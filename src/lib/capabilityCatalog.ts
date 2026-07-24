// ============================================================
// CATÁLOGO DE CAPACIDADES EN LENGUAJE HUMANO
// ------------------------------------------------------------
// Metadatos visibles de cada capacidad (label, descripción, categoría, riesgo).
// Las CLAVES técnicas (permissions.ts) solo se usan internamente; la UI muestra
// texto humano agrupado por categoría. Fuente única para Gestión de usuarios.
// ============================================================
import type { Capability } from '@/lib/permissions'

export type CapabilityCategory =
  | 'Empresa'
  | 'Usuarios'
  | 'Rutas'
  | 'Clientes'
  | 'Ventas'
  | 'Autorizaciones'
  | 'Pagos y caja'
  | 'Reportes'
  | 'Auditoría'
  | 'Cuenta'

export type CapabilityRisk = 'bajo' | 'medio' | 'alto'

export interface CapabilityMeta {
  key: Capability
  label: string
  description: string
  category: CapabilityCategory
  risk?: CapabilityRisk
}

/** Orden de presentación de las categorías en la UI. */
export const CATEGORY_ORDER: CapabilityCategory[] = [
  'Empresa', 'Usuarios', 'Rutas', 'Clientes', 'Ventas',
  'Autorizaciones', 'Pagos y caja', 'Reportes', 'Auditoría', 'Cuenta',
]

