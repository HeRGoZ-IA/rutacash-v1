// ============================================================
// RUTACASH — ARRANQUE DE LA PLATAFORMA (INSTALACIÓN DESDE CERO)
// ------------------------------------------------------------
// Una instalación LIMPIA nace COMPLETAMENTE VACÍA: sin Owners, sin usuarios, sin
// empresas, sin rutas y sin ninguna credencial conocida. La primera acción del
// sistema es que una persona real cree su propio OWNER eligiendo su contraseña.
//
// REGLA INNEGOCIABLE: RutaCash NUNCA crea silenciosamente una cuenta raíz con una
// contraseña conocida — ni al arrancar, ni al migrar, ni al recuperar, ni al
// actualizar. Toda cuenta raíz nace de una acción humana explícita.
//
// LOS DOS NIVELES (corrección arquitectónica de esta entrega)
//   · NIVEL 1 · PLATAFORMA → OWNER. Vive en la tabla `platformUsers`. NO pertenece a
//     ninguna empresa: no tiene `tenantId` ni `authorizedRouteIds`. Administra el
//     SaaS (empresas, estado comercial, rutas facturables, cobros). Entra por
//     `/owner/login`.
//   · NIVEL 2 · EMPRESA → SUPER ADMIN y por debajo (Admin, Supervisor, Secretario,
//     Socio, Cobrador). Viven en `users` SIEMPRE con el `tenantId` de SU empresa.
//     Entran por `/login`.
//
// El Super Admin dejó de ser "plataforma": ahora es la máxima autoridad DENTRO de
// una empresa y nada más. El primer Super Admin de cada empresa lo crea el Owner al
// dar de alta la empresa (ver `platform/companyControlService.ts`).
// ============================================================
import { db } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { nowISO } from '@/lib/formatters'
import { normalizeEmail, validateEmail } from '@/lib/email'
import type { PlatformUser } from '@/platform/types'
import type { Tenant, User } from '@/models/types'

/**
 * DEUDA DE MODELO HEREDADA — centinela `tenantId` del antiguo Super Admin global.
 *
 * Antes de esta entrega el Super Admin era de plataforma y, como `User.tenantId` es
 * obligatorio, llevaba el valor centinela 'platform', que nunca correspondió a una
 * fila de `tenants`. Ese modelo ya no existe: hoy el nivel plataforma es el Owner y
 * vive en su propia tabla, sin `tenantId` de ningún tipo.
 *
 * La constante SE CONSERVA porque la migración v13 necesita reconocer a los Super
 * Admin heredados que llevan ese centinela para reubicarlos. No debe usarse para
 * crear nada nuevo: ningún usuario de `users` puede volver a nacer con este valor.
 */
export const PLATFORM_TENANT_ID = 'platform'

// ------------------------------------------------------------
// Contrato de base de datos
// ------------------------------------------------------------
export interface PlatformDatabase {
  platformUsers: {
    toArray(): Promise<PlatformUser[]>
    add(item: PlatformUser): Promise<unknown>
  }
  users: {
    toArray(): Promise<User[]>
    add(item: User): Promise<unknown>
  }
  tenants: { toArray(): Promise<Tenant[]> }
  transaction<U>(mode: 'rw', tables: any, scope: () => PromiseLike<U>): Promise<U>
}

// ------------------------------------------------------------
// Estado de la instalación
// ------------------------------------------------------------
export type InstallationStatus =
  /** Base virgen: sin Owners y sin datos. Debe crearse el primer Owner. */
  | 'empty'
  /** INCONSISTENTE: hay usuarios/empresas pero NINGÚN Owner. Requiere recuperación. */
  | 'orphaned'
  /** Instalación operativa: existe al menos un Owner. */
  | 'ready'

export interface InstallationState {
  status: InstallationStatus
  /** true si existe al menos un Owner: la plataforma tiene dueño. */
  initialized: boolean
  ownerCount: number
  /** Usuarios de EMPRESA (tabla `users`). El Owner no cuenta aquí: no es de empresa. */
  userCount: number
  superadminCount: number
  companyCount: number
  /** Resumen de lo que hay, para la pantalla de recuperación. */
  existingAdminEmails: string[]
  existingCompanyNames: string[]
}

