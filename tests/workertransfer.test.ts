// ============================================================
// RUTACASH — SUITE TRASPASO INTERNO ENTRE TRABAJADORES (DEXIE REAL)
// ------------------------------------------------------------
//   npm run test:workertransfer
//
// Ajuste del socio 2026-10-02, punto 6. El socio intentó "Ruta Barreiro → Ruta
// Barreiro" en Transferencias para pasar efectivo de Fabio a Carlos. Eso NO es una
// Transferencia (entre rutas / socios): es un traspaso de CUSTODIA dentro de la
// misma ruta (`transferBaseBetweenWorkers`, una fila PERSON_TO_PERSON).
//
// Escenario base (el del socio): Barreiro con Base 300.000; Fabio 150.000 y Carlos
// 50.000 en manos; 100.000 sin asignar.
//
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import { sembrarResponsables } from './financial/capitalFixture'
import { today } from '../src/lib/formatters'
import { OPERATIONAL_TABLES, subscribeDataChanges, watchQuery } from '../src/lib/dataRevision'
import { getRouteBase } from '../src/services/cashboxEngine'
import { computeRouteBaseBreakdown } from '../src/services/routeCashReconciliation'
import { personalCashPosition, closeCashSettlement } from '../src/services/cashSettlementService'
import { registerCapital } from '../src/services/routeFundsService'
import {
  assignBaseToWorker, getTransferableCash, listCustodyMovements, transferBaseBetweenWorkers, transferableCash,
} from '../src/services/cashCustodyService'
import {
  approveSaleRequest, confirmDisbursement, createDirectSale, createSaleRequest, type SaleInputs,
} from '../src/services/saleRequestService'
import { registerPayment } from '../src/services/paymentService'
import type { Sale, User } from '../src/models/types'
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

const persona = (id: string, nombre: string, rol: User['rol'], rutas: string[], tenantId = T, status: User['status'] = 'activo'): User => ({
  id, tenantId, nombre, email: `${id}@adex.co`, password: '1234', rol, status,
  authorizedRouteIds: rutas, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)

const SUPER = persona('u-super', 'Sara SuperAdmin', 'superadmin', [])
const ADMIN = persona('u-admin', 'Andrés Admin', 'admin', [R1, R2])
const LAURA = persona('u-laura', 'Laura Supervisora', 'supervisor', [R1])
const OSCAR = persona('u-oscar', 'Óscar Supervisor Centro', 'supervisor', [R2])
const SECRE = persona('u-secre', 'Sergio Secretario', 'secretario', [R1])
const SOCIO = persona('u-socio', 'Sofía Socia', 'socio', [R1, R2])
const FABIO = persona('u-fabio', 'Fabio', 'cobrador', [R1])
const CARLOS = persona('u-carlos', 'Carlos', 'cobrador', [R1])
const ANDRES = persona('u-andres', 'Andrés Cobrador', 'cobrador', [R1])
const PEDRO = persona('u-pedro', 'Pedro Centro', 'cobrador', [R2])
const MIXTO = persona('u-mixto', 'Mario Dos Rutas', 'cobrador', [R1, R2])
const INACTIVO = persona('u-inactivo', 'Iván Inactivo', 'cobrador', [R1], T, 'inactivo')
const AJENO_ADMIN = persona('u-ajeno-admin', 'Ana Ajena', 'admin', [RB], TB)
const AJENO = persona('u-ajeno', 'Alberto Ajeno', 'cobrador', [RB], TB)

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
  await db.users.bulkAdd([SUPER, ADMIN, LAURA, OSCAR, SECRE, SOCIO, FABIO, CARLOS, ANDRES, PEDRO, MIXTO, INACTIVO, AJENO_ADMIN, AJENO])
  // v16: Andrés (primer Admin de ambas rutas) es su responsable de capital, con bolsa.
  await sembrarResponsables(db, T, { [R1]: ADMIN.id, [R2]: ADMIN.id })
  await sembrarResponsables(db, TB, { [RB]: AJENO_ADMIN.id })
}

const capital = (valor: number, routeId = R1, actor: User = ADMIN, tenantId = T) => registerCapital({ actor, tenantId, routeId, valor })
const entregar = (u: User, amount: number, routeId = R1) =>
  assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId, recipientUserId: u.id, amount, motivo: 'Base del día' })
