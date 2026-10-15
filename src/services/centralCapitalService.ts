// ============================================================
// CAPITAL CENTRALIZADO (C1) — SERVICIO DE DOMINIO
// ------------------------------------------------------------
// Reglas en `lib/centralCapital`. Operaciones:
//
//   activateCentralCapitalModel   SuperAdmin: activa el modelo en SU empresa (explícito;
//                                 nada lo activa al cargar la aplicación)
//   diagnoseCentralCapitalTransition  solo lectura: saldo heredado e inconsistencias
//   deliverCapitalToWorker        bolsa del responsable → trabajador (ruta identificada)
//   returnCapitalFromWorker       trabajador → bolsa del responsable
//   reverseCapitalDelivery        anula una entrega que el trabajador aún conserva
//   registerPartnerContribution   socio → bolsa del responsable de la ruta
//   reversePartnerContribution    anula ese aporte si la bolsa aún lo tiene
//
// GARANTÍAS (en el servicio, nunca solo en la pantalla):
//   · Actor, capacidad, empresa, ruta en alcance, Oficina activa (operación nueva).
//   · Autoridad sobre el capital de la ruta (v16): entregar = 'structural' (solo el
//     responsable); recibir una devolución = 'settle'; anular = 'correct'.
//   · Saldos RELEÍDOS dentro de la transacción: dos entregas simultáneas no gastan
//     el mismo disponible; una devolución no supera lo que la persona tiene.
//   · Pares atómicos: capital + custodia (o retiro + custodia) en UNA transacción,
//     con ids derivados de la operación: el reintento devuelve lo ya guardado.
//   · D7: el asiento lleva la fecha de hoy y no entra en una semana cerrada.
//   · Una entrega NO crea venta ni deuda. La referencia a una solicitud es opcional.
//   · El trabajador no ve la bolsa: los mensajes con cifras de la bolsa solo se
//     muestran a quien opera el capital.
// ============================================================
import { db, type RutaCashDB } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { nowISO, today } from '@/lib/formatters'
import { authorizedRouteIdsOf, can, isTransferInScope, routeCapitalController } from '@/lib/permissions'
import { adminCapital } from '@/lib/capitalAllocation'
import { centralIds, classifyRouteTransition, isCentralCapitalActive, type RouteTransitionStatus } from '@/lib/centralCapital'
import { normalizeReversalReason } from '@/lib/movementReversal'
import { assertCan, assertRouteAccess, assertRouteCashAuthority, AuthzError } from '@/services/authz'
import { logAction } from '@/services/auditService'
import { assertRouteOperationalContext } from '@/services/officeService'
import { closedPeriodBlockedReason } from '@/services/periodGuard'
import { capitalTables, loadCapitalRows, operationIdOf, type CapitalControlDatabase } from '@/services/capitalControlService'
import { custodianBlockedReason, transferableCash } from '@/services/cashCustodyService'
import { personalCashPosition } from '@/services/cashSettlementService'
import { computeRouteCashReconciliation } from '@/services/routeCashReconciliation'
import { fundsTables } from '@/services/routeFundsService'
import {
  CentralCapitalError, centralLedgerTables, creditControllerPool, debitControllerPool, reverseCentralCapitalMovement,
} from '@/services/centralCapitalLedger'
import type {
  CapitalLedgerEntry, CapitalMovement, CashCustodyMovement, PartnerCashMovement, Route, Tenant, User, Withdrawal,
} from '@/models/types'

export { CentralCapitalError }

function exigirActor(actor: User | null | undefined): User {
  if (!actor) throw new AuthzError('Acción no autorizada: falta el usuario.')
  return actor
}

function validarMonto(valor: unknown): number {
  const n = Number(valor)
  if (!Number.isFinite(n) || n <= 0 || Math.round(n) !== n) throw new CentralCapitalError('El valor debe ser un entero mayor a 0.')
  return n
}

function validarMotivo(motivo: string | undefined): string {
  const m = (motivo ?? '').trim()
  if (m.length < 3) throw new CentralCapitalError('Indica el motivo del movimiento.')
  return m
}

