// ============================================================
// RUTACASH — SUITE GASTOS DEL COBRADOR Y EFECTIVO EN MANOS (DEXIE REAL)
// ------------------------------------------------------------
//   npm run test:expensecash
//
// Incidente de producción (2026-10-08): un cobrador recaudó R$ 886 y al registrar
// R$ 100 de combustible recibió «El gasto supera el efectivo en manos del
// cobrador». El negocio exige (comportamiento histórico, anterior a e7708c2):
//
//   · un gasto de TRABAJADOR se registra aunque deje su posición en negativo;
//   · el negativo se muestra y se arrastra en los cálculos, sin compensaciones;
//   · el efectivo en manos solo suma recaudos EN EFECTIVO (una transferencia
//     bancaria no está en el bolsillo de nadie);
//   · un reintento técnico de la MISMA operación no duplica el gasto.
//
// Los controles de capital (entrega de Base, devolución, traspaso, retiro, gasto
// de la caja de la ruta) NO cambian: siguen sin poder gastar efectivo inexistente.
//
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import { sembrarResponsables } from './financial/capitalFixture'
import { today } from '../src/lib/formatters'
import { getRouteBase } from '../src/services/cashboxEngine'
import { computeRouteCashReconciliation } from '../src/services/routeCashReconciliation'
import { closeCashSettlement, personalCashPosition, previewCashSettlement } from '../src/services/cashSettlementService'
import { registerCapital, registerWithdrawal } from '../src/services/routeFundsService'
import {
  assignBaseToWorker, returnBaseFromWorker, transferBaseBetweenWorkers, getTransferableCash,
} from '../src/services/cashCustodyService'
import { createDirectSale, type SaleInputs } from '../src/services/saleRequestService'
import { registerPayment } from '../src/services/paymentService'
import { createExpense, type CreateExpenseParams } from '../src/services/expenseService'
import { generateWeeklySettlement } from '../src/services/weeklySettlementEngine'
import { getPendingSyncCount, syncPendingItems } from '../src/services/syncService'
import type { PaymentType, Sale, SyncStatus, User } from '../src/models/types'
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

const src = (p: string) => fs.readFileSync(p, 'utf8')

// ============================================================
// Escenario: ADEX, ruta Barreiro con capital; Fabio y Carlos cobradores
// ============================================================
const T = 't-adex'
const R1 = 'r-barreiro'
const CAT_COMBUSTIBLE = 'cat-combustible'

