# RUTACASH — AUDITORÍA CAJA / CUADRE / SUPERVISOR

**Fecha:** 2026-09-22
**Alcance:** Supervisor · Cobrador · Caja · Pagos · Base · Transferencias · Cuadre · Liquidación · Sincronización · Trazabilidad
**Naturaleza:** AUDITORÍA DE SOLO LECTURA. No se modificó ningún motor financiero, ninguna pantalla, ningún permiso ni ningún modelo.
**Commit de partida:** `77a6b43` (`fix(owner): use creation date in company onboarding`)

---

## 1. Resumen ejecutivo

RutaCash tiene hoy **dos contabilidades paralelas que no se hablan**:

| | Caja de la RUTA | Caja PERSONAL del trabajador |
|---|---|---|
| Motor | `getCashboxSummary()` | `getCollectorDailyCashSummary()` |
| Dimensión | `routeId` | `routeId` + `collectorId` + **un día concreto** |
| Entradas | capital, cobros, transferencias | cobros |
| Salidas | préstamos, gastos, transferencias, retiros | desembolsos, gastos |
| Cierre persistido | `weeklySettlements` (por ruta) | **ninguno** |
| Arrastre | histórico completo desde el año 2000 | ninguno (se reinicia cada día a las 00:00) |

El **cuadre que el negocio necesita** —cierre de responsabilidad de efectivo de UNA PERSONA sobre UNA RUTA desde el último cierre— **no existe como entidad**. Lo que existe (`WeeklySettlement`) es un **estado de cuenta de la RUTA para un rango de fechas**: no sabe quién tenía el dinero, no registra cuánto entregó realmente el trabajador, no puede producir un faltante ni un sobrante, y no deja a nadie en cero.

De ahí se derivan, en cascada, casi todos los síntomas reportados:

1. **Atribución del efectivo (causa raíz principal).** `Payment.collectorId` solo admite usuarios con rol `cobrador`. Un Supervisor que cobra físicamente en una ruta con cobrador activo **no puede quedar como responsable del dinero**: el sistema lo atribuye al cobrador habitual. *Probado ejecutando el servicio real (Caso B).*
2. **El cuadre no tiene dimensión de persona.** `WeeklySettlement` no guarda ningún campo de trabajador. El pago del Supervisor **sí entra** al cuadre —porque el cuadre es de la ruta— pero entra **a nombre de otro**.
3. **El motor de caja no conoce los cierres.** `cashboxEngine.ts` no importa `weeklySettlements` ni existe `lastClosedSettlementAt`. Cada cálculo rehace el histórico completo. *Probado (Pregunta crítica 3).*
4. **No hay faltantes ni sobrantes.** No existe entidad, campo, ni siquiera la palabra, en todo `src/`.
5. **Base pertenece exclusivamente a la Ruta.** `Transfer` no tiene responsable; la caja personal del trabajador ni siquiera lee la tabla `transfers`.
6. **Sin backend no hay sincronización entre dispositivos.** `syncService` solo cambia `syncStatus: 'pending' → 'synced'` en la MISMA IndexedDB. El propio repositorio ya lo documenta con pruebas ejecutables (`CROSS-DEVICE-001..004`).

Y dos hallazgos menores, pero reales y aislados:

7. **Histórico de abonos del Cobrador**: única pantalla operativa que filtra por *todas* las rutas autorizadas en vez de por la ruta activa. Causa exacta localizada en una línea.
8. **Secretario sin badge**: `SecretarioLayout` no monta ningún contador; además el contador que usa el Admin (`countPendingSaleRequests`) **no recorta por rutas autorizadas**, así que no es reutilizable tal cual.

**Lo importante: el sistema NO está roto.** Los motores de distribución de parcelas, el tope al saldo, la atomicidad, el aislamiento por ruta, la corrección controlada de pagos, el versionado de cierres y el scoping por `authorizedRouteIds` funcionan y están cubiertos por 1008 pruebas. Lo que falta es **una dimensión de modelo** (la persona responsable del efectivo y su ciclo de cierre), no una reparación de lo existente.

---

## 2. Baseline

Verificado antes de auditar, sobre el árbol de trabajo tal cual.

| Comando | Resultado |
|---|---|
| `npm run test:permissions` | **539 OK, 0 FALLIDAS** |
| `npm run test:financial` | **151 casos · 151 PASS · 0 FAIL** |
| `npm run test:bootstrap` | **159 casos · 159 PASS · 0 FAIL** |
| `npm run test:platform` | **64 casos · 64 PASS · 0 FAIL** |
| `npm run test:settlements` | **40 casos · 40 PASS · 0 FAIL** |
| `npm run test:migrations` | **55 casos · 55 PASS · 0 FAIL** |
| **TOTAL** | **1008 PASS / 0 FAIL** ✅ |
| `npx tsc --noEmit` | exit 0, sin errores |
| `npx tsc --noEmit -p tests` | exit 0, sin errores |
| `npm run build` | `✓ built in 12.54s` (solo aviso de tamaño de chunk, preexistente) |

**Estado al cerrar la auditoría: idéntico.** No se modificó ningún archivo del repositorio. El único artefacto creado es este documento. El script forense usado para las evidencias se ejecutó desde el directorio temporal de la sesión y **no se añadió al repositorio ni al suite**; su contenido se reproduce en el §29 para que cualquiera pueda repetirlo.

---

## 3. Arquitectura actual

### 3.1 Pila

- **Frontend puro.** React 18 + Vite + Zustand + React Router. Sin servidor.
- **Persistencia.** Dexie (IndexedDB), esquema en `src/lib/db.ts`, versión actual **13**.
- **Multiempresa.** `tenantId` en cada fila. Plano de control del Owner (`src/platform/`) sobre la MISMA base local.
- **Autorización.** `src/lib/permissions.ts` — modelo **ROL + CAPACIDADES + RUTAS AUTORIZADAS**, fail-closed. `authorizedRouteIds` es la única llave de alcance.
- **Oficina.** Agrupación visual. Vive SOLO en `Route.officeId`; ninguna entidad financiera la copia.

### 3.2 Capas de servicio financiero

```
PANTALLAS
  ├─ paymentService.registerPayment()        ← ÚNICO punto de escritura de pagos
  ├─ paymentCorrectionService                ← reversión + reemplazo (no destructivo)
  ├─ saleRequestService.confirmDisbursement()
  ├─ settlementService.closeSettlement()     ← archiva el documento de cierre
  └─ ESCRITURA DIRECTA A DEXIE (sin servicio):
        CapitalPage      → db.capitalMovements.add()
        TransfersPage    → db.transfers.add()
        WithdrawalsPage  → db.withdrawals.add()
        ExpensesPage     → db.expenses.add()
        CollectorExpensesPage → db.expenses.add()

MOTORES DE CÁLCULO
  ├─ cashboxEngine.getCashboxSummary(routeId, desde, hasta)      → caja de RUTA
  ├─ cashboxEngine.getRouteFinancialSummary(routeId)             → Base + Cartera
  ├─ cashboxEngine.getCollectorDailyCashSummary({routeId, collectorId, fecha})
  └─ weeklySettlementEngine.generateWeeklySettlement()           → delega 100% en getCashboxSummary
```

**Hallazgo de arquitectura [DISEÑO]:** no existen `transferService`, `capitalService` ni `withdrawalService`. Capital, transferencias, retiros y gastos se escriben **directamente desde el componente React**. Consecuencias observables:

- No hay un punto único donde aplicar una regla de responsabilidad de efectivo a esos movimientos (que es exactamente lo que el nuevo cuadre necesitará).
- No hay transacción Dexie: `TransfersPage` escribe `db.transfers.add()` y después `createPartnerMovement()` en dos operaciones separadas. Si la segunda falla, queda una transferencia sin su contrapartida en Caja socios.
- La validación de permiso y de Oficina activa está **en la pantalla**, no en un servicio revalidable.

Esto contrasta con `paymentService`, que sí es un servicio blindado, transaccional e inyectable. La asimetría es el origen del problema del punto 13.

### 3.3 Capa operativa compartida

`SupervisorLayout` es literalmente `export { CollectorLayout as SupervisorLayout }`. Las rutas de `/supervisor/*` y `/collector/*` montan **las mismas pantallas** vía `useOpBase()`, que devuelve el prefijo según la URL.

```
src/app/App.tsx:203   <Route path="/supervisor" element={<RequireAuth roles={['supervisor']}><SupervisorLayout/></RequireAuth>}>
src/app/App.tsx:208       {operationalRoutes()}    ← idéntico a /collector
```

Arquitectónicamente **sí** es "un cobrador con más permisos". El problema no está en la UI, está en el motor de atribución.

---

## 4. Supervisor actual

### 4.1 Capacidades (`SUPERVISOR_CAPS`, `src/lib/permissions.ts:168-179`)

```
route.viewAssigned
client.create, client.view
sale.viewActive, sale.viewHistory, sale.createRequest, sale.confirmDisbursement
payment.register, payment.viewHistory
expense.register
cashbox.viewRoute, cashbox.viewOwnCollection, cashbox.dailyClose
report.view, report.export, report.viewPortfolio
password.changeOwn
```

Prohibidas explícitamente (`INCOMPATIBLE_BY_ROLE.supervisor`, línea 258): `sale.createDirect`, todas las de autorización, `payment.correct/reverse/approveAdjustment`, `expense.correct`, `transfer.create`, `partnerCash.*`, `cashbox.viewConsolidated`, `report.viewConsolidated`, **`settlement.close` y `settlement.reopen`**, gestión de rutas y usuarios, `settings.access`, `capital.manage`.

### 4.2 Diferencia real frente al Cobrador

Solo **dos** capacidades distinguen al Supervisor del Cobrador:

| Capacidad | Cobrador | Supervisor |
|---|---|---|
| `cashbox.viewRoute` | ❌ prohibida | ✅ concedida |
| `report.export` | ❌ prohibida | ✅ concedida |

Todo lo demás es idéntico. **El Supervisor NO tiene hoy ningún permiso que lo habilite a "supervisar" en sentido funcional** (no aprueba, no corrige, no cierra, no ve consolidados). Es un Cobrador que además ve la caja financiera de la ruta y puede exportar.

### 4.3 El Supervisor NO es un sujeto financiero

Éste es el hallazgo central del rol. Tres lugares distintos deciden si alguien "tiene caja", y **no coinciden**:

| Lugar | ¿El Supervisor puede responder por efectivo? | Evidencia |
|---|---|---|
| `collectorAttribution.hasPersonalCashbox()` | **SÍ** — `rol === 'cobrador' \|\| rol === 'supervisor'` | `src/lib/collectorAttribution.ts:100` |
| `collectorAttribution.resolveResponsibleCollector()` | **NO** — `activos = routeCollectors.filter(c => c.rol === 'cobrador' && ...)` | `src/lib/collectorAttribution.ts:70` |
| `saleRequestService.confirmDisbursement()` | **NO** — `disbursedByCollectorId: actor?.rol === 'cobrador' ? actor.id : undefined` | `src/services/saleRequestService.ts:236` |
| `CollectorExpensesPage` | **NO** — `collectorId: user.rol === 'cobrador' ? user.id : undefined` | `src/pages/collector/CollectorExpensesPage.tsx:58` |

**`hasPersonalCashbox()` no se usa en NINGÚN archivo de `src/`.** Solo se importa desde `tests/permissions.test.ts:51`. Es código muerto en producción que declara una intención que el resto del sistema contradice.

Resultado práctico: la pantalla "Mi caja" del Supervisor **siempre marca 0** salvo en rutas sin cobrador activo, aunque él tenga el dinero en el bolsillo.

---

## 5. Cobrador actual

### 5.1 Capacidades (`COBRADOR_CAPS`, línea 183)

Idénticas al Supervisor menos `cashbox.viewRoute` y `report.export`. Además `INCOMPATIBLE_BY_ROLE.cobrador` bloquea explícitamente `cashbox.viewRoute` con un comentario que lo justifica:

> «El Cobrador NO accede a información financiera de la ruta ni de la empresa: su caja es el efectivo que él ha recaudado, sin capital inicial ni consolidados.»

Esta regla está **bien implementada y se respeta en profundidad**: `CollectorCashClosePage` no solo oculta el bloque, sino que **ni siquiera llama** a `getRouteFinancialSummary()` si falta la capacidad (línea 44: *"Fail-closed: si no tiene la capacidad, el dato financiero NO se pide"*). Es un buen patrón y hay que conservarlo.

### 5.2 Ruta activa

`useActiveRoute` (Zustand + `persist`) guarda un mapa `userId → routeId` en `localStorage` bajo la clave `rutacash-active-route`. **Persistido por usuario**, así que dos usuarios en el mismo navegador no se pisan la selección.

### 5.3 Tres idiomas de scoping conviviendo

Barrido de `src/pages/collector/`:

| Pantalla | Idioma de alcance |
|---|---|
| CollectorHomePage | `activeRouteId` ✅ |
| CollectorRoutePage | `activeRouteId ?? user?.routeId` ✅ |
| CollectorDisbursementsPage | `activeRouteId` ✅ |
| CollectorExpensesPage | `activeRouteId ?? user?.routeId` ✅ |
| CollectorDailyReportPage | `activeRouteId ?? user?.routeId` ✅ |
| CollectorCashClosePage | `activeRouteId ?? user?.routeId` ✅ |
| CollectorNewClientPage | `getAuthorizedRouteIds` para la lista, `activeRouteId` como valor por defecto ⚠️ (aceptable: es un selector) |
| CollectorNewSalePage | `getAuthorizedRouteIds` para la lista de clientes ⚠️ |
| CollectorSelectRoutePage | `getAuthorizedRouteIds` ✅ (es la pantalla de selección: debe verlas todas) |
| **CollectorPaymentHistoryPage** | **`getAuthorizedRouteIds` SIN `activeRouteId`** ❌ |
| **CollectorSyncPage** | **`user.routeId` legacy, sin `activeRouteId`** ❌ |

---

## 6. Diferencias Supervisor vs Cobrador

