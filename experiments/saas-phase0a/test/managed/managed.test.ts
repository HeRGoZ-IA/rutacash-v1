// [supabase-pg] Fase 0A.1 · La POC sobre el PostgreSQL GESTIONADO del proyecto
// Supabase experimental (scripts/run-managed.ts). Sin ese arnés: NO EJECUTADA.
//
// - La API se conecta como `adex_api` por el pooler en MODO TRANSACCIÓN (IPv4).
// - `postgres` (administrador del proyecto) solo siembra y verifica.
// - Los tokens de las pruebas financieras salen del EMISOR LOCAL: aquí se prueba
//   PostgreSQL gestionado, no Supabase Auth. El recorrido con tokens reales de
//   Supabase Auth es AUTH-REAL-004 (test/auth-real).
// - Volumen deliberadamente pequeño: no es una prueba de carga del plan Free.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { balanceOf, count, createTestDb, managedMode, managedSsl, type TestDb } from '../helpers/db.ts';
import { startApi, type TestApi } from '../helpers/api.ts';
import { createLocalIssuer, type LocalIssuer } from '../helpers/issuer.ts';
import * as F from '../helpers/fixtures.ts';

const SKIP = managedMode() ? false : 'NO EJECUTADA: requiere el proyecto Supabase experimental (npm run test:managed)';
const URL_ = process.env['SUPABASE_URL']?.replace(/\/$/, '');
const PUBLISHABLE = process.env['SUPABASE_ANON_KEY'] ?? '';
const SECRET = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const TABLES = ['currencies', 'companies', 'identities', 'routes', 'memberships', 'membership_routes', 'accounts', 'operations', 'movements', 'audit_log'];

let db: TestDb;
let iss: LocalIssuer;
let api: TestApi;
let anaToken: string;
let evaToken: string;
const createdUsers: string[] = [];
const runAccounts: string[] = [];

const adminHeaders = (): Record<string, string> =>
  SECRET.startsWith('sb_') ? { apikey: SECRET } : { apikey: SECRET, authorization: `Bearer ${SECRET}` };

before(async () => {
  if (SKIP) return;
  db = await createTestDb('managed');
  await F.seed(db.superPool);
  iss = await createLocalIssuer();
  api = await startApi(db.apiPool, iss.verifier);
  anaToken = await iss.issue(F.ANA);
  evaToken = await iss.issue(F.EVA);
});
after(async () => {
  if (SKIP) return;
  for (const id of createdUsers) await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: adminHeaders() });
  const errors = [...api.errors];
  await api.close();
  await db.close();
  assert.deepEqual(errors, [], 'sin errores internos inesperados');
});

async function newAccount(balanceMinor: bigint, company = F.COMPANY_BR, route: string | null = F.ROUTE_BR1): Promise<string> {
  const id = randomUUID();
  await db.superPool.query('insert into adex.accounts (id, company_id, route_id, name, balance_minor) values ($1, $2, $3, $4, $5)',
    [id, company, route, `m-${id.slice(0, 8)}`, balanceMinor.toString()]);
  runAccounts.push(id);
  return id;
}
const withdraw = (a: TestApi, token: string, membership: string, account: string, amount: string, operationId = randomUUID()) =>
  a.call('POST', `/v1/accounts/${account}/withdrawals`, { token, membership, body: { operationId, amount } });
const deposit = (a: TestApi, token: string, membership: string, account: string, amount: string, operationId = randomUUID()) =>
  a.call('POST', `/v1/accounts/${account}/deposits`, { token, membership, body: { operationId, amount } });
const movementsOf = (acc: string) => count(db.superPool, 'select 1 from adex.movements where account_id = $1', [acc]);
const auditOf = (acc: string, outcome?: string) =>
  count(db.superPool, `select 1 from adex.audit_log where entity_id = $1 ${outcome ? 'and outcome = $2' : ''}`, outcome ? [acc, outcome] : [acc]);
