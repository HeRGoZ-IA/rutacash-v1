import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff, Loader2, TrendingUp, Shield, Smartphone } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'
import { IS_DEMO, IS_CLEAN } from '@/lib/appMode'

const ALL_DEMO_USERS = [
  { email: 'superadmin@demo.com', password: '123456', label: 'Super Admin', role: 'Platform' },
  { email: 'admin@demo.com', password: '123456', label: 'Administrador', role: 'Empresa' },
  { email: 'supervisor@demo.com', password: '123456', label: 'Supervisor', role: 'Empresa' },
  { email: 'cobrador@demo.com', password: '123456', label: 'Cobrador', role: 'Ruta' },
]

const CLEAN_USERS = [
  { email: 'admin@demo.com', password: '123456', label: 'Administrador', role: 'Empresa' },
]

const DEMO_USERS = IS_DEMO ? ALL_DEMO_USERS : CLEAN_USERS

export default function LoginPage() {
  const navigate = useNavigate()
  const { login, isAuthenticated, user } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (isAuthenticated && user) {
      redirectByRole(user.rol)
    }
  }, [isAuthenticated, user])

  function redirectByRole(rol: string) {
    if (rol === 'superadmin') return navigate('/platform')
    if (rol === 'cobrador') return navigate('/collector/home')
    return navigate('/admin/dashboard')
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

  function fillDemo(u: typeof DEMO_USERS[0]) {
    setEmail(u.email)
    setPassword(u.password)
    setError('')
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1F0A0C] via-gray-900 to-[#1F0A0C] flex items-center justify-center p-4">
      {/* Background pattern */}
      <div className="absolute inset-0 opacity-10">
        <div className="absolute top-0 left-0 w-96 h-96 bg-primary-500 rounded-full -translate-x-1/2 -translate-y-1/2 blur-3xl" />
        <div className="absolute bottom-0 right-0 w-96 h-96 bg-primary-600 rounded-full translate-x-1/2 translate-y-1/2 blur-3xl" />
      </div>

      <div className="relative w-full max-w-4xl grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
        {/* Left - Branding */}
        <div className="hidden lg:block text-white">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-12 h-12 bg-primary-500 rounded-2xl flex items-center justify-center">
              <span className="text-white font-bold text-xl">RC</span>
            </div>
            <div>
              <p className="font-bold text-xl">RutaCash</p>
              <p className="text-primary-300 text-sm">Sistema de rutas y cobros</p>
            </div>
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
              { icon: <Smartphone className="w-5 h-5" />, title: 'App cobrador offline', desc: 'Funciona sin internet, sincroniza al conectar' },
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
          <div className="flex items-center gap-2 mb-6 lg:hidden">
            <div className="w-8 h-8 bg-primary-600 rounded-xl flex items-center justify-center">
              <span className="text-white font-bold text-sm">RC</span>
            </div>
            <p className="font-bold text-gray-900">RutaCash</p>
          </div>

          <div className="flex items-center justify-between mb-1">
            <h2 className="text-2xl font-bold text-gray-900">Iniciar sesión</h2>
            {IS_DEMO && (
              <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-700">
                DEMO
              </span>
            )}
            {IS_CLEAN && (
              <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-gray-100 text-gray-600">
                LIMPIO
              </span>
            )}
          </div>
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

          {/* Quick login */}
          <div className="mt-6">
            <p className="text-xs text-gray-400 text-center mb-3">
              {IS_DEMO ? '— Usuarios demo (clic para llenar) —' : '— Acceso inicial (clic para llenar) —'}
            </p>
            <div className={`grid gap-2 ${IS_DEMO ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {DEMO_USERS.map((u) => (
                <button
                  key={u.email}
                  onClick={() => fillDemo(u)}
                  className="text-left px-3 py-2.5 rounded-xl border border-gray-200 hover:border-primary-300 hover:bg-primary-50 transition-colors"
                >
                  <p className="text-xs font-semibold text-gray-700">{u.label}</p>
                  <p className="text-xs text-gray-400">{u.role}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
