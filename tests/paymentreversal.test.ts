// ============================================================
// RUTACASH — SUITE ANULACIÓN DE PAGOS Y RECÁLCULO DEL CRÉDITO (DEXIE REAL)
// ------------------------------------------------------------
//   npm run test:paymentreversal
//
// Ajuste del socio 2026-10-02, punto 7. Un Cobrador registra un pago; un Admin lo
// anula; la App del Cobrador seguía mostrando el abono, la cuota pagada y el crédito
// sin volver a su estado anterior. Aquí se prueba el MODELO: original + reversión
// (−X), crédito reconstruido desde los pagos vigentes, Base y efectivo coherentes.
//
// Escenario: ADEX, ruta Barreiro (Base por capital), Fabio y Carlos cobradores.
// Créditos de 1.000.000 al 20% en 20 cuotas → cuota 60.000.
//
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import { sembrarResponsables } from './financial/capitalFixture'
import { today } from '../src/lib/formatters'
import { OPERATIONAL_TABLES, subscribeDataChanges } from '../src/lib/dataRevision'
import { compareByCreation } from '../src/lib/eventOrder'
import {
  effectivePayments, isPaymentAnnullable, paymentDisplayStateOf, paymentHistoryRows,
} from '../src/lib/paymentState'
import { getCashboxSummary, getRouteBase } from '../src/services/cashboxEngine'
import { computeRouteBaseBreakdown, computeRouteCashReconciliation } from '../src/services/routeCashReconciliation'
import { closeCashSettlement, personalCashPosition } from '../src/services/cashSettlementService'
import { registerCapital } from '../src/services/routeFundsService'
import { assignBaseToWorker } from '../src/services/cashCustodyService'
import {
  approveSaleRequest, confirmDisbursement, createDirectSale, createSaleRequest, type SaleInputs,
} from '../src/services/saleRequestService'
import { registerPayment } from '../src/services/paymentService'
import { annulPayment, canAnnulPayment, recomputeSale } from '../src/services/paymentCorrectionService'
import {
  calculateCurrentInstallment, getLastPaidInstallmentNumber, installmentsCoveredBy, recalculateSaleFromPayments,
} from '../src/services/installmentEngine'
import { buildCajaDiariaReport, buildPagosReport, type ReportSources } from '../src/services/reportService'
import { generateWeeklySettlement } from '../src/services/weeklySettlementEngine'
import { getAdminDashboardData } from '../src/services/adminDashboardService'
import { routeOpsFacts } from '../src/lib/officeOperations'
import type { Payment, Sale, User } from '../src/models/types'
import * as fs from 'node:fs'

// ============================================================
// Mini-runner (mismo formato que las otras suites)
// ============================================================
interface Result { id: string; desc: string; passed: boolean; error?: string; metrics: string[] }
const results: Result[] = []
let current: string[] = []

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg) }
function metric(label: string, value: unknown) { current.push(`${label}: ${String(value)}`) }

async function spec(id: string, desc: string, fn: () => Promise<void> | void) {
  current = []
  let passed = true
  let error: string | undefined
  try { await fn() } catch (e) { passed = false; error = e instanceof Error ? e.message : String(e) }
  results.push({ id, desc, passed, error, metrics: [...current] })
}

async function rechazo(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'ACEPTADO' } catch (e) { return e instanceof Error ? e.message : String(e) }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const src = (p: string) => fs.readFileSync(p, 'utf8')

// ============================================================
// Escenario
// ============================================================
const T = 't-adex'
const TB = 't-ajena'
const R1 = 'r-barreiro'
const R2 = 'r-centro'
const RB = 'r-ajena'

