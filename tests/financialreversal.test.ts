// ============================================================
// RUTACASH — SUITE ANULACIÓN AUDITABLE DE MOVIMIENTOS (DEXIE REAL)
// ------------------------------------------------------------
//   npm run test:financialreversal
//
// Ajuste del socio 2026-10-02, punto 3: capital, retiros y transferencias
// registrados por error se ANULAN (original conservado + reversión espejo), nunca
// se borran ni se editan. Servicios de producción sobre el singleton `db`
// (Dexie + fake-indexeddb).
//
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import 'fake-indexeddb/auto'
import { db } from '../src/lib/db'
import { today } from '../src/lib/formatters'
import { getCashboxSummary } from '../src/services/cashboxEngine'
import { computeRouteCashReconciliation } from '../src/services/routeCashReconciliation'
import { registerCapital, registerTransfer, registerWithdrawal } from '../src/services/routeFundsService'
import { assignBaseToWorker, returnBaseFromWorker } from '../src/services/cashCustodyService'
import { createDirectSale } from '../src/services/saleRequestService'
import { buildPartnerSummaries } from '../src/services/partnerCashService'
import { generateWeeklySettlement } from '../src/services/weeklySettlementEngine'
import {
  canReverseRouteFund, canReverseTransfer, reverseCapitalMovement, reverseTransfer, reverseWithdrawal,
} from '../src/services/movementReversalService'
import { isReversible, pairReversals, reversalStateOf } from '../src/lib/movementReversal'
import { transferTotalsFor } from '../src/lib/transferTotals'
import { authorizedRouteIdsOf } from '../src/lib/permissions'
import type { Transfer, User } from '../src/models/types'
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
// Escenario: empresa con rutas Barreiro y Centro, un socio y empresa ajena
// ============================================================
const T = 't-adex'
const TB = 't-ajena'
const R1 = 'r-barreiro'
const R2 = 'r-centro'
const RB = 'r-ajena'
const HOY = today()

const base = (id: string, nombre: string, rol: User['rol'], rutas: string[], tenantId = T): User => ({
  id, tenantId, nombre, email: `${id}@adex.co`, password: '1234', rol, status: 'activo',
  authorizedRouteIds: rutas, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as User)

const SUPER = base('u-super', 'Sonia SuperAdmin', 'superadmin', [])
const ADMIN = base('u-admin', 'Andrés Admin', 'admin', [R1, R2])
const ADMIN_CENTRO = base('u-admin-c', 'Carla Admin Centro', 'admin', [R2])
const JUAN = base('u-juan', 'Juan Cobrador', 'cobrador', [R1])
const PEDRO = base('u-pedro', 'Pedro Cobrador', 'cobrador', [R2])
const LAURA = base('u-laura', 'Laura Supervisora', 'supervisor', [R1])
const SECRE = base('u-secre', 'Sergio Secretario', 'secretario', [R1])
const SOCIO = base('u-socio', 'Hernán Socio', 'socio', [R1])
const AJENO = base('u-ajeno', 'Ana Ajena', 'admin', [RB], TB)

async function empresa() {
  await Promise.all(db.tables.map(t => t.clear()))
  await db.tenants.bulkAdd([
    { id: T, nombre: 'ADEX', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z' },
    { id: TB, nombre: 'Ajena', status: 'activa', plan: 'profesional', createdAt: '2026-01-01', cashModelStartAt: '2026-01-01T00:00:00.000Z' },
  ] as never[])
  await db.offices.bulkAdd([
    { id: 'of-a', tenantId: T, nombre: 'Leticia', codigo: 'LET', status: 'activa', createdAt: '', updatedAt: '' },
    { id: 'of-b', tenantId: TB, nombre: 'B', codigo: 'B', status: 'activa', createdAt: '', updatedAt: '' },
  ] as never[])
  const ruta = (id: string, tenantId: string, officeId: string, nombre: string) =>
    ({ id, tenantId, officeId, nombre, codigo: id, status: 'activa', capitalInicial: 0, capitalActual: 0, tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 0, createdAt: '2026-09-01' })
  await db.routes.bulkAdd([ruta(R1, T, 'of-a', 'Barreiro'), ruta(R2, T, 'of-a', 'Centro'), ruta(RB, TB, 'of-b', 'Ajena')] as never[])
  await db.users.bulkAdd([SUPER, ADMIN, ADMIN_CENTRO, JUAN, PEDRO, LAURA, SECRE, SOCIO, AJENO])
}

const saldo = async (routeId: string) => (await getCashboxSummary(routeId)).saldoActual
const conc = (routeId: string) => computeRouteCashReconciliation({ tenantId: T, routeId })
const socioSaldo = async () => {
  const movs = await db.partnerCashMovements.where('tenantId').equals(T).toArray()
  return buildPartnerSummaries([SOCIO], movs).find(g => g.partnerId === SOCIO.id)?.saldo ?? 0
}
const aporteSocio = (valor: number, descripcion: string, extra: Partial<Parameters<typeof registerTransfer>[0]> = {}) =>
  registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'partner', id: SOCIO.id }, destino: { type: 'route', id: R1 }, valor, descripcion, ...extra })
