// ============================================================
// ADEX — SUITE RONDA 6/6C.1: CIERRES, ANULACIONES Y CAJA DE LA RUTA
// ------------------------------------------------------------
//   npm run test:periodauthority
//
// Servicios de producción sobre el singleton `db` (Dexie + fake-indexeddb), datos
// sintéticos. Decisiones que se prueban:
//   D29  un periodo solo se cierra cuando terminó (fin del propio rango).
//   D30  la caja de la ruta solo la usa su Administrador responsable de capital o
//        el SuperAdmin de la empresa; nunca un Administrador solo asociado.
//   D7   una anulación es un asiento NUEVO: no entra en una semana cerrada, conserva
//        el original y su vínculo, y no altera las cifras archivadas.
// Todo rechazo se comprueba con la base COMPLETA antes/después (cero escrituras).
// Familias: WEEK, AUTHBOX, REVPER. Cualquier fallo → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import { sembrarResponsables } from './financial/capitalFixture'
import { registerCapital, registerTransfer, registerWithdrawal } from '../src/services/routeFundsService'
import { assignBaseToWorker } from '../src/services/cashCustodyService'
import { createExpense, reverseAdminExpense } from '../src/services/expenseService'
import { registerPayment } from '../src/services/paymentService'
import { annulPayment, approvePaymentAdjustment, correctPayment, requestPaymentAdjustment } from '../src/services/paymentCorrectionService'
import { reverseCapitalMovement, reverseTransfer, reverseWithdrawal } from '../src/services/movementReversalService'
import { closeSettlement } from '../src/services/settlementService'
import { generateWeeklySettlement } from '../src/services/weeklySettlementEngine'
import { setRouteCapitalController } from '../src/services/capitalControlService'
import { getRouteCashReconciliation, computeRouteCashReconciliation } from '../src/services/routeCashReconciliation'
import {
  approveSaleRequest, confirmDisbursement, createDirectSale, createSaleRequest, type SaleInputs,
} from '../src/services/saleRequestService'
import { getRouteBase } from '../src/services/cashboxEngine'
import { periodClosableFrom, periodNotEndedReason } from '../src/lib/settlementPeriods'
import { can } from '../src/lib/permissions'
import { addDays, nowISO, today } from '../src/lib/formatters'
import type { Sale, User, WeeklySettlement } from '../src/models/types'
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

// ============================================================
// Escenario
// ============================================================
const T = 't-6c1'
const TB = 't-otra'
const R1 = 'r-uno'
const R2 = 'r-dos'
const RB = 'r-otra'
const CAT = 'cat-6c1'
const HOY = today()
const AYER = addDays(HOY, -1)
const PASADA = { semanaInicio: addDays(HOY, -7), semanaFin: AYER }          // ya terminó
const VIGENTE = { semanaInicio: addDays(HOY, -2), semanaFin: HOY }          // termina hoy: aún vigente
const persona = (id: string, nombre: string, rol: User['rol'], rutas: string[], tenantId = T): User => ({
  id, tenantId, nombre, email: `${id}@6c1.test`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)
const SA = persona('u-sa', 'Sara SuperAdmin', 'superadmin', [])
const SA_OTRA = persona('u-sa-b', 'Sergio SuperAdmin Otra', 'superadmin', [], TB)
const ADMIN = persona('u-admin', 'Andrés Admin (responsable)', 'admin', [R1])
const ADMIN_B = persona('u-admin-b', 'Beatriz Admin (asociada)', 'admin', [R1])
const ADMIN_2 = persona('u-admin-2', 'Darío Admin Dos', 'admin', [R2])
const JUAN = persona('u-juan', 'Juan Cobrador', 'cobrador', [R1])
const LAURA = persona('u-laura', 'Laura Supervisora', 'supervisor', [R1])
const SECRE = persona('u-secre', 'Sergio Secretario', 'secretario', [R1])
const SOCIO = persona('u-socio', 'Hernán Socio', 'socio', [R1])

async function empresa(capitalInicial = 5000) {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.bulkAdd([
    { id: T, nombre: '6C1', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z' },
    { id: TB, nombre: 'Otra', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z' },
  ] as never[])
  await db.offices.bulkAdd([
    { id: 'of-1', tenantId: T, nombre: 'Of', codigo: 'OF', status: 'activa', createdAt: '', updatedAt: '' },
    { id: 'of-b', tenantId: TB, nombre: 'OfB', codigo: 'OB', status: 'activa', createdAt: '', updatedAt: '' },
  ] as never[])
  const ruta = (id: string, nombre: string, tenantId = T, officeId = 'of-1') => ({ id, tenantId, officeId, nombre, codigo: id, status: 'activa', capitalInicial: 0, capitalActual: 0, tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 0, createdAt: '2026-09-01' })
  await db.routes.bulkAdd([ruta(R1, 'Uno'), ruta(R2, 'Dos'), ruta(RB, 'Otra', TB, 'of-b')] as never[])
  await db.users.bulkAdd([SA, SA_OTRA, ADMIN, ADMIN_B, ADMIN_2, JUAN, LAURA, SECRE, SOCIO])
  await db.expenseCategories.add({ id: CAT, tenantId: T, nombre: 'Papelería', activa: true } as never)
  // Andrés es el responsable de capital de Uno; Beatriz está asignada a Uno, sin serlo.
  await sembrarResponsables(db, T, { [R1]: ADMIN.id, [R2]: ADMIN_2.id })
  if (capitalInicial > 0) await capital(capitalInicial)
}
const capital = (valor: number, fecha?: string) => registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor, fecha })
const darBase = (u: User, amount: number) =>
  assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R1, recipientUserId: u.id, amount, motivo: 'Base para operar' })

