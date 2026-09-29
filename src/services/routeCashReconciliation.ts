// ============================================================
// CONCILIACIÓN ROUTE ↔ PERSONAS — ¿DÓNDE ESTÁ EL EFECTIVO? (solo lectura)
// ------------------------------------------------------------
// Responde, para UNA Route y en UN instante:
//
//   · cuánto efectivo debe tener la Route según su libro (capital, transferencias,
//     retiros, cobros, desembolsos, gastos),
//   · cuánto está en manos de cada persona (Cobrador / Supervisor) — su posición
//     de cuadre: arrastre + Base neta + recaudo − desembolso − gasto,
//   · cuánto queda sin asignar (caja de la Route / oficina),
//   · faltantes y sobrantes vigentes,
//   · y, por separado, la cartera (deuda de clientes), que NO es efectivo.
//
// IDENTIDAD (lo que garantiza que no se duplica dinero):
//
//     libro = noAsignado + Σ posiciónPersonal
//
// `noAsignado` se calcula de DOS maneras independientes y deben coincidir:
//   (a) libro − Σ posiciónPersonal
//   (b) estructural + operación no personal − Base entregada neta
//       + efectivo entregado en cuadres − sobrantes registrados
// (b) sale de sumar cuadre a cuadre la fórmula de `cashSettlementRules`:
// posición = Σ flujos personales − Σ entregado + Σ sobrante (el sobrante no se
// arrastra). Si (a) ≠ (b) algo se contó dos veces u omitió: `cuadra = false`.
//
// El SOBRANTE es efectivo físico que entró sin estar en el libro: se informa
// aparte (`efectivoFisicoNoAsignado = noAsignado + sobrantes`) y nunca se convierte
// en crédito de nadie.
//
// HISTÓRICO: todo movimiento anterior al inicio del modelo personal
// (`cashModelStartAt`) se presume en la caja de la Route — no se atribuye a nadie.
// Una posición NEGATIVA señala efectivo que una persona entregó sin Base
// registrada (típicamente, Base informal anterior a v15): se muestra, no se oculta.
// ============================================================
import { db, type RutaCashDB } from '@/lib/db'
import { nowISO } from '@/lib/formatters'
import { can } from '@/lib/permissions'
import { hasPersonalCashbox } from '@/lib/collectorAttribution'
import { getAssignedRouteIds } from '@/lib/roles'
import { isActiveCashSettlement, pendingShortages } from '@/lib/cashSettlementRules'
import { assertCan } from '@/services/authz'
import { getCashboxSummary, getCollectorCashSummary } from '@/services/cashboxEngine'
import { cashModelStartOf, personalCashPosition } from '@/services/cashSettlementService'
import type { CapitalMovement, CashCustodyMovement, Transfer, User, Withdrawal } from '@/models/types'

/** Libro sin cortes de fecha: todo lo registrado (también ventas con inicio futuro). */
const DESDE_SIEMPRE = '0000-01-01'
const SIN_TOPE = '9999-12-31'

export interface PersonCashPosition {
  userId: string
  nombre: string
  rol: User['rol']
  status: User['status']
  /** Asignada hoy a la Route (una persona desasignada puede seguir teniendo efectivo). */
  asignada: boolean
  cicloDesde: string
  ultimoCuadreId?: string
  arrastreAnterior: number
  baseRecibida: number
  baseDevuelta: number
  recaudado: number
  desembolsado: number
  gastos: number
  /** Efectivo que debería tener en mano AHORA (= esperado de su cuadre). */
  posicion: number
}

