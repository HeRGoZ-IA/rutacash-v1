// ============================================================
// RUTACASH — SUITE FINANCIERA
// ------------------------------------------------------------
// Mismo mecanismo que tests/permissions.test.ts: sin framework, esbuild + node.
//   npm run test:financial
//
// Desde la ETAPA 2 los casos ejecutan el SERVICIO REAL de producción
// (`src/services/paymentService.registerPayment`) sobre una base en memoria que
// replica la superficie de Dexie usada, incluida la transacción con rollback.
//
// SEMÁNTICA CONVENCIONAL: todos los casos deben pasar.
//   cualquier caso fallido → exit code 1
//   todos pasando          → exit code 0
// No existen "FAIL esperados": un dato heredado inconsistente se prueba verificando
// que el DIAGNÓSTICO lo detecta, no declarando el fallo como aceptable.
// ============================================================
import {
  generateInstallments, calculateTotalWithInterest, applyPaymentToInstallments,
  calculateSaleBalance, calculateCurrentInstallment, getLastPaidInstallmentNumber,
  recalculateSaleFromPayments,
} from '../src/services/installmentEngine'
import { quickAmounts, registerPayment, type PaymentDatabase, type AuditSink } from '../src/services/paymentService'
import {
  reconcileFinancials, formatReconciliationReport, LEGACY_ISSUES,
  type ReconciliationDatabase, type LegacyIssueCode,
} from '../src/services/financialReconciliation'
import type { Sale, User, Payment, AuditLog } from '../src/models/types'
import {
  buildScenario, buildCashboxScenario, readFinancialState, computeCobrosComoCaja, TEST_IDS,
  MemoryDb, type FinancialState,
} from './financial/harness'
import {
  createRouteWithAdmins, updateRouteWithAssignments, type RouteDatabase,
} from '../src/services/routeService'
import { getCashboxSummary, type CashboxDatabase } from '../src/services/cashboxEngine'
import {
  buildReport, resolveReportRouteIds, REPORT_OPTIONS,
  type ReportSources,
} from '../src/services/reportService'
import {
  generateWeeklySettlement, generateWeeklySettlementForUser,
} from '../src/services/weeklySettlementEngine'
import {
  buildClientCreditHistory, resolveSealedCompletionDate, CREDIT_STATUS_LABEL,
} from '../src/lib/creditHistory'
import { effectivePayments, lastEffectivePaymentDate } from '../src/lib/paymentState'
import { getCollectorDailyCashSummary, hasCapitalForSale, type CollectorCashDatabase } from '../src/services/cashboxEngine'
import { adminQuickPaymentFlow, operationalPaymentFlow } from './financial/flows'
import {
  adminHandlerBody, operationalHandlerBody, paymentServiceBody, opensDexieTransaction,
  writeSequence, capsAmountToBalance, validatesDisbursement, validatesSaleStatus,
  checksPaymentCapability, refetchesInstallments, supervisorSharesPaymentComponent,
  cashboxSumsRawPaymentValor, delegatesToPaymentService, correctionRecomputesInsideTransaction,
  containsLine, dexieWriteOperations, auditsOutsideTransaction, readSource, SRC,
  extractTransactionScope,
} from './financial/sourceContract'

// ============================================================
// Mini-runner (convencional: pasa o falla)
// ============================================================
interface Result {
  id: string; group: string; desc: string
  passed: boolean
  error?: string
  metrics: string[]
}

const results: Result[] = []
let current: string[] = []

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}
function metric(label: string, value: unknown) {
  current.push(`${label}: ${typeof value === 'number' ? value.toLocaleString('es-CO') : String(value)}`)
}

async function spec(id: string, group: string, desc: string, fn: () => Promise<void> | void) {
  current = []
  let passed = true
  let error: string | undefined
  try {
    await fn()
  } catch (e) {
    passed = false
    error = e instanceof Error ? e.message : String(e)
  }
  results.push({ id, group, desc, passed, error, metrics: [...current] })
}

// ============================================================
// Utilidades comunes
// ============================================================
const USER_ADMIN: User = {
  id: 'u-admin', tenantId: TEST_IDS.TENANT_ID, nombre: 'Admin', email: 'a@t.com', password: 'x',
  rol: 'admin', status: 'activo', authorizedRouteIds: [TEST_IDS.ROUTE_ID], createdAt: '', updatedAt: '',
}
const USER_COBRADOR: User = { ...USER_ADMIN, id: 'u-cob', nombre: 'Cobrador', rol: 'cobrador' }
const USER_SUPERVISOR: User = { ...USER_ADMIN, id: 'u-sup', nombre: 'Supervisor', rol: 'supervisor' }
/** Cobrador de OTRA ruta: no debe poder cobrar esta venta. */
const USER_OTRA_RUTA: User = { ...USER_COBRADOR, id: 'u-otro', authorizedRouteIds: ['route-ajena'] }
/** Socio: perfil de consulta, sin capacidad `payment.register`. */
const USER_SOCIO: User = { ...USER_ADMIN, id: 'u-socio', nombre: 'Socio', rol: 'socio' }

const asDb = (db: MemoryDb) => db as unknown as PaymentDatabase
const asRead = (db: MemoryDb) => db as unknown as ReconciliationDatabase
/** Fecha fija: los informes deben ser deterministas. */
const FECHA_FIJA = '2026-08-19T12:00:00.000Z'

/** Sumidero de auditoría de prueba: acumula en memoria; puede simular un fallo. */
function makeAuditSink(options: { failWith?: string } = {}) {
  const entries: Array<Parameters<AuditSink>[0]> = []
  const sink: AuditSink = async (params) => {
    if (options.failWith) throw new Error(options.failWith)
    entries.push(params)
  }
  return { sink, entries }
}

async function runAdmin(opts: Parameters<typeof buildScenario>[0], valor: number, user: User = USER_ADMIN) {
  const sc = buildScenario(opts)
  const res = await adminQuickPaymentFlow(sc.db, { paymentValor: valor, paymentSale: sc.sale, user })
  return { ...sc, res, state: await readFinancialState(sc.db) }
}

async function runOperational(opts: Parameters<typeof buildScenario>[0], valor: number, user: User = USER_COBRADOR) {
  const sc = buildScenario(opts)
  const res = await operationalPaymentFlow(sc.db, { valor, sale: sc.sale, user, installments: sc.installments })
  return { ...sc, res, state: await readFinancialState(sc.db) }
}

/** Escenario canónico: saldo 100.000 en 5 parcelas de 20.000. */
const ESC_100K = { valorVenta: 83333, tasaInteres: 20, numeroCuotas: 5 } as const
/** Escenario canónico: saldo 120.000 en 10 parcelas de 12.000. */
const ESC_120K = { valorVenta: 100000, tasaInteres: 20, numeroCuotas: 10 } as const
/** Escenario de redondeo: total 240.000 en 7 parcelas (6× 34.286 + 1× 34.284). */
const ESC_REDONDEO = { valorVenta: 200000, tasaInteres: 20, numeroCuotas: 7 } as const

const resumenParcelas = (s: FinancialState) =>
  s.parcelas.filter(p => p.pagado > 0).map(p => `#${p.numero}=${p.pagado}/${p.valor}`).join(',') || '(ninguna con abono)'

function diffStates(a: FinancialState, b: FinancialState): string[] {
  const out: string[] = []
  const cmp = (k: string, x: unknown, y: unknown) => {
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${k}: ADMIN=${JSON.stringify(x)} vs OPERATIVO=${JSON.stringify(y)}`)
  }
  cmp('saleSaldo', a.saleSaldo, b.saleSaldo)
  cmp('saleStatus', a.saleStatus, b.saleStatus)
  cmp('totalAplicadoAParcelas', a.totalAplicadoAParcelas, b.totalAplicadoAParcelas)
  cmp('totalRegistradoEnPayments', a.totalRegistradoEnPayments, b.totalRegistradoEnPayments)
  cmp('parcelaActual', a.parcelaActual, b.parcelaActual)
  cmp('ultimaParcelaPagada', a.ultimaParcelaPagada, b.ultimaParcelaPagada)
  if (JSON.stringify(a.parcelas) !== JSON.stringify(b.parcelas)) {
    out.push(`parcelas: ADMIN=[${resumenParcelas(a)}] vs OPERATIVO=[${resumenParcelas(b)}]`)
  }
  return out
}

// ############################################################
// GRUPO 0 — ARQUITECTURA (contrato con el código fuente)
// ############################################################
await spec('SRC-001', 'Arquitectura', 'ActiveSalesPage delega el pago y no escribe dinero por su cuenta', () => {
  const body = adminHandlerBody()
  const writes = writeSequence(body)
  metric('delega en registerPayment', delegatesToPaymentService(body))
  metric('escrituras propias de dinero', writes.length === 0 ? 'ninguna' : writes.join(' → '))
  assert(delegatesToPaymentService(body), 'handleQuickPayment ya no llama a registerPayment')
  assert(writes.length === 0, `handleQuickPayment reintrodujo escrituras propias: ${writes.join(' → ')}`)
  assert(!containsLine(body, 'applyPaymentToInstallments'), 'handleQuickPayment volvió a aplicar parcelas por su cuenta')
  assert(!containsLine(body, 'calculateSaleBalance'), 'handleQuickPayment volvió a calcular el saldo por su cuenta')
})

await spec('SRC-002', 'Arquitectura', 'PaymentPage delega el abono y no escribe dinero por su cuenta', () => {
  const body = operationalHandlerBody()
  const writes = writeSequence(body)
  metric('delega en registerPayment', delegatesToPaymentService(body))
  metric('escrituras propias de dinero', writes.length === 0 ? 'ninguna' : writes.join(' → '))
  assert(delegatesToPaymentService(body), 'handlePay ya no llama a registerPayment')
  assert(writes.length === 0, `handlePay reintrodujo escrituras propias: ${writes.join(' → ')}`)
  assert(!containsLine(body, 'applyPaymentToInstallments'), 'handlePay volvió a aplicar parcelas por su cuenta')
})

await spec('SRC-003', 'Arquitectura', 'Supervisor y Cobrador montan el MISMO componente de pago', () => {
  const r = supervisorSharesPaymentComponent()
  metric('operationalRoutes() montada veces', r.mounts)
  metric('<PaymentPage /> declarado veces', r.declarations)
  assert(r.shares, `App.tsx ya no comparte PaymentPage (mounts=${r.mounts}, declarations=${r.declarations})`)
})

await spec('SRC-004', 'Arquitectura', 'todas las reglas financieras viven en paymentService', () => {
  const svc = paymentServiceBody()
  metric('relee parcelas desde la base', refetchesInstallments(svc))
  metric('valida capacidad payment.register', checksPaymentCapability(svc))
  metric('valida estado de la venta', validatesSaleStatus(svc))
  metric('valida desembolso', validatesDisbursement(svc))
  metric('topa el importe al saldo', capsAmountToBalance(svc))
  metric('abre transacción', opensDexieTransaction(svc))
  metric('escrituras dentro del servicio', writeSequence(svc).join(' → '))
  assert(refetchesInstallments(svc), 'el servicio no relee las parcelas desde la base')
  assert(checksPaymentCapability(svc), 'el servicio no valida la capacidad payment.register')
  assert(validatesSaleStatus(svc), 'el servicio no valida el estado de la venta')
  assert(validatesDisbursement(svc), 'el servicio no valida el estado de desembolso')
  assert(capsAmountToBalance(svc), 'el servicio no topa el importe al saldo')
  assert(opensDexieTransaction(svc), 'el servicio no abre una transacción')
})

await spec('SRC-005', 'Arquitectura', 'paymentCorrectionService recomputa la venta DENTRO de su transacción', () => {
  const inside = correctionRecomputesInsideTransaction()
  metric('recomputeSale dentro de db.transaction', inside)
  assert(inside, 'executeCorrection volvió a recomputar la venta fuera de la transacción')
})

await spec('SRC-006', 'Arquitectura', 'la auditoría del pago ocurre FUERA de la transacción financiera', () => {
  const fuera = auditsOutsideTransaction()
  metric('auditSink invocado fuera del ámbito transaccional', fuera)
  assert(fuera, 'la auditoría entró dentro de la transacción: un fallo al auditar revertiría el pago')
})

await spec('SRC-007', 'Arquitectura', 'el módulo de conciliación es estrictamente de SOLO LECTURA', () => {
  const escrituras = dexieWriteOperations(readSource(SRC.reconciliation))
  metric('operaciones de escritura encontradas', escrituras.length === 0 ? 'ninguna' : escrituras.join(', '))
  assert(escrituras.length === 0, `financialReconciliation contiene escrituras: ${escrituras.join(', ')}`)
})

// ############################################################
// NIVEL A — MOTOR PURO (sin cambios: se conserva como red anti-regresión)
// ############################################################
await spec('PAY-001', 'Motor puro', 'pago parcial mantiene venta activa', () => {
  const { valorTotal } = calculateTotalWithInterest({ valorVenta: ESC_100K.valorVenta, tasaInteres: 20 })
  const insts = generateInstallments({ saleId: 's', valorTotal, numeroCuotas: 5, valorCuota: Math.round(valorTotal / 5), frecuencia: 'diaria', fechaInicio: '2026-08-19' })
  metric('saldo inicial', calculateSaleBalance(insts))
  const { updatedInstallments } = applyPaymentToInstallments(insts, 5000)
  const saldo = calculateSaleBalance(updatedInstallments)
  metric('pago', 5000)
  metric('saldo final', saldo)
  metric('parcela 1', `${updatedInstallments[0].status} pagado=${updatedInstallments[0].pagado}`)
  assert(valorTotal === 100000, `valorTotal esperado 100000, obtenido ${valorTotal}`)
  assert(updatedInstallments[0].status === 'parcial', 'la parcela debía quedar parcial')
  assert(updatedInstallments[0].pagado === 5000, 'pagado debía aumentar exactamente 5.000')
  assert(saldo === 95000, 'el saldo de la venta debía bajar exactamente 5.000')
})

await spec('PAY-002', 'Motor puro', 'completar parcela avanza a la siguiente', () => {
  const sc = buildScenario({ ...ESC_100K, abonoPrevioParcelaActual: 15000 })
  const { updatedInstallments } = applyPaymentToInstallments(sc.installments, 5000)
  metric('parcela 1 después', `${updatedInstallments[0].status} pagado=${updatedInstallments[0].pagado}`)
  metric('parcela actual', calculateCurrentInstallment(updatedInstallments)?.numero)
  assert(updatedInstallments[0].status === 'pagada', 'la parcela 1 debía quedar pagada')
  assert(calculateCurrentInstallment(updatedInstallments)?.numero === 2, 'la parcela actual debía pasar a la 2')
  assert(getLastPaidInstallmentNumber(updatedInstallments) === 1, 'la última pagada debía ser la 1')
  assert(calculateSaleBalance(updatedInstallments) === 80000, 'el saldo debía quedar en 80.000')
})

await spec('PAY-003', 'Motor puro', 'pago cubre múltiples parcelas con distribución correcta', () => {
  const sc = buildScenario(ESC_100K)
  const { updatedInstallments: p } = applyPaymentToInstallments(sc.installments, 50000)
  metric('distribución', p.map(i => `#${i.numero}=${i.pagado}/${i.valor}(${i.status})`).join(' '))
  assert(p[0].pagado === 20000 && p[0].status === 'pagada', 'parcela 1 debía quedar pagada al 100%')
  assert(p[1].pagado === 20000 && p[1].status === 'pagada', 'parcela 2 debía quedar pagada al 100%')
  assert(p[2].pagado === 10000 && p[2].saldo === 10000 && p[2].status === 'parcial', 'parcela 3 debía quedar parcial 10.000/20.000')
  assert(p[3].pagado === 0 && p[4].pagado === 0, 'parcelas 4 y 5 no debían recibir nada')
  assert(calculateSaleBalance(p) === 50000, 'el saldo debía quedar en 50.000')
})

await spec('PAY-004', 'Motor puro', 'pago exacto del saldo total finaliza la venta sin negativos', () => {
  const sc = buildScenario(ESC_100K)
  const { updatedInstallments, saldoRestante } = applyPaymentToInstallments(sc.installments, 100000)
  metric('aplicado a parcelas', updatedInstallments.reduce((s, i) => s + i.pagado, 0))
  metric('excedente', saldoRestante)
  assert(calculateSaleBalance(updatedInstallments) === 0, 'el saldo debía quedar en 0')
  assert(saldoRestante === 0, 'no debía sobrar nada')
  assert(updatedInstallments.every(i => i.saldo >= 0), 'ninguna parcela puede quedar con saldo negativo')
})

// ############################################################
// NIVEL B — FLUJO ADMIN (servicio real + persistencia)
// ############################################################
await spec('PAY-101', 'Flujo Admin', 'pago parcial: payments, parcelas y venta coherentes', async () => {
  const r = await runAdmin(ESC_100K, 5000)
  metric('payments.valor', r.state.totalRegistradoEnPayments)
  metric('aplicado a parcelas', r.state.totalAplicadoAParcelas)
  metric('saldo venta', r.state.saleSaldo)
  metric('estado venta', r.state.saleStatus)
  assert(r.res.ok, `el pago debía registrarse (${r.res.message})`)
  assert(r.state.totalRegistradoEnPayments === 5000 && r.state.totalAplicadoAParcelas === 5000, 'payments y aplicado debían ser 5.000')
  assert(r.state.saleSaldo === 95000 && r.state.saleStatus === 'activa', 'saldo 95.000 y venta activa')
})

await spec('PAY-102', 'Flujo Admin', 'completar parcela persiste el salto a la siguiente', async () => {
  const r = await runAdmin({ ...ESC_100K, abonoPrevioParcelaActual: 15000 }, 5000)
  metric('parcela actual', r.state.parcelaActual)
  metric('parcelas cerradas por este pago', r.res.result?.installmentsCompleted.join(',') ?? '—')
  assert(r.state.ultimaParcelaPagada === 1 && r.state.parcelaActual === 2, 'debía saltar a la parcela 2')
  assert(r.state.saleSaldo === 80000, 'el saldo debía quedar en 80.000')
  assert(r.res.result?.installmentsCompleted.join(',') === '1', 'el servicio debía informar que cerró la parcela 1')
})

await spec('PAY-103', 'Flujo Admin', 'pago multi-parcela persiste la distribución exacta', async () => {
  const r = await runAdmin(ESC_100K, 50000)
  metric('distribución', r.state.parcelas.map(i => `#${i.numero}=${i.pagado}/${i.valor}`).join(' '))
  assert(r.state.parcelas[0].pagado === 20000 && r.state.parcelas[1].pagado === 20000, 'parcelas 1 y 2 debían cerrarse')
  assert(r.state.parcelas[2].pagado === 10000 && r.state.saleSaldo === 50000, 'parcela 3 con 10.000 y saldo 50.000')
})

await spec('PAY-104', 'Flujo Admin', 'pago exacto del saldo finaliza la venta en BD', async () => {
  const r = await runAdmin(ESC_100K, 100000)
  metric('saldo venta', r.state.saleSaldo)
  metric('estado venta', r.state.saleStatus)
  assert(r.state.saleSaldo === 0 && r.state.saleStatus === 'finalizada', 'la venta debía quedar finalizada en 0')
  assert(r.state.totalRegistradoEnPayments === r.state.totalAplicadoAParcelas, 'payments y aplicado debían coincidir')
})

// ############################################################
// NIVEL B — FLUJO OPERATIVO (Cobrador / Supervisor)
// ############################################################
await spec('PAY-201', 'Flujo Operativo', 'pago parcial: payments, parcelas y venta coherentes', async () => {
  const r = await runOperational(ESC_100K, 5000)
  metric('payments.valor', r.state.totalRegistradoEnPayments)
  metric('saldo venta', r.state.saleSaldo)
  assert(r.res.ok, `el abono debía registrarse (${r.res.message})`)
  assert(r.state.totalRegistradoEnPayments === 5000 && r.state.totalAplicadoAParcelas === 5000, 'payments y aplicado debían ser 5.000')
  assert(r.state.saleSaldo === 95000 && r.state.saleStatus === 'activa', 'saldo 95.000 y venta activa')
})

await spec('PAY-202', 'Flujo Operativo', 'completar parcela persiste el salto a la siguiente', async () => {
  const r = await runOperational({ ...ESC_100K, abonoPrevioParcelaActual: 15000 }, 5000)
  metric('parcela actual', r.state.parcelaActual)
  assert(r.state.ultimaParcelaPagada === 1 && r.state.parcelaActual === 2, 'debía saltar a la parcela 2')
  assert(r.state.saleSaldo === 80000, 'el saldo debía quedar en 80.000')
})

await spec('PAY-203', 'Flujo Operativo', 'pago multi-parcela persiste la distribución exacta', async () => {
  const r = await runOperational(ESC_100K, 50000)
  metric('distribución', r.state.parcelas.map(i => `#${i.numero}=${i.pagado}/${i.valor}`).join(' '))
  assert(r.state.parcelas[2].pagado === 10000 && r.state.saleSaldo === 50000, 'la distribución debía ser idéntica al motor')
})

await spec('PAY-204', 'Flujo Operativo', 'pago exacto del saldo finaliza la venta en BD', async () => {
  const r = await runOperational(ESC_100K, 100000)
  assert(r.state.saleSaldo === 0 && r.state.saleStatus === 'finalizada', 'la venta debía quedar finalizada en 0')
})

await spec('PAY-205', 'Flujo Operativo', 'Supervisor obtiene el mismo resultado que el Cobrador', async () => {
  const cob = await runOperational(ESC_100K, 30000, USER_COBRADOR)
  const sup = await runOperational(ESC_100K, 30000, USER_SUPERVISOR)
  const d = diffStates(cob.state, sup.state)
  metric('diferencias', d.length === 0 ? 'ninguna' : d.join(' | '))
  assert(d.length === 0, `Supervisor y Cobrador divergen: ${d.join(' | ')}`)
})

