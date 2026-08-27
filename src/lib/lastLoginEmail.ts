// ============================================================
// RUTACASH — ÚLTIMO CORREO UTILIZADO
// ------------------------------------------------------------
// Comodidad de acceso, no un mecanismo de sesión. Se guarda ÚNICAMENTE el correo del
// último acceso correcto, para prerrellenar el campo del login. En una instalación
// limpia el dueño elige su propio correo, y si no lo recuerda no tiene forma de
// consultarlo desde la interfaz: esto lo resuelve.
//
// NO se guarda nunca: contraseña, contraseña temporal, token ni ningún otro dato.
//
// Vive en localStorage con el prefijo `rutacash-`, de modo que «Restablecer app
// limpia» (`resetLocalAppData`, que borra por prefijo) lo elimine junto al resto de
// datos locales. Cerrar sesión NO lo borra: es justo cuando hace falta.
// ============================================================
import { normalizeEmail } from '@/lib/email'

const STORAGE_KEY = 'rutacash-last-login-email'

/** Correo del último acceso correcto, o cadena vacía si no hay ninguno. */
export function getLastLoginEmail(): string {
  try {
    return normalizeEmail(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    // Almacenamiento no disponible (modo privado, permisos): no es un error.
    return ''
  }
}

/** Registra el correo tras un acceso correcto o al crear la cuenta principal. */
export function rememberLoginEmail(email: string): void {
  const normalizado = normalizeEmail(email)
  if (!normalizado) return
  try {
    window.localStorage.setItem(STORAGE_KEY, normalizado)
  } catch {
    /* almacenamiento no disponible: se ignora, es solo una comodidad */
  }
}

/** Solo para pruebas o limpiezas explícitas. */
export function forgetLastLoginEmail(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch { /* noop */ }
}

export const LAST_LOGIN_EMAIL_KEY = STORAGE_KEY
