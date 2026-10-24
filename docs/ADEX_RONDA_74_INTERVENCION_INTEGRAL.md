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

---

## 13. Continuación (2026-10-23): decisiones del propietario y preparación de publicación

El propietario revisó este informe y aprobó continuar con las recomendaciones, con una **modificación importante en O4**. Esta sección registra las decisiones (**sustituyen** a las recomendaciones de §8 donde difieren), lo implementado después y el estado de publicación. Los apartados anteriores se conservan como historia.

### 13.1 Decisiones aprobadas

| Id | Decisión del propietario | Estado |
|---|---|---|
| D74-A1 | Sin cambio de capital (solo tasa, parcelas o calendario), ni el desembolso incluido en un cuadre ni un cambio posterior de custodio bloquean la rectificación; sin mover efectivo, sin tocar asientos, con la reclasificación, auditoría, idempotencia y conciliación. Si cambia el capital, rigen las restricciones financieras | **APROBADA** · ya implementada así en 0032 (§1.2) · probada (R74-A-BLK-002, R74-A-BLK-005) |
| D74-A2 | No ampliar las rectificaciones a periodos cerrados (posibilidad futura documentada en §1.2) | **APROBADO MANTENER BLOQUEADO** · así está |
| D74-A3 | Total corregido inferior a lo pagado: bloqueado hasta definir sobrepagos y devoluciones | **APROBADO MANTENER BLOQUEADO** · así está (`OVERPAYMENT`) |
| D74-A4 | No reaplicar pagos cuya anulación ya entró en un cuadre (conciliación excepcional aparte, sin efectivo duplicado) | **APROBADO MANTENER BLOQUEADO** · así está (`REVERSAL_SETTLED`) |
| Undel | La reproducción sintética ya pasó; el caso real se comprueba desde la interfaz publicada, sin scripts sobre BlueLine | Sin cambios. Consulta de solo lectura previa a publicar (§13.3): BlueLine tiene 2 pagos anulados, 0 cuadres y 0 periodos cerrados, de modo que hoy la reaplicación no quedaría bloqueada por `REVERSAL_SETTLED` |
| D74-B1 | Mantener Dinero y Actividad, filtros en servidor, perspectivas, resúmenes, detalle y diseño adaptable. Periodo por defecto «Hoy». El Cobrador solo consulta su propia custodia por la API. El Administrador, por defecto, una perspectiva válida del modelo actual; con Base por Ruta, su ruta o una selección explícita (no perpetuar la bolsa). CSV si se puede recuperar con seguridad | **APROBADA** · CSV **implementado**: se arma en el navegador recorriendo las mismas páginas del servidor con los filtros vigentes (misma RLS), tope 5 000 filas con aviso, separador «;» y coma decimal; nombres tal como se registraron |
| D74-C1 | Formatear nombres de personas en el comprobante imprimible; empresas, marcas y razones sociales tal como se registraron; sin Title Case indiscriminado | **APROBADA** · **implementada** (`MovementReceiptPage`: personas formateadas; el nombre de la empresa no se toca). Separación asistida nombre/negocio: **PENDIENTE** |
| E1 | El SuperAdmin deja las operaciones financieras de ruta; conserva estructura y supervisión y, **temporalmente**, el capital de empresa. Dejará de mover dinero por completo cuando Base por Ruta sustituya las bolsas. Antes de publicar, comprobar que las rutas activas tienen responsable autorizado | **APROBADO PARA PUBLICACIÓN CONTROLADA** · comprobación hecha (§13.3): la única ruta activa tiene responsable válido |
| E2 | Retirar depósitos, retiros, asignaciones y operaciones de capital del SuperAdmin cuando el modelo nuevo ofrezca las equivalentes desde las rutas, sin etapa en que nadie pueda inyectar Base | **APROBADO** · se implementa por empresa al activar Base por Ruta (§14) |
| O1 / O2 | Cuenta `route_base` por ruta y contrapartida por ruta para inyecciones y retiros | **APROBADAS** · §14 |
| O3 | Saldos de bolsa no atribuibles quedan «sin asignar», visibles y controlados; reparto por procedimiento auditado con confirmación del Administrador; **sin** reparto proporcional ni plazo automático de 30 días | **APROBADA CON MODIFICACIÓN** (**sustituye** la recomendación de plazo de §8) · §14 |
| **O4** | **No todo gasto administrativo se imputa a una ruta.** Tres alcances: ruta, general del Administrador, general de empresa. **Alcance y fuente del dinero son dimensiones distintas.** Sin ruta pagadora arbitraria, sin que una ruta financie en silencio a otra, gasto económico registrado una sola vez. Gastos compartidos ≠ distribución analítica de costos. Clasificación mínima: operativos, adquisición de bienes duraderos, otros | **APROBADA CON MODIFICACIÓN IMPORTANTE** · **sustituye** la recomendación de §8 («imputar a una ruta»). Diseño en §13.2; la **fuente de fondos** de los gastos generales queda como **decisión D74-O4F** |
| O5 | Cambio de responsable con entrega y recepción controladas; la Base permanece en la ruta; diferencias en acta, sin movimientos ficticios | **APROBADA** · §14 |
| O6 | El SuperAdmin autoriza estructuralmente la activación por empresa, con respaldo, conciliación, plan de saldos, responsables, bolsas sin asignar, compatibilidad Offline, recuperación y evidencia | **APROBADA** · §14 |
| O7 | No combinar SuperAdmin y Administrador en la misma identidad dentro de una empresa; comprobar combinaciones existentes antes | **APROBADA** · consulta previa: **ninguna** identidad con varias membresías activas en el gestionado · **implementada** en 0033 |
| O8 | Resultado operativo básico = interés efectivamente cobrado − gastos operativos atribuibles; no es utilidad contable ni dinero retirable; gastos generales aparte; bienes duraderos clasificados aparte; sin depreciación ni impuestos | **APROBADA CON PRECISIÓN** · §14 |
| O9 | Tres estados distintos: resultado operativo negativo, flujo operativo negativo por crecimiento de cartera, insuficiencia de liquidez; una inyección no es pérdida | **APROBADA** · §14 |
| O10 | Sin cálculo automático de «ganancia retirable»; un solo «Retiro de Base», diferenciado de ganancias | **DECISIÓN DIFERIDA** |
| O11 | Transferencia explícita entre rutas (también con responsables distintos), iniciada por el responsable de origen y notificada al de destino; atómica, idempotente, auditada, sin negativos, con comprobante y sin doble conteo | **APROBADA** · §14; tránsito o confirmación física: ver §13.2 |
| D74-H1 | Enmienda de DS-05 (una persona solo acumula membresías activas en una empresa si es Administrador; SuperAdmin + Administrador nunca; por empresa; sin autoasignación) | **APROBADA** · registrada en [Visión §7](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md) · **implementada** en 0033 |
| D74-H2 | Cerrar: traspaso de efectivo de otro trabajador a la propia custodia, y asignación de rutas a otra membresía de la misma persona | **APROBADA** · **implementada** en 0033 y en la API |

