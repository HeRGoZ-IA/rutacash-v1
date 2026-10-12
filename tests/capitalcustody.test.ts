// ============================================================
// ADEX — SUITE RONDA 6/6C: CAPITAL, CUSTODIA, CASTIGOS Y CIERRES
// ------------------------------------------------------------
//   npm run test:capitalcustody
//
// Servicios de producción sobre el singleton `db` (Dexie + fake-indexeddb), datos
// sintéticos. Decisiones aprobadas que se prueban:
//   D24  aprobar NO reserva capital; la disponibilidad se mira al desembolsar.
//   D26  ningún desembolso supera la Base de la ruta (ni la deja negativa).
//   D25  quien entrega el dinero lo tiene en mano (efectivo del ciclo, sin faltantes
//        arrastrados); los gastos legítimos siguen pudiendo dejarlo en negativo.
//   D28  castigar un crédito desembolsado no mueve dinero ni borra su historia.
//   D7   un periodo cerrado no se modifica con escrituras ordinarias.
//   y la autorización: sin usuario no hay desembolso.
// Todo rechazo se comprueba con la base COMPLETA antes/después (cero escrituras).
// Familias: CAP6C, CASH6C, LOST6C, CLOSE6C, AUTH6C. Cualquier fallo → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import { sembrarResponsables } from './financial/capitalFixture'
import { registerCapital, registerTransfer } from '../src/services/routeFundsService'
import { assignBaseToWorker } from '../src/services/cashCustodyService'
import { createExpense } from '../src/services/expenseService'
import { registerPayment } from '../src/services/paymentService'
import { reverseCapitalMovement } from '../src/services/movementReversalService'
import { closeSettlement } from '../src/services/settlementService'
import { generateWeeklySettlement } from '../src/services/weeklySettlementEngine'
import {
  confirmDisbursement, createDirectSale, createSaleRequest, approveSaleRequest, markSaleLost,
  DisbursementFundsError, DisbursementStateError, type SaleInputs,
} from '../src/services/saleRequestService'
import { closeCashSettlement, previewCashSettlement, waitClockPast } from '../src/services/cashSettlementService'
import { computeRouteCashReconciliation } from '../src/services/routeCashReconciliation'
import { carteraEnCalleOf, getRouteBase } from '../src/services/cashboxEngine'
import { addDays, nowISO, today } from '../src/lib/formatters'
import type { Sale, User } from '../src/models/types'

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

// ============================================================
// Escenario: una ruta con su Admin responsable y el equipo
// ============================================================
const T = 't-6c'
const R1 = 'r-uno'
const R2 = 'r-dos'
const OF1 = 'of-1'
const CAT = 'cat-combustible'
const HOY = today()
const SEMANA_PASADA = { semanaInicio: addDays(HOY, -7), semanaFin: addDays(HOY, -1) }
const persona = (id: string, nombre: string, rol: User['rol'], rutas: string[]): User => ({
  id, tenantId: T, nombre, email: `${id}@6c.test`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)
const SA = persona('u-sa', 'Sara SuperAdmin', 'superadmin', [])
const ADMIN = persona('u-admin', 'Andrés Admin', 'admin', [R1])
const ADMIN_2 = persona('u-admin-2', 'Bea Admin Dos', 'admin', [R2])
const JUAN = persona('u-juan', 'Juan Cobrador', 'cobrador', [R1])
const FABIO = persona('u-fabio', 'Fabio Cobrador', 'cobrador', [R1])
const LAURA = persona('u-laura', 'Laura Supervisora', 'supervisor', [R1])
const SECRE = persona('u-secre', 'Sergio Secretario', 'secretario', [R1])
const SOCIO = persona('u-socio', 'Hernán Socio', 'socio', [R1])

async function empresa(capitalInicial = 5000) {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.add({ id: T, nombre: '6C', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z' } as never)
  await db.offices.add({ id: OF1, tenantId: T, nombre: 'Of', codigo: 'OF', status: 'activa', createdAt: '', updatedAt: '' } as never)
  const ruta = (id: string, nombre: string) => ({ id, tenantId: T, officeId: OF1, nombre, codigo: id, status: 'activa', capitalInicial: 0, capitalActual: 0, tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 0, createdAt: '2026-09-01' })
  await db.routes.bulkAdd([ruta(R1, 'Uno'), ruta(R2, 'Dos')] as never[])
  await db.users.bulkAdd([SA, ADMIN, ADMIN_2, JUAN, FABIO, LAURA, SECRE, SOCIO])
  await db.expenseCategories.add({ id: CAT, tenantId: T, nombre: 'Combustible', activa: true } as never)
  await sembrarResponsables(db, T, { [R1]: ADMIN.id, [R2]: ADMIN_2.id })
  if (capitalInicial > 0) await capital(capitalInicial)
}
const capital = (valor: number, fecha?: string) => registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor, fecha })
const darBase = (u: User, amount: number) =>
  assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R1, recipientUserId: u.id, amount, motivo: 'Base para el desembolso' })

/**
 * Cierre ANTICIPADO como los que la app permitía antes de D29 (Ronda 6/6C.1): hoy
 * `closeSettlement` lo rechaza, pero esos documentos existen en datos históricos y
 * siguen protegiendo su periodo. Se archiva con las cifras del motor, como lo hacía
 * el servicio.
 */
