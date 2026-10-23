# ADEX — Ronda 73: correcciones operativas del socio, integridad financiera y mejoras funcionales

| | |
|---|---|
| Fecha | 2026-10-22 |
| Base | `main` @ `72b6e1b` (= `origin/main` al empezar) |
| Alcance | SOC-01 a SOC-09. **SOC-10 excluida y no tocada** (CPF/RG) |
| Entorno de trabajo | Solo PostgreSQL **local** y aislado, empresas y personas **sintéticas**. Ninguna operación sobre ADEX-Staging, BlueLine ni las cuentas Owner |
| Estado de publicación | **PUBLICADA Y DISPONIBLE PARA EVALUACIÓN OPERATIVA** (2026-10-23): copia cifrada verificada, 0030 y 0031 aplicadas, `origin/main` = `2fa7152`, las dos API en Render y la web en Vercel sirviendo `2fa7152`. Ver §8 (publicación) y §9 (guía de evaluación) |

## 0. Criterios de cierre definidos antes de implementar

| Bloque | Criterio de aceptación |
|---|---|
| A · SOC-07 | El caso 20 % → 10 % se reproduce y, tras la corrección, el **servidor** genera total, parcelas y asiento con la tasa autorizada; reintentos y aprobaciones simultáneas no duplican; permisos y aislamiento intactos |
| A · SOC-04 | El autorizador cambia las parcelas antes de aprobar; servidor recalcula valor, total, calendario y fecha final; se conservan lo pedido y lo aprobado |
| A · SOC-09 | Puerta del propietario: una rectificación permitida deja coherentes desembolso, custodia, capital pendiente, intereses, parcelas, libro y auditoría, sin romper invariantes históricas (conciliación del SuperAdmin sin fallos) |
| B · SOC-02 | Un Administrador con dinero en su bolsa vende directo aunque la ruta no tenga efectivo en custodia; sin fondos, sin doble consumo, sin ignorar la custodia |
| C · SOC-03/05 | 20 parcelas propuestas (no límite); negocio obligatorio al crear cliente en pantalla y API, sin rellenar clientes existentes |
| D · SOC-08 | Tabla de varias columnas con filtros en los encabezados; una fila por operación lógica (sin la fila duplicada de la entrega); paginación y filtros en el servidor con RLS |
| E · SOC-01 | Iniciar sesión en otro dispositivo revoca la sesión anterior en el servidor (empresa y Owner); las capturas sin conexión no se pierden ni se aceptan con la sesión revocada |
| F · SOC-06 | Captura intencional confirmada; corrección manual del marcador; historial; sin proveedor externo no aprobado |
| Regresión | Suites existentes del SaaS y de CLEAN sin fallos nuevos; HIST-001/002/003 analizados, no maquillados |

## 1. Diagnóstico

### SOC-07 — interés autorizado distinto del desembolsado (causa exacta)

- **El servidor no tenía el defecto.** `approveRequest` (`saas/src/credits/service.ts`) recalcula total y cuota con la tasa recibida y `adex.credit_disburse` exige que el desembolso use exactamente las condiciones aprobadas (prueba existente CRED-003).
- **Causa:** el puente de ADEX Online `online/src/bridge/services/saleRequestService.ts` (`approveSaleRequestOnline`) **solo enviaba `notes`** a `POST /v1/credit-requests/:id/approve`. La pantalla del Secretario pasaba `interestRate`, `frequency`, `paymentDays`, `phoneConfirmed` y la nota telefónica, pero el puente los descartaba. El servidor aprobaba con lo solicitado (20 %) y el desembolso generó las parcelas del 20 %, mientras la pantalla seguía mostrando la selección local (10 %) y el aviso «Solicitud aprobada».
- Reproducción: R73-SOC07-001 (aprobar enviando solo `notes`, como el puente defectuoso, deja el 20 %).
- La venta real afectada **no se tocó**. Puede corregirse con SOC-09 si cumple sus condiciones (sin cobros, desembolso fuera de cuadre y de periodo cerrado) — decisión y ejecución del propietario/Administrador.

### SOC-02 — venta del Administrador bloqueada por la antigua caja de ruta

- **El servidor no tenía el defecto:** la venta directa de un Administrador la paga la **bolsa del responsable de capital de la ruta** (`credit_disburse`), con AX401 sin fondos y AX402 si quien vende no es el responsable.
- **Causa:** los formularios (`ActiveSalesPage`, `ClientsPage` del puente, `useCapitalGuard`) comparaban el importe con la «Base de la ruta» de CLEAN; en Online el puente la calculaba como **Σ custodias de todos los trabajadores de la ruta**. Sin entregas a trabajadores, la «Base» era 0 y el botón quedaba deshabilitado aunque la bolsa tuviera dinero. El Cobrador no se veía afectado porque solicita (no vende directo).

### SOC-08 — fila duplicada en Consultas

- Cada entrega de la bolsa al trabajador es **una** operación `WORKER_DELIVERY` en `capital_operations` con dos patas en `capital_entries`.
- El duplicado era del frontend: `capitalRecords.ts` proyecta esa operación en dos registros de CLEAN (`capitalMovements` y su espejo `cashCustodyMovements:<id>:custodia`) y el historial de CLEAN pinta una fila por registro. Lo mismo con `WORKER_RETURN`.
- No existía un listado unificado y paginado en el servidor (solo `/v1/capital/operations` con tope 500 y sin filtros).

### SOC-01 — sesiones

- Supabase Auth emite los tokens; la API valida cada petición contra `revoked_sessions` y el corte por identidad (`ctx_session_valid`). No había registro de la sesión **vigente**: varias sesiones convivían. Cambiar de empresa o rol no crea sesión (DS-05).
- Las capturas sin conexión del Cobrador se guardan cifradas por identidad y membresía y, ante `SESSION_REVOKED`, vuelven a «pendiente» sin borrarse.

