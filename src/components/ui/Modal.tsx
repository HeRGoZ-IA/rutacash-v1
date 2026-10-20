import { useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
  size?: 'sm' | 'md' | 'mdPlus' | 'lg' | 'xl'
  footer?: React.ReactNode
  /**
   * Ronda 49: el `onClose` de este modal ya protege lo escrito (p. ej. abre
   * «Cambios sin guardar»). Escape y el clic en el fondo lo llaman siempre.
   * Sin esta marca, Escape y el fondo solo cierran mientras no se haya escrito nada:
   * con datos a medias (un importe, un motivo) hay que usar Cancelar o la X.
   */
  guarded?: boolean
}

const sizes = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  // Ancho intermedio cómodo (Paquete 2.5): usado por los modales de
  // Nuevo cliente y Nueva venta para que queden visualmente equilibrados.
  mdPlus: 'max-w-xl',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Modales abiertos, del más antiguo al más reciente: solo el de arriba atiende teclado y foco. */
const stack: string[] = []

export function Modal({ open, onClose, title, children, size = 'md', footer, guarded = false }: ModalProps) {
  const id = useId()
  const titleId = `${id}-title`
  const panelRef = useRef<HTMLDivElement>(null)
  const touched = useRef(false)
  const pressOnBackdrop = useRef(false)
  const [nudge, setNudge] = useState(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    document.body.style.overflow = 'hidden'
    stack.push(id)
    touched.current = false
    const previous = document.activeElement as HTMLElement | null
    // Foco inicial: el elemento con autoFocus si lo hay; si no, el primer campo; si no, el panel.
    const t = window.setTimeout(() => {
      const panel = panelRef.current
      if (!panel || panel.contains(document.activeElement)) return
      const first = panel.querySelector<HTMLElement>('input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])')
      ;(first ?? panel).focus()
    }, 0)
    return () => {
      window.clearTimeout(t)
      const i = stack.lastIndexOf(id)
      if (i >= 0) stack.splice(i, 1)
      if (stack.length === 0) document.body.style.overflow = ''
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [open, id])

  useEffect(() => {
    if (!nudge) return
    const t = window.setTimeout(() => setNudge(false), 2500)
    return () => window.clearTimeout(t)
  }, [nudge])

  /** Cierre «suave» (Escape o fondo): nunca descarta en silencio lo que se escribió. */
  function softClose() {
    if (guarded || !touched.current) closeRef.current()
    else setNudge(true)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (stack[stack.length - 1] !== id) return
    if (e.key === 'Escape') { e.stopPropagation(); softClose(); return }
    if (e.key !== 'Tab') return
    // El foco no sale del modal con Tab / Mayús+Tab.
    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null)
    if (!items.length) { e.preventDefault(); return }
    const first = items[0]!, last = items[items.length - 1]!
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onKeyDown={onKeyDown}>
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        aria-hidden="true"
        // Solo un clic que EMPIEZA y termina en el fondo cierra (arrastrar al seleccionar texto no).
        onMouseDown={(e) => { pressOnBackdrop.current = e.target === e.currentTarget }}
        onClick={(e) => { if (pressOnBackdrop.current && e.target === e.currentTarget) softClose(); pressOnBackdrop.current = false }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        onInput={() => { touched.current = true }}
        onChange={() => { touched.current = true }}
        className={cn(
          'relative bg-white rounded-2xl shadow-modal w-full max-h-[90vh] flex flex-col focus:outline-none',
          sizes[size]
        )}
      >
        {title && (
          <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-4 border-b border-gray-100">
            <h2 id={titleId} className="text-base font-semibold text-gray-900">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="-mr-1 p-2 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <p role="status" aria-live="polite" className={cn('px-4 sm:px-6 text-xs text-amber-700 bg-amber-50 transition-all', nudge ? 'py-2' : 'h-0 overflow-hidden')}>
          {nudge ? 'Hay datos escritos: use Cancelar o la X para cerrar sin guardar.' : ''}
        </p>
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</div>
        {footer && (
          <div className="px-4 sm:px-6 py-4 border-t border-gray-100 flex flex-wrap items-center justify-end gap-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