async function rutaDeLaEmpresa(routeId: string, tenantId: string, database: RutaCashDB): Promise<Route> {
  const route = await database.routes.get(routeId)
  if (!route) throw new CentralCapitalError('La ruta indicada no existe.')
  if (route.tenantId !== tenantId) throw new AuthzError('La ruta no pertenece a esta empresa.')
  return route
}

async function exigirModeloActivo(tenantId: string, database: RutaCashDB): Promise<void> {
  if (!isCentralCapitalActive(await database.tenants.get(tenantId))) {
    throw new CentralCapitalError('El capital centralizado no está activo en esta empresa.')
  }
}

async function exigirAutoridad(actor: User, routeId: string, tenantId: string, op: 'structural' | 'settle' | 'correct', database: RutaCashDB) {
  const [route, users] = await Promise.all([
    database.routes.get(routeId),
    database.users.where('tenantId').equals(tenantId).toArray(),
  ])
  assertRouteCashAuthority(actor, route, op, users)
}

async function exigirPeriodoAbiertoHoy(routeId: string, database: RutaCashDB): Promise<void> {
  const cerrado = await closedPeriodBlockedReason(routeId, today(), database)
  if (cerrado) throw new CentralCapitalError(cerrado)
}

async function auditar(params: Parameters<typeof logAction>[0]) {
  await logAction(params).catch(() => undefined)
}

/** Alcance de las transacciones de este servicio. */
function tablas(database: RutaCashDB, extra: unknown[] = []) {
  return [...new Set([...fundsTables(database), ...centralLedgerTables(database), ...extra])] as never[]
}

// ============================================================
// ACTIVACIÓN (explícita) Y DIAGNÓSTICO
// ============================================================

/**
 * Activa el capital centralizado en la empresa. Solo el SuperAdmin de ESA empresa.
 * No mueve dinero ni reescribe movimientos: fija el instante desde el que rigen las
 * reglas nuevas y deja en la auditoría la foto del saldo heredado de cada ruta.
 * Idempotente: si ya está activo, devuelve la empresa sin cambios.
 *
 * En C1 NINGUNA pantalla la invoca; la transición controlada pertenece a C2.
 */
export async function activateCentralCapitalModel(
  params: { actor: User | null | undefined; tenantId: string; motivo: string },
  database: RutaCashDB = db,
): Promise<Tenant> {
  const actor = exigirActor(params.actor)
  const { tenantId } = params
  if (actor.tenantId !== tenantId) throw new AuthzError('Empresa no autorizada.')
  assertCan(actor, 'capital.allocateAdmins', { tenantId })
  const motivo = validarMotivo(params.motivo)
  const foto = await diagnoseCentralCapitalTransition({ actor, tenantId }, database)
  let tenant!: Tenant
  let yaActivo = false
  await database.transaction('rw', [database.tenants], async () => {
    const t = await database.tenants.get(tenantId)
    if (!t) throw new CentralCapitalError('La empresa no existe.')
    if (t.centralCapitalStartAt) { tenant = t; yaActivo = true; return }
    const ahora = nowISO()
    tenant = { ...t, centralCapitalStartAt: ahora, updatedAt: ahora }
    await database.tenants.put(tenant)
  })
  if (yaActivo) return tenant
  await auditar({
    tenantId, userId: actor.id, userRole: actor.rol, action: 'CENTRAL_CAPITAL_ACTIVATED', entityType: 'tenant', entityId: tenantId,
    descripcion: `Capital centralizado activado. Rutas: ${foto.rutas.length}; con saldo heredado: ${foto.rutas.filter(r => r.estado === 'saldo-heredado').length}; inconsistentes: ${foto.rutas.filter(r => r.estado === 'inconsistente').length}.`,
    motivo,
    after: { centralCapitalStartAt: tenant.centralCapitalStartAt },
    metadata: { rutas: foto.rutas.map(r => ({ routeId: r.routeId, estado: r.estado, base: r.base, saldoHeredado: r.sinAsignar, cuadra: r.cuadra })) },
  })
  return tenant
}

export interface RouteTransitionDiagnosis {
  routeId: string
  nombre: string
  controllerAdminId?: string
  estado: RouteTransitionStatus
  base: number
  /** "Sin asignar": con el modelo activo, es el saldo heredado de la caja de la ruta. */
  sinAsignar: number
  enTrabajadores: number
  cuadra: boolean
  faltantesPendientes: number
  sobrantesRegistrados: number
  /** Movimientos de capital/retiro/custodia del modelo centralizado vs. anteriores. */
  movimientosCentralizados: number
  movimientosHistoricos: number
}

