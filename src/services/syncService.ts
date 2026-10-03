// ============================================================
// Servicio de sincronización - simula sync en V1 local
// ------------------------------------------------------------
// ALCANCE REAL (auditado en el punto 8 de los ajustes del socio 2026-10-02):
// NO hay backend, ni cola remota, ni pull. Todas las sesiones de un navegador
// comparten UNA IndexedDB; `syncStatus` solo distingue lo registrado sin conexión
// ('pending') de lo confirmado ('synced'). "Sincronizar" confirma en esta misma
// base: no envía nada a otro dispositivo. La propagación entre pestañas la hace
// Dexie (`storagemutated` + BroadcastChannel) al confirmar cada transacción.
//
// Aun así, la confirmación respeta el contrato que necesitará un backend:
//   · ALCANCE: solo la empresa (y las rutas) de quien sincroniza.
//   · ATOMICIDAD POR CRÉDITO: los pagos de una venta se confirman en UNA
//     transacción; un fallo deja todo como estaba (pendiente) para reintentar.
//   · CAUSALIDAD: una reversión o un reemplazo nunca queda confirmado si su original
//     no lo está.
//   · IDEMPOTENCIA: repetir (doble clic, otra pestaña, reabrir la app) no cambia
//     nada de lo ya confirmado; solo toca `syncStatus`, nunca el estado del pago.
//   · ESTADOS IMPOSIBLES: se marcan 'error' (visibles), no se confirman ni se ocultan.
// ============================================================
import { db } from '@/lib/db'
import { paymentLedgerAnomalies } from '@/lib/paymentState'
import type { Payment, SyncStatus } from '@/models/types'

/** Qué se sincroniza: la empresa y, opcionalmente, solo estas rutas. */
export interface SyncScope {
  tenantId: string
  routeIds?: readonly string[]
}

const enAlcance = (scope: SyncScope | undefined, x: { tenantId: string; routeId?: string }) =>
  !scope || (x.tenantId === scope.tenantId && (!scope.routeIds || (!!x.routeId && scope.routeIds.includes(x.routeId))))

const porConfirmar = (s: SyncStatus) => s === 'pending' || s === 'error'

export async function getPendingSyncCount(scope?: SyncScope): Promise<number> {
  const pendingPayments = (await db.payments.where('syncStatus').equals('pending').toArray()).filter(p => enAlcance(scope, p)).length
  const pendingVisits = (await db.noPaymentVisits.where('syncStatus').equals('pending').toArray()).filter(v => enAlcance(scope, v)).length
  const pendingExpenses = (await db.expenses.where('syncStatus').equals('pending').toArray()).filter(e => enAlcance(scope, e)).length
  return pendingPayments + pendingVisits + pendingExpenses
}

export interface SyncResult {
  /** Registros confirmados en esta pasada. */
  synced: number
  /** Registros con estado imposible (quedan 'error') o créditos cuya confirmación falló (quedan pendientes). */
  errors: number
  /** Dependientes que esperan a su original (reversión/reemplazo de un pago no confirmable). */
  deferred: number
}

/**
 * Confirma los pagos pendientes de UNA venta, en una transacción. Devuelve el
 * recuento. Lee la venta completa bajo bloqueo: el orden causal y las anomalías se
 * evalúan sobre el libro real, no sobre una lista leída antes.
 */
async function confirmSalePayments(saleId: string, scope: SyncScope | undefined): Promise<SyncResult> {
  const r: SyncResult = { synced: 0, errors: 0, deferred: 0 }
  await db.transaction('rw', db.payments, async () => {
    const pagos = await db.payments.where('saleId').equals(saleId).toArray()
    const anomalos = new Set(paymentLedgerAnomalies(pagos).flatMap(a => a.paymentIds))
    const byId = new Map(pagos.map(p => [p.id, p]))
    const destino = new Map<string, SyncStatus>(pagos.map(p => [p.id, p.syncStatus]))

    // Un dependiente (reversión → su original, reemplazo → el original corregido)
    // solo se confirma si su original quedó confirmado antes o en esta transacción.
    // Punto fijo: cubre cadenas (un reemplazo que a su vez se anuló).
    const dependeDe = (p: Payment) => p.reversesPaymentId ?? p.correctionOfPaymentId
    let quedan = pagos.filter(p => porConfirmar(p.syncStatus) && enAlcance(scope, p))
    for (const p of quedan.filter(x => anomalos.has(x.id))) { destino.set(p.id, 'error'); r.errors++ }
    quedan = quedan.filter(p => !anomalos.has(p.id))
    for (let avanzo = true; avanzo;) {
      avanzo = false
      for (const p of quedan) {
        const padre = dependeDe(p)
        if (padre && byId.has(padre) && destino.get(padre) !== 'synced') continue
        destino.set(p.id, 'synced')
        r.synced++
        avanzo = true
      }
      quedan = quedan.filter(p => destino.get(p.id) !== 'synced')
    }
    r.deferred = quedan.length
    for (const p of pagos) {
      const nuevo = destino.get(p.id)!
      if (nuevo !== p.syncStatus) await db.payments.update(p.id, { syncStatus: nuevo })
    }
  })
  return r
}

export async function syncPendingItems(scope?: SyncScope): Promise<SyncResult> {
  const total: SyncResult = { synced: 0, errors: 0, deferred: 0 }

  // PAGOS: por crédito, en orden estable. Se incluyen los 'error' para reintentar:
  // una anomalía reparada se confirma en la siguiente pasada.
  const candidatos = [
    ...await db.payments.where('syncStatus').equals('pending').toArray(),
    ...await db.payments.where('syncStatus').equals('error').toArray(),
  ].filter(p => enAlcance(scope, p))
  const ventas = [...new Set(candidatos.map(p => p.saleId))].sort()
  for (const saleId of ventas) {
    try {
      const r = await confirmSalePayments(saleId, scope)
      total.synced += r.synced; total.errors += r.errors; total.deferred += r.deferred
    } catch {
      // La transacción se revirtió: todo sigue pendiente y se reintenta luego.
      total.errors++
    }
  }

  const pendingVisits = (await db.noPaymentVisits.where('syncStatus').equals('pending').toArray()).filter(v => enAlcance(scope, v))
  for (const v of pendingVisits) {
    try {
      await db.noPaymentVisits.update(v.id, { syncStatus: 'synced' })
      total.synced++
    } catch {
      await db.noPaymentVisits.update(v.id, { syncStatus: 'error' })
      total.errors++
    }
  }

  const pendingExpenses = (await db.expenses.where('syncStatus').equals('pending').toArray()).filter(e => enAlcance(scope, e))
  for (const e of pendingExpenses) {
    try {
      await db.expenses.update(e.id, { syncStatus: 'synced' })
      total.synced++
    } catch {
      await db.expenses.update(e.id, { syncStatus: 'error' })
      total.errors++
    }
  }

  return total
}
