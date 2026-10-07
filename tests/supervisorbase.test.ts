// ============================================================
// RUTACASH — SUITE BASE DEL SUPERVISOR: REACTIVIDAD Y VALIDACIÓN (DEXIE REAL)
// ------------------------------------------------------------
//   npm run test:supervisorbase
//
// Ajuste del socio 2026-10-02, punto 5. La Ronda 4 dejó UNA fórmula y UNA fuente de
// la Base (`getRouteBase`); aquí se prueba que las pantallas la RELEAN cuando cambia
// y que el servicio no venda con una cifra vieja.
//
// Cómo se prueba una pantalla sin navegador: cada pantalla es "señal + servicio".
//   · Señal: `useDataRevision` / `watchQuery` (src/lib/dataRevision.ts) sobre
//     `storagemutated` de Dexie. `watchQuery` es EXACTAMENTE el núcleo de
//     `useRouteCapital` / `useCapitalGuard`; las páginas con `useDataRevision` usan
//     la misma suscripción y aquí se modelan con `watchQuery(OPERATIONAL_TABLES, …)`.
//   · Servicio: la misma función que llama la pantalla.
//   · Cableado: se comprueba en el código fuente que cada pantalla depende de la
//     señal (sin eso, la señal no sirve de nada: era el defecto).
// La prueba de extremo a extremo en Chrome real queda en la documentación del punto 5.
//
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { db } from '../src/lib/db'
import { sembrarResponsables } from './financial/capitalFixture'
import { today } from '../src/lib/formatters'
import { OPERATIONAL_TABLES, ROUTE_BASE_TABLES, subscribeDataChanges, watchQuery } from '../src/lib/dataRevision'
import { getRouteBase, getRouteAvailableCapital, getRouteFinancialSummary } from '../src/services/cashboxEngine'
import { computeRouteBaseBreakdown, getRouteCashReconciliation } from '../src/services/routeCashReconciliation'
import { previewCashSettlement } from '../src/services/cashSettlementService'
import { registerCapital, registerTransfer, registerWithdrawal } from '../src/services/routeFundsService'
import { assignBaseToWorker, returnBaseFromWorker } from '../src/services/cashCustodyService'
import { reverseCapitalMovement, reverseTransfer, reverseWithdrawal } from '../src/services/movementReversalService'
import { createDirectSale, type SaleInputs } from '../src/services/saleRequestService'
import type { Client, User } from '../src/models/types'
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
// Escenario: Barreiro y Centro (Oficina Leticia)
// ============================================================
const T = 't-adex'
const R1 = 'r-barreiro'
const R2 = 'r-centro'
const OF1 = 'of-leticia'
const HOY = today()

const persona = (id: string, nombre: string, rol: User['rol'], rutas: string[]): User => ({
  id, tenantId: T, nombre, email: `${id}@adex.co`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)

const ADMIN = persona('u-admin', 'Andrés Admin', 'admin', [R1, R2])
const LAURA = persona('u-laura', 'Laura Supervisora', 'supervisor', [R1, R2])
const JUAN = persona('u-juan', 'Juan Cobrador', 'cobrador', [R1])
const SOCIO = persona('u-socio', 'Hernán Socio', 'socio', [R1, R2])

async function empresa() {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.add({ id: T, nombre: 'ADEX', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z' } as never)
  await db.offices.add({ id: OF1, tenantId: T, nombre: 'Leticia', codigo: 'LET', status: 'activa', createdAt: '', updatedAt: '' } as never)
  const ruta = (id: string, nombre: string) =>
    ({ id, tenantId: T, officeId: OF1, nombre, codigo: id, status: 'activa', capitalInicial: 0, capitalActual: 0, tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 0, createdAt: '2026-09-01' })
  await db.routes.bulkAdd([ruta(R1, 'Barreiro'), ruta(R2, 'Centro')] as never[])
  await db.users.bulkAdd([ADMIN, LAURA, JUAN, SOCIO])
  // v16: Andrés (primer Admin de ambas rutas) es su responsable de capital, con bolsa.
  await sembrarResponsables(db, T, { [R1]: ADMIN.id, [R2]: ADMIN.id })
}

const capital = (valor: number, routeId = R1) => registerCapital({ actor: ADMIN, tenantId: T, routeId, valor })
const retiro = (valor: number, routeId = R1) => registerWithdrawal({ actor: ADMIN, tenantId: T, routeId, valor })
const transferir = (valor: number, from = R1, to = R2) =>
  registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'route', id: from }, destino: { type: 'route', id: to }, valor })
