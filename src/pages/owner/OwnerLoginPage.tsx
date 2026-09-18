import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff, Loader2, Building2 } from 'lucide-react'
import { useOwnerAuth } from '@/hooks/useOwnerAuth'

/**
 * LOGIN DEL PORTAL OWNER (`/owner/login`).
 *
 * Puerta del NIVEL PLATAFORMA. Solo acepta cuentas de `platformUsers`; ningún usuario
 * de empresa —tampoco un Super Admin— puede autenticarse aquí, porque su fila está en
 * otra tabla. La cabecera lo dice sin rodeos para que nadie se confunda de puerta.
 *
 * No hay accesos rápidos ni credenciales sugeridas, ni siquiera en DEMO: las cuentas
 * de plataforma no se anuncian en una pantalla pública.
 */
export default function OwnerLoginPage() {
  const navigate = useNavigate()
  const { login, isAuthenticated, owner } = useOwnerAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (isAuthenticated && owner) navigate('/owner', { replace: true })
  }, [isAuthenticated, owner, navigate])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) { setError('Ingresa tu correo y contraseña'); return }
    setLoading(true)
    setError('')
    const result = await login(email, password)
    setLoading(false)
    if (!result.success) setError(result.error ?? 'Error al iniciar sesión')
  }

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
            <Building2 className="w-5 h-5 text-gray-700" />
            <h1 className="text-2xl font-bold text-gray-900">Acceso Owner</h1>
          </div>
          <p className="text-gray-500 text-sm mb-6">
            Portal de administración de RutaCash. Si eres cliente, entra por{' '}
            <a href="/login" className="text-primary-600 font-medium hover:underline">/login</a>.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Correo electrónico</label>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="correo@ejemplo.com" autoComplete="username"
                className="w-full h-11 rounded-xl border border-gray-300 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-gray-800 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Contraseña</label>
              <div className="relative">
                <input
                  type={showPass ? 'text' : 'password'} value={password}
                  onChange={e => setPassword(e.target.value)} placeholder="••••••••"
                  autoComplete="current-password"
                  className="w-full h-11 rounded-xl border border-gray-300 px-4 pr-11 text-sm focus:outline-none focus:ring-2 focus:ring-gray-800 focus:border-transparent"
                />
                <button type="button" onClick={() => setShowPass(!showPass)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">{error}</div>
            )}

            <button type="submit" disabled={loading}
              className="w-full h-11 bg-gray-900 hover:bg-black text-white rounded-xl font-medium text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-60">
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {loading ? 'Ingresando...' : 'Ingresar'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
