// ============================================================
// RUTACASH — SUITE DE LIQUIDACIONES PERSISTENTES (CIERRE DE PERIODO)
// ------------------------------------------------------------
//   npm run test:settlements
//
// Qué se verifica, y por qué importa:
//
// Hasta la Entrega 5 la liquidación semanal era SOLO un cálculo en pantalla. Nada
// se archivaba, así que ningún periodo estaba realmente cerrado y la protección de
// correcciones sobre periodos cerrados —que ya existía completa en
// `paymentCorrectionService`— nunca llegaba a activarse. Estas pruebas ejercitan el
// SERVICIO REAL (`closeSettlement` / `reopenSettlement`) contra el harness que
// replica el contrato de Dexie, y comprueban que:
//
//   · PERSIST  — cerrar archiva un documento con las cifras del motor financiero.
//   · CLOSE    — no se puede cerrar dos veces ni con rangos solapados o inválidos.
//   · REOPEN   — reabrir exige motivo, lo conserva y no borra el documento.
//   · CORRECTION — la protección de pagos se enciende al cerrar y se apaga al reabrir,
//                  usando la FECHA CONTABLE del pago.
//   · SNAPSHOT — la Oficina queda congelada en el cierre y no cambia si la ruta se mueve.
//   · HISTORY  — cerrar → reabrir → recerrar produce versiones trazables.
//   · SCOPE    — el alcance sigue naciendo de `authorizedRouteIds`, no de la Oficina.
//
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import { MemoryDb } from './financial/harness'
import {
  closeSettlement,
  reopenSettlement,
  listSettlementsForUser,
  MIN_REOPEN_REASON,
  type SettlementDatabase,
  type SettlementAuditSink,
} from '@/services/settlementService'
import { isPaymentInClosedPeriod } from '@/services/paymentCorrectionService'
import {
  closureBlockedReason,
  closedSettlementCsvRow,
  officeSnapshotOf,
  pendingSettlements,
  periodBadge,
  protectingClosureFor,
  settlementHistory,
  settlementStatus,
} from '@/lib/settlementPeriods'
import { can } from '@/lib/permissions'
import type { Payment, User } from '@/models/types'

// ============================================================
// Mini-runner (mismo formato que las otras suites)
// ============================================================
interface Result { id: string; group: string; desc: string; passed: boolean; error?: string; metrics: string[] }
const results: Result[] = []
let current: string[] = []

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg) }
function metric(label: string, value: unknown) { current.push(`${label}: ${String(value)}`) }

async function spec(id: string, group: string, desc: string, fn: () => Promise<void> | void) {
  current = []
  let passed = true
  let error: string | undefined
  try { await fn() } catch (e) { passed = false; error = e instanceof Error ? e.message : String(e) }
  results.push({ id, group, desc, passed, error, metrics: [...current] })
}

// ============================================================
// Escenario
// ============================================================
const TENANT = 't-1'
const R_NORTE = 'r-norte'
const R_SUR = 'r-sur'
const R_SOLA = 'r-sola'          // ruta Sin Oficina
const OF_CENTRO = 'of-centro'
const OF_RIO = 'of-rio'

const L1 = '2026-09-07'   // lunes
const S1 = '2026-09-12'   // sábado
const L2 = '2026-09-14'
const S2 = '2026-09-19'

const admin: User = {
  id: 'u-admin', tenantId: TENANT, nombre: 'Admin', email: 'a@c.com', rol: 'admin',
  status: 'activo', authorizedRouteIds: [R_NORTE, R_SOLA], createdAt: L1,
} as never

const adminAjeno: User = {
  id: 'u-admin2', tenantId: TENANT, nombre: 'Admin Sur', email: 'b@c.com', rol: 'admin',
  status: 'activo', authorizedRouteIds: [R_SUR], createdAt: L1,
} as never

const secretario: User = {
  id: 'u-sec', tenantId: TENANT, nombre: 'Secre', email: 's@c.com', rol: 'secretario',
  status: 'activo', authorizedRouteIds: [R_NORTE], createdAt: L1,
} as never

const cobrador: User = {
  id: 'u-cob', tenantId: TENANT, nombre: 'Cobra', email: 'c@c.com', rol: 'cobrador',
  status: 'activo', authorizedRouteIds: [R_NORTE], createdAt: L1,
} as never

