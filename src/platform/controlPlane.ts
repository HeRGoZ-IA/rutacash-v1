// ============================================================
// RUTACASH — REPOSITORIO DEL PLANO DE CONTROL SaaS
// ------------------------------------------------------------
// Frontera explícita entre "lo que el Owner necesita saber" y "dónde está guardado".
// Todo el portal Owner habla con esta interfaz y nunca con la base directamente.
//
// POR QUÉ EXISTE ESTA ABSTRACCIÓN
// Hoy RutaCash es local-first: cada navegador tiene su propio IndexedDB y NO hay
// servidor. Eso significa, sin adornos, que el Owner NO puede ver desde su equipo
// lo que ocurre en el equipo de un cliente. No se simula lo contrario: se aísla el
// acceso a datos detrás de `SaaSControlPlane` para que el día que exista backend
// baste con escribir otra implementación (`HttpControlPlane`) y cambiar el valor por
// defecto. Contrato mínimo del servidor:
// docs/CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md.
//
// SEPARACIÓN DE BASES: las tablas del plano de control (`platformUsers`,
// `companyControl`, `saasPayments`, `controlEvents`) son las ÚNICAS que este módulo
// escribe. Lee además `routes` (para contar) y `users`/`tenants`/`expenseCategories`
// solo en el alta de empresa. Ninguna entidad operativa —clientes, ventas, pagos,
// cartera, caja, documentos— se toca desde aquí, ni siquiera para leer.
// ============================================================
import { db } from '@/lib/db'
import type {
  CompanyControlRecord, ControlEvent, ControlEventType, PlatformUser, SaaSPayment,
} from '@/platform/types'

// ------------------------------------------------------------
// Contrato de base de datos (estructural, para poder inyectar en pruebas)
// ------------------------------------------------------------
interface ReadWriteTable<T> {
  add(item: T): Promise<unknown>
  get(key: string): Promise<T | undefined>
  update(key: string, changes: Partial<T>): Promise<number>
  toArray(): Promise<T[]>
  where(index: string): {
    equals(key: string): {
      toArray(): Promise<T[]>
      first(): Promise<T | undefined>
      count(): Promise<number>
    }
  }
}

/**
 * Superficie mínima que necesita el plano de control. Nótese lo que NO aparece:
 * `clients`, `sales`, `payments`, `installments`, `cashboxMovements`,
 * `weeklySettlements`… El Owner no puede leerlas ni por accidente.
 */
export interface ControlPlaneDatabase {
  platformUsers: ReadWriteTable<PlatformUser>
  companyControl: ReadWriteTable<CompanyControlRecord>
  saasPayments: ReadWriteTable<SaaSPayment>
  controlEvents: ReadWriteTable<ControlEvent>
  /** Solo LECTURA y solo para CONTAR rutas. Nunca se leen datos de la ruta. */
  routes: { where(index: string): { equals(key: string): { toArray(): Promise<{ id: string; status: string }[]> } } }
}

// ------------------------------------------------------------
// Interfaz pública del plano de control
// ------------------------------------------------------------
/**
 * Operaciones que el portal Owner necesita. Es el contrato que un backend futuro
 * deberá cumplir tal cual: cada método corresponde a una operación conceptual del
 * documento de requisitos.
 */
export interface SaaSControlPlane {
  // --- Empresas ---
  listCompanies(): Promise<CompanyControlRecord[]>
  getCompany(companyId: string): Promise<CompanyControlRecord | null>
  putCompany(record: CompanyControlRecord): Promise<void>
  updateCompany(companyId: string, changes: Partial<CompanyControlRecord>): Promise<void>
  // --- Telemetría de acceso y métricas estructurales ---
  countRoutes(companyId: string): Promise<{ routeCount: number; billableRouteCount: number }>
  // --- Cobros ---
  listPayments(companyId?: string): Promise<SaaSPayment[]>
  addPayment(payment: SaaSPayment): Promise<void>
  updatePayment(paymentId: string, changes: Partial<SaaSPayment>): Promise<void>
  // --- Eventos de control ---
  listEvents(companyId: string): Promise<ControlEvent[]>
  addEvent(event: ControlEvent): Promise<void>
  // --- Usuarios de plataforma (Owner) ---
  listOwners(): Promise<PlatformUser[]>
  getOwnerByEmail(email: string): Promise<PlatformUser | null>
  addOwner(owner: PlatformUser): Promise<void>
  updateOwner(ownerId: string, changes: Partial<PlatformUser>): Promise<void>
}

// ------------------------------------------------------------
// Implementación LOCAL (desarrollo y operación actual sin backend)
// ------------------------------------------------------------
import { computeRouteMetrics } from '@/platform/billing'
import { normalizeEmail } from '@/lib/email'

