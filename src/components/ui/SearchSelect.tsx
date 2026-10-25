// ============================================================
// SELECTOR CON BÚSQUEDA (clientes en Nueva venta, Histórico de abonos y Ventas)
// ------------------------------------------------------------
// Sustituye al <select> nativo donde la lista es larga. En el escritorio el
// <select> salta al escribir una letra, pero en el celular abre la rueda o la
// lista del sistema, donde no se puede escribir: había que recorrer todos los
// clientes a mano (reporte del socio, 2026-10-24).
//
// Aquí se escribe en un campo de texto y la lista se filtra al instante:
//   · sin distinguir mayúsculas ni acentos («joao» encuentra «JOÃO»);
//   · primero los que EMPIEZAN por lo escrito (nombre o cualquier palabra),
//     después los que lo contienen (por ejemplo, parte del documento).
// Solo presenta: el valor elegido es el mismo `value` que usaba el <select>.
// ============================================================
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

import { filterOptions, type SearchSelectOption } from '@/lib/searchFilter'

export type { SearchSelectOption }

interface SearchSelectProps {
  options: SearchSelectOption[]
  value: string
  onChange: (value: string) => void
  label?: string
  placeholder?: string
  required?: boolean
  disabled?: boolean
  /** Texto cuando nada coincide con lo escrito. */
  emptyText?: string
  containerClassName?: string
  'aria-label'?: string
}

/** Máximo de filas visibles a la vez: con más, se pide seguir escribiendo. */
const MAX_RESULTS = 60

export function SearchSelect({
  options, value, onChange, label, placeholder = 'Buscar…', required, disabled,
  emptyText = 'Ningún resultado', containerClassName, 'aria-label': ariaLabel,
}: SearchSelectProps) {
  const fieldId = useId()
  const listId = `${fieldId}-list`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const selected = options.find(o => o.value === value)
  const matches = useMemo(() => filterOptions(options, query), [options, query])
  const shown = matches.slice(0, MAX_RESULTS)

  // Lo que se ve en el campo: lo escrito mientras se busca; si no, el elegido.
  const text = open ? query : (selected?.label ?? '')

  useEffect(() => { setActive(0) }, [query, open])
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const choose = (o: SearchSelectOption) => {
    onChange(o.value)
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
  }

  const clear = () => {
    onChange('')
    setQuery('')
    setOpen(true)
    inputRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => Math.min(i + 1, shown.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { if (open && shown[active]) { e.preventDefault(); choose(shown[active]) } }
    else if (e.key === 'Escape') { setOpen(false); setQuery('') }
  }

  return (
    <div className={containerClassName ?? 'w-full'}>
      {label && (
        <label htmlFor={fieldId} className="block text-sm font-medium text-gray-700 mb-1.5">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
          <Search className="w-4 h-4" />
        </div>
        <input
          ref={inputRef}
          id={fieldId}
          type="text"
          role="combobox"
          aria-label={label ? undefined : ariaLabel}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          disabled={disabled}
          value={text}
          placeholder={selected ? selected.label : placeholder}
          onFocus={() => { setQuery(''); setOpen(true) }}
          // Se cierra después del toque en una opción (que usa onMouseDown).
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onKeyDown={onKeyDown}
          className={cn(
            'w-full h-11 sm:h-9 rounded-lg border bg-white text-gray-900 placeholder-gray-400 text-base sm:text-sm pl-9 pr-9',
            'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow border-gray-300',
            'disabled:bg-gray-50 disabled:text-gray-500',
          )}
        />
        {selected && !disabled ? (
          <button type="button" aria-label="Quitar selección" onMouseDown={e => e.preventDefault()} onClick={clear}
            className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600">
            <X className="w-4 h-4" />
          </button>
        ) : (
          <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-gray-400">
            <ChevronDown className="w-4 h-4" />
          </div>
        )}
        {open && !disabled && (
          <ul ref={listRef} id={listId} role="listbox"
            className="absolute z-30 mt-1 w-full max-h-64 overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg py-1">
            {shown.length === 0 && <li className="px-3 py-2.5 text-sm text-gray-500">{emptyText}</li>}
            {shown.map((o, i) => (
              <li key={o.value} data-index={i} role="option" aria-selected={o.value === value}
                // onMouseDown evita que el campo pierda el foco antes de elegir (también en táctil).
                onMouseDown={e => { e.preventDefault(); choose(o) }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  'px-3 py-2.5 sm:py-2 text-sm cursor-pointer',
                  i === active ? 'bg-primary-50 text-primary-700' : 'text-gray-800',
                  o.value === value && 'font-semibold',
                )}>
                {o.label}
              </li>
            ))}
            {matches.length > shown.length && (
              <li className="px-3 py-2 text-xs text-gray-500">{matches.length - shown.length} más: sigue escribiendo para acotar</li>
            )}
          </ul>
        )}
      </div>
    </div>
  )
}
