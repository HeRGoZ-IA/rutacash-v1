# Ronda 25 · Capital, Caja principal y Transferencias de CLEAN sobre el servidor

Fecha: 2026-10-18 · Base: `095ab5b` + cambios locales de la Ronda 24 · Estado: **local, sin commit ni publicación**.

## 1. Pantallas originales de CLEAN en uso

| Menú | Pantalla | Forma |
|---|---|---|
| Capital (Super Admin) · Caja principal (Administrador) | `CapitalPage` + `AdminPoolPanel` + asistente `OperationWizard` | copias con cambios mínimos marcados (CapitalPage, AdminPoolPanel); asistente original |
| Transferencias | `TransfersPage` | copia con un cambio marcado |
| Historial | `MovementHistoryPage` | original |
| Comprobante | `MovementReceiptPage` | original |
| Retiros | `WithdrawalsPage` | original |

Ya no redirigen a `/operaciones`. La ruta `/admin/capital/transicion` (activación del capital centralizado en CLEAN) lleva a Capital: en el SaaS el modelo centralizado rige desde el alta.

## 2. Correspondencia control original → servidor

| Control de CLEAN | Operación del servidor |
|---|---|
| Capital → Ingresar capital | `POST /v1/capital/company/deposits` (COMPANY_DEPOSIT) |
| Capital → Retiro de capital de la empresa | `POST /v1/capital/company/withdrawals` |
| Capital → Asignar a Administrador / Asignar más | `POST /v1/capital/allocations` |
| Capital → Detalle → Recoger | `POST /v1/capital/admin-returns` |
| Capital → Rutas y responsable → Cambiar / Asignar | `PUT /v1/routes/:id/capital-controller` |
| Caja principal / Transferencias → Entregar capital (asistente) | `POST /v1/capital/deliveries` (WORKER_DELIVERY) |
| Caja principal / Transferencias → Recibir devolución (asistente) | `POST /v1/capital/returns` (WORKER_RETURN) |
| Movimientos de la ruta → Anular entrega | `POST /v1/capital/operations/:id/reverse` |
| Transferencias → Registrar aporte de socio | `POST /v1/capital/partner-contributions` |
| Transferencias → Anular transferencia entre rutas | `POST /v1/capital/operations/:id/reverse` (ROUTE_REASSIGNMENT) |
| Caja principal → Registrar gasto | `POST /v1/expenses` (Ronda 24) |
| Disponibles, bolsas, custodia | `GET /v1/capital/summary`, `GET /v1/capital/custody` |
| Listas, movimientos, historial, comprobante | `GET /v1/capital/operations` (vista de cada operación con la forma del registro de CLEAN C1) + `GET /v1/expenses` |
| Aviso «El capital no cuadra» | `GET /v1/capital/reconciliation` (comprobaciones fallidas) |

Cada comando de dinero lleva el id de operación que la pantalla ya generaba al abrir el formulario: un doble clic o un reintento devuelven la misma operación. Descripción/motivo: mínimo 3 caracteres (queda en la auditoría). La fecha es la de la empresa; el servidor no registra otra.

**Cómo se leen los registros.** `online/src/runtime/capitalRecords.ts` presenta cada operación del libro central con la forma del registro que CLEAN crea para ella (libro de capital, capital, retiro, custodia, transferencia; equivalencias C1 documentadas en el servidor). Solo se usan para listar y consultar: ninguna cifra se calcula sumándolos.

## 3. Flujos probados de principio a fin (interfaz original → servidor)

Super Admin: ingresar capital, retirar capital de la empresa, asignar a un Administrador, recoger de un Administrador, cambiar el responsable de capital de una ruta, consultar la Caja principal de un Administrador.
Administrador: Caja principal con su bolsa, entregar capital a un trabajador, recibir su devolución, anular una entrega, registrar el aporte de un socio, historial y comprobante.

## 4. Diferencias y pendientes (motivo real)

| Tema | Situación |
|---|---|
| «Capital total controlado», «Asignado», «En rutas», «En rutas sin responsable», capital colocado por ruta, «Capital bajo mi responsabilidad», conciliación de la bolsa | Cifras del libro local de CLEAN sin equivalente con el mismo significado en el servidor. Se muestran «—» con aviso. Requiere decidir su definición en el servidor. |
| Historial de responsables de una ruta | El servidor lo audita pero no tiene consulta. El modal lo dice. |
| Operación con socio (Caja socios: Ruta → Socio, Socio ↔ Socio) | No existe en el servidor (decisión D1). Botón deshabilitado con el motivo. |
| Traspaso entre trabajadores | Existe en el servidor; en CLEAN vive en Liquidación → Cuadre (módulo de la próxima ronda). |
| Reasignación entre rutas en un solo paso | Existe en el servidor (y se lista y anula en Transferencias); el asistente de CLEAN centralizado lo hace en dos pasos (devolución + entrega), que funcionan. |
| Saldo heredado de cajas de ruta | Siempre 0: el SaaS nunca tuvo caja de ruta. |
| Listados | El servidor entrega las 500 operaciones más recientes por consulta (general y por ruta). Con años de actividad hará falta paginación en la API. |
| «Primeros pasos» del Administrador | Online lo calcula con su alcance (el servidor solo le entrega sus rutas); CLEAN con toda la empresa. |

