# RutaCash — Implementación de Oficinas

Documento **interno** de desarrollo. No se comparte fuera del equipo.

---

## 1. Objetivo

Introducir la entidad **Oficina** para que la operación real se refleje en el
modelo: una empresa opera a través de varias oficinas (Leticia, Río…), y cada
oficina agrupa varias rutas.

La Oficina **organiza**. La Ruta **sigue controlando el acceso**. Ese es el único
principio del que dependen todas las decisiones de este paquete.

---

## 2. Arquitectura final

```
Tenant (empresa)
├── Office ──(1:N)── Route ──> clientes, ventas, pagos, gastos, caja…
│                              (todos derivan la Oficina por su routeId)
├── Office ──(1:N)── Route
├── (Sin Oficina) ──── Route          ← estado válido y permanente
└── Users (generales de la empresa) ── authorizedRouteIds[] ──> Route
```

Una ruta pertenece **como máximo a una** Oficina y puede moverse entre ellas.
Una Oficina puede existir sin rutas; una ruta puede existir sin Oficina.

---

## 3. Usuarios generales

Los usuarios **no pertenecen a una Oficina**. No existe `User.officeId` ni
`User.officeIds`, no se duplican usuarios por oficina y no hay ningún permiso por
oficina que conceda acceso a datos.

Un mismo usuario puede trabajar en rutas de oficinas distintas:

```
Cobrador Fabio
├── Oficina Leticia / Ruta Centro
└── Oficina Río     / Ruta Puerto
```

Y —esto es lo importante— tener la Ruta Centro **no** le da las demás rutas de
Leticia. El acceso sigue naciendo exclusivamente de `authorizedRouteIds`.

---

## 4. Modelo Office

```ts
interface Office {
  id: string
  tenantId: string
  nombre: string            // obligatorio, único en la empresa (sin distinguir mayúsculas)
  codigo?: string           // opcional, único en la empresa si se usa
  status: 'activa' | 'inactiva'
  createdAt: string
  updatedAt: string
}
```

`Route` gana `officeId?: string`. Es el **único** lugar del modelo donde vive la
Oficina.

**Índice Dexie:** `offices: 'id, tenantId, status'`. `Route.officeId`
deliberadamente **no** se indexa: Dexie no indexa valores `undefined`, así que una
consulta `where('officeId')` dejaría invisibles las rutas "Sin Oficina" —
justamente el caso que el modelo vuelve normal. Las rutas se siguen cargando por
`tenantId` y agrupando en memoria, que además impide escribir consultas por oficina
capaces de saltarse el scoping.

**Unicidad:** por empresa, no global. Dos empresas distintas pueden tener cada una
su "Oficina Centro".

---

## 5. Rutas Sin Oficina

"Sin Oficina" no es un estado transitorio ni un error: es válido y permanente.

- Las rutas que ya existían **quedan todas Sin Oficina**. No se inventó ninguna
  Oficina para rescatarlas.
- Crear una ruta **no exige** Oficina (ni Administrador, ni Cobrador). Si falta, se
  muestra una advertencia ámbar —*"Esta ruta se creará sin Oficina asignada. Podrás
  asignarla posteriormente."*— y el botón Crear **sigue habilitado**.
- Las rutas Sin Oficina aparecen agrupadas aparte en listados, selectores de
  usuarios, App Cobrador, reportes y liquidación. Nunca se ocultan.
- Una ruta Sin Oficina opera con total normalidad: no hay Oficina que pueda
  inactivarla.

---

## 6. Saneamiento legacy

Este fue el bloque previo e innegociable, y la mitad del trabajo real.

RutaCash **ya tuvo Oficinas** y las eliminó en la versión 3 del esquema, pero dejó
restos vivos: `officeId` seguía declarado en **nueve** interfaces y, peor,
**catorce puntos del código seguían copiándolo** a cada registro nuevo
(`officeId: route?.officeId ?? officeId`). Mientras valía `''` era inofensivo; en
cuanto `Route.officeId` tuviera valor real, cada cliente, venta, gasto, retiro y
movimiento de capital habría nacido con una **copia congelada** de la oficina, y
mover una ruta habría dejado el histórico contradictorio para siempre.

