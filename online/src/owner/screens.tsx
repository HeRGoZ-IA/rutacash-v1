// Pantallas del panel Owner. Solo datos estructurales y comerciales de cada empresa
// (ficha de control, estado, rutas, facturación SaaS y cobros de ADEX). Nada de
// clientes, préstamos, capital, recaudos ni gastos: la API Owner no los tiene.

import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  amount, Badge, BILLING, Confirm, date, EVENT, expected, Field, Loaded, Message, PAY, Refresh, Section, STATUS,
  useAction, useOwner, useResource, type Company, type Payment,
} from './kit.tsx';

const loadCompanies = (get: <T>(p: string) => Promise<T>) => get<{ companies: Company[] }>('/control/v1/companies').then((b) => b.companies);
const loadPayments = (get: <T>(p: string) => Promise<T>) => get<{ payments: Payment[] }>('/control/v1/payments').then((b) => b.payments);

// ---------- Panel general ----------
export function Dashboard() {
  const { client, profile } = useOwner();
  const companies = useResource(() => loadCompanies((p) => client.get(p)), []);
  const payments = useResource(() => loadPayments((p) => client.get(p)), []);
  return (
    <>
      <Section title={`Panel general${profile ? ` · ${profile.displayName}` : ''}`} actions={<Refresh r={companies} />}>
        <Loaded r={companies}>{(list) => {
          const by = (s: string) => list.filter((c) => c.status === s).length;
          const tiles: [string, string | number][] = [
            ['Empresas', list.length], ['Activas', by('active')], ['En prueba', by('trial')], ['Suspendidas', by('suspended')],
            ['Rutas', list.reduce((n, c) => n + c.routeCount, 0)], ['Rutas facturables', list.reduce((n, c) => n + c.billableRouteCount, 0)],
            ['Cobro esperado por periodo', amount(list.filter((c) => c.status !== 'suspended').reduce((n, c) => n + expected(c), 0))],
            ['Cobros pendientes o vencidos', (payments.data ?? []).filter((p) => p.status !== 'paid').length],
          ];
          return <div className="tiles">{tiles.map(([k, v]) => <div key={k} className="tile"><span className="muted small">{k}</span><strong>{v}</strong></div>)}</div>;
        }}</Loaded>
        <p className="muted small">Cifras comerciales de ADEX Soluciones. Ninguna sale de la cartera, la caja ni los movimientos de las empresas.</p>
      </Section>
      <Section title="Próximos cobros">
        <Loaded r={companies}>{(list) => {
          const next = list.filter((c) => c.nextBillingDate && c.status !== 'suspended').sort((a, b) => a.nextBillingDate!.localeCompare(b.nextBillingDate!)).slice(0, 8);
          return next.length ? (
            <table className="table compact"><thead><tr><th>Empresa</th><th>Fecha</th><th className="right">Esperado</th><th>Estado de pago</th></tr></thead>
              <tbody>{next.map((c) => <tr key={c.companyId}><td><Link to={`/empresas/${c.companyId}`}>{c.name}</Link></td><td>{date(c.nextBillingDate)}</td>
                <td className="right num">{amount(expected(c))}</td><td><Badge tone={PAY[c.paymentStatus]?.tone}>{PAY[c.paymentStatus]?.label ?? c.paymentStatus}</Badge></td></tr>)}</tbody></table>
          ) : <p className="muted">Sin fechas de cobro programadas.</p>;
        }}</Loaded>
      </Section>
    </>
  );
}

// ---------- Empresas ----------
const COUNTRIES = [
  { code: 'CO', label: 'Colombia', currency: 'COP', tz: 'America/Bogota' },
  { code: 'BR', label: 'Brasil', currency: 'BRL', tz: 'America/Sao_Paulo' },
  { code: 'MX', label: 'México', currency: 'MXN', tz: 'America/Mexico_City' },
  { code: 'PE', label: 'Perú', currency: 'PEN', tz: 'America/Lima' },
  { code: 'EC', label: 'Ecuador', currency: 'USD', tz: 'America/Guayaquil' },
];

