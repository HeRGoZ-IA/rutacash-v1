# IMPLEMENTACIÓN DE ROLES Y PERMISOS — RUTACASH

## 1. Resumen ejecutivo

Se implementó el modelo centralizado **ROL BASE + CAPACIDADES + RUTAS AUTORIZADAS**
para los seis roles: Super Admin, Administrador, Socio, Supervisor, Cobrador y
Secretario. El corazón del sistema es `src/lib/permissions.ts`: un único punto de
verdad con capacidades tipadas, matriz por rol, jerarquía de gestión de usuarios,
resolución de rutas autorizadas y la función central `can(user, capability, ctx?)`.

Las restricciones se aplican en **navegación** (guards por rol/capacidad),
**menús** (filtrados por rol), **páginas** (apps propias de Socio y Secretario),
**servicios** (venta directa, corrección de pagos, reset de contraseñas y
autorizaciones validan permisos en la función que ejecuta), **consultas**
(filtrado por rutas autorizadas), **sesión** (revalidación de usuario/empresa/rol),
y **seeds** (DEMO con los 6 perfiles, CLEAN con Super Admin inicial).

Se añadieron flujos no destructivos de **corrección controlada de pagos**
(reversión + reemplazo, con solicitud de ajuste para periodos cerrados) y de
**autorización de ventas** con trazabilidad de condiciones (solicitadas vs
aprobadas) y confirmación telefónica. La migración Dexie **v5** es aditiva y segura.

El proyecto **compila** (`tsc + vite build`) y la matriz de permisos pasa una prueba
automatizada (`npm run test:permissions` → 52/52).

## 2. Archivos creados

- `src/lib/permissions.ts` — módulo central de permisos.
- `src/hooks/useActiveRoute.ts` — ruta activa (fuente única, persistida por usuario).
- `src/hooks/useAccessibleRoutes.ts` — rutas accesibles por el usuario.
- `src/services/paymentCorrectionService.ts` — corrección/reversión y solicitudes de ajuste.
- `src/services/passwordService.ts` — reseteo de contraseñas por jerarquía.
- `src/components/auth/guards.tsx` — guard central de navegación.
- `src/components/auth/ChangePasswordCard.tsx` — cambio de contraseña propia.
- `src/components/layout/SocioLayout.tsx`, `src/components/layout/SecretarioLayout.tsx`.
- `src/pages/socio/{SocioDashboardPage,SocioClientsPage,SocioReportsPage,SocioPartnerCashPage,SocioAccountPage}.tsx`.
- `src/pages/secretario/{SecretarioClientsPage,SecretarioAuthorizationsPage,SecretarioPaymentCorrectionPage,SecretarioAccountPage}.tsx`.
- `src/pages/admin/PaymentAdjustmentsPage.tsx` — aprobación de ajustes (periodo cerrado).
- `tests/permissions.test.ts` — prueba ejecutable de la matriz.
- `docs/VALIDACION_ROLES_PERMISOS.md`, `docs/IMPLEMENTACION_ROLES_PERMISOS.md`.

## 3. Archivos modificados

- `src/models/types.ts` — rol `secretario`; campos de corrección en `Payment`;
  `PaymentAdjustmentRequest`; trazabilidad en `SaleRequest`; `status` en
  `WeeklySettlement`; `grantedCapabilities/revokedCapabilities` en `User`;
  `AuditLog` con rol/ruta/before/after/motivo; nuevas `AuditAction`.
- `src/lib/db.ts` — versión Dexie **v5** (tabla `paymentAdjustmentRequests`,
  índices en `payments`, `.upgrade()` de datos existentes).
- `src/lib/roles.ts` — helpers de rutas generalizados (delegan en permissions).
- `src/hooks/useAuth.ts` — `revalidateSession`, `changeOwnPassword`, `refreshUser`.
- `src/hooks/useCollectorRoute.ts` — alias de `useActiveRoute` (fin de la duplicidad).
- `src/services/auditService.ts` — auditoría enriquecida.
- `src/services/saleRequestService.ts` — guard de venta directa en servicio +
  aprobación con condiciones finales y confirmación telefónica.
- `src/app/App.tsx` — rutas `/socio`, `/secretario`, `/admin/payment-adjustments`;
  guards; revalidación al iniciar.
- `src/pages/auth/LoginPage.tsx` — redirección central + credenciales de los 6 roles.
- `src/pages/platform/PlatformPage.tsx` — "Entrar" a empresa + auditoría de tenant.
- `src/pages/admin/UsersPage.tsx` — formulario dependiente del actor, delegación de
  capacidades, reseteo de contraseña, estados inválidos bloqueados.
