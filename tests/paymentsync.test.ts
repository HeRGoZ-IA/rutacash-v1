// ============================================================
// RUTACASH — SUITE SINCRONIZACIÓN DE ANULACIONES DE PAGOS (DEXIE REAL)
// ------------------------------------------------------------
//   npm run test:paymentsync
//
// Ajuste del socio 2026-10-02, punto 8. El Admin anula un pago y el Cobrador debe
// terminar viendo la anulación sin resetear la app.
//
// ALCANCE REAL (auditado): NO hay backend, ni pull, ni cola remota. Todas las
// sesiones de un navegador comparten la IndexedDB `RutaCashDB`; `syncStatus` es la
// etiqueta local "registrado sin conexión / confirmado". Aquí:
//   · "otra pestaña / otro contexto" = una SEGUNDA conexión `RutaCashDB` sobre la
//     misma base (lo que hace el navegador con dos pestañas);
//   · "llegada de un registro" = escritura de la fila tal cual viajaría (put) más
//     `recomputeSale`, para probar que el libro converge con cualquier orden y que
//     una copia vieja no reactiva un anulado (guarda de monotonía en Dexie).
//
// Escenario: ADEX, ruta Barreiro (R1) y Centro (R2), Fabio y Carlos cobradores.
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { format, subDays } from 'date-fns'
import { db, RutaCashDB } from '../src/lib/db'
import { today } from '../src/lib/formatters'
import { subscribeDataChanges } from '../src/lib/dataRevision'
import {
  dependentSyncStatus, paymentDisplayStateOf, paymentHistoryRows, paymentLedgerAnomalies, pendingPaymentSyncCount,
} from '../src/lib/paymentState'
import { getRouteBase } from '../src/services/cashboxEngine'
import { computeRouteCashReconciliation } from '../src/services/routeCashReconciliation'
import { personalCashPosition } from '../src/services/cashSettlementService'
import { registerCapital } from '../src/services/routeFundsService'
import { createDirectSale, type SaleInputs } from '../src/services/saleRequestService'
import { registerPayment } from '../src/services/paymentService'
import { annulPayment, correctPayment, recomputeSale } from '../src/services/paymentCorrectionService'
import { getPendingSyncCount, syncPendingItems } from '../src/services/syncService'
import { calculateCurrentInstallment, getLastPaidInstallmentNumber } from '../src/services/installmentEngine'
import type { Payment, Sale, User } from '../src/models/types'
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
  try { await fn() } catch (e) { passed = false; error = e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  results.push({ id, desc, passed, error, metrics: [...current] })
}

async function rechazo(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'ACEPTADO' } catch (e) { return e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const src = (p: string) => fs.readFileSync(p, 'utf8')
const ayer = format(subDays(new Date(), 1), 'yyyy-MM-dd')

// ============================================================
// Escenario
// ============================================================
const T = 't-adex'
const TB = 't-ajena'
const R1 = 'r-barreiro'
const R2 = 'r-centro'
const RB = 'r-ajena'

const persona = (id: string, nombre: string, rol: User['rol'], rutas: string[], tenantId = T): User => ({
  id, tenantId, nombre, email: `${id}@adex.co`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)

const SUPER = persona('u-super', 'Sara SuperAdmin', 'superadmin', [])
const ADMIN = persona('u-admin', 'Andrés Admin', 'admin', [R1, R2])
const SECRE = persona('u-secre', 'Sergio Secretario', 'secretario', [R1])
const FABIO = persona('u-fabio', 'Fabio', 'cobrador', [R1])
const CARLOS = persona('u-carlos', 'Carlos', 'cobrador', [R2])
const AJENO_ADMIN = persona('u-ajeno-admin', 'Ana Ajena', 'admin', [RB], TB)
const AJENO_COB = persona('u-ajeno-cob', 'Beto Ajeno', 'cobrador', [RB], TB)

/** Segunda conexión a la MISMA IndexedDB: la pestaña del Admin. */
const adminTab = new RutaCashDB()

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
  await db.users.bulkAdd([SUPER, ADMIN, SECRE, FABIO, CARLOS, AJENO_ADMIN, AJENO_COB])
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 5_000_000 })
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R2, valor: 5_000_000 })
  await registerCapital({ actor: AJENO_ADMIN, tenantId: TB, routeId: RB, valor: 5_000_000 })
}

