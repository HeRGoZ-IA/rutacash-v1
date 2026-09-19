import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Building2, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { toast } from '@/components/ui/Toast'
import { formatCurrency, formatDate, formatDateTime, today } from '@/lib/formatters'
import { generateTemporaryPassword } from '@/lib/utils'
import { useOwnerAuth } from '@/hooks/useOwnerAuth'
import { controlPlane } from '@/platform/controlPlane'
import { expectedPeriodAmount, BILLING_MODE_LABEL } from '@/platform/billing'
import { createCompanyWithFirstSuperAdmin, setCompanyCommercialStatus } from '@/platform/companyControlService'
import { provisioningDatabase, statusDatabase } from '@/platform/localDatabases'
import { COMMERCIAL_STATUS_LABEL, SAAS_PAYMENT_STATUS_LABEL } from '@/platform/types'
import type { CompanyControlRecord } from '@/platform/types'

/**
 * LISTADO DE EMPRESAS DEL OWNER.
 *
 * Columnas: empresa, fecha de alta, estado, primer y último ingreso, rutas actuales,
 * tarifa/plan, próximo cobro y estado de pago. Es TODO lo que el Owner ve de una
 * empresa. No hay —ni puede haber— columna de clientes, ventas, pagos, caja,
 * cobradores o documentos: esos datos ni se consultan.
 *
 * ALTA DE EMPRESA: el formulario pide datos comerciales mínimos y el PRIMER Super
 * Admin. Ahí termina el trabajo del Owner: ni Oficinas, ni Rutas, ni más usuarios.
 * Eso lo hace el Super Admin entrando por /login.
 */
