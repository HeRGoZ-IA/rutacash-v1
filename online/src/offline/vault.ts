// ALMACÉN LOCAL DEL MODO SIN CONEXIÓN (Ronda 62). IndexedDB propia (`adex-offline`), CIFRADA.
//
// Qué guarda (nada más):
//   · `keys`      — la llave AES-GCM de la membresía (la entrega el servidor, `POST /v1/offline/key`),
//                   importada como NO EXTRAÍBLE: el código de la página puede usarla, nadie la exporta.
//   · `snapshots` — copia de CONSULTA de lo último que el servidor mostró (ruta, clientes, créditos,
//                   cuotas…), por membresía. Sirve solo para consultar sin internet: nunca para sumar
//                   saldos ni decidir nada.
//   · `queue`     — operaciones capturadas sin conexión, pendientes de que el servidor las confirme.
// Contenido CIFRADO con la llave de la membresía. En claro solo lo imprescindible para no perder
// nada y avisar: id de operación, identidad, membresía, empresa, hora de captura y estado.
//
// Confidencialidad frente a conservación (cierre de sesión): se borran la llave y la copia de
// consulta; los pendientes QUEDAN cifrados. Otra persona en el mismo dispositivo no puede leerlos
// (el servidor solo entrega la llave a esa misma membresía); al volver a entrar esa persona, con
// internet, se recupera la llave y se envían.
//
// Versiones: el esquema solo crece (nunca se borra un almacén al actualizar) y cada registro lleva
// `v`. Una versión nueva de la aplicación lee los registros de las anteriores.

const DB_NAME = 'adex-offline';
const DB_VERSION = 1;
const STORES = ['keys', 'snapshots', 'queue'] as const;

export interface Scope {
  identityId: string;
  membershipId: string;
  companyId: string;
}

interface KeyRecord { v: 1; identityId: string; membershipId: string; key: CryptoKey; savedAt: string }
interface SealedRecord { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }
interface SnapshotRecord extends SealedRecord { v: 1; identityId: string; membershipId: string; name: string; savedAt: string }
export interface QueueRecord extends SealedRecord {
  v: 1;
  id: string;
  identityId: string;
  membershipId: string;
  companyId: string;
  capturedAt: string;
  status: string;
}

let opening: Promise<IDBDatabase | null> | null = null;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** La base local, o null si el navegador no ofrece IndexedDB (sin modo sin conexión). */
export function vault(): Promise<IDBDatabase | null> {
  opening ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        // Solo se AÑADEN almacenes: ninguna actualización borra pendientes.
        for (const s of STORES) if (!open.result.objectStoreNames.contains(s)) open.result.createObjectStore(s);
      };
      open.onsuccess = () => {
        const db = open.result;
        // Otra pestaña con una versión más nueva pide actualizar: se cierra esta conexión (se reabrirá).
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

async function tx<T>(store: (typeof STORES)[number], mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await vault();
  if (!db) throw new Error('OFFLINE_STORAGE_UNAVAILABLE');
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result: T;
    const r = fn(t.objectStore(store));
    r.onsuccess = () => { result = r.result; };
    r.onerror = () => reject(r.error);
    // Resuelve al CONFIRMARSE la transacción: lo escrito ya está en disco.
    t.oncomplete = () => resolve(result);
    t.onabort = () => reject(t.error ?? new Error('IDB_ABORTED'));
    t.onerror = () => reject(t.error ?? new Error('IDB_ERROR'));
  });
}

