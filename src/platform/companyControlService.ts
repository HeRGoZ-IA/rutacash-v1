// ============================================================
// RUTACASH — OPERACIONES SaaS DEL OWNER SOBRE LAS EMPRESAS
// ------------------------------------------------------------
// Todo lo que el Owner puede hacer con una empresa cliente, y NADA más:
//   · darla de alta junto con su PRIMER Super Admin;
//   · consultar y editar sus datos COMERCIALES;
//   · suspender y reactivar el servicio;
//   · fijar plan y tarifa;
//   · registrar cobros de RutaCash;
//   · leer sus métricas estructurales (rutas, primer/último acceso).
//
// Lo que NO hay aquí, deliberadamente: ni una consulta a clientes, ventas, pagos
// operativos, cartera, caja, gastos o documentos. El Owner no entra en la operación
// de sus clientes. No existe impersonación ni "entrar como cliente".
//
// LOS DOS RELOJES DE ESTADO
//   · `CompanyControlRecord.status` (trial | active | suspended) es la decisión
//     COMERCIAL del Owner.
//   · `Tenant.status` (prueba | activa | suspendida) es lo que consume la aplicación
//     de la empresa para permitir o bloquear el acceso.
//   Se escriben SIEMPRE juntos, en la misma transacción, desde este único sitio. No
//   son dos verdades: uno es la decisión y el otro su efecto.
// ============================================================
import { generateId } from '@/lib/utils'
import { nowISO, today } from '@/lib/formatters'
import { normalizeEmail, validateEmail } from '@/lib/email'
import { buildDefaultExpenseCategories } from '@/lib/expenseCategoryDefaults'
import { computeRouteMetrics, expectedPeriodAmount } from '@/platform/billing'
import { controlPlane, type SaaSControlPlane } from '@/platform/controlPlane'
import type {
  BillingMode, CompanyCommercialStatus, CompanyControlRecord, ControlEvent,
  ControlEventType, PlatformUser, SaaSPayment, SaaSPaymentStatus,
} from '@/platform/types'
import type { ExpenseCategory, Tenant, TenantStatus, User } from '@/models/types'

// ------------------------------------------------------------
// Contrato de base para el ALTA de empresa
// ------------------------------------------------------------
/**
 * Superficie mínima que necesita el alta. Son las TRES tablas imprescindibles para
 * que una empresa exista y tenga quien la administre, más el plano de control.
 * Ninguna tabla operativa aparece aquí.
 */
export interface CompanyProvisioningDatabase {
  tenants: { add(item: Tenant): Promise<unknown>; get(key: string): Promise<Tenant | undefined>; update(key: string, changes: Partial<Tenant>): Promise<number>; toArray(): Promise<Tenant[]> }
  users: { add(item: User): Promise<unknown>; toArray(): Promise<User[]> }
  expenseCategories: { bulkAdd(items: ExpenseCategory[]): Promise<unknown> }
  companyControl: { add(item: CompanyControlRecord): Promise<unknown> }
  transaction<U>(mode: 'rw', tables: any, scope: () => PromiseLike<U>): Promise<U>
}

/** Correspondencia ÚNICA entre el estado comercial y el estado operativo del tenant. */
export function tenantStatusFor(status: CompanyCommercialStatus): TenantStatus {
  switch (status) {
    case 'trial': return 'prueba'
    case 'active': return 'activa'
    case 'suspended': return 'suspendida'
  }
}

/** Correspondencia inversa, para derivar el estado comercial de empresas heredadas. */
export function commercialStatusFor(status: TenantStatus): CompanyCommercialStatus {
  switch (status) {
    case 'prueba': return 'trial'
    case 'suspendida': return 'suspended'
    default: return 'active'
  }
}

