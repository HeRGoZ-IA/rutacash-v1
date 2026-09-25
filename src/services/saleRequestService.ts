// ============================================================
// App Cobrador — creación de ventas y solicitudes de venta
// Reutiliza el motor financiero existente (installmentEngine).
// ============================================================
import { db } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { nowISO, today } from '@/lib/formatters'
import { can } from '@/lib/permissions'
import { hasPersonalCashbox } from '@/lib/collectorAttribution'
import { assertCan } from '@/services/authz'
import { logAction } from '@/services/auditService'
import {
  calculateTotalWithInterest, calculateInstallmentValue,
  estimateFinalDate, generateInstallments,
} from '@/services/installmentEngine'
import { hasCapitalForSale } from '@/services/cashboxEngine'
import type {
  Sale, Installment, SaleRequest, PaymentFrequency, DisbursementStatus, User, Client, Route,
} from '@/models/types'
import { assertRouteOperationalContext } from '@/services/officeService'

export interface SaleInputs {
  tenantId: string
  routeId: string
  clientId: string
  createdByUserId: string
  valorVenta: number
  tasaInteres: number
  numeroCuotas: number
  frecuenciaPago: PaymentFrequency
  fechaInicio: string
  paymentDays: number[]
}

/** Calcula los campos financieros derivados de una venta (sin tocar la base). */
export function computeSaleFinancials(input: Pick<SaleInputs, 'valorVenta' | 'tasaInteres' | 'numeroCuotas' | 'frecuenciaPago' | 'fechaInicio' | 'paymentDays'>) {
  const { valorInteres, valorTotal } = calculateTotalWithInterest({ valorVenta: input.valorVenta, tasaInteres: input.tasaInteres })
  const valorCuota = calculateInstallmentValue({ valorTotal, numeroCuotas: input.numeroCuotas })
  const fechaFinalEstimada = estimateFinalDate({ fechaInicio: input.fechaInicio, numeroCuotas: input.numeroCuotas, frecuencia: input.frecuenciaPago, paymentDays: input.paymentDays })
  return { valorInteres, valorTotal, valorCuota, fechaFinalEstimada }
}

/** Construye (en memoria) la venta y sus parcelas. No persiste. */
export function buildSaleWithInstallments(
  input: SaleInputs,
  disbursementStatus: DisbursementStatus,
  saleRequestId?: string,
): { sale: Sale; installments: Installment[] } {
  const saleId = generateId()
  const { valorInteres, valorTotal, valorCuota, fechaFinalEstimada } = computeSaleFinancials(input)
  const installments = generateInstallments({
    saleId, valorTotal, numeroCuotas: input.numeroCuotas, valorCuota,
    frecuencia: input.frecuenciaPago, fechaInicio: input.fechaInicio, paymentDays: input.paymentDays,
  })
  const sale: Sale = {
    id: saleId, tenantId: input.tenantId, routeId: input.routeId,
    clientId: input.clientId, createdByUserId: input.createdByUserId,
    valorVenta: input.valorVenta, tasaInteres: input.tasaInteres, valorInteres, valorTotal,
    saldo: valorTotal, numeroCuotas: input.numeroCuotas, valorCuota,
    frecuenciaPago: input.frecuenciaPago, paymentDays: input.paymentDays,
    fechaInicio: input.fechaInicio, fechaFinalEstimada, status: 'activa',
    disbursementStatus, saleRequestId,
    createdAt: nowISO(), updatedAt: nowISO(),
  }
  return { sale, installments }
}

// ============================================================
// REGLAS DE VENTA — REVALIDADAS EN EL SERVICIO
// ------------------------------------------------------------
// "Sin autorización" NO significa "sin validaciones". Hasta 2026-09-24 estas reglas
// vivían solo en las pantallas (tasa, fecha, días, límite, capital): quien llamara
// al servicio directamente se las saltaba. Ahora las revalida el servicio para TODO
// actor —incluido el Supervisor, que desde esta entrega otorga crédito directo—, de
// modo que la autoridad comercial no sea un atajo de seguridad.
// ============================================================

