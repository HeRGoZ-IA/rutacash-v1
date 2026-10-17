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
    // Un cliente EN USO no tiene el oyente de errores del pool: si el pooler corta la
    // conexión (reinicio, suspensión del alojamiento), un evento 'error' sin oyente
    // tumbaría el proceso. La consulta en curso falla igualmente (la transacción no
    // se confirma o queda incierta, y el cliente la consulta por id) y la conexión
    // rota se descarta en vez de volver al pool.
    let broken: Error | undefined;
    const onError = (e: Error) => { broken = e; };
    client.on('error', onError);
    try {
      // Un solo viaje (protocolo simple, sin parámetros): el valor es un entero propio.
      const lockMs = Math.max(1, Math.trunc(Number(opts.lockTimeoutMs ?? 5000)) || 5000);
      await client.query(`begin isolation level read committed; set local lock_timeout = '${lockMs}ms'`);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch((e: Error) => { broken ??= e; });
      const code = (err as { code?: string }).code ?? '';
      if (RETRYABLE.has(code) && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20 * attempt)));
        continue;
      }
      throw err;
    } finally {
      client.off('error', onError);
      client.release(broken ?? false);
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
