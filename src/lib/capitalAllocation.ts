// ============================================================
// CAPITAL POR ADMINISTRADOR — FÓRMULAS PURAS (sin Dexie) · v16
// ------------------------------------------------------------
// Cadena: SuperAdmin (bolsa de la empresa) → Administrador (su bolsa) → Ruta.
//
// FUENTES (ninguna se duplica):
//   · capitalLedger           empresa ↔ externo, empresa ↔ Admin y traspasos de la
//                             responsabilidad de una ruta entre Admins.
//   · CapitalMovement.adminId Admin → Ruta (capital colocado).
//   · Withdrawal.adminId      Ruta → Admin (retiro que vuelve a su bolsa).
//   · Transfer.adminId        Ruta → Ruta del MISMO responsable (traslado interno).
//
// "Capital colocado" de una ruta (lo que gestiona su responsable) =
//     capital − retiros ± traslados Ruta↔Ruta
// Los aportes y salidas de SOCIOS (Transfer con un extremo 'partner') pertenecen a
// Caja socios: mueven la Base de la ruta pero no las bolsas de los Administradores.
// Cobros, desembolsos y gastos tampoco: son operación, no capital estructural.
//
// DEFINICIONES (por Administrador a):
//   disponible(a) = asignaciones − devoluciones − capital colocado + retiros recibidos
//   enRutas(a)    = Σ_ruta colocado(a, ruta)       (incluye traspasos de responsabilidad)
//   asignado(a)   = disponible(a) + enRutas(a)     (identidad por construcción)
//
// Por ruta r:
//   colocado(a, r)  = capital(a) − retiros(a) ± traslados(a) + traspasos a a − traspasos desde a
//   sinResponsable(r) = capitalColocado(r) − Σ_a colocado(a, r)
//     (capital anterior a v16 aún no reconocido, o de una ruta que quedó sin responsable)
//
// Empresa:
//   disponibleEmpresa = depósitos − retiros de la empresa − asignaciones + devoluciones
//
// IDENTIDAD DE CONSERVACIÓN (se verifica en `verifyCapitalInvariants`):
//   depósitos − retirosEmpresa + capitalHistóricoPreV16
//     = disponibleEmpresa + Σ asignado(a) + Σ sinResponsable(r)
// Ninguna operación de la cadena crea ni destruye dinero: solo lo cambia de bolsa.
// ============================================================
import type {
  CapitalLedgerEntry, CapitalMovement, Route, RouteCapitalControllerEvent, Transfer, User, Withdrawal,
} from '@/models/types'

export interface CapitalRows {
  routes: Pick<Route, 'id' | 'tenantId' | 'nombre' | 'capitalControllerAdminId'>[]
  ledger: CapitalLedgerEntry[]
  capitalMovements: Pick<CapitalMovement, 'routeId' | 'valor' | 'adminId'>[]
  withdrawals: Pick<Withdrawal, 'routeId' | 'valor' | 'adminId'>[]
  transfers: Pick<Transfer, 'routeOrigenId' | 'routeDestinoId' | 'origenType' | 'destinoType' | 'valor' | 'adminId'>[]
}

/** ¿Es un traslado Ruta → Ruta? (las transferencias antiguas sin tipo son de ruta). */
export function isRouteToRouteTransfer(t: CapitalRows['transfers'][number]): boolean {
  return (t.origenType ?? 'route') === 'route' && (t.destinoType ?? 'route') === 'route'
    && !!t.routeOrigenId && !!t.routeDestinoId
}

const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0)

/** Capital colocado en la ruta (todas las bolsas, incluido lo anterior a v16). */
export function routePlacedCapital(routeId: string, rows: CapitalRows): number {
  const t = rows.transfers.filter(isRouteToRouteTransfer)
  return sum(rows.capitalMovements.filter(m => m.routeId === routeId), m => m.valor)
    - sum(rows.withdrawals.filter(w => w.routeId === routeId), w => w.valor)
    + sum(t.filter(x => x.routeDestinoId === routeId), x => x.valor)
    - sum(t.filter(x => x.routeOrigenId === routeId), x => x.valor)
}

