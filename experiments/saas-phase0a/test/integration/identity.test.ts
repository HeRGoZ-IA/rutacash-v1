// [pg+api] PostgreSQL REAL + API HTTP real. Tokens del EMISOR LOCAL (formato
// Supabase), no de Supabase Auth: prueban la autorización por membresía, no Auth.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { count, createTestDb, type TestDb } from '../helpers/db.ts';
import { startApi, type TestApi } from '../helpers/api.ts';
import { createLocalIssuer, type LocalIssuer } from '../helpers/issuer.ts';
import * as F from '../helpers/fixtures.ts';

let db: TestDb;
let iss: LocalIssuer;
let api: TestApi;

before(async () => {
  db = await createTestDb('identity');
  await F.seed(db.superPool);
  iss = await createLocalIssuer();
  api = await startApi(db.apiPool, iss.verifier);
});
after(async () => {
  // Cerrar SIEMPRE antes de comprobar: un pool abierto impediría que el proceso termine.
  const errors = [...api.errors];
  await api.close();
  await db.close();
  assert.deepEqual(errors, [], 'la API no debe producir errores internos inesperados');
});

const withdraw = (token: string, membership: string, account: string, amount: string, operationId = randomUUID()) =>
  api.call('POST', `/v1/accounts/${account}/withdrawals`, { token, membership, body: { operationId, amount } });
const deposit = (token: string, membership: string, account: string, amount: string, operationId = randomUUID()) =>
  api.call('POST', `/v1/accounts/${account}/deposits`, { token, membership, body: { operationId, amount } });
const accountIds = (body: Record<string, unknown>) => (body['accounts'] as { id: string }[]).map((a) => a.id).sort();

test('ID-001 [pg+api] una identidad con varias membresías (dos empresas, dos roles en una)', async () => {
  const token = await iss.issue(F.ANA);
  const r = await api.call('GET', '/v1/me/memberships', { token });
  assert.equal(r.status, 200);
  assert.equal(r.body['identityId'], F.ANA);
  const ms = r.body['memberships'] as { membershipId: string; companyId: string; role: string }[];
  assert.deepEqual(ms.map((m) => m.membershipId).sort(), [F.M_ANA_BR_ADMIN, F.M_ANA_BR_COBRADOR, F.M_ANA_CO_SUPERVISOR].sort());
  assert.deepEqual([...new Set(ms.map((m) => m.companyId))].sort(), [F.COMPANY_BR, F.COMPANY_CO].sort());
  assert.deepEqual(ms.filter((m) => m.companyId === F.COMPANY_BR).map((m) => m.role).sort(), ['admin', 'cobrador']);
  // Solo SUS membresías (RLS memberships_self), nunca las de otras identidades.
  const bruno = await api.call('GET', '/v1/me/memberships', { token: await iss.issue(F.BRUNO) });
  assert.deepEqual((bruno.body['memberships'] as { membershipId: string }[]).map((m) => m.membershipId), [F.M_BRUNO_CO_ADMIN]);
});

test('ID-002 [pg+api] el contexto activo es la membresía elegida, resuelta en PostgreSQL', async () => {
  const token = await iss.issue(F.ANA);
  const cases = [
    { m: F.M_ANA_BR_ADMIN, company: F.COMPANY_BR, role: 'admin', scope: 'company', routes: [] as string[] },
    { m: F.M_ANA_BR_COBRADOR, company: F.COMPANY_BR, role: 'cobrador', scope: 'routes', routes: [F.ROUTE_BR1] },
    { m: F.M_ANA_CO_SUPERVISOR, company: F.COMPANY_CO, role: 'supervisor', scope: 'company', routes: [] as string[] },
  ];
  for (const c of cases) {
    const r = await api.call('GET', '/v1/context', { token, membership: c.m });
    assert.equal(r.status, 200);
    assert.equal(r.body['membershipId'], c.m);
    assert.equal(r.body['role'], c.role);
    assert.equal(r.body['scope'], c.scope);
    assert.deepEqual(r.body['routeIds'], c.routes);
    assert.equal((r.body['company'] as { id: string }).id, c.company);
  }
  // Sin membresía elegida no hay contexto.
  assert.equal((await api.call('GET', '/v1/accounts', { token })).body['error'], 'MEMBERSHIP_REQUIRED');
});

