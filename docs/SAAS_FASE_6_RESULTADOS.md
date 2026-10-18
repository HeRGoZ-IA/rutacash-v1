# ADEX Soluciones — Fase 6 del SaaS (cuadres y cierres): resultados

| | |
|---|---|
| Fecha | 2026-10-17 · base `main` @ `186f90d` |
| Autorización | Fase 6 — Cuadres y Cierres (propietario, 2026-10-17). DS-04 y F6-D01 aprobadas ese día |
| Código | [`0014_settlements_closures.sql`](../saas/db/migrations/0014_settlements_closures.sql) · [`saas/src/settlements/service.ts`](../saas/src/settlements/service.ts) · pantallas [`Settlements.tsx`](../online/src/screens/Settlements.tsx) (Cuadres y Cierres). CLEAN (`src/`) no cambia |
| Motor | El de las Fases 3–5: Empresa → bolsa del Administrador → custodia del trabajador por ruta. Sin caja de ruta. Solo en línea (DS-07) |

## 1. Conceptos y dónde vive cada uno

| Concepto | Objeto | Mueve dinero | Cierra otra cosa |
|---|---|---|---|
| Entrega parcial | `WORKER_RETURN` (Fase 3, sin cambios de API) | Custodia → bolsa del responsable | No |
| Cuadre | `adex.custody_settlements` + asientos `SETTLEMENT_RETURN` / `SETTLEMENT_SURPLUS` | Solo el efectivo reconocido (y el sobrante a control) | No cierra la semana |
| Liquidación | `adex.route_period_figures` (consulta) | No | No |
| Cierre de periodo | `adex.weekly_settlements` (la fila que ya protege D7 en todas las funciones de dinero) + `adex.period_closures` (archivo inmutable) | No | No inventa entregas |

`cash_settlements` (0002) sigue siendo el histórico importado de CLEAN (DS-06). La ruta es atribución: el consolidado de ruta solo suma posiciones.

## 2. Cómo funciona el cuadre

**Ciclo por el libro, no por fechas.** Toda escritura bloquea la fila de la cuenta antes de insertar su pata; la nueva columna `capital_entries.seq` ordena así las patas de cada custodia en el orden en que se confirmaron. El ciclo de un cuadre son las patas con `from_seq < seq ≤ to_seq`; el siguiente empieza en el corte del anterior (`closing_seq`). Dos cuadres el mismo día son dos ciclos (CLEAN), y cada movimiento cae exactamente en uno (F6-G, CC6-003).

**Comando** `POST /v1/settlements` → `adex.custody_settle`, en una transacción:

1. Contexto activo (REVOKE-004), `cashSettlement.close` y autoridad `settle` (responsable de capital, SuperAdmin o Supervisor de la ruta); nunca la misma **persona** que se cuadra, comparando identidades (también con otra membresía).
2. Bloqueos en el orden vigente: ruta (compartido) → bolsa del responsable y custodia (orden global de cuentas).
3. Bajo bloqueo: posición *P* = saldo de la custodia, recalculada desde las patas del ciclo y comprobada. Si el esperado que vio la pantalla o el cuadre anterior que vio no coinciden → `409 SETTLEMENT_STALE` (sin cifras).
4. Diferencia, faltante, sobrante, retorno a la bolsa y arrastre (§3); motivo ≥ 10 caracteres si hay diferencia.
5. Asientos, arrastre, documento versionado y auditoría en la misma transacción. Idempotente por `X-Adex-Operation-Id`.

**Entrega parcial**: la devolución de la Fase 3. Baja la custodia y sube la bolsa; no cierra el cuadre; el cuadre la ve ya descontada (`partialReturnsMinor`) y no la vuelve a contar. Nadie registra su propia entrega (`AX410`, por identidad). Ahora no puede usar el faltante arrastrado (§3.1).

