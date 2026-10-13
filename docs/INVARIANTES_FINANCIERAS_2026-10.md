# ADEX Soluciones — Invariantes financieras y contratos de operación (Ronda 6/6D)

| | |
|---|---|
| Fecha | 2026-10-12 · `main` @ `520a331` |
| Propósito | Catálogo de lo que el servidor **debe** garantizar para no perder ninguna regla del motor local |
| Convenciones | **[T]** = demostrada hoy por pruebas automáticas (suite entre paréntesis). **[P]** = pendiente de verificar o que solo puede garantizar el servidor |
| Estado | Las reglas D1–D30 aprobadas se conservan tal cual. Los contratos propuestos son **candidatos**, no decisiones aprobadas |

Decisiones de negocio vigentes, todas **[T]**:

| Decisión | Regla |
|---|---|
| **D24** | Aprobar no reserva fondos |
| **D25** | Quien entrega el dinero lo tiene en mano |
| **D26** | Ningún desembolso supera la Base de la ruta |
| **D28** | Castigar no borra la historia financiera |
| **D7** | Lo cerrado es inmutable; las correcciones se registran como asientos nuevos y trazables |
| **D29** | No se cierra un periodo que no ha terminado |
| **D30** | La caja de la ruta solo la usa su responsable de capital o el SuperAdmin |

Siguen **abiertas**: D1 (Caja socios), D2–D4 y las D19–D23 propuestas en la pre-Ronda 6. Ver [decisiones pendientes](./DECISIONES_PENDIENTES_SAAS_2026-10.md).

---

## 1. Definiciones que el servidor debe calcular igual

| Concepto | Definición | Fuente |
|---|---|---|
| **Base de la ruta** | capital (con reversiones) + transferencias de entrada − transferencias de salida − retiros + cobros − préstamos desembolsados − gastos. Las ventas pendientes no restan | `cashboxEngine.getRouteBase` |
| **Posición del trabajador** | arrastre (faltante anterior) + Base recibida − Base devuelta + recaudo en efectivo − desembolsos − gastos, en el ciclo `(último cuadre, ahora]` | `cashSettlementRules.computeExpected`, `cashSettlementService.personalCashPosition` |
| **Efectivo en mano** (D25) | Posición − arrastre (= `neto` del ciclo). Un faltante es una deuda, no dinero | `saleRequestService.assertDisbursementFunds` |
| **Sin asignar** | Base − Σ posiciones. Se calcula por dos vías independientes que deben coincidir (`cuadra`) | `routeCashReconciliation.computeRouteCashReconciliation` |
| **Disponible de la ruta** | max(0, min(Base, Sin asignar)) | ídem |
| **Bolsa del Administrador** | asignaciones − devoluciones − colocado + retiros − gastos de su bolsa | `capitalAllocation.adminCapital` |
| **Conservación del capital** | depósitos − retiros de empresa + histórico anterior a v16 = disponible de la empresa + Σ asignado + sin responsable + gastos de empresa + Σ gastos de bolsa | `capitalAllocation.verifyCapitalInvariants` |
| **Cartera** | Σ saldo de ventas `activa` y desembolsadas. No es efectivo | `cashboxEngine.carteraEnCalleOf` |
| **Periodo cerrado** | Liquidación `cerrada` vigente que cubre la fecha contable de la ruta | `settlementPeriods.protectingClosureFor` |

---

## 2. Catálogo por operación

Formato de cada ficha:
- **Entrada**
- **Actor**
- **Validaciones**
- **Tablas**
- **Invariantes**
- **Atomicidad**
- **Resultado**
- **Concurrencia** (qué falla entre dispositivos)
- **Contrato candidato**

Todas las operaciones que mueven dinero exigen además:
- un actor autenticado de la misma empresa;
- un importe entero mayor que 0;
- que la Oficina de la ruta esté activa (`assertRouteOperationalContext`).

