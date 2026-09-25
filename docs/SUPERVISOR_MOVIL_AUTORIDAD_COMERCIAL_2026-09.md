# RUTACASH — SUPERVISOR MÓVIL: AUTORIDAD COMERCIAL Y AUTORIZACIONES

**Fecha:** 2026-09-24 · **Baseline:** 1145 PASS / 0 FAIL (`93ab3b8`) · **Después:** 1183 PASS / 0 FAIL

---

## 1. Modelo funcional

```
SUPERVISOR = experiencia móvil del Cobrador
           + otorga créditos directamente (sin solicitud)
           + revisa, aprueba, rechaza, modifica condiciones y confirma por teléfono
             las solicitudes de los Cobradores de SUS rutas
           + ve el globo de autorizaciones pendientes de su RUTA ACTIVA
```

Sigue siendo el rol `supervisor`: no se fusiona con Admin/Super Admin, no hay "modo
Supervisor" para cuentas Admin, no hay app ni páginas aparte. Las diferencias se
expresan con `can()`; la seguridad real la revalida el servicio.

## 2. Capabilities

| Capability | Antes (Supervisor) | Ahora | Acotada por ruta |
|---|---|---|---|
| `sale.createDirect` | ❌ incompatible | ✅ | ✅ |
| `authorization.access` | ❌ | ✅ | ✅ |
| `authorization.approve` | ❌ incompatible | ✅ | ✅ |
| `authorization.reject` | ❌ incompatible | ✅ | ✅ |
| `authorization.modifyConditions` | ❌ incompatible | ✅ | ✅ |
| `authorization.phoneConfirm` | ❌ incompatible | ✅ | ✅ |

**No cambió:** usuarios, rutas, configuración, `capital.manage`, `transfer.create`,
`partnerCash.*`, `settlement.*`, `cashSettlement.reopen`, caja e indicadores
consolidados, corrección/anulación de pagos, acceso Owner (`SUP-CREDIT-009`).
Cobrador: sin cambios (`sale.createDirect` y `authorization.*` siguen incompatibles o
ausentes). Socio: sin autoridad comercial (`SUP-AUTH-010`).

## 3. Semántica real de `sale.createDirect` (auditada en código)

| Pantalla | Capability | Servicio | Estado persistido | Siguiente paso |
|---|---|---|---|---|
| Nueva venta (móvil) · botón "Crear venta" | `sale.createDirect` | `createDirectSale` | `Sale` activa, **desembolsada** en el acto, parcelas | Recaudo |
| Nueva venta (móvil) · "Enviar solicitud de venta" | `sale.createRequest` | `createSaleRequest` | `SaleRequest` `pending` | Autorización |
| Autorizaciones (Admin / Secretario / **Supervisor**) · Aprobar | `authorization.approve` (+ `modifyConditions`, `phoneConfirm`) | `approveSaleRequest` | `SaleRequest` `approved` + `Sale` con desembolso **pendiente** | Desembolsos |
| Autorizaciones · Rechazar | `authorization.reject` | `rejectSaleRequest` | `SaleRequest` `rejected` + motivo | — |
| Desembolsos (móvil) · Confirmar | `sale.confirmDisbursement` | `confirmDisbursement` | `Sale` desembolsada, `disbursedByCollectorId` | Recaudo |

**Conclusión del gate de seguridad (A2):** `sale.createDirect` solo permite crear una
venta sin pasar por una solicitud. **No** concede ninguna facultad administrativa. Se
reutiliza para el Supervisor.

Al auditarla aparecieron cuatro huecos, que se corrigieron **antes** de dársela a nadie más:

| # | Hallazgo | Corrección |
|---|---|---|
| H1 | `createDirectSale` dejaba la venta **desembolsada** sin registrar quién entregó el dinero. Con el Admin (sin caja personal) no importaba; con un Supervisor, el efectivo le salía del bolsillo sin descontarse de "Mi efectivo" | Se registran `disbursedByUserId`, `fechaDesembolso`, `disbursedAt` (sellado dentro de la transacción) y, si el actor tiene caja personal, `disbursedByCollectorId` (misma regla que `confirmDisbursement`) |
| H2 | Tasa, fecha, días de pago, **límite de venta directa** y **capital** se validaban solo en la pantalla | `assertSaleIntegrity` en el servicio: empresa, ruta existente y **activa**, Oficina activa, cliente de ESA ruta y activo, valor/parcelas enteros > 0, tasa 10/20, frecuencia válida, días 0–6, inicio ≥ hoy. Venta directa: además `directSaleLimit` (menor entre ruta y usuario) y `hasCapitalForSale` |
| H3 | El alta **cliente + venta** (`CollectorNewClientPage`) escribía la venta directa en la propia pantalla, sin pasar por el servicio y con otro cálculo de límite | Pasa por `createDirectSale` / `createSaleRequest` con `{ newClient }` (cliente y venta en una sola transacción). Mismo límite (`directSaleLimit`) en ambas pantallas |
| H4 | `approveSaleRequest` / `rejectSaleRequest` no comprobaban que la solicitud siguiera **pendiente** y usaban el objeto de la pantalla | Ver §10 |

**Decisión sobre el desembolso (Bloque I):** el flujo directo existente ya era
"otorgar = entregar". Se conserva: el crédito directo del Supervisor queda desembolsado
y cargado a **su** efectivo (`SUP-CREDIT-010`: cobra 600.000, otorga 400.000 → Mi
efectivo 200.000, y el cuadre también da 200.000). El crédito **aprobado** sigue
separado: queda con desembolso pendiente y se entrega desde Desembolsos.

## 4. Flujo Cobrador (sin cambios de regla)

Nueva venta → **Enviar solicitud de venta** (no tiene "Crear venta"). La solicitud queda
`pending`; no puede aprobarla, rechazarla ni saltársela (`SUP-CREDIT-008`,
`SUP-AUTH-006/007`, `SMOKE SA-06`).

## 5. Flujo Supervisor

- **Nueva venta → Crear venta**: crédito directo, sin solicitud, con todas las
  validaciones del §3. Si supera el límite de venta directa, la misma pantalla ofrece
  "Enviar solicitud" (regla ya existente) y **no puede aprobársela él mismo**.
- **Inicio → Autorizaciones (globo)** → lista de pendientes de la ruta activa →
  detalle → Aprobar / Rechazar, y opcionalmente cambiar condiciones y confirmar
  teléfono.

## 6. Autorizaciones

Pantalla operativa `/supervisor/authorizations` (`CollectorAuthorizationsPage`, en la
capa compartida; el Cobrador ve "sin acceso").

- **Lista (tarjetas):** cliente, valor, forma de pago, parcelas, fecha, solicitante,
  estado.
- **Detalle:** cliente (documento, teléfono), ruta, solicitante y fecha; valor,
  interés, total, parcelas × cuota, forma de pago, inicio y fin estimado; historial de
  créditos del cliente (`ClientCreditHistory`, el mismo componente del Admin).
- **Condiciones** (`authorization.modifyConditions`): tasa, forma de pago y días. Las
  solicitadas quedan congeladas (`requested*`) y se registran las finales
  (`approved*`), además de la auditoría `CHANGE_SALE_CONDITIONS` con antes y después.
- **Confirmación telefónica** (`authorization.phoneConfirm`): casilla más nota. El
  servicio exige la capacidad para registrar una confirmación nueva.
- **Rechazar:** motivo obligatorio (también lo exige el servicio).
- **Autoría:** `requestedBy` (quien pidió) se conserva siempre; `reviewedBy` y
  `reviewedAt` registran a quien resolvió; auditoría `APPROVE_SALE_REQUEST`,
  `REJECT_SALE_REQUEST` y `PHONE_CONFIRMATION`.
- **Nadie resuelve su propia solicitud.** Tampoco el Supervisor: así el límite de
  venta directa no se puede saltar pidiendo y aprobando uno mismo.

## 7. Scoping

Por **ruta**: `tenantId` propio y `routeId ∈ authorizedRouteIds`. Lo revalida el
servicio con los datos releídos de la base, no con los de la pantalla. Una Oficina no
concede acceso: una ruta hermana no asignada queda fuera (`SUP-AUTH-005`).

## 8. Globo por Route activa

- `listPendingSaleRequestsForRoute(user, tenantId, routeId)` devuelve las pendientes de
  **esa** ruta que el usuario **puede resolver** (con acceso a la ruta y sin las
  propias).
