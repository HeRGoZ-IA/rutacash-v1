// ============================================================
// RUTACASH — SERVICIO CENTRAL DE PAGOS (FUENTE ÚNICA DE VERDAD)
// ------------------------------------------------------------
// TODA interfaz que registre un pago (Administrador, Cobrador, Supervisor) pasa por
// `registerPayment`. Las pantallas NO calculan saldos, NO aplican parcelas, NO
// deciden el estado de la venta y NO escriben en Dexie: solo recogen el importe,
// llaman aquí y muestran el resultado.
//
// Garantías del servicio (verificadas en tests/payments.test.ts):
//  1. LECTURA FRESCA: la venta y sus parcelas se releen DENTRO de la transacción.
//     Nada que envíe la UI se usa como fuente de verdad financiera. Esto elimina el
//     "congelamiento de abonos" por estado obsoleto de React (RC-BUG-005).
//  2. AUTORIZACIÓN EN EL DOMINIO: `payment.register` sobre la ruta y la empresa de
//     la venta releídas de la base, no de la pantalla (PARITY-009).
//  3. VALIDACIONES DE NEGOCIO idénticas para todas las interfaces: venta existente,
//     activa, desembolsada y con saldo (RC-BUG-003, RC-BUG-004).
//  4. TOPE AL SALDO: `payments.valor` guarda SIEMPRE el valor efectivo aplicado,
//     nunca el solicitado. La deuda nunca queda negativa ni se genera crédito a
//     favor, y caja no se infla (RC-BUG-001).
//  5. ATOMICIDAD: pago + parcelas + venta se escriben en UNA sola transacción
//     Dexie. Si algo falla, rollback total (RC-BUG-002).
//
// El motor de distribución (`applyPaymentToInstallments`) se reutiliza tal cual: la
// auditoría y la línea base demostraron que su reparto es correcto.
//
// CAPITAL CENTRALIZADO (C1): un cobro que no entra a la caja personal de nadie
// (transferencia, o efectivo recibido por un Administrador) caía en la caja de la
// ruta. Con el modelo activo va a la bolsa del Administrador responsable con un
// retiro enlazado (`COBRO_NO_PERSONAL`) en la MISMA transacción. No se registra como
// efectivo en manos de ningún trabajador. Sin responsable válido, ese cobro se
// rechaza (fail closed); el efectivo de un Cobrador o Supervisor no cambia.
// ============================================================
import { db } from '@/lib/db'
import type { GeoCapture, GeoRecordStatus } from '@/lib/geolocation'
import { generateId } from '@/lib/utils'
import { nowISO, today } from '@/lib/formatters'
import { can } from '@/lib/permissions'
import { getAssignedRouteIds } from '@/lib/roles'
import {
  resolveResponsibleCollector, hasPersonalCashbox, COLLECTOR_ATTRIBUTION_MESSAGE,
  type CollectorAttributionSource,
} from '@/lib/collectorAttribution'
import { logAction } from '@/services/auditService'
import { closedPeriodBlockedReason, type PeriodGuardDatabase } from '@/services/periodGuard'
import {
  applyPaymentToInstallments, calculateSaleBalance,
  calculateCurrentInstallment, getLastPaidInstallmentNumber,
} from '@/services/installmentEngine'
import { isRouteOperationBlocked, OFFICE_MESSAGES } from '@/services/officeService'
import { centralIds, isCentralCapitalActive, isPersonalCashPayment } from '@/lib/centralCapital'
import { NO_CAPITAL_CONTROLLER_MESSAGE, routeCapitalController } from '@/lib/permissions'
import type {
  Installment, Office, Payment, PaymentType, Route, Sale, SaleStatus, SyncStatus, Tenant, User, Withdrawal,
} from '@/models/types'

// ------------------------------------------------------------
// Contrato de base de datos
// ------------------------------------------------------------
/**
 * Superficie mínima de Dexie que necesita el servicio. Se declara de forma
 * estructural para poder inyectar una base en memoria desde las pruebas sin
 * arrastrar IndexedDB a Node. En producción SIEMPRE se usa el `db` real.
 */
