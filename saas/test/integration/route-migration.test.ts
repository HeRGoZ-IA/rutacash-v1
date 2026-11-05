// 0043 · Migración de rutas con historial, parte 1: estado «en migración» por ruta (decisiones de Helmer 2026-11-04),
// contra PostgreSQL real y la API (datos 100 % sintéticos).
//   · Solo el SuperAdmin abre y cancela; solo sobre una ruta activa, vacía y con Base por Ruta.
//   · En migración la ruta es de solo lectura (bloqueo en PostgreSQL); el resto de la empresa sigue igual.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf, routeId } from '../../db/seeds/synthetic.ts';
import { asApi, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('0043 · ruta en migración', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const [r1, r3] = [routeId('c1', 1), routeId('c1', 3)];
  let bruno: Caller, $bruno: Money, ana: Caller, $ana: Money;
  let edu: Person;
  let rm = '';

  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const newClient = (who: Caller, route: string) => who('POST', '/v1/clients', {
    routeId: route, name: `CLIENTE MIGRACION ${randomUUID().slice(0, 6)}`, documentType: 'CPF', document: cpf(),
    phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' });
  const expectCode = (r: { status: number; body: Body }, status: number, code: string, label: string) => {
    assert.equal(r.status, status, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body['error'], code, `${label}: ${JSON.stringify(r.body)}`);
  };
  const state = async (route: string) => (await db.admin.query<{ s: string }>('select migration_state s from adex.routes where id = $1', [route])).rows[0]!.s;
  const open = (who: Money, route: string, body: Body = {}, op?: string) =>
    who(`/v1/routes/${route}/migration`, { sourceRouteName: 'VALPARAISO SOC GAJ (sintética)', note: 'Prueba local', ...body }, op);
  const cancel = (who: Money, route: string, reason = 'Prueba local: se cancela la migración', op?: string) =>
    who(`/v1/routes/${route}/migration/cancel`, { reason }, op);

  before(async () => {
    db = await createTestDb('route_migration', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    // Base por Ruta (como en r74-consultas-routebase): r3 activa con responsable, disponible de la empresa a cero, «migrando» y corte.
    edu = await newPerson(api, issuer, provider.ids, bruno, { email: 'edu-rm@example.test', role: 'admin', displayName: 'Edu', routeIds: [r3] });
    const of2 = (await db.admin.query(`select id from adex.offices where company_id = $1 and code = 'OF-2'`, [c1])).rows[0].id as string;
    assert.equal((await bruno('POST', `/v1/offices/${of2}/status`, { status: 'activa' })).status, 200);
    assert.equal((await bruno('POST', `/v1/routes/${r3}/status`, { status: 'activa' })).status, 200);
    const r3ctrl = (await db.admin.query('select capital_controller_membership_id c from adex.routes where id = $1', [r3])).rows[0].c;
    if (r3ctrl !== edu.membershipId) {
      assert.equal((await bruno('PUT', `/v1/routes/${r3}/capital-controller`, { membershipId: edu.membershipId, reason: 'Responsable de r3' })).status, 200);
    }
    const company = await balance(db.admin, c1, 'company', null);
    if (company > 0) assert.equal((await $bruno('/v1/capital/company/withdrawals', { amountMinor: company, reason: 'Disponible a cero antes del corte' })).status, 201);
    const mig = await $bruno('/v1/capital/model', { target: 'migrating', evidence: 'Migración autorizada para la prueba local', backupReference: 'backup-local-rm' });
    assert.equal(mig.status, 200, JSON.stringify(mig.body));
    const act = await $bruno('/v1/capital/model', { target: 'route_base', evidence: 'Corte autorizado para la prueba local', backupReference: 'backup-local-rm' });
    assert.equal(act.status, 200, JSON.stringify(act.body));
    // Ruta nueva y vacía para la migración, con Ana como Administradora (responsable).
    const r = await bruno('POST', '/v1/routes', { name: 'Ruta Migrada', interestRate: 20, freeRate: false, maxLoanMinor: 500_000, adminIds: [M.anaAdmin] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    rm = r.body['id'] as string;
    assert.equal(r.body['migrationState'], 'normal');
  });
  after(async () => { await api?.close(); await db?.close(); });

  test('RM-001 · solo el SuperAdmin abre la migración, y solo sobre una ruta activa y vacía', async () => {
    expectCode(await open($ana, rm), 403, 'PERMISSION_DENIED', 'Administradora');
    expectCode(await bruno('POST', `/v1/routes/${rm}/migration`, { sourceRouteName: 'Sin operación' }), 400, 'OPERATION_ID_REQUIRED', 'sin X-Adex-Operation-Id');
    expectCode(await open($bruno, rm, { sourceRouteName: ' ' }), 400, 'INVALID_INPUT', 'sin nombre de origen');
    // r1 tiene clientes, ventas y movimientos: no se puede poner en migración.
    const busy = await open($bruno, r1);
    expectCode(busy, 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'ruta con datos');
    assert.equal(await state(r1), 'normal');

    const op = randomUUID();
    const ok = await open($bruno, rm, {}, op);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body['status'], 'en_migracion');
    assert.equal(ok.body['sourceRouteName'], 'VALPARAISO SOC GAJ (sintética)');
    assert.equal(await state(rm), 'en_migracion');
    // Reintento con la misma operación: misma respuesta, nada duplicado.
    const again = await open($bruno, rm, {}, op);
    assert.equal(again.status, 201);
    assert.deepEqual(again.body, ok.body);
    expectCode(await open($bruno, rm), 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'ya en migración');
    assert.equal(Number((await db.admin.query(`select count(*) n from adex.route_migrations where route_id = $1`, [rm])).rows[0].n), 1);
    // La ruta muestra su estado y la migración es visible para el SuperAdmin y para la Administradora de la ruta.
    const route = await bruno('GET', `/v1/routes/${rm}`);
    assert.equal(route.body['migrationState'], 'en_migracion', JSON.stringify(route.body));
    for (const who of [bruno, ana]) {
      const l = await who('GET', `/v1/route-migrations?routeId=${rm}`);
      assert.equal(l.status, 200, JSON.stringify(l.body));
      assert.deepEqual((l.body['migrations'] as Body[]).map((m) => [m['routeId'], m['status']]), [[rm, 'en_migracion']]);
    }
    const audit = (await db.admin.query(`select action from adex.audit_log where route_id = $1 and action like 'ROUTE_MIGRATION%'`, [rm])).rows.map((x) => x.action);
    assert.deepEqual(audit, ['ROUTE_MIGRATION_OPENED']);
  });

  test('RM-002 · en migración la ruta es de solo lectura (PostgreSQL); las demás rutas siguen igual', async () => {
    expectCode(await newClient(ana, rm), 409, 'ROUTE_IN_MIGRATION', 'cliente nuevo');
    expectCode(await $ana('/v1/capital/route-base/injections', { routeId: rm, amountMinor: 10_000, reason: 'Base en ruta migrada' }), 409, 'ROUTE_IN_MIGRATION', 'inyección de Base');
    assert.equal(await balance(db.admin, c1, 'route_base', null, rm), 0);
    // Segunda barrera sin la API: adex_api con contexto no cambia el estado de migración.
    await assert.rejects(asApi(db.api, { identityId: identityOf('bruno'), membershipId: M.brunoSa, companyId: c1 },
      (q) => q.query(`update adex.routes set migration_state = 'normal' where id = $1`, [rm])), { code: '42501' }, 'adex_api no cambia el estado');
    assert.equal(await state(rm), 'en_migracion');
    // Ni el propietario del esquema escribe ventas en la ruta fuera de una carga de migración.
    await assert.rejects(db.admin.query(
      `insert into adex.clients (id, company_id, route_id, name, document, phone_primary, address_primary, status, created_at, updated_at)
       values ($1, $2, $3, 'X', '1', '1', 'a', 'activo', now(), now())`, [randomUUID(), c1, rm]), { code: 'AX443' }, 'alta directa bloqueada');
    // El resto de la empresa sigue normal.
    assert.equal((await newClient(ana, r1)).status, 201, 'cliente en otra ruta');
    // Editar la ruta (nombre) sigue permitido.
    const put = await bruno('PATCH', `/v1/routes/${rm}`, { name: 'Ruta Migrada Valparaíso' });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body['migrationState'], 'en_migracion');
  });

  test('RM-003 · cancelar: solo el SuperAdmin, con motivo; la ruta vuelve a normal y ya no está vacía para reabrir', async () => {
    expectCode(await cancel($ana, rm), 403, 'PERMISSION_DENIED', 'Administradora');
    expectCode(await cancel($bruno, rm, 'corto'), 400, 'INVALID_INPUT', 'motivo corto');
    const ok = await cancel($bruno, rm);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body['status'], 'cancelada');
    assert.equal(await state(rm), 'normal');
    expectCode(await cancel($bruno, rm), 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'sin migración abierta');
    assert.equal((await newClient(ana, rm)).status, 201, 'la ruta vuelve a operar');
    expectCode(await open($bruno, rm), 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'ya tiene clientes');
    const l = await bruno('GET', `/v1/route-migrations?routeId=${rm}`);
    assert.deepEqual((l.body['migrations'] as Body[]).map((m) => m['status']), ['cancelada']);
  });

  test('RM-005 · cierres diarios de Listos: vista previa, carga por día (abonos en Listos sin caja), finalización y operación normal', async () => {
    // Ruta nueva, vacía, con Ana como Administradora responsable; se pone en migración.
    const nr = await bruno('POST', '/v1/routes', { name: 'Ruta Migrada Final', interestRate: 20, freeRate: false, maxLoanMinor: 500_000, adminIds: [M.anaAdmin] });
    assert.equal(nr.status, 201, JSON.stringify(nr.body));
    const rf = nr.body['id'] as string;
    assert.equal((await open($bruno, rf)).status, 201);
    const today = (await db.admin.query<{ d: string }>(`select to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') d from adex.companies where id = $1`, [c1])).rows[0]!.d;
    const day = (n: number) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const sched = (from: number, step: number, amounts: number[]) => amounts.map((a, k) => ({ number: k + 1, dueDate: day(from + k * step), amountMinor: a }));
    const docs = [cpf(), cpf()];
    const clients = (c3active: boolean) => [
      { code: 'C1', name: 'CLIENTE LISTOS UNO', document: docs[0], documentType: 'CPF', phone: '61999990001', address: 'Rua sintética 1', active: true },
      { code: 'C2', name: 'CLIENTE LISTOS DOS', document: docs[1], documentType: 'CPF', phone: '61999990002', address: 'Rua sintética 2', active: !c3active },
      { code: 'C3', name: 'CLIENTE LISTOS TRES', document: 'X12345', documentType: null, phone: '', address: '', active: c3active },
    ];
    // K1 (diario, 20 × 60,00 = 1.200,00; capital 1.000,00): pagadas 8 → saldo 720,00 en 12 cuotas, 4 vencidas.
    // K2 (semanal, 4 × 300,00): saldo 450,00.
    const k1 = (balance: number, from: number, n: number) => ({ code: 'K1', clientCode: 'C1', grantedOn: day(-13), valueMinor: 100_000, totalMinor: 120_000, rate: 20,
      installmentsCount: 20, installmentValueMinor: 6_000, frequency: 'diaria', paymentDays: [0, 1, 2, 3, 4, 5, 6], balanceMinor: balance, overdueListos: 4,
      lastPaymentOn: day(-3), schedule: sched(from, 1, Array<number>(n).fill(6_000)) });
    const k2 = { code: 'K2', clientCode: 'C2', grantedOn: day(-15), valueMinor: 100_000, totalMinor: 120_000, rate: 20, installmentsCount: 4, installmentValueMinor: 30_000,
      frequency: 'semanal', paymentDays: [1], balanceMinor: 45_000, overdueListos: 0, lastPaymentOn: day(-2), schedule: sched(-1, 7, [15_000, 30_000]) };
    const k0 = { code: 'K0', clientCode: 'C3', grantedOn: day(-300), valueMinor: 50_000, totalMinor: 60_000, installmentsCount: 20, frequency: 'diaria', lastPaymentOn: day(-250) };
    const paidK2 = { code: 'K2', clientCode: 'C2', grantedOn: day(-15), valueMinor: 100_000, totalMinor: 120_000, installmentsCount: 4, frequency: 'semanal', lastPaymentOn: day(-1) };
    const k3 = { code: 'K3', clientCode: 'C3', grantedOn: day(-1), valueMinor: 50_000, totalMinor: 60_000, rate: 20, installmentsCount: 2, installmentValueMinor: 30_000,
      frequency: 'semanal', paymentDays: [1], balanceMinor: 60_000, overdueListos: 0, lastPaymentOn: null, schedule: sched(6, 7, [30_000, 30_000]) };
    // Cierre 1 (anteayer) y cierre 2 (ayer): K1 bajó 120,00 (dos cuotas), K2 se pagó, C3 renovó con K3.
    const day1 = () => ({ sourceRouteName: 'VALPARAISO SOC GAJ (sintética)', reportDate: day(-2),
      control: { clients: 3, activeCredits: 2, balanceMinor: 72_000 + 45_000 }, listos: { cajaMinor: -158_000, carteraMinor: 117_000 },
      clients: clients(false), credits: [k1(72_000, -4, 12), k2], history: [k0] });
    const day2 = () => ({ sourceRouteName: 'VALPARAISO SOC GAJ (sintética)', reportDate: day(-1),
      control: { clients: 3, activeCredits: 2, balanceMinor: 60_000 + 60_000 }, listos: { cajaMinor: 10_000, carteraMinor: 120_000 },
      clients: clients(true), credits: [k1(60_000, -2, 10), k3], history: [k0, paidK2] });
    const preview = (p: Body) => bruno('POST', `/v1/routes/${rf}/migration/preview`, { payload: p });
    const load = (p: Body, op?: string) => $bruno(`/v1/routes/${rf}/migration/loads`, { payload: p }, op);
    const sales = async () => (await db.admin.query(`select s.sale_value_minor v, s.total_value_minor t, s.balance_minor b, s.installments_count n, s.status,
        (select count(*) from adex.installments i where i.sale_id = s.id and i.status = 'vencida')::int overdue
      from adex.sales s where s.route_id = $1 order by s.created_at, s.balance_minor desc`, [rf])).rows.map((x) => [Number(x.v), Number(x.t), Number(x.b), x.n, x.status, x.overdue]);

    // Solo el SuperAdmin.
    expectCode(await ana('POST', `/v1/routes/${rf}/migration/preview`, { payload: day1() }), 403, 'PERMISSION_DENIED', 'vista previa de la Administradora');
    expectCode(await $ana(`/v1/routes/${rf}/migration/loads`, { payload: day1() }), 403, 'PERMISSION_DENIED', 'carga de la Administradora');
    // Vista previa con datos que no cuadran: dice qué falla y no guarda nada.
    const bad = day1(); bad.control.balanceMinor += 100;
    const pb = await preview(bad);
    assert.equal(pb.status, 200, JSON.stringify(pb.body) + ' ' + String((api.errors.at(-1) as Error | undefined)?.message));
    assert.equal(pb.body['valid'], false);
    assert.match(String(pb.body['problem']), /does not match the report/);
    const bad2 = day1(); bad2.credits[0]!.schedule[11]!.amountMinor = 5_000;
    assert.match(String((await preview(bad2)).body['problem']), /K1: the schedule/);
    expectCode(await load(bad), 422, 'ROUTE_MIGRATION_INVALID_DATA', 'carga que no cuadra');
    assert.equal(Number((await db.admin.query('select count(*) n from adex.clients where route_id = $1', [rf])).rows[0].n), 0, 'nada se escribió');
    expectCode(await $bruno(`/v1/routes/${rf}/migration/close`, {}), 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'finalizar sin cierres');

    // Cierre 1: la ruta se ve con sus datos y SIGUE en migración (solo lectura).
    const pv = await preview(day1());
    assert.equal(pv.body['valid'], true, JSON.stringify(pv.body));
    assert.equal(pv.body['creditsOverdue'], 2);
    const op1 = randomUUID();
    const l1 = await load(day1(), op1);
    assert.equal(l1.status, 201, JSON.stringify(l1.body));
    assert.deepEqual((await load(day1(), op1)).body, l1.body, 'reintento: misma respuesta');
    assert.equal(l1.body['firstLoad'], true);
    assert.equal(await state(rf), 'en_migracion');
    assert.deepEqual(await sales(), [[60_000, 72_000, 72_000, 12, 'activa', 4], [37_500, 45_000, 45_000, 2, 'activa', 1]]);
    assert.equal(await balance(db.admin, c1, 'portfolio', null, rf), 97_500);
    expectCode(await newClient(ana, rf), 409, 'ROUTE_IN_MIGRATION', 'la ruta sigue de solo lectura');
    expectCode(await cancel($bruno, rf), 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'cancelar con cierres cargados');
    expectCode(await load(day1()), 422, 'ROUTE_MIGRATION_INVALID_DATA', 'el mismo cierre otra vez');

    // Un saldo que SUBE se detiene.
    const up = day2(); up.credits[0] = k1(73_000, -2, 10); up.credits[0].schedule[9]!.amountMinor = 19_000; up.control.balanceMinor = 73_000 + 60_000;
    assert.match(String((await preview(up)).body['problem']), /K1: the balance went up/);

    // Cierre 2: abono en Listos en K1, K2 pagado (finalizada), cliente C3 renueva con K3.
    const l2 = await load(day2());
    assert.equal(l2.status, 201, JSON.stringify(l2.body));
    assert.equal(l2.body['newCredits'], 1);
    assert.equal(l2.body['creditsWithPayments'], 1);
    assert.equal(l2.body['creditsPaidOff'], 1);
    assert.equal(l2.body['collectedInListosMinor'], 12_000 + 45_000);
    assert.deepEqual(await sales(), [[60_000, 72_000, 60_000, 12, 'activa', 2], [37_500, 45_000, 0, 2, 'finalizada', 0], [50_000, 60_000, 60_000, 2, 'activa', 0]]);
    const pays = (await db.admin.query(`select p.amount_minor a, p.payment_date::text d, p.collector_membership_id c, o.kind
        from adex.payments p join adex.capital_operations o on o.id = p.ledger_operation_id where p.route_id = $1 order by p.amount_minor`, [rf])).rows;
    assert.deepEqual(pays.map((x) => [Number(x.a), x.d, x.c, x.kind]), [[12_000, day(-1), M.anaAdmin, 'MIGRATION_COLLECTION'], [45_000, day(-1), M.anaAdmin, 'MIGRATION_COLLECTION']]);
    assert.equal(await balance(db.admin, c1, 'route_base', null, rf), 0, 'ninguna caja se movió');
    assert.equal(await balance(db.admin, c1, 'portfolio', null, rf), 60_000 - 10_000 + 50_000);
    const c3 = (await db.admin.query(`select status from adex.clients where route_id = $1 and notes = 'Cliente migrado (código C3)'`, [rf])).rows[0].status;
    assert.equal(c3, 'activo', 'el cliente que renovó queda activo');
    // 0046: ningún texto visible lleva el nombre del sistema anterior.
    const texts = (await db.admin.query(`select note t from adex.payments where route_id = $1
        union all select reason from adex.capital_operations where route_id = $1 and kind like 'MIGRATION%'
        union all select notes from adex.clients where route_id = $1
        union all select description from adex.audit_log where route_id = $1 and action like 'ROUTE_MIGRATION%'`, [rf])).rows.map((x) => String(x.t));
    assert.deepEqual(texts.filter((t) => /listos/i.test(t)), []);
    assert.ok(texts.includes('Abono previo a la migración (crédito K2 pagado)'), texts.join(' | '));
    assert.ok(texts.includes('Cartera migrada (crédito K3)'), texts.join(' | '));
    const list = await bruno('GET', `/v1/route-migrations?routeId=${rf}`);
    assert.deepEqual(((list.body['migrations'] as Body[])[0]!['loads'] as Body[]).map((x) => x['reportDate']), [day(-1), day(-2)]);

    // Finalizar: la ruta queda normal; luego la Administradora abre la caja y se cobra un crédito migrado.
    const fin = await $bruno(`/v1/routes/${rf}/migration/close`, { note: 'Cierre del domingo cargado' });
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    assert.equal(fin.body['status'], 'finalizada');
    assert.equal(await state(rf), 'normal');
    expectCode(await load(day2()), 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'cargar tras finalizar');
    const audit = (await db.admin.query(`select action from adex.audit_log where route_id = $1 and action like 'ROUTE_MIGRATION%' order by created_at`, [rf])).rows.map((x) => x.action);
    assert.deepEqual(audit, ['ROUTE_MIGRATION_OPENED', 'ROUTE_MIGRATION_LOADED', 'ROUTE_MIGRATION_LOADED', 'ROUTE_MIGRATION_FINISHED']);
    const inj = await $ana('/v1/capital/route-base/injections', { routeId: rf, amountMinor: 20_000, reason: 'Apertura de caja: conteo del cierre de Listos' });
    assert.equal(inj.status, 201, JSON.stringify(inj.body));
    const saleK1 = (await db.admin.query(`select id from adex.sales where route_id = $1 and balance_minor = 60000 and installments_count = 12`, [rf])).rows[0].id as string;
    const col = await $ana('/v1/collections', { saleId: saleK1, amountMinor: 6_000 });
    assert.equal(col.status, 201, JSON.stringify(col.body));
  });

  test('RM-004 · conciliación limpia', async () => {
    const r = await bruno('GET', '/v1/capital/reconciliation');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((r.body['checks'] as Body[]).filter((c) => !c['ok']), []);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });
});