async function cierreAnticipadoHistorico(semanaInicio: string, semanaFin: string) {
  const calculo = await generateWeeklySettlement({ tenantId: T, routeId: R1, semanaInicio, semanaFin })
  await db.weeklySettlements.add({ ...calculo, status: 'cerrada', closedAt: nowISO(), closedByUserId: ADMIN.id, createdByUserId: ADMIN.id, version: 1 } as never)
  return calculo
}

let cli = 0
async function entrada(by: User, valor: number): Promise<SaleInputs> {
  const clientId = `cli-${++cli}`
  await db.clients.add({ id: clientId, tenantId: T, routeId: R1, nombre: clientId, documento: clientId, status: 'activo', createdAt: '' } as never)
  return { tenantId: T, routeId: R1, clientId, createdByUserId: by.id, valorVenta: valor, tasaInteres: 20, numeroCuotas: 10, frecuenciaPago: 'diaria', fechaInicio: HOY, paymentDays: [0, 1, 2, 3, 4, 5, 6] }
}
/** Solicitud del Cobrador aprobada por la Supervisora → venta pendiente de desembolso. */
async function aprobada(by: User, valor: number): Promise<Sale> {
  const req = await createSaleRequest(await entrada(by, valor), by)
  return approveSaleRequest(req.id, LAURA)
}
async function rechazo(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); return 'ACEPTADO' } catch (e) { return e }
}
const texto = (e: unknown) => e === 'ACEPTADO' ? 'ACEPTADO' : e instanceof Error ? `${e.name}: ${e.message}` : String(e)

/** Fotografía de TODA la base: dos fotos iguales = cero escrituras. */
async function foto(): Promise<string> {
  const partes: Record<string, unknown[]> = {}
  for (const t of db.tables) partes[t.name] = (await t.toArray()).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return JSON.stringify(partes)
}
/** Intento que DEBE rechazarse sin escribir nada. Devuelve el error. */
async function sinEfecto(fn: () => Promise<unknown>): Promise<unknown> {
  const antes = await foto()
  const e = await rechazo(fn)
  assert(e !== 'ACEPTADO', 'el intento fue aceptado')
  assert(await foto() === antes, 'el intento rechazado escribió en la base')
  return e
}
async function saldos() {
  const r = await computeRouteCashReconciliation({ tenantId: T, routeId: R1 })
  const pos = (u: User) => r.personas.find(p => p.userId === u.id)?.posicion ?? 0
  return { base: await getRouteBase(R1), sinAsignar: r.noAsignado, juan: pos(JUAN), fabio: pos(FABIO), laura: pos(LAURA), cuadra: r.cuadra }
}
const fila = (s: Awaited<ReturnType<typeof saldos>>) => `Base ${s.base} · Sin asignar ${s.sinAsignar} · Juan ${s.juan} · Fabio ${s.fabio} · Laura ${s.laura} · ${s.cuadra ? 'cuadra' : 'NO CUADRA'}`
const estadoDe = async (s: Sale) => {
  const v = (await db.sales.get(s.id))!
  const req = v.saleRequestId ? await db.saleRequests.get(v.saleRequestId) : undefined
  return `venta ${v.status}/${v.disbursementStatus} · solicitud ${req?.status ?? '—'}`
}

// ============================================================
// CAPITAL (D24 + D26)
// ============================================================
await spec('CAP6C-001', 'Capital', 'Base 500, desembolso 2.000: rechazo por capital y cero escrituras (RC-1)', async () => {
  await empresa(500)
  await darBase(JUAN, 500)
  const a = await aprobada(JUAN, 2000)
  const b = await aprobada(JUAN, 2000)
  const e1 = await sinEfecto(() => confirmDisbursement(a.id, JUAN))
  const e2 = await sinEfecto(() => confirmDisbursement(b.id, JUAN))
  const s = await saldos()
  metric('1.º intento', texto(e1))
  metric('2.º intento', texto(e2))
  metric('saldos', fila(s))
  assert(e1 instanceof DisbursementFundsError && e1.kind === 'ruta' && e2 instanceof DisbursementFundsError, 'no es el rechazo por capital de ruta')
  assert(s.base === 500 && s.base >= 0, 'la Base cambió o quedó negativa')
})

await spec('CAP6C-002', 'Capital', 'Base 5.000, dos solicitudes de 4.000 aprobadas: la 1.ª se desembolsa, la 2.ª se rechaza (RC-2)', async () => {
  await empresa(5000)
  const a = await aprobada(JUAN, 4000)
  const b = await aprobada(FABIO, 4000)
  const tras = await saldos()
  await darBase(JUAN, 4000)
  await darBase(FABIO, 1000)
  await confirmDisbursement(a.id, JUAN)
  const despues1 = await saldos()
  const e = await sinEfecto(() => confirmDisbursement(b.id, FABIO))
  metric('tras aprobar ambas (D24, sin reserva)', fila(tras))
  metric('tras el 1.º desembolso', fila(despues1))
  metric('2.º desembolso', texto(e))
  assert(tras.base === 5000, 'aprobar movió la Base (reserva implícita)')
  assert(despues1.base === 1000 && despues1.juan === 0, 'el 1.º desembolso no se aplicó una vez')
  assert(e instanceof DisbursementFundsError && e.kind === 'ruta', 'el 2.º no se rechazó por capital de ruta')
})

