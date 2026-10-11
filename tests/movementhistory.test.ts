// ============================================================
// ADEX — SUITE HISTORIAL UNIFICADO + CAJA SOCIOS (Ronda 5/6, DEXIE REAL)
// ------------------------------------------------------------
//   npm run test:movementhistory
//
// Historial: proyección de registros reales (sin segundo libro), una entrada por
// operación (las patas enlazadas van dentro), identidad `fuente:id`, filtros,
// anulaciones/reintegros enlazados, alcance por rol en el SERVICIO y comprobante.
// Caja socios: corrección conservadora (permisos y saldo en el servicio).
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import { verifyCapitalInvariants } from '../src/lib/capitalAllocation'
import type { HistoryEntry } from '../src/lib/movementHistory'
import { allocateCapitalToAdmin, loadCapitalRows, registerCompanyCapital } from '../src/services/capitalControlService'
import { registerCapital, registerTransfer, registerWithdrawal } from '../src/services/routeFundsService'
import { assignBaseToWorker, returnBaseFromWorker, transferBaseBetweenWorkers } from '../src/services/cashCustodyService'
import { createExpense, refundAdminExpense, reverseAdminExpense } from '../src/services/expenseService'
import { reverseCapitalMovement, reverseTransfer } from '../src/services/movementReversalService'
import { createPartnerMovement, partnerBalance } from '../src/services/partnerCashService'
import { getMovementEntry, listMovementHistory } from '../src/services/movementHistoryService'
import { computeRouteCashReconciliation } from '../src/services/routeCashReconciliation'
import type { Route, User } from '../src/models/types'
import * as fs from 'node:fs'

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
async function rechazo(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'ACEPTADO' } catch (e) { return e instanceof Error ? e.message : String(e) }
}
const src = (p: string) => fs.readFileSync(p, 'utf8')

