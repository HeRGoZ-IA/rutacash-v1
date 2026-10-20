// RONDA 48.1 · reintentos seguros de abonos desde ADEX Online. El CLIENTE WEB REAL
// (`online/src/lib/client.ts`) y su guarda de abonos (`online/src/runtime/unconfirmedPayments.ts`)
// contra la API real y PostgreSQL real, con un proxy que pierde respuestas DESPUÉS del
// COMMIT, corta antes de llegar al servidor o durante la consulta de estado. Verificación
// independiente con SQL propio: ningún escenario registra dos abonos ni dos ubicaciones.
//
//   PR-001  abono normal: confirmado, una ubicación, nada pendiente
//   PR-002  fallo ANTES de llegar al servidor: pendiente → «Comprobar» → se registra una vez con el MISMO id
//   PR-003  confirmado por el servidor con respuesta perdida (socket cortado y 503): una vez
//   PR-004  reintento del cobrador (nueva lectura GPS) con un abono incierto: mismo id, mismas coordenadas
//   PR-005  doble toque: una sola petición, el mismo resultado
//   PR-006  dos pestañas a la vez sobre el mismo id (uno en vuelo): el servidor serializa, un abono
//   PR-007  interrupción durante la consulta de estado: sigue pendiente; luego se confirma una vez
//   PR-008  recarga con un resultado incierto y recarga con la petición EN VUELO
//   PR-009  ubicación no disponible (permiso denegado) también con respuesta perdida
//   PR-010  cambio de contexto: otra membresía no ve ni resuelve el abono pendiente
//   PR-011  sesión caducada o membresía desactivada durante la comprobación: nunca se toma como «no registrado»
//   PR-012  ruta retirada con el abono NO confirmado: 404 ambiguo → incierto; con la ruta de vuelta, una vez
//   PR-013  datos distintos tras un incierto: primero se resuelve el anterior (registrado / no registrado); nunca se envía el nuevo
//   PR-014  un abono realmente nuevo después de resolver: id nuevo, segundo pago legítimo
//   PR-015  primer envío rechazado (4xx): definitivo, nada pendiente; conciliación limpia
//   PR-016  al repetir: 404 de ruta, 400 de proxy u OPERATION_ID_REUSED nunca son «no registrado»
//   PR-017  nada se descarta por cantidad ni antigüedad; con demasiados pendientes no se envía
//   PR-018  otro importe con uno en vuelo: espera y obtiene su propio resultado

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import http from 'node:http';
import type net from 'node:net';
import { after, before, describe, test } from 'node:test';
import { companyId } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';
import { OnlineClient } from '../../../online/src/lib/client.ts';
import { MAX_PENDING, PaymentGuard, memoryPendingStore, type PaymentOutcome, type PendingStore } from '../../../online/src/runtime/unconfirmedPayments.ts';

