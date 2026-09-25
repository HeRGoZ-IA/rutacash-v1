# RUTACASH — RESPONSABILIDAD DEL SUPERVISOR · SINCRONÍA LOCAL · CUADRE POR TRABAJADOR

**Fecha:** 2026-09-24
**Origen:** `docs/AUDITORIA_CUADRE_CAJA_SUPERVISOR_2026-09.md` (§42) y
`docs/IMPLEMENTACION_SUPERVISOR_RESPONSABILIDAD_EFECTIVO_2026-09.md` (§13)
**Baseline antes:** 1051 PASS / 0 FAIL (Dexie v13) · **Después:** 1125 PASS / 0 FAIL (Dexie v14)

Tres bloques, en este orden y con un gate entre el segundo y el tercero:

| Bloque | Qué | Estado |
|---|---|---|
| **A** | Regla definitiva: el Supervisor que registra un pago es el responsable | ✅ |
| **B** | Auditoría y corrección de la actualización Cobrador/Supervisor → Admin en el mismo equipo | ✅ |
| Gate | Suite completa, TypeScript y build en verde antes de tocar el esquema | ✅ PASS |
| **C** | `CashSettlement`: cuadre real por trabajador | ✅ |

---

## 1. Regla final del Supervisor

| Actor que registra el pago | `createdByUserId` | `collectorId` (responsable) | ¿Selector? |
|---|---|---|---|
| Cobrador | cobrador | cobrador | No |
| **Supervisor** | supervisor | **supervisor** | **No** |
| Admin / Super Admin | admin | 1 cobrador → ese cobrador · varios → se elige · ninguno → legacy | Solo si hay varios |
| Secretario / Socio | — | — | No registran pagos |

- Idéntico con **0, 1 o 2** cobradores activos en la ruta (`SUP-RESP-002/003/004`).
- Si un Cobrador o Supervisor envía otro responsable, el servicio lo rechaza
  (`actor-owns-cash` → `COLLECTOR_INVALID`): la pantalla es comodidad, la regla vive
  en `resolveResponsibleCollector`.
- Admin y Super Admin **nunca** adquieren caja personal (`SUP-RESP-007`).
- Desembolsos y gastos del Supervisor ya se cargaban a su caja desde la Fase 1.

---

## 2. Diagnóstico de actualización local

### 2.1 Misma IndexedDB, verificado

- Nombre fijo `RutaCashDB` (`super('RutaCashDB')`), uno por origen + perfil de navegador.
- La sesión (`useAuth`, persistida en `localStorage`) solo guarda **quién** está
  conectado. Los datos siempre son los de `RutaCashDB`.
- Una segunda conexión Dexie a la misma base ve el pago recién escrito (`LOCAL-SYNC-000`).
- **Excepción a tener en cuenta en las pruebas:** una ventana de incógnito o un perfil
  distinto del navegador es **otra base**. Ahí sí "no aparece nada", y no es un bug.

Fila persistida de ejemplo (`LOCAL-SYNC-001`, suite real):
`id=8a9a…c4a5 · routeId=r-norte · collectorId=u-juan · createdByUserId=u-juan · valor=100000 · fecha=2026-09-24 · createdAt=2026-09-24T14:33:35.187Z`

### 2.2 Matriz de superficies administrativas

"Remontaje" = entrar de nuevo a la pantalla / logout-login. "Sin F5" = la pantalla ya
abierta se entera sola.

| Vista administrativa | Debe reflejar el pago | Al remontar | Sin F5 (antes) | Sin F5 (ahora) | Causa |
|---|---|---|---|---|---|
| Dashboard Admin / Super Admin (recaudo hoy, semana, 7 días, top rutas, Base, Cartera) | Sí | ✅ | ❌ | ✅ | Tipo 2: carga solo al montar |
| Panel de Oficinas (Dashboard) | Sí | ✅ | ❌ | ✅ | Tipo 2 |
| Detalle de Oficina (cobranza del día, cartera, finanzas) | Sí | ✅ | ❌ | ✅ | Tipo 2 |
| Caja (por ruta) | Sí | ✅ | ❌ (botón Actualizar) | ✅ | Tipo 2 |
| Ventas Activas (saldos) | Sí | ✅ | ❌ | ✅ | Tipo 2 |
| Liquidación · vista previa | Sí | ✅ al Generar | ❌ | ✅ se recalcula con los mismos parámetros | Tipo 2 |
| Reportes | Sí | ✅ al Generar | — | — | Bajo demanda por diseño |
| Historial de pagos del cliente (Clientes) | Sí | ✅ al abrir | — | — | Se carga al abrir el detalle |
| Mi efectivo (app operativa) | Sí | ✅ | ❌ | ✅ | Tipo 2 |
| Badges de autorizaciones/ajustes | — | ✅ | ✅ (Fase 1) | ✅ | Ya era reactivo |

