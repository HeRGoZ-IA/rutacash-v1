// ============================================================
// ADEX — SUITE TRANSFERENCIAS UNIFICADAS (Ronda 4/6, DEXIE REAL)
// ------------------------------------------------------------
//   npm run test:transferops
//
// El módulo unificado NO crea operaciones: identifica la operación existente y
// delega en su servicio. Se comprueba, por operación: vista previa = resultado
// real, permisos (mismas reglas en UI y servicio), fondos, duplicados por
// operationId (también en paralelo), custodia, cuadres, conservación del capital
// y compatibilidad con Caja principal y gastos administrativos.
// Caso de referencia: entregar R$ 100 de la caja sin asignar de cali1 a helmer.
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import { verifyCapitalInvariants } from '../src/lib/capitalAllocation'
import {
  availableOperations, previewTransferOperation, routesForOperation, type RouteBalances, type TransferOperationKind,
} from '../src/lib/transferOperations'
import {
  allocateCapitalToAdmin, getAdminAvailableCapital, getAdminPoolStatement, loadCapitalRows, registerCompanyCapital,
} from '../src/services/capitalControlService'
import { registerCapital, registerTransfer, registerWithdrawal } from '../src/services/routeFundsService'
import { assignBaseToWorker, returnBaseFromWorker } from '../src/services/cashCustodyService'
import { computeRouteCashReconciliation } from '../src/services/routeCashReconciliation'
import { closeCashSettlement, previewCashSettlement } from '../src/services/cashSettlementService'
import { createExpense } from '../src/services/expenseService'
import { getRouteBase } from '../src/services/cashboxEngine'
import type { Route, User } from '../src/models/types'

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

const T = 't-adex'
const CALI1 = 'r-cali1'
const CALI2 = 'r-cali2'
const PALMIRA = 'r-palmira'
const persona = (id: string, nombre: string, rol: User['rol'], rutas: string[]): User => ({
  id, tenantId: T, nombre, email: `${id}@adex.co`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, routeId: rutas[0], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)
const SA = persona('u-sa', 'Sara SuperAdmin', 'superadmin', [])
const ANA = persona('u-ana', 'Ana Admin', 'admin', [CALI1, CALI2, PALMIRA])   // responsable de cali1/cali2; asignada (no responsable) a palmira
const BETO = persona('u-beto', 'Beto Admin', 'admin', [PALMIRA])
const CARLOS = persona('u-carlos', 'Carlos Admin secundario', 'admin', [CALI1])
const HELMER = persona('u-helmer', 'helmer', 'cobrador', [CALI1])
const LAURA = persona('u-laura', 'Laura Supervisora', 'supervisor', [CALI1])
const SOCIO = persona('u-socio', 'Hernán Socio', 'socio', [CALI1])
const SECRE = persona('u-secre', 'Sergio Secretario', 'secretario', [CALI1])
const TODOS = [SA, ANA, BETO, CARLOS, HELMER, LAURA, SOCIO, SECRE]
const ruta = (id: string, nombre: string, ctl: string): Route => ({
  id, tenantId: T, nombre, codigo: id, status: 'activa', capitalInicial: 0, capitalActual: 0, tasaInteres: 20,
  tasaLibre: false, montoMaximoPrestamo: 0, createdAt: '2026-09-01', updatedAt: '2026-09-01', capitalControllerAdminId: ctl,
} as Route)
const RUTAS = [ruta(CALI1, 'cali1', ANA.id), ruta(CALI2, 'cali2', ANA.id), ruta(PALMIRA, 'palmira', BETO.id)]

async function empresa() {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.add({ id: T, nombre: 'ADEX', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z', baseCustodyStartAt: '2026-01-01T00:00:00.000Z' } as never)
  await db.routes.bulkAdd(RUTAS)
  await db.users.bulkAdd(TODOS)
  await db.expenseCategories.add({ id: 'c', tenantId: T, nombre: 'Combustible', activa: true })
  await registerCompanyCapital({ actor: SA, tenantId: T, amount: 100_000 })
  await allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: ANA.id, amount: 20_000 })
  await allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: BETO.id, amount: 10_000 })
  await registerCapital({ actor: ANA, tenantId: T, routeId: CALI1, valor: 5_000 })
  await registerCapital({ actor: ANA, tenantId: T, routeId: CALI2, valor: 3_000 })
  await registerCapital({ actor: BETO, tenantId: T, routeId: PALMIRA, valor: 2_000 })
}
/** Saldos tal como los recibe el asistente (conciliación). */
async function saldos(routeId: string): Promise<RouteBalances> {
  const r = await computeRouteCashReconciliation({ tenantId: T, routeId })
  return { disponible: r.disponible, sinAsignar: r.noAsignado, posiciones: Object.fromEntries(r.personas.map(p => [p.userId, p.posicion])) }
}
const nombres = { ruta: 'cali1', rutaDestino: 'cali2', trabajador: 'helmer', bolsa: 'Mi bolsa' }
async function invariantes() {
  const issues = verifyCapitalInvariants(await loadCapitalRows(T, db as never), [ANA.id, BETO.id, CARLOS.id])
  assert(issues.length === 0, `invariantes rotos: ${issues.join(' | ')}`)
  for (const r of RUTAS) assert((await computeRouteCashReconciliation({ tenantId: T, routeId: r.id })).cuadra, `la conciliación de ${r.nombre} no cuadra`)
}
const conteos = async () => [await db.cashCustodyMovements.count(), await db.transfers.count(), await db.capitalMovements.count(), await db.withdrawals.count()].join('/')