### SOC-06 — ubicaciones

- `client_locations` (0029) ya es historial append-only de la ubicación de referencia; la venta con GPS guarda la lectura del **dispositivo** en `sale_locations` y **nunca** se convierte en ubicación del cliente (comprobado en código y en las pruebas de R67).
- El Administrador solo podía marcar un punto sin ver la dirección escrita, sin corregir antes de confirmar y sin historial visible. No hay geocodificación (ningún proveedor).

## 2. Cambios implementados

| SOC | Qué cambió | Dónde | Necesita |
|---|---|---|---|
| 07 | El puente envía todas las condiciones elegidas y **rechaza informar éxito** si el servidor guardó otra cosa | `online/src/runtime/approvalBody.ts`, puente `saleRequestService.ts` | Solo frontend (compatible con la API publicada) |
| 04 | Parcelas modificables al aprobar (servidor y tres pantallas: Secretario, Supervisor, Administrador) con resumen de total y parcela calculado como el servidor; lo pedido y lo aprobado quedan guardados | 0030, `credits/service.ts`, `ApprovalInstallments.tsx` | 0030 + API + frontend |
| 09 | `POST /v1/credits/:id/rectify` y `adex.credit_rectify` (solo Administrador); historial `GET /v1/credits/:id/rectifications`; diálogo «Corregir venta» | 0030, `credits/service.ts`, `RectifySaleModal.tsx` | 0030 + API + frontend |
| 02 | El límite de la venta es el dinero que la pagaría (bolsa del responsable o custodia propia sin faltante arrastrado); textos «Disponible para esta venta» | `online/src/bridge/services/saleFunds.ts`, ganchos del puente | Solo frontend |
| 03 | 20 parcelas propuestas en todos los formularios (`DEFAULT_INSTALLMENTS`) | `src/lib/saleDefaults.ts` y formularios | Solo frontend |
| 05 | Negocio obligatorio al crear (pantallas y API); un negocio registrado no se vacía; clientes antiguos sin negocio siguen editables, nada se rellena | `structure/clients.ts`, formularios del puente | API + frontend |
| 08 | `GET /v1/movements` (una fila por operación lógica + eventos sin dinero; filtros, orden y páginas en el servidor) y tabla con filtros en los encabezados, columnas visibles, detalle con patas y CSV; historial anterior como «Comprobantes» sin la fila espejo | `saas/src/movements/service.ts`, `MovementsTable.tsx` | API + frontend (sin migración) |
| 01 | Una sola sesión activa por identidad (empresa y Owner) | 0031, `identity/service.ts`, APIs, `online/src/lib/client.ts` | 0031 + API + frontend |
| 06 | Captura GPS en dos pasos con precisión visible; mapa con dirección escrita, marcador provisional arrastrable, historial; contrato de geocodificación **sin proveedor** | `ClientReferenceLocation.tsx`, `RouteMapPage.tsx`, `geocoding.ts` | Solo frontend |

### Diseño financiero de SOC-09 (rectificación)

- **Condiciones (todas en la base, bajo bloqueo ruta → crédito → cuentas):** rol Administrador con la ruta en su alcance; crédito `activa`, desembolsado y con asiento; **ningún pago** (tampoco anulado) ni cuota con abono; el desembolso **no** está incluido en un cuadre vigente de la custodia que pagó (`to_seq ≥ seq` de su pata); ningún periodo cerrado (fecha del asiento, del desembolso, inicio anterior y nuevo, hoy); quien pagó sigue pudiendo responder del efectivo (custodio vigente de la ruta) y, si pagó la bolsa, solo su Administrador; motivo y evidencia (≥ 10 caracteres); confirmación de que no hay cobros pendientes en un dispositivo sin conexión (el servidor no puede verlos); concurrencia optimista (`expectedRectifications`); id de operación idempotente.
- **Representación de la diferencia:** el asiento `LOAN_DISBURSEMENT` original **no se modifica**. Δ = capital nuevo − registrado se registra como operación nueva `DISBURSEMENT_ADJUSTMENT` (fecha de hoy) entre **la misma cuenta que pagó** y la cartera de la ruta. Δ > 0 exige saldo (sin faltante arrastrado); Δ < 0 devuelve a esa cuenta el efectivo que nunca salió; Δ = 0 no mueve dinero. No se crean entradas ni salidas inventadas: la custodia pasa a reflejar el efectivo realmente entregado.
- **Crédito y cuotas:** conserva id, fecha y hora del desembolso, asiento y solicitud; capital, tasa, interés, total, saldo, parcelas, calendario y fecha final se recalculan con el motor de CLEAN (la última parcela absorbe el redondeo). Las cuotas **no se borran** (invariante 0002): cada número se actualiza en su fila y las nuevas se añaden.
- **Historial:** `adex.credit_rectifications` (append-only) guarda crédito y cuotas completos antes y después, Δ, cuenta que pagó, motivo, evidencia, Administrador, fecha contable y transacción; además `RECTIFY_CREDIT` en la auditoría.
- **Cuadres y cierres:** el ajuste cuenta como desembolso en el ciclo de la custodia y en las cifras del periodo (no como «otros»). Ningún cuadre ni cierre existente contiene este tipo nuevo, por lo que sus cifras archivadas no cambian.
- **Conciliación del SuperAdmin:** «desembolso ↔ crédito» suma los ajustes del crédito; la cartera de la ruta sigue cuadrando con el capital vigente.
- **No se anula** por la vía genérica: una rectificación equivocada se corrige con otra (mismas condiciones).

**Bloqueado por decisión (no implementado):** reducir el número de parcelas de una venta desembolsada (las cuotas no se pueden borrar) y la **excepción de conciliación** cuando quien pagó ya no custodia en la ruta o la diferencia no cabe en el libro — ver §5.

