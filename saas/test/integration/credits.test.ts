// FASE 4 · solicitud → autorización → desembolso (y venta directa) contra PostgreSQL
// real y la API. Reglas de CLEAN: el Cobrador solo solicita y solo al 20 %; el 10 % lo
// fija un autorizador; nadie resuelve lo suyo (ni con otra membresía); una pendiente por
// cliente; el crédito activo cuenta en toda la empresa. El crédito nace SOLO al
// desembolsar, con su asiento, una vez. Verificación independiente con SQL propio.
//
// Importes en unidades menores (BRL): R$ 500 = 50_000.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf, membershipId, routeId } from '../../db/seeds/synthetic.ts';
import { asApi, count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('Fase 4 · créditos: solicitud, autorización y desembolso', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  const r2 = routeId('c1', 2);
  let bruno: Caller, ana: Caller, gabi: Caller, anaCob: Caller, fabio: Caller;
  let $bruno: Money, $ana: Money;
  let carlos: Person, dora: Person, xavier: Person, gil: Person;
  let r5 = '';
  let today = '';

  const pool = (m: string) => balance(db.admin, c1, 'admin', m);
  const custody = (m: string, r: string) => balance(db.admin, c1, 'custody', m, r);
  const portfolio = (r: string) => balance(db.admin, c1, 'portfolio', null, r);
  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const newClient = async (route: string, name: string) => {
    const r = await bruno('POST', '/v1/clients', { routeId: route, name, documentType: 'CPF', document: cpf(), phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b' });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body['id'] as string;
  };
  const cond = (o: Body = {}) => ({ amountMinor: 50_000, interestRate: 20, installmentsCount: 12, frequency: 'diaria', startDate: today, paymentDays: [1, 2, 3, 4, 5, 6], ...o });
  const request = (who: Caller, route: string, client: string, o: Body = {}) => who('POST', '/v1/credit-requests', { routeId: route, clientId: client, ...cond(o) });
  const disburse = (m: Money, id: string, op?: string) => m(`/v1/credit-requests/${id}/disburse`, {}, op);
  const salesOf = (client: string) => count(db.admin, 'select 1 from adex.sales where client_id = $1', [client]);

  before(async () => {
    db = await createTestDb('credits', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    gabi = caller(api, issuer, 'gabi', M.gabiSec);
    anaCob = caller(api, issuer, 'ana', M.anaCob);
    fabio = caller(api, issuer, 'fabio', M.fabioSocio);
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    const mk = (email: string, role: string, displayName: string, routeIds: string[]) => newPerson(api, issuer, provider.ids, bruno, { email, role, displayName, routeIds });
    carlos = await mk('carlos-cr@example.test', 'cobrador', 'Carlos', [r1]);
    dora = await mk('dora-cr@example.test', 'supervisor', 'Dora', [r1]);
    xavier = await mk('xavier-cr@example.test', 'admin', 'Xavier', [r1]);
    gil = await mk('gil-cr@example.test', 'cobrador', 'Gil', [r2]);
    r5 = (await bruno('POST', '/v1/routes', { name: 'Ruta Cinco', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [M.anaAdmin] })).body['id'] as string;
    if ((await bruno('PUT', `/v1/members/${M.anaCob}/routes`, { routeIds: [r5] })).status !== 200) throw new Error('rutas de Ana cobradora');
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 3_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 1_000_000, reason: 'Bolsa de Ana' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
  });
  after(async () => { await api.close(); await db.close(); });

  test('CRED-001 · solicitud válida del Cobrador al 20 %: pendiente, condiciones congeladas, sin crédito ni dinero', async () => {
    const cl = await newClient(r1, 'Cliente Uno');
    const ops = await count(db.admin, 'select 1 from adex.capital_operations');
    const r = await request(carlos.call, r1, cl);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body['status'], r.body['totalAmountMinor'], r.body['installmentValueMinor'], r.body['requestedBy'], r.body['authorizationReason']],
      ['pending', 60_000, 5_000, carlos.membershipId, 'no-direct-capability']);
    assert.deepEqual(r.body['requested'], { interestRate: 20, frequency: 'diaria', paymentDays: [1, 2, 3, 4, 5, 6] });
    assert.equal(await salesOf(cl), 0, 'una solicitud no es un crédito');
    assert.equal(await count(db.admin, 'select 1 from adex.capital_operations'), ops, 'ni mueve dinero');
    const audit = await db.admin.query(`select actor_role from adex.audit_log where action = 'CREATE_SALE_REQUEST' and entity_id = $1 and txid is not null`, [r.body['id']]);
    assert.deepEqual(audit.rows, [{ actor_role: 'cobrador' }]);
  });

  test('CRED-002 · solicitudes inválidas: tasa, cliente, ruta, fechas, días, roles y duplicada', async () => {
    const cl = await newClient(r1, 'Cliente Dos');
    const err = async (who: Caller, route: string, client: string, o: Body = {}) => (await request(who, route, client, o)).body['error'];
    assert.equal(await err(carlos.call, r1, cl, { interestRate: 10 }), 'INTEREST_RATE_NOT_ALLOWED', 'el Cobrador solo origina al 20 %');
    assert.equal(await err(ana, r1, cl, { interestRate: 15 }), 'INTEREST_RATE_NOT_ALLOWED', 'no existen otras tasas');
    assert.equal(await err(carlos.call, r1, cl, { startDate: '2026-01-01' }), 'INVALID_CONDITIONS');
    assert.equal(await err(carlos.call, r1, cl, { paymentDays: [] }), 'INVALID_INPUT');
    assert.equal(await err(carlos.call, r1, cl, { amountMinor: 12.5 }), 'INVALID_INPUT');
    assert.equal(await err(carlos.call, r1, await newClient(r5, 'De otra ruta')), 'NOT_FOUND', 'cliente de otra ruta');
    assert.equal(await err(gil.call, r1, cl), 'NOT_FOUND', 'ruta fuera de su alcance');
    assert.equal((await request(gabi, r1, cl)).status, 403, 'la Secretaria no solicita');
    assert.equal((await request(fabio, r1, cl)).status, 403, 'el Socio no solicita');
    const inactive = await newClient(r1, 'Inactivo');
    assert.equal((await bruno('POST', `/v1/clients/${inactive}/status`, { status: 'inactivo' })).status, 200);
    assert.equal(await err(carlos.call, r1, inactive), 'CLIENT_NOT_ACTIVE');
    assert.equal((await request(carlos.call, r1, cl)).status, 201);
    assert.equal(await err(carlos.call, r1, cl), 'PENDING_REQUEST_EXISTS', 'una sola pendiente por cliente');
  });

  test('CRED-003 · aprobación: condiciones finales (10 % solo por quien autoriza), totales recalculados, sin crédito', async () => {
    const cl = await newClient(r1, 'Cliente Tres');
    const req = (await request(carlos.call, r1, cl)).body['id'] as string;
    assert.equal((await carlos.call('POST', `/v1/credit-requests/${req}/approve`, {})).status, 403, 'el Cobrador no aprueba');
    assert.equal((await ana('POST', `/v1/credit-requests/${req}/approve`, { phoneConfirmed: true })).status, 403, 'el Administrador no confirma por teléfono (CLEAN)');
    assert.equal((await gabi('POST', `/v1/credit-requests/${req}/approve`, { interestRate: 15 })).body['error'], 'INTEREST_RATE_NOT_ALLOWED');
    const r = await gabi('POST', `/v1/credit-requests/${req}/approve`, { interestRate: 10, phoneConfirmed: true, phoneConfirmationNote: 'Cliente confirma', notes: 'OK' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body['status'], r.body['interestRate'], r.body['totalAmountMinor'], r.body['installmentValueMinor'], r.body['reviewedBy']],
      ['approved', 10, 55_000, 4_583, M.gabiSec]);
    assert.deepEqual(r.body['requested'], { interestRate: 20, frequency: 'diaria', paymentDays: [1, 2, 3, 4, 5, 6] }, 'lo solicitado no se sobrescribe');
    assert.equal(await salesOf(cl), 0, 'aprobar no crea la deuda');
    const actions = (await db.admin.query(`select action from adex.audit_log where entity_id = $1 order by action`, [req])).rows.map((x) => x.action);
    assert.deepEqual(actions, ['APPROVE_SALE_REQUEST', 'CHANGE_SALE_CONDITIONS', 'CREATE_SALE_REQUEST', 'PHONE_CONFIRMATION']);
    assert.equal((await gabi('POST', `/v1/credit-requests/${req}/approve`, {})).body['error'], 'REQUEST_STATE_INVALID', 'ya resuelta');
  });

  test('CRED-004 · nadie resuelve su propia solicitud, tampoco con otra membresía de la misma persona (DS-05)', async () => {
    const own = (await request(dora.call, r1, await newClient(r1, 'De Dora'))).body['id'] as string;
    assert.equal((await dora.call('POST', `/v1/credit-requests/${own}/approve`, {})).body['error'], 'SELF_APPROVAL_FORBIDDEN');
    assert.equal((await dora.call('POST', `/v1/credit-requests/${own}/reject`, { reason: 'Propia' })).body['error'], 'SELF_APPROVAL_FORBIDDEN');
    const anas = (await request(anaCob, r5, await newClient(r5, 'De Ana cobradora'))).body['id'] as string;
    assert.equal((await ana('POST', `/v1/credit-requests/${anas}/approve`, {})).body['error'], 'SELF_APPROVAL_FORBIDDEN', 'Ana administradora = Ana cobradora');
    assert.equal((await bruno('POST', `/v1/credit-requests/${anas}/approve`, {})).status, 200, 'otra persona sí');
  });

  test('CRED-005 · rechazo con motivo: no crea nada y ya no se desembolsa', async () => {
    const cl = await newClient(r1, 'Rechazado');
    const req = (await request(carlos.call, r1, cl)).body['id'] as string;
    assert.equal((await gabi('POST', `/v1/credit-requests/${req}/reject`, {})).body['error'], 'INVALID_INPUT');
    const r = await gabi('POST', `/v1/credit-requests/${req}/reject`, { reason: 'Sin referencias' });
    assert.deepEqual([r.status, r.body['status'], r.body['rejectionReason']], [200, 'rejected', 'Sin referencias']);
    assert.equal((await disburse(carlos.money, req)).body['error'], 'REQUEST_NOT_DISBURSABLE');
    assert.equal(await salesOf(cl), 0);
  });

  test('CRED-006 · capital anticipado NO es deuda; el desembolso del Cobrador sale de SU custodia una vez y crea el crédito', async () => {
    const cl = await newClient(r1, 'Cliente Desembolso');
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 100_000, reason: 'Anticipo del día' })).status, 201);
    assert.equal(await salesOf(cl), 0, 'la entrega anticipada no crea crédito');
    const req = (await request(carlos.call, r1, cl)).body['id'] as string;
    assert.equal((await gabi('POST', `/v1/credit-requests/${req}/approve`, {})).status, 200);
    const poolBefore = await pool(M.anaAdmin);
    const d = await disburse(carlos.money, req);
    assert.equal(d.status, 201, JSON.stringify(d.body));
    const credit = d.body['credit'] as Body;
    assert.deepEqual([credit['status'], credit['disbursementStatus'], credit['saleValueMinor'], credit['totalValueMinor'], credit['balanceMinor'],
      credit['disbursedByCollectorId'], credit['saleRequestId']], ['activa', 'desembolsado', 50_000, 60_000, 60_000, carlos.membershipId, req]);
    const inst = d.body['installments'] as Body[];
    assert.equal(inst.length, 12);
    assert.equal(inst.reduce((s, i) => s + (i['amountMinor'] as number), 0), 60_000);
    assert.ok(inst.every((i) => (i['dueDate'] as string) >= today));
    assert.deepEqual((d.body['disbursementEntries'] as Body[]).map((e) => (e['account'] as Body)['kind']), ['custody'], 'el Cobrador no ve la cartera ni la bolsa');
    assert.equal(await custody(carlos.membershipId, r1), 50_000);
    assert.equal(await pool(M.anaAdmin), poolBefore, 'la bolsa no paga dos veces');
    assert.equal(await portfolio(r1), 50_000, 'la deuda por cobrar (capital) entra en la cartera de la ruta');
    const legs = await db.admin.query(
      `select a.kind, e.amount_minor::int amt from adex.capital_entries e join adex.capital_accounts a on a.id = e.account_id
        where e.operation_id = $1 order by e.leg`, [credit['ledgerOperationId']]);
    assert.deepEqual(legs.rows, [{ kind: 'custody', amt: -50_000 }, { kind: 'portfolio', amt: 50_000 }]);
    assert.deepEqual((await db.admin.query('select status, sale_id from adex.sale_requests where id = $1', [req])).rows, [{ status: 'disbursed', sale_id: credit['id'] }]);
    assert.equal((await disburse(carlos.money, req)).body['error'], 'REQUEST_NOT_DISBURSABLE', 'nunca dos veces');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('CRED-007 · fondos insuficientes: se rechaza sin crear obligación ni asiento; la solicitud sigue aprobada', async () => {
    const cl = await newClient(r1, 'Sin fondos');
    const req = (await request(carlos.call, r1, cl, { amountMinor: 60_000 })).body['id'] as string;
    assert.equal((await gabi('POST', `/v1/credit-requests/${req}/approve`, {})).status, 200);
    const ops = await count(db.admin, 'select 1 from adex.capital_operations');
    const r = await disburse(carlos.money, req);
    assert.deepEqual([r.status, r.body], [409, { error: 'INSUFFICIENT_FUNDS' }]);
    assert.equal(await salesOf(cl), 0);
    assert.equal(await count(db.admin, 'select 1 from adex.capital_operations'), ops);
    assert.equal((await db.admin.query('select status from adex.sale_requests where id = $1', [req])).rows[0].status, 'approved');
    // Completar con una entrega del Administrador: ahora sí.
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 10_000, reason: 'Completa la venta' })).status, 201);
    assert.equal((await disburse(carlos.money, req)).status, 201);
    assert.equal(await custody(carlos.membershipId, r1), 0);
  });

  test('CRED-008 · desembolso administrativo: solo el responsable de capital o el SuperAdmin, desde la bolsa del responsable', async () => {
    const mk = async (name: string) => {
      const req = (await request(carlos.call, r1, await newClient(r1, name), { amountMinor: 30_000 })).body['id'] as string;
      assert.equal((await gabi('POST', `/v1/credit-requests/${req}/approve`, {})).status, 200);
      return req;
    };
    const a = await mk('Admin Uno'); const b = await mk('Admin Dos');
    assert.equal((await disburse(xavier.money, a)).body['error'], 'CAPITAL_AUTHORITY_REQUIRED', 'Administrador asignado que no es responsable');
    const before = await pool(M.anaAdmin);
    assert.equal((await disburse($ana, a)).status, 201);
    assert.equal(await pool(M.anaAdmin), before - 30_000);
    assert.equal((await disburse($bruno, b)).status, 201, 'el SuperAdmin paga con la bolsa del responsable');
    assert.equal(await pool(M.anaAdmin), before - 60_000);
    assert.equal(await count(db.admin, `select 1 from adex.capital_operations where kind = 'LOAN_DISBURSEMENT' and admin_membership_id = $1`, [M.anaAdmin]), 2);
  });

  test('CRED-009 · venta directa: Admin desde la bolsa, Supervisor desde su custodia y con límite; el Cobrador no', async () => {
    const cl = await newClient(r1, 'Directa Admin');
    const r = await $ana('/v1/credits/direct', { routeId: r1, clientId: cl, ...cond({ amountMinor: 20_000, interestRate: 10 }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([(r.body['credit'] as Body)['saleRequestId'], (r.body['credit'] as Body)['totalValueMinor']], [null, 22_000]);
    assert.equal((await carlos.money('/v1/credits/direct', { routeId: r1, clientId: await newClient(r1, 'Directa Cob'), ...cond() })).status, 403);
    const max = Number((await db.admin.query('select max_loan_minor m from adex.routes where id = $1', [r1])).rows[0].m);
    assert.ok(max > 0);
    assert.equal((await dora.money('/v1/credits/direct', { routeId: r1, clientId: await newClient(r1, 'Sobre límite'), ...cond({ amountMinor: max + 1 }) })).body['error'], 'DIRECT_SALE_LIMIT');
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: dora.membershipId, amountMinor: 40_000, reason: 'Base de Dora' })).status, 201);
    const ok = await dora.money('/v1/credits/direct', { routeId: r1, clientId: await newClient(r1, 'Directa Sup'), ...cond({ amountMinor: 40_000 }) });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(await custody(dora.membershipId, r1), 0);
    assert.equal((await dora.money('/v1/credits/direct', { routeId: r1, clientId: await newClient(r1, 'Sin efectivo'), ...cond({ amountMinor: 1 }) })).body['error'], 'INSUFFICIENT_FUNDS');
  });

  test('CRED-010 · crédito activo (toda la empresa): la segunda solicitud se marca; una aprobada sin desembolsar también cuenta', async () => {
    const cl = await newClient(r1, 'Con crédito');
    const sale = (await $ana('/v1/credits/direct', { routeId: r1, clientId: cl, ...cond({ amountMinor: 10_000 }) })).body['credit'] as Body;
    const second = await request(carlos.call, r1, cl);
    assert.equal(second.status, 201);
    assert.deepEqual([second.body['authorizationReason'], second.body['activeCreditSaleIdsAtRequest']], ['active-credit', [sale['id']]]);
    const ctx = (await gabi('GET', `/v1/credit-requests/${second.body['id']}`)).body['activeCreditsNow'] as Body;
    assert.equal(ctx['count'], 1);
    const cl2 = await newClient(r1, 'Aprobada pendiente');
    const first = (await request(carlos.call, r1, cl2)).body['id'] as string;
    assert.equal((await gabi('POST', `/v1/credit-requests/${first}/approve`, {})).status, 200);
    assert.equal((await request(carlos.call, r1, cl2)).body['authorizationReason'], 'active-credit');
  });

  test('CRED-011 · cancelación de una aprobada (Admin/SuperAdmin): ya no admite desembolso', async () => {
    const req = (await request(carlos.call, r1, await newClient(r1, 'Cancelada'))).body['id'] as string;
    assert.equal((await ana('POST', `/v1/credit-requests/${req}/cancel`, { reason: 'Pendiente' })).body['error'], 'REQUEST_STATE_INVALID', 'solo una aprobada');
    assert.equal((await gabi('POST', `/v1/credit-requests/${req}/approve`, {})).status, 200);
    assert.equal((await carlos.call('POST', `/v1/credit-requests/${req}/cancel`, { reason: 'Yo' })).status, 403);
    const r = await ana('POST', `/v1/credit-requests/${req}/cancel`, { reason: 'El cliente desistió' });
    assert.deepEqual([r.status, r.body['status'], r.body['cancelledBy']], [200, 'cancelled', M.anaAdmin]);
    assert.equal((await disburse($ana, req)).body['error'], 'REQUEST_NOT_DISBURSABLE');
  });

  test('CRED-012 · consultas por rol y ruta; un desembolso no se anula; la conciliación crédito ↔ libro cuadra', async () => {
    const credits = (await carlos.call('GET', '/v1/credits')).body['credits'] as Body[];
    assert.ok(credits.length > 0 && credits.every((c) => c['routeId'] === r1));
    const one = credits.find((c) => c['ledgerOperationId'])!;
    const detail = (await carlos.call('GET', `/v1/credits/${one['id']}`)).body;
    assert.ok((detail['events'] as Body[]).every((e) => e['actorId'] === carlos.membershipId), 'el Cobrador solo ve sus propias acciones');
    assert.equal((await gil.call('GET', `/v1/credits/${one['id']}`)).status, 404, 'otra ruta');
    const mine = (await carlos.call('GET', '/v1/credit-requests')).body['requests'] as Body[];
    assert.ok(mine.every((r) => r['requestedBy'] === carlos.membershipId), 'el Cobrador ve sus solicitudes');
    const inbox = (await gabi('GET', '/v1/credit-requests?status=pending')).body['requests'] as Body[];
    assert.ok(inbox.length > 0 && inbox.every((r) => r['routeId'] === r1 && r['status'] === 'pending'));
    const op = (await db.admin.query(`select id from adex.capital_operations where kind = 'LOAN_DISBURSEMENT' limit 1`)).rows[0].id;
    assert.equal((await $ana(`/v1/capital/operations/${op}/reverse`, { reason: 'Anular préstamo' })).body['error'], 'REVERSAL_NOT_ALLOWED');
    const rec = (await bruno('GET', '/v1/capital/reconciliation')).body;
    assert.equal(rec['ok'], true, JSON.stringify(rec));
    assert.ok((rec['checks'] as Body[]).some((c) => c['name'] === 'portfolio-matches-credits'));
    assert.equal(((await bruno('GET', '/v1/capital/summary')).body['company'] as Body)['portfolioMinor'], await portfolio(r1));
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('CRED-013 · segunda barrera (SQL): transiciones, autoaprobación, tasas y escritura directa de créditos', async () => {
    const cl = await newClient(r1, 'Barrera');
    const req = (await request(carlos.call, r1, cl)).body['id'] as string;
    const ctx = (person: string, m: string) => ({ identityId: person, membershipId: m, companyId: c1 });
    await asApi(db.api, ctx(carlos.identityId, carlos.membershipId), async (q) => {
      const u = await q.query(`update adex.sale_requests set status = 'approved' where id = $1`, [req]);
      assert.equal(u.rowCount, 0, 'el Cobrador no resuelve (RLS)');
      for (const [sql, code] of [
        [`insert into adex.sales (id, company_id) values ('x', '${c1}')`, '42501'],
        [`insert into adex.installments (id, company_id) values ('x', '${c1}')`, '42501'],
        [`insert into adex.sale_requests (id, company_id, client_id, route_id, collector_membership_id, amount_minor, interest_rate, total_amount_minor,
            installments_count, installment_value_minor, frequency, start_date, payment_days, status, requested_at, requested_by_membership_id,
            requested_interest_rate, requested_frequency, requested_payment_days)
          values ('x10', '${c1}', '${cl}', '${r1}', '${carlos.membershipId}', 100, 10, 110, 1, 110, 'diaria', '${today}', '{1}', 'pending', now(),
                  '${carlos.membershipId}', 10, 'diaria', '{1}')`, 'AX502'],
        [`insert into adex.sale_requests (id, company_id, client_id, route_id, collector_membership_id, amount_minor, interest_rate, total_amount_minor,
            installments_count, installment_value_minor, frequency, start_date, payment_days, status, requested_at, requested_by_membership_id,
            requested_interest_rate, requested_frequency, requested_payment_days)
          values ('x20', '${c1}', '${cl}', '${r1}', '${carlos.membershipId}', 100, 20, 999, 1, 999, 'diaria', '${today}', '{1}', 'pending', now(),
                  '${carlos.membershipId}', 20, 'diaria', '{1}')`, 'AX503'],
      ] as const) {
        await q.query('savepoint s');
        await assert.rejects(q.query(sql), { code }, sql.slice(0, 60));
        await q.query('rollback to savepoint s');
      }
    });
    await asApi(db.api, ctx(identityOf('gabi'), M.gabiSec), async (q) => {
      for (const [sql, code] of [
        [`update adex.sale_requests set amount_minor = 1 where id = '${req}'`, '42501'],
        [`update adex.sale_requests set status = 'disbursed' where id = '${req}'`, 'AX501'],
        [`update adex.sale_requests set status = 'approved', reviewed_at = now(), reviewed_by_membership_id = '${carlos.membershipId}',
            approved_interest_rate = interest_rate, approved_frequency = frequency, approved_payment_days = payment_days where id = '${req}'`, '42501'],
      ] as const) {
        await q.query('savepoint s');
        await assert.rejects(q.query(sql), { code }, sql.slice(0, 60));
        await q.query('rollback to savepoint s');
      }
    });
    // La función de desembolso con contexto falso o de otra empresa no escribe nada.
    for (const forged of [{}, { identityId: identityOf('carla'), membershipId: membershipId('c2', 'carla-sa'), companyId: companyId('c2') }]) {
      await asApi(db.api, forged, async (q) => {
        await q.query('savepoint s');
        await assert.rejects(q.query(`select * from adex.credit_disburse(gen_random_uuid(), $1, $2, $3, 50000, 20, 12, 'diaria', $4::date, '{1,2,3,4,5,6}', '[]', 'x')`,
          [req, r1, cl, today]), (e: { code?: string }) => ['42501', 'AX412'].includes(e.code ?? ''));
        await q.query('rollback to savepoint s');
      });
    }
    await assert.rejects(db.admin.query(`select * from adex.credit_disburse(gen_random_uuid(), null, $1, $2, 1, 20, 1, 'diaria', $3::date, '{1}', '[]', 'x')`, [r1, cl, today]), { code: '42501' });
    assert.equal(await salesOf(cl), 0);
  });

  test('CRED-014 · aislamiento: otra empresa no ve solicitudes ni créditos aunque conozca los ids', async () => {
    const carla = caller(api, issuer, 'carla', M.carlaSa);
    const req = (await db.admin.query(`select id from adex.sale_requests where company_id = $1 and status = 'disbursed' limit 1`, [c1])).rows[0].id;
    const sale = (await db.admin.query(`select id from adex.sales where company_id = $1 and ledger_operation_id is not null limit 1`, [c1])).rows[0].id;
    assert.equal((await carla('GET', `/v1/credit-requests/${req}`)).status, 404);
    assert.equal((await carla('GET', `/v1/credits/${sale}`)).status, 404);
    assert.equal((await money(carla)(`/v1/credit-requests/${req}/disburse`, {})).status, 404);
    assert.equal((await carla('POST', `/v1/credit-requests/${req}/approve`, {})).status, 404);
    await asApi(db.api, { identityId: identityOf('carla'), membershipId: M.carlaSa, companyId: companyId('c2') }, async (q) => {
      assert.equal(await count(q, 'select 1 from adex.sales where company_id = $1', [c1]), 0);
      assert.equal(await count(q, 'select 1 from adex.sale_requests where company_id = $1', [c1]), 0);
    });
  });

  test('CRED-099 · sin errores inesperados en la API', () => {
    assert.deepEqual(api.errors, []);
  });
});