const opsOf = (opId: string) => count(db.superPool, 'select 1 from adex.operations where operation_id = $1', [opId]);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function syntheticUserToken(label: string): Promise<string> {
  const email = `adex-0a1-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = `Synthetic-${randomUUID()}`;
  const c = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST', headers: { ...adminHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  assert.equal(c.status, 200, `crear usuario sintético → ${c.status}`);
  createdUsers.push(((await c.json()) as { id: string }).id);
  const s = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: PUBLISHABLE, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  assert.equal(s.status, 200);
  return ((await s.json()) as { access_token: string }).access_token;
}

// ---------------------------------------------------------------------------

test('MANAGED-ROLE-001 [supabase-pg] rol de la API de mínimos privilegios, sujeto a RLS', { skip: SKIP }, async (t) => {
  const roles = await db.superPool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean; rolcanlogin: boolean }>(
    `select rolname, rolsuper, rolbypassrls, rolinherit, rolcanlogin from pg_roles
      where rolname in ('postgres', 'adex_owner', 'adex_api', 'anon', 'authenticated', 'service_role', 'authenticator') order by rolname`);
  for (const r of roles.rows) t.diagnostic(`${r.rolname}: super=${r.rolsuper} bypassrls=${r.rolbypassrls} inherit=${r.rolinherit} login=${r.rolcanlogin}`);
  const apiRole = roles.rows.find((r) => r.rolname === 'adex_api');
  assert.deepEqual(apiRole && { s: apiRole.rolsuper, b: apiRole.rolbypassrls, i: apiRole.rolinherit, l: apiRole.rolcanlogin }, { s: false, b: false, i: false, l: true });
  const owner = roles.rows.find((r) => r.rolname === 'adex_owner');
  assert.deepEqual(owner && { s: owner.rolsuper, b: owner.rolbypassrls, l: owner.rolcanlogin }, { s: false, b: false, l: false });

  // adex_api no pertenece a ningún rol, y ningún rol de la Data API puede convertirse en adex_api.
  assert.equal(await count(db.superPool, `select 1 from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'adex_api'`), 0);
  for (const role of ['authenticator', 'anon', 'authenticated', 'service_role']) {
    const r = await db.superPool.query(`select pg_has_role($1, 'adex_api', 'member') a, pg_has_role($1, 'adex_owner', 'member') o`, [role]);
    assert.deepEqual(r.rows[0], { a: false, o: false }, `${role} no puede asumir adex_api ni adex_owner`);
  }

  // Conectado realmente como adex_api por el pooler en modo transacción.
  const c = await db.apiPool.connect();
  try {
    const me = await c.query(`select current_user u, (select rolbypassrls from pg_roles where rolname = current_user) b`);
    assert.deepEqual(me.rows[0], { u: 'adex_api', b: false });
    const owners = await c.query(`select distinct tableowner from pg_tables where schemaname = 'adex'`);
    assert.deepEqual(owners.rows.map((x) => x.tableowner), ['adex_owner'], 'la API no es propietaria');
    const notForced = await c.query(`select count(*)::int n from pg_class cl join pg_namespace ns on ns.oid = cl.relnamespace
                                      where ns.nspname = 'adex' and cl.relkind = 'r' and not (cl.relrowsecurity and cl.relforcerowsecurity)`);
    assert.equal(notForced.rows[0].n, 0, 'RLS habilitada y forzada en todas las tablas');
  } finally { c.release(); }

  for (const table of TABLES) {
    const p = await db.superPool.query(`select has_table_privilege('adex_api', $1, 'DELETE') d, has_table_privilege('adex_api', $1, 'TRUNCATE') tr`, [`adex.${table}`]);
    assert.deepEqual(p.rows[0], { d: false, tr: false }, `adex_api sin DELETE/TRUNCATE en ${table}`);
  }
  for (const table of ['movements', 'audit_log']) {
    const p = await db.superPool.query(`select has_table_privilege('adex_api', $1, 'UPDATE') u`, [`adex.${table}`]);
    assert.equal(p.rows[0].u, false, `${table} append-only para la API`);
  }
});

test('MANAGED-CONN-001 [supabase-pg] conectividad: pooler transacción/sesión (IPv4) y conexión directa', { skip: SKIP }, async (t) => {
  await t.test('pooler en modo transacción (6543): adex_api', async () => {
    assert.equal((await db.apiPool.query('select current_user u')).rows[0].u, 'adex_api');
  });
  await t.test('pooler en modo sesión (5432): adex_api', async () => {
    const c = new pg.Client({ connectionString: process.env['ADEX_PG_API_SESSION_URL'], ssl: managedSsl() });
    await c.connect();
    try { assert.equal((await c.query('select current_user u')).rows[0].u, 'adex_api'); } finally { await c.end(); }
  });
  await t.test('el contexto RLS (set_config local) no se filtra entre transacciones del pooler', async () => {
    for (let i = 0; i < 15; i++) {
      const c = await db.apiPool.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('adex.identity_id', $1, true)`, [F.ANA]);
        await c.query('commit');
      } finally { c.release(); }
      const leaked = await db.apiPool.query(`select coalesce(current_setting('adex.identity_id', true), '') v`);
      assert.equal(leaked.rows[0].v, '', `iteración ${i}: contexto residual`);
      assert.equal(await count(db.apiPool, 'select 1 from adex.accounts'), 0, 'sin contexto no hay filas');
    }
  });
  await t.test('conexión directa db.<ref>.supabase.co (IPv6 en el plan Free)', async (st) => {
    const c = new pg.Client({ connectionString: process.env['ADEX_PG_DIRECT_API_URL'], ssl: managedSsl(), connectionTimeoutMillis: 8000 });
    try {
      await c.connect();
      assert.equal((await c.query('select current_user u')).rows[0].u, 'adex_api');
      st.diagnostic('conexión directa disponible desde este equipo');
    } catch (e) {
      st.skip(`BLOQUEADO por red: ${(e as { code?: string }).code ?? (e as Error).message} (directa = IPv6; no se contrata IPv4)`);
    } finally { await c.end().catch(() => undefined); }
  });
});