const persona = (id: string, nombre: string, rol: User['rol'], rutas: string[], tenantId = T): User => ({
  id, tenantId, nombre, email: `${id}@adex.co`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)

const SUPER = persona('u-super', 'Sara SuperAdmin', 'superadmin', [])
const ADMIN = persona('u-admin', 'Andrés Admin', 'admin', [R1, R2])
const ADMIN_CENTRO = persona('u-admin-centro', 'Clara Admin Centro', 'admin', [R2])
const LAURA = persona('u-laura', 'Laura Supervisora', 'supervisor', [R1])
const SECRE = persona('u-secre', 'Sergio Secretario', 'secretario', [R1])
const SOCIO = persona('u-socio', 'Sofía Socia', 'socio', [R1, R2])
const FABIO = persona('u-fabio', 'Fabio', 'cobrador', [R1])
const CARLOS = persona('u-carlos', 'Carlos', 'cobrador', [R1])
const AJENO_ADMIN = persona('u-ajeno-admin', 'Ana Ajena', 'admin', [RB], TB)

async function empresa() {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.bulkAdd([
    { id: T, nombre: 'ADEX', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z' },
    { id: TB, nombre: 'Ajena', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z' },
  ] as never[])
  await db.offices.bulkAdd([
    { id: 'of-1', tenantId: T, nombre: 'Leticia', codigo: 'LET', status: 'activa', createdAt: '', updatedAt: '' },
    { id: 'of-b', tenantId: TB, nombre: 'B', codigo: 'B', status: 'activa', createdAt: '', updatedAt: '' },
  ] as never[])
  const ruta = (id: string, tenantId: string, officeId: string, nombre: string) =>
    ({ id, tenantId, officeId, nombre, codigo: id, status: 'activa', capitalInicial: 0, capitalActual: 0, tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 0, createdAt: '2026-09-01' })
  await db.routes.bulkAdd([ruta(R1, T, 'of-1', 'Barreiro'), ruta(R2, T, 'of-1', 'Centro'), ruta(RB, TB, 'of-b', 'Ajena')] as never[])
  await db.users.bulkAdd([SUPER, ADMIN, ADMIN_CENTRO, LAURA, SECRE, SOCIO, FABIO, CARLOS, AJENO_ADMIN])
  // v16: Andrés (primer Admin de ambas rutas) es su responsable de capital, con bolsa.
  await sembrarResponsables(db, T, { [R1]: ADMIN.id, [R2]: ADMIN.id })
  await sembrarResponsables(db, TB, { [RB]: AJENO_ADMIN.id })
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 5_000_000 })
}

let cliSeq = 0
async function cliente(routeId = R1) {
  const id = `cli-${++cliSeq}`
  await db.clients.add({ id, tenantId: T, routeId, nombre: `Cliente ${cliSeq}`, documento: id, telefonoPrincipal: '300', direccionPrincipal: 'x', direccionSecundaria: 'y', status: 'activo', createdAt: '', updatedAt: '' } as never)
  return id
}
const entrada = (clientId: string, actor: User, valor: number, cuotas: number, routeId = R1): SaleInputs => ({
  tenantId: T, routeId, clientId, createdByUserId: actor.id, valorVenta: valor, tasaInteres: 20, numeroCuotas: cuotas,
  frecuenciaPago: 'diaria', fechaInicio: today(), paymentDays: [0, 1, 2, 3, 4, 5, 6],
})
/** Crédito administrativo (cobrable de inmediato): 1.000.000 al 20% en 20 cuotas = 60.000. */
async function credito(valor = 1_000_000, cuotas = 20, clientId?: string): Promise<Sale> {
  return createDirectSale(entrada(clientId ?? await cliente(), SUPER, valor, cuotas), SUPER)
}
async function cobra(u: User, sale: Sale, valor: number, fecha = today()): Promise<Payment> {
  const r = await registerPayment({ saleId: sale.id, requestedAmount: valor, actor: u, fecha })
  if (!r.ok) throw new Error(`pago rechazado: ${r.code} ${r.message}`)
  return (await db.payments.get(r.paymentId))!
}
const anular = (p: { id: string }, actor: User = ADMIN, reason = 'Pago duplicado', tenantId = T) =>
  annulPayment({ actor, tenantId, paymentId: p.id, reason })

/** Foto completa del crédito, derivada SOLO de lo persistido. */
async function estado(saleId: string) {
  const sale = (await db.sales.get(saleId))!
  const insts = (await db.installments.where('saleId').equals(saleId).toArray()).sort((a, b) => a.numero - b.numero)
  return {
    saldo: sale.saldo, status: sale.status, fechaFinalizacion: sale.fechaFinalizacion,
    actual: calculateCurrentInstallment(insts)?.numero ?? null,
    ultimaPagada: getLastPaidInstallmentNumber(insts),
    cuotas: insts.map(i => `${i.numero}:${i.status}:${i.pagado}`).join(' '),
    pagadoTotal: insts.reduce((s, i) => s + i.pagado, 0),
    insts,
  }
}
const firma = (e: Awaited<ReturnType<typeof estado>>) => `${e.saldo}|${e.status}|${e.actual}|${e.ultimaPagada}|${e.cuotas}`
const posicion = async (u: User) =>
  (await personalCashPosition({ tenantId: T, routeId: R1, userId: u.id, hasta: new Date().toISOString() })).esperado
const desglose = () => computeRouteBaseBreakdown({ tenantId: T, routeId: R1 })
async function identidad() {
  const r = await computeRouteCashReconciliation({ tenantId: T, routeId: R1 })
  return { base: r.libro.saldo, sinAsignar: r.noAsignado, enManos: r.enPersonas, cuadra: r.cuadra, ok: r.libro.saldo === r.noAsignado + r.enPersonas && r.cuadra }
}
async function fuentes(): Promise<ReportSources> {
  return {
    payments: await db.payments.toArray(), sales: await db.sales.toArray(), expenses: await db.expenses.toArray(),
    clients: await db.clients.toArray(), routes: await db.routes.toArray(), categories: [],
  }
}

// ============================================================
// Casos
// ============================================================
await spec('PAY-REV-001', 'pago parcial 20.000 + anulación: abono 0, cuota 60.000, misma parcela', async () => {
  await empresa()
  const v = await credito()
  const antes = await estado(v.id)
  const p = await cobra(FABIO, v, 20_000)
  const conPago = await estado(v.id)
  await anular(p)
  const despues = await estado(v.id)
  metric('cuota 1', `${antes.insts[0].status} ${antes.insts[0].pagado} → ${conPago.insts[0].status} ${conPago.insts[0].pagado} → ${despues.insts[0].status} ${despues.insts[0].pagado}`)
  metric('saldo', `${antes.saldo} → ${conPago.saldo} → ${despues.saldo}`)
  assert(conPago.insts[0].status === 'parcial' && conPago.actual === 1, 'el pago parcial no quedó como parcial')
  assert(despues.insts[0].pagado === 0 && despues.insts[0].saldo === 60_000 && despues.actual === 1, 'la cuota no volvió a 60.000 pendiente')
  assert(firma(despues) === firma(antes), 'el crédito no volvió exactamente al estado previo')
})

await spec('PAY-REV-002', '20 cuotas, pagadas 1–3; anular el pago que completó la 3', async () => {
  await empresa()
  const v = await credito()
  await cobra(FABIO, v, 60_000)
  await cobra(FABIO, v, 60_000)
  await cobra(FABIO, v, 20_000)
  const p3 = await cobra(FABIO, v, 40_000)   // completa la 3
  const conPago = await estado(v.id)
  await anular(p3)
  const d = await estado(v.id)
  metric('cuotas 1–4 con pago', conPago.insts.slice(0, 4).map(i => `${i.numero}:${i.status}`).join(' '))
  metric('cuotas 1–4 tras anular', d.insts.slice(0, 4).map(i => `${i.numero}:${i.status}:${i.pagado}`).join(' '))
  assert(conPago.insts[2].status === 'pagada', 'la cuota 3 no estaba pagada')
  assert(d.insts[2].status === 'parcial' && d.insts[2].pagado === 20_000 && d.insts[2].saldo === 40_000, 'la cuota 3 sigue PAGADA o no quedó parcial con 20.000')
  assert(d.insts[0].status === 'pagada' && d.insts[1].status === 'pagada', 'se tocaron las cuotas 1–2')
  assert(d.saldo === 1_200_000 - 140_000, 'saldo incorrecto')
})

await spec('PAY-REV-003', 'salto de parcela: el pago que completó la 5 se anula → vuelve a la 5', async () => {
  await empresa()
  const v = await credito()
  await cobra(FABIO, v, 240_000)                        // 1–4
  const antes = await estado(v.id)
  const p = await cobra(FABIO, v, 60_000)               // completa 5 → avanza a 6
  const con = await estado(v.id)
  await anular(p)
  const d = await estado(v.id)
  metric('parcela actual', `${antes.actual} → ${con.actual} → ${d.actual}`)
  metric('última pagada', `${antes.ultimaPagada} → ${con.ultimaPagada} → ${d.ultimaPagada}`)
  assert(con.actual === 6 && con.ultimaPagada === 5, 'el pago no avanzó a la 6')
  assert(d.actual === 5 && d.ultimaPagada === 4 && d.insts[4].status !== 'pagada', 'la parcela quedó congelada en la 6')
  assert(firma(d) === firma(antes), 'el estado no coincide con el previo al pago')
})

await spec('PAY-REV-004', 'pago que finalizó el crédito: vuelve a Activo, saldo 50.000, sin fecha de finalización', async () => {
  await empresa()
  const v = await credito(200_000, 10)                  // total 240.000, cuota 24.000
  await cobra(FABIO, v, 190_000)
  const p = await cobra(FABIO, v, 50_000)
  const con = await estado(v.id)
  await anular(p)
  const d = await estado(v.id)
  metric('estado', `${con.status} (fin ${con.fechaFinalizacion}) → ${d.status} (fin ${d.fechaFinalizacion ?? '—'})`)
  metric('saldo', `${con.saldo} → ${d.saldo}`)
  metric('cuotas finales', d.insts.slice(-3).map(i => `${i.numero}:${i.status}:${i.saldo}`).join(' '))
  assert(con.status === 'finalizada' && !!con.fechaFinalizacion, 'el pago no finalizó el crédito')
  assert(d.status === 'activa' && d.saldo === 50_000 && d.fechaFinalizacion === undefined, 'el crédito no reabrió')
  assert(d.insts.filter(i => i.status !== 'pagada').length === 3 && d.insts[7].status === 'parcial', 'las cuotas finales no volvieron a parcial/pendiente')
})

await spec('PAY-REV-005', 'pago de 150.000 cubre N, N+1 y parte de N+2; anulación reconstruye la distribución', async () => {
  await empresa()
  const v = await credito()
  await cobra(FABIO, v, 60_000)                         // cuota 1 pagada
  const antes = await estado(v.id)
  const p = await cobra(FABIO, v, 150_000)              // cuotas 2 y 3 completas + 30.000 de la 4
  const con = await estado(v.id)
  const cubiertas = installmentsCoveredBy(con.insts, effectivePayments(await db.payments.where('saleId').equals(v.id).toArray()), p.id)
  await anular(p)
  const d = await estado(v.id)
  metric('cubrió', cubiertas.join(', '))
  metric('con pago', con.cuotas.split(' ').slice(0, 4).join(' '))
  metric('tras anular', d.cuotas.split(' ').slice(0, 4).join(' '))
  assert(cubiertas.join() === '2,3,4' && con.insts[3].status === 'parcial' && con.insts[3].pagado === 30_000, 'distribución del pago incorrecta')
  assert(firma(d) === firma(antes), 'la distribución previa no se reconstruyó exactamente')
})

await spec('PAY-REV-006', '09:00 +20.000 · 10:00 +40.000 · 11:00 +30.000; anular solo el segundo', async () => {
  await empresa()
  const v = await credito()
  await cobra(FABIO, v, 20_000)
  const p2 = await cobra(FABIO, v, 40_000)
  await cobra(FABIO, v, 30_000)
  await anular(p2)
  const d = await estado(v.id)
  // Referencia: un crédito idéntico que SOLO recibió 20.000 y 30.000.
  const ref = await credito()
  await cobra(FABIO, ref, 20_000)
  await cobra(FABIO, ref, 30_000)
  const r = await estado(ref.id)
  metric('anulado el intermedio', firma(d))
  metric('solo 20.000 + 30.000', firma(r))
  assert(firma(d) === firma(r) && d.pagadoTotal === 50_000, 'el estado no equivale a procesar solo los restantes')
})

await spec('PAY-REV-007', 'dos pagos con el mismo createdAt: orden y estado deterministas', async () => {
  await empresa()
  const v = await credito()
  const a = await cobra(FABIO, v, 50_000)
  const b = await cobra(FABIO, v, 25_000)
  const mismo = '2026-10-03T12:00:00.000Z'
  await db.payments.update(a.id, { createdAt: mismo })
  await db.payments.update(b.id, { createdAt: mismo })
  const pagos = await db.payments.where('saleId').equals(v.id).toArray()
  const insts = (await estado(v.id)).insts
  const ida = recalculateSaleFromPayments(insts, [pagos[0], pagos[1]]).map(i => `${i.numero}:${i.pagado}`).join()
  const vuelta = recalculateSaleFromPayments(insts, [pagos[1], pagos[0]]).map(i => `${i.numero}:${i.pagado}`).join()
  const orden1 = [...pagos].sort(compareByCreation).map(p => p.id).join()
  const orden2 = [...pagos].reverse().sort(compareByCreation).map(p => p.id).join()
  const cub1 = installmentsCoveredBy(insts, pagos, b.id).join()
  const cub2 = installmentsCoveredBy(insts, [...pagos].reverse(), b.id).join()
  await recomputeSale(v.id)
  const f1 = firma(await estado(v.id))
  await recomputeSale(v.id)
  metric('orden createdAt+id', orden1 === orden2 ? 'estable' : 'INESTABLE')
  metric('parcelas del segundo', `${cub1} / ${cub2}`)
  assert(orden1 === orden2 && ida === vuelta && cub1 === cub2, 'el orden depende de la entrada')
  assert(f1 === firma(await estado(v.id)), 'recalcular dos veces cambió el estado')
})

await spec('PAY-REV-008', 'Base: 100.000 → pago +20.000 → 120.000 → anular → 100.000 (por el libro)', async () => {
  await empresa()
  const v = await credito()
  const b0 = await getRouteBase(R1)
  const p = await cobra(FABIO, v, 20_000)
  const b1 = await getRouteBase(R1)
  await anular(p)
  const b2 = await getRouteBase(R1)
  const filas = (await db.payments.where('saleId').equals(v.id).toArray()).map(x => x.valor).sort((x, y) => y - x)
  metric('Base', `${b0} → ${b1} → ${b2}`)
  metric('libro de pagos', filas.join(', '))
  assert(b1 === b0 + 20_000 && b2 === b0, 'la Base no volvió al valor anterior')
  assert(filas.join() === '20000,-20000', 'la Base no se movió por el libro (original + reversión)')
})

await spec('PAY-REV-009', 'efectivo de Fabio: 50.000 → cobra 20.000 → 70.000 → anular → 50.000', async () => {
  await empresa()
  await assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R1, recipientUserId: FABIO.id, amount: 50_000, motivo: 'Base' })
  const v = await credito()
  const e0 = await posicion(FABIO)
  const p = await cobra(FABIO, v, 20_000)
  const e1 = await posicion(FABIO)
  await anular(p)
  const e2 = await posicion(FABIO)
  const id = await identidad()
  metric('Fabio', `${e0} → ${e1} → ${e2}`)
  metric('Base = Sin asignar + En manos', `${id.base} = ${id.sinAsignar} + ${id.enManos}`)
  assert(e0 === 50_000 && e1 === 70_000 && e2 === 50_000, 'el efectivo de Fabio no volvió')
  assert(id.ok, 'identidad rota')
})