const entregar = (u: User, amount: number) => assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R1, recipientUserId: u.id, amount, motivo: 'Base' })
const devolver = (u: User, amount: number) => returnBaseFromWorker({ actor: ADMIN, tenantId: T, routeId: R1, fromUserId: u.id, amount, motivo: 'Devolución' })
const MOTIVO = { reason: 'Error de digitación verificado' }

let cliSeq = 0
function nuevoCliente(routeId = R1): Client {
  const id = `cli-${++cliSeq}`
  return { id, tenantId: T, routeId, nombre: id, documento: id, telefonoPrincipal: '300', direccionPrincipal: 'x', direccionSecundaria: 'y', status: 'activo', createdAt: '', updatedAt: '' } as Client
}
const inputs = (clientId: string, valorVenta: number, routeId = R1): SaleInputs => ({
  tenantId: T, routeId, clientId, createdByUserId: LAURA.id, valorVenta, tasaInteres: 20, numeroCuotas: 10,
  frecuenciaPago: 'diaria', fechaInicio: HOY, paymentDays: [0, 1, 2, 3, 4, 5, 6],
})
async function vender(valor: number, routeId = R1, actor: User = LAURA) {
  const c = nuevoCliente(routeId)
  await db.clients.add(c)
  return createDirectSale({ ...inputs(c.id, valor, routeId), createdByUserId: actor.id }, actor)
}

/**
 * Una pantalla abierta: publica lo que lee `read` al montar y tras cada escritura en
 * `tables`. Agrupación corta (5 ms) para que la suite sea rápida; la lógica es la de
 * producción (150 ms).
 */
interface Pantalla<T> { valor(): T | undefined; lecturas(): number; publicaciones(): number; cerrar(): void }
function pantalla<T>(read: () => Promise<T>, tables: readonly string[] = OPERATIONAL_TABLES): Pantalla<T> {
  let v: T | undefined
  let lecturas = 0
  let publicaciones = 0
  const cerrar = watchQuery(tables, () => { lecturas++; return read() }, x => { v = x; publicaciones++ }, 5)
  return { valor: () => v, lecturas: () => lecturas, publicaciones: () => publicaciones, cerrar }
}
/** Espera a que la pantalla muestre `esperado` (o devuelve lo último que mostró). */
async function muestra<T>(p: Pantalla<T>, esperado: T, ms = 1500): Promise<T | undefined> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (JSON.stringify(p.valor()) === JSON.stringify(esperado)) return p.valor()
    await sleep(5)
  }
  return p.valor()
}
/** Espera a que no queden lecturas en vuelo (sin escrituras nuevas). */
const quieto = () => sleep(60)

const subscriptores = () => (Dexie.on as unknown as { storagemutated: { subscribers: unknown[] } }).storagemutated.subscribers.length

