// ============================================================
// ADEX — SUITE GASTOS ADMINISTRATIVOS EN LA BOLSA (Ronda 2/6, DEXIE REAL)
// ------------------------------------------------------------
//   npm run test:adminexpense
//
// Decisión aprobada: UNA bolsa por Administrador para distribuir capital y pagar
// sus gastos. D9 (históricos intactos), D10 (gasto del SuperAdmin → bolsa de la
// empresa), D11 (el SuperAdmin carga un gasto a la bolsa de un Admin), D12 (sin
// ingresos arbitrarios; anulación y reintegro enlazados).
//
// Cada caso comprueba saldo anterior → movimiento → saldo posterior y los
// invariantes de conservación (`verifyCapitalInvariants`).
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import { today } from '../src/lib/formatters'
import { adminCapital, computeCapitalStructure, verifyCapitalInvariants } from '../src/lib/capitalAllocation'
import {
  allocateCapitalToAdmin, loadCapitalRows, registerCompanyCapital, returnCapitalFromAdmin, setRouteCapitalController,
  getCompanyAvailableCapital,
} from '../src/services/capitalControlService'
import { registerCapital, registerWithdrawal } from '../src/services/routeFundsService'
import { assignBaseToWorker } from '../src/services/cashCustodyService'
import { personalCashPosition } from '../src/services/cashSettlementService'
import {
  createExpense, refundAdminExpense, reverseAdminExpense, listVisibleExpenses, type CreateExpenseParams,
} from '../src/services/expenseService'
import { buildGastosReport } from '../src/services/reportService'
import type { Expense, Route, User } from '../src/models/types'
import * as fs from 'node:fs'

// ============================================================
// Mini-runner (mismo formato que las otras suites)
// ============================================================
interface Result { id: string; group: string; desc: string; passed: boolean; error?: string; metrics: string[] }
const results: Result[] = []
let current: string[] = []
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg) }
function metric(label: string, value: unknown) { current.push(`${label}: ${String(value)}`) }
async function spec(id: string, group: string, desc: string, fn: () => Promise<void> | void) {
  current = []
  let passed = true
  let error: string | undefined
  try { await fn() } catch (e) { passed = false; error = e instanceof Error ? e.message : String(e) }
  results.push({ id, group, desc, passed, error, metrics: [...current] })
}
async function rechazo(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'ACEPTADO' } catch (e) { return e instanceof Error ? e.message : String(e) }
}
const src = (p: string) => fs.readFileSync(p, 'utf8')

// ============================================================
// Escenario
// ============================================================
const T = 't-adex'
const TB = 't-ajena'
const R1 = 'r-ruta1'
const R2 = 'r-ruta2'
const R3 = 'r-ruta3'
const RB = 'r-ajena'
const CASCO = 'cat-cascos'
const COMB = 'cat-combustible'
const CAT_B = 'cat-ajena'

const persona = (id: string, nombre: string, rol: User['rol'], rutas: string[], extra: Partial<User> = {}, tenantId = T): User => ({
  id, tenantId, nombre, email: `${id}@adex.co`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...extra,
} as User)
const SA = persona('u-sa', 'Sara SuperAdmin', 'superadmin', [])
const ANA = persona('u-ana', 'Ana Admin', 'admin', [R1, R2])
const BETO = persona('u-beto', 'Beto Admin', 'admin', [R3])
const CARLOS = persona('u-carlos', 'Carlos Admin', 'admin', [R1])   // secundario en Ruta 1
const INACTIVO = persona('u-ina', 'Iván Inactivo', 'admin', [], { status: 'inactivo' } as Partial<User>)
const LAURA = persona('u-laura', 'Laura Supervisora', 'supervisor', [R1])
const FABIO = persona('u-fabio', 'Fabio Cobrador', 'cobrador', [R1])
const SOCIO = persona('u-socio', 'Hernán Socio', 'socio', [R1])
const AJENO = persona('u-ajeno', 'Ana Ajena', 'admin', [RB], {}, TB)
const ADMINS = [ANA.id, BETO.id, CARLOS.id, INACTIVO.id]

const ruta = (id: string, nombre: string, ctl?: string, tenantId = T): Route => ({
  id, tenantId, nombre, codigo: id, status: 'activa', capitalInicial: 0, capitalActual: 0, tasaInteres: 20,
  tasaLibre: false, montoMaximoPrestamo: 0, createdAt: '2026-09-01', updatedAt: '2026-09-01', capitalControllerAdminId: ctl,
} as Route)