await spec('PAY-REV-010', 'pago ya cuadrado: rechazo explícito; tras devolverle Base, la anulación cuadra', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 100_000)
  await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: FABIO.id, entregado: 100_000 })
  const antes = await identidad()
  const r = await rechazo(() => anular(p))
  const intacto = await db.payments.get(p.id)
  metric('tras cuadre exacto', `Base ${antes.base} · sin asignar ${antes.sinAsignar} · Fabio ${await posicion(FABIO)}`)
  metric('anular', r)
  assert(/Fabio ya no tiene en manos/.test(r) && /entrégale Base/.test(r), 'no se rechazó con la regla de custodia')
  assert(intacto?.state === 'active' && (await db.payments.count()) === 1, 'el rechazo dejó cambios')
  // Regla adoptada: la caja de la ruta le entrega el dinero a Fabio y la anulación procede.
  await assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R1, recipientUserId: FABIO.id, amount: 100_000, motivo: 'Devolver pago anulado' })
  await anular(p)
  const d = await identidad()
  metric('tras devolverle Base y anular', `Base ${d.base} · sin asignar ${d.sinAsignar} · Fabio ${await posicion(FABIO)}`)
  assert(d.base === antes.base - 100_000 && d.sinAsignar === antes.sinAsignar - 100_000 && (await posicion(FABIO)) === 0, 'la distribución no es coherente')
  assert(d.ok, 'identidad rota')
})