await spec('CAP6C-003', 'Capital', 'la solicitud rechazada por fondos sigue aprobada y pendiente de desembolso (D24)', async () => {
  await empresa(5000)
  await aprobada(JUAN, 4000).then(async a => { await darBase(JUAN, 4000); await confirmDisbursement(a.id, JUAN) })
  const b = await aprobada(FABIO, 4000)
  await darBase(FABIO, 1000)
  await rechazo(() => confirmDisbursement(b.id, FABIO))
  const estado = await estadoDe(b)
  metric('segunda', estado)
  assert(estado === 'venta activa/pendiente · solicitud approved', 'el rechazo por fondos canceló o alteró la solicitud')
})

await spec('CAP6C-004', 'Capital', 'con capital legítimo posterior, la pendiente se desembolsa UNA sola vez', async () => {
  await empresa(5000)
  await aprobada(JUAN, 4000).then(async a => { await darBase(JUAN, 4000); await confirmDisbursement(a.id, JUAN) })
  const b = await aprobada(FABIO, 4000)
  await darBase(FABIO, 1000)
  await rechazo(() => confirmDisbursement(b.id, FABIO))
  await capital(3000)                 // colocación desde la bolsa del responsable
  await darBase(FABIO, 3000)          // entrega de Base autorizada
  const a1 = await saldos()
  await confirmDisbursement(b.id, FABIO)
  const a2 = await saldos()
  const otra = await sinEfecto(() => confirmDisbursement(b.id, FABIO))
  metric('antes / después', `${fila(a1)} → ${fila(a2)}`)
  metric('reintento', texto(otra))
  assert(a2.base === a1.base - 4000 && a2.base === 0 && a2.fabio === 0, 'el desembolso no se aplicó una vez')
  assert(otra instanceof DisbursementStateError, 'el reintento no se rechazó por estado')
  assert(await estadoDe(b) === 'venta activa/desembolsado · solicitud disbursed', 'estado final incorrecto')
})

await spec('CAP6C-005', 'Capital', 'intentos simultáneos: nunca Base negativa ni doble uso del disponible', async () => {
  // Ruta y efectivo coinciden (Juan tiene toda la Base): tres desembolsos de 2.000
  // simultáneos con 5.000 → se aplican exactamente dos.
  await empresa(5000)
  const ventas = [await aprobada(JUAN, 2000), await aprobada(JUAN, 2000), await aprobada(JUAN, 2000)]
  await darBase(JUAN, 5000)
  const r = await Promise.allSettled(ventas.map(v => confirmDisbursement(v.id, JUAN)))
  const s = await saldos()
  const ok = r.filter(x => x.status === 'fulfilled').length
  const motivos = r.filter(x => x.status === 'rejected').map(x => texto((x as PromiseRejectedResult).reason))
  metric('aplicados', `${ok}/3`)
  metric('rechazo', motivos.join(' | '))
  metric('saldos', fila(s))
  assert(ok === 2 && s.base === 1000 && s.juan === 1000 && s.base >= 0 && s.juan >= 0, 'se usó dos veces el mismo disponible')
  // Efectivo del trabajador: cinco de 1.000 con 3.000 en mano → exactamente tres.
  await empresa(10_000)
  const cinco = await Promise.all(Array.from({ length: 5 }, () => aprobada(FABIO, 1000)))
  await darBase(FABIO, 3000)
  const r2 = await Promise.allSettled(cinco.map(v => confirmDisbursement(v.id, FABIO)))
  const s2 = await saldos()
  const ok2 = r2.filter(x => x.status === 'fulfilled').length
  metric('cinco de 1.000 con 3.000 en mano', `${ok2} aplicados · ${fila(s2)}`)
  assert(ok2 === 3 && s2.fabio === 0 && s2.base === 7000 && s2.cuadra, 'el efectivo del trabajador se usó dos veces')
})

