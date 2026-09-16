// ============================================================
// RUTACASH — SUITE DE MIGRACIONES (DEXIE REAL, NO SIMULADO)
// ------------------------------------------------------------
//   npm run test:migrations
//
// Las demás suites usan `MemoryDb`, que replica la superficie de Dexie pero NO es
// Dexie. Esta suite ejecuta el MOTOR REAL sobre `fake-indexeddb`, porque hay dos
// cosas que solo Dexie puede responder:
//
//   1. ¿Se puede RECREAR la tabla `offices` que la v3 borró (`offices: null`)?
//      Es la pregunta que la auditoría dejó explícitamente sin responder. Aquí se
//      migra una base v1 COMPLETA hasta v11, pasando por ese borrado.
//   2. ¿La migración v11 sanea de verdad el `officeId` legado?
//
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import type { User } from '../src/models/types'

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

const DB_NAME = 'RutaCashDB'

/**
 * Esquema EXACTO de la v1 (copiado de db.ts), incluida la tabla `offices` que
 * existía entonces. Sirve para fabricar una base "antigua" real.
 */
const V1_STORES = {
  tenants: 'id, status, plan',
  offices: 'id, tenantId, status',
  routes: 'id, tenantId, officeId, cobradorId, status',
  users: 'id, tenantId, officeId, routeId, email, rol, status',
  clients: 'id, tenantId, officeId, routeId, documento, status',
  sales: 'id, tenantId, officeId, routeId, clientId, status, createdAt',
  installments: 'id, saleId, numero, status',
  payments: 'id, tenantId, saleId, clientId, routeId, collectorId, syncStatus, createdAt',
  noPaymentVisits: 'id, tenantId, saleId, clientId, routeId, collectorId, syncStatus',
  expenseCategories: 'id, tenantId, activa',
  expenses: 'id, tenantId, officeId, routeId, categoryId, userId, syncStatus',
  capitalMovements: 'id, tenantId, officeId, routeId, tipo',
  transfers: 'id, tenantId, officeId, routeOrigenId, routeDestinoId',
  withdrawals: 'id, tenantId, officeId, routeId',
  cashboxMovements: 'id, tenantId, routeId, tipo, fecha',
  weeklySettlements: 'id, tenantId, officeId, routeId, semanaInicio',
  auditLogs: 'id, tenantId, userId, action, entityType, entityId, createdAt',
}

const OFICINA_VIEJA = 'office-001'
const OFICINA_FANTASMA = 'office-002'   // nunca existió como registro

/** Fabrica una base v1 REAL con datos que llevan `officeId` por todas partes. */
async function crearBaseV1(): Promise<void> {
  await Dexie.delete(DB_NAME)
  const vieja = new Dexie(DB_NAME)
  vieja.version(1).stores(V1_STORES)
  await vieja.open()

  await vieja.table('tenants').add({ id: 't-1', nombre: 'Caribe', status: 'activa', plan: 'profesional' })
  await vieja.table('offices').add({ id: OFICINA_VIEJA, tenantId: 't-1', nombre: 'Oficina Vieja', status: 'activa' })

  // Una ruta apunta a una Oficina que SÍ existía; otra a una que nunca existió.
  await vieja.table('routes').bulkAdd([
    { id: 'r-1', tenantId: 't-1', officeId: OFICINA_VIEJA, nombre: 'Ruta Norte', codigo: 'RN-001', status: 'activa' },
    { id: 'r-2', tenantId: 't-1', officeId: OFICINA_FANTASMA, nombre: 'Ruta Sur', codigo: 'RS-001', status: 'activa' },
    { id: 'r-3', tenantId: 't-1', nombre: 'Ruta Sin Oficina', codigo: 'SO-001', status: 'activa' },
  ])

  // `officeId` legado sembrado en TODAS las entidades que lo tenían.
  await vieja.table('users').add({
    id: 'u-1', tenantId: 't-1', officeId: OFICINA_VIEJA, routeId: 'r-1', email: 'a@c.com',
    nombre: 'Ana', rol: 'admin', status: 'activo', authorizedRouteIds: ['r-1'],
  })
  await vieja.table('clients').add({ id: 'c-1', tenantId: 't-1', officeId: OFICINA_VIEJA, routeId: 'r-1', nombre: 'Cliente', documento: '1', status: 'activo' })
  await vieja.table('sales').add({ id: 's-1', tenantId: 't-1', officeId: OFICINA_VIEJA, routeId: 'r-1', clientId: 'c-1', status: 'activa', saldo: 1000, valorVenta: 1000, createdAt: '2026-01-01' })
  await vieja.table('installments').add({ id: 'i-1', saleId: 's-1', numero: 1, status: 'pendiente', valor: 1000, pagado: 0, saldo: 1000 })
  await vieja.table('payments').add({ id: 'p-1', tenantId: 't-1', saleId: 's-1', clientId: 'c-1', routeId: 'r-1', collectorId: 'u-1', valor: 500, fecha: '2026-01-02', syncStatus: 'synced', createdAt: '2026-01-02' })
  await vieja.table('expenses').add({ id: 'e-1', tenantId: 't-1', officeId: OFICINA_VIEJA, routeId: 'r-1', categoryId: 'cat-1', userId: 'u-1', valor: 100, fecha: '2026-01-02', syncStatus: 'synced' })
  await vieja.table('capitalMovements').add({ id: 'cm-1', tenantId: 't-1', officeId: OFICINA_VIEJA, routeId: 'r-1', tipo: 'ingresoCapital', valor: 5000, fecha: '2026-01-01' })
  await vieja.table('transfers').add({ id: 'tr-1', tenantId: 't-1', officeId: OFICINA_VIEJA, routeOrigenId: 'r-1', routeDestinoId: 'r-2', valor: 200, fecha: '2026-01-03' })
  await vieja.table('withdrawals').add({ id: 'w-1', tenantId: 't-1', officeId: OFICINA_VIEJA, routeId: 'r-1', valor: 300, fecha: '2026-01-03' })
  await vieja.table('weeklySettlements').add({ id: 'ws-1', tenantId: 't-1', officeId: OFICINA_VIEJA, routeId: 'r-1', semanaInicio: '2026-01-01', semanaFin: '2026-01-07' })

  vieja.close()
}

/** Abre la base con el esquema ACTUAL de producción (dispara v2 → v11). */
async function abrirActual() {
  // Import diferido: instanciar `RutaCashDB` antes de fabricar la base v1 no abriría
  // nada (Dexie es perezoso), pero cargarlo aquí deja el orden explícito.
  const { RutaCashDB } = await import('../src/lib/db')
  const actual = new RutaCashDB()
  await actual.open()
  return actual
}

// ############################################################
// GRUPO — RECREACIÓN DE LA TABLA `offices` (borrada en la v3)
// ############################################################

await spec('OFFICE-MIG-001', 'Migración', 'v11 recrea la tabla offices que la v3 había borrado', async () => {
  await crearBaseV1()
  const actual = await abrirActual()

  metric('versión alcanzada', actual.verno)
  metric('tabla offices presente', actual.tables.some(t => t.name === 'offices'))

  // La prueba de fuego: la tabla se puede USAR, no solo declarar.
  await actual.offices.add({
    id: 'of-nueva', tenantId: 't-1', nombre: 'Oficina Nueva', status: 'activa',
    createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
  })
  const leida = await actual.offices.get('of-nueva')
  const porTenant = await actual.offices.where('tenantId').equals('t-1').toArray()
  metric('escritura/lectura', leida?.nombre)
  metric('índice tenantId operativo', porTenant.length)

  assert(actual.verno === 11, `la base debía quedar en v11, quedó en v${actual.verno}`)
  assert(actual.tables.some(t => t.name === 'offices'), 'la tabla offices no se recreó')
  assert(leida?.nombre === 'Oficina Nueva', 'no se puede escribir/leer en la tabla recreada')
  assert(porTenant.length === 1, 'el índice tenantId de offices no funciona')
  actual.close()
})

await spec('OFFICE-MIG-002', 'Migración', 'las Oficinas de la v1 NO resucitan: la tabla llega vacía', async () => {
  await crearBaseV1()
  const actual = await abrirActual()
  const offices = await actual.offices.toArray()
  metric('oficinas tras migrar', offices.length)
  metric('la Oficina de la v1 sigue borrada', !offices.some(o => o.id === OFICINA_VIEJA))
  assert(offices.length === 0, 'la migración resucitó Oficinas: la v3 las borró y no deben volver')
  actual.close()
})

await spec('OFFICE-MIG-003', 'Migración', 'toda ruta con officeId colgante queda "Sin Oficina"', async () => {
  await crearBaseV1()
  const actual = await abrirActual()
  const rutas = await actual.routes.toArray()
  const conOficina = rutas.filter(r => r.officeId !== undefined)
  metric('rutas migradas', rutas.length)
  metric('rutas con officeId', conOficina.length)
  metric('detalle', rutas.map(r => `${r.id}:${r.officeId ?? 'Sin Oficina'}`).join(', '))
  assert(rutas.length === 3, 'no debe perderse ninguna ruta')
  assert(conOficina.length === 0, 'quedaron rutas apuntando a Oficinas inexistentes')
  assert(rutas.every(r => r.nombre && r.codigo), 'la migración dañó datos de la ruta')
  actual.close()
})

await spec('OFFICE-MIG-004', 'Migración', 'se elimina officeId legado de las 8 entidades que lo tenían', async () => {
  await crearBaseV1()
  const actual = await abrirActual()

  const tablas = ['users', 'clients', 'sales', 'expenses', 'capitalMovements', 'transfers', 'withdrawals', 'weeklySettlements'] as const
  const sucias: string[] = []
  for (const t of tablas) {
    const filas = await actual.table(t).toArray() as Record<string, unknown>[]
    const conOffice = filas.filter(f => 'officeId' in f)
    metric(t, conOffice.length === 0 ? 'limpia' : `${conOffice.length} con officeId`)
    if (conOffice.length > 0) sucias.push(t)
  }
  assert(sucias.length === 0, `quedó officeId legado en: ${sucias.join(', ')}`)
  actual.close()
})

await spec('OFFICE-MIG-005', 'Migración', 'el saneamiento no borra registros ni toca importes', async () => {
  await crearBaseV1()
  const actual = await abrirActual()

  const conteos = {
    tenants: await actual.tenants.count(), routes: await actual.routes.count(),
    users: await actual.users.count(), clients: await actual.clients.count(),
    sales: await actual.sales.count(), installments: await actual.installments.count(),
    payments: await actual.payments.count(), expenses: await actual.expenses.count(),
    capitalMovements: await actual.capitalMovements.count(), transfers: await actual.transfers.count(),
    withdrawals: await actual.withdrawals.count(), weeklySettlements: await actual.weeklySettlements.count(),
  }
  metric('conteos', JSON.stringify(conteos))
  assert(Object.values(conteos).every(n => n === 1 || n === 3), `se perdieron registros: ${JSON.stringify(conteos)}`)

  const venta = await actual.sales.get('s-1')
  const pago = await actual.payments.get('p-1')
  const gasto = await actual.expenses.get('e-1')
  metric('venta saldo/routeId', `${venta?.saldo} / ${venta?.routeId}`)
  metric('pago valor/routeId', `${pago?.valor} / ${pago?.routeId}`)
  metric('gasto valor', gasto?.valor)
  assert(venta?.saldo === 1000 && venta?.routeId === 'r-1', 'la venta cambió de importe o de ruta')
  assert(pago?.valor === 500 && pago?.routeId === 'r-1', 'el pago cambió de importe o de ruta')
  assert(gasto?.valor === 100, 'el gasto cambió de importe')
  actual.close()
})