**No se encontró ningún bug de cálculo (Tipo 1) que excluyera pagos por responsable.**
Todas las vistas agregan por `routeId`; un cobro del Supervisor entra a la ruta igual
que uno del Cobrador (`LOCAL-SYNC-003/004/005/013/014/015`). La dimensión
`collectorId` decide **quién tiene el efectivo**, no **si la ruta cobró**.

### 2.3 Tipo 1 latentes encontrados

| Hallazgo | Efecto | Acción |
|---|---|---|
| `getCashboxSummary` usaba fecha **UTC** como fin por defecto; `Payment.fecha` es **local** | En husos por delante de UTC, entre medianoche local y UTC, los cobros de hoy no entraban en la Base. En Colombia no se manifestaba | **Corregido** (fecha local) |
| Semana operativa **lunes → sábado** | Un cobro en **domingo** no aparece en "Recaudo semanal", Caja por defecto ni Liquidación por defecto | **No cambiado**: es la convención declarada ("Lunes a Sábado"). Decisión de negocio pendiente |

### 2.3.b Sesiones en varias pestañas del mismo navegador (importante para las pruebas)

La sesión (`rutacash-auth`) se guarda en `localStorage`, que es **compartido** por
todas las pestañas del navegador. Cada pestaña conserva en memoria el usuario con el
que entró, pero **al recargar (F5) adopta la última sesión iniciada en cualquier
pestaña**. Ejemplo: Admin en la pestaña A, Cobrador inicia sesión en la pestaña B, F5
en A → A pasa a ser el Cobrador. No es pérdida de datos: es la sesión. Para probar
Admin y Cobrador a la vez sin F5, basta con que el refresco automático (§2.5) haga su
trabajo; para recargar, conviene usar perfiles de navegador distintos **sabiendo que
cada perfil es otra IndexedDB**. No se cambió (decisión de producto: pasar la sesión a
`sessionStorage` obligaría a iniciar sesión en cada pestaña nueva).

### 2.4 Pagos efectivos

El Dashboard y `getCashboxSummary` suman pagos **en bruto**. Es equivalente a
`effectivePayments()`: una corrección deja original (+X) y reversión (−X) con la misma
fecha, que se netean, y el pago corregido (+Y). Probado con una corrección real
(`LOCAL-SYNC-016`: bruto 80.000 = vigente 80.000 = Dashboard 80.000). No se cambió.

### 2.5 Corrección: una señal única de refresco

No se esparció `useLiveQuery` por 20 componentes. Se creó **un** mecanismo:

- `src/lib/dataRevision.ts` → `subscribeDataChanges(tablas, cb)`: escucha el evento
  `storagemutated` de Dexie, que se emite al confirmar cualquier escritura **y se
  reenvía a las demás pestañas del mismo navegador** por `BroadcastChannel`. Filtra por
  tabla (una escritura de auditoría no recalcula pantallas financieras).
- `src/hooks/useDataRevision.ts` → contador que sube tras cada cambio relevante
  (agrupando ráfagas de 150 ms). Las pantallas lo añaden a las dependencias del efecto
  que **ya tenían**: el cálculo es el mismo, solo cambia cuándo se repite. Los refrescos
  no muestran spinner.

Además, el cálculo del Dashboard se movió de `DashboardPage` a
`src/services/adminDashboardService.ts` **sin cambiar ninguna cifra**, para poder
probarlo con Dexie real (antes era imposible verificar el Dashboard sin renderizar React).

### 2.6 Verificación en navegador real

Chrome headless contra el servidor de desarrollo, dos pestañas del mismo navegador
(misma IndexedDB), datos sembrados con el código de la app:

| Paso | Resultado |
|---|---|
| Laura (Supervisora) abre "Registrar abono" | Sin "¿Quién recibió el dinero?" ni "Yo —" |
| Laura registra $300.000 por la UI | `collectorId = createdBy = u-laura` |
| Dashboard del Admin abierto en la otra pestaña | **$0 → $300.000 sin F5** (Recaudo hoy, semanal, Base, Cartera, panel de Oficinas) |
| Mi efectivo de Laura | $300.000 · "Mi recaudo hoy" aparte |
| Admin → Liquidación → Cuadre por trabajador → Laura, entrega $250.000 | FALTANTE $50.000 · confirmación "Este faltante continuará pendiente en el siguiente ciclo." |
| Histórico y alerta | Fila con esperado, entregado, faltante, quién cerró, motivo · alerta "Faltante pendiente: $50.000" |
| Mi efectivo de Laura tras el cuadre (sin F5) | "Faltante pendiente del cuadre anterior +$50.000" · a entregar $50.000 |
| Laura intenta cuadrarse a sí misma | Bloqueado en pantalla; sin botón "Cerrar cuadre" |
| Errores de página | Ninguno |

---

## 3. CashSettlement — cuadre real por trabajador

### 3.1 Dos cierres distintos

| | `WeeklySettlement` | `CashSettlement` |
|---|---|---|
| Clave | Route + semana | **Route + persona + ciclo** |
| Pregunta | ¿Qué movió la ruta? | ¿Cuánto efectivo debía entregar esta persona? |
| Periodo | Fechas (lunes→sábado) | **Instantes ISO** desde el último cuadre |
| Incluye capital, transferencias, retiros | Sí | **No** |

Coexisten. `WeeklySettlement` **no cambió de significado** (`CASH-SETTLEMENT-031`:
cuadrar trabajadores no altera cobros ni saldo final de la liquidación). En la pantalla
de Liquidación aparece una línea informativa "Cuadres de trabajadores", que **no** se
suma ni se concilia contra la liquidación.

### 3.2 Modelo (`src/models/types.ts`)

`id, tenantId, routeId, userId, desde, hasta, origenDesde, previousSettlementId?,
arrastreAnterior, recaudado, desembolsado, gastos, esperado, entregado, diferencia,
faltante, sobrante, motivo?, status ('cerrada'|'reabierta'), version, supersededBy?,
createdAt, closedAt, closedByUserId, reopenedAt?, reopenedByUserId?, reopenReason?`

Sin `officeId`: la Oficina se deriva por la ruta, como en todo el modelo.

### 3.3 Dexie v14

- Tabla `cashSettlements`: `id, tenantId, routeId, userId, status, [routeId+userId]`.
- **No se crean cuadres históricos.** La migración marca en cada empresa
  `Tenant.cashModelStartAt` = instante de la actualización (**inicio del modelo
  personal**). El primer ciclo de cada trabajador parte de ahí con arrastre 0.
  Empresas creadas después usan su `createdAt`.
- `Sale.disbursedAt` (nuevo, opcional): instante exacto del desembolso, sellado por
  `confirmDisbursement`. Ventas anteriores usan la medianoche local de
  `fechaDesembolso` (conservador: nunca entra a un ciclo que no le corresponde).
- Pruebas `MIG-CASH-001..004` sobre una base v13 real.

### 3.4 Motor por rango

`getCollectorCashSummary({ routeId, userId, desde, hasta, modelStart })` en
`cashboxEngine.ts`, sobre la misma superficie que la caja diaria (pagos, ventas,
gastos — **nunca** capital, transferencias ni retiros):

| Componente | Criterio |
|---|---|
| recaudado | pagos con `collectorId = userId` y `createdAt` en (desde, hasta] |
| desembolsado | ventas con `disbursedByCollectorId = userId` y `disbursedAt` en (desde, hasta] |
| gastos | gastos con `collectorId` (o `userId` legacy) = userId y `createdAt` en (desde, hasta] |

`getCollectorDailyCashSummary` **se conserva intacta**: "Mi recaudo hoy" sigue siendo diario.

**Pagos corregidos — divergencia documentada respecto de `effectivePayments()`.** El
motor usa el **libro con signo** (original +X, reversión −X, corrección +Y, cada uno
en su instante), anclado a que el pago raíz sea posterior al inicio del modelo:

- En una misma ventana da **exactamente** lo mismo que `effectivePayments()`
  (`CASH-SETTLEMENT-026`).
- Si la corrección cae en un ciclo **posterior** al del pago original, el original ya
  se entregó en el cuadre anterior. `effectivePayments()` sumaría +Y otra vez (cobrar
  dos veces el mismo dinero); el libro con signo carga solo el ajuste Y − X
  (`CASH-SETTLEMENT-027`: −20.000). Un esperado negativo significa que el trabajador
  entregó de más en un ciclo anterior.
- Corregir un pago **anterior al inicio del modelo** no genera efectivo ni deuda
  (`CASH-SETTLEMENT-028`).

### 3.5 Fórmula, signos y arrastre

```
esperado   = arrastreAnterior + recaudado − desembolsado − gastos
diferencia = entregado − esperado
                 0 → CUADRE EXACTO
               < 0 → FALTANTE  (faltante = −diferencia)
               > 0 → SOBRANTE  (sobrante = diferencia)
arrastreAnterior(N+1) = max(0, −diferencia(N))
```

No se usa `arrastre(N+1) = diferencia(N)`: el faltante tiene diferencia **negativa**,
pero la deuda que sigue viva es **positiva** y se **suma** a lo esperado.

| Situación | Esperado | Entregado | Diferencia | Arrastre siguiente |
|---|---|---|---|---|
| Exacto | 1.000.000 | 1.000.000 | 0 | 0 |
| Faltante | 1.000.000 | 900.000 | −100.000 | **+100.000** |
| Faltante + recaudo 300.000 | 400.000 | 400.000 | 0 | 0 |
| Sobrante | 1.000.000 | 1.050.000 | +50.000 | **0** (no es crédito) |

- **Faltante:** persiste en el documento y continúa en el siguiente ciclo. No bloquea
  al trabajador; se alerta.
- **Sobrante:** persiste con motivo obligatorio. **No** se compensa contra futuras
  obligaciones ni se convierte en capital: queda como excepción trazable.
- **Motivo:** obligatorio si la diferencia ≠ 0, mínimo 10 caracteres (misma regla que
  la reapertura de liquidaciones).

### 3.6 Periodo

`desde` = `hasta` del último cuadre **vigente** de esa persona en esa ruta, o el inicio
del modelo personal. `hasta` = instante del cierre. Ciclos (desde, hasta]: dos cierres
el mismo día son dos ciclos distintos (`CASH-SETTLEMENT-019`).

### 3.6.b Frontera temporal — convención única (actualizado 2026-09-24, ajuste previo a Fase 3)

**Convención: `(desde, hasta]` — `desde` EXCLUSIVO, `hasta` INCLUSIVO.** Un único
helper la aplica a los tres componentes:

```ts
// src/lib/cashSettlementRules.ts
export function inCycle(instante: string, desde: string, hasta: string): boolean {
  return instante > desde && instante <= hasta
}
// src/services/cashboxEngine.ts — getCollectorCashSummary
//   pagos:       inCycle(x.instante, desde, hasta)            (createdAt)
//   desembolsos: inCycle(disbursementInstant(s), desde, hasta) (disbursedAt)
//   gastos:      inCycle(expenseInstant(e), desde, hasta)      (createdAt)
```

El ciclo B empieza exactamente en el `hasta` de A. Un movimiento en el instante T de
la frontera entra **una sola vez**, en A:

| Instante | Ciclo A `(…, T]` | Ciclo B `(T, T2]` |
|---|---|---|
| T − 1 ms | ✅ | — |
| **T** | ✅ | — |
| T + 1 ms | — | ✅ |

**¿Podía contarse dos veces?** No: la convención ya era esta y ya era única.

**¿Podía quedar en NINGÚN ciclo?** Sí, en teoría, y se corrigió. El cierre sellaba
`hasta` y leía los movimientos **sin bloquear sus tablas**, y tres escritores sellaban su
instante **antes** de obtener su bloqueo: el gasto (pantalla), la confirmación de
desembolso y la corrección de pago. Un movimiento sellado ≤ `hasta` y confirmado justo
después de la lectura del cierre (otra pestaña, mismo milisegundo) no entraba ni en A
(no existía al leer) ni en B (instante ≤ `desde`). Las pruebas no llegaron a forzarlo,
pero la ventana existía en el código.