const T = 't-adex'
const CALI1 = 'r-cali1'
const CALI2 = 'r-cali2'
const PALMIRA = 'r-palmira'
const persona = (id: string, nombre: string, rol: User['rol'], rutas: string[]): User => ({
  id, tenantId: T, nombre, email: `${id}@adex.co`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, routeId: rutas[0], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)
const SA = persona('u-sa', 'Sara SuperAdmin', 'superadmin', [])
const ANA = persona('u-ana', 'Ana Admin', 'admin', [CALI1, CALI2])
const BETO = persona('u-beto', 'Beto Admin', 'admin', [PALMIRA])
const CARLOS = persona('u-carlos', 'Carlos Secundario', 'admin', [CALI1])
const HELMER = persona('u-helmer', 'helmer', 'cobrador', [CALI1])
const LAURA = persona('u-laura', 'Laura Supervisora', 'supervisor', [CALI1])
const SOCIO = persona('u-socio', 'Hernán Socio', 'socio', [CALI1])
const SOCIO2 = persona('u-socio2', 'Pía Socia', 'socio', [PALMIRA])
const SECRE = persona('u-secre', 'Sergio Secretario', 'secretario', [CALI1])
const TODOS = [SA, ANA, BETO, CARLOS, HELMER, LAURA, SOCIO, SOCIO2, SECRE]
const ruta = (id: string, nombre: string, ctl: string): Route => ({
  id, tenantId: T, nombre, codigo: id, status: 'activa', capitalInicial: 0, capitalActual: 0, tasaInteres: 20,
  tasaLibre: false, montoMaximoPrestamo: 0, createdAt: '2026-09-01', updatedAt: '2026-09-01', capitalControllerAdminId: ctl,
} as Route)
const RUTAS = [ruta(CALI1, 'cali1', ANA.id), ruta(CALI2, 'cali2', ANA.id), ruta(PALMIRA, 'palmira', BETO.id)]

const ref: Record<string, string> = {}
/** Escenario con TODOS los tipos de movimiento (servicios reales). */
async function escenario() {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.add({ id: T, nombre: 'ADEX', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z', baseCustodyStartAt: '2026-01-01T00:00:00.000Z' } as never)
  await db.routes.bulkAdd(RUTAS)
  await db.users.bulkAdd(TODOS)
  await db.expenseCategories.add({ id: 'c', tenantId: T, nombre: 'Combustible', activa: true })
  await registerCompanyCapital({ actor: SA, tenantId: T, amount: 100_000 })
  ref.asigAna = (await allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: ANA.id, amount: 20_000 })).id
  ref.asigBeto = (await allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: BETO.id, amount: 10_000 })).id
  ref.colSept = (await registerCapital({ actor: ANA, tenantId: T, routeId: CALI1, valor: 5_000, fecha: '2026-09-15' })).id
  ref.col2 = (await registerCapital({ actor: ANA, tenantId: T, routeId: CALI2, valor: 3_000 })).id
  ref.colError = (await registerCapital({ actor: ANA, tenantId: T, routeId: CALI2, valor: 100 })).id
  ref.revCol = (await reverseCapitalMovement({ actor: ANA, tenantId: T, movementId: ref.colError, reason: 'Duplicada' })).reversal.id
  ref.colBeto = (await registerCapital({ actor: BETO, tenantId: T, routeId: PALMIRA, valor: 2_000 })).id
  // Dos entregas REALES del mismo importe (no se fusionan).
  ref.ent1 = (await assignBaseToWorker({ actor: ANA, tenantId: T, routeId: CALI1, recipientUserId: HELMER.id, amount: 100, motivo: 'Base lunes' })).id
  ref.ent2 = (await assignBaseToWorker({ actor: ANA, tenantId: T, routeId: CALI1, recipientUserId: HELMER.id, amount: 100, motivo: 'Base martes' })).id
  ref.dev = (await returnBaseFromWorker({ actor: ANA, tenantId: T, routeId: CALI1, fromUserId: HELMER.id, amount: 40, motivo: 'Devolución' })).id
  ref.p2p = (await transferBaseBetweenWorkers({ actor: ANA, tenantId: T, routeId: CALI1, fromUserId: HELMER.id, toUserId: LAURA.id, amount: 20, motivo: 'Apoyo' })).id
  ref.tr = (await registerTransfer({ actor: ANA, tenantId: T, origen: { type: 'route', id: CALI1 }, destino: { type: 'route', id: CALI2 }, valor: 1_000 })).transfer.id
  ref.revTr = (await reverseTransfer({ actor: ANA, tenantId: T, movementId: ref.tr, reason: 'Ruta equivocada' })).reversal.id
  const enMano = await registerTransfer({ actor: ANA, tenantId: T, origen: { type: 'route', id: CALI2 }, destino: { type: 'route', id: CALI1 }, valor: 200, entregarA: { userId: HELMER.id } })
  ref.trMano = enMano.transfer.id
  ref.trManoLeg = enMano.custody!.id
  ref.ret = (await registerWithdrawal({ actor: ANA, tenantId: T, routeId: CALI2, valor: 500 })).id
  const g = (actor: User, valor: number, extra: object) => createExpense({ actor, tenantId: T, categoryId: 'c', valor, descripcion: 'Gasto', ...extra } as never)
  ref.gAna = (await g(ANA, 400, { scope: 'empresa', funding: { source: 'admin', adminId: ANA.id } })).id
  ref.reint = (await refundAdminExpense({ actor: ANA, tenantId: T, expenseId: ref.gAna, amount: 100, reason: 'Devolvieron un casco' })).id
  ref.gAna2 = (await g(ANA, 150, { scope: 'empresa', funding: { source: 'admin', adminId: ANA.id } })).id
  ref.anul = (await reverseAdminExpense({ actor: ANA, tenantId: T, expenseId: ref.gAna2, reason: 'Duplicado' })).reversal.id
  ref.gBeto = (await g(BETO, 700, { scope: 'empresa', funding: { source: 'admin', adminId: BETO.id } })).id
  ref.gEmp = (await g(SA, 300, { scope: 'empresa', funding: { source: 'empresa' } })).id
  ref.gRuta = (await g(ANA, 50, { scope: 'ruta', routeId: CALI1 })).id
  ref.gTrab = (await g(ANA, 30, { scope: 'trabajador', routeId: CALI1, collectorId: HELMER.id })).id
  ref.hist = 'hist-beto'
  await db.expenses.add({ id: ref.hist, tenantId: T, scope: 'empresa', categoryId: 'c', valor: 9_999, descripcion: 'Histórico de Beto', fecha: '2026-09-01', userId: BETO.id, syncStatus: 'synced', createdAt: '2026-09-01T00:00:00.000Z' })
  // Caja socios: ingreso manual, aporte a la ruta (pata enlazada) y salida manual.
  ref.ingSocio = (await createPartnerMovement({ actor: ANA, tenantId: T, partnerId: SOCIO.id, type: 'ingreso', category: 'inversion', amount: 1_000, fecha: '2026-10-01', description: 'Aporte' })).id
  const aporte = await registerTransfer({ actor: ANA, tenantId: T, origen: { type: 'partner', id: SOCIO.id }, destino: { type: 'route', id: CALI1 }, valor: 600 })
  ref.aporte = aporte.transfer.id
  ref.aporteLeg = aporte.partnerMovements[0].id
  ref.salSocio = (await createPartnerMovement({ actor: ANA, tenantId: T, partnerId: SOCIO.id, type: 'salida', category: 'retiro', amount: 100, fecha: '2026-10-02' })).id
}
const lista = (actor: User, filtros = {}) => listMovementHistory({ actor, tenantId: T, filtros })
const keys = (es: HistoryEntry[]) => new Set(es.map(e => e.key))
const tiene = (es: HistoryEntry[], fuente: string, id: string) => es.some(e => e.key === `${fuente}:${id}`)

