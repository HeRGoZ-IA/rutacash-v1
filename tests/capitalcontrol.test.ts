// ============================================================
// RUTACASH — SUITE CAPITAL POR ADMINISTRADOR (v16, DEXIE REAL)
// ------------------------------------------------------------
//   npm run test:capitalcontrol
//
// Cadena SuperAdmin → Administrador → Ruta, con UN responsable de capital por
// ruta. Grupos (requerimiento 2026-10-07, §26):
//   A SuperAdmin → Admin       B Admin → Ruta          C Multi-Admin
//   D Cambio de responsable    E Desasignación         F Migración
//   G UI / permisos            H Traspaso entre trabajadores
//   I Regresiones (Caja, Liquidación, Transferencias, anulaciones)
//
// Escenario (el del requerimiento): la empresa ingresa $50.000.000 y asigna
// Juan $20.000.000 · Carlos $15.000.000 · María $10.000.000 (queda $5.000.000).
// Rutas: Norte (Juan + Carlos; responsable Juan), Sur (Juan), Palmira (María),
// Huérfana (sin Administradores).
//
// Tras cada operación se comprueban los invariantes de `verifyCapitalInvariants`
// (conservación, disponibles ≥ 0, un solo responsable con capital por ruta).
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { db, RutaCashDB } from '../src/lib/db'
import { nowISO, today } from '../src/lib/formatters'
import {
  adminCapital, capitalControllerAt, computeCapitalStructure, planCapitalMigrationV16, verifyCapitalInvariants,
} from '../src/lib/capitalAllocation'
import {
  can, canOperateRouteCash, isCapabilityCompatible, routeCashAuthorityError, sanitizeGrantedCapabilities, type RouteCashOperation,
} from '../src/lib/permissions'
import {
  allocateCapitalToAdmin, getCapitalOverview, listCapitalLedger, listRouteControllerHistory, loadCapitalRows,
  registerCompanyCapital, returnCapitalFromAdmin, setRouteCapitalController, withCapitalControllerGuard, withdrawCompanyCapital,
} from '../src/services/capitalControlService'
import { registerCapital, registerTransfer, registerWithdrawal, canManageRouteFunds } from '../src/services/routeFundsService'
import { assignBaseToWorker, returnBaseFromWorker, transferBaseBetweenWorkers } from '../src/services/cashCustodyService'
import { closeCashSettlement } from '../src/services/cashSettlementService'
import { closeSettlement } from '../src/services/settlementService'
import { reverseCapitalMovement, reverseWithdrawal } from '../src/services/movementReversalService'
import { createRouteWithAdmins, updateRouteWithAssignments, type RouteDatabase } from '../src/services/routeService'
import { getRouteBase } from '../src/services/cashboxEngine'
import type { Route, User } from '../src/models/types'
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

async function rechazo(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'ACEPTADO' } catch (e) { return e instanceof Error ? e.message : String(e) }
}

const src = (p: string) => fs.readFileSync(p, 'utf8')
const M = 1_000_000

// ============================================================
// Escenario
// ============================================================
const T = 't-adex'
const TB = 't-ajena'
const NORTE = 'r-norte'
const SUR = 'r-sur'
const PALMIRA = 'r-palmira'
const HUERFANA = 'r-huerfana'
const RB = 'r-ajena'

const persona = (id: string, nombre: string, rol: User['rol'], rutas: string[], createdAt = '2026-09-01T00:00:00.000Z', tenantId = T): User => ({
  id, tenantId, nombre, email: `${id}@adex.co`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, createdAt, updatedAt: createdAt,
} as User)

const SA = persona('u-sa', 'Sara SuperAdmin', 'superadmin', [])
const JUAN = persona('u-juan', 'Juan Admin', 'admin', [NORTE, SUR], '2026-09-01T00:00:00.000Z')
const CARLOS = persona('u-carlos', 'Carlos Admin', 'admin', [NORTE], '2026-09-02T00:00:00.000Z')
const MARIA = persona('u-maria', 'María Admin', 'admin', [PALMIRA], '2026-09-03T00:00:00.000Z')
const LAURA = persona('u-laura', 'Laura Supervisora', 'supervisor', [NORTE])
const FABIO = persona('u-fabio', 'Fabio Cobrador', 'cobrador', [NORTE])
const PEDRO = persona('u-pedro', 'Pedro Cobrador', 'cobrador', [NORTE])
const SOCIO = persona('u-socio', 'Hernán Socio', 'socio', [NORTE])
const SECRE = persona('u-secre', 'Sergio Secretario', 'secretario', [NORTE])
const SIN_RUTA = persona('u-sinruta', 'Nadia Admin sin rutas', 'admin', [])
const AJENO = persona('u-ajeno', 'Ana Ajena', 'admin', [RB], '2026-09-01T00:00:00.000Z', TB)

const ruta = (id: string, nombre: string, tenantId = T, capitalControllerAdminId?: string): Route => ({
  id, tenantId, nombre, codigo: id, status: 'activa', capitalInicial: 0, capitalActual: 0, tasaInteres: 20,
  tasaLibre: false, montoMaximoPrestamo: 1_000_000, createdAt: '2026-09-01', updatedAt: '2026-09-01',
  capitalControllerAdminId,
} as Route)

const noop = async () => undefined
const routeDb = db as unknown as RouteDatabase

async function vaciar() {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.bulkAdd([
    { id: T, nombre: 'ADEX', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z', baseCustodyStartAt: '2026-01-01T00:00:00.000Z' },
    { id: TB, nombre: 'Ajena', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z', baseCustodyStartAt: '2026-01-01T00:00:00.000Z' },
  ] as never[])
}

/** Empresa del requerimiento con responsables ya fijados y bolsas asignadas. */
async function empresa(opts: { asignar?: boolean } = {}) {
  await vaciar()
  await db.routes.bulkAdd([
    ruta(NORTE, 'Norte', T, JUAN.id), ruta(SUR, 'Sur', T, JUAN.id), ruta(PALMIRA, 'Palmira', T, MARIA.id),
    ruta(HUERFANA, 'Huérfana'), ruta(RB, 'Ajena', TB, AJENO.id),
  ])
  await db.users.bulkAdd([SA, JUAN, CARLOS, MARIA, LAURA, FABIO, PEDRO, SOCIO, SECRE, SIN_RUTA, AJENO])
  if (opts.asignar !== false) {
    await registerCompanyCapital({ actor: SA, tenantId: T, amount: 50 * M })
    await allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: JUAN.id, amount: 20 * M })
    await allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: CARLOS.id, amount: 15 * M })
    await allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: MARIA.id, amount: 10 * M })
  }
}

const rows = () => loadCapitalRows(T, db as never)
const admins = () => [JUAN.id, CARLOS.id, MARIA.id, SIN_RUTA.id]
async function bolsa(adminId: string) { return adminCapital(adminId, await rows()) }
async function estructura() { return computeCapitalStructure(await rows(), admins()) }
async function invariantes() {
  const issues = verifyCapitalInvariants(await rows(), admins())
  assert(issues.length === 0, `invariantes rotos: ${issues.join(' | ')}`)
}
const fmt = (n: number) => `${(n / M).toLocaleString('es-CO')}M`
async function users() { return db.users.where('tenantId').equals(T).toArray() }

// ############################################################
// A — SUPERADMIN → ADMINISTRADOR
// ############################################################
const GA = 'A · SuperAdmin → Admin'

await spec('CAP-A-001', GA, 'asignación válida: 50M en la empresa → Juan 20M, Carlos 15M, María 10M; disponible 5M', async () => {
  await empresa()
  const s = await estructura()
  const j = await bolsa(JUAN.id)
  metric('empresa total / disponible', `${fmt(s.company.total)} / ${fmt(s.company.disponible)}`)
  metric('Juan asignado / en rutas / disponible', `${fmt(j.asignado)} / ${fmt(j.enRutas)} / ${fmt(j.disponible)}`)
  assert(s.company.total === 50 * M && s.company.disponible === 5 * M, 'la empresa no quedó en 50M / 5M')
  assert(j.asignado === 20 * M && j.disponible === 20 * M && j.enRutas === 0, 'la bolsa de Juan no es 20M disponible')
  assert((await bolsa(CARLOS.id)).asignado === 15 * M && (await bolsa(MARIA.id)).asignado === 10 * M, 'bolsas de Carlos/María incorrectas')
  await invariantes()
})

