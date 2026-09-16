// ============================================================
// OFICINAS — CATÁLOGO DE AGRUPACIÓN DE RUTAS (Empresa → Oficina → Ruta)
// ------------------------------------------------------------
// La Oficina ORGANIZA; la Ruta CONTROLA el acceso. Reglas que este servicio
// garantiza y que ninguna capa superior debe poder saltarse:
//
//  · Gestionar el catálogo (`office.*`) NO concede acceso a los datos de las rutas
//    de la Oficina. Ese acceso nace SOLO de `User.authorizedRouteIds`.
//  · Una Oficina puede existir sin rutas; una ruta puede existir sin Oficina.
//  · Eliminar una Oficina NUNCA elimina rutas: las deja "Sin Oficina" en la MISMA
//    transacción. Clientes, ventas, pagos y asignaciones de usuarios no se tocan.
//  · Mover una ruta de Oficina es UNA sola escritura sobre `Route.officeId`. No se
//    propaga a ninguna entidad hija: la Oficina se deriva por `routeId`.
//  · Oficina `inactiva` bloquea las operaciones NUEVAS de sus rutas (ver
//    `assertRouteOperationalContext`) y conserva intacta toda la consulta histórica.
//
// La base es inyectable (mismo patrón que `paymentService` y `routeService`) para
// poder probar el servicio real sin IndexedDB.
// ============================================================
import { db } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { nowISO } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import { assertCan, AuthzError } from '@/services/authz'
import { canManageUser } from '@/lib/permissions'
import { setCobradorRoutes } from '@/services/routeAssignment'
import { applyOfficeRouteSelection } from '@/lib/officeManagement'
import type { AuditLog, Client, Expense, Installment, Office, Payment, Route, Sale, User } from '@/models/types'

// ------------------------------------------------------------
// Contrato de base de datos
// ------------------------------------------------------------
export interface OfficeDatabase {
  offices: {
    add(item: Office): Promise<unknown>
    get(key: string): Promise<Office | undefined>
    update(key: string, changes: Partial<Office>): Promise<number>
    delete(key: string): Promise<void>
    where(index: string): { equals(key: string): { toArray(): Promise<Office[]> } }
  }
  routes: {
    get(key: string): Promise<Route | undefined>
    update(key: string, changes: Partial<Route>): Promise<number>
    where(index: string): { equals(key: string): { toArray(): Promise<Route[]> } }
  }
  transaction<U>(mode: 'rw', tables: unknown, scope: () => PromiseLike<U>): Promise<U>
}

/**
 * Lecturas adicionales que necesita el RESUMEN DE GESTIÓN de una Oficina. Se
 * separa de `OfficeDatabase` para que el CRUD no arrastre tablas que no usa.
 */
export interface OfficeSummaryDatabase extends OfficeDatabase {
  users: { where(index: string): { equals(key: string): { toArray(): Promise<User[]> } } }
  clients: { where(index: string): { equals(key: string): { toArray(): Promise<Client[]> } } }
  sales: { where(index: string): { equals(key: string): { toArray(): Promise<Sale[]> } } }
  /** Solo LECTURA: hechos operativos (cobranza, cartera, gastos) de la Oficina. */
  payments: { where(index: string): { equals(key: string): { toArray(): Promise<Payment[]> } } }
  installments: { toArray(): Promise<Installment[]> }
  expenses: { where(index: string): { equals(key: string): { toArray(): Promise<Expense[]> } } }
  /** Solo LECTURA: actividad reciente. Se reutiliza la auditoría existente. */
  auditLogs: { where(index: string): { equals(key: string): { toArray(): Promise<AuditLog[]> } } }
}

export type OfficeAuditSink = (params: Parameters<typeof logAction>[0]) => Promise<void>

// ------------------------------------------------------------
// Validación de nombre y código
// ------------------------------------------------------------
/** Comparación de identidad para nombres/códigos: sin espacios extremos ni mayúsculas. */
export function normalizeOfficeKey(value: string): string {
  return value.trim().toLocaleLowerCase()
}

export const OFFICE_MESSAGES = {
  nameRequired: 'El nombre de la oficina es obligatorio.',
  nameDuplicated: 'Ya existe una oficina con ese nombre en esta empresa.',
  codeDuplicated: 'Ya existe una oficina con ese código en esta empresa.',
  notFound: 'La oficina no existe o fue eliminada.',
  otherTenant: 'Esa oficina pertenece a otra empresa.',
  routeNotFound: 'La ruta no existe o fue eliminada.',
  routeOtherTenant: 'Esa ruta pertenece a otra empresa.',
  hasRoutes: 'Esta oficina todavía tiene rutas. Desvincúlalas antes de eliminarla.',
  inactiveOffice: 'Esta ruta pertenece a una Oficina inactiva. No se pueden registrar nuevas operaciones.',
} as const