export interface RouteCashReconciliation {
  tenantId: string
  routeId: string
  routeName: string
  hasta: string
  modelStart: string
  baseCustodyStartAt?: string
  libro: {
    capital: number
    transferenciasEntrada: number
    transferenciasSalida: number
    retiros: number
    cobros: number
    desembolsos: number
    gastos: number
    saldo: number
  }
  /** capital + transferencias entrantes − salientes − retiros. */
  estructural: number
  personas: PersonCashPosition[]
  enPersonas: number
  /** (a) libro − Σ posiciones. */
  noAsignado: number
  /** (b) descomposición independiente de `noAsignado`. */
  explicacionNoAsignado: {
    estructural: number
    operacionNoPersonal: number
    baseEntregadaNeta: number
    entregadoEnCuadres: number
    sobrantesRegistrados: number
    total: number
  }
  cuadra: boolean
  /** noAsignado + sobrantes: efectivo físico que debería haber en la caja de la Route. */
  efectivoFisicoNoAsignado: number
  /** Lo que se puede entregar, transferir o retirar sin tocar efectivo ajeno. */
  disponible: number
  faltantes: { userId: string; nombre: string; monto: number; settlementId: string }[]
  sobrantes: { userId: string; nombre: string; monto: number; settlementId: string; motivo?: string }[]
  cuadresVigentes: number
  cartera: { carteraEnCalle: number; ventasActivas: number }
  movimientosEstructurales: {
    capital: CapitalMovement[]
    transferencias: Transfer[]
    retiros: Withdrawal[]
  }
  custodia: CashCustodyMovement[]
}

/**
 * Cálculo puro de la conciliación (sin permisos). Lo usan la vista, los servicios
 * de custodia y de fondos (dentro de su transacción, para validar `disponible`).
 */
