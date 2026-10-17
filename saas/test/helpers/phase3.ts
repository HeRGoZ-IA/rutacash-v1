// Atajos de las pruebas de la Fase 3 (capital y custodia): comandos de dinero con
// `X-Adex-Operation-Id`, personas sintéticas nuevas y lectura de saldos con el
// administrador de la base (verificación independiente de la API).

import { randomUUID } from 'node:crypto';
import type pg from '../../src/db/pgTypes.ts';
import type { ApiResponse, LocalIssuer, TestServer } from './auth.ts';
import { caller, type Caller } from './phase2.ts';

/** Llamada de dinero: un `operationId` nuevo salvo que se indique (reintentos). */
export type Money = (path: string, body: Record<string, unknown>, operationId?: string) => Promise<ApiResponse & { operationId: string }>;

export function money(call: Caller): Money {
  return async (path, body, operationId = randomUUID()) => ({ ...(await call('POST', path, body, { 'x-adex-operation-id': operationId })), operationId });
}

export interface Person { membershipId: string; identityId: string; call: Caller; money: Money }

/** Alta de una persona sintética por la API (Fase 2) y su llamador. */
export async function newPerson(api: TestServer, issuer: LocalIssuer, ids: Map<string, string>, by: Caller,
  p: { email: string; role: string; displayName: string; routeIds?: string[] }): Promise<Person> {
  const r = await by('POST', '/v1/members', { email: p.email, role: p.role, displayName: p.displayName, routeIds: p.routeIds ?? [] });
  if (r.status !== 201) throw new Error(`alta de ${p.email}: ${r.status} ${JSON.stringify(r.body)}`);
  const membershipId = r.body['membershipId'] as string;
  const identityId = ids.get(p.email.toLowerCase())!;
  const call = caller(api, issuer, identityId, membershipId);
  return { membershipId, identityId, call, money: money(call) };
}

/** Saldo de una cuenta (0 si aún no existe), leído como administrador de la base. */
export async function balance(q: pg.Pool, company: string, kind: string, membership: string | null, route: string | null = null): Promise<number> {
  const r = await q.query<{ b: string }>(
    `select balance_minor::text b from adex.capital_accounts
      where company_id = $1 and kind = $2 and membership_id is not distinct from $3 and route_id is not distinct from $4`,
    [company, kind, membership, route]);
  return Number(r.rows[0]?.b ?? 0);
}

/**
 * Conciliación INDEPENDIENTE de la API (SQL propio): cada saldo = Σ patas, cada
 * operación cuadra con ≥ 2 patas, sin sobregiros (custodia negativa solo por gastos
 * del trabajador) y Σ saldos = 0 (conservación).
 */
export async function reconcile(q: pg.Pool, company: string): Promise<{ mismatched: number; unbalanced: number; overdrawn: number; total: number }> {
  const r = await q.query<{ mismatched: string; unbalanced: string; overdrawn: string; total: string }>(
    `select (select count(*) from adex.capital_accounts a where a.company_id = $1
               and a.balance_minor <> coalesce((select sum(e.amount_minor) from adex.capital_entries e where e.company_id = a.company_id and e.account_id = a.id), 0))::text mismatched,
            (select count(*) from adex.capital_operations o where o.company_id = $1
               and (select coalesce(sum(e.amount_minor), 0) <> 0 or count(*) < 2 from adex.capital_entries e where e.company_id = o.company_id and e.operation_id = o.id))::text unbalanced,
            -- Contrapartidas (externa, socios, interés) pueden ser negativas; la custodia, solo
            -- por un gasto del trabajador (Fase 5, 73209ce), comprobado pata a pata.
            ((select count(*) from adex.capital_accounts where company_id = $1 and kind not in ('external', 'partner', 'income', 'custody') and balance_minor < 0)
             + (select count(*) from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
                  join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
                 where e.company_id = $1 and a.kind = 'custody' and e.amount_minor < 0 and e.balance_after_minor < 0 and o.kind <> 'WORKER_EXPENSE'))::text overdrawn,
            (select coalesce(sum(balance_minor), 0) from adex.capital_accounts where company_id = $1)::text total`, [company]);
  const x = r.rows[0]!;
  return { mismatched: Number(x.mismatched), unbalanced: Number(x.unbalanced), overdrawn: Number(x.overdrawn), total: Number(x.total) };
}

export const CLEAN = { mismatched: 0, unbalanced: 0, overdrawn: 0, total: 0 };