test('MANAGED-RLS-001 [supabase-pg] RLS multiempresa en PostgreSQL gestionado (sin pasar por la API)', { skip: SKIP }, async (t) => {
  const c = await db.apiPool.connect();
  const ctx = (identity: string, membership: string, company: string) =>
    c.query(`select set_config('adex.identity_id', $1, true), set_config('adex.membership_id', $2, true), set_config('adex.company_id', $3, true)`, [identity, membership, company]);
  const n = async (sql: string, params: unknown[] = []) => Number((await c.query(`select count(*)::int as n from (${sql}) q`, params)).rows[0].n);
  const sqlState = async (sql: string, params: unknown[] = []) => {
    await c.query('savepoint s');
    try { await c.query(sql, params); await c.query('release savepoint s'); return 'OK'; }
    catch (e) { await c.query('rollback to savepoint s'); return (e as { code?: string }).code ?? 'ERR'; }
  };
  try {
    await c.query('begin');
    await t.test('sin contexto: ninguna fila', async () => {
      for (const table of TABLES.filter((x) => x !== 'currencies')) assert.equal(await n(`select 1 from adex.${table}`), 0, table);
    });
    await t.test('contexto BR: solo BR; CO invisible e inmodificable; escrituras ajenas rechazadas', async () => {
      await ctx(F.ANA, F.M_ANA_BR_ADMIN, F.COMPANY_BR);
      assert.equal(await n('select 1 from adex.accounts where id = any($1)', [[F.ACC_BR_COMPANY, F.ACC_BR_R1, F.ACC_BR_R2]]), 3);
      assert.equal(await n('select 1 from adex.accounts where company_id = $1', [F.COMPANY_CO]), 0);
      assert.equal((await c.query('update adex.accounts set balance_minor = 0 where id = $1', [F.ACC_CO_COMPANY])).rowCount, 0);
      assert.equal(await sqlState(`insert into adex.operations (company_id, operation_id, kind, request_hash, membership_id, outcome) values ($1, $2, 'deposit', 'x', $3, 'pending')`,
        [F.COMPANY_CO, randomUUID(), F.M_ANA_BR_ADMIN]), '42501');
      assert.equal(await sqlState(`insert into adex.audit_log (company_id, identity_id, membership_id, role, action, entity_type, entity_id, outcome) values ($1, $2, $3, 'admin', 'x', 'x', 'x', 'approved')`,
        [F.COMPANY_CO, F.ANA, F.M_BRUNO_CO_ADMIN]), '42501');
    });
    await t.test('contexto falsificado (empresa ajena o membresía de otra identidad): nada', async () => {
      await ctx(F.ANA, F.M_ANA_BR_ADMIN, F.COMPANY_CO);
      assert.equal(await n('select 1 from adex.accounts'), 0);
      await ctx(F.BRUNO, F.M_ANA_BR_ADMIN, F.COMPANY_BR);
      assert.equal(await n('select 1 from adex.accounts'), 0);
    });
    await t.test('alcance por rutas', async () => {
      await ctx(F.ANA, F.M_ANA_BR_COBRADOR, F.COMPANY_BR);
      assert.deepEqual((await c.query('select id from adex.accounts where id = any($1)', [[F.ACC_BR_COMPANY, F.ACC_BR_R1, F.ACC_BR_R2]])).rows.map((r) => r.id), [F.ACC_BR_R1]);
      assert.equal((await c.query('update adex.accounts set balance_minor = 0 where id = $1', [F.ACC_BR_R2])).rowCount, 0);
    });
    await t.test('append-only y sin DELETE para la API', async () => {
      await ctx(F.ANA, F.M_ANA_BR_ADMIN, F.COMPANY_BR);
      assert.equal(await sqlState('update adex.movements set amount_minor = 1'), '42501');
      assert.equal(await sqlState('delete from adex.audit_log'), '42501');
      assert.equal(await sqlState('delete from adex.accounts'), '42501');
    });
    await c.query('rollback');
    await t.test('membresía desactivada: RLS no devuelve nada', async () => {
      await db.superPool.query(`update adex.memberships set status = 'inactive' where id = $1`, [F.M_CARLA_BR_COBRADOR]);
      try {
        await c.query('begin');
        await ctx(F.CARLA, F.M_CARLA_BR_COBRADOR, F.COMPANY_BR);
        assert.equal(await n('select 1 from adex.accounts'), 0);
        await c.query('rollback');
      } finally {
        await db.superPool.query(`update adex.memberships set status = 'active' where id = $1`, [F.M_CARLA_BR_COBRADOR]);
      }
    });
    await t.test('contraste: el administrador del proyecto sí ve las cuentas (los datos existen)', async () => {
      assert.ok(await count(db.superPool, 'select 1 from adex.accounts') >= 5);
    });
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
});

test('MANAGED-DATAAPI-001 [supabase-pg] la Data API no expone el esquema adex', { skip: SKIP }, async (t) => {
  await t.test('privilegios: anon, authenticated, service_role y authenticator sin acceso a adex', async () => {
    for (const role of ['anon', 'authenticated', 'service_role', 'authenticator']) {
      const s = await db.superPool.query(`select has_schema_privilege($1, 'adex', 'USAGE') u`, [role]);
      assert.equal(s.rows[0].u, false, `${role} sin USAGE en adex`);
      for (const table of TABLES) {
        const p = await db.superPool.query(
          `select has_table_privilege($1, $2, 'SELECT') s, has_table_privilege($1, $2, 'INSERT') i, has_table_privilege($1, $2, 'UPDATE') u, has_table_privilege($1, $2, 'DELETE') d`,
          [role, `adex.${table}`]);
        assert.deepEqual(p.rows[0], { s: false, i: false, u: false, d: false }, `${role} en ${table}`);
      }
      const fns = await db.superPool.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                                              where ns.nspname = 'adex' and has_function_privilege($1, p.oid, 'EXECUTE')`, [role]);
      assert.equal(fns.rows[0].n, 0, `${role} sin EXECUTE en funciones de adex`);
    }
  });

  const userToken = await syntheticUserToken('dataapi');
  const acc = F.ACC_BR_R1;
  const before = await balanceOf(db.superPool, acc);
  const callers: Array<[string, Record<string, string>]> = [
    ['clave publicable (anon)', { apikey: PUBLISHABLE }],
    ['usuario autenticado real', { apikey: PUBLISHABLE, authorization: `Bearer ${userToken}` }],
    ['clave secreta (service_role)', adminHeaders()],
  ];
  for (const [who, headers] of callers) {
    await t.test(`REST con ${who}: lectura, escritura y RPC rechazadas`, async () => {
      const read = await fetch(`${URL_}/rest/v1/accounts?select=*`, { headers: { ...headers, 'accept-profile': 'adex' } });
      const readBody = await read.text();
      assert.ok(read.status >= 400, `GET adex.accounts → ${read.status}`);
      assert.ok(!readBody.includes(acc), 'sin datos en la respuesta');
      t.diagnostic(`${who}: GET adex → ${read.status} ${safeCode(readBody)}`);

      const pub = await fetch(`${URL_}/rest/v1/accounts?select=*`, { headers });
      assert.ok(pub.status >= 400, `GET public.accounts → ${pub.status}`);

      const patch = await fetch(`${URL_}/rest/v1/accounts?id=eq.${acc}`, {
        method: 'PATCH', headers: { ...headers, 'content-profile': 'adex', 'content-type': 'application/json', prefer: 'return=minimal' },
        body: JSON.stringify({ balance_minor: 0 }),
      });
      assert.ok(patch.status >= 400, `PATCH adex.accounts → ${patch.status}`);
      const ins = await fetch(`${URL_}/rest/v1/audit_log`, {
        method: 'POST', headers: { ...headers, 'content-profile': 'adex', 'content-type': 'application/json' }, body: '{}',
      });
      assert.ok(ins.status >= 400, `POST adex.audit_log → ${ins.status}`);
      const rpc = await fetch(`${URL_}/rest/v1/rpc/ctx_identity`, {
        method: 'POST', headers: { ...headers, 'content-profile': 'adex', 'content-type': 'application/json' }, body: '{}',
      });
      assert.ok(rpc.status >= 400, `RPC adex.ctx_identity → ${rpc.status}`);
    });
  }
  await t.test('GraphQL no refleja tablas de adex', async () => {
    const r = await fetch(`${URL_}/graphql/v1`, {
      method: 'POST', headers: { apikey: PUBLISHABLE, authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __schema { types { name } } }' }),
    });
    const text = (await r.text()).toLowerCase();
    t.diagnostic(`GraphQL → ${r.status}`);
    for (const name of ['accounts', 'movements', 'audit_log', 'auditlog', 'memberships']) assert.ok(!text.includes(`"${name}`), `sin tipo ${name}`);
  });
  await t.test('cero efectos: el saldo no cambió', async () => {
    assert.equal(await balanceOf(db.superPool, acc), before);
  });
});

function safeCode(body: string): string {
  try { return String((JSON.parse(body) as { code?: string }).code ?? ''); } catch { return ''; }
}

test('MANAGED-FIN-001 [supabase-pg+api] doble retiro concurrente 5.000 − 4.000 − 4.000', { skip: SKIP }, async (t) => {
  await t.test('dos peticiones simultáneas, dos usuarios, 5 rondas', async () => {
    for (let round = 0; round < 5; round++) {
      const acc = await newAccount(500000n);
      const [a, b] = await Promise.all([
        withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '4000.00'),
        withdraw(api, evaToken, F.M_EVA_BR_COBRADOR, acc, '4000.00'),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [201, 422], `ronda ${round}`);
      assert.equal((a.status === 422 ? a : b).body['balance'], '1000.00');
      assert.equal(await balanceOf(db.superPool, acc), 100000n);
      assert.equal(await movementsOf(acc), 1);
      assert.equal(await auditOf(acc, 'approved'), 1);
      assert.equal(await auditOf(acc, 'rejected'), 1);
    }
  });
  await t.test('bloqueo de saldo: la segunda transacción espera la fila y lee el saldo actualizado', async () => {
    const acc = await newAccount(500000n);
    const opA = randomUUID();
    const locked = deferred();
    const release = deferred();
    const pids: number[] = [];
    const paused = await startApi(db.apiPool, iss.verifier, {
      afterAccountLocked: async ({ operationId, client }) => {
        pids.push(Number((await client.query('select pg_backend_pid() as p')).rows[0].p));
        if (operationId === opA) { locked.resolve(); await release.promise; }
      },
    });
    try {
      const pA = withdraw(paused, anaToken, F.M_ANA_BR_ADMIN, acc, '4000.00', opA);
      await locked.promise;
      const pB = withdraw(paused, evaToken, F.M_EVA_BR_COBRADOR, acc, '4000.00');
      let waiting = 0;
      for (let i = 0; i < 100 && waiting === 0; i++) {
        await new Promise((r) => setTimeout(r, 30));
        waiting = await count(db.superPool, `select 1 from pg_locks l join pg_class c on c.oid = l.relation
                                               join pg_namespace n on n.oid = c.relnamespace
                                              where not l.granted and n.nspname = 'adex'`)
          + await count(db.superPool, `select 1 from pg_locks where not granted and locktype in ('transactionid', 'tuple')`);
      }
      release.resolve();
      const [a, b] = await Promise.all([pA, pB]);
      t.diagnostic(`bloqueo observado en pg_locks desde el administrador: ${waiting > 0 ? 'sí' : 'no visible'}`);
      assert.ok(waiting > 0, 'B esperaba un bloqueo mientras A retenía la fila');
      assert.equal(a.status, 201);
      assert.equal(b.status, 422);
      assert.equal(b.body['balance'], '1000.00', 'B leyó el saldo ya actualizado por A');
      assert.equal(new Set(pids).size, 2, 'dos backends distintos tras el pooler');
    } finally {
      release.resolve();
      await paused.close();
    }
  });
  await t.test('10 retiros simultáneos de 400 sobre 2.000 → 5 aprobados, saldo 0', async () => {
    const acc = await newAccount(200000n);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      i % 2 ? withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '400.00') : withdraw(api, evaToken, F.M_EVA_BR_COBRADOR, acc, '400.00')));
    assert.equal(rs.filter((r) => r.status === 201).length, 5);
    assert.equal(rs.filter((r) => r.status === 422).length, 5);
    assert.equal(await balanceOf(db.superPool, acc), 0n);
    assert.equal(await movementsOf(acc), 5);
  });
});