/** Base con dos Oficinas, tres rutas y un cobro de 50.000 dentro de la semana 1. */
function nuevaBase(): { db: SettlementDatabase; audit: Array<Record<string, unknown>> } {
  const mem = new MemoryDb()
  mem.offices._seed([
    { id: OF_CENTRO, tenantId: TENANT, nombre: 'Oficina Centro', codigo: 'CEN', status: 'activa' },
    { id: OF_RIO, tenantId: TENANT, nombre: 'Oficina Río', codigo: 'RIO', status: 'activa' },
  ])
  mem.routes._seed([
    { id: R_NORTE, tenantId: TENANT, officeId: OF_CENTRO, nombre: 'Ruta Norte', codigo: 'RN', status: 'activa' },
    { id: R_SUR, tenantId: TENANT, officeId: OF_RIO, nombre: 'Ruta Sur', codigo: 'RS', status: 'activa' },
    { id: R_SOLA, tenantId: TENANT, nombre: 'Ruta Sola', codigo: 'SO', status: 'activa' },
  ])
  mem.payments._seed([
    { id: 'p-1', tenantId: TENANT, routeId: R_NORTE, saleId: 's-1', clientId: 'c-1', valor: 50000, fecha: '2026-09-09', createdAt: '2026-09-09' },
  ])
  const audit: Array<Record<string, unknown>> = []
  const sink = async (p: Record<string, unknown>) => { audit.push(p) }
  return { db: mem as unknown as SettlementDatabase, audit, sink } as never
}

// El sumidero se tipa con el contrato REAL del servicio. Antes era `(p: never)`, que
// hacía que TypeScript rechazara pasarlo a `closeSettlement` (el parámetro nunca
// podía satisfacerse). La suite pasaba porque esbuild borra los tipos, pero
// `tsc -p tests` lo denunciaba con razón.
type Escenario = { db: SettlementDatabase; audit: Array<Record<string, unknown>>; sink: SettlementAuditSink }

// ============================================================
// SETTLEMENT-PERSIST — la liquidación deja de ser solo un cálculo
// ============================================================
await spec('SETTLEMENT-PERSIST-001', 'Persistencia', 'cerrar ARCHIVA el documento con las cifras del motor financiero', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const doc = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)

  const guardadas = await db.weeklySettlements.where('routeId').equals(R_NORTE).toArray()
  metric('documentos archivados', guardadas.length)
  metric('cobros archivados', doc.cobros)
  assert(guardadas.length === 1, 'el cierre debe dejar exactamente un documento archivado')
  // El importe lo produjo el motor de caja leyendo el pago sembrado: la pantalla
  // no entrega cifras al servicio.
  assert(doc.cobros === 50000, `los cobros archivados deben venir del motor (esperado 50000, fue ${doc.cobros})`)
  assert(guardadas[0].cobros === 50000, 'lo archivado debe coincidir con lo devuelto')
})

await spec('SETTLEMENT-PERSIST-002', 'Persistencia', 'el documento nace CERRADO, con autor, fecha y versión 1', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const doc = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  metric('estado', settlementStatus(doc))
  metric('versión', doc.version)
  assert(settlementStatus(doc) === 'cerrada', 'un cierre nace en estado cerrada')
  assert(doc.version === 1, 'el primer cierre de un periodo es la versión 1')
  assert(doc.closedByUserId === admin.id, 'debe quedar registrado quién cerró')
  assert(Boolean(doc.closedAt), 'debe quedar registrado cuándo se cerró')
})

await spec('SETTLEMENT-PERSIST-003', 'Persistencia', 'el cierre queda en auditoría con ruta, periodo y oficina', async () => {
  const { db, audit, sink } = nuevaBase() as Escenario
  await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  const evento = audit.find(a => a.action === 'SETTLEMENT_CLOSED')
  metric('eventos de auditoría', audit.length)
  assert(Boolean(evento), 'cerrar debe dejar un evento SETTLEMENT_CLOSED')
  assert(evento!.routeId === R_NORTE, 'el evento debe nombrar la ruta cerrada')
  assert(String(evento!.descripcion).includes('Oficina Centro'), 'el evento debe nombrar la Oficina del cierre')
})

// ============================================================
// SETTLEMENT-CLOSE — validaciones del cierre
// ============================================================
await spec('SETTLEMENT-CLOSE-001', 'Cierre', 'no se puede cerrar dos veces la misma semana sin reabrir', async () => {
  const { db, sink } = nuevaBase() as Escenario
  await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  let error = ''
  try {
    await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  metric('mensaje', error)
  assert(error.includes('ya está cerrada'), 'el segundo cierre debe rechazarse pidiendo reabrir primero')
  const guardadas = await db.weeklySettlements.where('routeId').equals(R_NORTE).toArray()
  assert(guardadas.length === 1, 'un cierre rechazado no debe dejar documento')
})

await spec('SETTLEMENT-CLOSE-002', 'Cierre', 'se rechaza un rango que SOLAPA una semana ya cerrada', async () => {
  const { db, sink } = nuevaBase() as Escenario
  await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  let error = ''
  try {
    // Empieza dentro de la semana ya cerrada: dos cierres vigentes protegerían los
    // mismos días con cifras distintas.
    await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: '2026-09-10', semanaFin: '2026-09-16' }, db, sink)
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  metric('mensaje', error)
  assert(error.includes('solapa'), 'un rango solapado debe rechazarse explícitamente')
})

