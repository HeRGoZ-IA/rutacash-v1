// Usuarios y trabajadores de la empresa: membresías (DS-05), datos de contacto, estado
// y rutas autorizadas. Sin contraseñas: el alta crea la identidad en el proveedor y la
// persona fija su contraseña con «Olvidé mi contraseña / primer acceso». El rol de una
// membresía no se cambia: se crea otra membresía con el nuevo rol y se desactiva esta.

import { useMemo, useState, type FormEvent } from 'react';
import { useAction, useApp, useCtx } from '../lib/app.tsx';
import { useMembers, useOffices, useRoutes, type MemberView, type OfficeView, type RouteView } from '../lib/lookups.ts';
import { manageableRoles, manages, ROLE_ORDER, routeLabel, useIntent, useSynced } from '../lib/admin.ts';
import { ROLE } from '../lib/format.ts';
import { ActionMessage, Badge, CheckList, Confirm, Field, Loaded, Refresh, Section } from '../ui.tsx';

interface ControllerEvent { routeId: string; kind: string }
type MemberResult = MemberView & { controllerEvents?: ControllerEvent[] };

function controllerNote(events: ControllerEvent[] | undefined): string {
  return events?.length ? ` El servidor actualizó el responsable de capital de ${events.length} ruta(s).` : '';
}

