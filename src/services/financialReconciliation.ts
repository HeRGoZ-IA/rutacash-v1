// ============================================================
// RUTACASH — CONCILIACIÓN FINANCIERA (DIAGNÓSTICO DE DATOS HEREDADOS)
// ------------------------------------------------------------
// HERRAMIENTA DE **SOLO LECTURA**. No escribe, no corrige, no migra y no borra
// nada: únicamente lee `sales`, `installments`, `payments`, `clients` y `routes`
// y reporta inconsistencias. Cualquier corrección debe decidirse a la vista de
// este informe, nunca de forma automática.
//
// Existe porque hasta la introducción de `paymentService` era posible registrar
// pagos superiores al saldo y escrituras parciales sin transacción. Este módulo
// permite comprobar si una base concreta llegó a materializar ese daño.
//
// SEMÁNTICA DE PAGOS: se reutiliza `effectivePayments` de `paymentCorrectionService`
// (fuente única). NO se suman todas las filas de `payments`: los originales
// revertidos (`state: 'reversed'`) y los asientos de reversión (`state: 'reversal'`)
// se excluyen del cómputo, igual que hace el recálculo de una venta corregida.
//
// USO EN NAVEGADOR (consola de DevTools, sobre la base real):
//   await rutacash.diagnostico()            → informe de texto de la empresa activa
//   await rutacash.diagnosticoJSON()        → datos crudos para exportar
// ============================================================
import { db } from '@/lib/db'
import { effectivePayments } from '@/services/paymentCorrectionService'
import { formatCurrency } from '@/lib/formatters'
import type { Client, Installment, Payment, Route, Sale } from '@/models/types'

// ------------------------------------------------------------
// Contrato de base de datos (solo lectura)
// ------------------------------------------------------------
export interface ReadOnlyTable<T> {
  toArray(): Promise<T[]>
}

/** Superficie mínima y EXCLUSIVAMENTE de lectura que necesita el diagnóstico. */
export interface ReconciliationDatabase {
  sales: ReadOnlyTable<Sale>
  installments: ReadOnlyTable<Installment>
  payments: ReadOnlyTable<Payment>
  clients?: ReadOnlyTable<Client>
  routes?: ReadOnlyTable<Route>
}

// ------------------------------------------------------------
// Catálogo de inconsistencias
// ------------------------------------------------------------
export type LegacyIssueCode =
  | 'LEGACY-001' | 'LEGACY-002' | 'LEGACY-003'
  | 'LEGACY-004' | 'LEGACY-005' | 'LEGACY-006'

export type IssueSeverity = 'alta' | 'media'

interface IssueMeta {
  label: string
  severity: IssueSeverity
  explicacion: string
}

export const LEGACY_ISSUES: Record<LegacyIssueCode, IssueMeta> = {
  'LEGACY-001': {
    label: 'Sobrepago histórico',
    severity: 'alta',
    explicacion: 'Se cobró más dinero del que se aplicó a la deuda. El excedente entró en caja pero no redujo cartera.',
  },
  'LEGACY-002': {
    label: 'Aplicado sin respaldo en pagos',
    severity: 'alta',
    explicacion: 'Las parcelas registran más abonado que los pagos efectivos. Puede venir de una escritura parcial o de un pago eliminado.',
  },
  'LEGACY-003': {
    label: 'Deriva del saldo agregado',
    severity: 'media',
    explicacion: '`sale.saldo` (copia denormalizada) no coincide con la suma de saldos de las parcelas (libro mayor).',
  },
  'LEGACY-004': {
    label: 'Venta finalizada con deuda',
    severity: 'alta',
    explicacion: 'La venta figura como finalizada pero sus parcelas conservan saldo pendiente.',
  },
  'LEGACY-005': {
    label: 'Venta activa sin deuda',
    severity: 'media',
    explicacion: 'La venta sigue activa pero sus parcelas ya están saldadas: debería estar finalizada.',
  },
  'LEGACY-006': {
    label: 'Parcela con importes imposibles',
    severity: 'alta',
    explicacion: 'Alguna parcela tiene `pagado > valor` o `saldo < 0`.',
  },
}