await spec('PAY-REV-010b', 'pago ficticio cuadrado con faltante: la anulación cancela el faltante', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 100_000)
  await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: FABIO.id, entregado: 0, motivo: 'no tenía ese dinero' })
  const antes = await posicion(FABIO)
  await anular(p, ADMIN, 'Registro accidental')
  const d = await identidad()
  metric('Fabio (arrastre de faltante)', `${antes} → ${await posicion(FABIO)}`)
  assert(antes === 100_000 && (await posicion(FABIO)) === 0 && d.ok, 'el faltante no quedó cancelado')
})

await spec('PAY-REV-011', 'efectivo ya usado: cobra 100.000, desembolsa 80.000 → anular 100.000 se rechaza sin cambios', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 100_000)
  const req = await createSaleRequest(entrada(await cliente(), FABIO, 80_000, 10), FABIO)
  const s2 = await approveSaleRequest(req.id, LAURA)
  await confirmDisbursement(s2.id, FABIO)
  const antes = { base: await getRouteBase(R1), fabio: await posicion(FABIO), credito: firma(await estado(v.id)), pagos: await db.payments.count() }
  const r = await rechazo(() => anular(p))
  const despues = { base: await getRouteBase(R1), fabio: await posicion(FABIO), credito: firma(await estado(v.id)), pagos: await db.payments.count() }
  metric('Fabio en manos', antes.fabio)
  metric('anular', r)
  assert(/en manos: \$\s?20\.000/.test(r.replace(/ /g, ' ')) || /20\.000/.test(r), 'el mensaje no informa lo que tiene en manos')
  assert(JSON.stringify(antes) === JSON.stringify(despues), 'el rechazo dejó cambios (rollback incompleto)')
  assert((await identidad()).ok, 'identidad rota')
})