const traspasar = (from: User, to: User, amount: unknown, extra: { actor?: User; routeId?: string; tenantId?: string; motivo?: string } = {}) =>
  transferBaseBetweenWorkers({
    actor: extra.actor ?? ADMIN, tenantId: extra.tenantId ?? T, routeId: extra.routeId ?? R1,
    fromUserId: from.id, toUserId: to.id, amount: amount as number, motivo: extra.motivo ?? 'Traspaso entre trabajadores',
  })
const posicion = async (u: User, routeId = R1) =>
  (await personalCashPosition({ tenantId: T, routeId, userId: u.id, hasta: new Date().toISOString() })).esperado
const disponible = (u: User, routeId = R1) => getTransferableCash({ tenantId: T, routeId, userId: u.id })
const desglose = (routeId = R1) => computeRouteBaseBreakdown({ tenantId: T, routeId })
const foto = async (routeId = R1) => {
  const d = await desglose(routeId)
  return {
    base: d.base, sinAsignar: d.sinAsignar, enTrabajadores: d.enTrabajadores, disponible: d.disponible,
    socios: await db.partnerCashMovements.count(), transfers: await db.transfers.count(),
    capital: await db.capitalMovements.count(), retiros: await db.withdrawals.count(),
  }
}

/** Escenario del socio: Base 300.000; Fabio 150.000, Carlos 50.000; 100.000 sin asignar. */
async function escenario() {
  await empresa()
  await capital(300_000)
  await entregar(FABIO, 150_000)
  await entregar(CARLOS, 50_000)
}

let cliSeq = 0
async function cliente(routeId = R1) {
  const id = `cli-${++cliSeq}`
  await db.clients.add({ id, tenantId: T, routeId, nombre: id, documento: id, telefonoPrincipal: '300', direccionPrincipal: 'x', direccionSecundaria: 'y', status: 'activo', createdAt: '', updatedAt: '' } as never)
  return id
}
const entrada = (clientId: string, actor: User, valor: number, routeId = R1): SaleInputs => ({
  tenantId: T, routeId, clientId, createdByUserId: actor.id, valorVenta: valor, tasaInteres: 20, numeroCuotas: 10,
  frecuenciaPago: 'diaria', fechaInicio: today(), paymentDays: [0, 1, 2, 3, 4, 5, 6],
})
async function cobra(u: User, sale: Sale, valor: number) {
  const r = await registerPayment({ saleId: sale.id, requestedAmount: valor, actor: u, fecha: today() })
  if (!r.ok) throw new Error(`pago rechazado: ${r.code}`)
}
/** `u` desembolsa `valor` de su efectivo: solicita, Laura aprueba y `u` entrega el dinero. */
async function desembolsa(u: User, valor: number) {
  const req = await createSaleRequest(entrada(await cliente(), u, valor), u)
  const sale = await approveSaleRequest(req.id, LAURA)
  await confirmDisbursement(sale.id, u)
}

const PANEL = 'src/components/settlement/WorkerCashSettlementPanel.tsx'

// ============================================================
// Casos
// ============================================================
await spec('WORKER-XFER-001', 'misma ruta, Fabio → Carlos 40.000: éxito', async () => {
  await escenario()
  const mov = await traspasar(FABIO, CARLOS, 40_000)
  metric('movimiento', `${mov.tipo} · ${mov.fromUserId} → ${mov.toUserId} · ${mov.amount} · ruta ${mov.routeId}`)
  assert(mov.tipo === 'PERSON_TO_PERSON' && mov.routeId === R1 && mov.amount === 40_000, 'movimiento incorrecto')
})

await spec('WORKER-XFER-002', 'Base total antes / después: idéntica', async () => {
  await escenario()
  const antes = await getRouteBase(R1)
  await traspasar(FABIO, CARLOS, 40_000)
  const despues = await getRouteBase(R1)
  metric('Base', `${antes} → ${despues}`)
  assert(antes === 300_000 && despues === 300_000, 'la Base cambió')
})

await spec('WORKER-XFER-003', 'Sin asignar (y Disponible para retiro) antes / después: idénticos', async () => {
  await escenario()
  const a = await desglose()
  await traspasar(FABIO, CARLOS, 40_000)
  const b = await desglose()
  metric('Sin asignar', `${a.sinAsignar} → ${b.sinAsignar}`)
  metric('Disponible para retiro', `${a.disponible} → ${b.disponible}`)
  assert(a.sinAsignar === 100_000 && b.sinAsignar === 100_000 && a.disponible === b.disponible, 'cambió la caja sin asignar')
})

