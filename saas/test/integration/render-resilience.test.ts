// ADEX Online · preparación para Render Free: el servidor REAL como proceso aparte,
// configurado solo por variables de entorno, contra PostgreSQL REAL detrás de un proxy
// TLS (ver test/helpers/render.ts). Reproduce EN LOCAL lo que Render Free provoca:
// suspensión y reactivación, reinicios en cualquier momento, conexiones viejas con el
// pooler, respuestas perdidas y 5xx tras el COMMIT. NO prueba la plataforma Render.
//
//   RND-001  arranque como en Render: PORT, 0.0.0.0, salud, TLS verificado, CORS, registros sin secretos
//   RND-002  configuración inválida o certificado ajeno: no arranca / no conecta, sin secretos
//   RND-010  suspensión: proceso muerto → peticiones fallan → reactivación sin pérdida, recuperación por id
//   RND-011  respuesta perdida y 503 DESPUÉS del COMMIT: el cliente web real consulta antes de repetir
//   RND-012  servidor caído durante el comando: operación incierta → «Comprobar» → una sola vez
//   RND-020  muerte abrupta durante la petición (antes y después del COMMIT): exactamente una vez
//   RND-030  concurrencia: mismos fondos y mismo id de operación a la vez
//   RND-040  conexiones invalidadas, base inaccesible y cortes durante transacciones en curso
//   RND-050  Empresa Demo: reinicio del API a mitad de un reinicio de la Demo → recuperación
//   RND-060  SIGTERM: cierre ordenado

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { companyId } from '../../db/seeds/synthetic.ts';
import { createTestDb, pgAvailable, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, type LocalIssuer } from '../helpers/auth.ts';
import { M } from '../helpers/phase2.ts';
import { CLEAN, balance, reconcile } from '../helpers/phase3.ts';
import { grantDemoOperator } from '../helpers/online.ts';
import {
  cleanupDir, findOpenssl, makeCert, renderTmp, startApiExpectingFailure, startApiProcess, startFaultProxy, startJwksHost, startPgTlsProxy,
  type ApiProcess, type Cert, type PgTlsProxy,
} from '../helpers/render.ts';
import { OnlineClient, UncertainOperation } from '../../../online/src/lib/client.ts';

const openssl = findOpenssl();
const SKIP = !pgAvailable() ? 'requires real PostgreSQL (npm run test:db)' : !openssl ? 'requires openssl (TLS certificate for the local pooler)' : false;
const ORIGIN = 'https://adex-online.example.test';
type Body = Record<string, unknown>;
interface Res { status: number; body: Body; headers: Headers }

