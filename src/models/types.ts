// ============================================================
// RUTACASH - Modelos de dominio TypeScript
// ============================================================

// --- ENUMS ---

export type UserRole = 'superadmin' | 'admin' | 'socio' | 'supervisor' | 'cobrador' | 'secretario'

export type TenantStatus = 'activa' | 'suspendida' | 'prueba'

export type TenantPlan = 'basico' | 'operativo' | 'profesional' | 'empresarial'

export type RouteStatus = 'activa' | 'inactiva'

export type ClientStatus = 'activo' | 'inactivo' | 'moroso' | 'perdido'

export type SaleStatus = 'activa' | 'finalizada' | 'perdida' | 'refinanciada'

/**
 * Estado de desembolso de una venta (App Cobrador).
 * - undefined: ventas antiguas → se tratan como ya desembolsadas (compatibilidad).
 * - 'pendiente': venta creada (p. ej. al aprobar una solicitud) pero aún sin desembolsar;
 *   NO es cobrable hasta que el cobrador confirme el desembolso.
 * - 'desembolsado': venta activa y cobrable.
 */
export type DisbursementStatus = 'pendiente' | 'desembolsado'

/** Estado de una Solicitud de venta (UI: "Solicitud de venta"). */
export type SaleRequestStatus = 'pending' | 'approved' | 'rejected' | 'disbursed' | 'cancelled'

export type PaymentFrequency = 'diaria' | 'semanal' | 'quincenal' | 'mensual' | 'personalizada'

export type InstallmentStatus = 'pendiente' | 'parcial' | 'pagada' | 'vencida' | 'adelantada'

export type PaymentType = 'efectivo' | 'transferencia' | 'otro'

export type SyncStatus = 'synced' | 'pending' | 'error'

export type MovementType =
  | 'ingresoCapital'
  | 'ajusteCapital'
  | 'cobro'
  | 'prestamo'
  | 'gasto'
  | 'transferencia_entrada'
  | 'transferencia_salida'
  | 'retiro'

export type AuditAction =
  | 'CREATE_CLIENT'
  | 'UPDATE_CLIENT'
  | 'DELETE_CLIENT'
  | 'CREATE_SALE'
  | 'UPDATE_SALE'
  | 'SALE_LOST'
  | 'SALE_FINISHED'
  | 'REGISTER_PAYMENT'
  | 'REGISTER_NO_PAYMENT'
  | 'CREATE_EXPENSE'
  | 'CREATE_TRANSFER'
  | 'CREATE_WITHDRAWAL'
  | 'ADD_CAPITAL'
  | 'CHANGE_ROUTE'
  | 'UPDATE_USER'
  | 'CREATE_USER'
  | 'DELETE_USER'
  | 'UPDATE_TENANT'
  | 'DELETE_ROUTE'
  // --- Modelo de roles y permisos (nuevas acciones auditables) ---
  | 'CREATE_TENANT'
  | 'SUSPEND_TENANT'
  | 'CREATE_ROUTE'
  | 'UPDATE_ROUTE'
  | 'BLOCK_ROUTE'
  | 'ASSIGN_ROUTE'
  | 'UNASSIGN_ROUTE'
  | 'BLOCK_USER'
  | 'CHANGE_ROLE'
  | 'CHANGE_PERMISSIONS'
  | 'RESET_PASSWORD'
  | 'CHANGE_PASSWORD'
  | 'APPROVE_SALE_REQUEST'
  | 'REJECT_SALE_REQUEST'
  | 'CHANGE_SALE_CONDITIONS'
  | 'PHONE_CONFIRMATION'
  | 'CONFIRM_DISBURSEMENT'
  | 'CORRECT_PAYMENT'
  | 'REVERSE_PAYMENT'
  | 'REQUEST_PAYMENT_ADJUSTMENT'
  | 'APPROVE_PAYMENT_ADJUSTMENT'
  | 'REJECT_PAYMENT_ADJUSTMENT'
  | 'MODIFY_CASHBOX'
  | 'CLOSE_PERIOD'
  | 'REOPEN_PERIOD'

// --- ENTIDADES ---

export interface Tenant {
  id: string
  nombre: string
  nombreLegal?: string
  nit?: string
  email: string
  telefono?: string
  plan: TenantPlan
  status: TenantStatus
  fechaVencimiento?: string
  logo?: string
  pais: string
  ciudad?: string
  moneda: string
  direccion?: string
  responsable?: string
  createdAt: string
  updatedAt: string
}


