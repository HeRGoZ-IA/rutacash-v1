// ============================================================
// RUTACASH — SUITE BASE DE RUTA UNIFICADA (DEXIE REAL)
// ------------------------------------------------------------
//   npm run test:routebase
//
// Ajuste del socio 2026-10-02, punto 4: una sola definición de "Base de la ruta"
// y una sola fuente (`getRouteBase`). Cada caso consulta la MISMA ruta desde los
// servicios que alimentan cada pantalla (Admin, Supervisor, Retiros, Dashboard,
// Oficina, Cuadres) y exige el mismo valor; lo que es otro concepto (Sin asignar,
// En manos de trabajadores, Base recibida del Cobrador) se comprueba aparte.
//
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import { sembrarResponsables } from './financial/capitalFixture'
import { today } from '../src/lib/formatters'
import {
  getRouteBase, getRouteAvailableCapital, getRoutesCurrentBalance, getRouteFinancialSummary, getRouteLedger, hasCapitalForSale,
} from '../src/services/cashboxEngine'
import {
  computeRouteBaseBreakdown, computeRouteCashReconciliation, getRouteCashReconciliation,
} from '../src/services/routeCashReconciliation'
import { getAdminDashboardData } from '../src/services/adminDashboardService'
import { getOfficeManagementSummary } from '../src/services/officeService'
import { previewCashSettlement } from '../src/services/cashSettlementService'
import { registerCapital, registerTransfer, registerWithdrawal } from '../src/services/routeFundsService'
import { assignBaseToWorker, returnBaseFromWorker } from '../src/services/cashCustodyService'
import { reverseCapitalMovement, reverseTransfer, reverseWithdrawal } from '../src/services/movementReversalService'
import { createDirectSale, type SaleInputs } from '../src/services/saleRequestService'
import { registerPayment } from '../src/services/paymentService'
import type { Sale, Transfer, User } from '../src/models/types'
import * as fs from 'node:fs'
import * as path from 'node:path'

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

// ============================================================
// Escenario: Barreiro (Oficina Leticia) y Centro (Oficina Río); empresa ajena
// ============================================================
const T = 't-adex'
const TB = 't-ajena'
const R1 = 'r-barreiro'
const R2 = 'r-centro'
const RB = 'r-ajena'
const OF1 = 'of-leticia'
const OF2 = 'of-rio'
const HOY = today()
const MANANA = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toLocaleDateString('en-CA') })()

