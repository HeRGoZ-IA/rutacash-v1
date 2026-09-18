import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Settings, Download, Building2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { exportJSON } from '@/lib/utils'
import { nowISO, today } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import { can } from '@/lib/permissions'
import type { Tenant, TenantStatus } from '@/models/types'

// Monedas de Suramérica y Centroamérica (Paquete 2.5).
// La moneda guardada sigue siendo el código ISO (string), 100% compatible
// con tenants existentes; solo se amplió la lista de opciones visibles.
const MONEDAS = [
  { value: 'COP', label: 'COP - Peso colombiano' },
  { value: 'USD', label: 'USD - Dólar estadounidense' },
  { value: 'EUR', label: 'EUR - Euro' },
  { value: 'MXN', label: 'MXN - Peso mexicano' },
  { value: 'PEN', label: 'PEN - Sol peruano' },
  { value: 'ARS', label: 'ARS - Peso argentino' },
  { value: 'VES', label: 'VES - Bolívar venezolano' },
  { value: 'CLP', label: 'CLP - Peso chileno' },
  { value: 'BRL', label: 'BRL - Real brasileño' },
  { value: 'UYU', label: 'UYU - Peso uruguayo' },
  { value: 'PYG', label: 'PYG - Guaraní paraguayo' },
  { value: 'BOB', label: 'BOB - Boliviano' },
  { value: 'CRC', label: 'CRC - Colón costarricense' },
  { value: 'GTQ', label: 'GTQ - Quetzal guatemalteco' },
  { value: 'HNL', label: 'HNL - Lempira hondureño' },
  { value: 'NIO', label: 'NIO - Córdoba nicaragüense' },
  { value: 'PAB', label: 'PAB - Balboa panameño' },
  { value: 'DOP', label: 'DOP - Peso dominicano' },
  { value: 'SVC', label: 'SVC - Colón salvadoreño' },
]

