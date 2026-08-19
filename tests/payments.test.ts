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
  buildScenario, readFinancialState, computeCobrosComoCaja, TEST_IDS,
  type FinancialState, type MemoryDb,
} from './financial/harness'
import { adminQuickPaymentFlow, operationalPaymentFlow } from './financial/flows'
import {
  adminHandlerBody, operationalHandlerBody, paymentServiceBody, opensDexieTransaction,
  writeSequence, capsAmountToBalance, validatesDisbursement, validatesSaleStatus,
  checksPaymentCapability, refetchesInstallments, supervisorSharesPaymentComponent,
  cashboxSumsRawPaymentValor, delegatesToPaymentService, correctionRecomputesInsideTransaction,
  containsLine, dexieWriteOperations, auditsOutsideTransaction, readSource, SRC,
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
