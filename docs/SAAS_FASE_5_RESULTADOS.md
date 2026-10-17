# ADEX Soluciones — Fase 5 del SaaS (recaudos y gastos centralizados): resultados

| | |
|---|---|
| Fecha | 2026-10-17 · base `main` @ `cc22ba0` |
| Autorización | Implementar y probar localmente. **Sin** commit, push, despliegue, migración en ADEX-Staging ni datos reales |
| Código | [`0013_collections_expenses.sql`](../saas/db/migrations/0013_collections_expenses.sql) · [`saas/src/collections/service.ts`](../saas/src/collections/service.ts) · [`saas/src/expenses/service.ts`](../saas/src/expenses/service.ts) · pantallas [`Collections.tsx`](../online/src/screens/Collections.tsx) y [`Expenses.tsx`](../online/src/screens/Expenses.tsx). CLEAN (`src/`) no cambia |
| Motor | El de las Fases 3–4: Empresa → bolsa del Administrador → custodia del trabajador por ruta. Sin caja de ruta. Solo en línea (DS-07) |

## Recaudos

| Regla (CLEAN `registerPayment` / `annulPayment`) | En el servidor |
|---|---|
| Métodos de pago | **Solo efectivo.** `transferencia` y `otro` existen en el modelo, pero ninguna pantalla de CLEAN los crea y el libro no tiene cuenta bancaria: no se habilitan |
| Crédito cobrable | Activo, desembolsado, con cuotas y con asiento de desembolso (los sembrados sin asiento se rechazan: `CREDIT_NOT_LEDGERED`) |
| Tope al saldo | Se guarda lo aplicado, nunca lo pedido; sin saldo a favor (`capped`, `cappedMinor` en la respuesta) |
| Cascada | Por número de cuota sobre el total pagado neto (= `recalculateSaleFromPayments`); estado de cuota y días de mora con la fecha de la empresa. Paridad aleatoria con el motor de CLEAN: PAR-001 |
| Responsable del efectivo | `resolveResponsibleCollector` (importado): quien tiene caja personal responde por lo suyo; un actor administrativo indica al trabajador, o se atribuye al único Cobrador de la ruta; sin Cobrador en la ruta, el cobro va a la **bolsa del responsable** (C1, `COBRO_NO_PERSONAL`). Un cobro recibido por un trabajador **nunca** sube una bolsa |
| Fecha contable | La del servidor en la zona de la empresa; el reloj del dispositivo no cuenta |

Asiento `COLLECTION`: receptor +X · cartera de la ruta −capital · interés de la ruta −resto. El capital se reconoce en la proporción capital/total del crédito, acumulada: tras cobrar *P*, capital = round(*P* × capital / total). **F5-D01 · APROBADA por el propietario (2026-10-17):** capital recuperado acumulado = redondeo determinista de pagado acumulado × capital / total pactado; interés acumulado = pagado − capital; cada pago imputa la diferencia entre los acumulados antes y después. Es una clasificación financiera interna del SaaS, no una política fiscal o contable legal para Colombia o Brasil. CLEAN no fijaba esta imputación (solo estimaba el interés por cobrar con la misma proporción); el efectivo, las cuotas, el saldo y el tope no dependen de ella. Pruebas SPLIT-A…E. Al saldar, la cartera del crédito queda en 0 y el interés acumulado es exactamente el pactado. La cuenta `income` (por ruta) es una contrapartida: mide lo ganado, nunca es positiva y no es una caja.

**Anulación** (`payment.reverse`: Administrador y SuperAdmin): asiento espejo y pago espejo (`reversal`), original `reversed`, recálculo canónico del crédito (se reabre y se limpia la fecha sellada). Exige que quien recibió el dinero aún lo tenga (`FUNDS_ALREADY_USED`; nunca se devuelve dinero ya usado). Nadie anula un cobro que redujo su propia custodia, tampoco con otra membresía (DS-05). D7 (6C.1): si la semana del pago está cerrada, la anulación va a hoy y exige `payment.approveAdjustment`; si hoy también está cerrado, no hay anulación.

## Gastos

