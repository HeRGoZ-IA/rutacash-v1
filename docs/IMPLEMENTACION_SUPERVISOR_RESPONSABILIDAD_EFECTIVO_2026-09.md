# RUTACASH — IMPLEMENTACIÓN FASE 0 + FASE 1
## Scoping operativo · Badges · Glosario · Supervisor como sujeto financiero

**Fecha:** 2026-09-22
**Origen:** `docs/AUDITORIA_CUADRE_CAJA_SUPERVISOR_2026-09.md`
**Baseline antes:** 1008 PASS / 0 FAIL · **Después:** 1051 PASS / 0 FAIL
**Migraciones de esquema:** ninguna (sigue en Dexie v13)

> **⚠ ACTUALIZACIÓN 2026-09-24 — CAMBIO DE REGLA APROBADO POR NEGOCIO.**
> La regla `must-choose` descrita en §2 y §4 **quedó sustituida**: el Supervisor que
> registra un pago es SIEMPRE el responsable del efectivo, sin selector. Ver §13 al
> final. El resto del documento se conserva como registro de la Fase 1.

---

## 1. Qué resuelve esta entrega

La auditoría concluyó que RutaCash modela correctamente **dónde** ocurre el dinero
(`routeId`) pero no **quién responde por él**. Esta entrega ataca la mitad
*atribución* del problema y deja preparado el terreno para el cuadre por trabajador:

| Antes | Ahora |
|---|---|
| El Supervisor no podía ser responsable de efectivo **ni indicándose a sí mismo** | Puede, siempre de forma **explícita** |
| Cobros, desembolsos y gastos usaban **tres reglas distintas** | Los tres usan **un único predicado** |
| Para que el Supervisor se quedara el dinero había que **inhabilitar al Cobrador** | No hace falta: basta con elegirlo en pantalla |
| "Mi caja" mezclaba efectivo personal y Base de la ruta | Dos bloques separados y advertidos |
| El histórico de abonos mostraba clientes de **todas** las rutas | Solo de la **ruta activa** |
| El badge del Admin contaba **toda la empresa** | Cuenta **sus rutas**; badge = lista |
| El Secretario **no tenía badge** | Lo tiene, con alcance correcto |
| `createdByUserId` era un dato **inerte** | Se escribe siempre y es la base de la trazabilidad |

**Lo que NO se tocó:** `WeeklySettlement`, el cuadre de ruta, el motor de parcelas,
el tope al saldo, la atomicidad, la corrección no destructiva y el scoping
fail-closed. Sin migraciones y sin `CashSettlement`.

---

## 2. Responsable del efectivo: el predicado único

### `hasPersonalCashbox(rol)` — de código muerto a fuente única

La auditoría (§4.3) encontró que este predicado existía, declaraba que el Supervisor
**sí** tiene caja personal… y **no se usaba en ningún archivo de `src/`**. Mientras
tanto, tres lugares distintos decidían lo mismo por su cuenta y decían lo contrario.

```
ANTES                                          AHORA
─────────────────────────────────────────────  ───────────────────────────────────
cobros      resolveResponsibleCollector:       cobros      hasPersonalCashbox(u.rol)
            c.rol === 'cobrador'
desembolsos actor?.rol === 'cobrador'          desembolsos hasPersonalCashbox(actor.rol)
gastos      user.rol === 'cobrador'            gastos      hasPersonalCashbox(user.rol)
```

| Rol | ¿Caja personal? |
|---|---|
| `cobrador` | ✅ |
| `supervisor` | ✅ |
| `admin`, `superadmin` | ❌ administran dinero, no lo cargan encima |
| `secretario`, `socio` | ❌ no operan caja |

Archivo: [`src/lib/collectorAttribution.ts`](../src/lib/collectorAttribution.ts).
Guardián: `SUPERVISOR-UI-005` falla si vuelve a aparecer un `rol === 'cobrador'`
suelto en cualquiera de los tres flujos.

### La regla de atribución