// ############################################################
// BUGS CORREGIDOS — RC-BUG-001 · TOPE AL SALDO
// ############################################################
await spec('RC-BUG-001', 'Bugs', 'pago superior al saldo se topa y no infla payments', async () => {
  const r = await runAdmin(ESC_120K, 170000)
  const registrado = r.state.totalRegistradoEnPayments
  const aplicado = r.state.totalAplicadoAParcelas
  metric('valor solicitado', r.res.result?.requestedAmount)
  metric('valor efectivo aplicado', r.res.result?.appliedAmount)
  metric('¿se topó?', r.res.result?.capped)
  metric('importe rechazado por el tope', r.res.result?.cappedAmount)
  metric('valor registrado en payments', registrado)
  metric('valor aplicado a parcelas', aplicado)
  metric('saldo restante de la venta', r.state.saleSaldo)
  metric('excedente', registrado - aplicado)
  metric('estado venta', r.state.saleStatus)
  assert(r.res.ok, 'el pago topado debe registrarse, no rechazarse')
  assert(registrado === 120000, `payments.valor debía ser 120.000 y fue ${registrado.toLocaleString('es-CO')}`)
  assert(registrado - aplicado === 0, 'no debe quedar excedente')
  assert(r.state.saleSaldo === 0, 'el saldo debía quedar exactamente en 0')
  assert(r.state.saleStatus === 'finalizada', 'la venta debía quedar finalizada')
  assert(r.res.result?.capped === true && r.res.result?.cappedAmount === 50000, 'el servicio debía informar el tope de 50.000 a la UI')
})

await spec('RC-BUG-001-OP', 'Bugs', 'sobrepago desde Cobrador/Supervisor se topa igual', async () => {
  const r = await runOperational(ESC_120K, 170000)
  metric('valor registrado en payments', r.state.totalRegistradoEnPayments)
  metric('valor aplicado a parcelas', r.state.totalAplicadoAParcelas)
  metric('¿se topó?', r.res.result?.capped)
  assert(r.state.totalRegistradoEnPayments === 120000, 'payments.valor debía ser 120.000')
  assert(r.state.saleSaldo === 0, 'el saldo debía quedar en 0')
})

await spec('RC-BUG-001-CAJA', 'Bugs', 'caja no cobra más de lo aplicado a cartera', async () => {
  const r = await runAdmin(ESC_120K, 170000)
  const cobros = await computeCobrosComoCaja(r.db)
  const descuadre = cobros - r.state.totalAplicadoAParcelas
  metric('cobros que suma cashboxEngine', cobros)
  metric('aplicado a cartera', r.state.totalAplicadoAParcelas)
  metric('DESCUADRE caja vs cartera', descuadre)
  metric('cashbox sigue sumando p.valor sin lógica compensatoria', cashboxSumsRawPaymentValor())
  assert(descuadre === 0, `descuadre de ${descuadre.toLocaleString('es-CO')} entre caja y cartera`)
  assert(cashboxSumsRawPaymentValor(), 'cashboxEngine no debe llevar parches compensatorios: la regla se resuelve en el origen')
})

// ############################################################
// BUGS CORREGIDOS — RC-BUG-002 · ATOMICIDAD
// ############################################################
await spec('RC-BUG-002-EST', 'Bugs', 'las escrituras del pago ocurren dentro de db.transaction', () => {
  const svc = paymentServiceBody()
  metric('secuencia de escrituras del servicio', writeSequence(svc).join(' → '))
  metric('servicio abre transacción', opensDexieTransaction(svc))
  metric('Admin — escrituras propias', writeSequence(adminHandlerBody()).length)
  metric('Operativo — escrituras propias', writeSequence(operationalHandlerBody()).length)
  assert(opensDexieTransaction(svc), 'registerPayment no abre una transacción Dexie')
  assert(writeSequence(adminHandlerBody()).length === 0, 'el Admin conserva escrituras fuera del servicio')
  assert(writeSequence(operationalHandlerBody()).length === 0, 'el flujo operativo conserva escrituras fuera del servicio')
})

await spec('RC-BUG-002', 'Bugs', 'un fallo a mitad del pago no deja escrituras parciales', async () => {
  const sc = buildScenario(ESC_120K)
  // Fallo inyectado en la 3ª actualización de parcela: el pago ya se escribió y
  // dos parcelas ya se modificaron dentro de la transacción.
  sc.db.injectFault({ op: 'installments.update', nth: 3, message: 'Fallo simulado de IndexedDB' })
  const res = await adminQuickPaymentFlow(sc.db, { paymentValor: 30000, paymentSale: sc.sale, user: USER_ADMIN })
  const st = await readFinancialState(sc.db)
  metric('resultado del handler', `${res.ok ? 'ok' : 'RECHAZADO(' + res.rejected + ')'} — ${res.message}`)
  metric('¿usó transacción?', sc.db.usedTransaction())
  metric('bitácora', sc.db.log.join(' → '))
  metric('payments tras el fallo', st.totalRegistradoEnPayments)
  metric('aplicado a parcelas tras el fallo', st.totalAplicadoAParcelas)
  metric('saldo de la venta tras el fallo', st.saleSaldo)
  assert(!res.ok && res.rejected === 'WRITE_FAILED', 'el servicio debía informar el fallo de escritura')
  assert(sc.db.usedTransaction(), 'la operación no se ejecutó dentro de una transacción')
  assert(sc.db.log.includes('transaction:rollback'), 'no se revirtió la transacción')
  assert(st.totalRegistradoEnPayments === 0, `quedó un pago de ${st.totalRegistradoEnPayments.toLocaleString('es-CO')} pese al fallo`)
  assert(st.totalAplicadoAParcelas === 0, 'quedaron parcelas modificadas pese al fallo')
  assert(st.saleSaldo === 120000, 'el saldo de la venta no debía cambiar')
})

await spec('RC-BUG-002-DESCUADRE', 'Bugs', 'tras un fallo intermedio, payments y cartera siguen cuadrados', async () => {
  const sc = buildScenario(ESC_120K)
  sc.db.injectFault({ op: 'installments.update', nth: 3, message: 'Fallo simulado de IndexedDB' })
  await adminQuickPaymentFlow(sc.db, { paymentValor: 30000, paymentSale: sc.sale, user: USER_ADMIN })
  const st = await readFinancialState(sc.db)
  const descuadre = st.totalRegistradoEnPayments - st.totalAplicadoAParcelas
  metric('payments', st.totalRegistradoEnPayments)
  metric('aplicado', st.totalAplicadoAParcelas)
  metric('descuadre', descuadre)
  assert(descuadre === 0, `descuadre de ${descuadre.toLocaleString('es-CO')} tras el fallo`)
})

// ############################################################
// BUGS CORREGIDOS — RC-BUG-003 · DESEMBOLSO
// ############################################################
await spec('RC-BUG-003', 'Bugs', 'Admin no puede cobrar una venta pendiente de desembolso', async () => {
  const r = await runAdmin({ ...ESC_120K, disbursementStatus: 'pendiente' }, 12000)
  metric('resultado', r.res.ok ? 'PAGO ACEPTADO' : `rechazado: ${r.res.rejected}`)
  metric('mensaje', r.res.message)
  metric('payments registrados', r.state.totalRegistradoEnPayments)
  assert(!r.res.ok && r.res.rejected === 'SALE_NOT_DISBURSED', 'el Admin debía rechazar el cobro')
  assert(r.state.totalRegistradoEnPayments === 0 && r.state.saleSaldo === 120000, 'no debía tocarse nada')
})

await spec('RC-BUG-003-OP', 'Bugs', 'Cobrador/Supervisor rechaza la venta pendiente de desembolso', async () => {
  const r = await runOperational({ ...ESC_120K, disbursementStatus: 'pendiente' }, 12000)
  metric('resultado', r.res.rejected ?? 'aceptado')
  assert(!r.res.ok && r.res.rejected === 'SALE_NOT_DISBURSED', 'el flujo operativo debía rechazar el cobro')
  assert(r.state.totalRegistradoEnPayments === 0, 'no debía registrarse ningún pago')
})

// ############################################################
// BUGS CORREGIDOS — RC-BUG-004 · ESTADO DE LA VENTA
// ############################################################
await spec('RC-BUG-004-FIN', 'Bugs', 'una venta finalizada no admite nuevos pagos (Admin)', async () => {
  const r = await runAdmin({ ...ESC_120K, parcelasPagadas: 10, status: 'finalizada' }, 50000)
  metric('resultado', r.res.ok ? 'PAGO ACEPTADO' : `rechazado: ${r.res.rejected}`)
  metric('payments registrados', r.state.totalRegistradoEnPayments)
  assert(!r.res.ok && r.res.rejected === 'SALE_NOT_ACTIVE', 'debía rechazarse por estado')
  assert(r.state.totalRegistradoEnPayments === 0, 'no debía registrarse dinero fantasma')
})

await spec('RC-BUG-004-FIN-OP', 'Bugs', 'una venta finalizada no admite nuevos pagos (Operativo)', async () => {
  const r = await runOperational({ ...ESC_120K, parcelasPagadas: 10, status: 'finalizada' }, 50000)
  metric('resultado', r.res.ok ? 'PAGO ACEPTADO' : `rechazado: ${r.res.rejected}`)
  assert(!r.res.ok && r.res.rejected === 'SALE_NOT_ACTIVE', 'debía rechazarse por estado')
  assert(r.state.totalRegistradoEnPayments === 0, 'no debía registrarse dinero fantasma')
})

await spec('RC-BUG-004-PERD', 'Bugs', 'una venta perdida no admite pagos ni resucita a activa', async () => {
  const r = await runAdmin({ ...ESC_120K, parcelasPagadas: 3, status: 'perdida' }, 12000)
  metric('estado inicial', 'perdida')
  metric('resultado', r.res.ok ? 'PAGO ACEPTADO' : `rechazado: ${r.res.rejected}`)
  metric('estado FINAL de la venta', r.state.saleStatus)
  assert(!r.res.ok && r.res.rejected === 'SALE_NOT_ACTIVE', 'debía rechazarse por estado')
  assert(r.state.saleStatus === 'perdida', `la venta pasó a '${r.state.saleStatus}': un pago no puede revivir una venta castigada`)
  assert(r.state.totalRegistradoEnPayments === 0, 'no debía registrarse ningún pago')
})

// ############################################################
// BUGS CORREGIDOS — RC-BUG-005 · ESTADO OBSOLETO (CONGELAMIENTO)
// ############################################################
await spec('RC-BUG-005', 'Bugs', 'el estado obsoleto de la pantalla no afecta al resultado', async () => {
  const sc = buildScenario(ESC_120K)
  // Instantánea que la pantalla del Cobrador cargó en el mount (todas pendientes).
  const parcelasEnPantalla = structuredClone(sc.installments)

  // Mientras tanto, otra interfaz (Admin) registra un abono sobre la MISMA venta.
  await adminQuickPaymentFlow(sc.db, { paymentValor: 12000, paymentSale: sc.sale, user: USER_ADMIN })
  const tras1 = await readFinancialState(sc.db)
  metric('tras el pago del Admin — saldo', tras1.saleSaldo)

  // El Cobrador registra su abono con la pantalla desactualizada.
  const r2 = await operationalPaymentFlow(sc.db, {
    valor: 12000, sale: sc.sale, user: USER_COBRADOR, installments: parcelasEnPantalla,
  })
  const st = await readFinancialState(sc.db)
  metric('el servicio relee la base', refetchesInstallments(paymentServiceBody()))
  metric('parcela informada por el servicio', r2.result?.paidInstallmentNumber)
  metric('payments registrados (2 abonos)', st.totalRegistradoEnPayments)
  metric('aplicado a parcelas', st.totalAplicadoAParcelas)
  metric('saldo final de la venta', st.saleSaldo)
  metric('dinero cobrado y no aplicado', st.totalRegistradoEnPayments - st.totalAplicadoAParcelas)
  assert(st.saleSaldo === 96000, `el saldo debía bajar a 96.000 tras dos abonos de 12.000; quedó en ${st.saleSaldo.toLocaleString('es-CO')}`)
  assert(st.totalAplicadoAParcelas === 24000, 'debían aplicarse 24.000 a las parcelas')
  assert(st.totalRegistradoEnPayments === 24000, 'debían registrarse 24.000 en payments')
  assert(r2.result?.paidInstallmentNumber === 2, 'el segundo abono debía aplicarse a la parcela 2, no a la 1')
})

// ############################################################
// BUGS CORREGIDOS — RC-BUG-006 · REDONDEO DE LA ÚLTIMA PARCELA
// ############################################################
await spec('RC-BUG-006', 'Bugs', 'el monto rápido usa el saldo real de la parcela, no el nominal', async () => {
  const sc = buildScenario({ ...ESC_REDONDEO, parcelasPagadas: 6 })
  const ultima = sc.installments[6]
  const qa = quickAmounts(sc.sale, sc.installments)
  metric('valorCuota nominal', sc.sale.valorCuota)
  metric('valor real de la última parcela', ultima.valor)
  metric('monto propuesto por "Completar parcela"', qa.parcela)
  assert(sc.sale.valorCuota === 34286 && ultima.valor === 34284, `escenario alterado: nominal=${sc.sale.valorCuota}, última=${ultima.valor}`)
  assert(qa.parcela === 34284, `el botón proponía ${qa.parcela}; debía proponer 34.284 (saldo real)`)

  const r = await adminQuickPaymentFlow(sc.db, { paymentValor: qa.parcela, paymentSale: sc.sale, user: USER_ADMIN })
  const st = await readFinancialState(sc.db)
  metric('registrado en payments', st.totalRegistradoEnPayments)
  metric('saldo final', st.saleSaldo)
  metric('excedente', r.result ? r.result.cappedAmount : '—')
  assert(st.totalRegistradoEnPayments === 34284, 'payments debía registrar exactamente el saldo real')
  assert(st.saleSaldo === 0 && st.saleStatus === 'finalizada', 'la venta debía cerrarse exactamente en 0')
})

await spec('RC-BUG-006-NOMINAL', 'Bugs', 'aunque se escriba el nominal, el servicio lo topa al saldo real', async () => {
  const sc = buildScenario({ ...ESC_REDONDEO, parcelasPagadas: 6 })
  const r = await adminQuickPaymentFlow(sc.db, { paymentValor: 34286, paymentSale: sc.sale, user: USER_ADMIN })
  const st = await readFinancialState(sc.db)
  metric('escrito por el usuario', 34286)
  metric('registrado en payments', st.totalRegistradoEnPayments)
  metric('excedente evitado', r.result?.cappedAmount)
  assert(st.totalRegistradoEnPayments === 34284, `payments registró ${st.totalRegistradoEnPayments}: debía toparse a 34.284`)
  assert(r.result?.cappedAmount === 2, 'el servicio debía informar los 2 de tope')
})

// ############################################################
// RECOMPUTACIÓN DESDE PAYMENTS
// ############################################################
await spec('REC-001', 'Recomputación', 'Σ payments = Σ aplicado tras recomputar una venta normal', async () => {
  const sc = buildScenario(ESC_120K)
  const pristinas = structuredClone(sc.installments)
  // Tres abonos por las dos interfaces, incluido uno que pide de más.
  await adminQuickPaymentFlow(sc.db, { paymentValor: 30000, paymentSale: sc.sale, user: USER_ADMIN })
  await operationalPaymentFlow(sc.db, { valor: 45000, sale: sc.sale, user: USER_COBRADOR })
  await adminQuickPaymentFlow(sc.db, { paymentValor: 999999, paymentSale: sc.sale, user: USER_ADMIN })

  const pagos = await sc.db.payments.toArray() as Payment[]
  const totalPayments = pagos.reduce((s, p) => s + p.valor, 0)
  const rec = recalculateSaleFromPayments(pristinas, pagos)
  const aplicado = rec.reduce((s, i) => s + i.pagado, 0)
  metric('pagos registrados', pagos.map(p => p.valor).join(' + '))
  metric('Σ payments', totalPayments)
  metric('Σ aplicado tras recomputar', aplicado)
  metric('saldo recomputado', calculateSaleBalance(rec))
  metric('excedente silencioso', totalPayments - aplicado)
  assert(totalPayments === 120000, `Σ payments debía ser 120.000 y fue ${totalPayments.toLocaleString('es-CO')}`)
  assert(totalPayments === aplicado, `al recomputar se pierden ${(totalPayments - aplicado).toLocaleString('es-CO')}`)
  assert(calculateSaleBalance(rec) === 0, 'el saldo recomputado debía ser 0')
})

await spec('REC-002-LEGACY', 'Recomputación', 'un sobrepago heredado se DETECTA y se reporta, y no se corrige solo', async () => {
  // Un dato histórico sobrepagado no se puede reconstruir automáticamente (no existe
  // registro de a qué debía imputarse el excedente). La conducta CORRECTA del sistema
  // ante él es detectarlo y reportarlo, nunca alterar la contabilidad en silencio.
  // Este caso verifica exactamente eso.
  const sc = buildScenario(ESC_120K)
  const pagoHeredado = {
    id: 'legacy-1', tenantId: TEST_IDS.TENANT_ID, saleId: sc.sale.id, clientId: sc.sale.clientId,
    routeId: sc.sale.routeId, collectorId: 'u-legacy', valor: 170000, fecha: '2026-07-27',
    tipo: 'efectivo', syncStatus: 'synced', createdAt: '2026-07-27T10:00:00Z',
  } as unknown as Payment
  // Se siembra el estado tal y como lo dejaba el código anterior: pago de 170.000
  // registrado, 120.000 aplicados a parcelas y venta cerrada en 0.
  sc.db.payments._seed([pagoHeredado])
  const { updatedInstallments } = applyPaymentToInstallments(sc.installments, 170000)
  sc.db.installments._seed(updatedInstallments)
  sc.db.sales._seed([{ ...sc.sale, saldo: 0, status: 'finalizada' }])

  const antes = JSON.stringify([await sc.db.payments.toArray(), await sc.db.installments.toArray(), await sc.db.sales.toArray()])
  const report = await reconcileFinancials({ ahora: FECHA_FIJA }, asRead(sc.db))
  const despues = JSON.stringify([await sc.db.payments.toArray(), await sc.db.installments.toArray(), await sc.db.sales.toArray()])

  const fila = report.filas[0]
  const issue = fila.issues.find(i => i.code === 'LEGACY-001')
  metric('pago heredado en la base', pagoHeredado.valor)
  metric('aplicado a parcelas', fila.aplicadoAParcelas)
  metric('excedente detectado', issue?.diferencia)
  metric('código reportado', issue?.code)
  metric('¿la herramienta modificó algo?', antes !== despues ? 'SÍ — ERROR' : 'no (solo lectura)')
  assert(!!issue, 'el diagnóstico no detectó el sobrepago heredado')
  assert(issue!.diferencia === 50000, `el excedente calculado fue ${issue!.diferencia}, debía ser 50.000`)
  assert(antes === despues, 'la herramienta de diagnóstico modificó datos: debe ser de SOLO LECTURA')
  // Y se confirma que el recálculo sigue sin poder recuperar el excedente: por eso
  // la única salida correcta es reportarlo.
  const rec = recalculateSaleFromPayments(sc.installments, [pagoHeredado])
  metric('recalculateSaleFromPayments aplica', rec.reduce((s, i) => s + i.pagado, 0))
  assert(rec.reduce((s, i) => s + i.pagado, 0) === 120000, 'el recálculo debe seguir topando a la deuda real')
})

// ############################################################
// CASOS SOLICITADOS PARA EL SERVICIO
// ############################################################
await spec('PAY-CAP-001', 'Servicio', 'pago superior al saldo guarda únicamente el saldo real', async () => {
  const sc = buildScenario(ESC_100K)
  const r = await registerPayment({ saleId: sc.sale.id, requestedAmount: 150000, actor: USER_ADMIN }, asDb(sc.db))
  const st = await readFinancialState(sc.db)
  metric('saldo previo', r.ok ? r.previousBalance : '—')
  metric('solicitado', r.ok ? r.requestedAmount : '—')
  metric('aplicado', r.ok ? r.appliedAmount : '—')
  metric('payments.valor', st.totalRegistradoEnPayments)
  metric('saldo nuevo', st.saleSaldo)
  assert(r.ok, 'el pago topado debe aceptarse')
  assert(r.ok && r.appliedAmount === 100000 && r.capped && r.cappedAmount === 50000, 'debía toparse a 100.000')
  assert(st.totalRegistradoEnPayments === 100000, 'payments debía guardar 100.000')
  assert(st.saleSaldo === 0, 'la deuda debía quedar exactamente en 0')
  assert(st.parcelas.every(p => p.saldo >= 0 && p.pagado <= p.valor), 'sin saldos negativos ni sobrepagos por parcela')
})

await spec('PAY-CONCURRENT-001', 'Servicio', 'el estado obsoleto de la UI no altera el resultado (relectura fresca)', async () => {
  const sc = buildScenario(ESC_120K)
  // Se aplican DOS abonos previos por fuera de la pantalla.
  await registerPayment({ saleId: sc.sale.id, requestedAmount: 12000, actor: USER_ADMIN }, asDb(sc.db))
  await registerPayment({ saleId: sc.sale.id, requestedAmount: 12000, actor: USER_COBRADOR }, asDb(sc.db))
  // La pantalla sigue mostrando la venta y las parcelas originales (saldo 120.000).
  const r = await operationalPaymentFlow(sc.db, {
    valor: 12000, sale: sc.sale, user: USER_COBRADOR, installments: sc.installments,
  })
  const st = await readFinancialState(sc.db)
  metric('saldo que creía la pantalla', sc.sale.saldo)
  metric('saldo real leído por el servicio', r.result?.previousBalance)
  metric('parcela aplicada', r.result?.paidInstallmentNumber)
  metric('saldo final', st.saleSaldo)
  metric('aplicado total', st.totalAplicadoAParcelas)
  assert(r.result?.previousBalance === 96000, 'el servicio debía leer el saldo real (96.000), no el de la pantalla')
  assert(r.result?.paidInstallmentNumber === 3, 'debía aplicarse a la parcela 3')
  assert(st.saleSaldo === 84000 && st.totalAplicadoAParcelas === 36000, 'los tres abonos debían acumularse')
})

