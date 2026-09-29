// ============================================================
// RUTACASH — SUITE CRÉDITO ACTIVO · BASE POR TRABAJADOR · MOVIMIENTOS · CONCILIACIÓN
// ------------------------------------------------------------
//   npm run test:basecash
//
// Servicios de PRODUCCIÓN sobre el singleton `db` real (Dexie + fake-indexeddb):
// el mismo escenario de un solo equipo y una sola IndexedDB de las pruebas del socio.
//
// Familias:
//   ACTIVE-CREDIT-*   segundo crédito del Cobrador (incidente 2026-09).
//   BASE-WORKER-*     Base física entregada a cada persona (custodia, v15).
//   MOVEMENT-SVC-*    capital, transferencias y retiros por servicio de dominio.
//   RECON-*           conciliación Route ↔ trabajadores.
//   CASH-BOUNDARY-011 custodia concurrente con el cierre del cuadre.
//   SUNDAY-ADMIN-*    la operación administrativa del domingo sigue permitida.
//   SMOKE-*           recorridos A–G del socio.
//
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import { can } from '../src/lib/permissions'
import { today } from '../src/lib/formatters'
import {
  ACTIVE_SALE_STATUSES, activeCreditsOf, decideSaleOrigination, isActiveCredit,
} from '../src/lib/activeCredit'
import {
  approveSaleRequest, confirmDisbursement, createDirectSale, createSaleRequest, findActiveSaleForClient, type SaleInputs,
} from '../src/services/saleRequestService'
import { registerPayment } from '../src/services/paymentService'
import { addExpenseStamped } from '../src/services/expenseService'
import { hasPersonalCashbox } from '../src/lib/collectorAttribution'
import { computeExpected } from '../src/lib/cashSettlementRules'
import { OPERATIONAL_TABLES, subscribeDataChanges } from '../src/lib/dataRevision'
import { getCashboxSummary } from '../src/services/cashboxEngine'
import { closeCashSettlement, personalCashPosition, previewCashSettlement } from '../src/services/cashSettlementService'
import {
  computeRouteCashReconciliation, getRouteCashReconciliation, type RouteCashReconciliation,
} from '../src/services/routeCashReconciliation'
import { assignBaseToWorker, returnBaseFromWorker, transferBaseBetweenWorkers } from '../src/services/cashCustodyService'
import { registerCapital, registerTransfer, registerWithdrawal } from '../src/services/routeFundsService'
import { generateWeeklySettlement } from '../src/services/weeklySettlementEngine'
import type { Client, Sale, User } from '../src/models/types'
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
async function rechazo(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'ACEPTADO' } catch (e) { return e instanceof Error ? e.message : String(e) }
}

// ============================================================
// Escenario: empresa Caribe (Norte, Sur) + empresa ajena
// ============================================================
const T = 't-caribe'
const T_AJENA = 't-ajena'
const OF_LETICIA = 'of-leticia'
const R_NORTE = 'r-norte'
const R_SUR = 'r-sur'
const R_AJENA = 'r-ajena'
const HOY = today()

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
const SECRE = base('u-secre', 'Sergio Secretario', 'secretario', [R_NORTE])
const SOCIO = base('u-socio', 'Sofía Socia', 'socio', [R_NORTE])
const INACTIVO = base('u-inactivo', 'Iván Inactivo', 'cobrador', [R_NORTE], { status: 'inactivo' })
const AJENO = { ...base('u-ajeno', 'Ana Ajena', 'admin', [R_AJENA]), tenantId: T_AJENA } as User
const EQUIPO = [SUPER, ADMIN, ADMIN_SUR, JUAN, PEDRO, LAURA, SECRE, SOCIO, INACTIVO, AJENO]