async function empresa(opts: { deposito?: number; ana?: number; beto?: number } = {}) {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.bulkAdd([
    { id: T, nombre: 'ADEX', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z', baseCustodyStartAt: '2026-01-01T00:00:00.000Z' },
    { id: TB, nombre: 'Ajena', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z', baseCustodyStartAt: '2026-01-01T00:00:00.000Z' },
  ] as never[])
  await db.routes.bulkAdd([ruta(R1, 'Ruta 1', ANA.id), ruta(R2, 'Ruta 2', ANA.id), ruta(R3, 'Ruta 3', BETO.id), ruta(RB, 'Ajena', AJENO.id, TB)])
  await db.users.bulkAdd([SA, ANA, BETO, CARLOS, INACTIVO, LAURA, FABIO, SOCIO, AJENO])
  await db.expenseCategories.bulkAdd([
    { id: CASCO, tenantId: T, nombre: 'Cascos', activa: true },
    { id: COMB, tenantId: T, nombre: 'Combustible', activa: true },
    { id: CAT_B, tenantId: TB, nombre: 'Ajena', activa: true },
  ])
  await registerCompanyCapital({ actor: SA, tenantId: T, amount: opts.deposito ?? 100_000 })
  if ((opts.ana ?? 20_000) > 0) await allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: ANA.id, amount: opts.ana ?? 20_000 })
  if ((opts.beto ?? 10_000) > 0) await allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: BETO.id, amount: opts.beto ?? 10_000 })
}

const rows = () => loadCapitalRows(T, db as never)
async function bolsa(adminId: string) { return adminCapital(adminId, await rows()) }
async function emp() { return computeCapitalStructure(await rows(), ADMINS).company }
async function invariantes() {
  const issues = verifyCapitalInvariants(await rows(), ADMINS)
  assert(issues.length === 0, `invariantes rotos: ${issues.join(' | ')}`)
}
const money = (n: number) => `R$ ${n.toLocaleString('es-CO')}`

/** Gasto administrativo con la bolsa explícita. */
type Bolsa = CreateExpenseParams['funding']
const gasto = (actor: User, valor: number, funding: Bolsa, extra: Partial<CreateExpenseParams> = {}) =>
  createExpense({ actor, tenantId: T, scope: 'empresa', categoryId: CASCO, valor, descripcion: 'Compra administrativa', funding, ...extra })
const deAna = (valor: number, extra: Partial<CreateExpenseParams> = {}) => gasto(ANA, valor, { source: 'admin', adminId: ANA.id }, extra)
const gastosCount = () => db.expenses.count()

// ############################################################
// A — FÓRMULA DE LA BOLSA (ejemplo obligatorio)
// ############################################################
const GA = 'A · Bolsa del Administrador con gastos'

await spec('ADM-EXP-001', GA, 'ejemplo R$ 20.000: 20.000 → 15.000 → 12.000 → 11.600 → 11.450 → 12.450', async () => {
  await empresa()
  const pasos: [string, number][] = []
  const paso = async (k: string) => { const d = (await bolsa(ANA.id)).disponible; pasos.push([k, d]); metric(k, money(d)) }
  await paso('SA asigna 20.000')
  await registerCapital({ actor: ANA, tenantId: T, routeId: R1, valor: 5_000 }); await paso('coloca 5.000 en Ruta 1')
  await registerCapital({ actor: ANA, tenantId: T, routeId: R2, valor: 3_000 }); await paso('coloca 3.000 en Ruta 2')
  await deAna(400, { categoryId: CASCO, descripcion: 'Cascos' }); await paso('cascos 400')
  await deAna(150, { categoryId: COMB, descripcion: 'Combustible' }); await paso('combustible 150')
  await registerWithdrawal({ actor: ANA, tenantId: T, routeId: R1, valor: 1_000 }); await paso('Ruta 1 devuelve 1.000')
  assert(JSON.stringify(pasos.map(p => p[1])) === JSON.stringify([20_000, 15_000, 12_000, 11_600, 11_450, 12_450]), 'la secuencia del disponible no es la del ejemplo')
  const b = await bolsa(ANA.id)
  metric('disponible / en rutas / gastos / recibido', `${money(b.disponible)} / ${money(b.enRutas)} / ${money(b.gastos)} / ${money(b.asignadoPorEmpresa)}`)
  assert(b.enRutas === 7_000 && b.gastos === 550 && b.asignadoPorEmpresa === 20_000, 'en rutas o gastos no cuadran')
  assert(b.disponible + b.enRutas + b.gastos === 20_000, 'total conciliado ≠ 20.000')
  await invariantes()
})

await spec('ADM-EXP-002', GA, 'gasto superior al disponible: rechazo sin escritura; igual al disponible: aceptado', async () => {
  await empresa({ ana: 1_000 })
  const n = await gastosCount()
  const r = await rechazo(() => deAna(1_001))
  metric('1.001 con 1.000', r)
  assert(r !== 'ACEPTADO' && await gastosCount() === n && (await bolsa(ANA.id)).disponible === 1_000, 'escribió o descontó')
  await deAna(1_000)
  assert((await bolsa(ANA.id)).disponible === 0, 'no aceptó el gasto exacto')
  const r2 = await rechazo(() => deAna(1))
  assert(r2 !== 'ACEPTADO', 'gastó con disponible 0')
  await invariantes()
})