### 13.2 O4 modificado: diseño de gastos generales

**Dos dimensiones independientes en cada gasto:**

| Dimensión | Valores | Para qué sirve |
|---|---|---|
| **Alcance** (a quién beneficia) | `ruta` (una ruta) · `administrador` (varias rutas de un mismo Administrador) · `empresa` (no atribuible a una ruta ni a un Administrador) | Análisis de resultados: resultado propio de cada ruta, gastos generales de Administrador, gastos generales de empresa y consolidado. **Sin prorrateo automático** (requeriría una política explícita) |
| **Fuente del dinero** (qué cuenta pagó realmente) | La Base de una ruta concreta, la custodia de un trabajador, la cuenta de empresa (modelo actual) o —por decidir— otra fuente | Trazabilidad del efectivo: cada salida de dinero debe tener una fuente válida antes de ejecutarse |
| **Naturaleza** (clasificación mínima) | `operativo` · `bien_duradero` (p. ej. la motocicleta) · `otro` | Que una compra de un bien duradero no aparezca sin explicación como gasto operativo del periodo ni como «pérdida». Sin depreciación, impuestos ni contabilidad patrimonial |

Registro de cada gasto: empresa, Administrador responsable (si aplica), concepto, importe, fecha, categoría y naturaleza, cuenta realmente utilizada, quién registró, evidencia y alcance. Un gasto general del Administrador **no crea una caja personal**.

**Decisión pendiente D74-O4F — fuente de fondos de los gastos generales con Base por Ruta** (en el modelo actual siguen pagándose como hoy, desde la empresa o la bolsa):

| Alternativa | Cómo funciona | Ventajas | Riesgos |
|---|---|---|---|
| **A · Aportes explícitos al pagar (recomendada para gastos del Administrador)** | Al registrar el gasto general, el Administrador indica de qué rutas **bajo su responsabilidad** sale el dinero y cuánto de cada una (la suma = el gasto). Una sola operación con varias patas (una por ruta aportante) y un único gasto con alcance `administrador` | Sin cuenta nueva; el gasto existe una sola vez; cada aporte es explícito, autorizado y conciliable; ninguna ruta de otro responsable participa | Exige decidir los aportes en el momento del pago |
| B · Fondo administrativo por Administrador | Cuenta nueva que solo recibe aportes explícitos de sus rutas y solo paga gastos generales | Separa el momento del aporte y del pago | Es una segunda caja: riesgo de reconstruir la antigua bolsa |
| C · Gastos generales de empresa | C1: aportes explícitos de rutas, cada uno autorizado por el responsable de esa ruta (dos pasos). C2: registro de un gasto pagado **fuera** de ADEX (informativo para resultados, sin movimiento de efectivo en el libro) | C1 trazable; C2 honesto cuando el dinero no salió de ninguna ruta | C1 más lento; C2 no controla efectivo |

**Decisión del propietario (2026-10-23): D74-O4F APROBADA para gastos generales del Administrador = alternativa A.** El Administrador decide de cuántas y cuáles de sus rutas sale el aporte para cubrir cada gasto general y cuánto aporta cada una; el gasto se registra una sola vez con alcance `administrador`. Pendiente de implementar sobre Base por Ruta (§14). **Gastos generales de empresa (2026-10-23): C1 y C2 APROBADAS, ambas se usan.** **C1 · regla definitiva (aclaración del propietario):** los aportes solo salen de rutas **a cargo del mismo Administrador** que registra el gasto; nunca de rutas de otro responsable (igual que en A y en los reembolsos). En C2, si el Administrador cubrió el gasto con dinero propio, debe quedar un **saldo a favor del Administrador**. Precisiones **confirmadas por el propietario (2026-10-23)**:
1. **Todo gasto C2 registrado en ADEX es reembolsable** («si lo registro es porque quiero que se me reembolse; si no, no lo incluyo»). No hay variante «no reembolsable»: el gasto se registra una vez y crea una **obligación de la empresa con ese Administrador** (cuenta de pasivo por Administrador).
2. **Sin aprobación:** los Administradores son socios del SuperAdmin y tienen su plena confianza; el saldo a favor queda firme al registrarlo el Administrador. Se conservan motivo, evidencia opcional, auditoría de quién lo registró, visibilidad para el SuperAdmin y corrección solo por anulación auditable (nunca borrado). *(Sustituye la precisión propuesta de aprobación por el SuperAdmin.)*
3. El saldo a favor **no es efectivo**: no suma a ninguna Base ni caja; se muestra aparte («reembolsos pendientes a Administradores») en la Caja principal y en el consolidado.
4. El **reembolso** se paga con aportes explícitos de rutas (como C1), autorizados por el responsable de cada ruta; puede ser parcial y reduce la obligación.
El mismo mecanismo puede servir para gastos generales del Administrador cuando sus rutas no tengan Base suficiente. No es patrimonio personal: es una obligación nacida de un gasto de la empresa.

**Recomendación (original):** A para gastos generales del Administrador; C1 y C2 para gastos generales de empresa (C2 cuando el pago se hizo con dinero que ADEX no administra). B solo si la operación real lo exige, con una justificación escrita. Hasta decidirlo, en empresas con Base por Ruta los gastos generales quedan **rechazados con un mensaje claro** (no se activa el modelo en ninguna empresa todavía); los gastos de ruta se pagan con la Base de esa ruta y los del trabajador con su custodia.

**O11 · ¿tránsito o confirmación?** La regla aprobada en R59 es «quien tiene el dinero lo entrega sin pedir permiso». La transferencia entre rutas se aplica en el acto y se notifica al destino. Una confirmación de recepción física **solo** importa si la entrega entre responsables distintos puede quedar en el camino; si el propietario lo considera necesario, se añade un estado «en tránsito» con confirmación del destino y un desacuerdo registrable (decisión **D74-O11T**, recomendación: no por ahora; revisar con la operación real).

