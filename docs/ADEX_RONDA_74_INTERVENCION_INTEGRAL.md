# ADEX — Ronda 74: intervención integral posterior a R73

| | |
|---|---|
| Fecha | 2026-10-23 |
| Base | `main` @ `f9bec14` (commit documental de R73, **local, sin publicar**); `origin/main` @ `2fa7152` (R73 publicada) |
| Encargo | «Intervención integral post-R73: rectificaciones, consultas, Base por Ruta, SuperAdmin, transferencias, resultados, roles y experiencia de usuario» (bloques A–I + pendientes P-01…P-06) |
| Diagnóstico previo | «Ronda 74 — Diagnóstico y propuesta (sin cambios)», entregado al propietario. **No está persistido en el repositorio**: esta ronda reutilizó su resumen (incluido en el encargo) y lo **reverificó contra el código** (§A.1) |
| Entorno de trabajo | PostgreSQL **local** aislado y datos **sintéticos**. Ninguna operación sobre ADEX-Staging, BlueLine ni las cuentas Owner |
| Estado | Ver §11 (estado por bloque) y §12 (publicación) |

Estados usados (como en el Registro Maestro): **APROBADO** (decisión escrita del propietario), **IMPLEMENTADO** (código en el árbol de trabajo o en un commit local), **PROBADO** (pruebas registradas aquí), **PUBLICADO** (servido por Render/Vercel, verificado), **PENDIENTE**, **BLOQUEADO POR DECISIÓN**.

---

## 0. Registro íntegro de requerimientos y criterios de cierre (Etapa 0)

### 0.1 Bloques de la intervención

| Bloque | Requerimiento | Aprobación | Criterio de aceptación | Estado al cierre |
|---|---|---|---|---|
| **A** | Corregir ventas con pagos anteriores: A1 pagos íntegramente anulados; A2 pagos vigentes con recálculo y reclasificación capital/interés sin mover efectivo; reaplicación segura de pagos anulados; diálogo abrible siempre con diagnóstico | APROBADO (dirección y núcleo B + extensión C del diagnóstico) | Caso 20 % → 10 % reproducible sin tocar BlueLine; pagos conservados; sin doble reconocimiento de capital; libro, cartera e interés conciliados; bloqueos explicados; sobrepago bloqueado; cuadres/cierres/custodia/Offline protegidos; reintentos y concurrencia | Ver §1 y §11 |
| **B** | Rediseño de Consultas: vistas Dinero/Actividad, perspectiva financiera explícita, resúmenes conciliables, filtros en servidor, detalle con patas, móvil adaptado, accesibilidad, zona horaria de la empresa | APROBADO (dirección) | Sin desplazamiento horizontal obligatorio a 390/1024/1280 px; sin UUID fuera del detalle; filas y totales concilian con saldos y `route_period_figures`; filtros y páginas en servidor con RLS | Ver §2 y §11 |
| **C** | Nombres sin MAYÚSCULAS, solo en la vista; partículas, iniciales, guiones, apóstrofos, siglas y negocios preservados | APROBADO | Formateo transversal sin modificar datos guardados, contratos, búsqueda, documentos ni auditoría | Ver §3 y §11 |
| **D** | Base independiente por Ruta; Caja principal como panel consolidado sin duplicar dinero | APROBADO (dirección de negocio, §D.4 del encargo) | Diseño técnico integrado con transición de saldos; **sin migraciones gestionadas** hasta cerrar decisiones financieras | Diseño en §4; implementación **BLOQUEADA POR DECISIÓN** (O1–O6) |
| **E** | SuperAdmin supervisor: sin facultades financieras; conserva estructura y supervisión; dashboard global verificable | APROBADO | Matriz, API y PostgreSQL sin rutas de dinero para el SuperAdmin; panel con indicadores de fuente verificada | E1 (independiente de D) en §5; E2 (capital de empresa) **depende de D**; dashboard **depende de G** |
| **F** | Caja principal consolidada y Transferencias rediseñadas para Base por Ruta | APROBADO (dirección) | Cada acción explica origen, destino, quién registra, quién responde, qué saldo cambia | Diseño en §4.6; implementación **depende de D** |
| **G** | Saldos negativos, faltantes, resultados y ganancias: definiciones antes de alertas | APROBADO (dirección); definiciones abiertas | Indicadores con definición y fuente; «ruta en rojo» y «ganancia retirable» definidos antes de implementarse | Propuesta en §4.7; **BLOQUEADO POR DECISIÓN** (O8–O10) |
| **H** | Solo el Administrador acumula perfiles operativos; sin autoasignación; sin aprobar lo propio con otra membresía | APROBADO (regla de negocio) | Verificar primero lo existente; si exige enmendar DS-05, recomendar antes de cambiar identidad | Verificación en §6; huecos independientes cerrados (§5.2); la regla de acumulación **requiere enmienda de DS-05** (decisión D74-H1) |
| **I** | Terminología coherente; pantallas estrechas (Secretario) | APROBADO | Cambios visuales que no dependan del modelo financiero; no tocar pantallas que se rediseñarán | Inventario en §7; ajustes en §11 |

### 0.2 Pendientes anteriores que no se pierden

| Id | Pendiente | Estado | Relación |
|---|---|---|---|
| P-01 | Evaluación funcional de R73 por el propietario y el socio («Tasa libre» en comprobación) | PENDIENTE (en curso por el propietario) | Sin defecto nuevo abierto sin evidencia |
| P-02 | SOC-10 (documento de 7 dígitos, CPF/RG) | **SUSPENDIDO** por decisión del propietario | No se tocó |
| P-03 | Búsqueda por dirección (proveedor de geocodificación) | PENDIENTE (D73-05) | No se contrató ni integró nada |
| P-04 | Conciliaciones excepcionales (desembolso en cuadre, custodio cambiado, saldo insuficiente, periodo cerrado) | PENDIENTE / bloqueadas | El bloque A acota: el cuadre y el custodio solo bloquean **cuando cambia el capital**; la reaplicación tras un cuadre sigue bloqueada (§1.4) |
| P-05 | Respaldos recurrentes, retención, PITR, continuidad; posible uso de Supabase Pro de STARCLI sin mezclar productos | PENDIENTE (DS-02/DS-14) | La copia cifrada de R73 no es una política de respaldo. No se migró ninguna organización |
| P-06 | Portugués, normativa y retención de datos, coordenadas y privacidad, SMTP y recuperación de acceso, capacidad multiempresa, modelo comercial, importación de cartera histórica, herramientas internas que apuntan a CLEAN | PENDIENTE (registrados en el Registro Maestro §G) | Fuera de alcance; se conservan |

### 0.3 Reglas aplicadas en toda la ronda

DS-01, DS-05, DS-15, DS-17; transacciones atómicas; idempotencia por id de operación; bloqueos en el orden global (ruta → crédito → cuentas); auditoría; libro inmutable (no se reescribe ni borra ningún asiento); cuadres y cierres protegidos; dinero en unidades menores; fecha contable de la empresa; Offline del Cobrador sin crear clientes ni ventas. Ninguna autorización financiera depende solo de la interfaz: toda regla nueva está en la API **y** en PostgreSQL.

---

## 1. Bloque A — rectificación de ventas con pagos registrados

### 1.1 Diagnóstico reverificado

| Hallazgo del diagnóstico | Verificación en el código (R73 publicado) |
|---|---|
| `collection_reverse` no borra pagos: el original queda `reversed` y nace una contrapartida `reversal` | Confirmado: `0017_payment_corrections.sql` (`collection_reverse`): fila nueva con importe negativo y capital/interés negativos; el original pasa a `reversed` |
| El guardián de 0030 bloquea si «existe cualquier pago» | Confirmado: `0030` `credit_rectify` y `credit_rectify_check`: `exists (select 1 from adex.payments … sale_id = s.id)` → `AX520 CREDIT_HAS_COLLECTIONS`, aunque el efecto neto sea cero |
| La interfaz no abre el diálogo si hay filas de pagos | Confirmado: `src/pages/admin/ActiveSalesPage.tsx`, botón «Corregir venta» condicionado a `detailPayments.length === 0` (cuenta filas históricas, también anuladas) |
| Imputación capital/interés | `collection_post`: capital reconocido acumulado `round(pagado × capital / total) − ya reconocido` (F5-D01). Es acumulativa: tras anular todos los pagos, Σ capital = Σ interés = 0 exactamente |
| Qué protegen los cierres | `period_closures.figures` y la conciliación `closedDrift` comparan **custodia** y **huella de operaciones** del rango (0014, 0019): cambiar cuotas de una venta no altera ningún cierre; una operación nueva fechada hoy tampoco |