### 2.1 Capital de empresa: depósito y retiro
- **Entrada:** importe, fecha (no futura), descripción, `operationId`.
- **Actor:** SuperAdmin (`capital.allocateAdmins`).
- **Validaciones:** el retiro no supera el disponible de la empresa.
- **Tablas:** `capitalLedger` (`COMPANY_DEPOSIT` / `COMPANY_WITHDRAWAL`), `auditLogs`.
- **Invariantes:** conservación del capital **[T]** (`capitalcontrol`, `adminpool`); el disponible de la empresa nunca es negativo **[T]**.
- **Atomicidad:** se relee el libro dentro de la transacción (`registrarLedger`).
- **Resultado:** movimiento del libro, idempotente por `operationId` **[T]**.
- **Concurrencia:** dos SuperAdmin en equipos distintos pueden retirar el mismo disponible **[P]**.
- **Contrato:** `POST /companies/{id}/capital/deposits|withdrawals {operationId, amount, date}`. Bloqueo del saldo de la empresa y escritura del libro y de la auditoría en una sola transacción.

### 2.2 Asignación y devolución de capital a un Administrador
- **Actor:** SuperAdmin.
- **Validaciones:** el Administrador está activo; la asignación no supera el disponible de la empresa y la devolución no supera la bolsa del Administrador.
- **Tablas:** `capitalLedger` (`ADMIN_ALLOCATION` / `ADMIN_RETURN`).
- **Invariantes:** ninguna bolsa negativa; conservación **[T]**.
- **Concurrencia:** una asignación y una colocación simultáneas sobre la misma bolsa **[P]**.
- **Contrato:** `POST /admins/{id}/capital/allocations|returns`, con bloqueo de fila sobre la bolsa.

### 2.3 Responsable de capital de la ruta
- **Entrada:** ruta, nuevo Administrador, motivo (al menos 3 caracteres).
- **Actor:** SuperAdmin (`capital.assignController`).
- **Validaciones:** el nuevo responsable es un Administrador activo y asignado a la ruta (`isValidCapitalController`).
- **Tablas:** `routes.capitalControllerAdminId`, `routeCapitalControllerEvents` (con la Base al cambio), `capitalLedger` (traspaso del capital colocado, `transitionRouteCapitalController`).
- **Invariantes:**
  - un único responsable por ruta **[T]**;
  - sin responsable válido, toda operación de caja falla cerrada **[T]** (`capitalcontrol`, `periodauthority` AUTHBOX-005);
  - al cambiar asignaciones de Administradores nunca se elige un responsable «en silencio» (`withCapitalControllerGuard`) **[T]**.
- **Concurrencia:** una operación de caja autorizada por el responsable anterior que llega después del cambio. Hoy se relee dentro de la transacción **[T]** (AUTHBOX-006); entre dispositivos queda **[P]**.
- **Contrato:** `PUT /routes/{id}/capital-controller`. Las operaciones de caja leen al responsable en su propia transacción, nunca desde el token.

### 2.4 Colocación de capital en la ruta (`registerCapital`)
- **Actor:** Administrador responsable (`capital.manage` + autoridad `structural`).
- **Validaciones:** el importe no supera la bolsa del responsable; la fecha no es futura y no cae en una semana cerrada (D7) **[T]**.
- **Tablas:** `capitalMovements` (`adminId`).
- **Invariantes:** la Base y Sin asignar suben X; la bolsa baja X; conservación **[T]** (`capitalcontrol`, `routebase`).
- **Atomicidad:** `fundsTables` (libro, custodia, cuadres, capital, cierres semanales).
- **Contrato:** `POST /routes/{id}/capital {operationId, amount, date}`.

