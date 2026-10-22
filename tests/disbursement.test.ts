// ============================================================
// ADEX — SUITE DE DESEMBOLSOS: UNA SOLA VEZ Y ESTADOS TERMINALES (Ronda 6/6B)
// ------------------------------------------------------------
//   npm run test:disbursement
//
// Servicios de producción sobre el singleton `db` (Dexie + fake-indexeddb), con
// datos sintéticos. Invariantes:
//   I1  una venta produce como máximo UN desembolso real;
//   I2  una venta en estado terminal (perdida, finalizada, refinanciada, solicitud
//       cancelada) no se desembolsa;
//   I3  un segundo intento —mismo u otro trabajador, antes o después de un cuadre—
//       no escribe NADA (se compara la base completa antes/después);
//   I4  comprobación y escrituras en una transacción: un fallo no deja medio
//       desembolso;
//   I5  las pantallas pasan por el servicio canónico.
// Familias: DISB-* (desembolso), LOST-* (marcar perdida), SRC-* (estructura).
// Cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import { sembrarResponsables } from './financial/capitalFixture'
import { registerCapital } from '../src/services/routeFundsService'
import { assignBaseToWorker } from '../src/services/cashCustodyService'
import {
  confirmDisbursement, createDirectSale, createSaleRequest, approveSaleRequest, markSaleLost,
  disbursementBlockedReason, DisbursementStateError, type SaleInputs,
} from '../src/services/saleRequestService'
import { closeCashSettlement, previewCashSettlement, waitClockPast } from '../src/services/cashSettlementService'
import { computeRouteCashReconciliation } from '../src/services/routeCashReconciliation'
import { getRouteBase } from '../src/services/cashboxEngine'
import { today } from '../src/lib/formatters'
import type { Sale, User } from '../src/models/types'
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
// Escenario: una ruta, su Admin responsable y el equipo
// ============================================================
const T = 't-disb'
const R1 = 'r-uno'
const R2 = 'r-dos'
const OF1 = 'of-1'
const HOY = today()
const persona = (id: string, nombre: string, rol: User['rol'], rutas: string[]): User => ({
  id, tenantId: T, nombre, email: `${id}@disb.test`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)
const SA = persona('u-sa', 'Sara SuperAdmin', 'superadmin', [])
const ADMIN = persona('u-admin', 'Andrés Admin', 'admin', [R1])
const ADMIN_2 = persona('u-admin-2', 'Bea Admin Dos', 'admin', [R2])
const JUAN = persona('u-juan', 'Juan Cobrador', 'cobrador', [R1])
const FABIO = persona('u-fabio', 'Fabio Cobrador', 'cobrador', [R1])
const LAURA = persona('u-laura', 'Laura Supervisora', 'supervisor', [R1])
const SECRE = persona('u-secre', 'Sergio Secretario', 'secretario', [R1])

async function empresa(capital = 5000) {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.add({ id: T, nombre: 'Disb', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z' } as never)
  await db.offices.add({ id: OF1, tenantId: T, nombre: 'Of', codigo: 'OF', status: 'activa', createdAt: '', updatedAt: '' } as never)
  const ruta = (id: string, nombre: string) => ({ id, tenantId: T, officeId: OF1, nombre, codigo: id, status: 'activa', capitalInicial: 0, capitalActual: 0, tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 0, createdAt: '2026-09-01' })
  await db.routes.bulkAdd([ruta(R1, 'Uno'), ruta(R2, 'Dos')] as never[])
  await db.users.bulkAdd([SA, ADMIN, ADMIN_2, JUAN, FABIO, LAURA, SECRE])
  await sembrarResponsables(db, T, { [R1]: ADMIN.id, [R2]: ADMIN_2.id })
  if (capital > 0) await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: capital })
}

let cli = 0
async function entrada(by: User, valor: number): Promise<SaleInputs> {
  const clientId = `cli-${++cli}`
  await db.clients.add({ id: clientId, tenantId: T, routeId: R1, nombre: clientId, documento: clientId, status: 'activo', createdAt: '' } as never)
  return { tenantId: T, routeId: R1, clientId, createdByUserId: by.id, valorVenta: valor, tasaInteres: 20, numeroCuotas: 10, frecuenciaPago: 'diaria', fechaInicio: HOY, paymentDays: [0, 1, 2, 3, 4, 5, 6] }
}
/** Solicitud del Cobrador aprobada por la Supervisora → venta pendiente de desembolso. */
async function aprobada(by: User = JUAN, valor = 2000): Promise<Sale> {
  const req = await createSaleRequest(await entrada(by, valor), by)
  return approveSaleRequest(req.id, LAURA)
}
/** D25 (Ronda 6/6C): quien desembolsa debe tener el efectivo; el responsable le entrega Base antes. */
const darBase = (u: User, amount: number) =>
  assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R1, recipientUserId: u.id, amount, motivo: 'Base para el desembolso' })