await spec('PAY-TX-001', 'Servicio', 'un fallo durante la actualización de parcelas produce rollback total', async () => {
  const sc = buildScenario(ESC_120K)
  const antes = await readFinancialState(sc.db)
  sc.db.injectFault({ op: 'installments.update', nth: 5, message: 'Fallo simulado a mitad de las parcelas' })
  const r = await registerPayment({ saleId: sc.sale.id, requestedAmount: 60000, actor: USER_ADMIN }, asDb(sc.db))
  const despues = await readFinancialState(sc.db)
  metric('resultado', r.ok ? 'ok' : `rechazado: ${r.code}`)
  metric('payments antes → después', `${antes.totalRegistradoEnPayments} → ${despues.totalRegistradoEnPayments}`)
  metric('aplicado antes → después', `${antes.totalAplicadoAParcelas} → ${despues.totalAplicadoAParcelas}`)
  metric('saldo antes → después', `${antes.saleSaldo} → ${despues.saleSaldo}`)
  metric('bitácora', sc.db.log.join(' → '))
  assert(!r.ok, 'el servicio debía informar el fallo')
  assert(JSON.stringify(antes) === JSON.stringify(despues), 'el estado financiero cambió pese al rollback')
})

await spec('PAY-AUTH-001', 'Servicio', 'un actor sin acceso a la ruta no puede registrar pago', async () => {
  const otra = await runAdmin(ESC_120K, 12000, USER_OTRA_RUTA)
  metric('cobrador de otra ruta', otra.res.ok ? 'ACEPTADO' : `rechazado: ${otra.res.rejected}`)
  const socio = await runAdmin(ESC_120K, 12000, USER_SOCIO)
  metric('socio (sin capacidad payment.register)', socio.res.ok ? 'ACEPTADO' : `rechazado: ${socio.res.rejected}`)
  const sinSesion = await runAdmin(ESC_120K, 12000, null as unknown as User)
  metric('sin sesión', sinSesion.res.ok ? 'ACEPTADO' : `rechazado: ${sinSesion.res.rejected}`)
  assert(!otra.res.ok && otra.res.rejected === 'NOT_AUTHORIZED', 'un usuario de otra ruta no debe poder cobrar')
  assert(otra.state.totalRegistradoEnPayments === 0 && otra.state.saleSaldo === 120000, 'no debía tocarse nada')
  assert(!socio.res.ok && socio.res.rejected === 'NOT_AUTHORIZED', 'el Socio es perfil de consulta: no registra pagos')
  assert(!sinSesion.res.ok, 'sin sesión no se puede registrar un pago')
})

await spec('PAY-STATUS-001', 'Servicio', 'venta finalizada rechaza pago', async () => {
  const sc = buildScenario({ ...ESC_120K, parcelasPagadas: 10, status: 'finalizada' })
  const r = await registerPayment({ saleId: sc.sale.id, requestedAmount: 10000, actor: USER_ADMIN }, asDb(sc.db))
  metric('resultado', r.ok ? 'ACEPTADO' : `${r.code} — ${r.message}`)
  assert(!r.ok && r.code === 'SALE_NOT_ACTIVE', 'debía rechazarse por estado')
})

await spec('PAY-STATUS-002', 'Servicio', 'venta perdida rechaza pago', async () => {
  const sc = buildScenario({ ...ESC_120K, parcelasPagadas: 3, status: 'perdida' })
  const r = await registerPayment({ saleId: sc.sale.id, requestedAmount: 10000, actor: USER_ADMIN }, asDb(sc.db))
  const st = await readFinancialState(sc.db)
  metric('resultado', r.ok ? 'ACEPTADO' : `${r.code} — ${r.message}`)
  metric('estado final', st.saleStatus)
  assert(!r.ok && r.code === 'SALE_NOT_ACTIVE', 'debía rechazarse por estado')
  assert(st.saleStatus === 'perdida', 'la venta debe seguir perdida')
})

await spec('PAY-DISB-001', 'Servicio', 'venta pendiente de desembolso rechaza pago', async () => {
  const sc = buildScenario({ ...ESC_120K, disbursementStatus: 'pendiente' })
  const r = await registerPayment({ saleId: sc.sale.id, requestedAmount: 10000, actor: USER_ADMIN }, asDb(sc.db))
  metric('resultado', r.ok ? 'ACEPTADO' : `${r.code} — ${r.message}`)
  assert(!r.ok && r.code === 'SALE_NOT_DISBURSED', 'debía rechazarse por desembolso pendiente')
})

await spec('PAY-GUARD-001', 'Servicio', 'importes inválidos y ventas inexistentes se rechazan sin escribir', async () => {
  const sc = buildScenario(ESC_120K)
  const cero = await registerPayment({ saleId: sc.sale.id, requestedAmount: 0, actor: USER_ADMIN }, asDb(sc.db))
  const neg = await registerPayment({ saleId: sc.sale.id, requestedAmount: -5000, actor: USER_ADMIN }, asDb(sc.db))
  const nan = await registerPayment({ saleId: sc.sale.id, requestedAmount: Number.NaN, actor: USER_ADMIN }, asDb(sc.db))
  const inexistente = await registerPayment({ saleId: 'no-existe', requestedAmount: 1000, actor: USER_ADMIN }, asDb(sc.db))
  const st = await readFinancialState(sc.db)
  metric('importe 0', cero.ok ? 'ACEPTADO' : cero.code)
  metric('importe negativo', neg.ok ? 'ACEPTADO' : neg.code)
  metric('importe NaN', nan.ok ? 'ACEPTADO' : nan.code)
  metric('venta inexistente', inexistente.ok ? 'ACEPTADO' : inexistente.code)
  metric('payments escritos', st.totalRegistradoEnPayments)
  assert(!cero.ok && cero.code === 'INVALID_AMOUNT', 'importe 0 debía rechazarse')
  assert(!neg.ok && neg.code === 'INVALID_AMOUNT', 'importe negativo debía rechazarse')
  assert(!nan.ok && nan.code === 'INVALID_AMOUNT', 'importe NaN debía rechazarse')
  assert(!inexistente.ok && inexistente.code === 'SALE_NOT_FOUND', 'venta inexistente debía rechazarse')
  assert(st.totalRegistradoEnPayments === 0, 'ninguna validación debía escribir')
})

await spec('PAY-GUARD-002', 'Servicio', 'venta activa sin parcelas no se cierra sola: se rechaza', async () => {
  const sc = buildScenario(ESC_120K)
  // Simula una venta cuyas parcelas se perdieron (p. ej. un reset parcial de datos).
  const vacia = new (sc.db.constructor as new () => MemoryDb)()
  vacia.sales._seed([sc.sale])
  const r = await registerPayment({ saleId: sc.sale.id, requestedAmount: 10000, actor: USER_ADMIN }, asDb(vacia))
  const st = await readFinancialState(vacia)
  metric('resultado', r.ok ? 'ACEPTADO' : `${r.code} — ${r.message}`)
  metric('saldo de la venta', st.saleSaldo)
  metric('estado de la venta', st.saleStatus)
  assert(!r.ok && r.code === 'NO_INSTALLMENTS', 'debía rechazarse por falta de parcelas')
  assert(st.saleSaldo === 120000 && st.saleStatus === 'activa', 'la venta no debía cerrarse sola en 0')
})

// ############################################################
// AUDITORÍA PERSISTENTE DE PAGOS
// ############################################################
await spec('AUD-PAY-001', 'Auditoría', 'un pago normal genera su registro de auditoría', async () => {
  const sc = buildScenario(ESC_100K)
  const audit = makeAuditSink()
  const r = await registerPayment({ saleId: sc.sale.id, requestedAmount: 20000, actor: USER_COBRADOR }, asDb(sc.db), audit.sink)
  const log = audit.entries[0]
  const md = log?.metadata as Record<string, unknown> | undefined
  metric('registros de auditoría', audit.entries.length)
  metric('action', log?.action)
  metric('entityType / entityId', `${log?.entityType} / ${log?.entityId === (r.ok ? r.paymentId : '') ? 'paymentId ✔' : log?.entityId}`)
  metric('saleId · routeId · tenantId', `${md?.saleId} · ${md?.routeId} · ${md?.tenantId}`)
  metric('actorId', md?.actorId)
  metric('requested / applied', `${md?.requestedAmount} / ${md?.appliedAmount}`)
  metric('previousBalance → newBalance', `${md?.previousBalance} → ${md?.newBalance}`)
  metric('timestamp', typeof md?.timestamp === 'string' ? 'presente' : 'AUSENTE')
  metric('audited', r.ok ? r.audited : '—')
  assert(r.ok && r.audited, 'el pago debía quedar auditado')
  assert(audit.entries.length === 1, `se esperaba 1 registro y hubo ${audit.entries.length}`)
  assert(log.action === 'REGISTER_PAYMENT', `action incorrecto: ${log.action}`)
  assert(log.entityType === 'Payment' && log.entityId === (r as { paymentId: string }).paymentId, 'la entidad auditada debe ser el pago')
  assert(log.userId === USER_COBRADOR.id && log.userRole === 'cobrador', 'debe registrarse el actor y su rol')
  assert(log.routeId === TEST_IDS.ROUTE_ID && log.tenantId === TEST_IDS.TENANT_ID, 'deben registrarse ruta y empresa')
  for (const campo of ['saleId', 'paymentId', 'routeId', 'tenantId', 'actorId', 'requestedAmount', 'appliedAmount', 'capped', 'cappedAmount', 'previousBalance', 'newBalance', 'timestamp']) {
    assert(md?.[campo] !== undefined, `falta el campo obligatorio '${campo}' en la auditoría`)
  }
  assert(md?.requestedAmount === 20000 && md?.appliedAmount === 20000 && md?.capped === false, 'importes auditados incorrectos')
  assert(md?.previousBalance === 100000 && md?.newBalance === 80000, 'saldos auditados incorrectos')
})

await spec('AUD-PAY-002', 'Auditoría', 'un sobrepago registra lo solicitado y lo realmente aplicado', async () => {
  // Caso del enunciado: saldo 100.000, se intenta pagar 150.000.
  const sc = buildScenario(ESC_100K)
  const audit = makeAuditSink()
  const r = await registerPayment({ saleId: sc.sale.id, requestedAmount: 150000, actor: USER_ADMIN }, asDb(sc.db), audit.sink)
  const md = audit.entries[0]?.metadata as Record<string, unknown>
  const st = await readFinancialState(sc.db)
  metric('requestedAmount auditado', md?.requestedAmount)
  metric('appliedAmount auditado', md?.appliedAmount)
  metric('capped auditado', md?.capped)
  metric('cappedAmount auditado', md?.cappedAmount)
  metric('descripción', audit.entries[0]?.descripcion)
  metric('payments.valor realmente guardado', st.totalRegistradoEnPayments)
  assert(r.ok, 'el pago topado debía aceptarse')
  assert(md.requestedAmount === 150000, `requestedAmount auditado ${md.requestedAmount}, debía ser 150.000`)
  assert(md.appliedAmount === 100000, `appliedAmount auditado ${md.appliedAmount}, debía ser 100.000`)
  assert(md.capped === true, 'capped debía ser true')
  assert(md.cappedAmount === 50000, `cappedAmount auditado ${md.cappedAmount}, debía ser 50.000`)
  assert(String(audit.entries[0].descripcion).includes('limitado al saldo'), 'la descripción debe indicar que se limitó')
  // La auditoría NO altera la contabilidad.
  assert(st.totalRegistradoEnPayments === 100000, 'payments debe guardar solo el valor efectivo')
  assert(st.saleSaldo === 0, 'la deuda debe quedar en 0')
})

await spec('AUD-PAY-003', 'Auditoría', 'un pago rechazado no genera ningún registro de auditoría', async () => {
  const audit = makeAuditSink()
  const casos: Array<[string, Parameters<typeof buildScenario>[0], number, User]> = [
    ['venta finalizada', { ...ESC_120K, parcelasPagadas: 10, status: 'finalizada' }, 10000, USER_ADMIN],
    ['venta perdida', { ...ESC_120K, parcelasPagadas: 3, status: 'perdida' }, 10000, USER_ADMIN],
    ['no desembolsada', { ...ESC_120K, disbursementStatus: 'pendiente' }, 10000, USER_ADMIN],
    ['sin permiso', ESC_120K, 10000, USER_OTRA_RUTA],
    ['importe inválido', ESC_120K, 0, USER_ADMIN],
  ]
  for (const [nombre, opts, valor, user] of casos) {
    const sc = buildScenario(opts)
    const r = await registerPayment({ saleId: sc.sale.id, requestedAmount: valor, actor: user }, asDb(sc.db), audit.sink)
    metric(nombre, r.ok ? 'ACEPTADO' : r.code)
    assert(!r.ok, `[${nombre}] debía rechazarse`)
  }
  metric('registros de auditoría generados', audit.entries.length)
  assert(audit.entries.length === 0, `un pago rechazado no debe auditarse (hubo ${audit.entries.length})`)
})

await spec('AUD-PAY-004', 'Auditoría', 'un fallo de auditoría NO revierte el pago ya consolidado', async () => {
  const sc = buildScenario(ESC_100K)
  const audit = makeAuditSink({ failWith: 'auditLogs no disponible' })
  const r = await registerPayment({ saleId: sc.sale.id, requestedAmount: 20000, actor: USER_ADMIN }, asDb(sc.db), audit.sink)
  const st = await readFinancialState(sc.db)
  metric('resultado del pago', r.ok ? 'ok (correcto)' : `RECHAZADO: ${r.code}`)
  metric('audited', r.ok ? r.audited : '—')
  metric('auditError', r.ok ? r.auditError : '—')
  metric('payments guardados', st.totalRegistradoEnPayments)
  metric('aplicado a parcelas', st.totalAplicadoAParcelas)
  metric('saldo venta', st.saleSaldo)
  // El pago es CORRECTO: la UI no debe presentarlo como error.
  assert(r.ok, 'un fallo de auditoría no puede convertir el pago en fallido')
  assert(r.ok && r.audited === false, 'debe quedar marcado que no se pudo auditar')
  assert(r.ok && !!r.auditError, 'debe conservarse la causa del fallo de auditoría')
  assert(st.totalRegistradoEnPayments === 20000 && st.totalAplicadoAParcelas === 20000, 'el pago debía quedar aplicado')
  assert(st.saleSaldo === 80000, 'el saldo debía actualizarse')
})

await spec('AUD-PAY-005', 'Auditoría', 'un fallo de auditoría no provoca un doble registro del pago', async () => {
  const sc = buildScenario(ESC_100K)
  const audit = makeAuditSink({ failWith: 'auditLogs no disponible' })
  await registerPayment({ saleId: sc.sale.id, requestedAmount: 20000, actor: USER_ADMIN }, asDb(sc.db), audit.sink)
  const pagos = await sc.db.payments.toArray()
  const st = await readFinancialState(sc.db)
  metric('filas en payments', pagos.length)
  metric('Σ payments', st.totalRegistradoEnPayments)
  metric('Σ aplicado', st.totalAplicadoAParcelas)
  assert(pagos.length === 1, `se registró el pago ${pagos.length} veces`)
  assert(st.totalRegistradoEnPayments === st.totalAplicadoAParcelas, 'payments y cartera deben seguir cuadrados')
})

await spec('AUD-PAY-006', 'Auditoría', 'la auditoría no toca la contabilidad (payments, parcelas, venta, caja)', async () => {
  const conAudit = buildScenario(ESC_100K)
  const okSink = makeAuditSink()
  await registerPayment({ saleId: conAudit.sale.id, requestedAmount: 25000, actor: USER_ADMIN }, asDb(conAudit.db), okSink.sink)
  const sinAudit = buildScenario(ESC_100K)
  const failSink = makeAuditSink({ failWith: 'fallo' })
  await registerPayment({ saleId: sinAudit.sale.id, requestedAmount: 25000, actor: USER_ADMIN }, asDb(sinAudit.db), failSink.sink)

  const a = await readFinancialState(conAudit.db)
  const b = await readFinancialState(sinAudit.db)
  metric('con auditoría OK', `payments=${a.totalRegistradoEnPayments} saldo=${a.saleSaldo}`)
  metric('con auditoría FALLIDA', `payments=${b.totalRegistradoEnPayments} saldo=${b.saleSaldo}`)
  metric('caja (cobros) con/sin auditoría', `${await computeCobrosComoCaja(conAudit.db)} / ${await computeCobrosComoCaja(sinAudit.db)}`)
  assert(JSON.stringify(a) === JSON.stringify(b), 'el resultado financiero cambia según si la auditoría funciona')
  assert(await computeCobrosComoCaja(conAudit.db) === await computeCobrosComoCaja(sinAudit.db), 'la auditoría no debe influir en caja')
})

// ############################################################
// CONCILIACIÓN DE DATOS HEREDADOS (solo lectura)
// ############################################################
/** Construye una base con una venta "sucia" sembrada directamente. */
function escenarioLegacy(mutar: (sc: ReturnType<typeof buildScenario>) => void) {
  const sc = buildScenario(ESC_120K)
  mutar(sc)
  return sc
}

async function diagnosticar(sc: ReturnType<typeof buildScenario>) {
  const antes = JSON.stringify([
    await sc.db.payments.toArray(), await sc.db.installments.toArray(), await sc.db.sales.toArray(),
  ])
  const report = await reconcileFinancials({ ahora: FECHA_FIJA }, asRead(sc.db))
  const despues = JSON.stringify([
    await sc.db.payments.toArray(), await sc.db.installments.toArray(), await sc.db.sales.toArray(),
  ])
  return { report, intacto: antes === despues }
}

function pagoLegacy(sc: ReturnType<typeof buildScenario>, valor: number, extra: Partial<Payment> = {}): Payment {
  return {
    id: `legacy-${valor}-${Math.abs(valor)}`, tenantId: sc.sale.tenantId, saleId: sc.sale.id,
    clientId: sc.sale.clientId, routeId: sc.sale.routeId, collectorId: 'u-legacy',
    valor, fecha: '2026-07-01', tipo: 'efectivo', syncStatus: 'synced',
    createdAt: '2026-07-01T10:00:00Z', ...extra,
  } as Payment
}

await spec('LEGACY-001', 'Conciliación', 'detecta un sobrepago histórico', async () => {
  const sc = escenarioLegacy(s => {
    s.db.payments._seed([pagoLegacy(s, 170000)])
    const { updatedInstallments } = applyPaymentToInstallments(s.installments, 170000)
    s.db.installments._seed(updatedInstallments)
    s.db.sales._seed([{ ...s.sale, saldo: 0, status: 'finalizada' }])
  })
  const { report, intacto } = await diagnosticar(sc)
  const fila = report.filas[0]
  const issue = fila.issues.find(i => i.code === 'LEGACY-001')
  metric('pagos efectivos', fila.paymentsEfectivos)
  metric('aplicado a parcelas', fila.aplicadoAParcelas)
  metric('diferencia detectada', issue?.diferencia)
  metric('severidad', issue?.severity)
  metric('base intacta', intacto)
  assert(!!issue && issue.diferencia === 50000, 'debía detectar un sobrepago de 50.000')
  assert(intacto, 'el diagnóstico debe ser de solo lectura')
})

await spec('LEGACY-002', 'Conciliación', 'detecta parcelas aplicadas sin respaldo en pagos', async () => {
  const sc = escenarioLegacy(s => {
    // Escenario del antiguo RC-BUG-002: se aplicaron parcelas y el pago no quedó.
    const { updatedInstallments } = applyPaymentToInstallments(s.installments, 36000)
    s.db.installments._seed(updatedInstallments)
    s.db.payments._seed([pagoLegacy(s, 12000)])
    s.db.sales._seed([{ ...s.sale, saldo: 84000 }])
  })
  const { report, intacto } = await diagnosticar(sc)
  const issue = report.filas[0].issues.find(i => i.code === 'LEGACY-002')
  metric('pagos efectivos', report.filas[0].paymentsEfectivos)
  metric('aplicado a parcelas', report.filas[0].aplicadoAParcelas)
  metric('diferencia detectada', issue?.diferencia)
  metric('base intacta', intacto)
  assert(!!issue && issue.diferencia === 24000, 'debía detectar 24.000 aplicados sin respaldo')
  assert(intacto, 'el diagnóstico debe ser de solo lectura')
})

await spec('LEGACY-003', 'Conciliación', 'detecta la deriva entre sale.saldo y el saldo de parcelas', async () => {
  const sc = escenarioLegacy(s => {
    const { updatedInstallments } = applyPaymentToInstallments(s.installments, 24000)
    s.db.installments._seed(updatedInstallments)
    s.db.payments._seed([pagoLegacy(s, 24000)])
    // sale.saldo quedó desactualizado (escritura parcial del flujo antiguo).
    s.db.sales._seed([{ ...s.sale, saldo: 120000 }])
  })
  const { report, intacto } = await diagnosticar(sc)
  const issue = report.filas[0].issues.find(i => i.code === 'LEGACY-003')
  metric('sale.saldo', report.filas[0].saldoVenta)
  metric('Σ saldo parcelas', report.filas[0].saldoParcelas)
  metric('diferencia detectada', issue?.diferencia)
  metric('base intacta', intacto)
  assert(!!issue && issue.diferencia === 24000, 'debía detectar una deriva de 24.000')
  assert(intacto, 'el diagnóstico debe ser de solo lectura')
})

await spec('LEGACY-004', 'Conciliación', 'detecta una venta finalizada que conserva deuda', async () => {
  const sc = escenarioLegacy(s => {
    const { updatedInstallments } = applyPaymentToInstallments(s.installments, 36000)
    s.db.installments._seed(updatedInstallments)
    s.db.payments._seed([pagoLegacy(s, 36000)])
    s.db.sales._seed([{ ...s.sale, saldo: 0, status: 'finalizada' }])
  })
  const { report, intacto } = await diagnosticar(sc)
  const issue = report.filas[0].issues.find(i => i.code === 'LEGACY-004')
  metric('estado', report.filas[0].status)
  metric('Σ saldo parcelas', report.filas[0].saldoParcelas)
  metric('deuda viva detectada', issue?.diferencia)
  metric('base intacta', intacto)
  assert(!!issue && issue.diferencia === 84000, 'debía detectar 84.000 de deuda en una venta finalizada')
  assert(intacto, 'el diagnóstico debe ser de solo lectura')
})

