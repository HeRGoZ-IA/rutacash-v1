import { useState, useEffect } from 'react'
import { Plus, Building2, Users, CheckCircle, PauseCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { formatDate, nowISO } from '@/lib/formatters'
import type { Tenant, TenantPlan, TenantStatus } from '@/models/types'
import { useAuth } from '@/hooks/useAuth'
import { useNavigate } from 'react-router-dom'

const PLANS: { value: TenantPlan; label: string }[] = [
  { value: 'basico', label: 'Básico' },
  { value: 'operativo', label: 'Operativo' },
  { value: 'profesional', label: 'Profesional' },
  { value: 'empresarial', label: 'Empresarial' },
]

export default function PlatformPage() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [metrics, setMetrics] = useState<Record<string, { offices: number; routes: number; users: number; clients: number; sales: number }>>({})
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ nombre: '', email: '', plan: 'profesional' as TenantPlan, pais: 'Colombia', moneda: 'COP', fechaVencimiento: '' })

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const ts = await db.tenants.toArray()
    setTenants(ts)
    const m: typeof metrics = {}
    for (const t of ts) {
      const [offices, routes, users, clients, sales] = await Promise.all([
        db.offices.where('tenantId').equals(t.id).count(),
        db.routes.where('tenantId').equals(t.id).count(),
        db.users.where('tenantId').equals(t.id).count(),
        db.clients.where('tenantId').equals(t.id).count(),
        db.sales.where('tenantId').equals(t.id).and(s => s.status === 'activa').count(),
      ])
      m[t.id] = { offices, routes, users, clients, sales }
    }
    setMetrics(m)
    setLoading(false)
  }

  async function handleCreate() {
    if (!form.nombre || !form.email) { toast.error('Nombre y email requeridos'); return }
    setSaving(true)
    try {
      const t: Tenant = { id: generateId(), ...form, status: 'prueba', createdAt: nowISO(), updatedAt: nowISO() }
      await db.tenants.add(t)
      toast.success('Empresa creada')
      setModalOpen(false)
      await load()
    } catch { toast.error('Error') } finally { setSaving(false) }
  }

  async function toggleStatus(t: Tenant) {
    const ns: TenantStatus = t.status === 'activa' ? 'suspendida' : 'activa'
    await db.tenants.update(t.id, { status: ns, updatedAt: nowISO() })
    toast.success(`Empresa ${ns}`)
    await load()
  }

  const statusVariant = (s: TenantStatus) => s === 'activa' ? 'success' : s === 'suspendida' ? 'danger' : 'warning'
  const planVariant = (p: TenantPlan) => p === 'empresarial' ? 'purple' : p === 'profesional' ? 'info' : 'gray'

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-primary-600 rounded-xl flex items-center justify-center">
            <span className="text-white font-bold text-sm">RC</span>
          </div>
          <div>
            <p className="font-bold text-gray-900">RutaCash Platform</p>
            <p className="text-xs text-gray-500">Super Admin</p>
          </div>
        </div>
        <button onClick={() => { logout(); navigate('/login') }} className="text-sm text-gray-500 hover:text-gray-700">Cerrar sesión</button>
      </header>

      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div><h1 className="text-xl font-bold text-gray-900">Empresas / Prestamistas</h1><p className="text-sm text-gray-500 mt-0.5">{tenants.length} empresa(s)</p></div>
          <Button onClick={() => setModalOpen(true)} icon={<Plus className="w-4 h-4" />}>Nueva empresa</Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {tenants.map(t => {
              const m = metrics[t.id] ?? { offices: 0, routes: 0, users: 0, clients: 0, sales: 0 }
              return (
                <div key={t.id} className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 space-y-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-primary-100 rounded-xl flex items-center justify-center">
                        <Building2 className="w-5 h-5 text-primary-600" />
                      </div>
                      <div>
                        <p className="font-semibold text-gray-900 text-sm">{t.nombre}</p>
                        <p className="text-xs text-gray-400">{t.email}</p>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1 items-end">
                      <Badge variant={statusVariant(t.status)}>{t.status}</Badge>
                      <Badge variant={planVariant(t.plan)} size="sm">{t.plan}</Badge>
                    </div>
                  </div>

                  <div className="grid grid-cols-5 gap-1 text-center">
                    {[['Oficinas', m.offices], ['Rutas', m.routes], ['Usuarios', m.users], ['Clientes', m.clients], ['Ventas', m.sales]].map(([label, val]) => (
                      <div key={label as string} className="bg-gray-50 rounded-lg p-1.5">
                        <p className="text-xs font-bold text-gray-800">{val}</p>
                        <p className="text-xs text-gray-400 leading-tight">{label}</p>
                      </div>
                    ))}
                  </div>

                  {t.fechaVencimiento && (
                    <p className="text-xs text-gray-400">Vence: {formatDate(t.fechaVencimiento)}</p>
                  )}

                  <button onClick={() => toggleStatus(t)}
                    className={`w-full flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-medium border transition-colors ${t.status === 'activa' ? 'text-red-600 border-red-100 bg-red-50 hover:bg-red-100' : 'text-emerald-600 border-emerald-100 bg-emerald-50 hover:bg-emerald-100'}`}>
                    {t.status === 'activa' ? <><PauseCircle className="w-4 h-4" /> Suspender</> : <><CheckCircle className="w-4 h-4" /> Activar</>}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Nueva empresa"
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleCreate} loading={saving}>Crear</Button></>}>
        <div className="space-y-4">
          <Input label="Nombre de la empresa" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required />
          <Input label="Email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required />
          <div className="grid grid-cols-2 gap-3">
            <Select label="Plan" value={form.plan} onChange={e => setForm(f => ({ ...f, plan: e.target.value as TenantPlan }))} options={PLANS} />
            <Input label="País" value={form.pais} onChange={e => setForm(f => ({ ...f, pais: e.target.value }))} />
          </div>
          <Input label="Fecha de vencimiento" type="date" value={form.fechaVencimiento} onChange={e => setForm(f => ({ ...f, fechaVencimiento: e.target.value }))} />
        </div>
      </Modal>
    </div>
  )
}
