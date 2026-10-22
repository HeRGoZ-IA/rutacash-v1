// RONDA 67 · Entrega B: mapa de rutas del Administrador (0029) contra PostgreSQL real y la API.
// Ubicación de REFERENCIA del cliente (fijada a propósito, con origen e historia) frente a la
// ubicación del DISPOSITIVO al registrar (venta o abono). Marcadores: venta (bolsa), abono válido
// (check), visita sin pago (X, sin GPS propio). Filtros por ruta, trabajador, fechas y tipo.
// Seguridad: solo el Administrador lee coordenadas, en sus rutas; nada de otras empresas.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf, routeId } from '../../db/seeds/synthetic.ts';
import { asApi, count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { money, newPerson, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;
interface MapBody {
  from: string; to: string; today: string;
  routes: { id: string }[]; workers: { id: string; role: string }[];
  clients: { id: string; routeId: string; location: null | { source: string; lat: number; lng: number; setBy: string } }[];
  activities: { kind: string; id: string; clientId: string; routeId: string; workerId: string; day: string; device: null | { status: string; lat: number | null }; deviceOrigin?: string | null }[];
  lastKnown: { workerId: string; kind: string; id: string; lat: number; lng: number; at: string }[];
  truncated: boolean;
}

describe('Ronda 67 · mapa de rutas del Administrador', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  let r2 = '';   // ruta operativa nueva (la ruta 2 sintética pertenece a una Oficina inactiva)
  let bruno: Caller, ana: Caller, gabi: Caller, hugo: Caller, carla: Caller;
  let $bruno: Money, $ana: Money;
  let carlos: Person, dora: Person;
  let today = '';
  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const newClient = async (route = r1, name = `Cliente ${randomUUID().slice(0, 6)}`) => {
    const r = await ana('POST', '/v1/clients', { routeId: route, name, documentType: 'CPF', document: cpf(), phonePrimary: '1', addressPrimary: 'Rua A, 10', addressSecondary: 'Loja', business: 'Negocio sintético' });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body['id'] as string;
  };
  const saleBody = (route: string, clientId: string, extra: Body = {}): Body => ({ routeId: route, clientId, amountMinor: 40_000, interestRate: 20, installmentsCount: 10,
    frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6], ...extra });
  const direct = async (route: string, clientId: string, extra: Body = {}, who: Money = $ana, op?: string) => {
    const r = await who('/v1/credits/direct', saleBody(route, clientId, extra), op);
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return (r.body['credit'] as Body)['id'] as string;
  };
  const gps = (lat: number, lng: number, accuracyM = 12) => ({ status: 'captured', lat, lng, accuracyM, capturedAt: new Date().toISOString() });
  const setLoc = (who: Caller, clientId: string, body: Body) => who('POST', `/v1/clients/${clientId}/location`, body, { 'x-adex-operation-id': randomUUID() });
  const map = async (who: Caller, qs = '') => {
    const r = await who('GET', `/v1/map${qs}`);
    return r as { status: number; body: MapBody & Body };
  };

  before(async () => {
    db = await createTestDb('route_map', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    gabi = caller(api, issuer, 'gabi', M.gabiSec);
    hugo = caller(api, issuer, 'hugo', M.hugoAdmin);
    carla = caller(api, issuer, 'carla', M.carlaSa);
    today = (await db.admin.query(`select adex.company_today($1)::text d`, [c1])).rows[0].d;
    r2 = (await bruno('POST', '/v1/routes', { name: 'Ruta Mapa B', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [M.anaAdmin] })).body['id'] as string;
    carlos = await newPerson(api, issuer, provider.ids, bruno, { email: 'carlos-map@example.test', role: 'cobrador', displayName: 'Carlos Mapa', routeIds: [r1] });
    dora = await newPerson(api, issuer, provider.ids, bruno, { email: 'dora-map@example.test', role: 'supervisor', displayName: 'Dora Mapa', routeIds: [r2] });
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 50_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 30_000_000, reason: 'Bolsa de Ana' }],
    ] as const) {
      const r = await $bruno(path, body);
      assert.equal(r.status, 201, `${path}: ${JSON.stringify(r.body)}`);
    }
  });
  after(async () => { await api.close(); await db.close(); });

  test('MAP-001 · referencia del cliente: GPS en el lugar (Cobrador) y punto en el mapa (Administrador), con historia y auditoría sin coordenadas', async () => {
    const cl = await newClient();
    const a = await setLoc(carlos.call, cl, { source: 'gps_on_site', lat: -23.5505, lng: -46.6333, accuracyM: 9, capturedAt: new Date().toISOString() });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([a.body['source'], a.body['lat'], a.body['setBy'], a.body['setByRole']], ['gps_on_site', -23.5505, carlos.membershipId, 'cobrador']);
    const b = await setLoc(ana, cl, { source: 'map_pin', lat: -23.551, lng: -46.634, note: 'Corregido: la tienda está en la esquina' });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    const got = await ana('GET', `/v1/clients/${cl}/location`);
    assert.equal(got.status, 200);
    assert.equal((got.body['current'] as Body)['source'], 'map_pin', 'la vigente es la última');
    assert.equal((got.body['history'] as Body[]).length, 2, 'la anterior se conserva');
    const audit = (await db.admin.query(`select actor_role, metadata from adex.audit_log where action = 'SET_CLIENT_LOCATION' and entity_id = $1 order by created_at`, [cl])).rows;
    assert.deepEqual(audit.map((x) => [x.actor_role, x.metadata.source]), [['cobrador', 'gps_on_site'], ['admin', 'map_pin']]);
    assert.ok(!JSON.stringify(audit).includes('-23.55'), 'las coordenadas no se copian a la auditoría');
    // Historia: nada se corrige ni se borra.
    await assert.rejects(db.admin.query('update adex.client_locations set lat = 1 where client_id = $1', [cl]));
    await assert.rejects(db.admin.query('delete from adex.client_locations where client_id = $1', [cl]));
    // Supervisor de su ruta también puede.
    const r2c = await newClient(r2);
    assert.equal((await setLoc(dora.call, r2c, { source: 'gps_on_site', lat: -23.56, lng: -46.64 })).status, 201);
  });

  test('MAP-002 · quién NO fija ubicaciones y qué lecturas se rechazan (nunca se inventan coordenadas)', async () => {
    const cl = await newClient();
    assert.equal((await setLoc(bruno, cl, { source: 'map_pin', lat: -23.5, lng: -46.6 })).status, 403, 'SuperAdmin: cartera de solo lectura');
    assert.equal((await setLoc(gabi, cl, { source: 'map_pin', lat: -23.5, lng: -46.6 })).status, 403, 'Secretario');
    assert.ok([403, 404].includes((await setLoc(dora.call, cl, { source: 'gps_on_site', lat: -23.5, lng: -46.6 })).status), 'Supervisor de otra ruta');
    assert.equal((await setLoc(carla, cl, { source: 'map_pin', lat: -23.5, lng: -46.6 })).status, 404, 'otra empresa');
    for (const bad of [
      { source: 'gps_on_site', lat: 0, lng: 0 },
      { source: 'gps_on_site', lat: 200, lng: 10 },
      { source: 'gps_on_site', lat: '-23.5', lng: -46.6 },
      { source: 'map_pin', lat: -23.5, lng: -46.6, accuracyM: 5 },
      { source: 'oficina', lat: -23.5, lng: -46.6 },
      { source: 'map_pin' },
    ]) assert.equal((await setLoc(ana, cl, bad)).status, 400, JSON.stringify(bad));
    assert.equal((await ana('POST', `/v1/clients/${cl}/location`, { source: 'map_pin', lat: -23.5, lng: -46.6 })).status, 400, 'exige id de operación');
    assert.equal(await count(db.admin, 'select 1 from adex.client_locations where client_id = $1', [cl]), 0);
    // Segunda barrera: la base rechaza al SuperAdmin y a un rol sin la capacidad aunque se salte la API.
    await asApi(db.api, { identityId: identityOf('bruno'), membershipId: M.brunoSa, companyId: c1 }, async (q) => {
      await assert.rejects(q.query(`insert into adex.client_locations (id, company_id, client_id, route_id, source, lat, lng, set_by_membership_id, set_by_role, created_at)
                                    values ($1, $2, $3, $4, 'map_pin', -23.5, -46.6, $5, 'superadmin', now())`, [randomUUID(), c1, cl, r1, M.brunoSa]), { code: '42501' });
    });
  });

  test('MAP-003 · GPS al vender en línea: se guarda como ubicación del DISPOSITIVO, nunca como la del cliente; sin GPS la venta sigue y no se duplica', async () => {
    const cl = await newClient();
    const op = randomUUID();
    const reading = gps(-22.9, -43.2);   // una lectura por intención: el reintento envía el MISMO cuerpo
    const s = await direct(r1, cl, { location: reading }, $ana, op);
    const row = (await db.admin.query('select entity_kind, status, lat, captured_by_membership_id m, client_id from adex.sale_locations where entity_id = $1', [s])).rows;
    assert.deepEqual(row, [{ entity_kind: 'direct_sale', status: 'captured', lat: -22.9, m: M.anaAdmin, client_id: cl }]);
    assert.equal(await count(db.admin, 'select 1 from adex.client_locations where client_id = $1', [cl]), 0, 'la ubicación de la oficina NO es la del cliente');
    // Reintento con el mismo id (respuesta perdida): una venta y una ubicación.
    const again = await $ana('/v1/credits/direct', saleBody(r1, cl, { location: reading }), op);
    assert.equal(again.status, 201);
    assert.equal(await count(db.admin, 'select 1 from adex.sales where client_id = $1', [cl]), 1);
    assert.equal(await count(db.admin, 'select 1 from adex.sale_locations where client_id = $1', [cl]), 1);
    // Permiso denegado y lectura imposible: la venta sigue; se guarda la causa, sin coordenadas.
    const denied = await direct(r1, await newClient(), { location: { status: 'denied', reason: 'El permiso de ubicación fue denegado.' } });
    assert.deepEqual((await db.admin.query('select status, lat from adex.sale_locations where entity_id = $1', [denied])).rows, [{ status: 'denied', lat: null }]);
    const bad = await direct(r1, await newClient(), { location: { status: 'captured', lat: 0, lng: 0 } });
    assert.deepEqual((await db.admin.query('select status, lat from adex.sale_locations where entity_id = $1', [bad])).rows, [{ status: 'invalid', lat: null }]);
    const none = await direct(r1, await newClient());
    assert.equal(await count(db.admin, 'select 1 from adex.sale_locations where entity_id = $1', [none]), 0, 'frontend anterior: sin fila');
    // Importes y condiciones idénticos con y sin ubicación (no se altera la venta).
    const money = (await db.admin.query('select sale_value_minor::int v, total_value_minor::int t, installments_count n from adex.sales where id = any($1) order by id', [[s, denied, none]])).rows;
    assert.ok(money.every((m) => m.v === 40_000 && m.t === money[0].t && m.n === 10));
    // Solicitud del Cobrador con GPS → aprobación → desembolso: el crédito muestra la ubicación de la solicitud.
    const cl2 = await newClient();
    const req = await carlos.call('POST', '/v1/credit-requests', saleBody(r1, cl2, { amountMinor: 10_000, location: gps(-23.6, -46.7) }));
    assert.equal(req.status, 201, JSON.stringify(req.body));
    assert.equal(await count(db.admin, `select 1 from adex.sale_locations where entity_kind = 'credit_request' and entity_id = $1`, [req.body['id']]), 1);
    assert.equal((await gabi('POST', `/v1/credit-requests/${req.body['id']}/approve`, {})).status, 200);
    const dis = await $ana(`/v1/credit-requests/${req.body['id']}/disburse`, {});
    assert.equal(dis.status, 201, JSON.stringify(dis.body));
    const m = (await map(ana, `?routeId=${r1}&kinds=sale`)).body;
    const act = m.activities.find((a) => a.clientId === cl2)!;
    assert.deepEqual([act.kind, act.device?.status, act.device?.lat, act.deviceOrigin], ['sale', 'captured', -23.6, 'credit_request']);
    // El campo `offline` sigue prohibido en ventas (65-C1): la ubicación no abre ninguna vía sin conexión.
    const off = await carlos.call('POST', '/v1/credit-requests', saleBody(r1, await newClient(), { location: gps(-23.6, -46.7), offline: { capturedAt: new Date().toISOString() } }));
    assert.equal(off.body['error'], 'UNKNOWN_FIELD');
  });

  test('MAP-004 · marcadores: venta, abono válido y visita sin pago, ligados a cliente y ruta; un abono anulado no es un cobro', async () => {
    const cl = await newClient(r1, 'Marcadores');
    await setLoc(ana, cl, { source: 'map_pin', lat: -23.57, lng: -46.65 });
    const s = await direct(r1, cl);
    const paid = await carlos.money('/v1/collections', { saleId: s, amountMinor: 4_000, location: gps(-23.5701, -46.6501) });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    const annulled = await carlos.money('/v1/collections', { saleId: s, amountMinor: 1_000 });
    assert.equal(annulled.status, 201);
    assert.equal((await $ana(`/v1/collections/${annulled.body['paymentId']}/reverse`, { reason: 'Error de digitación' })).status, 201);
    const visit = await carlos.money('/v1/no-payment-visits', { saleId: s, reason: 'no_estaba' });
    assert.equal(visit.status, 201, JSON.stringify(visit.body));
    const m = (await map(ana, `?routeId=${r1}`)).body;
    const mine = m.activities.filter((a) => a.clientId === cl);
    assert.deepEqual(mine.map((a) => a.kind).sort(), ['payment', 'sale', 'visit']);
    assert.ok(mine.every((a) => a.routeId === r1));
    const p = mine.find((a) => a.kind === 'payment')!;
    assert.deepEqual([p.id, p.workerId, p.device?.status, p.device?.lat], [paid.body['paymentId'], carlos.membershipId, 'captured', -23.5701]);
    const v = mine.find((a) => a.kind === 'visit')!;
    assert.deepEqual([v.workerId, v.device], [carlos.membershipId, null], 'la visita no tiene GPS propio: se pinta en la referencia del cliente');
    assert.ok(!m.activities.some((a) => a.id === annulled.body['paymentId']), 'el abono anulado no aparece como cobro');
    const c = m.clients.find((x) => x.id === cl)!;
    assert.deepEqual([c.location?.source, c.location?.lat], ['map_pin', -23.57], 'referencia del cliente distinta de la del dispositivo');
  });

  test('MAP-005 · filtros: fechas, ruta, trabajador y tipo; rango acotado', async () => {
    const cl1 = await newClient(r1);
    const s1 = await direct(r1, cl1);
    assert.equal((await carlos.money('/v1/collections', { saleId: s1, amountMinor: 2_000 })).status, 201);
    const cl2 = await newClient(r2);
    const s2 = await direct(r2, cl2);
    assert.equal((await dora.money('/v1/collections', { saleId: s2, amountMinor: 2_000, location: gps(-23.58, -46.66) })).status, 201);
    // Una venta antigua (fecha contable de hace 20 días) solo aparece si el rango la incluye.
    const old = await direct(r1, await newClient(r1));
    await db.admin.query(`update adex.sales set disbursement_date = $2::date - 20, start_date = $2::date - 20 where id = $1`, [old, today]);
    const all = (await map(ana)).body;
    assert.ok(all.routes.map((r) => r.id).includes(r1) && all.routes.map((r) => r.id).includes(r2));
    assert.ok(!all.activities.some((a) => a.id === old), 'por defecto, los últimos 7 días');
    const wide = (await map(ana, `?from=${new Date(Date.parse(today) - 30 * 86_400_000).toISOString().slice(0, 10)}&to=${today}`)).body;
    assert.ok(wide.activities.some((a) => a.id === old), 'con el rango ampliado sí');
    const onlyR2 = (await map(ana, `?routeId=${r2}`)).body;
    assert.ok(onlyR2.activities.length > 0 && onlyR2.activities.every((a) => a.routeId === r2));
    assert.ok(onlyR2.clients.every((c) => c.routeId === r2));
    const byDora = (await map(ana, `?workerId=${dora.membershipId}&kinds=payment`)).body;
    assert.ok(byDora.activities.length > 0 && byDora.activities.every((a) => a.workerId === dora.membershipId && a.kind === 'payment'));
    const visitsOnly = (await map(ana, '?kinds=visit')).body;
    assert.ok(visitsOnly.activities.every((a) => a.kind === 'visit'));
    assert.equal((await map(ana, `?from=2025-01-01&to=${today}`)).status, 400, 'más de 93 días');
    assert.equal((await map(ana, `?from=${today}&to=2025-01-01`)).status, 400, 'desde > hasta');
    assert.equal((await map(ana, '?kinds=gps')).status, 400);
  });

  test('MAP-006 · clientes sin ubicación: sin coordenadas inventadas (ni oficina ni 0,0) y contables', async () => {
    const cl = await newClient(r1, 'Sin ubicación');
    await direct(r1, cl, { location: gps(-22.95, -43.21) });   // la venta tiene GPS del dispositivo…
    const m = (await map(ana, `?routeId=${r1}`)).body;
    const c = m.clients.find((x) => x.id === cl)!;
    assert.equal(c.location, null, '…pero el cliente sigue SIN ubicación de referencia');
    const without = m.clients.filter((x) => x.location === null).length;
    assert.equal(without, await count(db.admin, `select 1 from adex.clients c where c.company_id = $1 and c.route_id = $2
                                                   and not exists (select 1 from adex.client_locations l where l.client_id = c.id)`, [c1, r1]));
    assert.ok(m.clients.every((x) => x.location === null || !(x.location.lat === 0 && x.location.lng === 0)));
  });

  test('MAP-007 · última actividad CONOCIDA con ubicación por trabajador (operación pasada, no rastreo)', async () => {
    const cl = await newClient();
    const s = await direct(r1, cl);
    const first = await carlos.money('/v1/collections', { saleId: s, amountMinor: 1_000, location: gps(-23.59, -46.67) });
    const lastPay = await carlos.money('/v1/collections', { saleId: s, amountMinor: 1_000, location: gps(-23.60, -46.68) });
    await carlos.money('/v1/collections', { saleId: s, amountMinor: 1_000, location: { status: 'denied' } });   // sin posición: no cuenta
    assert.equal(first.status, 201);
    const m = (await map(ana)).body;
    const k = m.lastKnown.find((x) => x.workerId === carlos.membershipId)!;
    assert.deepEqual([k.kind, k.id, k.lat, k.lng], ['payment', lastPay.body['paymentId'], -23.60, -46.68]);
    assert.ok(!m.lastKnown.some((x) => x.workerId === M.anaAdmin), 'solo Cobradores y Supervisores');
    const d = m.lastKnown.find((x) => x.workerId === dora.membershipId);
    assert.ok(d && d.kind === 'payment');
  });

  test('MAP-008 · seguridad: solo el Administrador, solo sus rutas, nada de otra empresa; la base no entrega coordenadas a otros roles', async () => {
    for (const [who, name] of [[bruno, 'SuperAdmin'], [gabi, 'Secretario'], [carlos.call, 'Cobrador'], [dora.call, 'Supervisor'], [carla, 'SuperAdmin c2']] as const) {
      assert.equal((await who('GET', '/v1/map')).status, 403, name);
    }
    assert.equal((await map(ana, `?routeId=${routeId('c1', 3)}`)).status, 403, 'ruta de su empresa que no tiene asignada');
    assert.ok([403, 404].includes((await map(ana, `?routeId=${routeId('c2', 1)}`)).status), 'ruta de otra empresa');
    const h = (await map(hugo)).body;
    const c1Ids = new Set((await db.admin.query('select id from adex.clients where company_id = $1', [c1])).rows.map((r) => r.id as string));
    assert.ok(h.clients.every((c) => !c1Ids.has(c.id)) && h.activities.every((a) => !c1Ids.has(a.clientId)), 'el Administrador de c2 no ve c1');
    // Segunda barrera: con contexto de Cobrador o SuperAdmin, PostgreSQL no devuelve coordenadas de dispositivo.
    for (const ctx of [{ identityId: carlos.identityId, membershipId: carlos.membershipId }, { identityId: identityOf('bruno'), membershipId: M.brunoSa }]) {
      await asApi(db.api, { ...ctx, companyId: c1 }, async (q) => {
        assert.equal((await q.query('select count(*)::int n from adex.payment_locations')).rows[0].n, 0);
        assert.equal((await q.query('select count(*)::int n from adex.sale_locations')).rows[0].n, 0);
      });
    }
    await asApi(db.api, { identityId: identityOf('bruno'), membershipId: M.brunoSa, companyId: c1 }, async (q) => {
      assert.equal((await q.query('select count(*)::int n from adex.client_locations')).rows[0].n, 0, 'el SuperAdmin no lee coordenadas');
    });
    await asApi(db.api, { identityId: identityOf('ana'), membershipId: M.anaAdmin, companyId: c1 }, async (q) => {
      assert.ok((await q.query('select count(*)::int n from adex.payment_locations')).rows[0].n > 0, 'el Administrador sí, en sus rutas');
    });
  });

  test('MAP-009 · volumen representativo: 2 rutas, 300 clientes, 500 operaciones; respuesta acotada y rápida', async () => {
    const clients: string[] = [];
    for (let i = 0; i < 300; i++) clients.push(await newClient(i % 2 ? r2 : r1, `Vol ${i}`));
    await db.admin.query(`insert into adex.client_locations (id, company_id, client_id, route_id, source, lat, lng, set_by_membership_id, set_by_role, created_at)
                          select gen_random_uuid()::text, c.company_id, c.id, c.route_id, 'map_pin', -23.5 - random() / 10, -46.6 - random() / 10, $2, 'admin', now()
                            from adex.clients c where c.id = any($1::text[]) and right(c.name, 1) in ('0', '2', '4', '6', '8')`, [clients, M.anaAdmin]);
    const sales = await Promise.all(clients.slice(0, 200).map((cl, i) => direct(i % 2 ? r2 : r1, cl)));
    for (let i = 0; i < 200; i++) {
      const who = i % 2 ? dora : carlos;
      assert.equal((await who.money('/v1/collections', { saleId: sales[i]!, amountMinor: 1_000, location: gps(-23.5, -46.6) })).status, 201);
    }
    for (let i = 0; i < 200; i += 2) assert.equal((await carlos.money('/v1/no-payment-visits', { saleId: sales[i]!, reason: 'sin_dinero' })).status, 201);
    const t0 = Date.now();
    const m = await map(ana);
    const ms = Date.now() - t0;
    assert.equal(m.status, 200);
    assert.ok(m.body.clients.length >= 300 && m.body.activities.length >= 500, `${m.body.clients.length} / ${m.body.activities.length}`);
    assert.equal(m.body.truncated, false);
    process.stdout.write(`# MAP-009 GET /v1/map: ${ms} ms, ${m.body.clients.length} clientes, ${m.body.activities.length} actividades
`);
    assert.ok(ms < 3_000, `tiempo ${ms} ms`);
    // Un marcador por cliente: cada cliente tiene su lista de actividad, la más reciente primero.
    const firstByClient = new Map<string, string>();
    for (const a of m.body.activities) if (!firstByClient.has(a.clientId)) firstByClient.set(a.clientId, a.kind);
    assert.ok(firstByClient.size >= 200);
  });

  test('MAP-099 · sin errores inesperados en el servidor', () => {
    assert.deepEqual(api.errors, []);
  });
});
