// Administración de la EMPRESA DEMO (ADEX Online v1): crear, reiniciar, eliminar y
// recrear. Autoridad propia (`adex_demo.operators`), rol de base de datos propio
// (`adex_demo`) y auditoría externa (`adex_demo.events`). Ver 0011.
//
//   · El ciclo de vida (hueco, congelación, retirada) lo deciden funciones de
//     PostgreSQL que serializan sobre el hueco: dos operaciones simultáneas nunca
//     se mezclan (la segunda recibe DEMO_BUSY).
//   · El ESCENARIO se ejecuta con la API de empresa normal (`CompanyExecutor`) y
//     puestos sintéticos: mismo motor, mismas reglas, mismas transacciones.
//   · Tras el escenario se exige la conciliación del libro (como SuperAdmin
//     sintético) antes de activar la Demo; si falla, la Demo nueva se retira y, en un
//     reinicio, la anterior se descongela intacta.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import { setDbContext, withTransaction, type SessionClaims } from '../db/tx.ts';
import type { IdentityProvider } from '../auth/provider.ts';
import type { CompanyExecutor } from '../http/companyApi.ts';
import { DEFAULT_COMPANY, SCENARIO_VERSION, SEATS, runScenario, type DemoCompanySpec, type ScenarioCall, type SeatSpec } from './scenario.ts';
import { HISTORY_COMPANY, HISTORY_SEATS, HISTORY_VERSION, runHistoryScenario } from './history.ts';

export const SLOT_RE = /^[a-z][a-z0-9-]{1,30}$/;

