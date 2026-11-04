// 0042 · Venta registrada tarde y corrección de la fecha de entrega (decisión del propietario 2026-11-04),
// contra PostgreSQL real y la API (datos 100 % sintéticos).
//   · Caso 1: el Administrador registra una venta que el Cobrador olvidó (o que él mismo entregó) hasta 3 días atrás.
//   · Caso 2: el Administrador corrige la fecha de entrega de una venta registrada tarde.
//   · Días cerrados no se reabren; límites de fecha; roles; faltante de cuadre; idempotencia; conciliación.
//
// Importes en unidades menores (BRL): R$ 600 = 60_000.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, routeId } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('0042 · venta registrada tarde y fecha de entrega', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  let ana: Caller, $ana: Money, gabi: Caller, bruno: Caller, $bruno: Money;
  let today = '', yesterday = '', minus3 = '', minus4 = '';
  let n = 0;

  const custody = (m: string) => balance(db.admin, c1, 'custody', m, r1);
  const carried = async (m: string) => Number((await db.admin.query(
    `select carried_minor from adex.capital_accounts where company_id = $1 and kind = 'custody' and membership_id = $2 and route_id = $3`, [c1, m, r1])).rows[0]?.carried_minor ?? 0);
  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const newClient = async () => {
    const r = await ana('POST', '/v1/clients', { routeId: r1, name: `CLIENTE TARDE ${randomUUID().slice(0, 6)}`, documentType: 'CPF', document: cpf(),
      phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body['id'] as string;
  };
  const cond = (o: Body = {}) => ({ amountMinor: 60_000, interestRate: 20, installmentsCount: 10, frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6], ...o });
  const worker = async () => {
    n += 1;
    return newPerson(api, issuer, provider.ids, bruno, { email: `late-w${n}@example.test`, role: 'cobrador', displayName: `COBRADOR TARDE ${n}`, routeIds: [r1] });
  };
  const fund = async (w: Person, amountMinor: number) =>
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: w.membershipId, amountMinor, reason: 'Base sintética' })).status, 201);
  const late = async (o: Body, op?: string) => $ana('/v1/credits/late', {
    routeId: r1, clientId: await newClient(), ...cond(), deliveredOn: yesterday, reason: 'El cobrador olvidó registrar la venta', ...o }, op);
  const direct = async () => {
    const r = await $ana('/v1/credits/direct', { routeId: r1, clientId: await newClient(), ...cond() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return (r.body['credit'] as Body)['id'] as string;
  };
  const correct = (id: string, o: Body = {}, op?: string) =>
    $ana(`/v1/credits/${id}/delivery-date`, { deliveredOn: yesterday, reason: 'La venta se entregó el día anterior', ...o }, op);
  const credit = (r: { body: Body }) => r.body['credit'] as Body;
  const saleRow = async (id: string) => (await db.admin.query<{ disbursement_date: string; delivered_on: string | null; entry_date: string; collector: string | null }>(
    `select s.disbursement_date::text, s.delivered_on::text, o.entry_date::text, s.disbursed_by_collector_id collector
       from adex.sales s join adex.capital_operations o on o.company_id = s.company_id and o.id = s.ledger_operation_id where s.id = $1`, [id])).rows[0]!;
  const history = async (id: string) => (await db.admin.query<{ kind: string; delivered_on: string; before: string | null; after: string; applied: boolean; by: string | null }>(
    `select kind, delivered_on::text, before_disbursement_date::text before, after_disbursement_date::text after, applied_to_books applied,
            delivered_by_membership_id by from adex.sale_delivery_dates where sale_id = $1`, [id])).rows;
  const payerKind = async (id: string) => (await db.admin.query<{ kind: string }>(
    `select a.kind from adex.sales s join adex.capital_entries e on e.company_id = s.company_id and e.operation_id = s.ledger_operation_id and e.leg = 1
       join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id where s.id = $1`, [id])).rows[0]!.kind;
  const closeDay = async (day: string) => {
    const wk = randomUUID();
    await db.admin.query(
      `insert into adex.weekly_settlements (id, company_id, route_id, week_start, week_end, opening_balance_minor, capital_in_minor, collections_minor,
         loans_disbursed_minor, expenses_minor, transfers_in_minor, transfers_out_minor, withdrawals_minor, closing_balance_minor, created_at, status, closed_at, version)
       values ($1, $2, $3, $4::date, $4::date, 0, 0, 0, 0, 0, 0, 0, 0, 0, now(), 'cerrada', now(), 1)`, [wk, c1, r1, day]);
    // Un cierre nunca se borra: se reabre al terminar (transición permitida por guard_closure).
    return async () => { await db.admin.query(`update adex.weekly_settlements set status = 'reabierta', reopened_at = now(), reopen_reason = 'Fin de la prueba sintética' where id = $1`, [wk]); };
  };
  const ledgerChecks = async () => {
    const r = await bruno('GET', '/v1/capital/reconciliation');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((r.body['checks'] as Body[]).filter((c) => !c['ok']), [], 'conciliación del SuperAdmin sin fallos');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  };

  before(async () => {
    db = await createTestDb('latesale', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    gabi = caller(api, issuer, 'gabi', M.gabiSec);
    const d = (await db.admin.query(`select t::text t, (t - 1)::text y, (t - 3)::text m3, (t - 4)::text m4
                                       from (select (now() at time zone 'America/Sao_Paulo')::date t) x`)).rows[0];
    [today, yesterday, minus3, minus4] = [d.t, d.y, d.m3, d.m4];
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 3_000_000, reason: 'Bolsa de Ana' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
  });
  after(async () => { await api?.close(); await db?.close(); });

  test('LS-001 · venta olvidada por el Cobrador (ayer, semana abierta): sale de su custodia y queda en su día', async () => {
    const w = await worker(); await fund(w, 100_000);
    const k0 = await custody(w.membershipId);
    const r = await late({ deliveredBy: w.membershipId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = credit(r);
    assert.deepEqual([c['disbursementDate'], c['deliveredOn'], c['disbursedByCollectorId']], [yesterday, yesterday, w.membershipId]);
    assert.deepEqual(r.body['lateSale'], { deliveredOn: yesterday, businessDate: yesterday, appliedToBooks: true });
    assert.equal(await custody(w.membershipId), k0 - 60_000, 'sale de la custodia del Cobrador que entregó');
    assert.equal(await payerKind(c['id'] as string), 'custody');
    const row = await saleRow(c['id'] as string);
    assert.deepEqual([row.disbursement_date, row.delivered_on, row.entry_date], [yesterday, yesterday, yesterday], 'venta y asiento con la fecha real');
    assert.deepEqual(await history(c['id'] as string), [{ kind: 'LATE_REGISTRATION', delivered_on: yesterday, before: null, after: yesterday, applied: true, by: w.membershipId }]);
    await ledgerChecks();
  });

  test('LS-002 · el Administrador entregó él mismo (sin «quién entregó»): sale de la Base de la ruta', async () => {
    const r = await late({ deliveredOn: minus3 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = credit(r);
    assert.deepEqual([c['disbursementDate'], c['deliveredOn'], c['disbursedByCollectorId']], [minus3, minus3, null]);
    assert.notEqual(await payerKind(c['id'] as string), 'custody', 'paga la Base de la ruta, no una custodia');
    await ledgerChecks();
  });

  test('LS-003 · límites: hoy, 4 días atrás, inicio antes de la entrega, sin motivo, Cobrador y Secretario', async () => {
    const w = await worker(); await fund(w, 100_000);
    assert.equal((await late({ deliveredOn: today })).body['error'], 'DELIVERY_DATE_OUT_OF_RANGE');
    assert.equal((await late({ deliveredOn: minus4 })).body['error'], 'DELIVERY_DATE_OUT_OF_RANGE');
    assert.equal((await late({ deliveredOn: yesterday, startDate: minus3 })).body['error'], 'INVALID_CONDITIONS');
    assert.equal((await late({ reason: 'corto' })).status, 400);
    const body = { routeId: r1, clientId: await newClient(), ...cond(), deliveredOn: yesterday, reason: 'Intento de un rol sin autoridad' };
    assert.equal((await w.money('/v1/credits/late', body)).status, 403, 'el Cobrador no registra ventas tarde');
    assert.equal((await money(gabi)('/v1/credits/late', body)).status, 403, 'el Secretario tampoco');
    assert.equal((await db.admin.query('select count(*)::int n from adex.sales where client_id = $1', [body.clientId])).rows[0].n, 0, 'nada escrito');
  });

  test('LS-004 · semana de la fecha real cerrada: no se reabre; la venta queda hoy y la fecha real aparte', async () => {
    const w = await worker(); await fund(w, 100_000);
    const reopen = await closeDay(yesterday);
    try {
      const r = await late({ deliveredBy: w.membershipId });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const c = credit(r);
      assert.deepEqual([c['disbursementDate'], c['deliveredOn']], [today, yesterday]);
      assert.deepEqual(r.body['lateSale'], { deliveredOn: yesterday, businessDate: today, appliedToBooks: false });
      assert.equal((await saleRow(c['id'] as string)).entry_date, today, 'el asiento va a hoy: el día cerrado no cambia');
      assert.equal((await history(c['id'] as string))[0]!.applied, false);
    } finally { await reopen(); }
    await ledgerChecks();
  });

  test('LS-005 · el Cobrador ya cuadró con faltante por ese dinero: con efectivo libre la venta se registra y el cuadre siguiente sale exacto', async () => {
    const w = await worker(); await fund(w, 100_000);
    const settle = async (deliveredMinor: number, reason?: string) => {
      const p = (await ana('GET', `/v1/settlements/preview?routeId=${r1}&workerId=${w.membershipId}`)).body;
      const s = await $ana('/v1/settlements', { routeId: r1, workerId: w.membershipId, deliveredMinor, expectedSeenMinor: p['expectedPositionMinor'],
        previousSettlementId: p['previousSettlementId'] ?? null, ...(reason ? { reason } : {}) });
      assert.equal(s.status, 201, JSON.stringify(s.body));
      return s.body;
    };
    // Ayer entregó R$ 600 sin registrar: al cuadrar le faltan R$ 600.
    await settle(40_000, 'Faltan R$ 600 sin explicación');
    assert.deepEqual([await custody(w.membershipId), await carried(w.membershipId)], [60_000, 60_000], 'faltante arrastrado de R$ 600');
    const none = await late({ deliveredBy: w.membershipId });
    assert.equal(none.body['error'], 'INSUFFICIENT_FUNDS', 'sin efectivo libre: el faltante es deuda, no billetes');
    // Hoy recibe Base nueva: con efectivo libre, el Administrador registra la venta olvidada.
    await fund(w, 100_000);
    const r = await late({ deliveredBy: w.membershipId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([await custody(w.membershipId), await carried(w.membershipId)], [100_000, 60_000]);
    // En la calle tiene R$ 1.000 (la Base nueva): su cuadre siguiente sale exacto y el arrastre queda en cero.
    const s2 = await settle(100_000);
    assert.deepEqual([(s2['settlement'] as Body)['result'], await carried(w.membershipId)], ['exacto', 0], JSON.stringify(s2));
    await ledgerChecks();
  });

  test('LS-006 · idempotencia: el mismo id de operación no registra dos ventas', async () => {
    const w = await worker(); await fund(w, 100_000);
    const op = randomUUID();
    const clientId = await newClient();
    const a = await late({ clientId, deliveredBy: w.membershipId }, op);
    const b = await late({ clientId, deliveredBy: w.membershipId }, op);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(credit(b)['id'], credit(a)['id'], JSON.stringify(b.body));
    assert.equal((await db.admin.query('select count(*)::int n from adex.sales where client_id = $1', [clientId])).rows[0].n, 1);
  });

  test('LS-007 · corrección de la fecha (semanas abiertas): la venta pasa a la fecha real; el asiento conserva la suya; una sola vez', async () => {
    const id = await direct();
    const r = await correct(id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([credit(r)['disbursementDate'], credit(r)['deliveredOn']], [yesterday, yesterday]);
    assert.deepEqual(r.body['deliveryDate'], { deliveredOn: yesterday, businessDate: yesterday, appliedToBooks: true });
    const row = await saleRow(id);
    assert.deepEqual([row.disbursement_date, row.delivered_on, row.entry_date], [yesterday, yesterday, today], 'el libro no se reescribe');
    assert.deepEqual(await history(id), [{ kind: 'DATE_CORRECTION', delivered_on: yesterday, before: today, after: yesterday, applied: true, by: null }]);
    assert.equal((await correct(id, { deliveredOn: minus3 })).body['error'], 'DELIVERY_DATE_ALREADY_SET');
    await ledgerChecks();
  });

  test('LS-008 · corrección: límites, roles y semana cerrada', async () => {
    const id = await direct();
    assert.equal((await correct(id, { deliveredOn: today })).body['error'], 'DELIVERY_DATE_OUT_OF_RANGE');
    assert.equal((await correct(id, { deliveredOn: minus4 })).body['error'], 'DELIVERY_DATE_OUT_OF_RANGE');
    assert.equal((await correct(id, { reason: 'corto' })).status, 400);
    assert.equal((await money(gabi)(`/v1/credits/${id}/delivery-date`, { deliveredOn: yesterday, reason: 'Intento de un rol sin autoridad' })).status, 403);
    const reopen = await closeDay(yesterday);
    try {
      const r = await correct(id);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([credit(r)['disbursementDate'], credit(r)['deliveredOn']], [today, yesterday], 'la fecha real queda solo informativa');
      assert.equal((await history(id))[0]!.applied, false);
    } finally { await reopen(); }
    await ledgerChecks();
  });
});