export function People() {
  const { can, role } = useCtx();
  const members = useMembers(true);
  const routes = useRoutes();
  const offices = useOffices();
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [status, setStatus] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const filtered = useMemo(() => (members.data ?? [])
    .filter((m) => (!roleFilter || m.role === roleFilter) && (!status || m.status === status)
      && (!q || `${m.displayName} ${m.email ?? ''} ${m.phone ?? ''}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.displayName.localeCompare(b.displayName, 'es')),
  [members.data, q, roleFilter, status]);
  const reloadAll = async () => { await Promise.all([members.reload(), routes.reload(), offices.reload()]); };

  return (
    <Section title="Usuarios y trabajadores" actions={<>
      {can('user.create') && manageableRoles(role).length ? <button className="primary" onClick={() => { setCreating(!creating); setDone(null); }}>{creating ? 'Cerrar alta' : 'Nuevo usuario'}</button> : null}
      <Refresh r={members} />
    </>}>
      {creating ? <NewMember routes={routes.data ?? []} onDone={(id, msg) => { setCreating(false); setDone(msg); setSelected(id); void reloadAll(); }} onRefresh={() => void reloadAll()} /> : null}
      {done ? <p className="msg ok" role="status">{done}</p> : null}
      <div className="filters">
        <input placeholder="Buscar por nombre, correo o teléfono" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Rol">
          <option value="">Todos los roles</option>
          {ROLE_ORDER.map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado">
          <option value="activo">Activos</option>
          <option value="inactivo">Inactivos</option>
          <option value="">Todos</option>
        </select>
      </div>
      <Loaded r={members} empty={() => filtered.length === 0}>
        {(all) => (
          <ul className="list">
            {filtered.map((m) => (
              <li key={m.membershipId} className={selected === m.membershipId ? 'active' : ''}>
                <button className="row-button" onClick={() => setSelected(selected === m.membershipId ? null : m.membershipId)}>
                  <strong>{m.displayName}</strong>
                  <span className="muted">{ROLE[m.role] ?? m.role} · {m.email ?? 'sin correo'} · {m.role === 'superadmin' ? 'todas las rutas' : `${m.routeIds.length} ruta(s)`}</span>
                  {m.status !== 'activo' ? <Badge tone="warn">Inactivo</Badge> : null}
                </button>
                {selected === m.membershipId
                  ? <MemberDetail m={m} all={all} routes={routes.data ?? []} offices={offices.data ?? []} onChanged={reloadAll} onDeleted={() => { setSelected(null); void reloadAll(); }} />
                  : null}
              </li>
            ))}
          </ul>
        )}
      </Loaded>
    </Section>
  );
}

function MemberDetail({ m, all, routes, offices, onChanged, onDeleted }: {
  m: MemberView; all: MemberView[]; routes: RouteView[]; offices: OfficeView[]; onChanged: () => Promise<void>; onDeleted: () => void;
}) {
  const { client, setCtx } = useApp();
  const ctx = useCtx();
  const managed = manages(ctx.role, m.role);
  const self = m.membershipId === ctx.membershipId;
  const visible = new Set(routes.map((r) => r.id));
  const others = all.filter((x) => x.membershipId !== m.membershipId && x.email && x.email === m.email);
  const status = useAction();
  const del = useAction();

  async function changed() {
    await onChanged();
    // Si se tocó la propia membresía, el contexto (rutas) se relee del servidor.
    if (self) { try { setCtx(await client.context()); } catch { /* el cliente ya gestiona la pérdida de contexto */ } }
  }

  return (
    <div className="detail">
      <dl className="grid2">
        <dt>Rol</dt><dd>{ROLE[m.role] ?? m.role}</dd>
        <dt>Estado</dt><dd>{m.status === 'activo' ? <Badge tone="ok">Activo</Badge> : <Badge tone="warn">Inactivo</Badge>}</dd>
        <dt>Correo</dt><dd>{m.email ?? '—'}</dd>
        <dt>Teléfono</dt><dd>{m.phone ?? '—'}</dd>
        <dt>Rutas</dt>
        <dd>{m.role === 'superadmin' ? 'Todas las de la empresa' : m.routeIds.map((id) => {
          const r = routes.find((x) => x.id === id);
          return r ? routeLabel(r) : 'ruta fuera de su alcance';
        }).join(', ') || 'Ninguna'}</dd>
      </dl>
      {others.length ? (
        <p className="muted small">
          La misma persona tiene además: {others.map((o) => `${ROLE[o.role] ?? o.role}${o.status !== 'activo' ? ' (inactiva)' : ''}`).join(', ')}.
          Cada membresía tiene sus propios permisos y rutas; nunca se suman.
        </p>
      ) : null}
      <p className="muted small">El rol de una membresía no se modifica. Para otro rol: cree una membresía nueva con el mismo correo y desactive esta (conserva su historia).</p>

      {ctx.can('user.edit') && managed ? <EditMember m={m} onDone={changed} /> : null}
      {ctx.can('route.assign') && managed && m.role !== 'superadmin'
        ? <MemberRoutes m={m} routes={routes} hidden={m.routeIds.filter((id) => !visible.has(id))} onDone={changed} />
        : null}
      {ctx.can('route.assign') && managed && m.role !== 'superadmin' && offices.length
        ? <OfficeRoutes m={m} routes={routes} offices={offices} onDone={changed} />
        : null}

      <div className="actions-row">
        {ctx.can('user.block') && managed ? (m.status === 'activo'
          ? <Confirm label="Desactivar" disabled={status.busy} confirmLabel="Sí, desactivar"
              question={<>¿Desactivar la membresía de <strong>{m.displayName}</strong> ({ROLE[m.role]})? Pierde el acceso con este rol al instante; su historia se conserva.{self ? ' Es su propia membresía: saldrá de este contexto.' : ''}</>}
              onConfirm={() => status.run(() => client.send<MemberResult>('POST', `/v1/members/${m.membershipId}/deactivate`), (r) => `Membresía desactivada.${controllerNote(r.controllerEvents)}`).then((r) => r && changed())} />
          : <Confirm label="Reactivar" danger={false} disabled={status.busy} confirmLabel="Sí, reactivar"
              question={<>¿Reactivar la membresía de <strong>{m.displayName}</strong>? Recupera el acceso con el rol {ROLE[m.role]} y sus rutas asignadas.</>}
              onConfirm={() => status.run(() => client.send<MemberResult>('POST', `/v1/members/${m.membershipId}/reactivate`), (r) => `Membresía reactivada.${controllerNote(r.controllerEvents)}`).then((r) => r && changed())} />)
          : null}
        {ctx.role === 'superadmin' && !self ? (
          <Confirm label="Eliminar" disabled={del.busy} confirmLabel="Sí, eliminar"
            question={<>¿Eliminar definitivamente la membresía de <strong>{m.displayName}</strong>? Solo es posible si nunca tuvo historia ni rutas; en otro caso el servidor lo rechazará y deberá desactivarla.</>}
            onConfirm={() => del.run(() => client.send('POST', `/v1/members/${m.membershipId}/delete`)).then((r) => { if (r) onDeleted(); })} />
        ) : null}
      </div>
      <ActionMessage action={status} />
      <ActionMessage action={del} />
    </div>
  );
}

function EditMember({ m, onDone }: { m: MemberView; onDone: () => Promise<void> }) {
  const { client } = useApp();
  const action = useAction();
  const [displayName, setName] = useSynced(m.displayName);
  const [phone, setPhone] = useSynced(m.phone ?? '');
  const dirty = displayName.trim() !== m.displayName || (phone.trim() || null) !== (m.phone ?? null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await action.run(() => client.send('PATCH', `/v1/members/${m.membershipId}`, { displayName: displayName.trim(), phone: phone.trim() || null }), () => 'Datos guardados.');
    if (r) await onDone();
  }
  return (
    <form className="form admin-block" onSubmit={(e) => void submit(e)}>
      <h3>Datos de contacto</h3>
      <div className="row">
        <Field label="Nombre visible"><input required maxLength={120} value={displayName} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Teléfono"><input maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
      </div>
      <div><button className="primary" disabled={action.busy || !dirty}>Guardar datos</button></div>
      <ActionMessage action={action} />
    </form>
  );
}

function MemberRoutes({ m, routes, hidden, onDone }: { m: MemberView; routes: RouteView[]; hidden: string[]; onDone: () => Promise<void> }) {
  const { client } = useApp();
  const action = useAction();
  const current = m.routeIds.filter((id) => !hidden.includes(id));
  const [sel, setSel] = useSynced<string[]>(current);
  const dirty = sel.length !== current.length || sel.some((id) => !current.includes(id));
  async function save() {
    // Las rutas que este contexto no alcanza se conservan tal cual (el servidor las protege).
    const r = await action.run(() => client.send<MemberResult>('PUT', `/v1/members/${m.membershipId}/routes`, { routeIds: [...hidden, ...sel] }),
      (v) => `Rutas guardadas.${controllerNote(v.controllerEvents)}`);
    if (r) await onDone();
  }
  return (
    <div className="admin-block">
      <h3>Rutas autorizadas</h3>
      {m.role === 'cobrador' ? <p className="muted small">Al asignar una ruta a un Cobrador, pasa a ser su Cobrador responsable (si había otro, el servidor lo retira de esa ruta).</p> : null}
      {m.role === 'admin' ? <p className="muted small">Si este Administrador es el responsable de capital de una ruta que se le retira, el servidor exigirá elegir antes otro responsable.</p> : null}
      <CheckList items={routes.map((r) => ({ id: r.id, label: routeLabel(r), hint: r.status !== 'activa' ? 'inactiva' : undefined }))} selected={sel} onChange={setSel} />
      {hidden.length ? <p className="muted small">Además tiene {hidden.length} ruta(s) fuera de su alcance, que no se modifican.</p> : null}
      <div className="actions-row"><button className="primary" disabled={action.busy || !dirty} onClick={() => void save()}>Guardar rutas</button></div>
      <ActionMessage action={action} />
    </div>
  );
}

function OfficeRoutes({ m, routes, offices, onDone }: { m: MemberView; routes: RouteView[]; offices: OfficeView[]; onDone: () => Promise<void> }) {
  const { client } = useApp();
  const action = useAction();
  const [officeId, setOfficeId] = useState('');
  const office = offices.find((o) => o.id === officeId);
  const officeRoutes = routes.filter((r) => office?.routeIds.includes(r.id));
  const [sel, setSel] = useState<string[]>([]);
  function pick(id: string) {
    setOfficeId(id);
    const o = offices.find((x) => x.id === id);
    setSel(m.routeIds.filter((r) => o?.routeIds.includes(r)));
  }
  async function save() {
    const r = await action.run(() => client.send<MemberResult>('PUT', `/v1/members/${m.membershipId}/office-routes`, { officeId, selectedRouteIds: sel }),
      (v) => `Rutas de la oficina guardadas; las demás rutas no cambiaron.${controllerNote(v.controllerEvents)}`);
    if (r) await onDone();
  }
  return (
    <div className="admin-block">
      <h3>Asignar por oficina</h3>
      <Field label="Oficina">
        <select value={officeId} onChange={(e) => pick(e.target.value)}>
          <option value="">Elegir oficina…</option>
          {offices.map((o) => <option key={o.id} value={o.id}>{o.name}{o.status !== 'activa' ? ' (inactiva)' : ''}</option>)}
        </select>
      </Field>
      {office ? (
        <>
          <CheckList items={officeRoutes.map((r) => ({ id: r.id, label: routeLabel(r) }))} selected={sel} onChange={setSel} empty="Esta oficina no tiene rutas a su alcance." />
          <div className="actions-row"><button className="primary" disabled={action.busy || !officeRoutes.length} onClick={() => void save()}>Guardar rutas de la oficina</button></div>
        </>
      ) : null}
      <ActionMessage action={action} />
    </div>
  );
}

function NewMember({ routes, onDone, onRefresh }: { routes: RouteView[]; onDone: (membershipId: string, message: string) => void; onRefresh: () => void }) {
  const { client } = useApp();
  const { role, can } = useCtx();
  const roles = manageableRoles(role);
  const action = useAction();
  const [f, setF] = useState({ email: '', displayName: '', phone: '', role: roles.includes('cobrador') ? 'cobrador' : roles[0]! });
  const [routeIds, setRouteIds] = useState<string[]>([]);
  const withRoutes = f.role !== 'superadmin' && can('route.assign');
  const body = { email: f.email.trim().toLowerCase(), displayName: f.displayName.trim(), role: f.role, ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
    routeIds: withRoutes ? routeIds : [] };
  const intent = useIntent(body);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const created = await action.run(() => client.command<MemberResult>('POST', '/v1/members', body, intent.operationId));
    if (created) {
      intent.confirmed();
      onDone(created.membershipId, `Alta confirmada: ${created.displayName}. Para su primer acceso, la persona abre ADEX Online, pulsa «Olvidé mi contraseña / primer acceso» y usa ${created.email ?? 'su correo'}.${controllerNote(created.controllerEvents)}`);
    }
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <h3>Nuevo usuario</h3>
      <p className="muted small">ADEX nunca pide ni muestra contraseñas: la persona fija la suya desde la pantalla de acceso. Si ya usa ADEX en otra empresa o con otro rol, se reutiliza su identidad y se crea una membresía independiente.</p>
      <div className="row">
        <Field label="Correo"><input type="email" required value={f.email} onChange={set('email')} autoComplete="off" /></Field>
        <Field label="Nombre visible"><input required maxLength={120} value={f.displayName} onChange={set('displayName')} /></Field>
      </div>
      <div className="row">
        <Field label="Rol">
          <select value={f.role} onChange={set('role')}>{roles.map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}</select>
        </Field>
        <Field label="Teléfono (opcional)"><input maxLength={40} value={f.phone} onChange={set('phone')} /></Field>
      </div>
      {withRoutes ? (
        <div className="field">
          <span>Rutas autorizadas</span>
          <CheckList items={routes.map((r) => ({ id: r.id, label: routeLabel(r) }))} selected={routeIds} onChange={setRouteIds} empty="No hay rutas a su alcance todavía." />
        </div>
      ) : f.role === 'superadmin' ? <p className="muted small">El Super Admin accede a todas las rutas de la empresa.</p> : null}
      <div><button className="primary" disabled={action.busy}>Dar de alta</button></div>
      <ActionMessage action={action} onResolved={onRefresh} />
    </form>
  );
}
