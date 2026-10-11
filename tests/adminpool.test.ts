// ============================================================
// ADEX — SUITE CAJA PRINCIPAL DEL ADMINISTRADOR (Ronda 3/6, DEXIE REAL)
// ------------------------------------------------------------
//   npm run test:adminpool
//
// La Caja principal NO es otra bolsa: presenta el estado de cuenta que calcula
// `getAdminPoolStatement` sobre la fórmula oficial (`adminCapital`, Ronda 2/6).
// Se comprueba: cifras = fórmula oficial, conciliación sin diferencias (también
// con cambio de responsable), movimientos = registros reales, período ≠
// acumulado, históricos fuera, aislamiento y permisos, y que las pantallas no
// recalculan nada.
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import { adminCapital, verifyCapitalInvariants } from '../src/lib/capitalAllocation'
import { poolExpensesInPeriod } from '../src/lib/adminPoolStatement'
import {
  allocateCapitalToAdmin, getAdminPoolStatement, loadCapitalRows, registerCompanyCapital, returnCapitalFromAdmin, setRouteCapitalController,
} from '../src/services/capitalControlService'
import { registerCapital, registerTransfer, registerWithdrawal } from '../src/services/routeFundsService'
import { createExpense, refundAdminExpense, reverseAdminExpense, type CreateExpenseParams } from '../src/services/expenseService'
import { reverseCapitalMovement } from '../src/services/movementReversalService'
import type { Route, User } from '../src/models/types'
import * as fs from 'node:fs'

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

const T = 't-adex'
const R1 = 'r-ruta1'
const R2 = 'r-ruta2'
const R3 = 'r-ruta3'
const CASCO = 'cat-cascos'
const COMB = 'cat-combustible'
const persona = (id: string, nombre: string, rol: User['rol'], rutas: string[]): User => ({
  id, tenantId: T, nombre, email: `${id}@adex.co`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)
const SA = persona('u-sa', 'Sara SuperAdmin', 'superadmin', [])
const ANA = persona('u-ana', 'Ana Admin', 'admin', [R1, R2])
const BETO = persona('u-beto', 'Beto Admin', 'admin', [R3, R1])
const LAURA = persona('u-laura', 'Laura Supervisora', 'supervisor', [R1])
const FABIO = persona('u-fabio', 'Fabio Cobrador', 'cobrador', [R1])
const SOCIO = persona('u-socio', 'Hernán Socio', 'socio', [R1])
const ruta = (id: string, nombre: string, ctl: string): Route => ({
  id, tenantId: T, nombre, codigo: id, status: 'activa', capitalInicial: 0, capitalActual: 0, tasaInteres: 20,
  tasaLibre: false, montoMaximoPrestamo: 0, createdAt: '2026-09-01', updatedAt: '2026-09-01', capitalControllerAdminId: ctl,
} as Route)

async function empresa() {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.add({ id: T, nombre: 'ADEX', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z', baseCustodyStartAt: '2026-01-01T00:00:00.000Z' } as never)
  await db.routes.bulkAdd([ruta(R1, 'Ruta 1', ANA.id), ruta(R2, 'Ruta 2', ANA.id), ruta(R3, 'Ruta 3', BETO.id)])
  await db.users.bulkAdd([SA, ANA, BETO, LAURA, FABIO, SOCIO])
  await db.expenseCategories.bulkAdd([{ id: CASCO, tenantId: T, nombre: 'Cascos', activa: true }, { id: COMB, tenantId: T, nombre: 'Combustible', activa: true }])
  await registerCompanyCapital({ actor: SA, tenantId: T, amount: 100_000 })
  await allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: ANA.id, amount: 20_000 })
  await allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: BETO.id, amount: 10_000 })
}
const caja = (adminId = ANA.id, actor: User = ANA) => getAdminPoolStatement({ actor, tenantId: T, adminId })
const oficial = async (adminId = ANA.id) => adminCapital(adminId, await loadCapitalRows(T, db as never))
const gastoAna = (valor: number, extra: Partial<CreateExpenseParams> = {}) =>
  createExpense({ actor: ANA, tenantId: T, scope: 'empresa', categoryId: CASCO, valor, descripcion: 'Gasto administrativo', funding: { source: 'admin', adminId: ANA.id }, ...extra })
const money = (n: number) => `R$ ${n.toLocaleString('es-CO')}`

