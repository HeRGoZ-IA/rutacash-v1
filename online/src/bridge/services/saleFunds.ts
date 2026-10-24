// Ronda 73 · SOC-02: DINERO QUE PAGARÍA UNA VENTA DIRECTA de quien la registra.
//
// CLEAN limitaba toda venta nueva por la «Base de la ruta» (su caja de ruta). En ADEX Online no
// existe caja de ruta (capital centralizado: empresa → bolsa del Administrador → custodia del
// trabajador) y el puente sumaba la custodia de TODOS los trabajadores de la ruta: un
// Administrador con dinero en su bolsa y sin entregas a trabajadores quedaba bloqueado.
// El servidor (`adex.credit_disburse`) cobra la venta directa así, y aquí se replica SOLO para
// avisar antes de enviar (la decisión siempre la toma el servidor, con bloqueo):
//   · Cobrador / Supervisor → su propia custodia en la ruta, sin el faltante arrastrado (D25);
//   · Administrador responsable de capital de la ruta → el disponible de su bolsa; con Base por Ruta
//     (R74), la Base de ESA ruta (nunca su saldo «sin asignar» ni la Base de otra ruta);
//   · cualquier otro caso (Administrador que no es responsable, SuperAdmin…) → null: no se
//     bloquea en pantalla y el servidor responde con su motivo (p. ej. «solo el responsable»).

import { db } from '@/lib/db';
import { custodyPositions, serverView } from '../../runtime/projection.ts';
import { toMajor } from '../../runtime/mappers.ts';
import { useRuntime } from '../../runtime/session.ts';
import { todayIn } from '../../lib/format.ts';
import { fetchModel, fetchPanel } from '../../runtime/routeBase/api.ts';

export async function saleFunds(routeId: string): Promise<number | null> {
  const ctx = useRuntime.getState().ctx;
  if (!ctx) return null;
  if (ctx.role === 'cobrador' || ctx.role === 'supervisor') {
    const own = (await custodyPositions()).find((p) => p.routeId === routeId && p.workerId === ctx.membershipId);
    return toMajor(own ? Math.max(0, own.balanceMinor - own.carriedMinor) : 0);
  }
  if (ctx.role === 'admin') {
    const route = await db.routes.get(routeId);
    if (!route || route.capitalControllerAdminId !== ctx.membershipId) return null;
    if ((await fetchModel()).model === 'route_base') {
      const today = todayIn(ctx.company.timezone ?? 'UTC');
      const row = (await fetchPanel(today, today)).routes.find((r) => r.routeId === routeId);
      return row ? toMajor(row.baseMinor) : null;
    }
    const summary = await serverView<{ admins: { adminId: string; availableMinor: number }[] }>('/v1/capital/summary');
    const own = summary.admins.find((a) => a.adminId === ctx.membershipId);
    return toMajor(own ? own.availableMinor : 0);
  }
  return null;
}