- `src/pages/admin/RoutesPage.tsx` — restricción por rutas, auto-asignación al crear,
  borrado solo Super Admin, auditoría.
- `src/components/layout/AdminLayout.tsx` — entrada "Ajustes de pago" con badge.
- `src/pages/collector/CollectorNewSalePage.tsx` — venta directa por capacidad.
- `src/data/seed.ts` — DEMO 6 roles (socios con rutas + login, secretario, admin con
  rutas, semana cerrada) y CLEAN con Super Admin inicial.
- `package.json`, `.gitignore`.

## 4. Migración Dexie

- **Versión anterior:** v4.
- **Nueva versión:** v5.
- **Campos/tablas añadidos:** tabla `paymentAdjustmentRequests`; índices
  `state, correctionOfPaymentId, reversesPaymentId` en `payments`; en runtime,
  campos opcionales nuevos en `User`, `Payment`, `SaleRequest`, `WeeklySettlement`,
  `AuditLog`.
- **`.upgrade()` (aditiva):** cobradores → `canCreateDirectSales=false`; `routeId`
  legacy → `authorizedRouteIds` (sin duplicar) para roles operativos; liquidaciones
  existentes → `status='cerrada'`; pagos existentes → `state='active'`.
- **Compatibilidad:** todos los campos nuevos son opcionales; los registros
  anteriores conviven sin conversión forzada. No se eliminan tablas ni registros.
- **Datos preservados:** usuarios (incl. socios), pagos, ventas, gastos, caja,
  transferencias, liquidaciones, auditoría.

## 5. Matriz implementada por rol

| Capacidad | Super Admin | Administrador | Socio | Supervisor | Cobrador | Secretario |
|---|---|---|---|---|---|---|
| Crear/suspender empresas | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Entrar a panel de empresa | ✅ | ✅ | — | — | — | — |
| Crear/editar rutas | ✅ | ✅ (autorizadas) | ❌ | ❌ | ❌ | ❌ |
| Eliminar rutas | ✅ (sin movimientos) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Asignar rutas | ✅ | ✅ (subordinados) | ❌ | ❌ | ❌ | ❌ |
| Ver rutas | Todas | Autorizadas | Autorizadas | Asignadas | Asignadas | Asignadas |
| Crear usuarios | Todos | socio/supervisor/cobrador/secretario | ❌ | ❌ | ❌ | ❌ |
| Reset contraseña (otros) | Cualquiera | Subordinados | ❌ | ❌ | ❌ | ❌ |
| Cambiar contraseña propia | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Crear clientes | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| Editar cliente | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ (limitado) |
| Consultar clientes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Venta directa | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Solicitud de venta | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| Confirmar desembolso | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| Aprobar/rechazar autorización | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| Modificar condiciones + conf. telefónica | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| Registrar pagos | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| Corregir/anular pagos | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ (abierto) |
| Aprobar ajuste (periodo cerrado) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Registrar/corregir gastos | ✅ | ✅ | ❌ | ✅ / ❌ | ✅ / ❌ | ❌ |
| Consultar caja de ruta | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Caja de socios | Todas | Todas | Propia | ❌ | ❌ | ❌ |
| Transferencias | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Reportes / exportar | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | ✅ / ❌ | Cartera/mora |
| Indicadores consolidados | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Eliminar históricos financieros | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

## 6. Navegación y guards

`RequireAuth` (`src/components/auth/guards.tsx`) valida rol y, opcionalmente,
capacidad; redirige a `homePathForRole` cuando no procede (protege el acceso directo
por URL, no solo el menú). Rutas: `/platform`, `/admin`, `/socio`, `/supervisor`,
`/collector`, `/secretario`. La redirección post-login usa la fuente única
`homePathForRole`. Al iniciar la app se ejecuta `revalidateSession`.

## 7. Restricción por rutas

`authorizedRouteIdsOf` consolida `authorizedRouteIds + routeId` legacy.
`canAccessRoute` / `filterAccessibleRoutes` / `filterByAccessibleRoute` filtran
rutas y registros. Super Admin no se limita; el Administrador queda limitado cuando
tiene rutas autorizadas (sin rutas = todas, por compatibilidad — ver Riesgos). La
ruta activa tiene fuente única (`useActiveRoute`, persistida por usuario), eliminando
la duplicidad `useAuth.route` / `useCollectorRoute`.

## 8. Flujo de autorizaciones

Solicitud → revisión (Secretario/Admin/Super Admin, restringido por ruta). Al aprobar
se congela lo **solicitado** (tasa/frecuencia/días) y se registra lo **aprobado**,
más `phoneConfirmed`. Se audita `APPROVE_SALE_REQUEST`, `CHANGE_SALE_CONDITIONS` y
`PHONE_CONFIRMATION` con valores antes/después. Toda venta de Supervisor/Cobrador
entra como solicitud pendiente; la venta directa se rechaza también en el servicio.