## 5. Comparación visual

`tmp/r25/compare/comparacion.html`: 39 combinaciones (Super Admin: acceso + 15 pantallas × 1366 y 390; Administrador: Dashboard, Caja principal, Transferencias, Historial × 1366 y 390) con CLEAN en modo de capital centralizado. **37 idénticas** en textos fijos y estilos medidos; las 2 restantes son la diferencia de alcance de «Primeros pasos».

## 6. Pruebas

- `tmp/r25/e2e-capital.mjs`: **50/50** (empresas sintéticas `stg-r25-*`, Chrome real): los flujos del punto 3; idempotencia (triple clic y repetición con el mismo id), sin consumo de capital inexistente, permisos por rol y por responsable, membresías sin permisos acumulados, aislamiento entre empresas, una auditoría por operación, conciliación del servidor OK (incluye periodos cerrados intactos), refresco sin parpadeo y cambios de otros visibles sin navegar, solo la base de sesión en el navegador, Empresa Demo y demás empresas intactas.
- `tmp/r24/e2e.mjs` (regresión Ronda 24): **62/62**.
- SaaS `npm test`: typecheck OK, unitarias 13/13, base de datos 312/313 (1 omitida: Auth real sin staging).
- Typecheck de `online/` y de CLEAN: 0 errores.

**Cambio en una prueba del servidor:** `saas/test/integration/expenses.test.ts` (SEC5-003) buscaba los nombres `Dexie`/`RutaCashDB` en todo `online/src`; desde la Ronda 24 el puente los usa precisamente para sustituir la base local. Ahora se permiten solo dentro de `bridge/` y la prueba comprueba además que `dexie` se resuelve al sustituto que falla y que el `db` del puente rechaza las escrituras. El código del servidor no cambió.

## 7. Empresa DEMO · inventario de escenarios para capital y transferencias

No se creó ni modificó nada en la DEMO. Para comprobar estas pantallas con ~6 meses de actividad ficticia hacen falta, como mínimo:

1. **Estructura**: 2 oficinas, 4 rutas (una sin oficina), 2 Administradores responsables + 1 Administrador secundario (asignado, no responsable), 1 Supervisor, 3 Cobradores, 1 Socio, 1 Secretario; una persona con dos membresías.
2. **Capital de empresa**: ingresos mensuales, un retiro, un ingreso anulado.
3. **Bolsas**: asignaciones y devoluciones mensuales por Administrador; un Administrador desactivado con historia; una asignación rechazada por fondos.
4. **Responsables**: un cambio de responsable a mitad de periodo con motivo; una ruta temporalmente sin responsable (operaciones rechazadas `CAPITAL_CONTROLLER_MISSING`).
5. **Entregas y devoluciones**: base diaria por Cobrador y devoluciones al cierre; devoluciones registradas por el Supervisor; una entrega anulada a tiempo y otra cuya anulación se rechaza porque el dinero ya se usó.
6. **Traspasos**: entre trabajadores de una ruta; reasignación entre dos rutas del mismo responsable, y una anulada.
7. **Socios**: aportes a la bolsa del responsable y uno anulado.
8. **Desembolsos y cobros**: préstamos desde la custodia del Cobrador y desde la bolsa del Administrador; cobros en custodia y cobros no personales a la bolsa, con alguna anulación.
9. **Gastos**: de ruta pagados con la bolsa, de trabajador, administrativos de empresa y de bolsa, reintegros y anulaciones.
10. **Cuadres**: cuadres semanales con retorno a la bolsa, faltantes arrastrados, sobrantes en control y una reapertura.
11. **Cierres**: ~24 semanas cerradas por ruta y un intento de registrar en un periodo cerrado (rechazado).
12. **Volumen**: más de 500 operaciones por ruta, para fijar el comportamiento de los listados (paginación pendiente en la API).
13. **Aislamiento**: una segunda empresa con datos parecidos para verificar que nada cruza.

Cada escenario debe cerrar con la conciliación del servidor en OK y un registro de auditoría por operación. La carga debe hacerse con un mecanismo sintético seguro cuando estén los módulos de Caja y Liquidación para verificar sus resultados.

## 8. Demostración local

- `tmp\r25\ABRIR_PRUEBA_CAPITAL.cmd`: crea una **empresa de prueba nueva** (Super Admin, Administrador, Cobrador, Socio, una ruta, capital inicial), muestra las credenciales y las borra al cerrar. No toca la DEMO.
- `tmp\r24\ABRIR_ADEX_ONLINE_CLEAN.cmd`: la DEMO en consulta (cualquier operación confirmada se registraría allí).
