// Rutas: alta, datos, oficina, personas asignadas, Cobrador responsable, responsable de
// capital (v16) y estado. La ruta NO tiene caja propia: el capital lo entrega a los
// trabajadores el Administrador responsable desde su bolsa (Capital centralizado).
// Cambiar el responsable de capital es un comando del servidor con sus propias
// restricciones; esta pantalla nunca mueve dinero ni crea capital.

import { useMemo, useState, type FormEvent } from 'react';
import { useAction, useApp, useCtx, useResource } from '../lib/app.tsx';
import { useMembers, useOffices, useRoutes, nameOf, type MemberView, type OfficeView, type RouteView } from '../lib/lookups.ts';
import { manages, memberName, minorToText, parseLimit, parseRate, routeLabel, useIntent, useSynced } from '../lib/admin.ts';
import { date, ROLE } from '../lib/format.ts';
import { ActionMessage, Badge, CheckList, Confirm, Field, Loaded, Money, Refresh, Section } from '../ui.tsx';

interface ControllerEvent { routeId: string; kind: string; toMembershipId: string | null }
type RouteResult = RouteView & { controllerEvents?: ControllerEvent[] };

const EVENT: Record<string, string> = {
  FIRST_ADMIN: 'quedó como primer responsable de capital', CHANGE: 'es el nuevo responsable de capital', RELEASE: 'la ruta quedó sin responsable de capital',
};

function eventsNote(events: ControllerEvent[] | undefined, members: MemberView[] | null): string {
  return (events ?? []).map((e) => ` ${e.toMembershipId ? `${memberName(members, e.toMembershipId)} ${EVENT[e.kind] ?? e.kind}` : EVENT['RELEASE']}.`).join('');
}