await spec('CAP6C-006', 'Capital', 'venta directa: conserva el control de Base y aplica el mismo control de efectivo', async () => {
  await empresa(1000)
  const e0 = await entrada(LAURA, 2000)
  const supera = await sinEfecto(() => createDirectSale(e0, LAURA))
  metric('Supervisora 2.000 con Base 1.000', texto(supera))
  assert(supera instanceof DisbursementFundsError && /supera la Base de la ruta/.test((supera as Error).message), 'la venta directa perdió el control de Base')
  const e1 = await entrada(LAURA, 800)
  const sinEfectivo = await sinEfecto(() => createDirectSale(e1, LAURA))
  metric('Supervisora sin efectivo', texto(sinEfectivo))
  assert(sinEfectivo instanceof DisbursementFundsError && sinEfectivo.kind === 'trabajador', 'la venta directa no exige efectivo en mano')
  await darBase(LAURA, 800)
  const v = await createDirectSale(e1, LAURA)
  metric('con Base entregada', `${v.disbursementStatus} · ${v.disbursedByCollectorId} · ${fila(await saldos())}`)
  assert(v.disbursedByCollectorId === LAURA.id && (await saldos()).laura === 0, 'la venta directa no se cargó a la Supervisora')
  // Admin (sin caja personal): el dinero sale de la caja de la ruta. Base 1.200 con
  // 1.000 en manos de Juan → la Base alcanza para 300, la caja sin asignar (200) no.
  await capital(1000)
  await darBase(JUAN, 1000)
  const eAdm = await entrada(ADMIN, 300)
  const caja = await sinEfecto(() => createDirectSale(eAdm, ADMIN))
  metric('Admin 300 con Base 1.200 y Sin asignar 200', texto(caja))
  assert(caja instanceof DisbursementFundsError && caja.kind === 'caja', 'el Admin desembolsó más que la caja de la ruta')
  const adm = await createDirectSale(await entrada(ADMIN, 200), ADMIN)
  metric('Admin 200', `${adm.disbursementStatus} · responsable ${adm.disbursedByCollectorId ?? 'ninguno (caja de la ruta)'} · ${fila(await saldos())}`)
  assert(adm.disbursedByCollectorId === undefined && (await saldos()).sinAsignar === 0 && (await saldos()).juan === 1000, 'el desembolso administrativo no salió de la caja')
  const eJuan = await entrada(JUAN, 100)
  const juan = await sinEfecto(() => createDirectSale(eJuan, JUAN))
  metric('Cobrador venta directa', texto(juan))
})

// ============================================================
// CUSTODIA (D25)
// ============================================================
await spec('CASH6C-001', 'Custodia', 'trabajador sin efectivo: rechazo informado y cero escrituras (RC-6)', async () => {
  await empresa(5000)
  const s = await aprobada(JUAN, 2000)
  const e = await sinEfecto(() => confirmDisbursement(s.id, JUAN))
  metric('Juan con 0', texto(e))
  assert(e instanceof DisbursementFundsError && e.kind === 'trabajador' && /Tienes 0 y necesitas 2000/.test(e.message), 'no informa el motivo del rechazo')
})

await spec('CASH6C-002', 'Custodia', 'trabajador con efectivo suficiente: desembolso correcto', async () => {
  await empresa(5000)
  const s = await aprobada(JUAN, 2000)
  await darBase(JUAN, 2500)
  const a = await saldos()
  await confirmDisbursement(s.id, JUAN)
  const b = await saldos()
  metric('antes → después', `${fila(a)} → ${fila(b)}`)
  assert(b.base === a.base - 2000 && b.juan === 500 && b.sinAsignar === a.sinAsignar && b.cuadra, 'efectos incorrectos')
})

await spec('CASH6C-003', 'Custodia', 'rechazo → entrega de Base autorizada → nuevo intento válido', async () => {
  await empresa(5000)
  const s = await aprobada(JUAN, 2000)
  await rechazo(() => confirmDisbursement(s.id, JUAN))
  await darBase(JUAN, 2000)
  await confirmDisbursement(s.id, JUAN)
  const b = await saldos()
  metric('final', `${await estadoDe(s)} · ${fila(b)}`)
  assert(b.juan === 0 && b.base === 3000 && b.sinAsignar === 3000, 'el desembolso tras la entrega no cuadró')
})

await spec('CASH6C-004', 'Custodia', 'el bloqueo por efectivo no toca la solicitud, la venta ni el capital', async () => {
  await empresa(5000)
  const s = await aprobada(FABIO, 3000)
  await darBase(FABIO, 1000)
  const a = await saldos()
  const e = await sinEfecto(() => confirmDisbursement(s.id, FABIO))   // compara la base completa
  metric('rechazo', texto(e))
  metric('estado', `${await estadoDe(s)} · ${fila(a)}`)
  assert(await estadoDe(s) === 'venta activa/pendiente · solicitud approved', 'la solicitud cambió')
})

await spec('CASH6C-005', 'Custodia', 'un gasto legítimo del trabajador sigue pudiendo dejarlo en negativo; un desembolso no', async () => {
  await empresa(5000)
  const g = await createExpense({ actor: JUAN, tenantId: T, scope: 'trabajador', routeId: R1, collectorId: JUAN.id, categoryId: CAT, valor: 300 })
  const tras = await saldos()
  metric('gasto 300 sin efectivo', `${g.valor} · Juan ${tras.juan}`)
  assert(tras.juan === -300, 'el gasto legítimo del trabajador ya no puede dejarlo en negativo')
  const s = await aprobada(JUAN, 100)
  await darBase(JUAN, 200)   // queda en −100
  const e = await sinEfecto(() => confirmDisbursement(s.id, JUAN))
  metric('desembolso 100 con −100 en mano', texto(e))
  assert(e instanceof DisbursementFundsError && e.kind === 'trabajador', 'un desembolso dejó al trabajador en negativo')
})