// ------------------------------------------------------------
// Alta de empresa + primer Super Admin
// ------------------------------------------------------------
export interface CreateCompanyInput {
  /** Datos COMERCIALES mínimos de la empresa. */
  nombre: string
  email: string
  identificacion?: string
  contacto?: string
  pais?: string
  moneda?: string
  /** Plan comercial inicial. Por defecto entra en prueba. */
  status?: CompanyCommercialStatus
  billingMode?: BillingMode
  billingRate?: number
  nextBillingDate?: string
  /** PRIMER Super Admin de la empresa. Datos mínimos: nombre, correo y clave inicial. */
  superAdmin: {
    nombre: string
    email: string
    password: string
  }
}

export type CreateCompanyRejectionCode =
  | 'INVALID_COMPANY_NAME'
  | 'INVALID_COMPANY_EMAIL'
  | 'INVALID_ADMIN_NAME'
  | 'INVALID_ADMIN_EMAIL'
  | 'WEAK_PASSWORD'
  | 'EMAIL_TAKEN'
  | 'NOT_OWNER'
  | 'WRITE_FAILED'

export interface CreateCompanySuccess {
  ok: true
  tenant: Tenant
  superAdmin: User
  record: CompanyControlRecord
}
export interface CreateCompanyFailure {
  ok: false
  code: CreateCompanyRejectionCode
  message: string
}
export type CreateCompanyResult = CreateCompanySuccess | CreateCompanyFailure

const CREATE_MESSAGES: Record<CreateCompanyRejectionCode, string> = {
  INVALID_COMPANY_NAME: 'Escribe el nombre de la empresa.',
  INVALID_COMPANY_EMAIL: 'Escribe un correo de empresa válido.',
  INVALID_ADMIN_NAME: 'Escribe el nombre del Super Admin.',
  INVALID_ADMIN_EMAIL: 'Escribe un correo válido para el Super Admin.',
  WEAK_PASSWORD: 'La contraseña inicial debe tener al menos 6 caracteres.',
  EMAIL_TAKEN: 'Ya existe un usuario con ese correo.',
  NOT_OWNER: 'Solo un Owner activo puede dar de alta empresas.',
  WRITE_FAILED: 'No se pudo crear la empresa. No se guardó ningún cambio.',
}

const reject = (code: CreateCompanyRejectionCode): CreateCompanyFailure =>
  ({ ok: false, code, message: CREATE_MESSAGES[code] })

class ProvisioningRejection extends Error {
  constructor(public code: CreateCompanyRejectionCode) {
    super(CREATE_MESSAGES[code]); this.name = 'ProvisioningRejection'
  }
}

/** Longitud mínima de la contraseña inicial que el Owner entrega al cliente. */
export const MIN_INITIAL_PASSWORD_LENGTH = 6

/**
 * ALTA DE EMPRESA — la única puerta por la que nace una empresa cliente.
 *
 * Crea, en UNA sola transacción: la empresa, sus categorías de gasto, su ficha de
 * control comercial y su PRIMER Super Admin. Si algo falla, no queda nada a medias.
 *
 * ONBOARDING (apartado O): aquí termina el trabajo del Owner. NO se crea ninguna
 * Oficina, ninguna Ruta ni ningún otro usuario. La empresa nace estructuralmente
 * vacía y es su Super Admin quien, entrando por `/login`, configura la empresa, crea
 * Oficinas, Rutas y el resto del equipo. El Owner no organiza la operación del
 * cliente: no es asunto suyo.
 *
 * CONTRASEÑA INICIAL: se define al crear la cuenta y el Super Admin puede usarla con
 * normalidad. No se marca ningún cambio obligatorio (apartado Q). Toda gestión
 * posterior de contraseñas ocurre en Usuarios, dentro de la empresa.
 */
