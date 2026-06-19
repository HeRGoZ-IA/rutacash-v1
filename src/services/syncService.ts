// ============================================================
// Servicio de sincronización - simula sync en V1 local
// ============================================================
import { db } from '@/lib/db'

export async function getPendingSyncCount(): Promise<number> {
  const pendingPayments = await db.payments
    .where('syncStatus').equals('pending').count()
  const pendingVisits = await db.noPaymentVisits
    .where('syncStatus').equals('pending').count()
  const pendingExpenses = await db.expenses
    .where('syncStatus').equals('pending').count()
  return pendingPayments + pendingVisits + pendingExpenses
}

export async function syncPendingItems(): Promise<{ synced: number; errors: number }> {
  let synced = 0
  let errors = 0

  // En V1 local: simplemente marcamos como synced
  // En V2 con Supabase: aquí iría la lógica real de push a servidor

  const pendingPayments = await db.payments.where('syncStatus').equals('pending').toArray()
  for (const p of pendingPayments) {
    try {
      await db.payments.update(p.id, { syncStatus: 'synced' })
      synced++
    } catch {
      await db.payments.update(p.id, { syncStatus: 'error' })
      errors++
    }
  }

  const pendingVisits = await db.noPaymentVisits.where('syncStatus').equals('pending').toArray()
  for (const v of pendingVisits) {
    try {
      await db.noPaymentVisits.update(v.id, { syncStatus: 'synced' })
      synced++
    } catch {
      await db.noPaymentVisits.update(v.id, { syncStatus: 'error' })
      errors++
    }
  }

  const pendingExpenses = await db.expenses.where('syncStatus').equals('pending').toArray()
  for (const e of pendingExpenses) {
    try {
      await db.expenses.update(e.id, { syncStatus: 'synced' })
      synced++
    } catch {
      await db.expenses.update(e.id, { syncStatus: 'error' })
      errors++
    }
  }

  return { synced, errors }
}
