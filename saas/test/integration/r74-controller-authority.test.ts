// R74 · REGLA DEFINITIVA del propietario (migración 0037): la autoridad financiera máxima de una ruta es su
// Administrador responsable de capital (UNO por ruta). En SUS rutas corrige y anula, también lo que él registró,
// sin aprobación de nadie; los demás Administradores con acceso operativo conservan solo sus permisos operativos.
//   · autocorrección: gasto de ruta y de trabajador, cobro y operaciones de capital registrados por él mismo;
//   · otro Administrador con alcance operativo: autoriza ventas, pero no inyecta, no anula, no concilia;
//   · dependencias con camino: gasto con dinero propio ya reembolsado (anulación en cadena) y periodo cerrado
//     (reapertura explícita); operación conjunta con responsables distintos (anulación coordinada: proponer,
//     confirmar, cancelar; asiento atómico; idempotencia; concurrencia);
//   · reembolso de la obligación concreta de OTRO Administrador (route_base y admin_pool);
//   · aislamiento RLS (empresa, ruta, persona).
// Dos empresas (c1 route_base, c2 admin_pool). Datos sintéticos, PostgreSQL local.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf, routeId } from '../../db/seeds/synthetic.ts';
import { asApi, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, parallel, type Caller } from '../helpers/phase2.ts';
import { balance, money, newPerson, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('R74 · autoridad del responsable de capital de la ruta (0037)', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const c2 = companyId('c2');
  const [r1, r2, r3] = [routeId('c1', 1), routeId('c1', 2), routeId('c1', 3)];
  let bruno: Caller, $bruno: Money, ana: Caller, $ana: Money, carla: Caller, $carla: Money, hugo: Caller, $hugo: Money;
  let carlos: Person, edu: Person, fede: Person, gael: Person, iris: Person;
  let today = '', cat = '', catC2 = '';
  let jointExpense = '', jointReimb = '';

  const base = (r: string) => balance(db.admin, c1, 'route_base', null, r);
  const custody = (m: string, r: string = r1) => balance(db.admin, c1, 'custody', m, r);
  const payable = (m: string, company = c1) => balance(db.admin, company, 'admin_payable', m);
  const pool = (m: string, company = c2) => balance(db.admin, company, 'admin', m);
  const count = async (sql: string, p: unknown[] = [c1]) => Number((await db.admin.query(sql, p)).rows[0].n);
  const opCount = () => count('select count(*) n from adex.capital_operations where company_id = $1');
  const expectCode = (r: { status: number; body: Body }, status: number, code: string, label: string) =>
    assert.deepEqual([r.status, r.body['error'] ?? r.body['code']], [status, code], `${label}: ${JSON.stringify(r.body)}`);
  const deps = (r: { body: Body }) => (((r.body['details'] as Body | undefined)?.['dependencies'] ?? []) as Body[]);
  const pg = (who: { identityId: string; membershipId: string }, company: string, sql: string, params: unknown[]) =>
    asApi(db.api, { ...who, companyId: company }, async (q) => q.query(sql, params).then((r) => r.rows, (e: { code?: string }) => e.code));
  const anaCtx = { identityId: identityOf('ana'), membershipId: M.anaAdmin };
  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const newClient = async (who: Caller, route: string) => {
    const r = await who('POST', '/v1/clients', { routeId: route, name: `CLIENTE CA ${randomUUID().slice(0, 6)}`, documentType: 'CPF', document: cpf(),
      phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body['id'] as string;
  };
  const cond = (o: Body = {}) => ({ amountMinor: 20_000, interestRate: 20, installmentsCount: 10, frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6], ...o });
  const general = (who: Money, body: Body, opId?: string) => who('/v1/expenses', { categoryId: cat, description: 'Gasto general sintético', ...body }, opId);
  const ledgerOk = async () => {
    const r = await bruno('GET', '/v1/capital/reconciliation');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((r.body['checks'] as Body[]).filter((c) => !c['ok']), [], 'conciliación limpia');
  };
  const items = async (who: Caller) => {
    const r = await who('GET', '/v1/capital/admin-payables/items');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body['items'] as Body[];
  };

  before(async () => {
    db = await createTestDb('r74_controller_authority', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    carla = caller(api, issuer, 'carla', M.carlaSa); $carla = money(carla);
    hugo = caller(api, issuer, 'hugo', M.hugoAdmin); $hugo = money(hugo);
    today = (await db.admin.query(`select adex.business_today($1)::text d`, [c1])).rows[0].d;
    cat = (await db.admin.query(`select id from adex.expense_categories where company_id = $1 and active order by id limit 1`, [c1])).rows[0].id;
    catC2 = (await db.admin.query(`select id from adex.expense_categories where company_id = $1 and active order by id limit 1`, [c2])).rows[0].id;
    carlos = await newPerson(api, issuer, provider.ids, bruno, { email: 'carlos-ca@example.test', role: 'cobrador', displayName: 'Carlos', routeIds: [r1] });
    edu = await newPerson(api, issuer, provider.ids, bruno, { email: 'edu-ca@example.test', role: 'admin', displayName: 'Edu', routeIds: [r3] });
    // Fede: Administrador con ALCANCE OPERATIVO en r1 (membership_routes), sin ser su responsable de capital.
    fede = await newPerson(api, issuer, provider.ids, bruno, { email: 'fede-ca@example.test', role: 'admin', displayName: 'Fede', routeIds: [r1] });
    gael = await newPerson(api, issuer, provider.ids, bruno, { email: 'gael-ca@example.test', role: 'admin', displayName: 'Gael', routeIds: [r2] });
    iris = await newPerson(api, issuer, provider.ids, carla, { email: 'iris-ca@example.test', role: 'admin', displayName: 'Iris', routeIds: [] });
    const of2 = (await db.admin.query(`select id from adex.offices where company_id = $1 and code = 'OF-2'`, [c1])).rows[0].id as string;
    assert.equal((await bruno('POST', `/v1/offices/${of2}/status`, { status: 'activa' })).status, 200);
    assert.equal((await bruno('POST', `/v1/routes/${r3}/status`, { status: 'activa' })).status, 200);
    const ctrl = async (r: string) => (await db.admin.query('select capital_controller_membership_id c from adex.routes where id = $1', [r])).rows[0].c;
    for (const [r, m] of [[r1, M.anaAdmin], [r2, M.anaAdmin], [r3, edu.membershipId]] as const) {
      if ((await ctrl(r)) !== m) assert.equal((await bruno('PUT', `/v1/routes/${r}/capital-controller`, { membershipId: m, reason: 'Responsable inicial' })).status, 200);
    }
    const company = await balance(db.admin, c1, 'company', null);
    if (company > 0) assert.equal((await $bruno('/v1/capital/company/withdrawals', { amountMinor: company, reason: 'Disponible a cero antes del corte' })).status, 201);
    const act = await $bruno('/v1/capital/model', { target: 'route_base', evidence: 'Corte autorizado para la prueba local del responsable', backupReference: 'backup-local-ca' });
    assert.equal(act.status, 200, JSON.stringify(act.body));
    for (const [who, r, amt] of [[$ana, r1, 300_000], [$ana, r2, 120_000], [edu.money, r3, 90_000]] as const) {
      const inj = await who('/v1/capital/route-base/injections', { routeId: r, amountMinor: amt, reason: 'Base inicial sintética' });
      assert.equal(inj.status, 201, JSON.stringify(inj.body));
    }
    // c2 (admin_pool): bolsa de Hugo.
    assert.equal((await $carla('/v1/capital/company/deposits', { amountMinor: 1_000_000, reason: 'Capital c2' })).status, 201);
    assert.equal((await $carla('/v1/capital/allocations', { adminId: M.hugoAdmin, amountMinor: 300_000, reason: 'Bolsa de Hugo' })).status, 201);
  });
  after(async () => { await api?.close(); await db?.close(); });

  test('CA-001 · esquema 0037: tablas, funciones, AX717 acotado a la propia custodia', async () => {
    const fns = ['joint_reversal_propose', 'joint_reversal_confirm', 'joint_reversal_cancel', 'joint_reversal_list', 'admin_payable_items',
      'admin_reimbursement_pay', 'expense_reversal_dependencies', 'joint_posting_ok'];
    assert.equal(await count(`select count(*) n from pg_proc where proname = any($1)`, [fns]), fns.length);
    assert.equal(await count(`select count(*) n from pg_class where relname in ('joint_reversal_proposals', 'joint_reversal_parts', 'joint_reversal_events')`, []), 3);
    const body = (await db.admin.query(`select pg_get_functiondef('adex.expense_correctable(adex.money_ctx,text,boolean)'::regprocedure) d`)).rows[0].d as string;
    assert.ok(!body.includes('e.registered_by_membership_id'), 'ya no compara con quien registró');
    assert.ok(body.includes('e.collector_membership_id') && body.includes('AX717'), 'solo la propia custodia');
    await assert.rejects(db.admin.query('truncate adex.joint_reversal_events'), /./);
  });

  test('CA-002 · autocorrección: la responsable anula el gasto de ruta y el de trabajador que ELLA registró (API y SQL)', async () => {
    const b1 = await base(r1);
    const e = await $ana('/v1/expenses', { scope: 'ruta', routeId: r1, categoryId: cat, amountMinor: 2_500, description: 'Gasto de ruta propio' });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    const eid = (e.body['expense'] as Body)['id'] as string;
    assert.equal(await base(r1), b1 - 2_500);
    const pv = await ana('GET', `/v1/corrections/preview?kind=expense&id=${eid}`);
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    assert.equal(pv.body['mode'], 'direct');
    assert.ok((pv.body['effects'] as Body[]).some((x) => (x['account'] as Body)['kind'] === 'route_base' && x['deltaMinor'] === 2_500), JSON.stringify(pv.body));
    const rv = await $ana(`/v1/expenses/${eid}/reverse`, { reason: 'Lo registré dos veces' });
    assert.equal(rv.status, 201, JSON.stringify(rv.body));
    assert.equal(await base(r1), b1, 'el dinero vuelve a la Base');
    const audit = (await db.admin.query(`select metadata->>'selfCorrection' s from adex.audit_log where action = 'MOVEMENT_REVERSED' and entity_id = $1`, [eid])).rows;
    assert.deepEqual(audit, [{ s: 'true' }], 'auditado (sin revisión obligatoria)');
    // Gasto de trabajador cargado por ella a Carlos (registró Ana): lo anula ella; vuelve a la custodia de Carlos.
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 20_000, reason: 'Base de Carlos' })).status, 201);
    const c0 = await custody(carlos.membershipId);
    const w = await $ana('/v1/expenses', { scope: 'trabajador', routeId: r1, workerId: carlos.membershipId, categoryId: cat, amountMinor: 1_200, description: 'Cargado por Ana' });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    const wr = await $ana(`/v1/expenses/${(w.body['expense'] as Body)['id']}/reverse`, { reason: 'Cargado por error' });
    assert.equal(wr.status, 201, JSON.stringify(wr.body));
    assert.equal(await custody(carlos.membershipId), c0);
    // Segunda barrera: por SQL directo, también (sin AX717).
    const e3 = await $ana('/v1/expenses', { scope: 'ruta', routeId: r1, categoryId: cat, amountMinor: 700, description: 'Otro propio' });
    const rows = await pg(anaCtx, c1, 'select adex.expense_reverse($1, $2, $3) r', [randomUUID(), (e3.body['expense'] as Body)['id'], 'Por SQL directo']);
    assert.ok(Array.isArray(rows), `SQL directo: ${String(rows)}`);
    await ledgerOk();
  });

  test('CA-003 · autocorrección: la responsable anula el cobro que ELLA registró', async () => {
    const s = await $ana('/v1/credits/direct', { routeId: r2, clientId: await newClient(ana, r2), ...cond() });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const saleId = (s.body['credit'] as Body)['id'] as string;
    const b2 = await base(r2);
    const p = await $ana('/v1/collections', { saleId, amountMinor: 3_000 });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const pid = (p.body['paymentId'] as string | undefined) ?? ((p.body['payment'] as Body)['id'] as string);
    assert.equal(await base(r2), b2 + 3_000);
    const rv = await $ana(`/v1/collections/${pid}/reverse`, { reason: 'Cobro registrado por error' });
    assert.equal(rv.status, 201, JSON.stringify(rv.body));
    assert.equal(await base(r2), b2);
  });

  test('CA-004 · autocorrección de capital: inyección, retiro, entrega y transferencia entre SUS rutas', async () => {
    const [b1, b2] = [await base(r1), await base(r2)];
    const rev = (opId: string, reason = 'Registrado por error') => $ana(`/v1/capital/operations/${opId}/reverse`, { reason });
    const opOf = (r: { body: Body }) => (r.body['operation'] as Body)['id'] as string;
    const inj = await $ana('/v1/capital/route-base/injections', { routeId: r1, amountMinor: 5_000, reason: 'Inyección equivocada' });
    assert.equal((await rev(opOf(inj))).status, 201);
    const wd = await $ana('/v1/capital/route-base/withdrawals', { routeId: r1, amountMinor: 4_000, reason: 'Retiro equivocado' });
    const wr = await rev(opOf(wd));
    assert.equal(wr.status, 201, JSON.stringify(wr.body));
    const dl = await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 3_000, reason: 'Entrega equivocada' });
    assert.equal((await rev(opOf(dl))).status, 201);
    const tr = await $ana('/v1/capital/route-base/transfers', { fromRouteId: r1, toRouteId: r2, amountMinor: 6_000, reason: 'Transferencia equivocada' });
    assert.equal(tr.status, 201, JSON.stringify(tr.body));
    assert.deepEqual([await base(r1), await base(r2)], [b1 - 6_000, b2 + 6_000]);
    const tv = await rev(opOf(tr));
    assert.equal(tv.status, 201, JSON.stringify(tv.body));
    assert.deepEqual([await base(r1), await base(r2)], [b1, b2], 'todo vuelve a su sitio');
    expectCode(await rev(opOf(tr), 'Otra vez'), 409, 'ALREADY_REVERSED', 'una sola vez');
    await ledgerOk();
  });

  test('CA-005 · otro Administrador con alcance operativo: autoriza ventas; no inyecta, no anula, no concilia (API y SQL)', async () => {
    const fedeCtx = { identityId: fede.identityId, membershipId: fede.membershipId };
    // Permiso operativo conservado: autoriza la solicitud de venta de un Cobrador de r1.
    const req = await carlos.money('/v1/credit-requests', { routeId: r1, clientId: await newClient(carlos.call, r1), ...cond({ amountMinor: 5_000 }) });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    const ap = await fede.call('POST', `/v1/credit-requests/${req.body['id']}/approve`, {});
    assert.equal(ap.status, 200, `Fede autoriza la venta: ${JSON.stringify(ap.body)}`);
    // Sin autoridad de capital.
    const before = await opCount();
    expectCode(await fede.money('/v1/capital/route-base/injections', { routeId: r1, amountMinor: 1_000, reason: 'No soy el responsable' }), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'inyectar');
    expectCode(await fede.money('/v1/capital/route-base/withdrawals', { routeId: r1, amountMinor: 1_000, reason: 'No soy el responsable' }), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'retirar');
    const e = await $ana('/v1/expenses', { scope: 'ruta', routeId: r1, categoryId: cat, amountMinor: 900, description: 'Gasto que Fede no anula' });
    const eid = (e.body['expense'] as Body)['id'] as string;
    expectCode(await fede.money(`/v1/expenses/${eid}/reverse`, { reason: 'No soy el responsable' }), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'anular gasto');
    const inj = await $ana('/v1/capital/route-base/injections', { routeId: r1, amountMinor: 1_500, reason: 'Inyección de Ana' });
    const injId = (inj.body['operation'] as Body)['id'] as string;
    expectCode(await fede.money(`/v1/capital/operations/${injId}/reverse`, { reason: 'No soy el responsable' }), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'anular inyección');
    const pv = await fede.call('GET', `/v1/corrections/preview?kind=expense&id=${eid}`);
    assert.equal(pv.body['mode'], 'blocked', JSON.stringify(pv.body));
    // Conciliar: una diferencia de cuadre de Carlos en r1; Fede no la concilia.
    const p = (await ana('GET', `/v1/settlements/preview?routeId=${r1}&workerId=${carlos.membershipId}`)).body;
    const expected = Number(p['expectedPositionMinor']);
    const s = await $ana('/v1/settlements', { routeId: r1, workerId: carlos.membershipId, deliveredMinor: expected - 100, expectedSeenMinor: expected,
      previousSettlementId: p['previousSettlementId'] ?? null, reason: 'Faltan 100 en el conteo' });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const sid = (s.body['settlement'] as Body)['id'];
    expectCode(await fede.money('/v1/capital/differences/resolve', { sourceKind: 'settlement_shortage', sourceId: sid, resolution: 'route_shortage', amountMinor: 100,
      reason: 'No soy el responsable de r1' }), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'conciliar');
    // Segunda barrera en PostgreSQL.
    assert.equal(await pg(fedeCtx, c1, `select adex.route_base_post($1, 'ROUTE_BASE_INJECTION', 1000, 'Por SQL directo', $2)`, [randomUUID(), r1]), 'AX402');
    assert.equal(await pg(fedeCtx, c1, 'select adex.expense_reverse($1, $2, $3)', [randomUUID(), eid, 'Por SQL directo']), 'AX402');
    assert.equal(await pg(fedeCtx, c1, `select adex.route_base_post($1, 'REVERSAL', null, 'Por SQL directo', $2, null, $3)`, [randomUUID(), r1, injId]), 'AX402');
    assert.equal(await opCount(), before + 3, 'solo lo de Ana (gasto, inyección, cuadre) se escribió');
    // La responsable sí concilia.
    assert.equal((await $ana('/v1/capital/differences/resolve', { sourceKind: 'settlement_shortage', sourceId: sid, resolution: 'route_shortage', amountMinor: 100,
      reason: 'Faltante pequeño asumido por la ruta' })).status, 201);
  });

  test('CA-006 · dependencia: gasto con dinero propio ya reembolsado → anular reembolso y gasto en UNA transacción (idempotente)', async () => {
    const e = await general($ana, { scope: 'administrador', fundingSource: 'own_money', amountMinor: 10_000, description: 'Equipo pagado por Ana' });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    const eid = (e.body['expense'] as Body)['id'] as string;
    const p0 = await payable(M.anaAdmin);
    const b1 = await base(r1);
    const reimb = await $ana('/v1/capital/reimbursements', { adminId: M.anaAdmin, expenseId: eid, contributions: [{ routeId: r1, amountMinor: 4_000 }], reason: 'Autorreembolso parcial' });
    assert.equal(reimb.status, 201, JSON.stringify(reimb.body));
    assert.deepEqual([reimb.body['expenseId'], reimb.body['obligationPendingAfterMinor']], [eid, 6_000]);
    // Sin cascada: 409 con la dependencia y el camino.
    const r = await $ana(`/v1/expenses/${eid}/reverse`, { reason: 'Equipo devuelto al proveedor' });
    expectCode(r, 409, 'PAYABLE_ALREADY_REIMBURSED', 'gasto reembolsado');
    assert.deepEqual(deps(r).map((d) => [d['kind'], d['action'], d['amountMinor'], d['linked']]), [['reimbursement', 'reverse_reimbursement', 4_000, true]]);
    assert.equal((r.body['details'] as Body)['cascadeAvailable'], true);
    const pv = await ana('GET', `/v1/corrections/preview?kind=expense&id=${eid}`);
    assert.equal(pv.body['mode'], 'cascade', JSON.stringify(pv.body));
    assert.ok((pv.body['effects'] as Body[]).some((x) => (x['account'] as Body)['kind'] === 'route_base' && x['deltaMinor'] === 4_000), 'el aporte vuelve a r1');
    // Con cascada: una transacción; reintento con el mismo id → misma respuesta, nada se duplica.
    const op = randomUUID();
    const ok = await $ana(`/v1/expenses/${eid}/reverse`, { reason: 'Equipo devuelto al proveedor', cascade: true }, op);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal((ok.body['cascadedReimbursements'] as Body[]).length, 1);
    const again = await $ana(`/v1/expenses/${eid}/reverse`, { reason: 'Equipo devuelto al proveedor', cascade: true }, op);
    assert.deepEqual(again.body, ok.body, 'idempotente');
    assert.equal(await base(r1), b1, 'el reembolso volvió a r1');
    assert.equal(await payable(M.anaAdmin), p0 + 10_000, 'la obligación desaparece');
    assert.equal(await count(`select count(*) n from adex.admin_reimbursements where company_id = $1 and expense_id = $2 and reversed_at is not null`, [c1, eid]), 1);
    await ledgerOk();
  });

  test('CA-007 · reembolso a OTRO Administrador eligiendo la obligación: reduce exactamente esa; sin ver sus rutas; topes e idempotencia', async () => {
    const mk = async (amount: number, d: string) => ((await general($ana, { scope: 'administrador', fundingSource: 'own_money', amountMinor: amount, description: d })).body['expense'] as Body)['id'] as string;
    const eA = await mk(8_000, 'Moto: repuesto');
    const eB = await mk(5_000, 'Celular de cobro');
    const list = await items(edu.call);
    const a = list.find((x) => x['expenseId'] === eA)!;
    const b = list.find((x) => x['expenseId'] === eB)!;
    assert.deepEqual([a['adminId'], a['description'], a['pendingMinor'], a['isMine']], [M.anaAdmin, 'Moto: repuesto', 8_000, false]);
    assert.ok(!Object.keys(a).some((k) => /route/i.test(k)), 'sin rutas del beneficiario');
    const [b3, pA] = [await base(r3), await payable(M.anaAdmin)];
    // Una ruta fuera de su alcance ni siquiera existe para él (404); nunca paga con dinero ajeno.
    expectCode(await edu.money('/v1/capital/reimbursements', { adminId: M.anaAdmin, expenseId: eB, contributions: [{ routeId: r1, amountMinor: 1_000 }], reason: 'Desde ruta ajena' }),
      404, 'NOT_FOUND', 'ruta de otro responsable');
    expectCode(await edu.money('/v1/capital/reimbursements', { adminId: M.anaAdmin, expenseId: eB, contributions: [{ routeId: r3, amountMinor: 5_001 }], reason: 'Más que la obligación' }),
      409, 'REIMBURSEMENT_EXCEEDS_PENDING', 'más que esa obligación');
    const op = randomUUID();
    const pay = await edu.money('/v1/capital/reimbursements', { adminId: M.anaAdmin, expenseId: eB, contributions: [{ routeId: r3, amountMinor: 3_000 }], reason: 'Edu paga el celular de Ana' }, op);
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    assert.deepEqual((await edu.money('/v1/capital/reimbursements', { adminId: M.anaAdmin, expenseId: eB, contributions: [{ routeId: r3, amountMinor: 3_000 }], reason: 'Edu paga el celular de Ana' }, op)).body,
      pay.body, 'idempotente');
    assert.deepEqual([await base(r3), await payable(M.anaAdmin)], [b3 - 3_000, pA + 3_000]);
    const after = await items(ana);
    assert.equal(after.find((x) => x['expenseId'] === eB)!['pendingMinor'], 2_000, 'esa obligación baja exactamente');
    assert.equal(after.find((x) => x['expenseId'] === eA)!['pendingMinor'], 8_000, 'la otra no cambia');
    assert.equal(b['pendingMinor'], 5_000);
    // Ana no anula ese gasto mientras el reembolso de Edu esté vigente: el camino es pedírselo a Edu (no puede anularlo ella).
    const r = await $ana(`/v1/expenses/${eB}/reverse`, { reason: 'Celular devuelto', cascade: true });
    expectCode(r, 409, 'PAYABLE_ALREADY_REIMBURSED', 'reembolsado por otro');
    assert.deepEqual(deps(r).map((d) => [d['action'], d['payerId']]), [['ask_controller', edu.membershipId]]);
    assert.equal((r.body['details'] as Body)['cascadeAvailable'], false);
    // Edu anula SU reembolso (vuelve a r3) y entonces Ana anula el gasto.
    const rid = (pay.body['reimbursement'] as Body)['id'];
    assert.equal((await edu.money(`/v1/capital/reimbursements/${rid}/reverse`, { reason: 'Se pagó la obligación equivocada' })).status, 201);
    assert.equal((await $ana(`/v1/expenses/${eB}/reverse`, { reason: 'Celular devuelto' })).status, 201);
    assert.equal(await base(r3), b3);
    await ledgerOk();
  });

  test('CA-008 · admin_pool (c2): reembolso de la obligación de OTRO Administrador desde la bolsa propia', async () => {
    const e = await iris.money('/v1/expenses', { scope: 'administrador', fundingSource: 'own_money', categoryId: catC2, amountMinor: 7_000, description: 'Papelería de Iris' });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    const eid = (e.body['expense'] as Body)['id'] as string;
    const it = (await items(hugo)).find((x) => x['expenseId'] === eid)!;
    assert.deepEqual([it['adminId'], it['pendingMinor']], [iris.membershipId, 7_000]);
    const p0 = await pool(M.hugoAdmin);
    const pay = await $hugo('/v1/capital/reimbursements', { adminId: iris.membershipId, expenseId: eid, amountMinor: 2_500, reason: 'Hugo paga a Iris desde su bolsa' });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    assert.deepEqual([await pool(M.hugoAdmin), await payable(iris.membershipId, c2), pay.body['obligationPendingAfterMinor']], [p0 - 2_500, -4_500, 4_500]);
  });

  test('CA-009 · operación conjunta con responsables distintos: proponer, confirmar (asiento atómico), idempotencia y aislamiento', async () => {
    // Antes del cambio de responsable: un gasto general con aportes de r1 y r2, y un reembolso pagado con r1 y r2.
    const g = await general($ana, { scope: 'administrador', fundingSource: 'routes', amountMinor: 9_000,
      contributions: [{ routeId: r1, amountMinor: 5_000 }, { routeId: r2, amountMinor: 4_000 }], description: 'Gasto conjunto r1 + r2' });
    assert.equal(g.status, 201, JSON.stringify(g.body));
    jointExpense = (g.body['expense'] as Body)['id'] as string;
    const own = await general($ana, { scope: 'administrador', fundingSource: 'own_money', amountMinor: 6_000, description: 'Viáticos de Ana' });
    const rb = await $ana('/v1/capital/reimbursements', { adminId: M.anaAdmin, expenseId: (own.body['expense'] as Body)['id'],
      contributions: [{ routeId: r1, amountMinor: 2_000 }, { routeId: r2, amountMinor: 1_000 }], reason: 'Autorreembolso desde dos rutas' });
    assert.equal(rb.status, 201, JSON.stringify(rb.body));
    jointReimb = (rb.body['reimbursement'] as Body)['id'] as string;
    // r2 pasa a Gael (entrega con conteo).
    assert.equal((await bruno('PUT', `/v1/routes/${r2}/capital-controller`, { membershipId: gael.membershipId, reason: 'Reorganización de rutas' })).status, 200);
    const b2h = await base(r2);
    assert.equal((await gael.money(`/v1/capital/handovers/${r2}/confirm`, { countedMinor: b2h, expectedSeenMinor: b2h })).status, 200);
    const [b1, b2] = [await base(r1), await base(r2)];
    // Anular directamente: 409 con el camino «proponer».
    const direct = await $ana(`/v1/expenses/${jointExpense}/reverse`, { reason: 'Gasto conjunto equivocado' });
    expectCode(direct, 409, 'JOINT_OPERATION_MIXED_CONTROLLERS', 'directa');
    assert.equal(deps(direct)[0]!['action'], 'propose_joint_reversal');
    // Quien no controla ninguna ruta afectada no propone (Edu) y Fede tampoco (alcance operativo, sin capital).
    expectCode(await edu.money('/v1/capital/joint-reversals', { targetKind: 'expense', targetId: jointExpense, reason: 'No es mío' }), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'Edu propone');
    expectCode(await fede.money('/v1/capital/joint-reversals', { targetKind: 'expense', targetId: jointExpense, reason: 'No es mío' }), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'Fede propone');
    // Ana propone (su parte queda confirmada); idempotente.
    const op = randomUUID();
    const pr = await $ana('/v1/capital/joint-reversals', { targetKind: 'expense', targetId: jointExpense, reason: 'Gasto conjunto equivocado' }, op);
    assert.equal(pr.status, 201, JSON.stringify(pr.body));
    const proposal = pr.body['proposal'] as Body;
    assert.deepEqual((proposal['parts'] as Body[]).map((p) => [p['routeId'], p['confirmed']]).sort(), [[r1, true], [r2, false]].sort());
    assert.deepEqual((await $ana('/v1/capital/joint-reversals', { targetKind: 'expense', targetId: jointExpense, reason: 'Gasto conjunto equivocado' }, op)).body, pr.body, 'idempotente');
    assert.equal(await pg(anaCtx, c1, 'select adex.joint_reversal_propose($1, $2, $3, $4)', [op, 'expense', jointExpense, 'Repetido por SQL']), 'AX409');
    expectCode(await gael.money('/v1/capital/joint-reversals', { targetKind: 'expense', targetId: jointExpense, reason: 'Otra propuesta' }), 409, 'JOINT_REVERSAL_PENDING_EXISTS', 'una pendiente');
    assert.deepEqual([await base(r1), await base(r2)], [b1, b2], 'nada se asentó todavía');
    // Aviso y pendiente para Gael; invisible para Edu y para otra empresa.
    const n = await gael.call('GET', '/v1/notifications');
    assert.ok((n.body['actionRequired'] as Body[]).some((x) => x['type'] === 'joint-reversal-confirmation'), JSON.stringify(n.body));
    assert.ok(Number((await gael.call('GET', '/v1/notifications/count')).body['actionRequired']) >= 1);
    assert.equal((await edu.call('GET', `/v1/capital/joint-reversals/${proposal['id']}`)).status, 404);
    assert.deepEqual(((await edu.call('GET', '/v1/capital/joint-reversals')).body['proposals'] as Body[]), []);
    assert.equal((await hugo('GET', `/v1/capital/joint-reversals/${proposal['id']}`)).status, 404);
    expectCode(await edu.money(`/v1/capital/joint-reversals/${proposal['id']}/confirm`, {}), 404, 'NOT_FOUND', 'Edu confirma');
    expectCode(await $ana(`/v1/capital/joint-reversals/${proposal['id']}/confirm`, {}), 409, 'DECISION_ALREADY_REGISTERED', 'Ana ya confirmó');
    // Gael confirma su parte → la anulación COMPLETA se asienta en esa transacción.
    const cf = await gael.money(`/v1/capital/joint-reversals/${proposal['id']}/confirm`, {});
    assert.equal(cf.status, 200, JSON.stringify(cf.body));
    assert.equal((cf.body['proposal'] as Body)['status'], 'posted');
    assert.deepEqual([await base(r1), await base(r2)], [b1 + 5_000, b2 + 4_000], 'cada aporte vuelve a su Base');
    assert.equal((await db.admin.query('select reversal_id is not null r from adex.expenses where id = $1', [jointExpense])).rows[0].r, true);
    const revOps = (await db.admin.query(`select route_id, admin_membership_id from adex.capital_operations where company_id = $1 and reverses_kind = 'GENERAL_EXPENSE_CONTRIBUTION'
                                            and expense_id = (select reversal_id from adex.expenses where id = $2) order by route_id`, [c1, jointExpense])).rows;
    assert.deepEqual(revOps.map((x) => [x.route_id, x.admin_membership_id]).sort(), [[r1, M.anaAdmin], [r2, gael.membershipId]].sort(), 'cada responsable firma su parte');
    expectCode(await gael.money(`/v1/capital/joint-reversals/${proposal['id']}/confirm`, {}), 409, 'JOINT_REVERSAL_NOT_PENDING', 'ya asentada');
    await ledgerOk();
  });

  test('CA-010 · conjunta: cancelar (solo quien propone); dos confirmaciones simultáneas → un solo asiento; transferencia entre responsables', async () => {
    const pr = await $ana('/v1/capital/joint-reversals', { targetKind: 'reimbursement', targetId: jointReimb, reason: 'Reembolso desde dos rutas por error' });
    assert.equal(pr.status, 201, JSON.stringify(pr.body));
    const id = (pr.body['proposal'] as Body)['id'];
    expectCode(await gael.money(`/v1/capital/joint-reversals/${id}/cancel`, { reason: 'No la propuse yo' }), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'cancela otro');
    const cn = await $ana(`/v1/capital/joint-reversals/${id}/cancel`, { reason: 'Me equivoqué de reembolso' });
    assert.equal(cn.status, 200, JSON.stringify(cn.body));
    assert.equal((cn.body['proposal'] as Body)['status'], 'cancelled');
    expectCode(await gael.money(`/v1/capital/joint-reversals/${id}/confirm`, {}), 409, 'JOINT_REVERSAL_NOT_PENDING', 'confirmar una cancelada');
    // Nueva propuesta y DOS confirmaciones simultáneas de Gael (ids distintos): una asienta, la otra se rechaza.
    const [b1, b2, pA] = [await base(r1), await base(r2), await payable(M.anaAdmin)];
    const ops0 = await opCount();
    const p2 = await $ana('/v1/capital/joint-reversals', { targetKind: 'reimbursement', targetId: jointReimb, reason: 'Reembolso desde dos rutas por error' });
    const id2 = (p2.body['proposal'] as Body)['id'];
    const res = await parallel(2, () => gael.money(`/v1/capital/joint-reversals/${id2}/confirm`, {}));
    assert.deepEqual(res.map((r) => r.status).sort(), [200, 409], JSON.stringify(res.map((r) => r.body)));
    assert.deepEqual([await base(r1), await base(r2), await payable(M.anaAdmin)], [b1 + 2_000, b2 + 1_000, pA - 3_000], 'una sola vez');
    assert.equal(await opCount(), ops0 + 2, 'dos patas de anulación (una por ruta), nada duplicado');
    // Confirmar y cancelar a la vez: exactamente un efecto.
    const tr = await $ana('/v1/capital/route-base/transfers', { fromRouteId: r1, toRouteId: r3, amountMinor: 15_000, reason: 'Préstamo de caja a r3' });
    assert.equal(tr.status, 201, JSON.stringify(tr.body));
    const trId = (tr.body['operation'] as Body)['id'] as string;
    expectCode(await $ana(`/v1/capital/operations/${trId}/reverse`, { reason: 'Transferencia equivocada' }), 409, 'JOINT_OPERATION_MIXED_CONTROLLERS', 'transferencia directa');
    assert.equal(await pg(anaCtx, c1, `select adex.route_base_post($1, 'REVERSAL', null, 'Por SQL directo', $2, null, $3)`, [randomUUID(), r1, trId]), 'AX434');
    const [t1, t3] = [await base(r1), await base(r3)];
    const p3 = await $ana('/v1/capital/joint-reversals', { targetKind: 'route_transfer', targetId: trId, reason: 'Transferencia equivocada' });
    assert.equal(p3.status, 201, JSON.stringify(p3.body));
    const id3 = (p3.body['proposal'] as Body)['id'];
    const race = await Promise.all([edu.money(`/v1/capital/joint-reversals/${id3}/confirm`, {}), $ana(`/v1/capital/joint-reversals/${id3}/cancel`, { reason: 'Cancelo a la vez' })]);
    const final = ((await ana('GET', `/v1/capital/joint-reversals/${id3}`)).body['proposal'] as Body)['status'];
    if (final === 'posted') {
      assert.deepEqual([race[0].status, race[1].status], [200, 409]);
      assert.deepEqual([await base(r1), await base(r3)], [t1 + 15_000, t3 - 15_000]);
    } else {
      assert.equal(final, 'cancelled');
      assert.deepEqual([race[0].status, race[1].status], [409, 200]);
      assert.deepEqual([await base(r1), await base(r3)], [t1, t3]);
      const p4 = await $ana('/v1/capital/joint-reversals', { targetKind: 'route_transfer', targetId: trId, reason: 'Transferencia equivocada, otra vez' });
      assert.equal((await edu.money(`/v1/capital/joint-reversals/${(p4.body['proposal'] as Body)['id']}/confirm`, {})).status, 200);
      assert.deepEqual([await base(r1), await base(r3)], [t1 + 15_000, t3 - 15_000]);
    }
    await ledgerOk();
  });

  test('CA-011 · RLS: ni otra empresa ni un Administrador ajeno ven propuestas, partes u obligaciones; el SuperAdmin ve y no actúa', async () => {
    const hugoCtx = { identityId: identityOf('hugo'), membershipId: M.hugoAdmin };
    const fedeCtx = { identityId: fede.identityId, membershipId: fede.membershipId };
    assert.equal(((await pg(hugoCtx, c2, 'select count(*)::int n from adex.joint_reversal_proposals', [])) as { n: number }[])[0]!.n, 0);
    assert.equal(((await pg(fedeCtx, c1, 'select count(*)::int n from adex.joint_reversal_parts', [])) as { n: number }[])[0]!.n, 0, 'Fede no participa');
    const any = (await db.admin.query(`select id from adex.joint_reversal_proposals where company_id = $1 order by created_at limit 1`, [c1])).rows[0].id;
    assert.equal(await pg(hugoCtx, c2, 'select adex.joint_reversal_confirm($1, $2)', [randomUUID(), any]), 'AX412');
    assert.equal(await pg(hugoCtx, c2, 'select adex.joint_reversal_get($1)', [any]), 'AX412');
    assert.ok((await items(hugo)).every((x) => x['adminId'] !== M.anaAdmin), 'c2 no ve obligaciones de c1');
    // El SuperAdmin ve (solo lectura) pero no propone, confirma ni anula.
    assert.ok(((await bruno('GET', '/v1/capital/joint-reversals?status=all')).body['proposals'] as Body[]).length >= 3);
    const e = await general($ana, { scope: 'administrador', fundingSource: 'own_money', amountMinor: 1_000, description: 'Para el SuperAdmin' });
    expectCode(await $bruno(`/v1/expenses/${(e.body['expense'] as Body)['id']}/reverse`, { reason: 'Soy SuperAdmin' }), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'SA anula');
    expectCode(await $bruno('/v1/capital/joint-reversals', { targetKind: 'expense', targetId: jointExpense, reason: 'Soy SuperAdmin' }), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'SA propone');
    // Tablas sin escritura para la API.
    assert.equal(await pg(anaCtx, c1, 'update adex.joint_reversal_proposals set status = $1', ['cancelled']), '42501');
  });

  test('CA-012 · periodo cerrado: la anulación ofrece la reapertura explícita; la responsable reabre con motivo y anula', async () => {
    const inj = await $ana('/v1/capital/route-base/injections', { routeId: r1, amountMinor: 2_000, reason: 'Inyección antes del cierre' });
    const injId = (inj.body['operation'] as Body)['id'] as string;
    // Semana de hoy cerrada en r1 (siembra directa: el servidor solo cierra semanas terminadas).
    const wid = randomUUID();
    await db.admin.query(`insert into adex.weekly_settlements (id, company_id, route_id, week_start, week_end, opening_balance_minor, capital_in_minor, collections_minor,
      loans_disbursed_minor, expenses_minor, transfers_in_minor, transfers_out_minor, withdrawals_minor, closing_balance_minor, created_at, status, version,
      created_by_membership_id, closed_at, closed_by_membership_id)
      values ($1, $2, $3, $4::date - 1, $4::date + 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, now(), 'cerrada', 1, $5, now(), $5)`, [wid, c1, r1, today, M.anaAdmin]);
    const r = await $ana(`/v1/capital/operations/${injId}/reverse`, { reason: 'Inyección equivocada' });
    expectCode(r, 409, 'PERIOD_CLOSED', 'periodo cerrado');
    assert.deepEqual(deps(r).map((d) => [d['kind'], d['id'], d['action']]), [['closed_period', wid, 'reopen_period']]);
    const pv = await ana('GET', `/v1/corrections/preview?kind=operation&id=${injId}`);
    assert.ok((pv.body['dependencies'] as Body[]).some((d) => d['kind'] === 'closed_period'), JSON.stringify(pv.body));
    // Otro Administrador no reabre; la responsable sí (motivo de 10+).
    expectCode(await fede.money(`/v1/periods/${wid}/reopen`, { reason: 'No soy el responsable de r1' }), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'Fede reabre');
    const ro = await $ana(`/v1/periods/${wid}/reopen`, { reason: 'Reabro para corregir una inyección equivocada' });
    assert.equal(ro.status, 200, JSON.stringify(ro.body));
    const rv = await $ana(`/v1/capital/operations/${injId}/reverse`, { reason: 'Inyección equivocada' });
    assert.equal(rv.status, 201, JSON.stringify(rv.body));
    await ledgerOk();
  });
});