const base = (id: string, nombre: string, rol: User['rol'], rutas: string[], tenantId = T): User => ({
  id, tenantId, nombre, email: `${id}@adex.co`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)

const ADMIN = base('u-admin', 'Andrés Admin', 'admin', [R1, R2])
const ADMIN_B1 = base('u-admin-b', 'Bea Admin Barreiro', 'admin', [R1])   // vistas de una sola ruta
const JUAN = base('u-juan', 'Juan Cobrador', 'cobrador', [R1])
const FABIO = base('u-fabio', 'Fabio Cobrador', 'cobrador', [R1])
const LAURA = base('u-laura', 'Laura Supervisora', 'supervisor', [R1])
const PEDRO = base('u-pedro', 'Pedro Cobrador', 'cobrador', [R2])
const SOCIO = base('u-socio', 'Hernán Socio', 'socio', [R1, R2])
const AJENO = base('u-ajeno', 'Ana Ajena', 'admin', [RB], TB)

async function empresa() {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.bulkAdd([
    { id: T, nombre: 'ADEX', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z' },
    { id: TB, nombre: 'Ajena', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z' },
  ] as never[])
  await db.offices.bulkAdd([
    { id: OF1, tenantId: T, nombre: 'Leticia', codigo: 'LET', status: 'activa', createdAt: '', updatedAt: '' },
    { id: OF2, tenantId: T, nombre: 'Río', codigo: 'RIO', status: 'activa', createdAt: '', updatedAt: '' },
    { id: 'of-b', tenantId: TB, nombre: 'B', codigo: 'B', status: 'activa', createdAt: '', updatedAt: '' },
  ] as never[])
  const ruta = (id: string, tenantId: string, officeId: string, nombre: string) =>
    ({ id, tenantId, officeId, nombre, codigo: id, status: 'activa', capitalInicial: 0, capitalActual: 0, tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 0, createdAt: '2026-09-01' })
  await db.routes.bulkAdd([ruta(R1, T, OF1, 'Barreiro'), ruta(R2, T, OF2, 'Centro'), ruta(RB, TB, 'of-b', 'Ajena')] as never[])
  await db.users.bulkAdd([ADMIN, ADMIN_B1, JUAN, FABIO, LAURA, PEDRO, SOCIO, AJENO])
  // v16: Andrés (primer Admin de ambas rutas) es su responsable de capital, con bolsa.
  await sembrarResponsables(db, T, { [R1]: ADMIN.id, [R2]: ADMIN.id })
  await sembrarResponsables(db, TB, { [RB]: AJENO.id })
}

/**
 * La Base de UNA ruta tal como la obtiene cada pantalla. `ADMIN_B1` solo tiene
 * Barreiro y Barreiro es la única ruta de su Oficina: Dashboard y Oficina suman
 * exactamente esa ruta.
 */
async function vistas(routeId = R1) {
  const unaRuta = routeId === R1
  const officeId = routeId === R1 ? OF1 : OF2
  const actor = unaRuta ? ADMIN_B1 : ADMIN
  const desglose = await computeRouteBaseBreakdown({ tenantId: T, routeId })
  const oficina = await getOfficeManagementSummary({ user: actor, tenantId: T, officeId })
  return {
    motor: await getRouteBase(routeId),
    'Admin (Capital/Rutas/Socio)': (await getRouteFinancialSummary(routeId)).baseActual,
    'Supervisor (tarjeta de ruta)': await getRouteAvailableCapital(routeId),
    'Supervisor (Mi efectivo)': (await getRouteFinancialSummary(routeId)).baseActual,
    Retiros: (await getRoutesCurrentBalance([routeId]))[routeId],
    'Dashboard Admin': unaRuta ? (await getAdminDashboardData({ user: ADMIN_B1, tenantId: T })).baseActualTotal : undefined,
    Oficina: oficina?.finance?.baseActual,
    'Cuadres (conciliación)': desglose.base,
    desglose,
  }
}

/** Todas las pantallas que dicen "Base" muestran el mismo número. */
async function unica(routeId = R1): Promise<number> {
  const v = await vistas(routeId)
  const { desglose, ...pantallas } = v
  const valores = Object.entries(pantallas).filter(([, x]) => x !== undefined) as [string, number][]
  const distintos = valores.filter(([, x]) => x !== v.motor)
  assert(distintos.length === 0, `Base distinta entre pantallas: ${valores.map(([k, x]) => `${k}=${x}`).join(', ')}`)
  assert(desglose.base === desglose.sinAsignar + desglose.enTrabajadores, `identidad rota: ${desglose.base} ≠ ${desglose.sinAsignar} + ${desglose.enTrabajadores}`)
  return v.motor
}

const desglose = (routeId = R1) => computeRouteBaseBreakdown({ tenantId: T, routeId })
const tripleta = async (routeId = R1) => { const d = await desglose(routeId); return { base: d.base, sinAsignar: d.sinAsignar, enTrabajadores: d.enTrabajadores } }
const signo = (n: number) => n > 0 ? 'sube' : n < 0 ? 'baja' : 'no cambia'
async function efecto(fn: () => Promise<unknown>, routeId = R1) {
  const a = await tripleta(routeId)
  await fn()
  const b = await tripleta(routeId)
  await unica(routeId)
  return { base: signo(b.base - a.base), sinAsignar: signo(b.sinAsignar - a.sinAsignar), enTrabajadores: signo(b.enTrabajadores - a.enTrabajadores), d: b }
}
const fila = (e: { base: string; sinAsignar: string; enTrabajadores: string }) => `Base ${e.base} · Sin asignar ${e.sinAsignar} · En manos ${e.enTrabajadores}`

const capital = (valor: number, routeId = R1) => registerCapital({ actor: ADMIN, tenantId: T, routeId, valor })
const entregar = (u: User, amount: number, routeId = R1) => assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId, recipientUserId: u.id, amount, motivo: 'Base' })
const devolver = (u: User, amount: number, routeId = R1) => returnBaseFromWorker({ actor: ADMIN, tenantId: T, routeId, fromUserId: u.id, amount, motivo: 'Devolución' })
let cliSeq = 0
async function venta(actor: User, valor: number, extra: Partial<SaleInputs> = {}): Promise<Sale> {
  const clientId = `cli-${++cliSeq}`
  await db.clients.add({ id: clientId, tenantId: T, routeId: extra.routeId ?? R1, nombre: clientId, documento: clientId, status: 'activo', createdAt: '' } as never)
  return createDirectSale({ tenantId: T, routeId: R1, clientId, createdByUserId: actor.id, valorVenta: valor, tasaInteres: 20, numeroCuotas: 10, frecuenciaPago: 'diaria', fechaInicio: HOY, paymentDays: [0, 1, 2, 3, 4, 5, 6], ...extra }, actor)
}
async function cobrar(u: User, sale: Sale, valor: number) {
  const r = await registerPayment({ saleId: sale.id, requestedAmount: valor, actor: u, fecha: HOY })
  if (!r.ok) throw new Error(`pago rechazado: ${r.code}`)
}
const aporteSocio = (valor: number, descripcion: string) =>
  registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'partner', id: SOCIO.id }, destino: { type: 'route', id: R1 }, valor, descripcion })

