# CAMBIOS — Avance de parcelas, columna Parcelas, días como badges y tooltip

Sistema de cobros **RutaCash V1** (local-first, sin backend, sin autenticación real).
Correcciones en App Cobrador (avance de parcelas), Ventas Activas (columna Parcelas),
Detalle de venta (días como badges) y Autorizaciones (tooltip "Ver historial").

Sin backend, sin Supabase, sin tocar GitHub/Vercel, sin commit/push/deploy.
No se cambió lógica contable ni el modelo de dinero entero. No se reintrodujo "Oficinas".

---

## 1. Archivos modificados / creados

| Archivo | Cambio |
|---|---|
| `src/services/installmentEngine.ts` | **Nuevo helper** `getLastPaidInstallmentNumber()` (última parcela pagada, centralizado). |
| `src/components/ui/PaymentDaysBadges.tsx` | **Nuevo componente** de días de pago como badges (reutilizable). |
| `src/pages/collector/CollectorRoutePage.tsx` | Listado: "Parcelas" = última pagada/total. Días de cobro como badges. |
| `src/pages/collector/ClientDetailPage.tsx` | Detalle: "Parcelas" = última pagada/total (antes usaba la próxima pendiente). |
| `src/pages/collector/PaymentPage.tsx` | (Ya correcto) "Pagando parcela N" / "Parcela N registrada" con la parcela a pagar. |
| `src/pages/supervisor/SupervisorRoutePage.tsx` | "Parcelas" = última pagada/total. Días de cobro como badges. |
| `src/pages/admin/ActiveSalesPage.tsx` | Columna **Cuota** solo con el valor; nueva columna **Parcelas**; días de pago como badges en el detalle. |
| `src/pages/admin/SaleAuthorizationsPage.tsx` | Tooltip "Ver historial" recuperado (posición fija); días de pago con el componente compartido. |

---

## 2. Corrección de la lógica visual de parcelas

Se introdujo un **helper central** para evitar interpretaciones distintas por pantalla:

```ts
// Mayor "numero" de parcela completamente pagada (0 si ninguna). Basado en el
// número de parcela, NO en el orden de inserción de Dexie.
getLastPaidInstallmentNumber(installments): number
```

Definición oficial aplicada:

- **Listados / vistas previas** (App Cobrador, Detalle de venta, Supervisor, Ventas Activas):
  muestran **última parcela pagada / total** → `getLastPaidInstallmentNumber` / `numeroCuotas`.
  Ejemplo: con 3 pagadas → **3/24**; tras pagar la 4 → **4/24** (no salta a 5/24).
- **Pantalla de registrar abono** (`PaymentPage`): muestra la **próxima pendiente** a pagar bajo
  el texto **"Pagando parcela N de total"** (usa `calculateCurrentInstallment`, ordenado).
  Ejemplo: **Pagando parcela 4 de 24**.
- **Confirmación** (`PaymentPage`): muestra **"Parcela N de total registrada"** con la parcela
  recién pagada (número capturado al registrar). Ejemplo: **Parcela 4 de 24 registrada**.

Antes, las vistas previas mostraban la **próxima pendiente** (`calculateCurrentInstallment`), lo
que hacía que el listado mostrara 4/24 cuando solo había 3 pagadas. Ahora las previas muestran la
**última pagada**, y solo la pantalla de pago muestra la próxima bajo su etiqueta explícita.

**Casos validados por diseño:**
- 24 parcelas, 3 pagadas → listado/detalle **3/24**; pagar → "Pagando parcela **4** de 24";
  confirmación "Parcela **4** de 24 registrada"; al volver **4/24**.
- 0 pagadas → listado **0/24**; pagar → "Pagando parcela **1** de 24".
- Totalmente pagada → **24/24**; la venta pasa a finalizada y no aparece para cobro.

> Cada venta se calcula con sus propias parcelas, por lo que un cliente con varias ventas activas
> muestra el avance correcto e independiente por venta (el detalle ya carga por `saleId`).

---

## 3. Ventas Activas (Admin) — Cuota y Parcelas separadas

- La columna **Cuota** ahora muestra **solo el valor** de la cuota/parcela (se quitó el subtítulo
  "N cuotas").
- Se agregó una nueva columna **Parcelas** que muestra **última parcela pagada / total**
  (0/24, 4/24, …), calculada con `getLastPaidInstallmentNumber`.
- Orden de columnas: **Cliente | Venta | Saldo | Cuota | Parcelas | Estado | Ruta | Fecha**.
- No se tocaron Venta, Saldo, Estado, Ruta, Fecha ni cálculos contables.
- Para obtenerlo, la página ahora carga las parcelas de las ventas del tenant
  (`installments.where('saleId').anyOf(...)`) y arma un mapa venta → última pagada.

---

## 4. Días de pago como badges

Se creó el componente reutilizable **`PaymentDaysBadges`** (chips redondeados, fondo tenue
`bg-primary-50`, borde suave, texto legible, orden fijo **Lun, Mar, Mié, Jue, Vie, Sáb, Dom**;
si no hay días → "Según frecuencia original").

