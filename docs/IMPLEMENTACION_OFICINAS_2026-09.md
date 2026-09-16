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

---

# Evolución 2 — Integración transversal Oficina → Ruta

La Entrega 1 convirtió la Oficina en unidad de gestión, pero sus accesos rápidos
llevaban al módulo general sin contexto. Esta entrega los conecta de verdad y
extiende el filtro a los ocho módulos administrativos.

## Patrón Office → Route

Un solo patrón, implementado una vez y reutilizado en todas partes:

```
Oficina seleccionada
  ↓ rutas YA autorizadas del usuario (filterAccessibleRoutes)
  ↓ filtradas por officeId
  ↓ ruta elegida (opcional)
  ↓ datos
```

Piezas nuevas:

- [`src/lib/officeRouteFilter.ts`](../src/lib/officeRouteFilter.ts) — **puro**, sin
  base de datos: `resolveOfficeParam`, `visibleRouteIds`, `routeStillInFilter`,
  `filterRowsByVisibleRoutes`, etiquetas e índices.
- [`src/hooks/useOfficeRouteFilter.ts`](../src/hooks/useOfficeRouteFilter.ts) — el
  hook compartido. Parte de `useAccessibleRoutes`, lee `?officeId=`, limpia la ruta
  al cambiar de Oficina y no persiste ninguna "Oficina activa".
- [`OfficeRouteFilterBar`](../src/components/ui/OfficeRouteFilterBar.tsx) — la barra
  Oficina + Ruta + contexto, para que las ocho pantallas se comporten igual.

**"Todas las oficinas" son todas las rutas AUTORIZADAS**, no todas las del tenant
(para el Super Admin, que no está limitado por rutas, coinciden).

## Accesos rápidos desde OfficeDetail

Los seis destinos llevan ahora `?officeId=<id>`: **Clientes, Ventas, Caja,
Reportes, Liquidación y Rutas**. Hay una prueba que falla si alguno vuelve a
navegar al módulo general sin contexto (`OFFICE-CONTEXT-007`).

Si el panel mostraba un alcance parcial ("2 de 3 rutas visibles"), el destino
hereda exactamente ese alcance: el filtro se aplica sobre las rutas autorizadas,
no sobre las de la Oficina.

## Módulos integrados

| Módulo | Qué cambió |
|---|---|
| **Clientes** | Barra Oficina→Ruta; la fila muestra "Leticia / Centro" derivado de `routeId`; se eliminó su selector de ruta propio |
| **Ventas activas** | Barra Oficina→Ruta; recorte antes de los filtros de la pantalla; selector propio eliminado |
| **Caja** | Su selector suelto se sustituyó por Oficina + Ruta; el motor `cashboxEngine` **no se tocó** |
| **Gastos** | Barra compartida; `<select>` de ruta propio eliminado |
| **Capital** | Solo se agrupan las rutas visibles del filtro; con filtro activo desaparece el grupo "Sin ruta", que lo contradecía |
| **Retiros** | Barra compartida |
| **Transferencias** | Cada extremo de tipo ruta muestra "Oficina / Ruta" derivadas; una transferencia entra si **alguno** de sus extremos está en el filtro |
| **Reportes** | Ya tenía Oficina; ahora acepta y valida `?officeId=` |
| **Liquidación** | Oficina preseleccionada desde la URL; la ruta sigue siendo obligatoria y el motor no cambia |
| **Rutas** | Acepta `?officeId=` además de `?nueva` y `?editar` |

## Query params y degradación segura

`?officeId=` se **valida contra el catálogo de la empresa** antes de aplicarse. Un
id de otra empresa, inventado o de una Oficina borrada se **ignora** y se cae a
"todas las oficinas".

Y aunque se aceptara, no habría filtración: el filtro se aplica siempre sobre
`accessibleRoutes`, así que un id ajeno produce un conjunto vacío
(`OFFICE-FILTER-006f`). El parámetro se consume una sola vez y se limpia de la URL,
para que un refresco no reimponga un filtro que el usuario ya cambió.

## Sin Oficina

Transversal en todos los módulos con filtro: `Route.officeId === undefined`. No se
creó ninguna Office falsa con ese nombre.

## Scoping y seguridad