await spec('LEGACY-005', 'Conciliación', 'detecta una venta activa ya saldada', async () => {
  const sc = escenarioLegacy(s => {
    const { updatedInstallments } = applyPaymentToInstallments(s.installments, 120000)
    s.db.installments._seed(updatedInstallments)
    s.db.payments._seed([pagoLegacy(s, 120000)])
    s.db.sales._seed([{ ...s.sale, saldo: 0, status: 'activa' }])
  })
  const { report, intacto } = await diagnosticar(sc)
  const issue = report.filas[0].issues.find(i => i.code === 'LEGACY-005')
  metric('estado', report.filas[0].status)
  metric('Σ saldo parcelas', report.filas[0].saldoParcelas)
  metric('detectado', issue?.label)
  metric('base intacta', intacto)
  assert(!!issue, 'debía detectar una venta activa sin deuda')
  assert(intacto, 'el diagnóstico debe ser de solo lectura')
})

await spec('LEGACY-006', 'Conciliación', 'detecta parcelas con importes imposibles', async () => {
  const sc = escenarioLegacy(s => {
    const insts = structuredClone(s.installments)
    insts[0] = { ...insts[0], pagado: 15000, saldo: -3000, status: 'pagada' }
    s.db.installments._seed(insts)
    s.db.payments._seed([pagoLegacy(s, 15000)])
    s.db.sales._seed([{ ...s.sale, saldo: 105000 }])
  })
  const { report, intacto } = await diagnosticar(sc)
  const issue = report.filas[0].issues.find(i => i.code === 'LEGACY-006')
  metric('detalle', issue?.detalle)
  metric('magnitud', issue?.diferencia)
  metric('base intacta', intacto)
  assert(!!issue, 'debía detectar la parcela con pagado > valor y saldo < 0')
  assert(intacto, 'el diagnóstico debe ser de solo lectura')
})

await spec('LEGACY-000', 'Conciliación', 'una base sana se reporta explícitamente como LIMPIA', async () => {
  const sc = buildScenario(ESC_120K)
  await registerPayment({ saleId: sc.sale.id, requestedAmount: 36000, actor: USER_ADMIN }, asDb(sc.db), makeAuditSink().sink)
  const { report, intacto } = await diagnosticar(sc)
  metric('ventas analizadas', report.ventasAnalizadas)
  metric('ventas con inconsistencias', report.ventasConInconsistencias)
  metric('limpio', report.limpio)
  metric('base intacta', intacto)
  assert(report.ventasAnalizadas === 1, 'debía analizar la venta')
  assert(report.limpio && report.ventasConInconsistencias === 0, 'una base sana no debe reportar inconsistencias')
  assert(formatReconciliationReport(report).includes('SIN INCONSISTENCIAS'), 'el informe debe decirlo explícitamente')
  assert(intacto, 'el diagnóstico debe ser de solo lectura')
})

await spec('LEGACY-SEM-001', 'Conciliación', 'respeta la semántica de corrección: no suma reversiones ni originales revertidos', async () => {
  const sc = escenarioLegacy(s => {
    // Un pago de 30.000 corregido a 12.000 mediante reversión + reemplazo.
    const original = pagoLegacy(s, 30000, { id: 'p-original', state: 'reversed', correctedByPaymentId: 'p-corregido' })
    const reversion = pagoLegacy(s, -30000, { id: 'p-reversion', state: 'reversal', reversesPaymentId: 'p-original' })
    const corregido = pagoLegacy(s, 12000, { id: 'p-corregido', state: 'active', correctionOfPaymentId: 'p-original' })
    s.db.payments._seed([original, reversion, corregido])
    const { updatedInstallments } = applyPaymentToInstallments(s.installments, 12000)
    s.db.installments._seed(updatedInstallments)
    s.db.sales._seed([{ ...s.sale, saldo: 108000 }])
  })
  const { report } = await diagnosticar(sc)
  const fila = report.filas[0]
  metric('filas en payments', 3)
  metric('suma ingenua de todas las filas', 30000 - 30000 + 12000)
  metric('pagos efectivos computados', fila.paymentsEfectivos)
  metric('pagos excluidos por la semántica', fila.paymentsExcluidos)
  metric('aplicado a parcelas', fila.aplicadoAParcelas)
  metric('inconsistencias', fila.issues.length === 0 ? 'ninguna' : fila.issues.map(i => i.code).join(','))
  assert(fila.paymentsEfectivos === 12000, `pagos efectivos ${fila.paymentsEfectivos}: debía ser 12.000 (solo el corregido)`)
  assert(fila.paymentsExcluidos === 2, 'debía excluir el original revertido y el asiento de reversión')
  assert(fila.issues.length === 0, `una corrección bien hecha no debe reportar inconsistencias: ${fila.issues.map(i => i.code).join(',')}`)
})

await spec('LEGACY-DEMO-001', 'Conciliación', 'detecta el pago no aplicado que siembra el seed DEMO', async () => {
  // HALLAZGO REAL, NO HIPOTÉTICO. `src/data/seed.ts` (líneas 431-445) añade a la
  // PRIMERA venta demo un pago extra «Pago sin conexión» por `sale.valorCuota` que
  // NO se aplica a ninguna parcela. Toda base DEMO recién sembrada arranca, por
  // tanto, con un desajuste de exactamente un valor de parcela.
  // Aquí se reproduce ese patrón y se comprueba que el diagnóstico lo detecta, para
  // que nadie lo confunda con daño provocado durante una prueba.
  const VALOR_CUOTA = 12000
  const sc = escenarioLegacy(s => {
    const { updatedInstallments } = applyPaymentToInstallments(s.installments, VALOR_CUOTA * 5)
    s.db.installments._seed(updatedInstallments)
    const pagosAplicados = Array.from({ length: 5 }, (_, i) =>
      pagoLegacy(s, VALOR_CUOTA, { id: `p-aplicado-${i}` }))
    const pagoSinConexion = pagoLegacy(s, VALOR_CUOTA, { id: 'p-sin-conexion', syncStatus: 'pending', observacion: 'Pago sin conexión' })
    s.db.payments._seed([...pagosAplicados, pagoSinConexion])
    s.db.sales._seed([{ ...s.sale, saldo: 120000 - VALOR_CUOTA * 5 }])
  })
  const { report, intacto } = await diagnosticar(sc)
  const fila = report.filas[0]
  const issue = fila.issues.find(i => i.code === 'LEGACY-001')
  metric('pagos efectivos', fila.paymentsEfectivos)
  metric('aplicado a parcelas', fila.aplicadoAParcelas)
  metric('desajuste detectado', issue?.diferencia)
  metric('origen', 'seed.ts:431-445 — pago demo no aplicado a parcelas')
  metric('base intacta', intacto)
  assert(!!issue && issue.diferencia === VALOR_CUOTA,
    `debía detectar un desajuste de ${VALOR_CUOTA} (un valor de parcela) en la venta demo`)
  assert(intacto, 'el diagnóstico debe ser de solo lectura')
})

await spec('LEGACY-RUTA-001', 'Conciliación', 'agrega el impacto por ruta y por código', async () => {
  const sc = escenarioLegacy(s => {
    s.db.payments._seed([pagoLegacy(s, 170000)])
    const { updatedInstallments } = applyPaymentToInstallments(s.installments, 170000)
    s.db.installments._seed(updatedInstallments)
    s.db.sales._seed([{ ...s.sale, saldo: 0, status: 'finalizada' }])
  })
  const { report } = await diagnosticar(sc)
  const ruta = report.porRuta[0]
  metric('rutas afectadas', report.porRuta.length)
  metric('ruta', ruta?.routeName)
  metric('ventas afectadas', ruta?.ventasAfectadas)
  metric('diferencia total', ruta?.diferenciaTotal)
  metric('códigos catalogados', Object.keys(LEGACY_ISSUES).length)
  metric('conteo LEGACY-001', report.conteoPorCodigo['LEGACY-001' as LegacyIssueCode])
  assert(report.porRuta.length === 1 && ruta.ventasAfectadas === 1, 'debía agregar por ruta')
  assert(ruta.routeName === 'Ruta Norte', `debía resolver el nombre de la ruta, obtuvo ${ruta.routeName}`)
  assert(ruta.diferenciaTotal === 50000, `diferencia por ruta ${ruta.diferenciaTotal}, debía ser 50.000`)
  assert(report.conteoPorCodigo['LEGACY-001' as LegacyIssueCode] === 1, 'debía contar la incidencia por código')
})

// ############################################################
// PARIDAD ADMIN / COBRADOR / SUPERVISOR
// ############################################################
async function parity(id: string, desc: string, opts: Parameters<typeof buildScenario>[0], valor: number) {
  await spec(id, 'Paridad', desc, async () => {
    const a = await runAdmin(opts, valor)
    const o = await runOperational(opts, valor)
    const s = await runOperational(opts, valor, USER_SUPERVISOR)
    const fmt = (x: typeof a) => `${x.res.ok ? 'aceptado' : 'RECHAZADO(' + x.res.rejected + ')'} · payments=${x.state.totalRegistradoEnPayments} · saldo=${x.state.saleSaldo} · estado=${x.state.saleStatus}`
    metric('Admin', fmt(a))
    metric('Cobrador', fmt(o))
    metric('Supervisor', fmt(s))
    const d = [...diffStates(a.state, o.state), ...diffStates(a.state, s.state)]
    if (a.res.ok !== o.res.ok || a.res.ok !== s.res.ok) d.push(`aceptación: ADMIN=${a.res.ok} COBRADOR=${o.res.ok} SUPERVISOR=${s.res.ok}`)
    if (a.res.rejected !== o.res.rejected || a.res.rejected !== s.res.rejected) d.push(`motivo: ADMIN=${a.res.rejected} COBRADOR=${o.res.rejected} SUPERVISOR=${s.res.rejected}`)
    metric('diferencias', d.length === 0 ? 'ninguna' : d.join(' | '))
    assert(d.length === 0, `las interfaces producen resultados distintos → ${d.join(' | ')}`)
  })
}

await parity('PARITY-001', 'pago parcial produce el mismo estado financiero', ESC_100K, 5000)
await parity('PARITY-002', 'completar parcela produce el mismo salto', { ...ESC_100K, abonoPrevioParcelaActual: 15000 }, 5000)
await parity('PARITY-003', 'pago total produce el mismo cierre de venta', ESC_100K, 100000)
await parity('PARITY-004', 'sobrepago produce el mismo tope al saldo', ESC_120K, 170000)
await parity('PARITY-005', 'venta pendiente de desembolso se rechaza en las tres interfaces', { ...ESC_120K, disbursementStatus: 'pendiente' }, 12000)
await parity('PARITY-006', 'venta finalizada se rechaza en las tres interfaces', { ...ESC_120K, parcelasPagadas: 10, status: 'finalizada' }, 50000)
await parity('PARITY-007', 'última parcela con redondeo produce el mismo comportamiento', { ...ESC_REDONDEO, parcelasPagadas: 6 }, 34286)
await parity('PARITY-010', 'venta perdida se rechaza en las tres interfaces', { ...ESC_120K, parcelasPagadas: 3, status: 'perdida' }, 12000)

await spec('PARITY-008', 'Paridad', 'ambas interfaces leen las parcelas de la misma fuente', () => {
  const admin = adminHandlerBody()
  const op = operationalHandlerBody()
  metric('Admin delega en el servicio', delegatesToPaymentService(admin))
  metric('Operativo delega en el servicio', delegatesToPaymentService(op))
  metric('Admin lee parcelas por su cuenta', refetchesInstallments(admin))
  metric('Operativo lee parcelas por su cuenta', refetchesInstallments(op))
  metric('el servicio relee de la base', refetchesInstallments(paymentServiceBody()))
  assert(delegatesToPaymentService(admin) && delegatesToPaymentService(op), 'ambas pantallas deben delegar en el servicio')
  assert(!refetchesInstallments(admin) && !refetchesInstallments(op), 'ninguna pantalla debe leer parcelas para pagar')
  assert(refetchesInstallments(paymentServiceBody()), 'la fuente única debe releer la base')
})

await spec('PARITY-009', 'Paridad', 'la capacidad se valida en el dominio, no solo en la UI', () => {
  const svc = paymentServiceBody()
  metric('el servicio verifica can(payment.register)', checksPaymentCapability(svc))
  metric('el servicio topa al saldo', capsAmountToBalance(svc))
  assert(checksPaymentCapability(svc), "el servicio debe llamar a can(actor,'payment.register',{routeId,tenantId})")
  assert(capsAmountToBalance(svc), 'el tope al saldo debe vivir en el servicio')
})

// ############################################################
// INVARIANTES FINANCIEROS
// ############################################################
const ESCENARIOS_INV: Array<[string, Parameters<typeof buildScenario>[0], number]> = [
  ['parcial', ESC_100K, 5000],
  ['completar parcela', { ...ESC_100K, abonoPrevioParcelaActual: 15000 }, 5000],
  ['multi-parcela', ESC_100K, 50000],
  ['pago total', ESC_100K, 100000],
  ['redondeo última', { ...ESC_REDONDEO, parcelasPagadas: 6 }, 34284],
  ['sobrepago 170k sobre 120k', ESC_120K, 170000],
  ['sobrepago x10', ESC_120K, 1200000],
]

await spec('FIN-INV-001', 'Invariantes', 'capital original = aplicado a parcelas + saldo actual', async () => {
  for (const [nombre, opts, valor] of ESCENARIOS_INV) {
    const r = await runAdmin(opts, valor)
    const izq = r.sale.valorTotal
    const der = r.state.totalAplicadoAParcelas + r.state.saleSaldo
    metric(nombre, `${izq} = ${r.state.totalAplicadoAParcelas} + ${r.state.saleSaldo}`)
    assert(izq === der, `[${nombre}] valorTotal=${izq} ≠ aplicado+saldo=${der}`)
  }
})

await spec('FIN-INV-002', 'Invariantes', 'suma de payments = total aplicado a parcelas (incluido el sobrepago)', async () => {
  for (const [nombre, opts, valor] of ESCENARIOS_INV) {
    const r = await runAdmin(opts, valor)
    const previo = r.installments.reduce((s, i) => s + i.pagado, 0)
    const aplicadoAhora = r.state.totalAplicadoAParcelas - previo
    metric(nombre, `payments=${r.state.totalRegistradoEnPayments} aplicado=${aplicadoAhora}`)
    assert(r.state.totalRegistradoEnPayments === aplicadoAhora, `[${nombre}] payments=${r.state.totalRegistradoEnPayments} ≠ aplicado=${aplicadoAhora}`)
  }
})

await spec('FIN-INV-003', 'Invariantes', 'el saldo de una venta nunca es negativo', async () => {
  for (const [nombre, opts, valor] of ESCENARIOS_INV) {
    const a = await runAdmin(opts, valor)
    const o = await runOperational(opts, valor)
    metric(nombre, `admin=${a.state.saleSaldo} operativo=${o.state.saleSaldo}`)
    assert(a.state.saleSaldo >= 0 && o.state.saleSaldo >= 0, `[${nombre}] saldo negativo`)
    assert(a.state.parcelas.every(p => p.saldo >= 0), `[${nombre}] parcela con saldo negativo`)
  }
})

await spec('FIN-INV-004', 'Invariantes', 'ninguna parcela tiene pagado > valor', async () => {
  const casos: Array<[string, Parameters<typeof buildScenario>[0], number]> = [
    ...ESCENARIOS_INV,
    ['redondeo con nominal', { ...ESC_REDONDEO, parcelasPagadas: 6 }, 34286],
  ]
  for (const [nombre, opts, valor] of casos) {
    const r = await runAdmin(opts, valor)
    const malas = r.state.parcelas.filter(p => p.pagado > p.valor)
    metric(nombre, malas.length === 0 ? 'ok' : malas.map(m => `#${m.numero} ${m.pagado}>${m.valor}`).join(' '))
    assert(malas.length === 0, `[${nombre}] parcelas con pagado > valor`)
  }
})

await spec('FIN-INV-005', 'Invariantes', 'toda venta finalizada tiene saldo 0', async () => {
  for (const [nombre, opts, valor] of ESCENARIOS_INV) {
    const r = await runAdmin(opts, valor)
    metric(nombre, `estado=${r.state.saleStatus} saldo=${r.state.saleSaldo}`)
    if (r.state.saleStatus === 'finalizada') {
      assert(r.state.saleSaldo === 0, `[${nombre}] venta finalizada con saldo ${r.state.saleSaldo}`)
    }
  }
})


// ############################################################
// CAJA POR RUTA — AISLAMIENTO DEL MOTOR (red de seguridad RQ-02/RQ-03)
// ------------------------------------------------------------
// `getCashboxSummary` es la base de la Liquidación semanal, de la Caja y del
// capital disponible. Antes de que la Liquidación permita elegir ruta hay que
// demostrar que el motor YA aísla por ruta: si esto se rompiera, el selector
// mostraría cifras contaminadas sin que nada avisara.
// ############################################################
const asCashboxDb = (db: MemoryDb) => db as unknown as CashboxDatabase

/** Semana de referencia de los casos de caja. */
const SEM_INI = '2026-08-17'
const SEM_FIN = '2026-08-22'

/** Dos rutas de la misma empresa con movimientos DISTINTOS en los 8 componentes. */
function dosRutas() {
  return buildCashboxScenario([
    {
      routeId: 'r-A', nombre: 'Ruta A', codigo: 'RT-001',
      capital: [{ fecha: '2026-08-18', valor: 1_000_000 }],
      pagos: [{ fecha: '2026-08-19', valor: 300_000 }, { fecha: '2026-08-20', valor: 200_000 }],
      ventas: [{ fechaInicio: '2026-08-19', valorVenta: 400_000 }],
      gastos: [{ fecha: '2026-08-20', valor: 50_000 }],
      retiros: [{ fecha: '2026-08-21', valor: 100_000 }],
      transferenciasSalida: [{ fecha: '2026-08-21', valor: 70_000, routeDestinoId: 'r-B' }],
      transferenciasEntrada: [{ fecha: '2026-08-18', valor: 30_000, routeOrigenId: 'r-B' }],
    },
    {
      routeId: 'r-B', nombre: 'Ruta B', codigo: 'RT-002',
      capital: [{ fecha: '2026-08-18', valor: 9_000_000 }],
      pagos: [{ fecha: '2026-08-19', valor: 7_000_000 }],
      ventas: [{ fechaInicio: '2026-08-19', valorVenta: 5_000_000 }],
      gastos: [{ fecha: '2026-08-20', valor: 800_000 }],
      retiros: [{ fecha: '2026-08-21', valor: 600_000 }],
    },
  ])
}

await spec('CASH-ROUTE-001', 'Caja por ruta', 'la caja de la Ruta A no incorpora ningún movimiento de la Ruta B', async () => {
  const db = dosRutas()
  const a = await getCashboxSummary('r-A', SEM_INI, SEM_FIN, asCashboxDb(db))
  metric('capital A', a.ingresoCapital)
  metric('cobros A', a.cobros)
  metric('prestamos A', a.prestamosEntregados)
  metric('gastos A', a.gastos)
  metric('transf. entradas A', a.transferenciasEntradas)
  metric('transf. salidas A', a.transferenciasSalidas)
  metric('retiros A', a.retiros)
  metric('saldo final A', a.saldoActual)
  // Cada componente corresponde EXCLUSIVAMENTE a lo sembrado en A.
  assert(a.ingresoCapital === 1_000_000, `capital contaminado: ${a.ingresoCapital}`)
  assert(a.cobros === 500_000, `cobros contaminados: ${a.cobros}`)
  assert(a.prestamosEntregados === 400_000, `préstamos contaminados: ${a.prestamosEntregados}`)
  assert(a.gastos === 50_000, `gastos contaminados: ${a.gastos}`)
  assert(a.transferenciasEntradas === 30_000, `transferencias de entrada contaminadas: ${a.transferenciasEntradas}`)
  assert(a.transferenciasSalidas === 70_000, `transferencias de salida contaminadas: ${a.transferenciasSalidas}`)
  assert(a.retiros === 100_000, `retiros contaminados: ${a.retiros}`)
  // saldoActual = 0 (sin historial previo) + 1.000.000 + 500.000 + 30.000 - 400.000 - 50.000 - 70.000 - 100.000
  assert(a.saldoActual === 910_000, `saldo final contaminado: ${a.saldoActual}`)
  assert(a.routeId === 'r-A', 'el resumen no identifica su propia ruta')
})

await spec('CASH-ROUTE-002', 'Caja por ruta', 'el saldo anterior de A se calcula solo con historial de A', async () => {
  const db = buildCashboxScenario([
    {
      routeId: 'r-A',
      // Historial ANTERIOR al rango.
      capital: [{ fecha: '2026-08-01', valor: 500_000 }],
      pagos: [{ fecha: '2026-08-02', valor: 100_000 }],
      gastos: [{ fecha: '2026-08-03', valor: 40_000 }],
      ventas: [{ fechaInicio: '2026-08-02', valorVenta: 200_000 }],
    },
    {
      routeId: 'r-B',
      // Historial MUCHO mayor, también anterior al rango: no debe filtrarse.
      capital: [{ fecha: '2026-08-01', valor: 8_000_000 }],
      pagos: [{ fecha: '2026-08-02', valor: 3_000_000 }],
    },
  ])
  const a = await getCashboxSummary('r-A', SEM_INI, SEM_FIN, asCashboxDb(db))
  metric('saldo anterior A', a.saldoAnterior)
  metric('movimientos dentro del rango', `${a.ingresoCapital}/${a.cobros}/${a.gastos}`)
  // 500.000 + 100.000 - 200.000 - 40.000 = 360.000
  assert(a.saldoAnterior === 360_000, `saldo anterior contaminado: ${a.saldoAnterior}`)
  assert(a.ingresoCapital === 0 && a.cobros === 0 && a.gastos === 0, 'movimientos previos contados dentro del rango')
  assert(a.saldoActual === 360_000, `saldo final incorrecto: ${a.saldoActual}`)
})

await spec('CASH-ROUTE-003', 'Caja por ruta', 'una venta pendiente de desembolso no descuenta caja', async () => {
  const db = buildCashboxScenario([{
    routeId: 'r-A',
    capital: [{ fecha: '2026-08-18', valor: 1_000_000 }],
    ventas: [
      { fechaInicio: '2026-08-19', valorVenta: 300_000 },
      { fechaInicio: '2026-08-19', valorVenta: 900_000, disbursementStatus: 'pendiente' },
    ],
  }])
  const a = await getCashboxSummary('r-A', SEM_INI, SEM_FIN, asCashboxDb(db))
  metric('préstamos entregados', a.prestamosEntregados)
  metric('saldo final', a.saldoActual)
  assert(a.prestamosEntregados === 300_000, 'la venta pendiente de desembolso descontó caja')
  assert(a.saldoActual === 700_000, `saldo final incorrecto: ${a.saldoActual}`)
})