// ============================================================
// Casos
// ============================================================
await spec('BASE-001', 'ruta nueva con capital inicial: misma Base en todas las pantallas', async () => {
  await empresa()
  await capital(100_000)
  const v = await vistas()
  for (const [k, x] of Object.entries(v)) if (k !== 'desglose' && x !== undefined) metric(k, x)
  assert(await unica() === 100_000, 'la Base inicial no es 100.000')
})

await spec('BASE-002', 'ingreso de capital', async () => {
  await empresa()
  await capital(100_000)
  const e = await efecto(() => capital(50_000))
  metric('ingreso 50.000', fila(e))
  assert(e.d.base === 150_000 && e.base === 'sube' && e.sinAsignar === 'sube' && e.enTrabajadores === 'no cambia', 'el ingreso no se refleja igual')
})

await spec('BASE-003', 'retiro', async () => {
  await empresa()
  await capital(100_000)
  const e = await efecto(() => registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R1, valor: 30_000 }))
  metric('retiro 30.000', fila(e))
  assert(e.d.base === 70_000 && e.base === 'baja' && e.sinAsignar === 'baja' && e.enTrabajadores === 'no cambia', 'el retiro no se refleja igual')
})

await spec('BASE-004', 'transferencia Ruta→Ruta', async () => {
  await empresa()
  await capital(100_000)
  const antes2 = await unica(R2)
  const e = await efecto(() => registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'route', id: R1 }, destino: { type: 'route', id: R2 }, valor: 40_000 }))
  const despues2 = await unica(R2)
  metric('Barreiro (origen)', `${fila(e)} → ${e.d.base}`)
  metric('Centro (destino)', `${antes2} → ${despues2}`)
  assert(e.d.base === 60_000 && despues2 === 40_000, 'origen o destino inconsistente')
})

await spec('BASE-005', 'Socio→Ruta: la Base sube', async () => {
  await empresa()
  const e = await efecto(() => aporteSocio(80_000, 'aporte'))
  metric('aporte 80.000', fila(e))
  assert(e.d.base === 80_000 && e.base === 'sube' && e.sinAsignar === 'sube', 'el aporte del socio no sube la Base')
})