let cli = 0
async function entrada(by: User, valor: number): Promise<SaleInputs> {
  const clientId = `cli-${++cli}`
  await db.clients.add({ id: clientId, tenantId: T, routeId: R1, nombre: clientId, documento: clientId, status: 'activo', createdAt: '' } as never)
  return { tenantId: T, routeId: R1, clientId, createdByUserId: by.id, valorVenta: valor, tasaInteres: 20, numeroCuotas: 10, frecuenciaPago: 'diaria', fechaInicio: HOY, paymentDays: [0, 1, 2, 3, 4, 5, 6] }
}
async function aprobada(by: User, valor: number): Promise<Sale> {
  const req = await createSaleRequest(await entrada(by, valor), by)
  return approveSaleRequest(req.id, LAURA)
}
async function credito(valor = 1000): Promise<Sale> {
  const s = await aprobada(JUAN, valor)
  await darBase(JUAN, valor)
  await confirmDisbursement(s.id, JUAN)
  return (await db.sales.get(s.id))!
}
async function pagar(s: Sale, valor: number, fecha?: string) {
  const r = await registerPayment({ saleId: s.id, requestedAmount: valor, actor: JUAN, fecha })
  if (!r.ok) throw new Error(`pago rechazado: ${r.code} ${r.message}`)
  return (await db.payments.get(r.paymentId))!
}
/** Cierre ANTICIPADO histórico (anterior a D29): el servicio ya no lo crea, pero existe en datos reales. */
async function cierreAnticipadoHistorico(semanaInicio: string, semanaFin: string, routeId = R1) {
  const calculo = await generateWeeklySettlement({ tenantId: T, routeId, semanaInicio, semanaFin })
  await db.weeklySettlements.add({ ...calculo, status: 'cerrada', closedAt: nowISO(), closedByUserId: ADMIN.id, createdByUserId: ADMIN.id, version: 1 } as never)
}
async function rechazo(fn: () => Promise<unknown>): Promise<unknown> {
  try { const r = await fn(); return (r && typeof r === 'object' && 'success' in r && (r as { success: boolean }).success === false) ? new Error((r as { error?: string }).error) : 'ACEPTADO' } catch (e) { return e }
}
const texto = (e: unknown) => e === 'ACEPTADO' ? 'ACEPTADO' : e instanceof Error ? `${e.name}: ${e.message}` : String(e)
async function foto(): Promise<string> {
  const partes: Record<string, unknown[]> = {}
  for (const t of db.tables) partes[t.name] = (await t.toArray()).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return JSON.stringify(partes)
}
async function sinEfecto(fn: () => Promise<unknown>): Promise<unknown> {
  const antes = await foto()
  const e = await rechazo(fn)
  assert(e !== 'ACEPTADO', 'el intento fue aceptado')
  assert(await foto() === antes, 'el intento rechazado escribió en la base')
  return e
}
async function saldos() {
  const r = await computeRouteCashReconciliation({ tenantId: T, routeId: R1 })
  return { base: await getRouteBase(R1), sinAsignar: r.noAsignado, cuadra: r.cuadra }
}
const fila = (s: Awaited<ReturnType<typeof saldos>>) => `Base ${s.base} · Sin asignar ${s.sinAsignar} · ${s.cuadra ? 'cuadra' : 'NO CUADRA'}`
const cifras = (w: Pick<WeeklySettlement, 'saldoAnterior' | 'ingresoCapital' | 'cobros' | 'prestamosEntregados' | 'gastos' | 'transferenciasEntradas' | 'transferenciasSalidas' | 'retiros' | 'saldoFinal'>) =>
  JSON.stringify([w.saldoAnterior, w.ingresoCapital, w.cobros, w.prestamosEntregados, w.gastos, w.transferenciasEntradas, w.transferenciasSalidas, w.retiros, w.saldoFinal])
