// ============================================================
// RUTACASH — SUITE DE CAJA DEL TRABAJADOR (DEXIE REAL, MISMA INDEXEDDB)
// ------------------------------------------------------------
//   npm run test:workercash
//
// Ejecuta los SERVICIOS DE PRODUCCIÓN sobre el singleton `db` real (Dexie +
// fake-indexeddb). Es exactamente el escenario de las pruebas del socio: UN solo
// equipo, UN navegador, UNA base `RutaCashDB` que comparten todas las sesiones.
//
// Familias:
//   SUP-RESP-*        regla definitiva: el Supervisor que registra = responsable.
//   LOCAL-SYNC-*      lo que registra Cobrador/Supervisor lo ve el Admin.
//   CASH-SETTLEMENT-* cuadre real por trabajador (Route + persona + periodo).
//   SMOKE-*           recorridos de extremo a extremo pedidos por el socio.
//
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import Dexie, { liveQuery } from 'dexie'
import { db } from '../src/lib/db'
import { addExpenseStamped } from '../src/services/expenseService'
import { registerPayment } from '../src/services/paymentService'
import { getCashboxSummary, getCollectorDailyCashSummary, getCollectorCashSummary } from '../src/services/cashboxEngine'
import { generateWeeklySettlementForUser } from '../src/services/weeklySettlementEngine'
import { getAdminDashboardData } from '../src/services/adminDashboardService'
import { getOfficeManagementSummary, getOfficesExecutiveSummary } from '../src/services/officeService'
import { buildReport, resolveReportRouteIds } from '../src/services/reportService'
import { authenticateUser } from '../src/services/authService'
import { correctPayment } from '../src/services/paymentCorrectionService'
import { effectivePayments } from '../src/lib/paymentState'
import { filterAccessibleRoutes } from '../src/lib/permissions'
import { hasPersonalCashbox } from '../src/lib/collectorAttribution'
import { subscribeDataChanges, mutatedTables } from '../src/lib/dataRevision'
import {
  confirmDisbursement, createDirectSale, createSaleRequest, approveSaleRequest, rejectSaleRequest,
  listPendingSaleRequestsForRoute, countPendingSaleRequestsForRoute, countPendingSaleRequestsForUser, type SaleInputs,
} from '../src/services/saleRequestService'
import {
  previewCashSettlement, closeCashSettlement, reopenCashSettlement, getPendingShortagesForUser, waitClockPast,
} from '../src/services/cashSettlementService'
import { closeCycleBlockedReason, inCycle } from '../src/lib/cashSettlementRules'
import { can } from '../src/lib/permissions'
import { today, getWeekStart, getWeekEnd } from '../src/lib/formatters'
import type { CashSettlement, Client, Payment, Sale, User } from '../src/models/types'
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

const readSource = (p: string) => fs.readFileSync(p, 'utf8')

// ============================================================
// Escenario: empresa con dos Oficinas, tres rutas y un equipo completo
// ============================================================
const T = 't-caribe'
const OF_LETICIA = 'of-leticia'
const OF_RIO = 'of-rio'
const R_NORTE = 'r-norte'     // Oficina Leticia
const R_SUR = 'r-sur'         // Oficina Río
const R_LIBRE = 'r-libre'     // Sin Oficina
const HOY = today()
const AHORA = new Date()

const base = (id: string, nombre: string, rol: User['rol'], rutas: string[], extra: Partial<User> = {}): User => ({
  id, tenantId: T, nombre, email: `${id}@caribe.co`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  ...extra,
} as User)

const SUPER = base('u-super', 'Sonia SuperAdmin', 'superadmin', [])
const ADMIN = base('u-admin', 'Andrés Admin', 'admin', [R_NORTE, R_SUR])
const ADMIN_SUR = base('u-admin-sur', 'Alba Admin Sur', 'admin', [R_SUR])
const JUAN = base('u-juan', 'Juan Cobrador', 'cobrador', [R_NORTE, R_SUR])
const PEDRO = base('u-pedro', 'Pedro Cobrador', 'cobrador', [R_NORTE])
const LAURA = base('u-laura', 'Laura Supervisora', 'supervisor', [R_NORTE, R_SUR])
const MARTA = base('u-marta', 'Marta Supervisora', 'supervisor', [R_NORTE])
const SECRE = base('u-secre', 'Sergio Secretario', 'secretario', [R_NORTE])

let saleSeq = 0

/** Base limpia con el equipo. `cobradores` decide quién está ACTIVO en Norte. */
async function empresa(opts: { cobradoresActivosNorte?: string[] } = {}) {
  await Promise.all(db.tables.map(t => t.clear()))
  const activos = new Set(opts.cobradoresActivosNorte ?? [JUAN.id, PEDRO.id])
  await db.tenants.add({ id: T, nombre: 'Caribe', status: 'activa', plan: 'profesional', createdAt: '2026-01-01' } as never)
  await db.offices.bulkAdd([
    { id: OF_LETICIA, tenantId: T, nombre: 'Leticia', codigo: 'LET', status: 'activa', createdAt: '', updatedAt: '' },
    { id: OF_RIO, tenantId: T, nombre: 'Río', codigo: 'RIO', status: 'activa', createdAt: '', updatedAt: '' },
  ] as never[])
  await db.routes.bulkAdd([
    { id: R_NORTE, tenantId: T, officeId: OF_LETICIA, nombre: 'Norte', codigo: 'N-1', status: 'activa', cobradorId: JUAN.id, capitalInicial: 0, capitalActual: 0, createdAt: '2026-09-01' },
    { id: R_SUR, tenantId: T, officeId: OF_RIO, nombre: 'Sur', codigo: 'S-1', status: 'activa', cobradorId: JUAN.id, capitalInicial: 0, capitalActual: 0, createdAt: '2026-09-01' },
    { id: R_LIBRE, tenantId: T, nombre: 'Libre', codigo: 'L-1', status: 'activa', capitalInicial: 0, capitalActual: 0, createdAt: '2026-09-01' },
  ] as never[])
  const equipo = [SUPER, ADMIN, ADMIN_SUR, JUAN, PEDRO, LAURA, MARTA, SECRE].map(u =>
    (u.rol === 'cobrador' && u.authorizedRouteIds?.includes(R_NORTE) && !activos.has(u.id))
      ? { ...u, status: 'inactivo' as const } : u)
  await db.users.bulkAdd(equipo)
  // Capital para que la Base no parta en negativo.
  await db.capitalMovements.bulkAdd([
    { id: 'cap-n', tenantId: T, routeId: R_NORTE, tipo: 'ingresoCapital', valor: 10_000_000, fecha: '2026-09-01', createdAt: '' },
    { id: 'cap-s', tenantId: T, routeId: R_SUR, tipo: 'ingresoCapital', valor: 10_000_000, fecha: '2026-09-01', createdAt: '' },
  ] as never[])
}

/** Venta activa y desembolsada con parcelas, lista para cobrar. */
async function venta(routeId: string, total = 2_000_000, cuotas = 10): Promise<Sale> {
  const n = ++saleSeq
  const sale = {
    id: `sale-${n}`, tenantId: T, routeId, clientId: `cli-${n}`, createdByUserId: ADMIN.id,
    valorVenta: total, tasaInteres: 0, valorInteres: 0, valorTotal: total, saldo: total,
    numeroCuotas: cuotas, valorCuota: total / cuotas, frecuenciaPago: 'diaria',
    fechaInicio: '2026-09-01', fechaFinalEstimada: '2026-12-31', status: 'activa',
    disbursementStatus: 'desembolsado', fechaDesembolso: '2026-09-01',
    createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:00:00.000Z',
  } as unknown as Sale
  await db.clients.add({ id: sale.clientId, tenantId: T, routeId, nombre: `Cliente ${n}`, documento: String(n), status: 'activo', createdAt: '' } as never)
  await db.sales.add(sale)
  await db.installments.bulkAdd(Array.from({ length: cuotas }, (_, i) => ({
    id: `${sale.id}-i${i + 1}`, saleId: sale.id, numero: i + 1, valor: total / cuotas, pagado: 0,
    saldo: total / cuotas, status: 'pendiente', fechaVencimiento: '2026-12-31', diasMora: 0,
  })) as never[])
  return sale
}

async function pagar(actor: User, sale: Sale, valor: number, extra: { collectorId?: string; fecha?: string } = {}) {
  const res = await registerPayment({ saleId: sale.id, requestedAmount: valor, actor, fecha: extra.fecha ?? HOY, collectorId: extra.collectorId })
  if (!res.ok) throw new Error(`pago rechazado (${actor.nombre}): ${res.code} — ${res.message}`)
  return (await db.payments.get(res.paymentId)) as Payment
}

const miEfectivo = async (userId: string, routeId = R_NORTE, fecha = HOY) =>
  (await getCollectorDailyCashSummary({ routeId, collectorId: userId, fecha })).efectivoAEntregar

/** "Logout + login": se cierra la conexión y el Admin entra con credenciales reales. */
async function reingresarComo(u: User): Promise<User> {
  db.close()
  await db.open()
  const auth = await authenticateUser(u.email, u.password)
  if (!auth.ok) throw new Error(`login fallido: ${auth.code}`)
  return auth.user
}

async function reportePagos(user: User, routeId = '') {
  const accessible = new Set(filterAccessibleRoutes(user, await db.routes.where('tenantId').equals(T).toArray()).map(r => r.id))
  const [payments, sales, expenses, clients, routes, categories] = await Promise.all([
    db.payments.where('tenantId').equals(T).toArray(), db.sales.where('tenantId').equals(T).toArray(),
    db.expenses.where('tenantId').equals(T).toArray(), db.clients.where('tenantId').equals(T).toArray(),
    db.routes.where('tenantId').equals(T).toArray(), db.expenseCategories.toArray(),
  ])
  const rows = buildReport('pagos', { payments, sales, expenses, clients, routes, categories },
    { routeIds: resolveReportRouteIds(accessible, routeId), fechaDesde: HOY, fechaHasta: HOY })
  return rows.reduce((s, r) => s + Number(r.Valor), 0)
}

const semana = () => ({ semanaInicio: getWeekStart(AHORA), semanaFin: getWeekEnd(AHORA) })
/** El rango semanal por defecto (lunes→sábado) no contiene el domingo: se usa HOY→HOY si hoy es domingo. */
const rangoQueContieneHoy = () => {
  const s = semana()
  return HOY >= s.semanaInicio && HOY <= s.semanaFin ? s : { semanaInicio: HOY, semanaFin: HOY }
}

// ############################################################
// FAMILIA — SUP-RESP · REGLA DEFINITIVA DEL SUPERVISOR
// ############################################################

for (const [id, activos, etiqueta] of [
  ['SUP-RESP-002', [JUAN.id], '1 Cobrador activo'],
  ['SUP-RESP-003', [JUAN.id, PEDRO.id], '2 Cobradores activos'],
  ['SUP-RESP-004', [], '0 Cobradores activos'],
] as const) {
  await spec(id, 'Supervisor', `Supervisor con ${etiqueta} → responsable = Supervisor`, async () => {
    await empresa({ cobradoresActivosNorte: [...activos] })
    const sale = await venta(R_NORTE)
    const res = await registerPayment({ saleId: sale.id, requestedAmount: 300_000, actor: LAURA, fecha: HOY })
    metric('resultado', res.ok ? `ACEPTADO (${res.collectorSource})` : res.code)
    assert(res.ok, `el pago del Supervisor fue rechazado: ${res.ok ? '' : res.code}`)
    const p = (await db.payments.get(res.paymentId)) as Payment
    metric('createdByUserId', p.createdByUserId)
    metric('collectorId', p.collectorId)
    assert(p.createdByUserId === LAURA.id && p.collectorId === LAURA.id, 'autor y responsable deben ser Laura')
    assert(res.collectorSource === 'actor', 'el Supervisor responde por ser quien cobra')
  })
}

await spec('SUP-RESP-001', 'Supervisor', 'Supervisor registra pago → responsable = Supervisor (sin indicar a nadie)', async () => {
  await empresa()
  const p = await pagar(LAURA, await venta(R_NORTE), 300_000)
  metric('Payment', `id=${p.id} route=${p.routeId} collector=${p.collectorId} createdBy=${p.createdByUserId} valor=${p.valor} fecha=${p.fecha}`)
  assert(p.collectorId === LAURA.id && p.createdByUserId === LAURA.id, 'el responsable no es la Supervisora')
})

await spec('SUP-RESP-005', 'Supervisor', 'el Supervisor NO ve CollectorPicker ni la opción "Yo"', () => {
  const picker = readSource('src/components/ui/CollectorPicker.tsx')
  const oculto = picker.includes('if (!user || actorRespondePorSiMismo) return null')
  const predicado = picker.includes('hasPersonalCashbox(user!.rol)')
  metric('return null para rol con caja personal', oculto)
  metric('decisión con hasPersonalCashbox', predicado)
  metric('hasPersonalCashbox(supervisor)', hasPersonalCashbox('supervisor'))
  assert(oculto && predicado && hasPersonalCashbox('supervisor'), 'el Supervisor sigue viendo el selector')
  assert(!picker.includes('Yo —'), 'sigue existiendo la opción "Yo — {nombre}"')
})

await spec('SUP-RESP-006', 'Supervisor', 'el Cobrador sigue siendo responsable automático', async () => {
  await empresa()
  const p = await pagar(JUAN, await venta(R_NORTE), 100_000)
  const desvio = await registerPayment({ saleId: p.saleId, requestedAmount: 1_000, actor: JUAN, collectorId: PEDRO.id, fecha: HOY })
  metric('collectorId', p.collectorId)
  metric('Cobrador intenta cargar a Pedro', desvio.ok ? 'ACEPTADO — ERROR' : desvio.code)
  assert(p.collectorId === JUAN.id && p.createdByUserId === JUAN.id, 'el Cobrador no quedó responsable')
  assert(!desvio.ok && desvio.code === 'COLLECTOR_INVALID', 'un Cobrador no puede cargar su cobro a otro')
})

await spec('SUP-RESP-007', 'Supervisor', 'Admin no adquiere caja personal', async () => {
  await empresa({ cobradoresActivosNorte: [JUAN.id] })
  const sale = await venta(R_NORTE)
  const propio = await registerPayment({ saleId: sale.id, requestedAmount: 1_000, actor: ADMIN, collectorId: ADMIN.id, fecha: HOY })
  const auto = await registerPayment({ saleId: sale.id, requestedAmount: 1_000, actor: ADMIN, fecha: HOY })
  metric('Admin indicándose a sí mismo', propio.ok ? 'ACEPTADO — ERROR' : propio.code)
  metric('Admin sin indicar (1 cobrador)', auto.ok ? `${auto.collectorId} (${auto.collectorSource})` : auto.code)
  assert(!hasPersonalCashbox('admin') && !hasPersonalCashbox('superadmin'), 'Admin/SuperAdmin no tienen caja personal')
  assert(!propio.ok && propio.code === 'COLLECTOR_INVALID', 'el Admin se atribuyó el efectivo')
  assert(auto.ok && auto.collectorId === JUAN.id, 'con un único cobrador el Admin lo preselecciona, no se autoasigna')
})

await spec('SUP-RESP-008', 'Supervisor', 'pago del Supervisor afecta "Mi efectivo" del Supervisor', async () => {
  await empresa()
  await pagar(LAURA, await venta(R_NORTE), 300_000)
  const laura = await miEfectivo(LAURA.id)
  metric('Mi efectivo Laura', laura)
  assert(laura === 300_000, `Laura debía tener 300.000, tiene ${laura}`)
})

await spec('SUP-RESP-009', 'Supervisor', 'pago del Supervisor NO afecta "Mi efectivo" del Cobrador', async () => {
  await empresa()
  await pagar(LAURA, await venta(R_NORTE), 300_000)
  const juan = await miEfectivo(JUAN.id)
  metric('Mi efectivo Juan', juan)
  assert(juan === 0, `Juan no cobró nada y tiene ${juan}`)
})