/** Error de regla de negocio de ventas (mensaje listo para mostrar). */
export class SaleRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SaleRuleError'
  }
}

/** La solicitud ya no está pendiente: otro autorizador la resolvió antes. */
export class SaleRequestResolvedError extends SaleRuleError {
  constructor() {
    super('Esta solicitud ya fue resuelta.')
    this.name = 'SaleRequestResolvedError'
  }
}

/** Tasas de interés admitidas por el negocio (mismas que ofrecen las pantallas). */
export const ALLOWED_INTEREST_RATES = [10, 20] as const
const FRECUENCIAS: PaymentFrequency[] = ['diaria', 'semanal', 'quincenal', 'mensual', 'personalizada']

/**
 * Límite efectivo de VENTA DIRECTA: el menor entre el de la ruta
 * (`montoMaximoPrestamo`) y el del usuario (`maxDirectSaleAmount`). 0/vacío = sin
 * límite en ese lado. Por encima del límite la venta solo puede ir como solicitud.
 * Fuente ÚNICA: la usan las pantallas y el servicio.
 */
export function directSaleLimit(
  route: Pick<Route, 'montoMaximoPrestamo'> | null | undefined,
  user: Pick<User, 'maxDirectSaleAmount'> | null | undefined,
): number {
  const deRuta = route && route.montoMaximoPrestamo > 0 ? route.montoMaximoPrestamo : Infinity
  const deUsuario = user?.maxDirectSaleAmount && user.maxDirectSaleAmount > 0 ? user.maxDirectSaleAmount : Infinity
  return Math.min(deRuta, deUsuario)
}

/**
 * Integridad de una venta o solicitud: empresa, ruta activa, Oficina activa,
 * cliente de ESA ruta y reglas de producto. `newClient` permite validar un cliente
 * que se crea en la MISMA operación (alta de cliente + venta).
 */
async function assertSaleIntegrity(
  input: SaleInputs,
  opts: { checkStartDate: boolean; newClient?: Client },
): Promise<{ route: Route; client: Client }> {
  await assertRouteOperationalContext(input.routeId)
  const route = await db.routes.get(input.routeId)
  if (!route || route.tenantId !== input.tenantId) throw new SaleRuleError('La ruta no existe en esta empresa.')
  if (route.status !== 'activa') throw new SaleRuleError('La ruta está inactiva: no admite ventas nuevas.')
  const client = opts.newClient ?? await db.clients.get(input.clientId)
  if (!client || client.id !== input.clientId || client.tenantId !== input.tenantId || client.routeId !== input.routeId) {
    throw new SaleRuleError('El cliente no pertenece a esta ruta.')
  }
  if (client.status !== 'activo') throw new SaleRuleError('El cliente no está activo.')
  if (!Number.isInteger(input.valorVenta) || input.valorVenta <= 0) throw new SaleRuleError('El valor de la venta debe ser mayor a 0.')
  if (!Number.isInteger(input.numeroCuotas) || input.numeroCuotas < 1) throw new SaleRuleError('La cantidad de parcelas debe ser mayor a 0.')
  if (!(ALLOWED_INTEREST_RATES as readonly number[]).includes(input.tasaInteres)) throw new SaleRuleError('La tasa debe ser 10% o 20%.')
  if (!FRECUENCIAS.includes(input.frecuenciaPago)) throw new SaleRuleError('La forma de pago no es válida.')
  const dias = input.paymentDays ?? []
  if (dias.length === 0 || dias.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new SaleRuleError('Selecciona al menos un día de pago válido.')
  }
  if (opts.checkStartDate && input.fechaInicio < today()) {
    throw new SaleRuleError('La fecha de inicio no puede ser anterior a hoy.')
  }
  return { route, client }
}