### 1.2 Diseño implementado (migración `0032_rectification_with_payments.sql`)

**A1 y A2 en un solo guardián.** La rectificación ya no mira si «existe algún pago», sino el **efecto neto**: pagado neto (originales + anulaciones), capital reconocido (Σ `principal_minor` + reclasificaciones previas) e interés reconocido. Con todo anulado (A1) el resultado es idéntico a R73. Con pagos vigentes (A2):

1. Se conservan todos los pagos: importe, fecha, quién y evidencia (los hechos del pago son inmutables desde 0002/0013).
2. Las cuotas se rehacen con el calendario nuevo y el **pagado neto** se reparte en cascada (`credit_recompute`, el mismo motor de los recaudos). Reducir parcelas sigue la regla D73-02 (cuotas `sustituida`, nunca borradas).
3. La diferencia de imputación es una **reclasificación**: `capital reconocido nuevo = round(pagado neto × capital nuevo / total nuevo)`; la diferencia con lo ya reconocido se registra hoy como operación nueva `PRINCIPAL_RECLASSIFICATION` con dos patas, **cartera de la ruta** e **interés de la ruta**. No toca ninguna cuenta de efectivo, no es un recaudo, no entra en cuadres (no tiene patas de custodia) y no cambia cierres.
4. `sales.principal_reclassified_minor` acumula las reclasificaciones; `collection_post` y `collection_reverse` (copiados literalmente de 0017 con un solo cambio cada uno) suman ese valor a lo «ya reconocido». Así el siguiente recaudo imputa sobre lo ajustado: **sin doble reconocimiento de capital**.
5. Si cambia el **capital entregado**, se aplica además la operación `DISBURSEMENT_ADJUSTMENT` de SOC-09 con todos sus controles.
6. Historial: `credit_rectifications` guarda además el pagado neto, la reclasificación y su operación; `before_state`/`after_state` incluyen el capital reconocido antes y después.

**Controles (todos en PostgreSQL, bajo bloqueo ruta → crédito → cuentas):**

| Control | Regla | Error |
|---|---|---|
| Solo el Administrador de la ruta | igual que R73 | `AX402` |
| Motivo y evidencia (≥ 10), confirmación Offline | igual que R73 | `AX411` |
| Concurrencia optimista e idempotencia | igual que R73 (+ id derivado determinista para la reclasificación) | `AX523` / `AX409` |
| Periodo cerrado (desembolso, calendario anterior y nuevo, hoy) | **se mantiene D73-03** | `AX407` |
| Total corregido < pagado neto | **bloqueado** (sin política de sobrepagos y devoluciones) | `AX525 OVERPAYMENT` |
| Ajuste de pago pendiente en la venta | bloqueado: resolverlo primero | `AX527` |
| Pagos importados sin asiento | bloqueado | `AX526 LEGACY_PAYMENTS` |
| Pagos e imputación que no concilian | bloqueado | `AX420` |
| Desembolso en un cuadre / custodio cambiado / bolsa de otro Administrador / saldo | **solo si cambia el capital** (es lo único que mueve efectivo) | `AX521` / `AX522` / `AX402` / `AX401` |

**Decisión técnica que el propietario debe confirmar (D74-A1).** En R73 (D73-03) el desembolso incluido en un cuadre y el custodio cambiado bloqueaban **toda** corrección. Ahora solo bloquean si cambia el capital, porque una corrección de tasa o parcelas no mueve efectivo ni toca la custodia ya cuadrada. Sin este ajuste, el requisito «corregir errores descubiertos después de algunos días» sería imposible en la práctica (los cuadres son diarios). Si el propietario prefiere la regla de R73, basta con volver a exigir esas dos comprobaciones siempre (cambio local en `credit_rectify`), sin otra consecuencia.

**Periodo cerrado (D74-A2, recomendación).** Se mantuvo el bloqueo de D73-03. Técnicamente, como los cierres archivan solo cifras de custodia y huella de operaciones (§1.1), una corrección sin cambio de capital fechada hoy no altera ningún cierre; si el propietario lo aprueba, podría permitirse corregir tasa/parcelas de ventas desembolsadas en semanas ya cerradas. Queda **BLOQUEADO POR DECISIÓN**.

### 1.3 Extensión C — reaplicar un pago anulado (`adex.collection_reapply`)

El encargo pide reproducir los abonos de referencia después de corregir, sin duplicaciones. Volver a registrarlos como recaudos nuevos los dejaría con la fecha de hoy y sin vínculo con el pago anulado. La reaplicación:

- Solo para un pago `reversed` (no una contrapartida, no un pago corregido —su reemplazo ya existe—, no reaplicado antes: índice único).
- El **mismo efectivo vuelve a la misma cuenta** que lo recibió (la custodia del trabajador o la bolsa), en una operación `COLLECTION` nueva enlazada (`payments.reapplies_payment_id`), con la **fecha original** del pago si su semana sigue abierta (si no, hoy, como la anulación, D7). El asiento va hoy.
- No crea dinero: la anulación había retirado ese efectivo de la cuenta (`AX413` si ya se había usado).
- **Bloqueada si la anulación ya entró en un cuadre de esa custodia** (`AX529 REVERSAL_SETTLED`): el efectivo pudo quedar registrado como sobrante y reaplicarlo duplicaría dinero. No hay reaplicación desde «Sobrante en control» sin política aprobada (P-04).
- Bloqueada también si el trabajador ya no puede tener caja en la ruta, si excede el saldo de la venta, si el periodo de hoy está cerrado o si la bolsa es de otro Administrador.
- Solo el Administrador (el SuperAdmin no mueve dinero). Comprobación previa sin efectos: `GET /v1/collections/:id/reapply-check`; comando: `POST /v1/collections/:id/reapply` (id de operación obligatorio).

### 1.4 Interfaz

- «Corregir venta» se abre aunque la venta tenga pagos (`ActiveSalesPage`). El diálogo (`RectifySaleModal`) muestra el **diagnóstico del servidor**: pagos vigentes, anulados y reaplicados, pagado neto, último pago, el mínimo del total corregido y qué controles aplican si cambia el capital. «0 pagos vigentes» ya no se presenta como garantía de nada: la decisión es del servidor.
- Bloqueos nuevos explicados en lenguaje claro (sobrepago, ajuste pendiente, pagos sin asiento, inconsistencia) y **registrables como caso** sin efecto financiero (D73-03).
- En el detalle de la venta, cada pago anulado reaplicable tiene el botón **«Reaplicar»** (`ReapplyPaymentModal`): muestra valor, fecha original, fecha al reaplicar, a qué cuenta vuelve y los bloqueos, y exige motivo.
- La puerta de Vercel exige `rectification-payments-v1` (la API la anuncia solo con 0032 aplicada).

### 1.5 Pruebas del bloque A (PostgreSQL local, datos sintéticos)

| Conjunto | Resultado | Registro |
|---|---|---|
| `r74-rectification` (nuevo) + `r73-credits` + `r73-decisions` | **46/46** ✔ (11 nuevas + 35 de R73) | `tmp/r74/a/test-3.log` |
| Reversión de 0032 (esquema idéntico a 0031, datos intactos, reaplicable, se niega con uso registrado) | **8/8** ✔ | `tmp/r74/a/rollback-check-0032.log` |
| E2E en Chrome real (build de producción, pila local) | **21/21**: diálogo abierto con pagos, diagnóstico «0 vigentes · 2 anulados», corrección 20 % → 10 %, dos «Reaplicar» desde la pantalla con la custodia correcta, corrección con pagos vigentes (reclasificación 1.455), sobrepago explicado, diálogo a 390 px sin desplazamiento horizontal, conciliación limpia, sin errores JS | `tmp/r74/a/e2e-a.log`, capturas `tmp/r74/a/e2e/` |
| Suite completa del SaaS | ver §9 | — |