// ############################################################
// FAMILIA — LOCAL-SYNC · COBRADOR / SUPERVISOR → ADMIN EN LA MISMA INDEXEDDB
// ############################################################

await spec('LOCAL-SYNC-000', 'Misma base', 'todas las sesiones usan la MISMA IndexedDB (RutaCashDB)', async () => {
  await empresa()
  const p = await pagar(JUAN, await venta(R_NORTE), 100_000)
  // Otra "sesión" = otra instancia Dexie abierta sobre el mismo nombre.
  const { RutaCashDB } = await import('../src/lib/db')
  const otra = new RutaCashDB()
  await otra.open()
  const visto = await otra.payments.get(p.id)
  metric('nombre de la base', db.name)
  metric('versión de esquema', db.verno)
  metric('pago visto desde otra conexión', visto ? `${visto.id} · ${visto.valor}` : 'NO')
  otra.close()
  assert(db.name === 'RutaCashDB', 'el nombre de la base no es fijo')
  assert(visto?.valor === 100_000, 'otra conexión a la misma base no ve el pago')
  // El nombre NO depende del usuario ni de la empresa: una sola base por origen.
  const fuente = readSource('src/lib/db.ts')
  assert(fuente.includes("super('RutaCashDB')"), 'el nombre de la base debe ser constante')
})

await spec('LOCAL-SYNC-001', 'Cobrador → Admin', 'Cobrador registra pago y Admin lo lee desde la misma DB', async () => {
  await empresa()
  const p = await pagar(JUAN, await venta(R_NORTE), 100_000)
  const leido = (await db.payments.where('routeId').equals(R_NORTE).toArray()).find(x => x.id === p.id)
  metric('Payment', `id=${p.id} route=${p.routeId} collector=${p.collectorId} createdBy=${p.createdByUserId} valor=${p.valor} fecha=${p.fecha} createdAt=${p.createdAt}`)
  assert(leido, 'la fila no está en IndexedDB')
  const dash = await getAdminDashboardData({ user: ADMIN, tenantId: T, now: AHORA })
  metric('Dashboard Admin · recaudo hoy', dash.recaudoHoy)
  assert(dash.recaudoHoy === 100_000, 'el Dashboard del Admin no refleja el pago del Cobrador')
})

await spec('LOCAL-SYNC-002', 'Supervisor → Admin', 'Supervisor registra pago y Admin lo lee desde la misma DB', async () => {
  await empresa()
  const p = await pagar(LAURA, await venta(R_NORTE), 300_000)
  metric('Payment', `id=${p.id} route=${p.routeId} collector=${p.collectorId} createdBy=${p.createdByUserId} valor=${p.valor} fecha=${p.fecha}`)
  const dash = await getAdminDashboardData({ user: ADMIN, tenantId: T, now: AHORA })
  metric('Dashboard Admin · recaudo hoy', dash.recaudoHoy)
  assert(dash.recaudoHoy === 300_000, 'el Dashboard del Admin no refleja el pago del Supervisor')
})

await spec('LOCAL-SYNC-003', 'Supervisor → Admin', 'el pago del Supervisor entra al total de la Route', async () => {
  await empresa()
  await pagar(LAURA, await venta(R_NORTE), 300_000)
  const caja = await getCashboxSummary(R_NORTE, HOY, HOY)
  metric('Caja Norte · cobros hoy', caja.cobros)
  assert(caja.cobros === 300_000, 'la caja de la ruta no suma el cobro del Supervisor')
})

await spec('LOCAL-SYNC-004', 'Supervisor → Admin', 'el pago del Supervisor entra al reporte administrativo', async () => {
  await empresa()
  await pagar(LAURA, await venta(R_NORTE), 300_000)
  await pagar(JUAN, await venta(R_NORTE), 100_000)
  const total = await reportePagos(ADMIN)
  metric('Reporte "Pagos recibidos" Admin', total)
  assert(total === 400_000, `el reporte debía sumar 400.000, suma ${total}`)
})

await spec('LOCAL-SYNC-005', 'Supervisor → Admin', 'el pago del Supervisor entra al preview de WeeklySettlement', async () => {
  await empresa()
  await pagar(LAURA, await venta(R_NORTE), 300_000)
  const prev = await generateWeeklySettlementForUser({ user: ADMIN, tenantId: T, routeId: R_NORTE, ...rangoQueContieneHoy() })
  metric('preview · cobros', prev?.cobros)
  assert(prev?.cobros === 300_000, 'la liquidación no recibe el pago del Supervisor')
})

await spec('LOCAL-SYNC-006', 'Sesión', 'cambio de sesión Cobrador → Admin no pierde el pago', async () => {
  await empresa()
  const cobrador = await reingresarComo(JUAN)
  await pagar(cobrador, await venta(R_NORTE), 100_000)
  const admin = await reingresarComo(ADMIN)
  const dash = await getAdminDashboardData({ user: admin, tenantId: admin.tenantId, now: AHORA })
  metric('login Cobrador → pago → logout → login Admin · recaudo hoy', dash.recaudoHoy)
  assert(dash.recaudoHoy === 100_000, 'tras el cambio de sesión el Admin no ve el pago')
})

await spec('LOCAL-SYNC-007', 'Sesión', 'cambio de sesión Supervisor → Admin no pierde el pago', async () => {
  await empresa()
  const sup = await reingresarComo(LAURA)
  await pagar(sup, await venta(R_NORTE), 300_000)
  const admin = await reingresarComo(ADMIN)
  const dash = await getAdminDashboardData({ user: admin, tenantId: admin.tenantId, now: AHORA })
  metric('login Supervisor → pago → logout → login Admin · recaudo hoy', dash.recaudoHoy)
  assert(dash.recaudoHoy === 300_000, 'tras el cambio de sesión el Admin no ve el pago del Supervisor')
})

await spec('LOCAL-SYNC-008', 'Alcance', 'filtro de Oficina correcto no excluye el pago de una Route visible', async () => {
  await empresa()
  await pagar(LAURA, await venta(R_NORTE), 300_000)
  const leticia = await getOfficeManagementSummary({ user: ADMIN, tenantId: T, officeId: OF_LETICIA })
  const recaudo = leticia?.routeOps.reduce((s, r) => s + r.recaudadoHoy, 0)
  metric('Oficina Leticia · recaudado hoy', recaudo)
  assert(recaudo === 300_000, 'la Oficina de la ruta no refleja el cobro')
})

await spec('LOCAL-SYNC-009', 'Alcance', 'filtro de Route correcto no mezcla Routes', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 100_000)
  await pagar(JUAN, await venta(R_SUR), 70_000)
  const norte = await reportePagos(ADMIN, R_NORTE)
  const sur = await reportePagos(ADMIN, R_SUR)
  const cajaSur = await getCashboxSummary(R_SUR, HOY, HOY)
  const soloSur = await reportePagos(ADMIN_SUR)
  metric('reporte Norte', norte)
  metric('reporte Sur', sur)
  metric('caja Sur', cajaSur.cobros)
  metric('Admin solo-Sur (todas sus rutas)', soloSur)
  assert(norte === 100_000 && sur === 70_000 && cajaSur.cobros === 70_000, 'las rutas se mezclaron')
  assert(soloSur === 70_000, 'un Admin de Sur vio el cobro de Norte')
})

await spec('LOCAL-SYNC-010', 'Reactividad', 'una vista reactiva observa el cambio en la misma IndexedDB', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  const avisos: string[][] = []
  const cancelar = subscribeDataChanges(['payments'], tablas => avisos.push([...tablas]))
  await pagar(JUAN, sale, 50_000)
  await new Promise(r => setTimeout(r, 20))
  cancelar()
  await pagar(JUAN, sale, 10_000)          // ya sin suscripción: no debe avisar
  await new Promise(r => setTimeout(r, 20))
  metric('avisos recibidos', avisos.length)
  metric('tablas del aviso', avisos[0]?.join(', '))
  assert(avisos.length === 1, `se esperaba 1 aviso, llegaron ${avisos.length}`)
  assert(avisos[0].includes('payments') && avisos[0].includes('installments'), 'el aviso debe identificar las tablas tocadas')
  // Y las pantallas críticas lo usan.
  const conRevision = [
    'src/pages/admin/DashboardPage.tsx', 'src/components/ui/OfficesExecutivePanel.tsx',
    'src/pages/admin/CashboxPage.tsx', 'src/pages/admin/OfficeDetailPage.tsx',
    'src/pages/admin/WeeklySettlementPage.tsx', 'src/pages/admin/ActiveSalesPage.tsx',
    'src/pages/collector/CollectorCashClosePage.tsx',
  ]
  const faltan = conRevision.filter(f => !readSource(f).includes('useDataRevision()'))
  metric('pantallas sin refresco', faltan.length ? faltan.join(', ') : 'ninguna')
  assert(faltan.length === 0, `pantallas críticas sin refresco: ${faltan.join(', ')}`)
  assert(mutatedTables({ 'idb://RutaCashDB/payments/': 1, 'idb://RutaCashDB/sales/routeId': 1 }).size === 2, 'parser de claves roto')
})

await spec('LOCAL-SYNC-011', 'Remontaje', 'pago del Supervisor visible al volver a montar el Dashboard Admin', async () => {
  await empresa()
  const antes = await getAdminDashboardData({ user: ADMIN, tenantId: T, now: AHORA })
  await pagar(LAURA, await venta(R_NORTE), 300_000)
  const despues = await getAdminDashboardData({ user: ADMIN, tenantId: T, now: AHORA })
  metric('recaudo hoy (montaje 1 → montaje 2)', `${antes.recaudoHoy} → ${despues.recaudoHoy}`)
  metric('top rutas', despues.topRoutes.map(t => `${t.nombre}:${t.cobrado}`).join(', ') || '—')
  assert(despues.recaudoHoy - antes.recaudoHoy === 300_000, 'el remontaje no refleja el pago del Supervisor')
})

await spec('LOCAL-SYNC-012', 'Remontaje', 'pago del Cobrador visible al volver a montar el Dashboard Admin', async () => {
  await empresa()
  const antes = await getAdminDashboardData({ user: SUPER, tenantId: T, now: AHORA })
  await pagar(JUAN, await venta(R_NORTE), 100_000)
  const despues = await getAdminDashboardData({ user: SUPER, tenantId: T, now: AHORA })
  metric('SuperAdmin · recaudo hoy (montaje 1 → montaje 2)', `${antes.recaudoHoy} → ${despues.recaudoHoy}`)
  assert(despues.recaudoHoy - antes.recaudoHoy === 100_000, 'el remontaje no refleja el pago del Cobrador')
})

await spec('LOCAL-SYNC-013', 'Liquidación', 'WeeklySettlement preview incluye ambos (Cobrador + Supervisor)', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 100_000)
  await pagar(LAURA, await venta(R_NORTE), 300_000)
  const prev = await generateWeeklySettlementForUser({ user: ADMIN, tenantId: T, routeId: R_NORTE, ...rangoQueContieneHoy() })
  metric('preview · cobros', prev?.cobros)
  assert(prev?.cobros === 400_000, `debía sumar 400.000, suma ${prev?.cobros}`)
})

await spec('LOCAL-SYNC-014', 'Oficina', 'Dashboard de Office incluye ambos si la Route pertenece a la Office', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 100_000)
  await pagar(LAURA, await venta(R_NORTE), 300_000)
  await pagar(LAURA, await venta(R_SUR), 50_000)
  const exec = await getOfficesExecutiveSummary({ user: ADMIN, tenantId: T })
  const fila = (id: string) => exec?.rows.find(r => r.officeId === id)
  metric('filas', exec?.rows.map(r => `${r.officeId}:${r.totals.recaudadoHoy}`).join(', '))
  assert(fila(OF_LETICIA)?.totals.recaudadoHoy === 400_000, 'Leticia debía mostrar 400.000')
  assert(fila(OF_RIO)?.totals.recaudadoHoy === 50_000, 'Río debía mostrar 50.000')
})

await spec('LOCAL-SYNC-015', 'Alcance', 'filtros de Office/Route no excluyen movimientos válidos por rol del responsable', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  await pagar(JUAN, sale, 100_000)
  await pagar(LAURA, sale, 300_000)
  await pagar(ADMIN, sale, 20_000, { collectorId: PEDRO.id })
  const porResponsable = (await db.payments.toArray()).map(p => `${p.collectorId}:${p.valor}`).join(', ')
  const dash = await getAdminDashboardData({ user: ADMIN, tenantId: T, now: AHORA })
  const caja = await getCashboxSummary(R_NORTE, HOY, HOY)
  const rep = await reportePagos(ADMIN, R_NORTE)
  metric('pagos por responsable', porResponsable)
  metric('Dashboard / Caja / Reporte', `${dash.recaudoHoy} / ${caja.cobros} / ${rep}`)
  assert(dash.recaudoHoy === 420_000 && caja.cobros === 420_000 && rep === 420_000, 'alguna vista filtra por rol del responsable')
})

await spec('LOCAL-SYNC-016', 'Semántica', 'la suma bruta del Dashboard equivale a effectivePayments() con correcciones', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  const p = await pagar(JUAN, sale, 100_000)
  const corr = await correctPayment(SUPER, p.id, { newValor: 80_000, reason: 'error de digitación' })
  metric('corrección', corr.success ? 'aplicada' : corr.error)
  assert(corr.success, `la corrección falló: ${corr.error}`)
  const pagos = await db.payments.where('routeId').equals(R_NORTE).toArray()
  const bruto = pagos.filter(x => x.fecha === HOY).reduce((s, x) => s + x.valor, 0)
  const vigente = effectivePayments(pagos).filter(x => x.fecha === HOY).reduce((s, x) => s + x.valor, 0)
  const dash = await getAdminDashboardData({ user: ADMIN, tenantId: T, now: AHORA })
  metric('filas (valor/state)', pagos.map(x => `${x.valor}/${x.state}`).join(', '))
  metric('bruto / vigente / dashboard', `${bruto} / ${vigente} / ${dash.recaudoHoy}`)
  assert(pagos.length === 3, 'la corrección debía dejar original + reversión + corrección')
  assert(bruto === 80_000 && vigente === 80_000 && dash.recaudoHoy === 80_000, 'la suma bruta diverge de effectivePayments')
})

// ############################################################
// BLOQUE C — CUADRE REAL POR TRABAJADOR (CashSettlement)
// ############################################################
const tick = (ms = 4) => new Promise(r => setTimeout(r, ms))

/** Desembolso REAL (servicio de producción) de una venta nueva, por `actor`. */
async function desembolsar(actor: User, routeId: string, valor: number): Promise<Sale> {
  const n = ++saleSeq
  const sale = {
    id: `sale-d${n}`, tenantId: T, routeId, clientId: `cli-d${n}`, createdByUserId: actor.id,
    valorVenta: valor, tasaInteres: 0, valorInteres: 0, valorTotal: valor, saldo: valor,
    numeroCuotas: 1, valorCuota: valor, frecuenciaPago: 'diaria', fechaInicio: HOY, fechaFinalEstimada: HOY,
    status: 'activa', disbursementStatus: 'pendiente', createdAt: new Date().toISOString(), updatedAt: '',
  } as unknown as Sale
  await db.sales.add(sale)
  await confirmDisbursement(sale.id, actor)
  return (await db.sales.get(sale.id)) as Sale
}

/** Gasto con la MISMA forma que escribe CollectorExpensesPage. */
async function gastar(actor: User, routeId: string, valor: number) {
  await db.expenses.add({
    id: `exp-${Math.random().toString(36).slice(2)}`, tenantId: T, routeId, categoryId: 'cat-1', valor,
    fecha: HOY, userId: actor.id, collectorId: hasPersonalCashbox(actor.rol) ? actor.id : undefined,
    syncStatus: 'synced', createdAt: new Date().toISOString(),
  })
}

const previewDe = (userId: string, routeId = R_NORTE, actor: User = ADMIN) =>
  previewCashSettlement({ actor, tenantId: T, routeId, userId })