test('MANAGED-FIN-002 [supabase-pg+api] idempotencia por operationId', { skip: SKIP }, async (t) => {
  await t.test('secuencial: el reintento devuelve el mismo resultado sin escribir', async () => {
    const acc = await newAccount(500000n);
    const op = randomUUID();
    const a = await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '1500.00', op);
    const b = await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '1500.00', op);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(b.body['replayed'], true);
    assert.equal(b.body['movementId'], a.body['movementId']);
    assert.equal(await movementsOf(acc), 1);
    assert.equal(await auditOf(acc), 1);
    assert.equal(await opsOf(op), 1);
    assert.equal(await balanceOf(db.superPool, acc), 350000n);
  });
  await t.test('rechazo de negocio conservado bajo el mismo operationId (comportamiento experimental)', async () => {
    const acc = await newAccount(100000n);
    const op = randomUUID();
    assert.equal((await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '2000.00', op)).status, 422);
    assert.equal((await deposit(api, anaToken, F.M_ANA_BR_ADMIN, acc, '5000.00')).status, 201);
    const again = await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '2000.00', op);
    assert.equal(again.status, 422);
    assert.equal(again.body['replayed'], true);
  });
  await t.test('concurrente: 5 copias simultáneas → un solo movimiento', async () => {
    const acc = await newAccount(500000n);
    const op = randomUUID();
    const rs = await Promise.all(Array.from({ length: 5 }, () => withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '100.00', op)));
    assert.ok(rs.every((r) => r.status === 201));
    assert.equal(new Set(rs.map((r) => r.body['movementId'])).size, 1);
    assert.equal(rs.filter((r) => r.body['replayed'] === true).length, 4);
    assert.equal(await movementsOf(acc), 1);
    assert.equal(await balanceOf(db.superPool, acc), 490000n);
  });
});