const cerrar = (rango: { semanaInicio: string; semanaFin: string }, actor: User = ADMIN) =>
  closeSettlement({ actor, tenantId: T, routeId: R1, ...rango })

// ============================================================
// D29 — SEMANAS
// ============================================================
await spec('WEEK-001', 'D29', 'cerrar una semana todavía vigente: rechazo y cero escrituras', async () => {
  await empresa()
  const a = await saldos()
  const e = await sinEfecto(() => cerrar(VIGENTE))
  const futura = await sinEfecto(() => cerrar({ semanaInicio: HOY, semanaFin: addDays(HOY, 5) }))
  metric('saldo inicial', fila(a))
  metric(`semana ${VIGENTE.semanaInicio}–${VIGENTE.semanaFin}`, texto(e))
  metric('semana que termina en 5 días', texto(futura).split(':')[0])
  assert(/podrá cerrarse a partir del/.test((e as Error).message), 'no informa desde cuándo podrá cerrarse')
  assert(await db.weeklySettlements.count() === 0, 'quedó un cierre')
})

await spec('WEEK-002', 'D29', 'semana terminada: cierre válido con las cifras del motor', async () => {
  await empresa()
  await capital(700, AYER)
  const provisional = await generateWeeklySettlement({ tenantId: T, routeId: R1, ...PASADA })
  const doc = await cerrar(PASADA)
  metric('importes', `capital ${doc.ingresoCapital} · saldo final ${doc.saldoFinal} · versión ${doc.version}`)
  assert(doc.status === 'cerrada' && doc.ingresoCapital === 700 && cifras(doc) === cifras(provisional), 'el cierre no archivó las cifras del motor')
})

await spec('WEEK-003', 'D29', 'límite exacto: bloqueado hasta la medianoche que sigue al último día; permitido desde ese instante', () => {
  const fin = '2026-10-10'
  const limite = periodClosableFrom(fin)
  const antes = new Date(Date.parse(limite) - 1).toISOString()
  const r1 = periodNotEndedReason(fin, antes)
  const r2 = periodNotEndedReason(fin, limite)
  const r3 = periodNotEndedReason(fin, new Date(`${fin}T23:59:59`).toISOString())
  metric('cerrable desde (medianoche local del día siguiente)', limite)
  metric('1 ms antes / 23:59:59 del último día / en el límite', `${r1 ? 'bloqueado' : 'permitido'} / ${r3 ? 'bloqueado' : 'permitido'} / ${r2 ? 'bloqueado' : 'permitido'}`)
  assert(r1 && r3 && r2 === null, 'el límite del periodo no respeta el rango inclusivo por días')
})

await spec('WEEK-004', 'D29', 'tras rechazar el cierre anticipado, pagos y desembolsos de los días restantes siguen permitidos', async () => {
  await empresa()
  await rechazo(() => cerrar(VIGENTE))
  const s = await credito(1000)
  const p = await pagar(s, 100)
  metric('desembolso / pago de hoy', `${s.disbursementStatus} / ${p.valor}`)
  metric('saldos', fila(await saldos()))
  assert(s.disbursementStatus === 'desembolsado' && p.valor === 100, 'una operación legítima quedó bloqueada')
})

await spec('WEEK-005', 'D29', 'la liquidación provisional se calcula sin crear un cierre', async () => {
  await empresa()
  await credito(1000)
  const antes = await foto()
  const prov = await generateWeeklySettlement({ tenantId: T, routeId: R1, ...VIGENTE })
  metric('provisional', `préstamos ${prov.prestamosEntregados} · saldo final ${prov.saldoFinal}`)
  assert(await foto() === antes && await db.weeklySettlements.count() === 0, 'calcular la liquidación escribió o cerró algo')
})

