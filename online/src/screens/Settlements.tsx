// Cuadres (por trabajador y ruta) y cierres de periodo. TODAS las cifras vienen del
// servidor: la pantalla muestra la vista previa, envía lo entregado y el esperado que
// vio (si cambió, el servidor rechaza y aquí se vuelve a leer). Nada se calcula como
// autoridad en el navegador; la diferencia que se muestra antes de cerrar es orientativa.
//
//   · Entrega parcial: devolución de efectivo a la bolsa del responsable. No cierra el cuadre.
//   · Cuadre: concilia esperado, entregado, faltante (arrastre, no gastable) y sobrante
//     (en control, no es capital). Una posición negativa por gastos sigue al ciclo siguiente.
//   · Cierre: archiva la liquidación de un periodo terminado (fechas de la empresa).

import { useState, type FormEvent } from 'react';
import { useAction, useApp, useCtx, useResource } from '../lib/app.tsx';
import { ApiFailure } from '../lib/client.ts';
import { useRoutes, nameOf, type RouteView } from '../lib/lookups.ts';
import { date, errorText, parseMoney, ROLE } from '../lib/format.ts';
import { ActionMessage, Badge, Field, Loaded, Money, Refresh, Section } from '../ui.tsx';

type Num = number;
interface Cycle { openingMinor: Num; baseDeliveredMinor: Num; transfersInMinor: Num; transfersOutMinor: Num; partialReturnsMinor: Num; reopenedSettlementsMinor: Num; collectedMinor: Num; disbursedMinor: Num; expensesMinor: Num; otherMinor: Num; entries: Num }
interface Preview {
  routeId: string; workerId: string; workerName: string; workerRole: string; workerActive: boolean; assigned: boolean;
  previousSettlementId: string | null; previousClosedAt: string | null; cycle: Cycle; openingCarriedMinor: Num;
  expectedPositionMinor: Num; expectedCashMinor: Num; negativePositionMinor: Num; carriedMinor: Num; availableMinor: Num;
  controllerId: string | null; businessDate: string; timezone: string; periodClosedToday: boolean;
}
interface Worker { workerId: string; name: string; role: string; status: string; assigned: boolean; own: boolean; positionMinor: Num; carriedMinor: Num; availableMinor: Num }
interface Workers { routeId: string; routeName: string; workers: Worker[]; routeTotalPositionMinor: Num; routeTotalAvailableMinor: Num }
interface Settlement {
  id: string; routeId: string; workerId: string; cycleNo: Num; version: Num; expectedPositionMinor: Num; expectedCashMinor: Num; deliveredMinor: Num;
  differenceMinor: Num; shortageMinor: Num; surplusMinor: Num; returnedToPoolMinor: Num; carriedAfterMinor: Num; negativePositionMinor: Num;
  result: 'exacto' | 'faltante' | 'sobrante'; reason: string | null; status: 'cerrada' | 'reabierta'; supersededBy: string | null; businessDate: string;
  closedAt: string; closedBy: string; reopenReason: string | null;
}

const RESULT: Record<string, [string, 'ok' | 'warn' | 'bad' | 'info']> = { exacto: ['Cuadre exacto', 'ok'], faltante: ['Faltante', 'bad'], sobrante: ['Sobrante', 'warn'] };
const MIN_REASON = 10;

/** El servidor aún no tiene este módulo (frontend publicado antes que la API). */
function notDeployed(e: unknown): boolean {
  return e instanceof ApiFailure && e.code === 'NOT_FOUND' && e.status === 404;
}

