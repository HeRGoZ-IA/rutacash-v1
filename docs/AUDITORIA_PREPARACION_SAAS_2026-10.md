# ADEX Soluciones — Auditoría de preparación SaaS (Ronda 6/6D)

| | |
|---|---|
| Fecha | 2026-10-12 |
| Estado auditado | `main` @ `520a331` (= `origin/main`); producción sirve `index-b05G8Ybt.js` |
| Pruebas de referencia | 26 suites · 1.490 casos · 0 fallos (`npm test`) |
| Alcance | **Solo análisis.** No se modificó código, esquema, dependencias ni datos |
| Documentos relacionados | [Invariantes](./INVARIANTES_FINANCIERAS_2026-10.md) · [Riesgos de concurrencia](./RIESGOS_CONCURRENCIA_SAAS_2026-10.md) · [Arquitectura propuesta](./ARQUITECTURA_SAAS_PROPUESTA_2026-10.md) · [Plan de migración](./PLAN_MIGRACION_SAAS_2026-10.md) · [Decisiones pendientes](./DECISIONES_PENDIENTES_SAAS_2026-10.md) |

> **Documentos previos.**
> - [`database-schema.md`](./database-schema.md) (junio de 2026) describe el esquema **v1** y está **desactualizado**: le faltan oficinas v11, cuadres v14, custodia v15, capital por Administrador v16, plano de control v13 y los estados de pago, solicitudes y desembolso. Este inventario lo sustituye como referencia del modelo.
> - [`CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md`](./CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md) define **solo** el plano de control Owner ↔ empresas y excluye expresamente la operación financiera. Sigue vigente y no se duplica aquí.

---

## 1. Resumen

ADEX es hoy una aplicación **local-first sin servidor**:
- Cada navegador guarda **todo** (empresa, usuarios, contraseñas, cartera, caja y cuadres) en su propia IndexedDB (`RutaCashDB`, Dexie, esquema **v16**, 28 tablas).
- La "sincronización" no envía nada (`src/services/syncService.ts:1-20`).

Las reglas financieras ya están **centralizadas en servicios** que validan permisos y estado dentro de transacciones Dexie: 40 transacciones en 17 archivos. Además están cubiertas por 1.490 pruebas. Es la mejor base posible para migrar, pero esas garantías **solo valen dentro de un navegador**.

Para el SaaS hay cuatro hallazgos que condicionan el diseño:
1. **Autenticación local en texto plano:**
   - las contraseñas se guardan y comparan sin hash (`authService.ts:68`, `useAuth.ts:125-131`);
   - la sesión persistida en `localStorage` (`rutacash-auth`) incluye el objeto de usuario **con su contraseña** (`useAuth.ts:146-152`).
2. **20 escrituras directas desde pantallas.** Ninguna sobre tablas de dinero, pero sí sobre usuarios, rutas, clientes, categorías, empresa y visitas (§6).
3. **La idempotencia por `operationId` existe solo en 5 servicios.** Los pagos (`registerPayment`) no la tienen (§11).
4. **Los periodos dependen del reloj y la zona horaria del dispositivo** (`localMidnightISO`, `periodClosableFrom`). El servidor necesitará zona horaria por empresa.

## 2. Estructura de módulos

| Carpeta | Contenido | Observación para SaaS |
|---|---|---|
| `src/models/types.ts` | Tipos de dominio (entidades, estados, `AuditAction`) | Base del contrato de datos del servidor |
| `src/lib/` (42 archivos) | **Reglas puras** sin Dexie: `permissions.ts`, `cashSettlementRules.ts`, `capitalAllocation.ts`, `settlementPeriods.ts`, `paymentState.ts`, `activeCredit.ts`, `expenseAttribution.ts`, `interestRatePolicy.ts`, `movementHistory.ts`… | **Reutilizables en un servidor TypeScript sin cambios.** Están probadas de forma aislada |
| `src/services/` (29 archivos) | Lógica con persistencia: validan permisos, releen estado y escriben en transacción | Son los **comandos** que pasarán al servidor |
| `src/pages/` (admin, collector, secretario, socio, owner) | Pantallas; 41 importan la base directamente | Deben pasar a leer y escribir a través de una API |
| `src/hooks/` | `useAuth` (sesión, `persist`), `useActiveRoute`, `useDataRevision` (reactividad por `storagemutated`) | La reactividad entre pestañas pasará a eventos del servidor |
| `src/platform/` | Plano de control Owner (`controlPlane.ts`, `localDatabases.ts` como única frontera con Dexie) | Ya diseñado como repositorio inyectable (`SaaSControlPlane`) |
| `scripts/` | `prod-smoke.mjs` (smoke de caja negra), `verify-deploy.mjs` (marcadores del bundle) | Se conservan como puertas de aceptación |
| `tests/` | 26 suites (Dexie real sobre `fake-indexeddb` y harness `MemoryDb`) | Base de la batería de contratos del servidor |