await spec('SETTLEMENT-CLOSE-003', 'Cierre', 'se rechaza un rango invertido', async () => {
  const { db, sink } = nuevaBase() as Escenario
  let error = ''
  try {
    await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: S1, semanaFin: L1 }, db, sink)
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  metric('mensaje', error)
  assert(error.includes('anterior'), 'fin < inicio debe rechazarse')
})

await spec('SETTLEMENT-CLOSE-004', 'Cierre', 'cerrar una semana de OTRA ruta no afecta a la primera', async () => {
  const { db, sink } = nuevaBase() as Escenario
  await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_SOLA, semanaInicio: L1, semanaFin: S1 }, db, sink)
  const norte = await db.weeklySettlements.where('routeId').equals(R_NORTE).toArray()
  const sola = await db.weeklySettlements.where('routeId').equals(R_SOLA).toArray()
  metric('documentos Norte', norte.length)
  metric('documentos Sola', sola.length)
  assert(norte.length === 1 && sola.length === 1, 'cada ruta cierra su propia semana, sin interferencias')
})

await spec('SETTLEMENT-CLOSE-005', 'Cierre', 'una ruta inexistente no se puede cerrar', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const fantasma: User = { ...admin, authorizedRouteIds: ['r-fantasma'] } as never
  let error = ''
  try {
    await closeSettlement({ actor: fantasma, tenantId: TENANT, routeId: 'r-fantasma', semanaInicio: L1, semanaFin: S1 }, db, sink)
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  metric('mensaje', error)
  assert(error.includes('no existe'), 'una ruta inexistente debe rechazarse')
})

// ============================================================
// SETTLEMENT-REOPEN — reapertura controlada
// ============================================================
await spec('SETTLEMENT-REOPEN-001', 'Reapertura', 'reabrir SIN motivo se rechaza', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const doc = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  let error = ''
  try {
    await reopenSettlement({ actor: admin, settlementId: doc.id, motivo: '   ' }, db, sink)
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  metric('mensaje', error)
  metric('mínimo exigido', MIN_REOPEN_REASON)
  assert(error.includes('motivo'), 'sin motivo no se reabre')
  const vigente = await db.weeklySettlements.get(doc.id)
  assert(settlementStatus(vigente!) === 'cerrada', 'una reapertura rechazada deja el cierre intacto')
})

await spec('SETTLEMENT-REOPEN-002', 'Reapertura', 'reabrir CON motivo lo conserva de forma permanente', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const doc = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  await reopenSettlement({ actor: admin, settlementId: doc.id, motivo: 'Pago del jueves mal registrado' }, db, sink)
  const vigente = await db.weeklySettlements.get(doc.id)
  metric('estado', settlementStatus(vigente!))
  metric('motivo', vigente!.reopenReason)
  assert(settlementStatus(vigente!) === 'reabierta', 'el documento pasa a reabierta')
  assert(vigente!.reopenReason === 'Pago del jueves mal registrado', 'el motivo se guarda literal')
  assert(vigente!.reopenedByUserId === admin.id, 'queda registrado quién reabrió')
})

await spec('SETTLEMENT-REOPEN-003', 'Reapertura', 'reabrir NO borra el documento ni sus cifras', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const doc = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  await reopenSettlement({ actor: admin, settlementId: doc.id, motivo: 'Corrección de un cobro mal digitado' }, db, sink)
  const guardadas = await db.weeklySettlements.where('routeId').equals(R_NORTE).toArray()
  metric('documentos tras reabrir', guardadas.length)
  metric('cobros conservados', guardadas[0].cobros)
  assert(guardadas.length === 1, 'reabrir conserva el documento, no lo elimina')
  assert(guardadas[0].cobros === doc.cobros, 'las cifras del cierre reabierto no se alteran')
})

await spec('SETTLEMENT-REOPEN-004', 'Reapertura', 'no se reabre dos veces el mismo documento', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const doc = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  await reopenSettlement({ actor: admin, settlementId: doc.id, motivo: 'Motivo suficientemente explicado' }, db, sink)
  let error = ''
  try {
    await reopenSettlement({ actor: admin, settlementId: doc.id, motivo: 'Otro motivo bien explicado' }, db, sink)
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  metric('mensaje', error)
  assert(error.includes('ya está reabierta'), 'una reapertura repetida debe rechazarse')
})

