import { cn } from '@/lib/utils'
import { forwardRef, useId } from 'react'

// Ronda 49 · accesibilidad y móvil:
//   · cada etiqueta apunta a su control (`htmlFor` con un id estable: el de las props o uno
//     generado), y la ayuda y el error quedan enlazados con `aria-describedby`;
//   · en pantallas estrechas el texto es de 16 px y el control de 44 px de alto (iOS no
//     amplía la página al enfocar y el objetivo táctil es cómodo); el escritorio no cambia.
const FIELD = 'text-base sm:text-sm'

function useFieldIds(id: string | undefined, error?: string, hint?: string) {
  const auto = useId()
  const fieldId = id ?? auto
  const describedBy = error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined
  return { fieldId, describedBy }
}

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
  /**
   * Clases del CONTENEDOR (etiqueta + control). Por defecto el campo ocupa todo el
   * ancho (`w-full`), que es lo correcto en formularios. Las barras de filtros lo usan
   * para fijar un ancho propio (p. ej. `w-full sm:w-44`); si se indica, REEMPLAZA a
   * `w-full`. `className` sigue aplicándose al control, como siempre.
   */
  containerClassName?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, leftIcon, rightIcon, className, containerClassName, id, ...props }, ref) => {
    const { fieldId, describedBy } = useFieldIds(id, error, hint)
    return (
      <div className={containerClassName ?? 'w-full'}>
        {label && (
          <label htmlFor={fieldId} className="block text-sm font-medium text-gray-700 mb-1.5">
            {label}
            {props.required && <span className="text-red-500 ml-1">*</span>}
          </label>
        )}
        <div className="relative">
          {leftIcon && (
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
              {leftIcon}
            </div>
          )}
          <input
            ref={ref}
            id={fieldId}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={cn(
              'w-full h-11 sm:h-9 rounded-lg border bg-white text-gray-900 placeholder-gray-400', FIELD,
              'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow',
              error ? 'border-red-400 focus:ring-red-400' : 'border-gray-300',
              leftIcon ? 'pl-9' : 'pl-3',
              rightIcon ? 'pr-9' : 'pr-3',
              'disabled:bg-gray-50 disabled:text-gray-500',
              className
            )}
            {...props}
          />
          {rightIcon && (
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400">
              {rightIcon}
            </div>
          )}
        </div>
        {error && <p id={`${fieldId}-error`} className="mt-1 text-xs text-red-600">{error}</p>}
        {hint && !error && <p id={`${fieldId}-hint`} className="mt-1 text-xs text-gray-500">{hint}</p>}
      </div>
    )
  }
)
Input.displayName = 'Input'

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  hint?: string
  options: { value: string; label: string }[]
  placeholder?: string
  /** Ver `containerClassName` de Input. */
  containerClassName?: string
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, hint, options, placeholder, className, containerClassName, id, ...props }, ref) => {
    const { fieldId, describedBy } = useFieldIds(id, error, hint)
    return (
      <div className={containerClassName ?? 'w-full'}>
        {label && (
          <label htmlFor={fieldId} className="block text-sm font-medium text-gray-700 mb-1.5">
            {label}
            {props.required && <span className="text-red-500 ml-1">*</span>}
          </label>
        )}
        <select
          ref={ref}
          id={fieldId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'w-full h-11 sm:h-9 rounded-lg border bg-white text-gray-900 pl-3 pr-8', FIELD,
            'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow',
            error ? 'border-red-400' : 'border-gray-300',
            'disabled:bg-gray-50 disabled:text-gray-500',
            className
          )}
          {...props}
        >
          {placeholder && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {error && <p id={`${fieldId}-error`} className="mt-1 text-xs text-red-600">{error}</p>}
        {hint && !error && <p id={`${fieldId}-hint`} className="mt-1 text-xs text-gray-500">{hint}</p>}
      </div>
    )
  }
)
Select.displayName = 'Select'

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
  hint?: string
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, hint, className, id, ...props }, ref) => {
    const { fieldId, describedBy } = useFieldIds(id, error, hint)
    return (
      <div className="w-full">
        {label && (
          <label htmlFor={fieldId} className="block text-sm font-medium text-gray-700 mb-1.5">
            {label}
            {props.required && <span className="text-red-500 ml-1">*</span>}
          </label>
        )}
        <textarea
          ref={ref}
          id={fieldId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'w-full rounded-lg border bg-white text-gray-900 p-3', FIELD,
            'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow',
            error ? 'border-red-400' : 'border-gray-300',
            className
          )}
          {...props}
        />
        {error && <p id={`${fieldId}-error`} className="mt-1 text-xs text-red-600">{error}</p>}
        {hint && !error && <p id={`${fieldId}-hint`} className="mt-1 text-xs text-gray-500">{hint}</p>}
      </div>
    )
  }
)
Textarea.displayName = 'Textarea'