await spec('WORKER-XFER-004', 'En manos total: idéntico (identidad Base = Sin asignar + En manos)', async () => {
  await escenario()
  const a = await desglose()
  await traspasar(FABIO, CARLOS, 40_000)
  const b = await desglose()
  metric('En manos', `${a.enTrabajadores} → ${b.enTrabajadores}`)
  metric('identidad', `${b.base} = ${b.sinAsignar} + ${b.enTrabajadores}`)
  assert(a.enTrabajadores === 200_000 && b.enTrabajadores === 200_000, 'cambió el total en manos')
  assert(b.base === b.sinAsignar + b.enTrabajadores, 'identidad rota')
})

await spec('WORKER-XFER-005', 'distribución individual: Fabio −40.000, Carlos +40.000', async () => {
  await escenario()
  const f0 = await posicion(FABIO); const c0 = await posicion(CARLOS)
  await traspasar(FABIO, CARLOS, 40_000)
  const f1 = await posicion(FABIO); const c1 = await posicion(CARLOS)
  const porTrabajador = (await desglose()).porTrabajador.map(p => `${p.nombre} ${p.monto}`).join(' · ')
  metric('Fabio', `${f0} → ${f1}`); metric('Carlos', `${c0} → ${c1}`); metric('porTrabajador', porTrabajador)
  assert(f1 - f0 === -40_000 && c1 - c0 === 40_000, 'la redistribución no es exacta')
})

await spec('WORKER-XFER-006', 'Caja socios, capital, retiros y transferencias: sin movimientos nuevos', async () => {
  await escenario()
  const a = await foto()
  await traspasar(FABIO, CARLOS, 40_000)
  const b = await foto()
  metric('antes', JSON.stringify(a)); metric('después', JSON.stringify(b))
  assert(a.socios === b.socios && a.capital === b.capital && a.retiros === b.retiros && a.transfers === b.transfers, 'se tocaron fondos fuera de la custodia')
})

await spec('WORKER-XFER-007', 'mismo trabajador como origen y destino: rechazo', async () => {
  await escenario()
  const r = await rechazo(() => traspasar(FABIO, FABIO, 10_000))
  metric('Fabio → Fabio', r)
  assert(/personas distintas/.test(r), 'se aceptó')
})

await spec('WORKER-XFER-008', 'trabajadores de rutas diferentes: rechazo', async () => {
  await escenario()
  await capital(100_000, R2)
  await entregar(PEDRO, 80_000, R2)
  const a = await rechazo(() => traspasar(FABIO, PEDRO, 10_000))            // destino de otra ruta
  const b = await rechazo(() => traspasar(PEDRO, CARLOS, 10_000))            // origen de otra ruta
  const c = await rechazo(() => traspasar(PEDRO, CARLOS, 10_000, { routeId: R2 }))  // ruta de Pedro, Carlos no está en ella
  metric('Fabio(Barreiro) → Pedro(Centro)', a)
  metric('Pedro(Centro) → Carlos, ruta Barreiro', b)
  metric('Pedro → Carlos, ruta Centro', c)
  assert([a, b, c].every(x => x !== 'ACEPTADO'), 'se mezclaron rutas')
  assert(/no está asignada a esta ruta/.test(a) && /no está asignada a esta ruta/.test(b) && /no está asignada a esta ruta/.test(c), 'mensaje inesperado')
})

await spec('WORKER-XFER-009', 'empresas diferentes: rechazo', async () => {
  await escenario()
  const a = await rechazo(() => traspasar(FABIO, AJENO, 10_000))
  const b = await rechazo(() => traspasar(AJENO, CARLOS, 10_000))
  const c = await rechazo(() => traspasar(AJENO, AJENO_ADMIN, 10_000, { actor: ADMIN, tenantId: TB, routeId: RB }))
  metric('→ trabajador ajeno', a); metric('trabajador ajeno →', b); metric('Admin de ADEX en la ruta ajena', c)
  assert([a, b, c].every(x => x !== 'ACEPTADO'), 'se cruzó el aislamiento por empresa')
})