await spec('PAY-REV-012', 'motivo obligatorio: vacío y espacios rechazados', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 10_000)
  const vacio = await rechazo(() => anular(p, ADMIN, ''))
  const espacios = await rechazo(() => anular(p, ADMIN, '    '))
  metric('vacío', vacio)
  metric('espacios', espacios)
  assert(/motivo/.test(vacio) && /motivo/.test(espacios), 'se aceptó sin motivo')
  assert((await db.payments.get(p.id))?.state === 'active', 'se modificó el pago')
})

await spec('PAY-REV-013', 'doble anulación: segunda rechazada, una sola reversión', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 10_000)
  await anular(p)
  const r = await rechazo(() => anular(p))
  const reversiones = (await db.payments.toArray()).filter(x => x.state === 'reversal')
  metric('segunda', r)
  assert(r !== 'ACEPTADO' && reversiones.length === 1, 'se creó más de una reversión')
})

await spec('PAY-REV-014', 'la reversión no se puede anular (ni corregido ni anulado)', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 10_000)
  const { reversal } = await anular(p)
  const r = await rechazo(() => anular(reversal))
  metric('anular la reversión', r)
  assert(r === 'Una reversión no se puede anular.', 'la reversión fue anulable')
  assert(!isPaymentAnnullable(reversal) && !canAnnulPayment(SUPER, reversal), 'la UI ofrece anular la reversión')
})

await spec('PAY-REV-015', 'permisos: SuperAdmin y Admin sí; Supervisor, Secretario, Cobrador y Socio no', async () => {
  await empresa()
  const v = await credito()
  const filas: string[] = []
  for (const [u, debe] of [[LAURA, false], [SECRE, false], [FABIO, false], [SOCIO, false], [ADMIN, true], [SUPER, true]] as [User, boolean][]) {
    const p = await cobra(CARLOS, v, 1_000)
    const r = await rechazo(() => anular(p, u))
    const ui = canAnnulPayment(u, p)
    filas.push(`${u.rol}: ${r === 'ACEPTADO' ? 'anula' : 'rechazado'} · botón ${ui ? 'sí' : 'no'}`)
    assert((r === 'ACEPTADO') === debe && ui === debe, `${u.rol}: permiso incorrecto (${r})`)
  }
  metric('roles', filas.join(' | '))
  assert(/can\(actor, 'payment\.reverse'/.test(src('src/services/paymentCorrectionService.ts')), 'no se usa la capacidad payment.reverse')
  assert(!/rol === 'admin'/.test(src('src/services/paymentCorrectionService.ts')), 'se codificó el rol')
})

await spec('PAY-REV-016', 'aislamiento: Admin de otra ruta y Admin de otra empresa', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 10_000)
  const centro = await rechazo(() => anular(p, ADMIN_CENTRO))
  const ajenaSuya = await rechazo(() => anular(p, AJENO_ADMIN, 'x', TB))
  const ajenaNuestra = await rechazo(() => anular(p, AJENO_ADMIN, 'x', T))
  metric('Admin Centro', centro)
  metric('empresa ajena (su tenant)', ajenaSuya)
  metric('empresa ajena (tenant ADEX)', ajenaNuestra)
  assert(centro !== 'ACEPTADO' && ajenaSuya !== 'ACEPTADO' && ajenaNuestra !== 'ACEPTADO', 'se aceptó fuera de alcance')
  assert(!canAnnulPayment(ADMIN_CENTRO, p) && !canAnnulPayment(AJENO_ADMIN, p), 'la UI ofrece anular fuera de alcance')
  assert((await db.payments.get(p.id))?.state === 'active' && (await db.payments.count()) === 1, 'un rechazo dejó cambios')
})

await spec('PAY-REV-017', 'atomicidad: fallo forzado a mitad del recálculo → sin cambios parciales', async () => {
  await empresa()
  const v = await credito()
  await cobra(FABIO, v, 60_000)
  const p = await cobra(FABIO, v, 60_000)
  const antes = { credito: firma(await estado(v.id)), pagos: JSON.stringify((await db.payments.toArray()).sort(compareByCreation)), base: await getRouteBase(R1) }
  const original = db.installments.update.bind(db.installments)
  let llamadas = 0
  ;(db.installments as unknown as { update: unknown }).update = (...args: Parameters<typeof original>) => {
    if (++llamadas === 3) throw new Error('fallo forzado de escritura')
    return original(...args)
  }
  const r = await rechazo(() => anular(p))
  ;(db.installments as unknown as { update: unknown }).update = original
  const despues = { credito: firma(await estado(v.id)), pagos: JSON.stringify((await db.payments.toArray()).sort(compareByCreation)), base: await getRouteBase(R1) }
  metric('anular con fallo', r)
  assert(r === 'fallo forzado de escritura', 'el fallo no se propagó')
  assert(JSON.stringify(antes) === JSON.stringify(despues), 'quedaron cambios parciales')
  await anular(p)
  assert((await estado(v.id)).ultimaPagada === 1, 'tras el fallo, la anulación ya no funciona')
})