const MOTIVO = 'Error de digitación'

// ============================================================
// Casos
// ============================================================
await spec('FIN-REV-001', 'anular inyección de capital', async () => {
  await empresa()
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 21_000 })
  const mal = await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 21_500 })
  const antes = await saldo(R1)
  const { reversal } = await reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: mal.id, reason: MOTIVO })
  const original = (await db.capitalMovements.get(mal.id))!
  const resumen = await getCashboxSummary(R1)
  metric('saldo antes → después', `${antes} → ${resumen.saldoActual}`)
  metric('original', `${original.valor} · ${reversalStateOf(original)} · reversión ${original.reversalId === reversal.id}`)
  metric('reversión', `${reversal.valor} · ${reversalStateOf(reversal)} · fecha ${reversal.fecha}`)
  assert(original.valor === 21_500 && reversalStateOf(original) === 'anulado', 'el original no quedó intacto y anulado')
  assert(reversal.valor === -21_500 && reversal.reversesId === mal.id && reversal.fecha === HOY, 'la reversión no es el espejo del original')
  assert(antes === 42_500 && resumen.saldoActual === 21_000 && resumen.ingresoCapital === 21_000, 'el saldo neto no es correcto')
  assert((await db.capitalMovements.count()) === 3 && (await conc(R1)).cuadra, 'se perdió historial o la conciliación no cuadra')
})

await spec('FIN-REV-002', 'anular retiro: el dinero vuelve a la ruta', async () => {
  await empresa()
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 100_000 })
  const w = await registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R1, valor: 30_000 })
  const conRetiro = await saldo(R1)
  const { reversal } = await reverseWithdrawal({ actor: ADMIN, tenantId: T, movementId: w.id, reason: 'Retiro duplicado' })
  const r = await getCashboxSummary(R1)
  metric('saldo con retiro → anulado', `${conRetiro} → ${r.saldoActual} · retiros netos ${r.retiros}`)
  assert(conRetiro === 70_000 && r.saldoActual === 100_000 && r.retiros === 0 && reversal.valor === -30_000, 'el efecto inverso del retiro no es correcto')
  assert(reversalStateOf((await db.withdrawals.get(w.id))!) === 'anulado' && (await conc(R1)).cuadra, 'el retiro no quedó anulado o no cuadra')
})