const persona = (id: string, nombre: string, rol: User['rol'], rutas: string[]): User => ({
  id, tenantId: T, nombre, email: `${id}@adex.co`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)

const ADMIN = persona('u-admin', 'Andrés Admin', 'admin', [R1])
const LAURA = persona('u-laura', 'Laura Supervisora', 'supervisor', [R1])
const FABIO = persona('u-fabio', 'Fabio', 'cobrador', [R1])
const CARLOS = persona('u-carlos', 'Carlos', 'cobrador', [R1])

const CAPITAL = 1_000_000

async function escenario() {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.add({ id: T, nombre: 'ADEX', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z' } as never)
  await db.offices.add({ id: 'of-1', tenantId: T, nombre: 'Leticia', codigo: 'LET', status: 'activa', createdAt: '', updatedAt: '' } as never)
  await db.routes.add({ id: R1, tenantId: T, officeId: 'of-1', nombre: 'Barreiro', codigo: R1, status: 'activa', capitalInicial: 0, capitalActual: 0, tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 0, createdAt: '2026-09-01' } as never)
  await db.users.bulkAdd([ADMIN, LAURA, FABIO, CARLOS])
  await sembrarResponsables(db, T, { [R1]: ADMIN.id })
  await db.expenseCategories.add({ id: CAT_COMBUSTIBLE, tenantId: T, nombre: 'Combustible', activa: true })
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: CAPITAL })
}

let cliSeq = 0
/** Crédito colocado por el ADMIN (no sale del efectivo de ningún cobrador). */
async function credito(valor = 10_000): Promise<Sale> {
  const clientId = `cli-${++cliSeq}`
  await db.clients.add({ id: clientId, tenantId: T, routeId: R1, nombre: clientId, documento: clientId, telefonoPrincipal: '300', direccionPrincipal: 'x', direccionSecundaria: 'y', status: 'activo', createdAt: '', updatedAt: '' } as never)
  const input: SaleInputs = {
    tenantId: T, routeId: R1, clientId, createdByUserId: ADMIN.id, valorVenta: valor, tasaInteres: 20, numeroCuotas: 10,
    frecuenciaPago: 'diaria', fechaInicio: today(), paymentDays: [0, 1, 2, 3, 4, 5, 6],
  }
  return createDirectSale(input, ADMIN)
}
async function cobra(u: User, valor: number, extra: { tipo?: PaymentType; syncStatus?: SyncStatus } = {}) {
  const sale = await credito()
  const r = await registerPayment({ saleId: sale.id, requestedAmount: valor, actor: u, fecha: today(), ...extra })
  if (!r.ok) throw new Error(`pago rechazado: ${r.code}`)
  return r
}
const gasto = (u: User, valor: number, extra: Partial<CreateExpenseParams> = {}) =>
  createExpense({
    actor: u, tenantId: T, scope: 'trabajador', routeId: R1, collectorId: u.id,
    categoryId: CAT_COMBUSTIBLE, valor, descripcion: 'Combustible', ...extra,
  })
const ahora = () => new Date().toISOString()
const pos = (u: User) => personalCashPosition({ tenantId: T, routeId: R1, userId: u.id, hasta: ahora() })
const posicion = async (u: User) => (await pos(u)).esperado
/** Lo que ve el cobrador en «Mi efectivo» (mismo servicio que la pantalla). */
const miEfectivo = (u: User) => previewCashSettlement({ actor: u, tenantId: T, routeId: R1, userId: u.id })
const conciliacion = () => computeRouteCashReconciliation({ tenantId: T, routeId: R1 })
const nGastos = () => db.expenses.count()

// ============================================================
// 1. CASO EXACTO DEL INCIDENTE
// ============================================================
await spec('EXP-CASH-001', 'recaudo efectivo R$ 886, gasto R$ 100: aceptado, saldo R$ 786', async () => {
  await escenario()
  await cobra(FABIO, 886)
  const r = await rechazo(() => gasto(FABIO, 100))
  const p = await pos(FABIO)
  const vista = await miEfectivo(FABIO)
  metric('registro del gasto', r)
  metric('recaudado / gastos / efectivo en manos', `${p.recaudado} / ${p.gastos} / ${p.esperado}`)
  metric('«Mi efectivo»', vista.esperado)
  assert(r === 'ACEPTADO', `el gasto fue rechazado: ${r}`)
  assert(p.recaudado === 886 && p.gastos === 100 && p.esperado === 786, 'saldo incorrecto')
  assert(vista.esperado === 786, 'la pantalla del cobrador muestra otra cifra')
})

// ============================================================
// 2. SALDOS NEGATIVOS (comportamiento histórico)
// ============================================================
await spec('EXP-CASH-002', 'sin Base ni recaudos, gasto R$ 100: aceptado, balance −R$ 100 sin fabricar capital', async () => {
  await escenario()
  const antes = await conciliacion()
  const custodiaAntes = await db.cashCustodyMovements.count()
  const capitalAntes = await db.capitalMovements.count()
  const r = await rechazo(() => gasto(FABIO, 100))
  const despues = await conciliacion()
  metric('registro', r)
  metric('posición de Fabio', await posicion(FABIO))
  metric('Base / Sin asignar / En manos', `${antes.libro.saldo}/${antes.noAsignado}/${antes.enPersonas} → ${despues.libro.saldo}/${despues.noAsignado}/${despues.enPersonas}`)
  metric('Disponible de la ruta', `${antes.disponible} → ${despues.disponible}`)
  assert(r === 'ACEPTADO', `rechazado: ${r}`)
  assert(await posicion(FABIO) === -100, 'el negativo no se refleja')
  // El gasto baja la Base UNA vez; la caja sin asignar de la ruta no lo pagó.
  assert(despues.libro.saldo === antes.libro.saldo - 100, 'la Base no bajó exactamente 100')
  assert(despues.noAsignado === antes.noAsignado, 'el gasto tocó la caja sin asignar')
  assert(despues.enPersonas === antes.enPersonas - 100, 'el negativo no está en manos de Fabio')
  // No se fabrica capital: lo disponible nunca sube por un negativo.
  assert(despues.disponible <= antes.disponible, 'un saldo negativo aumentó lo disponible')
  assert(despues.cuadra, 'la conciliación no cuadra')
  assert(await db.cashCustodyMovements.count() === custodiaAntes && await db.capitalMovements.count() === capitalAntes,
    'se crearon movimientos de custodia o capital para compensar')
})

await spec('EXP-CASH-003', 'Base R$ 200, gasto R$ 250: balance −R$ 50', async () => {
  await escenario()
  await assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R1, recipientUserId: FABIO.id, amount: 200, motivo: 'Base del día' })
  const r = await rechazo(() => gasto(FABIO, 250))
  metric('registro', r)
  metric('posición', await posicion(FABIO))
  assert(r === 'ACEPTADO' && await posicion(FABIO) === -50, 'balance incorrecto')
  assert((await conciliacion()).cuadra, 'la conciliación no cuadra')
})

