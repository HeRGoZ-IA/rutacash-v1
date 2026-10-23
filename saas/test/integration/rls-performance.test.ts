// RONDA 33 · 0020: el contexto RLS se evalúa una vez por consulta. Misma regla, otro coste.
//   PERF-SQL-001  visibilidad IDÉNTICA (filas y contenido) con las políticas anteriores y con
//                 0020, para todas las membresías de dos empresas y contextos falsificados;
//                 la reversión y la reaplicación funcionan.
//   PERF-SQL-002  las políticas SELECT de adex_api no llaman a funciones de contexto por fila.
//   PERF-SQL-003  marcador de cambios: aislado por empresa, nulo sin membresía activa.
//   PERF-SQL-004  semanas cerradas del alcance = `payment_in_closed_period` cobro a cobro.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf } from '../../db/seeds/synthetic.ts';
import { asApi, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller } from '../helpers/phase2.ts';
import { money } from '../helpers/phase3.ts';

const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'db');
const MIGRATION = readFileSync(path.join(dbDir, 'migrations', '0020_rls_context_once.sql'), 'utf8');
const ROLLBACK = readFileSync(path.join(dbDir, 'rollback', '0020_rls_context_once.down.sql'), 'utf8');

interface Ctx { identityId: string; membershipId: string; companyId: string; sessionId?: string }
const REVOKED = '33333333-3333-4333-8333-333333333333';

