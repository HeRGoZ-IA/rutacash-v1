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