export async function computeRouteCashReconciliation(
  params: { tenantId: string; routeId: string; hasta?: string },
  database: RutaCashDB = db,
): Promise<RouteCashReconciliation> {
  const { tenantId, routeId } = params
  const hasta = params.hasta ?? nowISO()
  const route = await database.routes.get(routeId)
  if (!route || route.tenantId !== tenantId) throw new Error('La ruta no existe en esta empresa.')
  const tenant = await database.tenants.get(tenantId)
  const modelStart = await cashModelStartOf(tenantId, database)

  const libroRaw = await getCashboxSummary(routeId, DESDE_SIEMPRE, SIN_TOPE, database)
  const libro = {
    capital: libroRaw.ingresoCapital,
    transferenciasEntrada: libroRaw.transferenciasEntradas,
    transferenciasSalida: libroRaw.transferenciasSalidas,
    retiros: libroRaw.retiros,
    cobros: libroRaw.cobros,
    desembolsos: libroRaw.prestamosEntregados,
    gastos: libroRaw.gastos,
    saldo: libroRaw.saldoActual,
  }
  const estructural = libro.capital + libro.transferenciasEntrada - libro.transferenciasSalida - libro.retiros

  const [users, custodia, settlements, capital, tIn, tOut, retiros, sales] = await Promise.all([
    database.users.where('tenantId').equals(tenantId).toArray(),
    database.cashCustodyMovements.where('routeId').equals(routeId).toArray(),
    database.cashSettlements.where('routeId').equals(routeId).toArray(),
    database.capitalMovements.where('routeId').equals(routeId).toArray(),
    database.transfers.where('routeDestinoId').equals(routeId).toArray(),
    database.transfers.where('routeOrigenId').equals(routeId).toArray(),
    database.withdrawals.where('routeId').equals(routeId).toArray(),
    database.sales.where('routeId').equals(routeId).toArray(),
  ])
  const custodiaEmpresa = custodia.filter(m => m.tenantId === tenantId && m.createdAt <= hasta)
  const vigentes = settlements.filter(s => s.tenantId === tenantId && isActiveCashSettlement(s) && s.hasta <= hasta)

  // Personas: quien tiene caja personal, o quien ya figura en cuadres/custodia de la Route.
  const conRastro = new Set<string>([
    ...vigentes.map(s => s.userId),
    ...custodiaEmpresa.flatMap(m => [m.fromUserId, m.toUserId].filter(Boolean) as string[]),
  ])
  const candidatos = users.filter(u => hasPersonalCashbox(u.rol) || conRastro.has(u.id))

  const personas: PersonCashPosition[] = []
  let flujosPersonales = 0
  for (const u of candidatos) {
    const pos = await personalCashPosition({ tenantId, routeId, userId: u.id, hasta }, database)
    // Flujos operativos de la persona desde el inicio del modelo (para la vía (b)).
    const total = await getCollectorCashSummary({ routeId, userId: u.id, desde: modelStart, hasta, modelStart }, database)
    flujosPersonales += total.recaudado - total.desembolsado - total.gastos
    const tieneAlgo = pos.esperado !== 0 || pos.previo || total.recaudado || total.desembolsado || total.gastos || total.baseRecibida || total.baseDevuelta
    const asignada = getAssignedRouteIds(u).includes(routeId)
    if (!tieneAlgo && !asignada) continue
    personas.push({
      userId: u.id, nombre: u.nombre, rol: u.rol, status: u.status, asignada,
      cicloDesde: pos.desde, ultimoCuadreId: pos.previo?.id,
      arrastreAnterior: pos.arrastreAnterior, baseRecibida: pos.baseRecibida, baseDevuelta: pos.baseDevuelta,
      recaudado: pos.recaudado, desembolsado: pos.desembolsado, gastos: pos.gastos, posicion: pos.esperado,
    })
  }
  personas.sort((a, b) => a.nombre.localeCompare(b.nombre))
  const enPersonas = personas.reduce((s, p) => s + p.posicion, 0)
  const noAsignado = libro.saldo - enPersonas

  const baseEntregadaNeta = custodiaEmpresa.reduce((s, m) =>
    s + (m.tipo === 'BASE_ASSIGNMENT' ? m.amount : m.tipo === 'BASE_RETURN' ? -m.amount : 0), 0)
  const entregadoEnCuadres = vigentes.reduce((s, c) => s + c.entregado, 0)
  const sobrantesRegistrados = vigentes.reduce((s, c) => s + c.sobrante, 0)
  const operacionNoPersonal = (libro.cobros - libro.desembolsos - libro.gastos) - flujosPersonales
  const explicacionTotal = estructural + operacionNoPersonal - baseEntregadaNeta + entregadoEnCuadres - sobrantesRegistrados

  const nombre = (id: string) => users.find(u => u.id === id)?.nombre ?? id
  const ultimos = pendingShortages(vigentes)
  const carteraActivas = sales.filter(s => s.status === 'activa' && s.disbursementStatus !== 'pendiente')

  return {
    tenantId, routeId, routeName: route.nombre, hasta, modelStart,
    baseCustodyStartAt: tenant?.baseCustodyStartAt,
    libro, estructural, personas, enPersonas, noAsignado,
    explicacionNoAsignado: {
      estructural, operacionNoPersonal, baseEntregadaNeta, entregadoEnCuadres, sobrantesRegistrados,
      total: explicacionTotal,
    },
    cuadra: explicacionTotal === noAsignado,
    efectivoFisicoNoAsignado: noAsignado + sobrantesRegistrados,
    disponible: Math.max(0, Math.min(libro.saldo, noAsignado)),
    faltantes: ultimos.map(s => ({ userId: s.userId, nombre: nombre(s.userId), monto: s.faltante, settlementId: s.id })),
    sobrantes: vigentes.filter(s => s.sobrante > 0)
      .map(s => ({ userId: s.userId, nombre: nombre(s.userId), monto: s.sobrante, settlementId: s.id, motivo: s.motivo })),
    cuadresVigentes: vigentes.length,
    cartera: {
      carteraEnCalle: carteraActivas.reduce((s, v) => s + Math.max(0, v.saldo), 0),
      ventasActivas: carteraActivas.length,
    },
    movimientosEstructurales: {
      capital: capital.filter(m => m.tenantId === tenantId).sort((a, b) => b.fecha.localeCompare(a.fecha)),
      transferencias: [...tIn, ...tOut].filter(t => t.tenantId === tenantId).sort((a, b) => b.fecha.localeCompare(a.fecha)),
      retiros: retiros.filter(w => w.tenantId === tenantId).sort((a, b) => b.fecha.localeCompare(a.fecha)),
    },
    custodia: custodiaEmpresa.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }
}

/**
 * Conciliación con permiso: `cashbox.viewRoute` sobre la Route (Admin, Super
 * Admin, Supervisor, Socio en consulta). El Cobrador no ve la caja de la Route.
 */
export async function getRouteCashReconciliation(
  params: { actor: User | null | undefined; tenantId: string; routeId: string },
  database: RutaCashDB = db,
): Promise<RouteCashReconciliation> {
  assertCan(params.actor, 'cashbox.viewRoute', { routeId: params.routeId, tenantId: params.tenantId })
  return computeRouteCashReconciliation({ tenantId: params.tenantId, routeId: params.routeId }, database)
}

/** ¿El actor puede consultar la conciliación de la Route? (para la UI). */
export function canViewRouteReconciliation(actor: User | null | undefined, routeId: string, tenantId: string): boolean {
  return can(actor, 'cashbox.viewRoute', { routeId, tenantId })
}