await spec('EXP-CASH-004', 'recaudo R$ 886, entrega R$ 800 y gasto R$ 100: balance −R$ 14', async () => {
  await escenario()
  await cobra(FABIO, 886)
  // Entrega del efectivo a la caja de la ruta (la recibe el Administrador).
  await returnBaseFromWorker({ actor: ADMIN, tenantId: T, routeId: R1, fromUserId: FABIO.id, amount: 800, motivo: 'Entrega del recaudo' })
  const r = await rechazo(() => gasto(FABIO, 100))
  const p = await pos(FABIO)
  metric('registro', r)
  metric('recaudado − entregado − gastos', `${p.recaudado} − ${p.baseDevuelta} − ${p.gastos} = ${p.esperado}`)
  assert(r === 'ACEPTADO' && p.esperado === -14, 'balance incorrecto')
  assert((await conciliacion()).cuadra, 'la conciliación no cuadra')
})

await spec('EXP-CASH-005', 'recaudo NO efectivo R$ 886, gasto R$ 100: no se suma como efectivo; balance −R$ 100', async () => {
  await escenario()
  await cobra(FABIO, 886, { tipo: 'transferencia' })
  const r = await rechazo(() => gasto(FABIO, 100))
  const p = await pos(FABIO)
  const c = await conciliacion()
  metric('registro', r)
  metric('recaudado en efectivo / posición', `${p.recaudado} / ${p.esperado}`)
  metric('cobros en el libro de la ruta', c.libro.cobros)
  assert(r === 'ACEPTADO', `rechazado: ${r}`)
  assert(p.recaudado === 0 && p.esperado === -100, 'la transferencia se contó como efectivo en manos')
  // El cobro sigue existiendo para la ruta (cartera y libro): solo no está en el bolsillo.
  assert(c.libro.cobros === 886, 'el cobro desapareció del libro de la ruta')
  assert(c.cuadra, 'la conciliación no cuadra')
})

