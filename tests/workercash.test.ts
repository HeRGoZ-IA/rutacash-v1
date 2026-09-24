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
import { db } from '../src/lib/db'
import { registerPayment } from '../src/services/paymentService'
import { getCashboxSummary, getCollectorDailyCashSummary } from '../src/services/cashboxEngine'
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
import { confirmDisbursement } from '../src/services/saleRequestService'
import {
  previewCashSettlement, closeCashSettlement, reopenCashSettlement, getPendingShortagesForUser,
} from '../src/services/cashSettlementService'
import { closeCycleBlockedReason } from '../src/lib/cashSettlementRules'
import { can } from '../src/lib/permissions'
import { today, getWeekStart, getWeekEnd } from '../src/lib/formatters'
import type { Payment, Sale, User } from '../src/models/types'
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