| Capacidad | Cobrador actual | Supervisor actual | Modelo objetivo |
|---|---|---|---|
| Ver Route | ✅ `route.viewAssigned` | ✅ `route.viewAssigned` | Igual |
| Seleccionar Route | ✅ `useActiveRoute` | ✅ mismo componente | Igual |
| Ver clientes | ✅ `client.view` | ✅ `client.view` | Igual |
| Crear cliente | ✅ `client.create` | ✅ `client.create` | Igual |
| Registrar pago | ✅ `payment.register` | ✅ `payment.register` | Igual **+ poder quedar como responsable del efectivo** |
| Registrar venta | ⚠️ solo solicitud (`sale.createRequest`) | ⚠️ solo solicitud | Igual (decisión de negocio ya tomada) |
| Desembolsar | ✅ `sale.confirmDisbursement` — **y se le carga a su caja** | ✅ capacidad concedida — **pero NO se carga a caja de nadie** | Debe cargarse a la caja de quien entrega, sea cobrador o supervisor |
| Registrar gasto | ✅ `expense.register` — **cargado a su caja** | ✅ `expense.register` — **cargado a nadie** | Igual, cargado a quien lo pagó |
| Ver Mi Caja | ✅ `cashbox.viewOwnCollection` (muestra cifra real) | ✅ concedida (**muestra 0 casi siempre**) | Debe mostrar su efectivo real |
| Ver Base de la Route | ❌ bloqueada `cashbox.viewRoute` | ✅ concedida — **mezclada en la misma pantalla "Mi caja"** | Ver Base **como dato de la Ruta**, separado visual y conceptualmente de su caja |
| Ver cartera | ✅ en la tarjeta de ruta | ✅ misma tarjeta | Igual |
| Ver histórico de abonos | ✅ pero **sin filtrar por ruta activa** | ✅ mismo defecto | Debe respetar ruta activa |
| Cuadre | ⚠️ `cashbox.dailyClose` → solo vista del día | ⚠️ igual, y `settlement.close` PROHIBIDA | Cierre de SU responsabilidad; el cierre de RUTA sigue siendo del Admin |
| Alertas / badges | ❌ ninguna | ❌ ninguna | (fuera de alcance) |
| Múltiples Routes | ✅ `authorizedRouteIds` + ruta activa | ✅ igual | Igual |
| Exportar reportes | ❌ prohibida | ✅ `report.export` | Igual |
| Corregir pagos | ❌ | ❌ | Igual |
| Aprobar solicitudes | ❌ | ❌ | **Decisión de negocio pendiente** (§36) |

---

## 7. Autoría de pagos

Todo pago pasa obligatoriamente por `registerPayment()` (`src/services/paymentService.ts:216`). El servicio distingue **tres** conceptos, pero solo persiste **dos**:

| Concepto de negocio | Campo persistido | Estado |
|---|---|---|
| A. Responsable habitual de la Route | `Route.cobradorId` | ✅ existe, **no se usa en ningún cálculo financiero** |
| B. Usuario que registró el pago | `Payment.createdByUserId` | ✅ existe y se escribe siempre |
| C. Usuario responsable del efectivo | `Payment.collectorId` | ⚠️ existe, pero **solo puede ser un `cobrador`** |

La resolución vive en `resolveResponsibleCollector()` (`src/lib/collectorAttribution.ts:62`), con este orden:

```
1. requested  → debe ser cobrador ACTIVO de la ruta; si no → 'invalid'   [source: 'explicit']
2. actor.rol === 'cobrador' → responde él                                 [source: 'actor']
3. exactamente 1 cobrador activo en la ruta → se preselecciona            [source: 'single-route-collector']
4. varios cobradores activos → RECHAZO 'ambiguous' (COLLECTOR_REQUIRED)
5. NINGÚN cobrador activo → se atribuye al ACTOR                          [source: 'legacy-actor']
```

**La regla es buena y deliberada.** Su comentario de cabecera explica exactamente el problema que resuelve (antes el dinero iba a quien digitaba). Pero tiene un agujero: el paso 3 asume que *si hay un cobrador en la ruta, el dinero es suyo*. Cuando el Supervisor está cobrando en persona, esa asunción es falsa y **no hay forma de desmentirla**: el paso 1 rechaza a cualquiera que no sea `cobrador`.

---

## 8. Responsable del efectivo

### Quién puede serlo HOY

| Rol | ¿Puede ser `Payment.collectorId`? | ¿Puede ser `Sale.disbursedByCollectorId`? | ¿Puede ser `Expense.collectorId`? |
|---|---|---|---|
| cobrador (activo) | ✅ | ✅ | ✅ |
| cobrador (inactivo) | ❌ (filtrado por `status`) | ❌ | ❌ |
| supervisor | ❌ salvo ruta sin cobradores | ❌ **nunca** | ❌ **nunca** |
| admin / superadmin | ❌ salvo ruta sin cobradores | ❌ | ❌ |
| secretario / socio | ❌ (sin `payment.register`) | ❌ | ❌ |

### La asimetría

Las tres patas de la caja personal usan **tres reglas distintas**:

```
COBROS        → resolveResponsibleCollector()   → puede caer en el actor (legacy-actor)
DESEMBOLSOS   → actor.rol === 'cobrador' ? actor.id : undefined
GASTOS        → user.rol === 'cobrador' ? user.id : undefined
```

Consecuencia numérica: en una ruta SIN cobradores activos, un Supervisor que cobra $300.000 y desembolsa $200.000 verá en "Mi caja" **+300.000**, no **+100.000**. El desembolso salió de su bolsillo pero no se le descontó. Su cuadre no puede cerrar.

---

## 9. `Payment.collectorId`

| Pregunta | Respuesta |
|---|---|
| **¿Qué significa hoy?** | Cobrador (rol `cobrador`) que recibió físicamente el dinero y responde por él en su caja personal. |
| **¿Quién lo escribe?** | `paymentService.registerPayment()` (línea 319) vía `resolveResponsibleCollector()`. `paymentCorrectionService.executeCorrection()` lo **copia intacto** del pago original a la reversión y a la corrección (líneas 129 y 140). |
| **¿Cuándo?** | En el instante del registro, dentro de la transacción Dexie, leyendo los cobradores de la ruta **desde la base**, no desde la pantalla. |
| **¿Quién lo lee?** | `getCollectorDailyCashSummary()` (cashboxEngine:258) · `CollectorHomePage` KPI "Mi recaudo hoy" (línea 47) · `CollectorDailyReportPage` (línea 55) · `UsersPage` para contar pagos por usuario (línea 255). |
| **¿Qué motores lo usan?** | **Solo la caja personal.** `getCashboxSummary()` (caja de ruta) y `generateWeeklySettlement()` **lo ignoran por completo**. |
| **¿Qué reportes lo usan?** | Informe del día del operativo. **Ningún reporte administrativo ni el cuadre.** |
| **¿Uso inconsistente?** | Sí: es el eje de la caja personal, pero el cuadre —el documento que cierra la responsabilidad— no lo mira. Y no admite supervisores. |

**Índice Dexie:** sí, `payments: 'id, tenantId, saleId, clientId, routeId, collectorId, syncStatus, state, ...'` (`db.ts:117`). Consultable eficientemente.

---

## 10. `Payment.createdByUserId`

| Pregunta | Respuesta |
|---|---|
| **¿Qué significa hoy?** | Usuario que digitó la operación. Trazabilidad pura. |
| **¿Quién lo escribe?** | `registerPayment()` — siempre `input.actor.id` (línea 320). |
| **¿Cuándo?** | Siempre, en todo pago nuevo. |
| **¿Quién lo lee?** | **NADIE en `src/`.** Un barrido completo no encuentra ninguna lectura funcional. |
| **¿Qué motores lo usan?** | Ninguno. |
| **¿Qué reportes lo usan?** | Ninguno. Ni siquiera se muestra en el Histórico de abonos. |
| **Migración** | `db.ts:302` — v12 rellenó `createdByUserId ← collectorId` en pagos antiguos, con equivalencia legacy explícita y documentada. Correcto. |
| **¿Uso inconsistente?** | No es inconsistente: es **inerte**. El dato existe, es correcto y nadie lo aprovecha. |

**Hallazgo colateral [BUG menor]:** `executeCorrection()` NO escribe `createdByUserId` en la reversión ni en el pago corregido (líneas 126-146). Quedan con `createdByUserId: undefined`, que por la regla legacy equivale a `collectorId`. Se pierde la traza de que fue el Secretario quien generó esos dos asientos — aunque sí queda en `correctedBy`.

---

## 11. Caja personal

**Definición en código** (`getCollectorDailyCashSummary`, cashboxEngine:240):

```
recaudado    = Σ pagos VIGENTES  con p.collectorId === X  AND p.fecha === D
desembolsado = Σ ventas          con s.disbursedByCollectorId === X AND s.fechaDesembolso === D
                                  AND s.disbursementStatus !== 'pendiente'
gastos       = Σ gastos          con (e.collectorId ?? e.userId) === X AND e.fecha === D
────────────────────────────────────────────────────────────────────────────
efectivoAEntregar = recaudado − desembolsado − gastos
```

Características verificadas:

- **Es de UN DÍA.** `fecha === D`, igualdad exacta. La pantalla siempre pasa `today()` (`CollectorCashClosePage:42`). A las 00:00 vuelve a cero por sí sola.
- **NO lee** `capitalMovements`, `transfers` ni `withdrawals`. La superficie de datos (`CollectorCashDatabase`) solo declara `payments`, `sales`, `expenses`. Esto es **deliberado y correcto**: el dato no se puede filtrar ni por accidente.
- **NO tiene saldo anterior.** No arrastra nada de ayer.
- **Fail-closed:** sin `routeId` o sin `collectorId` devuelve ceros.
- Usa `effectivePayments()` → excluye `state: 'reversed'` y `state: 'reversal'`.

**Lo que esto significa:** la "caja personal" de RutaCash **no es una caja**, es un **informe diario de movimientos atribuidos**. Un cierre de responsabilidad necesita continuidad entre cierres; esto no la tiene.

---

## 12. Caja de Route

**Definición en código** (`getCashboxSummary`, cashboxEngine:36):

```
saldoAnterior = Σ(capital + cobros + transfIn − préstamos − gastos − transfOut − retiros)   con fecha < desde
saldoActual   = saldoAnterior + ingresoCapital + cobros + transferenciasEntradas
                              − prestamosEntregados − gastos − transferenciasSalidas − retiros
```

Detalles verificados:

- Rango por defecto: **`'2000-01-01'` → `today()`**. Sin rango, `saldoAnterior = 0` y todo el histórico cae en el periodo actual. (Confirmado ejecutando: §29 Pregunta crítica 3.)
- `prestamosEntregados` se filtra por **`s.fechaInicio`**, no por `s.fechaDesembolso`. Una venta creada el lunes y desembolsada el jueves se resta de la caja el **lunes**. Descuadre temporal real frente a la caja personal, que sí usa `fechaDesembolso`.
- Excluye ventas con `disbursementStatus === 'pendiente'`. Correcto.
- `cobros` suma **todas** las filas de `payments`, sin `effectivePayments()`. Funciona porque la reversión lleva `valor: -original.valor` y neteа. **Pero las dos cajas usan semánticas distintas para lo mismo** (una excluye el par, la otra lo suma): si alguna vez se escribiera una reversión con signo positivo, la caja de ruta se duplicaría y la personal no. Riesgo latente, no defecto actual.
- **No conoce el concepto de cierre.** `cashboxEngine.ts` no menciona `weeklySettlement` en ninguna línea.

---

## 13. Base

Es el concepto **más sobrecargado** del sistema. Significa cuatro cosas distintas según dónde se mire:

| Término en UI | Valor real | Origen |
|---|---|---|
| **"Base actual"** (Mi caja del Supervisor) | `getRouteFinancialSummary().baseActual` = `getCashboxSummary().saldoActual` | `CollectorCashClosePage:88` |
| **"Base actual"** (Retiros) | `getRouteAvailableCapital(routeId)` = mismo `saldoActual` | `WithdrawalsPage:66` |
| **"Capital actual"** (Capital) | `summary.baseActual` — mismo valor, **otro nombre** | `CapitalPage:104` |
| **`Route.capitalActual`** (campo persistido) | Se fija al crear la ruta y **nunca se recalcula** | `routeService.ts:172` |

**Hallazgo [TERMINOLOGÍA + DISEÑO]:** `Route.capitalActual` es un campo muerto que contradice al motor. Se escribe una vez (`capitalActual: input.capitalInicial`) y jamás se actualiza. Cualquier pantalla que lo leyera daría una cifra falsa.

**Respuesta directa: la Base pertenece hoy a la RUTA, a nadie más.** No existe ningún campo que vincule Base con un trabajador. Ver §29 Caso D.

---

## 14. Transferencias

### Modelo

`Transfer` admite cuatro combinaciones: Ruta→Ruta, Ruta→Socio, Socio→Ruta, Socio→Socio. Campos: `routeOrigenId`, `routeDestinoId`, `socioOrigenId`, `socioDestinoId`, `origenType`, `destinoType`, `valor`, `fecha`, **`userId`** (quien digitó).

**No hay campo de responsable del efectivo.** El único campo de persona es `userId` = quien lo registró en el panel administrativo.

### Efecto en las cajas

- **Caja de RUTA:** `transferenciasEntradas` = Σ transfers con `routeDestinoId === routeId`. Suma al saldo. ✅
- **Caja PERSONAL:** **cero efecto.** `CollectorCashDatabase` ni siquiera declara la tabla `transfers`.

### Punto 14 — "Transferencias recibidas" → "BASE RECIBIDA"

Barrido de la etiqueta en toda la UI:

| Ubicación | Texto actual |
|---|---|
| `WeeklySettlementPage.tsx:324` | **"(+) Transferencias recibidas"** ← la única con ese texto |
| `CashboxPage.tsx:104` | "(+) Transferencias entrantes" |
| `settlementPeriods.ts:334` (CSV de cierre) | "Transferencias entrada" |
| `WeeklySettlementPage.tsx:194` (CSV vista previa) | "Transferencias entrada" |
| `OfficeDetailPage.tsx:390` | sin etiqueta textual (par entrada/salida) |
| `SocioReportsPage.tsx:35` (CSV) | columna posicional |

**Veredicto sobre el renombrado: NO se puede renombrar en bloque.** `transferenciasEntradas` agrega movimientos de naturaleza distinta:

| Caso | ¿Es "Base recibida"? |
|---|---|
| Socio → Ruta | ✅ Sí. Es inyección de capital operativo. |
| Ruta A → Ruta B | ❌ No. Es una **reasignación interna**: para la ruta A es una salida y para la B una entrada; el capital de la empresa no cambió. |
| Externo → Ruta | ❌ No modelado. `routeOrigenId: ''` es posible pero no hay flujo que lo cree. |

Renombrar todo a "BASE RECIBIDA" haría que una ruta que recibe dinero de otra ruta hermana lo vea como "base nueva", cuando en realidad es dinero que otra ruta perdió. Si el socio llama "Base" a cualquier entrada de efectivo que el trabajador recibe, la etiqueta funciona; si distingue "capital del socio" de "traslado entre rutas", no. **Decisión de negocio pendiente (§36 D-6).**

---

## 15. Capital

`CapitalMovement { routeId, tipo: 'ingresoCapital'|'ajusteCapital', valor, fecha, userId }`.

- Sin campo de responsable de efectivo. `userId` = quien digitó.
- Se escribe en dos sitios: `CapitalPage:88` (directo desde el componente) y `routeService.ts:180` (capital inicial al crear la ruta, dentro de transacción).
- Efecto en caja de RUTA: `ingresoCapital` suma. ✅
- Efecto en caja PERSONAL: **ninguno**.
- `ajusteCapital` puede ser negativo, pero la UI no lo impide ni lo distingue en el cálculo: ambos tipos se suman igual (`cashboxEngine:48`).

