# ADEX Soluciones — Fase 3 del SaaS (capital centralizado y custodia): resultados

| | |
|---|---|
| Fecha | 2026-10-16 · base `main` @ `1ebab80` |
| Autorización | Fase 3 autorizada por el propietario: capital y custodia en PostgreSQL, staging sintético. Sin despliegue comercial, sin migrar CLEAN, sin dinero real |
| Modelo | Empresa → bolsa del Administrador → custodia del trabajador por ruta. **Sin caja financiera de ruta** ([C1/C2](./CAPITAL_CENTRALIZADO_C1_2026-10.md)) |
| Código | [`saas/db/migrations/0009_capital_custody.sql`](../saas/db/migrations/0009_capital_custody.sql) · [`saas/src/capital/service.ts`](../saas/src/capital/service.ts) (CLEAN no cambia) |

La fila «Fase 3» del [plan](./PLAN_MIGRACION_SAAS_2026-10.md) describe todavía cajas de ruta y las suites v16 (`capitalcontrol`, `basecash`, `routebase`…). Esa parte quedó sustituida por la decisión del capital centralizado: aquí se aplica el modelo C1 y su suite `centralcapital` donde es aplicable.

## Modelo de datos (0009)

| Tabla | Contenido |
|---|---|
| `capital_accounts` | Posición materializada por cuenta: `company`, `admin` (bolsa), `custody` (ruta × trabajador), y las contrapartes `external` (depósitos/retiros) y `partner` (aportes de cada socio). `carried_minor` reservado para el arrastre de faltantes (Fase 6). CHECK: empresa, bolsas y custodias nunca negativas |
| `capital_operations` | Una fila por operación: tipo, importe en unidades menores, moneda de la empresa, ruta(s), bolsa, trabajador(es), solicitud opcional, motivo, fecha contable en la zona de la empresa, actor (membresía, identidad, rol), `txid`. `operation_id` único por empresa; una anulación por operación |
| `capital_entries` | Patas con signo y saldo resultante. Σ patas de cada operación = 0 (comprobado al COMMIT) |

No existe cuenta, tabla ni fila de saldo de ruta (CHECK de forma por tipo). Operaciones y patas son inmutables (sin UPDATE/DELETE/TRUNCATE, también para el administrador de la base). Conservación: Σ de todos los saldos de una empresa = 0.

## Comandos (`POST /v1/capital/…`, `X-Adex-Operation-Id` obligatorio)

| Comando | Patas | Autoridad |
|---|---|---|
| `company/deposits`, `company/withdrawals` | externa ↔ empresa | SuperAdmin |
| `allocations`, `admin-returns` | empresa ↔ bolsa | SuperAdmin (recibir exige Administrador activo) |
| `partner-contributions` | socio → bolsa del responsable de la ruta | Responsable de la ruta; socio en su alcance. Caja socios (D1) no se toca |
| `deliveries` | bolsa → custodia (ruta, trabajador) | Solo el responsable (`structural`). No crea venta ni deuda; `saleRequestId` opcional |
| `returns` | custodia → bolsa del responsable | `settle`: responsable, SuperAdmin o Supervisor de la ruta |
| `worker-transfers` | custodia → custodia, misma ruta | `settle`; solo efectivo en manos (saldo − arrastre) |
| `route-reassignments` | custodia r1 → bolsa → custodia r2 (una operación) | Responsable de **ambas** rutas. Responsables distintos → `409 DECISION_PENDING_D2` |
| `operations/:id/reverse` | asiento espejo | `correct` (responsable o SuperAdmin); de empresa, SuperAdmin |

Anulaciones: nunca sobre capital consumido (entrega ya usada → `FUNDS_ALREADY_USED`; bolsa sin fondos → `INSUFFICIENT_FUNDS`), una sola vez, una anulación no se anula y un **retiro de la empresa no se anula** (reintroduciría dinero: se registra un depósito). Las patas de bolsa de entregas y devoluciones van a la bolsa que **hoy** responde por la ruta (como C1).