await spec('BASE-006', 'Ruta→Socio: la Base baja', async () => {
  await empresa()
  await capital(100_000)
  const e = await efecto(() => registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'route', id: R1 }, destino: { type: 'partner', id: SOCIO.id }, valor: 25_000 }))
  metric('salida 25.000', fila(e))
  assert(e.d.base === 75_000 && e.base === 'baja' && e.sinAsignar === 'baja', 'la salida al socio no baja la Base')
})

await spec('BASE-007', 'entregar Base a un trabajador: Base igual, se mueve de caja a manos', async () => {
  await empresa()
  await capital(100_000)
  const e = await efecto(() => entregar(FABIO, 40_000))
  const fabio = (await desglose()).porTrabajador.find(p => p.userId === FABIO.id)
  const ciclo = await previewCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: FABIO.id })
  metric('entrega 40.000 a Fabio', `${fila(e)} → Base ${e.d.base} = Sin asignar ${e.d.sinAsignar} + En manos ${e.d.enTrabajadores}`)
  metric('Fabio', `en manos ${fabio?.monto} · Base recibida (su pantalla) ${ciclo.baseRecibida}`)
  assert(e.d.base === 100_000 && e.d.sinAsignar === 60_000 && e.d.enTrabajadores === 40_000, 'la custodia cambió la Base')
  assert(e.base === 'no cambia' && e.sinAsignar === 'baja' && e.enTrabajadores === 'sube', 'semántica de entrega incorrecta')
  assert(fabio?.monto === 40_000 && ciclo.baseRecibida === 40_000, 'la Base recibida de Fabio no coincide con su parte')
})

await spec('BASE-008', 'devolución del trabajador: relación inversa', async () => {
  await empresa()
  await capital(100_000)
  await entregar(FABIO, 40_000)
  const e = await efecto(() => devolver(FABIO, 15_000))
  metric('devuelve 15.000', `${fila(e)} → ${e.d.sinAsignar} + ${e.d.enTrabajadores}`)
  assert(e.d.base === 100_000 && e.d.sinAsignar === 75_000 && e.d.enTrabajadores === 25_000, 'la devolución no es la inversa')
  assert(e.base === 'no cambia' && e.sinAsignar === 'sube' && e.enTrabajadores === 'baja', 'semántica de devolución incorrecta')
})

await spec('BASE-009', 'desembolso: la Base baja (el dinero pasa a cartera)', async () => {
  await empresa()
  await capital(500_000)
  await entregar(LAURA, 300_000)
  const admin = await efecto(() => venta(ADMIN, 100_000))
  const supervisora = await efecto(() => venta(LAURA, 200_000))
  metric('desembolso Admin 100.000', fila(admin))
  metric('desembolso Laura (desde su Base) 200.000', fila(supervisora))
  const f = await getRouteFinancialSummary(R1)
  metric('Base / Cartera / Total controlado', `${f.baseActual} / ${f.carteraEnCalle} / ${f.totalControlado}`)
  assert(admin.base === 'baja' && admin.sinAsignar === 'baja' && admin.enTrabajadores === 'no cambia', 'desembolso administrativo incorrecto')
  assert(supervisora.base === 'baja' && supervisora.sinAsignar === 'no cambia' && supervisora.enTrabajadores === 'baja', 'desembolso desde Base en mano incorrecto')
  assert(f.baseActual === 200_000 && f.carteraEnCalle === 360_000 && f.totalControlado === 560_000, 'la cartera entró en la Base')
  // Inicio FUTURO: el dinero sale hoy. Antes la Base de Admin no lo restaba hasta su fecha.
  const futura = await efecto(() => venta(ADMIN, 50_000, { fechaInicio: MANANA }))
  const libro = (await computeRouteCashReconciliation({ tenantId: T, routeId: R1 })).libro.saldo
  metric('desembolso con inicio mañana 50.000', `${fila(futura)} · Base ${await getRouteBase(R1)} · libro conciliación ${libro}`)
  assert(futura.base === 'baja' && await getRouteBase(R1) === 150_000 && libro === 150_000, 'el préstamo con inicio futuro no resta de la Base')
  assert(!(await hasCapitalForSale(R1, 150_001)) && await hasCapitalForSale(R1, 150_000), 'la guarda de venta no usa la misma Base')
})