await spec('CASH6C-006', 'Custodia', 'desembolsar no genera transferencias ni entregas de Base automáticas', async () => {
  await empresa(5000)
  const s = await aprobada(JUAN, 1000)
  const t0 = await db.transfers.count()
  const c0 = await db.cashCustodyMovements.count()
  await rechazo(() => confirmDisbursement(s.id, JUAN))
  const c1 = await db.cashCustodyMovements.count()
  await darBase(JUAN, 1000)
  await confirmDisbursement(s.id, JUAN)
  const c2 = await db.cashCustodyMovements.count()
  metric('transferencias', `${t0} → ${await db.transfers.count()}`)
  metric('movimientos de Base (rechazo · entrega · desembolso)', `${c0} → ${c1} → ${c2 - 1} + 1 entrega manual`)
  assert(await db.transfers.count() === t0 && c1 === c0 && c2 === c0 + 1, 'el desembolso creó movimientos de Base o transferencias')
})

await spec('CASH6C-007', 'Custodia', 'un faltante arrastrado no es efectivo disponible para desembolsar', async () => {
  await empresa(5000)
  await darBase(JUAN, 2000)
  const cierre = await closeCashSettlement({ actor: LAURA, tenantId: T, routeId: R1, userId: JUAN.id, entregado: 1500, motivo: 'Faltan 500 por justificar' })
  waitClockPast(cierre.hasta)
  const p = await previewCashSettlement({ actor: LAURA, tenantId: T, routeId: R1, userId: JUAN.id })
  const s = await aprobada(JUAN, 500)
  const e = await sinEfecto(() => confirmDisbursement(s.id, JUAN))
  metric('cuadre', `esperado ${cierre.esperado} · entregado 1500 · arrastre siguiente ${p.arrastreAnterior} · posición ${p.esperado}`)
  metric('desembolso 500', texto(e))
  assert(p.arrastreAnterior === 500 && p.esperado === 500, 'el faltante no quedó arrastrado')
  assert(e instanceof DisbursementFundsError && e.kind === 'trabajador', 'el faltante arrastrado se usó como efectivo')
})

// ============================================================
// CASTIGOS (D28)
// ============================================================
async function creditoDesembolsado(valor = 2000): Promise<Sale> {
  const s = await aprobada(JUAN, valor)
  await darBase(JUAN, valor)
  await confirmDisbursement(s.id, JUAN)
  return (await db.sales.get(s.id))!
}

await spec('LOST6C-001', 'Castigos', 'un crédito desembolsado puede castigarse (Admin y SuperAdmin de la ruta)', async () => {
  await empresa(5000)
  const a = await creditoDesembolsado(1000)
  const b = await creditoDesembolsado(1000)
  await markSaleLost(a.id, ADMIN, 'Cliente ilocalizable hace 45 días')
  await markSaleLost(b.id, SA, 'Cliente fallecido sin herederos')
  metric('Admin / SuperAdmin', `${(await db.sales.get(a.id))!.status} / ${(await db.sales.get(b.id))!.status}`)
  assert((await db.sales.get(a.id))!.status === 'perdida' && (await db.sales.get(b.id))!.status === 'perdida', 'no se pudo castigar')
})

await spec('LOST6C-002', 'Castigos', 'el castigo no mueve Base, custodia ni transferencias', async () => {
  await empresa(5000)
  const s = await creditoDesembolsado()
  const a = await saldos()
  const custodia = JSON.stringify(await db.cashCustodyMovements.toArray())
  const transf = JSON.stringify(await db.transfers.toArray())
  await markSaleLost(s.id, ADMIN, 'Cliente ilocalizable hace 45 días')
  const b = await saldos()
  metric('saldos', `${fila(a)} → ${fila(b)}`)
  assert(JSON.stringify(a) === JSON.stringify(b), 'el castigo cambió Base, caja o posiciones')
  assert(JSON.stringify(await db.cashCustodyMovements.toArray()) === custodia && JSON.stringify(await db.transfers.toArray()) === transf, 'el castigo tocó custodia o transferencias')
})

await spec('LOST6C-003', 'Castigos', 'conserva desembolso, pagos, parcelas y deuda histórica; sale de la cartera activa', async () => {
  await empresa(5000)
  const s = await creditoDesembolsado(2000)
  const pago = await registerPayment({ saleId: s.id, requestedAmount: 240, actor: JUAN })
  assert(pago.ok, 'no se pudo registrar el pago previo')
  const antes = (await db.sales.get(s.id))!
  const pagos = JSON.stringify(await db.payments.where('saleId').equals(s.id).toArray())
  const parcelas = JSON.stringify(await db.installments.where('saleId').equals(s.id).toArray())
  const cartera0 = carteraEnCalleOf(await db.sales.toArray())
  await markSaleLost(s.id, ADMIN, 'Cliente ilocalizable hace 45 días')
  const v = (await db.sales.get(s.id))!
  const cartera1 = carteraEnCalleOf(await db.sales.toArray())
  metric('venta', `${v.status} · saldo ${v.saldo} (antes ${antes.saldo}) · desembolsó ${v.disbursedByCollectorId} el ${v.disbursedAt}`)
  metric('cartera activa', `${cartera0} → ${cartera1}`)
  assert(['disbursementStatus', 'disbursedByCollectorId', 'disbursedByUserId', 'disbursedAt', 'fechaDesembolso', 'saldo', 'valorTotal', 'clientId', 'valorVenta']
    .every(k => JSON.stringify((v as never)[k]) === JSON.stringify((antes as never)[k])), 'el castigo cambió datos del crédito')
  assert(JSON.stringify(await db.payments.where('saleId').equals(s.id).toArray()) === pagos, 'el castigo tocó los pagos')
  assert(JSON.stringify(await db.installments.where('saleId').equals(s.id).toArray()) === parcelas, 'el castigo tocó las parcelas')
  assert(cartera1 === cartera0 - antes.saldo, 'la deuda castigada sigue en la cartera activa')
})