test('ID-003 [pg+api] permisos independientes por membresía', async () => {
  const token = await iss.issue(F.ANA);
  // Como cobradora de BR-1: ve solo su ruta y no puede depositar.
  const asCobrador = await api.call('GET', '/v1/accounts', { token, membership: F.M_ANA_BR_COBRADOR });
  assert.deepEqual(accountIds(asCobrador.body), [F.ACC_BR_R1]);
  assert.equal((await api.call('GET', `/v1/accounts/${F.ACC_BR_R2}`, { token, membership: F.M_ANA_BR_COBRADOR })).status, 404);
  assert.equal((await api.call('GET', `/v1/accounts/${F.ACC_BR_COMPANY}`, { token, membership: F.M_ANA_BR_COBRADOR })).status, 404);
  assert.equal((await deposit(token, F.M_ANA_BR_COBRADOR, F.ACC_BR_R1, '1.00')).body['error'], 'PERMISSION_DENIED');
  assert.equal((await withdraw(token, F.M_ANA_BR_COBRADOR, F.ACC_BR_R1, '1.00')).status, 201);
  // Como admin de BR: ve las tres cuentas de BR y puede depositar.
  const asAdmin = await api.call('GET', '/v1/accounts', { token, membership: F.M_ANA_BR_ADMIN });
  assert.deepEqual(accountIds(asAdmin.body), [F.ACC_BR_COMPANY, F.ACC_BR_R1, F.ACC_BR_R2].sort());
  assert.equal((await deposit(token, F.M_ANA_BR_ADMIN, F.ACC_BR_R2, '1.00')).status, 201);
  // Como supervisora de CO: lee CO, no retira.
  const asSup = await api.call('GET', '/v1/accounts', { token, membership: F.M_ANA_CO_SUPERVISOR });
  assert.deepEqual(accountIds(asSup.body), [F.ACC_CO_COMPANY, F.ACC_CO_R1].sort());
  assert.equal((await withdraw(token, F.M_ANA_CO_SUPERVISOR, F.ACC_CO_R1, '1.00')).body['error'], 'PERMISSION_DENIED');
  // La auditoría registra la membresía y el rol con que se actuó.
  const a = await db.superPool.query(`select membership_id, role from adex.audit_log where identity_id = $1 and outcome = 'approved' order by id`, [F.ANA]);
  assert.deepEqual(a.rows.map((x) => [x.membership_id, x.role]), [[F.M_ANA_BR_COBRADOR, 'cobrador'], [F.M_ANA_BR_ADMIN, 'admin']]);
});

test('ID-004 [pg+api] membresía desactivada: el MISMO token deja de operar', async () => {
  const token = await iss.issue(F.EVA);
  // 1-3. Identidad autenticada, membresía activa, operación autorizada.
  assert.equal((await withdraw(token, F.M_EVA_BR_COBRADOR, F.ACC_BR_R1, '1.00')).status, 201);
  // 4. Desactivación (operación administrativa directa en la base).
  await db.superPool.query(`update adex.memberships set status = 'inactive', updated_at = now() where id = $1`, [F.M_EVA_BR_COBRADOR]);
  // 5. Reintento con el mismo token → rechazado.
  const retry = await withdraw(token, F.M_EVA_BR_COBRADOR, F.ACC_BR_R1, '1.00');
  assert.equal(retry.status, 403);
  assert.equal(retry.body['error'], 'MEMBERSHIP_INACTIVE');
  assert.equal((await api.call('GET', '/v1/accounts', { token, membership: F.M_EVA_BR_COBRADOR })).body['error'], 'MEMBERSHIP_INACTIVE');
  // El token sigue siendo criptográficamente válido: lo revocado es la membresía, no la sesión.
  assert.equal((await iss.verifier(token)).identityId, F.EVA);
  assert.equal(await count(db.superPool, 'select 1 from adex.movements where identity_id = $1', [F.EVA]), 1);

  // Empresa suspendida: todas sus membresías dejan de operar con tokens vigentes.
  const bruno = await iss.issue(F.BRUNO);
  assert.equal((await api.call('GET', '/v1/accounts', { token: bruno, membership: F.M_BRUNO_CO_ADMIN })).status, 200);
  await db.superPool.query(`update adex.companies set status = 'suspended' where id = $1`, [F.COMPANY_CO]);
  assert.equal((await api.call('GET', '/v1/accounts', { token: bruno, membership: F.M_BRUNO_CO_ADMIN })).body['error'], 'COMPANY_SUSPENDED');
  await db.superPool.query(`update adex.companies set status = 'active' where id = $1`, [F.COMPANY_CO]);
  // Reactivar la membresía restablece el acceso con el mismo token.
  await db.superPool.query(`update adex.memberships set status = 'active' where id = $1`, [F.M_EVA_BR_COBRADOR]);
  assert.equal((await api.call('GET', '/v1/accounts', { token, membership: F.M_EVA_BR_COBRADOR })).status, 200);
});

