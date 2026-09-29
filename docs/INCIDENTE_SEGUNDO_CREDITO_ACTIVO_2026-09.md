# Incidente — segundo crédito activo sin autorización (2026-09)

**Estado:** cerrado · **Fecha:** 2026-09-29 · **Base:** `a7459ce` (1183 PASS) · **Suite nueva:** `npm run test:basecash` (familia `ACTIVE-CREDIT-*`)

## 1. Síntoma

En la app móvil operativa (la de Cobrador, que desde `a7459ce` también usa el Supervisor) un cliente que ya tenía un crédito activo recibió otro sin pasar por una Solicitud de autorización.

## 2. Reproducción (contra `a7459ce`, sin modificar)

Script temporal con los servicios de producción sobre Dexie real (fake-indexeddb). Escenario: Carlos, en Norte, con la **Venta A activa**.

| # | Intento | Resultado en `a7459ce` |
|---|---|---|
| R1 | Juan (cobrador) → `createDirectSale(…, JUAN)` | Rechazado (sin `sale.createDirect`) |
| R2 | Juan → `createSaleRequest` | Solicitud `pending` ✔ |
| R3 | Juan → segunda solicitud para Carlos | **Aceptada**: 2 pendientes |
| R4 | `createDirectSale(input)` **sin actor** | **Aceptada**: 2ª venta activa a nombre de Juan, sin ninguna validación |
| R5 | Laura (supervisora, misma app móvil) → venta directa | **Aceptada**: sin ninguna regla, solo el diálogo de confirmación de la pantalla |
| R6 | Doble toque concurrente de Juan → 2 solicitudes → aprobadas por dos autorizadores | **3 créditos activos** |

## 3. Causa raíz

1. **La regla no existía en el dominio.** "Un Cobrador no otorga un segundo crédito a quien ya tiene uno activo" no estaba en ningún servicio. Lo único que había era:
   - la **alerta de pantalla** del 25-jun (`CAMBIOS_SOCIO_REVISION_25_JUNIO.md` §7: *"no se bloquea: alerta fuerte + confirmación"*), y
   - la ausencia de `sale.createDirect` en el rol Cobrador.

   El segundo crédito se evitaba solo porque el Cobrador no tenía venta directa, no porque existiera una regla sobre el cliente.
2. **`actor` era opcional en `createDirectSale` / `createSaleRequest`** (desde `2547bdb`, 2026-07-24, "para semillas y pruebas"). Una llamada sin actor se saltaba el permiso, la integridad, el límite y el capital (R4).
3. **`a7459ce` (2026-09-24) dio `sale.createDirect` al Supervisor** en la **misma capa operativa móvil** (`/collector` y `/supervisor` comparten pantallas). Desde ese momento, en la app móvil podía otorgarse un segundo crédito directo solo con la confirmación de pantalla (R5). En la prueba de un solo equipo (sesión compartida en `localStorage`, ver `PROTOCOLO_PRUEBA_DOS_EQUIPOS.md`), una pestaña "de Cobrador" recargada adopta la última sesión iniciada. Esta es la explicación más probable del reporte, aunque no puede verificarse sin la IndexedDB del socio.
4. **No había protección frente al doble envío** (R3/R6): dos solicitudes pendientes del mismo cliente, aprobadas por personas distintas, terminaban en dos créditos.
5. **Dos pantallas de Administrador escribían la `Sale` por su cuenta** (`ActiveSalesPage`, `ClientsPage`, con `db.sales.add`), fuera de cualquier servicio.

Descartados con prueba: la capacidad del Supervisor **no** contaminó la del Cobrador (`can(JUAN, 'sale.createDirect') = false`, R1). El cálculo de estados no omitía ninguno: solo `'activa'` bloquea. No hay diferencia entre rutas (ver §6).

## 4. Rutas de creación auditadas