// Lo que pinta cada pantalla del Supervisor (y las otras dos de la ronda).
const tarjeta = (routeId = R1) => () => getRouteAvailableCapital(routeId)                    // CollectorSelectRoutePage
const guardaVenta = (routeId = R1) => () => getRouteBase(routeId)                              // useCapitalGuard / useRouteCapital
const miEfectivo = (u: User) => async () => {                                                 // CollectorCashClosePage
  const c = await previewCashSettlement({ actor: u, tenantId: T, routeId: R1, userId: u.id })
  return { esperado: c.esperado, baseRecibida: c.baseRecibida, baseDevuelta: c.baseDevuelta }
}
const cuadrar = async () => {                                                                 // RouteCashReconciliationCard
  const r = await computeRouteBaseBreakdown({ tenantId: T, routeId: R1 })
  return { base: r.base, sinAsignar: r.sinAsignar, enTrabajadores: r.enTrabajadores }
}
const resumen = (routeId = R1) => async () => (await getRouteFinancialSummary(routeId)).baseActual  // RoutesPage / Socio / Mi efectivo (bloque ruta)

// ============================================================
// Cableado de las pantallas (estático)
// ============================================================
const PAGES = {
  tarjeta: 'src/pages/collector/CollectorSelectRoutePage.tsx',
  miEfectivo: 'src/pages/collector/CollectorCashClosePage.tsx',
  panel: 'src/components/settlement/WorkerCashSettlementPanel.tsx',
  conciliacion: 'src/components/settlement/RouteCashReconciliationCard.tsx',
  nuevaVenta: 'src/pages/collector/CollectorNewSalePage.tsx',
  nuevoCliente: 'src/pages/collector/CollectorNewClientPage.tsx',
  rutas: 'src/pages/admin/RoutesPage.tsx',
  socio: 'src/pages/socio/SocioDashboardPage.tsx',
  guard: 'src/hooks/useCapitalGuard.ts',
  capital: 'src/hooks/useRouteCapital.ts',
}

// ============================================================
// Casos
// ============================================================
await spec('SUP-BASE-001', 'tarjeta del Supervisor refleja un ingreso de capital sin recargar', async () => {
  await empresa()
  await capital(100_000)
  const p = pantalla(tarjeta())
  assert(await muestra(p, 100_000) === 100_000, 'la tarjeta no muestra la Base inicial')
  await capital(50_000)
  const v = await muestra(p, 150_000)
  metric('tarjeta Barreiro', `100.000 → ${v}`)
  p.cerrar()
  const s = src(PAGES.tarjeta)
  const cableada = /const revision = useDataRevision\(\)/.test(s) && /\[user, revision\]\)/.test(s)
  metric('CollectorSelectRoutePage depende de la revisión', cableada)
  assert(v === 150_000, `la tarjeta quedó en ${v}`)
  assert(cableada, 'CollectorSelectRoutePage no vuelve a cargar al cambiar los datos')
})

await spec('SUP-BASE-002', 'tarjeta refleja un retiro', async () => {
  await empresa()
  await capital(100_000)
  const p = pantalla(tarjeta())
  await muestra(p, 100_000)
  await retiro(30_000)
  const v = await muestra(p, 70_000)
  metric('tarjeta Barreiro', `100.000 → ${v}`)
  p.cerrar()
  assert(v === 70_000, `la tarjeta quedó en ${v}`)
})

await spec('SUP-BASE-003', 'tarjeta refleja una transferencia (origen y destino)', async () => {
  await empresa()
  await capital(100_000)
  const a = pantalla(tarjeta(R1))
  const b = pantalla(tarjeta(R2))
  await muestra(a, 100_000); await muestra(b, 0)
  await transferir(40_000)
  const va = await muestra(a, 60_000)
  const vb = await muestra(b, 40_000)
  metric('Barreiro (sale)', `100.000 → ${va}`)
  metric('Centro (entra)', `0 → ${vb}`)
  a.cerrar(); b.cerrar()
  assert(va === 60_000 && vb === 40_000, 'origen o destino quedó viejo')
})