await spec('WORKER-XFER-010', 'saldo insuficiente: rechazo y sin escritura parcial', async () => {
  await empresa()
  await capital(300_000)
  await entregar(FABIO, 30_000)
  const movs0 = await db.cashCustodyMovements.count()
  const logs0 = await db.auditLogs.count()
  const r = await rechazo(() => traspasar(FABIO, CARLOS, 40_000))
  metric('Fabio tiene 30.000, intenta 40.000', r)
  metric('movimientos / auditoría nuevos', `${(await db.cashCustodyMovements.count()) - movs0} / ${(await db.auditLogs.count()) - logs0}`)
  assert(/supera el efectivo en manos de Fabio \(30000\)/.test(r), 'se aceptó o mensaje inesperado')
  assert(await db.cashCustodyMovements.count() === movs0 && await db.auditLogs.count() === logs0, 'quedó escritura parcial')
  assert(await posicion(FABIO) === 30_000 && await posicion(CARLOS) === 0, 'cambiaron las posiciones')
})

await spec('WORKER-XFER-011', 'valor exactamente igual al disponible: permitido; el origen queda en 0', async () => {
  await empresa()
  await capital(300_000)
  await entregar(FABIO, 40_000)
  await traspasar(FABIO, CARLOS, 40_000)
  metric('Fabio / Carlos', `${await posicion(FABIO)} / ${await posicion(CARLOS)}`)
  assert(await posicion(FABIO) === 0 && await posicion(CARLOS) === 40_000, 'no quedó en 0')
  const r = await rechazo(() => traspasar(FABIO, CARLOS, 1))
  metric('1 peso más', r)
  assert(r !== 'ACEPTADO', 'se pudo dejar en negativo')
})

await spec('WORKER-XFER-012', 'valor 0 / negativo / NaN / vacío / decimal: rechazo', async () => {
  await escenario()
  const casos: [string, unknown][] = [['0', 0], ['-5.000', -5_000], ['NaN', NaN], ['vacío', ''], ['undefined', undefined], ['decimal', 10.5], ['Infinity', Infinity]]
  for (const [n, v] of casos) {
    const r = await rechazo(() => traspasar(FABIO, CARLOS, v))
    metric(n, r)
    assert(r !== 'ACEPTADO', `se aceptó ${n}`)
  }
  assert(await db.cashCustodyMovements.where('tipo').equals('PERSON_TO_PERSON').count() === 0, 'quedó algún traspaso')
})

await spec('WORKER-XFER-013', 'permisos: solo quien tiene cashCustody.manage sobre la ruta', async () => {
  await escenario()
  const quien: [string, User, boolean][] = [
    ['Super Admin', SUPER, true], ['Admin', ADMIN, true], ['Supervisor de la ruta', LAURA, true],
    ['Supervisor de otra ruta', OSCAR, false], ['Secretario', SECRE, false], ['Socio', SOCIO, false],
    ['Cobrador (tercero)', ANDRES, false], ['Fabio (reduce su propia responsabilidad)', FABIO, false],
  ]
  for (const [n, actor, puede] of quien) {
    const r = await rechazo(() => traspasar(FABIO, CARLOS, 1_000, { actor }))
    metric(n, r === 'ACEPTADO' ? 'ACEPTADO' : `rechazado (${r})`)
    assert((r === 'ACEPTADO') === puede, `${n}: resultado inesperado`)
  }
})

await spec('WORKER-XFER-014', 'atomicidad: un fallo al escribir no deja nada (ni movimiento ni auditoría)', async () => {
  await escenario()
  const movs0 = await db.cashCustodyMovements.count()
  const logs0 = await db.auditLogs.count()
  const fallo = function () { throw new Error('fallo forzado al escribir') }
  db.cashCustodyMovements.hook('creating', fallo)
  const r = await rechazo(() => traspasar(FABIO, CARLOS, 40_000))
  db.cashCustodyMovements.hook('creating').unsubscribe(fallo)
  metric('traspaso con fallo forzado', r)
  metric('movimientos / auditoría nuevos', `${(await db.cashCustodyMovements.count()) - movs0} / ${(await db.auditLogs.count()) - logs0}`)
  assert(r !== 'ACEPTADO', 'no falló')
  assert(await db.cashCustodyMovements.count() === movs0 && await db.auditLogs.count() === logs0, 'quedó algo escrito')
  assert(await posicion(FABIO) === 150_000 && await posicion(CARLOS) === 50_000, 'cambió una posición')
  // Modelo: una sola fila lleva origen Y destino; no existe "salida sin entrada".
  const ok = await traspasar(FABIO, CARLOS, 40_000)
  metric('tras quitar el fallo', `${ok.fromUserId} → ${ok.toUserId} en una fila`)
  assert(Boolean(ok.fromUserId && ok.toUserId), 'el traspaso no es una sola fila')
})

