// ============================================================
// RUTACASH — PLANO DE CONTROL SaaS (NIVEL PLATAFORMA)
// ------------------------------------------------------------
// Estos modelos pertenecen a RutaCash como PRODUCTO, no a ninguna empresa cliente.
// Son la frontera dura entre los dos niveles del sistema:
//
//   NIVEL 1 · PLATAFORMA  → Owner. Administra el SaaS: empresas, altas, estado
//                            comercial, rutas facturables y cobros de RutaCash.
//   NIVEL 2 · EMPRESA     → Super Admin y por debajo. Operan SU empresa.
//
// REGLA INNEGOCIABLE DE PRIVACIDAD: en este plano NO entra ni un solo dato
// operativo de las empresas. Nada de clientes, ventas, pagos, cartera, caja,
// documentos ni cobradores. Solo hechos ESTRUCTURALES y COMERCIALES.
// Lo garantiza la prueba OWNER-PRIVACY-* leyendo los imports reales del código.
//
// LIMITACIÓN VIGENTE (auditada, no disimulada): hoy estas entidades se persisten en
// la MISMA base local (IndexedDB) que la operación, porque RutaCash no tiene aún
// backend compartido. Por eso viven detrás de `SaaSControlPlane` (repositorio
// inyectable): el día que exista servidor, solo cambia la implementación.
// Ver docs/CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md.
// ============================================================

/**
 * Rol del NIVEL PLATAFORMA. Deliberadamente NO forma parte de `UserRole`
 * (src/models/types.ts): un Owner no es un usuario de empresa degradado ni
 * ascendido, es un registro de autenticación de otra tabla. Así ningún selector
 * de roles empresariales puede ofrecerlo y ningún Super Admin puede crearlo.
 */
export type PlatformRole = 'owner'

/**
 * Persona dueña de RutaCash. Vive en la tabla `platformUsers`, NUNCA en `users`.
 * No tiene `tenantId` ni `authorizedRouteIds`: no pertenece a ninguna empresa y no
 * opera ninguna ruta.
 */
export interface PlatformUser {
  id: string
  nombre: string
  email: string
  /**
   * NOTA DE SEGURIDAD (idéntica a la del nivel empresa, ver `permissions.ts`):
   * la contraseña se guarda en texto plano en la base local. Esto NO es seguridad
   * real; la autenticación robusta requiere el backend. Se audita y se documenta,
   * y no se amplía el alcance de esta entrega a un rediseño criptográfico.
   */
  password: string
  rol: PlatformRole
  status: 'activo' | 'inactivo'
  /** Primer acceso correcto de esta persona al portal Owner. */
  firstLoginAt?: string
  /** Último acceso correcto al portal Owner. */
  lastLoginAt?: string
  createdAt: string
  updatedAt: string
}

/**
 * ESTADO COMERCIAL de una empresa (lo decide el Owner), SEPARADO del estado
 * operativo `Tenant.status` que consume la aplicación de la empresa.
 *
 *   trial     → en prueba
 *   active    → servicio contratado y al día
 *   suspended → servicio suspendido por el Owner
 *
 * Son tres y no diez a propósito. `Tenant.status` se mantiene como ESPEJO
 * (prueba/activa/suspendida) para que el bloqueo de acceso que ya existe
 * (`lib/company.isCompanyBlocked`) siga funcionando sin una segunda regla paralela.
 */
export type CompanyCommercialStatus = 'trial' | 'active' | 'suspended'

/** Modo de facturación. Hoy solo se implementa `per_route`; el resto es extensión. */
export type BillingMode = 'per_route' | 'fixed'

/** Estado de un cobro de RutaCash a una empresa. NO tiene NADA que ver con Caja. */
export type SaaSPaymentStatus = 'pending' | 'paid' | 'overdue'

/**
 * FICHA DE CONTROL de una empresa cliente. Es TODO lo que el Owner puede saber.
 * Cualquier campo que se añada aquí debe superar una pregunta: ¿es estructural o
 * comercial? Si describe la operación interna del cliente, no entra.
 */
