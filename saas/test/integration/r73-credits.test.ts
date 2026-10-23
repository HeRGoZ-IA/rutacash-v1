// RONDA 73 · Bloque A contra PostgreSQL real y la API (datos 100 % sintéticos).
//   · SOC-07: la tasa AUTORIZADA es la que genera las obligaciones (reproducción del caso
//     20 % → 10 % y de lo que enviaba el puente defectuoso de ADEX Online);
//   · SOC-04: el autorizador cambia el número de parcelas antes de aprobar (0030);
//   · SOC-09: el Administrador rectifica un crédito desembolsado sin recaudos (0030):
//     capital hacia arriba y hacia abajo, solo interés/parcelas, fondos, cuadres,
//     permisos, aislamiento, idempotencia, concurrencia, redondeo e historial.
// Verificación independiente con SQL propio y la conciliación del SuperAdmin.
//
// Importes en unidades menores (BRL): R$ 500 = 50_000.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, routeId } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, parallel, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';
import { calculateTotalWithInterest } from '@/services/installmentEngine';

type Body = Record<string, unknown>;

describe('Ronda 73 · bloque A: condiciones autorizadas, parcelas y rectificación de créditos', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  let ana: Caller, $ana: Money, gabi: Caller, bruno: Caller, $bruno: Money, hugo: Caller;
  let xavier: Person, dora: Person;
  let today = '';
  let n = 0;

  const custody = (m: string, r: string) => balance(db.admin, c1, 'custody', m, r);
  const pool = (m: string) => balance(db.admin, c1, 'admin', m);
  const portfolio = (r: string) => balance(db.admin, c1, 'portfolio', null, r);
  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const newClient = async (name: string) => {
    const r = await ana('POST', '/v1/clients', { routeId: r1, name, documentType: 'CPF', document: cpf(), phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body['id'] as string;
  };
  const cond = (o: Body = {}) => ({ amountMinor: 50_000, interestRate: 20, installmentsCount: 12, frequency: 'diaria', startDate: today, paymentDays: [1, 2, 3, 4, 5, 6], ...o });
  const worker = async () => {
    n += 1;
    const w = await newPerson(api, issuer, provider.ids, bruno, { email: `r73-w${n}@example.test`, role: 'cobrador', displayName: `Cobrador ${n}`, routeIds: [r1] });
    return w;
  };
  const fund = async (w: Person, amountMinor: number) =>
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: w.membershipId, amountMinor, reason: 'Base sintética' })).status, 201);
  /** Solicitud del Cobrador → aprobación (cuerpo dado) → desembolso desde su custodia. */
  const viaRequest = async (w: Person, approve: Body = {}, o: Body = {}) => {
    const req = await w.call('POST', '/v1/credit-requests', { routeId: r1, clientId: await newClient(`Cliente ${randomUUID().slice(0, 6)}`), ...cond(o) });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    const ap = await gabi('POST', `/v1/credit-requests/${req.body['id']}/approve`, approve);
    assert.equal(ap.status, 200, JSON.stringify(ap.body));
    const d = await w.money(`/v1/credit-requests/${req.body['id']}/disburse`, {});
    assert.equal(d.status, 201, JSON.stringify(d.body));
    return { requestId: req.body['id'] as string, approval: ap.body, credit: d.body['credit'] as Body, installments: d.body['installments'] as Body[] };
  };
  const rectify = (m: Money, saleId: string, o: Body, op?: string) => m(`/v1/credits/${saleId}/rectify`, {
    ...cond(), expectedRectifications: 0, reason: 'Entregó R$ 1.500 y registró R$ 1.400', evidence: 'Confirmado por teléfono con el cliente', offlineChecked: true, ...o,
  }, op);
  const sumOf = (inst: Body[]) => inst.reduce((s, i) => s + (i['amountMinor'] as number), 0);
  const dbInstallments = async (saleId: string) => (await db.admin.query<{ number: number; amount_minor: string; due_date: string }>(
    'select number, amount_minor, due_date::text from adex.installments where sale_id = $1 order by number', [saleId])).rows;
  const ledgerChecks = async () => {
    const r = await bruno('GET', '/v1/capital/reconciliation');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const failed = (r.body['checks'] as Body[]).filter((c) => !c['ok']);
    assert.deepEqual(failed, [], 'conciliación del SuperAdmin sin fallos');
  };

  before(async () => {
    db = await createTestDb('r73credits', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    gabi = caller(api, issuer, 'gabi', M.gabiSec);
    hugo = caller(api, issuer, 'hugo', M.hugoAdmin);
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    xavier = await newPerson(api, issuer, provider.ids, bruno, { email: 'r73-xavier@example.test', role: 'admin', displayName: 'Xavier', routeIds: [r1] });
    dora = await newPerson(api, issuer, provider.ids, bruno, { email: 'r73-dora@example.test', role: 'supervisor', displayName: 'Dora', routeIds: [r1] });
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 3_000_000, reason: 'Bolsa de Ana' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
  });
  after(async () => { await api?.close(); await db?.close(); });

  // ---------------- SOC-07 ----------------

  test('R73-SOC07-001 · reproducción: aprobar SIN enviar la tasa (lo que hacía el puente) deja el 20 % en las parcelas', async () => {
    const w = await worker(); await fund(w, 60_000);
    const { credit, installments } = await viaRequest(w, { notes: 'Aprobada' });
    assert.deepEqual([credit['interestRate'], credit['totalValueMinor'], installments[0]!['amountMinor']], [20, 60_000, 5_000],
      'el servidor desembolsa exactamente lo aprobado: si la tasa no llega, sigue el 20 %');
  });

  test('R73-SOC07-002 · solicitud 20 % → aprobación 10 % → desembolso 10 %: total, parcelas y asiento del 10 %', async () => {
    const w = await worker(); await fund(w, 60_000);
    const { approval, credit, installments, requestId } = await viaRequest(w, { interestRate: 10 });
    assert.deepEqual([approval['interestRate'], approval['totalAmountMinor'], approval['installmentValueMinor']], [10, 55_000, 4_583]);
    assert.deepEqual((approval['requested'] as Body)['interestRate'], 20, 'lo solicitado se conserva');
    assert.deepEqual([credit['interestRate'], credit['interestValueMinor'], credit['totalValueMinor'], credit['balanceMinor']], [10, 5_000, 55_000, 55_000]);
    assert.equal(installments.length, 12);
    assert.equal(sumOf(installments), 55_000, 'Σ parcelas = total al 10 %');
    assert.ok(installments.slice(0, 11).every((i) => i['amountMinor'] === 4_583), 'valor de parcela del 10 %');
    const db12 = await dbInstallments(credit['id'] as string);
    assert.equal(db12.reduce((s, i) => s + Number(i.amount_minor), 0), 55_000, 'PostgreSQL guarda el 10 %');
    const actions = (await db.admin.query(`select action from adex.audit_log where entity_id = $1 order by action`, [requestId])).rows.map((x) => x.action);
    assert.ok(actions.includes('CHANGE_SALE_CONDITIONS'), 'auditoría del cambio de condiciones');
  });

  test('R73-SOC07-003 · solicitud 20 % → aprobación 20 % (sin cambios): sin auditoría de cambio', async () => {
    const w = await worker(); await fund(w, 60_000);
    const { credit, requestId } = await viaRequest(w, { interestRate: 20, frequency: 'diaria', paymentDays: [1, 2, 3, 4, 5, 6], installmentsCount: 12 });
    assert.deepEqual([credit['interestRate'], credit['totalValueMinor']], [20, 60_000]);
    const actions = (await db.admin.query(`select action from adex.audit_log where entity_id = $1`, [requestId])).rows.map((x) => x.action);
    assert.ok(!actions.includes('CHANGE_SALE_CONDITIONS'));
  });

  test('R73-SOC07-004 · reintentos y concurrencia: una sola aprobación gana; el desembolso repetido con el mismo id no duplica', async () => {
    const w = await worker(); await fund(w, 60_000);
    const req = await w.call('POST', '/v1/credit-requests', { routeId: r1, clientId: await newClient('Concurrente'), ...cond() });
    const id = req.body['id'] as string;
    const fabio = caller(api, issuer, 'fabio', M.fabioSec);
    const res = await Promise.all([gabi('POST', `/v1/credit-requests/${id}/approve`, { interestRate: 10 }), fabio('POST', `/v1/credit-requests/${id}/approve`, { interestRate: 20 })]);
    assert.deepEqual(res.map((r) => r.status).sort(), [200, 409]);
    const winner = res.find((r) => r.status === 200)!.body;
    assert.equal((await gabi('POST', `/v1/credit-requests/${id}/approve`, { interestRate: 10 })).body['error'], 'REQUEST_STATE_INVALID', 'reintento: ya resuelta');
    const op = randomUUID();
    const d1 = await w.money(`/v1/credit-requests/${id}/disburse`, {}, op);
    const d2 = await w.money(`/v1/credit-requests/${id}/disburse`, {}, op);
    assert.equal(d1.status, 201);
    assert.deepEqual(d2.body, d1.body, 'el reintento devuelve el mismo resultado');
    assert.equal((d1.body['credit'] as Body)['interestRate'], winner['interestRate'], 'el crédito tiene la tasa de la aprobación ganadora');
    assert.equal(await count(db.admin, 'select 1 from adex.sales where sale_request_id = $1', [id]), 1);
  });

  test('R73-SOC07-005 · condiciones inválidas, permisos y aislamiento entre empresas', async () => {
    const w = await worker();
    const id = (await w.call('POST', '/v1/credit-requests', { routeId: r1, clientId: await newClient('Inválidas'), ...cond() })).body['id'] as string;
    assert.equal((await gabi('POST', `/v1/credit-requests/${id}/approve`, { interestRate: 15 })).body['error'], 'INTEREST_RATE_NOT_ALLOWED');
    assert.equal((await gabi('POST', `/v1/credit-requests/${id}/approve`, { interestRate: '10' })).body['error'], 'INTEREST_RATE_NOT_ALLOWED');
    assert.equal((await w.call('POST', `/v1/credit-requests/${id}/approve`, { interestRate: 10 })).status, 403, 'el Cobrador no aprueba');
    assert.equal((await hugo('POST', `/v1/credit-requests/${id}/approve`, { interestRate: 10 })).status, 404, 'otra empresa no la ve');
    assert.equal((await db.admin.query('select status, interest_rate::int r from adex.sale_requests where id = $1', [id])).rows[0].status, 'pending');
  });

  // ---------------- SOC-05 ----------------

  test('R73-SOC05-001 · Negocio obligatorio al crear; vacío o espacios rechazados; clientes anteriores sin negocio siguen editables y nada se rellena', async () => {
    const base = { routeId: r1, name: 'Cliente Negocio', documentType: 'CPF', phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b' };
    for (const business of [undefined, '', '   ', null]) {
      const r = await ana('POST', '/v1/clients', { ...base, document: cpf(), ...(business === undefined ? {} : { business }) });
      assert.deepEqual([r.status, r.body['error']], [400, 'INVALID_INPUT'], String(business));
    }
    const ok = await ana('POST', '/v1/clients', { ...base, document: cpf(), business: '  Panadería  ' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body['business'], 'Panadería');
    assert.equal((await ana('PATCH', `/v1/clients/${ok.body['id']}`, { business: ' ' })).body['error'], 'INVALID_INPUT', 'un negocio registrado no se vacía');
    // Cliente ANTERIOR a la regla (sin negocio): se simula en esta base sintética aislada.
    const legacy = await ana('POST', '/v1/clients', { ...base, document: cpf(), business: 'Temporal' });
    await db.admin.query('update adex.clients set business = null where id = $1', [legacy.body['id']]);
    const old = { id: legacy.body['id'] as string };
    const before = await count(db.admin, 'select 1 from adex.clients where business is null');
    const edit = await ana('PATCH', `/v1/clients/${old.id}`, { phoneSecondary: '2', business: '' });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal((await db.admin.query('select business from adex.clients where id = $1', [old.id])).rows[0].business, null, 'no se inventa un negocio');
    assert.equal(await count(db.admin, 'select 1 from adex.clients where business is null'), before, 'ningún cliente existente se rellenó');
  });

  // ---------------- SOC-02 ----------------

  test('R73-SOC02-001 · venta directa del Administrador responsable: paga su BOLSA aunque la ruta no tenga efectivo en custodia; fondos insuficientes y concurrencia', async () => {
    const zoe = await newPerson(api, issuer, provider.ids, bruno, { email: 'r73-zoe@example.test', role: 'admin', displayName: 'Zoe', routeIds: [] });
    const route = (await bruno('POST', '/v1/routes', { name: 'Ruta R73', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [zoe.membershipId, xavier.membershipId] })).body;
    const rz = route['id'] as string;
    assert.equal(route['capitalControllerId'], zoe.membershipId, 'Zoe es la responsable de capital');
    assert.equal((await $bruno('/v1/capital/allocations', { adminId: zoe.membershipId, amountMinor: 100_000, reason: 'Bolsa de Zoe' })).status, 201);
    const client = async (name: string) => (await zoe.call('POST', '/v1/clients', { routeId: rz, name, documentType: 'CPF', document: cpf(), phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' })).body['id'] as string;
    assert.equal(await count(db.admin, `select 1 from adex.capital_accounts where kind = 'custody' and route_id = $1 and balance_minor > 0`, [rz]), 0, 'sin efectivo en la ruta');
    const ok = await zoe.money('/v1/credits/direct', { routeId: rz, clientId: await client('Directa Zoe'), ...cond({ amountMinor: 60_000 }) });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(await pool(zoe.membershipId), 40_000, 'salió de la bolsa de Zoe');
    assert.equal((await zoe.money('/v1/credits/direct', { routeId: rz, clientId: await client('Sin fondos'), ...cond({ amountMinor: 40_001 }) })).body['error'], 'INSUFFICIENT_FUNDS');
    assert.equal((await xavier.money('/v1/credits/direct', { routeId: rz, clientId: await client('No responsable'), ...cond({ amountMinor: 1_000 }) })).body['error'], 'CAPITAL_AUTHORITY_REQUIRED',
      'otro Administrador de la ruta no gasta la bolsa del responsable');
    const [a, b] = [await client('Concurrente A'), await client('Concurrente B')];
    const res = await Promise.all([a, b].map((c) => zoe.money('/v1/credits/direct', { routeId: rz, clientId: c, ...cond({ amountMinor: 30_000 }) })));
    assert.deepEqual(res.map((r) => r.status).sort(), [201, 409], 'dos ventas de 30.000 con 40.000: una sola');
    assert.equal(await pool(zoe.membershipId), 10_000, 'sin doble consumo');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  // ---------------- SOC-04 ----------------

  test('R73-SOC04-001 · el autorizador cambia 12 → 20 parcelas: valor, total, calendario y fecha final recalculados; pedido y aprobado se conservan', async () => {
    const w = await worker(); await fund(w, 60_000);
    const { approval, credit, installments, requestId } = await viaRequest(w, { installmentsCount: 20, interestRate: 10 });
    assert.deepEqual([approval['installmentsCount'], approval['installmentValueMinor'], approval['totalAmountMinor']], [20, 2_750, 55_000]);
    assert.equal((approval['requested'] as Body)['installmentsCount'], 12);
    assert.equal((approval['approved'] as Body)['installmentsCount'], 20);
    assert.equal(installments.length, 20);
    assert.equal(sumOf(installments), 55_000);
    assert.equal(credit['estimatedEndDate'], installments[19]!['dueDate'], 'fecha final = última parcela');
    assert.deepEqual((await db.admin.query('select requested_installments_count r, approved_installments_count a, installments_count c from adex.sale_requests where id = $1', [requestId])).rows,
      [{ r: 12, a: 20, c: 20 }]);
    const change = (await db.admin.query(`select before_data, after_data from adex.audit_log where entity_id = $1 and action = 'CHANGE_SALE_CONDITIONS'`, [requestId])).rows[0];
    assert.deepEqual([change.before_data.installmentsCount, change.after_data.installmentsCount], [12, 20]);
  });

  test('R73-SOC04-002 · parcelas inválidas, sin autoridad o en una solicitud ya resuelta: nada cambia', async () => {
    const w = await worker();
    const id = (await w.call('POST', '/v1/credit-requests', { routeId: r1, clientId: await newClient('Parcelas'), ...cond() })).body['id'] as string;
    for (const bad of [0, 1001, 2.5, '20']) {
      assert.equal((await gabi('POST', `/v1/credit-requests/${id}/approve`, { installmentsCount: bad })).body['error'], 'INVALID_INPUT', String(bad));
    }
    assert.equal((await db.admin.query('select installments_count c from adex.sale_requests where id = $1', [id])).rows[0].c, 12);
    // Rechazar no cambia parcelas; tras resolverla ya no se aprueba.
    assert.equal((await gabi('POST', `/v1/credit-requests/${id}/reject`, { reason: 'Sin referencias' })).status, 200);
    assert.equal((await gabi('POST', `/v1/credit-requests/${id}/approve`, { installmentsCount: 20 })).body['error'], 'REQUEST_STATE_INVALID');
    // Segunda barrera: la API no puede cambiar las parcelas de una solicitud PENDIENTE fuera de la aprobación.
    const id2 = (await w.call('POST', '/v1/credit-requests', { routeId: r1, clientId: await newClient('Parcelas 2'), ...cond() })).body['id'] as string;
    const client = await db.api.connect();
    try {
      const r = await client.query('update adex.sale_requests set installments_count = 20 where id = $1', [id2]).catch((e: unknown) => e);
      assert.ok(r instanceof Error || (r as { rowCount: number }).rowCount === 0, 'sin contexto válido no cambia nada');
    } finally { client.release(); }
    assert.equal((await db.admin.query('select installments_count c from adex.sale_requests where id = $1', [id2])).rows[0].c, 12);
  });

  // ---------------- SOC-09 ----------------

  test('R73-SOC09-001 · capital HACIA ARRIBA (custodia): R$ 1.400 → R$ 1.500 con la diferencia como ajuste; asiento original intacto', async () => {
    const w = await worker(); await fund(w, 200_000);
    const { credit } = await viaRequest(w, {}, { amountMinor: 140_000 });
    const saleId = credit['id'] as string;
    const original = (await db.admin.query('select * from adex.capital_operations where id = $1', [credit['ledgerOperationId']])).rows[0];
    const [cus, port] = [await custody(w.membershipId, r1), await portfolio(r1)];
    const r = await rectify($ana, saleId, { amountMinor: 150_000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = r.body['credit'] as Body;
    assert.deepEqual([c['saleValueMinor'], c['interestRate'], c['totalValueMinor'], c['balanceMinor'], c['rectificationCount']], [150_000, 20, 180_000, 180_000, 1]);
    assert.deepEqual([c['disbursementDate'], c['disbursedAt'], c['ledgerOperationId'], c['saleRequestId']],
      [credit['disbursementDate'], credit['disbursedAt'], credit['ledgerOperationId'], credit['saleRequestId']], 'fecha, hora, asiento y solicitud históricos');
    assert.equal(sumOf(r.body['installments'] as Body[]), 180_000);
    assert.equal(await custody(w.membershipId, r1), cus - 10_000, 'la custodia refleja el efectivo realmente entregado');
    assert.equal(await portfolio(r1), port + 10_000, 'la cartera, el capital realmente prestado');
    assert.deepEqual((await db.admin.query('select * from adex.capital_operations where id = $1', [credit['ledgerOperationId']])).rows[0], original, 'asiento original sin cambios');
    const rect = (r.body['rectification'] as Body);
    assert.equal(rect['deltaMinor'], 10_000);
    const legs = (await db.admin.query(`select a.kind, e.amount_minor::int amt, o.kind ok, o.sale_id from adex.capital_entries e
      join adex.capital_accounts a on a.id = e.account_id join adex.capital_operations o on o.id = e.operation_id where e.operation_id = $1 order by e.leg`,
      [rect['adjustmentOperationId']])).rows;
    assert.deepEqual(legs, [{ kind: 'custody', amt: -10_000, ok: 'DISBURSEMENT_ADJUSTMENT', sale_id: saleId }, { kind: 'portfolio', amt: 10_000, ok: 'DISBURSEMENT_ADJUSTMENT', sale_id: saleId }]);
    const h = (await db.admin.query('select * from adex.credit_rectifications where sale_id = $1', [saleId])).rows;
    assert.equal(h.length, 1);
    assert.deepEqual([h[0].before_state.sale.sale_value_minor, h[0].after_state.sale.sale_value_minor, h[0].before_state.installments.length, h[0].actor_role],
      [140_000, 150_000, 12, 'admin']);
    assert.ok(h[0].reason.length >= 10 && h[0].evidence.length >= 10 && h[0].actor_membership_id === M.anaAdmin);
    assert.equal(await count(db.admin, `select 1 from adex.audit_log where entity_id = $1 and action = 'RECTIFY_CREDIT'`, [saleId]), 1);
    // Historial por la API (Administrador) y vista del trabajador del ajuste de su custodia.
    const list = await ana('GET', `/v1/credits/${saleId}/rectifications`);
    assert.equal((list.body['rectifications'] as Body[]).length, 1);
    const seen = await w.call('GET', '/v1/capital/operations?limit=500');
    assert.ok((seen.body['operations'] as Body[]).some((o) => o['id'] === rect['adjustmentOperationId']), 'el trabajador ve el ajuste de su custodia');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    await ledgerChecks();
  });

  test('R73-SOC09-002 · capital HACIA ABAJO: el efectivo no entregado sigue en la custodia; parcelas reconstruidas', async () => {
    const w = await worker(); await fund(w, 100_000);
    const { credit } = await viaRequest(w, {}, { amountMinor: 50_000 });
    const [cus, port] = [await custody(w.membershipId, r1), await portfolio(r1)];
    const r = await rectify($ana, credit['id'] as string, { amountMinor: 45_000, installmentsCount: 15 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await custody(w.membershipId, r1), cus + 5_000);
    assert.equal(await portfolio(r1), port - 5_000);
    const inst = r.body['installments'] as Body[];
    assert.deepEqual([inst.length, sumOf(inst), (r.body['credit'] as Body)['installmentValueMinor']], [15, 54_000, 3_600]);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    await ledgerChecks();
  });

  test('R73-SOC09-003 · solo interés y parcelas (Δ = 0): ningún movimiento de dinero; redondeo absorbido por la última parcela', async () => {
    const w = await worker(); await fund(w, 40_000);
    const { credit } = await viaRequest(w, {}, { amountMinor: 33_333, installmentsCount: 7 });
    const ops = await count(db.admin, 'select 1 from adex.capital_operations');
    const r = await rectify($ana, credit['id'] as string, { amountMinor: 33_333, interestRate: 10, installmentsCount: 7 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await count(db.admin, 'select 1 from adex.capital_operations'), ops, 'sin asiento');
    const total = calculateTotalWithInterest({ valorVenta: 33_333, tasaInteres: 10 }).valorTotal;
    assert.equal(sumOf(r.body['installments'] as Body[]), total);
    assert.equal((r.body['rectification'] as Body)['adjustmentOperationId'], null);
    assert.deepEqual((await db.admin.query('select delta_minor::int d, adjustment_operation_id a from adex.credit_rectifications where sale_id = $1', [credit['id']])).rows, [{ d: 0, a: null }]);
    assert.equal((await rectify($ana, credit['id'] as string, { amountMinor: 33_333, interestRate: 10, installmentsCount: 7, expectedRectifications: 1 })).body['error'],
      'NOTHING_TO_RECTIFY');
    await ledgerChecks();
  });

  test('R73-SOC09-004 · fondos insuficientes para subir el capital: 409 y nada escrito', async () => {
    const w = await worker(); await fund(w, 50_000);
    const { credit } = await viaRequest(w);
    const snapshot = async () => [await count(db.admin, 'select 1 from adex.capital_operations'), await count(db.admin, 'select 1 from adex.credit_rectifications'),
      (await db.admin.query('select sale_value_minor::int v from adex.sales where id = $1', [credit['id']])).rows[0].v];
    const before = await snapshot();
    assert.deepEqual([(await rectify($ana, credit['id'] as string, { amountMinor: 50_001 })).status, (await rectify($ana, credit['id'] as string, { amountMinor: 50_001 })).body['error']],
      [409, 'INSUFFICIENT_FUNDS']);
    assert.deepEqual(await snapshot(), before);
  });

  test('R73-SOC09-005 · con recaudos: bloqueada (también si el recaudo se anuló)', async () => {
    const w = await worker(); await fund(w, 60_000);
    const { credit } = await viaRequest(w);
    assert.equal((await w.money('/v1/collections', { saleId: credit['id'], amountMinor: 5_000 })).status, 201);
    assert.equal((await rectify($ana, credit['id'] as string, { amountMinor: 45_000 })).body['error'], 'CREDIT_HAS_COLLECTIONS');
  });

  test('R73-SOC09-006 · desembolso incluido en un cuadre: bloqueada', async () => {
    const w = await worker(); await fund(w, 60_000);
    const { credit } = await viaRequest(w);
    const p = (await ana('GET', `/v1/settlements/preview?routeId=${r1}&workerId=${w.membershipId}`)).body;
    const s = await $ana('/v1/settlements', { routeId: r1, workerId: w.membershipId, deliveredMinor: p['expectedPositionMinor'], expectedSeenMinor: p['expectedPositionMinor'],
      previousSettlementId: p['previousSettlementId'] ?? null });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal((await rectify($ana, credit['id'] as string, { amountMinor: 45_000 })).body['error'], 'DISBURSEMENT_SETTLED');
  });

  test('R73-SOC09-007 · permisos: solo el Administrador de la ruta; la bolsa solo la mueve su Administrador; otra empresa no ve el crédito', async () => {
    const w = await worker(); await fund(w, 60_000);
    const { credit } = await viaRequest(w);
    const id = credit['id'] as string;
    assert.equal((await rectify(w.money, id, { amountMinor: 45_000 })).status, 403, 'Cobrador');
    assert.equal((await rectify(money(gabi), id, { amountMinor: 45_000 })).status, 403, 'Secretaria');
    assert.equal((await rectify(dora.money, id, { amountMinor: 45_000 })).status, 403, 'Supervisora');
    assert.equal((await rectify($bruno, id, { amountMinor: 45_000 })).status, 403, 'SuperAdmin (cartera de solo lectura, R67)');
    assert.equal((await rectify(money(hugo), id, { amountMinor: 45_000 })).status, 404, 'otra empresa');
    assert.equal((await hugo('GET', `/v1/credits/${id}/rectifications`)).status, 404);
    // Venta directa pagada con la bolsa de Ana: Xavier (Administrador de la ruta, no dueño de la bolsa) no la rectifica.
    const direct = await $ana('/v1/credits/direct', { routeId: r1, clientId: await newClient('Directa bolsa'), ...cond({ amountMinor: 20_000 }) });
    assert.equal(direct.status, 201, JSON.stringify(direct.body));
    const did = (direct.body['credit'] as Body)['id'] as string;
    assert.equal((await rectify(xavier.money, did, { amountMinor: 25_000 })).body['error'], 'CAPITAL_AUTHORITY_REQUIRED');
    // Xavier SÍ puede rectificar un crédito pagado con custodia de su ruta.
    assert.equal((await rectify(xavier.money, id, { amountMinor: 45_000 })).status, 200);
    // Ana sí, desde su bolsa (hacia arriba).
    const before = await pool(M.anaAdmin);
    assert.equal((await rectify($ana, did, { amountMinor: 25_000 })).status, 200);
    assert.equal(await pool(M.anaAdmin), before - 5_000);
    await ledgerChecks();
  });

  test('R73-SOC09-008 · entradas inválidas: motivo, evidencia, confirmación sin conexión, tasa, inicio antes del desembolso', async () => {
    const w = await worker(); await fund(w, 60_000);
    const { credit } = await viaRequest(w);
    const id = credit['id'] as string;
    const err = async (o: Body) => (await rectify($ana, id, { amountMinor: 45_000, ...o })).body['error'];
    assert.equal(await err({ reason: 'corto' }), 'INVALID_INPUT');
    assert.equal(await err({ evidence: '' }), 'INVALID_INPUT');
    assert.equal(await err({ offlineChecked: false }), 'INVALID_INPUT');
    assert.equal(await err({ interestRate: 15 }), 'INTEREST_RATE_NOT_ALLOWED');
    assert.equal(await err({ startDate: '2026-01-01' }), 'INVALID_CONDITIONS');
    assert.equal(await err({ amountMinor: 0 }), 'INVALID_INPUT');
    assert.equal((await $ana(`/v1/credits/${id}/rectify`, { ...cond(), expectedRectifications: 0, reason: 'x'.repeat(12), evidence: 'y'.repeat(12), offlineChecked: true, extra: 1 })).status, 400);
    assert.equal((await ana('POST', `/v1/credits/${id}/rectify`, { ...cond({ amountMinor: 45_000 }), expectedRectifications: 0, reason: 'x'.repeat(12), evidence: 'y'.repeat(12), offlineChecked: true })).body['error'],
      'OPERATION_ID_REQUIRED');
    assert.equal(await count(db.admin, 'select 1 from adex.credit_rectifications where sale_id = $1', [id]), 0);
  });

  test('R73-SOC09-009 · idempotencia y concurrencia: el mismo id devuelve lo mismo; dos rectificaciones simultáneas, una gana; dato viejo → 409', async () => {
    const w = await worker(); await fund(w, 100_000);
    const { credit } = await viaRequest(w);
    const id = credit['id'] as string;
    const op = randomUUID();
    const a = await rectify($ana, id, { amountMinor: 55_000 }, op);
    const b = await rectify($ana, id, { amountMinor: 55_000 }, op);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(b.body, a.body, 'reintento con el mismo id: mismo resultado, sin segunda rectificación');
    assert.equal(await count(db.admin, 'select 1 from adex.credit_rectifications where sale_id = $1', [id]), 1);
    assert.equal((await rectify($ana, id, { amountMinor: 52_000 })).body['error'], 'CREDIT_CHANGED', 'quien vio 0 rectificaciones llega tarde');
    const res = await parallel(2, (i) => rectify($ana, id, { amountMinor: 56_000 + i * 1_000, expectedRectifications: 1 }));
    assert.deepEqual(res.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await count(db.admin, 'select 1 from adex.credit_rectifications where sale_id = $1', [id]), 2);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    await ledgerChecks();
  });

  test('R73-SOC09-010 · el ajuste no se anula por la vía genérica; el cuadre lo cuenta como desembolso; un recaudo posterior usa el calendario nuevo', async () => {
    const w = await worker(); await fund(w, 100_000);
    const { credit } = await viaRequest(w);
    const id = credit['id'] as string;
    const r = await rectify($ana, id, { amountMinor: 60_000 });
    const adj = (r.body['rectification'] as Body)['adjustmentOperationId'] as string;
    assert.equal((await $ana(`/v1/capital/operations/${adj}/reverse`, { reason: 'Intento de anulación' })).body['error'], 'REVERSAL_NOT_ALLOWED');
    const p = (await ana('GET', `/v1/settlements/preview?routeId=${r1}&workerId=${w.membershipId}`)).body;
    assert.equal((p['cycle'] as Body)['disbursedMinor'], 60_000, 'el cuadre ve 60.000 desembolsados (50.000 + ajuste)');
    assert.equal((p['cycle'] as Body)['otherMinor'], 0, 'y no como «otros»');
    assert.equal(p['expectedPositionMinor'], 40_000);
    const pay = await w.money('/v1/collections', { saleId: id, amountMinor: 6_000 });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    const s = (await db.admin.query('select balance_minor::int b, total_value_minor::int t from adex.sales where id = $1', [id])).rows[0];
    assert.deepEqual([s.t, s.b], [72_000, 66_000]);
    assert.equal((await rectify($ana, id, { amountMinor: 50_000, expectedRectifications: 1 })).body['error'], 'CREDIT_HAS_COLLECTIONS', 'y ya no se rectifica');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    await ledgerChecks();
  });

  // [MODIFICADO D73-02] Antes la reducción se bloqueaba (INSTALLMENTS_REDUCTION_BLOCKED); el propietario la aprobó.
  test('R73-SOC09-012 · D73-02: reducir 12 → 10 parcelas: las sobrantes quedan «sustituidas» (sin borrar, sin deuda)', async () => {
    const w = await worker(); await fund(w, 60_000);
    const { credit } = await viaRequest(w);
    const r = await rectify($ana, credit['id'] as string, { installmentsCount: 10 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((r.body['installments'] as Body[]).length, 10, 'el calendario vigente tiene 10');
    assert.deepEqual((await db.admin.query(`select count(*)::int n, count(*) filter (where status = 'sustituida')::int s from adex.installments where sale_id = $1`, [credit['id']])).rows,
      [{ n: 12, s: 2 }], 'ninguna cuota se borró');
    await ledgerChecks();
  });

  test('R73-SOC09-011 · trabajador que ya no custodia en la ruta: bloqueada (excepción de conciliación pendiente de decisión)', async () => {
    const w = await worker(); await fund(w, 60_000);
    const { credit } = await viaRequest(w);
    assert.equal((await bruno('PUT', `/v1/members/${w.membershipId}/routes`, { routeIds: [] })).status, 200);
    assert.equal((await rectify($ana, credit['id'] as string, { amountMinor: 45_000 })).body['error'], 'CUSTODIAN_CHANGED');
  });
});
