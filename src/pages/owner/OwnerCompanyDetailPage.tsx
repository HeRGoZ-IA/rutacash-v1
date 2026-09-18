import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Pencil, PauseCircle, CheckCircle, Receipt } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { toast } from '@/components/ui/Toast'
import { formatCurrency, formatDate, formatDateTime, today } from '@/lib/formatters'
import { useOwnerAuth } from '@/hooks/useOwnerAuth'
import { controlPlane } from '@/platform/controlPlane'
import { expectedPeriodAmount, BILLING_MODE_LABEL } from '@/platform/billing'
import { updateCompanyBilling, setCompanyCommercialStatus, registerSaaSPayment } from '@/platform/companyControlService'
import { statusDatabase } from '@/platform/localDatabases'
import {
  COMMERCIAL_STATUS_LABEL, SAAS_PAYMENT_STATUS_LABEL, CONTROL_EVENT_LABEL,
} from '@/platform/types'
import type { CompanyControlRecord, ControlEvent, SaaSPayment, SaaSPaymentStatus } from '@/platform/types'

/**
 * FICHA COMERCIAL DE UNA EMPRESA.
 *
 * Contiene EXACTAMENTE lo necesario para administrar el SaaS: identificación,
 * contacto, fechas de alta y de acceso, estado, rutas, plan, tarifa, próximo cobro,
 * estado de pago y el historial ESTRUCTURAL/COMERCIAL (alta, primer acceso, altas y
 * bajas de rutas, suspensiones, reactivaciones y cobros).
 *
 * Lo que NO hay, y no por estar escondido: ningún acceso a clientes, ventas, pagos de
 * clientes finales, cartera, caja, gastos, documentos ni cobradores de la empresa.
 * Entrar en la ficha de una empresa NO es entrar en la empresa.
 */
