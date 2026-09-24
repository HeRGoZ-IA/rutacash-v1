// ============================================================
// CUADRE REAL POR TRABAJADOR — REGLAS PURAS (sin Dexie ni React)
// ------------------------------------------------------------
// Todo lo que significa "cuánto debía entregar esta persona", "qué diferencia
// quedó", "qué se arrastra" y "qué cierre está vigente" vive aquí, verificable sin
// base de datos. `cashSettlementService` solo lee, valida permisos y escribe.
//
// FÓRMULA (mientras NO exista Base personal):
//
//     esperado   = arrastreAnterior + recaudado − desembolsado − gastos
//     diferencia = entregado − esperado
//                    0 → cuadre exacto
//                  < 0 → FALTANTE  (sigue debiéndose)
//                  > 0 → SOBRANTE  (se registra y motiva; NO es saldo a favor)
//     arrastreAnterior(N+1) = max(0, −diferencia(N))
//
// Por qué no `arrastre(N+1) = diferencia(N)`: un faltante tiene diferencia
// NEGATIVA, pero lo que el trabajador sigue debiendo es una cantidad POSITIVA que
// se SUMA a lo esperado. Copiar la diferencia restaría la deuda en vez de sumarla.
// Y un sobrante no se convierte en crédito: se arrastra 0.
//
// PERIODO POR INSTANTES. El ciclo de una persona va desde el instante del último
// cuadre vigente (EXCLUSIVO) hasta el instante del cierre (INCLUSIVO). No hay
// semana, ni medianoche, ni lunes: dos cierres el mismo día son dos ciclos.
// ============================================================
import type { CashSettlement, Expense, Payment, Sale } from '@/models/types'

/** Motivo mínimo: misma regla que la reapertura de liquidaciones semanales. */
export const MIN_CASH_REASON = 10

export type CashSettlementResult = 'exacto' | 'faltante' | 'sobrante'

// ------------------------------------------------------------
// Instantes
// ------------------------------------------------------------
/** Convierte una fecha contable local (yyyy-MM-dd) en el instante ISO de su medianoche local. */
export function localMidnightISO(fecha: string): string {
  const d = new Date(`${fecha}T00:00:00`)
  return Number.isNaN(d.getTime()) ? '1970-01-01T00:00:00.000Z' : d.toISOString()
}

/** Instante en que el movimiento entró a la caja personal. */
export function paymentInstant(p: Pick<Payment, 'createdAt' | 'fecha'>): string {
  return p.createdAt || localMidnightISO(p.fecha)
}
export function expenseInstant(e: Pick<Expense, 'createdAt' | 'fecha'>): string {
  return e.createdAt || localMidnightISO(e.fecha)
}
/**
 * Ventas anteriores a v14 no guardan `disbursedAt`: se usa la medianoche local de
 * `fechaDesembolso`. Es conservador: una entrega del mismo día del inicio del
 * modelo queda ANTES del inicio y no se carga a nadie (no se inventa).
 */
export function disbursementInstant(s: Pick<Sale, 'disbursedAt' | 'fechaDesembolso' | 'fechaInicio'>): string {
  return s.disbursedAt || localMidnightISO(s.fechaDesembolso ?? s.fechaInicio)
}

/** ¿`instante` cae en el ciclo (desde, hasta]? */
export function inCycle(instante: string, desde: string, hasta: string): boolean {
  return instante > desde && instante <= hasta
}

// ------------------------------------------------------------
// Pagos: libro con signo anclado al inicio del modelo
// ------------------------------------------------------------
/**
 * Contribución de CADA fila de pagos al efectivo de su responsable, con su instante.
 *
 * Se usa el LIBRO CON SIGNO (original +X, reversión −X, corrección +Y, cada uno en
 * el instante en que se registró) y no `effectivePayments()` directamente:
 *
 *  · Dentro de una misma ventana ambos dan EXACTAMENTE lo mismo: original y
 *    reversión se netean y queda +Y (probado en CASH-SETTLEMENT-026).
 *  · Si la corrección llega en un ciclo POSTERIOR al del pago original, el original
 *    ya se entregó en el cuadre anterior. `effectivePayments()` excluiría el
 *    original (ya fuera de ventana) y sumaría +Y otra vez — cobrando dos veces el
 *    mismo dinero. El libro con signo carga solo el ajuste (Y − X) al ciclo nuevo.
 *
 * ANCLA: una cadena de corrección cuenta solo si su pago RAÍZ es posterior al
 * inicio del modelo personal. Corregir un pago histórico no genera efectivo nuevo
 * ni deuda: su original nunca estuvo en ningún cuadre.
 */
export function personalPaymentLedger(
  payments: Payment[],
  modelStart: string,
): { payment: Payment; instante: string; aporte: number }[] {
  const porId = new Map(payments.map(p => [p.id, p]))
  const raizDe = (p: Payment): Payment => {
    let actual = p
    const vistos = new Set<string>()
    while (!vistos.has(actual.id)) {
      vistos.add(actual.id)
      const previo = actual.reversesPaymentId ?? actual.correctionOfPaymentId
      const siguiente = previo ? porId.get(previo) : undefined
      if (!siguiente) break
      actual = siguiente
    }
    return actual
  }
  return payments
    .filter(p => paymentInstant(raizDe(p)) > modelStart)
    .map(p => ({ payment: p, instante: paymentInstant(p), aporte: p.valor }))
}

// ------------------------------------------------------------
// Fórmula
// ------------------------------------------------------------
export function computeExpected(c: { arrastreAnterior: number; recaudado: number; desembolsado: number; gastos: number }): number {
  return c.arrastreAnterior + c.recaudado - c.desembolsado - c.gastos
}