/** ¿La plataforma tiene dueño? ⇔ existe al menos un Owner. */
export async function isPlatformInitialized(database: PlatformDatabase = db): Promise<boolean> {
  const owners = await database.platformUsers.toArray()
  return owners.length > 0
}

/**
 * Estado completo de la instalación. Distingue las tres situaciones reales:
 * virgen, huérfana (datos sin dueño de plataforma) y lista.
 */
export async function getInstallationState(database: PlatformDatabase = db): Promise<InstallationState> {
  const [owners, users, tenants] = await Promise.all([
    database.platformUsers.toArray(),
    database.users.toArray(),
    database.tenants.toArray(),
  ])
  const superadmins = users.filter(u => u.rol === 'superadmin')
  const companies = tenants.filter(t => t.id !== PLATFORM_TENANT_ID)

  const status: InstallationStatus =
    owners.length > 0 ? 'ready' :
    users.length === 0 && companies.length === 0 ? 'empty' : 'orphaned'

  return {
    status,
    initialized: owners.length > 0,
    ownerCount: owners.length,
    userCount: users.length,
    superadminCount: superadmins.length,
    companyCount: companies.length,
    existingAdminEmails: users.filter(u => u.rol === 'admin' || u.rol === 'superadmin').map(u => u.email),
    existingCompanyNames: companies.map(t => t.nombre),
  }
}

// ------------------------------------------------------------
// Creación del primer Owner
// ------------------------------------------------------------
export interface FirstOwnerInput {
  nombre: string
  email: string
  password: string
  confirmPassword: string
}

export type BootstrapRejectionCode =
  | 'ALREADY_INITIALIZED'
  | 'INVALID_NAME'
  | 'INVALID_EMAIL'
  | 'WEAK_PASSWORD'
  | 'PASSWORD_MISMATCH'
  | 'EMAIL_TAKEN'
  | 'WRITE_FAILED'

export interface BootstrapSuccess {
  ok: true
  owner: PlatformUser
  /** true si se creó sobre una instalación huérfana (recuperación). */
  recovered: boolean
}
export interface BootstrapFailure {
  ok: false
  code: BootstrapRejectionCode
  message: string
}
export type BootstrapResult = BootstrapSuccess | BootstrapFailure

const MESSAGES: Record<BootstrapRejectionCode, string> = {
  ALREADY_INITIALIZED: 'Esta instalación ya tiene un Owner. Inicia sesión con esa cuenta.',
  INVALID_NAME: 'Escribe el nombre de la persona responsable.',
  INVALID_EMAIL: 'Escribe un correo electrónico válido.',
  WEAK_PASSWORD: 'La contraseña debe tener al menos 8 caracteres.',
  PASSWORD_MISMATCH: 'La contraseña y su confirmación no coinciden.',
  EMAIL_TAKEN: 'Ya existe una cuenta con ese correo.',
  WRITE_FAILED: 'No se pudo crear la cuenta. No se guardó ningún cambio.',
}

const fail = (code: BootstrapRejectionCode): BootstrapFailure => ({ ok: false, code, message: MESSAGES[code] })

/** Rechazo controlado dentro de la transacción (aborta sin escribir). */
class BootstrapRejection extends Error {
  constructor(public code: BootstrapRejectionCode) { super(MESSAGES[code]); this.name = 'BootstrapRejection' }
}

/** Longitud mínima de la contraseña que el propio dueño elige. */
export const MIN_BOOTSTRAP_PASSWORD_LENGTH = 8

/**
 * Crea el PRIMER Owner de la instalación. Es la única operación pública que puede
 * crear una cuenta raíz, y solo funciona mientras no exista ninguna.
 *
 * · La contraseña la elige la persona: es DEFINITIVA. No se marca ningún cambio
 *   obligatorio; RutaCash ya no fuerza cambios de contraseña en el acceso.
 * · La comprobación "no existe Owner" se REPITE dentro de la transacción, de modo
 *   que dos pestañas/dispositivos compitiendo no puedan crear dos raíces. El mismo
 *   patrón sirve tal cual cuando esto pase a un backend: la condición se verifica en
 *   el mismo ámbito atómico que la escritura.
 * · Sobre una instalación HUÉRFANA (datos sin Owner) actúa como recuperación: crea
 *   la cuenta de plataforma y NO toca ningún usuario, empresa ni dato existente.
 */
