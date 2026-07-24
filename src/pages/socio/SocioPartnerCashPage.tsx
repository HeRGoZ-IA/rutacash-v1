import { useState, useEffect } from 'react'
import { Wallet, ArrowDownCircle, ArrowUpCircle } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { formatCurrency, formatDate } from '@/lib/formatters'
import type { PartnerCashMovement } from '@/models/types'

/**
 * "Mi caja" del SOCIO: consulta de SU PROPIA caja de socio (solo lectura).
 * No puede ver la caja de otros socios ni registrar movimientos.
 */
export default function SocioPartnerCashPage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const [movs, setMovs] = useState<PartnerCashMovement[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    if (!user) return
    db.partnerCashMovements.where('partnerId').equals(user.id).toArray().then(list => {
      if (!alive) return
      setMovs(list.sort((a, b) => b.fecha.localeCompare(a.fecha)))
      setLoading(false)
    })
    return () => { alive = false }
  }, [user])

  const ingresos = movs.filter(m => m.type === 'ingreso').reduce((s, m) => s + m.amount, 0)
  const salidas = movs.filter(m => m.type === 'salida').reduce((s, m) => s + m.amount, 0)
  const saldo = ingresos - salidas

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Mi caja de socio</h1>
        <p className="text-sm text-gray-500 mt-0.5">Movimientos asociados a tu cuenta como socio</p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-3">
          <p className="text-[11px] text-gray-500">Ingresos</p>
          <p className="text-base font-bold text-emerald-600 tabular-nums truncate">{formatCurrency(ingresos, currency)}</p>
        </div>
        <div className="rounded-2xl border border-red-100 bg-red-50 p-3">
          <p className="text-[11px] text-gray-500">Salidas</p>
          <p className="text-base font-bold text-red-500 tabular-nums truncate">{formatCurrency(salidas, currency)}</p>
        </div>
        <div className="rounded-2xl border border-primary-100 bg-primary-50 p-3">
          <p className="text-[11px] text-gray-500">Saldo</p>
          <p className="text-base font-bold text-primary-700 tabular-nums truncate">{formatCurrency(saldo, currency)}</p>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : movs.length === 0 ? (
        <EmptyState icon={<Wallet className="w-8 h-8" />} title="Sin movimientos" description="Tu caja de socio no tiene movimientos registrados." />
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 divide-y divide-gray-50">
          {movs.map(m => (
            <div key={m.id} className="flex items-center gap-3 px-4 py-3">
              {m.type === 'ingreso'
                ? <ArrowDownCircle className="w-5 h-5 text-emerald-500 flex-shrink-0" />
                : <ArrowUpCircle className="w-5 h-5 text-red-400 flex-shrink-0" />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{m.description ?? m.category}</p>
                <p className="text-xs text-gray-400">{formatDate(m.fecha)} · <Badge variant="gray" size="sm">{m.category}</Badge></p>
              </div>
              <p className={`text-sm font-semibold flex-shrink-0 ${m.type === 'ingreso' ? 'text-emerald-600' : 'text-red-500'}`}>
                {m.type === 'ingreso' ? '+' : '−'}{formatCurrency(m.amount, currency)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
