# CAMBIOS — Revisión 2 del socio (30 de junio)

Sistema de cobros **RutaCash V1** (local-first, sin backend, sin autenticación real).
Documento de referencia: *VERSION 2 Revision cambios 30 Junio de 2026 - Sistema de cobros.docx*.

Todos los cambios se hicieron **sin backend**, **sin Supabase**, **sin tocar GitHub/Vercel**,
manteniendo el dinero en enteros (sin centavos) y sin reintroducir "Oficinas".

---

## 1. Resumen de módulos afectados

| Módulo / archivo | Cambio |
|---|---|
| `src/models/types.ts` | Nuevo tipo `PartnerCashMovement`; campos nuevos en `Transfer` (socioOrigenId, origenType, destinoType); tipos `TransferEntityType`, `PartnerCashType`, `PartnerCashCategory`. |
| `src/lib/db.ts` | Nueva versión **v4** con tabla `partnerCashMovements`. |
| `src/services/partnerCashService.ts` | **Nuevo.** Lógica de Caja socios (socios, resúmenes, crear movimiento). |
| `src/pages/admin/PartnerCashPage.tsx` | **Nuevo.** Módulo visible "Caja socios". |
| `src/pages/admin/ExpenseCategoriesPage.tsx` | **Nuevo.** Módulo "Categorías de gastos" (CRUD). |
| `src/pages/admin/TransfersPage.tsx` | Rediseño agrupado tipo Capital + transferencias Ruta↔Socio + filtros. |
| `src/pages/admin/SaleAuthorizationsPage.tsx` | Botón "Ver historial" + indicadores comparativos + advertencias. |
| `src/pages/admin/UsersPage.tsx` | Badge "Socio" + búsqueda por nombre/email/rol. |
| `src/pages/admin/RoutesPage.tsx` | "Cartera en calle" → "Cartera Activa" + filtro por fecha de creación. |
| `src/pages/admin/DashboardPage.tsx` | "Cartera en calle" → "Cartera Activa". |
| `src/pages/admin/CapitalPage.tsx` | "Cartera en calle" → "Cartera Activa". |
| `src/pages/admin/ExpensesPage.tsx` | Filtro por fecha + solo categorías activas. |
| `src/pages/admin/WithdrawalsPage.tsx` | Filtro por fecha. |
| `src/pages/admin/ActiveSalesPage.tsx` | Columna "Venta" sin interés + parcelas obligatorio. |
| `src/pages/admin/ClientsPage.tsx` | Parcelas obligatorio (crear crédito). |
| `src/pages/collector/CollectorNewSalePage.tsx` | Parcelas obligatorio. |
| `src/pages/collector/CollectorExpensesPage.tsx` | Solo categorías activas. |
| `src/pages/collector/CollectorCashClosePage.tsx` | "Cartera en calle" → "Cartera Activa". |
| `src/components/layout/AdminLayout.tsx` | Nuevos ítems de menú: "Caja socios" y "Categorías de gastos". |
| `src/app/App.tsx` | Nuevas rutas `/admin/partner-cash` y `/admin/expense-categories`. |
| `src/data/seed.ts` | Socios demo + movimientos de Caja socios + transferencia Ruta→Socio. |

---

## 2. Cartera en calle → **Cartera Activa**

Se reemplazó el **texto visible** "Cartera en calle" por **"Cartera Activa"** en:
Dashboard, Rutas, Capital y Cuadre de la App Cobrador.

- **No se cambió la lógica de cálculo.** El campo interno sigue llamándose `carteraEnCalle`
  en el código (`RouteFinancialSummary`), solo cambió la etiqueta mostrada al usuario.
- **Definición visible:** Cartera Activa = valor pendiente por cobrar de ventas
  activas/desembolsadas, incluyendo intereses.
- Se mantienen: **Base actual** = dinero disponible de la ruta; **Total controlado** =
  Base actual + Cartera Activa.

---

## 3. Transferencias Ruta ↔ Socio

El módulo Transferencias ahora permite **origen y destino de tipo Ruta o Socio**:
Ruta→Ruta, Ruta→Socio, Socio→Ruta y Socio→Socio.

**Modelo (`Transfer`)** — compatible con transferencias antiguas:
- `origenType` / `destinoType`: `'route' | 'partner'` (las transferencias viejas sin estos
  campos se interpretan como `'route'`).
- `routeOrigenId` / `routeDestinoId`: se usan cuando la entidad es una **ruta** (el motor de
  caja los indexa; no se tocó `cashboxEngine`).
- `socioOrigenId` / `socioDestinoId`: se usan cuando la entidad es un **socio**.

**Reglas aplicadas:**
- No se permite origen y destino exactamente iguales.
- Si participa una **ruta**, impacta su caja/base como antes (el motor de caja lee
  `routeOrigenId` = salida y `routeDestinoId` = entrada). Una transferencia Ruta→Socio deja
  `routeDestinoId` vacío, por lo que solo **resta** de la ruta origen. Socio→Ruta solo
  **suma** a la ruta destino.