### 2.5 Retiro de la ruta a la bolsa (`registerWithdrawal`)
- **Actor:** responsable.
- **Validaciones:** el importe no supera el disponible de la ruta (nunca toma efectivo en custodia); D7 **[T]** (`basecash`, `supervisorbase`).
- **Invariantes:** la Base baja; el dinero vuelve a la bolsa del responsable (`adminId`) **[T]**.
- **Concurrencia:** un retiro y una entrega de Base, o un retiro y un desembolso administrativo, sobre la misma caja desde dos equipos **[P]**.

### 2.6 Transferencias (`registerTransfer`)
- **Tipos:** Ruta → Ruta (mismo responsable en las dos), Socio → Ruta (aporte; pata `salida` en Caja socios), Ruta → Socio (pata `ingreso`), con entrega en mano opcional (`entregarA` → `BASE_ASSIGNMENT` enlazada).
- **Actor:** Administrador con `transfer.create` y autoridad `structural` sobre cada ruta implicada.
- **Validaciones:** la ruta de origen tiene disponible; D7 en cada ruta; idempotencia por `operationId` **[T]** (`transferops`, `movementhistory`).
- **Invariantes:**
  - todas las patas (transferencia, Caja socios, custodia) en una transacción **[T]**;
  - Socio → Ruta **no exige** saldo en Caja socios **[T]**: es D1, abierta.
- **Contrato:** `POST /transfers {operationId, from, to, amount, handTo?}`. Bloqueo ordenado por id de ruta para evitar interbloqueos.

### 2.7 Custodia: entregar, devolver y traspasar Base
- **Entregar** (`assignBaseToWorker`):
  - Actor: responsable (`structural`).
  - Validaciones: importe ≤ disponible de la ruta; el destinatario puede custodiar (`custodianBlockedReason`).
- **Devolver** (`returnBaseFromWorker`) y **traspasar** (`transferBaseBetweenWorkers`):
  - Actor: autoridad `settle`.
  - Nadie registra su propia devolución.
- **Tablas:** `cashCustodyMovements`.
- **Invariantes:**
  - la Base **no cambia**; solo cambia quién la tiene;
  - `Base = Sin asignar + Σ posiciones` **[T]** (`basecash`, `routebase`, `workertransfer`);
  - idempotencia por `operationId` **[T]**.
- **Concurrencia:** una entrega mientras otro equipo desembolsa como Administrador desde la misma caja **[P]**.

### 2.8 Solicitud y aprobación de venta
- **Solicitar** (`createSaleRequest`):
  - Actor: `sale.createRequest`.
  - Validaciones: integridad (ruta y cliente de la empresa, tasa, días, fecha de inicio ≥ hoy); el Cobrador solo origina al 20 %; **una sola solicitud pendiente por cliente** (comprobada en la transacción) **[T]** (`activecredit`, `interestrate`).
- **Aprobar o rechazar** (`approveSaleRequest`, `rejectSaleRequest`):
  - Actor: `authorization.approve` / `reject`; nunca quien la pidió.
  - La solicitud se relee como `pending` dentro de la transacción: dos aprobadores producen una sola venta **[T]** (`workercash` SUP-AUTH-*).
- **Invariante D24:** la venta aprobada queda `pendiente` y no resta Base ni reserva nada **[T]** (`capitalcustody` CAP6C-002/003).
- **Contrato:** `POST /sale-requests`, `POST /sale-requests/{id}/approve|reject`, con bloqueo optimista (versión) sobre la solicitud.

### 2.9 Desembolso: confirmación y venta directa
- **Entrada:** venta (confirmación) o datos de la venta (directa).
- **Actor:**
  - confirmación: `sale.confirmDisbursement` y usuario obligatorio;
  - directa: `sale.createDirect`, con límite de venta directa salvo para `route.edit`.
