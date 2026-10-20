// ADEX Online: COPIA de la OwnerCompaniesPage original de CLEAN (src/pages/owner/OwnerCompaniesPage.tsx).
// Misma tabla, columnas, alta y modales. Cambios, marcados con «ADEX Online:»:
//   · el alta fija PAÍS, MONEDA y ZONA HORARIA (solo las que el servidor admite: COP y BRL);
//   · el primer Super Admin no recibe una contraseña inventada por el Owner: recibe un
//     ENLACE DE PRIMER ACCESO de un solo uso para fijar la suya (nadie más la conoce);
//   · Ronda 50: búsqueda, filtro por estado y orden; en móvil, tarjetas en vez de tabla.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Building2, Loader2, Search } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { CompanyStatusConfirmModal } from '@/components/owner/CompanyStatusConfirmModal'
import { toast } from '@/components/ui/Toast'
import { formatCurrency, formatDate, formatDateTime, today } from '@/lib/formatters'
import { useOwnerAuth } from '@/hooks/useOwnerAuth'
import { controlPlane } from '@/platform/controlPlane'
import { expectedPeriodAmount, BILLING_MODE_LABEL } from '@/platform/billing'
import { createCompanyWithFirstSuperAdmin, setCompanyCommercialStatus } from '@/platform/companyControlService'
// ADEX Online: opciones reales del servidor y resultado del alta con enlace de primer acceso.
import { ONLINE_COUNTRIES, ONLINE_CURRENCIES, type AccessLinkResult, type OnlineCreateCompanyResult } from '@/platform/companyControlService'
import { AccessLinkPanel } from '@/pages/owner/AccessLinkPanel'
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
  // Ronda 48 (H-01): el cambio de estado comercial pasa siempre por una confirmación.
  const [statusTarget, setStatusTarget] = useState<CompanyControlRecord | null>(null)
  // ADEX Online: entrega del ENLACE de primer acceso (no de una contraseña).
  const [credenciales, setCredenciales] = useState<{ empresa: string; email: string; access: AccessLinkResult } | null>(null)

  const emptyForm = {
    nombre: '', email: '', identificacion: '', contacto: '',
    status: 'trial' as 'trial' | 'active',
    billingMode: 'per_route' as 'per_route' | 'fixed',
    billingRate: '',
    // ADEX Online: sin contraseña inicial; país, moneda y zona horaria de la empresa.
    adminNombre: '', adminEmail: '',
    pais: 'CO' as string, moneda: 'COP' as string, zonaHoraria: 'America/Bogota' as string,
  }
  const [form, setForm] = useState(emptyForm)
  // ADEX Online (Ronda 50): búsqueda, filtro y orden del listado (solo presentación).
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | CompanyControlRecord['status'] | 'overdue'>('all')
  const [sort, setSort] = useState<'name' | 'created' | 'lastLogin' | 'nextBilling'>('name')
  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('es')
    const list = rows.filter(r =>
      (!q || r.nombre.toLocaleLowerCase('es').includes(q) || (r.contactoEmail ?? '').toLocaleLowerCase('es').includes(q))
      && (statusFilter === 'all' || (statusFilter === 'overdue' ? r.paymentStatus === 'overdue' : r.status === statusFilter)))
    const time = (v: string | null | undefined, empty: number) => (v ? Date.parse(v) : empty)
    return [...list].sort((a, b) =>
      sort === 'created' ? time(b.createdAt, 0) - time(a.createdAt, 0)
      : sort === 'lastLogin' ? time(b.lastLoginAt, 0) - time(a.lastLoginAt, 0)
      : sort === 'nextBilling' ? time(a.nextBillingDate, Infinity) - time(b.nextBillingDate, Infinity)
      : a.nombre.localeCompare(b.nombre, 'es'))
  }, [rows, query, statusFilter, sort])

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setRows(await controlPlane.listCompanies())
    setLoading(false)
  }

  function openCreate() {
    setForm({ ...emptyForm })
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
        // ADEX Online: país, moneda y zona horaria (se fijan en el alta y no cambian después).
        pais: form.pais,
        moneda: form.moneda,
        zonaHoraria: form.zonaHoraria,
        // `nextBillingDate` NO se define en el alta: es gestión comercial posterior.
        // El servicio lo deja vacío y se fija luego desde la ficha de la empresa.
        superAdmin: {
          nombre: form.adminNombre,
          email: form.adminEmail,
          password: '',
        },
      } as Parameters<typeof createCompanyWithFirstSuperAdmin>[1],
      provisioningDatabase,
    ) as unknown as OnlineCreateCompanyResult
    setSaving(false)
    if (!result.ok) { toast.error(result.message); return }
    setModalOpen(false)
    // ADEX Online: ENTREGA DEL ENLACE de primer acceso. Se muestra UNA vez, aquí; no se
    // guarda en ninguna parte. Si se pierde o caduca, se genera otro desde la ficha.
    setCredenciales({ empresa: result.tenant.nombre, email: result.superAdmin.email, access: result.access })
    await load()
  }

  async function toggleStatus(r: CompanyControlRecord): Promise<boolean> {
    if (!owner) return false
    const next = r.status === 'suspended' ? 'active' : 'suspended'
    const res = await setCompanyCommercialStatus(owner, r.companyId, next, statusDatabase)
    if (!res.ok) { toast.error(res.error ?? 'No se pudo cambiar el estado'); return false }
    toast.success(next === 'suspended' ? 'Servicio suspendido' : 'Servicio reactivado')
    await load()
    return true
  }

  const statusVariant = (s: CompanyControlRecord['status']) =>
    s === 'active' ? 'success' : s === 'suspended' ? 'danger' : 'warning'
  const payVariant = (s: CompanyControlRecord['paymentStatus']) =>
    s === 'paid' ? 'success' : s === 'overdue' ? 'danger' : 'warning'

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Empresas</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {visible.length === rows.length ? `${rows.length} empresa(s) en la plataforma` : `${visible.length} de ${rows.length} empresa(s)`}
          </p>
        </div>
        <Button onClick={openCreate} icon={<Plus className="w-4 h-4" />}>Nueva empresa</Button>
      </div>

      {rows.length > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-end gap-3" data-testid="owner-companies-toolbar">
          <Input containerClassName="w-full sm:flex-1" aria-label="Buscar empresa" placeholder="Buscar por nombre o correo"
            leftIcon={<Search className="w-4 h-4" />} value={query} onChange={e => setQuery(e.target.value)} />
          <Select containerClassName="w-full sm:w-48" aria-label="Filtrar por estado" value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
            options={[{ value: 'all', label: 'Todos los estados' }, { value: 'active', label: COMMERCIAL_STATUS_LABEL.active },
              { value: 'trial', label: COMMERCIAL_STATUS_LABEL.trial }, { value: 'suspended', label: COMMERCIAL_STATUS_LABEL.suspended },
              { value: 'overdue', label: 'Pago vencido' }]} />
          <Select containerClassName="w-full sm:w-48" aria-label="Ordenar por" value={sort}
            onChange={e => setSort(e.target.value as typeof sort)}
            options={[{ value: 'name', label: 'Nombre (A–Z)' }, { value: 'created', label: 'Alta más reciente' },
              { value: 'lastLogin', label: 'Último ingreso' }, { value: 'nextBilling', label: 'Próximo cobro' }]} />
        </div>
      )}

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
      ) : visible.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card px-6 py-10 text-center">
          <p className="text-sm text-gray-500">Ninguna empresa coincide con la búsqueda o el filtro.</p>
          <Button className="mt-3" variant="secondary" size="sm" onClick={() => { setQuery(''); setStatusFilter('all') }}>Limpiar filtros</Button>
        </div>
      ) : (
        <>
        {/* Móvil: una tarjeta por empresa, sin desplazamiento horizontal. */}
        <ul className="md:hidden space-y-3" data-testid="owner-companies-cards">
          {visible.map(r => (
            <li key={r.companyId} className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <button onClick={() => navigate(`/owner/empresas/${r.companyId}`)} className="text-left min-w-0">
                  <span className="block font-semibold text-gray-900 hover:text-primary-600 [overflow-wrap:anywhere]">{r.nombre}</span>
                  <span className="block text-xs text-gray-500 [overflow-wrap:anywhere]">{r.contactoEmail ?? '—'}</span>
                </button>
                <Badge variant={statusVariant(r.status)} size="sm">{COMMERCIAL_STATUS_LABEL[r.status]}</Badge>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                <div><dt className="text-gray-500">Rutas</dt><dd className="font-semibold text-gray-900 tabular-nums">{r.billableRouteCount} / {r.routeCount}</dd></div>
                <div><dt className="text-gray-500">Pago</dt><dd><Badge variant={payVariant(r.paymentStatus)} size="sm">{SAAS_PAYMENT_STATUS_LABEL[r.paymentStatus]}</Badge></dd></div>
                <div><dt className="text-gray-500">Próximo cobro</dt><dd className="text-gray-800 tabular-nums">{r.nextBillingDate ? formatDate(r.nextBillingDate) : '—'}</dd></div>
                <div><dt className="text-gray-500">Esperado</dt><dd className="text-gray-800 tabular-nums">{formatCurrency(expectedPeriodAmount(r))}</dd></div>
                <div className="col-span-2"><dt className="text-gray-500">Último ingreso</dt><dd className="text-gray-800">{r.lastLoginAt ? formatDateTime(r.lastLoginAt) : '—'}</dd></div>
              </dl>
              <div className="flex items-center justify-between border-t border-gray-100 pt-3">
                <button onClick={() => navigate(`/owner/empresas/${r.companyId}`)} className="text-sm font-medium text-primary-600">Ver ficha</button>
                <button onClick={() => setStatusTarget(r)}
                  className={`text-sm font-medium ${r.status === 'suspended' ? 'text-emerald-600' : 'text-red-600'}`}>
                  {r.status === 'suspended' ? 'Reactivar' : 'Suspender'}
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="hidden md:block bg-white rounded-2xl shadow-card border border-gray-100 overflow-x-auto">
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
              {visible.map(r => (
                <tr key={r.companyId} className="hover:bg-gray-50/70">
                  <td className="px-4 py-3">
                    <button onClick={() => navigate(`/owner/empresas/${r.companyId}`)}
                      className="font-medium text-gray-900 hover:text-primary-600 hover:underline">
                      {r.nombre}
                    </button>
                    <p className="text-xs text-gray-500">{r.contactoEmail ?? '—'}</p>
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
                    <span className="text-xs text-gray-500"> · {BILLING_MODE_LABEL[r.billingMode]}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {r.nextBillingDate ? formatDate(r.nextBillingDate) : '—'}
                    <p className="text-xs text-gray-500">Esperado {formatCurrency(expectedPeriodAmount(r))}</p>
                  </td>
                  <td className="px-4 py-3"><Badge variant={payVariant(r.paymentStatus)} size="sm">{SAAS_PAYMENT_STATUS_LABEL[r.paymentStatus]}</Badge></td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => setStatusTarget(r)}
                      className={`text-xs font-medium hover:underline ${r.status === 'suspended' ? 'text-emerald-600' : 'text-red-600'}`}>
                      {r.status === 'suspended' ? 'Reactivar' : 'Suspender'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
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
          {/* ADEX Online: país, moneda y zona horaria (solo las que el servidor admite). */}
          <div className="grid grid-cols-2 gap-3">
            <Select label="País" value={form.pais}
              onChange={e => {
                const c = ONLINE_COUNTRIES.find(x => x.code === e.target.value)!
                setForm(f => ({ ...f, pais: c.code, moneda: c.currency, zonaHoraria: c.timezones[0] }))
              }}
              options={ONLINE_COUNTRIES.map(c => ({ value: c.code, label: c.label }))} />
            <Select label="Moneda" value={form.moneda}
              onChange={e => setForm(f => ({ ...f, moneda: e.target.value }))}
              options={ONLINE_CURRENCIES.map(m => ({ value: m, label: m }))} />
          </div>
          <Select label="Zona horaria" value={form.zonaHoraria}
            onChange={e => setForm(f => ({ ...f, zonaHoraria: e.target.value }))}
            options={(ONLINE_COUNTRIES.find(c => c.code === form.pais)?.timezones ?? []).map(z => ({ value: z, label: z.replace('America/', '').replace('_', ' ') }))}
            hint="Define la fecha de negocio de la empresa. No se cambia después del alta." />
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
            {/* ADEX Online: sin contraseña inicial: el Super Admin fija la suya con un enlace de un solo uso. */}
            <p className="text-xs text-gray-500">
              Al crear la empresa se genera un enlace de primer acceso de un solo uso. El Super Admin
              fija con él su propia contraseña: nadie más la conoce.
            </p>
          </div>
        </div>
      </Modal>

      {/* --- Entrega de credenciales (se muestran una sola vez) --- */}
      {/* ADEX Online: se entrega el ENLACE de primer acceso, no una contraseña. */}
      <Modal open={!!credenciales} onClose={() => setCredenciales(null)} title="Acceso del Super Admin"
        footer={<Button onClick={() => setCredenciales(null)}>Listo</Button>}>
        {credenciales && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Empresa <span className="font-semibold text-gray-900">{credenciales.empresa}</span> creada.
              Super Admin: <span className="font-mono">{credenciales.email}</span>
            </p>
            <AccessLinkPanel result={credenciales.access} />
          </div>
        )}
      </Modal>

      <CompanyStatusConfirmModal target={statusTarget} onClose={() => setStatusTarget(null)}
        onConfirm={() => statusTarget ? toggleStatus(statusTarget) : Promise.resolve(false)} />

      {saving && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/10 pointer-events-none">
          <Loader2 className="w-6 h-6 animate-spin text-gray-700" />
        </div>
      )}
    </div>
  )
}
