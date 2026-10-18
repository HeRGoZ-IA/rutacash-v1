// Capital: bolsa del Administrador (solo la propia), entrega anticipada al Cobrador,
// devolución y movimientos. SuperAdmin: posición de la empresa, aportes y asignaciones.
// «Mi efectivo»: custodia del trabajador por ruta (nunca bolsas ajenas).

import { useState, type FormEvent } from 'react';
import { useAction, useApp, useCtx, useResource } from '../lib/app.tsx';
import { useMembers, useRoutes, nameOf, type RouteView } from '../lib/lookups.ts';
import { date, OPERATION_KIND, parseMoney } from '../lib/format.ts';
import { ActionMessage, Field, Loaded, Money, Refresh, Section } from '../ui.tsx';

interface Pool { adminId: string; name: string; availableMinor: number; allocatedNetMinor: number; deliveredToWorkersMinor: number; returnedFromWorkersMinor: number; custodyUnderResponsibilityMinor: number }
interface Summary { company?: { availableMinor: number; adminPoolsMinor: number; custodyMinor: number; portfolioMinor: number; externalNetInMinor: number }; admins: Pool[] }
interface Position { routeId: string; workerId: string; workerName: string; role: string; balanceMinor: number; carriedMinor: number; transferableMinor: number; updatedAt: string }
interface Operation { id: string; kind: string; amountMinor: number; routeId: string | null; workerId: string | null; adminId: string | null; reason: string; entryDate: string; createdAt: string; actorRole: string | null }

function useAmount() {
  const { company } = useCtx();
  const [text, setText] = useState('');
  return { text, setText, minor: parseMoney(text, company.minorUnits) };
}

export function Capital() {
  const { client } = useApp();
  const { role, membershipId } = useCtx();
  const summary = useResource(() => client.get<Summary>('/v1/capital/summary'), []);
  const routes = useRoutes();
  const myRoutes = (routes.data ?? []).filter((r) => role === 'superadmin' || r.capitalControllerId === membershipId);
  return (
    <>
      <Section title={role === 'superadmin' ? 'Capital de la empresa' : 'Mi bolsa de capital'} actions={<Refresh r={summary} />}>
        <Loaded r={summary}>
          {(s) => (
            <>
              {s.company ? (
                <div className="stats">
                  <Stat label="Disponible en la empresa" minor={s.company.availableMinor} />
                  <Stat label="En bolsas de Administradores" minor={s.company.adminPoolsMinor} />
                  <Stat label="En custodia de trabajadores" minor={s.company.custodyMinor} />
                  <Stat label="Cartera prestada (por cobrar)" minor={s.company.portfolioMinor} />
                </div>
              ) : null}
              <ul className="list">
                {s.admins.map((a) => (
                  <li key={a.adminId}><div className="row-static">
                    <strong>{a.name}</strong>
                    <span>Disponible <Money minor={a.availableMinor} /></span>
                    <span className="muted small">Entregado <Money minor={a.deliveredToWorkersMinor} /> · Devuelto <Money minor={a.returnedFromWorkersMinor} /> · En custodia de sus rutas <Money minor={a.custodyUnderResponsibilityMinor} /></span>
                  </div></li>
                ))}
              </ul>
            </>
          )}
        </Loaded>
      </Section>
      {role === 'superadmin' ? <CompanyCapital pools={summary.data?.admins ?? []} onDone={() => void summary.reload()} /> : null}
      <Section title="Entregar capital al trabajador">
        <p className="muted small">Anticipo de efectivo: no crea deuda ni autoriza a prestar. Solo el Administrador responsable de la ruta.</p>
        <WorkerMove kind="deliver" routes={myRoutes} loaded={routes.data !== null} onDone={() => void summary.reload()} />
      </Section>
      <Section title="Recibir devolución del trabajador">
        <WorkerMove kind="return" routes={(routes.data ?? []).filter((r) => role === 'superadmin' || r.capitalControllerId === membershipId || role === 'supervisor')}
          loaded={routes.data !== null} onDone={() => void summary.reload()} />
      </Section>
      <Movements routes={routes.data ?? []} />
    </>
  );
}

function Stat({ label, minor }: { label: string; minor: number }) {
  return <div className="stat"><span className="muted small">{label}</span><strong><Money minor={minor} /></strong></div>;
}

function WorkerMove({ kind, routes, loaded, onDone }: { kind: 'deliver' | 'return'; routes: RouteView[]; loaded: boolean; onDone: () => void }) {
  const { client } = useApp();
  const { can } = useCtx();
  const members = useMembers(can('user.viewAll'));
  const [routeId, setRouteId] = useState('');
  const [workerId, setWorkerId] = useState('');
  const [reason, setReason] = useState(kind === 'deliver' ? 'Capital del día' : 'Devolución de efectivo');
  const amount = useAmount();
  const action = useAction();
  const route = routes.find((r) => r.id === (routeId || routes[0]?.id));
  const workers = (members.data ?? []).filter((m) => m.status === 'activo' && ['cobrador', 'supervisor'].includes(m.role) && route && m.routeIds.includes(route.id));
  const options = workers.length ? workers.map((w) => ({ id: w.membershipId, label: `${w.displayName} (${w.role})` }))
    : route?.collectorId ? [{ id: route.collectorId, label: 'Cobrador de la ruta' }] : [];

  if (!loaded) return <p className="muted">Cargando…</p>;
  if (!routes.length) return <p className="muted">No es responsable de capital de ninguna ruta.</p>;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!route || !amount.minor) return action.setMessage({ kind: 'error', text: 'Indique ruta, trabajador e importe válido.' });
    const body = { routeId: route.id, workerId: workerId || options[0]?.id, amountMinor: amount.minor, reason };
    const done = await action.run(() => client.command('POST', kind === 'deliver' ? '/v1/capital/deliveries' : '/v1/capital/returns', body),
      () => (kind === 'deliver' ? 'Entrega registrada y confirmada por el servidor.' : 'Devolución registrada.'));
    if (done) { amount.setText(''); onDone(); }
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <div className="row">
        <Field label="Ruta"><select value={route?.id ?? ''} onChange={(e) => { setRouteId(e.target.value); setWorkerId(''); }}>
          {routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        <Field label="Trabajador"><select value={workerId || options[0]?.id || ''} onChange={(e) => setWorkerId(e.target.value)}>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></Field>
      </div>
      <div className="row">
        <Field label="Importe"><input inputMode="decimal" required value={amount.text} onChange={(e) => amount.setText(e.target.value)} placeholder="0,00" /></Field>
        <Field label="Motivo"><input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
      <button className="primary" disabled={action.busy}>{kind === 'deliver' ? 'Entregar' : 'Registrar devolución'}</button>
      <ActionMessage action={action} onResolved={onDone} />
    </form>
  );
}