/**
 * Comprueba unicidad de nombre (obligatorio) y código (opcional) DENTRO de la
 * empresa, sin distinguir mayúsculas ni espacios extremos. No hay unicidad global:
 * dos empresas distintas pueden tener una "Oficina Centro" cada una.
 */
export function validateOfficeIdentity(params: {
  nombre: string
  codigo?: string
  existentes: Pick<Office, 'id' | 'nombre' | 'codigo'>[]
  /** Al editar, la propia oficina se excluye de la comparación. */
  excludeId?: string
}): { ok: true } | { ok: false; message: string } {
  const nombre = params.nombre.trim()
  if (!nombre) return { ok: false, message: OFFICE_MESSAGES.nameRequired }

  const otras = params.existentes.filter(o => o.id !== params.excludeId)
  const nombreKey = normalizeOfficeKey(nombre)
  if (otras.some(o => normalizeOfficeKey(o.nombre) === nombreKey)) {
    return { ok: false, message: OFFICE_MESSAGES.nameDuplicated }
  }

  const codigo = params.codigo?.trim()
  if (codigo) {
    const codigoKey = normalizeOfficeKey(codigo)
    if (otras.some(o => o.codigo && normalizeOfficeKey(o.codigo) === codigoKey)) {
      return { ok: false, message: OFFICE_MESSAGES.codeDuplicated }
    }
  }
  return { ok: true }
}

// ------------------------------------------------------------
// CRUD
// ------------------------------------------------------------
export interface CreateOfficeInput {
  tenantId: string
  nombre: string
  codigo?: string
}

export async function createOffice(
  input: CreateOfficeInput,
  actor: User,
  database: OfficeDatabase = db,
  auditSink: OfficeAuditSink = logAction,
): Promise<Office> {
  assertCan(actor, 'office.create', { tenantId: input.tenantId })

  const existentes = await database.offices.where('tenantId').equals(input.tenantId).toArray()
  const check = validateOfficeIdentity({ nombre: input.nombre, codigo: input.codigo, existentes })
  if (!check.ok) throw new AuthzError(check.message)

  const office: Office = {
    id: generateId(),
    tenantId: input.tenantId,
    nombre: input.nombre.trim(),
    codigo: input.codigo?.trim() || undefined,
    status: 'activa',
    createdAt: nowISO(),
    updatedAt: nowISO(),
  }
  await database.offices.add(office)
  await auditSink({
    tenantId: input.tenantId, userId: actor.id, userRole: actor.rol,
    action: 'CREATE_OFFICE', entityType: 'Office', entityId: office.id,
    descripcion: `Oficina creada: ${office.nombre}`,
    after: { nombre: office.nombre, codigo: office.codigo, status: office.status },
  })
  return office
}

export interface UpdateOfficeInput {
  officeId: string
  tenantId: string
  nombre: string
  codigo?: string
}

export async function updateOffice(
  input: UpdateOfficeInput,
  actor: User,
  database: OfficeDatabase = db,
  auditSink: OfficeAuditSink = logAction,
): Promise<void> {
  assertCan(actor, 'office.edit', { tenantId: input.tenantId })

  const prev = await database.offices.get(input.officeId)
  if (!prev) throw new AuthzError(OFFICE_MESSAGES.notFound)
  if (prev.tenantId !== input.tenantId) throw new AuthzError(OFFICE_MESSAGES.otherTenant)

  const existentes = await database.offices.where('tenantId').equals(input.tenantId).toArray()
  const check = validateOfficeIdentity({
    nombre: input.nombre, codigo: input.codigo, existentes, excludeId: input.officeId,
  })
  if (!check.ok) throw new AuthzError(check.message)

  await database.offices.update(input.officeId, {
    nombre: input.nombre.trim(),
    codigo: input.codigo?.trim() || undefined,
    updatedAt: nowISO(),
  })
  await auditSink({
    tenantId: input.tenantId, userId: actor.id, userRole: actor.rol,
    action: 'UPDATE_OFFICE', entityType: 'Office', entityId: input.officeId,
    descripcion: `Oficina actualizada: ${input.nombre.trim()}`,
    before: { nombre: prev.nombre, codigo: prev.codigo },
    after: { nombre: input.nombre.trim(), codigo: input.codigo?.trim() || undefined },
  })
}

/**
 * Activa o inactiva una Oficina.
 *
 * `inactiva` NO borra nada, NO desasigna usuarios y NO cambia `Route.status`: solo
 * bloquea las operaciones NUEVAS de sus rutas. Reactivar restablece la operación
 * sin necesidad de reasignar a nadie.
 */