/** El estado de cuenta debe cuadrar y coincidir con la fórmula oficial. */
async function cuadra(adminId = ANA.id) {
  const s = await caja(adminId, SA)
  const o = await oficial(adminId)
  assert(JSON.stringify(s.capital) === JSON.stringify(o), 'la caja no usa la fórmula oficial')
  assert(s.conciliacion.diferencia === 0, `la conciliación no cuadra (${s.conciliacion.diferencia})`)
  const issues = verifyCapitalInvariants(await loadCapitalRows(T, db as never), [ANA.id, BETO.id])
  assert(issues.length === 0, `invariantes rotos: ${issues.join(' | ')}`)
  return s
}

const G = 'Caja principal'

await spec('POOL-001', G, 'al abrir: disponible, colocado, gastos y recibido = fórmula oficial (ejemplo R$ 20.000)', async () => {
  await empresa()
  await registerCapital({ actor: ANA, tenantId: T, routeId: R1, valor: 5_000 })
  await registerCapital({ actor: ANA, tenantId: T, routeId: R2, valor: 3_000 })
  await gastoAna(400, { categoryId: CASCO, descripcion: 'Cascos' })
  await gastoAna(150, { categoryId: COMB, descripcion: 'Combustible' })
  await registerWithdrawal({ actor: ANA, tenantId: T, routeId: R1, valor: 1_000 })
  const s = await cuadra()
  metric('disponible / en rutas / gastos / recibido', `${money(s.capital.disponible)} / ${money(s.capital.enRutas)} / ${money(s.capital.gastos)} / ${money(s.partidas.recibidoSA)}`)
  metric('conciliación', `${money(s.conciliacion.entradas)} = ${money(s.conciliacion.explicado)}`)
  assert(s.capital.disponible === 12_450 && s.capital.enRutas === 7_000 && s.capital.gastos === 550 && s.partidas.recibidoSA === 20_000, 'cifras del ejemplo incorrectas')
  assert(s.conciliacion.entradas === 20_000 && s.conciliacion.explicado === 20_000, 'conciliación del ejemplo incorrecta')
})

await spec('POOL-002', G, 'movimientos = registros reales (ids existentes), con signo y tipo', async () => {
  await empresa()
  const c1 = await registerCapital({ actor: ANA, tenantId: T, routeId: R1, valor: 5_000 })
  const g = await gastoAna(400)
  const w = await registerWithdrawal({ actor: ANA, tenantId: T, routeId: R1, valor: 1_000 })
  const s = await caja()
  const por = (k: string) => s.movimientos.filter(m => m.kind === k)
  metric('tipos', s.movimientos.map(m => `${m.kind}:${m.monto}`).join(', '))
  assert(por('asignacion').length === 1 && por('asignacion')[0].monto === 20_000, 'falta la asignación')
  assert(por('colocacion')[0]?.id === c1.id && por('colocacion')[0].monto === -5_000 && por('colocacion')[0].routeId === R1, 'colocación mal clasificada')
  assert(por('gasto')[0]?.id === g.id && por('gasto')[0].monto === -400, 'gasto mal clasificado')
  assert(por('retiroRuta')[0]?.id === w.id && por('retiroRuta')[0].monto === 1_000 && por('retiroRuta')[0].actorId === ANA.id, 'devolución de ruta mal clasificada')
  // Sin movimientos sintéticos: cada id existe en su tabla.
  const ids = new Set([
    ...(await db.capitalLedger.toArray()).map(x => x.id), ...(await db.capitalMovements.toArray()).map(x => x.id),
    ...(await db.withdrawals.toArray()).map(x => x.id), ...(await db.expenses.toArray()).map(x => x.id),
  ])
  assert(s.movimientos.every(m => ids.has(m.id)), 'hay movimientos que no son registros reales')
  // La suma de los que afectan el disponible = disponible oficial.
  const suma = s.movimientos.filter(m => m.afecta === 'disponible').reduce((a, m) => a + m.monto, 0)
  assert(suma === s.capital.disponible, 'los movimientos no explican el disponible')
})

