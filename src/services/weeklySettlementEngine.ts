// ============================================================
// Motor de liquidación semanal
// ============================================================
import { db } from '@/lib/db'
import { getCashboxSummary } from './cashboxEngine'
import { generateId } from '@/lib/utils'
import { nowISO } from '@/lib/formatters'
import type { WeeklySettlement } from '@/models/types'

export async function generateWeeklySettlement(params: {
  tenantId: string
  officeId: string
  routeId: string
  semanaInicio: string
  semanaFin: string
}): Promise<WeeklySettlement> {
  const { tenantId, officeId, routeId, semanaInicio, semanaFin } = params

  const summary = await getCashboxSummary(routeId, semanaInicio, semanaFin)

  const settlement: WeeklySettlement = {
    id: generateId(),
    tenantId,
    officeId,
    routeId,
    semanaInicio,
    semanaFin,
    saldoAnterior: summary.saldoAnterior,
    ingresoCapital: summary.ingresoCapital,
    cobros: summary.cobros,
    prestamosEntregados: summary.prestamosEntregados,
    gastos: summary.gastos,
    transferenciasEntradas: summary.transferenciasEntradas,
    transferenciasSalidas: summary.transferenciasSalidas,
    retiros: summary.retiros,
    saldoFinal: summary.saldoActual,
    createdAt: nowISO(),
  }

  return settlement
}

export async function getAllRoutesWeeklySettlement(params: {
  tenantId: string
  semanaInicio: string
  semanaFin: string
}): Promise<WeeklySettlement[]> {
  const { tenantId, semanaInicio, semanaFin } = params

  // Liquidación por empresa: todas las rutas del tenant (ya no por oficina).
  const routes = await db.routes.where('tenantId').equals(tenantId).toArray()

  const settlements: WeeklySettlement[] = []
  for (const route of routes) {
    const s = await generateWeeklySettlement({
      tenantId,
      officeId: route.officeId ?? '',
      routeId: route.id,
      semanaInicio,
      semanaFin,
    })
    settlements.push(s)
  }
  return settlements
}
