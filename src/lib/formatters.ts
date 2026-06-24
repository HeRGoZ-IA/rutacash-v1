import { format, parseISO, differenceInDays, isValid } from 'date-fns'
import { es } from 'date-fns/locale'

export function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('es-CO').format(value)
}

// ============================================================
// Paquete 2.5 — Inputs de dinero con formato moneda
// ============================================================
//
// El modelo siempre guarda NÚMEROS. Estos helpers solo afectan la
// presentación dentro de los inputs. Toda la app trabaja con montos
// enteros (formatCurrency usa 0 decimales), así que estos helpers son
// también enteros, para no romper cálculos ni redondeos existentes.

interface CurrencyMeta {
  /** Símbolo que se muestra a la izquierda del input. */
  symbol: string
  /** Locale usado SOLO para el separador de miles del input. */
  locale: string
}

// Símbolo + separador "razonable" por moneda (Suramérica y Centroamérica).
// Si una moneda no está aquí, se usa el propio código como símbolo y es-CO.
const CURRENCY_META: Record<string, CurrencyMeta> = {
  COP: { symbol: '$', locale: 'es-CO' },
  USD: { symbol: 'US$', locale: 'en-US' },
  EUR: { symbol: '€', locale: 'es-ES' },
  MXN: { symbol: '$', locale: 'es-MX' },
  PEN: { symbol: 'S/', locale: 'es-PE' },
  ARS: { symbol: '$', locale: 'es-AR' },
  VES: { symbol: 'Bs', locale: 'es-VE' },
  CLP: { symbol: '$', locale: 'es-CL' },
  BRL: { symbol: 'R$', locale: 'pt-BR' },
  UYU: { symbol: '$U', locale: 'es-UY' },
  PYG: { symbol: '₲', locale: 'es-PY' },
  BOB: { symbol: 'Bs', locale: 'es-BO' },
  CRC: { symbol: '₡', locale: 'es-CR' },
  GTQ: { symbol: 'Q', locale: 'es-GT' },
  HNL: { symbol: 'L', locale: 'es-HN' },
  NIO: { symbol: 'C$', locale: 'es-NI' },
  PAB: { symbol: 'B/.', locale: 'es-PA' },
  DOP: { symbol: 'RD$', locale: 'es-DO' },
  SVC: { symbol: '₡', locale: 'es-SV' },
}

export function getCurrencyMeta(currency = 'COP'): CurrencyMeta {
  return CURRENCY_META[currency] ?? { symbol: currency, locale: 'es-CO' }
}

export function getCurrencySymbol(currency = 'COP'): string {
  return getCurrencyMeta(currency).symbol
}

/**
 * Convierte lo que el usuario escribe en el input a un número entero.
 * Ignora símbolo, espacios y separadores de miles. Si está vacío → 0.
 */
export function parseCurrencyInput(raw: string): number {
  const digits = String(raw).replace(/[^\d]/g, '')
  if (digits === '') return 0
  const n = parseInt(digits, 10)
  return Number.isFinite(n) ? n : 0
}

/**
 * Formatea un número para mostrarlo dentro del input (solo separadores
 * de miles, sin símbolo: el símbolo va como adorno a la izquierda).
 * 0 / vacío → string vacío para permitir dejar el campo vacío.
 */
export function formatCurrencyInput(value: number | '' | null | undefined, currency = 'COP'): string {
  if (value === '' || value === null || value === undefined || value === 0 || Number.isNaN(value)) return ''
  const { locale } = getCurrencyMeta(currency)
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
}

/**
 * Normaliza un documento para comparar duplicados:
 * quita espacios, puntos y guiones, y pasa a minúsculas.
 */
export function normalizeDoc(doc: string): string {
  return String(doc).replace(/[\s.\-]/g, '').toLowerCase()
}

export function formatDate(dateStr: string, fmt = 'dd/MM/yyyy'): string {
  try {
    const d = parseISO(dateStr)
    if (!isValid(d)) return dateStr
    return format(d, fmt, { locale: es })
  } catch {
    return dateStr
  }
}

export function formatDateLong(dateStr: string): string {
  return formatDate(dateStr, "d 'de' MMMM yyyy")
}

export function formatDateTime(dateStr: string): string {
  return formatDate(dateStr, 'dd/MM/yyyy HH:mm')
}

export function today(): string {
  return format(new Date(), 'yyyy-MM-dd')
}

export function nowISO(): string {
  return new Date().toISOString()
}

export function addDays(dateStr: string, days: number): string {
  const d = parseISO(dateStr)
  d.setDate(d.getDate() + days)
  return format(d, 'yyyy-MM-dd')
}

export function daysBetween(from: string, to: string): number {
  return differenceInDays(parseISO(to), parseISO(from))
}

export function getWeekStart(date = new Date()): string {
  const d = new Date(date)
  const day = d.getDay()
  // Lunes = inicio semana
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  return format(d, 'yyyy-MM-dd')
}

export function getWeekEnd(date = new Date()): string {
  const start = parseISO(getWeekStart(date))
  start.setDate(start.getDate() + 5) // Sábado
  return format(start, 'yyyy-MM-dd')
}

export function truncate(str: string, max = 30): string {
  return str.length > max ? str.slice(0, max) + '…' : str
}

// Días de pago: 0=domingo, 1=lunes ... 6=sábado
const DAY_LABELS_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']

/** "Lun, Mar, Mié..." ordenado de lunes a domingo. Si no hay días → "Según frecuencia original". */
export function formatPaymentDays(days?: number[]): string {
  if (!days || days.length === 0) return 'Según frecuencia original'
  return [...days]
    .sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b))
    .map(d => DAY_LABELS_SHORT[d] ?? '')
    .filter(Boolean)
    .join(', ')
}

export function initials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}