await spec('ADM-EXP-003', GA, 'capital colocado en rutas no se puede gastar', async () => {
  await empresa({ ana: 5_000 })
  await registerCapital({ actor: ANA, tenantId: T, routeId: R1, valor: 5_000 })
  const r = await rechazo(() => deAna(1))
  metric('gasto con todo en rutas', r)
  assert(r !== 'ACEPTADO', 'gastó capital ya colocado')
  await invariantes()
})

await spec('ADM-EXP-004', GA, 'colocar capital después de un gasto usa el disponible ya reducido', async () => {
  await empresa({ ana: 1_000 })
  await deAna(600)
  const r = await rechazo(() => registerCapital({ actor: ANA, tenantId: T, routeId: R1, valor: 401 }))
  metric('colocar 401 con 400', r)
  assert(r !== 'ACEPTADO', 'colocó dinero ya gastado')
  await registerCapital({ actor: ANA, tenantId: T, routeId: R1, valor: 400 })
  assert((await bolsa(ANA.id)).disponible === 0, 'disponible incorrecto')
  // Devolver al SuperAdmin tampoco puede usar lo gastado.
  const dev = await rechazo(() => returnCapitalFromAdmin({ actor: SA, tenantId: T, adminId: ANA.id, amount: 1 }))
  assert(dev !== 'ACEPTADO', 'devolvió al SuperAdmin dinero gastado')
  await invariantes()
})

// ############################################################
// B — QUIÉN PAGA (D10, D11)
// ############################################################
const GB = 'B · Bolsa financiadora y permisos'

await spec('ADM-EXP-005', GB, 'D11: el SuperAdmin carga un gasto a la bolsa de Ana (solo la de Ana)', async () => {
  await empresa()
  const [a0, b0, e0] = [await bolsa(ANA.id), await bolsa(BETO.id), await emp()]
  const g = await gasto(SA, 300, { source: 'admin', adminId: ANA.id }, { descripcion: 'Maletines para Ana' })
  const [a1, b1, e1] = [await bolsa(ANA.id), await bolsa(BETO.id), await emp()]
  metric('Ana', `${money(a0.disponible)} → ${money(a1.disponible)}`)
  metric('Beto / empresa', `${money(b1.disponible)} / ${money(e1.disponible)}`)
  metric('registró / bolsa', `${g.userId} / ${g.funding}:${g.fundingAdminId}`)
  assert(a1.disponible === a0.disponible - 300 && b1.disponible === b0.disponible && e1.disponible === e0.disponible, 'afectó otra bolsa')
  assert(g.userId === SA.id && g.funding === 'admin' && g.fundingAdminId === ANA.id && !!g.id && !!g.createdAt, 'registro incompleto')
  const inactivo = await rechazo(() => gasto(SA, 1, { source: 'admin', adminId: INACTIVO.id }))
  const noAdmin = await rechazo(() => gasto(SA, 1, { source: 'admin', adminId: LAURA.id }))
  const ajeno = await rechazo(() => gasto(SA, 1, { source: 'admin', adminId: AJENO.id }))
  metric('inactivo / no admin / otra empresa', `${inactivo} / ${noAdmin} / ${ajeno}`)
  assert([inactivo, noAdmin, ajeno].every(r => r !== 'ACEPTADO'), 'aceptó una bolsa no válida')
  await invariantes()
})

await spec('ADM-EXP-006', GB, 'un Administrador no carga gastos a bolsas ajenas ni a la de la empresa', async () => {
  await empresa()
  const n = await gastosCount()
  const otro = await rechazo(() => gasto(ANA, 100, { source: 'admin', adminId: BETO.id }))
  const empresaBolsa = await rechazo(() => gasto(ANA, 100, { source: 'empresa' }))
  const sinBolsa = await rechazo(() => createExpense({ actor: ANA, tenantId: T, scope: 'empresa', categoryId: CASCO, valor: 100, descripcion: 'x sin bolsa' }))
  const sup = await rechazo(() => gasto(LAURA, 100, { source: 'admin', adminId: ANA.id }))
  const cob = await rechazo(() => gasto(FABIO, 100, { source: 'admin', adminId: ANA.id }))
  const soc = await rechazo(() => gasto(SOCIO, 100, { source: 'admin', adminId: ANA.id }))
  for (const [k, v] of Object.entries({ otro, empresaBolsa, sinBolsa, sup, cob, soc })) metric(k, v)
  assert([otro, empresaBolsa, sinBolsa, sup, cob, soc].every(r => r !== 'ACEPTADO'), 'se aceptó un cargo no autorizado')
  assert(await gastosCount() === n && (await bolsa(BETO.id)).disponible === 10_000, 'quedó una escritura')
  await invariantes()
})