await spec('WEEK-006', 'D29', 'doble intento de cierre (simultáneo y repetido): un solo documento, intacto', async () => {
  await empresa()
  const r = await Promise.allSettled([cerrar(PASADA), cerrar(PASADA), cerrar(PASADA, SA)])
  const ok = r.filter(x => x.status === 'fulfilled').length
  const doc = JSON.stringify(await db.weeklySettlements.toArray())
  const otra = await sinEfecto(() => cerrar(PASADA))
  metric('simultáneos aplicados', `${ok}/3`)
  metric('repetido', texto(otra))
  assert(ok === 1 && await db.weeklySettlements.count() === 1, 'dos cierres del mismo periodo')
  assert(JSON.stringify(await db.weeklySettlements.toArray()) === doc, 'el cierre válido cambió')
})

await spec('WEEK-007', 'D29', 'semanas históricas cerradas (también las anticipadas anteriores a D29) quedan intactas', async () => {
  await empresa()
  await capital(300, AYER)
  const valida = await cerrar(PASADA)
  await capital(200)
  await cierreAnticipadoHistorico(HOY, HOY)
  const docs = JSON.stringify(await db.weeklySettlements.toArray())
  await rechazo(() => cerrar(VIGENTE))
  const pago = await registerPayment({ saleId: 'inexistente', requestedAmount: 1, actor: JUAN })
  metric('cierre válido', `${valida.semanaInicio}–${valida.semanaFin} saldo ${valida.saldoFinal}`)
  metric('cierres tras operar', `${await db.weeklySettlements.count()} (sin reaperturas automáticas)`)
  assert(JSON.stringify(await db.weeklySettlements.toArray()) === docs && !pago.ok, 'un cierre histórico cambió o se reabrió')
})

await spec('WEEK-008', 'D29', 'llamada directa al servicio (cualquier actor) no elude D29', async () => {
  await empresa()
  const res: string[] = []
  for (const u of [ADMIN, SA]) {
    const e = await sinEfecto(() => cerrar(VIGENTE, u))
    res.push(`${u.rol}: ${texto(e).split(':')[0]}`)
  }
  for (const r of res) metric('·', r)
})

// ============================================================
// D30 — AUTORIDAD SOBRE LA CAJA DE LA RUTA
// ============================================================
await spec('AUTHBOX-001', 'D30', 'Administrador responsable de capital: desembolsa desde la caja (una vez)', async () => {
  await empresa(5000)
  const s = await aprobada(JUAN, 800)
  const a = await saldos()
  await confirmDisbursement(s.id, ADMIN)
  const b = await saldos()
  const v = (await db.sales.get(s.id))!
  metric('antes → después', `${fila(a)} → ${fila(b)}`)
  assert(b.base === a.base - 800 && b.sinAsignar === a.sinAsignar - 800 && v.disbursedByCollectorId === undefined && v.disbursedByUserId === ADMIN.id, 'el desembolso administrativo no salió de la caja una vez')
})

await spec('AUTHBOX-002', 'D30', 'Administrador asociado no responsable: rechazo (confirmación y venta directa)', async () => {
  await empresa(5000)
  const s = await aprobada(JUAN, 800)
  const e = await sinEfecto(() => confirmDisbursement(s.id, ADMIN_B))
  const ent = await entrada(ADMIN_B, 500)
  const e2 = await sinEfecto(() => createDirectSale(ent, ADMIN_B))
  metric('Beatriz confirma', texto(e))
  metric('Beatriz venta directa', texto(e2))
  assert((e as Error).name === 'AuthzError' && (e2 as Error).name === 'AuthzError', 'el Admin asociado usó la caja de la ruta')
  assert(can(ADMIN_B, 'sale.confirmDisbursement', { routeId: R1, tenantId: T }), 'el caso no prueba D30: Beatriz no tenía el permiso general')
})

await spec('AUTHBOX-003', 'D30', 'SuperAdmin de la empresa: desembolso válido, saldos una sola vez', async () => {
  await empresa(5000)
  const s = await aprobada(JUAN, 600)
  const a = await saldos()
  await confirmDisbursement(s.id, SA)
  const b = await saldos()
  metric('antes → después', `${fila(a)} → ${fila(b)}`)
  assert(b.base === a.base - 600 && b.sinAsignar === a.sinAsignar - 600, 'saldos incorrectos')
})