await spec('SUP-BASE-004', 'Mi efectivo se actualiza tras una entrega de Base', async () => {
  await empresa()
  await capital(500_000)
  const mio = pantalla(miEfectivo(JUAN))
  const ruta = pantalla(cuadrar)
  await muestra(mio, { esperado: 0, baseRecibida: 0, baseDevuelta: 0 })
  await entregar(JUAN, 200_000)
  const v = await muestra(mio, { esperado: 200_000, baseRecibida: 200_000, baseDevuelta: 0 })
  const r = await muestra(ruta, { base: 500_000, sinAsignar: 300_000, enTrabajadores: 200_000 })
  metric('Mi efectivo de Juan', JSON.stringify(v))
  metric('ruta', JSON.stringify(r))
  mio.cerrar(); ruta.cerrar()
  assert(v?.baseRecibida === 200_000 && v.esperado === 200_000, 'Mi efectivo no refleja la Base recibida')
  assert(r?.base === 500_000, 'la custodia cambió la Base (no debe)')
  assert(/const revision = useDataRevision\(\)/.test(src(PAGES.miEfectivo)), 'Mi efectivo no depende de la revisión')
})

await spec('SUP-BASE-005', 'Mi efectivo se actualiza tras una devolución de Base', async () => {
  await empresa()
  await capital(500_000)
  await entregar(JUAN, 200_000)
  const mio = pantalla(miEfectivo(JUAN))
  await muestra(mio, { esperado: 200_000, baseRecibida: 200_000, baseDevuelta: 0 })
  await devolver(JUAN, 50_000)
  const v = await muestra(mio, { esperado: 150_000, baseRecibida: 200_000, baseDevuelta: 50_000 })
  metric('Mi efectivo de Juan', JSON.stringify(v))
  mio.cerrar()
  assert(v?.esperado === 150_000 && v.baseDevuelta === 50_000, 'Mi efectivo no refleja la devolución')
})

await spec('SUP-BASE-006', 'Cuadrar trabajadores se actualiza tras un cambio de custodia', async () => {
  await empresa()
  await capital(500_000)
  const ruta = pantalla(cuadrar)
  await muestra(ruta, { base: 500_000, sinAsignar: 500_000, enTrabajadores: 0 })
  await entregar(JUAN, 120_000)
  const v1 = await muestra(ruta, { base: 500_000, sinAsignar: 380_000, enTrabajadores: 120_000 })
  await devolver(JUAN, 20_000)
  const v2 = await muestra(ruta, { base: 500_000, sinAsignar: 400_000, enTrabajadores: 100_000 })
  metric('tras entrega 120.000', JSON.stringify(v1))
  metric('tras devolución 20.000', JSON.stringify(v2))
  ruta.cerrar()
  const panel = src(PAGES.panel)
  const conc = src(PAGES.conciliacion)
  const cableado = /\[user, tenantId, routeId, userId, revision\]/.test(panel) && /\[user, tenantId, routeId, revision, visible\]/.test(conc)
  metric('panel + conciliación dependen de la revisión', cableado)
  assert(v1?.sinAsignar === 380_000 && v2?.enTrabajadores === 100_000, 'la conciliación quedó vieja')
  assert(v1.base === 500_000 && v2.base === 500_000, 'la custodia cambió la Base')
  assert(cableado, 'Cuadrar trabajadores no se recalcula')
})

await spec('SUP-BASE-007', 'Nueva venta: abierta con X, la Base cambia a Y → la guarda y el envío usan Y', async () => {
  await empresa()
  await capital(100_000)
  const guarda = pantalla(guardaVenta(), ROUTE_BASE_TABLES)
  assert(await muestra(guarda, 100_000) === 100_000, 'la guarda no muestra X')
  await capital(60_000)
  const y = await muestra(guarda, 160_000)
  metric('guarda (useRouteCapital)', `100.000 → ${y}`)
  guarda.cerrar()
  const s = src(PAGES.nuevaVenta)
  const g = src(PAGES.guard)
  // El envío revalida con una lectura NUEVA antes de llamar al servicio.
  const envio = s.slice(s.indexOf('async function handleDirectSale'), s.indexOf('async function handleRequest'))
  const revalida = /await recheckCapital\(form\.valorVenta\)/.test(envio) && envio.indexOf('recheckCapital(') < envio.indexOf('createDirectSale(')
  const guardaViva = /useRouteCapital\(routeId\)/.test(g) && /await getRouteBase\(routeId\)/.test(g)
  metric('envío revalida con la Base vigente', revalida)
  metric('useCapitalGuard usa la Base viva', guardaViva)
  assert(y === 160_000, `la guarda quedó en ${y}`)
  assert(revalida && guardaViva, 'Nueva venta decide con la cifra pintada')
  // Y la venta de 150.000 (> X, ≤ Y) se acepta.
  const venta = await vender(150_000)
  metric('venta 150.000 con Base 160.000', venta.disbursementStatus)
})

