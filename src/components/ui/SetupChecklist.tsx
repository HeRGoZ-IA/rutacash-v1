import { useState, useEffect } from 'react'
import { CheckCircle2, Circle, ChevronRight, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'

interface Step {
  id: string
  label: string
  description: string
  path: string
  done: boolean
}

export function SetupChecklist() {
  const navigate = useNavigate()
  const { tenantId } = useTenant()
  const [steps, setSteps] = useState<Step[]>([])
  const [loading, setLoading] = useState(true)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (tenantId) loadSteps()
  }, [tenantId])

  async function loadSteps() {
    setLoading(true)
    try {
      const [tenant, routes, collectors, clients, sales, payments] = await Promise.all([
        db.tenants.get(tenantId),
        db.routes.where('tenantId').equals(tenantId).count(),
        db.users.where('tenantId').equals(tenantId).and(u => u.rol === 'cobrador').count(),
        db.clients.where('tenantId').equals(tenantId).count(),
        db.sales.where('tenantId').equals(tenantId).count(),
        db.payments.where('tenantId').equals(tenantId).count(),
      ])

      setSteps([
        {
          id: 'empresa',
          label: 'Configura tu empresa',
          description: 'Nombre, país, ciudad y moneda en Configuración',
          path: '/admin/settings',
          done: !!tenant &&
            !!tenant.nombre.trim() &&
            tenant.nombre !== 'Mi Empresa' &&
            !!tenant.pais &&
            !!tenant.ciudad &&
            !!tenant.moneda,
        },
        {
          id: 'ruta',
          label: 'Crea una ruta',
          description: 'Zona o sector de cobranza asignada',
          path: '/admin/routes',
          done: routes > 0,
        },
        {
          id: 'cobrador',
          label: 'Agrega un cobrador',
          description: 'Usuario que saldrá a cobrar en calle',
          path: '/admin/users',
          done: collectors > 0,
        },
        {
          id: 'cliente',
          label: 'Registra tu primer cliente',
          description: 'Persona o negocio al que prestarás',
          path: '/admin/clients',
          done: clients > 0,
        },
        {
          id: 'venta',
          label: 'Crea tu primer crédito',
          description: 'Préstamo con cuotas y tasa de interés',
          path: '/admin/active-sales',
          done: sales > 0,
        },
        {
          id: 'pago',
          label: 'Registra el primer pago',
          description: 'Confirma el primer cobro de cuota',
          path: '/admin/active-sales',
          done: payments > 0,
        },
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
          <button
            key={step.id}
            onClick={() => !step.done && navigate(step.path)}
            disabled={step.done}
            className={[
              'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors',
              step.done
                ? 'opacity-50 cursor-default'
                : step.id === nextStep?.id
                ? 'bg-primary-50 hover:bg-primary-100 cursor-pointer ring-1 ring-primary-200'
                : 'hover:bg-gray-50 cursor-pointer',
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
            {!step.done && <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />}
          </button>
        ))}
      </div>
    </div>
  )
}