### 13.3 Puerta previa a la publicación (A, B, C, E1, H, I)

| Punto | Resultado | Evidencia |
|---|---|---|
| Árbol local y commits | `main` local: `416998f` sobre `552cf93` … `f9bec14`; `origin/main` = `2fa7152` (nada publicado de R74) | `git log` |
| Contenido final de 0032 y 0033 | 0032 sin cambios (ya conforme a D74-A1…A4). 0033 **ampliada antes de aplicarse**: regla de perfiles D74-H1/O7 (`memberships_profile_rule`, `AX313`), traspaso a la propia custodia (`AX419`) y rutas a otra membresía propia (`membership_routes_no_self_scope`) | migraciones |
| Reversiones | 0032 **8/8**; 0033 **9/9** (con los objetos nuevos) | `tmp/r74/a/rollback-check-0032.log`, `tmp/r74p/rollback-0033.log` |
| Regresión completa en una copia limpia del commit (0001–0033, sin trabajo en curso) | SaaS: tipos sin errores; unidad **31/31**; PostgreSQL **509**: 504 ✔ · 4 ✖ · 1 omitida. Los ✖: **HIST-001/002/003** (históricos, previos a R73) y **ONL-061** (límite de peticiones), que pasó **17/17** al repetirlo aislado: inestabilidad de tiempos bajo la carga de dos suites en paralelo, no un defecto. CLEAN: 28 suites, salida 0. Online: tipos sin errores | `tmp/r74p/saas-full.log`, `tmp/r74p/onl-rerun.log`, `tmp/r74p/clean-full.log`, `tmp/r74p/online-tsc.log` |
| Fallos nuevos frente a la línea base | Ninguno | ídem |
| Rutas activas con responsable autorizado (E1) | BlueLine: 1 ruta activa («Aguas Lindas») con responsable de capital **válido** | consulta de **solo lectura** `tmp/r74p/pregate-antes.json` |
| Combinaciones de membresías existentes (O7, D74-H1) | **Ninguna** identidad con varias membresías activas | ídem |
| Estado gestionado | Migraciones 0001–0031; 1 empresa (BlueLine) con conservación del libro = 0; 2 Owners reales activos | ídem |
| Respaldo previo | Volcado lógico de solo lectura cifrado (AES-256-GCM, clave DPAPI), `adex-20261023T1820`, 82 tablas con datos, descifrado verificado; **restauración completa** en PostgreSQL local aislado: **82 tablas y 2 067 filas idénticas** al origen, migraciones hasta 0031; único aviso benigno «schema public already exists». Guardado fuera del repositorio, en la carpeta privada del propietario | `tmp/r74p/restore-check.log` |
| Compatibilidad API/frontend | La API nueva anuncia `movements-v2` siempre y `rectification-payments-v1` solo con 0032; la puerta de Vercel exige ambas. `/v1/movements` de R73 intacto. La API nueva necesita 0032 y 0033 aplicadas antes de desplegarse (usa sus columnas y reglas) | código |

**Conclusión:** las puertas técnicas están **superadas**. La publicación **no se ejecutó**: requiere la autorización específica del propietario. Si pasan días antes de publicar y BlueLine registra operaciones, repetir el respaldo (mismo procedimiento) justo antes de migrar.

**Orden cuando se autorice** (terminal integrada de VS Code, PowerShell): (1) respaldo si hubo operaciones desde `adex-20261023T1820`; (2) `cd saas; npm run staging:migrate` → debe aplicar solo 0032 y 0033; (3) `git push origin main` desde la raíz (Vercel cancelará el build hasta el paso 5); (4) Render, *Manual Deploy* de `adex-online-api` y de `adex-owner-api` (si falla la autenticación justo después de migrar, reintentar: R73 §8.3); (5) `https://adex-online-api.onrender.com/healthz` con `movements-v2` y `rectification-payments-v1`; (6) Vercel *Redeploy* y comprobar `VITE_VERCEL_GIT_COMMIT_SHA`; (7) comprobación de solo lectura de BlueLine y Owners (`node --require ./tmp/r26/dns-fix.cjs tmp/r74p/pregate.mjs despues`). **Qué cambia para los usuarios de BlueLine:** el SuperAdmin ya no cuadra, cierra periodos ni opera cajas de ruta (lo hace el Administrador responsable); nadie puede darse perfiles a sí mismo; las ventas con pagos se pueden corregir y los pagos anulados reaplicar.

---

## 14. Base por Ruta, gastos generales y pantallas nuevas (rama `r74-route-base`, solo local)

**No forma parte de la publicación de R74.** Está en la rama `r74-route-base` para que `staging:migrate` no aplique estas migraciones de capital al publicar `main`. Ninguna empresa real cambia de modelo: todo queda detrás de `companies.capital_model`, que por defecto es `admin_pool` (el modelo actual).

| Pieza | Commit (rama) | Contenido | Pruebas |
|---|---|---|---|
| Núcleo Base por Ruta (O1, O2, O3, O5, O6, O9, O11, E2) | `249bb53` · migración **0034** | Cuentas `route_base` (≥ 0) y `route_funding`; modelo por empresa `admin_pool` / `migrating` / `route_base`; inyección, retiro, transferencia entre rutas (inmediata y avisada al destino) y reparto auditado del saldo «sin asignar»; entrega de ruta con acta, sin movimientos ficticios; activación estructural por el SuperAdmin con requisitos comprobados en PostgreSQL; guardián de ámbito de ruta (una ruta no consume la Base de otra); en `route_base` el SuperAdmin no mueve dinero; naturaleza de gastos `operativo` / `bien_duradero` / `otro`; `route_panel` con resultado operativo básico y los tres estados O9 | `r74-route-base` **20/20**; suite completa sin fallos nuevos (solo HIST-001/002/003); reversión **15/15** (`tmp/r74p/d/`) |
| Pantallas (F y panel global de E) | `373cde3` | Según el modelo de la empresa: en `admin_pool` las pantallas actuales sin cambios; en `route_base`, Caja principal como **panel consolidado** (Base + custodias = efectivo de las rutas; cartera aparte; resultado operativo rotulado «no es utilidad contable ni dinero retirable»; tres insignias O9 distintas), **Transferencias** nuevas (cada acción explica origen, destino, quién registra, quién responde, qué saldo cambia y restricciones), entrega de ruta, activación del SuperAdmin y panel de solo lectura del SuperAdmin. Corrige un fallo: un aviso de entrega rompía Notificaciones | E2E en Chrome **69/69**; sin regresión en E2E A (21/21) y Consultas (28/28) (`tmp/r74p/ui/`) |
| Consultas con la Base | `a691082` | La perspectiva de una ruta incluye su Base; operaciones de Base con origen y destino legibles | RB-099; consultas 17/17 |
| Gastos generales (O4F) | `8c782f5` · migración **0035** | **A**: gasto general del Administrador pagado con aportes explícitos de **sus** rutas (él elige cuáles y cuánto). **C1**: gasto general de empresa con aportes de rutas del **mismo** Administrador. **C2**: pagado con dinero propio del Administrador, siempre reembolsable, sin aprobación, crea un saldo a favor (`admin_payable`), **nunca efectivo**. Reembolsos con aportes de las rutas de quien paga (en `admin_pool`, desde su bolsa). Un gasto se registra una sola vez; una operación por ruta aportante. Panel: gastos generales y reembolsos pendientes separados del resultado de cada ruta | `r74-general-expenses` **19/19**; dirigidas 69/69; suite completa sin fallos nuevos; reversión **13/13** (`tmp/r74p/o4f/`) |

