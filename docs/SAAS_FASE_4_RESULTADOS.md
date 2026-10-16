# ADEX Soluciones — Fase 4 del SaaS (créditos, autorizaciones y desembolsos): resultados

| | |
|---|---|
| Fecha | 2026-10-16 · base `main` @ `e582299` |
| Autorización | Fase 4 autorizada por el propietario. ADEX Online, primera versión: **solo en línea** (sin operaciones financieras offline, sin cola diferida, sin libro local paralelo) |
| Código | [`0010_credits_disbursements.sql`](../saas/db/migrations/0010_credits_disbursements.sql) · [`saas/src/credits/service.ts`](../saas/src/credits/service.ts) (CLEAN no cambia) |
| Motor | El de la [Fase 3](./SAAS_FASE_3_RESULTADOS.md): Empresa → bolsa del Administrador → custodia del trabajador por ruta, sin caja de ruta |

## Estados

| Estado | Qué significa | Dinero | Deuda del cliente |
|---|---|---|---|
| `pending` | Solicitud creada | No | No |
| `approved` | Condiciones finales fijadas por quien autoriza | No | No |
| `disbursed` | El dinero salió: crédito, cuotas y asiento en **una** transacción | Sí, una vez | Sí |
| `rejected` | Rechazada con motivo | No | No |
| `cancelled` | Aprobada que no se entregará (Admin/SuperAdmin, motivo) | No | No |

Diferencia con CLEAN (justificada por la decisión de separar aprobación y desembolso): en CLEAN, aprobar ya creaba la venta «pendiente». Aquí la obligación nace solo al desembolsar. Para la regla del segundo crédito, una solicitud aprobada cuenta como crédito activo (equivale a la venta pendiente de CLEAN).

## Endpoints

| Endpoint | Autoridad (CLEAN `can()`) |
|---|---|
| `POST /v1/credit-requests` | `sale.createRequest`: SuperAdmin, Admin, Supervisor, Cobrador |
| `POST …/:id/approve` (condiciones opcionales) | `authorization.approve`; cambiar tasa/frecuencia/días: `modifyConditions`; confirmación telefónica: `phoneConfirm` (Admin no la tiene) |
| `POST …/:id/reject`, `POST …/:id/cancel` | `authorization.reject`; `sale.cancel` (Admin, SuperAdmin) |
| `POST …/:id/disburse` · `POST /v1/credits/direct` | `sale.confirmDisbursement`; `sale.createDirect` (SuperAdmin, Admin, Supervisor). `X-Adex-Operation-Id` obligatorio |
| `GET /v1/credit-requests[/:id]`, `GET /v1/credits[/:id]` | Por ruta y rol (RLS); el Cobrador ve sus solicitudes; el detalle de crédito incluye cuotas, patas visibles y eventos visibles |

## Política aplicada (sin cambios respecto de CLEAN)

- Tasas 10 % y 20 %; el Cobrador origina solo al 20 %; el 10 % lo fija quien autoriza.
- El Cobrador no vende directo (la libertad por Cobrador **no** se habilita: pendiente de decisión). El Supervisor vende directo hasta el límite de la ruta; por encima, solicitud.
- Una solicitud pendiente por cliente; crédito activo evaluado en toda la empresa (`decideSaleOrigination`).
- Nadie resuelve su propia solicitud, **tampoco con otra membresía de la misma persona** (DS-05).
- Totales y calendario con el motor de CLEAN (`calculateTotalWithInterest`, `generateInstallments`) sobre unidades menores; PostgreSQL comprueba número, importes, suma y fechas.

## Custodia, capital y cartera

- Entregar capital al Cobrador **no** crea deuda; tenerlo **no** autoriza a prestar.
- Desembolso del Cobrador o Supervisor: sale de **su** custodia en esa ruta (sin el faltante arrastrado, D25). La bolsa no paga otra vez.
- Desembolso administrativo o venta directa del Admin: sale de la bolsa del **responsable** de la ruta (solo él o el SuperAdmin, D30/C1).
- Asiento `LOAN_DISBURSEMENT`: pagador −X, **cartera de la ruta** (`portfolio`) +X. El interés no se contabiliza como dinero hasta cobrarse (sin capital ficticio). Σ del libro = 0.
- Un desembolso no se anula (`REVERSAL_NOT_ALLOWED`): el dinero está en manos del cliente.

