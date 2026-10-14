// Una petición = una transacción en una conexión del pool. El contexto RLS se fija
// con set_config(…, true): vive solo dentro de la transacción, así que es seguro con
// el pooler de Supabase en modo transacción (validado en 0A.1 MANAGED-CONN-001).

import pg from './pgTypes.ts';

const RETRYABLE = new Set(['40001', '40P01']);

export interface TxOptions {
  maxAttempts?: number;
  /** Espera máxima de un bloqueo (REVOKE-004). Por defecto 5 s. */
  lockTimeoutMs?: number;
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('begin isolation level read committed');
      await client.query(`select set_config('lock_timeout', $1, true)`, [`${opts.lockTimeoutMs ?? 5000}ms`]);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      const code = (err as { code?: string }).code ?? '';
      if (RETRYABLE.has(code) && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20 * attempt)));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Identidad verificada del token. Nunca contiene permisos (DS-03/DS-05). */
export interface SessionClaims {
  identityId: string;
  sessionId: string;
  /** `iat` del token, en segundos. */
  iat: number;
}

export interface DbContextInput extends SessionClaims {
  membershipId?: string | null;
  companyId?: string | null;
}

export async function setDbContext(client: pg.PoolClient, ctx: DbContextInput): Promise<void> {
  await client.query(
    `select set_config('adex.identity_id', $1, true), set_config('adex.session_id', $2, true),
            set_config('adex.token_iat', $3, true), set_config('adex.membership_id', $4, true),
            set_config('adex.company_id', $5, true)`,
    [ctx.identityId, ctx.sessionId, String(ctx.iat), ctx.membershipId ?? '', ctx.companyId ?? ''],
  );
}