`permissions.ts` no cambió. El módulo puro del filtro **no importa la base de
datos**, y todas sus funciones parten de rutas ya recortadas: la Oficina solo puede
estrechar. Verificado tras el cambio: `officeId?: string` sigue apareciendo **una
sola vez** en el modelo (Route), ninguna de las once entidades operativas lo
declara, y no existe `user.officeId` ni `officeIds`.

## Rendimiento

Sin consultas N+1: `buildLookups` construye `Map<routeId, Route>` y
`Map<officeId, Office>` una vez por pantalla y todo el etiquetado se resuelve en
memoria.

## Ajustes absorbidos de Entrega 1

Resueltos dentro de este mismo paquete, sin abrir mini-parches:

1. **Accesos rápidos sin contexto** — navegaban al módulo general. Ahora los seis
   llevan `?officeId=`.
2. **Faltaba "Ver Caja"** en el panel de Oficina. Añadido, junto con "Ver Ventas".
3. **"Ver todas las rutas"** dentro del panel ignoraba la Oficina; ahora es "Ver
   estas rutas" y conserva el filtro.
4. **Selectores de ruta duplicados** en Clientes, Ventas, Gastos y Caja —
   sustituidos por el par compartido, que era la limpieza pendiente que la
   auditoría había señalado.
5. **`OFFICE-NAV-003`** comprobaba una línea exacta del efecto de `RoutesPage`; al
   añadir el contexto de Oficina se reescribió para verificar la conducta (entrar
   sin parámetros sigue funcionando) en vez de la forma del código.
6. **Grupo "Sin ruta" de Capital** aparecía incluso con un filtro activo,
   contradiciendo el recorte. Ahora solo se muestra sin filtro.

## Tests

| Suite | Antes | Después |
|---|---|---|
| Permisos | 349 | **402** |
| Financiera | 151 | **151** |
| Arranque | 155 | **155** |
| Migraciones y smoke | 23 | **30** |
| **Total** | **678** | **738 PASS · 0 FAIL** |

Familias `OFFICE-FILTER-*`, `OFFICE-CONTEXT-*`, `OFFICE-CLIENT-*`,
`OFFICE-SALES-*`, `OFFICE-CASH-FILTER-*`, `OFFICE-EXPENSE-FILTER-*`,
`OFFICE-CAPITAL-FILTER-*`, `OFFICE-WITHDRAW-FILTER-*`,
`OFFICE-TRANSFER-FILTER-*`, `OFFICE-DERIVE-STRICT-*` y los smoke `SMOKE-E2-1..7`
sobre Dexie real.

## Pendientes para Entrega 3

Recaudo analítico por Oficina; cartera avanzada; dashboard ejecutivo comparativo y
ranking entre Oficinas; integración profunda de Secretario y Socio; exportaciones
del resumen de Oficina; auditoría ejecutiva; persistencia y cierre de liquidaciones;
snapshot histórico de Oficina.

---

# Evolución 3 — Oficina operativa y financiera

La Oficina pasa de ser un contexto de navegación a una **unidad operativa**: al
entrar se ve cómo va la cobranza del día, la cartera, el consolidado financiero y
qué rutas necesitan atención.

## Ajustes UX absorbidos de Entrega 2

Resueltos dentro del paquete, sin abrir mini-parches:

1. **Textos explicativos eliminados.** Fuera el banner *"Las oficinas agrupan
   rutas…"* de Oficinas, la explicación de *"Los usuarios pertenecen a la empresa,
   no a la oficina"* y el texto *"Estos accesos abren cada módulo filtrado por…"*.
   La app no explica lo obvio. Se conservó el texto del estado vacío de Oficinas
   porque es **accionable**: dice qué hacer cuando no hay ninguna.
2. **Lista de usuarios compacta.** Las tarjetas grandes se sustituyeron por filas
   de una línea: nombre · rol · rutas de esta oficina · **[Editar]**. El enlace
   largo "Editar sus rutas de esta oficina" desapareció. La edición conserva el
   comportamiento: solo toca rutas de esta Oficina.
3. **Barra de acciones anclada.** Los seis accesos (Clientes, Ventas, Caja,
   Reportes, Liquidación, Rutas) viven ahora en una barra fija al borde inferior,
   con fondo difuminado y elevación. Se reserva un espaciador de 64 px para que no
   tape la última sección, y en pantallas estrechas la fila se desplaza en
   horizontal en vez de romperse. Sin texto explicativo.
