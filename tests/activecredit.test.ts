// ============================================================
// RUTACASH — SUITE CRÉDITO ACTIVO EN AUTORIZACIONES (DEXIE REAL)
// ------------------------------------------------------------
//   npm run test:activecredit
//
// Ajuste del socio 2026-10-02, punto 2: el Secretario ve, antes de decidir, que el
// cliente tiene crédito(s) activo(s), distinguiendo cómo estaban AL SOLICITAR y
// cómo están AHORA. Servicios de producción sobre el singleton `db`
// (Dexie + fake-indexeddb).
//
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import {
  approveSaleRequest, confirmDisbursement, createDirectSale, createSaleRequest, getActiveCreditContext,
  rejectSaleRequest, type SaleInputs,
} from '../src/services/saleRequestService'
import { registerPayment } from '../src/services/paymentService'
import { buildActiveCreditContext } from '../src/lib/activeCreditContext'
import { CREDIT_STATUS_LABEL } from '../src/lib/creditHistory'
import { today } from '../src/lib/formatters'
import type { Sale, User } from '../src/models/types'
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

async function rechazo(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'ACEPTADO' } catch (e) { return e instanceof Error ? e.message : String(e) }
}

// ============================================================
// Escenario: empresa A (rutas Centro y Otra) y empresa B
// ============================================================
const T = 't-a'
const TB = 't-b'
const R = 'r-centro'
const R2 = 'r-otra'
const RB = 'r-b'
const HOY = today()

