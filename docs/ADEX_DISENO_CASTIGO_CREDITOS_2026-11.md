# 3.28 · Castigo de créditos («Dar por perdida») — diseño para aprobar

**Estado:** BORRADOR (2026-11-08). No se construye nada hasta el «sí» de Helmer.
**Origen:** decisión 2.1.10 (2026-11-05). El socio contó que hay clientes que pagan años después, así que un crédito solo se da por perdido cuando el cliente falleció o se fue del país. Castigo **manual**, sin plazo automático y sin estado «Congelado».

## 1. Qué ve el Administrador

- En el detalle de una venta **activa** aparece el botón **«Dar por perdida»**.
- **Solo el Administrador** responsable de la ruta puede usarlo. No lo tienen el SuperAdmin, el Secretario, el Supervisor ni el Cobrador.
- Se abre una ventana con:
  - el **motivo obligatorio**: «Falleció», «Se fue del país» u «Otro». Con «Otro», hay que escribir la explicación;
  - el **saldo** que se da por perdido y cuánto de ese saldo es **capital** y cuánto **interés**;
  - un aviso: «El dinero no se mueve. Si el cliente paga después, el pago se recibe igual como recuperación».
- La fecha del castigo es la de hoy, según la empresa.

## 2. Qué pasa al confirmar

| Dónde | Efecto |
|---|---|
| Venta | Pasa a **«Perdida»**. Se guardan la fecha, el motivo y quién lo hizo. Queda en el historial; no se borra nada |
| Cobrador | La venta **desaparece de su lista de cobro** y de los atrasos |
| Cartera activa y mora | El saldo **sale** de la cartera activa y de los indicadores de atraso |
| Dinero (Base y efectivo) | **No cambia nada**. Castigar no mueve dinero |
| Reportes | Nuevo dato **«Créditos dados por perdidos»**: cantidad, saldo, capital perdido y motivo |
| Cliente | En su ficha se ve «Venta perdida el dd/mm · motivo» |
| Auditoría | Evento `SALE_WRITTEN_OFF` con quién, cuándo, motivo y saldo |

## 3. Si el cliente paga después (recuperación)

- El **Administrador** registra el pago desde el detalle de la venta perdida, como un recaudo normal: el dinero **entra a la Base de la ruta**.
- En los reportes se ve como **«Recuperación»**, aparte del recaudo normal.
- Si el cliente termina de pagar, la venta pasa a «Finalizada».

## 4. Deshacer

- El Administrador puede **«Deshacer pérdida»** con un motivo, por ejemplo si se equivocó de venta.
- La venta vuelve a «Activa», con su calendario y su mora, como si no se hubiera castigado. Todo queda en auditoría.

## 5. Técnico (para el registro)

- Migración **0053**:
  - columnas en la venta: fecha, motivo, texto y quién;
  - funciones `credit_write_off` y `credit_write_off_undo`, solo para el Administrador responsable y validadas en la base;
  - eventos de auditoría.
- Los estados `perdida` (venta) y `perdido` (cliente) ya existen desde la migración 0002, pero ninguna pantalla los usaba.
- La API recibe dos órdenes nuevas. La web suma el botón, la ventana, el filtro «Perdidas» y la línea en los reportes.
- Pruebas: en PostgreSQL y de punta a punta, con datos sintéticos. **Nunca** se castigan ventas de BlueLine para probar.

## 6. Preguntas para Helmer (con mi sugerencia)

1. **¿La pérdida resta en la Liquidación del periodo?**
   - Sugerencia: **sí, en una línea aparte**, «Pérdida por créditos (capital)», que baja el resultado pero no el efectivo, para que la ganancia no se vea inflada.
   - Alternativa: que solo aparezca en los reportes.
2. **¿Quién recibe un pago de recuperación?**
   - Sugerencia: **solo el Administrador**, porque la venta ya no está en la lista del Cobrador.
   - Alternativa: que el Cobrador también pueda, buscando al cliente.
3. **¿Se puede deshacer un castigo?**
   - Sugerencia: **sí, con motivo**, para corregir errores.