await spec('SUP-BASE-008', 'Nuevo cliente + venta usa la Base actual (y no deja cliente huérfano)', async () => {
  await empresa()
  await capital(100_000)
  await retiro(70_000) // la pantalla se abrió con 100.000; ahora hay 30.000
  const c = nuevoCliente()
  const r = await rechazo(() => createDirectSale(inputs(c.id, 80_000), LAURA, { newClient: c }))
  const huerfano = await db.clients.get(c.id)
  metric('cliente + venta 80.000 con Base 30.000', r)
  metric('cliente creado igualmente', Boolean(huerfano))
  assert(/supera la Base de la ruta/.test(r), 'el servicio aceptó la venta con la Base vieja')
  assert(!huerfano, 'la transacción dejó el cliente sin su venta')
  await capital(100_000)
  const c2 = nuevoCliente()
  const ok = await createDirectSale(inputs(c2.id, 80_000), LAURA, { newClient: c2 })
  metric('cliente + venta 80.000 con Base 130.000', ok.disbursementStatus)
  const s = src(PAGES.nuevoCliente)
  const guardar = s.slice(s.indexOf('async function handleSave'))
  const revalida = /await recheckCapital\(saleForm\.valorVenta\)/.test(guardar) && guardar.indexOf('recheckCapital(') < guardar.indexOf('createDirectSale(')
  metric('Nuevo cliente revalida al guardar', revalida)
  assert(revalida, 'Nuevo cliente decide con la cifra pintada')
})

await spec('SUP-BASE-009', 'cambio de ruta A → B → A: cada valor es el de su ruta', async () => {
  await empresa()
  await capital(100_000, R1)
  await capital(40_000, R2)
  const vistos: number[] = []
  for (const r of [R1, R2, R1]) {
    const p = pantalla(guardaVenta(r), ROUTE_BASE_TABLES)
    await muestra(p, r === R1 ? 100_000 : 40_000)
    vistos.push(p.valor() as number)
    p.cerrar()
  }
  metric('A → B → A', vistos.join(' → '))
  // El hook guarda el valor JUNTO a su ruta y solo lo entrega si coincide.
  const h = src(PAGES.capital)
  const asociado = /state\?\.routeId === routeId \? state\.value : null/.test(h)
  metric('useRouteCapital asocia el valor a su ruta', asociado)
  assert(JSON.stringify(vistos) === JSON.stringify([100_000, 40_000, 100_000]), 'se mezclaron rutas')
  assert(asociado, 'useRouteCapital podría devolver la Base de la ruta anterior')
})

