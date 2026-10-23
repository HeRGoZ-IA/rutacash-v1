// CONSULTAS v2 (Ronda 74 · bloque B): modelo PURO de la pantalla (tipos de la API, etiquetas,
// periodos en la zona horaria de la empresa, partes legibles y enlaces a comprobantes). Sin React:
// se prueba aparte y lo comparten Dinero, Actividad y el detalle.

import { formatClientName, formatPersonName } from '@/lib/displayName';

// ---------- Contrato de la API (`/v1/movements/{perspectives,cash,activity,detail}`) ----------

export type PerspectiveKind = 'company' | 'route' | 'admin' | 'custody';
export interface PerspectiveOption { key: string; kind: PerspectiveKind; label: string; routeId: string | null; membershipId: string | null; office: string | null }
export interface Perspectives { default: string | null; options: PerspectiveOption[]; timezone: string }

export interface Ref { id: string; name: string | null }
export interface Party { type: string; id?: string | null; name?: string | null; routeId?: string | null; routeName?: string | null }
interface RowBase {
  id: string; kind: string; reversesKind: string | null; at: string; date: string; localTime: string;
  route: { id: string; name: string | null; office: string | null } | null; toRoute: Ref | null;
  worker: Ref | null; counterpart: Ref | null; admin: Ref | null; client: Ref | null; actor: (Ref & { role: string | null }) | null;
  concept: string; status: string; reference: string | null; saleId: string | null; paymentId: string | null; expenseId: string | null; settlementId: string | null;
}
export interface CashRow extends RowBase {
  base: string; group: string; amountMinor: number; inMinor: number; outMinor: number; internalMinor: number; flow: 'in' | 'out' | 'internal';
  from: Party | null; to: Party | null; reversesOperationId: string | null;
}
export interface GroupTotal { group: string; inMinor: number; outMinor: number; internalMinor: number; count: number }
export interface CashPage {
  perspective: { key: string; kind: PerspectiveKind; label: string; routeId: string | null; membershipId: string | null; accounts: number };
  period: { from: string | null; to: string | null };
  summary: {
    openingMinor: number; inMinor: number; outMinor: number; internalMinor: number; closingMinor: number; count: number;
    groups: GroupTotal[]; ledger: { balanceMinor: number; ok: boolean }; outside: { count: number } | null;
  };
  filtered: { count: number; inMinor: number; outMinor: number; internalMinor: number };
  rows: CashRow[]; hasMore: boolean; limit: number; offset: number; timezone: string;
}
export interface ActivityRow extends RowBase { group: string; amountMinor: number | null }
export interface ActivityPage { perspective: CashPage['perspective']; period: CashPage['period']; total: number; rows: ActivityRow[]; hasMore: boolean; limit: number; offset: number }
export interface DetailLeg {
  leg: number; account: { kind: string; label: string; membershipId: string | null; name: string | null; routeId: string | null; routeName: string | null };
  cash: boolean; amountMinor: number; balanceAfterMinor: number;
}
export interface Detail {
  movement: RowBase & { base: string; money: boolean; localAt: string; timezone: string; amountMinor: number | null; from: Party | null; to: Party | null;
    reversesOperationId: string | null; reversedBy: string | null; actorRole: string | null };
  legs: DetailLeg[]; legsComplete: boolean;
}

// ---------- Etiquetas ----------

export const KIND_LABEL: Record<string, string> = {
  COMPANY_DEPOSIT: 'Depósito de capital', COMPANY_WITHDRAWAL: 'Retiro de capital', ADMIN_ALLOCATION: 'Inyección a bolsa',
  ADMIN_RETURN: 'Devolución a la empresa', PARTNER_CONTRIBUTION: 'Aporte de socio (histórico)', WORKER_DELIVERY: 'Entrega a trabajador',
  WORKER_RETURN: 'Devolución del trabajador', WORKER_TRANSFER: 'Traspaso entre trabajadores', ROUTE_REASSIGNMENT: 'Traspaso entre rutas',
  LOAN_DISBURSEMENT: 'Desembolso', COLLECTION: 'Recaudo', WORKER_EXPENSE: 'Gasto del trabajador', ROUTE_EXPENSE: 'Gasto de ruta',
  COMPANY_EXPENSE: 'Gasto de empresa', EXPENSE_REFUND: 'Reintegro de gasto', SETTLEMENT_RETURN: 'Entrega por cuadre',
  SETTLEMENT_SURPLUS: 'Sobrante de cuadre', ADMIN_TRANSFER_HOLD: 'Traspaso entre Administradores · salida',
  ADMIN_TRANSFER_APPLY: 'Traspaso entre Administradores · llegada', ADMIN_TRANSFER_RELEASE: 'Traspaso entre Administradores · devuelto',
  DISBURSEMENT_ADJUSTMENT: 'Corrección de desembolso', PRINCIPAL_RECLASSIFICATION: 'Reclasificación capital / interés',
  SALE_REQUEST: 'Solicitud de venta', SALE_APPROVAL: 'Venta autorizada', SALE_REJECTION: 'Solicitud rechazada',
  SALE_CANCELLATION: 'Venta aprobada cancelada', CUSTODY_SETTLEMENT: 'Cuadre', PERIOD_CLOSURE: 'Cierre de periodo',
  CREDIT_RECTIFICATION: 'Corrección de venta sin diferencia',
};

