// R74 · E1 (decisión del propietario): el SuperAdmin es dueño/supervisor de SU empresa, NO operador
// financiero de las rutas. Ya no recibe devoluciones, no traspasa entre trabajadores, no anula
// operaciones de capital de una ruta, no cierra ni reabre cuadres ni periodos, no registra gastos de
// ruta ni carga gastos a otros y no anula gastos de ruta o de trabajador. Tampoco desembolsa, cobra,
// rectifica ni reaplica (0028/0030/0032). Se prueba en las DOS barreras: la API (matriz única de
// `src/lib/permissions.ts`) y PostgreSQL (0033), llamando a las funciones directamente con el contexto
// del SuperAdmin. Conserva: capital de la empresa (depósitos, retiros, asignaciones y devoluciones de
// bolsas: única entrada de capital hasta diseñar «Base por Ruta»), gasto de EMPRESA, estructura y
// TODA la consulta (conciliación, cuadres, cierres, liquidación, movimientos).
// Consecuencia documentada: una ruta sin Administrador responsable no cierra su periodo hasta que el
// SuperAdmin le asigne uno.

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { SUPERADMIN_NOT_FINANCIAL_OPERATOR } from '@/lib/permissions';
import { companyId, identityOf, routeId } from '../../db/seeds/synthetic.ts';
import { asApi, count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('R74 · E1 · SuperAdmin supervisor, no operador financiero', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  let bruno: Caller, ana: Caller, $bruno: Money, $ana: Money;
  let carlos: Person, dora: Person;
  let cat = '', today = '';
  let deliveryOp = '', workerExp = '', settlementId = '', closureId = '', saleId = '', paymentId = '';
  const brunoCtx = { identityId: identityOf('bruno'), membershipId: M.brunoSa, companyId: c1 };
  const op = () => ({ 'x-adex-operation-id': randomUUID() });
  const fingerprint = async () => Object.fromEntries(await Promise.all(
    ['capital_operations', 'capital_entries', 'expenses', 'custody_settlements', 'weekly_settlements', 'period_closures', 'payments', 'sales']
      .map(async (t) => [t, await count(db.admin, `select 1 from adex.${t} where company_id = $1`, [c1])] as const)));

  before(async () => {
    db = await createTestDb('r74_superadmin', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    cat = (await db.admin.query(`select id from adex.expense_categories where company_id = $1 and active limit 1`, [c1])).rows[0].id;
    carlos = await newPerson(api, issuer, provider.ids, bruno, { email: 'carlos-r74@example.test', role: 'cobrador', displayName: 'Carlos', routeIds: [r1] });
    dora = await newPerson(api, issuer, provider.ids, bruno, { email: 'dora-r74@example.test', role: 'supervisor', displayName: 'Dora', routeIds: [r1] });
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético R74' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 3_000_000, reason: 'Bolsa de Ana' }],
    ] as const) assert.equal((await $bruno(path, body)).status, 201, path);
    const d = await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 100_000, reason: 'Base de Carlos' });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    deliveryOp = (d.body['operation'] as Body)['id'] as string;
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: dora.membershipId, amountMinor: 50_000, reason: 'Base de Dora' })).status, 201);
    const e = await carlos.money('/v1/expenses', { scope: 'trabajador', routeId: r1, workerId: carlos.membershipId, categoryId: cat, amountMinor: 1_000, description: 'Combustible' });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    workerExp = (e.body['expense'] as Body)['id'] as string;
    // Un cuadre cerrado por la responsable (para intentar reabrirlo) y un periodo pasado cerrado.
    const p = (await ana('GET', `/v1/settlements/preview?routeId=${r1}&workerId=${dora.membershipId}`)).body;
    const s = await $ana('/v1/settlements', { routeId: r1, workerId: dora.membershipId, deliveredMinor: 50_000, expectedSeenMinor: p['expectedPositionMinor'], previousSettlementId: p['previousSettlementId'] ?? null });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    settlementId = (s.body['settlement'] as Body)['id'] as string;
    const c = await $ana('/v1/periods/close', { routeId: r1, weekStart: '2026-09-28', weekEnd: '2026-10-04', note: 'Cierre de prueba' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    closureId = c.body['closureId'] as string;
    // Un crédito con un cobro (para intentar rectificar y reaplicar).
    const cl = await ana('POST', '/v1/clients', { routeId: r1, name: 'Cliente R74', documentType: 'CPF', document: String(10_000_000_000 + (Number.parseInt(randomBytes(4).toString('hex'), 16) % 89_999_999_999)),
      phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' });
    assert.equal(cl.status, 201, JSON.stringify(cl.body));
    const cr = await $ana('/v1/credits/direct', { routeId: r1, clientId: cl.body['id'], amountMinor: 50_000, interestRate: 20, installmentsCount: 10,
      frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
    assert.equal(cr.status, 201, JSON.stringify(cr.body));
    saleId = (cr.body['credit'] as Body)['id'] as string;
    const pay = await carlos.money('/v1/collections', { saleId, amountMinor: 6_000 });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    paymentId = pay.body['paymentId'] as string;
  });
  after(async () => { await api.close(); await db.close(); });

  test('R74-SA-001 · API: cada operación financiera de ruta retirada responde 403 y nada cambia', async () => {
    const p = (await bruno('GET', `/v1/settlements/preview?routeId=${r1}&workerId=${carlos.membershipId}`)).body;
    const before = await fingerprint();
    const attempts: [string, string, Body, string][] = [
      ['POST', '/v1/capital/returns', { routeId: r1, workerId: carlos.membershipId, amountMinor: 1_000, reason: 'Recibe el SuperAdmin' }, '1 devolución del trabajador'],
      ['POST', '/v1/capital/worker-transfers', { routeId: r1, fromWorkerId: carlos.membershipId, toWorkerId: dora.membershipId, amountMinor: 1_000, reason: 'Traspaso' }, '2 traspaso entre trabajadores'],
      ['POST', `/v1/capital/operations/${deliveryOp}/reverse`, { reason: 'Anula el SuperAdmin' }, '3 anulación de operación de ruta'],
      ['POST', '/v1/settlements', { routeId: r1, workerId: carlos.membershipId, deliveredMinor: p['expectedPositionMinor'], expectedSeenMinor: p['expectedPositionMinor'], previousSettlementId: p['previousSettlementId'] ?? null }, '4 cierre de cuadre'],
      ['POST', `/v1/settlements/${settlementId}/reopen`, { reason: 'Reabre el SuperAdmin' }, '5 reapertura de cuadre'],
      ['POST', '/v1/periods/close', { routeId: r1, weekStart: '2026-10-05', weekEnd: '2026-10-11', note: 'Cierre' }, '6a cierre de periodo'],
      ['POST', `/v1/periods/${closureId}/reopen`, { reason: 'Reapertura pedida por el SuperAdmin' }, '6b reapertura de periodo'],
      ['POST', '/v1/expenses', { scope: 'trabajador', routeId: r1, workerId: carlos.membershipId, categoryId: cat, amountMinor: 500, description: 'Cargado por el SuperAdmin' }, '7a gasto cargado a otro'],
      ['POST', '/v1/expenses', { scope: 'ruta', routeId: r1, categoryId: cat, amountMinor: 500, description: 'Gasto de ruta' }, '7b gasto de ruta'],
      ['POST', `/v1/expenses/${workerExp}/reverse`, { reason: 'Anula el SuperAdmin' }, '8 anulación de gasto de trabajador'],
      ['POST', '/v1/credits/direct', { routeId: r1, clientId: 'x', amountMinor: 1, interestRate: 20, installmentsCount: 1, frequency: 'diaria', startDate: today, paymentDays: [1] }, 'desembolso (venta directa)'],
      ['POST', '/v1/collections', { saleId, amountMinor: 1_000 }, 'cobro'],
      ['POST', `/v1/credits/${saleId}/rectify`, { amountMinor: 40_000, reason: 'Rectifica el SuperAdmin', evidence: 'x', expectedRectifications: 0 }, 'rectificación'],
      ['POST', `/v1/collections/${paymentId}/reapply`, { reason: 'Reaplica el SuperAdmin' }, 'reaplicación de pago'],
    ];
    for (const [method, path, body, label] of attempts) {
      const r = await bruno(method, path, body, op());
      assert.equal(r.status, 403, `${label}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.deepEqual(await fingerprint(), before, 'ningún intento escribió');
    const caps = (await bruno('GET', '/v1/context')).body['capabilities'] as string[];
    assert.deepEqual(SUPERADMIN_NOT_FINANCIAL_OPERATOR.filter((c) => caps.includes(c)), [], 'el contexto no anuncia ninguna');
  });

  test('R74-SA-002 · PostgreSQL: con el contexto del SuperAdmin las funciones de dinero se niegan aunque se salte la API', async () => {
    const r2 = await db.admin.query(`select oidvectortypes(proargtypes) t from pg_proc where oid = 'adex.credit_rectify'::regproc`);
    const rectifyArgs = (r2.rows[0].t as string).split(', ').slice(1).map((t) => `null::${t}`).join(', ');
    const before = await fingerprint();
    await asApi(db.api, brunoCtx, async (q) => {
      const cases: [string, unknown[], string, string][] = [
        [`select adex.capital_post(p_operation_id => gen_random_uuid(), p_kind => 'WORKER_RETURN', p_amount => 1000, p_reason => 'Recibe el SuperAdmin', p_route => $1, p_worker => $2)`, [r1, carlos.membershipId], 'AX402', '1 devolución'],
        [`select adex.capital_post(p_operation_id => gen_random_uuid(), p_kind => 'WORKER_TRANSFER', p_amount => 1000, p_reason => 'Traspaso', p_route => $1, p_worker => $2, p_counterpart => $3)`, [r1, carlos.membershipId, dora.membershipId], 'AX402', '2 traspaso'],
        [`select adex.capital_post(p_operation_id => gen_random_uuid(), p_kind => 'REVERSAL', p_amount => null, p_reason => 'Anula el SuperAdmin', p_reverses => $1)`, [deliveryOp], 'AX402', '3 anulación'],
        ['select adex.custody_settle(gen_random_uuid(), $1, $2, 1000, 1000, null, null)', [r1, carlos.membershipId], '42501', '4 cuadre'],
        [`select adex.custody_settlement_reopen(gen_random_uuid(), $1, 'Reabre el SuperAdmin')`, [settlementId], '42501', '5 reapertura de cuadre'],
        [`select adex.period_close(gen_random_uuid(), $1, '2026-10-05', '2026-10-11', 'Cierre')`, [r1], '42501', '6a cierre de periodo'],
        [`select adex.period_reopen(gen_random_uuid(), $1, 'Reapertura pedida por el SuperAdmin')`, [closureId], '42501', '6b reapertura de periodo'],
        [`select adex.expense_post(gen_random_uuid(), 'trabajador', $1, $2, $3, 500, 'Cargado por el SuperAdmin', null, null, null)`, [r1, carlos.membershipId, cat], '42501', '7a gasto a otro'],
        [`select adex.expense_post(gen_random_uuid(), 'ruta', $1, null, $2, 500, 'Gasto de ruta', null, null, null)`, [r1, cat], '42501', '7b gasto de ruta'],
        [`select adex.expense_reverse(gen_random_uuid(), $1, 'Anula el SuperAdmin')`, [workerExp], 'AX402', '8 anulación de gasto'],
        [`select * from adex.credit_disburse(gen_random_uuid(), null, $1, 'x', 1000, 20, 1, 'diaria', current_date, array[1]::smallint[], '[]'::jsonb, null)`, [r1], 'AX402', 'desembolso'],
        [`select adex.collection_post(gen_random_uuid(), $1, 1000, $2, null)`, [saleId, carlos.membershipId], '42501', 'cobro'],
        [`select adex.credit_rectify(gen_random_uuid(), ${rectifyArgs})`, [], 'AX402', 'rectificación'],
        [`select adex.collection_reapply(gen_random_uuid(), $1, 'Reaplica el SuperAdmin')`, [paymentId], 'AX402', 'reaplicación'],
      ];
      for (const [sql, args, code, label] of cases) {
        await q.query('savepoint s');
        await assert.rejects(q.query(sql, args), { code }, label);
        await q.query('rollback to savepoint s');
      }
      for (const cap of SUPERADMIN_NOT_FINANCIAL_OPERATOR) {
        assert.equal((await q.query('select adex.ctx_can($1) ok', [cap])).rows[0].ok, false, cap);
      }
      for (const cap of ['expense.register', 'expense.correct', 'cashSettlement.view', 'cashbox.viewRoute', 'cashbox.viewConsolidated', 'payment.viewHistory']) {
        assert.equal((await q.query('select adex.ctx_can($1) ok', [cap])).rows[0].ok, true, `${cap} se conserva`);
      }
    });
    assert.deepEqual(await fingerprint(), before);
    // Sin ramas `superadmin` de operación en las funciones redefinidas (la rama muerta de 0018 incluida).
    const def = async (fn: string) => (await db.admin.query(`select pg_get_functiondef($1::regproc) d`, [fn])).rows[0].d as string;
    for (const fn of ['adex.custody_settle', 'adex.custody_settlement_reopen', 'adex.period_close', 'adex.period_reopen', 'adex.credit_disburse']) {
      assert.ok(!(await def(fn)).includes("'superadmin'"), `${fn} sin rama del SuperAdmin`);
    }
    assert.ok(!(await def('adex.capital_post')).includes('or the SuperAdmin'), 'capital_post: el SuperAdmin solo en el capital de la empresa');
    assert.ok(!(await def('adex.capital_post')).includes("or v_role = 'superadmin'"));
    assert.ok(!(await def('adex.expense_post')).includes("or x.role = 'superadmin'"));
    assert.ok(!/x\.role (<>|=) 'superadmin' then\s+perform adex\.capital_raise\('AX402', 'only the route/.test(await def('adex.expense_correctable')));
  });

  test('R74-SA-003 · el SuperAdmin sigue CONSULTANDO todo: conciliación, cuadres, cierres, liquidación y movimientos', async () => {
    const rec = await bruno('GET', '/v1/capital/reconciliation');
    assert.equal(rec.status, 200);
    assert.equal(rec.body['ok'], true, JSON.stringify(rec.body));
    for (const path of ['/v1/settlements', `/v1/settlements/${settlementId}`, `/v1/settlements/preview?routeId=${r1}&workerId=${carlos.membershipId}`,
      `/v1/settlements/workers?routeId=${r1}`, '/v1/periods', `/v1/periods/${closureId}`, `/v1/periods/liquidation?routeId=${r1}&from=2026-09-28&to=2026-10-04`,
      '/v1/periods/calendar', '/v1/movements', '/v1/capital/summary', '/v1/capital/custody', '/v1/expenses', '/v1/collections', '/v1/credits']) {
      const r = await bruno('GET', path);
      assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    assert.ok(((await bruno('GET', '/v1/settlements')).body['settlements'] as Body[]).some((s) => s['id'] === settlementId));
    assert.ok(((await bruno('GET', '/v1/periods')).body['closures'] as Body[]).length >= 1);
  });

  test('R74-SA-004 · conserva el capital de la empresa y el gasto de empresa (bloqueado por decisión «Base por Ruta»)', async () => {
    assert.equal((await $bruno('/v1/capital/company/deposits', { amountMinor: 100_000, reason: 'Más capital' })).status, 201);
    const alloc = await $bruno('/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 20_000, reason: 'Asignación duplicada' });
    assert.equal(alloc.status, 201);
    // 0039 (RB-D11, propietario 2026-10-27): el SuperAdmin conserva el capital de la empresa pero ya NO anula nada.
    assert.equal((await $bruno(`/v1/capital/operations/${(alloc.body['operation'] as Body)['id']}/reverse`, { reason: 'Asignación duplicada' })).status, 403, 'no anula operaciones de la EMPRESA');
    assert.equal((await $bruno('/v1/capital/admin-returns', { adminId: M.anaAdmin, amountMinor: 10_000, reason: 'Recoge capital' })).status, 201);
    assert.equal((await $bruno('/v1/capital/company/withdrawals', { amountMinor: 5_000, reason: 'Retiro sintético' })).status, 201);
    const exp = await $bruno('/v1/expenses', { scope: 'empresa', categoryId: cat, amountMinor: 1_000, description: 'Papelería', fundingSource: 'empresa' });
    assert.equal(exp.status, 201, JSON.stringify(exp.body));
    assert.equal((await $bruno(`/v1/expenses/${(exp.body['expense'] as Body)['id']}/reverse`, { reason: 'Gasto duplicado' })).status, 403, 'no anula gastos de empresa (RB-D11)');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('R74-SA-005 · los demás conservan su autoridad: la responsable anula, la Supervisora recibe y cuadra', async () => {
    assert.equal((await dora.money('/v1/capital/returns', { routeId: r1, workerId: carlos.membershipId, amountMinor: 1_000, reason: 'Recibe la Supervisora' })).status, 201);
    assert.equal((await $ana('/v1/capital/worker-transfers', { routeId: r1, fromWorkerId: carlos.membershipId, toWorkerId: dora.membershipId, amountMinor: 1_000, reason: 'Traspaso' })).status, 201);
    assert.equal((await $ana(`/v1/expenses/${workerExp}/reverse`, { reason: 'Gasto mal cargado' })).status, 201);
    const p = (await dora.call('GET', `/v1/settlements/preview?routeId=${r1}&workerId=${carlos.membershipId}`)).body;
    const s = await dora.money('/v1/settlements', { routeId: r1, workerId: carlos.membershipId, deliveredMinor: p['expectedPositionMinor'], expectedSeenMinor: p['expectedPositionMinor'], previousSettlementId: p['previousSettlementId'] ?? null });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal((await $ana(`/v1/periods/${closureId}/reopen`, { reason: 'Revisión de la semana cerrada' })).status, 200);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('R74-SA-006 · consecuencia: una ruta sin Administrador responsable no cierra su periodo hasta que el SuperAdmin le asigne uno', async () => {
    const created = await bruno('POST', '/v1/routes', { name: 'Ruta sin responsable R74', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [] }, op());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const rx = created.body['id'] as string;
    const close = (m: Money) => m('/v1/periods/close', { routeId: rx, weekStart: '2026-09-28', weekEnd: '2026-10-04', note: 'Cierre' });
    assert.equal((await close($bruno)).status, 403, 'el SuperAdmin no cierra periodos');
    assert.equal((await close($ana)).status, 404, 'la ruta aún no es de Ana');
    await asApi(db.api, brunoCtx, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(q.query(`select adex.period_close(gen_random_uuid(), $1, '2026-09-28', '2026-10-04', 'Cierre')`, [rx]), { code: '42501' });
      await q.query('rollback to savepoint s');
    });
    // El SuperAdmin asigna la ruta a Ana (función estructural que conserva): pasa a ser la responsable y cierra.
    const routes = ((await ana('GET', '/v1/context')).body['routeIds'] as string[]);
    assert.equal((await bruno('PUT', `/v1/members/${M.anaAdmin}/routes`, { routeIds: [...routes, rx] })).status, 200);
    const ctrl = (await db.admin.query('select capital_controller_membership_id c from adex.routes where id = $1', [rx])).rows[0].c;
    assert.equal(ctrl, M.anaAdmin);
    const ok = await close($ana);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });
});