export function Companies() {
  const { client } = useOwner();
  const companies = useResource(() => loadCompanies((p) => client.get(p)), []);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Section title="Empresas" actions={<><button className="primary" onClick={() => setCreating(!creating)}>{creating ? 'Cerrar' : 'Nueva empresa'}</button><Refresh r={companies} /></>}>
        {creating ? <NewCompany onCreated={() => { setCreating(false); void companies.reload(); }} /> : null}
        <div className="filters row">
          <input placeholder="Buscar por nombre, NIT o contacto" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos los estados</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        <Loaded r={companies}>{(list) => {
          const t = q.trim().toLowerCase();
          const rows = list.filter((c) => (!status || c.status === status) && (!t || [c.name, c.taxId, c.contactName, c.contactEmail].some((x) => x?.toLowerCase().includes(t))));
          return rows.length ? (
            <table className="table">
              <thead><tr><th>Empresa</th><th>Estado</th><th className="right">Rutas (facturables)</th><th>Facturación</th><th className="right">Esperado</th><th>Pago</th><th>Último acceso</th></tr></thead>
              <tbody>{rows.map((c) => (
                <tr key={c.companyId}>
                  <td><Link to={`/empresas/${c.companyId}`}>{c.name}</Link>{c.taxId ? <div className="muted small">{c.taxId}</div> : null}</td>
                  <td><Badge tone={STATUS[c.status]?.tone}>{STATUS[c.status]?.label ?? c.status}</Badge></td>
                  <td className="right num">{c.routeCount} ({c.billableRouteCount})</td>
                  <td>{BILLING[c.billingMode] ?? c.billingMode} · {amount(c.billingRate)}</td>
                  <td className="right num">{amount(expected(c))}</td>
                  <td><Badge tone={PAY[c.paymentStatus]?.tone}>{PAY[c.paymentStatus]?.label ?? c.paymentStatus}</Badge></td>
                  <td className="muted small">{date(c.lastLoginAt)}</td>
                </tr>))}</tbody>
            </table>
          ) : <p className="muted">Sin empresas que coincidan.</p>;
        }}</Loaded>
      </Section>
    </>
  );
}