await spec('OFFICE-MIG-006', 'Migración', 'las asignaciones de usuarios sobreviven intactas', async () => {
  await crearBaseV1()
  const actual = await abrirActual()
  const ana = await actual.users.get('u-1')
  metric('authorizedRouteIds', JSON.stringify(ana?.authorizedRouteIds))
  metric('officeId eliminado', !(ana && 'officeId' in ana))
  assert(ana?.authorizedRouteIds?.includes('r-1') === true, 'la migración perdió la asignación de rutas')
  assert(!(ana && 'officeId' in ana), 'User conserva officeId: los usuarios NO pertenecen a una Oficina')
  actual.close()
})

await spec('OFFICE-MIG-007', 'Migración', 'una instalación NUEVA nace directamente en v11 con offices vacía', async () => {
  await Dexie.delete(DB_NAME)
  const actual = await abrirActual()
  metric('versión', actual.verno)
  metric('oficinas', await actual.offices.count())
  metric('rutas', await actual.routes.count())
  assert(actual.verno === 11, 'una base nueva debe abrir en v11')
  assert((await actual.offices.count()) === 0, 'una instalación nueva no debe traer Oficinas')
  assert((await actual.routes.count()) === 0, 'una instalación nueva no debe traer rutas')
  actual.close()
})

await spec('OFFICE-MIG-008', 'Migración', 'reabrir una base ya migrada es idempotente', async () => {
  await crearBaseV1()
  const primera = await abrirActual()
  await primera.offices.add({
    id: 'of-x', tenantId: 't-1', nombre: 'Persistente', status: 'activa',
    createdAt: '', updatedAt: '',
  })
  await primera.routes.update('r-1', { officeId: 'of-x' })
  primera.close()

  const segunda = await abrirActual()
  const ruta = await segunda.routes.get('r-1')
  metric('oficinas tras reabrir', await segunda.offices.count())
  metric('r-1.officeId', ruta?.officeId)
  assert((await segunda.offices.count()) === 1, 'reabrir perdió la Oficina')
  assert(ruta?.officeId === 'of-x', 'reabrir limpió una Oficina VÁLIDA (el saneamiento no es idempotente)')
  segunda.close()
})


// ############################################################
// GRUPO — SMOKE: RECORRIDOS COMPLETOS SOBRE DEXIE REAL
// ------------------------------------------------------------
// No son pruebas unitarias: son los recorridos que haría una persona, ejecutados
// de extremo a extremo con la base REAL (fake-indexeddb) y los SERVICIOS REALES.
// Si alguno de estos cae, la funcionalidad no sirve por muy verdes que estén las
// pruebas unitarias.
// ############################################################
const SU: User = {
  id: 'u-su', tenantId: 'platform', nombre: 'Root', email: 'root@c.com', password: 'x',
  rol: 'superadmin', status: 'activo', createdAt: '', updatedAt: '',
}

/** Base limpia, abierta en v11, con una empresa y un cobrador. */
async function baseLimpia() {
  await Dexie.delete(DB_NAME)
  const { db } = await import('../src/lib/db')
  if (db.isOpen()) db.close()
  await db.open()
  await db.tenants.add({
    id: 't-1', nombre: 'Caribe', email: 'c@c.com', plan: 'profesional', status: 'activa',
    pais: 'Colombia', moneda: 'COP', createdAt: '', updatedAt: '',
  })
  return db
}

const datosRutaSmoke = (over: Record<string, unknown> = {}) => ({
  tenantId: 't-1', nombre: 'Ruta Centro', ciudad: 'Leticia', tasaInteres: 20,
  tasaLibre: false, montoMaximoPrestamo: 500_000, capitalInicial: 0,
  codigo: 'RT-001', adminIds: [] as string[], ...over,
})

/** Crea cliente + venta desembolsada con parcelas sobre una ruta. */
async function ventaLista(db: Awaited<ReturnType<typeof baseLimpia>>, routeId: string, clientId: string, saleId: string) {
  const { calculateTotalWithInterest, generateInstallments } = await import('../src/services/installmentEngine')
  await db.clients.add({
    id: clientId, tenantId: 't-1', routeId, nombre: 'Cliente Smoke', documento: clientId,
    telefonoPrincipal: '300', direccionPrincipal: 'x', status: 'activo', createdAt: '', updatedAt: '',
  } as never)
  const { valorInteres, valorTotal } = calculateTotalWithInterest({ valorVenta: 100_000, tasaInteres: 20 })
  const valorCuota = Math.round(valorTotal / 10)
  await db.sales.add({
    id: saleId, tenantId: 't-1', routeId, clientId, createdByUserId: 'u-cob',
    valorVenta: 100_000, tasaInteres: 20, valorInteres, valorTotal, saldo: valorTotal,
    numeroCuotas: 10, valorCuota, frecuenciaPago: 'diaria', fechaInicio: '2026-09-15',
    fechaFinalEstimada: '2026-12-31', status: 'activa', disbursementStatus: 'desembolsado',
    createdAt: '', updatedAt: '',
  } as never)
  for (const p of generateInstallments({
    saleId, valorTotal, numeroCuotas: 10, valorCuota, frecuencia: 'diaria', fechaInicio: '2026-09-15',
  })) await db.installments.add(p)
  return valorTotal
}

await spec('SMOKE-1', 'Smoke', 'CLEAN completo SIN ninguna Oficina: ruta → usuario → cliente → venta → pago', async () => {
  const db = await baseLimpia()
  const { createRouteWithAdmins } = await import('../src/services/routeService')
  const { registerPayment } = await import('../src/services/paymentService')

  const ruta = await createRouteWithAdmins(datosRutaSmoke(), SU)
  await db.users.add({
    id: 'u-cob', tenantId: 't-1', nombre: 'Luis', email: 'luis@c.com', password: 'x',
    rol: 'cobrador', status: 'activo', authorizedRouteIds: [ruta.id], createdAt: '', updatedAt: '',
  } as never)
  const cob = (await db.users.get('u-cob'))!
  const total = await ventaLista(db, ruta.id, 'c-1', 's-1')

  const pago = await registerPayment({ saleId: 's-1', requestedAmount: 4_000, actor: cob, fecha: '2026-09-15' })
  const venta = await db.sales.get('s-1')

  metric('oficinas creadas', await db.offices.count())
  metric('ruta sin Oficina', ruta.officeId === undefined)
  metric('pago', pago.ok ? `ACEPTADO ${pago.appliedAmount}` : `${pago.code}: ${pago.message}`)
  metric('saldo', `${total} → ${venta?.saldo}`)
  assert((await db.offices.count()) === 0, 'el recorrido no debe exigir ninguna Oficina')
  assert(pago.ok, `el pago debe registrarse: ${pago.ok ? '' : pago.message}`)
  assert(venta?.saldo === total - 4_000, 'el saldo no se actualizó')
  db.close()
})

await spec('SMOKE-2', 'Smoke', 'Oficina normal: crear Oficina → ruta → usuario → venta → pago → reporte', async () => {
  const db = await baseLimpia()
  const { createOffice } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')
  const { registerPayment } = await import('../src/services/paymentService')
  const { buildReport, resolveReportRouteIds } = await import('../src/services/reportService')
  const { narrowRouteIdsByOffice } = await import('../src/lib/officeGrouping')

  const office = await createOffice({ tenantId: 't-1', nombre: 'Oficina Leticia', codigo: 'LET' }, SU)
  const ruta = await createRouteWithAdmins(datosRutaSmoke({ officeId: office.id }), SU)
  await db.users.add({
    id: 'u-cob', tenantId: 't-1', nombre: 'Luis', email: 'luis@c.com', password: 'x',
    rol: 'cobrador', status: 'activo', authorizedRouteIds: [ruta.id], createdAt: '', updatedAt: '',
  } as never)
  const cob = (await db.users.get('u-cob'))!
  await ventaLista(db, ruta.id, 'c-1', 's-1')
  const pago = await registerPayment({ saleId: 's-1', requestedAmount: 6_000, actor: cob, fecha: '2026-09-15' })

  // Reporte filtrado por la Oficina, con el orden real: alcance → Oficina → ruta.
  const rutas = await db.routes.toArray()
  const alcance = new Set([ruta.id])
  const ids = resolveReportRouteIds(narrowRouteIdsByOffice(alcance, rutas, office.id), '')
  const filas = buildReport('pagos', {
    payments: await db.payments.toArray(), sales: await db.sales.toArray(),
    expenses: [], clients: await db.clients.toArray(), routes: rutas, categories: [],
  }, { routeIds: ids, fechaDesde: '2026-09-01', fechaHasta: '2026-09-30' })

  metric('ruta en la Oficina', ruta.officeId === office.id)
  metric('pago', pago.ok ? `ACEPTADO ${pago.appliedAmount}` : pago.code)
  metric('filas del reporte de Leticia', filas.length)
  assert(ruta.officeId === office.id, 'la ruta debía quedar en la Oficina')
  assert(pago.ok, 'el pago debe registrarse en una Oficina activa')
  assert(filas.length === 1, 'el reporte de la Oficina debe recoger el pago de su ruta')
  db.close()
})

await spec('SMOKE-3', 'Smoke', 'usuario con rutas en DOS Oficinas ve solo las suyas', async () => {
  const db = await baseLimpia()
  const { createOffice } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')
  const { filterAccessibleRoutes, canAccessRoute } = await import('../src/lib/permissions')
  const { accessibleOfficeIdsOf } = await import('../src/lib/officeGrouping')

  const leticia = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, SU)
  const rio = await createOffice({ tenantId: 't-1', nombre: 'Río' }, SU)
  const rL1 = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Centro', codigo: 'RT-001' }), SU)
  const rL2 = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Norte', codigo: 'RT-002' }), SU)
  const rR1 = await createRouteWithAdmins(datosRutaSmoke({ officeId: rio.id, nombre: 'Puerto', codigo: 'RT-003' }), SU)
  const rR2 = await createRouteWithAdmins(datosRutaSmoke({ officeId: rio.id, nombre: 'Mercado', codigo: 'RT-004' }), SU)

  await db.users.add({
    id: 'u-fabio', tenantId: 't-1', nombre: 'Fabio', email: 'fabio@c.com', password: 'x',
    rol: 'cobrador', status: 'activo', authorizedRouteIds: [rL1.id, rR1.id], createdAt: '', updatedAt: '',
  } as never)
  const fabio = (await db.users.get('u-fabio'))!
  const todas = await db.routes.toArray()
  const suyas = filterAccessibleRoutes(fabio, todas)
  const oficinas = accessibleOfficeIdsOf(suyas)

  metric('rutas de la empresa', todas.length)
  metric('rutas visibles', suyas.map(r => r.nombre).join(', '))
  metric('oficinas visibles', oficinas.size)
  assert(suyas.length === 2, 'debe ver exactamente sus dos rutas')
  assert(oficinas.size === 2, 'debe ver sus dos Oficinas')
  assert(!canAccessRoute(fabio, rL2.id) && !canAccessRoute(fabio, rR2.id),
    'tener una ruta de una Oficina NO concede las demás rutas de esa Oficina')
  db.close()
})

