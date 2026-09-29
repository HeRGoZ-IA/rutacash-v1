// ============================================================
// RUTACASH — SUITE CRÉDITO ACTIVO · BASE POR TRABAJADOR · MOVIMIENTOS · CONCILIACIÓN
// ------------------------------------------------------------
//   npm run test:basecash
//
// Servicios de PRODUCCIÓN sobre el singleton `db` real (Dexie + fake-indexeddb):
// el mismo escenario de un solo equipo y una sola IndexedDB de las pruebas del socio.
//
// Familias:
//   ACTIVE-CREDIT-*  segundo crédito del Cobrador (incidente 2026-09).
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
  approveSaleRequest, createDirectSale, createSaleRequest, findActiveSaleForClient, type SaleInputs,
} from '../src/services/saleRequestService'
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
