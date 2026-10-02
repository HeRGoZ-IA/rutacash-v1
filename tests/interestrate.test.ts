// ============================================================
// RUTACASH — SUITE TASA DE INTERÉS POR ROL (DEXIE REAL)
// ------------------------------------------------------------
//   npm run test:interestrate
//
// Ajuste del socio 2026-10-02, punto 1: el Cobrador solo origina créditos al 20%;
// el 10% se aplica en la autorización (Secretario y demás autorizadores). Ejecuta
// los SERVICIOS DE PRODUCCIÓN sobre el singleton `db` (Dexie + fake-indexeddb).
//
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import {
  approveSaleRequest, computeSaleFinancials, createDirectSale, createSaleRequest, type SaleInputs,
} from '../src/services/saleRequestService'
import {
  ALLOWED_INTEREST_RATES, COLLECTOR_INTEREST_RATE, canOriginateAtRate, originationRatesFor,
} from '../src/lib/interestRatePolicy'
import { today } from '../src/lib/formatters'
import type { Client, Sale, User } from '../src/models/types'
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

/** Ejecuta y devuelve 'ACEPTADO' o el mensaje del rechazo. */
async function rechazo(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'ACEPTADO' } catch (e) { return e instanceof Error ? e.message : String(e) }
}

// ============================================================
// Escenario
// ============================================================
const T = 't-tasa'
const OF = 'of-centro'
const R = 'r-centro'
const HOY = today()

