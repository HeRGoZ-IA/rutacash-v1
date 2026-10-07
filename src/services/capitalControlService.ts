// ============================================================
// CAPITAL POR ADMINISTRADOR — SERVICIO DE DOMINIO (v16)
// ------------------------------------------------------------
// Cadena:   SuperAdmin ──▶ Administrador ──▶ Ruta
//
//   registerCompanyCapital      externo → bolsa de la empresa          (SuperAdmin)
//   withdrawCompanyCapital      bolsa de la empresa → externo          (SuperAdmin)
//   allocateCapitalToAdmin      bolsa empresa → bolsa del Admin        (SuperAdmin)
//   returnCapitalFromAdmin      bolsa del Admin → bolsa empresa        (SuperAdmin)
//   setRouteCapitalController   cambia el responsable de una ruta      (SuperAdmin)
//   reconcileRouteCapitalControllers  regla del "primer Admin" y protección del
//                               responsable al cambiar asignaciones (lo invocan,
//                               DENTRO de su transacción, los servicios que
//                               asignan o retiran Administradores de rutas).
//
// Admin → Ruta y Ruta → Admin viven en `routeFundsService` (registerCapital /
// registerWithdrawal), que sella `adminId` y descuenta/abona la bolsa.
//
// GARANTÍAS (todas en el servicio; la pantalla nunca es la única barrera):
//   · Actor, capacidad y empresa revalidados en cada operación.
//   · Saldos releídos DENTRO de la transacción Dexie: dos operaciones simultáneas
//     no gastan el mismo disponible (las transacciones rw sobre las mismas tablas
//     se serializan).
//   · Montos enteros > 0; nunca disponible negativo.
//   · Todo movimiento tiene id, tipo, monto, origen/destino, actor, rol, fecha,
//     instante y estado; el libro es inmutable (sin ediciones ni borrados).
//   · Cambiar de responsable traspasa el capital colocado en la ruta de una bolsa
//     a otra con un asiento + un evento, en la MISMA transacción que el cambio: el
//     capital nunca queda en dos bolsas ni en ninguna por error.
// ============================================================
import { db, type RutaCashDB } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { nowISO, today } from '@/lib/formatters'
import {
  adminCapital, adminRoutePlacement, computeCapitalStructure, isValidCapitalController, pickFirstAdmin,
  unattributedRouteCapital, validRouteAdmins, verifyCapitalInvariants,
  type CapitalRows, type CapitalStructure,
} from '@/lib/capitalAllocation'
import { can, isRouteCapitalController } from '@/lib/permissions'
import { assertCan, AuthzError } from '@/services/authz'
import { logAction } from '@/services/auditService'
import { getRouteLedger } from '@/services/cashboxEngine'
import type {
  CapitalLedgerEntry, CapitalLedgerType, CapitalMovement, Route, RouteCapitalControllerEvent,
  RouteCapitalControllerEventKind, Transfer, User, Withdrawal,
} from '@/models/types'

export class CapitalControlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CapitalControlError'
  }
}

// ------------------------------------------------------------
// Contrato de base de datos (estructural: Dexie real o base en memoria de pruebas)
// ------------------------------------------------------------
interface ReadByIndex<T> { where(index: string): { equals(value: string): { toArray(): Promise<T[]> } } }

export interface CapitalControlDatabase {
  routes: ReadByIndex<Route> & {
    get(key: string): Promise<Route | undefined>
    update(key: string, changes: Partial<Route>): Promise<number>
  }
  users: ReadByIndex<User>
  capitalLedger: ReadByIndex<CapitalLedgerEntry> & { add(item: CapitalLedgerEntry): Promise<unknown> }
  routeCapitalControllerEvents: ReadByIndex<RouteCapitalControllerEvent> & { add(item: RouteCapitalControllerEvent): Promise<unknown> }
  capitalMovements: ReadByIndex<CapitalMovement>
  withdrawals: ReadByIndex<Withdrawal>
  transfers: ReadByIndex<Transfer>
}