let cliSeq = 0
async function cliente(routeId = R1, tenantId = T) {
  const id = `cli-${++cliSeq}`
  await db.clients.add({ id, tenantId, routeId, nombre: `Cliente ${cliSeq}`, documento: id, telefonoPrincipal: '300', direccionPrincipal: 'x', direccionSecundaria: 'y', status: 'activo', createdAt: '', updatedAt: '' } as never)
  return id
}
const entrada = (clientId: string, actor: User, valor: number, cuotas: number, routeId: string, tenantId: string): SaleInputs => ({
  tenantId, routeId, clientId, createdByUserId: actor.id, valorVenta: valor, tasaInteres: 20, numeroCuotas: cuotas,
  frecuenciaPago: 'diaria', fechaInicio: today(), paymentDays: [0, 1, 2, 3, 4, 5, 6],
})
/** Crédito administrativo: 1.000.000 al 20% en 20 cuotas = 60.000 (por defecto). */
async function credito(valor = 1_000_000, cuotas = 20, routeId = R1, tenantId = T): Promise<Sale> {
  const actor = tenantId === T ? SUPER : AJENO_ADMIN
  return createDirectSale(entrada(await cliente(routeId, tenantId), actor, valor, cuotas, routeId, tenantId), actor)
}
/** Pago del Cobrador; `offline` → queda 'pending' como lo deja PaymentPage sin red. */
async function cobra(u: User, sale: Sale, valor: number, opts: { offline?: boolean; fecha?: string } = {}): Promise<Payment> {
  const r = await registerPayment({ saleId: sale.id, requestedAmount: valor, actor: u, fecha: opts.fecha, syncStatus: opts.offline ? 'pending' : 'synced' })
  if (!r.ok) throw new Error(`pago rechazado: ${r.code} ${r.message}`)
  return (await db.payments.get(r.paymentId))!
}
/** Anulación hecha en la PESTAÑA DEL ADMIN (otra conexión). */
const anularEnAdmin = (p: { id: string }, reason = 'Pago duplicado', actor: User = ADMIN, tenantId = T) =>
  annulPayment({ actor, tenantId, paymentId: p.id, reason }, adminTab)

/** Foto del crédito vista desde una conexión (por defecto, la del Cobrador). */
async function estado(saleId: string, base: RutaCashDB = db) {
  const sale = (await base.sales.get(saleId))!
  const insts = (await base.installments.where('saleId').equals(saleId).toArray()).sort((a, b) => a.numero - b.numero)
  return {
    saldo: sale.saldo, status: sale.status, fechaFinalizacion: sale.fechaFinalizacion,
    actual: calculateCurrentInstallment(insts)?.numero ?? null,
    ultimaPagada: getLastPaidInstallmentNumber(insts),
    cuotas: insts.map(i => `${i.numero}:${i.status}:${i.pagado}`).join(' '),
    insts,
  }
}
const firma = (e: Awaited<ReturnType<typeof estado>>) => `${e.saldo}|${e.status}|${e.actual}|${e.ultimaPagada}|${e.cuotas}`
const posicion = async (u: User, routeId = R1) =>
  (await personalCashPosition({ tenantId: T, routeId, userId: u.id, hasta: new Date().toISOString() })).esperado
const pagosDe = (saleId: string, base: RutaCashDB = db) => base.payments.where('saleId').equals(saleId).toArray()
const estadosSync = async (saleId: string) =>
  (await pagosDe(saleId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map(p => `${p.state}:${p.valor}:${p.syncStatus}`).join(' ')

/**
 * LLEGADA de un registro a una copia (como lo aplicaría una sincronización): la fila
 * tal cual + recálculo canónico, en UNA transacción. Devuelve 'aplicado' o el error
 * (una copia vieja que intenta reactivar un anulado es rechazada por la guarda).
 */
async function llega(row: Payment, base: RutaCashDB = db): Promise<string> {
  try {
    await base.transaction('rw', [base.payments, base.installments, base.sales], async () => {
      await base.payments.put({ ...row })
      await recomputeSale(row.saleId, base)
    })
    return 'aplicado'
  } catch (e) { return e instanceof Error ? e.name : String(e) }
}
/** Copia "vacía" del crédito: sin pagos, recalculado (la otra copia antes de recibir nada). */
async function copiaVacia(saleId: string) {
  await db.payments.where('saleId').equals(saleId).delete()
  await db.transaction('rw', [db.payments, db.installments, db.sales], () => recomputeSale(saleId))
}

// ============================================================
// Casos
// ============================================================
await spec('PAY-SYNC-001', 'pago local pending → synced (estado y crédito intactos)', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000, { offline: true })
  const antes = firma(await estado(v.id))
  const pendientes = await getPendingSyncCount({ tenantId: T })
  const r = await syncPendingItems({ tenantId: T, routeIds: [R1] })
  const o = (await db.payments.get(p.id))!
  metric('pendientes antes', pendientes)
  metric('resultado', JSON.stringify(r))
  assert(p.syncStatus === 'pending' && pendientes === 1, 'el pago offline no quedó pendiente')
  assert(o.syncStatus === 'synced' && o.state === 'active' && r.synced === 1, 'no se confirmó')
  assert(firma(await estado(v.id)) === antes, 'confirmar cambió el crédito')
})

await spec('PAY-SYNC-002', 'reversión local pending (hereda del original) → synced con él', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000, { offline: true })
  const { reversal } = await anularEnAdmin(p)
  metric('al anular', await estadosSync(v.id))
  assert(reversal.syncStatus === 'pending', 'la reversión de un pago pendiente nació confirmada')
  const r = await syncPendingItems({ tenantId: T, routeIds: [R1] })
  metric('tras confirmar', await estadosSync(v.id))
  assert(r.synced === 2 && r.deferred === 0, 'no se confirmaron original y reversión')
  assert((await db.payments.get(reversal.id))!.syncStatus === 'synced' && (await db.payments.get(p.id))!.state === 'reversed', 'estado final incorrecto')
})