await spec('WORKER-XFER-015', 'concurrencia: 100.000 disponibles y dos traspasos simultáneos de 80.000', async () => {
  await empresa()
  await capital(300_000)
  await entregar(FABIO, 100_000)
  const [a, b] = await Promise.all([rechazo(() => traspasar(FABIO, CARLOS, 80_000)), rechazo(() => traspasar(FABIO, ANDRES, 80_000))])
  metric('a Carlos / a Andrés', `${a === 'ACEPTADO' ? 'ACEPTADO' : 'rechazado'} / ${b === 'ACEPTADO' ? 'ACEPTADO' : 'rechazado'}`)
  metric('Fabio', await posicion(FABIO))
  assert([a, b].filter(x => x === 'ACEPTADO').length === 1, 'no se aceptó exactamente uno')
  assert(await posicion(FABIO) === 20_000, 'Fabio no quedó en 20.000')
})

await spec('WORKER-XFER-016', 'auditoría: fecha, ejecutor, ruta, origen, destino, importe y referencia común', async () => {
  await escenario()
  const mov = await traspasar(FABIO, CARLOS, 40_000, { actor: LAURA, motivo: 'Refuerzo para la tarde' })
  const log = (await db.auditLogs.toArray()).find(l => l.entityId === mov.id)
  metric('movimiento', JSON.stringify({ fecha: mov.fecha, createdAt: mov.createdAt, por: mov.createdByUserId, ruta: mov.routeId, de: mov.fromUserId, a: mov.toUserId, monto: mov.amount, motivo: mov.motivo }))
  metric('auditoría', log ? `${log.action} · ${log.userId} · ${log.entityId}` : 'NINGUNA')
  assert(mov.fecha === today() && Boolean(mov.createdAt) && mov.createdByUserId === LAURA.id, 'faltan fecha o ejecutor')
  assert(mov.routeId === R1 && mov.fromUserId === FABIO.id && mov.toUserId === CARLOS.id && mov.amount === 40_000, 'faltan datos de la operación')
  assert(mov.motivo === 'Refuerzo para la tarde', 'falta el motivo')
  assert(log?.action === 'CASH_CUSTODY_PERSON_TO_PERSON' && log.userId === LAURA.id && log.routeId === R1, 'auditoría incompleta')
})

await spec('WORKER-XFER-017', 'reactividad: el traspaso dispara la señal y las pantallas cambian sin F5', async () => {
  await escenario()
  const señales: string[] = []
  const off = subscribeDataChanges(OPERATIONAL_TABLES, t => señales.push([...t].filter(x => x !== 'auditLogs').sort().join('+')))
  let vista = ''
  const cerrar = watchQuery(OPERATIONAL_TABLES, async () => (await desglose()).porTrabajador.map(p => `${p.nombre} ${p.monto}`).join(' · '), v => { vista = v }, 5)
  await sleep(40)
  const antes = vista
  await traspasar(FABIO, CARLOS, 40_000)
  for (let i = 0; i < 100 && vista === antes; i++) await sleep(5)
  cerrar(); off()
  metric('señal', señales.join(', '))
  metric('Cuadrar trabajadores', `${antes} → ${vista}`)
  assert(señales.includes('cashCustodyMovements'), 'el traspaso no emitió la señal')
  assert(/Carlos 90000/.test(vista) && /Fabio 110000/.test(vista), 'la vista no se actualizó')
  const panel = src(PANEL)
  assert(/\[traspaso, tenantId, routeId, userId, revision\]/.test(panel) && /\[tenantId, routeId, revision\]/.test(panel), 'el panel no recalcula el disponible / historial')
})