/** Base limpia. La Route Norte arranca con `capitalNorte` de Base estructural. */
async function empresa(opts: { capitalNorte?: number; capitalSur?: number } = {}) {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.bulkAdd([
    { id: T, nombre: 'Caribe', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z' },
    { id: T_AJENA, nombre: 'Ajena', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z' },
  ] as never[])
  await db.offices.add({ id: OF_LETICIA, tenantId: T, nombre: 'Leticia', codigo: 'LET', status: 'activa', createdAt: '', updatedAt: '' } as never)
  await db.routes.bulkAdd([
    { id: R_NORTE, tenantId: T, officeId: OF_LETICIA, nombre: 'Norte', codigo: 'N-1', status: 'activa', cobradorId: JUAN.id, capitalInicial: 0, capitalActual: 0, montoMaximoPrestamo: 500_000, createdAt: '2026-09-01' },
    { id: R_SUR, tenantId: T, nombre: 'Sur', codigo: 'S-1', status: 'activa', cobradorId: JUAN.id, capitalInicial: 0, capitalActual: 0, montoMaximoPrestamo: 500_000, createdAt: '2026-09-01' },
    { id: R_AJENA, tenantId: T_AJENA, nombre: 'Ajena', codigo: 'A-1', status: 'activa', capitalInicial: 0, capitalActual: 0, montoMaximoPrestamo: 0, createdAt: '2026-09-01' },
  ] as never[])
  await db.users.bulkAdd(EQUIPO)
  const movs = [
    { id: 'cap-n', tenantId: T, routeId: R_NORTE, tipo: 'ingresoCapital', valor: opts.capitalNorte ?? 10_000_000, fecha: '2026-09-01', userId: ADMIN.id, createdAt: '2026-09-01T08:00:00.000Z' },
    { id: 'cap-s', tenantId: T, routeId: R_SUR, tipo: 'ingresoCapital', valor: opts.capitalSur ?? 10_000_000, fecha: '2026-09-01', userId: ADMIN.id, createdAt: '2026-09-01T08:00:00.000Z' },
    { id: 'cap-a', tenantId: T_AJENA, routeId: R_AJENA, tipo: 'ingresoCapital', valor: 5_000_000, fecha: '2026-09-01', userId: AJENO.id, createdAt: '2026-09-01T08:00:00.000Z' },
  ].filter(m => m.valor > 0)
  await db.capitalMovements.bulkAdd(movs as never[])
}

const DIAS = [1, 2, 3, 4, 5, 6]
const entrada = (routeId: string, clientId: string, actor: User, valor = 300_000, extra: Partial<SaleInputs> = {}): SaleInputs => ({
  tenantId: T, routeId, clientId, createdByUserId: actor.id, valorVenta: valor, tasaInteres: 20, numeroCuotas: 20,
  frecuenciaPago: 'diaria', fechaInicio: HOY, paymentDays: DIAS, ...extra,
})

let cliSeq = 0
async function cliente(routeId: string, nombre = 'Carlos'): Promise<Client> {
  const c = { id: `cli-${++cliSeq}`, tenantId: T, routeId, nombre, documento: `doc-${cliSeq}`, status: 'activo', createdAt: '', updatedAt: '' } as Client
  await db.clients.add(c)
  return c
}

/** Carlos con Venta A ACTIVA (otorgada por el Admin). */
async function carlosConVentaA(routeId = R_NORTE): Promise<{ carlos: Client; ventaA: Sale }> {
  const carlos = await cliente(routeId)
  const ventaA = await createDirectSale(entrada(routeId, carlos.id, ADMIN, 200_000), ADMIN)
  return { carlos, ventaA }
}

const activasDe = async (clientId: string) =>
  (await db.sales.where('clientId').equals(clientId).toArray()).filter(isActiveCredit)

// ############################################################
// ACTIVE-CREDIT — SEGUNDO CRÉDITO DEL COBRADOR
// ############################################################
const G_AC = 'Crédito activo'

await spec('ACTIVE-CREDIT-001', G_AC, 'Cobrador + cliente sin crédito activo → flujo normal (solicitud) permitido', async () => {
  await empresa()
  const c = await cliente(R_NORTE)
  const req = await createSaleRequest(entrada(R_NORTE, c.id, JUAN), JUAN)
  metric('solicitud', `${req.status} · motivo ${req.authorizationReason} · créditos activos ${req.activeCreditSaleIds?.length}`)
  const venta = await approveSaleRequest(req.id, LAURA)
  metric('tras aprobar', `${venta.status} · ${venta.disbursementStatus}`)
  assert(req.status === 'pending' && req.authorizationReason === 'no-direct-capability' && req.activeCreditSaleIds?.length === 0, 'la solicitud normal no quedó bien registrada')
  assert(venta.status === 'activa', 'la aprobación normal no creó la venta')
})

await spec('ACTIVE-CREDIT-002', G_AC, 'Cobrador + cliente con crédito activo → NO venta directa', async () => {
  await empresa()
  const { carlos } = await carlosConVentaA()
  const r = await rechazo(() => createDirectSale(entrada(R_NORTE, carlos.id, JUAN), JUAN))
  const activas = await activasDe(carlos.id)
  metric('Juan venta directa', r)
  metric('créditos activos de Carlos', activas.length)
  assert(r !== 'ACEPTADO' && activas.length === 1, 'el Cobrador creó un segundo crédito directo')
})

await spec('ACTIVE-CREDIT-003', G_AC, 'Cobrador + cliente con crédito activo → genera Solicitud de autorización', async () => {
  await empresa()
  const { carlos, ventaA } = await carlosConVentaA()
  const req = await createSaleRequest(entrada(R_NORTE, carlos.id, JUAN), JUAN)
  metric('solicitud', `${req.status} · motivo ${req.authorizationReason}`)
  metric('créditos activos fotografiados', JSON.stringify(req.activeCreditSaleIds))
  assert(req.status === 'pending' && req.authorizationReason === 'active-credit', 'no se generó la solicitud por crédito activo')
  assert(JSON.stringify(req.activeCreditSaleIds) === JSON.stringify([ventaA.id]), 'la solicitud no informa del crédito activo')
  assert((await db.saleRequests.get(req.id))?.authorizationReason === 'active-credit', 'no quedó persistido')
})

await spec('ACTIVE-CREDIT-004', G_AC, 'antes de la aprobación no existen dos Sales activas; después, solo por decisión de un autorizador', async () => {
  await empresa()
  const { carlos } = await carlosConVentaA()
  const req = await createSaleRequest(entrada(R_NORTE, carlos.id, JUAN), JUAN)
  const antes = (await activasDe(carlos.id)).length
  const propia = await rechazo(() => approveSaleRequest(req.id, JUAN))
  const venta = await approveSaleRequest(req.id, LAURA)
  const despues = (await activasDe(carlos.id)).length
  metric('activas antes de aprobar', antes)
  metric('Juan aprueba su propia solicitud', propia)
  metric('activas tras aprobar Laura', `${despues} (venta B: ${venta.disbursementStatus}, solicitud ${venta.saleRequestId === req.id ? 'enlazada' : 'SIN enlace'})`)
  assert(antes === 1 && propia !== 'ACEPTADO' && despues === 2 && venta.saleRequestId === req.id, 'la segunda venta no dependió de la autorización')
})

await spec('ACTIVE-CREDIT-005', G_AC, 'manipular la UI no evade el servicio', async () => {
  await empresa()
  const { carlos } = await carlosConVentaA()
  // 1) Pantalla manipulada que muestra "Crear venta" al Cobrador.
  const directa = await rechazo(() => createDirectSale(entrada(R_NORTE, carlos.id, JUAN), JUAN))
  // 2) Sesión manipulada: Juan con `grantedCapabilities` de venta directa.
  const juanInflado = { ...JUAN, grantedCapabilities: ['sale.createDirect'] } as User
  const inflada = await rechazo(() => createDirectSale(entrada(R_NORTE, carlos.id, juanInflado), juanInflado))
  // 3) Flujo "alta de cliente + venta" reutilizando el id de Carlos.
  const altaFalsa = await rechazo(() => createDirectSale(entrada(R_NORTE, carlos.id, JUAN), JUAN, { newClient: { ...carlos, nombre: 'Carlos bis' } }))
  // 4) La regla por ROL se mantiene aunque algún día el Cobrador tuviera venta directa.
  const hipotetico = decideSaleOrigination({ actor: JUAN, canCreateDirect: true, canCreateRequest: true, activeCredits: 1 })
  metric('botón directo forzado', directa)
  metric('capacidades infladas', inflada)
  metric('alta de cliente falsa', altaFalsa)
  metric('regla con venta directa hipotética', JSON.stringify(hipotetico))
  assert([directa, inflada, altaFalsa].every(r => r !== 'ACEPTADO'), 'una manipulación de pantalla creó la venta')
  assert(hipotetico.kind === 'authorization' && hipotetico.reason === 'active-credit', 'la regla depende solo de la capacidad')
  assert((await activasDe(carlos.id)).length === 1, 'quedó un segundo crédito')
})

await spec('ACTIVE-CREDIT-006', G_AC, 'invocación directa del servicio (incluso sin actor) no evade la regla', async () => {
  await empresa()
  const { carlos } = await carlosConVentaA()
  const sinActor = await rechazo(() => createDirectSale(entrada(R_NORTE, carlos.id, JUAN), undefined as never))
  const solicitudSinActor = await rechazo(() => createSaleRequest(entrada(R_NORTE, carlos.id, JUAN), undefined as never))
  const nuloActor = await rechazo(() => createDirectSale(entrada(R_NORTE, carlos.id, JUAN), null as never))
  metric('createDirectSale sin actor (antes ACEPTADO)', sinActor)
  metric('createSaleRequest sin actor', solicitudSinActor)
  metric('createDirectSale actor null', nuloActor)
  assert([sinActor, solicitudSinActor, nuloActor].every(r => r !== 'ACEPTADO'), 'el servicio aceptó una llamada sin actor')
  assert((await activasDe(carlos.id)).length === 1 && (await db.saleRequests.count()) === 0, 'quedaron escrituras')
})

await spec('ACTIVE-CREDIT-007', G_AC, 'Supervisor autorizado conserva el crédito directo (incluso con crédito activo)', async () => {
  await empresa()
  const { carlos } = await carlosConVentaA()
  const nuevo = await cliente(R_NORTE, 'Nuevo')
  const conActivo = await createDirectSale(entrada(R_NORTE, carlos.id, LAURA), LAURA)
  const sinActivo = await createDirectSale(entrada(R_NORTE, nuevo.id, LAURA), LAURA)
  const sobreLimite = await rechazo(() => createDirectSale(entrada(R_NORTE, nuevo.id, LAURA, 600_000), LAURA))
  metric('Laura → Carlos (con crédito)', `${conActivo.status} · ${conActivo.disbursementStatus} · entregó ${conActivo.disbursedByCollectorId}`)
  metric('Laura → cliente nuevo', sinActivo.status)
  metric('Laura sobre el límite de la ruta (500k)', sobreLimite)
  assert(conActivo.disbursedByCollectorId === LAURA.id && sinActivo.status === 'activa', 'el Supervisor perdió su autoridad comercial')
  assert(sobreLimite !== 'ACEPTADO', 'el Supervisor ya no respeta el límite de venta directa')
  assert(can(LAURA, 'sale.createDirect', { routeId: R_NORTE, tenantId: T }) && !can(JUAN, 'sale.createDirect', { routeId: R_NORTE, tenantId: T }), 'la matriz de capacidades cambió')
})

await spec('ACTIVE-CREDIT-008', G_AC, 'Admin/SuperAdmin conservan su comportamiento (directa, sin límite operativo, por servicio)', async () => {
  await empresa()
  const { carlos } = await carlosConVentaA()
  const admin = await createDirectSale(entrada(R_NORTE, carlos.id, ADMIN, 800_000), ADMIN)
  const sup = await createDirectSale(entrada(R_NORTE, carlos.id, SUPER, 900_000), SUPER)
  const socio = await rechazo(() => createDirectSale(entrada(R_NORTE, carlos.id, SOCIO), SOCIO))
  const secre = await rechazo(() => createSaleRequest(entrada(R_NORTE, carlos.id, SECRE), SECRE))
  const paginas = ['src/pages/admin/ActiveSalesPage.tsx', 'src/pages/admin/ClientsPage.tsx'].map(readSource)
  metric('Admin 800k (límite de ruta 500k)', `${admin.status} · desembolsado por ${admin.disbursedByUserId} · caja personal ${admin.disbursedByCollectorId ?? 'ninguna'}`)
  metric('SuperAdmin 900k', sup.status)
  metric('Socio / Secretario', `${socio} / ${secre}`)
  assert(admin.status === 'activa' && admin.disbursedByCollectorId === undefined && sup.status === 'activa', 'Admin/SuperAdmin perdieron la venta directa')
  assert(socio !== 'ACEPTADO' && secre !== 'ACEPTADO', 'un perfil sin autoridad comercial creó ventas')
  assert(paginas.every(src => src.includes('createDirectSale(') && !src.includes('db.sales.add')), 'las pantallas de Admin siguen escribiendo la venta por su cuenta')
})

await spec('ACTIVE-CREDIT-009', G_AC, 'cliente con venta finalizada/refinanciada/perdida → no es crédito activo', async () => {
  await empresa()
  const { carlos, ventaA } = await carlosConVentaA()
  const resultados: string[] = []
  for (const estado of ['finalizada', 'refinanciada', 'perdida'] as const) {
    await db.sales.update(ventaA.id, { status: estado })
    await db.saleRequests.clear()
    const req = await createSaleRequest(entrada(R_NORTE, carlos.id, JUAN), JUAN)
    resultados.push(`${estado}: motivo ${req.authorizationReason}, activos ${req.activeCreditSaleIds?.length}, alerta ${(await findActiveSaleForClient(carlos.id)) ? 'SÍ' : 'no'}`)
    assert(req.authorizationReason === 'no-direct-capability' && req.activeCreditSaleIds?.length === 0, `'${estado}' se tomó como crédito activo`)
  }
  for (const r of resultados) metric('Venta A', r)
})

await spec('ACTIVE-CREDIT-010', G_AC, 'los estados activos están definidos en un solo lugar', () => {
  const servicio = readSource('src/services/saleRequestService.ts')
  const pagina = readSource('src/pages/collector/CollectorNewSalePage.tsx')
  metric('ACTIVE_SALE_STATUSES', JSON.stringify(ACTIVE_SALE_STATUSES))
  metric('servicio usa la regla central', servicio.includes('decideSaleOrigination') && servicio.includes('activeCreditsOf'))
  metric('pantalla usa la regla central', pagina.includes('decideSaleOrigination'))
  assert(JSON.stringify(ACTIVE_SALE_STATUSES) === '["activa"]', 'los estados activos cambiaron sin decisión')
  assert(!/sales\.find\(s => s\.status === 'activa'\)/.test(servicio), 'quedó un literal disperso en el servicio')
  assert(servicio.includes('decideSaleOrigination') && pagina.includes('decideSaleOrigination'), 'servicio y pantalla no comparten la regla')
  const ventas = [{ status: 'activa' }, { status: 'finalizada' }, { status: 'perdida' }, { status: 'refinanciada' }] as Sale[]
  assert(ventas.filter(isActiveCredit).length === 1, 'isActiveCredit no respeta el catálogo')
})

await spec('ACTIVE-CREDIT-011', G_AC, 'dos intentos concurrentes no crean dos créditos activos', async () => {
  await empresa()
  const { carlos } = await carlosConVentaA()
  // a) Doble toque del Cobrador: dos solicitudes simultáneas.
  const dobles = await Promise.allSettled([
    createSaleRequest(entrada(R_NORTE, carlos.id, JUAN), JUAN),
    createSaleRequest(entrada(R_NORTE, carlos.id, JUAN), JUAN),
  ])
  const pendientes = (await db.saleRequests.where('clientId').equals(carlos.id).toArray()).filter(r => r.status === 'pending')
  // b) Dos intentos directos simultáneos del Cobrador.
  const directos = await Promise.allSettled([
    createDirectSale(entrada(R_NORTE, carlos.id, JUAN), JUAN),
    createDirectSale(entrada(R_NORTE, carlos.id, JUAN), JUAN),
  ])
  // c) Cliente SIN crédito: dos solicitudes simultáneas de Juan y Pedro → una sola.
  const otro = await cliente(R_NORTE, 'Otro')
  const cruzadas = await Promise.allSettled([
    createSaleRequest(entrada(R_NORTE, otro.id, JUAN), JUAN),
    createSaleRequest(entrada(R_NORTE, otro.id, PEDRO), PEDRO),
  ])
  metric('doble toque → resultados', dobles.map(d => d.status).join(' / '))
  metric('solicitudes pendientes de Carlos', pendientes.length)
  metric('dos directas de Juan', directos.map(d => d.status).join(' / '))
  metric('Juan y Pedro a la vez (cliente sin crédito)', cruzadas.map(d => d.status).join(' / '))
  assert(pendientes.length === 1 && dobles.filter(d => d.status === 'fulfilled').length === 1, 'el doble toque dejó dos solicitudes')
  assert(directos.every(d => d.status === 'rejected'), 'un intento directo del Cobrador prosperó')
  assert(cruzadas.filter(d => d.status === 'fulfilled').length === 1, 'dos solicitudes simultáneas para el mismo cliente')
  assert((await activasDe(carlos.id)).length === 1 && (await activasDe(otro.id)).length === 0, 'apareció un crédito sin autorización')
})

await spec('ACTIVE-CREDIT-012', G_AC, 'cliente multi-Route: el crédito activo cuenta en TODA la empresa (alcance histórico por cliente)', async () => {
  await empresa()
  const { carlos, ventaA } = await carlosConVentaA(R_NORTE)
  // Carlos se traslada a Sur; su Venta A sigue viva en Norte.
  await db.clients.update(carlos.id, { routeId: R_SUR })
  const directa = await rechazo(() => createDirectSale(entrada(R_SUR, carlos.id, JUAN), JUAN))
  const req = await createSaleRequest(entrada(R_SUR, carlos.id, JUAN), JUAN)
  // Una venta de OTRA empresa con el mismo clientId no cuenta.
  const cruzada = activeCreditsOf([{ ...ventaA, tenantId: T_AJENA }], carlos.id, T)
  metric('Venta A en', ventaA.routeId)
  metric('Juan en Sur → directa', directa)
  metric('Juan en Sur → solicitud', `${req.authorizationReason} · activos ${JSON.stringify(req.activeCreditSaleIds)}`)
  metric('venta de otra empresa cuenta', cruzada.length)
  assert(directa !== 'ACEPTADO' && req.authorizationReason === 'active-credit' && req.activeCreditSaleIds?.[0] === ventaA.id, 'el crédito de otra ruta no se consideró')
  assert(cruzada.length === 0, 'se mezclaron empresas')
})

await spec('ACTIVE-CREDIT-013', G_AC, 'ninguna pantalla escribe una Sale fuera del servicio', () => {
  const archivos: string[] = []
  const recorrer = (dir: string) => {
    for (const nombre of fs.readdirSync(dir)) {
      const p = `${dir}/${nombre}`
      if (fs.statSync(p).isDirectory()) recorrer(p)
      else if (/\.(ts|tsx)$/.test(nombre)) archivos.push(p)
    }
  }
  recorrer('src')
  const escritores = archivos.filter(p => /db\.sales\.(add|bulkAdd|put|bulkPut)\(/.test(readSource(p)))
  metric('archivos que insertan ventas', escritores.join(', '))
  assert(escritores.length === 1 && escritores[0].endsWith('services/saleRequestService.ts'), 'hay otra ruta de creación de ventas')
})

// ############################################################
// Utilidades de efectivo (Bloques 2–4)
// ############################################################
let expSeq = 0
async function pagar(actor: User, sale: Sale, valor: number): Promise<void> {
  const res = await registerPayment({ saleId: sale.id, requestedAmount: valor, actor, fecha: today() })
  if (!res.ok) throw new Error(`pago rechazado (${actor.nombre}): ${res.code}`)
}
async function gastar(actor: User, routeId: string, valor: number): Promise<void> {
  await addExpenseStamped({
    id: `exp-${++expSeq}`, tenantId: T, routeId, categoryId: 'cat-1', valor, fecha: today(),
    userId: actor.id, collectorId: hasPersonalCashbox(actor.rol) ? actor.id : undefined, syncStatus: 'synced',
  } as never)
}
/** Venta cobrable de Carlos otorgada ANTES por la administración (sin caja personal). */
async function ventaAdministrativa(routeId: string, valor: number): Promise<Sale> {
  const c = await cliente(routeId)
  return createDirectSale(entrada(routeId, c.id, SUPER, valor, { numeroCuotas: 10 }), SUPER)
}
/** Juan desembolsa `valor`: solicita, Laura aprueba y Juan entrega el dinero. */
async function desembolsoDeJuan(routeId: string, valor: number): Promise<Sale> {
  const c = await cliente(routeId, 'Cliente de Juan')
  const req = await createSaleRequest(entrada(routeId, c.id, JUAN, valor), JUAN)
  const sale = await approveSaleRequest(req.id, LAURA)
  await confirmDisbursement(sale.id, JUAN)
  return (await db.sales.get(sale.id))!
}
const posicion = async (userId: string, routeId = R_NORTE) =>
  (await personalCashPosition({ tenantId: T, routeId, userId, hasta: new Date().toISOString() })).esperado
const recon = (routeId = R_NORTE) => computeRouteCashReconciliation({ tenantId: T, routeId })
const entregar = (userId: string, amount: number, actor: User = ADMIN, routeId = R_NORTE) =>
  assignBaseToWorker({ actor, tenantId: T, routeId, recipientUserId: userId, amount, motivo: 'Base del día' })
const devolver = (userId: string, amount: number, actor: User = ADMIN, routeId = R_NORTE) =>
  returnBaseFromWorker({ actor, tenantId: T, routeId, fromUserId: userId, amount, motivo: 'Devolución de Base' })
const cerrar = (userId: string, entregado: number, actor: User = ADMIN, motivo?: string) =>
  closeCashSettlement({ actor, tenantId: T, routeId: R_NORTE, userId, entregado, motivo })
const previewJuan = () => previewCashSettlement({ actor: ADMIN, tenantId: T, routeId: R_NORTE, userId: JUAN.id })
function identidad(r: RouteCashReconciliation): string {
  return `libro ${r.libro.saldo} = sin asignar ${r.noAsignado} + personas ${r.enPersonas} · explicación ${r.explicacionNoAsignado.total} · cuadra ${r.cuadra}`
}

// ############################################################
// BASE-WORKER — BASE FÍSICA ENTREGADA AL TRABAJADOR
// ############################################################
const G_BW = 'Base por trabajador'

await spec('BASE-WORKER-001', G_BW, 'la Route recibe / posee Base estructural', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const r = await recon()
  metric('estructural / libro / sin asignar / en personas', `${r.estructural} / ${r.libro.saldo} / ${r.noAsignado} / ${r.enPersonas}`)
  assert(r.estructural === 5_000_000 && r.libro.saldo === 5_000_000 && r.noAsignado === 5_000_000 && r.enPersonas === 0, 'la Base estructural no se refleja')
  assert(r.cuadra, 'la conciliación inicial no cuadra')
})

await spec('BASE-WORKER-002', G_BW, 'se asigna Base a Juan (movimiento explícito y trazable)', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const antes = new Date().toISOString()
  const m = await entregar(JUAN.id, 1_500_000)
  const guardado = await db.cashCustodyMovements.get(m.id)
  metric('movimiento', `${guardado?.tipo} · ${guardado?.amount} · de ${guardado?.fromUserId ?? 'caja de la ruta'} a ${guardado?.toUserId}`)
  metric('registró / origen / motivo', `${guardado?.createdByUserId} / ${guardado?.origen} / ${guardado?.motivo}`)
  assert(guardado?.tipo === 'BASE_ASSIGNMENT' && guardado.toUserId === JUAN.id && !guardado.fromUserId && guardado.amount === 1_500_000, 'el movimiento no es Route → Juan')
  assert(guardado.createdByUserId === ADMIN.id && guardado.routeId === R_NORTE && guardado.createdAt >= antes && guardado.origen === 'route-cash', 'faltan autoría, ruta o instante')
})

await spec('BASE-WORKER-003', G_BW, 'la asignación queda bajo la responsabilidad de Juan (cuadre y Mi efectivo)', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  await entregar(JUAN.id, 1_500_000)
  const admin = await previewJuan()
  const propio = await previewCashSettlement({ actor: JUAN, tenantId: T, routeId: R_NORTE, userId: JUAN.id })
  metric('vista del Admin', `Base ${admin.baseRecibida} · esperado ${admin.esperado}`)
  metric('Mi efectivo de Juan', `Base ${propio.baseRecibida} · esperado ${propio.esperado}`)
  assert(admin.baseRecibida === 1_500_000 && admin.esperado === 1_500_000 && propio.esperado === 1_500_000, 'la Base no quedó a cargo de Juan')
})