Casos nuevos (`saas/test/integration/r74-rectification.test.ts`):

| Id | Qué demuestra |
|---|---|
| R74-A1-001 | **Reproducción sintética del caso de referencia** (R$ 600, 20 %, 10 parcelas; abonos R$ 60 y R$ 132; anulados). Corrección a 10 % (total R$ 660, parcela R$ 66) sin reclasificación ni dinero; reaplicación de los dos abonos con su fecha y a la misma custodia; la custodia vuelve exactamente al efectivo cobrado; parcelas 1–2 pagadas y 3 parcial; un pago no se reaplica dos veces; conciliación SQL propia y del SuperAdmin limpias |
| R74-A2-001 | Pagos vigentes 20 % → 10 %: pagos intactos (byte a byte), reclasificación de 1.455 (cartera −1.455, interés +1.455, fecha de hoy), ninguna cuenta de efectivo cambia; el siguiente recaudo de 6.600 imputa 6.000 capital + 600 interés; capital cobrado + interés cobrado = recaudos del periodo; anular un pago anterior a la rectificación sigue conciliando |
| R74-A2-002 | Reducir parcelas con pagos (sobrantes `sustituida` sin pagos) y volver a aumentarlas (mismas filas), con la cascada del pagado neto |
| R74-A2-003 | Cambio de capital con pagos: ajuste del desembolso (+10.000 a la custodia que pagó) + reclasificación (+909) |
| R74-A-BLK-001 | Sobrepago bloqueado sin efecto (venta, cuotas y pagos idénticos) |
| R74-A-BLK-002 | Desembolso en un cuadre: la tasa se corrige; el capital no (`DISBURSEMENT_SETTLED`) |
| R74-A-BLK-003 | Ajuste de pago pendiente y periodo cerrado: bloqueados y explicados |
| R74-A-BLK-004 | Reaplicación bloqueada tras un cuadre posterior a la anulación, sobre un pago corregido, por rol (SuperAdmin y Cobrador 403) y sin motivo |
| R74-A-BLK-005 | Custodio cambiado: la tasa se corrige; el capital y la reaplicación hacia esa custodia, no |
| R74-A-CON-001 | Reintento con el mismo id = misma respuesta y una sola reclasificación; dos rectificaciones simultáneas: una gana (409 la otra); rectificación ∥ recaudo: ambos se serializan y todo concilia |
| R74-A-SEC-001 | Secretario y SuperAdmin no corrigen; la reclasificación no se anula por la vía genérica; el historial guarda pagado neto y reclasificación |

Pruebas de R73 sustituidas (constancia en el propio código): R73-SOC09-005 y el final de R73-SOC09-007 esperaban `CREDIT_HAS_COLLECTIONS`; R73-D03-001/002 esperaban ese bloqueo y `DISBURSEMENT_SETTLED` como bloqueo general. Ahora verifican la regla nueva.

**Comprobación nueva en la conciliación del SuperAdmin:** `income-matches-interest` (interés reconocido de cada ruta = Σ interés de sus pagos − Σ capital reclasificado). Antes no existía ninguna comprobación sobre la cuenta de interés.

### 1.6 Caso de referencia de BlueLine (cliente «Undel»)

**No se tocó.** Con 0032 publicada, el Administrador podrá, desde la interfaz y sin intervención técnica:
1. abrir la venta → «Corregir venta»: el diálogo mostrará los dos pagos anulados y pagado neto 0;
2. corregir la tasa a 10 % con motivo y evidencia (la referencia de Listos);
3. en el detalle de la venta, «Reaplicar» cada abono (R$ 60 y R$ 132): vuelven a la custodia del cobrador con su fecha original si su semana sigue abierta.

Condiciones que el servidor comprobará en ese momento: periodo abierto; que las anulaciones **no** hayan entrado ya en un cuadre del cobrador (si entraron, la reaplicación queda bloqueada por `REVERSAL_SETTLED` y el caso se registra; ver P-04); que el cobrador siga asignado a la ruta. Esta ronda **no** consultó los datos de BlueLine para saberlo.

---

## 2. Bloque B — Consultas

### 2.1 Diagnóstico reverificado
La tabla de R73 (`online/src/runtime/MovementsTable.tsx`) medía 3 691 px de ancho frente a 1 006 / 750 / 356 px visibles a 1280 / 1024 / 390 px (arnés `tmp/r74/b/e2e-consultas.mjs`, modo «antes», 5/5): desplazamiento horizontal obligatorio, trece columnas, cliente repetido, UUID completos, dinero y eventos mezclados, horas del navegador y origen/destino invertidos en los traspasos aplicados. Se retiró (nada más la importaba).

### 2.2 API nueva (sin migración, sin tocar el libro; `/v1/movements` de R73 intacto para el frontend publicado)
| Endpoint | Qué devuelve |
|---|---|
| `GET /v1/movements/perspectives` | Perspectivas disponibles para el rol: Empresa (solo SuperAdmin), Ruta, Bolsa de un Administrador, Caja de un trabajador en una ruta; la zona horaria de la empresa |
| `GET /v1/movements/cash` (vista **Dinero**) | Movimientos de efectivo de la perspectiva y el periodo (fechas contables de la empresa), con filtros en el servidor (grupo, tipo, entrada/salida/traspaso, persona, cliente, responsable, estado, texto, importes), orden y páginas (50, máx. 200). **Resumen** independiente de los filtros: saldo inicial, entradas, salidas, traspasos internos, saldo final y comprobación contra el saldo del libro |
| `GET /v1/movements/activity` (vista **Actividad**) | Solicitudes, decisiones, cuadres, cierres y operaciones contables sin efectivo (p. ej. la reclasificación del bloque A). Cobrador y Secretario: 403 |
| `GET /v1/movements/detail?id=` | Actor, fecha y hora completas en la zona de la empresa, ruta y oficina, cuentas de origen y destino, referencias, anulación relacionada y **patas contables** visibles para el rol (todas solo para el SuperAdmin); fuera de alcance: 404 |

### 2.3 Reglas financieras
- **Perspectiva = conjunto de cuentas de efectivo**, resuelto bajo RLS: Empresa = empresa + bolsas + custodias + tránsito + sobrantes en control; Ruta = custodias de la ruta (coincide con `route_period_figures.custody`); Bolsa = la bolsa del Administrador; Caja = una custodia. Con Base por Ruta solo cambiará la resolución de la perspectiva (`resolvePerspective`), no la interfaz ni los cálculos.
- Por operación, las patas dentro de la perspectiva se netean por cuenta: traspaso interno = mín(entra, sale); entrada = entra − interno; salida = sale − interno. Por construcción **entradas − salidas = saldo final − saldo inicial**; los traspasos internos se muestran aparte y nunca como ingreso, salida ni ganancia.
- Bolsa → custodia de la misma ruta: entrada en la vista de ruta, interno en la de Empresa. Traspasos entre Administradores: salida de la bolsa que envía y entrada en la que recibe; internos en la vista de Empresa. Origen y destino salen de los roles de cada campo (0023): corrige la inversión de R73.
- Ventas o cobros hechos directamente con la bolsa de un Administrador no tocan las custodias de la ruta: la vista de ruta los cuenta como «fuera de esta vista» con un aviso que remite a la bolsa. Incluirlos en la ruta requiere Base por Ruta.

