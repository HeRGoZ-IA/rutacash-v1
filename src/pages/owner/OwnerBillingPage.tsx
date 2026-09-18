import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Receipt } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { toast } from '@/components/ui/Toast'
import { formatCurrency, formatDate, today } from '@/lib/formatters'
import { useOwnerAuth } from '@/hooks/useOwnerAuth'
import { controlPlane } from '@/platform/controlPlane'
import { expectedPeriodTotal } from '@/platform/billing'
import { markPaymentPaid } from '@/platform/companyControlService'
import { SAAS_PAYMENT_STATUS_LABEL } from '@/platform/types'
import type { CompanyControlRecord, SaaSPayment } from '@/platform/types'

/**
 * COBROS SaaS — módulo comercial simple.
 *
 * Registra qué se espera cobrar a cada empresa, cuándo y si está pagado. No es
 * contabilidad y NO ES CAJA: la Caja de RutaCash es del cliente y vive en el panel de
 * su empresa. Confundir ambos conceptos sería el error más caro de este módulo, así
 * que ni siquiera comparten tabla, ruta ni vocabulario.
 */
export default function OwnerBillingPage() {
  const navigate = useNavigate()
  const { owner } = useOwnerAuth()
  const [payments, setPayments] = useState<SaaSPayment[]>([])
  const [companies, setCompanies] = useState<CompanyControlRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const [pays, comps] = await Promise.all([controlPlane.listPayments(), controlPlane.listCompanies()])
    setPayments(pays)
    setCompanies(comps)
    setLoading(false)
  }

  const nombreDe = (id: string) => companies.find(c => c.companyId === id)?.nombre ?? '—'

  async function marcarPagado(p: SaaSPayment) {
    if (!owner) return
    const res = await markPaymentPaid(owner, p, today())
    if (!res.ok) { toast.error(res.error ?? 'No se pudo actualizar'); return }
    toast.success('Cobro marcado como pagado')
    await load()
  }

  const pendientes = payments.filter(p => p.status !== 'paid')
  const totalPendiente = pendientes.reduce((s, p) => s + p.valor, 0)

  if (loading) {
    return <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin" /></div>
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Cobros</h1>
        <p className="text-sm text-gray-500 mt-0.5">Facturación de RutaCash a las empresas cliente</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="rounded-2xl border border-primary-200 bg-primary-50 p-4">
          <p className="text-xs font-medium text-primary-700 opacity-70">Cobro esperado del período</p>
          <p className="text-2xl font-bold text-primary-700 mt-1.5 tabular-nums">{formatCurrency(expectedPeriodTotal(companies))}</p>
        </div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs font-medium text-amber-700 opacity-70">Cobros pendientes</p>
          <p className="text-2xl font-bold text-amber-700 mt-1.5 tabular-nums">{pendientes.length}</p>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
          <p className="text-xs font-medium text-gray-600 opacity-70">Valor pendiente</p>
          <p className="text-2xl font-bold text-gray-800 mt-1.5 tabular-nums">{formatCurrency(totalPendiente)}</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        {payments.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <Receipt className="w-8 h-8 text-gray-300 mx-auto" />
            <p className="text-sm text-gray-500 mt-3">Sin cobros registrados.</p>
            <p className="text-xs text-gray-400 mt-1">Los cobros se registran desde la ficha de cada empresa.</p>
            <Button className="mt-4" variant="secondary" onClick={() => navigate('/owner/empresas')}>Ir a Empresas</Button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr className="text-left">
                <th className="px-4 py-2.5 font-medium">Empresa</th>
                <th className="px-4 py-2.5 font-medium">Período</th>
                <th className="px-4 py-2.5 font-medium text-right">Valor</th>
                <th className="px-4 py-2.5 font-medium">Esperado</th>
                <th className="px-4 py-2.5 font-medium">Pagado</th>
                <th className="px-4 py-2.5 font-medium">Estado</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {payments.map(p => (
                <tr key={p.id} className="hover:bg-gray-50/70">
                  <td className="px-4 py-3">
                    <button onClick={() => navigate(`/owner/empresas/${p.companyId}`)}
                      className="font-medium text-gray-900 hover:text-primary-600 hover:underline">
                      {nombreDe(p.companyId)}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-gray-600 tabular-nums">{p.periodo}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-800">{formatCurrency(p.valor)}</td>
                  <td className="px-4 py-3 text-gray-600">{formatDate(p.fechaEsperada)}</td>
                  <td className="px-4 py-3 text-gray-600">{p.fechaPagada ? formatDate(p.fechaPagada) : '—'}</td>
                  <td className="px-4 py-3">
                    <Badge variant={p.status === 'paid' ? 'success' : p.status === 'overdue' ? 'danger' : 'warning'} size="sm">
                      {SAAS_PAYMENT_STATUS_LABEL[p.status]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {p.status !== 'paid' && (
                      <button onClick={() => marcarPagado(p)} className="text-xs font-medium text-emerald-600 hover:underline">
                        Marcar pagado
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