const GA = 'A · Operaciones (vista previa = resultado real)'

await spec('OPS-001', GA, 'caso de referencia: R$ 100 de cali1 (sin asignar) a helmer, sin cierre de caja', async () => {
  await empresa()
  const base0 = await getRouteBase(CALI1)
  const antes = await saldos(CALI1)
  const pv = previewTransferOperation({ kind: 'entregar-base', importe: 100, ruta: antes, trabajadorId: HELMER.id, nombres })
  const m = await assignBaseToWorker({ actor: ANA, tenantId: T, routeId: CALI1, recipientUserId: HELMER.id, amount: 100, motivo: 'Base del día', operationId: 'op-ref' })
  const despues = await saldos(CALI1)
  metric('sin asignar (previsto / real)', `${pv.origen.despues} / ${despues.sinAsignar}`)
  metric('helmer (previsto / real)', `${pv.destino.despues} / ${despues.posiciones[HELMER.id]}`)
  assert(pv.origen.antes === 5_000 && pv.origen.despues === despues.sinAsignar && pv.destino.despues === despues.posiciones[HELMER.id] && despues.posiciones[HELMER.id] === 100, 'la vista previa no coincide con el resultado')
  assert(m.tipo === 'BASE_ASSIGNMENT' && m.origen === 'route-cash' && await getRouteBase(CALI1) === base0, 'la entrega cambió la Base o no es una entrega de Base')
  assert(await db.cashSettlements.count() === 0, 'se exigió o creó un cierre')
  await invariantes()
})

// [MODIFICADO R74] Antes el SuperAdmin también recibía la devolución; ya no (no opera la caja de la ruta).
await spec('OPS-002', GA, 'recibir devolución de Base (Admin responsable; R74: el SuperAdmin no)', async () => {
  await empresa()
  await assignBaseToWorker({ actor: ANA, tenantId: T, routeId: CALI1, recipientUserId: HELMER.id, amount: 100, motivo: 'Base' })
  const antes = await saldos(CALI1)
  const pv = previewTransferOperation({ kind: 'devolver-base', importe: 40, ruta: antes, trabajadorId: HELMER.id, nombres })
  await returnBaseFromWorker({ actor: ANA, tenantId: T, routeId: CALI1, fromUserId: HELMER.id, amount: 40, motivo: 'Devolución' })
  const d = await saldos(CALI1)
  metric('helmer / sin asignar', `${pv.origen.despues}=${d.posiciones[HELMER.id]} / ${pv.destino.despues}=${d.sinAsignar}`)
  assert(pv.origen.despues === d.posiciones[HELMER.id] && pv.destino.despues === d.sinAsignar && pv.limite === 100, 'vista previa ≠ resultado')
  const sa = await rechazo(() => returnBaseFromWorker({ actor: SA, tenantId: T, routeId: CALI1, fromUserId: HELMER.id, amount: 10, motivo: 'Devolución al SuperAdmin' }))
  metric('SuperAdmin recibe', sa)
  assert(sa !== 'ACEPTADO' && (await saldos(CALI1)).posiciones[HELMER.id] === 60, 'R74: el SuperAdmin recibió la devolución')
  await invariantes()
})

