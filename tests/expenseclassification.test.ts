// ============================================================
// RUTACASH — SUITE CLASIFICACIÓN Y ATRIBUCIÓN DE GASTOS (DEXIE REAL)
// ------------------------------------------------------------
//   npm run test:expenseclassification
//
// Ajuste del socio 2026-10-02, punto 9. El socio vio en Gastos de Fabio el
// Transporte ($11.000) y la Papelería ($300) registrados por el Admin. La
// visibilidad y el efecto de un gasto dependen de A QUIÉN SE ATRIBUYE (empresa,
// ruta o trabajador), nunca de quién lo registró.
//
// Escenario: Barreiro con Base 300.000; Fabio 100.000 y Carlos 50.000 en manos;
// 150.000 sin asignar. Centro con Pedro. Una empresa ajena.
//
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import { sembrarResponsables } from './financial/capitalFixture'
import { today } from '../src/lib/formatters'
import { can } from '../src/lib/permissions'
import { OPERATIONAL_TABLES, subscribeDataChanges, watchQuery } from '../src/lib/dataRevision'
import { expenseAttribution, isExpenseOf } from '../src/lib/expenseAttribution'
import { filterRowsByVisibleRoutes } from '../src/lib/officeRouteFilter'
import { getRouteBase, getCollectorCashSummary } from '../src/services/cashboxEngine'
import { computeRouteBaseBreakdown, computeRouteCashReconciliation } from '../src/services/routeCashReconciliation'
import { personalCashPosition, closeCashSettlement } from '../src/services/cashSettlementService'
import { registerCapital } from '../src/services/routeFundsService'
import { assignBaseToWorker } from '../src/services/cashCustodyService'
import { createExpense, type CreateExpenseParams } from '../src/services/expenseService'
import { generateWeeklySettlement } from '../src/services/weeklySettlementEngine'
import { getOfficeManagementSummary } from '../src/services/officeService'
import { buildReport } from '../src/services/reportService'
import { getPendingSyncCount, syncPendingItems } from '../src/services/syncService'
import type { Expense, User } from '../src/models/types'
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
// Escenario: ADEX (Barreiro, Centro) y una empresa ajena
// ============================================================
const T = 't-adex'
const TB = 't-ajena'
const R1 = 'r-barreiro'
const R2 = 'r-centro'
const RB = 'r-ajena'
const CAT_TRANSPORTE = 'cat-transporte'
const CAT_PAPELERIA = 'cat-papeleria'
const CAT_AJENA = 'cat-ajena'

const persona = (id: string, nombre: string, rol: User['rol'], rutas: string[], tenantId = T): User => ({
  id, tenantId, nombre, email: `${id}@adex.co`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)

const SUPER = persona('u-super', 'Sara SuperAdmin', 'superadmin', [])
const ADMIN = persona('u-admin', 'Andrés Admin', 'admin', [R1, R2])
const LAURA = persona('u-laura', 'Laura Supervisora', 'supervisor', [R1])
const FABIO = persona('u-fabio', 'Fabio', 'cobrador', [R1])
const CARLOS = persona('u-carlos', 'Carlos', 'cobrador', [R1])
const PEDRO = persona('u-pedro', 'Pedro Centro', 'cobrador', [R2])
const AJENO_ADMIN = persona('u-ajeno-admin', 'Ana Ajena', 'admin', [RB], TB)
const AJENO = persona('u-ajeno', 'Alberto Ajeno', 'cobrador', [RB], TB)
const TODOS = [SUPER, ADMIN, LAURA, FABIO, CARLOS, PEDRO, AJENO_ADMIN, AJENO]

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
  await db.users.bulkAdd(TODOS)
  // v16: Andrés (primer Admin de ambas rutas) es su responsable de capital, con bolsa.
  await sembrarResponsables(db, T, { [R1]: ADMIN.id, [R2]: ADMIN.id })
  await sembrarResponsables(db, TB, { [RB]: AJENO_ADMIN.id })
  await db.expenseCategories.bulkAdd([
    { id: CAT_TRANSPORTE, tenantId: T, nombre: 'Transporte', activa: true },
    { id: CAT_PAPELERIA, tenantId: T, nombre: 'Papelería', activa: true },
    { id: CAT_AJENA, tenantId: TB, nombre: 'Ajena', activa: true },
  ])
}

const entregar = (u: User, amount: number, routeId = R1) =>
  assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId, recipientUserId: u.id, amount, motivo: 'Base del día' })

/** Base 300.000 en Barreiro; Fabio 100.000, Carlos 50.000; Centro 200.000 con Pedro 80.000. */
async function escenario() {
  await empresa()
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 300_000 })
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R2, valor: 200_000 })
  await entregar(FABIO, 100_000)
  await entregar(CARLOS, 50_000)
  await entregar(PEDRO, 80_000, R2)
}

type Extra = Partial<Omit<CreateExpenseParams, 'actor' | 'scope'>>
const gasto = (actor: User, scope: CreateExpenseParams['scope'], extra: Extra = {}) =>
  createExpense({
    actor, tenantId: actor.tenantId, scope, categoryId: CAT_TRANSPORTE, valor: 10_000,
    routeId: scope === 'empresa' ? undefined : R1, ...extra,
  })
const deEmpresa = (valor: number, descripcion = 'Papelería administrativa') =>
  gasto(ADMIN, 'empresa', { categoryId: CAT_PAPELERIA, valor, descripcion })
