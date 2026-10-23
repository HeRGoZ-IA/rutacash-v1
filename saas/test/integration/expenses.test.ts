// FASE 5 · gastos contra PostgreSQL real y la API. Fuente financiera ≠ atribución:
//   trabajador → su custodia, SIN tope (73209ce): puede quedar negativa, y ese negativo
//                no se entrega, no se desembolsa ni se traspasa;
//   ruta       → la bolsa del responsable (C1), sin negativos;
//   empresa    → la bolsa elegida (Administrador: la suya; SuperAdmin: empresa o un
//                Administrador activo, D10/D11), sin negativos.
// Correcciones: anulación y reintegro (D12) como asientos nuevos enlazados.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { can } from '@/lib/permissions';
import { companyId, identityOf } from '../../db/seeds/synthetic.ts';
import { asApi, count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';
import { toCleanUser, USER_ROLES } from '../../src/authz/cleanRules.ts';

type Body = Record<string, unknown>;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('Fase 5 · gastos', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  let r1 = '';
  let rX = '';
  let cat = '';
  let adm: Caller;
  let bruno: Caller, ana: Caller, gabi: Caller, fabio: Caller;
  let $bruno: Money, $ana: Money;
  let carlos: Person, dora: Person, xavier: Person, olga: Person, pia: Person, eva: Person;
  let today = '';

  const pool = (m: string) => balance(db.admin, c1, 'admin', m);
  const companyAcc = () => balance(db.admin, c1, 'company', null);
  const custody = (m: string, r = r1) => balance(db.admin, c1, 'custody', m, r);
  const expenseAcc = (r: string | null) => balance(db.admin, c1, 'expense', null, r);
  const spend = (m: Money, body: Body, op?: string) => m('/v1/expenses', { categoryId: cat, ...body }, op);
  const worker = (m: Money, workerId: string, amountMinor: number, o: Body = {}, op?: string) => spend(m, { scope: 'trabajador', routeId: r1, workerId, amountMinor, description: 'Combustible', ...o }, op);
  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));

  before(async () => {
    db = await createTestDb('expenses', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    r1 = (await db.admin.query(`select id from adex.routes where company_id = $1 and name = 'Ruta 1'`, [c1])).rows[0].id;
    cat = (await db.admin.query(`select id from adex.expense_categories where company_id = $1 and name = 'Combustible'`, [c1])).rows[0].id;
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    // Ronda 67: el SuperAdmin ya no registra clientes (cartera de solo lectura); los prepara la Administradora.
    adm = caller(api, issuer, 'ana', M.anaAdmin);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    gabi = caller(api, issuer, 'gabi', M.gabiSec);
    fabio = caller(api, issuer, 'fabio', M.fabioSec);
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    const mk = (email: string, role: string, displayName: string, routeIds: string[]) => newPerson(api, issuer, provider.ids, bruno, { email, role, displayName, routeIds });
    carlos = await mk('carlos-exp@example.test', 'cobrador', 'Carlos', [r1]);
    dora = await mk('dora-exp@example.test', 'supervisor', 'Dora', [r1]);
    xavier = await mk('xavier-exp@example.test', 'admin', 'Xavier', [r1]);
    olga = await mk('olga-exp@example.test', 'admin', 'Olga', []);
    pia = await mk('pia-exp@example.test', 'admin', 'Pía', []);
    rX = (await bruno('POST', '/v1/routes', { name: 'Ruta Equis', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [M.anaAdmin] })).body['id'] as string;
    eva = await mk('eva-exp@example.test', 'cobrador', 'Eva', [rX]);
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 1_000_000, reason: 'Bolsa de Ana' }],
      ['/v1/capital/allocations', { adminId: olga.membershipId, amountMinor: 10_000, reason: 'Bolsa de Olga' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
    if ((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 10_000, reason: 'Base del día' })).status !== 201) throw new Error('entrega');
  });
  after(async () => { await api.close(); await db.close(); });

  test('EXP-001 · gasto del trabajador: baja SU posición, atribuido a ruta y trabajador, auditado con actor y responsable', async () => {
    const r = await worker(carlos.money, carlos.membershipId, 3_000);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const e = r.body['expense'] as Body;
    assert.deepEqual([e['scope'], e['routeId'], e['workerId'], e['registeredBy'], e['amountMinor'], e['expenseDate'], e['state'], e['funding']],
      ['trabajador', r1, carlos.membershipId, carlos.membershipId, 3_000, today, 'vigente', null]);
    assert.equal(await custody(carlos.membershipId), 7_000);
    assert.equal(await expenseAcc(r1), 3_000);
    assert.deepEqual((r.body['entries'] as Body[]).map((x) => (x['account'] as Body)['kind']), ['custody'], 'el Cobrador no ve la cuenta de gastos');
    const op = (await db.admin.query('select kind, worker_membership_id w, actor_role from adex.capital_operations where id = $1', [e['ledgerOperationId']])).rows[0];
    assert.deepEqual(op, { kind: 'WORKER_EXPENSE', w: carlos.membershipId, actor_role: 'cobrador' });
    assert.equal(await count(db.admin, `select 1 from adex.audit_log where action = 'CREATE_EXPENSE' and entity_id = $1 and txid is not null`, [e['id']]), 1);
    // Reintento con el mismo id: el mismo gasto; con otros datos: 409.
    const op1 = randomUUID();
    const a = await worker(carlos.money, carlos.membershipId, 1_000, {}, op1);
    const b = await worker(carlos.money, carlos.membershipId, 1_000, {}, op1);
    assert.deepEqual(b.body, a.body);
    assert.equal((await worker(carlos.money, carlos.membershipId, 1_500, {}, op1)).body['error'], 'OPERATION_ID_REUSED');
    assert.equal(await custody(carlos.membershipId), 6_000);
  });

  test('EXP-002 · gasto mayor que el efectivo (73209ce): se registra y la posición queda NEGATIVA, sin capital ficticio', async () => {
    const before = { company: await companyAcc(), ana: await pool(M.anaAdmin) };
    const r = await worker(carlos.money, carlos.membershipId, 10_000, { description: 'Reparación de la moto' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await custody(carlos.membershipId), -4_000);
    assert.deepEqual({ company: await companyAcc(), ana: await pool(M.anaAdmin) }, before, 'ni la empresa ni la bolsa cubren el negativo');
    const mine = (await carlos.call('GET', `/v1/capital/custody?routeId=${r1}`)).body['positions'] as Body[];
    assert.deepEqual(mine.map((p) => [p['workerId'], p['balanceMinor'], p['transferableMinor']]), [[carlos.membershipId, -4_000, 0]], 'Mi efectivo: −4.000, nada entregable');
    const rec = (await bruno('GET', '/v1/capital/reconciliation')).body;
    assert.equal(rec['ok'], true, JSON.stringify(rec));
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('EXP-003 · el negativo no se entrega, no se desembolsa ni se traspasa; los cobros y la Base lo compensan', async () => {
    assert.equal(await custody(carlos.membershipId), -4_000);
    const ops = await count(db.admin, 'select 1 from adex.capital_operations');
    assert.equal((await $ana('/v1/capital/returns', { routeId: r1, workerId: carlos.membershipId, amountMinor: 1, reason: 'Devolver negativo' })).body['error'], 'INSUFFICIENT_FUNDS');
    assert.equal((await $ana('/v1/capital/worker-transfers', { routeId: r1, fromWorkerId: carlos.membershipId, toWorkerId: dora.membershipId, amountMinor: 1, reason: 'Traspaso' })).body['error'], 'FUNDS_ALREADY_USED');
    const delivery = (await db.admin.query(`select id from adex.capital_operations where kind = 'WORKER_DELIVERY' and worker_membership_id = $1`, [carlos.membershipId])).rows[0].id;
    assert.equal((await $ana(`/v1/capital/operations/${delivery}/reverse`, { reason: 'Anular la Base' })).body['error'], 'FUNDS_ALREADY_USED');
    // Desembolso desde la custodia negativa: rechazado sin crear la obligación.
    const client = (await adm('POST', '/v1/clients', { routeId: r1, name: 'Cliente gasto', documentType: 'CPF', document: cpf(), phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' })).body['id'] as string;
    const req = (await carlos.call('POST', '/v1/credit-requests', { routeId: r1, clientId: client, amountMinor: 1_000, interestRate: 20, installmentsCount: 2, frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] })).body['id'] as string;
    assert.equal((await gabi('POST', `/v1/credit-requests/${req}/approve`, {})).status, 200);
    assert.equal((await carlos.money(`/v1/credit-requests/${req}/disburse`, {})).body['error'], 'INSUFFICIENT_FUNDS');
    assert.equal(await count(db.admin, 'select 1 from adex.sales where sale_request_id = $1', [req]), 0);
    assert.equal(await count(db.admin, 'select 1 from adex.capital_operations'), ops, 'nada se escribió');
    // Segunda barrera: ninguna otra operación deja la custodia bajo cero.
    await asApi(db.api, { identityId: identityOf('ana'), membershipId: M.anaAdmin, companyId: c1 }, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(q.query(`select * from adex.capital_post(gen_random_uuid(), 'WORKER_RETURN', 1, 'Devolución', $1, $2)`, [r1, carlos.membershipId]), { code: 'AX401' });
      await q.query('rollback to savepoint s');
    });
    // Base nueva y cobros compensan el negativo (posición del ciclo, como en CLEAN).
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 1_000, reason: 'Base' })).status, 201);
    assert.equal(await custody(carlos.membershipId), -3_000);
    const sale = ((await $ana('/v1/credits/direct', { routeId: r1, clientId: (await adm('POST', '/v1/clients', { routeId: r1, name: 'Paga', documentType: 'CPF', document: cpf(), phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' })).body['id'],
      amountMinor: 10_000, interestRate: 20, installmentsCount: 2, frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] })).body['credit'] as Body)['id'] as string;
    assert.equal((await carlos.money('/v1/collections', { saleId: sale, amountMinor: 5_000 })).status, 201);
    assert.equal(await custody(carlos.membershipId), 2_000);
    // Anular un cobro cuyo efectivo cubrió el negativo: ya no está en sus manos.
    const pay = (await db.admin.query('select id from adex.payments where sale_id = $1', [sale])).rows[0].id;
    assert.equal((await $ana(`/v1/collections/${pay}/reverse`, { reason: 'Error' })).body['error'], 'FUNDS_ALREADY_USED');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('EXP-004 · permisos del gasto de trabajador: el Cobrador solo los suyos; cargar a otro exige `settle`', async () => {
    assert.equal((await worker(carlos.money, dora.membershipId, 100)).status, 403, 'el Cobrador no carga gastos a otra persona');
    const d = await worker(dora.money, carlos.membershipId, 100);
    assert.equal(d.status, 201, 'el Supervisor de la ruta sí (settle)');
    assert.deepEqual([(d.body['expense'] as Body)['registeredBy'], (d.body['expense'] as Body)['workerId']], [dora.membershipId, carlos.membershipId], 'registrar ≠ responder');
    assert.equal((await worker($ana, carlos.membershipId, 100)).status, 201, 'el responsable de capital sí');
    // R74 (cambio de regla en esta intervención): el SuperAdmin ya no carga gastos a otros (antes sí).
    assert.equal((await worker($bruno, carlos.membershipId, 100)).status, 403, 'el SuperAdmin ya no (R74)');
    assert.equal((await worker(xavier.money, carlos.membershipId, 100)).body['error'], 'CAPITAL_AUTHORITY_REQUIRED', 'Administrador asignado que no es responsable');
    assert.equal((await worker(money(gabi), carlos.membershipId, 100)).status, 403, 'la Secretaria no registra gastos');
    assert.equal((await worker(money(fabio), carlos.membershipId, 100)).status, 403, 'el Socio no registra gastos');
    assert.equal((await worker($ana, eva.membershipId, 100)).body['error'], 'CUSTODIAN_INVALID', 'trabajador de otra ruta');
    assert.equal((await worker($ana, xavier.membershipId, 100)).body['error'], 'CUSTODIAN_INVALID', 'un Administrador no tiene caja personal');
    assert.equal((await spend(carlos.money, { scope: 'trabajador', routeId: r1, amountMinor: 100 })).body['error'], 'INVALID_INPUT', 'forma: falta el trabajador');
    assert.equal((await spend(carlos.money, { scope: 'trabajador', routeId: r1, workerId: carlos.membershipId, amountMinor: 100, fundingSource: 'empresa' })).body['error'], 'INVALID_INPUT', 'no elige bolsa');
    assert.equal((await worker(carlos.money, carlos.membershipId, 100, { categoryId: 'no-existe' })).body['error'], 'CATEGORY_INVALID');
    for (const amountMinor of [0, -5, 1.5]) assert.equal((await worker(carlos.money, carlos.membershipId, amountMinor)).body['error'], 'INVALID_INPUT');
  });

  test('EXP-005 · gasto de ruta: lo paga la bolsa del responsable (C1); la ruta es atribución, no caja', async () => {
    const before = await pool(M.anaAdmin);
    const r = await spend($ana, { scope: 'ruta', routeId: r1, amountMinor: 2_500, description: 'Papelería de la ruta' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await pool(M.anaAdmin), before - 2_500);
    const legs = await db.admin.query(`select a.kind, a.route_id, a.membership_id, e.amount_minor::int amt from adex.capital_entries e join adex.capital_accounts a on a.id = e.account_id
                                        where e.operation_id = $1 order by e.leg`, [(r.body['expense'] as Body)['ledgerOperationId']]);
    assert.deepEqual(legs.rows, [{ kind: 'admin', route_id: null, membership_id: M.anaAdmin, amt: -2_500 }, { kind: 'expense', route_id: r1, membership_id: null, amt: 2_500 }]);
    assert.equal(await count(db.admin, `select 1 from adex.capital_accounts where company_id = $1 and route_id = $2 and kind not in ('custody', 'portfolio', 'income', 'expense')`, [c1, r1]), 0,
      'no existe ninguna caja de ruta');
    assert.equal((await spend(xavier.money, { scope: 'ruta', routeId: r1, amountMinor: 100 })).body['error'], 'CAPITAL_AUTHORITY_REQUIRED');
    // R74: sin `cashCustody.manage` el SuperAdmin ya recibe 403 antes de la autoridad sobre la ruta.
    assert.equal((await spend($bruno, { scope: 'ruta', routeId: r1, amountMinor: 100 })).status, 403, 'el SuperAdmin asigna capital; la ruta la maneja su responsable');
    assert.equal((await spend(dora.money, { scope: 'ruta', routeId: r1, amountMinor: 100 })).body['error'], 'CAPITAL_AUTHORITY_REQUIRED');
    assert.equal((await spend(carlos.money, { scope: 'ruta', routeId: r1, amountMinor: 100 })).status, 403);
  });

  test('EXP-006 · gasto administrativo: consume SOLO la bolsa que lo paga (D10/D11)', async () => {
    const snap = async () => ({ company: await companyAcc(), ana: await pool(M.anaAdmin), olga: await pool(olga.membershipId), pia: await pool(pia.membershipId) });
    const company = (who: Money, amountMinor: number, o: Body) => spend(who, { scope: 'empresa', amountMinor, description: 'Arriendo de oficina', ...o });
    let s0 = await snap();
    assert.equal((await company($ana, 4_000, { fundingSource: 'admin', fundingAdminId: M.anaAdmin })).status, 201);
    assert.deepEqual(await snap(), { ...s0, ana: s0.ana - 4_000 });
    s0 = await snap();
    assert.equal((await company($bruno, 3_000, { fundingSource: 'empresa' })).status, 201);
    assert.deepEqual(await snap(), { ...s0, company: s0.company - 3_000 });
    s0 = await snap();
    assert.equal((await company($bruno, 2_000, { fundingSource: 'admin', fundingAdminId: olga.membershipId })).status, 201);
    assert.deepEqual(await snap(), { ...s0, olga: s0.olga - 2_000 });
    s0 = await snap();
    assert.equal((await company($ana, 1, { fundingSource: 'empresa' })).body['error'], 'POOL_NOT_ALLOWED', 'un Administrador solo paga con su bolsa');
    assert.equal((await company($ana, 1, { fundingSource: 'admin', fundingAdminId: olga.membershipId })).body['error'], 'POOL_NOT_ALLOWED', 'nunca con la de otro');
    assert.equal((await company($bruno, 1, { fundingSource: 'admin', fundingAdminId: M.anaCob })).status, 404, 'solo bolsas de Administradores');
    assert.equal((await company(dora.money, 1, { fundingSource: 'empresa' })).status, 403, 'el Supervisor no registra gastos de empresa');
    assert.equal((await company($bruno, 1, { fundingSource: 'admin' })).body['error'], 'INVALID_INPUT');
    assert.equal((await spend($bruno, { scope: 'empresa', amountMinor: 1, fundingSource: 'empresa' })).body['error'], 'INVALID_INPUT', 'concepto obligatorio');
    assert.equal((await spend($bruno, { scope: 'empresa', routeId: r1, amountMinor: 1, description: 'Con ruta', fundingSource: 'empresa' })).body['error'], 'INVALID_INPUT', 'forma');
    assert.equal((await bruno('POST', `/v1/members/${pia.membershipId}/deactivate`, {})).status, 200);
    assert.equal((await company($bruno, 1, { fundingSource: 'admin', fundingAdminId: pia.membershipId })).body['error'], 'MEMBER_INACTIVE', 'no se carga a un Administrador inactivo');
    assert.deepEqual(await snap(), s0);
  });

  test('EXP-007 · gasto administrativo sin fondos: rechazado sin escribir nada', async () => {
    const left = await pool(olga.membershipId);
    const ops = await count(db.admin, 'select 1 from adex.capital_operations');
    const exp = await count(db.admin, 'select 1 from adex.expenses');
    const r = await spend($bruno, { scope: 'empresa', amountMinor: left + 1, description: 'Más que la bolsa', fundingSource: 'admin', fundingAdminId: olga.membershipId });
    assert.deepEqual([r.status, r.body], [409, { error: 'INSUFFICIENT_FUNDS' }], 'sin cifras de saldos');
    assert.equal((await spend($bruno, { scope: 'empresa', amountMinor: (await companyAcc()) + 1, description: 'Más que la empresa', fundingSource: 'empresa' })).body['error'], 'INSUFFICIENT_FUNDS');
    const ruta = await spend($ana, { scope: 'ruta', routeId: r1, amountMinor: (await pool(M.anaAdmin)) + 1, description: 'Más que la bolsa' });
    assert.equal(ruta.body['error'], 'INSUFFICIENT_FUNDS', 'el gasto de ruta tampoco deja negativa la bolsa');
    assert.deepEqual([await count(db.admin, 'select 1 from adex.capital_operations'), await count(db.admin, 'select 1 from adex.expenses'), await pool(olga.membershipId)], [ops, exp, left]);
  });

  test('EXP-008 · otra empresa: no gasta ni ve rutas, bolsas ni categorías ajenas', async () => {
    const carla = money(caller(api, issuer, 'carla', M.carlaSa));
    const c2cat = (await db.admin.query(`select id from adex.expense_categories where company_id = $1 limit 1`, [companyId('c2')])).rows[0].id;
    assert.equal((await carla('/v1/expenses', { scope: 'ruta', routeId: r1, categoryId: c2cat, amountMinor: 100, description: 'Ruta ajena' })).status, 404);
    assert.equal((await carla('/v1/expenses', { scope: 'empresa', categoryId: c2cat, amountMinor: 100, description: 'Bolsa ajena', fundingSource: 'admin', fundingAdminId: M.anaAdmin })).status, 404);
    assert.equal((await carla('/v1/expenses', { scope: 'empresa', categoryId: cat, amountMinor: 100, description: 'Categoría ajena', fundingSource: 'empresa' })).body['error'], 'CATEGORY_INVALID');
    await asApi(db.api, { identityId: identityOf('carla'), membershipId: M.carlaSa, companyId: companyId('c2') }, async (q) => {
      for (const [sql, code] of [
        [`select adex.expense_post(gen_random_uuid(), 'ruta', '${r1}', null, '${c2cat}', 100, 'x', null, null, null)`, 'AX412'],
        [`select adex.expense_post(gen_random_uuid(), 'empresa', null, null, '${c2cat}', 100, 'Bolsa ajena', null, 'admin', '${M.anaAdmin}')`, 'AX712'],
        [`select adex.expense_post(gen_random_uuid(), 'empresa', null, null, '${cat}', 100, 'Categoría ajena', null, 'empresa', null)`, 'AX711'],
      ] as const) {
        await q.query('savepoint s');
        await assert.rejects(q.query(sql), { code }, sql.slice(0, 60));
        await q.query('rollback to savepoint s');
      }
      assert.equal(await count(q, 'select 1 from adex.expenses where company_id = $1', [c1]), 0);
    });
    await asApi(db.api, { identityId: carlos.identityId, membershipId: carlos.membershipId, companyId: c1 }, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(q.query(`insert into adex.expenses (id, company_id, category_id, amount_minor, expense_date, registered_by_membership_id, sync_status, created_at)
                                    values ('x', '${c1}', '${cat}', 1, current_date, '${carlos.membershipId}', 'synced', now())`), { code: '42501' });
      await q.query('rollback to savepoint s');
    });
  });

  test('EXP-009 · correcciones: anulación y reintegro (D12) con su autoridad; nada se reescribe', async () => {
    // Gasto de bolsa de Ana: lo anula ella (su bolsa); otro Administrador no.
    const a = (await spend($ana, { scope: 'empresa', amountMinor: 5_000, description: 'Equivocado', fundingSource: 'admin', fundingAdminId: M.anaAdmin })).body['expense'] as Body;
    const before = await pool(M.anaAdmin);
    assert.equal((await xavier.money(`/v1/expenses/${a['id']}/reverse`, { reason: 'No es mío' })).status, 404, 'la bolsa de otro ni siquiera se ve');
    assert.equal((await carlos.money(`/v1/expenses/${a['id']}/reverse`, { reason: 'Cobrador' })).status, 404);
    const rv = await $ana(`/v1/expenses/${a['id']}/reverse`, { reason: 'Registro duplicado' });
    assert.equal(rv.status, 201, JSON.stringify(rv.body));
    assert.deepEqual([(rv.body['reversal'] as Body)['amountMinor'], (rv.body['reversal'] as Body)['state'], (rv.body['original'] as Body)['state'], (rv.body['original'] as Body)['reversedBy']],
      [-5_000, 'anulacion', 'anulado', M.anaAdmin]);
    assert.equal(await pool(M.anaAdmin), before + 5_000, 'vuelve a la bolsa que pagó');
    assert.equal((await $ana(`/v1/expenses/${a['id']}/reverse`, { reason: 'Otra vez' })).body['error'], 'ALREADY_REVERSED');
    assert.equal((await $ana(`/v1/expenses/${(rv.body['reversal'] as Body)['id']}/reverse`, { reason: 'Anular la anulación' })).body['error'], 'REVERSAL_NOT_ALLOWED');
    // Reintegros parciales hasta lo no reintegrado; después ya no se anula.
    const b = (await spend($bruno, { scope: 'empresa', amountMinor: 9_000, description: 'Compra', fundingSource: 'empresa' })).body['expense'] as Body;
    const comp = await companyAcc();
    const op = randomUUID();
    const f1 = await $bruno(`/v1/expenses/${b['id']}/refunds`, { amountMinor: 4_000, reason: 'Devolución del proveedor' }, op);
    assert.deepEqual([f1.status, f1.body['remainingMinor']], [201, 5_000]);
    assert.deepEqual((await $bruno(`/v1/expenses/${b['id']}/refunds`, { amountMinor: 4_000, reason: 'Devolución del proveedor' }, op)).body, f1.body, 'idempotente');
    assert.equal((await $bruno(`/v1/expenses/${b['id']}/refunds`, { amountMinor: 5_001, reason: 'Demasiado' })).body['error'], 'REFUND_EXCEEDS_EXPENSE');
    assert.equal((await $bruno(`/v1/expenses/${b['id']}/reverse`, { reason: 'Con reintegros' })).body['error'], 'EXPENSE_HAS_REFUNDS');
    assert.equal(await companyAcc(), comp + 4_000);
    // Gastos de trabajador y de ruta (F5-D02): los anula el responsable, nunca quien los registró.
    // R74 (cambio de regla en esta intervención): el SuperAdmin ya no los anula.
    const w = (await worker(carlos.money, carlos.membershipId, 700, { description: 'Mal cargado' })).body['expense'] as Body;
    const rr = (await spend($ana, { scope: 'ruta', routeId: r1, amountMinor: 1_200, description: 'Ruta' })).body['expense'] as Body;
    assert.equal((await dora.money(`/v1/expenses/${w['id']}/reverse`, { reason: 'Supervisor' })).status, 403, 'el Supervisor no corrige');
    const cash = await custody(carlos.membershipId);
    assert.equal((await $ana(`/v1/expenses/${w['id']}/reverse`, { reason: 'Mal cargado' })).status, 201);
    assert.equal(await custody(carlos.membershipId), cash + 700);
    assert.equal((await $ana(`/v1/expenses/${rr['id']}/refunds`, { amountMinor: 100, reason: 'Parcial de ruta' })).body['error'], 'REFUND_NOT_ALLOWED', 'reintegros: solo gastos de bolsa (D12)');
    assert.equal((await $ana(`/v1/expenses/${rr['id']}/reverse`, { reason: 'Propio' })).body['error'], 'SELF_CORRECTION_FORBIDDEN', 'Ana lo registró');
    assert.equal((await $bruno(`/v1/expenses/${rr['id']}/reverse`, { reason: 'Anulado por el SuperAdmin' })).body['error'], 'CAPITAL_AUTHORITY_REQUIRED', 'R74: el SuperAdmin tampoco');
    // Históricos sembrados (D9, sin asiento): no se corrigen por esta vía.
    const legacy = (await db.admin.query(`select id from adex.expenses where company_id = $1 and ledger_operation_id is null and reverses_id is null and refunds_expense_id is null and reversal_id is null and route_id is null limit 1`, [c1])).rows[0]?.id;
    if (legacy) assert.equal((await $bruno(`/v1/expenses/${legacy}/reverse`, { reason: 'Histórico' })).body['error'], 'NOT_CORRECTABLE_HERE');
    // La anulación genérica de capital no aplica a gastos.
    assert.equal((await $bruno(`/v1/capital/operations/${rr['ledgerOperationId']}/reverse`, { reason: 'Genérica' })).body['error'], 'REVERSAL_NOT_ALLOWED');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('EXP-011 · anulación D12 de un gasto de bolsa: simultánea → una sola; auditada; devuelve a la bolsa que pagó una vez', async () => {
    const e = (await spend($ana, { scope: 'empresa', amountMinor: 3_000, description: 'Doble anulación', fundingSource: 'admin', fundingAdminId: M.anaAdmin })).body['expense'] as Body;
    const before = await pool(M.anaAdmin);
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => (i % 2 ? $bruno : $ana)(`/v1/expenses/${e['id']}/reverse`, { reason: 'Carrera de anulaciones' })));
    assert.equal(res.filter((r) => r.status === 201).length, 1, JSON.stringify(res.map((r) => r.body['error'] ?? r.status)));
    assert.ok(res.filter((r) => r.status !== 201).every((r) => r.body['error'] === 'ALREADY_REVERSED'));
    assert.equal(await pool(M.anaAdmin), before + 3_000, 'una sola devolución a la bolsa');
    assert.equal(await count(db.admin, 'select 1 from adex.expenses where reverses_id = $1', [e['id']]), 1);
    const audit = await db.admin.query(`select actor_role, reason from adex.audit_log where action = 'MOVEMENT_REVERSED' and entity_id = $1 and txid is not null`, [e['id']]);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].reason, 'Carrera de anulaciones');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('EXP-010 · visibilidad: el Cobrador ve los suyos; la ruta, quien la gestiona; las bolsas, cada Administrador la suya', async () => {
    const list = async (who: Caller, q = '') => ((await who('GET', `/v1/expenses${q}`)).body['expenses'] as Body[]);
    const mine = await list(carlos.call);
    assert.ok(mine.length > 0 && mine.every((e) => e['workerId'] === carlos.membershipId || e['registeredBy'] === carlos.membershipId));
    assert.ok((await list(dora.call)).some((e) => e['scope'] === 'ruta'), 'el Supervisor ve los gastos de su ruta');
    assert.ok((await list(dora.call)).every((e) => e['routeId'] !== null), 'pero ningún gasto de empresa');
    assert.ok((await list(fabio)).every((e) => e['routeId'] !== null));
    const anas = await list(ana);
    assert.ok(anas.some((e) => e['scope'] === 'empresa' && e['fundingAdminId'] === M.anaAdmin));
    assert.ok(anas.every((e) => e['scope'] !== 'empresa' || e['fundingAdminId'] === M.anaAdmin || (e['funding'] === null && e['registeredBy'] === M.anaAdmin)), 'nunca la bolsa de otro ni la de la empresa');
    assert.ok((await list(xavier.call)).every((e) => e['routeId'] !== null), 'Xavier no ve la bolsa de Ana');
    assert.ok((await list(bruno)).some((e) => e['funding'] === 'empresa'));
    assert.deepEqual(await list(caller(api, issuer, 'carla', M.carlaSa), `?routeId=${r1}`), []);
    assert.deepEqual(await list(eva.call), [], 'Eva (otra ruta) no ve nada de Ruta 1');
    const one = mine[0]!;
    assert.equal((await carlos.call('GET', `/v1/expenses/${one['id']}`)).status, 200);
    assert.equal((await eva.call('GET', `/v1/expenses/${one['id']}`)).status, 404);
    assert.equal((await gabi('GET', '/v1/expenses')).status, 200);
    assert.deepEqual(await list(gabi), [], 'la Secretaria no ve gastos');
  });

  test('SEC5-001 · el Owner (plano de control) no tiene autoridad financiera sobre la empresa', async () => {
    for (const sql of [
      'select count(*) from adex.payments', 'select count(*) from adex.expenses',
      `select adex.collection_post(gen_random_uuid(), 'x', 1, 'x', null)`,
      `select adex.expense_post(gen_random_uuid(), 'empresa', null, null, 'x', 1, 'x', null, 'empresa', null)`,
      `select adex.collection_reverse(gen_random_uuid(), 'x', 'motivo')`,
    ]) await assert.rejects(db.control.query(sql), { code: '42501' }, sql);
  });

  test('SEC5-002 · la API no tiene escritura directa sobre el dinero: solo las funciones', async () => {
    const r = await db.admin.query(`select table_name, privilege_type from information_schema.role_table_grants
                                     where grantee = 'adex_api' and table_schema = 'adex' and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
                                       and table_name in ('payments', 'expenses', 'sales', 'installments', 'capital_accounts', 'capital_operations', 'capital_entries')`);
    assert.deepEqual(r.rows, []);
    const definer = await db.admin.query(`select proname, prosecdef from pg_proc where pronamespace = 'adex'::regnamespace
                                           and proname in ('collection_post', 'collection_reverse', 'expense_post', 'expense_reverse', 'expense_refund') order by 1`);
    assert.deepEqual(definer.rows.map((x) => [x.proname, x.prosecdef]), [['collection_post', true], ['collection_reverse', true], ['expense_post', true], ['expense_refund', true], ['expense_reverse', true]]);
  });

  test('CAN-SQL-001 · la segunda barrera (`ctx_can`) coincide con `can()` de CLEAN para cada rol y capacidad', async () => {
    const caps = (await db.admin.query(`select pg_get_functiondef('adex.ctx_can(text)'::regprocedure) d`)).rows[0].d.match(/when '([a-zA-Z.]+)'/g)!
      .map((w: string) => w.slice(6, -1));
    assert.ok(caps.length >= 17);
    const byRole: Record<string, { identityId: string; membershipId: string }> = {
      superadmin: { identityId: identityOf('bruno'), membershipId: M.brunoSa }, admin: { identityId: identityOf('ana'), membershipId: M.anaAdmin },
      socio: { identityId: identityOf('fabio'), membershipId: M.fabioSec }, secretario: { identityId: identityOf('gabi'), membershipId: M.gabiSec },
      supervisor: { identityId: dora.identityId, membershipId: dora.membershipId }, cobrador: { identityId: carlos.identityId, membershipId: carlos.membershipId },
    };
    for (const role of USER_ROLES) {
      const who = byRole[role]!;
      const sql = await asApi(db.api, { ...who, companyId: c1 }, async (q) =>
        (await q.query<{ c: string; ok: boolean }>('select c, adex.ctx_can(c) ok from unnest($1::text[]) c', [caps])).rows);
      const user = toCleanUser({ membershipId: who.membershipId, companyId: c1, role, status: 'activo', displayName: role, routeIds: [] });
      for (const row of sql) assert.equal(row.ok, can(user, row.c as never, { tenantId: c1 }), `${role} · ${row.c}`);
    }
  });

  test('CAN-SQL-002 · las comprobaciones del libro (0019, propietario) solo responden al SuperAdmin del contexto', async () => {
    const byRole: Record<string, { identityId: string; membershipId: string }> = {
      superadmin: { identityId: identityOf('bruno'), membershipId: M.brunoSa }, admin: { identityId: identityOf('ana'), membershipId: M.anaAdmin },
      socio: { identityId: identityOf('fabio'), membershipId: M.fabioSec }, secretario: { identityId: identityOf('gabi'), membershipId: M.gabiSec },
      supervisor: { identityId: dora.identityId, membershipId: dora.membershipId }, cobrador: { identityId: carlos.identityId, membershipId: carlos.membershipId },
    };
    for (const role of USER_ROLES) {
      const run = asApi(db.api, { ...byRole[role]!, companyId: c1 }, async (q) => (await q.query('select adex.capital_ledger_checks() r')).rows[0].r);
      if (role !== 'superadmin') { await assert.rejects(run, (e: { code?: string }) => e.code === '42501', role); continue; }
      const r = await run as Record<string, number>;
      assert.deepEqual(Object.keys(r).sort(), ['carriedDrift', 'closedDrift', 'mismatched', 'negativeCustody', 'settlementDrift', 'surplusDrift', 'unbalanced']);
      for (const [k, v] of Object.entries(r)) assert.equal(v, 0, k);
    }
  });

  test('CAN-SQL-003 · 0019: aislamiento por empresa, sin suplantación y sin privilegios de más', async () => {
    const c2 = companyId('c2');
    const bruno = { identityId: identityOf('bruno'), membershipId: M.brunoSa };
    const call = (ctx: { identityId: string; membershipId: string; companyId: string }) =>
      asApi(db.api, ctx, async (q) => (await q.query('select adex.capital_ledger_checks() r')).rows[0].r as Record<string, number>);
    const denied = (e: { code?: string }) => e.code === '42501';
    // Un SuperAdmin no puede pedir la conciliación de OTRA empresa ni usar la membresía de otra persona.
    await assert.rejects(call({ ...bruno, companyId: c2 }), denied, 'SuperAdmin de c1 contra c2');
    await assert.rejects(call({ identityId: identityOf('bruno'), membershipId: M.carlaSa, companyId: c2 }), denied, 'membresía ajena');
    await assert.rejects(call({ identityId: identityOf('carla'), membershipId: M.brunoSa, companyId: c1 }), denied, 'identidad ajena');
    await assert.rejects(call({ identityId: '', membershipId: '', companyId: c1 }), denied, 'sin contexto');
    // Solo cuenta lo de SU empresa: un descuadre en c1 lo ve el SuperAdmin de c1, nunca el de c2.
    const tamper = (delta: number, id?: string) => db.admin.query(
      `update adex.capital_accounts set balance_minor = balance_minor + $2, version = version + 1
        where id = coalesce($3, (select id from adex.capital_accounts where company_id = $1 order by id limit 1)) returning id`, [c1, delta, id ?? null]);
    const acc = (await tamper(1)).rows[0]?.id as string | undefined;
    assert.ok(acc, 'c1 tiene cuentas de capital');
    try {
      assert.equal((await call({ identityId: identityOf('carla'), membershipId: M.carlaSa, companyId: c2 })).mismatched, 0, 'c2 no ve el descuadre de c1');
      assert.ok((await call({ ...bruno, companyId: c1 })).mismatched >= 1, 'c1 sí lo ve');
    } finally {
      await tamper(-1, acc);
    }
    assert.equal((await call({ ...bruno, companyId: c1 })).mismatched, 0, 'restaurado');
    // Catálogo: definer con search_path fijo, de solo lectura (STABLE) y ejecutable solo por adex_api (y su dueño).
    const f = (await db.admin.query(`select p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) owner,
             array(select coalesce(nullif(pg_get_userbyid(a.grantee), ''), 'PUBLIC') from aclexplode(p.proacl) a where a.privilege_type = 'EXECUTE' order by 1)::text[] exec
        from pg_proc p where p.oid = 'adex.capital_ledger_checks()'::regprocedure`)).rows[0];
    assert.equal(f.prosecdef, true);
    assert.equal(f.provolatile, 's');
    assert.deepEqual(f.proconfig, ['search_path=pg_catalog, adex']);
    assert.deepEqual([...f.exec].filter((g: string) => g !== f.owner), ['adex_api']);
  });

  test('SEC5-003 · ADEX Online no escribe dinero en el dispositivo: sin almacenamiento local financiero, solo comandos del servidor', () => {
    const dir = path.join(repo, 'online', 'src');
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(ts|tsx)$/.test(f));
    assert.ok(files.length > 10);
    const hits: string[] = [];
    for (const f of files) {
      // Solo código: los comentarios pueden nombrar lo que está prohibido.
      const text = readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const rel = f.replace(/\\/g, '/');
      // Ronda 48.1: única excepción, el registro del abono EN VUELO (id + cuerpo exacto) para
      // comprobarlo tras una recarga sin crear otro. Una sola clave; nada de saldos ni cálculos.
      if (rel === 'runtime/unconfirmedPayments.ts') {
        assert.deepEqual([...text.matchAll(/'adex\.[a-z.-]+\.v\d+'/g)].map((m) => m[0]), ["'adex.unconfirmed-payments.v1'"], 'una sola clave local');
        assert.doesNotMatch(text, /sessionStorage|openDatabase|indexedDB|balance|saldo/i, 'solo el registro del abono en vuelo');
        continue;
      }
      // Ronda 62: única otra excepción, el almacén CIFRADO del modo sin conexión del Cobrador: llave
      // AES-GCM NO extraíble de la membresía, copia de consulta y operaciones pendientes. Nada de
      // saldos ni cálculos: lo que decide es siempre el servidor al sincronizar.
      if (rel === 'offline/vault.ts') {
        assert.match(text, /importKey\('raw', raw, \{ name: 'AES-GCM' \}, false, \['encrypt', 'decrypt'\]\)/, 'llave importada como no extraíble');
        assert.match(text, /crypto\.subtle\.encrypt\(\{ name: 'AES-GCM', iv \}/, 'lo guardado va cifrado');
        assert.doesNotMatch(text, /localStorage|sessionStorage|openDatabase|balance|saldo/i, 'sin saldos ni otros almacenes');
        continue;
      }
      if (/localStorage|sessionStorage|openDatabase/.test(text)) hits.push(f);
      // Ronda 24/25: el puente (`bridge/`) SUSTITUYE la base local de CLEAN y por eso lleva sus
      // nombres (`RutaCashDB`, el sustituto bloqueante de `dexie`); fuera del puente siguen prohibidos.
      if (/Dexie|RutaCashDB/.test(text) && !rel.startsWith('bridge/')) hits.push(f);
      if (/indexedDB/.test(text) && rel !== 'lib/client.ts') hits.push(`${f} (indexedDB)`);
    }
    assert.deepEqual(hits, [], 'el único IndexedDB es la sesión (adex-server-mode)');
    // El paquete `dexie` está prohibido en el bundle: se resuelve a un sustituto que falla al abrir
    // una base, y el `db` del puente rechaza toda escritura que no sea un comando de la API.
    const vite = readFileSync(path.join(repo, 'online', 'vite.config.ts'), 'utf8');
    assert.match(vite, /id === 'dexie'[^\n]*BRIDGE, 'vendor', 'dexie\.ts'/, 'dexie se resuelve al sustituto bloqueante');
    assert.match(readFileSync(path.join(dir, 'bridge', 'vendor', 'dexie.ts'), 'utf8'), /constructor\(\) \{\s*throw new Error/, 'el sustituto de dexie falla al abrir una base');
    const bridgeDb = readFileSync(path.join(dir, 'bridge', 'lib', 'db.ts'), 'utf8');
    for (const op of ['put', 'bulkAdd', 'bulkPut', 'bulkDelete', 'clear']) {
      assert.match(bridgeDb, new RegExp(`async ${op}\\([^)]*\\): Promise<never> \\{ throw new OnlineWriteBlocked`), `db.${op} del puente bloqueado`);
    }
    // Ronda 26: las pantallas son las de CLEAN; sus comandos de dinero los emiten los puentes
    // (`bridge/services`) con `money()` (id de operación), nunca con `plain()`.
    const bridges = files.filter((f) => /^(bridge|runtime)[\\/]/.test(f)).map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n');
    for (const endpoint of ["'/v1/collections'", "'/v1/expenses'", '/reverse`', '/refunds`']) assert.ok(bridges.includes(endpoint), `la interfaz usa ${endpoint}`);
    assert.doesNotMatch(bridges, /plain(<[^>]*>)?\('POST', [`']\/v1\/(collections|expenses|capital|credits)/, 'los comandos de dinero van con operationId (money)');
  });

  test('EXP-099 · conciliación y sin errores inesperados', async () => {
    const rec = (await bruno('GET', '/v1/capital/reconciliation')).body;
    assert.equal(rec['ok'], true, JSON.stringify(rec));
    assert.ok((rec['checks'] as Body[]).some((c) => c['name'] === 'expense-accounts-match-expenses'));
    const summary = (await bruno('GET', '/v1/capital/summary')).body;
    assert.equal((summary['company'] as Body)['expensesMinor'], (await db.admin.query(`select coalesce(sum(balance_minor), 0)::int s from adex.capital_accounts where company_id = $1 and kind = 'expense'`, [c1])).rows[0].s);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    assert.deepEqual(api.errors, []);
  });
});