### Diseño de SOC-01

- `adex.identity_active_sessions` guarda la sesión vigente de cada identidad. `adex.claim_session` se ejecuta **solo** en un inicio de sesión explícito (empresa: `POST /v1/session/claim` desde el login; Owner: `POST /control/v1/session/start`), nunca al renovar el token ni al cambiar de contexto.
- La sesión anterior queda en `revoked_sessions` con el motivo nuevo `superseded`, con el bloqueo exclusivo de la identidad (las peticiones en curso terminan antes). `ctx_session_valid` exige además ser la sesión vigente: RLS, apertura de contexto y API Owner rechazan la anterior aunque renueve su token.
- Pestañas: comparten la sesión del navegador. Una pestaña cuya sesión fue revocada ya no borra (ni sobrescribe al renovar) la sesión nueva que otra pestaña guardó.
- Sin conexión: el dispositivo viejo conserva sus capturas cifradas; al sincronizar con la sesión revocada el servidor responde `SESSION_REVOKED` y **no escribe nada** (R73-SES-005).

## 3. Migraciones

| # | Archivo | Contenido | Estado |
|---|---|---|---|
| 0030 | `credit_conditions_rectification` | Parcelas pedidas/aprobadas; guardián de solicitudes; tipo `DISBURSEMENT_ADJUSTMENT`; `sales.rectification_count`; `credit_rectifications`; `adex.credit_rectify`; ciclo de custodia y cifras de periodo con el ajuste; política de lectura de operaciones | **Creada, NO aplicada** en el PostgreSQL gestionado. Aplicada solo en bases locales de prueba |
| 0031 | `single_active_session` | `identity_active_sessions`; motivo `superseded`; `ctx_session_valid` con sesión vigente; `adex.claim_session` y envoltura `adex_control.claim_session` | **Creada, NO aplicada** en el PostgreSQL gestionado |

Ambas solo añaden; no modifican ni borran filas existentes. Funciones anunciadas por `/healthz` solo con su migración: `credit-rectification-v1` (0030) y `single-session-v1` (0031). `movements-v1` es solo de la API. La puerta de Vercel exige `credit-rectification-v1` y `movements-v1`.

## 4. Pruebas

Todas sobre PostgreSQL local con las migraciones 0001–0031 y datos sintéticos. Registros en `tmp/r73/` (no versionado).

| Conjunto | Resultado | Registro |
|---|---|---|
| Línea base antes de cambiar nada (`72b6e1b`, 0001–0029) | 426 pruebas: 422 ✔ · 3 ✖ (HIST-001/002/003) · 1 omitida (staging real) | `baseline-saas-test.log` |
| SaaS completo final (`npm test`: tipos + unidad + PostgreSQL, 0001–0031) | Unidad **26/26** · PostgreSQL **459**: **455 ✔** · 3 ✖ (los mismos HIST) · 1 omitida | `saas-full-final.log` |
| Nuevas de la ronda | **36/36** ✔: `r73-credits` 21 (SOC-07 ×5, SOC-04 ×2, SOC-09 ×12, SOC-05, SOC-02), `r73-movements` 6 (SOC-08), `r73-sessions` 6 (SOC-01), unidad `r73-approval-body` 3 (SOC-07) | `test-r73-*.log` |
| CLEAN (`npm test` de la raíz, 27 suites) | Todas ✔, 0 fallos (una ejecución de `activecredit` se cortó por `npx`; repetida, 10/10) | `clean-tests*.log` |
| E2E en Chrome real, build de producción de Online, pila local | **40/40** ✔ (SOC-07/04 de la pantalla al crédito; SOC-02 y SOC-03; SOC-05; SOC-09; SOC-08 con filtro de encabezado y móvil 390 px; SOC-06; SOC-01 con dos navegadores; conciliación final limpia; sin errores de JavaScript) | `e2e.log`, `e2e/*.png` |

Lo que cubren las pruebas nuevas, además de los casos felices: reintentos idempotentes (mismo id → misma respuesta), aprobaciones y rectificaciones simultáneas (una gana), condiciones inválidas, permisos por rol (Cobrador, Secretaria, Supervisora, SuperAdmin, Administrador no responsable), aislamiento entre empresas, fondos insuficientes sin escritura parcial, recaudo posterior sobre el calendario corregido, redondeo, historial y auditoría, conciliación del SuperAdmin sin fallos y conciliación independiente por SQL.

**HIST-001/002/003:** fallan **idénticos en `72b6e1b`**, antes de cualquier cambio de esta ronda (ejecutados en una copia limpia: `hist-at-72b6e1b.log`): el escenario histórico de la Demo intenta anular el 2026-10-06 una entrega cuyo efectivo ya se usó (`AX413`); HIST-002/003 dependen de HIST-001. Sin relación con R73 y sin defecto productivo demostrado; no se modificaron.

El E2E encontró un defecto real de esta ronda que se corrigió antes del cierre: el diálogo «Corregir venta» quedaba detrás del detalle de la venta.

## 5. Decisiones pendientes del propietario