export interface CentralCapitalDiagnosis {
  tenantId: string
  activo: boolean
  activoDesde?: string
  rutas: RouteTransitionDiagnosis[]
}

/**
 * Diagnóstico de transición (SOLO LECTURA; no escribe nada). SuperAdmin: todas las
 * rutas; Administrador: solo las que controla. Clasifica cada ruta:
 *   limpia · saldo-heredado · inconsistente · sin-responsable
 * No propone ni aplica correcciones: los saldos heredados salen con operaciones
 * existentes y auditadas, y las inconsistencias requieren revisión humana.
 */
export async function diagnoseCentralCapitalTransition(
  params: { actor: User | null | undefined; tenantId: string },
  database: RutaCashDB = db,
): Promise<CentralCapitalDiagnosis> {
  const actor = exigirActor(params.actor)
  const { tenantId } = params
  if (actor.tenantId !== tenantId) throw new AuthzError('Empresa no autorizada.')
  const sa = can(actor, 'capital.allocateAdmins', { tenantId })
  if (!sa && !can(actor, 'capital.manage', { tenantId })) throw new AuthzError('Acción no autorizada (capital).')
  const [tenant, routes, users] = await Promise.all([
    database.tenants.get(tenantId),
    database.routes.where('tenantId').equals(tenantId).toArray(),
    database.users.where('tenantId').equals(tenantId).toArray(),
  ])
  const visibles = routes
    .filter(r => sa || r.capitalControllerAdminId === actor.id)
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
  const rutas: RouteTransitionDiagnosis[] = []
  for (const route of visibles) {
    const r = await computeRouteCashReconciliation({ tenantId, routeId: route.id }, database)
    const controller = routeCapitalController(route, users)
    const centralizados = [
      ...r.movimientosEstructurales.capital, ...r.movimientosEstructurales.retiros, ...r.custodia,
    ].filter(m => (m as { centralLink?: unknown }).centralLink).length
    const totales = r.movimientosEstructurales.capital.length + r.movimientosEstructurales.retiros.length + r.custodia.length
    rutas.push({
      routeId: route.id, nombre: route.nombre, controllerAdminId: controller?.id,
      estado: classifyRouteTransition({ tieneResponsable: !!controller, cuadra: r.cuadra, noAsignado: r.noAsignado }),
      base: r.libro.saldo, sinAsignar: r.noAsignado, enTrabajadores: r.enPersonas, cuadra: r.cuadra,
      faltantesPendientes: r.faltantes.reduce((s, f) => s + f.monto, 0),
      sobrantesRegistrados: r.sobrantes.reduce((s, x) => s + x.monto, 0),
      movimientosCentralizados: centralizados, movimientosHistoricos: totales - centralizados,
    })
  }
  return { tenantId, activo: isCentralCapitalActive(tenant), activoDesde: tenant?.centralCapitalStartAt, rutas }
}

// ============================================================
// ENTREGA DE CAPITAL AL TRABAJADOR
// ============================================================
export interface DeliverCapitalParams {
  actor: User | null | undefined
  tenantId: string
  routeId: string
  recipientUserId: string
  amount: number
  motivo: string
  /** Id de la operación (lo genera el formulario al abrirse): el reintento no duplica. */
  operationId?: string
  /** Solicitud de venta para la que se anticipa el capital (opcional; no crea venta). */
  saleRequestId?: string
}

export interface CapitalDelivery {
  capital: CapitalMovement
  custody: CashCustodyMovement
}

/**
 * Bolsa del Administrador responsable → trabajador de la ruta. La bolsa baja X una
 * sola vez (`CapitalMovement` con `adminId`), la posición del trabajador en ESA ruta
 * sube X (`BASE_ASSIGNMENT`) y "Sin asignar" no cambia. El trabajador puede usar ese
 * efectivo para desembolsar ventas autorizadas: el desembolso descuenta de su
 * posición, no otra vez de la bolsa. El importe lo decide el Administrador (completo,
 * solo la diferencia, o anticipado al inicio del día).
 */
