// ============================================================
// TASA DE INTERÉS POR ROL — REGLA CENTRAL (PURA)
// ------------------------------------------------------------
// Ajuste del socio 2026-10-02 (docs/AJUSTES_PRUEBAS_SOCIO_2026-10-02.md, punto 1):
// el Cobrador solo ORIGINA créditos al 20%. El 10% sigue siendo una tasa válida del
// sistema y se aplica en la AUTORIZACIÓN (Secretario, Supervisor, Admin, Super
// Admin con `authorization.modifyConditions`), nunca al originar desde Cobrador.
//
// La regla limita QUIÉN ORIGINA, no la venta: no toca créditos ya creados (su
// `tasaInteres` almacenado se lee tal cual) ni las condiciones que fija el
// autorizador al aprobar. La usan las pantallas (qué ofrecer) y el servicio
// (`createDirectSale` / `createSaleRequest`, antes de persistir). Sin Dexie ni React.
// ============================================================
import type { UserRole } from '@/models/types'

/** Tasas de interés admitidas por el negocio (catálogo global: NO se recorta). */
export const ALLOWED_INTEREST_RATES = [10, 20] as const

/** Única tasa con la que un Cobrador puede originar un crédito. */
export const COLLECTOR_INTEREST_RATE = 20

/** Tasas con las que `rol` puede ORIGINAR una venta o solicitud. */
export function originationRatesFor(rol: UserRole): readonly number[] {
  return rol === 'cobrador' ? [COLLECTOR_INTEREST_RATE] : ALLOWED_INTEREST_RATES
}

/** ¿Puede `rol` originar un crédito con esta tasa? */
export function canOriginateAtRate(rol: UserRole, rate: number): boolean {
  return originationRatesFor(rol).includes(rate)
}

/** Mensaje de rechazo listo para mostrar (null si la tasa es válida para el rol). */
export function originationRateError(rol: UserRole, rate: number): string | null {
  if (!(ALLOWED_INTEREST_RATES as readonly number[]).includes(rate)) return 'La tasa debe ser 10% o 20%.'
  if (!canOriginateAtRate(rol, rate)) return `El Cobrador solo puede crear créditos al ${COLLECTOR_INTEREST_RATE}%.`
  return null
}