```
1. requested  → debe ser responsable VÁLIDO: usuario ACTIVO con caja personal
                asignado a la ruta, o el propio actor si tiene caja personal.
                Cualquier otro (Admin, Secretario, usuario de otra ruta, inactivo)
                se rechaza con COLLECTOR_INVALID.
2. actor es COBRADOR                        → responde él        [source: 'actor']
3. actor con caja personal, NO cobrador,
   y la ruta TIENE cobradores activos       → 'must-choose'      ← REGLA NUEVA
4. exactamente 1 cobrador activo            → se preselecciona   [single-route-collector]
5. varios cobradores activos                → 'ambiguous'
6. ningún cobrador activo                   → el actor           [legacy-actor]
```

**El paso 3 es el corazón de la entrega.** Cuando el Supervisor opera una ruta que ya
tiene cobradores hay **dos destinos plausibles** y ninguno es adivinable: ni se lo
queda él por ser quien digita, ni se lo lleva el cobrador por ser el habitual. Se
exige decidir.

`must-choose` y `ambiguous` comparten el código de rechazo `COLLECTOR_REQUIRED`
—para la UI es el mismo hecho— pero **mensajes distintos**, porque las opciones que
se ofrecen no son las mismas:

- `ambiguous` → «Esta ruta tiene varios cobradores: indica quién recibió el dinero.»
- `must-choose` → «Indica quién recibió el dinero: **tú** o el cobrador de la ruta.»

---

## 3. Autor vs. responsable

Dos campos, dos preguntas distintas. Ninguno se renombró: `collectorId` conserva el
nombre por historia y para **no forzar una migración de esquema sin ganancia
funcional**, pero su semántica quedó documentada en el modelo.

| Campo | Significa | Quién lo escribe |
|---|---|---|
| `Payment.collectorId` | **Responsable del efectivo**: quien lo recibió y responde por él. Hoy `cobrador` ∪ `supervisor`. | `resolveResponsibleCollector` |
| `Payment.createdByUserId` | **Autor**: quien digitó la operación. | Siempre `actor.id` |

Lo mismo, en paralelo, para las otras dos patas de la caja personal:

| Movimiento | Autor | Responsable del efectivo |
|---|---|---|
| Pago | `createdByUserId` | `collectorId` |
| Desembolso | `disbursedByUserId` | `disbursedByCollectorId` |
| Gasto | `userId` | `collectorId` |

### Corrección de pagos

`executeCorrection` no escribía `createdByUserId` en la reversión ni en el pago
corregido: quedaban en `undefined`, que por la regla legacy equivale a `collectorId`,
y se perdía la traza de que los había generado otra persona. Corregido:

- El **responsable** se hereda intacto del pago original — el dinero **nunca** se
  reatribuye a quien corrige.
- El **autor** de ambos asientos pasa a ser el corrector.

Guardián: `PAYMENT-AUTHOR-003` exige las dos cosas y falla si aparece
`collectorId: actor.id`.

---

## 4. El Supervisor en pantalla

### Selector de responsable (`CollectorPicker`)

| Actor | Comportamiento |
|---|---|
| Cobrador | No se muestra. Responde él, sin fricción. |
| **Supervisor** | **Se exige elegir** entre `Yo — {nombre}` y los cobradores de la ruta. **Sin preselección.** |
| Admin, 1 cobrador | Se informa, no se pregunta. |
| Admin, varios cobradores | Se exige elegir. |
| Admin, sin cobradores | No se muestra: lo atribuye el servicio (legacy). |

La preselección automática del cobrador único se desactiva cuando el actor **también**
puede responder: con dos destinos posibles, preseleccionar uno es adivinar.

### "Mi efectivo" vs "Caja de la Ruta"

La pantalla se llamaba **"Mi caja"** y mostraba, justo bajo el total personal, la
"Base actual" de la ruta: dos cifras de naturaleza opuesta bajo un título posesivo.

```
┌─ Mi efectivo ──────────────────────────── dinero bajo TU responsabilidad
│    + Recaudado por ti
│    − Desembolsado por ti
│    − Tus gastos
│    = Efectivo a entregar
├─────────────────────────────────────────  ← separador visual explícito
└─ Caja de la Ruta ──────────────────────── solo con `cashbox.viewRoute`
     ⚠ "Este dinero no forma parte de tu efectivo"
     · Base de la ruta      · Cartera activa
```

