// Verificación de tokens con un EMISOR LOCAL (formato Supabase). No es Supabase Auth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, UnsecuredJWT } from 'jose';
import { createSupabaseJwtVerifier } from '../../src/auth/supabaseJwt.ts';
import { ApiError } from '../../src/errors.ts';
import { LOCAL_ISSUER, createLocalIssuer } from '../helpers/issuer.ts';

const SUB = '30000000-0000-4000-8000-000000000001';

async function rejects(p: Promise<unknown>) {
  await assert.rejects(p, (e: unknown) => e instanceof ApiError && e.status === 401 && e.code === 'INVALID_TOKEN');
}

test('ID-005 [unit] token inválido se rechaza con 401', async (t) => {
  const iss = await createLocalIssuer();

  await t.test('token válido → identidad = sub', async () => {
    const id = await iss.verifier(await iss.issue(SUB));
    assert.equal(id.identityId, SUB);
  });
  await t.test('firma con otra clave', async () => rejects(iss.verifier(await iss.issueForged(SUB))));
  await t.test('expirado', async () => rejects(iss.verifier(await iss.issue(SUB, { expSec: -60 }))));
  await t.test('emisor distinto', async () => rejects(iss.verifier(await iss.issue(SUB, { iss: 'https://evil.example/auth/v1' }))));
  await t.test('audiencia distinta', async () => rejects(iss.verifier(await iss.issue(SUB, { aud: 'other' }))));
  await t.test('role anon (clave pública de Supabase) no es identidad', async () => rejects(iss.verifier(await iss.issue(SUB, { role: 'anon' }))));
  await t.test('role service_role no es identidad', async () => rejects(iss.verifier(await iss.issue(SUB, { role: 'service_role' }))));
  await t.test('sub que no es uuid', async () => rejects(iss.verifier(await iss.issue('not-a-uuid'))));
  await t.test('alg none', async () => {
    const unsigned = new UnsecuredJWT({ role: 'authenticated' }).setSubject(SUB).setIssuer(LOCAL_ISSUER).setAudience('authenticated').setIssuedAt().setExpirationTime('1h').encode();
    await rejects(iss.verifier(unsigned));
  });
  await t.test('HS256 sin secreto configurado (confusión de algoritmo)', async () => {
    const hs = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' }).setSubject(SUB).setIssuer(LOCAL_ISSUER).setAudience('authenticated').setIssuedAt().setExpirationTime('1h')
      .sign(new TextEncoder().encode('guessable-secret'));
    await rejects(iss.verifier(hs));
  });
  await t.test('basura y token vacío', async () => {
    await rejects(iss.verifier('abc.def.ghi'));
    await rejects(iss.verifier(''));
  });
});

test('ID-005 [unit] JWKS remoto: la API descarga la clave pública del endpoint /.well-known/jwks.json', async () => {
  const iss = await createLocalIssuer();
  let hits = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      hits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(iss.jwks));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  try {
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/auth/v1`;
    const verifier = createSupabaseJwtVerifier({ issuer: LOCAL_ISSUER, jwksUrl: `${base}/.well-known/jwks.json` });
    assert.equal((await verifier(await iss.issue(SUB))).identityId, SUB);
    await rejects(verifier(await iss.issueForged(SUB)));
    assert.ok(hits >= 1);
  } finally {
    srv.close();
  }
});