**`officeId` eliminado de:** `User`, `Client`, `Sale`, `Expense`,
`CapitalMovement`, `Transfer`, `Withdrawal`, `WeeklySettlement`.
**Conservado solo en:** `Route`.
**Nunca añadido a:** `Payment`, `Installment`, `SaleRequest`.

Escrituras eliminadas (14 puntos): `routeService`, `saleRequestService`,
`ActiveSalesPage`, `ClientsPage`, `CapitalPage`, `ExpensesPage`,
`WithdrawalsPage`, `TransfersPage`, `CollectorExpensesPage`,
`CollectorNewClientPage`, `CollectorNewSalePage`. Además `useTenant` dejó de
exponer `officeId`.

También se **eliminó `useOfficeFilter.ts`**, código muerto cuyo comentario afirmaba
*"El Administrador tiene acceso a TODAS las oficinas de su empresa"* — una premisa
anterior al fail-closed, falsa hoy y peligrosa si alguien la hubiera reutilizado.

Esto está protegido por pruebas de contrato (`OFFICE-ARCH-001/b/c`,
`OFFICE-MODEL-003`, `OFFICE-USER-002`) que fallan si alguien reintroduce el campo o
vuelve a copiarlo.

---

## 7. Migración v11

Aditiva y segura. Recrea la tabla `offices` (que la v3 había borrado) y sanea:

1. Rutas cuyo `officeId` no apunte a una Oficina **real** → `undefined`.
2. `officeId` eliminado de las 8 entidades que lo arrastraban.
3. No borra registros, no toca importes, ni estados, ni `routeId`, ni
   `authorizedRouteIds`. Reporta conteos por consola.

**Verificada en ejecución, no supuesta.** La auditoría dejó abierta la pregunta de
si Dexie permite recrear una tabla eliminada. Se añadió `fake-indexeddb` como
dependencia de desarrollo y una suite nueva (`npm run test:migrations`) que fabrica
una base **v1 real** —con la tabla `offices` original y `officeId` sembrado por
todas partes—, la migra hasta v11 pasando por el borrado de la v3, y comprueba:

- la tabla se recrea y **se puede usar** (escribir, leer, consultar por índice);
- las Oficinas de la v1 **no resucitan**: la tabla llega vacía;
- las tres rutas quedan Sin Oficina, ninguna se pierde;
- las 8 entidades quedan limpias;
- importes, `routeId` y asignaciones intactos;
- una instalación nueva abre directamente en v11;
- reabrir una base ya migrada es **idempotente** (no limpia Oficinas válidas).

---

## 8. Scoping y seguridad

**`permissions.ts` no cambió ni una línea de lógica de acceso.** Las cinco
funciones centrales (`authorizedRouteIdsOf`, `canAccessRoute`,
`filterAccessibleRoutes`, `filterByAccessibleRoute`, `isRouteUnrestricted`) siguen
operando solo sobre rutas.

La dirección de la derivación es de un solo sentido:

```
accessibleOffices = Oficinas presentes en accessibleRoutes     ← así
accessibleRoutes  = todas las rutas de accessibleOffice        ← NUNCA
```

`src/lib/officeGrouping.ts` es puro y **no importa la base de datos**. Todas sus
funciones reciben rutas **ya recortadas** por el scoping central y solo las agrupan
o filtran: una Oficina únicamente puede **estrechar** un conjunto ya permitido.

`useAccessibleOffices` deriva de `useAccessibleRoutes`; la tabla `offices` solo se
lee para poner nombre a los ids.

**Capacidades nuevas** (`office.create`, `office.edit`, `office.delete`,
`office.changeStatus`): son de **catálogo**, solo Super Admin y Administrador, y no
conceden acceso a los datos de ninguna ruta. Gestionar una Oficina y poder ver sus
rutas son cosas distintas, y hay una prueba dedicada a ello
(`OFFICE-SCOPE-006`).

---

## 9. Reportes

Orden obligatorio, verificado por prueba sobre el código (`OFFICE-REPORT-006`):

```
getAccessibleRouteIdSet(user, tenantId)   → alcance real
  ↓ narrowRouteIdsByOffice(scope, …)      → estrecha por Oficina
  ↓ resolveReportRouteIds(scopeEnOficina) → estrecha por Ruta
  ↓ fechas → buildReport
```