await spec('LOST6C-004', 'Castigos', 'actor, instante, motivo y auditoría SALE_LOST (castigo vs. venta sin desembolsar)', async () => {
  await empresa(5000)
  const s = await creditoDesembolsado()
  const p = await aprobada(FABIO, 500)
  await markSaleLost(s.id, ADMIN, 'Cliente ilocalizable hace 45 días')
  await markSaleLost(p.id, ADMIN, 'El cliente desistió antes del desembolso')
  const v = (await db.sales.get(s.id))!
  const logs = (await db.auditLogs.toArray()).filter(l => l.action === 'SALE_LOST')
  const deS = logs.find(l => l.entityId === s.id)!
  const deP = logs.find(l => l.entityId === p.id)!
  metric('venta', `${v.motivoPerdida} · ${v.lostByUserId} · ${v.lostAt}`)
  metric('auditoría', `${deS.descripcion} | ${deP.descripcion}`)
  assert(v.lostByUserId === ADMIN.id && !!v.lostAt && v.motivoPerdida === 'Cliente ilocalizable hace 45 días', 'faltan actor, instante o motivo en la venta')
  assert(deS.userId === ADMIN.id && deS.motivo === v.motivoPerdida && (deS.metadata as { castigo?: boolean }).castigo === true, 'auditoría del castigo incompleta')
  assert((deP.metadata as { castigo?: boolean }).castigo === false, 'una venta sin desembolsar se auditó como castigo')
})

await spec('LOST6C-005', 'Castigos', 'sin permiso no se castiga (Cobrador, Supervisor, Secretario, Socio, Admin de otra ruta)', async () => {
  await empresa(5000)
  const s = await creditoDesembolsado()
  for (const u of [JUAN, LAURA, SECRE, SOCIO, ADMIN_2]) {
    const e = await sinEfecto(() => markSaleLost(s.id, u, 'Intento sin autoridad suficiente'))
    metric(u.rol + (u === ADMIN_2 ? ' (otra ruta)' : ''), texto(e).split(':')[0])
  }
})

await spec('LOST6C-006', 'Castigos', 'una venta aprobada marcada perdida sigue sin poder desembolsarse', async () => {
  await empresa(5000)
  const p = await aprobada(JUAN, 1000)
  await darBase(JUAN, 1000)
  await markSaleLost(p.id, ADMIN, 'El cliente desistió antes del desembolso')
  const e = await sinEfecto(() => confirmDisbursement(p.id, JUAN))
  metric('intento', texto(e))
  assert(e instanceof DisbursementStateError && /perdida/.test(e.message), 'la venta perdida se desembolsó')
})

// ============================================================
// CIERRES (D7)
// ============================================================
await spec('CLOSE6C-001', 'Cierres', 'un desembolso posterior no modifica el cuadre ni la semana cerrados', async () => {
  await empresa(5000)
  await capital(1000, addDays(HOY, -3))
  const semana = await closeSettlement({ actor: ADMIN, tenantId: T, routeId: R1, ...SEMANA_PASADA })
  const s1 = await creditoDesembolsado(1000)
  const cuadre = await closeCashSettlement({ actor: LAURA, tenantId: T, routeId: R1, userId: JUAN.id, entregado: 0 })
  waitClockPast(cuadre.hasta)
  const docs = JSON.stringify([await db.cashSettlements.toArray(), await db.weeklySettlements.toArray()])
  await creditoDesembolsado(1500)
  const p = await previewCashSettlement({ actor: LAURA, tenantId: T, routeId: R1, userId: JUAN.id })
  const vivo = await generateWeeklySettlement({ tenantId: T, routeId: R1, ...SEMANA_PASADA })
  metric('cuadre 1 de Juan', `Base ${cuadre.baseRecibida} − desembolso ${cuadre.desembolsado} = ${cuadre.esperado} · ${s1.valorVenta}`)
  metric('ciclo 2', `Base ${p.baseRecibida} · desembolsado ${p.desembolsado}`)
  metric('semana cerrada', `archivada ${semana.saldoFinal} · recalculada ${vivo.saldoFinal}`)
  assert(JSON.stringify([await db.cashSettlements.toArray(), await db.weeklySettlements.toArray()]) === docs, 'un cierre cambió')
  assert(p.desembolsado === 1500 && p.baseRecibida === 1500, 'el desembolso no cayó en el ciclo abierto')
  assert(vivo.saldoFinal === semana.saldoFinal && vivo.ingresoCapital === semana.ingresoCapital, 'la semana cerrada cambió al recalcularla')
})