export interface LegacyIssue {
  code: LegacyIssueCode
  label: string
  severity: IssueSeverity
  /** Magnitud del desajuste en dinero (0 cuando el problema es de estado). */
  diferencia: number
  detalle: string
}

export interface SaleReconciliation {
  saleId: string
  clientId: string
  clientName: string
  routeId: string
  routeName: string
  tenantId: string
  status: Sale['status']
  disbursementStatus?: Sale['disbursementStatus']
  /** Capital original de la venta (valor prestado + interés). */
  capitalOriginal: number
  /** Σ de los pagos EFECTIVOS (excluye revertidos y asientos de reversión). */
  paymentsEfectivos: number
  /** Σ `installments.pagado`. */
  aplicadoAParcelas: number
  /** `sale.saldo` tal y como está guardado. */
  saldoVenta: number
  /** Σ `installments.saldo` (libro mayor). */
  saldoParcelas: number
  installmentsCount: number
  /** Pagos descartados por la semántica de corrección (informativo). */
  paymentsExcluidos: number
  issues: LegacyIssue[]
}

export interface RouteImpact {
  routeId: string
  routeName: string
  ventasAfectadas: number
  diferenciaTotal: number
  porCodigo: Partial<Record<LegacyIssueCode, number>>
}

export interface ReconciliationReport {
  generadoEn: string
  tenantId: string | 'TODOS'
  ventasAnalizadas: number
  ventasConInconsistencias: number
  /** Ventas activas sin ninguna parcela generada (dato inconsistente aparte). */
  ventasSinParcelas: number
  conteoPorCodigo: Record<LegacyIssueCode, number>
  diferenciaTotal: number
  filas: SaleReconciliation[]
  porRuta: RouteImpact[]
  /** true si no se encontró ninguna inconsistencia. */
  limpio: boolean
}

export interface ReconcileOptions {
  /** Limita el análisis a una empresa. Si se omite, analiza todas. */
  tenantId?: string
  /** Tolerancia en unidades monetarias. RutaCash trabaja con enteros: 0 por defecto. */
  tolerancia?: number
  /** Fecha/hora del informe (inyectable para que las pruebas sean deterministas). */
  ahora?: string
}

// ------------------------------------------------------------
// Análisis
// ------------------------------------------------------------
/**
 * Analiza las ventas y devuelve un informe de inconsistencias. **No escribe nada.**
 * `database` permite inyectar una base en memoria en las pruebas; en la aplicación
 * siempre se usa el `db` real.
 */
