import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Printer } from 'lucide-react'
import { BrandLogo } from '@/components/ui/BrandLogo'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/formatters'
import { HISTORY_STATE_LABEL, accountLabel, type HistoryEntry } from '@/lib/movementHistory'
import { getMovementEntry } from '@/services/movementHistoryService'
// D74-C1: nombres de PERSONAS formateados solo para mostrar; la empresa y las razones sociales se muestran tal como se registraron.
import { formatPersonName } from '@/lib/displayName'
import type { ExpenseCategory, Route, User } from '@/models/types'

/**
 * COMPROBANTE DE MOVIMIENTO REGISTRADO (Ronda 5/6). Vista imprimible (el navegador
 * imprime o guarda en PDF) de UN registro real, leído con el MISMO alcance que el
 * historial: un id ajeno o inexistente no se muestra. La referencia es el id del
 * registro; no se genera otra al imprimir. No afirma recepción física, firmas ni
 * autorizaciones que el sistema no registra.
 */
export default function MovementReceiptPage() {
  const { fuente = '', id = '' } = useParams()
  const { tenantId, currency, tenant } = useTenant()
  const { user } = useAuth()
  const [entry, setEntry] = useState<HistoryEntry | null | undefined>(undefined)
  const [users, setUsers] = useState<User[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([
      getMovementEntry({ actor: user, tenantId, key: `${fuente}:${id}` }),
      db.users.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
      db.expenseCategories.where('tenantId').equals(tenantId).toArray(),
    ]).then(([e, us, rts, cats]) => { if (alive) { setEntry(e); setUsers(us); setRoutes(rts); setCategories(cats) } })
      .catch(e => { if (alive) { setError(e instanceof Error ? e.message : 'No se pudo cargar el comprobante'); setEntry(null) } })
    return () => { alive = false }
  }, [user, tenantId, fuente, id])

  const userName = (uid?: string) => (uid ? uid.startsWith('system:') ? 'Migración del sistema' : formatPersonName(users.find(u => u.id === uid)?.nombre) || 'Usuario no identificado' : 'No registrado')
  const routeName = (rid?: string) => (rid ? routes.find(r => r.id === rid)?.nombre ?? rid : '—')
  const nombres = { user: userName, route: routeName }
  const cat = (cid: string) => categories.find(c => c.id === cid)?.nombre ?? cid

  if (entry === undefined) return <div className="p-6 text-sm text-gray-500">Cargando…</div>
  if (!entry) {
    return (
      <div className="p-6 space-y-2" data-testid="receipt-missing">
        <p className="text-sm text-gray-700">{error ?? 'No existe un movimiento con esa referencia en tu alcance.'}</p>
        <Link to="/admin/movements" className="text-sm text-primary-700 hover:underline">Volver al historial</Link>
      </div>
    )
  }

  const filas: [string, string][] = [
    ['Tipo de movimiento', entry.tipo],
    ['Fecha y hora del registro', formatDateTime(entry.createdAt)],
    ['Fecha contable', formatDate(entry.fecha)],
    ['Importe', `${formatCurrency(entry.importe, currency)} (${currency})`],
    ['Origen', accountLabel(entry.origen, nombres)],
    ['Destino', accountLabel(entry.destino, nombres)],
    ['Registró', userName(entry.registradoPor)],
    ['Concepto / motivo', entry.concepto || 'No registrado'],
    ['Estado contable', HISTORY_STATE_LABEL[entry.estado]],
    ...(entry.routeIds.length ? [['Ruta', entry.routeIds.map(routeName).join(', ')] as [string, string]] : []),
    ...(entry.adminIds.length ? [['Bolsa / responsable de capital', entry.adminIds.map(userName).join(', ')] as [string, string]] : []),
    ...entry.extra.map(([k, v]) => [k, k === 'Categoría' ? cat(v) : v] as [string, string]),
    ...(entry.corrigeA ? [['Corrige a la referencia', entry.corrigeA.split(':')[1]] as [string, string]] : []),
    ...(entry.corregidoPor.length ? [['Corregido por la referencia', entry.corregidoPor.map(c => c.split(':')[1]).join(', ')] as [string, string]] : []),
  ]

  return (
    <div className="min-h-screen bg-gray-100 print:bg-white py-6 px-4 print:p-0">
      <div className="max-w-2xl mx-auto bg-white rounded-2xl shadow-card border border-gray-100 p-6 sm:p-8 print:shadow-none print:border-0 print:rounded-none" data-testid="receipt">
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 pb-4">
          <div>
            <BrandLogo className="h-10" />
            <p className="text-xs text-gray-500 mt-1">{tenant?.nombre ?? ''}</p>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-gray-500">Referencia</p>
            <p className="text-sm font-mono font-semibold text-gray-900 break-all" data-testid="receipt-ref">{entry.id}</p>
          </div>
        </div>
        <h1 className="text-lg font-bold text-gray-900 mt-4" data-testid="receipt-title">Comprobante de movimiento registrado</h1>
        <dl className="mt-4 divide-y divide-gray-100 text-sm">
          {filas.map(([k, v]) => (
            <div key={k} className="grid grid-cols-1 sm:grid-cols-3 gap-1 py-2">
              <dt className="text-gray-500">{k}</dt>
              <dd className="sm:col-span-2 text-gray-900 break-words" data-testid={`receipt-${k}`}>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 text-xs text-gray-600 border-t border-gray-100 pt-4" data-testid="receipt-disclaimer">
          Este comprobante acredita que el movimiento quedó registrado en ADEX Soluciones con la referencia indicada.
          No acredita la entrega ni la recepción física del efectivo, y no incluye firmas ni autorizaciones distintas de las registradas.
        </p>
        <p className="mt-1 text-[11px] text-gray-500">Generado el {formatDateTime(new Date().toISOString())} por {formatPersonName(user?.nombre)}.</p>
        <div className="mt-6 flex flex-wrap gap-2 print:hidden">
          <button type="button" onClick={() => window.print()}
            className="inline-flex items-center gap-2 h-9 px-4 text-sm font-medium rounded-lg bg-primary-600 hover:bg-primary-700 text-white shadow-sm">
            <Printer className="w-4 h-4" /> Imprimir o guardar PDF
          </button>
          <Link to="/admin/movements" className="inline-flex items-center h-9 px-4 text-sm font-medium rounded-lg bg-white hover:bg-gray-50 text-gray-700 border border-gray-300">Volver al historial</Link>
        </div>
      </div>
    </div>
  )
}