export async function deliverCapitalToWorker(params: DeliverCapitalParams, database: RutaCashDB = db): Promise<CapitalDelivery> {
  const actor = exigirActor(params.actor)
  const { tenantId, routeId, recipientUserId } = params
  assertCan(actor, 'capital.manage', { routeId, tenantId })
  assertCan(actor, 'cashCustody.manage', { routeId, tenantId })
  assertRouteAccess(actor, routeId)
  const route = await rutaDeLaEmpresa(routeId, tenantId, database)
  await exigirModeloActivo(tenantId, database)
  await exigirAutoridad(actor, routeId, tenantId, 'structural', database)
  await assertRouteOperationalContext(routeId)
  const amount = validarMonto(params.amount)
  const motivo = validarMotivo(params.motivo)
  const receptor = await database.users.get(recipientUserId)
  const bloqueo = custodianBlockedReason(receptor, routeId, tenantId)
  if (bloqueo) throw new CentralCapitalError(bloqueo)
  if (params.saleRequestId) {
    const req = await database.saleRequests.get(params.saleRequestId)
    if (!req || req.tenantId !== tenantId || req.routeId !== routeId) {
      throw new CentralCapitalError('La solicitud de venta indicada no existe en esta ruta.')
    }
  }
  const op = operationIdOf(params.operationId, m => new CentralCapitalError(m))
  const link = { kind: 'ENTREGA_TRABAJADOR' as const, operationId: op }
  let result!: CapitalDelivery
  let reintento = false
  await database.transaction('rw', tablas(database, [database.saleRequests]), async () => {
    const previo = await database.capitalMovements.get(op)
    if (previo) {
      const custodiaPrevia = await database.cashCustodyMovements.get(centralIds.custodia(op))
      if (previo.tenantId !== tenantId || previo.routeId !== routeId || previo.valor !== amount || previo.userId !== actor.id
        || previo.centralLink?.kind !== 'ENTREGA_TRABAJADOR' || custodiaPrevia?.toUserId !== recipientUserId) {
        throw new CentralCapitalError('Ese identificador de operación ya corresponde a otro movimiento.')
      }
      result = { capital: previo, custody: custodiaPrevia }
      reintento = true
      return
    }
    // Responsable releído DENTRO de la transacción (un cambio previo ya cuenta).
    await exigirAutoridad(actor, routeId, tenantId, 'structural', database)
    await exigirPeriodoAbiertoHoy(routeId, database)
    const capital = await debitControllerPool(database, {
      tenantId, routeId, amount, actor, link, id: op, controller: actor,
      descripcion: `Entrega de capital a ${receptor!.nombre} (${route.nombre}): ${motivo}`,
    })
    const custody: CashCustodyMovement = {
      id: centralIds.custodia(op), tenantId, routeId, tipo: 'BASE_ASSIGNMENT', amount, toUserId: recipientUserId,
      origen: 'admin-pool', centralLink: link, saleRequestId: params.saleRequestId || undefined,
      motivo, fecha: today(), createdAt: capital.createdAt, createdByUserId: actor.id,
    }
    await database.cashCustodyMovements.add(custody)
    result = { capital, custody }
  })
  if (reintento) return result
  await auditar({
    tenantId, userId: actor.id, userRole: actor.rol, routeId, action: 'CENTRAL_CAPITAL_DELIVERED',
    entityType: 'capitalMovement', entityId: op,
    descripcion: `Capital ${amount} de la bolsa de ${actor.nombre} entregado a ${receptor!.nombre} en ${route.nombre}.`,
    after: { amount, recipientUserId, adminId: actor.id, saleRequestId: params.saleRequestId }, motivo,
  })
  return result
}

// ============================================================
// DEVOLUCIÓN DEL TRABAJADOR A LA BOLSA
// ============================================================
export interface ReturnCapitalParams {
  actor: User | null | undefined
  tenantId: string
  routeId: string
  fromUserId: string
  amount: number
  motivo: string
  operationId?: string
}

export interface CapitalReturn {
  custody: CashCustodyMovement
  withdrawal: Withdrawal
}

/**
 * Trabajador → bolsa del Administrador responsable. La posición del trabajador en
 * la ruta baja X (`BASE_RETURN`), la bolsa sube X (`Withdrawal` con `adminId`) y "Sin
 * asignar" no cambia. Autoridad 'settle' (responsable, SuperAdmin o Supervisor de la
 * ruta, como recibir una devolución en v16); nadie registra su propia devolución.
 * No supera la posición de la persona (puede saldar su faltante arrastrado).
 */