export function Settlements() {
  const { can, role, membershipId } = useCtx();
  const routes = useRoutes();
  const manage = can('cashSettlement.view');
  const [routeId, setRouteId] = useState('');
  const [version, setVersion] = useState(0);
  const list = routes.data ?? [];
  const route = list.find((r) => r.id === (routeId || list[0]?.id));
  return (
    <>
      <Section title={manage ? 'Cuadres de efectivo' : 'Mi cuadre'} actions={<Refresh r={routes} />}>
        <p className="muted small">
          El servidor calcula lo que cada persona debe tener: arrastre o negativo anterior + Base recibida − entregas parciales + cobros − desembolsos − gastos.
          Cuadrar no cierra la semana; una entrega parcial no cierra el cuadre.
        </p>
        {list.length ? (
          <Field label="Ruta"><select value={route?.id ?? ''} onChange={(e) => setRouteId(e.target.value)}>
            {list.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        ) : <p className="muted">Sin rutas asignadas.</p>}
      </Section>
      {route ? (manage ? <RouteWorkers route={route} version={version} onDone={() => setVersion((v) => v + 1)} />
        : <OwnCycle route={route} />) : null}
      {route ? <History route={route} version={version} canReopen={can('cashSettlement.reopen') && (role === 'superadmin' || route.capitalControllerId === membershipId)} onDone={() => setVersion((v) => v + 1)} /> : null}
    </>
  );
}

function OwnCycle({ route }: { route: RouteView }) {
  const { client } = useApp();
  const { membershipId } = useCtx();
  const p = useResource(() => client.get<Preview>(`/v1/settlements/preview?routeId=${encodeURIComponent(route.id)}&workerId=${encodeURIComponent(membershipId)}`), [route.id]);
  return (
    <Section title={`Mi efectivo en ${route.name}`} actions={<Refresh r={p} />}>
      {p.error && notDeployed(p.error) ? <p className="muted">El servidor todavía no tiene el módulo de cuadres.</p> : (
        <Loaded r={p}>{(x) => <PreviewCard p={x} />}</Loaded>
      )}
      <p className="muted small">Su cuadre lo cierra otra persona autorizada (nunca uno mismo).</p>
    </Section>
  );
}

function RouteWorkers({ route, version, onDone }: { route: RouteView; version: number; onDone: () => void }) {
  const { client } = useApp();
  const w = useResource(() => client.get<Workers>(`/v1/settlements/workers?routeId=${encodeURIComponent(route.id)}`), [route.id, version]);
  const [selected, setSelected] = useState('');
  return (
    <Section title={`Trabajadores con efectivo en ${route.name}`} actions={<Refresh r={w} />}>
      {w.error && notDeployed(w.error) ? <p className="muted">El servidor todavía no tiene el módulo de cuadres.</p> : (
        <Loaded r={w} empty={(d) => d.workers.length === 0}>
          {(d) => (
            <>
              <table className="table">
                <thead><tr><th>Persona</th><th className="right">Posición</th><th className="right">Faltante arrastrado</th><th className="right">Efectivo disponible</th><th /></tr></thead>
                <tbody>{d.workers.map((x) => (
                  <tr key={x.workerId}>
                    <td>{x.name} <span className="muted small">({ROLE[x.role] ?? x.role}{x.assigned ? '' : ' · ya no asignado'}{x.status !== 'activo' ? ' · inactivo' : ''})</span></td>
                    <td className="right"><Money minor={x.positionMinor} /></td>
                    <td className="right">{x.carriedMinor ? <Money minor={x.carriedMinor} /> : '—'}</td>
                    <td className="right"><Money minor={x.availableMinor} /></td>
                    <td className="right">{x.own ? <span className="muted small">Lo cuadra otra persona</span>
                      : <button className="ghost" onClick={() => setSelected(x.workerId)}>Cuadrar</button>}</td>
                  </tr>))}
                </tbody>
                <tfoot><tr><td><strong>Total de la ruta</strong> <span className="muted small">(solo suma: no es una caja)</span></td>
                  <td className="right"><strong><Money minor={d.routeTotalPositionMinor} /></strong></td><td /><td className="right"><Money minor={d.routeTotalAvailableMinor} /></td><td /></tr></tfoot>
              </table>
              {selected ? <SettleForm key={selected} route={route} workerId={selected} onClose={() => setSelected('')} onDone={() => { void w.reload(); onDone(); }} /> : null}
            </>
          )}
        </Loaded>
      )}
    </Section>
  );
}

function PreviewCard({ p }: { p: Preview }) {
  const c = p.cycle;
  const rows: [string, Num, 1 | -1][] = [
    ['Arrastre o negativo anterior', c.openingMinor, 1], ['Base recibida', c.baseDeliveredMinor, 1], ['Traspasos recibidos', c.transfersInMinor, 1],
    ['Entregas parciales', c.partialReturnsMinor, -1], ['Traspasos entregados', c.transfersOutMinor, -1], ['Cobros en efectivo', c.collectedMinor, 1],
    ['Desembolsos', c.disbursedMinor, -1], ['Gastos', c.expensesMinor, -1], ['Reaperturas y otros', c.reopenedSettlementsMinor + c.otherMinor, 1],
  ];
  return (
    <>
      <table className="table">
        <tbody>
          {rows.filter(([, v], i) => v !== 0 || i === 0).map(([label, v, sign]) => (
            <tr key={label}><td>{label}</td><td className="right">{sign < 0 && v ? '− ' : ''}<Money minor={v} /></td></tr>))}
          <tr><td><strong>Posición esperada</strong></td><td className="right"><strong><Money minor={p.expectedPositionMinor} /></strong></td></tr>
          <tr><td><strong>Efectivo que debe entregar</strong></td><td className="right"><strong><Money minor={p.expectedCashMinor} /></strong></td></tr>
        </tbody>
      </table>
      {p.carriedMinor ? <p className="msg warn">Faltante arrastrado <Money minor={p.carriedMinor} />: es una deuda, no efectivo. No se entrega por partes, no se presta ni se traspasa; se repone al cuadrar.</p> : null}
      {p.negativePositionMinor < 0 ? <p className="msg warn">Posición negativa (<Money minor={p.negativePositionMinor} />) por gastos pagados de su bolsillo: no hay efectivo que entregar. Sigue al ciclo siguiente y la compensan los movimientos posteriores; el reembolso no es automático.</p> : null}
      <p className="muted small">Desde {p.previousClosedAt ? `el cuadre del ${date(p.previousClosedAt)}` : 'el inicio'} · {c.entries} movimientos · fecha contable {date(p.businessDate)} ({p.timezone}).</p>
    </>
  );
}

function SettleForm({ route, workerId, onClose, onDone }: { route: RouteView; workerId: string; onClose: () => void; onDone: () => void }) {
  const { client } = useApp();
  const { company } = useCtx();
  const p = useResource(() => client.get<Preview>(`/v1/settlements/preview?routeId=${encodeURIComponent(route.id)}&workerId=${encodeURIComponent(workerId)}`), [route.id, workerId], 0);
  const [delivered, setDelivered] = useState('');
  const [reason, setReason] = useState('');
  const [partial, setPartial] = useState('');
  const action = useAction();
  const partialAction = useAction();
  const dMinor = /^0+([.,]0*)?$/.test(delivered.trim()) ? 0 : parseMoney(delivered, company.minorUnits);
  const diff = p.data && dMinor !== null ? dMinor - p.data.expectedCashMinor : null;
  const fmt = (m: Num) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: company.currencyCode }).format(m / 10 ** company.minorUnits);

  async function settle(e: FormEvent) {
    e.preventDefault();
    if (!p.data || dMinor === null) return action.setMessage({ kind: 'error', text: 'Indique el efectivo entregado ahora (0 o más).' });
    if (diff !== 0 && reason.trim().length < MIN_REASON) return action.setMessage({ kind: 'error', text: `Hay ${diff! < 0 ? 'faltante' : 'sobrante'}: explique el motivo (mínimo ${MIN_REASON} caracteres).` });
    const body = { routeId: route.id, workerId, deliveredMinor: dMinor, expectedSeenMinor: p.data.expectedPositionMinor,
      previousSettlementId: p.data.previousSettlementId, ...(reason.trim() ? { reason: reason.trim() } : {}) };
    const r = await action.run(() => client.command<{ settlement: Settlement }>('POST', '/v1/settlements', body),
      (v) => `${RESULT[v.settlement.result]![0]}. A la bolsa: ${fmt(v.settlement.returnedToPoolMinor)}.`);
    if (r) { setDelivered(''); setReason(''); onDone(); void p.reload(); }
  }
  // Tras un rechazo por cifras obsoletas, se relee la vista previa del servidor.
  const stale = action.message?.kind === 'error' && action.message.text === errorText({ code: 'SETTLEMENT_STALE' });

  async function giveBack(e: FormEvent) {
    e.preventDefault();
    const amountMinor = parseMoney(partial, company.minorUnits);
    if (!amountMinor) return partialAction.setMessage({ kind: 'error', text: 'Indique el importe recibido.' });
    const r = await partialAction.run(() => client.command('POST', '/v1/capital/returns', { routeId: route.id, workerId, amountMinor, reason: 'Entrega parcial antes del cuadre' }),
      () => 'Entrega parcial registrada. El cuadre sigue abierto.');
    if (r) { setPartial(''); void p.reload(); onDone(); }
  }

  return (
    <div className="card inner">
      <header className="card-head"><h2>Cuadre de {p.data?.workerName ?? '…'}</h2><div className="card-actions"><Refresh r={p} /><button className="ghost" onClick={onClose}>Cerrar</button></div></header>
      <Loaded r={p}>
        {(x) => (
          <>
            <PreviewCard p={x} />
            {x.periodClosedToday ? <p className="msg error">El periodo de hoy está cerrado en esta ruta: no se puede cuadrar.</p> : null}
            <form className="form" onSubmit={(e) => void giveBack(e)}>
              <div className="row">
                <Field label="Entrega parcial (no cierra el cuadre)" hint={`Hasta el efectivo disponible: ${fmt(x.availableMinor)}`}>
                  <input inputMode="decimal" value={partial} onChange={(e) => setPartial(e.target.value)} placeholder="0,00" /></Field>
                <button disabled={partialAction.busy || x.availableMinor <= 0}>Registrar entrega parcial</button>
              </div>
              <ActionMessage action={partialAction} onResolved={() => void p.reload()} />
            </form>
            <form className="form" onSubmit={(e) => void settle(e)}>
              <div className="row">
                <Field label="Efectivo que entrega AHORA" hint="Las entregas parciales ya registradas no se vuelven a contar.">
                  <input inputMode="decimal" required value={delivered} onChange={(e) => setDelivered(e.target.value)} placeholder="0,00" /></Field>
                <div className="stat"><span className="muted small">Diferencia (orientativa)</span>
                  <strong>{diff === null ? '—' : <Money minor={diff} />}</strong>
                  {diff !== null && diff !== 0 ? <Badge tone={diff < 0 ? 'bad' : 'warn'}>{diff < 0 ? 'Faltante: quedará arrastrado' : 'Sobrante: queda en control, no es capital'}</Badge> : null}
                </div>
              </div>
              {diff !== null && diff !== 0 ? <Field label={`Motivo de la diferencia (mínimo ${MIN_REASON} caracteres)`}><input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></Field> : null}
              <button className="primary" disabled={action.busy || x.periodClosedToday}>Cerrar cuadre</button>
              <ActionMessage action={action} onResolved={onDone} />
              {stale ? <button className="link" onClick={(e) => { e.preventDefault(); void p.reload(); action.setMessage(null); }}>Ver las cifras nuevas</button> : null}
            </form>
          </>
        )}
      </Loaded>
    </div>
  );
}