**Reapertura** `POST /v1/settlements/:id/reopen` (CLEAN `reopenCashSettlement`): `cashSettlement.reopen` + `correct`, motivo ≥ 10, solo el último cuadre vigente, nunca la propia persona, y **solo si el día del cuadre y hoy están en periodo abierto** (D7). Revierte el retorno desde la bolsa que lo recibió (si ya no lo tiene: `409 FUNDS_ALREADY_USED`), libera el sobrante y devuelve el arrastre al anterior. Volver a cerrar crea la versión siguiente del mismo ciclo y sustituye a la reabierta.

## 3. Los tres puntos contables

Notación: *P* posición (saldo de la custodia), *E* = máx(*P*, 0) efectivo esperado, *D* entregado, dif = *D* − *E*, *T* = mín(*D*, *E*) a la bolsa.

### 3.1 Faltantes y `carried_minor`

- **CLEAN**: `arrastre(N+1) = máx(0, −dif(N))`; el esperado del ciclo siguiente lo suma. `transferableCash` = posición − arrastre.
- **Esquema**: `carried_minor` existía desde 0009 («lo mantiene la Fase 6»), sin uso.
- **Diseño**: el faltante se queda **dentro** de la custodia (es lo que el trabajador sigue debiendo) y se marca en `carried_minor`. Saldo − arrastre = efectivo utilizable = 0. Nueva guardia en la base sobre **todas** las patas que debitan una custodia: deben dejar saldo ≥ arrastre (salvo el gasto del trabajador, regla 73209ce, y el retorno del propio cuadre). Así el arrastre no financia devoluciones, traspasos, desembolsos ni anulaciones. Con arrastre 0 (todo lo anterior a la Fase 6) es exactamente la regla de 0013.
- **Ejemplo (F6-B)**: esperado 500.000, entregado 450.000 → bolsa +450.000, custodia 50.000, arrastre 50.000, disponible 0. Ciclo 2: cobra 100.000 → esperado 150.000 (el faltante una vez), disponible 100.000. Entrega 100.000 → faltante sigue siendo 50.000 (no 100.000). Ciclo 3: entrega 50.000 → exacto, arrastre 0. Bolsa total: 500.000 + 100.000.
- **Cambio de comportamiento frente a CLEAN (instruido en el encargo, §6.4)**: en CLEAN una devolución de Base podía saldar el faltante; aquí el faltante se repone en el cuadre (que puede hacerse en cualquier momento, F6-D01). El dinero sigue el mismo camino; solo cambia el comando.

### 3.2 Sobrantes

- **CLEAN**: el sobrante se registra y motiva; no es saldo a favor; a la bolsa va *D* − sobrante (`cuadreReturnToPool`). El efectivo de más quedaba fuera de todo libro.
- **Diseño**: dos cuentas de **control** por ruta: `suspense` (efectivo recibido sin identificar, en manos del responsable que lo recibió) y `unidentified` (su origen, contrapartida ≤ 0). Asiento `SETTLEMENT_SURPLUS`: `unidentified` −U, `suspense` +U. Σ = 0. Ninguna función debita `suspense` (salvo la reapertura del propio cuadre), no entra en «disponible» de bolsa ni de empresa, y la conciliación comprueba que coincide con los sobrantes vigentes.
- **Ejemplo (F6-C)**: esperado 500.000, presentado 530.000 → bolsa +500.000, control +30.000, origen −30.000, custodia 0. El capital de la empresa no cambia.
- **Decisión pendiente F6-D02** (no tomada): qué hacer con un sobrante sin identificar (devolverlo, reconocerlo como ingreso, imputarlo a un cobro o a un aporte). Hasta entonces queda en control, visible para el SuperAdmin (`unidentifiedSurplusMinor`) y el Administrador que lo tiene.

### 3.3 Posición negativa por gastos

