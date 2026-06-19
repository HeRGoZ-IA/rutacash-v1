// ============================================================
// RUTACASH - Modelos de dominio TypeScript
// ============================================================

// --- ENUMS ---

export type UserRole = 'superadmin' | 'admin' | 'supervisor' | 'cobrador' | 'socio'

export type TenantStatus = 'activa' | 'suspendida' | 'prueba'

export type TenantPlan = 'basico' | 'operativo' | 'profesional' | 'empresarial'

export type OfficeStatus = 'activa' | 'inactiva'

export type RouteStatus = 'activa' | 'inactiva'

export type ClientStatus = 'activo' | 'inactivo' | 'moroso' | 'perdido'

export type SaleStatus = 'activa' | 'finalizada' | 'perdida' | 'refinanciada'

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
  | 'DELETE_OFFICE'
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

export interface Office {
  id: string
  tenantId: string
  nombre: string
  pais: string
  ciudad: string
  responsable?: string
  telefono?: string
  email?: string
  status: OfficeStatus
  createdAt: string
  updatedAt: string
}

export interface Route {
  id: string
  tenantId: string
  officeId: string
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
  status: 'activo' | 'inactivo'
  createdAt: string
  updatedAt: string
}

export interface Client {
  id: string
  tenantId: string
  officeId: string
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
  officeId: string
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
  fechaInicio: string
  fechaFinalEstimada: string
  status: SaleStatus
  motivoPerdida?: string
  createdAt: string
  updatedAt: string
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
  officeId: string
  routeId: string
  categoryId: string
  valor: number
  descripcion?: string
  fecha: string
  userId: string
  syncStatus: SyncStatus
  createdAt: string
}

export interface CapitalMovement {
  id: string
  tenantId: string
  officeId: string
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
  officeId: string
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
  officeId: string
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
  officeId: string
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
