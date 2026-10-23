// R74 · Financiación de gastos GENERALES (0035, decisión D74-O4F del propietario, §13.2):
//   · alcance (`administrador` NUEVO / `empresa`) y fuente (`routes` / `own_money`) independientes;
//   · A  = gasto general del Administrador con aportes explícitos de SUS rutas (suma = gasto; sale de cada Base);
//   · C1 = gasto general de la empresa con la misma mecánica; regla DEFINITIVA del propietario: solo rutas del
//          Administrador que registra, nunca de otro Administrador (igual en A y en reembolsos);
//   · C2 = gasto pagado con dinero propio: obligación de la empresa (`admin_payable`), siempre reembolsable, sin
//          aprobación, NUNCA efectivo; en ambos modelos de capital;
//   · reembolsos (parciales/totales, nunca más de lo pendiente, idempotentes, concurrentes) y anulaciones;
//   · panel por ruta con los gastos generales y los reembolsos pendientes APARTE; conciliación y conservación.
// Datos sintéticos, PostgreSQL local.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf, routeId } from '../../db/seeds/synthetic.ts';
import { asApi, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { balance, money, newPerson, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('R74 · financiación de gastos generales (0035, D74-O4F)', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const c2 = companyId('c2');
  const [r1, r2, r3] = [routeId('c1', 1), routeId('c1', 2), routeId('c1', 3)];
  let bruno: Caller, $bruno: Money, ana: Caller, $ana: Money, carla: Caller, $carla: Money, hugo: Caller, $hugo: Money, fabio: Caller;
  let carlos: Person, dora: Person, edu: Person;
  let today = '', cat = '', durCat = '', catC2 = '';
  let aTwoRoutes = '';

  const base = (r: string) => balance(db.admin, c1, 'route_base', null, r);
  const payable = (m: string, company = c1) => balance(db.admin, company, 'admin_payable', m);
  const pool = (m: string, company = c1) => balance(db.admin, company, 'admin', m);
  const count = async (sql: string, p: unknown[] = [c1]) => Number((await db.admin.query(sql, p)).rows[0].n);
  const opCount = () => count('select count(*) n from adex.capital_operations where company_id = $1');
  const expCount = () => count('select count(*) n from adex.expenses where company_id = $1');
  const legs = async (opId: string) => (await db.admin.query<{ kind: string; route_id: string | null; membership_id: string | null; amount: number }>(
    `select a.kind, a.route_id, a.membership_id, e.amount_minor::int amount from adex.capital_entries e
       join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id where e.operation_id = $1 order by e.leg`, [opId])).rows;
  const expectCode = (r: { status: number; body: Body }, status: number, code: string, label: string) =>
    assert.deepEqual([r.status, r.body['error'] ?? r.body['code']], [status, code], `${label}: ${JSON.stringify(r.body)}`);
  const general = (who: Money, body: Body, opId?: string) =>
    who('/v1/expenses', { categoryId: cat, description: 'Gasto general sintético', ...body }, opId);
  const panel = async (who: Caller = bruno) => {
    const r = await who('GET', `/v1/capital/route-panel?from=${today}&to=${today}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const ledgerOk = async () => {
    const r = await bruno('GET', '/v1/capital/reconciliation');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const checks = r.body['checks'] as Body[];
    assert.deepEqual(checks.filter((c) => !c['ok']), [], 'conciliación limpia');
    for (const name of ['general-funding-matches-contributions', 'admin-payables-match-expenses-and-reimbursements', 'route-conservation', 'expenses-have-ledger-entry']) {
      assert.ok(checks.some((c) => c['name'] === name), `incluye ${name}`);
    }
  };

  before(async () => {
    db = await createTestDb('r74_general_expenses', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    carla = caller(api, issuer, 'carla', M.carlaSa); $carla = money(carla);
    hugo = caller(api, issuer, 'hugo', M.hugoAdmin); $hugo = money(hugo);
    fabio = caller(api, issuer, 'fabio', M.fabioSec);
    today = (await db.admin.query(`select adex.business_today($1)::text d`, [c1])).rows[0].d;
    cat = (await db.admin.query(`select id from adex.expense_categories where company_id = $1 and active order by id limit 1`, [c1])).rows[0].id;
    catC2 = (await db.admin.query(`select id from adex.expense_categories where company_id = $1 and active order by id limit 1`, [c2])).rows[0].id;
    carlos = await newPerson(api, issuer, provider.ids, bruno, { email: 'carlos-ge@example.test', role: 'cobrador', displayName: 'Carlos', routeIds: [r1] });
    dora = await newPerson(api, issuer, provider.ids, bruno, { email: 'dora-ge@example.test', role: 'supervisor', displayName: 'Dora', routeIds: [r1] });
    edu = await newPerson(api, issuer, provider.ids, bruno, { email: 'edu-ge@example.test', role: 'admin', displayName: 'Edu', routeIds: [r3] });
    const of2 = (await db.admin.query(`select id from adex.offices where company_id = $1 and code = 'OF-2'`, [c1])).rows[0].id as string;
    assert.equal((await bruno('POST', `/v1/offices/${of2}/status`, { status: 'activa' })).status, 200);
    assert.equal((await bruno('POST', `/v1/routes/${r3}/status`, { status: 'activa' })).status, 200);
    const r3ctrl = (await db.admin.query('select capital_controller_membership_id c from adex.routes where id = $1', [r3])).rows[0].c;
    if (r3ctrl !== edu.membershipId) {
      assert.equal((await bruno('PUT', `/v1/routes/${r3}/capital-controller`, { membershipId: edu.membershipId, reason: 'Responsable de r3' })).status, 200);
    }
    // r3 visible para Ana (alcance), pero su responsable es Edu: sirve para probar que Ana NO puede usar su Base.
    assert.equal((await bruno('PUT', `/v1/members/${M.anaAdmin}/routes`, { routeIds: [r1, r2, r3] })).status, 200);
    const company = await balance(db.admin, c1, 'company', null);
    if (company > 0) assert.equal((await $bruno('/v1/capital/company/withdrawals', { amountMinor: company, reason: 'Disponible a cero antes del corte' })).status, 201);
    const pre = await bruno('GET', '/v1/capital/model/prerequisites');
    assert.equal(pre.body['ok'], true, JSON.stringify(pre.body));
    const act = await $bruno('/v1/capital/model', { target: 'route_base', evidence: 'Corte autorizado para la prueba local de gastos generales', backupReference: 'backup-local-ge' });
    assert.equal(act.status, 200, JSON.stringify(act.body));
    for (const [who, r, amt] of [[$ana, r1, 200_000], [$ana, r2, 50_000], [edu.money, r3, 80_000]] as const) {
      const inj = await who('/v1/capital/route-base/injections', { routeId: r, amountMinor: amt, reason: 'Base inicial sintética' });
      assert.equal(inj.status, 201, JSON.stringify(inj.body));
    }
    const dc = await ana('POST', '/v1/expense-categories', { name: 'Equipo de oficina', nature: 'bien_duradero' }, { 'x-adex-operation-id': randomUUID() });
    assert.equal(dc.status, 201, JSON.stringify(dc.body));
    durCat = dc.body['id'] as string;
  });
  after(async () => { await api?.close(); await db?.close(); });

  test('GE-001 · esquema y API: feature, rechazo claro de bolsa/cuenta de empresa con route_base (AX426)', async () => {
    assert.equal(Number((await db.admin.query(`select count(*) n from pg_proc where proname in ('general_expense_post', 'admin_reimbursement_post', 'admin_payables')`)).rows[0].n), 3);
    const before = await opCount();
    expectCode(await general($ana, { scope: 'empresa', amountMinor: 1_000, fundingSource: 'admin', fundingAdminId: M.anaAdmin }), 409, 'GENERAL_EXPENSE_FUNDING_PENDING', 'bolsa con route_base');
    expectCode(await general($ana, { scope: 'administrador', amountMinor: 1_000 }), 400, 'INVALID_INPUT', 'alcance administrador sin fuente');
    expectCode(await general($ana, { scope: 'administrador', amountMinor: 1_000, fundingSource: 'admin' }), 400, 'INVALID_INPUT', 'alcance administrador con bolsa');
    expectCode(await general($ana, { scope: 'administrador', fundingSource: 'routes', routeId: r1, amountMinor: 1_000, contributions: [{ routeId: r1, amountMinor: 1_000 }] }),
      400, 'INVALID_INPUT', 'un gasto general no lleva ruta');
    expectCode(await general($ana, { scope: 'ruta', routeId: r1, amountMinor: 1_000, contributions: [{ routeId: r1, amountMinor: 1_000 }] }), 400, 'INVALID_INPUT', 'aportes en un gasto de ruta');
    assert.equal(await opCount(), before, 'nada se escribió');
  });

  test('GE-002 · A con una ruta: sale de la Base de la ruta; gasto único con alcance administrador; idempotente', async () => {
    const b1 = await base(r1);
    const opId = randomUUID();
    const body = { scope: 'administrador', fundingSource: 'routes', amountMinor: 10_000, contributions: [{ routeId: r1, amountMinor: 10_000 }], description: 'Papelería del Administrador' };
    const r = await general($ana, body, opId);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const e = r.body['expense'] as Body;
    assert.deepEqual([e['scope'], e['funding'], e['adminId'], e['routeId'], e['amountMinor'], e['nature'], e['isReimbursable']],
      ['administrador', 'routes', M.anaAdmin, null, 10_000, 'operativo', false]);
    assert.deepEqual((e['contributions'] as Body[]).map((c) => [c['routeId'], c['amountMinor']]), [[r1, 10_000]]);
    assert.deepEqual(await legs(e['ledgerOperationId'] as string), [
      { kind: 'route_base', route_id: r1, membership_id: null, amount: -10_000 }, { kind: 'expense', route_id: null, membership_id: null, amount: 10_000 }]);
    assert.equal(await base(r1), b1 - 10_000);
    const again = await general($ana, body, opId);
    assert.equal(again.status, 201);
    assert.deepEqual(again.body, r.body, 'el reintento devuelve la misma respuesta');
    assert.equal(await base(r1), b1 - 10_000, 'sin doble cobro');
    // Segunda barrera: el mismo id de operación en PostgreSQL → AX409.
    const dup = await asApi(db.api, { identityId: identityOf('ana'), membershipId: M.anaAdmin, companyId: c1 }, async (q) =>
      q.query(`select adex.general_expense_post($1, 'administrador', $2, 10000, 'Repetido', null, 'routes', $3::jsonb)`, [opId, cat, JSON.stringify(body.contributions)])
        .then(() => 'ok', (err: { code?: string }) => err.code));
    assert.equal(dup, 'AX409');
  });

  test('GE-003 · A con dos rutas: una operación por ruta enlazada al MISMO gasto; suma = gasto', async () => {
    const [b1, b2, n0] = [await base(r1), await base(r2), await expCount()];
    const r = await general($ana, { scope: 'administrador', fundingSource: 'routes', amountMinor: 10_000, categoryId: durCat, description: 'Impresora de la oficina',
      contributions: [{ routeId: r2, amountMinor: 3_000 }, { routeId: r1, amountMinor: 7_000 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const e = r.body['expense'] as Body;
    aTwoRoutes = e['id'] as string;
    assert.equal(e['nature'], 'bien_duradero');
    assert.equal(await expCount(), n0 + 1, 'el gasto existe una sola vez');
    assert.deepEqual([await base(r1), await base(r2)], [b1 - 7_000, b2 - 3_000]);
    const ops = (await db.admin.query(`select kind, route_id, amount_minor::int a, admin_membership_id from adex.capital_operations where expense_id = $1 order by route_id`, [aTwoRoutes])).rows;
    assert.deepEqual(ops.map((o) => [o.kind, o.route_id, o.a, o.admin_membership_id]).sort(),
      [['GENERAL_EXPENSE_CONTRIBUTION', r1, 7_000, M.anaAdmin], ['GENERAL_EXPENSE_CONTRIBUTION', r2, 3_000, M.anaAdmin]].sort());
    const rows = (await db.admin.query(`select route_id, amount_minor::int a from adex.general_funding_contributions where expense_id = $1 order by route_id`, [aTwoRoutes])).rows;
    assert.equal(rows.reduce((t, x) => t + x.a, 0), 10_000);
    const g = await ana('GET', `/v1/expenses/${aTwoRoutes}`);
    assert.equal(g.status, 200);
    // El Administrador ve las patas de las Bases de sus rutas (la cuenta de gastos generales sin ruta es solo del SuperAdmin).
    assert.deepEqual((g.body['entries'] as Body[]).map((x) => [(x['account'] as Body)['kind'], (x['account'] as Body)['routeId'], x['amountMinor']]).sort(),
      [['route_base', r1, -7_000], ['route_base', r2, -3_000]].sort(), 'patas de ambos aportes');
    assert.equal(((await bruno('GET', `/v1/expenses/${aTwoRoutes}`)).body['entries'] as Body[]).length, 4, 'el SuperAdmin ve las cuatro patas');
    assert.equal(((g.body['expense'] as Body)['contributions'] as Body[]).length, 2);
    const list = await ana('GET', '/v1/expenses?scope=administrador');
    assert.ok((list.body['expenses'] as Body[]).some((x) => x['id'] === aTwoRoutes), 'Ana ve su gasto general');
  });

  test('GE-004 · aportes inválidos: suma distinta, ruta repetida, lista vacía (API y segunda barrera AX429)', async () => {
    const before = [await opCount(), await expCount(), await base(r1)];
    expectCode(await general($ana, { scope: 'administrador', fundingSource: 'routes', amountMinor: 5_000, contributions: [{ routeId: r1, amountMinor: 4_000 }] }), 400, 'CONTRIBUTIONS_INVALID', 'suma');
    expectCode(await general($ana, { scope: 'administrador', fundingSource: 'routes', amountMinor: 2_000, contributions: [{ routeId: r1, amountMinor: 1_000 }, { routeId: r1, amountMinor: 1_000 }] }), 400, 'CONTRIBUTIONS_INVALID', 'repetida');
    expectCode(await general($ana, { scope: 'administrador', fundingSource: 'routes', amountMinor: 2_000, contributions: [] }), 400, 'CONTRIBUTIONS_INVALID', 'vacía');
    expectCode(await general($ana, { scope: 'administrador', fundingSource: 'routes', amountMinor: 2_000 }), 400, 'CONTRIBUTIONS_INVALID', 'sin aportes');
    expectCode(await general($ana, { scope: 'administrador', fundingSource: 'own_money', amountMinor: 2_000, contributions: [{ routeId: r1, amountMinor: 2_000 }] }), 400, 'INVALID_INPUT', 'dinero propio con aportes');
    const code = await asApi(db.api, { identityId: identityOf('ana'), membershipId: M.anaAdmin, companyId: c1 }, async (q) =>
      q.query(`select adex.general_expense_post($1, 'administrador', $2, 5000, 'Suma distinta', null, 'routes', $3::jsonb)`,
        [randomUUID(), cat, JSON.stringify([{ routeId: r1, amountMinor: 4_000 }])]).then(() => 'ok', (err: { code?: string }) => err.code));
    assert.equal(code, 'AX429', 'PostgreSQL también lo rechaza');
    assert.deepEqual([await opCount(), await expCount(), await base(r1)], before);
  });

  test('GE-005 · Base insuficiente en una de las rutas → TODO falla y nada se escribe', async () => {
    const before = [await opCount(), await expCount(), await base(r1), await base(r2),
      await count('select count(*) n from adex.general_funding_contributions where company_id = $1')];
    const r = await general($ana, { scope: 'administrador', fundingSource: 'routes', amountMinor: 1_000 + before[3]! + 1,
      contributions: [{ routeId: r1, amountMinor: 1_000 }, { routeId: r2, amountMinor: before[3]! + 1 }] });
    expectCode(r, 409, 'INSUFFICIENT_FUNDS', 'Base de r2 insuficiente');
    assert.deepEqual([await opCount(), await expCount(), await base(r1), await base(r2),
      await count('select count(*) n from adex.general_funding_contributions where company_id = $1')], before);
  });

  test('GE-006 · ruta de otro Administrador rechazada SIEMPRE (A y C1; regla definitiva del propietario)', async () => {
    const before = [await opCount(), await base(r3)];
    expectCode(await general($ana, { scope: 'administrador', fundingSource: 'routes', amountMinor: 1_000, contributions: [{ routeId: r3, amountMinor: 1_000 }] }),
      403, 'CONTRIBUTION_ROUTE_NOT_ALLOWED', 'A con la ruta de Edu');
    expectCode(await general($ana, { scope: 'empresa', fundingSource: 'routes', amountMinor: 2_000, contributions: [{ routeId: r1, amountMinor: 1_000 }, { routeId: r3, amountMinor: 1_000 }] }),
      403, 'CONTRIBUTION_ROUTE_NOT_ALLOWED', 'C1 mezclando una ruta de Edu');
    assert.deepEqual([await opCount(), await base(r3)], before);
    // Regla única y definitiva: solo el responsable válido de la ruta; nunca otro Administrador, en ningún alcance.
    const allowed = async (route: string, actor: string, scope: string) =>
      (await db.admin.query('select adex.general_contribution_route_allowed($1, $2, $3, $4) ok', [c1, route, actor, scope])).rows[0].ok;
    assert.deepEqual([await allowed(r3, M.anaAdmin, 'empresa'), await allowed(r3, edu.membershipId, 'empresa'), await allowed(r1, M.anaAdmin, 'administrador'),
      await allowed(r1, edu.membershipId, 'administrador')], [false, true, true, false]);
    assert.equal(await allowed(r1, edu.membershipId, 'empresa'), false, 'C1: tampoco con alcance empresa');
  });

  test('GE-007 · C1: gasto general de la empresa con aportes de rutas del Administrador que registra', async () => {
    const [b1, b3] = [await base(r1), await base(r3)];
    const a = await general($ana, { scope: 'empresa', fundingSource: 'routes', amountMinor: 4_000, contributions: [{ routeId: r1, amountMinor: 4_000 }], description: 'Contador de la empresa (parte de Ana)' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const e = await general(edu.money, { scope: 'empresa', funding: 'routes', amountMinor: 2_500, contributions: [{ routeId: r3, amountMinor: 2_500 }], description: 'Contador de la empresa (parte de Edu)' });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    assert.deepEqual([(a.body['expense'] as Body)['scope'], (a.body['expense'] as Body)['funding'], (e.body['expense'] as Body)['adminId']], ['empresa', 'routes', edu.membershipId]);
    assert.deepEqual([await base(r1), await base(r3)], [b1 - 4_000, b3 - 2_500]);
  });

  test('GE-008 · C2 con route_base: obligación con el Administrador (admin_payable), ninguna Base ni caja cambia', async () => {
    const [b1, b2, b3, p0] = [await base(r1), await base(r2), await base(r3), await payable(M.anaAdmin)];
    const cash0 = (await panel())['totals'] as Body;
    const r = await general($ana, { scope: 'empresa', fundingSource: 'own_money', amountMinor: 25_000, description: 'Arriendo pagado por Ana' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const e = r.body['expense'] as Body;
    assert.deepEqual([e['funding'], e['isReimbursable'], e['adminId'], r.body['pendingMinor']], ['own_money', true, M.anaAdmin, 25_000 - p0]);
    assert.deepEqual(await legs(e['ledgerOperationId'] as string), [
      { kind: 'admin_payable', route_id: null, membership_id: M.anaAdmin, amount: -25_000 }, { kind: 'expense', route_id: null, membership_id: null, amount: 25_000 }]);
    const s = await general($ana, { scope: 'administrador', fundingSource: 'own_money', amountMinor: 5_000, description: 'Viáticos de supervisión de Ana' });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal(await payable(M.anaAdmin), p0 - 30_000);
    assert.deepEqual([await base(r1), await base(r2), await base(r3)], [b1, b2, b3], 'ninguna Base se mueve');
    const cash1 = (await panel())['totals'] as Body;
    for (const k of ['baseMinor', 'custodyMinor', 'cashMinor', 'deliverableCustodyMinor']) assert.equal(cash1[k], cash0[k], `${k} no incluye la obligación`);
    const mine = await ana('GET', '/v1/capital/admin-payables');
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.body['isCash'], false);
    assert.deepEqual((mine.body['admins'] as Body[]).map((a) => [a['adminId'], a['pendingMinor'], a['ownMoneyExpensesMinor']]), [[M.anaAdmin, 30_000, 30_000]]);
    const sa = await bruno('GET', '/v1/capital/admin-payables');
    assert.equal(sa.body['totalPendingMinor'], 30_000);
  });

  test('GE-009 · C2 y reembolso con admin_pool (c2): obligación sin efectivo; reembolso desde la bolsa de quien paga', async () => {
    assert.equal((await $carla('/v1/capital/company/deposits', { amountMinor: 100_000, reason: 'Capital de c2' })).status, 201);
    assert.equal((await $carla('/v1/capital/allocations', { adminId: M.hugoAdmin, amountMinor: 50_000, reason: 'Bolsa de Hugo' })).status, 201);
    const pool0 = await pool(M.hugoAdmin, c2);
    const r = await $hugo('/v1/expenses', { scope: 'empresa', fundingSource: 'own_money', categoryId: catC2, amountMinor: 8_000, description: 'Software pagado por Hugo' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await payable(M.hugoAdmin, c2), -8_000);
    assert.equal(await pool(M.hugoAdmin, c2), pool0, 'la bolsa no se toca');
    expectCode(await $hugo('/v1/expenses', { scope: 'empresa', fundingSource: 'routes', categoryId: catC2, amountMinor: 1_000, description: 'Con aportes en admin_pool',
      contributions: [{ routeId: routeId('c2', 1), amountMinor: 1_000 }] }), 409, 'ROUTE_BASE_NOT_ACTIVE', 'aportes de rutas sin Base por Ruta');
    expectCode(await $hugo('/v1/capital/reimbursements', { adminId: M.hugoAdmin, contributions: [{ routeId: routeId('c2', 1), amountMinor: 1_000 }], reason: 'Con aportes en admin_pool' }),
      400, 'CONTRIBUTIONS_INVALID', 'aportes en admin_pool');
    const rb = await $hugo('/v1/capital/reimbursements', { adminId: M.hugoAdmin, amountMinor: 3_000, reason: 'Reembolso parcial desde la bolsa' });
    assert.equal(rb.status, 201, JSON.stringify(rb.body));
    assert.deepEqual([rb.body['pendingBeforeMinor'], rb.body['pendingAfterMinor'], (rb.body['reimbursement'] as Body)['source']], [8_000, 5_000, 'admin_pool']);
    assert.deepEqual([await payable(M.hugoAdmin, c2), await pool(M.hugoAdmin, c2)], [-5_000, pool0 - 3_000]);
    expectCode(await $hugo('/v1/capital/reimbursements', { adminId: M.hugoAdmin, amountMinor: 6_000, reason: 'Más de lo pendiente' }), 409, 'REIMBURSEMENT_EXCEEDS_PENDING', 'exceso');
    const rec = await carla('GET', '/v1/capital/reconciliation');
    assert.deepEqual((rec.body['checks'] as Body[]).filter((c) => !c['ok']), [], 'c2 concilia');
  });

  test('GE-010 · reembolso parcial con aportes de rutas de QUIEN PAGA (el mismo Administrador u otro)', async () => {
    const [b1, b2, b3, p0] = [await base(r1), await base(r2), await base(r3), await payable(M.anaAdmin)];
    assert.equal(p0, -30_000);
    const own = await $ana('/v1/capital/reimbursements', { adminId: M.anaAdmin, contributions: [{ routeId: r1, amountMinor: 6_000 }, { routeId: r2, amountMinor: 4_000 }], reason: 'Reembolso parcial a Ana' });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.deepEqual([own.body['pendingBeforeMinor'], own.body['pendingAfterMinor'], (own.body['reimbursement'] as Body)['amountMinor']], [30_000, 20_000, 10_000]);
    const opIds = ((own.body['reimbursement'] as Body)['contributions'] as Body[]).map((c) => c['operationId'] as string);
    assert.equal(opIds.length, 2);
    for (const id of opIds) {
      const l = await legs(id);
      assert.equal(l.length, 2);
      assert.equal(l[0]!.kind, 'route_base');
      assert.deepEqual([l[1]!.kind, l[1]!.membership_id], ['admin_payable', M.anaAdmin]);
    }
    // Edu (responsable de r3) paga parte de lo que la empresa le debe a Ana: aporte de SU ruta.
    const byEdu = await edu.money('/v1/capital/reimbursements', { adminId: M.anaAdmin, contributions: [{ routeId: r3, amountMinor: 5_000 }], reason: 'Edu reembolsa a Ana desde r3' });
    assert.equal(byEdu.status, 201, JSON.stringify(byEdu.body));
    expectCode(await $ana('/v1/capital/reimbursements', { adminId: M.anaAdmin, contributions: [{ routeId: r3, amountMinor: 1_000 }], reason: 'Desde la ruta de Edu' }),
      403, 'CONTRIBUTION_ROUTE_NOT_ALLOWED', 'ruta de otro responsable');
    assert.deepEqual([await base(r1), await base(r2), await base(r3), await payable(M.anaAdmin)], [b1 - 6_000, b2 - 4_000, b3 - 5_000, -15_000]);
    const list = await ana('GET', '/v1/capital/reimbursements');
    assert.equal((list.body['reimbursements'] as Body[]).length, 2, 'Ana ve los dos reembolsos recibidos');
  });

  test('GE-011 · nunca más de lo pendiente; idempotencia; concurrencia (dos que juntos lo superan → uno)', async () => {
    assert.equal(await payable(M.anaAdmin), -15_000);
    const before = await opCount();
    expectCode(await $ana('/v1/capital/reimbursements', { adminId: M.anaAdmin, contributions: [{ routeId: r1, amountMinor: 20_000 }], reason: 'Exceso' }), 409, 'REIMBURSEMENT_EXCEEDS_PENDING', 'exceso');
    assert.equal(await opCount(), before);
    const opId = randomUUID();
    const body = { adminId: M.anaAdmin, contributions: [{ routeId: r1, amountMinor: 1_000 }], reason: 'Reembolso idempotente' };
    const first = await $ana('/v1/capital/reimbursements', body, opId);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await $ana('/v1/capital/reimbursements', body, opId);
    assert.deepEqual([again.status, again.body], [first.status, first.body], 'mismo resultado');
    assert.equal(await payable(M.anaAdmin), -14_000);
    const b1 = await base(r1);
    const res = await Promise.all([0, 1].map((i) => $ana('/v1/capital/reimbursements', { adminId: M.anaAdmin, contributions: [{ routeId: r1, amountMinor: 10_000 }], reason: `Concurrente ${i}` })));
    const codes = res.map((r) => r.status).sort();
    assert.deepEqual(codes, [201, 409], JSON.stringify(res.map((r) => r.body)));
    expectCode(res.find((r) => r.status === 409)!, 409, 'REIMBURSEMENT_EXCEEDS_PENDING', 'el perdedor');
    assert.deepEqual([await payable(M.anaAdmin), await base(r1)], [-4_000, b1 - 10_000]);
    // Total: salda lo pendiente (queda en cero, nunca positivo).
    const total = await $ana('/v1/capital/reimbursements', { adminId: M.anaAdmin, amountMinor: 4_000, contributions: [{ routeId: r2, amountMinor: 4_000 }], reason: 'Saldo total' });
    assert.equal(total.status, 201, JSON.stringify(total.body));
    assert.equal(total.body['pendingAfterMinor'], 0);
    assert.equal(await payable(M.anaAdmin), 0);
    expectCode(await $ana('/v1/capital/reimbursements', { adminId: M.anaAdmin, contributions: [{ routeId: r1, amountMinor: 1 }], reason: 'Nada pendiente' }), 409, 'REIMBURSEMENT_EXCEEDS_PENDING', 'sin saldo');
  });

  test('GE-012 · anulación de C2: restaura la obligación; si ya se reembolsó, primero se anula el reembolso', async () => {
    const c2e = await general($ana, { scope: 'empresa', fundingSource: 'own_money', amountMinor: 12_000, description: 'Gasto que se anulará' });
    assert.equal(c2e.status, 201, JSON.stringify(c2e.body));
    const expId = (c2e.body['expense'] as Body)['id'] as string;
    assert.equal(await payable(M.anaAdmin), -12_000);
    const b1 = await base(r1);
    const rb = await $ana('/v1/capital/reimbursements', { adminId: M.anaAdmin, contributions: [{ routeId: r1, amountMinor: 5_000 }], reason: 'Reembolso que se anulará' });
    assert.equal(rb.status, 201, JSON.stringify(rb.body));
    assert.equal(await payable(M.anaAdmin), -7_000);
    // Quien no es responsable del gasto no lo anula (SuperAdmin, otro Administrador); tampoco reintegro parcial.
    expectCode(await $bruno(`/v1/expenses/${expId}/reverse`, { reason: 'El SuperAdmin no anula' }), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'SuperAdmin');
    expectCode(await edu.money(`/v1/expenses/${expId}/reverse`, { reason: 'Otro Administrador' }), 404, 'NOT_FOUND', 'Edu ni lo ve (RLS)');
    expectCode(await $ana(`/v1/expenses/${expId}/refunds`, { amountMinor: 1_000, reason: 'Reintegro parcial' }), 409, 'REFUND_NOT_ALLOWED', 'reintegro');
    expectCode(await $ana(`/v1/expenses/${expId}/reverse`, { reason: 'Ya reembolsado en parte' }), 409, 'PAYABLE_ALREADY_REIMBURSED', 'reembolsado');
    // Se anula el reembolso (solo quien pagó) y luego el gasto.
    const rbId = (rb.body['reimbursement'] as Body)['id'] as string;
    expectCode(await edu.money(`/v1/capital/reimbursements/${rbId}/reverse`, { reason: 'No lo pagó Edu' }), 404, 'NOT_FOUND', 'otro Administrador ni lo ve');
    const rv = await $ana(`/v1/capital/reimbursements/${rbId}/reverse`, { reason: 'Reembolso registrado por error' });
    assert.equal(rv.status, 201, JSON.stringify(rv.body));
    assert.deepEqual([await payable(M.anaAdmin), await base(r1)], [-12_000, b1]);
    expectCode(await $ana(`/v1/capital/reimbursements/${rbId}/reverse`, { reason: 'Otra vez' }), 409, 'ALREADY_REVERSED', 'doble anulación');
    const ex = await $ana(`/v1/expenses/${expId}/reverse`, { reason: 'Gasto registrado por error' });
    assert.equal(ex.status, 201, JSON.stringify(ex.body));
    assert.equal(await payable(M.anaAdmin), 0, 'la obligación vuelve a ser la de antes');
    assert.deepEqual([((ex.body['original'] as Body)['state']), ((ex.body['reversal'] as Body)['amountMinor'])], ['anulado', -12_000]);
    // La operación genérica de anulación no sirve para estos tipos.
    const opId = (c2e.body['expense'] as Body)['ledgerOperationId'] as string;
    expectCode(await $ana(`/v1/capital/operations/${opId}/reverse`, { reason: 'Por la vía genérica' }), 409, 'REVERSAL_NOT_ALLOWED', 'genérica');
  });

  test('GE-013 · anulación de A con dos rutas: cada importe vuelve a la Base de SU ruta; una sola vez', async () => {
    const [b1, b2] = [await base(r1), await base(r2)];
    const r = await $ana(`/v1/expenses/${aTwoRoutes}/reverse`, { reason: 'Impresora devuelta al proveedor' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([await base(r1), await base(r2)], [b1 + 7_000, b2 + 3_000]);
    assert.deepEqual((r.body['entries'] as Body[]).map((x) => x['amountMinor']).sort(), [3_000, 7_000], 'vuelve a cada Base');
    const rev = (await db.admin.query(`select count(*) n from adex.capital_operations where kind = 'REVERSAL' and reverses_kind = 'GENERAL_EXPENSE_CONTRIBUTION'
      and reverses_operation_id in (select operation_id from adex.general_funding_contributions where expense_id = $1)`, [aTwoRoutes])).rows[0].n;
    assert.equal(Number(rev), 2);
    expectCode(await $ana(`/v1/expenses/${aTwoRoutes}/reverse`, { reason: 'Otra vez' }), 409, 'ALREADY_REVERSED', 'doble');
  });

  test('GE-014 · permisos: SuperAdmin, Supervisor, Secretario y Cobrador no registran ni reembolsan; nada se escribe', async () => {
    const before = [await opCount(), await expCount()];
    const body = { scope: 'administrador', fundingSource: 'own_money', amountMinor: 1_000, categoryId: cat, description: 'No autorizado' };
    expectCode(await $bruno('/v1/expenses', body), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'SuperAdmin');
    expectCode(await $bruno('/v1/expenses', { ...body, scope: 'empresa' }), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'SuperAdmin empresa');
    for (const [who, label] of [[dora.money, 'Supervisor'], [carlos.money, 'Cobrador'], [money(fabio), 'Secretario']] as const) {
      const r = await who('/v1/expenses', body);
      assert.equal(r.status, 403, `${label}: ${JSON.stringify(r.body)}`);
      const rb = await who('/v1/capital/reimbursements', { adminId: M.anaAdmin, amountMinor: 1, reason: 'No autorizado' });
      assert.equal(rb.status, 403, `${label} reembolso: ${JSON.stringify(rb.body)}`);
    }
    expectCode(await $bruno('/v1/capital/reimbursements', { adminId: M.anaAdmin, contributions: [{ routeId: r1, amountMinor: 1 }], reason: 'El SuperAdmin no paga' }),
      403, 'CAPITAL_AUTHORITY_REQUIRED', 'SuperAdmin reembolso');
    // Segunda barrera: el SuperAdmin directamente en PostgreSQL → AX402.
    const code = await asApi(db.api, { identityId: identityOf('bruno'), membershipId: M.brunoSa, companyId: c1 }, async (q) =>
      q.query(`select adex.general_expense_post($1, 'empresa', $2, 1000, 'Directo', null, 'own_money', null)`, [randomUUID(), cat]).then(() => 'ok', (err: { code?: string }) => err.code));
    assert.equal(code, 'AX402');
    assert.equal((await carlos.call('GET', '/v1/capital/admin-payables')).status, 403);
    assert.deepEqual([await opCount(), await expCount()], before);
  });

  test('GE-015 · RLS multiempresa y por persona', async () => {
    // c2 no ve nada de c1.
    const seen = await asApi(db.api, { identityId: identityOf('hugo'), membershipId: M.hugoAdmin, companyId: c2 }, async (q) => ({
      contrib: Number((await q.query(`select count(*) n from adex.general_funding_contributions where company_id = $1`, [c1])).rows[0].n),
      reimb: Number((await q.query(`select count(*) n from adex.admin_reimbursements where company_id = $1`, [c1])).rows[0].n),
      exp: Number((await q.query(`select count(*) n from adex.expenses where company_id = $1 and scope = 'administrador'`, [c1])).rows[0].n),
      pay: Number((await q.query(`select count(*) n from adex.capital_accounts where company_id = $1 and kind = 'admin_payable'`, [c1])).rows[0].n),
    }));
    assert.deepEqual(seen, { contrib: 0, reimb: 0, exp: 0, pay: 0 });
    const hugoPay = await hugo('GET', '/v1/capital/admin-payables');
    assert.deepEqual((hugoPay.body['admins'] as Body[]).map((a) => a['adminId']), [M.hugoAdmin]);
    // Edu no ve el saldo a favor de Ana (aunque le pagó un reembolso) ni sus gastos generales.
    const eduPay = await edu.call('GET', '/v1/capital/admin-payables');
    assert.deepEqual(eduPay.body['admins'], []);
    const eduExp = await edu.call('GET', '/v1/expenses?scope=administrador');
    assert.ok(!(eduExp.body['expenses'] as Body[]).some((x) => x['adminId'] === M.anaAdmin));
    // El Cobrador no ve aportes ni obligaciones.
    const carlosSees = await asApi(db.api, { identityId: carlos.identityId, membershipId: carlos.membershipId, companyId: c1 }, async (q) =>
      Number((await q.query(`select (select count(*) from adex.general_funding_contributions) + (select count(*) from adex.admin_reimbursements)
        + (select count(*) from adex.capital_accounts where kind = 'admin_payable') n`)).rows[0].n));
    assert.equal(carlosSees, 0);
  });

  test('GE-016 · panel (O8): gastos generales y reembolsos pendientes APARTE del resultado de las rutas; nunca efectivo', async () => {
    // Una obligación vigente para verla en el panel.
    assert.equal((await general($ana, { scope: 'administrador', fundingSource: 'own_money', amountMinor: 3_000, categoryId: durCat, description: 'Silla de oficina de Ana' })).status, 201);
    const p = await panel();
    const rows = new Map((p['routes'] as Body[]).map((x) => [x['routeId'] as string, x]));
    const r1row = rows.get(r1)!;
    // Las salidas hacia gastos generales y reembolsos se ven por ruta, sin tocar su resultado ni su flujo operativo.
    const gf = r1row['generalFunding'] as Body;
    const net = async (kind: string) => Number((await db.admin.query(`select coalesce(-sum(e.amount_minor), 0) n from adex.capital_entries e
        join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
       where a.kind = 'route_base' and a.route_id = $1 and coalesce(o.reverses_kind, o.kind) = $2`, [r1, kind])).rows[0].n);
    assert.deepEqual([gf['generalExpenseContributionsMinor'], gf['adminReimbursementsMinor']], [await net('GENERAL_EXPENSE_CONTRIBUTION'), await net('ADMIN_REIMBURSEMENT')]);
    const period = r1row['period'] as Body;
    const exp = period['expenses'] as Body;
    assert.equal(r1row['operatingResultMinor'], Number(period['interestCollectedMinor']) - Number(exp['operativoMinor']) - Number(exp['otroMinor']),
      'el resultado de la ruta solo lleva sus gastos de ruta');
    const g = p['general'] as Body;
    const adminGeneral = (g['administratorGeneral'] as Body[]).find((a) => a['adminId'] === M.anaAdmin)!;
    // A de 10 000 (vigente) + A de 10 000 bien duradero anulada (neto 0) + 5 000 y 3 000 (duradero) con dinero propio.
    assert.deepEqual([adminGeneral['totalMinor'], adminGeneral['operativoMinor'], adminGeneral['bienDuraderoMinor'], adminGeneral['routesFundedMinor'], adminGeneral['ownMoneyMinor']],
      [18_000, 15_000, 3_000, 10_000, 8_000]);
    const companyGeneral = g['companyGeneral'] as Body;
    assert.deepEqual([(companyGeneral['byFunding'] as Body)['routesMinor'], (companyGeneral['byFunding'] as Body)['ownMoneyMinor']], [6_500, 25_000]);
    const pend = g['pendingAdminReimbursements'] as Body;
    assert.deepEqual([pend['totalMinor'], pend['isCash']], [3_000, false]);
    const totals = p['totals'] as Body;
    const cash = Number((await db.admin.query(`select coalesce(sum(balance_minor), 0) n from adex.capital_accounts where company_id = $1 and kind in ('route_base', 'custody')`, [c1])).rows[0].n);
    assert.equal(totals['cashMinor'], cash, 'el efectivo no incluye el saldo a favor');
    const cons = p['consolidated'] as Body;
    assert.equal(cons['pendingAdminReimbursementsMinor'], 3_000);
    assert.equal(cons['generalOperatingExpensesMinor'], 15_000 + Number(companyGeneral['operativoMinor']) + Number(companyGeneral['otroMinor']));
    assert.equal(cons['resultAfterGeneralExpensesMinor'], Number(cons['routesOperatingResultMinor']) - Number(cons['generalOperatingExpensesMinor']));
    // El Administrador ve sus propios gastos generales y su saldo a favor; Edu no ve los de Ana.
    const pa = await panel(ana);
    assert.ok(((pa['general'] as Body)['administratorGeneral'] as Body[]).some((a) => a['adminId'] === M.anaAdmin));
    const pe = await panel(edu.call);
    assert.ok(!((pe['general'] as Body)['administratorGeneral'] as Body[]).some((a) => a['adminId'] === M.anaAdmin));
    assert.equal(((pe['general'] as Body)['pendingAdminReimbursements'] as Body)['totalMinor'], 0);
  });

  test('GE-017 · concurrencia de A: dos gastos que juntos superan la Base de la ruta → exactamente uno', async () => {
    const b2 = await base(r2);
    const half = Math.floor(b2 / 2) + 1;
    const res = await Promise.all([0, 1].map((i) => general($ana, { scope: 'administrador', fundingSource: 'routes', amountMinor: half,
      contributions: [{ routeId: r2, amountMinor: half }], description: `Gasto concurrente ${i}` })));
    assert.deepEqual(res.map((r) => r.status).sort(), [201, 409], JSON.stringify(res.map((r) => r.body)));
    assert.equal(await base(r2), b2 - half);
  });

  test('GE-019 · ruta «en entrega» (O5): no aporta a gastos generales ni a reembolsos hasta confirmar el conteo', async () => {
    assert.equal((await bruno('PUT', `/v1/members/${edu.membershipId}/routes`, { routeIds: [r2, r3] })).status, 200);
    const ch = await bruno('PUT', `/v1/routes/${r2}/capital-controller`, { membershipId: edu.membershipId, reason: 'Edu recibe r2' });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    const [b2, n0] = [await base(r2), await opCount()];
    // Ana ya no es la responsable de r2.
    expectCode(await general($ana, { scope: 'administrador', fundingSource: 'routes', amountMinor: 1_000, contributions: [{ routeId: r2, amountMinor: 1_000 }] }),
      403, 'CONTRIBUTION_ROUTE_NOT_ALLOWED', 'antigua responsable');
    expectCode(await general(edu.money, { scope: 'administrador', fundingSource: 'routes', amountMinor: 1_000, contributions: [{ routeId: r2, amountMinor: 1_000 }] }),
      409, 'ROUTE_IN_HANDOVER', 'nuevo responsable antes del conteo');
    assert.equal((await general($ana, { scope: 'empresa', fundingSource: 'own_money', amountMinor: 1_000, description: 'Obligación para el reembolso' })).status, 201);
    expectCode(await edu.money('/v1/capital/reimbursements', { adminId: M.anaAdmin, contributions: [{ routeId: r2, amountMinor: 1_000 }], reason: 'Desde una ruta en entrega' }),
      409, 'ROUTE_IN_HANDOVER', 'reembolso');
    assert.deepEqual([await base(r2), await opCount()], [b2, n0 + 1], 'solo se registró la obligación (sin efectivo)');
  });

  test('GE-018 · libro: conciliación limpia (incluidas las comprobaciones nuevas), suma cero y conservación por ruta', async () => {
    await ledgerOk();
    const total = Number((await db.admin.query('select coalesce(sum(balance_minor), 0) n from adex.capital_accounts where company_id = $1', [c1])).rows[0].n);
    assert.equal(total, 0, 'el libro suma cero');
    for (const r of [r1, r2, r3]) {
      const x = (await db.admin.query(`
        select (select coalesce(sum(a.balance_minor), 0) from adex.capital_accounts a where a.company_id = $1 and a.route_id = $2)::bigint inside,
               (select coalesce(sum(e.amount_minor), 0) from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
                 where e.company_id = $1 and a.route_id = $2
                   and exists (select 1 from adex.capital_entries e2 join adex.capital_accounts a2 on a2.company_id = e2.company_id and a2.id = e2.account_id
                                where e2.company_id = e.company_id and e2.operation_id = e.operation_id and a2.route_id is distinct from $2))::bigint crossed`, [c1, r])).rows[0];
      assert.equal(Number(x.inside), Number(x.crossed), `conservación de ${r}`);
    }
    // Independiente de la función: saldo a favor = Σ dinero propio − Σ reembolsos vigentes; ninguna Base negativa ni obligación positiva.
    const bad = Number((await db.admin.query(`select count(*) n from adex.capital_accounts where company_id = $1
      and ((kind = 'route_base' and balance_minor < 0) or (kind = 'admin_payable' and balance_minor > 0))`, [c1])).rows[0].n);
    assert.equal(bad, 0);
    const own = Number((await db.admin.query(`select coalesce(sum(amount_minor), 0) n from adex.expenses where company_id = $1 and funding = 'own_money' and responsible_admin_membership_id = $2`, [c1, M.anaAdmin])).rows[0].n);
    const paid = Number((await db.admin.query(`select coalesce(sum(amount_minor), 0) n from adex.admin_reimbursements where company_id = $1 and admin_membership_id = $2 and reversed_at is null`, [c1, M.anaAdmin])).rows[0].n);
    assert.equal(-(await payable(M.anaAdmin)), own - paid);
  });
});