await spec('WORKER-XFER-018', 'cambio de ruta: posición por ruta; no reutiliza saldos de la ruta anterior', async () => {
  await empresa()
  await capital(300_000, R1)
  await capital(300_000, R2)
  await entregar(MIXTO, 70_000, R1)
  await entregar(MIXTO, 20_000, R2)
  await entregar(PEDRO, 10_000, R2)
  metric('Mario en Barreiro / Centro', `${await disponible(MIXTO, R1)} / ${await disponible(MIXTO, R2)}`)
  const r = await rechazo(() => traspasar(MIXTO, PEDRO, 50_000, { routeId: R2 }))
  metric('Mario → Pedro 50.000 en Centro (tiene 70.000 en Barreiro)', r)
  assert(await disponible(MIXTO, R1) === 70_000 && await disponible(MIXTO, R2) === 20_000, 'mezcla posiciones entre rutas')
  assert(/supera el efectivo/.test(r), 'usó el saldo de otra ruta')
  await traspasar(MIXTO, PEDRO, 20_000, { routeId: R2 })
  assert(await disponible(MIXTO, R1) === 70_000, 'un traspaso en Centro movió Barreiro')
  const panel = src(PANEL)
  const ligado = /traspasable\.routeId === routeId && traspasable\.userId === userId/.test(panel) && /setTraspaso\(null\); setTraspasoDestino\(''\); setTraspasoMonto\(0\) \}, \[routeId\]\)/.test(panel)
  metric('panel: disponible ligado a ruta+persona y reinicio al cambiar de ruta', ligado)
  assert(ligado, 'el panel podría mostrar el disponible de otra ruta')
})

await spec('WORKER-XFER-019', 'bypass del servicio: IDs manipulados', async () => {
  await escenario()
  const casos: [string, () => Promise<unknown>][] = [
    ['destino inexistente', () => transferBaseBetweenWorkers({ actor: ADMIN, tenantId: T, routeId: R1, fromUserId: FABIO.id, toUserId: 'u-fantasma', amount: 1_000, motivo: 'x x x' })],
    ['origen inexistente', () => transferBaseBetweenWorkers({ actor: ADMIN, tenantId: T, routeId: R1, fromUserId: 'u-fantasma', toUserId: CARLOS.id, amount: 1_000, motivo: 'x x x' })],
    ['ruta inexistente', () => traspasar(FABIO, CARLOS, 1_000, { routeId: 'r-fantasma' })],
    ['ruta de otra empresa con tenant propio', () => traspasar(FABIO, CARLOS, 1_000, { routeId: RB })],
    ['tenant ajeno con ruta propia', () => traspasar(FABIO, CARLOS, 1_000, { tenantId: TB })],
    ['Admin ajeno sobre ADEX', () => traspasar(FABIO, CARLOS, 1_000, { actor: AJENO_ADMIN })],
    ['destino inactivo', () => traspasar(FABIO, INACTIVO, 1_000)],
    ['destino sin caja personal (Admin)', () => transferBaseBetweenWorkers({ actor: SUPER, tenantId: T, routeId: R1, fromUserId: FABIO.id, toUserId: ADMIN.id, amount: 1_000, motivo: 'x x x' })],
    ['origen sin caja personal (Socio)', () => traspasar(SOCIO, CARLOS, 1_000)],
    ['sin actor', () => transferBaseBetweenWorkers({ actor: null, tenantId: T, routeId: R1, fromUserId: FABIO.id, toUserId: CARLOS.id, amount: 1_000, motivo: 'x x x' })],
    ['sin motivo', () => traspasar(FABIO, CARLOS, 1_000, { motivo: '' })],
  ]
  for (const [n, fn] of casos) {
    const r = await rechazo(fn)
    metric(n, r)
    assert(r !== 'ACEPTADO', `${n}: se aceptó`)
  }
  assert(await db.cashCustodyMovements.where('tipo').equals('PERSON_TO_PERSON').count() === 0, 'quedó algún traspaso')
})

await spec('WORKER-XFER-020', 'no crea una transferencia financiera Ruta → Ruta', async () => {
  await escenario()
  await traspasar(FABIO, CARLOS, 40_000)
  const falsas = (await db.transfers.toArray()).filter(t => t.routeOrigenId === R1 || t.routeDestinoId === R1)
  metric('transferencias con Barreiro', falsas.length)
  assert(falsas.length === 0, 'apareció una transferencia financiera')
  // Y la Transferencia sigue rechazando Ruta A → Ruta A (no se habilitó).
  const transfers = src('src/services/routeFundsService.ts')
  assert(/Origen y destino no pueden ser iguales/.test(transfers), 'se relajó la regla de Transferencias')
})