## 3. Modelo Dexie: versiones de esquema

`src/lib/db.ts` (673 líneas). Todas las migraciones son **aditivas y no destructivas**, salvo la v3, revertida en la v11.

| Versión | Cambio |
|---|---|
| v1 | Esquema base: 17 tablas (empresas, oficinas, rutas, usuarios, clientes, ventas, parcelas, pagos, visitas, gastos, capital, transferencias, retiros, cashbox, liquidaciones, auditoría) |
| v2 | `saleRequests` (solicitudes de venta del Cobrador) |
| v3 | Elimina oficinas e índices `officeId` (revertido en la v11) |
| v4 | `partnerCashMovements` (Caja socios) |
| v5 | Roles y permisos: `paymentAdjustmentRequests`, índices `state`, `correctionOfPaymentId`, `reversesPaymentId`; `routeId` → `authorizedRouteIds` |
| v6–v10 | Solo `upgrade()` de datos: Admin *fail closed*, rol base + rutas, consistencia usuario↔ruta, fecha real de finalización, atribución del efectivo |
| v11 | Vuelven las oficinas: Empresa → Oficina → Ruta; `Route.officeId` como única fuente |
| v12 | Liquidaciones semanales persistentes |
| v13 | Separación Plataforma/Empresa: `platformUsers`, `companyControl`, `saasPayments`, `controlEvents` |
| v14 | `cashSettlements` (cuadre por trabajador, índice `[routeId+userId]`) |
| v15 | `cashCustodyMovements` (Base física por trabajador) |
| v16 | Capital por Administrador: `capitalLedger`, `routeCapitalControllerEvents`, `routes.capitalControllerAdminId` |

## 4. Tablas, claves e índices (v16)

Todas tienen clave primaria `id` (UUID generado en el cliente), salvo `companyControl`, que usa `companyId`. Las relaciones son por convención: **IndexedDB no impone claves foráneas**.

