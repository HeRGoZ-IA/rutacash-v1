// PUERTA DE LA FASE 0: aislamiento por empresa aplicado y privilegios controlados.
// Todo se ejecuta como `adex_api` (sin BYPASSRLS) sobre las 3 empresas sintéticas.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DEXIE_V16_TABLES } from '../../src/model/dexieV16.ts';
import { EXPECTED_API_WRITES } from '../../src/db/privileges.ts';
import { companyId, identityOf, membershipId, routeId } from '../../db/seeds/synthetic.ts';
import { asApi, count, createTestDb, type TestDb } from '../helpers/db.ts';


const OPERATIONAL = DEXIE_V16_TABLES.filter((t) => t.source === 'models' && t.sqlTable).map((t) => t.sqlTable!);
const ctx = {
  c1sa: { identityId: identityOf('bruno'), membershipId: membershipId('c1', 'bruno-sa'), companyId: companyId('c1') },
  c2sa: { identityId: identityOf('carla'), membershipId: membershipId('c2', 'carla-sa'), companyId: companyId('c2') },
  c3sa: { identityId: identityOf('diego'), membershipId: membershipId('c3', 'diego-sa'), companyId: companyId('c3') },
  anaCob: { identityId: identityOf('ana'), membershipId: membershipId('c1', 'ana-cob'), companyId: companyId('c1') },
  anaAdmin: { identityId: identityOf('ana'), membershipId: membershipId('c1', 'ana-admin'), companyId: companyId('c1') },
  anaSup: { identityId: identityOf('ana'), membershipId: membershipId('c2', 'ana-sup'), companyId: companyId('c2') },
};
const companyCol = (table: string) => (table === 'adex.companies' ? 'id' : 'company_id');

