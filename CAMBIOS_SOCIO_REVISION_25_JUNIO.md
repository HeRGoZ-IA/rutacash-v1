# Cambios — Revisión del socio (25 de junio)

Versión: RutaCash V1 CLEAN (desarrollo local).
Modelo vigente: **Empresa → Rutas → Clientes → Ventas → Parcelas / Abonos**.
No se usa "Oficinas" en la interfaz.

Estos ajustes son **solo de aplicación local** para que el socio pueda verificar
mejor la versión CLEAN. No se tocó GitHub, Vercel, Supabase, backend ni
autenticación real. El modelo de dinero sigue siendo entero (sin centavos).

---

## 1. Métricas por ruta: Base actual vs Cartera en calle

Se creó un helper reutilizable para que todas las pantallas calculen igual y no
haya cifras distintas por vista.

**Archivo:** `src/services/cashboxEngine.ts`
**Tipo:** `src/models/types.ts` → `RouteFinancialSummary`

```ts
getRouteFinancialSummary(routeId): Promise<RouteFinancialSummary>
getRoutesFinancialSummary(routeIds): Promise<Record<string, RouteFinancialSummary>>
```

Devuelve por ruta:

- `baseActual`
- `carteraEnCalle`
- `totalControlado`
- `ventasActivas`
- `clientesActivos`
- `interesPorCobrarEstimado`

### Cómo se calcula **Base actual**

Es el dinero disponible **real** de la ruta (saldo de caja). Reusa la lógica ya
existente del motor de caja (`getRouteAvailableCapital` → `getCashboxSummary`):

```
Base actual =
    capital inyectado
  + abonos cobrados
  + transferencias recibidas
  - ventas/desembolsos entregados
  - gastos
  - retiros
  - transferencias enviadas
```

> Las ventas aprobadas pero **pendientes de desembolso** NO restan caja todavía
> (no se ha entregado el dinero).

### Cómo se calcula **Cartera en calle**

Es lo prestado en la calle pendiente por cobrar (capital + interés), tomando el
**saldo** de las ventas **activas y ya desembolsadas**:

```
Cartera en calle = Σ saldo de ventas (status = 'activa' Y desembolsadas)
```

- NO incluye ventas pendientes de desembolso.
- NO incluye solicitudes no aprobadas.
- NO incluye ventas perdidas/cerradas (saldo 0).

### Total controlado

```
Total controlado = Base actual + Cartera en calle
```

### Interés por cobrar (ESTIMADO)

Se calcula de forma proporcional al saldo de cada venta:

```
interesPorCobrarEstimado = Σ ( saldo × valorInteres / valorTotal )
```

> Es una **estimación**, no un desglose exacto capital/interés cuota por cuota.
> Por seguridad **no se muestra como cifra principal** en las pantallas; queda
> disponible en el helper y documentado como pendiente de definición exacta para
> V2 (cuando el socio confirme el desglose deseado). En las pantallas solo se
> muestran **Base actual**, **Cartera en calle** y **Total controlado**.

---

## 2. Dónde se muestran Base actual y Cartera en calle

| Pantalla | Archivo | Qué muestra |
|---|---|---|
| Dashboard Administrador | `src/pages/admin/DashboardPage.tsx` | KPIs: **Base actual** (total), **Cartera en calle** (total), **Total controlado**, + clientes activos, ventas, etc. |
| Módulo Rutas | `src/pages/admin/RoutesPage.tsx` | Por ruta: Base actual, Cartera en calle, Total controlado, Ventas activas, Clientes activos |
| Módulo Capital | `src/pages/admin/CapitalPage.tsx` | Por ruta (tarjeta): Base actual, Cartera en calle, Total controlado, Total inyectado, Total retirado |
| App Cobrador / Cuadre | `src/pages/collector/CollectorCashClosePage.tsx` | Base actual y Cartera en calle de la ruta, + abonos hoy, gastos hoy, saldo esperado |