await spec('AUTHBOX-004', 'D30', 'SuperAdmin de OTRA empresa: rechazo', async () => {
  await empresa(5000)
  const s = await aprobada(JUAN, 600)
  const e = await sinEfecto(() => confirmDisbursement(s.id, SA_OTRA))
  metric('SuperAdmin ajeno', texto(e))
  assert((e as Error).name === 'AuthzError', 'un SuperAdmin de otra empresa desembolsó')
})

await spec('AUTHBOX-005', 'D30', 'ruta sin responsable válido: ni el Admin ni el SuperAdmin desembolsan desde la caja', async () => {
  await empresa(5000)
  const s = await aprobada(JUAN, 600)
  await db.routes.update(R1, { capitalControllerAdminId: undefined })
  const e1 = await sinEfecto(() => confirmDisbursement(s.id, ADMIN))
  const e2 = await sinEfecto(() => confirmDisbursement(s.id, SA))
  metric('Admin / SuperAdmin', `${texto(e1)} | ${texto(e2).split(':')[0]}`)
  assert(/no tiene Administrador responsable de capital/.test((e1 as Error).message) && (e2 as Error).name === 'AuthzError', 'se desembolsó sin responsable')
})

await spec('AUTHBOX-006', 'D30', 'cambio de responsable antes de confirmar: decide el estado vigente', async () => {
  await empresa(5000)
  const s = await aprobada(JUAN, 600)
  await setRouteCapitalController({ actor: SA, tenantId: T, routeId: R1, adminId: ADMIN_B.id, motivo: 'Andrés pasa a otra oficina' })
  const e = await sinEfecto(() => confirmDisbursement(s.id, ADMIN))
  await confirmDisbursement(s.id, ADMIN_B)
  metric('Andrés (ya no responsable)', texto(e))
  metric('Beatriz (nueva responsable)', (await db.sales.get(s.id))!.disbursementStatus)
  assert((e as Error).name === 'AuthzError' && (await db.sales.get(s.id))!.disbursedByUserId === ADMIN_B.id, 'se usó una autoridad obsoleta')
})

await spec('AUTHBOX-007', 'D30', 'Cobrador con efectivo: comportamiento anterior intacto', async () => {
  await empresa(5000)
  const s = await credito(900)
  metric('desembolso de Juan', `${s.disbursementStatus} · ${s.disbursedByCollectorId}`)
  assert(s.disbursedByCollectorId === JUAN.id, 'el Cobrador ya no desembolsa')
})

await spec('AUTHBOX-008', 'D30', 'Supervisor con efectivo: comportamiento anterior intacto', async () => {
  await empresa(5000)
  const s = await aprobada(JUAN, 700)
  await darBase(LAURA, 700)
  await confirmDisbursement(s.id, LAURA)
  const ent = await entrada(LAURA, 300)
  await darBase(LAURA, 300)
  const d = await createDirectSale(ent, LAURA)
  metric('Laura confirma / venta directa', `${(await db.sales.get(s.id))!.disbursedByCollectorId} / ${d.disbursedByCollectorId}`)
  assert((await db.sales.get(s.id))!.disbursedByCollectorId === LAURA.id && d.disbursedByCollectorId === LAURA.id, 'el Supervisor ya no desembolsa')
})

await spec('AUTHBOX-009', 'D30', 'el rechazo por D30 deja idénticas todas las tablas', async () => {
  await empresa(5000)
  const s = await aprobada(JUAN, 500)
  const antes = await foto()
  await rechazo(() => confirmDisbursement(s.id, ADMIN_B))
  assert(await foto() === antes, 'el rechazo escribió')
  metric('tablas', 'idénticas')
})