async function cerrar(userId: string, entregado: number, opts: { actor?: User; routeId?: string; motivo?: string } = {}) {
  await tick()
  const doc = await closeCashSettlement({
    actor: opts.actor ?? ADMIN, tenantId: T, routeId: opts.routeId ?? R_NORTE, userId, entregado, motivo: opts.motivo,
  })
  await tick()
  return doc
}

async function rechazo(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'ACEPTADO' } catch (e) { return e instanceof Error ? e.message : String(e) }
}

const snapshot = async () => ({
  payments: JSON.stringify(await db.payments.toArray()),
  sales: JSON.stringify(await db.sales.toArray()),
  expenses: JSON.stringify(await db.expenses.toArray()),
})

await spec('CASH-SETTLEMENT-001', 'Cuadre', 'el primer cuadre arranca con arrastre 0 desde el inicio del modelo', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 100_000)
  const p = await previewDe(JUAN.id)
  metric('origen / desde', `${p.origenDesde} / ${p.desde}`)
  metric('arrastre', p.arrastreAnterior)
  assert(p.arrastreAnterior === 0 && p.origenDesde === 'inicio-modelo', 'el primer ciclo debe partir de 0 y del inicio del modelo')
})

await spec('CASH-SETTLEMENT-002', 'Cuadre', 'el pago del trabajador entra al esperado', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 250_000)
  const p = await previewDe(JUAN.id)
  metric('recaudado / esperado', `${p.recaudado} / ${p.esperado}`)
  assert(p.recaudado === 250_000 && p.esperado === 250_000, 'el cobro del trabajador no entró')
})

await spec('CASH-SETTLEMENT-003', 'Cuadre', 'createdBy distinto pero collectorId = trabajador → entra', async () => {
  await empresa()
  await pagar(ADMIN, await venta(R_NORTE), 90_000, { collectorId: JUAN.id })
  const pago = (await db.payments.toArray())[0]
  const p = await previewDe(JUAN.id)
  metric('createdBy / collector', `${pago.createdByUserId} / ${pago.collectorId}`)
  metric('recaudado Juan', p.recaudado)
  assert(pago.createdByUserId === ADMIN.id && p.recaudado === 90_000, 'el cuadre debe seguir al RESPONSABLE, no al autor')
})

await spec('CASH-SETTLEMENT-004', 'Cuadre', 'el pago de otro responsable NO entra', async () => {
  await empresa()
  await pagar(PEDRO, await venta(R_NORTE), 80_000)
  await pagar(LAURA, await venta(R_NORTE), 300_000)
  const p = await previewDe(JUAN.id)
  metric('recaudado Juan', p.recaudado)
  assert(p.recaudado === 0, 'se cargó a Juan dinero de otros')
})

await spec('CASH-SETTLEMENT-005', 'Cuadre', 'el desembolso del trabajador resta', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 500_000)
  const s = await desembolsar(JUAN, R_NORTE, 200_000)
  const p = await previewDe(JUAN.id)
  metric('disbursedAt / disbursedByCollectorId', `${s.disbursedAt} / ${s.disbursedByCollectorId}`)
  metric('desembolsado / esperado', `${p.desembolsado} / ${p.esperado}`)
  assert(Boolean(s.disbursedAt), 'confirmDisbursement debe sellar el instante')
  assert(p.desembolsado === 200_000 && p.esperado === 300_000, '500.000 − 200.000 debía dar 300.000')
})

await spec('CASH-SETTLEMENT-006', 'Cuadre', 'el gasto del trabajador resta', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 500_000)
  await gastar(JUAN, R_NORTE, 40_000)
  const p = await previewDe(JUAN.id)
  metric('gastos / esperado', `${p.gastos} / ${p.esperado}`)
  assert(p.gastos === 40_000 && p.esperado === 460_000, '500.000 − 40.000 debía dar 460.000')
})

await spec('CASH-SETTLEMENT-007', 'Cuadre', 'cuadre exacto: diferencia 0 y el siguiente ciclo parte en 0', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 1_000_000)
  const doc = await cerrar(JUAN.id, 1_000_000)
  const next = await previewDe(JUAN.id)
  metric('esperado / entregado / diferencia', `${doc.esperado} / ${doc.entregado} / ${doc.diferencia}`)
  metric('siguiente ciclo · arrastre / esperado', `${next.arrastreAnterior} / ${next.esperado}`)
  assert(doc.diferencia === 0 && doc.faltante === 0 && doc.sobrante === 0, 'el cuadre exacto no dio 0')
  assert(next.arrastreAnterior === 0 && next.esperado === 0 && next.origenDesde === 'ultimo-cierre', 'el siguiente ciclo no partió de 0')
})

await spec('CASH-SETTLEMENT-008', 'Cuadre', 'faltante: diferencia negativa persistida con motivo', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 1_000_000)
  const doc = await cerrar(JUAN.id, 900_000, { motivo: 'faltaron billetes en la entrega' })
  metric('diferencia / faltante', `${doc.diferencia} / ${doc.faltante}`)
  assert(doc.diferencia === -100_000 && doc.faltante === 100_000 && doc.sobrante === 0, 'el faltante no quedó registrado')
  assert((await db.cashSettlements.get(doc.id))?.faltante === 100_000, 'el faltante no se persistió')
})

await spec('CASH-SETTLEMENT-009', 'Cuadre', 'el faltante se arrastra POSITIVO al siguiente esperado', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  await pagar(JUAN, sale, 1_000_000)
  await cerrar(JUAN.id, 900_000, { motivo: 'faltaron billetes en la entrega' })
  await pagar(JUAN, sale, 300_000)
  const p = await previewDe(JUAN.id)
  metric('arrastre / recaudado / esperado', `${p.arrastreAnterior} / ${p.recaudado} / ${p.esperado}`)
  assert(p.arrastreAnterior === 100_000, `el arrastre debía ser +100.000, es ${p.arrastreAnterior}`)
  assert(p.esperado === 400_000, `100.000 + 300.000 debía dar 400.000, dio ${p.esperado}`)
})

await spec('CASH-SETTLEMENT-010', 'Cuadre', 'sobrante: se registra con motivo y NO se vuelve crédito', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  await pagar(JUAN, sale, 1_000_000)
  const doc = await cerrar(JUAN.id, 1_050_000, { motivo: 'cliente pagó de más, se devolverá' })
  await pagar(JUAN, sale, 200_000)
  const next = await previewDe(JUAN.id)
  metric('diferencia / sobrante', `${doc.diferencia} / ${doc.sobrante}`)
  metric('siguiente ciclo · arrastre / esperado', `${next.arrastreAnterior} / ${next.esperado}`)
  assert(doc.sobrante === 50_000 && doc.faltante === 0 && doc.motivo, 'el sobrante no quedó registrado y motivado')
  assert(next.arrastreAnterior === 0 && next.esperado === 200_000, 'el sobrante se compensó automáticamente')
})

await spec('CASH-SETTLEMENT-011', 'Cuadre', 'una diferencia exige motivo (≥10 caracteres)', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 1_000_000)
  const sin = await rechazo(() => closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R_NORTE, userId: JUAN.id, entregado: 900_000 }))
  const corto = await rechazo(() => closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R_NORTE, userId: JUAN.id, entregado: 900_000, motivo: 'falta' }))
  metric('sin motivo', sin)
  metric('motivo corto', corto)
  assert(/motivo/i.test(sin) && /motivo/i.test(corto), 'se aceptó una diferencia sin motivo suficiente')
  assert((await db.cashSettlements.count()) === 0, 'se escribió un cuadre pese al rechazo')
})

await spec('CASH-SETTLEMENT-012', 'Permisos', 'el Cobrador NO autocierra (ni cierra a nadie)', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 100_000)
  const propio = await rechazo(() => closeCashSettlement({ actor: JUAN, tenantId: T, routeId: R_NORTE, userId: JUAN.id, entregado: 100_000 }))
  const otro = await rechazo(() => closeCashSettlement({ actor: JUAN, tenantId: T, routeId: R_NORTE, userId: PEDRO.id, entregado: 0 }))
  metric('Juan cierra el suyo', propio)
  metric('Juan cierra el de Pedro', otro)
  assert(propio !== 'ACEPTADO' && otro !== 'ACEPTADO', 'un Cobrador pudo cerrar un cuadre')
})

await spec('CASH-SETTLEMENT-013', 'Permisos', 'el Supervisor NO autocierra', async () => {
  await empresa()
  await pagar(LAURA, await venta(R_NORTE), 300_000)
  const r = await rechazo(() => closeCashSettlement({ actor: LAURA, tenantId: T, routeId: R_NORTE, userId: LAURA.id, entregado: 300_000 }))
  metric('Laura cierra el suyo', r)
  assert(/propio cuadre/.test(r), 'el Supervisor pudo cerrar su propio cuadre')
})

await spec('CASH-SETTLEMENT-014', 'Permisos', 'el Admin cierra (y el Super Admin también)', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 100_000)
  await pagar(LAURA, await venta(R_NORTE), 50_000)
  const a = await cerrar(JUAN.id, 100_000, { actor: ADMIN })
  const s = await cerrar(LAURA.id, 50_000, { actor: SUPER })
  metric('Admin → Juan', `${a.closedByUserId} · dif ${a.diferencia}`)
  metric('SuperAdmin → Laura', `${s.closedByUserId} · dif ${s.diferencia}`)
  assert(a.closedByUserId === ADMIN.id && s.closedByUserId === SUPER.id, 'Admin/SuperAdmin no pudieron cerrar')
})

await spec('CASH-SETTLEMENT-015', 'Permisos', 'el Supervisor cierra a OTRO trabajador autorizado, no fuera de su ruta', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 120_000)
  const doc = await cerrar(JUAN.id, 120_000, { actor: MARTA })
  await pagar(JUAN, await venta(R_SUR), 70_000)
  const fuera = await rechazo(() => closeCashSettlement({ actor: MARTA, tenantId: T, routeId: R_SUR, userId: JUAN.id, entregado: 70_000 }))
  const secre = await rechazo(() => closeCashSettlement({ actor: SECRE, tenantId: T, routeId: R_NORTE, userId: PEDRO.id, entregado: 0 }))
  metric('Marta cierra a Juan en Norte', doc.closedByUserId)
  metric('Marta en Sur (no autorizada)', fuera)
  metric('Secretario', secre)
  assert(doc.closedByUserId === MARTA.id, 'el Supervisor no pudo cerrar a otro')
  assert(fuera !== 'ACEPTADO' && secre !== 'ACEPTADO', 'se cerró fuera de alcance o sin permiso')
})

await spec('CASH-SETTLEMENT-016', 'Independencia', 'dos trabajadores de la misma ruta tienen cuadres independientes', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  await pagar(JUAN, sale, 100_000)
  await pagar(LAURA, sale, 300_000)
  await cerrar(JUAN.id, 60_000, { motivo: 'entregó solo una parte hoy' })
  const laura = await previewDe(LAURA.id)
  const juan = await previewDe(JUAN.id)
  metric('Laura · arrastre / esperado', `${laura.arrastreAnterior} / ${laura.esperado}`)
  metric('Juan · arrastre / esperado', `${juan.arrastreAnterior} / ${juan.esperado}`)
  assert(laura.arrastreAnterior === 0 && laura.esperado === 300_000 && laura.origenDesde === 'inicio-modelo', 'el cuadre de Juan afectó a Laura')
  assert(juan.arrastreAnterior === 40_000 && juan.esperado === 40_000, 'el faltante de Juan no quedó en su ciclo')
})

await spec('CASH-SETTLEMENT-017', 'Independencia', 'el mismo trabajador en dos rutas tiene ciclos independientes', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 100_000)
  await pagar(JUAN, await venta(R_SUR), 70_000)
  await cerrar(JUAN.id, 100_000)
  const sur = await previewDe(JUAN.id, R_SUR)
  const norte = await previewDe(JUAN.id, R_NORTE)
  metric('Sur · origen / esperado', `${sur.origenDesde} / ${sur.esperado}`)
  metric('Norte · esperado', norte.esperado)
  assert(sur.origenDesde === 'inicio-modelo' && sur.esperado === 70_000, 'cerrar Norte alteró Sur')
  assert(norte.esperado === 0, 'Norte debía quedar en 0')
})

await spec('CASH-SETTLEMENT-018', 'Periodo', 'los movimientos anteriores al cierre no vuelven a entrar', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  await pagar(JUAN, sale, 400_000)
  await gastar(JUAN, R_NORTE, 10_000)
  await cerrar(JUAN.id, 390_000)
  await pagar(JUAN, sale, 25_000)
  const p = await previewDe(JUAN.id)
  metric('recaudado / gastos del ciclo nuevo', `${p.recaudado} / ${p.gastos}`)
  assert(p.recaudado === 25_000 && p.gastos === 0, 'movimientos ya cuadrados volvieron a contar')
})

await spec('CASH-SETTLEMENT-019', 'Periodo', 'dos cierres el mismo día se ordenan por instante', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  await pagar(JUAN, sale, 100_000)
  const a = await cerrar(JUAN.id, 100_000)
  await pagar(JUAN, sale, 30_000)
  const b = await cerrar(JUAN.id, 30_000)
  metric('cierre 1', `${a.desde} → ${a.hasta} · recaudado ${a.recaudado}`)
  metric('cierre 2', `${b.desde} → ${b.hasta} · recaudado ${b.recaudado}`)
  assert(a.hasta.slice(0, 10) === b.hasta.slice(0, 10), 'la prueba exige dos cierres el mismo día')
  assert(b.desde === a.hasta && b.hasta > a.hasta, 'el segundo ciclo no empieza en el instante del primero')
  assert(a.recaudado === 100_000 && b.recaudado === 30_000, 'los cierres del mismo día mezclaron movimientos')
})

await spec('CASH-SETTLEMENT-020', 'Periodo', 'el solapamiento con un cuadre vigente se bloquea', async () => {
  const lista = [{ id: 'x', routeId: R_NORTE, userId: JUAN.id, desde: '2026-09-20T10:00:00.000Z', hasta: '2026-09-22T10:00:00.000Z', status: 'cerrada' }] as never[]
  const solapa = closeCycleBlockedReason(lista, R_NORTE, JUAN.id, '2026-09-21T00:00:00.000Z', '2026-09-23T00:00:00.000Z')
  const borde = closeCycleBlockedReason(lista, R_NORTE, JUAN.id, '2026-09-22T10:00:00.000Z', '2026-09-23T00:00:00.000Z')
  const vacio = closeCycleBlockedReason([], R_NORTE, JUAN.id, '2026-09-22T10:00:00.000Z', '2026-09-22T10:00:00.000Z')
  metric('rango que se solapa', solapa)
  metric('rango que comparte solo el borde', borde ?? 'permitido')
  metric('rango vacío', vacio)
  assert(solapa && !borde && vacio, 'la regla de solapamiento por instantes es incorrecta')
  // Y en el servicio: dos cierres concurrentes del mismo ciclo no pueden coexistir.
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 10_000)
  await tick()
  const [r1, r2] = await Promise.all([
    rechazo(() => closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R_NORTE, userId: JUAN.id, entregado: 10_000 })),
    rechazo(() => closeCashSettlement({ actor: SUPER, tenantId: T, routeId: R_NORTE, userId: JUAN.id, entregado: 10_000 })),
  ])
  const vigentes = (await db.cashSettlements.toArray()).filter(s => s.status === 'cerrada')
  metric('dos cierres simultáneos', `${r1} | ${r2}`)
  metric('cuadres vigentes', vigentes.length)
  assert(vigentes.length === 1, 'quedaron dos cuadres vigentes solapados')
})