await spec('PAY-REV-018', 'auditoría: quién, cuándo, motivo y vínculos en ambos asientos + log', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 30_000)
  const { original, reversal } = await anular(p, ADMIN, '  Valor   digitado incorrectamente ')
  const o = (await db.payments.get(original.id))!
  const rv = (await db.payments.get(reversal.id))!
  const log = (await db.auditLogs.toArray()).find(l => l.action === 'ANNUL_PAYMENT')
  metric('original', `${o.state} · reversalPaymentId=${o.reversalPaymentId === rv.id} · por ${o.correctedBy} · ${o.correctedAt} · "${o.correctionReason}"`)
  metric('reversión', `${rv.state} · ${rv.valor} · reversesPaymentId=${rv.reversesPaymentId === o.id} · responsable ${rv.collectorId} · autor ${rv.createdByUserId} · fecha ${rv.fecha}`)
  metric('log', `${log?.action} · ${log?.userId} · ${log?.motivo}`)
  assert(o.state === 'reversed' && o.reversalPaymentId === rv.id && o.correctedBy === ADMIN.id && !!o.correctedAt && o.correctionReason === 'Valor digitado incorrectamente', 'original sin traza completa')
  assert(rv.state === 'reversal' && rv.valor === -30_000 && rv.reversesPaymentId === o.id && rv.collectorId === FABIO.id && rv.createdByUserId === ADMIN.id && rv.fecha === p.fecha, 'reversión sin traza completa')
  assert(log?.userId === ADMIN.id && log?.entityId === o.id && log?.motivo === o.correctionReason, 'no quedó en el log de auditoría')
  assert(paymentDisplayStateOf(o) === 'anulado' && paymentDisplayStateOf(rv) === 'reversion', 'estado visible incorrecto')
})

await spec('PAY-REV-019', 'reportes del día: pago 01/10, anulado el 03/10', async () => {
  await empresa()
  const v = await credito()
  const DIA_PAGO = '2026-10-01'
  const p = await cobra(FABIO, v, 100_000, DIA_PAGO)
  const dia = (d: string) => ({ routeIds: new Set([R1]), fechaDesde: d, fechaHasta: d })
  const sumaPagos = (rows: Record<string, unknown>[]) => rows.reduce((s, r) => s + Number(r.Valor), 0)
  const antes01 = sumaPagos(buildPagosReport(await fuentes(), dia(DIA_PAGO)))
  await anular(p)
  const s = await fuentes()
  const rep01 = sumaPagos(buildPagosReport(s, dia(DIA_PAGO)))
  const rep03 = sumaPagos(buildPagosReport(s, dia(today())))
  const caja01 = buildCajaDiariaReport(s, dia(DIA_PAGO)).reduce((t, r) => t + Number(r.Cobros), 0)
  const motor01 = (await getCashboxSummary(R1, DIA_PAGO, DIA_PAGO)).cobros
  const motor03 = (await getCashboxSummary(R1, today(), today())).cobros
  const dash01 = (await getAdminDashboardData({ user: ADMIN, tenantId: T, now: new Date(`${DIA_PAGO}T12:00:00`) })).recaudoHoy
  metric('Pagos 01/10', `${antes01} → ${rep01}`)
  metric('Pagos 03/10 (día de la anulación)', rep03)
  metric('Caja diaria 01/10 · motor 01/10 · motor 03/10 · dashboard 01/10', `${caja01} · ${motor01} · ${motor03} · ${dash01}`)
  assert(antes01 === 100_000, 'el pago no estaba en el reporte del día')
  assert(rep01 === 0 && caja01 === 0 && motor01 === 0 && dash01 === 0, 'el día del pago sigue mostrando el cobro anulado')
  assert(rep03 === 0 && motor03 === 0, 'el día de la anulación muestra un cobro negativo')
})

await spec('PAY-REV-020', 'reporte por rango 01/10–03/10: neto vigente; el resto del rango no cambia', async () => {
  await empresa()
  const v = await credito()
  await cobra(FABIO, v, 30_000, '2026-10-01')
  const malo = await cobra(FABIO, v, 100_000, '2026-10-02')
  await cobra(FABIO, v, 30_000, today())
  const rango = { routeIds: new Set([R1]), fechaDesde: '2026-10-01', fechaHasta: today() }
  const antes = buildPagosReport(await fuentes(), rango).reduce((s, r) => s + Number(r.Valor), 0)
  await anular(malo)
  const filas = buildPagosReport(await fuentes(), rango)
  const despues = filas.reduce((s, r) => s + Number(r.Valor), 0)
  const motor = (await getCashboxSummary(R1, '2026-10-01', today())).cobros
  metric('rango', `${antes} → ${despues} (${filas.length} filas) · motor ${motor}`)
  assert(despues === 60_000 && motor === 60_000 && filas.length === 2, 'el rango no muestra el neto vigente')
})

await spec('PAY-REV-021', 'Ventas activas / cartera: el crédito finalizado reaparece tras anular el pago final', async () => {
  await empresa()
  const v = await credito(200_000, 10)
  const p = await cobra(FABIO, v, 240_000)
  const activasCon = (await db.sales.where('routeId').equals(R1).toArray()).filter(s => s.status === 'activa').map(s => s.id)
  const carteraCon = (await desglose()).carteraEnCalle
  await anular(p)
  const activas = (await db.sales.where('routeId').equals(R1).toArray()).filter(s => s.status === 'activa').map(s => s.id)
  const cartera = (await desglose()).carteraEnCalle
  const insts = new Map([[v.id, (await estado(v.id)).insts]])
  const ops = routeOpsFacts({ routeId: R1, nombre: 'Barreiro', sales: await db.sales.where('routeId').equals(R1).toArray(), installmentsBySale: insts, payments: await db.payments.toArray(), expenses: [], today: today() })
  metric('activas', `${activasCon.length} → ${activas.length}`)
  metric('cartera en calle', `${carteraCon} → ${cartera}`)
  metric('Oficina: ventas activas · cartera', `${ops.ventasActivas} · ${ops.carteraActiva}`)
  assert(!activasCon.includes(v.id) && activas.includes(v.id), 'no volvió a Ventas activas')
  assert(cartera === carteraCon + 240_000 && ops.carteraActiva === 240_000 && ops.ventasActivas === 1, 'no volvió a cartera')
})

