# Base física por trabajador, movimientos de fondos y conciliación Route ↔ trabajadores (2026-09)

**Fecha:** 2026-09-29 · **Dexie:** v14 → **v15** · **Suite:** `npm run test:basecash` (`BASE-WORKER-*`, `MOVEMENT-SVC-*`, `RECON-*`, `CASH-BOUNDARY-011`, `SUNDAY-ADMIN-001`, `SMOKE-*`) y `npm run test:migrations` (`MIG-BASE-*`).

## 1. Problema

RutaCash conocía la **Base estructural** de cada Route, pero no qué parte de ese efectivo estaba físicamente en manos de cada persona. El cuadre por trabajador (v14) suponía que todos empiezan el día con 0.

Si Juan recibía 1.500.000 de Base y desembolsaba 500.000, su cuadre daba **−500.000**. No había forma de explicar ni de conciliar dónde estaba el dinero. Además, Capital, Transferencias y Retiros se escribían directamente desde las pantallas:

- un retiro podía superar los fondos;
- una transferencia con socio podía quedar a medias;
- un Admin podía mover fondos de una ruta no asignada, porque `capital.manage` no está acotada por ruta en `can()`.

## 2. Conceptos (no son sinónimos)

| Concepto | Qué es | Dónde vive |
|---|---|---|
| **Base estructural** | capital + transferencias entrantes − salientes − retiros | `capitalMovements`, `transfers`, `withdrawals` |
| **Libro de la Route** | estructural + cobros − desembolsos − gastos: todo el efectivo que la Route debe tener | `getCashboxSummary` |
| **Base física personal** | efectivo de la Route entregado explícitamente a una persona | `cashCustodyMovements` (v15) |
| **Posición personal / Mi efectivo** | lo que la persona debe tener en mano ahora = esperado de su cuadre | `personalCashPosition` |
| **Sin asignar** | libro − Σ posiciones personales (caja de la Route / oficina) | `routeCashReconciliation` |
| **Cartera** | deuda de clientes. **No es efectivo** | ventas activas |

## 3. Movimientos de custodia (`CashCustodyMovement`)

| Tipo | Flujo | Efecto |
|---|---|---|
| `BASE_ASSIGNMENT` | Route → persona (ROUTE_TO_PERSON) | persona +X, sin asignar −X |
| `BASE_RETURN` | persona → Route (PERSON_TO_ROUTE) | persona −X, sin asignar +X |
| `PERSON_TO_PERSON` | persona → persona | A −X, B +X |

Cada movimiento guarda `routeId`, `fromUserId`/`toUserId`, `amount`, `motivo`, `origen` (`route-cash` o `transfer`, con `relatedTransferId`), `createdByUserId`, `fecha` y `createdAt` (sellado dentro de la transacción).

**No crea dinero:** el libro de la Route no cambia (`BASE-WORKER-005`). Nunca se infiere de `Route.cobradorId`, del rol ni del usuario en sesión.

### Reglas del servicio (`cashCustodyService`)

- **Capacidad:** `cashCustody.manage` sobre la ruta. La tienen Super Admin, Admin y Supervisor. Es incompatible con Cobrador, Secretario y Socio.
- **Receptor:** misma empresa, activo, con caja personal (Cobrador o Supervisor) y asignado a la ruta (`custodianBlockedReason`, fuente única).
  - Admin y Super Admin **no** reciben Base: el "Modo Supervisor" no existe en el repositorio. Cuando exista, la elegibilidad se amplía solo en esa función; el ledger ya es por `userId`.
- **Nadie reduce su propia responsabilidad:** una devolución o un traspaso que descarga a X lo registra otra persona, igual que "nadie cierra su propio cuadre".
- **Fondos, validados dentro de la transacción:**
  - la entrega ≤ caja sin asignar;
  - la devolución o el traspaso ≤ la posición de quien entrega.
- **Oficina inactiva:** bloquea entregar y traspasar (operaciones nuevas); **permite** la devolución, porque concilia efectivo existente.

## 4. Fórmula del cuadre (congelada)

```
esperado = arrastreAnterior
         + baseRecibida        (custodia: toUserId = persona)
         − baseDevuelta        (custodia: fromUserId = persona)
         + recaudado           (pagos con collectorId = persona, libro con signo)
         − desembolsado        (ventas con disbursedByCollectorId = persona)
         − gastos              (gastos con collectorId ?? userId = persona)
diferencia = entregado − esperado;  arrastre siguiente = max(0, −diferencia)
```

Cada término sale de una sola tabla, así que no hay doble conteo. Un desembolso hecho con Base resta una vez (como desembolso) y la Base suma una vez (como entrega). Sin Base, la fórmula es idéntica a la v14 (`BASE-WORKER-012`).

El cuadre archiva `baseRecibida` y `baseDevuelta`. `cashCustodyMovements` entra al bloqueo del cierre (`closeCashSettlement`), así que una entrega simultánea a un cierre cae en **un solo** ciclo (`CASH-BOUNDARY-011`). La frontera `(desde, hasta]` no cambia.

## 5. Conciliación Route ↔ trabajadores

`computeRouteCashReconciliation(routeId)`:

```
libro = sinAsignar + Σ posiciones personales
```

`sinAsignar` se calcula por **dos vías independientes** y debe coincidir (`cuadra`):

- **(a)** `libro − Σ posiciones`
- **(b)** `estructural + operación no personal − Base entregada neta + entregado en cuadres − sobrantes registrados`