- **Validaciones**, en una transacción:
  1. Estado: venta `activa` y `pendiente`, solicitud `approved` (`disbursementBlockedReason`) **[T]** (`disbursement`).
  2. D7: la semana de la fecha de inicio no está cerrada **[T]**.
  3. **D30**: si quien confirma no tiene caja personal, autoridad `correct` sobre la caja **[T]** (`periodauthority`).
  4. **D26**: importe ≤ Base de la ruta **[T]**.
  5. **D25**: importe ≤ efectivo en mano (Cobrador o Supervisor) o ≤ disponible de la caja (Admin o SuperAdmin) **[T]** (`capitalcustody`).
- **Tablas:** `sales` (`disbursementStatus`, `disbursedByCollectorId`, `disbursedByUserId`, `disbursedAt`), `saleRequests`.
- **Invariantes:**
  - una venta se desembolsa una sola vez;
  - reconfirmar con otro trabajador no cambia nada;
  - la Base nunca queda negativa;
  - nunca se crea Base automática **[T]**.
- **Concurrencia:** dos dispositivos desembolsan con la misma Base o el mismo efectivo **[P]**. Ver [riesgos](./RIESGOS_CONCURRENCIA_SAAS_2026-10.md) R1/R2.
- **Contrato:** `POST /sales/{id}/disburse {operationId}`, con bloqueo de la fila de la venta **y** de las filas de saldo de la ruta y del trabajador (`SELECT … FOR UPDATE`) o aislamiento `SERIALIZABLE` con reintento.

### 2.10 Pagos y recaudos (`registerPayment`)
- **Entrada:** venta, importe solicitado, responsable (solo si actúa un rol administrativo), tipo (efectivo u otro), fecha (por defecto hoy), `syncStatus`.
- **Actor:** `payment.register`; el Cobrador y el Supervisor siempre responden por lo que cobran.
- **Validaciones:**
  - venta `activa` y desembolsada, con parcelas;
  - **tope al saldo** (pago parcial o tope, nunca un saldo negativo);
  - atribución del cobrador (`resolveResponsibleCollector`);
  - D7 sobre la fecha **[T]** (`financial` con 180 casos, `paymentsync`).
- **Tablas:** `payments`, `installments`, `sales` (`saldo`, `status`, `fechaFinalizacion`).
- **Invariantes:**
  - el saldo se calcula desde las parcelas;
  - solo cuenta como efectivo personal el pago `efectivo`;
  - una venta finaliza con saldo 0 **[T]**.
- **Hueco:** **no hay idempotencia** por operación **[P]**: un reintento crea otro pago.
- **Concurrencia:** dos cobros sobre el mismo saldo desde dos equipos **[P]** (R3).
- **Contrato:** `POST /sales/{id}/payments {operationId, amount, type, collectorId?, capturedAt}`. Bloqueo de la venta y tope recalculado en el servidor; `operationId` único por empresa.

### 2.11 Corrección, ajuste y anulación de pagos
- **Corregir** (`correctPayment`):
  - Actor: `payment.correct`.
  - En una semana cerrada exige `payment.approveAdjustment`. El Secretario crea una solicitud (`requestPaymentAdjustment`) que aprueba un Administrador o el SuperAdmin (`approvePaymentAdjustment`).
- **Anular** (`annulPayment`):
  - Actor: `payment.reverse`.
  - Validación: el efectivo debe seguir siendo posible (`assertAnnulmentKeepsCashPossible`).
- **Invariantes:**
  - el original nunca se borra: queda `reversed` con un asiento espejo (`reversesPaymentId`) y, si corresponde, un pago nuevo (`correctionOfPaymentId`);
  - la fecha del asiento es la del original si su semana sigue abierta; si está cerrada, hoy; una fecha **elegida** dentro de un cierre se rechaza; sin periodo abierto no hay ajuste (`adjustmentEntryDate`, D7);
  - no puede haber dos correcciones del mismo pago (revalidación bajo bloqueo) **[T]** (`paymentreversal`, `periodauthority` REVPER-005/006/010).
- **Contrato:** `POST /payments/{id}/reversal|correction {operationId, reason, newAmount?, newDate?}`.