function NewCompany({ onCreated }: { onCreated: () => void }) {
  const { client } = useOwner();
  const nav = useNavigate();
  const action = useAction();
  const [f, setF] = useState({ name: '', email: '', taxId: '', contactName: '', country: 'CO', billingMode: 'per_route', billingRate: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function submit(e: FormEvent) {
    e.preventDefault();
    const c = COUNTRIES.find((x) => x.code === f.country)!;
    const created = await action.run(() => client.send<Company>('POST', '/control/v1/companies', {
      name: f.name, email: f.email, taxId: f.taxId || undefined, contactName: f.contactName || undefined, countryCode: c.code, countryLabel: c.label,
      currencyCode: c.currency, timezone: c.tz, billingMode: f.billingMode, billingRate: Number(f.billingRate.replace(',', '.') || 0) }), (v) => `Empresa «${v.name}» creada en prueba.`);
    if (created) { onCreated(); nav(`/empresas/${created.companyId}`); }
  }
  return (
    <form className="form admin-block" onSubmit={(e) => void submit(e)}>
      <div className="row">
        <Field label="Nombre comercial"><input required value={f.name} onChange={set('name')} /></Field>
        <Field label="Correo de la empresa"><input type="email" required value={f.email} onChange={set('email')} /></Field>
        <Field label="NIT / documento (opcional)"><input value={f.taxId} onChange={set('taxId')} /></Field>
        <Field label="Contacto (opcional)"><input value={f.contactName} onChange={set('contactName')} /></Field>
      </div>
      <div className="row">
        <Field label="País y moneda" hint="Fijos tras el alta: la moneda no se cambia con datos.">
          <select value={f.country} onChange={set('country')}>{COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.label} · {c.currency}</option>)}</select>
        </Field>
        <Field label="Facturación"><select value={f.billingMode} onChange={set('billingMode')}>{Object.entries(BILLING).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label={f.billingMode === 'fixed' ? 'Tarifa fija por periodo' : 'Tarifa por ruta facturable'}><input inputMode="decimal" value={f.billingRate} onChange={set('billingRate')} placeholder="0,00" /></Field>
      </div>
      <p className="muted small">La empresa nace «En prueba» y sin usuarios. Después, desde su ficha, invite a su primer SuperAdmin. Usted no recibe ninguna membresía.</p>
      <button className="primary" disabled={action.busy}>Crear empresa</button>
      <Message action={action} />
    </form>
  );
}

// ---------- Detalle de empresa ----------
interface Detail { company: Company; events: { type: string; at: string; detail: string | null }[]; payments: Payment[] }

export function CompanyDetail() {
  const { id = '' } = useParams();
  const { client } = useOwner();
  const r = useResource(() => client.get<Detail>(`/control/v1/companies/${encodeURIComponent(id)}`), [id]);
  return (
    <>
      <p><Link to="/empresas">← Empresas</Link></p>
      <Loaded r={r}>{(d) => (
        <>
          <CompanyCard d={d} reload={r.reload} />
          <BillingCard c={d.company} reload={r.reload} />
          <PaymentsCard d={d} reload={r.reload} />
          <SuperAdminCard c={d.company} />
          <Section title="Historial (estructural y comercial)">
            {d.events.length ? (
              <table className="table compact"><thead><tr><th>Fecha</th><th>Evento</th><th>Detalle</th></tr></thead>
                <tbody>{d.events.map((e, i) => <tr key={i}><td>{date(e.at)}</td><td>{EVENT[e.type] ?? e.type}</td><td className="muted small">{e.detail ?? ''}</td></tr>)}</tbody></table>
            ) : <p className="muted">Sin eventos.</p>}
          </Section>
        </>
      )}</Loaded>
    </>
  );
}

function CompanyCard({ d, reload }: { d: Detail; reload: () => Promise<void> }) {
  const { client } = useOwner();
  const action = useAction();
  const c = d.company;
  const status = (s: string, ok: string) => void action.run(() => client.send('POST', `/control/v1/companies/${c.companyId}/status`, { status: s }), () => ok).then(() => reload());
  return (
    <Section title={c.name} actions={<Badge tone={STATUS[c.status]?.tone}>{STATUS[c.status]?.label ?? c.status}</Badge>}>
      <dl className="grid2">
        <dt>NIT / documento</dt><dd>{c.taxId ?? '—'}</dd>
        <dt>Contacto</dt><dd>{c.contactName ?? '—'}{c.contactEmail ? ` · ${c.contactEmail}` : ''}</dd>
        <dt>Creada</dt><dd>{date(c.createdAt)}</dd>
        <dt>Primer / último acceso</dt><dd>{date(c.firstLoginAt)} · {date(c.lastLoginAt)}</dd>
        <dt>Rutas</dt><dd>{c.routeCount} en total · {c.billableRouteCount} facturables (activas)</dd>
        <dt>ID interno</dt><dd><code>{c.companyId}</code></dd>
      </dl>
      <div className="row actions-row">
        {c.status !== 'active' ? <Confirm label="Activar" danger={false} question={`¿Activar «${c.name}»? Sus usuarios podrán operar.`} onConfirm={() => status('active', 'Empresa activada.')} disabled={action.busy} /> : null}
        {c.status !== 'suspended' ? <Confirm label="Suspender" question={`¿Suspender «${c.name}»? Se cierran sus sesiones y nadie de la empresa podrá operar hasta reactivarla. No se borra ningún dato.`} onConfirm={() => status('suspended', 'Empresa suspendida.')} disabled={action.busy} /> : null}
        {c.status === 'suspended' ? <Confirm label="Pasar a prueba" danger={false} question="¿Reactivar la empresa en modo prueba?" onConfirm={() => status('trial', 'Empresa en prueba.')} disabled={action.busy} /> : null}
        <button disabled={action.busy} onClick={() => void action.run(() => client.send('POST', `/control/v1/companies/${c.companyId}/route-counts`), () => 'Rutas recontadas por el servidor.').then(() => reload())}>Recontar rutas</button>
      </div>
      <Message action={action} />
    </Section>
  );
}

function BillingCard({ c, reload }: { c: Company; reload: () => Promise<void> }) {
  const { client } = useOwner();
  const action = useAction();
  const [f, setF] = useState({ billingMode: c.billingMode, billingRate: String(c.billingRate), nextBillingDate: c.nextBillingDate ?? '', paymentStatus: c.paymentStatus });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Section title="Suscripción y facturación SaaS">
      <p className="muted small">Lo que ADEX Soluciones cobra a esta empresa. Cobro esperado por periodo con las condiciones actuales: <strong>{amount(expected(c))}</strong>.</p>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void action.run(() => client.send('PUT', `/control/v1/companies/${c.companyId}/billing`, {
        billingMode: f.billingMode, billingRate: Number(f.billingRate.replace(',', '.')), nextBillingDate: f.nextBillingDate || null, paymentStatus: f.paymentStatus }), () => 'Facturación guardada.').then(() => reload()); }}>
        <div className="row">
          <Field label="Modo"><select value={f.billingMode} onChange={set('billingMode')}>{Object.entries(BILLING).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Tarifa"><input inputMode="decimal" value={f.billingRate} onChange={set('billingRate')} /></Field>
          <Field label="Próximo cobro"><input type="date" value={f.nextBillingDate} onChange={set('nextBillingDate')} /></Field>
          <Field label="Estado de pago"><select value={f.paymentStatus} onChange={set('paymentStatus')}>{Object.entries(PAY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        </div>
        <button disabled={action.busy}>Guardar facturación</button>
        <Message action={action} />
      </form>
    </Section>
  );
}

function PaymentsCard({ d, reload }: { d: Detail; reload: () => Promise<void> }) {
  const { client } = useOwner();
  const action = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ period: today.slice(0, 7), amount: String(expected(d.company) || ''), expectedDate: today, note: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Section title="Cobros SaaS de esta empresa">
      <PaymentsTable payments={d.payments} onChange={reload} />
      <form className="form admin-block" onSubmit={(e) => { e.preventDefault(); void action.run(() => client.send('POST', `/control/v1/companies/${d.company.companyId}/payments`, {
        period: f.period, amount: Number(f.amount.replace(',', '.')), expectedDate: f.expectedDate, note: f.note || undefined }), () => 'Cobro registrado como pendiente.').then(() => reload()); }}>
        <div className="row">
          <Field label="Periodo"><input type="month" required value={f.period} onChange={set('period')} /></Field>
          <Field label="Importe"><input inputMode="decimal" required value={f.amount} onChange={set('amount')} /></Field>
          <Field label="Fecha esperada"><input type="date" required value={f.expectedDate} onChange={set('expectedDate')} /></Field>
          <Field label="Nota (opcional)"><input value={f.note} maxLength={200} onChange={set('note')} /></Field>
        </div>
        <button disabled={action.busy}>Registrar cobro</button>
        <Message action={action} />
      </form>
    </Section>
  );
}

