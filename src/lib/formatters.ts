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

export function initials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}