export async function createCompanyWithFirstSuperAdmin(
  actor: PlatformUser,
  input: CreateCompanyInput,
  database: CompanyProvisioningDatabase,
  plane: SaaSControlPlane = controlPlane,
): Promise<CreateCompanyResult> {
  if (!actor || actor.rol !== 'owner' || actor.status !== 'activo') return reject('NOT_OWNER')

  const nombre = input.nombre?.trim() ?? ''
  if (nombre.length < 2) return reject('INVALID_COMPANY_NAME')

  const companyEmail = validateEmail(input.email)
  if (!companyEmail.ok) return reject('INVALID_COMPANY_EMAIL')

  const adminNombre = input.superAdmin?.nombre?.trim() ?? ''
  if (adminNombre.length < 2) return reject('INVALID_ADMIN_NAME')

  const adminEmail = validateEmail(input.superAdmin?.email ?? '')
  if (!adminEmail.ok) return reject('INVALID_ADMIN_EMAIL')

  const password = input.superAdmin?.password ?? ''
  if (password.length < MIN_INITIAL_PASSWORD_LENGTH) return reject('WEAK_PASSWORD')

  const status: CompanyCommercialStatus = input.status ?? 'trial'
  const at = nowISO()
  const tenantId = generateId()

  const tenant: Tenant = {
    id: tenantId,
    nombre,
    nit: input.identificacion?.trim() || undefined,
    email: companyEmail.email,
    responsable: input.contacto?.trim() || undefined,
    plan: 'profesional',
    status: tenantStatusFor(status),
    pais: input.pais?.trim() || 'Colombia',
    moneda: input.moneda?.trim() || 'COP',
    createdAt: at,
    updatedAt: at,
  }

  const superAdmin: User = {
    id: generateId(),
    tenantId,                      // SIEMPRE su empresa. Nunca el centinela de plataforma.
    nombre: adminNombre,
    email: adminEmail.email,
    password,
    rol: 'superadmin',
    status: 'activo',
    // Contraseña inicial utilizable. RutaCash ya no fuerza cambios de contraseña.
    mustChangePassword: false,
    createdAt: at,
    updatedAt: at,
  }

  const record: CompanyControlRecord = {
    companyId: tenantId,
    nombre,
    identificacion: input.identificacion?.trim() || undefined,
    contacto: input.contacto?.trim() || undefined,
    contactoEmail: companyEmail.email,
    createdAt: at,
    status,
    routeCount: 0,
    billableRouteCount: 0,
    billingMode: input.billingMode ?? 'per_route',
    billingRate: Math.max(0, input.billingRate ?? 0),
    nextBillingDate: input.nextBillingDate || undefined,
    paymentStatus: 'pending',
    updatedAt: at,
  }

  try {
    await database.transaction(
      'rw',
      [database.tenants, database.users, database.expenseCategories, database.companyControl],
      async () => {
        // El correo del Super Admin debe ser único en TODA la instalación: es la
        // clave de acceso. Se comprueba DENTRO de la transacción (es la que cuenta).
        const users = await database.users.toArray()
        if (users.some(u => normalizeEmail(u.email) === adminEmail.email)) {
          throw new ProvisioningRejection('EMAIL_TAKEN')
        }
        await database.tenants.add(tenant)
        await database.expenseCategories.bulkAdd(buildDefaultExpenseCategories(tenantId))
        await database.users.add(superAdmin)
        await database.companyControl.add(record)
      },
    )
  } catch (err) {
    if (err instanceof ProvisioningRejection) return { ok: false, code: err.code, message: err.message }
    return reject('WRITE_FAILED')
  }

  // Evento de control FUERA de la transacción de alta: la bitácora comercial no debe
  // poder tumbar el alta de una empresa ya creada correctamente.
  await emitEvent(plane, tenantId, 'COMPANY_CREATED', `Empresa creada: ${nombre}`)

  return { ok: true, tenant, superAdmin, record }
}

// ------------------------------------------------------------
// Eventos de control
// ------------------------------------------------------------
/** Registra un hecho estructural/comercial. Nunca se llama con datos operativos. */
export async function emitEvent(
  plane: SaaSControlPlane,
  companyId: string,
  type: ControlEventType,
  detail?: string,
): Promise<void> {
  const event: ControlEvent = { id: generateId(), companyId, type, at: nowISO(), detail }
  try {
    await plane.addEvent(event)
  } catch {
    // La bitácora es informativa: su fallo no puede tumbar la operación que la generó.
  }
}