export interface Route {
  id: string
  tenantId: string
  /** @deprecated Legacy: "Oficinas" se eliminó; el contexto es la ruta (routeId)/empresa (tenantId). */
  officeId?: string
  nombre: string
  codigo: string
  ciudad?: string
  email?: string
  telefono?: string
  tasaInteres: number
  tasaLibre: boolean
  montoMaximoPrestamo: number
  capitalInicial: number
  capitalActual: number
  cobradorId?: string
  status: RouteStatus
  createdAt: string
  updatedAt: string
}

export interface User {
  id: string
  tenantId: string
  officeId?: string
  routeId?: string
  nombre: string
  email: string
  password: string
  rol: UserRole
  telefono?: string
  avatar?: string
  /**
   * Rutas autorizadas del usuario (modelo centralizado ROL + CAPACIDADES + RUTAS).
   * Aplica a admin, socio, supervisor, cobrador y secretario. El SUPERADMIN no se
   * limita por este campo (accede a todas las rutas de la empresa).
   * Opcional para compatibilidad: si no existe, se usa `routeId` como fallback
   * (una sola ruta). Ver helpers en `src/lib/roles.ts` y `src/lib/permissions.ts`.
   */
  authorizedRouteIds?: string[]
  /**
   * @deprecated LEGADO (modelo de roles y permisos). La validación funcional con el
   * socio determinó que el COBRADOR NO crea ventas directas: toda venta suya es una
   * solicitud pendiente de autorización. Este campo se conserva solo por compatibilidad
   * y la migración lo pone en `false` para cobradores. La capacidad real de venta
   * directa se resuelve en `src/lib/permissions.ts` (capability `sale.createDirect`),
   * que hoy únicamente tienen admin y superadmin.
   */
  canCreateDirectSales?: boolean
  /** @deprecated LEGADO: tope de venta directa del cobrador (ver canCreateDirectSales). */
  maxDirectSaleAmount?: number
  /**
   * Capacidades ADICIONALES otorgadas explícitamente a este usuario, por encima de
   * las predeterminadas de su rol (delegación). Un administrador solo puede otorgar
   * capacidades que él mismo posee. Ver `Capability` en src/lib/permissions.ts.
   */
  grantedCapabilities?: string[]
  /** Capacidades RETIRADAS explícitamente (tienen prioridad sobre las del rol/otorgadas). */
  revokedCapabilities?: string[]
  status: 'activo' | 'inactivo'
  createdAt: string
  updatedAt: string
}

export interface Client {
  id: string
  tenantId: string
  /** @deprecated Legacy: "Oficinas" se eliminó; el contexto es la ruta (routeId)/empresa (tenantId). */
  officeId?: string
  routeId: string
  nombre: string
  documento: string
  telefonoPrincipal: string
  telefonoSecundario?: string
  direccionPrincipal: string
  direccionSecundaria?: string
  negocio?: string
  fotoDocumentoUrl?: string
  fotoNegocioUrl?: string
  status: ClientStatus
  notas?: string
  createdAt: string
  updatedAt: string
}

export interface Sale {
  id: string
  tenantId: string
  /** @deprecated Legacy: "Oficinas" se eliminó; el contexto es la ruta (routeId)/empresa (tenantId). */
  officeId?: string
  routeId: string
  clientId: string
  createdByUserId: string
  valorVenta: number
  tasaInteres: number
  valorInteres: number
  valorTotal: number
  saldo: number
  numeroCuotas: number
  valorCuota: number
  frecuenciaPago: PaymentFrequency
  /**
   * Días de la semana en los que se cobra esta venta.
   * 0=domingo, 1=lunes, 2=martes, 3=miércoles, 4=jueves, 5=viernes, 6=sábado.
   * Opcional para mantener compatibilidad con ventas existentes que no lo tengan.
   * NOTA (Paquete 1): se captura y se guarda, pero el motor de cuotas y el
   * listado del cobrador aún NO lo consumen. Pendiente Paquete 2.
   */
  paymentDays?: number[]
  fechaInicio: string
  fechaFinalEstimada: string
  status: SaleStatus
  /** App Cobrador: estado de desembolso. undefined = desembolsada (ventas antiguas). */
  disbursementStatus?: DisbursementStatus
  /** Solicitud de venta de origen, si la venta nació de una autorización. */
  saleRequestId?: string
  motivoPerdida?: string
  createdAt: string
  updatedAt: string
}

