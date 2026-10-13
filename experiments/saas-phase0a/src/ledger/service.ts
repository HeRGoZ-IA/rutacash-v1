// Libro financiero SINTÉTICO. No reutiliza ni sustituye saleRequestService ni
// ningún comando real de ADEX; solo demuestra el patrón transaccional.
//
// Orden fijo dentro de la transacción (mismo orden en todos los comandos):
//   1. permiso del rol de la membresía activa
//   2. reclamar la clave de idempotencia (índice único → una petición duplicada
//      concurrente espera aquí hasta que la primera confirme o revierta)
//   3. SELECT … FOR UPDATE de la fila de saldo
//   4. regla de negocio (saldo suficiente)
//   5. UPDATE del saldo → INSERT del movimiento → INSERT de la auditoría
//   6. resultado guardado en la operación
// Todo en UNA transacción: si cualquier paso falla, no queda nada escrito.

import { createHash } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import { MoneyError, formatMinor, parseAmount } from '../money.ts';
import { can, roleAllows, type Permission } from '../authz/permissions.ts';
import { UUID_RE, type ActiveContext } from '../authz/context.ts';

export interface LedgerCommand {
  kind: 'deposit' | 'withdrawal';
  accountId: string;
  operationId: unknown;
  amount: unknown;
}

/** Puntos de inyección SOLO para pruebas (pausar o provocar fallos). La API HTTP de producción no los configura. */
export interface HookInfo {
  operationId: string;
  accountId: string;
  client: pg.PoolClient;
}
export interface LedgerHooks {
  afterAccountLocked?: (info: HookInfo) => Promise<void>;
  afterBalanceUpdate?: (info: HookInfo) => Promise<void>;
  afterMovementInsert?: (info: HookInfo) => Promise<void>;
}

export interface CommandResult {
  status: number;
  body: Record<string, unknown>;
}

interface AccountRow {
  id: string;
  route_id: string | null;
  name: string;
  balance_minor: string;
}

function permissionFor(kind: LedgerCommand['kind']): Permission {
  return kind === 'deposit' ? 'ledger.deposit' : 'ledger.withdraw';
}

async function audit(
  client: pg.PoolClient,
  ctx: ActiveContext,
  entry: { action: string; entityId: string; operationId: string; outcome: 'approved' | 'rejected'; detail: Record<string, unknown> },
): Promise<void> {
  await client.query(
    `insert into adex.audit_log (company_id, identity_id, membership_id, role, action, entity_type, entity_id, operation_id, outcome, detail)
     values ($1, $2, $3, $4, $5, 'account', $6, $7, $8, $9)`,
    [ctx.companyId, ctx.identityId, ctx.membershipId, ctx.role, entry.action, entry.entityId, entry.operationId, entry.outcome, JSON.stringify(entry.detail)],
  );
}

