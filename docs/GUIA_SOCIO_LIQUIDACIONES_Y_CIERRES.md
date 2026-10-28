# Guía para el socio: Liquidaciones, cierres y cuadres

*2026-10-27 · Basada en el código publicado (no probada en BlueLine). Mejora pendiente: 3.19 del [listado canónico](./ADEX_PENDIENTES_CONSOLIDADOS_2026-10-24.md).*

## Las palabras

| Palabra | Qué es | Quién lo hace |
|---|---|---|
| **Cierre** | Congelar las cifras de **una ruta** en un rango de fechas. Se puede hacer **cuando se quiera**: no tiene que ser semanal. Hoy la pantalla lo llama «Liquidación de ruta» y «Cerrar semana». | Solo el Administrador **responsable de capital** de la ruta |
| **Cuadre** | El trabajador entrega su efectivo y se compara con lo que debía tener | El responsable con el Cobrador o el Supervisor |

Todo está en el menú **Control → Liquidación**.

## Hacer un cierre

1. Elegir la **ruta**: cada ruta se cierra por separado.
2. Poner las fechas. **Hoy hay que hacerlo a mano**: la pantalla propone de lunes a sábado de la semana actual.
   - **Inicio:** el día siguiente al último cierre.
   - **Fin:** el último día que se quiere cerrar. Puede ser hoy.
   - Si la ruta trabaja domingos, incluir el domingo. Si no, ese día no sale en ningún cierre (el dinero no se pierde, pero no aparece en ningún resumen).
3. **Generar:** es una vista previa y no guarda nada.
4. **Cerrar semana → Cerrar y congelar semana:** queda archivado y las cifras quedan congeladas.

Antes de cerrar, conviene que los cobradores **sincronicen sus teléfonos**. Lo que llegue después con fechas ya cerradas se rechaza.

## Qué muestra un cierre

- Base del trabajador al inicio.
- (+) Entregas de Base, (+) Recaudo y (+) Transferencias entrantes.
- (−) Desembolsos, (−) Gastos, (−) Transferencias salientes y (−) Devoluciones de Base.
- Base del trabajador al cierre.
- Una nota con los cuadres de los trabajadores en esas fechas. Es informativa y no se suma al cierre.

## Ver cierres anteriores (¿cerré el domingo?)

- En **Liquidación**, elegir la ruta. Abajo aparece la tabla **«Liquidaciones archivadas»**, con cada cierre, su estado y un botón **CSV**.
- **Si la tabla no aparece, esa ruta no tiene cierres.** Hoy no sale ningún aviso que lo diga.
- Otra forma de comprobarlo: poner las fechas. Si ya están cerradas, el responsable ve el aviso «Esta semana ya está cerrada».
- **Cualquier Administrador con acceso a la ruta ve los cierres**, también los que hizo otro.

## Si cierro hoy fechas pasadas, ¿se daña lo de hoy?

**No.** Por ejemplo, si el martes 27 se cierra del 19 al 25, el cierre solo toma los movimientos de esos días. La Base, los gastos, los recaudos y las ventas de los días siguientes no se tocan. Solo cambia esto:

- ya no se registra nada con fechas del 19 al 25;
- corregir un pago de esas fechas requiere una solicitud de ajuste o **reabrir** con un motivo (solo el responsable).

No se puede cerrar un rango que se cruce con otro cierre, ni uno que termine en una fecha futura.

## Responsable frente a otro Administrador

| | Responsable de la ruta | Otro Administrador |
|---|---|---|
| Generar, ver, descargar CSV, ver cierres anteriores | Sí | Sí |
| Cerrar y reabrir | Sí | No (los botones no aparecen) |
| Cuadre por trabajador: entregar Base, recibir efectivo, cerrar cuadres | Sí | Solo consulta |

## Lo que viene (3.19, aprobado el 2026-10-27)

- La ventana pasará a llamarse **«Liquidaciones»**. El menú sigue diciendo «Liquidación».
- Las pestañas serán **«Cierre de ruta»** y **«Cuadre por trabajador»**.
- **«Desde» / «Hasta»:**
  - «Desde» será el día siguiente al último cierre y vendrá puesto solo;
  - «Hasta» propondrá hoy.
- El botón se llamará **«Hacer cierre»** y la tabla, **«Cierres realizados»**.
- Un aviso dirá **«Último cierre: …»** o **«Esta ruta aún no tiene cierres»**.
- Los encabezados del CSV no cambian.