const base = (id: string, nombre: string, rol: User['rol']): User => ({
  id, tenantId: T, nombre, email: `${id}@tasa.co`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: [R], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)

const ADMIN = base('u-admin', 'Andrés Admin', 'admin')
const JUAN = base('u-juan', 'Juan Cobrador', 'cobrador')
const LAURA = base('u-laura', 'Laura Supervisora', 'supervisor')
const SECRE = base('u-secre', 'Sergio Secretario', 'secretario')

async function empresa() {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.add({ id: T, nombre: 'Tasa', status: 'activa', plan: 'profesional', createdAt: '2026-01-01' } as never)
  await db.offices.add({ id: OF, tenantId: T, nombre: 'Centro', codigo: 'CEN', status: 'activa', createdAt: '', updatedAt: '' } as never)
  await db.routes.add({ id: R, tenantId: T, officeId: OF, nombre: 'Centro', codigo: 'C-1', status: 'activa', cobradorId: JUAN.id, capitalInicial: 0, capitalActual: 0, tasaInteres: 20, createdAt: '2026-09-01' } as never)
  await db.users.bulkAdd([ADMIN, JUAN, LAURA, SECRE])
  await db.capitalMovements.add({ id: 'cap', tenantId: T, routeId: R, tipo: 'ingresoCapital', valor: 50_000_000, fecha: '2026-09-01', createdAt: '' } as never)
}

let cliSeq = 0
async function cliente(): Promise<string> {
  const id = `cli-${++cliSeq}`
  await db.clients.add({ id, tenantId: T, routeId: R, nombre: `Cliente ${id}`, documento: id, status: 'activo', createdAt: '' } as never)
  return id
}

const entrada = (clientId: string, actor: User, tasaInteres: number, extra: Partial<SaleInputs> = {}): SaleInputs => ({
  tenantId: T, routeId: R, clientId, createdByUserId: actor.id, valorVenta: 1_000_000, tasaInteres, numeroCuotas: 20,
  frecuenciaPago: 'diaria', fechaInicio: HOY, paymentDays: [1, 2, 3, 4, 5, 6], ...extra,
})

/** Crédito HISTÓRICO al 10% ya desembolsado y con abonos (como lo dejaría producción). */
async function historicoAl10(clientId: string): Promise<Sale> {
  const sale = {
    id: 'sale-hist-10', tenantId: T, routeId: R, clientId, createdByUserId: JUAN.id,
    valorVenta: 500_000, tasaInteres: 10, valorInteres: 50_000, valorTotal: 550_000, saldo: 440_000,
    numeroCuotas: 10, valorCuota: 55_000, frecuenciaPago: 'diaria', paymentDays: [1, 2, 3, 4, 5, 6],
    fechaInicio: '2026-09-01', fechaFinalEstimada: '2026-09-12', status: 'activa',
    disbursementStatus: 'desembolsado', fechaDesembolso: '2026-09-01',
    createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-03T08:00:00.000Z',
  } as unknown as Sale
  await db.sales.add(sale)
  await db.installments.bulkAdd(Array.from({ length: 10 }, (_, i) => ({
    id: `${sale.id}-i${i + 1}`, saleId: sale.id, numero: i + 1, valor: 55_000,
    pagado: i < 2 ? 55_000 : 0, saldo: i < 2 ? 0 : 55_000, status: i < 2 ? 'pagada' : 'pendiente',
    fechaVencimiento: '2026-09-12', diasMora: 0,
  })) as never[])
  return sale
}

const cuenta = async () => ({ sales: await db.sales.count(), requests: await db.saleRequests.count(), clients: await db.clients.count() })

// ============================================================
// Casos
// ============================================================
await spec('TASA-001', 'Cobrador crea crédito (solicitud) al 20%', async () => {
  await empresa()
  const req = await createSaleRequest(entrada(await cliente(), JUAN, 20), JUAN)
  const guardada = (await db.saleRequests.get(req.id))!
  metric('solicitud', `${guardada.status} · ${guardada.interestRate}% · solicitada ${guardada.requestedInterestRate}%`)
  assert(guardada.status === 'pending' && guardada.interestRate === 20 && guardada.requestedInterestRate === 20, 'la solicitud al 20% no quedó registrada')
})

await spec('TASA-002', 'Cobrador al 10% → RECHAZADO, nada persistido', async () => {
  await empresa()
  const cli = await cliente()
  const antes = await cuenta()
  const msg = await rechazo(() => createSaleRequest(entrada(cli, JUAN, 10), JUAN))
  // Alta de cliente + venta en la misma operación: tampoco debe quedar el cliente.
  const nuevo = { id: 'cli-nuevo', tenantId: T, routeId: R, nombre: 'Nuevo', documento: '999', status: 'activo', createdAt: '' } as unknown as Client
  const msgNuevo = await rechazo(() => createSaleRequest(entrada(nuevo.id, JUAN, 10), JUAN, { newClient: nuevo }))
  const despues = await cuenta()
  metric('rechazo', msg)
  metric('rechazo alta+venta', msgNuevo)
  metric('antes → después', `${JSON.stringify(antes)} → ${JSON.stringify(despues)}`)
  assert(/20%/.test(msg) && /20%/.test(msgNuevo), 'no se rechazó la tasa del 10% del Cobrador')
  assert(JSON.stringify(antes) === JSON.stringify(despues), 'se persistió algo con una tasa inválida')
})

await spec('TASA-003', 'UI del Cobrador no ofrece 10%', async () => {
  const opciones = originationRatesFor('cobrador')
  metric('tasas que origina el Cobrador', opciones.map(t => `${t}%`).join(', '))
  assert(opciones.length === 1 && opciones[0] === 20 && COLLECTOR_INTEREST_RATE === 20, 'la política del Cobrador no es solo 20%')
  for (const p of ['src/pages/collector/CollectorNewSalePage.tsx', 'src/pages/collector/CollectorNewClientPage.tsx']) {
    const src = fs.readFileSync(p, 'utf8')
    // Las opciones salen de la política por rol; con una sola tasa (Cobrador) se
    // renderiza un campo fijo, no un <Select>. Ninguna lista 10/20 fija en la pantalla.
    const fijo = src.includes('originationRatesFor(user.rol)')
      && /tasas\.length === 1\s*\?\s*<Input label="Tasa de interés" value=\{`\$\{tasas\[0\]\}%`\} readOnly/.test(src)
      && !/value: '10'/.test(src)
    const valida = /originationRateError\(user\.rol,/.test(src)
    metric(p.split('/').pop()!, `campo fijo ${fijo ? 'sí' : 'NO'} · validación por rol ${valida ? 'sí' : 'NO'}`)
    assert(fijo && valida, `${p}: el Cobrador todavía puede elegir tasa`)
  }
})

await spec('TASA-004', 'Secretario conserva el 10% al autorizar (no regresión)', async () => {
  await empresa()
  const req = await createSaleRequest(entrada(await cliente(), JUAN, 20), JUAN)
  const venta = await approveSaleRequest(req.id, SECRE, { interestRate: 10 })
  const res = (await db.saleRequests.get(req.id))!
  metric('solicitada → aprobada', `${res.requestedInterestRate}% → ${res.approvedInterestRate}%`)
  metric('venta', `${venta.tasaInteres}% · interés ${venta.valorInteres} · total ${venta.valorTotal}`)
  assert(venta.tasaInteres === 10 && venta.valorInteres === 100_000 && venta.valorTotal === 1_100_000, 'el Secretario no pudo aplicar el 10%')
  assert(res.requestedInterestRate === 20 && res.approvedInterestRate === 10, 'no quedó la trazabilidad solicitada/aprobada')
  // El catálogo global conserva el 10%; Supervisor y Admin siguen originando al 10%.
  const sup = await createDirectSale(entrada(await cliente(), LAURA, 10), LAURA)
  const adm = await createDirectSale(entrada(await cliente(), ADMIN, 10), ADMIN)
  metric('catálogo global', ALLOWED_INTEREST_RATES.join('/'))
  metric('Supervisor / Admin directo al 10%', `${sup.tasaInteres}% / ${adm.tasaInteres}%`)
  assert(sup.tasaInteres === 10 && adm.tasaInteres === 10, 'se recortó el 10% a otros roles')
  assert(canOriginateAtRate('secretario', 10) && canOriginateAtRate('supervisor', 10), 'la política restringe a roles distintos del Cobrador')
  // El Secretario sigue SIN originar ventas (su modelo vigente: autoriza, no crea).
  const origina = await rechazo(async () => createSaleRequest(entrada(await cliente(), SECRE, 10), SECRE))
  metric('Secretario origina', origina)
  assert(origina !== 'ACEPTADO', 'el Secretario obtuvo capacidad de originar')
})

await spec('TASA-005', 'crédito histórico al 10% intacto', async () => {
  await empresa()
  const cli = await cliente()
  const hist = await historicoAl10(cli)
  const antes = JSON.stringify({ s: await db.sales.get(hist.id), i: await db.installments.where('saleId').equals(hist.id).sortBy('numero') })
  // Operar con la regla nueva: solicitud del Cobrador (crédito adicional) aprobada al 20% y un rechazo al 10%.
  const req = await createSaleRequest(entrada(cli, JUAN, 20), JUAN)
  await approveSaleRequest(req.id, SECRE)
  await rechazo(async () => createSaleRequest(entrada(await cliente(), JUAN, 10), JUAN))
  const ahora = await db.sales.get(hist.id)
  const despues = JSON.stringify({ s: ahora, i: await db.installments.where('saleId').equals(hist.id).sortBy('numero') })
  metric('histórico', `${ahora!.tasaInteres}% · total ${ahora!.valorTotal} · saldo ${ahora!.saldo} · cuota ${ahora!.valorCuota}`)
  assert(antes === despues, 'el crédito histórico o sus parcelas cambiaron')
  assert(ahora!.tasaInteres === 10 && ahora!.saldo === 440_000 && ahora!.valorCuota === 55_000, 'el histórico no conserva su tasa/saldo/cuota')
  // Ninguna migración de Dexie reescribe la tasa almacenada.
  const migra = /tasaInteres\s*[:=]/.test(fs.readFileSync('src/lib/db.ts', 'utf8'))
  metric('migraciones que tocan tasaInteres', migra ? 'SÍ' : 'ninguna')
  assert(!migra, 'una migración de Dexie modifica tasaInteres')
})

await spec('TASA-006', 'crédito al 20%: interés, total y cuota correctos', async () => {
  await empresa()
  const calc = computeSaleFinancials({ valorVenta: 1_000_000, tasaInteres: 20, numeroCuotas: 20, frecuenciaPago: 'diaria', fechaInicio: HOY, paymentDays: [1, 2, 3, 4, 5, 6] })
  const req = await createSaleRequest(entrada(await cliente(), JUAN, 20), JUAN)
  const venta = await approveSaleRequest(req.id, SECRE)
  const parcelas = await db.installments.where('saleId').equals(venta.id).toArray()
  const suma = parcelas.reduce((a, p) => a + p.valor, 0)
  metric('cálculo', `interés ${calc.valorInteres} · total ${calc.valorTotal} · cuota ${calc.valorCuota}`)
  metric('venta', `${venta.tasaInteres}% · total ${venta.valorTotal} · saldo ${venta.saldo} · ${parcelas.length} parcelas suman ${suma}`)
  assert(calc.valorInteres === 200_000 && calc.valorTotal === 1_200_000 && calc.valorCuota === 60_000, 'cálculo financiero al 20% incorrecto')
  assert(venta.tasaInteres === 20 && venta.valorTotal === 1_200_000 && venta.saldo === 1_200_000 && venta.valorCuota === 60_000, 'la venta no refleja el cálculo')
  assert(parcelas.length === 20 && suma === 1_200_000, 'las parcelas no cuadran con el total')
})

await spec('TASA-007', 'bypass de servicio: Cobrador + 10% rechazado sin UI', async () => {
  await empresa()
  const antes = await cuenta()
  const intentos: [string, () => Promise<unknown>][] = [
    // Payload directo al servicio, sin pasar por la pantalla.
    ['solicitud 10%', async () => createSaleRequest(entrada(await cliente(), JUAN, 10), JUAN)],
    // Suplantar al creador en el payload: la regla mira al ACTOR, no `createdByUserId`.
    ['createdBy=Supervisor', async () => createSaleRequest(entrada(await cliente(), LAURA, 10), JUAN)],
    // Tipos manipulados desde DevTools.
    ['tasa "10" (texto)', async () => createSaleRequest(entrada(await cliente(), JUAN, '10' as unknown as number), JUAN)],
    ['tasa 10.0001', async () => createSaleRequest(entrada(await cliente(), JUAN, 10.0001), JUAN)],
    // Venta directa al 10%: el Cobrador tampoco tiene esa vía.
    ['directa 10%', async () => createDirectSale(entrada(await cliente(), JUAN, 10), JUAN)],
    // Capacidad delegada: `sale.createDirect` es incompatible con Cobrador (se ignora).
    ['directa 10% con grant', async () => createDirectSale(entrada(await cliente(), JUAN, 10), { ...JUAN, grantedCapabilities: ['sale.createDirect'] } as User)],
  ]
  const res: string[] = []
  for (const [k, fn] of intentos) res.push(`${k}: ${await rechazo(fn)}`)
  const despues = await cuenta()
  for (const r of res) metric('intento', r)
  assert(res.every(r => !r.endsWith('ACEPTADO')), 'un bypass del Cobrador al 10% fue aceptado')
  assert(despues.sales === antes.sales && despues.requests === antes.requests, 'se persistió una venta o solicitud')
})

await spec('TASA-008', 'segundo crédito: la regla no rompe la autorización', async () => {
  await empresa()
  const cli = await cliente()
  await historicoAl10(cli)
  const directa = await rechazo(() => createDirectSale(entrada(cli, JUAN, 20), JUAN))
  const al10 = await rechazo(() => createSaleRequest(entrada(cli, JUAN, 10), JUAN))
  const req = await createSaleRequest(entrada(cli, JUAN, 20), JUAN)
  metric('directa', directa)
  metric('solicitud 10%', al10)
  metric('solicitud 20%', `${req.status} · motivo ${req.authorizationReason} · créditos activos ${req.activeCreditSaleIds?.length}`)
  assert(directa !== 'ACEPTADO' && al10 !== 'ACEPTADO', 'el Cobrador evitó la autorización o la tasa')
  assert(req.authorizationReason === 'active-credit' && req.activeCreditSaleIds?.length === 1, 'la solicitud no quedó marcada como crédito adicional')
  // El autorizador aprueba el crédito adicional y puede fijar el 10%.
  const venta = await approveSaleRequest(req.id, SECRE, { interestRate: 10 })
  metric('aprobada', `${venta.tasaInteres}% · ${venta.disbursementStatus}`)
  assert(venta.tasaInteres === 10 && venta.disbursementStatus === 'pendiente', 'la aprobación del segundo crédito cambió de comportamiento')
})

// ============================================================
// Informe
// ============================================================
const line = (ch = '─') => ch.repeat(96)
console.log('')
console.log(line('═'))
console.log('  RUTACASH — SUITE TASA DE INTERÉS POR ROL (Dexie real)')
console.log(line('═'))
for (const r of results) {
  console.log(`[${r.passed ? ' PASS ' : ' FAIL '}] ${r.id.padEnd(10)} ${r.desc}`)
  for (const m of r.metrics) console.log(`           · ${m}`)
  if (r.error) console.log(`           ↳ ERROR: ${r.error}`)
}
const fallidos = results.filter(r => !r.passed)
console.log('')
console.log(line('═'))
console.log(`  TOTAL: ${results.length} casos   ${results.length - fallidos.length} PASS   ${fallidos.length} FAIL`)
console.log(line('═'))
console.log(fallidos.length ? 'SUITE TASA DE INTERÉS: FALLÓ' : 'SUITE TASA DE INTERÉS: TODOS LOS CASOS PASAN')
process.exit(fallidos.length === 0 ? 0 : 1)
