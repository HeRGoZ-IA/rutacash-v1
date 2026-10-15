# Capital centralizado (C1 + C2) — 2026-10-15

Decisión del propietario: la caja de la ruta deja de ser una bolsa intermediaria de capital. El Administrador responsable administra su bolsa y entrega capital directamente al trabajador, identificando la ruta. Lo que el trabajador devuelve o entrega en el cuadre vuelve a esa misma bolsa.

La ruta sigue siendo la unidad de atribución: clientes, cartera, préstamos, recaudos, gastos, cuadres, liquidaciones e historial.

**Estado.** C1 (motor) y C2 (interfaz y transición) implementados y probados en local. **No está activo para ninguna empresa** y no se ha desplegado. La activación es una acción explícita del SuperAdmin en cada navegador (sección 4).

## 1. Cómo funciona

Las fórmulas v16 no cambian:

- Base de la ruta = Sin asignar + Σ posiciones.
- Bolsa del Administrador = asignaciones − devoluciones − colocado + retiros − gastos.

Cada operación que antes dejaba o tomaba dinero de "Sin asignar" se registra ahora como un **par atómico** con la bolsa del responsable. Las patas comparten `centralLink` (`kind`, `operationId`, `relatedId`).

| Operación | Registros (una transacción) | Bolsa | Trabajador | Sin asignar |
|---|---|---|---|---|
| Entrega a trabajador (`deliverCapitalToWorker`) | `CapitalMovement` + `BASE_ASSIGNMENT` | −X | +X | = |
| Devolución (`returnCapitalFromWorker`) | `BASE_RETURN` + `Withdrawal` | +X | −X | = |
| Anulación de entrega (`reverseCapitalDelivery`) | capital espejo + `BASE_RETURN` | +X | −X | = |
| Cuadre (`closeCashSettlement`) | cuadre + `Withdrawal` por `entregado − sobrante` | +S | se cierra el ciclo | = |
| Reapertura del cuadre | `Withdrawal` espejo | −S | recupera S | = |
| Cobro no personal (transferencia, o cobro recibido por un Admin) | pago + `Withdrawal` | +X | no cambia | = |
| Anulación o corrección de ese cobro | `Withdrawal` espejo (+ el nuevo importe) | −X (+Y) | no cambia | = |
| Desembolso del Admin o SuperAdmin | `CapitalMovement` + venta | −X | no cambia | = |
| Gasto de ruta | `CapitalMovement` + gasto | −X | no cambia | = |
| Aporte de socio (`registerPartnerContribution`) | `capitalLedger` `PARTNER_CONTRIBUTION` + salida en Caja socios | +X | no cambia | = |

**Sin doble consumo.** La bolsa paga cuando entrega. El trabajador desembolsa de su posición, que incluye el capital recibido y su recaudo en efectivo de esa misma ruta, así que el préstamo no vuelve a descontar de la bolsa. Un trabajador con R$ 200 recaudados puede completar una venta de R$ 500 con una entrega de R$ 300. Sin entrega se rechaza (D25).

**Lo que no cambia:**
- Permisos de venta e interés (el Cobrador no tiene venta directa; tasas 10/20).
- Gastos del trabajador: pueden dejar la posición en negativo.
- Faltantes y sobrantes.
- D7, D24, D25, D28 y D29.
- Autoridades `structural`, `settle` y `correct`:
  - entregar: solo el responsable;
  - recibir una devolución: responsable, SuperAdmin o Supervisor de la ruta;
  - anular: responsable o SuperAdmin.

**Cuadre con esperado negativo** (gasto sin efectivo). `entregado − sobrante` es ≤ 0, así que no se mueve la bolsa. Se conserva el tratamiento vigente: "Sin asignar" baja y el sobrante queda documentado, sin mover efectivo físico. Es el mismo pendiente abierto del sobrante (73209ce).