await spec('PAY-SYNC-003', 'otro contexto recibe el payment active', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000)
  const enAdmin = await adminTab.payments.get(p.id)
  metric('pestaña Admin', enAdmin ? `${enAdmin.state} ${enAdmin.valor}` : 'NO LLEGA')
  assert(enAdmin?.state === 'active' && enAdmin.valor === 60_000, 'la otra pestaña no ve el pago')
  assert(firma(await estado(v.id, adminTab)) === firma(await estado(v.id)), 'las copias difieren')
})

await spec('PAY-SYNC-004', 'después recibe la reversal: payment queda reversed', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000)
  const vistaVieja = (await db.payments.get(p.id))!
  await anularEnAdmin(p)
  const o = (await db.payments.get(p.id))!
  const rev = (await pagosDe(v.id)).find(x => x.state === 'reversal')
  metric('Cobrador', `antes ${vistaVieja.state} → ahora ${o.state} · reversión ${rev?.valor}`)
  assert(o.state === 'reversed' && rev?.reversesPaymentId === p.id && o.reversalPaymentId === rev.id, 'el Cobrador no recibió la anulación completa')
  assert((await estado(v.id)).saldo === 1_200_000, 'saldo no restaurado')
})

await spec('PAY-SYNC-005', 'reversal duplicada: idempotente; una segunda reversión distinta se señala', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000)
  const { reversal } = await anularEnAdmin(p)
  const f = firma(await estado(v.id))
  const otra = await rechazo(() => anularEnAdmin(p))
  const r1 = await llega(reversal)
  const r2 = await llega(reversal)
  const revs = (await pagosDe(v.id)).filter(x => x.state === 'reversal')
  metric('segunda anulación', otra)
  metric('misma reversión ×2', `${r1}, ${r2} → ${revs.length} reversión(es)`)
  assert(otra.includes('ya fue anulado') && revs.length === 1 && firma(await estado(v.id)) === f, 'la reversión se duplicó')
  // Una reversión con OTRO id para el mismo pago es un estado imposible: se ve, no se suma en silencio.
  await db.payments.add({ ...reversal, id: 'rev-fantasma', syncStatus: 'pending' })
  const anom = paymentLedgerAnomalies(await pagosDe(v.id))
  const s = await syncPendingItems({ tenantId: T })
  metric('fila extra', `${anom.map(a => a.code).join(',')} · sync ${JSON.stringify(s)} · fantasma ${(await db.payments.get('rev-fantasma'))!.syncStatus}`)
  assert(anom.some(a => a.code === 'DUPLICATE_REVERSAL') && (await db.payments.get('rev-fantasma'))!.syncStatus === 'error', 'la reversión duplicada no se señaló')
})

await spec('PAY-SYNC-006', 'payment duplicado: idempotente', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000)
  const f = firma(await estado(v.id))
  const a = await llega(p)
  const b = await llega(p)
  const add = await rechazo(() => db.payments.add({ ...p }))
  metric('put ×2', `${a}, ${b} · add repetido: ${add.split(':')[0]}`)
  assert((await pagosDe(v.id)).length === 1 && firma(await estado(v.id)) === f, 'el pago se duplicó o se recalculó acumulando')
  assert(add !== 'ACEPTADO', 'add del mismo id aceptado')
})

await spec('PAY-SYNC-007', 'reversal llega antes que payment: se difiere (error visible) y converge al llegar', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000, { offline: true })
  await anularEnAdmin(p)
  const filas = await pagosDe(v.id)
  const P = filas.find(x => x.id === p.id)!
  const R = filas.find(x => x.state === 'reversal')!
  const esperado = firma(await estado(v.id))
  await copiaVacia(v.id)
  await llega(R)
  const s1 = await syncPendingItems({ tenantId: T })
  const rTrasSync = (await db.payments.get(R.id))!.syncStatus
  await llega(P)
  const s2 = await syncPendingItems({ tenantId: T })
  metric('R1 sola', `sync ${JSON.stringify(s1)} → R1 ${rTrasSync}`)
  metric('llega P1', `sync ${JSON.stringify(s2)} → ${await estadosSync(v.id)}`)
  assert(rTrasSync === 'error' && s1.synced === 0, 'la reversión huérfana se confirmó o se descartó')
  assert(s2.synced === 2 && firma(await estado(v.id)) === esperado, 'no convergió al llegar el original')
})

await spec('PAY-SYNC-008', 'Cobrador offline → anulación en otra pestaña → vuelve online: converge', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000, { offline: true })
  await anularEnAdmin(p)
  const antes = await pendingPaymentSyncCount(await pagosDe(v.id))
  const s = await syncPendingItems({ tenantId: T, routeIds: [R1] })
  metric('pendientes (filas)', `${antes} → ${pendingPaymentSyncCount(await pagosDe(v.id))}`)
  metric('crédito', firma(await estado(v.id)).slice(0, 40))
  assert(antes === 1 && s.synced === 2 && pendingPaymentSyncCount(await pagosDe(v.id)) === 0, 'no quedó todo confirmado')
  assert((await estado(v.id)).saldo === 1_200_000, 'el crédito no refleja la anulación')
})