El bloque de ruta es **fail-closed**: sin la capacidad, `getRouteFinancialSummary`
**ni se llama**. Ocultar la tarjeta no bastaría; el dato no se pide.

### Tarjeta de ruta: Base para el Supervisor, nunca para el Cobrador

La tarjeta la comparten ambos perfiles, así que la Base va tras la guarda real:

```ts
const verBase = can(user, 'cashbox.viewRoute', { routeId: route.id, tenantId })
base: verBase ? await getRouteAvailableCapital(route.id) : undefined
```

- **Cobrador** → `base === undefined`: tarjeta idéntica a la de siempre
  (Clientes · Ventas · **Cartera**). No se le concedió ninguna capacidad nueva.
- **Supervisor** → la Base ocupa el tercer indicador y la **Cartera sigue visible**
  en una fila debajo. No se perdió funcionalidad: se repriorizó.

### Supervisión temporal sin inhabilitar a nadie

Antes, la ÚNICA forma de que el Supervisor se quedara el efectivo era inhabilitar al
cobrador habitual, y funcionaba por la rama de respaldo `legacy-actor` —un accidente,
no un diseño (auditoría §29 CASO C). Ahora **Juan puede seguir activo**: Laura entra,
cobra, elige `Yo — Laura` y el dinero es suyo. Verificado en SMOKE F03.

---

## 5. Alcance operativo: un solo idioma

La capa operativa convivía con **tres** formas de resolver rutas. Ahora la regla es
`activeRouteId`, con excepciones documentadas y vigiladas.

| Pantalla | Antes | Ahora |
|---|---|---|
| `CollectorPaymentHistoryPage` | `getAuthorizedRouteIds` (todas) | `activeRouteId` |
| `CollectorSyncPage` | `user.routeId` (legacy) | `activeRouteId` |

En el histórico se corrigieron además dos defectos secundarios:

1. `db.sales.where('clientId')` traía **todas** las ventas del cliente sin filtrar por
   ruta. Ahora se filtran; y un `saleId` recibido por URL **no amplía el alcance**.
2. No aplicaba `effectivePayments()`: un pago corregido aparecía **tres veces**
   (original, reversión negativa y corrección). Ahora solo se listan los vigentes. La
   trazabilidad completa sigue en Auditoría y en la pantalla de corrección de pagos.

### Excepciones legítimas (contrato `SCOPE-HIST-005`)

| Pantalla | Por qué |
|---|---|
| `CollectorSelectRoutePage` | Su propósito **es** elegir ruta: debe verlas todas. |
| `CollectorNewClientPage` | Crea una entidad **eligiendo** ruta; usa la activa por defecto. |
| `CollectorNewSalePage` | Igual. |

El guardián recorre `src/pages/collector/*.tsx`, salta esas tres y falla si cualquier
otra pantalla resuelve rutas sin consultar `activeRouteId`. No es un grep ingenuo: las
excepciones son explícitas y el resto se comprueba de verdad.

---

## 6. Badges: el globo vale lo que la lista

`countPendingSaleRequests(tenantId)` contaba **toda la empresa**. Un Administrador
autorizado en 2 de 5 rutas veía "5" y al abrir la lista encontraba 2. Era un bug
vigente del Admin, no solo un impedimento para el Secretario.

**Contadores nuevos, con la misma regla de acceso que la pantalla:**

| Función | Capacidad que aplica |
|---|---|
| `countPendingSaleRequestsForUser(user, tenantId)` | `authorization.access` |
| `countPendingAdjustmentRequestsForUser(user, tenantId)` | `payment.approveAdjustment` |

Los antiguos quedan `@deprecated` para usos donde el total de empresa **sí** es lo que
se quiere medir.

**Secretario:** badge de autorizaciones en `SecretarioLayout`. **No** cuenta ajustes de
pago: los *origina*, no los aprueba (no tiene `payment.approveAdjustment`), así que un
globo ahí le pediría una acción imposible. El contador devuelve 0 por la propia regla
de permisos, sin excepciones escritas a mano.