await spec('CAP-A-002', GA, 'asignación insuficiente: 6M con 5M disponibles → rechazada sin escribir nada', async () => {
  await empresa()
  const antes = await db.capitalLedger.count()
  const r = await rechazo(() => allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: JUAN.id, amount: 6 * M }))
  metric('respuesta', r)
  assert(r !== 'ACEPTADO' && /no tiene ese capital disponible/.test(r), 'se asignó más de lo disponible')
  assert(await db.capitalLedger.count() === antes && (await estructura()).company.disponible === 5 * M, 'quedó un asiento o cambió el disponible')
  for (const [k, n] of [['cero', 0], ['negativo', -5], ['decimal', 10.5]] as const) {
    const x = await rechazo(() => allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: JUAN.id, amount: n }))
    assert(x !== 'ACEPTADO', `monto ${k} aceptado`)
  }
  await invariantes()
})

await spec('CAP-A-003', GA, 'retiro (devolución) válido: el SuperAdmin recoge 2M del disponible de Juan', async () => {
  await empresa()
  await returnCapitalFromAdmin({ actor: SA, tenantId: T, adminId: JUAN.id, amount: 2 * M, descripcion: 'Reajuste' })
  const j = await bolsa(JUAN.id)
  const s = await estructura()
  metric('Juan asignado / disponible', `${fmt(j.asignado)} / ${fmt(j.disponible)}`)
  metric('empresa disponible', fmt(s.company.disponible))
  assert(j.asignado === 18 * M && j.disponible === 18 * M && s.company.disponible === 7 * M && s.company.total === 50 * M, 'la devolución no cuadra')
  await invariantes()
})

await spec('CAP-A-004', GA, 'retiro imposible: el capital de Juan está comprometido en sus rutas', async () => {
  await empresa()
  await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 10 * M })
  await registerCapital({ actor: JUAN, tenantId: T, routeId: SUR, valor: 8 * M })
  const r = await rechazo(() => returnCapitalFromAdmin({ actor: SA, tenantId: T, adminId: JUAN.id, amount: 5 * M }))
  const j = await bolsa(JUAN.id)
  metric('Juan asignado / en rutas / disponible', `${fmt(j.asignado)} / ${fmt(j.enRutas)} / ${fmt(j.disponible)}`)
  metric('recoger 5M', r)
  assert(r !== 'ACEPTADO' && /solo tiene/.test(r), 'se recogió capital colocado en rutas')
  assert(j.asignado === 20 * M && j.enRutas === 18 * M && j.disponible === 2 * M, 'la bolsa no refleja lo colocado')
  await returnCapitalFromAdmin({ actor: SA, tenantId: T, adminId: JUAN.id, amount: 2 * M })
  assert((await bolsa(JUAN.id)).disponible === 0, 'no se pudo recoger exactamente el disponible')
  await invariantes()
})

await spec('CAP-A-005', GA, 'historial: cada asiento con id, tipo, monto, origen/destino, actor, rol, fecha, instante, estado y auditoría', async () => {
  await empresa()
  await returnCapitalFromAdmin({ actor: SA, tenantId: T, adminId: CARLOS.id, amount: 1 * M })
  await withdrawCompanyCapital({ actor: SA, tenantId: T, amount: 1 * M, descripcion: 'Dividendos' })
  const led = await listCapitalLedger({ actor: SA, tenantId: T })
  const audit = await db.auditLogs.where('entityType').equals('capitalLedger').toArray()
  metric('asientos', led.map(e => e.tipo).join(', '))
  metric('auditoría', audit.length)
  assert(led.length === 6, 'faltan asientos')
  for (const e of led) {
    assert(e.id && e.tipo && e.amount > 0 && e.actorUserId === SA.id && e.actorRole === 'superadmin' && e.fecha && e.createdAt && e.status === 'aplicado', `asiento incompleto ${e.id}`)
    if (e.tipo === 'ADMIN_ALLOCATION') assert(e.toAdminId && !e.fromAdminId, 'asignación sin destino')
    if (e.tipo === 'ADMIN_RETURN') assert(e.fromAdminId && !e.toAdminId, 'devolución sin origen')
  }
  assert(audit.length === 6, 'cada asiento debe dejar auditoría')
  const deJuan = await listCapitalLedger({ actor: JUAN, tenantId: T })
  metric('Juan ve', deJuan.map(e => e.tipo).join(', '))
  assert(deJuan.length === 1 && deJuan[0].toAdminId === JUAN.id, 'el Administrador ve asientos ajenos')
  await invariantes()
})

await spec('CAP-A-006', GA, 'solo el SuperAdmin asigna: Admin, Supervisor, otra empresa, Admin inactivo y no-Admin → rechazo', async () => {
  await empresa()
  const antes = await db.capitalLedger.count()
  await db.users.update(CARLOS.id, { status: 'inactivo' })
  const intentos: [string, () => Promise<unknown>][] = [
    ['Admin se asigna', () => allocateCapitalToAdmin({ actor: JUAN, tenantId: T, adminId: JUAN.id, amount: 1 })],
    ['Admin ingresa capital', () => registerCompanyCapital({ actor: JUAN, tenantId: T, amount: 1 })],
    ['Supervisor', () => allocateCapitalToAdmin({ actor: LAURA, tenantId: T, adminId: JUAN.id, amount: 1 })],
    ['SuperAdmin de otra empresa', () => allocateCapitalToAdmin({ actor: { ...SA, tenantId: TB }, tenantId: T, adminId: JUAN.id, amount: 1 })],
    ['a un Admin inactivo', () => allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: CARLOS.id, amount: 1 })],
    ['a un Cobrador', () => allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: FABIO.id, amount: 1 })],
    ['a un Admin de otra empresa', () => allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: AJENO.id, amount: 1 })],
    ['sin usuario', () => allocateCapitalToAdmin({ actor: null, tenantId: T, adminId: JUAN.id, amount: 1 })],
  ]
  for (const [k, fn] of intentos) {
    const r = await rechazo(fn)
    metric(k, r)
    assert(r !== 'ACEPTADO', `${k}: aceptado`)
  }
  assert(await db.capitalLedger.count() === antes, 'un rechazo escribió en el libro')
})

// ############################################################
// B — ADMINISTRADOR → RUTA
// ############################################################
const GB = 'B · Admin → Ruta'

await spec('CAP-B-001', GB, 'el responsable coloca capital: sale de su bolsa y entra a la Base de la ruta', async () => {
  await empresa()
  const mov = await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 8 * M })
  const j = await bolsa(JUAN.id)
  metric('Juan asignado / en rutas / disponible', `${fmt(j.asignado)} / ${fmt(j.enRutas)} / ${fmt(j.disponible)}`)
  metric('Base de Norte', fmt(await getRouteBase(NORTE)))
  assert(mov.adminId === JUAN.id && mov.userId === JUAN.id, 'el capital no quedó sellado con la bolsa de Juan')
  assert(j.asignado === 20 * M && j.enRutas === 8 * M && j.disponible === 12 * M && await getRouteBase(NORTE) === 8 * M, 'la colocación no cuadra')
  await invariantes()
})

await spec('CAP-B-002', GB, 'el responsable retira: el dinero vuelve a SU bolsa', async () => {
  await empresa()
  await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 8 * M })
  const w = await registerWithdrawal({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 3 * M })
  const j = await bolsa(JUAN.id)
  metric('Juan en rutas / disponible', `${fmt(j.enRutas)} / ${fmt(j.disponible)}`)
  assert(w.adminId === JUAN.id && j.enRutas === 5 * M && j.disponible === 15 * M && await getRouteBase(NORTE) === 5 * M, 'el retiro no volvió a la bolsa')
  await invariantes()
})

await spec('CAP-B-003', GB, 'saldo insuficiente: Juan no coloca más de su disponible', async () => {
  await empresa()
  await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 12 * M })
  const r = await rechazo(() => registerCapital({ actor: JUAN, tenantId: T, routeId: SUR, valor: 8 * M + 1 }))
  metric('colocar 8.000.001 con 8M', r)
  assert(r !== 'ACEPTADO' && /disponible no alcanza/.test(r), 'se colocó más del disponible')
  assert((await bolsa(JUAN.id)).disponible === 8 * M, 'cambió el disponible')
  await invariantes()
})