await spec('SMOKE-4', 'Smoke', 'mover una ruta de Oficina no altera clientes, ventas ni pagos', async () => {
  const db = await baseLimpia()
  const { createOffice, moveRouteToOffice } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')
  const { registerPayment } = await import('../src/services/paymentService')

  const leticia = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, SU)
  const rio = await createOffice({ tenantId: 't-1', nombre: 'Río' }, SU)
  const ruta = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id }), SU)
  await db.users.add({
    id: 'u-cob', tenantId: 't-1', nombre: 'Luis', email: 'luis@c.com', password: 'x',
    rol: 'cobrador', status: 'activo', authorizedRouteIds: [ruta.id], createdAt: '', updatedAt: '',
  } as never)
  const cob = (await db.users.get('u-cob'))!
  await ventaLista(db, ruta.id, 'c-1', 's-1')
  await registerPayment({ saleId: 's-1', requestedAmount: 7_000, actor: cob, fecha: '2026-09-15' })

  const antes = JSON.stringify([
    await db.clients.toArray(), await db.sales.toArray(),
    await db.installments.toArray(), await db.payments.toArray(), await db.users.toArray(),
  ])
  await moveRouteToOffice({ routeId: ruta.id, tenantId: 't-1', officeId: rio.id }, SU)
  const despues = JSON.stringify([
    await db.clients.toArray(), await db.sales.toArray(),
    await db.installments.toArray(), await db.payments.toArray(), await db.users.toArray(),
  ])

  const movida = await db.routes.get(ruta.id)
  metric('Oficina destino', movida?.officeId === rio.id)
  metric('clientes/ventas/pagos/usuarios idénticos', antes === despues)
  assert(movida?.officeId === rio.id, 'la ruta no se movió')
  assert(antes === despues, 'mover la Oficina modificó datos que dependen de la RUTA')
  db.close()
})

await spec('SMOKE-5', 'Smoke', 'Oficina inactiva: lectura intacta, operaciones nuevas bloqueadas, reactivar restablece', async () => {
  const db = await baseLimpia()
  const { createOffice, setOfficeStatus } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')
  const { registerPayment } = await import('../src/services/paymentService')
  const { createDirectSale } = await import('../src/services/saleRequestService')

  const office = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, SU)
  const ruta = await createRouteWithAdmins(datosRutaSmoke({ officeId: office.id }), SU)
  await db.users.add({
    id: 'u-cob', tenantId: 't-1', nombre: 'Luis', email: 'luis@c.com', password: 'x',
    rol: 'cobrador', status: 'activo', authorizedRouteIds: [ruta.id], createdAt: '', updatedAt: '',
  } as never)
  const cob = (await db.users.get('u-cob'))!
  await ventaLista(db, ruta.id, 'c-1', 's-1')
  await registerPayment({ saleId: 's-1', requestedAmount: 3_000, actor: cob, fecha: '2026-09-15' })

  await setOfficeStatus({ officeId: office.id, tenantId: 't-1', status: 'inactiva' }, SU)

  // LECTURA: todo sigue disponible.
  const clientes = await db.clients.count()
  const ventas = await db.sales.count()
  const pagosPrevios = await db.payments.count()

  // ESCRITURA: bloqueada, con motivo comprensible.
  const pagoBloqueado = await registerPayment({ saleId: 's-1', requestedAmount: 3_000, actor: cob, fecha: '2026-09-15' })
  let ventaBloqueada = ''
  try {
    await createDirectSale({
      tenantId: 't-1', routeId: ruta.id, clientId: 'c-1', createdByUserId: cob.id,
      valorVenta: 50_000, tasaInteres: 20, numeroCuotas: 5, frecuenciaPago: 'diaria',
      fechaInicio: '2026-09-15',
    } as never, cob)
  } catch (e) { ventaBloqueada = e instanceof Error ? e.message : String(e) }

  metric('clientes/ventas/pagos legibles', `${clientes}/${ventas}/${pagosPrevios}`)
  metric('pago nuevo', pagoBloqueado.ok ? 'ACEPTADO — ERROR' : `${pagoBloqueado.code}`)
  metric('venta nueva', ventaBloqueada || 'ACEPTADA — ERROR')
  assert(clientes === 1 && ventas === 1 && pagosPrevios === 1, 'la consulta histórica debe seguir intacta')
  assert(!pagoBloqueado.ok && pagoBloqueado.code === 'OFFICE_INACTIVE', 'el pago nuevo debía bloquearse')
  assert(ventaBloqueada.includes('Oficina inactiva'), 'la venta nueva debía bloquearse con un motivo claro')
  assert((await db.payments.count()) === 1, 'el intento bloqueado no debe dejar escrituras')

  // REACTIVAR: la operación vuelve sin tocar asignaciones.
  await setOfficeStatus({ officeId: office.id, tenantId: 't-1', status: 'activa' }, SU)
  const pagoTrasReactivar = await registerPayment({ saleId: 's-1', requestedAmount: 3_000, actor: cob, fecha: '2026-09-15' })
  const cobFinal = (await db.users.get('u-cob'))!
  metric('pago tras reactivar', pagoTrasReactivar.ok ? 'ACEPTADO' : pagoTrasReactivar.code)
  metric('asignaciones intactas', JSON.stringify(cobFinal.authorizedRouteIds))
  assert(pagoTrasReactivar.ok, 'reactivar debe restablecer la operación')
  assert(cobFinal.authorizedRouteIds?.includes(ruta.id) === true, 'reactivar no debe reasignar a nadie')
  db.close()
})


// ############################################################
// GRUPO — SMOKE DE GESTIÓN DE OFICINA (Dexie real)
// ------------------------------------------------------------
// Los recorridos de la Entrega 1, ejecutados de punta a punta con la base y los
// servicios reales. El más delicado es el B: editar asignaciones desde una Oficina
// no puede hacerle perder al usuario sus rutas de otra.
// ############################################################

await spec('SMOKE-A', 'Smoke gestión', 'Admin con acceso PARCIAL: ve 2 de 3 rutas y sus indicadores lo reflejan', async () => {
  const db = await baseLimpia()
  const { createOffice, getOfficeManagementSummary } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')

  const leticia = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, SU)
  const centro = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Centro', codigo: 'RT-001' }), SU)
  const norte = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Norte', codigo: 'RT-002' }), SU)
  const mercado = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Mercado', codigo: 'RT-003' }), SU)

  await db.users.add({
    id: 'u-adm', tenantId: 't-1', nombre: 'Ana', email: 'ana@c.com', password: 'x',
    rol: 'admin', status: 'activo', authorizedRouteIds: [centro.id, mercado.id], createdAt: '', updatedAt: '',
  } as never)
  const admin = (await db.users.get('u-adm'))!

  // Datos SOLO en la ruta que el Admin no ve: no pueden aparecer en sus cifras.
  await ventaLista(db, norte.id, 'c-norte', 's-norte')

  const resumen = await getOfficeManagementSummary({ user: admin, tenantId: 't-1', officeId: leticia.id })
  const nombres = resumen!.accessibleOfficeRoutes.map(r => r.nombre).sort()

  metric('rutas visibles', nombres.join(', '))
  metric('alcance', resumen!.scope.label)
  metric('clientes en indicadores', resumen!.kpis.clientesActivos)
  metric('alertas mencionan Norte', resumen!.alerts.some(a => a.mensaje.includes('Norte')))
  assert(nombres.length === 2 && nombres[0] === 'Centro' && nombres[1] === 'Mercado', 'debe ver Centro y Mercado')
  assert(!nombres.includes('Norte'), 'NO debe ver Norte')
  assert(resumen!.scope.label === '2 de 3 rutas visibles — rutas autorizadas', 'el alcance parcial debe rotularse')
  assert(resumen!.kpis.clientesActivos === 0, 'un cliente de una ruta no autorizada se coló en los indicadores')
  assert(!resumen!.alerts.some(a => a.mensaje.includes('Norte')), 'una alerta reveló una ruta no autorizada')
  db.close()
})

await spec('SMOKE-B', 'Smoke gestión', 'usuario multi-Oficina: editar desde Leticia NO le quita su ruta de Río', async () => {
  const db = await baseLimpia()
  const { createOffice, getOfficeManagementSummary, setUserOfficeRoutes } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')

  const leticia = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, SU)
  const rio = await createOffice({ tenantId: 't-1', nombre: 'Río' }, SU)
  const centro = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Centro', codigo: 'RT-001' }), SU)
  const norte = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Norte', codigo: 'RT-002' }), SU)
  const puerto = await createRouteWithAdmins(datosRutaSmoke({ officeId: rio.id, nombre: 'Puerto', codigo: 'RT-003' }), SU)

  await db.users.add({
    id: 'u-fabio', tenantId: 't-1', nombre: 'Fabio', email: 'fabio@c.com', password: 'x',
    rol: 'cobrador', status: 'activo', authorizedRouteIds: [centro.id, puerto.id], createdAt: '', updatedAt: '',
  } as never)

  // 1) Entrar a Leticia: Fabio aparece, y SOLO con su ruta de Leticia.
  const enLeticia = await getOfficeManagementSummary({ user: SU, tenantId: 't-1', officeId: leticia.id })
  const fabioEnLeticia = enLeticia!.relatedUsers.find(u => u.id === 'u-fabio')
  metric('Fabio aparece en Leticia', !!fabioEnLeticia)
  metric('sus rutas mostradas aquí', fabioEnLeticia?.routes.map(r => r.nombre).join(', '))
  assert(!!fabioEnLeticia, 'Fabio debe aparecer relacionado con Leticia')
  assert(fabioEnLeticia!.routes.length === 1 && fabioEnLeticia!.routes[0].nombre === 'Centro',
    'aquí solo deben verse sus rutas de Leticia')

  // 2) Desde Leticia se le AGREGA Norte (se marcan Centro y Norte).
  const { authorizedRouteIds } = await setUserOfficeRoutes({
    userId: 'u-fabio', tenantId: 't-1',
    officeRouteIds: [centro.id, norte.id],
    selectedRouteIds: [centro.id, norte.id],
  }, SU)

  const fabio = (await db.users.get('u-fabio'))!
  const finales = fabio.authorizedRouteIds ?? []
  metric('rutas resultantes', finales.length)
  metric('conserva Puerto (Río)', finales.includes(puerto.id))
  assert(finales.length === 3, `debían quedar 3 rutas, quedaron ${finales.length}`)
  assert(finales.includes(centro.id) && finales.includes(norte.id), 'faltan las rutas de Leticia')
  assert(finales.includes(puerto.id), 'SE PERDIÓ la ruta de Río al editar desde Leticia')
  assert(authorizedRouteIds.includes(puerto.id), 'el servicio debe devolver también las rutas de otras Oficinas')

  // 3) Y al quitarle TODO en Leticia, sigue conservando Río.
  await setUserOfficeRoutes({
    userId: 'u-fabio', tenantId: 't-1',
    officeRouteIds: [centro.id, norte.id], selectedRouteIds: [],
  }, SU)
  const trasVaciar = (await db.users.get('u-fabio'))!
  metric('tras vaciar Leticia', JSON.stringify(trasVaciar.authorizedRouteIds))
  assert((trasVaciar.authorizedRouteIds ?? []).length === 1, 'solo debía quedar la ruta de Río')
  assert((trasVaciar.authorizedRouteIds ?? [])[0] === puerto.id, 'la ruta conservada debe ser Puerto')

  // Y deja de aparecer relacionado con Leticia, sin dejar de existir.
  const leticiaFinal = await getOfficeManagementSummary({ user: SU, tenantId: 't-1', officeId: leticia.id })
  metric('sigue relacionado con Leticia', leticiaFinal!.relatedUsers.some(u => u.id === 'u-fabio'))
  metric('sigue existiendo el usuario', !!(await db.users.get('u-fabio')))
  assert(!leticiaFinal!.relatedUsers.some(u => u.id === 'u-fabio'), 'ya no debe aparecer relacionado con Leticia')
  assert(!!(await db.users.get('u-fabio')), 'el usuario no puede desaparecer de la empresa')
  db.close()
})