**Reactividad (mismo dispositivo):** [`usePendingBadges`](../src/hooks/usePendingBadges.ts)
usa `useLiveQuery` de Dexie, que ya era dependencia declarada y no se usaba. Si un
Cobrador envía una solicitud en otra pestaña del **mismo navegador**, el globo sube sin
navegar. Es *fail-soft* a propósito: si la consulta falla, el contador vale 0 y la
navegación sigue viva — un globo jamás debe tumbar el menú de toda la aplicación.

> **Límite honesto:** esto solo funciona dentro de una misma IndexedDB. Entre
> dispositivos distintos no llega nada, y eso no lo arregla un hook.

`liveQuery` se aplicó **solo** a los badges: es la superficie más pequeña y sin lógica
financiera. "Mi efectivo" y el histórico conservan su carga por `useEffect` —se
recargan al navegar— porque convertirlos exigiría un refactor mayor sin cobertura de
render en este repositorio. Queda anotado para un paquete posterior.

---

## 7. Glosario financiero

Definiciones únicas. **"Base" y "caja personal" no son sinónimos y nunca deben mezclarse.**

| Término | Definición | Fuente en código |
|---|---|---|
| **BASE** | Efectivo estructural disponible de la **Ruta**. Pertenece a la ruta, no a una persona. | `getRouteAvailableCapital(routeId)` = `getCashboxSummary().saldoActual` |
| **BASE ACTUAL** | Sinónimo de Base en pantalla. *Preferir "Base de la ruta".* | ídem |
| **CAJA DE LA ROUTE** | Estado financiero completo de la ruta: capital, cobros, préstamos, gastos, transferencias, retiros. | `getCashboxSummary(routeId, desde, hasta)` |
| **MI EFECTIVO** | Dinero físicamente bajo responsabilidad de **una persona**. No incluye Base, capital, transferencias ni retiros. | `getCollectorDailyCashSummary({routeId, collectorId, fecha})` |
| **EFECTIVO A ENTREGAR** | `recaudado − desembolsado − gastos` de esa persona. Resultado personal, **no** caja de ruta. | `CollectorCashSummary.efectivoAEntregar` |
| **CARTERA** | Saldo pendiente de clientes en ventas activas **ya desembolsadas** (capital + interés). | `RouteFinancialSummary.carteraEnCalle` |
| **TOTAL CONTROLADO** | `baseActual + carteraEnCalle`. Valor total que administra la ruta: lo que tiene en caja más lo que tiene en la calle. | `RouteFinancialSummary.totalControlado` |

### `Route.capitalActual` — deprecado

Se fija al **crear** la ruta (= `capitalInicial`) y **nunca se recalcula**: no lo
actualiza ningún cobro, gasto, transferencia ni retiro. Leerlo como "capital
disponible" da una cifra falsa.

Se marcó `@deprecated` en vez de eliminarlo: `routeService.createRoute` lo escribe y
existen rutas persistidas con él, así que borrarlo exigiría una migración de esquema
sin ninguna ganancia funcional. **No añadir lecturas nuevas.** La fuente real de la
Base es el motor financiero.

### Terminología de transferencias

Etiqueta unificada y **neutra** en toda la app: **"Transferencias entrantes"** /
**"Transferencias salientes"**. Antes convivían tres variantes ("recibidas",
"entrada", "entrantes").

**No se renombró a "BASE RECIBIDA"** (decisión D-6). El total agrega naturalezas
distintas:

| Caso | ¿Es Base recibida? |
|---|---|
| Socio → Ruta | ✅ Sí: inyección de capital operativo |
| Ruta A → Ruta B | ❌ No: **traslado interno** — lo que B gana, A lo pierde |

Llamar "Base recibida" a un traslado entre rutas haría el informe **menos** exacto.
Distinguirlas exige modelado nuevo; queda para Fase 2.

---

## 8. Sincronización

Sin cambios de arquitectura. Sigue declarándose lo que es:

| Escenario | Estado |
|---|---|
| **A — mismo navegador** | ✅ Todo se comparte (misma IndexedDB). Los badges ahora además se refrescan solos. |
| **B — dispositivos distintos** | ❌ **NO soportado.** Sin backend. |