"Todas las rutas" dentro de una Oficina significa **la intersección** con lo
autorizado, nunca todas las rutas de esa Oficina.

El CSV gana columna **Oficina**, derivada de la ruta mediante
`officeNameByRouteId(routes, offices)`. No se lee de `Sale`, `Payment` ni `Expense`
—no la tienen—, así que mover una ruta reagrupa los reportes sin reescribir nada.
El nombre del archivo incluye la oficina cuando hay filtro.

**Consolidado parcial rotulado con honestidad:** si el usuario solo ve parte de las
rutas de una Oficina, el encabezado dice *"Leticia — 1 de 3 rutas (rutas
autorizadas)"*. Una cifra parcial nunca se presenta como el total de la Oficina.

---

## 10. Liquidación

Sigue siendo **por una sola ruta**. No existe liquidación consolidada por Oficina y
el motor (`weeklySettlementEngine`) **no conoce las Oficinas** — hay una prueba que
falla si alguien se las mete.

La Oficina es un filtro previo que recorta el selector de rutas. Al cambiar de
Oficina, una ruta seleccionada que quede fuera del filtro se **descarta**, para que
"Generar" no apunte a una ruta invisible.

---

## 11. Caja

**`cashboxEngine` no se tocó.** Todo sigue calculándose por ruta. La Oficina
funciona como filtro, agrupación y consolidado derivado: `rutas accesibles ∩
Oficina` → `getRoutesFinancialSummary(routeIds)`, que ya existía.

Ningún movimiento financiero guarda `officeId`. Verificado en `OFFICE-CASH-001`:
un pago y una venta recién creados **no contienen el campo**.

---

## 12. App Cobrador

- **Sin paso obligatorio de Oficina.** La app sigue trabajando por ruta.
- El selector de rutas las **agrupa visualmente** por Oficina, con "Sin Oficina" al
  final. Los encabezados solo aparecen cuando hay más de una ruta.
- Con **una sola ruta** se conserva la autoselección: el cobrador entra directo.
- **No se persiste ninguna "Oficina activa"**: habría sido un segundo estado capaz
  de desincronizarse de `useActiveRoute`.
- Elegir una Oficina nunca habilita rutas no autorizadas: lo que se muestra son
  exactamente las rutas asignadas.

---

## 13. Office inactiva

**Permite** (todo lo que es consulta): clientes, ventas, historial de crédito,
reportes históricos, caja histórica, administración de la propia Oficina y
reactivarla.

**Bloquea** (operaciones nuevas en sus rutas): pagos, ventas directas, solicitudes
de venta, aprobación de solicitudes, desembolsos, gastos, retiros, movimientos de
capital y transferencias con cualquier extremo en una ruta afectada.

**No hace:** borrar `authorizedRouteIds`, desasignar usuarios ni cambiar
`Route.status`.

**Implementación.** `can()` sigue siendo **síncrona y pura**: no se le metió
ninguna consulta a la base. Se siguió el camino del bloqueo de empresa
(`isCompanyBlocked`): una guarda aparte,
`assertRouteOperationalContext(routeId)`, invocada en los puntos de **escritura**.
En `registerPayment` la comprobación vive **dentro** de la transacción, con
`routes` y `offices` declaradas en su alcance — la lección del incidente del
15/09/2026.

Mensaje al usuario: *"Esta ruta pertenece a una Oficina inactiva. No se pueden
registrar nuevas operaciones."* Reactivar restablece la operación sin reasignar a
nadie.

---

## 14. DEMO

- **Oficina Barranquilla** (`BAQ`): Ruta Norte, Ruta Sur.
- **Oficina Soledad** (`SOL`): Ruta Soledad Centro, Ruta Soledad Industrial.
- **Ruta Malambo**: quinta ruta, deliberadamente **Sin Oficina**, para que ese
  estado sea visible en la demo.

`db.offices` está declarada en el alcance de la transacción del seed y las
oficinas se siembran allí. Ningún cliente, venta, gasto ni movimiento del seed
guarda `officeId`: solo las rutas.