type Body = Record<string, unknown>;
type Fault = 'down' | 'drop-after' | '503-after' | 'route-404' | 'proxy-400';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Proxy cliente → API con fallos programados por método. `down` = la petición NO llega al servidor. */
async function startProxy(target: string) {
  const queue: Record<'POST' | 'GET', Fault[]> = { POST: [], GET: [] };
  let allDown = false;
  const seen: { method: string; path: string; op: string | null; membership: string | null }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const m = req.method === 'POST' || req.method === 'GET' ? req.method : null;
        const fault = allDown ? 'down' : m ? queue[m].shift() : undefined;
        if (fault === 'down') return void req.socket.destroy();
        // Respuestas que NO vienen de la API de empresa (no llegan a ella).
        if (fault === 'route-404') { res.writeHead(404, { 'content-type': 'application/json' }); return void res.end('{"error":"NOT_FOUND"}'); }
        if (fault === 'proxy-400') { res.writeHead(400, { 'content-type': 'text/html' }); return void res.end('<html>Bad Request</html>'); }
        const headers: Record<string, string> = {};
        for (const h of ['authorization', 'content-type', 'x-adex-membership', 'x-adex-operation-id']) {
          const v = req.headers[h];
          if (typeof v === 'string') headers[h] = v;
        }
        seen.push({ method: req.method ?? '', path: req.url ?? '', op: headers['x-adex-operation-id'] ?? null, membership: headers['x-adex-membership'] ?? null });
        let status = 502;
        let text = '';
        try {
          const r = await fetch(target + (req.url ?? '/'), { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
          status = r.status;
          text = await r.text();
        } catch {
          return void req.socket.destroy();
        }
        if (fault === 'drop-after') return void req.socket.destroy();
        if (fault === '503-after') { res.writeHead(503, { 'content-type': 'application/json' }); return void res.end('{"error":"UNAVAILABLE"}'); }
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(text);
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    base: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    post: (...f: Fault[]) => { queue.POST.push(...f); },
    get: (...f: Fault[]) => { queue.GET.push(...f); },
    down: (v: boolean) => { allDown = v; },
    reset: () => { queue.POST.length = 0; queue.GET.length = 0; allDown = false; seen.length = 0; },
    seen,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

describe('Ronda 48.1 · reintentos seguros de abonos (cliente web real + PostgreSQL real)', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  let proxy: Awaited<ReturnType<typeof startProxy>>;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  let r1 = '';
  let bruno: Caller;
  let $bruno: Money, $ana: Money;
  let carlos: Person;
  let today = '';
  /** Retención del COMMIT de la PRÓXIMA petición de abono (para tener una «en vuelo»). */
  let hold: { started: () => void; release: Promise<void> } | null = null;

  const credit = async (amountMinor = 100_000, installmentsCount = 10) => {
    const client = (await bruno('POST', '/v1/clients', { routeId: r1, name: `Cliente ${randomUUID().slice(0, 6)}`, documentType: 'CPF',
      document: String(randomInt(10_000_000_000, 99_999_999_999)), phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b' })).body['id'];
    const r = await $ana('/v1/credits/direct', { routeId: r1, clientId: client, amountMinor, interestRate: 20, installmentsCount, frequency: 'diaria',
      startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return (r.body['credit'] as Body)['id'] as string;
  };
  const paymentsOf = async (s: string) => (await db.admin.query<{ id: string; amount: number; by: string }>(
    `select id, amount_minor::int amount, created_by_membership_id by from adex.payments where sale_id = $1 and coalesce(state, 'active') = 'active' order by created_at`, [s])).rows;
  const locationsOf = async (s: string) => (await db.admin.query<{ payment_id: string; status: string; lat: number | null; lng: number | null }>(
    `select l.payment_id, l.status, l.lat, l.lng from adex.payment_locations l join adex.payments p on p.company_id = l.company_id and p.id = l.payment_id
      where p.sale_id = $1`, [s])).rows;
  const opRows = async (op: string) => Number((await db.admin.query<{ n: string }>(
    'select count(*) n from adex.operations where company_id = $1 and operation_id = $2', [c1, op])).rows[0]!.n);
  const saleBalance = async (s: string) => Number((await db.admin.query<{ b: string }>('select balance_minor::text b from adex.sales where id = $1', [s])).rows[0]!.b);

  /** Navegador del cobrador: cliente web real con su sesión; `store` = almacenamiento local (sobrevive a la recarga). */
  const device = async (store: PendingStore, base = proxy.base, who: Person = carlos) => {
    const client = new OnlineClient({ apiBase: base, supabaseUrl: 'http://127.0.0.1:9', publishableKey: 'sb_publishable_test' });
    const token = await issuer.issue(who.identityId);
    (client as unknown as { session: unknown }).session = { accessToken: token, refreshToken: 'unused', expiresAt: Math.floor(Date.now() / 1000) + 3600, identityId: who.identityId, activeMembershipId: who.membershipId };
    return { client, guard: new PaymentGuard(client, store) };
  };
  const reading = (lat: number, lng: number) => ({ status: 'captured', lat, lng, accuracyM: 12, capturedAt: new Date().toISOString() });
  /** `location: null` = el cliente no envía ubicación (frontend anterior). */
  const pay = (saleId: string, amountMinor: number, location: Body | null = reading(-23.55, -46.63)) =>
    (location ? { saleId, amountMinor, location } : { saleId, amountMinor }) as Body;
  const confirmed = (o: PaymentOutcome) => {
    assert.equal(o.kind, 'confirmed', JSON.stringify(o));
    return (o as { result: Body; recovered: boolean });
  };

  before(async () => {
    db = await createTestDb('payretry', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider, {
      beforeCommit: async (_ctx, path) => {
        if (path !== '/v1/collections' || !hold) return;
        const h = hold;
        hold = null;
        h.started();
        await h.release;
      },
    });
    proxy = await startProxy(api.base);
    r1 = (await db.admin.query(`select id from adex.routes where company_id = $1 and name = 'Ruta 1'`, [c1])).rows[0].id;
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    $ana = money(caller(api, issuer, 'ana', M.anaAdmin));
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    carlos = await newPerson(api, issuer, provider.ids, bruno, { email: 'carlos-r481@example.test', role: 'cobrador', displayName: 'Carlos', routeIds: [r1] });
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 9_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 5_000_000, reason: 'Bolsa de Ana' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
  });
  after(async () => { await proxy?.close(); await api?.close(); await db?.close(); });

  test('PR-001 · abono normal: confirmado, una ubicación, nada pendiente', async () => {
    proxy.reset();
    const store = memoryPendingStore();
    const { guard } = await device(store);
    const s = await credit();
    const out = confirmed(await guard.register(s, pay(s, 12_000)));
    assert.equal(out.recovered, false);
    assert.equal((await paymentsOf(s)).length, 1);
    assert.deepEqual((await locationsOf(s)).map((l) => l.status), ['captured']);
    assert.deepEqual(store.read(), [], 'nothing left pending');
  });

  test('PR-002 · fallo ANTES de llegar al servidor: queda pendiente; «Comprobar» lo registra una vez con el MISMO id', async () => {
    proxy.reset();
    const store = memoryPendingStore();
    const { guard } = await device(store);
    const s = await credit();
    proxy.down(true);
    const o = await guard.register(s, pay(s, 12_000));
    assert.equal(o.kind, 'uncertain', 'never a definitive error nor a success');
    const op = store.read()[0]!.operationId;
    assert.equal((await paymentsOf(s)).length, 0);
    assert.equal(await opRows(op), 0);
    proxy.down(false);
    const out = await guard.check(s);
    assert.equal(confirmed(out!).recovered, true);
    assert.equal((await paymentsOf(s)).length, 1);
    assert.equal(await opRows(op), 1, 'registered under the ORIGINAL operation id');
    assert.ok(proxy.seen.filter((x) => x.method === 'POST').every((x) => x.op === op), 'no POST with another id');
    assert.deepEqual(store.read(), []);
  });

  test('PR-003 · confirmado por el servidor con la respuesta perdida (socket cortado y 503): exactamente una vez', async () => {
    for (const fault of ['drop-after', '503-after'] as const) {
      proxy.reset();
      const store = memoryPendingStore();
      const { guard } = await device(store);
      const s = await credit();
      proxy.post(fault);
      const out = confirmed(await guard.register(s, pay(s, 15_000)));
      assert.equal(out.recovered, true, fault);
      assert.equal((out.result['appliedMinor'] as number), 15_000);
      assert.equal((await paymentsOf(s)).length, 1, `${fault}: one payment`);
      assert.equal((await locationsOf(s)).length, 1, `${fault}: one location`);
      assert.equal(proxy.seen.filter((x) => x.method === 'POST').length, 1, `${fault}: the GET found it; no second POST`);
      assert.deepEqual(store.read(), []);
    }
  });

  test('PR-004 · reintento del cobrador con nueva lectura GPS sobre un abono incierto: mismo id, mismas coordenadas', async () => {
    proxy.reset();
    const store = memoryPendingStore();
    const { guard } = await device(store);
    const s = await credit();
    proxy.post('drop-after');
    proxy.get('down', 'down', 'down');                       // ni siquiera se puede consultar
    const first = await guard.register(s, pay(s, 20_000, reading(-23.5501, -46.6301)));
    assert.equal(first.kind, 'uncertain');
    assert.equal((await paymentsOf(s)).length, 1, 'the server DID commit it');
    // El cobrador pulsa otra vez: misma intención, otra lectura del GPS.
    const again = confirmed(await guard.register(s, pay(s, 20_000, reading(4.6097, -74.0817))));
    assert.equal(again.recovered, true);
    assert.equal((await paymentsOf(s)).length, 1, 'never a second payment');
    const loc = await locationsOf(s);
    assert.equal(loc.length, 1, 'never a second location');
    assert.deepEqual([loc[0]!.lat, loc[0]!.lng], [-23.5501, -46.6301], 'the ORIGINAL reading; the new one is not sent');
    const posts = proxy.seen.filter((x) => x.method === 'POST');
    assert.equal(new Set(posts.map((p) => p.op)).size, 1, 'one operation id for the whole life of the payment');
  });

  test('PR-005 · doble toque: una sola petición y el mismo resultado', async () => {
    proxy.reset();
    const { guard } = await device(memoryPendingStore());
    const s = await credit();
    const [a, b] = await Promise.all([guard.register(s, pay(s, 10_000)), guard.register(s, pay(s, 10_000, reading(1, 1)))]);
    assert.equal(confirmed(a).result['paymentId'], confirmed(b).result['paymentId']);
    assert.equal((await paymentsOf(s)).length, 1);
    assert.equal(proxy.seen.filter((x) => x.method === 'POST').length, 1);
  });

  test('PR-006 · dos pestañas a la vez sobre el mismo id (uno en vuelo): el servidor serializa; un abono', async () => {
    proxy.reset();
    const store = memoryPendingStore();               // misma «localStorage» para las dos pestañas
    const tabA = await device(store);
    const tabB = await device(store);
    const s = await credit();
    let started!: () => void;
    const inFlight = new Promise<void>((r) => { started = r; });
    let release!: () => void;
    hold = { started, release: new Promise<void>((r) => { release = r; }) };
    const a = tabA.guard.register(s, pay(s, 11_000));
    await inFlight;                                    // A está dentro de la transacción, sin COMMIT
    assert.equal(tabB.guard.pendingFor(s)?.operationId !== undefined, true, 'B sees the record written BEFORE sending');
    const b = tabB.guard.check(s);                     // B: consulta (404) y repite con el MISMO id → espera a A
    await sleep(300);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(confirmed(ra).result['paymentId'], confirmed(rb!).result['paymentId']);
    assert.equal((await paymentsOf(s)).length, 1);
    // Y a nivel HTTP: dos POST simultáneos con el mismo id → el mismo resultado, un abono.
    const s2 = await credit();
    const op = randomUUID();
    const same = pay(s2, 9_000);
    const [x, y] = await Promise.all([carlos.money('/v1/collections', same, op), carlos.money('/v1/collections', same, op)]);
    assert.deepEqual([x.status, y.status], [201, 201]);
    assert.deepEqual(x.body, y.body);
    assert.equal((await paymentsOf(s2)).length, 1);
    // Mismo id con OTRO cuerpo (p. ej. otra lectura GPS): el servidor lo rechaza, nunca otro abono.
    const other = await carlos.money('/v1/collections', pay(s2, 9_000, reading(2, 2)), op);
    assert.deepEqual([other.status, other.body['error']], [409, 'OPERATION_ID_REUSED']);
    assert.equal((await paymentsOf(s2)).length, 1);
  });

  test('PR-007 · interrupción durante la consulta de estado: sigue pendiente; después se confirma una vez', async () => {
    proxy.reset();
    const store = memoryPendingStore();
    const { guard } = await device(store);
    const s = await credit();
    proxy.post('drop-after');
    proxy.get('drop-after', '503-after', 'down');
    assert.equal((await guard.register(s, pay(s, 13_000))).kind, 'uncertain');
    proxy.get('down', 'down', 'down');
    assert.equal((await guard.check(s))!.kind, 'uncertain', 'still unknown, still the same record');
    assert.equal(store.read().length, 1);
    const out = confirmed((await guard.check(s))!);
    assert.equal(out.recovered, true);
    assert.equal((await paymentsOf(s)).length, 1);
    assert.equal(proxy.seen.filter((x) => x.method === 'POST').length, 1, 'found by id: never posted again');
  });

  test('PR-008 · recarga con un resultado incierto, y recarga con la petición EN VUELO', async () => {
    proxy.reset();
    const store = memoryPendingStore();
    const s = await credit();
    {
      const before = await device(store);
      proxy.post('drop-after');
      proxy.get('down', 'down', 'down');
      assert.equal((await before.guard.register(s, pay(s, 14_000))).kind, 'uncertain');
    }
    const after = await device(store);                // nueva pestaña: cliente y guarda nuevos
    assert.equal(after.guard.pendingFor(s)?.body['amountMinor'], 14_000, 'the pending payment survives the reload');
    assert.equal(confirmed((await after.guard.check(s))!).recovered, true);
    assert.equal((await paymentsOf(s)).length, 1);

    // Recarga a MITAD de la petición: el id ya estaba guardado antes de enviar.
    proxy.reset();
    const store2 = memoryPendingStore();
    const s2 = await credit();
    let started!: () => void;
    const inFlight = new Promise<void>((r) => { started = r; });
    let release!: () => void;
    hold = { started, release: new Promise<void>((r) => { release = r; }) };
    const orphan = (await device(store2)).guard.register(s2, pay(s2, 16_000));   // la pestaña «muere»: nadie lee esta respuesta
    await inFlight;
    const reloaded = await device(store2);
    assert.ok(reloaded.guard.pendingFor(s2), 'after reload the in-flight payment is known');
    const check = reloaded.guard.check(s2);
    await sleep(200);
    release();
    confirmed((await check)!);
    await orphan;
    assert.equal((await paymentsOf(s2)).length, 1, 'reload during the request never produces a second payment');
    assert.deepEqual(store2.read(), []);
  });

  test('PR-009 · ubicación no disponible (permiso denegado), también con respuesta perdida', async () => {
    proxy.reset();
    const { guard } = await device(memoryPendingStore());
    const s = await credit();
    const denied = { status: 'denied', reason: 'El permiso de ubicación fue denegado.' };
    proxy.post('drop-after');
    const out = confirmed(await guard.register(s, pay(s, 10_000, denied)));
    assert.deepEqual(out.result['location'], { status: 'denied' });
    const loc = await locationsOf(s);
    assert.deepEqual(loc.map((l) => [l.status, l.lat, l.lng]), [['denied', null, null]], 'no invented coordinates');
    assert.equal((await paymentsOf(s)).length, 1);
    // Sin campo de ubicación (frontend anterior): el abono se registra igual, sin fila.
    const s2 = await credit();
    confirmed(await guard.register(s2, pay(s2, 10_000, null)));
    assert.equal((await locationsOf(s2)).length, 0);
  });

  test('PR-010 · cambio de contexto: otra membresía no ve ni resuelve el abono pendiente', async () => {
    proxy.reset();
    const store = memoryPendingStore();
    const { client, guard } = await device(store);
    const s = await credit();
    proxy.down(true);
    assert.equal((await guard.register(s, pay(s, 10_000))).kind, 'uncertain');
    proxy.down(false);
    const session = (client as unknown as { session: { activeMembershipId: string } }).session;
    session.activeMembershipId = M.anaAdmin;           // otro contexto en el mismo dispositivo
    assert.equal(guard.pendingFor(s), null, 'invisible under another membership');
    assert.equal(await guard.check(s), null);
    assert.equal(proxy.seen.length, 0, 'nothing sent under another membership');
    session.activeMembershipId = carlos.membershipId;  // vuelve a su contexto
    confirmed((await guard.check(s))!);
    const p = await paymentsOf(s);
    assert.deepEqual(p.map((x) => x.by), [carlos.membershipId], 'registered by the person who sent it');
  });

  test('PR-011 · sesión caducada o membresía desactivada durante la comprobación: nunca «no registrado»', async () => {
    proxy.reset();
    const store = memoryPendingStore();
    const s = await credit();
    let dev = await device(store);
    proxy.post('drop-after');
    proxy.get('down', 'down', 'down');
    assert.equal((await dev.guard.register(s, pay(s, 10_000))).kind, 'uncertain');
    // Token inválido (sesión caducada en el proveedor): la consulta devuelve 401.
    (dev.client as unknown as { session: { accessToken: string } }).session.accessToken = await issuer.issueForged(carlos.identityId);
    assert.equal((await dev.guard.check(s))!.kind, 'uncertain', '401 on the status query is NOT a result');
    assert.equal(store.read().length, 1, 'record kept');
    // Membresía desactivada: 403 de contexto, tampoco es un resultado.
    assert.equal((await bruno('POST', `/v1/members/${carlos.membershipId}/deactivate`, {})).status, 200);
    dev = await device(store);
    assert.equal((await dev.guard.check(s))!.kind, 'uncertain', 'context rejection is NOT a result');
    assert.equal(store.read().length, 1);
    assert.equal((await bruno('POST', `/v1/members/${carlos.membershipId}/reactivate`, {})).status, 200);
    dev = await device(store);
    confirmed((await dev.guard.check(s))!);
    assert.equal((await paymentsOf(s)).length, 1);
  });

  test('PR-012 · ruta retirada con el abono NO confirmado: el crédito deja de ser visible (404) → sigue incierto, nada registrado; al devolver la ruta se completa una vez', async () => {
    proxy.reset();
    const store = memoryPendingStore();
    const { guard } = await device(store);
    const s = await credit();
    proxy.down(true);
    assert.equal((await guard.register(s, pay(s, 10_000))).kind, 'uncertain');
    proxy.down(false);
    assert.equal((await bruno('PUT', `/v1/members/${carlos.membershipId}/routes`, { routeIds: [] })).status, 200);
    try {
      // 404 NOT_FOUND es ambiguo (crédito fuera de alcance o ruta inexistente): nunca «no registrado».
      assert.equal((await guard.check(s))!.kind, 'uncertain');
      assert.equal((await paymentsOf(s)).length, 0);
      assert.equal(store.read().length, 1, 'record kept');
    } finally {
      assert.equal((await bruno('PUT', `/v1/members/${carlos.membershipId}/routes`, { routeIds: [r1] })).status, 200);
    }
    confirmed((await guard.check(s))!);
    assert.equal((await paymentsOf(s)).length, 1, 'the original send, once');
    assert.deepEqual(store.read(), []);
  });

  test('PR-013 · datos distintos tras un incierto: primero se resuelve el anterior; el nuevo nunca se envía', async () => {
    proxy.reset();
    const store = memoryPendingStore();
    const { guard } = await device(store);
    // a) El anterior SÍ quedó registrado.
    const s = await credit();
    proxy.post('drop-after');
    proxy.get('down', 'down', 'down');
    assert.equal((await guard.register(s, pay(s, 10_000))).kind, 'uncertain');
    const o = await guard.register(s, pay(s, 25_000));
    assert.equal(o.kind, 'previous_confirmed', JSON.stringify(o));
    assert.deepEqual((await paymentsOf(s)).map((p) => p.amount), [10_000], 'the new amount was NOT sent');
    assert.deepEqual(store.read(), []);
    // b) El anterior NO llegó y ya no puede registrarse (el crédito se saldó por otra vía).
    const s2 = await credit(10_000, 2);                // total 12.000
    proxy.down(true);
    assert.equal((await guard.register(s2, pay(s2, 6_000))).kind, 'uncertain');
    proxy.down(false);
    assert.equal((await $ana('/v1/collections', { saleId: s2, amountMinor: 12_000 })).status, 201);
    const o2 = await guard.register(s2, pay(s2, 3_000));
    assert.equal(o2.kind, 'previous_rejected', JSON.stringify(o2));
    assert.deepEqual((await paymentsOf(s2)).map((p) => p.amount), [12_000], 'neither the old nor the new one');
    assert.equal(await saleBalance(s2), 0);
    assert.deepEqual(store.read(), []);
  });

  test('PR-014 · un abono realmente nuevo después de resolver el anterior: id nuevo, segundo pago legítimo', async () => {
    proxy.reset();
    const store = memoryPendingStore();
    const { guard } = await device(store);
    const s = await credit();
    proxy.post('drop-after');
    confirmed(await guard.register(s, pay(s, 10_000)));
    confirmed(await guard.register(s, pay(s, 10_000)));   // misma cantidad, otra visita: es OTRO abono
    const p = await paymentsOf(s);
    assert.equal(p.length, 2);
    const ops = proxy.seen.filter((x) => x.method === 'POST').map((x) => x.op);
    assert.equal(new Set(ops).size, 2, 'a new operation id only after the previous one was resolved');
    assert.equal(await saleBalance(s), 120_000 - 20_000);
  });

  test('PR-016 · al repetir con el mismo id, una respuesta que no es de la operación (404 de ruta, 400 de proxy, id ya usado) sigue siendo incierta', async () => {
    proxy.reset();
    const store = memoryPendingStore();
    const { guard } = await device(store);
    const s = await credit();
    proxy.down(true);
    assert.equal((await guard.register(s, pay(s, 10_000))).kind, 'uncertain');
    proxy.down(false);
    for (const f of ['route-404', 'proxy-400'] as const) {
      proxy.post(f, f, f);
      assert.equal((await guard.check(s))!.kind, 'uncertain', `${f} is not a result`);
      assert.equal(store.read().length, 1, `${f}: record kept`);
    }
    // El mismo id con OTRO cuerpo ya registrado (409 OPERATION_ID_REUSED): la operación existe → incierto, nunca «no registrado».
    const rec = store.read()[0]!;
    assert.equal((await carlos.money('/v1/collections', pay(s, 7_000), rec.operationId)).status, 201);
    assert.equal((await guard.check(s))!.kind !== 'rejected', true, 'never «not registered» for an existing id');
    assert.equal((await paymentsOf(s)).length, 1, 'never a second payment');
  });

  test('PR-017 · los pendientes nunca se descartan por cantidad ni antigüedad; con demasiados no se envía nada nuevo', async () => {
    proxy.reset();
    const store = memoryPendingStore();
    let clock = Date.now();
    const { client } = await device(store);
    const guard = new PaymentGuard(client, store, () => clock);
    proxy.down(true);
    const sales: string[] = [];
    for (let i = 0; i < MAX_PENDING; i++) {
      const s = await credit();
      sales.push(s);
      assert.equal((await guard.register(s, pay(s, 1_000))).kind, 'uncertain');
    }
    clock += 30 * 24 * 3600_000;                       // un mes después
    const extra = await credit();
    const o = await guard.register(extra, pay(extra, 1_000));
    assert.deepEqual(o, { kind: 'too_many_pending', count: MAX_PENDING });
    assert.equal(store.read().length, MAX_PENDING, 'none evicted, none expired');
    assert.ok(guard.pendingFor(sales[0]!), 'the oldest is still known');
    proxy.down(false);
    for (const s of sales) confirmed((await guard.check(s))!);
    assert.deepEqual(store.read(), []);
    for (const s of sales) assert.equal((await paymentsOf(s)).length, 1);
    assert.equal((await paymentsOf(extra)).length, 0);
  });

  test('PR-018 · otro importe mientras el primero está en vuelo: espera y se decide después (no hereda el resultado)', async () => {
    proxy.reset();
    const { guard } = await device(memoryPendingStore());
    const s = await credit();
    let started!: () => void;
    const inFlight = new Promise<void>((r) => { started = r; });
    let release!: () => void;
    hold = { started, release: new Promise<void>((r) => { release = r; }) };
    const a = guard.register(s, pay(s, 10_000));
    await inFlight;
    const b = guard.register(s, pay(s, 20_000));
    await sleep(100);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(confirmed(ra).result['appliedMinor'], 10_000);
    assert.equal(confirmed(rb).result['appliedMinor'], 20_000, 'its own result, not the first one');
    assert.deepEqual((await paymentsOf(s)).map((p) => p.amount), [10_000, 20_000]);
  });

  test('PR-015 · primer envío rechazado (4xx): definitivo y nada pendiente; conciliación limpia', async () => {
    proxy.reset();
    const store = memoryPendingStore();
    const { guard } = await device(store);
    const s = await credit();
    const o = await guard.register(s, pay(s, -5));
    assert.equal(o.kind, 'rejected');
    assert.equal((o as { previous: boolean }).previous, false);
    assert.deepEqual(store.read(), []);
    assert.equal((await paymentsOf(s)).length, 0);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });
});
