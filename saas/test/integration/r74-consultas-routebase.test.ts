// R74 · Consultas (bloque B) con Base por Ruta y gastos generales (0034 + 0035): nombres, grupos y partes legibles
// para los tipos nuevos, perspectivas sin «bolsa» con Base por Ruta, detalle con los aportes por ruta y la regla de
// oro: el saldo a favor de un Administrador (`admin_payable`) es una OBLIGACIÓN y nunca cuenta como efectivo.
// Datos sintéticos, PostgreSQL local.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { companyId, routeId } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { balance, money, newPerson, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('R74 · Consultas con Base por Ruta y gastos generales', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const c2 = companyId('c2');
  const [r1, r2, r3] = [routeId('c1', 1), routeId('c1', 2), routeId('c1', 3)];
  let bruno: Caller, $bruno: Money, ana: Caller, $ana: Money, carla: Caller, $carla: Money, hugo: Caller, $hugo: Money;
  let edu: Person;
  let today = '', cat = '', catC2 = '';
  let twoRoutesExpense = '', ownMoneyExpense = '', reimbursementId = '';

  const base = (r: string) => balance(db.admin, c1, 'route_base', null, r);
  const custody = async (r: string) => Number((await db.admin.query(`select coalesce(sum(balance_minor), 0) s from adex.capital_accounts where company_id = $1 and kind = 'custody' and route_id = $2`, [c1, r])).rows[0].s);
  const get = async (who: Caller, path: string) => {
    const r = await who('GET', path);
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const cash = (who: Caller, q: string) => get(who, `/v1/movements/cash?from=${today}&to=${today}&limit=200&${q}`);
  const opsOf = async (where: string, p: unknown[]) => (await db.admin.query<{ id: string }>(`select id from adex.capital_operations where company_id = $1 and ${where} order by created_at, id`, [c1, ...p])).rows.map((x) => x.id);

  before(async () => {
    db = await createTestDb('r74_consultas_rb', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    carla = caller(api, issuer, 'carla', M.carlaSa); $carla = money(carla);
    hugo = caller(api, issuer, 'hugo', M.hugoAdmin); $hugo = money(hugo);
    today = (await db.admin.query(`select adex.business_today($1)::text d`, [c1])).rows[0].d;
    cat = (await db.admin.query(`select id from adex.expense_categories where company_id = $1 and active order by id limit 1`, [c1])).rows[0].id;
    catC2 = (await db.admin.query(`select id from adex.expense_categories where company_id = $1 and active order by id limit 1`, [c2])).rows[0].id;
    edu = await newPerson(api, issuer, provider.ids, bruno, { email: 'edu-crb@example.test', role: 'admin', displayName: 'Edu', routeIds: [r3] });
    const of2 = (await db.admin.query(`select id from adex.offices where company_id = $1 and code = 'OF-2'`, [c1])).rows[0].id as string;
    assert.equal((await bruno('POST', `/v1/offices/${of2}/status`, { status: 'activa' })).status, 200);
    assert.equal((await bruno('POST', `/v1/routes/${r3}/status`, { status: 'activa' })).status, 200);
    const r3ctrl = (await db.admin.query('select capital_controller_membership_id c from adex.routes where id = $1', [r3])).rows[0].c;
    if (r3ctrl !== edu.membershipId) {
      assert.equal((await bruno('PUT', `/v1/routes/${r3}/capital-controller`, { membershipId: edu.membershipId, reason: 'Responsable de r3' })).status, 200);
    }
    // Historia con bolsas: Ana recibe una bolsa que quedará «sin asignar» al activar Base por Ruta.
    assert.equal((await $bruno('/v1/capital/company/deposits', { amountMinor: 500_000, reason: 'Capital sintético' })).status, 201);
    assert.equal((await $bruno('/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 100_000, reason: 'Bolsa de Ana' })).status, 201);
    const company = await balance(db.admin, c1, 'company', null);
    if (company > 0) assert.equal((await $bruno('/v1/capital/company/withdrawals', { amountMinor: company, reason: 'Disponible a cero antes del corte' })).status, 201);
    // Con saldos que repartir se pasa por «migrando» (RB-D6); vale con y sin la regla de 0036.
    const mig = await $bruno('/v1/capital/model', { target: 'migrating', evidence: 'Migración autorizada para la prueba local de Consultas', backupReference: 'backup-local-crb' });
    assert.equal(mig.status, 200, JSON.stringify(mig.body));
    const act = await $bruno('/v1/capital/model', { target: 'route_base', evidence: 'Corte autorizado para la prueba local de Consultas', backupReference: 'backup-local-crb' });
    assert.equal(act.status, 200, JSON.stringify(act.body));
    for (const [who, r, amt] of [[$ana, r1, 200_000], [$ana, r2, 50_000], [edu.money, r3, 80_000]] as const) {
      const inj = await who('/v1/capital/route-base/injections', { routeId: r, amountMinor: amt, reason: 'Base inicial sintética' });
      assert.equal(inj.status, 201, JSON.stringify(inj.body));
    }
    // c2 sigue en el modelo de bolsas: Hugo con bolsa propia.
    assert.equal((await $carla('/v1/capital/company/deposits', { amountMinor: 300_000, reason: 'Capital c2' })).status, 201);
    assert.equal((await $carla('/v1/capital/allocations', { adminId: M.hugoAdmin, amountMinor: 100_000, reason: 'Bolsa de Hugo' })).status, 201);
  });
  after(async () => { await api?.close(); await db?.close(); });

  test('CRB-001 · perspectivas con Base por Ruta: por defecto una ruta propia; el saldo anterior se llama «sin asignar», nunca «bolsa»', async () => {
    const p = await get(ana, '/v1/movements/perspectives') as { default: string; options: Body[] };
    assert.equal(p.default, `route:${r1}`, 'por defecto, la primera ruta de la que es responsable');
    const admins = p.options.filter((o) => o['kind'] === 'admin');
    assert.ok(admins.length >= 1, 'el saldo anterior de Ana aparece');
    for (const o of admins) assert.match(String(o['label']), /^Saldo sin asignar de /, `sin «bolsa»: ${String(o['label'])}`);
    assert.ok(!p.options.some((o) => /bolsa/i.test(String(o['label']))), 'ninguna perspectiva dice «bolsa»');
    const page = await cash(ana, `perspective=admin:${M.anaAdmin}`);
    assert.match(String((page['perspective'] as Body)['label']), /^Saldo sin asignar de /);
    // Modelo de bolsas (c2): todo igual que antes.
    const h = await get(hugo, '/v1/movements/perspectives') as { default: string; options: Body[] };
    assert.equal(h.default, `admin:${M.hugoAdmin}`);
    assert.match(String(h.options.find((o) => o['key'] === h.default)!['label']), /^Bolsa de /);
  });

  test('CRB-002 · reparto del saldo sin asignar: «Saldo sin asignar de Ana» → Base de la ruta; grupo capital', async () => {
    const r = await $ana('/v1/capital/route-base/unassigned-assignments', { routeId: r2, amountMinor: 30_000, reason: 'Reparto del saldo anterior', evidence: 'Conteo del sistema anterior para la Ruta 2' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const page = await cash(ana, `perspective=route:${r2}`);
    const row = (page['rows'] as Body[]).find((x) => x['kind'] === 'LEGACY_POOL_TO_ROUTE')!;
    assert.ok(row, 'el reparto aparece en el Dinero de la ruta');
    assert.deepEqual([row['group'], (row['from'] as Body)['type'], (row['to'] as Body)['type'], row['inMinor']], ['capital', 'unassigned', 'route_base', 30_000]);
  });

  test('CRB-003 · A con dos rutas: cada aporte es una fila de «gastos» en el Dinero de SU ruta; el detalle muestra todos los aportes', async () => {
    const [b1, b2] = [await base(r1), await base(r2)];
    const r = await $ana('/v1/expenses', { scope: 'administrador', fundingSource: 'routes', categoryId: cat, amountMinor: 10_000, description: 'Papelería general',
      contributions: [{ routeId: r1, amountMinor: 7_000 }, { routeId: r2, amountMinor: 3_000 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    twoRoutesExpense = (r.body['expense'] as Body)['id'] as string;
    assert.deepEqual([await base(r1), await base(r2)], [b1 - 7_000, b2 - 3_000]);
    const page = await cash(ana, `perspective=route:${r1}`);
    const row = (page['rows'] as Body[]).find((x) => x['kind'] === 'GENERAL_EXPENSE_CONTRIBUTION')!;
    assert.ok(row, 'el aporte aparece en el Dinero de la Ruta 1');
    assert.deepEqual([row['group'], row['outMinor'], (row['from'] as Body)['type'], (row['to'] as Body)['type']], ['gastos', 7_000, 'route_base', 'general_expense']);
    const summary = page['summary'] as Body;
    assert.equal((summary['ledger'] as Body)['ok'], true, 'cuadra con el libro');
    assert.equal(summary['closingMinor'], (await base(r1)) + (await custody(r1)), 'saldo final = Base + custodias');
    const gastos = (summary['groups'] as Body[]).find((g) => g['group'] === 'gastos')!;
    assert.ok(Number(gastos['outMinor']) >= 7_000);
    const d = await get(ana, `/v1/movements/detail?id=${row['id']}`);
    const mv = d['movement'] as Body;
    assert.deepEqual([mv['money'], (mv['from'] as Body)['type'], (mv['to'] as Body)['type']], [true, 'route_base', 'general_expense']);
    const c = d['contributions'] as Body;
    assert.equal(c['purpose'], 'expense');
    assert.equal(c['expenseId'], twoRoutesExpense);
    assert.equal(c['totalMinor'], 10_000);
    assert.deepEqual((c['items'] as Body[]).map((i) => [i['routeId'], i['amountMinor']]).sort(), [[r1, 7_000], [r2, 3_000]].sort());
    const legs = d['legs'] as Body[];
    assert.ok(legs.some((l) => (l['account'] as Body)['kind'] === 'route_base' && (l['account'] as Body)['label'] === 'Base de la ruta' && l['cash'] === true));
    // Filtro por grupo en el servidor.
    const only = await cash(ana, `perspective=route:${r1}&group=gastos`);
    assert.ok((only['rows'] as Body[]).every((x) => x['group'] === 'gastos'));
  });

  test('CRB-004 · C2 (dinero propio): no es efectivo en ninguna perspectiva; aparece en Actividad como «obligaciones»; el detalle lo explica', async () => {
    const companyBefore = await cash(bruno, 'perspective=company');
    const r = await $ana('/v1/expenses', { scope: 'empresa', fundingSource: 'own_money', categoryId: cat, amountMinor: 5_000, description: 'Pagado con dinero propio' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ownMoneyExpense = (r.body['expense'] as Body)['id'] as string;
    const opId = (await opsOf(`kind = 'GENERAL_EXPENSE_OWN_MONEY' and expense_id = $2`, [ownMoneyExpense]))[0]!;
    const company = await cash(bruno, 'perspective=company');
    const s0 = companyBefore['summary'] as Body, s1 = company['summary'] as Body;
    assert.equal(s1['closingMinor'], s0['closingMinor'], 'el efectivo de la empresa no cambia');
    assert.ok(!(company['rows'] as Body[]).some((x) => x['id'] === opId), 'no es una fila de Dinero');
    // Perspectiva empresa = solo cuentas de efectivo: nunca la cuenta del saldo a favor.
    const cashKinds = (await db.admin.query(`select coalesce(sum(balance_minor), 0) s, count(*) n from adex.capital_accounts
      where company_id = $1 and kind in ('company', 'admin', 'custody', 'transit', 'suspense', 'route_base')`, [c1])).rows[0];
    assert.equal(s1['closingMinor'], Number(cashKinds.s), 'saldo final = Σ cuentas de efectivo');
    assert.equal((company['perspective'] as Body)['accounts'], Number(cashKinds.n), 'admin_payable no está en la perspectiva');
    assert.equal((s1['ledger'] as Body)['ok'], true);
    const act = await get(bruno, `/v1/movements/activity?perspective=company&from=${today}&to=${today}&limit=200&group=obligaciones`);
    const arow = (act['rows'] as Body[]).find((x) => x['id'] === opId)!;
    assert.ok(arow, 'aparece en Actividad');
    assert.equal(arow['group'], 'obligaciones');
    const d = await get(bruno, `/v1/movements/detail?id=${opId}`);
    const mv = d['movement'] as Body;
    assert.deepEqual([mv['money'], (mv['from'] as Body)['type'], (mv['from'] as Body)['id'], (mv['to'] as Body)['type']], [false, 'admin_money', M.anaAdmin, 'general_expense']);
    const payableLeg = (d['legs'] as Body[]).find((l) => (l['account'] as Body)['kind'] === 'admin_payable')!;
    assert.deepEqual([(payableLeg['account'] as Body)['label'], payableLeg['cash'], payableLeg['amountMinor']], ['Saldo a favor del Administrador (obligación)', false, -5_000]);
    assert.equal(d['contributions'], null);
    // El propio Administrador también lo ve en su Actividad (perspectiva de su saldo).
    const mine = await get(ana, `/v1/movements/activity?perspective=admin:${M.anaAdmin}&from=${today}&to=${today}&limit=200`);
    assert.ok((mine['rows'] as Body[]).some((x) => x['id'] === opId && x['group'] === 'obligaciones'), 'Ana ve su gasto con dinero propio');
  });

  test('CRB-005 · autorreembolso desde la Ruta 1: fila «reembolsos» (Base → Reembolso a Ana); anulación invertida y enlazada', async () => {
    const r = await $ana('/v1/capital/reimbursements', { adminId: M.anaAdmin, contributions: [{ routeId: r1, amountMinor: 2_000 }], reason: 'Autorreembolso parcial' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    reimbursementId = (r.body['reimbursement'] as Body)['id'] as string;
    const page = await cash(ana, `perspective=route:${r1}&group=reembolsos`);
    const row = (page['rows'] as Body[]).find((x) => x['kind'] === 'ADMIN_REIMBURSEMENT')!;
    assert.ok(row, 'el reembolso aparece en el Dinero de la Ruta 1');
    assert.deepEqual([row['group'], row['outMinor'], (row['from'] as Body)['type'], (row['to'] as Body)['type'], (row['to'] as Body)['id']],
      ['reembolsos', 2_000, 'route_base', 'reimbursed_admin', M.anaAdmin]);
    const d = await get(ana, `/v1/movements/detail?id=${row['id']}`);
    const c = d['contributions'] as Body;
    assert.deepEqual([c['purpose'], c['reimbursementId'], c['totalMinor']], ['reimbursement', reimbursementId, 2_000]);
    assert.ok((d['legs'] as Body[]).some((l) => (l['account'] as Body)['kind'] === 'route_base' && l['cash'] === true));
    const rev = await $ana(`/v1/capital/reimbursements/${reimbursementId}/reverse`, { reason: 'Registrado por error' });
    assert.equal(rev.status, 201, JSON.stringify(rev.body));
    const after = await cash(ana, `perspective=route:${r1}&group=reembolsos`);
    const rr = (after['rows'] as Body[]).find((x) => x['kind'] === 'REVERSAL' && x['reversesKind'] === 'ADMIN_REIMBURSEMENT')!;
    assert.ok(rr, 'la anulación aparece en el mismo grupo');
    assert.deepEqual([rr['group'], rr['inMinor'], (rr['from'] as Body)['type'], (rr['to'] as Body)['type']], ['reembolsos', 2_000, 'reimbursed_admin', 'route_base']);
    const orig = (after['rows'] as Body[]).find((x) => x['id'] === row['id'])!;
    assert.equal(orig['status'], 'anulada');
    const dr = await get(ana, `/v1/movements/detail?id=${rr['id']}`);
    assert.equal((dr['movement'] as Body)['reversesOperationId'], row['id']);
    assert.equal((dr['contributions'] as Body)['reimbursementId'], reimbursementId, 'la anulación muestra los aportes del original');
  });

  test('CRB-006 · anular el gasto general con dos rutas: dos anulaciones, cada una vuelve a SU Base (grupo gastos)', async () => {
    const [b1, b2] = [await base(r1), await base(r2)];
    const r = await $ana(`/v1/expenses/${twoRoutesExpense}/reverse`, { reason: 'Gasto duplicado' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([await base(r1), await base(r2)], [b1 + 7_000, b2 + 3_000]);
    const page = await cash(ana, `perspective=route:${r2}&group=gastos`);
    const rr = (page['rows'] as Body[]).find((x) => x['kind'] === 'REVERSAL' && x['reversesKind'] === 'GENERAL_EXPENSE_CONTRIBUTION')!;
    assert.ok(rr);
    assert.deepEqual([rr['inMinor'], (rr['from'] as Body)['type'], (rr['to'] as Body)['type']], [3_000, 'general_expense', 'route_base']);
  });

  test('CRB-007 · modelo de bolsas (c2): C2 y reembolso desde la bolsa propia; partes «Bolsa de Hugo» → «Reembolso a Hugo»', async () => {
    const e = await $hugo('/v1/expenses', { scope: 'empresa', fundingSource: 'own_money', categoryId: catC2, amountMinor: 4_000, description: 'Gasto con dinero propio (c2)' });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    const r = await $hugo('/v1/capital/reimbursements', { adminId: M.hugoAdmin, amountMinor: 1_500, reason: 'Reembolso desde mi bolsa' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const todayC2 = (await db.admin.query(`select adex.business_today($1)::text d`, [c2])).rows[0].d;
    const page = await get(hugo, `/v1/movements/cash?perspective=admin:${M.hugoAdmin}&from=${todayC2}&to=${todayC2}&limit=200`);
    assert.match(String((page['perspective'] as Body)['label']), /^Bolsa de /, 'en el modelo de bolsas sigue siendo «Bolsa»');
    const row = (page['rows'] as Body[]).find((x) => x['kind'] === 'ADMIN_REIMBURSEMENT')!;
    assert.ok(row);
    assert.deepEqual([row['group'], row['outMinor'], (row['from'] as Body)['type'], (row['to'] as Body)['type']], ['reembolsos', 1_500, 'pool', 'reimbursed_admin']);
    const d = await get(hugo, `/v1/movements/detail?id=${row['id']}`);
    const items = (d['contributions'] as Body)['items'] as Body[];
    assert.deepEqual(items.map((i) => [i['routeId'], i['amountMinor']]), [[null, 1_500]], 'reembolso desde la bolsa: un aporte sin ruta');
    assert.ok((d['legs'] as Body[]).some((l) => (l['account'] as Body)['kind'] === 'admin' && (l['account'] as Body)['label'] === 'Bolsa'));
    assert.equal((page['summary'] as Body)['ledger'] && ((page['summary'] as Body)['ledger'] as Body)['ok'], true);
  });

  test('CRB-008 · grupos: «reembolsos» y «obligaciones» válidos; un grupo desconocido sigue siendo 400', async () => {
    assert.equal((await ana('GET', `/v1/movements/cash?perspective=route:${r1}&group=reembolsos`)).status, 200);
    assert.equal((await bruno('GET', '/v1/movements/activity?perspective=company&group=obligaciones')).status, 200);
    assert.equal((await ana('GET', `/v1/movements/cash?perspective=route:${r1}&group=inventado`)).status, 400);
    assert.equal((await bruno('GET', '/v1/movements/activity?perspective=company&group=reembolsos')).status, 400, 'reembolsos es un grupo de Dinero, no de Actividad');
  });

  test('CRB-009 · conciliación de una diferencia (0036): «Conciliación de diferencia» en el grupo «diferencias»; Base → «faltante/sobrante conciliado», que no es efectivo', async (t) => {
    const has0036 = Number((await db.admin.query(`select count(*) n from pg_proc where proname = 'difference_resolve'`)).rows[0].n) > 0;
    if (!has0036) { t.skip('base sin 0036'); return; }
    // Edu recibe la Ruta 2 (entrega con acta) y cuenta R$ 10 menos de lo esperado.
    assert.equal((await bruno('PUT', `/v1/members/${edu.membershipId}/routes`, { routeIds: [r2, r3] })).status, 200);
    const ch = await bruno('PUT', `/v1/routes/${r2}/capital-controller`, { membershipId: edu.membershipId, reason: 'Edu asume la Ruta 2 (prueba de conciliación)' });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    const expected = await base(r2);
    const conf = await edu.money(`/v1/capital/handovers/${r2}/confirm`, { countedMinor: expected - 1_000, expectedSeenMinor: expected, note: 'Faltan R$ 10 en el conteo físico' });
    assert.ok(conf.status === 200 || conf.status === 201, JSON.stringify(conf.body));
    const difs = await get(edu.call, `/v1/capital/differences?routeId=${r2}`);
    const item = (difs['items'] as Body[]).find((i) => i['sourceKind'] === 'handover')!;
    assert.ok(item, JSON.stringify(difs));
    const res = await edu.money('/v1/capital/differences/resolve', { sourceKind: 'handover', sourceId: item['sourceId'], resolution: 'route_shortage',
      amountMinor: item['pendingMinor'], reason: 'La ruta asume el faltante del acta de entrega' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await base(r2), expected - 1_000, 'la Base baja al reconocer el faltante');
    const page = await cash(edu.call, `perspective=route:${r2}&group=diferencias`);
    const row = (page['rows'] as Body[]).find((x) => x['kind'] === 'DIFFERENCE_CONCILIATION')!;
    assert.ok(row, 'la conciliación aparece en el Dinero de la ruta');
    assert.deepEqual([row['group'], row['outMinor'], (row['from'] as Body)['type'], (row['to'] as Body)['type']], ['diferencias', 1_000, 'route_base', 'route_difference']);
    assert.equal(((page['summary'] as Body)['ledger'] as Body)['ok'], true);
    const d = await get(edu.call, `/v1/movements/detail?id=${row['id']}`);
    assert.equal((d['movement'] as Body)['money'], true);
    const diffLeg = (d['legs'] as Body[]).find((l) => (l['account'] as Body)['kind'] === 'route_difference')!;
    assert.deepEqual([(diffLeg['account'] as Body)['label'], diffLeg['cash'], diffLeg['amountMinor']], ['Faltante/sobrante conciliado', false, 1_000]);
    // La perspectiva Empresa nunca incluye la cuenta de diferencias conciliadas.
    const company = await cash(bruno, 'perspective=company');
    const n = Number((await db.admin.query(`select count(*) n from adex.capital_accounts where company_id = $1 and kind in ('company', 'admin', 'custody', 'transit', 'suspense', 'route_base')`, [c1])).rows[0].n);
    assert.equal((company['perspective'] as Body)['accounts'], n);
  });
});
