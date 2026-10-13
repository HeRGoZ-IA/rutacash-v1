// EMISOR LOCAL DE TOKENS con el formato de Supabase Auth (claims, ES256, JWKS).
//
// ATENCIÓN: esto NO es Supabase Auth. Sirve para ejercitar la verificación de
// la API y la autorización por membresía sin servicios externos. Las pruebas que
// lo usan NO son evidencia de que Supabase Auth funcione; esa evidencia la da
// test/auth-real (NO EJECUTADA en este entorno, ver informe).

import { randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet, type JWK } from 'jose';
import { createSupabaseJwtVerifier, type TokenVerifier } from '../../src/auth/supabaseJwt.ts';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export const LOCAL_ISSUER = 'http://127.0.0.1:54321/auth/v1';

export interface LocalIssuer {
  jwks: JSONWebKeySet;
  verifier: TokenVerifier;
  issue(sub: string, overrides?: { expSec?: number; iss?: string; aud?: string; role?: string; extra?: Record<string, unknown> }): Promise<string>;
  /** Token firmado con OTRA clave pero el mismo kid (firma inválida). */
  issueForged(sub: string): Promise<string>;
}

export async function createLocalIssuer(): Promise<LocalIssuer> {
  const kid = randomUUID();
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const other = await generateKeyPair('ES256');
  const pub: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const jwks: JSONWebKeySet = { keys: [pub] };

  const sign = (key: SigningKey, sub: string, o: Parameters<LocalIssuer['issue']>[1] = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ role: o.role ?? 'authenticated', session_id: randomUUID(), aal: 'aal1', email: `${sub}@example.test`, ...(o.extra ?? {}) })
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
      .setSubject(sub)
      .setIssuer(o.iss ?? LOCAL_ISSUER)
      .setAudience(o.aud ?? 'authenticated')
      .setIssuedAt(now)
      .setExpirationTime(now + (o.expSec ?? 3600))
      .sign(key);
  };

  return {
    jwks,
    verifier: createSupabaseJwtVerifier({ issuer: LOCAL_ISSUER, jwks }),
    issue: (sub, o) => sign(privateKey, sub, o),
    issueForged: (sub) => sign(other.privateKey, sub),
  };
}