export function settlementOutcome(esperado: number, entregado: number): {
  diferencia: number; faltante: number; sobrante: number; resultado: CashSettlementResult
} {
  const diferencia = entregado - esperado
  return {
    diferencia,
    faltante: Math.max(0, -diferencia),
    sobrante: Math.max(0, diferencia),
    resultado: diferencia === 0 ? 'exacto' : diferencia < 0 ? 'faltante' : 'sobrante',
  }
}

/** Lo que el siguiente ciclo hereda del cierre anterior: SOLO el faltante, en positivo. */
export function carryOverFrom(previo: Pick<CashSettlement, 'diferencia'> | null | undefined): number {
  return previo ? Math.max(0, -previo.diferencia) : 0
}

// ------------------------------------------------------------
// Validaciones de entrada
// ------------------------------------------------------------
export function validateDelivered(entregado: unknown): string | null {
  const n = Number(entregado)
  if (!Number.isFinite(n) || n < 0) return 'Indica el efectivo entregado (0 o más).'
  if (Math.round(n) !== n) return 'El efectivo entregado debe ser un valor entero.'
  return null
}

export function validateDifferenceReason(diferencia: number, motivo: string | undefined): string | null {
  if (diferencia === 0) return null
  if ((motivo ?? '').trim().length < MIN_CASH_REASON) {
    return `Hay ${diferencia < 0 ? 'faltante' : 'sobrante'}: explica el motivo (mínimo ${MIN_CASH_REASON} caracteres).`
  }
  return null
}

// ------------------------------------------------------------
// Ciclo, vigencia, solapamiento y versionado
// ------------------------------------------------------------
/** Un cuadre VIGENTE es un cierre que no fue reabierto. */
export function isActiveCashSettlement(s: Pick<CashSettlement, 'status'>): boolean {
  return s.status === 'cerrada'
}

const mismoPar = (routeId: string, userId: string) =>
  (s: Pick<CashSettlement, 'routeId' | 'userId'>) => s.routeId === routeId && s.userId === userId

/** Último cuadre vigente de la persona en la ruta (por instante de cierre). */
export function lastActiveCashSettlement(list: CashSettlement[], routeId: string, userId: string): CashSettlement | null {
  const vigentes = list.filter(mismoPar(routeId, userId)).filter(isActiveCashSettlement)
  if (vigentes.length === 0) return null
  return vigentes.reduce((a, b) => (b.hasta > a.hasta ? b : a))
}

/** ¿Dos ciclos (desde, hasta] se solapan? Compartir solo el borde NO es solaparse. */
export function cyclesOverlap(a: Pick<CashSettlement, 'desde' | 'hasta'>, b: Pick<CashSettlement, 'desde' | 'hasta'>): boolean {
  return a.desde < b.hasta && b.desde < a.hasta
}

export function closeCycleBlockedReason(
  list: CashSettlement[], routeId: string, userId: string, desde: string, hasta: string,
): string | null {
  if (!(hasta > desde)) return 'El ciclo está vacío: el cierre debe ser posterior al último cuadre.'
  const choque = list.filter(mismoPar(routeId, userId)).filter(isActiveCashSettlement)
    .find(s => cyclesOverlap(s, { desde, hasta }))
  return choque ? 'Este periodo se solapa con un cuadre vigente del mismo trabajador en esta ruta.' : null
}

/**
 * ¿Se puede reabrir `doc`? Solo el ÚLTIMO cuadre vigente de la persona en la ruta:
 * reabrir uno anterior dejaría al posterior con un arrastre calculado sobre un
 * cierre que ya no vale.
 */
export function reopenCashBlockedReason(doc: CashSettlement, list: CashSettlement[]): string | null {
  if (doc.status === 'reabierta') return 'Este cuadre ya está reabierto.'
  if (doc.supersededBy) return 'Esta versión ya fue sustituida por un cierre posterior.'
  const posterior = list.filter(mismoPar(doc.routeId, doc.userId)).filter(isActiveCashSettlement)
    .some(s => s.id !== doc.id && s.hasta > doc.hasta)
  return posterior
    ? 'Existe un cuadre posterior vigente de este trabajador en esta ruta: solo puede reabrirse el último.'
    : null
}

/**
 * Versión del cierre nuevo. Un ciclo reabierto y vuelto a cerrar parte del MISMO
 * `desde`: el nuevo documento es la versión siguiente y sustituye a los reabiertos
 * de ese mismo arranque.
 */
export function nextCashVersion(list: CashSettlement[], routeId: string, userId: string, desde: string): {
  version: number; sustituye: CashSettlement[]
} {
  const previos = list.filter(mismoPar(routeId, userId)).filter(s => s.desde === desde)
  return {
    version: previos.reduce((m, s) => Math.max(m, s.version), 0) + 1,
    sustituye: previos.filter(s => s.status === 'reabierta' && !s.supersededBy),
  }
}

/** Faltantes pendientes: último cuadre vigente por (ruta, persona) con diferencia < 0. */
export function pendingShortages(list: CashSettlement[]): CashSettlement[] {
  const ultimos = new Map<string, CashSettlement>()
  for (const s of list.filter(isActiveCashSettlement)) {
    const k = `${s.routeId}|${s.userId}`
    const actual = ultimos.get(k)
    if (!actual || s.hasta > actual.hasta) ultimos.set(k, s)
  }
  return [...ultimos.values()].filter(s => s.diferencia < 0)
}