1. **SOC-09 · reducir parcelas de una venta desembolsada.** Hoy se bloquea (`INSTALLMENTS_REDUCTION_BLOCKED`). Opciones: (a) estado de cuota «anulada» que el motor de recaudos y las vistas ignoren (migración y cambios en el motor de cobros); (b) mantenerlo bloqueado y corregir solo hacia más parcelas; (c) resolverlo con la futura anulación excepcional (fuera de alcance).
2. **SOC-09 · excepción de conciliación** (diseñada, no implementada): cuando quien pagó ya no custodia en la ruta (`CUSTODIAN_CHANGED`), la diferencia no cabe en el saldo (`INSUFFICIENT_FUNDS`) o el desembolso ya está en un cuadre (`DISBURSEMENT_SETTLED`). Propuesta: una «solicitud de rectificación» registrada sin efecto financiero, con la evidencia, que un rol a decidir (¿SuperAdmin? ¿doble aprobación?) resuelve contra una cuenta a decidir (bolsa del responsable actual, sobrante en control, reapertura del cuadre). Falta: quién aprueba, contra qué cuenta y si el trabajador debe confirmar.
3. **SOC-01 · capturas sin conexión de una sesión desplazada.** Hoy quedan pendientes en el dispositivo y solo se envían si la persona vuelve a iniciar sesión **en ese dispositivo** (lo que revoca el otro). Opciones: (a) dejarlo así; (b) al volver a iniciar sesión, retenerlas para revisión manual antes de enviarlas; (c) un inicio de sesión «solo para sincronizar» que no revoque el otro dispositivo.
4. **SOC-06 · proveedor de geocodificación** (claves, tarifas, condiciones de uso, privacidad): Nominatim público no admite uso intensivo ni autocompletado; alternativas: Nominatim/Photon propio, o comerciales (Google, Mapbox, LocationIQ, HERE). El contrato `geocoding.ts` ya define resultados con precisión, ambigüedad y confirmación manual.
5. **Venta real del incidente SOC-07:** si se corrige con SOC-09 (tras aplicar 0030 y publicar) o por otra vía.

## 6. Publicación (no realizada)

Orden obligatorio cuando el propietario lo autorice: aplicar 0030 y 0031 en el PostgreSQL gestionado → desplegar `adex-online-api` y `adex-owner-api` (manual) → comprobar `/healthz` (`credit-rectification-v1`, `movements-v1`, `single-session-v1`) → `push` a `main` (Vercel compila; la puerta exige las funciones). El commit `3c869b1` (SOC-07) y `f976e66` (SOC-02) no dependen de la API ni de migraciones y podrían publicarse antes, pero comparten rama con el resto: hacerlo exige una rama o un orden de `push` decidido por el propietario.

---

## 7. Continuación y cierre (2026-10-22): decisiones del propietario D73-01 a D73-06

El propietario resolvió las decisiones de §5. Esta sección **sustituye** a §5 y §6.

### 7.1 Decisiones aprobadas y su implementación

| Decisión | Regla | Implementación |
|---|---|---|
| **D73-01** Tasa libre | Sin «Tasa libre», el Cobrador origina con la tasa de su ruta; con «Tasa libre», elige 10 % o 20 %. Solo existen 10 % y 20 %. **Sustituye** «el Cobrador solo origina al 20 %». El autorizador conserva la facultad de modificar; el desembolso usa solo lo aprobado | Política pura `src/lib/interestRatePolicy.ts` (con la ruta). La API la aplica con la configuración **vigente** de la ruta y el guardián de PostgreSQL (0030) la vuelve a exigir. La tasa de una ruta solo puede ser 10 o 20 (alta y edición). Los formularios del Cobrador ofrecen la política de la ruta y se releen cuando cambia la configuración; antes de una solicitud en línea, el dispositivo relee la ruta del servidor. Sin conexión, el Cobrador sigue sin crear clientes, solicitudes ni ventas |
| **D73-02** Reducir parcelas | El Administrador puede aumentar o **reducir** parcelas en una rectificación válida | Las cuotas nunca se borran: las que quedan fuera del calendario pasan al estado nuevo `sustituida` (importe, pagado y saldo 0). El motor de recaudos (`credit_recompute`) las ignora y la API no las lista. El calendario anterior queda completo en el historial de la rectificación. Al volver a aumentar se reactivan las mismas filas (sin duplicados) |
| **D73-03** Excepciones | Siguen **bloqueadas** las correcciones sin saldo, con custodio cambiado, con desembolso en cuadre, en periodo cerrado o con cobros sin conexión pendientes | `GET /v1/credits/:id/rectification-check` explica el bloqueo antes de intentar, sin efectos. El diálogo muestra cada motivo en lenguaje claro y permite **registrar el caso** (`POST …/rectification-cases`, append-only, con la comprobación del servidor) **sin tocar el libro ni la venta** |
| **D73-04** Sesión única y Offline | Las capturas del dispositivo desplazado se conservan, no se envían con la sesión revocada y, tras volver a autenticarse, pasan por **revisión explícita** | Al detectar la sesión cerrada, la sincronización guarda cada operación pendiente en «Requiere revisión» con el motivo. Incluye las enviadas sin respuesta y las retenidas por dependencia. Nada se envía solo: «Reintentar» la envía con su **mismo id** y las validaciones vigentes. No hay sesión especial ni se borra nada |
| **D73-05** Búsqueda por dirección | Pospuesta (sin proveedor, claves ni costos) | Se publican las mejoras de SOC-06; el buscador permanece oculto |
| **D73-06** Venta real del incidente | Se corrige con SOC-09 desde la interfaz, solo si cumple los requisitos | **No se tocó.** Procedimiento en §7.6 |

### 7.2 Pruebas del cierre

Todas sobre PostgreSQL **local** (0001–0031) con datos **sintéticos**. Registros en `tmp/r73/` (no versionado).