await spec('POOL-003', G, 'gastos por período ≠ acumulado; anulación y reintegro reflejados', async () => {
  await empresa()
  await gastoAna(400, { fecha: '2026-09-10' })
  const g = await gastoAna(300, { fecha: '2026-10-05' })
  await gastoAna(100, { fecha: '2026-10-06' })
  await reverseAdminExpense({ actor: ANA, tenantId: T, expenseId: g.id, reason: 'duplicado' })   // anulación fechada hoy
  const g2 = await gastoAna(200, { fecha: '2026-10-07' })
  await refundAdminExpense({ actor: ANA, tenantId: T, expenseId: g2.id, amount: 50, reason: 'devolución' })
  const s = await cuadra()
  const sept = poolExpensesInPeriod(s.movimientos, '2026-09-01', '2026-09-30')
  const todo = poolExpensesInPeriod(s.movimientos)
  metric('septiembre / acumulado / fórmula', `${money(sept.neto)} / ${money(todo.neto)} / ${money(s.capital.gastos)}`)
  assert(sept.neto === 400 && sept.registros === 1, 'resumen de septiembre incorrecto')
  assert(todo.neto === s.capital.gastos && s.capital.gastos === 400 + 300 + 100 - 300 + 200 - 50, 'acumulado ≠ gastos de la fórmula')
  assert(s.movimientos.some(m => m.kind === 'anulacionGasto' && m.monto === 300) && s.movimientos.some(m => m.kind === 'reintegro' && m.monto === 50), 'anulación o reintegro no reflejados')
  assert(s.movimientos.find(m => m.id === g.id)?.estado === 'anulado', 'el original no aparece anulado')
})

await spec('POOL-004', G, 'cambio de responsable: partidas explícitas y la conciliación sigue cuadrando', async () => {
  await empresa()
  await registerCapital({ actor: ANA, tenantId: T, routeId: R1, valor: 6_000 })
  await gastoAna(500)
  await setRouteCapitalController({ actor: SA, tenantId: T, routeId: R1, adminId: BETO.id, motivo: 'Reasignación' })
  const [a, b] = [await cuadra(ANA.id), await cuadra(BETO.id)]
  metric('Ana: entregado con rutas / gastos', `${money(a.partidas.rutasEntregadas)} / ${money(a.capital.gastos)}`)
  metric('Beto: recibido con rutas / en rutas', `${money(b.partidas.rutasRecibidas)} / ${money(b.capital.enRutas)}`)
  assert(a.partidas.rutasEntregadas === 6_000 && a.capital.gastos === 500 && a.capital.enRutas === 0, 'Ana: partidas incorrectas')
  assert(b.partidas.rutasRecibidas === 6_000 && b.capital.enRutas === 6_000 && b.capital.gastos === 0, 'Beto: partidas incorrectas (los gastos no viajan)')
  assert(a.movimientos.some(m => m.kind === 'rutaEntregada' && m.afecta === 'enRutas'), 'falta el movimiento de cambio de responsable')
})

await spec('POOL-005', G, 'histórico sin bolsa: fuera de la conciliación y de los movimientos', async () => {
  await empresa()
  await db.expenses.add({ id: 'hist-1', tenantId: T, scope: 'empresa', categoryId: CASCO, valor: 9_999, descripcion: 'Histórico', fecha: '2026-09-01', userId: ANA.id, syncStatus: 'synced', createdAt: '2026-09-01T00:00:00.000Z' })
  await gastoAna(100)
  const s = await cuadra()
  metric('gastos / movimientos de gasto', `${money(s.capital.gastos)} / ${s.movimientos.filter(m => m.kind === 'gasto').length}`)
  assert(s.capital.gastos === 100 && !s.movimientos.some(m => m.id === 'hist-1'), 'el histórico entró en la caja')
})

await spec('POOL-006', G, 'aislamiento y permisos: cada Admin su caja; SuperAdmin todas; operativos ninguna', async () => {
  await empresa()
  await gastoAna(300)
  await createExpense({ actor: BETO, tenantId: T, scope: 'empresa', categoryId: CASCO, valor: 700, descripcion: 'Gasto de Beto', funding: { source: 'admin', adminId: BETO.id } })
  const [a, b] = [await caja(ANA.id, ANA), await caja(BETO.id, BETO)]
  assert(a.capital.gastos === 300 && b.capital.gastos === 700 && !a.movimientos.some(m => b.movimientos.some(x => x.id === m.id && x.kind !== 'asignacion')), 'las cajas se mezclan')
  const intentos = {
    'Ana pide la de Beto': await rechazo(() => caja(BETO.id, ANA)),
    'Supervisor': await rechazo(() => caja(ANA.id, LAURA)),
    'Cobrador': await rechazo(() => caja(ANA.id, FABIO)),
    'Socio': await rechazo(() => caja(ANA.id, SOCIO)),
    'SuperAdmin pide un no-Admin': await rechazo(() => caja(LAURA.id, SA)),
  }
  for (const [k, v] of Object.entries(intentos)) metric(k, v)
  assert(Object.values(intentos).every(r => r !== 'ACEPTADO'), 'acceso indebido a una caja')
  const deSA = await caja(BETO.id, SA)
  assert(deSA.capital.gastos === 700, 'el SuperAdmin no ve la caja de Beto')
})