await spec('BASE-WORKER-004', G_BW, 'la Base de Juan no aparece en Laura ni en Pedro', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  await entregar(JUAN.id, 1_500_000)
  const laura = await posicion(LAURA.id)
  const pedro = await posicion(PEDRO.id)
  metric('Laura / Pedro', `${laura} / ${pedro}`)
  assert(laura === 0 && pedro === 0, 'la Base de Juan se filtró a otra persona')
})

await spec('BASE-WORKER-005', G_BW, 'la asignación no duplica el capital de la Route', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const antes = await recon()
  await entregar(JUAN.id, 1_500_000)
  const despues = await recon()
  const libroMotor = (await getCashboxSummary(R_NORTE)).saldoActual
  metric('antes', identidad(antes))
  metric('después', identidad(despues))
  metric('Base de la ruta (motor de caja, pantalla)', libroMotor)
  assert(despues.libro.saldo === 5_000_000 && libroMotor === 5_000_000, 'la asignación cambió el libro de la Route')
  assert(despues.noAsignado === 3_500_000 && despues.enPersonas === 1_500_000 && despues.noAsignado + despues.enPersonas === 5_000_000, 'el dinero se duplicó o se perdió')
  assert(despues.cuadra, 'la conciliación no cuadra')
})

await spec('BASE-WORKER-006', G_BW, 'asignación válida a un Supervisor (y el Supervisor entrega a su equipo)', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  await entregar(LAURA.id, 1_000_000)
  const aPedro = await entregar(PEDRO.id, 200_000, LAURA)
  metric('Laura (Supervisora)', await posicion(LAURA.id))
  metric('Laura entrega a Pedro', `${aPedro.amount} · registró ${aPedro.createdByUserId}`)
  assert(await posicion(LAURA.id) === 1_000_000 && await posicion(PEDRO.id) === 200_000, 'la Base del Supervisor no quedó a su cargo')
  assert(can(LAURA, 'cashCustody.manage', { routeId: R_NORTE, tenantId: T }) && !can(JUAN, 'cashCustody.manage', { routeId: R_NORTE, tenantId: T }), 'matriz de custodia incorrecta')
})

