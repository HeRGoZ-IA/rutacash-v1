import { useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { toast } from '@/components/ui/Toast'

/**
 * Tarjeta de cambio de contraseña propia. Disponible para TODOS los perfiles
 * (SESIONES, BLOQUEOS Y CONTRASEÑAS). Usa `useAuth.changeOwnPassword`, que valida
 * la contraseña actual y audita el cambio.
 */
export function ChangePasswordCard() {
  const { changeOwnPassword } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (next !== confirm) { toast.error('La nueva contraseña y su confirmación no coinciden'); return }
    setSaving(true)
    const res = await changeOwnPassword(current, next)
    setSaving(false)
    if (res.success) {
      toast.success('Contraseña actualizada')
      setCurrent(''); setNext(''); setConfirm('')
    } else {
      toast.error(res.error ?? 'No se pudo cambiar la contraseña')
    }
  }

  const input = 'w-full h-11 rounded-xl border border-gray-300 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500'

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-gray-100 shadow-card p-5 space-y-3 max-w-md">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-9 h-9 bg-primary-100 rounded-xl flex items-center justify-center">
          <KeyRound className="w-4 h-4 text-primary-600" />
        </div>
        <div>
          <h3 className="font-semibold text-gray-900 text-sm">Cambiar mi contraseña</h3>
          <p className="text-xs text-gray-400">Actualiza tu clave de acceso</p>
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Contraseña actual</label>
        <input type="password" className={input} value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" required />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Nueva contraseña</label>
        <input type="password" className={input} value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" required />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Confirmar nueva contraseña</label>
        <input type="password" className={input} value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" required />
      </div>
      <button type="submit" disabled={saving}
        className="w-full h-11 bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white rounded-xl font-medium text-sm flex items-center justify-center gap-2">
        {saving && <Loader2 className="w-4 h-4 animate-spin" />}
        {saving ? 'Guardando...' : 'Actualizar contraseña'}
      </button>
    </form>
  )
}