const base = (id: string, tenantId: string, rol: User['rol'], rutas: string[]): User => ({
  id, tenantId, nombre: id, email: `${id}@ac.co`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)

const ADMIN = base('u-admin', T, 'admin', [R, R2])
const JUAN = base('u-juan', T, 'cobrador', [R])
const SECRE = base('u-secre', T, 'secretario', [R])
const SECRE_B = base('u-secre-b', TB, 'secretario', [RB])
const ADMIN_B = base('u-admin-b', TB, 'admin', [RB])

async function empresas() {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.bulkAdd([
    { id: T, nombre: 'A', status: 'activa', plan: 'profesional', createdAt: '2026-01-01' },
    { id: TB, nombre: 'B', status: 'activa', plan: 'profesional', createdAt: '2026-01-01' },
  ] as never[])
  await db.offices.bulkAdd([
    { id: 'of-a', tenantId: T, nombre: 'A', codigo: 'A', status: 'activa', createdAt: '', updatedAt: '' },
    { id: 'of-b', tenantId: TB, nombre: 'B', codigo: 'B', status: 'activa', createdAt: '', updatedAt: '' },
  ] as never[])
  const ruta = (id: string, tenantId: string, officeId: string, nombre: string) =>
    ({ id, tenantId, officeId, nombre, codigo: id, status: 'activa', capitalInicial: 0, capitalActual: 0, tasaInteres: 20, createdAt: '2026-09-01' })
  await db.routes.bulkAdd([ruta(R, T, 'of-a', 'Centro'), ruta(R2, T, 'of-a', 'Otra'), ruta(RB, TB, 'of-b', 'B')] as never[])
  await db.users.bulkAdd([ADMIN, JUAN, SECRE, SECRE_B, ADMIN_B])
  await db.capitalMovements.bulkAdd([R, R2, RB].map(r => ({
    id: `cap-${r}`, tenantId: r === RB ? TB : T, routeId: r, tipo: 'ingresoCapital', valor: 50_000_000, fecha: '2026-09-01', createdAt: '',
  })) as never[])
}

let cliSeq = 0
async function cliente(routeId = R, tenantId = T, id = `cli-${++cliSeq}`): Promise<string> {
  await db.clients.add({ id, tenantId, routeId, nombre: `Cliente ${id}`, documento: id, status: 'activo', createdAt: '' } as never)
  return id
}

const entrada = (clientId: string, actor: User, valor: number, extra: Partial<SaleInputs> = {}): SaleInputs => ({
  tenantId: actor.tenantId, routeId: R, clientId, createdByUserId: actor.id, valorVenta: valor, tasaInteres: 20, numeroCuotas: 20,
  frecuenciaPago: 'diaria', fechaInicio: HOY, paymentDays: [0, 1, 2, 3, 4, 5, 6], ...extra,
})

/** Crédito activo y desembolsado, creado por el Admin con el servicio real. */
const creditoActivo = (clientId: string, valor = 1_000_000, routeId = R) =>
  createDirectSale(entrada(clientId, ADMIN, valor, { routeId }), ADMIN)

async function pagar(sale: Sale, valor: number) {
  const res = await registerPayment({ saleId: sale.id, requestedAmount: valor, actor: JUAN, fecha: HOY })
  if (!res.ok) throw new Error(`pago rechazado: ${res.code} — ${res.message}`)
}

const PAGE = 'src/pages/secretario/SecretarioAuthorizationsPage.tsx'
const NOTICE = 'src/components/ui/ActiveCreditNotice.tsx'

// ============================================================
// Casos
// ============================================================
await spec('CREDITO-ACTIVO-SEC-001', 'cliente sin crédito activo → sin aviso', async () => {
  await empresas()
  const req = await createSaleRequest(entrada(await cliente(), JUAN, 500_000), JUAN)
  const ctx = await getActiveCreditContext(req.id, SECRE)
  metric('solicitud', `motivo ${req.authorizationReason} · activos ${req.activeCreditSaleIds?.length} · fotografía ${req.activeCreditSnapshot?.length}`)
  metric('contexto para el Secretario', ctx === null ? 'ninguno' : JSON.stringify(ctx))
  assert(ctx === null, 'una solicitud sin crédito activo produjo aviso')
  // La UI no pinta caja vacía y no arrastra el aviso de la solicitud anterior.
  const page = fs.readFileSync(PAGE, 'utf8')
  const notice = fs.readFileSync(NOTICE, 'utf8')
  const sinCaja = /if \(!context\) return null/.test(notice)
  const limpia = /setClientSales\(\[\]\); setCreditContext\(null\)/.test(page) && /if \(openingId\.current !== req\.id\) return/.test(page)
  metric('sin contexto → nada renderizado', sinCaja)
  metric('estado limpio entre solicitudes', limpia)
  assert(sinCaja && limpia, 'la UI puede mostrar un aviso vacío o residual')
})

await spec('CREDITO-ACTIVO-SEC-002', 'un crédito activo: solicitud marcada y visible al Secretario', async () => {
  await empresas()
  const cli = await cliente()
  const a = await creditoActivo(cli)
  const req = await createSaleRequest(entrada(cli, JUAN, 500_000), JUAN)
  const ctx = await getActiveCreditContext(req.id, SECRE)
  metric('solicitud', `${req.interestRate}% · motivo ${req.authorizationReason} · activos ${JSON.stringify(req.activeCreditSaleIds)}`)
  metric('contexto', `al solicitar ${ctx?.flaggedAtRequest} · activos ahora ${ctx?.activeNowCount}`)
  assert(req.interestRate === 20 && req.authorizationReason === 'active-credit' && req.activeCreditSaleIds?.[0] === a.id, 'la solicitud no quedó marcada')
  assert(ctx && ctx.flaggedAtRequest && ctx.activeNowCount === 1 && ctx.items[0].saleId === a.id && ctx.items[0].activeNow, 'el Secretario no ve el crédito activo')
  const page = fs.readFileSync(PAGE, 'utf8')
  const enDetalle = page.indexOf('<ActiveCreditNotice') > 0 && page.indexOf('<ActiveCreditNotice') < page.indexOf('Condiciones (modificables antes de aprobar)')
  metric('aviso en el detalle, antes de las condiciones', enDetalle)
  assert(enDetalle, 'el aviso no está en el detalle antes de los controles de decisión')
})

await spec('CREDITO-ACTIVO-SEC-003', 'información mínima: crédito, saldo, total, estado, ruta, inicio', async () => {
  await empresas()
  const cli = await cliente()
  const a = await creditoActivo(cli, 1_000_000)
  const req = await createSaleRequest(entrada(cli, JUAN, 500_000), JUAN)
  const it = (await getActiveCreditContext(req.id, SECRE))!.items[0]
  const c = it.current!
  metric('crédito', `${c.id} · cliente ${c.clientId} · ruta ${c.routeId} · desde ${c.fechaInicio}`)
  metric('montos', `venta ${c.valorVenta} · total ${c.valorTotal} · saldo ${c.saldo} · estado ${CREDIT_STATUS_LABEL[c.status]}`)
  metric('fotografía', JSON.stringify(it.snapshot))
  assert(c.id === a.id && c.clientId === cli && c.routeId === R && c.fechaInicio === HOY, 'faltan identificación, ruta o fecha')
  assert(c.valorVenta === 1_000_000 && c.valorTotal === 1_200_000 && c.saldo === 1_200_000 && CREDIT_STATUS_LABEL[c.status] === 'Activo', 'faltan montos o estado')
  assert(it.snapshot?.saldo === 1_200_000 && it.snapshot.status === 'activa' && !it.saldoChanged, 'la fotografía no coincide')
  const notice = fs.readFileSync(NOTICE, 'utf8')
  const muestra = ['current.valorVenta', 'current.routeId', 'current.fechaInicio', 'current.saldo', 'current.valorTotal', 'CREDIT_STATUS_LABEL[current.status]'].every(k => notice.includes(k))
  metric('el aviso muestra los campos', muestra)
  assert(muestra, 'el aviso no muestra la información mínima')
})

await spec('CREDITO-ACTIVO-SEC-004', 'dos créditos activos: ambos identificables', async () => {
  await empresas()
  const cli = await cliente()
  const a = await creditoActivo(cli, 1_000_000)
  const b = await creditoActivo(cli, 300_000)  // el Admin conserva venta directa con crédito activo
  const req = await createSaleRequest(entrada(cli, JUAN, 500_000), JUAN)
  const ctx = (await getActiveCreditContext(req.id, SECRE))!
  metric('fotografiados', JSON.stringify(req.activeCreditSaleIds))
  metric('en el aviso', ctx.items.map(i => `${i.saleId}: saldo ${i.current?.saldo}`).join(' · '))
  const ids = ctx.items.map(i => i.saleId).sort()
  assert(ctx.activeNowCount === 2 && ids.length === 2 && ids.join() === [a.id, b.id].sort().join(), 'se ocultó un crédito activo')
  assert(ctx.items.every(i => i.current && i.atRequest && i.activeNow), 'algún crédito llega sin detalle')
  const notice = fs.readFileSync(NOTICE, 'utf8')
  assert(/context\.items\.map\(/.test(notice) && /créditos activos/.test(notice), 'el aviso no lista todos los créditos')
})

await spec('CREDITO-ACTIVO-SEC-005', 'crédito cancelado tras la solicitud: motivo histórico, estado actual correcto', async () => {
  await empresas()
  const cli = await cliente()
  const a = await creditoActivo(cli, 1_000_000)
  const req = await createSaleRequest(entrada(cli, JUAN, 500_000), JUAN)
  await pagar(a, 1_200_000)
  const venta = (await db.sales.get(a.id))!
  const guardada = (await db.saleRequests.get(req.id))!
  const ctx = (await getActiveCreditContext(req.id, SECRE))!
  const it = ctx.items[0]
  metric('crédito anterior ahora', `${venta.status} · saldo ${venta.saldo}`)
  metric('solicitud conserva', `motivo ${guardada.authorizationReason} · activos ${JSON.stringify(guardada.activeCreditSaleIds)} · foto ${it.snapshot?.status}/${it.snapshot?.saldo}`)
  metric('contexto', `al solicitar ${ctx.flaggedAtRequest} · activos ahora ${ctx.activeNowCount} · estado ${CREDIT_STATUS_LABEL[it.current!.status]}`)
  assert(venta.status === 'finalizada' && venta.saldo === 0, 'el pago no canceló el crédito')
  assert(guardada.authorizationReason === 'active-credit' && guardada.activeCreditSaleIds?.[0] === a.id && it.snapshot?.status === 'activa', 'se perdió el motivo histórico')
  assert(ctx.flaggedAtRequest && ctx.activeNowCount === 0 && !it.activeNow && it.current?.status === 'finalizada', 'se afirma que sigue activo')
  const notice = fs.readFileSync(NOTICE, 'utf8')
  assert(notice.includes("'Solicitada con crédito activo · hoy ya no está activo'"), 'la UI no distingue histórico de actual')
})

await spec('CREDITO-ACTIVO-SEC-006', 'saldo cambia tras la solicitud: actual + valor al solicitar', async () => {
  await empresas()
  const cli = await cliente()
  const a = await creditoActivo(cli, 1_000_000)
  const req = await createSaleRequest(entrada(cli, JUAN, 500_000), JUAN)
  const sinCambio = (await getActiveCreditContext(req.id, SECRE))!.items[0]
  await pagar(a, 200_000)
  const it = (await getActiveCreditContext(req.id, SECRE))!.items[0]
  metric('sin abonos', `saldo ${sinCambio.current?.saldo} · cambió ${sinCambio.saldoChanged}`)
  metric('tras abono 200.000', `al solicitar ${it.snapshot?.saldo} → ahora ${it.current?.saldo} · cambió ${it.saldoChanged} · activo ${it.activeNow}`)
  assert(!sinCambio.saldoChanged, 'se duplica la información sin que haya cambio')
  assert(it.saldoChanged && it.snapshot?.saldo === 1_200_000 && it.current?.saldo === 1_000_000 && it.activeNow, 'no se distingue fotografía de estado actual')
  // Solicitud anterior a la fotografía (solo IDs): estado actual, sin inventar el pasado.
  const legado = buildActiveCreditContext({ ...req, activeCreditSnapshot: undefined }, [(await db.sales.get(a.id))!])!
  metric('solicitud sin fotografía', `saldo ${legado.items[0].current?.saldo} · cambió ${legado.items[0].saldoChanged}`)
  assert(!legado.items[0].snapshot && !legado.items[0].saldoChanged && legado.activeNowCount === 1, 'se inventó un saldo histórico')
})

await spec('CREDITO-ACTIVO-SEC-007', 'aislamiento: empresa y rutas', async () => {
  await empresas()
  const cli = await cliente()
  await creditoActivo(cli)
  const req = await createSaleRequest(entrada(cli, JUAN, 500_000), JUAN)
  // Secretario y Admin de la empresa B: nada, ni siquiera existencia.
  const secreB = await rechazo(() => getActiveCreditContext(req.id, SECRE_B))
  const adminB = await rechazo(() => getActiveCreditContext(req.id, ADMIN_B))
  metric('Secretario empresa B', secreB)
  metric('Admin empresa B', adminB)
  assert(secreB !== 'ACEPTADO' && adminB !== 'ACEPTADO', 'otra empresa leyó el contexto')
  // Una venta de la empresa B con el mismo clientId (dato corrupto) no se mezcla.
  const ajena = { id: 'sale-b', tenantId: TB, clientId: cli, routeId: RB, status: 'activa', saldo: 9_999_999, valorTotal: 9_999_999, valorVenta: 9_999_999, fechaInicio: HOY } as Sale
  const mezcla = buildActiveCreditContext(req, [ajena, ...(await db.sales.toArray())])!
  metric('venta de empresa B con el mismo clientId', mezcla.items.some(i => i.saleId === 'sale-b') ? 'MEZCLADA' : 'excluida')
  assert(!mezcla.items.some(i => i.saleId === 'sale-b'), 'se mezcló información de otra empresa')
  // Crédito en una ruta fuera del alcance del Secretario (cliente movido de ruta).
  const movido = await cliente(R2)
  await creditoActivo(movido, 700_000, R2)
  await db.clients.update(movido, { routeId: R })
  const req2 = await createSaleRequest(entrada(movido, JUAN, 500_000), JUAN)
  const it = (await getActiveCreditContext(req2.id, SECRE))!.items[0]
  metric('crédito en ruta ajena', `restringido ${it.restricted} · activo ${it.activeNow} · detalle ${it.current ? 'VISIBLE' : 'oculto'}`)
  assert(it.restricted && it.activeNow && !it.current, 'se mostró detalle financiero de una ruta sin acceso')
  // El historial del mismo modal aplica el mismo recorte (empresa + rutas).
  const historial = /s\.tenantId === req\.tenantId && can\(user, 'sale\.viewActive', \{ routeId: s\.routeId/.test(fs.readFileSync(PAGE, 'utf8'))
  metric('historial del cliente recortado por empresa y ruta', historial)
  assert(historial, 'el historial del modal muestra créditos fuera del alcance')
})

await spec('CREDITO-ACTIVO-SEC-008', 'aprobación con cambio al 10% (Ronda 1) intacta', async () => {
  await empresas()
  const cli = await cliente()
  await creditoActivo(cli)
  const req = await createSaleRequest(entrada(cli, JUAN, 500_000), JUAN)
  const antes = JSON.stringify(await db.saleRequests.get(req.id))
  await getActiveCreditContext(req.id, SECRE)
  const leida = JSON.stringify(await db.saleRequests.get(req.id))
  const venta = await approveSaleRequest(req.id, SECRE, { interestRate: 10 })
  const res = (await db.saleRequests.get(req.id))!
  metric('consultar el contexto modifica la solicitud', antes !== leida)
  metric('aprobada', `${res.requestedInterestRate}% → ${res.approvedInterestRate}% · venta ${venta.tasaInteres}% · ${venta.disbursementStatus} · total ${venta.valorTotal}`)
  assert(antes === leida, 'la consulta escribió en la solicitud')
  assert(venta.tasaInteres === 10 && venta.valorTotal === 550_000 && venta.disbursementStatus === 'pendiente' && res.status === 'approved', 'la aprobación al 10% cambió')
  const cobrador10 = await rechazo(async () => createSaleRequest(entrada(await cliente(), JUAN, 500_000, { tasaInteres: 10 }), JUAN))
  metric('Cobrador al 10%', cobrador10)
  assert(/20%/.test(cobrador10), 'se perdió la regla de la Ronda 1')
})

await spec('CREDITO-ACTIVO-SEC-009', 'rechazo intacto', async () => {
  await empresas()
  const cli = await cliente()
  await creditoActivo(cli)
  const req = await createSaleRequest(entrada(cli, JUAN, 500_000), JUAN)
  await getActiveCreditContext(req.id, SECRE)
  const ventasAntes = await db.sales.count()
  const sinMotivo = await rechazo(() => rejectSaleRequest(req.id, SECRE, '  '))
  await rejectSaleRequest(req.id, SECRE, 'ya tiene crédito')
  const res = (await db.saleRequests.get(req.id))!
  const segunda = await rechazo(() => rejectSaleRequest(req.id, SECRE, 'otra vez'))
  metric('sin motivo', sinMotivo)
  metric('rechazada', `${res.status} · "${res.rejectionReason}" · motivo ${res.authorizationReason}`)
  metric('segundo rechazo', segunda)
  assert(sinMotivo !== 'ACEPTADO' && res.status === 'rejected' && res.rejectionReason === 'ya tiene crédito', 'el rechazo cambió')
  assert(segunda !== 'ACEPTADO' && (await db.sales.count()) === ventasAntes, 'el rechazo creó o resolvió de nuevo')
})

await spec('CREDITO-ACTIVO-SEC-010', 'regresión segundo crédito: mismo estado financiero tras aprobar', async () => {
  // Mismo flujo dos veces: con y sin consultar el contexto. El resultado debe ser idéntico.
  const flujo = async (consultar: boolean) => {
    await empresas()
    const cli = await cliente(R, T, 'cli-flujo')
    const a = await creditoActivo(cli, 1_000_000)
    const req = await createSaleRequest(entrada(cli, JUAN, 500_000), JUAN)
    if (consultar) await getActiveCreditContext(req.id, SECRE)
    const venta = await approveSaleRequest(req.id, SECRE)
    await confirmDisbursement(venta.id, JUAN)
    const final = (await db.sales.get(venta.id))!
    const anterior = (await db.sales.get(a.id))!
    const parcelas = await db.installments.where('saleId').equals(venta.id).toArray()
    const ctx = consultar ? await getActiveCreditContext(req.id, SECRE) : null
    return {
      nueva: { tasa: final.tasaInteres, total: final.valorTotal, saldo: final.saldo, cuota: final.valorCuota, cuotas: parcelas.length, suma: parcelas.reduce((s, p) => s + p.valor, 0), status: final.status, desembolso: final.disbursementStatus },
      anterior: { saldo: anterior.saldo, status: anterior.status },
      solicitud: (await db.saleRequests.get(req.id))!.status,
      contextoIncluyeNueva: !!ctx?.items.some(i => i.saleId === venta.id),
    }
  }
  const sin = await flujo(false)
  const con = await flujo(true)
  metric('sin consultar', JSON.stringify(sin))
  metric('consultando', JSON.stringify(con))
  assert(JSON.stringify({ ...sin, contextoIncluyeNueva: false }) === JSON.stringify({ ...con, contextoIncluyeNueva: false }), 'mostrar el contexto cambió el resultado financiero')
  assert(con.nueva.total === 600_000 && con.nueva.saldo === 600_000 && con.nueva.suma === 600_000 && con.nueva.desembolso === 'desembolsado' && con.solicitud === 'disbursed', 'el segundo crédito no quedó como antes')
  assert(con.anterior.saldo === 1_200_000 && con.anterior.status === 'activa', 'el crédito anterior cambió')
  assert(!con.contextoIncluyeNueva, 'la venta nacida de la solicitud aparece como crédito previo')
})

// ============================================================
// Informe
// ============================================================
const line = (ch = '─') => ch.repeat(96)
console.log('')
console.log(line('═'))
console.log('  RUTACASH — SUITE CRÉDITO ACTIVO EN AUTORIZACIONES (Dexie real)')
console.log(line('═'))
for (const r of results) {
  console.log(`[${r.passed ? ' PASS ' : ' FAIL '}] ${r.id.padEnd(24)} ${r.desc}`)
  for (const m of r.metrics) console.log(`           · ${m}`)
  if (r.error) console.log(`           ↳ ERROR: ${r.error}`)
}
const fallidos = results.filter(r => !r.passed)
console.log('')
console.log(line('═'))
console.log(`  TOTAL: ${results.length} casos   ${results.length - fallidos.length} PASS   ${fallidos.length} FAIL`)
console.log(line('═'))
console.log(fallidos.length ? 'SUITE CRÉDITO ACTIVO: FALLÓ' : 'SUITE CRÉDITO ACTIVO: TODOS LOS CASOS PASAN')
process.exit(fallidos.length === 0 ? 0 : 1)