await spec('AUTHBOX-010', 'D30', 'el Admin asociado conserva sus demás permisos (aprobar, consultar la caja, reportes)', async () => {
  await empresa(5000)
  const req = await createSaleRequest(await entrada(JUAN, 400), JUAN)
  const venta = await approveSaleRequest(req.id, ADMIN_B)
  const conc = await getRouteCashReconciliation({ actor: ADMIN_B, tenantId: T, routeId: R1 })
  const caps = ['authorization.approve', 'cashbox.viewRoute', 'report.view', 'client.view'] as const
  const tiene = caps.filter(c => can(ADMIN_B, c, { routeId: R1, tenantId: T }))
  metric('aprobó', venta.disbursementStatus)
  metric('consulta la caja', `Base ${conc.libro.saldo}`)
  metric('capacidades', tiene.join(', '))
  assert(venta.disbursementStatus === 'pendiente' && tiene.length === caps.length, 'D30 recortó otros permisos')
})

// ============================================================
// D7 — ANULACIONES
// ============================================================
await spec('REVPER-001', 'D7', 'anular capital en periodo abierto: asiento de hoy enlazado', async () => {
  await empresa(5000)
  const m = await capital(400)
  const { original, reversal } = await reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: m.id, reason: 'Capital duplicado' })
  metric('anulación', `${reversal.fecha} · ${reversal.valor} · enlaza ${reversal.reversesId === m.id}`)
  assert(reversal.fecha === HOY && reversal.valor === -400 && reversal.reversesId === m.id && original.reversalId === reversal.id, 'anulación incorrecta')
})

await spec('REVPER-002', 'D7', 'anular transferencia en periodo abierto', async () => {
  await empresa(5000)
  const t = (await registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'partner', id: SOCIO.id }, destino: { type: 'route', id: R1 }, valor: 300 })).transfer
  const r = await reverseTransfer({ actor: ADMIN, tenantId: T, movementId: t.id, reason: 'Aporte mal registrado' })
  metric('anulación', `${r.reversal.fecha} · ${r.reversal.valor} · patas socio ${r.partnerReversals.length}`)
  assert(r.reversal.fecha === HOY && r.reversal.reversesId === t.id, 'anulación incorrecta')
})

await spec('REVPER-003', 'D7', 'anular retiro en periodo abierto', async () => {
  await empresa(5000)
  const w = await registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R1, valor: 500 })
  const { reversal } = await reverseWithdrawal({ actor: ADMIN, tenantId: T, movementId: w.id, reason: 'Retiro no realizado' })
  metric('anulación', `${reversal.fecha} · ${reversal.valor}`)
  assert(reversal.fecha === HOY && reversal.reversesId === w.id, 'anulación incorrecta')
})

await spec('REVPER-004', 'D7', 'anular gasto de bolsa: no tiene ruta, ninguna semana de ruta cambia (ni con la de hoy cerrada)', async () => {
  await empresa(5000)
  const g = await createExpense({ actor: ADMIN, tenantId: T, scope: 'empresa', categoryId: CAT, valor: 250, descripcion: 'Resmas de papel', funding: { source: 'admin', adminId: ADMIN.id } })
  await cierreAnticipadoHistorico(HOY, HOY)
  const semana = cifras(await generateWeeklySettlement({ tenantId: T, routeId: R1, semanaInicio: HOY, semanaFin: HOY }))
  const { reversal } = await reverseAdminExpense({ actor: ADMIN, tenantId: T, expenseId: g.id, reason: 'Gasto registrado dos veces' })
  const despues = cifras(await generateWeeklySettlement({ tenantId: T, routeId: R1, semanaInicio: HOY, semanaFin: HOY }))
  metric('anulación', `${reversal.fecha} · ${reversal.valor} · ruta ${reversal.routeId ?? 'ninguna'}`)
  assert(!g.routeId && !reversal.routeId && reversal.reversesId === g.id && semana === despues, 'el gasto de bolsa tocó una semana de ruta')
})

await spec('REVPER-005', 'D7', 'anular y corregir un pago en periodo abierto: conserva la fecha del original', async () => {
  await empresa(5000)
  const s = await credito(1000)
  const p = await pagar(s, 100)
  const { reversal } = await annulPayment({ actor: ADMIN, tenantId: T, paymentId: p.id, reason: 'Pago registrado por error' })
  const p2 = await pagar(s, 120)
  const c = await correctPayment(SECRE, p2.id, { newValor: 110, reason: 'Valor mal digitado' })
  const rev2 = (await db.payments.get(c.reversalId!))!
  metric('anulación', `${reversal.fecha} · ${reversal.valor}`)
  metric('corrección', `${c.success} · reversión ${rev2.fecha}`)
  assert(reversal.fecha === p.fecha && reversal.reversesPaymentId === p.id && c.success && rev2.fecha === p2.fecha, 'cambió la semántica en periodo abierto')
})