await spec('ADM-EXP-007', GB, 'D10: el gasto del SuperAdmin reduce solo la bolsa de la empresa (sin tocar lo asignado)', async () => {
  await empresa({ deposito: 50_000, ana: 20_000, beto: 10_000 })
  const [e0, a0, b0] = [await emp(), await bolsa(ANA.id), await bolsa(BETO.id)]
  await gasto(SA, 2_000, { source: 'empresa' }, { descripcion: 'Software de la empresa' })
  const [e1, a1, b1] = [await emp(), await bolsa(ANA.id), await bolsa(BETO.id)]
  metric('empresa', `${money(e0.disponible)} → ${money(e1.disponible)}`)
  assert(e1.disponible === e0.disponible - 2_000 && a1.disponible === a0.disponible && b1.disponible === b0.disponible, 'afectó bolsas de Administradores')
  assert(await getCompanyAvailableCapital(T) === e1.disponible, 'el disponible de la empresa del servicio no coincide')
  // Lo asignado a Administradores (30.000) no es gastable por la empresa.
  const r = await rechazo(() => gasto(SA, e1.disponible + 1, { source: 'empresa' }))
  metric('gastar más que el disponible de la empresa', r)
  assert(r !== 'ACEPTADO', 'gastó dinero asignado a Administradores')
  await invariantes()
})

await spec('ADM-EXP-008', GB, 'dos Administradores mantienen bolsas independientes', async () => {
  await empresa()
  await deAna(500)
  await gasto(BETO, 700, { source: 'admin', adminId: BETO.id })
  await registerCapital({ actor: BETO, tenantId: T, routeId: R3, valor: 1_000 })
  const [a, b] = [await bolsa(ANA.id), await bolsa(BETO.id)]
  metric('Ana / Beto', `${money(a.disponible)} (gastos ${money(a.gastos)}) / ${money(b.disponible)} (gastos ${money(b.gastos)})`)
  assert(a.disponible === 19_500 && a.gastos === 500 && b.disponible === 8_300 && b.gastos === 700, 'las bolsas se mezclaron')
  await invariantes()
})

await spec('ADM-EXP-009', GB, 'cambio de responsable de una ruta: el capital viaja, los gastos NO', async () => {
  await empresa()
  await registerCapital({ actor: ANA, tenantId: T, routeId: R1, valor: 4_000 })
  await deAna(300)
  await allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: CARLOS.id, amount: 1_000 })
  const a0 = await bolsa(ANA.id)
  await setRouteCapitalController({ actor: SA, tenantId: T, routeId: R1, adminId: CARLOS.id, motivo: 'Reasignación' })
  const [a1, c1] = [await bolsa(ANA.id), await bolsa(CARLOS.id)]
  metric('Ana gastos / en rutas', `${money(a0.gastos)} / ${money(a0.enRutas)} → ${money(a1.gastos)} / ${money(a1.enRutas)}`)
  metric('Carlos gastos / en rutas', `${money(c1.gastos)} / ${money(c1.enRutas)}`)
  assert(a1.gastos === 300 && c1.gastos === 0 && a1.disponible === a0.disponible && c1.enRutas === 4_000 && a1.enRutas === 0, 'los gastos cambiaron de bolsa')
  await invariantes()
})

// ############################################################
// C — HISTÓRICOS (D9)
// ############################################################
const GC = 'C · Históricos sin imputación'

await spec('ADM-EXP-010', GC, 'gasto de empresa histórico (sin bolsa) no afecta bolsas; el nuevo sí', async () => {
  await empresa()
  const historico: Expense = {
    id: 'hist-1', tenantId: T, scope: 'empresa', categoryId: CASCO, valor: 9_999, descripcion: 'Histórico 2026-09',
    fecha: '2026-09-15', userId: ANA.id, syncStatus: 'synced', createdAt: '2026-09-15T10:00:00.000Z',
  }
  const legacySinScope: Expense = { ...historico, id: 'hist-2', scope: undefined, valor: 777, fecha: today(), createdAt: new Date().toISOString() }
  await db.expenses.bulkAdd([historico, legacySinScope])
  const [a0, e0] = [await bolsa(ANA.id), await emp()]
  metric('Ana / empresa con históricos', `${money(a0.disponible)} / ${money(e0.disponible)}`)
  assert(a0.disponible === 20_000 && a0.gastos === 0 && e0.disponible === 70_000, 'un histórico entró en la fórmula')
  await deAna(250)
  assert((await bolsa(ANA.id)).disponible === 19_750, 'el gasto nuevo no se imputó')
  const intactos = await db.expenses.bulkGet(['hist-1', 'hist-2'])
  metric('históricos tras operar', intactos.map(h => `${h!.valor}:${h!.funding ?? 'sin bolsa'}`).join(', '))
  assert(intactos.every(h => h && !h.funding && !h.fundingAdminId && !h.reversalId) && intactos[0]!.valor === 9_999 && intactos[1]!.valor === 777, 'se alteró un histórico')
  const anularHist = await rechazo(() => reverseAdminExpense({ actor: SA, tenantId: T, expenseId: 'hist-1', reason: 'probar' }))
  metric('anular histórico', anularHist)
  assert(anularHist !== 'ACEPTADO', 'se corrigió un histórico sin bolsa')
  await invariantes()
})