await spec('CAP-B-004', GB, 'Admin SECUNDARIO de la misma ruta: no coloca, no retira, no transfiere, no entrega Base', async () => {
  await empresa()
  await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 5 * M })
  const intentos: [string, () => Promise<unknown>][] = [
    ['capital', () => registerCapital({ actor: CARLOS, tenantId: T, routeId: NORTE, valor: 1 * M })],
    ['retiro', () => registerWithdrawal({ actor: CARLOS, tenantId: T, routeId: NORTE, valor: 1 })],
    ['transferencia Norte → Socio', () => registerTransfer({ actor: CARLOS, tenantId: T, origen: { type: 'route', id: NORTE }, destino: { type: 'partner', id: SOCIO.id }, valor: 1 })],
    ['entregar Base', () => assignBaseToWorker({ actor: CARLOS, tenantId: T, routeId: NORTE, recipientUserId: FABIO.id, amount: 1, motivo: 'Base' })],
  ]
  for (const [k, fn] of intentos) {
    const r = await rechazo(fn)
    metric(k, r)
    assert(r !== 'ACEPTADO' && /responsable del capital/.test(r), `${k}: el Admin secundario operó la caja`)
  }
  assert((await bolsa(CARLOS.id)).disponible === 15 * M && await getRouteBase(NORTE) === 5 * M, 'cambió una bolsa o la Base')
  assert(can(CARLOS, 'capital.manage', { routeId: NORTE, tenantId: T }), 'Carlos debe conservar sus capacidades administrativas')
})

await spec('CAP-B-005', GB, 'Admin de OTRA ruta y Admin sin rutas: rechazados', async () => {
  await empresa()
  for (const [k, actor] of [['María (Palmira)', MARIA], ['Nadia (sin rutas)', SIN_RUTA], ['Ajena (otra empresa)', AJENO]] as const) {
    const r = await rechazo(() => registerCapital({ actor, tenantId: T, routeId: NORTE, valor: 1 }))
    metric(k, r)
    assert(r !== 'ACEPTADO', `${k} colocó capital en Norte`)
  }
})

await spec('CAP-B-006', GB, 'Supervisor, Cobrador, Socio y Secretario: no manejan capital ni caja estructural', async () => {
  await empresa()
  await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 5 * M })
  for (const actor of [LAURA, FABIO, SOCIO, SECRE]) {
    const r = await Promise.all([
      rechazo(() => registerCapital({ actor, tenantId: T, routeId: NORTE, valor: 1 })),
      rechazo(() => registerWithdrawal({ actor, tenantId: T, routeId: NORTE, valor: 1 })),
      rechazo(() => assignBaseToWorker({ actor, tenantId: T, routeId: NORTE, recipientUserId: PEDRO.id, amount: 1, motivo: 'Base' })),
    ])
    metric(actor.rol, r.every(x => x !== 'ACEPTADO') ? 'rechazado' : r.join(' | '))
    assert(r.every(x => x !== 'ACEPTADO'), `${actor.rol} operó la caja estructural`)
  }
  assert(await getRouteBase(NORTE) === 5 * M, 'la Base cambió')
})

await spec('CAP-B-007', GB, 'ruta SIN responsable: nadie coloca ni retira (ni el SuperAdmin); se muestra "Sin responsable"', async () => {
  await empresa()
  const maria = { ...MARIA, authorizedRouteIds: [PALMIRA, HUERFANA] }   // asignada, pero sin responsable fijado
  await db.users.update(MARIA.id, { authorizedRouteIds: maria.authorizedRouteIds })
  const r1 = await rechazo(() => registerCapital({ actor: maria, tenantId: T, routeId: HUERFANA, valor: 1 }))
  const r2 = await rechazo(() => registerCapital({ actor: SA, tenantId: T, routeId: HUERFANA, valor: 1 }))
  const users0 = await users()
  const h = (await db.routes.get(HUERFANA))!
  metric('María', r1)
  metric('SuperAdmin', r2)
  assert(r1 !== 'ACEPTADO' && /no tiene Administrador responsable/.test(r1), 'la ruta sin responsable operó')
  assert(r2 !== 'ACEPTADO', 'el SuperAdmin operó una ruta sin responsable')
  assert((['structural', 'settle', 'correct'] as RouteCashOperation[]).every(op => !canOperateRouteCash(SA, h, op, users0) && !canOperateRouteCash(maria, h, op, users0)), 'la UI ofrecería operar')
  assert(/Sin responsable de capital/.test(src('src/components/ui/CapitalControllerBadge.tsx')), 'falta la etiqueta visible')
})

await spec('CAP-B-008', GB, 'no existe el atajo SuperAdmin → Ruta (capital, retiro, transferencia, capital inicial)', async () => {
  await empresa()
  await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 5 * M })
  const intentos: [string, () => Promise<unknown>][] = [
    ['capital', () => registerCapital({ actor: SA, tenantId: T, routeId: NORTE, valor: 1 })],
    ['retiro', () => registerWithdrawal({ actor: SA, tenantId: T, routeId: NORTE, valor: 1 })],
    ['Socio → Norte', () => registerTransfer({ actor: SA, tenantId: T, origen: { type: 'partner', id: SOCIO.id }, destino: { type: 'route', id: NORTE }, valor: 1 })],
    ['ruta nueva con capital inicial', () => createRouteWithAdmins({ tenantId: T, nombre: 'Nueva', tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 1, capitalInicial: 1 * M, codigo: 'N-9', adminIds: [JUAN.id] }, SA, routeDb, noop, noop)],
  ]
  for (const [k, fn] of intentos) {
    const r = await rechazo(fn)
    metric(k, r)
    assert(r !== 'ACEPTADO', `${k}: el SuperAdmin operó la ruta directamente`)
  }
  assert(!(await db.routes.toArray()).some(r => r.nombre === 'Nueva'), 'quedó una ruta a medias')
  await invariantes()
})

await spec('CAP-B-009', GB, 'concurrencia: dos colocaciones simultáneas no gastan el mismo disponible', async () => {
  await empresa()
  const r = await Promise.all([
    rechazo(() => registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 12 * M })),
    rechazo(() => registerCapital({ actor: JUAN, tenantId: T, routeId: SUR, valor: 12 * M })),
  ])
  const j = await bolsa(JUAN.id)
  metric('resultados', r.map(x => x === 'ACEPTADO' ? 'OK' : 'rechazo').join(' / '))
  metric('Juan disponible', fmt(j.disponible))
  assert(r.filter(x => x === 'ACEPTADO').length === 1, 'deberían aceptarse exactamente una')
  assert(j.disponible === 8 * M, 'el disponible quedó mal')
  const r2 = await Promise.all([
    rechazo(() => allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: JUAN.id, amount: 4 * M })),
    rechazo(() => allocateCapitalToAdmin({ actor: SA, tenantId: T, adminId: MARIA.id, amount: 4 * M })),
  ])
  metric('dos asignaciones de 4M con 5M', r2.map(x => x === 'ACEPTADO' ? 'OK' : 'rechazo').join(' / '))
  assert(r2.filter(x => x === 'ACEPTADO').length === 1 && (await estructura()).company.disponible === 1 * M, 'la empresa gastó dos veces su disponible')
  await invariantes()
})

// ############################################################
// C — MULTI-ADMIN
// ############################################################
const GC = 'C · Multi-Admin'

await spec('CAP-C-001', GC, 'la primera asignación crea al responsable (el primero seleccionado, persistido)', async () => {
  await empresa()
  const nueva = await createRouteWithAdmins({ tenantId: T, nombre: 'Cali 1', tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 1, capitalInicial: 0, codigo: 'C-1', adminIds: [CARLOS.id, JUAN.id, MARIA.id] }, SA, routeDb, noop, noop)
  const r = (await db.routes.get(nueva.id))!
  const ev = await listRouteControllerHistory({ actor: SA, tenantId: T, routeId: nueva.id })
  metric('responsable', r.capitalControllerAdminId)
  metric('evento', ev.map(e => `${e.kind}→${e.toAdminId}`).join(', '))
  assert(r.capitalControllerAdminId === CARLOS.id, 'el responsable no es el primer Admin seleccionado')
  assert(ev.length === 1 && ev[0].kind === 'FIRST_ADMIN' && ev[0].actorUserId === SA.id, 'falta el evento')
})

