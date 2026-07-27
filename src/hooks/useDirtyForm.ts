import { useMemo } from 'react'

/**
 * Detección de "cambios sin guardar" (dirty state) para editores/modales.
 *
 * Compara un SNAPSHOT original (los datos guardados al abrir) contra el DRAFT actual
 * del formulario. Uso: guardar `original` al abrir el editor, pasar el subconjunto de
 * campos relevantes como `draft`. `isDirty` es true si difieren.
 *
 * Regla de cierre (X / Cancelar):
 *  - Si NO hay cambios → cerrar directamente (sin preguntar).
 *  - Si hay cambios    → pedir confirmación antes de descartar.
 *  - Cancelar/X NUNCA persisten; solo descartan el draft.
 */
export function shallowDirty(original: Record<string, unknown>, draft: Record<string, unknown>): boolean {
  // Comparación estable por valor. Los ARREGLOS se comparan SIN importar el orden
  // (p. ej. asignaciones de usuarios: ['u1','u2'] == ['u2','u1']). Suficiente para los
  // formularios de la app (campos primitivos + arrays de ids serializables).
  const norm = (v: unknown) => Array.isArray(v)
    ? JSON.stringify([...v].map(x => JSON.stringify(x)).sort())
    : JSON.stringify(v ?? null)
  const keys = new Set([...Object.keys(original), ...Object.keys(draft)])
  for (const k of keys) {
    if (norm(original[k]) !== norm(draft[k])) return true
  }
  return false
}

/** Hook: memoiza el estado dirty comparando original vs draft. */
export function useDirtyForm(original: Record<string, unknown> | null, draft: Record<string, unknown>): boolean {
  return useMemo(() => (original ? shallowDirty(original, draft) : false), [original, draft])
}
