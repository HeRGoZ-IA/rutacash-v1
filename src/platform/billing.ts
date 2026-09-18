// ============================================================
// RUTACASH — DEFINICIÓN COMERCIAL DE RUTA FACTURABLE
// ------------------------------------------------------------
// Punto ÚNICO donde se decide QUÉ se cobra. El número que ve el Owner no puede ser
// ambiguo: antes de contar hay que decir qué cuenta.
//
// DECISIÓN COMERCIAL EXPLÍCITA (apartado G de la entrega):
//
//   billableRouteCount = rutas de la empresa con `status === 'activa'`.
//
// Por qué esta y no otra:
//   · Una ruta ELIMINADA deja de existir: no se cobra. Evidente.
//   · Una ruta INACTIVA es una ruta que la empresa ha apagado deliberadamente
//     (`RoutesPage` la bloquea: no admite operación nueva, solo consulta histórica).
//     Cobrar por capacidad que el cliente no puede usar sería indefendible.
//   · Contar "rutas existentes" haría que archivar una ruta no abaratara nada y que
//     el cliente prefiriera BORRARLA, perdiendo su histórico. La regla no debe
//     empujar al cliente a destruir datos.
//
// `routeCount` (todas las rutas, en cualquier estado) se conserva aparte como dato
// informativo de tamaño. NUNCA se factura sobre él.
// ============================================================
import type { BillingMode, CompanyControlRecord } from '@/platform/types'

/** Estado de ruta que se factura. Fuente única; no repetir el literal por ahí. */
export const BILLABLE_ROUTE_STATUS = 'activa' as const

/** Forma mínima de una ruta para efectos de facturación (no se lee nada más). */
export interface BillableRouteLike {
  status: string
}

/** ¿Esta ruta se factura? Ver la decisión comercial de la cabecera. */
export function isBillableRoute(route: BillableRouteLike): boolean {
  return route.status === BILLABLE_ROUTE_STATUS
}

export interface RouteMetrics {
  /** Rutas existentes de la empresa, en cualquier estado. Informativo. */
  routeCount: number
  /** Rutas que se facturan. Es el número con valor comercial. */
  billableRouteCount: number
}

/** Métricas de rutas de una empresa a partir de sus rutas reales. */
export function computeRouteMetrics(routes: BillableRouteLike[]): RouteMetrics {
  return {
    routeCount: routes.length,
    billableRouteCount: routes.filter(isBillableRoute).length,
  }
}

/**
 * Valor esperado del período para una empresa.
 *
 *   per_route → billableRouteCount × billingRate
 *   fixed     → billingRate
 *
 * `billingMode` existe para que añadir un plan nuevo sea agregar un caso aquí y no
 * reescribir la facturación. Hoy solo se usa `per_route`; `fixed` está implementado
 * porque es trivial y evita que el enum sea decorativo. No se inventan más modos.
 */
export function expectedPeriodAmount(
  record: Pick<CompanyControlRecord, 'billingMode' | 'billingRate' | 'billableRouteCount'>,
): number {
  const rate = Number.isFinite(record.billingRate) ? record.billingRate : 0
  if (record.billingMode === 'fixed') return Math.max(0, rate)
  return Math.max(0, rate) * Math.max(0, record.billableRouteCount)
}

/** Etiqueta legible del modo de facturación. */
export const BILLING_MODE_LABEL: Record<BillingMode, string> = {
  per_route: 'Por ruta',
  fixed: 'Tarifa fija',
}

/**
 * Cobro esperado del período para TODAS las empresas: solo las que están en estado
 * comercial de servicio (`trial` o `active`). Una empresa suspendida no genera
 * expectativa de cobro mientras esté suspendida.
 */
export function expectedPeriodTotal(records: CompanyControlRecord[]): number {
  return records
    .filter(r => r.status !== 'suspended')
    .reduce((sum, r) => sum + expectedPeriodAmount(r), 0)
}