// ------------------------------------------------------------
// Estado comercial (suspender / reactivar)
// ------------------------------------------------------------
export interface StatusChangeDatabase {
  tenants: { get(key: string): Promise<Tenant | undefined>; update(key: string, changes: Partial<Tenant>): Promise<number> }
}

/**
 * Cambia el estado COMERCIAL de una empresa y su reflejo operativo, juntos.
 *
 * Suspender no borra absolutamente nada: los datos de la empresa siguen intactos.
 * Lo que ocurre es que sus usuarios dejan de poder operar, con un mensaje corto y sin
 * detalles comerciales (`lib/company.companyBlockMessage`). El Super Admin NO puede
 * revertirlo: reactivar es competencia exclusiva del Owner.
 */
export async function setCompanyCommercialStatus(
  actor: PlatformUser,
  companyId: string,
  status: CompanyCommercialStatus,
  database: StatusChangeDatabase,
  plane: SaaSControlPlane = controlPlane,
): Promise<{ ok: boolean; error?: string }> {
  if (!actor || actor.rol !== 'owner' || actor.status !== 'activo') {
    return { ok: false, error: 'Solo un Owner activo puede cambiar el estado del servicio.' }
  }
  const tenant = await database.tenants.get(companyId)
  if (!tenant) return { ok: false, error: 'La empresa no existe.' }

  const at = nowISO()
  await database.tenants.update(companyId, { status: tenantStatusFor(status), updatedAt: at })
  await plane.updateCompany(companyId, { status, updatedAt: at })

  if (status === 'suspended') await emitEvent(plane, companyId, 'COMPANY_SUSPENDED', `Servicio suspendido: ${tenant.nombre}`)
  else await emitEvent(plane, companyId, 'COMPANY_ACTIVATED', `Servicio activo (${status}): ${tenant.nombre}`)

  return { ok: true }
}

// ------------------------------------------------------------
// Datos comerciales y tarifa
// ------------------------------------------------------------
export interface BillingUpdate {
  nombre?: string
  identificacion?: string
  contacto?: string
  contactoEmail?: string
  billingMode?: BillingMode
  billingRate?: number
  nextBillingDate?: string
  paymentStatus?: SaaSPaymentStatus
}

/** Edita los datos comerciales de una empresa. No toca ni un dato operativo suyo. */
export async function updateCompanyBilling(
  actor: PlatformUser,
  companyId: string,
  changes: BillingUpdate,
  plane: SaaSControlPlane = controlPlane,
): Promise<{ ok: boolean; error?: string }> {
  if (!actor || actor.rol !== 'owner' || actor.status !== 'activo') {
    return { ok: false, error: 'Solo un Owner activo puede editar los datos comerciales.' }
  }
  const record = await plane.getCompany(companyId)
  if (!record) return { ok: false, error: 'La empresa no existe en el plano de control.' }

  const clean: Partial<CompanyControlRecord> = { updatedAt: nowISO() }
  if (changes.nombre !== undefined) clean.nombre = changes.nombre.trim()
  if (changes.identificacion !== undefined) clean.identificacion = changes.identificacion.trim() || undefined
  if (changes.contacto !== undefined) clean.contacto = changes.contacto.trim() || undefined
  if (changes.contactoEmail !== undefined) clean.contactoEmail = changes.contactoEmail.trim() || undefined
  if (changes.billingMode !== undefined) clean.billingMode = changes.billingMode
  if (changes.billingRate !== undefined) clean.billingRate = Math.max(0, changes.billingRate)
  if (changes.nextBillingDate !== undefined) clean.nextBillingDate = changes.nextBillingDate || undefined
  if (changes.paymentStatus !== undefined) clean.paymentStatus = changes.paymentStatus

  await plane.updateCompany(companyId, clean)
  await emitEvent(plane, companyId, 'BILLING_UPDATED', 'Datos comerciales actualizados')
  return { ok: true }
}