| Conjunto | Resultado | Registro |
|---|---|---|
| SaaS completo (`npm test`) | Unidad **29/29** · PostgreSQL **473**: **469 ✔**, 3 ✖ (HIST-001/002/003, idénticos a la línea base `72b6e1b`), 1 omitida (staging real) | `close-saas-final.log` |
| Pruebas de R73 en PostgreSQL | **47/47**: `r73-credits` 21, `r73-movements` 6, `r73-sessions` 6, `r73-decisions` 14 (D73-01 ×8, D73-02 ×4, D73-03 ×2) | `close-r73-tests.log` |
| Unidad de R73 | 6/6 (cuerpo de aprobación ×3, retención Offline D73-04 ×3) | dentro de la suite de unidad |
| CLEAN (`npm test` de la raíz) | Todas las suites **sin fallos** (EXIT 0). `interestrate` se actualizó a la regla D73-01, que sustituye a la anterior | `close-clean-final.log` |
| E2E en Chrome real (build de producción, pila local) | **52/52**. Los 40 escenarios SOC anteriores más los D73: Cobrador en **móvil** con «Tasa libre» (10/20), configuración cambiada con la pantalla abierta, reducción 30 → 20 desde la pantalla, bloqueo explicado y caso registrado sin efecto financiero, **dos teléfonos del mismo Cobrador** (abono sin conexión retenido, no aplicado con la sesión revocada, revisado y aplicado una sola vez) | `e2e-close.log`, `e2e/*.png` |
| Reversión de 0030/0031 | **9/9** en local | `rollback-check.log` |

Las pruebas encontraron dos defectos de esta continuación, ya corregidos: los formularios no releían la ruta al cambiar su configuración, y las rutas locales antiguas de CLEAN sin tasa quedaban sin política.

Criterios de cierre del encargo (§10):

| # | Criterio | Estado |
|---|---|---|
| 1–5 | Tasa libre, aumentar y reducir parcelas, integridad de SOC-09, excepciones bloqueadas, Offline de sesiones desplazadas | **Cumplidos** (pruebas anteriores) |
| 6–7 | SOC-01 a SOC-09 mantienen sus pruebas; sin regresiones financieras nuevas | **Cumplidos** |
| 8–10 | Migraciones aplicadas, API con capacidades, Vercel sirviendo el código nuevo | **No cumplidos: bloqueados por la puerta de recuperación** (§7.4) |
| 11 | BlueLine y Owners protegidos | **Cumplido** (nada se tocó) |
| 12 | Registro Maestro actualizado | **Cumplido** |

### 7.3 Revisión final de migraciones (0030 y 0031)

| Aspecto | Resultado |
|---|---|
| Orden y dependencias | 0030 y 0031 van después de las 29 aplicadas y solo dependen de objetos de 0002–0029. Las aplicadas **no se modificaron** (su huella SHA-256 no cambia). 0030 se amplió en esta continuación porque **nunca se ha aplicado** en el gestionado |
| Efecto sobre datos existentes | Solo **añaden**: columnas nullable o con valor por defecto, tablas nuevas, funciones, políticas y restricciones que las filas existentes ya cumplen. No modifican ni borran filas (comprobado en local sobre el conjunto sintético: RB-04 y RB-05) |
| Funciones reemplazadas | `sale_requests_guard` (0018), `credit_recompute` (0013), `custody_cycle` y `route_period_figures` (0014), `ctx_session_valid` (0005) y la política de lectura de `capital_operations` (0023). Mientras no haya cuotas sustituidas ni ajustes, los resultados son idénticos |
| Bloqueos | Cada archivo corre en su propia transacción. `ALTER TABLE` toma bloqueos breves sobre `sale_requests`, `sales`, `installments`, `capital_operations` y `revoked_sessions`, sin reescribir las tablas. Conviene aplicarlas con poco tráfico |
| Permisos y RLS | Tablas nuevas con RLS forzado. `adex_api` solo lee rectificaciones, inserta casos y ejecuta las funciones; `adex_control` solo la envoltura de `claim_session` |
| Compatibilidad con la API | La API nueva tolera la ausencia de 0031 (`claim` sin efecto) y solo anuncia `credit-rectification-v1` y `single-session-v1` si su migración está aplicada. **No** debe desplegarse la API nueva sin 0030: el guardián anterior seguiría exigiendo el 20 % al Cobrador y las parcelas aprobadas fallarían |
| Sesiones existentes | Al aplicar 0031 ninguna sesión cae: la regla rige desde el primer inicio de sesión explícito de cada identidad |
| Recuperación ante fallo | Un error durante una migración revierte su transacción. Los scripts de reversión `saas/db/rollback/0030_…down.sql` y `0031_…down.sql` se verificaron en local (`tmp/r73/rollback-check.mjs`, **9/9**): esquema idéntico al de 0029, datos intactos y migraciones reaplicables. El de 0030 **se niega** a ejecutarse si ya hubo rectificaciones, casos o parcelas cambiadas; en ese caso se corrige hacia adelante. **Un script de reversión no es una copia de seguridad de datos** |

### 7.4 Puerta de recuperación previa a migraciones: **NO SUPERADA** (situación al cierre del 2026-10-23 por la mañana)

> **Actualización:** el propietario aprobó la alternativa 1. La copia lógica cifrada se hizo y se verificó con una restauración completa antes de migrar, así que la puerta quedó **superada**. Ver §8.1.

| Punto | Evidencia | Resultado |
|---|---|---|
| Proveedor y plan | Supabase, `sa-east-1`. Declaración del propietario en `saas/.env.staging`: **plan Free sin método de pago**. El arnés de staging lo documenta igual | Free |
| Respaldos existentes, último, frecuencia y retención | No hay token de la API de gestión: la variable existe vacía, porque el procedimiento pide revocarlo tras usarlo. No se pudo listar ninguna copia. La documentación oficial de Supabase solo describe copias diarias accesibles para Pro (7 días), Team (14) y Enterprise (30), y recomienda a los proyectos Free exportar sus datos con `supabase db dump` | **Desconocido / no verificable.** Según el proveedor, el plan Free no ofrece copias restaurables |
| PITR | Solo como complemento de pago en Pro, Team o Enterprise (requiere cómputo Small o mayor) | **No disponible** en Free |
| Restauración probada | Ninguna (R39 ya lo registraba) | **No** |
| Restauración aislada | No hay copia que restaurar. Duplicar datos reales fuera de la infraestructura requiere aprobación específica | No realizada |
| Punto de recuperación antes de migrar | No existe | **No** |