await spec('REVPER-006', 'D7', 'anulaciones posteriores de movimientos de una semana cerrada: asiento hoy, semana intacta', async () => {
  await empresa(5000)
  const s = await credito(1000)
  const m = await capital(400, AYER)
  const p = await pagar(s, 150, AYER)
  const p2 = await pagar(s, 90, AYER)
  const semana = await cerrar(PASADA)
  const archivada = JSON.stringify(await db.weeklySettlements.toArray())
  const rc = await reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: m.id, reason: 'Capital colocado en la ruta equivocada' })
  const rp = await annulPayment({ actor: ADMIN, tenantId: T, paymentId: p.id, reason: 'Cobro inexistente' })
  const sol = await requestPaymentAdjustment(SECRE, p2.id, { newValor: 80, reason: 'Valor mal digitado en la semana cerrada' })
  const ap = await approvePaymentAdjustment(ADMIN, sol.requestId!)
  const corregido = (await db.payments.toArray()).find(x => x.correctionOfPaymentId === p2.id)!
  const reversionP2 = (await db.payments.toArray()).find(x => x.reversesPaymentId === p2.id)!
  metric('capital', `original ${m.fecha} → anulación ${rc.reversal.fecha}`)
  metric('pago anulado', `original ${p.fecha} → anulación ${rp.reversal.fecha}`)
  metric('ajuste aprobado', `${ap.success} · reversión ${reversionP2.fecha} · corregido ${corregido.fecha} (${corregido.valor})`)
  assert(rc.reversal.fecha === HOY && rp.reversal.fecha === HOY && reversionP2.fecha === HOY && corregido.fecha === HOY, 'un asiento entró en la semana cerrada')
  assert((await db.capitalMovements.get(m.id))!.fecha === AYER && (await db.payments.get(p.id))!.fecha === AYER, 'se cambió la fecha del original')
  assert(JSON.stringify(await db.weeklySettlements.toArray()) === archivada && cifras(await generateWeeklySettlement({ tenantId: T, routeId: R1, ...PASADA })) === cifras(semana), 'la semana cerrada cambió')
})

await spec('REVPER-007', 'D7', 'semana de destino (hoy) cerrada: todas las anulaciones se rechazan', async () => {
  await empresa(5000)
  const s = await credito(1000)
  const m = await capital(400)
  const w = await registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R1, valor: 200 })
  const t = (await registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'partner', id: SOCIO.id }, destino: { type: 'route', id: R1 }, valor: 300 })).transfer
  const p = await pagar(s, 100)
  await cierreAnticipadoHistorico(HOY, HOY)
  const r = {
    capital: await sinEfecto(() => reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: m.id, reason: 'Error de registro' })),
    retiro: await sinEfecto(() => reverseWithdrawal({ actor: ADMIN, tenantId: T, movementId: w.id, reason: 'Error de registro' })),
    transferencia: await sinEfecto(() => reverseTransfer({ actor: ADMIN, tenantId: T, movementId: t.id, reason: 'Error de registro' })),
    pago: await sinEfecto(() => annulPayment({ actor: ADMIN, tenantId: T, paymentId: p.id, reason: 'Error de registro' })),
    correccion: await sinEfecto(() => correctPayment(ADMIN, p.id, { newValor: 90, reason: 'Error de registro' })),
  }
  for (const [k, v] of Object.entries(r)) metric(k, texto(v))
  assert(Object.values(r).every(v => /cerrada/.test((v as Error).message)), 'una anulación no explicó el cierre')
})

await spec('REVPER-008', 'D7', 'rechazo por periodo cerrado: saldos y tablas idénticos', async () => {
  await empresa(5000)
  const m = await capital(400)
  await cierreAnticipadoHistorico(HOY, HOY)
  const a = await saldos()
  const antes = await foto()
  await rechazo(() => reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: m.id, reason: 'Error de registro' }))
  const b = await saldos()
  metric('saldos', `${fila(a)} → ${fila(b)}`)
  assert(await foto() === antes && JSON.stringify(a) === JSON.stringify(b), 'el rechazo dejó efectos')
})