await spec('SMOKE-C', 'Smoke gestión', 'Sin Oficina: una ruta suelta se organiza y sus datos quedan intactos', async () => {
  const db = await baseLimpia()
  const { createOffice, assignRoutesToOffice, getOfficeManagementSummary } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')
  const { unassignedRoutesOf } = await import('../src/lib/officeManagement')

  const leticia = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, SU)
  const antigua = await createRouteWithAdmins(datosRutaSmoke({ nombre: 'Antigua', codigo: 'RT-009' }), SU)
  await ventaLista(db, antigua.id, 'c-1', 's-1')

  const sueltasAntes = unassignedRoutesOf(await db.routes.toArray())
  const hijosAntes = JSON.stringify([await db.clients.toArray(), await db.sales.toArray(), await db.installments.toArray()])

  await assignRoutesToOffice({ routeIds: [antigua.id], tenantId: 't-1', officeId: leticia.id }, SU)

  const sueltasDespues = unassignedRoutesOf(await db.routes.toArray())
  const hijosDespues = JSON.stringify([await db.clients.toArray(), await db.sales.toArray(), await db.installments.toArray()])
  const enLeticia = await getOfficeManagementSummary({ user: SU, tenantId: 't-1', officeId: leticia.id })

  metric('sueltas antes → después', `${sueltasAntes.length} → ${sueltasDespues.length}`)
  metric('aparece en Leticia', enLeticia!.accessibleOfficeRoutes.some(r => r.id === antigua.id))
  metric('hijos intactos', hijosAntes === hijosDespues)
  assert(sueltasAntes.length === 1 && sueltasDespues.length === 0, 'la ruta debía salir de "Sin Oficina"')
  assert(enLeticia!.accessibleOfficeRoutes.some(r => r.id === antigua.id), 'la ruta debía aparecer en Leticia')
  assert(hijosAntes === hijosDespues, 'organizar la ruta alteró sus clientes, ventas o parcelas')
  db.close()
})

await spec('SMOKE-D', 'Smoke gestión', 'nueva ruta desde una Oficina: preseleccionada, sin Admin ni Cobrador', async () => {
  const db = await baseLimpia()
  const { createOffice, getOfficeManagementSummary } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')

  const rio = await createOffice({ tenantId: 't-1', nombre: 'Río' }, SU)
  // Exactamente lo que envía el formulario al llegar con ?nueva=1&officeId=<rio>.
  const nueva = await createRouteWithAdmins(
    datosRutaSmoke({ officeId: rio.id, nombre: 'Ruta Puerto', codigo: 'RT-001' }), SU,
  )
  const resumen = await getOfficeManagementSummary({ user: SU, tenantId: 't-1', officeId: rio.id })

  metric('officeId preseleccionada', nueva.officeId === rio.id)
  metric('sin Cobrador', nueva.cobradorId === undefined)
  metric('aparece en el panel de Río', resumen!.accessibleOfficeRoutes.length)
  metric('alerta de ruta sin Cobrador', resumen!.alerts.some(a => a.kind === 'sin-cobrador'))
  assert(nueva.officeId === rio.id, 'la Oficina no quedó preseleccionada')
  assert(nueva.cobradorId === undefined, 'no debe exigirse Cobrador')
  assert(resumen!.accessibleOfficeRoutes.length === 1, 'la ruta debe aparecer en el panel de su Oficina')
  assert(resumen!.alerts.some(a => a.kind === 'sin-cobrador'), 'debe avisarse que la ruta aún no puede cobrar')
  db.close()
})

await spec('SMOKE-E', 'Smoke gestión', 'Oficina inactiva: el panel se consulta, las operaciones siguen bloqueadas', async () => {
  const db = await baseLimpia()
  const { createOffice, setOfficeStatus, getOfficeManagementSummary, updateOffice } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')
  const { registerPayment } = await import('../src/services/paymentService')

  const leticia = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, SU)
  const ruta = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id }), SU)
  await db.users.add({
    id: 'u-cob', tenantId: 't-1', nombre: 'Luis', email: 'luis@c.com', password: 'x',
    rol: 'cobrador', status: 'activo', authorizedRouteIds: [ruta.id], createdAt: '', updatedAt: '',
  } as never)
  const cob = (await db.users.get('u-cob'))!
  await ventaLista(db, ruta.id, 'c-1', 's-1')
  await registerPayment({ saleId: 's-1', requestedAmount: 2_000, actor: cob, fecha: '2026-09-15' })

  await setOfficeStatus({ officeId: leticia.id, tenantId: 't-1', status: 'inactiva' }, SU)

  // CONSULTA: el panel sigue abriéndose y avisa del estado.
  const resumen = await getOfficeManagementSummary({ user: SU, tenantId: 't-1', officeId: leticia.id })
  metric('panel accesible', !!resumen)
  metric('estado', resumen?.office.status)
  metric('rutas visibles', resumen?.accessibleOfficeRoutes.length)
  metric('alerta de Oficina inactiva', resumen!.alerts.some(a => a.kind === 'oficina-inactiva'))
  assert(!!resumen, 'una Oficina inactiva debe poder consultarse')
  assert(resumen!.office.status === 'inactiva' && resumen!.accessibleOfficeRoutes.length === 1, 'el panel debe mostrar sus rutas')
  assert(resumen!.alerts.some(a => a.kind === 'oficina-inactiva' && a.severity === 'error'), 'debe avisarse el estado')

  // OPERACIÓN: sigue bloqueada.
  const pago = await registerPayment({ saleId: 's-1', requestedAmount: 2_000, actor: cob, fecha: '2026-09-15' })
  metric('pago nuevo', pago.ok ? 'ACEPTADO — ERROR' : pago.code)
  assert(!pago.ok && pago.code === 'OFFICE_INACTIVE', 'las operaciones nuevas deben seguir bloqueadas')

  // CRUD ADMINISTRATIVO: sigue disponible según permisos (se puede renombrar y reactivar).
  await updateOffice({ officeId: leticia.id, tenantId: 't-1', nombre: 'Leticia Centro' }, SU)
  await setOfficeStatus({ officeId: leticia.id, tenantId: 't-1', status: 'activa' }, SU)
  const tras = await getOfficeManagementSummary({ user: SU, tenantId: 't-1', officeId: leticia.id })
  const pagoFinal = await registerPayment({ saleId: 's-1', requestedAmount: 2_000, actor: cob, fecha: '2026-09-15' })
  metric('renombrada y reactivada', `${tras?.office.nombre} · ${tras?.office.status}`)
  metric('pago tras reactivar', pagoFinal.ok ? 'ACEPTADO' : pagoFinal.code)
  assert(tras?.office.nombre === 'Leticia Centro', 'el CRUD administrativo debe seguir disponible')
  assert(pagoFinal.ok, 'reactivar debe restablecer la operación')
  db.close()
})


// ############################################################
// GRUPO — SMOKE MULTI-ADMINISTRADOR (Dexie real)
// ------------------------------------------------------------
// Reproduce el recorrido de las capturas y los casos de múltiples
// Administradores, con la base y los servicios reales.
// ############################################################

/** Empresa real con dos Administradores y una ruta que tiene a ambos. */
async function empresaDosAdmins() {
  const db = await baseLimpia()
  const { createRouteWithAdmins } = await import('../src/services/routeService')

  for (const a of [{ id: 'u-carlos', nombre: 'Carlos' }, { id: 'u-juan', nombre: 'Juan' }]) {
    await db.users.add({
      id: a.id, tenantId: 't-1', nombre: a.nombre, email: `${a.id}@c.com`, password: 'x',
      rol: 'admin', status: 'activo', createdAt: '', updatedAt: '',
    } as never)
  }
  const sur = await createRouteWithAdmins(
    datosRutaSmoke({ nombre: 'Ruta Sur', codigo: 'RT-001', adminIds: ['u-carlos', 'u-juan'] }), SU,
  )
  return { db, sur }
}

/** Reproduce lo que hace la pantalla al abrir el editor de una ruta. */
async function abrirEditor(db: Awaited<ReturnType<typeof baseLimpia>>, routeId: string, actor: User) {
  const { assignableRoles, canManageUser } = await import('../src/lib/permissions')
  const { getAssignedRouteIds } = await import('../src/lib/roles')
  const users = await db.users.toArray()
  const asignables = users.filter(u =>
    u.rol !== 'superadmin' && assignableRoles(actor).includes(u.rol) && canManageUser(actor, u))
  return {
    users,
    assignableUserIds: asignables.map(u => u.id),
    // Hidratación del borrador: asignables que ya están en la ruta.
    draftAssignedUserIds: asignables.filter(u => getAssignedRouteIds(u).includes(routeId)).map(u => u.id),
  }
}

await spec('SMOKE-ADMIN-A', 'Smoke multi-admin', 'editar una ruta con DOS Admin y guardar sin cambios NO advierte', async () => {
  const { db, sur } = await empresaDosAdmins()
  const { routeAdmins, effectiveAdminIdsAfterSave, shouldConfirmRouteWithoutAdmin } = await import('../src/lib/routeAdmins')

  const admins = routeAdmins(await db.users.toArray(), sur.id, 't-1')
  metric('administradores de la ruta', admins.map(a => a.nombre).sort().join(', '))
  assert(admins.length === 2, 'precondición: la ruta debe tener a Carlos y Juan')

  // Caso de la captura: el ACTOR es un Administrador.
  const carlos = (await db.users.get('u-carlos'))!
  const editorAdmin = await abrirEditor(db, sur.id, carlos)
  const efectivosAdmin = effectiveAdminIdsAfterSave({
    routeId: sur.id, users: editorAdmin.users, tenantId: 't-1',
    assignableUserIds: editorAdmin.assignableUserIds,
    draftAssignedUserIds: editorAdmin.draftAssignedUserIds,
  })
  const adviertePorAdmin = shouldConfirmRouteWithoutAdmin({
    routeStatus: sur.status, adminIdsBefore: admins.map(a => a.id),
    effectiveAdminIdsAfterSave: efectivosAdmin,
  })
  metric('borrador del actor Admin contiene admins', editorAdmin.draftAssignedUserIds.length)
  metric('efectivos tras guardar (actor Admin)', efectivosAdmin.length)
  metric('advertencia (actor Admin)', adviertePorAdmin)
  assert(efectivosAdmin.length === 2, 'los dos Administradores deben seguir siendo efectivos')
  assert(!adviertePorAdmin, 'NO debe advertirse: nadie tocó los Administradores')

  // Y con el Super Admin, que sí los gestiona, el borrador los hidrata.
  const editorSuper = await abrirEditor(db, sur.id, SU)
  const efectivosSuper = effectiveAdminIdsAfterSave({
    routeId: sur.id, users: editorSuper.users, tenantId: 't-1',
    assignableUserIds: editorSuper.assignableUserIds,
    draftAssignedUserIds: editorSuper.draftAssignedUserIds,
  })
  metric('borrador del Super Admin hidrata ambos', editorSuper.draftAssignedUserIds.filter(id => id.startsWith('u-carlos') || id.startsWith('u-juan')).length)
  metric('efectivos (Super Admin)', efectivosSuper.length)
  assert(efectivosSuper.length === 2, 'el editor del Super Admin debe conservar ambos')
  assert(!shouldConfirmRouteWithoutAdmin({
    routeStatus: sur.status, adminIdsBefore: admins.map(a => a.id), effectiveAdminIdsAfterSave: efectivosSuper,
  }), 'tampoco debe advertir con el Super Admin')
  db.close()
})