await spec('CAP-C-002', GC, 'un segundo Admin asignado NO reemplaza al responsable (Rutas, Usuarios y Oficinas)', async () => {
  await empresa()
  await updateRouteWithAssignments({
    routeId: SUR, tenantId: T, nombre: 'Sur', tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 1,
    assignedUserIds: [JUAN.id, MARIA.id], assignableUserIds: [JUAN.id, MARIA.id, CARLOS.id],
  }, SA, routeDb, noop)
  await withCapitalControllerGuard({ tenantId: T, actor: SA, routeIds: [SUR], preferredAdminIds: [CARLOS.id] },
    () => db.users.update(CARLOS.id, { authorizedRouteIds: [NORTE, SUR] }))
  const sur = (await db.routes.get(SUR))!
  metric('responsable de Sur', sur.capitalControllerAdminId)
  assert(sur.capitalControllerAdminId === JUAN.id, 'un Admin nuevo reemplazó al responsable')
  assert((await db.routeCapitalControllerEvents.count()) === 0, 'se registró un cambio inexistente')
})

await spec('CAP-C-003', GC, 'el SuperAdmin cambia el responsable; solo uno queda activo', async () => {
  await empresa()
  const ev = await setRouteCapitalController({ actor: SA, tenantId: T, routeId: NORTE, adminId: CARLOS.id, motivo: 'Rotación' })
  const n = (await db.routes.get(NORTE))!
  const us = await users()
  metric('responsable', n.capitalControllerAdminId)
  assert(n.capitalControllerAdminId === CARLOS.id && ev.fromAdminId === JUAN.id && ev.toAdminId === CARLOS.id, 'no cambió el responsable')
  assert(canOperateRouteCash(CARLOS, n, 'structural', us) && !canOperateRouteCash(JUAN, n, 'structural', us), 'quedaron dos con control')
  await invariantes()
})

await spec('CAP-C-004', GC, 'el historial conserva al responsable anterior (sin recalcular el pasado)', async () => {
  await empresa()
  const nueva = await createRouteWithAdmins({ tenantId: T, nombre: 'Cali 2', tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 1, capitalInicial: 0, codigo: 'C-2', adminIds: [JUAN.id, CARLOS.id] }, SA, routeDb, noop, noop)
  const antes = nowISO()
  await new Promise(r => setTimeout(r, 5))
  await setRouteCapitalController({ actor: SA, tenantId: T, routeId: nueva.id, adminId: CARLOS.id, motivo: 'Cambio' })
  const ev = await listRouteControllerHistory({ actor: SA, tenantId: T, routeId: nueva.id })
  metric('historial', ev.map(e => `${e.kind}: ${e.fromAdminId ?? '—'} → ${e.toAdminId}`).join(' | '))
  metric('responsable en el instante previo', capitalControllerAt(ev, nueva.id, antes))
  assert(ev.length === 2 && ev[1].kind === 'FIRST_ADMIN' && ev[0].kind === 'CHANGE', 'el historial no tiene ambos eventos')
  assert(capitalControllerAt(ev, nueva.id, antes) === JUAN.id && capitalControllerAt(ev, nueva.id, nowISO()) === CARLOS.id, 'el historial reescribe el pasado')
})

await spec('CAP-C-005', GC, 'el Administrador NO puede cambiar el responsable (ni por servicio ni por el editor)', async () => {
  await empresa()
  const r1 = await rechazo(() => setRouteCapitalController({ actor: CARLOS, tenantId: T, routeId: NORTE, adminId: CARLOS.id, motivo: 'Me lo quedo' }))
  const r2 = await rechazo(() => updateRouteWithAssignments({
    routeId: NORTE, tenantId: T, nombre: 'Norte', tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 1,
    assignedUserIds: [], assignableUserIds: [], capitalControllerAdminId: CARLOS.id,
  }, JUAN, routeDb, noop))
  metric('servicio', r1)
  metric('editor de ruta', r2)
  assert(r1 !== 'ACEPTADO' && r2 !== 'ACEPTADO' && (await db.routes.get(NORTE))!.capitalControllerAdminId === JUAN.id, 'un Admin cambió el responsable')
  assert(!can(JUAN, 'capital.assignController') && !isCapabilityCompatible('admin', 'capital.assignController'), 'la capacidad no es exclusiva del SuperAdmin')
})

// ############################################################
// D — CAMBIO DE RESPONSABLE
// ############################################################
const GD = 'D · Cambio de responsable'

await spec('CAP-D-001', GD, 'ruta sin saldo: el cambio no mueve capital', async () => {
  await empresa()
  const ev = await setRouteCapitalController({ actor: SA, tenantId: T, routeId: NORTE, adminId: CARLOS.id, motivo: 'Sin saldo' })
  metric('capital traspasado', ev.capitalTransferido)
  assert(ev.capitalTransferido === 0 && (await bolsa(JUAN.id)).asignado === 20 * M && (await bolsa(CARLOS.id)).asignado === 15 * M, 'se movió capital inexistente')
  await invariantes()
})

await spec('CAP-D-002', GD, 'ruta con saldo: el capital colocado viaja con la ruta (Juan −8M, Carlos +8M), disponibles intactos', async () => {
  await empresa()
  await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 8 * M })
  const totalAntes = (await estructura()).company.total
  const ev = await setRouteCapitalController({ actor: SA, tenantId: T, routeId: NORTE, adminId: CARLOS.id, motivo: 'Reorganización' })
  const j = await bolsa(JUAN.id)
  const c = await bolsa(CARLOS.id)
  metric('Juan asignado / en rutas / disponible', `${fmt(j.asignado)} / ${fmt(j.enRutas)} / ${fmt(j.disponible)}`)
  metric('Carlos asignado / en rutas / disponible', `${fmt(c.asignado)} / ${fmt(c.enRutas)} / ${fmt(c.disponible)}`)
  metric('evento', `${ev.capitalTransferido} · Base al cambio ${ev.baseAlCambio} · asiento ${ev.ledgerEntryId}`)
  assert(ev.capitalTransferido === 8 * M && ev.baseAlCambio === 8 * M && !!ev.ledgerEntryId, 'evento incompleto')
  assert(j.asignado === 12 * M && j.enRutas === 0 && j.disponible === 12 * M, 'Juan conserva capital de una ruta que ya no controla')
  assert(c.asignado === 23 * M && c.enRutas === 8 * M && c.disponible === 15 * M, 'Carlos no recibió la ruta con su capital')
  assert((await estructura()).company.total === totalAntes, 'el cambio creó o destruyó capital')
  await invariantes()
})

await spec('CAP-D-003', GD, 'nuevo Admin con o sin capacidad: el capital NO consume su disponible; sin asignación o inactivo → rechazo', async () => {
  await empresa()
  await returnCapitalFromAdmin({ actor: SA, tenantId: T, adminId: CARLOS.id, amount: 15 * M })   // Carlos sin capacidad
  await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 8 * M })
  await setRouteCapitalController({ actor: SA, tenantId: T, routeId: NORTE, adminId: CARLOS.id, motivo: 'Cambio' })
  const c = await bolsa(CARLOS.id)
  metric('Carlos (sin capacidad) asignado / disponible', `${fmt(c.asignado)} / ${fmt(c.disponible)}`)
  assert(c.disponible === 0 && c.enRutas === 8 * M, 'el traspaso consumió o creó disponible')
  const noAsignada = await rechazo(() => setRouteCapitalController({ actor: SA, tenantId: T, routeId: NORTE, adminId: MARIA.id, motivo: 'x x x' }))
  await db.users.update(JUAN.id, { status: 'inactivo' })
  const inactivo = await rechazo(() => setRouteCapitalController({ actor: SA, tenantId: T, routeId: NORTE, adminId: JUAN.id, motivo: 'x x x' }))
  const sinMotivo = await rechazo(() => setRouteCapitalController({ actor: SA, tenantId: T, routeId: NORTE, adminId: JUAN.id, motivo: '' }))
  metric('María (no asignada)', noAsignada)
  metric('Juan inactivo', inactivo)
  assert(noAsignada !== 'ACEPTADO' && inactivo !== 'ACEPTADO' && sinMotivo !== 'ACEPTADO', 'responsable inválido aceptado')
  await invariantes()
})