await spec('BASE-WORKER-007', G_BW, 'Admin/SuperAdmin no son custodios (no existe "Modo Supervisor"); el ledger es por persona', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const admin = await rechazo(() => entregar(ADMIN.id, 100_000, SUPER))
  const sup = await rechazo(() => entregar(SUPER.id, 100_000, ADMIN))
  const app = readSource('src/app/App.tsx')
  const modoSupervisor = /path="\/supervisor"[\s\S]{0,120}roles=\{\['supervisor'\]\}/.test(app)
  metric('entregar Base a Admin / SuperAdmin', `${admin} / ${sup}`)
  metric('/supervisor/* solo rol supervisor (no hay Modo Supervisor)', modoSupervisor)
  metric('clave del ledger', 'toUserId / fromUserId (no rol)')
  assert(admin !== 'ACEPTADO' && sup !== 'ACEPTADO', 'un administrador quedó como custodio sin Modo Supervisor')
  assert(modoSupervisor, 'apareció un Modo Supervisor no auditado: revisar su integración con la custodia')
})

await spec('BASE-WORKER-008', G_BW, 'usuario no elegible → rechazado; el Cobrador no administra Base', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const casos: [string, () => Promise<unknown>][] = [
    ['inactivo', () => entregar(INACTIVO.id, 100_000)],
    ['socio', () => entregar(SOCIO.id, 100_000)],
    ['secretario', () => entregar(SECRE.id, 100_000)],
    ['Pedro en Sur (no asignado)', () => entregar(PEDRO.id, 100_000, ADMIN, R_SUR)],
    ['persona de otra empresa', () => entregar(AJENO.id, 100_000)],
    ['inexistente', () => entregar('u-nadie', 100_000)],
    ['Juan (cobrador) entrega a Pedro', () => entregar(PEDRO.id, 100_000, JUAN)],
    ['monto 0', () => entregar(JUAN.id, 0)],
    ['monto con decimales', () => entregar(JUAN.id, 10.5)],
    ['sin motivo', () => assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R_NORTE, recipientUserId: JUAN.id, amount: 1000, motivo: ' ' })],
    ['más que la caja sin asignar', () => entregar(JUAN.id, 5_000_001)],
  ]
  for (const [k, f] of casos) {
    const r = await rechazo(f)
    metric(k, r)
    assert(r !== 'ACEPTADO', `se aceptó: ${k}`)
  }
  assert(await db.cashCustodyMovements.count() === 0, 'quedaron movimientos')
})

await spec('BASE-WORKER-009', G_BW, 'Route ajena → rechazada', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const adminSur = await rechazo(() => entregar(JUAN.id, 100_000, ADMIN_SUR))
  const ajeno = await rechazo(() => entregar(JUAN.id, 100_000, AJENO))
  const otraEmpresa = await rechazo(() => assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R_AJENA, recipientUserId: JUAN.id, amount: 1000, motivo: 'Base del día' }))
  const disfrazada = await rechazo(() => assignBaseToWorker({ actor: AJENO, tenantId: T_AJENA, routeId: R_NORTE, recipientUserId: JUAN.id, amount: 1000, motivo: 'Base del día' }))
  metric('Admin de Sur en Norte', adminSur)
  metric('Admin de otra empresa', ajeno)
  metric('ruta de otra empresa', otraEmpresa)
  metric('otra empresa declarando su tenant sobre Norte', disfrazada)
  assert([adminSur, ajeno, otraEmpresa, disfrazada].every(r => r !== 'ACEPTADO'), 'se operó una ruta ajena')
})

await spec('BASE-WORKER-010', G_BW, 'la Oficina no amplía permisos; Oficina inactiva bloquea entregar pero no la devolución', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  // Sur pasa a la misma Oficina que Norte: Alba (solo Sur) sigue sin Norte.
  await db.routes.update(R_SUR, { officeId: OF_LETICIA })
  const albaNorte = await rechazo(() => entregar(JUAN.id, 100_000, ADMIN_SUR))
  await entregar(JUAN.id, 500_000)
  await db.offices.update(OF_LETICIA, { status: 'inactiva' })
  const nueva = await rechazo(() => entregar(JUAN.id, 100_000))
  const devolucion = await rechazo(() => devolver(JUAN.id, 200_000))
  metric('Alba (misma Oficina, sin la ruta)', albaNorte)
  metric('Oficina inactiva · entregar', nueva)
  metric('Oficina inactiva · devolución', devolucion)
  assert(albaNorte !== 'ACEPTADO', 'la Oficina concedió acceso a una ruta no asignada')
  assert(nueva !== 'ACEPTADO' && devolucion === 'ACEPTADO', 'la Oficina inactiva no se respetó correctamente')
  assert(await posicion(JUAN.id) === 300_000, 'la devolución no redujo la responsabilidad')
})

