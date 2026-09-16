// ============================================================
// OFICINA COMO UNIDAD OPERATIVA Y FINANCIERA (PURO, sin DB) — testeable.
// ------------------------------------------------------------
// Convierte las filas crudas de UNA ruta en los hechos operativos que se muestran
// en el panel de Oficina, y agrega esos hechos al nivel de Oficina.
//
// REGLA QUE ESTE MÓDULO PROTEGE: todo se calcula a partir de las filas que se le
// pasan, y quien llama solo le pasa las de las rutas ACCESIBLES de la Oficina. Este
// módulo no puede ver ninguna otra ruta: no consulta la base ni recibe la Oficina.
//
// No se creó ningún motor financiero nuevo: se reutilizan las reglas que ya existen
// (`effectivePayments` para el recaudo vigente, `isSaleDisbursed` para lo que está
// realmente en la calle) y el saldo de las parcelas, que es el libro mayor.
// ============================================================
import type { Expense, Installment, Payment, Sale } from '@/models/types'
import { effectivePayments } from '@/lib/paymentState'
import { isSaleDisbursed } from '@/services/installmentEngine'

/** Hechos operativos de UNA ruta, ya calculados. */
export interface RouteOpsFacts {
  routeId: string
  nombre: string
  clientesActivos: number
  ventasActivas: number
  parcelasPendientes: number
  /** META del día: valor de las cuotas que vencen hoy (no el saldo restante). */
  aCobrarHoy: number
  /** Recaudo VIGENTE de hoy (excluye pagos revertidos y sus contrapartidas). */
  recaudadoHoy: number
  /** Lo que falta de la cuota de hoy. Nunca negativo. */
  pendienteHoy: number
  /** % de la cuota de hoy efectivamente recaudada. */
  cumplimiento: number
  /** Saldo por cobrar de ventas activas YA desembolsadas. */
  carteraActiva: number
  /** Saldo de cuotas ya vencidas (fecha anterior a hoy). */
  carteraVencida: number
  clientesConAtraso: number
  gastosHoy: number
  desembolsosPendientes: number
}

export interface RouteOpsInput {
  routeId: string
  nombre: string
  /** Ventas de ESTA ruta. */
  sales: Sale[]
  /** Parcelas indexadas por venta. */
  installmentsBySale: Map<string, Installment[]>
  /** Pagos de ESTA ruta (se filtran los vigentes aquí dentro). */
  payments: Payment[]
  /** Gastos de ESTA ruta. */
  expenses: Expense[]
  /** Fecha contable de referencia (yyyy-MM-dd). */
  today: string
}

/**
 * Hechos operativos de una ruta.
 *
 * Criterios, todos alineados con los que ya usa el sistema:
 *  · "Activa" = venta en estado `activa` y DESEMBOLSADA (lo pendiente de desembolso
 *    aún no salió a la calle, igual que en `getRouteFinancialSummary`).
 *  · El saldo autoritativo es el de las PARCELAS, no `sale.saldo`.
 *  · El recaudo usa `effectivePayments`: un pago revertido no cuenta, ni su asiento
 *    de reversión.
 */
export function routeOpsFacts(input: RouteOpsInput): RouteOpsFacts {
  const activas = input.sales.filter(s => s.status === 'activa' && isSaleDisbursed(s))
  const pendientesDesembolso = input.sales.filter(s => s.status === 'activa' && !isSaleDisbursed(s))

  let aCobrarHoy = 0
  let carteraActiva = 0
  let carteraVencida = 0
  let parcelasPendientes = 0
  const clientesConAtraso = new Set<string>()

  for (const venta of activas) {
    const parcelas = input.installmentsBySale.get(venta.id) ?? []
    for (const p of parcelas) {
      // META DEL DÍA: el VALOR de la cuota que vence hoy, no su saldo restante.
      // Con el saldo, cobrar reducía la meta y el cumplimiento salía inflado
      // (cobrar 60 de 100 daba 60/40 → 100 %). Con el valor, 60/100 = 60 %.
      // Una cuota de hoy ya saldada sigue contando como meta cumplida.
      if (p.fechaVencimiento === input.today) aCobrarHoy += p.valor

      if (p.saldo <= 0) continue
      parcelasPendientes++
      carteraActiva += p.saldo
      if (p.fechaVencimiento < input.today) {
        carteraVencida += p.saldo
        clientesConAtraso.add(venta.clientId)
      }
    }
  }

  const recaudadoHoy = effectivePayments(input.payments)
    .filter(p => p.fecha === input.today)
    .reduce((s, p) => s + p.valor, 0)

  return {
    routeId: input.routeId,
    nombre: input.nombre,
    clientesActivos: new Set(activas.map(s => s.clientId)).size,
    ventasActivas: activas.length,
    parcelasPendientes,
    aCobrarHoy,
    recaudadoHoy,
    pendienteHoy: Math.max(0, aCobrarHoy - recaudadoHoy),
    cumplimiento: cumplimientoPct(aCobrarHoy, recaudadoHoy),
    carteraActiva,
    carteraVencida,
    clientesConAtraso: clientesConAtraso.size,
    gastosHoy: input.expenses.filter(e => e.fecha === input.today).reduce((s, e) => s + e.valor, 0),
    desembolsosPendientes: pendientesDesembolso.length,
  }
}

/**
 * % de cumplimiento del cobro del día.
 *
 * Sin cuota que cobrar no hay porcentaje que calcular: se devuelve 100 si aun así
 * se recaudó algo (adelantos) y 0 si no hubo nada. Nunca se divide por cero ni se
 * inventa un 0 % engañoso en un día sin cuotas.
 */
export function cumplimientoPct(aCobrarHoy: number, recaudadoHoy: number): number {
  if (aCobrarHoy <= 0) return recaudadoHoy > 0 ? 100 : 0
  return Math.min(100, Math.round((recaudadoHoy / aCobrarHoy) * 100))
}