await spec('PAY-REV-022', 'historial del cliente: original visible como ANULADO con motivo; reversión no es una fila', async () => {
  await empresa()
  const v = await credito()
  await cobra(FABIO, v, 20_000)
  const p = await cobra(FABIO, v, 50_000)
  await anular(p, ADMIN, 'Pago duplicado')
  const pagos = (await db.payments.where('saleId').equals(v.id).toArray()).sort(compareByCreation)
  const filas = paymentHistoryRows(pagos)
  metric('filas', filas.map(f => `${f.payment.valor} ${paymentDisplayStateOf(f.payment)}${f.reversal ? ` (reversión ${f.reversal.valor}, ${f.payment.correctionReason})` : ''}`).join(' · '))
  assert(filas.length === 2 && filas.every(f => f.payment.valor > 0), 'la reversión aparece como abono')
  const anulada = filas.find(f => f.payment.id === p.id)
  assert(anulada && paymentDisplayStateOf(anulada.payment) === 'anulado' && anulada.reversal?.valor === -50_000, 'el anulado no se entiende')
  for (const f of ['src/pages/admin/ClientsPage.tsx', 'src/pages/collector/CollectorPaymentHistoryPage.tsx', 'src/pages/admin/ActiveSalesPage.tsx']) {
    const s = src(f)
    assert(s.includes('paymentHistoryRows(') && s.includes('<PaymentAnnulmentDetail') && s.includes('<PaymentStateBadge'), `${f}: no muestra el anulado`)
  }
  assert(/title="Anular pago"/.test(src('src/components/ui/PaymentAnnulment.tsx')) && /label="Motivo" required/.test(src('src/components/ui/PaymentAnnulment.tsx')), 'el modal no dice "Anular pago" o no exige motivo')
})

await spec('PAY-REV-023', 'Cobrador al reconsultar (y en la misma pestaña): no ve el pago como vigente', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000)
  const señales: string[] = []
  const off = subscribeDataChanges(OPERATIONAL_TABLES, t => señales.push([...t].filter(x => x !== 'auditLogs').sort().join('+')))
  await anular(p)
  for (let i = 0; i < 50 && señales.length === 0; i++) await sleep(5)
  off()
  // Mismas consultas que CollectorRoutePage / CollectorHomePage / PaymentPage.
  const delDia = effectivePayments(await db.payments.where('routeId').equals(R1).toArray()).filter(x => x.fecha === today())
  const e = await estado(v.id)
  metric('señal', señales.join(', '))
  metric('vista Cobrador', `pagó hoy: ${delDia.some(x => x.saleId === v.id) ? 'sí' : 'no'} · saldo ${e.saldo} · parcela ${e.actual} · cuota 1 ${e.insts[0].status}`)
  assert(señales.some(s => s.includes('payments') && s.includes('installments') && s.includes('sales')), 'la anulación no emitió la señal de revisión')
  assert(!delDia.some(x => x.saleId === v.id) && e.saldo === 1_200_000 && e.actual === 1 && e.insts[0].status !== 'pagada', 'el Cobrador sigue viendo el pago vigente')
  const ruta = src('src/pages/collector/CollectorRoutePage.tsx')
  assert(ruta.includes('effectivePayments(await db.payments') && ruta.includes('useDataRevision()'), 'la Ruta del Cobrador no filtra anulados o no se refresca')
  for (const f of ['CollectorHomePage', 'CollectorDailyReportPage', 'ClientDetailPage', 'PaymentPage', 'CollectorPaymentHistoryPage']) {
    assert(src(`src/pages/collector/${f}.tsx`).includes('useDataRevision()'), `${f} no se refresca`)
  }
})

await spec('PAY-REV-024', 'cuadre / liquidación: el anulado no se cobra al cuadre ni a la semana', async () => {
  await empresa()
  const v = await credito()
  await cobra(FABIO, v, 30_000)
  const p = await cobra(FABIO, v, 70_000)
  await anular(p)
  const pos = await personalCashPosition({ tenantId: T, routeId: R1, userId: FABIO.id, hasta: new Date().toISOString() })
  const semana = await generateWeeklySettlement({ tenantId: T, routeId: R1, semanaInicio: today(), semanaFin: today() } as never)
  const cuadre = await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: FABIO.id, entregado: 30_000 })
  metric('cuadre Fabio', `recaudado ${pos.recaudado} · esperado ${pos.esperado} → diferencia ${cuadre.diferencia}`)
  metric('liquidación semanal', `cobros ${semana.cobros}`)
  assert(pos.recaudado === 30_000 && pos.esperado === 30_000 && cuadre.esperado === 30_000 && cuadre.diferencia === 0, 'el cuadre incluye el pago anulado')
  assert(semana.cobros === 30_000, 'la liquidación incluye el pago anulado')
  assert((await identidad()).ok, 'identidad rota')
})