async function rechazo(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'ACEPTADO' } catch (e) { return e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
}

/** Fotografía de TODA la base: dos fotos iguales = cero escrituras. */
async function foto(): Promise<string> {
  const partes: Record<string, unknown[]> = {}
  for (const t of db.tables) partes[t.name] = (await t.toArray()).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return JSON.stringify(partes)
}
async function saldos() {
  const r = await computeRouteCashReconciliation({ tenantId: T, routeId: R1 })
  const pos = (u: User) => r.personas.find(p => p.userId === u.id)?.posicion ?? 0
  return { base: await getRouteBase(R1), sinAsignar: r.noAsignado, juan: pos(JUAN), fabio: pos(FABIO), laura: pos(LAURA), cuadra: r.cuadra }
}
const fila = (s: Awaited<ReturnType<typeof saldos>>) => `Base ${s.base} · Sin asignar ${s.sinAsignar} · Juan ${s.juan} · Fabio ${s.fabio} · Laura ${s.laura} · ${s.cuadra ? 'cuadra' : 'NO CUADRA'}`

/** Intento que DEBE rechazarse sin escribir nada. Devuelve el motivo. */
async function sinEfecto(fn: () => Promise<unknown>): Promise<string> {
  const antes = await foto()
  const r = await rechazo(fn)
  assert(r !== 'ACEPTADO', 'el intento fue aceptado')
  assert(await foto() === antes, 'el intento rechazado escribió en la base')
  return r
}

// ============================================================
// DISB — confirmación de desembolso
// ============================================================
await spec('DISB-001', 'T1 normal', 'una venta aprobada se desembolsa una vez con los efectos esperados', async () => {
  await empresa()
  const s = await aprobada(JUAN, 2000)
  await darBase(JUAN, 2000)
  const a = await saldos()
  await confirmDisbursement(s.id, JUAN)
  const b = await saldos()
  const v = (await db.sales.get(s.id))!
  const req = await db.saleRequests.get(v.saleRequestId!)
  metric('antes', fila(a))
  metric('después', fila(b))
  assert(b.base === a.base - 2000 && b.juan === a.juan - 2000 && b.sinAsignar === a.sinAsignar, 'el desembolso no afectó Base y posición exactamente una vez')
  assert(v.disbursementStatus === 'desembolsado' && v.disbursedByCollectorId === JUAN.id && v.disbursedByUserId === JUAN.id && !!v.disbursedAt && v.fechaDesembolso === HOY, 'campos de desembolso incompletos')
  assert(req?.status === 'disbursed', `la solicitud quedó '${req?.status}'`)
  assert(b.cuadra, 'la conciliación no cuadra')
})

await spec('DISB-002', 'T2 doble confirmación', 'confirmar dos veces la misma venta: el segundo intento escribe 0', async () => {
  await empresa()
  const s = await aprobada(JUAN, 2000)
  await darBase(JUAN, 2000)
  await confirmDisbursement(s.id, JUAN)
  const a = await saldos()
  const r = await sinEfecto(() => confirmDisbursement(s.id, JUAN))
  const b = await saldos()
  metric('segundo intento', r)
  metric('saldos', `${fila(a)} → ${fila(b)}`)
  assert(r.startsWith('DisbursementStateError') && /ya fue desembolsada/.test(r), 'no es el error de dominio esperado')
})