**Partes de D26 y D30 que sustituye esta decisión** (aplican solo con el modelo activo):
- **D26.** Sigue aplicándose y queda implícita en D25: la Base es la suma de las posiciones.
- **D30.** El desembolso administrativo y el gasto de ruta salen de la bolsa del responsable, no de la caja de la ruta. La autoridad no cambia (responsable o SuperAdmin).

## 2. Activación y compatibilidad (preparado para C2)

**Activación.** El modelo se activa por empresa con `Tenant.centralCapitalStartAt`. Es un campo **sin índice**, así que no hay versión Dexie nueva y las bases v16 abren igual.
- Solo lo fija `activateCentralCapitalModel`, que exige SuperAdmin y es idempotente. Guarda en la auditoría la foto del saldo heredado de cada ruta.
- Nada lo activa al cargar la aplicación.
- En C1 ninguna pantalla llama a este servicio.

**Sin activar** (todas las empresas hoy), el comportamiento es exactamente el de v16.

**Cómo se distingue cada cosa:**

| Qué | Cómo se reconoce |
|---|---|
| Movimientos del modelo nuevo | Llevan `centralLink` |
| Movimientos históricos v16 | No lo llevan |
| Saldo heredado | Es "Sin asignar" de la ruta en el momento de activar |

**Con el modelo activo:**
- **Lo que haría crecer la caja de la ruta se rechaza:**
  - capital a la caja;
  - devolución a la caja;
  - Socio → Ruta y Ruta → Ruta;
  - anular un retiro histórico o una transferencia que salió de una ruta;
  - anular por separado una pata enlazada.
- **Lo que solo la vacía sigue permitido**, con tope en el disponible:
  - retiro a la bolsa;
  - entrega de Base desde la caja;
  - salida a socio.
- **Excepción documentada:** una cadena de corrección de un cobro no personal **anterior** a la activación sigue su circuito histórico.
- **Diagnóstico (`diagnoseCentralCapitalTransition`)**, solo lectura. Clasifica cada ruta en una de cuatro categorías:
  - `limpia`;
  - `saldo-heredado`: incluye el negativo explicado por sobrantes de cuadres con esperado negativo (C2: no es dinero disponible, nada lo consume y el sobrante sigue documentado);
  - `inconsistente`: la conciliación no cuadra, o "Sin asignar" es negativo **sin** que lo expliquen sobrantes registrados; requiere revisión humana;
  - `sin-responsable`.
- **Un cuadre anterior a la activación** solo se reabre si su efectivo sigue en la caja de la ruta.

**No se convierte nada automáticamente.** Ningún saldo anterior se transforma en aportes ni en retiros.

## 3. Interfaz y transición (C2)

**Cada pantalla elige el circuito según el estado de la empresa** (`useCentralCapital`). Sin activar, todo es v16. Mientras ese estado se carga, no se ofrece ninguna operación de capital.

| Pantalla | Con el modelo activo |
|---|---|
| Capital / Caja principal | «Entregar capital», «Recibir devolución» y, si queda, «Traspasar heredado» (asistente → servicios C1). Sin «Colocar capital». Anular una entrega anula el par. La bolsa clasifica cada movimiento por su operación |
| Transferencias (asistente) | Solo entregar y recibir capital, más el vaciado del heredado en las rutas que lo tienen. Sin Ruta → Ruta, sin colocar ni devolver a la caja. «Aporte de socio a mi bolsa». La operación con socio ya no ofrece una ruta como destino |
| Retiros | Solo «Traspasar saldo heredado». Los retornos de cuadre, las devoluciones y los cobros no en efectivo no se listan como retiros |
| Liquidación → cuadre por trabajador | «Capital recibido / devuelto», «Entregar capital», «Recibir devolución de capital». La confirmación indica que el efectivo vuelve a la bolsa |
| Caja y Liquidación semanal | Desglose del ingreso de capital y de los retiros por operación (`capitalFlowBreakdown`; suma exactamente los totales) |
| Conciliación de la ruta | «Saldo heredado de la antigua caja», su valor al activar y el bloqueo si lo hay |
| Rutas | Sin «Capital inicial» (el servicio también lo rechaza); aviso de ruta bloqueada |
| Historial | Cada registro centralizado con su nombre real |
| «Mi efectivo» del Cobrador | «Capital recibido del Administrador» separado del recaudo. Las filas son entradas y salidas del periodo; el único saldo es «Efectivo a tu cargo». Lista de entregas y devoluciones del periodo. Nunca la bolsa |

