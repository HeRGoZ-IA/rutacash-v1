import { useRef, useState } from 'react'
import { Camera, X, ImageIcon } from 'lucide-react'
import { resizeImageToDataUrl } from '@/lib/image'

interface PhotoInputProps {
  label: string
  /** Data URL guardado (o vacío si no hay foto). */
  value?: string
  /** Devuelve el nuevo Data URL, o undefined al quitar la foto. */
  onChange: (dataUrl: string | undefined) => void
  hint?: string
}

/**
 * Captura/carga de una foto (documento, negocio, etc.) para V1 local-first.
 * - input file con accept="image/*" y capture para abrir cámara en móvil.
 * - Muestra preview y permite quitar/reemplazar antes de guardar.
 * - Redimensiona/comprime con canvas nativo (sin librerías externas).
 * - NO sube nada a ningún servidor: el Data URL se guarda en el cliente.
 */
export function PhotoInput({ label, value, onChange, hint }: PhotoInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(false)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Permite reseleccionar el mismo archivo después de quitarlo.
    e.target.value = ''
    if (!file) return
    setLoading(true)
    try {
      const dataUrl = await resizeImageToDataUrl(file)
      onChange(dataUrl)
    } catch {
      // Si falla la compresión, no rompemos el formulario.
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full">
      <label className="block text-sm font-medium text-gray-700 mb-1.5">{label}</label>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFile}
      />
      {value ? (
        <div className="relative group">
          <img
            src={value}
            alt={label}
            className="w-full h-40 object-cover rounded-xl border border-gray-200"
          />
          <div className="absolute top-2 right-2 flex gap-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="px-2.5 py-1.5 rounded-lg bg-white/90 text-xs font-medium text-gray-700 shadow-sm hover:bg-white"
            >
              Reemplazar
            </button>
            <button
              type="button"
              onClick={() => onChange(undefined)}
              className="p-1.5 rounded-lg bg-white/90 text-red-500 shadow-sm hover:bg-white"
              aria-label="Quitar foto"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={loading}
          className="w-full h-32 rounded-xl border-2 border-dashed border-gray-300 flex flex-col items-center justify-center gap-2 text-gray-400 hover:border-primary-400 hover:text-primary-500 transition-colors disabled:opacity-60"
        >
          {loading ? (
            <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Camera className="w-5 h-5" />
                <ImageIcon className="w-5 h-5" />
              </div>
              <span className="text-xs font-medium">Tomar o cargar foto</span>
            </>
          )}
        </button>
      )}
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  )
}
