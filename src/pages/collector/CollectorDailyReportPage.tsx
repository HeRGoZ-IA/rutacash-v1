import { useState, useEffect } from 'react'
import { ClipboardList } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { formatCurrency, today } from '@/lib/formatters'
import type { Client } from '@/models/types'

interface Movement {
  hora: string
  cliente: string
  concepto: string
  valor: number
  tipo: 'abono' | 'venta' | 'gasto'
}

function hora(iso: string): string {
  // HH:MM a partir del createdAt ISO (sin date-fns para evitar problemas de zona)
  const t = iso.slice(11, 16)
  return t || '--:--'
}

export default function CollectorDailyReportPage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const { activeRouteId } = useCollectorRoute()
  const [movements, setMovements] = useState<Movement[]>([])
  const [totals, setTotals] = useState({ abonos: 0, ventas: 0, gastos: 0 })
  const [loading, setLoading] = useState(true)

  const routeId = activeRouteId ?? user?.routeId ?? null

  useEffect(() => { load() }, [user, routeId])

  async function load() {
    if (!user || !routeId) { setLoading(false); return }
    setLoading(true)
    const todayStr = today()
    const [payments, sales, expenses, categories, clientsArr] = await Promise.all([
      db.payments.where('routeId').equals(routeId).and(p => p.fecha === todayStr).toArray(),
      db.sales.where('routeId').equals(routeId).toArray(),
      db.expenses.where('routeId').equals(routeId).and(e => e.fecha === todayStr).toArray(),
      db.expenseCategories.where('tenantId').equals(user.tenantId).toArray(),
      db.clients.where('tenantId').equals(user.tenantId).toArray(),
    ])
    const clientMap = new Map<string, Client>(clientsArr.map(c => [c.id, c]))
    const catName = (id: string) => categories.find(c => c.id === id)?.nombre ?? 'Gasto'

    // Ventas creadas hoy (incluye directas y aprobadas creadas hoy)
    const salesToday = sales.filter(s => s.createdAt.slice(0, 10) === todayStr)

    const movs: Movement[] = []
    for (const p of payments) movs.push({ hora: hora(p.createdAt), cliente: clientMap.get(p.clientId)?.nombre ?? 'Cliente', concepto: 'Abono', valor: p.valor, tipo: 'abono' })
    for (const s of salesToday) movs.push({ hora: hora(s.createdAt), cliente: clientMap.get(s.clientId)?.nombre ?? 'Cliente', concepto: 'Venta', valor: s.valorVenta, tipo: 'venta' })
    for (const e of expenses) movs.push({ hora: hora(e.createdAt), cliente: catName(e.categoryId), concepto: 'Gasto', valor: e.valor, tipo: 'gasto' })
    movs.sort((a, b) => a.hora.localeCompare(b.hora))

    setTotals({
      abonos: payments.reduce((s, p) => s + p.valor, 0),
      ventas: salesToday.reduce((s, x) => s + x.valorVenta, 0),
      gastos: expenses.reduce((s, e) => s + e.valor, 0),
    })
    setMovements(movs)
    setLoading(false)
  }

  const dot = (t: Movement['tipo']) => t === 'abono' ? 'bg-emerald-500' : t === 'venta' ? 'bg-primary-500' : 'bg-red-500'
  const sign = (t: Movement['tipo']) => t === 'abono' ? '+' : '-'
  const color = (t: Movement['tipo']) => t === 'abono' ? 'text-emerald-600' : t === 'venta' ? 'text-primary-600' : 'text-red-500'

  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="font-bold text-gray-900">Informe del día</h1>
        <p className="text-xs text-gray-500">Movimientos de hoy en tu ruta</p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-2xl p-3 shadow-card border border-gray-100 text-center">
          <p className="text-sm font-bold text-emerald-600 leading-tight">{formatCurrency(totals.abonos, currency)}</p>
          <p className="text-xs text-gray-500 mt-0.5">Abonos</p>
        </div>
        <div className="bg-white rounded-2xl p-3 shadow-card border border-gray-100 text-center">
          <p className="text-sm font-bold text-primary-600 leading-tight">{formatCurrency(totals.ventas, currency)}</p>
          <p className="text-xs text-gray-500 mt-0.5">Ventas</p>
        </div>
        <div className="bg-white rounded-2xl p-3 shadow-card border border-gray-100 text-center">
          <p className="text-sm font-bold text-red-500 leading-tight">{formatCurrency(totals.gastos, currency)}</p>
          <p className="text-xs text-gray-500 mt-0.5">Gastos</p>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : movements.length === 0 ? (
        <EmptyState icon={<ClipboardList className="w-8 h-8" />} title="Sin movimientos hoy" />
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-50">
          {movements.map((m, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot(m.tipo)}`} />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{m.cliente}</p>
                  <p className="text-xs text-gray-400">{m.hora} · {m.concepto}</p>
                </div>
              </div>
              <span className={`text-sm font-bold ${color(m.tipo)}`}>{sign(m.tipo)}{formatCurrency(m.valor, currency)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