describe('Fase 0 · aislamiento por empresa y privilegios', () => {
  let db: TestDb;
  before(async () => { db = await createTestDb('tenancy', { seed: true }); });
  after(async () => { await db.close(); });

  test('TEN-001 · roles de aplicación sin superusuario, BYPASSRLS ni herencia; la Data API no puede asumirlos', async () => {
    const roles = (await db.admin.query(
      `select rolname, rolsuper, rolbypassrls, rolinherit, rolcanlogin from pg_roles where rolname in ('adex_owner', 'adex_api', 'adex_control') order by 1`)).rows;
    assert.equal(roles.length, 3);
    for (const r of roles) {
      assert.equal(r.rolsuper, false, r.rolname);
      assert.equal(r.rolbypassrls, false, r.rolname);
      assert.equal(r.rolinherit, false, r.rolname);
      assert.equal(r.rolcanlogin, r.rolname !== 'adex_owner', r.rolname);
    }
    for (const dataApi of ['anon', 'authenticated', 'service_role', 'authenticator']) {
      for (const target of ['adex_owner', 'adex_api', 'adex_control']) {
        const r = await db.admin.query('select pg_has_role($1, $2, $3) ok', [dataApi, target, 'MEMBER']);
        assert.equal(r.rows[0].ok, false, `${dataApi} → ${target}`);
      }
    }
    for (const app of ['adex_api', 'adex_control']) {
      assert.equal(await count(db.admin, `select 1 from pg_auth_members am join pg_roles r on r.oid = am.member where r.rolname = $1`, [app]), 0);
    }
  });

  test('TEN-002 · RLS habilitada y FORZADA en todas las tablas de adex y adex_control', async () => {
    const rows = (await db.admin.query(
      `select n.nspname || '.' || c.relname t, c.relrowsecurity rls, c.relforcerowsecurity force
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('adex', 'adex_control') and c.relkind = 'r'`)).rows;
    assert.ok(rows.length >= 29);
    for (const r of rows) assert.ok(r.rls && r.force, `${r.t} must enable and force RLS`);
  });

  test('TEN-003 · privilegios: sin TRUNCATE ni DELETE financiero; escrituras solo las del contrato; planos separados', async () => {
    // Privilegios de tabla Y de columna (un INSERT/UPDATE de columnas concretas no aparece en role_table_grants).
    const grants = (await db.admin.query(
      `select distinct grantee, t, p from (
         select grantee, table_schema || '.' || table_name t, privilege_type p, table_schema s from information_schema.role_table_grants
         union all
         select grantee, table_schema || '.' || table_name, privilege_type, table_schema from information_schema.column_privileges) g
        where s in ('adex', 'adex_control')
          and grantee in ('adex_api', 'adex_control', 'anon', 'authenticated', 'service_role', 'authenticator', 'PUBLIC')`)).rows;
    assert.deepEqual(grants.filter((g) => ['TRUNCATE', 'REFERENCES', 'TRIGGER'].includes(g.p)), []);
    // DELETE solo donde el contrato lo declara (asignación de rutas, nunca datos financieros).
    assert.deepEqual(grants.filter((g) => g.p === 'DELETE' && !(EXPECTED_API_WRITES[g.t] ?? []).includes('DELETE')), []);
    assert.deepEqual(grants.filter((g) => !['adex_api', 'adex_control'].includes(g.grantee)), [], 'Data API roles and PUBLIC have nothing');
    const apiWrites: Record<string, string[]> = {};
    for (const g of grants.filter((x) => x.grantee === 'adex_api' && x.p !== 'SELECT')) (apiWrites[g.t] ??= []).push(g.p);
    for (const k of Object.keys(apiWrites)) apiWrites[k]!.sort();
    assert.deepEqual(apiWrites, EXPECTED_API_WRITES);
    assert.deepEqual(grants.filter((g) => g.grantee === 'adex_api' && g.t.startsWith('adex_control.')), [], 'company API has nothing in the control plane');
    assert.deepEqual(grants.filter((g) => g.grantee === 'adex_control' && g.t.startsWith('adex.')), [], 'control plane has no table privilege on operations');
    const usage = (await db.admin.query(
      `select r, s, has_schema_privilege(r, s, 'USAGE') u from unnest(array['anon','authenticated','service_role','authenticator','adex_control']) r,
              unnest(array['adex']) s`)).rows;
    for (const u of usage) assert.equal(u.u, false, `${u.r} must not use schema ${u.s}`);
  });

  test('TEN-004 · cada SuperAdmin ve SOLO su empresa, en cada tabla operativa', async () => {
    for (const [key, c] of [['c1', ctx.c1sa], ['c2', ctx.c2sa], ['c3', ctx.c3sa]] as const) {
      await asApi(db.api, c, async (q) => {
        for (const table of OPERATIONAL) {
          const col = companyCol(table);
          const total = await count(db.admin, `select 1 from ${table} where ${col} = $1`, [companyId(key)]);
          const visible = await count(q, `select 1 from ${table}`);
          const foreign = await count(q, `select 1 from ${table} where ${col} <> $1`, [companyId(key)]);
          assert.equal(foreign, 0, `${key} sees foreign rows in ${table}`);
          if (table === 'adex.memberships') continue; // ve además sus propias membresías (todas de su empresa aquí)
          assert.equal(visible, total, `${key} must see all its rows in ${table}`);
        }
      });
    }
  });

  test('TEN-005 · sin contexto, o con contexto falsificado, no se ve ninguna fila', async () => {
    const forged = [
      {},
      { identityId: ctx.c1sa.identityId, membershipId: ctx.c1sa.membershipId, companyId: companyId('c2') },
      { identityId: identityOf('elisa'), membershipId: ctx.c1sa.membershipId, companyId: companyId('c1') },
      { identityId: ctx.c1sa.identityId, companyId: companyId('c1') },
      { membershipId: ctx.c1sa.membershipId, companyId: companyId('c1') },
    ];
    for (const f of forged) {
      await asApi(db.api, f, async (q) => {
        for (const table of OPERATIONAL) {
          if (table === 'adex.memberships' || table === 'adex.companies') continue; // las suyas (selector): ver TEN-009
          assert.equal(await count(q, `select 1 from ${table}`), 0, `${JSON.stringify(f)} sees ${table}`);
        }
        for (const t of ['adex_control.company_control', 'adex_control.platform_operators']) {
          await assert.rejects(q.query('savepoint s; select 1 from ' + t), { code: '42501' });
          await q.query('rollback to savepoint s');
        }
      });
    }
  });

  test('TEN-006 · alcance por rutas: la cobradora ve solo su ruta y nada sin ruta', async () => {
    await asApi(db.api, ctx.anaCob, async (q) => {
      assert.deepEqual((await q.query('select id from adex.routes')).rows.map((r) => r.id), [routeId('c1', 1)]);
      for (const table of ['adex.clients', 'adex.sales', 'adex.payments', 'adex.expenses', 'adex.cash_custody_movements', 'adex.capital_ledger']) {
        assert.equal(await count(q, `select 1 from ${table} where route_id is distinct from $1`, [routeId('c1', 1)]), 0, table);
      }
      assert.ok(await count(q, 'select 1 from adex.payments') > 0);
      assert.equal(await count(q, 'select 1 from adex.partner_cash_movements'), 0, 'Caja socios: solo SuperAdmin (fase 0)');
      assert.equal(await count(q, 'select 1 from adex.identities where id <> $1', [identityOf('ana')]), 0, 'cobradora no ve correos ajenos');
    });
  });

  test('TEN-007 · DS-05: la misma persona, con otra membresía, ve otra cosa; nunca la suma', async () => {
    const seen = async (c: typeof ctx.anaCob) => asApi(db.api, c, async (q) => (await q.query('select id from adex.routes order by id')).rows.map((r) => r.id));
    assert.deepEqual(await seen(ctx.anaCob), [routeId('c1', 1)]);
    assert.deepEqual(await seen(ctx.anaAdmin), [routeId('c1', 1), routeId('c1', 2)].sort());
    assert.deepEqual(await seen(ctx.anaSup), [routeId('c2', 1)]);
    await asApi(db.api, ctx.anaSup, async (q) => {
      assert.equal(await count(q, 'select 1 from adex.sales where company_id = $1', [companyId('c1')]), 0);
    });
  });

  test('TEN-008 · la API no escribe datos operativos (Fase 0 solo lectura)', async () => {
    await asApi(db.api, ctx.c1sa, async (q) => {
      for (const sql of [
        `insert into adex.expense_categories (id, company_id, name, active) values ('x', '${companyId('c1')}', 'x', true)`,
        `update adex.sales set balance_minor = 0`,
        `delete from adex.payments`,
      ]) {
        await q.query('savepoint s');
        await assert.rejects(q.query(sql), { code: '42501' }, sql);
        await q.query('rollback to savepoint s');
      }
    });
  });

  test('TEN-009 · membresía inactiva, identidad desactivada, empresa suspendida o vencida → nada', async () => {
    const before = await asApi(db.api, ctx.c1sa, (q) => count(q, 'select 1 from adex.sales'));
    assert.ok(before > 0);
    const cases: [string, string][] = [
      [`update adex.memberships set status = 'inactivo' where id = '${ctx.c1sa.membershipId}'`, `update adex.memberships set status = 'activo' where id = '${ctx.c1sa.membershipId}'`],
      [`update adex.identities set status = 'disabled' where id = '${ctx.c1sa.identityId}'`, `update adex.identities set status = 'active' where id = '${ctx.c1sa.identityId}'`],
      [`update adex.companies set status = 'suspendida' where id = '${companyId('c1')}'`, `update adex.companies set status = 'activa' where id = '${companyId('c1')}'`],
      [`update adex.companies set expires_on = current_date - 2 where id = '${companyId('c1')}'`, `update adex.companies set expires_on = '2027-12-31' where id = '${companyId('c1')}'`],
    ];
    for (const [i, [off, on]] of cases.entries()) {
      await db.admin.query(off);
      assert.equal(await asApi(db.api, ctx.c1sa, (q) => count(q, 'select 1 from adex.sales')), 0, off);
      // Selector: membresía inactiva o identidad desactivada → la empresa desaparece. Empresa
      // suspendida o vencida → sus miembros siguen viendo su NOMBRE (para el aviso «Servicio
      // suspendido», como CLEAN), pero ningún dato operativo.
      assert.equal(await asApi(db.api, ctx.c1sa, (q) => count(q, 'select 1 from adex.companies')), i < 2 ? 0 : 1, `${off} (selector)`);
      await db.admin.query(on);
      assert.equal(await asApi(db.api, ctx.c1sa, (q) => count(q, 'select 1 from adex.sales')), before, on);
    }
  });

  test('TEN-010 · el selector: una identidad ve SUS membresías de todas sus empresas y nada más', async () => {
    await asApi(db.api, { identityId: identityOf('ana') }, async (q) => {
      const mine = (await q.query('select id, company_id, role from adex.memberships order by role')).rows;
      assert.deepEqual(mine.map((m) => m.role).sort(), ['admin', 'cobrador', 'supervisor']);
      const companies = (await q.query('select id from adex.companies order by id')).rows.map((r) => r.id);
      assert.deepEqual(companies, [companyId('c1'), companyId('c2')].sort());
      assert.equal(await count(q, 'select 1 from adex.sales'), 0, 'sin membresía elegida no hay datos operativos');
    });
  });
});