export default function SettingsPage() {
  const { user, tenant, selectTenant } = useAuth()
  const { tenantId } = useTenant()

  const navigate = useNavigate()
  const [savingTenant, setSavingTenant] = useState(false)

  // Solo el Super Admin puede editar parámetros CORPORATIVOS (estado, vigencia).
  const canEditCompany = can(user, 'company.edit', { tenantId })

  const [form, setForm] = useState({
    nombre: '', nombreLegal: '', nit: '',
    pais: 'Colombia', ciudad: '', moneda: 'COP',
    telefono: '', email: '', direccion: '', responsable: '',
    // Campos corporativos (solo Super Admin).
    status: 'activa' as TenantStatus,
    vigencia: 'sin' as 'sin' | 'con',
    fechaVencimiento: '',
  })

  useEffect(() => {
    if (!tenantId) return
    db.tenants.get(tenantId).then(t => {
      if (!t) return
      setForm({
        nombre: t.nombre,
        nombreLegal: t.nombreLegal ?? '',
        nit: t.nit ?? '',
        pais: t.pais,
        ciudad: t.ciudad ?? '',
        moneda: t.moneda,
        telefono: t.telefono ?? '',
        email: t.email,
        direccion: t.direccion ?? '',
        responsable: t.responsable ?? '',
        status: t.status,
        vigencia: t.fechaVencimiento ? 'con' : 'sin',
        fechaVencimiento: t.fechaVencimiento ?? '',
      })
    })
  }, [tenantId])

  async function handleSaveTenant() {
    if (!form.nombre.trim()) { toast.error('El nombre de la empresa es obligatorio'); return }
    if (!form.pais.trim() || !form.moneda.trim()) { toast.error('País y moneda son obligatorios'); return }
    // Vigencia (#7): si es "con fecha", la fecha es obligatoria y no puede ser pasada.
    if (canEditCompany && form.vigencia === 'con') {
      if (!form.fechaVencimiento) { toast.error('Indica la fecha de vencimiento'); return }
      if (form.fechaVencimiento < today()) { toast.error('La fecha de vencimiento no puede ser anterior a hoy'); return }
    }
    setSavingTenant(true)
    try {
      const prev = await db.tenants.get(tenantId)
      const updates: Partial<Tenant> = {
        nombre: form.nombre.trim(),
        nombreLegal: form.nombreLegal || undefined,
        nit: form.nit || undefined,
        pais: form.pais.trim(),
        ciudad: form.ciudad.trim() || undefined,
        moneda: form.moneda,
        telefono: form.telefono || undefined,
        email: form.email,
        direccion: form.direccion || undefined,
        responsable: form.responsable || undefined,
        updatedAt: nowISO(),
      }
      // Parámetros corporativos: SOLO si el actor tiene company.edit (Super Admin).
      if (canEditCompany) {
        updates.status = form.status
        updates.fechaVencimiento = form.vigencia === 'con' ? form.fechaVencimiento : undefined
      }
      await db.tenants.update(tenantId, updates)
      const updated = await db.tenants.get(tenantId)
      if (updated) selectTenant(updated)
      if (user) await logAction({
        tenantId, userId: user.id, userRole: user.rol,
        action: 'UPDATE_TENANT', entityType: 'Tenant', entityId: tenantId,
        descripcion: `Empresa actualizada: ${form.nombre.trim()}`,
        before: prev ? { nombre: prev.nombre, email: prev.email, pais: prev.pais, status: prev.status, fechaVencimiento: prev.fechaVencimiento ?? null } : undefined,
        after: { nombre: updates.nombre, email: updates.email, pais: updates.pais, status: updates.status ?? prev?.status, fechaVencimiento: (canEditCompany ? (updates.fechaVencimiento ?? null) : (prev?.fechaVencimiento ?? null)) },
      })
      toast.success('Datos de la empresa guardados')
    } catch { toast.error('Error al guardar') } finally { setSavingTenant(false) }
  }

  // NINGÚN ROL DE EMPRESA PUEDE BORRAR LA INSTALACIÓN. El restablecimiento de
  // fábrica es exclusivo del portal Owner y esta pantalla ni siquiera importa el
  // módulo que lo ejecuta. Antes existía aquí un "Restaurar datos demo"/"Restablecer
  // app" que desapareció junto con los modos DEMO y CLEAN.

  async function handleExport() {
    try {
      const [tenants, routes, users, clients, sales, installments, payments, expenses, capitalMovements, transfers, withdrawals] = await Promise.all([
        db.tenants.toArray(), db.routes.toArray(), db.users.toArray(),
        db.clients.toArray(), db.sales.toArray(), db.installments.toArray(), db.payments.toArray(),
        db.expenses.toArray(), db.capitalMovements.toArray(), db.transfers.toArray(), db.withdrawals.toArray(),
      ])
      exportJSON({ tenants, routes, users: users.map(u => ({ ...u, password: '***' })), clients, sales, installments, payments, expenses, capitalMovements, transfers, withdrawals, exportedAt: new Date().toISOString() }, 'rutacash-backup.json')
      toast.success('Backup exportado')
    } catch { toast.error('Error al exportar') }
  }

  // #2: el Super Admin (con empresa seleccionada) TAMBIÉN edita la empresa. Antes
  // estaba explícitamente excluido. Se muestra a quien tenga acceso a configuración
  // y haya una empresa real seleccionada (no la "platform").
  const showEmpresaForm = !!tenant && tenant.id !== 'platform' && can(user, 'settings.access', { tenantId })

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Configuración</h1>
        <p className="text-sm text-gray-500 mt-0.5">Gestiona los datos de tu empresa y opciones del sistema</p>
      </div>

      {/* Datos de la empresa */}
      {showEmpresaForm && (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
          <h2 className="font-semibold text-gray-800 flex items-center gap-2 mb-5">
            <Building2 className="w-4 h-4" />
            Datos de la empresa
          </h2>
          <div className="space-y-4">
            <Input label="Nombre de la empresa" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required placeholder="Ej: Créditos del Norte" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input label="NIT / Documento" value={form.nit} onChange={e => setForm(f => ({ ...f, nit: e.target.value }))} placeholder="Ej: 900123456-7" />
              <Select label="Moneda principal" value={form.moneda} onChange={e => setForm(f => ({ ...f, moneda: e.target.value }))} options={MONEDAS} required />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input label="País" value={form.pais} onChange={e => setForm(f => ({ ...f, pais: e.target.value }))} required placeholder="Ej: Colombia" />
              <Input label="Ciudad principal" value={form.ciudad} onChange={e => setForm(f => ({ ...f, ciudad: e.target.value }))} placeholder="Ej: Barranquilla" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input label="Teléfono" value={form.telefono} onChange={e => setForm(f => ({ ...f, telefono: e.target.value }))} placeholder="Ej: 3001234567" />
              <Input label="Email de contacto" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="admin@miempresa.com" />
            </div>
            <Input label="Responsable / Contacto principal" value={form.responsable} onChange={e => setForm(f => ({ ...f, responsable: e.target.value }))} placeholder="Nombre del propietario o encargado" />

            {/* Parámetros corporativos: SOLO Super Admin (company.edit). */}
            {canEditCompany && (
              <div className="rounded-xl border border-primary-100 bg-primary-50/40 p-4 space-y-4">
                <p className="text-xs font-semibold text-primary-700 uppercase tracking-wide">Parámetros corporativos (Super Admin)</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Select label="Estado de la empresa" value={form.status}
                    onChange={e => setForm(f => ({ ...f, status: e.target.value as TenantStatus }))}
                    options={[
                      { value: 'activa', label: 'Activa' },
                      { value: 'prueba', label: 'En prueba' },
                      { value: 'suspendida', label: 'Suspendida' },
                    ]} />
                  <Select label="Vigencia" value={form.vigencia}
                    onChange={e => setForm(f => ({ ...f, vigencia: e.target.value as 'sin' | 'con' }))}
                    options={[
                      { value: 'sin', label: 'Sin vencimiento' },
                      { value: 'con', label: 'Con fecha de vencimiento' },
                    ]} />
                </div>
                {form.vigencia === 'con' && (
                  <Input label="Fecha de vencimiento" type="date" min={today()}
                    value={form.fechaVencimiento}
                    onChange={e => setForm(f => ({ ...f, fechaVencimiento: e.target.value }))} required />
                )}
                <p className="text-xs text-gray-400">El plan comercial queda pendiente de definición; no se edita aquí.</p>
              </div>
            )}

            <div className="flex items-center justify-between pt-2 border-t border-gray-100">
              <p className="text-xs text-gray-400">
                {form.pais && form.ciudad && form.nombre && form.nombre !== 'Mi Empresa'
                  ? 'Empresa configurada correctamente'
                  : 'Completa nombre, país y ciudad para marcar este paso como hecho'}
              </p>
              <Button onClick={handleSaveTenant} loading={savingTenant}>Guardar empresa</Button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Datos del sistema */}
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 space-y-4">
          <h2 className="font-semibold text-gray-800 flex items-center gap-2"><Settings className="w-4 h-4" /> Datos del sistema</h2>
          <div className="space-y-3">
            <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
              <Download className="w-4 h-4 text-gray-600 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-gray-800">Exportar backup JSON</p>
                <p className="text-xs text-gray-500 mt-0.5">Descarga todos los datos en formato JSON</p>
                <Button variant="secondary" size="sm" onClick={handleExport} className="mt-2" icon={<Download className="w-3.5 h-3.5" />}>Exportar backup</Button>
              </div>
            </div>
          </div>
        </div>

        {/* Sobre RutaCash */}
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 space-y-4">
          <h2 className="font-semibold text-gray-800">Sobre RutaCash</h2>
          <div className="space-y-2 text-sm text-gray-600">
            <p><span className="font-medium">Versión:</span> 1.0.0 (V1 Local)</p>
            <p><span className="font-medium">Almacenamiento:</span> IndexedDB (local)</p>
            <p><span className="font-medium">Framework:</span> React + Vite + TypeScript</p>
            <p><span className="font-medium">Estilos:</span> Tailwind CSS</p>
            <p><span className="font-medium">Estado:</span> Zustand</p>
          </div>
          <div className="pt-2 border-t border-gray-100">
            <p className="text-xs text-gray-400">V2 incluirá backend Supabase, app Android nativa y más. Ver docs/future-roadmap.md</p>
          </div>
        </div>

        {/* Usuarios de acceso */}
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 md:col-span-2">
          <h2 className="font-semibold text-gray-800 mb-3">Usuarios de acceso</h2>
          <div className="flex items-start gap-3 p-4 bg-primary-50 rounded-xl border border-primary-100">
            <Building2 className="w-4 h-4 text-primary-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-primary-800">Administra tus propios usuarios</p>
              <p className="text-xs text-primary-600 mt-1">
                Esta es tu empresa. Crea los usuarios que necesites —cobradores, supervisores,
                administradores u otros Super Admin— desde el módulo de Usuarios.
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Cada usuario nace con una contraseña inicial que puedes definir tú y que la
                persona usa tal cual. RutaCash no crea ninguna cuenta por su cuenta.
              </p>
              <button onClick={() => navigate('/admin/users')} className="mt-2 text-xs font-semibold text-primary-600 hover:underline">Ir a Usuarios →</button>
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}
