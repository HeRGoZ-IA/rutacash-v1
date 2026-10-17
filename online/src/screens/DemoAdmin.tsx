// Administración de la EMPRESA DEMO (solo operadores Demo; plano separado, sin
// membresía). Crear, reiniciar (= recrear con otro ID y retirar la anterior), eliminar
// y recrear. Las acciones destructivas exigen escribir el ID interno exacto.

import { useState } from 'react';
import { useAction, useApp, useResource } from '../lib/app.tsx';
import { ApiFailure } from '../lib/client.ts';
import { date, errorText, ROLE } from '../lib/format.ts';
import { ActionMessage, Badge, Field, Refresh, Section } from '../ui.tsx';

const SLOT = 'principal';

interface Status {
  state: string;
  company: { id: string; name: string; createdAt: string; activatedAt: string | null; scenario: string; state: string; operable: boolean } | null;
  pendingCompanyId: string | null;
  seats: { seat: string; role: string; synthetic: boolean; assignable: boolean; displayName: string }[];
  participants: { seat: string; email: string; displayName: string; identityStatus: string }[];
  assignableSeats: { seat: string; role: string }[];
  retiredCount: number;
  jobRunning: boolean;
  events: { id: number; at: string; companyId: string | null; action: string; outcome: string; detail: Record<string, unknown> | null }[];
}

const STATE: Record<string, string> = { empty: 'Sin Empresa Demo', provisioning: 'Creando…', active: 'Activa', resetting: 'Reiniciando…' };

export function DemoAdmin() {
  const { client } = useApp();
  const busyStates = ['provisioning', 'resetting'];
  const status = useResource(async () => (await client.demo('GET', `/slots/${SLOT}`)) as unknown as Status, [], 5_000);
  const action = useAction();
  const [confirm, setConfirm] = useState('');
  const s = status.data;

  if (status.error instanceof ApiFailure && status.error.code === 'DEMO_OPERATOR_REQUIRED') {
    return <Section title="Empresa Demo"><p className="msg warn">Su usuario no está habilitado para administrar la Empresa Demo.</p></Section>;
  }
  const live = s?.company?.id ?? '';
  const lifecycle = (path: string, body: Record<string, unknown>, ok: string) =>
    void action.run(() => client.demo('POST', `/slots/${SLOT}/${path}`, { ...body, wait: false }), () => ok).then(() => { setConfirm(''); void status.reload(); });

  return (
    <>
      <Section title="Empresa Demo" actions={<Refresh r={status} />}>
        {!s ? <p className="muted">{status.error ? errorText(status.error) : 'Cargando…'}</p> : (
          <>
            <p><Badge tone={s.state === 'active' ? 'ok' : busyStates.includes(s.state) ? 'warn' : 'neutral'}>{STATE[s.state] ?? s.state}</Badge>
              {s.jobRunning ? <span className="muted small"> · preparando el escenario con el motor real…</span> : null}</p>
            {s.company ? (
              <dl className="grid2">
                <dt>Nombre</dt><dd>{s.company.name}</dd>
                <dt>ID interno</dt><dd><code>{s.company.id}</code></dd>
                <dt>Escenario</dt><dd>{s.company.scenario}</dd>
                <dt>Creada</dt><dd>{date(s.company.createdAt)}</dd>
                <dt>Operable</dt><dd>{s.company.operable ? 'Sí' : 'No (congelada o en mantenimiento)'}</dd>
              </dl>
            ) : null}
            <p className="muted small">Empresas Demo retiradas (conservadas, inmutables e inaccesibles): {s.retiredCount}</p>
            <div className="form">
              {s.state === 'empty' ? (
                <button className="primary" disabled={action.busy} onClick={() => lifecycle('create', {}, 'Creación iniciada. El estado se actualiza solo.')}>Crear Empresa Demo</button>
              ) : null}
              {s.state === 'active' && s.company ? (
                <>
                  <Field label="Para reiniciar o eliminar, escriba el ID interno exacto" hint="Reiniciar crea una Demo NUEVA (otro ID) con el escenario conocido y retira la actual. Eliminar la retira y deja el hueco vacío para recrearla.">
                    <input value={confirm} onChange={(e) => setConfirm(e.target.value.trim())} placeholder={live} />
                  </Field>
                  <div className="row">
                    <button className="primary" disabled={action.busy || confirm !== live} onClick={() => lifecycle('reset', { companyId: live, confirm }, 'Reinicio iniciado: la Demo actual quedó congelada.')}>Reiniciar</button>
                    <button className="danger" disabled={action.busy || confirm !== live} onClick={() => lifecycle('delete', { companyId: live, confirm }, 'Empresa Demo retirada.')}>Eliminar</button>
                  </div>
                </>
              ) : null}
              {busyStates.includes(s.state) && !s.jobRunning ? (
                <button className="danger" disabled={action.busy} onClick={() => lifecycle('abort', { companyId: s.pendingCompanyId ?? live, confirm: s.pendingCompanyId ?? live }, 'Aprovisionamiento interrumpido y revertido.')}>
                  Recuperar aprovisionamiento interrumpido
                </button>
              ) : null}
            </div>
            <ActionMessage action={action} />
          </>
        )}
      </Section>
      {s ? <Participants s={s} onChange={() => void status.reload()} /> : null}
      {s ? (
        <Section title="Auditoría administrativa (externa a la Demo)">
          <table className="table compact">
            <thead><tr><th>Fecha</th><th>Acción</th><th>Resultado</th><th>Empresa</th></tr></thead>
            <tbody>{s.events.map((e) => (
              <tr key={e.id}><td>{date(e.at)}</td><td>{e.action}</td>
                <td><Badge tone={e.outcome === 'succeeded' ? 'ok' : e.outcome === 'started' ? 'info' : 'bad'}>{e.outcome}</Badge>{e.detail?.['code'] ? ` ${String(e.detail['code'])}` : ''}</td>
                <td className="muted small">{e.companyId?.slice(0, 8) ?? '—'}</td></tr>))}
            </tbody>
          </table>
        </Section>
      ) : null}
    </>
  );
}