function History({ route, version, canReopen, onDone }: { route: RouteView; version: number; canReopen: boolean; onDone: () => void }) {
  const { client } = useApp();
  const { can } = useCtx();
  const list = useResource(async () => (await client.get<{ settlements: Settlement[] }>(`/v1/settlements?routeId=${encodeURIComponent(route.id)}&limit=100`)).settlements, [route.id, version]);
  const workers = useResource(async () => (can('cashSettlement.view') ? (await client.get<Workers>(`/v1/settlements/workers?routeId=${encodeURIComponent(route.id)}`)).workers : []), [route.id, version], 0);
  const action = useAction();
  const [open, setOpen] = useState('');
  const [reason, setReason] = useState('');
  const who = (id: string) => (workers.data ?? []).find((w) => w.workerId === id)?.name ?? 'Usted';
  const latest = new Map<string, string>();
  for (const s of list.data ?? []) if (s.status === 'cerrada' && !latest.has(s.workerId)) latest.set(s.workerId, s.id);
  async function reopen(s: Settlement) {
    const r = await action.run(() => client.command('POST', `/v1/settlements/${s.id}/reopen`, { reason: reason.trim() }), () => 'Cuadre reabierto: el efectivo volvió a la custodia del trabajador.');
    if (r) { setOpen(''); setReason(''); onDone(); }
  }
  return (
    <Section title="Historial de cuadres" actions={<Refresh r={list} />}>
      <ActionMessage action={action} onResolved={onDone} />
      {list.error && notDeployed(list.error) ? <p className="muted">El servidor todavía no tiene el módulo de cuadres.</p> : (
        <Loaded r={list} empty={(d) => d.length === 0}>
          {(d) => (
            <ul className="list">
              {d.map((s) => {
                const [label, tone] = RESULT[s.result]!;
                return (
                  <li key={s.id}><div className="row-static">
                    <strong>{who(s.workerId)} · <Badge tone={tone}>{label}</Badge>{s.status === 'reabierta' ? <> <Badge>Reabierto</Badge></> : null} <span className="muted small">v{s.version}</span></strong>
                    <span className="muted small">{date(s.closedAt)} · esperado <Money minor={s.expectedCashMinor} /> · entregado <Money minor={s.deliveredMinor} /> · a la bolsa <Money minor={s.returnedToPoolMinor} />
                      {s.shortageMinor ? <> · faltante <Money minor={s.shortageMinor} /></> : null}{s.surplusMinor ? <> · sobrante <Money minor={s.surplusMinor} /></> : null}
                      {s.negativePositionMinor < 0 ? <> · negativo que sigue <Money minor={s.negativePositionMinor} /></> : null}
                      {s.reason ? ` · ${s.reason}` : ''}{s.reopenReason ? ` · reabierto: ${s.reopenReason}` : ''}</span>
                    {canReopen && latest.get(s.workerId) === s.id ? (open === s.id ? (
                      <div className="row">
                        <Field label={`Motivo de la reapertura (mínimo ${MIN_REASON})`}><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                        <button className="danger" disabled={action.busy || reason.trim().length < MIN_REASON} onClick={() => void reopen(s)}>Confirmar reapertura</button>
                        <button className="ghost" onClick={() => setOpen('')}>Cancelar</button>
                      </div>
                    ) : <div className="row"><button className="ghost" onClick={() => setOpen(s.id)}>Reabrir</button></div>) : null}
                  </div></li>
                );
              })}
            </ul>
          )}
        </Loaded>
      )}
    </Section>
  );
}

