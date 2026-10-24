// ============================================================
// RUTACASH — SUITE CAPITAL CENTRALIZADO (C1, DEXIE REAL)
// ------------------------------------------------------------
//   npm run test:centralcapital
//
// Decisión del propietario (C1): la caja de la ruta deja de ser bolsa intermediaria.
// El Administrador responsable entrega capital de SU bolsa al trabajador (ruta
// identificada) y lo que el trabajador devuelve o cuadra vuelve a esa bolsa.
//
//   A. Conservación: la bolsa baja/sube una sola vez; "Sin asignar" no crece; el
//      saldo heredado no crece; los invariantes de capital siguen intactos.
//   B. Custodia del Cobrador: anticipo sin préstamo; recaudo + entrega; rutas
//      aisladas; duplicados; capital consumido no se revierte; visibilidad.
//   C. Cuadres y pagos: el cuadre devuelve a la bolsa; reapertura coherente o
//      bloqueada; cobros no en efectivo; anulación y corrección; gastos.
//   D. Compatibilidad: datos v16 sin activar; activación explícita; diagnóstico;
//      periodos cerrados intactos; sin versión Dexie nueva; permisos de venta.
//
// Datos sintéticos. Cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import { sembrarResponsables } from './financial/capitalFixture'
import { nowISO, today } from '../src/lib/formatters'
import { can } from '../src/lib/permissions'
import { ALLOWED_INTEREST_RATES, originationRatesFor } from '../src/lib/interestRatePolicy'
import { verifyCapitalInvariants } from '../src/lib/capitalAllocation'
import { getRouteBase } from '../src/services/cashboxEngine'
import { computeRouteCashReconciliation } from '../src/services/routeCashReconciliation'
import { closeCashSettlement, personalCashPosition, previewCashSettlement, reopenCashSettlement } from '../src/services/cashSettlementService'
import { registerCapital, registerTransfer, registerWithdrawal } from '../src/services/routeFundsService'
import { assignBaseToWorker, returnBaseFromWorker } from '../src/services/cashCustodyService'
import { approveSaleRequest, confirmDisbursement, createDirectSale, createSaleRequest, type SaleInputs } from '../src/services/saleRequestService'
import { registerPayment } from '../src/services/paymentService'
import { annulPayment, correctPayment } from '../src/services/paymentCorrectionService'
import { createExpense } from '../src/services/expenseService'
import { reverseCapitalMovement, reverseWithdrawal } from '../src/services/movementReversalService'
import { getAdminAvailableCapital, getAdminPoolStatement, getCapitalOverview, loadCapitalRows } from '../src/services/capitalControlService'
import { generateWeeklySettlement } from '../src/services/weeklySettlementEngine'
import {
  activateCentralCapitalModel, deliverCapitalToWorker, diagnoseCentralCapitalTransition, registerPartnerContribution,
  returnCapitalFromWorker, reverseCapitalDelivery, reversePartnerContribution,
} from '../src/services/centralCapitalService'
import { centralIds } from '../src/lib/centralCapital'
import { buildCentralCapitalBackup, centralCapitalBackupStatus, verifyCentralCapitalBackup } from '../src/services/centralCapitalBackupService'
import { getActivationReadiness, releaseCentralCapitalRoute } from '../src/services/centralCapitalService'
import { getCapitalFlowBreakdown, getCashboxSummary } from '../src/services/cashboxEngine'
import { availableOperations, previewTransferOperation, routesForOperation } from '../src/lib/transferOperations'
import { createRouteWithAdmins } from '../src/services/routeService'
import type { PaymentType, Sale, User } from '../src/models/types'
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
  try { await fn() } catch (e) { passed = false; error = e instanceof Error ? `${e.message}\n${e.stack?.split('\n').slice(1, 4).join('\n') ?? ''}` : String(e) }
  results.push({ id, desc, passed, error, metrics: [...current] })
}

async function rechazo(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'ACEPTADO' } catch (e) { return e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
}

/** Fotografía de TODA la base: dos fotos iguales = cero escrituras. */
async function foto(): Promise<string> {
  const partes: Record<string, unknown[]> = {}
  for (const t of db.tables) partes[t.name] = (await t.toArray()).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return JSON.stringify(partes)
}
async function sinEfecto(fn: () => Promise<unknown>): Promise<string> {
  const antes = await foto()
  const e = await rechazo(fn)
  assert(e !== 'ACEPTADO', 'el intento fue aceptado')
  assert(await foto() === antes, 'el intento rechazado escribió en la base')
  return e
}

// ============================================================
// Escenario sintético
// ============================================================
const T = 't-central'
const R1 = 'r-uno'
const R2 = 'r-dos'
const R3 = 'r-tres'
const OF1 = 'of-1'
const CAT = 'cat-combustible'
const HOY = today()

