import { KeyRound, ShieldAlert } from 'lucide-react'
import { ChangePasswordCard } from '@/components/auth/ChangePasswordCard'
import { useAuth } from '@/hooks/useAuth'
import { ROLE_LABELS } from '@/lib/permissions'

/**
 * CAMBIO OBLIGATORIO DE CONTRASEÑA.
 *
 * Se interpone ante CUALQUIER pantalla mientras el usuario en sesión tenga
 * `mustChangePassword: true`. Lo activan los seeds de arranque (credenciales por
 * defecto conocidas y públicas) y el restablecimiento por parte de un superior.
 *
 * Al cambiar la clave, `useAuth.changeOwnPassword` apaga el flag en Dexie Y en el
 * store, de modo que esta pantalla desaparece en el acto: sin recargar, sin cerrar
 * sesión y sin tocar IndexedDB.
 */
export function PasswordChangeGate() {
  const { user, logout } = useAuth()
  if (!user) return null

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-5">
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-center">
          <div className="w-14 h-14 bg-amber-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <ShieldAlert className="w-7 h-7 text-amber-600" />
          </div>
          <h1 className="text-lg font-bold text-gray-900">Cambia tu contraseña para continuar</h1>
          <p className="text-sm text-gray-600 mt-2">
            Tu cuenta usa una contraseña inicial conocida. Por seguridad debes definir una
            nueva antes de acceder a RutaCash.
          </p>
          <p className="text-xs text-gray-400 mt-3">
            {user.nombre} · {user.email} · {ROLE_LABELS[user.rol]}
          </p>
        </div>

        <ChangePasswordCard />

        <div className="text-center">
          <p className="text-xs text-gray-400 flex items-center justify-center gap-1.5">
            <KeyRound className="w-3.5 h-3.5" />
            La contraseña actual es la que acabas de usar para entrar.
          </p>
          <button onClick={logout} className="mt-3 text-sm text-gray-500 hover:text-gray-700">
            Cerrar sesión
          </button>
        </div>
      </div>
    </div>
  )
}
