import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Landmark } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useDataRevision } from '@/hooks/useDataRevision'
import { formatCurrency } from '@/lib/formatters'
import {
  canViewRouteReconciliation, getRouteCashReconciliation, type RouteCashReconciliation,
} from '@/services/routeCashReconciliation'

/**
 * ¿DÓNDE ESTÁ EL EFECTIVO DE LA RUTA? Base de la ruta = sin asignar + Σ personas.
 * Todo el cálculo sale de `routeCashReconciliation`; aquí solo se presenta.
 * La cartera (deuda de clientes) se muestra aparte: no es efectivo.
 */
export function RouteCashReconciliationCard({ routeId }: { routeId: string }) {
  const { user } = useAuth()
  const { tenantId, currency } = useTenant()
  const revision = useDataRevision()
  const money = (n: number) => formatCurrency(n, currency)
  const [r, setR] = useState<RouteCashReconciliation | null>(null)
  const [detalle, setDetalle] = useState(false)
  const visible = canViewRouteReconciliation(user, routeId, tenantId)

  useEffect(() => {
    let alive = true
    if (!visible || !routeId) { setR(null); return }
    getRouteCashReconciliation({ actor: user, tenantId, routeId })
      .then(x => { if (alive) setR(x) })
      .catch(() => { if (alive) setR(null) })
    return () => { alive = false }
  }, [user, tenantId, routeId, revision, visible])

  if (!visible || !r) return null
  const e = r.explicacionNoAsignado
  const Linea = ({ label, value, tone = 'text-gray-800', strong = false }: { label: string; value: string; tone?: string; strong?: boolean }) => (
    <div className="flex items-center justify-between px-4 py-2">
      <span className={`text-sm ${strong ? 'font-semibold text-gray-800' : 'text-gray-600'}`}>{label}</span>
      <span className={`text-sm font-semibold ${tone}`}>{value}</span>
    </div>
  )

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden divide-y divide-gray-50">
      <div className="px-4 py-3 bg-gray-50 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-gray-800">
          <Landmark className="w-4 h-4 text-gray-400" /> Efectivo de la ruta
        </span>
        {r.cuadra
          ? <span className="flex items-center gap-1 text-xs font-medium text-emerald-600"><CheckCircle2 className="w-3.5 h-3.5" /> Cuadra</span>
          : <span className="flex items-center gap-1 text-xs font-medium text-red-600"><AlertTriangle className="w-3.5 h-3.5" /> Revisar</span>}
      </div>
      <Linea label="Base de la ruta" value={money(r.libro.saldo)} strong />
      {r.personas.filter(p => p.posicion !== 0 || p.baseRecibida > 0).map(p => (
        <Linea key={p.userId}
          label={`En manos de ${p.nombre}${p.baseRecibida ? ` (Base entregada ${money(p.baseRecibida - p.baseDevuelta)})` : ''}`}
          value={money(p.posicion)} tone={p.posicion < 0 ? 'text-red-600' : 'text-gray-800'} />
      ))}
      <Linea label="Sin asignar (caja de la ruta)" value={money(r.noAsignado)} tone="text-primary-700" strong />
      {r.faltantes.map(f => (
        <Linea key={f.settlementId} label={`Faltante pendiente · ${f.nombre}`} value={money(f.monto)} tone="text-amber-600" />
      ))}
      {e.sobrantesRegistrados > 0 && (
        <Linea label="Sobrantes registrados (fuera del libro)" value={money(e.sobrantesRegistrados)} tone="text-amber-600" />
      )}
      <Linea label="Cartera en calle (no es efectivo)" value={money(r.cartera.carteraEnCalle)} tone="text-indigo-600" />
      <button onClick={() => setDetalle(d => !d)} className="w-full flex items-center justify-between px-4 py-2 text-xs text-gray-500">
        Cómo se explica lo no asignado {detalle ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
      {detalle && (
        <div className="divide-y divide-gray-50 bg-gray-50/50">
          <Linea label="Capital + transferencias − retiros" value={money(e.estructural)} />
          <Linea label="(+) Operación no atribuida a personas" value={money(e.operacionNoPersonal)} />
          <Linea label="(−) Base entregada neta" value={money(e.baseEntregadaNeta)} />
          <Linea label="(+) Entregado en cuadres" value={money(e.entregadoEnCuadres)} />
          <Linea label="(−) Sobrantes (no se suman al libro)" value={money(e.sobrantesRegistrados)} />
          <Linea label="= Sin asignar" value={money(e.total)} strong />
        </div>
      )}
    </div>
  )
}