await spec('OPS-003', GA, 'entregar Base a un Supervisor de la ruta (custodio elegible)', async () => {
  await empresa()
  await assignBaseToWorker({ actor: ANA, tenantId: T, routeId: CALI1, recipientUserId: LAURA.id, amount: 300, motivo: 'Base supervisora' })
  assert((await saldos(CALI1)).posiciones[LAURA.id] === 300, 'la Supervisora no recibió la Base')
  await invariantes()
})

await spec('OPS-004', GA, 'transferir entre rutas del mismo responsable (también con entrega en mano)', async () => {
  await empresa()
  const [o0, d0] = [await saldos(CALI1), await saldos(CALI2)]
  const bolsa0 = await getAdminAvailableCapital(T, ANA.id)
  const pv = previewTransferOperation({ kind: 'ruta-ruta', importe: 1_000, ruta: o0, rutaDestino: d0, nombres })
  const { transfer } = await registerTransfer({ actor: ANA, tenantId: T, origen: { type: 'route', id: CALI1 }, destino: { type: 'route', id: CALI2 }, valor: 1_000, descripcion: 'Refuerzo', operationId: 'op-t1' })
  const [o1, d1] = [await saldos(CALI1), await saldos(CALI2)]
  metric('cali1 disponible (previsto / real)', `${pv.origen.despues} / ${o1.disponible}`)
  metric('cali2 sin asignar (previsto / real)', `${pv.destino.despues} / ${d1.sinAsignar}`)
  assert(pv.origen.despues === o1.disponible && pv.destino.despues === d1.sinAsignar, 'vista previa ≠ resultado')
  assert(transfer.adminId === ANA.id && await getAdminAvailableCapital(T, ANA.id) === bolsa0, 'el traslado cambió la bolsa')
  // Con entrega en mano a helmer (asignado a cali1): cali2 → cali1.
  const pv2 = previewTransferOperation({ kind: 'ruta-ruta', importe: 200, ruta: d1, rutaDestino: o1, trabajadorId: HELMER.id, nombres })
  await registerTransfer({ actor: ANA, tenantId: T, origen: { type: 'route', id: CALI2 }, destino: { type: 'route', id: CALI1 }, valor: 200, entregarA: { userId: HELMER.id } })
  assert(pv2.destino.despues === (await saldos(CALI1)).posiciones[HELMER.id], 'entrega en mano: vista previa ≠ resultado')
  await invariantes()
})

await spec('OPS-005', GA, 'colocar y retirar capital: vista previa = resultado; la Caja principal cuadra', async () => {
  await empresa()
  const [b0, r0] = [await getAdminAvailableCapital(T, ANA.id), await saldos(CALI2)]
  const pc = previewTransferOperation({ kind: 'colocar', importe: 2_000, ruta: r0, bolsa: b0, nombres })
  const c = await registerCapital({ actor: ANA, tenantId: T, routeId: CALI2, valor: 2_000, descripcion: 'Distribución', operationId: 'op-c1' })
  const [b1, r1] = [await getAdminAvailableCapital(T, ANA.id), await saldos(CALI2)]
  assert(pc.origen.despues === b1 && pc.destino.despues === r1.sinAsignar, 'colocar: vista previa ≠ resultado')
  const pr = previewTransferOperation({ kind: 'retirar', importe: 500, ruta: r1, bolsa: b1, nombres })
  const w = await registerWithdrawal({ actor: ANA, tenantId: T, routeId: CALI2, valor: 500, descripcion: 'Retiro', operationId: 'op-w1' })
  const [b2, r2] = [await getAdminAvailableCapital(T, ANA.id), await saldos(CALI2)]
  metric('bolsa', `${b0} → ${b1} → ${b2}`)
  assert(pr.origen.despues === r2.disponible && pr.destino.despues === b2, 'retirar: vista previa ≠ resultado')
  const caja = await getAdminPoolStatement({ actor: ANA, tenantId: T, adminId: ANA.id })
  assert(caja.conciliacion.diferencia === 0 && caja.movimientos.some(m => m.id === c.id) && caja.movimientos.some(m => m.id === w.id), 'la Caja principal no refleja las operaciones')
  await invariantes()
})