---

## 15. CLEAN

Zero-state con **0 Oficinas**, y el recorrido completo se hace sin crear ninguna:
Super Admin → Empresa → Ruta sin Oficina → usuarios → asignar rutas → cliente →
venta → desembolso → pago.

Las Oficinas **no entran en el checklist de arranque** (hay una prueba que lo
verifica). Tras dos incidentes recientes de deadlock de onboarding, añadir un sexto
paso por algo que decidimos que es opcional habría reintroducido esa presión.

`offices` se añadió a `MemoryDb.TABLES` (para que el zero-state siga siendo
exhaustivo) y a `resetCleanDatabase`. El reset total ya borraba la base entera.

---

## 16. Tests

| Suite | Antes | Después |
|---|---|---|
| Permisos | 229 | **275** |
| Financiera | 136 | **151** |
| Arranque | 101 | **129** |
| Migraciones (nueva) | — | **13** |
| **Total** | **466** | **568 PASS · 0 FAIL** |

Familias nuevas: `OFFICE-MODEL-*`, `OFFICE-MIG-*`, `OFFICE-CRUD-*`,
`OFFICE-ROUTE-*`, `OFFICE-SCOPE-*`, `OFFICE-USER-*`, `OFFICE-STATUS-*`,
`OFFICE-REPORT-*`, `OFFICE-SETTLE-*`, `OFFICE-CASH-*`, `OFFICE-CLEAN-*`,
`OFFICE-DEMO-*`, `OFFICE-ARCH-*`, `SMOKE-1..5`.

Ninguna prueba existente se eliminó ni se debilitó.

Los cinco **smoke tests** se ejecutan de verdad sobre Dexie real con los servicios
reales, no como instrucciones manuales: CLEAN sin Oficina de punta a punta;
Oficina normal hasta el reporte; usuario multi-oficina; mover ruta sin alterar
datos; y Oficina inactiva con su ciclo completo de bloqueo y reactivación.

`npx tsc --noEmit` ✅ · `npx tsc --noEmit -p tests` ✅ · `npm run build` ✅

Dependencia nueva de desarrollo: `fake-indexeddb` (solo tests; no entra al bundle).

---

## 17. Hallazgos pendientes

No forman parte de este paquete.

1. **Dashboard sin desglose por Oficina.** El panel cuenta rutas y cifras sobre las
   rutas ya recortadas, que es correcto, pero no ofrece todavía un desglose
   "Oficina → rutas". Añadirlo es directo (los agregadores multi-ruta existen); se
   dejó fuera para no ampliar el alcance.
2. **Selectores de ruta antiguos sin filtro de Oficina.** Caja, Gastos, Retiros y
   Capital conservan sus selectores propios. Funcionan y respetan el scoping; solo
   no ofrecen el filtro por Oficina. Unificarlos con `RouteSelector` +
   `OfficeSelector` es la limpieza pendiente que ya señalaba la auditoría.
3. **Secretario y Socio sin filtro de Oficina.** Ven la agrupación donde comparten
   componentes, pero no se les añadió un filtro propio.
4. **Snapshot histórico de Oficina en liquidaciones.** `WeeklySettlement.officeId`
   se eliminó, como se decidió. Si el negocio necesita congelar la oficina del
   momento en una liquidación archivada, debe diseñarse aparte y a propósito.
5. Siguen abiertos los hallazgos previos: persistencia de liquidaciones semanales y
   la discrepancia `createdAt` vs `fechaInicio`.

---

# Evolución 1 — Oficina como unidad de gestión

La entrega anterior dejó las Oficinas funcionando, pero como un CRUD: crear,
editar, activar, eliminar. Esta evolución las convierte en una **unidad de
gestión**: se entra a una Oficina y se trabaja desde ella.

Nada de la arquitectura cambió. El principio sigue siendo el mismo y ahora está
protegido en un sitio más: **entrar a una Oficina no concede ni una sola ruta.**

## OfficeDetail

Nueva página `/admin/offices/:officeId` ([OfficeDetailPage.tsx](../src/pages/admin/OfficeDetailPage.tsx)),
con botón **Entrar** en cada tarjeta de `OfficesPage`. No es un modal.