await spec('CAP-D-004', GD, 'atomicidad: si el evento falla, no cambia el responsable ni queda asiento', async () => {
  await empresa()
  await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 8 * M })
  const antes = await db.capitalLedger.count()
  const original = db.routeCapitalControllerEvents.add.bind(db.routeCapitalControllerEvents)
  ;(db.routeCapitalControllerEvents as { add: unknown }).add = () => Promise.reject(new Error('fallo simulado'))
  const r = await rechazo(() => setRouteCapitalController({ actor: SA, tenantId: T, routeId: NORTE, adminId: CARLOS.id, motivo: 'Cambio' }))
  ;(db.routeCapitalControllerEvents as { add: unknown }).add = original
  metric('respuesta', r)
  assert(r !== 'ACEPTADO', 'el fallo no se propagó')
  assert((await db.routes.get(NORTE))!.capitalControllerAdminId === JUAN.id && await db.capitalLedger.count() === antes, 'estado parcial tras el fallo')
  await invariantes()
})

await spec('CAP-D-005', GD, 'no duplica capital: idas y vueltas del responsable conservan el total y cada bolsa', async () => {
  await empresa()
  await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 6 * M })
  const total = (await estructura()).company.total
  await setRouteCapitalController({ actor: SA, tenantId: T, routeId: NORTE, adminId: CARLOS.id, motivo: 'Ida' })
  await registerCapital({ actor: CARLOS, tenantId: T, routeId: NORTE, valor: 1 * M })
  await setRouteCapitalController({ actor: SA, tenantId: T, routeId: NORTE, adminId: JUAN.id, motivo: 'Vuelta' })
  const j = await bolsa(JUAN.id)
  const c = await bolsa(CARLOS.id)
  metric('Juan / Carlos asignado', `${fmt(j.asignado)} / ${fmt(c.asignado)}`)
  assert((await estructura()).company.total === total, 'cambió el total')
  assert(j.enRutas === 7 * M && j.asignado === 21 * M && c.asignado === 14 * M && c.disponible === 14 * M, 'el capital no siguió a la ruta')
  await invariantes()
})

await spec('CAP-D-006', GD, 'históricos intactos: capital, cuadres y liquidaciones conservan al responsable de entonces', async () => {
  await empresa()
  const mov = await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 5 * M })
  await assignBaseToWorker({ actor: JUAN, tenantId: T, routeId: NORTE, recipientUserId: FABIO.id, amount: 100_000, motivo: 'Base' })
  const cuadre = await closeCashSettlement({ actor: JUAN, tenantId: T, routeId: NORTE, userId: FABIO.id, entregado: 100_000 }, db, noop)
  const semana = await closeSettlement({ actor: JUAN, tenantId: T, routeId: NORTE, semanaInicio: '2026-09-07', semanaFin: '2026-09-13' }, db as never, noop)
  await setRouteCapitalController({ actor: SA, tenantId: T, routeId: NORTE, adminId: CARLOS.id, motivo: 'Cambio' })
  const movDespues = (await db.capitalMovements.get(mov.id))!
  const cuadreDespues = (await db.cashSettlements.get(cuadre.id))!
  const semanaDespues = (await db.weeklySettlements.get(semana.id))!
  metric('capital / cuadre / liquidación', `${movDespues.adminId} / ${cuadreDespues.capitalControllerAdminIdAtClose} / ${semanaDespues.capitalControllerAdminIdAtClose}`)
  assert(JSON.stringify(movDespues) === JSON.stringify(mov), 'el capital histórico se modificó')
  assert(cuadreDespues.capitalControllerAdminIdAtClose === JUAN.id && semanaDespues.capitalControllerAdminIdAtClose === JUAN.id, 'el histórico apunta al responsable actual')
  const desdeAhora = await rechazo(() => registerWithdrawal({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 1 }))
  await registerWithdrawal({ actor: CARLOS, tenantId: T, routeId: NORTE, valor: 1 })
  metric('Juan tras el cambio', desdeAhora)
  assert(desdeAhora !== 'ACEPTADO', 'el responsable anterior sigue operando')
  await invariantes()
})

// ############################################################
// E — DESASIGNACIÓN
// ############################################################
const GE = 'E · Desasignación'
const editarNorte = (assigned: string[], extra: { capitalControllerAdminId?: string } = {}) => updateRouteWithAssignments({
  routeId: NORTE, tenantId: T, nombre: 'Norte', tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 1,
  assignedUserIds: assigned, assignableUserIds: [JUAN.id, CARLOS.id], ...extra,
}, SA, routeDb, noop)

await spec('CAP-E-001', GE, 'retirar a un Admin SECUNDARIO: normal; el responsable no cambia', async () => {
  await empresa()
  await editarNorte([JUAN.id])
  const n = (await db.routes.get(NORTE))!
  const carlos = (await db.users.get(CARLOS.id))!
  assert(!(carlos.authorizedRouteIds ?? []).includes(NORTE) && n.capitalControllerAdminId === JUAN.id, 'retiro del secundario incorrecto')
})

await spec('CAP-E-002', GE, 'retirar al RESPONSABLE quedando otros Admins: rechazado sin elegir otro; nada se guarda', async () => {
  await empresa()
  await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 5 * M })
  const r = await rechazo(() => editarNorte([CARLOS.id]))
  const g = await rechazo(() => withCapitalControllerGuard({ tenantId: T, actor: SA, routeIds: [NORTE, SUR] }, () => db.users.update(JUAN.id, { status: 'inactivo' })))
  const juan = (await db.users.get(JUAN.id))!
  metric('editor de ruta', r)
  metric('desactivar a Juan', g)
  assert(r !== 'ACEPTADO' && /debe elegir otro responsable/.test(r) && g !== 'ACEPTADO', 'se retiró al responsable sin elegir otro')
  assert((juan.authorizedRouteIds ?? []).includes(NORTE) && juan.status === 'activo' && (await db.routes.get(NORTE))!.capitalControllerAdminId === JUAN.id, 'quedó un estado parcial')
  await invariantes()
})

await spec('CAP-E-003', GE, 'reemplazar al responsable correctamente: se elige a Carlos en la misma operación', async () => {
  await empresa()
  await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 5 * M })
  await editarNorte([CARLOS.id], { capitalControllerAdminId: CARLOS.id })
  const n = (await db.routes.get(NORTE))!
  metric('responsable', n.capitalControllerAdminId)
  assert(n.capitalControllerAdminId === CARLOS.id && (await bolsa(CARLOS.id)).enRutas === 5 * M && (await bolsa(JUAN.id)).enRutas === 0, 'el reemplazo no traspasó el capital')
  await invariantes()
})

await spec('CAP-E-004', GE, 'último Admin de la ruta: queda SIN responsable, bloqueada; al asignar otro, reconoce el capital', async () => {
  await empresa()
  await registerCapital({ actor: MARIA, tenantId: T, routeId: PALMIRA, valor: 4 * M })
  await withCapitalControllerGuard({ tenantId: T, actor: SA, routeIds: [PALMIRA] }, () => db.users.update(MARIA.id, { authorizedRouteIds: [] }))
  const p = (await db.routes.get(PALMIRA))!
  const s = await estructura()
  const m = await bolsa(MARIA.id)
  metric('responsable', p.capitalControllerAdminId ?? 'ninguno')
  metric('sin responsable / María en rutas', `${fmt(s.company.sinResponsable)} / ${fmt(m.enRutas)}`)
  assert(!p.capitalControllerAdminId && s.company.sinResponsable === 4 * M && m.enRutas === 0 && m.disponible === 6 * M, 'la liberación no cuadra')
  await invariantes()
  const bloqueado = await rechazo(() => registerWithdrawal({ actor: SA, tenantId: T, routeId: PALMIRA, valor: 1 }))
  assert(bloqueado !== 'ACEPTADO', 'la ruta sin responsable operó')
  await withCapitalControllerGuard({ tenantId: T, actor: SA, routeIds: [PALMIRA], preferredAdminIds: [CARLOS.id] },
    () => db.users.update(CARLOS.id, { authorizedRouteIds: [NORTE, PALMIRA] }))
  const p2 = (await db.routes.get(PALMIRA))!
  metric('nuevo responsable', p2.capitalControllerAdminId)
  assert(p2.capitalControllerAdminId === CARLOS.id && (await bolsa(CARLOS.id)).enRutas === 4 * M && (await estructura()).company.sinResponsable === 0, 'no reconoció el capital al nuevo responsable')
  const ev = await listRouteControllerHistory({ actor: SA, tenantId: T, routeId: PALMIRA })
  assert(ev.map(e => e.kind).join(',') === 'FIRST_ADMIN,RELEASE', 'historial de la liberación incompleto')
  await invariantes()
})

