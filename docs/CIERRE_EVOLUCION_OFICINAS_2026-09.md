# Cierre de la evolución "Oficinas" — RutaCash

**Septiembre de 2026 · documento interno de ingeniería**

Resume las cinco evoluciones que introdujeron la Oficina en RutaCash, desde la
auditoría inicial hasta el cierre de período persistente. Es el punto de referencia
para quien retome el trabajo: qué se decidió, por qué, qué lo demuestra y qué queda
fuera.

---

## 1. La decisión que sostiene todo

> **La Oficina organiza. La Ruta controla el acceso.**

Ninguna evolución puede romper esto, y cada una añadió pruebas de contrato que lo
congelan leyendo el código fuente de producción.

| Invariante | Dónde se verifica |
|---|---|
| `User` no tiene `officeId` ni `officeIds` | `OFFICE-USER-002`, `OFFICE-USER-002b` |
| `authorizedRouteIds` es la **única** fuente de acceso | `OFFICE-ARCH-002` |
| Tener una ruta de una Oficina **no** concede sus rutas hermanas | `OFFICE-SCOPE-*`, `SMOKE-E4-1`, `SETTLEMENT-SCOPE-002` |
| `Route.officeId` es el **único** `officeId` operativo persistido | `OFFICE-ARCH-001c`, `OFFICE-ARCH-003a` |
| Clientes, ventas, pagos, cuotas, gastos, capital, transferencias, retiros y solicitudes **no** persisten `officeId` | `OFFICE-ARCH-001`, `OFFICE-ARCH-001b`, `OFFICE-ARCH-001c` |
| La Oficina se **deriva** siempre de la Ruta | `OFFICE-DERIVE-*` |
| `permissions.ts` no es un sistema de permisos por Oficina | `OFFICE-ARCH-002b` |

**Única excepción, introducida en la Evolución 5**: el snapshot histórico de Oficina
dentro de un `WeeklySettlement` cerrado (`officeIdAtClose`, `officeNameAtClose`,
`officeCodeAtClose`). Es metadata de un documento de cierre, nunca una fuente de
alcance. Acotada por `OFFICE-ARCH-003a..e`.

---

## 2. Las cinco evoluciones

### Evolución 0 — Auditoría de solo lectura

Sin cambios de código. Dejó cerradas las decisiones de diseño: rutas existentes →
"Sin Oficina"; Oficina opcional al crear ruta; una Oficina puede existir sin rutas;
una ruta puede existir sin Oficina; los usuarios trabajan entre Oficinas; el acceso
a una Oficina **no** concede rutas hermanas.

Dejó una pregunta explícitamente sin responder: *¿se puede recrear en Dexie una tabla
que una versión anterior borró con `offices: null`?* La Evolución 1 la respondió
ejecutándola.

### Evolución 1 — Modelo, migración y CRUD · `e12769a`

Saneamiento del `officeId` legado, entidad `Office`, Dexie **v11**, servicio
`officeService` con base inyectable, y el catálogo de Oficinas.

**Lo que se aprendió**: la v11 sí recrea la tabla borrada en v3. Se verificó
ejecutando una migración v1 → v11 completa con **Dexie real sobre `fake-indexeddb`**
(`OFFICE-MIG-001`), no razonando sobre la documentación. De ahí nació la suite de
migraciones.

### Evolución 2 — Panel de gestión de la Oficina · `bc15fe0`

`OfficeDetailPage` con KPIs, rutas, usuarios relacionados, asignaciones y alertas.

**Riesgo evitado**: editar las asignaciones de un usuario desde una Oficina no puede
borrarle las rutas que tiene en otras. Resuelto con `applyOfficeRouteSelection`, que
solo toca las rutas del ámbito visible.

### Evolución 2b — Administradores por ruta · `fa67162`