/**
 * Solicitud de venta enviada por un cobrador para autorización del administrador.
 * Nombres técnicos en inglés; en la UI siempre se llama "Solicitud de venta".
 */
export interface SaleRequest {
  id: string
  tenantId: string
  clientId: string
  routeId: string
  collectorId: string
  amount: number
  interestRate: number
  totalAmount: number
  installmentsCount: number
  installmentValue: number
  frequency: PaymentFrequency
  startDate: string
  paymentDays?: number[]
  status: SaleRequestStatus
  requestedAt: string
  reviewedAt?: string
  reviewedBy?: string
  rejectionReason?: string
  approvalNotes?: string
  /** Venta creada al aprobar (para enlazar con el desembolso). */
  saleId?: string
  // --- Trazabilidad de autorización (modelo de roles y permisos) ---
  /** Quien originó la solicitud (cobrador/supervisor). Igual a collectorId salvo casos especiales. */
  requestedBy?: string
  /**
   * Condiciones SOLICITADAS (originales), congeladas al crear la solicitud. No se
   * sobrescriben aunque el revisor cambie porcentaje/frecuencia/días al aprobar.
   */
  requestedInterestRate?: number
  requestedFrequency?: PaymentFrequency
  requestedPaymentDays?: number[]
  /** Condiciones FINALES aprobadas (si el revisor las modificó). */
  approvedInterestRate?: number
  approvedFrequency?: PaymentFrequency
  approvedPaymentDays?: number[]
  /** Confirmación telefónica con el cliente (Secretario / autorizador). */
  phoneConfirmed?: boolean
  phoneConfirmationNote?: string
}

export interface Installment {
  id: string
  saleId: string
  numero: number
  fechaVencimiento: string
  valor: number
  pagado: number
  saldo: number
  status: InstallmentStatus
  diasMora: number
}

/**
 * Estado de un pago en el flujo de CORRECCIÓN CONTROLADA (no destructiva).
 * - undefined / 'active': pago normal vigente (compatibilidad con pagos antiguos).
 * - 'reversed': pago original que fue corregido; PERMANECE como histórico inalterado
 *   (no se borra) y queda enlazado con su corrección vía `correctedByPaymentId`.
 * - 'reversal': asiento de reversión (valor negativo) que anula contablemente al
 *   original; enlaza con él vía `reversesPaymentId`.
 * - 'correction': pago corregido nuevo que reemplaza al original; enlaza con el
 *   original vía `correctionOfPaymentId`.
 */
export type PaymentState = 'active' | 'reversed' | 'reversal' | 'correction'

export interface Payment {
  id: string
  tenantId: string
  saleId: string
  clientId: string
  routeId: string
  collectorId: string
  valor: number
  fecha: string
  tipo: PaymentType
  observacion?: string
  lat?: number
  lng?: number
  syncStatus: SyncStatus
  createdAt: string
  // --- Corrección controlada de pagos (trazabilidad; ver paymentCorrectionService) ---
  /** Estado del pago. undefined = 'active' (pagos antiguos). */
  state?: PaymentState
  /** En un asiento de reversión: id del pago original que anula. */
  reversesPaymentId?: string
  /** En el pago original corregido: id del pago corregido que lo reemplaza. */
  correctedByPaymentId?: string
  /** En el pago corregido: id del pago original al que corrige. */
  correctionOfPaymentId?: string
  /** Motivo de la corrección (obligatorio al corregir). */
  correctionReason?: string
  /** Usuario que ejecutó la corrección/reversión. */
  correctedBy?: string
  /** Fecha/hora de la corrección/reversión. */
  correctedAt?: string
}

/** Estado de una Solicitud de ajuste de pago (periodos cerrados). */
export type PaymentAdjustmentStatus = 'pending' | 'approved' | 'rejected'

/**
 * Solicitud de ajuste de pago (CORRECCIÓN CONTROLADA en periodo CERRADO).
 * Cuando el pago ya fue incluido en una liquidación/cuadre cerrado, el Secretario
 * NO puede corregirlo directamente: genera esta solicitud, que debe aprobar un
 * Administrador autorizado para la ruta o el Super Admin. Al aprobarse se ejecuta
 * la reversión + reemplazo (nunca se elimina el pago original).
 */