export default function OwnerCompaniesPage() {
  const navigate = useNavigate()
  const { owner } = useOwnerAuth()
  const [rows, setRows] = useState<CompanyControlRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [credenciales, setCredenciales] = useState<{ empresa: string; email: string; password: string } | null>(null)

  const emptyForm = {
    nombre: '', email: '', identificacion: '', contacto: '',
    status: 'trial' as 'trial' | 'active',
    billingMode: 'per_route' as 'per_route' | 'fixed',
    billingRate: '',
    adminNombre: '', adminEmail: '', adminPassword: generateTemporaryPassword(),
  }
  const [form, setForm] = useState(emptyForm)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setRows(await controlPlane.listCompanies())
    setLoading(false)
  }

  function openCreate() {
    setForm({ ...emptyForm, adminPassword: generateTemporaryPassword() })
    setModalOpen(true)
  }

  async function handleCreate() {
    if (!owner) return
    setSaving(true)
    const result = await createCompanyWithFirstSuperAdmin(
      owner,
      {
        nombre: form.nombre,
        email: form.email,
        identificacion: form.identificacion,
        contacto: form.contacto,
        status: form.status,
        billingMode: form.billingMode,
        billingRate: Number(form.billingRate) || 0,
        // `nextBillingDate` NO se define en el alta: es gestión comercial posterior.
        // El servicio lo deja vacío y se fija luego desde la ficha de la empresa.
        superAdmin: {
          nombre: form.adminNombre,
          email: form.adminEmail,
          password: form.adminPassword,
        },
      },
      provisioningDatabase,
    )
    setSaving(false)
    if (!result.ok) { toast.error(result.message); return }
    setModalOpen(false)
    // ENTREGA DE CREDENCIALES: el Owner necesita poder copiarlas para dárselas al
    // cliente. Se muestran UNA vez, aquí, justo después de crearlas. Después ya no se
    // pueden consultar: la contraseña nunca se vuelve a mostrar en ninguna pantalla.
    setCredenciales({ empresa: result.tenant.nombre, email: result.superAdmin.email, password: form.adminPassword })
    await load()
  }

  async function toggleStatus(r: CompanyControlRecord) {
    if (!owner) return
    const next = r.status === 'suspended' ? 'active' : 'suspended'
    const res = await setCompanyCommercialStatus(owner, r.companyId, next, statusDatabase)
    if (!res.ok) { toast.error(res.error ?? 'No se pudo cambiar el estado'); return }
    toast.success(next === 'suspended' ? 'Servicio suspendido' : 'Servicio reactivado')
    await load()
  }

  const statusVariant = (s: CompanyControlRecord['status']) =>
    s === 'active' ? 'success' : s === 'suspended' ? 'danger' : 'warning'
  const payVariant = (s: CompanyControlRecord['paymentStatus']) =>
    s === 'paid' ? 'success' : s === 'overdue' ? 'danger' : 'warning'

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Empresas</h1>
          <p className="text-sm text-gray-500 mt-0.5">{rows.length} empresa(s) en la plataforma</p>
        </div>
        <Button onClick={openCreate} icon={<Plus className="w-4 h-4" />}>Nueva empresa</Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card px-6 py-14 text-center">
          <Building2 className="w-8 h-8 text-gray-300 mx-auto" />
          <p className="text-sm text-gray-500 mt-3">Todavía no hay ninguna empresa.</p>
          <Button className="mt-4" onClick={openCreate}>Crear la primera empresa</Button>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr className="text-left">
                <th className="px-4 py-2.5 font-medium">Empresa</th>
                <th className="px-4 py-2.5 font-medium">Alta</th>
                <th className="px-4 py-2.5 font-medium">Estado</th>
                <th className="px-4 py-2.5 font-medium">Primer ingreso</th>
                <th className="px-4 py-2.5 font-medium">Último ingreso</th>
                <th className="px-4 py-2.5 font-medium text-right">Rutas</th>
                <th className="px-4 py-2.5 font-medium">Tarifa</th>
                <th className="px-4 py-2.5 font-medium">Próximo cobro</th>
                <th className="px-4 py-2.5 font-medium">Pago</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rows.map(r => (
                <tr key={r.companyId} className="hover:bg-gray-50/70">
                  <td className="px-4 py-3">
                    <button onClick={() => navigate(`/owner/empresas/${r.companyId}`)}
                      className="font-medium text-gray-900 hover:text-primary-600 hover:underline">
                      {r.nombre}
                    </button>
                    <p className="text-xs text-gray-400">{r.contactoEmail ?? '—'}</p>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{formatDate(r.createdAt)}</td>
                  <td className="px-4 py-3"><Badge variant={statusVariant(r.status)} size="sm">{COMMERCIAL_STATUS_LABEL[r.status]}</Badge></td>
                  <td className="px-4 py-3 text-gray-600">{r.firstLoginAt ? formatDateTime(r.firstLoginAt) : '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{r.lastLoginAt ? formatDateTime(r.lastLoginAt) : '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <span className="font-semibold text-gray-900">{r.billableRouteCount}</span>
                    <span className="text-gray-400"> / {r.routeCount}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {formatCurrency(r.billingRate)}
                    <span className="text-xs text-gray-400"> · {BILLING_MODE_LABEL[r.billingMode]}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {r.nextBillingDate ? formatDate(r.nextBillingDate) : '—'}
                    <p className="text-xs text-gray-400">Esperado {formatCurrency(expectedPeriodAmount(r))}</p>
                  </td>
                  <td className="px-4 py-3"><Badge variant={payVariant(r.paymentStatus)} size="sm">{SAAS_PAYMENT_STATUS_LABEL[r.paymentStatus]}</Badge></td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => toggleStatus(r)}
                      className={`text-xs font-medium hover:underline ${r.status === 'suspended' ? 'text-emerald-600' : 'text-red-600'}`}>
                      {r.status === 'suspended' ? 'Reactivar' : 'Suspender'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* --- Alta de empresa + primer Super Admin --- */}
      <Modal open={modalOpen} onClose={() => !saving && setModalOpen(false)} title="Nueva empresa"
        footer={<>
          <Button variant="secondary" onClick={() => setModalOpen(false)} disabled={saving}>Cancelar</Button>
          <Button onClick={handleCreate} loading={saving}>Crear empresa</Button>
        </>}>
        <div className="space-y-4">
          <p className="text-xs text-gray-500">
            Datos comerciales mínimos y la cuenta del primer Super Admin. La empresa se
            configura después desde su propio panel.
          </p>
          <Input label="Nombre de la empresa" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required />
          <Input label="Correo de la empresa" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Identificación / NIT" value={form.identificacion} onChange={e => setForm(f => ({ ...f, identificacion: e.target.value }))} />
            <Input label="Contacto principal" value={form.contacto} onChange={e => setForm(f => ({ ...f, contacto: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Estado comercial" value={form.status}
              onChange={e => setForm(f => ({ ...f, status: e.target.value as 'trial' | 'active' }))}
              options={[{ value: 'trial', label: 'Prueba' }, { value: 'active', label: 'Activa' }]} />
            <Select label="Modo de cobro" value={form.billingMode}
              onChange={e => setForm(f => ({ ...f, billingMode: e.target.value as 'per_route' | 'fixed' }))}
              options={[{ value: 'per_route', label: 'Por ruta' }, { value: 'fixed', label: 'Tarifa fija' }]} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Tarifa" type="number" value={form.billingRate} onChange={e => setForm(f => ({ ...f, billingRate: e.target.value }))} />
            {/* FECHA DE CREACIÓN — informativa y de solo lectura.
                Se deriva de `today()` en cada render, así que aparece ya diligenciada
                al abrir el formulario y no puede quedarse obsoleta si el modal se deja
                abierto. NO vive en el estado del formulario ni se envía al servicio:
                la fecha que se persiste es la que sella `createCompanyWithFirstSuperAdmin`
                con `nowISO()` al escribir, no lo que muestre este campo.
                Aquí NO va «Próximo cobro»: ese dato es de gestión comercial y se
                administra después desde la ficha de la empresa y desde Cobros. */}
            <Input label="Fecha de creación" type="text" readOnly value={formatDate(today())}
              className="bg-gray-50 text-gray-500 cursor-default"
              hint="Se registra automáticamente al crear la empresa." />
          </div>

          <div className="pt-3 border-t border-gray-100 space-y-3">
            <p className="text-sm font-semibold text-gray-800">Primer Super Admin</p>
            <Input label="Nombre" value={form.adminNombre} onChange={e => setForm(f => ({ ...f, adminNombre: e.target.value }))} required />
            <Input label="Correo (usuario de acceso)" type="email" value={form.adminEmail} onChange={e => setForm(f => ({ ...f, adminEmail: e.target.value }))} required />
            <Input label="Contraseña inicial" value={form.adminPassword} onChange={e => setForm(f => ({ ...f, adminPassword: e.target.value }))}
              hint="La usará tal cual para entrar por /login. No se le pedirá cambiarla." />
          </div>
        </div>
      </Modal>

      {/* --- Entrega de credenciales (se muestran una sola vez) --- */}
      <Modal open={!!credenciales} onClose={() => setCredenciales(null)} title="Credenciales del Super Admin"
        footer={<Button onClick={() => setCredenciales(null)}>Listo</Button>}>
        {credenciales && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Empresa <span className="font-semibold text-gray-900">{credenciales.empresa}</span> creada.
              Entrega estos datos al cliente: entrará por <span className="font-mono">/login</span>.
            </p>
            <div className="rounded-xl bg-gray-50 border border-gray-200 p-4 space-y-2 font-mono text-sm">
              <p><span className="text-gray-400">usuario:</span> {credenciales.email}</p>
              <p><span className="text-gray-400">clave:</span> {credenciales.password}</p>
            </div>
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3">
              Anótala ahora. La contraseña no vuelve a mostrarse en ninguna pantalla; si
              se pierde, el Super Admin la restablece desde Usuarios.
            </p>
          </div>
        )}
      </Modal>

      {saving && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/10 pointer-events-none">
          <Loader2 className="w-6 h-6 animate-spin text-gray-700" />
        </div>
      )}
    </div>
  )
}