---

## 16. Retiros

`Withdrawal { routeId, valor, fecha, userId }`. Escrito directo desde `WithdrawalsPage:85`.

- Sin responsable de efectivo.
- Resta de la caja de RUTA.
- **No resta de la caja de nadie.**
- **No hay validación de fondos**: `handleSave()` solo comprueba `routeId` y `valor > 0`. Se puede retirar más de lo que hay y dejar el saldo de ruta negativo. (A diferencia de las ventas, que sí validan con `hasCapitalForSale()`.)

Éste es exactamente el escenario del punto 13: *"Se retira parte del dinero de la caja del trabajador... el resultado esperado no se reflejó en la caja del trabajador."* No se reflejó porque **el retiro no toca la caja del trabajador, por diseño**.

---

## 17. Gastos

`Expense { routeId, categoryId, valor, fecha, userId, collectorId?, syncStatus }`.

Es el **único** movimiento no-pago que distingue "quién registró" de "a qué caja se carga". Escrito en dos sitios:

| Origen | `collectorId` |
|---|---|
| `CollectorExpensesPage:58` (app operativa) | `user.rol === 'cobrador' ? user.id : undefined` |
| `ExpensesPage:73` (admin) | **no se escribe nunca** → `undefined` |

Lectura (`cashboxEngine:268`): `(e.collectorId ?? e.userId) === collectorId`. El fallback legacy hace que un gasto administrativo registrado por un usuario que resulta ser cobrador **se le cargue a su caja personal aunque nunca se decidiera así**.

Migración v12 (`db.ts:307`): rellenó `collectorId ← userId` solo cuando ese usuario es cobrador. Coherente con el fallback.

---

## 18. Liquidación actual

**Qué se puede hacer hoy desde `WeeklySettlementPage` (Admin / Super Admin):**

1. Elegir Oficina (filtro visual) y **una Ruta obligatoria** — no existe modo consolidado.
2. Elegir rango `semanaInicio` / `semanaFin` con dos `<input type="date">` libres. Por defecto `getWeekStart()` (lunes) → `getWeekEnd()` (sábado).
3. **Generar**: vista previa, recalculada, no archivada.
4. **Cerrar semana**: `closeSettlement()` recalcula con el motor y archiva un `WeeklySettlement` con `status: 'cerrada'`, snapshot de Oficina, `version`, `closedAt`, `closedByUserId`.
5. **Reabrir** con motivo obligatorio (≥10 caracteres), conservando el documento.
6. **Re-cerrar** → crea versión N+1 y enlaza la anterior vía `supersededBy`.
7. Exportar CSV de la vista previa y CSV del documento archivado.

**Qué NO se puede hacer:**

- ❌ Ver los **movimientos** que componen cada cifra (solo los ocho totales).
- ❌ Ver **caja de la Route** como saldo vivo junto al cierre.
- ❌ Ver ni registrar el **saldo a entregar por trabajador**.
- ❌ Registrar cuánto **entregó realmente** el trabajador.
- ❌ Generar **traslado / retiro** desde la liquidación.
- ❌ Saber **quién** tenía ese dinero.
- ❌ Que el Supervisor o el Cobrador vean su propio cierre (`settlement.close`/`reopen` están en `INCOMPATIBLE_BY_ROLE` de ambos).

**Lo que SÍ funciona muy bien y hay que preservar:** el versionado no destructivo, el bloqueo de solapamiento (`closureBlockedReason`), el snapshot histórico de Oficina, la reapertura con motivo permanente, y el encadenado con `paymentCorrectionService` (un pago en semana cerrada exige Solicitud de ajuste). Esa maquinaria es correcta.

---

## 19. Cuadre actual

### Fórmula que realmente usa RutaCash

```
saldoAnterior        = Σ movimientos de la RUTA con fecha < semanaInicio     (desde 2000-01-01)
   + ingresoCapital          (capitalMovements.fecha ∈ [inicio, fin])
   + cobros                  (payments.fecha ∈ [inicio, fin], TODOS los cobradores)
   + transferenciasEntradas  (transfers.routeDestinoId = ruta)
   − prestamosEntregados     (sales.fechaInicio ∈ rango, disbursementStatus ≠ 'pendiente')
   − gastos                  (expenses.fecha ∈ rango, TODOS los usuarios)
   − transferenciasSalidas   (transfers.routeOrigenId = ruta)
   − retiros                 (withdrawals.fecha ∈ rango)
   ─────────────────────────────────────────────────────────────────────────
   = saldoFinal
```

### Dónde entra cada concepto

| Concepto | ¿Dónde entra en el cuadre? |
|---|---|
| **Base** | En `ingresoCapital` (si vino como CapitalMovement) o en `transferenciasEntradas` (si vino como Transfer). **Nunca como línea propia.** |
| **Efectivo personal del trabajador** | **NO ENTRA.** El cuadre no tiene dimensión de persona. |
| **Faltante** | **NO EXISTE.** |
| **Sobrante** | **NO EXISTE.** |
| **Qué se reinicia tras el cierre** | **NADA.** El cierre archiva un documento; ningún motor cambia de comportamiento después. El siguiente cálculo vuelve a recorrer el histórico completo. |

### ¿Es `WeeklySettlement` el cuadre que el negocio necesita?

**No.** Es un **estado de cuenta de ruta por rango de fechas**. Le faltan las cuatro propiedades que definen un cuadre:

| Propiedad exigida | ¿La tiene? |
|---|---|
| Cierra la responsabilidad de UNA PERSONA | ❌ no hay campo de trabajador |
| Parte del último cierre, no del calendario | ❌ el rango es manual; por defecto lunes-sábado |
| Registra lo REALMENTE entregado | ❌ no hay campo de entrega |
| Deja la caja corriente en cero | ❌ ningún motor consulta el cierre |

`WeeklySettlement` es un **buen documento de ruta** y debe conservarse. El cuadre de trabajador es una **entidad nueva**, no una reforma de ésta.

---

## 20. Relación con el último cierre

### ¿Existe forma robusta de obtener `lastClosedSettlementAt`?

**Parcialmente, y solo POR RUTA.** Existe en un solo sitio, y es un subproducto de otra función:

```ts
// src/lib/settlementPeriods.ts:290  (dentro de pendingSettlements)
const cerradas = settlements
  .filter(s => s.routeId === r.id && isProtectingClosure(s))
  .map(s => s.semanaFin)
  .sort()
lastClosedUntil: cerradas.length > 0 ? cerradas[cerradas.length - 1] : null
```

Limitaciones:

- Es **por ruta**, nunca por trabajador (`WeeklySettlement` no tiene ese campo).
- Devuelve `semanaFin` (una **fecha**, `yyyy-MM-dd`), no un **instante**. Dos cierres el mismo día no se pueden ordenar.
- Solo alimenta el aviso `PendingSettlementsNotice`. **Ningún motor financiero lo consume.**
- No hay función exportada `getLastClosedSettlement(routeId)` ni equivalente.

### ¿El cuadre debe ser por Route, por Trabajador, o por ambos?

Analizando el caso del Supervisor sustituyendo temporalmente al Cobrador, la evidencia apunta a **ROUTE + TRABAJADOR**, con dos documentos de naturaleza distinta:

| Documento | Dimensión | Responde a |
|---|---|---|
| **Cierre de RUTA** (`WeeklySettlement`, ya existe) | `routeId` + rango | "¿Cuánto capital administra esta ruta?" — es la contabilidad del socio. |
| **Cuadre de TRABAJADOR** (nuevo) | `routeId` + `userId` + `[desdeInstante, hastaInstante]` | "¿Cuánto efectivo debe entregar esta persona y cuánto entregó?" — es el arqueo físico. |

Por qué **no** basta con uno solo:

- **Solo por Ruta** → es lo que hay hoy: cuando Juan y Laura trabajan la misma ruta en la misma semana, el cuadre no puede decir de quién es el faltante.
- **Solo por Trabajador** → el socio pierde la visión de capital de la ruta; y la Base, los retiros y las transferencias no pertenecen a ninguna persona.
- **Route + Trabajador** → el cierre de ruta agrega los cuadres de trabajador del periodo más los movimientos estructurales (capital, transferencias, retiros) que no son de nadie. Cuadran entre sí y cada uno responde a su pregunta.

---

## 21. Faltantes

**NO EXISTE. En absoluto.**

Barrido exhaustivo sobre `src/` de: `faltante`, `sobrante`, `shortfall`, `surplus`, `carriedBalance`, `previousBalance` (como saldo de trabajador), `deuda`, `arrastre`, `ajuste` (como ajuste de caja):

| Coincidencia | ¿Es lo que buscamos? |
|---|---|
| `paymentService.previousBalance` | ❌ es el saldo de una **venta**, no de un trabajador |
| `financialReconciliation.previousBalance` | ❌ ídem, en el informe de diagnóstico |
| `routeService.ts:206 faltantes` | ❌ es una lista de **campos ausentes** al crear la ruta |
| `WeeklySettlement.saldoAnterior` | ❌ es el saldo de la **ruta** arrastrado por fechas, no una deuda de nadie |
| `PaymentAdjustmentRequest` | ❌ es una solicitud de corrección de **un pago concreto**, no un ajuste de caja |

**No existe:** entidad, tabla, campo, tipo, ni siquiera la palabra en un comentario.

**Consecuencia del escenario del punto 10:** si el sistema calcula $1.000.000 a entregar y el trabajador entrega $900.000:

- El sistema **no sabe** que debía entregar $1.000.000 (no hay concepto de "a entregar acumulado", solo el diario).
- El sistema **no sabe** que entregó $900.000 (no hay dónde anotarlo).
- El $100.000 **no existe en ninguna parte**.
- Al día siguiente la caja personal vuelve a 0 por el cambio de fecha, y el faltante desaparece sin dejar rastro.

**El faltante no "se pierde al cerrar el cuadre": nunca llegó a existir.**

---

## 22. Sobrantes

### Comportamiento actual

Idéntico al faltante, **también inexistente**. Si el sistema espera $1.000.000 y el trabajador entrega $1.050.000, el excedente no tiene dónde registrarse y el sistema nunca se entera.

Lo más cercano que existe es `LEGACY-001 "Sobrepago histórico"` en `financialReconciliation.ts:59` — pero eso es otra cosa: detecta que se **cobró a un cliente más de lo que se aplicó a su deuda**, un defecto de datos antiguos. No tiene relación con el arqueo del trabajador.

Sí existe, en cambio, una **protección contra el sobrante de origen**: `registerPayment()` topa el abono al saldo pendiente (`appliedAmount = Math.min(requestedAmount, previousBalance)`), así que un sobrepago de cliente no puede entrar en caja. Eso funciona y está probado (RC-BUG-001).

### Riesgos de NO modelarlo

1. **Encubre faltantes anteriores.** Si Juan tuvo $100.000 de faltante el lunes y el martes entrega $100.000 de más, sin modelo ambos desaparecen y nadie detecta el patrón.
2. **Encubre cobros no registrados.** Un sobrante sistemático suele significar que el cobrador está recibiendo dinero que no digita. Es una señal de control interno que hoy se pierde.
3. **Pérdida contable.** Si el sobrante se ingresa como capital sin traza, el capital de la ruta crece sin origen identificable.

### Alternativas posibles

| Opción | Tratamiento | Ventaja | Inconveniente |
|---|---|---|---|
| **A. Simétrico al faltante** | Saldo a favor del trabajador, se arrastra al siguiente ciclo y se compensa contra faltantes futuros | Contablemente limpio; el arrastre es un solo número con signo | El trabajador acumula "crédito" en la empresa, lo que puede no ser la intención del negocio |
| **B. Ingreso a la Ruta** | Se registra como `CapitalMovement` de tipo `ajusteCapital` con motivo obligatorio | El dinero queda en la empresa de inmediato | Requiere decidir si se le devuelve al trabajador; sin eso, es una retención |
| **C. Excepción bloqueante** | No se permite cerrar con sobrante: hay que explicarlo y clasificarlo (devolución / ingreso / corrección de pago) antes de cerrar | Fuerza a investigar el origen, que es lo que un sobrante debe provocar | Fricción operativa; puede bloquear el cierre al final del día |

### Recomendación funcional

**Opción A como mecanismo, con la clasificación de la C como gesto de UI.** Concretamente:

- El cuadre registra `diferencia = entregado − esperado`, con signo.
- `diferencia < 0` → faltante, arrastra como deuda del trabajador.
- `diferencia > 0` → sobrante, arrastra como saldo a favor.
- **Cualquier** `diferencia ≠ 0` exige un `motivo` obligatorio, igual que ya se exige para reabrir una liquidación (patrón ya establecido y aceptado en el sistema).
- El siguiente cuadre parte de `arrastreAnterior` y lo compensa automáticamente.

Un solo campo con signo evita duplicar lógica, y el motivo obligatorio conserva el valor de control interno sin bloquear la operación.

**Esto es una recomendación, no una decisión. Ver §36 D-3.**

---

## 23. Sincronización — mismo dispositivo

### Escenario A: dos usuarios, mismo navegador, misma IndexedDB

| Qué | ¿Se comparte? | Dónde vive |
|---|---|---|
| Pagos, ventas, clientes, gastos, capital, transferencias, retiros, liquidaciones | ✅ **SÍ, instantáneamente** | IndexedDB (`rutacash`), compartida por origen |
| Usuarios, rutas, oficinas, empresa | ✅ SÍ | IndexedDB |
| Auditoría | ✅ SÍ | IndexedDB |
| **Ruta activa** | ❌ NO — y es correcto | `localStorage` `rutacash-active-route`, mapa `userId → routeId` |
| **Sesión** | ❌ NO | `useAuth` (Zustand persist, prefijo `rutacash-`) |
| **Último email de login** | ⚠️ compartido | `localStorage` `rutacash-…` (`lastLoginEmail.ts`) |

**Refresco entre pestañas:** las pantallas cargan con `useEffect` al montar y al cambiar dependencias. **No hay `liveQuery` ni `BroadcastChannel`**: si el Supervisor registra un pago en una pestaña, la pestaña del Cobrador **no se entera hasta que navegue o recargue**. Los datos están ahí; la vista está obsoleta.

**Veredicto Escenario A:** todo se comparte a nivel de datos. Los síntomas que aparecen aquí son **bugs reales de cálculo/scoping**, no limitaciones de transporte.

---

## 24. Sincronización — cross-device

### Escenario B: dos dispositivos / navegadores distintos

> ### ¿Supervisor y Cobrador en dos equipos diferentes comparten hoy pagos realmente?
> # **NO.**

**Por qué, con evidencia:**

1. **No hay backend.** Barrido completo de `src/` buscando `fetch(`, `axios`, `supabase`, `XMLHttpRequest`, `WebSocket`, `BroadcastChannel`: **cero coincidencias**. Las únicas coincidencias de almacenamiento son `localStorage`/`sessionStorage` en `factoryReset.ts` y `lastLoginEmail.ts`.