export interface PaymentAdjustmentRequest {
  id: string
  tenantId: string
  routeId: string
  paymentId: string
  clientId: string
  saleId: string
  requestedBy: string
  requestedByRole: UserRole
  requestedAt: string
  /** Condiciones originales del pago (para evidencia antes/después). */
  originalValor: number
  originalFecha: string
  /** Corrección solicitada. */
  reason: string
  newValor: number
  newFecha?: string
  observacion?: string
  status: PaymentAdjustmentStatus
  reviewedBy?: string
  reviewedAt?: string
  rejectionReason?: string
  /** Al aprobarse: ids resultantes de la reversión y del pago corregido. */
  resultingReversalId?: string
  resultingPaymentId?: string
}

export interface NoPaymentVisit {
  id: string
  tenantId: string
  saleId: string
  clientId: string
  routeId: string
  collectorId: string
  motivo: 'no_estaba' | 'sin_dinero' | 'negocio_cerrado' | 'promesa_pago' | 'otro'
  fechaPromesaPago?: string
  observacion?: string
  fecha: string
  syncStatus: SyncStatus
  createdAt: string
}

export interface ExpenseCategory {
  id: string
  tenantId: string
  nombre: string
  icono?: string
  activa: boolean
}

export interface Expense {
  id: string
  tenantId: string
  /** @deprecated Legacy: "Oficinas" se eliminó; el contexto es la ruta (routeId)/empresa (tenantId). */
  officeId?: string
  routeId: string
  categoryId: string
  valor: number
  descripcion?: string
  /** App Cobrador: foto opcional de factura/soporte (Data URL local). */
  receiptPhotoDataUrl?: string
  fecha: string
  userId: string
  syncStatus: SyncStatus
  createdAt: string
}

export interface CapitalMovement {
  id: string
  tenantId: string
  /** @deprecated Legacy: "Oficinas" se eliminó; el contexto es la ruta (routeId)/empresa (tenantId). */
  officeId?: string
  routeId: string
  tipo: 'ingresoCapital' | 'ajusteCapital'
  valor: number
  descripcion?: string
  fecha: string
  userId: string
  createdAt: string
}

/**
 * Tipo de entidad que participa en una transferencia (Revisión 2 socio 30-jun).
 * Una transferencia puede ir Ruta↔Ruta, Ruta↔Socio, Socio↔Ruta o Socio↔Socio.
 */
export type TransferEntityType = 'route' | 'partner'

export interface Transfer {
  id: string
  tenantId: string
  /** @deprecated Legacy: "Oficinas" se eliminó; el contexto es la ruta (routeId)/empresa (tenantId). */
  officeId?: string
  /**
   * ID de la ruta origen cuando el origen es una RUTA. Se mantiene por
   * compatibilidad y porque el motor de caja indexa por este campo.
   * Si el origen es un SOCIO queda como '' (cadena vacía) y se usa socioOrigenId.
   */
  routeOrigenId: string
  /** ID de la ruta destino cuando el destino es una RUTA. */
  routeDestinoId?: string
  /** ID del socio origen cuando el origen es un SOCIO (Revisión 2). */
  socioOrigenId?: string
  /** ID del socio destino cuando el destino es un SOCIO. */
  socioDestinoId?: string
  /**
   * Tipo de entidad del origen/destino. Opcionales para compatibilidad:
   * las transferencias antiguas (sin estos campos) se interpretan como 'route'.
   */
  origenType?: TransferEntityType
  destinoType?: TransferEntityType
  valor: number
  descripcion?: string
  fecha: string
  userId: string
  createdAt: string
}

export interface Withdrawal {
  id: string
  tenantId: string
  /** @deprecated Legacy: "Oficinas" se eliminó; el contexto es la ruta (routeId)/empresa (tenantId). */
  officeId?: string
  routeId: string
  valor: number
  descripcion?: string
  fecha: string
  userId: string
  createdAt: string
}

/**
 * Movimiento de Caja socios (Revisión 2 socio 30-jun).
 * Caja socios es un módulo SEPARADO de la caja de rutas: registra el dinero
 * asociado a cada socio (usuario con rol 'socio'). Se alimenta de dos formas:
 *  1. Movimientos creados directamente en el módulo Caja socios.
 *  2. Movimientos generados automáticamente por una Transferencia que involucra
 *     a un socio (se enlazan con relatedTransferId).
 */
export type PartnerCashType = 'ingreso' | 'salida'

/** Categorías de movimiento de Caja socios. */
export type PartnerCashCategory =
  | 'ingreso'          // ingreso genérico con observación
  | 'reembolso'
  | 'inversion'
  | 'retiro'
  | 'envio_exterior'
  | 'transferencia'    // generado desde el módulo Transferencias
  | 'otro'

