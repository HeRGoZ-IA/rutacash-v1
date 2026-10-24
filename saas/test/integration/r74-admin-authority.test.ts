// R74 §15 · Autoridad del Administrador (migración 0036). Decisiones del propietario (2026-10-23):
//   · regla rectora: el Administrador es el máximo responsable del dinero; sin autorizador definido, la autoridad es
//     del responsable de capital VÁLIDO de las rutas afectadas; nunca de rutas ajenas ni de otra empresa;
//   · RB-D3 conciliación de diferencias por el Administrador (actas, faltantes y sobrantes de cuadre), sin aprobación
//     superior, con operaciones nuevas balanceadas; una diferencia resuelta no bloquea la ruta;
//   · RB-D1 ningún Administrador se desactiva con cuentas pendientes (API + disparador);
//   · RB-D2 cuenta de empresa en cero; RB-D6 activación directa solo sin saldos;
//   · RB-D7 correcciones por el responsable VIGENTE de TODAS las rutas afectadas;
//   · RB-D8 autorreembolso desde sus rutas; RB-D9 nunca pagar dos veces la misma obligación entre modelos;
//   · RB-D4 solicitud de devolución sin mover dinero; RB-D5 Secretario sin traspasos en route_base;
//   · C-14 Offline: sin clientes ni ventas; cobros, visitas, gastos propios y desembolsos aprobados desde la custodia.
// Dos empresas (c1 route_base, c2 admin_pool), varias rutas y Administradores. Datos sintéticos, PostgreSQL local.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf, routeId } from '../../db/seeds/synthetic.ts';
import { asApi, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, parallel, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('R74 · autoridad del Administrador y conciliación de diferencias (0036)', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const c2 = companyId('c2');
  const c3 = companyId('c3');
  const [r1, r2, r3] = [routeId('c1', 1), routeId('c1', 2), routeId('c1', 3)];
  const c2r1 = routeId('c2', 1);
  let bruno: Caller, $bruno: Money, ana: Caller, $ana: Money, carla: Caller, $carla: Money, hugo: Caller, $hugo: Money, gabi: Caller, diego: Caller;
  let carlos: Person, dora: Person, edu: Person, fede: Person;
  let today = '', todayC2 = '', cat = '', catC2 = '';
  let jointExpense = '', singleExpenseR2 = '', selfReimbR2 = '';
  let shortageSettlement = '';

  const base = (r: string) => balance(db.admin, c1, 'route_base', null, r);
  const diffAcc = (r: string, company = c1) => balance(db.admin, company, 'route_difference', null, r);
  const custody = (m: string, r: string = r1, company = c1) => balance(db.admin, company, 'custody', m, r);
  const payable = (m: string) => balance(db.admin, c1, 'admin_payable', m);
  const pool = (m: string, company = c1) => balance(db.admin, company, 'admin', m);
  const count = async (sql: string, p: unknown[] = [c1]) => Number((await db.admin.query(sql, p)).rows[0].n);
  const opCount = (company = c1) => count('select count(*) n from adex.capital_operations where company_id = $1', [company]);
  const carried = async (m: string, r: string = r1, company = c1) => Number((await db.admin.query(
    `select coalesce((select carried_minor from adex.capital_accounts where company_id = $1 and kind = 'custody' and membership_id = $2 and route_id = $3), 0) n`,
    [company, m, r])).rows[0].n);
  const legs = async (opId: string) => (await db.admin.query<{ kind: string; route_id: string | null; membership_id: string | null; amount: number }>(
    `select a.kind, a.route_id, a.membership_id, e.amount_minor::int amount from adex.capital_entries e
       join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id where e.operation_id = $1 order by e.leg`, [opId])).rows;
  const expectCode = (r: { status: number; body: Body }, status: number, code: string, label: string) =>
    assert.deepEqual([r.status, r.body['error'] ?? r.body['code']], [status, code], `${label}: ${JSON.stringify(r.body)}`);
  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const off = () => ({ capturedAt: new Date(Date.now() - 3_600_000).toISOString() });
  const clientBody = (route: string) => ({ routeId: route, name: `CLIENTE AA ${randomUUID().slice(0, 6)}`, documentType: 'CPF', document: cpf(),
    phonePrimary: '1', addressPrimary: 'Rua A', addressSecondary: 'Rua B', business: 'Negocio sintético' });
  const cond = (o: Body = {}) => ({ amountMinor: 20_000, interestRate: 20, installmentsCount: 10, frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6], ...o });
  const pg = (who: { identityId: string; membershipId: string }, company: string, sql: string, params: unknown[]) =>
    asApi(db.api, { ...who, companyId: company }, async (q) => q.query(sql, params).then(() => 'ok', (e: { code?: string }) => e.code));
  const ledgerOk = async (who: Caller = bruno) => {
    const r = await who('GET', '/v1/capital/reconciliation');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const checks = r.body['checks'] as Body[];
    assert.deepEqual(checks.filter((c) => !c['ok']), [], 'conciliación limpia');
    assert.ok(checks.some((c) => c['name'] === 'differences-match-conciliations'), 'incluye la comprobación de conciliaciones');
  };
  const differences = async (who: Caller, route?: string, status = 'pending') => {
    const r = await who('GET', `/v1/capital/differences?status=${status}${route ? `&routeId=${route}` : ''}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body as { items: Body[]; summary: Body };
  };
  const settle = async (who: Money, caller_: Caller, route: string, worker: string, delta: number, reason = 'Diferencia contada en el cuadre') => {
    const p = (await caller_('GET', `/v1/settlements/preview?routeId=${route}&workerId=${worker}`)).body;
    const expected = Number(p['expectedPositionMinor']);
    const r = await who('/v1/settlements', { routeId: route, workerId: worker, deliveredMinor: Math.max(0, expected) + delta, expectedSeenMinor: expected,
      previousSettlementId: p['previousSettlementId'] ?? null, ...(delta !== 0 ? { reason } : {}) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body['settlement'] as Body;
  };
  const resolve = (who: Money, body: Body, opId?: string) => who('/v1/capital/differences/resolve', { reason: 'Conciliación revisada por el Administrador', ...body }, opId);
  const general = (who: Money, body: Body, opId?: string) =>
    who('/v1/expenses', { categoryId: cat, description: 'Gasto general sintético', ...body }, opId);
  const panelRoute = async (who: Caller, route: string) => {
    const r = await who('GET', `/v1/capital/route-panel?from=${today}&to=${today}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { route: (r.body['routes'] as Body[]).find((x) => x['routeId'] === route)!, totals: r.body['totals'] as Body };
  };

  before(async () => {
    db = await createTestDb('r74_admin_authority', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    carla = caller(api, issuer, 'carla', M.carlaSa); $carla = money(carla);
    hugo = caller(api, issuer, 'hugo', M.hugoAdmin); $hugo = money(hugo);
    gabi = caller(api, issuer, 'gabi', M.gabiSec);
    diego = caller(api, issuer, 'diego', M.diegoSa);
    today = (await db.admin.query(`select adex.business_today($1)::text d`, [c1])).rows[0].d;
    todayC2 = (await db.admin.query(`select adex.business_today($1)::text d`, [c2])).rows[0].d;
    cat = (await db.admin.query(`select id from adex.expense_categories where company_id = $1 and active order by id limit 1`, [c1])).rows[0].id;
    catC2 = (await db.admin.query(`select id from adex.expense_categories where company_id = $1 and active order by id limit 1`, [c2])).rows[0].id;
    carlos = await newPerson(api, issuer, provider.ids, bruno, { email: 'carlos-aa@example.test', role: 'cobrador', displayName: 'Carlos', routeIds: [r1] });
    dora = await newPerson(api, issuer, provider.ids, bruno, { email: 'dora-aa@example.test', role: 'supervisor', displayName: 'Dora', routeIds: [r1] });
    edu = await newPerson(api, issuer, provider.ids, bruno, { email: 'edu-aa@example.test', role: 'admin', displayName: 'Edu', routeIds: [r3] });
    fede = await newPerson(api, issuer, provider.ids, bruno, { email: 'fede-aa@example.test', role: 'admin', displayName: 'Fede', routeIds: [r2] });
    const of2 = (await db.admin.query(`select id from adex.offices where company_id = $1 and code = 'OF-2'`, [c1])).rows[0].id as string;
    assert.equal((await bruno('POST', `/v1/offices/${of2}/status`, { status: 'activa' })).status, 200);
    assert.equal((await bruno('POST', `/v1/routes/${r3}/status`, { status: 'activa' })).status, 200);
    const ctrl = async (r: string) => (await db.admin.query('select capital_controller_membership_id c from adex.routes where id = $1', [r])).rows[0].c;
    for (const [r, m] of [[r1, M.anaAdmin], [r2, M.anaAdmin], [r3, edu.membershipId]] as const) {
      if ((await ctrl(r)) !== m) assert.equal((await bruno('PUT', `/v1/routes/${r}/capital-controller`, { membershipId: m, reason: 'Responsable inicial' })).status, 200);
    }
    // Historia con bolsas (admin_pool).
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético autoridad' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 2_000_000, reason: 'Bolsa de Ana' }],
    ] as const) assert.equal((await $bruno(path, body)).status, 201, path);
    // c2 (admin_pool, se queda así): capital para Hugo y Base para Elisa.
    assert.equal((await $carla('/v1/capital/company/deposits', { amountMinor: 1_000_000, reason: 'Capital c2' })).status, 201);
    assert.equal((await $carla('/v1/capital/allocations', { adminId: M.hugoAdmin, amountMinor: 500_000, reason: 'Bolsa de Hugo' })).status, 201);
    assert.equal((await $hugo('/v1/capital/deliveries', { routeId: c2r1, workerId: M.elisaCob, amountMinor: 50_000, reason: 'Base de Elisa' })).status, 201);
  });
  after(async () => { await api?.close(); await db?.close(); });

  test('AA-001 · esquema 0036: cuenta route_difference, operación DIFFERENCE_CONCILIATION, tabla inmutable, disparadores y feature', async () => {
    const fns = ['difference_resolve', 'difference_preview', 'route_differences', 'route_difference_summary', 'admin_pending_accounts', 'require_controls_all_routes'];
    assert.equal(await count(`select count(*) n from pg_proc where proname = any($1)`, [fns]), fns.length);
    assert.equal(await count(`select count(*) n from pg_trigger where tgname in ('memberships_admin_deactivation_guard', 'routes_controller_change_guard')`, []), 2);
    // Inmutable: ni el propietario del esquema borra una conciliación.
    await assert.rejects(db.admin.query('truncate adex.difference_conciliations'), /./);
  });

  test('AA-002 · RB-D9 (1/2) y RB-D8 en admin_pool: gasto con dinero propio y autorreembolso parcial desde la bolsa propia', async () => {
    const e = await general($ana, { scope: 'administrador', fundingSource: 'own_money', amountMinor: 10_000, description: 'Equipo pagado por Ana' });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    assert.equal(await payable(M.anaAdmin), -10_000);
    const p0 = await pool(M.anaAdmin);
    const r = await $ana('/v1/capital/reimbursements', { adminId: M.anaAdmin, amountMinor: 4_000, reason: 'Reembolso parcial desde mi bolsa' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([(r.body['reimbursement'] as Body)['source'], r.body['pendingAfterMinor']], ['admin_pool', 6_000]);
    assert.equal(await pool(M.anaAdmin), p0 - 4_000);
    assert.equal(await payable(M.anaAdmin), -6_000);
  });

  test('AA-003 · RB-D2/RB-D6/C-13: empresa en cero (la nota ya no exime); con saldos, primero migrating; posiciones intactas', async () => {
    const pre = await bruno('GET', '/v1/capital/model/prerequisites');
    const company = pre.body['checks'] as Body[];
    assert.equal(company.find((c) => c['name'] === 'company-account-zero')!['documentable'], undefined, 'sin la opción «documentar con nota»');
    expectCode(await $bruno('/v1/capital/model', { target: 'route_base', evidence: 'Intento con nota del saldo de empresa', backupReference: 'bk-aa-1',
      companyBalanceNote: 'El saldo de empresa queda documentado aparte' }), 409, 'ACTIVATION_PREREQUISITES_FAILED', 'RB-D2: la nota no exime');
    const avail = await balance(db.admin, c1, 'company', null);
    assert.equal((await $bruno('/v1/capital/company/withdrawals', { amountMinor: avail, reason: 'Empresa a cero antes del corte' })).status, 201);
    const direct = await bruno('GET', '/v1/capital/model/prerequisites');
    assert.deepEqual((direct.body['checks'] as Body[]).filter((c) => !c['ok']).map((c) => c['name']), ['direct-activation-or-migrating']);
    expectCode(await $bruno('/v1/capital/model', { target: 'route_base', evidence: 'Activación directa con saldos que repartir', backupReference: 'bk-aa-2' }),
      409, 'ACTIVATION_PREREQUISITES_FAILED', 'RB-D6: con saldos, migrating');
    const snap = async () => (await db.admin.query(`select id, balance_minor::text b, carried_minor::text c from adex.capital_accounts where company_id = $1 order by id`, [c1])).rows;
    const before0 = await snap();
    assert.equal((await $bruno('/v1/capital/model', { target: 'migrating', evidence: 'Congelamos bolsas para el corte de autoridad' })).status, 200);
    // RB-D9: durante la migración no se paga la obligación por ninguna vía (nunca dos veces entre modelos).
    expectCode(await $ana('/v1/capital/reimbursements', { adminId: M.anaAdmin, amountMinor: 1_000, reason: 'Durante la migración' }), 409, 'CAPITAL_MIGRATION_IN_PROGRESS', 'reembolso en migrating');
    const act = await $bruno('/v1/capital/model', { target: 'route_base', evidence: 'Corte autorizado para la prueba de autoridad', backupReference: 'bk-aa-3' });
    assert.equal(act.status, 200, JSON.stringify(act.body));
    assert.deepEqual(await snap(), before0, 'C-13: la transición no mueve ningún saldo (sin ingresos ficticios)');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    // RB-D6: una empresa sin saldos (c3) puede activarse directamente (con todas las demás validaciones).
    const c3pre = await diego('GET', '/v1/capital/model/prerequisites');
    assert.equal(c3pre.status, 200, JSON.stringify(c3pre.body));
    assert.equal((c3pre.body['checks'] as Body[]).find((c) => c['name'] === 'direct-activation-or-migrating')!['ok'], true, JSON.stringify(c3pre.body));
  });

  test('AA-004 · Bases y RB-D9 (2/2): el resto de la obligación con aportes de rutas; nunca supera lo pendiente; reintentos y concurrencia', async () => {
    for (const [who, r, amt] of [[$ana, r1, 300_000], [$ana, r2, 100_000], [edu.money, r3, 80_000]] as const) {
      assert.equal((await who('/v1/capital/route-base/injections', { routeId: r, amountMinor: amt, reason: 'Base inicial sintética' })).status, 201);
    }
    expectCode(await $ana('/v1/capital/reimbursements', { adminId: M.anaAdmin, contributions: [{ routeId: r1, amountMinor: 7_000 }], reason: 'Más de lo pendiente' }),
      409, 'REIMBURSEMENT_EXCEEDS_PENDING', 'supera lo pendiente');
    const opId = randomUUID();
    const body = { adminId: M.anaAdmin, contributions: [{ routeId: r1, amountMinor: 4_000 }, { routeId: r2, amountMinor: 2_000 }], reason: 'Resto del reembolso (autorreembolso RB-D8)' };
    const [b1, b2] = [await base(r1), await base(r2)];
    const r = await $ana('/v1/capital/reimbursements', body, opId);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const again = await $ana('/v1/capital/reimbursements', body, opId);
    assert.deepEqual(again.body, r.body, 'reintento idempotente');
    assert.deepEqual([await base(r1), await base(r2), await payable(M.anaAdmin)], [b1 - 4_000, b2 - 2_000, 0], 'total reembolsado = obligación (4 000 + 6 000)');
    assert.equal(await count(`select coalesce(sum(amount_minor), 0) n from adex.admin_reimbursements where company_id = $1 and admin_membership_id = $2 and reversed_at is null`,
      [c1, M.anaAdmin]), 10_000, 'nunca más que el gasto con dinero propio');
    expectCode(await $ana('/v1/capital/reimbursements', { adminId: M.anaAdmin, contributions: [{ routeId: r1, amountMinor: 1 }], reason: 'Nada pendiente' }),
      409, 'REIMBURSEMENT_EXCEEDS_PENDING', 'obligación saldada');
    // Concurrencia: dos reembolsos simultáneos que juntos superan lo pendiente → exactamente uno.
    assert.equal((await general($ana, { scope: 'administrador', fundingSource: 'own_money', amountMinor: 5_000, description: 'Segundo gasto propio' })).status, 201);
    const res = await parallel(2, () => $ana('/v1/capital/reimbursements', { adminId: M.anaAdmin, contributions: [{ routeId: r1, amountMinor: 5_000 }], reason: 'Doble reembolso simultáneo' }));
    assert.deepEqual(res.map((x) => x.status).sort(), [201, 409], JSON.stringify(res.map((x) => x.body)));
    assert.equal(await payable(M.anaAdmin), 0);
    // RB-D7 (preparación): gasto conjunto r1+r2, gasto de una ruta (r2) y autorreembolso pagado por r2.
    const j = await general($ana, { scope: 'administrador', fundingSource: 'routes', amountMinor: 5_000,
      contributions: [{ routeId: r1, amountMinor: 3_000 }, { routeId: r2, amountMinor: 2_000 }], description: 'Gasto conjunto r1 y r2' });
    assert.equal(j.status, 201, JSON.stringify(j.body));
    jointExpense = (j.body['expense'] as Body)['id'] as string;
    const s = await general($ana, { scope: 'administrador', fundingSource: 'routes', amountMinor: 1_500, contributions: [{ routeId: r2, amountMinor: 1_500 }], description: 'Gasto de r2' });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    singleExpenseR2 = (s.body['expense'] as Body)['id'] as string;
    assert.equal((await general($ana, { scope: 'administrador', fundingSource: 'own_money', amountMinor: 2_500, description: 'Tercer gasto propio' })).status, 201);
    const rr = await $ana('/v1/capital/reimbursements', { adminId: M.anaAdmin, contributions: [{ routeId: r2, amountMinor: 2_500 }], reason: 'Autorreembolso desde r2' });
    assert.equal(rr.status, 201, JSON.stringify(rr.body));
    selfReimbR2 = (rr.body['reimbursement'] as Body)['id'] as string;
    // Visible para el SuperAdmin (supervisión, RB-D8).
    assert.ok(((await bruno('GET', '/v1/capital/reimbursements')).body['reimbursements'] as Body[]).some((x) => x['id'] === selfReimbR2));
    await ledgerOk();
  });

  test('AA-005 · RB-D3 faltante de cuadre: pendiente → «el trabajador repone» (sin movimiento) → «faltante de la ruta»; C-03/C-04/C-09', async () => {
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 50_000, reason: 'Base de Carlos' })).status, 201);
    const s = await settle($ana, ana, r1, carlos.membershipId, -3_000, 'Faltan 3 000 en el conteo del cuadre');
    shortageSettlement = s['id'] as string;
    assert.equal(await carried(carlos.membershipId), 3_000);
    let d = await differences(ana, r1);
    const item = d.items.find((i) => i['sourceKind'] === 'settlement_shortage')!;
    assert.deepEqual([item['sourceId'], item['pendingMinor'], item['differenceMinor'], item['workerId'], item['allowedResolutions']],
      [shortageSettlement, 3_000, -3_000, carlos.membershipId, ['route_shortage', 'worker_owes']]);
    assert.equal(d.summary['pendingCount'], 1);
    // Vista previa: patas y quién puede resolver.
    const pv = await ana('GET', `/v1/capital/differences/preview?sourceKind=settlement_shortage&sourceId=${shortageSettlement}&resolution=route_shortage`);
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    assert.deepEqual([pv.body['canResolve'], pv.body['amountMinor'], (pv.body['legs'] as Body[]).map((l) => [l['kind'], l['sign']])],
      [true, 3_000, [['custody', -1], ['route_difference', 1]]]);
    const pvSa = await bruno('GET', `/v1/capital/differences/preview?sourceKind=settlement_shortage&sourceId=${shortageSettlement}&resolution=worker_owes`);
    assert.deepEqual([pvSa.status, pvSa.body['canResolve']], [200, false]);
    assert.ok((pvSa.body['blockers'] as string[]).includes('ONLY_ADMINISTRATOR'), 'C-11: el SuperAdmin ve, no concilia');
    // Ni el SuperAdmin, ni el Supervisor, ni el Cobrador concilian (API y PostgreSQL).
    const ops0 = await opCount();
    expectCode(await resolve($bruno, { sourceKind: 'settlement_shortage', sourceId: shortageSettlement, resolution: 'route_shortage', amountMinor: 3_000 }),
      403, 'CAPITAL_AUTHORITY_REQUIRED', 'SuperAdmin');
    expectCode(await resolve(dora.money, { sourceKind: 'settlement_shortage', sourceId: shortageSettlement, resolution: 'route_shortage', amountMinor: 3_000 }),
      403, 'CAPITAL_AUTHORITY_REQUIRED', 'Supervisor');
    expectCode(await resolve(carlos.money, { sourceKind: 'settlement_shortage', sourceId: shortageSettlement, resolution: 'worker_owes', amountMinor: 3_000 }),
      403, 'CAPITAL_AUTHORITY_REQUIRED', 'Cobrador');
    assert.equal(await pg({ identityId: identityOf('bruno'), membershipId: M.brunoSa }, c1,
      `select adex.difference_resolve($1, 'settlement_shortage', $2, 'route_shortage', 3000, 'SuperAdmin por SQL directo')`, [randomUUID(), shortageSettlement]), 'AX402');
    expectCode(await resolve($ana, { sourceKind: 'settlement_shortage', sourceId: shortageSettlement, resolution: 'route_shortage', amountMinor: 2_999 }),
      409, 'DIFFERENCE_AMOUNT_MISMATCH', 'importe distinto');
    expectCode(await resolve($ana, { sourceKind: 'settlement_shortage', sourceId: shortageSettlement, resolution: 'route_shortage', amountMinor: 3_000, reason: 'corto' }),
      400, 'REASON_REQUIRED', 'motivo corto');
    expectCode(await resolve($ana, { sourceKind: 'settlement_shortage', sourceId: shortageSettlement, resolution: 'surplus_to_base', amountMinor: 3_000 }),
      409, 'RESOLUTION_NOT_ALLOWED', 'resolución de sobrante sobre un faltante');
    assert.equal(await opCount(), ops0, 'nada se escribió');
    // «El trabajador repone»: SOLO si el Administrador lo elige; sin movimiento; queda como faltante pendiente del trabajador.
    const wo = await resolve($ana, { sourceKind: 'settlement_shortage', sourceId: shortageSettlement, resolution: 'worker_owes', amountMinor: 3_000,
      reason: 'Carlos repone el faltante en el próximo cuadre' });
    assert.equal(wo.status, 201, JSON.stringify(wo.body));
    assert.deepEqual([(wo.body['conciliation'] as Body)['movesMoney'], (wo.body['entries'] as Body[]).length], [false, 0]);
    assert.equal(await opCount(), ops0, 'sin movimientos');
    assert.equal(await carried(carlos.membershipId), 3_000);
    d = await differences(ana, r1, 'all');
    const owed = d.items.find((i) => i['sourceKind'] === 'settlement_shortage')!;
    assert.deepEqual([owed['pending'], owed['pendingMinor'], owed['workerOwedMinor'], owed['allowedResolutions']], [false, 0, 3_000, ['route_shortage']]);
    assert.equal((await differences(ana, r1)).summary['pendingCount'], 0, 'C-04: ya no está pendiente');
    // Luego el Administrador lo reconoce como faltante de la ruta (convierte lo decidido): custodia −3 000, faltante conciliado +3 000.
    const opId = randomUUID();
    const body = { sourceKind: 'settlement_shortage', sourceId: shortageSettlement, resolution: 'route_shortage', amountMinor: 3_000, reason: 'Carlos no pudo reponer: lo asume la ruta' };
    const c0 = await custody(carlos.membershipId);
    const rs = await resolve($ana, body, opId);
    assert.equal(rs.status, 201, JSON.stringify(rs.body));
    const conc = rs.body['conciliation'] as Body;
    assert.deepEqual([conc['resolution'], conc['amountMinor'], conc['carriedAfterMinor'], conc['expectedMinor'] !== null, conc['actorId']],
      ['route_shortage', 3_000, 0, true, M.anaAdmin]);
    assert.deepEqual((await legs(conc['ledgerOperationId'] as string)).map((l) => [l.kind, l.route_id, l.amount]),
      [['custody', r1, -3_000], ['route_difference', r1, 3_000]], 'C-06: todas las patas en la ruta de la diferencia');
    assert.deepEqual([await custody(carlos.membershipId), await carried(carlos.membershipId), await diffAcc(r1)], [c0 - 3_000, 0, 3_000]);
    // Reintento con el mismo id: misma respuesta y nada nuevo (API); en PostgreSQL, AX409.
    const again = await resolve($ana, body, opId);
    assert.deepEqual([again.status, again.body], [201, rs.body]);
    assert.equal(await pg({ identityId: identityOf('ana'), membershipId: M.anaAdmin }, c1,
      `select adex.difference_resolve($1, 'settlement_shortage', $2, 'route_shortage', 3000, 'Reintento por SQL directo')`, [opId, shortageSettlement]), 'AX409');
    expectCode(await resolve($ana, { ...body, amountMinor: 3_000 }), 409, 'DIFFERENCE_NOT_PENDING', 'ya conciliada');
    assert.equal((await differences(ana, r1, 'all')).items.filter((i) => i['sourceKind'] === 'settlement_shortage').length, 0);
    // El cuadre conciliado no se reabre; el cierre del periodo clasifica la operación (sin «movimientos sin clasificar»).
    expectCode(await $ana(`/v1/settlements/${shortageSettlement}/reopen`, { reason: 'Reabrir tras conciliar no se permite' }), 409, 'SETTLEMENT_NOT_REOPENABLE', 'reabrir');
    const fig = (await db.admin.query(`select adex.route_period_figures($1, $2, $3::date, $3::date) f`, [c1, r1, today])).rows[0].f;
    assert.deepEqual([fig.custody.otherMinor, fig.custody.conciliatedShortagesMinor], [0, 3_000], 'C-04: el cierre de periodo no queda bloqueado');
    // La ruta sigue: un cuadre posterior exacto funciona.
    await settle($ana, ana, r1, carlos.membershipId, 0);
    const pr = await panelRoute(ana, r1);
    const dif = pr.route['differences'] as Body;
    assert.deepEqual([dif['pendingCount'], dif['conciliatedShortageMinor'], dif['workerOwesDecidedMinor'], dif['conciliatedNetMinor'], dif['isCash']],
      [0, 3_000, 3_000, 3_000, false]);
    assert.ok(!(pr.route['alerts'] as string[]).includes('PENDING_DIFFERENCES'));
    assert.ok(!(pr.route['alerts'] as string[]).includes('CARRIED_SHORTAGE'));
    assert.equal(pr.route['cashMinor'], Number(pr.route['baseMinor']) + Number((pr.route['custody'] as Body)['grossMinor']), 'el faltante conciliado no es efectivo');
    await ledgerOk();
  });

  test('AA-006 · RB-D3 sobrante de cuadre: incorporar a la Base (dos resoluciones simultáneas → una) y devolver a su dueño', async () => {
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 10_000, reason: 'Base de Carlos 2' })).status, 201);
    const s = await settle($ana, ana, r1, carlos.membershipId, 2_000, 'Sobran 2 000 en el conteo del cuadre');
    const item = (await differences(ana, r1)).items.find((i) => i['sourceId'] === s['id'])!;
    assert.deepEqual([item['sourceKind'], item['kind'], item['pendingMinor'], item['holderId'], item['allowedResolutions']],
      ['settlement_surplus', 'sobrante', 2_000, M.anaAdmin, ['surplus_to_base', 'surplus_returned']]);
    const b0 = await base(r1);
    const res = await parallel(2, () => resolve($ana, { sourceKind: 'settlement_surplus', sourceId: s['id'], resolution: 'surplus_to_base', amountMinor: 2_000,
      reason: 'Sobrante del cuadre incorporado a la Base' }));
    assert.deepEqual(res.map((x) => x.status).sort(), [201, 409], JSON.stringify(res.map((x) => x.body)));
    assert.ok(res.some((x) => x.body['error'] === 'DIFFERENCE_NOT_PENDING'));
    const ok = res.find((x) => x.status === 201)!;
    assert.deepEqual((await legs((ok.body['conciliation'] as Body)['ledgerOperationId'] as string)).map((l) => [l.kind, l.route_id, l.amount]),
      [['suspense', r1, -2_000], ['route_base', r1, 2_000], ['unidentified', r1, 2_000], ['route_difference', r1, -2_000]]);
    assert.deepEqual([await base(r1), await balance(db.admin, c1, 'suspense', M.anaAdmin, r1), await diffAcc(r1)], [b0 + 2_000, 0, 1_000]);
    // Otro sobrante: devuelto a su dueño (sale del control, no es ingreso ni entra a la Base).
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 5_000, reason: 'Base de Carlos 3' })).status, 201);
    const s2 = await settle($ana, ana, r1, carlos.membershipId, 1_000, 'Sobran 1 000: dinero propio de Carlos');
    const b1 = await base(r1);
    const ret = await resolve($ana, { sourceKind: 'settlement_surplus', sourceId: s2['id'], resolution: 'surplus_returned', amountMinor: 1_000,
      reason: 'Era dinero propio de Carlos: se le devuelve' });
    assert.equal(ret.status, 201, JSON.stringify(ret.body));
    assert.deepEqual([await base(r1), await balance(db.admin, c1, 'suspense', M.anaAdmin, r1), await balance(db.admin, c1, 'unidentified', null, r1), await diffAcc(r1)],
      [b1, 0, 0, 1_000]);
    const hist = await ana('GET', `/v1/capital/conciliations?routeId=${r1}`);
    assert.deepEqual((hist.body['conciliations'] as Body[]).map((c) => c['resolution']), ['surplus_returned', 'surplus_to_base', 'route_shortage', 'worker_owes']);
    await ledgerOk();
  });

  test('AA-007 · RB-D3 actas de entrega: faltante reconocido por el nuevo responsable; la ruta continúa; el anterior ya no concilia', async () => {
    const ch = await bruno('PUT', `/v1/routes/${r2}/capital-controller`, { membershipId: fede.membershipId, reason: 'Fede asume r2' });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    const b = await base(r2);
    const ok = await fede.money(`/v1/capital/handovers/${r2}/confirm`, { countedMinor: b - 700, expectedSeenMinor: b, note: 'Faltan 700 en el conteo físico de la Base' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const h = (await differences(fede.call, r2)).items.find((i) => i['sourceKind'] === 'handover')!;
    assert.deepEqual([h['expectedMinor'], h['countedMinor'], h['differenceMinor'], h['pendingMinor'], h['allowedResolutions']], [b, b - 700, -700, 700, ['route_shortage']]);
    assert.ok(((await panelRoute(fede.call, r2)).route['alerts'] as string[]).includes('HANDOVER_DIFFERENCE'));
    // Ana (responsable anterior) ya no concilia r2; Fede sí, sin aprobación superior.
    expectCode(await resolve($ana, { sourceKind: 'handover', sourceId: h['sourceId'], resolution: 'route_shortage', amountMinor: 700 }), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'responsable anterior');
    const r = await resolve(fede.money, { sourceKind: 'handover', sourceId: h['sourceId'], resolution: 'route_shortage', amountMinor: 700,
      reason: 'Faltante de la entrega asumido por la ruta' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([await base(r2), await diffAcc(r2)], [b - 700, 700]);
    const pr = await panelRoute(fede.call, r2);
    assert.ok(!(pr.route['alerts'] as string[]).includes('HANDOVER_DIFFERENCE'), 'C-04: conciliada, sin alerta');
    assert.equal((await fede.money('/v1/capital/route-base/injections', { routeId: r2, amountMinor: 1_000, reason: 'La ruta sigue operando' })).status, 201);
    await ledgerOk();
  });

  test('AA-008 · C-10: empresa ajena, ruta ajena y responsable no válido (API y PostgreSQL); el responsable vigente solo lo cambia el SuperAdmin', async () => {
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 4_000, reason: 'Base de Carlos 4' })).status, 201);
    const s = await settle($ana, ana, r1, carlos.membershipId, -400, 'Faltan 400 en el conteo del cuadre');
    const body = { sourceKind: 'settlement_shortage', sourceId: s['id'], resolution: 'route_shortage', amountMinor: 400 };
    // Otra empresa: invisible (404) y, por SQL, AX412.
    assert.equal((await hugo('GET', `/v1/capital/differences/preview?sourceKind=settlement_shortage&sourceId=${s['id']}`)).status, 404);
    expectCode(await resolve($hugo, body), 404, 'NOT_FOUND', 'Administrador de c2');
    assert.equal(await pg({ identityId: identityOf('hugo'), membershipId: M.hugoAdmin }, c2,
      `select adex.difference_resolve($1, 'settlement_shortage', $2, 'route_shortage', 400, 'Empresa ajena por SQL directo')`, [randomUUID(), s['id']]), 'AX412');
    // Ruta fuera del alcance (Edu: solo r3) y ruta en el alcance pero de otro responsable.
    expectCode(await resolve(edu.money, body), 404, 'NOT_FOUND', 'ruta ajena');
    assert.equal((await bruno('PUT', `/v1/members/${edu.membershipId}/routes`, { routeIds: [r1, r3] })).status, 200);
    const eduCtx = { identityId: edu.identityId, membershipId: edu.membershipId };
    expectCode(await resolve(edu.money, body), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'no es el responsable de r1');
    assert.equal(await pg(eduCtx, c1, `select adex.difference_resolve($1, 'settlement_shortage', $2, 'route_shortage', 400, 'No responsable por SQL directo')`,
      [randomUUID(), s['id']]), 'AX402');
    // Hacerse responsable de una ruta ajena (aunque esté en su alcance): ni por la API ni por SQL directo.
    assert.equal((await edu.call('PUT', `/v1/routes/${r1}/capital-controller`, { membershipId: edu.membershipId, reason: 'Me hago responsable' })).status, 403);
    assert.equal(await pg(eduCtx, c1, 'update adex.routes set capital_controller_membership_id = $1 where id = $2', [edu.membershipId, r1]), 'AX402');
    assert.equal((await db.admin.query('select capital_controller_membership_id c from adex.routes where id = $1', [r1])).rows[0].c, M.anaAdmin);
    assert.equal((await bruno('PUT', `/v1/members/${edu.membershipId}/routes`, { routeIds: [r3] })).status, 200);
    // La responsable la concilia.
    assert.equal((await resolve($ana, { ...body, reason: 'Faltante pequeño asumido por la ruta' })).status, 201);
  });

  test('AA-009 · RB-D7: corrección por el responsable VIGENTE; operación conjunta con responsables distintos → rechazo explicado; nunca parcial', async () => {
    const [b1, b2] = [await base(r1), await base(r2)];
    // Conjunto r1 (Ana) + r2 (Fede): nadie lo anula mientras sean de distintos responsables.
    for (const who of [$ana, fede.money]) {
      const r = await who(`/v1/expenses/${jointExpense}/reverse`, { reason: 'Gasto conjunto registrado por error' });
      assert.deepEqual([r.status, r.body['error']], [409, 'JOINT_OPERATION_MIXED_CONTROLLERS'], JSON.stringify(r.body));
      const routes = ((r.body['details'] as Body | undefined)?.['routes'] ?? []) as Body[];
      assert.ok(routes.length > 0, JSON.stringify(r.body));
      assert.deepEqual(routes.map((x) => [x['routeId'], x['controllerId']]).sort(), [[r1, M.anaAdmin], [r2, fede.membershipId]].sort());
    }
    assert.equal(await pg({ identityId: identityOf('ana'), membershipId: M.anaAdmin }, c1, `select adex.expense_reverse($1, $2, 'Conjunto por SQL directo')`,
      [randomUUID(), jointExpense]), 'AX434');
    assert.deepEqual([await base(r1), await base(r2)], [b1, b2], 'sin anulación parcial');
    // Gasto de UNA ruta (r2) registrado por Ana: lo anula Fede (responsable vigente), no Ana.
    expectCode(await $ana(`/v1/expenses/${singleExpenseR2}/reverse`, { reason: 'Ya no soy la responsable' }), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'responsable anterior');
    const rv = await fede.money(`/v1/expenses/${singleExpenseR2}/reverse`, { reason: 'Gasto de r2 duplicado' });
    assert.equal(rv.status, 201, JSON.stringify(rv.body));
    assert.equal(await base(r2), b2 + 1_500, 'el dinero vuelve a la Base de r2');
    // Reembolso pagado por r2: lo anula Fede; la obligación con Ana vuelve a quedar pendiente (2 500).
    expectCode(await $ana(`/v1/capital/reimbursements/${selfReimbR2}/reverse`, { reason: 'Ya no soy la responsable' }), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'pagadora anterior');
    const rr = await fede.money(`/v1/capital/reimbursements/${selfReimbR2}/reverse`, { reason: 'Reembolso pagado por error desde r2' });
    assert.equal(rr.status, 201, JSON.stringify(rr.body));
    assert.deepEqual([await base(r2), await payable(M.anaAdmin)], [b2 + 1_500 + 2_500, -2_500]);
    // AX432 se conserva: no se anula un gasto propio ya reembolsado como si el reembolso no existiera.
    const own = (await db.admin.query(`select id from adex.expenses where company_id = $1 and funding = 'own_money' and responsible_admin_membership_id = $2
      and reversal_id is null and reverses_id is null and amount_minor = 10000`, [c1, M.anaAdmin])).rows[0].id;
    expectCode(await $ana(`/v1/expenses/${own}/reverse`, { reason: 'Gasto propio ya reembolsado' }), 409, 'PAYABLE_ALREADY_REIMBURSED', 'AX432');
    await ledgerOk();
  });

  test('AA-010 · acta con sobrante incorporado a la Base; con ambas rutas de nuevo bajo Ana, el gasto conjunto se anula completo', async () => {
    assert.equal((await bruno('PUT', `/v1/routes/${r2}/capital-controller`, { membershipId: M.anaAdmin, reason: 'Ana retoma r2' })).status, 200);
    const b = await base(r2);
    assert.equal((await $ana(`/v1/capital/handovers/${r2}/confirm`, { countedMinor: b + 300, expectedSeenMinor: b, note: 'Sobran 300 en el conteo de la entrega' })).status, 200);
    const h = (await differences(ana, r2)).items.find((i) => i['sourceKind'] === 'handover')!;
    assert.deepEqual([h['kind'], h['allowedResolutions']], ['sobrante', ['surplus_to_base', 'surplus_returned']]);
    const r = await resolve($ana, { sourceKind: 'handover', sourceId: h['sourceId'], resolution: 'surplus_to_base', amountMinor: 300, reason: 'Sobrante de la entrega a la Base' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([await base(r2), await diffAcc(r2)], [b + 300, 400]);
    const [b1, b2] = [await base(r1), await base(r2)];
    const rv = await $ana(`/v1/expenses/${jointExpense}/reverse`, { reason: 'Gasto conjunto registrado por error' });
    assert.equal(rv.status, 201, JSON.stringify(rv.body));
    assert.deepEqual([await base(r1), await base(r2)], [b1 + 3_000, b2 + 2_000], 'cada aporte vuelve a su ruta');
    await ledgerOk();
  });

  test('AA-011 · RB-D1: Administradores con cuentas pendientes no se desactivan (API + disparador); tras saldar y entregar, sí', async () => {
    // Ana: rutas a su cargo, saldo «sin asignar» y reembolso pendiente.
    const chk = await bruno('GET', `/v1/members/${M.anaAdmin}/deactivation-check`);
    assert.equal(chk.status, 200, JSON.stringify(chk.body));
    const codes = (chk.body['blockers'] as Body[]).map((b) => b['code']);
    for (const c of ['CAPITAL_CONTROLLER', 'ADMIN_POOL_BALANCE', 'PENDING_REIMBURSEMENT']) assert.ok(codes.includes(c), `${c} en ${JSON.stringify(codes)}`);
    assert.equal(chk.body['canDeactivate'], false);
    assert.ok((chk.body['blockers'] as Body[]).every((b) => typeof b['message'] === 'string' && (b['message'] as string).length > 10), 'textos en español');
    const off = await bruno('POST', `/v1/members/${M.anaAdmin}/deactivate`, {});
    assert.deepEqual([off.status, off.body['error']], [409, 'ADMIN_HAS_PENDING_ACCOUNTS']);
    assert.ok(((off.body['details'] as Body)['blockers'] as Body[]).length >= 3);
    assert.equal((await ana('GET', `/v1/members/${M.anaAdmin}/deactivation-check`)).status, 200, 'el propio Administrador ve su diagnóstico');
    assert.equal((await ana('GET', `/v1/members/${fede.membershipId}/deactivation-check`)).status, 403, 'no el de otro');
    // Fede: sin rutas a su cargo, pero con un reembolso pendiente.
    assert.equal((await general(fede.money, { scope: 'administrador', fundingSource: 'own_money', amountMinor: 1_000, description: 'Taxi pagado por Fede' })).status, 201);
    let f = await bruno('GET', `/v1/members/${fede.membershipId}/deactivation-check`);
    assert.deepEqual((f.body['blockers'] as Body[]).map((b) => [b['code'], b['amountMinor']]), [['PENDING_REIMBURSEMENT', 1_000]]);
    expectCode(await bruno('POST', `/v1/members/${fede.membershipId}/deactivate`, {}), 409, 'ADMIN_HAS_PENDING_ACCOUNTS', 'Fede con reembolso pendiente');
    // Barrera final: ni por SQL directo (disparador AX433).
    await assert.rejects(db.admin.query(`update adex.memberships set status = 'inactivo' where id = $1`, [fede.membershipId]), (e: { code?: string }) => e.code === 'AX433');
    // Se salda: Ana le reembolsa desde r1 → ya puede desactivarse.
    assert.equal((await $ana('/v1/capital/reimbursements', { adminId: fede.membershipId, contributions: [{ routeId: r1, amountMinor: 1_000 }], reason: 'Reembolso a Fede' })).status, 201);
    f = await bruno('GET', `/v1/members/${fede.membershipId}/deactivation-check`);
    assert.deepEqual([f.body['blockers'], f.body['canDeactivate']], [[], true]);
    assert.equal((await bruno('POST', `/v1/members/${fede.membershipId}/deactivate`, {})).status, 200);
    // Edu: entrega estructural de r3 a Ana; mientras el acta esté pendiente, no; tras el conteo, sí.
    assert.equal((await bruno('PUT', `/v1/members/${M.anaAdmin}/routes`, { routeIds: [r1, r2, r3] })).status, 200);
    assert.equal((await bruno('PUT', `/v1/routes/${r3}/capital-controller`, { membershipId: M.anaAdmin, reason: 'Edu entrega r3 a Ana' })).status, 200);
    let e = await bruno('GET', `/v1/members/${edu.membershipId}/deactivation-check`);
    assert.deepEqual((e.body['blockers'] as Body[]).map((b) => b['code']), ['PENDING_HANDOVER']);
    expectCode(await bruno('POST', `/v1/members/${edu.membershipId}/deactivate`, {}), 409, 'ADMIN_HAS_PENDING_ACCOUNTS', 'acta pendiente');
    const b3 = await base(r3);
    assert.equal((await $ana(`/v1/capital/handovers/${r3}/confirm`, { countedMinor: b3, expectedSeenMinor: b3 })).status, 200);
    e = await bruno('GET', `/v1/members/${edu.membershipId}/deactivation-check`);
    assert.equal(e.body['canDeactivate'], true, JSON.stringify(e.body));
    assert.equal((await bruno('POST', `/v1/members/${edu.membershipId}/deactivate`, {})).status, 200);
    // Datos heredados: el diagnóstico de un Administrador ya inactivo se informa (legacy), no se ajusta solo.
    const legacy = await bruno('GET', `/v1/members/${edu.membershipId}/deactivation-check`);
    assert.deepEqual([legacy.body['status'], legacy.body['legacy'], legacy.body['canDeactivate']], ['inactivo', false, false]);
  });

  test('AA-012 · RB-D4: la solicitud de devolución no mueve dinero; la entrega la registra UNA vez (reintento incluido)', async () => {
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 6_000, reason: 'Base de Carlos 5' })).status, 201);
    const ops0 = await opCount();
    const req = await $ana('/v1/capital/requests', { kind: 'worker_return', holderId: carlos.membershipId, routeId: r1, concept: 'base', amountMinor: 2_000, note: 'Devuélveme 2 000' });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    assert.equal(await opCount(), ops0, 'pedir no mueve dinero');
    const [b0, w0] = [await base(r1), await custody(carlos.membershipId)];
    const opId = randomUUID();
    const reqId = (req.body['request'] as Body)['id'] as string;
    const body = { routeId: r1, amountMinor: 2_000, concept: 'base', requestId: reqId };
    const d = await carlos.money('/v1/capital/own-returns', body, opId);
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.deepEqual((await carlos.money('/v1/capital/own-returns', body, opId)).body, d.body);
    assert.deepEqual([await opCount(), await base(r1), await custody(carlos.membershipId)], [ops0 + 1, b0 + 2_000, w0 - 2_000]);
    assert.equal((await db.admin.query('select state from adex.capital_requests where id = $1', [reqId])).rows[0].state, 'fulfilled');
  });

  test('AA-013 · RB-D5: con route_base el Secretario no registra traspasos (API y PostgreSQL, AX421); nada se escribe', async () => {
    const gil = await newPerson(api, issuer, provider.ids, bruno, { email: 'gil-aa@example.test', role: 'admin', displayName: 'Gil', routeIds: [] });
    const ops0 = await opCount();
    const r = await gabi('POST', '/v1/capital/admin-transfers', { originAdminId: M.anaAdmin, destinationAdminId: gil.membershipId, amountMinor: 1_000, reason: 'Traspaso del Secretario' },
      { 'x-adex-operation-id': randomUUID() });
    expectCode(r, 409, 'CAPITAL_MODEL_OPERATION_REFUSED', 'traspaso del Secretario');
    const sqlCode = await pg({ identityId: identityOf('gabi'), membershipId: M.gabiSec }, c1,
      `select adex.admin_transfer_register($1::uuid, $2, $3, 1000, 'Traspaso por SQL directo')`, [randomUUID(), M.anaAdmin, gil.membershipId]);
    assert.equal(sqlCode, 'AX421');
    assert.equal(await opCount(), ops0);
    assert.equal(await count(`select count(*) n from adex.admin_transfers where company_id = $1`), 0);
  });

  test('AA-014 · C-14 Offline en route_base: sin clientes ni ventas; cobros, visitas, gastos propios y desembolsos aprobados desde la custodia', async () => {
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 40_000, reason: 'Base para desembolsar' })).status, 201);
    const cl = await ana('POST', '/v1/clients', clientBody(r1));
    assert.equal(cl.status, 201, JSON.stringify(cl.body));
    // Clientes y solicitudes/ventas: nunca sin conexión.
    expectCode(await carlos.money('/v1/clients', { ...clientBody(r1), offline: off() }), 400, 'UNKNOWN_FIELD', 'cliente sin conexión');
    expectCode(await carlos.money('/v1/credit-requests', { routeId: r1, clientId: cl.body['id'], ...cond(), offline: off() }), 400, 'UNKNOWN_FIELD', 'solicitud sin conexión');
    assert.equal((await carlos.money('/v1/credits/direct', { routeId: r1, clientId: cl.body['id'], ...cond(), offline: off() })).status, 400, 'venta sin conexión');
    // Desembolso aprobado, sin conexión, desde SU custodia (la Base no se toca).
    const req = await carlos.money('/v1/credit-requests', { routeId: r1, clientId: cl.body['id'], ...cond() });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    assert.equal((await gabi('POST', `/v1/credit-requests/${req.body['id']}/approve`, {})).status, 200);
    const [b0, w0] = [await base(r1), await custody(carlos.membershipId)];
    const dis = await carlos.money(`/v1/credit-requests/${req.body['id']}/disburse`, { offline: off() });
    assert.equal(dis.status, 201, JSON.stringify(dis.body));
    assert.deepEqual([await base(r1), await custody(carlos.membershipId)], [b0, w0 - 20_000]);
    const saleId = ((dis.body['credit'] as Body | undefined)?.['id'] ?? dis.body['saleId'] ?? (dis.body['sale'] as Body | undefined)?.['id']) as string;
    assert.ok(saleId, JSON.stringify(dis.body));
    assert.equal((await carlos.money('/v1/collections', { saleId, amountMinor: 2_000, offline: off() })).status, 201, 'cobro sin conexión');
    assert.equal((await carlos.call('POST', '/v1/no-payment-visits', { saleId, reason: 'sin_dinero', offline: off() }, { 'x-adex-operation-id': randomUUID() })).status, 201,
      'visita sin conexión');
    assert.equal((await carlos.money('/v1/expenses', { scope: 'trabajador', routeId: r1, workerId: carlos.membershipId, categoryId: cat, amountMinor: 300,
      description: 'Almuerzo', offline: off() })).status, 201, 'gasto propio sin conexión');
    assert.equal(await base(r1), b0, 'nada de lo capturado sin conexión toca la Base');
    await ledgerOk();
  });

  test('AA-015 · C-12 admin_pool (c2): sigue igual; también concilia en su modelo y RB-D1 aplica; c1 y c2 no se ven', async () => {
    assert.equal((await db.admin.query('select capital_model from adex.companies where id = $1', [c2])).rows[0].capital_model, 'admin_pool');
    const p0 = await pool(M.hugoAdmin, c2);
    const p = (await hugo('GET', `/v1/settlements/preview?routeId=${c2r1}&workerId=${M.elisaCob}`)).body;
    const expected = Number(p['expectedPositionMinor']);
    const s = await $hugo('/v1/settlements', { routeId: c2r1, workerId: M.elisaCob, deliveredMinor: expected - 5_000, expectedSeenMinor: expected,
      previousSettlementId: p['previousSettlementId'] ?? null, reason: 'Faltan 5 000 en el cuadre de Elisa' });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal(await pool(M.hugoAdmin, c2), p0 + expected - 5_000, 'el cuadre en admin_pool devuelve a la bolsa como siempre');
    const sid = (s.body['settlement'] as Body)['id'];
    // c1 no ve la diferencia de c2.
    assert.equal((await ana('GET', `/v1/capital/differences/preview?sourceKind=settlement_shortage&sourceId=${sid}`)).status, 404);
    const r = await resolve($hugo, { sourceKind: 'settlement_shortage', sourceId: sid, resolution: 'route_shortage', amountMinor: 5_000, reason: 'Faltante asumido por la ruta c2' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([await custody(M.elisaCob, c2r1, c2), await carried(M.elisaCob, c2r1, c2), await diffAcc(c2r1, c2), await pool(M.hugoAdmin, c2)],
      [0, 0, 5_000, p0 + expected - 5_000], 'sin tocar la bolsa');
    expectCode(await carla('POST', `/v1/members/${M.hugoAdmin}/deactivate`, {}), 409, 'ADMIN_HAS_PENDING_ACCOUNTS', 'RB-D1 en admin_pool');
    // Elisa ve la operación de su custodia; Ana (otra empresa) no ve nada de c2.
    const seen = await asApi(db.api, { identityId: identityOf('elisa'), membershipId: M.elisaCob, companyId: c2 }, async (q) =>
      Number((await q.query(`select count(*) n from adex.capital_operations where kind = 'DIFFERENCE_CONCILIATION'`)).rows[0].n));
    assert.equal(seen, 1, 'el Cobrador ve la conciliación de su custodia');
    assert.equal(((await ana('GET', '/v1/capital/conciliations')).body['conciliations'] as Body[]).length,
      await count(`select count(*) n from adex.difference_conciliations where company_id = $1`, [c1]));
    await ledgerOk(carla);
    assert.deepEqual(await reconcile(db.admin, c2), CLEAN);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    void todayC2; void catC2;
  });
});
