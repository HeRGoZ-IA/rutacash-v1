// Gastos: registro (trabajador, ruta, empresa), historial y correcciones (anulación y
// reintegro D12). Quién paga lo decide el servidor: el gasto del trabajador sale de su
// custodia aunque quede negativa (73209ce); el de ruta, de la bolsa del responsable; el
// de empresa, de la bolsa elegida. Cada comando lleva su id de operación.

import { useState, type FormEvent } from 'react';
import { useAction, useApp, useCtx, useResource } from '../lib/app.tsx';
import { useMembers, useRoutes, nameOf } from '../lib/lookups.ts';
import { date, parseMoney, ROLE } from '../lib/format.ts';
import { ActionMessage, Badge, Field, Loaded, Money, Refresh, Section } from '../ui.tsx';
import { ContextLine } from './Collections.tsx';

interface Category { id: string; name: string; active: boolean }
interface ExpenseView {
  id: string; scope: 'empresa' | 'ruta' | 'trabajador' | null; routeId: string | null; workerId: string | null; categoryId: string; amountMinor: number;
  description: string | null; expenseDate: string; registeredBy: string; funding: string | null; fundingAdminId: string | null; state: string;
  reversalReason: string | null; createdAt: string;
}
interface Position { routeId: string; workerId: string; balanceMinor: number; transferableMinor: number }

const SCOPE: Record<string, string> = { trabajador: 'Gasto de trabajador', ruta: 'Gasto de la ruta', empresa: 'Gasto administrativo' };
const STATE: Record<string, [string, 'ok' | 'warn' | 'bad' | 'info' | 'neutral']> = {
  vigente: ['Vigente', 'ok'], anulado: ['Anulado', 'bad'], anulacion: ['Anulación', 'warn'], reintegro: ['Reintegro', 'info'],
  historico: ['Histórico · sin bolsa', 'neutral'], legado: ['Importado', 'neutral'],
};

export function Expenses() {
  const { can } = useCtx();
  const [version, setVersion] = useState(0);
  return (
    <>
      {can('expense.register') ? <NewExpense onDone={() => setVersion((v) => v + 1)} /> : null}
      <ExpenseHistory version={version} />
    </>
  );
}

