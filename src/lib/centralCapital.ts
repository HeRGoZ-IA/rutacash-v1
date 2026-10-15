// ============================================================
// CAPITAL CENTRALIZADO (C1, 2026-10) — REGLAS PURAS (sin Dexie)
// ------------------------------------------------------------
// Decisión del propietario: la caja de la ruta deja de ser una BOLSA INTERMEDIARIA.
// El Administrador responsable administra su bolsa y entrega capital directamente al
// trabajador, identificando la ruta; lo que el trabajador entrega vuelve a esa
// bolsa. La ruta sigue siendo la unidad de atribución (Base, cartera, cuadres,
// liquidaciones), pero su parte "Sin asignar" ya no recibe dinero nuevo.
//
// CÓMO SE CONSIGUE SIN FÓRMULAS NUEVAS. La Base de la ruta y la bolsa del
// Administrador se calculan igual que en v16. Cada operación que antes dejaba o
// tomaba dinero de "Sin asignar" se registra ahora como un PAR atómico:
//
//   entrega        CapitalMovement(+X, adminId) + BASE_ASSIGNMENT(X)  → Sin asignar no cambia
//   devolución     BASE_RETURN(X) + Withdrawal(+X, adminId)           → Sin asignar no cambia
//   cuadre         CashSettlement + Withdrawal(entregado − sobrante)  → Sin asignar no cambia
//   cobro no personal  Payment + Withdrawal(+X)                       → Sin asignar no cambia
//   desembolso Admin   CapitalMovement(+X) + venta desembolsada       → Sin asignar no cambia
//   gasto de ruta      CapitalMovement(+X) + gasto                    → Sin asignar no cambia
//
// Identidad que lo demuestra (conciliación v15): Base = Sin asignar + Σ posiciones.
// La bolsa baja (o sube) exactamente una vez por operación; el desembolso de un
// trabajador sale de SU posición, que ya recibió el capital: no se cobra dos veces.
//
// INVARIANTE NUEVA: tras cualquier operación del modelo centralizado, "Sin asignar"
// de una ruta NO AUMENTA. Lo que hubiera en ella al activarse es SALDO HEREDADO: solo
// puede salir (retiro a la bolsa, entrega a un trabajador, salida a socio), nunca
// crecer por operaciones nuevas. Única excepción documentada: corregir o anular un
// cobro no personal ANTERIOR a la activación sigue su circuito histórico.
//
// ACTIVACIÓN: explícita, por empresa (`Tenant.centralCapitalStartAt`). Sin ella todo
// funciona exactamente como en v16. Nada la activa al cargar la aplicación.
// ============================================================
import type { CashSettlement, Payment, Tenant, UserRole } from '@/models/types'

/** ¿La empresa opera con capital centralizado? */
export function isCentralCapitalActive(tenant: Pick<Tenant, 'centralCapitalStartAt'> | null | undefined): boolean {
  return !!tenant?.centralCapitalStartAt
}

/**
 * Efectivo que un cuadre devuelve a la bolsa del responsable: lo que deja la
 * posición del trabajador Y está en el libro de la ruta.
 *
 *   posición cae en  esperado − arrastreSiguiente = min(entregado, esperado)
 *                 =  entregado − sobrante
 *
 * · Faltante: solo vuelve lo entregado; el faltante sigue siendo deuda del trabajador.
 * · Sobrante: el exceso es efectivo que no está en el libro (regla vigente: se
 *   registra, nunca es crédito). No entra a la bolsa: sigue documentado en el cuadre.
 * · Esperado negativo (gastos sin efectivo, 73209ce): el resultado es ≤ 0. Hoy esa
 *   diferencia rebaja "Sin asignar" y queda como sobrante documentado sin mover
 *   efectivo físico; se conserva tal cual (no se carga a la bolsa: nadie recibió
 *   ese dinero). Ver EXP-CASH-010.
 */
export function cuadreReturnToPool(doc: Pick<CashSettlement, 'entregado' | 'sobrante'>): number {
  return doc.entregado - doc.sobrante
}

/**
 * ¿El cobro entra a la caja personal de alguien? Solo el EFECTIVO recibido por
 * quien tiene caja personal (Cobrador, Supervisor). Lo demás —transferencias,
 * cobros recibidos por un Administrador— no está en manos de ningún trabajador:
 * en v16 caía en "Sin asignar"; con capital centralizado va a la bolsa.
 */
export function isPersonalCashPayment(p: Pick<Payment, 'tipo'>, collectorRol: UserRole | undefined): boolean {
  return (p.tipo ?? 'efectivo') === 'efectivo' && (collectorRol === 'cobrador' || collectorRol === 'supervisor')
}