const persona = (id: string, nombre: string, rol: User['rol'], rutas: string[]): User => ({
  id, tenantId: T, nombre, email: `${id}@c1.test`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)

const SA = persona('u-sa', 'Sara SuperAdmin', 'superadmin', [])
const ADMIN = persona('u-admin', 'Andrés Admin', 'admin', [R1, R2, R3])
const ADMIN_2 = persona('u-admin-2', 'Bea Admin Secundaria', 'admin', [R1])
const JUAN = persona('u-juan', 'Juan Cobrador', 'cobrador', [R1, R2])
const FABIO = persona('u-fabio', 'Fabio Cobrador', 'cobrador', [R1, R2])
const LAURA = persona('u-laura', 'Laura Supervisora', 'supervisor', [R1])
const SOCIO = persona('u-socio', 'Hernán Socio', 'socio', [R1])

const BOLSA_INICIAL = 10_000

/**
 * Empresa con dos rutas del MISMO responsable (Andrés) y una tercera sin responsable.
 * `heredado` = capital colocado en la caja de R1 ANTES de activar (modelo v16).
 */
async function empresa(opts: { activar?: boolean; heredado?: number; bolsa?: number } = {}) {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.add({ id: T, nombre: 'C1', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z' } as never)
  await db.offices.add({ id: OF1, tenantId: T, nombre: 'Of', codigo: 'OF', status: 'activa', createdAt: '', updatedAt: '' } as never)
  const ruta = (id: string, nombre: string) => ({ id, tenantId: T, officeId: OF1, nombre, codigo: id, status: 'activa', capitalInicial: 0, capitalActual: 0, tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 0, createdAt: '2026-09-01' })
  await db.routes.bulkAdd([ruta(R1, 'Uno'), ruta(R2, 'Dos'), ruta(R3, 'Tres')] as never[])
  await db.users.bulkAdd([SA, ADMIN, ADMIN_2, JUAN, FABIO, LAURA, SOCIO])
  await db.expenseCategories.add({ id: CAT, tenantId: T, nombre: 'Combustible', activa: true } as never)
  await sembrarResponsables(db, T, { [R1]: ADMIN.id, [R2]: ADMIN.id }, opts.bolsa ?? BOLSA_INICIAL)
  if (opts.heredado) await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: opts.heredado })
  if (opts.activar !== false) await activar()
}
/**
 * C2: con datos financieros la activación exige un respaldo exportado y verificado.
 * El helper hace el recorrido real: exportar → volver a cargar → activar.
 */
async function activar() {
  // Ya activa: la llamada debe ser idempotente (sin respaldo nuevo).
  if ((await db.tenants.get(T))?.centralCapitalStartAt) return activateCentralCapitalModel({ actor: SA, tenantId: T, motivo: 'Prueba C1: capital centralizado' })
  const { text } = await buildCentralCapitalBackup({ actor: SA, tenantId: T })
  const v = await verifyCentralCapitalBackup({ actor: SA, tenantId: T, text })
  if (!v.ok) throw new Error(`respaldo no verificado: ${v.problemas.join(' | ')}`)
  return activateCentralCapitalModel({ actor: SA, tenantId: T, motivo: 'Prueba C1: capital centralizado' })
}

let cli = 0
async function entrada(by: User, valor: number, routeId = R1): Promise<SaleInputs> {
  const clientId = `cli-${++cli}`
  await db.clients.add({ id: clientId, tenantId: T, routeId, nombre: clientId, documento: clientId, status: 'activo', createdAt: '' } as never)
  return { tenantId: T, routeId, clientId, createdByUserId: by.id, valorVenta: valor, tasaInteres: 20, numeroCuotas: 10, frecuenciaPago: 'diaria', fechaInicio: HOY, paymentDays: [0, 1, 2, 3, 4, 5, 6] }
}
/** Solicitud del Cobrador aprobada por el Administrador → venta pendiente de desembolso. */
async function aprobada(by: User, valor: number, routeId = R1): Promise<Sale> {
  const req = await createSaleRequest(await entrada(by, valor, routeId), by)
  return approveSaleRequest(req.id, ADMIN)
}
/** Venta directa del Administrador (desembolso administrativo). */
async function ventaAdmin(valor: number, routeId = R1): Promise<Sale> {
  return createDirectSale(await entrada(ADMIN, valor, routeId), ADMIN)
}
async function cobra(u: User, sale: Sale, valor: number, tipo: PaymentType = 'efectivo') {
  const r = await registerPayment({ saleId: sale.id, requestedAmount: valor, actor: u, fecha: HOY, tipo })
  if (!r.ok) throw new Error(`pago rechazado: ${r.code} ${r.message}`)
  return r
}
const entregar = (u: User, amount: number, extra: Partial<Parameters<typeof deliverCapitalToWorker>[0]> = {}) =>
  deliverCapitalToWorker({ actor: ADMIN, tenantId: T, routeId: R1, recipientUserId: u.id, amount, motivo: 'Capital para ventas', ...extra })
const bolsa = () => getAdminAvailableCapital(T, ADMIN.id)
const conciliacion = (routeId = R1) => computeRouteCashReconciliation({ tenantId: T, routeId })
const posicion = async (u: User, routeId = R1) => (await personalCashPosition({ tenantId: T, routeId, userId: u.id, hasta: nowISO() })).esperado
async function invariantes(): Promise<string[]> {
  const rows = await loadCapitalRows(T)
  return verifyCapitalInvariants(rows, rows.users.filter(u => u.rol === 'admin').map(u => u.id))
}
/** "Sin asignar" + conciliación + invariantes de capital en un solo control. */
async function sano(routeId = R1, sinAsignarEsperado = 0) {
  const c = await conciliacion(routeId)
  const inv = await invariantes()
  assert(c.cuadra, `la conciliación de ${routeId} no cuadra`)
  assert(c.noAsignado === sinAsignarEsperado, `"Sin asignar" de ${routeId} = ${c.noAsignado}, esperado ${sinAsignarEsperado}`)
  assert(inv.length === 0, `invariantes de capital rotos: ${inv.join(' | ')}`)
}

// ============================================================
// A. CONSERVACIÓN DEL CAPITAL
// ============================================================
await spec('CC-A01', 'entrega: la bolsa baja UNA vez, el trabajador sube, "Sin asignar" no cambia', async () => {
  await empresa()
  const b0 = await bolsa()
  const base0 = await getRouteBase(R1)
  const d = await entregar(JUAN, 1000)
  metric('bolsa', `${b0} → ${await bolsa()}`)
  metric('posición Juan', await posicion(JUAN))
  metric('Base R1', `${base0} → ${await getRouteBase(R1)}`)
  assert(await bolsa() === b0 - 1000, 'la bolsa no bajó exactamente 1.000')
  assert(await posicion(JUAN) === 1000, 'el trabajador no recibió 1.000')
  assert(await getRouteBase(R1) === base0 + 1000, 'la Base no refleja el efectivo en manos del trabajador')
  assert(d.capital.centralLink?.kind === 'ENTREGA_TRABAJADOR' && d.custody.centralLink?.operationId === d.capital.id, 'el par no quedó enlazado')
  assert(d.custody.origen === 'admin-pool' && d.capital.adminId === ADMIN.id, 'origen o bolsa incorrectos')
  await sano()
})

await spec('CC-A02', 'devolución: el trabajador baja, la bolsa recupera exactamente lo devuelto', async () => {
  await empresa()
  await entregar(JUAN, 1000)
  const b1 = await bolsa()
  const r = await returnCapitalFromWorker({ actor: ADMIN, tenantId: T, routeId: R1, fromUserId: JUAN.id, amount: 400, motivo: 'Sobró capital' })
  metric('bolsa', `${b1} → ${await bolsa()}`)
  metric('posición Juan', await posicion(JUAN))
  assert(await bolsa() === b1 + 400 && await posicion(JUAN) === 600, 'la devolución no restituyó correctamente')
  assert(r.withdrawal.adminId === ADMIN.id && r.custody.tipo === 'BASE_RETURN', 'patas incorrectas')
  // No se devuelve más de lo que tiene; nadie registra su propia devolución.
  metric('devolver 700 con 600 en manos', await sinEfecto(() => returnCapitalFromWorker({ actor: ADMIN, tenantId: T, routeId: R1, fromUserId: JUAN.id, amount: 700, motivo: 'x' })))
  await sano()
})

await spec('CC-A03', 'ciclo completo en ruta nueva: ningún paso crea dinero ni deja saldo en la caja de la ruta', async () => {
  await empresa()
  const total = async () => (await bolsa()) + (await conciliacion()).enPersonas + (await conciliacion()).cartera.carteraEnCalle
  const pasos: string[] = []
  const control = async (paso: string) => { await sano(); pasos.push(`${paso}: bolsa ${await bolsa()} · en manos ${(await conciliacion()).enPersonas}`) }
  const t0 = await total()
  const vAdmin = await ventaAdmin(1000); await control('venta del Admin 1.000')
  await cobra(JUAN, vAdmin, 200); await control('Juan cobra 200 en efectivo')
  await cobra(JUAN, vAdmin, 150, 'transferencia'); await control('cobro 150 por transferencia')
  await entregar(JUAN, 400); await control('entrega 400 a Juan')
  const v = await aprobada(JUAN, 500); await confirmDisbursement(v.id, JUAN); await control('Juan desembolsa 500')
  await createExpense({ actor: JUAN, tenantId: T, scope: 'trabajador', routeId: R1, collectorId: JUAN.id, categoryId: CAT, valor: 50, descripcion: 'Combustible' }); await control('gasto de Juan 50')
  await createExpense({ actor: ADMIN, tenantId: T, scope: 'ruta', routeId: R1, categoryId: CAT, valor: 80, descripcion: 'Papelería' }); await control('gasto de ruta 80')
  const enManos = await posicion(JUAN)
  const bAntes = await bolsa()
  await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: JUAN.id, entregado: enManos }); await control(`cuadre de Juan (${enManos})`)
  for (const p of pasos) metric('paso', p)
  const t1 = await total()
  metric('bolsa + en manos + cartera', `${t0} → ${t1}`)
  // Conservación: lo único que cambia el total es el interés pactado de las dos ventas
  // (20 % de 1.000 y de 500, ya en cartera) menos los gastos consumidos (50 + 80).
  assert(t1 === t0 + 200 + 100 - 50 - 80, `se creó o perdió dinero: ${t0} → ${t1}`)
  // 200 + 400 − 500 − 50 = 50 en manos; el cuadre lo devuelve íntegro a la bolsa.
  assert(enManos === 50 && await bolsa() === bAntes + 50, 'el cuadre no devolvió el efectivo exacto a la bolsa')
  assert(await posicion(JUAN) === 0, 'el trabajador no inicia el siguiente periodo en cero')
})

await spec('CC-A04', 'saldo heredado: no crece con operaciones nuevas y las vías que lo llenarían se rechazan', async () => {
  await empresa({ activar: false, heredado: 3000 })
  await registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R1, valor: 500 })   // retiro histórico v16
  const retiroHistorico = (await db.withdrawals.toArray())[0]
  await activar()
  const heredado = (await conciliacion()).noAsignado
  metric('saldo heredado al activar', heredado)
  assert(heredado === 2500, 'saldo heredado inesperado')
  // Operaciones nuevas: el heredado no se mueve.
  await entregar(JUAN, 700)
  const v = await ventaAdmin(400)
  await cobra(JUAN, v, 100, 'transferencia')
  await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: JUAN.id, entregado: 700 })
  await sano(R1, 2500)
  // Vías que harían crecer la caja de la ruta: rechazadas sin escribir.
  metric('capital a la caja', await sinEfecto(() => registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 100 })))
  await entregar(FABIO, 200)
  metric('devolución a la caja', await sinEfecto(() => returnBaseFromWorker({ actor: ADMIN, tenantId: T, routeId: R1, fromUserId: FABIO.id, amount: 100, motivo: 'x' })))
  metric('Socio → Ruta', await sinEfecto(() => registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'partner', id: SOCIO.id }, destino: { type: 'route', id: R1 }, valor: 100 })))
  metric('Ruta → Ruta', await sinEfecto(() => registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'route', id: R1 }, destino: { type: 'route', id: R2 }, valor: 100 })))
  metric('anular retiro histórico', await sinEfecto(() => reverseWithdrawal({ actor: ADMIN, tenantId: T, movementId: retiroHistorico.id, reason: 'Corrección' })))
  // Vías que lo VACÍAN (operaciones existentes, tope = heredado).
  const b = await bolsa()
  await registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R1, valor: 1500 })
  await assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R1, recipientUserId: FABIO.id, amount: 600, motivo: 'Base del heredado' })
  metric('heredado tras vaciar', (await conciliacion()).noAsignado)
  metric('bolsa', `${b} → ${await bolsa()}`)
  assert(await bolsa() === b + 1500, 'el retiro del heredado no llegó a la bolsa')
  metric('retirar más que el heredado', await sinEfecto(() => registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R1, valor: 500 })))
  await sano(R1, 400)
})