await spec('CLOSE6C-002', 'Cierres', 'escrituras con fecha en un periodo cerrado: rechazo y cero escrituras', async () => {
  await empresa(5000)
  await closeSettlement({ actor: ADMIN, tenantId: T, routeId: R1, ...SEMANA_PASADA })
  const ayer = addDays(HOY, -1)
  // Capital y gasto de ruta con fecha en la semana cerrada (las pantallas tienen selector de fecha).
  const cap = await sinEfecto(() => capital(1000, ayer))
  const gasto = await sinEfecto(() => createExpense({ actor: ADMIN, tenantId: T, scope: 'ruta', routeId: R1, categoryId: CAT, valor: 100, fecha: ayer }))
  // Pago con fecha en la semana cerrada.
  const s = await creditoDesembolsado(1000)
  const antes = await foto()
  const pago = await registerPayment({ saleId: s.id, requestedAmount: 100, actor: JUAN, fecha: ayer })
  const pagoSinEscritura = await foto() === antes
  metric('capital con fecha cerrada', texto(cap))
  metric('gasto de ruta con fecha cerrada', texto(gasto))
  metric('pago con fecha cerrada', pago.ok ? 'ACEPTADO' : `${pago.code}: ${pago.message}`)
  assert(!pago.ok && pago.code === 'PERIOD_CLOSED' && pagoSinEscritura, 'el pago entró en la semana cerrada')
  // Semana en curso cerrada antes de tiempo: un desembolso de hoy tampoco entra.
  const hoyAprobada = await aprobada(FABIO, 500)
  await darBase(FABIO, 500)
  await cierreAnticipadoHistorico(HOY, HOY)
  const d = await sinEfecto(() => confirmDisbursement(hoyAprobada.id, FABIO))
  const eDir = await entrada(ADMIN, 100)
  const directa = await sinEfecto(() => createDirectSale(eDir, ADMIN))
  const pagoHoy = await registerPayment({ saleId: s.id, requestedAmount: 100, actor: JUAN })
  metric('desembolso con la semana de hoy cerrada', texto(d))
  metric('venta directa con la semana de hoy cerrada', texto(directa))
  metric('pago de hoy con la semana cerrada', pagoHoy.ok ? 'ACEPTADO' : pagoHoy.code)
  assert(d instanceof DisbursementStateError && /cerrada/.test(d.message), 'el desembolso entró en la semana cerrada')
  assert(!pagoHoy.ok && pagoHoy.code === 'PERIOD_CLOSED', 'el pago de hoy entró en la semana cerrada')
  assert(await estadoDe(hoyAprobada) === 'venta activa/pendiente · solicitud approved', 'el rechazo alteró la solicitud')
})

await spec('CLOSE6C-003', 'Cierres', 'ajuste legítimo posterior (anulación de capital) va al periodo actual sin reescribir el cerrado', async () => {
  await empresa(5000)
  const mov = await capital(1000, addDays(HOY, -3))
  const semana = await closeSettlement({ actor: ADMIN, tenantId: T, routeId: R1, ...SEMANA_PASADA })
  const archivada = JSON.stringify(await db.weeklySettlements.toArray())
  const { original, reversal } = await reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: mov.id, reason: 'Capital colocado en la ruta equivocada' })
  const vivo = await generateWeeklySettlement({ tenantId: T, routeId: R1, ...SEMANA_PASADA })
  metric('original', `fecha ${original.fecha} · valor ${original.valor} · anulado por ${original.reversedByUserId ?? '—'}`)
  metric('anulación', `fecha ${reversal.fecha} · valor ${reversal.valor} · vínculo ${reversal.reversesId === mov.id}`)
  metric('semana cerrada', `archivada ${semana.ingresoCapital} · recalculada ${vivo.ingresoCapital}`)
  assert(reversal.fecha === HOY && reversal.reversesId === mov.id && original.fecha === mov.fecha && original.valor === mov.valor, 'el ajuste reescribió el hecho original')
  assert(JSON.stringify(await db.weeklySettlements.toArray()) === archivada && vivo.ingresoCapital === semana.ingresoCapital, 'el ajuste alteró la semana cerrada')
})

await spec('CLOSE6C-004', 'Cierres', 'castigar después de los cierres no altera cuadre ni semana históricos', async () => {
  await empresa(5000)
  const s = await creditoDesembolsado(2000)
  const cuadre = await closeCashSettlement({ actor: LAURA, tenantId: T, routeId: R1, userId: JUAN.id, entregado: 0 })
  waitClockPast(cuadre.hasta)
  await cierreAnticipadoHistorico(HOY, HOY)
  const docs = JSON.stringify([await db.cashSettlements.toArray(), await db.weeklySettlements.toArray()])
  const vivoAntes = await generateWeeklySettlement({ tenantId: T, routeId: R1, semanaInicio: HOY, semanaFin: HOY })
  await markSaleLost(s.id, ADMIN, 'Cliente ilocalizable hace 45 días')
  const vivoDespues = await generateWeeklySettlement({ tenantId: T, routeId: R1, semanaInicio: HOY, semanaFin: HOY })
  const p = await previewCashSettlement({ actor: LAURA, tenantId: T, routeId: R1, userId: JUAN.id })
  metric('semana', `${vivoAntes.saldoFinal} → ${vivoDespues.saldoFinal}`)
  metric('ciclo siguiente de Juan', `desembolsado ${p.desembolsado} · esperado ${p.esperado}`)
  assert(JSON.stringify([await db.cashSettlements.toArray(), await db.weeklySettlements.toArray()]) === docs, 'el castigo cambió un cierre')
  assert(vivoAntes.saldoFinal === vivoDespues.saldoFinal && vivoAntes.prestamosEntregados === vivoDespues.prestamosEntregados, 'el castigo cambió las cifras de la semana')
  assert(p.desembolsado === 0 && p.esperado === 0, 'el castigo reapareció en el cuadre')
})