// ############################################################
// D — CORRECCIÓN: ANULACIÓN Y REINTEGRO (D12)
// ############################################################
const GD = 'D · Anulación y reintegro'

await spec('ADM-EXP-011', GD, 'anulación autorizada revierte una sola vez (también en paralelo)', async () => {
  await empresa()
  const g = await deAna(400)
  const d0 = (await bolsa(ANA.id)).disponible
  const [x, y] = await Promise.allSettled([
    reverseAdminExpense({ actor: ANA, tenantId: T, expenseId: g.id, reason: 'Factura duplicada' }),
    reverseAdminExpense({ actor: ANA, tenantId: T, expenseId: g.id, reason: 'Factura duplicada' }),
  ])
  const ok = [x, y].filter(r => r.status === 'fulfilled').length
  const d1 = (await bolsa(ANA.id)).disponible
  const original = await db.expenses.get(g.id)
  const reversiones = (await db.expenses.toArray()).filter(e => e.reversesId === g.id)
  metric('anulaciones aceptadas en paralelo', ok)
  metric('disponible', `${money(d0)} → ${money(d1)}`)
  assert(ok === 1 && d1 === d0 + 400 && reversiones.length === 1, 'la anulación se duplicó o no revirtió')
  assert(original?.reversalId === reversiones[0].id && original.reversedByUserId === ANA.id && !!original.reversedAt && original.reversalReason === 'Factura duplicada', 'el original no conserva el vínculo')
  assert(reversiones[0].valor === -400 && reversiones[0].fundingAdminId === ANA.id && reversiones[0].userId === ANA.id, 'la reversión no es un espejo de la misma bolsa')
  const otra = await rechazo(() => reverseAdminExpense({ actor: ANA, tenantId: T, expenseId: g.id, reason: 'otra vez' }))
  const deReversion = await rechazo(() => reverseAdminExpense({ actor: ANA, tenantId: T, expenseId: reversiones[0].id, reason: 'x' }))
  const g10 = await deAna(10)
  const sinMotivo = await rechazo(() => reverseAdminExpense({ actor: ANA, tenantId: T, expenseId: g10.id, reason: '  ' }))
  metric('segunda / de reversión / sin motivo', `${otra} / ${deReversion} / ${sinMotivo}`)
  assert([otra, deReversion, sinMotivo].every(r => r !== 'ACEPTADO'), 'anulación indebida aceptada')
  await invariantes()
})

await spec('ADM-EXP-012', GD, 'reintegro parcial enlazado; tope; idempotente; no anula después', async () => {
  await empresa()
  const g = await deAna(400)
  const d0 = (await bolsa(ANA.id)).disponible
  const r1 = await refundAdminExpense({ actor: ANA, tenantId: T, expenseId: g.id, amount: 150, reason: 'Proveedor devolvió un casco', operationId: 'op-reint-1' })
  const r1b = await refundAdminExpense({ actor: ANA, tenantId: T, expenseId: g.id, amount: 150, reason: 'Proveedor devolvió un casco', operationId: 'op-reint-1' })
  const d1 = (await bolsa(ANA.id)).disponible
  metric('disponible', `${money(d0)} → ${money(d1)}`)
  assert(r1.id === r1b.id && d1 === d0 + 150 && r1.refundsExpenseId === g.id && r1.valor === -150, 'reintegro no enlazado o duplicado')
  const exceso = await rechazo(() => refundAdminExpense({ actor: ANA, tenantId: T, expenseId: g.id, amount: 251, reason: 'demasiado' }))
  const anular = await rechazo(() => reverseAdminExpense({ actor: ANA, tenantId: T, expenseId: g.id, reason: 'ya tiene reintegro' }))
  const deReintegro = await rechazo(() => reverseAdminExpense({ actor: ANA, tenantId: T, expenseId: r1.id, reason: 'x' }))
  metric('exceso / anular con reintegro / anular reintegro', `${exceso} / ${anular} / ${deReintegro}`)
  assert([exceso, anular, deReintegro].every(r => r !== 'ACEPTADO'), 'corrección indebida aceptada')
  await refundAdminExpense({ actor: ANA, tenantId: T, expenseId: g.id, amount: 250, reason: 'resto devuelto' })
  assert((await bolsa(ANA.id)).disponible === d0 + 400, 'reintegro total incorrecto')
  // Un gasto anulado no admite reintegro.
  const g2 = await deAna(100)
  await reverseAdminExpense({ actor: ANA, tenantId: T, expenseId: g2.id, reason: 'error' })
  const sobreAnulado = await rechazo(() => refundAdminExpense({ actor: ANA, tenantId: T, expenseId: g2.id, amount: 10, reason: 'x' }))
  assert(sobreAnulado !== 'ACEPTADO', 'reintegró un gasto anulado')
  await invariantes()
})