await spec('BASE-WORKER-011', G_BW, 'devolución parcial → reduce la responsabilidad personal; la Route la recupera', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  await entregar(JUAN.id, 1_500_000)
  await entregar(LAURA.id, 400_000)
  await devolver(JUAN.id, 500_000)
  const r = await recon()
  const propia = await rechazo(() => devolver(LAURA.id, 100_000, LAURA))
  const excesiva = await rechazo(() => devolver(JUAN.id, 1_000_001))
  metric('Juan tras devolver 500.000', await posicion(JUAN.id))
  metric('conciliación', identidad(r))
  metric('Laura registra su propia devolución', propia)
  metric('devolver más de lo que tiene', excesiva)
  assert(await posicion(JUAN.id) === 1_000_000, 'la devolución no redujo a Juan')
  assert(r.libro.saldo === 5_000_000 && r.noAsignado === 3_600_000 && r.cuadra, 'la Route no recuperó el efectivo o se creó capital')
  assert(propia !== 'ACEPTADO' && excesiva !== 'ACEPTADO', 'devolución indebida aceptada')
})

await spec('BASE-WORKER-012', G_BW, 'el CashSettlement incluye la Base recibida (fórmula congelada)', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const carlos = await ventaAdministrativa(R_NORTE, 1_000_000)
  await entregar(JUAN.id, 1_500_000)
  await desembolsoDeJuan(R_NORTE, 500_000)
  await pagar(JUAN, carlos, 300_000)
  await gastar(JUAN, R_NORTE, 100_000)
  const p = await previewJuan()
  const formula = computeExpected({ arrastreAnterior: 0, baseRecibida: 1_500_000, baseDevuelta: 0, recaudado: 300_000, desembolsado: 500_000, gastos: 100_000 })
  const doc = await cerrar(JUAN.id, p.esperado)
  metric('vista previa', `arrastre ${p.arrastreAnterior} + Base ${p.baseRecibida} − devuelta ${p.baseDevuelta} + recaudo ${p.recaudado} − desembolso ${p.desembolsado} − gastos ${p.gastos} = ${p.esperado}`)
  metric('documento archivado', `Base ${doc.baseRecibida} · esperado ${doc.esperado} · entregado ${doc.entregado}`)
  assert(p.esperado === 1_200_000 && formula === 1_200_000, 'la fórmula con Base no da 1.200.000')
  assert(doc.baseRecibida === 1_500_000 && doc.baseDevuelta === 0 && doc.esperado === 1_200_000, 'el cuadre no archivó la Base')
  // Sin Base, la fórmula es EXACTAMENTE la de v14.
  assert(computeExpected({ arrastreAnterior: 100, recaudado: 300, desembolsado: 50, gastos: 20 }) === 330, 'la fórmula v14 cambió')
})

await spec('BASE-WORKER-013', G_BW, 'cierre exacto con Base → el siguiente ciclo parte de 0 sin duplicar', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  await entregar(JUAN.id, 1_000_000)
  await desembolsoDeJuan(R_NORTE, 400_000)
  const doc = await cerrar(JUAN.id, 600_000)
  const sig = await previewJuan()
  const r = await recon()
  metric('cierre', `esperado ${doc.esperado} · entregado ${doc.entregado} · diferencia ${doc.diferencia}`)
  metric('siguiente ciclo', `desde ${sig.desde === doc.hasta ? 'el cierre' : sig.desde} · arrastre ${sig.arrastreAnterior} · Base ${sig.baseRecibida} · esperado ${sig.esperado}`)
  metric('conciliación', identidad(r))
  assert(doc.diferencia === 0 && sig.esperado === 0 && sig.baseRecibida === 0 && sig.desde === doc.hasta, 'el siguiente ciclo arrastró Base o saldo')
  assert(r.enPersonas === 0 && r.noAsignado === r.libro.saldo && r.libro.saldo === 4_600_000 && r.cuadra, 'la Route no recuperó el efectivo entregado')
})

await spec('BASE-WORKER-014', G_BW, 'faltante con Base → persiste en el ciclo siguiente y en la conciliación', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  await entregar(JUAN.id, 1_000_000)
  const doc = await cerrar(JUAN.id, 900_000, ADMIN, 'faltaron billetes en la entrega')
  const sig = await previewJuan()
  const r = await recon()
  metric('cierre', `esperado ${doc.esperado} · entregado ${doc.entregado} · faltante ${doc.faltante}`)
  metric('siguiente ciclo', `arrastre ${sig.arrastreAnterior} · esperado ${sig.esperado}`)
  metric('faltantes en la conciliación', r.faltantes.map(f => `${f.nombre} ${f.monto}`).join(', '))
  metric('conciliación', identidad(r))
  assert(doc.faltante === 100_000 && sig.arrastreAnterior === 100_000 && sig.esperado === 100_000, 'el faltante no persistió')
  assert(r.faltantes.length === 1 && r.faltantes[0].monto === 100_000 && r.cuadra, 'la conciliación perdió el faltante')
})

await spec('BASE-WORKER-015', G_BW, 'no se reescribe el histórico previo (pagos, ventas, gastos, cuadres)', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const carlos = await ventaAdministrativa(R_NORTE, 1_000_000)
  await pagar(JUAN, carlos, 200_000)
  await gastar(JUAN, R_NORTE, 50_000)
  const cuadreViejo = await cerrar(JUAN.id, 150_000)
  const snap = async () => JSON.stringify(await Promise.all([db.payments.toArray(), db.sales.toArray(), db.expenses.toArray(), db.cashSettlements.get(cuadreViejo.id), db.capitalMovements.toArray()]))
  const antes = await snap()
  await entregar(JUAN.id, 700_000)
  await devolver(JUAN.id, 100_000)
  await entregar(LAURA.id, 300_000)
  await transferBaseBetweenWorkers({ actor: ADMIN, tenantId: T, routeId: R_NORTE, fromUserId: LAURA.id, toUserId: JUAN.id, amount: 100_000, motivo: 'refuerzo de Base' })
  const despues = await snap()
  metric('movimientos de custodia', await db.cashCustodyMovements.count())
  metric('históricos idénticos', antes === despues)
  metric('cuadre previo (sin campos de Base)', `${cuadreViejo.esperado} · Base ${cuadreViejo.baseRecibida}`)
  assert(antes === despues, 'la custodia modificó hechos históricos')
  assert(await posicion(JUAN.id) === 700_000 && await posicion(LAURA.id) === 200_000, 'el traspaso no movió la responsabilidad')
})

// ############################################################
// MOVEMENT-SVC — CAPITAL · TRANSFERENCIAS · RETIROS POR SERVICIO
// ############################################################
const G_MS = 'Movimientos por servicio'
const HOY_F = today()

await spec('MOVEMENT-SVC-001', G_MS, 'Capital validado en servicio (capacidad, monto, fecha, empresa)', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const ok = await registerCapital({ actor: ADMIN, tenantId: T, routeId: R_NORTE, valor: 2_000_000, descripcion: 'aporte socio', fecha: HOY_F })
  const casos: [string, () => Promise<unknown>][] = [
    ['Supervisor', () => registerCapital({ actor: LAURA, tenantId: T, routeId: R_NORTE, valor: 1000 })],
    ['Cobrador', () => registerCapital({ actor: JUAN, tenantId: T, routeId: R_NORTE, valor: 1000 })],
    ['valor 0', () => registerCapital({ actor: ADMIN, tenantId: T, routeId: R_NORTE, valor: 0 })],
    ['fecha futura', () => registerCapital({ actor: ADMIN, tenantId: T, routeId: R_NORTE, valor: 1000, fecha: '2999-01-01' })],
    ['sin actor', () => registerCapital({ actor: null, tenantId: T, routeId: R_NORTE, valor: 1000 })],
  ]
  metric('Admin +2.000.000', `${ok.tipo} · ${ok.valor}`)
  for (const [k, f] of casos) { const r = await rechazo(f); metric(k, r); assert(r !== 'ACEPTADO', `capital aceptado: ${k}`) }
  const r = await recon()
  metric('estructural', r.estructural)
  assert(r.estructural === 7_000_000 && r.libro.saldo === 7_000_000, 'el capital no sumó a la Base estructural')
})

