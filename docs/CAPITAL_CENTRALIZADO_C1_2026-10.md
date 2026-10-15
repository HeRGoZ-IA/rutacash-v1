# Capital centralizado (C1) — 2026-10-15

Decisión del propietario: la caja de la ruta deja de ser una bolsa intermediaria de capital. El Administrador responsable administra su bolsa y entrega capital directamente al trabajador, identificando la ruta. Lo que el trabajador devuelve o entrega en el cuadre vuelve a esa misma bolsa.

La ruta sigue siendo la unidad de atribución: clientes, cartera, préstamos, recaudos, gastos, cuadres, liquidaciones e historial.

**Estado.** Implementado en el motor local, solo con pruebas. **No está activo para ninguna empresa.** No hay cambios de interfaz ni despliegue. La activación y la transición de los datos reales pertenecen a C2.

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
  - `saldo-heredado`;
  - `inconsistente`: la conciliación no cuadra o "Sin asignar" es negativo; requiere revisión humana;
  - `sin-responsable`.
- **Un cuadre anterior a la activación** solo se reabre si su efectivo sigue en la caja de la ruta.

**No se convierte nada automáticamente.** Ningún saldo anterior se transforma en aportes ni en retiros.

## 3. Pendiente fuera de C1

- **C2:**
  - pantallas (entregar, devolver, aporte de socio, «Mi efectivo» con "Capital recibido");
  - diagnóstico visible;
  - vaciado controlado del saldo heredado;
  - activación por empresa;
  - etiquetas de los informes (los retornos de cuadre se registran como retiros).
- **Devolución de la bolsa a un socio:** no está definida por la decisión. No se implementó. La salida a socio solo opera sobre el saldo heredado.
- **Traslado entre rutas:** son dos operaciones del responsable (devolución en una ruta y entrega en la otra). Entre responsables distintos sigue abierto como D2.
- **`npm test` sigue encadenando las 26 suites:** el banco de contratos de `saas/` (BENCH-002) exige esa lista exacta. La suite nueva se ejecuta con `npm run test:centralcapital` y se incorporará al encadenado cuando se actualice el manifiesto SaaS en S3.
- **S3** implementará el mismo modelo en PostgreSQL desde cero, sin caja de ruta operativa.