export async function setOfficeStatus(
  params: { officeId: string; tenantId: string; status: Office['status'] },
  actor: User,
  database: OfficeDatabase = db,
  auditSink: OfficeAuditSink = logAction,
): Promise<void> {
  assertCan(actor, 'office.changeStatus', { tenantId: params.tenantId })

  const prev = await database.offices.get(params.officeId)
  if (!prev) throw new AuthzError(OFFICE_MESSAGES.notFound)
  if (prev.tenantId !== params.tenantId) throw new AuthzError(OFFICE_MESSAGES.otherTenant)

  await database.offices.update(params.officeId, { status: params.status, updatedAt: nowISO() })
  await auditSink({
    tenantId: params.tenantId, userId: actor.id, userRole: actor.rol,
    action: 'BLOCK_OFFICE', entityType: 'Office', entityId: params.officeId,
    descripcion: `Oficina ${params.status}: ${prev.nombre}`,
    before: { status: prev.status }, after: { status: params.status },
  })
}

/** Rutas de una Oficina (lectura directa; la visibilidad la recorta quien llama). */
export async function getOfficeRoutes(
  officeId: string,
  tenantId: string,
  database: OfficeDatabase = db,
): Promise<Route[]> {
  const all = await database.routes.where('tenantId').equals(tenantId).toArray()
  return all.filter(r => r.officeId === officeId)
}

/**
 * Elimina una Oficina. NUNCA elimina rutas.
 *
 * · `detachRoutes: false` (por defecto) → si tiene rutas, se RECHAZA con un motivo
 *   claro. Mismo criterio que el borrado de rutas con movimientos.
 * · `detachRoutes: true` → en UNA transacción, las rutas quedan "Sin Oficina" y
 *   después se borra la Oficina. Si algo falla, Dexie revierte todo.
 *
 * Clientes, ventas, pagos, parcelas, gastos y `authorizedRouteIds` no se tocan.
 */
export async function deleteOffice(
  params: { officeId: string; tenantId: string; detachRoutes?: boolean },
  actor: User,
  database: OfficeDatabase = db,
  auditSink: OfficeAuditSink = logAction,
): Promise<{ detached: string[] }> {
  assertCan(actor, 'office.delete', { tenantId: params.tenantId })

  const office = await database.offices.get(params.officeId)
  if (!office) throw new AuthzError(OFFICE_MESSAGES.notFound)
  if (office.tenantId !== params.tenantId) throw new AuthzError(OFFICE_MESSAGES.otherTenant)

  const rutas = await getOfficeRoutes(params.officeId, params.tenantId, database)
  if (rutas.length > 0 && !params.detachRoutes) throw new AuthzError(OFFICE_MESSAGES.hasRoutes)

  const detached = rutas.map(r => r.id)
  await database.transaction('rw', [database.offices, database.routes], async () => {
    // Primero desvincular: si el borrado fallara, no quedan rutas apuntando al vacío.
    for (const r of rutas) {
      await database.routes.update(r.id, { officeId: undefined, updatedAt: nowISO() })
    }
    await database.offices.delete(params.officeId)
  })

  await auditSink({
    tenantId: params.tenantId, userId: actor.id, userRole: actor.rol,
    action: 'DELETE_OFFICE', entityType: 'Office', entityId: params.officeId,
    descripcion: detached.length > 0
      ? `Oficina eliminada: ${office.nombre} (${detached.length} ruta(s) quedaron Sin Oficina)`
      : `Oficina eliminada: ${office.nombre}`,
    before: { nombre: office.nombre, status: office.status },
    metadata: { rutasDesvinculadas: detached },
  })
  return { detached }
}

// ------------------------------------------------------------
// Ruta ↔ Oficina
// ------------------------------------------------------------
/**
 * Asigna o mueve una ruta a una Oficina (o la deja Sin Oficina con `officeId: undefined`).
 *
 * Es UNA sola escritura sobre `Route.officeId`. NO se actualiza ningún cliente,
 * venta, pago, parcela, gasto, retiro ni transferencia: todos siguen colgando de la
 * misma ruta y derivan la Oficina por `routeId`. Por eso mover una ruta jamás
 * reescribe el histórico financiero.
 */