await spec('DISB-003', 'T2 doble confirmación', 'dos confirmaciones SIMULTÁNEAS (doble clic): exactamente una se aplica', async () => {
  await empresa()
  const s = await aprobada(JUAN, 2000)
  await darBase(JUAN, 2000)
  await darBase(FABIO, 2000)
  const a = await saldos()
  const r = await Promise.allSettled([confirmDisbursement(s.id, JUAN), confirmDisbursement(s.id, JUAN), confirmDisbursement(s.id, FABIO)])
  const b = await saldos()
  const ok = r.filter(x => x.status === 'fulfilled').length
  const errores = r.filter(x => x.status === 'rejected').map(x => (x as PromiseRejectedResult).reason)
  metric('aplicadas / rechazadas', `${ok} / ${errores.length}`)
  metric('saldos', `${fila(a)} → ${fila(b)}`)
  assert(ok === 1, `se aplicaron ${ok} confirmaciones`)
  assert(errores.every(e => e instanceof DisbursementStateError), 'un rechazo no es DisbursementStateError')
  assert(b.base === a.base - 2000 && b.juan + b.fabio === a.juan + a.fabio - 2000, 'la Base o las posiciones se descontaron más de una vez')
  assert(b.cuadra, 'la conciliación no cuadra')
})

await spec('DISB-004', 'T3 otro trabajador', 'reconfirmar con OTRO trabajador: rechazado, el responsable sigue siendo el original', async () => {
  await empresa()
  const s = await aprobada(JUAN, 2000)
  await darBase(JUAN, 2000)
  await darBase(FABIO, 2000)
  await confirmDisbursement(s.id, JUAN)
  const original = (await db.sales.get(s.id))!
  const a = await saldos()
  const r = await sinEfecto(() => confirmDisbursement(s.id, FABIO))
  const r2 = await sinEfecto(() => confirmDisbursement(s.id, LAURA))
  const r3 = await sinEfecto(() => confirmDisbursement(s.id, ADMIN))
  const v = (await db.sales.get(s.id))!
  const b = await saldos()
  metric('Fabio / Laura / Admin', [r, r2, r3].map(x => x.split(':')[0]).join(' / '))
  metric('responsable', `${v.disbursedByCollectorId} (instante ${v.disbursedAt === original.disbursedAt ? 'intacto' : 'MOVIDO'})`)
  metric('saldos', `${fila(a)} → ${fila(b)}`)
  assert(v.disbursedByCollectorId === JUAN.id && v.disbursedAt === original.disbursedAt, 'el desembolso cambió de responsable o de instante')
})

await spec('DISB-005', 'T3 otro trabajador', 'reconfirmar DESPUÉS de cerrar el cuadre (caso I3 de la auditoría): cuadre y conciliación intactos', async () => {
  await empresa()
  const s = await aprobada(JUAN, 2000)
  await darBase(JUAN, 2000)
  await confirmDisbursement(s.id, JUAN)
  const cierre = await closeCashSettlement({ actor: LAURA, tenantId: T, routeId: R1, userId: JUAN.id, entregado: 0 })
  waitClockPast(cierre.hasta)
  const a = await saldos()
  const r = await sinEfecto(() => confirmDisbursement(s.id, FABIO))
  const b = await saldos()
  const docs = await db.cashSettlements.toArray()
  const ciclo2Juan = await previewCashSettlement({ actor: LAURA, tenantId: T, routeId: R1, userId: JUAN.id })
  const ciclo2Fabio = await previewCashSettlement({ actor: LAURA, tenantId: T, routeId: R1, userId: FABIO.id })
  metric('cuadre 1 de Juan', `esperado ${cierre.esperado} · diferencia ${cierre.diferencia}`)
  metric('reintento de Fabio', r.split(':')[0])
  metric('ciclo siguiente', `Juan desembolsado ${ciclo2Juan.desembolsado} · Fabio desembolsado ${ciclo2Fabio.desembolsado}`)
  metric('saldos', `${fila(a)} → ${fila(b)}`)
  assert(docs.length === 1 && docs[0].id === cierre.id && docs[0].desembolsado === 2000 && docs[0].baseRecibida === 2000 && docs[0].diferencia === 0, 'el cuadre cerrado cambió')
  assert(ciclo2Juan.desembolsado === 0 && ciclo2Fabio.desembolsado === 0, 'el desembolso reapareció en un ciclo nuevo')
  assert(b.cuadra, 'la conciliación quedó NO CUADRA')
})