### 2.12 Gastos de trabajador y de ruta (`createExpense`)
- **De trabajador:**
  - Actor: el propio trabajador, o una autoridad `settle` si se carga a otra persona.
  - **Sin tope de efectivo:** su posición puede quedar negativa **[T]** (`expensecash`, `capitalcustody` CASH6C-005).
- **De ruta:**
  - Actor: responsable (`structural`).
  - Validación: importe ≤ disponible de la caja **[T]**.
- **Común:** D7 sobre la fecha **[T]**; idempotencia por `operationId` **[T]**.
- **Contrato:** `POST /routes/{id}/expenses {operationId, scope, workerId?, amount, date, category}`.

### 2.13 Gastos administrativos de la bolsa
- **Crear:** `createExpense` con alcance `empresa` y `funding` del Administrador o de la empresa. Validación: importe ≤ disponible de la bolsa **[T]** (`adminexpense`, `adminpool`).
- **Anular o reintegrar:** `reverseAdminExpense`, `refundAdminExpense`. Asiento enlazado con importe negado; el reintegro tiene tope en lo no reintegrado.
- **Sin ruta:** ningún cierre semanal les aplica **[T]** (REVPER-004).
- **Invariante:** la bolsa nunca queda negativa.

### 2.14 Anulación de capital, retiro y transferencia (`movementReversalService`)
- **Actor:** autoridad `correct` (responsable o SuperAdmin); la transferencia exige además estar en el alcance de las rutas o socios implicados.
- **Validaciones:**
  - el movimiento sigue vigente (`assertVigente`);
  - hay fondos para revertir;
  - la transferencia entregada en mano exige que la persona aún tenga ese efectivo;
  - D7 sobre **hoy** en cada ruta implicada **[T]** (REVPER-001/002/003/007).
- **Invariantes:**
  - asiento espejo con fecha de hoy, enlazado (`reversesId`); el original solo se marca;
  - todas las patas de la transferencia en una transacción **[T]** (`financialreversal`, `supervisorbase`).

### 2.15 Castigo de cartera (`markSaleLost`, D28)
- **Actor:** `sale.cancel` (Administrador o SuperAdmin de la ruta).
- **Validaciones:** venta `activa`; motivo obligatorio.
- **Invariantes:**
  - no mueve dinero;
  - no toca el desembolso, los pagos, las parcelas ni los cuadres;
  - guarda `lostAt` y `lostByUserId`;
  - audita `SALE_LOST` distinguiendo castigo de venta nunca desembolsada;
  - una venta perdida pendiente no se desembolsa **[T]** (LOST6C-*).

### 2.16 Cuadre por trabajador (`closeCashSettlement`)
- **Actor:** autoridad `settle`; nunca uno mismo.
- **Validaciones:**
  - el trabajador tiene caja personal y está asignado;
  - el `esperadoVisto` coincide;
  - motivo obligatorio si hay diferencia;
  - no hay solapamiento con otro cuadre.
- **Invariantes:**
  - ciclo por instantes `(desde, hasta]`, con `hasta` sellado bajo bloqueo y el reloj superado antes de soltarlo;
  - arrastre = máx(0, −diferencia);
  - el sobrante no es crédito;
  - cada movimiento cae en un solo ciclo **[T]** (`workercash` CASH-BOUNDARY-*, `settlements`).
- **Reapertura:** `reopenCashSettlement`, con motivo, versionada.

### 2.17 Liquidación y cierre semanal (`closeSettlement`)
- **Actor:** `settlement.close` + autoridad `correct` (responsable o SuperAdmin).
- **Validaciones (en una transacción con el libro):**
  - **D29**: solo periodos terminados;
  - sin duplicado ni solapamiento;
  - cálculo del motor y archivo **[T]** (`periodauthority` WEEK-*, `settlements`).
