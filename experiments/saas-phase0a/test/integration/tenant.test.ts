// [pg+api] y [pg-rls] Aislamiento multiempresa sobre PostgreSQL REAL.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { balanceOf, count, createTestDb, type TestDb } from '../helpers/db.ts';
import { startApi, type TestApi } from '../helpers/api.ts';
import { createLocalIssuer, type LocalIssuer } from '../helpers/issuer.ts';
import * as F from '../helpers/fixtures.ts';

let db: TestDb;
let iss: LocalIssuer;
let api: TestApi;

before(async () => {
  db = await createTestDb('tenant');
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

const ids = (body: Record<string, unknown>) => (body['accounts'] as { id: string }[]).map((a) => a.id).sort();

test('TENANT-001 [pg+api] lectura autorizada dentro de la empresa', async () => {
  const token = await iss.issue(F.BRUNO);
  const list = await api.call('GET', '/v1/accounts', { token, membership: F.M_BRUNO_CO_ADMIN });
  assert.equal(list.status, 200);
  assert.deepEqual(ids(list.body), [F.ACC_CO_COMPANY, F.ACC_CO_R1].sort());
  const one = await api.call('GET', `/v1/accounts/${F.ACC_CO_R1}`, { token, membership: F.M_BRUNO_CO_ADMIN });
  assert.equal(one.status, 200);
  assert.equal(one.body['balance'], '2000.00');
  assert.equal(one.body['currency'], 'COP');
});

test('TENANT-002 [pg+api] lectura entre empresas rechazada', async () => {
  const bruno = await iss.issue(F.BRUNO);
  for (const acc of [F.ACC_BR_COMPANY, F.ACC_BR_R1, F.ACC_BR_R2]) {
    const r = await api.call('GET', `/v1/accounts/${acc}`, { token: bruno, membership: F.M_BRUNO_CO_ADMIN });
    assert.equal(r.status, 404, 'no se revela ni la existencia de la cuenta ajena');
  }
  const ana = await iss.issue(F.ANA);
  const brList = await api.call('GET', '/v1/accounts', { token: ana, membership: F.M_ANA_BR_ADMIN });
  assert.ok(!ids(brList.body).includes(F.ACC_CO_COMPANY));
  assert.equal((await api.call('GET', `/v1/accounts/${F.ACC_CO_COMPANY}`, { token: ana, membership: F.M_ANA_BR_ADMIN })).status, 404);
});

test('TENANT-003 [pg+api] escritura entre empresas rechazada sin efectos', async () => {
  const bruno = await iss.issue(F.BRUNO);
  const beforeBal = await balanceOf(db.superPool, F.ACC_BR_COMPANY);
  const beforeOps = await count(db.superPool, 'select 1 from adex.operations');
  for (const kind of ['withdrawals', 'deposits']) {
    const r = await api.call('POST', `/v1/accounts/${F.ACC_BR_COMPANY}/${kind}`, {
      token: bruno, membership: F.M_BRUNO_CO_ADMIN, body: { operationId: randomUUID(), amount: '100.00' },
    });
    assert.equal(r.status, 404);
  }
  assert.equal(await balanceOf(db.superPool, F.ACC_BR_COMPANY), beforeBal);
  assert.equal(await count(db.superPool, 'select 1 from adex.operations'), beforeOps, 'la transacción rechazada no deja ni la clave de idempotencia');
});

test('TENANT-004 [pg-rls] RLS bajo el rol no privilegiado de la API (sin pasar por la API)', async (t) => {
  const c = new pg.Client({ connectionString: db.apiUrl });
  await c.connect();
  const ctx = async (identity: string, membership: string, company: string) => {
    await c.query(`select set_config('adex.identity_id', $1, true), set_config('adex.membership_id', $2, true), set_config('adex.company_id', $3, true)`, [identity, membership, company]);
  };
  const n = async (sql: string, params: unknown[] = []) => Number((await c.query(`select count(*)::int as n from (${sql}) q`, params)).rows[0].n);
  const sqlState = async (sql: string, params: unknown[] = []) => {
    await c.query('savepoint s');
    try { await c.query(sql, params); await c.query('release savepoint s'); return 'OK'; }
    catch (e) { await c.query('rollback to savepoint s'); return (e as { code?: string }).code ?? 'ERR'; }
  };
  try {
    await t.test('el rol está realmente sujeto a RLS', async () => {
      const r = await c.query(`select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user`);
      assert.deepEqual(r.rows[0], { current_user: 'adex_api', rolsuper: false, rolbypassrls: false });
      const owners = await c.query(`select distinct tableowner from pg_tables where schemaname = 'adex'`);
      assert.deepEqual(owners.rows.map((x) => x.tableowner), ['adex_owner'], 'la API no es propietaria');
      const rls = await c.query(`select count(*)::int as n from pg_class cl join pg_namespace ns on ns.oid = cl.relnamespace
                                  where ns.nspname = 'adex' and cl.relkind = 'r' and not (cl.relrowsecurity and cl.relforcerowsecurity)`);
      assert.equal(rls.rows[0].n, 0, 'todas las tablas con RLS habilitada y forzada');
    });

    await c.query('begin');
    await t.test('sin contexto no se ve ninguna fila', async () => {
      for (const table of ['companies', 'identities', 'memberships', 'routes', 'accounts', 'operations', 'movements', 'audit_log']) {
        assert.equal(await n(`select 1 from adex.${table}`), 0, table);
      }
    });
    await t.test('contexto BR: solo filas de BR; lo de CO es invisible e inmodificable', async () => {
      await ctx(F.ANA, F.M_ANA_BR_ADMIN, F.COMPANY_BR);
      assert.equal(await n('select 1 from adex.accounts'), 3);
      assert.equal(await n('select 1 from adex.accounts where company_id = $1', [F.COMPANY_CO]), 0);
      assert.equal(await n('select 1 from adex.accounts where id = $1', [F.ACC_CO_COMPANY]), 0);
      const upd = await c.query('update adex.accounts set balance_minor = 0 where id = $1', [F.ACC_CO_COMPANY]);
      assert.equal(upd.rowCount, 0, 'UPDATE sobre cuenta ajena no afecta filas');
      const opId = randomUUID();
      assert.equal(await sqlState(`insert into adex.operations (company_id, operation_id, kind, request_hash, membership_id, outcome) values ($1, $2, 'deposit', 'x', $3, 'pending')`,
        [F.COMPANY_CO, opId, F.M_ANA_BR_ADMIN]), '42501', 'operación en empresa ajena: violación de política');
      assert.equal(await sqlState(`insert into adex.audit_log (company_id, identity_id, membership_id, role, action, entity_type, entity_id, outcome) values ($1, $2, $3, 'admin', 'x', 'x', 'x', 'approved')`,
        [F.COMPANY_CO, F.ANA, F.M_BRUNO_CO_ADMIN]), '42501', 'auditoría falsificada en empresa ajena');
    });
    await t.test('contexto falsificado: empresa CO con membresía de BR → nada', async () => {
      await ctx(F.ANA, F.M_ANA_BR_ADMIN, F.COMPANY_CO);
      assert.equal(await n('select 1 from adex.accounts'), 0);
      assert.equal(await n('select 1 from adex.companies'), 0);
      await ctx(F.BRUNO, F.M_ANA_BR_ADMIN, F.COMPANY_BR); // membresía de otra identidad
      assert.equal(await n('select 1 from adex.accounts'), 0);
    });
    await t.test('alcance por rutas también en RLS', async () => {
      await ctx(F.ANA, F.M_ANA_BR_COBRADOR, F.COMPANY_BR);
      assert.deepEqual((await c.query('select id from adex.accounts')).rows.map((r) => r.id), [F.ACC_BR_R1]);
      assert.equal((await c.query('update adex.accounts set balance_minor = 0 where id = $1', [F.ACC_BR_R2])).rowCount, 0);
    });
    await t.test('membresía desactivada → RLS no devuelve nada aunque la API fallara', async () => {
      await db.superPool.query(`update adex.memberships set status = 'inactive' where id = $1`, [F.M_CARLA_BR_COBRADOR]);
      await ctx(F.CARLA, F.M_CARLA_BR_COBRADOR, F.COMPANY_BR);
      assert.equal(await n('select 1 from adex.accounts'), 0);
      await db.superPool.query(`update adex.memberships set status = 'active' where id = $1`, [F.M_CARLA_BR_COBRADOR]);
      assert.equal(await n('select 1 from adex.accounts'), 1);
    });
    await t.test('la API no puede saltarse RLS ni el carácter append-only', async () => {
      await ctx(F.ANA, F.M_ANA_BR_ADMIN, F.COMPANY_BR);
      assert.equal(await sqlState('alter table adex.accounts disable row level security'), '42501');
      assert.equal(await sqlState('set role adex_owner'), '42501');
      assert.equal(await sqlState('set session authorization postgres'), '42501');
      assert.equal(await sqlState(`update adex.memberships set role = 'admin' where id = $1`, [F.M_ANA_BR_COBRADOR]), '42501');
      assert.equal(await sqlState('delete from adex.audit_log'), '42501');
      assert.equal(await sqlState('update adex.movements set amount_minor = 1'), '42501');
    });
    await c.query('rollback');
    await t.test('contraste: el superusuario (ignora RLS) sí ve las 5 cuentas — los datos existen', async () => {
      assert.equal(await count(db.superPool, 'select 1 from adex.accounts'), 5);
    });
  } finally {
    await c.end();
  }
});

test('TENANT-005 [pg+api] manipulación del contexto rechazada', async () => {
  const ana = await iss.issue(F.ANA);
  // Membresía de otra identidad.
  assert.equal((await api.call('GET', '/v1/accounts', { token: ana, membership: F.M_BRUNO_CO_ADMIN })).body['error'], 'MEMBERSHIP_NOT_FOUND');
  // Membresía inexistente / malformada.
  assert.equal((await api.call('GET', '/v1/accounts', { token: ana, membership: randomUUID() })).body['error'], 'MEMBERSHIP_NOT_FOUND');
  assert.equal((await api.call('GET', '/v1/accounts', { token: ana, membership: `' or 1=1 --` })).body['error'], 'INVALID_MEMBERSHIP_ID');
  // Encabezados inventados de rol/empresa se ignoran: el contexto sale de la base.
  const forged = { 'x-adex-role': 'admin', 'x-adex-company': F.COMPANY_CO, 'x-role': 'admin' };
  const ctx = await api.call('GET', '/v1/context', { token: ana, membership: F.M_ANA_BR_COBRADOR, headers: forged });
  assert.equal(ctx.body['role'], 'cobrador');
  assert.equal((ctx.body['company'] as { id: string }).id, F.COMPANY_BR);
  const dep = await api.call('POST', `/v1/accounts/${F.ACC_BR_R1}/deposits`, {
    token: ana, membership: F.M_ANA_BR_COBRADOR, headers: forged, body: { operationId: randomUUID(), amount: '1.00' },
  });
  assert.equal(dep.body['error'], 'PERMISSION_DENIED');
  // Parámetros de consulta con otra empresa se ignoran.
  const q = await api.call('GET', `/v1/accounts?companyId=${F.COMPANY_CO}&role=admin`, { token: ana, membership: F.M_ANA_BR_COBRADOR });
  assert.deepEqual(ids(q.body), [F.ACC_BR_R1]);
  // Campos de autoridad en el cuerpo se rechazan.
  for (const extra of [{ companyId: F.COMPANY_CO }, { role: 'admin' }, { membershipId: F.M_ANA_BR_ADMIN }, { routeIds: [F.ROUTE_BR2] }]) {
    const r = await api.call('POST', `/v1/accounts/${F.ACC_BR_R1}/withdrawals`, {
      token: ana, membership: F.M_ANA_BR_COBRADOR, body: { operationId: randomUUID(), amount: '1.00', ...extra },
    });
    assert.equal(r.body['error'], 'UNKNOWN_FIELD', JSON.stringify(extra));
  }
});
