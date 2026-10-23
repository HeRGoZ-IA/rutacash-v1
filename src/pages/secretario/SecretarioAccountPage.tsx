import { useAuth } from '@/hooks/useAuth'
import { formatPersonName } from '@/lib/displayName'
import { ChangePasswordCard } from '@/components/auth/ChangePasswordCard'
import { ROLE_LABELS } from '@/lib/permissions'

/** Cuenta del SECRETARIO: datos básicos + cambio de contraseña propia. */
export default function SecretarioAccountPage() {
  const { user } = useAuth()
  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto w-full">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Mi cuenta</h1>
        <p className="text-sm text-gray-500 mt-0.5">{formatPersonName(user?.nombre)} · {user ? ROLE_LABELS[user.rol] : ''}</p>
      </div>
      <div className="grid gap-5 lg:grid-cols-2 items-start">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4">
          <p className="text-xs text-gray-500">Correo</p>
          <p className="text-sm font-medium text-gray-800 break-all">{user?.email}</p>
        </div>
        <ChangePasswordCard />
      </div>
    </div>
  )
}
