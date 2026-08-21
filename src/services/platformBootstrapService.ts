// ============================================================
// RUTACASH — ARRANQUE DE LA PLATAFORMA (INSTALACIÓN DESDE CERO)
// ------------------------------------------------------------
// Una instalación LIMPIA nace COMPLETAMENTE VACÍA: sin usuarios, sin empresas, sin
// rutas y sin ninguna credencial conocida. La primera acción del sistema es que una
// persona real cree su propio Super Admin eligiendo su propia contraseña.
//
// REGLA INNEGOCIABLE: RutaCash NUNCA crea silenciosamente una cuenta Super Admin con
// una contraseña conocida — ni al arrancar, ni al migrar, ni al recuperar, ni al
// actualizar. Toda cuenta raíz nace de una acción humana explícita.
//
// NIVELES DEL MODELO
//   · Super Admin  → nivel PLATAFORMA. No pertenece a ninguna empresa: lleva el
//                    tenantId centinela `PLATFORM_TENANT_ID`, que NO corresponde a
//                    ninguna fila de `tenants`. Puede existir con cero empresas.
//   · Admin / Supervisor / Cobrador / Secretario / Socio → nivel EMPRESA.
// ============================================================
import { db } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { nowISO } from '@/lib/formatters'
import { normalizeEmail } from '@/services/authService'
import type { Tenant, User } from '@/models/types'

/**
 * tenantId centinela del Super Admin. NO existe como fila en `tenants`: expresa
 * "pertenece a la plataforma, no a una empresa". Ver DEUDA DE MODELO más abajo.
 */
export const PLATFORM_TENANT_ID = 'platform'

// ------------------------------------------------------------
// DEUDA DE MODELO (documentada, no corregida aquí)
// ------------------------------------------------------------
// `User.tenantId` es obligatorio (`string`), así que un Super Admin —que es de
// plataforma y no de empresa— se ve forzado a llevar un valor. Hoy se resuelve con
// el centinela 'platform', y funciona porque ningún flujo hace
// `tenants.get(user.tenantId)` para un superadmin (`authenticateUser` y
// `revalidateSession` lo excluyen explícitamente).
//
// Corrección mínima futura, cuando toque tocar el esquema:
//   tenantId?: string        // ausente = usuario de plataforma
//   scope: 'platform' | 'tenant'
// Mientras tanto, el centinela queda centralizado en esta constante para que el día
// que se cambie haya un único punto que tocar, y no cadenas 'platform' dispersas.