const GA = 'A · Historial'

await spec('HIST-001', GA, 'todos los tipos, UNA entrada por operación real (patas dentro), sin duplicar claves', async () => {
  await escenario()
  const es = await lista(SA)
  const cats = [...new Set(es.map(e => e.categoria))].sort().join(',')
  // Registros de primer nivel: todo menos las patas enlazadas a transferencias.
  const [led, cm, w, tr, cu, ex, pc] = await Promise.all([db.capitalLedger.count(), db.capitalMovements.count(), db.withdrawals.count(), db.transfers.count(),
    db.cashCustodyMovements.filter(c => !c.relatedTransferId).count(), db.expenses.count(), db.partnerCashMovements.filter(p => !p.relatedTransferId).count()])
  metric('categorías', cats)
  metric('entradas / registros de primer nivel', `${es.length} / ${led + cm + w + tr + cu + ex + pc}`)
  assert(cats === 'capital,correccion,custodia,gasto,socios,transferencia', 'faltan tipos de movimiento')
  assert(es.length === led + cm + w + tr + cu + ex + pc && keys(es).size === es.length, 'hay entradas duplicadas o faltantes')
  assert(!tiene(es, 'cashCustodyMovements', ref.trManoLeg) && !tiene(es, 'partnerCashMovements', ref.aporteLeg), 'una pata enlazada aparece como operación aparte')
  const mano = es.find(e => e.id === ref.trMano)!
  const aporte = es.find(e => e.id === ref.aporte)!
  metric('transferencia con entrega en mano', `${mano.destino.kind}:${mano.destino.id} · patas ${mano.patas.map(p => p.clase).join(',')}`)
  assert(mano.destino.kind === 'trabajador' && mano.destino.id === HELMER.id && mano.patas.some(p => p.clase === 'entrega-en-mano' && p.key.endsWith(ref.trManoLeg)), 'la entrega en mano no está dentro de su transferencia')
  assert(aporte.patas.some(p => p.clase === 'caja-socios' && p.movimiento === 'salida' && p.personaId === SOCIO.id), 'la pata de Caja socios no está en el aporte')
})

await spec('HIST-002', GA, 'dos entregas reales del mismo importe se conservan; referencias = ids reales', async () => {
  await escenario()
  const es = await lista(SA)
  const entregas = es.filter(e => e.fuente === 'cashCustodyMovements' && e.tipo.startsWith('Entrega') && e.importe === 100)
  metric('entregas de 100', entregas.map(e => e.id.slice(0, 8)).join(', '))
  assert(entregas.length === 2 && tiene(es, 'cashCustodyMovements', ref.ent1) && tiene(es, 'cashCustodyMovements', ref.ent2), 'se fusionaron entregas del mismo valor')
  for (const e of es) {
    const tabla = (db as unknown as Record<string, { get(id: string): Promise<unknown> }>)[e.fuente]
    assert(await tabla.get(e.id), `la referencia ${e.key} no existe en su tabla`)
  }
})

