// FASE 1 · REVOKE-004 (aprobado 2026-10-14) con la API real y PostgreSQL real.
// Cierra la ventana medida en 0A.1 (REVOKE-002): una operación ya autorizada y una
// revocación concurrente quedan SERIALIZADAS por el bloqueo consultivo.
//   (1) La revocación espera a la operación en curso y confirma después.
//   (2) Una operación que empieza durante la revocación espera y, al seguir, ve el
//       estado nuevo: se rechaza sin efectos.
// Vías cubiertas: desactivar membresía, quitar ruta, suspender empresa (Owner),
// desactivar identidad y cerrar sesión global.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ActiveContext } from '../../src/authz/context.ts';
import { companyId, identityOf, membershipId, routeId } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import {
  createLocalIssuer, createMemoryProvider, startCompanyApi, startControlApi, type LocalIssuer, type TestServer,
} from '../helpers/auth.ts';

const M = {
  brunoSa: membershipId('c1', 'bruno-sa'), anaCob: membershipId('c1', 'ana-cob'), anaAdmin: membershipId('c1', 'ana-admin'),
  gabiSec: membershipId('c1', 'gabi-sec'), fabioSocio: membershipId('c1', 'fabio-socio'), carlaSa: membershipId('c2', 'carla-sa'),
  elisaCob: membershipId('c2', 'elisa-cob'),
};

/** Compuerta: la operación de la membresía indicada se detiene con los bloqueos tomados. */
function gate() {
  let open!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  const inside = new Promise<void>((r) => { entered = r; });
  let target: string | null = null;
  return {
    arm(membership: string) { target = membership; },
    hook: async (ctx: ActiveContext) => {
      if (ctx.membershipId !== target) return;
      target = null;
      entered();
      await opened;
    },
    inside,
    open: () => open(),
  };
}