await spec('SUP-BASE-010', 'respuesta asíncrona tardía no pisa la actual', async () => {
  await empresa()
  await capital(100_000)
  // Lecturas controladas: la PRIMERA tarda; la segunda (tras una escritura) llega antes.
  const pendientes: Array<(v: string) => void> = []
  let n = 0
  const publicado: string[] = []
  const cerrar = watchQuery(ROUTE_BASE_TABLES, () => {
    const i = ++n
    return new Promise<string>(res => { pendientes[i] = res })
  }, v => publicado.push(v), 5)
  await capital(1)                    // dispara la 2.ª lectura
  await sleep(40)
  pendientes[2]?.('B (nueva)')
  await sleep(5)
  pendientes[1]?.('A (tardía)')       // termina después: debe descartarse
  await sleep(5)
  cerrar()
  // Tras desmontar: nada se publica.
  const tras: string[] = []
  const cerrar2 = watchQuery(ROUTE_BASE_TABLES, () => new Promise<string>(res => setTimeout(() => res('tarde'), 20)), v => tras.push(v), 5)
  cerrar2()
  await sleep(40)
  metric('publicado', publicado.join(', '))
  metric('publicado tras desmontar', tras.length)
  assert(JSON.stringify(publicado) === JSON.stringify(['B (nueva)']), 'una respuesta tardía pisó a la actual')
  assert(tras.length === 0, 'se publicó después de desmontar')
  // Las pantallas con useDataRevision descartan por el mismo principio.
  const guardas = [
    [PAGES.tarjeta, /if \(!vigente\(\)\) return/],
    [PAGES.miEfectivo, /if \(!vigente\(\)\) return/],
    [PAGES.rutas, /if \(seq !== loadSeq\.current\) return/],
    [PAGES.socio, /if \(!alive\) return/],
  ] as const
  for (const [p, re] of guardas) assert(re.test(src(p)), `${p} no descarta respuestas superadas`)
  metric('pantallas con descarte de respuestas superadas', guardas.length)
})

await spec('SUP-BASE-011', 'anular capital → el Supervisor ve la Base reducida', async () => {
  await empresa()
  await capital(100_000)
  const mov = await capital(50_000)
  const p = pantalla(tarjeta())
  await muestra(p, 150_000)
  await reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: mov.id, ...MOTIVO })
  const v = await muestra(p, 100_000)
  metric('tarjeta', `150.000 → ${v}`)
  p.cerrar()
  assert(v === 100_000, `quedó en ${v}`)
})

await spec('SUP-BASE-012', 'anular retiro → el Supervisor ve la Base restaurada', async () => {
  await empresa()
  await capital(100_000)
  const w = await retiro(40_000)
  const p = pantalla(tarjeta())
  await muestra(p, 60_000)
  await reverseWithdrawal({ actor: ADMIN, tenantId: T, movementId: w.id, ...MOTIVO })
  const v = await muestra(p, 100_000)
  metric('tarjeta', `60.000 → ${v}`)
  p.cerrar()
  assert(v === 100_000, `quedó en ${v}`)
})

await spec('SUP-BASE-013', 'anular transferencia → ambas rutas actualizadas', async () => {
  await empresa()
  await capital(100_000)
  const { transfer } = await transferir(30_000)
  const a = pantalla(tarjeta(R1))
  const b = pantalla(tarjeta(R2))
  await muestra(a, 70_000); await muestra(b, 30_000)
  await reverseTransfer({ actor: ADMIN, tenantId: T, movementId: transfer.id, ...MOTIVO })
  const va = await muestra(a, 100_000)
  const vb = await muestra(b, 0)
  metric('Barreiro', `70.000 → ${va}`)
  metric('Centro', `30.000 → ${vb}`)
  a.cerrar(); b.cerrar()
  assert(va === 100_000 && vb === 0, 'alguna ruta quedó vieja')
})

await spec('SUP-BASE-014', 'RoutesPage reactiva', async () => {
  await empresa()
  await capital(100_000)
  const p = pantalla(resumen())
  await muestra(p, 100_000)
  await retiro(25_000)
  const v = await muestra(p, 75_000)
  metric('RoutesPage · Barreiro', `100.000 → ${v}`)
  p.cerrar()
  const s = src(PAGES.rutas)
  const cableada = /const revision = useDataRevision\(\)/.test(s) && /\[tenantId, revision\]\)/.test(s)
  metric('RoutesPage depende de la revisión', cableada)
  assert(v === 75_000 && cableada, 'RoutesPage no se actualiza')
})