await spec('PAY-SYNC-009', 'copia vieja active intenta sobrescribir reversed: reversed prevalece', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000)
  const vieja = (await db.payments.get(p.id))!   // lo que la pestaña del Cobrador tenía en memoria
  await anularEnAdmin(p)
  const put = await llega({ ...vieja, observacion: 'copia tardía' })
  const upd = await rechazo(() => db.payments.update(p.id, { state: 'active' }))
  const mod = await rechazo(() => db.payments.where('id').equals(p.id).modify({ state: 'active' }))
  metric('put copia vieja', put)
  metric('update/modify', `${upd.split(':')[0]} / ${mod.split(':')[0]}`)
  assert(put === 'PaymentStateTransitionError' && upd !== 'ACEPTADO' && mod !== 'ACEPTADO', 'una copia vieja reactivó el pago')
  const o = (await db.payments.get(p.id))!
  assert(o.state === 'reversed' && o.observacion !== 'copia tardía' && (await estado(v.id)).saldo === 1_200_000, 'quedó un estado intermedio')
})

await spec('PAY-SYNC-010', 'P1 +50.000, P2 +30.000, anular P1 → solo P2 cuenta', async () => {
  await empresa()
  const v = await credito()
  const control = await credito()
  const p1 = await cobra(FABIO, v, 50_000)
  await cobra(FABIO, v, 30_000)
  await anularEnAdmin(p1)
  await cobra(FABIO, control, 30_000)
  metric('con P1 anulado', firma(await estado(v.id)).slice(0, 60))
  metric('solo P2 (control)', firma(await estado(control.id)).slice(0, 60))
  assert(firma(await estado(v.id)) === firma(await estado(control.id)), 'P1 sigue contando')
})

await spec('PAY-SYNC-011', 'recomputeSale tras la llegada = estado del contexto que anuló', async () => {
  await empresa()
  const v = await credito()
  await cobra(FABIO, v, 60_000)
  const p = await cobra(FABIO, v, 90_000)
  await anularEnAdmin(p)
  const enAdmin = firma(await estado(v.id, adminTab))
  const filas = await pagosDe(v.id)
  await copiaVacia(v.id)
  for (const f of filas) await llega(f)
  metric('Admin', enAdmin.slice(0, 50))
  metric('copia reconstruida', firma(await estado(v.id)).slice(0, 50))
  assert(firma(await estado(v.id)) === enAdmin, 'el recálculo no reproduce el estado')
})

await spec('PAY-SYNC-012', 'Base tras recibir la anulación', async () => {
  await empresa()
  const v = await credito()
  const base0 = await getRouteBase(R1)
  const p = await cobra(FABIO, v, 70_000)
  const conPago = await getRouteBase(R1)
  await anularEnAdmin(p)
  const r = await computeRouteCashReconciliation({ tenantId: T, routeId: R1 })
  metric('Base', `${base0} → ${conPago} → ${await getRouteBase(R1)}`)
  assert(conPago === base0 + 70_000 && await getRouteBase(R1) === base0, 'Base no restaurada')
  assert(r.libro.saldo === r.noAsignado + r.enPersonas && r.cuadra, 'identidad Base rota')
})

await spec('PAY-SYNC-013', 'efectivo del trabajador tras recibir la anulación', async () => {
  await empresa()
  const v = await credito()
  const e0 = await posicion(FABIO)
  const p = await cobra(FABIO, v, 70_000, { offline: true })
  const e1 = await posicion(FABIO)
  await anularEnAdmin(p)
  metric('Fabio en manos', `${e0} → ${e1} → ${await posicion(FABIO)}`)
  assert(e1 === e0 + 70_000 && await posicion(FABIO) === e0, 'efectivo no restaurado')
})

await spec('PAY-SYNC-014', 'cuotas tras recibir la anulación', async () => {
  await empresa()
  const v = await credito()
  await cobra(FABIO, v, 60_000)
  const antes = (await estado(v.id)).cuotas
  const p = await cobra(FABIO, v, 80_000)        // completa la 2 y abona 20.000 a la 3
  await anularEnAdmin(p)
  const d = await estado(v.id)
  metric('cuotas 1–3', d.insts.slice(0, 3).map(i => `${i.numero}:${i.status}:${i.pagado}`).join(' '))
  assert(d.cuotas === antes && d.insts[1].status !== 'pagada' && d.insts[2].pagado === 0, 'cuotas no reconstruidas')
})

await spec('PAY-SYNC-015', 'parcela actual tras recibir la anulación', async () => {
  await empresa()
  const v = await credito()
  await cobra(FABIO, v, 240_000)
  const p = await cobra(FABIO, v, 60_000)
  const con = (await estado(v.id)).actual
  await anularEnAdmin(p)
  metric('parcela', `${con} → ${(await estado(v.id)).actual}`)
  assert(con === 6 && (await estado(v.id)).actual === 5, 'parcela no restaurada')
})