### 2.4 Interfaz
Escritorio: Hora · Movimiento · Persona/concepto · Responsable · Entrada · Salida; filtros visibles arriba (Caja o ruta, Periodo, Tipo de movimiento) y «Más filtros»; nombres largos abreviados con el completo en el detalle; UUID solo en el detalle. Móvil: tarjetas. Teclado: flechas entre filas, Intro abre el detalle con el foco dentro, Escape devuelve el foco a la fila. Horas en la zona de la empresa aunque el dispositivo esté en otra. Las vistas anteriores (caja por ruta, historial con comprobantes) siguen en «Otras vistas» porque otras pantallas enlazan a ellas.

### 2.5 Pruebas
| Conjunto | Resultado | Registro |
|---|---|---|
| `r74-movements` (nuevo) | **11/11** (conciliación con saldos y `route_period_figures`, sin duplicados, anulaciones, traspasos entre Administradores, filtros/páginas/totales en servidor, RLS, límite de zona horaria, nombres largos, operación sin efectivo, compatibilidad R73) | `tmp/r74/b/test-r74-3.log` |
| `r73-movements` | 6/6 | ídem |
| E2E Chrome (build de producción) | **28/28** (6 columnas, sin UUID, saldo final de ruta = Σ custodias en PostgreSQL, saldo de Empresa = efectivo total, sin desplazamiento horizontal a 1280/1024/390, tarjetas a 390, teclado, filtro en servidor, Actividad sin dinero, sin errores JS; navegador en hora de Tokio mostrando la hora de São Paulo) | `tmp/r74/b/e2e-after.log`, capturas `tmp/r74/b/shots/` (antes y después) |

Límite de la prueba de zona horaria: el libro fecha con `now()`, así que no se pudo fijar un movimiento exacto a las 23:30; se comprobó con una zona cuya fecha local difiere de la UTC.

### 2.6 Decisiones abiertas de B
- El Cobrador puede consultar por la API **solo su propia caja** (R73 le devolvía 403); el menú no cambia (Consultas sigue siendo de Administrador y SuperAdmin).
- Periodo por defecto «Hoy» y perspectiva por defecto del Administrador = su bolsa: a confirmar.
- La exportación CSV de R73 no se repuso (puede volver sobre los filtros del servidor).

---

## 3. Bloque C — nombres

- `src/lib/displayName.ts`: `formatPersonName`, `formatBusinessName`, `formatClientName`. Solo la vista: valores guardados, búsqueda, contratos, documentos y auditoría no cambian.
- Reglas: solo se transforma un texto escrito **todo** en mayúsculas (lo bien escrito se respeta); no se inventan acentos; partículas pt/es en minúscula salvo al inicio; iniciales, guiones, apóstrofos, números romanos y palabras con dígitos se conservan; en negocios, siglas (sin vocales), formas societarias (LTDA, ME, EPP…) y «&» quedan en mayúsculas; «PERSONA - NEGOCIO» (texto ingresado así) se presenta como persona + negocio, **sin separar ni guardar nada**.
- La separación asistida de negocios históricos queda **PENDIENTE** (requiere confirmación expresa del usuario por registro y auditoría; no se asume ninguna separación automática).

- **Cobertura:** el formateo se aplica solo donde se pinta un nombre (helpers de cada pantalla, sin tocar el puente de datos): Clientes (Administrador, Secretario, Cobrador), Ventas activas y detalle, Autorizaciones (tres bandejas), Mapa (marcadores, ventanas, listas), Usuarios y rutas, pantallas del Cobrador (inicio, cobro, visita, desembolsos, gastos, reporte, cola sin conexión), Notificaciones, cuadres y liquidación, Caja principal, transferencias y asistente de operaciones, cabeceras y cuentas, Owner (SuperAdmins de cada empresa) y Consultas (bloque B). 49 archivos de interfaz.
- **Sin cambiar a propósito:** búsquedas (siguen comparando en minúsculas con el valor guardado), ordenamiento, valores de formularios, cargas a la API y a la cola sin conexión, auditoría, documentos, mensajes de WhatsApp y exportaciones CSV.
- **No cubierto:** el comprobante imprimible (`MovementReceiptPage`), páginas de CLEAN que Online sustituye por las del puente, y nombres de empresa, oficina, ruta y categoría (no son personas ni clientes).
- **Pruebas:** `npm run test:displayname` **36/36** (incluye Filho, Neto, Jr., Sobrinho, Fátima, «JOSE NETO - PADARIA DO NETO ME»); tipos de CLEAN y Online sin errores; `npm test` de la raíz sin fallos (`tmp/r74/c/npm-test.log`). La búsqueda no ignora acentos («joao» no encuentra «JOÃO»): ya era así, queda anotado.
- **Decisiones abiertas de C:** ¿formatear también nombres de empresa y el comprobante imprimible? Una palabra corta con vocales en un negocio («BAR») pasa a «Bar»; solo « - » con espacios separa persona y negocio.

---

## 4. Diseño técnico de Base por Ruta, SuperAdmin, Caja principal, Transferencias e indicadores (D, E, F, G)

Revisión focalizada del modelo vigente (no auditoría general). Citas a migraciones y código del repositorio; lo no comprobado se marca así.

### 4.1 Modelo actual (resumen verificado)

- Cuentas (`capital_accounts.kind`, 0023): `company`, `external` (≤ 0, contrapartida de lo que entra), `admin` (**bolsa del Administrador, sin ruta**), `custody` (trabajador × ruta, con `carried_minor` = faltante arrastrado), `portfolio`, `income` (≤ 0), `expense`, `suspense` (sobrante en control), `unidentified` (≤ 0), `transit` (traspasos pendientes). Cada operación suma cero; operaciones y patas son inmutables.
- La bolsa que paga o recibe en cada comando es la del **responsable de capital actual** de la ruta (`routes.capital_controller_membership_id`), releída bajo bloqueo (`capital_post` 0025, `credit_disburse` 0018, `collection_post`, `expense_post` 0013, `custody_settle` 0014).
- **Cambio de responsable** (`saas/src/structure/capitalGuard.ts`): registra el evento y actualiza la ruta, pero **no mueve nada en `capital_accounts`**. Lo que la ruta ya devolvió queda en la bolsa del Administrador anterior: **hoy el dinero no se queda con la ruta**.
- Venta directa del Administrador: desde la bolsa del responsable (D25: el faltante arrastrado no es billete). La rama «el SuperAdmin paga desde la bolsa» de `credit_disburse` es código muerto desde R67.
- Offline: las capturas no referencian cuentas (solo venta, ruta o solicitud) y tocan solo la custodia del Cobrador.

### 4.2 Saldos negativos hoy

| Cuenta | ¿Negativa? | Regla | Protege |
|---|---|---|---|
| `company`, `admin`, `transit`, `suspense`, `portfolio`, `expense` | No | `capital_accounts_no_overdraft` | Sin sobregiro ni doble consumo |
| `custody` | Solo por gasto del trabajador; otros débitos dejan saldo ≥ arrastre | `guard_custody_negative` (0014) + comprobación `negativeCustody` | Un negativo nunca es efectivo entregable |
| `external`, `income`, `unidentified` | Sí (≤ 0) | — | Son contrapartidas |
| Cuadre | `expected = máx(P, 0)`; el negativo se guarda aparte | 0014 | Sin reembolso implícito |

**Conclusión (bloque G):** la prohibición de negativos en cuentas de efectivo es correcta y debe mantenerse. Lo que oculta información es la **granularidad**: la bolsa agrega todas las rutas del Administrador, así que hoy no existen el resultado ni la necesidad de capital **por ruta**, y una necesidad de capital solo se manifiesta como un rechazo (`AX401`) sin registro. El «resultado negativo» que describe el socio debe expresarse como **indicador calculado**, no como saldo negativo de efectivo. Además, dos rótulos actuales del panel engañan: «Base total» = Σ custodias (no incluye bolsas) y «Total controlado» incluye el interés no cobrado (`adminDashboardService.ts`).

### 4.3 Diseño recomendado: cuenta `route_base` por ruta