export interface PaymentDatabase {
  payments: { add(item: Payment): Promise<unknown> }
  installments: {
    where(index: string): { equals(key: string): { toArray(): Promise<Installment[]> } }
    update(key: string, changes: Partial<Installment>): Promise<number>
  }
  sales: {
    get(key: string): Promise<Sale | undefined>
    update(key: string, changes: Partial<Sale>): Promise<number>
  }
  /**
   * Solo LECTURA: necesaria para resolver el COBRADOR RESPONSABLE del recaudo.
   * Se lee dentro de la transacción, así que la tabla DEBE declararse en su
   * alcance (ver `registerPayment`).
   */
  users: {
    where(index: string): { equals(key: string): { toArray(): Promise<User[]> } }
  }
  /** Solo LECTURA: ruta y Oficina de la venta, para la guarda de Oficina inactiva. */
  routes: { get(key: string): Promise<Route | undefined> }
  offices: { get(key: string): Promise<Office | undefined> }
  /**
   * Solo LECTURA: cierres semanales de la ruta, para no escribir pagos en una
   * semana cerrada (D7). La base real siempre la tiene; las bases de prueba
   * inyectadas que no la declaran no tienen periodos cerrados.
   */
  weeklySettlements?: PeriodGuardDatabase['weeklySettlements']
  /**
   * Capital centralizado (C1): empresa (¿modelo activo?) y retiros (cobro no
   * personal → bolsa del responsable). La base real siempre las tiene; las bases
   * inyectadas que no las declaran operan como v16.
   */
  tenants?: { get(key: string): Promise<Tenant | undefined> }
  withdrawals?: { add(item: Withdrawal): Promise<unknown> }
  transaction<U>(mode: 'rw', tables: any, scope: () => PromiseLike<U>): Promise<U>
}

// ------------------------------------------------------------
// Contrato de entrada / salida
// ------------------------------------------------------------
export type PaymentRejectionCode =
  | 'INVALID_AMOUNT'      // importe nulo, negativo o no numérico
  | 'SALE_NOT_FOUND'      // la venta no existe en la base
  | 'NOT_AUTHORIZED'      // el actor no puede registrar pagos en esa ruta/empresa
  | 'SALE_NOT_ACTIVE'     // venta finalizada, perdida o refinanciada
  | 'SALE_NOT_DISBURSED'  // venta aprobada pero aún no desembolsada
  | 'NO_INSTALLMENTS'     // venta sin parcelas: dato inconsistente, nunca se cobra
  | 'NO_BALANCE'          // la venta ya no tiene saldo pendiente
  | 'COLLECTOR_REQUIRED'  // hay más de un destino posible: hay que indicar quién recibió el dinero
  | 'COLLECTOR_INVALID'   // el responsable indicado no puede responder por el efectivo de esa ruta
  | 'OFFICE_INACTIVE'     // la Oficina de la ruta está inactiva: no admite operaciones nuevas
  | 'PERIOD_CLOSED'       // la fecha del pago cae en una semana cerrada de la ruta (D7)
  | 'CAPITAL_CONTROLLER_REQUIRED' // C1: cobro no personal en una ruta sin responsable de capital
  | 'WRITE_FAILED'        // fallo de persistencia: se revirtió todo

export interface RegisterPaymentInput {
  /** Venta sobre la que se abona. Es el ÚNICO identificador que acepta el servicio. */
  saleId: string
  /** Importe que pidió el usuario. Puede exceder el saldo: el servicio lo topa. */
  requestedAmount: number
  /** Usuario en sesión. Se valida su capacidad contra la ruta real de la venta. */
  actor: User | null | undefined
  /**
   * RESPONSABLE DEL EFECTIVO (quien recibió el dinero). Solo lo envía un actor
   * ADMINISTRATIVO cuando la ruta tiene varios responsables posibles. Si el actor es
   * Cobrador o Supervisor, el responsable es SIEMPRE él mismo: enviar otro id se
   * rechaza. Si se omite, lo resuelve `resolveResponsibleCollector`.
   */
  collectorId?: string
  tipo?: PaymentType
  observacion?: string
  /** Fecha contable del pago (yyyy-MM-dd). Por defecto, hoy. */
  fecha?: string
  lat?: number
  lng?: number
  /** 'pending' cuando el dispositivo está sin conexión (App Cobrador). */
  syncStatus?: SyncStatus
  /**
   * Ronda 48: lectura de ubicación del dispositivo con su ESTADO (también cuando no
   * hay posición). ADEX Online la envía al servidor; este servicio local solo usa
   * `lat`/`lng`, como siempre.
   */
  location?: GeoCapture
}