export async function returnCapitalFromWorker(params: ReturnCapitalParams, database: RutaCashDB = db): Promise<CapitalReturn> {
  const actor = exigirActor(params.actor)
  const { tenantId, routeId, fromUserId } = params
  assertCan(actor, 'cashCustody.manage', { routeId, tenantId })
  const route = await rutaDeLaEmpresa(routeId, tenantId, database)
  await exigirModeloActivo(tenantId, database)
  await exigirAutoridad(actor, routeId, tenantId, 'settle', database)
  if (actor.id === fromUserId) throw new CentralCapitalError('No puedes registrar tu propia devolución: debe recibirla otra persona autorizada.')
  const persona = await database.users.get(fromUserId)
  if (!persona || persona.tenantId !== tenantId) throw new CentralCapitalError('La persona indicada no existe en esta empresa.')
  const amount = validarMonto(params.amount)
  const motivo = validarMotivo(params.motivo)
  const op = operationIdOf(params.operationId, m => new CentralCapitalError(m))
  const link = { kind: 'DEVOLUCION_TRABAJADOR' as const, operationId: op }
  let result!: CapitalReturn
  let reintento = false
  await database.transaction('rw', tablas(database), async () => {
    const previo = await database.withdrawals.get(op)
    if (previo) {
      const custodiaPrevia = await database.cashCustodyMovements.get(centralIds.custodia(op))
      if (previo.tenantId !== tenantId || previo.routeId !== routeId || previo.valor !== amount || previo.userId !== actor.id
        || previo.centralLink?.kind !== 'DEVOLUCION_TRABAJADOR' || custodiaPrevia?.fromUserId !== fromUserId) {
        throw new CentralCapitalError('Ese identificador de operación ya corresponde a otro movimiento.')
      }
      result = { custody: custodiaPrevia, withdrawal: previo }
      reintento = true
      return
    }
    await exigirAutoridad(actor, routeId, tenantId, 'settle', database)
    await exigirPeriodoAbiertoHoy(routeId, database)
    const ahora = nowISO()
    const pos = await personalCashPosition({ tenantId, routeId, userId: fromUserId, hasta: ahora }, database)
    if (amount > pos.esperado) {
      throw new CentralCapitalError(`La devolución supera el efectivo a cargo de ${persona.nombre} (${Math.max(0, pos.esperado)}).`)
    }
    const custody: CashCustodyMovement = {
      id: centralIds.custodia(op), tenantId, routeId, tipo: 'BASE_RETURN', amount, fromUserId,
      origen: 'admin-pool', centralLink: link, motivo, fecha: today(), createdAt: ahora, createdByUserId: actor.id,
    }
    await database.cashCustodyMovements.add(custody)
    const withdrawal = await creditControllerPool(database, {
      tenantId, routeId, amount, actor, link, id: op,
      descripcion: `Devolución de ${persona.nombre} (${route.nombre}): ${motivo}`,
    })
    result = { custody, withdrawal }
  })
  if (reintento) return result
  await auditar({
    tenantId, userId: actor.id, userRole: actor.rol, routeId, action: 'CENTRAL_CAPITAL_RETURNED',
    entityType: 'withdrawal', entityId: op,
    descripcion: `Devolución ${amount} de ${persona.nombre} a la bolsa del responsable de ${route.nombre}.`,
    after: { amount, fromUserId, adminId: result.withdrawal.adminId }, motivo,
  })
  return result
}

// ============================================================
// ANULACIÓN DE UNA ENTREGA
// ============================================================
/**
 * Anula una entrega registrada por error. Solo si el trabajador AÚN tiene ese
 * efectivo en esta ruta (lo que puede traspasar: su posición sin el faltante
 * arrastrado). Si ya lo desembolsó o gastó, se rechaza: el capital consumido no se
 * "devuelve" a la bolsa con un asiento; se recupera con una devolución real o en el
 * cuadre. Autoridad 'correct' (responsable o SuperAdmin). Asiento de hoy (D7).
 */