await spec('MOVEMENT-SVC-002', G_MS, 'Transferencia Route → Route: atómica, traslado interno (no crea capital)', async () => {
  await empresa({ capitalNorte: 5_000_000, capitalSur: 1_000_000 })
  const totalAntes = (await recon(R_NORTE)).estructural + (await recon(R_SUR)).estructural
  const { transfer, kind } = await registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'route', id: R_NORTE }, destino: { type: 'route', id: R_SUR }, valor: 2_000_000 })
  const norte = await recon(R_NORTE)
  const sur = await recon(R_SUR)
  const sinFondos = await rechazo(() => registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'route', id: R_NORTE }, destino: { type: 'route', id: R_SUR }, valor: 3_000_001 }))
  metric('tipo', kind)
  metric('Norte / Sur', `${norte.libro.saldo} / ${sur.libro.saldo}`)
  metric('total empresa antes → después', `${totalAntes} → ${norte.estructural + sur.estructural}`)
  metric('más que los fondos de Norte', sinFondos)
  assert(kind === 'traslado-interno' && transfer.routeOrigenId === R_NORTE && transfer.routeDestinoId === R_SUR, 'no se clasificó como traslado interno')
  assert(norte.libro.saldo === 3_000_000 && sur.libro.saldo === 3_000_000 && norte.estructural + sur.estructural === totalAntes, 'el traslado creó o perdió capital')
  assert(sinFondos !== 'ACEPTADO' && (await db.transfers.count()) === 1, 'se transfirió sin fondos')
})

await spec('MOVEMENT-SVC-003', G_MS, 'contrapartidas (Caja socios, entrega en mano) son atómicas: todo o nada', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  // a) Socio → Norte entregado en mano a Juan: transferencia + Caja socios + custodia.
  const { kind, custody, partnerMovements } = await registerTransfer({
    actor: SUPER, tenantId: T, origen: { type: 'partner', id: SOCIO.id }, destino: { type: 'route', id: R_NORTE }, valor: 800_000, entregarA: { userId: JUAN.id },
  })
  const r = await recon()
  metric('Socio → Norte', `${kind} · Caja socios ${partnerMovements.map(m => m.type).join(',')} · en mano a ${custody?.toUserId} (${custody?.relatedTransferId ? 'enlazada' : 'sin enlace'})`)
  metric('conciliación', identidad(r))
  assert(kind === 'aporte-socio' && custody?.toUserId === JUAN.id && custody.origen === 'transfer' && partnerMovements.length === 1, 'la entrega no quedó enlazada')
  assert(r.libro.saldo === 5_800_000 && await posicion(JUAN.id) === 800_000 && r.noAsignado === 5_000_000 && r.cuadra, 'la entrega en mano duplicó dinero')
  // b) Fallo a mitad de la transacción (Caja socios): no queda la transferencia.
  const conteo = async () => `${await db.transfers.count()}/${await db.partnerCashMovements.count()}/${await db.cashCustodyMovements.count()}`
  const antes = await conteo()
  const original = db.partnerCashMovements.bulkAdd.bind(db.partnerCashMovements)
  ;(db.partnerCashMovements as { bulkAdd: unknown }).bulkAdd = () => Promise.reject(new Error('fallo simulado en Caja socios'))
  const fallo = await rechazo(() => registerTransfer({ actor: SUPER, tenantId: T, origen: { type: 'route', id: R_NORTE }, destino: { type: 'partner', id: SOCIO.id }, valor: 100_000 }))
  ;(db.partnerCashMovements as { bulkAdd: unknown }).bulkAdd = original
  // c) Fallo en la entrega en mano: tampoco queda la transferencia.
  const addOriginal = db.cashCustodyMovements.add.bind(db.cashCustodyMovements)
  ;(db.cashCustodyMovements as { add: unknown }).add = () => Promise.reject(new Error('fallo simulado en custodia'))
  const fallo2 = await rechazo(() => registerTransfer({ actor: SUPER, tenantId: T, origen: { type: 'partner', id: SOCIO.id }, destino: { type: 'route', id: R_NORTE }, valor: 100_000, entregarA: { userId: JUAN.id } }))
  ;(db.cashCustodyMovements as { add: unknown }).add = addOriginal
  const despues = await conteo()
  metric('transferencias/socios/custodia antes → después de dos fallos', `${antes} → ${despues}`)
  metric('fallos', `${fallo} | ${fallo2}`)
  assert(fallo !== 'ACEPTADO' && fallo2 !== 'ACEPTADO' && antes === despues, 'una transferencia quedó a medias')
  // d) Receptor no elegible: rechazo antes de escribir.
  const noElegible = await rechazo(() => registerTransfer({ actor: SUPER, tenantId: T, origen: { type: 'partner', id: SOCIO.id }, destino: { type: 'route', id: R_NORTE }, valor: 1000, entregarA: { userId: SECRE.id } }))
  assert(noElegible !== 'ACEPTADO' && (await conteo()) === antes, 'entrega en mano a un no elegible')
})

await spec('MOVEMENT-SVC-004', G_MS, 'retiro > fondos → rechazado (incluido el efectivo que está en manos de trabajadores)', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const excede = await rechazo(() => registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R_NORTE, valor: 5_000_001 }))
  await entregar(JUAN.id, 1_500_000)
  const enManos = await rechazo(() => registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R_NORTE, valor: 4_000_000 }))
  const exacto = await registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R_NORTE, valor: 3_500_000 })
  const vacio = await rechazo(() => registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R_NORTE, valor: 1 }))
  // Dos retiros simultáneos no gastan el mismo dinero.
  await empresa({ capitalNorte: 1_000_000 })
  const dobles = await Promise.allSettled([
    registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R_NORTE, valor: 700_000 }),
    registerWithdrawal({ actor: SUPER, tenantId: T, routeId: R_NORTE, valor: 700_000 }),
  ])
  metric('retirar 5.000.001 de 5.000.000', excede)
  metric('retirar 4.000.000 con 1.500.000 en manos de Juan', enManos)
  metric('retirar exactamente lo no asignado', `${exacto.valor} · ACEPTADO`)
  metric('retirar 1 con la caja en 0', vacio)
  metric('dos retiros de 700.000 a la vez con 1.000.000', dobles.map(d => d.status).join(' / '))
  assert(excede !== 'ACEPTADO' && enManos !== 'ACEPTADO' && vacio !== 'ACEPTADO', 'un retiro superó los fondos')
  assert(dobles.filter(d => d.status === 'fulfilled').length === 1, 'dos retiros concurrentes gastaron el mismo dinero')
  assert(!readSource('src/pages/admin/WithdrawalsPage.tsx').includes('db.withdrawals.add'), 'la pantalla sigue escribiendo el retiro')
})

await spec('MOVEMENT-SVC-005', G_MS, 'la capacidad se revalida en el servicio', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const casos: [string, () => Promise<unknown>][] = [
    ['Supervisor retira', () => registerWithdrawal({ actor: LAURA, tenantId: T, routeId: R_NORTE, valor: 1000 })],
    ['Supervisor transfiere', () => registerTransfer({ actor: LAURA, tenantId: T, origen: { type: 'route', id: R_NORTE }, destino: { type: 'route', id: R_SUR }, valor: 1000 })],
    ['Cobrador transfiere', () => registerTransfer({ actor: JUAN, tenantId: T, origen: { type: 'route', id: R_NORTE }, destino: { type: 'route', id: R_SUR }, valor: 1000 })],
    ['Socio registra capital', () => registerCapital({ actor: SOCIO, tenantId: T, routeId: R_NORTE, valor: 1000 })],
    ['Secretario retira', () => registerWithdrawal({ actor: SECRE, tenantId: T, routeId: R_NORTE, valor: 1000 })],
    ['Admin de Sur retira de Norte', () => registerWithdrawal({ actor: ADMIN_SUR, tenantId: T, routeId: R_NORTE, valor: 1000 })],
    ['Admin de Sur transfiere Norte → Sur', () => registerTransfer({ actor: ADMIN_SUR, tenantId: T, origen: { type: 'route', id: R_NORTE }, destino: { type: 'route', id: R_SUR }, valor: 1000 })],
    ['Admin entrega en mano sin cashCustody (Secretario)', () => registerTransfer({ actor: SECRE, tenantId: T, origen: { type: 'partner', id: SOCIO.id }, destino: { type: 'route', id: R_NORTE }, valor: 1000, entregarA: { userId: JUAN.id } })],
  ]
  for (const [k, f] of casos) { const r = await rechazo(f); metric(k, r); assert(r !== 'ACEPTADO', `aceptado sin capacidad: ${k}`) }
  const paginas = ['CapitalPage', 'TransfersPage', 'WithdrawalsPage'].map(p => readSource(`src/pages/admin/${p}.tsx`))
  assert(paginas.every(s => !/db\.(capitalMovements|transfers|withdrawals|partnerCashMovements)\.add/.test(s)), 'una pantalla sigue escribiendo por su cuenta')
})

await spec('MOVEMENT-SVC-006', G_MS, 'Oficina inactiva bloquea capital, transferencias y retiros nuevos', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  await db.offices.update(OF_LETICIA, { status: 'inactiva' })
  const casos: [string, () => Promise<unknown>][] = [
    ['capital', () => registerCapital({ actor: ADMIN, tenantId: T, routeId: R_NORTE, valor: 1000 })],
    ['retiro', () => registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R_NORTE, valor: 1000 })],
    ['transferencia desde Norte', () => registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'route', id: R_NORTE }, destino: { type: 'route', id: R_SUR }, valor: 1000 })],
    ['transferencia hacia Norte', () => registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'route', id: R_SUR }, destino: { type: 'route', id: R_NORTE }, valor: 1000 })],
  ]
  for (const [k, f] of casos) { const r = await rechazo(f); metric(k, r); assert(/Oficina/i.test(r), `no bloqueó por Oficina: ${k}`) }
  const sur = await registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R_SUR, valor: 1000 })
  metric('Sur (sin Oficina) sigue operando', sur.valor)
})

