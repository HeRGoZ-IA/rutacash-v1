import { useEffect, useState } from 'react'
import { AlertTriangle, Trash2, Plus, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { toast } from '@/components/ui/Toast'
import { formatDateTime } from '@/lib/formatters'
import { ENABLE_FACTORY_RESET } from '@/lib/featureFlags'
import { FactoryResetDialog } from '@/components/owner/FactoryResetDialog'
import { useOwnerAuth } from '@/hooks/useOwnerAuth'
import { controlPlane } from '@/platform/controlPlane'
import { createAdditionalOwner, MIN_BOOTSTRAP_PASSWORD_LENGTH } from '@/services/platformBootstrapService'
import type { PlatformUser } from '@/platform/types'

/**
 * CONFIGURACIÓN DEL PORTAL OWNER.
 *
 * Dos cosas, y solo dos:
 *   · Gestión de Owners. Los Owners posteriores al primero se crean AQUÍ, nunca desde
 *     `/owner/login`: esa pantalla solo permite crear el primero, cuando todavía no
 *     hay ninguno. Abrir un registro público de cuentas de plataforma sería un
 *     agujero evidente.
 *   · Zona de pruebas: restablecimiento de fábrica, la única forma de volver a cero.
 *
 * Nada de esto existe en el portal de empresa, y no por estar oculto: el portal de
 * empresa no importa ninguno de estos módulos.
 */
export default function OwnerSettingsPage() {
  const { owner, refresh } = useOwnerAuth()
  const [owners, setOwners] = useState<PlatformUser[]>([])
  const [loading, setLoading] = useState(true)
  const [resetOpen, setResetOpen] = useState(false)
  const [nuevoOpen, setNuevoOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ nombre: '', email: '', password: '', confirmPassword: '' })

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setOwners(await controlPlane.listOwners())
    setLoading(false)
  }

  async function handleCreate() {
    if (!owner) return
    setSaving(true)
    const r = await createAdditionalOwner(owner, form)
    setSaving(false)
    if (!r.ok) { toast.error(r.message); return }
    toast.success(`Owner creado: ${r.owner.email}`)
    setNuevoOpen(false)
    setForm({ nombre: '', email: '', password: '', confirmPassword: '' })
    await load()
    await refresh()
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Configuración</h1>
        <p className="text-sm text-gray-500 mt-0.5">Cuentas de plataforma y herramientas de la instalación</p>
      </div>

      {/* --- Owners --- */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-gray-600" />
            <p className="font-semibold text-gray-900 text-sm">Owners</p>
          </div>
          <Button size="sm" onClick={() => setNuevoOpen(true)} icon={<Plus className="w-3.5 h-3.5" />}>
            Nuevo Owner
          </Button>
        </div>
        {loading ? (
          <div className="flex justify-center py-10">
            <div className="w-6 h-6 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin" />
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {owners.map(o => (
              <div key={o.id} className="px-5 py-3 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {o.nombre}
                    {o.id === owner?.id && <span className="text-xs text-gray-400 font-normal"> · tú</span>}
                  </p>
                  <p className="text-xs text-gray-400 truncate">{o.email}</p>
                </div>
                <span className="text-xs text-gray-500">
                  {o.lastLoginAt ? `Último acceso ${formatDateTime(o.lastLoginAt)}` : 'Sin acceder todavía'}
                </span>
                <Badge variant={o.status === 'activo' ? 'success' : 'gray'} size="sm">{o.status}</Badge>
              </div>
            ))}
          </div>
        )}
        <p className="px-5 py-3 text-xs text-gray-400 border-t border-gray-50">
          Los Owners se crean únicamente desde aquí. La pantalla de acceso solo permite
          crear el primero, cuando la instalación aún no tiene ninguno.
        </p>
      </div>

      {/* --- Zona de pruebas --- */}
      {ENABLE_FACTORY_RESET && (
        <div className="bg-white rounded-2xl shadow-card border border-red-200 p-5">
          <h2 className="font-semibold text-red-700 flex items-center gap-2 mb-1">
            <AlertTriangle className="w-4 h-4 text-red-600" />
            Zona de pruebas
          </h2>
          <p className="text-xs text-gray-500 mb-4">
            Herramienta de esta etapa de desarrollo. Acciones irreversibles sobre los
            datos de este dispositivo.
          </p>
          <div className="flex items-center justify-between p-3.5 bg-red-50 rounded-xl border border-red-100">
            <div className="min-w-0 pr-4">
              <p className="text-sm font-medium text-red-800">Restablecer RutaCash a cero</p>
              <p className="text-xs text-red-600 mt-0.5">
                Elimina todos los datos locales, incluidos los Owners. La aplicación
                volverá a pedir la creación del primer Owner.
              </p>
            </div>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setResetOpen(true)}
              icon={<Trash2 className="w-3.5 h-3.5" />}
              className="flex-shrink-0"
            >
              Restablecer
            </Button>
          </div>
        </div>
      )}

      <Modal open={nuevoOpen} onClose={() => !saving && setNuevoOpen(false)} title="Nuevo Owner"
        footer={<>
          <Button variant="secondary" onClick={() => setNuevoOpen(false)} disabled={saving}>Cancelar</Button>
          <Button onClick={handleCreate} loading={saving}>Crear Owner</Button>
        </>}>
        <div className="space-y-4">
          <p className="text-xs text-gray-500">
            Un Owner administra la plataforma: empresas, estado comercial y cobros. No
            pertenece a ninguna empresa ni accede a su operación.
          </p>
          <Input label="Nombre" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required />
          <Input label="Correo electrónico" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required />
          <Input label="Contraseña" type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            hint={`Mínimo ${MIN_BOOTSTRAP_PASSWORD_LENGTH} caracteres`} required />
          <Input label="Confirmar contraseña" type="password" value={form.confirmPassword} onChange={e => setForm(f => ({ ...f, confirmPassword: e.target.value }))} required />
        </div>
      </Modal>

      <FactoryResetDialog open={resetOpen} onClose={() => setResetOpen(false)} />
    </div>
  )
}
