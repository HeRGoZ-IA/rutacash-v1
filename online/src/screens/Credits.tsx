// Créditos: solicitud (Cobrador y demás roles con `sale.createRequest`), bandeja de
// autorizaciones, confirmación del desembolso real y consulta de créditos originados.
// Ninguna cifra se calcula aquí como verdad: totales y cuotas los fija el servidor.

import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAction, useApp, useCtx, useResource } from '../lib/app.tsx';
import { useClients, useRoutes, nameOf } from '../lib/lookups.ts';
import { date, FREQUENCY, parseMoney, REQUEST_STATUS, todayIn } from '../lib/format.ts';
import { ActionMessage, Badge, Field, Loaded, Money, Refresh, Section } from '../ui.tsx';

interface Request {
  id: string; clientId: string; routeId: string; requestedBy: string; status: string; amountMinor: number; interestRate: number;
  totalAmountMinor: number; installmentsCount: number; installmentValueMinor: number; frequency: string; startDate: string; paymentDays: number[];
  requestedAt: string; reviewedAt: string | null; reviewedBy: string | null; rejectionReason: string | null; approvalNotes: string | null;
  saleId: string | null; authorizationReason: string | null; approved: { interestRate: number | null; frequency: string | null } | null;
}

const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const tone = (s: string) => (s === 'disbursed' ? 'ok' : s === 'approved' ? 'info' : s === 'pending' ? 'warn' : 'bad');

function useRequests(status?: string) {
  const { client } = useApp();
  return useResource(async () => (await client.get<{ requests: Request[] }>(`/v1/credit-requests${status ? `?status=${status}` : ''}`)).requests, [status]);
}

function Conditions({ r }: { r: Request }) {
  return (
    <span className="muted small">
      <Money minor={r.amountMinor} /> al {r.interestRate} % → total <Money minor={r.totalAmountMinor} /> en {r.installmentsCount} cuotas de <Money minor={r.installmentValueMinor} />
      {' '}· {FREQUENCY[r.frequency] ?? r.frequency} · inicia {date(r.startDate)}
    </span>
  );
}

export function Requests() {
  const { can } = useCtx();
  const list = useRequests();
  const clients = useClients();
  const routes = useRoutes();
  return (
    <>
      {can('sale.createRequest') ? <NewRequest onDone={() => void list.reload()} /> : null}
      <Section title="Solicitudes" actions={<Refresh r={list} />}>
        <Loaded r={list} empty={(d) => d.length === 0}>
          {(d) => (
            <ul className="list">
              {[...d].reverse().map((r) => (
                <li key={r.id}><div className="row-static">
                  <strong>{nameOf(clients.data, r.clientId)}</strong>
                  <span>{nameOf(routes.data, r.routeId)} · <Badge tone={tone(r.status)}>{REQUEST_STATUS[r.status] ?? r.status}</Badge> · {date(r.requestedAt)}</span>
                  <Conditions r={r} />
                  {r.rejectionReason ? <span className="muted small">Motivo: {r.rejectionReason}</span> : null}
                </div></li>
              ))}
            </ul>
          )}
        </Loaded>
      </Section>
    </>
  );
}

