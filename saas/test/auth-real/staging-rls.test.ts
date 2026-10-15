// FASE 1 · RLS, privilegios mínimos y aislamiento multiempresa en el PostgreSQL
// GESTIONADO de ADEX-Staging (las mismas puertas que TEN-001…009 en local). Se ejecuta
// SOLO con `node scripts/staging.ts --test`; sin esas variables queda SKIPPED con el
// motivo: BLOQUEADA / NO EJECUTADA. `adex_api` entra por el pooler de transacciones.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from '../../src/db/pgTypes.ts';
import { readMigrations } from '../../src/db/migrate.ts';
import { DEXIE_V16_TABLES } from '../../src/model/dexieV16.ts';
import { EXPECTED_API_WRITES } from '../../src/db/privileges.ts';
import { companyId, identityOf, membershipId, routeId, type PEOPLE } from '../../db/seeds/synthetic.ts';
import { asApi, count } from '../helpers/db.ts';

const env = process.env;
const ready = Boolean(env['ADEX_STAGING_API_URL'] && env['ADEX_STAGING_ADMIN_URL']);
const SKIP = ready ? false : 'BLOQUEADA / NO EJECUTADA: requiere ADEX-Staging (node scripts/staging.ts --test)';

const OPERATIONAL = DEXIE_V16_TABLES.filter((t) => t.source === 'models' && t.sqlTable).map((t) => t.sqlTable!);
const companyCol = (table: string) => (table === 'adex.companies' ? 'id' : 'company_id');
const sa = (c: 'c1' | 'c2' | 'c3', who: (typeof PEOPLE)[number]) => ({ identityId: identityOf(who), membershipId: membershipId(c, `${who}-sa`), companyId: companyId(c) });
const ctx = {
  c1: sa('c1', 'bruno'), c2: sa('c2', 'carla'), c3: sa('c3', 'diego'),
  anaCob: { identityId: identityOf('ana'), membershipId: membershipId('c1', 'ana-cob'), companyId: companyId('c1') },
  anaSup: { identityId: identityOf('ana'), membershipId: membershipId('c2', 'ana-sup'), companyId: companyId('c2') },
};