await spec('BASE-010', 'cobro de cuota', async () => {
  await empresa()
  await capital(200_000)
  const s = await venta(ADMIN, 100_000)
  const juan = await efecto(() => cobrar(JUAN, s, 12_000))
  metric('Juan cobra 12.000', fila(juan))
  assert(juan.base === 'sube' && juan.sinAsignar === 'no cambia' && juan.enTrabajadores === 'sube', 'el cobro en campo no queda en manos de Juan')
  assert(juan.d.base === 112_000, 'Base tras el cobro incorrecta')
})

await spec('BASE-011', 'reversión de capital (Ronda 3)', async () => {
  await empresa()
  await capital(100_000)
  const mal = await capital(30_000)
  const e = await efecto(() => reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: mal.id, reason: 'duplicado' }))
  metric('anular 30.000', `${fila(e)} → ${e.d.base}`)
  assert(e.d.base === 100_000 && e.base === 'baja' && e.sinAsignar === 'baja', 'la reversión de capital no da el neto')
})

await spec('BASE-012', 'reversión de retiro', async () => {
  await empresa()
  await capital(100_000)
  const w = await registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R1, valor: 20_000 })
  const e = await efecto(() => reverseWithdrawal({ actor: ADMIN, tenantId: T, movementId: w.id, reason: 'error' }))
  metric('anular retiro 20.000', `${fila(e)} → ${e.d.base}`)
  assert(e.d.base === 100_000 && e.base === 'sube', 'la reversión del retiro no restaura la Base')
})

await spec('BASE-013', 'reversión de transferencia: ambas rutas', async () => {
  await empresa()
  await capital(100_000)
  const { transfer } = await registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'route', id: R1 }, destino: { type: 'route', id: R2 }, valor: 35_000 })
  const e = await efecto(() => reverseTransfer({ actor: ADMIN, tenantId: T, movementId: transfer.id, reason: 'ruta equivocada' }))
  const centro = await unica(R2)
  metric('Barreiro / Centro', `${e.d.base} / ${centro}`)
  assert(e.d.base === 100_000 && centro === 0 && e.base === 'sube', 'una de las rutas quedó mal')
})

await spec('BASE-014', 'caso Barreiro: +21.000 +21.500 −21.500 → 21.000 en todas las pantallas', async () => {
  await empresa()
  await aporteSocio(21_000, 'base para créditos')
  const { transfer } = await aporteSocio(21_500, 'base préstamos')
  const antes = await unica()
  await reverseTransfer({ actor: ADMIN, tenantId: T, movementId: transfer.id, reason: 'Valor duplicado' })
  const v = await vistas()
  for (const [k, x] of Object.entries(v)) if (k !== 'desglose' && x !== undefined) metric(k, x)
  metric('antes de anular', antes)
  assert(antes === 42_500 && await unica() === 21_000, 'la Base efectiva no es 21.000')
})

await spec('BASE-015', 'Route.capitalActual divergente no afecta a ninguna pantalla', async () => {
  await empresa()
  await capital(100_000)
  await db.routes.update(R1, { capitalActual: 987_654_321, capitalInicial: 555 })
  const b = await unica()
  metric('Base con capitalActual=987.654.321', b)
  assert(b === 100_000, 'alguna pantalla usa capitalActual')
  const lecturas: string[] = []
  const recorrer = (dir: string) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f)
      if (fs.statSync(p).isDirectory()) recorrer(p)
      else if (/\.tsx?$/.test(f)) fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((l, i) => {
        const codigo = l.replace(/\/\/.*$/, '').trim()
        if (/\.capitalActual\b/.test(codigo) && !codigo.startsWith('*')) lecturas.push(`${p}:${i + 1}`)
      })
    }
  }
  recorrer('src')
  metric('lecturas de .capitalActual en src', lecturas.length ? lecturas.join(', ') : 'ninguna')
  assert(lecturas.length === 0, 'hay lecturas de capitalActual')
})