await spec('CASH-ROUTE-004', 'Caja por ruta', 'un pago corregido no infla la caja (reversión + reemplazo)', async () => {
  // Original 300.000 revertido y reemplazado por 250.000: la caja debe ver 250.000.
  const db = buildCashboxScenario([{
    routeId: 'r-A',
    pagos: [
      { fecha: '2026-08-19', valor: 300_000, state: 'reversed' },
      { fecha: '2026-08-19', valor: -300_000, state: 'reversal' },
      { fecha: '2026-08-19', valor: 250_000, state: 'active' },
    ],
  }])
  const a = await getCashboxSummary('r-A', SEM_INI, SEM_FIN, asCashboxDb(db))
  metric('cobros netos', a.cobros)
  metric('regla', 'el asiento de reversión es negativo: se netea sin filtrar por state')
  assert(a.cobros === 250_000, `cobros tras corrección: ${a.cobros}`)
})


// ############################################################
// RQ-03 — REPORTES POR RUTA
// ------------------------------------------------------------
// El scoping es de DOS pasos y en ese orden: (1) rutas permitidas al usuario,
// (2) ruta elegida. La interseccion hace que una ruta fuera del alcance produzca
// CERO filas en vez de un acceso.
// ############################################################

/** Empresa con dos rutas y datos claramente distinguibles en cada una. */
function fuentesDosRutas(): ReportSources {
  const mkPay = (id: string, routeId: string, valor: number, fecha: string) => ({
    id, tenantId: 't-1', saleId: `s-${id}`, clientId: routeId === 'r-A' ? 'c-A' : 'c-B',
    routeId, collectorId: 'u-cob', valor, fecha, tipo: 'efectivo' as const,
    syncStatus: 'synced' as const, createdAt: `${fecha}T10:00:00.000Z`, state: 'active' as const,
  })
  const mkSale = (id: string, routeId: string, valorVenta: number, createdAt: string) => ({
    id, tenantId: 't-1', routeId, clientId: routeId === 'r-A' ? 'c-A' : 'c-B',
    createdByUserId: 'u-cob', valorVenta, tasaInteres: 20, valorInteres: 0, valorTotal: valorVenta,
    saldo: valorVenta, numeroCuotas: 1, valorCuota: valorVenta, frecuenciaPago: 'diaria' as const,
    fechaInicio: createdAt.slice(0, 10), fechaFinalEstimada: createdAt.slice(0, 10),
    status: 'activa' as const, createdAt, updatedAt: createdAt,
  })
  const mkExp = (id: string, routeId: string, valor: number, fecha: string) => ({
    id, tenantId: 't-1', routeId, categoryId: 'cat-1', valor, fecha,
    userId: 'u-cob', syncStatus: 'synced' as const, createdAt: `${fecha}T11:00:00.000Z`,
  })
  return {
    payments: [
      mkPay('p-A1', 'r-A', 100_000, '2026-08-19'),
      mkPay('p-A2', 'r-A', 50_000, '2026-08-20'),
      mkPay('p-B1', 'r-B', 900_000, '2026-08-19'),
      mkPay('p-A3', 'r-A', 777_000, '2026-07-01'),
    ] as never,
    sales: [
      mkSale('s-A1', 'r-A', 300_000, '2026-08-19T09:00:00.000Z'),
      mkSale('s-B1', 'r-B', 800_000, '2026-08-19T09:00:00.000Z'),
    ] as never,
    expenses: [
      mkExp('e-A1', 'r-A', 20_000, '2026-08-20'),
      mkExp('e-B1', 'r-B', 60_000, '2026-08-20'),
    ] as never,
    clients: [
      { id: 'c-A', tenantId: 't-1', routeId: 'r-A', nombre: 'Cliente A', documento: '1' },
      { id: 'c-B', tenantId: 't-1', routeId: 'r-B', nombre: 'Cliente B', documento: '2' },
    ] as never,
    routes: [
      { id: 'r-A', tenantId: 't-1', nombre: 'Ruta A', codigo: 'RT-001' },
      { id: 'r-B', tenantId: 't-1', nombre: 'Ruta B', codigo: 'RT-002' },
    ] as never,
    categories: [{ id: 'cat-1', tenantId: 't-1', nombre: 'Transporte', activa: true }] as never,
  }
}

const RANGO = { fechaDesde: '2026-08-17', fechaHasta: '2026-08-22' }
const soloA = { routeIds: new Set(['r-A']), ...RANGO }

await spec('REP-ROUTE-001', 'Reportes', 'los 4 reportes filtrados a la Ruta A no traen registros de la Ruta B', () => {
  const src = fuentesDosRutas()
  for (const tipo of REPORT_OPTIONS.map(o => o.value)) {
    const rows = buildReport(tipo, src, soloA)
    const rutas = [...new Set(rows.map(r => String(r.Ruta)))]
    metric(`${tipo} -> filas`, `${rows.length} (rutas: ${rutas.join(', ') || '-'})`)
    assert(rows.length > 0, `${tipo}: el reporte de la Ruta A quedo vacio`)
    assert(rutas.every(n => n === 'Ruta A'), `${tipo}: se colo otra ruta -> ${rutas.join(', ')}`)
  }
})

await spec('REP-ROUTE-002', 'Reportes', 'los importes del reporte de A son exactamente los de A', () => {
  const src = fuentesDosRutas()
  const pagos = buildReport('pagos', src, soloA)
  const total = pagos.reduce((s, r) => s + Number(r.Valor), 0)
  metric('pagos de A dentro del rango', total)
  assert(total === 150_000, `total contaminado o fuera de rango: ${total}`)

  const caja = buildReport('caja_diaria', src, soloA)
  const cobros = caja.reduce((s, r) => s + Number(r.Cobros), 0)
  const gastos = caja.reduce((s, r) => s + Number(r.Gastos), 0)
  metric('caja diaria A', `cobros=${cobros} gastos=${gastos}`)
  assert(cobros === 150_000 && gastos === 20_000, `caja diaria contaminada: ${cobros}/${gastos}`)
})

await spec('REP-SCOPE-001', 'Reportes', 'Todas las rutas consolida UNICAMENTE las rutas permitidas', () => {
  const src = fuentesDosRutas()
  const efectivas = resolveReportRouteIds(new Set(['r-A']), '')
  metric('rutas efectivas con seleccion Todas', [...efectivas].join(', '))
  const rows = buildReport('pagos', src, { routeIds: efectivas, ...RANGO })
  const rutas = [...new Set(rows.map(r => String(r.Ruta)))]
  metric('rutas presentes', rutas.join(', '))
  assert(efectivas.size === 1 && efectivas.has('r-A'), 'Todas amplio el alcance del usuario')
  assert(rutas.every(n => n === 'Ruta A'), 'se consolidaron rutas no autorizadas')
})

await spec('REP-SCOPE-002', 'Reportes', 'el Super Admin ve todas las rutas de la empresa actual', () => {
  const src = fuentesDosRutas()
  const efectivas = resolveReportRouteIds(new Set(['r-A', 'r-B']), '')
  const rows = buildReport('pagos', src, { routeIds: efectivas, ...RANGO })
  const rutas = [...new Set(rows.map(r => String(r.Ruta)))].sort()
  metric('rutas consolidadas', rutas.join(', '))
  assert(rutas.length === 2, `el Super Admin no consolido ambas rutas: ${rutas.join(', ')}`)
})

await spec('REP-SCOPE-003', 'Reportes', 'elegir una ruta FUERA del alcance devuelve cero filas (fail-closed)', () => {
  const src = fuentesDosRutas()
  const efectivas = resolveReportRouteIds(new Set(['r-A']), 'r-B')
  metric('rutas efectivas', efectivas.size === 0 ? '(vacio)' : [...efectivas].join(', '))
  assert(efectivas.size === 0, 'una ruta fuera del alcance NO debe resolverse')
  for (const tipo of REPORT_OPTIONS.map(o => o.value)) {
    const rows = buildReport(tipo, src, { routeIds: efectivas, ...RANGO })
    metric(`${tipo} -> filas`, rows.length)
    assert(rows.length === 0, `${tipo}: se filtraron datos de una ruta no autorizada`)
  }
})

await spec('REP-CSV-001', 'Reportes', 'lo que se exporta a CSV es exactamente lo generado para esa ruta', () => {
  const src = fuentesDosRutas()
  const rows = buildReport('pagos', src, soloA)
  const ajenas = rows.filter(r => String(r.Ruta) !== 'Ruta A')
  metric('filas exportables', rows.length)
  metric('filas de otra ruta', ajenas.length)
  assert(ajenas.length === 0, 'el CSV contendria registros de otra ruta')
  assert(rows.every(r => 'Ruta' in r), 'el CSV perdio la columna Ruta')
})

await spec('REP-SEM-001', 'Reportes', 'un pago corregido aparece una sola vez, no como tres movimientos', () => {
  const src = fuentesDosRutas()
  const base = {
    tenantId: 't-1', saleId: 's-A1', clientId: 'c-A', routeId: 'r-A', collectorId: 'u-cob',
    fecha: '2026-08-21', tipo: 'efectivo' as const, syncStatus: 'synced' as const,
    createdAt: '2026-08-21T10:00:00.000Z',
  }
  src.payments = [
    ...src.payments,
    { ...base, id: 'p-orig', valor: 100_000, state: 'reversed', correctedByPaymentId: 'p-corr' },
    { ...base, id: 'p-rev', valor: -100_000, state: 'reversal', reversesPaymentId: 'p-orig' },
    { ...base, id: 'p-corr', valor: 80_000, state: 'active', correctionOfPaymentId: 'p-orig' },
  ] as never

  const rows = buildReport('pagos', src, soloA)
  const del21 = rows.filter(r => String(r.Fecha).includes('21'))
  const total = rows.reduce((s, r) => s + Number(r.Valor), 0)
  metric('movimientos listados del dia corregido', del21.length)
  metric('valores del dia corregido', del21.map(r => r.Valor).join(', '))
  metric('total del reporte', total)
  assert(del21.length === 1, `el pago corregido se lista ${del21.length} veces (debe ser 1)`)
  assert(Number(del21[0].Valor) === 80_000, `se listo el importe equivocado: ${del21[0].Valor}`)
  assert(!rows.some(r => Number(r.Valor) < 0), 'el reporte muestra asientos de reversion negativos')
  assert(total === 230_000, `total incorrecto tras la correccion: ${total}`)

  const caja = buildReport('caja_diaria', src, soloA)
  const cobros = caja.reduce((s, r) => s + Number(r.Cobros), 0)
  metric('cobros de caja diaria', cobros)
  assert(cobros === 230_000, `caja diaria incoherente con el reporte de pagos: ${cobros}`)
})

await spec('REP-DATE-001', 'Reportes', 'el rango de fechas se respeta dentro de la ruta elegida', () => {
  const src = fuentesDosRutas()
  const rows = buildReport('pagos', src, { routeIds: new Set(['r-A']), fechaDesde: '2026-07-01', fechaHasta: '2026-07-31' })
  const total = rows.reduce((s, r) => s + Number(r.Valor), 0)
  metric('filas en julio', rows.length)
  metric('total julio', total)
  assert(rows.length === 1 && total === 777_000, `el rango de fechas no se aplico: ${rows.length} filas / ${total}`)
})


// ############################################################
// RQ-02 — LIQUIDACION SEMANAL POR RUTA
// ------------------------------------------------------------
// La liquidacion es SIEMPRE de una ruta. Se apoya integramente en
// getCashboxSummary, asi que estos casos comprueban dos cosas distintas:
//   1. que la liquidacion refleje exactamente la caja de ESA ruta;
//   2. que el alcance del usuario se valide en el SERVICIO, no solo en la UI.
// ############################################################

/** Misma empresa, dos rutas con movimientos deliberadamente distintos. */
function rutasParaLiquidar() {
  return buildCashboxScenario([
    {
      routeId: 'r-A', nombre: 'Ruta A', codigo: 'RT-001',
      capital: [{ fecha: '2026-08-10', valor: 2_000_000 }],
      pagos: [{ fecha: '2026-08-19', valor: 400_000 }, { fecha: '2026-08-20', valor: 100_000 }],
      ventas: [{ fechaInicio: '2026-08-19', valorVenta: 300_000 }],
      gastos: [{ fecha: '2026-08-20', valor: 25_000 }],
      retiros: [{ fecha: '2026-08-21', valor: 75_000 }],
    },
    {
      routeId: 'r-B', nombre: 'Ruta B', codigo: 'RT-002',
      capital: [{ fecha: '2026-08-10', valor: 50_000_000 }],
      pagos: [{ fecha: '2026-08-19', valor: 9_000_000 }],
      ventas: [{ fechaInicio: '2026-08-20', valorVenta: 6_000_000 }],
      gastos: [{ fecha: '2026-08-20', valor: 400_000 }],
      retiros: [{ fecha: '2026-08-21', valor: 300_000 }],
    },
  ])
}

const mkUserRutas = (rol: User['rol'], routeIds: string[]): User => ({
  id: `u-${rol}`, tenantId: TEST_IDS.TENANT_ID, nombre: rol, email: `${rol}@t.com`, password: 'x',
  rol, status: 'activo', authorizedRouteIds: routeIds, createdAt: '', updatedAt: '',
})

await spec('SETTLE-ROUTE-001', 'Liquidacion', 'la liquidacion de la Ruta A no incluye ningun movimiento de la Ruta B', async () => {
  const db = rutasParaLiquidar()
  const a = await generateWeeklySettlement(
    { tenantId: TEST_IDS.TENANT_ID, routeId: 'r-A', semanaInicio: SEM_INI, semanaFin: SEM_FIN },
    asCashboxDb(db),
  )
  metric('ruta liquidada', a.routeId)
  metric('cobros', a.cobros)
  metric('prestamos', a.prestamosEntregados)
  metric('gastos', a.gastos)
  metric('retiros', a.retiros)
  metric('saldo anterior', a.saldoAnterior)
  metric('saldo final', a.saldoFinal)
  assert(a.routeId === 'r-A', 'la liquidacion no identifica su ruta')
  assert(a.cobros === 500_000, `cobros contaminados: ${a.cobros}`)
  assert(a.prestamosEntregados === 300_000, `prestamos contaminados: ${a.prestamosEntregados}`)
  assert(a.gastos === 25_000, `gastos contaminados: ${a.gastos}`)
  assert(a.retiros === 75_000, `retiros contaminados: ${a.retiros}`)
  assert(a.ingresoCapital === 0, 'el capital previo se conto dentro de la semana')
  // Saldo anterior: solo el capital de A del 10-ago.
  assert(a.saldoAnterior === 2_000_000, `saldo anterior contaminado: ${a.saldoAnterior}`)
  // 2.000.000 + 500.000 - 300.000 - 25.000 - 75.000
  assert(a.saldoFinal === 2_100_000, `saldo final contaminado: ${a.saldoFinal}`)
})

await spec('SETTLE-ROUTE-002', 'Liquidacion', 'liquidar A y liquidar B dan resultados independientes', async () => {
  const db = rutasParaLiquidar()
  const params = { tenantId: TEST_IDS.TENANT_ID, semanaInicio: SEM_INI, semanaFin: SEM_FIN }
  const a = await generateWeeklySettlement({ ...params, routeId: 'r-A' }, asCashboxDb(db))
  const b = await generateWeeklySettlement({ ...params, routeId: 'r-B' }, asCashboxDb(db))
  metric('saldo final A', a.saldoFinal)
  metric('saldo final B', b.saldoFinal)
  assert(a.cobros === 500_000 && b.cobros === 9_000_000, 'los cobros se mezclaron entre rutas')
  assert(a.saldoFinal !== b.saldoFinal, 'ambas rutas devolvieron el mismo saldo: hay consolidacion')
  // B: 50.000.000 + 9.000.000 - 6.000.000 - 400.000 - 300.000
  assert(b.saldoFinal === 52_300_000, `saldo final de B incorrecto: ${b.saldoFinal}`)
})

await spec('SETTLE-SCOPE-001', 'Liquidacion', 'un Administrador NO puede liquidar una ruta fuera de su alcance', async () => {
  const db = rutasParaLiquidar()
  const adminSoloA = mkUserRutas('admin', ['r-A'])
  const params = { tenantId: TEST_IDS.TENANT_ID, semanaInicio: SEM_INI, semanaFin: SEM_FIN }

  const propia = await generateWeeklySettlementForUser({ ...params, routeId: 'r-A', user: adminSoloA }, asCashboxDb(db))
  const ajena = await generateWeeklySettlementForUser({ ...params, routeId: 'r-B', user: adminSoloA }, asCashboxDb(db))
  metric('ruta propia (r-A)', propia ? `saldo ${propia.saldoFinal}` : 'null')
  metric('ruta ajena (r-B)', ajena === null ? 'null (fail-closed)' : 'DEVOLVIO DATOS')
  assert(propia !== null, 'el Administrador no pudo liquidar su propia ruta')
  assert(ajena === null, 'se liquido una ruta fuera del alcance del usuario')
})

await spec('SETTLE-SCOPE-002', 'Liquidacion', 'un Administrador SIN rutas no puede liquidar nada (fail-closed)', async () => {
  const db = rutasParaLiquidar()
  const sinRutas = mkUserRutas('admin', [])
  const params = { tenantId: TEST_IDS.TENANT_ID, semanaInicio: SEM_INI, semanaFin: SEM_FIN }
  for (const routeId of ['r-A', 'r-B']) {
    const r = await generateWeeklySettlementForUser({ ...params, routeId, user: sinRutas }, asCashboxDb(db))
    metric(`liquidacion de ${routeId}`, r === null ? 'null (fail-closed)' : 'DEVOLVIO DATOS')
    assert(r === null, `un Admin sin rutas liquido ${routeId}`)
  }
  const anonimo = await generateWeeklySettlementForUser({ ...params, routeId: 'r-A', user: null }, asCashboxDb(db))
  metric('sin sesion', anonimo === null ? 'null' : 'DEVOLVIO DATOS')
  assert(anonimo === null, 'sin sesion se genero una liquidacion')
})

await spec('SETTLE-SCOPE-003', 'Liquidacion', 'el Super Admin puede liquidar cualquier ruta de la empresa', async () => {
  const db = rutasParaLiquidar()
  const su = mkUserRutas('superadmin', [])
  const params = { tenantId: TEST_IDS.TENANT_ID, semanaInicio: SEM_INI, semanaFin: SEM_FIN }
  const a = await generateWeeklySettlementForUser({ ...params, routeId: 'r-A', user: su }, asCashboxDb(db))
  const b = await generateWeeklySettlementForUser({ ...params, routeId: 'r-B', user: su }, asCashboxDb(db))
  metric('r-A', a ? a.saldoFinal : 'null')
  metric('r-B', b ? b.saldoFinal : 'null')
  assert(a !== null && b !== null, 'el Super Admin no pudo liquidar alguna ruta')
  assert(a!.cobros === 500_000 && b!.cobros === 9_000_000, 'las cifras se mezclaron para el Super Admin')
})

await spec('SETTLE-CSV-001', 'Liquidacion', 'el CSV de la Ruta A contiene solo la Ruta A', async () => {
  const db = rutasParaLiquidar()
  const a = await generateWeeklySettlement(
    { tenantId: TEST_IDS.TENANT_ID, routeId: 'r-A', semanaInicio: SEM_INI, semanaFin: SEM_FIN },
    asCashboxDb(db),
  )
  // Replica de exportCSV(): una unica fila, la de la ruta liquidada.
  const rows = [{
    Ruta: 'Ruta A',
    Cobros: a.cobros, Gastos: a.gastos, Retiros: a.retiros,
    'Saldo anterior': a.saldoAnterior, 'Saldo final': a.saldoFinal,
  }]
  metric('filas exportadas', rows.length)
  metric('rutas presentes', [...new Set(rows.map(r => r.Ruta))].join(', '))
  assert(rows.length === 1, 'el CSV de una liquidacion debe tener una sola fila de ruta')
  assert(rows.every(r => r.Ruta === 'Ruta A'), 'el CSV incluye otra ruta')
  assert(rows[0].Cobros === 500_000, `el CSV exporta cobros contaminados: ${rows[0].Cobros}`)
})

await spec('SETTLE-SRC-001', 'Liquidacion', 'ya no existe el modo consolidado "todas las rutas"', () => {
  const engine = readSource('src/services/weeklySettlementEngine.ts')
  const page = readSource('src/pages/admin/WeeklySettlementPage.tsx')
  metric('getAllRoutesWeeklySettlement en el motor', /getAllRoutesWeeklySettlement/.test(engine))
  metric('la pantalla exige ruta', page.includes('Selecciona la ruta que deseas liquidar.'))
  metric('la pantalla valida el alcance', page.includes('canAccessRoute(user, routeId)'))
  metric('el servicio valida el alcance', engine.includes('canAccessRoute(user, rest.routeId)'))
  assert(!/getAllRoutesWeeklySettlement/.test(engine), 'sigue existiendo el orquestador consolidado')
  assert(!/getAllRoutesWeeklySettlement/.test(page), 'la pantalla sigue llamando al modo consolidado')
  assert(page.includes('Selecciona la ruta que deseas liquidar.'), 'la ruta dejo de ser obligatoria en la pantalla')
  assert(engine.includes('canAccessRoute(user, rest.routeId)'), 'el servicio dejo de aplicar fail-closed')
  // El motor no reimplementa el calculo: lo delega en getCashboxSummary.
  assert(engine.includes('getCashboxSummary('), 'la liquidacion dejo de reutilizar el motor de caja')
})


// ############################################################
// RQ-04 — HISTORIAL DE CREDITOS DEL CLIENTE
// ------------------------------------------------------------
// Dos reglas que estos casos protegen:
//   1. el historial se cruza por clientId, JAMAS por nombre;
//   2. fechaFinalEstimada (cuando deberia terminar) y fechaFinalizacion (cuando
//      termino de verdad) son datos distintos y no se sustituyen entre si.
// ############################################################