await spec('ADM-EXP-013', GD, 'corregir: solo con permiso y sobre la bolsa propia (SuperAdmin: todas)', async () => {
  await empresa()
  const g = await deAna(400)
  const gEmp = await gasto(SA, 500, { source: 'empresa' })
  const intentos = {
    'Beto anula el de Ana': await rechazo(() => reverseAdminExpense({ actor: BETO, tenantId: T, expenseId: g.id, reason: 'x' })),
    'Ana anula el de la empresa': await rechazo(() => reverseAdminExpense({ actor: ANA, tenantId: T, expenseId: gEmp.id, reason: 'x' })),
    'Supervisor anula': await rechazo(() => reverseAdminExpense({ actor: LAURA, tenantId: T, expenseId: g.id, reason: 'x' })),
    'Cobrador reintegra': await rechazo(() => refundAdminExpense({ actor: FABIO, tenantId: T, expenseId: g.id, amount: 1, reason: 'x' })),
    'otra empresa': await rechazo(() => reverseAdminExpense({ actor: AJENO, tenantId: T, expenseId: g.id, reason: 'x' })),
  }
  for (const [k, v] of Object.entries(intentos)) metric(k, v)
  assert(Object.values(intentos).every(r => r !== 'ACEPTADO'), 'corrección no autorizada aceptada')
  await reverseAdminExpense({ actor: SA, tenantId: T, expenseId: g.id, reason: 'SuperAdmin corrige' })
  assert((await bolsa(ANA.id)).gastos === 0, 'el SuperAdmin no pudo corregir')
  // Gasto de RUTA: fuera de este procedimiento (no se reinterpreta aquí).
  await registerCapital({ actor: ANA, tenantId: T, routeId: R1, valor: 1_000 })
  const deRuta = await createExpense({ actor: ANA, tenantId: T, scope: 'ruta', routeId: R1, categoryId: COMB, valor: 50, descripcion: 'Ruta' })
  const anularRuta = await rechazo(() => reverseAdminExpense({ actor: ANA, tenantId: T, expenseId: deRuta.id, reason: 'x' }))
  metric('anular gasto de ruta por esta vía', anularRuta)
  assert(anularRuta !== 'ACEPTADO', 'corrigió un gasto de ruta como administrativo')
  await invariantes()
})

// ############################################################
// E — IDEMPOTENCIA Y CONCURRENCIA
// ############################################################
const GE = 'E · Duplicados y concurrencia'

await spec('ADM-EXP-014', GE, 'reintento del mismo gasto (mismo operationId) no lo duplica; datos distintos se rechazan', async () => {
  await empresa()
  const a = await deAna(400, { operationId: 'op-gasto-1' })
  const b = await deAna(400, { operationId: 'op-gasto-1' })
  const [c, d] = await Promise.all([deAna(400, { operationId: 'op-gasto-2' }), deAna(400, { operationId: 'op-gasto-2' })])
  const distinto = await rechazo(() => deAna(999, { operationId: 'op-gasto-1' }))
  metric('gastos guardados', await gastosCount())
  assert(a.id === b.id && c.id === d.id && await gastosCount() === 2 && (await bolsa(ANA.id)).gastos === 800, 'se duplicó un gasto')
  assert(distinto !== 'ACEPTADO', 'reutilizó un operationId con otros datos')
  await invariantes()
})

await spec('ADM-EXP-015', GE, 'doble clic en asignar, colocar y retirar: una sola operación', async () => {
  await empresa()
  const e0 = await emp()
  const [a1, a2] = await Promise.all([
    allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: ANA.id, amount: 5_000, operationId: 'op-asig' }),
    allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: ANA.id, amount: 5_000, operationId: 'op-asig' }),
  ])
  const a3 = await allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: ANA.id, amount: 5_000, operationId: 'op-asig' })
  const [c1, c2] = await Promise.all([
    registerCapital({ actor: ANA, tenantId: T, routeId: R1, valor: 2_000, operationId: 'op-col' }),
    registerCapital({ actor: ANA, tenantId: T, routeId: R1, valor: 2_000, operationId: 'op-col' }),
  ])
  const [w1, w2] = await Promise.all([
    registerWithdrawal({ actor: ANA, tenantId: T, routeId: R1, valor: 500, operationId: 'op-ret' }),
    registerWithdrawal({ actor: ANA, tenantId: T, routeId: R1, valor: 500, operationId: 'op-ret' }),
  ])
  const b = await bolsa(ANA.id)
  metric('asignaciones / colocaciones / retiros', `${await db.capitalLedger.where('toAdminId').equals(ANA.id).count()} / ${await db.capitalMovements.count()} / ${await db.withdrawals.count()}`)
  metric('Ana disponible / en rutas', `${money(b.disponible)} / ${money(b.enRutas)}`)
  assert(a1.id === a2.id && a2.id === a3.id && c1.id === c2.id && w1.id === w2.id, 'no devolvió la misma operación')
  assert(b.asignadoPorEmpresa === 25_000 && b.enRutas === 1_500 && b.disponible === 23_500 && (await emp()).disponible === e0.disponible - 5_000, 'se duplicó capital')
  const cruzado = await rechazo(() => registerCapital({ actor: ANA, tenantId: T, routeId: R2, valor: 2_000, operationId: 'op-col' }))
  assert(cruzado !== 'ACEPTADO', 'reutilizó un operationId de colocación con otros datos')
  await invariantes()
})