await spec('DISB-006', 'T4 perdida', 'una venta aprobada marcada perdida no se desembolsa (efecto 0)', async () => {
  await empresa()
  const s = await aprobada(JUAN, 4000)
  await markSaleLost(s.id, ADMIN, 'El cliente desistió del préstamo')
  const r = await sinEfecto(() => confirmDisbursement(s.id, JUAN))
  const v = (await db.sales.get(s.id))!
  metric('intento', r)
  metric('venta', `${v.status} · ${v.disbursementStatus}`)
  metric('saldos', fila(await saldos()))
  assert(/perdida/.test(r) && v.disbursementStatus === 'pendiente', 'la venta perdida se desembolsó')
})

await spec('DISB-007', 'T5 terminales', 'finalizada, refinanciada, solicitud cancelada/rechazada y venta antigua sin estado: 0 efecto', async () => {
  await empresa()
  const casos: [string, (s: Sale) => Promise<unknown>][] = [
    // `cancelled` existe en el modelo pero ningún servicio lo asigna hoy: se siembra.
    ['solicitud cancelled', s => db.saleRequests.update(s.saleRequestId!, { status: 'cancelled' })],
    ['solicitud rejected', s => db.saleRequests.update(s.saleRequestId!, { status: 'rejected' })],
    ['venta finalizada', s => db.sales.update(s.id, { status: 'finalizada' })],
    ['venta refinanciada', s => db.sales.update(s.id, { status: 'refinanciada' })],
    ['venta sin disbursementStatus (anterior al flujo)', s => db.sales.update(s.id, { disbursementStatus: undefined })],
  ]
  for (const [nombre, sembrar] of casos) {
    const s = await aprobada(JUAN, 1000)
    await sembrar(s)
    const r = await sinEfecto(() => confirmDisbursement(s.id, JUAN))
    metric(nombre, r.replace(/^DisbursementStateError: /, ''))
    assert(r.startsWith('DisbursementStateError'), `${nombre}: no es error de dominio`)
  }
  // Solo la venta "antigua" (sin estado = desembolsada por definición) resta 1.000 de
  // la Base, por la siembra y no por el intento; los intentos ya probaron 0 escrituras.
  assert((await saldos()).base === 4000, 'la Base cambió')
})

await spec('DISB-008', 'T7 atomicidad', 'un fallo a mitad de la confirmación no deja medio desembolso', async () => {
  await empresa()
  const s = await aprobada(JUAN, 2000)
  await darBase(JUAN, 2000)
  const antes = await foto()
  // Fallo controlado en la SEGUNDA escritura (la solicitud), después de que la venta
  // ya se actualizó dentro de la misma transacción.
  const fallo = () => { throw new Error('fallo inyectado al actualizar la solicitud') }
  db.saleRequests.hook('updating', fallo)
  let r: string
  try { r = await rechazo(() => confirmDisbursement(s.id, JUAN)) } finally { db.saleRequests.hook('updating').unsubscribe(fallo) }
  const v = (await db.sales.get(s.id))!
  metric('intento con fallo', r)
  metric('venta tras el fallo', `${v.disbursementStatus} · disbursedAt ${v.disbursedAt ?? '—'}`)
  assert(r !== 'ACEPTADO', 'el fallo inyectado no llegó a la operación')
  assert(await foto() === antes, 'quedó una escritura parcial')
  // Sin el fallo, la misma venta se desembolsa normalmente (y una sola vez).
  await confirmDisbursement(s.id, JUAN)
  const b = await saldos()
  metric('reintento sin fallo', fila(b))
  assert(b.base === 3000 && b.juan === 0 && b.sinAsignar === 3000, 'el reintento sin fallo no se aplicó una vez')
})

