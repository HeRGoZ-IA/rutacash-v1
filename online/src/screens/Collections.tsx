// Recaudos: cobro de cuotas sobre créditos desembolsados, historial y anulación.
// Nada se calcula aquí como verdad: el servidor aplica la cascada por cuota, el tope al
// saldo, quién responde por el efectivo y el periodo. Cada cobro lleva su id de
// operación; si la respuesta se pierde, «Comprobar en el servidor» consulta ese id
// (nunca se repite a ciegas). Solo efectivo, como CLEAN.

import { useState, type FormEvent } from 'react';
import { useAction, useApp, useCtx, useResource } from '../lib/app.tsx';
import { useClients, useMembers, useRoutes, nameOf } from '../lib/lookups.ts';
import { date, money, parseMoney, ROLE } from '../lib/format.ts';
import { ActionMessage, Badge, Field, Loaded, Money, Refresh, Section } from '../ui.tsx';

interface Credit { id: string; routeId: string; clientId: string; saleValueMinor: number; totalValueMinor: number; balanceMinor: number; status: string; installmentsCount: number }
interface Installment { number: number; dueDate: string; amountMinor: number; balanceMinor: number; status: string }
export interface PaymentView {
  id: string; saleId: string; routeId: string; clientId: string; collectorId: string; createdBy: string; amountMinor: number; paymentDate: string;
  state: string; reversesPaymentId: string | null; correctionReason: string | null; createdAt: string;
}
interface CollectResult { appliedMinor: number; requestedMinor: number; capped: boolean; cappedMinor: number; newBalanceMinor: number; receiver: string; credit: { status: string } }

const STATE: Record<string, [string, 'ok' | 'warn' | 'bad' | 'info' | 'neutral']> = {
  active: ['Vigente', 'ok'], reversed: ['Anulado', 'bad'], reversal: ['Anulación', 'warn'], correction: ['Corrección', 'info'],
};
const INSTALLMENT: Record<string, string> = { pendiente: 'Pendiente', parcial: 'Parcial', pagada: 'Pagada', vencida: 'Vencida', adelantada: 'Adelantada' };

/** Ruta activa elegida (o la primera visible). */
function useRouteChoice() {
  const routes = useRoutes();
  const [routeId, setRouteId] = useState('');
  const route = (routes.data ?? []).find((r) => r.id === (routeId || routes.data?.[0]?.id));
  return { routes, route, setRouteId };
}

export function ContextLine({ routeName }: { routeName?: string }) {
  const { company, role } = useCtx();
  return <p className="muted small">Operando como <strong>{ROLE[role] ?? role}</strong> en <strong>{company.name}</strong>{routeName ? <> · ruta <strong>{routeName}</strong></> : null}. Saldos leídos del servidor.</p>;
}