function NewExpense({ onDone }: { onDone: () => void }) {
  const { client } = useApp();
  const { company, role, membershipId, can } = useCtx();
  const routes = useRoutes();
  const members = useMembers(can('user.viewAll'));
  const categories = useResource(async () => (await client.get<{ categories: Category[] }>('/v1/expense-categories')).categories.filter((c) => c.active), [], 0);
  const custody = useResource(async () => (await client.get<{ positions: Position[] }>('/v1/capital/custody')).positions, [], 30_000);
  const action = useAction();
  const scopes = [
    'trabajador',
    ...(can('cashCustody.manage') && (role === 'admin' || role === 'superadmin') ? ['ruta'] : []),
    ...(can('cashbox.viewConsolidated') ? ['empresa'] : []),
  ];
  const [scope, setScope] = useState(scopes[0]!);
  const [routeId, setRouteId] = useState('');
  const [workerId, setWorkerId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [pool, setPool] = useState(role === 'admin' ? `admin:${membershipId}` : 'empresa');
  const route = (routes.data ?? []).find((r) => r.id === (routeId || routes.data?.[0]?.id));
  const personal = role === 'cobrador' || role === 'supervisor';
  const workers = (members.data ?? []).filter((m) => (m.role === 'cobrador' || m.role === 'supervisor') && m.status === 'activo' && route && m.routeIds.includes(route.id));
  const admins = (members.data ?? []).filter((m) => m.role === 'admin' && m.status === 'activo');
  const worker = workerId || (personal ? membershipId : workers[0]?.membershipId ?? '');
  const mine = (custody.data ?? []).find((p) => p.routeId === route?.id && p.workerId === worker);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const amountMinor = parseMoney(amount, company.minorUnits);
    const category = categoryId || categories.data?.[0]?.id;
    if (!amountMinor || !category) return action.setMessage({ kind: 'error', text: 'Indique categoría e importe válido.' });
    const body: Record<string, unknown> = { scope, categoryId: category, amountMinor, ...(description.trim() ? { description: description.trim() } : {}), ...(reference.trim() ? { reference: reference.trim() } : {}) };
    if (scope !== 'empresa') body['routeId'] = route?.id;
    if (scope === 'trabajador') body['workerId'] = worker;
    if (scope === 'empresa') {
      const [source, adminId] = pool.split(':');
      body['fundingSource'] = source;
      if (adminId) body['fundingAdminId'] = adminId;
    }
    const r = await action.run(() => client.command('POST', '/v1/expenses', body), () => 'Gasto registrado en el servidor.');
    if (r) { setAmount(''); setDescription(''); setReference(''); void custody.reload(); onDone(); }
  }
  return (
    <Section title="Registrar gasto">
      <ContextLine routeName={scope === 'empresa' ? undefined : route?.name} />
      <form className="form" onSubmit={(e) => void submit(e)}>
        <div className="row">
          <Field label="Tipo"><select value={scope} onChange={(e) => setScope(e.target.value)}>{scopes.map((s) => <option key={s} value={s}>{SCOPE[s]}</option>)}</select></Field>
          {scope !== 'empresa' ? (
            <Field label="Ruta"><select value={route?.id ?? ''} onChange={(e) => { setRouteId(e.target.value); setWorkerId(''); }}>
              {(routes.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
          ) : null}
          {scope === 'trabajador' && !personal ? (
            <Field label="Trabajador que pagó"><select value={worker} onChange={(e) => setWorkerId(e.target.value)}>
              {workers.map((m) => <option key={m.membershipId} value={m.membershipId}>{m.displayName} ({ROLE[m.role] ?? m.role})</option>)}</select></Field>
          ) : null}
          {scope === 'empresa' ? (
            <Field label="Bolsa que paga"><select value={pool} onChange={(e) => setPool(e.target.value)} disabled={role === 'admin'}>
              {role === 'admin' ? <option value={`admin:${membershipId}`}>Mi bolsa</option> : (
                <>
                  <option value="empresa">Bolsa de la empresa</option>
                  {admins.map((a) => <option key={a.membershipId} value={`admin:${a.membershipId}`}>Bolsa de {a.displayName}</option>)}
                </>
              )}
            </select></Field>
          ) : null}
        </div>
        <div className="row">
          <Field label="Categoría"><select value={categoryId || categories.data?.[0]?.id || ''} onChange={(e) => setCategoryId(e.target.value)}>
            {(categories.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Importe"><input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" /></Field>
        </div>
        <Field label={scope === 'empresa' ? 'Concepto (obligatorio)' : 'Descripción'}><input value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} required={scope === 'empresa'} /></Field>
        <Field label="Referencia del soporte (opcional)"><input value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} /></Field>
        {scope === 'trabajador' && mine ? (
          <p className="muted small">Efectivo a cargo del trabajador en esta ruta: <Money minor={mine.balanceMinor} />.
            {' '}El gasto se registra aunque lo supere: la posición puede quedar negativa y se concilia en el cuadre. Un negativo no se entrega ni se presta.</p>
        ) : null}
        {scope === 'ruta' ? <p className="muted small">Lo paga la bolsa del Administrador responsable de la ruta. Sin fondos suficientes, el servidor lo rechaza.</p> : null}
        <button className="primary" disabled={action.busy}>Registrar gasto</button>
        <ActionMessage action={action} onResolved={onDone} />
      </form>
    </Section>
  );
}

function ExpenseHistory({ version }: { version: number }) {
  const { client } = useApp();
  const { can, role, membershipId } = useCtx();
  const routes = useRoutes();
  const members = useMembers(can('user.viewAll'));
  const categories = useResource(async () => (await client.get<{ categories: Category[] }>('/v1/expense-categories')).categories, [], 0);
  const list = useResource(async () => (await client.get<{ expenses: ExpenseView[] }>('/v1/expenses?limit=100')).expenses, [version]);
  const action = useAction();
  const [open, setOpen] = useState<{ id: string; mode: 'reverse' | 'refund' } | null>(null);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const { company } = useCtx();
  const who = (id: string | null) => (id ? (members.data ?? []).find((m) => m.membershipId === id)?.displayName ?? 'Persona de la empresa' : '—');
  async function correct(e: ExpenseView) {
    const isRefund = open?.mode === 'refund';
    const amountMinor = isRefund ? parseMoney(amount, company.minorUnits) : null;
    if (isRefund && !amountMinor) return action.setMessage({ kind: 'error', text: 'Indique el importe reintegrado.' });
    const r = await action.run(() => (isRefund
      ? client.command('POST', `/v1/expenses/${e.id}/refunds`, { amountMinor, reason: reason.trim() })
      : client.command('POST', `/v1/expenses/${e.id}/reverse`, { reason: reason.trim() })),
    () => (isRefund ? 'Reintegro registrado.' : 'Gasto anulado.'));
    if (r) { setOpen(null); setReason(''); setAmount(''); void list.reload(); }
  }
  return (
    <Section title="Historial de gastos" actions={<Refresh r={list} />}>
      <ActionMessage action={action} onResolved={() => void list.reload()} />
      <Loaded r={list} empty={(d) => d.length === 0}>
        {(d) => (
          <ul className="list">
            {d.map((e) => {
              const [label, tone] = STATE[e.state] ?? [e.state, 'neutral'];
              // Bolsa: D12 (el servidor valida la bolsa). Ruta o trabajador (F5-D02): responsable de la
              // ruta o SuperAdmin, y no quien lo registró. El servidor lo revalida (también por persona).
              const routeOk = e.scope === 'empresa' || role === 'superadmin'
                || (routes.data ?? []).find((r) => r.id === e.routeId)?.capitalControllerId === membershipId;
              const correctable = can('expense.correct') && e.state === 'vigente' && routeOk && (e.scope === 'empresa' || e.registeredBy !== membershipId);
              return (
                <li key={e.id}><div className="row-static">
                  <strong><Money minor={e.amountMinor} /> · {SCOPE[e.scope ?? ''] ?? 'Gasto'} · <Badge tone={tone}>{label}</Badge></strong>
                  <span className="muted small">
                    {nameOf(categories.data, e.categoryId)} · {date(e.expenseDate)}
                    {e.routeId ? ` · ${nameOf(routes.data, e.routeId)}` : ''}
                    {e.workerId ? ` · a cargo de ${who(e.workerId)}` : ''}
                    {e.funding === 'empresa' ? ' · bolsa de la empresa' : e.funding === 'admin' ? ` · bolsa de ${who(e.fundingAdminId)}` : ''}
                    {e.description ? ` · ${e.description}` : ''}
                  </span>
                  {correctable ? (
                    open?.id === e.id ? (
                      <div className="row">
                        {open.mode === 'refund' ? <Field label="Importe reintegrado"><input inputMode="decimal" value={amount} onChange={(x) => setAmount(x.target.value)} /></Field> : null}
                        <Field label="Motivo"><input value={reason} onChange={(x) => setReason(x.target.value)} /></Field>
                        <button className="danger" disabled={action.busy || reason.trim().length < 3} onClick={() => void correct(e)}>{open.mode === 'refund' ? 'Registrar reintegro' : 'Confirmar anulación'}</button>
                        <button className="ghost" onClick={() => { setOpen(null); setReason(''); setAmount(''); }}>Cancelar</button>
                      </div>
                    ) : (
                      <div className="row">
                        <button className="ghost" onClick={() => setOpen({ id: e.id, mode: 'reverse' })}>Anular</button>
                        {e.scope === 'empresa' ? <button className="ghost" onClick={() => setOpen({ id: e.id, mode: 'refund' })}>Reintegro parcial</button> : null}
                      </div>
                    )
                  ) : null}
                </div></li>
              );
            })}
          </ul>
        )}
      </Loaded>
    </Section>
  );
}