await spec('DISB-009', 'T8 regresión', 'Supervisor, Admin y venta directa siguen funcionando como antes', async () => {
  await empresa()
  const sup = await aprobada(FABIO, 1000)
  await darBase(LAURA, 1700)
  await confirmDisbursement(sup.id, LAURA)
  const adm = await aprobada(JUAN, 500)
  const a = await saldos()
  await confirmDisbursement(adm.id, ADMIN)
  const b = await saldos()
  const directa = await createDirectSale(await entrada(LAURA, 700), LAURA)
  const v1 = (await db.sales.get(sup.id))!
  const v2 = (await db.sales.get(adm.id))!
  metric('Supervisora', `responsable ${v1.disbursedByCollectorId}`)
  metric('Admin (entrega administrativa)', `responsable ${v2.disbursedByCollectorId ?? 'ninguno'} · Sin asignar ${a.sinAsignar} → ${b.sinAsignar}`)
  metric('venta directa Supervisora', `${directa.disbursementStatus} · ${directa.disbursedByCollectorId}`)
  metric('saldos', fila(await saldos()))
  assert(v1.disbursedByCollectorId === LAURA.id, 'el desembolso de la Supervisora no se le atribuyó')
  assert(v2.disbursedByCollectorId === undefined && b.sinAsignar === a.sinAsignar - 500, 'el desembolso del Admin no salió de la caja')
  assert(directa.disbursementStatus === 'desembolsado' && directa.disbursedByCollectorId === LAURA.id, 'la venta directa cambió')
  // Permisos sin cambios: Secretario no confirma; un Admin de otra ruta tampoco.
  const otra = await aprobada(JUAN, 300)
  const sec = await sinEfecto(() => confirmDisbursement(otra.id, SECRE))
  const ajeno = await sinEfecto(() => confirmDisbursement(otra.id, ADMIN_2))
  metric('Secretario / Admin de otra ruta', `${sec.split(':')[0]} / ${ajeno.split(':')[0]}`)
  assert((await saldos()).cuadra, 'la conciliación no cuadra')
})

await spec('DISB-010', 'regla pura', 'disbursementBlockedReason solo admite activa + pendiente + solicitud aprobada', () => {
  const ok = disbursementBlockedReason({ status: 'activa', disbursementStatus: 'pendiente' }, { status: 'approved' })
  const sinSolicitud = disbursementBlockedReason({ status: 'activa', disbursementStatus: 'pendiente' }, undefined)
  const bloqueadas = [
    disbursementBlockedReason(null),
    disbursementBlockedReason({ status: 'activa', disbursementStatus: 'desembolsado' }),
    disbursementBlockedReason({ status: 'activa', disbursementStatus: undefined }),
    disbursementBlockedReason({ status: 'perdida', disbursementStatus: 'pendiente' }),
    disbursementBlockedReason({ status: 'activa', disbursementStatus: 'pendiente' }, { status: 'disbursed' }),
    disbursementBlockedReason({ status: 'activa', disbursementStatus: 'pendiente' }, { status: 'pending' }),
  ]
  metric('admitidas', [ok, sinSolicitud].filter(x => x === null).length)
  metric('bloqueadas', bloqueadas.filter(Boolean).length)
  assert(ok === null && sinSolicitud === null, 'una venta válida quedó bloqueada')
  assert(bloqueadas.every(Boolean), 'un estado inválido quedó admitido')
})