await spec('PAY-SYNC-016', 'crédito finalizado reabre tras la anulación en otra pestaña', async () => {
  await empresa()
  const v = await credito(200_000, 10)
  const p = await cobra(FABIO, v, 240_000)
  const fin = await estado(v.id)
  await anularEnAdmin(p)
  const d = await estado(v.id)
  metric('estado', `${fin.status} (${fin.fechaFinalizacion}) → ${d.status} (${d.fechaFinalizacion ?? 'sin fecha'})`)
  assert(fin.status === 'finalizada' && d.status === 'activa' && d.saldo === 240_000 && !d.fechaFinalizacion, 'no reabrió')
})

await spec('PAY-SYNC-017', 'CollectorSyncPage: anulado ≠ vigente, sin fila técnica, reactiva y con alcance', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 24_000, { offline: true })
  await cobra(FABIO, v, 10_000)
  await anularEnAdmin(p)
  const pagos = await pagosDe(v.id)
  const filas = paymentHistoryRows(pagos)
  const vista = filas.map(r => `${r.payment.valor}:${paymentDisplayStateOf(r.payment)}`).join(' ')
  metric('filas', vista)
  metric('pendientes (filas)', pendingPaymentSyncCount(pagos))
  assert(filas.length === 2 && !filas.some(r => r.payment.state === 'reversal'), 'aparece el asiento técnico')
  assert(vista.includes('24000:anulado') && vista.includes('10000:vigente'), 'el anulado se ve vigente')
  assert(pendingPaymentSyncCount(pagos) === 1, 'el pendiente se cuenta doble o se pierde')
  const page = src('src/pages/collector/CollectorSyncPage.tsx')
  for (const k of ['paymentHistoryRows(', "useDataRevision(['payments'])", 'paymentDisplayStateOf(', 'syncPendingItems({ tenantId, routeIds: [routeId] })', 'p.tenantId === tenantId', 'PaymentStateBadge']) {
    assert(page.includes(k), `CollectorSyncPage no usa ${k}`)
  }
  assert(!/reversesPaymentId|UUID|\{r\.payment\.id\}/.test(page.replace(/key=\{r\.payment\.id\}/, '')), 'la pantalla expone detalles técnicos')
})

await spec('PAY-SYNC-018', 'corrección del Secretario: reversión + reemplazo siguen al original pendiente', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000, { offline: true })
  const r = await correctPayment(SECRE, p.id, { newValor: 50_000, reason: 'Valor digitado incorrectamente' })
  assert(r.success, `corrección rechazada: ${r.error}`)
  metric('al corregir', await estadosSync(v.id))
  const pend = (await pagosDe(v.id)).filter(x => x.syncStatus === 'pending').length
  const s = await syncPendingItems({ tenantId: T, routeIds: [R1] })
  metric('tras confirmar', await estadosSync(v.id))
  assert(pend === 3 && s.synced === 3, 'la cadena no nació pendiente o no se confirmó entera')
  assert(firma(await estado(v.id, adminTab)) === firma(await estado(v.id)) && (await estado(v.id)).saldo === 1_150_000, 'la corrección no converge')
})

await spec('PAY-SYNC-019', 'interrupción a mitad de la confirmación: rollback, reintento sin duplicados', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000, { offline: true })
  await anularEnAdmin(p)
  const original = db.payments.update.bind(db.payments)
  let n = 0
  ;(db.payments as { update: typeof original }).update = ((...a: Parameters<typeof original>) => {
    if (++n === 2) throw new Error('Fallo de red simulado')
    return original(...a)
  }) as typeof original
  const s1 = await syncPendingItems({ tenantId: T })
  ;(db.payments as { update: typeof original }).update = original
  const trasFallo = await estadosSync(v.id)
  const s2 = await syncPendingItems({ tenantId: T })
  const s3 = await syncPendingItems({ tenantId: T })
  metric('fallo', `${JSON.stringify(s1)} → ${trasFallo}`)
  metric('reintento', `${JSON.stringify(s2)} · otra vez ${JSON.stringify(s3)} → ${await estadosSync(v.id)}`)
  assert(!trasFallo.includes('synced') && s1.synced === 0 && s1.errors === 1, 'la transacción fallida dejó confirmaciones a medias')
  assert(s2.synced === 2 && s3.synced === 0 && (await pagosDe(v.id)).length === 2, 'el reintento duplicó o no confirmó')
})

await spec('PAY-SYNC-020', 'reentrada: cerrar y reabrir la app a mitad no pierde ni duplica', async () => {
  await empresa()
  const v1 = await credito()
  const v2 = await credito(500_000, 10, R2)
  const a = await cobra(FABIO, v1, 60_000, { offline: true })
  await cobra(CARLOS, v2, 30_000, { offline: true })
  await anularEnAdmin(a)
  await syncPendingItems({ tenantId: T, routeIds: [R1] })     // confirma R1 y "se cierra"
  db.close()
  await db.open()
  const pend = await getPendingSyncCount({ tenantId: T })
  const s = await syncPendingItems({ tenantId: T })
  metric('tras reabrir', `pendientes ${pend} · sync ${JSON.stringify(s)}`)
  assert(pend === 1 && s.synced === 1, 'la reentrada perdió o repitió trabajo')
  assert((await db.payments.get(a.id))!.state === 'reversed' && (await db.payments.count()) === 3, 'estado o filas alterados')
})