await spec('MOVEMENT-SVC-007', G_MS, 'Route / socio de otra empresa → rechazado', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const casos: [string, () => Promise<unknown>][] = [
    ['Admin retira de ruta ajena', () => registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R_AJENA, valor: 1000 })],
    ['Admin de otra empresa en Norte', () => registerCapital({ actor: AJENO, tenantId: T, routeId: R_NORTE, valor: 1000 })],
    ['otra empresa declarando su tenant', () => registerWithdrawal({ actor: AJENO, tenantId: T_AJENA, routeId: R_NORTE, valor: 1000 })],
    ['Norte → ruta ajena', () => registerTransfer({ actor: SUPER, tenantId: T, origen: { type: 'route', id: R_NORTE }, destino: { type: 'route', id: R_AJENA }, valor: 1000 })],
    ['socio inexistente', () => registerTransfer({ actor: SUPER, tenantId: T, origen: { type: 'partner', id: AJENO.id }, destino: { type: 'route', id: R_NORTE }, valor: 1000 })],
    ['conciliación de Norte por otra empresa', () => getRouteCashReconciliation({ actor: AJENO, tenantId: T, routeId: R_NORTE })],
    ['conciliación por el Cobrador', () => getRouteCashReconciliation({ actor: JUAN, tenantId: T, routeId: R_NORTE })],
  ]
  for (const [k, f] of casos) { const r = await rechazo(f); metric(k, r); assert(r !== 'ACEPTADO', `aceptado: ${k}`) }
})

await spec('MOVEMENT-SVC-008', G_MS, 'fecha y autoría las pone el servicio', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const t0 = new Date().toISOString()
  const cap = await registerCapital({ actor: ADMIN, tenantId: T, routeId: R_NORTE, valor: 1000, fecha: '2026-09-01' })
  const ret = await registerWithdrawal({ actor: SUPER, tenantId: T, routeId: R_NORTE, valor: 500 })
  const { transfer } = await registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'route', id: R_NORTE }, destino: { type: 'route', id: R_SUR }, valor: 200 })
  const t1 = new Date().toISOString()
  const audit = await db.auditLogs.where('entityId').anyOf([cap.id, ret.id, transfer.id]).toArray()
  metric('capital', `fecha ${cap.fecha} · autor ${cap.userId} · instante ${cap.createdAt}`)
  metric('retiro', `fecha ${ret.fecha} · autor ${ret.userId}`)
  metric('transferencia', `fecha ${transfer.fecha} · autor ${transfer.userId}`)
  metric('auditoría', audit.map(a => a.action).sort().join(', '))
  assert(cap.fecha === '2026-09-01' && cap.userId === ADMIN.id && cap.createdAt >= t0 && cap.createdAt <= t1, 'capital sin autoría o instante')
  assert(ret.fecha === HOY_F && ret.userId === SUPER.id && transfer.userId === ADMIN.id && transfer.createdAt >= t0, 'retiro/transferencia sin autoría')
  assert(audit.length === 3, 'faltan registros de auditoría')
})

// ############################################################
// RECON — CONCILIACIÓN ROUTE ↔ TRABAJADORES
// ############################################################
const G_RC = 'Conciliación'

await spec('RECON-001', G_RC, 'identidad libro = no asignado + personas en un escenario mixto (faltante, sobrante, traspaso, gasto administrativo)', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const carlos = await ventaAdministrativa(R_NORTE, 1_000_000)
  await entregar(JUAN.id, 800_000)
  await entregar(LAURA.id, 300_000)
  await pagar(JUAN, carlos, 150_000)
  await pagar(LAURA, carlos, 70_000)
  await gastar(ADMIN, R_NORTE, 20_000)                             // gasto administrativo
  await desembolsoDeJuan(R_NORTE, 200_000)
  await cerrar(JUAN.id, 700_000, ADMIN, 'faltaron cincuenta mil')   // esperado 750.000 → faltante 50.000
  await cerrar(LAURA.id, 400_000, ADMIN, 'sobraron treinta mil')    // esperado 370.000 → sobrante 30.000
  await entregar(JUAN.id, 100_000)
  await transferBaseBetweenWorkers({ actor: ADMIN, tenantId: T, routeId: R_NORTE, fromUserId: JUAN.id, toUserId: PEDRO.id, amount: 60_000, motivo: 'refuerzo de Base' })
  const r = await recon()
  for (const p of r.personas) metric(p.nombre, `posición ${p.posicion} (arrastre ${p.arrastreAnterior}, Base ${p.baseRecibida}−${p.baseDevuelta}, recaudo ${p.recaudado}, desembolso ${p.desembolsado}, gastos ${p.gastos})`)
  const e = r.explicacionNoAsignado
  metric('explicación', `${e.estructural} + ${e.operacionNoPersonal} − ${e.baseEntregadaNeta} + ${e.entregadoEnCuadres} − ${e.sobrantesRegistrados} = ${e.total}`)
  metric('identidad', identidad(r))
  metric('efectivo físico sin asignar', r.efectivoFisicoNoAsignado)
  assert(r.cuadra && r.noAsignado + r.enPersonas === r.libro.saldo, 'la conciliación no cuadra')
  assert(r.personas.find(p => p.userId === JUAN.id)?.posicion === 50_000 + 100_000 - 60_000, 'posición de Juan incorrecta')
  assert(r.personas.find(p => p.userId === PEDRO.id)?.posicion === 60_000, 'el traspaso no llegó a Pedro')
  assert(r.sobrantes.length === 1 && r.sobrantes[0].monto === 30_000 && r.efectivoFisicoNoAsignado === r.noAsignado + 30_000, 'el sobrante no se trató aparte')
})

await spec('RECON-002', G_RC, 'la cartera (deuda de clientes) se informa aparte y no entra al efectivo', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  await ventaAdministrativa(R_NORTE, 1_000_000)
  const r = await recon()
  metric('cartera en calle / libro / sin asignar', `${r.cartera.carteraEnCalle} / ${r.libro.saldo} / ${r.noAsignado}`)
  assert(r.cartera.carteraEnCalle === 1_200_000 && r.libro.saldo === 4_000_000 && r.noAsignado === 4_000_000, 'la cartera se mezcló con el efectivo')
})

await spec('RECON-003', G_RC, 'WeeklySettlement conserva su naturaleza: la custodia no altera la liquidación de la Route', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const carlos = await ventaAdministrativa(R_NORTE, 1_000_000)
  await pagar(JUAN, carlos, 200_000)
  const rango = { tenantId: T, routeId: R_NORTE, semanaInicio: '2026-01-01', semanaFin: '2999-12-31' }
  // Cifras de la liquidación (sin `id`/`createdAt`, que son nuevos en cada cálculo).
  const cifras = async () => { const { id: _i, createdAt: _c, ...resto } = await generateWeeklySettlement(rango); return JSON.stringify(resto) }
  const antes = await cifras()
  await entregar(JUAN.id, 1_000_000)
  await devolver(JUAN.id, 300_000)
  const despues = await cifras()
  metric('liquidación idéntica tras mover Base', antes === despues)
  metric('tablas distintas', 'weeklySettlements ≠ cashSettlements ≠ cashCustodyMovements')
  assert(antes === despues, 'la custodia cambió la liquidación semanal')
})

await spec('RECON-004', G_RC, 'reactividad: entregar/devolver/transferir/retirar avisan a las vistas sin F5', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const vistos: string[] = []
  const off = subscribeDataChanges(OPERATIONAL_TABLES, t => vistos.push([...t].filter(x => x !== 'auditLogs').sort().join('+')))
  await entregar(JUAN.id, 100_000)
  await devolver(JUAN.id, 50_000)
  await registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'route', id: R_NORTE }, destino: { type: 'route', id: R_SUR }, valor: 1000 })
  await registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R_NORTE, valor: 1000 })
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R_NORTE, valor: 1000 })
  await new Promise(r => setTimeout(r, 50))
  off()
  metric('avisos', vistos.join(' | '))
  for (const t of ['cashCustodyMovements', 'transfers', 'withdrawals', 'capitalMovements']) {
    assert(vistos.some(v => v.includes(t)), `no se avisó el cambio de ${t}`)
  }
  assert((OPERATIONAL_TABLES as readonly string[]).includes('cashCustodyMovements'), 'la tabla nueva no es observada')
})