/** Venta de prueba con los campos que consume el historial. */
function venta(over: Partial<Sale> & { id: string; clientId: string }): Sale {
  return {
    tenantId: 't-1', routeId: 'r-A', createdByUserId: 'u-cob',
    valorVenta: 100_000, tasaInteres: 20, valorInteres: 20_000, valorTotal: 120_000,
    saldo: 0, numeroCuotas: 30, valorCuota: 4_000, frecuenciaPago: 'diaria',
    fechaInicio: '2026-01-01', fechaFinalEstimada: '2026-01-31',
    status: 'finalizada', createdAt: '2026-01-01T09:00:00.000Z', updatedAt: '2026-06-01T09:00:00.000Z',
    ...over,
  } as Sale
}

/** Pago de prueba. */
function pago(over: Partial<Payment> & { id: string; saleId: string; clientId: string }): Payment {
  return {
    tenantId: 't-1', routeId: 'r-A', collectorId: 'u-cob',
    valor: 10_000, fecha: '2026-01-10', tipo: 'efectivo', syncStatus: 'synced',
    createdAt: '2026-01-10T10:00:00.000Z', state: 'active',
    ...over,
  } as Payment
}

await spec('HIST-001', 'Historial', 'un cliente con varios creditos los muestra todos', () => {
  const sales = [
    venta({ id: 's-1', clientId: 'c-1', valorVenta: 300_000, fechaInicio: '2026-01-01', fechaFinalizacion: '2026-02-10' }),
    venta({ id: 's-2', clientId: 'c-1', valorVenta: 500_000, fechaInicio: '2026-03-01', fechaFinalizacion: '2026-04-15' }),
    venta({ id: 's-3', clientId: 'c-1', valorVenta: 700_000, fechaInicio: '2026-06-01', status: 'activa', saldo: 400_000, fechaFinalizacion: undefined }),
    // Credito de OTRO cliente: no debe aparecer.
    venta({ id: 's-x', clientId: 'c-2', valorVenta: 999_000 }),
  ]
  const payments = [
    pago({ id: 'p-1', saleId: 's-1', clientId: 'c-1', valor: 360_000 }),
    pago({ id: 'p-2', saleId: 's-2', clientId: 'c-1', valor: 600_000 }),
    pago({ id: 'p-3', saleId: 's-3', clientId: 'c-1', valor: 440_000 }),
    pago({ id: 'p-x', saleId: 's-x', clientId: 'c-2', valor: 999_000 }),
  ]
  const h = buildClientCreditHistory('c-1', sales, payments)
  metric('cantidad de creditos', h.total)
  metric('activos / finalizados', `${h.activos} / ${h.finalizados}`)
  metric('valores', h.entries.map(e => e.valorVenta).join(', '))
  metric('total prestado', h.totalPrestado)
  metric('total abonado', h.totalAbonado)
  metric('saldo pendiente', h.saldoPendiente)
  assert(h.total === 3, `debe mostrar 3 creditos, mostro ${h.total}`)
  assert(h.activos === 1 && h.finalizados === 2, `conteo por estado incorrecto: ${h.activos}/${h.finalizados}`)
  assert(h.entries.every(e => e.saleId !== 's-x'), 'se colo el credito de otro cliente')
  assert(h.totalPrestado === 1_500_000, `total prestado incorrecto: ${h.totalPrestado}`)
  assert(h.totalAbonado === 1_400_000, `total abonado incorrecto: ${h.totalAbonado}`)
  assert(h.saldoPendiente === 400_000, `saldo pendiente incorrecto: ${h.saldoPendiente}`)
  // Del mas reciente al mas antiguo.
  assert(h.entries[0].saleId === 's-3', 'el historial no esta ordenado del mas reciente al mas antiguo')
})

await spec('HIST-002', 'Historial', 'un credito ACTIVO nunca aparece como finalizado', () => {
  const sales = [
    venta({ id: 's-act', clientId: 'c-1', status: 'activa', saldo: 50_000, fechaFinalizacion: undefined }),
    // Dato inconsistente heredado: activa PERO con fecha de finalizacion guardada.
    venta({ id: 's-raro', clientId: 'c-1', status: 'activa', saldo: 10_000, fechaFinalizacion: '2026-05-05' }),
  ]
  const h = buildClientCreditHistory('c-1', sales, [])
  const act = h.entries.find(e => e.saleId === 's-act')!
  const raro = h.entries.find(e => e.saleId === 's-raro')!
  metric('estado del credito activo', act.estado)
  metric('fecha de finalizacion del activo', String(act.fechaFinalizacion))
  metric('activo con fecha heredada -> se ignora', String(raro.fechaFinalizacion))
  assert(act.estado === 'Activo', `el credito activo se etiqueto como ${act.estado}`)
  assert(act.fechaFinalizacion === undefined, 'un credito activo no puede tener fecha real de finalizacion')
  assert(raro.fechaFinalizacion === undefined, 'una venta activa con fecha heredada la sigue mostrando')
  assert(h.finalizados === 0, 'se conto como finalizado un credito activo')
})

await spec('HIST-003', 'Historial', 'un credito PERDIDO no inventa fecha de finalizacion', () => {
  const sales = [
    venta({ id: 's-perd', clientId: 'c-1', status: 'perdida', saldo: 80_000, motivoPerdida: 'ilocalizable', updatedAt: '2026-09-09T00:00:00.000Z', fechaFinalizacion: undefined }),
    venta({ id: 's-ref', clientId: 'c-1', status: 'refinanciada', saldo: 0, fechaFinalizacion: undefined }),
  ]
  const h = buildClientCreditHistory('c-1', sales, [pago({ id: 'p-1', saleId: 's-perd', clientId: 'c-1', valor: 20_000 })])
  const perd = h.entries.find(e => e.saleId === 's-perd')!
  const ref = h.entries.find(e => e.saleId === 's-ref')!
  metric('estado', perd.estado)
  metric('fecha de finalizacion del perdido', String(perd.fechaFinalizacion))
  metric('estado del refinanciado', ref.estado)
  assert(perd.estado === 'Perdido' && ref.estado === 'Refinanciado', 'etiquetas de estado incorrectas')
  assert(perd.fechaFinalizacion === undefined, 'un credito perdido no debe tener fecha real de finalizacion')
  assert(ref.fechaFinalizacion === undefined, 'un credito refinanciado no debe tener fecha real de finalizacion')
  assert(h.perdidos === 1 && h.refinanciados === 1, 'conteo por estado incorrecto')
  // Y su etiqueta esta en el catalogo oficial de estados.
  assert(CREDIT_STATUS_LABEL.perdida === 'Perdido', 'cambio la etiqueta oficial del estado perdido')
})

await spec('HIST-004', 'Historial', 'un credito FINALIZADO expone su fecha real, distinta de la estimada', () => {
  const sales = [venta({
    id: 's-fin', clientId: 'c-1', status: 'finalizada',
    fechaInicio: '2026-01-01', fechaFinalEstimada: '2026-01-31', fechaFinalizacion: '2026-02-18',
  })]
  const h = buildClientCreditHistory('c-1', sales, [])
  const e = h.entries[0]
  metric('fecha de creacion (comercial)', e.fechaInicio)
  metric('fin estimado', e.fechaFinEstimada)
  metric('finalizacion real', String(e.fechaFinalizacion))
  assert(e.fechaFinalizacion === '2026-02-18', `fecha real incorrecta: ${e.fechaFinalizacion}`)
  assert(e.fechaFinEstimada === '2026-01-31', 'se perdio la fecha estimada')
  assert(e.fechaFinalizacion !== e.fechaFinEstimada, 'la fecha real quedo igualada a la estimada')
  // La fecha de creacion del credito es la COMERCIAL (fechaInicio), no createdAt.
  assert(e.fechaInicio === '2026-01-01', 'la fecha de creacion no es la fecha comercial del credito')
})

await spec('HIST-005', 'Historial', 'dos clientes con el MISMO nombre no mezclan historiales', () => {
  // Mismo nombre y hasta el mismo documento: solo el id los distingue.
  const sales = [
    venta({ id: 's-a1', clientId: 'c-ana-1', valorVenta: 100_000 }),
    venta({ id: 's-a2', clientId: 'c-ana-1', valorVenta: 200_000 }),
    venta({ id: 's-b1', clientId: 'c-ana-2', valorVenta: 900_000 }),
  ]
  const payments = [
    pago({ id: 'p-a1', saleId: 's-a1', clientId: 'c-ana-1', valor: 120_000 }),
    pago({ id: 'p-b1', saleId: 's-b1', clientId: 'c-ana-2', valor: 999_000 }),
  ]
  const a = buildClientCreditHistory('c-ana-1', sales, payments)
  const b = buildClientCreditHistory('c-ana-2', sales, payments)
  metric('Ana (id c-ana-1)', `${a.total} creditos / prestado ${a.totalPrestado} / abonado ${a.totalAbonado}`)
  metric('Ana (id c-ana-2)', `${b.total} creditos / prestado ${b.totalPrestado} / abonado ${b.totalAbonado}`)
  assert(a.total === 2 && b.total === 1, `historiales mezclados: ${a.total} / ${b.total}`)
  assert(a.totalPrestado === 300_000 && b.totalPrestado === 900_000, 'importes mezclados entre homonimos')
  assert(a.totalAbonado === 120_000 && b.totalAbonado === 999_000, 'abonos mezclados entre homonimos')
  assert(a.entries.every(e => e.saleId !== 's-b1'), 'un credito del homonimo aparece en el historial equivocado')
})

await spec('HIST-006', 'Historial', 'los abonos revertidos no cuentan en el historial', () => {
  const sales = [venta({ id: 's-1', clientId: 'c-1', status: 'activa', saldo: 40_000 })]
  const payments = [
    pago({ id: 'p-orig', saleId: 's-1', clientId: 'c-1', valor: 100_000, state: 'reversed' }),
    pago({ id: 'p-rev', saleId: 's-1', clientId: 'c-1', valor: -100_000, state: 'reversal' }),
    pago({ id: 'p-corr', saleId: 's-1', clientId: 'c-1', valor: 80_000, state: 'active' }),
    // Pago heredado sin `state`: cuenta (compatibilidad).
    pago({ id: 'p-legacy', saleId: 's-1', clientId: 'c-1', valor: 5_000, state: undefined }),
  ]
  const h = buildClientCreditHistory('c-1', sales, payments)
  metric('abonado segun el historial', h.totalAbonado)
  metric('pagos vigentes', effectivePayments(payments).length)
  assert(h.totalAbonado === 85_000, `el historial no aplico la semantica de correccion: ${h.totalAbonado}`)
  assert(effectivePayments(payments).length === 2, 'la definicion de pago vigente cambio')
})

await spec('HIST-007', 'Historial', 'un cliente sin creditos devuelve un historial vacio, no un error', () => {
  const h = buildClientCreditHistory('c-sin-nada', [venta({ id: 's-1', clientId: 'c-otro' })], [])
  metric('creditos', h.total)
  metric('entradas', h.entries.length)
  assert(h.total === 0 && h.entries.length === 0, 'un cliente sin creditos no devolvio historial vacio')
  assert(h.totalPrestado === 0 && h.saldoPendiente === 0, 'totales no nulos en un historial vacio')
  // Sin clientId no se devuelve nada (fail-closed).
  assert(buildClientCreditHistory('', [venta({ id: 's-1', clientId: 'c-otro' })], []).total === 0, 'sin clientId se devolvieron creditos')
})

// ------------------------------------------------------------
// SELLADO DE LA FECHA REAL DE FINALIZACION
// ------------------------------------------------------------
await spec('HIST-SEAL-001', 'Historial', 'al saldar la venta se sella la fecha CONTABLE del abono que la cerro', async () => {
  // Venta de 2 parcelas: el segundo abono la cierra, con fecha contable propia.
  const sc = buildScenario({ valorVenta: 100_000, numeroCuotas: 2, parcelasPagadas: 1 })
  const saldo = (await sc.db.sales.get(TEST_IDS.SALE_ID))!.saldo
  const res = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: saldo, actor: USER_ADMIN, fecha: '2026-09-07' },
    asDb(sc.db),
  )
  const sale = (await sc.db.sales.get(TEST_IDS.SALE_ID))!
  metric('resultado', res.ok ? `saldo ${res.newBalance} estado ${res.saleStatus}` : res.code)
  metric('fechaFinalizacion sellada', String(sale.fechaFinalizacion))
  metric('updatedAt (NO se usa como cierre)', sale.updatedAt.slice(0, 10))
  assert(res.ok && res.saleStatus === 'finalizada', 'la venta no quedo finalizada')
  assert(sale.fechaFinalizacion === '2026-09-07', `no se sello la fecha contable del abono: ${sale.fechaFinalizacion}`)
  assert(sale.fechaFinalizacion !== sale.updatedAt, 'se uso updatedAt como fecha de finalizacion')
  assert(sale.fechaFinalizacion !== sale.fechaFinalEstimada, 'se uso la fecha estimada como fecha real')
})

await spec('HIST-SEAL-002', 'Historial', 'un abono que NO cierra la venta no sella ninguna fecha', async () => {
  const sc = buildScenario({ valorVenta: 100_000, numeroCuotas: 10 })
  const res = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: 5_000, actor: USER_ADMIN, fecha: '2026-09-07' },
    asDb(sc.db),
  )
  const sale = (await sc.db.sales.get(TEST_IDS.SALE_ID))!
  metric('estado', res.ok ? res.saleStatus : 'rechazado')
  metric('fechaFinalizacion', String(sale.fechaFinalizacion))
  assert(res.ok && res.saleStatus === 'activa', 'la venta no siguio activa')
  assert(sale.fechaFinalizacion === undefined, 'se sello una fecha de finalizacion en una venta activa')
})

await spec('HIST-SEAL-003', 'Historial', 'una fecha ya sellada no se reescribe mientras la venta siga cerrada', () => {
  // Regla pura aplicada por paymentCorrectionService al recomputar.
  const conservada = resolveSealedCompletionDate({
    status: 'finalizada', sealed: '2026-02-18', lastEffectivePaymentDate: '2026-03-30',
  })
  metric('fecha sellada previa', '2026-02-18')
  metric('ultimo pago vigente tras la correccion', '2026-03-30')
  metric('resultado', String(conservada))
  assert(conservada === '2026-02-18', `la correccion reescribio una fecha ya sellada: ${conservada}`)

  // Si nunca se sello (dato heredado), se infiere del ultimo pago vigente.
  const inferida = resolveSealedCompletionDate({
    status: 'finalizada', sealed: undefined, lastEffectivePaymentDate: '2026-03-30',
  })
  metric('sin sellar -> se infiere', String(inferida))
  assert(inferida === '2026-03-30', 'no se infirio la fecha del ultimo pago vigente')

  // Sin ninguna fuente fiable NO se inventa nada.
  const sinFuente = resolveSealedCompletionDate({ status: 'finalizada', sealed: undefined, lastEffectivePaymentDate: undefined })
  metric('sin fuente fiable', String(sinFuente))
  assert(sinFuente === undefined, 'se invento una fecha de finalizacion sin fuente')
})

await spec('HIST-SEAL-004', 'Historial', 'si una correccion REABRE la venta, la fecha de cierre se limpia', () => {
  // Unica excepcion admitida: la venta vuelve a tener saldo -> el cierre ya no existe.
  const reabierta = resolveSealedCompletionDate({
    status: 'activa', sealed: '2026-02-18', lastEffectivePaymentDate: '2026-02-18',
  })
  metric('estado tras la correccion', 'activa')
  metric('fecha de cierre resultante', String(reabierta))
  assert(reabierta === undefined, 'una venta reabierta conservo su fecha de finalizacion (dato falso)')

  // Perdida o refinanciada tampoco conservan fecha real de finalizacion.
  assert(resolveSealedCompletionDate({ status: 'perdida', sealed: '2026-02-18' }) === undefined, 'una venta perdida conservo fecha de cierre')
  assert(resolveSealedCompletionDate({ status: 'refinanciada', sealed: '2026-02-18' }) === undefined, 'una venta refinanciada conservo fecha de cierre')

  // Y al volver a saldarse se sella la NUEVA fecha real.
  const recerrada = resolveSealedCompletionDate({ status: 'finalizada', sealed: undefined, lastEffectivePaymentDate: '2026-05-02' })
  metric('vuelve a saldarse', String(recerrada))
  assert(recerrada === '2026-05-02', 'no se sello la nueva fecha real tras volver a cerrarse')
})

await spec('HIST-MIG-001', 'Historial', 'la migracion historica infiere la fecha del ultimo pago vigente, o la deja vacia', () => {
  // Replica exacta de la migracion v9 de db.ts sobre datos heredados.
  const salesHeredadas: Sale[] = [
    venta({ id: 's-con-pagos', clientId: 'c-1', status: 'finalizada', fechaFinalizacion: undefined }),
    venta({ id: 's-sin-pagos', clientId: 'c-1', status: 'finalizada', fechaFinalizacion: undefined }),
    venta({ id: 's-ya-sellada', clientId: 'c-1', status: 'finalizada', fechaFinalizacion: '2025-12-01' }),
    venta({ id: 's-activa', clientId: 'c-1', status: 'activa', saldo: 10_000, fechaFinalizacion: undefined }),
    venta({ id: 's-perdida', clientId: 'c-1', status: 'perdida', saldo: 10_000, fechaFinalizacion: undefined }),
  ]
  const pagosHeredados: Payment[] = [
    pago({ id: 'p-1', saleId: 's-con-pagos', clientId: 'c-1', fecha: '2026-03-01' }),
    pago({ id: 'p-2', saleId: 's-con-pagos', clientId: 'c-1', fecha: '2026-04-20' }),
    // Ultimo pago del historial, pero REVERTIDO: no puede ser la fecha de cierre.
    pago({ id: 'p-3', saleId: 's-con-pagos', clientId: 'c-1', fecha: '2026-05-30', state: 'reversed' }),
    pago({ id: 'p-4', saleId: 's-con-pagos', clientId: 'c-1', fecha: '2026-05-30', valor: -10_000, state: 'reversal' }),
    // La venta perdida SI tiene pagos, pero no se le sella fecha.
    pago({ id: 'p-5', saleId: 's-perdida', clientId: 'c-1', fecha: '2026-06-06' }),
  ]

  const porVenta = new Map<string, Payment[]>()
  for (const pmt of pagosHeredados) {
    const arr = porVenta.get(pmt.saleId) ?? []
    arr.push(pmt); porVenta.set(pmt.saleId, arr)
  }
  const resultado = new Map<string, string | undefined>()
  for (const v of salesHeredadas.filter(x => x.status === 'finalizada' && !x.fechaFinalizacion)) {
    resultado.set(v.id, lastEffectivePaymentDate(porVenta.get(v.id) ?? []))
  }

  metric('s-con-pagos', String(resultado.get('s-con-pagos')))
  metric('s-sin-pagos', String(resultado.get('s-sin-pagos')))
  metric('s-ya-sellada (no se toca)', 'no entra en la migracion')
  metric('s-activa / s-perdida', 'no entran en la migracion')
  assert(resultado.get('s-con-pagos') === '2026-04-20', `se inferio la fecha equivocada: ${resultado.get('s-con-pagos')}`)
  assert(resultado.get('s-sin-pagos') === undefined, 'se invento una fecha sin pagos que la respalden')
  assert(!resultado.has('s-ya-sellada'), 'la migracion reescribio una fecha ya sellada')
  assert(!resultado.has('s-activa') && !resultado.has('s-perdida'), 'la migracion sello fechas en ventas no finalizadas')

  // Y la migracion real de db.ts aplica exactamente esta regla.
  const dbSrc = readSource('src/lib/db.ts')
  metric('db.ts usa lastEffectivePaymentDate', dbSrc.includes('lastEffectivePaymentDate('))
  metric('db.ts usa updatedAt como cierre', /fechaFinalizacion:\s*s\.updatedAt/.test(dbSrc))
  assert(dbSrc.includes('this.version(9)'), 'falta la migracion v9')
  assert(dbSrc.includes('lastEffectivePaymentDate('), 'la migracion no usa la fuente canonica')
  assert(!/fechaFinalizacion:\s*\w*\.?updatedAt/.test(dbSrc), 'la migracion usa updatedAt como fecha de cierre')
})

await spec('HIST-SRC-001', 'Historial', 'el historial se monta en las areas administrativas y consulta por clientId', () => {
  const comp = readSource('src/components/ui/ClientCreditHistory.tsx')
  metric('consulta por clientId', comp.includes("db.sales.where('clientId').equals(client.id)"))
  metric('aplica scoping por rutas', comp.includes('filterByAccessibleRoute(user'))
  metric('exige sale.viewHistory', comp.includes("can(user, 'sale.viewHistory'"))
  assert(comp.includes("db.sales.where('clientId').equals(client.id)"), 'el historial no consulta por clientId')
  assert(!/where\('nombre'\)|c\.nombre ===/.test(comp), 'el historial cruza por nombre')
  assert(comp.includes('filterByAccessibleRoute(user'), 'el historial no aplica el scoping por rutas')
  assert(comp.includes("can(user, 'sale.viewHistory'"), 'el historial no valida la capacidad')

  // Montado en Secretario, Admin y Socio; NO en la app del Cobrador.
  for (const f of [
    'src/pages/secretario/SecretarioClientsPage.tsx',
    'src/pages/admin/ClientsPage.tsx',
    'src/pages/socio/SocioClientsPage.tsx',
  ]) {
    const src = readSource(f)
    metric(`montado en ${f.split('/').pop()}`, src.includes('<ClientCreditHistory'))
    assert(src.includes('<ClientCreditHistory'), `falta el historial en ${f}`)
  }
  for (const f of ['src/pages/collector/ClientDetailPage.tsx', 'src/pages/collector/CollectorRoutePage.tsx']) {
    const src = readSource(f)
    metric(`ausente en ${f.split('/').pop()}`, !src.includes('ClientCreditHistory'))
    assert(!src.includes('ClientCreditHistory'), `el historial se agrego a la app del Cobrador (${f})`)
  }
})