2. **`syncService` es una simulación declarada.** `src/services/syncService.ts:1-2`: *"Servicio de sincronización - simula sync en V1 local"*. `syncPendingItems()` hace literalmente:
   ```ts
   await db.payments.update(p.id, { syncStatus: 'synced' })
   ```
   Cambia una etiqueta en la MISMA base. Con el comentario explícito *"En V2 con Supabase: aquí iría la lógica real de push a servidor"*.

3. **El propio repositorio lo prueba.** `tests/platform.test.ts` §CROSS-DEVICE:
   - `CROSS-DEVICE-001`: afirma `CONTROL_PLANE_IS_SHARED === false` y verifica que no haya clientes HTTP ocultos, *"no puede haber una sincronización simulada: o hay backend o se dice que no lo hay"*.
   - `CROSS-DEVICE-002`: prueba ejecutable con dos bases en memoria — un cambio en el dispositivo B **no llega** al A.
   - `CROSS-DEVICE-003/004`: el contrato del backend pendiente está documentado en `docs/CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md`.

4. **`PROTOCOLO_PRUEBA_DOS_EQUIPOS.md`** ya existe en `docs/`.

### La distinción crítica

> **NO confundir estos dos diagnósticos.** Durante las pruebas reales, un síntoma como *"el Supervisor cobró y no aparece"* puede tener dos causas completamente distintas:
>
> | Si las pruebas se hicieron en… | Diagnóstico |
> |---|---|
> | **El mismo navegador** | **BUG de cálculo/atribución.** Los datos están ahí. Ver §29 Casos B y C. |
> | **Dispositivos distintos** | **LIMITACIÓN cross-device.** No hay nada que arreglar en el motor financiero: falta el backend. |
>
> El indicador "Online/Offline" de la app **no significa sincronizado**: solo lee `navigator.onLine`. Es engañoso en el estado actual.

**Implicación para el plan:** el punto 6 (supervisión temporal) tiene sentido **solo dentro de un mismo dispositivo** hasta que exista backend. Laura debe operar en el equipo donde vive la base de la ruta, o los datos no existirán para nadie más.

---

## 25. Histórico del Cobrador

### Causa exacta

`src/pages/collector/CollectorPaymentHistoryPage.tsx`, función `init()`:

```ts
34:    const routeIds = getAuthorizedRouteIds(user)          // ← TODAS las rutas autorizadas
35:    const allClients = await db.clients.where('tenantId').equals(user.tenantId).toArray()
36:    const mine = allClients.filter(c => routeIds.includes(c.routeId))
37:    setClients(mine)
```

La pantalla **nunca importa `useCollectorRoute` / `useActiveRoute`**. Es la **única** pantalla operativa con acceso a datos que lo omite (ver tabla §5.3). Un cobrador con Route A y Route B ve en el selector de Cliente los clientes de ambas, trabajando en A.

### Dos defectos secundarios en la misma pantalla

1. **`onSelectClient` ignora el alcance por completo:**
   ```ts
   57:    const cs = await db.sales.where('clientId').equals(id).toArray()
   ```
   Trae **todas** las ventas del cliente sin filtrar por ruta. Un cliente que pasó de Route A a Route B mostraría ventas de ambas.

2. **No aplica `effectivePayments()`:**
   ```ts
   67:    const ps = await db.payments.where('saleId').equals(sid).toArray()
   ```
   Un pago corregido aparece **tres veces** en la lista: el original ($100.000), la reversión (−$100.000) y la corrección ($80.000). `totalAbonado` suma correctamente por el neteo, pero la lista visible es confusa. Todas las demás pantallas operativas sí usan `effectivePayments()`.

### Un tercer caso del mismo patrón

`CollectorSyncPage:23` usa `user.routeId` (campo legacy de ruta única) en vez de `activeRouteId`. Un cobrador multi-ruta ve pendientes de la ruta equivocada.

**Clasificación: SCOPING, aislado, sin impacto financiero** (es solo visualización; no altera cálculos ni escrituras).

---

## 26. Badge Secretario

### Cómo se calcula el badge del Admin

`src/components/layout/AdminLayout.tsx:56-71`:

```ts
const [pendingAuth, setPendingAuth] = useState(0)
useEffect(() => {
  countPendingSaleRequests(tenantId).then(n => setPendingAuth(n))
  countPendingAdjustmentRequests(tenantId).then(n => setPendingAdj(n))
}, [tenantId, location.pathname])

const badges = {
  '/admin/sale-authorizations': pendingAuth,
  '/admin/payment-adjustments': pendingAdj,
}
// ...render:
{badges[item.path] > 0 && <CountBadge count={badges[item.path]} />}
```

Se recalcula en cada cambio de ruta de navegación. Componente `CountBadge` reutilizable, ya existe.

### Estado del Secretario

`src/components/layout/SecretarioLayout.tsx` monta cuatro `NavLink` (Clientes, Autorizaciones, Corrección de pagos, Cuenta). **Ningún badge, ningún contador, ningún `useEffect` de datos.**

### El obstáculo real: el contador NO recorta por rutas

```ts
// src/services/saleRequestService.ts:208
export async function countPendingSaleRequests(tenantId: string): Promise<number> {
  const reqs = await db.saleRequests.where('tenantId').equals(tenantId).toArray()
  return reqs.filter(r => r.status === 'pending').length          // ← toda la EMPRESA
}
```

Mientras tanto, la **pantalla** del Secretario sí recorta correctamente:

```ts
// src/pages/secretario/SecretarioAuthorizationsPage.tsx:66
const accessible = reqs.filter(r => can(user, 'authorization.access', { routeId: r.routeId }))
```

**Consecuencia si se reutilizara el contador tal cual:** el badge diría "5" y la lista mostraría 2. Inconsistencia visible y difícil de explicar al usuario.

**Hallazgo colateral [SCOPING]:** el mismo defecto afecta **hoy** al Admin. Un Administrador con dos rutas de las cinco de la empresa ya ve un badge inflado. Esto no se ha reportado pero es el mismo bug. Lo mismo vale para `countPendingAdjustmentRequests`.

### ¿Qué debe contar el Secretario?

`SECRETARIO_CAPS` incluye `authorization.access/approve/reject/modifyConditions/phoneConfirm` y `payment.correct`, pero **NO** `payment.approveAdjustment`. Por tanto:

- ✅ Solicitudes de venta `pending` de **sus rutas autorizadas** → badge en `/secretario/autorizaciones`.
- ❌ Solicitudes de ajuste de pago → **no puede aprobarlas**. No debe contarlas. (Él las *origina*; las aprueba el Admin.)

### ¿Se puede reutilizar el componente?

`CountBadge` sí, tal cual. El **contador** no: hay que darle una variante que reciba el usuario y filtre por rutas accesibles (y que, de paso, arregle el badge del Admin).

---

## 27. Matriz de responsabilidad financiera

Leyenda: ✅ sí · ❌ no · **AMBIGUO / NO MODELADO** cuando el sistema no puede responder.

| Movimiento | Route | Actor real (quién digitó) | Responsable efectivo | Afecta caja trabajador | Afecta caja Route | Entra al cuadre |
|---|---|---|---|---|---|---|
| **Pago (cobrador)** | `Payment.routeId` ✅ | `createdByUserId` ✅ | `collectorId` = el cobrador ✅ | ✅ `+valor` | ✅ `+cobros` | ✅ (como cifra de ruta) |
| **Pago (supervisor, ruta CON cobrador activo)** | ✅ | `createdByUserId` = supervisor ✅ | ❌ **INCORRECTO**: se asigna al cobrador habitual | ✅ pero **a la caja equivocada** | ✅ | ✅ pero **a nombre de otro** |
| **Pago (supervisor, ruta SIN cobrador activo)** | ✅ | ✅ | ⚠️ al supervisor, por fallback `legacy-actor` | ✅ a la caja del supervisor | ✅ | ✅ |
| **Pago (admin, ruta con varios cobradores)** | ✅ | ✅ | ✅ exigido explícitamente (`COLLECTOR_REQUIRED`) | ✅ | ✅ | ✅ |
| **Desembolso (cobrador)** | `Sale.routeId` ✅ | `disbursedByUserId` ✅ | `disbursedByCollectorId` ✅ | ✅ `−valorVenta` | ✅ `−prestamos` | ✅ |
| **Desembolso (supervisor/admin)** | ✅ | `disbursedByUserId` ✅ | ❌ **`undefined`** | ❌ **a nadie** | ✅ | ✅ |
| **Gasto (cobrador, app operativa)** | `Expense.routeId` ✅ | `userId` ✅ | `collectorId` ✅ | ✅ `−valor` | ✅ `−gastos` | ✅ |
| **Gasto (supervisor, app operativa)** | ✅ | `userId` ✅ | ❌ `undefined` | ❌ **a nadie** | ✅ | ✅ |
| **Gasto (admin)** | ✅ | `userId` ✅ | ❌ nunca se escribe | ⚠️ fallback `e.userId`: si ese admin fuera cobrador, se le carga por accidente | ✅ | ✅ |
| **Base recibida** | **NO MODELADO como concepto propio** | — | — | — | — | — |
| **Transferencia entrante** | `routeDestinoId` ✅ | `Transfer.userId` ✅ | ❌ **NO MODELADO** | ❌ no | ✅ `+transferenciasEntradas` | ✅ |
| **Transferencia saliente** | `routeOrigenId` ✅ | `Transfer.userId` ✅ | ❌ **NO MODELADO** | ❌ no | ✅ `−transferenciasSalidas` | ✅ |
| **Capital** | `CapitalMovement.routeId` ✅ | `userId` ✅ | ❌ **NO MODELADO** | ❌ no | ✅ `+ingresoCapital` | ✅ |
| **Retiro** | `Withdrawal.routeId` ✅ | `userId` ✅ | ❌ **NO MODELADO** | ❌ no | ✅ `−retiros` | ✅ |
| **Ajuste / corrección de pago** | `routeId` heredado ✅ | `correctedBy` ✅ | hereda `collectorId` del original ⚠️ | ✅ neteado | ✅ neteado | ✅ |
| **Faltante** | **NO MODELADO** | — | — | — | — | — |
| **Sobrante** | **NO MODELADO** | — | — | — | — | — |

**Lectura de la matriz:** seis filas de once tienen "NO MODELADO" en *Responsable efectivo*. Todo lo que no es un pago o un gasto de cobrador **no pertenece a nadie**. Ése es el hueco del modelo.

---

## 28. Flujo real Payment → Caja → Cuadre

```
┌─ PaymentPage.handlePay()  (misma pantalla para /collector y /supervisor)
│    · lee importe y observación
│    · CollectorPicker → collectorId (SOLO si el actor NO es cobrador Y la ruta
│                        tiene cobradores; el supervisor NUNCA aparece en la lista)
│    · syncStatus = navigator.onLine ? 'synced' : 'pending'
│
└──► registerPayment()  ─── TRANSACCIÓN DEXIE ['payments','installments','sales','users','routes','offices']
       │
       ├─ 1. RELECTURA FRESCA: sales.get(saleId)          (nada de la UI es fuente de verdad)
       ├─ 2. can(actor, 'payment.register', {routeId: sale.routeId, tenantId: sale.tenantId})
       ├─ 2b. Oficina de la ruta activa (isRouteOperationBlocked)
       ├─ 3. sale.status === 'activa'  &&  disbursementStatus !== 'pendiente'
       ├─ 4. previousBalance = calculateSaleBalance(installments)   ← parcelas = libro mayor
       ├─ 4b. ATRIBUCIÓN ──► resolveResponsibleCollector({actor, requested, routeCollectors})
       │                      routeCollectors = users.rol==='cobrador' ∧ ruta asignada
       │                      ⚠️ el SUPERVISOR nunca está en esta lista
       ├─ 5. appliedAmount = min(requested, previousBalance)        ← tope duro
       ├─ 6. applyPaymentToInstallments()
       └─ 7. ESCRITURA: payments.add({collectorId, createdByUserId, valor: appliedAmount, ...})
                        installments.update(×N)
                        sales.update({saldo, status, fechaFinalizacion?})
       ─── COMMIT ───
       8. auditSink(REGISTER_PAYMENT)   ← FUERA de la transacción; su fallo no revierte el pago

                    ┌─────────────────────────────┬──────────────────────────────┐
                    ▼                             ▼                              ▼
       CAJA PERSONAL                    CAJA DE RUTA                    REPORTES
  getCollectorDailyCashSummary     getCashboxSummary(routeId,          reportService
    filtra p.collectorId === X       desde, hasta)                     (sin dimensión
    filtra p.fecha === HOY           suma TODOS los cobradores          de persona)
    NO lee transfers/capital/        lee capital, transfers,
       withdrawals                      withdrawals
                    │                             │
                    │                             ▼
                    │                  generateWeeklySettlement()
                    │                    (delegación 100 %)
                    │                             │
                    │                             ▼
                    │                  closeSettlement()  ──► weeklySettlements.add({status:'cerrada'})
                    │                             │
                    │                             ▼
                    │                  paymentCorrectionService
                    │                    isPaymentInClosedPeriod() ──► exige Solicitud de ajuste ✅
                    │
                    ✗  ─────────── NO HAY NINGUNA CONEXIÓN ───────────►
                       La caja personal no sabe que hubo un cierre.
                       El cierre no sabe que hay cajas personales.
```

**El único efecto real de cerrar un periodo hoy** es activar la protección de corrección de pagos. Eso funciona y está probado (`SMOKE-E5-3`, `SMOKE-E5-4`). No hay ningún otro efecto.

---

## 29. Casos forenses

Todos los casos se ejecutaron contra **los servicios reales de producción** (`registerPayment`, `getCollectorDailyCashSummary`, `getCashboxSummary`, `generateWeeklySettlement`) sobre la base en memoria de `tests/financial/harness.ts`. El script es temporal, vivió en el directorio de sesión y **no se añadió al repositorio**. Salida literal:

### CASO A — Cobrador registra su propio pago

```
Juan (cobrador, activo) registra $100.000 en Ruta Norte
   resultado ................................ OK 100000
   Payment.collectorId ...................... u-juan
   Payment.createdByUserId .................. u-juan
   fuente de atribución ..................... actor
   Mi caja de Juan · efectivoAEntregar ...... 100000
```

✅ **CORRECTO.** El caso normal funciona perfectamente.

### CASO B — Supervisor registra pago en Route de otro Cobrador (Juan ACTIVO)

```
Laura (supervisor) registra $300.000; Juan sigue ACTIVO
   resultado ................................ OK 300000
   Payment.collectorId ...................... u-juan    ← ¿de quién es el dinero?
   Payment.createdByUserId .................. u-laura
   fuente de atribución ..................... single-route-collector
   Mi caja de JUAN  · efectivoAEntregar ..... 300000
   Mi caja de LAURA · efectivoAEntregar ..... 0
   ¿Laura puede auto-asignarse el dinero? ... RECHAZADO (COLLECTOR_INVALID)
```