- **Invariantes:**
  - un cierre nunca se sobrescribe; reabrir lo marca `reabierta` y volver a cerrar crea una versión nueva;
  - las cifras archivadas coinciden con el recálculo tras anulaciones legítimas **[T]** (REVPER-011).
- **Pendiente:** el «fin de periodo» depende del reloj y la zona horaria del dispositivo **[P]**.

### 2.18 Caja socios (`createPartnerMovement`)
- **Actor:** `partnerCash.registerMovement`.
- **Validaciones:** socio real en alcance; importe entero; fecha no futura; `operationId`.
- **Sin control de saldo:** es D1, abierta **[T]** (`movementhistory` HIST-*).

---

## 3. Reglas transversales

| Regla | Estado |
|---|---|
| Toda operación financiera exige actor autenticado y autorizado **en el servicio**; las pantallas solo informan | [T] local (`permissions` 559 casos, AUTH6C-*); el servidor debe reimplementarla **[P]** |
| Permisos por rol y ruta (`can`); autoridad de caja por responsable (`routeCashAuthorityError`) | [T] |
| Aislamiento por empresa: `tenantId` en cada fila y en cada consulta | [T] local; **[P]** en el servidor (RLS o filtro obligatorio) |
| Correcciones como asientos espejo enlazados; ningún dato financiero se borra físicamente | [T] en servicios. **Excepción:** pantallas que borran usuarios, rutas y clientes (`UsersPage`, `RoutesPage`, `ClientsPage`) **[P]** |
| Auditoría de toda operación financiera | Parcial: `logAction` va fuera de la transacción y como mejor esfuerzo **[P]**. El servidor debe auditar en la misma transacción |
| Idempotencia | `operationId` en 5 servicios y estado releído en desembolsos, aprobaciones, anulaciones y cierres **[T]**. **Falta** en pagos, venta directa y altas **[P]** |
| Instantes del servidor (no del dispositivo) para cuadres, cierres y periodos | **[P]** |
| Conservación del capital y `Base = Sin asignar + Σ posiciones` después de cada comando | [T] (`capitalcontrol`, `routebase`, `capitalcustody`) |
| Ningún desembolso, entrega ni retiro deja negativos la Base, la caja o la bolsa | [T] |

## 4. Matriz de cobertura

| Suite | Casos | Invariantes que protege |
|---|---|---|
| permissions | 559 | Matriz de roles, incompatibles, alcance por ruta y empresa |
| financial (payments) | 180 | Pagos, tope, parcelas, contratos Dexie, paridad entre interfaces |
| bootstrap / platform / migrations | 159 / 64 / 62 | Alta de instalación, plano de control y migraciones de esquema |
| settlements | 40 | Cierres semanales y protección de periodos para correcciones |
| workercash | 123 | Cuadre por trabajador, fronteras por instante, Supervisor |
| basecash / routebase / supervisorbase / workertransfer | 45 / 21 / 20 / 22 | Base única, custodia, conciliación, concurrencia local |
| capitalcontrol / adminpool / adminexpense / expensecash / expenseclassification | 47 / 8 / 19 / 14 / 31 | Capital por Administrador, bolsas, gastos |
| financialreversal / paymentreversal / paymentsync | 15 / 31 / 31 | Anulaciones y sincronización de estados |
| transferops / movementhistory | 10 / 10 | Asistente de transferencias, historial, Caja socios |
| activecredit / interestrate | 10 / 8 | Crédito activo, tasas por rol |
| disbursement / capitalcustody / periodauthority | 13 / 28 / 30 | Rondas 6B, 6C y 6C.1 (desembolso único, D24–D30, D7) |

**Ninguna** de estas pruebas puede demostrar garantías **entre dispositivos**: todas se ejecutan sobre una sola base. Esas garantías son **[P]** por definición hasta que exista un servidor (ver [riesgos de concurrencia](./RIESGOS_CONCURRENCIA_SAAS_2026-10.md)).
