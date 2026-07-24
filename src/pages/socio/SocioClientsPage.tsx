import { useState, useEffect, useMemo } from 'react'
import { Search, Users, Lock } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useAccessibleRoutes } from '@/hooks/useAccessibleRoutes'
import { filterByAccessibleRoute } from '@/lib/permissions'
import { formatCurrency } from '@/lib/formatters'
import type { Client, Sale } from '@/models/types'

/**
 * Clientes del SOCIO (solo lectura) limitados a sus rutas autorizadas.
 * Sin crear ni editar: solo consulta con saldo de venta activa.
 */
export default function SocioClientsPage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const { routes } = useAccessibleRoutes()
  const [clients, setClients] = useState<Client[]>([])
  const [sales, setSales] = useState<Sale[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    if (!user) return
    Promise.all([
      db.clients.where('tenantId').equals(user.tenantId).toArray(),
      db.sales.where('tenantId').equals(user.tenantId).toArray(),
    ]).then(([cs, ss]) => {
      if (!alive) return
      // RESTRICCIÓN POR RUTAS: solo clientes/ventas de rutas autorizadas.
      setClients(filterByAccessibleRoute(user, cs))
      setSales(filterByAccessibleRoute(user, ss))
      setLoading(false)
    })
    return () => { alive = false }
  }, [user, routes.length])

  const routeName = (id: string) => routes.find(r => r.id === id)?.nombre ?? '—'
  const activeSaldo = (clientId: string) =>
    sales.filter(s => s.clientId === clientId && s.status === 'activa').reduce((sum, s) => sum + Math.max(0, s.saldo), 0)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return clients
      .filter(c => !q || c.nombre.toLowerCase().includes(q) || c.documento.includes(q))
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
  }, [clients, search])

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Clientes</h1>
          <p className="text-sm text-gray-500 mt-0.5">{filtered.length} cliente(s) · solo consulta</p>
        </div>
        <span className="inline-flex items-center gap-1 text-xs text-gray-400"><Lock className="w-3 h-3" /> Solo lectura</span>
      </div>

      <div className="max-w-sm">
        <Input placeholder="Buscar por nombre o documento…" value={search} onChange={e => setSearch(e.target.value)} leftIcon={<Search className="w-4 h-4" />} />
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<Users className="w-8 h-8" />} title="Sin clientes" description="No hay clientes en tus rutas autorizadas." />
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 divide-y divide-gray-50">
          {filtered.map(c => {
            const saldo = activeSaldo(c.id)
            return (
              <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center text-primary-700 font-bold text-sm flex-shrink-0">
                  {c.nombre.charAt(0)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 truncate">{c.nombre}</p>
                  <p className="text-xs text-gray-400 truncate">{c.documento} · {routeName(c.routeId)}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  {saldo > 0
                    ? <p className="text-sm font-semibold text-amber-600">{formatCurrency(saldo, currency)}</p>
                    : <Badge variant="gray" size="sm">Sin saldo</Badge>}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
