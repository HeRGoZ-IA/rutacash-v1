// ============================================================
// RUTACASH — RESTABLECIMIENTO DE FÁBRICA
// ------------------------------------------------------------
// Devuelve la instalación al estado de una aplicación recién abierta: CERO REAL.
//
// QUÉ BORRA, sin excepciones:
//   · IndexedDB completa (Dexie): platformUsers, tenants, users, offices, routes,
//     clients, sales, installments, payments, expenses, capital, transfers,
//     withdrawals, settlements, auditoría, cobros SaaS, eventos de control… todas.
//   · localStorage y sessionStorage con prefijo `rutacash-` / `rutacash_`, lo que
//     incluye AMBAS sesiones: la de empresa (`rutacash-auth`) y la de plataforma
//     (`rutacash-owner-auth`).
//   · Cache Storage y Service Workers del dominio.
//
// SÍ BORRA LOS OWNERS, y es intencionado. Tras el restablecimiento no queda Helmer,
// ni Andrés, ni ninguna cuenta de plataforma: la aplicación vuelve a `/owner/login`
// mostrando «Crear primer Owner». Un reset que dejara viva la cuenta raíz no sería un
// reset, sería un borrado de datos con dueño.
//
// QUIÉN PUEDE EJECUTARLO: únicamente un Owner autenticado, desde el portal de
// plataforma. Ningún rol de empresa —tampoco el Super Admin— tiene acceso a esta
// función; no es una cuestión de que el botón esté oculto: el portal de empresa no
// importa este módulo, y hay una prueba que lo verifica.
// ============================================================
import { db } from '@/lib/db'
import { ENABLE_FACTORY_RESET } from '@/lib/featureFlags'

// Prefijos de claves locales que pertenecen a RutaCash (Zustand persist y demás).
// Cubre `rutacash-auth`, `rutacash-owner-auth`, `rutacash-collector-route`, etc.
// Solo se borran claves con estos prefijos para NO tocar datos de otros sistemas
// que compartan el mismo origen.
const RUTACASH_KEY_PREFIXES = ['rutacash-', 'rutacash_']

/** Destino tras el borrado: la puerta de la plataforma, nunca la de empresas. */
export const POST_RESET_PATH = '/owner/login'

function clearStorageByPrefix(storage: Storage) {
  try {
    const toRemove: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i)
      if (k && RUTACASH_KEY_PREFIXES.some(p => k.startsWith(p))) toRemove.push(k)
    }
    for (const k of toRemove) storage.removeItem(k)
  } catch { /* almacenamiento no disponible: se ignora */ }
}

/**
 * Borra TODO lo que RutaCash controla en este navegador. Cada paso va protegido con
 * try/catch para que un fallo aislado (por ejemplo, Cache Storage no disponible) no
 * deje la aplicación a medio borrar y sin salida.
 *
 * No navega: el destino lo decide quien la invoca (ver `factoryResetAndRestart`).
 */
export async function wipeLocalInstallation(): Promise<void> {
  // 1) Base de datos completa. `db.delete()` elimina TODAS las tablas de una vez, de
  //    modo que cualquier tabla futura queda cubierta sin tocar este archivo.
  try { await db.delete() } catch { /* noop */ }

  // 2) localStorage / sessionStorage: ambas sesiones caen por prefijo.
  clearStorageByPrefix(window.localStorage)
  clearStorageByPrefix(window.sessionStorage)

  // 3) Cache Storage del dominio (si existe).
  try {
    if ('caches' in window) {
      const names = await caches.keys()
      await Promise.all(names.map(n => caches.delete(n)))
    }
  } catch { /* noop */ }

  // 4) Service Workers registrados en el dominio (si existen).
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map(r => r.unregister()))
    }
  } catch { /* noop */ }
}

/**
 * Restablecimiento completo: borra y reinicia la aplicación en `/owner/login`.
 *
 * La navegación es una RECARGA DURA (`location.replace`) y no una navegación de
 * React Router: tras borrar la base, los stores en memoria y las conexiones Dexie
 * abiertas quedan apuntando a algo que ya no existe. Recargar el documento es la
 * única forma limpia de volver al estado inicial de verdad.
 *
 * Devuelve `false` si el interruptor está apagado: la función no puede ejecutarse
 * por accidente cuando la herramienta se retire.
 */
export async function factoryResetAndRestart(): Promise<boolean> {
  if (!ENABLE_FACTORY_RESET) return false
  await wipeLocalInstallation()
  location.replace(POST_RESET_PATH)
  return true
}