**Falta para cerrar D, E2, F y G:** conectar en la Caja principal la pantalla de gastos generales y reembolsos (la API ya existe); que Consultas muestre con nombre los tres tipos de operación de O4F; revisar textos de «bolsa» en Gastos, Dashboard y Reportes cuando la empresa está en `route_base`; y las decisiones de §14.1. La activación en una empresa real requiere además publicar y aplicar 0034/0035 con autorización, respaldo y el procedimiento O6.

### 14.1 Decisiones pendientes del propietario (con recomendación)

| Id | Pregunta | Recomendación |
|---|---|---|
| RB-D1 | Saldo «sin asignar» de un Administrador inactivo o sin rutas: hoy nadie puede repartirlo | El SuperAdmin traspasa la titularidad de ese saldo a otro Administrador activo, con acta y sin mover dinero; ese Administrador lo reparte |
| RB-D2 | Cuenta de empresa con saldo al activar | Exigir cero antes de activar (asignar o retirar con las reglas actuales) |
| RB-D3 | Faltantes o sobrantes en las actas de entrega | Mismo trato que el sobrante de los cuadres, sin movimientos automáticos, hasta definir la política (F6-D02) |
| RB-D4 | ¿Se mantiene la solicitud de devolución al Cobrador con Base por Ruta? | Sí |
| RB-D5 | Pantalla de transferencias del Secretario con Base por Ruta | Solo historial |
| RB-D6 | ¿La activación exige pasar antes por «migrando»? | No obligatorio; recomendable cuando haya saldos que repartir |
| RB-D7 | ¿Quién anula un gasto general o un reembolso si el Administrador que lo registró ya no es responsable? | El responsable vigente de las rutas, con procedimiento auditado |
| RB-D8 | ¿Un Administrador puede reembolsarse a sí mismo desde sus propias rutas? | Sí (confianza entre socios), visible para el SuperAdmin |
| RB-D9 | Reembolso desde la bolsa mientras la empresa esté en el modelo actual | Sí, hasta migrar a Base por Ruta |

---

## 15. Cierre funcional local de Base por Ruta (rama `r74-route-base`)

Encargo: completar el sistema de Base y caja independiente por Ruta y dejarlo **íntegramente funcional para pruebas locales del propietario**, sin push, despliegues, migraciones gestionadas ni activación en empresas reales.

### 15.1 Estado verificado al empezar (2026-10-23, 19:09)

| Punto | Resultado |
|---|---|
| `main` | `25f3af0` (R74 preparada, 8 commits sobre `origin/main` = `2fa7152`, sin publicar) |
| Rama `r74-route-base` | `249bb53`, `373cde3`, `a691082`, `8c782f5`, `56e3ec9` (como se informó); se le incorporó `main` (`66cf317`, solo documentación) |
| Árbol | Limpio |
| Migraciones de la rama | 0001–0035 (0034 Base por Ruta, 0035 gastos generales); en ADEX-Staging siguen 0001–0031 |
| Procesos | Quedaban procesos de la sesión anterior (dos ejecuciones de pruebas colgadas desde las 13:40 y 13:58, y una base local de desarrollo de las 17:44). La herramienta no permitió detenerlos; no afectan a las pruebas (puertos dinámicos). Servidores `vite` del 15 y 20 de octubre: no se tocaron |

### 15.2 Decisiones aprobadas por el propietario (2026-10-23)

| Id | Decisión | Sustituye a |
|---|---|---|
| **Rectora** | **El Administrador es el máximo responsable del dinero.** Si una transacción de este sistema no tiene definido quién la autoriza, la autoridad financiera es del Administrador de las rutas afectadas. No requiere aprobación del SuperAdmin para resolver faltantes o sobrantes; una diferencia resuelta no mantiene la ruta bloqueada. No concede acceso a otras empresas ni a rutas ajenas. Se conservan las reglas aprobadas de transferencias inmediatas, independencia y no autoaprobación. El SuperAdmin conserva estructura, supervisión y activación estructural; no concilia en lugar del Administrador. No autoriza inventar operaciones de negocio nuevas | Cualquier propuesta anterior de aprobación superior o de bloqueo indefinido por diferencias |
| RB-D1 | Ningún Administrador se desactiva con cuentas pendientes: antes salda y entrega cuentas con su socio principal o SuperAdmin (sin crear un rol «Socio» ni devolver facultades financieras al SuperAdmin). Diagnóstico y control previo; reasignación estructural de rutas después de la entrega; datos heredados incompatibles se reportan, no se ajustan solos | §14.1 RB-D1 (traspaso de saldo sin asignar de Administradores inactivos) |
| RB-D2 | Cuenta de empresa **en cero** antes de activar, con operaciones explícitas; nunca puesta a cero ficticia ni apropiación por una ruta | Opción anterior de «documentar con una nota» |
| RB-D3 | El Administrador concilia faltantes y sobrantes bajo su responsabilidad, sin autorización superior: esperado, contado, diferencia, resolución expresa, operaciones nuevas balanceadas y auditadas; sin reescribir asientos ni cierres; sin convertir por defecto un faltante en deuda del trabajador ni un sobrante en ganancia; al resolver, la ruta continúa | §14.1 RB-D3 (diferencias solo registradas; ruta bloqueada) |
| RB-D4 | Se mantiene la solicitud de devolución al Cobrador; solicitar no mueve dinero; la entrega efectiva registra el movimiento una vez | — (confirma la recomendación) |
| RB-D5 | En Base por Ruta, Transferencias del Secretario = solo historial | — (confirma) |
| RB-D6 | «Migrando» no es obligatorio para una empresa sin movimientos y con saldos cero; se usa cuando hay saldos que repartir o posiciones que conciliar; la activación directa nunca omite validaciones; sin dobles escrituras entre modelos | — (precisa la recomendación) |
| RB-D7 | Anulación cuando cambió el responsable: la hace el Administrador **vigente** de las rutas afectadas; si son de distintos Administradores, cada uno sobre su parte, sin débitos sobre rutas ajenas ni anulaciones parciales que dejen inconsistente la operación conjunta; no anular un gasto reembolsado como si el reembolso no existiera | §14.1 RB-D7 (recomendación genérica) |
| RB-D8 | Reembolso al propio Administrador desde sus rutas: permitido hasta la obligación pendiente, con fondos, aportes explícitos por ruta, sin aprobación, visible al SuperAdmin y auditado. Excepción expresa; no elimina otras reglas de independencia | — (confirma) |
| RB-D9 | Reembolso desde la bolsa propia mientras la empresa esté en `admin_pool`; con `route_base`, el circuito nuevo; nunca pagar dos veces la misma obligación | — (confirma) |

