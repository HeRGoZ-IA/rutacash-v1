// MODELO DE CAPITAL · activación de Base por Ruta (R74 · O6). Pantalla ESTRUCTURAL del SuperAdmin:
// muestra los requisitos que comprueba PostgreSQL, el saldo de bolsas que quedará «sin asignar» y el
// formulario de autorización (evidencia + referencia de respaldo). NUNCA mueve dinero: cambia el
// modelo de la empresa y deja el acta. `admin_pool → route_base` es irreversible por la API;
// `migrating` congela las bolsas mientras se prepara el corte y se puede cancelar.

import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { CheckCircle2, ChevronLeft, CircleAlert, RefreshCw, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { toast } from '@/components/ui/Toast';
import { db } from '@/lib/db';
import { useTenant } from '@/hooks/useTenant';
import { useDataRevision } from '@/hooks/useDataRevision';
import { formatDateTime } from '@/lib/formatters';
import { formatPersonName } from '@/lib/displayName';
import { generateId, cn } from '@/lib/utils';
import type { Route } from '@/models/types';
import { useRuntime } from '../session.ts';
import { invalidate } from '../projection.ts';
import { fetchModel, fetchPrerequisites, transitionModel, type CapitalModel, type ModelInfo, type PrereqCheck, type Prerequisites } from './api.ts';
import { Notice, num, useMoney } from './parts.tsx';

const MODEL_LABEL: Record<CapitalModel, string> = { admin_pool: 'Bolsas de Administradores', migrating: 'En migración (bolsas congeladas)', route_base: 'Base por Ruta' };
const CHECK_LABEL: Record<string, string> = {
  'company-account-zero': 'Capital de la empresa sin asignar en cero',
  'transit-zero': 'Sin dinero en tránsito entre Administradores',
  'no-pending-admin-transfers': 'Sin transferencias entre Administradores pendientes',
  'no-pending-pool-requests': 'Sin solicitudes de capital de bolsa pendientes',
  'active-routes-have-controller': 'Toda ruta activa tiene un responsable válido',
  'ledger-clean': 'Libro de capital conciliado (sin descuadres, negativos ni patas fuera de ruta)',
  // 0036 (RB-D6): la activación directa solo para una empresa sin saldos; con saldos, primero «Migrando».
  'direct-activation-or-migrating': 'Activación directa solo sin saldos: con saldos, pasa primero por «Migrando»',
};

export default function ActivationPage() {
  const me = useRuntime((s) => s.ctx);
  const { tenantId } = useTenant();
  const money = useMoney();
  const navigate = useNavigate();
  const revision = useDataRevision();
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [pre, setPre] = useState<Prerequisites | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ target: 'route_base' as CapitalModel, evidence: '', backup: '', note: '', confirm: '' });
  const [saving, setSaving] = useState(false);
  const [opId, setOpId] = useState(() => generateId());

  const load = () => {
    Promise.all([fetchModel(), fetchPrerequisites(), db.routes.where('tenantId').equals(tenantId).toArray()])
      .then(([m, p, r]) => { setInfo(m); setPre(p); setRoutes(r); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo cargar'));
  };
  useEffect(load, [revision, tenantId]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (me && me.role !== 'superadmin') return <Navigate to="/admin/capital" replace />;

  const model = info?.model ?? 'admin_pool';
  const targets: { value: CapitalModel; label: string }[] = model === 'admin_pool'
    ? [{ value: 'route_base', label: 'Activar Base por Ruta' }, { value: 'migrating', label: 'Congelar bolsas para preparar el corte (migración)' }]
    : model === 'migrating' ? [{ value: 'route_base', label: 'Activar Base por Ruta' }, { value: 'admin_pool', label: 'Cancelar la migración (volver a bolsas)' }] : [];
  const target = targets.some((t) => t.value === f.target) ? f.target : targets[0]?.value ?? 'route_base';
  const companyCheck = pre?.checks.find((c) => c.name === 'company-account-zero');
  const blocking = (pre?.checks ?? []).filter((c) => !c.ok && !(c.name === 'company-account-zero' && f.note.trim().length >= 10));
  const toRouteBase = target === 'route_base';
  const word = toRouteBase ? 'ACTIVAR' : target === 'migrating' ? 'CONGELAR' : 'CANCELAR';
  const problem = f.evidence.trim().length < 10 ? 'La evidencia necesita mínimo 10 caracteres.'
    : toRouteBase && !f.backup.trim() ? 'Indica la referencia del respaldo verificado.'
      : toRouteBase && blocking.length > 0 ? 'Hay requisitos sin cumplir.'
        : f.confirm.trim().toUpperCase() !== word ? `Escribe ${word} para confirmar.` : null;

  async function save() {
    if (problem) { toast.error(problem); return; }
    setSaving(true);
    try {
      await transitionModel({ target, evidence: f.evidence, backupReference: toRouteBase ? f.backup : undefined,
        companyBalanceNote: toRouteBase && companyCheck && !companyCheck.ok ? f.note : undefined }, opId);
      toast.success(toRouteBase ? 'Base por Ruta activada' : target === 'migrating' ? 'Bolsas congeladas: migración en curso' : 'Migración cancelada');
      setF({ target: 'route_base', evidence: '', backup: '', note: '', confirm: '' });
      setOpId(generateId());
      invalidate();
      if (toRouteBase) navigate('/admin/capital');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error'); load(); } finally { setSaving(false); }
  }

  const detail = (c: PrereqCheck): string | null => {
    if (c.ok) return null;
    if (c.name === 'company-account-zero' || c.name === 'transit-zero') return `Saldo: ${money(Number(c.detail))}`;
    if (c.name === 'direct-activation-or-migrating') {
      const n = Number((c.detail as { nonZeroAccounts?: number } | null)?.nonZeroAccounts ?? 0);
      return `Hay ${n} cuenta(s) con saldo. Elige «Congelar bolsas para preparar el corte (migración)», reparte los saldos y después activa.`;
    }
    if (c.name === 'active-routes-have-controller' && Array.isArray(c.detail)) return `Rutas: ${(c.detail as string[]).map((id) => routes.find((r) => r.id === id)?.nombre ?? id).join(', ')}`;
    if (typeof c.detail === 'number') return `Pendientes: ${c.detail}`;
    if (c.detail && typeof c.detail === 'object') return Object.entries(c.detail as Record<string, unknown>).filter(([, v]) => Number(v) !== 0).map(([k, v]) => `${k}: ${String(v)}`).join(' · ');
    return null;
  };

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-4xl mx-auto w-full" data-testid="rb-activation">
      <div>
        <button type="button" onClick={() => navigate('/admin/capital')} className="text-sm text-primary-700 hover:underline inline-flex items-center gap-1"><ChevronLeft className="w-4 h-4" aria-hidden />Volver</button>
        <h1 className="text-xl font-bold text-gray-900 mt-1">Modelo de capital</h1>
        <p className="text-sm text-gray-600">Acto estructural del SuperAdmin. Esta pantalla no mueve dinero.</p>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : !info || !pre ? <div className="h-64 rounded-2xl bg-gray-100 animate-pulse" aria-busy="true" /> : (
        <>
          <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs text-gray-500">Modelo actual</p>
              <p className="text-base font-semibold text-gray-900" data-testid="rb-model-current">{MODEL_LABEL[model]}</p>
              {info.routeBaseSince && <p className="text-xs text-gray-500">Desde {formatDateTime(info.routeBaseSince)}</p>}
            </div>
            <Button variant="secondary" size="sm" onClick={load} icon={<RefreshCw className="w-3.5 h-3.5" />}>Volver a comprobar</Button>
          </section>

          {model !== 'route_base' && (
            <section className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 space-y-1.5" data-testid="rb-activation-warning">
              <p className="font-semibold flex items-center gap-2"><ShieldAlert className="w-4 h-4" aria-hidden />Antes de activar Base por Ruta</p>
              <ul className="list-disc pl-5 space-y-0.5">
                <li>Es <b>irreversible</b>: la empresa no vuelve al modelo de bolsas.</li>
                <li>El SuperAdmin deja de mover dinero: sin ingresos, retiros, asignaciones ni recogidas de capital de empresa.</li>
                <li>Cada ruta tiene su Base; solo su Administrador responsable inyecta, retira, entrega y transfiere.</li>
                <li>Lo que hoy está en las bolsas queda como «saldo sin asignar»: no se mueve; cada Administrador lo reparte a sus rutas con confirmación.</li>
                <li>Exige un respaldo verificado de la base de datos y su referencia. Las capturas sin conexión de los Cobradores siguen siendo válidas.</li>
              </ul>
            </section>
          )}

          <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-2" aria-labelledby="rb-pre-h" data-testid="rb-prereqs">
            <div className="flex items-center justify-between gap-2">
              <h2 id="rb-pre-h" className="text-sm font-semibold text-gray-900">Requisitos comprobados en el servidor</h2>
              <span className={cn('text-xs font-medium', pre.ok ? 'text-emerald-700' : 'text-amber-800')} data-testid="rb-prereqs-state">{pre.ok ? 'Todos cumplidos' : 'Hay requisitos pendientes'}</span>
            </div>
            <ul className="divide-y divide-gray-50">
              {pre.checks.map((c) => (
                <li key={c.name} className="flex items-start gap-2 py-2" data-testid={`rb-check-${c.name}`} data-ok={c.ok ? '1' : '0'}>
                  {c.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-600 flex-shrink-0" aria-label="Cumplido" /> : <CircleAlert className="w-4 h-4 mt-0.5 text-amber-600 flex-shrink-0" aria-label="Pendiente" />}
                  <div className="min-w-0">
                    <p className="text-sm text-gray-900">{CHECK_LABEL[c.name] ?? c.name}</p>
                    {detail(c) && <p className="text-xs text-gray-600 break-words">{detail(c)}{c.documentable ? ' · se puede documentar con una nota al activar' : ''}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-2" aria-labelledby="rb-pools-h" data-testid="rb-activation-pools">
            <h2 id="rb-pools-h" className="text-sm font-semibold text-gray-900">{model === 'route_base' ? 'Saldo sin asignar' : 'Bolsas que quedarán «sin asignar»'}</h2>
            {pre.unassignedPools.length === 0 ? <p className="text-sm text-gray-500">Ninguna bolsa con saldo.</p> : (
              <ul className="divide-y divide-gray-50">
                {pre.unassignedPools.map((p) => (
                  <li key={p.adminId} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                    <span className="min-w-0 truncate">{formatPersonName(p.name) || 'Administrador'}{p.status && p.status !== 'activo' ? ' (inactivo)' : ''}</span>
                    <span className={`${num} font-semibold`}>{money(p.balanceMinor)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {targets.length > 0 && (
            <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-3" aria-labelledby="rb-form-h" data-testid="rb-activation-form">
              <h2 id="rb-form-h" className="text-sm font-semibold text-gray-900">Autorizar el cambio</h2>
              <Select label="Cambio" value={target} onChange={(e) => setF((x) => ({ ...x, target: e.target.value as CapitalModel, confirm: '' }))} options={targets} />
              <Textarea label="Evidencia de la autorización" value={f.evidence} onChange={(e) => setF((x) => ({ ...x, evidence: e.target.value }))} rows={2} required maxLength={1000}
                hint="Quién lo autorizó y con qué conciliación o acta (mínimo 10 caracteres)." />
              {toRouteBase && (
                <Input label="Referencia del respaldo verificado" value={f.backup} onChange={(e) => setF((x) => ({ ...x, backup: e.target.value }))} required maxLength={300}
                  hint="Identificador del respaldo restaurado y comprobado antes del corte." />
              )}
              {toRouteBase && companyCheck && !companyCheck.ok && (
                <Textarea label="Nota sobre el capital de la empresa sin asignar" value={f.note} onChange={(e) => setF((x) => ({ ...x, note: e.target.value }))} rows={2} maxLength={500}
                  hint="Si no se puede dejar en cero antes del corte, documenta por qué (mínimo 10 caracteres)." />
              )}
              {toRouteBase && blocking.length > 0 && <Notice tone="amber" testId="rb-activation-blocked">No se puede activar: {blocking.map((c) => CHECK_LABEL[c.name] ?? c.name).join('; ')}.</Notice>}
              <Input label={`Escribe ${word} para confirmar`} value={f.confirm} onChange={(e) => setF((x) => ({ ...x, confirm: e.target.value }))} autoComplete="off" />
              <div className="flex justify-end">
                <Button variant={toRouteBase ? 'danger' : 'primary'} onClick={save} loading={saving} disabled={!!problem} data-testid="rb-activation-submit">
                  {toRouteBase ? 'Activar Base por Ruta' : target === 'migrating' ? 'Congelar bolsas' : 'Cancelar migración'}
                </Button>
              </div>
            </section>
          )}

          {info.activations.length > 0 && (
            <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-2" aria-labelledby="rb-act-h">
              <h2 id="rb-act-h" className="text-sm font-semibold text-gray-900">Historial de cambios de modelo</h2>
              <ul className="divide-y divide-gray-50">
                {[...info.activations].reverse().map((a) => (
                  <li key={a.id} className="py-2 text-sm">
                    <p className="text-gray-900">{MODEL_LABEL[a.fromModel as CapitalModel] ?? a.fromModel} → <b>{MODEL_LABEL[a.toModel as CapitalModel] ?? a.toModel}</b></p>
                    <p className="text-xs text-gray-600 break-words">{formatDateTime(a.createdAt)} · {a.evidence}{a.backupReference ? ` · respaldo ${a.backupReference}` : ''}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