- **Cuenta nueva `route_base(ruta)`** (siempre ≥ 0), ligada solo a la ruta: quién la tiene físicamente es el responsable vigente (cada operación ya guarda la foto del Administrador). La Base **se queda con la ruta** al cambiar de responsable. (Alternativa descartada: bolsa por (Administrador, ruta), que obliga a traspasos en cada cambio y contradice «la Base pertenece a la ruta».)
- **Contrapartida `route_funding(ruta)`** (con signo, como `external` pero por ruta): `−saldo` = aportes netos de la ruta. Permite «conservación por ruta» y los indicadores de aportes y retiros.
- **Invariante nueva:** una ruta nunca consume la Base de otra (disparador `guard_route_scope` en `capital_entries`: toda pata en una cuenta con ruta debe coincidir con la ruta de la operación, o con `to_route_id` en las transferencias).
- **Barrera del modelo:** `companies.capital_model` ∈ `admin_pool` | `migrating` | `route_base`. Con `route_base`, se rechazan las operaciones de empresa y de bolsa obsoletas y toda entrada nueva a una bolsa `admin`.

| Operación | Patas | Quién |
|---|---|---|
| Inyección de Base | `route_funding(R)` → `route_base(R)` (origen externo solo como nota; no se registra patrimonio) | Responsable de la ruta |
| Retiro de Base | `route_base(R)` → `route_funding(R)`, tope el saldo de la Base | Responsable |
| Entrega a cobrador / devolución / cuadre | `route_base(R)` ↔ `custody(R, w)` | Responsable (cuadre: responsable o Supervisor) |
| Venta directa del Administrador | `route_base(R)` → `portfolio(R)` (D26: ningún desembolso supera la Base) | Responsable |
| Cobro sin caja personal / gasto de ruta | ↔ `route_base(R)` | — / Responsable |
| Transferencia entre rutas | `route_base(R1)` → `route_base(R2)`, una operación (`route_id`, `to_route_id`), aviso al destino | Responsable de R1 (quien tiene el dinero entrega, R59) |
| Rectificación (R73/0032) | la cuenta que pagó; si fue `route_base`, el responsable actual | Administrador responsable |

- **Cifras de periodo:** bloque `base` nuevo en `route_period_figures` (apertura, inyecciones, retiros, transferencias, entregas, devoluciones, cobros, desembolsos, gastos, cierre); el bloque `pool` se conserva para la historia. Ningún cierre anterior cambia porque no se reescribe ningún asiento.
- **Cambio de responsable:** la Base no se mueve. Procedimiento protegido: la ruta queda «en entrega» (sin inyecciones, retiros, entregas ni transferencias de salida; cobros y cuadres siguen) hasta que el nuevo responsable confirma el conteo; diferencias en un acta, sin movimiento automático.
- **SuperAdmin:** lectura de todo por RLS; ninguna rama de escritura. Consulta `adex.route_panel(desde, hasta)` (SECURITY INVOKER): una fila por ruta en alcance con responsable, Base, custodias (bruta, negativa, entregable), arrastre, sobrante en control, cartera, cifras del periodo y alertas. Es a la vez la **Caja principal consolidada** del Administrador (suma de sus rutas, no una cuenta) y el panel del SuperAdmin.

### 4.4 Transición de los saldos existentes

Hechos: las bolsas no tienen ruta; las patas de bolsa con ruta permiten calcular un neto N(R) por ruta, normalmente **negativo** (la ruta consumió capital asignado), más un neto sin ruta U (asignaciones, devoluciones, traspasos, gastos de empresa). Por eso N(R) no puede ser el saldo inicial de una Base.

| Cuestión | Alternativas | Recomendación |
|---|---|---|
| Reparto de cada bolsa entre rutas | (a) automático por el libro — no sirve por los negativos y U; **(b) manual por el Administrador, con auditoría y N(R) como sugerencia**; (c) proporcional automático — arbitrario | (b). Con una sola ruta, automático y auditado. Operación nueva `LEGACY_POOL_TO_ROUTE` fechada el día del corte; **nunca se reescriben patas** (rompería la huella de cierres) |
| Saldo no atribuible | **(a) queda en la bolsa como «sin asignar», solo para repartir o retirar, con plazo**; (b) cuenta `legacy_pool`; (c) obligar a cero antes del corte | (a) con plazo a fijar (O3) |
| Disponible de empresa y tránsito | **(a) requisito previo: en cero (asignar o retirar con las reglas actuales antes del corte)**; (b) migración del sistema a `external` | (a) |
| Correcciones posteriores de operaciones previas al corte | (a) bloquearlas; (b) redirigir la pata de bolsa a `route_base(o.route_id)`; (c) cerrar periodos hasta el corte | (c) + (b) |
| Bloqueo durante la migración | `capital_model = 'migrating'`: se rechazan comandos que acreditan o debitan bolsas (`CAPITAL_MIGRATION_IN_PROGRESS`); siguen las operaciones del Cobrador | Migración por Administrador en una transacción con plan validado contra el saldo releído |
| Capturas Offline pendientes | Compatibles: no llevan ids de cuenta y solo tocan la custodia | No hace falta invalidar colas |

### 4.5 SuperAdmin (bloque E)

Hoy el SuperAdmin conserva, además de lo que R67 ya le quitó: recibir devoluciones de trabajadores, traspasos entre trabajadores, anular operaciones de ruta, cerrar y reabrir cuadres, cerrar y reabrir periodos, registrar y corregir gastos de ruta o de trabajador, y las operaciones de empresa (depósito, retiro, asignación y recogida de bolsas, gasto de empresa).

- **E1 — se puede retirar ya** (no depende de D): todo lo anterior salvo las operaciones de empresa, en la matriz de CLEAN, la API, `ctx_can` y las ramas de las funciones de PostgreSQL. Consecuencia: una ruta sin responsable válido no puede cerrar su periodo hasta que el SuperAdmin asigne uno (acto estructural). Implementación en §5.1.
- **E2 — depende de D:** depósito, retiro, asignación y recogida de empresa son hoy **la única vía de entrada de capital**; se retiran cuando exista la inyección de Base por ruta.
- **Riesgo:** una misma persona puede ser SuperAdmin y Administrador en la misma empresa (índice único por rol). Decisión O7.

### 4.6 Caja principal y Transferencias (bloque F)

- **Caja principal** = `route_panel` filtrado a las rutas del Administrador: ruta, responsable, Base disponible, efectivo en custodias, cartera, recaudos, gastos, retiros, resultado (cuando O8 se apruebe) y alertas; subtotales y total consolidado solo donde suman con sentido (Base + custodias = efectivo de la ruta; la cartera se muestra aparte).
- **Transferencias**, con el modelo nuevo: 1) inyección de Base, 2) retiro de Base, 3) entrega de Base a cobrador, 4) recepción de devolución, 5) transferencia entre rutas, 6) solicitudes válidas entre responsables (`route_transfer`, `worker_return`), 7) historial y comprobantes. Sin pedir ni devolver dinero al SuperAdmin ni flujos de bolsas. El cuadre queda en Liquidación. Cada acción muestra de dónde sale, a dónde llega, quién registra, quién queda responsable, qué saldo cambia y qué restricciones aplican.
- **No se implementó** en esta ronda: depende de D (no se construyen controles sobre un modelo financiero sin aprobar).

### 4.7 Indicadores (bloque G y paneles)