describe('Fase 1 · REVOKE-004: revocación serializada con las operaciones', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  let control: TestServer;
  let g = gate();
  const provider = createMemoryProvider();

  /** Espera hasta que haya `n` peticiones de bloqueo consultivo sin conceder. */
  async function waitingAdvisory(n = 1): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const r = await db.admin.query(`select count(*)::int n from pg_locks where locktype = 'advisory' and not granted`);
      if (r.rows[0].n >= n) return;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error('nobody is waiting for the advisory lock');
  }

  before(async () => {
    db = await createTestDb('revocation', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider, { afterContext: (ctx) => g.hook(ctx) });
    control = await startControlApi(db, issuer, provider);
  });
  after(async () => { await api.close(); await control.close(); await db.close(); });

  test('REV-001 · desactivar una membresía ESPERA a su operación en curso y la deja terminar', async () => {
    g = gate();
    g.arm(M.anaCob);
    const ana = await issuer.issue('ana');
    const op = api.call('GET', '/v1/routes', { token: ana, membership: M.anaCob });
    await g.inside;
    const revoke = api.call('POST', `/v1/members/${M.anaCob}/deactivate`, { token: await issuer.issue('bruno'), membership: M.brunoSa, body: {} });
    await waitingAdvisory();
    const state = await db.admin.query('select status from adex.memberships where id = $1', [M.anaCob]);
    assert.equal(state.rows[0].status, 'activo', 'la revocación aún no confirmó');
    g.open();
    assert.equal((await op).status, 200, 'la operación autorizada antes termina');
    assert.equal((await revoke).status, 200);
    assert.deepEqual((await api.call('GET', '/v1/routes', { token: ana, membership: M.anaCob })).body, { error: 'MEMBERSHIP_INACTIVE' });
  });

  test('REV-002 · una operación que empieza DURANTE la revocación espera y luego se rechaza', async () => {
    const tx = await db.admin.connect();
    try {
      await tx.query('begin');
      await tx.query(`update adex.memberships set status = 'inactivo' where id = $1`, [M.gabiSec]);
      const op = api.call('GET', '/v1/routes', { token: await issuer.issue('gabi'), membership: M.gabiSec });
      await waitingAdvisory();
      await tx.query('commit');
      assert.deepEqual((await op).body, { error: 'MEMBERSHIP_INACTIVE' });
    } finally {
      tx.release();
    }
  });

  test('REV-003 · quitar una ruta autorizada también serializa (vía membership_routes)', async () => {
    const tx = await db.admin.connect();
    try {
      await tx.query('begin');
      await tx.query('delete from adex.membership_routes where membership_id = $1 and route_id = $2', [M.fabioSocio, routeId('c1', 1)]);
      const op = api.call('GET', `/v1/routes/${routeId('c1', 1)}`, { token: await issuer.issue('fabio'), membership: M.fabioSocio });
      await waitingAdvisory();
      await tx.query('commit');
      assert.equal((await op).status, 404, 'al continuar ya no ve la ruta');
    } finally {
      tx.release();
    }
  });

  test('REV-004 · suspender la empresa desde el Owner espera a la operación en curso y corta las siguientes', async () => {
    g = gate();
    g.arm(M.carlaSa);
    const carla = await issuer.issue('carla');
    const op = api.call('GET', '/v1/members', { token: carla, membership: M.carlaSa });
    await g.inside;
    const suspend = control.call('POST', `/control/v1/companies/${companyId('c2')}/status`, { token: await issuer.issue('owner'), body: { status: 'suspended', detail: 'prueba' } });
    await waitingAdvisory();
    g.open();
    assert.equal((await op).status, 200);
    assert.equal((await suspend).status, 200);
    assert.deepEqual((await api.call('GET', '/v1/context', { token: carla, membership: M.carlaSa })).body, { error: 'COMPANY_BLOCKED' });
    assert.deepEqual((await api.call('GET', '/v1/context', { token: await issuer.issue('elisa'), membership: M.elisaCob })).body, { error: 'COMPANY_BLOCKED' });
    assert.equal((await control.call('POST', `/control/v1/companies/${companyId('c2')}/status`, { token: await issuer.issue('owner'), body: { status: 'active' } })).status, 200);
    assert.equal((await api.call('GET', '/v1/context', { token: carla, membership: M.carlaSa })).status, 200);
  });

  test('REV-005 · desactivar la identidad y el cierre global también esperan a las operaciones de esa persona', async () => {
    g = gate();
    g.arm(M.anaAdmin);
    const ana = await issuer.issue('ana');
    const op = api.call('GET', '/v1/routes', { token: ana, membership: M.anaAdmin });
    await g.inside;
    const logoutAll = api.call('POST', '/v1/session/logout', { token: await issuer.issue('ana'), body: { scope: 'global' } });
    await waitingAdvisory();
    g.open();
    assert.equal((await op).status, 200);
    assert.equal((await logoutAll).status, 200);
    assert.deepEqual((await api.call('GET', '/v1/routes', { token: ana, membership: M.anaAdmin })).body, { error: 'SESSION_REVOKED' });

    const tx = await db.admin.connect();
    try {
      await tx.query('begin');
      await tx.query(`update adex.identities set status = 'disabled' where id = $1`, [identityOf('elisa')]);
      const opE = api.call('GET', '/v1/context', { token: await issuer.issue('elisa'), membership: M.elisaCob });
      await waitingAdvisory();
      await tx.query('commit');
      assert.deepEqual((await opE).body, { error: 'IDENTITY_DISABLED' });
    } finally {
      tx.release();
    }
  });

  test('REV-006 · con lock_timeout, una operación bloqueada por una revocación larga falla limpia (503) sin efectos', async () => {
    const short = await startCompanyApi(db, issuer, provider, { lockTimeoutMs: 300 });
    const tx = await db.admin.connect();
    try {
      await tx.query('begin');
      await tx.query(`update adex.companies set status = 'activa', expires_on = expires_on where id = $1`, [companyId('c3')]);
      await tx.query(`select pg_advisory_xact_lock(adex.lock_key('company', $1))`, [companyId('c3')]);
      const before = (await db.admin.query('select count(*)::int n from adex.audit_log')).rows[0].n;
      const r = await short.call('POST', '/v1/members', { token: await issuer.issue('diego'), membership: membershipId('c3', 'diego-sa'),
        body: { email: 'timeout@example.test', role: 'cobrador', displayName: 'T' } });
      assert.deepEqual(r.body, { error: 'REVOCATION_IN_PROGRESS' });
      assert.equal(r.status, 503);
      assert.equal((await db.admin.query('select count(*)::int n from adex.audit_log')).rows[0].n, before);
      assert.equal((await db.admin.query(`select count(*)::int n from adex.identities where email = 'timeout@example.test'`)).rows[0].n, 0);
    } finally {
      await tx.query('rollback');
      tx.release();
      await short.close();
    }
  });

  test('REV-007 · sin errores inesperados en el servidor', () => {
    assert.deepEqual(api.errors, []);
    assert.deepEqual(control.errors, []);
  });
});
