// FASE 2 · puerta del plan: `withCapitalControllerGuard` como RESTRICCIÓN
// TRANSACCIONAL. Capital por Administrador v16: el responsable de capital de una ruta
// es NULL o un Administrador activo asignado; se fija (primer Admin), se protege (no
// se retira sin elegir otro), se cambia con traspaso y se libera, en la misma
// transacción que la causa. PostgreSQL lo vuelve a comprobar al COMMIT.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from '../../src/db/pgTypes.ts';
import { companyId, membershipId, routeId } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';

/** Capital colocado por `admin` en `route`, con una fórmula SQL independiente de CLEAN. */
async function placement(q: pg.Pool, company: string, route: string, admin: string | null): Promise<number> {
  const r = await q.query<{ v: string }>(
    `select (coalesce((select sum(amount_minor) from adex.capital_movements where company_id = $1 and route_id = $2 and admin_membership_id is not distinct from $3), 0)
           - coalesce((select sum(amount_minor) from adex.withdrawals where company_id = $1 and route_id = $2 and admin_membership_id is not distinct from $3), 0)
           + coalesce((select sum(amount_minor) from adex.transfers where company_id = $1 and admin_membership_id is not distinct from $3
                         and coalesce(origin_type, 'route') = 'route' and coalesce(destination_type, 'route') = 'route'
                         and route_origin_id is not null and route_destination_id = $2), 0)
           - coalesce((select sum(amount_minor) from adex.transfers where company_id = $1 and admin_membership_id is not distinct from $3
                         and coalesce(origin_type, 'route') = 'route' and coalesce(destination_type, 'route') = 'route'
                         and route_destination_id is not null and route_origin_id = $2), 0)
           + case when $3::text is null
               then - coalesce((select sum(amount_minor) from adex.capital_ledger where company_id = $1 and route_id = $2 and kind = 'ROUTE_CONTROL_TRANSFER' and to_admin_membership_id is not null), 0)
                    + coalesce((select sum(amount_minor) from adex.capital_ledger where company_id = $1 and route_id = $2 and kind = 'ROUTE_CONTROL_TRANSFER' and from_admin_membership_id is not null), 0)
               else coalesce((select sum(amount_minor) from adex.capital_ledger where company_id = $1 and route_id = $2 and kind = 'ROUTE_CONTROL_TRANSFER' and to_admin_membership_id = $3), 0)
                  - coalesce((select sum(amount_minor) from adex.capital_ledger where company_id = $1 and route_id = $2 and kind = 'ROUTE_CONTROL_TRANSFER' and from_admin_membership_id = $3), 0)
             end)::text v`, [company, route, admin]);
  return Number(r.rows[0]!.v);
}

