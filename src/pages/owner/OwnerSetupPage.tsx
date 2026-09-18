import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, ShieldCheck, LifeBuoy, Eye, EyeOff, Trash2 } from 'lucide-react'
import { useOwnerAuth } from '@/hooks/useOwnerAuth'
import { toast, useToastStore } from '@/components/ui/Toast'
import { rememberLoginEmail } from '@/lib/lastLoginEmail'
import {
  createFirstOwner, MIN_BOOTSTRAP_PASSWORD_LENGTH,
  type InstallationState,
} from '@/services/platformBootstrapService'
import { FullResetDialog } from '@/components/ui/FullResetDialog'

/**
 * CONFIGURACIÓN INICIAL DE LA PLATAFORMA.
 *
 * Se muestra en lugar del login del portal Owner cuando la instalación no tiene
 * ningún Owner. Cubre dos situaciones:
 *   · `empty`    → instalación nueva: se crea la cuenta de plataforma.
 *   · `orphaned` → instalación con datos (empresas, usuarios) pero sin dueño de
 *                  plataforma: RECUPERACIÓN. Se crea únicamente el Owner; no se toca
 *                  ni un usuario, empresa o dato existente.
 *
 * La persona elige su propio correo y su propia contraseña: RutaCash nunca genera una
 * cuenta raíz con credenciales conocidas.
 *
 * Aquí TERMINA el arranque de la plataforma. La primera empresa y su primer Super
 * Admin se crean después, ya dentro del portal: no hay wizard encadenado.
 */
export function OwnerSetupPage({ state, onDone }: { state: InstallationState; onDone: () => void }) {
  const navigate = useNavigate()
  const login = useOwnerAuth(s => s.login)
  const [form, setForm] = useState({ nombre: '', email: '', password: '', confirmPassword: '' })
  const [showPass, setShowPass] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [resetOpen, setResetOpen] = useState(false)

  const esRecuperacion = state.status === 'orphaned'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')

    const result = await createFirstOwner(form)
    if (!result.ok) {
      setError(result.message)
      setSaving(false)
      return
    }

    // El correo queda recordado aunque el acceso automático fallara: es justo el dato
    // que la persona necesita si vuelve al login y no lo tiene a mano.
    const correo = result.owner.email
    rememberLoginEmail(correo)

    // Se inicia sesión por la MISMA vía que cualquier otro acceso Owner
    // (`useOwnerAuth.login` → `authenticateOwner`): no se crea una sesión por un
    // camino paralelo. Y como la contraseña se confirmó en el formulario, no hay
    // riesgo de quedar fuera por una errata.
    const sesion = await login(correo, form.password)
    setSaving(false)
    onDone()

    useToastStore.getState().add({
      type: 'success',
      message: `Cuenta de plataforma creada · Owner: ${correo}`,
      duration: 15000,
    })

    if (sesion.success) navigate('/owner')
    else {
      toast.info('Inicia sesión con el correo que acabas de crear.')
      navigate('/owner/login')
    }
  }

  const input = 'w-full h-11 rounded-xl border border-gray-300 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-gray-800'
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-[#0B1220] to-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-6 justify-center">
          <div className="w-11 h-11 bg-white rounded-2xl flex items-center justify-center">
            <span className="text-gray-900 font-bold text-lg">RC</span>
          </div>
          <div className="text-white">
            <p className="font-bold text-lg leading-tight">RutaCash</p>
            <p className="text-gray-400 text-xs">Gestión de la plataforma</p>
          </div>
        </div>

        <div className="bg-white rounded-3xl shadow-2xl p-8">
          <div className="flex items-center gap-2 mb-1">
            {esRecuperacion
              ? <LifeBuoy className="w-5 h-5 text-amber-600" />
              : <ShieldCheck className="w-5 h-5 text-gray-700" />}
            <h1 className="text-2xl font-bold text-gray-900">
              {esRecuperacion ? 'Recuperar instalación' : 'Configurar RutaCash'}
            </h1>
          </div>

          {esRecuperacion ? (
            <div className="mt-3 mb-5 rounded-xl bg-amber-50 border border-amber-200 p-3.5">
              <p className="text-sm text-amber-800 font-medium">
                Esta instalación tiene datos pero ninguna cuenta de plataforma.
              </p>
              <p className="text-xs text-amber-700 mt-1.5">
                Crea el Owner para recuperar el control. No se modificará nada de lo que
                ya existe:
              </p>
              <ul className="text-xs text-amber-700 mt-2 space-y-0.5 list-disc list-inside">
                <li>{state.userCount} usuario(s) de empresa, con sus contraseñas intactas</li>
                <li>{state.companyCount} empresa(s): {state.existingCompanyNames.join(', ') || '—'}</li>
                <li>Rutas, clientes, ventas y pagos se conservan</li>
              </ul>
            </div>
          ) : (
            <p className="text-gray-500 text-sm mt-2 mb-5">
              Crea la cuenta de plataforma. Desde ella darás de alta las empresas
              clientes y su primer Super Admin.
            </p>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Nombre</label>
              <input className={input} value={form.nombre} onChange={set('nombre')} placeholder="Nombre y apellido" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Correo electrónico</label>
              <input className={input} type="email" autoComplete="username" value={form.email} onChange={set('email')} placeholder="correo@ejemplo.com" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Contraseña</label>
              <div className="relative">
                <input className={`${input} pr-11`} type={showPass ? 'text' : 'password'} autoComplete="new-password"
                  value={form.password} onChange={set('password')} placeholder={`Mínimo ${MIN_BOOTSTRAP_PASSWORD_LENGTH} caracteres`} />
                <button type="button" onClick={() => setShowPass(!showPass)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Confirmar contraseña</label>
              <input className={input} type={showPass ? 'text' : 'password'} autoComplete="new-password"
                value={form.confirmPassword} onChange={set('confirmPassword')} placeholder="Repite la contraseña" />
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">{error}</div>
            )}

            <button type="submit" disabled={saving}
              className="w-full h-11 bg-gray-900 hover:bg-black text-white rounded-xl font-medium text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-60">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {saving ? 'Creando...' : esRecuperacion ? 'Recuperar instalación (conserva los datos)' : 'Crear cuenta de plataforma'}
            </button>
          </form>

          {/* SEGUNDO CAMINO — SOLO EN RECUPERACIÓN. En una instalación virgen no hay
              nada que borrar, así que ofrecerlo sería ruido peligroso. */}
          {esRecuperacion && (
            <div className="mt-8 pt-5 border-t border-gray-100 text-center">
              <p className="text-xs text-gray-400">¿Prefieres empezar de cero?</p>
              <button type="button" onClick={() => setResetOpen(true)}
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-red-600 hover:text-red-700 hover:underline">
                <Trash2 className="w-3.5 h-3.5" />
                Empezar desde cero (elimina los datos locales)
              </button>
              <p className="text-[11px] text-gray-400 mt-1.5">
                Elimina todos los datos de RutaCash de este dispositivo.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Mismo diálogo destructivo que el login y Configuración. */}
      <FullResetDialog open={resetOpen} onClose={() => setResetOpen(false)} />
    </div>
  )
}