Corrección (la convención no cambió):

1. `closeCashSettlement` calcula y escribe **dentro de una transacción** sobre
   `cashSettlements, payments, sales, expenses, tenants`. Un movimiento en curso se
   confirma antes de que el cierre lea, o espera a que el cierre termine.
2. `hasta` se sella **después** de obtener el bloqueo (primera lectura).
3. `waitClockPast(hasta)`: el cierre no suelta el bloqueo hasta que el reloj supera
   `hasta` (≤ 1 ms). Todo lo que se selle después tiene instante estrictamente mayor.
4. Los escritores sellan **bajo bloqueo**, tras una primera lectura dentro de su
   transacción: `paymentService` (ya lo hacía), `confirmDisbursement`,
   `executeCorrection` y el gasto operativo (`addExpenseStamped`, servicio nuevo).

Pruebas `CASH-BOUNDARY-001..010` (§4).

### 3.7 Quién cierra

| Rol | `view` | `viewOwn` | `close` | `reopen` |
|---|---|---|---|---|
| Super Admin | ✅ | — | ✅ | ✅ |
| Admin | ✅ | — | ✅ | ✅ |
| Supervisor | ✅ | ✅ | ✅ **solo a otros** | ❌ |
| Cobrador | ❌ | ✅ | ❌ | ❌ |
| Secretario / Socio | ❌ | ❌ | ❌ | ❌ (incompatibles) |

Capacidades nuevas, separadas de `settlement.*`: cerrar la semana de una **ruta** y
cuadrar el efectivo de una **persona** son decisiones distintas (el Supervisor hace la
segunda y nunca la primera). Todas son `ROUTE_SCOPED`.

**Nadie cierra su propio cuadre** (`CASH-SETTLEMENT-012/013`, `SMOKE-C6`).

### 3.8 Revalidación en el servicio (`cashSettlementService.ts`)

`closeCashSettlement` recibe solo `routeId, userId, entregado, motivo` (+ `esperadoVisto`
opcional) y revalida: actor, capacidad con ruta y empresa, no autocierre, ruta existe y
es de la empresa, trabajador existe, es de la empresa, tiene caja personal y está
asignado a la ruta, entregado válido, último cierre vigente, periodo no vacío ni
solapado, y **recalcula el esperado** en ese instante.

- `esperadoVisto` **no** es fuente de verdad: si difiere del recalculado se rechaza
  ("las cifras cambiaron"), para que nadie cierre sobre una vista previa vieja.
- Dentro de la transacción se vuelve a comprobar que nadie cerró el mismo ciclo entre
  la lectura y la escritura (dos pestañas): solo queda **un** cuadre vigente
  (`CASH-SETTLEMENT-020`).
- **Oficina inactiva no bloquea el cuadre**: una Oficina inactiva congela operaciones
  nuevas; cuadrar no crea movimientos, solo registra la entrega del efectivo que ya
  existe. Bloquearlo dejaría dinero sin conciliar justo al cerrar una Oficina.
- Cerrar y reabrir **no modifican** pagos, ventas ni gastos (`CASH-SETTLEMENT-023/024/025`).

### 3.9 Reapertura y versionado

Inspirado en `WeeklySettlement`: reabrir marca `status: 'reabierta'` con fecha, autor
y **motivo obligatorio**; el documento se conserva. El siguiente cierre vuelve a partir
del mismo `desde`, es la **versión siguiente** y el reabierto apunta a él con
`supersededBy`.

**Solo se reabre el último cuadre vigente** de esa persona en esa ruta: reabrir uno
anterior dejaría al posterior con un arrastre calculado sobre un cierre que ya no vale
(`CASH-SETTLEMENT-022`).

### 3.10 Interfaz