**Decisión aplicada:** el encargo dice que, si la protección es desconocida o no verificable, se **detiene la publicación que depende de 0030 y 0031**. No apliqué migraciones, no desplegué Render, no hice `push` y Vercel no recibió nada. Tampoco publiqué una parte suelta: la API nueva necesita 0030 y el frontend nuevo exige `credit-rectification-v1` en la puerta de Vercel.

**Alternativas para el propietario** (cualquiera desbloquea la puerta; no ejecuté ninguna):

1. **Copia lógica previa hecha por el propietario** (recomendada como mínimo): `pg_dump` de la base gestionada a un archivo cifrado en un equipo suyo, antes de migrar, y comprobar que el archivo se lee (`pg_restore --list`). Esto copia datos reales fuera del proveedor y **requiere su aprobación expresa**. Comandos en §7.5.
2. **Pasar el proyecto a Supabase Pro** (copias diarias accesibles durante 7 días; PITR opcional de pago). Es un costo y un cambio de plan: decisión del propietario. Tras el cambio, esperar a que exista la copia diaria y anotar su fecha antes de aplicar 0030 y 0031.
3. **Aceptar expresamente el riesgo** de migrar sin copia. Se apoyaría en que 0030 y 0031 solo añaden, corren en transacción y tienen la reversión probada en local. No lo recomiendo como única medida: no protege ante un error humano posterior ni ante una pérdida del proveedor.

### 7.5 Pasos para publicar cuando el propietario lo autorice (en este orden)

Todos se ejecutan en la terminal integrada de VS Code (PowerShell), desde `RutaCash\saas`. No ejecuté ninguno.

1. **Copia previa** (alternativa 1, si la aprueba). Requiere el cliente `pg_dump` 17 instalado. El comando toma el host y la contraseña de `saas\.env.staging` sin mostrarlos:
   ```powershell
   $e = @{}; Get-Content .env.staging | ? { $_ -match '^([A-Z0-9_]+)=(.+)$' } | % { $e[$matches[1]] = $matches[2] }
   $env:PGPASSWORD = $e['SUPABASE_DB_PASSWORD']
   $f = "$HOME\adex-antes-0030-$(Get-Date -Format yyyyMMdd-HHmm).dump"
   pg_dump -h $e['SUPABASE_POOLER_HOST'] -p 5432 -U "postgres.$($e['ADEX_STAGING_PROJECT_REF'])" -d postgres -Fc -f $f
   pg_restore --list $f | Select-Object -First 5
   Remove-Item Env:PGPASSWORD
   ```
   - Efecto: un archivo en su equipo con **todos** los datos, incluidos BlueLine y los Owners. Guárdelo cifrado y fuera del repositorio.
   - Comprobación: `pg_restore --list` muestra el índice sin errores.
2. **Migraciones:** `npm run staging:migrate` (sin `--seed`). Es el único modo que admite la base con usuarios reales (BlueLine y Owners); `staging:check` se detiene a propósito con usuarios reales.
   - Antes de escribir, el script comprueba la identidad del proyecto y la huella exacta de 0001–0029.
   - Efecto esperado: aplica **solo** `0030_credit_conditions_rectification.sql` y `0031_single_active_session.sql`, cada una en su transacción.
   - Comprobación: la salida lista esas dos como aplicadas y no muestra «BLOQUEADO».
   - Si algo falla a mitad, esa migración se revierte sola. Si hiciera falta deshacerlas después, están `saas/db/rollback/0031_…down.sql` y luego `0030_…down.sql`, ejecutadas como administrador en ese orden.
3. **Frontend en GitHub:** `git push origin main`, desde la raíz. Vercel intentará compilar y su puerta cancelará el build mientras la API no anuncie las funciones nuevas. Es lo esperado.
4. **Render (manual):** en el panel, *Manual Deploy → Deploy latest commit* de `adex-online-api` y de `adex-owner-api`.
5. **Verificación de la API:**
   - `https://adex-online-api.onrender.com/healthz` debe anunciar `credit-rectification-v1`, `movements-v1` y `single-session-v1`.
   - `https://adex-owner-api.onrender.com/healthz` sigue con `owner-v1, owner-clean-v1, owner-email-v1`.
6. **Vercel:** *Redeploy* del último commit.
   - Comprobación: el bundle de `https://adex-online.vercel.app/` contiene un `VITE_VERCEL_GIT_COMMIT_SHA` igual al HEAD publicado.
7. **Comprobaciones seguras** (solo lectura): iniciar sesión con las cuentas Owner y de BlueLine y ver Consultas y el mapa. No crear clientes, ventas, pagos ni gastos en BlueLine.

### 7.6 Venta real del incidente SOC-07 (D73-06): procedimiento para el Administrador

Solo **después** de publicar. En Ventas Activas, abrir la venta y pulsar «Corregir venta»:

1. Confirmar que cliente, fecha de desembolso, importe y condiciones mostradas corresponden a la venta del incidente.
2. Al abrirse el diálogo, el servidor comprueba que la venta no tenga cobros, que el desembolso esté fuera de cuadres y de periodos cerrados, y que el trabajador siga siendo custodio de la ruta (o que la bolsa sea la propia). Si algo falla, lo explica y **no deja corregir**; en ese caso se puede registrar el caso.
3. Cambiar la tasa a 10 % (y las parcelas, si corresponde). Revisar el resumen (total y valor de parcela) antes de guardar.
4. Escribir el motivo (p. ej. «el Secretario aprobó al 10 % y el sistema desembolsó al 20 %») y la evidencia (aprobación del Secretario o confirmación con el cliente).
5. Confirmar con el Cobrador que no tiene cobros de esa venta guardados sin conexión. Si los tiene, marcarlo: la corrección queda bloqueada y el caso se puede registrar.
6. Pulsar «Registrar corrección». El desembolso original y su fecha se conservan, las parcelas pasan a las del 10 % y el historial guarda el antes y el después.

