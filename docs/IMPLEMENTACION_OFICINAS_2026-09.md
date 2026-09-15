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
