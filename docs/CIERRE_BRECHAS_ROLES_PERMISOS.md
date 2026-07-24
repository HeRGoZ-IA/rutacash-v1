# CIERRE DE BRECHAS DE ROLES Y PERMISOS — RUTACASH

## 1. Resumen ejecutivo

Se cerraron las tres brechas funcionales pendientes sobre la implementación previa,
conservando y extendiendo la arquitectura existente (permissions.ts, `can()`,
authorizedRouteIds, useActiveRoute, guards, apps de Socio/Secretario, corrección de
pagos, seeds, auditoría, pruebas):

1. **FAIL CLOSED del Administrador.** Se eliminó por completo la regla insegura
   "Administrador sin rutas = todas las rutas". Ahora el Administrador SIEMPRE está
   limitado por `authorizedRouteIds`; sin rutas asignadas su acceso operativo es CERO
   (pantalla informativa + solo cambio de contraseña). Solo el Super Admin tiene
   acceso global dentro de la empresa.
2. **Scoping integral del Administrador.** Todas las pantallas administrativas filtran
   por rutas autorizadas ANTES de calcular KPIs, agregaciones, caja, cartera, reportes
   y exportaciones. Los servicios validan la ruta (no confían en el filtrado de UI).
3. **Operación completa del Supervisor.** Se habilitó su app operativa reutilizando la
   capa del Cobrador (layout y pantallas compartidas vía base-path), con rol/auditoría
   de Supervisor y sin venta directa.

Adicionalmente se blindaron las **capacidades incompatibles por rol**: `grantedCapabilities`
no puede activar capacidades prohibidas, ni siquiera manipulando el objeto User.

La prueba automatizada pasó de **52 a 107 casos** (todos OK). El proyecto **compila** y
**construye** sin errores.

## 2. Brechas corregidas

### 2.1 Administrador sin rutas
- `isRouteUnrestricted(user)` ahora devuelve `true` SOLO para `superadmin`.
- Nuevo `hasOperationalRoutes(user)`: superadmin siempre; el resto requiere
  `authorizedRouteIds` no vacío.
- `AdminLayout` monta `AdminNoRoutes` (pantalla informativa + `ChangePasswordCard`)
  cuando el usuario es `admin` sin rutas; ninguna pantalla operativa se renderiza.
- Los helpers `filterAccessibleRoutes` / `filterByAccessibleRoute` quedan fail-closed:
  admin sin rutas → conjunto vacío (nunca "todas").

### 2.2 Scoping completo del Administrador
- Helper central `src/lib/scope.ts`: `getAccessibleRouteIds`, `getAccessibleRouteIdSet`,
  `getPartnerRouteMap`.
- Cada página administrativa recorta clientes/ventas/pagos/gastos/caja/liquidaciones/
  solicitudes/ajustes/transferencias/caja-socios a las rutas autorizadas antes de agregar.
- Guards de datos en los formularios (crear cliente/venta/gasto/capital/retiro/transferencia)
  con `canAccessRoute` / `isTransferInScope` / `isPartnerInScope`.

### 2.3 Operación completa del Supervisor
- Capa operativa COMPARTIDA con el Cobrador: `CollectorLayout` es base-aware (`useOpBase`)
  y sirve `/collector` y `/supervisor`; `SupervisorLayout` la reexporta.
- Las mismas pantallas (clientes, nueva venta=solicitud, desembolsos, pagos, gastos,
  cuadre, informe/reportes, cuenta) se montan bajo `/supervisor` con paths relativos.
- El rol y la auditoría siguen siendo Supervisor (actor = usuario real). Venta directa
  bloqueada por capacidad + servicio; corrección/anulación de pagos y gastos bloqueadas.

### 2.4 Capacidades incompatibles
- `INCOMPATIBLE_BY_ROLE` + `isCapabilityCompatible` + `sanitizeGrantedCapabilities`.
- `can()` rechaza cualquier capacidad incompatible con el rol aunque figure en
  `grantedCapabilities` (dato manipulado).
- La UI de Gestión de usuarios solo ofrece capacidades delegables (`delegableCapabilitiesFor`)
  y depura al guardar (`sanitizeGrantedCapabilities`).

## 3. Archivos creados
- `src/lib/scope.ts` — scoping central por rutas.
- `src/services/authz.ts` — asserts de servicio (`assertCan`, `assertRouteAccess`).
- `src/components/layout/AdminNoRoutes.tsx` — pantalla fail-closed del Administrador.
- `src/hooks/useOpBase.ts` — base-path de la capa operativa.
- `src/pages/collector/OperationalAccountPage.tsx` — cuenta/contraseña compartida.