Si la venta ya tiene cobros, esta función no permite corregirla (D73-03): registrar el caso.

### 7.7 Estado

| | |
|---|---|
| Código | Completo y probado en local (commits sobre `72b6e1b`, ver el Registro Maestro) |
| Migraciones | 0030 y 0031 **creadas, NO aplicadas** |
| Render / Vercel | **Sin cambios** (nada desplegado) |
| BlueLine y Owners | Ninguna operación ni lectura de sus datos. Solo se leyó la configuración local, sin mostrar secretos |
| SOC-10 | **No tocada** |
| Declaración | **CERRADA EN LOCAL / PENDIENTE DE PUBLICACIÓN.** Bloqueada por la puerta de recuperación (§7.4) hasta que el propietario elija una alternativa |

Esta tabla describe el estado del cierre en local. El estado vigente está en §8.6.

## 8. Publicación (2026-10-23)

Encargo: «R73: desbloquear publicación para pruebas operativas». La copia previa se autorizó como **copia**. No incluye modificar, eliminar ni recrear registros, ni transferir la base a terceros.

### 8.1 Copia de seguridad previa (puerta de recuperación superada)

| Punto | Resultado |
|---|---|
| Método | Volcado lógico `pg_dump` 17 (formato personalizado) de los esquemas `adex`, `adex_control`, `adex_demo`, `adex_meta`, `auth` y `public`. Es solo lectura sobre la base gestionada |
| Protección | Cifrado AES-256-GCM. La clave está protegida con DPAPI del usuario de Windows del propietario y solo puede descifrarse con ese usuario en ese equipo. Se guardó **fuera del repositorio**, en una carpeta con acceso restringido a ese usuario. El volcado en claro solo existió durante la verificación y se borró |
| Tamaño | ~1,07 MB, 79 tablas con datos |
| Verificación | (1) Se descifró y se comparó la huella SHA-256 con la del volcado original. (2) Se restauró completo en un PostgreSQL **local** aislado: **79 tablas y 2017 filas idénticas** a la fuente, tabla por tabla, migraciones hasta 0029. Único aviso: «schema public already exists», que es benigno |
| No incluido | La configuración que gestiona Supabase: ajustes de Auth, claves JWT, SMTP, contraseñas de roles y parámetros del proyecto. Storage y Vault estaban vacíos |
| Exposición | Ninguna. No se subió a servicios externos, logs, capturas ni carpetas compartidas. La ruta y los scripts no se versionan |

### 8.2 Migraciones

`npm run staging:migrate`, ejecutado por el propietario el **2026-10-23 hacia las 12:18 UTC**. Aplicó solo `0030_credit_conditions_rectification.sql` y `0031_single_active_session.sql` y omitió las 29 anteriores. Comprobación de solo lectura posterior: 31 migraciones registradas con las 31 huellas correctas.

### 8.3 Despliegue

| Paso | Resultado |
|---|---|
| `git push origin main` (propietario) | `72b6e1b..2fa7152`. Vercel canceló el build con la puerta («Ignored Build Step»), como se esperaba |
| `adex-online-api` (Render, manual) | Live. `/healthz`: `ok` con las 11 funciones anteriores más **`credit-rectification-v1`, `movements-v1` y `single-session-v1`** |
| `adex-owner-api` (Render, manual) | **Primer intento fallido** (12:27 UTC): `password authentication failed for user "adex_control"`. La versión anterior siguió activa. La URL de Render es correcta: el propietario la comparó con la vigente, y el mismo código arrancó en local contra la base real con esa credencial (12:31 y 12:41 UTC). Causa probable, no demostrada: `staging:migrate` vuelve a aplicar la contraseña de los roles, aunque sea la misma, y el pooler tarda unos minutos en reconocer el nuevo verificador. **Segundo intento: Live** en `2fa7152`. `/healthz`: `owner-v1, owner-clean-v1, owner-email-v1` (R73 no añade funciones al Owner) |
| `adex-online` (Vercel, *Redeploy* de `2fa7152`) | Ready. Sirve **`index-DyK4-kHp.js`**, con `VITE_VERCEL_GIT_COMMIT_SHA` = `2fa7152ad0e2…`. Contiene la rectificación con comprobación previa, la retención Offline `SESSION_ENDED` y la tabla de movimientos. `sw.js` 200 |

En el Owner, R73 solo cambia el inicio de sesión: deja vigente una sola sesión (SOC-01, aplicada también a los Owners).

### 8.4 Comprobaciones posteriores (sin escribir nada)

| Comprobación | Resultado |
|---|---|
| Endpoints nuevos sin sesión: `/v1/movements`, `/v1/sales/:id/rectification-check`, `/v1/rectification-cases`, `POST /v1/session/claim`, `POST /control/v1/session/start` | **401** en todos (protegidos) |
| Web `https://adex-online.vercel.app/` | 200 |
| Privilegios de `adex_control` | Sin USAGE sobre `adex`; ejecuta `claim_session` y `change_superadmin_email` |
| Integridad (consulta de solo lectura, 12:52 UTC), idéntica a la previa a la migración | 1 empresa · 36 ventas · 640 parcelas (0 sustituidas) · 48 pagos · 37 solicitudes · 92 operaciones de capital (suma de asientos = 0) · 0 rectificaciones · 0 casos · 2 Owners · 9 usuarios de Auth |

**BlueLine y Owners: intactos.** No se hizo ninguna operación sobre ellos. SOC-10 no se tocó. La búsqueda por dirección sigue pendiente (D73-05) y las correcciones excepcionales siguen bloqueadas (D73-03).