await spec('CC-A05', 'aporte de socio: entra a la bolsa del responsable, nunca a la ruta; anulación con fondos', async () => {
  await empresa()
  const b0 = await bolsa()
  const { entry, partnerMovement } = await registerPartnerContribution({ actor: ADMIN, tenantId: T, partnerId: SOCIO.id, routeId: R1, amount: 2000, descripcion: 'Aporte para Uno' })
  metric('bolsa', `${b0} → ${await bolsa()}`)
  metric('Caja socios', `${partnerMovement.type} ${partnerMovement.amount}`)
  assert(await bolsa() === b0 + 2000 && entry.toAdminId === ADMIN.id, 'el aporte no entró a la bolsa del responsable')
  assert(partnerMovement.type === 'salida' && partnerMovement.relatedLedgerEntryId === entry.id, 'pata de Caja socios incorrecta')
  await sano()
  // Lo registra solo el responsable de la ruta (no otro Admin ni el SuperAdmin).
  metric('Admin secundario', await sinEfecto(() => registerPartnerContribution({ actor: ADMIN_2, tenantId: T, partnerId: SOCIO.id, routeId: R1, amount: 10 })))
  metric('SuperAdmin', await sinEfecto(() => registerPartnerContribution({ actor: SA, tenantId: T, partnerId: SOCIO.id, routeId: R1, amount: 10 })))
  // Anulación: bloqueada si la bolsa ya lo entregó; permitida si lo conserva.
  await entregar(JUAN, (await bolsa()) - 1000)
  metric('anular con la bolsa consumida', await sinEfecto(() => reversePartnerContribution({ actor: ADMIN, tenantId: T, entryId: entry.id, reason: 'Registrado por error' })))
  await returnCapitalFromWorker({ actor: ADMIN, tenantId: T, routeId: R1, fromUserId: JUAN.id, amount: 5000, motivo: 'Devolución' })
  const b1 = await bolsa()
  await reversePartnerContribution({ actor: ADMIN, tenantId: T, entryId: entry.id, reason: 'Registrado por error' })
  metric('bolsa tras anular', `${b1} → ${await bolsa()}`)
  assert(await bolsa() === b1 - 2000, 'la anulación no sacó el aporte de la bolsa')
  await sano()
})

// ============================================================
// B. CUSTODIA DEL COBRADOR
// ============================================================
await spec('CC-B01', 'anticipo de R$ 1.000 al iniciar el día: sin préstamo ni deuda; referencia opcional a la solicitud', async () => {
  await empresa()
  const req = await createSaleRequest(await entrada(JUAN, 1000), JUAN)
  const ventasAntes = await db.sales.count()
  const cuotasAntes = await db.installments.count()
  const d = await entregar(JUAN, 1000, { saleRequestId: req.id })
  const reqDespues = await db.saleRequests.get(req.id)
  metric('ventas / cuotas', `${ventasAntes}/${cuotasAntes} → ${await db.sales.count()}/${await db.installments.count()}`)
  metric('solicitud', reqDespues?.status)
  assert(await db.sales.count() === ventasAntes && await db.installments.count() === cuotasAntes, 'la entrega creó un préstamo')
  assert(reqDespues?.status === 'pending', 'la entrega cambió la solicitud')
  assert(d.custody.saleRequestId === req.id, 'la referencia a la solicitud no quedó registrada')
  assert(await posicion(JUAN) === 1000 && await bolsa() === BOLSA_INICIAL - 1000, 'saldos incorrectos')
  metric('solicitud de otra ruta', await sinEfecto(async () => {
    const otra = await createSaleRequest(await entrada(JUAN, 100, R2), JUAN)
    await db.saleRequests.delete(otra.id); await db.saleRequests.add(otra)   // fija el estado previo a la foto
    return entregar(JUAN, 10, { saleRequestId: otra.id })
  }).catch(() => 'rechazado'))
})

await spec('CC-B02', 'recaudo R$ 200 + venta R$ 500 con envío de R$ 500: conserva R$ 200; la bolsa paga una sola vez', async () => {
  await empresa()
  await cobra(JUAN, await ventaAdmin(1000), 200)
  const v = await aprobada(JUAN, 500)
  await entregar(JUAN, 500)
  const b = await bolsa()
  await confirmDisbursement(v.id, JUAN)
  metric('posición de Juan', await posicion(JUAN))
  metric('bolsa al desembolsar', `${b} → ${await bolsa()}`)
  assert(await posicion(JUAN) === 200, 'Juan no conserva sus R$ 200')
  assert(await bolsa() === b, 'el desembolso volvió a descontar de la bolsa')
  assert((await db.sales.get(v.id))?.disbursedByCollectorId === JUAN.id, 'desembolso no atribuido a Juan')
  await sano()
})

await spec('CC-B03', 'recaudo R$ 200 + venta R$ 500 con envío de R$ 300: completa con el recaudo y queda en R$ 0', async () => {
  await empresa()
  await cobra(JUAN, await ventaAdmin(1000), 200)
  const v = await aprobada(JUAN, 500)
  await entregar(JUAN, 300)
  await confirmDisbursement(v.id, JUAN)
  metric('posición de Juan', await posicion(JUAN))
  assert(await posicion(JUAN) === 0, 'saldo final incorrecto')
  await sano()
})

await spec('CC-B04', 'recaudo R$ 200 sin envío: no puede desembolsar R$ 500 (sin escrituras)', async () => {
  await empresa()
  await cobra(JUAN, await ventaAdmin(1000), 200)
  const v = await aprobada(JUAN, 500)
  const e = await sinEfecto(() => confirmDisbursement(v.id, JUAN))
  metric('rechazo', e)
  assert(e.includes('DisbursementFundsError') && !/bolsa/i.test(e), 'rechazo inesperado o expone la bolsa al Cobrador')
  assert((await db.sales.get(v.id))?.disbursementStatus === 'pendiente', 'la venta dejó de estar pendiente')
})

await spec('CC-B05', 'rutas aisladas: el capital entregado en Dos no financia una venta en Uno', async () => {
  await empresa()
  await deliverCapitalToWorker({ actor: ADMIN, tenantId: T, routeId: R2, recipientUserId: JUAN.id, amount: 1000, motivo: 'Capital para Dos' })
  const v = await aprobada(JUAN, 500, R1)
  metric('posición Juan Uno / Dos', `${await posicion(JUAN, R1)} / ${await posicion(JUAN, R2)}`)
  metric('desembolso en Uno', await sinEfecto(() => confirmDisbursement(v.id, JUAN)))
  assert(await posicion(JUAN, R1) === 0 && await posicion(JUAN, R2) === 1000, 'las custodias se mezclaron')
  await sano(R1); await sano(R2)
})

await spec('CC-B06', 'entregas duplicadas: mismo id = un solo registro; mismo id con otros datos = rechazo', async () => {
  await empresa()
  const a = await entregar(JUAN, 500, { operationId: 'op-entrega-1' })
  const b = await entregar(JUAN, 500, { operationId: 'op-entrega-1' })
  metric('ids', `${a.capital.id} / ${b.capital.id}`)
  metric('capital / custodia', `${await db.capitalMovements.count()} / ${await db.cashCustodyMovements.count()}`)
  assert(a.capital.id === b.capital.id && await db.capitalMovements.count() === 1 && await db.cashCustodyMovements.count() === 1, 'el reintento duplicó la entrega')
  assert(await bolsa() === BOLSA_INICIAL - 500, 'la bolsa se descontó dos veces')
  metric('mismo id, otro importe', await sinEfecto(() => entregar(JUAN, 600, { operationId: 'op-entrega-1' })))
  metric('mismo id, otra persona', await sinEfecto(() => entregar(FABIO, 500, { operationId: 'op-entrega-1' })))
})

await spec('CC-B07', 'anular una entrega: se rechaza si el capital ya se usó; procede si el trabajador lo conserva', async () => {
  await empresa()
  const d = await entregar(JUAN, 500)
  const v = await aprobada(JUAN, 400)
  await confirmDisbursement(v.id, JUAN)
  const e = await sinEfecto(() => reverseCapitalDelivery({ actor: ADMIN, tenantId: T, operationId: d.capital.id, reason: 'Error' }))
  metric('anular capital consumido', e)
  assert(/utilizado/.test(e), 'mensaje inesperado')
  // Pata suelta: no se anula por separado.
  metric('anular solo la pata de capital', await sinEfecto(() => reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: d.capital.id, reason: 'Error' })))
  const d2 = await entregar(FABIO, 300)
  const b = await bolsa()
  await reverseCapitalDelivery({ actor: ADMIN, tenantId: T, operationId: d2.capital.id, reason: 'Destinatario equivocado' })
  metric('bolsa al anular', `${b} → ${await bolsa()}`)
  assert(await bolsa() === b + 300 && await posicion(FABIO) === 0, 'la anulación no restituyó')
  metric('anular dos veces', await sinEfecto(() => reverseCapitalDelivery({ actor: ADMIN, tenantId: T, operationId: d2.capital.id, reason: 'Otra vez' })))
  await sano()
})

