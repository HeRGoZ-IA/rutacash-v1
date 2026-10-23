// RONDA 74 · BLOQUE B: Consultas v2 contra PostgreSQL real y la API (datos 100 % sintéticos).
//   · Dinero por PERSPECTIVA (ruta, bolsa, custodia, empresa) con las patas del libro: entradas, salidas e
//     internos; saldo inicial + entradas − salidas = saldo final; conciliado con los saldos de las cuentas y
//     con `route_period_figures`; sin operaciones duplicadas; anulaciones y contrapartes con su sentido real.
//   · Actividad sin dinero; detalle con patas y vínculos; filtros, orden y páginas en el servidor; RLS
//     (otra empresa, Cobrador solo lo suyo, Secretario sin acceso); límites de zona horaria; nombres largos.

import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, routeId } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { money, newPerson, reconcile, CLEAN, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;
const LONG = 'MARIA APARECIDA DOS SANTOS FERREIRA DE OLIVEIRA CAVALCANTI DA SILVA';

describe('Ronda 74 · Consultas v2: Dinero por perspectiva, Actividad y detalle', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  let rB = '';
  let bruno: Caller, $bruno: Money, ana: Caller, $ana: Money, gabi: Caller, hugo: Caller;
  let w1: Person, w2: Person, w3: Person, xavier: Person;
  let today = '';
  let cat = '';
  const ids: Record<string, string> = {};

  const get = async (who: Caller, path: string, qs: Record<string, string | number> = {}) => {
    const u = new URLSearchParams(Object.entries(qs).map(([k, v]) => [k, String(v)]));
    return who('GET', `${path}${u.size ? `?${u}` : ''}`);
  };
  const cash = async (who: Caller, qs: Record<string, string | number> = {}) => {
    const r = await get(who, '/v1/movements/cash', { limit: 200, ...qs });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body as Body & { rows: Body[]; summary: Body; filtered: Body; perspective: Body };
  };
  const sumBalances = async (where: string, params: unknown[]) =>
    Number((await db.admin.query(`select coalesce(sum(balance_minor), 0)::bigint s from adex.capital_accounts where company_id = $1 and ${where}`, [c1, ...params])).rows[0].s);
  /** Invariante de toda respuesta de Dinero. */
  const reconciles = (b: { summary: Body }) => {
    const s = b.summary;
    assert.equal(Number(s['closingMinor']) - Number(s['openingMinor']), Number(s['inMinor']) - Number(s['outMinor']), 'final − inicial = entradas − salidas');
    assert.equal((s['ledger'] as Body)['ok'], true, 'el libro de las cuentas coincide');
    const g = s['groups'] as Body[];
    assert.equal(g.reduce((a, x) => a + Number(x['inMinor']), 0), Number(s['inMinor']), 'Σ grupos = entradas');
    assert.equal(g.reduce((a, x) => a + Number(x['outMinor']), 0), Number(s['outMinor']), 'Σ grupos = salidas');
  };

  before(async () => {
    db = await createTestDb('r74movements', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    gabi = caller(api, issuer, 'gabi', M.gabiSec);
    hugo = caller(api, issuer, 'hugo', M.hugoAdmin);
    today = (await db.admin.query(`select adex.business_today($1)::text d`, [c1])).rows[0].d;
    cat = (await db.admin.query(`select id from adex.expense_categories where company_id = $1 order by name limit 1`, [c1])).rows[0].id;
    // Regla de CLEAN: UN Cobrador por ruta; el segundo trabajador con caja personal es Supervisor.
    w1 = await newPerson(api, issuer, provider.ids, bruno, { email: 'r74-w1@example.test', role: 'cobrador', displayName: 'Carlos Uno', routeIds: [r1] });
    w2 = await newPerson(api, issuer, provider.ids, bruno, { email: 'r74-w2@example.test', role: 'supervisor', displayName: LONG, routeIds: [r1] });
    xavier = await newPerson(api, issuer, provider.ids, bruno, { email: 'r74-xavier@example.test', role: 'admin', displayName: 'Xavier Admin', routeIds: [] });
    const ok = async (r: Promise<{ status: number; body: Body }>, what: string, status = 201) => {
      const x = await r;
      assert.equal(x.status, status, `${what}: ${JSON.stringify(x.body)}`);
      return x.body;
    };
    await ok($bruno('/v1/capital/company/deposits', { amountMinor: 10_000_000, reason: 'Capital sintético' }), 'depósito');
    await ok($bruno('/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 8_000_000, reason: 'Bolsa de Ana' }), 'asignación');
    ids['d1'] = ((await ok($ana('/v1/capital/deliveries', { routeId: r1, workerId: w1.membershipId, amountMinor: 500_000, reason: 'Base Carlos' }), 'entrega w1'))['operation'] as Body)['id'] as string;
    ids['d2'] = ((await ok($ana('/v1/capital/deliveries', { routeId: r1, workerId: w2.membershipId, amountMinor: 300_000, reason: 'Base Maria' }), 'entrega w2'))['operation'] as Body)['id'] as string;
    ids['wt'] = ((await ok($ana('/v1/capital/worker-transfers', { routeId: r1, fromWorkerId: w1.membershipId, toWorkerId: w2.membershipId, amountMinor: 100_000, reason: 'Carlos pasa a Maria' }), 'traspaso'))['operation'] as Body)['id'] as string;
    // Venta del Cobrador: solicitud, aprobación (Secretaria), desembolso con su custodia, recaudo y su anulación.
    ids['client'] = (await ok(ana('POST', '/v1/clients', { routeId: r1, name: 'JOAO DA SILVA - MERCADINHO JK LTDA', documentType: 'CPF', document: String(randomInt(10_000_000_000, 99_999_999_999)),
      phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Mercado' }), 'cliente'))['id'] as string;
    ids['request'] = (await ok(w1.call('POST', '/v1/credit-requests', { routeId: r1, clientId: ids['client'], amountMinor: 50_000, interestRate: 20, installmentsCount: 20, frequency: 'diaria', startDate: today, paymentDays: [1, 2, 3, 4, 5, 6] }), 'solicitud'))['id'] as string;
    await ok(gabi('POST', `/v1/credit-requests/${ids['request']}/approve`, { interestRate: 20 }), 'aprobación', 200);
    ids['sale'] = ((await ok(w1.money(`/v1/credit-requests/${ids['request']}/disburse`, {}), 'desembolso'))['credit'] as Body)['id'] as string;
    await ok(w1.money('/v1/collections', { saleId: ids['sale'], amountMinor: 2_750 }), 'recaudo');
    await ok(w1.money('/v1/collections', { saleId: ids['sale'], amountMinor: 3_000 }), 'recaudo 2');
    const pays = (await db.admin.query('select id from adex.payments where sale_id = $1 order by created_at', [ids['sale']])).rows;
    ids['payRev'] = pays[1].id;
    await ok($ana(`/v1/collections/${ids['payRev']}/reverse`, { reason: 'Error de digitación' }), 'anulación de recaudo');
    await ok(w1.money('/v1/expenses', { categoryId: cat, scope: 'trabajador', routeId: r1, workerId: w1.membershipId, amountMinor: 1_000, description: 'Combustible R74' }), 'gasto');
    ids['ret'] = ((await ok($ana('/v1/capital/returns', { routeId: r1, workerId: w2.membershipId, amountMinor: 50_000, reason: 'Maria devuelve' }), 'devolución'))['operation'] as Body)['id'] as string;
    rB = (await bruno('POST', '/v1/routes', { name: 'Ruta R74 B', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [M.anaAdmin] })).body['id'] as string;
    w3 = await newPerson(api, issuer, provider.ids, bruno, { email: 'r74-w3@example.test', role: 'cobrador', displayName: 'Dora Tres', routeIds: [rB] });
    ids['ra'] = ((await ok($ana('/v1/capital/route-reassignments', { fromRouteId: r1, toRouteId: rB, fromWorkerId: w1.membershipId, toWorkerId: w3.membershipId, amountMinor: 20_000, reason: 'Base para Ruta B' }), 'reasignación'))['operation'] as Body)['id'] as string;
    // Traspaso entre Administradores (directo: HOLD + APPLY).
    await ok($ana('/v1/capital/admin-transfers', { destinationAdminId: xavier.membershipId, amountMinor: 200_000, reason: 'Refuerzo para Xavier' }), 'traspaso admin');
    ids['hold'] = (await db.admin.query(`select id from adex.capital_operations where company_id = $1 and kind = 'ADMIN_TRANSFER_HOLD'`, [c1])).rows[0].id;
    ids['apply'] = (await db.admin.query(`select id from adex.capital_operations where company_id = $1 and kind = 'ADMIN_TRANSFER_APPLY'`, [c1])).rows[0].id;
    // Operación SIN efectivo (simula `PRINCIPAL_RECLASSIFICATION` del bloque A si su migración existe).
    ids['noncash'] = '';
  });
  after(async () => { await api?.close(); await db?.close(); });

  test('R74-MOV-001 · perspectiva Ruta: custodias de la ruta; entradas/salidas/internos por patas; concilia con saldos y route_period_figures', async () => {
    const b = await cash(ana, { perspective: `route:${r1}`, from: today, to: today });
    reconciles(b);
    const byId = new Map(b.rows.map((r) => [r['id'] as string, r]));
    assert.equal(byId.size, b.rows.length, 'una fila por operación (sin duplicados)');
    assert.deepEqual([byId.get(ids['d1']!)!['inMinor'], byId.get(ids['d1']!)!['outMinor'], byId.get(ids['d1']!)!['flow']], [500_000, 0, 'in'], 'entrega de la bolsa = entrada a la ruta');
    const wt = byId.get(ids['wt']!)!;
    assert.deepEqual([wt['inMinor'], wt['outMinor'], wt['internalMinor'], wt['flow']], [0, 0, 100_000, 'internal'], 'traspaso entre custodias de la misma ruta = interno');
    assert.deepEqual([(wt['from'] as Body)['id'], (wt['to'] as Body)['id']], [w1.membershipId, w2.membershipId]);
    const ra = byId.get(ids['ra']!)!;
    assert.deepEqual([ra['outMinor'], ra['inMinor']], [20_000, 0], 'reasignación a otra ruta = salida de esta ruta');
    assert.deepEqual([byId.get(ids['ret']!)!['outMinor']], [50_000]);
    const rev = b.rows.find((r) => r['kind'] === 'REVERSAL' && r['base'] === 'COLLECTION')!;
    assert.deepEqual([rev['outMinor'], rev['group'], (rev['from'] as Body)['type'], (rev['to'] as Body)['type']], [3_000, 'recaudos', 'custody', 'client'], 'anulación de recaudo: sale de la custodia hacia el cliente');
    const orig = b.rows.find((r) => r['id'] === rev['reversesOperationId'])!;
    assert.deepEqual([orig['status'], orig['inMinor']], ['anulada', 3_000]);
    // Saldos reales y cifras del periodo (0030).
    const custody = await sumBalances(`kind = 'custody' and route_id = $2`, [r1]);
    assert.equal(b.summary['closingMinor'], custody, 'saldo final = Σ custodias de la ruta');
    assert.equal(b.summary['openingMinor'], 0);
    const fig = (await db.admin.query(`select adex.route_period_figures($1, $2, $3::date, $3::date) f`, [c1, r1, today])).rows[0].f;
    assert.deepEqual([b.summary['openingMinor'], b.summary['closingMinor']], [Number(fig.custody.openingMinor), Number(fig.custody.closingMinor)]);
    const g = Object.fromEntries((b.summary['groups'] as Body[]).map((x) => [x['group'], x]));
    assert.equal(Number(g['recaudos']!['inMinor']) - Number(g['recaudos']!['outMinor']), Number(fig.custody.collectionsMinor), 'recaudos netos = figures');
    assert.equal(Number(g['desembolsos']!['outMinor']) - Number(g['desembolsos']!['inMinor']), Number(fig.custody.disbursementsMinor), 'desembolsos = figures');
    assert.equal(Number(g['gastos']!['outMinor']), Number(fig.custody.workerExpensesMinor), 'gastos = figures');
    assert.equal(b.summary['internalMinor'], 100_000, 'internos aparte; Σ interno no altera el saldo');
    // La entrega de capital nunca cuenta como recaudo ni ganancia: va en «capital».
    assert.equal(Number(g['capital']!['inMinor']), 800_000);
  });

  test('R74-MOV-002 · perspectiva Empresa (SuperAdmin): entregas y traspasos entre Admin son internos; concilia con el efectivo total', async () => {
    const b = await cash(bruno, { perspective: 'company' });
    reconciles(b);
    const byId = new Map(b.rows.map((r) => [r['id'] as string, r]));
    assert.equal(byId.size, b.rows.length);
    for (const k of ['d1', 'd2', 'wt', 'ret', 'ra', 'hold', 'apply']) {
      const r = byId.get(ids[k]!)!;
      assert.deepEqual([r['inMinor'], r['outMinor'], r['flow']], [0, 0, 'internal'], `${k} es interno en la empresa`);
    }
    assert.equal(byId.get(ids['ra']!)!['internalMinor'], 20_000, 'la reasignación cuenta una vez (la bolsa intermedia se neta)');
    const dep = b.rows.find((r) => r['kind'] === 'COMPANY_DEPOSIT')!;
    assert.deepEqual([dep['inMinor'], dep['outMinor']], [10_000_000, 0]);
    const total = await sumBalances(`kind = any($2::text[])`, [['company', 'admin', 'custody', 'transit', 'suspense']]);
    assert.equal(b.summary['closingMinor'], total, 'saldo final = Σ efectivo de la empresa');
    // Entradas: depósito + recaudos (2.750 + 3.000); salidas: desembolso 50.000 + anulación 3.000 + gasto 1.000.
    assert.deepEqual([b.summary['inMinor'], b.summary['outMinor']], [10_000_000 + 5_750, 50_000 + 3_000 + 1_000]);
    assert.equal((await get(ana, '/v1/movements/cash', { perspective: 'company' })).status, 403, 'el Administrador no tiene perspectiva Empresa');
  });

  test('R74-MOV-003 · traspaso entre Administradores: origen y destino con su sentido real en cada bolsa', async () => {
    const a = await cash(ana, { perspective: `admin:${M.anaAdmin}` });
    reconciles(a);
    const hold = a.rows.find((r) => r['id'] === ids['hold'])!;
    assert.deepEqual([hold['outMinor'], (hold['from'] as Body)['type'], (hold['from'] as Body)['id'], (hold['to'] as Body)['type'], (hold['to'] as Body)['id']],
      [200_000, 'pool', M.anaAdmin, 'transit', xavier.membershipId]);
    assert.ok(!a.rows.some((r) => r['id'] === ids['apply']), 'la aplicación no toca la bolsa de Ana');
    assert.ok(!a.rows.some((r) => r['id'] === ids['ra']), 'la reasignación solo pasa por la bolsa (neto 0): no es fila de la bolsa');
    assert.equal(a.summary['closingMinor'], await sumBalances(`kind = 'admin' and membership_id = $2`, [M.anaAdmin]));
    const x = await cash(xavier.call, {});
    assert.equal((x.perspective as Body)['key'], `admin:${xavier.membershipId}`, 'perspectiva por defecto del Administrador: su bolsa');
    const apply = x.rows.find((r) => r['id'] === ids['apply'])!;
    assert.deepEqual([apply['inMinor'], (apply['from'] as Body)['type'], (apply['from'] as Body)['id'], (apply['to'] as Body)['id']],
      [200_000, 'transit', M.anaAdmin, xavier.membershipId], 'APPLY: de Ana (vía tránsito) hacia Xavier, no al revés');
    assert.equal((await get(ana, '/v1/movements/cash', { perspective: `admin:${xavier.membershipId}` })).status, 404, 'bolsa ajena: 404');
  });

  test('R74-MOV-004 · filtros, orden, totales y páginas en el servidor', async () => {
    const p = `route:${r1}`;
    const rec = await cash(ana, { perspective: p, group: 'recaudos' });
    assert.ok(rec.rows.length === 3 && rec.rows.every((r) => r['base'] === 'COLLECTION'), 'grupo recaudos (incluye su anulación)');
    assert.deepEqual([rec.filtered['inMinor'], rec.filtered['outMinor']], [5_750, 3_000]);
    assert.deepEqual(rec.summary['inMinor'], (await cash(ana, { perspective: p })).summary['inMinor'], 'el resumen no depende de los filtros de lista');
    assert.deepEqual((await cash(ana, { perspective: p, flow: 'internal' })).rows.map((r) => r['id']), [ids['wt']]);
    assert.ok((await cash(ana, { perspective: p, flow: 'out' })).rows.every((r) => Number(r['outMinor']) > 0));
    const byPerson = await cash(ana, { perspective: p, personId: w2.membershipId });
    assert.deepEqual(byPerson.rows.map((r) => r['id']).sort(), [ids['d2'], ids['wt'], ids['ret']].sort());
    const byClient = await cash(ana, { perspective: p, q: 'mercadinho' });
    assert.ok(byClient.rows.length === 4 && byClient.rows.every((r) => (r['client'] as Body)['id'] === ids['client']), 'búsqueda por nombre de cliente en el servidor');
    assert.equal((await cash(ana, { perspective: p, status: 'anulada' })).rows.length, 1);
    const desc = await cash(ana, { perspective: p, sort: 'amount_desc' });
    assert.ok(desc.rows.every((r, i) => i === 0 || Number(desc.rows[i - 1]!['amountMinor']) >= Number(r['amountMinor'])));
    const all = await cash(ana, { perspective: p });
    const p1 = await cash(ana, { perspective: p, limit: 3 });
    const p2 = await cash(ana, { perspective: p, limit: 3, offset: 3 });
    assert.equal(p1['hasMore'], true);
    assert.equal(new Set([...p1.rows, ...p2.rows].map((r) => r['id'])).size, 6, 'páginas sin solapes');
    assert.equal(p1.filtered['count'], all.rows.length, 'el total filtrado lo da el servidor, no la página');
    const future = await cash(ana, { perspective: p, from: '2099-01-01', to: '2099-01-31' });
    assert.deepEqual([future.rows.length, future.summary['openingMinor'], future.summary['closingMinor']], [0, all.summary['closingMinor'], all.summary['closingMinor']]);
    for (const qs of [{ from: '2026-02-30' }, { from: '2026-10-10', to: '2026-10-01' }, { flow: 'up' }, { group: 'nada' }, { sort: 'x' }, { minAmount: '1.5' }, { offset: 999999 }, { perspective: 'route:../x' }, { perspective: 'galaxy' }]) {
      const r = await get(ana, '/v1/movements/cash', qs as unknown as Record<string, string>);
      assert.ok([400, 404].includes(r.status), `${JSON.stringify(qs)} → ${r.status}`);
    }
  });

  test('R74-MOV-005 · RLS: otra empresa no ve nada; el Cobrador solo su custodia; Secretario sin acceso', async () => {
    assert.equal((await get(hugo, '/v1/movements/cash', { perspective: `route:${r1}` })).status, 404, 'ruta de otra empresa');
    const hugoRows = (await cash(hugo, {})).rows.map((r) => r['id']);
    assert.ok(!hugoRows.some((x) => Object.values(ids).includes(x as string)), 'nada de c1 en c2');
    assert.equal((await get(hugo, '/v1/movements/detail', { id: ids['d1']! })).status, 404, 'detalle ajeno: 404');
    assert.equal((await get(gabi, '/v1/movements/cash')).status, 403, 'Secretaria');
    const persp = (await get(w1.call, '/v1/movements/perspectives')).body as { options: Body[] };
    assert.ok(persp.options.length >= 1 && persp.options.every((o) => o['kind'] === 'custody' && o['membershipId'] === w1.membershipId), 'el Cobrador solo elige su custodia');
    const mine = await cash(w1.call, {});
    reconciles(mine);
    assert.equal(mine.summary['closingMinor'], await sumBalances(`kind = 'custody' and route_id = $2 and membership_id = $3`, [r1, w1.membershipId]));
    assert.ok(mine.rows.every((r) => r['id'] !== ids['d2'] && r['id'] !== ids['ret']), 'no ve las operaciones de otra custodia');
    assert.deepEqual([mine.rows.find((r) => r['id'] === ids['wt'])!['outMinor']], [100_000], 'para él, el traspaso es salida');
    for (const persp2 of [`custody:${r1}:${w2.membershipId}`, `route:${r1}`, `admin:${M.anaAdmin}`, 'company']) {
      assert.equal((await get(w1.call, '/v1/movements/cash', { perspective: persp2 })).status, 403, persp2);
    }
    assert.equal((await get(w1.call, '/v1/movements/activity')).status, 403, 'Actividad no es del Cobrador');
    assert.equal((await get(w1.call, '/v1/movements/detail', { id: ids['d2']! })).status, 404, 'detalle de otra custodia');
    assert.equal((await get(w1.call, '/v1/movements/detail', { id: ids['d1']! })).status, 200, 'detalle de lo suyo');
  });

  test('R74-MOV-006 · Actividad: solo eventos sin dinero, con filtros por grupo y perspectiva', async () => {
    const r = await get(ana, '/v1/movements/activity', { perspective: `route:${r1}`, limit: 200 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rows = r.body['rows'] as Body[];
    assert.deepEqual(rows.filter((x) => x['reference'] === ids['request']).map((x) => x['kind']).sort(), ['SALE_APPROVAL', 'SALE_REQUEST']);
    assert.ok(!rows.some((x) => ['WORKER_DELIVERY', 'COLLECTION', 'LOAN_DISBURSEMENT', 'REVERSAL'].includes(x['kind'] as string)), 'sin operaciones de efectivo');
    const sol = await get(ana, '/v1/movements/activity', { perspective: `route:${r1}`, group: 'solicitudes' });
    assert.ok((sol.body['rows'] as Body[]).every((x) => x['kind'] === 'SALE_REQUEST'));
    assert.equal(sol.body['total'], (sol.body['rows'] as Body[]).length);
    const other = await get(ana, '/v1/movements/activity', { perspective: `route:${rB}` });
    assert.ok(!(other.body['rows'] as Body[]).some((x) => x['reference'] === ids['request']), 'la perspectiva filtra en el servidor');
  });

  test('R74-MOV-007 · detalle: hora de la empresa, partes, patas, anulación vinculada; eventos sin dinero', async () => {
    const d = await get(bruno, '/v1/movements/detail', { id: ids['d1']! });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const mv = d.body['movement'] as Body;
    assert.deepEqual([mv['money'], (mv['from'] as Body)['type'], (mv['to'] as Body)['id'], (mv['route'] as Body)['id']], [true, 'pool', w1.membershipId, r1]);
    const local = (await db.admin.query(`select to_char(o.created_at at time zone c.timezone, 'YYYY-MM-DD HH24:MI:SS') t from adex.capital_operations o join adex.companies c on c.id = o.company_id where o.id = $1`, [ids['d1']])).rows[0].t;
    assert.equal(mv['localAt'], local, 'fecha y hora en la zona horaria de la empresa');
    const legs = d.body['legs'] as Body[];
    assert.deepEqual(legs.map((l) => [(l['account'] as Body)['kind'], l['amountMinor']]), [['admin', -500_000], ['custody', 500_000]]);
    assert.equal(((legs[1]!['account'] as Body)['name']), 'Carlos Uno');
    const revId = (await db.admin.query(`select id from adex.capital_operations where company_id = $1 and kind = 'REVERSAL' and reverses_kind = 'COLLECTION'`, [c1])).rows[0].id;
    const rev = (await get(ana, '/v1/movements/detail', { id: revId })).body['movement'] as Body;
    const orig = (await get(ana, '/v1/movements/detail', { id: rev['reversesOperationId'] as string })).body['movement'] as Body;
    assert.equal(orig['reversedBy'], revId, 'el original enlaza su anulación');
    const ev = await get(ana, '/v1/movements/detail', { id: `req:${ids['request']}` });
    assert.deepEqual([ev.status, (ev.body['movement'] as Body)['kind'], (ev.body['legs'] as Body[]).length], [200, 'SALE_REQUEST', 0]);
    assert.equal((await get(ana, '/v1/movements/detail', { id: 'zzz:1' })).status, 404);
    assert.equal((await get(ana, '/v1/movements/detail', { id: 'no-existe' })).status, 404);
  });

  test('R74-MOV-008 · nombres largos se devuelven completos (la vista abrevia y formatea; nada se altera)', async () => {
    const b = await cash(ana, { perspective: `route:${r1}`, personId: w2.membershipId });
    const d2 = b.rows.find((r) => r['id'] === ids['d2'])!;
    assert.equal((d2['to'] as Body)['name'], LONG, 'nombre completo, tal como se guardó');
    assert.equal((await db.admin.query('select display_name from adex.memberships where id = $1', [w2.membershipId])).rows[0].display_name, LONG);
    const coll = (await cash(ana, { perspective: `route:${r1}`, group: 'recaudos' })).rows[0]!;
    assert.equal((coll['client'] as Body)['name'], 'JOAO DA SILVA - MERCADINHO JK LTDA');
  });

  test('R74-MOV-009 · zona horaria: el día contable es el de la empresa, no el UTC', async () => {
    const utc = (await db.admin.query(`select (now() at time zone 'UTC')::date::text d, extract(hour from now() at time zone 'UTC')::int h`)).rows[0];
    // Zona fija donde la fecha local difiere de la UTC ahora mismo (UTC−12 antes del mediodía UTC; UTC+14 después).
    const tz = utc.h < 12 ? 'Etc/GMT+12' : 'Etc/GMT-14';
    const prev = (await db.admin.query('select timezone from adex.companies where id = $1', [c1])).rows[0].timezone;
    await db.admin.query('update adex.companies set timezone = $2 where id = $1', [c1, tz]);
    try {
      const local = (await db.admin.query(`select (now() at time zone $1)::date::text d, to_char(now() at time zone $1, 'HH24:MI') t`, [tz])).rows[0];
      assert.notEqual(local.d, utc.d, 'la fecha local difiere de la UTC');
      const bruno2 = caller(api, issuer, 'bruno', M.brunoSa);
      const dep = await money(bruno2)('/v1/capital/company/deposits', { amountMinor: 777, reason: 'Depósito en el borde del día' });
      assert.equal(dep.status, 201, JSON.stringify(dep.body));
      const id = (dep.body['operation'] as Body)['id'];
      const inLocal = await cash(bruno2, { perspective: 'company', from: local.d, to: local.d });
      const row = inLocal.rows.find((r) => r['id'] === id)!;
      assert.ok(row, 'pertenece al día local de la empresa');
      assert.equal(row['date'], local.d);
      assert.ok(Math.abs(Number(String(row['localTime']).slice(0, 2)) * 60 + Number(String(row['localTime']).slice(3)) - (Number(local.t.slice(0, 2)) * 60 + Number(local.t.slice(3)))) <= 2, 'hora local de la empresa');
      const inUtc = await cash(bruno2, { perspective: 'company', from: utc.d, to: utc.d });
      assert.ok(!inUtc.rows.some((r) => r['id'] === id), 'no pertenece al día UTC');
      reconciles(inLocal);
    } finally {
      await db.admin.query('update adex.companies set timezone = $2 where id = $1', [c1, prev]);
    }
  });

  test('R74-MOV-010 · operación del libro sin efectivo: va a Actividad y nunca a Dinero; el libro queda limpio', async () => {
    // Si el bloque A (0032) está aplicado, se crea una reclasificación REAL: rectificar la venta con pagos vigentes.
    const kindOk = (await db.admin.query(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'capital_operations_kind_check'`)).rows[0]?.d ?? '';
    if (String(kindOk).includes('PRINCIPAL_RECLASSIFICATION')) {
      const rect = await $ana(`/v1/credits/${ids['sale']}/rectify`, { amountMinor: 50_000, interestRate: 10, installmentsCount: 20, frequency: 'diaria', startDate: today,
        paymentDays: [1, 2, 3, 4, 5, 6], expectedRectifications: 0, reason: 'Tasa autorizada era 10 %', evidence: 'Confirmado con el cliente por teléfono', offlineChecked: true });
      assert.equal(rect.status, 200, JSON.stringify(rect.body));
      ids['noncash'] = (await db.admin.query(`select id from adex.capital_operations where company_id = $1 and kind = 'PRINCIPAL_RECLASSIFICATION'`, [c1])).rows[0].id;
      const route = await cash(ana, { perspective: `route:${r1}` });
      reconciles(route);
      assert.ok(!route.rows.some((r) => r['id'] === ids['noncash']), 'la reclasificación no es una fila de Dinero de la ruta');
      const ra = await get(ana, '/v1/movements/activity', { perspective: `route:${r1}`, group: 'contables' });
      assert.ok((ra.body['rows'] as Body[]).some((x) => x['id'] === ids['noncash']), 'aparece en Actividad («contables») para el Administrador');
      const det = await get(ana, '/v1/movements/detail', { id: ids['noncash'] });
      assert.deepEqual([det.status, (det.body['movement'] as Body)['money']], [200, false], 'su detalle la marca sin efectivo');
    }
    const company = await cash(bruno, { perspective: 'company' });
    assert.ok(company.rows.every((r) => r['kind'] !== 'PRINCIPAL_RECLASSIFICATION'), 'nunca en Dinero');
    const act = await get(bruno, '/v1/movements/activity', { perspective: 'company', group: 'contables', limit: 200 });
    assert.equal(act.status, 200, JSON.stringify(act.body));
    const cashKinds = new Set(['COLLECTION', 'LOAN_DISBURSEMENT', 'WORKER_DELIVERY', 'COMPANY_DEPOSIT']);
    assert.ok((act.body['rows'] as Body[]).every((x) => !cashKinds.has(x['kind'] as string)));
    if (String(kindOk).includes('PRINCIPAL_RECLASSIFICATION')) {
      const n = Number((await db.admin.query(`select count(*) n from adex.capital_operations where company_id = $1 and kind = 'PRINCIPAL_RECLASSIFICATION'`, [c1])).rows[0].n);
      assert.equal((act.body['rows'] as Body[]).filter((x) => x['kind'] === 'PRINCIPAL_RECLASSIFICATION').length, n);
    }
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN, 'Consultas es solo lectura: el libro sigue conciliado');
  });

  test('R74-MOV-011 · /v1/movements de R73 sigue respondiendo igual (compatibilidad del frontend publicado)', async () => {
    const r = await get(ana, '/v1/movements', { limit: 200 });
    assert.equal(r.status, 200);
    const rows = r.body['movements'] as Body[];
    assert.equal(rows.filter((m) => m['id'] === ids['d1']).length, 1);
    assert.deepEqual(Object.keys(rows[0]!).sort(), ['actorId', 'adminId', 'amountMinor', 'at', 'clientId', 'concept', 'counterpartId', 'date', 'expenseId', 'id', 'kind',
      'money', 'paymentId', 'reference', 'reversesKind', 'routeId', 'saleId', 'settlementId', 'status', 'toRouteId', 'workerId'].sort());
  });
});