await spec('SETTLEMENT-REOPEN-005', 'Reapertura', 'la reapertura queda en auditoría con su motivo', async () => {
  const { db, audit, sink } = nuevaBase() as Escenario
  const doc = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  await reopenSettlement({ actor: admin, settlementId: doc.id, motivo: 'Se corrige un cobro duplicado' }, db, sink)
  const evento = audit.find(a => a.action === 'SETTLEMENT_REOPENED')
  metric('motivo en auditoría', evento?.motivo)
  assert(Boolean(evento), 'reabrir debe dejar un evento SETTLEMENT_REOPENED')
  assert(evento!.motivo === 'Se corrige un cobro duplicado', 'el motivo viaja a la auditoría')
})

// ============================================================
// SETTLEMENT-CORRECTION — la protección se enciende de verdad
// ============================================================
await spec('SETTLEMENT-CORRECTION-001', 'Corrección', 'SIN cierre, ningún pago está en periodo cerrado', async () => {
  const { db } = nuevaBase() as Escenario
  const pago = { id: 'p-1', routeId: R_NORTE, fecha: '2026-09-09' } as Payment
  const cerrado = await isPaymentInClosedPeriod(pago, db)
  metric('en periodo cerrado', cerrado)
  // Esta era la situación real antes de la Entrega 5: la protección existía pero
  // nunca se activaba porque no había documentos archivados.
  assert(cerrado === false, 'sin liquidaciones archivadas no hay periodo cerrado')
})

await spec('SETTLEMENT-CORRECTION-002', 'Corrección', 'al CERRAR, el pago de esa semana queda protegido', async () => {
  const { db, sink } = nuevaBase() as Escenario
  await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  const pago = { id: 'p-1', routeId: R_NORTE, fecha: '2026-09-09' } as Payment
  const cerrado = await isPaymentInClosedPeriod(pago, db)
  metric('en periodo cerrado', cerrado)
  assert(cerrado === true, 'tras el cierre, el pago de esa semana está protegido')
})

await spec('SETTLEMENT-CORRECTION-003', 'Corrección', 'se usa la FECHA CONTABLE del pago, no la de registro', async () => {
  const { db, sink } = nuevaBase() as Escenario
  await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  // Cobrado el miércoles de la semana cerrada, pero digitado dos semanas después.
  const tardio = { id: 'p-tardio', routeId: R_NORTE, fecha: '2026-09-09', createdAt: '2026-09-25' } as Payment
  const cerrado = await isPaymentInClosedPeriod(tardio, db)
  metric('fecha contable', tardio.fecha)
  metric('registrado el', tardio.createdAt)
  metric('en periodo cerrado', cerrado)
  assert(cerrado === true, 'el dinero pertenece a la semana en que se cobró, no a la de digitación')
})

await spec('SETTLEMENT-CORRECTION-004', 'Corrección', 'al REABRIR, el pago vuelve a ser corregible', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const doc = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  const pago = { id: 'p-1', routeId: R_NORTE, fecha: '2026-09-09' } as Payment
  assert(await isPaymentInClosedPeriod(pago, db), 'precondición: protegido tras cerrar')
  await reopenSettlement({ actor: admin, settlementId: doc.id, motivo: 'Hay que corregir ese cobro' }, db, sink)
  const cerrado = await isPaymentInClosedPeriod(pago, db)
  metric('tras reabrir, en periodo cerrado', cerrado)
  assert(cerrado === false, 'un periodo reabierto deja de proteger: ese es el objetivo de reabrir')
})

await spec('SETTLEMENT-CORRECTION-005', 'Corrección', 'el cierre de una ruta NO protege pagos de otra', async () => {
  const { db, sink } = nuevaBase() as Escenario
  await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  const ajeno = { id: 'p-sur', routeId: R_SUR, fecha: '2026-09-09' } as Payment
  const cerrado = await isPaymentInClosedPeriod(ajeno, db)
  metric('pago de Ruta Sur protegido', cerrado)
  assert(cerrado === false, 'cada ruta cierra su propia caja: el cierre no se contagia')
})

