import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Settings, RefreshCw, Download, AlertTriangle, Building2, RotateCcw } from 'lucide-react'
import { IS_CLEAN } from '@/lib/appMode'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { resetLocalAppData } from '@/lib/resetApp'
import { exportJSON } from '@/lib/utils'
import { nowISO } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import type { Tenant } from '@/models/types'

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
  const { user, selectTenant } = useAuth()
  const { tenantId } = useTenant()

  const navigate = useNavigate()
  const [resetOpen, setResetOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [savingTenant, setSavingTenant] = useState(false)
  const [cleanResetOpen, setCleanResetOpen] = useState(false)
  const [cleanResetting, setCleanResetting] = useState(false)

  const [form, setForm] = useState({
    nombre: '', nombreLegal: '', nit: '',
    pais: 'Colombia', ciudad: '', moneda: 'COP',
    telefono: '', email: '', direccion: '', responsable: '',
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
      })
    })
  }, [tenantId])

  async function handleSaveTenant() {
    if (!form.nombre.trim()) { toast.error('El nombre de la empresa es obligatorio'); return }
    if (!form.pais.trim() || !form.moneda.trim()) { toast.error('País y moneda son obligatorios'); return }
    setSavingTenant(true)
    try {
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
      await db.tenants.update(tenantId, updates)
      const updated = await db.tenants.get(tenantId)
      if (updated) selectTenant(updated)
      if (user) await logAction({ tenantId, userId: user.id, action: 'UPDATE_TENANT', entityType: 'Tenant', entityId: tenantId, descripcion: `Empresa actualizada: ${form.nombre.trim()}` })
      toast.success('Datos de la empresa guardados')
    } catch { toast.error('Error al guardar') } finally { setSavingTenant(false) }
  }

  // CLEAN: restablece la app por completo (borra TODOS los datos locales) y
  // recarga en /login; la semilla limpia se vuelve a inicializar desde cero.
  async function handleCleanReset() {
    setCleanResetting(true)
    try {
      await resetLocalAppData()
      toast.success('App restablecida. Iniciando limpia…')
      // Redirección dura: recarga el documento y reinicializa la semilla CLEAN.
      setTimeout(() => location.replace('/login'), 800)
    } catch {
      toast.error('Error al restablecer la app')
      setCleanResetting(false)
    }
  }

  // DEMO/CLEAN: borra todos los datos locales y recarga. En DEMO la recarga
  // vuelve a sembrar los datos de demostración; en CLEAN deja la app vacía.
  async function handleReset() {
    setResetting(true)
    try {
      await resetLocalAppData()
      toast.success(IS_CLEAN ? 'App restablecida. Recargando…' : 'Restaurando datos demo…')
      setTimeout(() => location.replace('/login'), 800)
    } catch {
      toast.error('Error al reiniciar')
      setResetting(false)
    }
  }

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

  const showEmpresaForm = !!tenantId && user?.rol !== 'superadmin'

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

      {/* Restablecer app limpia — solo en modo LIMPIO (zona de control local) */}
      {IS_CLEAN && (
        <div className="bg-white rounded-2xl shadow-card border border-red-100 p-5">
          <h2 className="font-semibold text-gray-800 flex items-center gap-2 mb-1">
            <RotateCcw className="w-4 h-4 text-red-600" />
            Restablecer app limpia
          </h2>
          <p className="text-xs text-gray-500 mb-4">
            Borra <span className="font-medium">todos los datos locales de RutaCash en este navegador</span>
            {' '}(rutas, clientes, ventas, abonos, gastos y sesión) y deja la app lista para comenzar
            desde cero. Solo afecta a este navegador; no toca otros equipos.
          </p>
          <div className="flex items-center justify-between p-3 bg-red-50 rounded-xl border border-red-100">
            <div className="min-w-0">
              <p className="text-sm font-medium text-red-800">Dejar la app en cero</p>
              <p className="text-xs text-red-600 mt-0.5">
                Tras restablecer, queda solo el administrador inicial y las categorías base.
              </p>
            </div>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setCleanResetOpen(true)}
              icon={<RotateCcw className="w-3.5 h-3.5" />}
              className="ml-4 flex-shrink-0"
            >
              Restablecer app limpia
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Datos del sistema */}
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 space-y-4">
          <h2 className="font-semibold text-gray-800 flex items-center gap-2"><Settings className="w-4 h-4" /> Datos del sistema</h2>
          <div className="space-y-3">
            {/* En CLEAN el restablecimiento vive en su tarjeta dedicada arriba. */}
            {!IS_CLEAN && (
              <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-xl border border-amber-100">
                <RefreshCw className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-amber-800">Restaurar datos demo</p>
                  <p className="text-xs text-amber-600 mt-0.5">
                    Borra todos los datos actuales y restaura los datos de demostración originales
                  </p>
                  <Button variant="danger" size="sm" onClick={() => setResetOpen(true)} className="mt-2">
                    Restaurar demo
                  </Button>
                </div>
              </div>
            )}
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
          {IS_CLEAN ? (
            <div className="flex items-start gap-3 p-4 bg-primary-50 rounded-xl border border-primary-100">
              <Building2 className="w-4 h-4 text-primary-600 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-primary-800">Administra tus propios usuarios</p>
                <p className="text-xs text-primary-600 mt-1">
                  Esta es tu empresa. Crea los usuarios que necesites: cobradores, supervisores y administradores desde el módulo de Usuarios.
                </p>
                <p className="text-xs text-gray-500 mt-1">Usuario inicial: <span className="font-medium">admin@demo.com</span> / 123456</p>
                <button onClick={() => navigate('/admin/users')} className="mt-2 text-xs font-semibold text-primary-600 hover:underline">Ir a Usuarios →</button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { email: 'superadmin@demo.com', rol: 'Super Admin', pass: '123456' },
                { email: 'admin@demo.com', rol: 'Administrador', pass: '123456' },
                { email: 'supervisor@demo.com', rol: 'Supervisor', pass: '123456' },
                { email: 'cobrador@demo.com', rol: 'Cobrador', pass: '123456' },
              ].map(u => (
                <div key={u.email} className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs font-semibold text-gray-700">{u.rol}</p>
                  <p className="text-xs text-gray-500 mt-0.5 break-all">{u.email}</p>
                  <p className="text-xs text-gray-400">Pass: {u.pass}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal open={resetOpen} onClose={() => setResetOpen(false)} title={IS_CLEAN ? 'Confirmar restablecimiento' : 'Confirmar restauración'}
        footer={<><Button variant="secondary" onClick={() => setResetOpen(false)}>Cancelar</Button><Button variant="danger" onClick={handleReset} loading={resetting} icon={<AlertTriangle className="w-4 h-4" />}>Sí, {IS_CLEAN ? 'restablecer' : 'restaurar'}</Button></>}>
        <div className="space-y-3">
          <div className="flex items-center gap-3 p-3 bg-red-50 rounded-xl">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
            <p className="text-sm text-red-700">Esta acción eliminará TODOS los datos actuales y no se puede deshacer.</p>
          </div>
          <p className="text-sm text-gray-600">
            {IS_CLEAN
              ? 'La app volverá al estado inicial limpio y la página se recargará.'
              : 'Se restaurarán los datos demo originales y la página se recargará.'}
          </p>
        </div>
      </Modal>

      {/* Modal: Restablecer app limpia */}
      <Modal
        open={cleanResetOpen}
        onClose={() => !cleanResetting && setCleanResetOpen(false)}
        title="Restablecer app limpia"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCleanResetOpen(false)} disabled={cleanResetting}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              onClick={handleCleanReset}
              loading={cleanResetting}
              disabled={cleanResetting}
              icon={<RotateCcw className="w-4 h-4" />}
            >
              Sí, restablecer
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="flex items-start gap-3 p-3 bg-red-50 rounded-xl">
            <AlertTriangle className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-red-700">
              Esto eliminará todos los datos locales de RutaCash en este navegador (rutas, clientes,
              ventas, parcelas, abonos, gastos y la sesión actual) y dejará la app limpia desde cero.
              <span className="font-semibold"> Esta acción no se puede deshacer.</span>
            </p>
          </div>
          <p className="text-xs text-gray-500">
            Solo afecta a este navegador. Quedará el administrador inicial
            (<span className="font-medium">admin@demo.com / 123456</span>) y las categorías base; la
            app se recargará en la pantalla de inicio de sesión.
          </p>
        </div>
      </Modal>
    </div>
  )
}
