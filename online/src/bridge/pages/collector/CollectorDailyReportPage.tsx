// PUENTE de `src/pages/collector/CollectorDailyReportPage.tsx` (CLEAN) · petición del socio 3.23 (2026-11-04).
//
// Mismo informe PERSONAL (solo lo de quien está en sesión: recaudos, desembolsos y gastos con sus totales),
// pero con FECHA ELEGIBLE: por defecto hoy (fecha de negocio de la empresa; sin conexión, la del teléfono),
// cualquier fecha pasada, nunca futura.
//   · El desembolso cuenta en su `fechaDesembolso` (día de negocio), igual que antes.
//   · La hora se muestra en la hora del teléfono: `createdAt` llega en UTC y CLEAN cortaba el texto
//     (`slice(11, 16)`), lo que en Brasil adelantaba 3 horas.
//   · Cobros y gastos se cargan hasta 20 000 filas (`projection.ts`): si el listado se cortó y el día
//     elegido es anterior al movimiento más antiguo cargado, se avisa que puede estar incompleto.

import { useState, useEffect } from 'react'
import { ClipboardList, AlertTriangle } from 'lucide-react'
import { format, isValid, parseISO } from 'date-fns'
import { EmptyState } from '@/components/ui/EmptyState'
import { db } from '@/lib/db'
import { useDataRevision } from '@/hooks/useDataRevision'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { formatCurrency, formatDate, today } from '@/lib/formatters'
import { formatClientName } from '@/lib/displayName'
import { effectivePayments } from '@/lib/paymentState'
import { isExpenseOf } from '@/lib/expenseAttribution'
import type { Client } from '@/models/types'
import { calendar, truncated } from '../../../runtime/projection.ts'

interface Movement {
  orden: string
  hora: string
  cliente: string
  concepto: string
  valor: number
  tipo: 'abono' | 'venta' | 'gasto'
}