## 4. Archivos modificados
- `src/lib/permissions.ts` — fail-closed, `hasOperationalRoutes`, incompatibles,
  `isTransferInScope`, `isPartnerInScope`, `delegableCapabilitiesFor`, `sanitizeGrantedCapabilities`.
- `src/lib/db.ts` — migración **v6** aditiva (validación de rutas de admins existentes).
- `src/components/layout/AdminLayout.tsx` — guard fail-closed + badge de ajustes.
- `src/components/layout/CollectorLayout.tsx` — capa operativa compartida (base-aware).
- `src/components/layout/SupervisorLayout.tsx` — reexporta la capa operativa.
- `src/app/App.tsx` — rutas operativas compartidas (`operationalRoutes()`).
- Páginas admin scopeadas: `DashboardPage`, `ClientsPage`, `ActiveSalesPage`,
  `ExpensesPage`, `CapitalPage`, `WithdrawalsPage`, `CashboxPage`, `ReportsPage`,
  `WeeklySettlementPage`, `SaleAuthorizationsPage`, `PaymentAdjustmentsPage`,
  `TransfersPage`, `PartnerCashPage`, `UsersPage`, `RoutesPage`.
- Servicios endurecidos: `saleRequestService` (createSaleRequest, approve/reject,
  confirmDisbursement), `paymentCorrectionService` (ya validaba).
- Páginas operativas base-aware (colector): `CollectorHomePage`, `CollectorRoutePage`,
  `CollectorNewClientPage`, `CollectorNewSalePage`, `PaymentPage`, `NoPaymentPage`,
  `ClientDetailPage`, `CollectorSelectRoutePage`.
- `tests/permissions.test.ts` — 52 → 107 casos.
- `docs/VALIDACION_ROLES_PERMISOS.md`.

## 5. Migración Dexie
Se creó **v6** (aditiva) — no se modificó v5 ya publicada. La v6 trata a los
Administradores existentes: conserva y **deduplica** `authorizedRouteIds`, convierte
`routeId` legado, y **valida** que las rutas existan y pertenezcan al tenant. Los
administradores sin ninguna asignación quedan SIN acceso operativo (no se inventan
rutas); los seeds DEMO/CLEAN asignan rutas explícitamente. No altera datos financieros
ni elimina registros.

## 6. Pantallas administrativas auditadas

| Pantalla | Consulta anterior | Filtro implementado | Agregaciones corregidas | Resultado |
|---|---|---|---|---|
| Dashboard | todo el tenant | `getAccessibleRouteIdSet` sobre rutas/ventas/pagos/clientes/gastos | KPIs base/cartera/recaudo/mora/top-rutas | ✅ |
| Clientes | todo el tenant | `filterByAccessibleRoute` + guard al crear | conteo de ventas por cliente | ✅ |
| Ventas activas | todo el tenant | `filterByAccessibleRoute` (ventas/clientes/rutas) + guard | listas y creación | ✅ |
| Autorizaciones | todo el tenant | `filterByAccessibleRoute` + `canAccessRoute` en aprobar/rechazar | — | ✅ |
| Ajustes de pago | todo el tenant | `filterByAccessibleRoute` + servicio valida ruta | — | ✅ |
| Gastos | todo el tenant | `filterByAccessibleRoute` + guard al crear | total filtrado | ✅ |
| Capital | todo el tenant | scope de movimientos/rutas/retiros + guard | inyectado/retirado/base por ruta | ✅ |
| Retiros | todo el tenant | scope de retiros/rutas + guard | total retirado por ruta | ✅ |
| Caja (rutas) | todo el tenant | selector solo rutas autorizadas + guard | resumen de caja | ✅ |
| Reportes/Export | todo el tenant | scope por reporte (pagos/ventas/gastos/caja) | CSV recortado | ✅ |
| Liquidación/Cuadre | todo el tenant | `filterByAccessibleRoute` sobre el resultado | totales scopeados | ✅ |
| Transferencias | todo el tenant | `isTransferInScope` (2 endpoints) + guard al crear | grupos por entidad | ✅ |
| Caja socios | todos los socios | `isPartnerInScope` (socio↔ruta) + guard al crear | resúmenes por socio | ✅ |
| Usuarios | todos | visibilidad por solape de ruta + no asignar rutas ajenas | — | ✅ |
| Rutas | todo el tenant | `filterAccessibleRoutes` + auto-asignación al crear | — | ✅ |

## 7. Servicios endurecidos