await spec('FIN-REV-003', 'anular transferencia: todas las patas, atómico', async () => {
  await empresa()
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 200_000 })
  // Ruta → Ruta
  const { transfer: rr } = await registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'route', id: R1 }, destino: { type: 'route', id: R2 }, valor: 50_000 })
  await reverseTransfer({ actor: ADMIN, tenantId: T, movementId: rr.id, reason: 'Ruta equivocada' })
  const s1 = await saldo(R1)
  const s2 = await saldo(R2)
  metric('Ruta→Ruta anulada', `Barreiro ${s1} · Centro ${s2}`)
  assert(s1 === 200_000 && s2 === 0, 'origen o destino no se restauró')
  // Socio → Ruta (pata en Caja socios)
  const { transfer: sr, partnerMovements } = await aporteSocio(80_000, 'aporte')
  const res = await reverseTransfer({ actor: ADMIN, tenantId: T, movementId: sr.id, reason: MOTIVO })
  const pata = (await db.partnerCashMovements.get(partnerMovements[0].id))!
  metric('Socio→Ruta anulada', `Barreiro ${await saldo(R1)} · saldo socio ${await socioSaldo()} · patas socio revertidas ${res.partnerReversals.length}`)
  assert(await saldo(R1) === 200_000 && await socioSaldo() === 0, 'la ruta o la Caja socios no se restauró')
  assert(reversalStateOf(pata) === 'anulado' && res.partnerReversals[0].reversesId === pata.id && res.partnerReversals[0].relatedTransferId === res.reversal.id, 'la pata de Caja socios quedó huérfana')
  // Entregada en mano a Juan → la custodia también se revierte.
  const { transfer: mano, custody } = await aporteSocio(60_000, 'en mano', { entregarA: { userId: JUAN.id } })
  const juanAntes = (await conc(R1)).personas.find(p => p.userId === JUAN.id)?.posicion
  const resMano = await reverseTransfer({ actor: ADMIN, tenantId: T, movementId: mano.id, reason: MOTIVO })
  const c = await conc(R1)
  const juanDespues = c.personas.find(p => p.userId === JUAN.id)?.posicion ?? 0
  metric('en mano: Juan antes → después', `${juanAntes} → ${juanDespues} · custodia revertida ${resMano.custodyReversals.length} · cuadra ${c.cuadra}`)
  assert(juanAntes === 60_000 && juanDespues === 0 && resMano.custodyReversals[0].reversesId === custody!.id, 'la custodia en mano no se revirtió')
  assert(c.cuadra && c.noAsignado === 200_000, 'la conciliación no cuadra tras revertir con custodia')
  // Juan ya devolvió la Base → su custodia no existe: se rechaza, sin cambios.
  const { transfer: mano2 } = await aporteSocio(10_000, 'en mano 2', { entregarA: { userId: JUAN.id } })
  await returnBaseFromWorker({ actor: ADMIN, tenantId: T, routeId: R1, fromUserId: JUAN.id, amount: 10_000, motivo: 'Devolución' })
  const sinCustodia = await rechazo(() => reverseTransfer({ actor: ADMIN, tenantId: T, movementId: mano2.id, reason: MOTIVO }))
  metric('en mano ya devuelta', sinCustodia)
  assert(/ya no lo tiene/.test(sinCustodia) && isReversible((await db.transfers.get(mano2.id))!), 'se revirtió custodia que la persona ya no tiene')
})

await spec('FIN-REV-004', 'motivo obligatorio', async () => {
  await empresa()
  const m = await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 10_000 })
  const intentos = await Promise.all(['', '   ', undefined as unknown as string, '\n\t'].map(r =>
    rechazo(() => reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: m.id, reason: r }))))
  metric('rechazos', intentos.join(' · '))
  assert(intentos.every(r => /motivo/.test(r)), 'se aceptó una anulación sin motivo')
  assert((await db.capitalMovements.count()) === 1 && isReversible((await db.capitalMovements.get(m.id))!), 'se escribió algo sin motivo')
  const { original } = await reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: m.id, reason: '  Valor   duplicado ' })
  metric('motivo persistido', `"${original.reversalReason}"`)
  assert(original.reversalReason === 'Valor duplicado', 'el motivo no se persistió normalizado')
})

await spec('FIN-REV-005', 'doble anulación rechazada', async () => {
  await empresa()
  const m = await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 10_000 })
  await reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: m.id, reason: MOTIVO })
  const segunda = await rechazo(() => reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: m.id, reason: MOTIVO }))
  const reversiones = (await db.capitalMovements.toArray()).filter(x => x.reversesId === m.id)
  metric('segunda', segunda)
  assert(/ya fue anulado/.test(segunda) && reversiones.length === 1 && await saldo(R1) === 0, 'la segunda anulación generó otra reversión')
})