### 15.3 Criterios de aceptación (resultado en local, 2026-10-24)

Estado: **VERIFICADO EN LOCAL** (PostgreSQL embebido aislado, datos sintéticos). **No publicado ni validado operativamente.**

| # | Criterio | Estado | Evidencia |
|---|---|---|---|
| C-01 | Todos los flujos autorizados se completan desde el navegador | ✅ local | E2E final 43/43 casos de flujo (A, B, C, D, E, I, G) — `tmp/r74/e2e/e2e-final-summary.json` |
| C-02 | Ninguna pantalla esencial sustituida por «API disponible» | ✅ local | Todo el dinero del E2E se movió por la interfaz; solo aislamiento y concurrencia (H-01…H-10) usan HTTP directo. El aviso «estarán disponibles aquí» fue retirado |
| C-03 | El Administrador concilia diferencias sin aprobación superior | ✅ local | E-02, E-03, E-08, E-10, E-11, H-01; AA-001…AA-015 |
| C-04 | Una conciliación resuelta no mantiene el bloqueo por esa diferencia | ✅ local | E-01, E-04/05, E-06, E-09, E-12…E-14 (la ruta sigue operando; el aviso se apaga; Consultas muestra «Conciliación de diferencia») |
| C-05 | Desactivar un Administrador con cuentas pendientes se rechaza con explicación; tras saldar y entregar, se permite | ✅ local | F-01…F-10 (recorrido en 15.5) |
| C-06 | Una ruta no consume fondos de otra | ✅ local | A-05, B-01…B-04, B-06, C-04, H-02…H-04, H-10 |
| C-07 | Cajas y consolidado concilian sin duplicaciones | ✅ local | A-02, Z-01 (conciliación de empresa en Norte, Sur y Vacía), Z-02 |
| C-08 | Gastos y reembolsos no duplican gasto, efectivo ni obligaciones | ✅ local | C-01…C-18, D-07…D-11, F-04, Z-03 |
| C-09 | Reintentos y concurrencia no duplican operaciones | ✅ local | H-08 (mismo id → una operación), H-09 (dos conciliaciones simultáneas: 201 + 409), H-10 (aportes simultáneos: la Base nunca queda negativa), A-08/A-10/A-11 |
| C-10 | API y PostgreSQL rechazan empresas o rutas ajenas | ✅ local | B-06, C-04, D-09, D-10, H-01…H-03, H-05, H-06; pruebas RLS de la suite |
| C-11 | El SuperAdmin supervisa sin ejecutar operaciones financieras del modelo nuevo | ✅ local | H-07, D-01…D-03, E-15, E-17, F-07 |
| C-12 | Empresas en `admin_pool` conservan su comportamiento | ✅ local | C-14…C-19, E-18, G-05; regresión completa sin cambios de resultado |
| C-13 | La transición conserva posiciones y trazabilidad, sin ingresos ficticios | ✅ local | G-01…G-11 (activación directa negada con saldos → Migrando → Base por Ruta; reparto con evidencia; ingresos y cartera sin cambios). Limitación: las custodias de la empresa de transición estaban en cero |
| C-14 | Offline: no crea clientes ni ventas y conserva sus operaciones permitidas | ✅ local | I-04…I-08 |
| C-15 | Sin regresiones nuevas frente a una línea base reproducible | ✅ local | Worktree limpio de `8a185ea`: 573 pruebas, 569 ✔, 3 ✖ (HIST-001/002/003: mismo error AX413, misma línea que la base, también aisladas en ambos worktrees), 1 omitida (RND-060, igual que la base); +24 nuevas, todas ✔; unidad 31/31; CLEAN `npm test` todo PASS; tipos y build sin errores — `tmp/r74/reg/` |
| C-16 | Documentación, commits y pasos de prueba coinciden con el resultado | ✅ | Este apartado, Registro Maestro, `tmp/r74/local/README.md` (sin marcas pendientes), commits de 15.4 |

### 15.4 Qué se hizo (commits locales en `r74-route-base`, sin push)

| Commit | Contenido |
|---|---|
| `61427ce` · migración **0036** | Autoridad del Administrador y conciliación: cuenta `route_difference`, operación `DIFFERENCE_CONCILIATION` y tabla inmutable `difference_conciliations` (RB-D3); `admin_pending_accounts`, control previo y bloqueo AX433 de la desactivación en todos los modelos (RB-D1); cuenta de empresa en cero sin excepción por nota (RB-D2); requisito `direct-activation-or-migrating` (RB-D6); anulación de operaciones conjuntas solo por el responsable vigente de **todas** las rutas aportantes, nunca parcial (RB-D7, AX434); disparador `routes_controller_change_guard` (AX402), que cierra un hueco por el que un Administrador podía hacerse responsable de una ruta ajena por SQL; `route_panel` con diferencias y alerta `PENDING_DIFFERENCES`; feature `admin-authority-v1` (fuera de la puerta de Vercel). RB-D4, D5, D8 y D9: verificados con pruebas, sin cambios de lógica |
| `8a185ea` | Pantallas: gastos generales A/C1/C2 y reembolsos en la Caja principal; C2 y reembolso desde la bolsa en `admin_pool`; pantalla **Diferencias** (solo lectura para SuperAdmin y Supervisor); control previo de desactivación en Usuarios; Consultas con todos los tipos nuevos (las obligaciones y diferencias nunca cuentan como efectivo) y comprobante de operación; Dashboard desde `route_panel`; textos sin «bolsa» en Gastos y Reportes con Base por Ruta |
| `b84c987` | Defectos hallados por el E2E final: tope de desembolso = Base de la ruta (no el saldo sin asignar); botón «Anular» para el responsable vigente (RB-D7); total de Gastos rotulado; textos de corrección/reaplicación neutrales |

