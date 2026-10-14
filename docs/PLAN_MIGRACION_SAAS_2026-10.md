# ADEX Soluciones — Plan de migración SaaS (Ronda 6/6D)

| | |
|---|---|
| Fecha | 2026-10-12 · `main` @ `520a331` |
| Estado | **Propuesta.** No se inicia ninguna fase sin aprobación expresa del propietario |
| Documento rector | [VISION_Y_PRINCIPIOS_SAAS_ADEX.md](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md): visión multiempresa e internacional y principios P1–P10 que encuadran este plan |
| Supuesto de arquitectura | La recomendación de [ARQUITECTURA_SAAS_PROPUESTA_2026-10.md](./ARQUITECTURA_SAAS_PROPUESTA_2026-10.md) (Postgres + API TypeScript con comandos). Si se elige otra, cambian las herramientas, no las fases ni las puertas |

## 1. Principios

1. **El servidor es el único que escribe dinero.** Durante la transición, cada tipo de operación pasa del modo local al modo servidor **de una sola vez y por empresa**; nunca coexisten escrituras locales y del servidor sobre el mismo tipo de dato.
2. **Ningún navegador es fuente de verdad automática.** Cada base local es una copia parcial y posiblemente divergente: se diagnostica, se exporta, se valida y se concilia **antes** de importar.
3. **Las reglas no se reinterpretan.** Las reglas **vigentes y aprobadas** (D7, D24, D25, D26, D28, D29, D30 y el capital por Administrador v16) se trasladan tal cual. Las decisiones **abiertas** (D1–D4, D19–D23, D27, Secretario) no quedan aprobadas por migrar: se trasladan con el comportamiento actual del motor y se deciden aparte ([decisiones pendientes](./DECISIONES_PENDIENTES_SAAS_2026-10.md) §3). Las pruebas existentes se reutilizan como contrato del servidor.
4. **Cada fase tiene puerta de aceptación y reversión** antes de afectar a una empresa real.
5. **Ningún dato real se modifica fuera de la importación aprobada.** Las anomalías se reportan y las decide el propietario.

## 2. Fases

| Fase | Contenido | Depende de | Puerta de aceptación |
|---|---|---|---|
| **0 · Decisiones y preparación** | Aprobar las decisiones que bloquean el inicio (DS-01, aprobada; DS-02). Definir esquema SQL desde `types.ts` v16. Montar el banco de pruebas de contratos que ejecute las suites actuales contra un adaptador del servidor | — | Decisiones de las que depende esta fase firmadas; el esquema revisado reproduce las 28 tablas (o justifica las que desaparecen, como `cashboxMovements`, legado sin escritores) |
| **1 · Identidad y empresas** | Identidad central (contraseñas con hash, sesiones revocables, recuperación); empresas, usuarios, roles y `authorizedRouteIds` en el servidor; integración con el plano de control | 0, DS-03, DS-05 | Pruebas de aislamiento: un token de A no accede a B; usuario desactivado rechazado; **ninguna contraseña en el cliente** (se eliminan `password` de la sesión y de IndexedDB) |
| **2 · Estructura y catálogo** | Oficinas, rutas (con responsable de capital), asignaciones, categorías, clientes. Las 20 escrituras directas de pantallas pasan a comandos. Se acaban los borrados físicos de usuarios, rutas y clientes con historia (DS-11) | 1 | `permissions` (559) en verde contra el servidor; `withCapitalControllerGuard` como restricción transaccional |
| **3 · Capital y caja** | Libro de capital y bolsas; colocación, retiro y transferencias (con Caja socios y entrega en mano); custodia de Base; filas de saldo con bloqueo ordenado | 2 | `capitalcontrol`, `adminpool`, `basecash`, `routebase`, `workertransfer`, `transferops`, `supervisorbase` en verde contra el servidor; pruebas distribuidas **R2, R4, R5** |
| **4 · Créditos y pagos** | Solicitudes, aprobación, desembolso (D24/D25/D26/D30, estado único) y venta directa; pagos con `operationId`; cola sin conexión **solo** para lo aprobado en DS-07 | 3, DS-07 | `disbursement`, `capitalcustody` (CAP/CASH/AUTH), `activecredit`, `interestrate`, `financial` (180), `paymentsync`; pruebas **R1, R3, R10, R11** |
| **5 · Correcciones, gastos y castigos** | Gastos de trabajador, ruta y bolsa; anulaciones y reintegros; corrección, ajuste y anulación de pagos (`adjustmentEntryDate`); castigos (D28) | 4 | `expensecash`, `adminexpense`, `expenseclassification`, `paymentreversal`, `financialreversal`, LOST6C, REVPER; prueba **R7** |
| **6 · Cuadres y cierres** | Cuadre por trabajador por instante del servidor; liquidación semanal con D29 en la zona horaria de la empresa; `periodGuard` en el servidor; conciliación de ruta y de capital como comprobaciones automáticas | 5, DS-04 | `workercash` (123), `settlements`, WEEK-*, CLOSE6C; prueba **R6** |
| **7 · Migración histórica y piloto** | Exportación, diagnóstico, conciliación e importación de **una empresa piloto**; operación real controlada | 6, DS-06, DS-08 | Ver §4: conciliación firmada por el propietario; smoke de producción y protocolo de dos equipos ([`PROTOCOLO_PRUEBA_DOS_EQUIPOS.md`](./PROTOCOLO_PRUEBA_DOS_EQUIPOS.md)) en el piloto |
| **8 · Despliegue gradual** | Empresa por empresa, con bandera por empresa; retirada del modo local para escrituras | 7 | Cero incidencias críticas en el piloto durante el periodo acordado (DS-12) |

