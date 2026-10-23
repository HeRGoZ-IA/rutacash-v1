// ============================================================
// Presentación de nombres (intervención post-R73, bloque C)
// ------------------------------------------------------------
// Solo formatea lo que se MUESTRA: el valor guardado, los contratos, la búsqueda, la
// auditoría y los documentos de identidad no cambian. Reglas:
//   · Solo se transforma un texto escrito TODO en mayúsculas. Si ya tiene minúsculas
//     («Joao da Silva», «McDonald») se respeta tal cual.
//   · No se inventan acentos: «JOAO» → «Joao», «JOÃO» → «João».
//   · Partículas brasileñas y españolas en minúscula salvo al principio
//     («JOAO FERREIRA DOS SANTOS» → «Joao Ferreira dos Santos»).
//   · Se conservan iniciales («J.»), guiones («ANA-MARIA» → «Ana-Maria»),
//     apóstrofos («D'AVILA» → «D'Avila»), números romanos y palabras con dígitos.
//   · Negocios: siglas (palabras sin vocales), formas societarias (LTDA, ME, EPP…) y
//     palabras con dígitos o «&» quedan en mayúsculas («MERCADINHO JK LTDA» →
//     «Mercadinho JK LTDA»).
//   · «PERSONA - NEGOCIO» (texto ingresado así): la persona como nombre y el negocio
//     como negocio. No se separa ni se guarda nada: es solo la vista.
// ============================================================

const PARTICLES = new Set([
  // portugués
  'da', 'das', 'de', 'do', 'dos', 'e',
  // español
  'del', 'la', 'las', 'los', 'y',
  // otros frecuentes en apellidos
  'di', 'du', 'van', 'von', 'der',
])

const ROMAN = /^(I{1,3}|IV|V|VI{1,3}|IX|X)$/
const COMPANY_FORMS = new Set(['LTDA', 'ME', 'EPP', 'EIRELI', 'MEI', 'SA', 'S/A', 'SAS', 'CIA', 'S.A', 'S.A.', 'S.A.S', 'S.A.S.', 'LTD', 'EI'])
const LOCALE = 'pt-BR'

function hasLower(s: string): boolean {
  return s !== s.toLocaleUpperCase(LOCALE)
}

function hasLetter(s: string): boolean {
  return /\p{L}/u.test(s)
}

function capitalize(word: string): string {
  const lower = word.toLocaleLowerCase(LOCALE)
  return lower.charAt(0).toLocaleUpperCase(LOCALE) + lower.slice(1)
}

/** Palabra sin separadores: decide su forma. `first` = primera palabra del segmento. */
function formatWord(word: string, first: boolean, business: boolean): string {
  if (!hasLetter(word) || /\d/.test(word)) return word
  if (ROMAN.test(word) && !first) return word
  // Inicial: una sola letra (con o sin punto, que va aparte en el tokenizador).
  if ([...word].length === 1) {
    if (!first && !business && PARTICLES.has(word.toLocaleLowerCase(LOCALE))) return word.toLocaleLowerCase(LOCALE)
    return word
  }
  if (business) {
    if (COMPANY_FORMS.has(word)) return word
    // Sigla: sin vocales (KFC, JK, BRF) o con «&».
    if (!/[AEIOUÁÉÍÓÚÂÊÔÃÕÀÜY]/iu.test(word) || word.includes('&')) return word
  }
  const lower = word.toLocaleLowerCase(LOCALE)
  if (!first && PARTICLES.has(lower)) return lower
  // Apóstrofo interno: D'AVILA → D'Avila, O'BRIEN → O'Brien.
  const apo = word.match(/^(\p{L})(['’])(\p{L}.*)$/u)
  if (apo) return apo[1]!.toLocaleUpperCase(LOCALE) + apo[2] + capitalize(apo[3]!)
  return capitalize(word)
}

function formatSegment(text: string, business: boolean): string {
  // Separadores que se conservan: espacios, guion, barra, punto, paréntesis y coma.
  const parts = text.split(/([\s\-/.,()]+)/u)
  let first = true
  return parts.map((p) => {
    if (p === '' || /^[\s\-/.,()]+$/u.test(p)) return p
    const out = formatWord(p, first, business)
    first = false
    return out
  }).join('')
}

/** Nombre de persona para mostrar. Vacío o nulo → ''. */
export function formatPersonName(raw: string | null | undefined): string {
  if (raw == null) return ''
  const text = String(raw)
  if (!hasLetter(text) || hasLower(text)) return text
  return formatSegment(text, false)
}

/** Nombre de negocio para mostrar (conserva siglas y formas societarias). */
export function formatBusinessName(raw: string | null | undefined): string {
  if (raw == null) return ''
  const text = String(raw)
  if (!hasLetter(text) || hasLower(text)) return text
  return formatSegment(text, true)
}

/**
 * Nombre de cliente tal como se ingresó, que puede traer el negocio después de « - »
 * («NOMBRE DE PERSONA - NOMBRE DEL NEGOCIO»). Solo la vista; no separa ni guarda nada.
 */
export function formatClientName(raw: string | null | undefined): string {
  if (raw == null) return ''
  const text = String(raw)
  if (!hasLetter(text) || hasLower(text)) return text
  const sep = text.indexOf(' - ')
  if (sep < 0) return formatSegment(text, false)
  return formatSegment(text.slice(0, sep), false) + ' - ' + formatSegment(text.slice(sep + 3), true)
}