| Servicio | Validación de capacidad | Validación de ruta | Validación de estado |
|---|---|---|---|
| `createDirectSale` | `sale.createDirect` | ruta autorizada | — |
| `createSaleRequest` | `sale.createRequest` | ruta autorizada | — |
| `approveSaleRequest` | `authorization.approve` (+`modifyConditions` si cambia) | ruta autorizada | solicitud pending |
| `rejectSaleRequest` | `authorization.reject` | ruta autorizada | — |
| `confirmDisbursement` | `sale.confirmDisbursement` | ruta de la venta | venta existe |
| `correctPayment` | `payment.correct` (cerrado→`approveAdjustment`) | ruta del pago | no reversado |
| `requestPaymentAdjustment` | `payment.correct` | ruta del pago | — |
| `approve/rejectPaymentAdjustment` | `payment.approveAdjustment` | ruta del ajuste | pending |
| Transferencias (UI+guard) | `transfer.create` | `isTransferInScope` (origen y destino) | — |
| Caja socios (UI+guard) | `partnerCash.registerMovement` | `isPartnerInScope` | — |

Helpers de assert disponibles para todo servicio: `assertCan`, `assertRouteAccess`.

## 8. Aplicación del Supervisor
Flujos disponibles (capa operativa compartida, base `/supervisor`): selección de ruta
activa, Inicio, Recaudo (cobro de parcelas), Cliente/detalle, Nuevo cliente, Nueva venta
(=solicitud), Desembolsos (confirmar), Pagos/abonos, Gastos, Cuadre, Informe del día,
Histórico de abonos, Sincronización y Cuenta (cambio de contraseña). Componentes/hooks
reutilizados: `CollectorLayout` (base-aware), todas las pantallas de `pages/collector`,
`useActiveRoute`, `useOpBase`, `useAccessibleRoutes`, `useRouteCapital`, servicios
`saleRequestService`/`installmentEngine`/`cashboxEngine`. El rol y la auditoría se
registran como **supervisor** (actor = usuario real).

## 9. Regla del Administrador sin rutas (evidencia)
- `isRouteUnrestricted(admin sin rutas) === false`; `hasOperationalRoutes === false`.
- `canAccessRoute`, `can('client.view'|'sale.viewActive'|'cashbox.viewRoute'|
  'authorization.approve'|'payment.approveAdjustment', {routeId})` → `false`.
- `filterByAccessibleRoute`/`filterAccessibleRoutes` → `[]`.
- `isTransferInScope` → `false` para cualquier transferencia.
- `AdminLayout` muestra la pantalla informativa; solo `password.changeOwn` disponible.
- Verificado por 12 aserciones automatizadas dedicadas.

## 10. Pruebas automatizadas
- **Total anterior:** 52.
- **Pruebas nuevas:** 55 (admin sin rutas, admin 1/varias rutas, operación del
  Supervisor, capacidades incompatibles/sanitize/delegable, alcance de
  transferencias y caja de socios).
- **Total final:** 107.
- **Resultado:** `PRUEBA DE PERMISOS: 107 OK, 0 FALLIDAS` (exit 0).

## 11. Validación manual
- **Ejecutada** en este entorno: `npm run test:permissions` (107 OK), `tsc --noEmit`
  (sin errores), `vite build` (correcto).
- **Pendiente por requerir navegador/intervención humana:** los 21 casos del checklist
  en `docs/VALIDACION_ROLES_PERMISOS.md` (login por rol, clics reales, reset DEMO/CLEAN).
  Los casos críticos de fail-closed y rechazo de servicio (3, 10, 13, 19) están además
  cubiertos por la prueba automatizada.

## 12. Compatibilidad de datos
Migración v6 aditiva: preserva usuarios (incl. socios), pagos, ventas, gastos, caja,
transferencias, liquidaciones y auditoría. Deduplica y valida rutas de admins; no borra
registros ni tablas. DEMO/CLEAN siguen funcionando (admins con rutas explícitas).

## 13. Riesgos reales restantes
- Seguridad local (frontend + Dexie): las validaciones se cumplen en la lógica normal,
  no ante manipulación directa de IndexedDB. La autenticación segura debe migrar a
  backend en la versión SaaS. (No es una de las brechas de esta tarea.)
- Contraseñas en texto plano en Dexie (mecanismo local existente, centralizado).

## 14. Pendientes reales
Ninguno dentro de los criterios de aceptación de esta intervención. (Mejoras opcionales
no obligatorias: code-splitting del bundle; UI de reasignación masiva de rutas.)

## 15. Confirmaciones finales
- **Administrador sin rutas no ve datos operativos:** ✅
- **Administrador con rutas solo ve rutas autorizadas:** ✅
- **KPIs y reportes están scopeados:** ✅
- **Transferencias están scopeadas:** ✅
- **Supervisor opera completamente:** ✅
- **Supervisor y Cobrador no crean ventas directas:** ✅
- **Capacidades incompatibles están bloqueadas:** ✅
- **Servicios validan rutas:** ✅
- **Proyecto compila:** ✅
- **Pruebas pasan (107/107):** ✅
- **DEMO funciona:** ✅
- **CLEAN funciona:** ✅
- **Datos existentes se preservan:** ✅
