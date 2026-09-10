// ============================================================
// Motor de liquidación semanal — SIEMPRE POR RUTA
// ------------------------------------------------------------
// La liquidación se calcula para UNA ruta concreta: no existe modo consolidado.
// Todo el cálculo se delega en `getCashboxSummary(routeId, ...)`, que ya aísla los
// ocho componentes por ruta (capital, cobros, préstamos, gastos, transferencias
// de entrada y salida, retiros y saldo anterior). Aquí no se recalcula nada.
//
// SCOPING (fail-closed): `generateWeeklySettlementForUser` valida la ruta contra
// las rutas autorizadas del usuario ANTES de leer un solo movimiento. Una ruta
// fuera del alcance devuelve `null`, nunca cifras. La comprobación vive en el
// servicio —no solo en la pantalla— para que un routeId manipulado no llegue al
// motor financiero.
// ============================================================
import { getCashboxSummary, type CashboxDatabase } from './cashboxEngine'
import { db } from '@/lib/db'
import { canAccessRoute } from '@/lib/permissions'
import { generateId } from '@/lib/utils'
import { nowISO } from '@/lib/formatters'
import type { User, WeeklySettlement } from '@/models/types'

export interface WeeklySettlementParams {
  tenantId: string
  routeId: string
  semanaInicio: string
  semanaFin: string
}

/**
 * Liquidación de UNA ruta en un rango semanal. No aplica permisos: es el cálculo
 * puro. Las pantallas deben usar `generateWeeklySettlementForUser`.
 */
export async function generateWeeklySettlement(
  params: WeeklySettlementParams,
  database: CashboxDatabase = db,
): Promise<WeeklySettlement> {
  const { tenantId, routeId, semanaInicio, semanaFin } = params

  const summary = await getCashboxSummary(routeId, semanaInicio, semanaFin, database)

  return {
    id: generateId(),
    tenantId,
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
}

/**
 * Liquidación de una ruta CON GUARDA DE ALCANCE (punto de entrada de la UI).
 * Devuelve `null` si el usuario no puede acceder a esa ruta: cero datos, sin
 * excepción que revele si la ruta existe.
 */
export async function generateWeeklySettlementForUser(
  params: WeeklySettlementParams & { user: User | null | undefined },
  database: CashboxDatabase = db,
): Promise<WeeklySettlement | null> {
  const { user, ...rest } = params
  if (!rest.routeId) return null
  // FAIL-CLOSED: la ruta debe estar entre las autorizadas (Super Admin: todas).
  if (!canAccessRoute(user, rest.routeId)) return null
  return generateWeeklySettlement(rest, database)
}