await spec('SETTLEMENT-CORRECTION-006', 'Corrección', 'en periodo cerrado el Secretario pierde la corrección directa', () => {
  // La regla ya vivía en `can()`; lo que faltaba era que `periodClosed` pudiera ser
  // verdadero alguna vez. Aquí se comprueban las dos caras.
  const abierto = can(secretario, 'payment.correct', { routeId: R_NORTE, tenantId: TENANT, periodClosed: false })
  const cerrado = can(secretario, 'payment.correct', { routeId: R_NORTE, tenantId: TENANT, periodClosed: true })
  const adminCerrado = can(admin, 'payment.correct', { routeId: R_NORTE, tenantId: TENANT, periodClosed: true })
  metric('secretario, periodo abierto', abierto)
  metric('secretario, periodo cerrado', cerrado)
  metric('admin, periodo cerrado', adminCerrado)
  assert(abierto === true, 'en periodo abierto el Secretario corrige directamente')
  assert(cerrado === false, 'en periodo cerrado debe pasar por Solicitud de ajuste')
  assert(adminCerrado === true, 'el Administrador sí puede corregir en periodo cerrado (aprueba ajustes)')
})

// ============================================================
// SETTLEMENT-SNAPSHOT — Oficina histórica
// ============================================================
await spec('SETTLEMENT-SNAPSHOT-001', 'Snapshot', 'el cierre congela nombre y código de la Oficina', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const doc = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  metric('oficina al cierre', doc.officeNameAtClose)
  metric('código al cierre', doc.officeCodeAtClose)
  assert(doc.officeIdAtClose === OF_CENTRO, 'se guarda la Oficina del momento')
  assert(doc.officeNameAtClose === 'Oficina Centro', 'se guarda el NOMBRE del momento')
  assert(doc.officeCodeAtClose === 'CEN', 'se guarda el código del momento')
})

await spec('SETTLEMENT-SNAPSHOT-002', 'Snapshot', 'mover la ruta de Oficina NO reescribe el cierre pasado', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const doc = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  // La ruta se reorganiza a otra Oficina DESPUÉS del cierre.
  await (db as never as MemoryDb).routes.update(R_NORTE, { officeId: OF_RIO })
  const archivado = await db.weeklySettlements.get(doc.id)
  const rutaHoy = await db.routes.get(R_NORTE)
  metric('oficina actual de la ruta', rutaHoy!.officeId)
  metric('oficina en el cierre', archivado!.officeNameAtClose)
  assert(rutaHoy!.officeId === OF_RIO, 'precondición: la ruta se movió')
  assert(archivado!.officeNameAtClose === 'Oficina Centro', 'la semana cerrada sigue diciendo dónde se cerró')
})

await spec('SETTLEMENT-SNAPSHOT-003', 'Snapshot', 'una ruta SIN Oficina se archiva como "Sin Oficina", sin inventar ninguna', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const doc = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_SOLA, semanaInicio: L1, semanaFin: S1 }, db, sink)
  metric('officeIdAtClose', String(doc.officeIdAtClose))
  metric('officeNameAtClose', doc.officeNameAtClose)
  assert(doc.officeIdAtClose === undefined, 'no se inventa un id de Oficina')
  assert(doc.officeNameAtClose === 'Sin Oficina', 'se rotula honestamente como Sin Oficina')
})

await spec('SETTLEMENT-SNAPSHOT-004', 'Snapshot', 'una Oficina borrada del catálogo no se disfraza de "Sin Oficina"', () => {
  const snap = officeSnapshotOf({ officeId: 'of-borrada' }, [])
  metric('id conservado', snap.officeIdAtClose)
  metric('etiqueta', snap.officeNameAtClose)
  assert(snap.officeIdAtClose === 'of-borrada', 'se conserva el rastro del id')
  assert(snap.officeNameAtClose === 'Oficina eliminada', 'se distingue de una ruta que nunca tuvo Oficina')
})

await spec('SETTLEMENT-SNAPSHOT-005', 'Snapshot', 'el CSV del cierre sale del documento archivado, no de un recálculo', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const doc = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  // Llega un cobro NUEVO con fecha dentro de la semana ya cerrada.
  await (db as never as MemoryDb).payments.add({
    id: 'p-tardio', tenantId: TENANT, routeId: R_NORTE, saleId: 's-1', clientId: 'c-1',
    valor: 99000, fecha: '2026-09-10', createdAt: '2026-09-25',
  } as never)
  const archivado = await db.weeklySettlements.get(doc.id)
  const fila = closedSettlementCsvRow(archivado!, 'Ruta Norte', 'RN')
  metric('cobros en el CSV', fila.Cobros)
  metric('oficina en el CSV', fila['Oficina (al cierre)'])
  assert(fila.Cobros === 50000, 'el CSV conserva la cifra cerrada; un cobro posterior no la altera')
  assert(fila['Oficina (al cierre)'] === 'Oficina Centro', 'la Oficina del CSV es la del snapshot')
})

