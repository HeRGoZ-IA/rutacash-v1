// PUENTE de `src/services/settlementService.ts` (CLEAN): cierre y reapertura de la semana
// de una ruta contra el servidor (Fase 6 y 0016).
//
//   closeSettlement  → POST /v1/periods/close         (archiva las cifras del libro, D29, sin solapes)
//   reopenSettlement → POST /v1/periods/:id/reopen    (motivo ≥ 10; responsable o SuperAdmin)
//
// Ambos con id de operación: un doble clic no cierra ni reabre dos veces. El servidor decide
// con su reloj y la zona de la empresa si el periodo terminó; aquí no se valida nada que el
// servidor no vuelva a validar. Los listados (`listSettlementsOfRoute`…) son los originales
// sobre la proyección (`weeklySettlements` = cierres del servidor).

import type { WeeklySettlement } from '@clean/models/types';
import { SettlementError, type CloseSettlementParams, type ReopenSettlementParams } from '@clean/services/settlementService';
import { generateId } from '@/lib/utils';
import { money } from '../../runtime/commands.ts';
import { weeklySettlementFrom } from '../../runtime/mappers.ts';
import { api } from '../../runtime/session.ts';

export * from '@clean/services/settlementService';
import * as Clean from '@clean/services/settlementService';

async function asSettlementError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new SettlementError(e instanceof Error ? e.message : String(e));
  }
}

async function closeSettlementOnline(params: CloseSettlementParams): Promise<WeeklySettlement> {
  return asSettlementError(async () => {
    const r = await money<Record<string, unknown>>('POST', '/v1/periods/close',
      { routeId: params.routeId, weekStart: params.semanaInicio, weekEnd: params.semanaFin }, generateId());
    const closure = await api().get<Record<string, unknown>>(`/v1/periods/${r['closureId']}`);
    return weeklySettlementFrom(closure);
  });
}

async function reopenSettlementOnline(params: ReopenSettlementParams): Promise<WeeklySettlement> {
  return asSettlementError(async () => {
    const r = await money<Record<string, unknown>>('POST', `/v1/periods/${params.settlementId}/reopen`, { reason: (params.motivo ?? '').trim() }, generateId());
    return weeklySettlementFrom(r['closure'] as Record<string, unknown>);
  });
}

// Firmas ORIGINALES de CLEAN (las pantallas y servicios originales las llaman así).
export const closeSettlement = closeSettlementOnline as unknown as typeof Clean.closeSettlement;
export const reopenSettlement = reopenSettlementOnline as unknown as typeof Clean.reopenSettlement;