/**
 * Venta DIRECTA: el crédito se otorga sin solicitud y queda DESEMBOLSADO en el acto
 * (así funcionaba ya para Administrador y Super Admin, y así se conserva).
 *
 * `sale.createDirect` significa exactamente eso —crear una venta sin pasar por una
 * solicitud— y nada más: no concede gestión de usuarios, rutas, capital ni caja. Hoy
 * la tienen Super Admin, Administrador y, desde 2026-09-24, el Supervisor.
 *
 * Con `actor` (toda operación real) se revalidan en el servicio: permiso sobre la
 * ruta, integridad (empresa, ruta activa, Oficina activa, cliente de la ruta,
 * tasa, frecuencia, días, fecha), LÍMITE de venta directa y CAPITAL disponible.
 *
 * DESEMBOLSO: como el dinero sale en el acto, se registra QUIÉN lo entregó con la
 * misma regla que `confirmDisbursement`: si el actor tiene caja personal (Supervisor)
 * el desembolso se carga a SU efectivo; si no (Admin), es entrega administrativa.
 *
 * `actor` es opcional únicamente para semillas/pruebas internas.
 */
export async function createDirectSale(input: SaleInputs, actor?: User, opts: { newClient?: Client } = {}): Promise<Sale> {
  // Oficina inactiva → no se admiten ventas nuevas en sus rutas (la consulta sigue intacta).
  await assertRouteOperationalContext(input.routeId)
  if (actor && !can(actor, 'sale.createDirect', { routeId: input.routeId, tenantId: input.tenantId })) {
    throw new Error('No autorizado: este perfil no puede crear ventas directas. La venta debe enviarse como solicitud.')
  }
  if (actor) {
    const { route } = await assertSaleIntegrity(input, { checkStartDate: true, newClient: opts.newClient })
    const limite = directSaleLimit(route, actor)
    if (input.valorVenta > limite) {
      throw new SaleRuleError(`El valor supera el límite de venta directa (${limite}). Envíala como solicitud.`)
    }
    if (!(await hasCapitalForSale(input.routeId, input.valorVenta))) {
      throw new SaleRuleError('La venta supera el capital disponible de la ruta.')
    }
  }
  const { sale, installments } = buildSaleWithInstallments(input, 'desembolsado')
  await db.transaction('rw', [db.sales, db.installments, db.clients], async () => {
    if (actor) {
      // Instante sellado dentro de la transacción (frontera del cuadre por trabajador).
      await db.sales.get(sale.id)
      const ahora = nowISO()
      sale.disbursedByCollectorId = hasPersonalCashbox(actor.rol) ? actor.id : undefined
      sale.disbursedByUserId = actor.id
      sale.fechaDesembolso = today()
      sale.disbursedAt = ahora
    }
    if (opts.newClient) await db.clients.add(opts.newClient)
    await db.sales.add(sale)
    await db.installments.bulkAdd(installments)
  })
  return sale
}

/** Construye (en memoria) una Solicitud de venta. No persiste. */
export function buildSaleRequest(input: SaleInputs): SaleRequest {
  const { valorTotal, valorCuota } = computeSaleFinancials(input)
  return {
    id: generateId(), tenantId: input.tenantId, clientId: input.clientId,
    routeId: input.routeId, collectorId: input.createdByUserId,
    amount: input.valorVenta, interestRate: input.tasaInteres, totalAmount: valorTotal,
    installmentsCount: input.numeroCuotas, installmentValue: valorCuota,
    frequency: input.frecuenciaPago, startDate: input.fechaInicio, paymentDays: input.paymentDays,
    status: 'pending', requestedAt: nowISO(),
    // Trazabilidad: condiciones SOLICITADAS congeladas (no se sobrescriben al aprobar).
    requestedBy: input.createdByUserId,
    requestedInterestRate: input.tasaInteres,
    requestedFrequency: input.frecuenciaPago,
    requestedPaymentDays: input.paymentDays,
  }
}

/**
 * Crea una Solicitud de venta (estado pending). VALIDA EN SERVICIO que el actor
 * tenga `sale.createRequest` sobre la ruta (fail-closed) y la integridad de la
 * venta solicitada cuando se pasa `actor`.
 */
