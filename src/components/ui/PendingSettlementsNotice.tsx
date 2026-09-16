import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { CalendarClock } from 'lucide-react'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { can, filterAccessibleRoutes } from '@/lib/permissions'
import { officeNameByRouteId, NO_OFFICE_LABEL } from '@/lib/officeGrouping'
import { pendingSettlements, type PendingSettlementRoute } from '@/lib/settlementPeriods'
import { getWeekStart, getWeekEnd, formatDate } from '@/lib/formatters'

/**
 * AVISO DE LIQUIDACIONES PENDIENTES de la semana en curso.
 *
 * Solo se muestra a quien puede cerrar (`settlement.close`) y solo sobre RUTAS
 * AUTORIZADAS: la Oficina que acompaña a cada ruta es una etiqueta derivada para
 * ubicarla, no un criterio de alcance.
 *
 * Se oculta por completo cuando no hay nada pendiente, para no dejar un cartel
 * permanente en el panel.
 */
export function PendingSettlementsNotice() {
  const { user } = useAuth()
  const { tenantId } = useTenant()
  const [pendientes, setPendientes] = useState<PendingSettlementRoute[]>([])

  const semanaInicio = getWeekStart()
  const semanaFin = getWeekEnd()

  useEffect(() => {
    let vivo = true
    async function cargar() {
      if (!user || !tenantId || !can(user, 'settlement.close', { tenantId })) return
      const routes = filterAccessibleRoutes(user, await db.routes.where('tenantId').equals(tenantId).toArray())
      if (routes.length === 0) return
      const offices = await db.offices.where('tenantId').equals(tenantId).toArray()
      const permitidas = new Set(routes.map(r => r.id))
      const settlements = (await db.weeklySettlements.where('tenantId').equals(tenantId).toArray())
        .filter(w => permitidas.has(w.routeId))
      const etiquetas = officeNameByRouteId(routes, offices)
      const filas = pendingSettlements(
        routes, settlements, semanaInicio, semanaFin,
        id => etiquetas.get(id) ?? NO_OFFICE_LABEL,
      )
      if (vivo) setPendientes(filas)
    }
    cargar()
    return () => { vivo = false }
  }, [user, tenantId, semanaInicio, semanaFin])

  if (pendientes.length === 0) return null

  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-amber-200 bg-amber-50">
      <CalendarClock className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-500" />
      <div className="min-w-0 text-sm text-amber-800">
        <p className="font-medium">
          {pendientes.length} ruta(s) sin cerrar la semana del {formatDate(semanaInicio)} al {formatDate(semanaFin)}
        </p>
        <p className="mt-0.5 text-xs text-amber-700">
          {pendientes.slice(0, 4).map(p => `${p.routeName} (${p.officeLabel})`).join(' · ')}
          {pendientes.length > 4 ? ` y ${pendientes.length - 4} más` : ''}
        </p>
        <Link to="/admin/liquidacion" className="mt-1 inline-block text-xs font-medium text-amber-800 underline">
          Ir a Liquidación semanal
        </Link>
      </div>
    </div>
  )
}