// ============================================================
// 3. DUPLICADOS E IDEMPOTENCIA
// ============================================================
await spec('EXP-CASH-006', 'recaudo R$ 886 y dos gastos legítimos de R$ 100: ambos registrados; saldo R$ 686', async () => {
  await escenario()
  await cobra(FABIO, 886)
  const a = await gasto(FABIO, 100)
  const b = await gasto(FABIO, 100)
  metric('ids', `${a.id} / ${b.id}`)
  metric('posición', await posicion(FABIO))
  assert(a.id !== b.id && await nGastos() === 2, 'no quedaron dos gastos')
  assert(await posicion(FABIO) === 686, 'saldo incorrecto')
})

await spec('EXP-CASH-007', 'reintento técnico de la MISMA operación: sin duplicación', async () => {
  await escenario()
  await cobra(FABIO, 886)
  const op = 'op-combustible-1'
  const primero = await gasto(FABIO, 100, { operationId: op })
  const reintento = await gasto(FABIO, 100, { operationId: op })
  const auditorias = (await db.auditLogs.toArray()).filter(l => l.action === 'CREATE_EXPENSE').length
  metric('ids', `${primero.id} / ${reintento.id}`)
  metric('gastos / auditorías', `${await nGastos()} / ${auditorias}`)
  metric('posición', await posicion(FABIO))
  assert(primero.id === op && reintento.id === op, 'el reintento creó otra operación')
  assert(await nGastos() === 1 && auditorias === 1, 'el reintento duplicó el gasto o su auditoría')
  assert(await posicion(FABIO) === 786, 'el gasto se descontó dos veces')
  // Reutilizar el identificador con OTROS datos no es un reintento: se rechaza.
  const otro = await rechazo(() => gasto(FABIO, 250, { operationId: op }))
  const ajeno = await rechazo(() => gasto(CARLOS, 100, { operationId: op }))
  metric('mismo id, otro valor', otro)
  metric('mismo id, otra persona', ajeno)
  assert(otro !== 'ACEPTADO' && ajeno !== 'ACEPTADO' && await nGastos() === 1, 'se aceptó un id reutilizado con otros datos')
})

// ============================================================
// 4. MOVIMIENTOS POSTERIORES, CUADRE Y LIQUIDACIÓN
// ============================================================
await spec('EXP-CASH-008', 'gasto que deja negativo y luego recaudo en efectivo: saldo recalculado', async () => {
  await escenario()
  await gasto(FABIO, 100)
  const negativo = await posicion(FABIO)
  await cobra(FABIO, 500)
  const despues = await posicion(FABIO)
  metric('posición', `${negativo} → ${despues}`)
  assert(negativo === -100 && despues === 400, 'el negativo no se arrastró correctamente')
})

await spec('EXP-CASH-009', 'gasto y cuadre: el gasto cuenta UNA vez (ciclo, liquidación semanal y conciliación)', async () => {
  await escenario()
  await cobra(FABIO, 886)
  await gasto(FABIO, 100)
  const doc = await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: FABIO.id, entregado: 786 })
  const siguiente = await pos(FABIO)
  const semana = await generateWeeklySettlement({ tenantId: T, routeId: R1, semanaInicio: today(), semanaFin: today() })
  const c = await conciliacion()
  metric('cuadre', `recaudado ${doc.recaudado} − gastos ${doc.gastos} = esperado ${doc.esperado}; entregó ${doc.entregado} → ${doc.diferencia}`)
  metric('ciclo siguiente: gastos / posición', `${siguiente.gastos} / ${siguiente.esperado}`)
  metric('liquidación semanal · gastos', semana.gastos)
  assert(doc.gastos === 100 && doc.esperado === 786 && doc.diferencia === 0, 'cuadre incorrecto')
  assert(siguiente.gastos === 0 && siguiente.esperado === 0, 'el gasto volvió a contarse en el ciclo siguiente')
  assert(semana.gastos === 100, 'la liquidación semanal no cuenta el gasto exactamente una vez')
  assert(c.cuadra && c.libro.gastos === 100, 'la conciliación no cuadra')
})