4. **Jerarquía visual.** El estado operativo derivado ("5 rutas · 4 operativas · 1
   sin Cobrador") se movió a la cabecera, junto al alcance, para que el contexto
   quepa en una línea.

## KPIs operativos

Nuevo módulo **puro** [`src/lib/officeOperations.ts`](../src/lib/officeOperations.ts):
no importa la base de datos y **no conoce la Oficina** — solo recibe filas de
rutas. Quien llama le pasa únicamente las de las rutas accesibles.

**Cobranza de hoy:** a cobrar hoy, recaudado hoy, pendiente hoy y % de
cumplimiento.

Una decisión que importa: **"a cobrar hoy" es el VALOR de las cuotas que vencen
hoy, no su saldo restante.** La primera implementación usaba el saldo y el
cumplimiento salía inflado — cobrar 60 de 100 daba 60/40 → 100 %. Con el valor da
60 %. El smoke con datos reales lo detectó antes de publicarse.

El recaudo usa `effectivePayments`: un pago revertido no cuenta, ni su asiento de
reversión. Solo entran ventas **activas y desembolsadas**, igual que en
`getRouteFinancialSummary`.

## KPIs financieros

Consolidado de Oficina = **suma de los resúmenes por ruta que ya produce
`cashboxEngine`**. No hay motor nuevo y el existente no se tocó: `git diff` sobre
`cashboxEngine`, `installmentEngine` y `permissions.ts` está **vacío**.

Muestra base actual, total controlado, cobros, desembolsos, gastos, retiros y
transferencias. **Solo se calcula si el rol tiene `cashbox.viewRoute`**: sin
permiso, el dato ni siquiera se consulta ni viaja a la pantalla. Un Cobrador con
las mismas rutas recibe `finance: null` pero conserva sus indicadores operativos.

Si el motor de caja no responde, el panel se muestra sin consolidado en vez de
caerse: los indicadores operativos no dependen de él.

## Cartera y cobranza

Cartera activa, cartera vencida, clientes con atraso, ventas activas y parcelas
pendientes. La cartera vencida suma el saldo de cuotas con fecha anterior a hoy, y
los clientes con atraso son los **distintos** con alguna de esas cuotas.

## Comparativo por rutas

Dentro de la misma tarjeta de cada ruta, sin módulo aparte: barra de progreso del
cumplimiento del día, recaudado/meta, cartera, cartera vencida, clientes en atraso
y gastos del día.

## Alertas avanzadas

Derivadas al abrir, sin persistencia nueva: cartera vencida, clientes con atraso,
cumplimiento bajo (umbral 50 %) y rutas sin Administrador efectivo. Se suman a las
de Entrega 1 (Oficina inactiva, ruta sin Cobrador, ruta inactiva, desembolsos
pendientes).

Un día **sin cuotas no se marca como incumplimiento**: no hay meta que incumplir.

## Estado operativo calculado

Derivado, nunca persistido, en la cabecera junto al alcance.

## Scoping y seguridad

`permissions.ts` sin cambios. Cadena verificada por prueba sobre el código:
`authorizedRouteIds` → `filterAccessibleRoutes` → rutas de la Oficina → filas
recortadas por `routeIds` → hechos operativos. `SMOKE-E3-2` lo comprueba con datos
reales: una ruta no autorizada con 999.999 pendientes **no aparece en ningún
indicador ni en ninguna alerta**.

## Rendimiento

Las filas (pagos, gastos, parcelas) se cargan **una vez** y se indexan en memoria
(`installmentsBySale`). Sin consultas por ruta ni por fila.

## Tests

| Suite | Antes | Después |
|---|---|---|
| Permisos | 402 | **461** |
| Financiera | 151 | **151** |
| Arranque | 155 | **155** |
| Migraciones y smoke | 30 | **36** |
| **Total** | **738** | **803 PASS · 0 FAIL** |

Familias `OFFICE-OPS-*`, `OFFICE-FIN-*`, `OFFICE-UX-*`, `OFFICE-DASH-ADV-*`,
`OFFICE-ACTIONBAR-*` y los smoke `SMOKE-E3-1..6` sobre Dexie real.

## Limitaciones y pendientes

- **Gastos del período**: se muestra el gasto **del día** en el comparativo por
  ruta. El consolidado financiero sí trae el gasto del período que calcula el motor
  de caja. Un selector de período propio en el panel queda pendiente.
- **Transferencias**: se muestran entradas y salidas agregadas; falta el detalle
  por contraparte.
- Fuera de alcance, para etapas posteriores: dashboard ejecutivo entre Oficinas,
  ranking comparativo, integración profunda de Secretario y Socio, exportaciones
  del resumen de Oficina, auditoría ejecutiva, persistencia y cierre de
  liquidaciones, snapshot histórico de Oficina.

---

# Evolución 4 — Integración por roles y gestión ejecutiva

Cierra la integración de Oficinas: los roles operativos y de consulta las usan como
contexto, y la empresa gana una lectura ejecutiva de todas ellas.

## Semántica final de "A cobrar hoy"

La Entrega 3 la definió por el **valor nominal** de las cuotas del día. Al revisarlo
contra el modelo real, esa definición **contradecía lo que el sistema ya hacía**:

- `quickAmounts().parcela` — lo que la app propone cobrar al Cobrador — es
  `calculateCurrentInstallment(...).saldo`, el **saldo** de la cuota en curso.
- `applyPaymentToInstallments` aplica los pagos a la primera cuota no pagada en
  orden, **sin emparejar por fecha**: un abono adelantado de ayer reduce el saldo de
  la cuota de hoy.

Medir por el nominal habría penalizado al cobrador por los adelantos que ya
consiguió. **Definición adoptada, única para todo RutaCash:**

```
pendienteHoy = Σ saldo ACTUAL de las cuotas que vencen hoy
recaudadoHoy = Σ pagos vigentes con fecha de hoy
aCobrarHoy   = pendienteHoy + recaudadoHoy     ← meta al empezar la jornada
cumplimiento = recaudadoHoy / aCobrarHoy
```

Reconstruir la meta sumando lo ya cobrado evita el error original de la Entrega 3
(medirla por el saldo a secas la encogía al cobrar y el cumplimiento salía inflado).

| Caso | Situación | Meta | Recaudado | Cumplimiento |
|---|---|---|---|---|
| 1 | Cuota 100, sin abonos previos, se cobran 60 | 100 | 60 | **60 %** |
| 2 | Cuota 100 con 40 de ayer, se cobran los 60 restantes | 60 | 60 | **100 %** |
| 3 | Cuota 100, no se cobra nada | 100 | 0 | **0 %** |

El caso 2 es la decisión de fondo: la deuda del día quedó saldada, así que es un
100 %, no un 60 %.

**Aproximación conocida y aceptada:** `recaudadoHoy` son todos los pagos del día sin
distinguir a qué cuota se aplicaron (el modelo no enlaza pago↔parcela). Cobrar
atrasos sube tanto el recaudo como la meta, de modo que el porcentaje sigue acotado.

Probado en `OFFICE-COLLECTION-SEMANTICS-001..004`.

## Supervisor

Sus rutas se agrupan por Oficina en el selector y comparte el patrón Oficina → Ruta
de los módulos administrativos. **No gana ninguna capacidad estructural**: no
gestiona el catálogo de Oficinas, y sigue sin acceder a las rutas hermanas.

## Secretario

Clientes con filtro Oficina → Ruta y contexto **"Leticia / Centro"** en cada fila,
derivado de la ruta del cliente. Las correcciones de pago siguen sujetas al mismo
alcance: `payment.correct` funciona en su ruta y falla fuera de ella.

## Socio

- **Clientes** con el filtro compartido.
- **Panel consolidado** agrupado por Oficina, con el subtotal de base y cartera de
  **sus** rutas en cada grupo.
- Si su alcance es parcial, la fila del comparativo lo declara ("2/4 rutas") y el
  CSV también. Nunca aparenta el total de la Oficina.

## Dashboard general de empresa

Nuevo [`OfficesExecutivePanel`](../src/components/ui/OfficesExecutivePanel.tsx) en el
panel del Administrador/Super Admin: una tarjeta por Oficina (rutas, clientes,
cartera, recaudo de hoy, cumplimiento, alertas) con botón **Entrar**, más el grupo
**Sin Oficina** que lleva a su página de organización.

## Comparativo de Oficinas

Tabla objetiva —**sin ranking**, porque comparar oficinas es una lectura, no una
clasificación— con rutas, clientes, ventas, cartera, vencida, recaudo, cumplimiento,
gastos y alertas. El pie muestra el **total visible**, que se calcula con el mismo
agregador que las filas para que nunca puedan divergir (`OFFICE-COMPARE-002`).

Una Oficina de la que el usuario no ve ninguna ruta **no genera fila**: no se
insinúa lo que no se puede ver.

## Actividad reciente

Sección compacta en el panel de Oficina, derivada de la **auditoría existente**. Sin
tabla nueva.

El recorte sigue el principio de siempre: se parte de las rutas accesibles de la
Oficina y se filtran los registros por ellas. Una acción de una ruta no autorizada
no aparece aunque pertenezca a esa Oficina, y una acción sin `routeId` (de empresa)
no se atribuye aquí. `SMOKE-E4-5` lo comprueba quitándole una ruta al usuario y
verificando que su actividad desaparece de la vista.

## Exportaciones

Dos CSV desde el panel de Oficina: **resumen** (una fila) y **comparativo de rutas**
(una fila por ruta visible). Contienen exactamente lo que hay en pantalla, y el
campo **Alcance** declara *"2 de 4 rutas autorizadas"* cuando es parcial. Sin PDF en
esta entrega.

## Gastos del período y transferencias

El consolidado financiero trae el gasto del período que calcula el motor de caja; el
comparativo por ruta muestra el **del día**, y ambos van etiquetados como tales para
que no se confundan. Las transferencias se presentan como entradas y salidas
agregadas. El detalle por contraparte sigue pendiente: sin enlace directo
Oficina↔transferencia, aportaba poco frente al ruido que añadía al panel.

## Corrección de la barra flotante

La barra invadía el sidebar porque era `fixed` al **viewport**. Ahora es
**`sticky bottom-0` dentro del `<main>` del AdminLayout**, que es el contenedor de
scroll real.

Es una solución estructural, no un parche: no hay `left: 200px` ni `calc()` ni
ningún ancho del sidebar escrito a mano. Si el sidebar cambia de ancho o se colapsa
en móvil, la barra lo sigue sola. Los márgenes negativos (`-mx-4 md:-mx-6`) cancelan
el padding de la página para que llegue de borde a borde del área de contenido.

Verificado por `OFFICE-ACTIONBAR-003..006`: pertenece al contenedor principal, no
usa el ancho del viewport, no contiene desplazamientos hardcodeados y conserva el
scroll horizontal interno en pantallas estrechas.

## Tests

| Suite | Antes | Después |
|---|---|---|
| Permisos | 461 | **521** |
| Financiera | 151 | **151** |
| Arranque | 155 | **155** |
| Migraciones y smoke | 36 | **42** |
| **Total** | **803** | **869 PASS · 0 FAIL** |

Familias `OFFICE-COLLECTION-SEMANTICS-*`, `OFFICE-ROLE-SUP-*`, `OFFICE-ROLE-SEC-*`,
`OFFICE-ROLE-PARTNER-*`, `OFFICE-EXEC-*`, `OFFICE-COMPARE-*`, `OFFICE-ACTIVITY-*`,
`OFFICE-EXPORT-*`, `OFFICE-ACTIONBAR-003..006`, y los smoke `SMOKE-E4-1..6`.

---

# Entrega 5 — Liquidaciones persistentes y cierre de período

## El hallazgo que cambió el alcance

La investigación previa encontró que **casi toda la protección de períodos cerrados
ya estaba escrita**:

- `WeeklySettlement` ya tenía `status?: 'abierta' | 'cerrada'` y el bloque financiero completo.
- `isPaymentInClosedPeriod` ya existía y ya comparaba `payment.fecha` (la **fecha
  contable**), no `updatedAt`. La duda del enunciado sobre qué fecha usar ya estaba
  resuelta en el código.
- La cadena de ajuste estaba completa: `requestPaymentAdjustment`,
  `approvePaymentAdjustment`, `rejectPaymentAdjustment`, la tabla
  `paymentAdjustmentRequests` (Dexie v5), `PaymentAdjustmentsPage` y el aviso al
  Secretario en `SecretarioPaymentCorrectionPage`.
- `permissions.ts` ya condicionaba `payment.correct` a `periodClosed` y lo derivaba
  a `payment.approveAdjustment`.

**Faltaba una sola pieza**: `WeeklySettlementPage` calculaba la liquidación en
estado de React y exportaba el CSV desde ahí. No existía ninguna llamada a
`db.weeklySettlements.add`. Nada se archivaba, así que **ningún período estaba
cerrado nunca** y toda esa cadena permanecía dormida.

Por eso esta entrega no reescribe la protección: **la enciende**.

## Modelo (`WeeklySettlement`)

Se reutilizó el `status` existente añadiendo `'reabierta'`, y se añadieron campos
opcionales. No se creó ninguna entidad nueva.

| Campo | Para qué |
|---|---|
| `status: 'abierta' \| 'cerrada' \| 'reabierta'` | `reabierta` = cierre anulado de forma controlada; deja de proteger pero se conserva |
| `closedAt` / `closedByUserId` | quién cerró y cuándo |
| `reopenedAt` / `reopenedByUserId` / `reopenReason` | quién reabrió, cuándo y **por qué** (obligatorio) |
| `version` / `supersededBy` | cerrar → reabrir → corregir → recerrar genera v1, v2…; el anterior queda enlazado, nunca sobrescrito |
| `officeIdAtClose` / `officeNameAtClose` / `officeCodeAtClose` | snapshot histórico de Oficina |

## El snapshot de Oficina no reintroduce `officeId` operativo

Es la **única excepción** permitida y está acotada:

- Vive **solo** dentro de `WeeklySettlement`, en ninguna otra entidad.
- Se llama distinto a propósito (`officeIdAtClose`, no `officeId`) para que nadie lo
  confunda con `Route.officeId`.
- **No participa en ningún filtro de acceso ni de alcance.** `listSettlementsForUser`
  recorta por `filterAccessibleRoutes` y no menciona `AtClose`.
- Una ruta Sin Oficina se archiva como `officeIdAtClose: undefined` +
  `officeNameAtClose: 'Sin Oficina'`. No se inventa ninguna Oficina.
- Una Oficina borrada del catálogo conserva el id y se rotula `'Oficina eliminada'`,
  para no disfrazarla de "Sin Oficina".

Existe porque una ruta puede cambiar de Oficina, y una semana ya cerrada no debe
cambiar de Oficina retroactivamente. Congelado por `OFFICE-ARCH-003a..e`.

## Migración v12

Aditiva. Los campos nuevos son opcionales y no necesitan índices. La v12 solo
**normaliza** las liquidaciones que ya existieran: `status` ausente → `'cerrada'`,
`version` ausente → `1`, `closedAt` ausente → `createdAt`.

**No se deduce el snapshot de Oficina de los cierres heredados**: se desconoce en qué
Oficina estaba la ruta entonces, y deducirlo de la Oficina actual falsearía el
histórico. Esos cierres se muestran con `—`.

## Servicios

`src/lib/settlementPeriods.ts` — módulo **puro** (no importa `@/lib/db`):
`settlementStatus`, `isProtectingClosure`, `protectingClosureFor`, `periodsOverlap`,
`validateClosePeriod`, `closureBlockedReason`, `nextClosureVersion`,
`supersededClosures`, `officeSnapshotOf`, `settlementHistory`, `periodBadge`,
`pendingSettlements`, `closedSettlementCsvRow`.

`src/services/settlementService.ts` — base inyectable (mismo patrón que
`paymentService` / `officeService`):

- `closeSettlement` — permisos con ruta → ruta y empresa → validación del rango →
  **cálculo del motor financiero** → snapshot → escritura atómica. Todas las lecturas
  ocurren **antes** de la transacción, porque el cálculo lee ocho tablas y una
  transacción de Dexie solo puede tocar las que declara.
- `reopenSettlement` — motivo obligatorio (mínimo 10 caracteres), validado **después**
  del permiso para no revelar la existencia del documento a quien no puede tocarlo.
- `listSettlementsForUser` / `listSettlementsOfRoute` — recorte por ruta autorizada.

La pantalla **no entrega importes**: solo ruta, empresa y rango. Las cifras las
produce `generateWeeklySettlement` en el instante del cierre.

## Una sola definición de "período cerrado"

`isPaymentInClosedPeriod` pasó a ser inyectable y a delegar en `protectingClosureFor`.
Antes la condición estaba escrita a mano en ese servicio; ahora vive en el módulo puro
y la aplican por igual la corrección, el historial y la pantalla. Congelado por
`SETTLEMENT-PURE-002`.

Efecto de reabrir: un documento `'reabierta'` deja de proteger, así que los pagos de
esa semana vuelven a ser corregibles directamente hasta que se cierre de nuevo.

## Permisos

Capacidades nuevas `settlement.close` y `settlement.reopen`:

- **Super Admin y Administrador**: sí.
- **Socio, Supervisor, Cobrador, Secretario**: incompatibles de forma explícita.
  El Secretario en particular no puede levantar el cierre que le restringe.
- Ambas están en `ROUTE_SCOPED`: tener el rol no basta; la ruta debe estar
  autorizada. `SETTLEMENT-SCOPE-001` lo demuestra con un Administrador que sí tiene
  el rol pero no la ruta.

## Interfaz

- **Liquidación semanal**: "Generar" sigue siendo una vista previa; **"Cerrar semana"**
  archiva. El botón se deshabilita con el motivo explicado (rango inválido, semana ya
  cerrada, solapamiento). Historial de liquidaciones archivadas con semana, versión,
  **Oficina al cierre**, estado, saldo final, CSV y "Reabrir". Modal de reapertura con
  motivo obligatorio.
- **Detalle de Oficina**: sección compacta "Liquidaciones" con las 6 más recientes de
  las rutas visibles. Sin textos pedagógicos.
- **Dashboard de empresa**: aviso de semanas sin cerrar; se oculta por completo si no
  hay ninguna pendiente.
- La barra de acciones anclada de la Entrega 4 sigue verificada por
  `OFFICE-ACTIONBAR-003..006`: `sticky bottom-0`, sin `fixed`, sin `left-0 right-0`,
  sin desplazamientos del sidebar escritos a mano.

## CSV del cierre

`closedSettlementCsvRow` construye la fila **íntegramente desde el documento
archivado**, incluidos estado, versión, motivo de reapertura y Oficina histórica.
No se recalcula nada: si se recalculara, un pago corregido después del cierre
cambiaría el CSV de una semana ya cerrada y el documento dejaría de probar nada.
Demostrado por `SETTLEMENT-SNAPSHOT-005` y `SMOKE-E5-6`.

## Tests (Entrega 5)

| Suite | Antes | Después |
|---|---|---|
| Permisos | 521 | **538** |
| Financiera | 151 | **151** |
| Arranque | 155 | **155** |
| Liquidaciones (nueva) | — | **40** |
| Migraciones y smoke | 42 | **48** |
| **Total** | **869** | **932 PASS · 0 FAIL** |

Familias nuevas: `SETTLEMENT-PERSIST-*`, `SETTLEMENT-CLOSE-*`, `SETTLEMENT-REOPEN-*`,
`SETTLEMENT-CORRECTION-*`, `SETTLEMENT-SNAPSHOT-*`, `SETTLEMENT-HISTORY-*`,
`SETTLEMENT-SCOPE-*`, `SETTLEMENT-PENDING-*`, `SETTLEMENT-PURE-*`,
`OFFICE-ARCH-003a..e`, `OFFICE-SETTLE-101..112`, y los smoke `SMOKE-E5-1..6`
sobre Dexie real.

`SMOKE-E5-3` es el que demuestra el objetivo de la entrega: el mismo pago,
**no protegido** antes de cerrar y **protegido** después, con el Secretario derivado
a Solicitud de ajuste.

Dos casos de migración (`OFFICE-MIG-001`, `OFFICE-MIG-007`) fijaban la versión de
esquema en `11`. Se actualizaron a una constante `VERSION_ACTUAL`, porque lo que
comprueban es que la base llega al esquema vigente, no que sea la 11.

## Pendientes estructurales

Fuera de alcance por diseño: backend, sincronización remota, PWA/offline robusto y
PDF de Oficina. `npm run lint` no se puede ejecutar en este entorno porque `eslint`
no está instalado (no es una regresión de esta entrega); la verificación estática se
apoya en `tsc --noEmit`, que pasa limpio.