/** Etiqueta del movimiento; un tipo desconocido se muestra legible, nunca rompe la vista. */
export function kindLabel(kind: string, reversesKind?: string | null): string {
  if (kind === 'REVERSAL') return `Anulación · ${reversesKind ? (KIND_LABEL[reversesKind] ?? humanize(reversesKind)).toLowerCase() : 'operación'}`;
  return KIND_LABEL[kind] ?? humanize(kind);
}
function humanize(code: string): string {
  const t = code.toLowerCase().replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export const CASH_GROUPS: { value: string; label: string }[] = [
  { value: 'recaudos', label: 'Recaudos' }, { value: 'desembolsos', label: 'Desembolsos' }, { value: 'gastos', label: 'Gastos' },
  { value: 'capital', label: 'Capital, entregas y traspasos' }, { value: 'cuadres', label: 'Cuadres' }, { value: 'otros', label: 'Otros' },
];
export const ACTIVITY_GROUPS: { value: string; label: string }[] = [
  { value: 'solicitudes', label: 'Solicitudes' }, { value: 'decisiones', label: 'Autorizaciones y rechazos' },
  { value: 'cuadres', label: 'Cuadres' }, { value: 'cierres', label: 'Cierres' }, { value: 'contables', label: 'Correcciones y ajustes contables' },
];
export const groupLabel = (g: string) => CASH_GROUPS.find((x) => x.value === g)?.label ?? ACTIVITY_GROUPS.find((x) => x.value === g)?.label ?? humanize(g);

export const STATUS_LABEL: Record<string, string> = {
  aplicada: 'Aplicado', anulada: 'Anulado', anulacion: 'Anulación', pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada',
  disbursed: 'Desembolsada', cancelled: 'Cancelada', cerrada: 'Cerrado', reabierta: 'Reabierto', cerrado: 'Cerrado',
};
export const ROLE_LABEL: Record<string, string> = {
  superadmin: 'SuperAdmin', admin: 'Administrador', supervisor: 'Supervisor', cobrador: 'Cobrador', secretario: 'Secretario', socio: 'Socio',
};

// ---------- Personas y partes ----------

export const person = (r: { name: string | null } | null | undefined, fallback = 'Usuario') => formatPersonName(r?.name ?? '') || fallback;

/** Parte legible (sin truncar: la vista abrevia con CSS y el detalle la muestra completa). */
export function partyLabel(p: Party | null | undefined): string {
  if (!p) return '—';
  const name = formatPersonName(p.name ?? '');
  switch (p.type) {
    case 'pool': return `Bolsa de ${name || 'Administrador'}`;
    case 'custody': return name || 'Trabajador';
    case 'company': return 'Empresa';
    case 'client': return formatClientName(p.name ?? '') || 'Cliente';
    case 'expense': return `Gasto · ${p.name ?? ''}`.trim();
    case 'external': return 'Fuera de la empresa';
    case 'transit': return `Bolsa de ${name || 'Administrador'} · en tránsito`;
    case 'control': return 'Sobrante en control';
    case 'unidentified': return 'Origen sin identificar';
    case 'partner': return `Socio ${name}`.trim();
    default: return name || '—';
  }
}

/** «Persona / concepto»: la OTRA parte vista desde la perspectiva (nunca el cliente dos veces). */
export function counterpartOf(r: CashRow): string {
  if (r.flow === 'in') return partyLabel(r.from);
  if (r.flow === 'out') return partyLabel(r.to);
  return `${partyLabel(r.from)} → ${partyLabel(r.to)}`;
}

// ---------- Fechas en la zona horaria de la empresa ----------

export function todayIn(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function shift(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type PeriodPreset = 'hoy' | 'ayer' | '7d' | 'mes' | 'mes-anterior' | 'todo' | 'rango';
export const PERIODS: { value: PeriodPreset; label: string }[] = [
  { value: 'hoy', label: 'Hoy' }, { value: 'ayer', label: 'Ayer' }, { value: '7d', label: 'Últimos 7 días' },
  { value: 'mes', label: 'Este mes' }, { value: 'mes-anterior', label: 'Mes anterior' }, { value: 'todo', label: 'Todo el historial' },
  { value: 'rango', label: 'Elegir fechas…' },
];
/** Rango [desde, hasta] del periodo, con «hoy» de la EMPRESA (no del dispositivo). */
export function periodRange(p: PeriodPreset, today: string, custom: { from?: string; to?: string } = {}): { from: string | null; to: string | null } {
  switch (p) {
    case 'hoy': return { from: today, to: today };
    case 'ayer': { const y = shift(today, -1); return { from: y, to: y }; }
    case '7d': return { from: shift(today, -6), to: today };
    case 'mes': return { from: `${today.slice(0, 8)}01`, to: today };
    case 'mes-anterior': {
      const first = `${today.slice(0, 8)}01`;
      const last = shift(first, -1);
      return { from: `${last.slice(0, 8)}01`, to: last };
    }
    case 'todo': return { from: null, to: null };
    case 'rango': return { from: custom.from || null, to: custom.to || null };
  }
}

/** «jueves 23 oct» (fecha contable, sin zona: es un día, no un instante). */
export function dayHeading(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return new Intl.DateTimeFormat('es', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}
/** Fecha y hora completas en la zona horaria de la EMPRESA. */
export function fullDateTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('es', { timeZone: timezone, dateStyle: 'full', timeStyle: 'medium' }).format(new Date(iso));
}
/** Hora «HH:MM» de un instante en la zona de la empresa (la API ya la manda; esto la respalda). */
export function timeIn(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('es', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

// ---------- Comprobantes (vista imprimible ya existente de CLEAN) ----------

const LEDGER_KINDS = ['COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION'];
/**
 * Ruta del comprobante, con la misma identidad que la proyección del historial (`capitalRecords.ts`):
 * fuente + id del registro. null = ese movimiento no tiene comprobante en el historial.
 */
export function receiptPath(m: { id: string; kind: string; reversesKind: string | null; admin: Ref | null; route: { id: string } | null; expenseId: string | null }): string | null {
  const k = m.kind === 'REVERSAL' ? m.reversesKind ?? '' : m.kind;
  const at = (fuente: string, id = m.id) => `/comprobante/${fuente}/${encodeURIComponent(id)}`;
  if (m.expenseId) return at('expenses', m.expenseId);
  if (LEDGER_KINDS.includes(k)) return at('capitalLedger');
  if (k === 'WORKER_DELIVERY' && m.route) return at('capitalMovements');
  if (k === 'WORKER_RETURN' && m.route) return at('withdrawals');
  if (k === 'WORKER_TRANSFER' && m.route) return at('cashCustodyMovements');
  if (k === 'ROUTE_REASSIGNMENT' && m.route) return at('transfers');
  if (m.admin && m.route && (k === 'LOAN_DISBURSEMENT' || k === 'ROUTE_EXPENSE')) return at('capitalMovements');
  if (m.admin && m.route && (k === 'COLLECTION' || k === 'SETTLEMENT_RETURN')) return at('withdrawals');
  return null;
}

// ---------- Consulta ----------

export interface Filters {
  perspective: string; period: PeriodPreset; from?: string; to?: string; group: string;
  flow: '' | 'in' | 'out' | 'internal'; personId: string; status: string; q: string; minAmount: string; maxAmount: string;
  sort: 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc'; clientId: string;
}
export const EMPTY_EXTRA: Pick<Filters, 'flow' | 'personId' | 'status' | 'q' | 'minAmount' | 'maxAmount' | 'sort' | 'clientId'> =
  { flow: '', personId: '', status: '', q: '', minAmount: '', maxAmount: '', sort: 'date_desc', clientId: '' };

/** Número de «Más filtros» activos (para el botón). */
export function extraCount(f: Filters): number {
  return [f.flow, f.personId, f.status, f.q.trim(), f.minAmount, f.maxAmount, f.clientId].filter(Boolean).length + (f.sort !== 'date_desc' ? 1 : 0);
}

/** Query string para la API. Importes mínimos/máximos en unidades MAYORES → menores. */
export function queryOf(f: Filters, today: string, offset: number, limit: number, minorUnits: number, view: 'cash' | 'activity'): string {
  const q = new URLSearchParams({ perspective: f.perspective, sort: f.sort, limit: String(limit), offset: String(offset) });
  const { from, to } = periodRange(f.period, today, { from: f.from, to: f.to });
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if (f.group) q.set('group', f.group);
  if (f.personId) q.set('personId', f.personId);
  if (f.clientId) q.set('clientId', f.clientId);
  if (f.q.trim()) q.set('q', f.q.trim());
  if (view === 'cash') {
    if (f.flow) q.set('flow', f.flow);
    if (f.status) q.set('status', f.status);
    const minor = (v: string) => String(Math.round(Number(v.replace(',', '.')) * 10 ** minorUnits));
    if (f.minAmount && Number.isFinite(Number(f.minAmount.replace(',', '.')))) q.set('minAmount', minor(f.minAmount));
    if (f.maxAmount && Number.isFinite(Number(f.maxAmount.replace(',', '.')))) q.set('maxAmount', minor(f.maxAmount));
  }
  return q.toString();
}