describe('Ronda 33 · RLS con contexto evaluado una vez (0020)', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const c2 = companyId('c2');
  let tables: string[] = [];
  let contexts: { label: string; ctx: Ctx }[] = [];

  /** Huella de lo que ve cada contexto en cada tabla con política SELECT de adex_api. */
  async function visibility(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const { label, ctx } of contexts) {
      await asApi(db.api, ctx, async (q) => {
        for (const t of tables) {
          const r = (await q.query(`select count(*)::int n, coalesce(string_agg(x::text, ',' order by x::text), '') s from adex.${t} x`)).rows[0];
          out[`${label}:${t}`] = `${r.n}:${createHash('sha256').update(r.s).digest('hex')}`;
        }
      });
    }
    return out;
  }
  // Ronda 53 (0023): Caja socios ya no existe; su política se omite al revertir y reaplicar 0020.
  const withoutPartnerCash = (sql: string) => sql.replace(/alter policy partner_cash_movements_ctx[\s\S]*?;\n/g, '');
  async function asOwner(sql: string): Promise<void> {
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local role adex_owner');
      await c.query(sql);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally { c.release(); }
  }

  before(async () => {
    db = await createTestDb('rlsperf', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    // Algo de libro de capital en c1 (las políticas de capital también se comparan).
    const $bruno = money(caller(api, issuer, 'bruno', M.brunoSa));
    for (const [p, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 1_000_000, reason: 'Bolsa de Ana' }],
    ] as const) assert.equal((await $bruno(p, body)).status, 201, p);
    tables = (await db.admin.query(`select distinct tablename t from pg_policies where schemaname = 'adex' and cmd = 'SELECT'
                                     and 'adex_api' = any(roles) order by 1`)).rows.map((r) => r.t as string);
    const members = (await db.admin.query(`select id, identity_id, company_id, role, status from adex.memberships
                                            where company_id in ($1, $2) order by id`, [c1, c2])).rows;
    contexts = members.map((m) => ({ label: `${m.role}/${m.status}/${m.id}`, ctx: { identityId: m.identity_id, membershipId: m.id, companyId: m.company_id } }));
    // Contextos falsificados: deben ver lo mismo (nada) antes y después.
    contexts.push(
      { label: 'sa-c1-en-c2', ctx: { identityId: identityOf('bruno'), membershipId: M.brunoSa, companyId: c2 } },
      { label: 'membresía-ajena', ctx: { identityId: identityOf('bruno'), membershipId: M.carlaSa, companyId: c2 } },
      { label: 'sin-contexto', ctx: { identityId: '', membershipId: '', companyId: c1 } },
      { label: 'identidad-ajena-misma-empresa', ctx: { identityId: identityOf('carla'), membershipId: M.brunoSa, companyId: c1 } },
      { label: 'cobrador-desactivado', ctx: { identityId: identityOf('ana'), membershipId: M.anaCob, companyId: c1 } },
      { label: 'sesion-revocada', ctx: { identityId: identityOf('fabio'), membershipId: M.fabioSec, companyId: c1, sessionId: REVOKED } },
    );
    // Membresía con identidad desactivada y sesión revocada (deben ver lo mismo: nada).
    await db.admin.query(`update adex.memberships set status = 'inactivo' where id = $1`, [M.anaCob]);
    await db.admin.query(`insert into adex.revoked_sessions (session_id, identity_id, revoked_at, reason) values ($1, $2, now(), 'security')`, [REVOKED, identityOf('fabio')]);
  });
  after(async () => { await api.close(); await db.close(); });

  test('PERF-SQL-001 · misma visibilidad que las políticas anteriores (todas las membresías de dos empresas); reversión y reaplicación', async () => {
    assert.ok(tables.length >= 30, `tablas con política SELECT: ${tables.length}`);
    assert.ok(contexts.length >= 12, `contextos: ${contexts.length}`);
    const roles = new Set(contexts.map((c) => c.label.split('/')[0]));
    for (const r of ['superadmin', 'admin', 'cobrador', 'secretario']) assert.ok(roles.has(r), `rol ${r} presente`);
    const withMigration = await visibility();
    // Hay datos de verdad que comparar (no huellas de tablas vacías).
    for (const t of ['payments', 'sales', 'clients', 'capital_operations', 'audit_log']) {
      const visible = Object.entries(withMigration).filter(([k, v]) => k.endsWith(`:${t}`) && !v.startsWith('0:')).length;
      assert.ok(visible > 0, `${t}: algún contexto ve filas`);
    }
    // Contextos ilegítimos: ninguna fila financiera ni operativa (con 0020).
    const illegit = ['sa-c1-en-c2', 'membresía-ajena', 'sin-contexto', 'identidad-ajena-misma-empresa', 'cobrador-desactivado', 'sesion-revocada'];
    for (const l of illegit) for (const t of ['payments', 'sales', 'installments', 'clients', 'expenses', 'capital_operations', 'capital_accounts', 'routes', 'audit_log']) {
      assert.ok(withMigration[`${l}:${t}`]?.startsWith('0:'), `${l} no ve ${t}`);
    }
    // Ronda 67: las políticas de lectura de 0029 (mapa) usan las funciones de contexto de 0020 y 0028 reconoce al SuperAdmin
    // la lectura de solicitudes. Para revertir 0020 se retiran antes esas políticas posteriores (esta base de prueba se
    // descarta) y no se comparan las tablas que 0028/0029 cambiaron a propósito.
    // Ronda 73: igual con la lectura del historial de rectificaciones (0030).
    await asOwner(['client_locations', 'sale_locations', 'payment_locations'].map((t) => `drop policy ${t}_read on adex.${t};`).join(' ')
      + ' drop policy credit_rectifications_ctx on adex.credit_rectifications;'
      + ' drop policy credit_rectification_cases_ctx on adex.credit_rectification_cases; drop policy credit_rectification_cases_insert on adex.credit_rectification_cases;'
      // R74 Base por Ruta (0034): actas de entrega, activaciones y la lectura ampliada de cuentas/operaciones de la ruta.
      + ' drop policy route_handover_records_ctx on adex.route_handover_records; drop policy capital_model_activations_ctx on adex.capital_model_activations;'
      + ' drop policy capital_accounts_route_ctx on adex.capital_accounts; drop policy capital_operations_route_base_ctx on adex.capital_operations;');
    const LATER = [':client_locations', ':sale_locations', ':payment_locations', ':credit_rectifications', ':credit_rectification_cases',
      ':route_handover_records', ':capital_model_activations'];
    // 0034 amplía a propósito lo que el Administrador y el Supervisor ven de las cuentas de SUS rutas (cartera, interés,
    // gastos, control, Base) y, con ellas, sus patas: no se comparan esas lecturas.
    const route034 = (k: string) => (k.startsWith('admin/') || k.startsWith('supervisor/')) && (k.endsWith(':capital_accounts') || k.endsWith(':capital_entries'));
    const changedLater = (k: string) => LATER.some((t) => k.endsWith(t)) || (k.endsWith(':sale_requests') && k.startsWith('superadmin/')) || route034(k);
    await asOwner(withoutPartnerCash(ROLLBACK).replace(/^(begin|commit|set local role adex_owner);$/gm, ''));
    const previous = await visibility();
    const policies = (await db.admin.query(`select count(*)::int n from pg_policies where schemaname = 'adex' and qual like '%route_in_scope%'`)).rows[0].n;
    assert.equal(policies, 0, 'la reversión restaura las políticas anteriores');
    await asOwner(withoutPartnerCash(MIGRATION));
    const again = await visibility();
    const diff = Object.keys(previous).filter((k) => !changedLater(k) && (previous[k] !== withMigration[k] || previous[k] !== again[k]));
    assert.deepEqual(diff, [], 'ninguna diferencia de filas ni de contenido');
  });

  test('PERF-SQL-002 · las políticas SELECT de adex_api no llaman a funciones de contexto por fila', async () => {
    const rows = (await db.admin.query(`select tablename, policyname, qual from pg_policies where schemaname = 'adex' and cmd = 'SELECT' and 'adex_api' = any(roles)`)).rows;
    const perRow = rows.filter((p) => /adex\.ctx_route_allowed\(/.test(p.qual ?? '')
      || /(?<!SELECT )adex\.ctx_(membership_active|role|is|can)\(/.test(p.qual ?? ''));
    assert.deepEqual(perRow.map((p) => `${p.tablename}.${p.policyname}`), []);
    // El plan del listado de cobros: el alcance es un InitPlan; `route_in_scope` queda expandida.
    const plan = await asApi(db.api, { identityId: identityOf('ana'), membershipId: M.anaAdmin, companyId: c1 }, async (q) =>
      (await q.query(`explain select * from adex.payments where company_id = $1 order by created_at desc limit 10`, [c1])).rows.map((r) => r['QUERY PLAN']).join('\n'));
    assert.match(plan, /InitPlan/);
    assert.doesNotMatch(plan, /ctx_route_allowed|route_in_scope/);
    // Funciones nuevas: SECURITY DEFINER con search_path fijo (salvo la expresión pura) y solo adex_api.
    const fns = (await db.admin.query(`select p.proname, p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) owner,
        array(select coalesce(nullif(pg_get_userbyid(a.grantee), ''), 'PUBLIC') from aclexplode(p.proacl) a where a.privilege_type = 'EXECUTE' order by 1)::text[] exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'adex' and p.proname in ('ctx_routes_all', 'ctx_route_ids', 'route_in_scope', 'ctx_closed_weeks', 'ctx_change_marker')`)).rows;
    assert.equal(fns.length, 5);
    for (const f of fns) {
      assert.deepEqual([...f.exec].filter((g: string) => g !== f.owner), ['adex_api'], f.proname);
      if (f.proname === 'route_in_scope') { assert.equal(f.prosecdef, false); assert.equal(f.provolatile, 'i'); continue; }
      assert.equal(f.prosecdef, true, f.proname);
      assert.equal(f.provolatile, 's', f.proname);
      assert.deepEqual(f.proconfig, ['search_path=pg_catalog, adex'], f.proname);
    }
  });

  test('PERF-SQL-003 · marcador de cambios: cambia con la actividad de SU empresa, nunca con la de otra; nulo sin membresía activa', async () => {
    const marker = (ctx: Ctx) => asApi(db.api, ctx, async (q) => (await q.query('select adex.ctx_change_marker() m')).rows[0].m as string | null);
    const bruno = { identityId: identityOf('bruno'), membershipId: M.brunoSa, companyId: c1 };
    const carla = { identityId: identityOf('carla'), membershipId: M.carlaSa, companyId: c2 };
    const ana = { identityId: identityOf('ana'), membershipId: M.anaAdmin, companyId: c1 };
    const [b0, c0, a0] = [await marker(bruno), await marker(carla), await marker(ana)];
    assert.match(b0 ?? '', /^[0-9a-f]{32}$/);
    assert.equal(a0, b0, 'misma empresa, misma huella para cualquier rol');
    assert.notEqual(c0, b0);
    assert.equal(await marker({ identityId: identityOf('bruno'), membershipId: M.brunoSa, companyId: c2 }), null, 'empresa ajena');
    assert.equal(await marker({ identityId: identityOf('bruno'), membershipId: M.carlaSa, companyId: c2 }), null, 'membresía ajena');
    assert.equal(await marker({ identityId: '', membershipId: '', companyId: c1 }), null, 'sin contexto');
    const $bruno = money(caller(api, issuer, 'bruno', M.brunoSa));
    assert.equal((await $bruno('/v1/capital/company/deposits', { amountMinor: 1_000, reason: 'Movimiento para el marcador' })).status, 201);
    assert.notEqual(await marker(bruno), b0, 'c1 cambió');
    assert.equal(await marker(carla), c0, 'c2 no se entera de la actividad de c1');
    // Por la API: cualquier membresía activa lo consulta.
    const r = await caller(api, issuer, 'ana', M.anaAdmin)('GET', '/v1/changes');
    assert.equal(r.status, 200);
    assert.equal(r.body['marker'], await marker(ana));
  });

  test('PERF-SQL-004 · semanas cerradas del alcance: misma respuesta que payment_in_closed_period para cada cobro visible', async () => {
    // Semana cerrada sembrada sobre cobros reales de c1, para comparar «sí» y «no».
    const p = (await db.admin.query(`select route_id, payment_date::text d from adex.payments where company_id = $1 order by payment_date limit 1`, [c1])).rows[0];
    assert.ok(p, 'hay cobros en c1');
    await db.admin.query(`insert into adex.weekly_settlements (id, company_id, route_id, week_start, week_end, opening_balance_minor, capital_in_minor,
        collections_minor, loans_disbursed_minor, expenses_minor, transfers_in_minor, transfers_out_minor, withdrawals_minor, closing_balance_minor, created_at, status)
      values ('r33-closed-week', $1, $2, $3::date - 3, $3::date + 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, now(), 'cerrada')`, [c1, p.route_id, p.d]);
    let closedSeen = 0;
    for (const { label, ctx } of contexts) {
      const r = await asApi(db.api, ctx, async (q) => (await q.query(`with closed as materialized (select * from adex.ctx_closed_weeks())
          select count(*) filter (where a <> b)::int diff, count(*) filter (where a)::int closed, count(*)::int n from (
            select coalesce(adex.payment_in_closed_period(x.id), false) a,
                   exists (select 1 from closed w where w.route_id = x.route_id::text and x.payment_date between w.week_start and w.week_end) b
              from adex.payments x) z`)).rows[0]);
      assert.equal(r.diff, 0, label);
      closedSeen += r.closed;
    }
    assert.ok(closedSeen > 0, 'la semilla tiene cobros en semanas cerradas (se comparan «sí» y «no»)');
    // Ninguna semana cerrada de otra empresa aparece en el alcance.
    const foreign = await asApi(db.api, { identityId: identityOf('carla'), membershipId: M.carlaSa, companyId: c2 }, async (q) =>
      (await q.query(`select count(*)::int n from adex.ctx_closed_weeks() w join adex.routes r on r.id = w.route_id where r.company_id <> $1`, [c2])).rows[0].n);
    assert.equal(foreign, 0);
    // El listado de cobros de la API devuelve `periodClosed` igual que la consulta individual.
    const ana = caller(api, issuer, 'ana', M.anaAdmin);
    const list = (await ana('GET', '/v1/collections?limit=50')).body['collections'] as Record<string, unknown>[];
    assert.ok(list.length > 0);
    for (const c of list.slice(0, 10)) {
      const one = (await ana('GET', `/v1/collections/${c['id']}`)).body['payment'] as Record<string, unknown>;
      assert.equal(c['periodClosed'], one['periodClosed'], String(c['id']));
    }
  });
});
