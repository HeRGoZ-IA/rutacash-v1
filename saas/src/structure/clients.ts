// CLIENTES (ClientsPage, CollectorNewClientPage y SecretarioClientsPage de CLEAN →
// comandos). Sin crédito: el alta de cliente CON venta es un comando de la Fase 4.
//
//   · Alta: `client.create` en una ruta autorizada que admita operaciones nuevas
//     (activa y sin Oficina inactiva). Obligatorios, como en CLEAN: nombre, documento,
//     teléfono, dirección de residencia y dirección de cobro/negocio.
//   · DS-10: tipo de documento del catálogo del país de la empresa y número; la
//     unicidad (empresa, tipo, número normalizado) la impone PostgreSQL. El documento
//     original se guarda tal cual; nunca se fusiona ni se inventa uno.
//   · Edición completa: `client.edit`. Edición limitada (Secretario):
//     `client.editLimited`, solo datos operativos (también lo impone un disparador).
//   · Estado: `client.deactivate` (activo ↔ inactivo). `moroso` y `perdido` los
//     derivan los comandos financieros, no se fijan a mano.
//   · DS-11: borrado físico solo sin historia (sin solicitudes, ventas, pagos, visitas…).
//     Con historia: desactivar.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { allowed, routeUnrestricted } from '../authz/cleanRules.ts';
import { audit } from '../db/audit.ts';
import { need } from './common.ts';
import { has, oneOf, optText, pathId, reqId, reqText } from './input.ts';

interface Row {
  id: string; route_id: string; name: string; document: string; document_type: string | null; document_normalized: string | null;
  phone_primary: string; phone_secondary: string | null; address_primary: string; address_secondary: string | null;
  business: string | null; document_photo_url: string | null; business_photo_url: string | null; status: string; notes: string | null;
  created_at: Date; updated_at: Date;
}
const COLS = `id, route_id, name, document, document_type, document_normalized, phone_primary, phone_secondary, address_primary,
              address_secondary, business, document_photo_url, business_photo_url, status, notes, created_at, updated_at`;