| Indicador | Definición propuesta | ¿Existe hoy? | ¿Decisión? |
|---|---|---|---|
| Efectivo disponible en Base | saldo `route_base(R)` | No (D) | — |
| Efectivo bajo custodia | Σ custodias de R, con desglose: positivo, negativo y **entregable** = Σ máx(0, saldo − arrastre) | Sí | — |
| Faltantes | Σ `carried_minor` vigente; por periodo `settlements.shortageMinor` | Sí | — |
| Sobrante en control | `suspense(R)` | Sí | F6-D02 abierta |
| Capital colocado | `portfolio(R)` (capital pendiente, sin interés) | Sí | — |
| Cartera total | Σ saldos de ventas activas (incluye interés no cobrado; rotularlo) | Sí | — |
| Desembolsado / capital recuperado / interés cobrado / gastos | `route_period_figures.credit` | Sí (0030/0032) | — |
| Aportes acumulados / retiros | Σ inyecciones / retiros en `route_funding(R)` | No (D) | — |
| **Flujo de caja operativo** | recaudos − desembolsos − gastos del periodo. **Puede ser negativo sin ser pérdida** (es lo que describe el socio cuando hay que inyectar Base) | Sí | Rotularlo así |
| **Resultado económico** | interés cobrado − gastos [− castigos y faltantes dados por perdidos] | Parcial | **O8** |
| Necesidad de capital | máx(0, solicitudes aprobadas sin desembolsar − (Base + custodia entregable)) | Parcial | Recomendable |
| **Ruta en rojo** | tres estados distintos: **en pérdida** (resultado acumulado < 0), **en crecimiento** (flujo operativo < 0 con resultado ≥ 0), **sin liquidez** (necesidad de capital > 0) | — | **O9** |
| **Ganancia retirable** | mín(Base disponible, resultado acumulado − retiros clasificados como resultado), solo sobre periodos cerrados | — | **O10** (hasta entonces, un solo «retiro de Base» sin clasificar) |

Identidad de control (tras D): Base + custodias + cartera = aportes netos + resultado económico + transferencias netas.

### 4.8 Dependencias

E1 → D (esquema y comandos detrás de `capital_model`) → migración por empresa → E2 → F → G avanzado. Lo independiente de D (E1, huecos de roles de §5.2, rótulos engañosos del panel, indicadores existentes) puede hacerse ya.

---

## 5. Cambios independientes del modelo financiero

Migración `0033_superadmin_supervisor_roles.sql` (generada con `tmp/r74/e1h/build-0033.mjs`, que copia literalmente la última definición de cada función y aplica reemplazos exactos; falla si alguna tiene una definición posterior). Reversión `saas/db/rollback/0033_….down.sql` verificada en local **9/9** (esquema idéntico a 0032, datos intactos, reaplicable; `tmp/r74/e1h/rollback-check-0033.log`). 0033 no registra datos.

### 5.1 E1 — SuperAdmin sin operaciones de ruta (APROBADO, IMPLEMENTADO, PROBADO)

| Capa | Cambio |
|---|---|
| Matriz de CLEAN (`src/lib/permissions.ts`) | Constante `SUPERADMIN_NOT_FINANCIAL_OPERATOR`: esas capacidades salen del SuperAdmin y pasan a `INCOMPATIBLE_BY_ROLE.superadmin`; `routeCashAuthorityError` niega al SuperAdmin `structural`, `settle` y `correct` |
| PostgreSQL (0033) | `ctx_can` sin el SuperAdmin en `cashCustody.manage`, `cashSettlement.close/reopen`, `settlement.close/reopen`; sin ramas `superadmin` en `capital_post` (devolución de trabajador, traspaso entre trabajadores y las anulaciones de operaciones de ruta), `custody_settle`, `custody_settlement_reopen`, `period_close`, `period_reopen`, `expense_post` (cargar gastos a otro trabajador), `expense_correctable` (anular gastos de ruta o de trabajador); retirada la rama muerta «el SuperAdmin paga con la bolsa» de `credit_disburse` |
| API | `expenses/service.ts` ya no deja al SuperAdmin cargar gastos a otro; el resto se niega por la matriz y por PostgreSQL |
| Interfaz | Cuadres, cierres, custodia y asistente de operaciones se ocultan por la matriz; «Anular» ya no aparece al SuperAdmin en el historial de transferencias; en Gastos solo se le ofrece el gasto de empresa |

**Conserva el SuperAdmin (BLOQUEADO POR DECISIÓN O1–O6, porque hoy es la única entrada de capital):** depósito y retiro de empresa, asignación y recogida de bolsas, solicitudes `admin_allocation`/`admin_return`, gasto de empresa (desde la empresa o con cargo a la bolsa de un Administrador, D10/D11). Conserva toda la estructura, la supervisión, las consultas y la conciliación.

**Consecuencia operativa:** si una ruta queda sin Administrador responsable válido, nadie puede cerrar su periodo ni cuadrar sus cajas hasta que el SuperAdmin asigne uno (acto estructural). Prueba R74-SA-006.

### 5.2 Huecos de roles cerrados (consistentes con DS-05; IMPLEMENTADO, PROBADO)

| Hueco (verificación H) | Cierre | API | PostgreSQL |
|---|---|---|---|
| H1 · autoasignación de membresías | Nadie crea ni reactiva una membresía para su propia identidad | `createMember`, `setMemberStatus` → 403 `SELF_ASSIGNMENT_FORBIDDEN` | política restrictiva `memberships_no_self_insert` (solo `adex_api`) y disparador `memberships_no_self_reactivation` |
| H2 · aprobar o rechazar un ajuste de pago pedido por uno mismo (con otra membresía) | Comparación por **persona** (`same_person`) | aprobar y rechazar → 403 `SELF_APPROVAL_FORBIDDEN` | `collection_correct` con ajuste → `AX505`; política `payment_adjustment_reject` |
| H3 · entregar capital a la propia custodia de Cobrador | `WORKER_DELIVERY` a la misma persona prohibido | `deliverToWorker` → 403 `SELF_DELIVERY_FORBIDDEN` | `capital_post` → `AX419` |
| H4 · captura sin conexión enviada con la membresía activa del momento | Cada captura se envía con **su** membresía | `online/src/lib/client.ts` acepta la membresía por comando; `online/src/offline/sync.ts` usa `op.membershipId` | — |

Las rutas Owner y Demo de alta de membresías no corren como `adex_api` y no se ven afectadas. Los flujos legítimos con varias membresías (IDN-021, CRED-004, ONL-020) siguen pasando.

**Huecos de la misma clase aún abiertos (decisión D74-H2):** un Administrador puede traspasar efectivo de otro trabajador a su propia custodia de Cobrador, y puede asignar rutas a otra membresía suya. Recomendación: cerrarlos con la misma regla de persona en la próxima migración de roles (junto con D74-H1).

---

## 6. Bloque H — verificación de varios perfiles

| Pregunta | Resultado (código vigente) |
|---|---|
| ¿Una identidad puede tener varios roles en una empresa? | **Sí.** Único índice: (identidad, empresa, rol) (`0001`): se impide repetir el mismo rol, no combinar roles. Ni la base ni la API limitan combinaciones |
| ¿Selector de contexto? | **Sí, funcional:** `/contexto` (`online/src/runtime/ContextSelectPage.tsx`), botón «Cambiar empresa o rol» cuando hay más de una membresía (`AdminLayout`, `CollectorLayout`) |
| ¿Cambiar de contexto exige cerrar sesión? | **No.** `leaveContext()` solo olvida la membresía activa |
| Sesión única (0031) | `claim_session` solo en el inicio de sesión explícito; cambiar de contexto no abre sesión (prueba R73-SES-002) |
| Rutas | `ctx_route_allowed` usa solo las rutas de la membresía activa; nunca se suman (IDN-021) |
| ¿Quién asigna membresías? | SuperAdmin (todos los roles) y Administrador (supervisor, cobrador, secretario), API + RLS |
| **Autoasignación** | **Posible por la API**: un Administrador puede crearse otra membresía con su propio correo (`createMember` reutiliza la identidad del correo). La interfaz lo impide solo porque rechaza correos repetidos |
| Aprobar lo propio con otra membresía | Bloqueado **por identidad** (`same_person`) en solicitudes de crédito, reducción de la propia custodia, traspasos, corrección de gastos y cuadres. **Huecos:** aprobación de ajustes de pago (nadie compara solicitante y aprobador) y entrega de capital a la propia custodia |
| Offline con el Admin en contexto de Cobrador | Las capturas se guardan por identidad + membresía; al cambiar de contexto no se borran, pero no hay aviso; la sincronización envía con la membresía **activa** en ese momento, no con la de la captura (riesgo teórico) |
| ¿Imponer «solo el Administrador acumula perfiles»? | Restringe la frase de DS-05 «varias membresías independientes por empresa y rol». Necesita **enmienda escrita de DS-05** (D74-H1). Choca con la prueba ONL-020 y la Demo (Cobrador + Supervisor sin Administrador) |

