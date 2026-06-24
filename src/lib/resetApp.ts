import { db } from '@/lib/db'

// Prefijos de claves locales que pertenecen a RutaCash (Zustand persist y demás).
// Cubre: rutacash-auth, rutacash-collector-route, rutacash-office-filter, etc.
// Solo se borran claves con estos prefijos para NO tocar datos de otros sistemas.
const RUTACASH_KEY_PREFIXES = ['rutacash-', 'rutacash_']

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
 * Limpia TODOS los datos locales que RutaCash controla en este navegador:
 * IndexedDB (Dexie), localStorage/sessionStorage (claves rutacash-*), Cache Storage
 * y Service Workers del dominio. No borra el caché global del navegador ni datos de
 * otros sitios. Cada paso está protegido con try/catch para no dejar la app rota.
 *
 * Tras llamar a esta función conviene **recargar/redirigir** (p. ej. a /login) para
 * que la app vuelva a inicializar la semilla del modo actual (CLEAN o DEMO).
 */
export async function resetLocalAppData(): Promise<void> {
  // 1) IndexedDB (base de datos completa de RutaCash).
  try { await db.delete() } catch { /* noop */ }

  // 2) localStorage / sessionStorage (solo claves de RutaCash).
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