await spec('FIN-REV-006', 'permisos: solo Admin/SuperAdmin con la capacidad del movimiento', async () => {
  await empresa()
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 300_000 })
  const cap = await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 1_000 })
  const w = await registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R1, valor: 1_000 })
  const { transfer: t } = await aporteSocio(1_000, 'x')
  const res: string[] = []
  for (const u of [JUAN, LAURA, SECRE, SOCIO]) {
    const r = await Promise.all([
      rechazo(() => reverseCapitalMovement({ actor: u, tenantId: T, movementId: cap.id, reason: MOTIVO })),
      rechazo(() => reverseWithdrawal({ actor: u, tenantId: T, movementId: w.id, reason: MOTIVO })),
      rechazo(() => reverseTransfer({ actor: u, tenantId: T, movementId: t.id, reason: MOTIVO })),
    ])
    const ui = canReverseRouteFund(u, cap) || canReverseRouteFund(u, w) || canReverseTransfer(u, t, () => [R1])
    res.push(`${u.rol}: ${r.every(x => x !== 'ACEPTADO') ? 'rechazado' : 'ACEPTADO'} · botón ${ui ? 'VISIBLE' : 'oculto'}`)
    assert(r.every(x => x !== 'ACEPTADO') && !ui, `${u.rol} pudo anular`)
  }
  const sinActor = await rechazo(() => reverseCapitalMovement({ actor: null, tenantId: T, movementId: cap.id, reason: MOTIVO }))
  await reverseCapitalMovement({ actor: SUPER, tenantId: T, movementId: cap.id, reason: MOTIVO })
  await reverseWithdrawal({ actor: ADMIN, tenantId: T, movementId: w.id, reason: MOTIVO })
  for (const r of res) metric('rol', r)
  metric('sin usuario', sinActor)
  metric('SuperAdmin / Admin', 'anulan')
  assert(sinActor !== 'ACEPTADO', 'se anuló sin usuario')
})

await spec('FIN-REV-007', 'movimientos históricos (sin campos nuevos)', async () => {
  await empresa()
  // Registros previos a esta ronda: sin campos de anulación; transferencia antigua sin origenType.
  await db.capitalMovements.add({ id: 'cap-viejo', tenantId: T, routeId: R1, tipo: 'ingresoCapital', valor: 500_000, fecha: '2026-06-01', userId: ADMIN.id, createdAt: '2026-06-01T10:00:00.000Z' })
  await db.transfers.add({ id: 'tr-vieja', tenantId: T, routeOrigenId: R1, routeDestinoId: R2, valor: 100_000, fecha: '2026-06-02', userId: ADMIN.id, createdAt: '2026-06-02T10:00:00.000Z' } as Transfer)
  const estados = `${reversalStateOf((await db.capitalMovements.get('cap-viejo'))!)} / ${reversalStateOf((await db.transfers.get('tr-vieja'))!)}`
  const antes = `${await saldo(R1)} / ${await saldo(R2)}`
  await reverseTransfer({ actor: ADMIN, tenantId: T, movementId: 'tr-vieja', reason: 'Histórico erróneo' })
  const despues = `${await saldo(R1)} / ${await saldo(R2)}`
  metric('estado leído', estados)
  metric('Barreiro / Centro antes → después', `${antes} → ${despues}`)
  assert(estados === 'vigente / vigente', 'un histórico no se lee como vigente')
  assert(antes === '400000 / 100000' && despues === '500000 / 0', 'el histórico no se anuló correctamente')
  const rev = (await db.transfers.toArray()).find(t => t.reversesId === 'tr-vieja')!
  assert(rev.origenType === undefined && rev.routeOrigenId === R1 && rev.valor === -100_000, 'la reversión no conserva la forma del histórico')
})

