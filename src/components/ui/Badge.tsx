import { cn } from '@/lib/utils'

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'gray'

interface BadgeProps {
  variant?: BadgeVariant
  children: React.ReactNode
  className?: string
  size?: 'sm' | 'md'
}

const variants: Record<BadgeVariant, string> = {
  default: 'bg-primary-100 text-primary-700',
  success: 'bg-emerald-100 text-emerald-700',
  warning: 'bg-amber-100 text-amber-700',
  danger: 'bg-red-100 text-red-700',
  info: 'bg-blue-100 text-blue-700',
  purple: 'bg-purple-100 text-purple-700',
  gray: 'bg-gray-100 text-gray-600',
}

export function Badge({ variant = 'default', children, className, size = 'md' }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center font-medium rounded-full',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-0.5 text-xs',
        variants[variant],
        className
      )}
    >
      {children}
    </span>
  )
}

export function SaleStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: BadgeVariant }> = {
    activa: { label: 'Activa', variant: 'success' },
    finalizada: { label: 'Finalizada', variant: 'info' },
    perdida: { label: 'Perdida', variant: 'danger' },
    refinanciada: { label: 'Refinanciada', variant: 'purple' },
  }
  const item = map[status] ?? { label: status, variant: 'gray' }
  return <Badge variant={item.variant}>{item.label}</Badge>
}

export function InstallmentStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: BadgeVariant }> = {
    pendiente: { label: 'Pendiente', variant: 'warning' },
    parcial: { label: 'Parcial', variant: 'info' },
    pagada: { label: 'Pagada', variant: 'success' },
    vencida: { label: 'Vencida', variant: 'danger' },
    adelantada: { label: 'Adelantada', variant: 'purple' },
  }
  const item = map[status] ?? { label: status, variant: 'gray' }
  return <Badge variant={item.variant}>{item.label}</Badge>
}

export function ClientStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: BadgeVariant }> = {
    activo: { label: 'Activo', variant: 'success' },
    inactivo: { label: 'Inactivo', variant: 'gray' },
    moroso: { label: 'Moroso', variant: 'danger' },
    perdido: { label: 'Perdido', variant: 'warning' },
  }
  const item = map[status] ?? { label: status, variant: 'gray' }
  return <Badge variant={item.variant}>{item.label}</Badge>
}

export function SyncStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: BadgeVariant }> = {
    synced: { label: 'Sincronizado', variant: 'success' },
    pending: { label: 'Pendiente', variant: 'warning' },
    error: { label: 'Error', variant: 'danger' },
  }
  const item = map[status] ?? { label: status, variant: 'gray' }
  return <Badge variant={item.variant} size="sm">{item.label}</Badge>
}
