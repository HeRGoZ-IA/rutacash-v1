// Oficinas: la Oficina ORGANIZA rutas; no concede acceso a ellas (eso lo dan las rutas
// autorizadas de cada membresía). Una Oficina inactiva bloquea operaciones nuevas en
// sus rutas. Eliminarla nunca borra rutas: quedan «Sin oficina» si se confirma.

import { useState, type FormEvent } from 'react';
import { useAction, useApp, useCtx } from '../lib/app.tsx';
import { useOffices, useRoutes, type OfficeView, type RouteView } from '../lib/lookups.ts';
import { routeLabel, useIntent, useSynced } from '../lib/admin.ts';
import { ActionMessage, Badge, CheckList, Confirm, Field, Loaded, Refresh, Section } from '../ui.tsx';

export function Offices() {
  const { can } = useCtx();
  const offices = useOffices();
  const routes = useRoutes();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const reloadAll = async () => { await Promise.all([offices.reload(), routes.reload()]); };
  const loose = (routes.data ?? []).filter((r) => !r.officeId);

  return (
    <Section title="Oficinas" actions={<>
      {can('office.create') ? <button className="primary" onClick={() => { setCreating(!creating); setDone(null); }}>{creating ? 'Cerrar alta' : 'Nueva oficina'}</button> : null}
      <Refresh r={offices} />
    </>}>
      {creating ? <NewOffice onDone={(id, msg) => { setCreating(false); setDone(msg); setSelected(id); void reloadAll(); }} onRefresh={() => void reloadAll()} /> : null}
      {done ? <p className="msg ok" role="status">{done}</p> : null}
      <Loaded r={offices} empty={(d) => d.length === 0}>
        {(list) => (
          <ul className="list">
            {list.map((o) => (
              <li key={o.id} className={selected === o.id ? 'active' : ''}>
                <button className="row-button" onClick={() => setSelected(selected === o.id ? null : o.id)}>
                  <strong>{o.name}{o.code ? ` (${o.code})` : ''}</strong>
                  <span className="muted">{o.routeIds.length} ruta(s) a su alcance</span>
                  {o.status !== 'activa' ? <Badge tone="warn">Inactiva</Badge> : null}
                </button>
                {selected === o.id
                  ? <OfficeDetail o={o} routes={routes.data ?? []} onChanged={reloadAll} onDeleted={() => { setSelected(null); void reloadAll(); }} />
                  : null}
              </li>
            ))}
          </ul>
        )}
      </Loaded>
      {routes.data ? <p className="muted small">Rutas sin oficina: {loose.map(routeLabel).join(', ') || 'ninguna'}.</p> : null}
    </Section>
  );
}

function OfficeDetail({ o, routes, onChanged, onDeleted }: { o: OfficeView; routes: RouteView[]; onChanged: () => Promise<void>; onDeleted: () => void }) {
  const { client } = useApp();
  const { can } = useCtx();
  const status = useAction();
  const del = useAction();
  const mine = routes.filter((r) => o.routeIds.includes(r.id));
  return (
    <div className="detail">
      <dl className="grid2">
        <dt>Estado</dt><dd>{o.status === 'activa' ? <Badge tone="ok">Activa</Badge> : <Badge tone="warn">Inactiva: sus rutas no admiten operaciones nuevas</Badge>}</dd>
        <dt>Rutas</dt><dd>{mine.map(routeLabel).join(', ') || 'Ninguna a su alcance'}</dd>
      </dl>
      {can('office.edit') ? <EditOffice o={o} onDone={onChanged} /> : null}
      {can('route.edit') ? <OfficeRoutesEditor o={o} routes={routes} onDone={onChanged} /> : null}
      <div className="actions-row">
        {can('office.changeStatus') ? (o.status === 'activa'
          ? <Confirm label="Desactivar oficina" disabled={status.busy} confirmLabel="Sí, desactivar"
              question={<>¿Desactivar <strong>{o.name}</strong>? Sus {o.routeIds.length} ruta(s) dejarán de admitir operaciones nuevas hasta reactivarla; la consulta se conserva.</>}
              onConfirm={() => status.run(() => client.send('POST', `/v1/offices/${o.id}/status`, { status: 'inactiva' }), () => 'Oficina desactivada.').then((v) => v && onChanged())} />
          : <Confirm label="Reactivar oficina" danger={false} disabled={status.busy} confirmLabel="Sí, reactivar"
              question={<>¿Reactivar <strong>{o.name}</strong>? Sus rutas activas volverán a admitir operaciones nuevas.</>}
              onConfirm={() => status.run(() => client.send('POST', `/v1/offices/${o.id}/status`, { status: 'activa' }), () => 'Oficina reactivada.').then((v) => v && onChanged())} />)
          : null}
        {can('office.delete') ? (
          <Confirm label="Eliminar oficina" disabled={del.busy} confirmLabel="Sí, eliminar"
            question={o.routeIds.length
              ? <>¿Eliminar <strong>{o.name}</strong>? Sus rutas NO se borran: quedan «Sin oficina».</>
              : <>¿Eliminar <strong>{o.name}</strong>?</>}
            onConfirm={() => del.run(() => client.send('POST', `/v1/offices/${o.id}/delete`, { detachRoutes: true }), () => 'Oficina eliminada.').then((v) => { if (v) onDeleted(); })} />
        ) : null}
      </div>
      <ActionMessage action={status} />
      <ActionMessage action={del} />
    </div>
  );
}