## Integridad, idempotencia y concurrencia

- Único camino para crear un crédito: `adex.credit_disburse` (SECURITY DEFINER). La API no tiene INSERT en `sales` ni `installments`; un crédito creado por la API sin asiento es imposible (disparador).
- Solicitudes: escritura por columnas + guardia de transiciones en PostgreSQL (estados, hechos inmutables, tasas, totales, autoaprobación por identidad, capacidades).
- Exactamente una vez: bloqueo de la solicitud, índice único de desembolso por crédito y de crédito por solicitud, y `operation_id` único.
- Orden global de bloqueos: membresías (consultivo) → rutas → solicitud → cuentas.
- **Correcciones encontradas por las pruebas de esta fase:**
  - *Revocación vs. operación* (Fase 2): retirar una ruta bloqueaba la ruta antes que la membresía y podía interbloquearse con una operación en curso de esa persona. Ahora el bloqueo de revocación va primero (`lockMembershipsForRevocation`).
  - *Idempotencia con id en la URL* (Fases 3–4): la huella de la operación no incluía la ruta de la URL; la misma clave reutilizada en otra solicitud devolvía el resultado anterior. Ahora la incluye.

## Conciliación (`GET /v1/capital/reconciliation`)

Además de las comprobaciones de la Fase 3: cada desembolso tiene su crédito (mismo importe y ruta) y viceversa, un crédito por solicitud y cartera de cada ruta = capital de sus créditos con asiento (aún sin cobros).

## Pruebas

| Batería | Resultado |
|---|---|
| SaaS local (`npm test`, PostgreSQL 17 real, 0001–0010) | **210 PASS · 0 FAIL** (13 + 197). Nuevas: CRED-001…014/099 (15), CC4-001…009 (9) |
| ADEX-Staging (`staging:test`, Auth real + pooler, 0001–0010) | **34/34 en tres ejecuciones consecutivas** (27 de Fases 1–3 + STG-P4-001…006/099). Para que conste, dos tandas anteriores tuvieron una ejecución cortada por fallos de DNS local hacia el pooler (`ENOTFOUND`), sin fallos de aserción ni errores 500. Un ajuste de la prueba: el Cobrador recibe 404 (no 403) al intentar aprobar una solicitud ajena porque ni siquiera la ve |
| CLEAN | **1.637 / 1.637**; `src/` sin cambios; bundle `index-C1zR2rb4.js` |

## Pendiente (no implementado)

- Venta sin aprobación individual para Cobradores habilitados (decisión y entrega específicas).
- Cobros de cuotas y visitas (siguiente parte), gastos (Fase 5), cuadres y cierres (Fase 6), castigo D28 en el servidor.
- Operaciones offline (DS-07/DS-08) — fuera de la primera versión de ADEX Online.
- Fotografía de saldos de créditos activos al solicitar: se guardan los ids; el contexto actual se consulta en vivo.

## Hacia ADEX Online (entrega mínima propuesta, no iniciada)

Para que propietario y socio usen el primer circuito desde dos dispositivos:

1. **Decidir dónde corre la API en staging** (DS-02 solo cubre PostgreSQL): un proceso Node persistente con HTTPS y CORS hacia el cliente web. Única decisión bloqueante.
2. **Cliente web mínimo conectado al servidor** (separado de CLEAN, sin IndexedDB financiero): inicio de sesión (Supabase Auth), selector de membresía y seis pantallas: clientes de la ruta, bolsa y entrega de capital (Admin), «Mi efectivo» (Cobrador), nueva solicitud, bandeja de autorizaciones y confirmar desembolso.
3. **Empresa de prueba sintética** en staging con las dos identidades reales del propietario y del socio como membresías (sin datos de CLEAN). Precursora de la Empresa Demo reiniciable, que queda para después.
