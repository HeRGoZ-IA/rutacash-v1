// R74 · H (coherente con DS-05): se cierran tres huecos de autoasignación y autoaprobación, en la API
// y en PostgreSQL (0033). No implanta la regla «solo el Administrador acumula perfiles» (requiere
// enmienda de DS-05): una persona puede seguir teniendo varias membresías, pero nunca se las da ni
// se las reactiva a sí misma, nunca resuelve su propia solicitud de ajuste y nunca se entrega capital
// a su propia custodia.
//   H1 · alta y reactivación de una membresía propia → 403 SELF_ASSIGNMENT_FORBIDDEN / 42501.
//   H2 · aprobar o rechazar el ajuste que pidió la misma persona → 403 SELF_APPROVAL_FORBIDDEN / AX505 / 42501.
//   H3 · WORKER_DELIVERY a la custodia de la misma persona → 403 SELF_DELIVERY_FORBIDDEN / AX419.
// Los flujos legítimos con varias membresías (IDN-021, CRED-004, ONL-020) siguen en sus suites.

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf, routeId } from '../../db/seeds/synthetic.ts';
import { asApi, count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { balance, money, newPerson, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('R74 · H · autoasignación, autoaprobación y autoentrega', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  let bruno: Caller, ana: Caller, $bruno: Money, $ana: Money, $anaCob: Money;
  let pedro: Person, dora: Person, solAdmin: Person, solSec: Person;
  let today = '';

  const membershipsOf = (identity: string) => count(db.admin, 'select 1 from adex.memberships where company_id = $1 and identity_id = $2', [c1, identity]);
  const custody = (m: string) => balance(db.admin, c1, 'custody', m, r1);

  before(async () => {
    db = await createTestDb('r74_roles', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    $anaCob = money(caller(api, issuer, 'ana', M.anaCob));
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    // El proveedor de prueba conoce los correos de las personas sembradas (el real los resuelve solo).
    for (const p of ['bruno', 'ana'] as const) provider.ids.set(`${p}@example.test`, identityOf(p));
    pedro = await newPerson(api, issuer, provider.ids, bruno, { email: 'pedro-r74@example.test', role: 'admin', displayName: 'Pedro Admin', routeIds: [r1] });
    dora = await newPerson(api, issuer, provider.ids, bruno, { email: 'dora-r74h@example.test', role: 'supervisor', displayName: 'Dora Supervisora', routeIds: [r1] });
    // Sol: Administradora y Secretaria (dos membresías de la MISMA persona, dadas por el SuperAdmin: legítimo).
    solAdmin = await newPerson(api, issuer, provider.ids, bruno, { email: 'sol-r74@example.test', role: 'admin', displayName: 'Sol Admin', routeIds: [r1] });
    solSec = await newPerson(api, issuer, provider.ids, bruno, { email: 'sol-r74@example.test', role: 'secretario', displayName: 'Sol Secretaria', routeIds: [r1] });
    assert.equal(solSec.identityId, solAdmin.identityId);
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético R74' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 2_000_000, reason: 'Bolsa de Ana' }],
    ] as const) assert.equal((await $bruno(path, body)).status, 201, path);
  });
  after(async () => { await api.close(); await db.close(); });

  test('R74-H1-001 · nadie se da de alta otra membresía a sí mismo (API); otra persona con autoridad sí', async () => {
    const n0 = await membershipsOf(pedro.identityId);
    const own = await pedro.call('POST', '/v1/members', { email: 'pedro-r74@example.test', role: 'cobrador', displayName: 'Pedro Cobrador', routeIds: [] });
    assert.deepEqual([own.status, own.body['error']], [403, 'SELF_ASSIGNMENT_FORBIDDEN']);
    const sa = await bruno('POST', '/v1/members', { email: 'bruno@example.test', role: 'admin', displayName: 'Bruno Admin', routeIds: [] });
    assert.deepEqual([sa.status, sa.body['error']], [403, 'SELF_ASSIGNMENT_FORBIDDEN'], 'tampoco el SuperAdmin');
    const byAna = await ana('POST', '/v1/members', { email: 'ana@example.test', role: 'supervisor', displayName: 'Ana Supervisora', routeIds: [] });
    assert.deepEqual([byAna.status, byAna.body['error']], [403, 'SELF_ASSIGNMENT_FORBIDDEN'], 'ni la Administradora con perfiles previos');
    assert.equal(await membershipsOf(pedro.identityId), n0, 'nada se escribió');
    const legit = await bruno('POST', '/v1/members', { email: 'pedro-r74@example.test', role: 'cobrador', displayName: 'Pedro Cobrador', routeIds: [] });
    assert.equal(legit.status, 201, `DS-05: otra persona sí se la da: ${JSON.stringify(legit.body)}`);
    assert.equal(await membershipsOf(pedro.identityId), n0 + 1);
  });

  test('R74-H1-002 · PostgreSQL: la API no inserta una membresía para la identidad del contexto (política restrictiva)', async () => {
    const insert = (q: { query: (s: string, a: unknown[]) => Promise<unknown> }, identity: string, role: string) => q.query(
      `insert into adex.memberships (id, company_id, identity_id, role, status, display_name, created_at, updated_at)
       values ($1, $2, $3, $4, 'activo', 'Directo', now(), now())`, [randomUUID(), c1, identity, role]);
    await asApi(db.api, { identityId: pedro.identityId, membershipId: pedro.membershipId, companyId: c1 }, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(insert(q, pedro.identityId, 'supervisor'), { code: '42501' }, 'la propia identidad');
      await q.query('rollback to savepoint s');
      await q.query('savepoint s');
      await insert(q, identityOf('gabi'), 'cobrador');   // otra persona: la política no lo impide
      await q.query('rollback to savepoint s');
    });
    await asApi(db.api, { identityId: identityOf('bruno'), membershipId: M.brunoSa, companyId: c1 }, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(insert(q, identityOf('bruno'), 'admin'), { code: '42501' }, 'tampoco el SuperAdmin');
      await q.query('rollback to savepoint s');
    });
  });

  test('R74-H1-003 · nadie reactiva una membresía propia (API y PostgreSQL); otra persona sí', async () => {
    const cob = await bruno('POST', '/v1/members', { email: 'pedro-r74@example.test', role: 'supervisor', displayName: 'Pedro Supervisor', routeIds: [r1] });
    assert.equal(cob.status, 201, JSON.stringify(cob.body));
    const mid = cob.body['membershipId'] as string;
    assert.equal((await bruno('POST', `/v1/members/${mid}/deactivate`, {})).status, 200);
    const self = await pedro.call('POST', `/v1/members/${mid}/reactivate`, {});
    assert.deepEqual([self.status, self.body['error']], [403, 'SELF_ASSIGNMENT_FORBIDDEN']);
    await asApi(db.api, { identityId: pedro.identityId, membershipId: pedro.membershipId, companyId: c1 }, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(q.query(`update adex.memberships set status = 'activo', updated_at = now() where id = $1`, [mid]), { code: '42501' });
      await q.query('rollback to savepoint s');
    });
    assert.equal((await db.admin.query('select status from adex.memberships where id = $1', [mid])).rows[0].status, 'inactivo');
    assert.equal((await bruno('POST', `/v1/members/${mid}/reactivate`, {})).status, 200, 'otra persona con autoridad sí');
    // Desactivar la propia (otra) membresía sigue permitido: no amplía nada.
    assert.equal((await pedro.call('POST', `/v1/members/${mid}/deactivate`, {})).status, 200);
  });

  test('R74-H2-001 · nadie aprueba ni rechaza la solicitud de ajuste que pidió (tampoco con otra membresía)', async () => {
    const cl = await ana('POST', '/v1/clients', { routeId: r1, name: 'Cliente R74 H2', documentType: 'CPF', document: String(10_000_000_000 + (Number.parseInt(randomBytes(4).toString('hex'), 16) % 89_999_999_999)),
      phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' });
    assert.equal(cl.status, 201, JSON.stringify(cl.body));
    const cr = await $ana('/v1/credits/direct', { routeId: r1, clientId: cl.body['id'], amountMinor: 50_000, interestRate: 20, installmentsCount: 10,
      frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
    assert.equal(cr.status, 201, JSON.stringify(cr.body));
    const pay = await $anaCob('/v1/collections', { saleId: (cr.body['credit'] as Body)['id'], amountMinor: 6_000 });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    const req = await solSec.money('/v1/payment-adjustments', { paymentId: pay.body['paymentId'], newAmountMinor: 5_000, reason: 'Valor mal digitado' });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    const id = req.body['id'] as string;
    const ap = await solAdmin.money(`/v1/payment-adjustments/${id}/approve`, {});
    assert.deepEqual([ap.status, ap.body['error']], [403, 'SELF_APPROVAL_FORBIDDEN'], 'Sol Administradora no aprueba lo que pidió Sol Secretaria');
    const rj = await solAdmin.call('POST', `/v1/payment-adjustments/${id}/reject`, { reason: 'Me lo rechazo yo' });
    assert.deepEqual([rj.status, rj.body['error']], [403, 'SELF_APPROVAL_FORBIDDEN'], 'ni la rechaza');
    // Segunda barrera: PostgreSQL con el contexto de Sol Administradora.
    await asApi(db.api, { identityId: solAdmin.identityId, membershipId: solAdmin.membershipId, companyId: c1 }, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(q.query(`select adex.collection_correct(gen_random_uuid(), $1, 5000, 'Valor mal digitado', null, $2)`, [pay.body['paymentId'], id]), { code: 'AX505' });
      await q.query('rollback to savepoint s');
      await q.query('savepoint s');
      await assert.rejects(q.query(`update adex.payment_adjustment_requests set status = 'rejected', reviewed_by_membership_id = $2, reviewed_at = now(), rejection_reason = 'Directo'
                                    where id = $1`, [id, solAdmin.membershipId]), { code: '42501' });
      await q.query('rollback to savepoint s');
    });
    assert.equal((await db.admin.query('select status from adex.payment_adjustment_requests where id = $1', [id])).rows[0].status, 'pending');
    // Aprueba Pedro (otro Administrador de la ruta). No Ana: corregir el pago reduce la custodia de Ana
    // cobradora, que cobró, y nadie reduce la suya (DS-05, regla previa).
    const ok = await pedro.money(`/v1/payment-adjustments/${id}/approve`, {});
    assert.ok([200, 201].includes(ok.status), `otra persona autorizada sí: ${JSON.stringify(ok.body)}`);
    assert.equal((await db.admin.query('select status, reviewed_by_membership_id r from adex.payment_adjustment_requests where id = $1', [id])).rows[0].r, pedro.membershipId);
  });

  test('R74-H3-001 · la responsable no se entrega capital a su propia custodia (otra membresía de la misma persona)', async () => {
    const before = [await balance(db.admin, c1, 'admin', M.anaAdmin), await custody(M.anaCob)];
    const self = await $ana('/v1/capital/deliveries', { routeId: r1, workerId: M.anaCob, amountMinor: 10_000, reason: 'Base para mí' });
    assert.deepEqual([self.status, self.body['error']], [403, 'SELF_DELIVERY_FORBIDDEN']);
    await asApi(db.api, { identityId: identityOf('ana'), membershipId: M.anaAdmin, companyId: c1 }, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(q.query(`select adex.capital_post(p_operation_id => gen_random_uuid(), p_kind => 'WORKER_DELIVERY', p_amount => 10000,
                                    p_reason => 'Base para mí', p_route => $1, p_worker => $2)`, [r1, M.anaCob]), { code: 'AX419' });
      await q.query('rollback to savepoint s');
    });
    assert.deepEqual([await balance(db.admin, c1, 'admin', M.anaAdmin), await custody(M.anaCob)], before, 'nada se movió');
    const other = await $ana('/v1/capital/deliveries', { routeId: r1, workerId: dora.membershipId, amountMinor: 10_000, reason: 'Base de Dora' });
    assert.equal(other.status, 201, `a otra persona sí: ${JSON.stringify(other.body)}`);
  });
});