export async function createSaleRequest(input: SaleInputs, actor?: User, opts: { newClient?: Client } = {}): Promise<SaleRequest> {
  await assertRouteOperationalContext(input.routeId)
  if (actor) {
    assertCan(actor, 'sale.createRequest', { routeId: input.routeId, tenantId: input.tenantId })
    await assertSaleIntegrity(input, { checkStartDate: true, newClient: opts.newClient })
  }
  const request = buildSaleRequest(input)
  await db.transaction('rw', [db.saleRequests, db.clients], async () => {
    if (opts.newClient) await db.clients.add(opts.newClient)
    await db.saleRequests.add(request)
  })
  return request
}

/**
 * Cambios de condiciones permitidos por el autorizador (Secretario, Supervisor,
 * Admin, Super Admin): porcentaje (tasa), frecuencia y días de pago, además de la
 * confirmación telefónica.
 */
export interface ApprovalOverrides {
  notes?: string
  interestRate?: number
  frequency?: PaymentFrequency
  paymentDays?: number[]
  phoneConfirmed?: boolean
  phoneConfirmationNote?: string
}

/** Quién originó la solicitud. */
const requesterOf = (r: SaleRequest) => r.requestedBy ?? r.collectorId

/**
 * Auditoría de una APROBACIÓN, con la misma forma que ya registraba la pantalla del
 * Secretario: aprobación, cambio de condiciones (antes/después) y confirmación
 * telefónica. Fuera de la transacción: un fallo al auditar no revierte la venta.
 */
export async function logApprovalAudit(request: SaleRequest, actor: User, overrides: ApprovalOverrides, montoTexto: string): Promise<void> {
  const antes = { interestRate: request.interestRate, frequency: request.frequency, paymentDays: request.paymentDays }
  const despues = {
    interestRate: overrides.interestRate ?? request.interestRate,
    frequency: overrides.frequency ?? request.frequency,
    paymentDays: overrides.paymentDays ?? request.paymentDays,
  }
  const base = { tenantId: request.tenantId, userId: actor.id, userRole: actor.rol, routeId: request.routeId, entityType: 'SaleRequest', entityId: request.id }
  await logAction({ ...base, action: 'APPROVE_SALE_REQUEST', descripcion: `Solicitud aprobada (${montoTexto})`, before: antes, after: { ...despues, phoneConfirmed: overrides.phoneConfirmed } })
  if (JSON.stringify(antes) !== JSON.stringify(despues)) {
    await logAction({ ...base, action: 'CHANGE_SALE_CONDITIONS', descripcion: 'Modificación de condiciones en autorización', before: antes, after: despues })
  }
  if (overrides.phoneConfirmed && !request.phoneConfirmed) {
    await logAction({ ...base, action: 'PHONE_CONFIRMATION', descripcion: 'Confirmación telefónica con el cliente', motivo: overrides.phoneConfirmationNote || undefined })
  }
}

/**
 * Relee la solicitud y valida que el actor pueda resolverla. La pantalla solo
 * aporta el id: estado, ruta y empresa salen SIEMPRE de la base.
 */
async function loadResolvable(
  requestOrId: SaleRequest | string, actor: User, capability: 'authorization.approve' | 'authorization.reject',
): Promise<SaleRequest> {
  const id = typeof requestOrId === 'string' ? requestOrId : requestOrId.id
  const request = await db.saleRequests.get(id)
  if (!request) throw new SaleRuleError('La solicitud no existe.')
  assertCan(actor, capability, { routeId: request.routeId, tenantId: request.tenantId })
  if (request.status !== 'pending') throw new SaleRequestResolvedError()
  // Nadie resuelve su propia solicitud: quien pide no autoriza.
  if (requesterOf(request) === actor.id) {
    throw new SaleRuleError('No puedes resolver tu propia solicitud: debe hacerlo otro autorizador.')
  }
  return request
}