// ############################################################
// F — MIGRACIÓN
// ############################################################
const GF = 'F · Migración'
const legacyRows = {
  ledger: [],
  capitalMovements: [
    { routeId: NORTE, valor: 7 * M }, { routeId: SUR, valor: 3 * M }, { routeId: HUERFANA, valor: 2 * M },
  ],
  withdrawals: [{ routeId: NORTE, valor: 1 * M }],
  transfers: [{ routeOrigenId: SUR, routeDestinoId: NORTE, valor: 500_000 }],
}
const legacyRoutes = [ruta(NORTE, 'Norte'), ruta(SUR, 'Sur'), ruta(PALMIRA, 'Palmira'), ruta(HUERFANA, 'Huérfana')]
const legacyLogs = [
  // Carlos fue asignado a Norte ANTES que Juan, aunque la lista de usuarios diga otra cosa.
  { action: 'ASSIGN_ROUTE', routeId: NORTE, entityId: CARLOS.id, createdAt: '2026-08-01T00:00:00.000Z' },
  { action: 'ASSIGN_ROUTE', routeId: NORTE, entityId: JUAN.id, createdAt: '2026-08-05T00:00:00.000Z' },
]
const plan = () => planCapitalMigrationV16({
  routes: legacyRoutes.map(r => ({ ...r })), users: [JUAN, CARLOS, MARIA, LAURA], auditLogs: legacyLogs, rows: legacyRows as never, now: '2026-10-07T00:00:00.000Z',
})

await spec('CAP-F-001', GF, 'ruta con UN Admin → ese es el responsable', async () => {
  const p = plan()
  const sur = p.routeUpdates.find(u => u.id === SUR)
  const pal = p.routeUpdates.find(u => u.id === PALMIRA)
  metric('Sur / Palmira', `${sur?.capitalControllerAdminId} / ${pal?.capitalControllerAdminId}`)
  assert(sur?.capitalControllerAdminId === JUAN.id && pal?.capitalControllerAdminId === MARIA.id, 'responsable inicial incorrecto')
})

await spec('CAP-F-002', GF, 'ruta con VARIOS Admins → el primero según la auditoría (no el orden del array)', async () => {
  const p = plan()
  const invertido = planCapitalMigrationV16({ routes: legacyRoutes.map(r => ({ ...r })), users: [CARLOS, MARIA, JUAN], auditLogs: legacyLogs, rows: legacyRows as never, now: '2026-10-07T00:00:00.000Z' })
  const sinLogs = planCapitalMigrationV16({ routes: legacyRoutes.map(r => ({ ...r })), users: [CARLOS, JUAN], auditLogs: [], rows: legacyRows as never, now: '2026-10-07T00:00:00.000Z' })
  const norte = (pl: typeof p) => pl.routeUpdates.find(u => u.id === NORTE)?.capitalControllerAdminId
  metric('con auditoría (dos órdenes de usuarios)', `${norte(p)} / ${norte(invertido)}`)
  metric('sin auditoría (usuario creado antes)', norte(sinLogs))
  assert(norte(p) === CARLOS.id && norte(invertido) === CARLOS.id, 'la migración depende del orden del array')
  assert(norte(sinLogs) === JUAN.id, 'sin auditoría debe ganar el Admin creado antes')
})

await spec('CAP-F-003', GF, 'ruta SIN Admin → sin responsable (no se inventa ninguno)', async () => {
  const p = plan()
  metric('sin responsable', p.sinResponsable.join(', '))
  assert(p.sinResponsable.includes(HUERFANA) && !p.routeUpdates.some(u => u.id === HUERFANA), 'se inventó un responsable')
})

await spec('CAP-F-004', GF, 'capital existente reconocido sin duplicar: Σ bolsas + sin responsable = capital histórico', async () => {
  const p = plan()
  const migradas = legacyRoutes.map(r => ({ ...r, capitalControllerAdminId: p.routeUpdates.find(u => u.id === r.id)?.capitalControllerAdminId }))
  const filas = { ...legacyRows, ledger: p.ledger, routes: migradas } as never
  const s = computeCapitalStructure(filas, [JUAN.id, CARLOS.id, MARIA.id])
  const issues = verifyCapitalInvariants(filas, [JUAN.id, CARLOS.id, MARIA.id])
  metric('reconocido Norte / Sur', p.ledger.map(e => `${e.routeId}:${e.amount}`).join(', '))
  metric('total / histórico / sin responsable', `${s.company.total} / ${s.company.historicoPreV16} / ${s.company.sinResponsable}`)
  assert(s.company.total === 11 * M && s.company.historicoPreV16 === 11 * M && s.company.sinResponsable === 2 * M, 'el capital no se conservó')
  assert(p.ledger.find(e => e.routeId === NORTE)?.amount === 6_500_000 && p.ledger.find(e => e.routeId === SUR)?.amount === 2_500_000, 'reconocimiento por ruta incorrecto')
  assert(issues.length === 0, issues.join(' | '))
})

await spec('CAP-F-005', GF, 'determinista e idempotente: mismos IDs; re-ejecutar sobre datos migrados no crea nada', async () => {
  const a = plan(); const b = plan()
  const migradas = legacyRoutes.map(r => ({ ...r, capitalControllerAdminId: a.routeUpdates.find(u => u.id === r.id)?.capitalControllerAdminId }))
  const otraVez = planCapitalMigrationV16({ routes: migradas, users: [JUAN, CARLOS, MARIA], auditLogs: legacyLogs, rows: { ...legacyRows, ledger: a.ledger } as never, now: '2026-10-08T00:00:00.000Z' })
  assert(JSON.stringify(a) === JSON.stringify(b), 'el plan no es determinista')
  assert(otraVez.routeUpdates.length === 0 && otraVez.ledger.length === 0 && otraVez.events.length === 0, 're-ejecutar duplica')
})