/** Tablas que deben estar en el alcance de cualquier transacción que toque capital. */
export function capitalTables(database: CapitalControlDatabase = db as unknown as CapitalControlDatabase): unknown[] {
  return [
    database.routes, database.users, database.capitalLedger, database.routeCapitalControllerEvents,
    database.capitalMovements, database.withdrawals, database.transfers,
  ]
}

/** Lee TODO lo que alimenta las bolsas de una empresa (llamar dentro de la transacción). */
export async function loadCapitalRows(tenantId: string, database: CapitalControlDatabase = db as unknown as CapitalControlDatabase): Promise<CapitalRows & { users: User[] }> {
  const [routes, users, ledger, capitalMovements, withdrawals, transfers] = await Promise.all([
    database.routes.where('tenantId').equals(tenantId).toArray(),
    database.users.where('tenantId').equals(tenantId).toArray(),
    database.capitalLedger.where('tenantId').equals(tenantId).toArray(),
    database.capitalMovements.where('tenantId').equals(tenantId).toArray(),
    database.withdrawals.where('tenantId').equals(tenantId).toArray(),
    database.transfers.where('tenantId').equals(tenantId).toArray(),
  ])
  return { routes, users, ledger, capitalMovements, withdrawals, transfers }
}

const ENTERO = (n: unknown) => Number.isFinite(Number(n)) && Number(n) > 0 && Math.round(Number(n)) === Number(n)
const FECHA = /^\d{4}-\d{2}-\d{2}$/

function validarMonto(amount: unknown): number {
  if (!ENTERO(amount)) throw new CapitalControlError('El valor debe ser un entero mayor a 0.')
  return Number(amount)
}

function validarFecha(fecha: string | undefined): string {
  const f = fecha || today()
  if (!FECHA.test(f) || Number.isNaN(new Date(`${f}T00:00:00`).getTime())) throw new CapitalControlError('La fecha no es válida.')
  if (f > today()) throw new CapitalControlError('La fecha no puede ser futura.')
  return f
}

function exigirActor(actor: User | null | undefined): User {
  if (!actor) throw new AuthzError('Acción no autorizada: falta el usuario.')
  return actor
}

const money = (n: number) => `$${n.toLocaleString('es-CO')}`

async function auditar(params: Parameters<typeof logAction>[0]) {
  await logAction(params).catch(() => undefined)
}

// ------------------------------------------------------------
// CONSULTA
// ------------------------------------------------------------
export interface CapitalOverview extends CapitalStructure {
  /** Invariantes rotos (vacío = todo cuadra). Nunca se ocultan. */
  issues: string[]
}

/**
 * Estructura de capital de la empresa.
 *   · SuperAdmin: todo.
 *   · Administrador: SOLO su bolsa y las rutas que controla (sin la bolsa de la
 *     empresa ni las de otros Administradores).
 *   · Resto de roles: denegado.
 */
export async function getCapitalOverview(
  params: { actor: User | null | undefined; tenantId: string },
  database: RutaCashDB = db,
): Promise<CapitalOverview> {
  const actor = exigirActor(params.actor)
  if (actor.tenantId !== params.tenantId) throw new AuthzError('Empresa no autorizada.')
  if (!can(actor, 'capital.allocateAdmins', { tenantId: params.tenantId }) && !can(actor, 'capital.manage', { tenantId: params.tenantId })) {
    throw new AuthzError('Acción no autorizada (capital).')
  }
  const rows = await loadCapitalRows(params.tenantId, database as unknown as CapitalControlDatabase)
  const adminIds = rows.users.filter(u => u.rol === 'admin').map(u => u.id)
  const s = computeCapitalStructure(rows, adminIds)
  if (actor.rol === 'superadmin') return { ...s, issues: verifyCapitalInvariants(rows, adminIds) }
  const mias = new Set(rows.routes.filter(r => isRouteCapitalController(actor, r)).map(r => r.id))
  return {
    company: { depositos: 0, retirosEmpresa: 0, asignadoAAdmins: 0, disponible: 0, historicoPreV16: 0, total: 0, sinResponsable: 0 },
    admins: s.admins.filter(a => a.adminId === actor.id),
    routes: s.routes.filter(r => mias.has(r.routeId)),
    issues: [],
  }
}