export function RoutesAdmin() {
  const { can } = useCtx();
  const routes = useRoutes();
  const members = useMembers(can('user.viewAll'));
  const offices = useOffices();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [officeId, setOfficeId] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const filtered = useMemo(() => (routes.data ?? []).filter((r) => (!status || r.status === status)
    && (!officeId || (officeId === '-' ? !r.officeId : r.officeId === officeId))
    && (!q || `${r.name} ${r.code} ${r.city ?? ''}`.toLowerCase().includes(q.toLowerCase()))), [routes.data, q, status, officeId]);
  const reloadAll = async () => { await Promise.all([routes.reload(), members.reload(), offices.reload()]); };

  return (
    <Section title="Rutas" actions={<>
      {can('route.create') ? <button className="primary" onClick={() => { setCreating(!creating); setDone(null); }}>{creating ? 'Cerrar alta' : 'Nueva ruta'}</button> : null}
      <Refresh r={routes} />
    </>}>
      {creating ? <NewRoute members={members.data ?? []} offices={offices.data ?? []} onDone={(id, msg) => { setCreating(false); setDone(msg); setSelected(id); void reloadAll(); }} onRefresh={() => void reloadAll()} /> : null}
      {done ? <p className="msg ok" role="status">{done}</p> : null}
      <div className="filters">
        <input placeholder="Buscar por nombre, código o ciudad" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={officeId} onChange={(e) => setOfficeId(e.target.value)} aria-label="Oficina">
          <option value="">Todas las oficinas</option>
          <option value="-">Sin oficina</option>
          {(offices.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado">
          <option value="">Activas e inactivas</option>
          <option value="activa">Activas</option>
          <option value="inactiva">Inactivas</option>
        </select>
      </div>
      <Loaded r={routes} empty={() => filtered.length === 0}>
        {() => (
          <ul className="list">
            {filtered.map((r) => (
              <li key={r.id} className={selected === r.id ? 'active' : ''}>
                <button className="row-button" onClick={() => setSelected(selected === r.id ? null : r.id)}>
                  <strong>{routeLabel(r)}</strong>
                  <span className="muted">
                    {r.officeId ? nameOf(offices.data, r.officeId) : 'Sin oficina'} · Cobrador: {r.collectorId ? memberName(members.data, r.collectorId) : 'sin asignar'}
                    {' · '}Responsable de capital: {r.capitalControllerId ? memberName(members.data, r.capitalControllerId) : 'ninguno'}
                  </span>
                  {r.status !== 'activa' ? <Badge tone="warn">Inactiva</Badge> : null}
                  {!r.capitalControllerId ? <Badge tone="warn">Sin responsable de capital</Badge> : null}
                </button>
                {selected === r.id
                  ? <RouteDetail r={r} members={members.data ?? []} offices={offices.data ?? []} onChanged={reloadAll} onDeleted={() => { setSelected(null); void reloadAll(); }} />
                  : null}
              </li>
            ))}
          </ul>
        )}
      </Loaded>
    </Section>
  );
}

function RouteDetail({ r, members, offices, onChanged, onDeleted }: {
  r: RouteView; members: MemberView[]; offices: OfficeView[]; onChanged: () => Promise<void>; onDeleted: () => void;
}) {
  const { client } = useApp();
  const ctx = useCtx();
  // La lista no trae las personas asignadas: se leen de la ruta (y se releen tras cada cambio).
  const detail = useResource(async () => client.get<RouteView>(`/v1/routes/${r.id}`), [r.id, r.updatedAt], 30_000);
  const status = useAction();
  const del = useAction();
  const changed = async () => { await Promise.all([onChanged(), detail.reload()]); };
  const d = detail.data ?? r;
  const assigned = (d.memberIds ?? []).map((id) => members.find((m) => m.membershipId === id)).filter((m): m is MemberView => !!m);

  return (
    <div className="detail">
      <dl className="grid2">
        <dt>Código</dt><dd>{d.code}</dd>
        <dt>Estado</dt><dd>{d.status === 'activa' ? <Badge tone="ok">Activa</Badge> : <Badge tone="warn">Inactiva: no admite operaciones nuevas</Badge>}</dd>
        <dt>Oficina</dt><dd>{d.officeId ? nameOf(offices, d.officeId) : 'Sin oficina'}</dd>
        <dt>Ciudad</dt><dd>{d.city ?? '—'}</dd>
        <dt>Teléfono</dt><dd>{d.phone ?? '—'}</dd>
        <dt>Tasa de interés</dt><dd>{d.interestRate} %{d.freeRate ? ' · tasa libre' : ''}</dd>
        <dt>Préstamo máximo</dt><dd><Money minor={d.maxLoanMinor} /></dd>
        <dt>Cobrador responsable</dt><dd>{d.collectorId ? memberName(members, d.collectorId) : 'Sin Cobrador asignado'}</dd>
        <dt>Responsable de capital</dt>
        <dd>{d.capitalControllerId ? <>{memberName(members, d.capitalControllerId)} <span className="muted small">desde {date(d.capitalControllerSince)}</span></> : 'Ninguno: las operaciones de caja de la ruta quedan bloqueadas'}</dd>
        <dt>Personas asignadas</dt>
        <dd>{detail.data ? (assigned.map((m) => `${m.displayName} (${ROLE[m.role] ?? m.role}${m.status !== 'activo' ? ', inactiva' : ''})`).join(', ') || 'Ninguna') : 'Cargando…'}</dd>
      </dl>

      {ctx.can('route.edit') ? <EditRoute r={d} offices={offices} onDone={changed} /> : null}
      {ctx.can('route.assign') && detail.data ? <RouteAssignments r={d} members={members} onDone={changed} /> : null}
      {ctx.can('capital.assignController') && detail.data ? <CapitalController r={d} members={members} onDone={changed} /> : null}

      <div className="actions-row">
        {ctx.can('route.block') ? (d.status === 'activa'
          ? <Confirm label="Desactivar ruta" disabled={status.busy} confirmLabel="Sí, desactivar"
              question={<>¿Desactivar <strong>{d.name}</strong>? No admitirá operaciones nuevas (créditos, recaudos, gastos); su historia y sus saldos se conservan.</>}
              onConfirm={() => status.run(() => client.send('POST', `/v1/routes/${d.id}/status`, { status: 'inactiva' }), () => 'Ruta desactivada.').then((v) => v && changed())} />
          : <Confirm label="Reactivar ruta" danger={false} disabled={status.busy} confirmLabel="Sí, reactivar"
              question={<>¿Reactivar <strong>{d.name}</strong>? Volverá a admitir operaciones nuevas.</>}
              onConfirm={() => status.run(() => client.send('POST', `/v1/routes/${d.id}/status`, { status: 'activa' }), () => 'Ruta reactivada.').then((v) => v && changed())} />)
          : null}
        {ctx.can('route.delete') ? (
          <Confirm label="Eliminar ruta" disabled={del.busy} confirmLabel="Sí, eliminar"
            question={<>¿Eliminar definitivamente <strong>{d.name}</strong>? Solo es posible si nunca tuvo clientes, movimientos ni asignaciones; en otro caso el servidor lo rechazará y deberá desactivarla.</>}
            onConfirm={() => del.run(() => client.send('POST', `/v1/routes/${d.id}/delete`)).then((v) => { if (v) onDeleted(); })} />
        ) : null}
      </div>
      <ActionMessage action={status} />
      <ActionMessage action={del} />
    </div>
  );
}

function EditRoute({ r, offices, onDone }: { r: RouteView; offices: OfficeView[]; onDone: () => Promise<void> }) {
  const { client } = useApp();
  const { company } = useCtx();
  const action = useAction();
  const initial = { name: r.name, city: r.city ?? '', phone: r.phone ?? '', email: r.email ?? '', rate: String(r.interestRate), freeRate: !!r.freeRate,
    maxLoan: minorToText(r.maxLoanMinor, company.minorUnits), officeId: r.officeId ?? '' };
  const [f, setF] = useSynced(initial);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const interestRate = parseRate(f.rate);
    const maxLoanMinor = parseLimit(f.maxLoan, company.minorUnits);
    if (interestRate === null) return action.setMessage({ kind: 'error', text: 'Tasa de interés no válida (por ejemplo 20 o 20,5).' });
    if (maxLoanMinor === null) return action.setMessage({ kind: 'error', text: 'Préstamo máximo no válido.' });
    const body = { name: f.name.trim(), city: f.city.trim() || null, phone: f.phone.trim() || null, email: f.email.trim() || null, interestRate, freeRate: f.freeRate,
      maxLoanMinor, officeId: f.officeId || null };
    const v = await action.run(() => client.send('PATCH', `/v1/routes/${r.id}`, body), () => 'Datos de la ruta guardados.');
    if (v) await onDone();
  }
  return (
    <form className="form admin-block" onSubmit={(e) => void submit(e)}>
      <h3>Datos de la ruta</h3>
      <div className="row">
        <Field label="Nombre"><input required maxLength={120} value={f.name} onChange={set('name')} /></Field>
        <Field label="Oficina">
          <select value={f.officeId} onChange={set('officeId')}>
            <option value="">Sin oficina</option>
            {offices.map((o) => <option key={o.id} value={o.id}>{o.name}{o.status !== 'activa' ? ' (inactiva)' : ''}</option>)}
          </select>
        </Field>
      </div>
      <div className="row">
        <Field label="Ciudad"><input maxLength={120} value={f.city} onChange={set('city')} /></Field>
        <Field label="Teléfono"><input maxLength={40} value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Correo"><input type="email" maxLength={160} value={f.email} onChange={set('email')} /></Field>
      </div>
      <div className="row">
        <Field label="Tasa de interés (%)"><input inputMode="decimal" required value={f.rate} onChange={set('rate')} /></Field>
        <Field label={`Préstamo máximo (${company.currencyCode})`} hint="0 = sin límite configurado"><input inputMode="decimal" value={f.maxLoan} onChange={set('maxLoan')} /></Field>
      </div>
      <label className="check"><input type="checkbox" checked={f.freeRate} onChange={(e) => setF({ ...f, freeRate: e.target.checked })} /> Tasa libre</label>
      <div><button className="primary" disabled={action.busy || !dirty}>Guardar datos</button></div>
      <ActionMessage action={action} />
    </form>
  );
}

/** Personas que el contexto puede asignar a una ruta (`isAssignable` de CLEAN: nunca Super Admin). */
function assignableOf(role: string, members: MemberView[]): MemberView[] {
  return members.filter((m) => m.role !== 'superadmin' && manages(role, m.role));
}

function RouteAssignments({ r, members, onDone }: { r: RouteView; members: MemberView[]; onDone: () => Promise<void> }) {
  const { client } = useApp();
  const { role } = useCtx();
  const action = useAction();
  const assigned = r.memberIds ?? [];
  const pool = assignableOf(role, members).filter((m) => m.status === 'activo' || assigned.includes(m.membershipId));
  const initial = pool.filter((m) => assigned.includes(m.membershipId)).map((m) => m.membershipId);
  const [sel, setSel] = useSynced<string[]>(initial);
  const [collectorId, setCollectorId] = useSynced(r.collectorId ?? '');
  const collectors = pool.filter((m) => m.role === 'cobrador' && m.status === 'activo');
  const dirty = collectorId !== (r.collectorId ?? '') || sel.length !== initial.length || sel.some((id) => !initial.includes(id));
  function pickCollector(id: string) {
    setCollectorId(id);
    if (id && !sel.includes(id)) setSel([...sel, id]);
  }
  async function save() {
    const v = await action.run(() => client.send<RouteResult>('PATCH', `/v1/routes/${r.id}`, { memberIds: sel, collectorId: collectorId && sel.includes(collectorId) ? collectorId : null }),
      (x) => `Asignaciones guardadas.${eventsNote(x.controllerEvents, members)}`);
    if (v) await onDone();
  }
  return (
    <div className="admin-block">
      <h3>Personas asignadas y Cobrador responsable</h3>
      <p className="muted small">Asignar da acceso a la ruta con el rol de cada membresía. Un Administrador asignado puede llegar a ser responsable de capital; si retira al responsable actual y quedan otros Administradores, primero debe elegir el nuevo responsable.</p>
      <CheckList items={pool.map((m) => ({ id: m.membershipId, label: m.displayName, hint: `${ROLE[m.role] ?? m.role}${m.status !== 'activo' ? ', inactiva' : ''}`,
        disabled: m.status !== 'activo' && !sel.includes(m.membershipId) }))} selected={sel} onChange={setSel} empty="No hay personas que usted pueda asignar." />
      <Field label="Cobrador responsable">
        <select value={collectorId} onChange={(e) => pickCollector(e.target.value)}>
          <option value="">Sin Cobrador asignado</option>
          {collectors.map((m) => <option key={m.membershipId} value={m.membershipId}>{m.displayName}</option>)}
        </select>
      </Field>
      <div className="actions-row"><button className="primary" disabled={action.busy || !dirty} onClick={() => void save()}>Guardar asignaciones</button></div>
      <ActionMessage action={action} />
    </div>
  );
}

function CapitalController({ r, members, onDone }: { r: RouteView; members: MemberView[]; onDone: () => Promise<void> }) {
  const { client } = useApp();
  const action = useAction();
  const candidates = members.filter((m) => m.role === 'admin' && m.status === 'activo' && (r.memberIds ?? []).includes(m.membershipId) && m.membershipId !== r.capitalControllerId);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const valid = !!to && reason.trim().length >= 10;
  async function change() {
    const v = await action.run(() => client.send<{ event: ControllerEvent }>('PUT', `/v1/routes/${r.id}/capital-controller`, { membershipId: to, reason: reason.trim() }),
      () => `Responsable de capital cambiado: ${memberName(members, to)}.`);
    if (v) { setTo(''); setReason(''); await onDone(); }
  }
  return (
    <div className="admin-block">
      <h3>Responsable de capital</h3>
      <p className="muted small">Solo puede serlo un Administrador activo asignado a la ruta. El cambio lo valida el servidor con las reglas vigentes de capital y queda auditado; desde aquí no se entrega, retira ni traspasa efectivo.</p>
      {candidates.length ? (
        <>
          <div className="row">
            <Field label="Nuevo responsable">
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">Elegir Administrador…</option>
                {candidates.map((m) => <option key={m.membershipId} value={m.membershipId}>{m.displayName}</option>)}
              </select>
            </Field>
            <Field label="Motivo" hint="Mínimo 10 caracteres; queda en la auditoría.">
              <input maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
          <div className="actions-row">
            <Confirm label="Cambiar responsable" disabled={action.busy || !valid} confirmLabel="Sí, cambiar"
              question={<>¿Cambiar el responsable de capital de <strong>{r.name}</strong> de {memberName(members, r.capitalControllerId)} a <strong>{memberName(members, to)}</strong>?</>}
              onConfirm={change} />
          </div>
        </>
      ) : <p className="muted small">No hay otro Administrador activo asignado a esta ruta. Asigne uno en «Personas asignadas» para poder elegirlo.</p>}
      <ActionMessage action={action} />
    </div>
  );
}

function NewRoute({ members, offices, onDone, onRefresh }: { members: MemberView[]; offices: OfficeView[]; onDone: (id: string, message: string) => void; onRefresh: () => void }) {
  const { client } = useApp();
  const { role, company, membershipId } = useCtx();
  const action = useAction();
  const [f, setF] = useState({ name: '', code: '', city: '', phone: '', rate: '20', freeRate: false, maxLoan: '0', officeId: '', collectorId: '' });
  const [adminIds, setAdminIds] = useState<string[]>([]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const admins = members.filter((m) => m.role === 'admin' && m.status === 'activo' && (manages(role, 'admin') || m.membershipId === membershipId));
  const collectors = members.filter((m) => m.role === 'cobrador' && m.status === 'activo' && manages(role, 'cobrador'));
  const interestRate = parseRate(f.rate);
  const maxLoanMinor = parseLimit(f.maxLoan, company.minorUnits);
  const body = {
    name: f.name.trim(), ...(f.code.trim() ? { code: f.code.trim() } : {}), ...(f.city.trim() ? { city: f.city.trim() } : {}), ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
    interestRate, freeRate: f.freeRate, maxLoanMinor, officeId: f.officeId || null, adminIds: role === 'superadmin' ? adminIds : [], collectorId: f.collectorId || null,
  };
  const intent = useIntent(body);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (interestRate === null) return action.setMessage({ kind: 'error', text: 'Tasa de interés no válida (por ejemplo 20 o 20,5).' });
    if (maxLoanMinor === null) return action.setMessage({ kind: 'error', text: 'Préstamo máximo no válido.' });
    const created = await action.run(() => client.command<RouteResult>('POST', '/v1/routes', body, intent.operationId));
    if (created) { intent.confirmed(); onDone(created.id, `Ruta creada: ${routeLabel(created)}.${eventsNote(created.controllerEvents, members)}`); }
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <h3>Nueva ruta</h3>
      <p className="muted small">La ruta nace sin capital: no tiene caja propia. El Administrador responsable entrega capital a los trabajadores desde su bolsa (pantalla Capital).</p>
      <div className="row">
        <Field label="Nombre"><input required maxLength={120} value={f.name} onChange={set('name')} /></Field>
        <Field label="Código (opcional)" hint="Si se deja vacío, el servidor asigna RT-001, RT-002…"><input maxLength={40} value={f.code} onChange={set('code')} /></Field>
      </div>
      <div className="row">
        <Field label="Ciudad (opcional)"><input maxLength={120} value={f.city} onChange={set('city')} /></Field>
        <Field label="Teléfono (opcional)"><input maxLength={40} value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Oficina">
          <select value={f.officeId} onChange={set('officeId')}>
            <option value="">Sin oficina</option>
            {offices.filter((o) => o.status === 'activa').map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="row">
        <Field label="Tasa de interés (%)"><input inputMode="decimal" required value={f.rate} onChange={set('rate')} /></Field>
        <Field label={`Préstamo máximo (${company.currencyCode})`} hint="0 = sin límite configurado"><input inputMode="decimal" value={f.maxLoan} onChange={set('maxLoan')} /></Field>
      </div>
      <label className="check"><input type="checkbox" checked={f.freeRate} onChange={(e) => setF({ ...f, freeRate: e.target.checked })} /> Tasa libre</label>
      {role === 'superadmin' ? (
        <div className="field">
          <span>Administradores de la ruta</span>
          <CheckList items={admins.map((m) => ({ id: m.membershipId, label: m.displayName }))} selected={adminIds} onChange={setAdminIds} empty="No hay Administradores activos." />
          <small className="muted">El primero que quede asignado pasa a ser el responsable de capital.</small>
        </div>
      ) : <p className="muted small">Usted queda asignado a la ruta automáticamente como Administrador.</p>}
      <Field label="Cobrador responsable (opcional)">
        <select value={f.collectorId} onChange={set('collectorId')}>
          <option value="">Sin Cobrador asignado</option>
          {collectors.map((m) => <option key={m.membershipId} value={m.membershipId}>{m.displayName}</option>)}
        </select>
      </Field>
      <div><button className="primary" disabled={action.busy}>Crear ruta</button></div>
      <ActionMessage action={action} onResolved={onRefresh} />
    </form>
  );
}