**Transición** (`/admin/capital/transicion`, enlace «Capital centralizado» en Capital):
1. **Diagnóstico**, solo lectura. Por ruta muestra:
   - responsable, Base, sin asignar o heredado, conciliación;
   - faltantes, sobrantes y cobros no en efectivo;
   - ajustes de cobros históricos;
   - estado y explicación.

   El Administrador solo ve sus rutas.
2. **Respaldo** (`centralCapitalBackupService`):
   - exporta todas las tablas de la empresa, sin contraseñas ni otras empresas, a un archivo en el equipo;
   - al volver a cargarlo se comprueban el formato, la empresa, la huella de integridad (SHA-256) y que los datos financieros no cambiaron desde la exportación (huella financiera);
   - un movimiento posterior invalida el respaldo.
3. **Activación**: SuperAdmin, motivo, casilla de comprensión y palabra «ACTIVAR». Con movimientos financieros exige el respaldo verificado y vigente. Al activar:
   - guarda la foto del heredado por ruta (`centralCapitalHeritage`);
   - bloquea las rutas inconsistentes o sin responsable (`centralCapitalRouteBlocks`). Una ruta bloqueada no recibe capital nuevo (entregas, préstamos o gastos de ruta con la bolsa), pero sus cuadres y devoluciones siguen.
4. **Liberación** (`releaseCentralCapitalRoute`): solo el SuperAdmin, tras revisar, con motivo de al menos 10 caracteres.
   - Si la ruta sigue inconsistente, debe aceptarlo expresamente.
   - Sin responsable no se libera.
   - No corrige ningún saldo.

**Correcciones históricas.** Corregir un cobro no en efectivo anterior a la activación mueve el saldo heredado, no la bolsa, y no crea `centralLink`. El diagnóstico lo lista aparte en «Ajustes de cobros históricos».

## 4. Validación futura del socio (cuando se autorice publicar C2)

1. Antes de nada, el socio sigue trabajando igual: sin activar, CLEAN se comporta como hoy.
2. En **su** navegador, como SuperAdmin: Capital → «Capital centralizado».
   - Revisar el diagnóstico.
   - Si una ruta sale «Inconsistente» o «Sin responsable», queda bloqueada al activar hasta revisarla.
3. «Exportar respaldo», guardar el archivo en el equipo y, sin registrar movimientos entre medias, «Cargar respaldo para verificar» con ese mismo archivo.
4. Escribir el motivo, marcar la casilla, escribir ACTIVAR y «Activar capital centralizado».
5. Comprobar en Capital:
   - el saldo heredado de cada ruta;
   - entregar un importe pequeño a un cobrador;
   - verlo en su «Mi efectivo».
6. El respaldo queda en el equipo del socio: no se envía a nadie. Conservarlo.

## 5. Pendiente

- **Publicación de C2:** push, despliegue y `verify:deploy` (8 marcadores nuevos), y luego la activación por el socio según la sección 4.
- **Devolución de la bolsa a un socio:** no está definida por la decisión ni implementada. La salida a socio solo opera sobre el saldo heredado.
- **Traslado entre rutas:** son dos operaciones del responsable. Entre responsables distintos sigue abierto como D2.
- **Venta directa de ciertos Cobradores:** discrepancia funcional pendiente; sin cambios.
- **`npm test` encadena 27 suites** (1.600 históricos + `centralcapital`). El manifiesto del banco de contratos de `saas/` se actualizó en consecuencia (solo infraestructura de pruebas).
- **S3** implementará el mismo modelo en PostgreSQL desde cero, sin caja de ruta operativa.