Migraciones de la rama: 0001–0036 (0034, 0035 y 0036 solo en la rama; ADEX-Staging sigue en 0001–0031). Reversiones probadas: 0034 15/15, 0035 13/13, 0036 13/13 (el esquema vuelve a ser idéntico; la reversión de 0036 se niega si ya hay conciliaciones). 0036 es generada por `tmp/r74/w1/build-0036.mjs`.

### 15.5 Cómo se despeja cada bloqueo de desactivación (RB-D1) desde la interfaz

| Bloqueo | Paso |
|---|---|
| Saldo sin asignar | El Administrador: Transferencias → Reparto de saldo sin asignar a una de sus rutas |
| Reembolso pendiente | El Administrador: Caja principal → Gastos generales y reembolsos → Reembolsos pendientes → reembolsar (RB-D8) |
| Diferencias sin conciliar / saldo en control | El Administrador: Diferencias → conciliar |
| Responsable de rutas | SuperAdmin: Usuarios → otro Administrador → añadirle las rutas; Panel de rutas → Detalle → «Cambiar responsable» |
| Entrega pendiente | El Administrador entrante confirma el conteo desde el aviso de su Caja principal |

### 15.6 Limitaciones reales

- Todo es local. Nada está publicado ni validado operativamente; ninguna empresa real cambió de modelo.
- En el navegador no se ejercitó «Devolver el sobrante a su dueño» (sí está probado en la API, AA-*).
- El E2E final se ejecutó en dos partes (82 + 41) por el límite de tiempo de los procesos; el modo de una sola ejecución no se corrió.
- El texto neutral de los modales de corrección se cambió después del E2E (solo texto); CLEAN y el build se repitieron después.
- El cierre de periodo se probó sobre la semana anterior (el servidor exige que el periodo haya terminado).
- En «Selecciona tu ruta» del Supervisor (`src/pages/collector/CollectorSelectRoutePage.tsx`), «Base de la ruta» muestra la suma de custodias, no la Base real en `route_base`. Es un archivo compartido de CLEAN y no se cambió; es un rótulo, no un cálculo de dinero.
- Herramientas locales (no versionadas, `tmp/` está en `.gitignore`): `tmp/r74/local/` (arranque, siembra, humo 42/42) y `tmp/r74/e2e/e2e-final.mjs`.

### 15.7 Decisiones del propietario que quedan abiertas (no bloquean las pruebas locales)

| Id | Pregunta | Situación actual |
|---|---|---|
| RB-D10 | ¿Un faltante de acta de entrega se puede cargar al Administrador saliente? | Hoy solo «faltante de la ruta»; cargarlo exigiría una cuenta por cobrar nueva (no se inventó) |
| RB-D11 | ¿El responsable de capital puede anular un gasto de ruta que él mismo registró? | La regla de independencia aprobada (F5-D02, AX717) lo impide; como solo él registra esos gastos, nadie puede anularlos hasta que cambie el responsable |
| RB-D12 | RB-D7 «cada uno sobre su parte»: ¿anulación por partes de una operación conjunta? | Implementado el rechazo (AX434) salvo que el actor controle todas las rutas; por partes exige definir qué gasto u obligación queda |
| RB-D13 | ¿Un Administrador puede pagar el reembolso pendiente de **otro** Administrador desde la pantalla? | La API lo admite; la pantalla solo muestra el saldo a favor propio |

### 15.8 Plan de publicación posterior (requiere autorización expresa; no ejecutado)

1. **Antes:** publicar primero `main` (R74: 0032 y 0033) según §13.3. Fusionar `r74-route-base` en `main` solo con autorización, porque `staging:migrate` aplicaría 0034–0036.
2. **Respaldo:** copia cifrada nueva de ADEX-Staging, restaurada y verificada (procedimiento R73/R74), con su referencia anotada.
3. **Diagnóstico de solo lectura:** `tmp/r74/w1/legacy-inactive-admins.sql` (Administradores inactivos con cuentas pendientes, empresas con saldo de empresa); reportar, no ajustar.
4. **Migraciones:** `staging:migrate` aplica 0034, 0035 y 0036 en orden. Esto no cambia el modelo de ninguna empresa: todas siguen en `admin_pool`. Tras migrar, puede fallar la autenticación de Render unos minutos (ver memoria de contraseñas de roles): reintentar.
5. **Servicios:** desplegar la API (Render) y comprobar que `/healthz` anuncia `route-base-v1`, `general-expenses-v1` y `admin-authority-v1`; después la web (Vercel; la puerta exige `movements-v2` y `rectification-payments-v1`).
6. **Comprobaciones:** humo de solo lectura en BlueLine (sin operaciones sintéticas ni destructivas); conciliación de empresa sin diferencias; las empresas en `admin_pool` muestran las mismas pantallas que antes.
7. **Activación por empresa, por separado:** con autorización del propietario para cada empresa. SuperAdmin de esa empresa → Modelo de capital → requisitos en verde → con saldos, «Migrando» → reparto del saldo sin asignar con evidencia → activar con referencia de respaldo. Nunca activar BlueLine ni otra empresa real sin esa autorización.

## 16. Publicación en Online y transición de BlueLine (2026-10-24)

Encargo: terminar el despliegue de R74 y activar Base por Ruta en BlueLine. La publicación y la activación están **autorizadas** por el propietario. Online es el entorno de prelanzamiento; sus datos se conservan.

### 16.1 Estado verificado al retomar (2026-10-24, 11:15 hora de Colombia)