export async function createFirstOwner(
  input: FirstOwnerInput,
  database: PlatformDatabase = db,
): Promise<BootstrapResult> {
  const nombre = input.nombre?.trim() ?? ''
  const password = input.password ?? ''

  if (nombre.length < 2) return fail('INVALID_NAME')
  // Validación SINTÁCTICA centralizada (`lib/email`): misma regla que el resto de la app.
  const emailCheck = validateEmail(input.email)
  if (!emailCheck.ok) return { ok: false, code: 'INVALID_EMAIL', message: emailCheck.message }
  const email = emailCheck.email
  if (password.length < MIN_BOOTSTRAP_PASSWORD_LENGTH) return fail('WEAK_PASSWORD')
  if (password !== input.confirmPassword) return fail('PASSWORD_MISMATCH')

  try {
    return await database.transaction('rw', [database.platformUsers], async () => {
      // RE-COMPROBACIÓN DENTRO DE LA TRANSACCIÓN: es la que cuenta.
      const owners = await database.platformUsers.toArray()
      if (owners.length > 0) throw new BootstrapRejection('ALREADY_INITIALIZED')
      if (owners.some(o => normalizeEmail(o.email) === email)) throw new BootstrapRejection('EMAIL_TAKEN')

      const owner: PlatformUser = {
        id: generateId(),
        nombre,
        email,
        password,
        rol: 'owner',
        status: 'activo',
        createdAt: nowISO(),
        updatedAt: nowISO(),
      }
      await database.platformUsers.add(owner)

      const result: BootstrapSuccess = { ok: true, owner, recovered: false }
      return result
    })
  } catch (err) {
    if (err instanceof BootstrapRejection) return { ok: false, code: err.code, message: err.message }
    return fail('WRITE_FAILED')
  }
}

/**
 * Crea un Owner ADICIONAL. Solo un Owner autenticado puede hacerlo: la plataforma
 * tiene más de un dueño y cada uno debe poder dar de alta al siguiente sin que nadie
 * cablee nombres en el código. NINGÚN usuario de empresa puede llegar hasta aquí.
 */
export async function createAdditionalOwner(
  actor: PlatformUser,
  input: FirstOwnerInput,
  database: PlatformDatabase = db,
): Promise<BootstrapResult> {
  if (!actor || actor.rol !== 'owner' || actor.status !== 'activo') {
    return { ok: false, code: 'WRITE_FAILED', message: 'Solo un Owner activo puede crear otro Owner.' }
  }
  const nombre = input.nombre?.trim() ?? ''
  const password = input.password ?? ''
  if (nombre.length < 2) return fail('INVALID_NAME')
  const emailCheck = validateEmail(input.email)
  if (!emailCheck.ok) return { ok: false, code: 'INVALID_EMAIL', message: emailCheck.message }
  const email = emailCheck.email
  if (password.length < MIN_BOOTSTRAP_PASSWORD_LENGTH) return fail('WEAK_PASSWORD')
  if (password !== input.confirmPassword) return fail('PASSWORD_MISMATCH')

  try {
    return await database.transaction('rw', [database.platformUsers], async () => {
      const owners = await database.platformUsers.toArray()
      if (owners.some(o => normalizeEmail(o.email) === email)) throw new BootstrapRejection('EMAIL_TAKEN')
      const owner: PlatformUser = {
        id: generateId(), nombre, email, password, rol: 'owner', status: 'activo',
        createdAt: nowISO(), updatedAt: nowISO(),
      }
      await database.platformUsers.add(owner)
      const result: BootstrapSuccess = { ok: true, owner, recovered: false }
      return result
    })
  } catch (err) {
    if (err instanceof BootstrapRejection) return { ok: false, code: err.code, message: err.message }
    return fail('WRITE_FAILED')
  }
}