const deRuta = (valor: number, actor: User = ADMIN, routeId = R1) => gasto(actor, 'ruta', { valor, routeId, descripcion: 'Gasto operativo' })
const deTrabajador = (u: User, valor: number, actor: User = ADMIN, routeId = R1) =>
  gasto(actor, 'trabajador', { valor, routeId, collectorId: u.id, descripcion: `Transporte ${u.nombre}` })

const ahora = () => new Date().toISOString()
const posicion = async (u: User, routeId = R1) =>
  (await personalCashPosition({ tenantId: T, routeId, userId: u.id, hasta: ahora() })).esperado
const gastosEnCuadre = async (u: User, routeId = R1) =>
  (await personalCashPosition({ tenantId: T, routeId, userId: u.id, hasta: ahora() })).gastos
const desglose = (routeId = R1) => computeRouteBaseBreakdown({ tenantId: T, routeId })
const foto = async (routeId = R1) => {
  const d = await desglose(routeId)
  return { base: d.base, sinAsignar: d.sinAsignar, enTrabajadores: d.enTrabajadores }
}

/**
 * Lo que muestra `CollectorExpensesPage` (misma consulta y mismo filtro; EXP-CLASS-001
 * comprueba que la pantalla usa exactamente esta regla).
 */
async function vistaOperativa(u: User, routeId = R1): Promise<Expense[]> {
  const exps = await db.expenses.where('routeId').equals(routeId).toArray()
  const veGastosDeRuta = can(u, 'cashbox.viewRoute', { routeId, tenantId: u.tenantId })
  return exps.filter(e => e.tenantId === u.tenantId && (veGastosDeRuta || isExpenseOf(e, u.id)))
}
const descripciones = (xs: Expense[]) => xs.map(e => `${e.descripcion ?? '?'} ${e.valor}`).sort().join(' · ') || '(ninguno)'
const PANTALLA_COBRADOR = 'src/pages/collector/CollectorExpensesPage.tsx'
const PANTALLA_ADMIN = 'src/pages/admin/ExpensesPage.tsx'

// ============================================================
// EMPRESA
// ============================================================
await spec('EXP-CLASS-001', 'gasto de empresa creado por Admin: NO aparece al Cobrador', async () => {
  await escenario()
  const e = await deEmpresa(300)
  const vista = await vistaOperativa(FABIO)
  metric('gasto', `${e.scope} · routeId ${e.routeId ?? '—'} · collectorId ${e.collectorId ?? '—'} · registró ${e.userId}`)
  metric('Gastos de Fabio', descripciones(vista))
  assert(e.scope === 'empresa' && !e.routeId && !e.collectorId, 'el gasto de empresa quedó con ruta o trabajador')
  assert(!vista.some(x => x.id === e.id), 'Fabio ve el gasto de empresa')
  // La pantalla usa la misma regla (atribución, no ruta ni creador).
  const p = src(PANTALLA_COBRADOR)
  const regla = p.includes("veGastosDeRuta || isExpenseOf(e, user.id)") && p.includes("can(user, 'cashbox.viewRoute'")
  metric('pantalla filtra por atribución', regla)
  assert(regla, 'la pantalla del Cobrador no filtra por atribución')
  assert(!can(FABIO, 'cashbox.viewRoute', { routeId: R1, tenantId: T }), 'el Cobrador ve gastos de la ruta')
})

await spec('EXP-CLASS-002', 'gasto de empresa NO afecta el efectivo del trabajador', async () => {
  await escenario()
  const antes = [await posicion(FABIO), await posicion(CARLOS)]
  await deEmpresa(20_000)
  const despues = [await posicion(FABIO), await posicion(CARLOS)]
  metric('Fabio / Carlos', `${antes.join(' / ')} → ${despues.join(' / ')}`)
  assert(antes.join() === despues.join(), 'el gasto de empresa movió el efectivo de un trabajador')
})

await spec('EXP-CLASS-003', 'gasto de empresa NO entra en el cuadre del trabajador', async () => {
  await escenario()
  await deEmpresa(20_000)
  const g = await gastosEnCuadre(FABIO)
  metric('gastos en el ciclo de Fabio', g)
  assert(g === 0, 'el gasto de empresa entró en el cuadre de Fabio')
})

// ============================================================
// RUTA
// ============================================================
await spec('EXP-CLASS-004', 'gasto de ruta: Base ↓ y Sin asignar ↓; En manos igual', async () => {
  await escenario()
  const antes = await foto()
  const e = await deRuta(20_000)
  const despues = await foto()
  metric('Base / Sin asignar / En manos', `${antes.base}/${antes.sinAsignar}/${antes.enTrabajadores} → ${despues.base}/${despues.sinAsignar}/${despues.enTrabajadores}`)
  assert(e.scope === 'ruta' && e.routeId === R1 && !e.collectorId, 'forma incorrecta del gasto de ruta')
  assert(despues.base === antes.base - 20_000, 'la Base no bajó')
  assert(despues.sinAsignar === antes.sinAsignar - 20_000, 'no salió de Sin asignar')
  assert(despues.enTrabajadores === antes.enTrabajadores, 'cambió el efectivo en manos')
})