await spec('FIN-REV-008', 'auditoría: quién, cuándo, motivo y vínculo', async () => {
  await empresa()
  const m = await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 10_000 })
  const { original, reversal } = await reverseCapitalMovement({ actor: SUPER, tenantId: T, movementId: m.id, reason: 'Valor duplicado' })
  const log = (await db.auditLogs.where('entityId').equals(m.id).toArray()).find(l => l.action === 'MOVEMENT_REVERSED')
  metric('original', `por ${original.reversedByUserId} · ${original.reversedAt} · "${original.reversalReason}" · → ${original.reversalId}`)
  metric('reversión', `por ${reversal.userId} · ${reversal.createdAt} · "${reversal.reversalReason}" · ← ${reversal.reversesId}`)
  metric('bitácora', log ? `${log.action} · ${log.motivo} · ${JSON.stringify(log.after)}` : 'SIN REGISTRO')
  assert(original.reversedByUserId === SUPER.id && !!original.reversedAt && original.reversalReason === 'Valor duplicado', 'falta quién/cuándo/motivo')
  assert(original.reversalId === reversal.id && reversal.reversesId === original.id && reversal.userId === SUPER.id, 'falta el vínculo original↔reversión')
  assert(log && log.motivo === 'Valor duplicado' && (log.after as { reversalId: string }).reversalId === reversal.id, 'no quedó en la bitácora')
})

await spec('FIN-REV-009', 'una reversión no es anulable', async () => {
  await empresa()
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 100_000 })
  const w = await registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R1, valor: 10_000 })
  const { reversal } = await reverseWithdrawal({ actor: ADMIN, tenantId: T, movementId: w.id, reason: MOTIVO })
  const { transfer } = await aporteSocio(5_000, 'x')
  const rt = await reverseTransfer({ actor: ADMIN, tenantId: T, movementId: transfer.id, reason: MOTIVO })
  const a = await rechazo(() => reverseWithdrawal({ actor: SUPER, tenantId: T, movementId: reversal.id, reason: 'deshacer' }))
  const b = await rechazo(() => reverseTransfer({ actor: SUPER, tenantId: T, movementId: rt.reversal.id, reason: 'deshacer' }))
  metric('anular reversión de retiro', a)
  metric('anular reversión de transferencia', b)
  assert(/reversión no se puede anular/.test(a) && /reversión no se puede anular/.test(b), 'se permitió anular una reversión')
  assert(!canReverseRouteFund(SUPER, reversal) && !canReverseTransfer(SUPER, rt.reversal, () => [R1]), 'la UI ofrece anular una reversión')
  assert((await db.withdrawals.count()) === 2 && (await db.transfers.count()) === 2, 'se creó una cadena de reversiones')
})

await spec('FIN-REV-010', 'atomicidad: fallo a mitad → sin cambios parciales', async () => {
  await empresa()
  const { transfer } = await aporteSocio(70_000, 'aporte')
  const foto = async () => JSON.stringify({
    t: await db.transfers.toArray(), p: await db.partnerCashMovements.toArray(), c: await db.cashCustodyMovements.toArray(),
  })
  const antes = await foto()
  // Fallo controlado: la escritura de la pata de Caja socios lanza dentro de la transacción.
  const falla = () => { throw new Error('fallo inyectado en Caja socios') }
  db.partnerCashMovements.hook('creating', falla)
  const r = await rechazo(() => reverseTransfer({ actor: ADMIN, tenantId: T, movementId: transfer.id, reason: MOTIVO }))
  db.partnerCashMovements.hook('creating').unsubscribe(falla)
  const despues = await foto()
  metric('resultado', r)
  metric('estado intacto', antes === despues)
  assert(r !== 'ACEPTADO' && antes === despues, 'quedó un estado parcial tras el fallo')
  assert(await saldo(R1) === 70_000 && await socioSaldo() === -70_000, 'los saldos cambiaron tras el fallo')
  await reverseTransfer({ actor: ADMIN, tenantId: T, movementId: transfer.id, reason: MOTIVO })
  metric('reintento sin fallo', `Barreiro ${await saldo(R1)} · socio ${await socioSaldo()}`)
  assert(await saldo(R1) === 0 && await socioSaldo() === 0, 'el reintento no revirtió todo')
})

