// PUENTE de `src/services/platformBootstrapService.ts` (CLEAN) para ADEX Online.
//
// En CLEAN la instalación es el navegador: el primer Owner se crea en `/owner/login` y
// los siguientes desde Configuración. En ADEX Online la plataforma es el SERVIDOR y ya
// tiene dueño: los Owners se dan de alta con el procedimiento del administrador de la base
// (`saas/scripts/owner-register.ts`), que ejecuta el propietario en su equipo. Por eso:
//   · la entrada `/owner/login` siempre muestra el login (nunca «Crear primer Owner»: una
//     pantalla pública que creara cuentas de plataforma sería un agujero);
//   · «Nuevo Owner» explica el procedimiento en vez de pedir una contraseña.
//
// Los tipos son los de CLEAN (misma forma); se declaran aquí para no compilar el servicio
// original, que depende de la base local del navegador.

import type { PlatformUser } from '@clean/platform/types';

export const PLATFORM_TENANT_ID = 'platform';
export const MIN_BOOTSTRAP_PASSWORD_LENGTH = 12;

export type InstallationStatus = 'empty' | 'orphaned' | 'ready';
export interface InstallationState {
  status: InstallationStatus;
  initialized: boolean;
  ownerCount: number;
  userCount: number;
  superadminCount: number;
  companyCount: number;
  existingAdminEmails: string[];
  existingCompanyNames: string[];
}
export interface FirstOwnerInput { nombre: string; email: string; password: string; confirmPassword: string }
export type BootstrapRejectionCode = 'ALREADY_INITIALIZED' | 'INVALID_NAME' | 'INVALID_EMAIL' | 'WEAK_PASSWORD' | 'PASSWORD_MISMATCH' | 'EMAIL_TAKEN' | 'WRITE_FAILED';
export interface BootstrapSuccess { ok: true; owner: PlatformUser; recovered: boolean }
export interface BootstrapFailure { ok: false; code: BootstrapRejectionCode; message: string }
export type BootstrapResult = BootstrapSuccess | BootstrapFailure;

/** El servidor Owner es la instalación y ya está inicializado. */
export async function getInstallationState(): Promise<InstallationState> {
  return { status: 'ready', initialized: true, ownerCount: 1, userCount: 0, superadminCount: 0, companyCount: 0, existingAdminEmails: [], existingCompanyNames: [] };
}

export async function isPlatformInitialized(): Promise<boolean> { return true; }

export const OWNER_REGISTRATION_NOTICE =
  'En ADEX Online los Owners se dan de alta en el servidor con el procedimiento del administrador (owner-register), nunca desde el navegador.';

const refuse = async (): Promise<BootstrapResult> => ({ ok: false, code: 'ALREADY_INITIALIZED', message: OWNER_REGISTRATION_NOTICE });

export async function createFirstOwner(_input: FirstOwnerInput): Promise<BootstrapResult> { return refuse(); }
export async function createAdditionalOwner(_actor: PlatformUser, _input: FirstOwnerInput): Promise<BootstrapResult> { return refuse(); }