/** Capital colocado en `routeId` bajo la responsabilidad de `adminId`. */
export function adminRoutePlacement(adminId: string, routeId: string, rows: CapitalRows): number {
  const t = rows.transfers.filter(x => isRouteToRouteTransfer(x) && x.adminId === adminId)
  const ctl = rows.ledger.filter(e => e.tipo === 'ROUTE_CONTROL_TRANSFER' && e.routeId === routeId)
  return sum(rows.capitalMovements.filter(m => m.routeId === routeId && m.adminId === adminId), m => m.valor)
    - sum(rows.withdrawals.filter(w => w.routeId === routeId && w.adminId === adminId), w => w.valor)
    + sum(t.filter(x => x.routeDestinoId === routeId), x => x.valor)
    - sum(t.filter(x => x.routeOrigenId === routeId), x => x.valor)
    + sum(ctl.filter(e => e.toAdminId === adminId), e => e.amount)
    - sum(ctl.filter(e => e.fromAdminId === adminId), e => e.amount)
}

/** Capital de la ruta que hoy no está en la bolsa de ningún Administrador. */
export function unattributedRouteCapital(routeId: string, rows: CapitalRows): number {
  const t = rows.transfers.filter(x => isRouteToRouteTransfer(x) && !x.adminId)
  const ctl = rows.ledger.filter(e => e.tipo === 'ROUTE_CONTROL_TRANSFER' && e.routeId === routeId)
  return sum(rows.capitalMovements.filter(m => m.routeId === routeId && !m.adminId), m => m.valor)
    - sum(rows.withdrawals.filter(w => w.routeId === routeId && !w.adminId), w => w.valor)
    + sum(t.filter(x => x.routeDestinoId === routeId), x => x.valor)
    - sum(t.filter(x => x.routeOrigenId === routeId), x => x.valor)
    - sum(ctl.filter(e => e.toAdminId), e => e.amount)
    + sum(ctl.filter(e => e.fromAdminId), e => e.amount)
}

export interface AdminCapital {
  adminId: string
  /** Neto entregado por el SuperAdmin (asignaciones − devoluciones). */
  asignadoPorEmpresa: number
  /** Capital bajo su responsabilidad = disponible + enRutas. */
  asignado: number
  enRutas: number
  disponible: number
  /** Rutas cuyo capital controla HOY, con su capital colocado. */
  rutas: { routeId: string; colocado: number }[]
}

export function adminCapital(adminId: string, rows: CapitalRows): AdminCapital {
  const l = rows.ledger
  const asignaciones = sum(l.filter(e => e.tipo === 'ADMIN_ALLOCATION' && e.toAdminId === adminId), e => e.amount)
  const devoluciones = sum(l.filter(e => e.tipo === 'ADMIN_RETURN' && e.fromAdminId === adminId), e => e.amount)
  const colocado = sum(rows.capitalMovements.filter(m => m.adminId === adminId), m => m.valor)
  const recibido = sum(rows.withdrawals.filter(w => w.adminId === adminId), w => w.valor)
  const disponible = asignaciones - devoluciones - colocado + recibido
  const rutasIds = new Set<string>([
    ...rows.routes.filter(r => r.capitalControllerAdminId === adminId).map(r => r.id),
  ])
  // Rutas que ya no controla pero donde aún figura capital suyo (no debería ocurrir:
  // el traspaso lo mueve entero). Se incluyen para que la suma nunca lo esconda.
  for (const r of rows.routes) if (!rutasIds.has(r.id) && adminRoutePlacement(adminId, r.id, rows) !== 0) rutasIds.add(r.id)
  const rutas = [...rutasIds].map(routeId => ({ routeId, colocado: adminRoutePlacement(adminId, routeId, rows) }))
  const enRutas = sum(rutas, r => r.colocado)
  return { adminId, asignadoPorEmpresa: asignaciones - devoluciones, asignado: disponible + enRutas, enRutas, disponible, rutas }
}