/** Errores de conexión o autenticación transitorios del pooler (se reintentan en el escenario histórico). */
const TRANSIENT = new Set(['28P01', '08000', '08003', '08006', '57P01', '57P03', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);

export interface DemoServiceOptions {
  /** Pool conectado como `adex_demo`. */
  pool: pg.Pool;
  /** API de empresa en proceso (pool `adex_api`), para ejecutar el escenario. */
  execute: CompanyExecutor;
  provider: IdentityProvider;
  onError?: (err: unknown) => void;
  /** Solo pruebas: se llama entre pasos del escenario. */
  onScenarioStep?: (call: ScenarioCall) => Promise<void>;
  /**
   * Escenario de las Demos que se creen o reinicien. `demo-v1` (por defecto): estructura
   * mínima del día. `demo-v2-6m`: seis meses de operación registrada día a día (history.ts).
   */
  scenario?: 'demo-v1' | 'demo-v2-6m';
  /** demo-v2-6m: días de historia y escala de clientes (las pruebas usan valores pequeños). */
  historyDays?: number;
  historyScale?: number;
  onHistoryProgress?: (info: { day: string; index: number; total: number; calls: number }) => void;
}

type Seats = { seat: string; role: string; membershipId: string }[];

/** Una transacción del plano Demo: contexto de sesión SIN empresa ni membresía. */
async function inDemo<T>(pool: pg.Pool, claims: SessionClaims, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(pool, async (c) => {
    await setDbContext(c, claims);
    const s = (await c.query<{ s: string }>('select adex_demo.operator_status() s')).rows[0]!.s;
    if (s === 'session_revoked') throw new ApiError(401, 'SESSION_REVOKED');
    if (s !== 'ok') throw new ApiError(403, 'DEMO_OPERATOR_REQUIRED');
    return fn(c);
  }, { lockTimeoutMs: 15_000 });
}

function slotOf(slot: string): string {
  if (!SLOT_RE.test(slot)) throw new ApiError(400, 'INVALID_SLOT');
  return slot;
}

function targetOf(body: Record<string, unknown>): string {
  const id = body['companyId'];
  // ID interno exacto y confirmado: nunca por nombre.
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new ApiError(400, 'COMPANY_ID_REQUIRED');
  if (body['confirm'] !== id) throw new ApiError(400, 'CONFIRMATION_MISMATCH');
  return id;
}

export function createDemoService(opts: DemoServiceOptions) {
  const history = opts.scenario === 'demo-v2-6m';
  const SEATS_IN_USE: readonly SeatSpec[] = history ? HISTORY_SEATS : SEATS;
  const ASSIGNABLE_SEATS = SEATS_IN_USE.filter((s) => s.assignable).map((s) => s.seat);
  const VERSION = history ? HISTORY_VERSION : SCENARIO_VERSION;
  const COMPANY = history ? HISTORY_COMPANY : DEFAULT_COMPANY;
  function specOf(body: Record<string, unknown>): DemoCompanySpec {
    const name = body['name'];
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 80)) throw new ApiError(400, 'INVALID_NAME');
    return { ...COMPANY, name: typeof name === 'string' ? name.trim() : COMPANY.name };
  }
  const running = new Set<string>();

  async function status(claims: SessionClaims, slot: string) {
    return inDemo(opts.pool, claims, async (c) => ({
      ...(await c.query<{ s: Record<string, unknown> }>('select adex_demo.status($1) s', [slotOf(slot)])).rows[0]!.s,
      jobRunning: running.has(slot),
      assignableSeats: SEATS_IN_USE.filter((s) => s.assignable).map((s) => ({ seat: s.seat, role: s.role })),
      scenario: VERSION,
    }));
  }

  /** Rechazo auditado aparte (la transacción rechazada se revirtió). */
  async function recordRejection(claims: SessionClaims, slot: string, company: string | null, action: string, err: unknown) {
    const code = err instanceof ApiError ? err.code : (err as { code?: string }).code ?? 'ERROR';
    try {
      await inDemo(opts.pool, claims, (c) => c.query('select adex_demo.record_event($1, $2, $3, $4, $5)',
        [slot, company, action, 'rejected', JSON.stringify({ code })]));
    } catch { /* sin operador válido: no hay a quién atribuirlo */ }
  }

  /** Escenario + conciliación con puestos sintéticos de la empresa nueva. */
  async function provision(claims: SessionClaims, companyId: string, seats: Seats, timezone: string) {
    const actors = new Map<string, { identityId: string; membershipId: string }>();
    const actor = async (seat: string) => {
      const hit = actors.get(seat);
      if (hit) return hit;
      const lookup = () => inDemo(opts.pool, claims, (c) => c.query<{ identity_id: string; membership_id: string }>(
        'select identity_id, membership_id from adex_demo.synthetic_actor($1, $2)', [companyId, seat]));
      let r: Awaited<ReturnType<typeof lookup>>;
      for (let attempt = 0; ; attempt++) {
        try { r = await lookup(); break; } catch (err) {
          if (!history || attempt >= 8 || !TRANSIENT.has((err as { code?: string }).code ?? '')) throw err;
          await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
        }
      }
      const row = r.rows[0];
      // Nunca se actúa con un puesto ocupado por una persona.
      if (!row) throw new ApiError(409, 'DEMO_SEAT_NOT_SYNTHETIC');
      const a = { identityId: row.identity_id, membershipId: row.membership_id };
      actors.set(seat, a);
      return a;
    };
    const run = async (call: ScenarioCall) => {
      await opts.onScenarioStep?.(call);
      const a = await actor(call.seat);
      // Sesión propia del actor sintético (no tiene cuenta de acceso; nadie más la usa).
      const actorClaims: SessionClaims = { identityId: a.identityId, sessionId: randomUUID(), iat: Math.floor(Date.now() / 1000) };
      // Igual que el servidor HTTP: la ruta sin la consulta, y la consulta aparte.
      const url = new URL(call.path, 'http://demo.local');
      const operationId = call.operation ? randomUUID() : null;
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await opts.execute(actorClaims, { method: call.method, path: url.pathname, query: url.searchParams, membershipId: a.membershipId,
            operationId, body: call.body, ...(call.day ? { seedDay: call.day } : {}) });
          break;
        } catch (err) {
          const code = (err as { code?: string }).code;
          // Interbloqueo o fallo de serialización: la transacción se revirtió entera; se repite igual.
          if ((code === '40P01' || code === '40001') && attempt < 6) { await new Promise((r) => setTimeout(r, 100 * (attempt + 1))); continue; }
          // Escenario histórico: conexión caída o rechazo transitorio del pooler. Se repite con el
          // MISMO id de operación: si el comando llegó a confirmarse, el servidor devuelve ese
          // resultado guardado y nunca lo duplica.
          if (history && attempt < 8 && (TRANSIENT.has(code ?? '') || /Connection terminated|ECONNRESET|ETIMEDOUT|ENOTFOUND|timeout exceeded/i.test(String((err as Error).message)))) {
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
            continue;
          }
          if (history) {
            const e = err as Error & { code?: string; details?: unknown };
            throw new ApiError(500, 'DEMO_SCENARIO_STEP_FAILED',
              `${call.seat} ${call.method} ${url.pathname} (${call.day ?? ''}) → ${e.code ?? ''} ${e.message} ${JSON.stringify(e.details ?? '')} ${JSON.stringify(call.body ?? {}).slice(0, 300)}`);
          }
          throw err;
        }
      }
      // Escenario histórico: cualquier rechazo detiene la inicialización (la Demo nueva se
      // retira y la anterior sigue intacta). Nunca se sigue con una historia a medias.
      if (history && res.status >= 400) {
        throw new ApiError(500, 'DEMO_SCENARIO_STEP_FAILED', `${call.method} ${call.path.split('?')[0]} (${call.day ?? ''}) → ${res.status} ${JSON.stringify(res.body)}`);
      }
      return res.body as Record<string, unknown>;
    };
    const membership = (seat: string) => {
      const s = seats.find((x) => x.seat === seat);
      if (!s) throw new Error(`scenario: unknown seat ${seat}`);
      return s.membershipId;
    };
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const summary = history
      ? await runHistoryScenario(run, membership, { today, days: opts.historyDays ?? 182, scale: opts.historyScale, onProgress: opts.onHistoryProgress })
      : await runScenario(run, membership, today);
    const rec = await run({ seat: 'direccion', method: 'GET', path: '/v1/capital/reconciliation' }) as { ok?: boolean; checks?: { name: string; ok: boolean }[] };
    if (rec.ok !== true) throw new ApiError(500, 'DEMO_RECONCILIATION_FAILED');
    return { summary, reconciliation: { ok: true, checks: (rec.checks ?? []).map((c) => ({ name: c.name, ok: c.ok })) } };
  }

  async function finishOrAbort(claims: SessionClaims, slot: string, companyId: string, timezone: string, seats: Seats) {
    try {
      const result = await provision(claims, companyId, seats, timezone);
      return await inDemo(opts.pool, claims, async (c) => (await c.query<{ r: Record<string, unknown> }>(
        'select adex_demo.finish_provision($1, $2, $3) r', [slot, companyId, JSON.stringify(result)])).rows[0]!.r);
    } catch (err) {
      opts.onError?.(err);
      const message = err instanceof ApiError ? err.code : (err as { code?: string }).code ?? 'PROVISIONING_ERROR';
      await inDemo(opts.pool, claims, (c) => c.query('select adex_demo.abort_provision($1, $2, $3)', [slot, companyId, message]));
      throw err instanceof ApiError ? err : new ApiError(500, 'DEMO_PROVISIONING_FAILED');
    }
  }

  function seatsJson() {
    return JSON.stringify(SEATS_IN_USE.map((s) => ({ seat: s.seat, role: s.role, displayName: s.displayName, assignable: s.assignable })));
  }

  /**
   * Ejecuta el ciclo de vida. Con `wait=false` responde en cuanto la empresa nueva
   * existe (202) y termina en segundo plano; el estado se consulta con `status`.
   */
  async function lifecycle(claims: SessionClaims, slot: string, action: 'CREATE' | 'RESET', target: string | null,
    spec: DemoCompanySpec, wait: boolean) {
    const companyId = randomUUID();
    let seats: Seats;
    try {
      seats = await inDemo(opts.pool, claims, async (c) => {
        const args = [companyId, spec.name, spec.countryCode, spec.countryLabel, spec.currencyCode, spec.timezone, VERSION, seatsJson()];
        const r = action === 'CREATE'
          ? await c.query<{ s: Seats }>('select adex_demo.begin_create($1, $2, $3, $4, $5, $6, $7, $8, $9) s', [slot, ...args])
          : await c.query<{ s: Seats }>('select adex_demo.begin_reset($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) s', [slot, target, ...args]);
        return r.rows[0]!.s;
      });
    } catch (err) {
      await recordRejection(claims, slot, target, action, err);
      throw err;
    }
    running.add(slot);
    const job = finishOrAbort(claims, slot, companyId, spec.timezone, seats).finally(() => running.delete(slot));
    if (wait) return { status: 200, body: { companyId, previousCompanyId: target, ...(await job) } };
    job.catch(() => undefined);
    return { status: 202, body: { companyId, previousCompanyId: target, state: action === 'CREATE' ? 'provisioning' : 'resetting' } };
  }

  return {
    status,
    async create(claims: SessionClaims, slot: string, body: Record<string, unknown>, wait = true) {
      return lifecycle(claims, slotOf(slot), 'CREATE', null, specOf(body), wait);
    },
    async reset(claims: SessionClaims, slot: string, body: Record<string, unknown>, wait = true) {
      slotOf(slot);
      const target = targetOf(body);
      return lifecycle(claims, slot, 'RESET', target, specOf({ name: body['name'] }), wait);
    },
    async remove(claims: SessionClaims, slot: string, body: Record<string, unknown>) {
      slotOf(slot);
      const target = targetOf(body);
      try {
        await inDemo(opts.pool, claims, (c) => c.query('select adex_demo.delete_company($1, $2)', [slot, target]));
      } catch (err) {
        await recordRejection(claims, slot, target, 'DELETE', err);
        throw err;
      }
      return { status: 200, body: { deleted: true, companyId: target } };
    },
    /** Invitación con el procedimiento del proveedor (alta sin contraseña conocida por nadie). */
    async setParticipant(claims: SessionClaims, slot: string, seat: string, body: Record<string, unknown>) {
      slotOf(slot);
      if (!ASSIGNABLE_SEATS.includes(seat)) throw new ApiError(400, 'SEAT_NOT_ASSIGNABLE');
      const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) throw new ApiError(400, 'INVALID_EMAIL');
      const displayName = typeof body['displayName'] === 'string' ? body['displayName'].trim() : '';
      if (!displayName || displayName.length > 80) throw new ApiError(400, 'INVALID_NAME');
      // Antes de invitar: solo un operador válido puede provocar una alta en el proveedor.
      await inDemo(opts.pool, claims, async () => undefined);
      const role = SEATS_IN_USE.find((s) => s.seat === seat)!.role;
      const { identityId } = await opts.provider.ensureIdentity(email);
      await inDemo(opts.pool, claims, async (c) => {
        // Una persona no ocupa dos puestos del mismo rol (una membresía por empresa y rol, DS-05).
        const clash = await c.query<{ s: Record<string, unknown> }>('select adex_demo.status($1) s', [slot]);
        const participants = (clash.rows[0]!.s['participants'] as { seat: string; email: string }[]) ?? [];
        const sameRole = participants.find((p) => p.email === email && p.seat !== seat && SEATS_IN_USE.find((s) => s.seat === p.seat)?.role === role);
        if (sameRole) throw new ApiError(409, 'PARTICIPANT_ROLE_DUPLICATE');
        await c.query('select adex_demo.set_participant($1, $2, $3, $4, $5)', [slot, seat, identityId, email, displayName]);
      });
      return { status: 200, body: { seat, email, appliesOn: 'next create or reset' } };
    },
    /**
     * Recuperación: un aprovisionamiento interrumpido (p. ej. reinicio del proceso) deja
     * el hueco en `provisioning`/`resetting` sin trabajo vivo. Se aborta como un fallo:
     * la empresa a medio crear se retira y, en un reinicio, la anterior se descongela.
     */
    async abort(claims: SessionClaims, slot: string, body: Record<string, unknown>) {
      slotOf(slot);
      const target = targetOf(body);
      if (running.has(slot)) throw new ApiError(409, 'DEMO_BUSY');
      await inDemo(opts.pool, claims, (c) => c.query('select adex_demo.abort_provision($1, $2, $3)', [slot, target, 'aborted_by_operator']));
      return { status: 200, body: { aborted: true, companyId: target } };
    },
    async removeParticipant(claims: SessionClaims, slot: string, seat: string) {
      slotOf(slot);
      if (!ASSIGNABLE_SEATS.includes(seat)) throw new ApiError(400, 'SEAT_NOT_ASSIGNABLE');
      await inDemo(opts.pool, claims, (c) => c.query('select adex_demo.remove_participant($1, $2)', [slot, seat]));
      return { status: 200, body: { seat, removed: true } };
    },
  };
}

export type DemoService = ReturnType<typeof createDemoService>;