await spec('CASH-SETTLEMENT-021', 'Reapertura', 'reabrir exige motivo y conserva el documento (versionado)', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  await pagar(JUAN, sale, 500_000)
  const v1 = await cerrar(JUAN.id, 500_000)
  const sin = await rechazo(() => reopenCashSettlement({ actor: ADMIN, settlementId: v1.id, motivo: 'no' }))
  const sup = await rechazo(() => reopenCashSettlement({ actor: LAURA, settlementId: v1.id, motivo: 'motivo suficientemente largo' }))
  await reopenCashSettlement({ actor: ADMIN, settlementId: v1.id, motivo: 'se registró mal el entregado' })
  const reabierto = await previewDe(JUAN.id)
  const v2 = await cerrar(JUAN.id, 500_000)
  const v1Final = (await db.cashSettlements.get(v1.id))!
  metric('sin motivo', sin)
  metric('Supervisor reabre', sup)
  metric('tras reabrir · desde / esperado', `${reabierto.desde === v1.desde ? 'mismo arranque' : 'OTRO'} / ${reabierto.esperado}`)
  metric('versiones', `v1=${v1Final.status}→${v1Final.supersededBy === v2.id ? 'v2' : '?'} · v2=${v2.version}`)
  assert(/motivo/i.test(sin) && sup !== 'ACEPTADO', 'se reabrió sin motivo o sin permiso')
  assert(reabierto.desde === v1.desde && reabierto.esperado === 500_000, 'reabrir no devolvió el ciclo')
  assert(v1Final.status === 'reabierta' && v1Final.reopenReason && v1Final.supersededBy === v2.id && v2.version === 2, 'el versionado no es correcto')
})

await spec('CASH-SETTLEMENT-022', 'Reapertura', 'NO se reabre un cuadre antiguo si hay uno posterior vigente', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  await pagar(JUAN, sale, 100_000)
  const a = await cerrar(JUAN.id, 100_000)
  await pagar(JUAN, sale, 50_000)
  await cerrar(JUAN.id, 50_000)
  const r = await rechazo(() => reopenCashSettlement({ actor: ADMIN, settlementId: a.id, motivo: 'intento de reabrir el antiguo' }))
  metric('reabrir el primero', r)
  assert(/posterior/.test(r), 'se reabrió un cuadre con otro posterior vigente')
})

for (const [id, tabla] of [['CASH-SETTLEMENT-023', 'payments'], ['CASH-SETTLEMENT-024', 'sales'], ['CASH-SETTLEMENT-025', 'expenses']] as const) {
  await spec(id, 'Inmutabilidad', `cerrar (y reabrir) NO modifica ${tabla}`, async () => {
    await empresa()
    await pagar(JUAN, await venta(R_NORTE), 300_000)
    await desembolsar(JUAN, R_NORTE, 100_000)
    await gastar(JUAN, R_NORTE, 20_000)
    const antes = await snapshot()
    const doc = await cerrar(JUAN.id, 150_000, { motivo: 'faltante reconocido por el cobrador' })
    await reopenCashSettlement({ actor: ADMIN, settlementId: doc.id, motivo: 'revisión de la entrega del día' })
    const despues = await snapshot()
    metric(`${tabla} idéntica`, antes[tabla] === despues[tabla])
    assert(antes[tabla] === despues[tabla], `el cuadre modificó ${tabla}`)
  })
}

await spec('CASH-SETTLEMENT-026', 'Semántica', 'motor por rango = effectivePayments() cuando la corrección cae en el mismo ciclo', async () => {
  await empresa()
  const p = await pagar(JUAN, await venta(R_NORTE), 100_000)
  await correctPayment(SUPER, p.id, { newValor: 80_000, reason: 'valor mal digitado' })
  const pagos = await db.payments.where('routeId').equals(R_NORTE).toArray()
  const vigente = effectivePayments(pagos).filter(x => x.collectorId === JUAN.id).reduce((s, x) => s + x.valor, 0)
  const prev = await previewDe(JUAN.id)
  metric('effectivePayments / motor', `${vigente} / ${prev.recaudado}`)
  assert(vigente === 80_000 && prev.recaudado === 80_000, 'el motor por rango diverge de effectivePayments')
})

await spec('CASH-SETTLEMENT-027', 'Semántica', 'corrección en un ciclo POSTERIOR carga solo el ajuste (no cobra dos veces)', async () => {
  await empresa()
  const p = await pagar(JUAN, await venta(R_NORTE), 100_000)
  await cerrar(JUAN.id, 100_000)
  await correctPayment(SUPER, p.id, { newValor: 80_000, reason: 'valor mal digitado' })
  const prev = await previewDe(JUAN.id)
  metric('ciclo nuevo · recaudado / esperado', `${prev.recaudado} / ${prev.esperado}`)
  assert(prev.recaudado === -20_000, `debía cargarse el ajuste −20.000, se cargó ${prev.recaudado}`)
})

await spec('CASH-SETTLEMENT-028', 'Histórico', 'NO se inventa histórico: lo anterior al inicio del modelo no cuenta', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  const viejo = await pagar(JUAN, sale, 700_000)
  await tick()
  await db.tenants.update(T, { cashModelStartAt: new Date().toISOString() })
  await tick()
  await correctPayment(SUPER, viejo.id, { newValor: 650_000, reason: 'corrección de un pago histórico' })
  await pagar(JUAN, sale, 50_000)
  const p = await previewDe(JUAN.id)
  metric('recaudado del primer ciclo', p.recaudado)
  metric('cuadres existentes', await db.cashSettlements.count())
  assert(p.recaudado === 50_000, `solo debía contar lo posterior al inicio del modelo, contó ${p.recaudado}`)
})

await spec('CASH-SETTLEMENT-029', 'Mi efectivo', '"Mi efectivo" = movimientos desde el último cuadre + faltante', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  await pagar(JUAN, sale, 1_000_000)
  await cerrar(JUAN.id, 900_000, { motivo: 'faltaron billetes en la entrega' })
  await pagar(JUAN, sale, 300_000)
  const mio = await previewCashSettlement({ actor: JUAN, tenantId: T, routeId: R_NORTE, userId: JUAN.id })
  const hoy = await miEfectivo(JUAN.id)
  const ajeno = await rechazo(() => previewCashSettlement({ actor: JUAN, tenantId: T, routeId: R_NORTE, userId: PEDRO.id }))
  metric('Mi efectivo (ciclo)', mio.esperado)
  metric('Mi recaudo hoy (KPI diario)', hoy)
  metric('Juan consulta el ciclo de Pedro', ajeno)
  assert(mio.esperado === 400_000, 'Mi efectivo no refleja el faltante + lo nuevo')
  assert(hoy === 1_300_000, 'el KPI diario debe seguir siendo diario')
  assert(ajeno !== 'ACEPTADO', 'un Cobrador vio el ciclo de otro')
  const page = readSource('src/pages/collector/CollectorCashClosePage.tsx')
  assert(page.includes('previewCashSettlement(') && page.includes('Mi recaudo hoy'), 'la pantalla no separa Mi efectivo de Mi recaudo hoy')
})

await spec('CASH-SETTLEMENT-030', 'Alertas', 'Admin identifica trabajadores con faltante pendiente', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  await pagar(JUAN, sale, 1_000_000)
  await pagar(LAURA, sale, 200_000)
  await cerrar(JUAN.id, 900_000, { motivo: 'faltaron billetes en la entrega' })
  await cerrar(LAURA.id, 200_000)
  const alertas = await getPendingShortagesForUser(ADMIN, T)
  const alertasSur = await getPendingShortagesForUser(ADMIN_SUR, T)
  metric('faltantes (Admin)', alertas.map(a => `${a.userId}:${a.faltante}`).join(', '))
  metric('faltantes (Admin solo Sur)', alertasSur.length)
  assert(alertas.length === 1 && alertas[0].userId === JUAN.id && alertas[0].faltante === 100_000, 'la alerta de faltante no es correcta')
  assert(alertasSur.length === 0, 'un Admin vio faltantes de una ruta ajena')
  // Saldado en el ciclo siguiente → desaparece.
  await pagar(JUAN, sale, 300_000)
  await cerrar(JUAN.id, 400_000)
  metric('tras saldar', (await getPendingShortagesForUser(ADMIN, T)).length)
  assert((await getPendingShortagesForUser(ADMIN, T)).length === 0, 'el faltante saldado sigue alertando')
})

await spec('CASH-SETTLEMENT-031', 'Liquidación', 'WeeklySettlement conserva su significado tras cuadrar trabajadores', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 100_000)
  await pagar(LAURA, await venta(R_NORTE), 300_000)
  const antes = await generateWeeklySettlementForUser({ user: ADMIN, tenantId: T, routeId: R_NORTE, ...rangoQueContieneHoy() })
  await cerrar(JUAN.id, 50_000, { motivo: 'entregó la mitad por ahora' })
  await cerrar(LAURA.id, 300_000)
  const despues = await generateWeeklySettlementForUser({ user: ADMIN, tenantId: T, routeId: R_NORTE, ...rangoQueContieneHoy() })
  metric('cobros de la ruta antes / después', `${antes?.cobros} / ${despues?.cobros}`)
  metric('saldo final antes / después', `${antes?.saldoFinal} / ${despues?.saldoFinal}`)
  assert(antes?.cobros === 400_000 && despues?.cobros === 400_000 && antes?.saldoFinal === despues?.saldoFinal,
    'cuadrar trabajadores alteró la liquidación de la ruta')
  const engine = readSource('src/services/weeklySettlementEngine.ts')
  assert(!engine.includes('cashSettlement'), 'el motor de liquidación no debe leer cuadres de trabajadores')
})

await spec('CASH-SETTLEMENT-032', 'Permisos', 'capacidades nuevas por rol', () => {
  const tiene = (u: User, c: Parameters<typeof can>[1]) => can(u, c, { routeId: R_NORTE, tenantId: T })
  const fila = (u: User) => ['view', 'viewOwn', 'close', 'reopen'].map(c => tiene(u, `cashSettlement.${c}` as never) ? 'S' : '·').join('')
  for (const u of [SUPER, ADMIN, LAURA, JUAN, SECRE]) metric(`${u.rol.padEnd(10)} view/own/close/reopen`, fila(u))
  assert(fila(SUPER) === 'S·SS' && fila(ADMIN) === 'S·SS', 'Admin/SuperAdmin: ver, cerrar y reabrir')
  assert(fila(LAURA) === 'SSS·', 'Supervisor: ver, propio y cerrar a otros; NO reabrir')
  assert(fila(JUAN) === '·S··', 'Cobrador: solo su propio ciclo')
  assert(fila(SECRE) === '····', 'Secretario: nada')
})

// ############################################################
// SMOKES pedidos por el socio
// ############################################################
// ############################################################
// FAMILIA — CASH-BOUNDARY · FRONTERAS TEMPORALES DEL CUADRE
// ------------------------------------------------------------
// Convención ÚNICA: el ciclo es (desde, hasta] — desde EXCLUSIVO, hasta INCLUSIVO —
// y el ciclo siguiente empieza EXACTAMENTE en el `hasta` anterior. Un movimiento en
// el instante T de la frontera entra UNA sola vez: en el ciclo que termina en T.
// ############################################################
const T0 = '2026-09-24T08:00:00.000Z'
const TF = '2026-09-24T15:30:00.000Z'            // hasta de A = desde de B
const T2 = '2026-09-24T20:00:00.000Z'
const msDe = (iso: string, delta: number) => new Date(Date.parse(iso) + delta).toISOString()

let semillaSeq = 0
async function sembrarMovimiento(tipo: 'pago' | 'desembolso' | 'gasto', instante: string, valor: number, userId = JUAN.id) {
  const n = ++semillaSeq
  if (tipo === 'pago') {
    await db.payments.add({
      id: `pb-${n}`, tenantId: T, saleId: 'sale-x', clientId: 'cli-x', routeId: R_NORTE, collectorId: userId,
      createdByUserId: userId, valor, fecha: instante.slice(0, 10), tipo: 'efectivo', syncStatus: 'synced',
      createdAt: instante, state: 'active',
    } as Payment)
  } else if (tipo === 'desembolso') {
    await db.sales.add({
      id: `sb-${n}`, tenantId: T, routeId: R_NORTE, clientId: 'cli-x', createdByUserId: userId, valorVenta: valor,
      tasaInteres: 0, valorInteres: 0, valorTotal: valor, saldo: valor, numeroCuotas: 1, valorCuota: valor,
      frecuenciaPago: 'diaria', fechaInicio: instante.slice(0, 10), fechaFinalEstimada: instante.slice(0, 10),
      status: 'activa', disbursementStatus: 'desembolsado', disbursedByCollectorId: userId, disbursedByUserId: userId,
      fechaDesembolso: instante.slice(0, 10), disbursedAt: instante, createdAt: instante, updatedAt: instante,
    } as unknown as Sale)
  } else {
    await db.expenses.add({
      id: `eb-${n}`, tenantId: T, routeId: R_NORTE, categoryId: 'cat-1', valor, fecha: instante.slice(0, 10),
      userId, collectorId: userId, syncStatus: 'synced', createdAt: instante,
    })
  }
}

const ciclo = (desde: string, hasta: string, userId = JUAN.id) =>
  getCollectorCashSummary({ routeId: R_NORTE, userId, desde, hasta, modelStart: '' })

await spec('CASH-BOUNDARY-001', 'Fronteras', 'movimiento EXACTAMENTE en `hasta` de A entra en A', async () => {
  await empresa()
  await sembrarMovimiento('pago', TF, 100_000)
  const a = await ciclo(T0, TF)
  metric('A = (T0, 15:30:00.000]', `recaudado ${a.recaudado}`)
  assert(a.recaudado === 100_000, 'el movimiento de la frontera no entró en el ciclo que termina en él')
})

await spec('CASH-BOUNDARY-002', 'Fronteras', 'el mismo movimiento NO entra en B cuando B.desde === A.hasta', async () => {
  await empresa()
  await sembrarMovimiento('pago', TF, 100_000)
  const b = await ciclo(TF, T2)
  metric('B = (15:30:00.000, T2]', `recaudado ${b.recaudado}`)
  assert(b.recaudado === 0, 'el movimiento de la frontera se contó otra vez en B')
})

await spec('CASH-BOUNDARY-003', 'Fronteras', 'movimiento 1 ms DESPUÉS del cierre: no entra en A, sí en B', async () => {
  await empresa()
  await sembrarMovimiento('pago', msDe(TF, 1), 70_000)
  const a = await ciclo(T0, TF)
  const b = await ciclo(TF, T2)
  metric('A / B', `${a.recaudado} / ${b.recaudado}`)
  assert(a.recaudado === 0 && b.recaudado === 70_000, 'el movimiento posterior cayó en el ciclo equivocado')
})

await spec('CASH-BOUNDARY-004', 'Fronteras', 'movimiento 1 ms ANTES del cierre entra en A', async () => {
  await empresa()
  await sembrarMovimiento('pago', msDe(TF, -1), 40_000)
  const a = await ciclo(T0, TF)
  const b = await ciclo(TF, T2)
  metric('A / B', `${a.recaudado} / ${b.recaudado}`)
  assert(a.recaudado === 40_000 && b.recaudado === 0, 'el movimiento anterior cayó en el ciclo equivocado')
})

await spec('CASH-BOUNDARY-005', 'Fronteras', 'dos cierres REALES el mismo día no duplican ni pierden movimientos', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  const pagos = [100_000, 20_000, 35_000, 45_000]
  await pagar(JUAN, sale, pagos[0])
  await pagar(JUAN, sale, pagos[1])
  const a = await cerrar(JUAN.id, 120_000)
  await pagar(JUAN, sale, pagos[2])
  await pagar(JUAN, sale, pagos[3])
  const b = await cerrar(JUAN.id, 80_000)
  // Cada pago real cae en EXACTAMENTE uno de los ciclos archivados.
  const filas = (await db.payments.toArray()).filter(p => p.collectorId === JUAN.id)
  const enCuantos = filas.map(p => [a, b].filter(c => inCycle(p.createdAt, c.desde, c.hasta)).length)
  metric('A', `${a.desde} → ${a.hasta} · ${a.recaudado}`)
  metric('B', `${b.desde} → ${b.hasta} · ${b.recaudado}`)
  metric('ciclos por pago', enCuantos.join(', '))
  assert(a.hasta.slice(0, 10) === b.hasta.slice(0, 10) && b.desde === a.hasta, 'los cierres deben ser consecutivos y del mismo día')
  assert(enCuantos.every(n => n === 1), 'algún pago quedó en 0 o en 2 ciclos')
  assert(a.recaudado + b.recaudado === pagos.reduce((s, v) => s + v, 0), 'la suma de los ciclos no coincide con los pagos')
})

