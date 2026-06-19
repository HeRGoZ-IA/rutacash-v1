import { v4 as uuidv4 } from 'uuid'
import { clsx, type ClassValue } from 'clsx'

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}

export function generateId(): string {
  return uuidv4()
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
