import { cn } from '@/lib/utils'

interface CountBadgeProps {
  count: number
  className?: string
}

/**
 * Badge de notificación consistente para toda la app (App Cobrador y Administrador).
 * Color de atención ámbar, compacto y legible. Se oculta cuando el conteo es 0.
 */
export function CountBadge({ count, className }: CountBadgeProps) {
  if (!count || count <= 0) return null
  return (
    <span className={cn(
      'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold leading-none',
      className,
    )}>
      {count > 99 ? '99+' : count}
    </span>
  )
}
