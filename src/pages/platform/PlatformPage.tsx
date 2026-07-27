import { useState, useEffect } from 'react'
import { Plus, Building2, CheckCircle, PauseCircle, LogIn, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { ConfirmDiscardModal } from '@/components/ui/ConfirmDiscardModal'
import { useDirtyForm } from '@/hooks/useDirtyForm'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { formatDate, nowISO, today } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import { getEffectiveCompanyStatus, type EffectiveCompanyStatus } from '@/lib/company'
import type { Tenant, TenantPlan, TenantStatus } from '@/models/types'
import { useAuth } from '@/hooks/useAuth'
import { useNavigate } from 'react-router-dom'

// #7: el plan comercial NO tiene reglas/límites reales implementados; se oculta del
// formulario y se asigna un plan predeterminado. Pendiente de definición comercial.
const DEFAULT_PLAN: TenantPlan = 'profesional'

export default function PlatformPage() {
  const { logout, user, selectTenant } = useAuth()
  const navigate = useNavigate()

  // Super Admin entra al panel operativo de una empresa (acceptance: operar dentro
  // de empresas). Fija el tenant en sesión y navega al panel admin.
  function enterCompany(t: Tenant) {
    selectTenant(t)
    navigate('/admin/dashboard')
  }
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [metrics, setMetrics] = useState<Record<string, { routes: number; users: number; clients: number; sales: number }>>({})
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<Tenant | null>(null)
  const [form, setForm] = useState({ nombre: '', email: '', pais: 'Colombia', moneda: 'COP', vigencia: 'sin' as 'sin' | 'con', fechaVencimiento: '' })
  const [original, setOriginal] = useState<Record<string, unknown> | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  const dirty = useDirtyForm(original, form)
  function closeModal() { setModalOpen(false); setDiscardOpen(false); setOriginal(null) }
  function tryCloseModal() { if (dirty) setDiscardOpen(true); else closeModal() }

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const ts = await db.tenants.toArray()
    setTenants(ts)
    const m: typeof metrics = {}
    for (const t of ts) {
      const [routes, users, clients, sales] = await Promise.all([
        db.routes.where('tenantId').equals(t.id).count(),
        db.users.where('tenantId').equals(t.id).count(),
        db.clients.where('tenantId').equals(t.id).count(),
        db.sales.where('tenantId').equals(t.id).and(s => s.status === 'activa').count(),
      ])
      m[t.id] = { routes, users, clients, sales }
    }
    setMetrics(m)
    setLoading(false)
  }

  function openCreate() {
    setEditing(null)
    const init = { nombre: '', email: '', pais: 'Colombia', moneda: 'COP', vigencia: 'sin' as 'sin' | 'con', fechaVencimiento: '' }
    setForm(init); setOriginal({ ...init })
    setModalOpen(true)
  }

  function openEdit(t: Tenant) {
    setEditing(t)
    const init = {
      nombre: t.nombre, email: t.email, pais: t.pais, moneda: t.moneda,
      vigencia: (t.fechaVencimiento ? 'con' : 'sin') as 'sin' | 'con', fechaVencimiento: t.fechaVencimiento ?? '',
    }
    setForm(init); setOriginal({ ...init })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.nombre || !form.email) { toast.error('Nombre y email requeridos'); return }
    // #7 Vigencia: si es "con fecha", es obligatoria y no puede ser anterior a hoy.
    if (form.vigencia === 'con') {
      if (!form.fechaVencimiento) { toast.error('Indica la fecha de vencimiento'); return }
      if (form.fechaVencimiento < today()) { toast.error('La fecha de vencimiento no puede ser anterior a hoy'); return }
    }
    const fechaVencimiento = form.vigencia === 'con' ? form.fechaVencimiento : undefined
    setSaving(true)
    try {
      if (editing) {
        const before = { nombre: editing.nombre, email: editing.email, pais: editing.pais, fechaVencimiento: editing.fechaVencimiento ?? null }
        await db.tenants.update(editing.id, { nombre: form.nombre.trim(), email: form.email.trim(), pais: form.pais.trim(), moneda: form.moneda, fechaVencimiento, updatedAt: nowISO() })
        if (user) await logAction({
          tenantId: editing.id, userId: user.id, userRole: user.rol,
          action: 'UPDATE_TENANT', entityType: 'Tenant', entityId: editing.id, descripcion: `Empresa editada: ${form.nombre.trim()}`,
          before, after: { nombre: form.nombre.trim(), email: form.email.trim(), pais: form.pais.trim(), fechaVencimiento: fechaVencimiento ?? null },
        })
        toast.success('Empresa actualizada')
      } else {
        const t: Tenant = {
          id: generateId(), nombre: form.nombre.trim(), email: form.email.trim(), pais: form.pais.trim(),
          moneda: form.moneda, plan: DEFAULT_PLAN, status: 'prueba', fechaVencimiento,
          createdAt: nowISO(), updatedAt: nowISO(),
        }
        await db.tenants.add(t)
        if (user) await logAction({ tenantId: t.id, userId: user.id, userRole: user.rol, action: 'CREATE_TENANT', entityType: 'Tenant', entityId: t.id, descripcion: `Empresa creada: ${t.nombre}` })
        toast.success('Empresa creada')
      }
      closeModal()
      await load()
    } catch { toast.error('Error') } finally { setSaving(false) }
  }

  async function toggleStatus(t: Tenant) {
    const ns: TenantStatus = t.status === 'activa' ? 'suspendida' : 'activa'
    await db.tenants.update(t.id, { status: ns, updatedAt: nowISO() })
    if (user) await logAction({ tenantId: t.id, userId: user.id, userRole: user.rol, action: ns === 'suspendida' ? 'SUSPEND_TENANT' : 'UPDATE_TENANT', entityType: 'Tenant', entityId: t.id, descripcion: `Empresa ${ns}: ${t.nombre}` })
    toast.success(`Empresa ${ns}`)
    await load()
  }

  const statusVariant = (s: EffectiveCompanyStatus) => s === 'activa' ? 'success' : (s === 'suspendida' || s === 'vencida') ? 'danger' : 'warning'
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
          <Button onClick={openCreate} icon={<Plus className="w-4 h-4" />}>Nueva empresa</Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {tenants.map(t => {
              const m = metrics[t.id] ?? { routes: 0, users: 0, clients: 0, sales: 0 }
              const eff = getEffectiveCompanyStatus(t)  // incluye 'vencida' derivado por fecha
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
                      <Badge variant={statusVariant(eff)}>{eff}</Badge>
                      <Badge variant={planVariant(t.plan)} size="sm">{t.plan}</Badge>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-1 text-center">
                    {[['Rutas', m.routes], ['Usuarios', m.users], ['Clientes', m.clients], ['Ventas', m.sales]].map(([label, val]) => (
                      <div key={label as string} className="bg-gray-50 rounded-lg p-1.5">
                        <p className="text-xs font-bold text-gray-800">{val}</p>
                        <p className="text-xs text-gray-400 leading-tight">{label}</p>
                      </div>
                    ))}
                  </div>

                  {/* #3 La vigencia SIEMPRE se muestra (nunca línea vacía). */}
                  <p className={`text-xs ${eff === 'vencida' ? 'text-red-600 font-medium' : 'text-gray-400'}`}>
                    {t.fechaVencimiento
                      ? `${eff === 'vencida' ? 'Vencida el' : 'Vence:'} ${formatDate(t.fechaVencimiento)}`
                      : 'Sin fecha de vencimiento'}
                  </p>

                  <div className="grid grid-cols-3 gap-2">
                    <button onClick={() => enterCompany(t)} disabled={t.status === 'suspendida'}
                      className="flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-medium border text-primary-600 border-primary-100 bg-primary-50 hover:bg-primary-100 disabled:opacity-40 transition-colors">
                      <LogIn className="w-4 h-4" /> Entrar
                    </button>
                    <button onClick={() => openEdit(t)}
                      className="flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-medium border text-gray-600 border-gray-200 bg-white hover:bg-gray-50 transition-colors">
                      <Pencil className="w-4 h-4" /> Editar
                    </button>
                    <button onClick={() => toggleStatus(t)}
                      className={`flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-medium border transition-colors ${t.status === 'activa' ? 'text-red-600 border-red-100 bg-red-50 hover:bg-red-100' : 'text-emerald-600 border-emerald-100 bg-emerald-50 hover:bg-emerald-100'}`}>
                      {t.status === 'activa' ? <><PauseCircle className="w-4 h-4" /> Suspender</> : <><CheckCircle className="w-4 h-4" /> Activar</>}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <Modal open={modalOpen} onClose={tryCloseModal} title={editing ? 'Editar empresa' : 'Nueva empresa'}
        footer={<><Button variant="secondary" onClick={tryCloseModal} disabled={saving}>Cancelar</Button><Button onClick={handleSave} loading={saving}>{editing ? 'Guardar' : 'Crear'}</Button></>}>
        <div className="space-y-4">
          <Input label="Nombre de la empresa" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required />
          <Input label="Email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required />
          <Input label="País" value={form.pais} onChange={e => setForm(f => ({ ...f, pais: e.target.value }))} />
          {/* #7 Vigencia explícita: sin vencimiento / con fecha. */}
          <Select label="Vigencia" value={form.vigencia}
            onChange={e => setForm(f => ({ ...f, vigencia: e.target.value as 'sin' | 'con' }))}
            options={[
              { value: 'sin', label: 'Sin vencimiento' },
              { value: 'con', label: 'Con fecha de vencimiento' },
            ]} />
          {form.vigencia === 'con' && (
            <Input label="Fecha de vencimiento" type="date" min={today()}
              value={form.fechaVencimiento} onChange={e => setForm(f => ({ ...f, fechaVencimiento: e.target.value }))} required />
          )}
          <p className="text-xs text-gray-400">El plan comercial queda pendiente de definición; se asigna un plan predeterminado.</p>
        </div>
      </Modal>

      <ConfirmDiscardModal open={discardOpen} onKeepEditing={() => setDiscardOpen(false)} onDiscard={closeModal} />
    </div>
  )
}
