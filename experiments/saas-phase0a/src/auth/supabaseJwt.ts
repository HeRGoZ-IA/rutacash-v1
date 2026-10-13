// Verificación del token de acceso de Supabase Auth en la API.
//
// Supabase Auth firma sus tokens de acceso (JWT). Con claves asimétricas
// (ES256/RS256) publica las claves públicas en
//   {SUPABASE_URL}/auth/v1/.well-known/jwks.json
// y la API verifica la firma sin compartir ningún secreto. Con la clave legada
// HS256 hay que compartir el "JWT secret" con la API (opción `hs256Secret`).
//
// Esta verificación es LOCAL: comprueba firma, emisor, audiencia y expiración.
// NO detecta un cierre de sesión ni una revocación de la sesión en Supabase
// antes de `exp` (para eso habría que consultar /auth/v1/user en cada petición).
// La revocación de PERMISOS no depende de esto: la membresía se relee en
// PostgreSQL en cada operación (ver authz/context.ts).

import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import { ApiError } from '../errors.ts';

export interface VerifiedIdentity {
  identityId: string;   // claim `sub` = auth.users.id
  sessionId: string | null;
  email: string | null;
  expiresAt: number;
}

export interface SupabaseVerifierConfig {
  /** p. ej. https://<ref>.supabase.co/auth/v1  ·  local: http://127.0.0.1:54321/auth/v1 */
  issuer: string;
  /** JWKS remoto (por defecto `${issuer}/.well-known/jwks.json`). */
  jwksUrl?: string;
  /** JWKS en memoria (solo pruebas). */
  jwks?: JSONWebKeySet;
  /** Clave legada HS256. Si no se configura, HS256 se rechaza. */
  hs256Secret?: string;
  audience?: string;
  clockToleranceSec?: number;
}

export type TokenVerifier = (token: string) => Promise<VerifiedIdentity>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSupabaseJwtVerifier(cfg: SupabaseVerifierConfig): TokenVerifier {
  const audience = cfg.audience ?? 'authenticated';
  const keySet = cfg.jwks
    ? createLocalJWKSet(cfg.jwks)
    : createRemoteJWKSet(new URL(cfg.jwksUrl ?? `${cfg.issuer.replace(/\/$/, '')}/.well-known/jwks.json`));
  const hsKey = cfg.hs256Secret ? new TextEncoder().encode(cfg.hs256Secret) : null;
  const options = {
    issuer: cfg.issuer,
    audience,
    clockTolerance: cfg.clockToleranceSec ?? 5,
    requiredClaims: ['sub', 'exp', 'iat'],
  };

  return async (token: string): Promise<VerifiedIdentity> => {
    let payload: JWTPayload;
    try {
      const alg = readAlg(token);
      if (alg === 'HS256') {
        if (!hsKey) throw new Error('HS256 not configured');
        ({ payload } = await jwtVerify(token, hsKey, { ...options, algorithms: ['HS256'] }));
      } else {
        ({ payload } = await jwtVerify(token, keySet, { ...options, algorithms: ['ES256', 'RS256'] }));
      }
    } catch {
      throw new ApiError(401, 'INVALID_TOKEN');
    }
    // Supabase emite role=authenticated para usuarios con sesión; anon/service_role no son identidades.
    if (payload['role'] !== 'authenticated') throw new ApiError(401, 'INVALID_TOKEN', 'token role is not authenticated');
    if (typeof payload.sub !== 'string' || !UUID_RE.test(payload.sub)) throw new ApiError(401, 'INVALID_TOKEN', 'sub is not a uuid');
    return {
      identityId: payload.sub.toLowerCase(),
      sessionId: typeof payload['session_id'] === 'string' ? payload['session_id'] : null,
      email: typeof payload['email'] === 'string' ? payload['email'] : null,
      expiresAt: payload.exp as number,
    };
  };
}

function readAlg(token: string): string {
  const header = token.split('.')[0];
  if (!header) throw new Error('malformed');
  const parsed = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: unknown };
  if (typeof parsed.alg !== 'string') throw new Error('no alg');
  return parsed.alg;
}
