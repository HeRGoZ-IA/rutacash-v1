// Plano OWNER (Ronda 40): sustituto de `src/lib/expenseCategoryDefaults.ts` SOLO para los
// archivos del plano de control (ver `inOwnerPlane` en vite.config.ts). El original escribe
// en la base local de la empresa; en ADEX Online las categorías iniciales de una empresa
// nueva las crea el SERVIDOR en el alta (`adex_control.create_company`). Nada del plano
// Owner lo llama: el alta del puente va al servidor.
import type { ExpenseCategory } from '@clean/models/types'

// Referencia: lista del socio (3.29, migración 0047, `adex.partner_expense_categories()`); la fuente es el servidor.
export const DEFAULT_EXPENSE_CATEGORY_NAMES = [
  'Gasolina', 'Aceite', 'Despinchada moto', 'Mantenimiento moto', 'Recarga celular', 'Arriendo funcionario', 'Seguro de moto',
  'Impuesto CNPJ', 'Pago cadena', 'Medicamentos', 'Otros',
  'Arriendo administrativo', 'Seguro de carro', 'Honorarios contador', 'Pago abogado', 'Pago PM / PC', 'Arreglo celular',
  'Compra celular', 'SIM card celular', 'Artículos hogar funcionarios', 'Préstamos funcionarios', 'Comisión', 'Sueldo revisador',
  'Sueldo panfleteador(a)', 'Sueldo secretario(a)', 'Dotación funcionarios', 'Compra de moto', 'Vistoria', 'IPVA y licenciamiento',
  'Transferencia de moto', 'Cartório', 'Pago de multas', 'Declaración de renta', 'Descuadres', 'Fondo multas',
  'Documentos funcionarios', 'Integración funcionarios', 'Interés', 'Lavada de moto', 'Prima funcionarios', 'Liquidación',
  'Pago de sistema o aplicativo', 'Pago de administración', 'Panfletos', 'Sello panfletos', 'Pasaje aéreo', 'Reembolso',
  'Seguro de repatriación', 'Viáticos', 'Uber',
] as const

export function buildDefaultExpenseCategories(_tenantId: string): ExpenseCategory[] {
  throw new Error('ADEX Online: las categorías iniciales las crea el servidor en el alta de la empresa.')
}

export async function ensureExpenseCategories(): Promise<void> { /* servidor */ }
