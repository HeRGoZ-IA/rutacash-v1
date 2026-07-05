# CAMBIOS — Ajustes post-Revisión 2

Sistema de cobros **RutaCash V1** (local-first, sin backend, sin autenticación real).
Correcciones de usabilidad, navegación y reglas de negocio detectadas tras la Revisión 2,
antes de volver a compartir la versión CLEAN.

Sin backend, sin Supabase, sin autenticación real, sin tocar GitHub/Vercel, sin commit/push/deploy.
Dinero en enteros (sin centavos). No se reintrodujo "Oficinas".

---

## 1. Archivos modificados / creados

| Archivo | Cambio |
|---|---|
| `src/components/ui/DateRangeFilter.tsx` | **Nuevo.** Filtro de fechas compacto reutilizable (estilo Reportes). |
| `src/components/ui/ModuleTabs.tsx` | **Nuevo.** Pestañas internas de módulo + constantes `EXPENSE_TABS`, `CASHBOX_TABS`. |
| `src/components/layout/AdminLayout.tsx` | Se quitaron del menú lateral "Categorías de gastos" y "Caja socios". |
| `src/pages/admin/RoutesPage.tsx` | Filtro de fecha compacto. |
| `src/pages/admin/ExpensesPage.tsx` | Filtro compacto (ruta + fechas en una fila) + pestañas Gastos/Categorías. |
| `src/pages/admin/ExpenseCategoriesPage.tsx` | Pestañas Gastos/Categorías (entra por Gastos). |
| `src/pages/admin/WithdrawalsPage.tsx` | Filtro de fecha compacto. |
| `src/pages/admin/TransfersPage.tsx` | Filtros compactos (buscar + tipo + fechas en una fila). |
| `src/pages/admin/CashboxPage.tsx` | Pestañas Caja rutas / Caja socios. |
| `src/pages/admin/PartnerCashPage.tsx` | Pestañas Caja rutas / Caja socios + filtro compacto. |
| `src/pages/admin/SaleAuthorizationsPage.tsx` | Tooltip en fila, acciones rápidas Aprobar/Rechazar, modal más ancho a 2 columnas. |
| `src/pages/collector/CollectorExpensesPage.tsx` | Selector expandible (dropdown) de categorías en vez de grilla de badges. |
| `src/pages/collector/CollectorNewSalePage.tsx` | Límite efectivo de venta directa = mín(límite ruta, límite cobrador). |
| `src/pages/collector/CollectorRoutePage.tsx` | "Ver detalle" envía el `saleId` específico. |
| `src/pages/collector/ClientDetailPage.tsx` | Detalle por venta específica (saleId) + conmutador de ventas activas + orden de parcelas + WhatsApp de la venta seleccionada. |

**El menú lateral no cambió sus URLs**: `/admin/expense-categories` y `/admin/partner-cash`
siguen existiendo; ahora se accede a ellas mediante pestañas dentro de Gastos y Caja.

---

## 2. Filtros de fecha compactos

Se creó `DateRangeFilter`, que replica el estilo compacto de Reportes:
- Una sola fila horizontal en desktop; se apila en mobile con altura reducida (`h-9`).
- Labels cortos **Desde** / **Hasta**, sin campos full-width.
- Botón "Limpiar" pequeño que aparece solo cuando hay filtro activo.
- Admite `children` para anteponer selects propios de cada vista (ruta en Gastos,
  buscar/tipo en Transferencias) dentro de la misma fila.

Aplicado en **Rutas, Gastos, Transferencias, Retiros** (y también en Caja socios).
El comportamiento de filtrado no cambió.

---

## 3. Menú lateral más limpio

- **Categorías de gastos** ya no es entrada principal: ahora es una pestaña dentro de
  **Gastos** (`Gastos` / `Categorías`), vía `ModuleTabs`.
- **Caja socios** ya no es entrada principal: ahora es una pestaña dentro de **Caja**
  (`Caja rutas` / `Caja socios`).
- Las pestañas usan `NavLink` a las URLs existentes (deep-linking intacto), resaltando la
  activa. La navegación principal entra por **Gastos** y por **Caja**.

---

## 4. App Cobrador — selector de categorías de gasto

