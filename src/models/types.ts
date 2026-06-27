// ============================================================
// RUTACASH - Modelos de dominio TypeScript
// ============================================================

// --- ENUMS ---

export type UserRole = 'superadmin' | 'admin' | 'supervisor' | 'cobrador' | 'socio'

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
   * Rutas autorizadas para el rol SUPERVISOR (Paquete 3).
   * Opcional para mantener compatibilidad: cobradores siguen usando `routeId`
   * (una sola ruta) y los usuarios antiguos sin este campo no se rompen.
   * Un supervisor con `routeId` heredado se trata como una ruta autorizada.
   */
  authorizedRouteIds?: string[]
  /**
   * Config de ventas directas del cobrador (App Cobrador).
   * Decisión: se configura POR USUARIO (cobrador) porque la solicitud de venta
   * la origina el cobrador; toca menos código que hacerlo por ruta.
   * - canCreateDirectSales: si puede crear ventas directas (sin autorización).
   *   undefined/false → SIEMPRE debe enviar solicitud (opción más segura por defecto).
   * - maxDirectSaleAmount: tope para venta directa. undefined/0 → sin límite.
   */
  canCreateDirectSales?: boolean
  maxDirectSaleAmount?: number
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

export interface Transfer {
  id: string
  tenantId: string
  /** @deprecated Legacy: "Oficinas" se eliminó; el contexto es la ruta (routeId)/empresa (tenantId). */
  officeId?: string
  routeOrigenId: string
  routeDestinoId?: string
  socioDestinoId?: string
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
}

export interface AuditLog {
  id: string
  tenantId: string
  userId: string
  action: AuditAction
  entityType: string
  entityId: string
  descripcion: string
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