export interface CompanyCapital {
  depositos: number
  retirosEmpresa: number
  asignadoAAdmins: number
  disponible: number
  /** Capital de rutas anterior a v16 (sin bolsa de origen registrada). */
  historicoPreV16: number
  /** Capital total que la empresa controla = disponible + Σ asignado + sin responsable. */
  total: number
  sinResponsable: number
}

export interface CapitalStructure {
  company: CompanyCapital
  admins: AdminCapital[]
  routes: {
    routeId: string
    nombre: string
    controllerAdminId?: string
    colocado: number
    sinResponsable: number
  }[]
}

export function computeCapitalStructure(rows: CapitalRows, adminIds: string[]): CapitalStructure {
  const l = rows.ledger
  const depositos = sum(l.filter(e => e.tipo === 'COMPANY_DEPOSIT'), e => e.amount)
  const retirosEmpresa = sum(l.filter(e => e.tipo === 'COMPANY_WITHDRAWAL'), e => e.amount)
  const asignaciones = sum(l.filter(e => e.tipo === 'ADMIN_ALLOCATION'), e => e.amount)
  const devoluciones = sum(l.filter(e => e.tipo === 'ADMIN_RETURN'), e => e.amount)
  const disponible = depositos - retirosEmpresa - asignaciones + devoluciones
  // Toda bolsa con rastro cuenta, aunque el Admin ya no esté activo (nada se esconde).
  const conRastro = new Set<string>(adminIds)
  for (const e of l) { if (e.fromAdminId) conRastro.add(e.fromAdminId); if (e.toAdminId) conRastro.add(e.toAdminId) }
  for (const m of rows.capitalMovements) if (m.adminId) conRastro.add(m.adminId)
  for (const w of rows.withdrawals) if (w.adminId) conRastro.add(w.adminId)
  for (const r of rows.routes) if (r.capitalControllerAdminId) conRastro.add(r.capitalControllerAdminId)
  const admins = [...conRastro].map(id => adminCapital(id, rows))
  const routes = rows.routes.map(r => ({
    routeId: r.id, nombre: r.nombre, controllerAdminId: r.capitalControllerAdminId,
    colocado: routePlacedCapital(r.id, rows),
    sinResponsable: unattributedRouteCapital(r.id, rows),
  }))
  const historicoPreV16 = sum(rows.routes, r => legacyRouteCapital(r.id, rows))
  const sinResponsable = sum(routes, r => r.sinResponsable)
  return {
    company: {
      depositos, retirosEmpresa, asignadoAAdmins: asignaciones - devoluciones, disponible, historicoPreV16,
      sinResponsable, total: disponible + sum(admins, a => a.asignado) + sinResponsable,
    },
    admins, routes,
  }
}

/** Capital de la ruta registrado antes de v16 (movimientos sin `adminId`). */
export function legacyRouteCapital(routeId: string, rows: CapitalRows): number {
  const t = rows.transfers.filter(x => isRouteToRouteTransfer(x) && !x.adminId)
  return sum(rows.capitalMovements.filter(m => m.routeId === routeId && !m.adminId), m => m.valor)
    - sum(rows.withdrawals.filter(w => w.routeId === routeId && !w.adminId), w => w.valor)
    + sum(t.filter(x => x.routeDestinoId === routeId), x => x.valor)
    - sum(t.filter(x => x.routeOrigenId === routeId), x => x.valor)
}

/**
 * INVARIANTES. Lista vacía = todo cuadra. Se comprueban en las pruebas tras cada
 * operación y pueden mostrarse en pantalla (nunca se ocultan).
 */