await spec('EXP-CLASS-005', 'gasto de ruta no se atribuye a nadie; v16: lo paga la caja → solo su responsable (el Supervisor ya no)', async () => {
  await escenario()
  await entregar(LAURA, 30_000)
  const antes = { fabio: await posicion(FABIO), carlos: await posicion(CARLOS), laura: await posicion(LAURA) }
  // v16 (§8): un gasto de RUTA sale de la caja de la ruta → control estructural del
  // Administrador responsable. Laura (Supervisora) ya no puede registrarlo.
  const laura = await rechazo(() => deRuta(20_000, LAURA))
  const e = await deRuta(20_000, ADMIN)
  const despues = { fabio: await posicion(FABIO), carlos: await posicion(CARLOS), laura: await posicion(LAURA) }
  metric('Laura intenta registrarlo', laura)
  metric('registró', e.userId)
  metric('atribución', JSON.stringify(expenseAttribution(e)))
  metric('Fabio / Carlos / Laura', `${Object.values(antes).join('/')} → ${Object.values(despues).join('/')}`)
  assert(laura !== 'ACEPTADO', 'el Supervisor sigue pagando gastos con la caja de la ruta')
  assert(e.userId === ADMIN.id && expenseAttribution(e).cashHolderId === undefined, 'el gasto de ruta quedó a cargo de alguien')
  assert(JSON.stringify(antes) === JSON.stringify(despues), 'el gasto de ruta se cargó a un trabajador')
  assert(!(await vistaOperativa(FABIO)).some(x => x.id === e.id), 'Fabio ve el gasto de ruta como suyo')
})

// ============================================================
// TRABAJADOR
// ============================================================
await spec('EXP-CLASS-006', 'Admin registra un gasto atribuido a Fabio: Fabio SÍ lo ve', async () => {
  await escenario()
  const e = await deTrabajador(FABIO, 11_000)
  const vista = await vistaOperativa(FABIO)
  metric('gasto', `${e.scope} · collectorId ${e.collectorId} · registró ${e.userId}`)
  metric('Gastos de Fabio', descripciones(vista))
  assert(e.userId === ADMIN.id && e.collectorId === FABIO.id, 'atribución incorrecta')
  assert(vista.some(x => x.id === e.id), 'Fabio no ve su gasto registrado por el Admin')
})

await spec('EXP-CLASS-007', 'el gasto de Fabio reduce su efectivo', async () => {
  await escenario()
  const antes = await posicion(FABIO)
  await deTrabajador(FABIO, 11_000)
  const despues = await posicion(FABIO)
  metric('Fabio', `${antes} → ${despues}`)
  assert(antes === 100_000 && despues === 89_000, 'el efectivo de Fabio no bajó 11.000')
})

await spec('EXP-CLASS-008', 'el gasto de Fabio NO afecta a Carlos', async () => {
  await escenario()
  const antes = await posicion(CARLOS)
  const e = await deTrabajador(FABIO, 11_000)
  metric('Carlos', `${antes} → ${await posicion(CARLOS)}`)
  assert(await posicion(CARLOS) === antes, 'el gasto de Fabio movió a Carlos')
  assert(!(await vistaOperativa(CARLOS)).some(x => x.id === e.id), 'Carlos ve el gasto de Fabio')
})

await spec('EXP-CLASS-009', 'el Cobrador registra su propio gasto: queda a su cargo y en su ruta', async () => {
  await escenario()
  const e = await deTrabajador(FABIO, 5_000, FABIO)
  metric('gasto', `${e.scope} · ruta ${e.routeId} · collectorId ${e.collectorId} · registró ${e.userId}`)
  assert(e.scope === 'trabajador' && e.routeId === R1 && e.collectorId === FABIO.id && e.userId === FABIO.id, 'atribución incorrecta')
  assert(await posicion(FABIO) === 95_000, 'no se descontó del efectivo de Fabio')
  // El Cobrador no puede cargar el gasto a otro ni a la caja de la ruta.
  const aCarlos = await rechazo(() => deTrabajador(CARLOS, 5_000, FABIO))
  const aRuta = await rechazo(() => deRuta(5_000, FABIO))
  metric('Fabio → Carlos', aCarlos)
  metric('Fabio → caja de la ruta', aRuta)
  assert(aCarlos !== 'ACEPTADO' && aRuta !== 'ACEPTADO', 'el Cobrador desvió un gasto')
  // La pantalla sigue decidiendo con el predicado único de caja personal.
  assert(src(PANTALLA_COBRADOR).includes('hasPersonalCashbox(user.rol)'), 'la pantalla perdió el predicado único')
})

await spec('EXP-CLASS-010', 'Supervisor registra un gasto atribuido a Carlos: Carlos lo ve, Fabio no', async () => {
  await escenario()
  const e = await deTrabajador(CARLOS, 7_000, LAURA)
  const carlos = await vistaOperativa(CARLOS)
  const fabio = await vistaOperativa(FABIO)
  metric('Carlos ve', descripciones(carlos))
  metric('Fabio ve', descripciones(fabio))
  metric('Carlos', `50000 → ${await posicion(CARLOS)}`)
  assert(e.userId === LAURA.id && e.collectorId === CARLOS.id, 'atribución incorrecta')
  assert(carlos.some(x => x.id === e.id) && !fabio.some(x => x.id === e.id), 'visibilidad incorrecta')
  assert(await posicion(CARLOS) === 43_000, 'no se descontó del efectivo de Carlos')
})