## 9. Flujo de corrección de pagos

Periodo **abierto** (Secretario/Admin/Super Admin): el original queda `reversed`
(intacto), se crea un asiento de `reversal` (valor negativo) y un pago `correction`;
se recalculan parcelas, saldo, caja y recaudo (la caja suma pagos, incluidos los
negativos). Periodo **cerrado**: el Secretario genera una **Solicitud de ajuste**
(`/admin/payment-adjustments`) que aprueba un Administrador autorizado o el Super
Admin, ejecutando la misma reversión + reemplazo. En ningún caso se elimina el
original. Detección de periodo cerrado vía `WeeklySettlement.status='cerrada'`.

## 10. Cambios en DEMO y CLEAN

**DEMO** (password `123456`): superadmin@demo.com, admin@demo.com (rutas 1-4),
socio1@demo.com (rutas 1-2), socio2@demo.com (rutas 3-4), supervisor@demo.com,
cobrador@demo.com, secretario@demo.com (rutas 1-2). Incluye una semana **cerrada** en
Ruta Norte para probar el ajuste de periodo cerrado. **CLEAN**: superadmin@demo.com
(plataforma) + empresa inicial + admin@demo.com. El reset CLEAN preserva Super Admin
y Administrador; el reset DEMO resiembra los seis perfiles.

## 11. Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Matriz de permisos (52 casos) | ✅ | `npm run test:permissions` → 52 OK, 0 FALLIDAS |
| Compilación TypeScript | ✅ | `tsc --noEmit` sin errores |
| Build de producción | ✅ | `vite build` correcto |
| Venta directa rechazada en servicio | ✅ | test `cobrador/supervisor/secretario NO sale.createDirect` |
| Corrección periodo abierto vs cerrado | ✅ | test `secretario NO corrige en periodo cerrado; admin SÍ` |
| Jerarquía de usuarios | ✅ | test `admin NO crea admin/superadmin` |
| Restricción por rutas | ✅ | test `supervisor NO accede a ruta ajena` |
| Socio solo lectura | ✅ | test `socio NO crea/paga/transfiere` |
| Redirección por rol | ✅ | test `homePathForRole` de los 6 roles |
| Checklist manual E2E | Pendiente de QA | `docs/VALIDACION_ROLES_PERMISOS.md` |

## 12. Riesgos o limitaciones

- **Seguridad local:** la app es frontend + Dexie; las restricciones se cumplen en la
  lógica normal, no ante manipulación directa del navegador. La autenticación segura
  debe migrar a backend en la versión SaaS.
- **Administrador sin rutas = todas:** decisión de compatibilidad para no romper
  instalaciones existentes. Al asignarle rutas queda limitado. El DEMO le asigna
  rutas explícitas.
- **Filtrado por rutas del Administrador:** aplicado en `RoutesPage` y en las apps de
  Socio/Secretario; algunas pantallas admin de consulta (dashboard/clientes/caja) aún
  muestran datos del tenant completo para el admin (ver Pendientes).
- **Contraseñas en texto plano** en Dexie (mecanismo local existente, centralizado).

## 13. Pendientes reales

- Aplicar el filtro por rutas autorizadas del Administrador en el resto de pantallas
  admin de consulta (dashboard, clientes, caja, reportes) además de las ya cubiertas.
- App operativa del Supervisor para **crear solicitudes de venta** (hoy el envío de
  solicitudes vive en la app del Cobrador; el Supervisor consulta). La regla de "no
  venta directa" ya está garantizada por servicio y capacidades.

## 14. Confirmaciones finales

- **Proyecto compila:** ✅ (`tsc && vite build`).
- **Datos existentes preservados:** ✅ (migración v5 aditiva, sin borrados).
- **Socio funcional:** ✅ (login + app propia solo lectura).
- **Secretario funcional:** ✅ (login + Clientes/Autorizaciones/Corrección de pagos).
- **Administrador limitado por rutas:** ✅ (helpers + `RoutesPage` + apps).
- **Cobrador sin venta directa:** ✅ (capacidad + guard de servicio + migración).
- **Supervisor sin venta directa:** ✅ (capacidad + guard de servicio).
- **Corrección de pagos no destructiva:** ✅ (reversión + reemplazo).
- **Históricos no eliminables:** ✅ (no existe borrado físico de pagos/ventas/caja).
- **DEMO funcional:** ✅ (6 perfiles + periodo cerrado de prueba).
- **CLEAN funcional:** ✅ (Super Admin + empresa + Administrador iniciales).
