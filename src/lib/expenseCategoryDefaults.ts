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
