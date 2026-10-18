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
  if (can('payment.register') || can('payment.viewHistory')) items.push({ to: '/app/recaudos', label: 'Recaudos', hint: 'Cobrar cuotas e historial de abonos' });
  if (can('expense.register') || can('expense.correct')) items.push({ to: '/app/gastos', label: 'Gastos', hint: 'Registrar gastos e historial' });
  if (can('cashSettlement.view') || can('cashSettlement.viewOwn')) {
    items.push({ to: '/app/cuadres', label: can('cashSettlement.view') ? 'Cuadres' : 'Mi cuadre', hint: 'Esperado, entregas parciales, faltantes y sobrantes' });
  }
  if (can('cashbox.viewRoute')) items.push({ to: '/app/cierres', label: 'Cierres', hint: 'Liquidación por periodo y cierre semanal' });
  // Administración de la empresa (mismas capacidades que exige el servidor).
  if (can('user.viewAll')) items.push({ to: '/app/usuarios', label: 'Usuarios', hint: 'Altas, estado, rutas autorizadas y membresías' });
  if (can('route.create') || can('route.edit')) items.push({ to: '/app/rutas', label: 'Rutas', hint: 'Datos, asignaciones, Cobrador y responsable de capital' });
  if (can('office.create') || can('office.edit')) items.push({ to: '/app/oficinas', label: 'Oficinas', hint: 'Organización de rutas por oficina' });
  if (can('settings.access')) items.push({ to: '/app/configuracion', label: 'Configuración', hint: 'Datos de la empresa y categorías de gasto' });
  items.push({ to: '/app/proximamente', label: 'Próximamente', hint: 'Visitas sin pago, reportes' });
  return items;
}