await spec('FIN-REV-011', 'doble ejecución concurrente → una sola reversión', async () => {
  await empresa()
  const m = await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 50_000 })
  const { transfer } = await aporteSocio(20_000, 'x')
  // Un retiro devuelve dinero al anularse: ningún control de fondos frena el segundo
  // intento; solo la validación de estado dentro de la transacción.
  const w = await registerWithdrawal({ actor: ADMIN, tenantId: T, routeId: R1, valor: 5_000 })
  const [e, f] = await Promise.all([
    rechazo(() => reverseWithdrawal({ actor: ADMIN, tenantId: T, movementId: w.id, reason: MOTIVO })),
    rechazo(() => reverseWithdrawal({ actor: SUPER, tenantId: T, movementId: w.id, reason: MOTIVO })),
  ])
  const revW = (await db.withdrawals.toArray()).filter(x => x.reversesId === w.id).length
  metric('retiro', `${e} | ${f} → ${revW} reversión(es)`)
  assert([e, f].filter(x => x === 'ACEPTADO').length === 1 && revW === 1, 'retiro: doble reversión')
  const [a, b, c, d] = await Promise.all([
    rechazo(() => reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: m.id, reason: MOTIVO })),
    rechazo(() => reverseCapitalMovement({ actor: SUPER, tenantId: T, movementId: m.id, reason: MOTIVO })),
    rechazo(() => reverseTransfer({ actor: ADMIN, tenantId: T, movementId: transfer.id, reason: MOTIVO })),
    rechazo(() => reverseTransfer({ actor: SUPER, tenantId: T, movementId: transfer.id, reason: MOTIVO })),
  ])
  const revCap = (await db.capitalMovements.toArray()).filter(x => x.reversesId === m.id).length
  const revTr = (await db.transfers.toArray()).filter(x => x.reversesId === transfer.id).length
  const revSocio = (await db.partnerCashMovements.toArray()).filter(x => x.reversesId).length
  metric('capital', `${a} | ${b} → ${revCap} reversión(es)`)
  metric('transferencia', `${c} | ${d} → ${revTr} reversión(es), ${revSocio} pata(s) socio`)
  assert([a, b].filter(x => x === 'ACEPTADO').length === 1 && revCap === 1, 'capital: doble reversión')
  assert([c, d].filter(x => x === 'ACEPTADO').length === 1 && revTr === 1 && revSocio === 1, 'transferencia: doble reversión')
  assert(await saldo(R1) === 0 && await socioSaldo() === 0, 'los saldos no quedaron netos')
  // La UI además bloquea el doble clic (ref + botón deshabilitado).
  const ui = fs.readFileSync('src/components/ui/MovementReversal.tsx', 'utf8')
  assert(/if \(!motivo \|\| enCurso\.current\) return/.test(ui) && /disabled=\{!motivo \|\| working\}/.test(ui), 'la UI no bloquea el doble envío')
})

await spec('FIN-REV-012', 'UI/listado: el original sigue visible como anulado', async () => {
  await empresa()
  const a = await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 21_000 })
  const b = await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 21_500 })
  await reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: b.id, reason: MOTIVO })
  const filas = pairReversals((await db.capitalMovements.toArray()).sort((x, y) => x.createdAt.localeCompare(y.createdAt)))
  metric('filas', filas.map(f => `${f.movement.valor} ${reversalStateOf(f.movement)}${f.reversal ? ` (reversión ${f.reversal.valor})` : ''}`).join(' · '))
  assert(filas.length === 2 && filas[0].movement.id === a.id && filas[1].movement.id === b.id, 'el original desapareció o la reversión salió suelta')
  assert(reversalStateOf(filas[1].movement) === 'anulado' && filas[1].reversal?.valor === -21_500, 'el anulado no muestra su reversión')
  for (const p of ['src/pages/admin/TransfersPage.tsx', 'src/pages/admin/CapitalPage.tsx', 'src/pages/admin/WithdrawalsPage.tsx']) {
    const src = fs.readFileSync(p, 'utf8')
    const ok = src.includes('pairReversals(') && src.includes('<AnnulledBadge />') && src.includes('<ReversalDetail') && src.includes('<ReverseButton') && !/Eliminar/.test(src)
    metric(p.split('/').pop()!, ok ? 'anulado visible + acción Anular (sin Eliminar)' : 'FALTA')
    assert(ok, `${p}: el listado no muestra la anulación`)
  }
  const comp = fs.readFileSync('src/components/ui/MovementReversal.tsx', 'utf8')
  assert(comp.includes('title="Anular movimiento"') && comp.includes('label="Motivo" required'), 'el modal no pide motivo ni dice "Anular movimiento"')
})