await spec('BASE-016', 'varios trabajadores: Base = Sin asignar + Σ en manos', async () => {
  await empresa()
  await capital(300_000)
  await entregar(JUAN, 50_000)
  await entregar(FABIO, 70_000)
  await entregar(LAURA, 30_000)
  const s = await venta(LAURA, 20_000)
  await cobrar(JUAN, s, 5_000)
  const d = await desglose()
  const suma = d.porTrabajador.reduce((n, p) => n + p.monto, 0)
  metric('por trabajador', d.porTrabajador.map(p => `${p.nombre} ${p.monto}`).join(' · '))
  metric('Base / Sin asignar / En manos', `${d.base} / ${d.sinAsignar} / ${d.enTrabajadores}`)
  assert(d.base === 285_000 && d.enTrabajadores === suma && d.base === d.sinAsignar + d.enTrabajadores, 'la relación entre categorías no cuadra')
  assert(d.sinAsignar === 150_000 && suma === 135_000, 'reparto incorrecto')
  await unica()
})

await spec('BASE-017', 'varias rutas: sin contaminación', async () => {
  await empresa()
  await capital(100_000, R1)
  await capital(60_000, R2)
  await entregar(PEDRO, 10_000, R2)
  const centroAntes = await unica(R2)
  await capital(5_000, R1)
  await entregar(JUAN, 20_000)
  await registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R1, valor: 1_000 })
  const centroDespues = await unica(R2)
  metric('Barreiro / Centro', `${await unica(R1)} / ${centroDespues}`)
  assert(centroAntes === 60_000 && centroDespues === 60_000 && await getRouteBase(R1) === 104_000, 'una ruta afectó a la otra')
})

await spec('BASE-018', 'aislamiento por empresa', async () => {
  await empresa()
  await capital(100_000)
  await registerCapital({ actor: AJENO, tenantId: TB, routeId: RB, valor: 999_000 })
  const dash = await getAdminDashboardData({ user: ADMIN, tenantId: T })
  const ajenaDesdeA = await rechazo(() => getRouteCashReconciliation({ actor: ADMIN, tenantId: TB, routeId: RB }))
  const aDesdeAjena = await rechazo(() => getRouteCashReconciliation({ actor: AJENO, tenantId: T, routeId: R1 }))
  const oficinaAjena = await getOfficeManagementSummary({ user: ADMIN, tenantId: TB, officeId: 'of-b' })
  metric('Dashboard empresa A', dash.baseActualTotal)
  metric('Admin A → conciliación B', ajenaDesdeA)
  metric('Admin B → conciliación A', aDesdeAjena)
  metric('Admin A → Oficina de B', oficinaAjena?.finance ? oficinaAjena.finance.baseActual : 'sin datos')
  assert(dash.baseActualTotal === 100_000 && ajenaDesdeA !== 'ACEPTADO' && aDesdeAjena !== 'ACEPTADO', 'una empresa leyó la Base de otra')
  assert(!oficinaAjena?.finance, 'la Oficina ajena devolvió finanzas')
})

