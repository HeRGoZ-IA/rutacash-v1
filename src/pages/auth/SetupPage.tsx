import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, ShieldCheck, LifeBuoy, Eye, EyeOff } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { toast } from '@/components/ui/Toast'
import {
  createFirstSuperAdmin, MIN_BOOTSTRAP_PASSWORD_LENGTH,
  type InstallationState,
} from '@/services/platformBootstrapService'
import { homePathForRole } from '@/lib/permissions'

/**
 * CONFIGURACIÓN INICIAL DE LA PLATAFORMA.
 *
 * Se muestra en lugar del login cuando la instalación no tiene ningún Super Admin.
 * Cubre dos situaciones:
 *   · `empty`    → instalación nueva: se crea la cuenta principal.
 *   · `orphaned` → instalación con datos pero sin acceso raíz: RECUPERACIÓN. Se crea
 *                  únicamente el Super Admin; no se toca ni un usuario, empresa o
 *                  dato existente.
 *
 * La persona elige su propio correo y su propia contraseña: RutaCash nunca genera
 * una cuenta raíz con credenciales conocidas.
 */
export function SetupPage({ state, onDone }: { state: InstallationState; onDone: () => void }) {
  const navigate = useNavigate()
  const login = useAuth(s => s.login)
  const [form, setForm] = useState({ nombre: '', email: '', password: '', confirmPassword: '' })
  const [showPass, setShowPass] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const esRecuperacion = state.status === 'orphaned'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')

    const result = await createFirstSuperAdmin(form)
    if (!result.ok) {
      setError(result.message)
      setSaving(false)
      return
    }

    // Se inicia sesión por la MISMA vía que cualquier otro acceso (`useAuth.login`
    // → `authenticateUser`): no se crea una sesión por un camino paralelo. Y como
    // la contraseña se confirmó en el formulario, no hay riesgo de quedar fuera por
    // una errata.
    const sesion = await login(form.email, form.password)
    setSaving(false)
    onDone()

    if (sesion.success) {
      toast.success(esRecuperacion ? 'Instalación recuperada' : 'RutaCash configurado')
      navigate(homePathForRole('superadmin'))
    } else {
      toast.success('Cuenta creada. Inicia sesión para continuar.')
      navigate('/login')
    }
  }

  const input = 'w-full h-11 rounded-xl border border-gray-300 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500'
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1E3A8A] via-gray-900 to-[#1E3A8A] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-6 justify-center">
          <div className="w-11 h-11 bg-primary-500 rounded-2xl flex items-center justify-center">
            <span className="text-white font-bold text-lg">RC</span>
          </div>
          <div className="text-white">
            <p className="font-bold text-lg leading-tight">RutaCash</p>
            <p className="text-primary-300 text-xs">Sistema de rutas y cobros</p>
          </div>
        </div>

        <div className="bg-white rounded-3xl shadow-2xl p-8">
          <div className="flex items-center gap-2 mb-1">
            {esRecuperacion
              ? <LifeBuoy className="w-5 h-5 text-amber-600" />
              : <ShieldCheck className="w-5 h-5 text-primary-600" />}
            <h1 className="text-2xl font-bold text-gray-900">
              {esRecuperacion ? 'Recuperar instalación' : 'Configurar RutaCash'}
            </h1>
          </div>

          {esRecuperacion ? (
            <div className="mt-3 mb-5 rounded-xl bg-amber-50 border border-amber-200 p-3.5">
              <p className="text-sm text-amber-800 font-medium">
                Esta instalación tiene datos pero ninguna cuenta principal.
              </p>
              <p className="text-xs text-amber-700 mt-1.5">
                Crea el Super Admin para recuperar el acceso. No se modificará nada de lo
                que ya existe:
              </p>
              <ul className="text-xs text-amber-700 mt-2 space-y-0.5 list-disc list-inside">
                <li>{state.userCount} usuario(s) existente(s), con sus contraseñas intactas</li>
                <li>{state.companyCount} empresa(s): {state.existingCompanyNames.join(', ') || '—'}</li>
                <li>Rutas, clientes, ventas y pagos se conservan</li>
              </ul>
            </div>
          ) : (
            <p className="text-gray-500 text-sm mt-2 mb-6">
              Crea la cuenta principal que administrará la plataforma. Desde ella crearás
              tu empresa, los usuarios y las rutas.
            </p>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Nombre</label>
              <input className={input} value={form.nombre} onChange={set('nombre')}
                placeholder="Nombre del responsable" autoComplete="name" autoFocus />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Correo electrónico</label>
              <input className={input} type="email" value={form.email} onChange={set('email')}
                placeholder="tucorreo@empresa.com" autoComplete="username" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Contraseña</label>
              <div className="relative">
                <input className={`${input} pr-11`} type={showPass ? 'text' : 'password'}
                  value={form.password} onChange={set('password')} autoComplete="new-password" />
                <button type="button" onClick={() => setShowPass(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-gray-400 mt-1">Mínimo {MIN_BOOTSTRAP_PASSWORD_LENGTH} caracteres. Es tu contraseña definitiva.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Confirmar contraseña</label>
              <input className={input} type={showPass ? 'text' : 'password'}
                value={form.confirmPassword} onChange={set('confirmPassword')} autoComplete="new-password" />
            </div>

            {error && (
              <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3">
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            <button type="submit" disabled={saving}
              className="w-full h-12 bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white rounded-xl font-semibold text-sm flex items-center justify-center gap-2">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {saving ? 'Creando cuenta...' : esRecuperacion ? 'Recuperar acceso' : 'Crear Super Admin'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-400 mt-5">
          RutaCash no crea cuentas automáticamente. Esta es la única forma de generar el acceso principal.
        </p>
      </div>
    </div>
  )
}