| Ámbito | Fuente financiera (quién paga) | Autoridad (CLEAN) | Fondos |
|---|---|---|---|
| Trabajador | Su custodia en la ruta | `expense.register`; cargarlo a otra persona exige `settle` (responsable, SuperAdmin o Supervisor de la ruta) | **Sin tope** (73209ce) |
| Ruta | Bolsa del responsable de la ruta (C1, `GASTO_RUTA`) | `cashCustody.manage` + `structural` (solo el responsable) | Sin negativos |
| Empresa | Bolsa elegida: el Administrador, la suya; el SuperAdmin, la de la empresa (D10) o la de un Administrador activo (D11) | `expense.register` + `cashbox.viewConsolidated` | Sin negativos |

La ruta y el trabajador son **atribución**: la cuenta `expense` acumula el gasto por ruta (o de empresa) y no es una caja. Caja socios (D1) no paga gastos. El Secretario no registra gastos (como en CLEAN).

### Gasto del trabajador que supera su efectivo

La Fase 3 dejó la custodia sin negativos. La solución conserva 73209ce sin crear dinero:

- La custodia **puede** quedar negativa, y **solo** por una operación `WORKER_EXPENSE`. Lo impide en la base un disparador sobre las patas (`guard_custody_negative`): cualquier otro débito que dejara la custodia bajo cero se rechaza como sobregiro.
- Por eso un negativo no se devuelve a la bolsa, no se traspasa, no se reasigna, no paga desembolsos y no permite anular entregas ni cobros (todos exigen saldo − arrastre ≥ importe). Ninguna bolsa ni la empresa lo cubren.
- Es la posición del ciclo («Mi efectivo»), como en CLEAN: la Base nueva y los cobros posteriores la compensan. El cuadre (Fase 6) lo concilia; si la empresa reembolsa ese adelanto sigue siendo una decisión abierta.
- Conservación intacta: Σ saldos de la empresa = 0. La conciliación comprueba pata a pata que todo negativo de custodia procede de un gasto del trabajador.

### Correcciones

- Gastos de bolsa (D12): anulación total (no con reintegros previos) y reintegros parciales idempotentes hasta lo no reintegrado. Administrador: su bolsa; SuperAdmin: cualquiera.
- Gastos de ruta y de trabajador — **F5-D02 · APROBADA por el propietario (2026-10-17)**: anulación total auditada.
  - Autoridad: `expense.correct` + autoridad `correct` de CLEAN sobre la ruta = Administrador responsable de capital de la ruta o SuperAdmin. Cobrador, Supervisor, Secretario y Owner, no.
  - Independencia: quien anula no puede ser la **persona** que registró el gasto, comparando identidades (también con otra membresía; también el SuperAdmin): 403 `SELF_CORRECTION_FORBIDDEN`.
  - D7: la anulación se asienta hoy, que debe estar abierto. Si la semana del gasto está cerrada, es un ajuste nuevo en el periodo abierto que exige la autoridad de aprobar ajustes vigente (`payment.approveAdjustment`: Administrador y SuperAdmin, los mismos roles que tienen `expense.correct`). El original y el cierre no cambian; no hay reapertura automática.
  - Efecto: el importe vuelve a la cuenta que pagó: la custodia del trabajador (corrige el negativo que causó ese gasto, nunca más) o la bolsa que financió el gasto de ruta, aunque después cambie el responsable.
  - Una sola anulación por gasto, idempotente, atómica, auditada (motivo, persona que registró, fecha original y si el periodo estaba cerrado). Sin reintegros parciales (D12 los limita a gastos de bolsa).
- Los gastos de bolsa conservan D12 sin la regla de independencia (no se impone retroactivamente).
- Los históricos sin asiento (D9) no se corrigen por esta vía. La anulación genérica de capital no se usa para recaudos ni gastos.

## Endpoints (todos con `X-Adex-Operation-Id` obligatorio en los comandos)

| Endpoint | Autoridad |
|---|---|
| `POST /v1/collections` · `GET /v1/collections[/:id]` | `payment.register` · `payment.viewHistory` (por ruta, RLS) |
| `POST /v1/collections/:id/reverse` | `payment.reverse` (+ `payment.approveAdjustment` con semana cerrada) |
| `POST /v1/expenses` · `GET /v1/expenses[/:id]` | según el ámbito (tabla anterior) · RLS: de ruta, quien la gestiona; cualquiera, los suyos; de empresa, SuperAdmin y el Administrador de esa bolsa |
| `POST /v1/expenses/:id/reverse` · `POST /v1/expenses/:id/refunds` | `expense.correct` + D12 (bolsa) o F5-D02 (ruta y trabajador); reintegros solo de bolsa |
| `GET /v1/operations/:id` (ADEX Online v1) | Recuperación de resultados inciertos |