- **Liquidación** (Admin / Super Admin): pestaña **"Cuadre por trabajador"** junto a
  "Liquidación de ruta". Oficina → Ruta → Trabajador → vista previa (desde / hasta con
  hora, arrastre, recaudado, desembolsado, gastos, esperado) → Entregado →
  CUADRE EXACTO / FALTANTE / SOBRANTE → confirmación ("Este faltante continuará
  pendiente en el siguiente ciclo.").
- **Histórico compacto** por ruta: fecha/hora, trabajador, esperado, entregado,
  faltante/sobrante, quién cerró, motivo, reabrir.
- **Alerta de faltantes** en el Dashboard y en la pestaña: "Juan Pérez · Norte —
  Faltante pendiente: $100.000". Sin bloqueo.
- **App del Supervisor:** "Cuadre" → "Cuadrar a otro trabajador de la ruta"
  (`/supervisor/worker-settlements`, ruta activa). Su propio cuadre aparece marcado
  "(tú)" y no se puede cerrar.
- **Mi efectivo** (Cobrador y Supervisor): ya no es "lo de hoy". Es el ciclo abierto
  desde el último cuadre + faltante pendiente, calculado por el **mismo** servicio que
  usa quien cierra. "Mi recaudo hoy" queda aparte como KPI diario.

---

## 4. Pruebas

**1051 → 1125 PASS / 0 FAIL.**

| Suite | Antes | Después |
|---|---|---|
| permisos | 553 | 555 |
| financiera | 180 | 180 |
| arranque | 159 | 159 |
| plataforma | 64 | 64 |
| liquidaciones | 40 | 40 |
| migraciones | 55 | 59 (`MIG-CASH-001..004`) |
| **caja del trabajador (nueva)** | — | **68** |

Suite nueva `tests/workercash.test.ts` (`npm run test:workercash`): servicios de
producción sobre el singleton `db` real con `fake-indexeddb`.

| Familia | Casos |
|---|---|
| `SUP-RESP-001..009` | Regla definitiva del Supervisor |
| `CASH-BOUNDARY-001..010` | Frontera `(desde, hasta]`: T, T±1 ms, dos cierres el mismo día, pagos/desembolsos/gastos, escritor con bloqueo abierto durante el cierre, cierres concurrentes con los tres escritores, contrato de bloqueo |
| `MOBILE-PARITY-001..010` | Paridad móvil Supervisor/Cobrador (ver `PARIDAD_MOVIL_SUPERVISOR_COBRADOR_2026-09.md`) |
| `LOCAL-SYNC-000..016` | Misma base, Cobrador/Supervisor → Admin, sesión, alcance, reactividad, semántica |
| `CASH-SETTLEMENT-001..032` | Cuadre, permisos, independencia, periodo, reapertura, inmutabilidad, correcciones, histórico, Mi efectivo, alertas, liquidación, capacidades |
| `SMOKE-S1..S4`, `SMOKE-C1..C6` | Recorridos del socio |

Tests sustituidos por la regla nueva: ver `IMPLEMENTACION_SUPERVISOR_RESPONSABILIDAD_EFECTIVO_2026-09.md` §13.

---

## 5. Limitaciones honestas

- **Cross-device: NO soportado.** Todo lo anterior funciona dentro de **una**
  IndexedDB (mismo navegador, mismo perfil, mismo origen). Entre dos dispositivos no
  llega ningún pago ni ningún cuadre. Requiere backend (D-10).
- **Base física asignada a trabajador:** no existe; la Base sigue siendo de la ruta
  (D-2). La fórmula del esperado no incluye Base, capital, transferencias ni retiros.
- **Capital / Transferencias / Retiros:** siguen escribiéndose desde el componente, sin
  servicio.
- **Reconciliación formal Route ↔ trabajadores:** no existe. La línea informativa en
  Liquidación no concilia.
- **Domingo:** fuera de la semana operativa por defecto (§2.3). **Pendiente confirmar
  si las Routes operan/cobran los domingos.** No se tocaron `getWeekStart`,
  `getWeekEnd`, `WeeklySettlement` ni los rangos o reportes semanales.
- ~~**Instante de cierre:** un movimiento registrado en el mismo milisegundo que el
  cierre podía quedar fuera de ambos ciclos.~~ **Resuelto** (§3.6.b).
- **Gasto del panel de Administración** (`ExpensesPage`): sigue sellando fuera de
  bloqueo, pero no tiene responsable de caja personal (`collectorId` vacío y `userId` de
  un Admin), así que nunca entra en el cuadre de ningún trabajador.
