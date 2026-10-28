// FASE 6 · CUADRES Y CIERRES (0014) con PostgreSQL real. Empresa sintética colombiana
// (COP, America/Bogota) creada para esta prueba; la Empresa Demo y las semillas no se tocan.
//
// Escenarios de aceptación A–H del encargo, más autoridad e identidad (DS-05), RLS,
// idempotencia, concurrencia real (clientes paralelos contra la API) y DS-04.
// Importes en unidades menores: COP tiene 2 decimales → $(500_000) = 50.000.000.

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId } from '../../db/seeds/synthetic.ts';
import { asApi, count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, parallel, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;
const $ = (pesos: number) => pesos * 100;
const CO = 'co-f6-test';

describe('Fase 6 · cuadres y cierres', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  let failNextCommit = false;
  const provider = createMemoryProvider();
  const ids = { sara: randomUUID(), ana: randomUUID() };
  const mm = { sara: 'co-f6-sara', ana: 'co-f6-ana', anaCob: 'co-f6-ana-cob' };
  let sara: Caller, ana: Caller, $sara: Money, $ana: Money, $anaCob: Money;
  let xavier: Person, dora: Person, socio: Person, olga: Person;
  const routes: Record<string, string> = {};
  const cob: Record<string, Person> = {};
  let cat = '';
  let today = '';
  let clientSeq = 0;

  const custody = (m: string, r: string) => balance(db.admin, CO, 'custody', m, r);
  const pool = (m: string) => balance(db.admin, CO, 'admin', m);
  const carried = async (m: string, r: string) => Number((await db.admin.query(
    `select coalesce((select carried_minor from adex.capital_accounts where company_id = $1 and kind = 'custody' and membership_id = $2 and route_id = $3), 0)::text c`,
    [CO, m, r])).rows[0].c);
  const preview = async (who: Caller, route: string, worker: string) => {
    const r = await who('GET', `/v1/settlements/preview?routeId=${route}&workerId=${worker}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const settle = (m: Money, route: string, worker: string, deliveredMinor: number, p: Body, extra: Body = {}, op?: string) =>
    m('/v1/settlements', { routeId: route, workerId: worker, deliveredMinor, expectedSeenMinor: p['expectedPositionMinor'],
      previousSettlementId: p['previousSettlementId'] ?? null, ...extra }, op);
  /** Vista previa + cuadre en un paso (quien cuadra mira primero las cifras del servidor). */
  const settleNow = async (who: Caller, m: Money, route: string, worker: string, delivered: number, reason?: string) => {
    const p = await preview(who, route, worker);
    const r = await settle(m, route, worker, delivered, p, reason ? { reason } : {});
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body['settlement'] as Body;
  };
  const deliver = async (route: string, worker: string, amountMinor: number) => {
    const r = await $ana('/v1/capital/deliveries', { routeId: route, workerId: worker, amountMinor, reason: 'Base del día' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  };
  const giveBack = (m: Money, route: string, worker: string, amountMinor: number, op?: string) =>
    m('/v1/capital/returns', { routeId: route, workerId: worker, amountMinor, reason: 'Entrega parcial' }, op);
  const credit = async (route: string, amountMinor = $(2_000_000)) => {
    const cl = await ana('POST', '/v1/clients', { routeId: route, name: `Cliente ficticio F6 ${++clientSeq}`, documentType: 'CC',
      document: String(1_000_000 + Number.parseInt(randomBytes(3).toString('hex'), 16) % 8_999_999), phonePrimary: '3000000000',
      addressPrimary: 'Calle 1', addressSecondary: 'Barrio', business: 'Negocio sintético' });
    assert.equal(cl.status, 201, JSON.stringify(cl.body));
    const r = await $ana('/v1/credits/direct', { routeId: route, clientId: cl.body['id'], amountMinor, interestRate: 20, installmentsCount: 10,
      frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return (r.body['credit'] as Body)['id'] as string;
  };
  const collect = async (m: Money, saleId: string, amountMinor: number) => {
    const r = await m('/v1/collections', { saleId, amountMinor });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r;
  };
  const workerExpense = (m: Money, route: string, worker: string, amountMinor: number) =>
    m('/v1/expenses', { scope: 'trabajador', routeId: route, workerId: worker, categoryId: cat, amountMinor, description: 'Combustible de la moto' });
  const reconciliation = async () => {
    const r = await sara('GET', '/v1/capital/reconciliation');
    assert.equal(r.status, 200);
    const bad = (r.body['checks'] as Body[]).filter((c) => !c['ok']);
    assert.deepEqual(bad, [], 'conciliación del servidor sin diferencias');
    assert.deepEqual(await reconcile(db.admin, CO), CLEAN, 'conciliación independiente (SQL propio)');
  };

  before(async () => {
    db = await createTestDb('settlements', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider, {
      beforeCommit: async (_ctx, path) => { if (failNextCommit && path === '/v1/settlements') { failNextCommit = false; throw new Error('caída simulada antes del COMMIT'); } },
    });
    // Empresa sintética de Colombia (DS-04: su propia zona horaria).
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query(`insert into adex.companies (id, name, email, plan, status, country_code, country_label, currency_code, timezone, created_at, updated_at)
                     values ($1, 'Cobros Ficticios F6 SAS', 'f6-empresa@example.test', 'operativo', 'activa', 'CO', 'Colombia', 'COP', 'America/Bogota', now(), now())`, [CO]);
      await c.query(`insert into adex.identities (id, email) values ($1, 'f6-sara@example.test'), ($2, 'f6-ana@example.test')`, [ids.sara, ids.ana]);
      await c.query(`insert into adex.memberships (id, company_id, identity_id, role, status, display_name, created_at, updated_at)
                     values ($1, $4, $5, 'superadmin', 'activo', 'Sara SuperAdmin', now(), now()),
                            ($2, $4, $6, 'admin', 'activo', 'Ana Administradora', now(), now()),
                            ($3, $4, $6, 'cobrador', 'activo', 'Ana Cobradora', now(), now())`, [mm.sara, mm.ana, mm.anaCob, CO, ids.sara, ids.ana]);
      await c.query('commit');
    } finally { c.release(); }
    provider.ids.set('f6-sara@example.test', ids.sara);
    provider.ids.set('f6-ana@example.test', ids.ana);
    today = (await db.admin.query(`select (now() at time zone 'America/Bogota')::date::text d`)).rows[0].d;
    sara = caller(api, issuer, ids.sara, mm.sara); $sara = money(sara);
    ana = caller(api, issuer, ids.ana, mm.ana); $ana = money(ana);
    $anaCob = money(caller(api, issuer, ids.ana, mm.anaCob));
    const route = async (key: string) => {
      const r = await sara('POST', '/v1/routes', { name: `Ruta F6 ${key}`, interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [mm.ana] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      routes[key] = r.body['id'] as string;
    };
    for (const k of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'S', 'R', 'Q', 'X', 'Own']) await route(k);
    const mk = (email: string, role: string, displayName: string, routeIds: string[]) => newPerson(api, issuer, provider.ids, sara, { email, role, displayName, routeIds });
    for (const k of ['A', 'B', 'C', 'D', 'F', 'G', 'H', 'S', 'R', 'Q', 'X']) cob[k] = await mk(`f6-cob-${k.toLowerCase()}@example.test`, 'cobrador', `Cobrador ${k}`, [routes[k]!]);
    xavier = await mk('f6-xavier@example.test', 'admin', 'Xavier (no responsable)', [routes['A']!, routes['S']!]);
    dora = await mk('f6-dora@example.test', 'supervisor', 'Dora Supervisora', [routes['A']!, routes['E']!, routes['S']!]);
    socio = await mk('f6-sec@example.test', 'secretario', 'Secretario Fabio', [routes['A']!]);
    olga = await mk('f6-olga@example.test', 'admin', 'Olga Administradora', [routes['Q']!]);
    assert.equal((await sara('PUT', `/v1/members/${mm.anaCob}/routes`, { routeIds: [routes['Own']!] })).status, 200);
    cat = (await sara('POST', '/v1/expense-categories', { name: 'Combustible' })).body['id'] as string;
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: $(200_000_000), reason: 'Capital sintético F6' }],
      ['/v1/capital/allocations', { adminId: mm.ana, amountMinor: $(100_000_000), reason: 'Bolsa de Ana' }],
      ['/v1/capital/allocations', { adminId: olga.membershipId, amountMinor: $(1_000_000), reason: 'Bolsa de Olga' }],
    ] as const) assert.equal((await $sara(path, body)).status, 201, path);
  });
  after(async () => { await api.close(); await db.close(); });

  // ==========================================================
  // Escenarios de aceptación A–H
  // ==========================================================
  test('F6-A · cuadre exacto: esperado 500.000, entregado 500.000 → diferencia 0, 500.000 a la bolsa, ciclo cerrado y conciliado', async () => {
    const [r, w] = [routes['A']!, cob['A']!];
    await deliver(r, w.membershipId, $(300_000));
    await collect(w.money, await credit(r), $(200_000));
    const p = await preview(ana, r, w.membershipId);
    assert.deepEqual([p['expectedPositionMinor'], p['expectedCashMinor'], p['carriedMinor'], p['previousSettlementId']], [$(500_000), $(500_000), 0, null]);
    assert.deepEqual([(p['cycle'] as Body)['baseDeliveredMinor'], (p['cycle'] as Body)['collectedMinor'], (p['cycle'] as Body)['openingMinor']], [$(300_000), $(200_000), 0]);
    const poolBefore = await pool(mm.ana);
    const res = await settle($ana, r, w.membershipId, $(500_000), p);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const s = res.body['settlement'] as Body;
    assert.deepEqual([s['result'], s['differenceMinor'], s['shortageMinor'], s['surplusMinor'], s['returnedToPoolMinor'], s['carriedAfterMinor'], s['status'], s['version'], s['cycleNo']],
      ['exacto', 0, 0, 0, $(500_000), 0, 'cerrada', 1, 1]);
    assert.equal(s['businessDate'], today, 'fecha contable del servidor en la zona de la empresa');
    assert.equal(await pool(mm.ana), poolBefore + $(500_000));
    assert.deepEqual([await custody(w.membershipId, r), await carried(w.membershipId, r)], [0, 0]);
    const op = (await db.admin.query('select kind, amount_minor::bigint::text a, settlement_id from adex.capital_operations where id = $1', [s['returnOperationId']])).rows[0];
    assert.deepEqual(op, { kind: 'SETTLEMENT_RETURN', a: String($(500_000)), settlement_id: s['id'] });
    assert.equal(await count(db.admin, `select 1 from adex.audit_log where action = 'CASH_SETTLEMENT_CLOSED' and entity_id = $1 and txid is not null`, [s['id']]), 1);
    // Un cuadre no cierra la semana.
    assert.equal(await count(db.admin, 'select 1 from adex.weekly_settlements where route_id = $1', [r]), 0);
    // Reintento con el mismo id: mismo resultado, sin un segundo cuadre ni un segundo retorno.
    const again = await settle($ana, r, w.membershipId, $(500_000), p, {}, res.operationId);
    assert.deepEqual([again.status, (again.body['settlement'] as Body)['id']], [201, s['id']]);
    assert.equal(await count(db.admin, 'select 1 from adex.custody_settlements where route_id = $1', [r]), 1);
    assert.equal(await pool(mm.ana), poolBefore + $(500_000));
    await reconciliation();
  });

  test('F6-B · faltante: 450.000 de 500.000 → faltante 50.000 arrastrado, bolsa +450.000; el arrastre no es gastable ni se descuenta dos veces', async () => {
    const [r, w] = [routes['B']!, cob['B']!];
    await deliver(r, w.membershipId, $(500_000));
    const p = await preview(ana, r, w.membershipId);
    assert.equal((await settle($ana, r, w.membershipId, $(450_000), p)).body['error'], 'REASON_REQUIRED', 'una diferencia exige motivo');
    assert.equal((await settle($ana, r, w.membershipId, $(450_000), p, { reason: 'corto' })).body['error'], 'REASON_REQUIRED');
    const poolBefore = await pool(mm.ana);
    const s1 = (await settle($ana, r, w.membershipId, $(450_000), p, { reason: 'Faltaron billetes al contar' })).body['settlement'] as Body;
    assert.deepEqual([s1['result'], s1['differenceMinor'], s1['shortageMinor'], s1['returnedToPoolMinor'], s1['carriedAfterMinor']],
      ['faltante', -$(50_000), $(50_000), $(450_000), $(50_000)]);
    assert.equal(await pool(mm.ana), poolBefore + $(450_000), 'a la bolsa SOLO el efectivo recibido');
    assert.deepEqual([await custody(w.membershipId, r), await carried(w.membershipId, r)], [$(50_000), $(50_000)], 'deuda dentro de la custodia, marcada como arrastre');
    // El arrastre no es efectivo: no se devuelve, no se traspasa ni paga gastos de bolsa.
    assert.equal((await giveBack($ana, r, w.membershipId, $(1))).body['error'], 'INSUFFICIENT_FUNDS');
    assert.equal((await $ana('/v1/capital/worker-transfers', { routeId: r, fromWorkerId: w.membershipId, toWorkerId: dora.membershipId, amountMinor: $(1), reason: 'Traspaso' })).status >= 400, true);
    const mine = await preview(w.call, r, w.membershipId);
    assert.deepEqual([mine['expectedPositionMinor'], mine['availableMinor'], mine['carriedMinor']], [$(50_000), 0, $(50_000)], '«Mi efectivo» del cobrador');
    // Ciclo 2: cobra 100.000 y entrega 100.000 → el faltante sigue siendo 50.000 (no 100.000).
    const s = await credit(r);
    await collect(w.money, s, $(100_000));
    const p2 = await preview(ana, r, w.membershipId);
    assert.deepEqual([p2['expectedPositionMinor'], (p2['cycle'] as Body)['openingMinor'], p2['availableMinor'], p2['previousSettlementId']],
      [$(150_000), $(50_000), $(100_000), s1['id']]);
    const s2 = (await settle($ana, r, w.membershipId, $(100_000), p2, { reason: 'Aún no repone el faltante' })).body['settlement'] as Body;
    assert.deepEqual([s2['shortageMinor'], s2['carriedAfterMinor'], s2['openingCarriedMinor']], [$(50_000), $(50_000), $(50_000)], 'el mismo faltante, una sola vez');
    // Ciclo 3: repone los 50.000 → exacto, arrastre 0.
    const s3 = await settleNow(ana, $ana, r, w.membershipId, $(50_000));
    assert.deepEqual([s3['result'], s3['carriedAfterMinor'], s3['cycleNo']], ['exacto', 0, 3]);
    assert.equal(await pool(mm.ana), poolBefore - $(2_000_000) + $(600_000), 'bolsa: −crédito + 500.000 de Base + 100.000 cobrados, ni un peso más');
    assert.deepEqual([await custody(w.membershipId, r), await carried(w.membershipId, r)], [0, 0]);
    await reconciliation();
  });

  test('F6-C · sobrante: presenta 530.000 de 500.000 → 30.000 identificados en control, no convertidos en capital disponible', async () => {
    const [r, w] = [routes['C']!, cob['C']!];
    await deliver(r, w.membershipId, $(500_000));
    const poolBefore = await pool(mm.ana);
    const summaryBefore = (await sara('GET', '/v1/capital/summary')).body['company'] as Body;
    const s = await settleNow(ana, $ana, r, w.membershipId, $(530_000), 'Entregó billetes de más sin explicación');
    assert.deepEqual([s['result'], s['surplusMinor'], s['shortageMinor'], s['returnedToPoolMinor'], s['carriedAfterMinor']], ['sobrante', $(30_000), 0, $(500_000), 0]);
    assert.equal(await pool(mm.ana), poolBefore + $(500_000), 'la bolsa disponible NO crece por el sobrante');
    assert.equal(await balance(db.admin, CO, 'suspense', mm.ana, r), $(30_000), 'efectivo físico recibido, en control');
    assert.equal(await balance(db.admin, CO, 'unidentified', null, r), -$(30_000), 'origen sin identificar (contrapartida)');
    assert.equal(await custody(w.membershipId, r), 0);
    const summary = (await sara('GET', '/v1/capital/summary')).body['company'] as Body;
    assert.equal(summary['unidentifiedSurplusMinor'], (summaryBefore['unidentifiedSurplusMinor'] as number) + $(30_000));
    assert.equal(summary['availableMinor'], summaryBefore['availableMinor'], 'tampoco crece el capital de la empresa');
    const op = (await db.admin.query(`select kind, amount_minor::bigint::text a from adex.capital_operations where id = $1`, [s['surplusOperationId']])).rows[0];
    assert.deepEqual(op, { kind: 'SETTLEMENT_SURPLUS', a: String($(30_000)) });
    // Ningún comando puede gastar el sobrante: no existe vía que debite la cuenta de control.
    const kinds = (await db.admin.query(`select distinct coalesce(o.reverses_kind, o.kind) k from adex.capital_entries e join adex.capital_accounts a on a.id = e.account_id
                                          join adex.capital_operations o on o.id = e.operation_id where a.company_id = $1 and a.kind in ('suspense', 'unidentified')`, [CO])).rows.map((x) => x.k);
    assert.deepEqual(kinds, ['SETTLEMENT_SURPLUS']);
    await reconciliation();
  });

  test('F6-D · entregas parciales: +500 +300 −400 +200 −100 → esperado 500.000; las devoluciones no se duplican al cuadrar', async () => {
    const [r, w] = [routes['D']!, cob['D']!];
    const poolStart = await pool(mm.ana);
    await deliver(r, w.membershipId, $(500_000));
    const sale = await credit(r);
    await collect(w.money, sale, $(300_000));
    assert.equal((await giveBack(w.money, r, w.membershipId, $(400_000))).status, 403, 'nadie registra su propia entrega');
    assert.equal((await giveBack(dora.money, r, w.membershipId, $(400_000))).status, 404, 'Supervisora de otra ruta: ruta fuera de su alcance');
    assert.equal((await giveBack($ana, r, w.membershipId, $(400_000))).status, 201);
    await collect(w.money, sale, $(200_000));
    assert.equal((await giveBack($ana, r, w.membershipId, $(100_000))).status, 201);
    assert.equal(await count(db.admin, 'select 1 from adex.custody_settlements where route_id = $1', [r]), 0, 'una entrega parcial no cierra el cuadre');
    const p = await preview(ana, r, w.membershipId);
    const c = p['cycle'] as Body;
    assert.deepEqual([p['expectedPositionMinor'], c['baseDeliveredMinor'], c['collectedMinor'], c['partialReturnsMinor']], [$(500_000), $(500_000), $(500_000), $(500_000)]);
    const s = await settleNow(ana, $ana, r, w.membershipId, $(500_000));
    assert.deepEqual([s['result'], s['returnedToPoolMinor'], s['baseReturnedMinor']], ['exacto', $(500_000), $(500_000)]);
    assert.equal(await pool(mm.ana), poolStart - $(500_000) - $(2_000_000) + $(400_000) + $(100_000) + $(500_000), 'devoluciones contadas UNA vez (el crédito salió de la bolsa)');
    assert.equal(await custody(w.membershipId, r), 0);
    await reconciliation();
  });

  test('F6-E · varios trabajadores: A 400.000, B 250.000, Supervisora 100.000 → consolidado 750.000; cada custodia independiente', async () => {
    const r = routes['E']!;
    const b = await newPerson(api, issuer, provider.ids, sara, { email: 'f6-cob-e-b@example.test', role: 'cobrador', displayName: 'Cobrador E-B', routeIds: [r] });
    await deliver(r, b.membershipId, $(250_000));
    // Rotación: el Cobrador A sustituye a B en la ruta (un Cobrador por ruta, CLEAN); B conserva su custodia.
    const a = await newPerson(api, issuer, provider.ids, sara, { email: 'f6-cob-e-a@example.test', role: 'cobrador', displayName: 'Cobrador E-A', routeIds: [r] });
    await deliver(r, a.membershipId, $(400_000));
    await deliver(r, dora.membershipId, $(100_000));
    const list = (await ana('GET', `/v1/settlements/workers?routeId=${r}`)).body;
    const pos = Object.fromEntries((list['workers'] as Body[]).map((x) => [x['workerId'], [x['positionMinor'], x['assigned']]]));
    assert.deepEqual([pos[a.membershipId], pos[b.membershipId], pos[dora.membershipId]], [[$(400_000), true], [$(250_000), false], [$(100_000), true]]);
    assert.equal(list['routeTotalPositionMinor'], $(750_000), 'el consolidado agrega; no mueve ni concentra dinero');
    assert.equal(await count(db.admin, `select 1 from adex.capital_accounts where company_id = $1 and route_id = $2 and kind not in ('custody')`, [CO, r]), 0, 'sin caja de ruta');
    // La Supervisora cuadra al Cobrador A (faltante 50.000): B y ella no cambian.
    const sA = await settleNow(dora.call, dora.money, r, a.membershipId, $(350_000), 'Faltante reportado en campo');
    assert.deepEqual([sA['shortageMinor'], await custody(b.membershipId, r), await custody(dora.membershipId, r)], [$(50_000), $(250_000), $(100_000)]);
    // B ya no está asignado, pero su efectivo no queda varado: se cuadra.
    const sB = await settleNow(ana, $ana, r, b.membershipId, $(250_000));
    assert.equal(sB['result'], 'exacto');
    // La Supervisora no se cuadra a sí misma; la Administradora sí la cuadra.
    const pd = await preview(ana, r, dora.membershipId);
    assert.equal((await settle(dora.money, r, dora.membershipId, $(100_000), pd)).body['error'], 'SELF_SETTLEMENT_FORBIDDEN');
    assert.equal((await settle($ana, r, dora.membershipId, $(100_000), pd)).status, 201);
    assert.deepEqual([await custody(a.membershipId, r), await carried(a.membershipId, r), await custody(b.membershipId, r), await carried(b.membershipId, r)],
      [$(50_000), $(50_000), 0, 0], 'el faltante de A no pasa a B');
    await reconciliation();
  });

  test('F6-F · gasto con posición negativa: 20.000 − 50.000 = −30.000; se concilia sin devolución ficticia y sigue al ciclo siguiente', async () => {
    const [r, w] = [routes['F']!, cob['F']!];
    await deliver(r, w.membershipId, $(20_000));
    assert.equal((await workerExpense(w.money, r, w.membershipId, $(50_000))).status, 201);
    const p = await preview(ana, r, w.membershipId);
    assert.deepEqual([p['expectedPositionMinor'], p['expectedCashMinor'], p['negativePositionMinor'], p['availableMinor']], [-$(30_000), 0, -$(30_000), 0]);
    assert.equal((await giveBack($ana, r, w.membershipId, $(1))).body['error'], 'INSUFFICIENT_FUNDS', 'nada que devolver');
    const poolBefore = await pool(mm.ana);
    const s = (await settle($ana, r, w.membershipId, 0, p)).body['settlement'] as Body;
    assert.deepEqual([s['result'], s['returnedToPoolMinor'], s['returnOperationId'], s['negativePositionMinor'], s['carriedAfterMinor']],
      ['exacto', 0, null, -$(30_000), 0], 'sin devolución física ficticia; el negativo NO se convierte en sobrante ni se borra');
    assert.equal(await pool(mm.ana), poolBefore, 'ninguna bolsa cubre el negativo (sin reembolso automático)');
    assert.equal(await custody(w.membershipId, r), -$(30_000), 'el negativo sigue en la custodia');
    // Un segundo cuadre sin movimientos (ciclo vacío) también es válido y no duplica nada.
    const empty = await settleNow(ana, $ana, r, w.membershipId, 0);
    assert.deepEqual([empty['cycleNo'], empty['expectedPositionMinor'], (empty['breakdown'] as Body)['entries']], [2, -$(30_000), 0]);
    // Si presentara dinero con la posición negativa, todo es sobrante (no paga el adelanto).
    const pNeg = await preview(ana, r, w.membershipId);
    assert.equal((await settle($ana, r, w.membershipId, $(1_000), pNeg)).body['error'], 'REASON_REQUIRED');
    // Ciclo siguiente: nueva Base de 100.000 → posición 70.000; el adelanto se compensa con operaciones válidas.
    await deliver(r, w.membershipId, $(100_000));
    const p2 = await preview(ana, r, w.membershipId);
    assert.deepEqual([p2['expectedPositionMinor'], (p2['cycle'] as Body)['openingMinor']], [$(70_000), -$(30_000)]);
    const s2 = await settleNow(ana, $ana, r, w.membershipId, $(70_000));
    assert.deepEqual([s2['result'], await custody(w.membershipId, r)], ['exacto', 0]);
    assert.equal(await pool(mm.ana), poolBefore - $(100_000) + $(70_000));
    await reconciliation();
  });

  test('F6-G · recaudo concurrente: vista 500.000, entra un cobro de 100.000 → el cuadre obsoleto se rechaza; esperado 600.000; cada cobro en un solo ciclo', async () => {
    const [r, w] = [routes['G']!, cob['G']!];
    await deliver(r, w.membershipId, $(400_000));
    const sale = await credit(r);
    await collect(w.money, sale, $(100_000));
    const seen = await preview(ana, r, w.membershipId);
    assert.equal(seen['expectedPositionMinor'], $(500_000));
    await collect(w.money, sale, $(100_000));
    const stale = await settle($ana, r, w.membershipId, $(500_000), seen);
    assert.deepEqual([stale.status, stale.body['error']], [409, 'SETTLEMENT_STALE']);
    assert.ok(!JSON.stringify(stale.body).match(/\d{4,}/), 'el rechazo no revela cifras');
    const fresh = await preview(ana, r, w.membershipId);
    assert.equal(fresh['expectedPositionMinor'], $(600_000));
    const s = (await settle($ana, r, w.membershipId, $(600_000), fresh)).body['settlement'] as Body;
    assert.equal(s['result'], 'exacto');
    // Concurrencia real: cobros en ráfaga mientras se intenta cuadrar con cifras recién leídas.
    const done: string[] = [];
    await Promise.all([
      parallel(8, async () => { await collect(w.money, sale, $(1_000)); }),
      (async () => {
        for (let i = 0; i < 6; i++) {
          const pp = await preview(ana, r, w.membershipId);
          const rr = await settle($ana, r, w.membershipId, Math.max(0, pp['expectedPositionMinor'] as number), pp);
          assert.ok([201, 409].includes(rr.status), JSON.stringify(rr.body));
          if (rr.status === 201) done.push((rr.body['settlement'] as Body)['id'] as string);
        }
      })(),
    ]);
    const final = await preview(ana, r, w.membershipId);
    if ((final['expectedPositionMinor'] as number) > 0) await settleNow(ana, $ana, r, w.membershipId, final['expectedPositionMinor'] as number);
    // Cada pata de la custodia pertenece exactamente a UN ciclo (tramos contiguos y disjuntos).
    const acc = (await db.admin.query(`select id from adex.capital_accounts where company_id = $1 and kind = 'custody' and membership_id = $2 and route_id = $3`, [CO, w.membershipId, r])).rows[0].id;
    const cycles = (await db.admin.query(`select from_seq::bigint::text f, to_seq::bigint::text t, closing_seq::bigint::text c from adex.custody_settlements
                                           where custody_account_id = $1 and status = 'cerrada' order by cycle_no`, [acc])).rows;
    for (let i = 1; i < cycles.length; i++) assert.equal(cycles[i].f, cycles[i - 1].c, 'cada ciclo empieza donde termina el anterior');
    const orphan = await count(db.admin, `select 1 from adex.capital_entries e where e.account_id = $1 and not exists (
      select 1 from adex.custody_settlements s where s.custody_account_id = e.account_id and s.status = 'cerrada' and e.seq > s.from_seq and e.seq <= s.closing_seq)`, [acc]);
    assert.equal(orphan, 0, 'ningún cobro quedó fuera de un ciclo ni en dos');
    assert.deepEqual([await custody(w.membershipId, r), await carried(w.membershipId, r)], [0, 0]);
    await reconciliation();
  });

  test('F6-H · semana cerrada (5–11 oct 2026, Colombia): el cierre archiva el libro; un ajuste posterior va al periodo abierto, enlazado y autorizado', async () => {
    const [r, w] = [routes['H']!, cob['H']!];
    await deliver(r, w.membershipId, $(300_000));
    const sale = await credit(r, $(1_000_000));
    await collect(w.money, sale, $(100_000));
    const exp = await workerExpense(w.money, r, w.membershipId, $(20_000));
    const expenseId = (exp.body['expense'] as Body)['id'] as string;
    // Fixture: lo anterior ocurrió el 8 de octubre (los asientos del servidor siempre se fechan
    // HOY; para simular el pasado se re-fechan como propietario en esta base de prueba).
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local role adex_owner');
      for (const t of ['capital_operations', 'payments', 'expenses', 'sales']) await c.query(`alter table adex.${t} disable trigger user`);
      await c.query(`update adex.capital_operations set entry_date = '2026-10-08', created_at = '2026-10-08T15:00:00Z' where company_id = $1 and (route_id = $2 or to_route_id = $2)`, [CO, r]);
      await c.query(`update adex.payments set payment_date = '2026-10-08' where company_id = $1 and route_id = $2`, [CO, r]);
      await c.query(`update adex.expenses set expense_date = '2026-10-08' where company_id = $1 and route_id = $2`, [CO, r]);
      for (const t of ['capital_operations', 'payments', 'expenses', 'sales']) await c.query(`alter table adex.${t} enable trigger user`);
      await c.query('commit');
    } finally { c.release(); }
    const close = (m: Money, weekStart: string, weekEnd: string, op?: string) => m('/v1/periods/close', { routeId: r, weekStart, weekEnd, note: 'Cierre semanal' }, op);
    // D29 (0038): un periodo que termina mañana (en Bogotá) no se cierra; hoy sí (DS4-002).
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    assert.deepEqual([(await close($ana, today, tomorrow)).status, (await close($ana, today, tomorrow)).body['error']], [409, 'PERIOD_NOT_ENDED']);
    // Autoridad: solo el responsable (R74 (cambio de regla en esta intervención): el SuperAdmin ya no cierra periodos).
    assert.equal((await close(xavier.money, '2026-10-05', '2026-10-11')).status, 404, 'Administrador sin la ruta');
    assert.equal((await dora.money('/v1/periods/close', { routeId: routes['E'], weekStart: '2026-10-05', weekEnd: '2026-10-11' })).status, 403,
      'Supervisora: no cierra la semana (ni en su ruta)');
    assert.equal((await close(w.money, '2026-10-05', '2026-10-11')).status, 403, 'Cobrador');
    const liq = (await ana('GET', `/v1/periods/liquidation?routeId=${r}&from=2026-10-05&to=2026-10-11`)).body;
    assert.deepEqual([liq['ended'], liq['closable']], [true, true]);
    const res = await close($ana, '2026-10-05', '2026-10-11');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const cust = (res.body['figures'] as Body)['custody'] as Body;
    assert.deepEqual([cust['openingMinor'], cust['deliveriesMinor'], cust['collectionsMinor'], cust['workerExpensesMinor'], cust['closingMinor']],
      [0, $(300_000), $(100_000), $(20_000), $(380_000)]);
    assert.deepEqual([res.body['weekStart'], res.body['weekEnd'], res.body['timezone'], res.body['businessDate']], ['2026-10-05', '2026-10-11', 'America/Bogota', today]);
    const week = (await db.admin.query(`select status, version, closing_balance_minor::bigint::text closing, capital_controller_at_close_id ctrl from adex.weekly_settlements where id = $1`,
      [res.body['closureId']])).rows[0];
    assert.deepEqual(week, { status: 'cerrada', version: 1, closing: String($(380_000)), ctrl: mm.ana });
    // Sin duplicados ni solapes; un cierre ya archivado no se reescribe.
    assert.equal((await close($ana, '2026-10-05', '2026-10-11')).body['error'], 'PERIOD_OVERLAP');
    assert.equal((await close($sara, '2026-10-10', '2026-10-12')).status, 403, 'R74 (cambio de regla en esta intervención): el SuperAdmin ya no cierra periodos');
    assert.equal((await close($ana, '2026-10-10', '2026-10-12')).body['error'], 'PERIOD_OVERLAP');
    await assert.rejects(db.admin.query(`update adex.period_closures set note = 'x' where id = $1`, [res.body['closureId']]));
    await assert.rejects(db.admin.query(`update adex.weekly_settlements set closing_balance_minor = 0 where id = $1`, [res.body['closureId']]));
    // Ajuste posterior: la anulación del gasto del 8 de octubre exige autoridad de ajuste y va HOY.
    const rev = await $ana(`/v1/expenses/${expenseId}/reverse`, { reason: 'Gasto registrado dos veces' });
    assert.equal(rev.status, 201, JSON.stringify(rev.body));
    const op = (await db.admin.query(`select entry_date::text d, reverses_kind, reverses_operation_id is not null linked from adex.capital_operations where expense_id = $1`,
      [(rev.body['reversal'] as Body)['id']])).rows[0];
    assert.deepEqual(op, { d: today, reverses_kind: 'WORKER_EXPENSE', linked: true }, 'asiento nuevo en el periodo abierto, enlazado al original');
    const aud = (await db.admin.query(`select metadata->>'periodClosed' closed, metadata->>'originalDate' orig from adex.audit_log where action = 'MOVEMENT_REVERSED' and entity_id = $1`, [expenseId])).rows[0];
    assert.deepEqual(aud, { closed: 'true', orig: '2026-10-08' });
    // El cierre histórico no cambia: archivo y recálculo del rango siguen idénticos.
    const archived = (await ana('GET', `/v1/periods/${res.body['closureId']}`)).body;
    assert.deepEqual((archived['figures'] as Body)['custody'], cust);
    const again = (await ana('GET', `/v1/periods/liquidation?routeId=${r}&from=2026-10-05&to=2026-10-11`)).body;
    assert.deepEqual(again['custody'], cust);
    assert.equal((again['operations'] as Body)['hash'], archived['ledgerHash']);
    const now = (await ana('GET', `/v1/periods/liquidation?routeId=${r}&from=${today}&to=${today}`)).body;
    assert.equal((now['custody'] as Body)['workerExpensesMinor'], -$(20_000), 'la corrección aparece en el periodo abierto');
    // Visibilidad: el Cobrador no ve los cierres; la Supervisora de la ruta, sí (Ronda 53: sin Socio).
    assert.equal((await w.call('GET', `/v1/periods?routeId=${r}`)).status, 403);
    assert.equal((await ana('GET', `/v1/periods?routeId=${r}`)).body['closures'] instanceof Array, true);
    await reconciliation();
    // ADEX Online (0016): REABRIR la semana (CLEAN `reopenSettlement`). Motivo ≥ 10; responsable
    // o SuperAdmin; no borra ni recalcula; volver a cerrar crea la versión 2 que la sustituye.
    const reopen = (m: Money, reason: string, id = res.body['closureId'] as string) => m(`/v1/periods/${id}/reopen`, { reason });
    assert.deepEqual([(await reopen($ana, 'corto')).status, (await reopen($ana, 'corto')).body['error']], [400, 'REASON_REQUIRED']);
    assert.equal((await reopen(w.money, 'Corrección de un abono del día 8')).status, 403, 'Cobrador');
    assert.ok([403, 404].includes((await reopen(xavier.money, 'Corrección de un abono del día 8')).status), 'Administrador sin la ruta');
    const ro = await reopen($ana, 'Corrección de un abono del día 8');
    assert.equal(ro.status, 200, JSON.stringify(ro.body));
    assert.equal((ro.body['closure'] as Body)['status'], 'reabierta');
    assert.deepEqual((await reopen($ana, 'Corrección de un abono del día 8')).body['error'], 'SETTLEMENT_NOT_REOPENABLE');
    const audRo = (await db.admin.query(`select reason from adex.audit_log where action = 'SETTLEMENT_REOPENED' and entity_id = $1`, [res.body['closureId']])).rows;
    assert.deepEqual(audRo, [{ reason: 'Corrección de un abono del día 8' }]);
    assert.deepEqual(((await ana('GET', `/v1/periods/${res.body['closureId']}`)).body['figures'] as Body)['custody'], cust, 'el archivo no cambia');
    const v2 = await close($ana, '2026-10-05', '2026-10-11');
    assert.equal(v2.status, 201, JSON.stringify(v2.body));
    assert.equal(v2.body['version'], 2);
    const v1 = (await db.admin.query('select status, superseded_by from adex.weekly_settlements where id = $1', [res.body['closureId']])).rows[0];
    assert.deepEqual(v1, { status: 'reabierta', superseded_by: v2.body['closureId'] });
    assert.deepEqual((await reopen($ana, 'Intento sobre una versión sustituida')).body['error'], 'SETTLEMENT_NOT_REOPENABLE');
    await reconciliation();
  });

  // ==========================================================
  // Autoridad, identidad (DS-05), RLS y segunda barrera
  // ==========================================================
  test('SEC6-001 · quién cuadra: responsable, SuperAdmin y Supervisor de la ruta; no el Cobrador, el Administrador no responsable, el Secretario ni otra empresa', async () => {
    const [r, w] = [routes['S']!, cob['S']!];
    await deliver(r, w.membershipId, $(10_000));
    const p = await preview(ana, r, w.membershipId);
    const before = await custody(w.membershipId, r);
    assert.equal((await settle(w.money, r, w.membershipId, $(10_000), p)).status, 403, 'el Cobrador no cuadra (ni a sí mismo)');
    assert.equal((await settle(xavier.money, r, w.membershipId, $(10_000), p)).body['error'], 'CAPITAL_AUTHORITY_REQUIRED', 'Administrador asignado, no responsable');
    assert.ok([403, 404].includes((await settle(socio.money, r, w.membershipId, $(10_000), p)).status), 'el Secretario no cuadra');
    assert.equal((await settle(money(caller(api, issuer, 'carla', M.carlaSa)), r, w.membershipId, $(10_000), p)).status, 404, 'otra empresa: indistinguible de inexistente');
    assert.equal((await settle(money(caller(api, issuer, 'gabi', M.gabiSec)), r, w.membershipId, $(10_000), p)).status, 404, 'Secretaria de otra empresa');
    assert.equal(await custody(w.membershipId, r), before);
    await assert.rejects(db.control.query(`select adex.custody_settle(gen_random_uuid(), $1, $2, 1, 1, null, null)`, [r, w.membershipId]), { code: '42501' }, 'Owner: sin acceso financiero');
    await asApi(db.api, { identityId: xavier.identityId, membershipId: xavier.membershipId, companyId: CO }, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(q.query(`select adex.custody_settle(gen_random_uuid(), $1, $2, $3, $3, null, null)`, [r, w.membershipId, $(10_000)]), { code: 'AX402' }, 'segunda barrera');
      await q.query('rollback to savepoint s');
    });
    await asApi(db.api, { identityId: randomUUID(), membershipId: xavier.membershipId, companyId: CO }, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(q.query(`select adex.custody_settle(gen_random_uuid(), $1, $2, 1, 1, null, null)`, [r, w.membershipId]), { code: '42501' }, 'contexto falsificado');
      await q.query('rollback to savepoint s');
    });
    assert.equal((await settle(dora.money, r, w.membershipId, $(10_000), p)).status, 201, 'la Supervisora de la ruta sí');
  });

  test('SEC6-002 · DS-05: la misma persona no se cuadra ni reabre su propio cuadre con otra membresía (comparación por identidad)', async () => {
    const r = routes['Own']!;
    // R74 (cambio de regla en esta intervención): el SuperAdmin ya no cuadra; lo hace la Supervisora de la ruta. H3: Ana Administradora tampoco se entrega
    // Base a sí misma como Cobradora, así que su efectivo viene de un cobro.
    const paula = await newPerson(api, issuer, provider.ids, sara, { email: 'f6-paula@example.test', role: 'supervisor', displayName: 'Paula Supervisora', routeIds: [r] });
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r, workerId: mm.anaCob, amountMinor: $(5_000), reason: 'Base propia' })).body['error'], 'SELF_DELIVERY_FORBIDDEN');
    await collect($anaCob, await credit(r, $(100_000)), $(5_000));
    const p = await preview(sara, r, mm.anaCob);
    const res = await settle($ana, r, mm.anaCob, $(5_000), p);
    assert.deepEqual([res.status, res.body['error']], [403, 'SELF_SETTLEMENT_FORBIDDEN'], 'Ana administradora no cuadra a Ana cobradora');
    await asApi(db.api, { identityId: ids.ana, membershipId: mm.ana, companyId: CO }, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(q.query('select adex.custody_settle(gen_random_uuid(), $1, $2, $3, $3, null, null)', [r, mm.anaCob, $(5_000)]), { code: 'AX801' });
      await q.query('rollback to savepoint s');
    });
    assert.equal((await settle($sara, r, mm.anaCob, $(5_000), p)).status, 403, 'R74 (cambio de regla en esta intervención): el SuperAdmin ya no cuadra');
    const s = (await settle(paula.money, r, mm.anaCob, $(5_000), p)).body['settlement'] as Body;
    assert.equal(s['result'], 'exacto', 'otra persona autorizada sí');
    const re = await $ana(`/v1/settlements/${s['id']}/reopen`, { reason: 'Revisión del conteo del día' });
    assert.deepEqual([re.status, re.body['error']], [403, 'SELF_SETTLEMENT_FORBIDDEN']);
  });

  test('SEC6-003 · RLS: el Cobrador ve solo sus cuadres y su «Mi efectivo»; nada de otra ruta, otra persona ni otra empresa; Owner sin acceso', async () => {
    const wB = cob['B']!;
    const mine = (await wB.call('GET', '/v1/settlements')).body['settlements'] as Body[];
    assert.ok(mine.length >= 3 && mine.every((s) => s['workerId'] === wB.membershipId));
    assert.equal((await wB.call('GET', `/v1/settlements/preview?routeId=${routes['A']}&workerId=${cob['A']!.membershipId}`)).status, 404, 'otra ruta');
    assert.equal((await cob['A']!.call('GET', `/v1/settlements/preview?routeId=${routes['A']}&workerId=${dora.membershipId}`)).status, 403, 'otra persona de su ruta');
    assert.equal((await wB.call('GET', `/v1/settlements/workers?routeId=${routes['B']}`)).status, 403, 'el listado de la ruta es de quien gestiona');
    const other = (await money(caller(api, issuer, 'carla', M.carlaSa))('/v1/settlements', {})).status;
    assert.ok([400, 404].includes(other));
    assert.equal(((await caller(api, issuer, 'carla', M.carlaSa)('GET', '/v1/settlements')).body['settlements'] as Body[]).length, 0, 'otra empresa no ve nada');
    const sees = await asApi(db.api, { identityId: cob['A']!.identityId, membershipId: cob['A']!.membershipId, companyId: CO }, async (q) =>
      Number((await q.query(`select count(*) n from adex.custody_settlements where worker_membership_id <> $1`, [cob['A']!.membershipId])).rows[0].n));
    assert.equal(sees, 0);
    const suspenseVisible = await asApi(db.api, { identityId: xavier.identityId, membershipId: xavier.membershipId, companyId: CO }, async (q) =>
      Number((await q.query(`select count(*) n from adex.capital_accounts where kind in ('suspense', 'unidentified')`)).rows[0].n));
    assert.equal(suspenseVisible, 0, 'el sobrante en control de Ana no lo ve otro Administrador');
    await assert.rejects(db.control.query('select count(*) from adex.custody_settlements'), { code: '42501' }, 'Owner: sin datos financieros');
    const sup = (await dora.call('GET', `/v1/settlements?routeId=${routes['E']}`)).body['settlements'] as Body[];
    assert.ok(sup.length >= 3, 'la Supervisora ve los cuadres de su ruta');
  });

  test('SEC6-004 · los asientos del cuadre no se anulan por la vía genérica ni se crean con `capital_post`', async () => {
    const opId = (await db.admin.query(`select id from adex.capital_operations where company_id = $1 and kind = 'SETTLEMENT_RETURN' limit 1`, [CO])).rows[0].id;
    const r = await $ana(`/v1/capital/operations/${opId}/reverse`, { reason: 'Intento genérico' });
    assert.deepEqual([r.status, r.body['error']], [409, 'REVERSAL_NOT_ALLOWED']);
    await asApi(db.api, { identityId: ids.ana, membershipId: mm.ana, companyId: CO }, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(q.query(`select adex.capital_post(gen_random_uuid(), 'SETTLEMENT_RETURN', 100, 'Retorno inventado', $1, $2)`, [routes['A'], cob['A']!.membershipId]), { code: 'AX411' });
      await q.query('rollback to savepoint s');
      await assert.rejects(q.query(`select adex.capital_post(gen_random_uuid(), 'REVERSAL', null, 'Anular retorno', null, null, null, null, null, null, $1)`, [opId]), { code: 'AX411' });
      await q.query('rollback to savepoint s');
      await assert.rejects(q.query(`insert into adex.custody_settlements (id) values ('x')`), { code: '42501' }, 'sin escritura directa');
      await q.query('rollback to savepoint s');
    });
  });

  // ==========================================================
  // Reapertura (open period only), concurrencia e idempotencia
  // ==========================================================
  test('REO-001 · reabrir el último cuadre: el efectivo vuelve a la custodia, el arrastre al anterior; volver a cerrar crea la versión 2', async () => {
    const [r, w] = [routes['R']!, cob['R']!];
    await deliver(r, w.membershipId, $(200_000));
    const s1 = await settleNow(ana, $ana, r, w.membershipId, $(150_000), 'Faltante de cincuenta mil');
    await deliver(r, w.membershipId, $(10_000));
    const s2 = await settleNow(ana, $ana, r, w.membershipId, $(10_000), 'Pago del faltante pendiente');
    const poolBefore = await pool(mm.ana);
    assert.equal((await dora.money(`/v1/settlements/${s2['id']}/reopen`, { reason: 'Supervisor intenta reabrir' })).status, 404, 'Supervisora sin la ruta');
    assert.equal((await xavier.money(`/v1/settlements/${s1['id']}/reopen`, { reason: 'Administrador no responsable' })).status, 404);
    // R74 (cambio de regla en esta intervención): el SuperAdmin ya no reabre cuadres (antes era quien reabría aquí); lo hace la responsable.
    assert.equal((await $sara(`/v1/settlements/${s2['id']}/reopen`, { reason: 'Conteo equivocado del día' })).status, 403, 'el SuperAdmin ya no reabre');
    assert.equal((await $ana(`/v1/settlements/${s1['id']}/reopen`, { reason: 'No es el último cuadre' })).body['error'], 'SETTLEMENT_NOT_REOPENABLE', 'solo el último');
    assert.equal((await $ana(`/v1/settlements/${s2['id']}/reopen`, { reason: 'corto' })).body['error'], 'REASON_REQUIRED');
    const re = await $ana(`/v1/settlements/${s2['id']}/reopen`, { reason: 'Conteo equivocado del día' });
    assert.equal(re.status, 201, JSON.stringify(re.body));
    assert.equal((re.body['settlement'] as Body)['status'], 'reabierta');
    assert.equal(await pool(mm.ana), poolBefore - $(10_000), 'el retorno se revierte desde la bolsa que lo recibió');
    assert.deepEqual([await custody(w.membershipId, r), await carried(w.membershipId, r)], [$(60_000), $(50_000)], 'arrastre de antes del cuadre reabierto');
    assert.equal((await $ana(`/v1/settlements/${s2['id']}/reopen`, { reason: 'Segunda reapertura' })).body['error'], 'SETTLEMENT_NOT_REOPENABLE');
    const p = await preview(ana, r, w.membershipId);
    assert.deepEqual([p['previousSettlementId'], p['expectedPositionMinor']], [s1['id'], $(60_000)]);
    const v2 = (await settle($ana, r, w.membershipId, $(60_000), p)).body['settlement'] as Body;
    assert.deepEqual([v2['cycleNo'], v2['version'], v2['result']], [2, 2, 'exacto']);
    assert.equal((await ana('GET', `/v1/settlements/${s2['id']}`)).body['settlement'] instanceof Object, true);
    const old = (await db.admin.query('select status, superseded_by from adex.custody_settlements where id = $1', [s2['id']])).rows[0];
    assert.deepEqual(old, { status: 'reabierta', superseded_by: v2['id'] }, 'el documento anterior se conserva, sustituido');
    await reconciliation();
  });

  test('REO-002 · no se reabre si la bolsa ya usó ese efectivo (nunca se recupera dinero ya usado)', async () => {
    const [r, w] = [routes['Q']!, cob['Q']!];
    assert.equal((await sara('PUT', `/v1/routes/${r}/capital-controller`, { membershipId: olga.membershipId, reason: 'Ruta de Olga' })).status, 200);
    const $olga = money(caller(api, issuer, olga.identityId, olga.membershipId));
    const olgaCall = caller(api, issuer, olga.identityId, olga.membershipId);
    assert.equal((await $olga('/v1/capital/deliveries', { routeId: r, workerId: w.membershipId, amountMinor: $(500_000), reason: 'Base' })).status, 201);
    const s = await settleNow(olgaCall, $olga, r, w.membershipId, $(500_000));
    const all = await pool(olga.membershipId);
    assert.equal((await $sara('/v1/capital/admin-returns', { adminId: olga.membershipId, amountMinor: all, reason: 'Recogida de la bolsa' })).status, 201);
    // R74 (cambio de regla en esta intervención): el SuperAdmin ya no reabre; lo intenta la responsable (Olga).
    const re = await $olga(`/v1/settlements/${s['id']}/reopen`, { reason: 'Revisión del cuadre del día' });
    assert.deepEqual([re.status, re.body['error']], [409, 'FUNDS_ALREADY_USED']);
    assert.equal((await db.admin.query('select status from adex.custody_settlements where id = $1', [s['id']])).rows[0].status, 'cerrada');
    await reconciliation();
  });

  test('CC6-001 · dos intentos simultáneos del mismo cuadre: exactamente uno; el mismo id dos veces a la vez: un solo resultado', async () => {
    const [r, w] = [routes['A']!, cob['A']!];
    await deliver(r, w.membershipId, $(40_000));
    const p = await preview(ana, r, w.membershipId);
    const poolBefore = await pool(mm.ana);
    // R74 (cambio de regla en esta intervención): el SuperAdmin ya no cuadra: el segundo intento simultáneo es de la Supervisora de la ruta.
    const two = await Promise.all([settle($ana, r, w.membershipId, $(40_000), p), settle(dora.money, r, w.membershipId, $(40_000), p)]);
    assert.deepEqual(two.map((x) => x.status).sort(), [201, 409], JSON.stringify(two.map((x) => x.body)));
    assert.equal(await pool(mm.ana), poolBefore + $(40_000));
    await deliver(r, w.membershipId, $(7_000));
    const p2 = await preview(ana, r, w.membershipId);
    const op = randomUUID();
    const same = await Promise.all([settle($ana, r, w.membershipId, $(7_000), p2, {}, op), settle($ana, r, w.membershipId, $(7_000), p2, {}, op)]);
    assert.deepEqual(same.map((x) => x.status), [201, 201]);
    assert.equal((same[0]!.body['settlement'] as Body)['id'], (same[1]!.body['settlement'] as Body)['id']);
    assert.equal(await count(db.admin, 'select 1 from adex.custody_settlements where operation_id = $1', [op]), 1);
    assert.equal((await ana('GET', `/v1/operations/${op}`)).body['outcome'], 'approved', 'respuesta perdida: el resultado se recupera por su id');
    await reconciliation();
  });

  test('CC6-002 · caída antes del COMMIT: nada queda escrito; el reintento con el mismo id cuadra una sola vez', async () => {
    const [r, w] = [routes['A']!, cob['A']!];
    await deliver(r, w.membershipId, $(3_000));
    const p = await preview(ana, r, w.membershipId);
    const op = randomUUID();
    const [n0, pool0] = [await count(db.admin, 'select 1 from adex.custody_settlements'), await pool(mm.ana)];
    failNextCommit = true;
    const crash = await settle($ana, r, w.membershipId, $(3_000), p, {}, op);
    assert.equal(crash.status, 500);
    assert.deepEqual([await count(db.admin, 'select 1 from adex.custody_settlements'), await pool(mm.ana), await custody(w.membershipId, r)], [n0, pool0, $(3_000)]);
    assert.equal((await ana('GET', `/v1/operations/${op}`)).status, 404, 'no llegó a confirmarse: repetir es seguro');
    const retry = await settle($ana, r, w.membershipId, $(3_000), p, {}, op);
    assert.equal(retry.status, 201);
    assert.equal(await pool(mm.ana), pool0 + $(3_000));
  });

  test('CC6-003 · ráfaga mixta (recaudos, gastos, entregas parciales y cuadres) contra la misma custodia: sin interbloqueos, sin dinero perdido ni duplicado', async () => {
    const [r, w] = [routes['A']!, cob['A']!];
    await deliver(r, w.membershipId, $(300_000));
    const sale = await credit(r, $(3_000_000));
    const statuses: number[] = [];
    const errorsBefore = api.errors.length;
    await Promise.all([
      parallel(6, async () => { statuses.push((await w.money('/v1/collections', { saleId: sale, amountMinor: $(2_000) })).status); }),
      parallel(4, async () => { statuses.push((await workerExpense(w.money, r, w.membershipId, $(1_000))).status); }),
      parallel(4, async () => { statuses.push((await giveBack(dora.money, r, w.membershipId, $(5_000))).status); }),
      parallel(3, async () => {
        const pp = await preview(ana, r, w.membershipId);
        statuses.push((await settle($ana, r, w.membershipId, Math.max(0, pp['expectedPositionMinor'] as number), pp)).status);
      }),
    ]);
    assert.ok(statuses.every((s) => [201, 409].includes(s)), `estados: ${statuses.join(',')}`);
    assert.equal(api.errors.length, errorsBefore, 'sin errores 500 (interbloqueos ni carreras)');
    const last = await preview(ana, r, w.membershipId);
    if ((last['expectedPositionMinor'] as number) !== 0) {
      await settleNow(ana, $ana, r, w.membershipId, Math.max(0, last['expectedPositionMinor'] as number), 'Cierre de la ráfaga concurrente');
    }
    await reconciliation();
  });

  test('CC6-004 · revocación y cambio de responsable concurrentes con el cuadre: o antes o después, nunca a medias', async () => {
    const r = routes['S']!;
    const w = cob['S']!;
    await deliver(r, w.membershipId, $(20_000));
    const p = await preview(dora.call, r, w.membershipId);
    const [res, deact] = await Promise.all([settle(dora.money, r, w.membershipId, $(20_000), p), sara('POST', `/v1/members/${dora.membershipId}/deactivate`)]);
    assert.equal(deact.status, 200, JSON.stringify(deact.body));
    assert.ok([201, 403].includes(res.status), JSON.stringify(res.body));
    const after = await settle(dora.money, r, w.membershipId, $(20_000), await preview(ana, r, w.membershipId));
    assert.equal(after.status, 403, 'membresía revocada: ya no cuadra');
    assert.equal((await sara('POST', `/v1/members/${dora.membershipId}/reactivate`)).status, 200);
    // Cambio de responsable mientras se cuadra: el retorno va a la bolsa del responsable vigente al bloquear la ruta.
    await deliver(r, w.membershipId, $(9_000));
    const pp = await preview(ana, r, w.membershipId);
    const [anaPool, xPool] = [await pool(mm.ana), await pool(xavier.membershipId)];
    const [st, chg] = await Promise.all([
      settle(dora.money, r, w.membershipId, pp['expectedPositionMinor'] as number, pp),   // R74 (cambio de regla en esta intervención): el SuperAdmin ya no cuadra
      sara('PUT', `/v1/routes/${r}/capital-controller`, { membershipId: xavier.membershipId, reason: 'Rotación de responsable' }),
    ]);
    assert.equal(chg.status, 200, JSON.stringify(chg.body));
    assert.equal(st.status, 201, JSON.stringify(st.body));
    const receiver = (st.body['settlement'] as Body)['receiverAdminId'];
    const delta = (pp['expectedPositionMinor'] as number);
    if (receiver === mm.ana) assert.deepEqual([await pool(mm.ana), await pool(xavier.membershipId)], [anaPool + delta, xPool]);
    else assert.deepEqual([receiver, await pool(mm.ana), await pool(xavier.membershipId)], [xavier.membershipId, anaPool, xPool + delta]);
    assert.equal((await sara('PUT', `/v1/routes/${r}/capital-controller`, { membershipId: mm.ana, reason: 'Vuelve Ana' })).status, 200);
    await reconciliation();
  });

  test('CC6-006 · el arrastre no financia desembolsos; desembolso simultáneo al cuadre: uno antes que el otro, sin efectivo inventado', async () => {
    const [r, w] = [routes['X']!, cob['X']!];
    await deliver(r, w.membershipId, $(100_000));
    await settleNow(ana, $ana, r, w.membershipId, $(60_000), 'Faltante de cuarenta mil');
    await deliver(r, w.membershipId, $(50_000));
    assert.deepEqual([await custody(w.membershipId, r), await carried(w.membershipId, r)], [$(90_000), $(40_000)]);
    const request = async (amountMinor: number) => {
      const cl = await ana('POST', '/v1/clients', { routeId: r, name: `Cliente ficticio F6 ${++clientSeq}`, documentType: 'CC',
        document: String(1_000_000 + Number.parseInt(randomBytes(3).toString('hex'), 16) % 8_999_999), phonePrimary: '3000000000', addressPrimary: 'Calle 1', addressSecondary: 'B', business: 'Negocio sintético' });
      const req = await w.call('POST', '/v1/credit-requests', { routeId: r, clientId: cl.body['id'], amountMinor, interestRate: 20, installmentsCount: 10,
        frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
      assert.equal(req.status, 201, JSON.stringify(req.body));
      const id = req.body['id'] as string;
      assert.equal((await ana('POST', `/v1/credit-requests/${id}/approve`, {})).status, 200);
      return id;
    };
    // 60.000 > 50.000 de efectivo real (90.000 − 40.000 de faltante): rechazado aunque la posición sea 90.000.
    const big = await request($(60_000));
    assert.equal((await w.money(`/v1/credit-requests/${big}/disburse`, {})).body['error'], 'INSUFFICIENT_FUNDS');
    const ok = await request($(50_000));
    const p = await preview(ana, r, w.membershipId);
    const [disb, st] = await Promise.all([w.money(`/v1/credit-requests/${ok}/disburse`, {}), settle($ana, r, w.membershipId, $(90_000), p)]);
    if (st.status === 201) {
      assert.equal(disb.body['error'], 'INSUFFICIENT_FUNDS', 'cuadrado primero: el efectivo ya volvió a la bolsa');
      assert.deepEqual([await custody(w.membershipId, r), await carried(w.membershipId, r)], [0, 0]);
    } else {
      assert.deepEqual([disb.status, st.body['error']], [201, 'SETTLEMENT_STALE'], 'desembolsado primero: el cuadre con cifras viejas se rechaza');
      const fresh = await preview(ana, r, w.membershipId);
      assert.deepEqual([fresh['expectedPositionMinor'], fresh['availableMinor']], [$(40_000), 0]);
    }
    await reconciliation();
  });

  test('CC6-005 · dos cierres simultáneos del mismo periodo: uno solo; el cierre espera a lo que está en curso en la ruta', async () => {
    const r = routes['B']!;
    const [a, b] = await Promise.all([
      $ana('/v1/periods/close', { routeId: r, weekStart: '2026-09-28', weekEnd: '2026-10-04' }),
      $ana('/v1/periods/close', { routeId: r, weekStart: '2026-09-28', weekEnd: '2026-10-04' }),   // R74 (cambio de regla en esta intervención): el SuperAdmin ya no cierra periodos
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(await count(db.admin, `select 1 from adex.weekly_settlements where route_id = $1 and week_start = '2026-09-28'`, [r]), 1);
    await reconciliation();
  });

  // ==========================================================
  // DS-04 · zona horaria de la empresa y periodo cerrado
  // ==========================================================
  test('DS4-001 · el fin del periodo y el periodo cerrado los decide el servidor con la zona de la empresa, no el reloj del dispositivo', async () => {
    const c1 = companyId('c1');
    const bruno = caller(api, issuer, 'bruno', M.brunoSa);
    const $bruno = money(bruno);
    const $anaC1 = money(caller(api, issuer, 'ana', M.anaAdmin));
    const tz = (zone: string) => db.admin.query('update adex.companies set timezone = $2 where id = $1', [c1, zone]);
    const r = (await bruno('POST', '/v1/routes', { name: 'Ruta Zonas F6', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [M.anaAdmin] })).body['id'] as string;
    const w = await newPerson(api, issuer, provider.ids, bruno, { email: 'f6-tz-cob@example.test', role: 'cobrador', displayName: 'Cobrador Zonas', routeIds: [r] });
    await $bruno('/v1/capital/company/deposits', { amountMinor: 100_000, reason: 'Capital zonas' });
    await $bruno('/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 50_000, reason: 'Bolsa zonas' });
    try {
      await tz('Pacific/Pago_Pago');                                   // UTC−11
      assert.equal((await $anaC1('/v1/capital/deliveries', { routeId: r, workerId: w.membershipId, amountMinor: 1_000, reason: 'Base' })).status, 201);
      const pagoToday = (await bruno('GET', '/v1/periods/calendar')).body['businessDate'] as string;
      const settled = await settleNow(caller(api, issuer, 'ana', M.anaAdmin), $anaC1, r, w.membershipId, 1_000);
      assert.equal(settled['businessDate'], pagoToday);
      const close = () => $anaC1('/v1/periods/close', { routeId: r, weekStart: pagoToday, weekEnd: pagoToday });
      // 0038: el periodo puede terminar hoy, pero no mañana (mañana en Pago Pago).
      const pagoTomorrow = new Date(Date.parse(`${pagoToday}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const early = await $anaC1('/v1/periods/close', { routeId: r, weekStart: pagoToday, weekEnd: pagoTomorrow });
      assert.equal(early.body['error'], 'PERIOD_NOT_ENDED', 'en Pago Pago ese periodo aún no terminó');
      await tz('Pacific/Kiritimati');                                  // UTC+14: el mismo instante ya es otro día
      const cal = (await bruno('GET', '/v1/periods/calendar')).body;
      assert.ok((cal['businessDate'] as string) > pagoToday);
      assert.equal(cal['timezone'], 'Pacific/Kiritimati');
      const closed = await close();
      assert.equal(closed.status, 201, JSON.stringify(closed.body));
      // D7: el cuadre de ese día está en un periodo cerrado → no se reabre; se corrige en el abierto.
      // R74 (cambio de regla en esta intervención): el SuperAdmin ya no reabre cuadres: lo intenta la responsable.
      const re = await $anaC1(`/v1/settlements/${settled['id']}/reopen`, { reason: 'Revisión posterior al cierre' });
      assert.deepEqual([re.status, re.body['error']], [409, 'PERIOD_CLOSED']);
      // Y lo de hoy (otro día en Kiritimati) sigue abierto: se cuadra con normalidad.
      assert.equal((await $anaC1('/v1/capital/deliveries', { routeId: r, workerId: w.membershipId, amountMinor: 500, reason: 'Base' })).status, 201);
      assert.equal((await settleNow(caller(api, issuer, 'ana', M.anaAdmin), $anaC1, r, w.membershipId, 500))['businessDate'], cal['businessDate']);
    } finally {
      await tz('America/Sao_Paulo');
    }
  });

  test('DS4-002 · cierre del mismo día (0038): se cierra un periodo que termina hoy; después, la ruta no admite movimientos de hoy', async () => {
    const bruno = caller(api, issuer, 'bruno', M.brunoSa);
    const $bruno = money(bruno);
    const $anaC1 = money(caller(api, issuer, 'ana', M.anaAdmin));
    const r = (await bruno('POST', '/v1/routes', { name: 'Ruta Mismo Día', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [M.anaAdmin] })).body['id'] as string;
    const w = await newPerson(api, issuer, provider.ids, bruno, { email: 'f6-hoy-cob@example.test', role: 'cobrador', displayName: 'Cobrador Mismo Día', routeIds: [r] });
    await $bruno('/v1/capital/company/deposits', { amountMinor: 20_000, reason: 'Capital mismo día' });
    await $bruno('/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 10_000, reason: 'Bolsa mismo día' });
    assert.equal((await $anaC1('/v1/capital/deliveries', { routeId: r, workerId: w.membershipId, amountMinor: 1_000, reason: 'Base' })).status, 201);
    const day = (await bruno('GET', '/v1/periods/calendar')).body['businessDate'] as string;
    const closed = await $anaC1('/v1/periods/close', { routeId: r, weekStart: day, weekEnd: day, note: 'Cierre del domingo por la noche' });
    assert.equal(closed.status, 201, JSON.stringify(closed.body));
    assert.equal(((closed.body['figures'] as Record<string, Record<string, number>>)['custody'])!['deliveriesMinor'], 1_000, 'el cierre incluye lo registrado hoy');
    // Lo que llegue después se registra mañana: hoy la ruta queda cerrada.
    const late = await $anaC1('/v1/capital/deliveries', { routeId: r, workerId: w.membershipId, amountMinor: 500, reason: 'Base tardía' });
    assert.deepEqual([late.status, late.body['error']], [409, 'PERIOD_CLOSED']);
    // 3.18: el Cobrador (que no ve los documentos de cierre) lee SOLO las fechas de los cierres de SUS rutas, sin cifras.
    assert.equal((await w.call('GET', '/v1/periods')).status, 403, 'el Cobrador no ve los documentos de cierre');
    const ranges = await w.call('GET', `/v1/periods/closed-ranges?routeId=${r}`);
    assert.equal(ranges.status, 200, JSON.stringify(ranges.body));
    assert.deepEqual(ranges.body['ranges'], [{ routeId: r, from: day, to: day }]);
    const all = (await w.call('GET', '/v1/periods/closed-ranges')).body['ranges'] as { routeId: string }[];
    assert.ok(all.every((x) => x.routeId === r), 'solo sus rutas');
    assert.equal(JSON.stringify(ranges.body).includes('Minor'), false, 'sin importes');
  });
});