/** Disponible de la bolsa del Administrador (para mostrar antes de colocar capital). */
export async function getAdminAvailableCapital(tenantId: string, adminId: string, database: RutaCashDB = db): Promise<number> {
  return adminCapital(adminId, await loadCapitalRows(tenantId, database as unknown as CapitalControlDatabase)).disponible
}

/** Movimientos del libro de capital (más reciente primero). Admin: solo los suyos. */
export async function listCapitalLedger(
  params: { actor: User | null | undefined; tenantId: string; adminId?: string },
  database: RutaCashDB = db,
): Promise<CapitalLedgerEntry[]> {
  const actor = exigirActor(params.actor)
  if (actor.tenantId !== params.tenantId) throw new AuthzError('Empresa no autorizada.')
  const sa = can(actor, 'capital.allocateAdmins', { tenantId: params.tenantId })
  if (!sa && !can(actor, 'capital.manage', { tenantId: params.tenantId })) throw new AuthzError('Acción no autorizada (capital).')
  const adminId = sa ? params.adminId : actor.id
  const all = await database.capitalLedger.where('tenantId').equals(params.tenantId).toArray()
  return all
    .filter(e => !adminId || e.fromAdminId === adminId || e.toAdminId === adminId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Historial de responsables de una ruta (más reciente primero). */
export async function listRouteControllerHistory(
  params: { actor: User | null | undefined; tenantId: string; routeId?: string },
  database: RutaCashDB = db,
): Promise<RouteCapitalControllerEvent[]> {
  const actor = exigirActor(params.actor)
  if (actor.tenantId !== params.tenantId) throw new AuthzError('Empresa no autorizada.')
  const sa = can(actor, 'capital.assignController', { tenantId: params.tenantId })
  if (!sa && !can(actor, 'capital.manage', { tenantId: params.tenantId })) throw new AuthzError('Acción no autorizada (capital).')
  const all = await database.routeCapitalControllerEvents.where('tenantId').equals(params.tenantId).toArray()
  return all
    .filter(e => !params.routeId || e.routeId === params.routeId)
    // El Administrador ve los eventos en los que participa.
    .filter(e => sa || e.fromAdminId === actor.id || e.toAdminId === actor.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

// ------------------------------------------------------------
// SUPERADMIN ⇄ EMPRESA ⇄ ADMINISTRADOR
// ------------------------------------------------------------
interface LedgerOpParams {
  actor: User | null | undefined
  tenantId: string
  amount: number
  descripcion?: string
  fecha?: string
}

async function registrarLedger(
  tipo: CapitalLedgerType,
  params: LedgerOpParams & { adminId?: string },
  database: RutaCashDB,
): Promise<CapitalLedgerEntry> {
  const actor = exigirActor(params.actor)
  const { tenantId } = params
  assertCan(actor, 'capital.allocateAdmins', { tenantId })
  const amount = validarMonto(params.amount)
  const fecha = validarFecha(params.fecha)
  const conAdmin = tipo === 'ADMIN_ALLOCATION' || tipo === 'ADMIN_RETURN'
  let entry!: CapitalLedgerEntry
  await database.transaction('rw', capitalTables(database as unknown as CapitalControlDatabase) as never[], async () => {
    const rows = await loadCapitalRows(tenantId, database as unknown as CapitalControlDatabase)
    let admin: User | undefined
    if (conAdmin) {
      admin = rows.users.find(u => u.id === params.adminId)
      if (!admin || admin.rol !== 'admin') throw new CapitalControlError('El Administrador indicado no existe en esta empresa.')
      if (tipo === 'ADMIN_ALLOCATION' && admin.status !== 'activo') throw new CapitalControlError('No se puede asignar capital a un Administrador inactivo.')
    }
    const s = computeCapitalStructure(rows, [])
    if (tipo === 'ADMIN_ALLOCATION' || tipo === 'COMPANY_WITHDRAWAL') {
      if (amount > s.company.disponible) {
        throw new CapitalControlError(`La empresa no tiene ese capital disponible (disponible: ${money(s.company.disponible)}).`)
      }
    }
    if (tipo === 'ADMIN_RETURN') {
      const disponible = adminCapital(admin!.id, rows).disponible
      if (amount > disponible) {
        throw new CapitalControlError(`${admin!.nombre} solo tiene ${money(disponible)} disponible; el resto está colocado en sus rutas. Debe retirarlo de las rutas antes de devolverlo.`)
      }
    }
    entry = {
      id: generateId(), tenantId, tipo, amount,
      fromAdminId: tipo === 'ADMIN_RETURN' ? admin!.id : undefined,
      toAdminId: tipo === 'ADMIN_ALLOCATION' ? admin!.id : undefined,
      descripcion: params.descripcion?.trim() || undefined, fecha, createdAt: nowISO(),
      actorUserId: actor.id, actorRole: actor.rol, status: 'aplicado', syncStatus: 'pending',
    }
    await (database as unknown as CapitalControlDatabase).capitalLedger.add(entry)
  })
  const accion = {
    COMPANY_DEPOSIT: 'COMPANY_CAPITAL_DEPOSIT', COMPANY_WITHDRAWAL: 'COMPANY_CAPITAL_WITHDRAWAL',
    ADMIN_ALLOCATION: 'ADMIN_CAPITAL_ALLOCATED', ADMIN_RETURN: 'ADMIN_CAPITAL_RETURNED',
    ROUTE_CONTROL_TRANSFER: 'ROUTE_CAPITAL_CONTROLLER_CHANGED',
  } as const
  await auditar({
    tenantId, userId: actor.id, userRole: actor.rol, action: accion[tipo], entityType: 'capitalLedger', entityId: entry.id,
    descripcion: `${tipo} ${amount}${entry.toAdminId ? ` → Admin ${entry.toAdminId}` : ''}${entry.fromAdminId ? ` ← Admin ${entry.fromAdminId}` : ''}.`,
    after: { tipo, amount, fromAdminId: entry.fromAdminId, toAdminId: entry.toAdminId, fecha: entry.fecha },
  })
  return entry
}

/** Capital nuevo de la empresa (aporte externo) en la bolsa del SuperAdmin. */
export const registerCompanyCapital = (params: LedgerOpParams, database: RutaCashDB = db) =>
  registrarLedger('COMPANY_DEPOSIT', params, database)

/** Salida de capital de la empresa (solo lo NO asignado a Administradores). */
export const withdrawCompanyCapital = (params: LedgerOpParams, database: RutaCashDB = db) =>
  registrarLedger('COMPANY_WITHDRAWAL', params, database)

/** SuperAdmin → Administrador. No supera el disponible de la empresa. */
export const allocateCapitalToAdmin = (params: LedgerOpParams & { adminId: string }, database: RutaCashDB = db) =>
  registrarLedger('ADMIN_ALLOCATION', params, database)

/** Administrador → SuperAdmin. Solo lo disponible: lo colocado en rutas no se toca. */
export const returnCapitalFromAdmin = (params: LedgerOpParams & { adminId: string }, database: RutaCashDB = db) =>
  registrarLedger('ADMIN_RETURN', params, database)

// ------------------------------------------------------------
// RESPONSABLE DE CAPITAL DE UNA RUTA
// ------------------------------------------------------------

/**
 * Transición atómica del responsable (DEBE llamarse dentro de una transacción que
 * incluya `capitalTables`). Traspasa a `toAdminId` el capital colocado en la ruta
 * bajo el responsable anterior y reconoce el capital sin responsable; con
 * `toAdminId` vacío la ruta queda sin responsable y su capital sale de la bolsa del
 * anterior. Devuelve el evento.
 */
export async function transitionRouteCapitalController(
  database: CapitalControlDatabase,
  params: {
    route: Route
    toAdminId?: string
    kind: RouteCapitalControllerEventKind
    actor: Pick<User, 'id' | 'rol'>
    motivo?: string
    baseAlCambio?: number
    now?: string
  },
): Promise<RouteCapitalControllerEvent> {
  const { route, toAdminId, kind, actor } = params
  const now = params.now ?? nowISO()
  const rows = await loadCapitalRows(route.tenantId, database)
  const fromAdminId = route.capitalControllerAdminId
  if (fromAdminId === toAdminId) throw new CapitalControlError('Ese Administrador ya es el responsable de capital de la ruta.')
  const llevado = fromAdminId ? adminRoutePlacement(fromAdminId, route.id, rows) : 0
  const sinResponsable = unattributedRouteCapital(route.id, rows)
  const eventId = generateId()
  const base = {
    tenantId: route.tenantId, tipo: 'ROUTE_CONTROL_TRANSFER' as const, routeId: route.id, relatedEventId: eventId,
    fecha: now.slice(0, 10), createdAt: now, actorUserId: actor.id, actorRole: actor.rol,
    status: 'aplicado' as const, syncStatus: 'pending' as const,
  }
  const asientos: CapitalLedgerEntry[] = []
  if (fromAdminId && llevado !== 0) {
    asientos.push({
      ...base, id: generateId(), amount: llevado, fromAdminId, toAdminId: toAdminId || undefined,
      descripcion: toAdminId ? `Traspaso de responsabilidad de la ruta ${route.nombre}` : `La ruta ${route.nombre} queda sin responsable de capital`,
    })
  }
  if (toAdminId && sinResponsable !== 0) {
    asientos.push({
      ...base, id: generateId(), amount: sinResponsable, toAdminId,
      descripcion: `Capital existente de la ruta ${route.nombre} reconocido en la bolsa de su responsable`,
    })
  }
  const evento: RouteCapitalControllerEvent = {
    id: eventId, tenantId: route.tenantId, routeId: route.id, kind, fromAdminId, toAdminId: toAdminId || undefined,
    capitalTransferido: (fromAdminId ? llevado : 0) + (toAdminId ? sinResponsable : 0),
    baseAlCambio: params.baseAlCambio, ledgerEntryId: asientos[0]?.id,
    motivo: params.motivo?.trim() || undefined, createdAt: now, actorUserId: actor.id, actorRole: actor.rol, syncStatus: 'pending',
  }
  for (const a of asientos) await database.capitalLedger.add(a)
  await database.routeCapitalControllerEvents.add(evento)
  await database.routes.update(route.id, {
    capitalControllerAdminId: toAdminId || undefined,
    capitalControllerSince: toAdminId ? now : undefined,
    updatedAt: now,
  })
  route.capitalControllerAdminId = toAdminId || undefined
  return evento
}

/**
 * SuperAdmin cambia el responsable de capital de una ruta. El nuevo responsable
 * debe ser un Administrador ACTIVO ya asignado a la ruta. El capital colocado viaja
 * con la ruta (no consume el disponible del nuevo ni lo crea): bolsa del anterior
 * −X, bolsa del nuevo +X, todo en una transacción.
 */
export async function setRouteCapitalController(
  params: { actor: User | null | undefined; tenantId: string; routeId: string; adminId: string; motivo?: string },
  database: RutaCashDB = db,
): Promise<RouteCapitalControllerEvent> {
  const actor = exigirActor(params.actor)
  const { tenantId, routeId } = params
  assertCan(actor, 'capital.assignController', { tenantId })
  const motivo = (params.motivo ?? '').trim()
  if (motivo.length < 3) throw new CapitalControlError('Indica el motivo del cambio de responsable.')
  const previa = await database.routes.get(routeId)
  if (!previa || previa.tenantId !== tenantId) throw new CapitalControlError('La ruta indicada no existe en esta empresa.')
  const baseAlCambio = (await getRouteLedger(routeId, database)).saldoActual
  let evento!: RouteCapitalControllerEvent
  await database.transaction('rw', capitalTables(database as unknown as CapitalControlDatabase) as never[], async () => {
    const route = await database.routes.get(routeId)
    const users = await database.users.where('tenantId').equals(tenantId).toArray()
    const nuevo = users.find(u => u.id === params.adminId)
    if (!route) throw new CapitalControlError('La ruta indicada no existe.')
    if (!isValidCapitalController(nuevo, route)) {
      throw new CapitalControlError('El nuevo responsable debe ser un Administrador activo asignado a esta ruta.')
    }
    evento = await transitionRouteCapitalController(database as unknown as CapitalControlDatabase, {
      route, toAdminId: nuevo!.id, kind: 'CHANGE', actor, motivo, baseAlCambio,
    })
  })
  await auditar({
    tenantId, userId: actor.id, userRole: actor.rol, routeId, action: 'ROUTE_CAPITAL_CONTROLLER_CHANGED',
    entityType: 'Route', entityId: routeId, motivo,
    descripcion: `Responsable de capital de ${previa.nombre}: ${evento.fromAdminId ?? 'ninguno'} → ${evento.toAdminId}. Capital traspasado ${evento.capitalTransferido}.`,
    before: { capitalControllerAdminId: evento.fromAdminId ?? null },
    after: { capitalControllerAdminId: evento.toAdminId, capitalTransferido: evento.capitalTransferido, eventId: evento.id },
  })
  return evento
}

/**
 * Coherencia del responsable tras CAMBIAR ASIGNACIONES de Administradores (crear
 * ruta, editar ruta, editar/desactivar un usuario, asignar desde una Oficina).
 * DEBE ejecutarse dentro de la transacción del cambio (incluyendo `capitalTables`):
 * si lanza, nada del cambio se guarda.
 *
 * Por cada ruta indicada:
 *   · `replacements[ruta]` → el SuperAdmin eligió responsable explícitamente.
 *   · responsable válido   → nada que hacer (un segundo Admin NO lo reemplaza).
 *   · responsable que deja de ser válido (desasignado, inactivo, cambió de rol):
 *       – quedan otros Admins válidos → ERROR: hay que elegir uno explícitamente
 *         (nunca se elige "a cualquiera" en silencio);
 *       – no queda ninguno → la ruta queda SIN responsable (RELEASE) y sus
 *         operaciones de caja se bloquean.
 *   · sin responsable y con Admins válidos → "primer Admin": el primero de
 *     `preferredAdminIds` (orden en que se seleccionaron en esta operación) o, si no,
 *     el primero según `pickFirstAdmin` (creación del usuario, id).
 */
export async function reconcileRouteCapitalControllers(
  database: CapitalControlDatabase,
  params: {
    tenantId: string
    routeIds: string[]
    actor: User
    preferredAdminIds?: string[]
    replacements?: Record<string, string>
  },
): Promise<RouteCapitalControllerEvent[]> {
  const eventos: RouteCapitalControllerEvent[] = []
  const users = await database.users.where('tenantId').equals(params.tenantId).toArray()
  for (const routeId of [...new Set(params.routeIds)].sort()) {
    const route = await database.routes.get(routeId)
    if (!route || route.tenantId !== params.tenantId) continue
    const validos = validRouteAdmins(users, route)
    const actual = users.find(u => u.id === route.capitalControllerAdminId)
    const elegido = params.replacements?.[routeId]
    if (elegido && elegido !== route.capitalControllerAdminId) {
      if (!can(params.actor, 'capital.assignController', { tenantId: params.tenantId })) {
        throw new AuthzError('Solo el SuperAdmin puede cambiar el responsable de capital de una ruta.')
      }
      if (!validos.some(u => u.id === elegido)) {
        throw new CapitalControlError(`El responsable de capital de ${route.nombre} debe ser un Administrador activo asignado a la ruta.`)
      }
      eventos.push(await transitionRouteCapitalController(database, { route, toAdminId: elegido, kind: 'CHANGE', actor: params.actor, motivo: 'Cambio de responsable al editar las asignaciones' }))
      continue
    }
    if (route.capitalControllerAdminId) {
      if (isValidCapitalController(actual, route)) continue
      if (validos.length > 0) {
        throw new CapitalControlError(
          `${actual?.nombre ?? 'El Administrador'} es el responsable de capital de la ruta ${route.nombre}. ` +
          `Antes de retirarlo, desactivarlo o cambiar su rol, el SuperAdmin debe elegir otro responsable (${validos.map(v => v.nombre).join(', ')}).`,
        )
      }
      eventos.push(await transitionRouteCapitalController(database, {
        route, kind: 'RELEASE', actor: params.actor,
        motivo: 'La ruta quedó sin Administradores válidos: operaciones de caja bloqueadas hasta asignar un responsable',
      }))
      continue
    }
    if (validos.length === 0) continue
    const preferido = (params.preferredAdminIds ?? []).map(id => validos.find(v => v.id === id)).find(Boolean)
    const primero = preferido ?? pickFirstAdmin(validos, routeId, [])
    eventos.push(await transitionRouteCapitalController(database, {
      route, toAdminId: primero!.id, kind: 'FIRST_ADMIN', actor: params.actor,
      motivo: 'Primer Administrador válido asignado a la ruta',
    }))
  }
  return eventos
}

/** ¿Qué rutas controla HOY el usuario? (para bloquear su retiro en pantalla). */
export function routesControlledBy(userId: string, routes: Pick<Route, 'id' | 'capitalControllerAdminId'>[]): string[] {
  return routes.filter(r => r.capitalControllerAdminId === userId).map(r => r.id)
}

/**
 * Ejecuta `cambio` (escrituras de asignaciones/estado/rol de usuarios) y la
 * coherencia del responsable de capital de `routeIds` en UNA transacción. Para
 * las vías que no pasan por `routeService` (Gestión de usuarios, Oficinas,
 * activar/desactivar). Si el cambio deja una ruta sin su responsable habiendo
 * otros Administradores, lanza y no se guarda NADA.
 */
export async function withCapitalControllerGuard<T>(
  params: { tenantId: string; actor: User; routeIds: string[]; preferredAdminIds?: string[] },
  cambio: () => Promise<T>,
  database: RutaCashDB = db,
): Promise<{ result: T; events: RouteCapitalControllerEvent[] }> {
  let result!: T
  let events: RouteCapitalControllerEvent[] = []
  await database.transaction('rw', capitalTables(database as unknown as CapitalControlDatabase) as never[], async () => {
    result = await cambio()
    events = await reconcileRouteCapitalControllers(database as unknown as CapitalControlDatabase, params)
  })
  for (const e of events) {
    await auditar({
      tenantId: params.tenantId, userId: params.actor.id, userRole: params.actor.rol, routeId: e.routeId,
      action: 'ROUTE_CAPITAL_CONTROLLER_CHANGED', entityType: 'Route', entityId: e.routeId,
      descripcion: `Responsable de capital: ${e.fromAdminId ?? 'ninguno'} → ${e.toAdminId ?? 'ninguno'} (${e.kind}).`,
      before: { capitalControllerAdminId: e.fromAdminId ?? null },
      after: { capitalControllerAdminId: e.toAdminId ?? null, capitalTransferido: e.capitalTransferido, eventId: e.id },
    })
  }
  return { result, events }
}