export async function moveRouteToOffice(
  params: { routeId: string; tenantId: string; officeId?: string },
  actor: User,
  database: OfficeDatabase = db,
  auditSink: OfficeAuditSink = logAction,
): Promise<void> {
  assertCan(actor, 'route.edit', { routeId: params.routeId, tenantId: params.tenantId })

  const route = await database.routes.get(params.routeId)
  if (!route) throw new AuthzError(OFFICE_MESSAGES.routeNotFound)
  if (route.tenantId !== params.tenantId) throw new AuthzError(OFFICE_MESSAGES.routeOtherTenant)

  let destino: Office | undefined
  if (params.officeId) {
    destino = await database.offices.get(params.officeId)
    if (!destino) throw new AuthzError(OFFICE_MESSAGES.notFound)
    if (destino.tenantId !== params.tenantId) throw new AuthzError(OFFICE_MESSAGES.otherTenant)
  }

  await database.routes.update(params.routeId, { officeId: params.officeId, updatedAt: nowISO() })
  await auditSink({
    tenantId: params.tenantId, userId: actor.id, userRole: actor.rol, routeId: params.routeId,
    action: 'UPDATE_ROUTE', entityType: 'Route', entityId: params.routeId,
    descripcion: destino
      ? `Ruta ${route.nombre} asignada a la Oficina ${destino.nombre}`
      : `Ruta ${route.nombre} quedó Sin Oficina`,
    before: { officeId: route.officeId ?? null },
    after: { officeId: params.officeId ?? null },
  })
}

/** Deja la ruta "Sin Oficina". Atajo legible de `moveRouteToOffice` sin destino. */
export async function detachRouteFromOffice(
  params: { routeId: string; tenantId: string },
  actor: User,
  database: OfficeDatabase = db,
  auditSink: OfficeAuditSink = logAction,
): Promise<void> {
  await moveRouteToOffice({ ...params, officeId: undefined }, actor, database, auditSink)
}

// ============================================================
// OFICINA INACTIVA — GUARDA DE OPERACIONES NUEVAS
// ------------------------------------------------------------
// `can()` es SÍNCRONA y PURA a propósito: no consulta la base. Meter aquí una
// lectura de Dexie rompería esa garantía y la pieza más sensible del sistema.
// Se sigue el mismo camino que el bloqueo de empresa (`isCompanyBlocked`): una
// guarda aparte, explícita, que se invoca en los puntos de ESCRITURA.
//
// Solo aplica a ESCRITURAS. Las lecturas (clientes, ventas, historial, reportes,
// caja histórica) funcionan con normalidad aunque la Oficina esté inactiva.
// ============================================================

/** Decisión PURA: ¿la Oficina de la ruta permite operaciones nuevas? */
export function isRouteOperationBlocked(office: Pick<Office, 'status'> | undefined | null): boolean {
  return office?.status === 'inactiva'
}

/**
 * Lanza si la ruta pertenece a una Oficina INACTIVA. Una ruta Sin Oficina nunca se
 * bloquea por esta regla: no tiene Oficina que la inactive.
 */
export async function assertRouteOperationalContext(
  routeId: string,
  database: OfficeDatabase = db,
): Promise<void> {
  if (!routeId) return
  const route = await database.routes.get(routeId)
  if (!route?.officeId) return          // Sin Oficina → sin restricción por Oficina
  const office = await database.offices.get(route.officeId)
  if (isRouteOperationBlocked(office)) throw new AuthzError(OFFICE_MESSAGES.inactiveOffice)
}

/** Variante no lanzante, para que la UI pueda avisar antes de intentar guardar. */
export async function isRouteOperational(
  routeId: string,
  database: OfficeDatabase = db,
): Promise<boolean> {
  try {
    await assertRouteOperationalContext(routeId, database)
    return true
  } catch {
    return false
  }
}

// ============================================================
// RESUMEN DE GESTIÓN DE UNA OFICINA
// ------------------------------------------------------------
// Punto ÚNICO de carga de la pantalla de Oficina, para que ninguna vista invente
// su propia consulta y se salte el recorte.
//
// ORDEN OBLIGATORIO, y la razón por la que existe esta función:
//   1. rutas de la EMPRESA            → se cargan
//   2. filterAccessibleRoutes(user)   → se RECORTAN a las autorizadas
//   3. se filtran por la Oficina      → accessibleOfficeRoutes
//   4. TODO lo demás (indicadores, alertas, usuarios, clientes, ventas) se calcula
//      exclusivamente sobre ese conjunto.
//
// Jamás al revés: nunca se parte de la Oficina para descubrir rutas. Entrar a una
// Oficina no concede ni una sola ruta que el usuario no tuviera ya.
//
// La ÚNICA cifra que mira más allá es `totalRoutesInOffice`, un conteo estructural
// para poder decir "3 de 5 rutas visibles" en vez de aparentar que el consolidado
// parcial es el total. Es un número: no expone clientes, ventas ni dinero de las
// rutas que el usuario no tiene.
// ============================================================
import { filterAccessibleRoutes } from '@/lib/permissions'
import { getAssignedRouteIds } from '@/lib/roles'
import { getRoutesFinancialSummary } from '@/services/cashboxEngine'
import {
  officeKpis, officeAlerts, officeScope, relatedUsersOfOffice, routeOperationalState,
  type OfficeAlert, type OfficeKpis, type OfficeRouteFacts, type OfficeScope, type RelatedUser,
} from '@/lib/officeManagement'
import {
  routeOpsFacts, officeOpsTotals, officeFinanceTotals, opsAlerts,
  type OfficeFinanceTotals, type OfficeOpsTotals, type OpsAlert, type RouteOpsFacts,
} from '@/lib/officeOperations'
import { routeAdmins } from '@/lib/routeAdmins'
import { officeActivity, type OfficeActivityEntry } from '@/lib/officeExecutive'
import { getCashboxSummary } from '@/services/cashboxEngine'
import { today as hoyISO } from '@/lib/formatters'
import { can } from '@/lib/permissions'