describe('Fase 1 · RLS y aislamiento en PostgreSQL gestionado (ADEX-Staging)', { skip: SKIP }, () => {
  let admin: pg.Pool;
  let api: pg.Pool;
  before(() => {
    const ssl = { rejectUnauthorized: false };
    admin = new pg.Pool({ connectionString: env['ADEX_STAGING_ADMIN_URL'], ssl, max: 2 });
    api = new pg.Pool({ connectionString: env['ADEX_STAGING_API_URL'], ssl, max: 3 });
    // Una conexión inactiva que el pooler o la red cortan emite 'error' en el pool: sin
    // escucha, el proceso de la prueba muere sin rastro. Se registra; las consultas
    // afectadas siguen fallando por su cuenta.
    for (const [name, pool] of [['admin', admin], ['api', api]] as const) pool.on('error', (e) => console.error(`[pool ${name}]`, e.message));
  });
  after(async () => { await api?.end(); await admin?.end(); });

  test('STG-RLS-001 · todas las migraciones versionadas (0001…0007 desde la Fase 2), con la huella del repositorio', async () => {
    const applied = (await admin.query('select version, name, checksum from adex_meta.schema_migrations order by version')).rows;
    assert.deepEqual(applied.map((r) => ({ version: r.version, name: r.name, checksum: r.checksum })),
      readMigrations().map((m) => ({ version: m.version, name: m.name, checksum: m.checksum })));
    assert.equal(applied.length, readMigrations().length);
    assert.ok(applied.length >= 7);
  });

  test('STG-RLS-002 · roles sin superusuario/BYPASSRLS/herencia; la Data API no puede asumirlos', async () => {
    const roles = (await admin.query(
      `select rolname, rolsuper, rolbypassrls, rolinherit, rolcanlogin from pg_roles where rolname in ('adex_owner', 'adex_api', 'adex_control')`)).rows;
    assert.equal(roles.length, 3);
    for (const r of roles) {
      assert.equal(r.rolsuper || r.rolbypassrls || r.rolinherit, false, r.rolname);
      assert.equal(r.rolcanlogin, r.rolname !== 'adex_owner', r.rolname);
    }
    for (const dataApi of ['anon', 'authenticated', 'service_role', 'authenticator']) {
      for (const target of ['adex_owner', 'adex_api', 'adex_control']) {
        assert.equal((await admin.query('select pg_has_role($1, $2, $3) ok', [dataApi, target, 'MEMBER'])).rows[0].ok, false, `${dataApi} → ${target}`);
      }
    }
    const who = (await api.query('select current_user u, (select rolbypassrls from pg_roles where rolname = current_user) b')).rows[0];
    assert.deepEqual({ u: who.u, b: who.b }, { u: 'adex_api', b: false });
  });

  test('STG-RLS-003 · RLS habilitada y forzada en todas las tablas; privilegios exactamente los del contrato', async () => {
    const rows = (await admin.query(
      `select n.nspname || '.' || c.relname t, c.relrowsecurity rls, c.relforcerowsecurity force
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('adex', 'adex_control') and c.relkind = 'r'`)).rows;
    assert.ok(rows.length >= 29);
    for (const r of rows) assert.ok(r.rls && r.force, `${r.t} must enable and force RLS`);
    const grants = (await admin.query(
      `select distinct grantee, t, p from (
         select grantee, table_schema || '.' || table_name t, privilege_type p, table_schema s from information_schema.role_table_grants
         union all
         select grantee, table_schema || '.' || table_name, privilege_type, table_schema from information_schema.column_privileges) g
        where s in ('adex', 'adex_control')
          and grantee in ('adex_api', 'adex_control', 'anon', 'authenticated', 'service_role', 'authenticator', 'PUBLIC')`)).rows;
    assert.deepEqual(grants.filter((g) => !['adex_api', 'adex_control'].includes(g.grantee)), [], 'Data API roles and PUBLIC have nothing');
    assert.deepEqual(grants.filter((g) => ['TRUNCATE', 'REFERENCES', 'TRIGGER'].includes(g.p)), []);
    const apiWrites: Record<string, string[]> = {};
    for (const g of grants.filter((x) => x.grantee === 'adex_api' && x.p !== 'SELECT')) (apiWrites[g.t] ??= []).push(g.p);
    for (const k of Object.keys(apiWrites)) apiWrites[k]!.sort();
    assert.deepEqual(apiWrites, EXPECTED_API_WRITES);
    assert.deepEqual(grants.filter((g) => g.grantee === 'adex_api' && g.t.startsWith('adex_control.')), []);
    assert.deepEqual(grants.filter((g) => g.grantee === 'adex_control' && g.t.startsWith('adex.')), []);
    for (const r of ['anon', 'authenticated', 'service_role', 'authenticator']) {
      for (const s of ['adex', 'adex_control', 'adex_meta']) {
        assert.equal((await admin.query(`select has_schema_privilege($1, $2, 'USAGE') u`, [r, s])).rows[0].u, false, `${r} uses ${s}`);
      }
    }
  });

  test('STG-RLS-004 · cada SuperAdmin ve SOLO su empresa, en cada tabla operativa', async () => {
    for (const [key, c] of [['c1', ctx.c1], ['c2', ctx.c2], ['c3', ctx.c3]] as const) {
      await asApi(api, c, async (q) => {
        for (const table of OPERATIONAL) {
          const col = companyCol(table);
          assert.equal(await count(q, `select 1 from ${table} where ${col} <> $1`, [companyId(key)]), 0, `${key} sees foreign rows in ${table}`);
          if (table === 'adex.memberships') continue;
          assert.equal(await count(q, `select 1 from ${table}`), await count(admin, `select 1 from ${table} where ${col} = $1`, [companyId(key)]), `${key} · ${table}`);
        }
      });
    }
  });

  test('STG-RLS-005 · sin contexto o con contexto falsificado no se ve nada; el plano Owner está cerrado', async () => {
    const forged = [
      {},
      { identityId: ctx.c1.identityId, membershipId: ctx.c1.membershipId, companyId: companyId('c2') },
      { identityId: identityOf('elisa'), membershipId: ctx.c1.membershipId, companyId: companyId('c1') },
      { identityId: ctx.c1.identityId, companyId: companyId('c1') },
    ];
    for (const f of forged) {
      await asApi(api, f, async (q) => {
        for (const table of OPERATIONAL) {
          if (table === 'adex.memberships' || table === 'adex.companies') continue;
          assert.equal(await count(q, `select 1 from ${table}`), 0, `${JSON.stringify(f)} sees ${table}`);
        }
        await q.query('savepoint s');
        await assert.rejects(q.query('select 1 from adex_control.company_control'), { code: '42501' });
        await q.query('rollback to savepoint s');
      });
    }
  });

  test('STG-RLS-006 · DS-05: la misma persona con otra membresía ve otra empresa, nunca la suma', async () => {
    const routes = (c: typeof ctx.anaCob) => asApi(api, c, async (q) => (await q.query('select id from adex.routes order by id')).rows.map((r) => r.id));
    assert.deepEqual(await routes(ctx.anaCob), [routeId('c1', 1)]);
    assert.deepEqual(await routes(ctx.anaSup), [routeId('c2', 1)]);
    await asApi(api, ctx.anaSup, async (q) => assert.equal(await count(q, 'select 1 from adex.sales where company_id = $1', [companyId('c1')]), 0));
  });

  test('STG-RLS-007 · membresía desactivada → sin datos al instante; reactivada → vuelve', async () => {
    const sales = () => asApi(api, ctx.c3, (q) => count(q, 'select 1 from adex.sales'));
    const before = await sales();
    assert.ok(before > 0);
    try {
      await admin.query(`update adex.memberships set status = 'inactivo' where id = $1`, [ctx.c3.membershipId]);
      assert.equal(await sales(), 0);
    } finally {
      await admin.query(`update adex.memberships set status = 'activo' where id = $1`, [ctx.c3.membershipId]);
    }
    assert.equal(await sales(), before);
  });
});