await spec('EXP-CLASS-011', 'Supervisor atribuye a un trabajador de otra ruta: rechazo', async () => {
  await escenario()
  const pedroEnBarreiro = await rechazo(() => deTrabajador(PEDRO, 5_000, LAURA, R1))
  const pedroEnCentro = await rechazo(() => deTrabajador(PEDRO, 5_000, LAURA, R2))
  metric('Pedro en Barreiro', pedroEnBarreiro)
  metric('Pedro en Centro (ruta ajena a Laura)', pedroEnCentro)
  assert(pedroEnBarreiro !== 'ACEPTADO' && pedroEnCentro !== 'ACEPTADO', 'se aceptó un trabajador fuera de alcance')
  assert(await db.expenses.count() === 0, 'quedó un gasto escrito')
})

await spec('EXP-CLASS-012', 'empresa distinta: rechazo', async () => {
  await escenario()
  const ajenoEnAdex = await rechazo(() => createExpense({ actor: AJENO_ADMIN, tenantId: T, scope: 'empresa', categoryId: CAT_TRANSPORTE, valor: 1_000 }))
  const ajenoRuta = await rechazo(() => createExpense({ actor: AJENO_ADMIN, tenantId: TB, scope: 'ruta', routeId: R1, categoryId: CAT_AJENA, valor: 1_000 }))
  const categoriaAjena = await rechazo(() => gasto(ADMIN, 'empresa', { categoryId: CAT_AJENA }))
  const trabajadorAjeno = await rechazo(() => deTrabajador(AJENO, 1_000))
  metric('Admin ajeno → ADEX', ajenoEnAdex)
  metric('Admin ajeno → ruta de ADEX', ajenoRuta)
  metric('categoría ajena', categoriaAjena)
  metric('trabajador ajeno', trabajadorAjeno)
  assert([ajenoEnAdex, ajenoRuta, categoriaAjena, trabajadorAjeno].every(r => r !== 'ACEPTADO'), 'cruce entre empresas aceptado')
  assert(await db.expenses.count() === 0, 'quedó un gasto escrito')
})

await spec('EXP-CLASS-013', 'estados ambiguos: trabajador sin persona, empresa con ruta/persona, sin tipo', async () => {
  await escenario()
  const casos = {
    'trabajador sin collectorId': await rechazo(() => gasto(ADMIN, 'trabajador')),
    'empresa con collectorId': await rechazo(() => gasto(ADMIN, 'empresa', { collectorId: FABIO.id })),
    'empresa con routeId': await rechazo(() => gasto(ADMIN, 'empresa', { routeId: R1 })),
    'ruta con collectorId': await rechazo(() => gasto(ADMIN, 'ruta', { collectorId: FABIO.id })),
    'ruta sin routeId': await rechazo(() => gasto(ADMIN, 'ruta', { routeId: '' })),
    'sin tipo': await rechazo(() => gasto(ADMIN, undefined as never)),
    'valor 0': await rechazo(() => gasto(ADMIN, 'empresa', { valor: 0 })),
  }
  for (const [k, v] of Object.entries(casos)) metric(k, v)
  assert(Object.values(casos).every(v => v !== 'ACEPTADO'), 'se aceptó un estado ambiguo')
  assert(await db.expenses.count() === 0, 'quedó un gasto escrito')
})

await spec('EXP-CLASS-014', 'trabajador con una ruta que no es la suya: rechazo', async () => {
  await escenario()
  const r = await rechazo(() => deTrabajador(FABIO, 5_000, ADMIN, R2))
  metric('Fabio en Centro', r)
  assert(r !== 'ACEPTADO' && /no está asignada/.test(r), 'se aceptó un trabajador en una ruta ajena')
})

await spec('EXP-CLASS-015', 'gasto mayor al efectivo: el de trabajador se registra en negativo (incidente 2026-10-08); el de ruta se rechaza', async () => {
  await escenario()
  // Gasto de TRABAJADOR por encima de su efectivo: se registra (comportamiento
  // histórico) y deja su posición en negativo, sin tocar la caja sin asignar.
  const antes = await foto()
  const fabio = await rechazo(() => deTrabajador(FABIO, 100_001))
  const tras = await foto()
  const ruta = await rechazo(() => deRuta(150_001))
  metric('Fabio 100.001 con 100.000 en manos', fabio)
  metric('Fabio / Sin asignar', `${await posicion(FABIO)} / ${antes.sinAsignar} → ${tras.sinAsignar}`)
  metric('ruta 150.001 con 150.000 sin asignar', ruta)
  assert(fabio === 'ACEPTADO' && await posicion(FABIO) === -1, 'el gasto del trabajador no quedó en negativo')
  assert(tras.sinAsignar === antes.sinAsignar, 'el negativo se compensó con la caja sin asignar')
  // La caja de la ruta (capital) sigue sin poder gastar lo que no tiene.
  assert(/supera el efectivo sin asignar/.test(ruta), 'se aceptó un gasto de ruta sin fondos')
  await deRuta(150_000)
  const f = await foto()
  metric('Sin asignar tras gastar todo', f.sinAsignar)
  assert(f.sinAsignar === 0, 'posición imposible en la caja de la ruta')
  // El gasto de empresa no consume efectivo de ninguna ruta.
  await deEmpresa(1_000_000)
  assert((await foto()).base === 300_000 - 100_001 - 150_000, 'el gasto de empresa tocó la ruta')
})