| Tabla | Índices | Relación principal | Naturaleza |
|---|---|---|---|
| `tenants` | status, plan | — | Empresa |
| `offices` | tenantId, status | tenant | Estructura |
| `routes` | tenantId, cobradorId, status, capitalControllerAdminId | tenant, oficina (`officeId` sin índice), responsable de capital | Estructura |
| `users` | tenantId, routeId, email, rol, status | tenant, `authorizedRouteIds[]` | Identidad (incluye la contraseña) |
| `clients` | tenantId, routeId, documento, status | ruta | Cartera |
| `sales` | tenantId, routeId, clientId, status, createdAt | cliente, ruta, `saleRequestId` | **Financiera** |
| `installments` | saleId, numero, status | venta | **Financiera** (derivada) |
| `payments` | tenantId, saleId, clientId, routeId, collectorId, syncStatus, state, correctionOfPaymentId, reversesPaymentId, createdAt | venta, responsable | **Financiera, append-only con marcas** |
| `noPaymentVisits` | tenantId, saleId, clientId, routeId, collectorId, syncStatus | venta | Operativa |
| `expenseCategories` | tenantId, activa | — | Catálogo |
| `expenses` | tenantId, routeId, categoryId, userId, syncStatus | ruta/trabajador/bolsa (`funding`) | **Financiera** |
| `capitalMovements` | tenantId, routeId, tipo | ruta, `adminId` | **Financiera** |
| `transfers` | tenantId, routeOrigenId, routeDestinoId | rutas/socio | **Financiera** |
| `withdrawals` | tenantId, routeId | ruta, `adminId` | **Financiera** |
| `cashboxMovements` | tenantId, routeId, tipo, fecha | — | Legado v1 (sin escritores actuales) |
| `weeklySettlements` | tenantId, routeId, semanaInicio | ruta | **Cierre** (documento versionado) |
| `auditLogs` | tenantId, userId, action, entityType, entityId, createdAt | — | Auditoría |
| `saleRequests` | tenantId, routeId, collectorId, clientId, status, requestedAt | cliente, venta | Flujo comercial |
| `partnerCashMovements` | tenantId, partnerId, type, relatedTransferId, fecha | socio, transferencia | **Financiera** |
| `paymentAdjustmentRequests` | tenantId, routeId, paymentId, saleId, status, requestedAt | pago | Flujo de corrección |
| `cashSettlements` | tenantId, routeId, userId, status, [routeId+userId] | ruta+trabajador | **Cierre** (cuadre por trabajador) |
| `cashCustodyMovements` | tenantId, routeId, tipo, fromUserId, toUserId, createdAt, relatedTransferId | personas, transferencia | **Financiera** (custodia) |
| `capitalLedger` | tenantId, tipo, fromAdminId, toAdminId, routeId, createdAt | empresa↔Admin | **Financiera** (bolsas) |
| `routeCapitalControllerEvents` | tenantId, routeId, createdAt | ruta | Histórico del responsable |
| `platformUsers` | email, status | — | Plano de control (Owner) |
| `companyControl` | (pk companyId), status | tenant | Plano de control |
| `saasPayments` | companyId, periodo, status | tenant | Plano de control |
| `controlEvents` | companyId, type, at | tenant | Plano de control |

**Implicaciones:**
- La integridad referencial la mantienen hoy los servicios.
- Los identificadores son UUID creados en el dispositivo. Sirven como claves de importación, pero **no garantizan que dos navegadores no tengan la misma empresa creada dos veces con identificadores distintos** (ver el [plan de migración](./PLAN_MIGRACION_SAAS_2026-10.md) §4).

## 5. Servicios financieros y dependencias

| Servicio | Comandos (escritura) | Lecturas o reglas clave | Depende de |
|---|---|---|---|
| `capitalControlService.ts` | `registerCompanyCapital`, `withdrawCompanyCapital`, `allocateCapitalToAdmin`, `returnCapitalFromAdmin` (todas sobre `registrarLedger`), `setRouteCapitalController`, `withCapitalControllerGuard` | `getAdminPoolStatement`, `getCompanyAvailableCapital`, `loadCapitalRows` | `capitalAllocation.ts`, `authz` |
| `routeFundsService.ts` | `registerCapital`, `registerTransfer` (rutas, socio, entrega en mano), `registerWithdrawal` | `fundsTables`, `getRouteAvailableFunds` | conciliación, custodia, `periodGuard` |
| `cashCustodyService.ts` | `assignBaseToWorker`, `returnBaseFromWorker`, `transferBaseBetweenWorkers` | `reconciliationTables`, `custodianBlockedReason` | `routeCashReconciliation` |
| `saleRequestService.ts` | `createSaleRequest`, `approveSaleRequest`, `rejectSaleRequest`, `createDirectSale`, `confirmDisbursement`, `markSaleLost` | `assertDisbursementFunds`, `disbursementBlockedReason`, `directSaleLimit` | cashbox, custodia, cuadre, `periodGuard`, permisos |
| `paymentService.ts` | `registerPayment` | resolución del cobrador responsable | `installmentEngine`, `periodGuard` |
| `paymentCorrectionService.ts` | `correctPayment`, `requestPaymentAdjustment`, `approvePaymentAdjustment`, `annulPayment` | `adjustmentEntryDate`, `isPaymentInClosedPeriod`, `recomputeSale` | conciliación, `periodGuard` |
| `expenseService.ts` | `createExpense` (empresa/ruta/trabajador), `reverseAdminExpense`, `refundAdminExpense` | `listVisibleExpenses`, `payablePoolsFor` | capital, conciliación, `periodGuard` |
| `movementReversalService.ts` | `reverseCapitalMovement`, `reverseWithdrawal`, `reverseTransfer` | — | capital, conciliación, `periodGuard` |
| `partnerCashService.ts` | `createPartnerMovement` | `partnerBalance`, `buildPartnerSummaries` | permisos |
| `cashSettlementService.ts` | `closeCashSettlement`, `reopenCashSettlement` | `personalCashPosition`, `previewCashSettlement` | `cashSettlementRules.ts` |
| `settlementService.ts` | `closeSettlement`, `reopenSettlement` | `listSettlementsOfRoute` | `weeklySettlementEngine`, `settlementPeriods.ts` |
| `cashboxEngine.ts` | — | `getRouteBase` (**fuente única de la Base**), `hasCapitalForSale`, `getCollectorCashSummary` | — |
| `routeCashReconciliation.ts` | — | `computeRouteCashReconciliation` (`libro = sin asignar + Σ posiciones`) | cuadre, cashbox |
| `periodGuard.ts` | — | `closedPeriodBlockedReason` (D7) | `settlementPeriods.ts` |
| `financialReconciliation.ts` | — | `reconcileFinancials` (**diagnóstico de solo lectura** de datos heredados) | `paymentState.ts` |
| `routeService.ts`, `officeService.ts`, `routeAssignment.ts` | Alta y edición de rutas y oficinas, asignaciones | `assertRouteOperationalContext` | capital (responsable) |
| `movementHistoryService.ts`, `reportService.ts`, `adminDashboardService.ts` | — | Proyecciones de lectura con alcance | — |
| `syncService.ts` | Cambia `syncStatus` de pagos, visitas y gastos | — | No envía nada fuera del dispositivo |

