// PUENTE de `src/services/routeService.ts` (CLEAN): alta y edición de rutas con sus
// asignaciones. El servidor hace en UNA transacción lo mismo que CLEAN (datos, Oficina,
// Cobrador responsable, Administradores asignados, regla del primer Administrador y
// responsable de capital) y lo audita. Diferencias del servidor:
//   · el código de la ruta lo genera el servidor (con bloqueo, sin colisiones);
//   · no hay capital inicial: con capital centralizado la ruta no tiene caja propia.

import type { Route, User } from '@clean/models/types';
import type { CreateRouteInput, UpdateRouteInput } from '@clean/services/routeService';
import { money, OnlineCommandError, plain } from '../../runtime/commands.ts';
import { routeFrom, toMinor } from '../../runtime/mappers.ts';
import { generateId } from '@/lib/utils';

export * from '@clean/services/routeService';
import * as Clean from '@clean/services/routeService';

const text = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : null);

async function createRouteWithAdminsOnline(input: CreateRouteInput, _actor: User): Promise<Route> {
  if (input.capitalInicial > 0) {
    throw new OnlineCommandError('ROUTE_INITIAL_CAPITAL_NOT_ALLOWED',
      'Con capital centralizado la ruta no recibe capital inicial: el Administrador responsable entrega capital a sus trabajadores.');
  }
  const body: Record<string, unknown> = {
    name: input.nombre, city: text(input.ciudad), interestRate: input.tasaInteres, freeRate: input.tasaLibre,
    maxLoanMinor: toMinor(input.montoMaximoPrestamo ?? 0), officeId: input.officeId ?? null, adminIds: input.adminIds,
  };
  if (input.cobradorId) body['collectorId'] = input.cobradorId;
  const r = await money<Record<string, unknown>>('POST', '/v1/routes', body, generateId());
  return routeFrom(r);
}

async function updateRouteWithAssignmentsOnline(input: UpdateRouteInput, _actor: User): Promise<{ added: string[]; removed: string[] }> {
  const body: Record<string, unknown> = {
    name: input.nombre, city: text(input.ciudad), interestRate: input.tasaInteres, freeRate: input.tasaLibre,
    maxLoanMinor: toMinor(input.montoMaximoPrestamo ?? 0),
    // En CLEAN «sin valor» = sin Oficina / sin Cobrador; en el servidor hay que decirlo con null.
    officeId: input.officeId ?? null, collectorId: input.cobradorId ?? null,
    memberIds: input.assignedUserIds,
  };
  if (input.capitalControllerAdminId) body['capitalControllerId'] = input.capitalControllerAdminId;
  const r = await plain<{ added?: string[]; removed?: string[] }>('PATCH', `/v1/routes/${input.routeId}`, body);
  return { added: r.added ?? [], removed: r.removed ?? [] };
}

// Firmas ORIGINALES de CLEAN (las pantallas y servicios originales las llaman así).
export const createRouteWithAdmins = createRouteWithAdminsOnline as unknown as typeof Clean.createRouteWithAdmins;
export const updateRouteWithAssignments = updateRouteWithAssignmentsOnline as unknown as typeof Clean.updateRouteWithAssignments;