export interface OfficeManagementSummary {
  office: Office
  /** Rutas de la Oficina que el usuario TIENE AUTORIZADAS. Nunca más que eso. */
  accessibleOfficeRoutes: Route[]
  /** Hechos por ruta (base de indicadores y alertas). */
  facts: OfficeRouteFacts[]
  kpis: OfficeKpis
  alerts: OfficeAlert[]
  /** Cobertura del usuario sobre la Oficina (para el rótulo honesto). */
  scope: OfficeScope
  /** Usuarios con rutas asignadas en esta Oficina (derivado de authorizedRouteIds). */
  relatedUsers: RelatedUser[]
  /** Usuarios de la empresa que el actor podría asignar (para el gestor de asignaciones). */
  assignableUsers: User[]
  /** Hechos operativos por ruta VISIBLE (cobranza, cartera, atrasos). */
  routeOps: RouteOpsFacts[]
  /** Totales operativos de la Oficina: la suma de `routeOps`. */
  ops: OfficeOpsTotals
  /**
   * Consolidado financiero de la Oficina. `null` cuando el rol no tiene permiso
   * financiero sobre las rutas: el dato no se calcula ni se envía a la pantalla.
   */
  finance: OfficeFinanceTotals | null
  /** Alertas operativas avanzadas (cartera vencida, atrasos, cumplimiento, sin Admin). */
  opsAlerts: OpsAlert[]
  /** Fecha contable usada para los cálculos del día. */
  fecha: string
  /** Actividad reciente, recortada a las rutas accesibles de la Oficina. */
  activity: OfficeActivityEntry[]
}