export async function executeLedgerCommand(
  client: pg.PoolClient,
  ctx: ActiveContext,
  cmd: LedgerCommand,
  hooks: LedgerHooks = {},
): Promise<CommandResult> {
  const permission = permissionFor(cmd.kind);
  if (!roleAllows(ctx.role, permission)) throw new ApiError(403, 'PERMISSION_DENIED');
  if (typeof cmd.operationId !== 'string' || !UUID_RE.test(cmd.operationId)) throw new ApiError(400, 'INVALID_OPERATION_ID');
  if (!UUID_RE.test(cmd.accountId)) throw new ApiError(404, 'ACCOUNT_NOT_FOUND');
  const operationId = cmd.operationId.toLowerCase();
  const accountId = cmd.accountId.toLowerCase();

  let amountMinor: bigint;
  try {
    amountMinor = parseAmount(cmd.amount, ctx.company.minorUnits);
  } catch (e) {
    if (e instanceof MoneyError) throw new ApiError(400, e.code, e.message);
    throw e;
  }
  if (amountMinor <= 0n) throw new ApiError(400, 'AMOUNT_NOT_POSITIVE');

  const fmt = (v: bigint) => formatMinor(v, ctx.company.minorUnits);
  const requestHash = createHash('sha256')
    .update(JSON.stringify([cmd.kind, accountId, amountMinor.toString(), ctx.membershipId]))
    .digest('hex');

  // 2. Idempotencia.
  const claim = await client.query(
    `insert into adex.operations (company_id, operation_id, kind, request_hash, membership_id, outcome)
     values ($1, $2, $3, $4, $5, 'pending')
     on conflict (company_id, operation_id) do nothing
     returning operation_id`,
    [ctx.companyId, operationId, cmd.kind, requestHash, ctx.membershipId],
  );
  if (claim.rowCount === 0) {
    const prev = await client.query<{ request_hash: string; http_status: number | null; result: Record<string, unknown> | null }>(
      'select request_hash, http_status, result from adex.operations where company_id = $1 and operation_id = $2',
      [ctx.companyId, operationId],
    );
    const row = prev.rows[0];
    if (!row || row.request_hash !== requestHash || row.http_status === null || row.result === null) {
      throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'operationId already used with different parameters');
    }
    return { status: row.http_status, body: { ...row.result, replayed: true } };
  }

  // 3. Bloqueo de la fila de saldo. RLS ya oculta cuentas de otra empresa o fuera del alcance.
  const acc = await client.query<AccountRow>(
    'select id, route_id, name, balance_minor from adex.accounts where id = $1 and company_id = $2 for update',
    [accountId, ctx.companyId],
  );
  const account = acc.rows[0];
  if (!account) throw new ApiError(404, 'ACCOUNT_NOT_FOUND');
  if (!can(ctx, permission, { routeId: account.route_id })) throw new ApiError(404, 'ACCOUNT_NOT_FOUND');
  await hooks.afterAccountLocked?.({ operationId, accountId, client });

  const balance = BigInt(account.balance_minor);
  const base = { operationId, accountId, kind: cmd.kind, amount: fmt(amountMinor), currency: ctx.company.currencyCode };

  // 4. Regla de negocio: el rechazo se registra (auditoría + operación) para que un reintento devuelva lo mismo.
  if (cmd.kind === 'withdrawal' && balance < amountMinor) {
    const result = { ...base, outcome: 'rejected', reason: 'INSUFFICIENT_FUNDS', balance: fmt(balance) };
    await audit(client, ctx, { action: 'ledger.withdrawal', entityId: accountId, operationId, outcome: 'rejected', detail: result });
    await client.query(
      `update adex.operations set outcome = 'rejected', http_status = 422, result = $3 where company_id = $1 and operation_id = $2`,
      [ctx.companyId, operationId, JSON.stringify(result)],
    );
    return { status: 422, body: result };
  }

  // 5. Saldo → movimiento → auditoría.
  let newBalance: bigint;
  try {
    const upd = await client.query<{ balance_minor: string }>(
      `update adex.accounts
          set balance_minor = balance_minor ${cmd.kind === 'deposit' ? '+' : '-'} $2::bigint, updated_at = now()
        where id = $1 and company_id = $3
        returning balance_minor`,
      [accountId, amountMinor.toString(), ctx.companyId],
    );
    if (upd.rowCount !== 1) throw new ApiError(404, 'ACCOUNT_NOT_FOUND');
    newBalance = BigInt((upd.rows[0] as { balance_minor: string }).balance_minor);
  } catch (e) {
    if ((e as { code?: string }).code === '22003') throw new ApiError(422, 'AMOUNT_OUT_OF_RANGE');
    throw e;
  }
  await hooks.afterBalanceUpdate?.({ operationId, accountId, client });

  const mv = await client.query<{ id: string }>(
    `insert into adex.movements (company_id, account_id, operation_id, kind, amount_minor, balance_after_minor, currency_code, identity_id, membership_id, role)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [ctx.companyId, accountId, operationId, cmd.kind, amountMinor.toString(), newBalance.toString(), ctx.company.currencyCode, ctx.identityId, ctx.membershipId, ctx.role],
  );
  await hooks.afterMovementInsert?.({ operationId, accountId, client });

  const result = { ...base, outcome: 'approved', movementId: (mv.rows[0] as { id: string }).id, balanceAfter: fmt(newBalance) };
  await audit(client, ctx, { action: `ledger.${cmd.kind}`, entityId: accountId, operationId, outcome: 'approved', detail: result });
  await client.query(
    `update adex.operations set outcome = 'approved', http_status = 201, result = $3 where company_id = $1 and operation_id = $2`,
    [ctx.companyId, operationId, JSON.stringify(result)],
  );
  return { status: 201, body: result };
}

export async function listAccounts(client: pg.PoolClient, ctx: ActiveContext) {
  if (!roleAllows(ctx.role, 'account.read')) throw new ApiError(403, 'PERMISSION_DENIED');
  const r = await client.query<AccountRow>('select id, route_id, name, balance_minor from adex.accounts where company_id = $1 order by name', [ctx.companyId]);
  return r.rows.filter((a) => can(ctx, 'account.read', { routeId: a.route_id })).map((a) => present(ctx, a));
}

export async function getAccount(client: pg.PoolClient, ctx: ActiveContext, accountId: string) {
  if (!roleAllows(ctx.role, 'account.read')) throw new ApiError(403, 'PERMISSION_DENIED');
  if (!UUID_RE.test(accountId)) throw new ApiError(404, 'ACCOUNT_NOT_FOUND');
  const r = await client.query<AccountRow>('select id, route_id, name, balance_minor from adex.accounts where id = $1 and company_id = $2', [accountId, ctx.companyId]);
  const a = r.rows[0];
  if (!a || !can(ctx, 'account.read', { routeId: a.route_id })) throw new ApiError(404, 'ACCOUNT_NOT_FOUND');
  return present(ctx, a);
}

function present(ctx: ActiveContext, a: AccountRow) {
  return {
    id: a.id,
    routeId: a.route_id,
    name: a.name,
    balance: formatMinor(BigInt(a.balance_minor), ctx.company.minorUnits),
    currency: ctx.company.currencyCode,
  };
}