await spec('CASH-BOUNDARY-006', 'Fronteras', 'pago, desembolso y gasto aplican la MISMA frontera', async () => {
  const filas: string[] = []
  for (const tipo of ['pago', 'desembolso', 'gasto'] as const) {
    for (const [etiqueta, delta, esperadoA, esperadoB] of [['T−1ms', -1, 1, 0], ['T', 0, 1, 0], ['T+1ms', 1, 0, 1]] as const) {
      await empresa()
      await sembrarMovimiento(tipo, msDe(TF, delta), 10_000)
      const [a, b] = [await ciclo(T0, TF), await ciclo(TF, T2)]
      const campo = tipo === 'pago' ? 'recaudado' : tipo === 'desembolso' ? 'desembolsado' : 'gastos'
      const enA = a[campo] === 10_000 ? 1 : 0
      const enB = b[campo] === 10_000 ? 1 : 0
      filas.push(`${tipo}@${etiqueta}: A=${enA} B=${enB}`)
      assert(enA === esperadoA && enB === esperadoB, `${tipo} en ${etiqueta}: A=${enA} B=${enB}`)
      assert(enA + enB === 1, `${tipo} en ${etiqueta} no cayó en exactamente un ciclo`)
    }
  }
  metric('matriz', filas.join(' · '))
  const motor = readSource('src/services/cashboxEngine.ts')
  const usos = (motor.match(/inCycle\(/g) ?? []).length
  metric('usos de inCycle en el motor', usos)
  assert(usos === 3, 'los tres componentes deben filtrar con el MISMO helper')
})

await spec('CASH-BOUNDARY-007', 'Fronteras', 'un movimiento registrado JUSTO al cerrar (misma ms / otra pestaña) cae en un solo ciclo', async () => {
  // Carrera real: cierres y cobros concurrentes, sin pausas. Ningún pago puede
  // quedar fuera de todos los ciclos ni en dos.
  await empresa()
  const sale = await venta(R_NORTE, 20_000_000, 100)
  let valorTotal = 0
  const cerrados: CashSettlement[] = []
  for (let i = 0; i < 12; i++) {
    const valor = 1_000 + i
    valorTotal += valor
    const [, doc] = await Promise.all([
      pagar(JUAN, sale, valor),
      closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R_NORTE, userId: JUAN.id, entregado: 0, motivo: 'prueba de concurrencia de frontera' })
        .catch(() => null),
    ])
    if (doc) cerrados.push(doc)
    await pagar(JUAN, sale, 1).then(() => { valorTotal += 1 })   // inmediatamente después, sin pausa
  }
  const final = await previewCashSettlement({ actor: ADMIN, tenantId: T, routeId: R_NORTE, userId: JUAN.id })
  const filas = (await db.payments.toArray()).filter(p => p.collectorId === JUAN.id)
  const tramos = [...cerrados.map(c => ({ desde: c.desde, hasta: c.hasta })), { desde: final.desde, hasta: final.hasta }]
  const perdidos = filas.filter(p => tramos.every(t => !inCycle(p.createdAt, t.desde, t.hasta)))
  const dobles = filas.filter(p => tramos.filter(t => inCycle(p.createdAt, t.desde, t.hasta)).length > 1)
  const sumaCiclos = cerrados.reduce((s, c) => s + c.recaudado, 0) + final.recaudado
  metric('cierres / pagos', `${cerrados.length} / ${filas.length}`)
  metric('pagos en ningún ciclo', perdidos.map(p => p.createdAt).join(', ') || 'ninguno')
  metric('pagos en dos ciclos', dobles.length)
  metric('Σ ciclos / Σ pagos', `${sumaCiclos} / ${valorTotal}`)
  assert(perdidos.length === 0 && dobles.length === 0, 'la frontera perdió o duplicó movimientos')
  assert(sumaCiclos === valorTotal, 'la suma de los ciclos no coincide con los pagos registrados')
})

await spec('CASH-BOUNDARY-008', 'Fronteras', 'escritor con bloqueo abierto mientras arranca el cierre: el movimiento entra en A', async () => {
  // Interlocución DETERMINISTA: el gasto sella su instante dentro de su
  // transacción y, antes de confirmarlo, arranca el cierre. El cierre debe esperar
  // y contarlo (instante ≤ hasta), nunca dejarlo fuera de los dos ciclos.
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 100_000)
  await tick()
  let cierre: Promise<CashSettlement> | null = null
  await db.transaction('rw', [db.expenses], async () => {
    await db.expenses.get('bloqueo')
    const sello = new Date().toISOString()
    cierre = Dexie.ignoreTransaction(() => closeCashSettlement({
      actor: ADMIN, tenantId: T, routeId: R_NORTE, userId: JUAN.id, entregado: 90_000, motivo: 'gasto en curso al cerrar',
    }))
    await db.expenses.add({
      id: 'gasto-en-vuelo', tenantId: T, routeId: R_NORTE, categoryId: 'cat-1', valor: 10_000, fecha: HOY,
      userId: JUAN.id, collectorId: JUAN.id, syncStatus: 'synced', createdAt: sello,
    })
  })
  const doc = await cierre!
  const gasto = (await db.expenses.get('gasto-en-vuelo'))!
  const siguiente = await previewDe(JUAN.id)
  metric('instante del gasto / hasta de A', `${gasto.createdAt} / ${doc.hasta}`)
  metric('gastos en A / en B', `${doc.gastos} / ${siguiente.gastos}`)
  assert(gasto.createdAt <= doc.hasta && doc.gastos === 10_000 && siguiente.gastos === 0,
    'el gasto confirmado durante el cierre no quedó exactamente en A')
})

await spec('CASH-BOUNDARY-009', 'Fronteras', 'cierres concurrentes con pagos, desembolsos y gastos: cada movimiento en UN ciclo', async () => {
  await empresa()
  const sale = await venta(R_NORTE, 50_000_000, 200)
  const esperado = { recaudado: 0, desembolsado: 0, gastos: 0 }
  const cerrados: CashSettlement[] = []
  for (let i = 0; i < 10; i++) {
    const v = 1_000 + i
    const pendiente = {
      id: `sale-conc-${i}`, tenantId: T, routeId: R_NORTE, clientId: `cli-conc-${i}`, createdByUserId: JUAN.id,
      valorVenta: v, tasaInteres: 0, valorInteres: 0, valorTotal: v, saldo: v, numeroCuotas: 1, valorCuota: v,
      frecuenciaPago: 'diaria', fechaInicio: HOY, fechaFinalEstimada: HOY, status: 'activa', disbursementStatus: 'pendiente',
      createdAt: new Date().toISOString(), updatedAt: '',
    } as unknown as Sale
    await db.sales.add(pendiente)
    const [, , , doc] = await Promise.all([
      pagar(JUAN, sale, v).then(() => { esperado.recaudado += v }),
      confirmDisbursement(pendiente.id, JUAN).then(() => { esperado.desembolsado += v }),
      addExpenseStamped({
        id: `g-conc-${i}`, tenantId: T, routeId: R_NORTE, categoryId: 'cat-1', valor: v, fecha: HOY,
        userId: JUAN.id, collectorId: JUAN.id, syncStatus: 'synced',
      }).then(() => { esperado.gastos += v }),
      closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R_NORTE, userId: JUAN.id, entregado: 0, motivo: 'cierre concurrente de prueba' })
        .catch(() => null),
    ])
    if (doc) cerrados.push(doc)
  }
  const final = await previewDe(JUAN.id)
  const suma = (k: 'recaudado' | 'desembolsado' | 'gastos') => cerrados.reduce((s, c) => s + c[k], 0) + final[k]
  metric('cierres', cerrados.length)
  metric('Σ ciclos vs registrado', `recaudado ${suma('recaudado')}/${esperado.recaudado} · desembolsado ${suma('desembolsado')}/${esperado.desembolsado} · gastos ${suma('gastos')}/${esperado.gastos}`)
  assert(suma('recaudado') === esperado.recaudado, 'pagos perdidos o duplicados en la frontera')
  assert(suma('desembolsado') === esperado.desembolsado, 'desembolsos perdidos o duplicados en la frontera')
  assert(suma('gastos') === esperado.gastos, 'gastos perdidos o duplicados en la frontera')
})

await spec('CASH-BOUNDARY-010', 'Fronteras', 'contrato: cierre bajo bloqueo y escritores sellando bajo bloqueo', () => {
  const svc = readSource('src/services/cashSettlementService.ts')
  const cierreBloquea = svc.includes('[database.cashSettlements, database.payments, database.sales, database.expenses, database.tenants]')
  const guarda = svc.includes('waitClockPast(hasta)')
  const antes = Date.now()
  waitClockPast(new Date(antes).toISOString())
  const relojAvanza = Date.now() > antes
  const disb = readSource('src/services/saleRequestService.ts')
  const corr = readSource('src/services/paymentCorrectionService.ts')
  const gastosPantalla = readSource('src/pages/collector/CollectorExpensesPage.tsx')
  // Tolerante a finales de línea CRLF/LF.
  const disbSella = /await db\.sales\.get\(saleId\)\s+const ahora = nowISO\(\)/.test(disb)
  const corrSella = /await db\.payments\.get\(original\.id\)\s+const sello = nowISO\(\)/.test(corr)
  metric('cierre en transacción sobre pagos/ventas/gastos', cierreBloquea)
  metric('no suelta el bloqueo hasta superar `hasta`', guarda && relojAvanza)
  metric('desembolso sella tras leer', disbSella)
  metric('corrección sella tras leer', corrSella)
  metric('gasto operativo usa addExpenseStamped', gastosPantalla.includes('await addExpenseStamped(expense)'))
  assert(cierreBloquea && guarda && relojAvanza, 'el cierre no protege la frontera')
  assert(disbSella, 'el desembolso sella antes del bloqueo')
  assert(corrSella, 'la corrección sella antes del bloqueo')
  assert(gastosPantalla.includes('await addExpenseStamped(expense)') && !gastosPantalla.includes('createdAt: nowISO()'), 'el gasto sella antes del bloqueo')
})

// ############################################################
// FAMILIA — MOBILE-PARITY · SUPERVISOR Y COBRADOR, MISMA APP OPERATIVA
// ------------------------------------------------------------
// El Supervisor hace su recorrido con el teléfono: su experiencia operativa es la
// del Cobrador. Mismas rutas, mismo layout, mismas páginas; las diferencias salen
// de `can()`, no de copias ni de ramas por rol.
// ############################################################
const APP = () => readSource('src/app/App.tsx')
const OPERATIVAS = () => {
  const app = APP()
  const cuerpo = app.slice(app.indexOf('function operationalRoutes()'), app.indexOf('export default function App()'))
  return [...cuerpo.matchAll(/path="([^"]+)"/g)].map(m => m[1])
}
const PAGINAS_OPERATIVAS = () => fs.readdirSync('src/pages/collector').filter(f => f.endsWith('.tsx'))

await spec('MOBILE-PARITY-001', 'Paridad móvil', 'Cobrador y Supervisor usan la MISMA familia de layout operativo', () => {
  const app = APP()
  const sup = readSource('src/components/layout/SupervisorLayout.tsx')
  const bloque = (prefijo: string) => app.slice(app.indexOf(`<Route path="${prefijo}"`), app.indexOf('</Route>', app.indexOf(`<Route path="${prefijo}"`)))
  const reexporta = /export \{ CollectorLayout as SupervisorLayout \} from '\.\/CollectorLayout'/.test(sup)
  metric('SupervisorLayout = CollectorLayout', reexporta)
  metric('/collector monta operationalRoutes()', bloque('/collector').includes('{operationalRoutes()}'))
  metric('/supervisor monta operationalRoutes()', bloque('/supervisor').includes('{operationalRoutes()}'))
  assert(reexporta, 'el Supervisor tiene un layout propio')
  assert(bloque('/collector').includes('{operationalRoutes()}') && bloque('/supervisor').includes('{operationalRoutes()}'),
    'las dos capas no comparten la misma definición de rutas')
})

await spec('MOBILE-PARITY-002', 'Paridad móvil', 'no existen duplicados de páginas operativas', () => {
  const dirs = fs.readdirSync('src/pages')
  const paginas = PAGINAS_OPERATIVAS()
  const conSupervisor = paginas.filter(f => /supervisor/i.test(f))
  const rutas = OPERATIVAS()
  const repetidas = rutas.filter((r, i) => rutas.indexOf(r) !== i)
  metric('carpetas de páginas', dirs.join(', '))
  metric('páginas operativas', paginas.length)
  metric('páginas "Supervisor*"', conSupervisor.join(', ') || 'ninguna')
  metric('rutas repetidas', repetidas.join(', ') || 'ninguna')
  assert(!dirs.includes('supervisor'), 'existe una carpeta de páginas propia del Supervisor')
  assert(conSupervisor.length === 0 && repetidas.length === 0, 'hay páginas o rutas operativas duplicadas')
})

await spec('MOBILE-PARITY-003', 'Paridad móvil', 'el Supervisor tiene las mismas rutas operativas base que el Cobrador', () => {
  const rutas = OPERATIVAS()
  const base = ['select-route', 'home', 'route', 'clients/new', 'new-sale', 'disbursements', 'daily-report', 'cashclose',
    'payment-history', 'payment/:saleId', 'client/:id', 'expenses', 'sync', 'account', 'worker-settlements']
  const faltan = base.filter(r => !rutas.includes(r))
  metric('rutas operativas (ambos roles)', rutas.join(' · '))
  assert(faltan.length === 0, `faltan rutas operativas: ${faltan.join(', ')}`)
})