const GB = 'B · Fondos, permisos y duplicados'

await spec('OPS-006', GB, 'fondos insuficientes: la vista previa lo marca y el servicio rechaza sin escribir', async () => {
  await empresa()
  await assignBaseToWorker({ actor: ANA, tenantId: T, routeId: CALI1, recipientUserId: HELMER.id, amount: 100, motivo: 'Base' })
  const c1 = await saldos(CALI1)
  const bolsa = await getAdminAvailableCapital(T, ANA.id)
  const casos: [TransferOperationKind, number, () => Promise<unknown>][] = [
    ['entregar-base', c1.disponible + 1, () => assignBaseToWorker({ actor: ANA, tenantId: T, routeId: CALI1, recipientUserId: HELMER.id, amount: c1.disponible + 1, motivo: 'x x' })],
    ['devolver-base', 101, () => returnBaseFromWorker({ actor: ANA, tenantId: T, routeId: CALI1, fromUserId: HELMER.id, amount: 101, motivo: 'x x' })],
    ['ruta-ruta', c1.disponible + 1, () => registerTransfer({ actor: ANA, tenantId: T, origen: { type: 'route', id: CALI1 }, destino: { type: 'route', id: CALI2 }, valor: c1.disponible + 1 })],
    ['colocar', bolsa + 1, () => registerCapital({ actor: ANA, tenantId: T, routeId: CALI1, valor: bolsa + 1 })],
    ['retirar', c1.disponible + 1, () => registerWithdrawal({ actor: ANA, tenantId: T, routeId: CALI1, valor: c1.disponible + 1 })],
  ]
  const n0 = await conteos()
  for (const [kind, importe, f] of casos) {
    const pv = previewTransferOperation({ kind, importe, ruta: c1, rutaDestino: await saldos(CALI2), trabajadorId: kind.endsWith('base') ? HELMER.id : undefined, bolsa, nombres })
    const r = await rechazo(f)
    metric(kind, `excede=${pv.excede} · ${r.slice(0, 60)}`)
    assert(pv.excede && r !== 'ACEPTADO', `${kind}: no se marcó o no se rechazó`)
  }
  assert(await conteos() === n0, 'un rechazo dejó escrituras')
  // El capital colocado en préstamos / en manos de helmer no es transferible.
  assert(c1.disponible === c1.sinAsignar && c1.posiciones[HELMER.id] === 100, 'el disponible incluye efectivo en manos de trabajadores')
})