❌ **DEFECTO CONFIRMADO.** El dinero que Laura tiene físicamente aparece en la caja de Juan. Y Laura **no tiene ninguna forma de corregirlo**: pasar `collectorId: 'u-laura'` se rechaza porque el paso 1 de `resolveResponsibleCollector` exige que el `requested` sea un **cobrador activo de la ruta**. Un supervisor nunca lo es.

Éste es el **hallazgo más grave** de la auditoría: no es un descuido, es una **imposibilidad estructural**.

### CASO C — Cobrador inhabilitado + Supervisor cobra (PREGUNTA CRÍTICA 1)

```
Juan INHABILITADO (status: 'inactivo'); Laura cobra $300.000
   resultado ................................ OK 300000
   Payment.collectorId ...................... u-laura
   Payment.createdByUserId .................. u-laura
   fuente de atribución ..................... legacy-actor
   Mi caja de JUAN  · efectivoAEntregar ..... 0
   Mi caja de LAURA · efectivoAEntregar ..... 300000
   Cuadre de la RUTA · cobros ............... 300000
   ¿el cuadre distingue a Laura de Juan? .... campo de trabajador: NINGUNO
```

⚠️ **FUNCIONA, PERO POR ACCIDENTE.** Al inhabilitar a Juan, `activos` queda vacío, se salta hasta el paso 5 y cae en `legacy-actor` → el actor. El resultado es el **correcto por negocio**, pero llega por la rama que el propio código documenta como *"el único caso sin alternativa razonable"*. Nadie lo diseñó para esto.

Fragilidad demostrable: **basta con que la ruta tenga un segundo cobrador activo** para que la rama sea la 4 (`ambiguous`) y **Laura no pueda registrar el pago en absoluto** — el servicio devolvería `COLLECTOR_REQUIRED` y le exigiría elegir entre cobradores que no recibieron el dinero.

### CASO D — Route recibe Base (PREGUNTA CRÍTICA 2)

```
La ruta recibe $1.000.000 de Base (transferencia entrante)
   Caja de RUTA · transferenciasEntradas .... 1000000
   Caja de RUTA · saldoActual (Base actual) . 1000000
   Mi caja de JUAN · efectivoAEntregar ...... 0
   campos de responsable en Transfer ........ userId
   Transfer.userId (quien digitó) ........... u-seed
```

✅ Evidencia clara: **la Base es de la Ruta y de nadie más.** El trabajador que físicamente recibe ese millón no lo tiene en ninguna caja propia.

### CASO E — Cuadre completo sin diferencia

```
Capital 2.000.000 + Cobros 1.000.000, cuadre 2026-09-21 → 2026-09-26
   cuadre · cobros .......................... 1000000
   cuadre · saldoFinal ...................... 3000000
   campos del documento WeeklySettlement:
     id, tenantId, routeId, semanaInicio, semanaFin, saldoAnterior,
     ingresoCapital, cobros, prestamosEntregados, gastos,
     transferenciasEntradas, transferenciasSalidas, retiros, saldoFinal, createdAt
   ¿campo de trabajador responsable? ........ NO
```

⚠️ **"Sin diferencia" no se puede ni expresar.** El documento no tiene campo `esperado` ni `entregado`: no existe una diferencia que pueda ser cero. El cierre solo dice que la ruta tiene $3.000.000 en caja.

### CASO F — Cuadre con faltante

**NO EJECUTABLE.** No hay campo donde registrar lo entregado. El escenario del punto 10 (esperado $1.000.000, entregado $900.000) **no se puede representar en el sistema actual**. Ver §21.

### CASO G — Cuadre con sobrante

**NO EJECUTABLE.** Misma razón. Ver §22.

### CASO H — Capital → Route → Liquidación → Retiro

Flujo reconstruido del código (no requiere ejecución, es determinista):

```
1. CapitalPage       → db.capitalMovements.add({routeId, valor: 5.000.000})
                       ├─ caja de RUTA: +5.000.000  ✅
                       └─ caja de JUAN:          0  ❌
2. Juan cobra         → registerPayment() → collectorId = Juan
                       ├─ caja de RUTA: +cobros     ✅
                       └─ caja de JUAN: +recaudado  ✅
3. WeeklySettlement   → closeSettlement() archiva documento con saldoFinal
                       ├─ caja de RUTA: sin cambio (es un documento, no un asiento) ✅
                       └─ caja de JUAN: sin cambio, NO se entera del cierre  ❌
4. WithdrawalsPage    → db.withdrawals.add({routeId, valor: 3.000.000})
                       ├─ caja de RUTA: −3.000.000  ✅
                       └─ caja de JUAN:          0  ❌  ← el síntoma reportado
5. Siguiente ciclo    → getCashboxSummary sin rango vuelve a sumar desde 2000-01-01
                       └─ caja de JUAN: 0 por cambio de día, no por cierre  ❌
```

**El punto 13 queda explicado:** el retiro no se refleja en la caja del trabajador porque **`withdrawals` no es una tabla que la caja personal lea**. `CollectorCashDatabase` declara exactamente tres tablas: `payments`, `sales`, `expenses`. La caja personal es **estructuralmente incapaz** de ver un retiro, una transferencia o un capital.

---

### PREGUNTA CRÍTICA 3 — ¿cashboxEngine conoce el cierre?

```
Se cierra la semana 2026-09-07 → 2026-09-12 con cobros 500.000 (documento 'cerrada')
Después se registran 300.000 el 2026-09-21

   getCashboxSummary SIN rango · cobros ......... 800000  (incluye los 500.000 ya cerrados)
   getCashboxSummary SIN rango · saldoAnterior .. 0
   cashboxEngine importa weeklySettlements? ..... NO
   cashboxEngine tiene lastClosedSettlementAt? .. NO
```

> ## **NO.**
>
> `cashboxEngine.ts` (291 líneas) **no menciona `weeklySettlements` en ninguna línea**. Su rango por defecto es `'2000-01-01'` → `today()`. Cerrar un periodo **no cambia absolutamente nada** en el cálculo de caja. El único consumidor de los cierres es `paymentCorrectionService.isPaymentInClosedPeriod()`, para proteger correcciones.

---

### PREGUNTA CRÍTICA 1 — ¿A quién pertenece el efectivo de Laura?

> Juan = Cobrador Route Norte · Laura = Supervisor · Juan inhabilitado · Laura cobra $300.000 · se hace cuadre.

**Respuesta en dos niveles, porque el sistema responde distinto en cada uno:**

| Nivel | Respuesta | Evidencia |
|---|---|---|
| **`Payment.collectorId`** (caja personal) | **LAURA** — pero solo porque Juan está inhabilitado *y* la ruta no tiene otro cobrador activo. Con Juan activo sería **JUAN** (Caso B). Con dos cobradores activos, el pago **se rechazaría**. | `collectorAttribution.ts:93`, Casos B y C |
| **El cuadre (`WeeklySettlement`)** | **AMBIGUO / NO MODELADO** — el documento solo dice `cobros: 300000` en la ruta. No hay campo que nombre a nadie. | `models/types.ts:673-733`, Caso C |

**Veredicto:** el efectivo pertenece a **LA ROUTE**, con una atribución personal frágil que existe solo en la caja diaria y que **el cuadre descarta**. La respuesta más honesta al socio es: **AMBIGUO**, porque depende de un estado (¿está Juan activo? ¿hay otro cobrador?) que nadie considera al cobrar.

---

### PREGUNTA CRÍTICA 2 — ¿A quién pertenece la Base?

> La Route recibe $1.000.000 de Base.

> ## **A LA ROUTE. A nadie más.**

Evidencia:

1. `Transfer` y `CapitalMovement` **no tienen campo de responsable de efectivo**. Solo `userId` = quien digitó (Caso D: `u-seed`).
2. `CollectorCashDatabase` (`cashboxEngine.ts:222`) declara **solo** `payments`, `sales`, `expenses`. La caja personal no puede leer transferencias ni capital ni aunque quisiera.
3. `Route.cobradorId` existe pero **ningún cálculo financiero lo lee**.
4. La Base solo aparece como `getCashboxSummary().saldoActual`, una cifra de ruta.

Ni Cobrador, ni Supervisor, ni usuario activo. **La Route.**

---

### PREGUNTA CRÍTICA 4 — ¿Hay lugar persistente para un faltante?

> ## **NO.**

No existe entidad, tabla, campo ni tipo. Barrido completo documentado en §21. Las únicas coincidencias textuales (`previousBalance`, `saldoAnterior`, `faltantes`) significan otras cosas.

---

## 30. Causas raíz encontradas

| # | Causa raíz | Tipo | Evidencia | Gravedad |
|---|---|---|---|---|
| **R-1** | El **Supervisor no puede ser responsable de efectivo**. `resolveResponsibleCollector` solo admite `rol === 'cobrador'`, y `requested` se valida contra esa lista. | **ATRIBUCIÓN** | `collectorAttribution.ts:70,75`; Caso B | 🔴 Crítica |
| **R-2** | El **cuadre no tiene dimensión de persona**. `WeeklySettlement` es por `routeId` + rango de fechas. | **DISEÑO** | `models/types.ts:673`; Caso C | 🔴 Crítica |
| **R-3** | El **motor de caja ignora los cierres**. `cashboxEngine` no importa `weeklySettlements`; rango por defecto desde 2000. | **DISEÑO** | Pregunta crítica 3 | 🔴 Crítica |
| **R-4** | **No existe faltante ni sobrante**, ni el campo "entregado realmente". | **DISEÑO** | §21, §22, Casos F/G | 🔴 Crítica |
| **R-5** | La **caja personal es diaria y no acumula**. `fecha === D`, sin saldo anterior. Se reinicia por calendario, no por cierre. | **DISEÑO** | `cashboxEngine:258,268` | 🔴 Crítica |
| **R-6** | **Base / capital / transferencias / retiros no tienen responsable**. Seis de once filas de la matriz son "NO MODELADO". | **DISEÑO** | §27; Caso D; Caso H | 🟠 Alta |
| **R-7** | **Atribución asimétrica**: cobros usan una regla, desembolsos otra, gastos otra. Un Supervisor desembolsa y no se le descuenta. | **BUG** | `saleRequestService.ts:236`; `CollectorExpensesPage.tsx:58` | 🟠 Alta |
| **R-8** | **`hasPersonalCashbox()` es código muerto que contradice al sistema**: dice que el supervisor tiene caja; nada en `src/` lo respeta. | **DISEÑO** | `collectorAttribution.ts:100`, sin usos en `src/` | 🟡 Media |
| **R-9** | **"Mi caja" mezcla dos contabilidades en una pantalla**. Título "efectivo bajo tu responsabilidad" + bloque "Caja de la ruta · Base actual". | **UX** | `CollectorCashClosePage.tsx:61,80-95` | 🟠 Alta |
| **R-10** | **Tres idiomas de scoping** en la capa operativa: `activeRouteId`, `getAuthorizedRouteIds`, `user.routeId`. | **SCOPING** | §5.3 | 🟡 Media |
| **R-11** | **Histórico de abonos no filtra por ruta activa**; además no usa `effectivePayments()` ni filtra ventas por ruta. | **SCOPING** | `CollectorPaymentHistoryPage.tsx:34,57,67` | 🟡 Media |
| **R-12** | **Badges no recortan por rutas autorizadas** (afecta al Admin HOY, y bloquea la reutilización para el Secretario). | **SCOPING** | `saleRequestService.ts:208` | 🟡 Media |
| **R-13** | **El Secretario no tiene badge**: `SecretarioLayout` no monta contador. | **UX** | `SecretarioLayout.tsx:12-17` | 🟢 Baja |
| **R-14** | **"Transferencias recibidas" agrega naturalezas distintas** (socio→ruta y ruta→ruta). Renombrar en bloque sería incorrecto. | **TERMINOLOGÍA** | §14 | 🟡 Media |
| **R-15** | **"Base" significa cuatro cosas** y `Route.capitalActual` es un campo muerto que contradice al motor. | **TERMINOLOGÍA** | §13 | 🟡 Media |
| **R-16** | **Sin backend no hay nada cross-device.** `syncService` es una simulación declarada. | **SINCRONIZACIÓN** | §24; `CROSS-DEVICE-001..004` | 🟠 Alta (de expectativa) |
| **R-17** | **Capital / transferencias / retiros se escriben desde el componente**, sin servicio, sin transacción, sin punto único de regla. | **DISEÑO** | §3.2 | 🟠 Alta |
| **R-18** | **Préstamos se restan por `fechaInicio`, no por `fechaDesembolso`** en la caja de ruta; la caja personal sí usa `fechaDesembolso`. Descuadre temporal entre las dos. | **BUG** | `cashboxEngine:64` vs `:263` | 🟡 Media |
| **R-19** | **Retiro sin validación de fondos.** Puede dejar el saldo de ruta negativo. | **BUG** | `WithdrawalsPage.tsx:72` | 🟡 Media |
| **R-20** | **`createdByUserId` es un dato inerte**: se escribe siempre, no lo lee nadie. Y la corrección de pagos no lo escribe. | **DISEÑO** | §10 | 🟢 Baja |
| **R-21** | **La UI no refresca entre pestañas**: sin `liveQuery` ni `BroadcastChannel`. Escenario A puede parecer roto sin estarlo. | **UX** | §23 | 🟡 Media |
| **R-22** | **El indicador "Online" es engañoso**: solo lee `navigator.onLine`, no implica sincronización. | **UX** | `useOnlineStatus.ts` | 🟡 Media |

---

## 31. Qué funciona correctamente hoy

**Esto es importante: la base del sistema es sólida.** Nada de lo siguiente debe tocarse.