export const CAPABILITY_METADATA: Record<Capability, CapabilityMeta> = {
  // Empresa / Plataforma
  'platform.access': { key: 'platform.access', label: 'Acceder a la plataforma', description: 'Ingresar al panel de administración de la plataforma (empresas).', category: 'Empresa', risk: 'alto' },
  'company.create': { key: 'company.create', label: 'Crear empresas', description: 'Registrar nuevas empresas en la plataforma.', category: 'Empresa', risk: 'alto' },
  'company.edit': { key: 'company.edit', label: 'Editar datos de la empresa', description: 'Modificar nombre, contacto, plan y vigencia de la empresa.', category: 'Empresa', risk: 'alto' },
  'company.suspend': { key: 'company.suspend', label: 'Suspender o activar empresas', description: 'Bloquear o reactivar el acceso de una empresa.', category: 'Empresa', risk: 'alto' },
  'company.enterPanel': { key: 'company.enterPanel', label: 'Entrar al panel de una empresa', description: 'Operar dentro del panel administrativo de una empresa.', category: 'Empresa', risk: 'medio' },
  'company.viewConsolidated': { key: 'company.viewConsolidated', label: 'Ver información consolidada', description: 'Consultar cifras consolidadas de la empresa.', category: 'Empresa' },
  'settings.access': { key: 'settings.access', label: 'Acceder a configuración', description: 'Ver la configuración administrativa de la empresa.', category: 'Empresa' },
  'settings.edit': { key: 'settings.edit', label: 'Editar parámetros generales', description: 'Modificar parámetros generales del sistema.', category: 'Empresa', risk: 'medio' },
  'capital.manage': { key: 'capital.manage', label: 'Gestionar capital', description: 'Registrar y ajustar el capital de las rutas.', category: 'Pagos y caja', risk: 'medio' },

  // Rutas
  'route.create': { key: 'route.create', label: 'Crear rutas', description: 'Crear nuevas rutas.', category: 'Rutas', risk: 'medio' },
  'route.edit': { key: 'route.edit', label: 'Editar rutas', description: 'Modificar la configuración de rutas autorizadas.', category: 'Rutas', risk: 'medio' },
  'route.block': { key: 'route.block', label: 'Bloquear o activar rutas', description: 'Activar o inactivar rutas.', category: 'Rutas', risk: 'medio' },
  'route.delete': { key: 'route.delete', label: 'Eliminar rutas', description: 'Eliminar rutas sin movimientos (no destructivo de históricos).', category: 'Rutas', risk: 'alto' },
  'route.assign': { key: 'route.assign', label: 'Asignar rutas a usuarios', description: 'Asignar o retirar rutas a los usuarios.', category: 'Rutas', risk: 'medio' },
  'route.viewAll': { key: 'route.viewAll', label: 'Ver todas las rutas', description: 'Consultar todas las rutas de la empresa sin límite.', category: 'Rutas', risk: 'alto' },
  'route.viewAssigned': { key: 'route.viewAssigned', label: 'Ver rutas asignadas', description: 'Consultar únicamente las rutas autorizadas.', category: 'Rutas' },

  // Usuarios
  'user.viewAll': { key: 'user.viewAll', label: 'Ver usuarios', description: 'Consultar el listado de usuarios.', category: 'Usuarios' },
  'user.create': { key: 'user.create', label: 'Crear usuarios', description: 'Registrar nuevos usuarios subordinados.', category: 'Usuarios', risk: 'alto' },
  'user.edit': { key: 'user.edit', label: 'Editar usuarios', description: 'Modificar datos de usuarios subordinados.', category: 'Usuarios', risk: 'medio' },
  'user.block': { key: 'user.block', label: 'Bloquear o activar usuarios', description: 'Inactivar o reactivar usuarios subordinados.', category: 'Usuarios', risk: 'medio' },
  'user.setRole': { key: 'user.setRole', label: 'Definir roles', description: 'Asignar el rol de usuarios subordinados.', category: 'Usuarios', risk: 'alto' },
  'user.grantCapabilities': { key: 'user.grantCapabilities', label: 'Delegar permisos', description: 'Otorgar permisos adicionales (solo los que se poseen).', category: 'Usuarios', risk: 'alto' },
  'user.resetPassword': { key: 'user.resetPassword', label: 'Restablecer contraseñas', description: 'Restablecer la contraseña de usuarios subordinados.', category: 'Usuarios', risk: 'alto' },
  'password.changeOwn': { key: 'password.changeOwn', label: 'Cambiar mi contraseña', description: 'Cambiar la propia contraseña.', category: 'Cuenta' },

  // Clientes
  'client.create': { key: 'client.create', label: 'Crear clientes', description: 'Registrar nuevos clientes en rutas autorizadas.', category: 'Clientes' },
  'client.view': { key: 'client.view', label: 'Consultar clientes', description: 'Ver los clientes de rutas autorizadas.', category: 'Clientes' },
  'client.edit': { key: 'client.edit', label: 'Modificar clientes', description: 'Actualizar los datos de clientes autorizados.', category: 'Clientes', risk: 'medio' },
  'client.editLimited': { key: 'client.editLimited', label: 'Editar datos operativos del cliente', description: 'Actualizar datos operativos (teléfono, dirección, observaciones).', category: 'Clientes' },
  'client.deactivate': { key: 'client.deactivate', label: 'Inactivar clientes', description: 'Baja lógica de clientes (nunca destructiva).', category: 'Clientes', risk: 'medio' },

  // Ventas
  'sale.viewActive': { key: 'sale.viewActive', label: 'Ver ventas activas', description: 'Consultar las ventas activas.', category: 'Ventas' },
  'sale.viewHistory': { key: 'sale.viewHistory', label: 'Ver historial de ventas', description: 'Consultar el historial de ventas.', category: 'Ventas' },
  'sale.createDirect': { key: 'sale.createDirect', label: 'Crear ventas directas', description: 'Crear ventas sin necesidad de autorización.', category: 'Ventas', risk: 'alto' },
  'sale.createRequest': { key: 'sale.createRequest', label: 'Enviar solicitudes de venta', description: 'Crear ventas como solicitud pendiente de autorización.', category: 'Ventas' },
  'sale.editBeforeDisbursement': { key: 'sale.editBeforeDisbursement', label: 'Editar ventas antes del desembolso', description: 'Modificar ventas que aún no se han desembolsado.', category: 'Ventas', risk: 'medio' },
  'sale.adjustAfterDisbursement': { key: 'sale.adjustAfterDisbursement', label: 'Ajustar ventas desembolsadas', description: 'Ajustar ventas ya desembolsadas mediante flujo auditado.', category: 'Ventas', risk: 'alto' },
  'sale.cancel': { key: 'sale.cancel', label: 'Anular ventas', description: 'Anular ventas por estado y trazabilidad (no destructivo).', category: 'Ventas', risk: 'alto' },
  'sale.confirmDisbursement': { key: 'sale.confirmDisbursement', label: 'Confirmar desembolsos', description: 'Confirmar el desembolso de ventas aprobadas.', category: 'Ventas', risk: 'medio' },

  // Autorizaciones
  'authorization.access': { key: 'authorization.access', label: 'Acceder a autorizaciones', description: 'Ver el módulo de solicitudes de venta.', category: 'Autorizaciones' },
  'authorization.approve': { key: 'authorization.approve', label: 'Aprobar autorizaciones', description: 'Aprobar solicitudes de venta.', category: 'Autorizaciones', risk: 'alto' },
  'authorization.reject': { key: 'authorization.reject', label: 'Rechazar autorizaciones', description: 'Rechazar solicitudes de venta con motivo.', category: 'Autorizaciones', risk: 'medio' },
  'authorization.modifyConditions': { key: 'authorization.modifyConditions', label: 'Modificar condiciones', description: 'Cambiar porcentaje, frecuencia y días al autorizar.', category: 'Autorizaciones', risk: 'alto' },
  'authorization.phoneConfirm': { key: 'authorization.phoneConfirm', label: 'Confirmación telefónica', description: 'Registrar la confirmación telefónica con el cliente.', category: 'Autorizaciones' },

  // Pagos y caja
  'payment.register': { key: 'payment.register', label: 'Registrar pagos', description: 'Registrar abonos/pagos de las ventas.', category: 'Pagos y caja' },
  'payment.correct': { key: 'payment.correct', label: 'Corregir pagos', description: 'Corregir pagos mediante reversión y reemplazo (no destructivo).', category: 'Pagos y caja', risk: 'alto' },
  'payment.reverse': { key: 'payment.reverse', label: 'Anular pagos', description: 'Anular pagos mediante reversión.', category: 'Pagos y caja', risk: 'alto' },
  'payment.viewHistory': { key: 'payment.viewHistory', label: 'Ver historial de pagos', description: 'Consultar el historial de pagos.', category: 'Pagos y caja' },
  'payment.approveAdjustment': { key: 'payment.approveAdjustment', label: 'Aprobar ajustes de pago', description: 'Aprobar solicitudes de ajuste de pagos en periodos cerrados.', category: 'Pagos y caja', risk: 'alto' },
  'expense.register': { key: 'expense.register', label: 'Registrar gastos', description: 'Registrar gastos de la ruta.', category: 'Pagos y caja' },
  'expense.correct': { key: 'expense.correct', label: 'Corregir gastos', description: 'Corregir o anular gastos de forma auditada.', category: 'Pagos y caja', risk: 'medio' },
  'cashbox.viewRoute': { key: 'cashbox.viewRoute', label: 'Consultar caja de ruta', description: 'Ver la caja de las rutas autorizadas.', category: 'Pagos y caja' },
  'cashbox.viewConsolidated': { key: 'cashbox.viewConsolidated', label: 'Consultar caja consolidada', description: 'Ver la caja consolidada de la empresa.', category: 'Pagos y caja', risk: 'medio' },
  'cashbox.dailyClose': { key: 'cashbox.dailyClose', label: 'Realizar cuadre diario', description: 'Hacer el cuadre diario de la ruta.', category: 'Pagos y caja' },
  'partnerCash.viewOwn': { key: 'partnerCash.viewOwn', label: 'Ver mi caja de socio', description: 'Consultar la propia caja de socio.', category: 'Pagos y caja' },
  'partnerCash.viewAll': { key: 'partnerCash.viewAll', label: 'Ver caja de socios', description: 'Consultar la caja de los socios de las rutas.', category: 'Pagos y caja', risk: 'medio' },
  'partnerCash.registerMovement': { key: 'partnerCash.registerMovement', label: 'Registrar en caja de socios', description: 'Registrar movimientos en la caja de socios.', category: 'Pagos y caja', risk: 'alto' },
  'transfer.create': { key: 'transfer.create', label: 'Realizar transferencias', description: 'Crear transferencias entre rutas y socios.', category: 'Pagos y caja', risk: 'alto' },

  // Reportes
  'report.view': { key: 'report.view', label: 'Ver reportes', description: 'Consultar reportes.', category: 'Reportes' },
  'report.export': { key: 'report.export', label: 'Exportar reportes', description: 'Exportar reportes a CSV.', category: 'Reportes', risk: 'medio' },
  'report.viewPortfolio': { key: 'report.viewPortfolio', label: 'Ver cartera y mora', description: 'Consultar cartera y mora de rutas accesibles.', category: 'Reportes' },
  'report.viewConsolidated': { key: 'report.viewConsolidated', label: 'Ver indicadores consolidados', description: 'Consultar indicadores financieros consolidados.', category: 'Reportes', risk: 'medio' },

  // Auditoría
  'audit.view': { key: 'audit.view', label: 'Ver auditoría', description: 'Consultar la auditoría e historial de cambios.', category: 'Auditoría', risk: 'medio' },
}

/** Etiqueta humana de una capacidad (fallback: la clave técnica). */
export function capabilityLabel(cap: Capability): string {
  return CAPABILITY_METADATA[cap]?.label ?? cap
}