await spec('HIST-SRC-002', 'Historial', 'ninguna pantalla rotula la fecha estimada como fecha de fin real', () => {
  const auth = readSource('src/pages/admin/SaleAuthorizationsPage.tsx')
  metric('rotulo antiguo "Fin {estimada}"', /` · Fin \$\{formatDate\(s\.fechaFinalEstimada\)\}`/.test(auth))
  metric('rotulo nuevo', auth.includes('Fin estimado'))
  assert(!/` · Fin \$\{formatDate\(s\.fechaFinalEstimada\)\}`/.test(auth), 'la fecha estimada se sigue rotulando como "Fin"')
  assert(auth.includes('Fin estimado'), 'falta el rotulo inequivoco de la fecha estimada')

  // La ficha del cliente ya no usa updatedAt como fecha de cierre.
  const clientes = readSource('src/pages/admin/ClientsPage.tsx')
  metric('ClientsPage usa updatedAt como Cierre', /Cierre \$\{formatDate\(s\.updatedAt\)\}/.test(clientes))
  assert(!/Cierre \$\{formatDate\(s\.updatedAt\)\}/.test(clientes), 'la ficha del cliente sigue mostrando updatedAt como cierre')
})


// ############################################################
// RQ-05 — CAJA PERSONAL DEL COBRADOR
// ------------------------------------------------------------
// La caja del Cobrador es el EFECTIVO que el maneja, no la caja financiera de la
// ruta. Estos casos protegen tres cosas:
//   1. el capital inicial NO llega a la capa de calculo del cobrador;
//   2. dos cobradores de la misma ruta ven cifras distintas;
//   3. quien DIGITA un abono no se queda con el dinero de quien lo COBRO.
// ############################################################
const asCollectorDb = (db: MemoryDb) => db as unknown as CollectorCashDatabase
const DIA = '2026-08-19'

/** Ruta con capital inicial y movimientos de DOS cobradores el mismo dia. */
function rutaConDosCobradores() {
  return buildCashboxScenario([{
    routeId: 'r-A', nombre: 'Ruta A',
    // Capital inicial MUY alto: si se filtrara a la caja del cobrador, saltaria.
    capital: [{ fecha: '2026-08-01', valor: 50_000_000 }],
    pagos: [
      { fecha: DIA, valor: 60_000, collectorId: 'u-cobA' },
      { fecha: DIA, valor: 40_000, collectorId: 'u-cobA' },
      { fecha: DIA, valor: 200_000, collectorId: 'u-cobB' },
      // Otro dia: no entra en el cuadre de hoy.
      { fecha: '2026-08-18', valor: 900_000, collectorId: 'u-cobA' },
    ],
    ventas: [
      { fechaInicio: DIA, valorVenta: 30_000, collectorId: 'u-cobA' },
      { fechaInicio: DIA, valorVenta: 500_000, collectorId: 'u-cobB' },
    ],
    gastos: [
      { fecha: DIA, valor: 5_000, collectorId: 'u-cobA' },
      { fecha: DIA, valor: 90_000, collectorId: 'u-cobB' },
    ],
    retiros: [{ fecha: DIA, valor: 1_000_000 }],
    transferenciasEntrada: [{ fecha: DIA, valor: 2_000_000 }],
  }])
}

/** Marca las ventas del escenario con su desembolso (cobrador + fecha). */
async function marcarDesembolsos(db: MemoryDb) {
  for (const v of await db.sales.toArray() as Array<Sale & { collectorId?: string }>) {
    if (!v.collectorId) continue
    await db.sales.update(v.id, {
      disbursedByCollectorId: v.collectorId,
      fechaDesembolso: v.fechaInicio,
    } as Partial<Sale>)
  }
}

await spec('COLL-CASH-001', 'Caja cobrador', 'A y B recaudan en la misma ruta y cada uno ve SOLO lo suyo', async () => {
  const db = rutaConDosCobradores()
  await marcarDesembolsos(db)
  const a = await getCollectorDailyCashSummary({ routeId: 'r-A', collectorId: 'u-cobA', fecha: DIA }, asCollectorDb(db))
  const b = await getCollectorDailyCashSummary({ routeId: 'r-A', collectorId: 'u-cobB', fecha: DIA }, asCollectorDb(db))
  metric('A recaudado', a.recaudado)
  metric('B recaudado', b.recaudado)
  metric('A a entregar', a.efectivoAEntregar)
  metric('B a entregar', b.efectivoAEntregar)
  assert(a.recaudado === 100_000, `A ve un recaudo contaminado: ${a.recaudado}`)
  assert(b.recaudado === 200_000, `B ve un recaudo contaminado: ${b.recaudado}`)
  assert(a.recaudado !== b.recaudado, 'ambos cobradores ven la misma cifra: sigue habiendo consolidado')
  // A: 100.000 - 30.000 (desembolso) - 5.000 (gasto) = 65.000
  assert(a.efectivoAEntregar === 65_000, `efectivo de A incorrecto: ${a.efectivoAEntregar}`)
  // B: 200.000 - 500.000 - 90.000 = -390.000 (entrego mas de lo que recaudo)
  assert(b.efectivoAEntregar === -390_000, `efectivo de B incorrecto: ${b.efectivoAEntregar}`)
})

await spec('COLL-CASH-002', 'Caja cobrador', 'el capital inicial NO llega a la capa de calculo del cobrador', async () => {
  const db = rutaConDosCobradores()
  await marcarDesembolsos(db)
  const a = await getCollectorDailyCashSummary({ routeId: 'r-A', collectorId: 'u-cobA', fecha: DIA }, asCollectorDb(db))
  const campos = Object.keys(a).join(', ')
  metric('campos devueltos', campos)
  metric('capital sembrado en la ruta', 50_000_000)
  metric('mayor cifra devuelta al cobrador', Math.max(a.recaudado, a.desembolsado, a.gastos, Math.abs(a.efectivoAEntregar)))
  // Ningun campo del resumen puede acercarse al capital, a los retiros ni a las transferencias.
  const valores = [a.recaudado, a.desembolsado, a.gastos, a.efectivoAEntregar]
  assert(!valores.includes(50_000_000), 'el capital inicial se filtro a la caja del cobrador')
  assert(!valores.includes(1_000_000), 'los retiros de la ruta se filtraron a la caja del cobrador')
  assert(!valores.includes(2_000_000), 'las transferencias de la ruta se filtraron a la caja del cobrador')
  assert(!/capital|saldoAnterior|saldoActual|transferencias|retiros|baseActual/i.test(campos),
    `el resumen del cobrador expone datos financieros de la ruta: ${campos}`)

  // Y NO es solo que la UI lo oculte: la funcion ni siquiera declara esas tablas.
  const src = readSource('src/services/cashboxEngine.ts')
  const body = src.slice(src.indexOf('export async function getCollectorDailyCashSummary'))
  const cuerpo = body.slice(0, body.indexOf('export async function hasCapitalForSale'))
  metric('lee capitalMovements', /capitalMovements/.test(cuerpo))
  metric('lee transfers', /transfers/.test(cuerpo))
  metric('lee withdrawals', /withdrawals/.test(cuerpo))
  assert(!/capitalMovements|transfers|withdrawals/.test(cuerpo),
    'la caja personal consulta tablas financieras de la ruta')
})

await spec('COLL-CASH-003', 'Caja cobrador', 'los desembolsos y gastos se restan al cobrador que los hizo', async () => {
  const db = rutaConDosCobradores()
  await marcarDesembolsos(db)
  const a = await getCollectorDailyCashSummary({ routeId: 'r-A', collectorId: 'u-cobA', fecha: DIA }, asCollectorDb(db))
  const b = await getCollectorDailyCashSummary({ routeId: 'r-A', collectorId: 'u-cobB', fecha: DIA }, asCollectorDb(db))
  metric('A desembolso / gastos', `${a.desembolsado} / ${a.gastos}`)
  metric('B desembolso / gastos', `${b.desembolsado} / ${b.gastos}`)
  assert(a.desembolsado === 30_000, `el desembolso de B se cargo a A: ${a.desembolsado}`)
  assert(b.desembolsado === 500_000, `el desembolso de A se cargo a B: ${b.desembolsado}`)
  assert(a.gastos === 5_000, `el gasto de B se cargo a A: ${a.gastos}`)
  assert(b.gastos === 90_000, `el gasto de A se cargo a B: ${b.gastos}`)
})

await spec('COLL-CASH-004', 'Caja cobrador', 'solo cuentan los movimientos del DIA consultado', async () => {
  const db = rutaConDosCobradores()
  await marcarDesembolsos(db)
  const hoy = await getCollectorDailyCashSummary({ routeId: 'r-A', collectorId: 'u-cobA', fecha: DIA }, asCollectorDb(db))
  const ayer = await getCollectorDailyCashSummary({ routeId: 'r-A', collectorId: 'u-cobA', fecha: '2026-08-18' }, asCollectorDb(db))
  metric('recaudo de hoy', hoy.recaudado)
  metric('recaudo de ayer', ayer.recaudado)
  assert(hoy.recaudado === 100_000, 'el recaudo de otro dia entro en el cuadre de hoy')
  assert(ayer.recaudado === 900_000, `el recaudo de ayer es incorrecto: ${ayer.recaudado}`)
  assert(ayer.desembolsado === 0 && ayer.gastos === 0, 'movimientos de hoy contados en el cuadre de ayer')
})

await spec('COLL-CASH-005', 'Caja cobrador', 'los abonos parciales se suman y los revertidos no cuentan', async () => {
  const db = buildCashboxScenario([{
    routeId: 'r-A',
    pagos: [
      { fecha: DIA, valor: 10_000, collectorId: 'u-cobA' },
      { fecha: DIA, valor: 15_000, collectorId: 'u-cobA' },
      { fecha: DIA, valor: 25_000, collectorId: 'u-cobA' },
      // Corregido: original revertido + asiento negativo + reemplazo vigente.
      { fecha: DIA, valor: 100_000, collectorId: 'u-cobA', state: 'reversed' },
      { fecha: DIA, valor: -100_000, collectorId: 'u-cobA', state: 'reversal' },
      { fecha: DIA, valor: 70_000, collectorId: 'u-cobA', state: 'active' },
    ],
  }])
  const a = await getCollectorDailyCashSummary({ routeId: 'r-A', collectorId: 'u-cobA', fecha: DIA }, asCollectorDb(db))
  metric('recaudo con parciales y una correccion', a.recaudado)
  // 10.000 + 15.000 + 25.000 + 70.000 (el par revertido no cuenta)
  assert(a.recaudado === 120_000, `los parciales o la correccion se contaron mal: ${a.recaudado}`)
})

await spec('COLL-CASH-006', 'Caja cobrador', 'sin cobrador o sin ruta no se calcula nada (fail-closed)', async () => {
  const db = rutaConDosCobradores()
  const sinCobrador = await getCollectorDailyCashSummary({ routeId: 'r-A', collectorId: '', fecha: DIA }, asCollectorDb(db))
  const sinRuta = await getCollectorDailyCashSummary({ routeId: '', collectorId: 'u-cobA', fecha: DIA }, asCollectorDb(db))
  const ajeno = await getCollectorDailyCashSummary({ routeId: 'r-A', collectorId: 'u-desconocido', fecha: DIA }, asCollectorDb(db))
  metric('sin cobrador', sinCobrador.efectivoAEntregar)
  metric('sin ruta', sinRuta.efectivoAEntregar)
  metric('cobrador ajeno a la ruta', ajeno.efectivoAEntregar)
  assert(sinCobrador.recaudado === 0 && sinRuta.recaudado === 0, 'se calculo caja sin cobrador o sin ruta')
  assert(ajeno.recaudado === 0 && ajeno.efectivoAEntregar === 0, 'un cobrador ajeno obtuvo cifras de la ruta')
})

// ------------------------------------------------------------
// ATRIBUCION DEL RECAUDO EN EL SERVICIO REAL
// ------------------------------------------------------------
/** Escenario con los cobradores indicados asignados a la ruta de la venta. */
function escenarioConCobradores(ids: string[], opts: Parameters<typeof buildScenario>[0] = { valorVenta: 100_000, numeroCuotas: 10 }) {
  const sc = buildScenario(opts)
  sc.db.users._seed(ids.map(id => ({
    id, tenantId: TEST_IDS.TENANT_ID, nombre: id, email: `${id}@t.com`, password: 'x',
    rol: 'cobrador', status: 'activo', authorizedRouteIds: [TEST_IDS.ROUTE_ID],
    createdAt: '', updatedAt: '',
  })))
  return sc
}

await spec('COLL-ATTR-001', 'Caja cobrador', 'el Supervisor registra el cobro de A y el dinero queda a nombre de A', async () => {
  const sc = escenarioConCobradores(['u-cobA', 'u-cobB'])
  const res = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: 100_000, actor: USER_SUPERVISOR, collectorId: 'u-cobA', fecha: DIA },
    asDb(sc.db),
  )
  const pago = (await sc.db.payments.toArray())[0]
  metric('resultado', res.ok ? `${res.appliedAmount} atribuido a ${res.collectorId} (${res.collectorSource})` : res.code)
  metric('collectorId guardado', pago?.collectorId)
  metric('createdByUserId guardado', pago?.createdByUserId)
  assert(res.ok, `el pago fue rechazado: ${res.ok ? '' : res.code}`)
  assert(pago.collectorId === 'u-cobA', `el dinero se atribuyo a ${pago.collectorId} en lugar de al cobrador`)
  assert(pago.createdByUserId === USER_SUPERVISOR.id, `no se registro quien digito: ${pago.createdByUserId}`)
  assert(pago.collectorId !== pago.createdByUserId, 'registrar y responder siguen siendo el mismo campo')

  // Y la caja de A refleja ese dinero; la del Supervisor, no.
  const cajaA = await getCollectorDailyCashSummary({ routeId: TEST_IDS.ROUTE_ID, collectorId: 'u-cobA', fecha: DIA }, asCollectorDb(sc.db))
  const cajaSup = await getCollectorDailyCashSummary({ routeId: TEST_IDS.ROUTE_ID, collectorId: USER_SUPERVISOR.id, fecha: DIA }, asCollectorDb(sc.db))
  metric('caja de A', cajaA.recaudado)
  metric('caja del Supervisor', cajaSup.recaudado)
  assert(cajaA.recaudado === 100_000, `la caja de A no recibio el dinero: ${cajaA.recaudado}`)
  assert(cajaSup.recaudado === 0, 'el Supervisor se quedo con dinero que no cobro')
})

await spec('COLL-ATTR-002', 'Caja cobrador', 'un Admin NO puede atribuir el dinero solo por digitarlo si hay varios cobradores', async () => {
  const sc = escenarioConCobradores(['u-cobA', 'u-cobB'])
  const res = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: 50_000, actor: USER_ADMIN, fecha: DIA },
    asDb(sc.db),
  )
  const pagos = await sc.db.payments.toArray()
  metric('resultado', res.ok ? 'ACEPTADO — ERROR' : res.code)
  metric('pagos escritos', pagos.length)
  assert(!res.ok && res.code === 'COLLECTOR_REQUIRED', `se atribuyo el dinero sin elegir cobrador: ${res.ok ? 'aceptado' : res.code}`)
  assert(pagos.length === 0, 'se escribio un pago pese al rechazo')

  // Indicando el cobrador, el mismo pago se acepta.
  const ok = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: 50_000, actor: USER_ADMIN, collectorId: 'u-cobB', fecha: DIA },
    asDb(sc.db),
  )
  metric('tras indicar el cobrador', ok.ok ? `atribuido a ${ok.collectorId}` : ok.code)
  assert(ok.ok && ok.collectorId === 'u-cobB', 'no se acepto el pago con cobrador indicado')
})

await spec('COLL-ATTR-003', 'Caja cobrador', 'con un unico cobrador en la ruta se preselecciona sin preguntar', async () => {
  const sc = escenarioConCobradores(['u-cobA'])
  const res = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: 40_000, actor: USER_ADMIN, fecha: DIA },
    asDb(sc.db),
  )
  metric('resultado', res.ok ? `${res.collectorId} (${res.collectorSource})` : res.code)
  assert(res.ok && res.collectorId === 'u-cobA' && res.collectorSource === 'single-route-collector',
    'no se preselecciono el unico cobrador de la ruta')
})

await spec('COLL-ATTR-004', 'Caja cobrador', 'el cobrador que registra su cobro responde por el', async () => {
  const sc = escenarioConCobradores(['u-cob', 'u-cobB'])
  const res = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: 30_000, actor: USER_COBRADOR, fecha: DIA },
    asDb(sc.db),
  )
  const pago = (await sc.db.payments.toArray())[0]
  metric('atribuido a', res.ok ? res.collectorId : res.code)
  metric('origen', res.ok ? res.collectorSource : '—')
  assert(res.ok && res.collectorId === USER_COBRADOR.id && res.collectorSource === 'actor',
    'el cobrador no quedo como responsable de su propio cobro')
  assert(pago.createdByUserId === USER_COBRADOR.id, 'no se registro el usuario que digito')
})

await spec('COLL-ATTR-005', 'Caja cobrador', 'un cobrador ajeno a la ruta se rechaza', async () => {
  const sc = escenarioConCobradores(['u-cobA'])
  const res = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: 20_000, actor: USER_ADMIN, collectorId: 'u-de-otra-ruta', fecha: DIA },
    asDb(sc.db),
  )
  metric('resultado', res.ok ? 'ACEPTADO — ERROR' : res.code)
  metric('pagos escritos', (await sc.db.payments.toArray()).length)
  assert(!res.ok && res.code === 'COLLECTOR_INVALID', 'se acepto un cobrador ajeno a la ruta')
  assert((await sc.db.payments.toArray()).length === 0, 'se escribio un pago pese al rechazo')
})

await spec('COLL-ATTR-006', 'Caja cobrador', 'una correccion conserva el cobrador responsable original', () => {
  // `executeCorrection` copia `original.collectorId` tanto en la reversion como en
  // el pago corregido: corregir un abono NO cambia de quien es el dinero.
  const src = readSource('src/services/paymentCorrectionService.ts')
  const bloque = src.slice(src.indexOf('const reversal: Payment'), src.indexOf('// UNA SOLA TRANSACCIÓN'))
  const ocurrencias = (bloque.match(/collectorId: original\.collectorId/g) ?? []).length
  metric('asientos que conservan el cobrador original', ocurrencias)
  metric('quien ejecuta la correccion queda en correctedBy', /correctedBy: actor\.id/.test(bloque))
  assert(ocurrencias === 2, `la correccion no conserva el cobrador en ambos asientos (${ocurrencias})`)
  assert(/correctedBy: actor\.id/.test(bloque), 'la correccion no registra quien la ejecuto')
})

await spec('COLL-CAP-001', 'Caja cobrador', 'la validacion de capital sigue vigente sin exponer el monto', async () => {
  // Ruta con 500.000 de capital y 100.000 ya prestados: quedan 400.000.
  const db = buildCashboxScenario([{
    routeId: 'r-A',
    capital: [{ fecha: '2026-08-01', valor: 500_000 }],
    ventas: [{ fechaInicio: '2026-08-02', valorVenta: 100_000 }],
  }])
  const disponible = (await getCashboxSummary('r-A', undefined, '2026-12-31', asCashboxDb(db))).saldoActual
  metric('capital disponible real', disponible)
  assert(disponible === 400_000, `capital de partida incorrecto: ${disponible}`)

  // `hasCapitalForSale` devuelve SOLO el veredicto, nunca la cifra.
  const src = readSource('src/services/cashboxEngine.ts')
  const cuerpo = src.slice(src.indexOf('export async function hasCapitalForSale'))
  metric('tipo de retorno', /Promise<boolean>/.test(cuerpo) ? 'boolean' : 'OTRO')
  assert(/Promise<boolean>/.test(cuerpo), 'la guarda de capital devuelve algo distinto de un veredicto')

  // Y el hook solo revela el monto a quien puede ver la caja de la ruta.
  const hook = readSource('src/hooks/useCapitalGuard.ts')
  metric('el hook condiciona el monto a cashbox.viewRoute', hook.includes("can(user, 'cashbox.viewRoute'"))
  metric('devuelve el veredicto siempre', hook.includes('exceeded'))
  assert(hook.includes("can(user, 'cashbox.viewRoute'"), 'el hook no condiciona el monto a la capacidad')
  assert(hook.includes('available: puedeVerMonto ? capital : null'), 'el hook expone el capital a quien no debe verlo')
})

await spec('COLL-SRC-001', 'Caja cobrador', 'ninguna pantalla del Cobrador pide la caja financiera de la ruta sin permiso', () => {
  // El cuadre solo calcula la caja de ruta si el usuario tiene `cashbox.viewRoute`.
  const cuadre = readSource('src/pages/collector/CollectorCashClosePage.tsx')
  metric('usa la caja personal', cuadre.includes('getCollectorDailyCashSummary('))
  metric('condiciona la caja de ruta', cuadre.includes("can(user, 'cashbox.viewRoute'"))
  metric('no la pide sin permiso', cuadre.includes('verCajaRuta ? await getRouteFinancialSummary(routeId) : null'))
  assert(cuadre.includes('getCollectorDailyCashSummary('), 'el cuadre dejo de usar la caja personal')
  assert(cuadre.includes('verCajaRuta ? await getRouteFinancialSummary(routeId) : null'),
    'el cuadre calcula la caja financiera de la ruta sin comprobar el permiso')

  // El inicio y el informe del dia muestran lo del usuario en sesion.
  const home = readSource('src/pages/collector/CollectorHomePage.tsx')
  metric('inicio filtra por cobrador', home.includes('p.collectorId === user?.id'))
  assert(home.includes('p.collectorId === user?.id'), 'el inicio sigue mostrando el recaudo de toda la ruta')
  const informe = readSource('src/pages/collector/CollectorDailyReportPage.tsx')
  metric('informe filtra por cobrador', informe.includes('p.collectorId === user.id'))
  assert(informe.includes('p.collectorId === user.id'), 'el informe del dia sigue mostrando toda la ruta')

  // Las pantallas de venta ya no usan el hook que expone el capital sin filtro.
  for (const f of ['src/pages/collector/CollectorNewSalePage.tsx', 'src/pages/collector/CollectorNewClientPage.tsx']) {
    const src = readSource(f)
    metric(`${f.split('/').pop()} usa la guarda acotada`, src.includes('useCapitalGuard('))
    assert(src.includes('useCapitalGuard('), `${f} no usa la guarda acotada de capital`)
    assert(!src.includes('useRouteCapital('), `${f} sigue pidiendo el capital completo de la ruta`)
  }
})