export default function OwnerCompanyDetailPage() {
  const { companyId = '' } = useParams()
  const navigate = useNavigate()
  const { owner } = useOwnerAuth()

  const [record, setRecord] = useState<CompanyControlRecord | null>(null)
  const [events, setEvents] = useState<ControlEvent[]>([])
  const [payments, setPayments] = useState<SaaSPayment[]>([])
  const [loading, setLoading] = useState(true)
  const [editOpen, setEditOpen] = useState(false)
  const [payOpen, setPayOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const [form, setForm] = useState({
    nombre: '', identificacion: '', contacto: '', contactoEmail: '',
    billingMode: 'per_route' as 'per_route' | 'fixed', billingRate: '', nextBillingDate: '',
  })
  const [payForm, setPayForm] = useState({
    periodo: today().slice(0, 7), valor: '', fechaEsperada: today(),
    status: 'pending' as SaaSPaymentStatus, nota: '',
  })

  useEffect(() => { load() }, [companyId])

  async function load() {
    setLoading(true)
    const [r, ev, pays] = await Promise.all([
      controlPlane.getCompany(companyId),
      controlPlane.listEvents(companyId),
      controlPlane.listPayments(companyId),
    ])
    setRecord(r)
    setEvents(ev)
    setPayments(pays)
    setLoading(false)
  }

  function openEdit() {
    if (!record) return
    setForm({
      nombre: record.nombre,
      identificacion: record.identificacion ?? '',
      contacto: record.contacto ?? '',
      contactoEmail: record.contactoEmail ?? '',
      billingMode: record.billingMode,
      billingRate: String(record.billingRate ?? 0),
      nextBillingDate: record.nextBillingDate ?? '',
    })
    setEditOpen(true)
  }

  async function handleSave() {
    if (!owner || !record) return
    setSaving(true)
    const res = await updateCompanyBilling(owner, record.companyId, {
      nombre: form.nombre,
      identificacion: form.identificacion,
      contacto: form.contacto,
      contactoEmail: form.contactoEmail,
      billingMode: form.billingMode,
      billingRate: Number(form.billingRate) || 0,
      nextBillingDate: form.nextBillingDate,
    })
    setSaving(false)
    if (!res.ok) { toast.error(res.error ?? 'No se pudo guardar'); return }
    toast.success('Datos comerciales actualizados')
    setEditOpen(false)
    await load()
  }

  async function handleToggle() {
    if (!owner || !record) return
    const next = record.status === 'suspended' ? 'active' : 'suspended'
    const res = await setCompanyCommercialStatus(owner, record.companyId, next, statusDatabase)
    if (!res.ok) { toast.error(res.error ?? 'No se pudo cambiar el estado'); return }
    toast.success(next === 'suspended' ? 'Servicio suspendido' : 'Servicio reactivado')
    await load()
  }

  async function handleRegisterPayment() {
    if (!owner || !record) return
    setSaving(true)
    const res = await registerSaaSPayment(owner, {
      companyId: record.companyId,
      periodo: payForm.periodo,
      valor: Number(payForm.valor) || 0,
      fechaEsperada: payForm.fechaEsperada,
      status: payForm.status,
      nota: payForm.nota,
    })
    setSaving(false)
    if (!res.ok) { toast.error(res.error ?? 'No se pudo registrar'); return }
    toast.success('Cobro registrado')
    setPayOpen(false)
    await load()
  }

  if (loading) {
    return <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin" /></div>
  }
  if (!record) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center">
        <p className="text-sm text-gray-500">Esta empresa no existe en el plano de control.</p>
        <Button className="mt-4" variant="secondary" onClick={() => navigate('/owner/empresas')}>Volver</Button>
      </div>
    )
  }

  const statusVariant = record.status === 'active' ? 'success' : record.status === 'suspended' ? 'danger' : 'warning'
  const dato = (label: string, value: string) => (
    <div>
      <p className="text-xs text-gray-400">{label}</p>
      <p className="text-sm text-gray-900 font-medium">{value}</p>
    </div>
  )

  return (
    <div className="space-y-5">
      <button onClick={() => navigate('/owner/empresas')} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft className="w-4 h-4" /> Empresas
      </button>

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-gray-900">{record.nombre}</h1>
            <Badge variant={statusVariant} size="sm">{COMMERCIAL_STATUS_LABEL[record.status]}</Badge>
          </div>
          <p className="text-sm text-gray-500 mt-0.5">Ficha comercial</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={openEdit} icon={<Pencil className="w-4 h-4" />}>Editar</Button>
          <Button variant="secondary" onClick={() => setPayOpen(true)} icon={<Receipt className="w-4 h-4" />}>Registrar cobro</Button>
          <Button variant={record.status === 'suspended' ? 'primary' : 'danger'} onClick={handleToggle}
            icon={record.status === 'suspended' ? <CheckCircle className="w-4 h-4" /> : <PauseCircle className="w-4 h-4" />}>
            {record.status === 'suspended' ? 'Reactivar' : 'Suspender'}
          </Button>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 grid grid-cols-2 md:grid-cols-4 gap-4">
        {dato('Identificación', record.identificacion || '—')}
        {dato('Contacto principal', record.contacto || '—')}
        {dato('Correo de contacto', record.contactoEmail || '—')}
        {dato('Fecha de alta', formatDate(record.createdAt))}
        {dato('Primer ingreso', record.firstLoginAt ? formatDateTime(record.firstLoginAt) : 'Sin acceder todavía')}
        {dato('Último ingreso', record.lastLoginAt ? formatDateTime(record.lastLoginAt) : '—')}
        {dato('Rutas actuales', `${record.routeCount}`)}
        {dato('Rutas facturables', `${record.billableRouteCount}`)}
        {dato('Plan', BILLING_MODE_LABEL[record.billingMode])}
        {dato('Tarifa', formatCurrency(record.billingRate))}
        {dato('Cobro esperado', formatCurrency(expectedPeriodAmount(record)))}
        {dato('Próximo cobro', record.nextBillingDate ? formatDate(record.nextBillingDate) : '—')}
        <div>
          <p className="text-xs text-gray-400">Estado de pago</p>
          <Badge variant={record.paymentStatus === 'paid' ? 'success' : record.paymentStatus === 'overdue' ? 'danger' : 'warning'} size="sm">
            {SAAS_PAYMENT_STATUS_LABEL[record.paymentStatus]}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
          <p className="px-5 py-3 border-b border-gray-100 font-semibold text-gray-900 text-sm">Cobros</p>
          {payments.length === 0 ? (
            <p className="px-5 py-8 text-sm text-gray-500 text-center">Sin cobros registrados.</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {payments.map(p => (
                <div key={p.id} className="px-5 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{p.periodo}</p>
                    <p className="text-xs text-gray-400">
                      Esperado {formatDate(p.fechaEsperada)}{p.fechaPagada ? ` · Pagado ${formatDate(p.fechaPagada)}` : ''}
                    </p>
                    {p.nota && <p className="text-xs text-gray-400 mt-0.5">{p.nota}</p>}
                  </div>
                  <span className="text-sm tabular-nums text-gray-700">{formatCurrency(p.valor)}</span>
                  <Badge variant={p.status === 'paid' ? 'success' : p.status === 'overdue' ? 'danger' : 'warning'} size="sm">
                    {SAAS_PAYMENT_STATUS_LABEL[p.status]}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
          <p className="px-5 py-3 border-b border-gray-100 font-semibold text-gray-900 text-sm">
            Historial estructural y comercial
          </p>
          {events.length === 0 ? (
            <p className="px-5 py-8 text-sm text-gray-500 text-center">Sin movimientos registrados.</p>
          ) : (
            <div className="divide-y divide-gray-50 max-h-[420px] overflow-y-auto">
              {events.map(e => (
                <div key={e.id} className="px-5 py-2.5 flex items-start gap-3">
                  <span className="text-xs text-gray-400 tabular-nums w-32 flex-shrink-0">{formatDateTime(e.at)}</span>
                  <div className="min-w-0">
                    <p className="text-sm text-gray-800">{CONTROL_EVENT_LABEL[e.type]}</p>
                    {e.detail && <p className="text-xs text-gray-400">{e.detail}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal open={editOpen} onClose={() => !saving && setEditOpen(false)} title="Datos comerciales"
        footer={<>
          <Button variant="secondary" onClick={() => setEditOpen(false)} disabled={saving}>Cancelar</Button>
          <Button onClick={handleSave} loading={saving}>Guardar</Button>
        </>}>
        <div className="space-y-4">
          <Input label="Nombre" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Identificación / NIT" value={form.identificacion} onChange={e => setForm(f => ({ ...f, identificacion: e.target.value }))} />
            <Input label="Contacto principal" value={form.contacto} onChange={e => setForm(f => ({ ...f, contacto: e.target.value }))} />
          </div>
          <Input label="Correo de contacto" type="email" value={form.contactoEmail} onChange={e => setForm(f => ({ ...f, contactoEmail: e.target.value }))} />
          <div className="grid grid-cols-2 gap-3">
            <Select label="Modo de cobro" value={form.billingMode}
              onChange={e => setForm(f => ({ ...f, billingMode: e.target.value as 'per_route' | 'fixed' }))}
              options={[{ value: 'per_route', label: 'Por ruta' }, { value: 'fixed', label: 'Tarifa fija' }]} />
            <Input label="Tarifa" type="number" value={form.billingRate} onChange={e => setForm(f => ({ ...f, billingRate: e.target.value }))} />
          </div>
          <Input label="Próximo cobro" type="date" value={form.nextBillingDate} onChange={e => setForm(f => ({ ...f, nextBillingDate: e.target.value }))} />
        </div>
      </Modal>

      <Modal open={payOpen} onClose={() => !saving && setPayOpen(false)} title="Registrar cobro"
        footer={<>
          <Button variant="secondary" onClick={() => setPayOpen(false)} disabled={saving}>Cancelar</Button>
          <Button onClick={handleRegisterPayment} loading={saving}>Registrar</Button>
        </>}>
        <div className="space-y-4">
          <p className="text-xs text-gray-500">
            Cobro de RutaCash a esta empresa. No tiene ninguna relación con la caja ni
            con los pagos de los clientes de la empresa.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Período (AAAA-MM)" value={payForm.periodo} onChange={e => setPayForm(f => ({ ...f, periodo: e.target.value }))} />
            <Input label="Valor" type="number" value={payForm.valor} onChange={e => setPayForm(f => ({ ...f, valor: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Fecha esperada" type="date" value={payForm.fechaEsperada} onChange={e => setPayForm(f => ({ ...f, fechaEsperada: e.target.value }))} />
            <Select label="Estado" value={payForm.status}
              onChange={e => setPayForm(f => ({ ...f, status: e.target.value as SaaSPaymentStatus }))}
              options={[
                { value: 'pending', label: 'Pendiente' },
                { value: 'paid', label: 'Pagado' },
                { value: 'overdue', label: 'Vencido' },
              ]} />
          </div>
          <Input label="Nota (opcional)" value={payForm.nota} onChange={e => setPayForm(f => ({ ...f, nota: e.target.value }))} />
        </div>
      </Modal>
    </div>
  )
}