export interface RegisterPaymentSuccess {
  ok: true
  paymentId: string
  /** Responsable del efectivo al que quedó atribuido el dinero (puede no ser el actor). */
  collectorId: string
  /** Cómo se determinó ese cobrador (ver `CollectorAttributionSource`). */
  collectorSource: CollectorAttributionSource
  /** Lo que pidió el usuario. */
  requestedAmount: number
  /** Lo que realmente se registró y aplicó (= requestedAmount si no hubo tope). */
  appliedAmount: number
  /** true si `requestedAmount` superaba el saldo y se limitó. */
  capped: boolean
  /** Importe rechazado por el tope (0 si no hubo tope). */
  cappedAmount: number
  /** Saldo real (calculado desde parcelas) antes de aplicar. */
  previousBalance: number
  /** Saldo tras aplicar. Nunca negativo. */
  newBalance: number
  saleStatus: SaleStatus
  /** Parcela que se estaba pagando al iniciar la operación. */
  paidInstallmentNumber: number | null
  /** Parcela pendiente tras el pago (null si la venta quedó saldada). */
  currentInstallmentNumber: number | null
  /** Nº de la última parcela completamente pagada tras el abono. */
  lastPaidInstallmentNumber: number
  /** Parcelas que este pago terminó de cerrar. */
  installmentsCompleted: number[]
  /**
   * false si el pago se consolidó pero NO pudo escribirse su registro de auditoría.
   * El dinero está correctamente aplicado: la UI NO debe presentarlo como un error
   * ni invitar a reintentar. Sirve para diagnosticar la pérdida de trazabilidad.
   */
  audited: boolean
  /** Descripción del fallo de auditoría, cuando `audited` es false. */
  auditError?: string
  /** Ronda 48: estado de ubicación que confirmó el servidor (solo ADEX Online). */
  locationStatus?: GeoRecordStatus
  /**
   * Ronda 48.1 (solo ADEX Online): el servidor confirmó este abono al COMPROBAR un envío
   * cuya respuesta se había perdido. Es el mismo abono, no uno nuevo.
   */
  recovered?: boolean
}

export interface RegisterPaymentFailure {
  ok: false
  code: PaymentRejectionCode | UnconfirmedPaymentCode
  /** Mensaje listo para mostrar al usuario. */
  message: string
  /** Ronda 48.1: abono enviado cuya confirmación no llegó (solo con `PAYMENT_UNCONFIRMED`). */
  unconfirmed?: UnconfirmedPayment
}

export type RegisterPaymentResult = RegisterPaymentSuccess | RegisterPaymentFailure

// ------------------------------------------------------------
// Abono sin confirmar (Ronda 48.1)
// ------------------------------------------------------------
// En ADEX Online el abono viaja por red: si la respuesta se pierde, el resultado es
// DESCONOCIDO hasta comprobarlo con el servidor (mismo id de operación; nunca otro abono).
// En CLEAN el registro es una transacción local atómica: nunca queda incierto, así que
// aquí no hay nada pendiente. ADEX Online sustituye estas dos funciones en su puente.

export type UnconfirmedPaymentCode =
  | 'PAYMENT_UNCONFIRMED'              // enviado sin confirmación: comprobar antes de cobrar otra vez
  | 'PREVIOUS_PAYMENT_CONFIRMED'       // se pidió otro abono, pero el anterior sí quedó registrado
  | 'PREVIOUS_PAYMENT_NOT_REGISTERED'  // se pidió otro abono; el anterior no quedó registrado
  | 'TOO_MANY_UNCONFIRMED'             // demasiados abonos sin confirmar en el dispositivo: no se envió

