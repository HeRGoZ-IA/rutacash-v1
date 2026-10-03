// ============================================================
// ORDEN DETERMINISTA DE EVENTOS
// ------------------------------------------------------------
// `createdAt` tiene resolución de milisegundos: dos registros creados en el mismo
// milisegundo empatan, y `Array.prototype.sort` los deja en el orden de entrada
// (para Dexie, el de la clave primaria: un UUID aleatorio). El desempate por `id`
// hace que el mismo conjunto de registros produzca siempre el mismo orden.
// Sin Dexie ni React.
// ============================================================

/** Cronológico ascendente por `createdAt`; desempate estable por `id`. */
export function compareByCreation(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}
