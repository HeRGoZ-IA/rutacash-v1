// ============================================================
// RUTACASH — CORREO ELECTRÓNICO: NORMALIZACIÓN Y VALIDACIÓN
// ------------------------------------------------------------
// FUENTE ÚNICA. Toda pantalla o servicio que capture, edite, compare o busque un
// correo debe usar estas funciones. No se admite un regex propio por pantalla: eso
// fue precisamente lo que dejó pasar `111@111.1`.
//
// Alcance deliberado: validación SINTÁCTICA. No se comprueba por red que el buzón
// exista; eso exige backend y verificación por correo, y llegará con el SaaS.
// ============================================================

/** Longitudes máximas según los estándares de correo (RFC 5321). */
const MAX_TOTAL = 254
const MAX_LOCAL = 64
const MAX_LABEL = 63

/** Caracteres admitidos en la parte local (subconjunto seguro de RFC 5322). */
const LOCAL_CHARS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/
/** Etiqueta de dominio: alfanumérica, admite guiones interiores. */
const LABEL = /^[A-Za-z0-9-]+$/
/** TLD final: solo letras. */
const TLD = /^[A-Za-z]+$/

export type EmailRejectionReason =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'HAS_WHITESPACE'
  | 'AT_COUNT'
  | 'LOCAL_EMPTY'
  | 'LOCAL_TOO_LONG'
  | 'LOCAL_INVALID_CHARS'
  | 'DOMAIN_EMPTY'
  | 'DOMAIN_NO_DOT'
  | 'DOMAIN_EMPTY_LABEL'
  | 'DOMAIN_LABEL_INVALID'
  | 'DOMAIN_LABEL_HYPHEN'
  | 'DOMAIN_LABEL_TOO_LONG'
  | 'TLD_TOO_SHORT'
  | 'TLD_NOT_ALPHA'

/** Mensaje para el usuario. Explica QUÉ está mal, no solo que "es inválido". */
export const EMAIL_REJECTION_MESSAGES: Record<EmailRejectionReason, string> = {
  EMPTY: 'Escribe un correo electrónico.',
  TOO_LONG: 'El correo es demasiado largo.',
  HAS_WHITESPACE: 'El correo no puede contener espacios.',
  AT_COUNT: 'El correo debe tener exactamente una arroba (@).',
  LOCAL_EMPTY: 'Falta el nombre antes de la arroba.',
  LOCAL_TOO_LONG: 'La parte anterior a la arroba es demasiado larga.',
  LOCAL_INVALID_CHARS: 'El correo contiene caracteres no permitidos antes de la arroba.',
  DOMAIN_EMPTY: 'Falta el dominio después de la arroba.',
  DOMAIN_NO_DOT: 'El dominio debe incluir un punto (por ejemplo, empresa.com).',
  DOMAIN_EMPTY_LABEL: 'El dominio tiene un punto mal colocado.',
  DOMAIN_LABEL_INVALID: 'El dominio contiene caracteres no permitidos.',
  DOMAIN_LABEL_HYPHEN: 'Ninguna parte del dominio puede empezar o terminar con guion.',
  DOMAIN_LABEL_TOO_LONG: 'Una parte del dominio es demasiado larga.',
  TLD_TOO_SHORT: 'La terminación del dominio debe tener al menos 2 letras (por ejemplo, .co).',
  TLD_NOT_ALPHA: 'La terminación del dominio solo puede contener letras (por ejemplo, .com).',
}

/**
 * Forma canónica de un correo: sin espacios alrededor y en minúsculas.
 * Es la ÚNICA representación que debe guardarse, buscarse y compararse, de modo que
 * `Admin@Empresa.com` y `admin@empresa.com` sean siempre el mismo correo.
 */
export function normalizeEmail(raw: string | null | undefined): string {
  return String(raw ?? '').trim().toLowerCase()
}

export type EmailValidation =
  | { ok: true; email: string }
  | { ok: false; reason: EmailRejectionReason; message: string }

/**
 * Valida la sintaxis de un correo y devuelve su forma normalizada.
 * Reglas aplicadas (ver pruebas EMAIL-001..EMAIL-012):
 *   · exactamente una arroba · parte local no vacía · dominio no vacío
 *   · sin espacios · dominio con al menos un punto · sin etiquetas vacías
 *   · etiquetas sin guion inicial ni final · TLD ≥ 2 caracteres y solo letras
 *   · longitudes dentro de los límites del estándar
 */
export function validateEmail(raw: string | null | undefined): EmailValidation {
  const original = String(raw ?? '')
  const email = normalizeEmail(original)

  const reject = (reason: EmailRejectionReason): EmailValidation =>
    ({ ok: false, reason, message: EMAIL_REJECTION_MESSAGES[reason] })

  if (email.length === 0) return reject('EMPTY')
  if (email.length > MAX_TOTAL) return reject('TOO_LONG')
  // El recorte quita los extremos; cualquier espacio restante es interior y no vale.
  if (/\s/.test(email)) return reject('HAS_WHITESPACE')

  const partes = email.split('@')
  if (partes.length !== 2) return reject('AT_COUNT')

  const [local, dominio] = partes

  if (local.length === 0) return reject('LOCAL_EMPTY')
  if (local.length > MAX_LOCAL) return reject('LOCAL_TOO_LONG')
  if (!LOCAL_CHARS.test(local)) return reject('LOCAL_INVALID_CHARS')
  // Un punto no puede abrir ni cerrar la parte local, ni ir doblado.
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return reject('LOCAL_INVALID_CHARS')
  }

  if (dominio.length === 0) return reject('DOMAIN_EMPTY')
  if (!dominio.includes('.')) return reject('DOMAIN_NO_DOT')

  const etiquetas = dominio.split('.')
  for (const etiqueta of etiquetas) {
    if (etiqueta.length === 0) return reject('DOMAIN_EMPTY_LABEL')
    if (etiqueta.length > MAX_LABEL) return reject('DOMAIN_LABEL_TOO_LONG')
    if (!LABEL.test(etiqueta)) return reject('DOMAIN_LABEL_INVALID')
    if (etiqueta.startsWith('-') || etiqueta.endsWith('-')) return reject('DOMAIN_LABEL_HYPHEN')
  }

  const tld = etiquetas[etiquetas.length - 1]
  if (tld.length < 2) return reject('TLD_TOO_SHORT')
  if (!TLD.test(tld)) return reject('TLD_NOT_ALPHA')

  return { ok: true, email }
}

/** ¿El correo es sintácticamente válido? */
export function isValidEmail(raw: string | null | undefined): boolean {
  return validateEmail(raw).ok
}

/**
 * ¿Dos correos son el mismo? Comparación normalizada: la única forma correcta de
 * detectar duplicados (`Admin@Empresa.com` === `admin@empresa.com`).
 */
export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeEmail(a)
  return na.length > 0 && na === normalizeEmail(b)
}