| Ruta | Antes | Ahora |
|---|---|---|
| `CollectorNewSalePage` (Cobrador/Supervisor) | capacidad + alerta de UI | regla central en UI **y** en servicio |
| `CollectorNewClientPage` + venta | servicio (cliente nuevo = sin crédito) | igual; el servicio revalida |
| `approveSaleRequest` | crea venta tras autorización | igual (es la autorización) |
| `ActiveSalesPage` (Admin) | `db.sales.add` directo | `createDirectSale(…, user)` |
| `ClientsPage` alta + crédito (Admin) | `db.sales.add` directo | `createDirectSale(…, user, { newClient })` |
| `createDirectSale` / `createSaleRequest` sin actor | aceptado sin validar | rechazado |

`ACTIVE-CREDIT-013` recorre `src/`: el único archivo que inserta ventas es `saleRequestService.ts`.

## 5. Regla de negocio (dominio)

`src/lib/activeCredit.ts`:

- `ACTIVE_SALE_STATUSES = ['activa']` (desembolsada o pendiente de desembolso). `finalizada`, `refinanciada` y `perdida` no bloquean.
- `decideSaleOrigination({ actor, canCreateDirect, canCreateRequest, activeCredits })`:
  - sin ninguna de las dos capacidades → **prohibida**;
  - **rol Cobrador con ≥ 1 crédito activo → solicitud**, siempre. Se usa el rol además de la capacidad: la regla sigue en pie aunque algún día se le conceda venta directa;
  - con `sale.createDirect` (Supervisor, Admin, Super Admin) → **directa** (autoridad comercial vigente; la pantalla sigue pidiendo confirmación);
  - solo `sale.createRequest` → solicitud.

## 6. Alcance del "crédito activo": por cliente, en toda la empresa

Evidencia: el documento del cliente es único por empresa, sin importar la ruta (`CAMBIOS_SOCIO_REVISION_25_JUNIO.md` §6), y `findActiveSaleForClient` siempre buscó por `clientId` en todas las rutas. Se conserva ese alcance. Un cliente trasladado a otra ruta con su crédito anterior vivo sigue bloqueado (`ACTIVE-CREDIT-012`). Las ventas de otra empresa nunca cuentan.

## 7. Solución

- `createDirectSale`: `actor` **obligatorio**. Dentro de la transacción `rw [sales, installments, clients]`, relee las ventas del cliente y aplica `decideSaleOrigination`; si no es "directa", lanza `ActiveCreditAuthorizationRequiredError` y no escribe.
- `createSaleRequest`: `actor` obligatorio. Dentro de la transacción `rw [saleRequests, clients, sales]`:
  - rechaza una segunda solicitud **pendiente** del mismo cliente (`DuplicatePendingRequestError`);
  - fotografía `activeCreditSaleIds` y `authorizationReason` (`active-credit` / `no-direct-capability` / `over-limit`) para el autorizador.
- Límite de venta directa: no se aplica a quien puede editarlo (`route.edit`: Admin/Super Admin de la ruta). Así se conserva exactamente el comportamiento de las pantallas de Admin, que ahora pasan por el servicio. El Supervisor sigue limitado.
- UI: `CollectorNewSalePage` usa la misma regla. El Cobrador ve *"El cliente ya tiene un crédito activo: esta venta se enviará como solicitud de autorización."*. La lista móvil de autorizaciones marca *"Cliente con crédito activo"*.

## 8. Concurrencia

IndexedDB serializa las transacciones `readwrite` que comparten almacén. La lectura de créditos o solicitudes y la escritura ocurren dentro de la **misma** transacción, así que dos intentos simultáneos no pueden ver ambos "sin crédito / sin pendiente" (`ACTIVE-CREDIT-011`: doble toque → 1 solicitud; Juan y Pedro a la vez → 1; dos directas de Juan → 0).

## 9. Pruebas

`ACTIVE-CREDIT-001..013` (13 casos, todos PASS). Además siguen intactos `SUP-CREDIT-*`, `SUP-AUTH-*` y `SUP-AUTH-RACE-*`.

## 10. Resultado

Un Cobrador no puede crear un segundo crédito activo sin autorización por ninguna vía: pantalla, servicio directo, llamada sin actor, alta de cliente, otra ruta o concurrencia. El Supervisor conserva su crédito directo, y el Admin y el Super Admin su comportamiento. Suite completa tras el bloque: 1196 PASS / 0 FAIL; `tsc` (src y tests) PASS; build PASS.