// ------------------------------------------------------------
// Identificadores deterministas (idempotencia: la misma operación no se duplica)
// ------------------------------------------------------------
export const centralIds = {
  cuadre: (settlementId: string) => `central-cuadre-${settlementId}`,
  cobro: (paymentId: string) => `central-cobro-${paymentId}`,
  desembolso: (saleId: string) => `central-desembolso-${saleId}`,
  gastoRuta: (expenseId: string) => `central-gasto-${expenseId}`,
  custodia: (operationId: string) => `${operationId}-custodia`,
}

// ------------------------------------------------------------
// Diagnóstico de transición (preparado para C2; solo lectura)
// ------------------------------------------------------------
export type RouteTransitionStatus =
  /** Sin saldo en la caja de la ruta: nada que trasladar. */
  | 'limpia'
  /** Saldo heredado positivo y conciliación correcta: puede vaciarse con operaciones existentes. */
  | 'saldo-heredado'
  /** Conciliación rota o "Sin asignar" negativo: revisión manual; nada automático. */
  | 'inconsistente'
  /** Sin Administrador responsable válido: operaciones de caja bloqueadas. */
  | 'sin-responsable'

export interface RouteTransitionInput {
  tieneResponsable: boolean
  cuadra: boolean
  noAsignado: number
  /**
   * "Sin asignar" + sobrantes registrados (efectivo físico que debería haber en la
   * caja). Opcional: sin él, todo negativo se trata como inconsistencia.
   */
  efectivoFisicoNoAsignado?: number
}

/**
 * Clasificación de la ruta para la transición (C1/C2):
 *   · sin-responsable  → nadie puede operar su capital.
 *   · inconsistente    → la conciliación no cuadra, o "Sin asignar" es negativo SIN
 *                        explicación (el efectivo físico también sería negativo).
 *   · saldo-heredado   → hay saldo en la caja de la ruta. Incluye el NEGATIVO
 *                        explicado por sobrantes registrados (cuadres con esperado
 *                        negativo, 73209ce): no es dinero de nadie, ninguna operación
 *                        nueva lo consume (disponible 0) y el sobrante sigue documentado.
 *   · limpia           → nada en la caja de la ruta.
 */
export function classifyRouteTransition(r: RouteTransitionInput): RouteTransitionStatus {
  if (!r.tieneResponsable) return 'sin-responsable'
  if (!r.cuadra) return 'inconsistente'
  if (r.noAsignado < 0 && (r.efectivoFisicoNoAsignado ?? r.noAsignado) < 0) return 'inconsistente'
  return r.noAsignado === 0 ? 'limpia' : 'saldo-heredado'
}

/** Explicación legible del estado de una ruta (diagnóstico y activación). */
export function routeTransitionExplanation(estado: RouteTransitionStatus, r: { noAsignado: number; cuadra: boolean; bloqueada?: boolean }): string {
  switch (estado) {
    case 'sin-responsable':
      return 'Sin Administrador responsable de capital: nadie puede entregarle capital. Al activar queda bloqueada hasta asignar un responsable y liberarla.'
    case 'inconsistente':
      return r.cuadra
        ? 'El efectivo sin asignar es negativo y no lo explican sobrantes registrados. Requiere revisión: al activar queda bloqueada para capital nuevo.'
        : 'La conciliación de la ruta no cuadra. Requiere revisión: al activar queda bloqueada para capital nuevo. Nada se corrige automáticamente.'
    case 'saldo-heredado':
      return r.noAsignado > 0
        ? 'Tiene efectivo en la antigua caja de la ruta. Queda identificado como saldo heredado: solo puede bajar (traspaso a la bolsa del responsable o entrega a un trabajador).'
        : 'Tiene un saldo negativo explicado por sobrantes registrados en cuadres (gastos pagados por el trabajador). No es dinero disponible y ninguna operación nueva lo usa.'
    default:
      return r.bloqueada ? 'Sin saldo en la caja de la ruta, pero bloqueada desde la activación.' : 'Sin saldo en la caja de la ruta: lista para el modelo centralizado.'
  }
}

export const CENTRAL_CAPITAL_MESSAGES = {
  noCajaDeRuta: 'Con capital centralizado la ruta no recibe capital en su caja: entrégalo directamente a un trabajador desde tu bolsa.',
  devolucionACaja: 'Con capital centralizado la devolución va a la bolsa del Administrador responsable (devolución de capital), no a la caja de la ruta.',
  aporteSocioARuta: 'Con capital centralizado el aporte de un socio entra primero a la bolsa del Administrador responsable de la ruta.',
  trasladoEntreRutas: 'Con capital centralizado no hay traslados entre cajas de ruta: el responsable recibe la devolución en una ruta y entrega el capital en la otra.',
  anulacionQueRellenaCaja: 'Con capital centralizado una anulación no puede devolver dinero a la caja de la ruta.',
  operacionEmparejada: 'Este movimiento forma parte de una operación del capital centralizado: anúlalo desde esa operación, no por separado.',
  rutaBloqueada: 'Esta ruta quedó bloqueada al activar el capital centralizado (inconsistente o sin responsable). El SuperAdmin debe revisarla y liberarla antes de entregarle capital.',
} as const