// ============================================================
// AUTORIZACIÓN
// ============================================================
await spec('AUTH6C-001', 'Autorización', 'confirmar sin usuario: rechazo y cero escrituras', async () => {
  await empresa(5000)
  const s = await aprobada(JUAN, 1000)
  await darBase(JUAN, 1000)
  const e = await sinEfecto(() => confirmDisbursement(s.id, undefined as unknown as User))
  const e2 = await sinEfecto(() => confirmDisbursement(s.id, null as unknown as User))
  metric('undefined / null', `${texto(e)} / ${texto(e2).split(':')[0]}`)
  assert((e as Error).name === 'AuthzError' && (e2 as Error).name === 'AuthzError', 'una llamada sin usuario no se rechazó como autorización')
})

await spec('AUTH6C-002', 'Autorización', 'usuario sin permiso: rechazo y cero escrituras', async () => {
  await empresa(5000)
  const s = await aprobada(JUAN, 1000)
  await darBase(JUAN, 1000)
  for (const u of [SECRE, SOCIO, ADMIN_2]) {
    const e = await sinEfecto(() => confirmDisbursement(s.id, u))
    metric(u.rol + (u === ADMIN_2 ? ' (otra ruta)' : ''), texto(e).split(':')[0])
    assert((e as Error).name === 'AuthzError', `${u.rol}: no es un rechazo de autorización`)
  }
})

await spec('AUTH6C-003', 'Autorización', 'operación autorizada: comportamiento normal', async () => {
  await empresa(5000)
  const s = await aprobada(JUAN, 1000)
  await darBase(JUAN, 1000)
  await confirmDisbursement(s.id, JUAN)
  metric('final', `${await estadoDe(s)} · ${fila(await saldos())}`)
  assert(await estadoDe(s) === 'venta activa/desembolsado · solicitud disbursed', 'el desembolso autorizado no se aplicó')
})

await spec('AUTH6C-004', 'Autorización', 'los rechazos de autorización no dejan efectos financieros', async () => {
  await empresa(5000)
  const s = await aprobada(JUAN, 1000)
  await darBase(JUAN, 1000)
  const a = await saldos()
  await rechazo(() => confirmDisbursement(s.id, undefined as unknown as User))
  await rechazo(() => confirmDisbursement(s.id, SECRE))
  await rechazo(() => markSaleLost(s.id, undefined as unknown as User, 'Sin usuario'))
  await rechazo(() => createDirectSale({ tenantId: T, routeId: R1, clientId: 'x', createdByUserId: 'x', valorVenta: 1, tasaInteres: 20, numeroCuotas: 1, frecuenciaPago: 'diaria', fechaInicio: HOY, paymentDays: [1] }, undefined as unknown as User))
  const b = await saldos()
  metric('saldos', `${fila(a)} → ${fila(b)}`)
  assert(JSON.stringify(a) === JSON.stringify(b) && await estadoDe(s) === 'venta activa/pendiente · solicitud approved', 'un rechazo dejó efectos')
})

// Referencia de no regresión del modelo de transferencias: una Ruta → Ruta sigue igual.
await spec('REG6C-001', 'Regresión', 'transferencia Ruta → Ruta y entrega de Base intactas', async () => {
  await empresa(5000)
  await db.users.update(ADMIN.id, { authorizedRouteIds: [R1, R2] })
  await sembrarResponsables(db, T, { [R2]: ADMIN.id }, 0)
  const admin = { ...ADMIN, authorizedRouteIds: [R1, R2] }
  const t = await registerTransfer({ actor: admin, tenantId: T, origen: { type: 'route', id: R1 }, destino: { type: 'route', id: R2 }, valor: 1000 })
  await darBase(JUAN, 1000)
  const s = await saldos()
  metric('transferencia / saldos', `${t.transfer.valor} · ${fila(s)} · Dos ${await getRouteBase(R2)}`)
  assert(s.base === 4000 && s.juan === 1000 && await getRouteBase(R2) === 1000, 'transferencias o entrega de Base cambiaron')
})

// ============================================================
// Resumen
// ============================================================
let fallos = 0
for (const r of results) {
  console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.id} [${r.group}] ${r.desc}`)
  for (const m of r.metrics) console.log(`      ${m}`)
  if (!r.passed) { fallos++; console.log(`      ✘ ${r.error}`) }
}
console.log(`\n${results.length - fallos}/${results.length} PASS · ${fallos} FAIL`)
process.exit(fallos ? 1 : 0)