## 6. Escrituras directas desde pantallas (20)

Ninguna toca tablas de dinero (pagos, ventas, capital, transferencias, retiros, gastos, custodia, cuadres). Todas deberán pasar a comandos del servidor.

| Archivo | Escritura | Riesgo para SaaS |
|---|---|---|
| `pages/admin/UsersPage.tsx:191,204,212,218,248,290` | `users.update/add/delete` (dentro de `withCapitalControllerGuard` para responsables) | Alta: identidad, roles, contraseñas y **borrado físico** de usuarios |
| `pages/admin/RoutesPage.tsx:369,410` | `routes.update` (estado), `routes.delete` | Alta: **borrar una ruta** con historia financiera |
| `pages/admin/ClientsPage.tsx:235,251,275` | `clients.update/add/delete` | Media: borrado de cliente con créditos |
| `pages/admin/ExpenseCategoriesPage.tsx:67,71,80,101` | Catálogo | Baja |
| `pages/admin/SettingsPage.tsx:113` | `tenants.update` | Media (configuración de empresa) |
| `pages/collector/CollectorNewClientPage.tsx:153` | `clients.add` | Baja |
| `pages/secretario/SecretarioClientsPage.tsx:81` | `clients.update` (edición limitada) | Baja |
| `pages/collector/NoPaymentPage.tsx:47` | `noPaymentVisits.add` | Baja (sin dinero) |
| `hooks/useAuth.ts:131` | `users.update` (cambio de contraseña propia) | Alta (contraseña en texto plano) |

**Lecturas directas:** 50 archivos de pantallas, componentes y hooks leen la base directamente (por ejemplo, `ActiveSalesPage`, `CapitalPage`, `CollectorRoutePage`, `WeeklySettlementPage`). La reactividad depende de `useDataRevision`, que escucha `storagemutated` de Dexie.

## 7. Permisos

- **Fuente única:** `src/lib/permissions.ts`:
  - `ROLE_CAPABILITIES`, `INCOMPATIBLE_BY_ROLE` y `ROUTE_SCOPED`;
  - `can()`, que es **puramente por rol y rutas**: los permisos individuales concedidos se ignoran por diseño;
  - `routeCashAuthorityError()`, con tres niveles: `structural` (solo el responsable), `settle` (responsable, SuperAdmin o Supervisor de la ruta) y `correct` (responsable o SuperAdmin; sin responsable válido se rechaza).