Corrección de una advertencia falsa de "ruta sin Administrador". La causa:
`draftAdmins` salía de `form.assignedUserIds`, siempre vacío para un actor
Administrador porque `MANAGEABLE_ROLES.admin` excluye `'admin'`. Resuelto con
`effectiveAdminIdsAfterSave`; la lógica anterior quedó congelada como regresión
`ROUTE-ADMIN-REG-001`.

Reglas formalizadas: varias Admins por empresa y por ruta; un Admin nuevo no hereda
rutas; un Super Admin que crea una ruta no asigna a todas las Admins; una ruta sin
Administrador sigue siendo válida.

### Evolución 3 — Integración transversal Oficina → Ruta · `3b9f412`

Filtro Oficina → Ruta unificado (`useOfficeRouteFilter` + `OfficeRouteFilterBar`) en
Clientes, Ventas, Caja, Gastos, Capital, Retiros, Transferencias, Reportes,
Liquidación y Rutas. Contexto por query param `?officeId=`, validado contra el
catálogo: un id ajeno o inventado se ignora y cae a "todas las oficinas".

El filtro **solo estrecha** lo ya autorizado. Nunca amplía.

### Evolución 4 — La Oficina como unidad operativa · `d7ebe50`

KPIs operativos, desglose por ruta, caja consolidada, cartera y alertas avanzadas.

**Semántica de "A cobrar hoy"** — se validó en vez de asumirla. Usar el `saldo` de
las cuotas hacía que cobrar encogiera la meta (60 de 100 → 60/40 → 100 %). Al revisar
`quickAmounts().parcela` y `applyPaymentToInstallments` se confirmó que la semántica
establecida del sistema es por saldo. Definición final, documentada en
`officeOperations.ts`:

```
pendienteHoy = Σ saldo ACTUAL de las cuotas que vencen hoy
recaudadoHoy = Σ pagos vigentes con fecha de hoy
aCobrarHoy   = pendienteHoy + recaudadoHoy     ← meta al empezar la jornada
cumplimiento = recaudadoHoy / aCobrarHoy
```

### Evolución 4b — Vista ejecutiva y roles · `c8c8b37`

Dashboard de empresa con Oficinas, comparativo objetivo (sin ranking), actividad
reciente desde auditoría, exportaciones CSV e integración de Supervisor, Secretario
y Socio.

**Corrección de UI**: la barra de acciones invadía el sidebar. Estaba en
`fixed bottom-0 left-0 right-0` (anclada al viewport). Se resolvió con
`sticky bottom-0 z-20 -mx-4 md:-mx-6` dentro del `<main className="flex-1
overflow-y-auto">` del layout — estructural, sin `left: 200px` ni `calc()` ni anchos
del sidebar escritos a mano. Congelado por `OFFICE-ACTIONBAR-003..006`.

### Evolución 5 — Liquidaciones persistentes y cierre de período

La investigación previa cambió el alcance: **casi toda la protección de períodos
cerrados ya estaba escrita**. `isPaymentInClosedPeriod` ya existía y ya usaba
`payment.fecha` (fecha contable). La cadena de Solicitud de ajuste estaba completa,
con su tabla Dexie, sus pantallas y sus permisos.

Faltaba **una sola pieza**: nadie llamaba a `db.weeklySettlements.add`. La
liquidación se calculaba en estado de React y se descartaba, así que ningún período
estaba cerrado nunca y toda la cadena permanecía dormida.

Lo entregado: `settlementPeriods.ts` (puro), `settlementService.ts` (inyectable),
Dexie **v12** aditiva, versionado de cierres, snapshot histórico de Oficina,
capacidades `settlement.close` / `settlement.reopen`, historial en pantalla, CSV
desde el documento archivado y aviso de semanas pendientes.

---

## 3. Patrón de arquitectura que quedó establecido

Cada evolución repitió la misma forma, y conviene mantenerla:

1. **Módulo puro** en `src/lib/*.ts` que **no importa `@/lib/db`**. Recibe filas ya
   recortadas por alcance y decide sobre ellas. Se prueba sin IndexedDB.