// ============================================================
// Cierres de periodo y liquidación
// ============================================================
interface Calendar { businessDate: string; timezone: string; suggested: { weekStart: string; weekEnd: string } }
interface Flows { openingMinor: Num; deliveriesMinor: Num; transfersInMinor: Num; transfersOutMinor: Num; partialReturnsMinor: Num; settlementReturnsMinor: Num; collectionsMinor: Num; disbursementsMinor: Num; workerExpensesMinor: Num; closingMinor: Num }
interface Liquidation {
  routeName: string; from: string; to: string; businessDate: string; timezone: string; ended: boolean; closable: boolean;
  custody: Flows; workers: (Flows & { workerId: string; name: string; role: string })[];
  pool: { collectionsReceivedMinor: Num; deliveredToWorkersMinor: Num; returnsReceivedMinor: Num; routeExpensesMinor: Num; disbursedFromPoolMinor: Num; surplusHeldMinor: Num };
  credit: { principalDisbursedMinor: Num; principalCollectedMinor: Num; interestCollectedMinor: Num; expensesMinor: Num };
  settlements: { count: Num; deliveredMinor: Num; shortageMinor: Num; surplusMinor: Num };
  operations: { count: Num; hash: string };
  closures: { id: string; weekStart: string; weekEnd: string; status: string; version: Num; closedAt: string | null; archived: boolean }[];
}
interface Closure { id: string; routeId: string; weekStart: string; weekEnd: string; status: string; version: Num; closedAt: string | null; openingMinor: Num; closingMinor: Num; archived: boolean; businessDate: string | null; note: string | null }

