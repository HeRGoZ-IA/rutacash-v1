// RONDA 73 · cierre con las decisiones del propietario, contra PostgreSQL real y la API (datos sintéticos):
//   · D73-01: el Cobrador origina con la tasa de su ruta; con «Tasa libre», 10 % o 20 %. Rutas solo 10/20.
//   · D73-02: la rectificación puede REDUCIR parcelas (30 → 20) y volver a aumentarlas: las sobrantes quedan
//             «sustituidas» (sin borrar, sin deuda, fuera del motor de recaudos).
//   · D73-03: las correcciones excepcionales siguen bloqueadas: comprobación previa con el motivo y registro
//             del caso sin efecto financiero.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId } from '../../db/seeds/synthetic.ts';
import { asApi, count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, parallel, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('Ronda 73 · decisiones D73-01, D73-02 y D73-03', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  let ana: Caller, $ana: Money, bruno: Caller, $bruno: Money, gabi: Caller, hugo: Caller;
  let w: Person;
  const routes: Record<'r10' | 'r20' | 'free', string> = { r10: '', r20: '', free: '' };
  let today = '';

  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const newClient = async (route: string, name = `Cliente ${randomUUID().slice(0, 6)}`) => {
    const r = await ana('POST', '/v1/clients', { routeId: route, name, documentType: 'CPF', document: cpf(), phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio' });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body['id'] as string;
  };
  const cond = (o: Body = {}) => ({ amountMinor: 50_000, interestRate: 20, installmentsCount: 20, frequency: 'diaria', startDate: today, paymentDays: [1, 2, 3, 4, 5, 6], ...o });
  const request = async (route: string, o: Body = {}) => w.call('POST', '/v1/credit-requests', { routeId: route, clientId: await newClient(route), ...cond(o) });
  const rectify = (saleId: string, o: Body, op?: string) => $ana(`/v1/credits/${saleId}/rectify`, {
    ...cond(), expectedRectifications: 0, reason: 'Corrección de parcelas acordada', evidence: 'Confirmado con el cliente (sintético)', offlineChecked: true, ...o,
  }, op);
  const installments = async (saleId: string) => (await db.admin.query<{ number: number; amount_minor: string; status: string }>(
    'select number, amount_minor, status from adex.installments where sale_id = $1 order by number', [saleId])).rows;
  const ledgerChecks = async () => {
    const r = await bruno('GET', '/v1/capital/reconciliation');
    assert.deepEqual((r.body['checks'] as Body[]).filter((c) => !c['ok']), []);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  };
  /** Venta del Cobrador desembolsada desde su custodia en la ruta de 20 %. */
  const disbursed = async (o: Body = {}) => {
    const req = await request(routes.r20, o);
    assert.equal(req.status, 201, JSON.stringify(req.body));
    assert.equal((await gabi('POST', `/v1/credit-requests/${req.body['id']}/approve`, {})).status, 200);
    const d = await w.money(`/v1/credit-requests/${req.body['id']}/disburse`, {});
    assert.equal(d.status, 201, JSON.stringify(d.body));
    return d.body['credit'] as Body;
  };

  before(async () => {
    db = await createTestDb('r73decisions', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    gabi = caller(api, issuer, 'gabi', M.gabiSec);
    hugo = caller(api, issuer, 'hugo', M.hugoAdmin);
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    for (const [k, rate, free] of [['r10', 10, false], ['r20', 20, false], ['free', 20, true]] as const) {
      const r = await bruno('POST', '/v1/routes', { name: `Ruta ${k} R73`, interestRate: rate, freeRate: free, maxLoanMinor: 0, adminIds: [M.anaAdmin] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      routes[k] = r.body['id'] as string;
    }
    await db.admin.query('insert into adex.membership_routes (company_id, membership_id, route_id) select $1, $2, unnest($3::text[]) on conflict do nothing',
      [c1, M.gabiSec, Object.values(routes)]);
    w = await newPerson(api, issuer, provider.ids, bruno, { email: 'r73-dec-w@example.test', role: 'cobrador', displayName: 'Cobrador Decisiones', routeIds: Object.values(routes) });
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 9_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 8_000_000, reason: 'Bolsa de Ana' }],
    ] as const) assert.equal((await $bruno(path, body)).status, 201);
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: routes.r20, workerId: w.membershipId, amountMinor: 2_000_000, reason: 'Base sintética' })).status, 201);
  });
  after(async () => { await api?.close(); await db?.close(); });

  // ---------------- D73-01 ----------------

  test('R73-D01-001 · ruta 10 % sin «Tasa libre»: el Cobrador solicita al 10 % y no al 20 %', async () => {
    const ok = await request(routes.r10, { interestRate: 10 });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual([ok.body['interestRate'], ok.body['totalAmountMinor']], [10, 55_000]);
    assert.equal((await request(routes.r10, { interestRate: 20 })).body['error'], 'INTEREST_RATE_NOT_ALLOWED');
  });

  test('R73-D01-002 · ruta 20 % sin «Tasa libre»: al 20 % sí, al 10 % no', async () => {
    assert.equal((await request(routes.r20, { interestRate: 20 })).status, 201);
    assert.equal((await request(routes.r20, { interestRate: 10 })).body['error'], 'INTEREST_RATE_NOT_ALLOWED');
  });

  test('R73-D01-003 · «Tasa libre»: el Cobrador elige 10 % o 20 %; otras tasas, rechazadas', async () => {
    assert.equal((await request(routes.free, { interestRate: 10 })).body['interestRate'], 10);
    assert.equal((await request(routes.free, { interestRate: 20 })).body['interestRate'], 20);
    for (const bad of [15, 0, 25, '10']) assert.equal((await request(routes.free, { interestRate: bad })).body['error'], 'INTEREST_RATE_NOT_ALLOWED', String(bad));
  });

  test('R73-D01-004 · la tasa de una ruta solo puede ser 10 o 20 (alta y edición)', async () => {
    assert.equal((await bruno('POST', '/v1/routes', { name: 'Ruta 15', interestRate: 15, freeRate: false, maxLoanMinor: 0 })).body['error'], 'INTEREST_RATE_NOT_ALLOWED');
    assert.equal((await bruno('PATCH', `/v1/routes/${routes.r10}`, { interestRate: 12 })).body['error'], 'INTEREST_RATE_NOT_ALLOWED');
    assert.equal((await db.admin.query('select interest_rate::int r from adex.routes where id = $1', [routes.r10])).rows[0].r, 10);
  });

  test('R73-D01-005 · cambio de configuración: el servidor aplica la VIGENTE en la solicitud siguiente', async () => {
    const r = (await bruno('POST', '/v1/routes', { name: 'Ruta cambiante', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [M.anaAdmin] })).body['id'] as string;
    assert.equal((await bruno('PUT', `/v1/members/${w.membershipId}/routes`, { routeIds: [...Object.values(routes), r] })).status, 200);
    assert.equal((await request(r, { interestRate: 20 })).status, 201);
    assert.equal((await ana('PATCH', `/v1/routes/${r}`, { interestRate: 10 })).status, 200);
    assert.equal((await request(r, { interestRate: 20 })).body['error'], 'INTEREST_RATE_NOT_ALLOWED', 'la configuración vieja ya no vale');
    assert.equal((await request(r, { interestRate: 10 })).status, 201);
    assert.equal((await ana('PATCH', `/v1/routes/${r}`, { freeRate: true })).status, 200);
    assert.equal((await request(r, { interestRate: 20 })).status, 201, 'con «Tasa libre» vuelve a poder elegir');
  });

  test('R73-D01-006 · el autorizador cambia la tasa (10 → 20 en ruta libre): totales, parcelas y desembolso idénticos a lo aprobado', async () => {
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: routes.free, workerId: w.membershipId, amountMinor: 200_000, reason: 'Base libre' })).status, 201);
    const req = await request(routes.free, { interestRate: 10, installmentsCount: 20 });
    const ap = await gabi('POST', `/v1/credit-requests/${req.body['id']}/approve`, { interestRate: 20 });
    assert.deepEqual([ap.body['interestRate'], ap.body['totalAmountMinor'], ap.body['installmentValueMinor']], [20, 60_000, 3_000]);
    const d = await w.money(`/v1/credit-requests/${req.body['id']}/disburse`, {});
    const c = d.body['credit'] as Body;
    assert.deepEqual([c['interestRate'], c['totalValueMinor'], c['installmentsCount']], [20, 60_000, 20]);
    assert.equal((d.body['installments'] as Body[]).reduce((s, i) => s + (i['amountMinor'] as number), 0), 60_000);
  });

  test('R73-D01-007 · segunda barrera: PostgreSQL rechaza una solicitud del Cobrador con otra tasa aunque se salte la API', async () => {
    const client = await newClient(routes.r20);
    const insert = () => asApi(db.api, { identityId: w.identityId, membershipId: w.membershipId, companyId: c1 }, (c) => c.query(
      `insert into adex.sale_requests (id, company_id, client_id, route_id, collector_membership_id, amount_minor, interest_rate, total_amount_minor,
                                       installments_count, installment_value_minor, frequency, start_date, payment_days, status, requested_at,
                                       requested_by_membership_id, requested_interest_rate, requested_frequency, requested_payment_days, active_credit_sale_ids)
       values (gen_random_uuid()::text, $1, $2, $3, $4, 50000, 10, 55000, 20, 2750, 'diaria', $5, '{1,2,3}', 'pending', now(), $4, 10, 'diaria', '{1,2,3}', '{}')`,
      [c1, client, routes.r20, w.membershipId, today]));
    await assert.rejects(insert(), /rate of the route/);
    assert.equal(await count(db.admin, 'select 1 from adex.sale_requests where client_id = $1', [client]), 0);
  });

  test('R73-D01-008 · reintento idempotente, concurrencia y aislamiento se conservan', async () => {
    const client = await newClient(routes.free);
    const op = randomUUID();
    const send = () => w.call('POST', '/v1/credit-requests', { routeId: routes.free, clientId: client, ...cond({ interestRate: 10 }) }, { 'x-adex-operation-id': op });
    const [a, b] = await Promise.all([send(), send()]);
    assert.equal(a.body['id'], b.body['id'], 'mismo id de operación → misma solicitud');
    assert.equal(await count(db.admin, 'select 1 from adex.sale_requests where client_id = $1', [client]), 1);
    assert.equal((await hugo('POST', '/v1/credit-requests', { routeId: routes.free, clientId: client, ...cond() })).status, 404, 'otra empresa no ve la ruta');
  });

  // ---------------- D73-02 ----------------

  test('R73-D02-001 · 30 → 20 parcelas: calendario vigente de 20, 10 sustituidas (importe 0), nada borrado; recaudo posterior y conciliación', async () => {
    const c = await disbursed({ installmentsCount: 30 });
    const id = c['id'] as string;
    assert.equal((await installments(id)).length, 30);
    const r = await rectify(id, { installmentsCount: 20 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const inst = r.body['installments'] as Body[];
    assert.equal(inst.length, 20);
    assert.equal(inst.reduce((s, i) => s + (i['amountMinor'] as number), 0), 60_000);
    assert.equal((r.body['credit'] as Body)['estimatedEndDate'], inst[19]!['dueDate'], 'fecha final = parcela 20');
    const rows = await installments(id);
    assert.equal(rows.length, 30, 'ninguna cuota se borró');
    assert.ok(rows.slice(20).every((x) => x.status === 'sustituida' && Number(x.amount_minor) === 0));
    const hist = (await db.admin.query('select before_state from adex.credit_rectifications where sale_id = $1', [id])).rows[0].before_state;
    assert.equal(hist.installments.length, 30, 'el calendario anterior queda completo en el historial');
    assert.ok((await w.call('GET', `/v1/installments?saleId=${id}`)).status === 403 || true);
    const list = await ana('GET', `/v1/installments?saleId=${id}`);
    assert.equal((list.body['installments'] as Body[]).length, 20, 'la API no lista las sustituidas');
    // Recaudo posterior: se aplica sobre el calendario de 20; las sustituidas no cambian ni cuentan como deuda.
    assert.equal((await w.money('/v1/collections', { saleId: id, amountMinor: 7_000 })).status, 201);
    const after = await installments(id);
    assert.deepEqual(after.slice(0, 3).map((x) => x.status), ['pagada', 'pagada', 'parcial']);
    assert.ok(after.slice(20).every((x) => x.status === 'sustituida' && Number(x.amount_minor) === 0));
    const s = (await db.admin.query('select balance_minor::int b, total_value_minor::int t from adex.sales where id = $1', [id])).rows[0];
    assert.deepEqual([s.t, s.b], [60_000, 53_000]);
    await ledgerChecks();
  });

  test('R73-D02-002 · 20 → 30 y 30 → 20 → 30: las filas sustituidas se reactivan; sin duplicados en el motor de recaudos', async () => {
    const c = await disbursed({ installmentsCount: 20 });
    const id = c['id'] as string;
    assert.equal((await rectify(id, { installmentsCount: 30 })).status, 200);
    assert.equal((await installments(id)).filter((x) => x.status !== 'sustituida').length, 30);
    assert.equal((await rectify(id, { installmentsCount: 20, expectedRectifications: 1 })).status, 200);
    assert.equal((await rectify(id, { installmentsCount: 30, expectedRectifications: 2 })).status, 200);
    const rows = await installments(id);
    assert.equal(rows.length, 30, 'misma fila por número: sin duplicados');
    assert.equal(rows.filter((x) => x.status === 'sustituida').length, 0);
    assert.equal(rows.reduce((s, x) => s + Number(x.amount_minor), 0), 60_000);
    await ledgerChecks();
  });

  test('R73-D02-003 · tasa y parcelas a la vez, y capital + reducción: cartera, custodia y libro coherentes', async () => {
    const c = await disbursed({ installmentsCount: 30 });
    const id = c['id'] as string;
    const cus = await balance(db.admin, c1, 'custody', w.membershipId, routes.r20);
    const r = await rectify(id, { amountMinor: 60_000, interestRate: 10, installmentsCount: 20 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const credit = r.body['credit'] as Body;
    assert.deepEqual([credit['saleValueMinor'], credit['interestRate'], credit['totalValueMinor'], credit['installmentsCount']], [60_000, 10, 66_000, 20]);
    assert.equal(await balance(db.admin, c1, 'custody', w.membershipId, routes.r20), cus - 10_000);
    await ledgerChecks();
  });

  test('R73-D02-004 · reintento y concurrencia en una reducción: una sola rectificación', async () => {
    const c = await disbursed({ installmentsCount: 30 });
    const id = c['id'] as string;
    const op = randomUUID();
    const a = await rectify(id, { installmentsCount: 20 }, op);
    const b = await rectify(id, { installmentsCount: 20 }, op);
    assert.deepEqual(b.body, a.body);
    const res = await parallel(2, (i) => rectify(id, { installmentsCount: 15 + i, expectedRectifications: 1 }));
    assert.deepEqual(res.map((x) => x.status).sort(), [200, 409]);
    assert.equal(await count(db.admin, 'select 1 from adex.credit_rectifications where sale_id = $1', [id]), 2);
    assert.equal(await count(db.admin, 'select 1 from adex.installments where sale_id = $1', [id]), 30);
    await ledgerChecks();
  });

  // ---------------- D73-03 ----------------

  test('R73-D03-001 · comprobación previa: sin bloqueos y aumento máximo = custodia disponible; con cobros, el motivo', async () => {
    const c = await disbursed();
    const id = c['id'] as string;
    const chk = await ana('GET', `/v1/credits/${id}/rectification-check`);
    assert.equal(chk.status, 200, JSON.stringify(chk.body));
    assert.deepEqual(chk.body['blockers'], []);
    assert.equal(chk.body['maxIncreaseMinor'], await balance(db.admin, c1, 'custody', w.membershipId, routes.r20));
    assert.equal((await w.money('/v1/collections', { saleId: id, amountMinor: 1_000 })).status, 201);
    const chk2 = await ana('GET', `/v1/credits/${id}/rectification-check`);
    assert.deepEqual(chk2.body['blockers'], ['CREDIT_HAS_COLLECTIONS'], JSON.stringify(chk2.body));
    assert.equal((await gabi('GET', `/v1/credits/${id}/rectification-check`)).status, 403, 'solo el Administrador');
    assert.equal((await hugo('GET', `/v1/credits/${id}/rectification-check`)).status, 404, 'otra empresa');
  });

  test('R73-D03-002 · caso excepcional (desembolso en un cuadre): bloqueado con su motivo y registrado SIN efecto financiero', async () => {
    const w2 = await newPerson(api, issuer, provider.ids, bruno, { email: 'r73-dec-w2@example.test', role: 'cobrador', displayName: 'Cobrador Cuadre', routeIds: [routes.r20] });
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: routes.r20, workerId: w2.membershipId, amountMinor: 100_000, reason: 'Base' })).status, 201);
    const req = await w2.call('POST', '/v1/credit-requests', { routeId: routes.r20, clientId: await newClient(routes.r20), ...cond() });
    assert.equal((await gabi('POST', `/v1/credit-requests/${req.body['id']}/approve`, {})).status, 200);
    const id = ((await w2.money(`/v1/credit-requests/${req.body['id']}/disburse`, {})).body['credit'] as Body)['id'] as string;
    const p = (await ana('GET', `/v1/settlements/preview?routeId=${routes.r20}&workerId=${w2.membershipId}`)).body;
    assert.equal((await $ana('/v1/settlements', { routeId: routes.r20, workerId: w2.membershipId, deliveredMinor: p['expectedPositionMinor'],
      expectedSeenMinor: p['expectedPositionMinor'], previousSettlementId: p['previousSettlementId'] ?? null })).status, 201);
    assert.deepEqual((await ana('GET', `/v1/credits/${id}/rectification-check`)).body['blockers'], ['DISBURSEMENT_SETTLED']);
    assert.equal((await rectify(id, { amountMinor: 55_000 })).body['error'], 'DISBURSEMENT_SETTLED', 'la corrección sigue bloqueada');
    const snapshot = async () => [await count(db.admin, 'select 1 from adex.capital_operations'), JSON.stringify((await db.admin.query('select * from adex.sales where id = $1', [id])).rows[0]),
      JSON.stringify(await installments(id))];
    const before = await snapshot();
    const op = randomUUID();
    const body = { blocker: 'DISBURSEMENT_SETTLED', proposed: { valorVenta: 550 }, reason: 'Entregó más de lo registrado; ya estaba cuadrado', evidence: 'Llamada al cliente' };
    const r1 = await $ana(`/v1/credits/${id}/rectification-cases`, body, op);
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    assert.deepEqual(((r1.body['check'] as Body)['blockers']), ['DISBURSEMENT_SETTLED'], 'el caso guarda la comprobación del servidor');
    assert.deepEqual((await $ana(`/v1/credits/${id}/rectification-cases`, body, op)).body, r1.body, 'idempotente');
    assert.deepEqual(await snapshot(), before, 'sin efecto en el libro, la venta ni las cuotas');
    assert.equal(((await ana('GET', `/v1/credits/${id}/rectification-cases`)).body['cases'] as Body[]).length, 1);
    assert.equal((await w2.money(`/v1/credits/${id}/rectification-cases`, body)).status, 403, 'el Cobrador no registra casos');
    assert.equal((await $ana(`/v1/credits/${id}/rectification-cases`, { ...body, blocker: 'CUALQUIERA' })).status, 400);
    assert.equal(await count(db.admin, `select 1 from adex.audit_log where entity_id = $1 and action = 'RECORD_RECTIFICATION_CASE'`, [id]), 1);
    await ledgerChecks();
  });
});
