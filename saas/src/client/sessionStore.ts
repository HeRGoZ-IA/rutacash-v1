// Almacenamiento de la sesión del cliente en MODO SERVIDOR (Fase 1).
//
// Diferencia con CLEAN: CLEAN guarda el `User` completo (contraseña incluida) en su
// sesión y en IndexedDB. El modo servidor guarda SOLO tokens del proveedor y el
// contexto elegido. Nunca una contraseña:
//   · `assertNoSecrets` rechaza cualquier objeto con una clave de tipo contraseña
//     antes de escribirlo (defensa en profundidad);
//   · la base es PROPIA (`adex-server-mode`): no se abre ni se toca `RutaCashDB`.

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  /** Segundos epoch. */
  expiresAt: number;
  identityId: string;
  activeMembershipId: string | null;
}

export interface SessionStore {
  load(): Promise<StoredSession | null>;
  save(s: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

const SECRET_KEY = /pass(word)?|passwd|pwd|contrase|secret/i;

export class SecretInStorageError extends Error {}

/** Lanza si `value` (a cualquier profundidad) tiene una clave que parezca un secreto. */
export function assertNoSecrets(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) throw new SecretInStorageError(`refusing to persist secret-like key ${path}.${k}`);
    assertNoSecrets(v, `${path}.${k}`);
  }
}

const ALLOWED_KEYS: readonly (keyof StoredSession)[] = ['accessToken', 'refreshToken', 'expiresAt', 'identityId', 'activeMembershipId'];

function sanitize(s: StoredSession): StoredSession {
  assertNoSecrets(s);
  // Solo los campos conocidos: nada que venga «de paso» se persiste.
  return Object.fromEntries(ALLOWED_KEYS.map((k) => [k, s[k]])) as unknown as StoredSession;
}

export class MemorySessionStore implements SessionStore {
  private value: StoredSession | null = null;
  async load() { return this.value ? { ...this.value } : null; }
  async save(s: StoredSession) { this.value = sanitize(s); }
  async clear() { this.value = null; }
}

export const SERVER_MODE_DB = 'adex-server-mode';
const STORE = 'session';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class IndexedDbSessionStore implements SessionStore {
  private readonly idb: IDBFactory;
  private readonly dbName: string;

  constructor(idb: IDBFactory = indexedDB, dbName = SERVER_MODE_DB) {
    if (dbName === 'RutaCashDB') throw new Error('server mode must never use the CLEAN local database');
    this.idb = idb;
    this.dbName = dbName;
  }

  private async open(): Promise<IDBDatabase> {
    const req = this.idb.open(this.dbName, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    return request(req);
  }

  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    try {
      const tx = db.transaction(STORE, mode);
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      const out = await request(fn(tx.objectStore(STORE)));
      await done;
      return out;
    } finally {
      db.close();
    }
  }

  async load(): Promise<StoredSession | null> {
    return ((await this.run('readonly', (s) => s.get('current'))) as StoredSession | undefined) ?? null;
  }

  async save(s: StoredSession): Promise<void> {
    const clean = sanitize(s);
    await this.run('readwrite', (st) => st.put(clean, 'current'));
  }

  async clear(): Promise<void> {
    await this.run('readwrite', (s) => s.delete('current'));
  }
}