// ============================================================
// BASE CANÓNICA
// ============================================================
await spec('EXP-CLASS-016', 'Base canónica tras gasto de trabajador: Base ↓, En manos ↓, Sin asignar igual', async () => {
  await escenario()
  const antes = await foto()
  await deTrabajador(FABIO, 10_000)
  const despues = await foto()
  metric('Base / Sin asignar / En manos', `${antes.base}/${antes.sinAsignar}/${antes.enTrabajadores} → ${despues.base}/${despues.sinAsignar}/${despues.enTrabajadores}`)
  assert(antes.base === 300_000 && despues.base === 290_000, 'Base incorrecta')
  assert(despues.enTrabajadores === antes.enTrabajadores - 10_000, 'En manos no bajó')
  assert(despues.sinAsignar === antes.sinAsignar, 'Sin asignar cambió')
  assert(await getRouteBase(R1) === despues.base, 'la Base canónica no coincide con el desglose')
})

await spec('EXP-CLASS-017', 'Base canónica tras gasto de ruta', async () => {
  await escenario()
  await deRuta(20_000)
  const f = await foto()
  metric('Base / Sin asignar / En manos', `${f.base}/${f.sinAsignar}/${f.enTrabajadores}`)
  assert(f.base === 280_000 && f.sinAsignar === 130_000 && f.enTrabajadores === 150_000, 'desglose incorrecto')
  assert(await getRouteBase(R1) === 280_000, 'Base canónica incorrecta')
})

await spec('EXP-CLASS-018', 'gasto de empresa: no afecta la Base de ninguna ruta', async () => {
  await escenario()
  const antes = [await getRouteBase(R1), await getRouteBase(R2)]
  await deEmpresa(300)
  await deEmpresa(50_000, 'Arriendo oficina')
  const despues = [await getRouteBase(R1), await getRouteBase(R2)]
  metric('Base Barreiro / Centro', `${antes.join(' / ')} → ${despues.join(' / ')}`)
  assert(antes.join() === despues.join(), 'un gasto de empresa restó la Base de una ruta')
})

await spec('EXP-CLASS-019', 'Base = Sin asignar + En manos (y la conciliación cuadra) con los tres tipos', async () => {
  await escenario()
  await deEmpresa(300)
  await deRuta(20_000)
  await deTrabajador(FABIO, 11_000)
  await deTrabajador(CARLOS, 7_000, LAURA)
  const r = await computeRouteCashReconciliation({ tenantId: T, routeId: R1 })
  const d = await desglose()
  metric('Base = Sin asignar + En manos', `${d.base} = ${d.sinAsignar} + ${d.enTrabajadores}`)
  metric('conciliación (dos vías)', `${r.noAsignado} / ${r.explicacionNoAsignado.total} · cuadra ${r.cuadra}`)
  assert(d.base === d.sinAsignar + d.enTrabajadores, 'identidad rota')
  assert(d.base === 262_000 && d.sinAsignar === 130_000 && d.enTrabajadores === 132_000, 'valores incorrectos')
  assert(r.cuadra, 'la conciliación no cuadra')
})

// ============================================================
// CUADRE, LIQUIDACIÓN, OFICINA, REPORTES
// ============================================================
await spec('EXP-CLASS-020', 'cuadre del trabajador: solo los gastos atribuidos a él', async () => {
  await escenario()
  await deEmpresa(20_000)
  await deRuta(20_000)
  await deTrabajador(CARLOS, 7_000)
  await deTrabajador(FABIO, 11_000)
  const doc = await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: FABIO.id, entregado: 89_000 })
  metric('cuadre de Fabio', `Base ${doc.baseRecibida} − gastos ${doc.gastos} = esperado ${doc.esperado}; entregó ${doc.entregado}`)
  assert(doc.gastos === 11_000 && doc.esperado === 89_000 && doc.faltante === 0, 'el cuadre incluye gastos ajenos')
})

await spec('EXP-CLASS-021', 'liquidación semanal: cada gasto una sola vez, en su ruta; empresa fuera', async () => {
  await escenario()
  await deEmpresa(300)
  await deRuta(20_000)
  await deTrabajador(FABIO, 11_000)
  await deTrabajador(PEDRO, 4_000, ADMIN, R2)
  const semana = { tenantId: T, semanaInicio: today(), semanaFin: today() }
  const b = await generateWeeklySettlement({ ...semana, routeId: R1 })
  const c = await generateWeeklySettlement({ ...semana, routeId: R2 })
  const total = (await db.expenses.toArray()).reduce((s, e) => s + e.valor, 0)
  metric('Barreiro / Centro / empresa', `${b.gastos} / ${c.gastos} / 300`)
  metric('Σ liquidaciones + empresa = Σ gastos', `${b.gastos + c.gastos + 300} = ${total}`)
  assert(b.gastos === 31_000 && c.gastos === 4_000, 'la liquidación no suma ruta + trabajador de la ruta')
  assert(b.gastos + c.gastos + 300 === total, 'doble conteo u omisión')
})

