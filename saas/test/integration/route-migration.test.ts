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

  test('RM-005 · 0050: venta por su valor registrado, abono previo, abonos y créditos por la caja, gastos, ingresos y deuda con el socio', async () => {
    // Ruta nueva, vacía, con Ana como Administradora responsable; se pone en migración.
    const nr = await bruno('POST', '/v1/routes', { name: 'Ruta Migrada Final', interestRate: 20, freeRate: false, maxLoanMinor: 500_000, adminIds: [M.anaAdmin] });
    assert.equal(nr.status, 201, JSON.stringify(nr.body));
    const rf = nr.body['id'] as string;
    assert.equal((await open($bruno, rf)).status, 201);
    const today = (await db.admin.query<{ d: string }>(`select to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') d from adex.companies where id = $1`, [c1])).rows[0]!.d;
    const day = (n: number) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const sched = (from: number, step: number, amounts: number[]) => amounts.map((a, k) => ({ number: k + 1, dueDate: day(from + k * step), amountMinor: a }));
    const docs = [cpf(), cpf()];
    const clients = [
      { code: 'C1', name: 'CLIENTE MIGRADO UNO', business: 'Pizzaria', notes: 'Recomendado por Renato', document: docs[0], documentType: 'CPF', phone: '61999990001', address: 'Rua sintética 1', active: true },
      { code: 'C2', name: 'CLIENTE MIGRADO DOS', document: docs[1], documentType: 'CPF', phone: '61999990002', address: 'Rua sintética 2', active: true },
      { code: 'C3', name: 'CLIENTE MIGRADO TRES', document: 'X12345', documentType: null, phone: '', address: '', active: false },
    ];
    // K1 (diario, 20 × 60,00 = 1.200,00; capital 1.000,00, desde hace 13 días): pagadas 8 → saldo 720,00; TODAS sus cuotas.
    // K2 (semanal, 4 × 300,00 = 1.200,00): saldo 450,00.
    const k1 = (bal: number) => ({ code: 'K1', clientCode: 'C1', grantedOn: day(-13), valueMinor: 100_000, totalMinor: 120_000, rate: 20,
      installmentsCount: 20, installmentValueMinor: 6_000, frequency: 'diaria', paymentDays: [0, 1, 2, 3, 4, 5, 6], balanceMinor: bal, overdueListos: 4,
      lastPaymentOn: day(-3), schedule: sched(-12, 1, Array<number>(20).fill(6_000)) });
    const k2 = { code: 'K2', clientCode: 'C2', grantedOn: day(-15), valueMinor: 100_000, totalMinor: 120_000, rate: 20, installmentsCount: 4, installmentValueMinor: 30_000,
      frequency: 'semanal', paymentDays: [1], balanceMinor: 45_000, overdueListos: 0, lastPaymentOn: day(-2), schedule: sched(-8, 7, [30_000, 30_000, 30_000, 30_000]) };
    const k0 = { code: 'K0', clientCode: 'C3', grantedOn: day(-300), valueMinor: 50_000, totalMinor: 60_000, installmentsCount: 20, frequency: 'diaria', lastPaymentOn: day(-250) };
    const paidK2 = { code: 'K2', clientCode: 'C2', grantedOn: day(-15), valueMinor: 100_000, totalMinor: 120_000, installmentsCount: 4, frequency: 'semanal', lastPaymentOn: day(-1) };
    // K3: crédito NUEVO entregado ayer (después del corte): sale de la caja.
    const k3 = { code: 'K3', clientCode: 'C3', grantedOn: day(-1), valueMinor: 50_000, totalMinor: 60_000, rate: 20, installmentsCount: 2, installmentValueMinor: 30_000,
      frequency: 'semanal', paymentDays: [1], balanceMinor: 60_000, overdueListos: 0, lastPaymentOn: null, schedule: sched(6, 7, [30_000, 30_000]) };
    // Caja del sistema anterior: −500,00 al corte (el socio puso de su dinero). Ayer: +570,00 abonos +10,00 ingreso −500,00 crédito −100,00 gasto.
    const day1 = (): Body => ({ sourceRouteName: 'VALPARAISO SOC GAJ (sintética)', reportDate: day(-2),
      control: { clients: 3, activeCredits: 2, balanceMinor: 72_000 + 45_000 }, listos: { cajaMinor: -50_000, carteraMinor: 117_000 },
      cash: { closingMinor: -50_000 }, clients, credits: [k1(72_000), k2], history: [k0] });
    const day2 = (): Body => ({ sourceRouteName: 'VALPARAISO SOC GAJ (sintética)', reportDate: day(-1),
      control: { clients: 3, activeCredits: 2, balanceMinor: 60_000 + 60_000 }, listos: { cajaMinor: -52_000, carteraMinor: 120_000 },
      cash: { closingMinor: -50_000 + 57_000 + 1_000 - 50_000 - 10_000, collectionsMinor: 57_000, disbursementsMinor: 50_000,
              income: [{ date: day(-1), amountMinor: 1_000, concept: 'Aporte del socio' }],
              expenses: [{ date: day(-1), amountMinor: 10_000, category: 'Combustible', concept: 'Gasolina de la moto' }] },
      clients, credits: [k1(60_000), k3], history: [k0, paidK2] });
    const preview = (p: Body) => bruno('POST', `/v1/routes/${rf}/migration/preview`, { payload: p });
    const load = (p: Body, op?: string) => $bruno(`/v1/routes/${rf}/migration/loads`, { payload: p }, op);
    const sales = async () => (await db.admin.query(`select t.source_code k, s.sale_value_minor v, s.total_value_minor t, s.balance_minor b, s.installments_count n, s.status,
        (select count(*) from adex.installments i where i.sale_id = s.id and i.status = 'vencida')::int overdue
      from adex.route_migration_items t join adex.sales s on s.id = t.sale_id where t.route_id = $1 and t.kind = 'credit' order by 1`, [rf])).rows
      .map((x) => [x.k, Number(x.v), Number(x.t), Number(x.b), x.n, x.status, x.overdue]);
    const base = async () => balance(db.admin, c1, 'route_base', null, rf);
    const debt = async () => -Number((await db.admin.query(`select balance_minor b from adex.capital_accounts where company_id = $1 and kind = 'admin_payable' and membership_id = $2`,
      [c1, M.anaAdmin])).rows[0]?.b ?? 0);
    const debtBefore = await debt();
    const credits = (p: Body) => p['credits'] as { schedule: { amountMinor: number }[] }[];

    // Solo el SuperAdmin.
    expectCode(await ana('POST', `/v1/routes/${rf}/migration/preview`, { payload: day1() }), 403, 'PERMISSION_DENIED', 'vista previa de la Administradora');
    expectCode(await $ana(`/v1/routes/${rf}/migration/loads`, { payload: day1() }), 403, 'PERMISSION_DENIED', 'carga de la Administradora');
    // Vista previa con datos que no cuadran: dice qué falla y no guarda nada.
    const bad = day1(); (bad['control'] as { balanceMinor: number }).balanceMinor += 100;
    const pb = await preview(bad);
    assert.equal(pb.status, 200, JSON.stringify(pb.body) + ' ' + String((api.errors.at(-1) as Error | undefined)?.message));
    assert.equal(pb.body['valid'], false);
    assert.match(String(pb.body['problem']), /does not match the report/);
    const bad2 = day1(); credits(bad2)[0]!.schedule[11]!.amountMinor = 5_000;
    assert.match(String((await preview(bad2)).body['problem']), /K1: the schedule must have all its installments/);
    const bad3 = day1(); credits(bad3)[0]!.schedule = credits(bad3)[0]!.schedule.slice(8);
    assert.match(String((await preview(bad3)).body['problem']), /K1: the schedule must have all its installments/, 'solo las cuotas que faltan ya no sirve');
    const bad4 = day1(); delete bad4['cash'];
    assert.match(String((await preview(bad4)).body['problem']), /cash\.closingMinor/);
    expectCode(await load(bad), 422, 'ROUTE_MIGRATION_INVALID_DATA', 'carga que no cuadra');
    assert.equal(Number((await db.admin.query('select count(*) n from adex.clients where route_id = $1', [rf])).rows[0].n), 0, 'nada se escribió');
    expectCode(await $bruno(`/v1/routes/${rf}/migration/close`, {}), 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'finalizar sin cierres');

    // Cierre 1 (el corte): venta por su valor registrado y un abono previo; Base 0 y deuda de 500,00 con la responsable.
    const pv = await preview(day1());
    assert.equal(pv.body['valid'], true, JSON.stringify(pv.body));
    assert.equal(pv.body['creditsOverdue'], 1);
    const op1 = randomUUID();
    const l1 = await load(day1(), op1);
    assert.equal(l1.status, 201, JSON.stringify(l1.body));
    assert.deepEqual((await load(day1(), op1)).body, l1.body, 'reintento: misma respuesta');
    assert.equal(l1.body['firstLoad'], true);
    // 0051: nombre y negocio separados; las notas del lector van a observaciones.
    const cl = (await db.admin.query(`select name, business, notes from adex.clients where route_id = $1 order by name`, [rf])).rows;
    assert.deepEqual(cl.map((r) => [r.name, r.business, r.notes]), [
      ['CLIENTE MIGRADO DOS', null, 'Cliente migrado (código C2)'],
      ['CLIENTE MIGRADO TRES', null, 'Cliente migrado (código C3)'],
      ['CLIENTE MIGRADO UNO', 'Pizzaria', 'Cliente migrado (código C1)\nRecomendado por Renato'],
    ]);
    assert.equal(l1.body['paidBeforeMigrationMinor'], 48_000 + 75_000);
    assert.equal(await state(rf), 'en_migracion');
    assert.deepEqual(await sales(), [['K1', 100_000, 120_000, 72_000, 20, 'activa', 4], ['K2', 100_000, 120_000, 45_000, 4, 'activa', 0]]);
    assert.equal(await balance(db.admin, c1, 'portfolio', null, rf), 60_000 + 37_500, 'cartera = capital pendiente');
    assert.equal(await base(), 0, 'la Base abre en 0');
    assert.equal(await debt() - debtBefore, 50_000, 'deuda con el socio por la caja negativa');
    assert.deepEqual([(l1.body['cash'] as Body)['expectedBaseMinor'], (l1.body['cash'] as Body)['differenceMinor']], [0, 0]);
    expectCode(await newClient(ana, rf), 409, 'ROUTE_IN_MIGRATION', 'la ruta sigue de solo lectura');
    expectCode(await cancel($bruno, rf), 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'cancelar con cierres cargados');
    expectCode(await load(day1()), 422, 'ROUTE_MIGRATION_INVALID_DATA', 'el mismo cierre otra vez');

    // 0048: un saldo que SUBE queda como diferencia abierta (la vista previa lo avisa).
    const up = day2(); (up['credits'] as Body[])[0] = k1(73_000); (up['control'] as { balanceMinor: number }).balanceMinor = 73_000 + 60_000;
    const pu = await preview(up);
    assert.equal(pu.body['valid'], true, JSON.stringify(pu.body));
    assert.deepEqual((pu.body['differences'] as Body[]).map((d) => [d['code'], d['kind'], d['adexBalanceMinor'], d['sourceBalanceMinor']]), [['K1', 'balance_up', 72_000, 73_000]]);

    // Cierre 2: abono en K1 y K2 pagado (entran a la caja), ingreso, K3 nuevo (sale de la caja), gasto (el socio cubre 20,00).
    const l2 = await load(day2());
    assert.equal(l2.status, 201, JSON.stringify(l2.body));
    assert.deepEqual([l2.body['newCredits'], l2.body['creditsWithPayments'], l2.body['creditsPaidOff'], l2.body['collectedInListosMinor']], [1, 1, 1, 57_000]);
    const cash = l2.body['cash'] as Body;
    assert.deepEqual([cash['collectionsDifferenceMinor'], cash['disbursementsDifferenceMinor'], cash['incomeMinor'], cash['expensesMinor'], cash['partnerCoverMinor'],
      cash['baseMinor'], cash['partnerDebtMinor'], cash['differenceMinor']], [0, 0, 1_000, 10_000, 2_000, 0, 52_000, 0], JSON.stringify(cash));
    assert.deepEqual(await sales(), [['K1', 100_000, 120_000, 60_000, 20, 'activa', 2], ['K2', 100_000, 120_000, 0, 4, 'finalizada', 0],
      ['K3', 50_000, 60_000, 60_000, 2, 'activa', 0]]);
    const pays = (await db.admin.query(`select p.amount_minor a, p.payment_date::text d, o.kind from adex.payments p
        join adex.capital_operations o on o.id = p.ledger_operation_id where p.route_id = $1 order by p.payment_date, p.amount_minor`, [rf])).rows;
    assert.deepEqual(pays.map((x) => [Number(x.a), x.d, x.kind]), [[48_000, day(-2), 'MIGRATION_COLLECTION'], [75_000, day(-2), 'MIGRATION_COLLECTION'],
      [12_000, day(-1), 'MIGRATION_CASH_COLLECTION'], [45_000, day(-1), 'MIGRATION_CASH_COLLECTION']]);
    const exp = (await db.admin.query(`select x.amount_minor a, x.expense_date::text d, x.description, c.name from adex.expenses x
        join adex.expense_categories c on c.id = x.category_id where x.route_id = $1`, [rf])).rows;
    assert.deepEqual(exp.map((x) => [Number(x.a), x.d, x.description, x.name]), [[10_000, day(-1), 'Gasto del sistema anterior: Gasolina de la moto', 'Combustible']]);
    assert.equal(await debt() - debtBefore, 52_000);
    const c3 = (await db.admin.query(`select status from adex.clients where route_id = $1 and notes = 'Cliente migrado (código C3)'`, [rf])).rows[0].status;
    assert.equal(c3, 'activo', 'el cliente que renovó queda activo');
    // 0046: ningún texto visible lleva el nombre del sistema anterior.
    const texts = (await db.admin.query(`select note t from adex.payments where route_id = $1
        union all select reason from adex.capital_operations where route_id = $1 and (kind like 'MIGRATION%' or kind = 'ROUTE_EXPENSE')
        union all select notes from adex.clients where route_id = $1
        union all select description from adex.audit_log where route_id = $1 and action like 'ROUTE_MIGRATION%'`, [rf])).rows.map((x) => String(x.t));
    assert.deepEqual(texts.filter((t) => /listos/i.test(t)), []);
    assert.ok(texts.includes('Abono previo a la migración (crédito K1)'), texts.join(' | '));
    assert.ok(texts.includes('Abono durante la migración (crédito K2 pagado)'), texts.join(' | '));
    assert.ok(texts.includes('Crédito entregado durante la migración (crédito K3)'), texts.join(' | '));
    const rec0 = await bruno('GET', '/v1/capital/reconciliation');
    assert.deepEqual((rec0.body['checks'] as Body[]).filter((c) => !c['ok']), [], 'la conciliación cuadra durante la migración');

    // Finalizar: la caja cuadra; la ruta queda normal y se cobra un crédito migrado.
    const fin = await $bruno(`/v1/routes/${rf}/migration/close`, { note: 'Cierre del domingo cargado' });
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    assert.equal(fin.body['status'], 'finalizada');
    assert.equal(await state(rf), 'normal');
    expectCode(await load(day2()), 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'cargar tras finalizar');
    const audit = (await db.admin.query(`select action from adex.audit_log where route_id = $1 and action like 'ROUTE_MIGRATION%' order by created_at`, [rf])).rows.map((x) => x.action);
    assert.deepEqual(audit, ['ROUTE_MIGRATION_OPENED', 'ROUTE_MIGRATION_LOADED', 'ROUTE_MIGRATION_LOADED', 'ROUTE_MIGRATION_FINISHED']);
    const saleK1 = (await db.admin.query(`select sale_id from adex.route_migration_items where route_id = $1 and source_code = 'K1'`, [rf])).rows[0].sale_id as string;
    const inj = await $ana('/v1/capital/route-base/injections', { routeId: rf, amountMinor: 20_000, reason: 'Conteo del cierre: dinero del cobrador' });
    assert.equal(inj.status, 201, JSON.stringify(inj.body));
    const col = await $ana('/v1/collections', { saleId: saleK1, amountMinor: 6_000 });
    assert.equal(col.status, 201, JSON.stringify(col.body));
  });

  test('RM-006 · 0048/0050: un cierre con diferencias se carga igual; cada caso y cada corrección; terminar exige cero abiertas y caja cuadrada', async () => {
    // Ruta nueva con dos Administradores: Ana (responsable) y Edu (no responsable).
    const nr = await bruno('POST', '/v1/routes', { name: 'Ruta Migrada Diferencias', interestRate: 20, freeRate: false, maxLoanMinor: 500_000,
      adminIds: [M.anaAdmin, edu.membershipId] });
    assert.equal(nr.status, 201, JSON.stringify(nr.body));
    const rg = nr.body['id'] as string;
    const ctrl = (await db.admin.query('select capital_controller_membership_id c from adex.routes where id = $1', [rg])).rows[0].c;
    if (ctrl !== M.anaAdmin) {
      assert.equal((await bruno('PUT', `/v1/routes/${rg}/capital-controller`, { membershipId: M.anaAdmin, reason: 'Responsable de la ruta migrada' })).status, 200);
    }
    assert.equal((await open($bruno, rg)).status, 201);
    const today = (await db.admin.query<{ d: string }>(`select to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') d from adex.companies where id = $1`, [c1])).rows[0]!.d;
    const day = (n: number) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const codes = ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'C1', 'C2'];
    const docs = codes.map(() => cpf());
    const clients = codes.map((k, i) => ({ code: `P${k}`, name: `CLIENTE DIFERENCIA ${k}`, document: docs[i], documentType: 'CPF', phone: '61999990009', address: 'Rua sintética', active: true }));
    // Diario, 20 × 60,00 = 1.200,00 (capital 1.000,00), con TODAS sus cuotas (0050); lo pagado entra como abono.
    const credit = (k: string, balance: number) => ({ code: k, clientCode: `P${k}`, grantedOn: day(-30), valueMinor: 100_000, totalMinor: 120_000, rate: 20,
      installmentsCount: 20, installmentValueMinor: 6_000, frequency: 'diaria', paymentDays: [0, 1, 2, 3, 4, 5, 6], balanceMinor: balance, overdueListos: 0,
      lastPaymentOn: day(-6), schedule: Array.from({ length: 20 }, (_, j) => ({ number: j + 1, dueDate: day(-29 + j), amountMinor: 6_000 })) });
    const paid = (k: string) => ({ code: k, clientCode: `P${k}`, grantedOn: day(-30), valueMinor: 100_000, totalMinor: 120_000, installmentsCount: 20, frequency: 'diaria', lastPaymentOn: day(-3) });
    const close = (reportDate: string, credits: [string, number][], history: string[], closingMinor = 0) => ({ sourceRouteName: 'RUTA CON DIFERENCIAS (sintética)', reportDate,
      control: { clients: codes.length, activeCredits: credits.length, balanceMinor: credits.reduce((t, [, b]) => t + b, 0) },
      cash: { closingMinor }, clients, credits: credits.map(([k, b]) => credit(k, b)), history: history.map(paid) });
    const load = (p: Body, op?: string) => $bruno(`/v1/routes/${rg}/migration/loads`, { payload: p }, op);
    const sales = async () => Object.fromEntries((await db.admin.query(`select t.source_code k, s.status, s.balance_minor b, s.total_value_minor t, s.sale_value_minor v,
        s.migration_voided_at is not null voided from adex.route_migration_items t join adex.sales s on s.id = t.sale_id
       where t.route_id = $1 and t.kind = 'credit'`, [rg])).rows.map((x) => [x.k, [x.status, Number(x.b), Number(x.t), Number(x.v), x.voided]]));

    // Cierre 1: los nueve activos. Cierre 2: abonos en A1 y A2; C1 y C2 pagados.
    const day1 = close(day(-4), [['A1', 72_000], ['A2', 30_000], ['A3', 24_000], ['A4', 36_000], ['B1', 18_000], ['B2', 12_000], ['B3', 24_000], ['C1', 30_000], ['C2', 12_000]], []);
    assert.equal((await load(day1)).status, 201);
    // Cierre 2: los abonos (120 + 120 + 300 + 120) entran a la caja: la del sistema anterior queda en 660,00.
    const l2 = await load(close(day(-3), [['A1', 60_000], ['A2', 18_000], ['A3', 24_000], ['A4', 36_000], ['B1', 18_000], ['B2', 12_000], ['B3', 24_000]], ['C1', 'C2'], 66_000));
    assert.equal(l2.status, 201, JSON.stringify(l2.body));
    assert.equal(l2.body['openDifferences'], 0);
    const portfolioBefore = await balance(db.admin, c1, 'portfolio', null, rg);

    // Cierre 3: A (saldo sube) en A1…A4; B (desaparece sin estar pagado) en B1…B3; C (vuelve activo) en C1 y C2.
    const day3 = close(day(-2), [['A1', 66_000], ['A2', 36_000], ['A3', 30_000], ['A4', 42_000], ['C1', 30_000], ['C2', 12_000]], [], 66_000);
    const pv = await bruno('POST', `/v1/routes/${rg}/migration/preview`, { payload: day3 });
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    assert.equal(pv.body['valid'], true, JSON.stringify(pv.body));
    assert.equal(pv.body['newDifferences'], 9);
    assert.equal(Number((await db.admin.query('select count(*) n from adex.route_migration_differences where route_id = $1', [rg])).rows[0].n), 0, 'la vista previa no guarda nada');
    const before3 = await sales();
    const l3 = await load(day3);
    assert.equal(l3.status, 201, JSON.stringify(l3.body));
    assert.equal(l3.body['newDifferences'], 9);
    assert.equal(l3.body['openDifferences'], 9);
    assert.equal(l3.body['collectedInListosMinor'], 0);
    assert.deepEqual(await sales(), before3, 'ningún crédito con diferencia cambió');
    assert.equal(await balance(db.admin, c1, 'portfolio', null, rg), portfolioBefore, 'la cartera no se movió');
    const diffs: Record<string, Body> = Object.fromEntries((l3.body['differences'] as Body[]).map((d) => [d['code'], d]));
    assert.deepEqual(Object.entries(diffs).map(([k, d]) => [k, d['kind'], d['adexBalanceMinor'], d['sourceStatus'], d['sourceBalanceMinor']]).sort(), [
      ['A1', 'balance_up', 60_000, 'active', 66_000], ['A2', 'balance_up', 18_000, 'active', 36_000], ['A3', 'balance_up', 24_000, 'active', 30_000],
      ['A4', 'balance_up', 36_000, 'active', 42_000], ['B1', 'missing', 18_000, 'missing', null], ['B2', 'missing', 12_000, 'missing', null],
      ['B3', 'missing', 24_000, 'missing', null], ['C1', 'reappeared', 0, 'active', 30_000], ['C2', 'reappeared', 0, 'active', 12_000]]);
    assert.equal(diffs['A1']!['clientName'], 'CLIENTE DIFERENCIA A1');
    // La lista la ven el SuperAdmin y la Administradora; «Terminar» se bloquea con diferencias abiertas.
    const listed = await ana('GET', `/v1/route-migrations?routeId=${rg}`);
    assert.equal((listed.body['migrations'] as Body[])[0]!['openDifferences'], 9, JSON.stringify(listed.body));
    const blocked = await $bruno(`/v1/routes/${rg}/migration/close`, {});
    expectCode(blocked, 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'terminar con diferencias');

    const resolve = (who: Money, code: string, action: string, reason = 'Revisado con el reporte y el cuaderno del cobrador', op?: string) =>
      who(`/v1/routes/${rg}/migration/differences/${String(diffs[code]!['id'])}/resolve`, { action, reason }, op);
    // Quién corrige: SuperAdmin o la Administradora responsable; nadie más. Motivo obligatorio y opción del caso.
    expectCode(await resolve(edu.money, 'A1', 'accept_source'), 403, 'CAPITAL_AUTHORITY_REQUIRED', 'Administrador no responsable');
    expectCode(await resolve(money(caller(api, issuer, 'ana', M.anaCob)), 'A1', 'accept_source'), 403, 'PERMISSION_DENIED', 'cobradora');
    expectCode(await resolve($ana, 'A1', 'accept_source', 'corto'), 400, 'INVALID_INPUT', 'motivo corto');
    expectCode(await resolve($ana, 'A1', 'void'), 400, 'INVALID_INPUT', 'opción de otro caso');
    expectCode(await ana('POST', `/v1/routes/${rg}/migration/differences/${String(diffs['A1']!['id'])}/resolve`, { action: 'keep_adex', reason: 'Sin operación' }),
      400, 'OPERATION_ID_REQUIRED', 'sin X-Adex-Operation-Id');

    // A1 · aceptar: sube 60,00 y había un abono de 120,00 → se anula y se vuelve a registrar 60,00 (importe exacto).
    const opA1 = randomUUID();
    const a1 = await resolve($ana, 'A1', 'accept_source', undefined, opA1);
    assert.equal(a1.status, 200, JSON.stringify(a1.body));
    assert.deepEqual([a1.body['reversedMinor'], a1.body['collectedMinor'], a1.body['interestAdjustmentMinor'], a1.body['balanceAfterMinor']], [12_000, 6_000, 0, 66_000]);
    assert.deepEqual((await resolve($ana, 'A1', 'accept_source', undefined, opA1)).body, a1.body, 'reintento: misma respuesta');
    expectCode(await resolve($ana, 'A1', 'keep_adex'), 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'ya corregida');
    // A2 · aceptar (SuperAdmin): sube 180,00; se anulan el abono de 120,00 y el previo de 900,00, y se vuelve a registrar 840,00.
    const a2 = await resolve($bruno, 'A2', 'accept_source', 'El sistema anterior anuló un abono de 180,00');
    assert.equal(a2.status, 200, JSON.stringify(a2.body));
    assert.deepEqual([a2.body['reversedMinor'], a2.body['collectedMinor'], a2.body['interestAdjustmentMinor'], a2.body['balanceAfterMinor']], [102_000, 84_000, 0, 36_000]);
    // A3 · mantener ADEX: nada cambia; el siguiente cierre descuenta esa diferencia aceptada.
    assert.equal((await resolve($ana, 'A3', 'keep_adex')).status, 200);
    // B1 · fue pagado; B2 · nunca debió existir (anulada); C1 · reabrir; C2 · mantener pagado.
    assert.equal((await resolve($ana, 'B1', 'paid')).status, 200);
    const b2 = await resolve($ana, 'B2', 'void', 'Crédito digitado dos veces en el sistema anterior');
    assert.equal(b2.status, 200, JSON.stringify(b2.body));
    assert.equal(b2.body['principalReturnedMinor'], 10_000);
    const c1r = await resolve($bruno, 'C1', 'reopen', 'Reabrieron el pago en el sistema anterior');
    assert.equal(c1r.status, 200, JSON.stringify(c1r.body));
    assert.deepEqual([c1r.body['reversedMinor'], c1r.body['balanceAfterMinor']], [30_000, 30_000]);
    assert.equal((await resolve($ana, 'C2', 'keep_paid')).status, 200);

    // Cierre 4: A3 baja 60,00 sobre la diferencia aceptada (abono de 60,00 en ADEX); A4 vuelve a coincidir (se cierra sola);
    // C1 abona 60,00; C2 sigue activo allá (se respeta «mantener pagado»); B3 sigue sin aparecer (sigue abierta).
    const baseBefore4 = await balance(db.admin, c1, 'route_base', null, rg);
    const l4 = await load(close(day(-1), [['A1', 66_000], ['A2', 36_000], ['A3', 24_000], ['A4', 36_000], ['C1', 24_000], ['C2', 12_000]], ['B1'], baseBefore4 + 12_000));
    assert.equal(l4.status, 201, JSON.stringify(l4.body));
    assert.deepEqual([l4.body['newDifferences'], l4.body['resolvedDifferences'], l4.body['openDifferences'], l4.body['creditsWithPayments']], [0, 1, 1, 2]);
    assert.deepEqual((l4.body['differences'] as Body[]).map((d) => d['code']), ['B3']);
    expectCode(await $bruno(`/v1/routes/${rg}/migration/close`, {}), 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'falta B3');
    assert.equal((await resolve($ana, 'B3', 'still_active', 'El cliente sigue pagando: se cobra en ADEX')).status, 200);

    // [estado, saldo, total, capital, anulada]: cada venta por su valor registrado (0050); B2 queda anulada con lo ya cobrado.
    assert.deepEqual(await sales(), {
      A1: ['activa', 66_000, 120_000, 100_000, false], A2: ['activa', 36_000, 120_000, 100_000, false], A3: ['activa', 18_000, 120_000, 100_000, false],
      A4: ['activa', 36_000, 120_000, 100_000, false], B1: ['finalizada', 0, 120_000, 100_000, false], B2: ['finalizada', 0, 108_000, 90_000, true],
      B3: ['activa', 24_000, 120_000, 100_000, false], C1: ['activa', 24_000, 120_000, 100_000, false], C2: ['finalizada', 0, 120_000, 100_000, false],
    });
    // Los abonos durante la migración y sus correcciones pasan por la Base de la ruta; los previos, por la financiación.
    const touched = (await db.admin.query(`select distinct a.kind from adex.capital_entries e join adex.capital_accounts a on a.id = e.account_id
        join adex.capital_operations o on o.id = e.operation_id where o.route_id = $1`, [rg])).rows.map((x) => x.kind).sort();
    assert.deepEqual(touched, ['income', 'portfolio', 'route_base', 'route_funding']);
    const kinds = (await db.admin.query(`select coalesce(reverses_kind || ' anulado', kind) k, count(*)::int n from adex.capital_operations
        where route_id = $1 and (kind in ('REVERSAL', 'MIGRATION_ADJUSTMENT')) group by 1 order by 1`, [rg])).rows.map((x) => [x.k, x.n]);
    assert.deepEqual(kinds, [['MIGRATION_ADJUSTMENT', 1], ['MIGRATION_CASH_COLLECTION anulado', 3], ['MIGRATION_COLLECTION anulado', 1]]);
    const audit = (await db.admin.query(`select count(*)::int n from adex.audit_log where route_id = $1 and action = 'ROUTE_MIGRATION_DIFFERENCE_RESOLVED' and reason is not null`, [rg])).rows[0].n;
    assert.equal(audit, 8);
    const auto = (await db.admin.query(`select source_code, reason from adex.route_migration_differences where route_id = $1 and action = 'coincide'`, [rg])).rows;
    assert.deepEqual(auto.map((x) => [x.source_code, x.reason]), [['A4', 'Se corrigió en el sistema anterior']]);
    const texts = (await db.admin.query(`select note t from adex.payments where route_id = $1 union all select reason from adex.capital_operations where route_id = $1
        union all select description from adex.audit_log where route_id = $1`, [rg])).rows.map((x) => String(x.t));
    assert.deepEqual(texts.filter((t) => /listos/i.test(t)), []);
    const rec = await bruno('GET', '/v1/capital/reconciliation');
    assert.deepEqual((rec.body['checks'] as Body[]).filter((c) => !c['ok']), [], 'la ruta cuadra después de las correcciones');

    // Terminar con cero abiertas; luego la ruta opera normal.
    const fin = await $bruno(`/v1/routes/${rg}/migration/close`, { note: 'Diferencias revisadas' });
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    assert.equal(await state(rg), 'normal');
    assert.equal(await balance(db.admin, c1, 'route_base', null, rg), baseBefore4 + 12_000, 'la Base = la caja del último cierre');
  });

  test('RM-004 · conciliación limpia', async () => {
    const r = await bruno('GET', '/v1/capital/reconciliation');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((r.body['checks'] as Body[]).filter((c) => !c['ok']), []);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });
});
