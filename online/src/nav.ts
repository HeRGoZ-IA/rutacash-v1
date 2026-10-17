// Navegación según las capacidades que DEVUELVE el servidor para el contexto activo.
// Ocultar una entrada es comodidad; la autorización real la hace la API en cada petición.

import type { ActiveContextView } from './lib/client.ts';

export interface NavItem { to: string; label: string; hint: string }

export function navFor(ctx: ActiveContextView): NavItem[] {
  const can = (c: string) => ctx.capabilities.includes(c);
  const items: NavItem[] = [{ to: '/app', label: 'Inicio', hint: '' }, { to: '/app/clientes', label: 'Clientes', hint: 'Listado, alta y consulta' }];
  if (can('capital.manage') && ['superadmin', 'admin'].includes(ctx.role)) items.push({ to: '/app/capital', label: 'Capital', hint: 'Bolsa, entregas, devoluciones y movimientos' });
  if (['cobrador', 'supervisor'].includes(ctx.role)) items.push({ to: '/app/mi-efectivo', label: 'Mi efectivo', hint: 'Capital recibido y custodia por ruta' });
  if (can('sale.createRequest')) items.push({ to: '/app/solicitudes', label: 'Solicitudes', hint: 'Pedir un préstamo para un cliente' });
  if (can('authorization.approve')) items.push({ to: '/app/autorizaciones', label: 'Autorizaciones', hint: 'Aprobar o rechazar solicitudes' });
  if (can('sale.confirmDisbursement') || can('sale.viewActive')) items.push({ to: '/app/desembolsos', label: 'Desembolsos y créditos', hint: 'Confirmar entregas y consultar créditos' });
  items.push({ to: '/app/proximamente', label: 'Próximamente', hint: 'Recaudos, gastos, cuadres, cierres, reportes' });
  return items;
}