await spec('EXP-CLASS-022', 'Oficina: gastos de sus rutas (ruta + trabajador); los de empresa no se atribuyen', async () => {
  await escenario()
  await deEmpresa(300)
  await deRuta(20_000)
  await deTrabajador(FABIO, 11_000)
  await deTrabajador(PEDRO, 4_000, ADMIN, R2)
  const s = await getOfficeManagementSummary({ user: ADMIN, tenantId: T, officeId: 'of-1' })
  metric('Oficina Leticia · gastos hoy', s?.ops.gastosHoy)
  metric('Oficina Leticia · gastos del libro', s?.finance?.gastos)
  assert(s?.ops.gastosHoy === 35_000, 'la Oficina no suma exactamente los gastos de sus rutas')
  assert(s?.finance?.gastos === 35_000, 'el libro de la Oficina incluye gastos de empresa')
  // El filtro compartido Oficina → Ruta descarta filas sin ruta (fail-closed).
  const filas = filterRowsByVisibleRoutes(await db.expenses.toArray(), new Set([R1, R2]))
  metric('filas filtradas por Oficina', filas.length)
  assert(filas.length === 3 && filas.every(e => e.routeId), 'un gasto de empresa entró en una Oficina')
})

await spec('EXP-CLASS-023', 'reportes: Tipo y Trabajador distinguibles; empresa solo con "todas las rutas"', async () => {
  await escenario()
  await deEmpresa(300)
  await deRuta(20_000)
  await deTrabajador(FABIO, 11_000)
  const fuentes = {
    payments: await db.payments.toArray(), sales: await db.sales.toArray(), expenses: await db.expenses.toArray(),
    clients: [], routes: await db.routes.toArray(), categories: await db.expenseCategories.toArray(), users: await db.users.toArray(),
  }
  const rango = { fechaDesde: today(), fechaHasta: today() }
  const todo = buildReport('gastos', fuentes, { routeIds: new Set([R1, R2]), ...rango, includeCompanyExpenses: true })
  const soloBarreiro = buildReport('gastos', fuentes, { routeIds: new Set([R1]), ...rango })
  const caja = buildReport('caja_diaria', fuentes, { routeIds: new Set([R1, R2]), ...rango, includeCompanyExpenses: true })
  const filas = todo.map(r => `${r.Tipo}|${r.Ruta}|${r.Trabajador}|${r.Valor}`).sort()
  metric('Gastos (todas las rutas)', filas.join(' · '))
  metric('Gastos (Barreiro)', soloBarreiro.map(r => r.Tipo).join(', '))
  metric('Caja diaria Barreiro · gastos', caja.map(r => r.Gastos).join(', '))
  assert(filas.join() === ['Empresa|—|—|300', 'Ruta|Barreiro|—|20000', 'Trabajador|Barreiro|Fabio|11000'].join(), 'clasificación no distinguible')
  assert(soloBarreiro.length === 2 && !soloBarreiro.some(r => r.Tipo === 'Empresa'), 'la ruta incluye gastos de empresa')
  assert(caja.length === 1 && caja[0].Gastos === 31_000, 'la caja por ruta incluye gastos de empresa')
  const pagina = src('src/pages/admin/ReportsPage.tsx')
  assert(/includeCompanyExpenses = officeId === ALL_OFFICES && !routeId/.test(pagina) && pagina.includes("can(user, 'cashbox.viewConsolidated'"), 'la pantalla no acota los gastos de empresa')
})

// ============================================================
// SINCRONIZACIÓN Y REACTIVIDAD
// ============================================================
await spec('EXP-CLASS-024', 'CollectorSyncPage: solo gastos del alcance; nunca los de empresa', async () => {
  await escenario()
  await deTrabajador(FABIO, 5_000, FABIO).then(e => db.expenses.update(e.id, { syncStatus: 'pending' }))
  const emp = await deEmpresa(300)
  await db.expenses.update(emp.id, { syncStatus: 'pending' })
  const ajeno = await createExpense({ actor: AJENO_ADMIN, tenantId: TB, scope: 'empresa', categoryId: CAT_AJENA, valor: 1, syncStatus: 'pending' })
  const n = await getPendingSyncCount({ tenantId: T, routeIds: [R1] })
  await syncPendingItems({ tenantId: T, routeIds: [R1] })
  const estado = async (id: string) => (await db.expenses.get(id))?.syncStatus
  metric('pendientes en el alcance de Barreiro', n)
  metric('empresa / ajeno tras sincronizar Barreiro', `${await estado(emp.id)} / ${await estado(ajeno.id)}`)
  assert(n === 1, 'el alcance de la ruta cuenta gastos de empresa o ajenos')
  assert(await estado(emp.id) === 'pending' && await estado(ajeno.id) === 'pending', 'la sincronización del Cobrador tocó gastos fuera de su alcance')
  const page = src('src/pages/collector/CollectorSyncPage.tsx')
  metric('la pantalla de sincronización lista gastos', /db\.expenses/.test(page))
  assert(!/db\.expenses/.test(page), 'CollectorSyncPage lista gastos')
})

await spec('EXP-CLASS-025', 'syncStatus: pending → synced sin tocar la clasificación', async () => {
  await escenario()
  const e = await gasto(FABIO, 'trabajador', { collectorId: FABIO.id, valor: 5_000, syncStatus: 'pending' })
  const r = await syncPendingItems({ tenantId: T, routeIds: [R1] })
  const tras = await db.expenses.get(e.id)
  metric('estado', `${e.syncStatus} → ${tras?.syncStatus} (confirmados ${r.synced})`)
  assert(e.syncStatus === 'pending' && tras?.syncStatus === 'synced', 'no se confirmó')
  assert(tras.scope === 'trabajador' && tras.collectorId === FABIO.id && tras.routeId === R1 && tras.valor === 5_000, 'la sincronización alteró el gasto')
  const r2 = await syncPendingItems({ tenantId: T, routeIds: [R1] })
  assert(r2.synced === 0, 'la sincronización no es idempotente')
})

