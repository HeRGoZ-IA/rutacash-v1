// Piezas comunes de las pantallas de Base por Ruta (R74): importes, estados O9, alertas y la
// explicación de cada operación. Mismo vocabulario en todas (§7): Base, Inyección de Base, Retiro
// de Base, Entrega de Base, Devolución de Base, Caja principal (panel), Recaudo, Cobrador, Cuadre.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Droplets, Handshake, Sprout, TrendingDown, UserX, Scale, ShieldQuestion } from 'lucide-react';
import { formatCurrency } from '@/lib/formatters';
import { useTenant } from '@/hooks/useTenant';
import { cn } from '@/lib/utils';
import { toMajor } from '../mappers.ts';
import type { PanelAlert, PanelRoute } from './api.ts';

/** Importe en unidades menores → texto en la moneda de la empresa. */
export function useMoney() {
  const { currency } = useTenant();
  return (minor: number | null | undefined) => (minor == null ? '—' : formatCurrency(toMajor(minor), currency));
}

/** Clases de una cifra: números tabulares y negativos legibles sin depender solo del color. */
export const num = 'tabular-nums whitespace-nowrap';

// ---------------------------------------------------------------------------
// Estados O9: TRES estados distintos (nunca una alarma roja genérica). Una inyección no es pérdida.
// ---------------------------------------------------------------------------

const STATE_META = {
  negativeOperatingResult: {
    label: 'Resultado operativo negativo', icon: TrendingDown, cls: 'bg-red-50 text-red-800 ring-red-200',
    help: 'El interés cobrado no alcanzó a cubrir los gastos operativos de la ruta en el periodo.',
  },
  negativeFlowFromGrowth: {
    label: 'Flujo negativo por crecimiento de cartera', icon: Sprout, cls: 'bg-sky-50 text-sky-800 ring-sky-200',
    help: 'Se desembolsó más de lo que se recaudó: la cartera creció. No es una pérdida.',
  },
  insufficientLiquidity: {
    label: 'Insuficiencia de liquidez', icon: Droplets, cls: 'bg-amber-50 text-amber-900 ring-amber-200',
    help: 'Las ventas aprobadas sin desembolsar superan la Base disponible más el efectivo entregable de la ruta.',
  },
} as const;
export type StateKey = keyof typeof STATE_META;

export function activeStates(r: PanelRoute): StateKey[] {
  return (Object.keys(STATE_META) as StateKey[]).filter((k) => r.states[k] === true);
}

export function StateBadge({ k, detail }: { k: StateKey; detail?: string }) {
  const m = STATE_META[k];
  const Icon = m.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', m.cls)}
      title={m.help} data-testid={`state-${k}`}>
      <Icon className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />
      <span>{m.label}{detail ? ` · ${detail}` : ''}</span>
    </span>
  );
}
export const stateHelp = (k: StateKey) => STATE_META[k].help;
export const stateLabel = (k: StateKey) => STATE_META[k].label;

// ---------------------------------------------------------------------------
// Otras alertas del panel (las tres O9 se muestran con StateBadge, no aquí)
// ---------------------------------------------------------------------------

const ALERT_META: Partial<Record<PanelAlert, { label: string; icon: typeof AlertTriangle; cls: string }>> = {
  NO_VALID_CONTROLLER: { label: 'Sin responsable válido', icon: UserX, cls: 'bg-red-50 text-red-800 ring-red-200' },
  ROUTE_IN_HANDOVER: { label: 'Ruta en entrega', icon: Handshake, cls: 'bg-violet-50 text-violet-800 ring-violet-200' },
  HANDOVER_DIFFERENCE: { label: 'Diferencia en la última entrega', icon: Scale, cls: 'bg-gray-100 text-gray-700 ring-gray-200' },
  NEGATIVE_CUSTODY: { label: 'Base del trabajador negativa', icon: AlertTriangle, cls: 'bg-amber-50 text-amber-900 ring-amber-200' },
  CARRIED_SHORTAGE: { label: 'Faltante arrastrado', icon: AlertTriangle, cls: 'bg-amber-50 text-amber-900 ring-amber-200' },
  SURPLUS_IN_CONTROL: { label: 'Sobrante en control', icon: ShieldQuestion, cls: 'bg-gray-100 text-gray-700 ring-gray-200' },
  // 0036: faltantes o sobrantes sin conciliar (se resuelven en «Diferencias»).
  PENDING_DIFFERENCES: { label: 'Diferencias por conciliar', icon: Scale, cls: 'bg-amber-50 text-amber-900 ring-amber-200' },
};
const O9_ALERTS = new Set<PanelAlert>(['NEGATIVE_OPERATING_RESULT', 'NEGATIVE_FLOW_GROWTH', 'INSUFFICIENT_LIQUIDITY']);