await spec('SMOKE-ADMIN-B', 'Smoke multi-admin', 'quitar a Juan: sin advertencia, Carlos sigue y las rutas de Juan se conservan', async () => {
  const { db, sur } = await empresaDosAdmins()
  const { createRouteWithAdmins, updateRouteWithAssignments } = await import('../src/services/routeService')
  const { routeAdmins, effectiveAdminIdsAfterSave, shouldConfirmRouteWithoutAdmin } = await import('../src/lib/routeAdmins')

  // Juan tiene además otra ruta que no se está editando.
  const otra = await createRouteWithAdmins(
    datosRutaSmoke({ nombre: 'Ruta Norte', codigo: 'RT-002', adminIds: ['u-juan'] }), SU,
  )

  const users = await db.users.toArray()
  const antes = routeAdmins(users, sur.id, 't-1').map(a => a.id)
  const efectivos = effectiveAdminIdsAfterSave({
    routeId: sur.id, users, tenantId: 't-1',
    assignableUserIds: ['u-carlos', 'u-juan'],
    draftAssignedUserIds: ['u-carlos'],           // se desmarca Juan
  })
  metric('advertencia', shouldConfirmRouteWithoutAdmin({ routeStatus: sur.status, adminIdsBefore: antes, effectiveAdminIdsAfterSave: efectivos }))
  assert(!shouldConfirmRouteWithoutAdmin({ routeStatus: sur.status, adminIdsBefore: antes, effectiveAdminIdsAfterSave: efectivos }),
    'dejando a Carlos no debe advertirse')

  await updateRouteWithAssignments({
    routeId: sur.id, tenantId: 't-1', nombre: 'Ruta Sur', ciudad: undefined,
    tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 500_000,
    cobradorId: undefined, assignedUserIds: ['u-carlos'], assignableUserIds: ['u-carlos', 'u-juan'],
  }, SU)

  const finales = await db.users.toArray()
  const juan = finales.find(u => u.id === 'u-juan')!
  metric('admins de Ruta Sur', routeAdmins(finales, sur.id, 't-1').map(a => a.nombre).join(', '))
  metric('rutas de Juan', JSON.stringify(juan.authorizedRouteIds))
  assert(routeAdmins(finales, sur.id, 't-1').map(a => a.id).join() === 'u-carlos', 'solo Carlos debe quedar en Ruta Sur')
  assert((juan.authorizedRouteIds ?? []).includes(otra.id), 'SE PERDIÓ la otra ruta de Juan al desasignarlo de Ruta Sur')
  db.close()
})

await spec('SMOKE-ADMIN-C', 'Smoke multi-admin', 'quitar a los DOS: advierte, se confirma y la ruta queda sin Admin', async () => {
  const { db, sur } = await empresaDosAdmins()
  const { updateRouteWithAssignments } = await import('../src/services/routeService')
  const { routeAdmins, effectiveAdminIdsAfterSave, shouldConfirmRouteWithoutAdmin } = await import('../src/lib/routeAdmins')

  const users = await db.users.toArray()
  const antes = routeAdmins(users, sur.id, 't-1').map(a => a.id)
  const efectivos = effectiveAdminIdsAfterSave({
    routeId: sur.id, users, tenantId: 't-1',
    assignableUserIds: ['u-carlos', 'u-juan'], draftAssignedUserIds: [],
  })
  const advierte = shouldConfirmRouteWithoutAdmin({ routeStatus: sur.status, adminIdsBefore: antes, effectiveAdminIdsAfterSave: efectivos })
  metric('advertencia', advierte)
  assert(advierte, 'quitar a todos los Administradores SÍ debe advertir')

  // El usuario confirma "Guardar de todos modos": el guardado procede igual.
  await updateRouteWithAssignments({
    routeId: sur.id, tenantId: 't-1', nombre: 'Ruta Sur', ciudad: undefined,
    tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 500_000,
    cobradorId: undefined, assignedUserIds: [], assignableUserIds: ['u-carlos', 'u-juan'],
  }, SU)

  const finales = await db.users.toArray()
  const ruta = await db.routes.get(sur.id)
  metric('admins tras confirmar', routeAdmins(finales, sur.id, 't-1').length)
  metric('estado de la ruta', ruta?.status)
  assert(routeAdmins(finales, sur.id, 't-1').length === 0, 'la ruta debía quedar sin Administrador')
  assert(ruta?.status === 'activa', 'una ruta sin Administrador sigue siendo válida: no hay rollback')
  db.close()
})

await spec('SMOKE-ADMIN-D', 'Smoke multi-admin', 'un Admin nuevo nace sin rutas y solo recibe la que se le asigna', async () => {
  const { db } = await empresaDosAdmins()
  const { createOffice, createRouteWithAdmins } = await import('../src/services/officeService')
    .then(async o => ({ createOffice: o.createOffice, createRouteWithAdmins: (await import('../src/services/routeService')).createRouteWithAdmins }))
  const { setUserOfficeRoutes } = await import('../src/services/officeService')

  const rio = await createOffice({ tenantId: 't-1', nombre: 'Río' }, SU)
  const puerto = await createRouteWithAdmins(datosRutaSmoke({ officeId: rio.id, nombre: 'Puerto', codigo: 'RT-009' }), SU)

  await db.users.add({
    id: 'u-pedro', tenantId: 't-1', nombre: 'Pedro', email: 'pedro@c.com', password: 'x',
    rol: 'admin', status: 'activo', createdAt: '', updatedAt: '',
  } as never)
  const reciennacido = (await db.users.get('u-pedro'))!
  metric('rutas al crearse', JSON.stringify(reciennacido.authorizedRouteIds))
  metric('rutas existentes en la empresa', (await db.routes.count()))
  assert((reciennacido.authorizedRouteIds ?? []).length === 0, 'Pedro no debe heredar ninguna ruta')

  // Se le asigna SOLO la ruta de Río, desde el panel de esa Oficina.
  await setUserOfficeRoutes({
    userId: 'u-pedro', tenantId: 't-1', officeRouteIds: [puerto.id], selectedRouteIds: [puerto.id],
  }, SU)
  const pedro = (await db.users.get('u-pedro'))!
  metric('rutas tras asignar', JSON.stringify(pedro.authorizedRouteIds))
  assert((pedro.authorizedRouteIds ?? []).length === 1, 'solo debe tener la ruta asignada')
  assert((pedro.authorizedRouteIds ?? [])[0] === puerto.id, 'debe tener exactamente Ruta Puerto')
  db.close()
})

await spec('SMOKE-ADMIN-E', 'Smoke multi-admin', 'Carlos crea una ruta: queda asignado él y solo él', async () => {
  const { db } = await empresaDosAdmins()
  const { createRouteWithAdmins } = await import('../src/services/routeService')

  const carlos = (await db.users.get('u-carlos'))!
  const nueva = await createRouteWithAdmins(
    datosRutaSmoke({ nombre: 'Ruta Nueva', codigo: 'RT-050' }), carlos,
  )
  const users = await db.users.toArray()
  const tiene = (id: string) => (users.find(u => u.id === id)?.authorizedRouteIds ?? []).includes(nueva.id)

  metric('Carlos (actor)', tiene('u-carlos'))
  metric('Juan', tiene('u-juan'))
  const { canAccessRoute } = await import('../src/lib/permissions')
  metric('Carlos opera la ruta', canAccessRoute(users.find(u => u.id === 'u-carlos')!, nueva.id))
  assert(tiene('u-carlos'), 'el Administrador creador debe quedar asignado (anti auto-bloqueo)')
  assert(!tiene('u-juan'), 'ningún otro Administrador puede recibir la ruta automáticamente')
  db.close()
})


// ############################################################
// GRUPO — SMOKE INTEGRACIÓN TRANSVERSAL (Dexie real)
// ------------------------------------------------------------
// El patrón Oficina → Ruta aplicado a datos reales: lo que vería el usuario al
// llegar a cada módulo desde el panel de una Oficina.
// ############################################################

/**
 * Empresa real: Leticia con 3 rutas, Río con 1, y una ruta Sin Oficina.
 * El Admin tiene Centro y Mercado (de Leticia), Puerto (de Río) y la Sin Oficina.
 * NO tiene Norte, aunque sea de Leticia: es la prueba del alcance parcial.
 */
async function empresaTransversal() {
  const db = await baseLimpia()
  const { createOffice } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')

  const leticia = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, SU)
  const rio = await createOffice({ tenantId: 't-1', nombre: 'Río' }, SU)

  const centro = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Centro', codigo: 'RT-001' }), SU)
  const mercado = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Mercado', codigo: 'RT-002' }), SU)
  const norte = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Norte', codigo: 'RT-003' }), SU)
  const puerto = await createRouteWithAdmins(datosRutaSmoke({ officeId: rio.id, nombre: 'Puerto', codigo: 'RT-004' }), SU)
  const antigua = await createRouteWithAdmins(datosRutaSmoke({ nombre: 'Antigua', codigo: 'RT-005' }), SU)

  await db.users.add({
    id: 'u-adm', tenantId: 't-1', nombre: 'Carlos', email: 'carlos@c.com', password: 'x',
    rol: 'admin', status: 'activo',
    authorizedRouteIds: [centro.id, mercado.id, puerto.id, antigua.id],
    createdAt: '', updatedAt: '',
  } as never)

  // Un cliente y una venta por ruta, para poder comprobar el recorte de datos.
  let n = 0
  for (const r of [centro, mercado, norte, puerto, antigua]) {
    n++
    await ventaLista(db, r.id, `c-${n}`, `s-${n}`)
    await db.expenses.add({
      id: `e-${n}`, tenantId: 't-1', routeId: r.id, categoryId: 'cat', userId: 'u-adm',
      valor: 1000 * n, fecha: '2026-09-15', syncStatus: 'synced', createdAt: '',
    } as never)
    await db.withdrawals.add({
      id: `w-${n}`, tenantId: 't-1', routeId: r.id, valor: 500 * n,
      fecha: '2026-09-15', userId: 'u-adm', createdAt: '',
    } as never)
  }

  const admin = (await db.users.get('u-adm'))!
  return { db, admin, leticia, rio, centro, mercado, norte, puerto, antigua }
}

/** Reproduce lo que hace `useOfficeRouteFilter` al llegar con `?officeId=`. */
async function filtroDesde(db: Awaited<ReturnType<typeof baseLimpia>>, actor: User, officeParam: string | null) {
  const { filterAccessibleRoutes } = await import('../src/lib/permissions')
  const { resolveOfficeParam, visibleRouteIds, routesInOfficeFilter, filterRowsByVisibleRoutes } =
    await import('../src/lib/officeRouteFilter')
  const offices = await db.offices.where('tenantId').equals('t-1').toArray()
  const accesibles = filterAccessibleRoutes(actor, await db.routes.where('tenantId').equals('t-1').toArray())
  const officeId = resolveOfficeParam(officeParam, offices)
  return {
    officeId,
    routesInOffice: routesInOfficeFilter(accesibles, officeId),
    visibles: visibleRouteIds({ accessibleRoutes: accesibles, officeId }),
    filtrar: <T extends { routeId: string }>(rows: T[]) =>
      filterRowsByVisibleRoutes(rows, visibleRouteIds({ accessibleRoutes: accesibles, officeId })),
  }
}

await spec('SMOKE-E2-1', 'Smoke transversal', 'Oficina → Clientes: llega filtrado y solo con las rutas autorizadas', async () => {
  const { db, admin, leticia, norte } = await empresaTransversal()
  const f = await filtroDesde(db, admin, leticia.id)
  const clientes = f.filtrar(await db.clients.toArray())

  metric('oficina aplicada', f.officeId === leticia.id)
  metric('rutas del filtro', f.routesInOffice.map(r => r.nombre).sort().join(', '))
  metric('clientes visibles', clientes.length)
  assert(f.officeId === leticia.id, 'el contexto de la Oficina debe aplicarse')
  assert(f.routesInOffice.length === 2, 'solo las 2 rutas autorizadas de Leticia')
  assert(clientes.length === 2, 'solo los clientes de esas 2 rutas')
  assert(!clientes.some(c => c.routeId === norte.id), 'se coló un cliente de una ruta no autorizada')
  db.close()
})