// ============================================================
// SETTLEMENT-HISTORY — versionado y trazabilidad
// ============================================================
await spec('SETTLEMENT-HISTORY-001', 'Historial', 'cerrar → reabrir → recerrar produce v1 y v2, ambas conservadas', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const v1 = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  await reopenSettlement({ actor: admin, settlementId: v1.id, motivo: 'Faltaba registrar un cobro' }, db, sink)
  const v2 = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  const todas = await db.weeklySettlements.where('routeId').equals(R_NORTE).toArray()
  metric('documentos del periodo', todas.length)
  metric('versiones', todas.map(t => t.version).sort().join(','))
  assert(todas.length === 2, 'el cierre anterior se conserva; no se sobrescribe')
  assert(v2.version === 2, 'el recierre es la versión 2')
})

await spec('SETTLEMENT-HISTORY-002', 'Historial', 'la versión anterior queda ENLAZADA a la que la sustituye', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const v1 = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  await reopenSettlement({ actor: admin, settlementId: v1.id, motivo: 'Corrección acordada con el socio' }, db, sink)
  const v2 = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  const anterior = await db.weeklySettlements.get(v1.id)
  metric('supersededBy', anterior!.supersededBy)
  assert(anterior!.supersededBy === v2.id, 'cerrar → reabrir → recerrar queda trazable en ambos sentidos')
  assert(anterior!.reopenReason === 'Corrección acordada con el socio', 'el motivo de la reapertura sobrevive al recierre')
})

await spec('SETTLEMENT-HISTORY-003', 'Historial', 'el historial ordena por semana y por versión descendente', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const v1 = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  await reopenSettlement({ actor: admin, settlementId: v1.id, motivo: 'Ajuste de un cobro mal digitado' }, db, sink)
  await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L2, semanaFin: S2 }, db, sink)

  const todas = await db.weeklySettlements.where('routeId').equals(R_NORTE).toArray()
  const routes = await db.routes.where('tenantId').equals(TENANT).toArray()
  const filas = settlementHistory(todas, routes)
  metric('orden', filas.map(f => `${f.settlement.semanaInicio}v${f.version}`).join(' | '))
  assert(filas[0].settlement.semanaInicio === L2, 'la semana más reciente va primero')
  assert(filas[1].version === 2 && filas[2].version === 1, 'dentro de la semana, la versión más alta va primero')
  assert(filas[2].superseded === true, 'la versión sustituida se marca como tal')
})

await spec('SETTLEMENT-HISTORY-004', 'Historial', 'no se puede reabrir una versión ya sustituida', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const v1 = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  await reopenSettlement({ actor: admin, settlementId: v1.id, motivo: 'Primera corrección necesaria' }, db, sink)
  await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  let error = ''
  try {
    await reopenSettlement({ actor: admin, settlementId: v1.id, motivo: 'Intento sobre una versión vieja' }, db, sink)
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  metric('mensaje', error)
  assert(error.length > 0, 'reabrir una versión sustituida debe rechazarse')
})

await spec('SETTLEMENT-HISTORY-005', 'Historial', 'los distintivos de estado nombran el periodo correctamente', () => {
  metric('cerrada', periodBadge({ status: 'cerrada' }).label)
  metric('reabierta', periodBadge({ status: 'reabierta' }).label)
  metric('heredada (sin status)', periodBadge({}).label)
  assert(periodBadge({ status: 'cerrada' }).label === 'Período cerrado', 'distintivo de cierre')
  assert(periodBadge({ status: 'reabierta' }).label === 'Período reabierto', 'distintivo de reapertura')
  // Compatibilidad: una liquidación anterior a v12 ya representaba una semana cerrada.
  assert(periodBadge({}).label === 'Período cerrado', 'un documento heredado se lee como cerrado')
})

