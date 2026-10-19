// `dexie` está PROHIBIDO en ADEX Online (DS-07: ningún libro financiero en el
// dispositivo). Cualquier módulo de CLEAN que intente abrir una base IndexedDB propia
// falla en el acto, en vez de crear en silencio un segundo libro.
//
// Los tipos (`Table`, etc.) se importan solo como tipos y desaparecen al compilar.

export default class Dexie {
  static on = { storagemutated: { subscribe() { /* sin base local */ }, unsubscribe() { /* sin base local */ } } };
  constructor() {
    throw new Error('ADEX Online no usa bases locales (Dexie/IndexedDB): los datos viven en el servidor.');
  }
}
export type Table<T = unknown> = { _t?: T };