Las fases 1–6 se construyen y prueban en un entorno **de staging con datos sintéticos**. Ninguna empresa real usa el servidor hasta la fase 7.

**Decisiones por fase.** No hace falta aprobar todas las DS-01…DS-12 antes de empezar: cada decisión se aprueba **antes de la implementación que depende de ella**, según la columna «Bloquea» de [decisiones pendientes](./DECISIONES_PENDIENTES_SAAS_2026-10.md) (por ejemplo, DS-03 y DS-05 antes de la Fase 1; DS-07 antes de la 4; DS-04 antes de la 6; DS-06 y DS-12 antes de la 7). Las puertas de aceptación de cada fase se mantienen.

**POC frente a backend.** Las Fases 0A y 0A.1 ([0A](./SAAS_FASE_0A_RESULTADOS.md), [0A.1](./SAAS_FASE_0A1_RESULTADOS.md)) son una prueba de concepto transaccional **sintética y descartable**. Validan el patrón (transacción, bloqueo, idempotencia, auditoría, RLS), pero **el backend financiero multiusuario de ADEX todavía no existe**: se construye en las fases 1–6.

## 3. Estrategia sin conexión segura

- **En línea obligatoria** (D25/D26/D30 y los cierres necesitan el estado del servidor):
  - desembolsos y ventas directas;
  - entrega, devolución y traspaso de Base;
  - colocaciones, retiros y transferencias;
  - cierres y reaperturas;
  - anulaciones y correcciones;
  - castigos;
  - cambio de responsable.
- **Candidatas a cola sin conexión** (DS-07): pagos en efectivo y visitas sin pago. Quizá también los gastos del trabajador, que hoy ya pueden dejarlo en negativo.
  - Cada operación de la cola lleva `operationId`, instante de captura y versión vista del saldo.
  - El servidor la valida al llegar: venta activa y tope. Si el saldo ya se agotó o el periodo se cerró, la marca **para conciliar** sin escribir dinero fuera de las reglas (R3, R6, R11).
- **Lecturas sin conexión:** caché local de solo lectura (la ruta del día), con marca de antigüedad visible. Las cifras de caché nunca deciden un comando.
- IndexedDB pasa a ser **caché y cola**, no base de verdad.

## 4. Datos históricos: diagnóstico, exportación y conciliación

### 4.1 Punto de partida real
- Cada navegador tiene su base. El socio prueba en un solo equipo, pero puede haber más equipos con datos.
- Dos navegadores pueden contener **la misma empresa creada dos veces** con identificadores distintos, o datos que se solapan sin relación.
- **No se fusiona automáticamente** ni se elige un navegador como verdad.

### 4.2 Procedimiento propuesto (por empresa)
1. **Exportación controlada** desde cada navegador. Herramienta de solo lectura que no modifica la base local. Genera:
   - un archivo con todas las tablas de la empresa;
   - un resumen de huellas (recuentos y sumas por tabla y por ruta);
   - la versión de esquema (debe ser v16).
2. **Diagnóstico automático** sobre la exportación, reutilizando las comprobaciones existentes:
   - `financialReconciliation.reconcileFinancials`;
   - `computeRouteCashReconciliation` (`cuadra`) por ruta;
   - `verifyCapitalInvariants`;
   - `paymentLedgerAnomalies`;
   - y la lista de anomalías conocidas (§4.3).
3. **Selección de la fuente** por empresa, **decidida por el propietario** a la vista del informe. Nunca automática.
4. **Importación en staging** con identificadores conservados; repetición del diagnóstico en el servidor (mismos resultados que en el navegador de origen).
5. **Modelo de apertura** (DS-06): importar todo el histórico como **legado de solo lectura** y fijar **saldos de apertura** validados por ruta, bolsa y trabajador a la fecha de corte; o importar el histórico como movimientos vivos si el diagnóstico sale limpio.
6. **Conciliación firmada:** el propietario aprueba saldos, cartera y anomalías antes de activar la empresa. Las diferencias **no** se compensan con asientos automáticos (regla de la pre-Ronda 6).
7. **Congelación local:** al activar la empresa en el servidor, su base local queda de solo lectura y se conserva como archivo.

