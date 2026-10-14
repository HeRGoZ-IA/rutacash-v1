// IDN-001 · verificación de tokens (DS-03): solo ES256/RS256 con JWKS; iss, aud,
// exp, iat, sub y session_id obligatorios; role = authenticated. Emisor LOCAL con
// formato Supabase: valida el verificador, no el proveedor (ver test/auth-real).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SignJWT, UnsecuredJWT } from 'jose';
import { createTokenVerifier } from '../../src/auth/jwt.ts';
import { ApiError } from '../../src/errors.ts';
import { createLocalIssuer, LOCAL_ISSUER } from '../helpers/auth.ts';

const SUB = '0f2b6d5e-1c3a-4b8f-9d7e-6a5b4c3d2e1f';

async function rejected(p: Promise<unknown>) {
  await assert.rejects(p, (e: unknown) => e instanceof ApiError && e.status === 401 && e.code === 'INVALID_TOKEN');
}

describe('IDN-001 · verificador de tokens de acceso', () => {
  test('acepta un token válido y devuelve SOLO identidad, sesión e iat', async () => {
    const issuer = await createLocalIssuer();
    const v = await issuer.verifier(await issuer.issue(SUB, { sessionId: '11111111-2222-4333-8444-555555555555' }));
    assert.equal(v.identityId, SUB);
    assert.equal(v.sessionId, '11111111-2222-4333-8444-555555555555');
    assert.ok(Number.isInteger(v.iat));
    assert.deepEqual(Object.keys(v).sort(), ['email', 'expiresAt', 'iat', 'identityId', 'sessionId']);
  });

  test('rechaza firma ajena, alg none, HS256, caducado, iss/aud ajenos, rol no autenticado y claims ausentes', async () => {
    const issuer = await createLocalIssuer();
    const now = Math.floor(Date.now() / 1000);
    await rejected(issuer.verifier('basura'));
    await rejected(issuer.verifier(await issuer.issueForged(SUB)));
    await rejected(issuer.verifier(new UnsecuredJWT({ role: 'authenticated', session_id: SUB }).setSubject(SUB).setIssuer(LOCAL_ISSUER)
      .setAudience('authenticated').setIssuedAt().setExpirationTime('1h').encode()));
    await rejected(issuer.verifier(await new SignJWT({ role: 'authenticated', session_id: SUB }).setProtectedHeader({ alg: 'HS256' })
      .setSubject(SUB).setIssuer(LOCAL_ISSUER).setAudience('authenticated').setIssuedAt().setExpirationTime('1h')
      .sign(new TextEncoder().encode('sb_publishable_key_as_hmac_secret_xxxxxxxxxxxx'))));
    await rejected(issuer.verifier(await issuer.issue(SUB, { iat: now - 7200, expSec: 3600 })));
    await rejected(issuer.verifier(await issuer.issue(SUB, { iss: 'https://otro.supabase.co/auth/v1' })));
    await rejected(issuer.verifier(await issuer.issue(SUB, { aud: 'anon' })));
    for (const role of ['anon', 'service_role']) await rejected(issuer.verifier(await issuer.issue(SUB, { role })));
    await rejected(issuer.verifier(await issuer.issue('no-es-uuid')));
    await rejected(issuer.verifier(await issuer.issue(SUB, { omit: ['session_id'] })));
    await rejected(issuer.verifier(await issuer.issue(SUB, { sessionId: 'no-es-uuid' })));
    await rejected(issuer.verifier(await issuer.issue(SUB, { omit: ['iat'] })));
  });

  test('el reloj de verificación es inyectable (expiración determinista de un token real)', async () => {
    const issuer = await createLocalIssuer();
    const token = await issuer.issue(SUB, { expSec: 60 });
    const late = createTokenVerifier({ issuer: LOCAL_ISSUER, jwks: issuer.jwks, now: () => new Date(Date.now() + 120_000) });
    await rejected(late(token));
    const ok = createTokenVerifier({ issuer: LOCAL_ISSUER, jwks: issuer.jwks, now: () => new Date() });
    assert.equal((await ok(token)).identityId, SUB);
  });
});