await spec('HIST-003', GA, 'filtros: fecha, ruta, Administrador, trabajador, cuenta, estado y referencia', async () => {
  await escenario()
  const total = (await lista(SA)).length
  const desdeOct = await lista(SA, { desde: '2026-10-01' })
  const cali2 = await lista(SA, { routeId: CALI2 })
  const beto = await lista(SA, { adminId: BETO.id })
  const helmer = await lista(SA, { workerId: HELMER.id })
  const socios = await lista(SA, { cuenta: 'socio' })
  const anulados = await lista(SA, { estado: 'anulado' })
  const porRef = await lista(SA, { referencia: ref.ent2.slice(0, 8) })
  metric('total / desde oct / cali2 / Beto / helmer / socios / anulados / ref', [total, desdeOct.length, cali2.length, beto.length, helmer.length, socios.length, anulados.length, porRef.length].join(' / '))
  assert(!tiene(desdeOct, 'capitalMovements', ref.colSept) && desdeOct.every(e => e.fecha >= '2026-10-01'), 'filtro de fecha')
  assert(cali2.length > 0 && cali2.every(e => e.routeIds.includes(CALI2) || e.origen.routeId === CALI2 || e.destino.routeId === CALI2), 'filtro de ruta')
  assert(beto.length > 0 && beto.every(e => e.adminIds.includes(BETO.id)) && tiene(beto, 'expenses', ref.gBeto) && !tiene(beto, 'expenses', ref.gAna), 'filtro de Administrador')
  assert(helmer.length > 0 && helmer.every(e => e.workerIds.includes(HELMER.id)) && tiene(helmer, 'expenses', ref.gTrab), 'filtro de trabajador')
  assert(socios.length > 0 && socios.every(e => e.origen.kind === 'socio' || e.destino.kind === 'socio'), 'filtro de cuenta')
  assert(anulados.length === 3 && anulados.every(e => e.estado === 'anulado'), 'filtro de estado (colocación, transferencia y gasto anulados)')
  assert(porRef.length === 1 && porRef[0].id === ref.ent2, 'filtro de referencia')
})

await spec('HIST-004', GA, 'anulaciones y reintegros: entradas propias enlazadas al original; no cuentan como capital nuevo', async () => {
  await escenario()
  const es = await lista(SA)
  const por = (id: string) => es.find(e => e.id === id)!
  const casos: [string, string][] = [[ref.colError, ref.revCol], [ref.tr, ref.revTr], [ref.gAna2, ref.anul]]
  for (const [orig, rev] of casos) {
    const o = por(orig), r = por(rev)
    metric(o.tipo, `${o.estado} ← ${r.tipo} (${r.categoria})`)
    assert(o.estado === 'anulado' && o.corregidoPor.includes(r.key) && r.corrigeA === o.key && r.categoria === 'correccion' && r.estado === 'correccion', `${o.tipo}: anulación sin enlace`)
  }
  const reint = por(ref.reint)
  assert(reint.corrigeA === `expenses:${ref.gAna}` && por(ref.gAna).corregidoPor.includes(reint.key) && por(ref.gAna).estado === 'vigente', 'reintegro sin enlace (o anuló el original)')
  const revCol = por(ref.revCol)
  assert(revCol.origen.kind === 'caja-ruta' && revCol.destino.kind === 'bolsa-admin', 'la anulación de una colocación no devuelve a la bolsa')
})

const GB = 'B · Visibilidad (en el servicio)'

await spec('HIST-005', GB, 'Administradores aislados; secundario sin bolsa ajena; SuperAdmin todo; operativos sin acceso', async () => {
  await escenario()
  const [sa, ana, beto, carlos] = [await lista(SA), await lista(ANA), await lista(BETO), await lista(CARLOS)]
  metric('SA / Ana / Beto / Carlos', `${sa.length} / ${ana.length} / ${beto.length} / ${carlos.length}`)
  assert(!tiene(ana, 'expenses', ref.gBeto) && !tiene(ana, 'capitalLedger', ref.asigBeto) && !tiene(ana, 'capitalMovements', ref.colBeto) && !tiene(ana, 'expenses', ref.hist) && !tiene(ana, 'expenses', ref.gEmp), 'Ana ve datos de Beto o de la empresa')
  assert(!tiene(beto, 'expenses', ref.gAna) && !tiene(beto, 'capitalLedger', ref.asigAna) && tiene(beto, 'expenses', ref.hist) && !tiene(beto, 'cashCustodyMovements', ref.ent1), 'Beto ve datos de Ana o pierde su histórico')
  assert(!tiene(carlos, 'capitalLedger', ref.asigAna) && !tiene(carlos, 'expenses', ref.gAna) && tiene(carlos, 'cashCustodyMovements', ref.ent1) && !tiene(carlos, 'capitalMovements', ref.col2), 'el secundario ve la bolsa de Ana o rutas no asignadas')
  assert(sa.length > ana.length && tiene(sa, 'expenses', ref.gEmp) && tiene(sa, 'expenses', ref.hist), 'el SuperAdmin no ve todo')
  // Un filtro por URL no amplía el alcance.
  assert(!(await lista(ANA, { adminId: BETO.id })).some(e => e.adminIds.includes(BETO.id) && e.fuente === 'expenses'), 'un filtro amplió el alcance')
  for (const u of [LAURA, HELMER, SOCIO, SECRE]) {
    const r = await rechazo(() => lista(u))
    metric(u.rol, r.slice(0, 50))
    assert(r !== 'ACEPTADO', `${u.rol} accede al historial`)
  }
})

