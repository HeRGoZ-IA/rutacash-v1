// [pg] Fase 0A.1 · Revocación de membresía frente a una operación YA EN CURSO.
//
// Se ejecuta en PostgreSQL local (npm run test:integration) y en el gestionado
// (npm run test:managed). Solo usa datos propios con identificadores aleatorios.
//
// Qué demuestra:
//   1. Con el patrón actual, RLS revalida la membresía en cada sentencia: una
//      revocación confirmada a mitad de la operación la aborta sin efectos.
//   2. Pero queda una ventana: si la revocación se confirma después de la ÚLTIMA
//      sentencia y antes del COMMIT, la operación se confirma igualmente.
//   3. `FOR SHARE` sobre la membresía no es posible para adex_api (exige UPDATE).
//   4. Alternativa compatible con el pooler en modo transacción: bloqueo
//      consultivo de transacción (compartido en la operación, exclusivo en la
//      revocación). La revocación queda SERIALIZADA respecto de las operaciones.
//      Es una demostración en SQL de prueba; el servicio de la POC no cambia.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { balanceOf, count, createTestDb, managedSsl, managedMode, pgAvailable, type TestDb } from '../helpers/db.ts';
import { startApi, type TestApi } from '../helpers/api.ts';
import { createLocalIssuer, type LocalIssuer } from '../helpers/issuer.ts';

const SKIP = pgAvailable() ? false : 'NO EJECUTADA: requiere PostgreSQL (npm run test:integration o test:managed)';

let db: TestDb;
let iss: LocalIssuer;

interface World { company: string; identity: string; membership: string; account: string; token: string }

before(async () => {
  if (SKIP) return;
  db = await createTestDb('revocation');
  iss = await createLocalIssuer();
});
after(async () => { if (!SKIP) await db.close(); });

async function world(): Promise<World> {
  const w = { company: randomUUID(), identity: randomUUID(), membership: randomUUID(), account: randomUUID(), token: '' };
  await db.superPool.query(`insert into adex.companies (id, name, country_code, currency_code, timezone) values ($1, 'Revocación sintética', 'BR', 'BRL', 'America/Sao_Paulo')`, [w.company]);
  await db.superPool.query('insert into adex.identities (id, email) values ($1, $2)', [w.identity, `rev-${w.identity.slice(0, 8)}@example.test`]);
  await db.superPool.query(`insert into adex.memberships (id, identity_id, company_id, role, scope) values ($1, $2, $3, 'admin', 'company')`, [w.membership, w.identity, w.company]);
  await db.superPool.query(`insert into adex.accounts (id, company_id, route_id, name, balance_minor) values ($1, $2, null, 'Caixa revogação', 500000)`, [w.account, w.company]);
  w.token = await iss.issue(w.identity);
  return w;
}
const revoke = (membership: string) => db.superPool.query(`update adex.memberships set status = 'inactive' where id = $1`, [membership]);
const effects = async (w: World) => ({
  balance: await balanceOf(db.superPool, w.account),
  movements: await count(db.superPool, 'select 1 from adex.movements where account_id = $1', [w.account]),
  audits: await count(db.superPool, 'select 1 from adex.audit_log where entity_id = $1', [w.account]),
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
/** Conexión propia como adex_api (en gestionado, por el pooler en modo transacción: todo dentro de BEGIN…COMMIT). */
async function apiClient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: db.apiUrl, ssl: managedMode() ? managedSsl() : undefined });
  await c.connect();
  return c;
}
const setCtx = (c: pg.Client, w: World) =>
  c.query(`select set_config('adex.identity_id', $1, true), set_config('adex.membership_id', $2, true), set_config('adex.company_id', $3, true)`, [w.identity, w.membership, w.company]);

test('REVOKE-001 [pg+api] revocación confirmada a mitad de la operación: RLS la detecta y la operación no deja efectos', { skip: SKIP }, async (t) => {
  const w = await world();
  const locked = deferred();
  const release = deferred();
  const paused: TestApi = await startApi(db.apiPool, iss.verifier, {
    afterAccountLocked: async () => { locked.resolve(); await release.promise; },
  });
  try {
    const p = paused.call('POST', `/v1/accounts/${w.account}/withdrawals`, { token: w.token, membership: w.membership, body: { operationId: randomUUID(), amount: '100.00' } });
    await locked.promise;                // la operación ya leyó la membresía activa y bloqueó el saldo
    await revoke(w.membership);          // la revocación NO espera: nadie bloquea la fila de la membresía
    release.resolve();
    const r = await p;
    t.diagnostic(`respuesta de la operación en curso: ${r.status} ${String(r.body['error'] ?? '')}`);
    assert.notEqual(r.status, 201, 'la operación no se confirma');
    assert.deepEqual(await effects(w), { balance: 500000n, movements: 0, audits: 0 });
  } finally {
    release.resolve();
    await paused.close();
  }
});