Nadie reduce su propia custodia, **tampoco con otra membresía de la misma persona** (DS-05: se compara la identidad, más estricto que CLEAN, donde cada rol era otra cuenta).

Consultas: `summary` (SuperAdmin: empresa y todas las bolsas; Administrador: solo la suya), `custody`, `operations`, `operations/:id`, `reconciliation` (SuperAdmin).

## Seguridad (doble barrera)

1. **Exposición corregida (bloqueante).** Un Cobrador asignado a una ruta leía libro de capital, movimientos y retiros de la ruta, transferencias, eventos de responsable, cierres semanales, la custodia y los cuadres de otros y la auditoría de la ruta. Ahora cada tabla se lee por rol (`cashbox.viewRoute`, `capital.manage`, `audit.view`) o solo lo propio.
2. **Escritura** únicamente por `adex.capital_post` (SECURITY DEFINER, solo `adex_api`): la API no tiene INSERT/UPDATE/DELETE sobre el libro. La función relee bajo bloqueo contexto activo y sesión, rol, responsable, custodio, ruta operativa, periodo abierto (D7) y fondos. Los errores no llevan cifras.
3. Visibilidad: Cobrador → solo su custodia; Administrador → su bolsa y custodias de sus rutas; Supervisor/Socio → custodias de sus rutas; SuperAdmin → su empresa; Owner (`adex_control`) → nada.

## Concurrencia e idempotencia

- Orden global de bloqueos: consultivos de REVOKE-004 → filas de rutas (id asc) → cuentas (empresa → bolsas → custodias → contrapartes). La ruta va antes que las bolsas porque fija el responsable (R5); medición: **0 interbloqueos** en PostgreSQL en ráfagas cruzadas.
- Idempotencia en dos niveles: `adex.operations` (mismo id + mismos datos → misma respuesta; otros datos u otra membresía → 409) y `capital_operations.operation_id` único.
- Todo en una transacción: un fallo antes del COMMIT no deja operación, patas, saldos, idempotencia ni auditoría.

## Pruebas

| Batería | Resultado |
|---|---|
| SaaS local (`npm test`: typecheck + unitarias + PostgreSQL 17 real, 0001–0009) | **186 PASS · 0 FAIL** (13 + 173). Nuevas: CAP3-001…018, SEC3-001…010, CONC3-001…009 |
| Ajustes en pruebas anteriores | `structure` (código `ROUTE_INITIAL_CAPITAL_NOT_ALLOWED`), CAP-002 (`base_at_change_minor` = Σ custodias), SCHEMA-005 (tres tablas nuevas) |
| ADEX-Staging (`staging:test`, Auth real + pooler) | **27/27 en tres ejecuciones consecutivas** (19 de Fases 1–2 + STG-P3-001…007/099) |
| CLEAN (27 suites, banco de contratos) | **1.637 / 1.637**; `src/` sin cambios; bundle `index-C1zR2rb4.js` idéntico |

## ADEX-Staging

Destino verificado antes de escribir (referencia `hyqaufsagtsucztjfjvc`, sa-east-1, huella 0001–0008, Auth sin usuarios no sintéticos, `public` vacío). `staging:migrate` aplicó solo `0009`. Cada ejecución crea su propia empresa sintética (BRL) con dos usuarios reales de Auth que se borran al terminar; las filas sintéticas se conservan (historia inmutable). Ningún dato de CLEAN.

## Pendiente (no implementado)

- D1 (Caja socios con saldo), retiro o devolución de la bolsa a un socio, D2 (movimientos entre responsables distintos), D3, D4, D19–D23, D27, Secretario.
- Desembolsos (Fase 4), gastos (Fase 5; deberá admitir la custodia negativa por gastos del trabajador, regla 73209ce), cuadres y cierres (Fase 6; mantendrá `carried_minor`).
- Venta directa de ciertos Cobradores: sin cambios.
- Menores: registro de intentos denegados (DS-14); desactivar a un trabajador con custodia no se bloquea (su efectivo se puede devolver igualmente).