await spec('BASE-019', 'históricos sin campos nuevos', async () => {
  await empresa()
  // Datos como los dejaría producción antes de v15/Ronda 3: sin tipos de transferencia ni anulaciones.
  await db.capitalMovements.add({ id: 'cap-viejo', tenantId: T, routeId: R1, tipo: 'ingresoCapital', valor: 400_000, fecha: '2026-05-01', userId: ADMIN.id, createdAt: '2026-05-01T08:00:00.000Z' })
  await db.transfers.add({ id: 'tr-vieja', tenantId: T, routeOrigenId: R1, routeDestinoId: R2, valor: 50_000, fecha: '2026-05-02', userId: ADMIN.id, createdAt: '2026-05-02T08:00:00.000Z' } as Transfer)
  await db.withdrawals.add({ id: 'w-viejo', tenantId: T, routeId: R1, valor: 25_000, fecha: '2026-05-03', userId: ADMIN.id, createdAt: '2026-05-03T08:00:00.000Z' })
  await db.sales.add({ id: 'sale-vieja', tenantId: T, routeId: R1, clientId: 'c-v', createdByUserId: ADMIN.id, valorVenta: 100_000, tasaInteres: 20, valorInteres: 20_000, valorTotal: 120_000, saldo: 60_000, numeroCuotas: 10, valorCuota: 12_000, frecuenciaPago: 'diaria', fechaInicio: '2026-05-04', fechaFinalEstimada: '2026-05-20', status: 'activa', createdAt: '2026-05-04T08:00:00.000Z', updatedAt: '' } as unknown as Sale)
  await db.payments.add({ id: 'pay-viejo', tenantId: T, routeId: R1, saleId: 'sale-vieja', clientId: 'c-v', valor: 60_000, fecha: '2026-05-10', tipo: 'normal', createdAt: '2026-05-10T08:00:00.000Z', syncStatus: 'synced' } as never)
  const esperado = 400_000 - 50_000 - 25_000 - 100_000 + 60_000
  const b = await unica()
  metric('Base calculada / ecuación a mano', `${b} / ${esperado}`)
  assert(b === esperado && await unica(R2) === 50_000, 'los históricos no se calculan con la ecuación canónica')
})

await spec('BASE-020', 'sin fórmulas de Base duplicadas ni etiquetas ambiguas en la UI', async () => {
  const archivos: string[] = []
  const recorrer = (dir: string) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f)
      if (fs.statSync(p).isDirectory()) recorrer(p)
      else if (/\.tsx$/.test(f)) archivos.push(p)
    }
  }
  recorrer('src/pages'); recorrer('src/components')
  const problemas: string[] = []
  for (const p of archivos) {
    const src = fs.readFileSync(p, 'utf8')
    const nombre = p.replace(/\\/g, '/')
    // 1. El libro por periodo solo lo usa la vista de Caja (detalle con fechas).
    if (/getCashboxSummary/.test(src) && !nombre.endsWith('admin/CashboxPage.tsx')) problemas.push(`${nombre}: usa getCashboxSummary`)
    // 2. Etiquetas retiradas: un concepto, un nombre.
    for (const etiqueta of ['Base actual', 'Libro de la ruta', 'capital disponible', 'Capital disponible', 'SALDO ACTUAL', '>Base<', 'Disponible en rutas']) {
      if (src.includes(etiqueta)) problemas.push(`${nombre}: etiqueta "${etiqueta}"`)
    }
    // 3. Quien rotula "Base de la ruta"/"Base total" la toma de la fuente canónica.
    if (/Base de la ruta|Base total/.test(src)) {
      const fuente = /getRouteBase|getRouteLedger|getRouteFinancialSummary|getRouteAvailableCapital|getAdminDashboardData|getOfficeManagementSummary|getRouteCashReconciliation|useRouteCapital|useCapitalGuard|baseActual|routeBaseBreakdown/.test(src)
      if (!fuente) problemas.push(`${nombre}: rotula Base sin la fuente canónica`)
    }
    // 4. La cartera de la ruta tampoco se recalcula en pantalla (`carteraEnCalleOf`).
    //    (Sumar la deuda de UN cliente es otro concepto y no se marca.)
    if (/cartera\w*\s*[:=]\s*\w+\.reduce\(/i.test(src)) problemas.push(`${nombre}: calcula la cartera localmente`)
  }
  metric('archivos .tsx revisados', archivos.length)
  metric('problemas', problemas.length ? problemas.join(' | ') : 'ninguno')
  assert(problemas.length === 0, 'la UI vuelve a calcular o rotular la Base por su cuenta')
  const motor = fs.readFileSync('src/services/cashboxEngine.ts', 'utf8')
  assert(/export async function getRouteBase/.test(motor) && /return getRouteBase\(routeId\)/.test(motor), 'no hay una entrada canónica única')
})