export function Periods() {
  const { client } = useApp();
  const { can, role, membershipId } = useCtx();
  const routes = useRoutes();
  const cal = useResource(() => client.get<Calendar>('/v1/periods/calendar'), [], 60_000);
  const [routeId, setRouteId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [version, setVersion] = useState(0);
  const list = routes.data ?? [];
  const route = list.find((r) => r.id === (routeId || list[0]?.id));
  const start = from || cal.data?.suggested.weekStart || '';
  const end = to || cal.data?.suggested.weekEnd || '';
  const liq = useResource(async () => (route && start && end
    ? client.get<Liquidation>(`/v1/periods/liquidation?routeId=${encodeURIComponent(route.id)}&from=${start}&to=${end}`) : null), [route?.id, start, end, version], 0);
  const closures = useResource(async () => (route ? (await client.get<{ closures: Closure[] }>(`/v1/periods?routeId=${encodeURIComponent(route.id)}`)).closures : []), [route?.id, version], 0);
  const action = useAction();
  const [note, setNote] = useState('');
  const mayClose = can('settlement.close') && (role === 'superadmin' || route?.capitalControllerId === membershipId);
  async function close() {
    if (!route) return;
    const r = await action.run(() => client.command('POST', '/v1/periods/close', { routeId: route.id, weekStart: start, weekEnd: end, ...(note.trim() ? { note: note.trim() } : {}) }),
      () => `Periodo ${start} a ${end} cerrado y archivado.`);
    if (r) { setNote(''); setVersion((v) => v + 1); }
  }
  if (cal.error && notDeployed(cal.error)) return <Section title="Cierres y liquidación"><p className="muted">El servidor todavía no tiene el módulo de cierres.</p></Section>;
  return (
    <>
      <Section title="Cierres y liquidación" actions={<Refresh r={liq} />}>
        <Loaded r={cal}>{(c) => <p className="muted small">Fecha contable de la empresa: <strong>{date(c.businessDate)}</strong> ({c.timezone}). Solo se cierra un periodo ya terminado; lo cerrado no cambia: los ajustes van al periodo abierto.</p>}</Loaded>
        <div className="row">
          <Field label="Ruta"><select value={route?.id ?? ''} onChange={(e) => setRouteId(e.target.value)}>{list.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
          <Field label="Desde"><input type="date" value={start} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Hasta"><input type="date" value={end} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <Loaded r={liq}>
          {(l) => (l ? (
            <>
              <h3>Efectivo en manos de trabajadores (ruta {nameOf(list, route?.id)})</h3>
              <table className="table">
                <thead><tr><th>Persona</th><th className="right">Inicial</th><th className="right">Base</th><th className="right">Cobros</th><th className="right">Desembolsos</th><th className="right">Gastos</th><th className="right">Entregas a la bolsa</th><th className="right">Final</th></tr></thead>
                <tbody>
                  {l.workers.map((w) => (
                    <tr key={w.workerId}><td>{w.name}</td><td className="right"><Money minor={w.openingMinor} /></td><td className="right"><Money minor={w.deliveriesMinor + w.transfersInMinor - w.transfersOutMinor} /></td>
                      <td className="right"><Money minor={w.collectionsMinor} /></td><td className="right"><Money minor={w.disbursementsMinor} /></td><td className="right"><Money minor={w.workerExpensesMinor} /></td>
                      <td className="right"><Money minor={w.partialReturnsMinor + w.settlementReturnsMinor} /></td><td className="right"><Money minor={w.closingMinor} /></td></tr>))}
                </tbody>
                <tfoot><tr><td><strong>Ruta (suma)</strong></td><td className="right"><Money minor={l.custody.openingMinor} /></td>
                  <td className="right"><Money minor={l.custody.deliveriesMinor + l.custody.transfersInMinor - l.custody.transfersOutMinor} /></td><td className="right"><Money minor={l.custody.collectionsMinor} /></td>
                  <td className="right"><Money minor={l.custody.disbursementsMinor} /></td><td className="right"><Money minor={l.custody.workerExpensesMinor} /></td>
                  <td className="right"><Money minor={l.custody.partialReturnsMinor + l.custody.settlementReturnsMinor} /></td><td className="right"><strong><Money minor={l.custody.closingMinor} /></strong></td></tr></tfoot>
              </table>
              <div className="stats">
                <div className="stat"><span className="muted small">Cobros recibidos en la bolsa</span><strong><Money minor={l.pool.collectionsReceivedMinor} /></strong></div>
                <div className="stat"><span className="muted small">Gastos de la ruta (bolsa)</span><strong><Money minor={l.pool.routeExpensesMinor} /></strong></div>
                <div className="stat"><span className="muted small">Capital prestado</span><strong><Money minor={l.credit.principalDisbursedMinor} /></strong></div>
                <div className="stat"><span className="muted small">Capital recuperado</span><strong><Money minor={l.credit.principalCollectedMinor} /></strong></div>
                <div className="stat"><span className="muted small">Interés cobrado</span><strong><Money minor={l.credit.interestCollectedMinor} /></strong></div>
                <div className="stat"><span className="muted small">Cuadres del periodo</span><strong>{l.settlements.count}</strong>
                  <span className="muted small">faltantes <Money minor={l.settlements.shortageMinor} /> · sobrantes <Money minor={l.settlements.surplusMinor} /></span></div>
              </div>
              <p className="muted small">{l.operations.count} operaciones del libro · huella {l.operations.hash.slice(0, 12)}…</p>
              {mayClose ? (
                <div className="row">
                  <Field label="Nota del cierre (opcional)"><input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
                  <button className="primary" disabled={action.busy || !l.closable} onClick={() => void close()}>Cerrar periodo</button>
                  {!l.ended ? <span className="muted small">El periodo aún no termina.</span> : !l.closable ? <span className="muted small">Ya hay un cierre vigente en ese rango.</span> : null}
                </div>
              ) : null}
              <ActionMessage action={action} onResolved={() => setVersion((v) => v + 1)} />
            </>
          ) : null)}
        </Loaded>
      </Section>
      <Section title="Periodos cerrados" actions={<Refresh r={closures} />}>
        <Loaded r={closures} empty={(d) => d.length === 0}>
          {(d) => (
            <table className="table">
              <thead><tr><th>Periodo</th><th>Estado</th><th className="right">Inicial</th><th className="right">Final</th><th>Cerrado</th></tr></thead>
              <tbody>{d.map((c) => (
                <tr key={c.id}><td>{date(c.weekStart)} – {date(c.weekEnd)} <span className="muted small">v{c.version}</span></td>
                  <td><Badge tone={c.status === 'cerrada' ? 'ok' : 'neutral'}>{c.status === 'cerrada' ? 'Cerrado' : c.status === 'reabierta' ? 'Reabierto' : 'Abierto'}</Badge>{c.archived ? null : <span className="muted small"> · importado</span>}</td>
                  <td className="right"><Money minor={c.openingMinor} /></td><td className="right"><Money minor={c.closingMinor} /></td>
                  <td className="muted small">{date(c.closedAt)}{c.note ? ` · ${c.note}` : ''}</td></tr>))}
              </tbody>
            </table>
          )}
        </Loaded>
      </Section>
    </>
  );
}