await spec('WORKER-XFER-021', 'efectivo compuesto: Base + cobros − desembolsos (y sin el arrastre de faltantes)', async () => {
  await empresa()
  await capital(1_000_000)
  const venta = await createDirectSale(entrada(await cliente(), SUPER, 200_000), SUPER)   // venta administrativa, cobrable
  await entregar(FABIO, 100_000)
  await cobra(FABIO, venta, 60_000)        // + cobros
  await desembolsa(FABIO, 50_000)          // − desembolso de su efectivo
  const pos = await personalCashPosition({ tenantId: T, routeId: R1, userId: FABIO.id, hasta: new Date().toISOString() })
  metric('Fabio', `Base ${pos.baseRecibida} + cobros ${pos.recaudado} − desembolsos ${pos.desembolsado} = ${pos.esperado}`)
  metric('traspasable', await disponible(FABIO))
  assert(pos.esperado === 110_000 && await disponible(FABIO) === 110_000, 'el traspasable no es la posición real')
  assert(await rechazo(() => traspasar(FABIO, CARLOS, 110_001)) !== 'ACEPTADO', 'traspasó dinero ya desembolsado')
  // Faltante: Fabio entrega 80.000 de 110.000 → 30.000 de arrastre (deuda, no billetes).
  await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: FABIO.id, entregado: 80_000, motivo: 'faltaron billetes' })
  await entregar(FABIO, 20_000)
  const pos2 = await personalCashPosition({ tenantId: T, routeId: R1, userId: FABIO.id, hasta: new Date().toISOString() })
  metric('tras cuadre con faltante + 20.000 de Base', `esperado ${pos2.esperado} (arrastre ${pos2.arrastreAnterior}) · traspasable ${transferableCash(pos2)}`)
  assert(pos2.arrastreAnterior === 30_000 && transferableCash(pos2) === 20_000, 'el arrastre cuenta como efectivo traspasable')
  assert(/supera el efectivo/.test(await rechazo(() => traspasar(FABIO, CARLOS, 25_000))), 'se traspasó la deuda')
  await traspasar(FABIO, CARLOS, 20_000)
})

await spec('WORKER-XFER-022', 'historial: el traspaso aparece comprensible', async () => {
  await escenario()
  await traspasar(FABIO, CARLOS, 40_000, { actor: LAURA, motivo: 'Refuerzo para la tarde' })
  const movs = await listCustodyMovements(R1)
  const t = movs.find(m => m.tipo === 'PERSON_TO_PERSON')
  const nombre = (id?: string) => [FABIO, CARLOS, LAURA, ADMIN].find(u => u.id === id)?.nombre ?? id
  const linea = t && `Traspaso · ${nombre(t.fromUserId)} → ${nombre(t.toUserId)} · ${t.amount} · Registró ${nombre(t.createdByUserId)} · ${t.motivo}`
  metric('historial (más reciente primero)', movs.map(m => m.tipo).join(', '))
  metric('línea', linea)
  assert(movs[0]?.tipo === 'PERSON_TO_PERSON', 'el traspaso no encabeza el historial')
  const panel = src(PANEL)
  const visible = /Entregas, devoluciones y traspasos de Base/.test(panel) && /`Traspaso · \$\{nombreDe\(m\.fromUserId \?\? ''\)\} → \$\{nombreDe\(m\.toUserId \?\? ''\)\}`/.test(panel)
    && /Registró \{nombreDe\(m\.createdByUserId\)\}/.test(panel)
  metric('panel muestra "Traspaso · origen → destino" con quién registró', visible)
  assert(visible, 'el historial no es visible en la pantalla')
})

// ============================================================
// Informe
// ============================================================
console.log('\n════════════════════════════════════════════════════════════════')
console.log('  RUTACASH · TRASPASO ENTRE TRABAJADORES (punto 6)')
console.log('════════════════════════════════════════════════════════════════')
for (const r of results) {
  console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id}  ${r.desc}`)
  for (const m of r.metrics) console.log(`          · ${m}`)
  if (r.error) console.log(`          ✗ ${r.error}`)
}
const fallidos = results.filter(r => !r.passed).length
console.log(`\n  ${results.length - fallidos}/${results.length} casos OK`)
if (fallidos > 0) process.exit(1)
