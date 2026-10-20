// ADEX Online (Ronda 40): entrega del ENLACE DE PRIMER ACCESO de un Super Admin, con el
// mismo estilo que el recuadro de credenciales original de CLEAN. El enlace es de un solo
// uso, caduca y no se guarda en ninguna parte: se muestra una vez para entregarlo a la
// persona por un canal privado. Con él, la persona fija SU contraseña; nadie más la conoce.

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import type { AccessLinkResult } from '@/platform/companyControlService'

export function AccessLinkPanel({ result }: { result: AccessLinkResult }) {
  const [copied, setCopied] = useState(false)

  if (result.status === 'existing' || result.status === 'already_active') {
    return (
      <p className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-xl p-3">
        {result.status === 'existing'
          ? 'Esta persona ya tiene cuenta en ADEX: entra por /login con su contraseña de siempre y elige esta empresa.'
          : 'Esta persona ya inició sesión en ADEX: entra con su propia contraseña. Nadie puede fijársela desde fuera.'}
      </p>
    )
  }
  if (result.status === 'failed') {
    return (
      <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">
        {result.message} Puedes generar el enlace desde la ficha de la empresa.
      </p>
    )
  }

  async function copy() {
    if (result.status !== 'issued') return
    try { await navigator.clipboard.writeText(result.url); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* el texto sigue visible para copiarlo a mano */ }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Entrega este enlace al Super Admin. Con él fijará su propia contraseña y después entrará por{' '}
        <span className="font-mono">/login</span>.
      </p>
      <div className="rounded-xl bg-gray-50 border border-gray-200 p-3 flex items-start gap-2">
        <p className="font-mono text-xs text-gray-800 break-all flex-1 select-all" data-testid="access-link">{result.url}</p>
        <button type="button" onClick={copy} className="flex-shrink-0 text-gray-500 hover:text-gray-800" aria-label="Copiar enlace">
          {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3">
        Un solo uso y caduca (1 hora con la configuración actual del proveedor de identidad). No vuelve a
        mostrarse; si se pierde o caduca, genera otro desde la ficha de la empresa: el anterior deja de servir.
      </p>
    </div>
  )
}