// ============================================================
// SETTLEMENT-SCOPE — el acceso sigue naciendo de las rutas
// ============================================================
await spec('SETTLEMENT-SCOPE-001', 'Alcance', 'cerrar una ruta NO autorizada se rechaza aunque el rol lo permita', async () => {
  const { db, sink } = nuevaBase() as Escenario
  let error = ''
  try {
    // `adminAjeno` es Administrador, pero Ruta Norte no está en sus rutas.
    await closeSettlement({ actor: adminAjeno, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  metric('mensaje', error)
  assert(error.includes('settlement.close'), 'el rechazo debe venir de la capacidad con ruta')
  const guardadas = await db.weeklySettlements.where('routeId').equals(R_NORTE).toArray()
  assert(guardadas.length === 0, 'no debe quedar ningún documento')
})

await spec('SETTLEMENT-SCOPE-002', 'Alcance', 'tener una ruta de la Oficina NO habilita cerrar sus rutas hermanas', () => {
  // Ruta Norte y Ruta Sur están en Oficinas distintas; lo que se comprueba es la
  // regla general: la Oficina nunca amplía el alcance.
  const propia = can(admin, 'settlement.close', { routeId: R_NORTE, tenantId: TENANT })
  const hermana = can(admin, 'settlement.close', { routeId: R_SUR, tenantId: TENANT })
  metric('ruta autorizada', propia)
  metric('ruta de otra oficina', hermana)
  assert(propia === true, 'sobre su ruta autorizada sí puede cerrar')
  assert(hermana === false, 'sobre una ruta no autorizada no, venga de donde venga')
})

await spec('SETTLEMENT-SCOPE-003', 'Alcance', 'Cobrador y Secretario no pueden cerrar ni reabrir', () => {
  const casos = [
    ['cobrador cerrar', can(cobrador, 'settlement.close', { routeId: R_NORTE, tenantId: TENANT })],
    ['cobrador reabrir', can(cobrador, 'settlement.reopen', { routeId: R_NORTE, tenantId: TENANT })],
    ['secretario cerrar', can(secretario, 'settlement.close', { routeId: R_NORTE, tenantId: TENANT })],
    ['secretario reabrir', can(secretario, 'settlement.reopen', { routeId: R_NORTE, tenantId: TENANT })],
  ] as const
  for (const [etiqueta, valor] of casos) metric(etiqueta, valor)
  assert(casos.every(([, v]) => v === false), 'cerrar el periodo es una decisión de gestión, no de operación diaria')
})

await spec('SETTLEMENT-SCOPE-004', 'Alcance', 'el listado solo devuelve liquidaciones de rutas autorizadas', async () => {
  const { db, sink } = nuevaBase() as Escenario
  await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  await closeSettlement({ actor: adminAjeno, tenantId: TENANT, routeId: R_SUR, semanaInicio: L1, semanaFin: S1 }, db, sink)

  const mias = await listSettlementsForUser(admin, TENANT, db)
  metric('rutas visibles', mias.routes.map(r => r.nombre).join(', '))
  metric('liquidaciones visibles', mias.settlements.length)
  assert(mias.settlements.length === 1, 'solo la de su ruta autorizada')
  assert(mias.settlements[0].routeId === R_NORTE, 'y es exactamente la suya')
})

await spec('SETTLEMENT-SCOPE-005', 'Alcance', 'un usuario sin rutas autorizadas no ve ninguna liquidación', async () => {
  const { db, sink } = nuevaBase() as Escenario
  await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  const huerfano: User = { ...admin, id: 'u-x', authorizedRouteIds: [] } as never
  const r = await listSettlementsForUser(huerfano, TENANT, db)
  metric('liquidaciones visibles', r.settlements.length)
  assert(r.settlements.length === 0, 'fail-closed: sin rutas, sin datos')
})

// ============================================================
// SETTLEMENT-PENDING — indicador de semanas sin cerrar
// ============================================================
await spec('SETTLEMENT-PENDING-001', 'Pendientes', 'una ruta sin cierre de la semana aparece como pendiente', async () => {
  const { db, sink } = nuevaBase() as Escenario
  await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  const routes = (await db.routes.where('tenantId').equals(TENANT).toArray()).filter(r => admin.authorizedRouteIds!.includes(r.id))
  const settlements = await db.weeklySettlements.where('tenantId').equals(TENANT).toArray()
  const filas = pendingSettlements(routes, settlements, L1, S1, id => (id === R_SOLA ? 'Sin Oficina' : 'Oficina Centro'))
  metric('pendientes', filas.map(f => `${f.routeName} (${f.officeLabel})`).join(', '))
  assert(filas.length === 1 && filas[0].routeId === R_SOLA, 'solo la ruta sin cerrar figura como pendiente')
})

await spec('SETTLEMENT-PENDING-002', 'Pendientes', 'una semana REABIERTA vuelve a contar como pendiente', async () => {
  const { db, sink } = nuevaBase() as Escenario
  const doc = await closeSettlement({ actor: admin, tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1 }, db, sink)
  await reopenSettlement({ actor: admin, settlementId: doc.id, motivo: 'Se detectó un cobro sin registrar' }, db, sink)
  const routes = (await db.routes.where('tenantId').equals(TENANT).toArray()).filter(r => r.id === R_NORTE)
  const settlements = await db.weeklySettlements.where('tenantId').equals(TENANT).toArray()
  const filas = pendingSettlements(routes, settlements, L1, S1, () => 'Oficina Centro')
  metric('pendientes', filas.length)
  assert(filas.length === 1, 'reabrir deja la semana sin cierre vigente, luego vuelve a estar pendiente')
})

// ============================================================
// SETTLEMENT-PURE — contratos del módulo puro
// ============================================================
await spec('SETTLEMENT-PURE-001', 'Módulo puro', 'settlementPeriods no importa la base de datos', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync('src/lib/settlementPeriods.ts', 'utf8')
  const importaDb = /from\s+['"]@\/lib\/db['"]/.test(src)
  metric('importa @/lib/db', importaDb)
  assert(!importaDb, 'la lógica de periodos debe poder probarse sin IndexedDB')
})

await spec('SETTLEMENT-PURE-002', 'Módulo puro', 'existe UNA sola definición de "cierre que protege"', async () => {
  const fs = await import('node:fs')
  const correccion = fs.readFileSync('src/services/paymentCorrectionService.ts', 'utf8')
  const usaHelper = correccion.includes('protectingClosureFor')
  // Se comprueba que la condición no esté RE-ESCRITA a mano fuera del módulo puro.
  const sinComentarios = correccion.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const duplicada = /status\s*\?\?\s*'cerrada'/.test(sinComentarios)
  metric('usa protectingClosureFor', usaHelper)
  metric('condición duplicada a mano', duplicada)
  assert(usaHelper, 'la corrección debe apoyarse en el módulo puro')
  assert(!duplicada, 'la regla de periodo cerrado no debe reescribirse en dos sitios')
})

await spec('SETTLEMENT-PURE-003', 'Módulo puro', 'protectingClosureFor ignora los cierres reabiertos', () => {
  const base = {
    tenantId: TENANT, routeId: R_NORTE, semanaInicio: L1, semanaFin: S1,
    saldoAnterior: 0, ingresoCapital: 0, cobros: 0, prestamosEntregados: 0, gastos: 0,
    transferenciasEntradas: 0, transferenciasSalidas: 0, retiros: 0, saldoFinal: 0, createdAt: L1,
  }
  const cerrada = { ...base, id: 'w1', status: 'cerrada' as const }
  const reabierta = { ...base, id: 'w2', status: 'reabierta' as const }
  metric('con cierre vigente', protectingClosureFor([cerrada], R_NORTE, '2026-09-09')?.id)
  metric('solo con reabierta', String(protectingClosureFor([reabierta], R_NORTE, '2026-09-09')))
  assert(protectingClosureFor([cerrada], R_NORTE, '2026-09-09')?.id === 'w1', 'un cierre vigente protege')
  assert(protectingClosureFor([reabierta], R_NORTE, '2026-09-09') === null, 'un cierre reabierto no protege')
})

await spec('SETTLEMENT-PURE-004', 'Módulo puro', 'el bloqueo de cierre explica el motivo en lenguaje llano', () => {
  const vacio = closureBlockedReason([], R_NORTE, '', '')
  const invertido = closureBlockedReason([], R_NORTE, S1, L1)
  metric('sin fechas', vacio)
  metric('invertido', invertido)
  assert(vacio !== null && vacio.includes('inicio'), 'sin fechas se explica qué falta')
  assert(invertido !== null && invertido.includes('anterior'), 'con el rango invertido se explica el error')
})

// ============================================================
// Informe
// ============================================================
const ancho = 96
const linea = '═'.repeat(ancho)
console.log(`\n${linea}\n  RUTACASH — SUITE DE LIQUIDACIONES PERSISTENTES\n${linea}\n`)

let grupoActual = ''
for (const r of results) {
  if (r.group !== grupoActual) {
    grupoActual = r.group
    console.log(`\n── ${grupoActual} ${'─'.repeat(Math.max(0, ancho - grupoActual.length - 4))}`)
  }
  console.log(`[ ${r.passed ? 'PASS' : 'FAIL'} ] ${r.id.padEnd(28)} ${r.desc}`)
  for (const m of r.metrics) console.log(`           · ${m}`)
  if (!r.passed) console.log(`           ✗ ${r.error}`)
}

const ok = results.filter(r => r.passed).length
const fail = results.length - ok
console.log(`\n${linea}\n  TOTAL: ${results.length} casos   ${ok} PASS   ${fail} FAIL\n${linea}\n`)

if (fail > 0) {
  console.log('CASOS FALLIDOS:')
  for (const r of results.filter(x => !x.passed)) console.log(`  · ${r.id} — ${r.desc}\n    ${r.error}`)
  console.log('\nSUITE DE LIQUIDACIONES: FALLÓ')
  process.exit(1)
}
console.log('SUITE DE LIQUIDACIONES: TODOS LOS CASOS PASAN')