test('MANAGED-FIN-003 [supabase-pg+api] colisión: mismo operationId con otros parámetros → 409 sin efectos', { skip: SKIP }, async () => {
  const acc = await newAccount(500000n);
  const other = await newAccount(500000n);
  const op = randomUUID();
  assert.equal((await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '100.00', op)).status, 201);
  for (const r of [
    await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '200.00', op),
    await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, other, '100.00', op),
    await deposit(api, anaToken, F.M_ANA_BR_ADMIN, acc, '100.00', op),
    await withdraw(api, evaToken, F.M_EVA_BR_COBRADOR, acc, '100.00', op),
  ]) {
    assert.equal(r.status, 409);
    assert.equal(r.body['error'], 'IDEMPOTENCY_KEY_REUSED');
  }
  assert.equal(await balanceOf(db.superPool, acc), 490000n);
  assert.equal(await balanceOf(db.superPool, other), 500000n);
  assert.equal(await movementsOf(acc) + await movementsOf(other), 1);
});

test('MANAGED-FIN-004 [supabase-pg+api] rollback: fallo tras actualizar el saldo → nada queda escrito', { skip: SKIP }, async () => {
  const acc = await newAccount(500000n);
  const op = randomUUID();
  let inside: bigint | null = null;
  const failing = await startApi(db.apiPool, iss.verifier, {
    afterBalanceUpdate: async ({ client, accountId }) => {
      inside = BigInt((await client.query('select balance_minor::text b from adex.accounts where id = $1', [accountId])).rows[0].b);
      throw new Error('injected failure after balance update');
    },
  });
  try {
    const r = await withdraw(failing, anaToken, F.M_ANA_BR_ADMIN, acc, '1500.00', op);
    assert.equal(r.status, 500);
  } finally { await failing.close(); }
  assert.equal(inside, 350000n, 'dentro de la transacción el saldo sí había cambiado');
  assert.equal(await balanceOf(db.superPool, acc), 500000n);
  assert.equal(await movementsOf(acc), 0);
  assert.equal(await auditOf(acc), 0);
  assert.equal(await opsOf(op), 0);
  assert.equal((await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '1500.00', op)).status, 201, 'la clave no quedó consumida');
});

