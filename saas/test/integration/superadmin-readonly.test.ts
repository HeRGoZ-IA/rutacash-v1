// RONDA 67 · Entrega A: la CARTERA del SuperAdmin es SOLO Clientes, en consulta (decisión del
// propietario). Se prueba en las dos barreras: la API (matriz de `src/lib/permissions.ts`) y
// PostgreSQL (0028: `clients_manage_*` y `adex.ctx_can` sin el SuperAdmin en la escritura de
// cartera). El SuperAdmin conserva capital, gastos y estructura; el Administrador y los demás
// roles conservan sus escrituras; DS-05: otra membresía de la misma persona no le suma nada.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { CARTERA_WRITE_CAPS } from '@/lib/permissions';
import { companyId, identityOf, routeId, uid } from '../../db/seeds/synthetic.ts';
import { asApi, count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { money, newPerson, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('Ronda 67 · SuperAdmin: cartera de solo lectura', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const c2 = companyId('c2');
  const r1 = routeId('c1', 1);
  let bruno: Caller, ana: Caller, gabi: Caller, carla: Caller;
  let $bruno: Money, $ana: Money;
  let carlos: Person;
  let today = '';
  const brunoCtx = { identityId: identityOf('bruno'), membershipId: M.brunoSa, companyId: c1 };
  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const clientBody = (route = r1) => ({ routeId: route, name: `Cliente ${randomUUID().slice(0, 6)}`, documentType: 'CPF', document: cpf(),
    phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b' });
  const saleBody = (clientId: string): Body => ({ routeId: r1, clientId, amountMinor: 50_000, interestRate: 20, installmentsCount: 12,
    frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
  const newClient = async () => {
    const r = await ana('POST', '/v1/clients', clientBody());
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body['id'] as string;
  };
  const credit = async () => {
    const r = await $ana('/v1/credits/direct', saleBody(await newClient()));
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return (r.body['credit'] as Body)['id'] as string;
  };
  const fingerprint = async () => Object.fromEntries(await Promise.all(
    ['clients', 'sale_requests', 'sales', 'installments', 'payments', 'no_payment_visits', 'payment_adjustment_requests', 'capital_operations']
      .map(async (t) => [t, await count(db.admin, `select 1 from adex.${t} where company_id = $1`, [c1])] as const)));

  before(async () => {
    db = await createTestDb('superadmin_readonly', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    gabi = caller(api, issuer, 'gabi', M.gabiSec);
    carla = caller(api, issuer, 'carla', M.carlaSa);
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    carlos = await newPerson(api, issuer, provider.ids, bruno, { email: 'carlos-sa-ro@example.test', role: 'cobrador', displayName: 'Carlos', routeIds: [r1] });
    // Capital del SuperAdmin (criterio 12: sus funciones de capital siguen funcionando).
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 3_000_000, reason: 'Bolsa de Ana' }],
    ] as const) {
      const r = await $bruno(path, body);
      assert.equal(r.status, 201, `${path}: ${JSON.stringify(r.body)}`);
    }
  });
  after(async () => { await api.close(); await db.close(); });

  test('SA-RO-001 · consulta: lista, ficha, créditos, pagos y visitas; el contexto no anuncia escrituras de cartera', async () => {
    const sale = await credit();
    assert.equal((await carlos.money('/v1/collections', { saleId: sale, amountMinor: 5_000 })).status, 201);
    const list = await bruno('GET', '/v1/clients');
    assert.equal(list.status, 200);
    const clients = list.body['clients'] as { id: string; routeId: string }[];
    assert.ok(new Set(clients.map((c) => c.routeId)).size > 1, 've los clientes de todas las rutas de SU empresa');
    assert.equal((await bruno('GET', `/v1/clients/${uid('c1:client:1')}`)).status, 200);
    assert.equal((await bruno('GET', `/v1/clients?routeId=${r1}`)).status, 200, 'filtro por ruta');
    for (const path of ['/v1/credits', `/v1/credits/${sale}`, '/v1/collections', '/v1/no-payment-visits', `/v1/installments?routeId=${r1}`]) {
      assert.equal((await bruno('GET', path)).status, 200, path);
    }
    const caps = (await bruno('GET', '/v1/context')).body['capabilities'] as string[];
    assert.ok(caps.includes('client.view') && caps.includes('sale.viewHistory') && caps.includes('payment.viewHistory'));
    assert.deepEqual(CARTERA_WRITE_CAPS.filter((c) => caps.includes(c)), [], 'ninguna escritura de cartera');
    assert.ok(caps.includes('capital.allocateAdmins') && caps.includes('expense.correct') && caps.includes('route.assign'), 'conserva capital, gastos y estructura');
  });

  test('SA-RO-002 · ninguna escritura de cartera por endpoints directos (403) y nada cambia', async () => {
    const client = await newClient();
    const sale = await credit();
    const pay = await carlos.money('/v1/collections', { saleId: sale, amountMinor: 5_000 });
    assert.equal(pay.status, 201);
    const pending = await carlos.call('POST', '/v1/credit-requests', { ...saleBody(client), amountMinor: 20_000 });
    assert.equal(pending.status, 201, JSON.stringify(pending.body));
    const req = pending.body['id'] as string;
    const before = await fingerprint();
    const op = () => ({ 'x-adex-operation-id': randomUUID() });
    const attempts: [string, string, Body, Record<string, string>?][] = [
      ['POST', '/v1/clients', clientBody()],
      ['PATCH', `/v1/clients/${client}`, { name: 'Editado por SA' }],
      ['PATCH', `/v1/clients/${client}`, { routeId: routeId('c1', 2) }],
      ['POST', `/v1/clients/${client}/status`, { status: 'inactivo' }],
      ['POST', `/v1/clients/${client}/delete`, {}],
      ['POST', '/v1/credits/direct', saleBody(client), op()],
      ['POST', '/v1/credit-requests', saleBody(client)],
      ['POST', `/v1/credit-requests/${req}/approve`, {}],
      ['POST', `/v1/credit-requests/${req}/reject`, { reason: 'No' }],
      ['POST', `/v1/credit-requests/${req}/cancel`, { reason: 'No' }],
      ['POST', `/v1/credit-requests/${req}/disburse`, {}, op()],
      ['POST', '/v1/collections', { saleId: sale, amountMinor: 1_000 }, op()],
      ['POST', `/v1/collections/${pay.body['paymentId']}/reverse`, { reason: 'Prueba SA' }, op()],
      ['POST', '/v1/no-payment-visits', { saleId: sale, reason: 'no_estaba' }, op()],
      ['POST', '/v1/payment-adjustments', { paymentId: pay.body['paymentId'], kind: 'annul', reason: 'Prueba SA' }, op()],
    ];
    for (const [method, path, body, headers] of attempts) {
      const r = await bruno(method, path, body, headers);
      // 403 = sin la capacidad; 404 = ni siquiera ve el registro (solicitudes: ya no tiene `authorization.access`).
      // Una solicitud de ajuste mal formada (400) tampoco escribe nada; lo comprueba la huella de abajo.
      assert.ok([403, 404].includes(r.status) || (r.status === 400 && path === '/v1/payment-adjustments'), `${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
      if (path.startsWith('/v1/clients') || path === '/v1/credits/direct' || path === '/v1/collections' || path === '/v1/no-payment-visits') {
        assert.equal(r.status, 403, `${method} ${path}: ${JSON.stringify(r.body)}`);
      }
    }
    assert.deepEqual(await fingerprint(), before, 'ningún registro de cartera cambió');
    assert.equal((await db.admin.query('select name, status, route_id from adex.clients where id = $1', [client])).rows[0].route_id, r1);
  });

  test('SA-RO-003 · PostgreSQL rechaza al SuperAdmin aunque se salte la API (0028)', async () => {
    const client = await newClient();
    await asApi(db.api, brunoCtx, async (q) => {
      for (const cap of CARTERA_WRITE_CAPS.filter((c) => !c.startsWith('client.') && c !== 'sale.editBeforeDisbursement' && c !== 'sale.adjustAfterDisbursement')) {
        assert.equal((await q.query('select adex.ctx_can($1) ok', [cap])).rows[0].ok, false, cap);
      }
      for (const cap of ['payment.viewHistory', 'expense.correct', 'cashCustody.manage', 'settlement.close']) {
        assert.equal((await q.query('select adex.ctx_can($1) ok', [cap])).rows[0].ok, true, `${cap} se conserva`);
      }
      await q.query('savepoint s');
      await assert.rejects(q.query(
        `insert into adex.clients (id, company_id, route_id, name, document, document_type, phone_primary, address_primary, address_secondary, status, created_at, updated_at)
         values ($1, $2, $3, 'SA directo', '52998224725', 'CPF', '1', 'a', 'b', 'activo', now(), now())`, [randomUUID(), c1, r1]), { code: '42501' });
      await q.query('rollback to savepoint s');
      assert.equal((await q.query(`update adex.clients set name = 'SA directo' where id = $1`, [client])).rowCount, 0, 'la política no le deja editar');
      await q.query('savepoint s');
      const del = await q.query('delete from adex.clients where id = $1', [client]).then((r) => r.rowCount, (e: { code?: string }) => e.code);
      assert.ok(del === 0 || del === '2BP01' || del === '42501', `borrado: ${del}`);
      await q.query('rollback to savepoint s');
      assert.equal((await q.query('select count(*)::int n from adex.clients where id = $1', [client])).rows[0].n, 1, 'pero sí puede LEERLO');
    });
    assert.equal((await db.admin.query('select name from adex.clients where id = $1', [client])).rows[0].name.startsWith('Cliente'), true);
  });

  test('SA-RO-004 · DS-05: la misma persona como Administrador de otra empresa no suma permisos al contexto SuperAdmin', async () => {
    // La misma identidad (bruno) recibe una membresía de Administrador en c2 con la ruta 1 de c2.
    const otherId = randomUUID();
    await db.admin.query(`insert into adex.memberships (id, company_id, identity_id, role, status, display_name, created_at, updated_at)
                          values ($1, $2, $3, 'admin', 'activo', 'Bruno Admin C2', now(), now())`, [otherId, c2, identityOf('bruno')]);
    await db.admin.query('insert into adex.membership_routes (company_id, membership_id, route_id) values ($1, $2, $3)', [c2, otherId, routeId('c2', 1)]);
    const other = { call: caller(api, issuer, 'bruno', otherId) };
    assert.equal((await other.call('POST', '/v1/clients', { ...clientBody(routeId('c2', 1)), documentType: 'CC', document: String(randomInt(1_000_000_000, 1_999_999_999)) })).status, 201,
      'como Administrador en c2 sí gestiona su cartera');
    assert.equal((await bruno('POST', '/v1/clients', clientBody())).status, 403, 'en el contexto SuperAdmin de c1, nada');
    assert.ok([403, 404].includes((await other.call('POST', '/v1/clients', clientBody())).status), 'la membresía de c2 no alcanza c1');
    assert.equal((await other.call('GET', `/v1/clients/${uid('c1:client:1')}`)).status, 404);
  });

  test('SA-RO-005 · el Administrador y los demás roles conservan sus escrituras de cartera', async () => {
    const client = await newClient();
    assert.equal((await ana('PATCH', `/v1/clients/${client}`, { notes: 'Editado por la Administradora' })).status, 200);
    assert.equal((await ana('POST', `/v1/clients/${client}/status`, { status: 'inactivo' })).status, 200);
    assert.equal((await ana('POST', `/v1/clients/${client}/status`, { status: 'activo' })).status, 200);
    const sale = await credit();
    assert.equal((await carlos.money('/v1/collections', { saleId: sale, amountMinor: 3_000 })).status, 201, 'el Cobrador cobra');
    const req = await carlos.call('POST', '/v1/credit-requests', { ...saleBody(await newClient()), amountMinor: 10_000 });
    assert.equal(req.status, 201);
    assert.equal((await gabi('POST', `/v1/credit-requests/${req.body['id']}/approve`, {})).status, 200, 'la Secretaria autoriza');
    const other = await carlos.call('POST', '/v1/credit-requests', { ...saleBody(await newClient()), amountMinor: 10_000 });
    assert.equal((await ana('POST', `/v1/credit-requests/${other.body['id']}/reject`, { reason: 'Sin garantía' })).status, 200, 'la Administradora autoriza o rechaza');
    const gone = await ana('POST', '/v1/clients', clientBody());
    assert.equal((await ana('POST', `/v1/clients/${gone.body['id']}/delete`, {})).status, 200, 'y borra un cliente sin historia');
  });

  test('SA-RO-006 · el SuperAdmin conserva capital y gastos (fuera de CARTERA)', async () => {
    assert.equal((await $bruno('/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 10_000, reason: 'Más bolsa' })).status, 201);
    const cat = (await db.admin.query('select id from adex.expense_categories where company_id = $1 and active limit 1', [c1])).rows[0].id;
    const exp = await $bruno('/v1/expenses', { scope: 'empresa', categoryId: cat, amountMinor: 1_000, description: 'Papelería', fundingSource: 'empresa' });
    assert.equal(exp.status, 201, JSON.stringify(exp.body));
    const ruta = await $ana('/v1/expenses', { scope: 'ruta', routeId: r1, categoryId: cat, amountMinor: 500, description: 'Gasto de ruta' });
    assert.equal(ruta.status, 201, JSON.stringify(ruta.body));
    const rev = await $bruno(`/v1/expenses/${(ruta.body['expense'] as Body)['id']}/reverse`, { reason: 'Anulación de prueba' });
    assert.equal(rev.status, 201, `el SuperAdmin sigue anulando gastos: ${JSON.stringify(rev.body)}`);
    assert.equal((await bruno('GET', '/v1/capital/summary')).status, 200);
  });

  test('SA-RO-007 · aislamiento: el SuperAdmin de otra empresa no ve ni toca la cartera de c1', async () => {
    const c1Client = uid('c1:client:1');
    assert.equal((await carla('GET', `/v1/clients/${c1Client}`)).status, 404);
    const theirs = (await carla('GET', '/v1/clients')).body['clients'] as { id: string }[];
    const c1Ids = new Set((await db.admin.query('select id from adex.clients where company_id = $1', [c1])).rows.map((r) => r.id as string));
    assert.ok(theirs.length > 0 && theirs.every((c) => !c1Ids.has(c.id)), 'solo clientes de c2');
    assert.equal(theirs.length, await count(db.admin, 'select 1 from adex.clients where company_id = $1', [c2]));
  });

  test('SA-RO-099 · sin errores inesperados en el servidor', () => {
    assert.deepEqual(api.errors, []);
  });
});
