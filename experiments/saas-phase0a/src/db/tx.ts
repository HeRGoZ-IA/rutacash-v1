import type pg from 'pg';

// SQLSTATE reintentables: fallo de serialización y deadlock detectado.
const RETRYABLE = new Set(['40001', '40P01']);

export function isRetryable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && RETRYABLE.has((err as { code?: string }).code ?? '');
}

export interface TxOptions {
  maxAttempts?: number;
  onRetry?: (attempt: number, err: unknown) => void;
}

/**
 * Una petición = una transacción en una conexión del pool. Si PostgreSQL aborta
 * por deadlock (40P01) o serialización (40001), se reintenta la transacción
 * COMPLETA (todo se revirtió) con espera aleatoria acotada.
 */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('begin isolation level read committed');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      if (isRetryable(err) && attempt < maxAttempts) {
        opts.onRetry?.(attempt, err);
        await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20 * attempt)));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Fija el contexto de RLS solo para la transacción en curso (is_local = true). */
export async function setDbContext(
  client: pg.PoolClient,
  ctx: { identityId: string; membershipId?: string | null; companyId?: string | null },
): Promise<void> {
  await client.query(
    `select set_config('adex.identity_id', $1, true),
            set_config('adex.membership_id', $2, true),
            set_config('adex.company_id', $3, true)`,
    [ctx.identityId, ctx.membershipId ?? '', ctx.companyId ?? ''],
  );
}