function PaymentsTable({ payments, onChange, showCompany = false }: { payments: Payment[]; onChange: () => unknown; showCompany?: boolean }) {
  const { client } = useOwner();
  const action = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const mark = (p: Payment, status: string) => void action.run(() => client.send('POST', `/control/v1/payments/${p.id}/status`,
    { status, paidDate: status === 'paid' ? today : null }), () => `Cobro ${p.period} marcado como ${PAY[status]!.label.toLowerCase()}.`).then(() => onChange());
  if (!payments.length) return <p className="muted">Sin cobros registrados.</p>;
  return (
    <>
      <table className="table compact">
        <thead><tr>{showCompany ? <th>Empresa</th> : null}<th>Periodo</th><th className="right">Importe</th><th>Esperado</th><th>Pagado</th><th>Estado</th><th /></tr></thead>
        <tbody>{payments.map((p) => (
          <tr key={p.id}>
            {showCompany ? <td><Link to={`/empresas/${p.companyId}`}>{p.companyName}</Link></td> : null}
            <td>{p.period}{p.note ? <div className="muted small">{p.note}</div> : null}</td>
            <td className="right num">{amount(p.amount)}</td><td>{date(p.expectedDate)}</td><td>{date(p.paidDate)}</td>
            <td><Badge tone={PAY[p.status]?.tone}>{PAY[p.status]?.label ?? p.status}</Badge></td>
            <td className="right">
              {p.status !== 'paid' ? <button className="link" disabled={action.busy} onClick={() => mark(p, 'paid')}>Pagado hoy</button> : null}
              {p.status === 'pending' ? <button className="link" disabled={action.busy} onClick={() => mark(p, 'overdue')}>Vencido</button> : null}
              {p.status !== 'pending' ? <button className="link" disabled={action.busy} onClick={() => mark(p, 'pending')}>Pendiente</button> : null}
            </td>
          </tr>))}</tbody>
      </table>
      <Message action={action} />
    </>
  );
}