- **Aplicación en servicios:** `src/services/authz.ts` (`assertCan`, `assertRouteCashAuthority`).
- **Roles de empresa:** `superadmin`, `admin`, `supervisor`, `cobrador`, `secretario`, `socio`. El rol `owner` es de plataforma y vive en `platformUsers`.
- **Alcance:** `User.authorizedRouteIds` y `tenantId`. Una Oficina inactiva bloquea operaciones nuevas (`assertRouteOperationalContext`).
- Es una lógica pura y probada: `permissions` tiene 559 casos.

## 8. Empresas, oficinas, rutas y trabajadores

```
Empresa (tenants) → Oficina (offices) → Ruta (routes, officeId) → Clientes / Ventas
                       └─ Usuarios: rol + authorizedRouteIds (sin oficina propia)
Capital: SuperAdmin → bolsa de Administrador (capitalLedger) → Ruta (capitalMovements, adminId)
Responsable de capital: Route.capitalControllerAdminId (uno por ruta; histórico en routeCapitalControllerEvents)
Efectivo de la ruta: Base = Sin asignar + Σ posiciones de trabajadores (routeCashReconciliation)
```

## 9. Cuentas separadas por rol

- Cada `User` tiene **un único rol** y un correo **único en todo el sistema** (`UsersPage.tsx:170-172`). El inicio de sesión es por correo (`authService.ts:66`).
- Una persona que actúa como Administrador, Socio y Supervisor necesita **tres cuentas con tres correos**.
- No existe vínculo entre esas cuentas ni herencia de permisos. Es intencional y está documentado en la pre-Ronda 6.
- El servidor debe decidir si conserva este modelo o separa **identidad** (persona) de **membresía** (rol en una empresa) sin herencia de permisos: decisión DS-05.

## 10. Cuadres, cierres y conciliaciones

| Mecanismo | Implementación | Corte |
|---|---|---|
| Cuadre por trabajador | `cashSettlementService.closeCashSettlement` + `cashSettlementRules.ts` | **Por instante** `(desde, hasta]`, sellado bajo bloqueo; arrastre solo de faltantes |
| Liquidación semanal | `settlementService.closeSettlement` (D29: solo periodos terminados), versionada y reabrible con motivo | **Por fecha contable**; documento con cifras archivadas |
| Periodo cerrado | `periodGuard.closedPeriodBlockedReason` en pagos, desembolsos, gastos, fondos y anulaciones (D7) | Fecha contable + zona horaria del dispositivo |
| Conciliación de ruta | `routeCashReconciliation.computeRouteCashReconciliation`: dos vías independientes que deben coincidir (`cuadra`) | Instante |
| Conciliación de capital | `capitalAllocation.verifyCapitalInvariants` (conservación empresa ↔ bolsas ↔ rutas) | — |
| Diagnóstico heredado | `financialReconciliation.reconcileFinancials` (solo lectura) | — |

## 11. Autenticación, auditoría e idempotencia

**Autenticación:**
- `authService.authenticateUser`: búsqueda por correo y **comparación en claro** de `user.password`.
- Sesión: Zustand `persist` en `localStorage` (`rutacash-auth`), con el usuario completo incluida la contraseña. Se revalida contra la base en cada arranque.
- Owner: `platform/platformAuthService.ts` con su propia sesión (`useOwnerAuth`).
- **No hay autoridad externa:** cualquiera con acceso al navegador puede leer y modificar IndexedDB.

**Auditoría:**
- `auditService.logAction` escribe en `auditLogs` (67 acciones tipadas en `AuditAction`), desde 19 archivos.
- Casi siempre se ejecuta **fuera** de la transacción de negocio y como mejor esfuerzo (`.catch(() => undefined)`). Una operación puede quedar consolidada sin su registro de auditoría.
- **El servidor debe escribir la auditoría en la misma transacción.**

**Idempotencia:**