await spec('ADM-EXP-016', GE, 'gasto y colocación concurrentes no consumen dos veces el mismo dinero; nunca negativo', async () => {
  await empresa({ ana: 1_000 })
  const rs = await Promise.allSettled([
    deAna(700),
    registerCapital({ actor: ANA, tenantId: T, routeId: R1, valor: 700 }),
  ])
  const ok = rs.filter(r => r.status === 'fulfilled').length
  const b = await bolsa(ANA.id)
  metric('aceptadas / disponible', `${ok} / ${money(b.disponible)}`)
  assert(ok === 1 && b.disponible === 300, 'se gastó dos veces el mismo dinero')
  // Ráfaga de 6 gastos de 100 con 300 disponibles: exactamente 3.
  const rafaga = await Promise.allSettled(Array.from({ length: 6 }, () => deAna(100)))
  const b2 = await bolsa(ANA.id)
  metric('ráfaga aceptada / disponible final', `${rafaga.filter(r => r.status === 'fulfilled').length} / ${money(b2.disponible)}`)
  assert(rafaga.filter(r => r.status === 'fulfilled').length === 3 && b2.disponible === 0, 'la ráfaga dejó saldo negativo o perdió gastos')
  await invariantes()
})

// ############################################################
// F — VISIBILIDAD
// ############################################################
const GF = 'F · Visibilidad entre Administradores'