await spec('REVPER-009', 'D7', 'la anulación conserva el original y su referencia', async () => {
  await empresa(5000)
  const s = await credito(1000)
  const p = await pagar(s, 100)
  const { reversal } = await annulPayment({ actor: ADMIN, tenantId: T, paymentId: p.id, reason: 'Pago registrado por error' })
  const original = (await db.payments.get(p.id))!
  metric('original', `${original.state} · valor ${original.valor} · fecha ${original.fecha} · → ${original.reversalPaymentId}`)
  assert(original.valor === p.valor && original.fecha === p.fecha && original.reversalPaymentId === reversal.id && reversal.reversesPaymentId === p.id, 'se perdió el vínculo o el original')
})

await spec('REVPER-010', 'D7', 'reversos duplicados (repetidos y simultáneos) no duplican asientos', async () => {
  await empresa(5000)
  const m = await capital(400)
  await reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: m.id, reason: 'Capital duplicado' })
  const otra = await sinEfecto(() => reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: m.id, reason: 'Capital duplicado' }))
  const s = await credito(1000)
  const p = await pagar(s, 100)
  const r = await Promise.allSettled([1, 2, 3].map(() => annulPayment({ actor: ADMIN, tenantId: T, paymentId: p.id, reason: 'Pago registrado por error' })))
  const p2 = await pagar(s, 100)
  const c = await Promise.all([1, 2, 3].map(() => correctPayment(ADMIN, p2.id, { newValor: 80, reason: 'Valor mal digitado' })))
  const reversiones = (await db.payments.toArray()).filter(x => x.reversesPaymentId === p.id).length
  const correcciones = (await db.payments.toArray()).filter(x => x.correctionOfPaymentId === p2.id).length
  metric('capital repetido', texto(otra))
  metric('anulaciones simultáneas aplicadas', r.filter(x => x.status === 'fulfilled').length)
  metric('correcciones simultáneas aplicadas', c.filter(x => x.success).length)
  assert(reversiones === 1 && correcciones === 1 && (await db.capitalMovements.toArray()).filter(x => x.reversesId === m.id).length === 1, 'un reverso se duplicó')
})

await spec('REVPER-011', 'D7', 'cifras archivadas = cifras esperadas tras anulaciones legítimas posteriores', async () => {
  await empresa(5000)
  const s = await credito(1000)
  const m = await capital(600, AYER)
  const p = await pagar(s, 200, AYER)
  const esperado = await generateWeeklySettlement({ tenantId: T, routeId: R1, ...PASADA })
  const doc = await cerrar(PASADA)
  await reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: m.id, reason: 'Capital colocado en la ruta equivocada' })
  await annulPayment({ actor: ADMIN, tenantId: T, paymentId: p.id, reason: 'Cobro inexistente' })
  const despues = await generateWeeklySettlement({ tenantId: T, routeId: R1, ...PASADA })
  metric('esperado / archivado / recalculado', `${esperado.saldoFinal} / ${doc.saldoFinal} / ${despues.saldoFinal}`)
  assert(cifras(esperado) === cifras(doc) && cifras(doc) === cifras(despues), 'las cifras de la semana cerrada cambiaron')
})

await spec('REVPER-012', 'D7', 'no se puede elegir una fecha contable para entrar en un periodo cerrado', async () => {
  await empresa(5000)
  const s = await credito(1000)
  const p = await pagar(s, 100)
  await cerrar(PASADA)
  const corr = await sinEfecto(() => correctPayment(ADMIN, p.id, { newValor: 90, newFecha: AYER, reason: 'Fecha mal digitada' }))
  const cap = await sinEfecto(() => capital(100, AYER))
  const pago = await registerPayment({ saleId: s.id, requestedAmount: 50, actor: JUAN, fecha: AYER })
  metric('corrección con fecha cerrada', texto(corr))
  metric('capital con fecha cerrada', texto(cap).split(':')[0])
  metric('pago con fecha cerrada', pago.ok ? 'ACEPTADO' : pago.code)
  assert(/cerrada/.test((corr as Error).message) && !pago.ok, 'una fecha elegida entró en el periodo cerrado')
  // Las anulaciones no aceptan fecha: la ponen ellas (hoy o la del original abierto).
  const src = fs.readFileSync('src/services/movementReversalService.ts', 'utf8')
  const params = src.slice(src.indexOf('export interface ReverseParams'), src.indexOf('}', src.indexOf('export interface ReverseParams')))
  assert(!/fecha/.test(params), 'las anulaciones aceptan una fecha del cliente')
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