await spec('EXP-CLASS-026', 'reactividad: el gasto del Admin llega a la vista de Fabio sin F5', async () => {
  await escenario()
  const señales: string[] = []
  const off = subscribeDataChanges(OPERATIONAL_TABLES, t => señales.push([...t].filter(x => x !== 'auditLogs').sort().join('+')))
  let vista = ''
  const cerrar = watchQuery(['expenses', 'users'], async () => descripciones(await vistaOperativa(FABIO)), v => { vista = v }, 5)
  await sleep(40)
  const antes = vista
  await deTrabajador(FABIO, 11_000)
  for (let i = 0; i < 100 && vista === antes; i++) await sleep(5)
  cerrar(); off()
  metric('señal', [...new Set(señales)].join(', '))
  metric('Gastos de Fabio', `${antes} → ${vista}`)
  assert(señales.some(s => s.includes('expenses')), 'no hubo señal de cambio')
  assert(vista.includes('Transporte Fabio 11000'), 'la vista no se actualizó')
  for (const p of [PANTALLA_COBRADOR, PANTALLA_ADMIN]) {
    assert(/useDataRevision\(\[[^\]]*'expenses'/.test(src(p)), `${p} no se suscribe a gastos`)
    assert(!/setInterval/.test(src(p)), `${p} usa polling`)
  }
})

// ============================================================
// HISTÓRICOS, MIGRACIÓN, CREADOR ≠ RESPONSABLE, AISLAMIENTO
// ============================================================
await spec('EXP-CLASS-027', 'históricos sin clasificación: se muestran y conservan su regla', async () => {
  await escenario()
  const legacy = (id: string, extra: Partial<Expense>): Expense => ({
    id, tenantId: T, routeId: R1, categoryId: CAT_TRANSPORTE, valor: 1_000, fecha: today(), userId: ADMIN.id,
    syncStatus: 'synced', createdAt: ahora(), ...extra,
  })
  await db.expenses.bulkAdd([
    legacy('h-admin', { descripcion: 'Transporte (Admin, histórico)', valor: 11_000 }),
    legacy('h-fabio', { descripcion: 'Fabio con collectorId', userId: FABIO.id, collectorId: FABIO.id, valor: 2_000 }),
    legacy('h-fabio-v9', { descripcion: 'Fabio sin collectorId', userId: FABIO.id, valor: 3_000 }),
  ])
  const at = (id: string) => db.expenses.get(id).then(e => expenseAttribution(e!))
  metric('Admin histórico', JSON.stringify(await at('h-admin')))
  metric('Fabio histórico', JSON.stringify(await at('h-fabio')))
  metric('Fabio sin collectorId (pre-v10)', JSON.stringify(await at('h-fabio-v9')))
  const vista = await vistaOperativa(FABIO)
  metric('Gastos de Fabio', descripciones(vista))
  assert(!vista.some(e => e.id === 'h-admin'), 'Fabio ve el gasto histórico del Admin')
  assert(vista.some(e => e.id === 'h-fabio') && vista.some(e => e.id === 'h-fabio-v9'), 'Fabio perdió sus gastos históricos')
  assert(await posicion(FABIO) === 95_000, 'cambió la posición histórica de Fabio')
  const filas = buildReport('gastos', {
    payments: [], sales: [], expenses: await db.expenses.toArray(), clients: [],
    routes: await db.routes.toArray(), categories: await db.expenseCategories.toArray(), users: await db.users.toArray(),
  }, { routeIds: new Set([R1]), fechaDesde: today(), fechaHasta: today() })
  const etiquetas = filas.map(r => `${r.Tipo}/${r.Trabajador}`).sort()
  metric('reporte', etiquetas.join(', '))
  // El Transporte del Admin queda como Ruta; los de Fabio (aunque uno no tenga
  // `collectorId`) como Trabajador/Fabio: la etiqueta coincide con a quién se cargan.
  assert(etiquetas.join() === ['Ruta/—', 'Trabajador/Fabio', 'Trabajador/Fabio'].join(), 'el reporte no muestra los históricos con su atribución')
})

await spec('EXP-CLASS-028', 'migración: N/A — la clasificación no exigió versión propia (campo `scope` no indexado)', async () => {
  const dbSrc = src('src/lib/db.ts')
  const versiones = [...dbSrc.matchAll(/this\.version\((\d+)\)/g)].map(m => Number(m[1]))
  metric('versión de la base', db.verno)
  metric('versión más alta declarada', Math.max(...versiones))
  // v16 (capital por Administrador) subió la versión por OTRA razón; lo que esta
  // prueba protege es que la clasificación de gastos no necesitó migración.
  assert(db.verno === Math.max(...versiones), 'la base no abre en la versión declarada')
  assert(!/expenses: '[^']*scope/.test(dbSrc), '`scope` se indexó')
})

