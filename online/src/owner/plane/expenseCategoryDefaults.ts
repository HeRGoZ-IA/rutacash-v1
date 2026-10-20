// Plano OWNER (Ronda 40): sustituto de `src/lib/expenseCategoryDefaults.ts` SOLO para los
// archivos del plano de control (ver `inOwnerPlane` en vite.config.ts). El original escribe
// en la base local de la empresa; en ADEX Online las categorías iniciales de una empresa
// nueva las crea el SERVIDOR en el alta (`adex_control.create_company`). Nada del plano
// Owner lo llama: el alta del puente va al servidor.
import type { ExpenseCategory } from '@clean/models/types'

export const DEFAULT_EXPENSE_CATEGORY_NAMES = ['Transporte', 'Alimentación', 'Papelería', 'Combustible', 'Comunicación', 'Mantenimiento', 'Otros'] as const

export function buildDefaultExpenseCategories(_tenantId: string): ExpenseCategory[] {
  throw new Error('ADEX Online: las categorías iniciales las crea el servidor en el alta de la empresa.')
}

export async function ensureExpenseCategories(): Promise<void> { /* servidor */ }