/**
 * Aprueba una solicitud: crea la venta + parcelas con disbursementStatus 'pendiente'
 * (lista pero NO cobrable hasta confirmar el desembolso) y marca la solicitud como
 * 'approved'. Registra las condiciones FINALES sin sobrescribir las SOLICITADAS
 * (evidencia antes/después). El importe NO se modifica en la autorización.
 *
 * CONCURRENCIA: la solicitud se relee DENTRO de la transacción y solo se resuelve si
 * sigue 'pending'. Si dos autorizadores aprueban a la vez, IndexedDB serializa las
 * transacciones: la primera crea la venta; la segunda recibe
 * `SaleRequestResolvedError` y no escribe nada. Nunca hay dos ventas.
 */
export async function approveSaleRequest(requestOrId: SaleRequest | string, actor: User, overrides?: ApprovalOverrides): Promise<Sale> {
  const request = await loadResolvable(requestOrId, actor, 'authorization.approve')
  await assertRouteOperationalContext(request.routeId)
  const reviewerId = actor.id
  // Condiciones finales = override ?? condición solicitada.
  const finalInterest = overrides?.interestRate ?? request.interestRate
  const finalFrequency = overrides?.frequency ?? request.frequency
  const finalPaymentDays = overrides?.paymentDays ?? request.paymentDays ?? []
  // Modificar condiciones exige su propia capacidad, pero SOLO si algo cambia.
  const cambia = finalInterest !== request.interestRate || finalFrequency !== request.frequency
    || JSON.stringify(finalPaymentDays) !== JSON.stringify(request.paymentDays ?? [])
  if (cambia) assertCan(actor, 'authorization.modifyConditions', { routeId: request.routeId, tenantId: request.tenantId })
  // Registrar una confirmación telefónica NUEVA exige su capacidad.
  if (overrides?.phoneConfirmed && !request.phoneConfirmed) {
    assertCan(actor, 'authorization.phoneConfirm', { routeId: request.routeId, tenantId: request.tenantId })
  }

  const input: SaleInputs = {
    tenantId: request.tenantId, routeId: request.routeId,
    clientId: request.clientId, createdByUserId: request.collectorId,
    valorVenta: request.amount, tasaInteres: finalInterest, numeroCuotas: request.installmentsCount,
    frecuenciaPago: finalFrequency, fechaInicio: request.startDate, paymentDays: finalPaymentDays,
  }
  // La fecha de inicio puede haber quedado atrás mientras esperaba: no se exige.
  await assertSaleIntegrity(input, { checkStartDate: false })
  const { sale, installments } = buildSaleWithInstallments(input, 'pendiente', request.id)
  await db.transaction('rw', [db.sales, db.installments, db.saleRequests], async () => {
    const fresca = await db.saleRequests.get(request.id)
    if (!fresca || fresca.status !== 'pending') throw new SaleRequestResolvedError()
    await db.sales.add(sale)
    await db.installments.bulkAdd(installments)
    await db.saleRequests.update(request.id, {
      status: 'approved', reviewedAt: nowISO(), reviewedBy: reviewerId,
      approvalNotes: overrides?.notes || undefined, saleId: sale.id,
      // Congelar solicitadas si no existían (solicitudes antiguas) y registrar finales.
      requestedBy: requesterOf(fresca),
      requestedInterestRate: fresca.requestedInterestRate ?? fresca.interestRate,
      requestedFrequency: fresca.requestedFrequency ?? fresca.frequency,
      requestedPaymentDays: fresca.requestedPaymentDays ?? fresca.paymentDays,
      approvedInterestRate: finalInterest,
      approvedFrequency: finalFrequency,
      approvedPaymentDays: finalPaymentDays,
      phoneConfirmed: overrides?.phoneConfirmed ?? fresca.phoneConfirmed,
      phoneConfirmationNote: overrides?.phoneConfirmationNote ?? fresca.phoneConfirmationNote,
      // Reflejar en los campos base las condiciones finales aplicadas.
      interestRate: finalInterest, frequency: finalFrequency, paymentDays: finalPaymentDays,
    })
  })
  return sale
}