await spec('PAY-SYNC-021', 'syncStatus correcto en todo el ciclo', async () => {
  await empresa()
  const v = await credito()
  const online = await cobra(FABIO, v, 10_000)
  const offline = await cobra(FABIO, v, 20_000, { offline: true })
  const rOn = (await anularEnAdmin(online)).reversal
  const rOff = (await anularEnAdmin(offline)).reversal
  metric('online / su reversión', `${online.syncStatus} / ${rOn.syncStatus}`)
  metric('offline / su reversión', `${offline.syncStatus} / ${rOff.syncStatus}`)
  assert(online.syncStatus === 'synced' && rOn.syncStatus === 'synced', 'online mal etiquetado')
  assert(offline.syncStatus === 'pending' && rOff.syncStatus === 'pending', 'offline mal etiquetado')
  assert(dependentSyncStatus({ syncStatus: 'error' }) === 'pending', 'un original con error no deja pendiente al dependiente')
  await syncPendingItems({ tenantId: T })
  assert((await pagosDe(v.id)).every(x => x.syncStatus === 'synced'), 'no todo quedó confirmado')
})

await spec('PAY-SYNC-022', 'nada se marca synced prematuramente (dependiente espera al original)', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000, { offline: true })
  const r = await correctPayment(SECRE, p.id, { newValor: 40_000, reason: 'Valor digitado incorrectamente' })
  const rev = (await db.payments.get(r.reversalId!))!
  // Estado imposible en el original (segunda reversión) → original y reversiones 'error'.
  await db.payments.add({ ...rev, id: 'rev-dup', syncStatus: 'pending' })
  const s = await syncPendingItems({ tenantId: T })
  const reemplazo = (await db.payments.get(r.correctedId!))!
  metric('sync', JSON.stringify(s))
  metric('libro', await estadosSync(v.id))
  assert(reemplazo.syncStatus === 'pending' && s.deferred === 1 && s.synced === 0, 'el reemplazo se confirmó sin su original')
  assert((await db.payments.get(p.id))!.syncStatus === 'error', 'el original anómalo no quedó en error')
})

await spec('PAY-SYNC-023', 'carrera confirmación vs anulación: el resultado final es ANULADO', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000, { offline: true })
  const [, an] = await Promise.all([syncPendingItems({ tenantId: T }), rechazo(() => anularEnAdmin(p))])
  await syncPendingItems({ tenantId: T })
  metric('anulación', an)
  metric('libro', await estadosSync(v.id))
  assert(an === 'ACEPTADO' && (await db.payments.get(p.id))!.state === 'reversed', 'la confirmación pisó la anulación')
  assert((await pagosDe(v.id)).every(x => x.syncStatus === 'synced') && (await estado(v.id)).saldo === 1_200_000, 'no convergió')
})

await spec('PAY-SYNC-024', 'aislamiento de empresa', async () => {
  await empresa()
  const v = await credito()
  const vb = await credito(1_000_000, 20, RB, TB)
  await cobra(FABIO, v, 60_000, { offline: true })
  const pb = await cobra(AJENO_COB, vb, 60_000, { offline: true })
  const s = await syncPendingItems({ tenantId: T })
  const ajena = await rechazo(() => anularEnAdmin(pb))
  metric('sync ADEX', JSON.stringify(s))
  metric('pago ajeno', `${(await db.payments.get(pb.id))!.syncStatus} · anular desde ADEX: ${ajena.split(':')[1]?.trim()}`)
  assert(s.synced === 1 && (await db.payments.get(pb.id))!.syncStatus === 'pending', 'se confirmó un pago de otra empresa')
  assert(ajena !== 'ACEPTADO' && (await db.payments.get(pb.id))!.state === 'active', 'se anuló un pago de otra empresa')
})

await spec('PAY-SYNC-025', 'aislamiento de ruta', async () => {
  await empresa()
  const v1 = await credito()
  const v2 = await credito(1_000_000, 20, R2)
  const a = await cobra(FABIO, v1, 60_000, { offline: true })
  const b = await cobra(CARLOS, v2, 60_000, { offline: true })
  const s = await syncPendingItems({ tenantId: T, routeIds: [R1] })
  metric('sync Barreiro', `${JSON.stringify(s)} · Centro: ${(await db.payments.get(b.id))!.syncStatus}`)
  assert((await db.payments.get(a.id))!.syncStatus === 'synced' && (await db.payments.get(b.id))!.syncStatus === 'pending', 'el alcance de ruta no se respetó')
})

