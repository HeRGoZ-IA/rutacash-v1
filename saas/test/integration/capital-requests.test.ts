// RONDA 59 · entregas voluntarias, solicitudes de capital y notificaciones contra PostgreSQL real
// y la API HTTP. Regla: quien tiene el dinero lo entrega sin aprobación; quien lo necesita, lo
// solicita. Cada paso se verifica con SQL propio: bolsas, custodias, enlaces, conservación.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, routeId } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;
const R = (r: { body: Body }) => r.body['request'] as Body;

describe('Ronda 59 · entregas voluntarias y solicitudes de capital', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  const r2 = routeId('c1', 2);
  let bruno: Caller, ana: Caller, gabi: Caller, carla: Caller, anaCob: Caller;
  let $bruno: Money, $ana: Money, $gabi: Money, $hugo: Money, $anaCob: Money;
  let xavier: Person, rita: Person;

  const pool = (m: string) => balance(db.admin, c1, 'admin', m);
  const company = () => balance(db.admin, c1, 'company', null);
  const custody = (m: string, r = r1) => balance(db.admin, c1, 'custody', m, r);
  const requestOf = async (id: unknown) => (await db.admin.query('select * from adex.capital_requests where id = $1', [id])).rows[0];
  const countOf = async (c: Caller) => (await c('GET', '/v1/notifications/count')).body['actionRequired'];
  const inbox = async (c: Caller) => (await c('GET', '/v1/notifications')).body as { actionRequired: Body[]; waiting: Body[]; info: Body[]; count: number };
  const ask = (m: Money, body: Body, op?: string) => m('/v1/capital/requests', body, op);

  before(async () => {
    db = await createTestDb('capitalrequests', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    anaCob = caller(api, issuer, 'ana', M.anaCob); $anaCob = money(anaCob);
    gabi = caller(api, issuer, 'gabi', M.gabiSec); $gabi = money(gabi);
    carla = caller(api, issuer, 'carla', M.carlaSa);
    $hugo = money(caller(api, issuer, 'hugo', M.hugoAdmin));
    xavier = await newPerson(api, issuer, provider.ids, bruno, { email: 'xavier-r59@example.test', role: 'admin', displayName: 'Xavier Admin', routeIds: [r1] });
    rita = await newPerson(api, issuer, provider.ids, bruno, { email: 'rita-r59@example.test', role: 'cobrador', displayName: 'Rita Cobradora', routeIds: [r1] });
    for (const [m, path, body] of [
      [$bruno, '/v1/capital/company/deposits', { amountMinor: 2_000_000, reason: 'Capital inicial sintético' }],
      [$bruno, '/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 1_000_000, reason: 'Bolsa de Ana' }],
      [$bruno, '/v1/capital/allocations', { adminId: xavier.membershipId, amountMinor: 200_000, reason: 'Bolsa de Xavier' }],
      [$ana, '/v1/capital/deliveries', { routeId: r1, workerId: rita.membershipId, amountMinor: 100_000, reason: 'Base de Rita' }],
    ] as const) {
      const r = await m(path, body);
      if (r.status !== 201) throw new Error(`${path}: ${JSON.stringify(r.body)}`);
    }
  });
  after(async () => { await api.close(); await db.close(); });

  test('RQ-001 · el Administrador devuelve capital de SU bolsa al SuperAdmin sin aprobación; idempotente; nunca de una bolsa ajena', async () => {
    assert.equal(await pool(M.anaAdmin), 900_000);
    const c0 = await company();
    const op = randomUUID();
    const r = await $ana('/v1/capital/admin-returns', { amountMinor: 150_000, reason: 'Devuelvo lo que no uso' }, op);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([(r.body['operation'] as Body)['kind'], (r.body['operation'] as Body)['actorRole'], (r.body['operation'] as Body)['adminId']],
      ['ADMIN_RETURN', 'admin', M.anaAdmin]);
    assert.equal(await pool(M.anaAdmin), 750_000);
    assert.equal(await company(), c0 + 150_000, 'la contrapartida es la empresa');
    assert.equal((await $ana('/v1/capital/admin-returns', { amountMinor: 150_000, reason: 'Devuelvo lo que no uso' }, op)).status, 201);
    assert.equal(await pool(M.anaAdmin), 750_000, 'el reintento no devuelve dos veces');
    // Sin bolsa ajena, sin sobregiro, sin otros roles.
    assert.equal((await $ana('/v1/capital/admin-returns', { adminId: xavier.membershipId, amountMinor: 1, reason: 'Bolsa de otro' })).status, 403);
    assert.equal((await $ana('/v1/capital/admin-returns', { amountMinor: 750_001, reason: 'Más que la bolsa' })).body['error'], 'INSUFFICIENT_FUNDS');
    assert.equal((await money(rita.call)('/v1/capital/admin-returns', { amountMinor: 1, reason: 'Cobradora' })).status, 403);
    assert.equal((await $gabi('/v1/capital/admin-returns', { adminId: M.anaAdmin, amountMinor: 1, reason: 'Secretaria' })).status, 403);
    // El SuperAdmin queda avisado (informativo, no cuenta como pendiente).
    const box = await inbox(bruno);
    assert.ok(box.info.some((i) => i['type'] === 'capital-returned' && (i['operation'] as Body)['amountMinor'] === 150_000));
    assert.equal(await countOf(bruno), 0);
    assert.equal(await count(db.admin, `select 1 from adex.audit_log where company_id = $1 and action = 'ADMIN_CAPITAL_RETURNED' and actor_membership_id = $2`, [c1, M.anaAdmin]), 1);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('RQ-002 · el Cobrador entrega SU efectivo al responsable sin aprobación; recaudo y base se distinguen; el responsable puede anularla', async () => {
    const $rita = rita.money;
    const r = await $rita('/v1/capital/own-returns', { routeId: r1, amountMinor: 30_000, concept: 'recaudo', note: 'cierre del martes' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = r.body['operation'] as Body;
    assert.deepEqual([o['kind'], o['actorRole'], o['workerId'], o['adminId'], o['reason']],
      ['WORKER_RETURN', 'cobrador', rita.membershipId, M.anaAdmin, 'Entrega de recaudo: cierre del martes']);
    assert.equal(await custody(rita.membershipId), 70_000);
    assert.equal(await pool(M.anaAdmin), 780_000);
    const base = await $rita('/v1/capital/own-returns', { routeId: r1, amountMinor: 10_000, concept: 'base' });
    assert.equal((base.body['operation'] as Body)['reason'], 'Devolución de base');
    // Solo su efectivo, solo sus rutas, nunca más de lo que tiene; nunca a su propia bolsa (misma persona).
    assert.equal((await $rita('/v1/capital/own-returns', { routeId: r2, amountMinor: 1, concept: 'recaudo' })).status, 404);
    assert.equal((await $rita('/v1/capital/own-returns', { routeId: r1, amountMinor: 60_001, concept: 'recaudo' })).status, 409);
    assert.equal((await $rita('/v1/capital/own-returns', { routeId: r1, amountMinor: 1, concept: 'otro' })).body['error'], 'INVALID_INPUT');
    // Misma persona en ambos lados (Ana Cobradora entrega a la bolsa de Ana Administradora): prohibido.
    // (Un Cobrador por ruta: Rita ocupa r1, así que Ana Cobradora pasa a r2, también de Ana.)
    assert.equal((await bruno('PUT', `/v1/members/${M.anaCob}/routes`, { routeIds: [r2] })).status, 200);
    assert.equal((await $anaCob('/v1/capital/own-returns', { routeId: r2, amountMinor: 1, concept: 'recaudo' })).body['error'], 'SELF_REDUCTION_FORBIDDEN');
    assert.equal((await $ana('/v1/capital/own-returns', { routeId: r1, amountMinor: 1, concept: 'recaudo' })).status, 403, 'solo el Cobrador');
    // Antes de R59 el Cobrador no podía reducir su custodia: sigue sin poder hacerlo por la vía del Administrador.
    assert.equal((await $rita('/v1/capital/returns', { routeId: r1, workerId: rita.membershipId, amountMinor: 1, reason: 'Vía ajena' })).status, 403);
    // El responsable queda avisado y, si no la recibió, la anula (el efectivo vuelve a la custodia).
    const box = await inbox(ana);
    assert.equal(box.info.filter((i) => i['type'] === 'cash-delivered').length, 2);
    const rev = await $ana(`/v1/capital/operations/${o['id'] as string}/reverse`, { reason: 'No recibí ese efectivo' });
    assert.equal(rev.status, 201, JSON.stringify(rev.body));
    assert.equal(await custody(rita.membershipId), 90_000);
    assert.equal(await pool(M.anaAdmin), 760_000);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('RQ-003 · pedir capital al SuperAdmin no mueve dinero; se atiende una sola vez con la asignación ordinaria', async () => {
    const before = [await pool(M.anaAdmin), await company()];
    assert.equal((await money(rita.call)('/v1/capital/requests', { kind: 'admin_allocation', amountMinor: 1 })).status, 403);
    const q = await ask($ana, { kind: 'admin_allocation', amountMinor: 50_000, note: 'Para desembolsos del viernes' });
    assert.equal(q.status, 201, JSON.stringify(q.body));
    const req = R(q);
    assert.deepEqual([req['state'], req['mySide'], req['canAttend'], req['canCancel'], (req['holder'] as Body)['role']], ['pending', 'requester', false, true, 'superadmin']);
    assert.deepEqual([await pool(M.anaAdmin), await company()], before, 'solicitar no mueve dinero');
    assert.equal(await countOf(bruno), 1);
    assert.equal(await countOf(ana), 0, 'lo que uno pidió no le cuenta como pendiente');
    assert.ok((await inbox(ana)).waiting.some((w) => (w['request'] as Body)['id'] === req['id']));
    const forBruno = (await inbox(bruno)).actionRequired.find((a) => (a['request'] as Body)?.['id'] === req['id'])!;
    assert.deepEqual([(forBruno['request'] as Body)['canAttend'], (forBruno['request'] as Body)['canReject']], [true, true]);
    // Atender con otro Administrador como destino: no es lo pedido → nada se escribe.
    const x0 = await pool(xavier.membershipId);
    const wrong = await $bruno('/v1/capital/allocations', { adminId: xavier.membershipId, amountMinor: 50_000, reason: 'Equivocado', requestId: req['id'] });
    assert.deepEqual([wrong.status, wrong.body['error']], [409, 'REQUEST_MISMATCH']);
    assert.equal(await pool(xavier.membershipId), x0, 'la transacción entera se deshizo');
    // Atender: el MISMO comando de asignación, con el id de la solicitud.
    const op = randomUUID();
    const body = { adminId: M.anaAdmin, amountMinor: 50_000, reason: 'Atiendo la solicitud de Ana', requestId: req['id'] };
    const done = await $bruno('/v1/capital/allocations', body, op);
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(R(done)['state'], 'fulfilled');
    assert.equal(await pool(M.anaAdmin), before[0]! + 50_000);
    const row = await requestOf(req['id']);
    assert.deepEqual([row.state, row.fulfilled_operation_id], ['fulfilled', (done.body['operation'] as Body)['id']]);
    assert.equal((await $bruno('/v1/capital/allocations', body, op)).status, 201, 'reintento idempotente');
    const twice = await $bruno('/v1/capital/allocations', body);
    assert.deepEqual([twice.status, twice.body['error']], [409, 'REQUEST_NOT_PENDING'], 'una solicitud se atiende una vez');
    assert.equal(await pool(M.anaAdmin), before[0]! + 50_000, 'ni el reintento ni el segundo intento asignan de nuevo');
    assert.equal(await countOf(bruno), 0);
    const info = (await inbox(ana)).info;
    assert.ok(info.some((i) => i['type'] === 'request-resolved' && (i['request'] as Body)['state'] === 'fulfilled'));
    assert.ok(!info.some((i) => i['type'] === 'capital-received' && (i['operation'] as Body)['id'] === row.fulfilled_operation_id), 'un solo aviso por la misma entrega');
  });

  test('RQ-004 · el SuperAdmin pide una devolución; la atiende el Administrador con su devolución ordinaria; concurrencia', async () => {
    const q = await ask($bruno, { kind: 'admin_return', holderId: M.anaAdmin, amountMinor: 40_000, note: 'Cierre de mes' });
    assert.equal(q.status, 201, JSON.stringify(q.body));
    assert.equal(await countOf(ana), 1);
    assert.equal((await ask($ana, { kind: 'admin_return', holderId: xavier.membershipId, amountMinor: 1 })).status, 403, 'solo el SuperAdmin la pide');
    // El SuperAdmin no puede «atenderla» recogiendo él mismo: la entrega es de quien tiene el capital.
    const sa = await $bruno('/v1/capital/admin-returns', { adminId: M.anaAdmin, amountMinor: 40_000, reason: 'Me la cobro', requestId: R(q)['id'] });
    assert.equal(sa.body['error'], 'REQUEST_MISMATCH');
    const p0 = await pool(M.anaAdmin);
    const pair = await Promise.all([1, 2].map((i) => $ana('/v1/capital/admin-returns', { amountMinor: 40_000, reason: `Devolución pedida ${i}`, requestId: R(q)['id'] })));
    assert.deepEqual(pair.map((r) => r.status).sort(), [201, 409], 'dos toques a la vez: una sola devolución');
    assert.equal(pair.find((r) => r.status === 409)!.body['error'], 'REQUEST_NOT_PENDING');
    assert.equal(await pool(M.anaAdmin), p0 - 40_000);
    assert.equal(await countOf(ana), 0);
    assert.ok((await inbox(bruno)).info.some((i) => i['type'] === 'request-resolved' && (i['request'] as Body)['id'] === R(q)['id']));
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('RQ-005 · entre Administradores: rechazar con motivo, cancelar la propia, atender con un traspaso directo', async () => {
    const q = await ask(xavier.money, { kind: 'admin_transfer', holderId: M.anaAdmin, amountMinor: 20_000 });
    assert.equal(q.status, 201);
    assert.equal((await money(xavier.call)(`/v1/capital/requests/${R(q)['id'] as string}/reject`, { reason: 'Me la rechazo' })).status, 403, 'quien pide no rechaza');
    assert.equal((await $ana(`/v1/capital/requests/${R(q)['id'] as string}/reject`, { reason: '' })).body['error'], 'INVALID_INPUT');
    const no = await $ana(`/v1/capital/requests/${R(q)['id'] as string}/reject`, { reason: 'Ahora no puedo' });
    assert.deepEqual([no.status, R(no)['state'], R(no)['resolutionReason']], [200, 'rejected', 'Ahora no puedo']);
    assert.ok((await inbox(xavier.call)).info.some((i) => i['type'] === 'request-resolved' && (i['request'] as Body)['state'] === 'rejected'));
    const again = await $ana('/v1/capital/admin-transfers', { destinationAdminId: xavier.membershipId, amountMinor: 20_000, reason: 'Tarde', requestId: R(q)['id'] });
    assert.equal(again.body['error'], 'REQUEST_NOT_PENDING', 'resuelta: ya no se atiende');
    // Cancelar la propia (solo quien la pidió).
    const c = await ask(xavier.money, { kind: 'admin_transfer', holderId: M.anaAdmin, amountMinor: 5_000 });
    assert.equal((await $ana(`/v1/capital/requests/${R(c)['id'] as string}/cancel`, { reason: 'No es mía' })).status, 403);
    assert.equal(R(await xavier.money(`/v1/capital/requests/${R(c)['id'] as string}/cancel`, { reason: 'Ya no la necesito' }))['state'], 'cancelled');
    // Atender: traspaso directo de quien tiene el capital a quien lo pidió.
    const t = await ask(xavier.money, { kind: 'admin_transfer', holderId: M.anaAdmin, amountMinor: 25_000 });
    assert.equal((await xavier.money('/v1/capital/admin-transfers', { destinationAdminId: M.anaAdmin, amountMinor: 1, reason: 'Me la atiendo', requestId: R(t)['id'] })).status, 403);
    const x0 = await pool(xavier.membershipId);
    const done = await $ana('/v1/capital/admin-transfers', { destinationAdminId: xavier.membershipId, amountMinor: 25_000, reason: 'Para tu ruta', requestId: R(t)['id'] });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.deepEqual([(done.body['transfer'] as Body)['state'], R(done)['state']], ['applied', 'fulfilled']);
    assert.equal(await pool(xavier.membershipId), x0 + 25_000);
    assert.equal((await requestOf(R(t)['id'])).fulfilled_transfer_id, (done.body['transfer'] as Body)['id']);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('RQ-006 · el responsable pide efectivo a su Cobrador; lo atiende el Cobrador con su entrega ordinaria', async () => {
    assert.equal((await ask(xavier.money, { kind: 'worker_return', holderId: rita.membershipId, routeId: r1, concept: 'recaudo', amountMinor: 1 })).status, 403,
      'solo el responsable de capital de la ruta');
    assert.equal((await ask($ana, { kind: 'worker_return', holderId: rita.membershipId, routeId: r2, concept: 'recaudo', amountMinor: 1 })).body['error'], 'CUSTODIAN_INVALID',
      'la Cobradora no está en esa ruta');
    assert.equal((await ask($ana, { kind: 'worker_return', holderId: rita.membershipId, routeId: r1, amountMinor: 1 })).body['error'], 'INVALID_INPUT', 'concepto obligatorio');
    const q = await ask($ana, { kind: 'worker_return', holderId: rita.membershipId, routeId: r1, concept: 'recaudo', amountMinor: 15_000, note: 'Trae lo del día' });
    assert.equal(q.status, 201, JSON.stringify(q.body));
    const c0 = await custody(rita.membershipId);
    assert.equal(c0, 90_000, 'solicitar no reduce la custodia');
    assert.equal(await countOf(rita.call), 1);
    const box = await inbox(rita.call);
    assert.ok(box.info.some((i) => i['type'] === 'capital-delivered'), 'la Cobradora ve el capital que recibió');
    const done = await rita.money('/v1/capital/own-returns', { routeId: r1, amountMinor: 15_000, concept: 'recaudo', requestId: R(q)['id'] });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(R(done)['state'], 'fulfilled');
    assert.equal(await custody(rita.membershipId), 75_000);
    assert.equal(await countOf(rita.call), 0);
    const ruta2 = await rita.money('/v1/capital/own-returns', { routeId: r1, amountMinor: 1, concept: 'base', requestId: R(q)['id'] });
    assert.equal(ruta2.body['error'], 'REQUEST_NOT_PENDING');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('RQ-007 · aislamiento, inmutabilidad, Secretario y conciliación', async () => {
    assert.equal(((await carla('GET', '/v1/capital/requests')).body['requests'] as Body[]).length, 0, 'otra empresa no ve nada');
    const q = await ask($ana, { kind: 'admin_allocation', amountMinor: 1_000 });
    assert.equal((await $hugo('/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 1, reason: 'Otra empresa', requestId: R(q)['id'] })).status, 403);
    assert.equal((await $hugo(`/v1/capital/requests/${R(q)['id'] as string}/reject`, { reason: 'Otra empresa' })).body['error'], 'NOT_FOUND');
    assert.equal((await $gabi('/v1/capital/requests', { kind: 'admin_allocation', amountMinor: 1 })).status, 403, 'el Secretario no pide capital');
    // Secretario: registra; cada Administrador ve SU confirmación pendiente en Notificaciones (cuenta).
    const s = await $gabi('/v1/capital/admin-transfers', { originAdminId: M.anaAdmin, destinationAdminId: xavier.membershipId, amountMinor: 1_000, reason: 'Transferencia bancaria' });
    assert.equal(s.status, 201);
    assert.equal(await countOf(ana), 1);
    assert.equal(await countOf(xavier.call), 1);
    assert.equal(await countOf(gabi), 0, 'el Secretario no tiene nada que decidir');
    const item = (await inbox(ana)).actionRequired.find((a) => a['type'] === 'transfer-confirmation')!;
    assert.equal(((item['transfer'] as Body)['registeredBy'] as Body)['name'] !== null, true);
    assert.equal((await $gabi(`/v1/capital/admin-transfers/${(s.body['transfer'] as Body)['id'] as string}/confirm`, {})).status, 403, 'nunca decide por ellos');
    // Resueltas: inmutables y sin borrado.
    await assert.rejects(db.admin.query(`update adex.capital_requests set amount_minor = 1 where company_id = $1 and state = 'fulfilled'`, [c1]), /immutable/);
    await assert.rejects(db.admin.query(`delete from adex.capital_requests where company_id = $1`, [c1]));
    // Una operación no atiende dos solicitudes.
    assert.equal(await count(db.admin, `select 1 from adex.capital_requests where company_id = $1 and fulfilled_operation_id is not null group by fulfilled_operation_id having count(*) > 1`, [c1]), 0);
    const rec = (await bruno('GET', '/v1/capital/reconciliation')).body;
    assert.equal(rec['ok'], true, JSON.stringify(rec));
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });
});