**Pantallas donde los días de pago pasaron a badges:**
1. **Admin › Ventas Activas › Detalle de venta** (antes texto corrido "Lun, Mar, …").
2. **Admin › Autorizaciones › modal de historial** (unificado al componente compartido; ya eran
   badges tras el ajuste anterior).
3. **App Cobrador › Ruta del cobrador** (tarjeta de cliente, "Días de cobro").
4. **Supervisor › Revisión de ruta** (tarjeta de cliente, "Días de cobro").

No aplica (no muestran días de pago): Ficha de cliente (Admin), Home del cobrador,
Desembolsos. No se tocó la creación de ventas ni el cálculo de parcelas/frecuencia.

---

## 5. Autorizaciones — tooltip "Ver historial" recuperado

**Causa de que no apareciera:** el tooltip anterior era un elemento `absolute` dentro de la
celda; el contenedor de la tabla con `overflow-x-auto` (que computa `overflow-y: auto`) lo
**recortaba**, por lo que no se veía nunca.

**Solución:** tooltip con **posición `fixed`** que sigue al cursor (no lo recorta ningún
contenedor con overflow):
- Estilo RutaCash: fondo blanco, **borde azul** (`border-primary-300`), redondeado, **sombra
  suave**, tipografía de la app, tamaño algo mayor que el genérico (`text-sm`, padding cómodo),
  texto **"Ver historial"**.
- Se muestra con `onMouseMove` sobre la **fila** (cualquier celda clickeable:
  cliente, documento, ruta, valor, fecha…) y se oculta con `onMouseLeave`.
- La **celda de acciones** tiene su propio `onMouseMove` con `stopPropagation` que **oculta** el
  tooltip: así **no aparece** sobre **Aprobar** ni **Rechazar**.
- `pointer-events-none`: no bloquea clics. `zIndex` alto: nunca queda oculto.
- No se usa el `title` genérico del navegador.
- La fila sigue abriendo el historial al hacer clic; Aprobar/Rechazar mantienen `stopPropagation`
  (ejecutan su acción y no abren el historial), con anti doble-clic.

---

## Riesgos detectados

- **"Última parcela pagada" vs pagos parciales:** el helper cuenta parcelas **completamente
  pagadas** (`status pagada` o `pagado>0 && saldo<=0`). Una parcela parcial no cuenta como pagada
  (correcto: aún no se completó). Coincide con el conteo secuencial de abonos.
- **Carga de parcelas en Ventas Activas:** se leen las parcelas de todas las ventas del tenant
  para la columna Parcelas; en bases locales el volumen es pequeño y no afecta el rendimiento.
- **Tooltip con `onMouseMove`:** re-renderiza al mover el cursor sobre la tabla; el costo es
  mínimo para el tamaño de estas tablas.
- **PaymentPage** ya cumplía la especificación (parcela a pagar / confirmación); no se modificó su
  lógica, solo se documenta su comportamiento correcto.

## Qué NO se cambió

- No se tocó backend, Supabase ni autenticación.
- No se cambió la lógica contable (saldo, motor de cuotas/parcelas, aplicación de pagos).
- No se modificaron los flujos de creación de ventas, Aprobar/Rechazar ni la frecuencia de pago.
- No se rompió DEMO, CLEAN, App Cobrador ni Admin.
- No se hizo commit/push/deploy ni se tocó GitHub/Vercel.
- No se reintrodujo "Oficinas".

## Pruebas manuales recomendadas

**App Cobrador — parcelas**
1. Venta de 24 parcelas con 3 abonos: listado del cobrador muestra **3/24**; detalle **3/24**.
2. Entrar a abonar: **"Pagando parcela 4 de 24"** (número destacado).
3. Registrar abono: confirmación **"Parcela 4 de 24 registrada"**.
4. Volver al listado: **4/24** (no 5/24).
5. Cliente con varias ventas activas: cada venta muestra su propio avance correcto.
6. 0 pagadas → listado **0/24**, pago → "Pagando parcela 1 de 24".
7. Venta 24/24 → finalizada, no permite otro abono normal.

**Admin — Ventas Activas**
8. Columna **Cuota** muestra solo el valor (sin "N cuotas" debajo).
9. Columna **Parcelas** muestra última pagada/total (0/24, 4/24, …).

**Admin — Detalle de venta**
10. Los días de pago aparecen como **badges** (no texto corrido).

**Autorizaciones**
11. Hover sobre cliente/documento/ruta/valor/fecha muestra el tooltip **"Ver historial"** con
    estilo RutaCash.
12. Hover sobre **Aprobar** o **Rechazar** **no** muestra el tooltip.
13. Clic en la fila abre el historial; clic en Aprobar/Rechazar ejecuta la acción y no abre el
    historial. Aprobar/Rechazar siguen funcionando (anti doble-clic).
14. En el modal, los días de pago se ven como badges.

**General**
15. `npm run dev:clean` y `npm run dev:demo` funcionan.
16. `npm run build` termina exitoso.