await spec('EXP-CASH-010', 'gasto con saldo negativo y cuadre: la diferencia queda documentada, sin fabricar efectivo', async () => {
  await escenario()
  await gasto(FABIO, 100)
  const antes = await conciliacion()
  const sinMotivo = await rechazo(() => closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: FABIO.id, entregado: 0 }))
  const doc = await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: FABIO.id, entregado: 0, motivo: 'Fabio pagó el combustible de su bolsillo' })
  const despues = await conciliacion()
  metric('cuadre sin motivo', sinMotivo)
  metric('cuadre', `esperado ${doc.esperado}, entregado ${doc.entregado}, diferencia ${doc.diferencia}, gastos ${doc.gastos}`)
  metric('efectivo físico sin asignar', `${antes.efectivoFisicoNoAsignado} → ${despues.efectivoFisicoNoAsignado}`)
  assert(sinMotivo !== 'ACEPTADO', 'una diferencia se cerró sin motivo')
  assert(doc.esperado === -100 && doc.gastos === 100 && doc.diferencia === 100, 'el cuadre no refleja el negativo')
  assert(await posicion(FABIO) === 0, 'el ciclo siguiente no parte limpio')
  assert(despues.efectivoFisicoNoAsignado === antes.efectivoFisicoNoAsignado, 'el cuadre fabricó o perdió efectivo físico')
  assert(despues.cuadra && despues.libro.gastos === 100, 'la conciliación no cuadra')
})

// ============================================================
// 5. SIN CONEXIÓN
// ============================================================
await spec('EXP-CASH-011', 'recaudo y gasto sin conexión: persisten y se sincronizan sin duplicar ni perder', async () => {
  await escenario()
  await cobra(FABIO, 886, { syncStatus: 'pending' })
  const e = await gasto(FABIO, 100, { syncStatus: 'pending', operationId: 'op-offline' })
  // Reintento del dispositivo mientras sigue sin conexión.
  await gasto(FABIO, 100, { syncStatus: 'pending', operationId: 'op-offline' })
  const pendientes = await getPendingSyncCount({ tenantId: T, routeIds: [R1] })
  const offline = await posicion(FABIO)
  const r1 = await syncPendingItems({ tenantId: T, routeIds: [R1] })
  const r2 = await syncPendingItems({ tenantId: T, routeIds: [R1] })
  const tras = await db.expenses.get(e.id)
  metric('pendientes', pendientes)
  metric('posición sin conexión / tras sincronizar', `${offline} / ${await posicion(FABIO)}`)
  metric('sincronizados (1ª / 2ª pasada)', `${r1.synced} / ${r2.synced}`)
  assert(pendientes === 2, 'no quedaron exactamente un pago y un gasto pendientes')
  assert(offline === 786 && await posicion(FABIO) === 786, 'la posición cambió al sincronizar')
  assert(r1.synced === 2 && r2.synced === 0, 'la sincronización no es idempotente')
  assert(await nGastos() === 1 && tras?.syncStatus === 'synced' && tras.valor === 100, 'gasto duplicado, perdido o alterado')
})