await spec('SMOKE-E2-2', 'Smoke transversal', 'Oficina → Caja: solo se ofrecen las rutas autorizadas de esa Oficina', async () => {
  const { db, admin, leticia, norte, puerto } = await empresaTransversal()
  const f = await filtroDesde(db, admin, leticia.id)

  metric('rutas ofrecidas en caja', f.routesInOffice.map(r => r.nombre).sort().join(', '))
  assert(f.routesInOffice.length === 2, 'la caja solo puede ofrecer rutas del filtro')
  assert(!f.routesInOffice.some(r => r.id === norte.id), 'no puede ofrecerse una ruta no autorizada')
  assert(!f.routesInOffice.some(r => r.id === puerto.id), 'no puede ofrecerse una ruta de otra Oficina')

  // Y la caja de una de ellas se calcula con el motor de siempre, sin cambios.
  const { getCashboxSummary } = await import('../src/services/cashboxEngine')
  const resumen = await getCashboxSummary(f.routesInOffice[0].id)
  metric('caja calculada', typeof resumen.saldoActual === 'number')
  assert(typeof resumen.saldoActual === 'number', 'el motor de caja debe seguir respondiendo por ruta')
  db.close()
})

await spec('SMOKE-E2-3', 'Smoke transversal', 'cambiar de Oficina dentro del módulo limpia la ruta que queda fuera', async () => {
  const { db, admin, leticia, rio, centro } = await empresaTransversal()
  const { filterAccessibleRoutes } = await import('../src/lib/permissions')
  const { routeStillInFilter, routesInOfficeFilter } = await import('../src/lib/officeRouteFilter')
  const accesibles = filterAccessibleRoutes(admin, await db.routes.where('tenantId').equals('t-1').toArray())

  const siguesiendoValida = routeStillInFilter(accesibles, rio.id, centro.id)
  const rutasDeRio = routesInOfficeFilter(accesibles, rio.id)

  metric('ruta Centro sigue válida en Río', siguesiendoValida)
  metric('rutas de Río visibles', rutasDeRio.map(r => r.nombre).join(', '))
  assert(routeStillInFilter(accesibles, leticia.id, centro.id), 'Centro es válida dentro de Leticia')
  assert(!siguesiendoValida, 'al pasar a Río, Centro debe dejar de ser válida y limpiarse')
  assert(rutasDeRio.length === 1 && rutasDeRio[0].nombre === 'Puerto', 'deben ofrecerse solo las rutas de Río')
  db.close()
})

await spec('SMOKE-E2-4', 'Smoke transversal', '"Sin Oficina" funciona transversalmente en clientes, gastos y retiros', async () => {
  const { db, admin, antigua } = await empresaTransversal()
  const { NO_OFFICE } = await import('../src/lib/officeGrouping')
  const f = await filtroDesde(db, admin, NO_OFFICE)

  const clientes = f.filtrar(await db.clients.toArray())
  const gastos = f.filtrar(await db.expenses.toArray())
  const retiros = f.filtrar(await db.withdrawals.toArray())

  metric('rutas Sin Oficina', f.routesInOffice.map(r => r.nombre).join(', '))
  metric('clientes / gastos / retiros', `${clientes.length} / ${gastos.length} / ${retiros.length}`)
  assert(f.routesInOffice.length === 1 && f.routesInOffice[0].id === antigua.id, 'solo la ruta sin Oficina')
  assert(clientes.length === 1 && clientes[0].routeId === antigua.id, 'clientes recortados a la ruta sin Oficina')
  assert(gastos.length === 1 && retiros.length === 1, 'gastos y retiros siguen el mismo patrón')
  db.close()
})

await spec('SMOKE-E2-5', 'Smoke transversal', 'Admin parcial: mismos 2 resultados en clientes, ventas, gastos y retiros', async () => {
  const { db, admin, leticia, norte } = await empresaTransversal()
  const f = await filtroDesde(db, admin, leticia.id)

  const clientes = f.filtrar(await db.clients.toArray())
  const ventas = f.filtrar(await db.sales.toArray())
  const gastos = f.filtrar(await db.expenses.toArray())
  const retiros = f.filtrar(await db.withdrawals.toArray())

  metric('clientes/ventas/gastos/retiros', `${clientes.length}/${ventas.length}/${gastos.length}/${retiros.length}`)
  metric('alguno de la ruta no autorizada', [...clientes, ...ventas, ...gastos, ...retiros].some(r => r.routeId === norte.id))
  assert([clientes, ventas, gastos, retiros].every(l => l.length === 2),
    'los cuatro módulos deben coincidir en las mismas 2 rutas autorizadas')
  assert(![...clientes, ...ventas, ...gastos, ...retiros].some(r => r.routeId === norte.id),
    'ningún módulo puede mostrar datos de una ruta no autorizada')
  db.close()
})

await spec('SMOKE-E2-6', 'Smoke transversal', 'Oficina inactiva: el histórico se consulta y la escritura sigue bloqueada', async () => {
  const { db, admin, leticia, centro } = await empresaTransversal()
  const { setOfficeStatus } = await import('../src/services/officeService')
  const { registerPayment } = await import('../src/services/paymentService')

  await setOfficeStatus({ officeId: leticia.id, tenantId: 't-1', status: 'inactiva' }, SU)

  // LECTURA: el filtro sigue devolviendo sus datos históricos.
  const f = await filtroDesde(db, admin, leticia.id)
  const clientes = f.filtrar(await db.clients.toArray())
  metric('oficina inactiva filtrable', f.officeId === leticia.id)
  metric('clientes históricos visibles', clientes.length)
  assert(f.officeId === leticia.id, 'una Oficina inactiva no debe esconderse de los filtros')
  assert(clientes.length === 2, 'el histórico debe seguir consultándose')

  // ESCRITURA: bloqueada por la guarda existente, sin duplicarla en cada pantalla.
  const venta = (await db.sales.toArray()).find(s => s.routeId === centro.id)!
  const pago = await registerPayment({ saleId: venta.id, requestedAmount: 1_000, actor: admin, fecha: '2026-09-15' })
  metric('pago nuevo', pago.ok ? 'ACEPTADO — ERROR' : pago.code)
  assert(!pago.ok && pago.code === 'OFFICE_INACTIVE', 'la escritura debe seguir bloqueada por la guarda operativa')
  db.close()
})

await spec('SMOKE-E2-7', 'Smoke transversal', 'un officeId ajeno no amplía el alcance en ningún módulo', async () => {
  const { db, admin } = await empresaTransversal()
  const { createOffice } = await import('../src/services/officeService')
  const ajena = await createOffice({ tenantId: 't-2', nombre: 'Ajena' }, SU)

  const f = await filtroDesde(db, admin, ajena.id)
  const clientes = f.filtrar(await db.clients.toArray())
  const sinFiltro = await filtroDesde(db, admin, null)

  metric('officeId resuelto', f.officeId === '' ? 'todas (ignorado)' : f.officeId)
  metric('clientes con el id ajeno', clientes.length)
  metric('clientes sin filtro', sinFiltro.filtrar(await db.clients.toArray()).length)
  assert(f.officeId === '', 'una Oficina de otra empresa debe ignorarse')
  assert(clientes.length === 4, 'debe caer a "todas las oficinas" dentro de lo AUTORIZADO (4 rutas)')
  assert(clientes.length === sinFiltro.filtrar(await db.clients.toArray()).length,
    'ignorar el parámetro no puede dar más ni menos que no enviarlo')
  db.close()
})


// ############################################################
// GRUPO — SMOKE OFICINA OPERATIVA (Dexie real)
// ------------------------------------------------------------
// El panel de Oficina con datos reales: cobranza del día, cartera, consolidado
// financiero y alertas, siempre sobre las rutas visibles del usuario.
// ############################################################

/** Crea una venta desembolsada con parcelas en fechas controladas. */
async function ventaConCuotas(
  db: Awaited<ReturnType<typeof baseLimpia>>,
  params: { routeId: string; clientId: string; saleId: string; cuotas: { fecha: string; valor: number; pagado?: number }[] },
) {
  await db.clients.add({
    id: params.clientId, tenantId: 't-1', routeId: params.routeId, nombre: params.clientId,
    documento: params.clientId, telefonoPrincipal: '1', direccionPrincipal: 'x',
    status: 'activo', createdAt: '', updatedAt: '',
  } as never)
  const total = params.cuotas.reduce((s, c) => s + c.valor, 0)
  await db.sales.add({
    id: params.saleId, tenantId: 't-1', routeId: params.routeId, clientId: params.clientId,
    createdByUserId: 'u', valorVenta: total, tasaInteres: 0, valorInteres: 0, valorTotal: total,
    saldo: total, numeroCuotas: params.cuotas.length, valorCuota: params.cuotas[0]?.valor ?? 0,
    frecuenciaPago: 'diaria', fechaInicio: '2026-09-01', fechaFinalEstimada: '2026-12-31',
    status: 'activa', disbursementStatus: 'desembolsado', createdAt: '', updatedAt: '',
  } as never)
  let n = 0
  for (const c of params.cuotas) {
    n++
    const pagado = c.pagado ?? 0
    await db.installments.add({
      id: `${params.saleId}-i${n}`, saleId: params.saleId, numero: n,
      fechaVencimiento: c.fecha, valor: c.valor, pagado, saldo: c.valor - pagado,
      status: c.valor - pagado <= 0 ? 'pagada' : 'pendiente', diasMora: 0,
    } as never)
  }
}

/**
 * Oficina Leticia con 3 rutas (Centro, Mercado, Norte) y una en Río.
 * El Admin ve Centro y Mercado, NO Norte: el alcance parcial de siempre.
 */
async function oficinaOperativa() {
  const db = await baseLimpia()
  const { createOffice } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')
  const { today } = await import('../src/lib/formatters')
  const hoy = today()

  const leticia = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, SU)
  const centro = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Centro', codigo: 'RT-001' }), SU)
  const mercado = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Mercado', codigo: 'RT-002' }), SU)
  const norte = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Norte', codigo: 'RT-003' }), SU)

  // Centro: cuota de hoy 100, recaudado 60. Mercado: cuota de hoy 50, sin recaudo,
  // y una cuota vencida de 200 (cliente en atraso).
  await ventaConCuotas(db, { routeId: centro.id, clientId: 'c-centro', saleId: 's-centro', cuotas: [{ fecha: hoy, valor: 100 }] })
  await ventaConCuotas(db, { routeId: mercado.id, clientId: 'c-merc', saleId: 's-merc', cuotas: [{ fecha: '2026-01-05', valor: 200 }, { fecha: hoy, valor: 50 }] })
  // Norte (NO autorizada): cifras grandes que no deben aparecer en ningún indicador.
  await ventaConCuotas(db, { routeId: norte.id, clientId: 'c-norte', saleId: 's-norte', cuotas: [{ fecha: hoy, valor: 999_999 }] })

  await db.users.add({
    id: 'u-adm', tenantId: 't-1', nombre: 'Ana', email: 'ana@c.com', password: 'x',
    rol: 'admin', status: 'activo', authorizedRouteIds: [centro.id, mercado.id],
    createdAt: '', updatedAt: '',
  } as never)
  const admin = (await db.users.get('u-adm'))!

  // Recaudo real del día en Centro, con el servicio de pagos de producción.
  const { registerPayment } = await import('../src/services/paymentService')
  const pago = await registerPayment({ saleId: 's-centro', requestedAmount: 60, actor: admin, fecha: hoy })
  if (!pago.ok) throw new Error(`precondición: el pago debía registrarse (${pago.code})`)

  // Gasto del día en Centro.
  await db.expenses.add({
    id: 'e-hoy', tenantId: 't-1', routeId: centro.id, categoryId: 'cat', userId: 'u-adm',
    valor: 15, fecha: hoy, syncStatus: 'synced', createdAt: '',
  } as never)

  return { db, admin, leticia, centro, mercado, norte, hoy }
}