describe('ADEX Online · resiliencia para Render Free (proceso real, TLS, reinicios)', { skip: SKIP }, () => {
  const c1 = companyId('c1');
  const dir = path.join(renderTmp, `run-${Date.now()}`);
  let db: TestDb;
  let issuer: LocalIssuer;
  let jwks: Awaited<ReturnType<typeof startJwksHost>>;
  let cert: Cert;
  let foreign: Cert;
  let proxy: PgTlsProxy;
  let api: ApiProcess | null = null;
  let env: Record<string, string>;
  let port = 0;
  let token = '';
  const SECRET_KEY = `sb_secret_${randomUUID()}`;

  const viaProxy = (url: string) => url.replace(`:${process.env['ADEX_PG_PORT']}/`, `:${proxy.port}/`);
  const boot = async (extra: Record<string, string> = {}) => {
    api = await startApiProcess({ ...env, ...extra }, port || undefined);
    port = api.port;
    return api;
  };
  const call = async (method: string, p: string, o: { body?: unknown; op?: string; membership?: string | null; origin?: string; tok?: string } = {}): Promise<Res> => {
    const headers: Record<string, string> = { connection: 'close', authorization: `Bearer ${o.tok ?? token}` };
    const membership = o.membership === undefined ? M.brunoSa : o.membership;
    if (membership) headers['x-adex-membership'] = membership;
    if (o.op) headers['x-adex-operation-id'] = o.op;
    if (o.origin) headers['origin'] = o.origin;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    let text: string;
    try {
      res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
      text = await res.text();
    } catch (err) {
      // Diagnóstico: ¿murió el proceso? (estado y su salida de error, nunca secretos: los registros no los contienen).
      throw new Error(`${method} ${p}: ${(err as Error).message} (${(err as { cause?: { code?: string } }).cause?.code}); api exit=${api?.proc.exitCode} signal=${api?.proc.signalCode} stderr=${api?.stderr.slice(-5).join('')}`, { cause: err });
    }
    return { status: res.status, body: text ? JSON.parse(text) as Body : {}, headers: res.headers };
  };
  /** El proceso sigue vivo (un corte de la base nunca debe tumbar el API). */
  const alive = () => assert.ok(api!.proc.exitCode === null && api!.proc.signalCode === null, `API process died (${api!.proc.exitCode}/${api!.proc.signalCode}): ${api!.stderr.join('')}`);
  const deposit = (op: string, amountMinor = 10_000) => call('POST', '/v1/capital/company/deposits', { op, body: { amountMinor, reason: 'Aporte sintético Render' } });
  const deposits = async () => Number((await db.admin.query<{ n: string }>(
    `select count(*) n from adex.capital_operations where company_id = $1 and kind = 'COMPANY_DEPOSIT'`, [c1])).rows[0]!.n);
  const recorded = async (op: string) => Number((await db.admin.query<{ n: string }>(
    'select count(*) n from adex.operations where company_id = $1 and operation_id = $2', [c1, op])).rows[0]!.n);
  /** Lo que haría el cliente web: consultar por id; si no existe, repetir con el MISMO id. */
  const settle = async (op: string): Promise<'found' | 'repeated'> => {
    const known = await call('GET', `/v1/operations/${op}`);
    if (known.status === 200) return 'found';
    assert.equal(known.body['error'], 'OPERATION_NOT_FOUND', JSON.stringify(known.body));
    const again = await deposit(op);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    return 'repeated';
  };
  const clientFor = (apiBase: string) => {
    const client = new OnlineClient({ apiBase, supabaseUrl: jwks.base, publishableKey: 'sb_publishable_test' });
    (client as unknown as { session: unknown }).session = { accessToken: token, refreshToken: 'unused', expiresAt: Math.floor(Date.now() / 1000) + 3600, identityId: 'x', activeMembershipId: M.brunoSa };
    return client;
  };

  before(async () => {
    db = await createTestDb('render', { seed: true });
    issuer = await createLocalIssuer();
    jwks = await startJwksHost(issuer.jwks);
    cert = makeCert(openssl!, dir, 'pooler');
    foreign = makeCert(openssl!, dir, 'foreign');
    proxy = await startPgTlsProxy(Number(process.env['ADEX_PG_PORT']), cert);
    token = await issuer.issue('bruno', { iss: `${jwks.base}/auth/v1` });
    env = {
      ADEX_API_DATABASE_URL: viaProxy(db.url('adex_api')),
      ADEX_DEMO_DATABASE_URL: viaProxy(db.url('adex_demo')),
      SUPABASE_URL: jwks.base,
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      SUPABASE_SECRET_KEY: SECRET_KEY,
      ADEX_ALLOWED_ORIGINS: ORIGIN,
      ADEX_PG_SSL_CA_FILE: cert.certPath,
      ADEX_TRUST_PROXY: '1',
      ADEX_RATE_PER_IP: '100000',
      ADEX_RATE_PER_TOKEN: '100000',
    };
  });
  after(async () => {
    await api?.kill();
    await proxy?.close();
    await jwks?.close();
    await db?.close();
    cleanupDir(dir);
  });

  test('RND-001 · arranque como en Render: PORT asignado, 0.0.0.0, salud, TLS verificado, CORS y registros sin secretos', async () => {
    const a = await boot();
    process.stdout.write(`# RND-001 arranque hasta escuchar: ${a.startupMs} ms\n`);
    const listening = JSON.parse(a.stdout.find((l) => l.includes('adex-online listening'))!.trim().split('\n')[0]!) as Body;
    assert.equal(listening['port'], a.port, 'listens on the PORT given by the platform');
    // 0.0.0.0: también responde por una dirección no local del equipo (si existe).
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (lan) assert.equal((await fetch(`http://${lan.address}:${a.port}/healthz`)).status, 200, 'bound to 0.0.0.0');
    const health = await call('GET', '/healthz', { membership: null });
    assert.deepEqual([health.status, health.body], [200, { status: 'ok', features: ['collections-v1', 'settlements-v1', 'clean-online-v1', 'changes-v1', 'access-links-v1', 'payment-location-v1', 'admin-transfers-v1', 'capital-requests-v1', 'offline-collector-v1'] }]);
    const ready = await call('GET', '/readyz', { membership: null });
    assert.deepEqual([ready.status, ready.body], [200, { status: 'ready' }], 'PostgreSQL over TLS with the CA file');
    assert.equal(health.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
    // CORS: solo el origen configurado.
    const pre = await fetch(`${a.base}/v1/context`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
    const evil = await call('GET', '/v1/me/memberships', { origin: 'https://evil.example', membership: null });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    // Autenticación: sin token o con token ajeno, nada.
    assert.equal((await fetch(`${a.base}/v1/me/memberships`)).status, 401);
    assert.equal((await call('GET', '/v1/me/memberships', { tok: await issuer.issueForged('bruno'), membership: null })).status, 401);
    const me = await call('GET', '/v1/me/memberships', { membership: null });
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.ok((me.body['memberships'] as Body[]).some((m) => m['membershipId'] === M.brunoSa));
    // Registros: ni contraseñas, ni claves, ni tokens.
    const logs = a.stdout.join('') + a.stderr.join('');
    const dbPass = new URL(env['ADEX_API_DATABASE_URL']!).password;
    for (const secret of [dbPass, SECRET_KEY, token]) assert.ok(!logs.includes(secret), 'no secret in logs');
  });

  test('RND-002 · configuración inválida o certificado ajeno: no arranca o no conecta, y no revela secretos', async () => {
    const noCa = await startApiExpectingFailure({ ...env, ADEX_PG_SSL_CA_FILE: '', PORT: '0' });
    assert.equal(noCa.code, 1);
    assert.match(noCa.stderr, /ADEX_PG_SSL_CA_FILE or ADEX_PG_SSL_CA_PEM is required/);
    const missingFile = await startApiExpectingFailure({ ...env, ADEX_PG_SSL_CA_FILE: path.join(dir, 'missing.crt'), PORT: '0' });
    assert.equal(missingFile.code, 1);
    assert.match(missingFile.stderr, /ADEX_PG_SSL_CA_FILE cannot be read/);
    const noDb = await startApiExpectingFailure({ ...env, ADEX_API_DATABASE_URL: '', PORT: '0' });
    assert.match(noDb.stderr, /missing environment variable ADEX_API_DATABASE_URL/);
    const dbPass = new URL(env['ADEX_API_DATABASE_URL']!).password;
    for (const r of [noCa, missingFile, noDb]) for (const s of [dbPass, SECRET_KEY]) assert.ok(!r.stderr.includes(s) && !r.stdout.includes(s));
    // Certificado de OTRA autoridad: TLS rechazado → la base «no está lista», pero el proceso vive.
    await api!.kill();
    await boot({ ADEX_PG_SSL_CA_FILE: foreign.certPath });
    assert.equal((await call('GET', '/healthz', { membership: null })).status, 200);
    const ready = await call('GET', '/readyz', { membership: null });
    assert.deepEqual([ready.status, ready.body], [503, { error: 'UNAVAILABLE' }]);
    const before = await deposits();
    const op = randomUUID();
    const r = await deposit(op);
    assert.ok(r.status >= 500, `unverifiable database → no operation (${r.status})`);
    assert.equal(await deposits(), before);
    await api!.kill();
    await boot();
  });

  test('RND-010 · suspensión: proceso muerto, peticiones fallidas y reactivación sin pérdida', async () => {
    const op = randomUUID();
    const first = await deposit(op, 50_000);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const company = await balance(db.admin, c1, 'company', null);
    const count = await deposits();
    await api!.kill();                                          // Render suspende la instancia
    await assert.rejects(call('GET', '/healthz', { membership: null }), 'no server while suspended');
    await assert.rejects(deposit(randomUUID()), 'a command while suspended gets no response');
    const woke = await boot();                                  // primera petición → arranque
    process.stdout.write(`# RND-010 reactivación (proceso) hasta escuchar: ${woke.startupMs} ms\n`);
    assert.equal((await call('GET', '/readyz', { membership: null })).status, 200, 'fresh pool reconnects');
    assert.equal(await balance(db.admin, c1, 'company', null), company, 'nothing lost or added');
    assert.equal(await deposits(), count);
    const known = await call('GET', `/v1/operations/${op}`);
    assert.equal(known.status, 200);
    assert.deepEqual(known.body['result'], first.body, 'the outcome survives the restart');
    const retry = await deposit(op, 50_000);
    assert.deepEqual([retry.status, retry.body], [201, first.body], 'same id after restart → same result');
    assert.equal(await deposits(), count);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('RND-011 · respuesta perdida y 503 DESPUÉS del COMMIT: el cliente web consulta por id y no duplica', async () => {
    const faults = await startFaultProxy(() => `http://127.0.0.1:${port}`);
    try {
      const client = clientFor(faults.base);
      for (const fault of ['drop-after-commit', '503-after-commit'] as const) {
        const before = await deposits();
        const company = await balance(db.admin, c1, 'company', null);
        const op = randomUUID();
        faults.next(fault);
        const out = await client.command<Body>('POST', '/v1/capital/company/deposits', { amountMinor: 7_000, reason: `Respuesta perdida (${fault})` }, op);
        assert.equal((out['operation'] as Body)['kind'], 'COMPANY_DEPOSIT', fault);
        assert.equal(await deposits(), before + 1, `${fault}: exactly one deposit`);
        assert.equal(await balance(db.admin, c1, 'company', null), company + 7_000);
        assert.equal(await recorded(op), 1);
      }
      // Un 4xx sigue siendo definitivo (no se consulta ni se repite).
      await assert.rejects(client.command('POST', '/v1/capital/company/deposits', { amountMinor: -1, reason: 'x' }), (e: Error) => !(e instanceof UncertainOperation));
    } finally {
      await faults.close();
    }
  });

  test('RND-012 · servidor caído durante el comando: incierta → «Comprobar en el servidor» → una sola vez', async () => {
    const client = clientFor(`http://127.0.0.1:${port}`);
    await api!.kill();
    const before = await deposits();
    let pending: UncertainOperation | null = null;
    try {
      await client.command('POST', '/v1/capital/company/deposits', { amountMinor: 3_000, reason: 'Con el servidor dormido' });
    } catch (e) {
      pending = e as UncertainOperation;
    }
    assert.ok(pending instanceof UncertainOperation, 'never a definitive error nor a blind retry');
    assert.equal(await deposits(), before);
    await boot();
    const out = await client.resolveUncertain<Body>(pending);                 // botón «Comprobar en el servidor»
    assert.equal((out['operation'] as Body)['kind'], 'COMPANY_DEPOSIT');
    assert.equal(await deposits(), before + 1);
    const again = await client.resolveUncertain<Body>(pending);               // pulsado otra vez
    assert.deepEqual(again, out);
    assert.equal(await deposits(), before + 1, 'checking twice never posts twice');
  });

  test('RND-020 · muerte abrupta del proceso durante la petición (antes y después del COMMIT): exactamente una vez', async () => {
    const before = await deposits();
    const company = await balance(db.admin, c1, 'company', null);
    const delays = [0, 2, 5, 8, 12, 16, 20, 30, 45, 60, 90, 150, 300];
    const tally = { found: 0, repeated: 0 };
    for (const ms of delays) {
      const op = randomUUID();
      const inflight = deposit(op).catch(() => null);
      await new Promise((r) => setTimeout(r, ms));
      await api!.kill();
      await inflight;
      await boot();
      tally[await settle(op)]++;
      assert.equal(await recorded(op), 1);
    }
    process.stdout.write(`# RND-020 ${delays.length} muertes: confirmadas antes de morir ${tally.found}, no confirmadas y repetidas ${tally.repeated}\n`);
    assert.equal(await deposits(), before + delays.length, 'one deposit per intention');
    assert.equal(await balance(db.admin, c1, 'company', null), company + 10_000 * delays.length);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('RND-030 · concurrencia: los mismos fondos y el mismo id de operación a la vez', async () => {
    const available = await balance(db.admin, c1, 'company', null);
    const share = Math.floor(available * 0.6);
    const pool = await balance(db.admin, c1, 'admin', M.anaAdmin);
    const both = await Promise.all([0, 1].map(() => call('POST', '/v1/capital/allocations', { op: randomUUID(), body: { adminId: M.anaAdmin, amountMinor: share, reason: 'Carrera' } })));
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 409], JSON.stringify(both.map((r) => r.body)));
    assert.equal(both.find((r) => r.status === 409)!.body['error'], 'INSUFFICIENT_FUNDS');
    assert.equal(await balance(db.admin, c1, 'company', null), available - share);
    assert.equal(await balance(db.admin, c1, 'admin', M.anaAdmin), pool + share);
    const before = await deposits();
    const op = randomUUID();
    const twins = await Promise.all([deposit(op), deposit(op), deposit(op)]);
    assert.deepEqual(twins.map((r) => r.status), [201, 201, 201]);
    assert.deepEqual(twins[1]!.body, twins[0]!.body);
    assert.deepEqual(twins[2]!.body, twins[0]!.body);
    assert.equal(await deposits(), before + 1);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('RND-040 · conexiones invalidadas, base inaccesible y cortes durante transacciones en curso', async () => {
    // 1. El pooler corta TODAS las conexiones (p. ej. tras una suspensión larga).
    alive();
    assert.equal((await call('GET', '/readyz', { membership: null })).status, 200);
    proxy.dropAll();
    await new Promise((r) => setTimeout(r, 300));
    alive();
    const fresh = await Promise.all([0, 1, 2, 3].map(() => call('GET', '/v1/capital/summary')));
    assert.deepEqual(fresh.map((r) => r.status), [200, 200, 200, 200], 'stale connections are discarded');
    // 2. Base inaccesible: el proceso sigue vivo (Render no lo reinicia en bucle), nada se registra.
    proxy.setDown(true);
    assert.equal((await call('GET', '/healthz', { membership: null })).status, 200);
    assert.equal((await call('GET', '/readyz', { membership: null })).status, 503);
    const before = await deposits();
    const op = randomUUID();
    const r = await deposit(op);
    assert.ok(r.status >= 500, `database down → 5xx (${r.status})`);
    proxy.setDown(false);
    assert.equal(await deposits(), before);
    assert.equal(await settle(op), 'repeated');
    assert.equal(await deposits(), before + 1);
    // 3. Corte en medio de transacciones en curso: cada intención acaba confirmada UNA vez.
    const ops = Array.from({ length: 12 }, () => randomUUID());
    const start = await deposits();
    const inflight = Promise.all(ops.map((o) => deposit(o).catch(() => null)));
    await new Promise((res) => setTimeout(res, 25));
    proxy.dropAll();
    const answers = await inflight;
    await new Promise((res) => setTimeout(res, 300));
    alive();                                   // conexiones EN USO cortadas: el proceso sobrevive (tx.ts)
    const tally = { found: 0, repeated: 0 };
    for (const o of ops) tally[await settle(o)]++;
    process.stdout.write(`# RND-040 corte con 12 en curso: respuestas ${answers.filter((a) => a?.status === 201).length} ok / ${answers.filter((a) => a && a.status >= 500).length} 5xx; tras consultar: ${tally.found} ya confirmadas, ${tally.repeated} repetidas con el mismo id\n`);
    assert.equal(await deposits(), start + ops.length);
    for (const o of ops) assert.equal(await recorded(o), 1);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('RND-050 · Empresa Demo: el API muere a mitad de un reinicio de la Demo → recuperación sin residuos', async () => {
    const operatorId = randomUUID();
    await grantDemoOperator(db, operatorId, 'operador-render@example.test');
    const tok = await issuer.issue(operatorId, { iss: `${jwks.base}/auth/v1` });
    if (!api) await boot();
    const slot = `render-${randomUUID().slice(0, 8)}`;
    const demo = (method: string, p: string, body?: Body) => call(method, `/demo/v1/slots/${slot}${p}`, { tok, membership: null, body });
    const created = await demo('POST', '/create', { wait: true });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const first = created.body['companyId'] as string;
    // Reinicio en segundo plano y el proceso muere enseguida (reinicio de Render).
    const reset = await demo('POST', '/reset', { companyId: first, confirm: first, wait: false });
    assert.equal(reset.status, 202, JSON.stringify(reset.body));
    const half = reset.body['companyId'] as string;
    await api!.kill();
    await boot();
    const stuck = (await demo('GET', '')).body;
    assert.equal(stuck['state'], 'resetting', 'the interrupted provisioning is visible after the restart');
    assert.equal(stuck['jobRunning'], false);
    // Nadie opera la Demo vieja mientras tanto; otro reinicio queda bloqueado.
    assert.equal((await demo('POST', '/reset', { companyId: first, confirm: first })).body['error'], 'DEMO_BUSY');
    // «Recuperar aprovisionamiento interrumpido»: la Demo a medio crear se retira y la anterior vuelve.
    const aborted = await demo('POST', '/abort', { companyId: half, confirm: half });
    assert.equal(aborted.status, 200, JSON.stringify(aborted.body));
    const back = (await demo('GET', '')).body;
    assert.equal(back['state'], 'active');
    assert.equal((back['company'] as Body)['id'], first);
    // Reiniciar de nuevo: otra empresa, otro id, cuadrada; las anteriores retiradas para siempre.
    const again = await demo('POST', '/reset', { companyId: first, confirm: first, wait: true });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const live = again.body['companyId'] as string;
    assert.ok(![first, half].includes(live));
    const now = (await demo('GET', '')).body;
    assert.equal(now['state'], 'active');
    assert.equal((now['company'] as Body)['id'], live);
    assert.deepEqual(await reconcile(db.admin, live), CLEAN);
    const retired = await db.admin.query<{ id: string; retired: boolean; is_demo: boolean }>(
      'select id, retired_at is not null retired, is_demo from adex.companies where id = any($1) order by id', [[first, half, live]]);
    for (const row of retired.rows) {
      assert.equal(row.is_demo, true);
      assert.equal(row.retired, row.id !== live, `${row.id === live ? 'live' : 'previous'} demo`);
    }
    const events = await db.admin.query<{ n: string }>('select count(*) n from adex_demo.events');
    assert.ok(Number(events.rows[0]!.n) >= 4, 'administrative audit outside the company data');
    // Las empresas normales siguen intactas.
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  // En Windows `kill('SIGTERM')` termina el proceso a la fuerza (no hay señales POSIX):
  // solo se comprueba en Linux, que es lo que ejecuta Render.
  test('RND-060 · SIGTERM (Render antes de parar una instancia): cierre ordenado', { skip: process.platform === 'win32' ? 'POSIX signals only (Linux)' : false }, async () => {
    const code = await api!.term();
    assert.equal(code, 0);
    api = null;
  });
});