La vía (b) sale de sumar cuadre a cuadre la fórmula: `posición = Σ flujos personales − Σ entregado + Σ sobrante` (el sobrante no se arrastra). Si (a) ≠ (b), algo se contó dos veces.

- **Sobrantes:** efectivo físico fuera del libro. Se informa aparte (`efectivoFisicoNoAsignado = sinAsignar + sobrantes`) y nunca se convierte en crédito.
- **Faltantes:** último cuadre vigente con diferencia < 0 por persona.
- **Posición negativa:** una persona entregó dinero sin Base registrada (típicamente Base informal anterior a v15). Se muestra en rojo; no se oculta.
- **Disponible** para entregar, transferir o retirar = `max(0, min(libro, sinAsignar))`.

### Ejemplo real (SMOKE C–G)

Norte: capital 5.000.000, préstamo administrativo previo de 1.000.000.

| Paso | Cálculo | Resultado |
|---|---|---|
| C | Base a Juan 1.500.000 | Juan 1.500.000 · libro 4.000.000 · sin asignar 2.500.000 |
| D | 0 + 1.500.000 − 500.000 + 300.000 − 100.000 | **esperado 1.200.000** |
| E | entrega 1.200.000 | exacto · siguiente ciclo 0 · libro 3.700.000 = sin asignar 3.700.000 + 0 |
| F | Base 1.000.000 + recaudo 200.000; entrega 1.100.000 | faltante 100.000 → arrastre 100.000 |
| G (a) | 3.900.000 − 100.000 | sin asignar 3.800.000 |
| G (b) | 5.000.000 + (−1.000.000) − 2.500.000 + 2.300.000 − 0 | **3.800.000 ✔** |

Cartera (aparte): 1.300.000.

## 6. Capital, Transferencias y Retiros (`routeFundsService`)

Todas revalidan en servicio: actor, capacidad, empresa, ruta autorizada (explícita, porque `capital.manage` no está acotada por ruta en `can()`), Oficina activa, monto entero > 0 y fecha válida no futura. Autoría (`userId = actor`) e instante (`createdAt`) los pone el servicio, y se audita (`CAPITAL_REGISTERED`, `TRANSFER_REGISTERED`, `WITHDRAWAL_REGISTERED`).

- **Capital** (`capital.manage`): dinero **nuevo** para la Route; suma al estructural.
- **Transferencia** (`transfer.create`), clasificada:
  - `aporte-socio` (Socio → Route): entra dinero;
  - `traslado-interno` (Route → Route): el total de la empresa no cambia (`MOVEMENT-SVC-002`);
  - `salida-a-socio`;
  - `entre-socios`.

  La transferencia, sus movimientos de Caja socios y la entrega en mano opcional (`entregarA` → `BASE_ASSIGNMENT` con `relatedTransferId`) van en **una** transacción. Un fallo intermedio no deja nada (`MOVEMENT-SVC-003`). Si el origen es una ruta, el monto ≤ disponible.
- **Retiro** (`capital.manage`): salida estructural de la caja **sin asignar**. No puede superar el disponible: lo que está en manos de trabajadores no se retira. Dos retiros simultáneos no gastan el mismo dinero (`MOVEMENT-SVC-004`). Un retiro nunca afecta a una persona; devolver efectivo personal es `returnBaseFromWorker` o el cuadre.

**Nota de negocio:** antes, un retiro solo estaba limitado por la pantalla. Ahora el límite es la caja sin asignar, lo que obliga a cuadrar o recibir devoluciones antes de retirar el efectivo que tienen los trabajadores.

La Caja socios **no** valida saldo del socio en una transferencia Socio → Route: un aporte puede venir de fuera de la caja registrada del socio (comportamiento vigente, sin cambios).

## 7. Migración y tratamiento histórico

- **v15** añade `cashCustodyMovements` (índices: tenant, ruta, tipo, from, to, instante, transferencia) y marca `Tenant.baseCustodyStartAt` = instante de la actualización.
- **No se crea ningún movimiento histórico** ni se atribuye Base a `Route.cobradorId` (`MIG-BASE-002`).
- Pagos, capital, cuadres, rutas y usuarios quedan idénticos (`MIG-BASE-001`). Un cuadre v14 sigue siendo el arrastre válido (`MIG-BASE-003`).
- Todo movimiento anterior a `cashModelStartAt` se presume en la caja de la Route.

## 8. Superficies de UI

- **Liquidación → Cuadre por trabajador** (Admin) y **Cuadrar trabajadores** (Supervisor, móvil): tarjeta "Efectivo de la ruta" (conciliación con desglose), filas "(+) Base recibida" y "(−) Base devuelta", y botones **Entregar Base** y **Recibir devolución**.
- **Mi efectivo** (Cobrador/Supervisor): filas de Base en su ciclo.
- **Capital, Transferencias y Retiros** (Admin): escriben por servicio. Transferencias ofrece "Entregar en mano a (opcional)"; Retiros muestra "Disponible para retiro (caja no asignada)". Las tres son reactivas (`useDataRevision`).

## 9. Lo que no cambia

- `WeeklySettlement` sigue siendo el cierre de la Route: la custodia no altera sus cifras (`RECON-003`).
- Nadie cierra su propio cuadre.
- Los sobrantes se registran con motivo y nunca son crédito.
- Domingos: la operación administrativa sigue permitida (`SUNDAY-ADMIN-001`).
- Sin backend y sin sincronización entre dispositivos.