export function verifyCapitalInvariants(rows: CapitalRows, adminIds: string[]): string[] {
  const s = computeCapitalStructure(rows, adminIds)
  const issues: string[] = []
  if (s.company.disponible < 0) issues.push(`Disponible de la empresa negativo (${s.company.disponible}).`)
  for (const a of s.admins) if (a.disponible < 0) issues.push(`Disponible negativo del Administrador ${a.adminId} (${a.disponible}).`)
  for (const r of s.routes) {
    const controller = r.controllerAdminId
    for (const a of s.admins) {
      const c = adminRoutePlacement(a.adminId, r.routeId, rows)
      if (a.adminId !== controller && c !== 0) issues.push(`La ruta ${r.nombre} tiene capital (${c}) en la bolsa de ${a.adminId}, que no es su responsable.`)
    }
    if (controller && r.sinResponsable !== 0) issues.push(`La ruta ${r.nombre} tiene responsable pero ${r.sinResponsable} de capital sin reconocer.`)
  }
  const esperado = s.company.depositos - s.company.retirosEmpresa + s.company.historicoPreV16
  if (esperado !== s.company.total) issues.push(`Conservación rota: entradas ${esperado} ≠ capital controlado ${s.company.total}.`)
  return issues
}

// ------------------------------------------------------------
// RESPONSABLE DE CAPITAL
// ------------------------------------------------------------

type AdminLike = Pick<User, 'id' | 'rol' | 'status' | 'tenantId' | 'authorizedRouteIds' | 'routeId' | 'createdAt'>

function routesOf(u: AdminLike): string[] {
  const ids = new Set(u.authorizedRouteIds ?? [])
  if (u.routeId) ids.add(u.routeId)
  return [...ids]
}

/** ¿`u` puede ser responsable del capital de `route`? (Admin activo, misma empresa, asignado). */
export function isValidCapitalController(u: AdminLike | undefined | null, route: Pick<Route, 'id' | 'tenantId'>): boolean {
  return !!u && u.rol === 'admin' && u.status === 'activo' && u.tenantId === route.tenantId && routesOf(u).includes(route.id)
}

/** Administradores válidos (activos y asignados) de la ruta. */
export function validRouteAdmins<T extends AdminLike>(users: T[], route: Pick<Route, 'id' | 'tenantId'>): T[] {
  return users.filter(u => isValidCapitalController(u, route))
}

/** Registro mínimo de auditoría para reconstruir el orden real de asignación. */
export interface AssignmentLogLike {
  action: string
  routeId?: string
  entityId: string
  createdAt: string
  after?: Record<string, unknown>
}

/**
 * "PRIMER ADMINISTRADOR" de una ruta, de forma ESTABLE:
 *   1. el instante más antiguo en que la auditoría lo asignó a la ruta
 *      (ASSIGN_ROUTE sobre él, o CREATE_ROUTE con él en `adminIds`, respetando
 *      el orden de esa lista);
 *   2. sin rastro de auditoría: el usuario creado antes;
 *   3. desempate final por id.
 * Nunca depende del orden accidental de un array ni de la pantalla.
 */
export function pickFirstAdmin<T extends AdminLike>(candidates: T[], routeId: string, logs: AssignmentLogLike[]): T | undefined {
  const INF = '￿'
  const key = (u: T): [string, number, string, string] => {
    let best = INF
    let idx = Number.MAX_SAFE_INTEGER
    for (const l of logs) {
      if (l.routeId !== routeId) continue
      if (l.action === 'ASSIGN_ROUTE' && l.entityId === u.id && l.createdAt < best) { best = l.createdAt; idx = 0 }
      if (l.action === 'CREATE_ROUTE') {
        const ids = Array.isArray(l.after?.adminIds) ? (l.after!.adminIds as string[]) : []
        const i = ids.indexOf(u.id)
        if (i >= 0 && (l.createdAt < best || (l.createdAt === best && i < idx))) { best = l.createdAt; idx = i }
      }
    }
    return [best, idx, u.createdAt ?? INF, u.id]
  }
  return [...candidates].sort((a, b) => {
    const ka = key(a), kb = key(b)
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1
      if (ka[i] > kb[i]) return 1
    }
    return 0
  })[0]
}