En el formulario de gasto del cobrador se reemplazó la grilla de badges por un **dropdown**
(`<select>`) que:
- muestra solo **categorías activas**;
- escala bien aunque haya muchas categorías;
- funciona bien en mobile (control nativo);
- mantiene "Otros" si existe como categoría activa.

No se cambió la lógica de registro de gastos (Valor, Descripción y Foto soporte se mantienen).

---

## 5. Aprobaciones — tooltip, acciones rápidas y modal ancho

- **Tooltip / hint:** la fila tiene `title="Ver historial del cliente"` y `cursor-pointer`;
  al hacer clic se abre el historial (comportamiento evidente).
- **Acciones rápidas en la fila** (reemplazan el botón "Ver historial"):
  - Solicitudes **pendientes** → botones **Aprobar** y **Rechazar**.
  - Aprobar desde la fila ejecuta el mismo flujo (`approveSaleRequest`) con **anti doble-clic**
    (estado `rowWorkingId` que deshabilita los botones mientras procesa).
  - Rechazar desde la fila abre el modal directamente en modo "rechazar" para **pedir el
    motivo** (reutiliza `rejectSaleRequest`).
  - Solicitudes no pendientes → botón "Ver".
- **Modal más ancho** (`size="xl"`, `max-w-4xl`) organizado en **2 columnas** en desktop:
  - Izquierda: datos del cliente, fotos y condiciones de la solicitud.
  - Derecha: indicadores comparativos, advertencias e historial de ventas.
  - El motivo de rechazo ocupa el ancho completo debajo.
  - En mobile se apila a una sola columna, ocupando casi todo el ancho sin romperse.
- **Aprobar/Rechazar dentro del modal** se mantienen y comparten los mismos handlers; el flujo
  es idéntico desde fila o desde modal.

---

## 6. Límite efectivo de venta directa (ruta + cobrador)

Antes, un cobrador "sin límite" ignoraba el límite de la ruta. Ahora el monto máximo para
**venta directa** es el **menor** límite aplicable:

```
limiteRuta      = ruta.montoMaximoPrestamo > 0 ? ruta.montoMaximoPrestamo : sin límite
limiteCobrador  = cobrador.maxDirectSaleAmount > 0 ? cobrador.maxDirectSaleAmount : sin límite
limiteEfectivo  = mínimo(limiteRuta, limiteCobrador)
```

Reglas:
- Cobrador sin límite pero ruta con límite → **gobierna la ruta**.
- Ruta sin límite pero cobrador con límite → **gobierna el cobrador**.
- Ambos con límite → **gobierna el menor**.
- Ambos sin límite → **sin límite directo**.
- Si el valor supera el límite efectivo, **no** se crea venta directa: se genera **solicitud**
  para aprobación, con el mensaje:
  *"Esta venta supera el límite aprobado para venta directa. Se enviará como solicitud para aprobación."*
- Se muestran los tres valores: **Límite ruta**, **Límite cobrador** y **Efectivo aplicado**.

Se mantiene además la validación de **capital disponible** de la ruta (independiente del límite).
No se eliminaron los campos de límite de ruta ni de cobrador; trabajan juntos.
La condición `canCreateDirectSales` (si el cobrador puede o no crear ventas directas) se respeta
tal cual: si está desactivada, toda venta va a solicitud.

> Nota: el flujo del **Admin** (Ventas Activas, crear crédito desde Cliente) no es "venta directa
> del cobrador"; sigue validando capital disponible como antes y no se tocó.

---

## 7. App Cobrador — orden de parcelas recientes

En el detalle de venta, "Parcelas recientes" ya no sale en orden aleatorio de inserción.
Se ordena de forma consistente:
1. **Pendientes vencidas** (saldo > 0 y vencimiento < hoy) — ascendente por fecha.
2. **Pendientes próximas** (saldo > 0 y vencimiento ≥ hoy) — ascendente por fecha.
3. **Pagadas** — descendente por fecha (más recientes primero).

Se mantiene visible el número de parcela (`#n`).

---

## 8. App Cobrador — detalle por venta específica (crítico)

Cuando un cliente tiene varias ventas activas, "Ver detalle" ahora abre **la venta exacta
seleccionada**, no la más reciente:

- `CollectorRoutePage` navega con el `saleId`: `/collector/client/:id?saleId=<ventaId>`.
- `ClientDetailPage` lee `saleId` de la URL y muestra **esa** venta (fallback: primera activa,
  luego la más reciente). Todo lo del detalle usa la venta seleccionada:
  - saldo, parcela, progreso y parcelas de **esa** venta;
  - **Registrar abono** navega a `/collector/payment/<saleId>` de esa venta;
  - **WhatsApp** arma el mensaje con el saldo/parcela de esa venta.
- Si el cliente tiene **más de una venta activa**, se muestra un **conmutador** de chips
  ("Venta 1 · $…", "Venta 2 · $…") para alternar entre ellas dentro del detalle.
- El registro de abono ya apuntaba al `saleId` correcto (`PaymentPage` carga por id), por lo
  que abonar en A afecta A y abonar en B afecta B.

---

## Riesgos detectados

- **Pestañas de módulo:** al entrar por el menú "Gastos"/"Caja", la sub-pestaña activa se
  resalta según la URL. Si se navega directo a `/admin/expense-categories` o
  `/admin/partner-cash`, las pestañas siguen visibles y coherentes.
- **Límite efectivo:** se asume que `montoMaximoPrestamo = 0` en una ruta significa "sin
  límite". Las rutas creadas por defecto traen 500.000; si el socio quisiera que 0 signifique
  "no vender", habría que ajustar esa convención (documentado aquí).
- **saleId en detalle:** enlaces antiguos a `/collector/client/:id` sin `saleId` siguen
  funcionando (fallback a primera activa / más reciente).
- El bundle sigue siendo un único chunk grande (warning preexistente de tamaño), sin impacto
  funcional.

## Qué NO se cambió

- No se implementó backend, Supabase ni autenticación real.
- No se rediseñó toda la app ni se hizo refactor general.
- No se tocó el motor de caja, el de cuotas/parcelas, ni la liquidación.
- No se cambió el modelo de dinero entero (sin centavos).
- No se rompió DEMO, CLEAN, App Cobrador ni Admin.
- No se modificó GitHub, Vercel ni se hizo commit/push/deploy.
- No se reintrodujo "Oficinas" ni el vocabulario prohibido.

## Pruebas manuales recomendadas

**Admin**
1. `npm run dev:clean` y `npm run dev:demo` inician sin errores.
2. Rutas / Gastos / Transferencias / Retiros muestran filtros de fecha compactos en una fila.
3. El menú lateral ya no muestra "Categorías de gastos" ni "Caja socios".
4. Gastos tiene pestañas Gastos / Categorías; Categorías se administra ahí.
5. Caja tiene pestañas Caja rutas / Caja socios; Caja socios funciona desde ahí.
6. Gastos Admin usa solo categorías activas. Usuarios y Rutas siguen funcionando.

**Aprobaciones**
7. La fila muestra tooltip "Ver historial del cliente"; clic en fila abre el historial.
8. En solicitudes pendientes aparecen **Aprobar** y **Rechazar** al final de la fila.
9. Aprobar desde la fila funciona (sin ventas duplicadas por doble clic).
10. Rechazar desde la fila abre el modal pidiendo motivo.
11. El modal de historial es más ancho y se organiza en dos columnas en desktop.
12. Aprobar/Rechazar desde el modal funcionan igual.

**Límites**
13. Ruta 1.000.000 + cobrador sin límite: venta 900.000 permite directa (si cumple lo demás);
    venta 1.500.000 va a solicitud.
14. Ruta 1.000.000 + cobrador 500.000: venta 700.000 va a solicitud.
15. Ruta sin límite + cobrador 500.000: venta 700.000 va a solicitud.
16. Ruta sin límite + cobrador sin límite: venta directa permitida (si cumple lo demás).

**App Cobrador**
17. Registrar gasto muestra un selector expandible (dropdown), no badges masivos; categorías
    activas aparecen y crear gasto funciona.
18. Detalle de venta muestra parcelas ordenadas (vencidas → próximas → pagadas).
19. Cliente con varias ventas activas: "Ver detalle" de cada venta abre la venta correcta;
    registrar abono afecta la venta correcta; WhatsApp toma la venta correcta; el conmutador
    permite alternar entre ventas activas.
20. `npm run build` termina exitoso.