| Mecanismo | Dónde |
|---|---|
| `operationId` = id del registro; mismo id y mismos datos devuelve el registro guardado; datos distintos se rechazan | `capitalControlService` (`operationIdOf`), `routeFundsService`, `cashCustodyService`, `expenseService`, `partnerCashService` |
| Por estado releído bajo bloqueo (un segundo intento se rechaza) | Desembolso (`disbursementBlockedReason`), aprobación/rechazo de solicitudes, anulaciones (`assertVigente`), corrección de pagos (6C.1), cierres (6C.1) |
| **Sin idempotencia** | `registerPayment` (un reintento crea otro pago; la interfaz solo deshabilita el botón), `createDirectSale` para Supervisor/Admin (puede crear dos créditos a un cliente), altas de clientes y usuarios |

## 12. Dependencias del almacenamiento local

| Dependencia | Cantidad / ubicación | Naturaleza |
|---|---|---|
| Archivos que importan `@/lib/db` | ≈ 80 (41 pantallas, componentes y hooks; 26 servicios; `lib/scope.ts`, `lib/factoryReset.ts`, `lib/expenseCategoryDefaults.ts`; `platform/*`) | Acceso directo a Dexie |
| Transacciones Dexie | 40 en 17 archivos (más en servicios financieros: `saleRequestService` 6, `expenseService` 4, `routeAssignment` 4) | Atomicidad local |
| Reactividad | `useDataRevision` (`storagemutated` + BroadcastChannel) | Solo entre pestañas del mismo navegador |
| `localStorage` | `rutacash-auth`, `rutacash-active-route`, sesión Owner, `lastLoginEmail.ts`, `factoryReset.ts` | Sesión y preferencias |
| Reloj del dispositivo | `nowISO()`, `today()`, `localMidnightISO()`, `periodClosableFrom()` | Instantes de cuadre y fechas contables |
| Restablecimiento | `lib/factoryReset.ts` (`wipeLocalInstallation`) | Borra la instalación local |

## 13. Clasificación de operaciones

| Clase | Operaciones |
|---|---|
| **Lecturas** | Base y desglose (`getRouteBase`, `computeRouteBaseBreakdown`), conciliación, historial de movimientos, reportes, dashboard, liquidación provisional (`generateWeeklySettlement`), cuadre provisional (`previewCashSettlement`), bolsas (`getAdminPoolStatement`) |
| **Escrituras simples** (sin dinero) | Clientes, categorías, configuración de empresa, visitas sin pago, oficinas, rutas (alta, edición, estado), usuarios, solicitudes de venta (`createSaleRequest`), rechazo de solicitudes |
| **Operaciones financieras transaccionales** | Depósito/asignación/devolución de capital, cambio de responsable, colocación, retiro, transferencias (incluida la entrega en mano), entrega/devolución/traspaso de Base, aprobación de venta, venta directa, desembolso, castigo, pago, corrección/ajuste/anulación de pago, gastos (empresa, ruta, trabajador), anulación y reintegro de gastos de bolsa, anulaciones de capital/retiro/transferencia, movimientos de Caja socios |
| **Procesos de conciliación y cierre** | Cuadre por trabajador (cierre y reapertura), liquidación semanal (cierre y reapertura), `verifyCapitalInvariants`, `reconcileFinancials`, sincronización de `syncStatus` |
| **Requieren coordinación entre dispositivos** (imposible hoy) | Todo lo financiero cuando el responsable, el trabajador y el Administrador usan equipos distintos: desembolsos contra la misma Base, entrega de Base frente a desembolso, pagos sobre el mismo crédito, cierres mientras llegan movimientos, cambio de responsable, solicitudes de Base, confirmaciones de recepción, ratificaciones |

## 14. Conclusión del inventario

- **Ventaja:** el dominio está concentrado en servicios y reglas puras, con permisos fail-closed y más de 1.400 pruebas de invariantes. Migrar es sobre todo **mover la ejecución de los comandos al servidor**, no redescubrir las reglas.
- **Bloqueantes:** sin identidad central ni almacenamiento compartido, ninguna garantía financiera se mantiene entre dispositivos. La autenticación actual no es apta para producción multiusuario (contraseñas en claro, en IndexedDB y en `localStorage`).