Todo lo que muestra sale de un punto único de carga,
`getOfficeManagementSummary`, cuyo orden es obligatorio y está verificado por
prueba sobre el propio código (`OFFICE-DASH-008`):

```
rutas de la EMPRESA
  ↓ filterAccessibleRoutes(user)      ← se RECORTA aquí
  ↓ filtrar por officeId              ← accessibleOfficeRoutes
  ↓ indicadores, alertas, usuarios    ← solo sobre ese conjunto
```

Nunca al revés. La única cifra que mira más allá es `totalRoutesInOffice`, un
**conteo estructural** que existe precisamente para no mentir sobre el alcance.

## KPIs

Rutas visibles, operativas, sin Cobrador, clientes activos, ventas activas y
desembolsos pendientes. La cartera activa se muestra cuando el motor de caja la
devuelve.

**No se construyó ningún motor financiero nuevo ni se tocó el existente.** Se
reutiliza `getRoutesFinancialSummary(routeIds)`, que ya existía, y si no responde
se cae a un conteo directo con el mismo criterio. `git diff` sobre `cashboxEngine`,
`installmentEngine`, `weeklySettlementEngine` y `paymentService` está **vacío**.

El estado operativo de cada ruta es **derivado**, no persistido: `inactiva` →
`sin-cobrador` → `operativa`, todo a partir de reglas que ya existían.

## Rutas

Tarjetas con nombre, código, estado operativo, clientes, ventas, desembolsos
pendientes y el equipo asignado. Acciones **Editar** y **Mover**, ambas sujetas a
las capacidades actuales. No se creó ningún acceso nuevo por Oficina.

## Nueva ruta desde la Oficina

`[+ Nueva ruta]` navega a `/admin/routes?nueva=1&officeId=<id>` y **reutiliza el
formulario existente** con la Oficina preseleccionada. No hay un segundo
formulario — hay una prueba que falla si aparece (`OFFICE-NAV-002`).

La Oficina sigue siendo modificable y opcional; Administrador y Cobrador siguen
siendo opcionales; todas las advertencias ámbar se conservan.

`?editar=<routeId>` abre el editor de una ruta, pero **solo si está entre las
accesibles**: el enlace no sirve de atajo para editar una ruta fuera de alcance.
Los parámetros se consumen una vez y se limpian de la URL.

## Movimiento de rutas