1. **`paymentService.registerPayment()` como fuente única.** Relectura fresca dentro de la transacción, autorización contra la ruta real de la venta, tope duro al saldo, atomicidad con rollback, auditoría fuera de la transacción financiera. Es el mejor código del repositorio. Cubierto por 151 pruebas financieras.
2. **La separación `collectorId` / `createdByUserId` es conceptualmente CORRECTA.** El problema no es el diseño, es que el universo de valores válidos de `collectorId` es demasiado estrecho.
3. **`resolveResponsibleCollector` es conservador donde debe serlo.** Con varios cobradores **no adivina**: exige elegir (`COLLECTOR_REQUIRED`). Esa decisión es acertada y hay que conservarla.
4. **Motor de parcelas (`installmentEngine`).** La auditoría previa y la línea base demuestran que el reparto es correcto.
5. **Corrección controlada de pagos.** Nunca borra: reversión con signo negativo + pago de reemplazo + enlaces bidireccionales + motivo obligatorio. Modelo ejemplar.
6. **Versionado y protección de cierres.** Bloqueo de solapamiento, versión incremental, `supersededBy`, reapertura con motivo permanente, snapshot histórico de Oficina. Probado por `SMOKE-E5-1..6`.
7. **Scoping por `authorizedRouteIds`, fail-closed.** `isRouteUnrestricted` solo para superadmin; se eliminó explícitamente la regla insegura "admin sin rutas = todas las rutas".
8. **Aislamiento de la caja del Cobrador.** No se oculta el dato: **no se pide**. `CollectorCashDatabase` no declara `capitalMovements`, `transfers` ni `withdrawals`. Patrón a replicar.
9. **`hasCapitalForSale()`**: devuelve un veredicto booleano sin revelar el monto, para conservar la regla de negocio en pantallas donde el usuario no debe ver cifras financieras. Solución elegante.
10. **`effectivePayments()` como semántica única** de qué pagos cuentan, extraída a un módulo puro sin dependencias de Dexie.
11. **Honestidad arquitectónica sobre cross-device.** El sistema **se niega a fingir** que sincroniza: hay pruebas que fallarían si alguien pusiera un `fetch` simulado. Eso vale más que una falsa sensación de sincronización.
12. **Modelo de Oficina no invasivo.** Ninguna entidad financiera copia `officeId`; se deriva por `routeId`. Los cierres guardan snapshot histórico. Correcto.
13. **Capa operativa compartida sin duplicación.** `SupervisorLayout` = `CollectorLayout`; mismas pantallas vía `useOpBase`. La arquitectura para "Supervisor = Cobrador ampliado" **ya está construida**.
14. **1008 pruebas, 0 fallos, tipado limpio, build correcto.**

---

## 32. Qué debe cambiar

Ordenado por dependencia, no por urgencia.

| # | Cambio | Resuelve |
|---|---|---|
| **C-1** | Ampliar el universo de "responsable de efectivo" de `cobrador` a **`cobrador ∪ supervisor`**, en las **tres** reglas a la vez (cobros, desembolsos, gastos). Unificarlas en un único predicado derivado de `hasPersonalCashbox()`, que pasa de código muerto a fuente única. | R-1, R-7, R-8 |
| **C-2** | `CollectorPicker` debe ofrecer **al supervisor actor** como opción válida, y `resolveResponsibleCollector` aceptarlo como `requested`. | R-1 |
| **C-3** | Renombrar semánticamente `Payment.collectorId` → concepto **"responsable del efectivo"** (sin migración de datos; el campo y el índice se conservan). Documentar la ampliación. | R-1 |
| **C-4** | Crear la entidad **`CashSettlement`** (cuadre de trabajador): `routeId` + `userId` + `desde` (instante) + `hasta` (instante) + `esperado` + `entregado` + `diferencia` + `arrastreAnterior` + `motivo` + `status` + trazabilidad de cierre. | R-2, R-4 |
| **C-5** | Hacer que la caja personal acepte un **rango** `[desde, hasta]` en vez de un día fijo, y que su punto de partida sea **el último `CashSettlement` cerrado**, no medianoche. | R-3, R-5 |
| **C-6** | Añadir **arrastre con signo** (`arrastreAnterior`): faltante negativo, sobrante positivo. Motivo obligatorio si `diferencia ≠ 0`. | R-4 |
| **C-7** | Función única **`getLastClosedSettlement(routeId, userId?)`** que devuelva un **instante**, no una fecha. | R-3 |
| **C-8** | Dar responsable de efectivo a **Base / transferencias / retiros** cuando el dinero pasa por manos de una persona; mantenerlos sin responsable cuando es un movimiento estructural (socio↔empresa). Requiere decisión de negocio (§36 D-2). | R-6 |
| **C-9** | Extraer **`transferService` / `capitalService` / `withdrawalService`** con transacción, validación de permiso y de Oficina en el servicio. | R-17, R-19 |
| **C-10** | Separar en "Mi caja": **"Mi efectivo"** (responsabilidad personal) y **"Caja de la Ruta"** como pantalla o sección claramente ajena. | R-9 |
| **C-11** | Unificar el scoping operativo en **`activeRouteId`** como único idioma. Corregir `CollectorPaymentHistoryPage` y `CollectorSyncPage`. | R-10, R-11 |
| **C-12** | Aplicar `effectivePayments()` y filtro por ruta en el Histórico de abonos. | R-11 |
| **C-13** | Variante de los contadores de badge que **recorta por rutas accesibles** (arregla el Admin y habilita el Secretario). | R-12 |
| **C-14** | Badge de autorizaciones pendientes en `SecretarioLayout`, reutilizando `CountBadge`. | R-13 |
| **C-15** | Terminología: distinguir **"Base recibida"** (socio→ruta) de **"Traslado entre rutas"** (ruta→ruta), en vez de renombrar en bloque. Requiere decisión (§36 D-6). | R-14 |
| **C-16** | Eliminar o recalcular `Route.capitalActual`; fijar un glosario único de Base / Base actual / Total controlado. | R-15 |
| **C-17** | En la tarjeta de ruta del Supervisor, añadir **Base** condicionada a `cashbox.viewRoute` (el Cobrador debe seguir sin verla). | punto 2 |
| **C-18** | Alinear el criterio temporal del desembolso: la caja de ruta debe usar `fechaDesembolso`, igual que la personal. | R-18 |
| **C-19** | Refresco reactivo entre pestañas (`liveQuery` de Dexie) y aclarar el indicador "Online". | R-21, R-22 |
| **C-20** | Modelar la **supervisión temporal** como un estado explícito (quién opera la ruta ahora), en vez de inferirla de `status: 'inactivo'` del cobrador. Requiere decisión (§36 D-1). | R-1, punto 6 |

---

## 33. Qué NO debe cambiar

| # | No tocar | Por qué |
|---|---|---|
| **N-1** | La arquitectura de `registerPayment()`: relectura fresca, autorización en el dominio, tope al saldo, atomicidad, auditoría fuera de la transacción. | Es la garantía contra RC-BUG-001..005. Ampliar el universo de responsables **no requiere** cambiar nada de esto. |
| **N-2** | El rechazo `COLLECTOR_REQUIRED` con varios cobradores. | Adivinar el responsable es exactamente lo que causó el problema original. |
| **N-3** | `CollectorCashDatabase` como superficie mínima. | Si la caja personal pasa a leer `transfers`, debe hacerlo por una superficie NUEVA y explícita, nunca ampliando ésta "por comodidad". |
| **N-4** | El bloqueo de `cashbox.viewRoute` para el Cobrador, y el patrón *"si no tiene la capacidad, el dato no se pide"*. | Es privacidad real, no cosmética. |
| **N-5** | El versionado no destructivo de cierres y `paymentCorrectionService`. | Único mecanismo de trazabilidad financiera del sistema. |
| **N-6** | El scoping por `authorizedRouteIds`, fail-closed. | Regla de seguridad. No relajarla para "facilitar" la supervisión temporal. |
| **N-7** | Que `WeeklySettlement` sea **por ruta**. | Es correcto para lo que es. El cuadre de trabajador es una entidad **nueva**, no una reforma de ésta. |
| **N-8** | Que `Sale.saldo` sea denormalizado y las **parcelas** sean el libro mayor. | El servicio ya recalcula desde parcelas y corrige derivas. |
| **N-9** | La honestidad sobre cross-device y sus pruebas. | No "arreglar" `syncService` con algo que parezca sincronizar sin serlo. |
| **N-10** | El snapshot histórico de Oficina en los cierres. | Impide reescribir el pasado al reorganizar el catálogo. |
| **N-11** | Los 1008 casos existentes. | **Ninguna expectativa actual debe modificarse para hacer pasar código nuevo.** Si una prueba estorba, es señal de que el diseño nuevo rompe una garantía vigente. |

---

## 34. Riesgos de modificarlo

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| **Datos históricos sin responsable.** Pagos y gastos existentes con `collectorId` de un cobrador que en realidad cobró un supervisor. | Alta | Medio | **No reescribir el histórico.** El primer `CashSettlement` de cada trabajador arranca con `arrastreAnterior = 0` y una marca de "inicio de modelo". Igual que hizo la migración v12 con `createdByUserId`. |
| **Ampliar `collectorId` a supervisores rompe la caja del cobrador.** Si `single-route-collector` deja de aplicarse cuando el actor es supervisor, pagos que antes iban a Juan ahora van a Laura. | Alta | **Alto** | Debe ser una **elección explícita en la UI** (el picker incluye al supervisor pero **no lo preselecciona**), nunca un cambio silencioso de la rama por defecto. Es una decisión de negocio (§36 D-1). |
| **Un cuadre que resta de la caja rompe el aislamiento actual.** | Media | Alto | El `CashSettlement` debe ser un **documento**, no un asiento. La caja personal se calcula como `Σ movimientos posteriores al último cierre + arrastre`. Nunca se borra ni se modifica un movimiento. |
| **El arrastre puede duplicar dinero** si un cierre se reabre sin revertir el arrastre del siguiente. | Media | **Alto** | Reaplicar el modelo de `supersededBy`: reabrir un cuadre de trabajador debe bloquear el siguiente, o crear una cadena versionada con el mismo rigor que `weeklySettlements`. |
| **Solapamiento de periodos de trabajador.** Dos cuadres del mismo trabajador con rangos que se pisan. | Media | Alto | Reutilizar `periodsOverlap` / `closureBlockedReason`, que ya resuelven esto para rutas. |
| **Migración del esquema Dexie (v14).** | Alta | Medio | El repositorio tiene 55 pruebas de migración y un patrón establecido (v9-v13). Escribir la migración con su prueba **antes** del código funcional. |
| **Confundir bug con límite cross-device durante las pruebas.** | **Muy alta** | Medio | **Toda prueba de aceptación debe declarar el escenario (A o B).** Usar `docs/PROTOCOLO_PRUEBA_DOS_EQUIPOS.md`. |
| **Renombrar "Transferencias recibidas" mal.** | Alta | Bajo | No renombrar hasta resolver §36 D-6. |
| **Ampliar `cashbox.viewRoute` para mostrar "Base" en la tarjeta de ruta.** | Media | **Alto** | La tarjeta la comparten Cobrador y Supervisor. Debe condicionarse con `can()`, **nunca** concediendo la capacidad al Cobrador. |
| **Regresión en la suite.** | Media | Alto | La suite es el contrato. Ejecutar los seis comandos + `tsc` + `build` en **cada** paquete del plan, no solo al final. |

---

## 35. Modelo objetivo recomendado

### 35.1 Principio rector

> **La Route dice DÓNDE. El Usuario dice QUIÉN. El dinero pertenece a QUIEN LO TIENE, hasta que lo entregue y se le cierre.**

Tres planos separados que hoy están mezclados en dos:

```
┌──────────────────────────────────────────────────────────────────────┐
│  PLANO 1 — CAPITAL DE LA EMPRESA          (existe, correcto)         │
│  Capital · Transferencias socio↔ruta · Retiros · Cartera             │
│  Responsable: la RUTA / el SOCIO. Documento: WeeklySettlement.       │
├──────────────────────────────────────────────────────────────────────┤
│  PLANO 2 — EFECTIVO EN MANOS DE UNA PERSONA     (a construir)        │
│  Base entregada · Cobros · Desembolsos · Gastos · Entregas           │
│  Responsable: un USUARIO (cobrador o supervisor).                    │
│  Documento: CashSettlement (nuevo). Arrastra faltantes y sobrantes.  │
├──────────────────────────────────────────────────────────────────────┤
│  PLANO 3 — DEUDA DEL CLIENTE                    (existe, correcto)   │
│  Ventas · Parcelas · Abonos                                          │
│  Responsable: el CLIENTE. Motor: installmentEngine.                  │
└──────────────────────────────────────────────────────────────────────┘
```

Hoy los planos 1 y 2 están fundidos en `cashboxEngine`, y el plano 2 no tiene documento.

### 35.2 Entidad nueva: `CashSettlement`

Forma propuesta (**no implementada**; sujeta a las decisiones del §36):

```
CashSettlement
  id, tenantId
  routeId                  DÓNDE
  userId                   QUIÉN responde  ← la dimensión que falta hoy
  desde, hasta             INSTANTES (no fechas): desde = hasta del cierre anterior
  arrastreAnterior         faltante (−) o sobrante (+) heredado
  baseRecibida             efectivo que se le entregó en el periodo
  recaudado                Σ pagos con responsable = userId en [desde, hasta]
  desembolsado             Σ ventas que él entregó
  gastos                   Σ gastos cargados a él
  esperado                 arrastreAnterior + baseRecibida + recaudado − desembolsado − gastos
  entregado                lo que REALMENTE entregó  ← el campo que hoy no existe
  diferencia               entregado − esperado
  motivo                   OBLIGATORIO si diferencia ≠ 0
  status                   'abierta' | 'cerrada' | 'reabierta'
  version, supersededBy    mismo patrón no destructivo que WeeklySettlement
  closedAt, closedByUserId, reopenedAt, reopenedByUserId, reopenReason
```

Y el ciclo:

```
arrastreAnterior(N+1) = diferencia(N)
desde(N+1)            = hasta(N)
```

Cuando `diferencia = 0`, `arrastreAnterior` del siguiente ciclo es 0 → **la caja corriente del trabajador queda en cero**, que es exactamente lo que pide el punto 9. Y cuando hay faltante, `arrastreAnterior` negativo lo mantiene vivo hasta que se resuelva → punto 10.

### 35.3 Relación entre los dos documentos

```
WeeklySettlement (RUTA)  ────── agrega ──────►  N × CashSettlement (TRABAJADOR)
     +                                              del periodo
  movimientos estructurales
  (capital, transferencias
   socio↔ruta, retiros)
```

El cierre de ruta **no se sustituye**: se enriquece. Puede mostrar la lista de cuadres de trabajador del periodo y sus diferencias.

### 35.4 Supervisión temporal

Modelarla explícitamente en vez de inferirla:

- El Supervisor entra a la ruta y **el sistema le pregunta si va a manejar efectivo**.
- Si dice que sí, abre su propio `CashSettlement` sobre esa ruta, y a partir de ahí es un responsable válido en el `CollectorPicker`.
- El Cobrador habitual **no necesita estar inhabilitado** para que esto funcione: ambos pueden tener cuadres abiertos sobre la misma ruta, porque la clave es `routeId + userId`.
- Inhabilitar al cobrador sigue siendo una acción de Admin, pero deja de ser el mecanismo implícito de traspaso de responsabilidad.

### 35.5 Lo que NO cambia

`WeeklySettlement`, `paymentService`, `installmentEngine`, `paymentCorrectionService`, el scoping y el aislamiento de la caja del Cobrador se conservan íntegros. El modelo objetivo **añade una dimensión**; no reescribe la existente.

---

## 36. Decisiones funcionales que necesito tomar

Éstas **no se pueden inferir del código**. Las lista la auditoría; las responde el negocio.