/**
 * Rechaza una solicitud con motivo. No crea venta. Valida capacidad en servicio y,
 * como la aprobación, solo resuelve una solicitud que siga 'pending' (releída dentro
 * de la transacción): una solicitud ya resuelta no cambia de estado.
 */
export async function rejectSaleRequest(requestOrId: SaleRequest | string, actor: User, reason: string): Promise<void> {
  const request = await loadResolvable(requestOrId, actor, 'authorization.reject')
  const motivo = (reason ?? '').trim()
  if (!motivo) throw new SaleRuleError('Indica el motivo del rechazo.')
  await db.transaction('rw', [db.saleRequests], async () => {
    const fresca = await db.saleRequests.get(request.id)
    if (!fresca || fresca.status !== 'pending') throw new SaleRequestResolvedError()
    await db.saleRequests.update(request.id, {
      status: 'rejected', reviewedAt: nowISO(), reviewedBy: actor.id, rejectionReason: motivo,
      requestedBy: requesterOf(fresca),
    })
  })
}

/**
 * Cuenta las ventas pendientes por desembolsar en una ruta (App Cobrador).
 * Fuente única de verdad para el badge del dashboard y del menú inferior.
 */
export async function countPendingDisbursements(routeId: string): Promise<number> {
  if (!routeId) return 0
  const sales = await db.sales.where('routeId').equals(routeId).toArray()
  return sales.filter(s => s.status === 'activa' && s.disbursementStatus === 'pendiente').length
}

/**
 * Devuelve la venta activa de un cliente, si existe (revisión socio 25-jun).
 * "Activa" = estado 'activa', ya sea desembolsada o pendiente de desembolso.
 * Se usa para advertir al crear una segunda venta al mismo cliente.
 */
export async function findActiveSaleForClient(clientId: string): Promise<Sale | null> {
  if (!clientId) return null
  const sales = await db.sales.where('clientId').equals(clientId).toArray()
  return sales.find(s => s.status === 'activa') ?? null
}

/**
 * Solicitudes de venta pendientes de TODA la empresa, sin recorte por rutas.
 *
 * @deprecated Para un BADGE usa `countPendingSaleRequestsForUser`: este contador
 * ignora `authorizedRouteIds`, así que a un usuario limitado a algunas rutas le
 * mostraba un número mayor que la lista que puede abrir. Se conserva para usos
 * donde el total de la empresa SÍ es lo que se quiere medir.
 */
export async function countPendingSaleRequests(tenantId: string): Promise<number> {
  if (!tenantId) return 0
  const reqs = await db.saleRequests.where('tenantId').equals(tenantId).toArray()
  return reqs.filter(r => r.status === 'pending').length
}

/**
 * Solicitudes de venta pendientes que ESTE usuario puede realmente gestionar.
 *
 * REGLA: el badge tiene que coincidir EXACTAMENTE con la lista que el usuario abre
 * al pulsarlo. Por eso aplica el mismo criterio de acceso que las pantallas de
 * autorizaciones (`can(user, 'authorization.access', { routeId })`), no un filtro
 * paralelo que pueda divergir. Fail-closed: sin usuario o sin empresa, cero.
 *
 * Sirve para el Administrador y para el Secretario: la diferencia entre ambos ya
 * está en la capacidad y en sus rutas autorizadas, no en el contador.
 */
export async function countPendingSaleRequestsForUser(
  user: User | null | undefined,
  tenantId: string,
): Promise<number> {
  if (!user || !tenantId) return 0
  const reqs = await db.saleRequests.where('tenantId').equals(tenantId).toArray()
  return reqs.filter(r =>
    r.status === 'pending' && can(user, 'authorization.access', { routeId: r.routeId, tenantId }),
  ).length
}