## Seguridad e integridad

- Escritura **solo** por `adex.collection_post`, `collection_reverse`, `expense_post`, `expense_reverse` y `expense_refund` (SECURITY DEFINER, solo `adex_api`). La API no tiene INSERT/UPDATE en pagos, gastos, créditos, cuotas ni libro; un pago o gasto sin asiento creado por la API es imposible (disparador).
- Cada comando, en una transacción: operación idempotente, pago o gasto, cuotas y crédito, operación y patas del libro, auditoría. Un fallo antes del COMMIT no deja nada.
- Segunda barrera `ctx_can` ampliada (pagos, gastos, custodia) y verificada contra `can()` de CLEAN para cada rol y capacidad (CAN-SQL-001).
- Orden de bloqueos: consultivos de REVOKE-004 → ruta (compartido: deja correr cobros simultáneos de la ruta y frena el cambio de responsable o un cierre) → crédito o gasto → pago → cuentas en orden global. Medición: **0 interbloqueos** en ráfagas mixtas (CC5-011).
- **Corrección de la Fase 3 hallada aquí** (CC5-004): dos transacciones que creaban a la vez la misma cuenta nueva chocaban en el índice `capital_accounts_key` y una fallaba con 409 `CONFLICT`. `capital_account_for` absorbe ahora el conflicto en cualquier índice.

## Conciliación (`GET /v1/capital/reconciliation`)

Además de las comprobaciones de las Fases 3–4: cartera de cada ruta = capital de sus créditos − capital cobrado; cada crédito cumple saldo = Σ cuotas = total − Σ pagos y capital reconocido = round(pagado × capital / total); cada pago y cada gasto tiene su asiento (mismo importe y ruta); cuenta de gastos = Σ gastos netos; custodia negativa solo por gastos del trabajador.

## Pruebas

| Batería | Resultado |
|---|---|
| SaaS local (`npm test`: typecheck + unitarias + PostgreSQL 17 real, 0001–0013) | **13/13 + 281 PASS · 0 FAIL · 1 SKIP** (RND-060, SIGTERM en Windows, preexistente) con F5-D01 y F5-D02 aplicadas. Base antes de la fase: 13 + 223 |
| Decisiones F5-D01 y F5-D02 | `collections-split` 5 (SPLIT-A…E: F5-D01, redondeos y pago final) · `expenses-reversal` 11 (REVX-001…017/019: F5-D02) · EXP-011 (D12 concurrente); EXP-009 con el comportamiento aprobado |
| Nuevas | `collections` 15 (COL-001…010/099, PAR-001, REV-001…003) · `expenses` 15 (EXP-001…010/099, SEC5-001…003, CAN-SQL-001) · `collections-concurrency` 11 (CC5-001…011) |
| Ajustadas | CAP3-001 (dos campos nuevos en el resumen); helper `reconcile` (custodia negativa solo por gasto del trabajador) |
| ADEX-Staging | **No ejecutado** (no autorizado). `staging-phase5` (STG-P5-001…006/099) queda preparada y registrada en `staging.ts --test` |
| CLEAN | **1.637 / 1.637** (banco de 27 suites); `src/` sin cambios; bundle `index-C1zR2rb4.js` idéntico |
| ADEX Online | `tsc` + `vite build` sin errores; SEC5-003 (sin almacenamiento financiero local; comandos con id de operación). Sin E2E de navegador: el existente necesita ADEX-Staging |

## Pendiente (no implementado)

- Métodos de pago distintos del efectivo (necesitan cuenta bancaria en el libro: decisión).
- Corrección con reemplazo del Secretario y solicitudes de ajuste de periodo cerrado (el modelo del Secretario no está aprobado). Hoy una corrección es anular y registrar un cobro nuevo (con fecha de hoy).
- Visitas sin pago, cuadres y cierres (Fase 6, incluido qué hacer con el negativo del trabajador al cuadrar), castigo D28, reportes.
- 0013 en ADEX-Staging (requiere autorización; la batería `staging-phase5` queda preparada).