await spec('ADM-EXP-017', GF, 'cada Admin ve solo los gastos de su bolsa; el SuperAdmin todos; operativos ninguno', async () => {
  await empresa()
  await deAna(100, { descripcion: 'Gasto de Ana' })
  await gasto(BETO, 200, { source: 'admin', adminId: BETO.id }, { descripcion: 'Gasto de Beto' })
  await gasto(SA, 300, { source: 'empresa' }, { descripcion: 'Gasto de empresa' })
  await gasto(SA, 50, { source: 'admin', adminId: ANA.id }, { descripcion: 'SA para Ana' })
  await db.expenses.add({ id: 'hist-beto', tenantId: T, scope: 'empresa', categoryId: CASCO, valor: 40, descripcion: 'Histórico de Beto', fecha: '2026-09-01', userId: BETO.id, syncStatus: 'synced', createdAt: '2026-09-01T00:00:00.000Z' })
  const ve = async (u: User) => (await listVisibleExpenses({ actor: u, tenantId: T })).filter(e => !e.routeId).map(e => e.descripcion).sort().join(' | ') || '(ninguno)'
  const v = { ana: await ve(ANA), beto: await ve(BETO), carlos: await ve(CARLOS), sa: await ve(SA), laura: await ve(LAURA), fabio: await ve(FABIO), ajeno: (await listVisibleExpenses({ actor: AJENO, tenantId: T })).length }
  for (const [k, x] of Object.entries(v)) metric(k, x)
  assert(v.ana === 'Gasto de Ana | SA para Ana', 'Ana ve gastos ajenos')
  assert(v.beto === 'Gasto de Beto | Histórico de Beto', 'Beto ve gastos ajenos o pierde su histórico')
  assert(v.carlos === '(ninguno)' && v.laura === '(ninguno)' && v.fabio === '(ninguno)' && v.ajeno === 0, 'exposición a terceros')
  assert(v.sa.split(' | ').length === 5, 'el SuperAdmin no ve todos')
  // Reporte de Gastos (export): mismas fuentes visibles → mismas filas.
  const filas = buildGastosReport({ expenses: await listVisibleExpenses({ actor: ANA, tenantId: T }), routes: [], categories: [], users: [] } as never,
    { routeIds: new Set([R1, R2]), fechaDesde: '2000-01-01', fechaHasta: '2999-12-31', includeCompanyExpenses: true })
  metric('reporte de Ana', filas.map(f => f['Descripción']).join(' | '))
  assert(filas.length === 2 && filas.every(f => /Ana/.test(String(f['Descripción']))), 'el reporte expone gastos de otros')
  const paginas = [src('src/pages/admin/ExpensesPage.tsx'), src('src/pages/admin/ReportsPage.tsx')]
  assert(paginas.every(p => /listVisibleExpenses\(/.test(p) && !/db\.expenses\.where\('tenantId'\)/.test(p)), 'una pantalla lee gastos sin el filtro de visibilidad')
})

// ############################################################
// G — REGRESIONES OPERATIVAS Y CONSERVACIÓN
// ############################################################
const GG = 'G · Regresiones y conservación'

await spec('ADM-EXP-018', GG, 'gastos de ruta y de trabajador conservan sus reglas; cuadres intactos', async () => {
  await empresa()
  await registerCapital({ actor: ANA, tenantId: T, routeId: R1, valor: 3_000 })
  await assignBaseToWorker({ actor: ANA, tenantId: T, routeId: R1, recipientUserId: FABIO.id, amount: 1_000, motivo: 'Base' })
  await deAna(500)
  const pos0 = (await personalCashPosition({ tenantId: T, routeId: R1, userId: FABIO.id, hasta: new Date().toISOString() })).esperado
  // Ruta: tope = disponible de la ruta (2.000), no la bolsa.
  const rutaExceso = await rechazo(() => createExpense({ actor: ANA, tenantId: T, scope: 'ruta', routeId: R1, categoryId: COMB, valor: 2_001 }))
  // Trabajador: puede quedar negativo (regla 2026-10-08).
  await createExpense({ actor: ANA, tenantId: T, scope: 'trabajador', routeId: R1, collectorId: FABIO.id, categoryId: COMB, valor: 1_500 })
  const pos1 = (await personalCashPosition({ tenantId: T, routeId: R1, userId: FABIO.id, hasta: new Date().toISOString() })).esperado
  const b = await bolsa(ANA.id)
  metric('ruta 2.001 con 2.000', rutaExceso)
  metric('Fabio', `${money(pos0)} → ${money(pos1)}`)
  metric('bolsa de Ana (gastos de ruta/trabajador no la tocan)', `${money(b.disponible)} · gastos ${money(b.gastos)}`)
  assert(rutaExceso !== 'ACEPTADO' && pos0 === 1_000 && pos1 === -500 && b.gastos === 500 && b.disponible === 16_500, 'se alteró una regla existente')
  await invariantes()
})

await spec('ADM-EXP-019', GG, 'conservación tras 80 operaciones mezcladas (empresa + bolsas + rutas + gastos + correcciones)', async () => {
  await empresa({ deposito: 200_000, ana: 50_000, beto: 30_000 })
  let seed = 7
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  const gastos: string[] = []
  let aceptadas = 0
  for (let i = 0; i < 80; i++) {
    const op = rnd(7)
    const v = 100 + rnd(5_000)
    const f = async () => {
      if (op === 0) return registerCapital({ actor: ANA, tenantId: T, routeId: rnd(2) ? R1 : R2, valor: v })
      if (op === 1) return registerWithdrawal({ actor: ANA, tenantId: T, routeId: rnd(2) ? R1 : R2, valor: v })
      if (op === 2) { const g = await deAna(v); gastos.push(g.id); return g }
      if (op === 3) return gasto(SA, v, { source: 'empresa' })
      if (op === 4) return gasto(BETO, v, { source: 'admin', adminId: BETO.id })
      if (op === 5 && gastos.length) return reverseAdminExpense({ actor: ANA, tenantId: T, expenseId: gastos[rnd(gastos.length)], reason: 'auditoría' })
      return refundAdminExpense({ actor: ANA, tenantId: T, expenseId: gastos[rnd(Math.max(1, gastos.length))] ?? 'x', amount: 1 + rnd(200), reason: 'reintegro' })
    }
    if (await rechazo(f) === 'ACEPTADO') aceptadas++
    const issues = verifyCapitalInvariants(await rows(), ADMINS)
    assert(issues.length === 0, `paso ${i}: ${issues.join(' | ')}`)
  }
  const e = await emp()
  const [a, b] = [await bolsa(ANA.id), await bolsa(BETO.id)]
  metric('operaciones aceptadas', `${aceptadas}/80`)
  metric('Ana disp / rutas / gastos', `${money(a.disponible)} / ${money(a.enRutas)} / ${money(a.gastos)}`)
  metric('empresa disp / gastos', `${money(e.disponible)} / ${money(e.gastos)}`)
  assert(a.disponible >= 0 && b.disponible >= 0 && e.disponible >= 0, 'saldo negativo')
  assert(e.depositos - e.retirosEmpresa + e.historicoPreV16 === e.total + e.gastos + a.gastos + b.gastos, 'conservación rota')
})

// ============================================================
// Informe
// ============================================================
console.log('\n════════════════════════════════════════════════════════════════')
console.log('  ADEX · GASTOS ADMINISTRATIVOS EN LA BOLSA (Ronda 2/6)')
console.log('════════════════════════════════════════════════════════════════')
let grupo = ''
for (const r of results) {
  if (r.group !== grupo) { grupo = r.group; console.log(`\n  ▌ ${grupo}`) }
  console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id}  ${r.desc}`)
  for (const m of r.metrics) console.log(`          · ${m}`)
  if (r.error) console.log(`          ✗ ${r.error}`)
}
const fallidos = results.filter(r => !r.passed).length
console.log(`\n  ${results.length - fallidos}/${results.length} casos OK`)
if (fallidos > 0) process.exit(1)
