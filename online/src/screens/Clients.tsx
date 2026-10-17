// Clientes de las rutas del contexto: listado, consulta, alta y paso a «solicitar préstamo».

import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAction, useApp, useCtx, useResource } from '../lib/app.tsx';
import { useClients, useRoutes, nameOf, type ClientView } from '../lib/lookups.ts';
import { date, REQUEST_STATUS } from '../lib/format.ts';
import { ActionMessage, Badge, Field, Loaded, Money, Refresh, Section } from '../ui.tsx';

export function Clients() {
  const { can } = useCtx();
  const clients = useClients();
  const routes = useRoutes();
  const [q, setQ] = useState('');
  const [routeId, setRouteId] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const filtered = useMemo(() => (clients.data ?? []).filter((c) => (!routeId || c.routeId === routeId)
    && (!q || `${c.name} ${c.document}`.toLowerCase().includes(q.toLowerCase()))), [clients.data, q, routeId]);

  return (
    <>
      <Section title="Clientes" actions={<>
        {can('client.create') ? <button className="primary" onClick={() => setCreating(!creating)}>{creating ? 'Cerrar alta' : 'Nuevo cliente'}</button> : null}
        <Refresh r={clients} />
      </>}>
        {creating ? <NewClient onDone={(id) => { setCreating(false); setSelected(id); void clients.reload(); }} /> : null}
        <div className="filters">
          <input placeholder="Buscar por nombre o documento" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={routeId} onChange={(e) => setRouteId(e.target.value)}>
            <option value="">Todas mis rutas</option>
            {(routes.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <Loaded r={clients} empty={() => filtered.length === 0}>
          {() => (
            <ul className="list">
              {filtered.map((c) => (
                <li key={c.id} className={selected === c.id ? 'active' : ''}>
                  <button className="row-button" onClick={() => setSelected(selected === c.id ? null : c.id)}>
                    <strong>{c.name}</strong>
                    <span className="muted">{c.documentType ?? ''} {c.document} · {nameOf(routes.data, c.routeId)}</span>
                    {c.status !== 'activo' ? <Badge tone="warn">{c.status}</Badge> : null}
                  </button>
                  {selected === c.id ? <ClientDetail c={c} /> : null}
                </li>
              ))}
            </ul>
          )}
        </Loaded>
      </Section>
    </>
  );
}

function ClientDetail({ c }: { c: ClientView }) {
  const { client } = useApp();
  const { can } = useCtx();
  const nav = useNavigate();
  const credits = useResource(async () => (can('sale.viewActive')
    ? (await client.get<{ credits: { id: string; saleValueMinor: number; balanceMinor: number; status: string; disbursementDate: string | null }[] }>(`/v1/credits?clientId=${encodeURIComponent(c.id)}`)).credits
    : []), [c.id], 0);
  const requests = useResource(async () => (await client.get<{ requests: { id: string; clientId: string; status: string; amountMinor: number; requestedAt: string }[] }>('/v1/credit-requests')).requests
    .filter((r) => r.clientId === c.id), [c.id], 0);
  return (
    <div className="detail">
      <dl className="grid2">
        <dt>Teléfono</dt><dd>{c.phonePrimary}</dd>
        <dt>Residencia</dt><dd>{c.addressPrimary}</dd>
        <dt>Cobro</dt><dd>{c.addressSecondary ?? '—'}</dd>
        <dt>Negocio</dt><dd>{c.business ?? '—'}</dd>
        <dt>Alta</dt><dd>{date(c.createdAt)}</dd>
      </dl>
      <h3>Créditos</h3>
      <Loaded r={credits} empty={(d) => d.length === 0}>
        {(d) => <ul className="mini">{d.map((x) => <li key={x.id}><Money minor={x.saleValueMinor} /> · saldo <Money minor={x.balanceMinor} /> · {x.status} · {date(x.disbursementDate)}</li>)}</ul>}
      </Loaded>
      <h3>Solicitudes</h3>
      <Loaded r={requests} empty={(d) => d.length === 0}>
        {(d) => <ul className="mini">{d.map((x) => <li key={x.id}><Money minor={x.amountMinor} /> · {REQUEST_STATUS[x.status] ?? x.status} · {date(x.requestedAt)}</li>)}</ul>}
      </Loaded>
      {can('sale.createRequest') && c.status === 'activo'
        ? <button className="primary" onClick={() => nav(`/app/solicitudes?cliente=${encodeURIComponent(c.id)}&ruta=${encodeURIComponent(c.routeId)}`)}>Solicitar préstamo</button>
        : null}
    </div>
  );
}

function NewClient({ onDone }: { onDone: (id: string) => void }) {
  const { client } = useApp();
  const routes = useRoutes();
  const types = useResource(async () => (await client.get<{ documentTypes: { code: string; label: string }[] }>('/v1/document-types')).documentTypes, [], 0);
  const action = useAction();
  const [f, setF] = useState({ routeId: '', name: '', documentType: '', document: '', phonePrimary: '', addressPrimary: '', addressSecondary: '', business: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = { ...f, routeId: f.routeId || routes.data?.[0]?.id, documentType: f.documentType || types.data?.[0]?.code, business: f.business || undefined };
    const created = await action.run(() => client.command<{ id: string }>('POST', '/v1/clients', body), () => 'Cliente registrado.');
    if (created) onDone(created.id);
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <Field label="Ruta"><select value={f.routeId} onChange={set('routeId')}>{(routes.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
      <Field label="Nombre completo"><input required value={f.name} onChange={set('name')} /></Field>
      <div className="row">
        <Field label="Tipo"><select value={f.documentType} onChange={set('documentType')}>{(types.data ?? []).map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}</select></Field>
        <Field label="Documento"><input required value={f.document} onChange={set('document')} /></Field>
      </div>
      <Field label="Teléfono"><input required value={f.phonePrimary} onChange={set('phonePrimary')} /></Field>
      <Field label="Dirección de residencia"><input required value={f.addressPrimary} onChange={set('addressPrimary')} /></Field>
      <Field label="Dirección de cobro / negocio"><input required value={f.addressSecondary} onChange={set('addressSecondary')} /></Field>
      <Field label="Negocio (opcional)"><input value={f.business} onChange={set('business')} /></Field>
      <button className="primary" disabled={action.busy}>Registrar cliente</button>
      <ActionMessage action={action} />
    </form>
  );
}