/**
 * Solicitudes PENDIENTES de UNA ruta que este usuario puede gestionar.
 *
 * Es la lista de la capa operativa (Supervisor en recorrido): el Supervisor está
 * físicamente en una ruta concreta, así que ve y resuelve las pendientes de su RUTA
 * ACTIVA — no las de todas sus rutas ni las de la Oficina. Acceso por RUTA:
 * `authorization.access` sobre `routeId` (fail-closed). La Oficina no concede nada.
 */
export async function listPendingSaleRequestsForRoute(
  user: User | null | undefined,
  tenantId: string,
  routeId: string | null | undefined,
): Promise<SaleRequest[]> {
  if (!user || !tenantId || !routeId) return []
  if (!can(user, 'authorization.access', { routeId, tenantId })) return []
  const reqs = await db.saleRequests.where('routeId').equals(routeId).toArray()
  // Solo las que PUEDE resolver: nadie resuelve su propia solicitud, así que las
  // suyas no se listan ni cuentan en su globo (badge = lista = resolubles).
  return reqs
    .filter(r => r.status === 'pending' && r.tenantId === tenantId && requesterOf(r) !== user.id)
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
}

/**
 * Globo operativo de autorizaciones: EXACTAMENTE la longitud de
 * `listPendingSaleRequestsForRoute` (badge = lista, por construcción).
 */
export async function countPendingSaleRequestsForRoute(
  user: User | null | undefined,
  tenantId: string,
  routeId: string | null | undefined,
): Promise<number> {
  return (await listPendingSaleRequestsForRoute(user, tenantId, routeId)).length
}

/**
 * Confirma el desembolso de una venta aprobada: la venta queda desembolsada
 * (cobrable) y la solicitud asociada pasa a 'disbursed'.
 *
 * ATRIBUCIÓN DEL EFECTIVO: se registra QUIÉN entregó el dinero y CUÁNDO. El
 * desembolso sale de la caja personal de quien lo entrega, así que sin estos datos
 * su cuadre no cierra. Se distingue igual que en los pagos:
 *   · `disbursedByCollectorId` → responsable del efectivo que entregó el dinero.
 *   · `disbursedByUserId`      → usuario que registró la confirmación.
 *
 * SIMETRÍA (Fase 1): el responsable se decide con `hasPersonalCashbox`, el MISMO
 * predicado que usan los cobros y los gastos. Antes esto era `rol === 'cobrador'`,
 * así que un SUPERVISOR entregaba dinero de su bolsillo y no se le descontaba de
 * ninguna caja: recaudaba sin poder desembolsar y su arqueo nunca cerraba.
 * Si quien confirma no tiene caja personal (Admin, Super Admin), el desembolso NO
 * se atribuye a nadie: queda como entrega administrativa de la ruta.
 */
export async function confirmDisbursement(saleId: string, actor?: User): Promise<void> {
  const sale = await db.sales.get(saleId)
  if (!sale) throw new Error('Venta no encontrada')
  if (actor) assertCan(actor, 'sale.confirmDisbursement', { routeId: sale.routeId, tenantId: sale.tenantId })
  // Oficina inactiva → no se entregan desembolsos nuevos en sus rutas.
  await assertRouteOperationalContext(sale.routeId)
  const fechaDesembolso = today()
  await db.transaction('rw', [db.sales, db.saleRequests], async () => {
    // Primera lectura DENTRO de la transacción: con el bloqueo ya obtenido, el
    // instante sellado no puede quedar detrás de la frontera de un cuadre que se
    // está cerrando en otra pestaña (ver `closeCashSettlement`).
    await db.sales.get(saleId)
    const ahora = nowISO()
    await db.sales.update(saleId, {
      disbursementStatus: 'desembolsado',
      disbursedByCollectorId: actor && hasPersonalCashbox(actor.rol) ? actor.id : undefined,
      disbursedByUserId: actor?.id,
      fechaDesembolso,
      // Instante exacto: el cuadre por trabajador corta por instante, no por día.
      disbursedAt: ahora,
      updatedAt: ahora,
    })
    if (sale.saleRequestId) {
      await db.saleRequests.update(sale.saleRequestId, { status: 'disbursed' })
    }
  })
}
