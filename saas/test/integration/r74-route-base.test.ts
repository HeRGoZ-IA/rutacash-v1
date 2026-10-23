// R74 · Base por Ruta (0034), núcleo LOCAL detrás de `companies.capital_model`. Decisiones del
// propietario O1–O11 y E2 (docs/ADEX_RONDA_74_INTERVENCION_INTEGRAL.md §4/§8 y encargo R74-P/D):
//   · la Base es de la RUTA (`route_base` ≥ 0) con su contrapartida `route_funding`; la mueve el
//     Administrador responsable vigente; se queda con la ruta al cambiar de responsable (entrega con acta);
//   · con `route_base` las bolsas son saldo «sin asignar» (no reciben nada; solo se reparten por el
//     Administrador a una ruta suya) y el SuperAdmin no mueve capital de empresa (E2);
//   · entregas, devoluciones, cuadres, ventas directas, cobros sin caja personal, gastos de ruta,
//     rectificaciones y reaplicaciones usan la Base de la ruta; los gastos generales se rechazan hasta
//     decidir su financiación (O4); naturaleza de la categoría de gasto;
//   · transferencias entre rutas (mismo o distinto responsable) inmediatas, idempotentes y visibles al destino;
//   · una empresa `admin_pool` (c2) no cambia en nada.
// Datos sintéticos, PostgreSQL local.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf, routeId } from '../../db/seeds/synthetic.ts';
import { asApi, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, parallel, type Caller } from '../helpers/phase2.ts';
import { balance, money, newPerson, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('R74 · Base por Ruta (0034)', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const c2 = companyId('c2');
  const [r1, r2, r3] = [routeId('c1', 1), routeId('c1', 2), routeId('c1', 3)];
  let bruno: Caller, $bruno: Money, ana: Caller, $ana: Money, carla: Caller, $carla: Money, hugo: Caller;
  let carlos: Person, dora: Person, edu: Person;
  let today = '', cat = '', motoCat = '';
  // Historia anterior al corte (modelo de bolsas).
  let preSaleR1 = '', preSaleR2 = '', prePaymentR2 = '', preExpenseR2 = '';
  let baseSaleR1 = '';

  const op = () => ({ 'x-adex-operation-id': randomUUID() });
  const base = (r: string) => balance(db.admin, c1, 'route_base', null, r);
  const funding = (r: string) => balance(db.admin, c1, 'route_funding', null, r);
  const pool = (m: string) => balance(db.admin, c1, 'admin', m);
  const custody = (m: string, r: string) => balance(db.admin, c1, 'custody', m, r);
  const opCount = async () => Number((await db.admin.query('select count(*) n from adex.capital_operations where company_id = $1', [c1])).rows[0].n);
  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const cond = (o: Body = {}) => ({ amountMinor: 30_000, interestRate: 20, installmentsCount: 10, frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6], ...o });
  const newClient = async (who: Caller, route: string) => {
    const r = await who('POST', '/v1/clients', { routeId: route, name: `CLIENTE BASE ${randomUUID().slice(0, 6)}`, documentType: 'CPF', document: cpf(),
      phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body['id'] as string;
  };
  const directSale = async (who: Caller, route: string, o: Body = {}) => {
    const r = await money(who)('/v1/credits/direct', { routeId: route, clientId: await newClient(who, route), ...cond(o) });
    return r;
  };
  const paymentIdOf = (b: Body) => (b['paymentId'] as string | undefined) ?? ((b['payment'] as Body | undefined)?.['id'] as string);
  const expenseIdOf = (b: Body) => (b['expenseId'] as string | undefined) ?? ((b['expense'] as Body | undefined)?.['id'] as string);
  const legs = async (opId: string) => (await db.admin.query<{ kind: string; route_id: string | null; membership_id: string | null; amount: number }>(
    `select a.kind, a.route_id, a.membership_id, e.amount_minor::int amount from adex.capital_entries e
       join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id where e.operation_id = $1 order by e.leg`, [opId])).rows;
  const ledgerOk = async () => {
    const r = await bruno('GET', '/v1/capital/reconciliation');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const failed = (r.body['checks'] as Body[]).filter((c) => !c['ok']);
    assert.deepEqual(failed, [], 'conciliación limpia');
    for (const name of ['legs-in-route-scope', 'no-admin-pool-inflow-after-cutover', 'route-conservation']) {
      assert.ok((r.body['checks'] as Body[]).some((c) => c['name'] === name), `incluye ${name}`);
    }
  };
  const expectCode = (r: { status: number; body: Body }, status: number, code: string, label: string) =>
    assert.deepEqual([r.status, r.body['error'] ?? r.body['code']], [status, code], `${label}: ${JSON.stringify(r.body)}`);

  before(async () => {
    db = await createTestDb('r74_route_base', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    carla = caller(api, issuer, 'carla', M.carlaSa); $carla = money(carla);
    hugo = caller(api, issuer, 'hugo', M.hugoAdmin);
    today = (await db.admin.query(`select adex.business_today($1)::text d`, [c1])).rows[0].d;
    cat = (await db.admin.query(`select id from adex.expense_categories where company_id = $1 and active order by id limit 1`, [c1])).rows[0].id;
    carlos = await newPerson(api, issuer, provider.ids, bruno, { email: 'carlos-rb@example.test', role: 'cobrador', displayName: 'Carlos', routeIds: [r1] });
    dora = await newPerson(api, issuer, provider.ids, bruno, { email: 'dora-rb@example.test', role: 'supervisor', displayName: 'Dora', routeIds: [r1] });
    edu = await newPerson(api, issuer, provider.ids, bruno, { email: 'edu-rb@example.test', role: 'admin', displayName: 'Edu', routeIds: [r3] });
    // La semilla deja r2 en una oficina inactiva y r3 inactiva: se activan para operar las tres rutas.
    const of2 = (await db.admin.query(`select id from adex.offices where company_id = $1 and code = 'OF-2'`, [c1])).rows[0].id as string;
    assert.equal((await bruno('POST', `/v1/offices/${of2}/status`, { status: 'activa' })).status, 200);
    const st = await bruno('POST', `/v1/routes/${r3}/status`, { status: 'activa' });
    assert.equal(st.status, 200, JSON.stringify(st.body));
    // --- Historia con bolsas (admin_pool) ---
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético Base por Ruta' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 3_000_000, reason: 'Bolsa de Ana' }],
    ] as const) assert.equal((await $bruno(path, body)).status, 201, path);
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 100_000, reason: 'Base de Carlos' })).status, 201);
    const s1 = await directSale(ana, r1, { amountMinor: 50_000 });
    assert.equal(s1.status, 201, JSON.stringify(s1.body));
    preSaleR1 = (s1.body['credit'] as Body)['id'] as string;
    const s2 = await directSale(ana, r2, { amountMinor: 40_000 });
    assert.equal(s2.status, 201, JSON.stringify(s2.body));
    preSaleR2 = (s2.body['credit'] as Body)['id'] as string;
    // r2 sin Cobrador activo: Ana cobra sin caja personal → bolsa.
    const p2 = await $ana('/v1/collections', { saleId: preSaleR2, amountMinor: 4_000 });
    assert.equal(p2.status, 201, JSON.stringify(p2.body));
    prePaymentR2 = paymentIdOf(p2.body);
    const e2 = await $ana('/v1/expenses', { scope: 'ruta', routeId: r2, categoryId: cat, amountMinor: 1_000, description: 'Gasto de ruta antes del corte' });
    assert.equal(e2.status, 201, JSON.stringify(e2.body));
    preExpenseR2 = expenseIdOf(e2.body);
  });
  after(async () => { await api?.close(); await db?.close(); });

  test('RB-001 · esquema: modelo por empresa admin_pool por defecto; la API declara route-base-v1 solo con 0034', async () => {
    const r = await db.admin.query(`select id, capital_model, route_base_since from adex.companies order by id`);
    assert.ok(r.rows.length >= 3);
    for (const x of r.rows) assert.deepEqual([x.capital_model, x.route_base_since], ['admin_pool', null], x.id);
    const m = await ana('GET', '/v1/capital/model');
    assert.equal(m.status, 200);
    assert.equal(m.body['model'], 'admin_pool');
    // En admin_pool no existe la Base: comandos nuevos → ROUTE_BASE_NOT_ACTIVE y nada cambia.
    const before = await opCount();
    expectCode(await $ana('/v1/capital/route-base/injections', { routeId: r1, amountMinor: 1_000, reason: 'Antes de activar' }), 409, 'ROUTE_BASE_NOT_ACTIVE', 'inyección en admin_pool');
    assert.equal(await opCount(), before);
    assert.equal(Number((await db.admin.query(`select count(*) n from adex.capital_accounts where kind in ('route_base', 'route_funding')`)).rows[0].n), 0);
  });

  test('RB-002 · migrating congela las bolsas (AX422) y deja operar al Cobrador; volver a admin_pool lo restaura todo', async () => {
    const t = await $bruno('/v1/capital/model', { target: 'migrating', evidence: 'Congelamos bolsas para preparar el corte' });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    expectCode(await $bruno('/v1/capital/company/deposits', { amountMinor: 1_000, reason: 'Durante la migración' }), 409, 'CAPITAL_MIGRATION_IN_PROGRESS', 'depósito');
    expectCode(await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 1_000, reason: 'Durante la migración' }), 409, 'CAPITAL_MIGRATION_IN_PROGRESS', 'entrega desde la bolsa');
    const pay = await carlos.money('/v1/collections', { saleId: preSaleR1, amountMinor: 6_000 });
    assert.equal(pay.status, 201, `el Cobrador cobra a su custodia: ${JSON.stringify(pay.body)}`);
    const back = await $bruno('/v1/capital/model', { target: 'admin_pool', evidence: 'Cancelamos la migración de prueba' });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal((await $bruno('/v1/capital/company/deposits', { amountMinor: 1_000, reason: 'Tras cancelar' })).status, 201);
    const acts = (await bruno('GET', '/v1/capital/model')).body['activations'] as Body[];
    assert.deepEqual(acts.map((a) => [a['fromModel'], a['toModel']]), [['admin_pool', 'migrating'], ['migrating', 'admin_pool']]);
  });

  test('RB-003 · activación (O6): requisitos comprobados en PostgreSQL; solo el SuperAdmin; registro con evidencia y respaldo', async () => {
    expectCode(await $ana('/v1/capital/model', { target: 'route_base', evidence: 'Un Administrador no activa', backupReference: 'bk-1' }), 403, 'PERMISSION_DENIED', 'Administrador');
    const pre = await bruno('GET', '/v1/capital/model/prerequisites');
    assert.equal(pre.status, 200, JSON.stringify(pre.body));
    const failing = (pre.body['checks'] as Body[]).filter((c) => !c['ok']).map((c) => c['name']).sort();
    // Disponible de la empresa ≠ 0 y r3 sin responsable válido (Edu está asignado a r3; r3 lo tiene si FIRST_ADMIN corrió).
    assert.ok(failing.includes('company-account-zero'), JSON.stringify(failing));
    expectCode(await $bruno('/v1/capital/model', { target: 'route_base', evidence: 'Intento sin cumplir requisitos', backupReference: 'bk-2026-10-23' }),
      409, 'ACTIVATION_PREREQUISITES_FAILED', 'sin requisitos');
    expectCode(await $bruno('/v1/capital/model', { target: 'route_base', evidence: 'Sin referencia de respaldo' }), 400, 'INVALID_INPUT', 'sin respaldo');
    // Se cumplen: el disponible de la empresa se retira con las reglas actuales y r3 tiene responsable.
    const company = await balance(db.admin, c1, 'company', null);
    assert.equal((await $bruno('/v1/capital/company/withdrawals', { amountMinor: company, reason: 'Disponible a cero antes del corte' })).status, 201);
    const r3ctrl = (await db.admin.query('select capital_controller_membership_id c from adex.routes where id = $1', [r3])).rows[0].c;
    if (r3ctrl !== edu.membershipId) {
      assert.equal((await bruno('PUT', `/v1/routes/${r3}/capital-controller`, { membershipId: edu.membershipId, reason: 'Responsable de r3' })).status, 200);
    }
    const ok = await bruno('GET', '/v1/capital/model/prerequisites');
    assert.equal(ok.body['ok'], true, JSON.stringify(ok.body));
    const poolAna = await pool(M.anaAdmin);
    const act = await $bruno('/v1/capital/model', { target: 'route_base', evidence: 'Corte autorizado por el propietario (prueba local)', backupReference: 'backup-local-2026-10-23' });
    assert.equal(act.status, 200, JSON.stringify(act.body));
    assert.equal(act.body['model'], 'route_base');
    assert.deepEqual((act.body['unassignedPools'] as Body[]).map((p) => [p['adminId'], p['balanceMinor']]), [[M.anaAdmin, poolAna]], 'la bolsa queda «sin asignar», sin moverse');
    assert.equal(await pool(M.anaAdmin), poolAna);
    const row = (await db.admin.query(`select capital_model, route_base_since from adex.companies where id = $1`, [c1])).rows[0];
    assert.equal(row.capital_model, 'route_base');
    assert.ok(row.route_base_since);
    const rec = (await db.admin.query(`select * from adex.capital_model_activations where company_id = $1 and to_model = 'route_base'`, [c1])).rows;
    assert.equal(rec.length, 1);
    assert.equal(rec[0].actor_membership_id, M.brunoSa);
    assert.equal(rec[0].backup_reference, 'backup-local-2026-10-23');
    assert.equal(rec[0].prerequisites.ok, true);
    // Irreversible por la API.
    expectCode(await $bruno('/v1/capital/model', { target: 'admin_pool', evidence: 'Volver atrás no se permite' }), 409, 'CAPITAL_MODEL_OPERATION_REFUSED', 'desactivar');
    // Y c2 sigue en admin_pool.
    assert.equal((await db.admin.query(`select capital_model from adex.companies where id = $1`, [c2])).rows[0].capital_model, 'admin_pool');
  });

  test('RB-004 · E2: con route_base el SuperAdmin no deposita, retira, asigna ni inyecta; bolsas y solicitudes de bolsa cerradas', async () => {
    const before = await opCount();
    expectCode(await $bruno('/v1/capital/company/deposits', { amountMinor: 1_000, reason: 'Depósito tras el corte' }), 409, 'CAPITAL_MODEL_OPERATION_REFUSED', 'depósito');
    expectCode(await $bruno('/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 1_000, reason: 'Asignación tras el corte' }), 409, 'CAPITAL_MODEL_OPERATION_REFUSED', 'asignación');
    expectCode(await $bruno('/v1/capital/admin-returns', { adminId: M.anaAdmin, amountMinor: 1_000, reason: 'Recogida tras el corte' }), 409, 'CAPITAL_MODEL_OPERATION_REFUSED', 'recogida');
    expectCode(await $ana('/v1/capital/admin-returns', { amountMinor: 1_000, reason: 'Devolución tras el corte' }), 409, 'CAPITAL_MODEL_OPERATION_REFUSED', 'devolución voluntaria de la bolsa');
    assert.equal((await $bruno('/v1/capital/route-base/injections', { routeId: r1, amountMinor: 1_000, reason: 'El SuperAdmin no inyecta' })).status, 403);
    const req = await $bruno('/v1/capital/requests', { kind: 'admin_return', holderId: M.anaAdmin, amountMinor: 1_000, note: 'Solicitud obsoleta' });
    assert.ok([409, 400].includes(req.status), `solicitud de bolsa: ${JSON.stringify(req.body)}`);
    assert.equal(await opCount(), before, 'nada se escribió');
  });

  test('RB-005 · inyección y retiro de Base (O1/O2/O10): solo el responsable, idempotente, sin negativos', async () => {
    const opId = randomUUID();
    const inj = await $ana('/v1/capital/route-base/injections', { routeId: r1, amountMinor: 200_000, reason: 'Inyección inicial de r1', sourceNote: 'Aporte externo del propietario' }, opId);
    assert.equal(inj.status, 201, JSON.stringify(inj.body));
    const again = await $ana('/v1/capital/route-base/injections', { routeId: r1, amountMinor: 200_000, reason: 'Inyección inicial de r1', sourceNote: 'Aporte externo del propietario' }, opId);
    assert.equal(again.status, 201);
    assert.deepEqual(again.body, inj.body, 'el reintento devuelve la misma respuesta');
    assert.deepEqual([await base(r1), await funding(r1)], [200_000, -200_000], 'una sola inyección');
    const opRow = (inj.body['operation'] as Body);
    assert.deepEqual((await legs(opRow['id'] as string)).map((l) => [l.kind, l.route_id, l.amount]), [['route_funding', r1, -200_000], ['route_base', r1, 200_000]]);
    // Otros: Supervisor, Cobrador, Administrador de otra ruta → no.
    assert.equal((await dora.money('/v1/capital/route-base/injections', { routeId: r1, amountMinor: 1_000, reason: 'Supervisor' })).status, 403);
    assert.equal((await carlos.money('/v1/capital/route-base/injections', { routeId: r1, amountMinor: 1_000, reason: 'Cobrador' })).status, 403);
    assert.ok([403, 404].includes((await edu.money('/v1/capital/route-base/injections', { routeId: r1, amountMinor: 1_000, reason: 'Otro Administrador' })).status));
    // Retiro: tope el saldo (sin cifras en el error).
    expectCode(await $ana('/v1/capital/route-base/withdrawals', { routeId: r1, amountMinor: 200_001, reason: 'Más que la Base' }), 409, 'INSUFFICIENT_FUNDS', 'retiro excesivo');
    const w = await $ana('/v1/capital/route-base/withdrawals', { routeId: r1, amountMinor: 10_000, reason: 'Retiro de Base' });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    assert.deepEqual([await base(r1), await funding(r1)], [190_000, -190_000]);
    expectCode(await $ana(`/v1/capital/operations/${(w.body['operation'] as Body)['id']}/reverse`, { reason: 'Anular un retiro' }), 409, 'REVERSAL_NOT_ALLOWED', 'anular retiro');
    // Anular una inyección: solo si la Base aún la tiene; una sola vez.
    const small = await $ana('/v1/capital/route-base/injections', { routeId: r1, amountMinor: 7_000, reason: 'Inyección equivocada' });
    const sid = (small.body['operation'] as Body)['id'];
    const rev = await $ana(`/v1/capital/operations/${sid}/reverse`, { reason: 'Inyección registrada por error' });
    assert.equal(rev.status, 201, JSON.stringify(rev.body));
    expectCode(await $ana(`/v1/capital/operations/${sid}/reverse`, { reason: 'Otra vez' }), 409, 'ALREADY_REVERSED', 'doble anulación');
    assert.equal(await base(r1), 190_000);
  });

  test('RB-006 · custodia: entrega desde la Base, devolución voluntaria y cobro a custodia; la bolsa no se toca', async () => {
    const poolBefore = await pool(M.anaAdmin);
    const custBefore = await custody(carlos.membershipId, r1);
    const d = await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 50_000, reason: 'Base del día desde la ruta' });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.deepEqual((await legs((d.body['operation'] as Body)['id'] as string)).map((l) => [l.kind, l.amount]), [['route_base', -50_000], ['custody', 50_000]]);
    const ret = await carlos.money('/v1/capital/own-returns', { routeId: r1, amountMinor: 10_000, concept: 'recaudo' });
    assert.equal(ret.status, 201, JSON.stringify(ret.body));
    const pay = await carlos.money('/v1/collections', { saleId: preSaleR1, amountMinor: 3_000 });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    assert.equal(await base(r1), 190_000 - 50_000 + 10_000);
    assert.equal(await custody(carlos.membershipId, r1), custBefore + 50_000 - 10_000 + 3_000);
    assert.equal(await pool(M.anaAdmin), poolBefore, 'la bolsa «sin asignar» no se usa');
    // Más que la Base → INSUFFICIENT_FUNDS.
    expectCode(await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 10_000_000, reason: 'Más que la Base' }), 409, 'INSUFFICIENT_FUNDS', 'entrega excesiva');
  });

  test('RB-007 · ventas directas desde la Base (D26) y gastos: de ruta con la Base, generales rechazados (O4), naturaleza', async () => {
    const b0 = await base(r1);
    const s = await directSale(ana, r1, { amountMinor: 30_000 });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    baseSaleR1 = (s.body['credit'] as Body)['id'] as string;
    assert.equal(await base(r1), b0 - 30_000);
    expectCode(await directSale(ana, r1, { amountMinor: 10_000_000 }), 409, 'INSUFFICIENT_FUNDS', 'venta mayor que la Base');
    // Naturaleza de la categoría.
    const mc = await ana('POST', '/v1/expense-categories', { name: 'Moto de la ruta', nature: 'bien_duradero' }, op());
    assert.equal(mc.status, 201, JSON.stringify(mc.body));
    assert.equal(mc.body['nature'], 'bien_duradero');
    motoCat = mc.body['id'] as string;
    assert.equal((await ana('POST', '/v1/expense-categories', { name: 'Mala', nature: 'activo' }, op())).status, 400);
    const e1 = await $ana('/v1/expenses', { scope: 'ruta', routeId: r1, categoryId: cat, amountMinor: 2_000, description: 'Combustible de la ruta' });
    assert.equal(e1.status, 201, JSON.stringify(e1.body));
    const e2 = await $ana('/v1/expenses', { scope: 'ruta', routeId: r1, categoryId: motoCat, amountMinor: 5_000, description: 'Cuota de la moto' });
    assert.equal(e2.status, 201, JSON.stringify(e2.body));
    assert.equal(await base(r1), b0 - 30_000 - 7_000);
    // Generales: el del Administrador y el de la empresa, rechazados hasta decidir su financiación.
    expectCode(await $ana('/v1/expenses', { scope: 'empresa', categoryId: cat, amountMinor: 1_000, description: 'Papelería de la oficina', fundingSource: 'admin', fundingAdminId: M.anaAdmin }),
      409, 'GENERAL_EXPENSE_FUNDING_PENDING', 'gasto general del Administrador');
    expectCode(await $bruno('/v1/expenses', { scope: 'empresa', categoryId: cat, amountMinor: 1_000, description: 'Contador de la empresa', fundingSource: 'empresa' }),
      409, 'GENERAL_EXPENSE_FUNDING_PENDING', 'gasto general de la empresa');
    // El del trabajador sigue en su custodia.
    const wc = await custody(carlos.membershipId, r1);
    assert.equal((await carlos.money('/v1/expenses', { scope: 'trabajador', routeId: r1, workerId: carlos.membershipId, categoryId: cat, amountMinor: 500, description: 'Almuerzo' })).status, 201);
    assert.equal(await custody(carlos.membershipId, r1), wc - 500);
  });

  test('RB-008 · cuadre: el efectivo reconocido vuelve a la Base; reabrir lo devuelve desde la Base', async () => {
    const b0 = await base(r1);
    const p = (await ana('GET', `/v1/settlements/preview?routeId=${r1}&workerId=${carlos.membershipId}`)).body;
    const expected = Number(p['expectedPositionMinor']);
    const s = await $ana('/v1/settlements', { routeId: r1, workerId: carlos.membershipId, deliveredMinor: expected, expectedSeenMinor: expected, previousSettlementId: p['previousSettlementId'] ?? null });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal(await base(r1), b0 + expected);
    assert.equal(await custody(carlos.membershipId, r1), 0);
    const sid = (s.body['settlement'] as Body)['id'];
    const re = await $ana(`/v1/settlements/${sid}/reopen`, { reason: 'Conteo repetido por error' });
    assert.equal(re.status, 201, JSON.stringify(re.body));
    assert.equal(await base(r1), b0);
    assert.equal(await custody(carlos.membershipId, r1), expected);
  });

  test('RB-009 · rectificación (0032) con la Base: venta pagada por la Base y venta anterior al corte (redirigida)', async () => {
    const rect = (saleId: string, o: Body) => $ana(`/v1/credits/${saleId}/rectify`, {
      ...cond(), expectedRectifications: 0, reason: 'El capital correcto de la operación es otro', evidence: 'Contrato firmado por el cliente', offlineChecked: true, ...o });
    const b0 = await base(r1);
    const up = await rect(baseSaleR1, { amountMinor: 35_000 });
    assert.ok([200, 201].includes(up.status), JSON.stringify(up.body));
    assert.equal(await base(r1), b0 - 5_000, 'la diferencia sale de la Base');
    const chk = await ana('GET', `/v1/credits/${preSaleR1}/rectification-check`);
    assert.equal(chk.status, 200, JSON.stringify(chk.body));
    assert.equal(chk.body['payerKind'], 'route_base', 'la venta anterior al corte responde con la Base');
    const poolBefore = await pool(M.anaAdmin);
    const down = await rect(preSaleR1, { amountMinor: 45_000, startDate: today });
    assert.ok([200, 201].includes(down.status), JSON.stringify(down.body));
    assert.equal(await base(r1), b0 - 5_000 + 5_000, 'la reducción vuelve a la Base');
    assert.equal(await pool(M.anaAdmin), poolBefore, 'nada entra a la bolsa');
  });

  test('RB-010 · cobro sin caja personal, anulación y reaplicación con la Base (incluido un pago anterior al corte)', async () => {
    assert.equal((await $ana('/v1/capital/route-base/injections', { routeId: r2, amountMinor: 20_000, reason: 'Inyección de r2' })).status, 201);
    const poolBefore = await pool(M.anaAdmin);
    const rv = await $ana(`/v1/collections/${prePaymentR2}/reverse`, { reason: 'Pago mal registrado' });
    assert.equal(rv.status, 201, JSON.stringify(rv.body));
    assert.equal(await base(r2), 16_000, 'la anulación sale de la Base de la ruta (pago cobrado a la bolsa antes del corte)');
    assert.equal(await pool(M.anaAdmin), poolBefore);
    const chk = await ana('GET', `/v1/collections/${prePaymentR2}/reapply-check`);
    assert.equal(chk.status, 200, JSON.stringify(chk.body));
    assert.deepEqual(chk.body['blockers'], [], JSON.stringify(chk.body));
    assert.equal(chk.body['receiverKind'], 'route_base');
    const ra = await $ana(`/v1/collections/${prePaymentR2}/reapply`, { reason: 'El pago sí se recibió en efectivo' });
    assert.ok([200, 201].includes(ra.status), JSON.stringify(ra.body));
    assert.equal(await base(r2), 20_000);
    // Cobro nuevo sin caja personal (r2 sin Cobrador activo) → Base.
    const p = await $ana('/v1/collections', { saleId: preSaleR2, amountMinor: 2_000 });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal(await base(r2), 22_000);
    assert.equal(await pool(M.anaAdmin), poolBefore);
  });

  test('RB-011 · transferencias entre rutas (O11): mismo responsable y otro responsable; visibles y avisadas al destino', async () => {
    const [b1, b2, b3] = [await base(r1), await base(r2), await base(r3)];
    const same = await $ana('/v1/capital/route-base/transfers', { fromRouteId: r1, toRouteId: r2, amountMinor: 20_000, reason: 'Refuerzo de r2' });
    assert.equal(same.status, 201, JSON.stringify(same.body));
    const dest = await ana('GET', '/v1/capital/route-base/transfer-destinations');
    assert.equal(dest.status, 200);
    assert.ok((dest.body['routes'] as Body[]).some((x) => x['routeId'] === r3 && x['inScope'] === false && x['controllerId'] === edu.membershipId), JSON.stringify(dest.body));
    const opId = randomUUID();
    const other = await $ana('/v1/capital/route-base/transfers', { fromRouteId: r1, toRouteId: r3, amountMinor: 15_000, reason: 'Préstamo de caja a r3' }, opId);
    assert.equal(other.status, 201, JSON.stringify(other.body));
    const retry = await $ana('/v1/capital/route-base/transfers', { fromRouteId: r1, toRouteId: r3, amountMinor: 15_000, reason: 'Préstamo de caja a r3' }, opId);
    assert.deepEqual(retry.body, other.body, 'reintento idempotente');
    assert.deepEqual([await base(r1), await base(r2), await base(r3)], [b1 - 35_000, b2 + 20_000, b3 + 15_000]);
    const o = other.body['operation'] as Body;
    assert.deepEqual([o['routeId'], o['toRouteId'], o['counterpartId']], [r1, r3, edu.membershipId]);
    // El destino la ve (operaciones de su ruta) y recibe el aviso; nada que aceptar.
    const ops = await edu.call('GET', `/v1/capital/operations?routeId=${r3}`);
    assert.ok((ops.body['operations'] as Body[]).some((x) => x['id'] === o['id']), 'Edu ve la transferencia');
    const n = await edu.call('GET', '/v1/notifications');
    assert.ok((n.body['info'] as Body[]).some((x) => x['type'] === 'route-transfer-received'), JSON.stringify(n.body));
    // Sin negativos, sin anulación, y Edu no transfiere desde r1.
    expectCode(await $ana('/v1/capital/route-base/transfers', { fromRouteId: r1, toRouteId: r3, amountMinor: 10_000_000, reason: 'Más que la Base' }), 409, 'INSUFFICIENT_FUNDS', 'excesiva');
    expectCode(await $ana(`/v1/capital/operations/${o['id']}/reverse`, { reason: 'Deshacer transferencia' }), 409, 'REVERSAL_NOT_ALLOWED', 'anular transferencia');
    assert.ok([403, 404].includes((await edu.money('/v1/capital/route-base/transfers', { fromRouteId: r1, toRouteId: r3, amountMinor: 1_000, reason: 'Desde ruta ajena' })).status));
    // Quien ahora tiene el dinero lo devuelve con otra transferencia.
    assert.equal((await edu.money('/v1/capital/route-base/transfers', { fromRouteId: r3, toRouteId: r1, amountMinor: 5_000, reason: 'Devolución parcial' })).status, 201);
    assert.equal(await base(r3), b3 + 10_000);
  });

  test('RB-012 · concurrencia: dos transferencias que juntas superan la Base → exactamente una', async () => {
    const b = await base(r1);
    const half = Math.floor(b / 2) + 1;
    const res = await parallel(2, (i) => $ana('/v1/capital/route-base/transfers', { fromRouteId: r1, toRouteId: r2, amountMinor: half, reason: `Carrera ${i}` }));
    assert.deepEqual(res.map((r) => r.status).sort(), [201, 409], JSON.stringify(res.map((r) => r.body)));
    assert.equal(await base(r1), b - half);
    assert.ok(await base(r1) >= 0);
  });

  test('RB-013 · aislamiento: una ruta no consume la Base de otra (API y segunda barrera AX424)', async () => {
    assert.ok([403, 404].includes((await edu.money('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 1_000, reason: 'Ruta ajena' })).status));
    // Segunda barrera: una pata en la Base de r2 dentro de una operación de r1.
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local role adex_owner');
      const id = randomUUID();
      await c.query(`insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, worker_membership_id, admin_membership_id,
                       reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
                     values ($1, $2, gen_random_uuid(), 'WORKER_DELIVERY', 1, 'BRL', $3, $4, $5, 'Intento cruzado', current_date, $6, $7::uuid, 'admin', txid_current())`,
        [id, c1, r1, carlos.membershipId, M.anaAdmin, M.anaAdmin, identityOf('ana')]);
      await assert.rejects(c.query(`insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor)
                                     values ($1::text, $2::text, 1, (select id from adex.capital_accounts where company_id = $1::text and kind = 'route_base' and route_id = $3::text), -1, 0)`,
        [c1, id, r2]), { code: 'AX424' });
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  test('RB-014 · «sin asignar» (O3): solo el Administrador dueño reparte a una ruta suya; no se anula; la bolsa no recibe nada', async () => {
    const p0 = await pool(M.anaAdmin);
    const b0 = await base(r1);
    expectCode(await $ana('/v1/capital/route-base/unassigned-assignments', { routeId: r1, amountMinor: 100_000, reason: 'Reparto', evidence: 'corto' }), 400, 'INVALID_INPUT', 'evidencia corta');
    const a = await $ana('/v1/capital/route-base/unassigned-assignments', { routeId: r1, amountMinor: 100_000, reason: 'Reparto del saldo sin asignar', evidence: 'Conteo del sistema anterior: r1 usaba esta bolsa' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([await pool(M.anaAdmin), await base(r1)], [p0 - 100_000, b0 + 100_000]);
    expectCode(await $ana('/v1/capital/route-base/unassigned-assignments', { routeId: r1, amountMinor: p0 * 10, reason: 'Más que la bolsa', evidence: 'Intento excesivo sin respaldo' }), 409, 'INSUFFICIENT_FUNDS', 'excesivo');
    expectCode(await edu.money('/v1/capital/route-base/unassigned-assignments', { routeId: r3, amountMinor: 1_000, reason: 'Sin bolsa', evidence: 'Edu no tiene saldo sin asignar' }), 409, 'INSUFFICIENT_FUNDS', 'sin bolsa');
    expectCode(await $ana(`/v1/capital/operations/${(a.body['operation'] as Body)['id']}/reverse`, { reason: 'Deshacer reparto' }), 409, 'REVERSAL_NOT_ALLOWED', 'anular reparto');
    const panel = await bruno('GET', `/v1/capital/route-panel?from=${today}&to=${today}`);
    const pools = (panel.body['general'] as Body)['unassignedPools'] as Body[];
    assert.deepEqual(pools.map((x) => [x['adminId'], x['balanceMinor']]), [[M.anaAdmin, p0 - 100_000]], 'el saldo sin asignar sigue visible y controlado');
  });

  test('RB-015 · entrega controlada (O5): la Base se queda con la ruta; bloqueos; acta con diferencia sin movimientos', async () => {
    assert.equal((await bruno('PUT', `/v1/members/${edu.membershipId}/routes`, { routeIds: [r2, r3] })).status, 200);
    const b2 = await base(r2);
    const ch = await bruno('PUT', `/v1/routes/${r2}/capital-controller`, { membershipId: edu.membershipId, reason: 'Edu asume r2' });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    assert.equal(await base(r2), b2, 'la Base no se mueve');
    assert.equal((await db.admin.query('select handover_state s from adex.routes where id = $1', [r2])).rows[0].s, 'en_entrega');
    const n = await edu.call('GET', '/v1/notifications');
    assert.ok((n.body['actionRequired'] as Body[]).some((x) => x['type'] === 'handover-confirmation'), JSON.stringify(n.body));
    assert.ok(Number((await edu.call('GET', '/v1/notifications/count')).body['actionRequired']) >= 1);
    const ops0 = await opCount();
    expectCode(await edu.money('/v1/capital/route-base/injections', { routeId: r2, amountMinor: 1_000, reason: 'Durante la entrega' }), 409, 'ROUTE_IN_HANDOVER', 'inyección');
    expectCode(await edu.money('/v1/capital/route-base/withdrawals', { routeId: r2, amountMinor: 1_000, reason: 'Durante la entrega' }), 409, 'ROUTE_IN_HANDOVER', 'retiro');
    expectCode(await edu.money('/v1/capital/route-base/transfers', { fromRouteId: r2, toRouteId: r3, amountMinor: 1_000, reason: 'Durante la entrega' }), 409, 'ROUTE_IN_HANDOVER', 'transferencia de salida');
    expectCode(await edu.money('/v1/expenses', { scope: 'ruta', routeId: r2, categoryId: cat, amountMinor: 100, description: 'Gasto durante la entrega' }), 409, 'ROUTE_IN_HANDOVER', 'gasto de ruta');
    assert.equal(await opCount(), ops0);
    // Cobros siguen (sin caja personal: el responsable vigente).
    assert.equal((await edu.money('/v1/collections', { saleId: preSaleR2, amountMinor: 1_000 })).status, 201);
    const b = await base(r2);
    // Solo el nuevo responsable confirma; cifras vigentes; diferencia con nota.
    assert.equal((await $ana(`/v1/capital/handovers/${r2}/confirm`, { countedMinor: b, expectedSeenMinor: b })).status, 403, 'Ana ya no es la responsable de r2');
    const list = await edu.call('GET', `/v1/capital/handovers?routeId=${r2}&status=pendiente`);
    assert.equal((list.body['handovers'] as Body[])[0]!['currentBaseMinor'], b);
    expectCode(await edu.money(`/v1/capital/handovers/${r2}/confirm`, { countedMinor: b, expectedSeenMinor: b - 1 }), 409, 'SETTLEMENT_STALE', 'cifras viejas');
    expectCode(await edu.money(`/v1/capital/handovers/${r2}/confirm`, { countedMinor: b - 500, expectedSeenMinor: b, note: 'corta' }), 400, 'REASON_REQUIRED', 'diferencia sin nota');
    const opsBefore = await opCount();
    const ok = await edu.money(`/v1/capital/handovers/${r2}/confirm`, { countedMinor: b - 500, expectedSeenMinor: b, note: 'Faltan 500 en el conteo físico de la Base' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body['differenceMinor'], ok.body['result']], [-500, 'faltante']);
    assert.equal(await opCount(), opsBefore, 'sin movimientos automáticos');
    assert.equal(await base(r2), b, 'el libro no cambia');
    assert.equal((await db.admin.query('select handover_state s from adex.routes where id = $1', [r2])).rows[0].s, 'normal');
    expectCode(await edu.money(`/v1/capital/handovers/${r2}/confirm`, { countedMinor: b, expectedSeenMinor: b }), 409, 'HANDOVER_NOT_PENDING', 'ya confirmada');
    // Ahora Edu opera r2 y corrige el gasto de ruta que Ana registró antes del corte: vuelve a la Base.
    const rev = await edu.money(`/v1/expenses/${preExpenseR2}/reverse`, { reason: 'Gasto duplicado' });
    assert.equal(rev.status, 201, JSON.stringify(rev.body));
    assert.equal(await base(r2), b + 1_000);
    assert.equal((await edu.money('/v1/capital/route-base/injections', { routeId: r2, amountMinor: 1_000, reason: 'Tras la entrega' })).status, 201);
    // Ana ya no inyecta en r2.
    assert.ok([403, 404].includes((await $ana('/v1/capital/route-base/injections', { routeId: r2, amountMinor: 1_000, reason: 'Ya no es responsable' })).status));
  });

  test('RB-016 · cierre de periodo con route_base: cifras con bloque base y huella intacta; conciliación limpia', async () => {
    const wk = (await db.admin.query(`select (date_trunc('week', $1::date) - interval '7 days')::date::text s, (date_trunc('week', $1::date) - interval '1 day')::date::text e`, [today])).rows[0];
    const c = await $ana('/v1/periods/close', { routeId: r1, weekStart: wk.s, weekEnd: wk.e, note: 'Cierre con Base por Ruta' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const fig = (await db.admin.query(`select figures from adex.period_closures where id = $1`, [c.body['closureId']])).rows[0].figures;
    assert.ok(fig.base && 'closingMinor' in fig.base, 'las cifras archivadas incluyen el bloque base');
    await ledgerOk();
  });

  test('RB-017 · panel por ruta (O8/O9): Base, custodias, resultado operativo básico, flujo y liquidez; RLS', async () => {
    // Una solicitud aprobada mayor que la liquidez de r3 → insuficiencia de liquidez.
    const req = await edu.call('POST', '/v1/credit-requests', { routeId: r3, clientId: await newClient(edu.call, r3), ...cond({ amountMinor: 9_000_000 }) });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    assert.equal((await bruno('PUT', `/v1/members/${M.fabioSec}/routes`, { routeIds: [r1, r2, r3] })).status, 200);
    const fabio = caller(api, issuer, 'fabio', M.fabioSec);
    const ap = await fabio('POST', `/v1/credit-requests/${req.body['id']}/approve`, {});
    assert.equal(ap.status, 200, JSON.stringify(ap.body));
    const sa = await bruno('GET', `/v1/capital/route-panel?from=${today}&to=${today}`);
    assert.equal(sa.status, 200, JSON.stringify(sa.body));
    assert.equal(sa.body['model'], 'route_base');
    const rows = sa.body['routes'] as Body[];
    const byId = new Map(rows.map((x) => [x['routeId'] as string, x]));
    for (const r of [r1, r2, r3]) assert.equal(byId.get(r)!['baseMinor'], await base(r), `Base de ${r}`);
    const p1 = byId.get(r1)!;
    const exp = (p1['period'] as Body)['expenses'] as Body;
    assert.equal(exp['bienDuraderoMinor'], 5_000, 'la moto no es gasto operativo');
    assert.equal(p1['operatingResultMinor'], Number((p1['period'] as Body)['interestCollectedMinor']) - Number(exp['operativoMinor']) - Number(exp['otroMinor']));
    const p3 = byId.get(r3)!;
    assert.equal((p3['states'] as Body)['insufficientLiquidity'], true, JSON.stringify(p3));
    assert.ok((p3['alerts'] as string[]).includes('INSUFFICIENT_LIQUIDITY'));
    assert.ok((byId.get(r2)!['alerts'] as string[]).includes('HANDOVER_DIFFERENCE'));
    const totals = sa.body['totals'] as Body;
    assert.equal(totals['baseMinor'], (await base(r1)) + (await base(r2)) + (await base(r3)));
    // Edu ve solo sus rutas; el Cobrador no ve el panel.
    const e = await edu.call('GET', `/v1/capital/route-panel?from=${today}&to=${today}`);
    assert.deepEqual((e.body['routes'] as Body[]).map((x) => x['routeId']).sort(), [r2, r3].sort());
    assert.equal((await carlos.call('GET', `/v1/capital/route-panel?from=${today}&to=${today}`)).status, 403);
  });

  test('RB-018 · RLS multiempresa: c2 (admin_pool) no ve nada de c1 y sigue igual; la Base de c1 no aparece en c2', async () => {
    const c2ops = Number((await db.admin.query('select count(*) n from adex.capital_operations where company_id = $1', [c2])).rows[0].n);
    assert.equal((await $carla('/v1/capital/company/deposits', { amountMinor: 1_000_000, reason: 'Capital de c2 (admin_pool)' })).status, 201);
    assert.equal(Number((await db.admin.query('select count(*) n from adex.capital_operations where company_id = $1', [c2])).rows[0].n), c2ops + 1);
    expectCode(await money(hugo)('/v1/capital/route-base/injections', { routeId: routeId('c2', 1), amountMinor: 1_000, reason: 'c2 no tiene Base' }), 409, 'ROUTE_BASE_NOT_ACTIVE', 'c2');
    const seen = await asApi(db.api, { identityId: identityOf('carla'), membershipId: M.carlaSa, companyId: c2 }, async (q) =>
      (await q.query(`select count(*) n from adex.capital_accounts where kind in ('route_base', 'route_funding')`)).rows[0].n);
    assert.equal(Number(seen), 0);
    const anaSees = await asApi(db.api, { identityId: identityOf('ana'), membershipId: M.anaAdmin, companyId: c1 }, async (q) =>
      (await q.query(`select route_id from adex.capital_accounts where kind = 'route_base' order by route_id`)).rows.map((x) => x.route_id));
    // Visibilidad por alcance (rutas asignadas): Ana sigue asignada a r1 y r2; r3 no es de su alcance.
    assert.ok(anaSees.includes(r1) && !anaSees.includes(r3), JSON.stringify(anaSees));
    const carlosSees = await asApi(db.api, { identityId: carlos.identityId, membershipId: carlos.membershipId, companyId: c1 }, async (q) =>
      Number((await q.query(`select count(*) n from adex.capital_accounts where kind = 'route_base'`)).rows[0].n));
    assert.equal(carlosSees, 0, 'el Cobrador no ve la Base');
  });

  test('RB-020 · reasignación entre rutas del mismo responsable con route_base: devolución a la Base de origen y entrega desde la Base destino', async () => {
    const feli = await newPerson(api, issuer, provider.ids, bruno, { email: 'feli-rb@example.test', role: 'cobrador', displayName: 'Feli', routeIds: [r2, r3] });
    assert.equal((await edu.money('/v1/capital/deliveries', { routeId: r2, workerId: feli.membershipId, amountMinor: 3_000, reason: 'Base de Feli en r2' })).status, 201);
    const [b2, b3] = [await base(r2), await base(r3)];
    const ra = await edu.money('/v1/capital/route-reassignments', { fromRouteId: r2, toRouteId: r3, fromWorkerId: feli.membershipId, toWorkerId: feli.membershipId, amountMinor: 2_000, reason: 'Feli pasa a r3' });
    assert.equal(ra.status, 201, JSON.stringify(ra.body));
    assert.deepEqual((await legs((ra.body['operation'] as Body)['id'] as string)).map((l) => [l.kind, l.route_id, l.amount]),
      [['custody', r2, -2_000], ['route_base', r2, 2_000], ['route_base', r3, -2_000], ['custody', r3, 2_000]]);
    assert.deepEqual([await base(r2), await base(r3)], [b2 + 2_000, b3 - 2_000], 'cada ruta con su Base: ninguna financia a otra en silencio');
    const rv = await edu.money(`/v1/capital/operations/${(ra.body['operation'] as Body)['id']}/reverse`, { reason: 'Reasignación equivocada' });
    assert.equal(rv.status, 201, JSON.stringify(rv.body));
    assert.deepEqual([await base(r2), await base(r3)], [b2, b3]);
    assert.deepEqual([await custody(feli.membershipId, r2), await custody(feli.membershipId, r3)], [3_000, 0]);
  });

  test('RB-019 · conservación por ruta y libro en cero al final', async () => {
    await ledgerOk();
    const total = Number((await db.admin.query('select coalesce(sum(balance_minor), 0) n from adex.capital_accounts where company_id = $1', [c1])).rows[0].n);
    assert.equal(total, 0, 'el libro suma cero');
    // Cada ruta: Σ saldos de sus cuentas = Σ de lo que cruzó su frontera (bolsas antes del corte, transferencias,
    // reasignaciones y repartos). Independiente de la función de conciliación.
    for (const r of [r1, r2, r3]) {
      const x = (await db.admin.query(`
        select (select coalesce(sum(a.balance_minor), 0) from adex.capital_accounts a where a.company_id = $1 and a.route_id = $2)::bigint inside,
               (select coalesce(sum(e.amount_minor), 0) from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
                 where e.company_id = $1 and a.route_id = $2
                   and exists (select 1 from adex.capital_entries e2 join adex.capital_accounts a2 on a2.company_id = e2.company_id and a2.id = e2.account_id
                                where e2.company_id = e.company_id and e2.operation_id = e.operation_id and a2.route_id is distinct from $2))::bigint crossed`, [c1, r])).rows[0];
      assert.equal(Number(x.inside), Number(x.crossed), `conservación de ${r}`);
    }
    const neg = Number((await db.admin.query(`select count(*) n from adex.capital_accounts where company_id = $1 and kind = 'route_base' and balance_minor < 0`, [c1])).rows[0].n);
    assert.equal(neg, 0, 'ninguna Base negativa');
  });

  test('RB-099 · Consultas (bloque B) con Base por Ruta: la perspectiva de la ruta incluye su Base; saldo final = Base + custodias; origen y destino legibles', async () => {
    const r = await ana('GET', `/v1/movements/cash?perspective=route:${r1}&limit=200`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const custodies = Number((await db.admin.query(`select coalesce(sum(balance_minor), 0) s from adex.capital_accounts where company_id = $1 and kind = 'custody' and route_id = $2`, [c1, r1])).rows[0].s);
    const summary = r.body['summary'] as Body;
    assert.equal(summary['closingMinor'], (await base(r1)) + custodies, 'saldo final = Base de la ruta + custodias');
    assert.equal((summary['ledger'] as Body)['ok'], true, 'cuadra con el libro');
    const rows = r.body['rows'] as Body[];
    const inj = rows.find((x) => x['kind'] === 'ROUTE_BASE_INJECTION');
    assert.ok(inj, 'la inyección aparece en Dinero');
    assert.deepEqual([(inj!['to'] as Body)['type'], (inj!['from'] as Body)['type']], ['route_base', 'external']);
    const del = rows.find((x) => x['kind'] === 'WORKER_DELIVERY');
    if (del) assert.equal((del['from'] as Body)['type'], 'route_base', 'la entrega sale de la Base, no de una bolsa');
  });
});