await spec('OPS-007', GB, 'permisos: lo que la UI ofrece = lo que el servicio acepta', async () => {
  await empresa()
  const ops = (u: User) => availableOperations(u, RUTAS.filter(r => u.rol === 'superadmin' || (u.authorizedRouteIds ?? []).includes(r.id)), TODOS, T).join(',') || '—'
  const v = { ana: ops(ANA), beto: ops(BETO), carlos: ops(CARLOS), sa: ops(SA), laura: ops(LAURA), helmer: ops(HELMER), socio: ops(SOCIO), secre: ops(SECRE) }
  for (const [k, x] of Object.entries(v)) metric(k, x)
  assert(v.ana === 'entregar-base,devolver-base,ruta-ruta,colocar,retirar', 'Ana (responsable) no tiene sus operaciones')
  assert(v.carlos === '—', 'el Admin secundario obtiene control de caja')
  // [MODIFICADO R74] Antes el SuperAdmin conservaba «devolver-base» (nivel settle); ya no tiene ninguna.
  assert(v.sa === '—', 'el SuperAdmin obtiene operaciones de caja de ruta')
  assert(v.helmer === '—' && v.socio === '—' && v.secre === '—', 'un rol operativo o de consulta obtiene operaciones')
  assert(v.laura === 'devolver-base', 'el Supervisor obtiene algo más que recibir devoluciones (regla vigente)')
  assert(!routesForOperation('ruta-ruta', ANA, RUTAS, TODOS, T).some(r => r.id === PALMIRA), 'se ofrece la ruta de otro responsable')
  const intentos = {
    'Ana cali1 → palmira (otro responsable)': () => registerTransfer({ actor: ANA, tenantId: T, origen: { type: 'route', id: CALI1 }, destino: { type: 'route', id: PALMIRA }, valor: 1 }),
    'Ana retira de palmira': () => registerWithdrawal({ actor: ANA, tenantId: T, routeId: PALMIRA, valor: 1 }),
    'Carlos entrega Base en cali1': () => assignBaseToWorker({ actor: CARLOS, tenantId: T, routeId: CALI1, recipientUserId: HELMER.id, amount: 1, motivo: 'x x' }),
    'Carlos coloca en cali1': () => registerCapital({ actor: CARLOS, tenantId: T, routeId: CALI1, valor: 1 }),
    'SuperAdmin entrega Base': () => assignBaseToWorker({ actor: SA, tenantId: T, routeId: CALI1, recipientUserId: HELMER.id, amount: 1, motivo: 'x x' }),
    'SuperAdmin recibe devolución (R74)': () => returnBaseFromWorker({ actor: SA, tenantId: T, routeId: CALI1, fromUserId: HELMER.id, amount: 1, motivo: 'x x' }),
    'SuperAdmin transfiere': () => registerTransfer({ actor: SA, tenantId: T, origen: { type: 'route', id: CALI1 }, destino: { type: 'route', id: CALI2 }, valor: 1 }),
    'Supervisor entrega Base': () => assignBaseToWorker({ actor: LAURA, tenantId: T, routeId: CALI1, recipientUserId: HELMER.id, amount: 1, motivo: 'x x' }),
    'Cobrador entrega Base': () => assignBaseToWorker({ actor: HELMER, tenantId: T, routeId: CALI1, recipientUserId: LAURA.id, amount: 1, motivo: 'x x' }),
    'Socio transfiere': () => registerTransfer({ actor: SOCIO, tenantId: T, origen: { type: 'route', id: CALI1 }, destino: { type: 'route', id: CALI2 }, valor: 1 }),
  }
  for (const [k, f] of Object.entries(intentos)) {
    const r = await rechazo(f)
    metric(k, r.slice(0, 70))
    assert(r !== 'ACEPTADO', `aceptado sin autoridad: ${k}`)
  }
  await invariantes()
})

