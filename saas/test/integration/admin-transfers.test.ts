// RONDA 53 · traspasos entre Administradores (D2) contra PostgreSQL real y la API HTTP.
// Directo (lo registra el origen y confirma el destino) y por Secretario (confirman ambos).
// Cada paso se verifica con SQL propio: bolsas, tránsito, patas, conservación.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf, routeId } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;
const T = (r: { body: Body }) => r.body['transfer'] as Body;

describe('Ronda 53 · traspasos entre Administradores', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  let bruno: Caller, ana: Caller, gabi: Caller, fabio: Caller, carla: Caller, hugo: Caller;
  let $bruno: Money, $ana: Money, $gabi: Money, $fabio: Money, $hugo: Money;
  let xavier: Person;

  const pool = (m: string) => balance(db.admin, c1, 'admin', m);
  const transit = () => balance(db.admin, c1, 'transit', null);
  const register = (m: Money, body: Body, op?: string) => m('/v1/capital/admin-transfers', body, op);
  const decide = (m: Money, id: unknown, what: 'confirm' | 'reject' | 'cancel', body: Body = {}, op?: string) =>
    m(`/v1/capital/admin-transfers/${id as string}/${what}`, body, op);

  before(async () => {
    db = await createTestDb('admintransfers', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    gabi = caller(api, issuer, 'gabi', M.gabiSec); $gabi = money(gabi);
    fabio = caller(api, issuer, 'fabio', M.fabioSec); $fabio = money(fabio);
    carla = caller(api, issuer, 'carla', M.carlaSa);
    hugo = caller(api, issuer, 'hugo', M.hugoAdmin); $hugo = money(hugo);
    xavier = await newPerson(api, issuer, provider.ids, bruno, { email: 'xavier-r53@example.test', role: 'admin', displayName: 'Xavier Admin', routeIds: [routeId('c1', 1)] });
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 2_000_000, reason: 'Capital inicial sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 1_000_000, reason: 'Bolsa de Ana' }],
      ['/v1/capital/allocations', { adminId: xavier.membershipId, amountMinor: 200_000, reason: 'Bolsa de Xavier' }],
    ] as const) {
      const r = await $bruno(path, body);
      if (r.status !== 201) throw new Error(`${path}: ${JSON.stringify(r.body)}`);
    }
  });
  after(async () => { await api.close(); await db.close(); });

  test('AT-001 · directo: compromete al registrar, se aplica con la confirmación del destino; idempotente', async () => {
    const op = randomUUID();
    const body = { destinationAdminId: xavier.membershipId, amountMinor: 300_000, reason: 'Refuerzo para Xavier' };
    const r = await register($ana, body, op);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const t = T(r);
    assert.deepEqual([t['mode'], t['state'], (t['origin'] as Body)['decision'], (t['destination'] as Body)['decision'], t['canCancel'], t['canConfirm']],
      ['direct', 'pending', 'confirmed', 'pending', true, false]);
    assert.equal(await pool(M.anaAdmin), 700_000, 'el capital comprometido sale del disponible');
    assert.equal(await transit(), 300_000);
    assert.equal(await pool(xavier.membershipId), 200_000, 'el destino aún no lo tiene');
    const own = ((await ana('GET', '/v1/capital/summary')).body['admins'] as Body[])[0]!;
    assert.deepEqual([own['availableMinor'], own['pendingTransfersOutMinor']], [700_000, 300_000]);
    // Reintento con el mismo id: el mismo traspaso, nada se repite. Con otro cuerpo: rechazado.
    const again = await register($ana, body, op);
    assert.deepEqual([again.status, T(again)['id']], [201, t['id']]);
    assert.equal(await pool(M.anaAdmin), 700_000);
    assert.equal((await register($ana, { ...body, amountMinor: 1 }, op)).body['error'], 'OPERATION_ID_REUSED');
    // El origen ya confirmó; el Secretario no ve los directos ni decide; otro Administrador tampoco.
    assert.equal((await decide($ana, t['id'], 'confirm')).body['error'], 'DECISION_ALREADY_REGISTERED');
    assert.equal(((await gabi('GET', '/v1/capital/admin-transfers')).body['transfers'] as Body[]).length, 0);
    assert.equal((await decide($gabi, t['id'], 'confirm')).status, 403);
    const view = await xavier.call('GET', '/v1/capital/admin-transfers');
    const mine = (view.body['transfers'] as Body[]).find((x) => x['id'] === t['id'])!;
    assert.deepEqual([mine['mySide'], mine['canConfirm'], mine['canReject'], mine['canCancel']], ['destination', true, true, false]);
    // Confirmación del destino: se aplica. Reintento idempotente; otra decisión, rechazada.
    const cop = randomUUID();
    const ok = await decide(xavier.money, t['id'], 'confirm', {}, cop);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(T(ok)['state'], 'applied');
    assert.equal(await pool(xavier.membershipId), 500_000);
    assert.equal(await transit(), 0);
    assert.equal(T(await decide(xavier.money, t['id'], 'confirm', {}, cop))['state'], 'applied');
    assert.equal(await pool(xavier.membershipId), 500_000, 'el reintento no aplica dos veces');
    assert.equal((await decide(xavier.money, t['id'], 'reject', { reason: 'Tarde' })).body['error'], 'TRANSFER_NOT_PENDING');
    assert.equal(await count(db.admin, `select 1 from adex.capital_operations where company_id = $1 and kind like 'ADMIN_TRANSFER_%'`, [c1]), 2);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('AT-002 · sin saldos ficticios: no se compromete más que el disponible ni dos veces lo mismo; cancelación', async () => {
    const big = await register($ana, { destinationAdminId: xavier.membershipId, amountMinor: 700_001, reason: 'Más que la bolsa' });
    assert.deepEqual([big.status, big.body], [409, { error: 'INSUFFICIENT_FUNDS' }]);
    const first = await register($ana, { destinationAdminId: xavier.membershipId, amountMinor: 400_000, reason: 'Primer compromiso' });
    assert.equal(first.status, 201);
    const second = await register($ana, { destinationAdminId: xavier.membershipId, amountMinor: 400_000, reason: 'Segundo con el mismo dinero' });
    assert.deepEqual([second.status, second.body['error']], [409, 'INSUFFICIENT_FUNDS'], 'lo comprometido no se usa dos veces');
    const deliver = await $ana('/v1/capital/deliveries', { routeId: routeId('c1', 1), workerId: M.anaCob, amountMinor: 300_001, reason: 'Gastar lo comprometido' });
    assert.equal(deliver.body['error'], 'INSUFFICIENT_FUNDS', 'ni para entregar a un trabajador');
    assert.equal((await decide($ana, T(first)['id'], 'cancel', {})).body['error'], 'INVALID_INPUT', 'motivo obligatorio');
    assert.equal((await decide(xavier.money, T(first)['id'], 'cancel', { reason: 'No es mío' })).status, 403, 'solo quien registró cancela');
    const c = await decide($ana, T(first)['id'], 'cancel', { reason: 'Me equivoqué de importe' });
    assert.deepEqual([c.status, T(c)['state'], T(c)['closeReason']], [200, 'cancelled', 'Me equivoqué de importe']);
    assert.equal(await pool(M.anaAdmin), 700_000);
    assert.equal(await transit(), 0);
    assert.equal((await decide(xavier.money, T(first)['id'], 'confirm')).body['error'], 'TRANSFER_NOT_PENDING');
    assert.equal(await pool(xavier.membershipId), 500_000);
  });

  test('AT-003 · rechazo del destino: motivo obligatorio y el capital vuelve al origen', async () => {
    const r = await register($ana, { destinationAdminId: xavier.membershipId, amountMinor: 100_000, reason: 'Para rechazar' });
    assert.equal((await decide(xavier.money, T(r)['id'], 'reject', {})).body['error'], 'INVALID_INPUT');
    const no = await decide(xavier.money, T(r)['id'], 'reject', { reason: 'No recibí la transferencia' });
    assert.deepEqual([no.status, T(no)['state'], (T(no)['destination'] as Body)['decision'], (T(no)['destination'] as Body)['reason']],
      [200, 'rejected', 'rejected', 'No recibí la transferencia']);
    assert.equal(await pool(M.anaAdmin), 700_000);
    assert.equal(await pool(xavier.membershipId), 500_000);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('AT-004 · Secretario: registra por cuenta de ambos; cada Administrador confirma por su lado', async () => {
    const r = await register($gabi, { originAdminId: xavier.membershipId, destinationAdminId: M.anaAdmin, amountMinor: 50_000, reason: 'Transferencia bancaria hecha por Secretaría' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const t = T(r);
    assert.deepEqual([t['mode'], (t['origin'] as Body)['decision'], (t['destination'] as Body)['decision'], (t['registeredBy'] as Body)['role'], t['canConfirm'], t['canCancel']],
      ['secretary', 'pending', 'pending', 'secretario', false, true]);
    assert.equal(await pool(xavier.membershipId), 450_000, 'comprometido en la bolsa de origen');
    const hold = (await db.admin.query('select actor_role, actor_membership_id from adex.capital_operations where id = $1', [t['holdOperationId']])).rows[0];
    assert.deepEqual([hold.actor_role, hold.actor_membership_id], ['secretario', M.gabiSec], 'el asiento conserva quién lo registró');
    assert.equal((await decide($gabi, t['id'], 'confirm')).status, 403, 'el Secretario no confirma por nadie');
    assert.ok(((await fabio('GET', '/v1/capital/admin-transfers')).body['transfers'] as Body[]).some((x) => x['id'] === t['id']), 'otro Secretario lo consulta');
    const one = await decide(xavier.money, t['id'], 'confirm');
    assert.deepEqual([T(one)['state'], (T(one)['origin'] as Body)['decision'], (T(one)['destination'] as Body)['decision']], ['pending', 'confirmed', 'pending']);
    assert.equal(await pool(M.anaAdmin), 700_000, 'sin aplicar hasta la segunda confirmación');
    const two = await decide($ana, t['id'], 'confirm');
    assert.equal(T(two)['state'], 'applied');
    assert.equal(await pool(M.anaAdmin), 750_000);
    assert.equal(await transit(), 0);
    const row = (await db.admin.query('select origin_decided_identity_id o, destination_decided_identity_id d, registered_by_identity_id g from adex.admin_transfers where id = $1', [t['id']])).rows[0];
    assert.equal(new Set([row.o, row.d, row.g]).size, 3, 'tres personas distintas, cada decisión con su identidad');
  });

  test('AT-005 · Secretario: rechazo de una parte tras la confirmación de la otra; cancelación y otro Secretario', async () => {
    const r = await register($gabi, { originAdminId: M.anaAdmin, destinationAdminId: xavier.membershipId, amountMinor: 10_000, reason: 'Comunicada por teléfono' });
    await decide($ana, T(r)['id'], 'confirm');
    const no = await decide(xavier.money, T(r)['id'], 'reject', { reason: 'No llegó a mi cuenta' });
    assert.deepEqual([T(no)['state'], (T(no)['origin'] as Body)['decision'], (T(no)['destination'] as Body)['decision']], ['rejected', 'confirmed', 'rejected']);
    assert.equal(await pool(M.anaAdmin), 750_000, 'nada se trasladó');
    const r2 = await register($gabi, { originAdminId: M.anaAdmin, destinationAdminId: xavier.membershipId, amountMinor: 10_000, reason: 'Registrada por error' });
    assert.equal((await decide($fabio, T(r2)['id'], 'cancel', { reason: 'No la registré yo' })).status, 403);
    assert.equal(T(await decide($gabi, T(r2)['id'], 'cancel', { reason: 'Registrada por error' }))['state'], 'cancelled');
    assert.equal(await pool(M.anaAdmin), 750_000);
    // Entradas inválidas: mismo origen y destino, Administrador inexistente, rol que no es Administrador.
    assert.equal((await register($gabi, { originAdminId: M.anaAdmin, destinationAdminId: M.anaAdmin, amountMinor: 1, reason: 'Igual' })).body['error'], 'INVALID_INPUT');
    assert.equal((await register($gabi, { destinationAdminId: M.anaAdmin, amountMinor: 1, reason: 'Sin origen' })).body['error'], 'INVALID_INPUT');
    assert.equal((await register($gabi, { originAdminId: M.anaAdmin, destinationAdminId: M.gabiSec, amountMinor: 1, reason: 'A una secretaria' })).body['error'], 'NOT_FOUND');
    assert.equal((await register($ana, { originAdminId: xavier.membershipId, destinationAdminId: M.anaAdmin, amountMinor: 1, reason: 'Desde bolsa ajena' })).status, 403);
  });

  test('AT-006 · la misma persona no registra como Secretario un traspaso en el que es parte', async () => {
    // DS-05: la MISMA identidad de Ana con una segunda membresía, de Secretaria, en la misma empresa.
    await db.admin.query(`insert into adex.memberships (id, company_id, identity_id, role, status, display_name, created_at, updated_at)
      values ('m-ana-sec-r53', $1, $2, 'secretario', 'activo', 'Ana Secretaria', now(), now())`, [c1, identityOf('ana')]);
    const anaSec = money(caller(api, issuer, 'ana', 'm-ana-sec-r53'));
    const r = await register(anaSec, { originAdminId: M.anaAdmin, destinationAdminId: xavier.membershipId, amountMinor: 1_000, reason: 'Me lo registro a mí' });
    assert.deepEqual([r.status, r.body['error']], [403, 'REGISTRANT_CANNOT_BE_PARTY']);
    assert.equal(await pool(M.anaAdmin), 750_000);
  });

  test('AT-007 · concurrencia: dos compromisos sobre el mismo dinero, dos confirmaciones simultáneas, doble toque', async () => {
    const both = await Promise.all([1, 2].map((i) => register($ana, { destinationAdminId: xavier.membershipId, amountMinor: 400_000, reason: `Simultáneo ${i}` })));
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 409], 'solo uno compromete 400.000 de 750.000');
    const won = both.find((r) => r.status === 201)!;
    await decide($ana, T(won)['id'], 'cancel', { reason: 'Limpieza de la prueba' });
    const s = await register($gabi, { originAdminId: M.anaAdmin, destinationAdminId: xavier.membershipId, amountMinor: 20_000, reason: 'Dos confirmaciones a la vez' });
    const pair = await Promise.all([decide($ana, T(s)['id'], 'confirm'), decide(xavier.money, T(s)['id'], 'confirm')]);
    assert.deepEqual(pair.map((r) => r.status), [200, 200]);
    const final = (await db.admin.query('select state, settle_operation_id from adex.admin_transfers where id = $1', [T(s)['id']])).rows[0];
    assert.equal(final.state, 'applied');
    assert.equal(await count(db.admin, `select 1 from adex.capital_operations where company_id = $1 and kind = 'ADMIN_TRANSFER_APPLY' and id = $2`, [c1, final.settle_operation_id]), 1);
    assert.equal(await pool(xavier.membershipId), 470_000, 'aplicado una sola vez');
    const t = await register($ana, { destinationAdminId: xavier.membershipId, amountMinor: 5_000, reason: 'Doble toque del destino' });
    const taps = await Promise.all([decide(xavier.money, T(t)['id'], 'confirm'), decide(xavier.money, T(t)['id'], 'confirm')]);
    assert.deepEqual(taps.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await pool(xavier.membershipId), 475_000);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('AT-008 · aislamiento: otra empresa no ve ni alcanza los traspasos; el SuperAdmin consulta y concilia', async () => {
    assert.equal(((await carla('GET', '/v1/capital/admin-transfers')).body['transfers'] as Body[]).length, 0);
    assert.equal((await register($hugo, { destinationAdminId: M.anaAdmin, amountMinor: 1, reason: 'Otra empresa' })).body['error'], 'NOT_FOUND');
    const all = (await bruno('GET', '/v1/capital/admin-transfers')).body['transfers'] as Body[];
    assert.ok(all.length >= 8 && all.every((x) => x['mySide'] === null));
    assert.equal((await register($bruno, { destinationAdminId: M.anaAdmin, amountMinor: 1, reason: 'El SuperAdmin asigna' })).status, 403);
    const dir = (await gabi('GET', '/v1/capital/admin-directory')).body['admins'] as Body[];
    assert.deepEqual(Object.keys(dir[0]!).sort(), ['adminId', 'name', 'self'], 'el directorio no lleva saldos');
    const rec = (await bruno('GET', '/v1/capital/reconciliation')).body;
    assert.equal(rec['ok'], true, JSON.stringify(rec));
    assert.ok((rec['checks'] as Body[]).some((c) => c['name'] === 'transit-matches-pending-transfers' && c['ok'] === true));
  });

  test('AT-009 · los asientos del traspaso no se anulan por la vía genérica ni se editan', async () => {
    const op = (await db.admin.query(`select id from adex.capital_operations where company_id = $1 and kind = 'ADMIN_TRANSFER_HOLD' limit 1`, [c1])).rows[0].id;
    const r = await $ana(`/v1/capital/operations/${op}/reverse`, { reason: 'Intento de anular el compromiso' });
    assert.deepEqual([r.status, r.body['error']], [409, 'REVERSAL_NOT_ALLOWED']);
    await assert.rejects(db.admin.query(`update adex.admin_transfers set amount_minor = 1 where company_id = $1 and state = 'applied'`, [c1]), /immutable/);
    await assert.rejects(db.admin.query(`delete from adex.admin_transfers where company_id = $1`, [c1]));
  });
});