await spec('SMOKE-E3-1', 'Smoke oficina operativa', 'los indicadores del día salen de las rutas visibles', async () => {
  const { db, admin, leticia, hoy } = await oficinaOperativa()
  const { getOfficeManagementSummary } = await import('../src/services/officeService')
  const r = (await getOfficeManagementSummary({ user: admin, tenantId: 't-1', officeId: leticia.id }))!

  metric('fecha', r.fecha === hoy)
  metric('a cobrar hoy', r.ops.aCobrarHoy)
  metric('recaudado hoy', r.ops.recaudadoHoy)
  metric('pendiente hoy', r.ops.pendienteHoy)
  metric('cumplimiento', `${r.ops.cumplimiento}%`)
  assert(r.ops.aCobrarHoy === 150, `Centro 100 + Mercado 50 = 150; llegó ${r.ops.aCobrarHoy}`)
  assert(r.ops.recaudadoHoy === 60, 'el recaudo debe salir del pago real registrado')
  assert(r.ops.pendienteHoy === 90, 'pendiente = 150 − 60')
  assert(r.ops.cumplimiento === 40, '60/150 = 40%')
  db.close()
})

await spec('SMOKE-E3-2', 'Smoke oficina operativa', 'una ruta NO autorizada no contamina ningún indicador', async () => {
  const { db, admin, leticia, norte } = await oficinaOperativa()
  const { getOfficeManagementSummary } = await import('../src/services/officeService')
  const r = (await getOfficeManagementSummary({ user: admin, tenantId: 't-1', officeId: leticia.id }))!

  metric('alcance', r.scope.label)
  metric('rutas con hechos operativos', r.routeOps.map(o => o.nombre).sort().join(', '))
  metric('a cobrar hoy', r.ops.aCobrarHoy)
  assert(r.scope.label === '2 de 3 rutas visibles — rutas autorizadas', 'el alcance parcial debe rotularse')
  assert(r.routeOps.length === 2 && !r.routeOps.some(o => o.routeId === norte.id),
    'Norte no puede aparecer en el comparativo')
  assert(r.ops.aCobrarHoy === 150, 'los 999.999 de Norte NO pueden entrar en los indicadores')
  assert(!r.opsAlerts.some(a => a.mensaje.includes('Norte')), 'ninguna alerta puede revelar Norte')
  db.close()
})

await spec('SMOKE-E3-3', 'Smoke oficina operativa', 'cartera, atrasos y comparativo por ruta', async () => {
  const { db, admin, leticia, centro, mercado } = await oficinaOperativa()
  const { getOfficeManagementSummary } = await import('../src/services/officeService')
  const r = (await getOfficeManagementSummary({ user: admin, tenantId: 't-1', officeId: leticia.id }))!

  const opsCentro = r.routeOps.find(o => o.routeId === centro.id)!
  const opsMercado = r.routeOps.find(o => o.routeId === mercado.id)!

  metric('cartera activa', r.ops.carteraActiva)
  metric('cartera vencida', r.ops.carteraVencida)
  metric('clientes con atraso', r.ops.clientesConAtraso)
  metric('Centro: cumplimiento', `${opsCentro.cumplimiento}%`)
  metric('Mercado: cumplimiento', `${opsMercado.cumplimiento}%`)
  metric('gastos hoy', r.ops.gastosHoy)

  assert(r.ops.carteraVencida === 200, 'la cuota vencida de Mercado debe contarse')
  assert(r.ops.clientesConAtraso === 1, 'un solo cliente en atraso')
  assert(r.ops.carteraActiva === 290, 'saldo pendiente: 40 (Centro) + 250 (Mercado)')
  assert(opsCentro.cumplimiento === 60 && opsMercado.cumplimiento === 0,
    'el comparativo por ruta debe distinguir su cumplimiento')
  assert(r.ops.gastosHoy === 15, 'el gasto del día debe agregarse')
  db.close()
})

await spec('SMOKE-E3-4', 'Smoke oficina operativa', 'el consolidado financiero solo llega a roles con permiso', async () => {
  const { db, admin, leticia, centro, mercado } = await oficinaOperativa()
  const { getOfficeManagementSummary } = await import('../src/services/officeService')
  const { can } = await import('../src/lib/permissions')

  // Admin: SÍ tiene caja de ruta.
  const conPermiso = (await getOfficeManagementSummary({ user: admin, tenantId: 't-1', officeId: leticia.id }))!
  metric('admin ve finanzas', conPermiso.finance !== null)
  metric('base actual', conPermiso.finance?.baseActual)
  metric('cobros consolidados', conPermiso.finance?.cobros)
  assert(conPermiso.finance !== null, 'el Administrador debe ver el consolidado')
  assert(typeof conPermiso.finance!.totalControlado === 'number', 'el consolidado debe traer cifras')

  // Cobrador con las MISMAS rutas: no tiene `cashbox.viewRoute`.
  await db.users.add({
    id: 'u-cob', tenantId: 't-1', nombre: 'Luis', email: 'luis@c.com', password: 'x',
    rol: 'cobrador', status: 'activo', authorizedRouteIds: [centro.id, mercado.id],
    createdAt: '', updatedAt: '',
  } as never)
  const cob = (await db.users.get('u-cob'))!
  const sinPermiso = (await getOfficeManagementSummary({ user: cob, tenantId: 't-1', officeId: leticia.id }))!

  metric('cobrador puede ver caja de ruta', can(cob, 'cashbox.viewRoute', { routeId: centro.id }))
  metric('cobrador recibe finanzas', sinPermiso.finance !== null)
  assert(!can(cob, 'cashbox.viewRoute', { routeId: centro.id }), 'el Cobrador no tiene caja financiera de ruta')
  assert(sinPermiso.finance === null, 'sin permiso el consolidado NO debe calcularse ni enviarse')
  // Pero sus indicadores operativos sí existen: no es un panel vacío.
  assert(sinPermiso.ops.aCobrarHoy === 150, 'la operación del día sigue disponible para el Cobrador')
  db.close()
})

await spec('SMOKE-E3-5', 'Smoke oficina operativa', 'las alertas avanzadas aparecen cuando corresponde', async () => {
  const { db, admin, leticia, mercado } = await oficinaOperativa()
  const { getOfficeManagementSummary } = await import('../src/services/officeService')
  const r = (await getOfficeManagementSummary({ user: admin, tenantId: 't-1', officeId: leticia.id }))!

  const tipos = r.opsAlerts.map(a => a.kind)
  metric('alertas operativas', tipos.join(', '))
  metric('mensajes', r.opsAlerts.map(a => a.mensaje).join(' | '))
  assert(tipos.includes('cartera-vencida'), 'debe avisarse la cartera vencida')
  assert(tipos.includes('clientes-atraso'), 'debe avisarse el cliente en atraso')
  assert(tipos.includes('cumplimiento-bajo'), 'debe avisarse el cumplimiento bajo')
  // Ana es Administradora efectiva de las dos rutas: no debe avisarse lo contrario.
  assert(!tipos.includes('sin-administrador'),
    'no puede avisarse "sin Administrador" en rutas que sí lo tienen')
  assert(r.opsAlerts.some(a => a.routeId === mercado.id), 'las alertas deben identificar la ruta')
  db.close()
})

await spec('SMOKE-E3-6', 'Smoke oficina operativa', 'una Oficina inactiva sigue mostrando su operación histórica', async () => {
  const { db, admin, leticia } = await oficinaOperativa()
  const { getOfficeManagementSummary, setOfficeStatus } = await import('../src/services/officeService')
  await setOfficeStatus({ officeId: leticia.id, tenantId: 't-1', status: 'inactiva' }, SU)

  const r = (await getOfficeManagementSummary({ user: admin, tenantId: 't-1', officeId: leticia.id }))!
  metric('panel accesible', !!r)
  metric('estado', r.office.status)
  metric('a cobrar hoy', r.ops.aCobrarHoy)
  metric('finanzas disponibles', r.finance !== null)
  assert(r.office.status === 'inactiva', 'el panel debe reflejar el estado')
  assert(r.ops.aCobrarHoy === 150 && r.ops.carteraVencida === 200, 'la operación histórica sigue visible')
  assert(r.alerts.some(a => a.kind === 'oficina-inactiva'), 'debe avisarse que está inactiva')
  db.close()
})


// ############################################################
// GRUPO — SMOKE ENTREGA 4 (Dexie real)
// ------------------------------------------------------------
// Visión ejecutiva, roles, actividad y exportación con datos reales.
// ############################################################

await spec('SMOKE-E4-1', 'Smoke ejecutivo', 'Supervisor multi-Oficina ve solo sus rutas, agrupadas', async () => {
  const db = await baseLimpia()
  const { createOffice } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')
  const { filterAccessibleRoutes, canAccessRoute } = await import('../src/lib/permissions')
  const { groupRoutesByOffice } = await import('../src/lib/officeGrouping')

  const leticia = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, SU)
  const rio = await createOffice({ tenantId: 't-1', nombre: 'Río' }, SU)
  const centro = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Centro', codigo: 'RT-001' }), SU)
  const norte = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Norte', codigo: 'RT-002' }), SU)
  const puerto = await createRouteWithAdmins(datosRutaSmoke({ officeId: rio.id, nombre: 'Puerto', codigo: 'RT-003' }), SU)

  await db.users.add({
    id: 'u-sup', tenantId: 't-1', nombre: 'Sara', email: 'sara@c.com', password: 'x',
    rol: 'supervisor', status: 'activo', authorizedRouteIds: [centro.id, puerto.id],
    createdAt: '', updatedAt: '',
  } as never)
  const sup = (await db.users.get('u-sup'))!

  const suyas = filterAccessibleRoutes(sup, await db.routes.toArray())
  const grupos = groupRoutesByOffice(suyas, await db.offices.toArray())

  metric('rutas visibles', suyas.map(r => r.nombre).sort().join(', '))
  metric('grupos', grupos.map(g => `${g.label}(${g.routes.length})`).join(', '))
  assert(suyas.length === 2, 'debe ver exactamente sus dos rutas')
  assert(grupos.length === 2 && grupos.every(g => g.routes.length === 1), 'una ruta por Oficina')
  assert(!canAccessRoute(sup, norte.id), 'no puede acceder a la ruta hermana de Leticia')
  db.close()
})