/** Responsable de capital de la ruta en un instante (historial, sin recalcular el pasado). */
export function capitalControllerAt(
  events: Pick<RouteCapitalControllerEvent, 'routeId' | 'toAdminId' | 'createdAt'>[],
  routeId: string,
  instante: string,
): string | undefined {
  const previos = events
    .filter(e => e.routeId === routeId && e.createdAt <= instante)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return previos.length ? previos[previos.length - 1].toAdminId : undefined
}

// ------------------------------------------------------------
// MIGRACIÓN v16 (plan puro y determinista)
// ------------------------------------------------------------
export const MIGRATION_V16_ACTOR = 'system:migration-v16'

export interface CapitalMigrationPlan {
  routeUpdates: { id: string; capitalControllerAdminId: string; capitalControllerSince: string }[]
  events: RouteCapitalControllerEvent[]
  ledger: CapitalLedgerEntry[]
  /** Rutas que quedan "Sin responsable de capital" (sin Administrador válido). */
  sinResponsable: string[]
}

/**
 * Para cada ruta SIN responsable todavía:
 *   · 1 Administrador válido  → ese.
 *   · varios                 → el "primer Admin" según la auditoría (`pickFirstAdmin`).
 *   · ninguno                → queda sin responsable (fail closed).
 * Con responsable, el capital ya colocado en la ruta (anterior a v16) se RECONOCE en
 * su bolsa con un ROUTE_CONTROL_TRANSFER sin origen: no se crea dinero, se hace
 * visible quién responde por él. IDs derivados de la ruta: re-ejecutar el plan sobre
 * datos ya migrados no produce nada nuevo (idempotente).
 */
export function planCapitalMigrationV16(params: {
  routes: Route[]
  users: AdminLike[]
  auditLogs: AssignmentLogLike[]
  rows: Omit<CapitalRows, 'routes'>
  now: string
}): CapitalMigrationPlan {
  const plan: CapitalMigrationPlan = { routeUpdates: [], events: [], ledger: [], sinResponsable: [] }
  const rows: CapitalRows = { ...params.rows, routes: params.routes }
  const ordenadas = [...params.routes].sort((a, b) => a.id.localeCompare(b.id))
  for (const route of ordenadas) {
    if (route.capitalControllerAdminId) continue
    const elegido = pickFirstAdmin(validRouteAdmins(params.users, route), route.id, params.auditLogs)
    if (!elegido) { plan.sinResponsable.push(route.id); continue }
    const eventId = `mig16-evt-${route.id}`
    const reconocido = unattributedRouteCapital(route.id, rows)
    let ledgerEntryId: string | undefined
    if (reconocido !== 0) {
      ledgerEntryId = `mig16-ctl-${route.id}`
      plan.ledger.push({
        id: ledgerEntryId, tenantId: route.tenantId, tipo: 'ROUTE_CONTROL_TRANSFER', amount: reconocido,
        toAdminId: elegido.id, routeId: route.id, relatedEventId: eventId,
        descripcion: 'Migración v16: capital existente de la ruta reconocido en la bolsa de su responsable',
        fecha: params.now.slice(0, 10), createdAt: params.now, actorUserId: MIGRATION_V16_ACTOR, actorRole: 'system',
        status: 'aplicado', syncStatus: 'pending',
      })
    }
    plan.events.push({
      id: eventId, tenantId: route.tenantId, routeId: route.id, kind: 'MIGRATION', toAdminId: elegido.id,
      capitalTransferido: reconocido, ledgerEntryId,
      motivo: 'Responsable inicial: primer Administrador válido asignado a la ruta',
      createdAt: params.now, actorUserId: MIGRATION_V16_ACTOR, actorRole: 'system', syncStatus: 'pending',
    })
    plan.routeUpdates.push({ id: route.id, capitalControllerAdminId: elegido.id, capitalControllerSince: params.now })
  }
  return plan
}
