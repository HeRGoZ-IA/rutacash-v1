// FASE 3 · seguridad del capital (requisito BLOQUEANTE): doble barrera.
//   1. API: `can()` de CLEAN, alcance por rutas y autoridad sobre la caja de la ruta.
//   2. PostgreSQL: RLS por rol y membresía en TODAS las tablas financieras y
//      `adex.capital_post` como única vía de escritura, que revalida todo por su cuenta.
// Cada aserción de la barrera 2 se hace SIN la API (adex_api con contexto fijado), para
// demostrar que no depende de la barrera 1.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type pg from '../../src/db/pgTypes.ts';
import { companyId, identityOf, membershipId, routeId } from '../../db/seeds/synthetic.ts';
import { asApi, count, createTestDb, type DbContext, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { money, newPerson, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('Fase 3 · seguridad del capital: RLS y autorización', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const c2 = companyId('c2');
  const r1 = routeId('c1', 1);
  let bruno: Caller, ana: Caller, carla: Caller;
  let $bruno: Money, $ana: Money, $carla: Money;
  let carlos: Person, yara: Person, lucas: Person, xavier: Person, dora: Person;
  let delivery = '', yaraAllocation = '', c2Delivery = '';

  const ctxOf = (identityId: string, membership: string, company = c1): DbContext => ({ identityId, membershipId: membership, companyId: company });
  const post = (q: pg.PoolClient, kind: string, o: Body = {}) => q.query(
    'select id from adex.capital_post($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
    [randomUUID(), kind, o['amount'] ?? 1, 'Prueba directa', o['route'] ?? null, o['worker'] ?? null, o['counterpart'] ?? null,
      o['toRoute'] ?? null, o['admin'] ?? null, null, o['reverses'] ?? null]);
  /** Rechazo de la segunda barrera con su código (en un savepoint: la transacción sigue viva). */
  const rejects = async (q: pg.PoolClient, kind: string, o: Body, code: string, label: string) => {
    await q.query('savepoint s');
    await assert.rejects(post(q, kind, o), { code }, label);
    await q.query('rollback to savepoint s');
  };

  before(async () => {
    db = await createTestDb('capitalsec', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    carla = caller(api, issuer, 'carla', M.carlaSa); $carla = money(carla);
    const mk = (email: string, role: string, displayName: string, routeIds: string[]) => newPerson(api, issuer, provider.ids, bruno, { email, role, displayName, routeIds });
    carlos = await mk('carlos-sec@example.test', 'cobrador', 'Carlos Cobrador', [r1]);
    yara = await mk('yara-sec@example.test', 'admin', 'Yara Admin', []);
    lucas = await mk('lucas-sec@example.test', 'cobrador', 'Lucas Cobrador', []);
    xavier = await mk('xavier-sec@example.test', 'admin', 'Xavier', [r1]);
    dora = await mk('dora-sec@example.test', 'supervisor', 'Dora', [r1]);
    // Cambio de responsable de ida y vuelta (Fase 2): deja traspasos ROUTE_CONTROL_TRANSFER
    // reales del capital sembrado en r1, los que ANTES podía leer el Cobrador de la ruta.
    for (const to of [xavier.membershipId, M.anaAdmin]) {
      const r = await bruno('PUT', `/v1/routes/${r1}/capital-controller`, { membershipId: to, reason: 'Preparación de la prueba' });
      if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    }
    const ok = (r: { status: number; body: Body }) => { if (r.status !== 201) throw new Error(JSON.stringify(r.body)); return (r.body['operation'] as Body)['id'] as string; };
    ok(await $bruno('/v1/capital/company/deposits', { amountMinor: 1_000_000, reason: 'Capital sintético' }));
    ok(await $bruno('/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 400_000, reason: 'Bolsa de Ana' }));
    yaraAllocation = ok(await $bruno('/v1/capital/allocations', { adminId: yara.membershipId, amountMinor: 50_000, reason: 'Bolsa de Yara' }));
    delivery = ok(await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 100_000, reason: 'Base del día' }));
    ok(await $carla('/v1/capital/company/deposits', { amountMinor: 900_000, reason: 'Capital c2' }));
    ok(await $carla('/v1/capital/allocations', { adminId: M.hugoAdmin, amountMinor: 300_000, reason: 'Bolsa de Hugo' }));
    c2Delivery = ok(await money(caller(api, issuer, 'hugo', M.hugoAdmin))('/v1/capital/deliveries', { routeId: routeId('c2', 1), workerId: M.elisaCob, amountMinor: 70_000, reason: 'Base c2' }));
  });
  after(async () => { await api.close(); await db.close(); });

  test('SEC3-001 · exposición corregida: el Cobrador no lee capital de la ruta, ni custodias, cuadres ni auditoría ajenos', async () => {
    // Hay datos de capital de la ruta (sembrados y de esta fase) que ANTES se veían.
    for (const t of ['capital_ledger', 'capital_movements', 'withdrawals', 'route_capital_controller_events', 'weekly_settlements', 'cash_custody_movements', 'cash_settlements']) {
      assert.ok(await count(db.admin, `select 1 from adex.${t} where company_id = $1 and route_id = $2`, [c1, r1]) > 0, `seed: ${t} con datos en r1`);
    }
    for (const [who, ctx] of [['Carlos (c1)', ctxOf(carlos.identityId, carlos.membershipId)], ['Elisa (c2)', ctxOf(identityOf('elisa'), M.elisaCob, c2)]] as const) {
      await asApi(db.api, ctx, async (q) => {
        for (const t of ['capital_ledger', 'capital_movements', 'withdrawals', 'transfers', 'route_capital_controller_events', 'weekly_settlements']) {
          assert.equal(await count(q, `select 1 from adex.${t}`), 0, `${who} lee ${t}`);
        }
        assert.equal(await count(q, 'select 1 from adex.cash_custody_movements where adex.ctx_membership() not in (coalesce(from_membership_id, \'\'), coalesce(to_membership_id, \'\'))'), 0, `${who}: custodia ajena`);
        assert.equal(await count(q, 'select 1 from adex.cash_settlements where worker_membership_id <> adex.ctx_membership()'), 0, `${who}: cuadres ajenos`);
        assert.equal(await count(q, 'select 1 from adex.audit_log where actor_membership_id is distinct from adex.ctx_membership()'), 0, `${who}: auditoría ajena`);
        assert.deepEqual((await q.query(`select kind, membership_id = adex.ctx_membership() own from adex.capital_accounts`)).rows, [{ kind: 'custody', own: true }], `${who}: solo su custodia`);
        assert.equal(await count(q, `select 1 from adex.capital_operations where adex.ctx_membership() not in (coalesce(worker_membership_id, ''), coalesce(counterpart_membership_id, ''))`), 0);
        assert.equal(await count(q, `select 1 from adex.capital_entries e join adex.capital_accounts a on a.id = e.account_id where a.kind <> 'custody'`), 0);
        assert.equal(await count(q, `select 1 from adex.capital_entries`), 1, `${who}: solo la pata de su custodia`);
      });
    }
    // El Supervisor de la ruta sigue viendo la caja heredada (`cashbox.viewRoute`), no las bolsas.
    await asApi(db.api, ctxOf(identityOf('ana'), M.anaSup, c2), async (q) => {
      assert.ok(await count(q, 'select 1 from adex.capital_movements') > 0);
      assert.equal(await count(q, 'select 1 from adex.capital_ledger'), 0);
      assert.equal(await count(q, `select 1 from adex.capital_accounts where kind <> 'custody'`), 0);
    });
  });

  test('SEC3-002 · empresa A no lee ni modifica la empresa B, ni conociendo un identificador de operación', async () => {
    await asApi(db.api, ctxOf(identityOf('carla'), M.carlaSa, c2), async (q) => {
      for (const t of ['capital_accounts', 'capital_operations', 'capital_entries']) {
        assert.equal(await count(q, `select 1 from adex.${t} where company_id = $1`, [c1]), 0, t);
      }
      await rejects(q, 'REVERSAL', { reverses: delivery }, 'AX412', 'anular una operación de otra empresa');
    });
    assert.equal((await carla('GET', `/v1/capital/operations/${delivery}`)).status, 404);
    assert.equal((await $carla(`/v1/capital/operations/${delivery}/reverse`, { reason: 'Ajena' })).status, 404);
    assert.equal((await $carla('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 1, reason: 'Ajena' })).status, 404);
    assert.equal((await bruno('GET', `/v1/capital/operations/${c2Delivery}`)).status, 404);
    assert.equal((await $bruno('/v1/capital/allocations', { adminId: M.hugoAdmin, amountMinor: 1, reason: 'Admin ajeno' })).status, 404);
  });

  test('SEC3-003 · el Administrador solo ve SU bolsa y las custodias de sus rutas', async () => {
    await asApi(db.api, ctxOf(identityOf('ana'), M.anaAdmin), async (q) => {
      assert.deepEqual((await q.query(`select membership_id from adex.capital_accounts where kind = 'admin'`)).rows, [{ membership_id: M.anaAdmin }]);
      assert.equal(await count(q, `select 1 from adex.capital_accounts where kind in ('company', 'external', 'partner')`), 0);
      assert.equal(await count(q, 'select 1 from adex.capital_operations where admin_membership_id = $1', [yara.membershipId]), 0);
    });
    assert.equal((await ana('GET', `/v1/capital/operations/${yaraAllocation}`)).status, 404);
    assert.deepEqual(((await ana('GET', '/v1/capital/summary')).body['admins'] as Body[]).map((a) => a['adminId']), [M.anaAdmin]);
    assert.equal((await ana('GET', '/v1/capital/reconciliation')).status, 403);
    const sa = ((await bruno('GET', '/v1/capital/summary')).body['admins'] as Body[]).map((a) => a['adminId']).sort();
    assert.deepEqual(sa, [M.anaAdmin, yara.membershipId].sort(), 'el SuperAdmin ve todas las bolsas de SU empresa');
  });

  test('SEC3-004 · el Cobrador consulta su custodia y nada más; no infiere la bolsa', async () => {
    assert.equal((await carlos.call('GET', '/v1/capital/summary')).status, 403);
    assert.equal((await carlos.call('GET', '/v1/capital/reconciliation')).status, 403);
    const positions = (await carlos.call('GET', '/v1/capital/custody')).body['positions'] as Body[];
    assert.deepEqual(positions.map((p) => [p['workerId'], p['balanceMinor'], p['transferableMinor']]), [[carlos.membershipId, 100_000, 100_000]]);
    const ops = (await carlos.call('GET', '/v1/capital/operations')).body['operations'] as Body[];
    assert.deepEqual(ops.map((o) => o['id']), [delivery]);
    const legs = (await carlos.call('GET', `/v1/capital/operations/${delivery}`)).body['entries'] as Body[];
    assert.deepEqual(legs.map((e) => [(e['account'] as Body)['kind'], e['balanceAfterMinor']]), [['custody', 100_000]], 'ni la pata ni el saldo de la bolsa');
    assert.equal((await carlos.call('GET', `/v1/capital/operations/${yaraAllocation}`)).status, 404);
    for (const path of ['/v1/capital/deliveries', '/v1/capital/returns', '/v1/capital/company/deposits', '/v1/capital/allocations']) {
      const r = await carlos.money(path, { routeId: r1, workerId: carlos.membershipId, adminId: M.anaAdmin, amountMinor: 1, reason: 'Intento' });
      assert.ok([400, 403].includes(r.status), `${path}: ${r.status}`);
      assert.ok(!JSON.stringify(r.body).match(/\d{3,}/), 'sin cifras');
    }
  });

  test('SEC3-005 · Owner: el plano de control no tiene acceso financiero ni puede ejecutar comandos', async () => {
    for (const sql of ['select 1 from adex.capital_accounts', 'select 1 from adex.capital_operations', 'select 1 from adex.capital_entries',
      `select adex.capital_post(gen_random_uuid(), 'COMPANY_DEPOSIT', 1, 'Owner')`]) {
      await assert.rejects(db.control.query(sql), { code: '42501' }, sql);
    }
    const priv = await db.admin.query(
      `select count(*)::int n from information_schema.role_table_grants where grantee = 'adex_control' and table_schema = 'adex'`);
    assert.equal(priv.rows[0].n, 0);
  });

  test('SEC3-006 · membresías desactivadas pierden autorización; su efectivo se puede recuperar', async () => {
    assert.equal((await bruno('POST', `/v1/members/${carlos.membershipId}/deactivate`)).status, 200);
    assert.equal((await carlos.call('GET', '/v1/capital/custody')).body['error'], 'MEMBERSHIP_INACTIVE');
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 1, reason: 'A inactivo' })).body['error'], 'CUSTODIAN_INVALID');
    assert.equal((await $ana('/v1/capital/returns', { routeId: r1, workerId: carlos.membershipId, amountMinor: 100_000, reason: 'Entrega al salir' })).status, 201,
      'un trabajador inactivo devuelve su efectivo');
    // R74 (0036, RB-D1): un Administrador con saldo en su bolsa no se desactiva; primero se recoge (y después, sí).
    const refused = await bruno('POST', `/v1/members/${yara.membershipId}/deactivate`);
    assert.deepEqual([refused.status, refused.body['error']], [409, 'ADMIN_HAS_PENDING_ACCOUNTS'], JSON.stringify(refused.body));
    assert.ok((((refused.body['details'] as Body)['blockers']) as Body[]).some((b) => b['code'] === 'ADMIN_POOL_BALANCE'));
    const yaraPool = Number((await db.admin.query(`select balance_minor from adex.capital_accounts where kind = 'admin' and membership_id = $1`, [yara.membershipId])).rows[0].balance_minor);
    assert.equal((await $bruno('/v1/capital/admin-returns', { adminId: yara.membershipId, amountMinor: yaraPool, reason: 'Vaciar la bolsa antes de desactivar' })).status, 201);
    assert.equal((await bruno('POST', `/v1/members/${yara.membershipId}/deactivate`)).status, 200);
    assert.equal((await yara.call('GET', '/v1/capital/summary')).body['error'], 'MEMBERSHIP_INACTIVE');
    assert.equal((await $bruno('/v1/capital/allocations', { adminId: yara.membershipId, amountMinor: 1, reason: 'A inactivo' })).body['error'], 'MEMBER_INACTIVE');
    await asApi(db.api, ctxOf(yara.identityId, yara.membershipId), async (q) => {
      await rejects(q, 'COMPANY_DEPOSIT', {}, '42501', 'contexto inactivo en la segunda barrera');
      assert.equal(await count(q, 'select 1 from adex.capital_accounts'), 0, 'sin contexto válido no se ve nada');
    });
  });

  test('SEC3-007 · DS-05: la misma persona con otra membresía ve otra cosa; nunca la suma', async () => {
    const anaCob = caller(api, issuer, 'ana', M.anaCob);
    assert.equal((await anaCob('GET', '/v1/capital/summary')).status, 403);
    assert.equal((await money(anaCob)('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 1, reason: 'Con el rol equivocado' })).status, 404);
    assert.deepEqual((await anaCob('GET', '/v1/capital/custody')).body['positions'], []);
    assert.equal(((await ana('GET', '/v1/capital/summary')).body['admins'] as Body[]).length, 1);
    await asApi(db.api, ctxOf(identityOf('ana'), M.anaCob), async (q) => {
      assert.equal(await count(q, `select 1 from adex.capital_accounts where kind = 'admin'`), 0);
      await rejects(q, 'WORKER_DELIVERY', { route: r1, worker: carlos.membershipId }, 'AX402', 'Cobradora no entrega aunque sea la misma persona que la responsable');
    });
  });

  test('SEC3-008 · DS-03: una sesión revocada no opera capital aunque el token siga firmado', async () => {
    const token = await issuer.issue(lucas.identityId, { sessionId: randomUUID() });
    const call = (path: string) => api.call('GET', path, { token, membership: lucas.membershipId });
    assert.equal((await call('/v1/capital/custody')).status, 200);
    assert.equal((await api.call('POST', '/v1/session/logout', { token, body: { scope: 'global' } })).status, 200);
    assert.equal((await call('/v1/capital/custody')).body['error'], 'SESSION_REVOKED');
  });

  test('SEC3-009 · sin escritura monetaria directa: tablas sin INSERT/UPDATE/DELETE y funciones internas sin EXECUTE', async () => {
    await asApi(db.api, ctxOf(identityOf('bruno'), M.brunoSa), async (q) => {
      for (const sql of [
        `insert into adex.capital_accounts (id, company_id, kind) values ('x', '${c1}', 'company')`,
        `update adex.capital_accounts set balance_minor = balance_minor + 1, version = version + 1`,
        `delete from adex.capital_accounts`,
        `insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
         values ('x', '${c1}', gen_random_uuid(), 'COMPANY_DEPOSIT', 1, 'BRL', 'directo', current_date, '${M.brunoSa}', '${identityOf('bruno')}', 'superadmin', 1)`,
        `insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor) values ('${c1}', 'x', 1, 'x', 1, 1)`,
        `select adex.capital_account_for('${c1}', 'company', null, null)`,
        `select adex.capital_custodian_ok('${c1}', '${r1}', '${carlos.membershipId}')`,
      ]) {
        await q.query('savepoint s');
        await assert.rejects(q.query(sql), { code: '42501' }, sql);
        await q.query('rollback to savepoint s');
      }
    });
    // Contexto ausente o falsificado: la función no escribe nada.
    for (const forged of [{}, { identityId: identityOf('bruno'), membershipId: M.brunoSa, companyId: c2 }, { identityId: identityOf('elisa'), membershipId: M.brunoSa, companyId: c1 }]) {
      await asApi(db.api, forged, async (q) => { await rejects(q, 'COMPANY_DEPOSIT', {}, '42501', JSON.stringify(forged)); });
    }
    await assert.rejects(db.admin.query(`select adex.capital_post(gen_random_uuid(), 'COMPANY_DEPOSIT', 1, 'Admin de la base')`), { code: '42501' },
      'ni el administrador de la base escribe dinero por esta vía');
  });

  test('SEC3-010 · la segunda barrera (SQL) decide sola: autoridad, custodio, D2 y campos nulos', async () => {
    const r6 = (await bruno('POST', '/v1/routes', { name: 'Ruta Seis', interestRate: 20, freeRate: false, maxLoanMinor: 1000, adminIds: [xavier.membershipId, M.anaAdmin] })).body['id'] as string;
    await asApi(db.api, ctxOf(xavier.identityId, xavier.membershipId), async (q) => {
      await rejects(q, 'WORKER_DELIVERY', { route: r1, worker: dora.membershipId }, 'AX402', 'Admin asignado, no responsable');
    });
    await asApi(db.api, ctxOf(dora.identityId, dora.membershipId), async (q) => {
      await rejects(q, 'WORKER_DELIVERY', { route: r1, worker: dora.membershipId }, 'AX402', 'Supervisor no entrega');
    });
    await asApi(db.api, ctxOf(identityOf('bruno'), M.brunoSa), async (q) => {
      await rejects(q, 'WORKER_DELIVERY', { route: r1, worker: dora.membershipId }, 'AX402', 'SuperAdmin no entrega (structural)');
    });
    await asApi(db.api, ctxOf(identityOf('ana'), M.anaAdmin), async (q) => {
      await rejects(q, 'WORKER_DELIVERY', { route: r1, worker: xavier.membershipId }, 'AX403', 'un Administrador no recibe custodia');
      await rejects(q, 'WORKER_DELIVERY', { route: r1, worker: null }, 'AX411', 'trabajador nulo');
      await rejects(q, 'WORKER_DELIVERY', { route: null, worker: dora.membershipId }, 'AX411', 'ruta nula');
      await rejects(q, 'WORKER_DELIVERY', { route: r1, worker: dora.membershipId, amount: 0 }, 'AX411', 'importe 0');
      await rejects(q, 'WORKER_DELIVERY', { route: r1, worker: dora.membershipId, amount: 999_999_999 }, 'AX401', 'sobregiro de la bolsa');
      await rejects(q, 'ROUTE_REASSIGNMENT', { route: r1, toRoute: r6, worker: dora.membershipId, counterpart: dora.membershipId }, 'AX406', 'D2: responsables distintos');
      await rejects(q, 'COMPANY_DEPOSIT', {}, 'AX402', 'un Administrador no deposita en la empresa');
      await rejects(q, 'WORKER_DELIVERY', { route: routeId('c2', 1), worker: M.elisaCob }, 'AX412', 'ruta de otra empresa');
    });
    assert.equal(await count(db.admin, `select 1 from adex.capital_operations where reason = 'Prueba directa'`), 0, 'ningún intento escribió');
  });
});
