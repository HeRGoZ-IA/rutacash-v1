// Filtro del selector con búsqueda (`components/ui/SearchSelect.tsx`), separado para
// probarlo sin React: sin distinguir mayúsculas ni acentos, primero lo que empieza
// por el texto escrito.

export interface SearchSelectOption { value: string; label: string }

/** Marcas diacríticas combinantes (se construye desde texto ASCII, sin literales invisibles). */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g')

/** Texto comparable: sin acentos, en minúsculas y con los espacios normalizados. */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Opciones que coinciden con lo escrito, ordenadas: primero las que empiezan por el
 * texto, luego las que tienen una palabra que empieza por él, y al final las que lo
 * contienen en cualquier parte. Dentro de cada grupo se respeta el orden recibido.
 */
export function filterOptions(options: SearchSelectOption[], query: string): SearchSelectOption[] {
  const q = foldText(query)
  if (!q) return options
  const starts: SearchSelectOption[] = []
  const word: SearchSelectOption[] = []
  const contains: SearchSelectOption[] = []
  for (const o of options) {
    const t = foldText(o.label)
    if (t.startsWith(q)) starts.push(o)
    else if (t.includes(` ${q}`) || t.includes(`-${q}`)) word.push(o)
    else if (t.includes(q)) contains.push(o)
  }
  return [...starts, ...word, ...contains]
}
