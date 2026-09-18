// ============================================================
// CATEGORÍAS DE GASTO PREDETERMINADAS DE UNA EMPRESA
// ------------------------------------------------------------
// Vivían dentro de `data/seed.ts`. Se extraen aquí por una razón concreta y no
// estética: el alta de empresa la ejecuta ahora el portal OWNER, y el código del
// Owner tiene PROHIBIDO importar módulos operativos (la prueba OWNER-PRIVACY-*
// inspecciona los imports reales). `seed.ts` arrastra el conjunto DEMO completo
// —clientes, ventas, pagos—, así que el Owner no puede tocarlo ni para esto.
//
// Son DATO DE EMPRESA (llevan `tenantId`): nacen con la empresa, en su misma
// transacción. `seed.ts` sigue reexportando el constructor para no romper a quien ya
// lo importaba de allí.
// ============================================================
import { v4 as uuidv4 } from 'uuid'
import { db } from '@/lib/db'
import type { ExpenseCategory } from '@/models/types'

export const DEFAULT_EXPENSE_CATEGORY_NAMES = [
  'Transporte', 'Alimentación', 'Papelería', 'Combustible',
  'Comunicación', 'Mantenimiento', 'Otros',
]

export function buildDefaultExpenseCategories(tenantId: string): ExpenseCategory[] {
  return DEFAULT_EXPENSE_CATEGORY_NAMES.map(nombre => ({
    id: uuidv4(), tenantId, nombre, activa: true,
  }))
}

/**
 * RED DE SEGURIDAD: garantiza que toda empresa existente tenga sus categorías base.
 *
 * Las categorías nacen con la empresa (`createCompanyWithFirstSuperAdmin`, en la
 * misma transacción). Esta función solo cubre el caso borde de una empresa creada
 * antes de esa regla, y NO crea nada si no hay empresas: sobre una instalación vacía
 * no hace absolutamente nada, que es justo lo que debe ocurrir.
 *
 * Vivía en `data/seed.ts`, eliminado junto con el modo DEMO.
 */
export async function ensureExpenseCategories(): Promise<void> {
  const tenants = await db.tenants.toArray()
  for (const t of tenants) {
    const count = await db.expenseCategories.where('tenantId').equals(t.id).count()
    if (count === 0) {
      await db.expenseCategories.bulkAdd(buildDefaultExpenseCategories(t.id))
      console.log(`[RutaCash] Categorías de gasto base creadas para la empresa ${t.id}`)
    }
  }
}