| # | Decisión | Opciones | Por qué bloquea |
|---|---|---|---|
| **D-1** | **¿Cuándo el Supervisor responde por el efectivo?** | (a) Siempre que cobre en persona — debe elegirse explícitamente en el picker. (b) Solo cuando el cobrador habitual está inhabilitado. (c) Solo cuando declara "voy a manejar efectivo" al entrar a la ruta. | Determina si se cambia la rama por defecto de `resolveResponsibleCollector` (riesgo alto §34) o solo se añade una opción al picker. |
| **D-2** | **Cuando la Route recibe Base, ¿quién responde por ese efectivo?** | (a) Nadie: sigue siendo de la Ruta. (b) El trabajador que la recibe físicamente — requiere campo de responsable en `Transfer`. (c) Depende del tipo: socio→ruta tiene responsable, ruta→ruta no. | Define si `Transfer` y `CapitalMovement` necesitan campo nuevo y migración. |
| **D-3** | **¿Qué se hace con un SOBRANTE?** | (a) Saldo a favor que arrastra. (b) Ingreso a la Ruta con motivo. (c) Bloquear el cierre hasta clasificarlo. (Recomendación de la auditoría: a + motivo obligatorio, §22.) | Cambia la semántica del arrastre y las reglas del cierre. |
| **D-4** | **¿El faltante bloquea al trabajador?** | (a) No: solo se arrastra. (b) Sí: no puede abrir un nuevo ciclo hasta resolverlo. (c) Se avisa al Admin pero no bloquea. | Afecta a guardas de acceso operativo. |
| **D-5** | **¿Quién cierra el cuadre del trabajador?** | (a) El propio trabajador (se autodeclara). (b) Un Admin/Supervisor que recibe el dinero. (c) Ambos: el trabajador declara, el receptor confirma. | Define qué capacidad nueva se crea y quién la tiene. Hoy `settlement.close` está PROHIBIDA para cobrador y supervisor. |
| **D-6** | **¿"Transferencias recibidas" → "BASE RECIBIDA" en todos los casos?** | (a) Sí: toda entrada es Base para el trabajador. (b) No: solo socio→ruta es Base; ruta→ruta es "Traslado recibido". | Sin esta respuesta, el renombrado (punto 14) haría el informe menos exacto, no más. |
| **D-7** | **¿Cuál es el periodo natural del cuadre de trabajador?** | (a) Desde el último cierre, sin calendario (lo pedido en el punto 8). (b) Diario obligatorio. (c) Libre, pero con aviso si pasan N días sin cerrar. | Define si el rango es manual, automático o vigilado. |
| **D-8** | **¿El Supervisor debe poder cerrar SU propio cuadre pero no el de la Ruta?** | (a) Sí. (b) No: el Admin cierra todo. | Define la granularidad de las capacidades nuevas. |
| **D-9** | **¿Qué pasa con el efectivo que un trabajador tiene cuando lo inhabilitan?** | (a) Su cuadre queda abierto y pendiente. (b) Se fuerza un cierre. (c) Se traspasa al supervisor. | Afecta al flujo de supervisión temporal y a la integridad del arrastre. |
| **D-10** | **¿Cuándo se construye el backend?** | (a) Antes de este plan. (b) Después. (c) En paralelo. | Si los usuarios van a estar en dispositivos distintos, **todo este plan es invisible entre ellos**. Es la decisión de mayor impacto de la lista. |

**No se han inventado respuestas a ninguna de estas preguntas.** El plan del §37 está construido para que las decisiones D-1 a D-9 puedan tomarse **después del Paquete A** sin rehacer trabajo.

---

## 37. PLAN DE IMPLEMENTACIÓN CONSOLIDADO

**Un solo plan, en cuatro fases encadenadas.** Los paquetes no son proyectos aislados: cada uno deja al siguiente el terreno preparado. Las fases 0 y 1 no dependen de ninguna decisión de negocio y pueden ejecutarse de inmediato.

---

### FASE 0 — DESATASCO (sin decisiones pendientes, sin riesgo financiero)

Cambios aislados, verificables, sin tocar ningún motor de dinero. Dan valor inmediato y despejan ruido para las fases siguientes.

#### Paquete G — Histórico y scoping del Cobrador
- **G-1** `CollectorPaymentHistoryPage`: usar `activeRouteId` en vez de `getAuthorizedRouteIds` para la lista de clientes.
- **G-2** Misma pantalla: filtrar `db.sales.where('clientId')` por la ruta activa.
- **G-3** Misma pantalla: aplicar `effectivePayments()` al listado de abonos.
- **G-4** `CollectorSyncPage`: sustituir `user.routeId` por `activeRouteId`.
- **G-5** Prueba de contrato (al estilo de `sourceContract.ts`) que verifique que **ninguna** pantalla operativa con acceso a datos usa `getAuthorizedRouteIds` sin `activeRouteId`, salvo `CollectorSelectRoutePage`.
- *Resuelve: punto 15, R-10, R-11.*

#### Paquete H — Badges del Secretario (y del Admin)
- **H-1** Crear el contador con alcance: `countPendingSaleRequestsForUser(user, tenantId)` filtrando por `can(user, 'authorization.access', { routeId })`, mismo criterio que ya usa `SecretarioAuthorizationsPage:66`.
- **H-2** Cambiar `AdminLayout` para usarlo → **corrige el badge inflado del Admin**, que es un bug vigente.
- **H-3** Añadir badge de autorizaciones pendientes en `SecretarioLayout`, reutilizando `CountBadge`.
- **H-4** No contar ajustes de pago en el Secretario (no tiene `payment.approveAdjustment`).
- *Resuelve: punto 16, R-12, R-13.*

#### Paquete T — Terminología y glosario (sin renombrar aún)
- **T-1** Documentar el glosario único: Base / Base actual / Total controlado / Cartera / Efectivo a entregar.
- **T-2** Marcar `Route.capitalActual` como `@deprecated` o eliminarlo (no lo lee nadie hoy).
- **T-3** Unificar "Transferencias entrantes" / "Transferencias entrada" / "Transferencias recibidas" en **una sola** etiqueta neutra, a la espera de D-6.
- *Resuelve: parte de R-14, R-15.*

**Salida de fase 0:** suite en 1008+ PASS. Tres síntomas visibles resueltos. Ningún motor financiero tocado.

---

### FASE 1 — TRAZABILIDAD Y RESPONSABILIDAD (prerequisito de todo lo demás)

Aquí se resuelve la causa raíz R-1. **Sin esto, el cuadre por trabajador no tiene sobre qué construirse.**

#### Paquete A — El Supervisor pasa a ser sujeto financiero
- **A-1** Promover `hasPersonalCashbox()` de código muerto a **predicado único** del sistema. Toda decisión de "¿este usuario puede responder por efectivo?" pasa por ahí.
- **A-2** `resolveResponsibleCollector`: el conjunto de candidatos válidos pasa de `rol === 'cobrador'` a `hasPersonalCashbox(rol)` **para el paso 1 (`requested`)**. El paso 3 (`single-route-collector`) **no cambia todavía** — depende de D-1.
- **A-3** `CollectorPicker`: incluir al **actor supervisor** como opción, etiquetada sin ambigüedad ("Yo — {nombre}"). **Sin preselección.**
- **A-4** Simetrizar las otras dos reglas:
  - `confirmDisbursement`: `disbursedByCollectorId = hasPersonalCashbox(actor.rol) ? actor.id : undefined`.
  - `CollectorExpensesPage`: `collectorId = hasPersonalCashbox(user.rol) ? user.id : undefined`.
- **A-5** `executeCorrection`: escribir `createdByUserId = actor.id` en la reversión y en la corrección (hoy quedan `undefined`).
- **A-6** Documentar la ampliación en los comentarios de `Payment.collectorId` y `collectorAttribution.ts`.
- *Resuelve: R-1, R-7, R-8, R-20. Habilita: puntos 4, 5, 6.*

> **Punto de decisión.** Al terminar el Paquete A, D-1 debe estar respondida para saber si el paso 3 de la atribución cambia (y con él, la rama por defecto). El resto de la fase 1 no depende de ello.

#### Paquete B — Supervisor operativo
- **B-1** Separar "Mi caja": **"Mi efectivo"** arriba, **"Caja de la Ruta"** en una sección visualmente ajena o pantalla aparte, con encabezado propio que diga que es información de la ruta, no responsabilidad personal.
- **B-2** Añadir **Base** a la tarjeta de ruta, **condicionada a `can(user, 'cashbox.viewRoute', { routeId })`**. El Cobrador sigue viendo Clientes / Ventas / Cartera; el Supervisor ve además Base.
- **B-3** Modelar la supervisión temporal según D-1 (probablemente una declaración explícita al entrar a la ruta).
- *Resuelve: puntos 1, 2, 3, 6; R-9.*

**Salida de fase 1:** el Supervisor puede quedarse con el efectivo que realmente recibe, y su "Mi caja" muestra una cifra verdadera. **Los Casos B y C del §29 cambian de resultado.**

---

### FASE 2 — EL CUADRE REAL (el núcleo)

#### Paquete D — Cuadre por trabajador
- **D-1p** Esquema Dexie **v14**: tabla `cashSettlements` con índices `[routeId+userId]`, `tenantId`, `status`. Migración + su prueba **antes** del código funcional (patrón v9-v13).
- **D-2p** `getLastClosedSettlement(routeId, userId?)` → devuelve un **instante**, no una fecha. Fuente única.
- **D-3p** `getCollectorCashSummary(routeId, userId, desde, hasta)`: generalizar el motor diario a un rango. **Conservar** `getCollectorDailyCashSummary` como caso particular (`desde = hasta = fecha`) para no romper las 151 pruebas financieras.
- **D-4p** `cashSettlementService`: `open` / `close` / `reopen`, con el **mismo** rigor que `settlementService` — solapamiento bloqueado (`periodsOverlap`), versión incremental, `supersededBy`, motivo obligatorio al reabrir, auditoría.
- **D-5p** Pantalla de cuadre del trabajador: **esperado vs. entregado**, diferencia, motivo, lista de movimientos del periodo.
- **D-6p** Enriquecer `WeeklySettlementPage` con los cuadres de trabajador del periodo (punto 12: ver caja de la ruta, movimientos, saldo a entregar, traslado).
- *Resuelve: puntos 8, 9, 12; R-2, R-3, R-5.*

#### Paquete E — Faltantes y sobrantes
- **E-1** Campo `arrastreAnterior` con signo en `CashSettlement`.
- **E-2** Encadenado `arrastreAnterior(N+1) = diferencia(N)`.
- **E-3** Motivo obligatorio cuando `diferencia ≠ 0` (patrón ya aceptado en `reopenSettlement`).
- **E-4** Reglas de bloqueo por faltante según D-4.
- **E-5** Tratamiento del sobrante según D-3.
- **E-6** Indicador de faltante pendiente por trabajador para el Admin.
- *Resuelve: puntos 10, 11; R-4, R-6 (parcial).*

**Salida de fase 2:** los Casos E, F y G del §29 pasan a ser ejecutables. Un cierre limpio deja la caja del trabajador en cero; un faltante sobrevive al cierre.

---

### FASE 3 — CAPITAL Y BASE

#### Paquete C+F — Servicios de movimiento y responsabilidad de la Base
- **C-1p** Extraer `transferService`, `capitalService`, `withdrawalService`: transacción Dexie, permiso y Oficina validados **en el servicio**, base inyectable (patrón `paymentService`).
- **C-2p** `withdrawalService`: validación de fondos (R-19), reutilizando el criterio de `hasCapitalForSale()`.
- **C-3p** Atomicidad transferencia + movimiento de Caja socios (hoy son dos escrituras sueltas).
- **F-1** Responsable de efectivo en Base/transferencias/retiros **según D-2**. Si la respuesta es (b) o (c), añadir el campo en v15 y hacer que el cuadre de trabajador lo incorpore como `baseRecibida`.
- **F-2** Alinear el criterio temporal del desembolso (`fechaDesembolso` en ambas cajas) — R-18.
- **F-3** Renombrado terminológico definitivo **según D-6**.
- *Resuelve: puntos 13, 14; R-6, R-14, R-17, R-18, R-19.*

#### Paquete S — Sincronización (transversal, según D-10)
- **S-1** Refresco reactivo entre pestañas con `liveQuery` de Dexie (mismo dispositivo) — R-21.
- **S-2** Aclarar el indicador "Online" para que no sugiera sincronización — R-22.
- **S-3** El backend real es un proyecto aparte; su contrato ya está en `docs/CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md`. **No forma parte de este plan.**
- *Resuelve: punto 7 en lo que es resoluble sin backend.*

---

## 38. Orden de implementación recomendado

```
FASE 0 ── G ──► H ──► T                      sin decisiones, sin riesgo financiero
             │
             ▼
        ┌─── DECISIÓN D-1 ───┐
        ▼                    │
FASE 1 ── A ──► B            │               Supervisor = sujeto financiero
             │               │
             ▼               │
        ┌─── DECISIONES D-3, D-4, D-5, D-7, D-8, D-9 ───┐
        ▼                                               │
FASE 2 ── D ──► E                                       │   el cuadre real
             │                                          │
             ▼                                          │
        ┌─── DECISIONES D-2, D-6 ───┐                    │
        ▼                           │                   │
FASE 3 ── C+F                       │                   │   capital y Base
             │
             ▼
        S (transversal, condicionado a D-10)
```

**Justificación del orden:**

1. **G, H, T primero** porque no dependen de nada, resuelven tres síntomas visibles para el socio y no tocan dinero. Dan confianza y despejan ruido.
2. **A antes que todo lo financiero** porque el cuadre por trabajador necesita que el trabajador pueda *ser* responsable. Construir D sobre la atribución actual significaría rehacerlo.
3. **B junto a A** porque es su cara visible: sin el cambio de UI, A es invisible para el usuario.
4. **D antes que E** porque el arrastre necesita un documento donde vivir.
5. **C+F al final** porque es el paquete con más superficie de cambio y depende de dos decisiones abiertas.
6. **S en paralelo**, pero S-3 (backend) **fuera** del plan.

> **Regla de ejecución:** al cerrar **cada** paquete —no cada fase— se ejecutan los seis comandos de prueba, `tsc --noEmit`, `tsc --noEmit -p tests` y `npm run build`. **Ninguna expectativa existente se modifica para hacer pasar código nuevo.**

---

## 39. Tests necesarios para la implementación

Todos siguen el estilo vigente (`spec()` / `check()` / `metric()` / `assert()`) y el patrón de base inyectable.