test('MANAGED-FIN-005 [supabase-pg+api] auditoría atómica: cada movimiento con una auditoría de la misma transacción', { skip: SKIP }, async (t) => {
  const r = await db.superPool.query<{ id: string; ok: boolean }>(
    `select m.id::text, (select count(*) from adex.audit_log a
                          where a.company_id = m.company_id and a.operation_id = m.operation_id and a.outcome = 'approved'
                            and a.txid = m.txid and a.membership_id = m.membership_id and a.identity_id = m.identity_id and a.role = m.role) = 1 as ok
       from adex.movements m where m.account_id = any($1)`, [runAccounts]);
  t.diagnostic(`movimientos comprobados: ${r.rowCount}`);
  assert.ok((r.rowCount ?? 0) >= 10);
  assert.deepEqual(r.rows.filter((x) => !x.ok), []);
  const sqlState = async (sql: string) => { try { await db.superPool.query(sql); return 'OK'; } catch (e) { return (e as { code?: string }).code; } };
  assert.equal(await sqlState('update adex.movements set amount_minor = amount_minor'), '42501', 'el administrador del proyecto tampoco reescribe el libro');
  assert.equal(await sqlState('delete from adex.audit_log'), '42501');
});

test('MANAGED-ID-001 [supabase-pg+api] DS-05: una identidad, varias membresías, sin herencia; membresía desactivada', { skip: SKIP }, async (t) => {
  await t.test('cada petición actúa con una sola membresía y sus permisos', async () => {
    const coAcc = await newAccount(500000n, F.COMPANY_CO, F.ROUTE_CO1);
    const brCompany = await newAccount(500000n, F.COMPANY_BR, null);
    assert.equal((await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, brCompany, '10.00')).status, 201, 'admin BR');
    assert.equal((await withdraw(api, anaToken, F.M_ANA_BR_COBRADOR, brCompany, '10.00')).status, 404, 'cobradora BR-1 no alcanza la caja de empresa');
    assert.equal((await withdraw(api, anaToken, F.M_ANA_CO_SUPERVISOR, coAcc, '10.00')).body['error'], 'PERMISSION_DENIED', 'supervisora CO no retira');
    assert.equal((await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, coAcc, '10.00')).status, 404, 'admin BR no alcanza CO');
    assert.equal(await balanceOf(db.superPool, coAcc), 500000n);
    const audit = await db.superPool.query(`select membership_id, role from adex.audit_log where entity_id = $1`, [brCompany]);
    assert.deepEqual(audit.rows, [{ membership_id: F.M_ANA_BR_ADMIN, role: 'admin' }], 'auditoría con la membresía y el rol exactos');
  });
  await t.test('membresía desactivada: el mismo token deja de operar, cero efectos', async () => {
    const acc = await newAccount(500000n);
    assert.equal((await withdraw(api, evaToken, F.M_EVA_BR_COBRADOR, acc, '10.00')).status, 201);
    await db.superPool.query(`update adex.memberships set status = 'inactive' where id = $1`, [F.M_EVA_BR_COBRADOR]);
    try {
      const r = await withdraw(api, evaToken, F.M_EVA_BR_COBRADOR, acc, '10.00');
      assert.equal(r.body['error'], 'MEMBERSHIP_INACTIVE');
      assert.equal(await balanceOf(db.superPool, acc), 499000n);
      assert.equal(await movementsOf(acc), 1);
      assert.equal(await auditOf(acc), 1);
    } finally {
      await db.superPool.query(`update adex.memberships set status = 'active' where id = $1`, [F.M_EVA_BR_COBRADOR]);
    }
  });
});