export async function reconcileFinancials(
  options: ReconcileOptions = {},
  database: ReconciliationDatabase = db,
): Promise<ReconciliationReport> {
  const tolerancia = options.tolerancia ?? 0
  const [sales, installments, payments] = await Promise.all([
    database.sales.toArray(),
    database.installments.toArray(),
    database.payments.toArray(),
  ])
  const clients = database.clients ? await database.clients.toArray() : []
  const routes = database.routes ? await database.routes.toArray() : []

  const clientName = new Map(clients.map(c => [c.id, c.nombre]))
  const routeName = new Map(routes.map(r => [r.id, r.nombre]))

  const instBySale = new Map<string, Installment[]>()
  for (const i of installments) {
    const arr = instBySale.get(i.saleId) ?? []
    arr.push(i)
    instBySale.set(i.saleId, arr)
  }
  const paysBySale = new Map<string, Payment[]>()
  for (const p of payments) {
    const arr = paysBySale.get(p.saleId) ?? []
    arr.push(p)
    paysBySale.set(p.saleId, arr)
  }

  const target = options.tenantId ? sales.filter(s => s.tenantId === options.tenantId) : sales

  const filas: SaleReconciliation[] = []
  let ventasSinParcelas = 0

  for (const sale of target) {
    const insts = (instBySale.get(sale.id) ?? []).slice().sort((a, b) => a.numero - b.numero)
    const todosLosPagos = paysBySale.get(sale.id) ?? []
    // SEMÁNTICA COMPARTIDA: nunca una suma ingenua de todas las filas.
    const efectivos = effectivePayments(todosLosPagos)

    const paymentsEfectivos = efectivos.reduce((s, p) => s + p.valor, 0)
    const aplicadoAParcelas = insts.reduce((s, i) => s + i.pagado, 0)
    const saldoParcelas = insts.reduce((s, i) => s + i.saldo, 0)

    const fila: SaleReconciliation = {
      saleId: sale.id,
      clientId: sale.clientId,
      clientName: clientName.get(sale.clientId) ?? '(cliente no encontrado)',
      routeId: sale.routeId,
      routeName: routeName.get(sale.routeId) ?? sale.routeId,
      tenantId: sale.tenantId,
      status: sale.status,
      disbursementStatus: sale.disbursementStatus,
      capitalOriginal: sale.valorTotal,
      paymentsEfectivos,
      aplicadoAParcelas,
      saldoVenta: sale.saldo,
      saldoParcelas,
      installmentsCount: insts.length,
      paymentsExcluidos: todosLosPagos.length - efectivos.length,
      issues: [],
    }

    if (insts.length === 0) {
      ventasSinParcelas++
    }

    // LEGACY-001 — se cobró más de lo que se aplicó a la deuda.
    const excedente = paymentsEfectivos - aplicadoAParcelas
    if (excedente > tolerancia) {
      fila.issues.push({
        code: 'LEGACY-001',
        label: LEGACY_ISSUES['LEGACY-001'].label,
        severity: 'alta',
        diferencia: excedente,
        detalle: `Pagos efectivos ${paymentsEfectivos} vs aplicado a parcelas ${aplicadoAParcelas}: sobran ${excedente}.`,
      })
    }

    // LEGACY-002 — las parcelas registran más abonado que los pagos efectivos.
    if (-excedente > tolerancia) {
      fila.issues.push({
        code: 'LEGACY-002',
        label: LEGACY_ISSUES['LEGACY-002'].label,
        severity: 'alta',
        diferencia: -excedente,
        detalle: `Aplicado a parcelas ${aplicadoAParcelas} vs pagos efectivos ${paymentsEfectivos}: faltan ${-excedente} de respaldo.`,
      })
    }

    // LEGACY-003 — el saldo denormalizado no coincide con el libro mayor.
    if (insts.length > 0 && Math.abs(sale.saldo - saldoParcelas) > tolerancia) {
      fila.issues.push({
        code: 'LEGACY-003',
        label: LEGACY_ISSUES['LEGACY-003'].label,
        severity: 'media',
        diferencia: Math.abs(sale.saldo - saldoParcelas),
        detalle: `sale.saldo ${sale.saldo} vs Σ saldo parcelas ${saldoParcelas}.`,
      })
    }

    // LEGACY-004 — finalizada pero con deuda viva.
    if (sale.status === 'finalizada' && saldoParcelas > tolerancia) {
      fila.issues.push({
        code: 'LEGACY-004',
        label: LEGACY_ISSUES['LEGACY-004'].label,
        severity: 'alta',
        diferencia: saldoParcelas,
        detalle: `Venta finalizada con ${saldoParcelas} pendientes en parcelas.`,
      })
    }

    // LEGACY-005 — activa pero ya saldada.
    if (sale.status === 'activa' && insts.length > 0 && saldoParcelas <= tolerancia) {
      fila.issues.push({
        code: 'LEGACY-005',
        label: LEGACY_ISSUES['LEGACY-005'].label,
        severity: 'media',
        diferencia: 0,
        detalle: 'Venta activa con todas las parcelas saldadas: debería figurar como finalizada.',
      })
    }

    // LEGACY-006 — importes imposibles en alguna parcela.
    const malas = insts.filter(i => i.pagado > i.valor || i.saldo < 0)
    if (malas.length > 0) {
      fila.issues.push({
        code: 'LEGACY-006',
        label: LEGACY_ISSUES['LEGACY-006'].label,
        severity: 'alta',
        diferencia: malas.reduce((s, i) => s + Math.max(0, i.pagado - i.valor) + Math.max(0, -i.saldo), 0),
        detalle: `Parcelas afectadas: ${malas.map(i => `#${i.numero} (pagado ${i.pagado}/${i.valor}, saldo ${i.saldo})`).join('; ')}.`,
      })
    }

    filas.push(fila)
  }

  const conFallos = filas.filter(f => f.issues.length > 0)

  const conteoPorCodigo = Object.keys(LEGACY_ISSUES).reduce((acc, code) => {
    acc[code as LegacyIssueCode] = 0
    return acc
  }, {} as Record<LegacyIssueCode, number>)
  for (const f of conFallos) {
    for (const i of f.issues) conteoPorCodigo[i.code]++
  }

  // Impacto por ruta. La diferencia se cuenta UNA vez por venta (la mayor de sus
  // incidencias) para no sumar dos veces el mismo dinero cuando LEGACY-001 y
  // LEGACY-003 describen el mismo desajuste.
  const porRutaMap = new Map<string, RouteImpact>()
  for (const f of conFallos) {
    const cur = porRutaMap.get(f.routeId) ?? {
      routeId: f.routeId, routeName: f.routeName, ventasAfectadas: 0, diferenciaTotal: 0, porCodigo: {},
    }
    cur.ventasAfectadas++
    cur.diferenciaTotal += Math.max(...f.issues.map(i => i.diferencia), 0)
    for (const i of f.issues) cur.porCodigo[i.code] = (cur.porCodigo[i.code] ?? 0) + 1
    porRutaMap.set(f.routeId, cur)
  }
  const porRuta = [...porRutaMap.values()].sort((a, b) => b.diferenciaTotal - a.diferenciaTotal)

  return {
    generadoEn: options.ahora ?? new Date().toISOString(),
    tenantId: options.tenantId ?? 'TODOS',
    ventasAnalizadas: filas.length,
    ventasConInconsistencias: conFallos.length,
    ventasSinParcelas,
    conteoPorCodigo,
    diferenciaTotal: porRuta.reduce((s, r) => s + r.diferenciaTotal, 0),
    filas,
    porRuta,
    limpio: conFallos.length === 0,
  }
}

