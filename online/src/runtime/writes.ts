// TRADUCCIÓN DE ESCRITURAS de las pantallas de CLEAN a comandos de la API.
//
// Algunas pantallas originales escriben directamente sobre una tabla (p. ej.
// `db.routes.update(id, { status })` al activar/desactivar una ruta). Para conservar la
// pantalla intacta, el puente de `db` consulta esta LISTA BLANCA: solo las escrituras
// cuya forma coincide EXACTAMENTE con un comando del servidor se envían a la API; todas
// las demás siguen bloqueadas (`OnlineWriteBlocked`). Nada se aplica en el dispositivo:
// el resultado se ve cuando la proyección vuelve a leer del servidor.

import { plain } from './commands.ts';
import { OnlineWriteBlocked, ServerGap } from './projection.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Changes = Record<string, any>;
type Adapter = {
  add?: (row: Changes) => Promise<unknown>;
  update?: (id: string, changes: Changes) => Promise<unknown>;
  delete?: (id: string) => Promise<unknown>;
};

/** ¿Los cambios solo tocan `allowed` (más el sello `updatedAt`, que pone el servidor)? */
function only(changes: Changes, allowed: string[]): boolean {
  return Object.keys(changes).every((k) => k === 'updatedAt' || allowed.includes(k));
}

const ADAPTERS: Record<string, Adapter> = {
  routes: {
    // Activar / desactivar ruta (RoutesPage.toggleStatus).
    update: async (id, changes) => {
      if (!only(changes, ['status'])) throw new OnlineWriteBlocked('routes', 'update');
      return plain('POST', `/v1/routes/${id}/status`, { status: changes['status'] });
    },
    // Eliminar ruta (solo Super Admin; el servidor rechaza si tiene historia: HAS_HISTORY).
    delete: (id) => plain('POST', `/v1/routes/${id}/delete`, {}),
  },
};

export function registerWrites(table: string, adapter: Adapter): void {
  ADAPTERS[table] = { ...ADAPTERS[table], ...adapter };
}

export function writeAdapter<K extends keyof Adapter>(table: string, op: K): Adapter[K] | undefined {
  return ADAPTERS[table]?.[op];
}

// ---------------------------------------------------------------------------
// Tablas del libro local de CLEAN que siguen sin equivalente en el servidor (Caja socios,
// auditoría local, ajustes de pago…): ni se leen ni se cuentan. Los registros de capital
// (capital, retiros, transferencias, custodia) ya son vistas del libro central
// (runtime/capitalRecords.ts) y se cuentan con normalidad.
// ---------------------------------------------------------------------------
export async function gapCount(table: string, _key: string, _value: unknown): Promise<number> {
  throw new ServerGap(table);
}