export async function reverseCapitalDelivery(
  params: { actor: User | null | undefined; tenantId: string; operationId: string; reason: string },
  database: RutaCashDB = db,
): Promise<{ capitalReversal: CapitalMovement; custodyReversal: CashCustodyMovement }> {
  const actor = exigirActor(params.actor)
  const motivo = normalizeReversalReason(params.reason)
  if (!motivo) throw new CentralCapitalError('Indica el motivo de la anulación.')
  const { tenantId, operationId } = params
  const previa = await database.capitalMovements.get(operationId)
  if (!previa || previa.tenantId !== tenantId || previa.centralLink?.kind !== 'ENTREGA_TRABAJADOR') {
    throw new CentralCapitalError('La entrega indicada no existe.')
  }
  assertCan(actor, 'capital.manage', { routeId: previa.routeId, tenantId })
  assertRouteAccess(actor, previa.routeId)
  let result!: { capitalReversal: CapitalMovement; custodyReversal: CashCustodyMovement }
  await database.transaction('rw', tablas(database), async () => {
    const m = await database.capitalMovements.get(operationId)
    const c = await database.cashCustodyMovements.get(centralIds.custodia(operationId))
    if (!m || !c) throw new CentralCapitalError('La entrega indicada no existe.')
    if (m.reversalId || c.reversalId) throw new CentralCapitalError('Esta entrega ya fue anulada.')
    await exigirAutoridad(actor, m.routeId, tenantId, 'correct', database)
    await exigirPeriodoAbiertoHoy(m.routeId, database)
    const ahora = nowISO()
    const pos = await personalCashPosition({ tenantId, routeId: m.routeId, userId: c.toUserId!, hasta: ahora }, database)
    const conserva = transferableCash(pos)
    if (c.amount > conserva) {
      throw new CentralCapitalError(`El capital de esta entrega ya fue utilizado (el trabajador conserva ${conserva} de ${c.amount}). Recupéralo con una devolución o en el cuadre.`)
    }
    const link = { kind: 'ANULACION_ENTREGA' as const, operationId, relatedId: m.id }
    const capitalReversal = await reverseCentralCapitalMovement(database, m, { actor, motivo, link })
    const custodyReversal: CashCustodyMovement = {
      id: generateId(), tenantId, routeId: c.routeId, tipo: 'BASE_RETURN', amount: c.amount, fromUserId: c.toUserId,
      origen: 'admin-pool', centralLink: link, motivo: `Anulación de entrega: ${motivo}`,
      fecha: today(), createdAt: ahora, createdByUserId: actor.id, reversesId: c.id, reversalReason: motivo,
    }
    await database.cashCustodyMovements.add(custodyReversal)
    await database.cashCustodyMovements.put({ ...c, reversalId: custodyReversal.id, reversedAt: ahora, reversedByUserId: actor.id, reversalReason: motivo })
    result = { capitalReversal, custodyReversal }
  })
  await auditar({
    tenantId, userId: actor.id, userRole: actor.rol, routeId: previa.routeId, action: 'CENTRAL_CAPITAL_DELIVERY_REVERSED',
    entityType: 'capitalMovement', entityId: operationId, motivo,
    descripcion: `Entrega de capital ${previa.valor} anulada: ${motivo}`,
    before: { estado: 'vigente' }, after: { estado: 'anulado', reversalId: result.capitalReversal.id },
  })
  return result
}

// ============================================================
// APORTE DE SOCIO A LA BOLSA DEL RESPONSABLE
// ============================================================
export interface PartnerContributionParams {
  actor: User | null | undefined
  tenantId: string
  partnerId: string
  /** Ruta que el aporte va a operar: define el Administrador responsable que lo recibe. */
  routeId: string
  amount: number
  descripcion?: string
  fecha?: string
  operationId?: string
}

/**
 * Socio → bolsa del Administrador responsable de la ruta (decisión del propietario,
 * C1: el aporte NO entra a la caja de la ruta ni a un trabajador). Lo registra ese
 * mismo responsable, con las mismas exigencias que el antiguo Socio → Ruta
 * (`transfer.create`, socio y ruta en su alcance, autoridad 'structural'). Desde la
 * bolsa, el Administrador lo entrega a los trabajadores con `deliverCapitalToWorker`.
 *
 * Caja socios: pata `salida` enlazada. Si Caja socios debe tener saldo es la
 * decisión D1, abierta: no se exige aquí (mismo criterio que Socio → Ruta).
 */