Se ajustaron los KPIs existentes para no saturar (p. ej. en Dashboard "Capital
total" → "Base actual" y "Cartera activa" → "Cartera en calle").

---

## 3. Retiros agrupados por ruta

**Archivo:** `src/pages/admin/WithdrawalsPage.tsx` (presentación similar a Capital).

- Antes: un solo listado con todos los retiros de todas las rutas + un total
  general arriba.
- Ahora: **una tarjeta por ruta** con:
  - Nombre y código de ruta
  - Total retirado
  - Cantidad de retiros
  - Último retiro
  - **Base actual** de la ruta
  - Botón **"Ver retiros"** → detalle de esa ruta
- El detalle de una ruta lista: fecha, valor, descripción/motivo y usuario.
- Retiros sin `routeId` (o de rutas ya eliminadas) se agrupan en **"Sin ruta"**.
- Se quitó el KPI superior de "total de todas las rutas" (el socio no lo veía
  necesario).
- **No se cambió la lógica contable de retiros**, solo la presentación.

---

## 4. Ventas Activas — clientes filtrados por ruta

**Archivo:** `src/pages/admin/ActiveSalesPage.tsx`

- En el formulario de **Nueva venta** ahora aparece **primero la Ruta** y luego el
  **Cliente**.
- El selector de Cliente muestra **solo los clientes de la ruta seleccionada**.
- Si se cambia la ruta y el cliente ya no pertenece a la nueva ruta, **se limpia
  el cliente** automáticamente.
- Si la ruta no tiene clientes: mensaje **"No hay clientes registrados en esta
  ruta."**
- Al guardar se valida que el cliente **pertenezca** a la ruta; si no, no guarda.
- Se mantiene el flujo de crear cliente + venta desde Clientes y desde App
  Cobrador (el cliente nace ya asociado a su ruta).

---

## 5. Cantidad de parcelas (input)

**Archivos:** `ActiveSalesPage.tsx`, `ClientsPage.tsx`,
`collector/CollectorNewSalePage.tsx`, `collector/CollectorNewClientPage.tsx`.

- El campo "N° de parcelas" ahora **se puede vaciar** mientras se escribe (ya no
  queda un `0` pegado que no se deja borrar). Internamente, vacío = 0 temporal.
- Al guardar se valida que sea **> 0**; si está vacío o en 0 muestra:
  **"La cantidad de parcelas debe ser mayor a 0."**
- Se etiquetó el campo como **"N° de parcelas"** en el panel admin para
  consistencia con el vocabulario del socio.

---

## 6. Documento duplicado

Ya existía validación global; se revisó y se ajustaron los textos al modelo
actual (empresa, no oficina).

**Archivos:** `src/pages/admin/ClientsPage.tsx`,
`src/pages/collector/CollectorNewClientPage.tsx`,
helper `normalizeDoc` en `src/lib/formatters.ts`.

- Normaliza el documento: quita espacios, puntos y guiones y pasa a minúsculas.
- Bloquea duplicados dentro de la **misma empresa/tenant** (sin importar ruta).
- Aplica en **Administrador** y en **App Cobrador**.
- Mensaje visible: **"Este documento ya está registrado en esta empresa."**
- Se muestra además el **nombre del cliente** y la **ruta** donde ya está
  registrado.
- Se usa el helper existente; no se duplicó lógica.

---

## 7. Alerta por segunda venta activa del mismo cliente

**Helper nuevo:** `findActiveSaleForClient(clientId)` en
`src/services/saleRequestService.ts` (venta activa = `status 'activa'`,
desembolsada o pendiente de desembolso).

**Archivos:** `ActiveSalesPage.tsx` (admin) y `collector/CollectorNewSalePage.tsx`.

- Al **seleccionar** un cliente que ya tiene una venta activa, aparece una alerta
  visible: **"Este cliente ya tiene una venta activa."** con resumen: valor de la
  venta, saldo pendiente, fecha de inicio y ruta.
- Al **guardar**, se pide confirmación: **"¿Deseas crear otra venta para este
  cliente?"**
  - Si confirma → se crea la venta.
  - Si cancela → no se guarda.
- No se bloquea (algunos negocios permiten más de una venta): es **alerta fuerte +
  confirmación**, como pidió el socio.
- En los flujos de **Nuevo cliente** (admin y cobrador) la alerta no aplica porque
  el cliente es nuevo y no puede tener una venta activa previa.

---

## 8. Gastos — categorías

**Archivos:** `src/data/seed.ts`, `src/app/App.tsx`.

- CLEAN ya siembra categorías predeterminadas al iniciar y tras reset:
  **Transporte, Alimentación, Papelería, Combustible, Comunicación,
  Mantenimiento, Otros**.
- DEMO ya trae sus categorías (Gasolina, Aceite, Despinchada, Comisión, Pago
  policía, Transporte, Otro).
- **Refuerzo (seguro anti-vacío):** se agregó `ensureExpenseCategories()`, que al
  iniciar la app verifica cada empresa y, si no tiene categorías, siembra las base
  **sin duplicar**. Así el selector de categorías nunca aparece vacío si la app
  fue inicializada correctamente.
- El selector de gastos del cobrador ya mostraba aviso cuando no hay categorías;
  con el seguro anterior esto no debería ocurrir.
- No existe aún CRUD de categorías de gasto en la UI: **queda documentado como
  pendiente**, pero las categorías base siempre están disponibles.

---

## 9. Limpieza de textos / consistencia

- No aparece "Oficina" en la interfaz. Se corrigió el único texto visible
  pendiente en **Liquidación** ("Selecciona una **ruta**…").
- Menú admin usa: Rutas, Clientes, **Ventas Activas**, Capital, Gastos,
  Transferencias, **Retiros**, Caja, Reportes, Liquidación.
- Encabezado de la pantalla de ventas: **"Ventas activas"** (antes "Ventas /
  Créditos"). Modal: **"Nueva venta"**.
- App Cobrador mantiene **Parcelas**, **Abonos**, **Cuadre**, **Desembolsos**.
- Términos visibles **"Base actual"** y **"Cartera en calle"** en las pantallas
  indicadas.

---

## Archivos modificados

- `src/models/types.ts` — tipo `RouteFinancialSummary`.
- `src/services/cashboxEngine.ts` — `getRouteFinancialSummary`, `getRoutesFinancialSummary`.
- `src/services/saleRequestService.ts` — `findActiveSaleForClient`.
- `src/pages/admin/DashboardPage.tsx` — KPIs Base actual / Cartera en calle / Total controlado.
- `src/pages/admin/RoutesPage.tsx` — métricas por ruta.
- `src/pages/admin/CapitalPage.tsx` — Base actual + Cartera en calle + Total controlado por ruta.
- `src/pages/admin/WithdrawalsPage.tsx` — retiros agrupados por ruta + detalle.
- `src/pages/admin/ActiveSalesPage.tsx` — filtro de clientes por ruta, alerta 2.ª venta, input parcelas, textos.
- `src/pages/admin/ClientsPage.tsx` — input parcelas, textos de documento duplicado.
- `src/pages/admin/WeeklySettlementPage.tsx` — texto "ruta" en lugar de "oficina".
- `src/pages/collector/CollectorNewSalePage.tsx` — alerta 2.ª venta + input parcelas.
- `src/pages/collector/CollectorNewClientPage.tsx` — input parcelas + textos de documento duplicado.
- `src/pages/collector/CollectorCashClosePage.tsx` — Base actual + Cartera en calle de la ruta.
- `src/data/seed.ts` — `ensureExpenseCategories` (seguro de categorías).
- `src/app/App.tsx` — llama `ensureExpenseCategories` tras el seed.

---

## Riesgos detectados

- **Interés por cobrar** es una estimación proporcional. No debe usarse como cifra
  contable exacta hasta definir el desglose real (V2). Por eso no se muestra como
  número principal.
- `getRouteFinancialSummary` recorre ventas por ruta en cada carga (Dashboard,
  Rutas, Capital, Cuadre). Con el volumen actual (datos locales) es instantáneo;
  con muchas rutas/ventas podría optimizarse a futuro.
- "Cartera en calle" depende de que el `saldo` de cada venta esté correcto (lo
  mantiene el motor de cuotas existente, no se modificó).
- Si un retiro/movimiento quedó sin `routeId`, aparece en el grupo **"Sin ruta"**
  (esperado y documentado).

---

## Qué NO se cambió

- No se implementó backend, Supabase ni autenticación real.
- No se reintrodujo "Oficinas".
- No se modificó la lógica contable de caja, retiros, parcelas, abonos,
  liquidación, reportes ni capital.
- No se cambió el modelo de dinero entero (sin centavos).
- No se hizo refactor general innecesario.
- No se tocó GitHub, no hubo commit/push ni deploy en Vercel.

---

## Pruebas manuales recomendadas

1. `npm run dev:clean` y `npm run dev:demo` arrancan correctamente.
2. **Dashboard** muestra Base actual, Cartera en calle y Total controlado.
3. **Rutas** muestra Base actual, Cartera en calle y Total controlado por ruta.
4. **Capital** muestra Base actual y Cartera en calle por ruta.
5. **App Cobrador / Cuadre** muestra Base actual y Cartera en calle de la ruta.
6. **Retiros** se agrupa por ruta y se entra al detalle de cada ruta.
7. En **Ventas Activas**, al seleccionar ruta los clientes se filtran por esa ruta.
8. Al cambiar de ruta se limpia el cliente incompatible; no deja crear venta con
   cliente de otra ruta.
9. **Cantidad de parcelas** permite borrar el 0 y escribir; si queda vacío/0 no
   guarda y muestra el mensaje.
10. **Documento duplicado** se bloquea en Administrador y Cobrador; el mensaje dice
    "empresa", no "oficina".
11. Al seleccionar un cliente con venta activa aparece la **alerta**; si se cancela
    la confirmación no se crea, si se confirma sí.
12. **Gastos** en CLEAN y DEMO muestran categorías predeterminadas.
13. No aparece "Oficinas". Admin, App Cobrador, Caja, Reportes y Liquidación
    siguen funcionando.
14. `npm run build` finaliza sin errores.