await spec('SUP-BASE-015', 'SocioDashboardPage reactiva', async () => {
  await empresa()
  await capital(100_000)
  await capital(20_000, R2)
  const a = pantalla(resumen(R1))
  const b = pantalla(resumen(R2))
  await muestra(a, 100_000); await muestra(b, 20_000)
  await transferir(10_000, R2, R1)
  const va = await muestra(a, 110_000)
  const vb = await muestra(b, 10_000)
  metric('Socio · Barreiro / Centro', `${va} / ${vb}`)
  a.cerrar(); b.cerrar()
  const s = src(PAGES.socio)
  const cableada = /const revision = useDataRevision\(\)/.test(s) && /\[routes, revision\]\)/.test(s)
  metric('Socio depende de la revisión', cableada)
  assert(va === 110_000 && vb === 10_000 && cableada, 'el consolidado del Socio no se actualiza')
})

await spec('SUP-BASE-016', 'el servicio no acepta un crédito con Base vieja (100.000 → 20.000, venta 80.000)', async () => {
  await empresa()
  await capital(100_000)
  const capturada = await getRouteBase(R1) // lo que pintó la pantalla
  await retiro(80_000)                      // otra operación
  const antes = await db.sales.count()
  const r = await rechazo(() => vender(80_000))
  metric('Base capturada / vigente', `${capturada} / ${await getRouteBase(R1)}`)
  metric('venta 80.000', r)
  assert(/supera la Base de la ruta/.test(r), 'el servicio aceptó con la Base vieja')
  assert(await db.sales.count() === antes, 'quedó una venta escrita')
  // Concurrencia: la Base se lee DENTRO de la transacción de escritura.
  await empresa()
  await capital(100_000)
  const [x, y] = await Promise.all([rechazo(() => vender(80_000)), rechazo(() => vender(80_000))])
  const base = await getRouteBase(R1)
  metric('dos ventas simultáneas de 80.000 con Base 100.000', `${x === 'ACEPTADO' ? 'ACEPTADA' : 'RECHAZADA'} + ${y === 'ACEPTADO' ? 'ACEPTADA' : 'RECHAZADA'} → Base ${base}`)
  assert([x, y].filter(z => z === 'ACEPTADO').length === 1 && base === 20_000, 'dos ventas simultáneas superaron la Base')
  await empresa()
  await capital(100_000)
  const [v, w] = await Promise.all([rechazo(() => vender(80_000)), rechazo(() => retiro(80_000))])
  const base2 = await getRouteBase(R1)
  metric('venta 80.000 + retiro 80.000 simultáneos', `${v === 'ACEPTADO' ? 'venta OK' : 'venta rechazada'} · ${w === 'ACEPTADO' ? 'retiro OK' : 'retiro rechazado'} → Base ${base2}`)
  assert(base2 >= 0, 'la Base quedó negativa')
})

await spec('SUP-BASE-017', 'el servicio permite el crédito si la Base aumentó después de abrir la pantalla', async () => {
  await empresa()
  await capital(20_000)
  const capturada = await getRouteBase(R1)
  await capital(100_000)
  const venta = await vender(80_000)
  metric('Base capturada / vigente', `${capturada} / ${await getRouteBase(R1)}`)
  metric('venta 80.000', venta.disbursementStatus)
  assert(venta.disbursementStatus === 'desembolsado', 'no se creó la venta')
  assert(await getRouteBase(R1) === 40_000, 'la Base posterior no es 40.000')
})