export function Collections() {
  const { client } = useApp();
  const { can } = useCtx();
  const { routes, route, setRouteId } = useRouteChoice();
  const clients = useClients();
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const credits = useResource(async () => (route ? (await client.get<{ credits: Credit[] }>(`/v1/credits?routeId=${route.id}`)).credits : []), [route?.id, version]);
  const bump = () => setVersion((v) => v + 1);
  return (
    <>
      <Section title="Recaudos" actions={<Refresh r={credits} />}>
        <ContextLine routeName={route?.name} />
        <div className="row">
          <Field label="Ruta"><select value={route?.id ?? ''} onChange={(e) => { setRouteId(e.target.value); setOpen(null); }}>
            {(routes.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        </div>
        <Loaded r={credits} empty={(d) => d.filter((c) => c.status === 'activa').length === 0}>
          {(d) => (
            <ul className="list">
              {d.filter((c) => c.status === 'activa').map((c) => (
                <li key={c.id}>
                  <button className="row-button" onClick={() => setOpen(open === c.id ? null : c.id)}>
                    <strong>{nameOf(clients.data, c.clientId)}</strong>
                    <span>Saldo <Money minor={c.balanceMinor} /> de <Money minor={c.totalValueMinor} /> · {c.installmentsCount} cuotas</span>
                  </button>
                  {open === c.id ? <CollectPanel credit={c} canRegister={can('payment.register')} onDone={bump} /> : null}
                </li>
              ))}
            </ul>
          )}
        </Loaded>
      </Section>
      {route && can('payment.viewHistory') ? <PaymentHistory routeId={route.id} version={version} onChanged={bump} /> : null}
    </>
  );
}

function CollectPanel({ credit, canRegister, onDone }: { credit: Credit; canRegister: boolean; onDone: () => void }) {
  const { client } = useApp();
  const { company, role, can } = useCtx();
  const detail = useResource(() => client.get<{ credit: Credit; installments: Installment[] }>(`/v1/credits/${credit.id}`), [credit.id], 0);
  const members = useMembers(can('user.viewAll'));
  const action = useAction();
  const [amount, setAmount] = useState('');
  const [collectorId, setCollectorId] = useState('');
  const [note, setNote] = useState('');
  const personal = role === 'cobrador' || role === 'supervisor';
  const holders = (members.data ?? []).filter((m) => (m.role === 'cobrador' || m.role === 'supervisor') && m.status === 'activo' && m.routeIds.includes(credit.routeId));
  const current = detail.data?.installments.find((i) => i.status !== 'pagada');
  const fill = (minor: number) => setAmount((minor / 10 ** company.minorUnits).toFixed(company.minorUnits));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const amountMinor = parseMoney(amount, company.minorUnits);
    if (!amountMinor) return action.setMessage({ kind: 'error', text: 'Indique un importe válido.' });
    const body = { saleId: credit.id, amountMinor, ...(collectorId ? { collectorId } : {}), ...(note.trim() ? { note: note.trim() } : {}) };
    const fmt = (m: number) => money(m, company.currencyCode, company.minorUnits);
    const r = await action.run(() => client.command<CollectResult>('POST', '/v1/collections', body), (v) =>
      v.capped
        ? `Abono limitado al saldo pendiente: se aplicó ${fmt(v.appliedMinor)} de ${fmt(v.requestedMinor)} (no se registra saldo a favor). La deuda queda en ${fmt(0)}.`
        : `Abono de ${fmt(v.appliedMinor)} registrado. Saldo pendiente: ${fmt(v.newBalanceMinor)}.`);
    if (r) { setAmount(''); setNote(''); void detail.reload(); onDone(); }
  }
  return (
    <div className="detail">
      <Loaded r={detail}>
        {(d) => (
          <>
            <table className="table compact"><thead><tr><th>#</th><th>Vence</th><th className="right">Cuota</th><th className="right">Saldo</th><th>Estado</th></tr></thead>
              <tbody>{d.installments.map((i) => (
                <tr key={i.number}><td>{i.number}</td><td>{date(i.dueDate)}</td><td className="right"><Money minor={i.amountMinor} /></td>
                  <td className="right"><Money minor={i.balanceMinor} /></td><td>{INSTALLMENT[i.status] ?? i.status}</td></tr>))}</tbody></table>
            {canRegister && d.credit.status === 'activa' ? (
              <form className="form" onSubmit={(e) => void submit(e)}>
                <div className="row">
                  <Field label="Importe recibido en efectivo"><input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" /></Field>
                  {current ? <button type="button" className="ghost" onClick={() => fill(current.balanceMinor)}>Cuota #{current.number}</button> : null}
                  <button type="button" className="ghost" onClick={() => fill(d.credit.balanceMinor)}>Saldo total</button>
                </div>
                {personal ? <p className="muted small">El efectivo queda bajo su custodia en esta ruta.</p> : (
                  <Field label="¿Quién recibió el dinero?" hint="Si la ruta tiene un solo Cobrador se le atribuye; sin Cobrador, va a la bolsa del responsable de la ruta.">
                    <select value={collectorId} onChange={(e) => setCollectorId(e.target.value)}>
                      <option value="">Automático según la ruta</option>
                      {holders.map((m) => <option key={m.membershipId} value={m.membershipId}>{m.displayName} ({ROLE[m.role] ?? m.role})</option>)}
                    </select>
                  </Field>
                )}
                <Field label="Observación (opcional)"><input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
                <button className="primary" disabled={action.busy}>Registrar abono</button>
                <ActionMessage action={action} onResolved={() => { void detail.reload(); onDone(); }} />
              </form>
            ) : <p className="muted small">Este crédito no admite abonos{d.credit.status !== 'activa' ? ` (${d.credit.status})` : ''}.</p>}
            <PaymentHistory saleId={credit.id} version={0} onChanged={() => { void detail.reload(); onDone(); }} compact />
          </>
        )}
      </Loaded>
    </div>
  );
}

function PaymentHistory({ routeId, saleId, version, onChanged, compact }: { routeId?: string; saleId?: string; version: number; onChanged: () => void; compact?: boolean }) {
  const { client } = useApp();
  const { can } = useCtx();
  const clients = useClients();
  const q = saleId ? `saleId=${saleId}` : `routeId=${routeId}`;
  const list = useResource(async () => (await client.get<{ collections: PaymentView[] }>(`/v1/collections?${q}&limit=100`)).collections, [q, version]);
  const action = useAction();
  const [annul, setAnnul] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  async function reverse(p: PaymentView) {
    const r = await action.run(() => client.command('POST', `/v1/collections/${p.id}/reverse`, { reason: reason.trim() }), () => 'Pago anulado. El crédito se recalculó en el servidor.');
    if (r) { setAnnul(null); setReason(''); void list.reload(); onChanged(); }
  }
  const body = (
    <>
      <ActionMessage action={action} onResolved={() => { void list.reload(); onChanged(); }} />
      <Loaded r={list} empty={(d) => d.length === 0}>
        {(d) => (
          <ul className="list">
            {d.map((p) => {
              const [label, tone] = STATE[p.state] ?? [p.state, 'neutral'];
              return (
                <li key={p.id}><div className="row-static">
                  <strong><Money minor={p.amountMinor} /> · <Badge tone={tone}>{label}</Badge></strong>
                  <span className="muted small">{compact ? '' : `${nameOf(clients.data, p.clientId)} · `}{date(p.paymentDate)} · registrado {date(p.createdAt)}{p.correctionReason ? ` · motivo: ${p.correctionReason}` : ''}</span>
                  {can('payment.reverse') && p.state === 'active' ? (
                    annul === p.id ? (
                      <div className="row">
                        <Field label="Motivo de la anulación"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                        <button className="danger" disabled={action.busy || reason.trim().length < 3} onClick={() => void reverse(p)}>Confirmar anulación</button>
                        <button className="ghost" onClick={() => { setAnnul(null); setReason(''); }}>Cancelar</button>
                      </div>
                    ) : <button className="ghost" onClick={() => setAnnul(p.id)}>Anular</button>
                  ) : null}
                </div></li>
              );
            })}
          </ul>
        )}
      </Loaded>
    </>
  );
  return compact ? <><h3>Abonos del crédito</h3>{body}</> : <Section title="Historial de abonos de la ruta" actions={<Refresh r={list} />}>{body}</Section>;
}