export async function registerPartnerContribution(
  params: PartnerContributionParams,
  database: RutaCashDB = db,
): Promise<{ entry: CapitalLedgerEntry; partnerMovement: PartnerCashMovement }> {
  const actor = exigirActor(params.actor)
  const { tenantId, partnerId, routeId } = params
  assertCan(actor, 'transfer.create', { tenantId })
  assertCan(actor, 'capital.manage', { routeId, tenantId })
  const route = await rutaDeLaEmpresa(routeId, tenantId, database)
  await exigirModeloActivo(tenantId, database)
  await assertRouteOperationalContext(routeId)
  const users = await database.users.where('tenantId').equals(tenantId).toArray()
  const socio = users.find(u => u.id === partnerId && u.rol === 'socio')
  if (!socio) throw new CentralCapitalError('El socio indicado no existe en esta empresa.')
  const enAlcance = isTransferInScope(actor, { origenType: 'partner', socioOrigenId: partnerId, destinoType: 'route', routeDestinoId: routeId },
    id => authorizedRouteIdsOf(users.find(u => u.id === id)))
  if (!enAlcance) throw new AuthzError('No puedes registrar aportes de un socio o hacia una ruta fuera de tu alcance.')
  await exigirAutoridad(actor, routeId, tenantId, 'structural', database)
  const amount = validarMonto(params.amount)
  const fecha = params.fecha || today()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || fecha > today()) throw new CentralCapitalError('La fecha no es válida o es futura.')
  const id = operationIdOf(params.operationId, m => new CentralCapitalError(m))
  let entry!: CapitalLedgerEntry
  let partnerMovement!: PartnerCashMovement
  let reintento = false
  await database.transaction('rw', [...new Set([...(capitalTables(database as unknown as CapitalControlDatabase) as never[]), database.partnerCashMovements, database.tenants])], async () => {
    const previo = await database.capitalLedger.get(id)
    if (previo) {
      if (previo.tenantId !== tenantId || previo.tipo !== 'PARTNER_CONTRIBUTION' || previo.amount !== amount
        || previo.partnerId !== partnerId || previo.toAdminId !== actor.id || previo.routeId !== routeId) {
        throw new CentralCapitalError('Ese identificador de operación ya corresponde a otro movimiento de capital.')
      }
      entry = previo
      partnerMovement = (await database.partnerCashMovements.where('partnerId').equals(partnerId).toArray())
        .find(p => p.relatedLedgerEntryId === id)!
      reintento = true
      return
    }
    // Responsable releído dentro de la transacción.
    const r = await database.routes.get(routeId)
    assertRouteCashAuthority(actor, r, 'structural', await database.users.where('tenantId').equals(tenantId).toArray())
    const ahora = nowISO()
    const desc = params.descripcion?.trim()
    entry = {
      id, tenantId, tipo: 'PARTNER_CONTRIBUTION', amount, toAdminId: actor.id, routeId, partnerId,
      descripcion: desc || `Aporte de ${socio.nombre} para operar ${route.nombre}`,
      fecha, createdAt: ahora, actorUserId: actor.id, actorRole: actor.rol, status: 'aplicado', syncStatus: 'pending',
    }
    partnerMovement = {
      id: generateId(), tenantId, partnerId, type: 'salida', category: 'transferencia', amount,
      description: `Aporte a la bolsa de ${actor.nombre} para ${route.nombre}${desc ? ` · ${desc}` : ''}`,
      relatedLedgerEntryId: id, fecha, createdAt: ahora, createdBy: actor.id,
    }
    await database.capitalLedger.add(entry)
    await database.partnerCashMovements.add(partnerMovement)
  })
  if (reintento) return { entry, partnerMovement }
  await auditar({
    tenantId, userId: actor.id, userRole: actor.rol, routeId, action: 'PARTNER_CONTRIBUTION_REGISTERED',
    entityType: 'capitalLedger', entityId: id,
    descripcion: `Aporte ${amount} de ${socio.nombre} a la bolsa de ${actor.nombre} (ruta ${route.nombre}).`,
    after: { amount, partnerId, toAdminId: actor.id, routeId, fecha },
  })
  return { entry, partnerMovement }
}