Desde el panel, con vista previa explícita (*"Oficina actual: Leticia → Nueva
oficina: Río"*) y la opción de dejarla **Sin Oficina**. Sigue siendo **una sola
escritura** sobre `Route.officeId`: `OFFICE-MGMT-007` cuenta las escrituras reales
contra la base y falla si hay más de una.

## Usuarios relacionados

La sección se llama **"Usuarios con rutas asignadas en esta oficina"**, no
"usuarios de la oficina" — porque los usuarios pertenecen a la empresa.

Se derivan de `authorizedRouteIds ∩ rutas de la Oficina`. De un usuario que
también trabaja en otra Oficina se muestran aquí **solo sus rutas de esta**; no se
le oculta, simplemente no se mezclan alcances. El Super Admin no se lista: su
acceso es global y no representa una asignación.

## Gestión de asignaciones

"Gestionar asignaciones" permite marcar y desmarcar **solo rutas de esta Oficina**
para un usuario general de la empresa.

Esta es la parte más delicada de la entrega, y la lógica vive en una función pura
(`applyOfficeRouteSelection`) con siete casos dedicados. La regla:

> Fabio tiene Leticia/Centro y Río/Puerto. Si desde Leticia se desmarca Centro,
> **Puerto no se pierde.**

Se conserva todo lo que no pertenece a la Oficina editada, incluidas las rutas Sin
Oficina. Se guarda `authorizedRouteIds` y nada más: sin `officeIds`, sin
`user.officeId`, sin duplicar usuarios. Para cobradores se delega en
`setCobradorRoutes`, que ya mantenía coherente el responsable de la ruta.

El modal avisa en texto cuántas rutas de otras oficinas conserva el usuario.

## Alertas

Derivadas al abrir la pantalla, sin ninguna tabla ni estado nuevo: Oficina
inactiva (error), ruta sin Cobrador, ruta inactiva y desembolsos pendientes con su
conteo. Una ruta sana no genera ninguna alerta falsa (`OFFICE-ALERT-002`).

Las alertas se calculan sobre las rutas visibles: `OFFICE-MGMT-011` comprueba que
una alerta no puede revelar la existencia de una ruta no autorizada.

## Sin Oficina

Bloque propio en `OfficesPage` y página `/admin/offices/sin-oficina`
([UnassignedRoutesPage.tsx](../src/pages/admin/UnassignedRoutesPage.tsx)).

**No es una Oficina y no se crea ningún registro llamado así**: es la agrupación
derivada de `route.officeId === undefined`, donde la migración v11 dejó las rutas
que ya existían. Hay una prueba que falla si alguien crea esa Office
(`OFFICE-UNASSIGNED-002`).

Permite asignación **individual y masiva**. La masiva es **todo-o-nada**: valida
todas las rutas antes de escribir ninguna, y `OFFICE-UNASSIGNED-004` comprueba que
una ruta inválida deja el resto sin mover. Cada ruta se audita por separado.

## Navegación

Breadcrumbs `Empresa > Oficinas > Oficina Leticia` y cabecera adhesiva con nombre,
código, estado y alcance, para no perder contexto al hacer scroll.

Los breadcrumbs son orientación, no una dependencia funcional: `/admin/routes`
sigue funcionando exactamente igual sin ningún parámetro
(`OFFICE-NAV-003`). Accesos rápidos a Clientes, Reportes, Liquidación y Rutas, sin
prefiltrado inventado — la integración real de filtros llega en la Entrega 2.

## Tests

| Suite | Antes | Después |
|---|---|---|
| Permisos | 275 | **315** |
| Financiera | 151 | **151** |
| Arranque | 129 | **145** |
| Migraciones y smoke | 13 | **18** |
| **Total** | **568** | **629 PASS · 0 FAIL** |

Familias nuevas: `OFFICE-MGMT-*` (16), `OFFICE-DASH-*`, `OFFICE-ALERT-*`,
`OFFICE-UNASSIGNED-*`, `OFFICE-NAV-*`, y los smoke `SMOKE-A..E` ejecutados sobre
Dexie real con los servicios reales.

`npx tsc --noEmit` ✅ · `npx tsc --noEmit -p tests` ✅ · `npm run build` ✅

## Limitaciones deliberadas

Quedan fuera **a propósito**, para la Entrega 2 en adelante:

1. Filtro de Oficina en todas las pantallas (Clientes, Caja, Gastos, Retiros,
   Capital). Los accesos rápidos navegan sin prefiltrar en vez de inventar
   parámetros que la pantalla destino aún no entiende.
2. Caja consolidada avanzada, recaudo analítico y cartera avanzada por Oficina.
3. Comparación ejecutiva entre Oficinas y exportación CSV del resumen de Oficina.
4. Integración profunda de Secretario y Socio (Entrega 4). Los servicios ya quedan
   reutilizables para ello.
5. Desglose por Oficina en el Dashboard de empresa.
6. OfficeDetail para Cobrador: mantiene solo la agrupación en el selector de rutas,
   sin KPIs ni usuarios relacionados, como se pidió.

---

# Nota — Modelo de múltiples Administradores

Formalizado al corregir una advertencia falsa al editar rutas. La regla ya estaba
implícita en el modelo; ahora está documentada y probada.

## El bug corregido

Una ruta con Administrador asignado mostraba correctamente *"Administrador: Admin
Credirutas"* en la tarjeta, pero al pulsar **Actualizar** saltaba:

> «Esta ruta ACTIVA quedará sin ningún Administrador responsable. ¿Deseas guardar
> de todos modos?»

**Causa raíz** — `RoutesPage.handleSave` decidía la advertencia comparando el
BORRADOR de usuarios asignados contra los administradores previos:

```ts
const draftAdmins = form.assignedUserIds.filter(id => …rol === 'admin')   // ← siempre vacío
const prevAdmins  = allUsers.filter(a => a.rol === 'admin' && …)
if (draftAdmins.length === 0 && prevAdmins.length > 0) → advertencia
```

El borrador se hidrata solo con usuarios que el actor puede gestionar
(`isAssignable` → `assignableRoles`), y **`MANAGEABLE_ROLES.admin` no incluye
`'admin'`**: un Administrador no gestiona a otros Administradores. Así que para un
actor Admin el borrador **nunca** contiene administradores, `draftAdmins` daba 0 y
la advertencia saltaba aunque nadie hubiera tocado nada.

Lo curioso es que el guardado siempre fue correcto:
`computeRouteAssignmentDiff` solo retira usuarios dentro de `assignableUserIds`, de
modo que esos administradores jamás se iban a desasignar. El fallo era únicamente
de cálculo de la advertencia — pero llevaba al usuario a creer que estaba a punto
de romper algo.

## La corrección

Nuevo módulo puro [`src/lib/routeAdmins.ts`](../src/lib/routeAdmins.ts), que calcula
los administradores **efectivos después de guardar**:

```
efectivos = (admins asignables que quedan marcados en el borrador)
          ∪ (admins NO asignables que ya estaban y que el guardado no toca)
```

El segundo conjunto no es una concesión: es lo que realmente ocurre, porque el
diff no puede retirar fuera del alcance del actor. La advertencia ámbar del
formulario y la confirmación al guardar usan ahora esa misma cifra.

La lógica antigua quedó **congelada como prueba** (`ROUTE-ADMIN-REG-001`): el caso
verifica que producía el falso positivo, para que nadie la reintroduzca por
descuido.

## Reglas del modelo

- Una **empresa** puede tener tantos Administradores como necesite.
- Una **ruta** puede tener **más de un** Administrador.
- Los Administradores son **usuarios generales de la empresa**: no pertenecen a
  ninguna Oficina, no existe `user.officeId` ni `user.officeIds`.
- Su acceso operativo nace **solo** de `authorizedRouteIds`, y pueden tener rutas
  de Oficinas distintas.
- **Fuente única** de la relación Admin ↔ Ruta: `User.authorizedRouteIds`. No
  existe `Route.adminId` ni `Route.adminIds`, y hay una prueba que falla si
  aparecen.
- Un **Administrador nuevo no hereda ninguna ruta**: nace con
  `authorizedRouteIds` vacío.
- **Crear una ruta desde Super Admin no la reparte** entre los Administradores
  existentes: recibe la ruta solo quien se haya seleccionado.
- **Crear una ruta desde un Administrador** mantiene su autoasignación, que es una
  protección interna contra el auto-bloqueo (su acceso es fail-closed por rutas).
  No arrastra a ningún otro Administrador ni convierte el campo en obligatorio.
- Una **ruta sin Administrador sigue siendo válida**: advertencia, nunca bloqueo.
  Al confirmar se guarda y no hay rollback.
- **Desasignar** a un Administrador de una ruta conserva intactas sus demás rutas.

## Administradores inactivos

Un Administrador **inactivo no cuenta** como responsable efectivo de la ruta. Es
coherente con el resto del sistema: `createRouteWithAdmins` rechaza administradores
inactivos y el invariante de cobradores exige responsable activo.

No se desasigna ni se toca a nadie por estar inactivo: simplemente no se cuenta. La
tarjeta de ruta lo marca ahora como `(inactivo)` para que no aparente sostener una
responsabilidad que las advertencias no le reconocen.

## Interfaz

- **0 admins** → "Sin Administrador asignado"
- **1 admin** → "Administrador: Carlos"
- **2 o más** → "Administradores: Carlos, Juan" (nunca el singular)

La tarjeta muestra hasta dos por rol con "+N más" y un "Ver todos" para expandir,
de modo que nunca parece que solo existe uno.

## Tests

Grupo `ROUTE-ADMIN-*` (34 comprobaciones puras + 10 de servicio) y smoke
`SMOKE-ADMIN-A..E` sobre Dexie real. Cubren empresa multi-admin, ruta multi-admin,
hidratación del editor, la regresión del falso positivo, quitar todos vs dejar uno,
admin nuevo sin rutas, creación desde Super Admin y desde Admin, conservación de
rutas al desasignar, admin inactivo, y que gestionar Oficinas no concede rutas.
