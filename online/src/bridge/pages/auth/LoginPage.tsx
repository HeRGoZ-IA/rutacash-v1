// ADEX Online: COPIA de la LoginPage original de CLEAN (src/pages/auth/LoginPage.tsx).
// Idéntica salvo lo marcado abajo: ADEX Online no funciona sin conexión (DS-07), así que no
// puede anunciarlo; y (Ronda 40) «¿Olvidaste tu contraseña?», que pide al proveedor de
// identidad el enlace de recuperación (llega a /activar). La autenticación la hace el
// puente de `useAuth` (proveedor de identidad + contexto del servidor).
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff, Loader2, TrendingUp, Shield, Smartphone } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'
import { homePathForRole } from '@/lib/permissions'
import { getLastLoginEmail } from '@/lib/lastLoginEmail'
import type { UserRole } from '@/models/types'
import { BrandLogo } from '@/components/ui/BrandLogo'
// ADEX Online: recuperación de acceso por el proveedor de identidad.
import { api } from '../../../runtime/session.ts'

export default function LoginPage() {
  const navigate = useNavigate()
  const { login, isAuthenticated, user } = useAuth()
  // Se prerrellena con el último correo que entró correctamente en este navegador.
  // Solo el correo: la contraseña nunca se guarda.
  const [email, setEmail] = useState(getLastLoginEmail)
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // ADEX Online: recuperación de acceso.
  const [recoverNote, setRecoverNote] = useState('')

  async function handleRecover() {
    if (!email) { setError('Escribe tu correo para recuperar el acceso'); return }
    setError('')
    try {
      await api().recover(email)
      setRecoverNote('Si el correo está registrado, el proveedor de identidad enviará un enlace para fijar una nueva contraseña. Si no llega en unos minutos, avisa a tu administrador.')
    } catch {
      setRecoverNote('El servicio de identidad no respondió. Intenta de nuevo en unos minutos.')
    }
  }

  useEffect(() => {
    if (isAuthenticated && user) {
      redirectByRole(user.rol)
    }
  }, [isAuthenticated, user])

  function redirectByRole(rol: string) {
    // Fuente única de redirección post-login (modelo de roles y permisos).
    navigate(homePathForRole(rol as UserRole))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) {
      setError('Ingresa tu correo y contraseña')
      return
    }
    setLoading(true)
    setError('')
    const result = await login(email, password)
    setLoading(false)
    if (!result.success) {
      setError(result.error ?? 'Error al iniciar sesión')
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1E3A8A] via-gray-900 to-[#1E3A8A] flex items-center justify-center p-4">
      {/* Background pattern */}
      <div className="absolute inset-0 opacity-10">
        <div className="absolute top-0 left-0 w-96 h-96 bg-primary-500 rounded-full -translate-x-1/2 -translate-y-1/2 blur-3xl" />
        <div className="absolute bottom-0 right-0 w-96 h-96 bg-primary-600 rounded-full translate-x-1/2 translate-y-1/2 blur-3xl" />
      </div>

      <div className="relative w-full max-w-4xl grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
        {/* Left - Branding */}
        <div className="hidden lg:block text-white">
          <div className="mb-8">
            <BrandLogo variant="on-dark" className="h-16 -ml-2" />
            <p className="text-primary-300 text-sm mt-1">Sistema de rutas y cobros</p>
          </div>

          <h1 className="text-4xl font-bold mb-4 leading-tight">
            Gestiona tus rutas<br />
            <span className="text-primary-400">con total control</span>
          </h1>
          <p className="text-gray-400 text-lg mb-8">
            Préstamos, cobros, gastos, caja y liquidación semanal en una sola plataforma.
          </p>

          <div className="space-y-4">
            {[
              { icon: <TrendingUp className="w-5 h-5" />, title: 'Cartera activa en tiempo real', desc: 'Saldos, cuotas y mora siempre al día' },
              // ADEX Online: solo en línea (DS-07). CLEAN decía «App cobrador offline — Funciona sin internet, sincroniza al conectar».
              { icon: <Smartphone className="w-5 h-5" />, title: 'App cobrador en línea', desc: 'Cada cobro se confirma en el servidor central' },
              { icon: <Shield className="w-5 h-5" />, title: 'Roles y control de acceso', desc: 'Admin, supervisor y cobrador con permisos definidos' },
            ].map((f, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="w-10 h-10 bg-primary-500/20 rounded-xl flex items-center justify-center text-primary-400 flex-shrink-0">
                  {f.icon}
                </div>
                <div>
                  <p className="font-medium text-sm">{f.title}</p>
                  <p className="text-gray-400 text-xs mt-0.5">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right - Login form */}
        <div className="bg-white rounded-3xl shadow-2xl p-8">
          {/* Mobile logo */}
          <div className="mb-6 lg:hidden">
            <BrandLogo variant="primary" className="h-11 -ml-1" />
          </div>

          <h2 className="text-2xl font-bold text-gray-900 mb-1">Iniciar sesión</h2>
          <p className="text-gray-500 text-sm mb-6">Ingresa a tu cuenta para continuar</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Correo electrónico</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="correo@ejemplo.com"
                className="w-full h-11 rounded-xl border border-gray-300 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                autoComplete="username"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Contraseña</label>
              <div className="relative">
                <input
                  type={showPass ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••"
                  className="w-full h-11 rounded-xl border border-gray-300 px-4 pr-11 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPass(!showPass)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full h-11 bg-primary-600 hover:bg-primary-700 text-white rounded-xl font-medium text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-60"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {loading ? 'Ingresando...' : 'Ingresar'}
            </button>
          </form>

          {/* ADEX Online: recuperación de acceso (enlace del proveedor de identidad al correo). */}
          <div className="mt-4 text-center">
            <button type="button" onClick={handleRecover} className="text-sm text-primary-600 font-medium hover:underline">
              ¿Olvidaste tu contraseña?
            </button>
            {recoverNote && <p className="text-xs text-gray-500 mt-2">{recoverNote}</p>}
          </div>

        </div>
      </div>

    </div>
  )
}
