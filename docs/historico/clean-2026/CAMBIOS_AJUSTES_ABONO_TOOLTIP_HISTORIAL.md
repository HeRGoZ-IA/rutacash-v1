# CAMBIOS — Ajustes de abono, tooltip e historial

Sistema de cobros **RutaCash V1** (local-first, sin backend, sin autenticación real).
Ajustes finos en la App Cobrador (número de parcela al abonar) y en Aprobaciones del
Administrador (tooltip y ventana de historial del cliente).

Sin backend, sin Supabase, sin tocar GitHub/Vercel, sin commit/push/deploy.
No se cambió lógica contable ni el modelo de dinero entero. No se reintrodujo "Oficinas".

---

## 1. Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/pages/collector/PaymentPage.tsx` | Número de parcela consistente y destacado al registrar abono. |
| `src/pages/admin/SaleAuthorizationsPage.tsx` | Tooltip propio "Ver historial", días de pago como badges, scroll interno en la columna derecha del modal. |

---

## 2. App Cobrador — visualización del número de parcela al abonar

**Causa del error:** la pantalla de abono calculaba la parcela con
`installments.find(i => i.status !== 'pagada')` sobre un arreglo **sin ordenar**
(Dexie devuelve por id/uuid), por lo que mostraba una parcela **aleatoria** (p. ej. 19/24),
que parecía "parcelas restantes". El listado de ruta y el detalle del cliente sí usan
`calculateCurrentInstallment` (ordenado), de ahí la inconsistencia.

**Corrección (`PaymentPage.tsx`):**
- Se reemplazó el `find` sin orden por **`calculateCurrentInstallment(installments)`**
  (misma función que usa la ruta y el detalle → **consistencia entre las tres pantallas**).
- **Antes de guardar:** se muestra claramente la parcela que se va a pagar, con el número
  **destacado** (color primario) y una etiqueta tipo **"Pagando parcela N de total"**.
- **Al registrar el abono:** se **captura** el número de la parcela pagada (`paidNumber`)
  antes de aplicar el pago.
- **Después de guardar (confirmación):** se sigue mostrando **la misma parcela** recién
  registrada (no salta a la siguiente), con la etiqueta **"Parcela N de total registrada"**.
  La tarjeta superior también usa ese número en la confirmación.
- **WhatsApp:** el recibo usa la parcela recién pagada (o la actual pendiente), en orden
  correcto, en vez del primer elemento de un arreglo sin ordenar.

No se tocó el cálculo de saldo, el progreso, el total de parcelas ni el registro del abono
(`applyPaymentToInstallments` / `calculateSaleBalance` intactos).

> Nota sobre los números del ejemplo: la app ahora muestra **de forma consistente** la parcela
> pendiente que se está pagando y, tras el abono, esa misma parcela; el dígito exacto depende de
> los datos de la venta, pero ya nunca aparece un número aleatorio ni "parcelas restantes".

---

## 3. Aprobaciones — tooltip "Ver historial"

- Se quitó el atributo `title` genérico del navegador de la fila.
- Se agregó un **tooltip propio de RutaCash**, anclado al **área clickeable** de la fila
  (celda de identidad del cliente), con estilo:
  - fondo blanco, **borde azul** (`border-primary-300`), **bordes redondeados**,
  - **sombra suave** (`shadow-lg`), **padding** cómodo, tipografía de la app,
  - texto claro: **"Ver historial"**.
- Aparece al hacer **hover** sobre esa área y se oculta al salir (`group-hover`).
- Tiene `pointer-events-none`, así que **no bloquea clics**.
- **No aparece** al pasar el cursor sobre los botones **Aprobar** / **Rechazar** (están en otra
  celda, fuera del `group` del tooltip), por lo que las acciones rápidas no lo disparan.

---

## 4. Aprobaciones — ventana emergente del historial

**A. Días de pago como badges.**
En "Condiciones solicitadas", los días de pago dejaron de mostrarse como texto corrido y ahora
son **badges/chips** (Lun, Mar, Mié, …), ordenados de lunes a domingo, con estilo coherente con
RutaCash (`bg-primary-50`, borde suave, redondeados). Si no hay días definidos, se muestra
"Según frecuencia original".

**B. Control de altura / scroll interno.**
- El modal mantiene su altura máxima (`max-h-[90vh]`, ya existente en el componente `Modal`).
- La **columna derecha** (indicadores comparativos + advertencias + historial de ventas) tiene
  ahora **scroll vertical interno** en desktop (`lg:max-h-[62vh] lg:overflow-y-auto`), de modo
  que un historial largo **no** hace crecer la ventana hacia abajo.
- La **columna izquierda** (cliente + solicitud actual + días de pago) permanece estable.
- Se quitó el scroll anidado del listado de historial para que el contenedor de scroll sea la
  columna completa (evita doble barra en desktop). En mobile, el modal apila y su cuerpo hace
  scroll normal.

**C. Organización.** La ventana sigue mostrando: datos del cliente, solicitud actual, días de
pago (badges), indicadores comparativos, historial de ventas y acciones Aprobar/Rechazar; ahora
más ordenada y con la altura controlada.

---

## Riesgos detectados

- **Número de parcela en pagos multi-parcela:** si un abono cubre varias parcelas (p. ej. "Total
  saldo"), la etiqueta muestra la **primera** parcela pendiente que se estaba pagando; es el caso
  esperado por el socio (parcela actual). El saldo y estados se calculan igual que antes.
- **Tooltip anclado a la celda del cliente:** el tooltip se dispara sobre esa área (la más
  representativa para "ver historial"); el resto de la fila sigue siendo clickeable. Es
  intencional que no cubra las celdas de acciones.
- **Scroll interno solo en desktop (`lg:`):** en mobile el modal se apila y usa el scroll del
  cuerpo del modal, sin doble barra.

## Qué NO se cambió

- No se tocó backend, Supabase ni autenticación.
- No se cambió la lógica contable (saldo, motor de cuotas/parcelas, aplicación de pagos).
- No se modificaron los flujos de Aprobar/Rechazar (siguen usando los mismos handlers).
- No se rompió DEMO, CLEAN, App Cobrador ni Aprobaciones.
- No se hizo commit/push/deploy ni se tocó GitHub/Vercel.

## Pruebas manuales recomendadas

**App Cobrador**
1. Antes de entrar a abonar, la venta muestra la parcela actual (p. ej. 3/24 o 4/24 según datos).
2. Al entrar a registrar abono, se muestra claramente la parcela a pagar, con el número
   destacado y la etiqueta "Pagando parcela N de total".
3. Ya **no** aparece un número aleatorio alto (p. ej. 19/24) ni "parcelas restantes".
4. Tras registrar el abono, la confirmación muestra la **misma** parcela ("Parcela N de total
   registrada") y el nuevo saldo; el recibo de WhatsApp usa esa parcela.
5. El saldo, el progreso y el total de parcelas siguen correctos; registrar abono funciona.

**Aprobaciones**
6. Hover sobre el área clickeable de la fila muestra el tooltip "Ver historial" con estilo
   RutaCash (borde azul, fondo claro, sombra), no el tooltip genérico.
7. Hover sobre Aprobar y sobre Rechazar **no** muestra ese tooltip.
8. Clic en la fila abre el historial; Aprobar/Rechazar siguen funcionando (anti doble-clic).
9. En el modal, los días de pago se ven como badges.
10. Con un cliente de mucho historial, la **columna derecha** hace scroll vertical y el modal
    mantiene una altura razonable; la columna izquierda permanece estable.

**General**
11. `npm run dev:clean` y `npm run dev:demo` funcionan.
12. `npm run build` termina exitoso.