function NewRequest({ onDone }: { onDone: () => void }) {
  const { client } = useApp();
  const { company, role } = useCtx();
  const [params] = useSearchParams();
  const routes = useRoutes();
  const clients = useClients();
  const action = useAction();
  const [routeId, setRouteId] = useState(params.get('ruta') ?? '');
  const [clientId, setClientId] = useState(params.get('cliente') ?? '');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState(20);
  const [count, setCount] = useState(20);
  const [frequency, setFrequency] = useState('diaria');
  const [start, setStart] = useState(todayIn(company.timezone));
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const route = (routes.data ?? []).find((r) => r.id === (routeId || routes.data?.[0]?.id));
  const routeClients = (clients.data ?? []).filter((c) => c.routeId === route?.id && c.status === 'activo');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const amountMinor = parseMoney(amount, company.minorUnits);
    if (!route || !amountMinor) return action.setMessage({ kind: 'error', text: 'Indique ruta, cliente e importe válido.' });
    const body = { routeId: route.id, clientId: clientId || routeClients[0]?.id, amountMinor, interestRate: role === 'cobrador' ? 20 : rate,
      installmentsCount: count, frequency, startDate: start, paymentDays: days };
    const r = await action.run(() => client.command<Request>('POST', '/v1/credit-requests', body), () => 'Solicitud enviada. Queda pendiente de autorización.');
    if (r) { setAmount(''); onDone(); }
  }
  return (
    <Section title="Nueva solicitud de préstamo">
      <form className="form" onSubmit={(e) => void submit(e)}>
        <div className="row">
          <Field label="Ruta"><select value={route?.id ?? ''} onChange={(e) => { setRouteId(e.target.value); setClientId(''); }}>
            {(routes.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
          <Field label="Cliente"><select value={clientId || routeClients[0]?.id || ''} onChange={(e) => setClientId(e.target.value)}>
            {routeClients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        </div>
        <div className="row">
          <Field label="Importe"><input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" /></Field>
          <Field label="Tasa" hint={role === 'cobrador' ? 'El Cobrador solicita al 20 %; el 10 % lo fija quien autoriza.' : undefined}>
            <select value={role === 'cobrador' ? 20 : rate} disabled={role === 'cobrador'} onChange={(e) => setRate(Number(e.target.value))}><option value={20}>20 %</option><option value={10}>10 %</option></select>
          </Field>
          <Field label="Cuotas"><input type="number" min={1} max={1000} value={count} onChange={(e) => setCount(Number(e.target.value))} /></Field>
        </div>
        <div className="row">
          <Field label="Frecuencia"><select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            {['diaria', 'semanal', 'quincenal', 'mensual'].map((f) => <option key={f} value={f}>{FREQUENCY[f]}</option>)}</select></Field>
          <Field label="Primera cuota"><input type="date" value={start} min={todayIn(company.timezone)} onChange={(e) => setStart(e.target.value)} /></Field>
        </div>
        <fieldset className="days"><legend>Días de cobro</legend>
          {DAYS.map((d, i) => (
            <label key={d}><input type="checkbox" checked={days.includes(i)} onChange={(e) => setDays(e.target.checked ? [...days, i].sort() : days.filter((x) => x !== i))} /> {d}</label>
          ))}
        </fieldset>
        <button className="primary" disabled={action.busy || !routeClients.length}>Enviar solicitud</button>
        <ActionMessage action={action} onResolved={onDone} />
      </form>
    </Section>
  );
}

export function Authorizations() {
  const { client } = useApp();
  const { can, membershipId } = useCtx();
  const pending = useRequests('pending');
  const clients = useClients();
  const routes = useRoutes();
  const action = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [rate, setRate] = useState<number | null>(null);
  const [reason, setReason] = useState('');

  async function resolve(r: Request, verdict: 'approve' | 'reject') {
    const body = verdict === 'approve'
      ? { ...(notes ? { notes } : {}), ...(rate !== null && rate !== r.interestRate ? { interestRate: rate } : {}) }
      : { reason };
    // Sin idempotencia en el servidor: ante la duda se relee el estado (nunca se repite a ciegas).
    const done = await action.run(() => client.send('POST', `/v1/credit-requests/${r.id}/${verdict}`, body),
      () => (verdict === 'approve' ? 'Solicitud aprobada. Pendiente de desembolso.' : 'Solicitud rechazada.'));
    setOpen(null); setNotes(''); setRate(null); setReason('');
    if (done !== undefined) void pending.reload();
  }
  return (
    <Section title="Autorizaciones pendientes" actions={<Refresh r={pending} />}>
      <ActionMessage action={action} />
      <Loaded r={pending} empty={(d) => d.length === 0}>
        {(d) => (
          <ul className="list">
            {d.map((r) => {
              const own = r.requestedBy === membershipId;
              return (
                <li key={r.id}>
                  <div className="row-static">
                    <strong>{nameOf(clients.data, r.clientId)}</strong>
                    <span>{nameOf(routes.data, r.routeId)} · solicitada {date(r.requestedAt)}{r.authorizationReason ? ` · motivo: ${r.authorizationReason}` : ''}</span>
                    <Conditions r={r} />
                    {own ? <Badge tone="warn">Propia: no puede resolverla</Badge> : (
                      <div className="row">
                        <button onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Cerrar' : 'Resolver'}</button>
                      </div>
                    )}
                  </div>
                  {open === r.id ? (
                    <div className="detail form">
                      {can('authorization.modifyConditions') ? (
                        <Field label="Tasa autorizada"><select value={rate ?? r.interestRate} onChange={(e) => setRate(Number(e.target.value))}>
                          <option value={20}>20 %</option><option value={10}>10 %</option></select></Field>
                      ) : null}
                      <Field label="Notas de aprobación (opcional)"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
                      <button className="primary" disabled={action.busy} onClick={() => void resolve(r, 'approve')}>Aprobar</button>
                      <Field label="Motivo del rechazo"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                      <button className="danger" disabled={action.busy || reason.trim().length < 3} onClick={() => void resolve(r, 'reject')}>Rechazar</button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Loaded>
    </Section>
  );
}

export function Disbursements() {
  const { client } = useApp();
  const { can } = useCtx();
  const approved = useRequests('approved');
  const clients = useClients();
  const routes = useRoutes();
  const action = useAction();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [handed, setHanded] = useState(false);
  const [version, setVersion] = useState(0);

  async function disburse(r: Request) {
    const credit = await action.run(() => client.command<{ credit: { id: string } }>('POST', `/v1/credit-requests/${r.id}/disburse`, {}),
      () => 'Desembolso confirmado: el crédito quedó originado.');
    setConfirming(null); setHanded(false);
    void approved.reload();
    if (credit) setVersion((v) => v + 1);
  }
  return (
    <>
      {can('sale.confirmDisbursement') ? (
        <Section title="Desembolsos por confirmar" actions={<Refresh r={approved} />}>
          <p className="muted small">Confirme solo el dinero EFECTIVAMENTE entregado al cliente. Sale de su efectivo en custodia de esa ruta; sin fondos suficientes, el servidor lo rechaza y no se crea nada.</p>
          <ActionMessage action={action} onResolved={() => void approved.reload()} />
          <Loaded r={approved} empty={(d) => d.length === 0}>
            {(d) => (
              <ul className="list">
                {d.map((r) => (
                  <li key={r.id}><div className="row-static">
                    <strong>{nameOf(clients.data, r.clientId)}</strong>
                    <span>{nameOf(routes.data, r.routeId)} · aprobada {date(r.reviewedAt)}</span>
                    <Conditions r={r} />
                    {confirming === r.id ? (
                      <div className="form">
                        <label className="check"><input type="checkbox" checked={handed} onChange={(e) => setHanded(e.target.checked)} /> Entregué <Money minor={r.amountMinor} /> en efectivo al cliente</label>
                        <div className="row">
                          <button className="primary" disabled={!handed || action.busy} onClick={() => void disburse(r)}>Confirmar desembolso</button>
                          <button className="ghost" onClick={() => { setConfirming(null); setHanded(false); }}>Cancelar</button>
                        </div>
                      </div>
                    ) : <div className="row"><button onClick={() => setConfirming(r.id)}>Desembolsar</button></div>}
                  </div></li>
                ))}
              </ul>
            )}
          </Loaded>
        </Section>
      ) : null}
      {can('sale.viewActive') ? <CreditList version={version} /> : null}
    </>
  );
}

interface Credit { id: string; routeId: string; clientId: string; saleValueMinor: number; totalValueMinor: number; balanceMinor: number; installmentsCount: number; status: string; disbursementDate: string | null; saleRequestId: string | null }

function CreditList({ version }: { version: number }) {
  const { client } = useApp();
  const list = useResource(async () => (await client.get<{ credits: Credit[] }>('/v1/credits')).credits, [version]);
  const clients = useClients();
  const routes = useRoutes();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Section title="Créditos originados" actions={<Refresh r={list} />}>
      <Loaded r={list} empty={(d) => d.length === 0}>
        {(d) => (
          <ul className="list">
            {d.map((c) => (
              <li key={c.id}>
                <button className="row-button" onClick={() => setOpen(open === c.id ? null : c.id)}>
                  <strong>{nameOf(clients.data, c.clientId)}</strong>
                  <span>{nameOf(routes.data, c.routeId)} · desembolsado {date(c.disbursementDate)} · <Money minor={c.saleValueMinor} /> · saldo <Money minor={c.balanceMinor} /></span>
                </button>
                {open === c.id ? <CreditDetail id={c.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </Loaded>
    </Section>
  );
}

function CreditDetail({ id }: { id: string }) {
  const { client } = useApp();
  const detail = useResource(() => client.get<{ installments: { number: number; dueDate: string; amountMinor: number; balanceMinor: number; status: string }[]; events: { action: string; actorRole: string | null; at: string; description: string }[] }>(`/v1/credits/${id}`), [id], 0);
  return (
    <div className="detail">
      <Loaded r={detail}>
        {(d) => (
          <>
            <h3>Cuotas</h3>
            <table className="table compact"><thead><tr><th>#</th><th>Vence</th><th className="right">Cuota</th><th className="right">Saldo</th></tr></thead>
              <tbody>{d.installments.map((i) => <tr key={i.number}><td>{i.number}</td><td>{date(i.dueDate)}</td><td className="right"><Money minor={i.amountMinor} /></td><td className="right"><Money minor={i.balanceMinor} /></td></tr>)}</tbody></table>
            <h3>Trazabilidad</h3>
            <ul className="mini">{d.events.map((e, i) => <li key={i}>{date(e.at)} · {e.description}{e.actorRole ? ` (${e.actorRole})` : ''}</li>)}</ul>
          </>
        )}
      </Loaded>
    </div>
  );
}
