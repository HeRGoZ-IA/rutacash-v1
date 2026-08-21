import { v4 as uuidv4 } from 'uuid'
import { clsx, type ClassValue } from 'clsx'

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}

export function generateId(): string {
  return uuidv4()
}

/**
 * Contraseña TEMPORAL para un usuario que crea un superior. Se genera al azar en vez
 * de usar un valor fijo conocido: ninguna cuenta de RutaCash debe nacer con una
 * credencial adivinable. Quien la recibe está obligado a cambiarla en su primer
 * acceso (`User.mustChangePassword`).
 *
 * Alfabeto sin caracteres ambiguos (0/O, 1/l/I) porque la clave se dicta o se copia
 * a mano. Longitud 10 sobre 30 símbolos ≈ 49 bits: sobrado para una clave de un solo
 * uso y aún legible.
 */
export function generateTemporaryPassword(): string {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => alfabeto[b % alfabeto.length]).join('')
}

export function downloadCSV(data: Record<string, unknown>[], filename: string) {
  if (!data.length) return
  const headers = Object.keys(data[0])
  const rows = data.map((row) =>
    headers.map((h) => {
      const val = row[h]
      if (val === null || val === undefined) return ''
      const str = String(val)
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"`
        : str
    }).join(',')
  )
  const csv = [headers.join(','), ...rows].join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function exportJSON(data: unknown, filename: string) {
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export function formatPhone(phone: string): string {
  const clean = phone.replace(/\D/g, '')
  if (clean.length === 10) {
    return `${clean.slice(0, 3)} ${clean.slice(3, 6)} ${clean.slice(6)}`
  }
  return phone
}

export function buildWhatsAppMessage(params: {
  clientName: string
  valor: number
  saldo: number
  cuotaActual: number
  totalCuotas: number
  currency?: string
}): string {
  const fmt = (n: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: params.currency ?? 'COP', minimumFractionDigits: 0 }).format(n)
  return (
    `Hola ${params.clientName}, recibimos tu pago de ${fmt(params.valor)} ` +
    `correspondiente a tu crédito. Saldo actual: ${fmt(params.saldo)}. ` +
    `Cuota actual: ${params.cuotaActual} de ${params.totalCuotas}. ¡Gracias!`
  )
}