await spec('CAP-F-006', GF, 'Dexie real v15 → v16: responsables, reconocimiento y datos previos intactos', async () => {
  db.close()
  await Dexie.delete('RutaCashDB')
  const tmp = new RutaCashDB(); await tmp.open()
  const esquema: Record<string, string> = {}
  for (const t of tmp.tables) esquema[t.name] = [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(', ')
  tmp.close(); await Dexie.delete('RutaCashDB')
  delete esquema.capitalLedger; delete esquema.routeCapitalControllerEvents
  esquema.routes = esquema.routes.replace(', capitalControllerAdminId', '')
  const v15 = new Dexie('RutaCashDB'); v15.version(15).stores(esquema); await v15.open()
  await v15.table('routes').bulkAdd(legacyRoutes.map(r => { const { capitalControllerAdminId: _x, ...rest } = r; return rest }))
  await v15.table('users').bulkAdd([JUAN, CARLOS, MARIA])
  await v15.table('auditLogs').bulkAdd(legacyLogs.map((l, i) => ({ ...l, id: `log-${i}`, tenantId: T, userId: SA.id, entityType: 'User', descripcion: '' })))
  await v15.table('capitalMovements').bulkAdd(legacyRows.capitalMovements.map((m, i) => ({ ...m, id: `cap-${i}`, tenantId: T, tipo: 'ingresoCapital', fecha: '2026-08-01', userId: SA.id, createdAt: '' })))
  await v15.table('withdrawals').bulkAdd(legacyRows.withdrawals.map((w, i) => ({ ...w, id: `wd-${i}`, tenantId: T, fecha: '2026-08-02', userId: SA.id, createdAt: '' })))
  const previos = JSON.stringify(await Promise.all(['capitalMovements', 'withdrawals', 'users'].map(t => v15.table(t).toArray())))
  v15.close()
  const v16 = new RutaCashDB(); await v16.open()
  const rutas = await v16.routes.toArray()
  const ledger = await v16.capitalLedger.toArray()
  const eventos = await v16.routeCapitalControllerEvents.toArray()
  const despues = JSON.stringify(await Promise.all([v16.capitalMovements.toArray(), v16.withdrawals.toArray(), v16.users.toArray()]))
  metric('versión', v16.verno)
  metric('responsables', rutas.map(r => `${r.nombre}:${r.capitalControllerAdminId ?? '—'}`).join(', '))
  metric('asientos / eventos', `${ledger.length} / ${eventos.length}`)
  assert(v16.verno === 16, 'no migró a v16')
  assert(rutas.find(r => r.id === NORTE)?.capitalControllerAdminId === CARLOS.id && !rutas.find(r => r.id === HUERFANA)?.capitalControllerAdminId, 'responsables migrados incorrectos')
  assert(ledger.length === 2 && eventos.length === 3 && eventos.every(e => e.kind === 'MIGRATION' && e.actorUserId === 'system:migration-v16'), 'reconocimiento/eventos incorrectos')
  assert(despues === previos, 'la migración modificó capital, retiros o usuarios')
  v16.close()
  await db.open()
})

// ############################################################
// G — UI / PERMISOS
// ############################################################
const GG = 'G · UI y permisos'

await spec('CAP-G-001', GG, 'matriz de autoridad sobre la caja de la ruta (antes / después)', async () => {
  await empresa()
  const n = (await db.routes.get(NORTE))!
  const h = (await db.routes.get(HUERFANA))!
  const us = await users()
  const fila = (u: User, r: Route) => (['structural', 'settle', 'correct'] as RouteCashOperation[]).map(op => canOperateRouteCash(u, r, op, us) ? 'sí' : 'no').join('/')
  const esperado: [string, User, Route, string][] = [
    ['SuperAdmin', SA, n, 'no/sí/sí'],
    ['Admin responsable', JUAN, n, 'sí/sí/sí'],
    ['Admin secundario', CARLOS, n, 'no/no/no'],
    ['Admin de otra ruta', MARIA, n, 'no/no/no'],
    ['Supervisor de la ruta', LAURA, n, 'no/sí/no'],
    ['Cobrador', FABIO, n, 'no/no/no'],
    ['Socio', SOCIO, n, 'no/no/no'],
    ['Secretario', SECRE, n, 'no/no/no'],
    ['Usuario sin ruta', SIN_RUTA, n, 'no/no/no'],
    ['Otra empresa', AJENO, n, 'no/no/no'],
    ['Ruta sin responsable · SuperAdmin', SA, h, 'no/no/no'],
  ]
  metric('operación', 'estructural / cuadre / corrección')
  for (const [k, u, r, e] of esperado) {
    const real = fila(u, r)
    metric(k, real)
    assert(real === e, `${k}: ${real} (esperado ${e})`)
  }
  assert(routeCashAuthorityError(null, n, 'settle', us) !== null, 'sin usuario no falla cerrado')
  const inactivo = { ...JUAN, status: 'inactivo' as const }
  assert(!canOperateRouteCash(inactivo, n, 'structural', [...us.filter(u => u.id !== JUAN.id), inactivo]), 'responsable inactivo conserva control')
})

await spec('CAP-G-002', GG, 'capacidades nuevas: solo SuperAdmin; ningún rol puede recibirlas por delegación', async () => {
  for (const rol of ['admin', 'socio', 'supervisor', 'cobrador', 'secretario'] as const) {
    assert(!isCapabilityCompatible(rol, 'capital.allocateAdmins') && !isCapabilityCompatible(rol, 'capital.assignController'), `${rol} puede recibirlas`)
    assert(sanitizeGrantedCapabilities(rol, ['capital.allocateAdmins', 'capital.assignController']).length === 0, `${rol}: la delegación no se depura`)
  }
  const forjado = { ...JUAN, grantedCapabilities: ['capital.allocateAdmins'] }
  assert(can(SA, 'capital.allocateAdmins', { tenantId: T }) && can(SA, 'capital.assignController', { tenantId: T }) && !can(forjado, 'capital.allocateAdmins'), 'matriz de capacidades incorrecta')
})

await spec('CAP-G-003', GG, 'la UI ofrece acciones solo donde corresponde (y el dominio valida igual)', async () => {
  await empresa()
  const rts = await db.routes.where('tenantId').equals(T).toArray()
  const us = await users()
  const ofrece = (u: User) => rts.filter(r => canManageRouteFunds(u, r, T, us)).map(r => r.nombre).sort().join(',') || '—'
  metric('Juan / Carlos / María / SuperAdmin / Laura', `${ofrece(JUAN)} | ${ofrece(CARLOS)} | ${ofrece(MARIA)} | ${ofrece(SA)} | ${ofrece(LAURA)}`)
  assert(ofrece(JUAN) === 'Norte,Sur' && ofrece(CARLOS) === '—' && ofrece(MARIA) === 'Palmira' && ofrece(SA) === '—' && ofrece(LAURA) === '—', 'la UI ofrece rutas ajenas')
  const capital = src('src/pages/admin/CapitalPage.tsx')
  const retiros = src('src/pages/admin/WithdrawalsPage.tsx')
  const rutas = src('src/pages/admin/RoutesPage.tsx')
  const panel = src('src/components/settlement/WorkerCashSettlementPanel.tsx')
  assert(/data-testid="admins-capital"/.test(capital) && /Asignar a Administrador/.test(capital) && !/Inyectar capital/.test(capital), 'Capital no empieza por los Administradores')
  assert(/getCapitalOverview\(/.test(capital) && !/db\.capitalMovements\.add|db\.capitalLedger\.add/.test(capital), 'Capital escribe o calcula por su cuenta')
  assert(/rutasControladas\.map/.test(retiros), 'Retiros ofrece rutas no controladas')
  assert(/Responsable de capital/.test(rutas) && /capitalControllerAdminId: puedeElegirResponsable/.test(rutas), 'Rutas no muestra/elige al responsable')
  assert(/puedeEntregarBase = custodia && canOperateRouteCash\(user, ruta, 'structural'/.test(panel), 'el panel ofrece entregar Base sin ser responsable')
  const ov = await getCapitalOverview({ actor: CARLOS, tenantId: T })
  assert(ov.admins.length === 1 && ov.admins[0].adminId === CARLOS.id && ov.routes.length === 0 && ov.company.total === 0, 'un Admin ve bolsas ajenas o la de la empresa')
  const r = await rechazo(() => getCapitalOverview({ actor: LAURA, tenantId: T }))
  assert(r !== 'ACEPTADO', 'el Supervisor ve el capital')
})

// ############################################################
// H — TRASPASO ENTRE TRABAJADORES
// ############################################################
const GH = 'H · Traspaso entre trabajadores'

await spec('CAP-H-001', GH, 'Transferencias ya no tiene el botón "Traspaso entre trabajadores" que llevaba a Liquidación', async () => {
  const t = src('src/pages/admin/TransfersPage.tsx')
  metric('botón', /Traspaso entre trabajadores<\/Button>/.test(t) ? 'presente' : 'retirado')
  assert(!/Traspaso entre trabajadores<\/Button>/.test(t) && !/irATraspaso|useNavigate|weekly-settlement\?vista=trabajadores/.test(t), 'sigue el acceso confuso')
  const panel = src('src/components/settlement/WorkerCashSettlementPanel.tsx')
  assert(/Traspasar a otro trabajador/.test(panel) && /transferBaseBetweenWorkers\(/.test(panel), 'la operación real desapareció del cuadre')
})

await spec('CAP-H-002', GH, 'la lógica real se conserva: responsable y Supervisor traspasan; Admin secundario no', async () => {
  await empresa()
  await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 1 * M })
  await assignBaseToWorker({ actor: JUAN, tenantId: T, routeId: NORTE, recipientUserId: FABIO.id, amount: 300_000, motivo: 'Base' })
  const t1 = await transferBaseBetweenWorkers({ actor: JUAN, tenantId: T, routeId: NORTE, fromUserId: FABIO.id, toUserId: PEDRO.id, amount: 100_000, motivo: 'Apoyo' })
  const t2 = await transferBaseBetweenWorkers({ actor: LAURA, tenantId: T, routeId: NORTE, fromUserId: FABIO.id, toUserId: PEDRO.id, amount: 50_000, motivo: 'Apoyo' })
  const r = await rechazo(() => transferBaseBetweenWorkers({ actor: CARLOS, tenantId: T, routeId: NORTE, fromUserId: FABIO.id, toUserId: PEDRO.id, amount: 1, motivo: 'Apoyo' }))
  const dev = await returnBaseFromWorker({ actor: LAURA, tenantId: T, routeId: NORTE, fromUserId: PEDRO.id, amount: 150_000, motivo: 'Devolución' })
  metric('Juan / Laura / Carlos', `${t1.tipo} / ${t2.tipo} / ${r}`)
  assert(t1.tipo === 'PERSON_TO_PERSON' && t2.tipo === 'PERSON_TO_PERSON' && dev.tipo === 'BASE_RETURN', 'se perdió la operación')
  assert(r !== 'ACEPTADO', 'el Admin secundario traspasó')
  assert(await getRouteBase(NORTE) === 1 * M, 'el traspaso movió la Base')
})

// ############################################################
// I — REGRESIONES
// ############################################################
const GI = 'I · Regresiones'

await spec('CAP-I-001', GI, 'cuadre por trabajador: responsable y Supervisor cierran; Admin secundario no; SuperAdmin reabre', async () => {
  await empresa()
  await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 1 * M })
  await assignBaseToWorker({ actor: JUAN, tenantId: T, routeId: NORTE, recipientUserId: FABIO.id, amount: 200_000, motivo: 'Base' })
  await assignBaseToWorker({ actor: JUAN, tenantId: T, routeId: NORTE, recipientUserId: PEDRO.id, amount: 100_000, motivo: 'Base' })
  const sec = await rechazo(() => closeCashSettlement({ actor: CARLOS, tenantId: T, routeId: NORTE, userId: FABIO.id, entregado: 200_000 }, db, noop))
  const c1 = await closeCashSettlement({ actor: JUAN, tenantId: T, routeId: NORTE, userId: FABIO.id, entregado: 200_000 }, db, noop)
  const c2 = await closeCashSettlement({ actor: LAURA, tenantId: T, routeId: NORTE, userId: PEDRO.id, entregado: 100_000 }, db, noop)
  metric('Admin secundario', sec)
  assert(sec !== 'ACEPTADO' && c1.status === 'cerrada' && c2.status === 'cerrada', 'autoridad de cuadre incorrecta')
  const { reopenCashSettlement } = await import('../src/services/cashSettlementService')
  const rLaura = await rechazo(() => reopenCashSettlement({ actor: LAURA, settlementId: c2.id, motivo: 'Error de conteo' }, db, noop))
  const re = await reopenCashSettlement({ actor: SA, settlementId: c2.id, motivo: 'Error de conteo' }, db, noop)
  assert(rLaura !== 'ACEPTADO' && re.status === 'reabierta', 'reapertura con autoridad incorrecta')
})