test('REVOKE-002 [pg] ventana residual: revocación confirmada entre la última sentencia y el COMMIT', { skip: SKIP }, async () => {
  const w = await world();
  const c = await apiClient();
  try {
    const op = randomUUID();
    await c.query('begin isolation level read committed');
    await setCtx(c, w);
    // Mismas escrituras que el servicio, ya todas ejecutadas (RLS las aceptó con la membresía activa).
    await c.query(`insert into adex.operations (company_id, operation_id, kind, request_hash, membership_id, outcome) values ($1, $2, 'withdrawal', 'h', $3, 'pending')`, [w.company, op, w.membership]);
    await c.query('update adex.accounts set balance_minor = balance_minor - 10000 where id = $1', [w.account]);
    await c.query(`insert into adex.movements (company_id, account_id, operation_id, kind, amount_minor, balance_after_minor, currency_code, identity_id, membership_id, role)
                   values ($1, $2, $3, 'withdrawal', 10000, 490000, 'BRL', $4, $5, 'admin')`, [w.company, w.account, op, w.identity, w.membership]);
    await c.query(`insert into adex.audit_log (company_id, identity_id, membership_id, role, action, entity_type, entity_id, operation_id, outcome)
                   values ($1, $2, $3, 'admin', 'ledger.withdrawal', 'account', $4, $5, 'approved')`, [w.company, w.identity, w.membership, w.account, op]);
    await revoke(w.membership);          // confirmada ANTES del commit de la operación
    await c.query('commit');             // …y la operación se confirma igualmente
    assert.deepEqual(await effects(w), { balance: 490000n, movements: 1, audits: 1 }, 'la ventana existe: acotada a un viaje de red, pero existe');
  } finally {
    await c.query('rollback').catch(() => undefined);
    await c.end();
  }
});

test('REVOKE-003 [pg] FOR SHARE sobre la membresía no está disponible para adex_api (exige privilegio UPDATE)', { skip: SKIP }, async () => {
  const w = await world();
  const c = await apiClient();
  try {
    await c.query('begin');
    await setCtx(c, w);
    let code = 'OK';
    try { await c.query('select 1 from adex.memberships where id = $1 for share', [w.membership]); }
    catch (e) { code = (e as { code?: string }).code ?? 'ERR'; }
    assert.equal(code, '42501');
  } finally {
    await c.query('rollback').catch(() => undefined);
    await c.end();
  }
});

test('REVOKE-004 [pg] alternativa: bloqueo consultivo de transacción serializa revocación y operaciones', { skip: SKIP }, async (t) => {
  const w = await world();
  const key = `select hashtextextended($1, 0) k`;
  const k = (await db.superPool.query(key, [w.membership])).rows[0].k as string;
  const a = await apiClient();
  const admin = new pg.Client(managedMode() ? { connectionString: process.env['ADEX_PG_ADMIN_URL'], ssl: managedSsl() } : { connectionString: superUrlOf(db) });
  await admin.connect();
  const waitingAdvisory = () => count(db.superPool, `select 1 from pg_locks where locktype = 'advisory' and not granted`);
  try {
    await t.test('una revocación espera a la operación en curso', async () => {
      await a.query('begin');
      await setCtx(a, w);
      await a.query('select pg_advisory_xact_lock_shared($1::bigint)', [k]);
      const active = await a.query(`select status from adex.memberships where id = $1`, [w.membership]);
      assert.equal(active.rows[0].status, 'active');
      const revoking = (async () => {
        await admin.query('begin');
        await admin.query('select pg_advisory_xact_lock($1::bigint)', [k]);   // espera a la operación
        await admin.query(`update adex.memberships set status = 'inactive' where id = $1`, [w.membership]);
        await admin.query('commit');
        return Date.now();
      })();
      let waiting = 0;
      for (let i = 0; i < 100 && waiting === 0; i++) { await new Promise((r) => setTimeout(r, 30)); waiting = await waitingAdvisory(); }
      assert.equal(waiting, 1, 'la revocación está esperando el bloqueo consultivo');
      await a.query('update adex.accounts set balance_minor = balance_minor - 10000 where id = $1', [w.account]);
      await a.query('commit');
      const committedAt = Date.now();
      const revokedAt = await revoking;
      assert.ok(revokedAt >= committedAt, 'la revocación se confirma DESPUÉS de la operación');
      assert.equal(await balanceOf(db.superPool, w.account), 490000n);
    });
    await t.test('una operación que empieza durante la revocación espera y ya ve la membresía inactiva', async () => {
      await db.superPool.query(`update adex.memberships set status = 'active' where id = $1`, [w.membership]);
      await admin.query('begin');
      await admin.query('select pg_advisory_xact_lock($1::bigint)', [k]);
      await admin.query(`update adex.memberships set status = 'inactive' where id = $1`, [w.membership]);
      const op = (async () => {
        await a.query('begin');
        await setCtx(a, w);
        await a.query('select pg_advisory_xact_lock_shared($1::bigint)', [k]);   // espera a la revocación
        const s = await a.query(`select status from adex.memberships where id = $1`, [w.membership]);
        const visible = await count(a as unknown as pg.Pool, 'select 1 from adex.accounts where id = $1', [w.account]);
        await a.query('rollback');
        return { status: s.rows[0]?.status as string | undefined, visible };
      })();
      let waiting = 0;
      for (let i = 0; i < 100 && waiting === 0; i++) { await new Promise((r) => setTimeout(r, 30)); waiting = await waitingAdvisory(); }
      assert.equal(waiting, 1, 'la operación espera a la revocación');
      await admin.query('commit');
      assert.deepEqual(await op, { status: 'inactive', visible: 0 }, 'tras esperar, la operación ve la revocación');
    });
  } finally {
    await a.query('rollback').catch(() => undefined);
    await admin.query('rollback').catch(() => undefined);
    await a.end();
    await admin.end();
  }
});

/** Local: URL de superusuario de la base de esta prueba. */
function superUrlOf(d: TestDb): string {
  return d.apiUrl.replace(/^postgres:\/\/adex_api:[^@]+@/, `postgres://postgres:${encodeURIComponent(process.env['ADEX_PG_SUPER_PASS'] ?? '')}@`);
}