`syncPendingItems()` solo marca registros locales como enviados dentro de la **misma**
base. La pantalla de sincronización dejó de insinuar lo contrario:

- «Conectado» → **«En línea»**
- «Sincronizar ahora» → **«Confirmar pendientes»**
- «X item(s) sincronizados» → «X registro(s) confirmado(s) **en este dispositivo**»
- Aviso visible: **«Estar en línea no significa sincronizado.»**

Las pruebas `CROSS-DEVICE-001..004` siguen exigiendo que no aparezca ninguna
sincronización simulada.

---

## 9. Archivos tocados

### Lógica de dominio
| Archivo | Cambio |
|---|---|
| `src/lib/collectorAttribution.ts` | `hasPersonalCashbox` como fuente única; `isEligibleCashHolder`; error `must-choose`; regla ampliada |
| `src/services/paymentService.ts` | Candidatos por `hasPersonalCashbox`; mapeo del rechazo; documentación |
| `src/services/saleRequestService.ts` | `confirmDisbursement` simétrico; `countPendingSaleRequestsForUser` |
| `src/services/paymentCorrectionService.ts` | `createdByUserId` en reversión y corrección; `countPendingAdjustmentRequestsForUser` |
| `src/models/types.ts` | `collectorId` documentado; `capitalActual` deprecado |

### Interfaz
| Archivo | Cambio |
|---|---|
| `src/components/ui/CollectorPicker.tsx` | Opción `Yo — {nombre}`; sin preselección cuando el actor compite |
| `src/pages/collector/CollectorCashClosePage.tsx` | "Mi efectivo" / "Caja de la Ruta" separados y advertidos |
| `src/pages/collector/CollectorSelectRoutePage.tsx` | Base con guarda; Cartera conservada |
| `src/pages/collector/CollectorPaymentHistoryPage.tsx` | Ruta activa; ventas filtradas; `effectivePayments` |
| `src/pages/collector/CollectorSyncPage.tsx` | Ruta activa; copy honesto sobre sincronización |
| `src/pages/collector/CollectorExpensesPage.tsx` | Gasto con `hasPersonalCashbox` |
| `src/pages/collector/CollectorHomePage.tsx` | "Mi caja" → "Mi efectivo" |
| `src/components/layout/AdminLayout.tsx` | Badges con alcance y reactivos |
| `src/components/layout/SecretarioLayout.tsx` | Badge nuevo |
| `src/pages/admin/WeeklySettlementPage.tsx` | Etiquetas de transferencias |
| `src/pages/admin/CashboxPage.tsx` | Etiquetas de transferencias |
| `src/hooks/usePendingBadges.ts` | **NUEVO** — contadores reactivos con alcance |

---

## 10. Pruebas

**1008 → 1051 PASS / 0 FAIL.** Ninguna expectativa anterior se modificó.

| Familia | Casos | Qué fija |
|---|---|---|
| `ATTRIB-SUP-001..008` | 8 | El Supervisor responde por el efectivo, pero solo si lo declara |
| `CASH-SUP-001..005` | 5 | Cobros, desembolsos y gastos caen en la caja correcta |
| `PAYMENT-AUTHOR-001..003` | 3 | Autor ≠ responsable, también al corregir |
| `SUPERVISOR-UI-001..005` | 5 | Base visible/privada, bloques separados, predicado único |
| `SCOPE-HIST-001..005` | 5 | Ruta activa, pagos vigentes, contrato de alcance |
| `SCOPE-BADGE-001..003` | 3 | Badge = lista, para Admin y Secretario |
| `ATRIB-SUP` (permisos, puro) | 14 | La regla de atribución al nivel más bajo |

Dos guardianes merecen mención porque protegen el **diseño**, no solo el resultado:

- **`SUPERVISOR-UI-005`** falla si vuelve a aparecer un `rol === 'cobrador'` suelto en
  cobros, desembolsos o gastos. La asimetría no puede reintroducirse en silencio.
- **`SCOPE-HIST-005`** recorre las pantallas operativas y falla si alguna resuelve
  rutas ignorando la ruta activa, salvo las tres excepciones documentadas.

