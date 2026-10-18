// Configuración de la empresa (`settings.access`: Super Admin y Administrador): datos de
// contacto editables y categorías de gasto. País, moneda, zona horaria, plan y estado
// los fija el plano Owner al crear la empresa: aquí solo se consultan.

import { useState, type FormEvent } from 'react';
import { useAction, useApp, useResource } from '../lib/app.tsx';
import { useIntent, useSynced } from '../lib/admin.ts';
import { ActionMessage, Badge, Confirm, Field, Loaded, Refresh, Section } from '../ui.tsx';

interface Company {
  id: string; name: string; legalName: string | null; taxId: string | null; email: string | null; phone: string | null; city: string | null;
  address: string | null; contactName: string | null; countryCode: string; countryLabel: string; currencyCode: string; timezone: string; plan: string; status: string;
}
interface Category { id: string; name: string; icon: string | null; active: boolean }

const EDITABLE = [
  ['name', 'Nombre comercial', true], ['legalName', 'Razón social', false], ['taxId', 'Identificación tributaria', false], ['email', 'Correo', true],
  ['phone', 'Teléfono', false], ['city', 'Ciudad', false], ['address', 'Dirección', false], ['contactName', 'Persona de contacto', false],
] as const;
type EditableKey = (typeof EDITABLE)[number][0];

export function Settings() {
  return (
    <>
      <CompanyData />
      <Categories />
    </>
  );
}

function CompanyData() {
  const { client, setCtx } = useApp();
  const company = useResource(async () => client.get<Company>('/v1/company'), [], 60_000);
  return (
    <Section title="Datos de la empresa" actions={<Refresh r={company} />}>
      <Loaded r={company}>
        {(c) => (
          <>
            <CompanyForm c={c} onSaved={async () => {
              await company.reload();
              // El nombre de la cabecera viene del contexto: se relee del servidor.
              try { setCtx(await client.context()); } catch { /* el cliente gestiona la pérdida de contexto */ }
            }} />
            <dl className="grid2 admin-block">
              <dt>País</dt><dd>{c.countryLabel} ({c.countryCode})</dd>
              <dt>Moneda</dt><dd>{c.currencyCode}</dd>
              <dt>Zona horaria</dt><dd>{c.timezone}</dd>
              <dt>Plan</dt><dd>{c.plan}</dd>
              <dt>Estado</dt><dd>{c.status}</dd>
            </dl>
            <p className="muted small">País, moneda y zona horaria se fijan al crear la empresa; el plan y el estado los administra la plataforma. No se modifican desde aquí.</p>
          </>
        )}
      </Loaded>
    </Section>
  );
}

function CompanyForm({ c, onSaved }: { c: Company; onSaved: () => Promise<void> }) {
  const { client } = useApp();
  const action = useAction();
  const server = Object.fromEntries(EDITABLE.map(([k]) => [k, c[k] ?? ''])) as Record<EditableKey, string>;
  const [f, setF] = useSynced(server);
  const changed = EDITABLE.map(([k]) => k).filter((k) => f[k].trim() !== server[k]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    // Solo los campos cambiados; vacío = borrar el dato opcional.
    const body = Object.fromEntries(changed.map((k) => [k, f[k].trim() || null]));
    const v = await action.run(() => client.send('PATCH', '/v1/company', body), () => 'Datos de la empresa guardados.');
    if (v) await onSaved();
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <div className="row">
        {EDITABLE.map(([k, label, required]) => (
          <Field key={k} label={label}>
            <input type={k === 'email' ? 'email' : 'text'} required={required} maxLength={200} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </Field>
        ))}
      </div>
      <div><button className="primary" disabled={action.busy || !changed.length}>Guardar datos</button></div>
      <ActionMessage action={action} />
    </form>
  );
}

function Categories() {
  const { client } = useApp();
  const categories = useResource(async () => (await client.get<{ categories: Category[] }>('/v1/expense-categories')).categories, [], 60_000);
  const action = useAction();
  const [name, setName] = useState('');
  const body = { name: name.trim() };
  const intent = useIntent(body);
  async function create(e: FormEvent) {
    e.preventDefault();
    const v = await action.run(() => client.command<Category>('POST', '/v1/expense-categories', body, intent.operationId), (x) => `Categoría creada: ${x.name}.`);
    if (v) { intent.confirmed(); setName(''); await categories.reload(); }
  }
  return (
    <Section title="Categorías de gasto" actions={<Refresh r={categories} />}>
      <form className="form" onSubmit={(e) => void create(e)}>
        <div className="row">
          <Field label="Nueva categoría"><input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div><button className="primary" disabled={action.busy}>Agregar</button></div>
        </div>
        <ActionMessage action={action} onResolved={() => { intent.confirmed(); setName(''); void categories.reload(); }} />
      </form>
      <Loaded r={categories} empty={(d) => d.length === 0}>
        {(list) => <ul className="list">{list.map((c) => <CategoryRow key={c.id} c={c} onChanged={categories.reload} />)}</ul>}
      </Loaded>
      <p className="muted small">Una categoría con gastos registrados no se puede eliminar: desactívela y dejará de ofrecerse al registrar gastos.</p>
    </Section>
  );
}

function CategoryRow({ c, onChanged }: { c: Category; onChanged: () => Promise<void> }) {
  const { client } = useApp();
  const action = useAction();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useSynced(c.name);
  const save = (patch: Partial<Category>, ok: string) => action.run(() => client.send('PATCH', `/v1/expense-categories/${c.id}`, patch), () => ok)
    .then((v) => { if (v) { setRenaming(false); return onChanged(); } });
  return (
    <li>
      <div className="row-static">
        <strong>{c.name}</strong>
        {c.active ? <Badge tone="ok">Activa</Badge> : <Badge tone="warn">Inactiva</Badge>}
        {renaming ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); void save({ name: name.trim() }, 'Nombre guardado.'); }}>
            <Field label="Nuevo nombre"><input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <button className="primary" disabled={action.busy || !name.trim() || name.trim() === c.name}>Guardar nombre</button>
            <button type="button" className="ghost" onClick={() => { setRenaming(false); setName(c.name); }}>Cancelar</button>
          </form>
        ) : (
          <div className="actions-row">
            <button disabled={action.busy} onClick={() => setRenaming(true)}>Renombrar</button>
            <button disabled={action.busy} onClick={() => void save({ active: !c.active }, c.active ? 'Categoría desactivada.' : 'Categoría activada.')}>{c.active ? 'Desactivar' : 'Activar'}</button>
            <Confirm label="Eliminar" disabled={action.busy} confirmLabel="Sí, eliminar"
              question={<>¿Eliminar la categoría <strong>{c.name}</strong>? Si tiene gastos, el servidor lo rechazará.</>}
              onConfirm={() => action.run(() => client.send('POST', `/v1/expense-categories/${c.id}/delete`), () => 'Categoría eliminada.').then((v) => v && onChanged())} />
          </div>
        )}
        <ActionMessage action={action} />
      </div>
    </li>
  );
}
