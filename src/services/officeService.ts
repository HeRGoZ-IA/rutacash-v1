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
import type { Office, Route, User } from '@/models/types'

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