// ############################################################
// GRUPO — REGRESIÓN: LA APP COBRADOR REGISTRA ABONOS
// ------------------------------------------------------------
// INCIDENTE 15/09/2026 (producción CLEAN): "Registrar abono" devolvía siempre
// «Error al registrar el pago. No se guardó ningún cambio.» (WRITE_FAILED).
//
// CAUSA RAÍZ: `registerPayment` abría la transacción con el alcance
// ['payments','installments','sales'] y DENTRO leía `database.users` para
// resolver el cobrador responsable (paso 4.b, introducido con RQ-05). Dexie solo
// permite usar las tablas DECLARADAS y lanza
// `NotFoundError: Table users not part of transaction`
// (dexie/dist/dexie.js → Table.prototype._trans / Transaction.prototype.table).
// Ese error NO es un rechazo de negocio: caía en el catch genérico y abortaba el
// pago entero, con rollback completo. Afectaba a TODOS los roles y a DEMO y CLEAN.
//
// Por qué no lo vio la suite: el harness replicaba Dexie salvo esta regla —
// ignoraba el alcance declarado. Ya lo replica (`assertTableInTransaction`), así
// que este grupo protege la corrección de verdad.
// ############################################################
const DIA_REG = '2026-09-15'

/** Escenario de la App Cobrador: el propio Cobrador asignado a la ruta de la venta. */
function escenarioAppCobrador(opts: Parameters<typeof buildScenario>[0] = { valorVenta: 100_000, numeroCuotas: 10 }) {
  const sc = buildScenario(opts)
  sc.db.users._seed([{
    id: USER_COBRADOR.id, tenantId: TEST_IDS.TENANT_ID, nombre: 'Cobrador', email: 'cob@t.com',
    password: 'x', rol: 'cobrador', status: 'activo', authorizedRouteIds: [TEST_IDS.ROUTE_ID],
    createdAt: '', updatedAt: '',
  }])
  return sc
}

await spec('PAY-COLL-REG-001', 'App Cobrador', 'el Cobrador registra su propio abono en su ruta', async () => {
  const sc = escenarioAppCobrador()
  const res = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: 400, actor: USER_COBRADOR, fecha: DIA_REG },
    asDb(sc.db),
  )
  const pago = (await sc.db.payments.toArray())[0] as Payment | undefined
  metric('resultado', res.ok ? `ACEPTADO ${res.appliedAmount}` : `RECHAZADO(${res.code}) — ${res.message}`)
  metric('collectorId', pago?.collectorId)
  metric('createdByUserId', pago?.createdByUserId)
  metric('atribución', res.ok ? res.collectorSource : '—')
  assert(res.ok, `el abono del propio Cobrador debe registrarse: ${res.ok ? '' : res.message}`)
  assert(!!pago, 'no se persistió el pago')
  assert(pago!.collectorId === USER_COBRADOR.id, 'el dinero debe atribuirse al Cobrador que lo recibió')
  assert(pago!.createdByUserId === USER_COBRADOR.id, 'debe registrarse quién digitó la operación')
  assert(res.ok && res.collectorSource === 'actor', 'el Cobrador responde por su propio recaudo, sin pedir selección')
})

await spec('PAY-COLL-REG-002', 'App Cobrador', 'abono parcial: se registra y el saldo baja exactamente', async () => {
  const sc = escenarioAppCobrador()
  const antes = await readFinancialState(sc.db)
  const res = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: 5_000, actor: USER_COBRADOR, fecha: DIA_REG },
    asDb(sc.db),
  )
  const st = await readFinancialState(sc.db)
  metric('saldo antes', antes.saleSaldo)
  metric('aplicado', res.ok ? res.appliedAmount : res.code)
  metric('saldo después', st.saleSaldo)
  metric('payments.valor', st.totalRegistradoEnPayments)
  assert(res.ok && res.appliedAmount === 5_000, 'el abono parcial debe aplicarse completo')
  assert(st.saleSaldo === antes.saleSaldo - 5_000, 'el saldo no bajó exactamente lo abonado')
  assert(st.totalRegistradoEnPayments === 5_000, 'payments debe guardar el valor efectivo')
  assert(st.parcelas.every(p => p.saldo >= 0 && p.pagado <= p.valor), 'sin saldos negativos ni sobrepagos')
})

await spec('PAY-COLL-REG-003', 'App Cobrador', 'abono que completa la parcela la cierra y avanza a la siguiente', async () => {
  const sc = escenarioAppCobrador()
  const cuota = sc.installments[0].valor
  const res = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: cuota, actor: USER_COBRADOR, fecha: DIA_REG },
    asDb(sc.db),
  )
  const st = await readFinancialState(sc.db)
  metric('parcela pagada', res.ok ? res.paidInstallmentNumber : res.code)
  metric('parcela actual tras el abono', res.ok ? res.currentInstallmentNumber : '—')
  metric('estado parcela 1', st.parcelas[0].status)
  assert(res.ok && res.paidInstallmentNumber === 1, 'debía cerrarse la parcela 1')
  assert(st.parcelas[0].status === 'pagada' && st.parcelas[0].saldo === 0, 'la parcela 1 no quedó pagada')
  assert(res.ok && res.currentInstallmentNumber === 2, 'la parcela actual debe avanzar a la 2')
  assert(res.ok && res.installmentsCompleted.includes(1), 'debe reportarse la parcela cerrada')
})

await spec('PAY-COLL-REG-004', 'App Cobrador', 'abono que salda la venta la finaliza con fecha de finalización', async () => {
  const sc = escenarioAppCobrador()
  const total = calculateSaleBalance(sc.installments)
  const res = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: total, actor: USER_COBRADOR, fecha: DIA_REG },
    asDb(sc.db),
  )
  const venta = await sc.db.sales.get(TEST_IDS.SALE_ID) as Sale
  metric('saldo final', venta.saldo)
  metric('estado', venta.status)
  metric('fechaFinalizacion', venta.fechaFinalizacion)
  assert(res.ok && res.newBalance === 0, 'el saldo debía quedar en 0')
  assert(venta.status === 'finalizada', 'la venta debía finalizar')
  assert(venta.fechaFinalizacion === DIA_REG, 'la fecha de finalización debe sellarse con la fecha CONTABLE del pago')
})

await spec('PAY-COLL-REG-005', 'App Cobrador', 'abono superior al saldo se topa: nunca sobrepaga', async () => {
  const sc = escenarioAppCobrador()
  const total = calculateSaleBalance(sc.installments)
  const res = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: total + 50_000, actor: USER_COBRADOR, fecha: DIA_REG },
    asDb(sc.db),
  )
  const st = await readFinancialState(sc.db)
  metric('solicitado', res.ok ? res.requestedAmount : res.code)
  metric('aplicado', res.ok ? res.appliedAmount : '—')
  metric('excedente rechazado', res.ok ? res.cappedAmount : '—')
  metric('payments.valor', st.totalRegistradoEnPayments)
  assert(res.ok && res.capped && res.appliedAmount === total, 'debía toparse exactamente al saldo')
  assert(res.ok && res.cappedAmount === 50_000, 'el excedente debe reportarse')
  assert(st.totalRegistradoEnPayments === total, 'payments jamás debe guardar el solicitado')
  assert(st.saleSaldo === 0, 'la deuda no puede quedar negativa')
})

await spec('PAY-COLL-REG-006', 'App Cobrador', 'un Cobrador de OTRA ruta es rechazado de forma controlada', async () => {
  const sc = escenarioAppCobrador()
  const res = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: 5_000, actor: USER_OTRA_RUTA, fecha: DIA_REG },
    asDb(sc.db),
  )
  const st = await readFinancialState(sc.db)
  metric('resultado', res.ok ? 'ACEPTADO — ERROR' : `${res.code}: ${res.message}`)
  metric('payments', st.totalRegistradoEnPayments)
  assert(!res.ok && res.code === 'NOT_AUTHORIZED', 'un cobrador ajeno debe rechazarse por permisos')
  assert(!res.ok && res.message !== 'Error al registrar el pago. No se guardó ningún cambio.', 'el mensaje debe ser específico, no el genérico de fallo')
  assert(st.totalRegistradoEnPayments === 0, 'no debe quedar ninguna escritura')
})

await spec('PAY-COLL-REG-007', 'App Cobrador', 'con varios cobradores en la ruta, el propio Cobrador NO debe elegir responsable', async () => {
  const sc = escenarioConCobradores([USER_COBRADOR.id, 'u-cobB', 'u-cobC'])
  const res = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: 7_000, actor: USER_COBRADOR, fecha: DIA_REG },
    asDb(sc.db),
  )
  const pago = (await sc.db.payments.toArray())[0] as Payment | undefined
  metric('cobradores en la ruta', 3)
  metric('resultado', res.ok ? `ACEPTADO (${res.collectorSource})` : `${res.code}`)
  metric('collectorId', pago?.collectorId)
  assert(res.ok, 'no debe pedirse responsable cuando el actor ES el cobrador')
  assert(res.ok && res.collectorSource === 'actor', 'la atribución debe resolverse por el propio actor')
  assert(pago?.collectorId === USER_COBRADOR.id, 'el dinero debe quedar a nombre del Cobrador que lo recibió')
})

await spec('PAY-COLL-REG-008', 'App Cobrador', 'el Supervisor registra el cobro recibido por otro Cobrador', async () => {
  const sc = escenarioConCobradores(['u-cobA', 'u-cobB'])
  const ambiguo = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: 6_000, actor: USER_SUPERVISOR, fecha: DIA_REG },
    asDb(sc.db),
  )
  const explicito = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: 6_000, actor: USER_SUPERVISOR, collectorId: 'u-cobA', fecha: DIA_REG },
    asDb(sc.db),
  )
  const pago = (await sc.db.payments.toArray())[0] as Payment | undefined
  metric('sin indicar responsable', ambiguo.ok ? 'ACEPTADO — ERROR' : ambiguo.code)
  metric('indicando responsable', explicito.ok ? `ACEPTADO (${explicito.collectorSource})` : explicito.code)
  metric('collectorId', pago?.collectorId)
  metric('createdByUserId', pago?.createdByUserId)
  assert(!ambiguo.ok && ambiguo.code === 'COLLECTOR_REQUIRED', 'con varios cobradores no puede adivinarse quién cobró')
  assert(explicito.ok, 'indicando el responsable el pago debe registrarse')
  assert(pago?.collectorId === 'u-cobA', 'el dinero debe atribuirse al Cobrador que lo recibió')
  assert(pago?.createdByUserId === USER_SUPERVISOR.id, 'debe constar que lo digitó el Supervisor')
})

await spec('PAY-COLL-REG-009', 'App Cobrador', 'un fallo a mitad de la escritura revierte TODO', async () => {
  const sc = escenarioAppCobrador()
  const antes = await readFinancialState(sc.db)
  sc.db.injectFault({ op: 'installments.update', nth: 2 })
  const res = await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: 30_000, actor: USER_COBRADOR, fecha: DIA_REG },
    asDb(sc.db),
  )
  sc.db.injectFault(null)
  const st = await readFinancialState(sc.db)
  metric('resultado', res.ok ? 'ACEPTADO — ERROR' : res.code)
  metric('payments tras el fallo', st.totalRegistradoEnPayments)
  metric('saldo tras el fallo', `${antes.saleSaldo} → ${st.saleSaldo}`)
  metric('rollback registrado', sc.db.log.includes('transaction:rollback'))
  assert(!res.ok && res.code === 'WRITE_FAILED', 'un fallo de persistencia debe rechazarse como tal')
  assert(st.totalRegistradoEnPayments === 0, 'quedó un Payment huérfano')
  assert(st.saleSaldo === antes.saleSaldo, 'la venta quedó modificada pese al fallo')
  assert(JSON.stringify(st.parcelas) === JSON.stringify(antes.parcelas), 'quedaron parcelas modificadas')
})

await spec('PAY-COLL-REG-010', 'App Cobrador', 'el pago reversado conserva la atribución del Cobrador', async () => {
  const sc = escenarioAppCobrador()
  await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: 9_000, actor: USER_COBRADOR, fecha: DIA_REG },
    asDb(sc.db),
  )
  const original = (await sc.db.payments.toArray())[0] as Payment
  // Reverso con la misma forma que usa paymentCorrectionService: el contrapago
  // hereda la atribución del original (no se reasigna al que corrige).
  await sc.db.payments.update(original.id, { state: 'reversed' })
  await sc.db.payments.add({
    ...original, id: 'pay-reversal', valor: -original.valor, state: 'reversal',
    createdByUserId: USER_ADMIN.id,
  })
  const pagos = await sc.db.payments.toArray() as Payment[]
  const efectivos = effectivePayments(pagos)
  metric('pagos totales', pagos.length)
  metric('efectivos tras el reverso', efectivos.length)
  metric('collectorId del contrapago', pagos.find(p => p.id === 'pay-reversal')?.collectorId)
  assert(pagos.every(p => p.collectorId === USER_COBRADOR.id), 'la atribución del recaudo debe mantenerse en el reverso')
  assert(efectivos.length === 0, 'un pago reversado no debe contar como recaudo efectivo')
})

await spec('PAY-COLL-REG-011', 'App Cobrador', 'la caja personal del Cobrador refleja el abono recién registrado', async () => {
  const sc = escenarioAppCobrador()
  const antes = await getCollectorDailyCashSummary(
    { routeId: TEST_IDS.ROUTE_ID, collectorId: USER_COBRADOR.id, fecha: DIA_REG },
    sc.db as unknown as CollectorCashDatabase,
  )
  await registerPayment(
    { saleId: TEST_IDS.SALE_ID, requestedAmount: 12_000, actor: USER_COBRADOR, fecha: DIA_REG },
    asDb(sc.db),
  )
  const despues = await getCollectorDailyCashSummary(
    { routeId: TEST_IDS.ROUTE_ID, collectorId: USER_COBRADOR.id, fecha: DIA_REG },
    sc.db as unknown as CollectorCashDatabase,
  )
  metric('recaudado antes', antes.recaudado)
  metric('recaudado después', despues.recaudado)
  metric('efectivo a entregar', despues.efectivoAEntregar)
  assert(despues.recaudado === antes.recaudado + 12_000, 'la caja personal no recogió el abono')
  assert(despues.efectivoAEntregar === antes.efectivoAEntregar + 12_000, 'el efectivo a entregar no refleja el abono')
})

await spec('PAY-COLL-REG-012', 'App Cobrador', 'CLEAN de extremo a extremo: ruta sin Cobrador → asignarlo → cliente → venta → abono', async () => {
  // Reproduce el camino REAL del socio en CLEAN: base vacía, nada sembrado.
  const db = new MemoryDb()
  const audits: string[] = []
  const sink = async (p: Parameters<AuditSink>[0]) => { audits.push(p.action) }

  const su: User = {
    id: 'u-su', tenantId: 'platform', nombre: 'Root', email: 'root@c.com', password: 'x',
    rol: 'superadmin', status: 'activo', createdAt: '', updatedAt: '',
  }
  const cobrador: User = {
    id: 'u-cob-clean', tenantId: 't-clean', nombre: 'Luis', email: 'luis@c.com', password: 'x',
    rol: 'cobrador', status: 'activo', createdAt: '', updatedAt: '',
  }
  await db.users.add(cobrador)

  // 1) Ruta creada SIN Cobrador (regla de rutas libres) — servicio real.
  const ruta = await createRouteWithAdmins({
    tenantId: 't-clean', nombre: 'Ruta CLEAN', tasaInteres: 20, tasaLibre: false,
    montoMaximoPrestamo: 500_000, capitalInicial: 0, codigo: 'RT-001', adminIds: [],
  }, su, db as unknown as RouteDatabase, sink)
  metric('ruta sin Cobrador', ruta.cobradorId === undefined)

  // 2) Cobrador asignado DESPUÉS — servicio real.
  await updateRouteWithAssignments({
    routeId: ruta.id, tenantId: 't-clean', nombre: ruta.nombre, ciudad: ruta.ciudad,
    tasaInteres: ruta.tasaInteres, tasaLibre: ruta.tasaLibre, montoMaximoPrestamo: ruta.montoMaximoPrestamo,
    cobradorId: cobrador.id, assignedUserIds: [cobrador.id], assignableUserIds: [cobrador.id],
  }, su, db as unknown as RouteDatabase, sink)
  const cobAsignado = (await db.users.toArray() as User[]).find(u => u.id === cobrador.id)!
  metric('cobrador asignado', JSON.stringify(cobAsignado.authorizedRouteIds))

  // 3) Cliente y 4) venta DESEMBOLSADA con sus parcelas.
  await db.clients.add({ id: 'c-clean', tenantId: 't-clean', routeId: ruta.id, nombre: 'Cliente CLEAN', status: 'activo' })
  const { valorInteres, valorTotal } = calculateTotalWithInterest({ valorVenta: 100_000, tasaInteres: 20 })
  const numeroCuotas = 10
  const valorCuota = Math.round(valorTotal / numeroCuotas)
  const parcelas = generateInstallments({
    saleId: 's-clean', valorTotal, numeroCuotas, valorCuota, frecuencia: 'diaria', fechaInicio: DIA_REG,
  })
  await db.sales.add({
    id: 's-clean', tenantId: 't-clean', routeId: ruta.id, clientId: 'c-clean',
    createdByUserId: cobrador.id, valorVenta: 100_000, tasaInteres: 20, valorInteres, valorTotal,
    saldo: valorTotal, numeroCuotas, valorCuota, frecuenciaPago: 'diaria',
    fechaInicio: DIA_REG, fechaFinalEstimada: '2026-12-31', status: 'activa',
    disbursementStatus: 'desembolsado', createdAt: '', updatedAt: '',
  } as Sale)
  for (const p of parcelas) await db.installments.add(p)

  // 5) El Cobrador registra el abono: EXACTAMENTE lo que fallaba en producción.
  const res = await registerPayment(
    { saleId: 's-clean', requestedAmount: 400, actor: cobAsignado, fecha: DIA_REG },
    db as unknown as PaymentDatabase,
    sink,
  )
  const pago = (await db.payments.toArray())[0] as Payment | undefined
  const venta = await db.sales.get('s-clean') as Sale
  metric('resultado del abono', res.ok ? `ACEPTADO ${res.appliedAmount}` : `RECHAZADO(${res.code}) — ${res.message}`)
  metric('collectorId', pago?.collectorId)
  metric('createdByUserId', pago?.createdByUserId)
  metric('saldo tras el abono', `${valorTotal} → ${venta.saldo}`)
  metric('auditoría', audits.join(','))
  assert(res.ok, `el abono en CLEAN debe registrarse: ${res.ok ? '' : res.message}`)
  assert(pago?.collectorId === cobrador.id && pago?.createdByUserId === cobrador.id, 'atribución incorrecta en CLEAN')
  assert(venta.saldo === valorTotal - 400, 'el saldo no se actualizó en CLEAN')
  assert(audits.includes('REGISTER_PAYMENT'), 'el abono no quedó auditado')
})

await spec('PAY-COLL-REG-013', 'App Cobrador', 'el servicio declara TODAS las tablas que usa dentro de la transacción', () => {
  // CONTRATO DE DEXIE, verificado sobre el código real: cualquier tabla usada
  // dentro de `db.transaction(...)` debe estar declarada en su alcance. Esta es la
  // comprobación que habría atrapado el incidente en el commit que lo introdujo.
  const body = paymentServiceBody()
  const abre = body.indexOf('database.transaction')
  const flecha = body.indexOf('=>', abre)
  const alcance = new Set([...body.slice(abre, flecha).matchAll(/\bdatabase\.([a-zA-Z]+)\b/g)].map(m => m[1]))
  alcance.delete('transaction')
  const scope = extractTransactionScope(body)
  const usadas = new Set([...scope.matchAll(/\bdatabase\.([a-zA-Z]+)\./g)].map(m => m[1]))
  const fuera = [...usadas].filter(t => !alcance.has(t))
  metric('tablas declaradas', [...alcance].sort().join(', '))
  metric('tablas usadas dentro', [...usadas].sort().join(', '))
  metric('fuera de alcance', fuera.length === 0 ? '(ninguna)' : fuera.join(', '))
  assert(alcance.has('users'), 'la tabla users debe declararse: se lee dentro de la transacción')
  assert(fuera.length === 0, `tablas usadas sin declarar en la transacción: ${fuera.join(', ')}`)
})

// ############################################################
// INFORME
// ############################################################
const PAD = 24
function line(ch = '─') { return ch.repeat(96) }

console.log('')
console.log(line('═'))
console.log('  RUTACASH — SUITE FINANCIERA')
console.log(line('═'))

let group = ''
for (const r of results) {
  if (r.group !== group) {
    group = r.group
    console.log('')
    console.log(`▌ ${group.toUpperCase()}`)
    console.log(line())
  }
  console.log(`[${r.passed ? ' PASS ' : ' FAIL '}] ${r.id.padEnd(PAD)} ${r.desc}`)
  for (const m of r.metrics) console.log(`           · ${m}`)
  if (r.error) console.log(`           ↳ ERROR: ${r.error}`)
}

const fallidos = results.filter(r => !r.passed)
const porGrupo = new Map<string, { pass: number; fail: number }>()
for (const r of results) {
  const g = porGrupo.get(r.group) ?? { pass: 0, fail: 0 }
  r.passed ? g.pass++ : g.fail++
  porGrupo.set(r.group, g)
}

console.log('')
console.log(line('═'))
console.log('  RESUMEN POR GRUPO')
for (const [g, c] of porGrupo) {
  console.log(`    ${g.padEnd(18)} ${String(c.pass).padStart(3)} PASS   ${String(c.fail).padStart(3)} FAIL`)
}
console.log(line())
console.log(`  TOTAL: ${results.length} casos   ${results.length - fallidos.length} PASS   ${fallidos.length} FAIL`)
console.log(line('═'))

if (fallidos.length) {
  console.log('')
  console.log('CASOS FALLIDOS:')
  for (const r of fallidos) console.log(`  · ${r.id} — ${r.desc}\n    ${r.error}`)
  console.log('')
  console.log('SUITE FINANCIERA: FALLÓ')
} else {
  console.log('')
  console.log('SUITE FINANCIERA: TODOS LOS CASOS PASAN')
}

process.exit(fallidos.length === 0 ? 0 : 1)