export function otherAlerts(r: PanelRoute): PanelAlert[] {
  return r.alerts.filter((a) => !O9_ALERTS.has(a) && ALERT_META[a]);
}

export function AlertChip({ a, to }: { a: PanelAlert; to?: string }) {
  const m = ALERT_META[a];
  if (!m) return null;
  const Icon = m.icon;
  const cls = cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', m.cls);
  // Con destino (p. ej. «Diferencias por conciliar» → pantalla de Diferencias de esa ruta), la alerta es un enlace.
  if (to) return <Link to={to} className={cn(cls, 'hover:underline')} data-testid={`alert-${a}`}><Icon className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />{m.label}</Link>;
  return (
    <span className={cls} data-testid={`alert-${a}`}>
      <Icon className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />{m.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Explicación de una operación: de dónde sale, a dónde llega, quién registra, quién responde,
// qué saldo cambia y qué la impide. Se muestra en cada formulario, antes de registrar.
// ---------------------------------------------------------------------------

export interface Explanation { from: string; to: string; who: string; responsible: string; changes: string; limits: string[] }

export function ExplainPanel({ e, preview }: { e: Explanation; preview?: ReactNode }) {
  const rows: [string, string][] = [
    ['Sale de', e.from], ['Llega a', e.to], ['Registra', e.who], ['Queda responsable', e.responsible], ['Saldo que cambia', e.changes],
  ];
  return (
    <div className="rounded-xl bg-gray-50 border border-gray-200 p-3 text-sm" data-testid="op-explain">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-gray-500 text-xs pt-0.5">{k}</dt>
            <dd className="text-gray-900 min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {preview && <div className="mt-2 pt-2 border-t border-gray-200">{preview}</div>}
      {e.limits.length > 0 && (
        <ul className="mt-2 pt-2 border-t border-gray-200 space-y-0.5 text-xs text-gray-600 list-disc pl-4">
          {e.limits.map((l) => <li key={l}>{l}</li>)}
        </ul>
      )}
    </div>
  );
}

/** «Base de Ruta X: antes → después» (vista previa sin efectos; el servidor decide). */
export function BalancePreview({ label, before, after, money }: { label: string; before: number; after: number; money: (n: number) => string }) {
  const bad = after < 0;
  return (
    <p className={cn('flex flex-wrap items-center gap-x-2 text-sm', bad ? 'text-red-700' : 'text-gray-800')} data-testid="balance-preview">
      <span className={bad ? undefined : 'text-gray-600'}>{label}:</span>
      <span className={num}>{money(before)}</span>
      <ArrowRight className="w-3.5 h-3.5 text-gray-400" aria-hidden />
      <span className={cn(num, 'font-semibold')}>{money(after)}</span>
      {bad && <span className="text-xs">(no alcanza)</span>}
    </p>
  );
}

export function Notice({ tone = 'amber', children, testId }: { tone?: 'amber' | 'violet' | 'sky' | 'red' | 'gray'; children: ReactNode; testId?: string }) {
  const cls = {
    amber: 'bg-amber-50 border-amber-200 text-amber-900', violet: 'bg-violet-50 border-violet-200 text-violet-900',
    sky: 'bg-sky-50 border-sky-200 text-sky-900', red: 'bg-red-50 border-red-200 text-red-800',
    gray: 'bg-gray-50 border-gray-200 text-gray-700',
  }[tone];
  return <div className={cn('rounded-xl border px-3 py-2 text-sm', cls)} role="status" data-testid={testId}>{children}</div>;
}

/** Periodos del panel (afectan solo a las cifras del periodo; los saldos son siempre los actuales). */
export type PanelPeriod = 'hoy' | '7d' | 'mes' | 'rango';
export const PERIOD_LABEL: Record<PanelPeriod, string> = { hoy: 'Hoy', '7d': 'Últimos 7 días', mes: 'Este mes', rango: 'Rango' };

export function periodDates(p: PanelPeriod, today: string, custom: { from: string; to: string }): { from: string; to: string } {
  const d = (iso: string, days: number) => { const x = new Date(`${iso}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + days); return x.toISOString().slice(0, 10); };
  if (p === 'hoy') return { from: today, to: today };
  if (p === '7d') return { from: d(today, -6), to: today };
  if (p === 'mes') return { from: `${today.slice(0, 8)}01`, to: today };
  const from = custom.from || today;
  const to = custom.to && custom.to >= from ? custom.to : from;
  return { from, to };
}
