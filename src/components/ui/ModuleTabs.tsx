import { NavLink } from 'react-router-dom'
import { cn } from '@/lib/utils'

/**
 * Pestañas internas de un módulo (Ajustes post-Revisión 2).
 * Permite agrupar sub-secciones bajo una sola entrada del menú lateral
 * (p. ej. Gastos / Categorías y Caja rutas / Caja socios) manteniendo URLs
 * independientes para deep-linking.
 */
export function ModuleTabs({ tabs }: { tabs: { to: string; label: string }[] }) {
  return (
    <div className="flex gap-1 border-b border-gray-200 overflow-x-auto">
      {tabs.map(t => (
        <NavLink
          key={t.to}
          to={t.to}
          end
          className={({ isActive }) =>
            cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors',
              isActive
                ? 'border-primary-600 text-primary-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            )
          }
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  )
}

export const EXPENSE_TABS = [
  { to: '/admin/expenses', label: 'Gastos' },
  { to: '/admin/expense-categories', label: 'Categorías' },
]

export const CASHBOX_TABS = [
  { to: '/admin/cashbox', label: 'Caja rutas' },
  { to: '/admin/partner-cash', label: 'Caja socios' },
]