// ############################################################
// CASH-BOUNDARY-011 — custodia concurrente con el cierre
// ############################################################
await spec('CASH-BOUNDARY-011', 'Fronteras', 'una entrega de Base simultánea al cierre cae en UN solo ciclo', async () => {
  const resultados: string[] = []
  for (let i = 0; i < 5; i++) {
    await empresa({ capitalNorte: 5_000_000 })
    await entregar(JUAN.id, 1_000_000)
    const [cierre, mov] = await Promise.all([cerrar(JUAN.id, 1_000_000, ADMIN, 'cierre concurrente de prueba').catch(e => e as Error), entregar(JUAN.id, 200_000)])
    if (cierre instanceof Error) { resultados.push(`rechazado: ${cierre.message.slice(0, 40)}`); continue }
    const sig = await previewJuan()
    const enCierre = cierre.baseRecibida === 1_200_000
    const enSiguiente = sig.baseRecibida === 200_000
    resultados.push(`${enCierre ? 'en el cierre' : enSiguiente ? 'en el siguiente' : 'PERDIDA'}`)
    assert(enCierre !== enSiguiente, `la entrega ${mov.id} quedó en ${enCierre ? 'ambos' : 'ningún'} ciclo`)
  }
  metric('5 carreras', resultados.join(', '))
})

// ############################################################
// DOMINGO — la operación administrativa no se bloquea
// ############################################################
await spec('SUNDAY-ADMIN-001', 'Domingo', 'en domingo Admin/SuperAdmin cuadran, entregan Base, retiran y aprueban', async () => {
  const RealDate = Date
  const real = new RealDate()
  const offset = ((7 - real.getDay()) % 7) * 86_400_000
  class Domingo extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset)
      else super(...(args as [string]))
    }
    static now() { return RealDate.now() + offset }
  }
  ;(globalThis as { Date: DateConstructor }).Date = Domingo as unknown as DateConstructor
  try {
    await empresa({ capitalNorte: 5_000_000 })
    const dia = new Date().getDay()
    await entregar(JUAN.id, 300_000)
    const c = await cliente(R_NORTE)
    const req = await createSaleRequest(entrada(R_NORTE, c.id, JUAN, 300_000, { fechaInicio: today() }), JUAN)
    await approveSaleRequest(req.id, ADMIN)
    const doc = await cerrar(JUAN.id, 300_000, SUPER)
    const w = await registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R_NORTE, valor: 100_000 })
    metric('día simulado (0 = domingo)', dia)
    metric('entrega de Base, aprobación, cuadre y retiro', `OK · cuadre ${doc.diferencia === 0 ? 'exacto' : doc.diferencia} · retiro ${w.valor}`)
    assert(dia === 0, 'la simulación no cayó en domingo')
  } finally {
    ;(globalThis as { Date: DateConstructor }).Date = RealDate
  }
  const fuentes = ['cashCustodyService', 'routeFundsService', 'routeCashReconciliation', 'saleRequestService', 'cashSettlementService'].map(f => readSource(`src/services/${f}.ts`))
  assert(fuentes.every(s => !/getDay\(\)/.test(s)), 'un servicio nuevo restringe por día de la semana')
})

// ############################################################
// SMOKE — recorridos A–G
// ############################################################
const G_SM = 'Smoke'

await spec('SMOKE-A', G_SM, 'Juan (cobrador) intenta nueva venta a Carlos con Venta A activa', async () => {
  await empresa()
  const { carlos } = await carlosConVentaA()
  const directa = await rechazo(() => createDirectSale(entrada(R_NORTE, carlos.id, JUAN), JUAN))
  const req = await createSaleRequest(entrada(R_NORTE, carlos.id, JUAN), JUAN)
  metric('crédito directo', directa)
  metric('solicitud', `${req.status} (${req.authorizationReason})`)
  metric('créditos activos de Carlos', (await activasDe(carlos.id)).length)
  assert(directa !== 'ACEPTADO' && req.status === 'pending' && (await activasDe(carlos.id)).length === 1, 'SMOKE A falló')
})

await spec('SMOKE-B', G_SM, 'Laura (supervisora) otorga crédito directo a Carlos con crédito activo, como antes', async () => {
  await empresa()
  const { carlos } = await carlosConVentaA()
  const v = await createDirectSale(entrada(R_NORTE, carlos.id, LAURA), LAURA)
  metric('venta de Laura', `${v.status} · ${v.disbursementStatus} · efectivo de ${v.disbursedByCollectorId}`)
  assert(v.status === 'activa' && v.disbursedByCollectorId === LAURA.id && (await activasDe(carlos.id)).length === 2, 'SMOKE B falló')
})

await spec('SMOKE-C..G', G_SM, 'Norte 5.000.000 → Base a Juan → operación → cierre exacto → faltante → conciliación', async () => {
  await empresa({ capitalNorte: 5_000_000 })
  const carlos = await ventaAdministrativa(R_NORTE, 1_000_000)   // préstamo previo de la administración
  // C — Base personal
  await entregar(JUAN.id, 1_500_000)
  const c = await recon()
  metric('C · Juan responsable', await posicion(JUAN.id))
  metric('C · Route', `estructural ${c.estructural} · libro ${c.libro.saldo} · sin asignar ${c.noAsignado} · en Juan ${c.enPersonas}`)
  assert(await posicion(JUAN.id) === 1_500_000 && c.libro.saldo === 4_000_000 && c.noAsignado === 2_500_000 && c.cuadra, 'SMOKE C')
  // D — operación personal
  await desembolsoDeJuan(R_NORTE, 500_000)
  await pagar(JUAN, carlos, 300_000)
  await gastar(JUAN, R_NORTE, 100_000)
  const d = await previewJuan()
  metric('D · cálculo', `arrastre ${d.arrastreAnterior} + Base ${d.baseRecibida} − desembolso ${d.desembolsado} + recaudo ${d.recaudado} − gasto ${d.gastos} = ${d.esperado}`)
  assert(d.esperado === 1_200_000, 'SMOKE D')
  // E — entrega exacta
  const e = await cerrar(JUAN.id, 1_200_000)
  const eSig = await previewJuan()
  const eR = await recon()
  metric('E · cierre', `esperado ${e.esperado} · entregado ${e.entregado} · ${e.diferencia === 0 ? 'EXACTO' : e.diferencia}`)
  metric('E · siguiente ciclo', `arrastre ${eSig.arrastreAnterior} · esperado ${eSig.esperado}`)
  metric('E · Route', identidad(eR))
  assert(e.diferencia === 0 && eSig.esperado === 0 && eR.enPersonas === 0 && eR.noAsignado === eR.libro.saldo, 'SMOKE E')
  // F — faltante
  await entregar(JUAN.id, 1_000_000)
  await pagar(JUAN, carlos, 200_000)
  const fPrev = await previewJuan()
  const f = await cerrar(JUAN.id, 1_100_000, ADMIN, 'faltan cien mil de la ruta')
  const fSig = await previewJuan()
  metric('F · cierre', `esperado ${fPrev.esperado} · entregado ${f.entregado} · faltante ${f.faltante}`)
  metric('F · siguiente ciclo', `arrastre ${fSig.arrastreAnterior}`)
  assert(fPrev.esperado === 1_200_000 && f.faltante === 100_000 && fSig.arrastreAnterior === 100_000, 'SMOKE F')
  // G — conciliación
  const g = await recon()
  const x = g.explicacionNoAsignado
  metric('G · libro', `capital ${g.libro.capital} + cobros ${g.libro.cobros} − desembolsos ${g.libro.desembolsos} − gastos ${g.libro.gastos} = ${g.libro.saldo}`)
  metric('G · personas', g.personas.filter(p => p.posicion).map(p => `${p.nombre} ${p.posicion}`).join(', '))
  metric('G · sin asignar (a)', `${g.libro.saldo} − ${g.enPersonas} = ${g.noAsignado}`)
  metric('G · sin asignar (b)', `${x.estructural} + (${x.operacionNoPersonal}) − ${x.baseEntregadaNeta} + ${x.entregadoEnCuadres} − ${x.sobrantesRegistrados} = ${x.total}`)
  metric('G · faltantes', g.faltantes.map(ff => `${ff.nombre} ${ff.monto}`).join(', '))
  metric('G · cartera (aparte)', g.cartera.carteraEnCalle)
  assert(g.cuadra && g.libro.saldo === 3_900_000 && g.enPersonas === 100_000 && g.noAsignado === 3_800_000, 'SMOKE G')
})

// ============================================================
// Resumen
// ============================================================
const PAD = 22
function line(ch = '─') { return ch.repeat(96) }

console.log('')
console.log(line('═'))
console.log('  RUTACASH — SUITE CRÉDITO ACTIVO · BASE POR TRABAJADOR · MOVIMIENTOS · CONCILIACIÓN')
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
  for (const r of fallidos) console.log(`  · ${r.id} — ${r.desc}\n    ${r.error}`)
  console.log('')
  console.log('SUITE BASE/CRÉDITO: FALLÓ')
} else {
  console.log('')
  console.log('SUITE BASE/CRÉDITO: TODOS LOS CASOS PASAN')
}

process.exit(fallidos.length === 0 ? 0 : 1)