| Punto | Resultado |
|---|---|
| Git | `main` = `r74-route-base` = `origin/main` = `8d37c05`; árbol limpio |
| Migraciones en ADEX-Staging | 0001–**0037** (0032–0037 aplicadas por `staging:migrate` a las 15:53 UTC, con checksums iguales a los del repositorio; `tmp/r74pub/staging-migrate.log`, `tmp/r74pub/rehearsal-report.json`) |
| Render | `adex-online-api` y `adex-owner-api` **live en `8d37c05`** (despliegues manuales `dep-dbedelq9lscs73aq4qt0`, 16:05 UTC, y `dep-dbedg1d9fdbs73aob3eg`, 16:08 UTC). `/healthz` de la API: `movements-v2`, `rectification-payments-v1`, `route-base-v1`, `general-expenses-v1`, `admin-authority-v1`, `controller-authority-v1` (marcador de 0037). Owner: `owner-v1, owner-clean-v1, owner-email-v1` |
| Vercel | El build de `8d37c05` (15:53 UTC) fue **cancelado por la puerta** porque la API aún no anunciaba `movements-v2`/`rectification-payments-v1`; seguía servido `index-DyK4-kHp.js` (R73) |
| Vigilante de la sesión anterior | No se usó ni se asumió activo |

### 16.2 Publicación del frontend

`vercel redeploy` del despliegue cancelado (mismo commit `8d37c05`, destino producción). La puerta vio las funciones exigidas y construyó. **Servido:** `adex-online.vercel.app` → `index-C_tgH73z.js`, que incrusta `8d37c05fc578e8aba40fd4a1c1251bfa253040ad`. Los tres servicios quedan en el mismo commit.

### 16.3 Respaldo vigente

| Respaldo | Momento | Verificación |
|---|---|---|
| `adex-20261024T1408` | 14:08 UTC | Restauración aislada: 82 tablas, 2.233 filas idénticas (`tmp/r74pub/restore-check.log`); usado en el ensayo |
| `adex-20261024T1551` | 15:51 UTC, justo antes de migrar | Restauración aislada: 82 tablas, 2.233 filas idénticas, 0 diferencias (`tmp/r74pub/restore-check-1551.log`). El único error de `pg_restore` es «schema public already exists», esperado |

Vigencia: la foto de solo lectura de las 16:19 UTC (`tmp/r74p/pregate-ahora-1124.json`) y la de las 16:35 UTC (`tmp/r74/final/bl-antes.json`) coinciden con la tomada tras migrar: mismos saldos cuenta a cuenta y mismos recuentos (36 ventas, 68 pagos, 640 parcelas, 112 operaciones). **No hubo movimientos después del respaldo `adex-20261024T1551`**, así que sigue siendo la referencia para la activación.

### 16.4 Regresión completa sobre `8d37c05`

| Suite | Resultado | Evidencia |
|---|---|---|
| SaaS: tipos | Sin errores | `tmp/r74/final/saas-full.log` |
| SaaS: unidad | 31/31 | ídem |
| SaaS: PostgreSQL (suite completa, una sola ejecución) | **585 pruebas: 584 ✔, 0 ✖, 1 omitida** (RND-060, como en la línea base); 926 s | ídem |
| CLEAN `npm test` | Todas las suites en verde. WORKER-XFER-017 (reactividad de la vista) falló una vez mientras corría en paralelo con la suite de PostgreSQL; aislado, 3/3 en verde. Las 14 suites que la cadena `&&` dejó sin correr se ejecutaron después: todas con salida 0 | `tmp/r74/final/clean-*.log` |
| Online y CLEAN: tipos | Sin errores | `tmp/r74/final/online-typecheck.log`, `clean-tsc.log` |
| E2E de navegador de Base por Ruta (3 partes) | **83/83, 41/41 y 25/25** (partes 1, 2 y 3). Dos intentos previos se interrumpieron porque PostgreSQL local terminó con `0xC000013A` (Ctrl+C de la consola) mientras se ejecutaban otros comandos en paralelo; repetidos sin interferencias, todo en verde. Registros de PostgreSQL: `tmp/local/logs/postgres-fin2.log`, `postgres-fin3.log` | `tmp/r74/final/e2e/` |

Cobertura de las correcciones finales, comprobada en el código y en las pruebas: reversión de movimientos propios por el responsable de capital (0037, `controller-authority-v1`; pruebas r74 y E2E); otros Administradores con acceso operativo sin autoridad financiera (0037); indicador de Base del Supervisor (`7022642`); transición con custodias distintas de cero y devolución del sobrante desde la interfaz (E2E parte 3); reembolsos y reversiones conjuntas (propuesta, confirmación, cancelación) sin duplicaciones (E2E y suite r74). Herramientas reproducibles versionadas sin secretos: `saas/scripts/local/` (arranque, humo y `e2e-routebase.mjs`).

### 16.5 Posiciones de BlueLine y decisión del propietario

Foto de solo lectura previa a la activación (`tmp/r74/final/bl-antes.json`), modelo `admin_pool`:

| Cuenta | Saldo | Titular |
|---|---|---|
| Cuenta de la empresa | R$ 32.995,00 | — |
| Caja (bolsa) del Administrador | R$ 123,00 | Andrew |
| Custodia | R$ 6.959,00 | Leonel (Cobrador, Aguas Lindas) |
| **Efectivo total** | **R$ 40.077,00** | |
| Cartera | R$ 37.944,99 | Aguas Lindas |

Andrew es el Administrador responsable de capital de Aguas Lindas (`capital_controller_membership_id`, activo), única ruta de BlueLine. Helmer es Administrador con acceso operativo a la ruta, sin responsabilidad de capital.

Origen de la cuenta de la empresa (libro, `tmp/r74/final/company-origin.json`): el 22/10 el SuperAdmin Andrés depositó R$ 100.000,00 («Capital empresas Alexis») y asignó R$ 67.005,00 a Andrew («Capital para Aguas Lindas»). Los R$ 32.995,00 restantes no tenían destino documentado. La caja de Andrew (R$ 123,00) es el resto de lo que recibió para Aguas Lindas y de las devoluciones del Cobrador.

**Decisiones del propietario (2026-10-24):**