async function all<T>(store: (typeof STORES)[number]): Promise<T[]> {
  return tx(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

// ---------- Llave ----------

const keyId = (identityId: string, membershipId: string) => `${identityId}|${membershipId}`;

/** Importa la llave entregada por el servidor (base64, 32 bytes) como NO extraíble. */
export async function importKey(base64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error('OFFLINE_KEY_INVALID');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function saveKey(identityId: string, membershipId: string, key: CryptoKey): Promise<void> {
  const rec: KeyRecord = { v: 1, identityId, membershipId, key, savedAt: new Date().toISOString() };
  await tx('keys', 'readwrite', (s) => s.put(rec, keyId(identityId, membershipId)));
  // Pide al navegador que no desaloje estos datos por falta de espacio (Android/Chrome). Sin garantía.
  try { await navigator.storage?.persist?.(); } catch { /* opcional */ }
}

export async function loadKey(identityId: string, membershipId: string): Promise<CryptoKey | null> {
  try {
    const rec = await tx('keys', 'readonly', (s) => s.get(keyId(identityId, membershipId)) as IDBRequest<KeyRecord | undefined>);
    return rec?.key ?? null;
  } catch {
    return null;
  }
}

/** Cierre de sesión: se borran las llaves y la copia de consulta de esa identidad. Los pendientes NO. */
export async function forgetIdentity(identityId: string): Promise<void> {
  await purge((k) => k.startsWith(`${identityId}|`), (r) => r.identityId === identityId);
}

/**
 * Otra persona inicia sesión en este dispositivo sin que la anterior la cerrara: fuera las llaves y
 * copias de consulta de TODAS las demás identidades. Sus pendientes quedan cifrados (ilegibles hasta
 * que esa persona vuelva a entrar y el servidor le devuelva su llave).
 */
export async function forgetOtherIdentities(identityId: string): Promise<void> {
  await purge((k) => !k.startsWith(`${identityId}|`), (r) => r.identityId !== identityId);
}

/** Acceso perdido a una membresía (bloqueo, cambio de contexto): fuera su copia de consulta. Pendientes y llave quedan. */
export async function forgetSnapshotsOf(membershipId: string): Promise<void> {
  await purge(() => false, (r) => r.membershipId === membershipId);
}

/** Borra llaves y copias en UNA transacción (rápido al cerrar sesión). La cola nunca se toca aquí. */
async function purge(keyMatch: (k: string) => boolean, snapMatch: (r: SnapshotRecord) => boolean): Promise<void> {
  const db = await vault();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(['keys', 'snapshots'], 'readwrite');
    const ks = t.objectStore('keys').openCursor();
    ks.onsuccess = () => { const c = ks.result; if (!c) return; if (keyMatch(String(c.key))) c.delete(); c.continue(); };
    const ss = t.objectStore('snapshots').openCursor();
    ss.onsuccess = () => { const c = ss.result; if (!c) return; if (snapMatch(c.value as SnapshotRecord)) c.delete(); c.continue(); };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// ---------- Cifrado ----------

async function seal(key: CryptoKey, value: unknown): Promise<SealedRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { iv, data };
}

async function open<T>(key: CryptoKey, rec: SealedRecord): Promise<T> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.data);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

// ---------- Copia de consulta ----------

const snapId = (membershipId: string, name: string) => `${membershipId}|${name}`;

export async function putSnapshot(scope: Scope, key: CryptoKey, name: string, value: unknown): Promise<void> {
  const rec: SnapshotRecord = { v: 1, identityId: scope.identityId, membershipId: scope.membershipId, name, savedAt: new Date().toISOString(), ...(await seal(key, value)) };
  await tx('snapshots', 'readwrite', (s) => s.put(rec, snapId(scope.membershipId, name)));
}

export async function getSnapshot<T>(scope: Scope, key: CryptoKey, name: string): Promise<{ value: T; savedAt: string } | null> {
  try {
    const rec = await tx('snapshots', 'readonly', (s) => s.get(snapId(scope.membershipId, name)) as IDBRequest<SnapshotRecord | undefined>);
    if (!rec || rec.identityId !== scope.identityId) return null;
    return { value: await open<T>(key, rec), savedAt: rec.savedAt };
  } catch {
    return null;
  }
}

// ---------- Operaciones pendientes ----------

/** Guarda (o actualiza) una operación. Resuelve cuando la escritura ya está confirmada en disco. */
export async function putOperation(scope: Scope, key: CryptoKey, op: { id: string; capturedAt: string; status: string; reviewedAt?: string }): Promise<void> {
  // En claro, «reviewed» para lo ya revisado (no cuenta como pendiente de otra sesión).
  const rec: QueueRecord = { v: 1, id: op.id, identityId: scope.identityId, membershipId: scope.membershipId, companyId: scope.companyId,
    capturedAt: op.capturedAt, status: op.reviewedAt ? 'reviewed' : op.status, ...(await seal(key, op)) };
  await tx('queue', 'readwrite', (s) => s.put(rec, op.id));
}

export async function getOperation<T>(scope: Scope, key: CryptoKey, id: string): Promise<T | null> {
  const rec = await tx('queue', 'readonly', (s) => s.get(id) as IDBRequest<QueueRecord | undefined>);
  if (!rec || rec.membershipId !== scope.membershipId || rec.identityId !== scope.identityId) return null;
  return open<T>(key, rec);
}

/** Operaciones de ESTA membresía (descifradas). Un registro ilegible se conserva y se informa aparte. */
export async function listOperations<T>(scope: Scope, key: CryptoKey): Promise<{ ops: T[]; unreadable: number }> {
  const recs = (await all<QueueRecord>('queue')).filter((r) => r.membershipId === scope.membershipId && r.identityId === scope.identityId);
  const ops: T[] = [];
  let unreadable = 0;
  for (const r of recs) {
    try { ops.push(await open<T>(key, r)); } catch { unreadable++; }
  }
  return { ops, unreadable };
}

/** Pendientes guardados en este dispositivo por OTRA sesión (solo el número: su contenido está cifrado). */
export async function foreignPendingCount(identityId: string | null, statuses: readonly string[]): Promise<number> {
  try {
    return (await all<QueueRecord>('queue')).filter((r) => r.identityId !== identityId && statuses.includes(r.status)).length;
  } catch {
    return 0;
  }
}
