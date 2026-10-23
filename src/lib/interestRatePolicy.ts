// ============================================================
// TASA DE INTERÉS AL ORIGINAR — REGLA CENTRAL (PURA)
// ------------------------------------------------------------
// Decisión del propietario D73-01 (Ronda 73, 2026-10-22), que SUSTITUYE al ajuste del socio
// 2026-10-02 («el Cobrador solo origina al 20 %»):
//   · Ruta SIN «Tasa libre»: el Cobrador origina obligatoriamente con la tasa de su ruta.
//   · Ruta CON «Tasa libre»: el Cobrador elige entre las tasas admitidas (10 % o 20 %).
// Los demás roles originan con cualquier tasa admitida. Quien autoriza conserva su facultad de
// modificar condiciones (`authorization.modifyConditions`) y el desembolso usa solo lo aprobado.
//
// La regla limita QUIÉN ORIGINA y con qué tasa; no toca créditos ya creados. La usan las pantallas
// (qué ofrecer), el servicio local de CLEAN y la API de ADEX Online (que vuelve a comprobarla con la
// configuración VIGENTE de la ruta; PostgreSQL la exige una tercera vez). Sin Dexie ni React.
// ============================================================
import type { UserRole } from '@/models/types'

/** Tasas de interés admitidas por el negocio (catálogo global). */
export const ALLOWED_INTEREST_RATES = [10, 20] as const

/** Configuración de tasa de la ruta donde se origina. */
export interface RouteRatePolicy {
  /** Tasa configurada de la ruta. */
  tasaInteres: number
  /** «Tasa libre»: el Cobrador puede elegir entre las tasas admitidas. */
  tasaLibre: boolean
}

export const isAllowedRate = (rate: number): boolean => (ALLOWED_INTEREST_RATES as readonly number[]).includes(rate)

/**
 * Tasas con las que `rol` puede ORIGINAR una venta o solicitud en la ruta. Sin la ruta, el Cobrador no
 * tiene ninguna (la pantalla debe conocer la ruta antes de ofrecer una tasa).
 */
export function originationRatesFor(rol: UserRole, route?: RouteRatePolicy | null): readonly number[] {
  if (rol !== 'cobrador') return ALLOWED_INTEREST_RATES
  if (!route) return []
  if (route.tasaLibre) return ALLOWED_INTEREST_RATES
  return isAllowedRate(route.tasaInteres) ? [route.tasaInteres] : []
}

/** ¿Puede `rol` originar un crédito con esta tasa en la ruta? */
export function canOriginateAtRate(rol: UserRole, rate: number, route?: RouteRatePolicy | null): boolean {
  return originationRatesFor(rol, route).includes(rate)
}

/** Tasa propuesta al abrir el formulario: la de la ruta si se puede usar; si no, la primera admitida. */
export function defaultOriginationRate(rol: UserRole, route?: RouteRatePolicy | null): number {
  const rates = originationRatesFor(rol, route)
  if (route && rates.includes(route.tasaInteres)) return route.tasaInteres
  return rates[0] ?? ALLOWED_INTEREST_RATES[ALLOWED_INTEREST_RATES.length - 1]
}

/** Mensaje de rechazo listo para mostrar (null si la tasa es válida para el rol y la ruta). */
export function originationRateError(rol: UserRole, rate: number, route?: RouteRatePolicy | null): string | null {
  if (!isAllowedRate(rate)) return 'La tasa debe ser 10% o 20%.'
  if (rol !== 'cobrador') return null
  if (!route) return 'No se conoce la configuración de tasa de la ruta.'
  if (!route.tasaLibre && !isAllowedRate(route.tasaInteres)) {
    return `La tasa configurada de la ruta (${route.tasaInteres}%) no es válida: el Administrador debe fijarla en 10% o 20%.`
  }
  if (!canOriginateAtRate(rol, rate, route)) return `En esta ruta el Cobrador origina con la tasa de la ruta (${route.tasaInteres}%).`
  return null
}
