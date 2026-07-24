import { useNavigate } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useOpBase } from '@/hooks/useOpBase'
import { ChangePasswordCard } from '@/components/auth/ChangePasswordCard'
import { ROLE_LABELS } from '@/lib/permissions'

/**
 * Cuenta de la capa operativa (Cobrador / Supervisor): datos básicos + cambio de
 * contraseña propia. Reutilizada por ambas apps vía base-path.
 */
export default function OperationalAccountPage() {
  const { user } = useAuth()
  const base = useOpBase()
  const navigate = useNavigate()
  return (
    <div className="p-4 space-y-4">
      <button onClick={() => navigate(`${base}/home`)} className="flex items-center gap-1 text-primary-600 text-sm font-medium">
        <ChevronLeft className="w-4 h-4" /> Volver
      </button>
      <div>
        <h1 className="text-xl font-bold text-gray-900">Mi cuenta</h1>
        <p className="text-sm text-gray-500 mt-0.5">{user?.nombre} · {user ? ROLE_LABELS[user.rol] : ''}</p>
      </div>
      <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4">
        <p className="text-xs text-gray-400">Correo</p>
        <p className="text-sm font-medium text-gray-800">{user?.email}</p>
      </div>
      <ChangePasswordCard />
    </div>
  )
}