- **CLEAN**: el esperado podía ser negativo; al cuadrar, dif = *D* − *P* lo convertía en «sobrante» y el arrastre volvía a 0: el adelanto del trabajador desaparecía sin dinero (un reembolso implícito).
- **Diseño** (Fase 5 + §6.6 del encargo): *E* = 0, nada vuelve a la bolsa, no hay devolución ficticia; el negativo **sigue** en la custodia como apertura del ciclo siguiente y lo compensan las operaciones válidas posteriores. Disponible = 0. Sin reembolso automático. Si se presentara dinero con posición negativa, todo es sobrante (no paga el adelanto).
- **Ejemplo (F6-F)**: Base 20.000, gasto 50.000 → −30.000; cuadre con 0 → exacto, a la bolsa 0, custodia −30.000. Base nueva 100.000 → esperado 70.000; entrega 70.000 → custodia 0.

## 4. Periodos (DS-04) y cierres

- Fecha contable = hoy en la zona horaria de la empresa, según el reloj del servidor (`adex.company_today`); `GET /v1/periods/calendar` la expone con la semana propuesta (lunes–domingo anterior). Nunca la hora del navegador.
- Cierre `POST /v1/periods/close`: `settlement.close` + `correct` (responsable de capital o SuperAdmin), bloqueo exclusivo de la ruta (espera a lo que está en curso), **D29** (el fin del rango debe ser anterior a hoy de la empresa), sin duplicados ni solapes, cifras del libro (por `entry_date`) archivadas en `period_closures` con huella de las operaciones, versión, Oficina y responsable al cierre.
- Lo cerrado no se reescribe: ningún asiento se fecha en el pasado; las correcciones posteriores son asientos nuevos de hoy, enlazados al original y con la autoridad de ajuste vigente (F5-D02, `collection_reverse`). La conciliación recalcula cada periodo cerrado y exige que coincida con su archivo.
- **No hay reapertura de semanas en el SaaS**: en el servidor todos los asientos se fechan hoy, así que reabrir una semana solo relajaría la autoridad de ajuste. Se corrige siempre en el periodo abierto (§6.10 del encargo).

## 5. Endpoints (comandos con `X-Adex-Operation-Id` obligatorio)

| Endpoint | Autoridad |
|---|---|
| `GET /v1/settlements/preview?routeId&workerId` | `cashSettlement.viewOwn` (propio) o `cashSettlement.view` |
| `GET /v1/settlements/workers?routeId` | `cashSettlement.view` |
| `POST /v1/settlements` · `GET /v1/settlements[/:id]` | `cashSettlement.close` + `settle` · RLS (quien gestiona la ruta o el propio trabajador) |
| `POST /v1/settlements/:id/reopen` | `cashSettlement.reopen` + `correct` |
| `GET /v1/periods/calendar` · `GET /v1/periods/liquidation?routeId&from&to` · `GET /v1/periods[/:id]` | contexto · `cashbox.viewRoute` |
| `POST /v1/periods/close` | `settlement.close` + `correct` |

## 6. Seguridad e integridad

- Escritura **solo** por `adex.custody_settle`, `custody_settlement_reopen` y `period_close` (SECURITY DEFINER, solo `adex_api`); ningún privilegio de escritura nuevo para la API (TEN-003). `capital_post` no crea ni anula asientos de cuadre (`AX411`); la anulación genérica responde `409 REVERSAL_NOT_ALLOWED`.
- Segunda barrera `ctx_can` ampliada con `cashSettlement.*`, `settlement.*` y `cashbox.viewRoute`, verificada contra `can()` de CLEAN (CAN-SQL-001).
- RLS: cuadres visibles para quien gestiona la ruta o el propio trabajador; cierres como `weekly_settlements`; cuentas de control solo para el SuperAdmin y el Administrador que las tiene. El Owner no tiene acceso. Los rechazos no llevan cifras.
- Conciliación (`GET /v1/capital/reconciliation`) ampliada: arrastre = faltante del último cuadre vigente; cada cuadre coincide con el libro (posición hasta su corte, retorno y sobrante con sus asientos, reapertura con su anulación); control de sobrantes = Σ sobrantes vigentes; periodos cerrados sin cambios.

## 7. Pruebas

Ver la sección de resultados del informe de cierre de la fase (local, ADEX-Staging y publicación).