await spec('EXP-CLASS-029', 'el creador NO decide la atribución (prueba crítica)', async () => {
  await escenario()
  const deFabio = await deTrabajador(FABIO, 11_000)
  const papeleria = await deEmpresa(300)
  const vista = await vistaOperativa(FABIO)
  metric('ambos registrados por', `${deFabio.userId} / ${papeleria.userId}`)
  metric('Fabio ve', descripciones(vista))
  assert(deFabio.userId === ADMIN.id && papeleria.userId === ADMIN.id, 'mismo creador')
  assert(vista.some(e => e.id === deFabio.id) && !vista.some(e => e.id === papeleria.id), 'la visibilidad depende del creador')
  // Ningún consumidor decide con `collectorId ?? userId` fuera de la regla histórica.
  const consumidores = ['src/services/cashboxEngine.ts', 'src/pages/collector/CollectorDailyReportPage.tsx', PANTALLA_COBRADOR]
  const sueltos = consumidores.filter(f => /collectorId \?\? e\.userId/.test(src(f)))
  metric('reglas `collectorId ?? userId` sueltas', sueltos.join(', ') || 'ninguna')
  assert(sueltos.length === 0, 'queda una atribución por creador fuera de expenseAttribution')
})

await spec('EXP-CLASS-030', 'aislamiento total empresa / ruta / trabajador', async () => {
  await escenario()
  await deEmpresa(300)
  await deRuta(20_000)
  await deTrabajador(FABIO, 11_000)
  await deTrabajador(PEDRO, 4_000, ADMIN, R2)
  await createExpense({ actor: AJENO_ADMIN, tenantId: TB, scope: 'empresa', categoryId: CAT_AJENA, valor: 999 })
  const v = {
    fabio: descripciones(await vistaOperativa(FABIO)),
    carlos: descripciones(await vistaOperativa(CARLOS)),
    pedro: descripciones(await vistaOperativa(PEDRO, R2)),
    laura: descripciones(await vistaOperativa(LAURA)),
  }
  for (const [k, x] of Object.entries(v)) metric(k, x)
  assert(v.fabio === 'Transporte Fabio 11000', 'Fabio ve algo ajeno')
  assert(v.carlos === '(ninguno)', 'Carlos ve algo ajeno')
  assert(v.pedro === 'Transporte Pedro Centro 4000', 'Pedro ve algo ajeno')
  assert(v.laura === 'Gasto operativo 20000 · Transporte Fabio 11000', 'el Supervisor no ve exactamente su ruta')
  // El Supervisor no tiene acceso a gastos de empresa ni a otras rutas.
  assert(!can(LAURA, 'cashbox.viewConsolidated', { tenantId: T }), 'el Supervisor ve el consolidado')
  assert(!can(LAURA, 'cashbox.viewRoute', { routeId: R2, tenantId: T }), 'el Supervisor ve otra ruta')
  assert((await getCollectorCashSummary({ routeId: R1, userId: PEDRO.id, desde: '2026-01-01T00:00:00.000Z', hasta: ahora() })).gastos === 0, 'Pedro recibe gastos de Barreiro')
})

// ============================================================
// CASO EXACTO DEL SOCIO
// ============================================================
await spec('EXP-CLASS-SOCIO', 'caso del socio: Transporte $11.000 y Papelería $300 del Admin; luego Transporte de Fabio', async () => {
  await escenario()
  const antes = { pos: await posicion(FABIO), gastos: await gastosEnCuadre(FABIO) }
  await gasto(ADMIN, 'ruta', { valor: 11_000, descripcion: 'Transporte (sin atribución)' })
  await deEmpresa(300, 'Papelería')
  const tras1 = { vista: descripciones(await vistaOperativa(FABIO)), pos: await posicion(FABIO), gastos: await gastosEnCuadre(FABIO) }
  metric('1) Gastos de Fabio', tras1.vista)
  metric('1) efectivo / gastos en cuadre', `${antes.pos}/${antes.gastos} → ${tras1.pos}/${tras1.gastos}`)
  assert(tras1.vista === '(ninguno)' && tras1.pos === antes.pos && tras1.gastos === 0, 'Fabio sigue viendo/pagando gastos administrativos')
  await deTrabajador(FABIO, 11_000, ADMIN)
  const tras2 = { vista: descripciones(await vistaOperativa(FABIO)), pos: await posicion(FABIO), gastos: await gastosEnCuadre(FABIO) }
  metric('2) Gastos de Fabio', tras2.vista)
  metric('2) efectivo / gastos en cuadre', `${tras2.pos}/${tras2.gastos}`)
  assert(tras2.vista === 'Transporte Fabio 11000' && tras2.pos === 89_000 && tras2.gastos === 11_000, 'el gasto atribuido a Fabio no le aparece o no le descuenta')
})

// ============================================================
// Informe
// ============================================================
console.log('\n════════════════════════════════════════════════════════════════')
console.log('  RUTACASH · CLASIFICACIÓN DE GASTOS (punto 9)')
console.log('════════════════════════════════════════════════════════════════')
for (const r of results) {
  console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id}  ${r.desc}`)
  for (const m of r.metrics) console.log(`          · ${m}`)
  if (r.error) console.log(`          ✗ ${r.error}`)
}
const fallidos = results.filter(r => !r.passed).length
console.log(`\n  ${results.length - fallidos}/${results.length} casos OK`)
if (fallidos > 0) process.exit(1)