describe('Fase 2 · responsable de capital (v16) como restricción transaccional', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  let bruno: Caller, ana: Caller, diego: Caller;
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  before(async () => {
    db = await createTestDb('capitalguard', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, createMemoryProvider());
    bruno = caller(api, issuer, 'bruno', M.brunoSa);
    ana = caller(api, issuer, 'ana', M.anaAdmin);
    diego = caller(api, issuer, 'diego', M.diegoSa);
  });
  after(async () => { await api.close(); await db.close(); });

  const controllerOf = async (route: string) => (await db.admin.query('select capital_controller_membership_id c from adex.routes where id = $1', [route])).rows[0].c as string | null;

  test('CAP-001 · primer Administrador: asignarlo a una ruta sin responsable lo hace responsable en la misma transacción', async () => {
    const route = (await bruno('POST', '/v1/routes', { name: 'Sin responsable', interestRate: 20, freeRate: false, maxLoanMinor: 1000 })).body['id'] as string;
    const x = (await bruno('POST', '/v1/members', { email: 'admin-x@example.test', role: 'admin', displayName: 'Admin X' })).body['membershipId'] as string;
    const r = await bruno('PUT', `/v1/members/${x}/routes`, { routeIds: [route] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((r.body['controllerEvents'] as { kind: string; toMembershipId: string }[]).map((e) => [e.kind, e.toMembershipId]), [['FIRST_ADMIN', x]]);
    assert.equal(await controllerOf(route), x);
    const audit = await db.admin.query(`select route_id, actor_role, txid is not null t from adex.audit_log where action = 'ROUTE_CAPITAL_CONTROLLER_CHANGED' and entity_id = $1`, [route]);
    assert.deepEqual(audit.rows, [{ route_id: route, actor_role: 'superadmin', t: true }]);
  });

  test('CAP-002 · cambio de responsable (SuperAdmin): el capital colocado viaja de una bolsa a otra con un asiento; nunca en dos ni en ninguna', async () => {
    const x = (await bruno('POST', '/v1/members', { email: 'admin-y@example.test', role: 'admin', displayName: 'Admin Y', routeIds: [r1] })).body['membershipId'] as string;
    const carried = await placement(db.admin, c1, r1, M.anaAdmin);
    assert.equal(carried, 470_000, 'seed: 5.000 − 200 − 100 BRL en unidades menores (Ronda 53: tr3 ya no va a un Socio sino a la ruta 3)');
    assert.equal((await ana('PUT', `/v1/routes/${r1}/capital-controller`, { membershipId: x, reason: 'Reorganización' })).status, 403, 'el Administrador no cambia responsables');
    assert.equal((await bruno('PUT', `/v1/routes/${r1}/capital-controller`, { membershipId: x, reason: 'no' })).body['error'], 'REASON_REQUIRED');
    assert.equal((await bruno('PUT', `/v1/routes/${r1}/capital-controller`, { membershipId: M.anaAdmin, reason: 'Igual' })).body['error'], 'ALREADY_CONTROLLER');
    assert.equal((await bruno('PUT', `/v1/routes/${r1}/capital-controller`, { membershipId: membershipId('c1', 'ana-cob'), reason: 'Cobradora' })).body['error'], 'CAPITAL_CONTROLLER_INVALID');
    const r = await bruno('PUT', `/v1/routes/${r1}/capital-controller`, { membershipId: x, reason: 'Reorganización de cartera' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ev = r.body['event'] as { kind: string; capitalTransferredMinor: number; fromMembershipId: string; toMembershipId: string };
    assert.deepEqual([ev.kind, ev.fromMembershipId, ev.toMembershipId, ev.capitalTransferredMinor], ['CHANGE', M.anaAdmin, x, 470_000]);
    const led = await db.admin.query(
      `select amount_minor::int a, from_admin_membership_id f, to_admin_membership_id t, actor_membership_id act, actor_role role, related_event_id is not null linked
         from adex.capital_ledger where route_id = $1 and kind = 'ROUTE_CONTROL_TRANSFER' and created_at > now() - interval '1 minute'`, [r1]);
    assert.deepEqual(led.rows, [{ a: 470_000, f: M.anaAdmin, t: x, act: M.brunoSa, role: 'superadmin', linked: true }]);
    assert.equal(await placement(db.admin, c1, r1, M.anaAdmin), 0, 'la bolsa anterior ya no responde por la ruta');
    assert.equal(await placement(db.admin, c1, r1, x), 470_000, 'la nueva sí, por el mismo importe');
    assert.equal(await controllerOf(r1), x);
    const e = await db.admin.query('select reason, capital_transferred_minor::int c, base_at_change_minor from adex.route_capital_controller_events where id = $1', [(r.body['event'] as { eventId: string }).eventId]);
    assert.deepEqual(e.rows, [{ reason: 'Reorganización de cartera', c: 470_000, base_at_change_minor: '0' }], 'Fase 3: custodia de la ruta al cambiar (sin entregas: 0)');
    // ADEX Online: historial consultable (SuperAdmin: todo; Administrador: los suyos; Cobrador: nada).
    const hist = (await bruno('GET', `/v1/capital/controller-events?routeId=${r1}`)).body['events'] as Record<string, unknown>[];
    assert.deepEqual(hist.filter((h) => h['reason'] === 'Reorganización de cartera').map((h) => [h['kind'], h['fromAdminId'], h['toAdminId'], h['capitalTransferredMinor']]),
      [['CHANGE', M.anaAdmin, x, 470_000]]);
    const anaHist = (await ana('GET', `/v1/capital/controller-events?routeId=${r1}`)).body['events'] as Record<string, unknown>[];
    assert.ok(anaHist.every((h) => h['fromAdminId'] === M.anaAdmin || h['toAdminId'] === M.anaAdmin) && anaHist.some((h) => h['kind'] === 'CHANGE'));
    const cob = caller(api, issuer, 'ana', M.anaCob);
    assert.equal((await cob('GET', '/v1/capital/controller-events')).status, 403);
  });

  test('CAP-003 · desactivar al único Administrador libera la ruta (RELEASE); reactivarlo la recupera con el mismo capital', async () => {
    const c3 = companyId('c3');
    const irene = membershipId('c3', 'irene-admin');
    const routes = [routeId('c3', 1), routeId('c3', 2)];
    // Capital de cada ruta = bolsa de Irene + capital sin atribuir. Se conserva siempre.
    const state = () => Promise.all(routes.map(async (r) => [await placement(db.admin, c3, r, irene), await placement(db.admin, c3, r, null)]));
    const before = await state();
    const totals = before.map(([a, u]) => a! + u!);
    assert.deepEqual(before[1], [20_000_000, -10_000_000], 'seed c3/r2: traslado +200.000 COP y ajuste previo a v16 de −100.000 COP sin bolsa');
    const off = await diego('POST', `/v1/members/${irene}/deactivate`, {});
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.deepEqual((off.body['controllerEvents'] as { kind: string }[]).map((e) => e.kind), ['RELEASE', 'RELEASE']);
    for (const r of routes) assert.equal(await controllerOf(r), null);
    assert.deepEqual(await state(), totals.map((t) => [0, t]), 'liberada: todo el capital de la ruta queda sin bolsa');
    const on = await diego('POST', `/v1/members/${irene}/reactivate`, {});
    assert.deepEqual((on.body['controllerEvents'] as { kind: string }[]).map((e) => e.kind), ['FIRST_ADMIN', 'FIRST_ADMIN']);
    assert.deepEqual(await state(), totals.map((t) => [t, 0]), 'el nuevo responsable reconoce TODO el capital de la ruta, ni más ni menos');
  });

  test('CAP-004 · responsable protegido: no se le retira ni desactiva mientras haya otro Administrador; el SuperAdmin elige al editar la ruta', async () => {
    const c2 = companyId('c2');
    const hugo = membershipId('c2', 'hugo-admin');
    const carla = caller(api, issuer, 'carla', M.carlaSa);
    const other = (await carla('POST', '/v1/members', { email: 'admin-c2@example.test', role: 'admin', displayName: 'Admin C2', routeIds: [routeId('c2', 1)] })).body['membershipId'] as string;
    const deact = await carla('POST', `/v1/members/${hugo}/deactivate`, {});
    assert.equal(deact.body['error'], 'CAPITAL_CONTROLLER_REQUIRED');
    assert.equal((await db.admin.query('select status from adex.memberships where id = $1', [hugo])).rows[0].status, 'activo', 'nada se guardó');
    const hugoCaller = caller(api, issuer, 'hugo', hugo);
    assert.equal((await hugoCaller('PATCH', `/v1/routes/${routeId('c2', 1)}`, { capitalControllerId: other })).status, 403, 'solo el SuperAdmin elige');
    const r = await carla('PATCH', `/v1/routes/${routeId('c2', 1)}`, { capitalControllerId: other, reason: 'Hugo deja la ruta' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body['capitalControllerId'], other);
    assert.equal((await carla('PUT', `/v1/members/${hugo}/routes`, { routeIds: [routeId('c2', 2)] })).status, 200, 'ya no es responsable de r1');
    assert.equal(await placement(db.admin, c2, routeId('c2', 1), hugo), 0);
    assert.equal(await count(db.admin, `select 1 from adex.route_capital_controller_events where company_id = $1 and created_at > now() - interval '1 minute'`, [c2]), 1);
  });

  test('CAP-005 · PostgreSQL rechaza al COMMIT cualquier responsable inválido, venga de donde venga (AX101)', async () => {
    const r2 = routeId('c2', 2);
    const hugo = membershipId('c2', 'hugo-admin');
    assert.equal(await controllerOf(r2), hugo);
    const cases: [string, string[]][] = [
      ['update adex.routes set capital_controller_membership_id = $1 where id = $2', [membershipId('c2', 'elisa-cob'), r2]],
      ['delete from adex.membership_routes where membership_id = $1 and route_id = $2', [hugo, r2]],
      [`update adex.memberships set status = 'inactivo' where id = $1`, [hugo]],
      [`update adex.memberships set role = 'supervisor' where id = $1`, [hugo]],
    ];
    for (const [sql, params] of cases) {
      // Administrador de la base (BYPASSRLS): ni él salta la restricción diferida.
      const tx = new pg.Client({ connectionString: db.url('postgres') });
      await tx.connect();
      try {
        await tx.query('begin');
        await tx.query(sql, params);
        await assert.rejects(tx.query('commit'), { code: 'AX101' }, sql);
      } finally {
        await tx.end();
      }
    }
    assert.equal(await controllerOf(r2), hugo);
    assert.equal(await count(db.admin, `select 1 from adex.memberships where id = $1 and status = 'activo' and role = 'admin'`, [hugo]), 1);
    // Una secuencia válida dentro de la misma transacción sí se confirma.
    const tx = new pg.Client({ connectionString: db.url('postgres') });
    await tx.connect();
    try {
      await tx.query('begin');
      await tx.query('delete from adex.membership_routes where membership_id = $1 and route_id = $2', [hugo, r2]);
      await tx.query('update adex.routes set capital_controller_membership_id = null where id = $1', [r2]);
      await tx.query('commit');
    } finally {
      await tx.end();
    }
    assert.equal(await controllerOf(r2), null);
  });

  test('CAP-006 · carreras entre comandos: nunca queda un responsable inválido y el primer Admin se elige una sola vez', async () => {
    for (let i = 0; i < 5; i++) {
      const route = (await bruno('POST', '/v1/routes', { name: `Carrera capital ${i}`, interestRate: 20, freeRate: false, maxLoanMinor: 1000 })).body['id'] as string;
      const a = (await bruno('POST', '/v1/members', { email: `ca-${i}@example.test`, role: 'admin', displayName: `A${i}` })).body['membershipId'] as string;
      const b = (await bruno('POST', '/v1/members', { email: `cb-${i}@example.test`, role: 'admin', displayName: `B${i}` })).body['membershipId'] as string;
      // Dos Administradores asignados a la vez a una ruta sin responsable: un solo FIRST_ADMIN.
      const [ra, rb] = await Promise.all([a, b].map((m) => bruno('PUT', `/v1/members/${m}/routes`, { routeIds: [route] })));
      assert.equal(ra.status, 200, JSON.stringify(ra.body));
      assert.equal(rb.status, 200, JSON.stringify(rb.body));
      assert.equal(await count(db.admin, `select 1 from adex.route_capital_controller_events where route_id = $1 and kind = 'FIRST_ADMIN'`, [route]), 1);
      const ctl = await controllerOf(route);
      const otherAdmin = ctl === a ? b : a;
      // Retirar al otro Administrador mientras se le nombra responsable: ambos no.
      const [rem, chg] = await Promise.all([
        bruno('PUT', `/v1/members/${otherAdmin}/routes`, { routeIds: [] }),
        bruno('PUT', `/v1/routes/${route}/capital-controller`, { membershipId: otherAdmin, reason: 'Carrera' }),
      ]);
      assert.ok([rem.status, chg.status].includes(200), `trial ${i}: ${rem.status}/${chg.status}`);
      const valid = await db.admin.query<{ ok: boolean }>('select adex.route_controller_valid($1, $2) ok', [c1, route]);
      assert.equal(valid.rows[0]!.ok, true, `trial ${i}: responsable válido al final (${rem.status}/${chg.status})`);
    }
  });

  test('CAP-099 · sin errores inesperados en el servidor', () => {
    assert.deepEqual(api.errors, []);
  });
});