### 4.3 Anomalías conocidas que el diagnóstico debe detectar y reportar (sin corregir)

| Anomalía | Origen | Detección |
|---|---|---|
| Base de ruta negativa | Desembolsos sin capital antes de la 6C (RC-1/RC-2) | `getRouteBase < 0` |
| Trabajador con posición negativa por desembolsos | Desembolsos sin efectivo antes de la 6C (RC-6) | Posición < 0 con desembolsos en el ciclo |
| Conciliación «NO CUADRA» | Reconfirmación de desembolsos antes de la 6B (RC-3) | `cuadra = false` |
| Venta `perdida` + `desembolsado` con `disbursedAt` ≥ última actualización | Desembolso de venta perdida antes de la 6B | Filtro sobre `sales` |
| Cierres semanales anticipados | Cierres anteriores a D29 | `closedAt < periodClosableFrom(semanaFin)` |
| Reversiones de pagos fechadas dentro de una semana cerrada | `annulPayment` y `executeCorrection` antes de la 6C.1 | Reversión con `fecha` dentro de un cierre cuyo `closedAt` es anterior a su `createdAt` |
| Caja socios negativa | Aportes Socio → Ruta sin ingreso previo (D1 abierta; caso Barreiro) | `partnerBalance < 0`. **No es error por sí misma** |
| Gastos de empresa históricos sin bolsa | Anteriores a la Ronda 2 (D9) | `poolExpenseStateOf = 'historico'` |
| Ventas sin `disbursementStatus` | Anteriores al flujo de solicitudes | Campo ausente (se tratan como desembolsadas) |
| Sobrantes o faltantes de cuadre por aportes formalizados tarde | Pre-Ronda 6 (RC-7) | Sin asignar < 0 con un aporte posterior a un cuadre |
| Pagos con saldo inconsistente o escrituras parciales antiguas | Anteriores a `paymentService` | `reconcileFinancials` |
| Contraseñas en texto plano | Modelo local | **No se importan**: cada usuario restablece su contraseña en la identidad central |

## 5. Pruebas

1. **Contratos:** las 26 suites (1.600 casos) se ejecutan contra el servidor a través de un adaptador de repositorio. Una aserción solo puede cambiar si una decisión aprobada lo exige, y se documenta (mismo criterio que en las rondas 6B–6C.1).
2. **Concurrencia distribuida:** una prueba por riesgo R1–R11 de [RIESGOS_CONCURRENCIA_SAAS_2026-10.md](./RIESGOS_CONCURRENCIA_SAAS_2026-10.md), con clientes paralelos reales contra la API (no contra una base local).
3. **Doble dispositivo de extremo a extremo:** el protocolo de dos equipos automatizado (dos navegadores, dos usuarios, misma empresa).
4. **Aislamiento:** batería que intenta leer y escribir entre empresas con tokens, identificadores y rutas ajenos.
5. **Migración:** idempotencia de la importación (importar dos veces = una) y diagnóstico idéntico antes y después.
6. **Smoke de producción** (`scripts/prod-smoke.mjs`) adaptado al servidor, siempre con empresa sintética.

## 6. Despliegue y reversión

| Momento | Reversión |
|---|---|
| Fases 0–6 (solo staging) | Total: no hay usuarios reales |
| Piloto antes de activar | Total: la base local del piloto sigue operativa |
| Piloto después de activar | **No se vuelve a escribir en local.** Se congela el servidor en solo lectura, se corrige hacia delante y se concilia. La exportación original queda como evidencia |
| Despliegue por empresa | Bandera por empresa: se puede aplazar la activación de cada una sin afectar a las ya migradas |

## 7. Funcionalidades futuras que solo son posibles con servidor (no se implementan aquí)

| Funcionalidad | Por qué necesita servidor | Estado de la decisión |
|---|---|---|
| Ratificaciones entre Administradores (movimientos Admin ↔ Admin, D2) | Dos personas en dos equipos deben ver y confirmar el mismo registro | Abierta (D2) |
| Operaciones registradas por Secretarios | **Hipótesis no aprobada:** el Secretario registra un movimiento físico **ya ocurrido**; las partes lo ratifican; un rechazo deja el movimiento en disputa sin revertir fondos | No aprobada (D30 de la Ronda 6A) |
| Confirmación de recepción del trabajador | Verificable solo si emisor y receptor comparten estado | Abierta (D3) |
| Solicitudes de Base entre dispositivos | El celular del Cobrador debe llegar al responsable | Propuesta (D27 de la Ronda 6A) |
| Aportes extraordinarios con aviso y formalización única | Aviso en un equipo, formalización en otro | Propuesta (D19/D20) |
| Notificaciones (aprobaciones, cuadres, avisos) | Canal central de eventos | Sin decidir (DS-09) |
| Conciliación multiusuario | Una sola Base, cartera y cuadre para todos | Objetivo de las fases 3–6 |