**Recomendación D74-H1:** enmendar DS-05 así: (1) una identidad solo puede tener varias membresías **activas** en la misma empresa si una de ellas es Administrador; (2) la regla es por empresa (en otra empresa, otra decisión); (3) SuperAdmin y Administrador no se combinan en la misma empresa (O7); (4) nadie se asigna membresías a sí mismo; (5) se mantiene «una membresía por petición» y «nadie aprueba lo propio» por identidad. Implementación posterior: disparador en `adex.memberships` (alta, reactivación y asignación de puestos) con bloqueo por identidad, error `ROLE_ACCUMULATION_FORBIDDEN`, consulta previa de datos existentes que la incumplan en el gestionado, y ajuste de ONL-020/Demo.

---

## 7. Bloque I — terminología y pantallas estrechas (inventario)

**Pantallas del Secretario** (rutas en `online/src/runtime/CleanOnlineApp.tsx`; menú en el puente `SecretarioLayout`): Clientes, Autorizaciones, Corrección de pagos, Transferencias (R53) y Cuenta. El contenedor del layout no limita el ancho; el espacio se desperdicia por listas de una sola columna, trabajo en modales estrechos (`Modal` por defecto `max-w-lg`) y tarjetas de ancho fijo. El Supervisor usa `CollectorLayout` (`max-w-md` en toda la pantalla), es decir, una columna de móvil también en escritorio.

**Terminología** (sin infraestructura i18n; todos los textos en el código; configuración regional `es-CO` fija):

- (a) Cambios seguros de texto: Cuota → Parcela (13 apariciones), Crédito → Venta en historiales y avisos, «Cierre» → «Cuadre» cuando se refiere a cerrar un cuadre, «Caja de la Ruta» → «Caja de Ruta», «fondos» → «saldo disponible».
- (b) No son equivalentes y **no se fusionan**: Liquidación/cierre de periodo ≠ Cuadre; Recaudo ≠ Devolución de Base; Trabajador (Cobrador + Supervisor) ≠ Cobrador; «pago» de gastos o «días de pago» ≠ recaudo; «cobro» de la suscripción del Owner ≠ recaudo; capital de empresa ≠ Base de ruta; Base ≠ ganancia (no hay textos de ganancia hoy).
- (c) Dependen de Base por Ruta y **esperan**: «bolsa» (≈ 159 apariciones), «Entregar/Recibir capital», «Colocar/Retirar capital», «Inyección de capital», «Responsable de capital», contenido de la Caja principal.
- Inconsistencia a centralizar antes de cambiar vocabulario: los tipos de movimiento tienen textos distintos en `online/src/lib/format.ts` y en la tabla de Consultas.
- Para el portugués futuro conviene un diccionario único de textos antes de traducir.

**Ajustes aplicados en esta ronda (no dependen de Base por Ruta):**
- Secretario · Clientes: contenedor `max-w-7xl` centrado; en escritorio, columnas Cliente | Documento | Teléfono | Ruta (en móvil, filas compactas); edición en diálogo amplio con direcciones en dos columnas; historial en diálogo `xl`.
- Secretario · Autorizaciones: contenedor centrado; diálogo `xl` en dos columnas en escritorio (cliente, avisos e historial a la izquierda; condiciones a la derecha); el estado de las ventas del historial se muestra con texto («Activa») y no con el valor interno.
- Secretario · Corrección de pagos y Cuenta: contenedores centrados; buscador más ancho; correo y cambio de contraseña lado a lado en escritorio.
- Notificaciones: `max-w-6xl` centrado.
- Terminología segura: «Cuota» → «Parcela» en Ventas activas, detalle de venta, alta de venta desde Clientes, lista de comprobación inicial y pantalla de acceso.
- Sin tocar (se rediseñan con Base por Ruta): Transferencias, Caja principal y los textos de «bolsa/capital».

---

## 8. Decisiones pendientes del propietario

| Id | Decisión | Recomendación |
|---|---|---|
| D74-A1 | ¿Confirmar que el desembolso en cuadre y el custodio cambiado solo bloquean cuando cambia el capital? (§1.2) | Sí |
| D74-A2 | ¿Permitir corregir tasa/parcelas (sin cambio de capital) de ventas desembolsadas en semanas cerradas? (§1.2) | Opcional; técnicamente seguro. Hoy bloqueado |
| D74-A3 | Política de sobrepagos y devoluciones (total corregido < pagado) | Mantener bloqueado hasta definirla |
| D74-A4 | Reaplicación cuando la anulación ya entró en un cuadre (posible sobrante) | Mantener bloqueado; definir conciliación con «Sobrante en control» (P-04) |
| O1 | Cuenta de la Base: `route_base` ligada a la ruta | Sí |
| O2 | Contrapartida de aportes por ruta (`route_funding`) | Sí |
| O3 | Saldo de bolsa no atribuible: «sin asignar» con plazo | Sí, plazo a fijar (p. ej. 30 días) |
| O4 | Gastos administrativos de empresa: imputados a una ruta y pagados con su Base, o fuera de ADEX | Imputarlos a una ruta |
| O5 | Cambio de responsable: ruta «en entrega» hasta el conteo; diferencias en acta | Sí |
| O6 | Quién activa el modelo nuevo por empresa | El SuperAdmin, con respaldo verificado y requisitos previos |
| O7 | Prohibir SuperAdmin + Administrador en la misma persona y empresa | Sí (o al menos que no sea responsable de capital) |
| O8 | Resultado económico = interés cobrado − gastos | Sí |
| O9 | «Ruta en rojo» = en pérdida; «en crecimiento» y «sin liquidez» como estados distintos | Sí |
| O10 | Ganancia retirable (definición) | Hasta decidir, un solo «retiro de Base» sin clasificar |
| O11 | Transferencia entre rutas de responsables distintos: directa por quien tiene el dinero, con aviso | Sí |
| D74-H2 | ¿Cerrar también el traspaso de efectivo de otro trabajador a la propia custodia y la asignación de rutas a una membresía propia? | Sí |
| D74-E1 | ¿El SuperAdmin sigue cargando gastos de empresa a la bolsa de un Administrador (D10/D11)? | Mantener hasta Base por Ruta (O4) |
| D74-B1 | Consultas: Cobrador con acceso por API a su propia caja; periodo por defecto «Hoy»; perspectiva por defecto del Administrador = su bolsa; ¿reponer CSV? | Confirmar los tres; CSV a pedido |
| D74-C1 | ¿Formatear también nombres de empresa y el comprobante imprimible? | Sí para el comprobante; empresa a criterio |
| D74-H1 | Enmienda de DS-05 para «solo el Administrador acumula perfiles» (§6) | Sí, con los 5 puntos de §6 |

---

## 9. Pruebas y regresiones

Todo sobre PostgreSQL **local** con las migraciones 0001–0033 y datos **sintéticos**.