await spec('CC-B08', 'autoridad y visibilidad: solo el responsable entrega; el Cobrador no ve ni opera la bolsa', async () => {
  await empresa()
  metric('Admin secundario', await sinEfecto(() => deliverCapitalToWorker({ actor: ADMIN_2, tenantId: T, routeId: R1, recipientUserId: JUAN.id, amount: 10, motivo: 'x' })))
  metric('SuperAdmin', await sinEfecto(() => deliverCapitalToWorker({ actor: SA, tenantId: T, routeId: R1, recipientUserId: JUAN.id, amount: 10, motivo: 'x' })))
  metric('Supervisora', await sinEfecto(() => deliverCapitalToWorker({ actor: LAURA, tenantId: T, routeId: R1, recipientUserId: JUAN.id, amount: 10, motivo: 'x' })))
  metric('Cobrador', await sinEfecto(() => deliverCapitalToWorker({ actor: JUAN, tenantId: T, routeId: R1, recipientUserId: FABIO.id, amount: 10, motivo: 'x' })))
  metric('ruta sin responsable', await sinEfecto(() => deliverCapitalToWorker({ actor: ADMIN, tenantId: T, routeId: R3, recipientUserId: JUAN.id, amount: 10, motivo: 'x' })))
  metric('excede la bolsa', await sinEfecto(() => entregar(JUAN, BOLSA_INICIAL + 1)))
  const vistas = [
    await rechazo(() => getCapitalOverview({ actor: JUAN, tenantId: T })),
    await rechazo(() => getAdminPoolStatement({ actor: JUAN, tenantId: T, adminId: ADMIN.id })),
    await rechazo(() => diagnoseCentralCapitalTransition({ actor: JUAN, tenantId: T })),
  ]
  metric('consultas del Cobrador', vistas.join(' | '))
  assert(vistas.every(v => v !== 'ACEPTADO'), 'el Cobrador pudo consultar la bolsa')
  // La Supervisora recibe devoluciones (autoridad de cuadre), como en v16.
  await entregar(JUAN, 300)
  await returnCapitalFromWorker({ actor: LAURA, tenantId: T, routeId: R1, fromUserId: JUAN.id, amount: 100, motivo: 'Recibe la supervisora' })
  // «Mi efectivo» del Cobrador: capital recibido separado del recaudo, sin cifras de la bolsa.
  await cobra(JUAN, await ventaAdmin(500), 50)
  const mio = await previewCashSettlement({ actor: JUAN, tenantId: T, routeId: R1, userId: JUAN.id })
  metric('Mi efectivo', `recibido ${mio.baseRecibida} · devuelto ${mio.baseDevuelta} · recaudado ${mio.recaudado} · esperado ${mio.esperado}`)
  assert(mio.baseRecibida === 300 && mio.baseDevuelta === 100 && mio.recaudado === 50 && mio.esperado === 250, 'desglose incorrecto')
  assert(!JSON.stringify(mio).includes(String(await bolsa())), 'la vista del Cobrador contiene el disponible de la bolsa')
})

// ============================================================
// C. CUADRES Y PAGOS
// ============================================================
await spec('CC-C01', 'cuadre exacto: el efectivo vuelve a la bolsa del responsable y el ciclo siguiente parte de cero', async () => {
  await empresa()
  await entregar(JUAN, 500)
  await cobra(JUAN, await ventaAdmin(1000), 200)
  const b = await bolsa()
  const doc = await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: JUAN.id, entregado: 700 })
  const w = await db.withdrawals.get(centralIds.cuadre(doc.id))
  metric('bolsa', `${b} → ${await bolsa()}`)
  metric('retorno', `${w?.valor} (${w?.centralLink?.kind})`)
  assert(await bolsa() === b + 700 && w?.adminId === ADMIN.id, 'el cuadre no devolvió el efectivo a la bolsa')
  assert(await posicion(JUAN) === 0, 'el ciclo siguiente no parte de cero')
  await sano()
})

await spec('CC-C02', 'cuadre con faltante: solo vuelve lo entregado; el faltante sigue siendo deuda del trabajador', async () => {
  await empresa()
  await entregar(JUAN, 700)
  const b = await bolsa()
  const doc = await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: JUAN.id, entregado: 600, motivo: 'Faltan cien por revisar' })
  metric('bolsa', `${b} → ${await bolsa()}`)
  metric('faltante / arrastre', `${doc.faltante} / ${await posicion(JUAN)}`)
  assert(await bolsa() === b + 600 && doc.faltante === 100 && await posicion(JUAN) === 100, 'faltante mal tratado')
  await sano()
})

await spec('CC-C03', 'reapertura coherente: la bolsa devuelve lo recibido y el trabajador recupera su posición', async () => {
  await empresa()
  await entregar(JUAN, 700)
  const doc = await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: JUAN.id, entregado: 700 })
  const b = await bolsa()
  await reopenCashSettlement({ actor: ADMIN, settlementId: doc.id, motivo: 'Revisión del conteo de efectivo' })
  metric('bolsa', `${b} → ${await bolsa()}`)
  metric('posición Juan', await posicion(JUAN))
  assert(await bolsa() === b - 700 && await posicion(JUAN) === 700, 'la reapertura no revirtió el retorno')
  assert((await db.withdrawals.get(centralIds.cuadre(doc.id)))?.reversalId, 'el retorno no quedó anulado')
  await sano()
  const doc2 = await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: JUAN.id, entregado: 700 })
  assert(doc2.version === 2 && await bolsa() === b, 'el nuevo cierre no devolvió el efectivo')
  await sano()
})

await spec('CC-C04', 'reapertura bloqueada si la bolsa ya no tiene el efectivo (sin escrituras)', async () => {
  await empresa({ bolsa: 1000 })
  await entregar(JUAN, 700)
  const doc = await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: JUAN.id, entregado: 700 })
  await entregar(FABIO, await bolsa())   // la bolsa entrega todo
  const e = await sinEfecto(() => reopenCashSettlement({ actor: ADMIN, settlementId: doc.id, motivo: 'Revisión del conteo de efectivo' }))
  metric('rechazo', e)
  assert((await db.cashSettlements.get(doc.id))?.status === 'cerrada', 'el cuadre se reabrió')
})

await spec('CC-C05', 'cobro por transferencia: va a la bolsa; no es efectivo en manos del Cobrador', async () => {
  await empresa()
  const v = await ventaAdmin(1000)
  const b = await bolsa()
  const r = await cobra(JUAN, v, 300, 'transferencia')
  const w = await db.withdrawals.get(centralIds.cobro(r.paymentId))
  metric('bolsa', `${b} → ${await bolsa()}`)
  metric('posición Juan', await posicion(JUAN))
  assert(await posicion(JUAN) === 0, 'la transferencia se contó como efectivo del Cobrador')
  assert(await bolsa() === b + 300 && w?.centralLink?.kind === 'COBRO_NO_PERSONAL', 'la transferencia no llegó a la bolsa')
  // El efectivo SÍ es del Cobrador y no toca la bolsa.
  await cobra(JUAN, v, 100)
  assert(await bolsa() === b + 300 && await posicion(JUAN) === 100, 'el efectivo del Cobrador tocó la bolsa')
  await sano()
})

await spec('CC-C06', 'anulación de un cobro por transferencia: sale de la bolsa; bloqueada si la bolsa ya lo usó', async () => {
  await empresa({ bolsa: 2000 })
  const v = await ventaAdmin(1000)
  const r1 = await cobra(JUAN, v, 300, 'transferencia')
  const b = await bolsa()
  await annulPayment({ actor: ADMIN, tenantId: T, paymentId: r1.paymentId, reason: 'Pago duplicado' })
  metric('bolsa al anular', `${b} → ${await bolsa()}`)
  assert(await bolsa() === b - 300, 'la anulación no revirtió el retorno a la bolsa')
  await sano()
  const r2 = await cobra(JUAN, v, 400, 'transferencia')
  await entregar(FABIO, await bolsa())
  const e = await sinEfecto(() => annulPayment({ actor: ADMIN, tenantId: T, paymentId: r2.paymentId, reason: 'Pago duplicado' }))
  metric('anular con la bolsa vacía', e)
})

await spec('CC-C07', 'corrección de un cobro por transferencia: la bolsa refleja solo la diferencia', async () => {
  await empresa()
  const v = await ventaAdmin(1000)
  const r = await cobra(JUAN, v, 300, 'transferencia')
  const b = await bolsa()
  const c = await correctPayment(ADMIN, r.paymentId, { newValor: 250, reason: 'Valor mal digitado' })
  assert(c.success, `corrección rechazada: ${c.error}`)
  metric('bolsa', `${b} → ${await bolsa()}`)
  assert(await bolsa() === b - 50, 'la bolsa no refleja la diferencia')
  assert(await db.withdrawals.get(centralIds.cobro(c.correctedId!)), 'el pago corregido no volvió a la bolsa')
  await sano()
})