/**
 * Anula un aporte de socio registrado por error: asiento negado en el libro y en
 * Caja socios. Solo si la bolsa que lo recibió aún tiene ese disponible (no se
 * anula capital ya entregado a trabajadores). Autoridad 'correct' sobre la ruta.
 */
export async function reversePartnerContribution(
  params: { actor: User | null | undefined; tenantId: string; entryId: string; reason: string },
  database: RutaCashDB = db,
): Promise<{ reversal: CapitalLedgerEntry; partnerReversal?: PartnerCashMovement }> {
  const actor = exigirActor(params.actor)
  const motivo = normalizeReversalReason(params.reason)
  if (!motivo) throw new CentralCapitalError('Indica el motivo de la anulación.')
  const { tenantId, entryId } = params
  assertCan(actor, 'transfer.create', { tenantId })
  const previa = await database.capitalLedger.get(entryId)
  if (!previa || previa.tenantId !== tenantId || previa.tipo !== 'PARTNER_CONTRIBUTION' || !previa.routeId) {
    throw new CentralCapitalError('El aporte indicado no existe.')
  }
  await exigirAutoridad(actor, previa.routeId, tenantId, 'correct', database)
  let result!: { reversal: CapitalLedgerEntry; partnerReversal?: PartnerCashMovement }
  await database.transaction('rw', [...new Set([...(capitalTables(database as unknown as CapitalControlDatabase) as never[]), database.partnerCashMovements, database.tenants])], async () => {
    const e = await database.capitalLedger.get(entryId)
    if (!e) throw new CentralCapitalError('El aporte indicado no existe.')
    if (e.reversalId) throw new CentralCapitalError('Este aporte ya fue anulado.')
    if (e.reversesId) throw new CentralCapitalError('Una reversión no se puede anular.')
    const disponible = adminCapital(e.toAdminId!, await loadCapitalRows(tenantId, database as unknown as CapitalControlDatabase)).disponible
    if (e.amount > disponible) {
      throw new CentralCapitalError(`La bolsa que recibió el aporte ya no tiene ese disponible (disponible: ${disponible}; requerido: ${e.amount}).`)
    }
    const ahora = nowISO()
    const reversal: CapitalLedgerEntry = {
      ...e, id: generateId(), amount: -e.amount, descripcion: `Anulación de aporte: ${motivo}`, fecha: today(), createdAt: ahora,
      actorUserId: actor.id, actorRole: actor.rol, reversesId: e.id, reversalReason: motivo,
      reversalId: undefined, reversedAt: undefined, reversedByUserId: undefined, syncStatus: 'pending',
    }
    await database.capitalLedger.add(reversal)
    await database.capitalLedger.put({ ...e, reversalId: reversal.id, reversedAt: ahora, reversedByUserId: actor.id, reversalReason: motivo })
    const pata = (await database.partnerCashMovements.where('partnerId').equals(e.partnerId!).toArray())
      .find(p => p.relatedLedgerEntryId === e.id && !p.reversalId)
    let partnerReversal: PartnerCashMovement | undefined
    if (pata) {
      partnerReversal = {
        id: generateId(), tenantId, partnerId: pata.partnerId, type: pata.type, category: pata.category, amount: -pata.amount,
        description: `Anulación de aporte: ${motivo}`, relatedLedgerEntryId: reversal.id, fecha: today(), createdAt: ahora,
        createdBy: actor.id, reversesId: pata.id, reversalReason: motivo,
      }
      await database.partnerCashMovements.add(partnerReversal)
      await database.partnerCashMovements.put({ ...pata, reversalId: partnerReversal.id, reversedAt: ahora, reversedByUserId: actor.id, reversalReason: motivo })
    }
    result = { reversal, partnerReversal }
  })
  await auditar({
    tenantId, userId: actor.id, userRole: actor.rol, routeId: previa.routeId, action: 'PARTNER_CONTRIBUTION_REVERSED',
    entityType: 'capitalLedger', entityId: entryId, motivo,
    descripcion: `Aporte de socio ${previa.amount} anulado: ${motivo}`,
    before: { estado: 'vigente' }, after: { estado: 'anulado', reversalId: result.reversal.id },
  })
  return result
}