await spec('POOL-007', G, 'conservación: 60 operaciones mezcladas, la caja cuadra tras cada una', async () => {
  await empresa()
  let seed = 11
  const rnd = (n: number) => { seed = (seed * 48271) % 2147483647; return seed % n }
  const gastos: string[] = []
  const colocaciones: string[] = []
  let ok = 0
  const motivos = new Map<string, number>()
  for (let i = 0; i < 60; i++) {
    const v = 100 + rnd(3_000)
    const op = rnd(8)
    const f = async () => {
      if (op === 0) { const m = await registerCapital({ actor: ANA, tenantId: T, routeId: rnd(2) ? R1 : R2, valor: v }); colocaciones.push(m.id); return m }
      if (op === 1) return registerWithdrawal({ actor: ANA, tenantId: T, routeId: rnd(2) ? R1 : R2, valor: v })
      if (op === 2) { const g = await gastoAna(v); gastos.push(g.id); return g }
      if (op === 3 && gastos.length) return reverseAdminExpense({ actor: ANA, tenantId: T, expenseId: gastos[rnd(gastos.length)], reason: 'auditoría' })
      if (op === 4 && gastos.length) return refundAdminExpense({ actor: ANA, tenantId: T, expenseId: gastos[rnd(gastos.length)], amount: 1 + rnd(100), reason: 'reintegro' })
      if (op === 5) return registerTransfer({ actor: ANA, tenantId: T, origen: { type: 'route', id: R1 }, destino: { type: 'route', id: R2 }, valor: v })
      if (op === 6 && colocaciones.length) return reverseCapitalMovement({ actor: ANA, tenantId: T, movementId: colocaciones[rnd(colocaciones.length)], reason: 'error' })
      return returnCapitalFromAdmin({ actor: SA, tenantId: T, adminId: ANA.id, amount: 1 + rnd(500) })
    }
    const r = await rechazo(f)
    if (r === 'ACEPTADO') ok++
    else motivos.set(r.slice(0, 60), (motivos.get(r.slice(0, 60)) ?? 0) + 1)
    const s = await cuadra()
    assert(s.capital.disponible >= 0, `paso ${i}: disponible negativo`)
  }
  const s = await caja()
  metric('operaciones aceptadas', `${ok}/60`)
  for (const [k, n] of motivos) metric(`rechazo ×${n}`, k)
  metric('final', `disp ${money(s.capital.disponible)} · rutas ${money(s.capital.enRutas)} · gastos ${money(s.capital.gastos)} · a explicar ${money(s.conciliacion.entradas)}`)
})

await spec('POOL-008', G, 'las pantallas presentan el servicio: sin fórmulas propias ni lecturas de otras bolsas', async () => {
  const panel = src('src/components/capital/AdminPoolPanel.tsx')
  const pagina = src('src/pages/admin/CapitalPage.tsx')
  const modal = src('src/components/expenses/AdminExpenseModal.tsx')
  const gastos = src('src/pages/admin/ExpensesPage.tsx')
  assert(!/adminCapital\(|computeCapitalStructure\(|db\./.test(panel), 'el panel calcula o lee la base por su cuenta')
  assert(/getAdminPoolStatement\(/.test(pagina) && /<AdminPoolPanel/.test(pagina) && /<AdminExpenseModal/.test(pagina), 'Caja principal no usa el servicio o el formulario compartido')
  assert(/createExpense\(/.test(modal) && /scope: 'empresa'/.test(modal) && /funding: bolsaSel/.test(modal), 'el gasto administrativo no pasa por createExpense con su bolsa')
  assert(/<AdminExpenseModal/.test(gastos) && !/payablePoolsFor|getAdminAvailableCapital/.test(gastos), 'Gastos duplica el formulario de gasto administrativo')
  const layout = src('src/components/layout/AdminLayout.tsx')
  assert(/label: 'Caja principal'.*roles: \['admin'\]/.test(layout) && /label: 'Capital'.*roles: \['superadmin'\]/.test(layout), 'el menú no distingue Caja principal / Capital')
})

console.log('\n════════════════════════════════════════════════════════════════')
console.log('  ADEX · CAJA PRINCIPAL DEL ADMINISTRADOR (Ronda 3/6)')
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