await spec('CC-C08', 'gastos del Cobrador: pueden dejar negativo y no tocan la bolsa; el cuadre lo documenta sin mover dinero', async () => {
  await empresa()
  const b = await bolsa()
  await createExpense({ actor: JUAN, tenantId: T, scope: 'trabajador', routeId: R1, collectorId: JUAN.id, categoryId: CAT, valor: 100, descripcion: 'Combustible' })
  metric('posición', await posicion(JUAN))
  assert(await posicion(JUAN) === -100 && await bolsa() === b, 'el gasto tocó la bolsa o no dejó el negativo')
  const retirosAntes = await db.withdrawals.count()
  const doc = await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: JUAN.id, entregado: 0, motivo: 'Pagó el combustible de su bolsillo' })
  const c = await conciliacion()
  metric('cuadre', `esperado ${doc.esperado} · sobrante ${doc.sobrante}`)
  metric('Sin asignar / efectivo físico', `${c.noAsignado} / ${c.efectivoFisicoNoAsignado}`)
  assert(await db.withdrawals.count() === retirosAntes && await bolsa() === b, 'el cuadre negativo movió la bolsa')
  assert(doc.sobrante === 100 && c.efectivoFisicoNoAsignado === 0 && c.cuadra, 'tratamiento del negativo distinto del vigente (EXP-CASH-010)')
  assert(await posicion(JUAN) === 0, 'el ciclo siguiente no parte limpio')
})

await spec('CC-C09', 'desembolso administrativo y gasto de ruta: pagados con la bolsa, con tope en su disponible', async () => {
  await empresa({ bolsa: 1500 })
  await ventaAdmin(1000)
  assert(await bolsa() === 500, 'la venta del Admin no descontó de la bolsa')
  assert(await db.capitalMovements.where('routeId').equals(R1).count() === 1, 'no se registró el capital enlazado')
  metric('venta del Admin sin bolsa', await sinEfecto(async () => createDirectSale(await entrada(ADMIN, 600), ADMIN)).catch(() => 'rechazado'))
  const gasto = await createExpense({ actor: ADMIN, tenantId: T, scope: 'ruta', routeId: R1, categoryId: CAT, valor: 200, descripcion: 'Papelería' })
  metric('bolsa tras gasto de ruta', await bolsa())
  assert(await bolsa() === 300 && (await db.capitalMovements.get(centralIds.gastoRuta(gasto.id)))?.valor === 200, 'el gasto de ruta no salió de la bolsa')
  metric('gasto de ruta sin bolsa', await sinEfecto(() => createExpense({ actor: ADMIN, tenantId: T, scope: 'ruta', routeId: R1, categoryId: CAT, valor: 400, descripcion: 'Exceso' })))
  await sano()
})

// ============================================================
// D. COMPATIBILIDAD
// ============================================================
await spec('CC-D01', 'datos v16 sin activar: todo funciona como antes y no se crean vínculos centralizados', async () => {
  await empresa({ activar: false })
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 2000 })
  await assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R1, recipientUserId: JUAN.id, amount: 500, motivo: 'Base' })
  const v = await ventaAdmin(300)
  await cobra(JUAN, v, 100, 'transferencia')
  await returnBaseFromWorker({ actor: ADMIN, tenantId: T, routeId: R1, fromUserId: JUAN.id, amount: 200, motivo: 'Devolución' })
  await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: JUAN.id, entregado: await posicion(JUAN) })
  const vinculados = [...await db.capitalMovements.toArray(), ...await db.withdrawals.toArray(), ...await db.cashCustodyMovements.toArray()]
    .filter(m => (m as { centralLink?: unknown }).centralLink).length
  metric('vínculos centralizados', vinculados)
  metric('Sin asignar (v16)', (await conciliacion()).noAsignado)
  assert(vinculados === 0, 'sin activar se crearon movimientos del modelo nuevo')
  assert((await db.tenants.get(T))?.centralCapitalStartAt === undefined, 'el modelo se activó solo')
  metric('entrega centralizada sin activar', await sinEfecto(() => entregar(JUAN, 100)))
})

await spec('CC-D02', 'activación explícita: solo el SuperAdmin; idempotente; no toca ningún movimiento financiero', async () => {
  await empresa({ activar: false, heredado: 1200 })
  const financieras = async () => JSON.stringify(await Promise.all(
    [db.capitalMovements, db.withdrawals, db.transfers, db.capitalLedger, db.cashCustodyMovements, db.payments, db.sales, db.expenses, db.cashSettlements, db.weeklySettlements, db.partnerCashMovements]
      .map(t => t.toArray())))
  const antes = await financieras()
  metric('Admin intenta activar', await sinEfecto(() => activateCentralCapitalModel({ actor: ADMIN, tenantId: T, motivo: 'No autorizado' })))
  metric('SuperAdmin sin respaldo', await sinEfecto(() => activateCentralCapitalModel({ actor: SA, tenantId: T, motivo: 'Sin respaldo' })))
  const t1 = await activar()
  const t2 = await activar()
  const audit = (await db.auditLogs.toArray()).filter(l => l.action === 'CENTRAL_CAPITAL_ACTIVATED')
  metric('activo desde', t1.centralCapitalStartAt)
  metric('auditorías de activación', audit.length)
  assert(t1.centralCapitalStartAt && t1.centralCapitalStartAt === t2.centralCapitalStartAt, 'la activación no es idempotente')
  assert(await financieras() === antes, 'activar modificó movimientos financieros')
  assert(audit.length === 1 && JSON.stringify(audit[0].metadata).includes('1200'), 'la auditoría no guarda la foto del saldo heredado')
})

await spec('CC-D03', 'diagnóstico de transición: limpia, saldo heredado, inconsistente y sin responsable (solo lectura)', async () => {
  await empresa({ activar: false, heredado: 800 })
  // Dos: un cuadre archivado con cifras imposibles (dato histórico corrupto sintético):
  // entregó 500 con esperado 0 y sin sobrante → la conciliación deja de cuadrar.
  const ahora = nowISO()
  await db.cashSettlements.add({
    id: 'cs-forjado', tenantId: T, routeId: R2, userId: JUAN.id, desde: '2026-01-01T00:00:00.000Z', hasta: ahora, origenDesde: 'inicio-modelo',
    arrastreAnterior: 0, recaudado: 0, desembolsado: 0, gastos: 0, esperado: 0, entregado: 500, diferencia: 0, faltante: 0, sobrante: 0,
    status: 'cerrada', version: 1, createdAt: ahora, closedAt: ahora, closedByUserId: ADMIN.id,
  } as never)
  const antes = await foto()
  const d = await diagnoseCentralCapitalTransition({ actor: SA, tenantId: T })
  const deAdmin = await diagnoseCentralCapitalTransition({ actor: ADMIN_2, tenantId: T })
  for (const r of d.rutas) metric(r.nombre, `${r.estado} · Sin asignar ${r.sinAsignar} · cuadra ${r.cuadra} · ${r.explicacion}`)
  const estado = (id: string) => d.rutas.find(r => r.routeId === id)?.estado
  assert(estado(R1) === 'saldo-heredado' && estado(R2) === 'inconsistente' && estado(R3) === 'sin-responsable', 'clasificación incorrecta')
  assert(deAdmin.rutas.length === 0, 'un Administrador ve rutas que no controla')
  assert(d.rutas.every(r => r.explicacion.length > 20), 'falta la explicación de alguna ruta')
  assert(await foto() === antes, 'el diagnóstico escribió en la base')
  assert(!d.activo, 'el diagnóstico activó el modelo')
})

await spec('CC-D04', 'periodos cerrados intactos: cierres archivados sin cambios y sin asientos dentro de ellos', async () => {
  await empresa({ activar: false, heredado: 1000 })
  const semana = { semanaInicio: '2026-09-01', semanaFin: '2026-09-07' }
  const calculo = await generateWeeklySettlement({ tenantId: T, routeId: R1, ...semana })
  await db.weeklySettlements.add({ ...calculo, status: 'cerrada', closedAt: nowISO(), closedByUserId: ADMIN.id, createdByUserId: ADMIN.id, version: 1 } as never)
  const cierre = JSON.stringify(await db.weeklySettlements.toArray())
  await activar()
  await entregar(JUAN, 300)
  await cobra(JUAN, await ventaAdmin(500), 100, 'transferencia')
  await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: JUAN.id, entregado: 300 })
  const dentro = [...await db.capitalMovements.toArray(), ...await db.withdrawals.toArray()]
    .filter(m => m.centralLink && m.fecha >= semana.semanaInicio && m.fecha <= semana.semanaFin)
  metric('asientos nuevos dentro del cierre', dentro.length)
  assert(JSON.stringify(await db.weeklySettlements.toArray()) === cierre, 'el cierre archivado cambió')
  assert(dentro.length === 0, 'se registraron asientos dentro de un periodo cerrado')
  metric('aporte de socio fechado en el cierre', await rechazo(() => registerPartnerContribution({ actor: ADMIN, tenantId: T, partnerId: SOCIO.id, routeId: R1, amount: 10, fecha: '2026-09-03' })))
})

