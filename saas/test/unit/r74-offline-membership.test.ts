// R74 · H4: una captura sin conexión se envía con la membresía con la que se REGISTRÓ
// (`OnlineClient.command(..., { membership })`, usado por `online/src/offline/sync.ts`), no con la
// que esté activa al sincronizar. Sin la opción, el comportamiento anterior no cambia.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { OnlineClient } from '../../../online/src/lib/client.ts';

type Seen = { url: string; headers: Record<string, string> };

function clientWithSession(active: string): OnlineClient {
  const c = new OnlineClient({ apiBase: 'http://api.test', supabaseUrl: 'http://auth.test', publishableKey: 'k' });
  // Sesión vigente en memoria (sin red ni almacén): token que no caduca durante la prueba.
  (c as unknown as { session: unknown }).session = {
    accessToken: 'a.b.c', refreshToken: 'r', expiresAt: Math.floor(Date.now() / 1000) + 3600, identityId: 'i-1', activeMembershipId: active,
  };
  return c;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function capture(): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url, headers: init.headers });
    return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return seen;
}

describe('R74 · sincronización sin conexión con la membresía de la operación', () => {
  test('R74-UNIT-OFF-001 · con `membership` el comando viaja con ESA membresía y el mismo id de operación', async () => {
    const seen = capture();
    const c = clientWithSession('m-activa');
    await c.command('POST', '/v1/collections', { saleId: 's' }, 'op-1', { membership: 'm-captura' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.headers['x-adex-membership'], 'm-captura');
    assert.equal(seen[0]!.headers['x-adex-operation-id'], 'op-1');
  });

  test('R74-UNIT-OFF-002 · sin la opción se conserva el comportamiento anterior (membresía activa)', async () => {
    const seen = capture();
    const c = clientWithSession('m-activa');
    await c.command('POST', '/v1/collections', { saleId: 's' }, 'op-2');
    assert.equal(seen[0]!.headers['x-adex-membership'], 'm-activa');
  });
});