2. **Servicio con base inyectable**: `fn(params, database = db, auditSink = logAction)`.
   Valida permisos **con la ruta**, no solo con el rol.
3. **UI delgada** que no toma decisiones de negocio ni entrega cifras a los servicios.
4. **Pruebas de contrato** que leen el código fuente de producción para afirmar reglas
   estructurales (que un módulo no importe la base, que una entidad no declare un
   campo, que un servicio recorte por ruta).

---

## 4. El error que más enseñó

`WRITE_FAILED` en **todos** los pagos del Cobrador. La causa era invisible: el
servicio leía `database.users` dentro de una transacción que no declaraba esa tabla.
Dexie lanza `NotFoundError: Table X not part of transaction` y el error quedaba
tragado por un `catch` genérico.

El harness de pruebas replicaba toda la superficie de Dexie **menos esa regla**, así
que el fallo pasaba los tests y reventaba en el navegador. Se endureció el harness
(`assertTableInTransaction`), lo que convirtió un fallo de producción invisible en un
test rojo reproducible, y ahora **esa clase entera de defecto queda vigilada**.

Corolario aplicado en la Evolución 5: en `closeSettlement` todas las lecturas
(incluido el cálculo financiero, que toca ocho tablas) ocurren **antes** de abrir la
transacción, que solo declara `weeklySettlements`.

---

## 5. Estado de las pruebas

| Suite | Casos | Qué cubre |
|---|---|---|
| Permisos | 538 | roles, alcance, contratos estructurales leídos del código fuente |
| Financiera | 151 | motor de pagos, atomicidad, inyección de fallos |
| Arranque | 155 | instalación limpia desde cero |
| Liquidaciones | 40 | cierre, reapertura, versionado, snapshot, protección |
| Migraciones y smoke | 48 | Dexie **real** sobre `fake-indexeddb` + recorridos completos |
| **Total** | **932 PASS · 0 FAIL** | |

Los smoke no son pruebas unitarias: son los recorridos que haría una persona,
ejecutados de extremo a extremo con la base real y los servicios reales. Si alguno
cae, la funcionalidad no sirve por muy verdes que estén las unitarias.

`SMOKE-E5-3` es el caso que resume la Evolución 5: el mismo pago, **no protegido**
antes de cerrar la semana y **protegido** después, con el Secretario derivado a
Solicitud de ajuste.

---

## 6. Pendientes

**Fuera de alcance por diseño** (no son deuda; son el siguiente proyecto):

- Backend y sincronización remota. Hoy todo vive en IndexedDB en el dispositivo.
- PWA / offline robusto más allá de lo que da IndexedDB.
- PDF de Oficina y PDF de liquidación.
- Cierre consolidado por Oficina. **Deliberadamente no existe**: cada ruta es una
  caja independiente y una liquidación consolidada mezclaría cajas distintas.

**Deuda menor real**:

- `npm run lint` no se puede ejecutar: `eslint` no está instalado en el entorno. La
  verificación estática se apoya en `tsc --noEmit`, que pasa limpio. No es una
  regresión de ninguna evolución de Oficinas.
- Los cierres heredados de antes de la v12 no tienen snapshot de Oficina y se
  muestran con `—`. Es deliberado: deducirlo de la Oficina actual falsearía el
  histórico.

---

## 7. Commits

| Commit | Evolución |
|---|---|
| `64ca468` | creación de rutas sin asignaciones obligatorias |
| `e3e08f2` | incidente de registro de pagos del Cobrador |
| `e12769a` | Oficinas: modelo, migración v11 y CRUD |
| `bc15fe0` | panel de gestión de la Oficina |
| `fa67162` | administradores por ruta (multi-Admin) |
| `3b9f412` | integración transversal Oficina → Ruta |
| `d7ebe50` | la Oficina como unidad operativa |
| `c8c8b37` | vista ejecutiva e integración de roles |
| *(esta entrega)* | liquidaciones persistentes y cierre de período |