await spec('FIN-REV-013', 'caso real: Barreiro 21.000 + 21.500, anular 21.500', async () => {
  await empresa()
  // Igual que la captura del socio: dos aportes Socio → Barreiro.
  await aporteSocio(21_000, 'base para créditos')
  const { transfer: mal } = await aporteSocio(21_500, 'base préstamos')
  const vista = async () => transferTotalsFor(await db.transfers.where('tenantId').equals(T).toArray(), 'route', R1)
  const antes = await vista()
  await reverseTransfer({ actor: ADMIN, tenantId: T, movementId: mal.id, reason: 'Valor duplicado' })
  const despues = await vista()
  const filas = pairReversals(despues.transfers.sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
  metric('antes', `entrante ${antes.entrante} · neto ${antes.neto} · ${antes.cantidad} mov.`)
  metric('después', `entrante ${despues.entrante} · saliente ${despues.saliente} · neto ${despues.neto} · ${despues.cantidad} mov.`)
  metric('historial', filas.map(f => `${f.movement.descripcion} ${f.movement.valor} ${reversalStateOf(f.movement)}`).join(' · '))
  assert(antes.entrante === 42_500 && antes.neto === 42_500, 'el estado inicial no coincide con el reportado')
  assert(despues.entrante === 21_000 && despues.neto === 21_000 && despues.saliente === 0, 'los totales no muestran el efecto vigente')
  assert(despues.transfers.length === 3 && filas.length === 2 && reversalStateOf(filas[1].movement) === 'anulado', 'se perdió el historial del 21.500')
  assert(await saldo(R1) === 21_000 && await socioSaldo() === -21_000, 'Base o Caja socios no reflejan la anulación')
})

await spec('FIN-REV-014', 'aislamiento de empresa y ruta', async () => {
  await empresa()
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 100_000 })
  const cap = await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 5_000 })
  const { transfer } = await registerTransfer({ actor: ADMIN, tenantId: T, origen: { type: 'route', id: R1 }, destino: { type: 'route', id: R2 }, valor: 1_000 })
  const intentos: [string, () => Promise<unknown>][] = [
    ['Admin de Centro → capital Barreiro', () => reverseCapitalMovement({ actor: ADMIN_CENTRO, tenantId: T, movementId: cap.id, reason: MOTIVO })],
    ['Admin de Centro → transferencia Barreiro→Centro', () => reverseTransfer({ actor: ADMIN_CENTRO, tenantId: T, movementId: transfer.id, reason: MOTIVO })],
    ['empresa ajena con su tenant', () => reverseCapitalMovement({ actor: AJENO, tenantId: TB, movementId: cap.id, reason: MOTIVO })],
    ['empresa ajena con tenant ajeno', () => reverseCapitalMovement({ actor: AJENO, tenantId: T, movementId: cap.id, reason: MOTIVO })],
  ]
  for (const [k, fn] of intentos) {
    const r = await rechazo(fn)
    metric(k, r)
    assert(r !== 'ACEPTADO', `${k}: aceptado`)
  }
  const partnerRoutes = (id: string) => authorizedRouteIdsOf([SOCIO].find(u => u.id === id))
  assert(!canReverseRouteFund(ADMIN_CENTRO, cap) && !canReverseTransfer(ADMIN_CENTRO, transfer, partnerRoutes), 'la UI ofrece anular fuera de alcance')
  assert(isReversible((await db.capitalMovements.get(cap.id))!) && isReversible((await db.transfers.get(transfer.id))!), 'un rechazo modificó el movimiento')
})