### 8.5 Recuperación si algo sale mal

- **Ante un fallo del código:** es preferible corregir hacia adelante. Volver a desplegar el commit anterior (`72b6e1b`) en Render y Vercel es posible, pero **no se probó** que la API anterior funcione sobre 0030/0031. Por ejemplo, el guardián de 0030 ya exige al Cobrador la tasa de su ruta.
- **Para deshacer las migraciones:** `saas/db/rollback/0031_…down.sql` y luego `0030_…down.sql`. El de 0030 se niega a ejecutarse si ya hay rectificaciones o casos.
- **Ante una pérdida de datos:** restaurar la copia de §8.1. Solo puede hacerlo el propietario, en su equipo.

### 8.6 Estado

**R73 PUBLICADA Y DISPONIBLE PARA EVALUACIÓN OPERATIVA.** Se cumplen los criterios 8–10 de §7.2: migraciones aplicadas, API con las funciones nuevas y Vercel sirviendo el código nuevo.

## 9. Guía de evaluación para el propietario y el socio

Regla: **en BlueLine no se crean operaciones financieras de prueba.** Todo lo de la tabla A se puede revisar en BlueLine sin modificar datos. Lo de la tabla B exige crear o mover dinero, así que se prueba en una empresa de pruebas aparte (§9.3). La única excepción es la corrección de la venta real del incidente (D73-06), porque es una corrección real y no una prueba.

Antes de empezar, cerrar y volver a abrir la aplicación (o recargar con Ctrl+F5) para cargar la versión nueva.

### 9.1 A · Se observa sin modificar datos (sirve en BlueLine)

| Pedido | Dónde | Qué debe verse |
|---|---|---|
| SOC-08 Consultas | Consultas → tabla de movimientos | Una tabla con filtros en el encabezado de cada columna (fecha, tipo, ruta, persona, importe…). Sin filas duplicadas. Filtrar no cambia datos |
| SOC-03 20 parcelas | Abrir el formulario de nueva venta o solicitud **sin guardar** | El campo de parcelas aparece con 20 y se puede cambiar |
| SOC-05 Negocio | Abrir el formulario de nuevo cliente **sin guardar** | «Negocio» es obligatorio: al intentar continuar sin él, lo pide |
| D73-01 Tasa por ruta | Formulario del Cobrador **sin guardar** | Si la ruta no tiene «Tasa libre», solo aparece la tasa de la ruta. Si la tiene, aparecen 10 % y 20 %. La ruta actual de BlueLine tiene 20 % y «Tasa libre» activa |
| SOC-09 Comprobación previa | Ventas activas → abrir una venta → «Corregir venta». **Cerrar el diálogo sin registrar** | El servidor revisa si la venta se puede corregir. Si no se puede (cobros, cuadre, periodo cerrado…), lo explica en lenguaje claro. Abrir el diálogo no cambia nada |
| SOC-06 Mapa | Administrador → Mapa | Clientes con ubicación de referencia. Mirar el mapa no modifica nada |
| SOC-01 Sesión única | Entrar con la **misma cuenta** en dos navegadores o equipos | Al entrar en el segundo, el primero pide iniciar sesión de nuevo. No es una operación financiera. **Usar una cuenta sin trabajo pendiente sin conexión** (Administrador, Secretario u Owner), no el teléfono de un Cobrador con abonos por sincronizar |

### 9.2 B · Necesita operaciones (solo en una empresa de pruebas)

| Pedido | Qué hay que hacer para verlo |
|---|---|
| SOC-07 Tasa autorizada = tasa desembolsada | Crear una solicitud, autorizarla al 10 % y desembolsar. La venta debe quedar al 10 % |
| SOC-04 Parcelas al autorizar | Autorizar cambiando el número de parcelas. La venta debe salir con ese número |
| SOC-02 Venta directa del Administrador | Vender desde la bolsa del Administrador. Debe descontar de su bolsa, sin pedir caja de ruta |
| SOC-09 / D73-02 Rectificar | Corregir una venta recién desembolsada y sin cobros: subir o bajar la tasa, aumentar o reducir parcelas. Las parcelas sobrantes quedan «sustituidas», no borradas, y el historial muestra el antes y el después |
| D73-03 Caso bloqueado | Intentar corregir una venta con un cobro. Debe bloquearse y permitir registrar el caso sin mover dinero |
| D73-04 Offline y sesión desplazada | Teléfono A sin conexión registra un abono. El mismo Cobrador entra en el teléfono B. Al volver la conexión, A no envía nada, pide entrar de nuevo y muestra el abono **para revisión**. Solo se aplica tras confirmarlo, y una sola vez |
| SOC-06 Ubicación de referencia | Guardar o confirmar la ubicación de un cliente. Modifica la ficha del cliente: hacerlo en BlueLine solo con datos reales |

### 9.3 Empresa de pruebas (propuesta, requiere autorización)

Para la tabla B, propongo una empresa **sintética y aislada**, por ejemplo «ADEX Pruebas R73», creada desde el panel Owner:
- con 1 oficina, 1 ruta y cuentas ficticias de Administrador, Secretario y Cobrador;
- con capital ficticio, y sin clientes ni personas reales.

**Ventaja:** queda separada de BlueLine por empresa. Cada consulta está limitada a su empresa, igual que entre clientes del SaaS.

**Limitación:** vive en la misma base que BlueLine. No contamina los datos de BlueLine, pero sí deja registros de prueba en la base.

Al terminar, la empresa se suspende. No se borra, porque el modelo no permite borrar movimientos. **No se ha creado: requiere autorización expresa del propietario.**

### 9.4 Venta real del incidente SOC-07

La corrige el Administrador desde la interfaz, siguiendo §7.6. Si el diálogo la bloquea, se registra el caso. No la corrige el equipo técnico.