await spec('PAY-SYNC-026', 'registros antiguos sin campos nuevos: sincronizan y se anulan con el modelo nuevo', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000, { offline: true })
  const legado = { ...p } as Partial<Payment>
  delete legado.state
  delete legado.createdByUserId
  await db.payments.put(legado as Payment)
  // Corrección anterior a Ronda 7: original 'reversed' SIN `reversalPaymentId`.
  const q = await cobra(FABIO, v, 30_000)
  await db.payments.update(q.id, { state: 'reversed', correctedByPaymentId: 'x' })
  await db.payments.add({ ...q, id: 'rev-antigua', valor: -30_000, state: 'reversal', reversesPaymentId: q.id, syncStatus: 'pending' })
  await db.transaction('rw', [db.payments, db.installments, db.sales], () => recomputeSale(v.id))
  const anom = paymentLedgerAnomalies(await pagosDe(v.id))
  const s1 = await syncPendingItems({ tenantId: T })
  const { reversal } = await anularEnAdmin(p)
  metric('anomalías', anom.length)
  metric('sync legado', JSON.stringify(s1))
  assert(anom.length === 0 && s1.synced === 2, 'el legado se trató como error o no sincronizó')
  assert(reversal.syncStatus === 'synced' && (await db.payments.get(p.id))!.reversalPaymentId === reversal.id, 'la anulación del legado no usa el modelo nuevo')
})

await spec('PAY-SYNC-027', 'estados imposibles: detectados, visibles, confirmables tras reparar', async () => {
  await empresa()
  const v = await credito()
  const base = await cobra(FABIO, v, 10_000)
  const mk = (id: string, extra: Partial<Payment>): Payment => ({ ...base, id, createdAt: new Date().toISOString(), syncStatus: 'pending', ...extra })
  await db.payments.bulkAdd([
    mk('a-sin-rev', { state: 'reversed' }),                                              // anulado sin reversión
    mk('r-huerfana', { state: 'reversal', valor: -10_000, reversesPaymentId: 'no-existe' }), // reversión sin original
    mk('a-vigente', { state: 'active' }),
    mk('r-de-vigente', { state: 'reversal', valor: -10_000, reversesPaymentId: 'a-vigente' }), // ambos "activos"
    mk('r-sin-id', { state: 'reversal', valor: -10_000 }),                                   // sin reversesPaymentId
    mk('a-mal-link', { state: 'reversed', reversalPaymentId: 'otra' }),
    mk('r-mal-link', { state: 'reversal', valor: -10_000, reversesPaymentId: 'a-mal-link' }),
  ])
  const codes = new Set(paymentLedgerAnomalies(await pagosDe(v.id)).map(a => a.code))
  const s = await syncPendingItems({ tenantId: T })
  const visibles = pendingPaymentSyncCount(await pagosDe(v.id))
  metric('detectados', [...codes].join(', '))
  metric('sync', `${JSON.stringify(s)} · filas por confirmar ${visibles}`)
  for (const c of ['REVERSED_WITHOUT_REVERSAL', 'ORPHAN_REVERSAL', 'REVERSAL_OF_EFFECTIVE', 'BROKEN_REVERSAL_LINK']) assert(codes.has(c as never), `${c} no detectado`)
  assert(s.synced === 0 && s.errors === 7 && visibles > 0, 'una anomalía se confirmó o se ocultó')
  // Reparar los datos (la oficina decide) y reintentar: ahora sí se confirma.
  await db.payments.bulkDelete(['a-sin-rev', 'r-huerfana', 'r-de-vigente', 'r-sin-id', 'a-mal-link', 'r-mal-link'])
  const s2 = await syncPendingItems({ tenantId: T })
  assert(s2.synced === 1 && (await db.payments.get('a-vigente'))!.syncStatus === 'synced', 'tras reparar no se reintentó')
})

await spec('PAY-SYNC-028', 'multi-tab: la anulación en la pestaña Admin avisa a la del Cobrador sin F5', async () => {
  await empresa()
  const v = await credito()
  const p = await cobra(FABIO, v, 60_000)
  const señales: string[] = []
  const off = subscribeDataChanges(['payments'], t => señales.push([...t].sort().join('+')))
  await anularEnAdmin(p)
  await sleep(50)
  off()
  metric('señales en el Cobrador', señales.join(' | '))
  assert(señales.some(s => s.includes('payments') && s.includes('installments') && s.includes('sales')), 'la otra pestaña no recibió la señal')
  assert((await db.payments.get(p.id))!.state === 'reversed', 'la lectura del Cobrador sigue vieja')
})

await spec('PAY-SYNC-029', 'sin polling: la sincronización y el refresco no usan temporizadores periódicos', async () => {
  const archivos = ['src/services/syncService.ts', 'src/pages/collector/CollectorSyncPage.tsx', 'src/lib/dataRevision.ts', 'src/hooks/useDataRevision.ts', 'src/hooks/useOnlineStatus.ts']
  const conPolling = archivos.filter(f => /setInterval|requestAnimationFrame/.test(src(f)))
  metric('archivos revisados', archivos.length)
  assert(conPolling.length === 0, `polling en ${conPolling.join(', ')}`)
})