function Participants({ s, onChange }: { s: Status; onChange: () => void }) {
  const { client } = useApp();
  const action = useAction();
  const [seat, setSeat] = useState(s.assignableSeats[0]?.seat ?? '');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  return (
    <Section title="Personas invitadas en la Demo">
      <p className="muted small">Cada persona ocupa puestos (membresías) de la próxima Demo creada o reiniciada. La invitación usa el procedimiento del proveedor: nadie conoce una contraseña; la persona la fija con «primer acceso».</p>
      <ul className="list">
        {s.assignableSeats.map((a) => {
          const p = s.participants.find((x) => x.seat === a.seat);
          return (
            <li key={a.seat}><div className="row-static">
              <strong>{a.seat} · {ROLE[a.role] ?? a.role}</strong>
              <span>{p ? `${p.displayName} · ${p.email}` : <span className="muted">Puesto sintético (sin persona)</span>}</span>
              {p ? <button className="link" disabled={action.busy} onClick={() => void action.run(() => client.demo('POST', `/slots/${SLOT}/participants/${a.seat}/remove`), () => 'Puesto liberado.').then(onChange)}>Liberar</button> : null}
            </div></li>
          );
        })}
      </ul>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void action.run(() => client.demo('PUT', `/slots/${SLOT}/participants/${seat}`, { email, displayName: name }), () => 'Persona asignada. Se aplica al crear o reiniciar la Demo.').then((v) => { if (v) { setEmail(''); setName(''); onChange(); } }); }}>
        <div className="row">
          <Field label="Puesto"><select value={seat} onChange={(e) => setSeat(e.target.value)}>{s.assignableSeats.map((a) => <option key={a.seat} value={a.seat}>{a.seat}</option>)}</select></Field>
          <Field label="Correo de la persona"><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Nombre visible"><input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        </div>
        <button disabled={action.busy}>Asignar puesto</button>
        <ActionMessage action={action} />
      </form>
    </Section>
  );
}