export interface UnconfirmedPayment {
  saleId: string
  /** Importe enviado. */
  requestedAmount: number
  /** Momento del envío (ISO). */
  startedAt: string
}

export type UnconfirmedPaymentCheck =
  | { status: 'none' }
  | { status: 'confirmed'; result: RegisterPaymentSuccess }
  | { status: 'not_registered'; message: string }
  | { status: 'unconfirmed'; payment: UnconfirmedPayment; message: string }

/** Abono de esta venta enviado sin confirmación (CLEAN: nunca). */
export function getUnconfirmedPayment(_saleId: string): UnconfirmedPayment | null {
  return null
}

/** Comprueba con el servidor el abono sin confirmar de esta venta (CLEAN: no hay ninguno). */
export async function checkUnconfirmedPayment(_saleId: string): Promise<UnconfirmedPaymentCheck> {
  return { status: 'none' }
}

/**
 * Destino del registro de auditoría. Por defecto `auditService.logAction` (mecanismo
 * único de la aplicación). Se parametriza solo para poder probar el comportamiento
 * ante un fallo de auditoría sin tocar la base real.
 */
export type AuditSink = (params: Parameters<typeof logAction>[0]) => Promise<void>

/** Rechazo controlado: aborta la transacción sin dejar escrituras. */
class PaymentRejection extends Error {
  constructor(public code: PaymentRejectionCode, message: string) {
    super(message)
    this.name = 'PaymentRejection'
  }
}

const REJECTION_MESSAGES: Record<PaymentRejectionCode, string> = {
  INVALID_AMOUNT: 'Ingresa un valor válido.',
  SALE_NOT_FOUND: 'La venta no existe o fue eliminada.',
  NOT_AUTHORIZED: 'No tienes permiso para registrar pagos en esta ruta.',
  SALE_NOT_ACTIVE: 'Esta venta no está activa: no admite nuevos pagos.',
  SALE_NOT_DISBURSED: 'Esta venta aún no está desembolsada.',
  NO_INSTALLMENTS: 'La venta no tiene parcelas generadas. Revísala antes de cobrar.',
  NO_BALANCE: 'Esta venta ya no tiene saldo pendiente.',
  COLLECTOR_REQUIRED: COLLECTOR_ATTRIBUTION_MESSAGE.ambiguous,
  COLLECTOR_INVALID: COLLECTOR_ATTRIBUTION_MESSAGE.invalid,
  OFFICE_INACTIVE: OFFICE_MESSAGES.inactiveOffice,
  PERIOD_CLOSED: 'La semana de esta fecha está cerrada en la ruta: no admite pagos nuevos.',
  CAPITAL_CONTROLLER_REQUIRED: NO_CAPITAL_CONTROLLER_MESSAGE,
  WRITE_FAILED: 'Error al registrar el pago. No se guardó ningún cambio.',
}

// ------------------------------------------------------------
// Registro de pago
// ------------------------------------------------------------
/**
 * Registra un abono sobre una venta. Punto ÚNICO de entrada para Administrador,
 * Cobrador y Supervisor: mismo estado inicial + mismo importe = mismo resultado
 * financiero, sea cual sea la interfaz de origen.
 *
 * Nunca lanza por reglas de negocio: devuelve un resultado discriminado por `ok`.
 */
