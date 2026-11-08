// 3.31 · Ingreso con nombre de usuario: alta con usuario (correo interno), usuario único en todo ADEX,
// formato validado y correos reales sin cambios. Datos 100 % sintéticos.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { isValidUsername, loginEmailOf, loginLabelOf, suggestUsername, usernameOf, USERNAME_DOMAIN } from '../../src/client/username.ts';

describe('3.31 · ingreso con nombre de usuario', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  let bruno: Caller;

  before(async () => {
    db = await createTestDb('username_login', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, createMemoryProvider());
    bruno = caller(api, issuer, 'bruno', M.brunoSa);
  });
  after(async () => { await api.close(); await db.close(); });

  test('USR-001 · reglas del usuario: casilla «usuario o correo», propuesta desde el nombre y formato', () => {
    assert.equal(loginEmailOf('  Carlos.Centro '), `carlos.centro@${USERNAME_DOMAIN}`);
    assert.equal(loginEmailOf('Ana@Empresa.com'), 'ana@empresa.com', 'un correo real no cambia');
    assert.equal(usernameOf(`carlos.centro@${USERNAME_DOMAIN}`), 'carlos.centro');
    assert.equal(usernameOf('ana@empresa.com'), null);
    assert.equal(loginLabelOf(`carlos.centro@${USERNAME_DOMAIN}`), 'carlos.centro');
    assert.equal(suggestUsername('Carlos Andrés Pérez'), 'carlos.perez');
    assert.equal(suggestUsername('JOÃO'), 'joao');
    for (const ok of ['carlos.centro', 'ana_2', 'juan-p']) assert.ok(isValidUsername(ok), ok);
    for (const bad of ['ab', 'carlos centro', '.carlos', 'carlos.', 'josé', 'a..b', 'x'.repeat(31)]) assert.ok(!isValidUsername(bad), bad);
  });

  test('USR-002 · alta con usuario: la identidad usa el correo interno y la membresía queda activa', async () => {
    const r = await bruno('POST', '/v1/members', { email: loginEmailOf('cobrador.usuario'), role: 'cobrador', displayName: 'Cobrador Usuario' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = (await db.admin.query(`select i.email from adex.memberships m join adex.identities i on i.id = m.identity_id where m.id = $1`, [r.body['membershipId']])).rows[0];
    assert.equal(row?.email, `cobrador.usuario@${USERNAME_DOMAIN}`);
  });

  test('USR-003 · el usuario es único en todo ADEX: repetirlo se rechaza (no se reutiliza la identidad de otra persona)', async () => {
    const before = (await db.admin.query('select count(*)::int n from adex.memberships')).rows[0].n;
    const r = await bruno('POST', '/v1/members', { email: loginEmailOf('cobrador.usuario'), role: 'secretario', displayName: 'Otra persona' });
    assert.equal(r.status, 409);
    assert.equal(r.body['error'], 'USERNAME_TAKEN');
    assert.equal((await db.admin.query('select count(*)::int n from adex.memberships')).rows[0].n, before, 'no se creó ninguna membresía');
  });

  test('USR-004 · un usuario con formato inválido se rechaza; un correo real sigue funcionando como antes', async () => {
    const bad = await bruno('POST', '/v1/members', { email: `a..b@${USERNAME_DOMAIN}`, role: 'cobrador', displayName: 'Mal formato' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body['error'], 'INVALID_USERNAME');
    const real = await bruno('POST', '/v1/members', { email: 'real.correo@example.test', role: 'cobrador', displayName: 'Con correo' });
    assert.equal(real.status, 201, JSON.stringify(real.body));
  });
});