// ------------------------------------------------------------
// Contrato de base de datos
// ------------------------------------------------------------
export interface PlatformDatabase {
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
  /** Base virgen: sin usuarios. Debe crearse el primer Super Admin. */
  | 'empty'
  /** INCONSISTENTE: hay usuarios/datos pero NINGÚN Super Admin. Requiere recuperación. */
  | 'orphaned'
  /** Instalación operativa: existe al menos un Super Admin. */
  | 'ready'

export interface InstallationState {
  status: InstallationStatus
  /** true si existe al menos un Super Admin (estado B — inicializada). */
  initialized: boolean
  userCount: number
  superadminCount: number
  companyCount: number
  /** Resumen de lo que hay, para la pantalla de recuperación. */
  existingAdminEmails: string[]
  existingCompanyNames: string[]
}

/** ¿La plataforma tiene dueño? Estado B ⇔ existe al menos un Super Admin. */
export async function isPlatformInitialized(database: PlatformDatabase = db): Promise<boolean> {
  const users = await database.users.toArray()
  return users.some(u => u.rol === 'superadmin')
}

/**
 * Estado completo de la instalación. Distingue las tres situaciones reales:
 * virgen, huérfana (datos sin acceso raíz) y lista.
 */
export async function getInstallationState(database: PlatformDatabase = db): Promise<InstallationState> {
  const [users, tenants] = await Promise.all([database.users.toArray(), database.tenants.toArray()])
  const superadmins = users.filter(u => u.rol === 'superadmin')
  const companies = tenants.filter(t => t.id !== PLATFORM_TENANT_ID)

  const status: InstallationStatus =
    superadmins.length > 0 ? 'ready' :
    users.length === 0 && companies.length === 0 ? 'empty' : 'orphaned'

  return {
    status,
    initialized: superadmins.length > 0,
    userCount: users.length,
    superadminCount: superadmins.length,
    companyCount: companies.length,
    existingAdminEmails: users.filter(u => u.rol === 'admin').map(u => u.email),
    existingCompanyNames: companies.map(t => t.nombre),
  }
}

// ------------------------------------------------------------
// Creación del primer Super Admin
// ------------------------------------------------------------
export interface FirstSuperAdminInput {
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
  user: User
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
  ALREADY_INITIALIZED: 'Esta instalación ya tiene un Super Admin. Inicia sesión con esa cuenta.',
  INVALID_NAME: 'Escribe el nombre de la persona responsable.',
  INVALID_EMAIL: 'Escribe un correo electrónico válido.',
  WEAK_PASSWORD: 'La contraseña debe tener al menos 8 caracteres.',
  PASSWORD_MISMATCH: 'La contraseña y su confirmación no coinciden.',
  EMAIL_TAKEN: 'Ya existe un usuario con ese correo.',
  WRITE_FAILED: 'No se pudo crear la cuenta. No se guardó ningún cambio.',
}

const fail = (code: BootstrapRejectionCode): BootstrapFailure => ({ ok: false, code, message: MESSAGES[code] })

/** Rechazo controlado dentro de la transacción (aborta sin escribir). */
class BootstrapRejection extends Error {
  constructor(public code: BootstrapRejectionCode) { super(MESSAGES[code]); this.name = 'BootstrapRejection' }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Longitud mínima de la contraseña que el propio dueño elige. */
export const MIN_BOOTSTRAP_PASSWORD_LENGTH = 8

/**
 * Crea el PRIMER Super Admin de la instalación. Es la única operación pública que
 * puede crear una cuenta raíz, y solo funciona mientras no exista ninguna.
 *
 * · La contraseña la elige la persona: es DEFINITIVA. No se marca
 *   `mustChangePassword` (a diferencia de las cuentas que un superior crea con
 *   clave temporal, que sí lo llevan).
 * · La comprobación "no existe Super Admin" se REPITE dentro de la transacción, de
 *   modo que dos pestañas/dispositivos compitiendo no puedan crear dos raíces. El
 *   mismo patrón sirve tal cual cuando esto pase a un backend: la condición se
 *   verifica en el mismo ámbito atómico que la escritura.
 * · Sobre una instalación HUÉRFANA (datos sin Super Admin) actúa como recuperación:
 *   crea la cuenta raíz y NO toca ningún usuario, empresa ni dato existente.
 */
export async function createFirstSuperAdmin(
  input: FirstSuperAdminInput,
  database: PlatformDatabase = db,
): Promise<BootstrapResult> {
  const nombre = input.nombre?.trim() ?? ''
  const email = normalizeEmail(input.email ?? '')
  const password = input.password ?? ''

  if (nombre.length < 2) return fail('INVALID_NAME')
  if (!EMAIL_RE.test(email)) return fail('INVALID_EMAIL')
  if (password.length < MIN_BOOTSTRAP_PASSWORD_LENGTH) return fail('WEAK_PASSWORD')
  if (password !== input.confirmPassword) return fail('PASSWORD_MISMATCH')

  try {
    return await database.transaction('rw', [database.users], async () => {
      // RE-COMPROBACIÓN DENTRO DE LA TRANSACCIÓN: es la que cuenta.
      const users = await database.users.toArray()
      if (users.some(u => u.rol === 'superadmin')) throw new BootstrapRejection('ALREADY_INITIALIZED')
      if (users.some(u => normalizeEmail(u.email) === email)) throw new BootstrapRejection('EMAIL_TAKEN')

      const recovered = users.length > 0

      const user: User = {
        id: generateId(),
        tenantId: PLATFORM_TENANT_ID,
        nombre,
        email,
        password,
        rol: 'superadmin',
        status: 'activo',
        // Contraseña elegida por su dueño: es definitiva, no temporal.
        mustChangePassword: false,
        createdAt: nowISO(),
        updatedAt: nowISO(),
      }
      await database.users.add(user)

      const result: BootstrapSuccess = { ok: true, user, recovered }
      return result
    })
  } catch (err) {
    if (err instanceof BootstrapRejection) return { ok: false, code: err.code, message: err.message }
    return fail('WRITE_FAILED')
  }
}
