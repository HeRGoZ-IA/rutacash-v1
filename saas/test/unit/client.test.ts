// Cliente en modo servidor: selector aprobado, almacén sin secretos y recuperación
// sin enumeración. IndexedDB simulada (`fake-indexeddb`, la misma que usan las
// suites de CLEAN).

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decideContext, type SelectableMembership } from '../../src/client/contextSelector.ts';
import { IndexedDbSessionStore, SecretInStorageError, assertNoSecrets } from '../../src/client/sessionStore.ts';
import { createSupabaseAuthClient } from '../../src/client/serverSession.ts';

const m = (id: string, company: string, role: string, opts: Partial<{ status: 'activo' | 'inactivo'; operable: boolean }> = {}): SelectableMembership => ({
  membershipId: id, role, status: opts.status ?? 'activo', company: { id: company, name: company, countryCode: 'CO', operable: opts.operable ?? true },
});

describe('cliente modo servidor', () => {
  test('CLI-001 · selector: una activa → entra; varias → elegir; suspendida → aviso y no elegible; inactiva → oculta', () => {
    assert.deepEqual(decideContext([m('a', 'Beta', 'cobrador')]).kind, 'auto');
    const many = decideContext([m('a', 'Beta', 'cobrador'), m('b', 'Alfa', 'admin')]);
    assert.equal(many.kind, 'choose');
    assert.deepEqual(many.options.map((o) => o.label), ['Alfa · Administrador · CO', 'Beta · Cobrador · CO']);
    const blocked = decideContext([m('a', 'Beta', 'cobrador', { operable: false })]);
    assert.equal(blocked.kind, 'none');
    assert.equal(blocked.options[0]!.selectable, false);
    assert.match(blocked.options[0]!.notice!, /Servicio suspendido/);
    const mixed = decideContext([m('a', 'Beta', 'cobrador', { operable: false }), m('b', 'Alfa', 'admin')]);
    assert.equal(mixed.kind, 'choose', 'con una suspendida visible, la elección sigue siendo explícita');
    assert.equal(decideContext([m('a', 'Beta', 'cobrador', { status: 'inactivo' })]).options.length, 0);
  });

  test('CLI-002 · el almacén rechaza cualquier clave de tipo contraseña, a cualquier profundidad', () => {
    for (const bad of [{ password: 'x' }, { user: { Password: 'x' } }, { a: [{ pwd: 1 }] }, { contraseña: 'x' }, { clientSecret: 'x' }]) {
      assert.throws(() => assertNoSecrets(bad), SecretInStorageError, JSON.stringify(bad));
    }
    assertNoSecrets({ accessToken: 'a', refreshToken: 'r', expiresAt: 1, identityId: 'i', activeMembershipId: null });
  });

  test('CLI-003 · IndexedDB propia (`adex-server-mode`): guarda solo los campos de sesión; nunca usa RutaCashDB', async () => {
    assert.throws(() => new IndexedDbSessionStore(indexedDB, 'RutaCashDB'));
    const store = new IndexedDbSessionStore();
    await store.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 9, identityId: 'i', activeMembershipId: 'm',
      ...({ extraNoDeclarado: 'x' } as object) } as never);
    assert.deepEqual(await store.load(), { accessToken: 'a', refreshToken: 'r', expiresAt: 9, identityId: 'i', activeMembershipId: 'm' });
    await assert.rejects(store.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 9, identityId: 'i', activeMembershipId: null,
      ...({ password: 'secreta' } as object) } as never), SecretInStorageError);
    await store.clear();
    assert.equal(await store.load(), null);
    const names = (await indexedDB.databases()).map((d) => d.name);
    assert.ok(!names.includes('RutaCashDB'));
  });

  test('CLI-004 · recuperación de acceso por el proveedor: misma respuesta exista o no el correo; nunca envía contraseña', async () => {
    const calls: { url: string; body: string }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      // Supabase responde 200 en ambos casos (anti-enumeración).
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const auth = createSupabaseAuthClient({ url: 'https://staging.example', publishableKey: 'sb_publishable_x', fetchImpl: fakeFetch });
    await auth.recover('existe@example.test');
    await auth.recover('no-existe@example.test');
    assert.deepEqual(calls.map((c) => c.url), ['https://staging.example/auth/v1/recover', 'https://staging.example/auth/v1/recover']);
    assert.ok(calls.every((c) => !/pass/i.test(c.body)));
  });
});