export async function registerPayment(
  input: RegisterPaymentInput,
  database: PaymentDatabase = db,
  auditSink: AuditSink = logAction,
): Promise<RegisterPaymentResult> {
  // Validación barata previa a abrir la transacción.
  const requestedAmount = Math.round(Number(input.requestedAmount))
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    return fail('INVALID_AMOUNT')
  }
  if (!input.actor) return fail('NOT_AUTHORIZED')
  if (!input.saleId) return fail('SALE_NOT_FOUND')

  // Contexto necesario para auditar DESPUÉS del commit (se rellena dentro).
  let auditCtx: { tenantId: string; routeId: string; saleId: string } | null = null
  let consolidated: RegisterPaymentSuccess

  try {
    // ALCANCE DE LA TRANSACCIÓN — `users` va INCLUIDO a propósito: el paso 4.b lee
    // los cobradores de la ruta DENTRO del ámbito atómico. Dexie solo permite usar
    // las tablas DECLARADAS aquí; una tabla ausente lanza
    // `NotFoundError: Table users not part of transaction`, que no es un rechazo de
    // negocio y abortaba TODO el pago (incidente 15/09/2026, App Cobrador).
    // `users` solo se lee; ninguna escritura la toca.
    // `weeklySettlements` (D7) solo existe en la base real; las bases inyectadas de
    // prueba sin cierres no la declaran.
    consolidated = await database.transaction('rw', [database.payments, database.installments, database.sales, database.users, database.routes, database.offices, ...(database.weeklySettlements ? [database.weeklySettlements] : []),
      ...(database.tenants && database.withdrawals ? [database.tenants, database.withdrawals] : [])], async () => {
      // ---- 1. LECTURA FRESCA DENTRO DE LA TRANSACCIÓN -----------------------
      // Nada de lo que envía la UI se usa como fuente de verdad. El intervalo
      // lectura → cálculo → escritura queda dentro del mismo ámbito atómico.
      const sale = await database.sales.get(input.saleId)
      if (!sale) throw new PaymentRejection('SALE_NOT_FOUND', REJECTION_MESSAGES.SALE_NOT_FOUND)

      // ---- 2. AUTORIZACIÓN CONTRA LA RUTA REAL DE LA VENTA ------------------
      if (!can(input.actor, 'payment.register', { routeId: sale.routeId, tenantId: sale.tenantId })) {
        throw new PaymentRejection('NOT_AUTHORIZED', REJECTION_MESSAGES.NOT_AUTHORIZED)
      }

      // ---- 2.b OFICINA ACTIVA -----------------------------------------------
      // Una Oficina inactiva bloquea las operaciones NUEVAS de sus rutas, pero no
      // afecta a ninguna consulta. Una ruta SIN Oficina nunca se bloquea aquí.
      const routeOfSale = await database.routes.get(sale.routeId)
      if (routeOfSale?.officeId) {
        const office = await database.offices.get(routeOfSale.officeId)
        if (isRouteOperationBlocked(office)) {
          throw new PaymentRejection('OFFICE_INACTIVE', REJECTION_MESSAGES.OFFICE_INACTIVE)
        }
      }

      // ---- 3. REGLAS DE NEGOCIO (idénticas para todas las interfaces) -------
      // Solo una venta ACTIVA admite pagos. Una venta 'perdida' o 'finalizada'
      // se rechaza aquí, de modo que ningún abono puede revivirla.
      if (sale.status !== 'activa') {
        throw new PaymentRejection('SALE_NOT_ACTIVE', REJECTION_MESSAGES.SALE_NOT_ACTIVE)
      }
      // Una venta aprobada pero no desembolsada no es dinero prestado todavía.
      if (sale.disbursementStatus === 'pendiente') {
        throw new PaymentRejection('SALE_NOT_DISBURSED', REJECTION_MESSAGES.SALE_NOT_DISBURSED)
      }
      // D7 (Ronda 6/6C): un pago nuevo no entra en una semana ya cerrada de la ruta.
      // Corregir pagos de una semana cerrada tiene su vía (solicitud de ajuste).
      if (database.weeklySettlements) {
        const cerrado = await closedPeriodBlockedReason(sale.routeId, input.fecha ?? today(), database as PeriodGuardDatabase)
        if (cerrado) throw new PaymentRejection('PERIOD_CLOSED', cerrado)
      }

      const installments = await database.installments.where('saleId').equals(sale.id).toArray()
      if (installments.length === 0) {
        // Sin parcelas el saldo calculado sería 0 y la venta se cerraría sola:
        // se rechaza en vez de destruir la deuda.
        throw new PaymentRejection('NO_INSTALLMENTS', REJECTION_MESSAGES.NO_INSTALLMENTS)
      }

      // ---- 4. SALDO AUTORITATIVO --------------------------------------------
      // Las parcelas son el libro mayor; `sale.saldo` es una copia denormalizada.
      // Se usa el cálculo desde parcelas y, al escribir, se reescribe `sale.saldo`
      // con ese valor (corrige derivas previas sin tocar el histórico de pagos).
      const previousBalance = calculateSaleBalance(installments)
      if (previousBalance <= 0) {
        throw new PaymentRejection('NO_BALANCE', REJECTION_MESSAGES.NO_BALANCE)
      }

      // ---- 4.b RESPONSABLE DEL EFECTIVO --------------------------------------
      // Quien REGISTRA no es necesariamente quien recibió el dinero. Se resuelve
      // contra los usuarios REALES de la ruta de la venta (releídos de la base, no
      // enviados por la pantalla). Cuando hay más de un destino plausible NO se
      // adivina: se exige indicar quién recibió el efectivo, para que no se cargue
      // a la caja equivocada.
      //
      // Regla definitiva (2026-09-24): si el ACTOR tiene caja personal (Cobrador o
      // Supervisor) responde él por su registro, sin selector y sin mirar cuántos
      // cobradores tenga la ruta. Los candidatos solo sirven para los actores
      // administrativos: "usuarios CON CAJA PERSONAL asignados a la ruta".
      const usuariosEmpresa = await database.users.where('tenantId').equals(sale.tenantId).toArray()
      const routeCollectors = usuariosEmpresa
        .filter(u => hasPersonalCashbox(u.rol) && getAssignedRouteIds(u).includes(sale.routeId))
      const atribucion = resolveResponsibleCollector({
        actor: input.actor!,
        requested: input.collectorId,
        routeCollectors,
      })
      if (!atribucion.ok) {
        // 'ambiguous' = falta decidir (solo actores administrativos). 'invalid' y
        // 'actor-owns-cash' = el responsable indicado no es aceptable; comparten
        // código, pero el MENSAJE distingue el caso.
        throw new PaymentRejection(
          atribucion.code === 'ambiguous' ? 'COLLECTOR_REQUIRED' : 'COLLECTOR_INVALID',
          atribucion.message,
        )
      }

      // ---- 5. TOPE AL SALDO --------------------------------------------------
      const appliedAmount = Math.min(requestedAmount, previousBalance)
      const capped = appliedAmount < requestedAmount

      // ---- 6. CÁLCULO (motor existente, sin cambios) -------------------------
      const paidInstallmentNumber = calculateCurrentInstallment(installments)?.numero ?? null
      const previousPaidNumber = getLastPaidInstallmentNumber(installments)
      const { updatedInstallments } = applyPaymentToInstallments(installments, appliedAmount)
      const newBalance = calculateSaleBalance(updatedInstallments)
      const saleStatus: SaleStatus = newBalance <= 0 ? 'finalizada' : 'activa'
      const lastPaidInstallmentNumber = getLastPaidInstallmentNumber(updatedInstallments)
      const installmentsCompleted = updatedInstallments
        .filter(i => i.saldo <= 0 && i.numero > previousPaidNumber && i.numero <= lastPaidInstallmentNumber)
        .map(i => i.numero)

      // ---- 7. ESCRITURA ATÓMICA ---------------------------------------------
      const payment: Payment = {
        id: generateId(),
        tenantId: sale.tenantId,
        saleId: sale.id,
        clientId: sale.clientId,
        routeId: sale.routeId,
        // RESPONSABILIDAD ≠ REGISTRO: el dinero se atribuye a quien lo recibió;
        // quién lo digitó queda por separado para trazabilidad.
        collectorId: atribucion.collectorId,
        createdByUserId: input.actor!.id,
        // INVARIANTE: se guarda el valor EFECTIVO, jamás el solicitado.
        valor: appliedAmount,
        fecha: input.fecha ?? today(),
        tipo: input.tipo ?? 'efectivo',
        observacion: input.observacion,
        lat: input.lat,
        lng: input.lng,
        syncStatus: input.syncStatus ?? 'synced',
        createdAt: nowISO(),
        state: 'active',
      }
      await database.payments.add(payment)
      // C1: el cobro que no entra a ninguna caja personal va a la bolsa del responsable.
      if (database.tenants && database.withdrawals && isCentralCapitalActive(await database.tenants.get(sale.tenantId))) {
        const rolResponsable = atribucion.collectorId === input.actor!.id
          ? input.actor!.rol
          : usuariosEmpresa.find(u => u.id === atribucion.collectorId)?.rol
        if (!isPersonalCashPayment(payment, rolResponsable)) {
          const controller = routeCapitalController(routeOfSale, usuariosEmpresa)
          if (!controller) throw new PaymentRejection('CAPITAL_CONTROLLER_REQUIRED', REJECTION_MESSAGES.CAPITAL_CONTROLLER_REQUIRED)
          await database.withdrawals.add({
            id: centralIds.cobro(payment.id), tenantId: sale.tenantId, routeId: sale.routeId, valor: appliedAmount,
            descripcion: `Cobro ${payment.tipo} (no entra a caja personal) a la bolsa del responsable`,
            fecha: payment.fecha, userId: input.actor!.id, createdAt: payment.createdAt, adminId: controller.id,
            centralLink: { kind: 'COBRO_NO_PERSONAL', operationId: payment.id, relatedId: payment.id },
          })
        }
      }
      for (const inst of updatedInstallments) {
        await database.installments.update(inst.id, {
          pagado: inst.pagado, saldo: inst.saldo, status: inst.status, diasMora: inst.diasMora,
        })
      }

      // FECHA REAL DE FINALIZACIÓN: cuando este abono salda la venta, se SELLA con la
      // fecha CONTABLE del propio pago (no `updatedAt`, que cambia con cualquier
      // actualización posterior y no serviría como dato histórico). Si la venta ya
      // traía una fecha sellada, se respeta.
      const saleChanges: Partial<Sale> = { saldo: newBalance, status: saleStatus, updatedAt: nowISO() }
      if (saleStatus === 'finalizada' && !sale.fechaFinalizacion) {
        saleChanges.fechaFinalizacion = payment.fecha
      }
      await database.sales.update(sale.id, saleChanges)

      auditCtx = { tenantId: sale.tenantId, routeId: sale.routeId, saleId: sale.id }

      const result: RegisterPaymentSuccess = {
        ok: true,
        paymentId: payment.id,
        collectorId: atribucion.collectorId,
        collectorSource: atribucion.source,
        requestedAmount,
        appliedAmount,
        capped,
        cappedAmount: requestedAmount - appliedAmount,
        previousBalance,
        newBalance,
        saleStatus,
        paidInstallmentNumber,
        currentInstallmentNumber: calculateCurrentInstallment(updatedInstallments)?.numero ?? null,
        lastPaidInstallmentNumber,
        installmentsCompleted,
        audited: true,
      }
      return result
    })
  } catch (err) {
    // Rechazo de negocio: la transacción se abortó sin escribir nada. El mensaje ya
    // es específico y accionable ("no tienes permiso...", "la venta no está
    // activa...", "indica quién cobró...").
    if (err instanceof PaymentRejection) return { ok: false, code: err.code, message: err.message }
    // Fallo de persistencia: Dexie ya revirtió la transacción completa. Al usuario
    // se le da un mensaje amable, pero la CAUSA REAL se registra en consola: sin
    // esto, un error de esquema/alcance de Dexie quedaba indistinguible de
    // cualquier otro y no había forma de diagnosticarlo desde producción.
    console.error(
      '[RutaCash] registerPayment falló y se revirtió por completo.',
      { saleId: input.saleId, actorId: input.actor?.id, requestedAmount, error: err },
    )
    return fail('WRITE_FAILED')
  }

  // ---- 8. AUDITORÍA — FUERA DE LA TRANSACCIÓN FINANCIERA -------------------
  // Mismo criterio que routeService y paymentCorrectionService: `auditLogs` no
  // pertenece al ámbito de la transacción y un fallo al auditar NUNCA debe revertir
  // un pago ya consolidado ni provocar un segundo registro. El pago es correcto:
  // se marca `audited: false` para poder diagnosticar la pérdida de trazabilidad,
  // pero el resultado sigue siendo `ok: true` y la UI no debe invitar a reintentar.
  if (auditCtx) {
    const ctx = auditCtx as { tenantId: string; routeId: string; saleId: string }
    try {
      await auditSink({
        tenantId: ctx.tenantId,
        userId: input.actor.id,
        userRole: input.actor.rol,
        routeId: ctx.routeId,
        action: 'REGISTER_PAYMENT',
        entityType: 'Payment',
        entityId: consolidated.paymentId,
        descripcion: consolidated.capped
          ? `Pago registrado por ${consolidated.appliedAmount} (solicitado ${consolidated.requestedAmount}; limitado al saldo pendiente)`
          : `Pago registrado por ${consolidated.appliedAmount}`,
        before: { saldo: consolidated.previousBalance, status: 'activa' },
        after: { saldo: consolidated.newBalance, status: consolidated.saleStatus },
        metadata: {
          saleId: ctx.saleId,
          paymentId: consolidated.paymentId,
          routeId: ctx.routeId,
          tenantId: ctx.tenantId,
          actorId: input.actor.id,
          // Trazabilidad de la atribución: quién responde por el dinero y quién lo digitó.
          collectorId: consolidated.collectorId,
          createdByUserId: input.actor.id,
          collectorSource: consolidated.collectorSource,
          requestedAmount: consolidated.requestedAmount,
          appliedAmount: consolidated.appliedAmount,
          capped: consolidated.capped,
          cappedAmount: consolidated.cappedAmount,
          previousBalance: consolidated.previousBalance,
          newBalance: consolidated.newBalance,
          paidInstallmentNumber: consolidated.paidInstallmentNumber,
          installmentsCompleted: consolidated.installmentsCompleted,
          timestamp: nowISO(),
        },
      })
    } catch (auditErr) {
      consolidated.audited = false
      consolidated.auditError = auditErr instanceof Error ? auditErr.message : String(auditErr)
      // Diagnóstico para soporte: el pago SÍ se aplicó; lo que falló es la traza.
      console.warn(
        `[RutaCash] Pago ${consolidated.paymentId} aplicado correctamente, pero NO se pudo auditar:`,
        consolidated.auditError,
      )
    }
  }

  return consolidated
}