- `countPendingSaleRequestsForRoute` = su longitud → **globo = lista** por construcción.
- Ejemplo verificado: Norte 2 pendientes y Sur 3. Con Norte activa, el globo marca **2**, no 5 (`SUP-BADGE-001/002`).
- El globo va en el chip "Autorizaciones" de Inicio (bloque "Clientes y ventas").
  **La barra inferior sigue con 5 ítems** (`MOBILE-PARITY-011`).
- Admin y Secretario conservan su contador (`countPendingSaleRequestsForUser`, todas
  sus rutas); no se tocó.

## 9. Reactividad

`usePendingRouteSaleRequests` usa `useLiveQuery`, el mismo mecanismo de los badges de la Fase 1, con la ruta en sus dependencias:
- Sube cuando un Cobrador envía una solicitud desde otra pestaña.
- Baja al aprobar o rechazar.
- Se recalcula al cambiar de ruta.

Evidencia:
- **Node:** `liveQuery` observó 0 → 1 → 2 → 1 (`SUP-BADGE-007`).
- **Chrome real:** Juan envía la solicitud por la UI y el globo de Laura pasa a 1 sin F5 (`SMOKE SA-02`).

## 10. Concurrencia

`approveSaleRequest` y `rejectSaleRequest` releen la solicitud **dentro** de su
transacción y solo la resuelven si sigue `pending`. IndexedDB serializa las
transacciones: la primera gana y la segunda recibe `SaleRequestResolvedError`
("Esta solicitud ya fue resuelta.") sin escribir nada.

| Caso | Resultado |
|---|---|
| Admin ‖ Supervisor aprueban | 1 aprobación, 1 venta; el otro: "ya fue resuelta" (`RACE-001`) |
| Supervisor aprueba ‖ Admin rechaza | Una sola transición; estado y ventas coherentes (`RACE-002`) |
| Aprobada → rechazar / aprobar; rechazada → aprobar con objeto viejo | Rechazado, sin cambios (`RACE-003`) |

Antes no existía esta comprobación: dos aprobaciones simultáneas creaban dos ventas.
Admin y Secretario ahora muestran ese mensaje en lugar de un error genérico.

## 11. Responsive

Chrome real con emulación táctil:

| Tamaño | Pantallas | Resultado |
|---|---|---|
| 360×800 | Inicio con globo, lista, detalle, nueva venta, pago | Sin scroll horizontal; botones Aprobar/Rechazar de 48 px |
| 390×844, 412×915 | Lista y detalle con un importe de 8 dígitos ($12.500.000) | Sin scroll horizontal |

Tarjetas en lugar de tablas; navegación completa sin `/admin/*`; sin errores de página.
Paridad anterior intacta: 102/102 comprobaciones.

## 12. Tests

- **Modificados por el cambio de regla** (anotados `[MODIFICADO 2026-09-24 — autoridad comercial del Supervisor]`, todos en `permissions.test.ts`):
  - "supervisor NO puede venta directa" → puede en su ruta y no en una ruta ajena.
  - "supervisor: NO venta directa" → venta directa en su ruta.
  - "supervisor: NO aprueba" → aprueba en su ruta y no en una ruta ajena.
  - "grant NO habilita venta directa en Supervisor" → la misma intención antimanipulación, con `payment.reverse`.
  - "incompatible: supervisor + sale.createDirect" → sustituido por `supervisor + capital.manage` y `cobrador + sale.createDirect`.
- **Nuevos** (`tests/workercash.test.ts`, Dexie real):
  - `SUP-AUTH-001..011`
  - `SUP-CREDIT-001..011`
  - `SUP-BADGE-001..008`
  - `SUP-AUTH-RACE-001..003`
  - `SMOKE-SA-01..06,08`
  - `MOBILE-PARITY-011`
- **Navegador:** SA-01..08, 21/21.

## 13. Decisiones que NO se tocaron

- La regla de responsabilidad del efectivo: el Supervisor que cobra es el responsable, sin selector (verificado de nuevo en `SA-08`).
- CashSettlement, la frontera `(desde, hasta]`, `waitClockPast` y el bloqueo financiero.
- Base personal, capital, transferencias, retiros, reconciliación, backend, cross-device, domingo y sesión por pestaña.
- **Exportación móvil de reportes:** no se implementó. La capacidad `report.export` sigue existiendo, pero no hay flujo móvil. Queda como pendiente menor.
- **"Modo Supervisor" en cuentas Admin/Super Admin:** pendiente para una etapa posterior.
