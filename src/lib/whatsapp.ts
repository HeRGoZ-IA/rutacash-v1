// ============================================================
// DESTINATARIO DE WHATSAPP PARA RECIBOS (Ronda 48 · H-02)
// ------------------------------------------------------------
// Antes, el recibo se abría siempre hacia `wa.me/57<dígitos>`: en una empresa de
// Brasil, el nombre, el saldo y las parcelas del cliente podían llegar al número
// colombiano de un tercero. Ahora el destinatario se DEDUCE solo cuando es
// inequívoco; si no lo es, NO se construye ningún enlace (el recibo no sale).
//
// Reglas (solo Colombia y Brasil, los países de la plataforma):
//   · Número escrito como internacional (`+` o `00`): se respeta el país escrito, si
//     es 57 o 55 y el número es un móvil válido de ese país.
//   · Número nacional: se interpreta con el país de la EMPRESA.
//       Colombia: móvil de 10 dígitos que empieza por 3.
//       Brasil:   DDD válido (2 dígitos) + móvil de 9 dígitos que empieza por 9;
//                 se tolera el 0 de larga distancia delante («0 11 9…»).
//   · Ya con prefijo pero sin `+` («57 3…», «55 11 9…»): solo si la longitud no deja
//     duda (12 dígitos en Colombia, 13 en Brasil).
//   · Fijos, números cortos, códigos de operadora o cualquier otra forma: AMBIGUO.
// ============================================================

export type WhatsAppCountry = 'CO' | 'BR'

export type WhatsAppRecipient =
  | { ok: true; digits: string; display: string; country: WhatsAppCountry }
  | { ok: false; reason: string }

/** Código de país de la empresa a partir de lo que guarda cada versión (`CO`, `Colombia`, `BR`, `Brasil`…). */
export function companyWhatsAppCountry(pais: string | null | undefined): WhatsAppCountry | null {
  const p = (pais ?? '').trim().toLowerCase()
  if (p === 'co' || p === 'colombia') return 'CO'
  if (p === 'br' || p === 'brasil' || p === 'brazil') return 'BR'
  return null
}

// DDD vigentes de Brasil (Anatel).
const BR_DDD = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
])

const isCoMobile = (n: string) => /^3\d{9}$/.test(n)
const isBrMobile = (n: string) => /^\d{11}$/.test(n) && BR_DDD.has(Number(n.slice(0, 2))) && n[2] === '9'

function recipient(country: WhatsAppCountry, national: string): WhatsAppRecipient {
  if (country === 'CO') {
    return { ok: true, country, digits: `57${national}`, display: `+57 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}` }
  }
  return { ok: true, country, digits: `55${national}`, display: `+55 ${national.slice(0, 2)} ${national.slice(2, 7)}-${national.slice(7)}` }
}

const AMBIGUO = 'El teléfono del cliente no identifica un WhatsApp de forma segura. Corrígelo en la ficha del cliente (móvil completo).'

/**
 * Destinatario del recibo. `pais` es el país de la EMPRESA (contexto activo).
 * Nunca adivina: ante cualquier duda devuelve `{ ok: false }`.
 */
export function resolveWhatsAppRecipient(phone: string | null | undefined, pais: string | null | undefined): WhatsAppRecipient {
  const raw = (phone ?? '').trim()
  if (!raw) return { ok: false, reason: 'El cliente no tiene teléfono registrado.' }
  // Solo dígitos, espacios, guiones, puntos, paréntesis y un `+` inicial: cualquier otra
  // cosa (letras, extensiones, dos números en un campo) es ambigua.
  if (!/^\+?[\d\s\-().]+$/.test(raw)) return { ok: false, reason: AMBIGUO }
  const explicitIntl = raw.startsWith('+') || /^00/.test(raw.replace(/\D/g, ''))
  let digits = raw.replace(/\D/g, '')
  if (!explicitIntl) {
    const country = companyWhatsAppCountry(pais)
    if (!country) return { ok: false, reason: 'No se conoce el país de la empresa para interpretar el teléfono.' }
    if (country === 'CO') {
      if (isCoMobile(digits)) return recipient('CO', digits)
      if (digits.length === 12 && digits.startsWith('57') && isCoMobile(digits.slice(2))) return recipient('CO', digits.slice(2))
      return { ok: false, reason: AMBIGUO }
    }
    if (digits.length === 12 && digits.startsWith('0')) digits = digits.slice(1)   // «0 11 9…» (larga distancia)
    if (isBrMobile(digits)) return recipient('BR', digits)
    if (digits.length === 13 && digits.startsWith('55') && isBrMobile(digits.slice(2))) return recipient('BR', digits.slice(2))
    return { ok: false, reason: AMBIGUO }
  }
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.startsWith('57') && isCoMobile(digits.slice(2))) return recipient('CO', digits.slice(2))
  if (digits.startsWith('55') && isBrMobile(digits.slice(2))) return recipient('BR', digits.slice(2))
  return { ok: false, reason: 'Solo se envían recibos a móviles de Colombia (+57) o Brasil (+55).' }
}

/** Enlace `wa.me` para un destinatario YA validado. */
export function whatsAppLink(r: Extract<WhatsAppRecipient, { ok: true }>, message: string): string {
  return `https://wa.me/${r.digits}?text=${encodeURIComponent(message)}`
}