// ------------------------------------------------------------
// Cobros de RutaCash (NO es Caja: son dos mundos distintos)
// ------------------------------------------------------------
export interface RegisterPaymentInput {
  companyId: string
  /** Período facturado, yyyy-MM. */
  periodo: string
  valor: number
  fechaEsperada: string
  fechaPagada?: string
  status: SaaSPaymentStatus
  nota?: string
}

/**
 * Registra un cobro de RutaCash a una empresa. Esto NO es un pago de un cliente
 * final a la empresa: son conceptos distintos, con tablas distintas y sin ningún
 * punto de contacto. Confundirlos sería el peor error posible de este módulo.
 */
export async function registerSaaSPayment(
  actor: PlatformUser,
  input: RegisterPaymentInput,
  plane: SaaSControlPlane = controlPlane,
): Promise<{ ok: boolean; payment?: SaaSPayment; error?: string }> {
  if (!actor || actor.rol !== 'owner' || actor.status !== 'activo') {
    return { ok: false, error: 'Solo un Owner activo puede registrar cobros.' }
  }
  if (!/^\d{4}-\d{2}$/.test(input.periodo)) return { ok: false, error: 'El período debe tener el formato AAAA-MM.' }
  if (!(input.valor > 0)) return { ok: false, error: 'El valor debe ser mayor que cero.' }
  if (!input.fechaEsperada) return { ok: false, error: 'Indica la fecha esperada de pago.' }

  const at = nowISO()
  const payment: SaaSPayment = {
    id: generateId(),
    companyId: input.companyId,
    periodo: input.periodo,
    valor: input.valor,
    fechaEsperada: input.fechaEsperada,
    fechaPagada: input.status === 'paid' ? (input.fechaPagada || today()) : undefined,
    status: input.status,
    nota: input.nota?.trim() || undefined,
    createdAt: at,
    updatedAt: at,
  }
  await plane.addPayment(payment)
  // El estado de pago de la ficha refleja SIEMPRE el último cobro registrado.
  await plane.updateCompany(input.companyId, { paymentStatus: input.status, updatedAt: at })
  await emitEvent(plane, input.companyId, 'PAYMENT_REGISTERED', `Cobro ${input.periodo}: ${input.status}`)
  return { ok: true, payment }
}

/** Marca un cobro ya registrado como pagado. */
export async function markPaymentPaid(
  actor: PlatformUser,
  payment: SaaSPayment,
  fechaPagada: string,
  plane: SaaSControlPlane = controlPlane,
): Promise<{ ok: boolean; error?: string }> {
  if (!actor || actor.rol !== 'owner' || actor.status !== 'activo') {
    return { ok: false, error: 'Solo un Owner activo puede registrar cobros.' }
  }
  const at = nowISO()
  await plane.updatePayment(payment.id, { status: 'paid', fechaPagada: fechaPagada || today(), updatedAt: at })
  await plane.updateCompany(payment.companyId, { paymentStatus: 'paid', updatedAt: at })
  await emitEvent(plane, payment.companyId, 'PAYMENT_REGISTERED', `Cobro ${payment.periodo} pagado`)
  return { ok: true }
}

// ------------------------------------------------------------
// Telemetría de acceso de la empresa (primer / último ingreso)
// ------------------------------------------------------------
/**
 * Registra el acceso de un usuario de EMPRESA al producto.
 *
 * DECISIÓN DOCUMENTADA (apartado U): lo que tiene valor comercial es cuándo la
 * empresa EMPEZÓ A USAR el producto, no cuándo lo hizo una persona concreta. Por eso:
 *   · `firstLoginAt` = primer login correcto de CUALQUIER usuario del tenant. Se
 *     sella una sola vez y no se reescribe nunca.
 *   · `lastLoginAt`  = último login correcto de cualquier usuario del tenant.
 * No se guarda el historial completo de accesos: el Owner necesita dos fechas, no una
 * bitácora de quién entra y cuándo, que además rozaría la privacidad del cliente.
 *
 * Es FAIL-SAFE a propósito: si el plano de control falla, el usuario entra igual. La
 * telemetría comercial nunca puede impedir que un cliente trabaje.
 */