export async function getOfficeManagementSummary(
  params: { user: User | null | undefined; tenantId: string; officeId: string },
  database: OfficeSummaryDatabase = db,
): Promise<OfficeManagementSummary | null> {
  const { user, tenantId, officeId } = params
  if (!user || !tenantId || !officeId) return null

  const office = await database.offices.get(officeId)
  if (!office || office.tenantId !== tenantId) return null

  // --- 1 y 2: rutas de la empresa, RECORTADAS al alcance del usuario ---
  const allRoutes = await database.routes.where('tenantId').equals(tenantId).toArray()
  const accessible = filterAccessibleRoutes(user, allRoutes)

  // --- 3: solo las de esta Oficina ---
  const accessibleOfficeRoutes = accessible.filter(r => r.officeId === officeId)
  const routeIds = new Set(accessibleOfficeRoutes.map(r => r.id))

  // Conteo ESTRUCTURAL (no da acceso): cuántas rutas tiene la Oficina en la empresa.
  const totalRoutesInOffice = allRoutes.filter(r => r.officeId === officeId).length

  // --- 4: todo lo demás, solo sobre las rutas accesibles ---
  const [users, clients, sales, resumenes] = await Promise.all([
    database.users.where('tenantId').equals(tenantId).toArray(),
    database.clients.where('tenantId').equals(tenantId).toArray(),
    database.sales.where('tenantId').equals(tenantId).toArray(),
    getRoutesFinancialSummary([...routeIds]).catch(() => ({})),
  ])

  const clientesDeRuta = (routeId: string) =>
    clients.filter(c => c.routeId === routeId && c.status !== 'inactivo').length
  const ventasDeRuta = (routeId: string) =>
    sales.filter(s => s.routeId === routeId && s.status === 'activa' && s.disbursementStatus !== 'pendiente').length
  const desembolsosPendientesDeRuta = (routeId: string) =>
    sales.filter(s => s.routeId === routeId && s.status === 'activa' && s.disbursementStatus === 'pendiente').length

  const facts: OfficeRouteFacts[] = accessibleOfficeRoutes.map(r => {
    const cobradores = users
      .filter(u => u.rol === 'cobrador' && getAssignedRouteIds(u).includes(r.id))
      .map(u => u.id)
    const fin = (resumenes as Record<string, { carteraEnCalle?: number; clientesActivos?: number; ventasActivas?: number }>)[r.id]
    return {
      routeId: r.id,
      nombre: r.nombre,
      state: routeOperationalState({ status: r.status, assignedCobradorIds: cobradores, cobradorId: r.cobradorId }),
      // Se prefiere el motor de caja (fuente única); si no respondiera, se cae al
      // conteo directo, que usa exactamente el mismo criterio.
      clientesActivos: fin?.clientesActivos ?? clientesDeRuta(r.id),
      ventasActivas: fin?.ventasActivas ?? ventasDeRuta(r.id),
      desembolsosPendientes: desembolsosPendientesDeRuta(r.id),
      carteraEnCalle: fin?.carteraEnCalle ?? 0,
    }
  })

  const kpis = officeKpis(facts)

  // ---- OPERACIÓN Y FINANZAS ----------------------------------------------
  // Se cargan las filas de la EMPRESA una sola vez y se indexan en memoria: con el
  // recorte por `routeIds` no hay ninguna consulta por ruta ni por fila (sin N+1).
  const fecha = hoyISO()
  const [payments, expenses, installments] = await Promise.all([
    database.payments.where('tenantId').equals(tenantId).toArray(),
    database.expenses.where('tenantId').equals(tenantId).toArray(),
    database.installments.toArray(),
  ])

  const ventasDeLaOficina = sales.filter(s => routeIds.has(s.routeId))
  const idsDeVenta = new Set(ventasDeLaOficina.map(s => s.id))
  const installmentsBySale = new Map<string, Installment[]>()
  for (const i of installments) {
    if (!idsDeVenta.has(i.saleId)) continue
    const lista = installmentsBySale.get(i.saleId) ?? []
    lista.push(i)
    installmentsBySale.set(i.saleId, lista)
  }

  const routeOps: RouteOpsFacts[] = accessibleOfficeRoutes.map(r => routeOpsFacts({
    routeId: r.id,
    nombre: r.nombre,
    sales: ventasDeLaOficina.filter(s => s.routeId === r.id),
    installmentsBySale,
    payments: payments.filter(p => p.routeId === r.id),
    expenses: expenses.filter(e => e.routeId === r.id),
    today: fecha,
  }))

  // FINANZAS: solo para roles con permiso sobre la caja de ruta. Si no lo tienen,
  // el dato ni siquiera se calcula.
  const puedeVerFinanzas = accessibleOfficeRoutes.some(r =>
    can(user, 'cashbox.viewRoute', { routeId: r.id, tenantId }))
  let finance: OfficeFinanceTotals | null = null
  if (puedeVerFinanzas && accessibleOfficeRoutes.length > 0) {
    try {
      const cajas = await Promise.all(accessibleOfficeRoutes.map(r => getCashboxSummary(r.id)))
      const financieros = accessibleOfficeRoutes.map(r => {
        const fin = (resumenes as Record<string, { baseActual?: number; carteraEnCalle?: number }>)[r.id]
        return { baseActual: fin?.baseActual ?? 0, carteraEnCalle: fin?.carteraEnCalle ?? 0 }
      })
      finance = officeFinanceTotals(cajas, financieros)
    } catch {
      // El motor de caja no respondió: se muestra el panel sin consolidado en vez
      // de dejar la pantalla caída. Los indicadores operativos no dependen de él.
      finance = null
    }
  }

  // Rutas de la Oficina sin ningún Administrador EFECTIVO (activo y asignado).
  const routesWithoutAdmin = accessibleOfficeRoutes
    .filter(r => routeAdmins(users, r.id, tenantId).length === 0)
    .map(r => ({ routeId: r.id, nombre: r.nombre }))

  // ---- ACTIVIDAD RECIENTE -------------------------------------------------
  // Se parte de las rutas ACCESIBLES de la Oficina y se filtra la auditoría por
  // ellas. Un registro de una ruta no autorizada no aparece aunque pertenezca a
  // esta Oficina.
  let activity: OfficeActivityEntry[] = []
  try {
    const logs = await database.auditLogs.where('tenantId').equals(tenantId).toArray()
    activity = officeActivity({
      rows: logs,
      officeRouteIds: [...routeIds],
      routeNameById: new Map(accessibleOfficeRoutes.map(r => [r.id, r.nombre])),
      userNameById: new Map(users.map(u => [u.id, u.nombre])),
      limit: 15,
    })
  } catch {
    // La auditoría es informativa: si no se puede leer, el panel sigue completo.
    activity = []
  }

  return {
    office,
    accessibleOfficeRoutes,
    facts,
    kpis,
    activity,
    routeOps,
    ops: officeOpsTotals(routeOps),
    finance,
    opsAlerts: opsAlerts({ facts: routeOps, routesWithoutAdmin }),
    fecha,
    alerts: officeAlerts({ office, facts }),
    scope: officeScope(accessibleOfficeRoutes.length, totalRoutesInOffice),
    relatedUsers: relatedUsersOfOffice(users, accessibleOfficeRoutes, tenantId),
    // Candidatos del gestor de asignaciones: usuarios operativos de la empresa.
    // Que aparezcan aquí no les concede nada; solo permite marcar rutas de ESTA
    // Oficina, y la escritura conserva sus rutas de las demás.
    assignableUsers: users.filter(u => u.rol !== 'superadmin'),
  }
}