// ============================================================
// LOST — marcar perdida por servicio
// ============================================================
await spec('LOST-001', 'T6 transición', 'venta YA desembolsada → perdida: castigo sin mover dinero ni cuadres, auditado', async () => {
  await empresa()
  const s = await aprobada(JUAN, 2000)
  await darBase(JUAN, 2000)
  await confirmDisbursement(s.id, JUAN)
  const desembolso = (await db.sales.get(s.id))!
  const a = await saldos()
  await markSaleLost(s.id, ADMIN, 'Cliente ilocalizable desde hace 30 días')
  const b = await saldos()
  const v = (await db.sales.get(s.id))!
  const audit = (await db.auditLogs.toArray()).filter(l => l.action === 'SALE_LOST' && l.entityId === s.id)
  metric('saldos', `${fila(a)} → ${fila(b)}`)
  metric('venta', `${v.status} · ${v.disbursementStatus} · responsable ${v.disbursedByCollectorId}`)
  metric('auditoría SALE_LOST', audit.length)
  assert(a.base === b.base && a.juan === b.juan && a.sinAsignar === b.sinAsignar, 'marcar perdida movió dinero o cuadres')
  assert(v.status === 'perdida' && v.disbursementStatus === 'desembolsado' && v.disbursedByCollectorId === JUAN.id && v.disbursedAt === desembolso.disbursedAt, 'marcar perdida tocó el desembolso')
  assert(audit.length === 1 && audit[0].motivo === 'Cliente ilocalizable desde hace 30 días', 'falta la auditoría con motivo')
  // Ni se vuelve a desembolsar ni se vuelve a castigar.
  await sinEfecto(() => confirmDisbursement(s.id, FABIO))
  const otra = await sinEfecto(() => markSaleLost(s.id, ADMIN, 'Segundo intento de castigo'))
  metric('segundo castigo', otra)
})

// [MODIFICADO Ronda 67] Antes el SuperAdmin también castigaba; ahora su cartera es de solo lectura.
await spec('LOST-002', 'T6 permisos', 'marcar perdida conserva la matriz: solo el Admin de la ruta (sale.cancel); el SuperAdmin ya no', async () => {
  await empresa()
  const res: string[] = []
  for (const u of [JUAN, LAURA, SECRE, ADMIN_2]) {
    const s = await aprobada(JUAN, 300)
    const r = await sinEfecto(() => markSaleLost(s.id, u, 'Intento sin autoridad suficiente'))
    res.push(`${u.rol}${u === ADMIN_2 ? ' (otra ruta)' : ''}: ${r.split(':')[0]}`)
  }
  const s1 = await aprobada(JUAN, 300)
  await markSaleLost(s1.id, ADMIN, 'Admin de la ruta')
  const s2 = await aprobada(JUAN, 300)
  const sa = await sinEfecto(() => markSaleLost(s2.id, SA, 'SuperAdmin de la empresa'))
  res.push(`superadmin: ${sa.split(':')[0]}`)
  const s3 = await aprobada(JUAN, 300)
  const vacio = await sinEfecto(() => markSaleLost(s3.id, ADMIN, '   '))
  res.push(`Admin: aceptado`, `motivo vacío: ${vacio.split(':')[0]}`)
  for (const x of res) metric('·', x)
})

// ============================================================
// SRC — una sola frontera
// ============================================================
await spec('SRC-DISB-001', 'I5 frontera', 'ninguna pantalla escribe desembolsos ni estados de venta por su cuenta', () => {
  const pantallas = ['src/pages/admin/ActiveSalesPage.tsx', 'src/pages/collector/CollectorDisbursementsPage.tsx']
  const infractores = pantallas.filter(f => /db\.sales\.(update|put|add|bulkPut|modify)|status:\s*'perdida'|disbursementStatus:\s*'desembolsado'/.test(readSource(f)))
  const usan = [readSource(pantallas[0]).includes('markSaleLost('), readSource(pantallas[1]).includes('confirmDisbursement(')]
  // Fuera del servicio canónico nadie marca una venta como desembolsada.
  const escritores = fs.readdirSync('src', { recursive: true }).map(String)
    .filter(f => /\.(ts|tsx)$/.test(f)).map(f => `src/${f.replace(/\\/g, '/')}`)
    .filter(f => /disbursementStatus:\s*'desembolsado'/.test(readSource(f)))
  metric('pantallas con escrituras propias', infractores.length ? infractores.join(', ') : 'ninguna')
  metric('archivos que marcan desembolsado', escritores.join(', '))
  assert(infractores.length === 0, `escritura directa en ${infractores.join(', ')}`)
  assert(usan.every(Boolean), 'una pantalla no usa el servicio canónico')
  assert(escritores.length === 1 && escritores[0] === 'src/services/saleRequestService.ts', 'otro archivo marca ventas como desembolsadas')
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