export interface CompanyControlRecord {
  /** Mismo id que el `Tenant`: es la misma empresa vista desde el plano de control. */
  companyId: string
  nombre: string
  /** NIT / identificación fiscal. Dato comercial, no operativo. */
  identificacion?: string
  contacto?: string
  contactoEmail?: string
  /** Fecha de ALTA de la empresa en RutaCash. */
  createdAt: string
  /**
   * PRIMER INGRESO de la empresa al producto: el primer login correcto de
   * CUALQUIER usuario del tenant. Decisión documentada en
   * docs/ARQUITECTURA_OWNER_SUPERADMIN_2026-09.md (apartado U).
   */
  firstLoginAt?: string
  /** ÚLTIMO ingreso correcto de cualquier usuario del tenant. */
  lastLoginAt?: string
  status: CompanyCommercialStatus
  /** Rutas EXISTENTES de la empresa (cualquier estado). Informativo. */
  routeCount: number
  /** Rutas FACTURABLES según la regla comercial (ver `billing.ts`). */
  billableRouteCount: number
  billingMode: BillingMode
  /** Tarifa. En `per_route` es el precio por ruta facturable; en `fixed`, el total. */
  billingRate: number
  nextBillingDate?: string
  paymentStatus: SaaSPaymentStatus
  updatedAt: string
}

/** Cobro de RutaCash a una empresa. Módulo comercial simple, no contabilidad. */
export interface SaaSPayment {
  id: string
  companyId: string
  /** Periodo facturado en formato yyyy-MM (p. ej. '2026-09'). */
  periodo: string
  valor: number
  /** Fecha esperada de pago (yyyy-MM-dd). */
  fechaEsperada: string
  /** Fecha real de pago (yyyy-MM-dd). Ausente mientras no se haya pagado. */
  fechaPagada?: string
  status: SaaSPaymentStatus
  nota?: string
  createdAt: string
  updatedAt: string
}

/**
 * EVENTOS DE CONTROL SaaS. Son ESTRUCTURALES y COMERCIALES, jamás operativos.
 *
 * Lo que NUNCA puede llegar aquí, por decisión explícita: PAYMENT del cliente
 * final, SALE, CLIENT_CREATED, COLLECTION, EXPENSE y cualquier otro hecho de la
 * operación diaria de la empresa. Un cobro de RutaCash a su cliente (empresa) y un
 * pago de un cliente final a la empresa son cosas distintas y no comparten canal.
 */
export type ControlEventType =
  | 'COMPANY_CREATED'
  | 'COMPANY_ACTIVATED'
  | 'COMPANY_SUSPENDED'
  | 'FIRST_LOGIN'
  | 'LOGIN'
  | 'ROUTE_CREATED'
  | 'ROUTE_DEACTIVATED'
  | 'ROUTE_DELETED'
  | 'BILLING_UPDATED'
  | 'PAYMENT_REGISTERED'

export interface ControlEvent {
  id: string
  companyId: string
  type: ControlEventType
  /** Instante ISO del hecho. */
  at: string
  /** Descripción corta y legible. Nunca incluye datos operativos. */
  detail?: string
}

/** Etiquetas legibles del estado comercial (UI del portal Owner). */
export const COMMERCIAL_STATUS_LABEL: Record<CompanyCommercialStatus, string> = {
  trial: 'Prueba',
  active: 'Activa',
  suspended: 'Suspendida',
}

/** Etiquetas legibles del estado de cobro. */
export const SAAS_PAYMENT_STATUS_LABEL: Record<SaaSPaymentStatus, string> = {
  pending: 'Pendiente',
  paid: 'Pagado',
  overdue: 'Vencido',
}

/** Etiquetas legibles del evento de control (historial de la ficha de empresa). */
export const CONTROL_EVENT_LABEL: Record<ControlEventType, string> = {
  COMPANY_CREATED: 'Empresa creada',
  COMPANY_ACTIVATED: 'Servicio reactivado',
  COMPANY_SUSPENDED: 'Servicio suspendido',
  FIRST_LOGIN: 'Primer acceso',
  LOGIN: 'Acceso',
  ROUTE_CREATED: 'Ruta creada',
  ROUTE_DEACTIVATED: 'Ruta desactivada',
  ROUTE_DELETED: 'Ruta eliminada',
  BILLING_UPDATED: 'Datos comerciales actualizados',
  PAYMENT_REGISTERED: 'Cobro registrado',
}