/** Totales de la Oficina: la suma de los hechos de sus rutas VISIBLES. */
export type OfficeOpsTotals = Omit<RouteOpsFacts, 'routeId' | 'nombre'>

export function officeOpsTotals(facts: RouteOpsFacts[]): OfficeOpsTotals {
  const sum = (f: (x: RouteOpsFacts) => number) => facts.reduce((n, x) => n + f(x), 0)
  const aCobrarHoy = sum(f => f.aCobrarHoy)
  const recaudadoHoy = sum(f => f.recaudadoHoy)
  return {
    clientesActivos: sum(f => f.clientesActivos),
    ventasActivas: sum(f => f.ventasActivas),
    parcelasPendientes: sum(f => f.parcelasPendientes),
    aCobrarHoy,
    recaudadoHoy,
    pendienteHoy: Math.max(0, aCobrarHoy - recaudadoHoy),
    cumplimiento: cumplimientoPct(aCobrarHoy, recaudadoHoy),
    carteraActiva: sum(f => f.carteraActiva),
    carteraVencida: sum(f => f.carteraVencida),
    clientesConAtraso: sum(f => f.clientesConAtraso),
    gastosHoy: sum(f => f.gastosHoy),
    desembolsosPendientes: sum(f => f.desembolsosPendientes),
  }
}

// ------------------------------------------------------------
// Resumen financiero consolidado (agregación de lo que YA existe)
// ------------------------------------------------------------
/** Forma mínima de `CashboxSummary` que necesita la consolidación. */
export interface RouteCashLike {
  cobros: number
  gastos: number
  prestamosEntregados: number
  retiros: number
  transferenciasEntradas: number
  transferenciasSalidas: number
  saldoActual: number
}

export interface OfficeFinanceTotals extends RouteCashLike {
  /** Suma de `carteraEnCalle` de las rutas visibles. */
  carteraEnCalle: number
  /** Suma de `baseActual` (saldo de caja disponible). */
  baseActual: number
  /** baseActual + carteraEnCalle. */
  totalControlado: number
}

/**
 * Consolidado financiero de la Oficina: la SUMA de los resúmenes por ruta que ya
 * produce `cashboxEngine`. No hay motor nuevo ni consultas por `officeId`: se
 * agregan las rutas visibles y punto.
 */
export function officeFinanceTotals(
  cajas: RouteCashLike[],
  financieros: { baseActual: number; carteraEnCalle: number }[],
): OfficeFinanceTotals {
  const sumCaja = (f: (x: RouteCashLike) => number) => cajas.reduce((n, x) => n + f(x), 0)
  const baseActual = financieros.reduce((n, x) => n + x.baseActual, 0)
  const carteraEnCalle = financieros.reduce((n, x) => n + x.carteraEnCalle, 0)
  return {
    cobros: sumCaja(c => c.cobros),
    gastos: sumCaja(c => c.gastos),
    prestamosEntregados: sumCaja(c => c.prestamosEntregados),
    retiros: sumCaja(c => c.retiros),
    transferenciasEntradas: sumCaja(c => c.transferenciasEntradas),
    transferenciasSalidas: sumCaja(c => c.transferenciasSalidas),
    saldoActual: sumCaja(c => c.saldoActual),
    baseActual,
    carteraEnCalle,
    totalControlado: baseActual + carteraEnCalle,
  }
}

// ------------------------------------------------------------
// Alertas operativas avanzadas (derivadas, sin persistencia nueva)
// ------------------------------------------------------------
export type OpsAlertKind =
  | 'cartera-vencida'
  | 'clientes-atraso'
  | 'cumplimiento-bajo'
  | 'sin-administrador'

export interface OpsAlert {
  kind: OpsAlertKind
  severity: 'warning' | 'error'
  routeId?: string
  mensaje: string
}

/**
 * Alertas que se derivan de los hechos operativos. Se calculan al abrir la
 * pantalla; no hay tabla de alertas ni estado nuevo.
 *
 * El cumplimiento solo se señala cuando HAY cuota que cobrar: un día sin cuotas no
 * es un incumplimiento.
 */
export function opsAlerts(params: {
  facts: RouteOpsFacts[]
  /** Rutas de la Oficina sin ningún Administrador efectivo. */
  routesWithoutAdmin?: { routeId: string; nombre: string }[]
  /** Umbral de cumplimiento por debajo del cual se avisa (0-100). */
  cumplimientoMinimo?: number
}): OpsAlert[] {
  const minimo = params.cumplimientoMinimo ?? 50
  const out: OpsAlert[] = []

  for (const f of params.facts) {
    if (f.carteraVencida > 0) {
      out.push({
        kind: 'cartera-vencida', severity: 'warning', routeId: f.routeId,
        mensaje: `${f.nombre} — cartera vencida por cobrar`,
      })
    }
    if (f.clientesConAtraso > 0) {
      out.push({
        kind: 'clientes-atraso', severity: 'warning', routeId: f.routeId,
        mensaje: `${f.nombre} — ${f.clientesConAtraso} cliente(s) con cuotas vencidas`,
      })
    }
    if (f.aCobrarHoy > 0 && f.cumplimiento < minimo) {
      out.push({
        kind: 'cumplimiento-bajo', severity: 'warning', routeId: f.routeId,
        mensaje: `${f.nombre} — cumplimiento del día: ${f.cumplimiento}%`,
      })
    }
  }

  for (const r of params.routesWithoutAdmin ?? []) {
    out.push({
      kind: 'sin-administrador', severity: 'warning', routeId: r.routeId,
      mensaje: `${r.nombre} — Sin Administrador asignado`,
    })
  }
  return out
}