export async function recordTenantLogin(
  tenantId: string,
  plane: SaaSControlPlane = controlPlane,
  at: string = nowISO(),
): Promise<void> {
  if (!tenantId) return
  try {
    const record = await plane.getCompany(tenantId)
    if (!record) return
    const esPrimero = !record.firstLoginAt
    await plane.updateCompany(tenantId, {
      ...(esPrimero ? { firstLoginAt: at } : {}),
      lastLoginAt: at,
      updatedAt: at,
    })
    await emitEvent(plane, tenantId, esPrimero ? 'FIRST_LOGIN' : 'LOGIN', esPrimero ? 'Primer acceso de la empresa' : 'Acceso')
  } catch {
    /* nunca bloquea el acceso */
  }
}

// ------------------------------------------------------------
// Métricas de rutas (la cifra que se factura)
// ------------------------------------------------------------
/**
 * Recalcula y persiste `routeCount` / `billableRouteCount` de una empresa a partir de
 * sus rutas REALES. Se invoca desde las operaciones de ruta del tenant (crear,
 * activar/desactivar, eliminar) para que el número del Owner no se quede obsoleto.
 *
 * Recalcular en vez de sumar/restar es deliberado: un contador incremental se
 * desincroniza a la primera operación que falle a medias, y aquí la cifra es la base
 * del cobro. Contar de nuevo es barato y siempre es correcto.
 *
 * FAIL-SAFE: si el plano de control falla, la operación de ruta del cliente NO se
 * revierte. La métrica comercial no puede impedir que una empresa cree una ruta; se
 * reconciliará en el siguiente recálculo.
 */
export async function syncRouteMetrics(
  tenantId: string,
  plane: SaaSControlPlane = controlPlane,
  event?: ControlEventType,
  detail?: string,
): Promise<void> {
  if (!tenantId) return
  try {
    const record = await plane.getCompany(tenantId)
    if (!record) return
    const metrics = await plane.countRoutes(tenantId)
    await plane.updateCompany(tenantId, { ...metrics, updatedAt: nowISO() })
    if (event) await emitEvent(plane, tenantId, event, detail)
  } catch {
    /* nunca bloquea la operación de ruta */
  }
}

/** Recalcula métricas de rutas a partir de una lista ya cargada (sin ir a la base). */
export function routeMetricsOf(routes: { status: string }[]) {
  return computeRouteMetrics(routes)
}

// ------------------------------------------------------------
// Indicadores del Dashboard del Owner
// ------------------------------------------------------------
export interface OwnerKpis {
  empresasTotales: number
  empresasActivas: number
  empresasPrueba: number
  empresasSuspendidas: number
  rutasActuales: number
  rutasFacturables: number
  cobroEsperadoPeriodo: number
  cobrosPendientes: number
}

/**
 * KPIs del Dashboard. Solo cifras con valor comercial real: cuántas empresas hay y
 * en qué estado, cuántas rutas se facturan y cuánto se espera cobrar. Nada de
 * indicadores decorativos.
 */
export function ownerKpis(records: CompanyControlRecord[], payments: SaaSPayment[]): OwnerKpis {
  const activas = records.filter(r => r.status === 'active').length
  const prueba = records.filter(r => r.status === 'trial').length
  const suspendidas = records.filter(r => r.status === 'suspended').length
  const enServicio = records.filter(r => r.status !== 'suspended')
  return {
    empresasTotales: records.length,
    empresasActivas: activas,
    empresasPrueba: prueba,
    empresasSuspendidas: suspendidas,
    rutasActuales: records.reduce((s, r) => s + r.routeCount, 0),
    rutasFacturables: records.reduce((s, r) => s + r.billableRouteCount, 0),
    cobroEsperadoPeriodo: enServicio.reduce((s, r) => s + expectedPeriodAmount(r), 0),
    cobrosPendientes: payments.filter(p => p.status !== 'paid').length,
  }
}