// ------------------------------------------------------------
// PRUEBA CRUZADA ENTRE MÓDULOS (sección 19)
// ------------------------------------------------------------
await spec('BASE-CROSS', 'Barreiro: ingreso, entrega, crédito, pago, devolución, transferencia y reversión', async () => {
  await empresa()
  const paso = async (nombre: string, fn: () => Promise<unknown>) => {
    await fn()
    const v = await vistas()
    const b = await unica()
    const juan = await previewCashSettlement({ actor: JUAN, tenantId: T, routeId: R1, userId: JUAN.id })
    const enManosJuan = v.desglose.porTrabajador.find(p => p.userId === JUAN.id)?.monto ?? 0
    metric(nombre, `Base ${b} (Cobrador no la ve · Supervisor ${v['Supervisor (tarjeta de ruta)']} · Admin ${v['Admin (Capital/Rutas/Socio)']} · Oficina ${v.Oficina} · Cuadres ${v['Cuadres (conciliación)']}) · Sin asignar ${v.desglose.sinAsignar} · Juan: Base recibida ${juan.baseRecibida}, a entregar ${juan.esperado} = en manos ${enManosJuan}`)
    assert(juan.esperado === enManosJuan, 'la pantalla del Cobrador y los cuadres no coinciden')
    return b
  }
  await paso('1 ingreso 200.000', () => capital(200_000))
  await paso('2 entrega 80.000 a Juan', () => entregar(JUAN, 80_000))
  let s!: Sale
  await paso('3 crédito 50.000 (Laura, sin Base: queda en negativo)', async () => { s = await venta(LAURA, 50_000) })
  await paso('4 Juan cobra 6.000', () => cobrar(JUAN, s, 6_000))
  await paso('5 Juan devuelve 30.000', () => devolver(JUAN, 30_000))
  let t!: Transfer
  await paso('6 transferencia 40.000 a Centro', async () => { t = (await registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'route', id: R1 }, destino: { type: 'route', id: R2 }, valor: 40_000 })).transfer })
  const fin = await paso('7 anular la transferencia', () => reverseTransfer({ actor: ADMIN, tenantId: T, movementId: t.id, reason: 'error' }))
  assert(fin === 200_000 - 50_000 + 6_000, 'Base final incorrecta')
  assert(await unica(R2) === 0, 'Centro quedó con saldo')
})

// ============================================================
// Informe
// ============================================================
const line = (ch = '─') => ch.repeat(96)
console.log('')
console.log(line('═'))
console.log('  RUTACASH — SUITE BASE DE RUTA UNIFICADA (Dexie real)')
console.log(line('═'))
for (const r of results) {
  console.log(`[${r.passed ? ' PASS ' : ' FAIL '}] ${r.id.padEnd(11)} ${r.desc}`)
  for (const m of r.metrics) console.log(`           · ${m}`)
  if (r.error) console.log(`           ↳ ERROR: ${r.error}`)
}
const fallidos = results.filter(r => !r.passed)
console.log('')
console.log(line('═'))
console.log(`  TOTAL: ${results.length} casos   ${results.length - fallidos.length} PASS   ${fallidos.length} FAIL`)
console.log(line('═'))
console.log(fallidos.length ? 'SUITE BASE DE RUTA: FALLÓ' : 'SUITE BASE DE RUTA: TODOS LOS CASOS PASAN')
process.exit(fallidos.length === 0 ? 0 : 1)