/**
 * Guarda las asignaciones de un usuario decididas DESDE una Oficina.
 *
 * Solo se tocan las rutas de esa Oficina: las que el usuario tenga en otras
 * Oficinas (o Sin Oficina) se conservan intactas. Se delega en el mecanismo de
 * asignación existente (`setCobradorRoutes` para cobradores, que además sincroniza
 * el responsable de la ruta) para no duplicar lógica.
 */
export async function setUserOfficeRoutes(
  params: {
    userId: string
    tenantId: string
    /** Rutas de ESTA Oficina sobre las que se decide. */
    officeRouteIds: string[]
    /** Subconjunto que queda marcado. */
    selectedRouteIds: string[]
  },
  actor: User,
  auditSink: OfficeAuditSink = logAction,
): Promise<{ authorizedRouteIds: string[] }> {
  assertCan(actor, 'route.assign', { tenantId: params.tenantId })

  const target = await db.users.get(params.userId)
  if (!target) throw new AuthzError('El usuario no existe o fue eliminado.')
  if (target.tenantId !== params.tenantId) throw new AuthzError('Ese usuario pertenece a otra empresa.')
  if (!canManageUser(actor, target)) throw new AuthzError('No puedes gestionar las asignaciones de ese usuario.')

  const antes = getAssignedRouteIds(target)
  const despues = applyOfficeRouteSelection(antes, params.officeRouteIds, params.selectedRouteIds)

  if (target.rol === 'cobrador') {
    // Reutiliza el mecanismo existente: mantiene coherente `route.cobradorId`.
    await setCobradorRoutes(params.userId, despues)
  } else {
    await db.users.update(params.userId, {
      authorizedRouteIds: despues.length ? despues : undefined,
      routeId: despues[0],
      updatedAt: nowISO(),
    })
  }

  const agregadas = despues.filter(id => !antes.includes(id))
  const retiradas = antes.filter(id => !despues.includes(id))
  await auditSink({
    tenantId: params.tenantId, userId: actor.id, userRole: actor.rol,
    action: 'ASSIGN_ROUTE', entityType: 'User', entityId: params.userId,
    descripcion: `Asignaciones de ${target.nombre} actualizadas desde una Oficina`,
    before: { authorizedRouteIds: antes },
    after: { authorizedRouteIds: despues },
    metadata: { agregadas, retiradas, alcance: 'oficina', rutasDeLaOficina: params.officeRouteIds },
  })
  return { authorizedRouteIds: despues }
}

/**
 * Asigna VARIAS rutas a una Oficina (o las deja Sin Oficina) en UNA transacción.
 *
 * Pensado para organizar de golpe las rutas que la migración v11 dejó Sin Oficina.
 * Igual que el movimiento individual: solo cambia `Route.officeId`. Ninguna entidad
 * hija se toca, porque todas derivan la Oficina por `routeId`.
 *
 * Es todo-o-nada: si una ruta falla la validación, no se mueve ninguna. Cada ruta
 * se audita por separado para que el rastro siga siendo por ruta, como el resto
 * del sistema.
 */