// ============================================================
// 6. CONTROLES QUE SIGUEN VIGENTES
// ============================================================
await spec('EXP-CASH-012', 'capital: entrega de Base, devolución, traspaso, retiro y gasto de la caja de la ruta siguen limitados', async () => {
  await escenario()
  await gasto(FABIO, 100)                        // Fabio en −100
  const c = await conciliacion()
  const casos = {
    'entrega de Base > sin asignar': await rechazo(() => assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R1, recipientUserId: CARLOS.id, amount: c.disponible + 1, motivo: 'Base del día' })),
    'devolución con posición negativa': await rechazo(() => returnBaseFromWorker({ actor: ADMIN, tenantId: T, routeId: R1, fromUserId: FABIO.id, amount: 1, motivo: 'Entrega del recaudo' })),
    'traspaso con posición negativa': await rechazo(() => transferBaseBetweenWorkers({ actor: ADMIN, tenantId: T, routeId: R1, fromUserId: FABIO.id, toUserId: CARLOS.id, amount: 1, motivo: 'Traspaso entre trabajadores' })),
    'retiro > disponible': await rechazo(() => registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R1, valor: c.disponible + 1 })),
    'gasto de la caja de la ruta > sin asignar': await rechazo(() => createExpense({ actor: ADMIN, tenantId: T, scope: 'ruta', routeId: R1, categoryId: CAT_COMBUSTIBLE, valor: c.disponible + 1 })),
  }
  for (const [k, v] of Object.entries(casos)) metric(k, v)
  assert(Object.values(casos).every(v => v !== 'ACEPTADO'), 'un control de capital dejó de operar')
  assert(await getTransferableCash({ tenantId: T, routeId: R1, userId: FABIO.id }) === 0, 'una posición negativa ofrece efectivo traspasable')
  assert(await getRouteBase(R1) === CAPITAL - 100, 'la Base de la ruta cambió por los rechazos')
})

await spec('EXP-CASH-013', 'validaciones independientes: valor, categoría, permisos, ruta y persona', async () => {
  await escenario()
  const casos = {
    'valor 0': await rechazo(() => gasto(FABIO, 0)),
    'valor negativo': await rechazo(() => gasto(FABIO, -100)),
    'valor no numérico': await rechazo(() => gasto(FABIO, Number.NaN)),
    'categoría inválida': await rechazo(() => gasto(FABIO, 100, { categoryId: 'no-existe' })),
    'cobrador carga a otro': await rechazo(() => gasto(FABIO, 100, { collectorId: CARLOS.id })),
    'cobrador paga con la caja de la ruta': await rechazo(() => createExpense({ actor: FABIO, tenantId: T, scope: 'ruta', routeId: R1, categoryId: CAT_COMBUSTIBLE, valor: 100 })),
    'ruta inexistente': await rechazo(() => gasto(FABIO, 100, { routeId: 'r-no-existe' })),
    'operationId vacío': await rechazo(() => gasto(FABIO, 100, { operationId: '   ' })),
  }
  for (const [k, v] of Object.entries(casos)) metric(k, v)
  assert(Object.values(casos).every(v => v !== 'ACEPTADO'), 'se aceptó un gasto inválido')
  assert(await nGastos() === 0, 'quedó un gasto escrito')
})

await spec('EXP-CASH-014', 'pantallas: el formulario envía un id de operación estable y «Mi efectivo» señala el negativo', async () => {
  const form = src('src/pages/collector/CollectorExpensesPage.tsx')
  const caja = src('src/pages/collector/CollectorCashClosePage.tsx')
  const servicio = src('src/services/expenseService.ts')
  metric('formulario reutiliza operationId', /operationId: operacion\.current/.test(form))
  metric('Mi efectivo avisa del negativo', /ciclo\.esperado < 0/.test(caja))
  assert(/operationId: operacion\.current/.test(form), 'el formulario no envía un id de operación estable')
  assert(/ciclo\.esperado < 0/.test(caja), '«Mi efectivo» no señala el saldo negativo')
  assert(!/supera el efectivo en manos/.test(servicio), 'el servicio conserva el bloqueo por efectivo en manos')
})

// ============================================================
// Informe
// ============================================================
console.log('\n════════════════════════════════════════════════════════════════')
console.log('  RUTACASH · GASTOS DEL COBRADOR Y EFECTIVO EN MANOS')
console.log('════════════════════════════════════════════════════════════════')
for (const r of results) {
  console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id}  ${r.desc}`)
  for (const m of r.metrics) console.log(`          · ${m}`)
  if (r.error) console.log(`          ✗ ${r.error}`)
}
const fallidos = results.filter(r => !r.passed).length
console.log(`\n  ${results.length - fallidos}/${results.length} casos OK`)
if (fallidos > 0) process.exit(1)