await spec('MOBILE-PARITY-004', 'Paridad móvil', 'las diferencias de acceso están gobernadas por capacidades', () => {
  const fuentes = [...PAGINAS_OPERATIVAS().map(f => `src/pages/collector/${f}`), 'src/components/layout/CollectorLayout.tsx',
    'src/components/settlement/WorkerCashSettlementPanel.tsx']
  const ramas = fuentes.flatMap(f => readSource(f).split('\n').map((l, i) => ({ f, i: i + 1, l })))
    .filter(x => /rol\s*===\s*'(supervisor|cobrador)'/.test(x.l) && !x.l.trim().startsWith('//'))
  // Únicas ramas por rol admitidas: ETIQUETAS de texto (título y nombre del rol), nunca acceso.
  const noEtiqueta = ramas.filter(x => !/roleTitle|'Supervisor' : 'Cobrador'/.test(x.l))
  const gates = fuentes.reduce((n, f) => n + (readSource(f).match(/can\(user, '/g) ?? []).length, 0)
  metric('ramas por rol encontradas', ramas.map(x => `${x.f.split('/').pop()}:${x.i}`).join(', '))
  metric('ramas por rol que deciden acceso', noEtiqueta.length)
  metric('guardas can(user, …) en la capa operativa', gates)
  assert(noEtiqueta.length === 0, `hay decisiones de acceso por rol: ${noEtiqueta.map(x => x.l.trim()).join(' | ')}`)
  assert(gates >= 6, 'las diferencias deberían expresarse con can()')
})

await spec('MOBILE-PARITY-005', 'Paridad móvil', 'el Supervisor registra el pago desde el MISMO flujo (PaymentPage → registerPayment)', async () => {
  await empresa()
  const p = await pagar(LAURA, await venta(R_NORTE), 60_000)
  const page = readSource('src/pages/collector/PaymentPage.tsx')
  metric('ruta payment/:saleId compartida', OPERATIVAS().includes('payment/:saleId'))
  metric('PaymentPage llama a registerPayment', page.includes('await registerPayment({'))
  metric('Payment', `${p.createdByUserId} / ${p.collectorId} / ${p.valor}`)
  assert(page.includes('await registerPayment({') && p.collectorId === LAURA.id && p.createdByUserId === LAURA.id,
    'el pago del Supervisor no sigue el flujo compartido o no quedó a su nombre')
})

await spec('MOBILE-PARITY-006', 'Paridad móvil', 'el Cobrador sigue SIN ver la Base', () => {
  const puede = can(JUAN, 'cashbox.viewRoute', { routeId: R_NORTE, tenantId: T })
  const tarjeta = readSource('src/pages/collector/CollectorSelectRoutePage.tsx')
  const cierre = readSource('src/pages/collector/CollectorCashClosePage.tsx')
  metric('cobrador · cashbox.viewRoute', puede)
  assert(!puede, 'el Cobrador puede ver la caja de la ruta')
  assert(tarjeta.includes('base: verBase ? await getRouteAvailableCapital(route.id) : undefined'), 'la tarjeta pide la Base sin guarda')
  assert(cierre.includes('verCajaRuta ? await getRouteFinancialSummary(routeId) : null'), 'Mi efectivo pide la caja de ruta sin guarda')
})

await spec('MOBILE-PARITY-007', 'Paridad móvil', 'el Supervisor SÍ ve la Base (y separada de Mi efectivo)', () => {
  const puede = can(LAURA, 'cashbox.viewRoute', { routeId: R_NORTE, tenantId: T })
  const cierre = readSource('src/pages/collector/CollectorCashClosePage.tsx')
  metric('supervisor · cashbox.viewRoute', puede)
  assert(puede, 'el Supervisor no puede ver la Base')
  assert(cierre.includes('no forma parte de tu efectivo'), 'la Base no está separada de Mi efectivo')
})

await spec('MOBILE-PARITY-008', 'Paridad móvil', 'el Supervisor abre "Cuadrar trabajadores" desde la experiencia móvil', () => {
  const home = readSource('src/pages/collector/CollectorHomePage.tsx')
  const mi = readSource('src/pages/collector/CollectorCashClosePage.tsx')
  const desdeInicio = home.includes("can(user, 'cashSettlement.close'") && home.includes('to={`${base}/worker-settlements`}')
  const desdeMiEfectivo = mi.includes('to={`${base}/worker-settlements`}')
  metric('ruta operativa worker-settlements', OPERATIVAS().includes('worker-settlements'))
  metric('acceso en Inicio (con capacidad)', desdeInicio)
  metric('acceso en Mi efectivo', desdeMiEfectivo)
  metric('supervisor · cashSettlement.close / cobrador', `${can(LAURA, 'cashSettlement.close', { routeId: R_NORTE, tenantId: T })} / ${can(JUAN, 'cashSettlement.close', { routeId: R_NORTE, tenantId: T })}`)
  assert(OPERATIVAS().includes('worker-settlements') && desdeInicio && desdeMiEfectivo, 'el cuadre no es alcanzable desde el móvil')
  assert(can(LAURA, 'cashSettlement.close', { routeId: R_NORTE, tenantId: T }) && !can(JUAN, 'cashSettlement.close', { routeId: R_NORTE, tenantId: T }),
    'la capacidad no distingue Supervisor de Cobrador')
  const panel = readSource('src/components/settlement/WorkerCashSettlementPanel.tsx')
  assert(panel.includes('sm:hidden') && panel.includes('hidden sm:block'), 'el histórico no tiene tratamiento móvil')
})

await spec('MOBILE-PARITY-009', 'Paridad móvil', 'el Supervisor NO puede cerrar su propio cuadre (regla intacta)', async () => {
  await empresa()
  await pagar(LAURA, await venta(R_NORTE), 300_000)
  const r = await rechazo(() => closeCashSettlement({ actor: LAURA, tenantId: T, routeId: R_NORTE, userId: LAURA.id, entregado: 300_000 }))
  metric('Laura → su cuadre', r)
  assert(/propio cuadre/.test(r), 'el Supervisor pudo cerrar su propio cuadre')
})

await spec('MOBILE-PARITY-010', 'Paridad móvil', 'ninguna pantalla operativa exige ir a /admin/* para completar el recorrido', () => {
  const fuentes = [...PAGINAS_OPERATIVAS().map(f => `src/pages/collector/${f}`), 'src/components/layout/CollectorLayout.tsx',
    'src/components/settlement/WorkerCashSettlementPanel.tsx']
  const conAdmin = fuentes.filter(f => /['"`]\/admin/.test(readSource(f)))
  const layout = readSource('src/components/layout/CollectorLayout.tsx')
  const unaRuta = /if \(routes\.length === 1\) \{\s+return <div/.test(layout)
  metric('pantallas operativas que enlazan a /admin', conAdmin.join(', ') || 'ninguna')
  metric('una sola ruta entra directo (sin pasar por la selección)', unaRuta)
  assert(conAdmin.length === 0, `hay enlaces operativos a /admin: ${conAdmin.join(', ')}`)
  assert(unaRuta, 'con una sola ruta se vuelve a forzar la pantalla de selección')
})

// ############################################################
// AUTORIDAD COMERCIAL DEL SUPERVISOR — crédito directo + autorizaciones
// ------------------------------------------------------------
// Servicios de producción sobre Dexie real. Laura (Supervisora) tiene Norte y Sur;
// Marta (Supervisora) solo Norte; Juan y Pedro (Cobradores) solicitan en Norte.
// ############################################################
let cliSeq = 0
async function clienteEn(routeId: string): Promise<string> {
  const id = `cli-auth-${++cliSeq}`
  await db.clients.add({ id, tenantId: T, routeId, nombre: `Cliente ${id}`, documento: id, status: 'activo', createdAt: '' } as never)
  return id
}
const DIAS = [1, 2, 3, 4, 5, 6]
const entrada = (routeId: string, clientId: string, actor: User, valor = 500_000, extra: Partial<SaleInputs> = {}): SaleInputs => ({
  tenantId: T, routeId, clientId, createdByUserId: actor.id, valorVenta: valor, tasaInteres: 20, numeroCuotas: 20,
  frecuenciaPago: 'diaria', fechaInicio: HOY, paymentDays: DIAS, ...extra,
})
async function solicitud(actor: User, routeId = R_NORTE, valor = 500_000) {
  return createSaleRequest(entrada(routeId, await clienteEn(routeId), actor, valor), actor)
}
const SOCIO = base('u-socio', 'Sofía Socia', 'socio', [R_NORTE])
const pendientes = (u: User, routeId: string) => countPendingSaleRequestsForRoute(u, T, routeId)
const ventasDe = async (reqId: string) => (await db.sales.toArray()).filter(s => s.saleRequestId === reqId)

// ---------------- SUP-AUTH ----------------
await spec('SUP-AUTH-001', 'Autorizaciones', 'el Supervisor accede a las autorizaciones de su ruta', async () => {
  await empresa()
  const r = await solicitud(JUAN)
  const lista = await listPendingSaleRequestsForRoute(LAURA, T, R_NORTE)
  metric('authorization.access Norte', can(LAURA, 'authorization.access', { routeId: R_NORTE, tenantId: T }))
  metric('lista Norte', lista.map(x => x.id === r.id ? 'solicitud de Juan' : x.id).join(', '))
  assert(lista.length === 1 && lista[0].id === r.id, 'el Supervisor no ve la solicitud de su ruta')
})

await spec('SUP-AUTH-002', 'Autorizaciones', 'el Supervisor aprueba la solicitud de un Cobrador en su ruta', async () => {
  await empresa()
  const r = await solicitud(JUAN)
  const venta = await approveSaleRequest(r.id, LAURA)
  const res = (await db.saleRequests.get(r.id))!
  metric('solicitud', `${res.status} · pidió ${res.requestedBy} · resolvió ${res.reviewedBy} · ${res.reviewedAt ? 'con fecha' : 'SIN fecha'}`)
  metric('venta', `${venta.disbursementStatus} · creada a nombre de ${venta.createdByUserId}`)
  assert(res.status === 'approved' && res.reviewedBy === LAURA.id && res.requestedBy === JUAN.id && res.saleId === venta.id, 'la aprobación no quedó trazada')
  assert(venta.disbursementStatus === 'pendiente' && venta.createdByUserId === JUAN.id, 'aprobar no es desembolsar; la venta conserva al Cobrador')
})

await spec('SUP-AUTH-003', 'Autorizaciones', 'el Supervisor rechaza con motivo en su ruta', async () => {
  await empresa()
  const r = await solicitud(JUAN)
  await rejectSaleRequest(r.id, LAURA, 'cliente sin referencias')
  const res = (await db.saleRequests.get(r.id))!
  metric('solicitud', `${res.status} · ${res.rejectionReason} · ${res.reviewedBy}`)
  assert(res.status === 'rejected' && res.reviewedBy === LAURA.id && (await ventasDe(r.id)).length === 0, 'el rechazo no quedó bien')
  assert(/motivo/.test(await rechazo(async () => rejectSaleRequest((await solicitud(PEDRO)).id, LAURA, '  '))), 'se aceptó un rechazo sin motivo')
})

await spec('SUP-AUTH-004', 'Autorizaciones', 'el Supervisor NO gestiona solicitudes de una ruta no autorizada', async () => {
  await empresa()
  const r = await solicitud(LAURA, R_SUR)                 // pendiente en Sur
  const lista = await listPendingSaleRequestsForRoute(MARTA, T, R_SUR)
  const aprobar = await rechazo(() => approveSaleRequest(r.id, MARTA))
  const rechazar = await rechazo(() => rejectSaleRequest(r.id, MARTA, 'intento fuera de alcance'))
  metric('Marta (solo Norte) · lista Sur', lista.length)
  metric('aprobar / rechazar', `${aprobar} | ${rechazar}`)
  assert(lista.length === 0 && aprobar !== 'ACEPTADO' && rechazar !== 'ACEPTADO', 'se gestionó una solicitud de ruta ajena')
  assert((await db.saleRequests.get(r.id))!.status === 'pending', 'la solicitud ajena cambió de estado')
})

await spec('SUP-AUTH-005', 'Autorizaciones', 'una Oficina compartida NO amplía el acceso por ruta', async () => {
  await empresa()
  await db.routes.add({ id: 'r-norte-2', tenantId: T, officeId: OF_LETICIA, nombre: 'Norte 2', codigo: 'N-2', status: 'activa', capitalInicial: 0, capitalActual: 0, createdAt: '' } as never)
  await db.users.update(PEDRO.id, { authorizedRouteIds: [R_NORTE, 'r-norte-2'] })
  const pedro = (await db.users.get(PEDRO.id))!
  const r = await solicitud(pedro, 'r-norte-2')
  metric('Marta: Norte (Leticia) sí · Norte 2 (Leticia) no asignada', `${can(MARTA, 'authorization.access', { routeId: R_NORTE, tenantId: T })} / ${can(MARTA, 'authorization.access', { routeId: 'r-norte-2', tenantId: T })}`)
  const aprobar = await rechazo(() => approveSaleRequest(r.id, MARTA))
  metric('aprobar en Norte 2', aprobar)
  assert(aprobar !== 'ACEPTADO' && (await pendientes(MARTA, 'r-norte-2')) === 0, 'la Oficina concedió acceso a una ruta no asignada')
})

await spec('SUP-AUTH-006', 'Autorizaciones', 'el Cobrador sigue sin poder aprobar ni rechazar', async () => {
  await empresa()
  const r = await solicitud(PEDRO)
  const aprobar = await rechazo(() => approveSaleRequest(r.id, JUAN))
  const rechazar = await rechazo(() => rejectSaleRequest(r.id, JUAN, 'no debería poder'))
  metric('Juan aprueba / rechaza la de Pedro', `${aprobar} | ${rechazar}`)
  assert(aprobar !== 'ACEPTADO' && rechazar !== 'ACEPTADO' && (await pendientes(JUAN, R_NORTE)) === 0, 'un Cobrador resolvió una solicitud')
})

await spec('SUP-AUTH-007', 'Autorizaciones', 'nadie resuelve su propia solicitud (Cobrador ni Supervisor)', async () => {
  await empresa()
  const deJuan = await solicitud(JUAN)
  const deLaura = await solicitud(LAURA, R_NORTE, 900_000)
  const juan = await rechazo(() => approveSaleRequest(deJuan.id, JUAN))
  const laura = await rechazo(() => approveSaleRequest(deLaura.id, LAURA))
  const lauraRechaza = await rechazo(() => rejectSaleRequest(deLaura.id, LAURA, 'me la rechazo yo misma'))
  const enSuLista = (await listPendingSaleRequestsForRoute(LAURA, T, R_NORTE)).some(x => x.id === deLaura.id)
  metric('Juan → la suya', juan)
  metric('Laura → la suya (aprobar / rechazar)', `${laura} | ${lauraRechaza}`)
  metric('la propia aparece en la lista de Laura', enSuLista)
  assert(juan !== 'ACEPTADO' && /propia solicitud/.test(laura) && /propia solicitud/.test(lauraRechaza), 'alguien resolvió su propia solicitud')
  assert(!enSuLista, 'la lista muestra una solicitud que el usuario no puede resolver')
  const marta = await approveSaleRequest(deLaura.id, MARTA)
  metric('otra Supervisora la aprueba', marta.saleRequestId === deLaura.id)
})

await spec('SUP-AUTH-008', 'Autorizaciones', 'el Admin mantiene su flujo (aprobar sin cambios de condiciones)', async () => {
  await empresa()
  const r = await solicitud(JUAN)
  const venta = await approveSaleRequest(r, ADMIN)          // la pantalla del Admin envía el objeto
  metric('Admin', `${(await db.saleRequests.get(r.id))!.status} · venta ${venta.disbursementStatus}`)
  assert((await db.saleRequests.get(r.id))!.reviewedBy === ADMIN.id && venta.disbursementStatus === 'pendiente', 'el Admin cambió de comportamiento')
})

await spec('SUP-AUTH-009', 'Autorizaciones', 'el Secretario mantiene su flujo (condiciones + teléfono)', async () => {
  await empresa()
  const r = await solicitud(JUAN)
  await approveSaleRequest(r, SECRE, { interestRate: 10, frequency: 'semanal', paymentDays: [1, 4], phoneConfirmed: true, phoneConfirmationNote: 'confirmó' })
  const res = (await db.saleRequests.get(r.id))!
  metric('solicitadas → finales', `${res.requestedInterestRate}%/${res.requestedFrequency} → ${res.approvedInterestRate}%/${res.approvedFrequency} · teléfono ${res.phoneConfirmed}`)
  assert(res.requestedInterestRate === 20 && res.approvedInterestRate === 10 && res.approvedFrequency === 'semanal' && res.phoneConfirmed, 'el Secretario perdió su flujo o la trazabilidad')
})

await spec('SUP-AUTH-010', 'Autorizaciones', 'el Socio no obtiene autorizaciones por accidente', async () => {
  await empresa()
  await db.users.add(SOCIO)
  const r = await solicitud(JUAN)
  const caps = ['authorization.access', 'authorization.approve', 'authorization.reject', 'sale.createDirect'] as const
  const tiene = caps.filter(c => can(SOCIO, c, { routeId: R_NORTE, tenantId: T }))
  const aprobar = await rechazo(() => approveSaleRequest(r.id, SOCIO))
  metric('capacidades comerciales del Socio', tiene.join(', ') || 'ninguna')
  assert(tiene.length === 0 && aprobar !== 'ACEPTADO', 'el Socio obtuvo autoridad comercial')
})

await spec('SUP-AUTH-011', 'Autorizaciones', 'modificar condiciones y confirmar teléfono: Supervisor sí, con trazabilidad', async () => {
  await empresa()
  const r = await solicitud(JUAN)
  await approveSaleRequest(r.id, LAURA, { interestRate: 10, frequency: 'semanal', paymentDays: [2, 5], phoneConfirmed: true, phoneConfirmationNote: 'habló con el cliente' })
  const res = (await db.saleRequests.get(r.id))!
  const venta = (await ventasDe(r.id))[0]
  metric('antes → después', `${res.requestedInterestRate}%/${res.requestedFrequency}/${res.requestedPaymentDays} → ${res.approvedInterestRate}%/${res.approvedFrequency}/${res.approvedPaymentDays}`)
  metric('venta generada con', `${venta.tasaInteres}% · ${venta.frecuenciaPago}`)
  assert(res.requestedInterestRate === 20 && res.approvedInterestRate === 10 && venta.tasaInteres === 10 && venta.frecuenciaPago === 'semanal', 'las condiciones no se aplicaron con historial')
  assert(res.phoneConfirmed === true && res.phoneConfirmationNote === 'habló con el cliente', 'no quedó la confirmación telefónica')
  // Un Admin (sin phoneConfirm) no puede registrar una confirmación nueva.
  const r2 = await solicitud(PEDRO)
  const adminTel = await rechazo(() => approveSaleRequest(r2.id, ADMIN, { phoneConfirmed: true }))
  metric('Admin registra teléfono', adminTel)
  assert(adminTel !== 'ACEPTADO', 'se registró una confirmación telefónica sin la capacidad')
})

// ---------------- SUP-CREDIT ----------------
await spec('SUP-CREDIT-001', 'Crédito directo', 'el Supervisor otorga crédito directo (desembolsado por él)', async () => {
  await empresa()
  const venta = await createDirectSale(entrada(R_NORTE, await clienteEn(R_NORTE), LAURA, 400_000), LAURA)
  metric('venta', `${venta.status} · ${venta.disbursementStatus} · entregó ${venta.disbursedByCollectorId} · ${venta.disbursedAt ? 'instante sellado' : 'SIN instante'}`)
  assert(venta.disbursementStatus === 'desembolsado' && venta.disbursedByCollectorId === LAURA.id && venta.disbursedAt, 'el crédito directo no quedó atribuido al Supervisor')
  assert(!!(await db.sales.get(venta.id)) && (await db.installments.where('saleId').equals(venta.id).count()) === 20, 'la venta o sus parcelas no se guardaron')
})

await spec('SUP-CREDIT-002', 'Crédito directo', 'el crédito directo NO crea una solicitud pendiente', async () => {
  await empresa()
  const venta = await createDirectSale(entrada(R_NORTE, await clienteEn(R_NORTE), LAURA), LAURA)
  metric('solicitudes en la base', await db.saleRequests.count())
  metric('saleRequestId de la venta', venta.saleRequestId ?? 'ninguno')
  assert((await db.saleRequests.count()) === 0 && !venta.saleRequestId, 'apareció una solicitud fantasma')
})

await spec('SUP-CREDIT-003', 'Crédito directo', 'respeta la ruta autorizada (Laura en Sur también es suya)', async () => {
  await empresa()
  const venta = await createDirectSale(entrada(R_SUR, await clienteEn(R_SUR), LAURA), LAURA)
  metric('Laura en Sur', venta.routeId)
  assert(venta.routeId === R_SUR, 'no pudo operar en otra ruta autorizada')
})

await spec('SUP-CREDIT-004', 'Crédito directo', 'rechaza una ruta no autorizada', async () => {
  await empresa()
  const r = await rechazo(async () => createDirectSale(entrada(R_SUR, await clienteEn(R_SUR), MARTA), MARTA))
  metric('Marta en Sur', r)
  assert(/No autorizado/.test(r) && (await db.sales.count()) === 0, 'se otorgó crédito fuera de alcance')
})

await spec('SUP-CREDIT-005', 'Crédito directo', 'respeta la Oficina inactiva', async () => {
  await empresa()
  const cli = await clienteEn(R_NORTE)
  await db.offices.update(OF_LETICIA, { status: 'inactiva' })
  const r = await rechazo(() => createDirectSale(entrada(R_NORTE, cli, LAURA), LAURA))
  metric('Oficina Leticia inactiva', r)
  assert(/Oficina/.test(r) && (await db.sales.count()) === 0, 'la Oficina inactiva no bloqueó el crédito')
})

await spec('SUP-CREDIT-006', 'Crédito directo', 'respeta capital disponible y límite de venta directa', async () => {
  await empresa()
  const capital = await rechazo(async () => createDirectSale(entrada(R_NORTE, await clienteEn(R_NORTE), LAURA, 50_000_000), LAURA))
  await db.routes.update(R_NORTE, { montoMaximoPrestamo: 300_000 })
  const limite = await rechazo(async () => createDirectSale(entrada(R_NORTE, await clienteEn(R_NORTE), LAURA, 400_000), LAURA))
  const comoSolicitud = await createSaleRequest(entrada(R_NORTE, await clienteEn(R_NORTE), LAURA, 400_000), LAURA)
  metric('supera el capital', capital)
  metric('supera el límite de la ruta', limite)
  metric('por encima del límite puede solicitarlo', comoSolicitud.status)
  assert(/capital/.test(capital) && /límite/.test(limite) && (await db.sales.count()) === 0, 'se saltó una validación financiera')
})

await spec('SUP-CREDIT-007', 'Crédito directo', 'respeta tasa, periodicidad, días de pago y fecha', async () => {
  await empresa()
  const cli = await clienteEn(R_NORTE)
  const casos: [string, Partial<SaleInputs>][] = [
    ['sin días de pago', { paymentDays: [] }], ['día inválido', { paymentDays: [9] }], ['tasa 15%', { tasaInteres: 15 }],
    ['frecuencia inválida', { frecuenciaPago: 'anual' as never }], ['inicio ayer', { fechaInicio: '2020-01-01' }],
    ['parcelas 0', { numeroCuotas: 0 }], ['valor no entero', { valorVenta: 100.5 }],
  ]
  const res: string[] = []
  for (const [k, extra] of casos) res.push(`${k}: ${await rechazo(() => createDirectSale(entrada(R_NORTE, cli, LAURA, 400_000, extra), LAURA))}`)
  metric('rechazos', res.join(' · '))
  assert(res.every(x => !x.endsWith('ACEPTADO')) && (await db.sales.count()) === 0, 'se aceptó una venta que rompe las reglas')
  const ajeno = await rechazo(async () => createDirectSale(entrada(R_NORTE, await clienteEn(R_SUR), LAURA), LAURA))
  metric('cliente de otra ruta', ajeno)
  assert(/cliente/.test(ajeno), 'se aceptó un cliente de otra ruta')
})

await spec('SUP-CREDIT-008', 'Crédito directo', 'el Cobrador mantiene el flujo de solicitud', async () => {
  await empresa()
  const directa = await rechazo(async () => createDirectSale(entrada(R_NORTE, await clienteEn(R_NORTE), JUAN), JUAN))
  const r = await solicitud(JUAN)
  metric('Juan venta directa', directa)
  metric('Juan solicitud', r.status)
  assert(/No autorizado/.test(directa) && r.status === 'pending' && (await db.sales.count()) === 0, 'el Cobrador se saltó la autorización')
})

await spec('SUP-CREDIT-009', 'Crédito directo', 'el Supervisor NO obtiene permisos administrativos', () => {
  const admin = ['user.create', 'user.edit', 'route.create', 'route.edit', 'route.assign', 'settings.access', 'capital.manage',
    'transfer.create', 'partnerCash.viewAll', 'partnerCash.registerMovement', 'settlement.close', 'settlement.reopen',
    'cashbox.viewConsolidated', 'report.viewConsolidated', 'payment.correct', 'payment.reverse', 'payment.approveAdjustment',
    'company.enterPanel', 'cashSettlement.reopen'] as const
  const concedidos = admin.filter(c => can(LAURA, c, { routeId: R_NORTE, tenantId: T, targetRole: 'cobrador' }))
  metric('capacidades administrativas del Supervisor', concedidos.join(', ') || 'ninguna')
  assert(concedidos.length === 0, `el Supervisor obtuvo: ${concedidos.join(', ')}`)
})

await spec('SUP-CREDIT-010', 'Crédito directo', 'autoría y efectivo: el desembolso directo resta de Mi efectivo del Supervisor', async () => {
  await empresa()
  await pagar(LAURA, await venta(R_NORTE), 600_000)
  const v = await createDirectSale(entrada(R_NORTE, await clienteEn(R_NORTE), LAURA, 400_000), LAURA)
  const hoy = await getCollectorDailyCashSummary({ routeId: R_NORTE, collectorId: LAURA.id, fecha: HOY })
  const ciclo = await previewCashSettlement({ actor: ADMIN, tenantId: T, routeId: R_NORTE, userId: LAURA.id })
  metric('venta: creada por / registró desembolso / responsable', `${v.createdByUserId} / ${v.disbursedByUserId} / ${v.disbursedByCollectorId}`)
  metric('Mi efectivo hoy (recaudado − desembolsado)', `${hoy.recaudado} − ${hoy.desembolsado} = ${hoy.efectivoAEntregar}`)
  metric('cuadre: esperado', ciclo.esperado)
  assert(v.createdByUserId === LAURA.id && v.disbursedByUserId === LAURA.id && v.disbursedByCollectorId === LAURA.id, 'autoría incorrecta')
  assert(hoy.efectivoAEntregar === 200_000 && ciclo.esperado === 200_000, 'el desembolso directo no se descontó de su efectivo')
  // Un Admin (sin caja personal) sigue siendo entrega administrativa.
  const va = await createDirectSale(entrada(R_NORTE, await clienteEn(R_NORTE), ADMIN, 100_000), ADMIN)
  metric('venta directa del Admin · responsable', va.disbursedByCollectorId ?? 'ninguno (entrega de la ruta)')
  assert(va.disbursedByCollectorId === undefined, 'el Admin adquirió caja personal')
})

await spec('SUP-CREDIT-011', 'Crédito directo', 'alta de cliente + crédito pasa por el servicio y es atómica', async () => {
  await empresa()
  const nuevo = { id: 'cli-nuevo', tenantId: T, routeId: R_NORTE, nombre: 'Nuevo', documento: 'N-1', status: 'activo', createdAt: '' } as never as Client
  const v = await createDirectSale(entrada(R_NORTE, nuevo.id, LAURA, 300_000), LAURA, { newClient: nuevo })
  const falla = { ...nuevo, id: 'cli-falla', documento: 'N-2' }
  const r = await rechazo(() => createDirectSale(entrada(R_NORTE, falla.id, LAURA, 90_000_000), LAURA, { newClient: falla }))
  metric('cliente + venta', `${!!(await db.clients.get(nuevo.id))} · ${v.disbursedByCollectorId}`)
  metric('venta rechazada deja el cliente', `${r} · cliente ${(await db.clients.get('cli-falla')) ? 'CREADO — ERROR' : 'no creado'}`)
  assert(!!(await db.clients.get(nuevo.id)) && !(await db.clients.get('cli-falla')), 'el alta combinada no es atómica')
  const pantalla = readSource('src/pages/collector/CollectorNewClientPage.tsx')
  assert(pantalla.includes('createDirectSale(input, user, { newClient: client })') && !pantalla.includes('buildSaleWithInstallments'),
    'el alta de cliente escribe la venta sin pasar por el servicio')
})

// ---------------- SUP-BADGE ----------------
async function escenarioBadge() {
  await empresa()
  const n1 = await solicitud(JUAN); const n2 = await solicitud(PEDRO)
  for (let i = 0; i < 3; i++) await solicitud(JUAN, R_SUR)   // Juan también trabaja Sur
  return { n1, n2 }
}

await spec('SUP-BADGE-001', 'Globo', 'ruta activa con 2 pendientes → globo 2', async () => {
  const { n1, n2 } = await escenarioBadge()
  metric('Norte', await pendientes(LAURA, R_NORTE))
  assert((await pendientes(LAURA, R_NORTE)) === 2 && n1.routeId === R_NORTE && n2.routeId === R_NORTE, 'el globo de Norte no es 2')
})

await spec('SUP-BADGE-002', 'Globo', 'otra ruta autorizada con 3 pendientes NO suma si no está activa', async () => {
  await escenarioBadge()
  const norte = await pendientes(LAURA, R_NORTE)
  const sur = await pendientes(LAURA, R_SUR)
  const empresaEntera = await countPendingSaleRequestsForUser(LAURA, T)
  metric('Norte activa / Sur / todas sus rutas', `${norte} / ${sur} / ${empresaEntera}`)
  assert(norte === 2 && sur === 3 && empresaEntera === 5, 'el globo mezcla rutas')
})

await spec('SUP-BADGE-003', 'Globo', 'una ruta no autorizada nunca suma', async () => {
  await escenarioBadge()
  metric('Marta (solo Norte) consultando Sur', await pendientes(MARTA, R_SUR))
  assert((await pendientes(MARTA, R_SUR)) === 0, 'una ruta ajena sumó al globo')
})

await spec('SUP-BADGE-004', 'Globo', 'globo = lista, y todo lo listado es resoluble', async () => {
  await escenarioBadge()
  const lista = await listPendingSaleRequestsForRoute(LAURA, T, R_NORTE)
  const n = await pendientes(LAURA, R_NORTE)
  for (const r of lista) await approveSaleRequest(r.id, LAURA)
  metric('globo / lista / resueltas', `${n} / ${lista.length} / ${lista.length}`)
  assert(n === lista.length && (await pendientes(LAURA, R_NORTE)) === 0, 'el globo no coincide con la lista')
  const hook = readSource('src/hooks/usePendingBadges.ts')
  assert(hook.includes('countPendingSaleRequestsForRoute(user, tenantId, routeId)'), 'el hook no usa el contador de la lista')
})

await spec('SUP-BADGE-005', 'Globo', 'aprobar reduce el globo', async () => {
  const { n1 } = await escenarioBadge()
  const antes = await pendientes(LAURA, R_NORTE)
  await approveSaleRequest(n1.id, LAURA)
  metric('antes → después', `${antes} → ${await pendientes(LAURA, R_NORTE)}`)
  assert(antes === 2 && (await pendientes(LAURA, R_NORTE)) === 1, 'aprobar no redujo el globo')
})

await spec('SUP-BADGE-006', 'Globo', 'rechazar reduce el globo', async () => {
  const { n2 } = await escenarioBadge()
  await rejectSaleRequest(n2.id, LAURA, 'documentación incompleta')
  metric('después de rechazar', await pendientes(LAURA, R_NORTE))
  assert((await pendientes(LAURA, R_NORTE)) === 1, 'rechazar no redujo el globo')
})

await spec('SUP-BADGE-007', 'Globo', 'una solicitud nueva en la misma IndexedDB sube el globo sin F5', async () => {
  await empresa()
  const valores: number[] = []
  const sub = liveQuery(() => countPendingSaleRequestsForRoute(LAURA, T, R_NORTE)).subscribe(v => valores.push(v))
  await tick(30)
  await solicitud(JUAN)
  await tick(60)
  const r = await solicitud(PEDRO)
  await tick(60)
  await approveSaleRequest(r.id, LAURA)
  await tick(60)
  sub.unsubscribe()
  metric('valores observados', valores.join(' → '))
  assert(valores.join(',') === '0,1,2,1', `la consulta viva no siguió los cambios: ${valores.join(',')}`)
})

await spec('SUP-BADGE-008', 'Globo', 'cambiar de ruta recalcula el globo', async () => {
  await escenarioBadge()
  const hook = readSource('src/hooks/usePendingBadges.ts')
  const home = readSource('src/pages/collector/CollectorHomePage.tsx')
  const depende = /\[user\?\.id, user\?\.rol, tenantId, routeId,/.test(hook)
  metric('Norte → Sur', `${await pendientes(LAURA, R_NORTE)} → ${await pendientes(LAURA, R_SUR)}`)
  metric('el hook depende de la ruta', depende)
  metric('Inicio pasa la ruta activa', home.includes('usePendingRouteSaleRequests(user, tenantId, activeRouteId)'))
  assert(depende && home.includes('usePendingRouteSaleRequests(user, tenantId, activeRouteId)'), 'el globo no se recalcula al cambiar de ruta')
})

// ---------------- SUP-AUTH-RACE ----------------
await spec('SUP-AUTH-RACE-001', 'Concurrencia', 'Admin y Supervisor aprueban a la vez: UNA sola venta', async () => {
  await empresa()
  const r = await solicitud(JUAN)
  const res = await Promise.allSettled([approveSaleRequest(r.id, ADMIN), approveSaleRequest(r.id, LAURA)])
  const ok = res.filter(x => x.status === 'fulfilled').length
  const msg = res.filter(x => x.status === 'rejected').map(x => (x as PromiseRejectedResult).reason.message)
  metric('ganan / pierden', `${ok} / ${msg.join(' | ')}`)
  metric('ventas creadas', (await ventasDe(r.id)).length)
  assert(ok === 1 && msg[0] === 'Esta solicitud ya fue resuelta.' && (await ventasDe(r.id)).length === 1, 'se duplicó la aprobación')
})

await spec('SUP-AUTH-RACE-002', 'Concurrencia', 'Supervisor aprueba y Admin rechaza a la vez: UNA transición', async () => {
  await empresa()
  const r = await solicitud(JUAN)
  const res = await Promise.allSettled([approveSaleRequest(r.id, LAURA), rejectSaleRequest(r.id, ADMIN, 'rechazo simultáneo')])
  const final = (await db.saleRequests.get(r.id))!
  const ventas = (await ventasDe(r.id)).length
  metric('resultados', res.map(x => x.status).join(' / '))
  metric('estado final / ventas', `${final.status} / ${ventas}`)
  assert(res.filter(x => x.status === 'fulfilled').length === 1, 'hubo dos transiciones')
  assert((final.status === 'approved' && ventas === 1) || (final.status === 'rejected' && ventas === 0), 'estado y ventas incoherentes')
})

await spec('SUP-AUTH-RACE-003', 'Concurrencia', 'una solicitud resuelta no vuelve a cambiar', async () => {
  await empresa()
  const a = await solicitud(JUAN)
  await approveSaleRequest(a.id, LAURA)
  const reRechazo = await rechazo(() => rejectSaleRequest(a.id, ADMIN, 'intento tardío'))
  const reAprobar = await rechazo(() => approveSaleRequest(a.id, ADMIN))
  const b = await solicitud(PEDRO)
  await rejectSaleRequest(b.id, LAURA, 'no califica')
  const trasRechazo = await rechazo(() => approveSaleRequest(b, ADMIN))     // objeto viejo de la pantalla: status 'pending'
  metric('aprobada → rechazar / aprobar otra vez', `${reRechazo} | ${reAprobar}`)
  metric('rechazada → aprobar con objeto viejo', trasRechazo)
  assert([reRechazo, reAprobar, trasRechazo].every(x => x === 'Esta solicitud ya fue resuelta.'), 'una solicitud resuelta cambió de estado')
  assert((await db.saleRequests.get(a.id))!.status === 'approved' && (await db.saleRequests.get(b.id))!.status === 'rejected'
    && (await ventasDe(a.id)).length === 1 && (await ventasDe(b.id)).length === 0, 'los estados finales cambiaron')
})

// ---------------- SMOKE SA (servicios) ----------------
await spec('SMOKE-SA-01..06,08', 'Smoke', 'recorrido comercial completo del Supervisor en Norte', async () => {
  await empresa()
  // SA-01 Juan solicita → pending
  const r = await solicitud(JUAN)
  // SA-02 Laura con Norte activa → globo 1
  const globo = await pendientes(LAURA, R_NORTE)
  // SA-04 pendiente en Sur, Marta solo Norte → no aparece, no suma, URL directa rechazada
  const sur = await solicitud(LAURA, R_SUR)
  const martaSur = await rechazo(() => approveSaleRequest(sur.id, MARTA))
  // SA-03 Laura aprueba → resuelta, globo 0, sin duplicados
  await approveSaleRequest(r.id, LAURA)
  const globoTras = await pendientes(LAURA, R_NORTE)
  // SA-05 crédito directo de Laura → sin solicitud
  const antesSolicitudes = await db.saleRequests.count()
  const directa = await createDirectSale(entrada(R_NORTE, await clienteEn(R_NORTE), LAURA, 250_000), LAURA)
  // SA-06 Juan no puede saltar la autorización
  const juanDirecta = await rechazo(async () => createDirectSale(entrada(R_NORTE, await clienteEn(R_NORTE), JUAN), JUAN))
  // SA-08 Laura cobra después → responsable Laura
  const pago = await pagar(LAURA, await venta(R_NORTE), 50_000)
  metric('SA-01 solicitud de Juan', r.status)
  metric('SA-02 globo Laura/Norte', globo)
  metric('SA-03 tras aprobar: globo / ventas de la solicitud', `${globoTras} / ${(await ventasDe(r.id)).length}`)
  metric('SA-04 Marta: globo Sur / aprobar Sur', `${await pendientes(MARTA, R_SUR)} / ${martaSur}`)
  metric('SA-05 directa: estado / solicitudes nuevas', `${directa.disbursementStatus} / ${(await db.saleRequests.count()) - antesSolicitudes}`)
  metric('SA-06 Juan directa', juanDirecta)
  metric('SA-08 pago de Laura: responsable', pago.collectorId)
  assert(r.status === 'pending' && globo === 1 && globoTras === 0 && (await ventasDe(r.id)).length === 1, 'SA-01..03')
  assert((await pendientes(MARTA, R_SUR)) === 0 && martaSur !== 'ACEPTADO', 'SA-04')
  assert(directa.disbursementStatus === 'desembolsado' && (await db.saleRequests.count()) === antesSolicitudes, 'SA-05')
  assert(/No autorizado/.test(juanDirecta), 'SA-06')
  assert(pago.collectorId === LAURA.id && pago.createdByUserId === LAURA.id, 'SA-08')
})

await spec('MOBILE-PARITY-011', 'Paridad móvil', 'Autorizaciones es una función adicional de la MISMA app operativa', () => {
  const app = readSource('src/app/App.tsx')
  const cuerpo = app.slice(app.indexOf('function operationalRoutes()'), app.indexOf('export default function App()'))
  const pagina = readSource('src/pages/collector/CollectorAuthorizationsPage.tsx')
  const home = readSource('src/pages/collector/CollectorHomePage.tsx')
  const layout = readSource('src/components/layout/CollectorLayout.tsx')
  const barra = (layout.match(/\{ path: `\$\{base\}\//g) ?? []).length
  metric('ruta operativa authorizations', cuerpo.includes('path="authorizations"'))
  metric('acceso en Inicio gobernado por capacidad', home.includes("can(user, 'authorization.access'"))
  metric('ítems de la barra inferior', barra)
  assert(cuerpo.includes('path="authorizations"') && home.includes("can(user, 'authorization.access'"), 'autorizaciones no está en la capa operativa')
  assert(!/['"`]\/admin/.test(pagina) && pagina.includes('listPendingSaleRequestsForRoute(user, tenantId, routeId)'), 'la pantalla depende de /admin o no usa la lista de la ruta')
  assert(barra === 5, 'se añadió un botón fijo a la barra inferior')
})

await spec('SMOKE-S1', 'Smoke', 'Supervisor sin selector: Laura paga 300k con Juan activo', async () => {
  await empresa({ cobradoresActivosNorte: [JUAN.id] })
  const p = await pagar(LAURA, await venta(R_NORTE), 300_000)
  metric('createdBy / responsable', `${p.createdByUserId} / ${p.collectorId}`)
  metric('Mi efectivo Laura / Juan', `${await miEfectivo(LAURA.id)} / ${await miEfectivo(JUAN.id)}`)
  assert(p.createdByUserId === LAURA.id && p.collectorId === LAURA.id, 'Laura no es la responsable')
  assert(readSource('src/components/ui/CollectorPicker.tsx').includes('if (!user || actorRespondePorSiMismo) return null'), 'el selector sigue visible')
})

await spec('SMOKE-S2', 'Smoke', 'Cobrador → Admin en la misma base (+100k) y la vista se entera sin F5', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  const antes = await getAdminDashboardData({ user: ADMIN, tenantId: T, now: AHORA })
  let aviso = false
  const off = subscribeDataChanges(['payments'], () => { aviso = true })
  await pagar(JUAN, sale, 100_000)
  await tick(10)
  off()
  const despues = await getAdminDashboardData({ user: ADMIN, tenantId: T, now: AHORA })
  const caja = await getCashboxSummary(R_NORTE, HOY, HOY)
  metric('Dashboard recaudo hoy', `${antes.recaudoHoy} → ${despues.recaudoHoy}`)
  metric('Caja Norte cobros hoy', caja.cobros)
  metric('reporte', await reportePagos(ADMIN))
  metric('aviso de refresco recibido', aviso)
  assert(despues.recaudoHoy - antes.recaudoHoy === 100_000 && caja.cobros === 100_000 && aviso, 'S2 falló')
})

await spec('SMOKE-S3', 'Smoke', 'Supervisor → Admin: Route +300k, preview +300k, Mi efectivo Laura +300k, Juan 0', async () => {
  await empresa()
  await pagar(LAURA, await venta(R_NORTE), 300_000)
  const caja = await getCashboxSummary(R_NORTE, HOY, HOY)
  const prev = await generateWeeklySettlementForUser({ user: ADMIN, tenantId: T, routeId: R_NORTE, ...rangoQueContieneHoy() })
  const dash = await getAdminDashboardData({ user: ADMIN, tenantId: T, now: AHORA })
  metric('Route / Admin recaudo / preview cobros', `${caja.cobros} / ${dash.recaudoHoy} / ${prev?.cobros}`)
  metric('Mi efectivo Laura / Juan', `${await miEfectivo(LAURA.id)} / ${await miEfectivo(JUAN.id)}`)
  assert(caja.cobros === 300_000 && dash.recaudoHoy === 300_000 && prev?.cobros === 300_000, 'la ruta no recibió el cobro')
  assert(await miEfectivo(LAURA.id) === 300_000 && await miEfectivo(JUAN.id) === 0, 'la responsabilidad quedó mal')
})

await spec('SMOKE-S4', 'Smoke', 'cambio de sesión: Cobrador registra → logout → login Admin → visible', async () => {
  await empresa()
  const j = await reingresarComo(JUAN)
  await pagar(j, await venta(R_NORTE), 100_000)
  const a = await reingresarComo(ADMIN)
  const dash = await getAdminDashboardData({ user: a, tenantId: a.tenantId, now: AHORA })
  metric('Admin tras login · recaudo hoy', dash.recaudoHoy)
  assert(dash.recaudoHoy === 100_000, 'FAIL: el Admin no ve el pago tras el cambio de sesión')
})

await spec('SMOKE-C1', 'Smoke', 'cierre limpio: esperado 1.000.000, entrega 1.000.000 → 0 y siguiente ciclo 0', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 1_000_000)
  const doc = await cerrar(JUAN.id, 1_000_000)
  const next = await previewDe(JUAN.id)
  metric('diferencia / siguiente esperado', `${doc.diferencia} / ${next.esperado}`)
  assert(doc.esperado === 1_000_000 && doc.diferencia === 0 && next.esperado === 0, 'C1 falló')
})

await spec('SMOKE-C2', 'Smoke', 'faltante: esperado 1.000.000, entrega 900.000 → faltante 100.000 y arrastre 100.000', async () => {
  await empresa()
  await pagar(JUAN, await venta(R_NORTE), 1_000_000)
  const doc = await cerrar(JUAN.id, 900_000, { motivo: 'faltaron billetes en la entrega' })
  const next = await previewDe(JUAN.id)
  metric('faltante / arrastre siguiente', `${doc.faltante} / ${next.arrastreAnterior}`)
  assert(doc.faltante === 100_000 && next.arrastreAnterior === 100_000, 'C2 falló')
})

await spec('SMOKE-C3', 'Smoke', 'faltante + recaudo nuevo: 100.000 + 300.000 = 400.000, entrega 400.000 → 0', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  await pagar(JUAN, sale, 1_000_000)
  await cerrar(JUAN.id, 900_000, { motivo: 'faltaron billetes en la entrega' })
  await pagar(JUAN, sale, 300_000)
  const doc = await cerrar(JUAN.id, 400_000)
  metric('arrastre / recaudado / esperado / diferencia', `${doc.arrastreAnterior} / ${doc.recaudado} / ${doc.esperado} / ${doc.diferencia}`)
  assert(doc.arrastreAnterior === 100_000 && doc.esperado === 400_000 && doc.diferencia === 0, 'C3 falló')
})

await spec('SMOKE-C4', 'Smoke', 'Supervisor: recauda 300k, desembolsa 100k, gasta 50k → esperado 150k; Admin cierra 150k', async () => {
  await empresa()
  await pagar(LAURA, await venta(R_NORTE), 300_000)
  await desembolsar(LAURA, R_NORTE, 100_000)
  await gastar(LAURA, R_NORTE, 50_000)
  const doc = await cerrar(LAURA.id, 150_000, { actor: ADMIN })
  metric('recaudado / desembolsado / gastos / esperado / diferencia', `${doc.recaudado} / ${doc.desembolsado} / ${doc.gastos} / ${doc.esperado} / ${doc.diferencia}`)
  assert(doc.esperado === 150_000 && doc.diferencia === 0, 'C4 falló')
})

await spec('SMOKE-C5', 'Smoke', 'Juan y Laura operan la misma ruta: cuadres independientes', async () => {
  await empresa()
  const sale = await venta(R_NORTE)
  await pagar(JUAN, sale, 200_000)
  await pagar(LAURA, sale, 300_000)
  const j = await cerrar(JUAN.id, 200_000)
  const l = await cerrar(LAURA.id, 280_000, { motivo: 'faltante de la supervisora' })
  metric('Juan', `esperado ${j.esperado} · dif ${j.diferencia}`)
  metric('Laura', `esperado ${l.esperado} · dif ${l.diferencia}`)
  assert(j.esperado === 200_000 && l.esperado === 300_000 && j.diferencia === 0 && l.diferencia === -20_000, 'C5 falló')
})

await spec('SMOKE-C6', 'Smoke', 'no autocierre: Laura intenta cerrar el propio → rechazo; Admin lo cierra', async () => {
  await empresa()
  await pagar(LAURA, await venta(R_NORTE), 300_000)
  const r = await rechazo(() => closeCashSettlement({ actor: LAURA, tenantId: T, routeId: R_NORTE, userId: LAURA.id, entregado: 300_000 }))
  const doc = await cerrar(LAURA.id, 300_000, { actor: ADMIN })
  metric('Laura → su cuadre', r)
  metric('Admin → cuadre de Laura', `${doc.closedByUserId} · dif ${doc.diferencia}`)
  assert(r !== 'ACEPTADO' && doc.closedByUserId === ADMIN.id, 'C6 falló')
})


// ############################################################
// INFORME
// ############################################################
const PAD = 22
function line(ch = '─') { return ch.repeat(96) }

console.log('')
console.log(line('═'))
console.log('  RUTACASH — SUITE CAJA DEL TRABAJADOR (Dexie real · misma IndexedDB)')
console.log(line('═'))

let grupo = ''
for (const r of results) {
  if (r.group !== grupo) {
    grupo = r.group
    console.log('')
    console.log(`▌ ${grupo.toUpperCase()}`)
    console.log(line())
  }
  console.log(`[${r.passed ? ' PASS ' : ' FAIL '}] ${r.id.padEnd(PAD)} ${r.desc}`)
  for (const m of r.metrics) console.log(`           · ${m}`)
  if (r.error) console.log(`           ↳ ERROR: ${r.error}`)
}

const fallidos = results.filter(r => !r.passed)
console.log('')
console.log(line('═'))
console.log(`  TOTAL: ${results.length} casos   ${results.length - fallidos.length} PASS   ${fallidos.length} FAIL`)
console.log(line('═'))

if (fallidos.length) {
  console.log('')
  console.log('CASOS FALLIDOS:')
  for (const r of fallidos) console.log(`  · ${r.id} — ${r.desc}
    ${r.error}`)
  console.log('')
  console.log('SUITE CAJA DEL TRABAJADOR: FALLÓ')
} else {
  console.log('')
  console.log('SUITE CAJA DEL TRABAJADOR: TODOS LOS CASOS PASAN')
}

process.exit(fallidos.length === 0 ? 0 : 1)