### Smoke F01–F08

Ejecutados de extremo a extremo contra **Dexie real** (`fake-indexeddb`) con los
servicios de producción. Script temporal, **no añadido al repositorio**.

| Smoke | Resultado |
|---|---|
| F01 Histórico multi-ruta | ✅ 2 clientes de Norte; ninguno de Sur |
| F02 Badge Secretario | ✅ badge 2 = lista 2 (había 5 en la empresa); ajustes 0; Admin ve 5 |
| F03 Supervisor cobra, Juan **activo** | ✅ Laura +300.000 · Juan 0 |
| F04 Supervisor registra para el Cobrador | ✅ Juan +300.000 · Laura 0 · autor ≠ responsable · sin elegir → `COLLECTOR_REQUIRED` |
| F05 Desembolso del Supervisor | ✅ −200.000 de su caja (300.000 → 100.000) |
| F06 Gasto del Supervisor | ✅ −50.000 de su caja (100.000 → 50.000) |
| F07 Cobrador normal | ✅ sin fricción nueva, `source: 'actor'` |
| F08 Base privada | ✅ Cobrador NO la ve · Supervisor SÍ · no entra en "Mi efectivo" |

---

## 11. Decisiones preservadas para Fase 2

Nada de lo siguiente se implementó, y el diseño actual **no lo bloquea**:

| Pendiente | Decisión ya orientada |
|---|---|
| `CashSettlement` (cuadre por trabajador) | Clave `routeId + userId + [desde, hasta]` |
| Esperado / entregado / diferencia | El campo "entregado" no existe hoy |
| **Faltantes** | Se arrastran; no bloquean; se alertan a Admin (D-4) |
| **Sobrantes** | Diferencia positiva con motivo obligatorio; sin saldo a favor automático (D-3) |
| Arrastre entre ciclos | `arrastreAnterior(N+1) = diferencia(N)` |
| Cierre desde el último cuadre | `lastClosedSettlementAt` como **instante**, no fecha (D-7) |
| Quién cierra | El trabajador **no** se autoliquida: confirma otro actor (D-5, D-8) |
| Base asignada físicamente a un trabajador | D-2: la Base estructural sigue siendo de la Ruta |
| Inhabilitar trabajador | No se traspasa su dinero automáticamente (D-9) |
| `transferService` / `capitalService` / `withdrawalService` | Siguen escribiendo desde el componente |
| Backend y cross-device | D-10: fuera de alcance |

### Lo que esta entrega deja preparado

1. **El responsable del efectivo ya puede ser un Supervisor**, así que el cuadre por
   trabajador tendrá sobre qué agregar.
2. **Un solo predicado** decide quién tiene caja personal: `CashSettlement` preguntará
   ahí mismo, sin reabrir el debate.
3. **`createdByUserId` dejó de ser inerte**: la auditoría del cuadre podrá distinguir
   quién registró de quién respondía.
4. **"Mi efectivo" está conceptualmente aislado** de la caja de ruta, que es la
   separación que el cuadre por trabajador necesita para no mezclar planos.

---

## 12. Riesgo conocido y no resuelto

**Datos históricos.** Los pagos, desembolsos y gastos anteriores a esta entrega
conservan la atribución que tenían: si un Supervisor cobró en el pasado, ese dinero
sigue figurando a nombre del cobrador habitual. **No se reescribió el histórico** — un
recálculo masivo inventaría hechos que nadie puede verificar hoy. Cuando exista
`CashSettlement`, el primer cuadre de cada trabajador debe arrancar con
`arrastreAnterior = 0` y una marca de inicio de modelo, igual que hizo la migración
v12 con `createdByUserId`.


---

## 13. Cambio de regla aprobado por negocio (2026-09-24)

### «Supervisor que registra pago = Supervisor responsable.»