await spec('SMOKE-E4-2', 'Smoke ejecutivo', 'Secretario: clientes filtrados por Oficina sin escapar del alcance', async () => {
  const db = await baseLimpia()
  const { createOffice } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')
  const { filterAccessibleRoutes, can } = await import('../src/lib/permissions')
  const { visibleRouteIds, filterRowsByVisibleRoutes } = await import('../src/lib/officeRouteFilter')

  const leticia = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, SU)
  const centro = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Centro', codigo: 'RT-001' }), SU)
  const norte = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Norte', codigo: 'RT-002' }), SU)
  await ventaLista(db, centro.id, 'c-centro', 's-centro')
  await ventaLista(db, norte.id, 'c-norte', 's-norte')

  await db.users.add({
    id: 'u-sec', tenantId: 't-1', nombre: 'Sonia', email: 'sonia@c.com', password: 'x',
    rol: 'secretario', status: 'activo', authorizedRouteIds: [centro.id],
    createdAt: '', updatedAt: '',
  } as never)
  const sec = (await db.users.get('u-sec'))!

  const accesibles = filterAccessibleRoutes(sec, await db.routes.toArray())
  const visibles = visibleRouteIds({ accessibleRoutes: accesibles, officeId: leticia.id })
  const clientes = filterRowsByVisibleRoutes(await db.clients.toArray(), visibles)

  metric('clientes visibles', clientes.map(c => c.id).join(', '))
  metric('puede corregir en Centro', can(sec, 'payment.correct', { routeId: centro.id }))
  metric('puede corregir en Norte', can(sec, 'payment.correct', { routeId: norte.id }))
  assert(clientes.length === 1 && clientes[0].routeId === centro.id, 'solo el cliente de su ruta')
  assert(can(sec, 'payment.correct', { routeId: centro.id }), 'debe poder corregir en su ruta')
  assert(!can(sec, 'payment.correct', { routeId: norte.id }), 'no puede corregir fuera de su alcance')
  db.close()
})

await spec('SMOKE-E4-3', 'Smoke ejecutivo', 'Socio parcial: consolidado y CSV solo de sus rutas, rotulado parcial', async () => {
  const db = await baseLimpia()
  const { createOffice, getOfficesExecutiveSummary } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')
  const { officeSummaryCsvRows } = await import('../src/lib/officeExecutive')

  const leticia = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, SU)
  const rutas = []
  for (let i = 1; i <= 4; i++) {
    rutas.push(await createRouteWithAdmins(
      datosRutaSmoke({ officeId: leticia.id, nombre: `Ruta ${i}`, codigo: `RT-00${i}` }), SU))
  }
  for (let i = 0; i < 4; i++) await ventaLista(db, rutas[i].id, `c-${i}`, `s-${i}`)

  await db.users.add({
    id: 'u-socio', tenantId: 't-1', nombre: 'Pablo', email: 'pablo@c.com', password: 'x',
    rol: 'socio', status: 'activo', authorizedRouteIds: [rutas[0].id, rutas[1].id],
    createdAt: '', updatedAt: '',
  } as never)
  const socio = (await db.users.get('u-socio'))!

  const exec = (await getOfficesExecutiveSummary({ user: socio, tenantId: 't-1' }))!
  const fila = exec.rows.find(r => r.officeId === leticia.id)!

  metric('rutas visibles', fila.rutasVisibles)
  metric('alcance', fila.alcance)
  metric('clientes en el consolidado', fila.totals.clientesActivos)
  assert(fila.rutasVisibles === 2 && fila.rutasTotales === 4, 'debe ver 2 de las 4 rutas')
  assert(fila.parcial && fila.alcance === '2/4 rutas', 'el alcance parcial debe declararse')
  assert(fila.totals.clientesActivos === 2, 'el consolidado solo agrega sus rutas')

  const csv = officeSummaryCsvRows({
    office: { nombre: 'Leticia', codigo: undefined, status: 'activa' },
    fecha: exec.fecha, visibles: fila.rutasVisibles, totales: fila.rutasTotales,
    totals: fila.totals, alertas: fila.alertas,
  })
  metric('alcance en CSV', csv[0].Alcance)
  assert(csv[0].Alcance === '2 de 4 rutas autorizadas', 'el CSV debe declarar el alcance parcial')
  assert(csv[0]['Rutas visibles'] === 2, 'el CSV solo contiene lo que el Socio ve')
  db.close()
})

await spec('SMOKE-E4-4', 'Smoke ejecutivo', 'Dashboard de empresa: Leticia, Río y Sin Oficina con totales cuadrados', async () => {
  const db = await baseLimpia()
  const { createOffice, getOfficesExecutiveSummary } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')

  const leticia = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, SU)
  const rio = await createOffice({ tenantId: 't-1', nombre: 'Río' }, SU)
  const centro = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Centro', codigo: 'RT-001' }), SU)
  const puerto = await createRouteWithAdmins(datosRutaSmoke({ officeId: rio.id, nombre: 'Puerto', codigo: 'RT-002' }), SU)
  const suelta = await createRouteWithAdmins(datosRutaSmoke({ nombre: 'Antigua', codigo: 'RT-003' }), SU)
  let n = 0
  for (const r of [centro, puerto, suelta]) { n++; await ventaLista(db, r.id, `c-${n}`, `s-${n}`) }

  const exec = (await getOfficesExecutiveSummary({ user: SU, tenantId: 't-1' }))!

  metric('filas', exec.rows.map(r => `${r.nombre}(${r.rutasVisibles})`).join(', '))
  metric('oficinas visibles', exec.company.oficinasVisibles)
  metric('rutas sin oficina', exec.company.rutasSinOficina)
  assert(exec.rows.length === 3, 'Leticia, Río y Sin Oficina')
  assert(exec.rows[exec.rows.length - 1].nombre === 'Sin Oficina', '"Sin Oficina" va al final')
  assert(exec.company.oficinasVisibles === 2 && exec.company.rutasSinOficina === 1, 'el resumen debe cuadrar')

  const sumaFilas = exec.rows.reduce((s, r) => s + r.totals.clientesActivos, 0)
  metric('clientes: suma de filas vs total', `${sumaFilas} / ${exec.company.totals.clientesActivos}`)
  assert(sumaFilas === exec.company.totals.clientesActivos,
    'el total de empresa debe cuadrar exactamente con la suma de las filas')
  db.close()
})

await spec('SMOKE-E4-5', 'Smoke ejecutivo', 'actividad reciente: aparece la de rutas visibles y no la ajena', async () => {
  const db = await baseLimpia()
  const { createOffice, getOfficeManagementSummary } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')
  const { registerPayment } = await import('../src/services/paymentService')
  const { today } = await import('../src/lib/formatters')

  const leticia = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, SU)
  const centro = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Centro', codigo: 'RT-001' }), SU)
  const norte = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Norte', codigo: 'RT-002' }), SU)
  await ventaLista(db, centro.id, 'c-1', 's-1')
  await ventaLista(db, norte.id, 'c-2', 's-2')

  await db.users.add({
    id: 'u-adm', tenantId: 't-1', nombre: 'Ana', email: 'ana@c.com', password: 'x',
    rol: 'admin', status: 'activo', authorizedRouteIds: [centro.id, norte.id],
    createdAt: '', updatedAt: '',
  } as never)
  const admin = (await db.users.get('u-adm'))!

  // Un pago en CADA ruta: ambos quedan auditados.
  await registerPayment({ saleId: 's-1', requestedAmount: 500, actor: admin, fecha: today() })
  await registerPayment({ saleId: 's-2', requestedAmount: 700, actor: admin, fecha: today() })

  // Ahora el Admin pierde Norte: su actividad debe desaparecer de la vista.
  await db.users.update('u-adm', { authorizedRouteIds: [centro.id] })
  const recortado = (await db.users.get('u-adm'))!
  const r = (await getOfficeManagementSummary({ user: recortado, tenantId: 't-1', officeId: leticia.id }))!

  metric('actividades visibles', r.activity.length)
  metric('rutas en la actividad', [...new Set(r.activity.map(a => a.routeNombre))].join(', '))
  assert(r.activity.length > 0, 'debe verse la actividad de su ruta')
  assert(r.activity.every(a => a.routeId === centro.id),
    'no puede aparecer actividad de una ruta que ya no tiene autorizada')
  assert(r.activity.some(a => a.action === 'REGISTER_PAYMENT'), 'el pago registrado debe aparecer')
  assert(r.activity[0].actorNombre === 'Ana', 'debe resolverse el actor')
  db.close()
})

await spec('SMOKE-E4-6', 'Smoke ejecutivo', 'el CSV exportado coincide con lo que muestra la pantalla', async () => {
  const db = await baseLimpia()
  const { createOffice, getOfficeManagementSummary } = await import('../src/services/officeService')
  const { createRouteWithAdmins } = await import('../src/services/routeService')
  const { officeSummaryCsvRows, officeRoutesCsvRows } = await import('../src/lib/officeExecutive')

  const leticia = await createOffice({ tenantId: 't-1', nombre: 'Leticia', codigo: 'LET' }, SU)
  const centro = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Centro', codigo: 'RT-001' }), SU)
  const norte = await createRouteWithAdmins(datosRutaSmoke({ officeId: leticia.id, nombre: 'Norte', codigo: 'RT-002' }), SU)
  await ventaLista(db, centro.id, 'c-1', 's-1')
  await ventaLista(db, norte.id, 'c-2', 's-2')

  await db.users.add({
    id: 'u-adm', tenantId: 't-1', nombre: 'Ana', email: 'ana@c.com', password: 'x',
    rol: 'admin', status: 'activo', authorizedRouteIds: [centro.id],
    createdAt: '', updatedAt: '',
  } as never)
  const admin = (await db.users.get('u-adm'))!
  const r = (await getOfficeManagementSummary({ user: admin, tenantId: 't-1', officeId: leticia.id }))!

  const resumen = officeSummaryCsvRows({
    office: r.office, fecha: r.fecha, visibles: r.scope.visibles, totales: r.scope.totales,
    totals: r.ops, alertas: r.alerts.length + r.opsAlerts.length,
  })
  const rutasCsv = officeRoutesCsvRows({ office: r.office, fecha: r.fecha, facts: r.routeOps })

  metric('cartera en pantalla', r.ops.carteraActiva)
  metric('cartera en CSV', resumen[0].Cartera)
  metric('filas de rutas en CSV', rutasCsv.length)
  metric('alcance', resumen[0].Alcance)
  assert(resumen[0].Cartera === r.ops.carteraActiva, 'el CSV debe traer la misma cifra que la pantalla')
  assert(resumen[0]['Rutas visibles'] === 1 && rutasCsv.length === 1, 'solo la ruta visible')
  assert(!rutasCsv.some(f => f.Ruta === 'Norte'), 'el CSV no puede incluir una ruta no autorizada')
  assert(resumen[0].Alcance === '1 de 2 rutas autorizadas', 'el CSV declara el alcance parcial')
  db.close()
})

// ############################################################
// INFORME
// ############################################################
const PAD = 22
function line(ch = '─') { return ch.repeat(96) }

console.log('')
console.log(line('═'))
console.log('  RUTACASH — SUITE DE MIGRACIONES (Dexie real sobre fake-indexeddb)')
console.log(line('═'))

let grupo = ''
for (const r of results) {
  if (r.group !== grupo) {
    grupo = r.group
    console.log('')
    console.log(`▌ ${grupo.toUpperCase()}`)
    console.log(line())
  }
  console.log(`[${r.passed ? ' PASS ' : ' FAIL '}] ${r.id.padEnd(PAD)} ${r.desc}`)
  for (const m of r.metrics) console.log(`           · ${m}`)
  if (r.error) console.log(`           ↳ ERROR: ${r.error}`)
}

const fallidos = results.filter(r => !r.passed)
console.log('')
console.log(line('═'))
console.log(`  TOTAL: ${results.length} casos   ${results.length - fallidos.length} PASS   ${fallidos.length} FAIL`)
console.log(line('═'))

if (fallidos.length) {
  console.log('')
  console.log('CASOS FALLIDOS:')
  for (const r of fallidos) console.log(`  · ${r.id} — ${r.desc}\n    ${r.error}`)
  console.log('')
  console.log('SUITE DE MIGRACIONES: FALLÓ')
} else {
  console.log('')
  console.log('SUITE DE MIGRACIONES: TODOS LOS CASOS PASAN')
}

process.exit(fallidos.length === 0 ? 0 : 1)