await spec('OPS-008', GB, 'duplicados: el mismo operationId (secuencial y en paralelo) registra UNA vez', async () => {
  await empresa()
  await assignBaseToWorker({ actor: ANA, tenantId: T, routeId: CALI1, recipientUserId: LAURA.id, amount: 500, motivo: 'Base' })
  const dos = async <X>(f: () => Promise<X>) => { const [a, b] = await Promise.all([f(), f()]); const c = await f(); return [a, b, c] }
  const ids = (xs: { id: string }[]) => new Set(xs.map(x => x.id)).size
  const ent = await dos(() => assignBaseToWorker({ actor: ANA, tenantId: T, routeId: CALI1, recipientUserId: HELMER.id, amount: 100, motivo: 'Base del día', operationId: 'dup-ent' }))
  const dev = await dos(() => returnBaseFromWorker({ actor: ANA, tenantId: T, routeId: CALI1, fromUserId: LAURA.id, amount: 50, motivo: 'Devolución', operationId: 'dup-dev' }))
  const tra = await dos(() => registerTransfer({ actor: ANA, tenantId: T, origen: { type: 'route', id: CALI1 }, destino: { type: 'route', id: CALI2 }, valor: 300, entregarA: undefined, operationId: 'dup-tra' }).then(r => r.transfer))
  const col = await dos(() => registerCapital({ actor: ANA, tenantId: T, routeId: CALI2, valor: 700, operationId: 'dup-col' }))
  const ret = await dos(() => registerWithdrawal({ actor: ANA, tenantId: T, routeId: CALI2, valor: 200, operationId: 'dup-ret' }))
  metric('ids distintos por operación', [ent, dev, tra, col, ret].map(ids).join(','))
  assert([ent, dev, tra, col, ret].every(x => ids(x) === 1), 'una operación se duplicó')
  const s = await saldos(CALI1)
  assert(s.posiciones[HELMER.id] === 100 && s.posiciones[LAURA.id] === 450, 'los saldos reflejan duplicados')
  const otra = await rechazo(() => assignBaseToWorker({ actor: ANA, tenantId: T, routeId: CALI1, recipientUserId: HELMER.id, amount: 999, motivo: 'Base del día', operationId: 'dup-ent' }))
  const otraT = await rechazo(() => registerTransfer({ actor: ANA, tenantId: T, origen: { type: 'route', id: CALI1 }, destino: { type: 'route', id: CALI2 }, valor: 999, operationId: 'dup-tra' }))
  metric('mismo id, otros datos', `${otra.slice(0, 50)} / ${otraT.slice(0, 50)}`)
  assert(otra !== 'ACEPTADO' && otraT !== 'ACEPTADO', 'reutilizó un id con otros datos')
  await invariantes()
})

const GC = 'C · Custodia, cuadres y bolsa'

await spec('OPS-009', GC, 'custodia y cuadre: la Base entregada entra al cuadre de helmer y cierra exacto', async () => {
  await empresa()
  await assignBaseToWorker({ actor: ANA, tenantId: T, routeId: CALI1, recipientUserId: HELMER.id, amount: 100, motivo: 'Base del día' })
  const p = await previewCashSettlement({ actor: ANA, tenantId: T, routeId: CALI1, userId: HELMER.id })
  metric('cuadre de helmer', `Base recibida ${p.baseRecibida} · esperado ${p.esperado}`)
  assert(p.baseRecibida === 100 && p.esperado === 100, 'la entrega no está en el cuadre')
  const cierre = await closeCashSettlement({ actor: ANA, tenantId: T, routeId: CALI1, userId: HELMER.id, entregado: 100, esperadoVisto: 100 })
  assert(cierre.diferencia === 0, 'el cuadre no cerró exacto')
  const s = await saldos(CALI1)
  assert(s.posiciones[HELMER.id] === 0 && s.sinAsignar === 5_000, 'tras el cuadre el efectivo no volvió a la caja sin asignar')
  await invariantes()
})

await spec('OPS-010', GC, 'gastos administrativos y colocación compiten por la misma bolsa', async () => {
  await empresa()
  const b0 = await getAdminAvailableCapital(T, ANA.id)
  await createExpense({ actor: ANA, tenantId: T, scope: 'empresa', categoryId: 'c', valor: b0 - 1_000, descripcion: 'Combustible del mes', funding: { source: 'admin', adminId: ANA.id } })
  const b1 = await getAdminAvailableCapital(T, ANA.id)
  const pv = previewTransferOperation({ kind: 'colocar', importe: 1_001, ruta: await saldos(CALI1), bolsa: b1, nombres })
  const r = await rechazo(() => registerCapital({ actor: ANA, tenantId: T, routeId: CALI1, valor: 1_001 }))
  metric('bolsa tras el gasto / colocar 1.001', `${b1} / ${r.slice(0, 50)}`)
  assert(b1 === 1_000 && pv.excede && r !== 'ACEPTADO', 'se colocó dinero ya gastado')
  await registerCapital({ actor: ANA, tenantId: T, routeId: CALI1, valor: 1_000 })
  assert(await getAdminAvailableCapital(T, ANA.id) === 0, 'disponible final incorrecto')
  await invariantes()
})

console.log('\n════════════════════════════════════════════════════════════════')
console.log('  ADEX · TRANSFERENCIAS UNIFICADAS (Ronda 4/6)')
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