await spec('CAP-I-002', GI, 'liquidación semanal: la cierra el responsable o el SuperAdmin; el Admin secundario no', async () => {
  await empresa()
  const sec = await rechazo(() => closeSettlement({ actor: CARLOS, tenantId: T, routeId: NORTE, semanaInicio: '2026-09-07', semanaFin: '2026-09-13' }, db as never, noop))
  const ok = await closeSettlement({ actor: SA, tenantId: T, routeId: NORTE, semanaInicio: '2026-09-07', semanaFin: '2026-09-13' }, db as never, noop)
  metric('Admin secundario', sec)
  assert(sec !== 'ACEPTADO' && ok.capitalControllerAdminIdAtClose === JUAN.id, 'autoridad de liquidación incorrecta')
})

await spec('CAP-I-003', GI, 'anulaciones: SuperAdmin y responsable sí (a la bolsa del responsable ACTUAL); secundario no', async () => {
  await empresa()
  const cap = await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 3 * M })
  const w = await registerWithdrawal({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 1 * M })
  const sec = await rechazo(() => reverseCapitalMovement({ actor: CARLOS, tenantId: T, movementId: cap.id, reason: 'Error' }))
  await setRouteCapitalController({ actor: SA, tenantId: T, routeId: NORTE, adminId: CARLOS.id, motivo: 'Cambio' })
  const { reversal: rw } = await reverseWithdrawal({ actor: SA, tenantId: T, movementId: w.id, reason: 'Retiro duplicado' })
  const { reversal: rc } = await reverseCapitalMovement({ actor: CARLOS, tenantId: T, movementId: cap.id, reason: 'Error' })
  const c = await bolsa(CARLOS.id)
  metric('secundario (antes del cambio)', sec)
  metric('reversiones atribuidas a', `${rw.adminId} / ${rc.adminId}`)
  metric('Carlos en rutas / disponible', `${fmt(c.enRutas)} / ${fmt(c.disponible)}`)
  assert(sec !== 'ACEPTADO' && rw.adminId === CARLOS.id && rc.adminId === CARLOS.id, 'atribución de la anulación incorrecta')
  // Carlos recibió Norte con 2M netos (3M − 1M). Anuladas ambas, la ruta queda en 0 y
  // esos 2M terminan en SU disponible: 15M propios + 2M recibidos con la ruta.
  assert(c.enRutas === 0 && c.asignado === 17 * M && c.disponible === 17 * M && await getRouteBase(NORTE) === 0, 'las anulaciones no cuadran con la bolsa del responsable')
  assert((await bolsa(JUAN.id)).asignado === 18 * M && (await estructura()).company.total === 50 * M, 'las anulaciones crearon o destruyeron capital')
  await invariantes()
})

await spec('CAP-I-004', GI, 'transferencias Ruta → Ruta: mismo responsable sí (sin cambiar bolsas); responsables distintos no', async () => {
  await empresa()
  await registerCapital({ actor: JUAN, tenantId: T, routeId: NORTE, valor: 5 * M })
  const { transfer } = await registerTransfer({ actor: JUAN, tenantId: T, origen: { type: 'route', id: NORTE }, destino: { type: 'route', id: SUR }, valor: 2 * M })
  const cruce = await rechazo(() => registerTransfer({ actor: JUAN, tenantId: T, origen: { type: 'route', id: NORTE }, destino: { type: 'route', id: PALMIRA }, valor: 1 }))
  const j = await bolsa(JUAN.id)
  metric('Norte → Sur', `${transfer.valor} · adminId ${transfer.adminId}`)
  metric('Norte → Palmira (María)', cruce)
  assert(transfer.adminId === JUAN.id && j.enRutas === 5 * M && j.rutas.find(r => r.routeId === SUR)?.colocado === 2 * M, 'el traslado no quedó en la bolsa de Juan')
  assert(cruce !== 'ACEPTADO', 'se movió capital entre bolsas de Administradores sin el SuperAdmin')
  await invariantes()
})

await spec('CAP-I-005', GI, 'caja de socios intacta: aporte de socio a la ruta del responsable no altera bolsas', async () => {
  await empresa()
  const antes = await bolsa(JUAN.id)
  const { partnerMovements } = await registerTransfer({ actor: JUAN, tenantId: T, origen: { type: 'partner', id: SOCIO.id }, destino: { type: 'route', id: NORTE }, valor: 700_000 })
  const despues = await bolsa(JUAN.id)
  assert(partnerMovements.length === 1 && JSON.stringify(antes) === JSON.stringify(despues) && await getRouteBase(NORTE) === 700_000, 'el aporte de socio alteró la bolsa o la Caja socios')
  await invariantes()
})

// ============================================================
// Informe
// ============================================================
console.log('\n════════════════════════════════════════════════════════════════')
console.log('  RUTACASH · CAPITAL POR ADMINISTRADOR (v16)')
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
void today