await spec('CC-D05', 'esquema: Dexie sigue en v16 y abrir la base no activa el modelo en ninguna empresa', async () => {
  await empresa({ activar: false })
  db.close()
  await db.open()
  const tenants = await db.tenants.toArray()
  metric('versión Dexie', db.verno)
  metric('empresas activadas', tenants.filter(t => t.centralCapitalStartAt).length)
  assert(db.verno === 16, `la versión de Dexie cambió (${db.verno})`)
  assert(tenants.every(t => !t.centralCapitalStartAt), 'abrir la base activó el modelo')
  assert(!fs.readFileSync(path.resolve('src/lib/db.ts'), 'utf8').includes('version(17'), 'existe una versión Dexie nueva')
})

await spec('CC-D06', 'permisos de venta e interés sin cambios; solo la pantalla de transición activa el modelo y nada lo activa al cargar', async () => {
  const ctx = { tenantId: T, routeId: R1 }
  metric('Cobrador · venta directa', can(JUAN, 'sale.createDirect', ctx))
  metric('Cobrador · solicitar', can(JUAN, 'sale.createRequest', ctx))
  metric('tasas Cobrador (ruta 20, sin tasa libre) / permitidas', `${originationRatesFor('cobrador', { tasaInteres: 20, tasaLibre: false })} / ${ALLOWED_INTEREST_RATES}`)
  assert(!can(JUAN, 'sale.createDirect', ctx) && can(JUAN, 'sale.createRequest', ctx), 'permisos de venta alterados')
  assert(JSON.stringify(originationRatesFor('cobrador', { tasaInteres: 20, tasaLibre: false })) === '[20]' && JSON.stringify(ALLOWED_INTEREST_RATES) === '[10,20]', 'política de interés alterada')
  const archivos: string[] = []
  const recorrer = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name)
      if (f.isDirectory()) recorrer(p)
      else if (/\.(tsx?|jsx?)$/.test(f.name)) archivos.push(p)
    }
  }
  for (const d of ['src/pages', 'src/components', 'src/app', 'src/hooks']) recorrer(path.resolve(d))
  // C2: las pantallas usan los servicios del modelo, pero SOLO la de transición puede activarlo.
  const activan = archivos.filter(f => /activateCentralCapitalModel/.test(fs.readFileSync(f, 'utf8')))
  metric('archivos de UI que activan', activan.map(f => path.basename(f)).join(', '))
  assert(activan.length === 1 && activan[0].endsWith('CentralCapitalTransitionPage.tsx'), `la activación se invoca fuera de la pantalla de transición: ${activan.join(', ')}`)
  // Nada la invoca al arrancar ni al abrir la base.
  for (const f of ['src/main.tsx', 'src/app/App.tsx', 'src/lib/db.ts', 'src/hooks/useAuth.ts', 'src/services/authService.ts']) {
    if (fs.existsSync(path.resolve(f))) assert(!/activateCentralCapitalModel|centralCapitalStartAt\s*=/.test(fs.readFileSync(path.resolve(f), 'utf8')), `${f} activa el modelo`)
  }
})

// ============================================================
// E. TRANSICIÓN CONTROLADA (C2): respaldo, activación, bloqueos y liberación
// ============================================================
await spec('CC-E01', 'respaldo: completo, sin contraseñas ni otras empresas; se rechaza alterado, ajeno o desactualizado', async () => {
  await empresa({ activar: false, heredado: 1000 })
  await db.tenants.add({ id: 't-otra', nombre: 'Otra', status: 'activa', plan: 'profesional', createdAt: '2026-01-01' } as never)
  await db.users.add({ ...persona('u-ajeno', 'Ajeno', 'admin', []), tenantId: 't-otra' } as User)
  const { file, text } = await buildCentralCapitalBackup({ actor: SA, tenantId: T })
  metric('tablas / registros', `${Object.keys(file.tablas).length} / ${Object.values(file.conteos).reduce((a, b) => a + b, 0)}`)
  assert(file.tablas.capitalMovements.length === 1 && file.tablas.capitalLedger.length > 0 && 'installments' in file.tablas, 'faltan tablas en el respaldo')
  assert(!text.includes('"password"'), 'el respaldo contiene contraseñas')
  assert(!text.includes('u-ajeno'), 'el respaldo contiene datos de otra empresa')
  // Archivo alterado: una cifra cambiada.
  const alterado = JSON.parse(text); alterado.tablas.capitalMovements[0].valor = 999999
  const v1 = await verifyCentralCapitalBackup({ actor: SA, tenantId: T, text: JSON.stringify(alterado) })
  metric('alterado', v1.problemas.join(' | '))
  assert(!v1.ok, 'se aceptó un respaldo alterado')
  const ajeno = JSON.parse(text); ajeno.tenantId = 't-otra'
  assert(!(await verifyCentralCapitalBackup({ actor: SA, tenantId: T, text: JSON.stringify(ajeno) })).ok, 'se aceptó un respaldo de otra empresa')
  assert(!(await verifyCentralCapitalBackup({ actor: SA, tenantId: T, text: '{no es json' })).ok, 'se aceptó un archivo ilegible')
  metric('Admin exporta', await rechazo(() => buildCentralCapitalBackup({ actor: ADMIN, tenantId: T })))
  // Correcto y vigente.
  const ok = await verifyCentralCapitalBackup({ actor: SA, tenantId: T, text })
  assert(ok.ok && (await centralCapitalBackupStatus(T)).vigente, 'el respaldo correcto no quedó vigente')
  // Movimiento posterior: deja de estar vigente y la activación se rechaza.
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 50 })
  const st = await centralCapitalBackupStatus(T)
  metric('tras un movimiento', st.motivo)
  assert(!st.vigente, 'el respaldo siguió vigente tras un movimiento')
  metric('activar con respaldo desactualizado', await sinEfecto(() => activateCentralCapitalModel({ actor: SA, tenantId: T, motivo: 'Desactualizado' })))
  const viejo = await verifyCentralCapitalBackup({ actor: SA, tenantId: T, text })
  assert(!viejo.ok, 'se verificó un respaldo anterior a los movimientos')
})

await spec('CC-E02', 'activación: foto del saldo heredado, rutas inconsistentes y sin responsable bloqueadas; auditoría con las huellas', async () => {
  await empresa({ activar: false, heredado: 700 })
  const ahora = nowISO()
  await db.cashSettlements.add({
    id: 'cs-forjado', tenantId: T, routeId: R2, userId: JUAN.id, desde: '2026-01-01T00:00:00.000Z', hasta: ahora, origenDesde: 'inicio-modelo',
    arrastreAnterior: 0, recaudado: 0, desembolsado: 0, gastos: 0, esperado: 0, entregado: 500, diferencia: 0, faltante: 0, sobrante: 0,
    status: 'cerrada', version: 1, createdAt: ahora, closedAt: ahora, closedByUserId: ADMIN.id,
  } as never)
  const listo = await getActivationReadiness({ actor: SA, tenantId: T })
  metric('antes: requiere respaldo / puede activar / a bloquear', `${listo.requiereRespaldo} / ${listo.puedeActivar} / ${listo.rutasABloquear.join(',')}`)
  assert(listo.requiereRespaldo && !listo.puedeActivar, 'se podía activar sin respaldo')
  const t = await activar()
  metric('bloqueos', JSON.stringify(Object.fromEntries(Object.entries(t.centralCapitalRouteBlocks ?? {}).map(([k, v]) => [k, v.estado]))))
  metric('heredado al activar', JSON.stringify(t.centralCapitalHeritage))
  assert(t.centralCapitalHeritage?.[R1] === 700, 'no quedó la foto del saldo heredado')
  assert(t.centralCapitalRouteBlocks?.[R2]?.estado === 'inconsistente' && t.centralCapitalRouteBlocks?.[R3]?.estado === 'sin-responsable', 'bloqueos incorrectos')
  assert(!t.centralCapitalRouteBlocks?.[R1], 'una ruta con saldo heredado consistente quedó bloqueada')
  const audit = (await db.auditLogs.toArray()).find(l => l.action === 'CENTRAL_CAPITAL_ACTIVATED')
  assert(audit && JSON.stringify(audit.metadata).includes(t.centralCapitalBackup!.integridad), 'la auditoría no guarda la huella del respaldo')
})