await spec('PAY-SYNC-030', 'convergencia determinista: mismos eventos en distinto orden → mismo estado', async () => {
  await empresa()
  const v = await credito()
  const P1a = await cobra(FABIO, v, 50_000)            // versión vieja (active) de P1
  const P2 = await cobra(FABIO, v, 30_000)
  const { original: P1f, reversal: R1 } = await anularEnAdmin(P1a)
  const esperado = firma(await estado(v.id))
  const baseEsperada = await getRouteBase(R1.routeId)
  const fabioEsperado = await posicion(FABIO)
  const ordenes: [string, Payment[]][] = [
    ['P1 → P2 → R1', [P1a, P2, P1f, R1]],
    ['P2 → P1 → R1', [P2, P1a, R1, P1f]],
    ['R1 → P1 → P2', [R1, P1f, P2]],
    ['R1 → P1(viejo) → P1 → P2', [R1, P1a, P1f, P2]],
    ['P1 → R1 → P2 → P1(viejo tardío)', [P1f, R1, P2, P1a]],
    ['P2 → R1 → P1(viejo) → P1', [P2, R1, P1a, P1f]],
  ]
  const finales = new Set<string>()
  for (const [nombre, eventos] of ordenes) {
    await copiaVacia(v.id)
    const res = []
    for (const e of eventos) res.push(await llega(e))
    await syncPendingItems({ tenantId: T })
    const f = firma(await estado(v.id))
    const libro = (await pagosDe(v.id)).map(p => `${p.id}:${p.state}:${p.syncStatus}`).sort().join(',')
    const b = await getRouteBase(R1.routeId)
    const fab = await posicion(FABIO)
    finales.add(`${f}#${libro}#${b}#${fab}`)
    metric(nombre, `${res.join(',')} → ${f === esperado && b === baseEsperada && fab === fabioEsperado ? 'idéntico' : 'DISTINTO'}`)
    assert(f === esperado && b === baseEsperada && fab === fabioEsperado, `${nombre}: no converge`)
  }
  assert(finales.size === 1, 'los órdenes producen estados distintos')
})

await spec('PAY-SYNC-SOCIO', 'caso del socio: 144.000/parcela 5 → +24.000 → anulado en otra pestaña → vuelve sin reset', async () => {
  await empresa()
  const v = await credito(200_000, 10)                                       // 240.000 en 10 × 24.000
  await cobra(FABIO, v, 96_000, { fecha: ayer })
  const e0 = await estado(v.id)
  const base0 = await getRouteBase(R1)
  const fabio0 = await posicion(FABIO)
  const p = await cobra(FABIO, v, 24_000, { offline: true })
  const e1 = await estado(v.id)
  const señales: string[] = []
  const off = subscribeDataChanges(['payments'], t => señales.push([...t].join('+')))
  await anularEnAdmin(p, 'Pago duplicado')
  await sleep(50)
  off()
  const e2 = await estado(v.id)
  const hoy = (await pagosDe(v.id)).filter(x => x.fecha === today())
  const pagadoHoyVigente = hoy.some(x => x.state !== 'reversed' && x.state !== 'reversal')
  const fila = paymentHistoryRows(await pagosDe(v.id)).find(r => r.payment.id === p.id)!
  const syncAntes = pendingPaymentSyncCount(await pagosDe(v.id))
  await syncPendingItems({ tenantId: T, routeIds: [R1] })
  metric('inicial', `saldo ${e0.saldo} · parcela ${e0.actual}`)
  metric('tras +24.000', `saldo ${e1.saldo} · parcela ${e1.actual}`)
  metric('tras anular (Cobrador, sin F5)', `saldo ${e2.saldo} · parcela ${e2.actual} · cuota 5 ${e2.insts[4].status} · señal ${señales.length > 0}`)
  metric('Base / Fabio', `${base0} / ${fabio0} → ${await getRouteBase(R1)} / ${await posicion(FABIO)}`)
  metric('histórico', `${paymentDisplayStateOf(fila.payment)} · motivo "${fila.payment.correctionReason}" · Abonar visible ${!pagadoHoyVigente}`)
  metric('sync', `${syncAntes} pendiente → ${await estadosSync(v.id)}`)
  assert(e0.saldo === 144_000 && e0.actual === 5 && e1.saldo === 120_000 && e1.actual === 6, 'escenario inicial incorrecto')
  assert(e2.saldo === 144_000 && e2.actual === 5 && e2.insts[4].status === 'pendiente', 'el Cobrador no volvió a 144.000 / parcela 5')
  assert(await getRouteBase(R1) === base0 && await posicion(FABIO) === fabio0, 'Base o efectivo no restaurados')
  assert(paymentDisplayStateOf(fila.payment) === 'anulado' && !pagadoHoyVigente && señales.length > 0, 'histórico o botón Abonar incorrectos')
  assert((await pagosDe(v.id)).every(x => x.syncStatus === 'synced'), 'no quedó confirmado')
})

// ============================================================
// Informe
// ============================================================
console.log('\n════════════════════════════════════════════════════════════════')
console.log('  RUTACASH · SINCRONIZACIÓN DE ANULACIONES (punto 8)')
console.log('════════════════════════════════════════════════════════════════')
for (const r of results) {
  console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id}  ${r.desc}`)
  for (const m of r.metrics) console.log(`          · ${m}`)
  if (r.error) console.log(`          ✗ ${r.error}`)
}
const fallidos = results.filter(r => !r.passed).length
console.log(`\n  ${results.length - fallidos}/${results.length} casos OK`)
if (fallidos > 0) process.exit(1)