/** HH:MM en la hora del teléfono (el servidor envía UTC). */
export function horaLocal(iso: string): string {
  const d = iso ? parseISO(iso) : null
  return d && isValid(d) ? format(d, 'HH:mm') : '--:--'
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

export default function CollectorDailyReportPage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const { activeRouteId } = useCollectorRoute()
  const [hoy, setHoy] = useState(today())
  const [fecha, setFecha] = useState(today())
  const [movements, setMovements] = useState<Movement[]>([])
  const [totals, setTotals] = useState({ abonos: 0, ventas: 0, gastos: 0 })
  const [incompleto, setIncompleto] = useState(false)
  const [loading, setLoading] = useState(true)

  const routeId = activeRouteId ?? user?.routeId ?? null
  const esHoy = fecha === hoy

  // «Hoy» es la fecha de negocio de la empresa; sin conexión se queda la del teléfono.
  useEffect(() => {
    let vivo = true
    calendar().then((c) => {
      if (!vivo || !ISO_DAY.test(c.businessDate)) return
      setFecha((f) => (f === hoy ? c.businessDate : f > c.businessDate ? c.businessDate : f))
      setHoy(c.businessDate)
    }).catch(() => { /* sin conexión: fecha del teléfono */ })
    return () => { vivo = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Un pago registrado o anulado en otra pestaña cambia saldo y parcelas: se relee.
  const revision = useDataRevision()
  useEffect(() => { load() }, [user, routeId, revision, fecha])

  async function load() {
    if (!user || !routeId) { setLoading(false); return }
    setLoading(true)
    const dia = fecha
    const [allPayments, sales, allExpenses, categories, clientsArr] = await Promise.all([
      db.payments.where('routeId').equals(routeId).toArray(),
      db.sales.where('routeId').equals(routeId).toArray(),
      db.expenses.where('routeId').equals(routeId).toArray(),
      db.expenseCategories.where('tenantId').equals(user.tenantId).toArray(),
      db.clients.where('tenantId').equals(user.tenantId).toArray(),
    ])
    const payments = allPayments.filter(p => p.fecha === dia)
    const expenses = allExpenses.filter(e => e.fecha === dia)
    const clientMap = new Map<string, Client>(clientsArr.map(c => [c.id, c]))
    const catName = (id: string) => categories.find(c => c.id === id)?.nombre ?? 'Gasto'

    // INFORME PERSONAL: solo los movimientos ATRIBUIBLES a quien está en sesión.
    const misAbonos = effectivePayments(payments).filter(p => p.collectorId === user.id)
    const misDesembolsos = sales.filter(s =>
      s.disbursementStatus !== 'pendiente'
      && s.disbursedByCollectorId === user.id
      && s.fechaDesembolso === dia
    )
    const misGastos = expenses.filter(e => isExpenseOf(e, user.id))

    const movs: Movement[] = []
    for (const p of misAbonos) movs.push({ orden: p.createdAt, hora: horaLocal(p.createdAt), cliente: formatClientName(clientMap.get(p.clientId)?.nombre) || 'Cliente', concepto: 'Recaudo', valor: p.valor, tipo: 'abono' })
    for (const s of misDesembolsos) movs.push({ orden: s.disbursedAt ?? s.createdAt, hora: horaLocal(s.disbursedAt ?? s.createdAt), cliente: formatClientName(clientMap.get(s.clientId)?.nombre) || 'Cliente', concepto: 'Desembolso', valor: s.valorVenta, tipo: 'venta' })
    for (const e of misGastos) movs.push({ orden: e.createdAt, hora: horaLocal(e.createdAt), cliente: catName(e.categoryId), concepto: 'Gasto', valor: e.valor, tipo: 'gasto' })
    movs.sort((a, b) => a.orden.localeCompare(b.orden))

    // ¿Listado cortado y día anterior a lo más antiguo cargado? Puede faltar algo.
    const masAntigua = (rows: { fecha: string }[]) => rows.reduce((m, r) => (r.fecha && r.fecha < m ? r.fecha : m), '9999-12-31')
    const cortado = (truncated.has('/v1/collections') && dia <= masAntigua(allPayments))
      || (truncated.has('/v1/expenses') && dia <= masAntigua(allExpenses))

    setTotals({
      abonos: misAbonos.reduce((s, p) => s + p.valor, 0),
      ventas: misDesembolsos.reduce((s, x) => s + x.valorVenta, 0),
      gastos: misGastos.reduce((s, e) => s + e.valor, 0),
    })
    setIncompleto(cortado)
    setMovements(movs)
    setLoading(false)
  }

  const dot = (t: Movement['tipo']) => t === 'abono' ? 'bg-emerald-500' : t === 'venta' ? 'bg-primary-500' : 'bg-red-500'
  const sign = (t: Movement['tipo']) => t === 'abono' ? '+' : '-'
  const color = (t: Movement['tipo']) => t === 'abono' ? 'text-emerald-600' : t === 'venta' ? 'text-primary-600' : 'text-red-500'

  function elegir(v: string) {
    if (!ISO_DAY.test(v)) return
    setFecha(v > hoy ? hoy : v)
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-bold text-gray-900">Informe del día</h1>
          <p className="text-xs text-gray-500" data-testid="daily-report-subtitle">
            {esHoy ? 'Tus movimientos de hoy' : `Tus movimientos del ${formatDate(fecha)}`}
          </p>
        </div>
        <div className="flex-shrink-0">
          <label htmlFor="daily-report-date" className="block text-xs text-gray-500 mb-1">Fecha</label>
          <input id="daily-report-date" data-testid="daily-report-date" type="date" value={fecha} max={hoy}
            onChange={e => elegir(e.target.value)}
            className="h-9 rounded-lg border border-gray-300 px-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
        </div>
      </div>
      {!esHoy && (
        <button type="button" onClick={() => setFecha(hoy)} className="text-xs font-medium text-primary-600">
          Volver a hoy
        </button>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-2xl p-3 shadow-card border border-gray-100 text-center">
          <p className="text-sm font-bold text-emerald-600 leading-tight" data-testid="daily-report-abonos">{formatCurrency(totals.abonos, currency)}</p>
          <p className="text-xs text-gray-500 mt-0.5">Recaudo</p>
        </div>
        <div className="bg-white rounded-2xl p-3 shadow-card border border-gray-100 text-center">
          <p className="text-sm font-bold text-primary-600 leading-tight" data-testid="daily-report-ventas">{formatCurrency(totals.ventas, currency)}</p>
          <p className="text-xs text-gray-500 mt-0.5">Desembolsos</p>
        </div>
        <div className="bg-white rounded-2xl p-3 shadow-card border border-gray-100 text-center">
          <p className="text-sm font-bold text-red-500 leading-tight" data-testid="daily-report-gastos">{formatCurrency(totals.gastos, currency)}</p>
          <p className="text-xs text-gray-500 mt-0.5">Gastos</p>
        </div>
      </div>

      {incompleto && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800" data-testid="daily-report-incomplete">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>Este día puede estar incompleto: en el teléfono se cargan solo los 20 000 movimientos más recientes. Para fechas tan antiguas, consulta los reportes del Administrador.</span>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : movements.length === 0 ? (
        <EmptyState icon={<ClipboardList className="w-8 h-8" />} title={esHoy ? 'Sin movimientos hoy' : `Sin movimientos el ${formatDate(fecha)}`} />
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-50" data-testid="daily-report-list">
          {movements.map((m, i) => (
            <div key={i} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot(m.tipo)}`} />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{m.cliente}</p>
                  <p className="text-xs text-gray-500">{m.hora} · {m.concepto}</p>
                </div>
              </div>
              <span className={`text-sm font-bold whitespace-nowrap flex-shrink-0 ${color(m.tipo)}`}>{sign(m.tipo)}{formatCurrency(m.valor, currency)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