await spec('FIN-REV-015', 'no regresión Base / conciliación / liquidación', async () => {
  await empresa()
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 100_000 })
  const extra = await registerCapital({ actor: ADMIN, tenantId: T, routeId: R1, valor: 50_000 })
  // El dinero ya salió en un préstamo: anular el capital no puede dejar la caja en negativo.
  await db.clients.add({ id: 'cli-1', tenantId: T, routeId: R1, nombre: 'Cliente', documento: '1', status: 'activo', createdAt: '' } as never)
  await createDirectSale({ tenantId: T, routeId: R1, clientId: 'cli-1', createdByUserId: ADMIN.id, valorVenta: 120_000, tasaInteres: 20, numeroCuotas: 10, frecuenciaPago: 'diaria', fechaInicio: HOY, paymentDays: [0, 1, 2, 3, 4, 5, 6] }, ADMIN)
  const sinFondos = await rechazo(() => reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: extra.id, reason: MOTIVO }))
  metric('anular capital ya prestado', sinFondos)
  assert(/no tiene ese dinero disponible/.test(sinFondos) && isReversible((await db.capitalMovements.get(extra.id))!), 'se dejó la Base en negativo')
  // Base entregada en mano: la anulación no toca efectivo bajo custodia de nadie.
  await registerCapital({ actor: ADMIN, tenantId: T, routeId: R2, valor: 40_000 })
  const c2 = await registerCapital({ actor: ADMIN, tenantId: T, routeId: R2, valor: 30_000 })
  await assignBaseToWorker({ actor: ADMIN, tenantId: T, routeId: R2, recipientUserId: PEDRO.id, amount: 60_000, motivo: 'Base' })
  const custodia = await rechazo(() => reverseCapitalMovement({ actor: ADMIN, tenantId: T, movementId: c2.id, reason: MOTIVO }))
  metric('anular capital entregado como Base a Pedro', custodia)
  assert(/no tiene ese dinero disponible/.test(custodia) && isReversible((await db.capitalMovements.get(c2.id))!), 'se tocó efectivo bajo custodia')
  // Ningún agregador cambió: el motor sigue siendo la suma de siempre y la conciliación cuadra.
  const motor = fs.readFileSync('src/services/cashboxEngine.ts', 'utf8')
  const sinFiltros = !/reversalId|reversesId|reversalStateOf/.test(motor) && !/reversalId|reversesId/.test(fs.readFileSync('src/services/routeCashReconciliation.ts', 'utf8'))
  const semana = await generateWeeklySettlement({ tenantId: T, routeId: R1, semanaInicio: HOY, semanaFin: HOY } as never)
  metric('agregadores sin filtros por estado', sinFiltros)
  metric('liquidación del día Barreiro', `capital ${semana.ingresoCapital} · préstamos ${semana.prestamosEntregados} · saldo ${semana.saldoFinal}`)
  metric('conciliación Barreiro / Centro', `${(await conc(R1)).cuadra} / ${(await conc(R2)).cuadra}`)
  assert(sinFiltros && (await conc(R1)).cuadra && (await conc(R2)).cuadra, 'cambió una definición financiera o no cuadra')
  assert(semana.ingresoCapital === 150_000 && semana.saldoFinal === 30_000, 'la liquidación no refleja las reglas vigentes')
})

// ============================================================
// Informe
// ============================================================
const line = (ch = '─') => ch.repeat(96)
console.log('')
console.log(line('═'))
console.log('  RUTACASH — SUITE ANULACIÓN AUDITABLE DE MOVIMIENTOS (Dexie real)')
console.log(line('═'))
for (const r of results) {
  console.log(`[${r.passed ? ' PASS ' : ' FAIL '}] ${r.id.padEnd(12)} ${r.desc}`)
  for (const m of r.metrics) console.log(`           · ${m}`)
  if (r.error) console.log(`           ↳ ERROR: ${r.error}`)
}
const fallidos = results.filter(r => !r.passed)
console.log('')
console.log(line('═'))
console.log(`  TOTAL: ${results.length} casos   ${results.length - fallidos.length} PASS   ${fallidos.length} FAIL`)
console.log(line('═'))
console.log(fallidos.length ? 'SUITE ANULACIÓN DE MOVIMIENTOS: FALLÓ' : 'SUITE ANULACIÓN DE MOVIMIENTOS: TODOS LOS CASOS PASAN')
process.exit(fallidos.length === 0 ? 0 : 1)