await spec('SUP-BASE-018', 'múltiples actualizaciones consecutivas: estado final correcto, sin acumular suscripciones', async () => {
  await empresa()
  await capital(100_000)
  const base0 = subscriptores()
  const p = pantalla(guardaVenta(), ROUTE_BASE_TABLES)
  await muestra(p, 100_000)
  for (let i = 0; i < 10; i++) await capital(1_000)
  await retiro(5_000)
  const v = await muestra(p, 105_000)
  metric('final tras 11 escrituras', v)
  metric('lecturas', p.lecturas())
  p.cerrar()
  // Montar y desmontar muchas veces (navegación) no deja suscripciones colgadas.
  for (let i = 0; i < 50; i++) pantalla(guardaVenta(), ROUTE_BASE_TABLES).cerrar()
  await quieto()
  metric('suscripciones a storagemutated antes / después', `${base0} / ${subscriptores()}`)
  assert(v === 105_000, `estado final ${v}`)
  assert(subscriptores() === base0, 'quedaron suscripciones acumuladas')
})

await spec('SUP-BASE-019', 'sin bucles: un cambio produce una lectura; leer no dispara la señal', async () => {
  await empresa()
  await capital(100_000)
  let señales = 0
  const off = subscribeDataChanges(OPERATIONAL_TABLES, () => { señales++ })
  const p = pantalla(guardaVenta(), ROUTE_BASE_TABLES)
  await muestra(p, 100_000)
  await quieto()
  const l0 = p.lecturas()
  const s0 = señales
  await getRouteBase(R1)
  await getRouteFinancialSummary(R1)
  await getRouteCashReconciliation({ actor: LAURA, tenantId: T, routeId: R1 })
  await quieto()
  metric('señales por leer', señales - s0)
  await capital(5_000)
  await muestra(p, 105_000)
  await quieto()
  const porCambio = p.lecturas() - l0
  metric('lecturas por un cambio', porCambio)
  await sleep(100)
  metric('lecturas en reposo (100 ms)', p.lecturas() - l0 - porCambio)
  p.cerrar(); off()
  assert(señales === s0 + 1, `leer o escribir produjo ${señales - s0} señales (esperado 1, la escritura)`)
  assert(porCambio === 1, `un cambio produjo ${porCambio} lecturas`)
  assert(p.lecturas() - l0 === 1, 'hubo lecturas sin cambios (bucle)')
  // Ni polling ni recargas forzadas en las pantallas de la ronda.
  for (const f of Object.values(PAGES)) {
    const s = src(f)
    assert(!/setInterval\(|location\.reload\(/.test(s), `${f} usa polling o recarga forzada`)
  }
})

await spec('SUP-BASE-020', 'aislamiento: cambios en A no alteran la Base mostrada de B', async () => {
  await empresa()
  await capital(100_000, R1)
  await capital(40_000, R2)
  const a = pantalla(guardaVenta(R1), ROUTE_BASE_TABLES)
  const b = pantalla(guardaVenta(R2), ROUTE_BASE_TABLES)
  await muestra(a, 100_000); await muestra(b, 40_000)
  await capital(10_000, R1)
  await retiro(5_000, R1)
  await vender(30_000, R1)
  const va = await muestra(a, 75_000)
  await quieto()
  metric('A (Barreiro)', va)
  metric('B (Centro)', `${b.valor()} · motor ${await getRouteBase(R2)}`)
  a.cerrar(); b.cerrar()
  assert(va === 75_000, `A quedó en ${va}`)
  assert(b.valor() === 40_000 && await getRouteBase(R2) === 40_000, 'B cambió por operaciones de A')
})

// ============================================================
// Informe
// ============================================================
console.log('\n════════════════════════════════════════════════════════════════')
console.log('  RUTACASH · BASE DEL SUPERVISOR (punto 5) — REACTIVIDAD Y SERVICIO')
console.log('════════════════════════════════════════════════════════════════')
for (const r of results) {
  console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id}  ${r.desc}`)
  for (const m of r.metrics) console.log(`          · ${m}`)
  if (r.error) console.log(`          ✗ ${r.error}`)
}
const fallidos = results.filter(r => !r.passed).length
console.log(`\n  ${results.length - fallidos}/${results.length} casos OK`)
if (fallidos > 0) process.exit(1)