function EditOffice({ o, onDone }: { o: OfficeView; onDone: () => Promise<void> }) {
  const { client } = useApp();
  const action = useAction();
  const [name, setName] = useSynced(o.name);
  const [code, setCode] = useSynced(o.code ?? '');
  const dirty = name.trim() !== o.name || (code.trim() || null) !== o.code;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const v = await action.run(() => client.send('PATCH', `/v1/offices/${o.id}`, { name: name.trim(), code: code.trim() || null }), () => 'Oficina actualizada.');
    if (v) await onDone();
  }
  return (
    <form className="form admin-block" onSubmit={(e) => void submit(e)}>
      <h3>Datos de la oficina</h3>
      <div className="row">
        <Field label="Nombre"><input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Código (opcional)"><input maxLength={40} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
      </div>
      <div><button className="primary" disabled={action.busy || !dirty}>Guardar oficina</button></div>
      <ActionMessage action={action} />
    </form>
  );
}

/** Qué rutas pertenecen a la Oficina: se mueven de una en una en el servidor (ninguna se borra). */
function OfficeRoutesEditor({ o, routes, onDone }: { o: OfficeView; routes: RouteView[]; onDone: () => Promise<void> }) {
  const { client } = useApp();
  const action = useAction();
  const [sel, setSel] = useSynced<string[]>(o.routeIds);
  const added = sel.filter((id) => !o.routeIds.includes(id));
  const removed = o.routeIds.filter((id) => !sel.includes(id));
  async function save() {
    await action.run(async () => {
      if (removed.length) await client.send('POST', '/v1/offices/assign-routes', { officeId: null, routeIds: removed });
      if (added.length) await client.send('POST', '/v1/offices/assign-routes', { officeId: o.id, routeIds: added });
      return true;
    }, () => `Rutas de la oficina guardadas${removed.length ? ` (${removed.length} quedaron Sin oficina)` : ''}.`);
    // También tras un fallo: si se aplicó solo la primera parte, se muestra lo que tiene el servidor.
    await onDone();
  }
  return (
    <div className="admin-block">
      <h3>Rutas de la oficina</h3>
      <p className="muted small">Marcar una ruta de otra oficina la traslada aquí. Pertenecer a la oficina no da acceso a nadie: el acceso se asigna por persona.</p>
      <CheckList items={routes.map((r) => ({ id: r.id, label: routeLabel(r), hint: r.officeId && r.officeId !== o.id ? 'en otra oficina' : undefined }))}
        selected={sel} onChange={setSel} empty="No hay rutas a su alcance." />
      <div className="actions-row"><button className="primary" disabled={action.busy || (!added.length && !removed.length)} onClick={() => void save()}>Guardar rutas</button></div>
      <ActionMessage action={action} />
    </div>
  );
}

function NewOffice({ onDone, onRefresh }: { onDone: (id: string, message: string) => void; onRefresh: () => void }) {
  const { client } = useApp();
  const action = useAction();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const body = { name: name.trim(), ...(code.trim() ? { code: code.trim() } : {}) };
  const intent = useIntent(body);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const created = await action.run(() => client.command<OfficeView>('POST', '/v1/offices', body, intent.operationId));
    if (created) { intent.confirmed(); onDone(created.id, `Oficina creada: ${created.name}.`); }
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <h3>Nueva oficina</h3>
      <div className="row">
        <Field label="Nombre"><input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Código (opcional)"><input maxLength={40} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
      </div>
      <div><button className="primary" disabled={action.busy}>Crear oficina</button></div>
      <ActionMessage action={action} onResolved={onRefresh} />
    </form>
  );
}