| Conjunto | Resultado | Registro |
|---|---|---|
| SaaS · tipos | Sin errores | — |
| SaaS · unidad | **31/31** | `tmp/r74/unit-final.log` |
| SaaS · PostgreSQL completo | **506**: 501 ✔ · 4 ✖ · 1 omitida (staging real). Los ✖: **HIST-001/002/003** (fallo histórico de la Demo fechada, igual en `72b6e1b`, antes de R73) y **RT-001** (el campo nuevo `reappliesPaymentId`), corregido después y verificado con los contratos (**12/12**) | `tmp/r74/saas-db-final.log` (evidencia `tmp/saas-phase01/evidence/db-tests-2026-10-23T17-21-43-749Z.log`), `tmp/r74/contracts-final.log` |
| Nuevas de la ronda (PostgreSQL) | `r74-rectification` 11, `r74-movements` 11, `r74-superadmin-supervisor` 6, `r74-roles` 5 — todas ✔ dentro de la suite completa | ídem |
| Nuevas de la ronda (unidad) | `r74-offline-membership` 2 ✔ | ídem |
| Pruebas anteriores adaptadas al cambio de regla (con nota en el código) | SaaS: `r73-credits`, `r73-decisions`, `capital-commands`, `admin-transfers`, `expenses-reversal`, `expenses`, `settlements`, `superadmin-readonly`, `render-resilience`, `suite-manifest`; CLEAN: `permissions`, `platform`, `workercash`, `basecash`, `financialreversal`, `workertransfer`, `capitalcontrol`, `transferops`, `centralcapital` | — |
| CLEAN (`npm test` de la raíz, 28 suites encadenadas, incluida la nueva `displayname` 36/36) | Salida 0 | `tmp/r74/clean-final.log` |
| Online · tipos y build de producción | Sin errores | dentro de los E2E |
| E2E bloque A | **21/21** | `tmp/r74/a/e2e-a.log` |
| E2E bloque B (antes / después) | 5/5 midiendo la tabla de R73 · **28/28** después | `tmp/r74/b/e2e-before.log`, `tmp/r74/b/e2e-after.log` |
| Reversión de 0032 / 0033 | **8/8** · **9/9** | `tmp/r74/a/rollback-check-0032.log`, `tmp/r74/e1h/rollback-check-0033.log` |

Regresiones encontradas y corregidas durante la ronda: el mapa de esquema y el contrato de ida y vuelta no conocían las columnas nuevas; el manifiesto de suites no conocía `displayname`; una comprobación de rol escrita a mano en la reaplicación (sustituida por la capacidad `payment.reverse`). Los arneses E2E anteriores (p. ej. `tmp/r73/e2e.mjs`) que buscan nombres tal como se escribieron en mayúsculas verán ahora el texto formateado: no se volvieron a ejecutar.

## 10. Migraciones

| # | Archivo | Contenido | Estado |
|---|---|---|---|
| 0033 | `superadmin_supervisor_roles` | E1 (SuperAdmin sin operaciones de ruta) y H1–H3 (autoasignación, autoaprobación de ajustes, autoentrega): `ctx_can` y 9 funciones redefinidas, 1 política nueva, 1 disparador, 1 política ampliada | **Creada, NO aplicada.** No registra datos. Reversión verificada en local (9/9) |
| 0032 | `rectification_with_payments` | Bloque A: tipo `PRINCIPAL_RECLASSIFICATION`; `sales.principal_reclassified_minor`; `payments.reapplies_payment_id`; columnas de historial; `credit_rectify` y `credit_rectify_check` con pagos; `collection_post`/`collection_reverse` con la imputación ajustada; `route_period_figures` con la reclasificación; `collection_reapply` y su comprobación | **Creada, NO aplicada** en el gestionado. Solo añade. Reversión `saas/db/rollback/0032_….down.sql` verificada en local (8/8) |

## 11. Estado por bloque

| Bloque | Aprobado | Implementado | Probado | Publicado | Bloqueado / pendiente |
|---|---|---|---|---|---|
| A · rectificación con pagos y reaplicación | Sí | Sí (`e3522eb`, `9d84c1e`) | Sí (§1.5, E2E 21/21) | **No** | D74-A1 a confirmar; periodos cerrados (D74-A2), sobrepagos (D74-A3) y reaplicación tras cuadre (D74-A4) siguen bloqueados |
| B · Consultas | Sí (dirección) | Sí | Sí (11/11, E2E 28/28) | **No** | D74-B1 (accesos y valores por defecto) |
| C · nombres | Sí | Sí (`07c624a`, `9d84c1e`) | Sí (36/36) | **No** | Separación asistida de negocios históricos: PENDIENTE; D74-C1 |
| D · Base por Ruta | Sí (dirección) | **No** | — | — | **BLOQUEADO POR DECISIÓN** O1–O6 (diseño en §4) |
| E · SuperAdmin | Sí | E1 sí (`e3522eb`, `9d84c1e`) | Sí (6 + 5 casos) | **No** | E2 (capital de empresa) y dashboard global dependen de D y G |
| F · Caja principal y Transferencias | Sí (dirección) | **No** | — | — | Depende de D (diseño en §4.6) |
| G · negativos y resultados | Dirección sí; definiciones no | **No** | — | — | **BLOQUEADO POR DECISIÓN** O8–O10 (propuesta en §4.7) |
| H · varios perfiles | Regla sí | Verificación hecha; huecos H1–H4 cerrados | Sí | **No** | La regla «solo el Administrador acumula» requiere enmendar DS-05 (D74-H1); D74-H2 |
| I · terminología y pantallas | Sí | Ajustes independientes hechos | Tipos y build | **No** | Vocabulario de «bolsa/capital» y Transferencias esperan a D |

**La intervención no se declara cerrada:** D, F y G (y E2) quedan bloqueados por decisiones financieras del propietario, con diseño y recomendación concretos en §4 y §8. A, B, C, E1, H (huecos) e I están implementados y probados en local, pendientes de publicación.

## 12. Publicación

### 12.1 Estado exacto (2026-10-23, al cerrar esta ronda)

| Componente | Estado |
|---|---|
| Git local | `main` @ commit documental de esta ronda, sobre `9d84c1e` → `e3522eb` → `07c624a` → `f9bec14`. **Nada publicado**: `origin/main` sigue en `2fa7152` (el commit documental de R73 `f9bec14` tampoco está publicado) |
| PostgreSQL gestionado (ADEX-Staging) | 0001–0031 (R73). **0032 y 0033 NO aplicadas.** Ninguna lectura ni escritura en esta ronda |
| `adex-online-api` / `adex-owner-api` (Render) | Sin cambios (R73, `2fa7152`). La API nueva anuncia `movements-v2` siempre y `rectification-payments-v1` solo con 0032 aplicada |
| `adex-online` (Vercel) | Sin cambios (`index-DyK4-kHp.js`, `2fa7152`). La puerta exige ahora `movements-v2` y `rectification-payments-v1`: un `push` sin la API nueva queda cancelado («Ignored Build Step»), como en rondas anteriores |
| BlueLine y Owners | **Sin ninguna operación ni lectura** en esta ronda. Ningún movimiento sintético fuera de bases locales |

### 12.2 Compatibilidad y orden (cuando el propietario lo autorice)

- 0032 y 0033 solo añaden o redefinen funciones; ninguna modifica ni borra filas (comprobado en local sobre el conjunto sintético). 0033 cambia autorizaciones del SuperAdmin: desde su despliegue el SuperAdmin **ya no** cierra cuadres ni periodos ni opera cajas de ruta.
- La API nueva necesita 0032 (usa sus columnas) y debe desplegarse **después** de migrar. El frontend nuevo necesita la API nueva (puerta de Vercel).
- `/v1/movements` (R73) sigue igual: el frontend publicado funciona con la API nueva.

Orden: (1) **copia previa** cifrada como en R73 §8.1 (o la política de respaldo que se decida, P-05); (2) `cd saas; npm run staging:migrate` (aplicará solo 0032 y 0033); (3) `git push origin main` (Vercel cancelará el build hasta el paso 5); (4) Render *Manual Deploy* de `adex-online-api` y `adex-owner-api` (si falla la autenticación justo después de migrar, reintentar: R73 §8.3); (5) comprobar `/healthz` con `movements-v2` y `rectification-payments-v1`; (6) Vercel *Redeploy* y comprobar `VITE_VERCEL_GIT_COMMIT_SHA`; (7) comprobaciones de solo lectura en BlueLine y Owners.

**Recomendación:** antes de publicar, que el propietario confirme D74-A1 (§1.2) y acepte el cambio de autoridad del SuperAdmin (§5.1), porque ambos cambian lo que hoy pueden hacer los usuarios de BlueLine.

### 12.3 Orden de archivos (regla R8)
Salidas de la ronda en `tmp/r74/` (a, b, c, e1h). Se conservan arneses, registros finales y capturas; se borran solo las copias de compilación de la ronda.