- **D74-F1:** lo que está en la caja del Administrador principal de Aguas Lindas (Andrew) corresponde a Aguas Lindas. No autoriza atribuir dinero de otros Administradores ni de cajas no identificadas.
- **D74-F2 (corregida el mismo día por el propietario):** los R$ 32.995,00 de la cuenta de la empresa son capital que aún no se había distribuido a ningún Administrador. Se **retiran de la empresa** («Retiro de capital de la empresa», SuperAdmin) antes del corte, y el capital se vuelve a aportar ya con Base por Ruta funcionando, mediante «Inyección de Base» del responsable de la ruta. Sustituye a la primera respuesta (asignarlos a Andrew y repartirlos), que el propietario dio sin haber revisado aún la cuenta.

### 16.6 Activación

Estado: **ACTIVADA el 2026-10-24 a las 17:16 UTC** por Andrés (SuperAdmin) y Andrew (responsable), desde sus sesiones. Verificación de solo lectura en `tmp/r74/final/bl-despues.json` y `bl-invariants.json`.

| Momento (UTC) | Operación | Quién | Valor |
|---|---|---|---|
| 17:08 | `COMPANY_WITHDRAWAL` «Dejar caja de superadmin en cero» | Andrés | R$ 32.995,00 |
| 17:15 | Modelo → `migrating` | Andrés | — |
| 17:16 | Modelo → `route_base` | Andrés | — |
| 17:19 | `ROUTE_BASE_INJECTION` (por error) | Andrew | R$ 123,00 |
| 17:21 | `REVERSAL` de esa inyección («debí trasladar el saldo sin asignar») | Andrew | R$ 123,00 |
| 17:23 | `LEGACY_POOL_TO_ROUTE` (reparto del saldo sin asignar a Aguas Lindas) | Andrew | R$ 123,00 |

La reversión de su propia inyección por el responsable, sin aprobación de nadie, es la autocorrección de 0037 funcionando en Online.

| Comprobación | Antes | Después |
|---|---|---|
| Modelo | `admin_pool` | **`route_base`** |
| Cuenta de la empresa / caja de Andrew | R$ 32.995,00 / R$ 123,00 | R$ 0,00 / R$ 0,00 |
| Base de Aguas Lindas | — | **R$ 123,00** |
| Custodia de Leonel | R$ 6.959,00 | R$ 6.959,00 |
| Efectivo total | R$ 40.077,00 | **R$ 7.082,00** (= − R$ 32.995,00 retirados, D74-F2) |
| Cartera / ingresos / gastos | R$ 37.944,99 / R$ 5.718,99 / R$ 27.697,00 | Sin cambios |
| Ventas, pagos, parcelas, solicitudes, gastos, clientes | 36 / 68 / 640 / 37 / 1 / 36 | Sin cambios |
| Operaciones de capital | 112 | 116 (las 4 de la tabla anterior) |
| Conservación del libro; posiciones ≠ asientos; operaciones desbalanceadas; cuentas de efectivo negativas; traspasos pendientes | 0 | 0 |
| Responsable de capital de Aguas Lindas | Andrew | Andrew |

La conciliación de 26 comprobaciones de la API (`/v1/capital/reconciliation`) exige la sesión del SuperAdmin y no se ejecutó en su nombre; los invariantes anteriores se comprobaron con consultas propias de solo lectura. El propietario puede abrirla desde su sesión. Inyección de capital: **pospuesta por decisión del propietario** hasta verificar personalmente el funcionamiento.

<details><summary>Procedimiento entregado (referencia)</summary>

 Todo lo demás está preparado y verificado: la API y la web publicadas, el respaldo vigente, el diagnóstico previo y las pantallas. No se ejecutó ninguna operación en nombre de esos usuarios.

Procedimiento (etiquetas comprobadas en el código publicado `8d37c05`; el ensayo sobre la copia de `adex-20261024T1408` lo ejecutó con 26/26 invariantes):

| # | Quién | Pantalla y acción | Resultado esperado |
|---|---|---|---|
| 1 | Andrés (SuperAdmin) | Capital → **Realizar movimientos** → Operación «Retiro de capital de la empresa» → Valor = 32.995,00 → Concepto → **Registrar** | Cuenta de la empresa R$ 0,00; caja de Andrew sigue en R$ 123,00 |
| 2 | Andrés | Capital → **Modelo de capital** → Cambio = «Congelar bolsas para preparar el corte (migración)» → Evidencia de la autorización → escribir `CONGELAR` → **Congelar bolsas** | Modelo «Migrando» |
| 3 | Andrés | **Volver a comprobar** (debe decir «Todos cumplidos») → Cambio = «Activar Base por Ruta» → Evidencia → Referencia del respaldo verificado = `adex-20261024T1551` → escribir `ACTIVAR` → **Activar Base por Ruta** | Modelo Base por Ruta; Andrew con «Saldo sin asignar» R$ 123,00 |
| 4 | Andrew (responsable de capital) | Caja principal → tarjeta «Saldo sin asignar» → **Repartir a una ruta** → Ruta = Aguas Lindas → Valor = 123,00 → Concepto → Evidencia → casilla «Confirmo…» → **Registrar** | Base de Aguas Lindas R$ 123,00; saldo sin asignar R$ 0,00 |
| 5 (cuando corresponda) | Andrew | Transferencias → grupo «Base de la ruta» → **Inyección de Base** → Ruta = Aguas Lindas → Valor (el capital que se aporte) → Concepto → **Registrar** | Base de Aguas Lindas aumenta en ese valor |

Conciliación esperada tras el paso 4 (se comprueba con `node tmp/r74/final/bl-check.mjs despues`, solo lectura): efectivo total R$ 7.082,00 (= R$ 40.077,00 − R$ 32.995,00 retirados; Base R$ 123,00 + custodia de Leonel R$ 6.959,00), más lo que se inyecte en el paso 5; cartera R$ 37.944,99, ingresos y gastos sin cambios; mismos recuentos de ventas, pagos, parcelas, solicitudes, gastos y clientes; solo las operaciones de capital nuevas del retiro, el reparto y las inyecciones, más los cambios de modelo; conservación del libro = 0.

</details>

### 16.7 Pendientes reales

| Pendiente | Responsable |
|---|---|
| Inyección de capital en la Base de Aguas Lindas (paso 5), cuando el propietario lo decida tras su verificación personal | Andrew |
| RB-D10 (faltante de acta cargable al Administrador saliente), RB-D12 (anulación por partes de una operación conjunta), RB-D13 (pagar desde la pantalla el reembolso de otro Administrador) | Decisión del propietario |
| Política de respaldos (P-05): las copias cifradas son manuales; sin PITR | Decisión del propietario |