function SuperAdminCard({ c }: { c: Company }) {
  const { client } = useOwner();
  const action = useAction();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  return (
    <Section title="Primer SuperAdmin de la empresa">
      <p className="muted small">Crea la cuenta del responsable de la empresa SIN contraseña: nadie la conoce. La persona la fija con el enlace del proveedor
        («Olvidé mi contraseña / primer acceso» en ADEX Online). Usted no recibe ninguna membresía ni puede entrar en la empresa.</p>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void action.run(() => client.send('POST', `/control/v1/companies/${c.companyId}/superadmins`, { email, displayName: name }),
        () => 'SuperAdmin invitado.').then((v) => { if (v) { setEmail(''); setName(''); } }); }}>
        <div className="row">
          <Field label="Correo del SuperAdmin"><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Nombre visible"><input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        </div>
        <button disabled={action.busy}>Invitar SuperAdmin</button>
        <Message action={action} />
      </form>
    </Section>
  );
}

// ---------- Facturación (todas las empresas) ----------
export function Billing() {
  const { client } = useOwner();
  const payments = useResource(() => loadPayments((p) => client.get(p)), []);
  const [status, setStatus] = useState('open');
  const rows = useMemo(() => (payments.data ?? []).filter((p) => status === 'all' || (status === 'open' ? p.status !== 'paid' : p.status === status)), [payments.data, status]);
  const total = (s: string) => amount((payments.data ?? []).filter((p) => p.status === s).reduce((n, p) => n + p.amount, 0));
  return (
    <Section title="Cobros SaaS" actions={<Refresh r={payments} />}>
      <div className="tiles">
        <div className="tile"><span className="muted small">Pendiente</span><strong>{total('pending')}</strong></div>
        <div className="tile"><span className="muted small">Vencido</span><strong>{total('overdue')}</strong></div>
        <div className="tile"><span className="muted small">Cobrado</span><strong>{total('paid')}</strong></div>
      </div>
      <div className="filters row">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">Pendientes y vencidos</option><option value="pending">Pendientes</option><option value="overdue">Vencidos</option>
          <option value="paid">Pagados</option><option value="all">Todos</option>
        </select>
      </div>
      <Loaded r={payments}>{() => <PaymentsTable payments={rows} onChange={payments.reload} showCompany />}</Loaded>
      <p className="muted small">Para registrar un cobro nuevo, abra la ficha de la empresa.</p>
    </Section>
  );
}

// ---------- Configuración ----------
export function Settings() {
  const { client, profile } = useOwner();
  const nav = useNavigate();
  const action = useAction();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  return (
    <>
      <Section title="Mi cuenta Owner">
        <dl className="grid2">
          <dt>Nombre</dt><dd>{profile?.displayName ?? '—'}</dd>
          <dt>Rol</dt><dd>Owner de ADEX Soluciones (sin membresías en empresas)</dd>
          <dt>Owner desde</dt><dd>{date(profile?.since)}</dd>
        </dl>
        <p className="muted small">Dar de alta o retirar Owners es un procedimiento del administrador de la base de datos (no se hace desde aquí).</p>
      </Section>
      <Section title="Cambiar contraseña">
        <form className="form" onSubmit={(e) => { e.preventDefault(); void action.run(async () => {
          if (a.length < 12) throw Object.assign(new Error('PASSWORD_SHORT'), { code: 'PASSWORD_SHORT' });
          if (a !== b) throw Object.assign(new Error('PASSWORD_MISMATCH'), { code: 'PASSWORD_MISMATCH' });
          await client.changePassword(a);
        }, () => 'Contraseña cambiada en el proveedor de identidad.').finally(() => { setA(''); setB(''); }); }}>
          <div className="row">
            <Field label="Nueva contraseña"><input type="password" autoComplete="new-password" required value={a} onChange={(e) => setA(e.target.value)} /></Field>
            <Field label="Repítala"><input type="password" autoComplete="new-password" required value={b} onChange={(e) => setB(e.target.value)} /></Field>
          </div>
          <button disabled={action.busy}>Cambiar contraseña</button>
          <Message action={action} />
        </form>
      </Section>
      <Section title="Sesiones">
        <div className="row">
          <button onClick={() => void client.logout().then(() => nav('/login'))}>Cerrar sesión</button>
          <button className="danger" onClick={() => void client.logout('global').then(() => nav('/login'))}>Cerrar sesión en todos los dispositivos</button>
        </div>
      </Section>
    </>
  );
}
