import { cn } from '@/lib/utils'

interface CardProps {
  children: React.ReactNode
  className?: string
  onClick?: () => void
  hover?: boolean
  padding?: 'sm' | 'md' | 'lg' | 'none'
}

const paddings = { sm: 'p-4', md: 'p-5', lg: 'p-6', none: '' }

export function Card({ children, className, onClick, hover, padding = 'md' }: CardProps) {
  return (
    <div
      className={cn(
        'bg-white rounded-2xl shadow-card border border-gray-100',
        paddings[padding],
        hover && 'hover:shadow-card-hover transition-shadow duration-200 cursor-pointer',
        className
      )}
      onClick={onClick}
    >
      {children}
    </div>
  )
}

interface KPICardProps {
  title: string
  value: string | number
  subtitle?: string
  icon?: React.ReactNode
  trend?: { value: number; label: string }
  color?: 'blue' | 'green' | 'red' | 'yellow' | 'purple' | 'gray'
  className?: string
}

const colors = {
  blue: { bg: 'bg-primary-50', icon: 'text-primary-600', border: 'border-primary-100' },
  green: { bg: 'bg-emerald-50', icon: 'text-emerald-600', border: 'border-emerald-100' },
  red: { bg: 'bg-red-50', icon: 'text-red-600', border: 'border-red-100' },
  yellow: { bg: 'bg-amber-50', icon: 'text-amber-600', border: 'border-amber-100' },
  purple: { bg: 'bg-purple-50', icon: 'text-purple-600', border: 'border-purple-100' },
  gray: { bg: 'bg-gray-50', icon: 'text-gray-500', border: 'border-gray-100' },
}

export function KPICard({ title, value, subtitle, icon, trend, color = 'blue', className }: KPICardProps) {
  const c = colors[color]
  return (
    <Card className={cn('overflow-hidden', className)}>
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide truncate">{title}</p>
          <p className="mt-1.5 text-2xl font-bold text-gray-900 truncate">{value}</p>
          {subtitle && <p className="mt-1 text-xs text-gray-500 truncate">{subtitle}</p>}
          {trend && (
            <p className={cn('mt-1.5 text-xs font-medium', trend.value >= 0 ? 'text-emerald-600' : 'text-red-500')}>
              {trend.value >= 0 ? '↑' : '↓'} {Math.abs(trend.value)}% {trend.label}
            </p>
          )}
        </div>
        {icon && (
          <div className={cn('flex-shrink-0 w-11 h-11 rounded-xl flex items-center justify-center', c.bg, `border ${c.border}`)}>
            <span className={c.icon}>{icon}</span>
          </div>
        )}
      </div>
    </Card>
  )
}
