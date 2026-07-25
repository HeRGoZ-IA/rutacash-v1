import { useState, useEffect } from 'react'
import { CheckCircle2, Circle, ChevronRight, X } from 'lucide-react'
import { useNavigate, useLocation } from 'react-router-dom'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { authorizedRouteIdsOf } from '@/lib/permissions'

interface Step {
  id: string
  label: string
  description: string
  path: string
  cta: string
  done: boolean
}

/**
 * ONBOARDING de empresa nueva (#2). Muestra los primeros pasos ESENCIALES calculados
 * desde datos reales; cada paso se marca solo cuando existe el dato. Se auto-oculta al
 * completarse. Aparece en el Dashboard mientras haya pasos esenciales pendientes.
 */
export function SetupChecklist() {
  const navigate = useNavigate()
  const location = useLocation()
  const { tenantId } = useTenant()
  const [steps, setSteps] = useState<Step[]>([])
  const [loading, setLoading] = useState(true)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (tenantId) loadSteps()
    // Recalcular al volver al dashboard (tras crear admin/ruta/usuario/cliente/venta).
  }, [tenantId, location.pathname])

  async function loadSteps() {
    setLoading(true)
    try {
      const [users, routes, clients, sales] = await Promise.all([
        db.users.where('tenantId').equals(tenantId).toArray(),
        db.routes.where('tenantId').equals(tenantId).toArray(),
        db.clients.where('tenantId').equals(tenantId).count(),
        db.sales.where('tenantId').equals(tenantId).count(),
      ])

      const activeAdmins = users.filter(u => u.rol === 'admin' && u.status === 'activo')
      const routeIdSet = new Set(routes.map(r => r.id))
      const routeHasAdmin = routes.length > 0 && activeAdmins.some(a => authorizedRouteIdsOf(a).some(id => routeIdSet.has(id)))
      const otherOps = users.some(u => ['supervisor', 'cobrador', 'socio', 'secretario'].includes(u.rol))

      setSteps([
        { id: 'admin', label: 'Crea al menos un Administrador', description: 'Responsable de rutas y operación', path: '/admin/users', cta: 'Crear Administrador', done: activeAdmins.length > 0 },
        { id: 'ruta', label: 'Crea una ruta y asígnale un Administrador', description: 'Zona de cobranza con responsable', path: '/admin/routes', cta: 'Crear Ruta', done: routeHasAdmin },
        { id: 'usuario', label: 'Agrega Supervisor / Cobrador / Socio / Secretario', description: 'Equipo operativo de la empresa', path: '/admin/users', cta: 'Crear Usuario', done: otherOps },
        { id: 'cliente', label: 'Registra tu primer Cliente', description: 'Persona o negocio al que prestarás', path: '/admin/clients', cta: 'Crear Cliente', done: clients > 0 },
        { id: 'venta', label: 'Crea tu primera Venta', description: 'Préstamo con cuotas y tasa de interés', path: '/admin/active-sales', cta: 'Crear Venta', done: sales > 0 },
      ])
    } finally {
      setLoading(false)
    }
  }

  if (loading || dismissed) return null

  const completed = steps.filter(s => s.done).length
  const total = steps.length
  if (completed === total) return null

  const nextStep = steps.find(s => !s.done)

  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-card">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">
            Primeros pasos — {completed}/{total} completados
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Completa estos pasos para comenzar a operar
          </p>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-gray-300 hover:text-gray-500 p-0.5 rounded transition-colors"
          title="Ocultar"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-gray-100 rounded-full h-1.5 mb-4 mt-3">
        <div
          className="bg-primary-600 h-1.5 rounded-full transition-all"
          style={{ width: `${(completed / total) * 100}%` }}
        />
      </div>

      <div className="space-y-1">
        {steps.map((step) => (
          <div
            key={step.id}
            className={[
              'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors',
              step.done ? 'opacity-60' : step.id === nextStep?.id ? 'bg-primary-50 ring-1 ring-primary-200' : '',
            ].join(' ')}
          >
            {step.done
              ? <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />
              : <Circle className="w-5 h-5 text-gray-300 flex-shrink-0" />
            }
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium ${step.done ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                {step.label}
              </p>
              <p className="text-xs text-gray-400 truncate">{step.description}</p>
            </div>
            {/* Botón de acción real: navega a la pantalla exacta (no instrucción genérica). */}
            {!step.done && (
              <button
                onClick={() => navigate(step.path)}
                className={`flex items-center gap-1 flex-shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${step.id === nextStep?.id ? 'bg-primary-600 text-white hover:bg-primary-700' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}
              >
                {step.cta}<ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