function fail(code: PaymentRejectionCode): RegisterPaymentFailure {
  return { ok: false, code, message: REJECTION_MESSAGES[code] }
}

// ------------------------------------------------------------
// Montos rápidos (fuente única para los botones de las dos interfaces)
// ------------------------------------------------------------
export interface QuickAmounts {
  /** Lo que falta para cerrar la parcela actual (no el nominal `valorCuota`). */
  parcela: number
  /** La mitad de la parcela actual. */
  mitad: number
  /** El saldo total pendiente de la venta. */
  total: number
}

/**
 * Importes sugeridos para los accesos rápidos de la UI. Se calculan sobre el SALDO
 * REAL de la parcela actual, no sobre `sale.valorCuota`: la última parcela absorbe
 * el redondeo del total, así que su valor puede ser menor que el nominal y proponer
 * el nominal generaba un excedente silencioso.
 *
 * Si aún no se conocen las parcelas, se cae al nominal acotado por el saldo de la
 * venta (nunca propone más de lo que se debe).
 */
export function quickAmounts(
  sale: Pick<Sale, 'valorCuota' | 'saldo'>,
  installments: Installment[],
): QuickAmounts {
  const total = Math.max(0, calculateSaleBalance(installments) || sale.saldo)
  const actual = calculateCurrentInstallment(installments)
  const parcela = Math.min(actual ? actual.saldo : sale.valorCuota, total)
  return {
    parcela: Math.max(0, parcela),
    mitad: Math.max(0, Math.min(Math.floor(parcela / 2), total)),
    total,
  }
}
