// ============================================================
// GASTOS — ESCRITURA CON INSTANTE SELLADO BAJO BLOQUEO
// ------------------------------------------------------------
// El cuadre por trabajador corta por INSTANTE (`createdAt`) con la convención
// (desde, hasta]. Si el instante de un gasto se sellara ANTES de obtener el bloqueo
// de la tabla, un cierre concurrente (otra pestaña) podría leer sin verlo y el gasto
// quedaría con instante ≤ `hasta` pero confirmado después: en NINGÚN ciclo.
// Sellando dentro de la transacción, tras una primera lectura, el gasto o bien se
// confirma antes de que el cierre lea, o espera a que termine y obtiene un instante
// posterior a su frontera (ver `closeCashSettlement`).
// ============================================================
import { db } from '@/lib/db'
import { nowISO } from '@/lib/formatters'
import type { Expense } from '@/models/types'

export async function addExpenseStamped(expense: Omit<Expense, 'createdAt'>): Promise<Expense> {
  return db.transaction('rw', [db.expenses], async () => {
    await db.expenses.get(expense.id)            // primera lectura: bloqueo obtenido
    const fila: Expense = { ...expense, createdAt: nowISO() }
    await db.expenses.add(fila)
    return fila
  })
}