function view(r: Row) {
  return {
    id: r.id, routeId: r.route_id, name: r.name, documentType: r.document_type, document: r.document, documentNormalized: r.document_normalized,
    phonePrimary: r.phone_primary, phoneSecondary: r.phone_secondary, addressPrimary: r.address_primary, addressSecondary: r.address_secondary,
    business: r.business, documentPhotoUrl: r.document_photo_url, businessPhotoUrl: r.business_photo_url, status: r.status, notes: r.notes,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

// Columna ← campo de la API. LIMITED = lo que edita el Secretario (`EDITABLE_FIELDS`).
const TEXT_FIELDS: Record<string, { col: keyof Row; required: boolean; max: number }> = {
  name: { col: 'name', required: true, max: 160 },
  phonePrimary: { col: 'phone_primary', required: true, max: 40 },
  phoneSecondary: { col: 'phone_secondary', required: false, max: 40 },
  addressPrimary: { col: 'address_primary', required: true, max: 300 },
  addressSecondary: { col: 'address_secondary', required: true, max: 300 },
  business: { col: 'business', required: false, max: 160 },
  notes: { col: 'notes', required: false, max: 1000 },
  documentPhotoUrl: { col: 'document_photo_url', required: false, max: 2048 },
  businessPhotoUrl: { col: 'business_photo_url', required: false, max: 2048 },
};
const LIMITED = new Set(['name', 'phonePrimary', 'phoneSecondary', 'addressPrimary', 'addressSecondary', 'business', 'notes']);
export const CLIENT_FIELDS = ['routeId', 'documentType', 'document', ...Object.keys(TEXT_FIELDS)];

/** Fotos: referencia a almacenamiento (https). Subir archivos no es de esta fase. */
function photo(v: string | null): string | null {
  if (v !== null && !/^https:\/\/[^\s]+$/.test(v)) throw new ApiError(400, 'INVALID_INPUT', 'photo must be an https URL', { field: 'photo' });
  return v;
}

async function load(client: pg.PoolClient, ctx: ActiveContext, id: string, lock = false): Promise<Row> {
  const sql = `select ${COLS} from adex.clients where company_id = $1 and id = $2`;
  const row = (await client.query<Row>(sql, [ctx.companyId, pathId(id)])).rows[0];
  // Fuera del alcance de rutas = inexistente (RLS ya lo filtra; el filtro de CLEAN también).
  if (!row || (!routeUnrestricted(ctx) && !ctx.routeIds.includes(row.route_id))) throw new ApiError(404, 'NOT_FOUND');
  if (!lock) return row;
  // FOR UPDATE exige la política de UPDATE: quien solo puede ver el cliente no lo
  // bloquea y recibe 403 de la comprobación de capacidad que sigue, no un 404.
  return (await client.query<Row>(`${sql} for update`, [ctx.companyId, row.id])).rows[0] ?? row;
}

/** Una escritura que RLS filtra afecta 0 filas sin error: se exige exactamente 1. */
function exactlyOne(r: pg.QueryResult): void {
  if (r.rowCount !== 1) throw new ApiError(403, 'PERMISSION_DENIED');
}

async function assertRouteOperational(client: pg.PoolClient, ctx: ActiveContext, routeId: string): Promise<void> {
  const r = await client.query<{ exists: boolean; operational: boolean }>(
    'select exists (select 1 from adex.routes where company_id = $1 and id = $2) as exists, adex.route_operational($1, $2) operational', [ctx.companyId, routeId]);
  if (!r.rows[0]!.exists) throw new ApiError(404, 'ROUTE_NOT_FOUND');
  if (!r.rows[0]!.operational) throw new ApiError(409, 'ROUTE_NOT_OPERATIONAL');
}

export async function documentTypes(client: pg.PoolClient, ctx: ActiveContext) {
  const r = await client.query<{ code: string; label: string; normalization: string; min_length: number; max_length: number }>(
    'select code, label, normalization, min_length, max_length from adex.document_types where country_code = $1 order by code', [ctx.company.countryCode]);
  return r.rows.map((t) => ({ code: t.code, label: t.label, normalization: t.normalization, minLength: t.min_length, maxLength: t.max_length }));
}

export async function listClients(client: pg.PoolClient, ctx: ActiveContext, query: URLSearchParams) {
  need(ctx, 'client.view');
  const routeId = query.get('routeId');
  if (routeId !== null) need(ctx, 'client.view', { routeId: pathId(routeId) });
  const limit = Math.min(Math.max(Number(query.get('limit') ?? 200) || 200, 1), 1000);
  const offset = Math.max(Number(query.get('offset') ?? 0) || 0, 0);
  const r = await client.query<Row>(
    `select ${COLS} from adex.clients where company_id = $1 and ($2::text is null or route_id = $2)
      order by lower(name), id limit $3 offset $4`, [ctx.companyId, routeId, limit, offset]);
  return r.rows.filter((x) => routeUnrestricted(ctx) || ctx.routeIds.includes(x.route_id)).map(view);
}

export async function getClient(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  need(ctx, 'client.view');
  return view(await load(client, ctx, id));
}

export async function createClient(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>) {
  const routeId = reqId(body, 'routeId');
  need(ctx, 'client.create', { routeId });
  const values: Record<string, string | null> = {};
  for (const [field, f] of Object.entries(TEXT_FIELDS)) values[f.col] = f.required ? reqText(body, field, f.max) : optText(body, field, f.max);
  values['document_photo_url'] = photo(values['document_photo_url']!);
  values['business_photo_url'] = photo(values['business_photo_url']!);
  const documentType = reqText(body, 'documentType', 16).toUpperCase();
  const document = reqText(body, 'document', 40);
  await assertRouteOperational(client, ctx, routeId);
  const id = randomUUID();
  await client.query(
    `insert into adex.clients (id, company_id, route_id, name, document, document_type, phone_primary, phone_secondary, address_primary,
                               address_secondary, business, document_photo_url, business_photo_url, status, notes, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'activo', $14, now(), now())`,
    [id, ctx.companyId, routeId, values['name'], document, documentType, values['phone_primary'], values['phone_secondary'], values['address_primary'],
      values['address_secondary'], values['business'], values['document_photo_url'], values['business_photo_url'], values['notes']]);
  const row = await load(client, ctx, id);
  await audit(client, ctx, { action: 'CREATE_CLIENT', entityType: 'client', entityId: id, routeId, description: `Cliente creado: ${row.name}`,
    after: { routeId, documentType, documentNormalized: row.document_normalized } });
  return view(row);
}

export async function updateClient(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>) {
  const prev = await load(client, ctx, id, true);
  const full = allowed(ctx, 'client.edit', { routeId: prev.route_id });
  if (!full) {
    need(ctx, 'client.editLimited', { routeId: prev.route_id });
    const extra = Object.keys(body).filter((k) => !LIMITED.has(k));
    if (extra.length) throw new ApiError(403, 'PERMISSION_DENIED', `limited edit cannot change ${extra.join(', ')}`);
  }
  const next: Record<string, string | null> = {};
  for (const [field, f] of Object.entries(TEXT_FIELDS)) {
    if (has(body, field)) next[f.col] = f.required ? reqText(body, field, f.max) : optText(body, field, f.max);
  }
  if ('document_photo_url' in next) photo(next['document_photo_url']!);
  if ('business_photo_url' in next) photo(next['business_photo_url']!);
  if (has(body, 'document') || has(body, 'documentType')) {
    // Cambiar el documento exige declarar su tipo (DS-10), también en clientes importados sin tipo.
    next['document'] = has(body, 'document') ? reqText(body, 'document', 40) : prev.document;
    next['document_type'] = reqText(body, 'documentType', 16).toUpperCase();
  }
  if (has(body, 'routeId')) {
    const routeId = reqId(body, 'routeId');
    if (routeId !== prev.route_id) {
      need(ctx, 'client.edit', { routeId });
      await assertRouteOperational(client, ctx, routeId);
      next['route_id'] = routeId;
    }
  }
  const changed = Object.keys(next).filter((c) => next[c] !== (prev as unknown as Record<string, unknown>)[c]);
  if (!changed.length) return view(prev);
  exactlyOne(await client.query(`update adex.clients set ${changed.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = now() where company_id = $1 and id = $2`,
    [ctx.companyId, prev.id, ...changed.map((c) => next[c])]));
  const row = (await client.query<Row>(`select ${COLS} from adex.clients where company_id = $1 and id = $2`, [ctx.companyId, prev.id])).rows[0]!;
  await audit(client, ctx, {
    action: 'UPDATE_CLIENT', entityType: 'client', entityId: prev.id, routeId: row.route_id,
    description: full ? `Cliente actualizado: ${row.name}` : `Edición limitada de datos operativos de ${prev.name}`,
    before: Object.fromEntries(changed.map((c) => [c, (prev as unknown as Record<string, unknown>)[c] ?? null])),
    after: Object.fromEntries(changed.map((c) => [c, next[c]])),
  });
  return view(row);
}

export async function setClientStatus(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>) {
  const status = oneOf(body, 'status', ['activo', 'inactivo'] as const);
  const prev = await load(client, ctx, id, true);
  need(ctx, 'client.deactivate', { routeId: prev.route_id });
  if (status === 'activo' && prev.status !== 'inactivo' && prev.status !== 'activo') {
    throw new ApiError(409, 'STATUS_IS_DERIVED', `status ${prev.status} is set by financial commands`);
  }
  if (prev.status !== status) {
    exactlyOne(await client.query('update adex.clients set status = $3, updated_at = now() where company_id = $1 and id = $2', [ctx.companyId, prev.id, status]));
    await audit(client, ctx, { action: 'BLOCK_CLIENT', entityType: 'client', entityId: prev.id, routeId: prev.route_id,
      description: `Cliente ${status}: ${prev.name}`, before: { status: prev.status }, after: { status } });
  }
  return view({ ...prev, status });
}

export async function deleteClient(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  const prev = await load(client, ctx, id, true);
  // Borrado físico: además de poder desactivar, poder editar por completo (Administrador/SuperAdmin).
  need(ctx, 'client.deactivate', { routeId: prev.route_id });
  need(ctx, 'client.edit', { routeId: prev.route_id });
  const refs = (await client.query<{ refs: string[] }>("select adex.protected_references('adex.clients'::regclass, $1, $2) refs", [ctx.companyId, prev.id])).rows[0]!.refs;
  if (refs.length) throw new ApiError(409, 'HAS_HISTORY', 'the client has history: deactivate it instead', { references: refs });
  exactlyOne(await client.query('delete from adex.clients where company_id = $1 and id = $2', [ctx.companyId, prev.id]));
  // Sin `route_id`: la auditoría no debe convertirse en «historia» de la ruta por un borrado.
  await audit(client, ctx, { action: 'DELETE_CLIENT', entityType: 'client', entityId: prev.id, description: `Cliente eliminado: ${prev.name}`,
    before: { routeId: prev.route_id, name: prev.name, documentType: prev.document_type, documentNormalized: prev.document_normalized } });
  return { deleted: prev.id };
}