// ------------------------------------------------------------
// Presentación
// ------------------------------------------------------------
/** Informe legible en texto plano. Solo formatea: no consulta ni escribe. */
export function formatReconciliationReport(report: ReconciliationReport, currency = 'COP'): string {
  const money = (n: number) => formatCurrency(n, currency)
  const L: string[] = []
  const sep = '─'.repeat(100)

  L.push('='.repeat(100))
  L.push('RUTACASH — CONCILIACIÓN FINANCIERA (SOLO LECTURA)')
  L.push(`Generado: ${report.generadoEn}   ·   Empresa: ${report.tenantId}`)
  L.push('='.repeat(100))
  L.push(`Ventas analizadas: ${report.ventasAnalizadas}`)
  L.push(`Ventas con inconsistencias: ${report.ventasConInconsistencias}`)
  if (report.ventasSinParcelas > 0) L.push(`Ventas sin parcelas generadas: ${report.ventasSinParcelas}`)

  if (report.limpio) {
    L.push('')
    L.push('RESULTADO: SIN INCONSISTENCIAS. Los datos de esta base están cuadrados.')
    L.push('No se requiere ninguna conciliación.')
    L.push('='.repeat(100))
    return L.join('\n')
  }

  L.push('')
  L.push('CONTEO POR TIPO')
  L.push(sep)
  for (const [code, meta] of Object.entries(LEGACY_ISSUES)) {
    const n = report.conteoPorCodigo[code as LegacyIssueCode]
    if (n > 0) L.push(`  ${code}  ${String(n).padStart(4)}  ${meta.label} — ${meta.explicacion}`)
  }

  L.push('')
  L.push('DETALLE POR VENTA')
  L.push(sep)
  L.push(
    ['Venta', 'Cliente', 'Ruta', 'Tipo', 'Pagos efec.', 'Aplicado', 'Saldo venta', 'Saldo parcelas', 'Diferencia']
      .map((h, idx) => h.padEnd([10, 20, 14, 12, 14, 14, 14, 15, 12][idx])).join(''),
  )
  for (const f of report.filas.filter(x => x.issues.length > 0)) {
    for (const i of f.issues) {
      L.push([
        f.saleId.slice(0, 8).padEnd(10),
        f.clientName.slice(0, 19).padEnd(20),
        f.routeName.slice(0, 13).padEnd(14),
        i.code.padEnd(12),
        money(f.paymentsEfectivos).padStart(13) + ' ',
        money(f.aplicadoAParcelas).padStart(13) + ' ',
        money(f.saldoVenta).padStart(13) + ' ',
        money(f.saldoParcelas).padStart(14) + ' ',
        money(i.diferencia).padStart(12),
      ].join(''))
    }
  }

  L.push('')
  L.push('IMPACTO POR RUTA')
  L.push(sep)
  L.push(['Ruta', 'Ventas afectadas', 'Diferencia total'].map((h, idx) => h.padEnd([30, 20, 20][idx])).join(''))
  for (const r of report.porRuta) {
    L.push([
      r.routeName.slice(0, 29).padEnd(30),
      String(r.ventasAfectadas).padEnd(20),
      money(r.diferenciaTotal).padStart(18),
    ].join(''))
  }

  L.push('')
  L.push(`DIFERENCIA TOTAL ACUMULADA: ${money(report.diferenciaTotal)}`)
  L.push('')
  L.push('Este informe NO corrige nada. Cualquier ajuste debe decidirse manualmente.')
  L.push('='.repeat(100))
  return L.join('\n')
}