| | Regla anterior (Fase 1, §2) | Regla definitiva |
|---|---|---|
| Cobrador registra | responde él | responde él (sin cambio) |
| **Supervisor registra, ruta con cobradores** | `must-choose`: elegir entre "Yo" y el Cobrador | **responde el Supervisor**, automático |
| Supervisor registra, ruta sin cobradores | responde él (`legacy-actor`) | responde él (`actor`) |
| Cobrador/Supervisor envía otro responsable | aceptado si era elegible | **rechazado** (`actor-owns-cash` → `COLLECTOR_INVALID`) |
| Admin / Super Admin | 1 cobrador → preselección · varios → elegir · ninguno → legacy | **sin cambio**; nunca adquieren caja personal |

`resolveResponsibleCollector` ([collectorAttribution.ts](../src/lib/collectorAttribution.ts)):
el paso 1 es ahora *"el actor tiene caja personal → responde él"*. No consulta a los
cobradores de la ruta, ni cuántos hay, ni si están activos. `must-choose` desapareció
del tipo de error.

`CollectorPicker`: devuelve `null` para cualquier rol con caja personal (Cobrador y
Supervisor). Se eliminó la opción `Yo — {nombre}`. El selector solo existe para
actores administrativos.

Desembolsos (`disbursedByCollectorId = supervisor.id`) y gastos
(`collectorId = supervisor.id`) ya seguían esta regla desde la Fase 1: sin cambios.

**Autor vs responsable** se conserva: para un pago del propio Supervisor coinciden;
siguen divergiendo en correcciones (el corrector es autor, el responsable se hereda)
y cuando un Admin registra el cobro de un Cobrador.

### Tests sustituidos por la nueva regla

Solo se tocaron los tests cuya expectativa **era la regla anterior**. Cada uno quedó
anotado en el código con `[SUSTITUIDO 2026-09-24]` o `[MODIFICADO 2026-09-24]`.

| Test | Regla anterior que fijaba | Cambio |
|---|---|---|
| `permissions` · "ATRIB — el dinero se atribuye al cobrador indicado, no a quien digita" | Supervisor carga el cobro a A | Mismo propósito (autor ≠ responsable) con actor **Admin** |
| `permissions` · "ATRIB-SUP — el Supervisor puede indicarse a sí mismo" | `source: 'explicit'` | `source: 'actor'` |
| `permissions` · "ATRIB-SUP — con un cobrador… debe ELEGIR" + "…no se autoasigna por ser el actor" | `must-choose` | Sustituidos por 4 checks `SUP-RESP` (1 y 2 cobradores → Supervisor; Supervisor y Cobrador no pueden desviar) |
| `permissions` · "ATRIB-SUP — sin cobradores… el Supervisor responde" | `source: 'legacy-actor'` | `source: 'actor'` |
| `payments` · `COLL-ATTR-001` | Supervisor registra el cobro de A | Actor **Admin** (misma intención) |
| `payments` · `PAY-COLL-REG-008` | Sin responsable → `COLLECTOR_REQUIRED`; con A → dinero de A | Supervisor responde automáticamente; desviar a A → `COLLECTOR_INVALID` |
| `payments` · `ATTRIB-SUP-002` | Supervisor no se queda el dinero por registrarlo | Supervisor queda responsable sin elegir |
| `payments` · `ATTRIB-SUP-003` | Supervisor puede atribuir al Cobrador | Supervisor **no** puede atribuir al Cobrador |
| `payments` · `CASH-SUP-004` | Pago atribuido a Juan no cae en la caja del Supervisor | Pago del Supervisor no cae en la caja de Juan |
| `payments` · `PAYMENT-AUTHOR-001/002` | Supervisor digita para Juan | Actor **Admin** (autor ≠ responsable sigue probado) |
| `payments` · `SUPERVISOR-UI-004` | Selector con "Yo — {nombre}" sin preselección | El selector no se muestra a roles con caja personal |

Cambios de **ruta de archivo, no de expectativa** (el código se movió):

| Test | Motivo |
|---|---|
| `bootstrap` · `ROUTE-FREE-007` | El aviso "ruta sin Cobrador" vive ahora en `adminDashboardService.ts` (extraído de `DashboardPage` para probarlo con Dexie real). Misma aserción. |
| `migrations` · `VERSION_ACTUAL` 13 → 14 | Constante centralizada precisamente para esto; nueva migración v14. |

Ninguna otra expectativa se modificó.