export async function assignRoutesToOffice(
  params: { routeIds: string[]; tenantId: string; officeId?: string },
  actor: User,
  database: OfficeDatabase = db,
  auditSink: OfficeAuditSink = logAction,
): Promise<{ moved: string[] }> {
  assertCan(actor, 'route.edit', { tenantId: params.tenantId })
  if (params.routeIds.length === 0) return { moved: [] }

  let destino: Office | undefined
  if (params.officeId) {
    destino = await database.offices.get(params.officeId)
    if (!destino || destino.tenantId !== params.tenantId) throw new AuthzError(OFFICE_MESSAGES.notFound)
  }

  // VALIDACIÓN COMPLETA ANTES DE ESCRIBIR: si alguna ruta no es válida, no se
  // mueve ninguna (evita dejar la organización a medias).
  const rutas: Route[] = []
  for (const id of params.routeIds) {
    const r = await database.routes.get(id)
    if (!r) throw new AuthzError(OFFICE_MESSAGES.routeNotFound)
    if (r.tenantId !== params.tenantId) throw new AuthzError(OFFICE_MESSAGES.routeOtherTenant)
    rutas.push(r)
  }

  await database.transaction('rw', [database.routes, database.offices], async () => {
    for (const r of rutas) {
      await database.routes.update(r.id, { officeId: params.officeId, updatedAt: nowISO() })
    }
  })

  for (const r of rutas) {
    await auditSink({
      tenantId: params.tenantId, userId: actor.id, userRole: actor.rol, routeId: r.id,
      action: 'UPDATE_ROUTE', entityType: 'Route', entityId: r.id,
      descripcion: destino
        ? `Ruta ${r.nombre} asignada a la Oficina ${destino.nombre} (organización masiva)`
        : `Ruta ${r.nombre} quedó Sin Oficina (organización masiva)`,
      before: { officeId: r.officeId ?? null },
      after: { officeId: params.officeId ?? null },
    })
  }
  return { moved: rutas.map(r => r.id) }
}

// ============================================================
// RESUMEN EJECUTIVO DE OFICINAS (Dashboard de empresa y comparativo)
// ------------------------------------------------------------
// Mismo orden de siempre: rutas de la empresa → recorte por usuario → agrupación
// por Oficina → métricas. Cada fila se construye SOLO con las rutas accesibles de
// su Oficina; el total de rutas de cada una es un conteo estructural que permite
// declarar el alcance parcial sin exponer ningún dato ajeno.
// ============================================================
import {
  officeComparison, companyOfficesSummary,
  type CompanyOfficesSummary, type OfficeComparisonRow,
} from '@/lib/officeExecutive'

export interface OfficesExecutiveSummary {
  rows: OfficeComparisonRow[]
  company: CompanyOfficesSummary
  fecha: string
}

export async function getOfficesExecutiveSummary(
  params: { user: User | null | undefined; tenantId: string },
  database: OfficeSummaryDatabase = db,
): Promise<OfficesExecutiveSummary | null> {
  const { user, tenantId } = params
  if (!user || !tenantId) return null

  const [allRoutes, offices, users, sales, payments, expenses, installments] = await Promise.all([
    database.routes.where('tenantId').equals(tenantId).toArray(),
    database.offices.where('tenantId').equals(tenantId).toArray(),
    database.users.where('tenantId').equals(tenantId).toArray(),
    database.sales.where('tenantId').equals(tenantId).toArray(),
    database.payments.where('tenantId').equals(tenantId).toArray(),
    database.expenses.where('tenantId').equals(tenantId).toArray(),
    database.installments.toArray(),
  ])

  const accessible = filterAccessibleRoutes(user, allRoutes)
  const routeIds = new Set(accessible.map(r => r.id))
  const fecha = hoyISO()

  // Índices en memoria: ninguna consulta por ruta ni por fila.
  const ventasVisibles = sales.filter(s => routeIds.has(s.routeId))
  const idsDeVenta = new Set(ventasVisibles.map(s => s.id))
  const installmentsBySale = new Map<string, Installment[]>()
  for (const i of installments) {
    if (!idsDeVenta.has(i.saleId)) continue
    const lista = installmentsBySale.get(i.saleId) ?? []
    lista.push(i)
    installmentsBySale.set(i.saleId, lista)
  }

  const facts = accessible.map(r => routeOpsFacts({
    routeId: r.id,
    nombre: r.nombre,
    sales: ventasVisibles.filter(s => s.routeId === r.id),
    installmentsBySale,
    payments: payments.filter(p => p.routeId === r.id),
    expenses: expenses.filter(e => e.routeId === r.id),
    today: fecha,
  }))

  // Alertas por Oficina: se cuentan las operativas de sus rutas visibles más las
  // rutas sin Administrador efectivo. Misma derivación que el panel de Oficina.
  const sinAdmin = accessible
    .filter(r => routeAdmins(users, r.id, tenantId).length === 0)
    .map(r => ({ routeId: r.id, nombre: r.nombre }))
  const alertas = opsAlerts({ facts, routesWithoutAdmin: sinAdmin })
  const officeOf = new Map(accessible.map(r => [r.id, r.officeId]))
  const alertCountByOffice: Record<string, number> = {}
  for (const a of alertas) {
    const clave = (a.routeId ? officeOf.get(a.routeId) : undefined) || '__sin_oficina__'
    alertCountByOffice[clave] = (alertCountByOffice[clave] ?? 0) + 1
  }

  const rows = officeComparison({ facts, accessibleRoutes: accessible, allRoutes, offices, alertCountByOffice })
  return { rows, company: companyOfficesSummary(rows), fecha }
}