/**
 * Implementación sobre la base local. Es la única que existe hoy y su alcance es
 * EL NAVEGADOR ACTUAL: lo que escriba otro dispositivo no llega aquí. La UI del
 * Owner lo declara de forma visible; este código no lo disimula.
 */
export class LocalControlPlane implements SaaSControlPlane {
  constructor(private readonly database: ControlPlaneDatabase) {}

  async listCompanies(): Promise<CompanyControlRecord[]> {
    const rows = await this.database.companyControl.toArray()
    return rows.sort((a, b) => a.nombre.localeCompare(b.nombre))
  }

  async getCompany(companyId: string): Promise<CompanyControlRecord | null> {
    return (await this.database.companyControl.get(companyId)) ?? null
  }

  async putCompany(record: CompanyControlRecord): Promise<void> {
    await this.database.companyControl.add(record)
  }

  async updateCompany(companyId: string, changes: Partial<CompanyControlRecord>): Promise<void> {
    await this.database.companyControl.update(companyId, changes)
  }

  async countRoutes(companyId: string): Promise<{ routeCount: number; billableRouteCount: number }> {
    const routes = await this.database.routes.where('tenantId').equals(companyId).toArray()
    return computeRouteMetrics(routes)
  }

  async listPayments(companyId?: string): Promise<SaaSPayment[]> {
    const rows = companyId
      ? await this.database.saasPayments.where('companyId').equals(companyId).toArray()
      : await this.database.saasPayments.toArray()
    // Más recientes primero: el período es la clave natural de orden.
    return rows.sort((a, b) => b.periodo.localeCompare(a.periodo))
  }

  async addPayment(payment: SaaSPayment): Promise<void> {
    await this.database.saasPayments.add(payment)
  }

  async updatePayment(paymentId: string, changes: Partial<SaaSPayment>): Promise<void> {
    await this.database.saasPayments.update(paymentId, changes)
  }

  async listEvents(companyId: string): Promise<ControlEvent[]> {
    const rows = await this.database.controlEvents.where('companyId').equals(companyId).toArray()
    return rows.sort((a, b) => b.at.localeCompare(a.at))
  }

  async addEvent(event: ControlEvent): Promise<void> {
    await this.database.controlEvents.add(event)
  }

  async listOwners(): Promise<PlatformUser[]> {
    return this.database.platformUsers.toArray()
  }

  async getOwnerByEmail(email: string): Promise<PlatformUser | null> {
    const wanted = normalizeEmail(email)
    const rows = await this.database.platformUsers.toArray()
    return rows.find(o => normalizeEmail(o.email) === wanted) ?? null
  }

  async addOwner(owner: PlatformUser): Promise<void> {
    await this.database.platformUsers.add(owner)
  }

  async updateOwner(ownerId: string, changes: Partial<PlatformUser>): Promise<void> {
    await this.database.platformUsers.update(ownerId, changes)
  }
}

/** Plano de control por defecto de la aplicación (base local del navegador). */
export const controlPlane: SaaSControlPlane = new LocalControlPlane(
  db as unknown as ControlPlaneDatabase,
)

/** Construye un plano de control sobre una base inyectada (pruebas). */
export function controlPlaneOn(database: ControlPlaneDatabase): SaaSControlPlane {
  return new LocalControlPlane(database)
}

/**
 * ¿Puede este despliegue ver cambios hechos en OTRO dispositivo?
 *
 * Hoy la respuesta es NO y está escrita aquí, en un solo sitio, para que la UI la
 * muestre sin que nadie tenga que acordarse de actualizar un texto suelto. Cuando
 * exista backend compartido, esta constante pasa a `true` junto con la nueva
 * implementación de `SaaSControlPlane` — y no antes.
 */
export const CONTROL_PLANE_IS_SHARED = false

/** Aviso corto y honesto para la interfaz del Owner. */
export const CONTROL_PLANE_SCOPE_NOTICE =
  'Datos de este dispositivo. Sin servidor compartido, los cambios hechos desde otros equipos no se reflejan aquí.'

/** Tipos de evento que el plano de control acepta. Cualquier otro se rechaza. */
export const ALLOWED_CONTROL_EVENTS: readonly ControlEventType[] = [
  'COMPANY_CREATED', 'COMPANY_ACTIVATED', 'COMPANY_SUSPENDED',
  'FIRST_LOGIN', 'LOGIN',
  'ROUTE_CREATED', 'ROUTE_DEACTIVATED', 'ROUTE_DELETED',
  'BILLING_UPDATED', 'PAYMENT_REGISTERED',
] as const