await spec('PAY-REV-025', 'overshoot: pago topado al saldo; anularlo nunca deja saldo negativo', async () => {
  await empresa()
  const v = await credito(200_000, 10)
  await cobra(FABIO, v, 200_000)
  const p = await cobra(FABIO, v, 500_000)              // se topa a 40.000
  const con = await estado(v.id)
  await anular(p)
  const d = await estado(v.id)
  metric('aplicado', p.valor)
  metric('saldo', `${con.saldo} (${con.status}) → ${d.saldo} (${d.status})`)
  assert(p.valor === 40_000 && con.saldo === 0, 'el tope no se aplicó')
  assert(d.saldo === 40_000 && d.status === 'activa' && d.insts.every(i => i.saldo >= 0 && i.pagado >= 0), 'saldo incoherente')
})

await spec('PAY-REV-026', 'concurrencia: dos anulaciones simultáneas del mismo pago → solo una', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 25_000)
  const rs = await Promise.all([rechazo(() => anular(p, ADMIN)), rechazo(() => anular(p, SUPER))])
  const reversiones = (await db.payments.toArray()).filter(x => x.state === 'reversal')
  metric('resultados', rs.join(' | '))
  assert(rs.filter(r => r === 'ACEPTADO').length === 1 && reversiones.length === 1, 'pasaron dos anulaciones')
  assert((await estado(v.id)).saldo === 1_200_000 && (await getRouteBase(R1)) === 5_000_000 - 1_000_000, 'efecto duplicado')
})

await spec('PAY-REV-027', 'pago histórico sin campos nuevos (sin state ni createdByUserId): anulable', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000)
  const legado = { ...p } as Partial<Payment>
  delete legado.state
  delete legado.createdByUserId
  await db.payments.put(legado as Payment)
  assert(isPaymentAnnullable(legado as Payment) && canAnnulPayment(ADMIN, legado as Payment), 'el histórico no es anulable')
  await anular(p)
  const e = await estado(v.id)
  metric('tras anular', `saldo ${e.saldo} · cuota 1 ${e.insts[0].status}`)
  assert(e.saldo === 1_200_000 && (await db.payments.get(p.id))?.state === 'reversed', 'no se anuló el histórico')
})

await spec('PAY-REV-028', 'no regresión Base canónica: Base = Sin asignar + En manos en cada paso', async () => {
  await empresa()
  await assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R1, recipientUserId: CARLOS.id, amount: 40_000, motivo: 'Base' })
  const v = await credito()
  const pasos: string[] = []
  const foto = async (k: string) => {
    const d = await desglose()
    const i = await identidad()
    pasos.push(`${k}: ${d.base} = ${d.sinAsignar} + ${d.enTrabajadores}`)
    assert(d.base === d.sinAsignar + d.enTrabajadores && i.ok && d.base === await getRouteBase(R1), `${k}: identidad rota`)
  }
  await foto('inicio')
  const a = await cobra(FABIO, v, 30_000); await foto('Fabio +30.000')
  const b = await cobra(CARLOS, v, 20_000); await foto('Carlos +20.000')
  await anular(a); await foto('anula Fabio')
  await anular(b); await foto('anula Carlos')
  metric('pasos', pasos.join(' | '))
})

await spec('PAY-REV-029', 'segundo crédito: reabrir el primero no toca al segundo', async () => {
  await empresa()
  const cli = await cliente()
  const v1 = await credito(200_000, 10, cli)
  const fin = await cobra(FABIO, v1, 240_000)
  const v2 = await credito(300_000, 10, cli)
  await cobra(FABIO, v2, 36_000)
  const antes2 = firma(await estado(v2.id))
  const pagos2 = JSON.stringify(await db.payments.where('saleId').equals(v2.id).toArray())
  await anular(fin)
  const e1 = await estado(v1.id)
  metric('crédito 1', `${e1.status} saldo ${e1.saldo}`)
  metric('crédito 2', `${(await db.sales.get(v2.id))!.status} · intacto ${firma(await estado(v2.id)) === antes2}`)
  assert(e1.status === 'activa' && e1.saldo === 240_000, 'el primero no reabrió')
  assert(firma(await estado(v2.id)) === antes2 && JSON.stringify(await db.payments.where('saleId').equals(v2.id).toArray()) === pagos2, 'el segundo crédito cambió')
  assert((await db.sales.get(v2.id))!.clientId === cli && (await db.sales.get(v1.id))!.clientId === cli, 'relaciones rotas')
})

await spec('PAY-REV-030', 'no borrado destructivo: el original sigue en la base, intacto salvo la marca', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 45_000)
  await anular(p)
  const o = await db.payments.get(p.id)
  metric('original', o ? `${o.valor} ${o.fecha} ${o.collectorId} ${o.state}` : 'BORRADO')
  assert(o && o.valor === p.valor && o.fecha === p.fecha && o.collectorId === p.collectorId && o.createdAt === p.createdAt, 'el original se borró o se reescribió')
  assert(!/payments\.(delete|bulkDelete|clear)\(/.test(src('src/services/paymentCorrectionService.ts')), 'hay borrado físico')
})

// ============================================================
// Informe
// ============================================================
console.log('\n════════════════════════════════════════════════════════════════')
console.log('  RUTACASH · ANULACIÓN DE PAGOS (punto 7)')
console.log('════════════════════════════════════════════════════════════════')
for (const r of results) {
  console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id}  ${r.desc}`)
  for (const m of r.metrics) console.log(`          · ${m}`)
  if (r.error) console.log(`          ✗ ${r.error}`)
}
const fallidos = results.filter(r => !r.passed).length
console.log(`\n  ${results.length - fallidos}/${results.length} casos OK`)
if (fallidos > 0) process.exit(1)
