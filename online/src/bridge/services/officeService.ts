// PUENTE de `src/services/officeService.ts` (CLEAN): las escrituras de Oficinas van a la
// API (que valida unicidad, permisos por ruta y audita en la misma transacción). Las
// lecturas y resúmenes originales se conservan: leen la proyección del servidor.

import type { Office, User } from '@clean/models/types';
import { money, plain } from '../../runtime/commands.ts';
import { officeFrom } from '../../runtime/mappers.ts';
import { table } from '../../runtime/projection.ts';
import { generateId } from '@/lib/utils';

export * from '@clean/services/officeService';
import * as Clean from '@clean/services/officeService';

const code = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : null);

async function createOfficeOnline(params: { tenantId: string; nombre: string; codigo?: string }, _actor: User): Promise<Office> {
  return officeFrom(await money<Record<string, unknown>>('POST', '/v1/offices', { name: params.nombre, code: code(params.codigo) }, generateId()));
}

async function updateOfficeOnline(params: { officeId: string; tenantId: string; nombre: string; codigo?: string }, _actor: User): Promise<void> {
  await plain('PATCH', `/v1/offices/${params.officeId}`, { name: params.nombre, code: code(params.codigo) });
}

async function setOfficeStatusOnline(params: { officeId: string; tenantId: string; status: 'activa' | 'inactiva' }, _actor: User): Promise<void> {
  await plain('POST', `/v1/offices/${params.officeId}/status`, { status: params.status });
}

async function deleteOfficeOnline(params: { officeId: string; tenantId: string; detachRoutes?: boolean }, _actor: User): Promise<{ detached: string[] }> {
  const r = await plain<{ detached?: string[] }>('POST', `/v1/offices/${params.officeId}/delete`, { detachRoutes: params.detachRoutes === true });
  return { detached: r.detached ?? [] };
}

async function moveRouteToOfficeOnline(params: { routeId: string; tenantId: string; officeId?: string }, _actor: User): Promise<void> {
  await plain('POST', '/v1/offices/assign-routes', { officeId: params.officeId ?? null, routeIds: [params.routeId] });
}

async function detachRouteFromOfficeOnline(params: { routeId: string; tenantId: string }, actor: User): Promise<void> {
  await moveRouteToOfficeOnline({ ...params, officeId: undefined }, actor);
}

async function assignRoutesToOfficeOnline(params: { routeIds: string[]; tenantId: string; officeId?: string }, _actor: User): Promise<{ moved: string[] }> {
  if (params.routeIds.length === 0) return { moved: [] };
  const r = await plain<{ moved?: string[] }>('POST', '/v1/offices/assign-routes', { officeId: params.officeId ?? null, routeIds: params.routeIds });
  return { moved: r.moved ?? [] };
}

/**
 * Asignaciones de una persona decididas DESDE una Oficina. El servidor toca solo las rutas
 * de esa Oficina y conserva las demás (misma regla de CLEAN). Necesita el id de la Oficina,
 * que CLEAN no pasaba: se toma de las rutas de la Oficina mostradas.
 */
async function setUserOfficeRoutesOnline(
  params: { userId: string; tenantId: string; officeRouteIds: string[]; selectedRouteIds: string[] }, _actor: User,
): Promise<{ authorizedRouteIds: string[] }> {
  const routes = await table('routes');
  const officeId = routes.find((r) => params.officeRouteIds.includes(String(r['id'])) && r['officeId'])?.['officeId'];
  if (!officeId) return { authorizedRouteIds: [] };
  const r = await plain<{ routeIds?: string[] }>('PUT', `/v1/members/${params.userId}/office-routes`, { officeId, selectedRouteIds: params.selectedRouteIds });
  return { authorizedRouteIds: r.routeIds ?? [] };
}

// Firmas ORIGINALES de CLEAN (las pantallas y servicios originales las llaman así).
export const createOffice = createOfficeOnline as unknown as typeof Clean.createOffice;
export const updateOffice = updateOfficeOnline as unknown as typeof Clean.updateOffice;
export const setOfficeStatus = setOfficeStatusOnline as unknown as typeof Clean.setOfficeStatus;
export const deleteOffice = deleteOfficeOnline as unknown as typeof Clean.deleteOffice;
export const moveRouteToOffice = moveRouteToOfficeOnline as unknown as typeof Clean.moveRouteToOffice;
export const detachRouteFromOffice = detachRouteFromOfficeOnline as unknown as typeof Clean.detachRouteFromOffice;
export const assignRoutesToOffice = assignRoutesToOfficeOnline as unknown as typeof Clean.assignRoutesToOffice;
export const setUserOfficeRoutes = setUserOfficeRoutesOnline as unknown as typeof Clean.setUserOfficeRoutes;