function CompanyCapital({ pools, onDone }: { pools: Pool[]; onDone: () => void }) {
  const { client } = useApp();
  const deposit = useAmount();
  const alloc = useAmount();
  const [adminId, setAdminId] = useState('');
  const action = useAction();
  return (
    <Section title="Aportes y asignación (SuperAdmin)">
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (!deposit.minor) return;
        void action.run(() => client.command('POST', '/v1/capital/company/deposits', { amountMinor: deposit.minor, reason: 'Aporte de capital' }), () => 'Aporte registrado.')
          .then((v) => { if (v) { deposit.setText(''); onDone(); } }); }}>
        <div className="row">
          <Field label="Aporte a la empresa"><input inputMode="decimal" value={deposit.text} onChange={(e) => deposit.setText(e.target.value)} /></Field>
          <button className="primary" disabled={action.busy}>Registrar aporte</button>
        </div>
      </form>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (!alloc.minor) return;
        void action.run(() => client.command('POST', '/v1/capital/allocations', { adminId: adminId || pools[0]?.adminId, amountMinor: alloc.minor, reason: 'Asignación de capital' }), () => 'Asignación registrada.')
          .then((v) => { if (v) { alloc.setText(''); onDone(); } }); }}>
        <div className="row">
          <Field label="Administrador"><select value={adminId || pools[0]?.adminId || ''} onChange={(e) => setAdminId(e.target.value)}>
            {pools.map((p) => <option key={p.adminId} value={p.adminId}>{p.name}</option>)}</select></Field>
          <Field label="Importe a asignar"><input inputMode="decimal" value={alloc.text} onChange={(e) => alloc.setText(e.target.value)} /></Field>
          <button className="primary" disabled={action.busy}>Asignar</button>
        </div>
      </form>
      <ActionMessage action={action} onResolved={onDone} />
    </Section>
  );
}

function Movements({ routes }: { routes: RouteView[] }) {
  const { client } = useApp();
  const [routeId, setRouteId] = useState('');
  const ops = useResource(async () => (await client.get<{ operations: Operation[] }>(`/v1/capital/operations?limit=100${routeId ? `&routeId=${encodeURIComponent(routeId)}` : ''}`)).operations, [routeId]);
  return (
    <Section title="Movimientos de capital" actions={<>
      <select value={routeId} onChange={(e) => setRouteId(e.target.value)}><option value="">Todas las rutas visibles</option>{routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
      <Refresh r={ops} />
    </>}>
      <Loaded r={ops} empty={(d) => d.length === 0}>
        {(d) => (
          <table className="table">
            <thead><tr><th>Fecha</th><th>Tipo</th><th>Ruta</th><th className="right">Importe</th><th>Motivo</th></tr></thead>
            <tbody>{d.map((o) => (
              <tr key={o.id}><td>{date(o.createdAt)}</td><td>{OPERATION_KIND[o.kind] ?? o.kind}</td><td>{nameOf(routes, o.routeId)}</td>
                <td className="right"><Money minor={o.amountMinor} /></td><td className="muted">{o.reason}</td></tr>))}
            </tbody>
          </table>
        )}
      </Loaded>
    </Section>
  );
}

export function MyCash() {
  const { client } = useApp();
  const routes = useRoutes();
  const positions = useResource(async () => (await client.get<{ positions: Position[] }>('/v1/capital/custody')).positions, []);
  return (
    <>
      <Section title="Mi efectivo bajo custodia" actions={<Refresh r={positions} />}>
        <p className="muted small">Capital recibido y efectivo en sus manos, separado por ruta. Tenerlo no autoriza a prestar: cada crédito necesita su solicitud aprobada.</p>
        <Loaded r={positions} empty={(d) => d.length === 0}>
          {(d) => (
            <div className="stats">
              {d.map((p) => (
                <div className="stat" key={`${p.routeId}:${p.workerId}`}>
                  <span className="muted small">{nameOf(routes.data, p.routeId)} · {p.workerName}</span>
                  <strong><Money minor={p.balanceMinor} /></strong>
                  {p.carriedMinor ? <span className="muted small">Faltante arrastrado <Money minor={p.carriedMinor} /> (deuda, no efectivo) · disponible <Money minor={p.transferableMinor} /></span> : null}
                  {p.balanceMinor < 0 ? <span className="muted small">Negativo por gastos pagados: no se entrega ni se presta; los próximos cobros lo compensan y el cuadre lo concilia.</span> : null}
                </div>
              ))}
            </div>
          )}
        </Loaded>
      </Section>
      <Movements routes={routes.data ?? []} />
    </>
  );
}
