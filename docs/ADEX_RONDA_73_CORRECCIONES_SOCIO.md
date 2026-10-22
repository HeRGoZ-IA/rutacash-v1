# ADEX — Ronda 73: correcciones operativas del socio, integridad financiera y mejoras funcionales

| | |
|---|---|
| Fecha | 2026-10-22 |
| Base | `main` @ `72b6e1b` (= `origin/main` al empezar) |
| Alcance | SOC-01 a SOC-09. **SOC-10 excluida y no tocada** (CPF/RG) |
| Entorno de trabajo | Solo PostgreSQL **local** y aislado, empresas y personas **sintéticas**. Ninguna operación sobre ADEX-Staging, BlueLine ni las cuentas Owner |
| Estado de publicación | **Nada publicado.** Commits locales sin `push`; migraciones 0030 y 0031 **creadas, no aplicadas** en el PostgreSQL gestionado |

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