await spec('CC-E03', 'ruta bloqueada: no recibe capital nuevo; cuadres y devoluciones siguen; liberación revisada por el SuperAdmin', async () => {
  await empresa({ activar: false })
  // Uno con capital y efectivo en manos de Juan (v16), luego se forja la inconsistencia.
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 600 })
  await assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R1, recipientUserId: JUAN.id, amount: 400, motivo: 'Base' })
  const ahora = nowISO()
  await db.cashSettlements.add({
    id: 'cs-forjado', tenantId: T, routeId: R1, userId: FABIO.id, desde: '2026-01-01T00:00:00.000Z', hasta: ahora, origenDesde: 'inicio-modelo',
    arrastreAnterior: 0, recaudado: 0, desembolsado: 0, gastos: 0, esperado: 0, entregado: 300, diferencia: 0, faltante: 0, sobrante: 0,
    status: 'cerrada', version: 1, createdAt: ahora, closedAt: ahora, closedByUserId: ADMIN.id,
  } as never)
  await activar()
  metric('entregar capital', await sinEfecto(() => entregar(JUAN, 100)))
  metric('venta del Admin', await sinEfecto(async () => createDirectSale(await entrada(ADMIN, 100), ADMIN)).catch(() => 'rechazado'))
  metric('gasto de ruta', await sinEfecto(() => createExpense({ actor: ADMIN, tenantId: T, scope: 'ruta', routeId: R1, categoryId: CAT, valor: 10, descripcion: 'Papel' })))
  // El efectivo que ya existe sigue su curso: devolución y cuadre van a la bolsa.
  const b = await bolsa()
  await returnCapitalFromWorker({ actor: ADMIN, tenantId: T, routeId: R1, fromUserId: JUAN.id, amount: 100, motivo: 'Devolución en ruta bloqueada' })
  await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: JUAN.id, entregado: 300 })
  assert(await bolsa() === b + 400, 'la devolución o el cuadre no llegaron a la bolsa en la ruta bloqueada')
  // Liberación: Admin no; motivo corto no; inconsistente sin aceptación no.
  metric('Admin libera', await sinEfecto(() => releaseCentralCapitalRoute({ actor: ADMIN, tenantId: T, routeId: R1, motivo: 'Revisión completa realizada' })))
  metric('motivo corto', await sinEfecto(() => releaseCentralCapitalRoute({ actor: SA, tenantId: T, routeId: R1, motivo: 'ok' })))
  metric('sin aceptar la diferencia', await sinEfecto(() => releaseCentralCapitalRoute({ actor: SA, tenantId: T, routeId: R1, motivo: 'Revisión completa realizada' })))
  metric('ruta sin responsable', await sinEfecto(() => releaseCentralCapitalRoute({ actor: SA, tenantId: T, routeId: R3, motivo: 'Revisión completa realizada', aceptarInconsistencia: true })))
  await releaseCentralCapitalRoute({ actor: SA, tenantId: T, routeId: R1, motivo: 'Revisión completa: cuadre forjado documentado', aceptarInconsistencia: true })
  await entregar(JUAN, 100)
  assert(!(await db.tenants.get(T))?.centralCapitalRouteBlocks?.[R1], 'la ruta sigue bloqueada')
  assert((await db.auditLogs.toArray()).some(l => l.action === 'CENTRAL_CAPITAL_ROUTE_RELEASED' && l.routeId === R1), 'la liberación no quedó auditada')
})

await spec('CC-E04', 'empresa sin movimientos: se activa sin respaldo; la ruta nueva nace sin capital en su caja', async () => {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.add({ id: T, nombre: 'Nueva', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z' } as never)
  await db.users.bulkAdd([SA, ADMIN])
  const l = await getActivationReadiness({ actor: SA, tenantId: T })
  assert(!l.requiereRespaldo && l.puedeActivar, 'una empresa vacía exigía respaldo')
  await activateCentralCapitalModel({ actor: SA, tenantId: T, motivo: 'Empresa nueva' })
  const conCapital = await rechazo(() => createRouteWithAdmins({ tenantId: T, nombre: 'Cinco', codigo: 'R5', tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 1000, capitalInicial: 500, adminIds: [ADMIN.id] } as never, ADMIN, db as never, async () => undefined, async () => undefined))
  metric('ruta con capital inicial', conCapital)
  assert(conCapital !== 'ACEPTADO' && await db.capitalMovements.count() === 0, 'se colocó capital inicial en la caja de una ruta')
  const r = await createRouteWithAdmins({ tenantId: T, nombre: 'Cinco', codigo: 'R5', tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 1000, capitalInicial: 0, adminIds: [ADMIN.id] } as never, ADMIN, db as never, async () => undefined, async () => undefined)
  assert(r.id && await db.capitalMovements.count() === 0, 'la ruta sin capital no se creó limpia')
})

await spec('CC-E05', 'esperado negativo antes de activar: saldo heredado explicado; no crea capital ni borra obligaciones', async () => {
  await empresa({ activar: false })
  // Uno: sin capital. Fabio gasta 80 sin efectivo y cuadra en 0 → "Sin asignar" −80 explicado por el sobrante.
  await createExpense({ actor: FABIO, tenantId: T, scope: 'trabajador', routeId: R1, collectorId: FABIO.id, categoryId: CAT, valor: 80, descripcion: 'Combustible' })
  await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: FABIO.id, entregado: 0, motivo: 'Pagó el combustible de su bolsillo' })
  // Dos: Juan queda con un faltante de 50 (obligación pendiente).
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R2, valor: 1000 })
  await assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R2, recipientUserId: JUAN.id, amount: 300, motivo: 'Base' })
  await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R2, userId: JUAN.id, entregado: 250, motivo: 'Faltaron cincuenta reales' })
  const antes = await conciliacion(R1)
  const diag = await diagnoseCentralCapitalTransition({ actor: SA, tenantId: T })
  const d1 = diag.rutas.find(r => r.routeId === R1)!
  const d2 = diag.rutas.find(r => r.routeId === R2)!
  metric('Uno antes de activar', `Sin asignar ${antes.noAsignado} · físico ${antes.efectivoFisicoNoAsignado} · sobrantes ${d1.sobrantesRegistrados} · ${d1.estado}`)
  metric('Dos antes de activar', `faltantes ${d2.faltantesPendientes} · ${d2.estado}`)
  assert(antes.noAsignado === -80 && antes.efectivoFisicoNoAsignado === 0, 'el escenario no reproduce el negativo explicado')
  assert(d1.estado === 'saldo-heredado' && d1.sobrantesRegistrados === 80, 'el negativo explicado no se clasificó como saldo heredado')
  assert(d2.faltantesPendientes === 50, 'el faltante no aparece en el diagnóstico')
  const t = await activar()
  assert(!t.centralCapitalRouteBlocks?.[R1] && t.centralCapitalHeritage?.[R1] === -80, 'activación incorrecta para el negativo explicado')
  const b0 = await bolsa()
  // Operaciones nuevas en Uno: la bolsa cambia solo por lo real; el heredado no crece.
  await entregar(JUAN, 200)
  await createExpense({ actor: JUAN, tenantId: T, scope: 'trabajador', routeId: R1, collectorId: JUAN.id, categoryId: CAT, valor: 300, descripcion: 'Reparación' })
  await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: JUAN.id, entregado: 0, motivo: 'Gastó más de lo que tenía a cargo' })
  const despues = await conciliacion(R1)
  metric('Uno después', `Sin asignar ${despues.noAsignado} · físico ${despues.efectivoFisicoNoAsignado} · bolsa ${b0} → ${await bolsa()}`)
  assert(await bolsa() === b0 - 200, 'la bolsa cambió por algo distinto de la entrega real')
  assert(despues.noAsignado <= antes.noAsignado && despues.efectivoFisicoNoAsignado === 0, 'el saldo heredado creció o se fabricó efectivo físico')
  // Nada vacía un heredado negativo: su disponible es 0.
  metric('retirar del heredado negativo', await sinEfecto(() => registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R1, valor: 1 })))
  metric('entregar del heredado negativo', await sinEfecto(() => assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R1, recipientUserId: FABIO.id, amount: 1, motivo: 'x' })))
  // Obligaciones intactas: sobrantes documentados y el faltante de Juan sigue en su posición de Dos.
  const cuadres = await db.cashSettlements.toArray()
  assert(cuadres.some(c => c.userId === FABIO.id && c.sobrante === 80 && c.status === 'cerrada'), 'desapareció el sobrante documentado')
  assert(cuadres.some(c => c.userId === JUAN.id && c.routeId === R2 && c.faltante === 50 && c.status === 'cerrada'), 'el faltante histórico se borró o reescribió')
  const c2 = await conciliacion(R2)
  assert(c2.faltantes.some(f => f.userId === JUAN.id && f.monto === 50) && await posicion(JUAN, R2) === 50, 'el faltante dejó de estar pendiente')
  assert((await invariantes()).length === 0 && despues.cuadra && c2.cuadra, 'invariantes o conciliación rotos')
})