await spec('HIST-006', GB, 'comprobante: misma entrada por referencia; fuera de alcance no existe; sin recepciones inventadas', async () => {
  await escenario()
  const e = await getMovementEntry({ actor: ANA, tenantId: T, key: `cashCustodyMovements:${ref.ent1}` })
  const ajeno = await getMovementEntry({ actor: ANA, tenantId: T, key: `expenses:${ref.gBeto}` })
  metric('entrega', `${e?.tipo} · ${e?.importe} · registró ${e?.registradoPor}`)
  assert(e && e.id === ref.ent1 && e.importe === 100 && e.registradoPor === ANA.id && e.concepto === 'Base lunes', 'el comprobante no es el registro real')
  assert(ajeno === null, 'el comprobante de otra bolsa es accesible por URL')
  const recibo = src('src/pages/admin/MovementReceiptPage.tsx')
  const lib = src('src/lib/movementHistory.ts')
  assert(/Comprobante de movimiento registrado/.test(recibo) && /No acredita la entrega ni la recepción física del efectivo/.test(recibo), 'falta el título o la advertencia')
  // Frases que AFIRMARÍAN una recepción, firma o autorización (la advertencia que las
  // niega no cuenta).
  const afirma = /Recibido por|Recibí|Firma del|Firmado por|Autorizado por|Confirmado por el trabajador/i
  assert(!afirma.test(recibo) && !afirma.test(lib), 'se afirma una recepción o firma inexistente')
  assert(/getMovementEntry\(/.test(recibo) && !/generateId|crypto\.randomUUID/.test(recibo), 'el comprobante genera otra referencia')
})

await spec('HIST-007', GB, 'el historial no escribe; recaudos y desembolsos fuera (no duplica pagos)', async () => {
  await escenario()
  const tablas = ['capitalLedger', 'capitalMovements', 'withdrawals', 'transfers', 'cashCustodyMovements', 'expenses', 'partnerCashMovements', 'payments', 'sales'] as const
  const antes = await Promise.all(tablas.map(t => (db as unknown as Record<string, { count(): Promise<number> }>)[t].count()))
  await lista(SA); await lista(ANA)
  const despues = await Promise.all(tablas.map(t => (db as unknown as Record<string, { count(): Promise<number> }>)[t].count()))
  assert(JSON.stringify(antes) === JSON.stringify(despues), 'consultar el historial escribió registros')
  const svc = src('src/services/movementHistoryService.ts')
  assert(!/database\.(payments|sales)/.test(svc) && !/\.(add|put|update|delete)\(/.test(svc), 'el historial lee pagos/ventas o escribe')
})

const GC = 'C · Caja socios (corrección conservadora)'

await spec('HIST-008', GC, 'fondos: Ruta → Socio sin disponible se rechaza; aporte Socio → Ruta sin saldo queda visible (D1 pendiente)', async () => {
  await escenario()
  const saldo = async () => partnerBalance((await db.partnerCashMovements.where('partnerId').equals(SOCIO.id).toArray()))
  const disp = (await computeRouteCashReconciliation({ tenantId: T, routeId: CALI1 })).disponible
  const n0 = await db.partnerCashMovements.count()
  // El ORIGEN real del dinero (la caja de la ruta) sí se valida: sin fondos, no sale.
  const salidaRuta = await rechazo(() => registerTransfer({ actor: ANA, tenantId: T, origen: { type: 'route', id: CALI1 }, destino: { type: 'partner', id: SOCIO.id }, valor: disp + 1 }))
  metric('Ruta → Socio por encima del disponible', salidaRuta.slice(0, 70))
  assert(salidaRuta !== 'ACEPTADO' && await db.partnerCashMovements.count() === n0, 'salió dinero de una ruta sin fondos')
  // Aporte de efectivo EXTERNO del socio sin saldo previo: se conserva (caso real
  // Barreiro). Caja socios queda en negativo, VISIBLE; exigir saldo es la decisión D1.
  const s0 = await saldo()
  await registerTransfer({ actor: ANA, tenantId: T, origen: { type: 'partner', id: SOCIO.id }, destino: { type: 'route', id: CALI1 }, valor: s0 + 500 })
  metric('saldo del socio antes → después del aporte', `${s0} → ${await saldo()}`)
  assert(await saldo() === -500, 'el saldo negativo de Caja socios no queda a la vista')
  // Duplicados: el mismo id de operación en paralelo registra UNA vez.
  const rs = await Promise.all([1, 2].map(() => createPartnerMovement({ actor: ANA, tenantId: T, partnerId: SOCIO.id, type: 'ingreso', category: 'ingreso', amount: 500, fecha: '2026-10-05', operationId: 'op-par' })))
  assert(rs[0].id === rs[1].id && await saldo() === 0, 'un reintento en paralelo duplicó el movimiento')
})

await spec('HIST-009', GC, 'permisos e identidad en el servicio; duplicados por operationId', async () => {
  await escenario()
  const mov = (actor: User | null, extra: object = {}) => createPartnerMovement({ actor, tenantId: T, partnerId: SOCIO.id, type: 'ingreso', category: 'ingreso', amount: 10, fecha: '2026-10-05', ...extra } as never)
  const intentos = {
    'sin actor': await rechazo(() => mov(null)),
    'Supervisor': await rechazo(() => mov(LAURA)),
    'Cobrador': await rechazo(() => mov(HELMER)),
    'Socio': await rechazo(() => mov(SOCIO)),
    'Beto con socio de cali1 (fuera de alcance)': await rechazo(() => mov(BETO)),
    'Ana con socio de palmira': await rechazo(() => mov(ANA, { partnerId: SOCIO2.id })),
    'id que no es socio': await rechazo(() => mov(ANA, { partnerId: HELMER.id })),
    'decimal': await rechazo(() => mov(ANA, { amount: 10.5 })),
    'fecha futura': await rechazo(() => mov(ANA, { fecha: '2999-01-01' })),
  }
  for (const [k, v] of Object.entries(intentos)) { metric(k, v.slice(0, 55)); assert(v !== 'ACEPTADO', `aceptado: ${k}`) }
  const a = await mov(ANA, { operationId: 'op-soc-1' })
  const b = await mov(ANA, { operationId: 'op-soc-1' })
  const otra = await rechazo(() => mov(ANA, { operationId: 'op-soc-1', amount: 99 }))
  assert(a.id === b.id && a.createdBy === ANA.id && otra !== 'ACEPTADO', 'duplicado o autor no sellado')
})

await spec('HIST-010', GC, 'conservación: invariantes de capital y conciliación de todas las rutas tras el escenario', async () => {
  await escenario()
  const issues = verifyCapitalInvariants(await loadCapitalRows(T, db as never), [ANA.id, BETO.id, CARLOS.id])
  assert(issues.length === 0, `invariantes: ${issues.join(' | ')}`)
  for (const r of RUTAS) assert((await computeRouteCashReconciliation({ tenantId: T, routeId: r.id })).cuadra, `${r.nombre} no cuadra`)
  const page = src('src/pages/admin/PartnerCashPage.tsx')
  assert(/actor: user, operationId: opId/.test(page), 'Caja socios no envía actor e id de operación')
})

console.log('\n════════════════════════════════════════════════════════════════')
console.log('  ADEX · HISTORIAL UNIFICADO + CAJA SOCIOS (Ronda 5/6)')
console.log('════════════════════════════════════════════════════════════════')
let grupo = ''
for (const r of results) {
  if (r.group !== grupo) { grupo = r.group; console.log(`\n  ▌ ${grupo}`) }
  console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id}  ${r.desc}`)
  for (const m of r.metrics) console.log(`          · ${m}`)
  if (r.error) console.log(`          ✗ ${r.error}`)
}
const fallidos = results.filter(r => !r.passed).length
console.log(`\n  ${results.length - fallidos}/${results.length} casos OK`)
if (fallidos > 0) process.exit(1)