export interface PartnerCashMovement {
  id: string
  tenantId: string
  /** Usuario con rol 'socio' dueño del movimiento. */
  partnerId: string
  type: PartnerCashType
  category: PartnerCashCategory
  amount: number
  description?: string
  /** Si el movimiento nació de una transferencia, su id (para trazabilidad). */
  relatedTransferId?: string
  fecha: string
  createdAt: string
  createdBy?: string
}

export interface CashboxMovement {
  id: string
  tenantId: string
  routeId: string
  tipo: MovementType
  valor: number
  descripcion: string
  referenceId?: string
  fecha: string
  createdAt: string
}

export interface WeeklySettlement {
  id: string
  tenantId: string
  /** @deprecated Legacy: "Oficinas" se eliminó; el contexto es la ruta (routeId)/empresa (tenantId). */
  officeId?: string
  routeId: string
  semanaInicio: string
  semanaFin: string
  saldoAnterior: number
  ingresoCapital: number
  cobros: number
  prestamosEntregados: number
  gastos: number
  transferenciasEntradas: number
  transferenciasSalidas: number
  retiros: number
  saldoFinal: number
  createdAt: string
  /**
   * Estado del periodo/liquidación (corrección controlada de pagos).
   * Una liquidación registrada representa una semana CERRADA. undefined = 'cerrada'
   * (compatibilidad con liquidaciones existentes). Los pagos con fecha dentro del
   * rango [semanaInicio, semanaFin] de una liquidación 'cerrada' NO son corregibles
   * directamente por el Secretario: requieren Solicitud de ajuste de pago.
   */
  status?: 'abierta' | 'cerrada'
}

export interface AuditLog {
  id: string
  tenantId: string
  userId: string
  /** Rol del usuario al momento de la acción (trazabilidad). */
  userRole?: UserRole
  /** Ruta relacionada, cuando aplique. */
  routeId?: string
  action: AuditAction
  entityType: string
  entityId: string
  descripcion: string
  /** Valores anteriores / nuevos (para acciones que modifican datos). */
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  /** Motivo, cuando la acción lo exige (correcciones, rechazos, ajustes). */
  motivo?: string
  metadata?: Record<string, unknown>
  createdAt: string
}

// --- TIPOS CALCULADOS Y HELPERS ---

export interface RouteMetrics {
  routeId: string
  capitalActual: number
  carteraActiva: number
  cobradoHoy: number
  cobradoSemana: number
  ventasActivas: number
  gastosSemana: number
  saldoActual: number
}

export interface CashboxSummary {
  routeId: string
  saldoAnterior: number
  ingresoCapital: number
  cobros: number
  prestamosEntregados: number
  gastos: number
  transferenciasEntradas: number
  transferenciasSalidas: number
  retiros: number
  saldoActual: number
}

/**
 * Resumen financiero por ruta (revisión socio 25-jun).
 * Separa dos conceptos que el socio pidió distinguir:
 *  - baseActual: dinero disponible REAL de la ruta (saldo de caja).
 *  - carteraEnCalle: lo prestado en la calle pendiente por cobrar (capital + interés)
 *    en ventas activas YA desembolsadas.
 */
export interface RouteFinancialSummary {
  routeId: string
  /** Saldo de caja disponible (getRouteAvailableCapital). */
  baseActual: number
  /** Saldo pendiente por cobrar de ventas activas desembolsadas (capital + interés). */
  carteraEnCalle: number
  /** baseActual + carteraEnCalle: valor total que administra la ruta. */
  totalControlado: number
  /** Ventas activas desembolsadas. */
  ventasActivas: number
  /** Clientes distintos con venta activa desembolsada. */
  clientesActivos: number
  /**
   * Interés pendiente por cobrar ESTIMADO (proporcional al saldo de cada venta:
   * saldo × valorInteres / valorTotal). Es una aproximación, no un desglose exacto;
   * se documenta como estimado hasta que el socio defina el desglose definitivo (V2).
   */
  interesPorCobrarEstimado: number
}

export interface DashboardMetrics {
  capitalTotal: number
  carteraActiva: number
  recaudoHoy: number
  recaudoSemana: number
  ventasActivas: number
  clientesActivos: number
  gastosSemana: number
  saldoGeneral: number
  rutasConMora: number
  clientesEnMora: number
  pagosPendienteSync: number
}