test('ID-005 [pg+api] token inválido o identidad no aprovisionada', async () => {
  const before = await count(db.superPool, 'select 1 from adex.operations');
  const body = { operationId: randomUUID(), amount: '1.00' };
  const path = `/v1/accounts/${F.ACC_BR_R1}/withdrawals`;
  assert.equal((await api.call('POST', path, { membership: F.M_ANA_BR_ADMIN, body })).body['error'], 'MISSING_TOKEN');
  assert.equal((await api.call('POST', path, { token: await iss.issueForged(F.ANA), membership: F.M_ANA_BR_ADMIN, body })).status, 401);
  assert.equal((await api.call('POST', path, { token: await iss.issue(F.ANA, { expSec: -60 }), membership: F.M_ANA_BR_ADMIN, body })).status, 401);
  assert.equal((await api.call('POST', path, { headers: { authorization: 'Basic YW5hOnNlY3JldA==' }, membership: F.M_ANA_BR_ADMIN, body })).status, 401);
  assert.equal((await api.call('GET', '/v1/me/memberships', { token: 'x.y.z' })).status, 401);
  // Las rutas desconocidas tampoco responden sin token.
  assert.equal((await api.call('GET', '/v1/admin/everything')).status, 401);
  assert.equal(await count(db.superPool, 'select 1 from adex.operations'), before, 'ningún intento sin autenticar escribe');

  // Token válido pero identidad sin aprovisionar en ADEX.
  assert.equal((await api.call('GET', '/v1/me/memberships', { token: await iss.issue(F.GHOST) })).body['error'], 'IDENTITY_NOT_PROVISIONED');
  // Identidad sin membresías: lista vacía y no puede usar membresías ajenas.
  const dario = await iss.issue(F.DARIO);
  assert.deepEqual((await api.call('GET', '/v1/me/memberships', { token: dario })).body['memberships'], []);
  assert.equal((await api.call('GET', '/v1/accounts', { token: dario, membership: F.M_ANA_BR_ADMIN })).body['error'], 'MEMBERSHIP_NOT_FOUND');
});

test('ID-006 [pg+api] sin herencia entre roles de la misma identidad', async () => {
  const token = await iss.issue(F.ANA);
  // Ana es admin en BR, pero como supervisora en CO no retira y como cobradora en BR no deposita.
  assert.equal((await withdraw(token, F.M_ANA_CO_SUPERVISOR, F.ACC_CO_COMPANY, '1.00')).body['error'], 'PERMISSION_DENIED');
  assert.equal((await deposit(token, F.M_ANA_BR_COBRADOR, F.ACC_BR_R1, '1.00')).body['error'], 'PERMISSION_DENIED');
  // Como cobradora de BR-1 no alcanza la ruta BR-2 aunque como admin sí.
  assert.equal((await withdraw(token, F.M_ANA_BR_COBRADOR, F.ACC_BR_R2, '1.00')).status, 404);
  // No se pueden combinar dos membresías en una petición.
  const both = await api.call('GET', '/v1/accounts', { token, membership: `${F.M_ANA_BR_ADMIN}, ${F.M_ANA_BR_COBRADOR}` });
  assert.equal(both.body['error'], 'INVALID_MEMBERSHIP_ID');
});
