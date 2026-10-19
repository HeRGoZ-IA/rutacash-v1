// PUENTE de `src/lib/permissions.ts` (CLEAN): todas las reglas originales, y `can()`
// exige ADEMÁS que la capacidad figure en las que el SERVIDOR devolvió para el contexto
// activo (DS-05: contexto explícito, sin permisos acumulados). Es una restricción, nunca
// una ampliación: la pantalla solo ofrece lo que la API va a autorizar, y la API vuelve
// a autorizar cada comando de todos modos.

import type { User } from '@clean/models/types';
import { can as cleanCan, type Capability, type PermissionContext } from '@clean/lib/permissions';
import { useRuntime } from '../../runtime/session.ts';

export * from '@clean/lib/permissions';

export function can(user: User | null | undefined, capability: Capability, ctx?: PermissionContext): boolean {
  const server = useRuntime.getState().ctx;
  if (!server || !user || user.id !== server.membershipId) return cleanCan(user, capability, ctx);
  return server.capabilities.includes(capability) && cleanCan(user, capability, ctx);
}
