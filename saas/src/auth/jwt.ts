// Verificación del token de acceso de Supabase Auth (DS-03, validado en 0A.1).
//
//   · Solo ES256/RS256 con el JWKS publicado por el proveedor. HS256 y `alg none`
//     se rechazan: la API no comparte ningún secreto con el proveedor.
//   · `iss`, `aud`, `exp`, `iat`, `sub` (UUID) y `session_id` (UUID) obligatorios.
//   · `role` debe ser `authenticated` (no `anon` ni `service_role`).
//   · NINGUNA autoridad sale del token: empresa, rol y rutas se releen en PostgreSQL.
//
// La verificación es LOCAL. La revocación (cierre de sesión, desactivación) la
// aplica ADEX en PostgreSQL con `session_id` e `iat` (0005).

import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import { ApiError } from '../errors.ts';
import type { SessionClaims } from '../db/tx.ts';

export interface VerifiedToken extends SessionClaims {
  email: string | null;
  expiresAt: number;
}

export interface VerifierConfig {
  /** https://<ref>.supabase.co/auth/v1 */
  issuer: string;
  jwksUrl?: string;
  /** JWKS en memoria (pruebas con el emisor local). */
  jwks?: JSONWebKeySet;
  audience?: string;
  clockToleranceSec?: number;
  now?: () => Date;
}

export type TokenVerifier = (token: string) => Promise<VerifiedToken>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTokenVerifier(cfg: VerifierConfig): TokenVerifier {
  const keySet = cfg.jwks
    ? createLocalJWKSet(cfg.jwks)
    : createRemoteJWKSet(new URL(cfg.jwksUrl ?? `${cfg.issuer.replace(/\/$/, '')}/.well-known/jwks.json`));
  const options = {
    issuer: cfg.issuer,
    audience: cfg.audience ?? 'authenticated',
    clockTolerance: cfg.clockToleranceSec ?? 5,
    algorithms: ['ES256', 'RS256'],
    requiredClaims: ['sub', 'exp', 'iat', 'session_id'],
  };
  return async (token) => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keySet, cfg.now ? { ...options, currentDate: cfg.now() } : options));
    } catch {
      throw new ApiError(401, 'INVALID_TOKEN');
    }
    const sub = payload.sub;
    const sessionId = payload['session_id'];
    if (payload['role'] !== 'authenticated') throw new ApiError(401, 'INVALID_TOKEN');
    if (typeof sub !== 'string' || !UUID_RE.test(sub)) throw new ApiError(401, 'INVALID_TOKEN');
    if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) throw new ApiError(401, 'INVALID_TOKEN');
    if (typeof payload.iat !== 'number' || !Number.isInteger(payload.iat)) throw new ApiError(401, 'INVALID_TOKEN');
    return {
      identityId: sub.toLowerCase(),
      sessionId: sessionId.toLowerCase(),
      iat: payload.iat,
      email: typeof payload['email'] === 'string' ? payload['email'] : null,
      expiresAt: payload.exp as number,
    };
  };
}

export function bearer(header: string | string[] | undefined): string {
  const h = Array.isArray(header) ? header[0] : header;
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) throw new ApiError(401, 'MISSING_TOKEN');
  const token = h.slice(7).trim();
  if (!token) throw new ApiError(401, 'MISSING_TOKEN');
  return token;
}
