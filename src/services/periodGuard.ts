// ============================================================
// GUARDA DE PERIODO CERRADO (D7, Ronda 6/6C)
// ------------------------------------------------------------
// Una liquidación semanal CERRADA archiva sus cifras (`settlementService`), pero
// el motor las calcula por FECHA CONTABLE (`getCashboxSummary`): un movimiento
// nuevo con fecha dentro de esa semana cambiaría el cálculo vivo del periodo sin
// reabrirlo. Esta guarda lo impide en los servicios que escriben dinero con fecha
// contable de una ruta. Reabrir la semana (con motivo, `reopenSettlement`) es la
// vía autorizada para volver a escribir en ella.
//
// El cuadre POR TRABAJADOR no necesita esta guarda: corta por INSTANTE y todos sus
// escritores sellan "ahora" bajo bloqueo (ver `closeCashSettlement`).
//
// La condición de "cierre que protege" es la MISMA que usa la corrección de pagos
// (`protectingClosureFor`): una sola definición.
// ============================================================
import { db } from '@/lib/db'
import { protectingClosureFor } from '@/lib/settlementPeriods'
import type { WeeklySettlement } from '@/models/types'

export interface PeriodGuardDatabase {
  weeklySettlements: {
    where(index: string): { equals(key: string): { toArray(): Promise<WeeklySettlement[]> } }
  }
}

/** Mensaje único de bloqueo por periodo cerrado. */
export function closedPeriodMessage(cierre: Pick<WeeklySettlement, 'semanaInicio' | 'semanaFin'>, fecha: string): string {
  return `La semana del ${cierre.semanaInicio} al ${cierre.semanaFin} de esta ruta está cerrada: no admite movimientos con fecha ${fecha}. Para registrarlo, reábrela con motivo.`
}

/**
 * Motivo por el que `routeId` no admite un movimiento con fecha contable `fecha`
 * (null = el periodo está abierto). Debe llamarse DENTRO de la transacción que
 * escribe, con `weeklySettlements` en su ámbito, para que un cierre simultáneo no
 * se cuele entre la comprobación y la escritura.
 */
export async function closedPeriodBlockedReason(
  routeId: string,
  fecha: string,
  database: PeriodGuardDatabase = db,
): Promise<string | null> {
  if (!routeId || !fecha) return null
  const settlements = await database.weeklySettlements.where('routeId').equals(routeId).toArray()
  const cierre = protectingClosureFor(settlements, routeId, fecha)
  return cierre ? closedPeriodMessage(cierre, fecha) : null
}