await spec('CC-E06', 'corrección de un cobro histórico: circuito histórico separado, identificado y sin tocar la bolsa', async () => {
  await empresa({ activar: false, heredado: 2000 })
  const v = await ventaAdmin(1000)   // v16: sale de la caja de la ruta
  const historico = await cobra(JUAN, v, 300, 'transferencia')
  await activar()
  const b = await bolsa()
  const heredadoAntes = (await conciliacion()).noAsignado
  const c = await correctPayment(ADMIN, historico.paymentId, { newValor: 250, reason: 'Valor mal digitado' })
  assert(c.success, `corrección rechazada: ${c.error}`)
  const heredadoDespues = (await conciliacion()).noAsignado
  const d = (await diagnoseCentralCapitalTransition({ actor: SA, tenantId: T })).rutas.find(r => r.routeId === R1)!
  metric('heredado', `${heredadoAntes} → ${heredadoDespues}`)
  metric('ajustes históricos', `${d.ajustesHistoricos.cantidad} por ${d.ajustesHistoricos.total}`)
  assert(await bolsa() === b, 'la corrección histórica movió la bolsa')
  assert(heredadoDespues === heredadoAntes - 50, 'el ajuste histórico no se reflejó en el saldo heredado')
  assert(!(await db.withdrawals.toArray()).some(w => w.centralLink), 'la corrección se registró como operación de capital nueva')
  assert(d.ajustesHistoricos.cantidad === 2 && d.ajustesHistoricos.total === -50, 'el ajuste histórico no quedó identificado')
})

// ============================================================
// F. INTERFAZ: catálogos, informes y contratos de pantalla
// ============================================================
await spec('CC-F01', 'asistente: en modo centralizado solo entregar/recibir capital y vaciar el heredado donde existe', async () => {
  await empresa()
  const us = await db.users.toArray()
  const rs = await db.routes.toArray()
  const modo = { central: true, heredado: { [R1]: 500, [R2]: 0 } }
  const opsAdmin = availableOperations(ADMIN, rs, us, T, modo)
  const opsV16 = availableOperations(ADMIN, rs, us, T)
  metric('Admin centralizado', opsAdmin.join(', '))
  metric('Admin v16', opsV16.join(', '))
  assert(JSON.stringify(opsAdmin.sort()) === JSON.stringify(['devolver-capital', 'entregar-base', 'entregar-capital', 'retirar']), 'operaciones centralizadas incorrectas')
  assert(!opsAdmin.includes('ruta-ruta') && !opsAdmin.includes('colocar') && !opsAdmin.includes('devolver-base'), 'quedó una operación de caja de ruta')
  assert(routesForOperation('retirar', ADMIN, rs, us, T, modo).map(r => r.id).join() === R1, 'el vaciado se ofrece en rutas sin heredado')
  assert(JSON.stringify(opsV16.sort()) === JSON.stringify(['colocar', 'devolver-base', 'entregar-base', 'retirar', 'ruta-ruta']), 'el modo v16 cambió')
  assert(availableOperations(JUAN, rs, us, T, modo).length === 0, 'el Cobrador puede mover capital')
  assert(JSON.stringify(availableOperations(LAURA, rs, us, T, modo)) === JSON.stringify(['devolver-capital']), 'la Supervisora tiene operaciones de más')
  // [MODIFICADO R74] Antes el SuperAdmin conservaba «devolver-capital» (recibir devoluciones); ya no opera la caja de ninguna ruta.
  assert(availableOperations(SA, rs, us, T, modo).length === 0, 'el SuperAdmin opera la caja de una ruta')
  const p = previewTransferOperation({ kind: 'entregar-capital', importe: 300, ruta: { disponible: 0, sinAsignar: 0, posiciones: { [JUAN.id]: 200 } }, trabajadorId: JUAN.id, bolsa: 1000, nombres: {} })
  assert(p.origen.despues === 700 && p.destino.despues === 500 && p.limite === 1000 && !p.excede, 'vista previa de la entrega incorrecta')
})

await spec('CC-F02', 'informes: retornos de cuadre y cobros no en efectivo separados de los retiros; sumas iguales a la caja', async () => {
  await empresa({ activar: false, heredado: 400 })
  await registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R1, valor: 100 })
  await activar()
  await entregar(JUAN, 500)
  await cobra(JUAN, await ventaAdmin(300), 120, 'transferencia')
  await closeCashSettlement({ actor: ADMIN, tenantId: T, routeId: R1, userId: JUAN.id, entregado: 500 })
  await registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R1, valor: 50 })   // vaciado del heredado
  const caja = await getCashboxSummary(R1)
  const f = await getCapitalFlowBreakdown(R1)
  metric('capital', JSON.stringify(f.capital))
  metric('retiros', JSON.stringify(f.retiros))
  const suma = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)
  assert(suma(f.capital) === caja.ingresoCapital && suma(f.retiros) === caja.retiros, 'el desglose no suma los totales de la caja')
  assert(f.retiros.retornosDeCuadre === 500 && f.retiros.cobrosNoEnEfectivo === 120 && f.retiros.retirosDeCaja === 150, 'clasificación de retiros incorrecta')
  assert(f.capital.entregasATrabajadores === 500 && f.capital.desembolsosDelAdministrador === 300 && f.capital.aCajaDeRuta === 400, 'clasificación de capital incorrecta')
  // Estado de cuenta de la bolsa: cada operación con su nombre y la conciliación cuadra.
  const st = await getAdminPoolStatement({ actor: ADMIN, tenantId: T, adminId: ADMIN.id })
  const kinds = new Set(st.movimientos.map(m => m.kind))
  metric('tipos en la bolsa', [...kinds].join(', '))
  assert(kinds.has('retornoCuadre') && kinds.has('cobroNoPersonal') && kinds.has('entregaTrabajador') && kinds.has('desembolsoAdmin') && kinds.has('retiroRuta'), 'la bolsa no distingue las operaciones')
  assert(st.conciliacion.diferencia === 0, `la conciliación de la bolsa no cuadra (${st.conciliacion.diferencia})`)
})

await spec('CC-F03', 'contratos de pantalla: servicios C1 en la interfaz, sin cálculos propios ni circuitos equivocados', async () => {
  const src = (f: string) => fs.readFileSync(path.resolve(f), 'utf8')
  const wizard = src('src/components/transfers/OperationWizard.tsx')
  const capital = src('src/pages/admin/CapitalPage.tsx')
  const transfers = src('src/pages/admin/TransfersPage.tsx')
  const retiros = src('src/pages/admin/WithdrawalsPage.tsx')
  const panel = src('src/components/settlement/WorkerCashSettlementPanel.tsx')
  const cobrador = src('src/pages/collector/CollectorCashClosePage.tsx')
  const transicion = src('src/pages/admin/CentralCapitalTransitionPage.tsx')
  const checks: [string, boolean][] = [
    ['asistente usa deliverCapitalToWorker/returnCapitalFromWorker', wizard.includes('deliverCapitalToWorker(') && wizard.includes('returnCapitalFromWorker(')],
    ['asistente filtra por modo', wizard.includes('availableOperations(user, routes, users, tenantId, modo)')],
    ['Capital: colocar/retirar solo fuera del modo centralizado', /central\.activo \? \([\s\S]*?Entregar capital[\s\S]*?\) : \([\s\S]*?Colocar capital/.test(capital)],
    ['Capital: entrega anulada como par', capital.includes('reverseCapitalDelivery(')],
    ['Transferencias: sin Socio → Ruta con el modelo activo', transfers.includes("!(central.activo && o.value.startsWith('route:'))")],
    ['Transferencias: aporte de socio a la bolsa', transfers.includes('registerPartnerContribution(')],
    ['Retiros: excluye patas centralizadas', retiros.includes('.filter(w => !w.centralLink)')],
    ['Cuadre: servicios de capital en modo centralizado', panel.includes('deliverCapitalToWorker(') && panel.includes('returnCapitalFromWorker(')],
    ['Cobrador: «Base recibida» y sin bolsa', cobrador.includes('Base recibida') && !/capitalControlService|getAdminAvailableCapital|adminCapital/.test(cobrador)],
    ['Transición: respaldo y confirmación escrita', transicion.includes('verifyCentralCapitalBackup(') && transicion.includes('PALABRA')],
    ['Ninguna pantalla escribe capital directamente', ![wizard, capital, transfers, retiros, panel, transicion].some(s => /db\.(capitalMovements|withdrawals|capitalLedger|cashCustodyMovements|tenants)\.(add|put|update)/.test(s))],
  ]
  for (const [k, v] of checks) metric(k, v)
  assert(checks.every(([, v]) => v), 'contrato de pantalla incumplido')
  // Marcadores de despliegue para C2 (presentes en el bundle cuando se publique).
  const marcadores = src('scripts/verify-deploy.mjs')
  assert(marcadores.includes('Capital centralizado') && marcadores.includes('Base recibida y devuelta en este periodo'), 'faltan marcadores de despliegue de C2')
})

// ============================================================
// Resumen
// ============================================================
let ok = 0
for (const r of results) {
  if (r.passed) ok++
  console.log(`${r.passed ? '✔' : '✘'} ${r.id} ${r.desc}`)
  for (const m of r.metrics) console.log(`     · ${m}`)
  if (!r.passed) console.log(`     ✘ ${r.error}`)
}
const fallidas = results.length - ok
// Formato de total que reconoce el banco de contratos (`parseSuiteTotals`).
console.log(`\n  TOTAL: ${results.length} casos   ${ok} PASS   ${fallidas} FAIL`)
console.log(`SUITE CAPITAL CENTRALIZADO: ${ok} OK, ${fallidas} FALLIDAS (${results.length} casos)`)
if (fallidas > 0) process.exit(1)