- Si participa un **socio**, se crea automáticamente un movimiento en **Caja socios**
  (ver sección 4), enlazado por `relatedTransferId`.

**Rediseño visual (tipo Capital):** vista agrupada por entidad (Rutas y Socios) con tarjetas
que muestran nombre, tipo (Ruta/Socio), total entrante, total saliente, saldo neto, cantidad
de movimientos y último movimiento, con botón **"Ver movimientos"**.
**Filtros:** búsqueda por nombre, tipo de entidad (Todas / Rutas / Socios) y rango de fecha
Desde/Hasta.

---

## 4. Caja socios (módulo nuevo)

Módulo **separado** de la caja de rutas. Menú Administrador → **Caja socios**
(`/admin/partner-cash`).

**Tabla:** `partnerCashMovements` (Dexie v4). Campos: `id, tenantId, partnerId, type
('ingreso'|'salida'), category, amount, description, relatedTransferId?, fecha, createdAt,
createdBy?`.

Se decidió **crear tabla nueva** (no reutilizar otra) porque el dinero de socios es un
concepto contable distinto al de las rutas y mezclarlo rompería los cálculos de caja/capital.

**Se alimenta de dos formas:**
1. Movimientos creados directamente en Caja socios (ingresos con observación; salidas:
   reembolso, inversión, retiro, envío al exterior, otro).
2. Movimientos generados automáticamente por Transferencias que involucran a un socio
   (categoría `transferencia`, con `relatedTransferId`).

**Vista principal:** una tarjeta por socio con nombre, total ingresos, total salidas,
**saldo socio** (= ingresos − salidas), cantidad de movimientos, último movimiento y botón
**"Ver movimientos"**. Filtro por rango de fecha.

**Detalle por socio:** lista de movimientos con fecha, tipo, categoría, valor, observación e
indicador de origen "desde Transferencias" cuando aplica.

---

## 5. Enlace Socio ↔ Caja socios / Transferencias (Usuarios)

- El rol **"Socio"** ya existía en el modelo; ahora está **conectado**: un usuario con rol
  Socio queda disponible como entidad en **Transferencias** y en **Caja socios**.
- En Usuarios, el socio muestra un **badge "Socio"** y la nota "Caja socios · Transferencias".
- Al crear/editar un Socio **no se piden rutas** (se limpian `routeId` y `authorizedRouteIds`).
- El socio es un **usuario de control interno**: no requiere login operativo y no recibe
  permisos de Admin, Cobrador ni Supervisor.
- Se agregó **búsqueda** por nombre (también email y rol) en la lista de Usuarios.

---

## 6. Ventas Activas — columna Venta sin interés

- La columna **"Venta"** muestra ahora `valorVenta` (el valor real prestado, **sin interés**).
- La columna **"Saldo"** sigue mostrando el pendiente **con interés** (`saldo`).
- El detalle de venta ya mostraba Venta = valor prestado y Total+interés por separado
  (sin cambios).
- Ejemplo: préstamo 1.000.000 al 20% → Venta: 1.000.000 · Saldo inicial: 1.200.000.

---

## 7. N° de parcelas obligatorio visual

Se marcó el campo **"N° de parcelas"** como obligatorio (asterisco `*`) en:
Ventas Activas (Admin), Crear crédito desde Cliente (Admin) y Nueva venta (App Cobrador).
Se mantuvo la validación `> 0` y la posibilidad de vaciar el campo temporalmente mientras
se escribe.

---

## 8. Filtros por fecha y búsqueda

- **Gastos, Retiros, Transferencias:** filtro Desde/Hasta que filtra los movimientos; los
  totales/vistas agrupadas respetan el rango. (En Retiros y Transferencias, "Base actual"
  es un saldo a la fecha y no depende del filtro.)
- **Rutas:** filtro por **fecha de creación** de la ruta ("si aplica"); no afecta los
  cálculos financieros (Base actual / Cartera Activa son saldos a la fecha).
- **Usuarios:** búsqueda por nombre / email / rol.
- Todos muestran estado vacío claro cuando no hay resultados.

---

## 9. Categorías de gastos (módulo)

Menú Administrador → **Categorías de gastos** (`/admin/expense-categories`).
Permite **crear, editar, activar/desactivar** categorías. **No** se pueden eliminar las que
tengan gastos asociados (se bloquea; se pueden desactivar). Evita duplicados por nombre
(comparación normalizada).

Las categorías base ya se siembran (seed / `ensureExpenseCategories`): Transporte,
Alimentación, Papelería, Combustible, Comunicación, Mantenimiento, Otros (en DEMO además:
Gasolina, Aceite, etc.). Los formularios de Gastos (Admin y App Cobrador) ahora muestran
**solo categorías activas**.

---

## 10 y 11. Aprobaciones — Ver historial + Aprobar/Rechazar

En Administrador → **Autorizaciones**:

- Cada fila tiene un botón visible **"Ver historial"** (además de que la fila abre el detalle).
- El modal de detalle muestra (además de los datos del cliente y la solicitud):
  - **Historial de ventas** del cliente (activas / cerradas / perdidas) con valor prestado,
    total a pagar, pagado y saldo.
  - **Indicadores comparativos:** solicitud actual, promedio histórico de valor prestado,
    mayor venta anterior, diferencia vs promedio y diferencia vs mayor.
  - **Advertencias** (reglas simples, sin scoring):
    - Sin historial → "Cliente sin historial previo."
    - Solicitud > **150%** del promedio → advertencia **moderada** (amarilla).
    - Solicitud > **200%** del promedio → advertencia **fuerte** (roja).
    - Solicitud > mayor venta histórica → "Esta solicitud supera la mayor venta anterior
      del cliente."
- **Aprobar / Rechazar desde el mismo modal** (ya existía y se reutiliza):
  - Aprobar → ejecuta `approveSaleRequest`: crea la venta en estado
    `disbursementStatus: 'pendiente'` (aparece en Desembolsos de la App Cobrador). No se
    duplica lógica.
  - Rechazar → pide motivo y ejecuta `rejectSaleRequest`. No crea venta.
  - Los botones se **deshabilitan mientras procesan** (`loading` = `disabled`), evitando la
    doble aprobación por doble clic.

---

## 12. Consistencia de textos

- "Cartera en calle" → "Cartera Activa" (todas las vistas).
- Se usa "Parcelas", "Abonos", "Ventas"; no aparece "Oficinas".

---

## Cálculo de la advertencia de solicitud fuera de lo normal

Sobre el **historial previo** del cliente (ventas distintas de la creada por la propia
solicitud):

```
promedio = Σ valorVenta / nº ventas previas
mayor    = max(valorVenta de ventas previas)
actual   = valor solicitado

sin historial              → "Cliente sin historial previo"
actual > promedio * 2.0    → advertencia FUERTE
actual > promedio * 1.5    → advertencia MODERADA
actual > mayor             → "Supera la mayor venta anterior del cliente"
```

---

## Riesgos detectados

- **Migración Dexie v4:** al abrir la app, IndexedDB migra a la versión 4 (crea
  `partnerCashMovements`). Las bases existentes de usuarios que ya estaban probando
  conservan sus datos; la tabla nueva arranca vacía.
- **Transferencias antiguas:** las Ruta→Ruta previas no tienen `origenType/destinoType`; se
  interpretan como rutas y siguen funcionando en la vista agrupada y en el motor de caja.
- **Base actual en Caja socios:** el saldo del socio es puramente `ingresos − salidas` de
  Caja socios; **no** se mezcla con la caja de rutas (por diseño).
- **Filtro de fecha en Rutas:** filtra por fecha de creación de la ruta; es intencional que
  no altere Base actual / Cartera Activa (saldos a la fecha).

## Qué NO se cambió

- No se implementó backend, Supabase ni autenticación real.
- No se tocó el motor de caja (`cashboxEngine`), ni el de cuotas (`installmentEngine`), ni
  la liquidación semanal.
- No se cambió el modelo de dinero entero (sin centavos).
- No se reintrodujo "Oficinas".
- No se modificó GitHub, Vercel ni se hizo commit/push/deploy.

## Pruebas manuales recomendadas

1. `npm run dev:clean` y `npm run dev:demo` inician sin errores.
2. Rutas / Dashboard / Capital / Cuadre muestran "Cartera Activa".
3. Ventas Activas: columna Venta = valor sin interés; Saldo = con interés.
4. "N° de parcelas" se ve con asterisco en los 3 formularios de venta.
5. Crear usuario tipo **Socio** → aparece con badge "Socio" y disponible en Transferencias y
   Caja socios; no se le piden rutas.
6. Transferencia **Ruta → Socio** → alimenta Caja socios (ingreso del socio) y resta de la
   ruta. **Socio → Ruta** → salida del socio y suma a la ruta.
7. Transferencias: vista agrupada por Rutas/Socios, filtro por fecha y tipo, búsqueda por
   nombre.
8. Caja socios: tarjetas por socio con ingresos/salidas/saldo y "Ver movimientos".
9. Categorías de gastos: crear/editar/activar/desactivar; no permite eliminar con gastos
   asociados. Gastos (Admin y App Cobrador) usan solo categorías activas.
10. Retiros y Gastos filtran por fecha.
11. Usuarios permite búsqueda por nombre.
12. Aprobaciones: botón "Ver historial"; el modal muestra historial + indicadores +
    advertencia si la solicitud supera el histórico; se puede **Aprobar** (genera venta
    pendiente de desembolso → visible en Desembolsos de la App Cobrador) y **Rechazar** con
    motivo (no crea venta).
13. Caja, Capital, Reportes y Liquidación siguen funcionando; no aparece "Oficinas".
14. `npm run build` termina exitoso.