### Para el Paquete A — atribución
| Id propuesto | Qué prueba |
|---|---|
| ATRIB-SUP-01 | Un supervisor puede ser `requested` y el pago se le atribuye. |
| ATRIB-SUP-02 | Con cobrador activo, el supervisor **no** se autoasigna por defecto (salvo que D-1 diga lo contrario). |
| ATRIB-SUP-03 | Un secretario/socio **sigue sin poder** ser responsable de efectivo. |
| ATRIB-SUP-04 | Simetría: un supervisor que desembolsa **sí** ve el descuento en su caja. |
| ATRIB-SUP-05 | Simetría: un gasto de supervisor **sí** se carga a su caja. |
| ATRIB-SUP-06 | `hasPersonalCashbox()` es el **único** predicado: prueba de contrato que verifica que no queda ningún `rol === 'cobrador'` suelto en las tres reglas. |
| ATRIB-SUP-07 | Reversión y corrección escriben `createdByUserId`. |

### Para el Paquete D — cuadre por trabajador
| Id propuesto | Qué prueba |
|---|---|
| CUADRE-01 | El cuadre parte del **instante** del último cierre, no de medianoche. |
| CUADRE-02 | Cerrar sin diferencia deja `arrastreAnterior = 0` en el siguiente ciclo. |
| CUADRE-03 | Dos trabajadores en la misma ruta y periodo tienen cuadres **independientes**. |
| CUADRE-04 | Solapamiento de periodos del mismo trabajador **bloqueado**. |
| CUADRE-05 | Reabrir conserva el documento y crea versión N+1 (paridad con `SMOKE-E5-5`). |
| CUADRE-06 | Movimientos anteriores al último cierre **no** vuelven a entrar. |
| CUADRE-07 | `getLastClosedSettlement` devuelve un instante ordenable con dos cierres el mismo día. |
| CUADRE-08 | La suma de los cuadres de trabajador + movimientos estructurales **cuadra** con el `WeeklySettlement` de la ruta. *(La prueba de coherencia más importante del paquete.)* |
| CUADRE-09 | Cerrar el cuadre **no borra ni modifica** ningún movimiento. |

### Para el Paquete E — faltantes y sobrantes
| Id propuesto | Qué prueba |
|---|---|
| FALT-01 | Faltante de $100.000 sobrevive al cierre y aparece como `arrastreAnterior` negativo. |
| FALT-02 | El faltante se compensa al entregarse de más en un ciclo posterior. |
| FALT-03 | `diferencia ≠ 0` sin motivo → rechazo. |
| FALT-04 | Sobrante según D-3. |
| FALT-05 | Reabrir un cuadre con arrastre **no duplica** el dinero en el siguiente. *(Riesgo alto §34.)* |

### Para los Paquetes G y H — scoping
| Id propuesto | Qué prueba |
|---|---|
| SCOPE-HIST-01 | El histórico de abonos solo muestra clientes de la **ruta activa**. |
| SCOPE-HIST-02 | Un pago revertido **no** aparece como fila independiente. |
| SCOPE-BADGE-01 | El badge del Secretario cuenta **exactamente** lo que muestra su lista. |
| SCOPE-BADGE-02 | El badge del Admin **no** cuenta rutas no autorizadas *(bug vigente)*. |
| SCOPE-CONTRACT-01 | Contrato de fuente: ninguna pantalla operativa con acceso a datos usa `getAuthorizedRouteIds` sin `activeRouteId`, salvo la de selección. |

### Para el Paquete C+F — servicios
| Id propuesto | Qué prueba |
|---|---|
| SERV-TRANS-01 | Transferencia + movimiento de Caja socios son **atómicos**. |
| SERV-RET-01 | Un retiro por encima del saldo se **rechaza**. |
| SERV-CAP-01 | Los tres servicios validan permiso y Oficina **en el servicio**, no en la pantalla. |
| SERV-DESEMB-01 | Caja de ruta y caja personal usan **el mismo** criterio temporal de desembolso. |

### Pruebas de regresión obligatorias
Las **1008 existentes**, sin modificar ninguna expectativa. Especialmente:
`SMOKE-E5-1..6` (cierres), `RC-BUG-001..005` (garantías de pago), `ATRIB-*` (atribución actual), `CROSS-DEVICE-001..004` (honestidad arquitectónica) y las 55 de migración.

---

## 40. Veredicto final

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | **¿Supervisor hoy funciona realmente como Cobrador ampliado?** | **PARCIALMENTE.** En UI y navegación, **sí**: comparte literalmente las mismas pantallas (`SupervisorLayout = CollectorLayout`). En permisos, **sí**: mismas capacidades + `cashbox.viewRoute` + `report.export`. **Financieramente, NO**: no puede ser responsable de efectivo en ninguna de las tres reglas del sistema. |
| 2 | **¿Pago de Supervisor se atribuye al Supervisor?** | **NO**, salvo que la ruta no tenga ningún cobrador **activo**. Con el cobrador habitual activo, se atribuye a **él** (Caso B), y el Supervisor **no puede corregirlo** ni indicándose explícitamente: recibe `COLLECTOR_INVALID`. |
| 3 | **¿Pago de Supervisor entra al cuadre?** | **SÍ, pero a nombre de otro.** El cuadre es de la RUTA (`getCashboxSummary` suma todos los pagos del `routeId` sin mirar `collectorId`), así que el importe **sí** aparece. Lo que no aparece es **quién lo tenía**: `WeeklySettlement` no tiene campo de trabajador. |
| 4 | **¿Caja personal distingue correctamente Supervisor/Cobrador?** | **NO.** Técnicamente sí filtra por `collectorId`, pero como el Supervisor casi nunca lo es, su "Mi caja" marca **0** aunque tenga el dinero. Y su desembolso y su gasto no se descuentan de la caja de nadie (R-7). |
| 5 | **¿Base pertenece hoy a Route o trabajador?** | **A LA ROUTE, inequívocamente.** `Transfer` y `CapitalMovement` no tienen responsable de efectivo, y `CollectorCashDatabase` ni siquiera declara esas tablas (Caso D). |
| 6 | **¿Cuadre calcula desde último cuadre cerrado?** | **NO.** `cashboxEngine` no importa `weeklySettlements`; rango por defecto `'2000-01-01' → today()`. La pantalla propone lunes-sábado calendario. Un cierre **no cambia nada** en el cálculo posterior. |
| 7 | **¿Cuadre deja trabajador en cero?** | **NO.** El cuadre no tiene dimensión de trabajador. Lo que sí queda en cero es la caja personal — pero **por cambio de día**, no por cierre: es un informe diario, no un cierre de responsabilidad. |
| 8 | **¿Existe arrastre de faltantes?** | **NO.** No existe entidad, tabla, campo ni la palabra en todo `src/`. Un faltante no "desaparece al cerrar": **nunca llega a existir**. |
| 9 | **¿Existe manejo explícito de sobrantes?** | **NO.** Idéntico al faltante. Lo único relacionado es el tope al saldo en `registerPayment`, que **impide** el sobrepago de cliente — pero eso es otra cosa. |
| 10 | **¿Capital/Transferencias afectan correctamente Caja?** | **A LA CAJA DE RUTA, SÍ** — suman y restan correctamente. **A LA CAJA DEL TRABAJADOR, NO** — y no por un bug, sino por diseño: la superficie de datos de la caja personal no incluye esas tablas. Esto explica exactamente el síntoma del punto 13. |
| 11 | **¿Histórico del Cobrador respeta Route activa?** | **NO.** `CollectorPaymentHistoryPage:34` usa `getAuthorizedRouteIds(user)` y nunca importa `useActiveRoute`. Es la **única** pantalla operativa con acceso a datos que lo omite. Defecto aislado, de visualización, sin impacto financiero. |
| 12 | **¿Secretario tiene badge de autorizaciones?** | **NO.** `SecretarioLayout` no monta ningún contador. Y el contador del Admin no es reutilizable tal cual: `countPendingSaleRequests(tenantId)` **no recorta por rutas autorizadas** — un bug que ya afecta al Admin hoy. |
| 13 | **¿Hay sincronización real cross-device?** | **NO.** Sin backend, sin `fetch`, sin `WebSocket`. `syncService` solo cambia `syncStatus: 'pending' → 'synced'` en la **misma** IndexedDB. El propio repositorio lo prueba con `CROSS-DEVICE-001..004` y documenta el contrato pendiente. **En el mismo navegador, en cambio, todo se comparte instantáneamente** — aunque la vista no se refresque sola. |
| 14 | **¿Cuál es la causa raíz principal?** | **El sistema modela DÓNDE ocurre el dinero (`routeId`) pero no QUIÉN responde por él a lo largo del tiempo.** `Payment.collectorId` es el único vínculo persona↔efectivo, solo admite cobradores, y el documento que debería cerrar esa responsabilidad (`WeeklySettlement`) no lo mira. De ahí salen, en cascada: la atribución incorrecta del Supervisor, la ausencia de faltantes y sobrantes, la caja que se reinicia por calendario en vez de por cierre, y la Base que no pertenece a nadie. |
| 15 | **¿Qué modelo recomiendas implementar?** | **Tres planos separados** (capital de la empresa / efectivo en manos de una persona / deuda del cliente) y una **entidad nueva `CashSettlement`** con clave `routeId + userId + [desde, hasta]`, campos `esperado` / `entregado` / `diferencia` / `arrastreAnterior`, y el mismo versionado no destructivo que ya tiene `WeeklySettlement`. **No sustituye** al cierre de ruta: lo complementa. Detalle completo en §35. |

---

### Nota de cierre

Esta auditoría **no modificó una sola línea de código de producción**. El único archivo creado es este documento. La línea base sigue siendo **1008 PASS / 0 FAIL**, `tsc` limpio en `src` y en `tests`, y `npm run build` correcto.

El script forense usado para el §29 se ejecutó desde el directorio temporal de la sesión, **no se añadió al repositorio ni al suite de pruebas**, y su lógica está descrita con suficiente detalle en el §29 para reproducirla.

Las decisiones del §36 son el siguiente paso. El plan del §37 está construido para que la **Fase 0 pueda comenzar sin esperar a ninguna de ellas**.

---

# 41. Implementación Fase 0 + Fase 1

> **Estado de este documento.** Los §1–§40 describen el sistema **tal como estaba el
> 2026-09-22 antes de tocar nada**, y se conservan íntegros como evidencia. Esta
> sección registra qué de lo auditado ya está resuelto. Detalle completo en
> [`IMPLEMENTACION_SUPERVISOR_RESPONSABILIDAD_EFECTIVO_2026-09.md`](./IMPLEMENTACION_SUPERVISOR_RESPONSABILIDAD_EFECTIVO_2026-09.md).

**Baseline:** 1008 → **1051 PASS / 0 FAIL**. Sin migraciones (sigue en Dexie v13).
Ninguna expectativa anterior fue modificada.

## 41.1 Causas raíz cerradas

| # | Causa raíz | Estado |
|---|---|---|
| **R-1** | El Supervisor no podía ser responsable de efectivo | ✅ **RESUELTA** — puede, siempre de forma explícita |
| **R-7** | Atribución asimétrica (cobros / desembolsos / gastos) | ✅ **RESUELTA** — un solo predicado |
| **R-8** | `hasPersonalCashbox()` era código muerto contradictorio | ✅ **RESUELTA** — es la fuente única |
| **R-9** | "Mi caja" mezclaba efectivo personal y Base de ruta | ✅ **RESUELTA** — dos bloques separados |
| **R-10** | Tres idiomas de scoping en la capa operativa | ✅ **RESUELTA** — `activeRouteId` + contrato guardián |
| **R-11** | Histórico sin ruta activa, sin `effectivePayments` | ✅ **RESUELTA** |
| **R-12** | Badges sin recorte por rutas (afectaba al Admin) | ✅ **RESUELTA** |
| **R-13** | Secretario sin badge | ✅ **RESUELTA** |
| **R-15** | "Base" con cuatro significados; `capitalActual` muerto | ✅ **RESUELTA** — glosario único + `@deprecated` |
| **R-20** | `createdByUserId` inerte y ausente en correcciones | ✅ **RESUELTA** |
| **R-21** | Sin refresco entre pestañas | 🟡 **PARCIAL** — solo badges (`useLiveQuery`) |
| **R-22** | Indicador "Online" engañoso | ✅ **RESUELTA** — «En línea» + aviso explícito |
| **R-14** | "Transferencias recibidas" agrega naturalezas distintas | 🟡 **PARCIAL** — etiqueta neutra unificada; distinción socio→ruta vs ruta→ruta en Fase 2 |

## 41.2 Causas raíz pendientes (Fase 2)

| # | Causa raíz | Por qué sigue abierta |
|---|---|---|
| **R-2** | El cuadre no tiene dimensión de persona | Requiere `CashSettlement` |
| **R-3** | El motor de caja ignora los cierres | Requiere `lastClosedSettlementAt` como instante |
| **R-4** | No existen faltantes ni sobrantes | Requiere el documento de cuadre |
| **R-5** | La caja personal es diaria y no acumula | Depende de R-2 y R-3 |
| **R-6** | Base / capital / transferencias / retiros sin responsable | Decisión D-2 abierta |
| **R-16** | Sin backend no hay nada cross-device | D-10: fuera de alcance |
| **R-17** | Capital / transferencias / retiros se escriben desde el componente | No era necesario para esta fase |
| **R-18** | Préstamos por `fechaInicio` vs `fechaDesembolso` | Se aborda junto a los servicios (R-17) |
| **R-19** | Retiro sin validación de fondos | ídem |

## 41.3 Casos forenses que cambiaron de resultado

| Caso | Antes (§29) | Ahora |
|---|---|---|
| **B** — Laura cobra, Juan ACTIVO | `collectorId = u-juan`; Laura no podía corregirlo (`COLLECTOR_INVALID`) | Laura elige `Yo — Laura` → `collectorId = u-laura`. Sin elegir → `COLLECTOR_REQUIRED` |
| **C** — Juan inhabilitado | Funcionaba por accidente (`legacy-actor`); con 2 cobradores se rechazaba | **Ya no hace falta inhabilitar a nadie**: la elección es explícita y estable |
| **D** — La ruta recibe Base | Base de la Ruta, de nadie más | **Sin cambios** (D-2 lo mantiene deliberadamente) |
| **E/F/G** — Cuadre | No ejecutables | **Sin cambios**: siguen necesitando `CashSettlement` |
| **H** — Capital → Retiro | El retiro no toca la caja del trabajador | **Sin cambios** |

## 41.4 Preguntas críticas revisadas

| Pregunta | Respuesta entonces | Respuesta ahora |
|---|---|---|
| **1** — ¿De quién es el efectivo de Laura? | **AMBIGUO** | **DE QUIEN SE DECLARE**, explícitamente y sin adivinar |
| **2** — ¿A quién pertenece la Base? | **A la Route** | **A la Route** (sin cambio, por decisión D-2) |
| **3** — ¿El motor de caja conoce el cierre? | **NO** | **NO** (Fase 2) |
| **4** — ¿Hay sitio para un faltante? | **NO** | **NO** (Fase 2) |

---

**AUDITORÍA COMPLETA — LISTO PARA DEFINIR IMPLEMENTACIÓN**

**FASE 0 + FASE 1 IMPLEMENTADAS (2026-09-22) — PENDIENTE EL CUADRE POR TRABAJADOR**