// ------------------------------------------------------------
// Acceso desde la consola del navegador
// ------------------------------------------------------------
/**
 * Publica el diagnóstico en `window.rutacash` para poder ejecutarlo desde la consola
 * de DevTools sobre la base real de un navegador concreto. Solo expone funciones de
 * LECTURA; no hay ninguna operación de escritura accesible por esta vía.
 */
export function exposeReconciliationConsole(): void {
  if (typeof window === 'undefined') return
  const api = {
    async diagnostico(tenantId?: string) {
      const report = await reconcileFinancials({ tenantId })
      console.log(formatReconciliationReport(report))
      return report.limpio ? 'SIN INCONSISTENCIAS' : `${report.ventasConInconsistencias} venta(s) con inconsistencias`
    },
    async diagnosticoJSON(tenantId?: string) {
      return reconcileFinancials({ tenantId })
    },
    /**
     * Últimos pagos auditados (solo lectura). No existe pantalla de auditoría;
     * esta vista permite verificar la trazabilidad durante las pruebas manuales.
     */
    async auditoriaPagos(limite = 10) {
      const logs = await db.auditLogs.toArray()
      const filas = logs
        .filter(l => l.action === 'REGISTER_PAYMENT')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limite)
        .map(l => {
          const m = (l.metadata ?? {}) as Record<string, unknown>
          return {
            fecha: l.createdAt,
            actor: l.userId,
            rol: l.userRole,
            ruta: l.routeId,
            paymentId: l.entityId,
            solicitado: m.requestedAmount,
            aplicado: m.appliedAmount,
            topado: m.capped,
            excedenteRechazado: m.cappedAmount,
            saldoAntes: m.previousBalance,
            saldoDespues: m.newBalance,
          }
        })
      console.table(filas)
      return filas
    },
  }
  ;(window as unknown as Record<string, unknown>).rutacash = api
}
