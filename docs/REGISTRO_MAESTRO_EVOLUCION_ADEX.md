# ADEX Soluciones — Registro maestro de evolución

| | |
|---|---|
| Creado | 2026-10-22 · Ronda 70 (solo documental) · base `main` @ `b44379b` |
| Cubre | 2026-06-18 (`4b1c3c9`, primer commit) → 2026-10-22 (`b44379b`, cierre de la Ronda 67) |
| Actualizado | 2026-10-23 · Ronda 73 **publicada** (0030/0031 en staging, API y web en `2fa7152`; ver §B.2, §C, §D) · Ronda 74 (intervención integral) **en local, sin publicar** (0032; ver §B.2, §C, §E, §G) |
| Carácter | **Índice** de la historia del producto. No sustituye a los documentos de cada ronda ni al historial de Git: los enlaza |
| Fuentes | `git log` de `main` · `saas/db/migrations/` · documentos de `docs/` · consulta HTTPS de solo lectura a los servicios publicados (2026-10-22) |

## Cómo leer este registro

Cada hecho lleva uno de estos estados. Ninguno implica a otro.

| Estado | Significado |
|---|---|
| **IMPLEMENTADO** | Existe el commit en `main` |
| **PROBADO** | Hay resultados de prueba registrados en un documento de la ronda |
| **PUBLICADO** | Un documento (o la consulta de esta ronda) registra que el servicio publicado lo sirve |
| **APLICADA (staging)** | Un documento registra la migración aplicada en ADEX-Staging |
| **NO VERIFICADO** | Pudo ocurrir, pero no hay evidencia escrita en el repositorio |
| **DESCONOCIDO** | No hay forma de saberlo con las fuentes disponibles |

Reglas: un commit no es un despliegue; un archivo de migración no es una migración aplicada; una decisión solo es **APROBADA** si un documento lo dice. Las memorias de conversación **no** son fuente de este registro.

---

## A. Identificación del proyecto

| Elemento | Valor | Fuente |
|---|---|---|
| Nombre | **ADEX Soluciones** (antes RutaCash; marca migrada en `388aa4a`, 2026-10-01) | Git |
| Propósito | Plataforma SaaS para empresas de préstamo y cobro diario por rutas: que cada empresa sepa cuánto dinero tiene, dónde está y quién responde de él | [Visión §1](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md) |
| Visión | SaaS comercial multiempresa, escalable e internacional, sobre infraestructura compartida — **APROBADO** (2026-10-14) | [Visión §2](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md) |
| Mercados | Brasil y Colombia — **APROBADO**. Resto de Sudamérica — objetivo estratégico sin fechas | [Visión §3](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md) |
| Repositorio | `HeRGoZ-IA/rutacash-v1`, rama `main` | Git |
| Aplicación | https://adex-online.vercel.app (empresas) · `/owner` (plataforma Owner) | Consulta 2026-10-22 |
| API de empresa | `adex-online-api` (Render, despliegue **manual**) | [Render](./ADEX_ONLINE_RENDER.md), R40 |
| API Owner | `adex-owner-api` (Render, servicio aparte, despliegue manual) | [R40 §9](./ADEX_RONDA_40_OWNER_ONLINE.md) |
| Base de datos | Supabase PostgreSQL, proyecto **ADEX-Staging** (`sa-east-1`), con RLS por empresa | [Fase 2](./SAAS_FASE_2_RESULTADOS.md), [R39](./ADEX_RONDA_39_VALIDACION_FINANCIERA_Y_PILOTO.md) |

**Arquitectura vigente (resumen).** Interfaz: el frontend original de CLEAN (`src/`) compilado por `online/` con un puente de datos hacia la API (sin Dexie). Servidor: `saas/` (Node + TypeScript), comandos financieros transaccionales sobre PostgreSQL, RLS como segunda barrera (DS-15), plano Owner separado (DS-17). Modelo de capital: Empresa → bolsa del Administrador → custodia del trabajador por ruta, **sin caja de ruta**. Vercel construye `adex-online` en cada push a `main` solo si la puerta [`deploy-gate.mjs`](../online/scripts/deploy-gate.mjs) ve en `/healthz` las funciones exigidas; Render **no** despliega solo.

**Aplicaciones retiradas.** CLEAN local (`rutacash-clean.vercel.app`) retirada en R59 (404 confirmado el 2026-10-22). DEMO local (`rutacash-demo.vercel.app`) eliminada en R53. Su código sigue en Git porque Online lo compila.

---

## B. Línea de tiempo de evolución

Las rondas sin documento propio se indican con «—» en la referencia. La correspondencia commit↔ronda solo se anota cuando el mensaje del commit o un documento la declaran.

### B.1 Etapa CLEAN (aplicación local, Dexie en el navegador)

| Fecha | Hito | Commits | Migr. | Implem. | Publicación | Referencia |
|---|---|---|---|---|---|---|
| 2026-06-18 | RutaCash V1 (versiones demo y limpia) + fallback SPA en Vercel | `4b1c3c9`, `54c1869` | — | Sí | NO VERIFICADO | — |
| 2026-06-24 → 07-05 | Versión limpia para pruebas del socio | `28d1bbf`, `c4c1e94`, `c179247` | — | Sí | NO VERIFICADO | — |
| 2026-07-24 → 07-27 | Modelo centralizado de roles y permisos; integridad de rutas y cobradores | `2547bdb` … `47892d4` | — | Sí | NO VERIFICADO | [Roles](./IMPLEMENTACION_ROLES_PERMISOS.md), [Cierre brechas](./CIERRE_BRECHAS_ROLES_PERMISOS.md) |
| 2026-08-19 → 09-02 | Flujo de pagos endurecido; arranque desde cero (zero-state) | `f1f05c6` … `47ddd52` | — | Sí | NO VERIFICADO | [Bootstrap](./BOOTSTRAP_RUTACASH_DESDE_CERO.md) |
| 2026-09-10 | Revisión del socio RQ01–RQ05 | `8096d22` | — | Sí | NO VERIFICADO | [RQ01–05](./REVISION_SOCIO_RQ01_RQ05.md) |
| 2026-09-15 → 09-16 | Oficinas; cierre de periodo persistente | `e12769a` … `ec77e98` | — | Sí | NO VERIFICADO | [Oficinas](./IMPLEMENTACION_OFICINAS_2026-09.md) |
| 2026-09-18 | Separación Owner / empresa | `fcbcfa8` … `77a6b43` | — | Sí | NO VERIFICADO | [Arquitectura Owner](./ARQUITECTURA_OWNER_SUPERADMIN_2026-09.md) |
| 2026-09-22 → 09-29 | Responsabilidad de efectivo del Supervisor; cuadre del trabajador; Base y custodia | `1761dc5` … `3746ed3` | — | Sí | NO VERIFICADO | [Supervisor](./IMPLEMENTACION_SUPERVISOR_RESPONSABILIDAD_EFECTIVO_2026-09.md), [Cuadre](./IMPLEMENTACION_CUADRE_TRABAJADOR_2026-09.md) |
| 2026-10-01 | Marca ADEX Soluciones | `388aa4a`, `7363409`, `62b67b4` | — | Sí | NO VERIFICADO | — |
| 2026-10-02 → 10-03 | 9 ajustes del socio (reversiones auditables, tasa 20 %, Base única…) | `c8bd1e1` … `e7708c2` | — | Sí | NO VERIFICADO | [Ajustes socio](./AJUSTES_PRUEBAS_SOCIO_2026-10-02.md) |
| 2026-10-07 | Capital de ruta por Administrador responsable (Dexie v16) | `086e2d4` | — | Sí | NO VERIFICADO | [Capital por Admin](./CAPITAL_POR_ADMINISTRADOR_2026-10.md) |
| 2026-10-08 → 10-12 | Gastos del cobrador sin tope de efectivo; Caja principal; operaciones guiadas; guardas de desembolso (D24–D30, D7) | `73209ce` … `520a331` | — | Sí | NO VERIFICADO | [Incidente gastos](./INCIDENTE_GASTOS_COBRADOR_2026-10-08.md), [Invariantes](./INVARIANTES_FINANCIERAS_2026-10.md) |
| 2026-10-13 | CLEAN publicada sirve `index-b05G8Ybt.js` (`verify:deploy` 81/81) | — | — | — | **PUBLICADO** (constancia en Fase 0A) | [Fase 0A](./SAAS_FASE_0A_RESULTADOS.md) |
| 2026-10-15 | Capital centralizado C1+C2 en CLEAN (inactivo por defecto) | `354a3ce`, `1ebab80` | — | Sí | CLEAN sirve `index-C1zR2rb4.js` (constancia en ADEX Online v1) | [C1](./CAPITAL_CENTRALIZADO_C1_2026-10.md) |

### B.2 Etapa SaaS (servidor central)

| Fecha | Ronda / fase | Funcionalidad | Commits | Migr. | Implem. | Publicación | Referencia |
|---|---|---|---|---|---|---|---|
| 2026-10-12 | 6D | Arquitectura SaaS documentada | `315099c` | — | Doc. | — | [Arquitectura](./ARQUITECTURA_SAAS_PROPUESTA_2026-10.md), [Plan](./PLAN_MIGRACION_SAAS_2026-10.md) |
| 2026-10-13/14 | Fase 0A / 0A.1 | POC (PostgreSQL embebido) y Supabase gestionado | `78a6401`, `8aaf65f`, `f4357ba` | — | Experimental | No aplica | [0A](./SAAS_FASE_0A_RESULTADOS.md), [0A.1](./SAAS_FASE_0A1_RESULTADOS.md) |
| 2026-10-14 | Visión | Documento rector; DS-01/05/15 aprobadas | `3ce1df6` | — | Doc. | — | [Visión](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md) |
| 2026-10-14 | Fases 0–1 | Esquema multiempresa, identidad y membresías | `c007cc3`, `a2ab180`, `fbfbb6d`, `f17d53d` | 0001–0006 | Sí | Staging (sin servicio publicado) | [Fases 0–1](./SAAS_FASES_0_1_RESULTADOS.md) |
| 2026-10-14 | Fase 2 | Estructura y catálogo (DS-10, DS-11) | `de726ff`, `863d7c1` | 0007–0008 | Sí | Staging | [Fase 2](./SAAS_FASE_2_RESULTADOS.md) |
| 2026-10-16 | Fase 3 | Capital centralizado y custodia | `e582299` | 0009 | Sí | Staging | [Fase 3](./SAAS_FASE_3_RESULTADOS.md) |
| 2026-10-16 | Fase 4 | Solicitudes, autorización y desembolso (solo en línea) | `a64406e` | 0010 | Sí | Staging | [Fase 4](./SAAS_FASE_4_RESULTADOS.md) |
| 2026-10-16 | Online v1 | Web privada + API + Empresa Demo; preparación Render | `7f26944`, `cc22ba0` | 0011–0012 | Sí | «Nada publicado» al cerrar | [Online v1](./ADEX_ONLINE_V1_RESULTADOS.md), [Render](./ADEX_ONLINE_RENDER.md) |
| 2026-10-17 | Fase 5 | Recaudos y gastos | `09f177d`, `186f90d` | 0013 | Sí | Vercel `adex-online` en `186f90d` (constancia en Fase 6) | [Fase 5](./SAAS_FASE_5_RESULTADOS.md) |
| 2026-10-17 | Fase 6 | Cuadres y cierres; puerta de despliegue por `/healthz` | `03de95a`, `8ffecff` | 0014 | Sí | 0014 aplicada 2026-10-18; publicación del frontend NO VERIFICADA en el doc | [Fase 6](./SAAS_FASE_6_RESULTADOS.md) |
| 2026-10-18 | R17 | Pantallas de administración de la empresa | `654f35d` | — | Sí | Indirecta: R20 valida contra la web publicada | [Administración](./ADEX_ONLINE_ADMINISTRACION_RESULTADOS.md) |
| 2026-10-18 | R20 | Panel Owner (servicio aparte) y Demo única | `095ab5b` | — | Sí | Demo en staging; Owner **no** publicado en R20 | [R20](./ADEX_RONDA_20_OWNER_Y_DEMO.md) |
| 2026-10-18/19 | R24–R26 | Online compila las pantallas originales de CLEAN | `3c7f9fe`, `09b8a15`, `091aa0f` … `b46188c` | 0015–0019 | Sí | Pendiente de Render al cerrar R26 | [R24](./ADEX_RONDA_24_CLEAN_EN_ONLINE.md), [R25](./ADEX_RONDA_25_CAPITAL_EN_ONLINE.md), [R26](./ADEX_RONDA_26_ONLINE_INTEGRAL.md) |
| 2026-10-19 | R29 | Corrección de tipos para el build de Vercel | `ae78c2a` | — | Sí | NO VERIFICADO en docs (sin documento de ronda) | — |
| 2026-10-19 | R33 | Rendimiento: RLS una vez por consulta; marcador de cambios | `a35eb56`, `0fcf580`, `1018391` | 0020 | Sí | Indirecta: R39 ve `changes-v1` publicado | — |
| 2026-10-19 | R39 | Validación financiera multiusuario; piloto **no** listo | `23abb2e` | — | Doc. | API y web publicadas validadas | [R39](./ADEX_RONDA_39_VALIDACION_FINANCIERA_Y_PILOTO.md) |
| 2026-10-19/20 | R40 | Plataforma Owner original en Online; primer acceso | `4875ef3`, `faf741e`, `b6b09d3`, `11c26b7`, `9bcca96` | 0021 | Sí | **PUBLICADO** 2026-10-20, E2E 32/32 | [R40](./ADEX_RONDA_40_OWNER_ONLINE.md) |
| 2026-10-20 | R48 / 48.1 | Confirmaciones, ubicación del cobro, filtros; un id por abono | `5feaca7` … `58bf42c`, `9a2fc6a` | 0022 | Sí | Indirecta: R53 «R48–R50 publicadas» | [R48](./ADEX_RONDA_48_OPTIMIZACION_UX.md) |
| 2026-10-20 | R49 / R50 | Accesibilidad; Owner responsive, menú agrupado, carga por rol | `f3b3b9f`, `46358be` | — | Sí | Indirecta (ídem) | — |
| 2026-10-20 | R53 | Retirada de Socio; traspasos entre Administradores; Demo Online retirada | `f3c1fc2`, `0a8d106`, `07ceffe`, `a85e84e` | 0023 | Sí | Indirecta: R59 parte de «R55 publicada» | [R53](./ADEX_RONDA_53_TRANSFERENCIAS_SIN_SOCIO.md) |
| 2026-10-20 | R54 / R55 | Owner cambia el correo de un SuperAdmin | `80d2db6`, `896d806` | 0024 | Sí | Indirecta (R59) + `owner-email-v1` visible el 2026-10-22 | — |
| 2026-10-21 | R59 | DINERO: entregas voluntarias, solicitudes de capital, notificaciones; retirada de CLEAN | `de8203c` … `05d82ca` | 0025 | Sí | **PUBLICADO** 2026-10-21 | [R59](./ADEX_RONDA_59_DINERO.md) |
| 2026-10-21 | R62 | Cobrador sin conexión (abonos, visitas, gastos) | `42ede4d`, `6a4e4d6`, `147a8e4` | 0026 | Sí | **PUBLICADO** 2026-10-21 | [R62](./ADEX_RONDA_62_OFFLINE_COBRADOR.md) |
| 2026-10-21 | R65 / 65-C1 | Desembolsos aprobados sin conexión; clientes y ventas offline retirados | `24ef149`, `448b28c`, `e71d5d0`, `dcb0575` | 0027 | Sí | **PUBLICADO** 2026-10-21 | [R65](./ADEX_RONDA_65_OFFLINE_DESEMBOLSOS.md) |
| 2026-10-21/22 | R67 | SuperAdmin con cartera de solo lectura; mapa de rutas del Administrador | `9902795`, `b310279`, `2b3ef13`, `54944b8`, `b44379b` | 0028–0029 | Sí | **PUBLICADO** 2026-10-22 | [R67](./ADEX_RONDA_67_SUPERADMIN_Y_MAPA.md) |
| 2026-10-22 | R70 | Este registro (solo documentación) | ver §I | — | Doc. | — | este archivo |
| 2026-10-22 | R71 | Auditoría de organización de archivos y plan por bloques (diagnóstico) | `6686c14` | — | Doc. | — | [Auditoría](./AUDITORIA_ORGANIZACION_PROYECTO_ADEX.md) |
| 2026-10-22 | R72 | Bloques 1–3 de R71: limpieza local de regenerables (25 clústeres PostgreSQL de prueba, copias de compilaciones, `node_modules` del experimento; 5 675 → 767 MB, sin commit por ser archivos ignorados); 13 documentos antiguos a [`historico/clean-2026/`](./historico/clean-2026/); `README.md` de raíz; `.gitignore` con `.env*`, certificados, claves, `*.zip`, `.impeccable/`. Sin cambios funcionales; evidencias de `tmp/` conservadas (bloques 0 y 4 no autorizados) | commit que añade esta fila (`git log -1 -- docs/historico`) | — | Doc. / config. | Sin despliegue manual | [Auditoría §11](./AUDITORIA_ORGANIZACION_PROYECTO_ADEX.md) |

| 2026-10-23 | R73 (cierre) | Decisiones D73-01…D73-06: tasa por ruta con «Tasa libre», reducción de parcelas (cuotas `sustituida`), excepciones bloqueadas con comprobación previa y casos registrables, retención Offline de sesiones desplazadas, reversiones de 0030/0031 probadas. Copia lógica cifrada verificada por restauración antes de migrar | `72b6e1b..2fa7152` | 0030 ampliada, 0031 (aplicadas 2026-10-23) | Sí | **PUBLICADO** 2026-10-23 (API Render + web `index-DyK4-kHp.js`) | [R73 §7](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md) |
| 2026-10-23 | R74 | Intervención integral post-R73: **A** rectificación de ventas con pagos (anulados o vigentes; reclasificación capital/interés sin efectivo; reaplicación de pagos anulados), **B** Consultas v2, **C** nombres sin mayúsculas (solo vista), E1 SuperAdmin sin operaciones de ruta, huecos de roles; diseño de Base por Ruta (D/F/G) con decisiones pendientes | `07c624a`, `e3522eb`, `9d84c1e` + commit documental | 0032, 0033 | Sí (local) | **NO publicado** | [R74](./ADEX_RONDA_74_INTERVENCION_INTEGRAL.md) |
| 2026-10-22 | R73 | Correcciones del socio SOC-01…SOC-09 (SOC-10 excluida): tasa autorizada en el puente (SOC-07), parcelas en la autorización (SOC-04), rectificación de ventas desembolsadas (SOC-09), venta directa con la bolsa (SOC-02), 20 parcelas propuestas (SOC-03), negocio obligatorio (SOC-05), Consultas en tabla (SOC-08), sesión única (SOC-01), ubicaciones confirmables (SOC-06) | `3c869b1` … `2fa7152` | 0030, 0031 | Sí | Publicado con el cierre (fila anterior) | [R73](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md) |

**Hitos registrados:** 14 de la etapa CLEAN y 29 de la etapa SaaS (43 en total).

---

## C. Registro de migraciones (`saas/db/migrations/`)

Las 31 migraciones existen en `main` @ `2fa7152`. La columna «Staging» indica la **primera evidencia escrita** de aplicación en ADEX-Staging; no hay otro entorno de base de datos documentado. La huella aplicada se guarda en `adex_meta.schema_migrations` (SHA-256 por archivo). Reversiones disponibles en `saas/db/rollback/`: 0020, 0021, 0022 y 0029.

| # | Archivo | Propósito | Cambios relevantes | Commit | Staging (evidencia) |
|---|---|---|---|---|---|
| 0001 | `core_tenancy` | Núcleo multiempresa | Empresas, identidades, membresías (DS-05), oficinas, rutas; dinero en unidades menores | `c007cc3` | Aplicada (Fases 0–1) |
| 0002 | `operational_model` | Modelo operativo y financiero de Dexie v16 | Aislamiento por FK compuestas; inmutabilidad financiera (D7, D28) | `c007cc3` | Aplicada (Fases 0–1) |
| 0003 | `rls_and_privileges` | RLS y privilegios mínimos | Contexto `identity/membership/company` por transacción (DS-15) | `c007cc3` | Aplicada (Fases 0–1) |
| 0004 | `control_plane_model` | Plano de control Owner (modelo) | Esquema propio; nunca datos operativos de la empresa | `c007cc3` | Aplicada (Fases 0–1) |
| 0005 | `identity_sessions_revocation` | Sesiones revocables y membresías | `revoked_sessions`, corte por identidad, bloqueo REVOKE-004 | `a2ab180` | Aplicada (Fases 0–1) |
| 0006 | `control_plane_access` | Acceso del plano Owner | Rol `adex_control` sin privilegios sobre `adex` (DS-17) | `a2ab180` | Aplicada (Fases 0–1) |
| 0007 | `structure_catalog` | Estructura y catálogo | DS-10 (documento único), DS-11 (sin borrado con historia), responsable de capital diferido | `de726ff` | Aplicada (Fase 2) |
| 0008 | `structure_helpers_context` | Funciones de 0007 atadas al contexto | Defensa en profundidad para `adex_api` | `de726ff` | Aplicada (Fase 2) |
| 0009 | `capital_custody` | Capital centralizado y custodia | Cuentas, operaciones y patas inmutables; sin caja de ruta; Σ saldos = 0 | `e582299` | Aplicada (Fase 3) |
| 0010 | `credits_disbursements` | Solicitudes, autorización, desembolso | Solo en línea; 20 % Cobrador / 10 % autorizador; nadie resuelve lo propio | `a64406e` | Aplicada (Fase 4) |
| 0011 | `demo_company_admin` | Ciclo de vida de la Empresa Demo | Esquema y rol `adex_demo` separados | `7f26944` | Aplicada (Online v1) |
| 0012 | `request_context_roundtrip` | Contexto de la petición en un viaje | Misma secuencia y bloqueos, una sola ida a la base | `7f26944` | Aplicada (Online v1) |
| 0013 | `collections_expenses` | Recaudos y gastos | Solo efectivo, tope al saldo, imputación capital/interés F5-D01 | `09f177d` | Aplicada (commit `186f90d` «validate phase 5… on managed staging»; regresión de Fase 5 en staging en Fase 6) |
| 0014 | `settlements_closures` | Cuadres y cierres | DS-04 y F6-D01; ciclo por el libro | `03de95a` | Aplicada 2026-10-18 (Fase 6) |
| 0015 | `no_payment_visits` | Alta de visitas sin pago | RLS: quien registra es quien visita | `09b8a15` | Aplicada (R26) |
| 0016 | `period_reopen` | Reapertura de periodo cerrado | Motivo ≥ 10 caracteres; nueva versión al recerrar | `09b8a15` | Aplicada (R26) |
| 0017 | `payment_corrections` | Corrección de pagos y solicitudes de ajuste | Reversión + reemplazo en una transacción | `09b8a15` | Aplicada (R26) |
| 0018 | `business_date` | Fecha contable de la empresa | `business_today()`; excepción solo para aprovisionar la Demo | `09b8a15` | Aplicada (R26) |
| 0019 | `reconciliation_ledger_checks` | Conciliación del libro en una función | Solo SuperAdmin del contexto; no escribe | `d834c76` | Aplicada (R26) |
| 0020 | `rls_context_once` | Rendimiento RLS | Contexto evaluado una vez por consulta; regla intacta | `a35eb56` | Aplicada (R39: 0001–0020) |
| 0021 | `owner_online_access` | Owner original en Online y primer acceso | Eventos con autor; enlaces de acceso | `4875ef3` | Aplicada 2026-10-20 (R40) |
| 0022 | `payment_locations` | Ubicación del cobro | Tabla aparte del libro; el abono no depende de ella | `19ab31f` | Aplicada (R53: 0001–0022) |
| 0023 | `remove_socio_admin_transfers` | Retirada de Socio; traspasos entre Administradores | Borra Caja socios y rol `socio`; aportes históricos → cuenta externa | `f3c1fc2`, corregida en `07ceffe` | Aplicada (R53: 0001–0023) |
| 0024 | `superadmin_email_change` | Cambio de correo del SuperAdmin | Misma identidad; solo plano de control | `80d2db6` | Aplicada (R59: 0001–0024) |
| 0025 | `voluntary_deliveries_requests` | Entregas voluntarias y solicitudes de capital | Traspaso directo sin confirmación; `capital_requests` | `de8203c` | Aplicada 2026-10-21 (R59) |
| 0026 | `offline_collector` | Captura sin conexión del Cobrador | `offline_captures`; mismos comandos e idempotencia | `42ede4d` | Aplicada 2026-10-21 (R62) |
| 0027 | `offline_disbursements` | Desembolsos aprobados sin conexión | Corregida en 65-C1: solo desembolsos | `24ef149`, reescrita en `e71d5d0` | Aplicada 2026-10-21 (R65) |
| 0028 | `superadmin_portfolio_read_only` | SuperAdmin sin escritura en cartera | `clients_manage_*` y `ctx_can` sin SuperAdmin | `9902795` | Aplicada 2026-10-22 (R67) |
| 0029 | `route_map_locations` | Mapa de rutas | `client_locations` (referencia) y `sale_locations` (dispositivo), solo inserción | `9902795` | Aplicada 2026-10-22 (R67) |
| 0030 | `credit_conditions_rectification` | Parcelas en la autorización; rectificación de créditos desembolsados; D73-01/02/03 (tasa por ruta en el guardián, cuotas `sustituida`, comprobación y casos) | Parcelas pedidas/aprobadas; `DISBURSEMENT_ADJUSTMENT`; `credit_rectifications` (append-only); `adex.credit_rectify`; ciclo y cifras de periodo con el ajuste | `6d8d520` | 2026-10-23 (R73 §8.2) |
| 0031 | `single_active_session` | Una sola sesión activa por identidad | `identity_active_sessions`; motivo `superseded`; `ctx_session_valid` exige la sesión vigente; `claim_session` | `4b4510c` | 2026-10-23 (R73 §8.2) |

| 0032 | `rectification_with_payments` | Bloque A de R74: rectificación con pagos (efecto neto), reclasificación capital/interés, reaplicación de pagos anulados | Tipo `PRINCIPAL_RECLASSIFICATION`; `sales.principal_reclassified_minor`; `payments.reapplies_payment_id`; `collection_reapply` | local (R74) | **NO aplicada** (reversión probada en local) |

| 0033 | `superadmin_supervisor_roles` | E1 de R74 (SuperAdmin sin operaciones de ruta, cuadres ni cierres) y huecos de roles H1–H3 | `ctx_can` y 9 funciones redefinidas; políticas contra autoasignación y autoaprobación | local (R74) | **NO aplicada** (reversión probada en local) |

**Migraciones catalogadas:** 31 aplicadas en staging + 0032 y 0033 (creadas en R74, sin aplicar). `staging:migrate` vuelve a aplicar las contraseñas de los roles: si un despliegue de Render falla por autenticación justo después, reintentar (R73 §8.3). Los commits de las filas 0023 y 0027 provienen de `git log` del archivo.

---

## D. Historial de despliegues con evidencia

El bundle de Vercel **cambia de nombre con cada commit**, aunque el código no cambie: el build incrusta metadatos de Git (`VITE_VERCEL_GIT_COMMIT_SHA`, entre otros). El nombre del bundle identifica un despliegue, no una versión funcional. Para saber qué commit se sirve, leer `VITE_VERCEL_GIT_COMMIT_SHA` dentro del bundle (§H).

| Fecha | Componente | Commit | Bundle / funciones `/healthz` | Verificación | Fuente |
|---|---|---|---|---|---|
| ≤ 2026-10-13 | CLEAN (`rutacash-clean`) | NO VERIFICADO | `index-b05G8Ybt.js` | `verify:deploy` 81/81 | [Fase 0A](./SAAS_FASE_0A_RESULTADOS.md) |
| 2026-10-16 | CLEAN | `1ebab80` o posterior | `index-C1zR2rb4.js` | build local idéntico al publicado | [Online v1 §7](./ADEX_ONLINE_V1_RESULTADOS.md) |
| 2026-10-17 | `adex-online` (Vercel) | `186f90d` | NO VERIFICADO | El push de `03de95a` quedó `CANCELED` por la puerta | [Fase 6](./SAAS_FASE_6_RESULTADOS.md) |
| ≤ 2026-10-18 | `adex-online-api` (Render), primer despliegue | DESCONOCIDO | `settlements-v1` | Pruebas de seguridad 65/66 contra la API publicada | [Administración](./ADEX_ONLINE_ADMINISTRACION_RESULTADOS.md) |
| 2026-10-18 | Web + API (Demo) | `654f35d` o posterior | NO VERIFICADO | 51/51 con la web de Vercel y la API de Render | [R20 §1.3](./ADEX_RONDA_20_OWNER_Y_DEMO.md) |
| 2026-10-19 | Web + API | `origin/main` = `1018391` | `index-BBRl2Vjp.js` · `collections, settlements, clean-online, changes` | Validación financiera R39 | [R39](./ADEX_RONDA_39_VALIDACION_FINANCIERA_Y_PILOTO.md) |
| 2026-10-20 | API + `adex-owner-api` + web | Web `b6b09d3`; API NO VERIFICADO | `access-links-v1` · Owner `owner-v1, owner-clean-v1` · `owner-CWwRkmy3.js` | E2E publicado 32/32 | [R40 §9](./ADEX_RONDA_40_OWNER_ONLINE.md) |
| 2026-10-20 | Web (R48–R50) | NO VERIFICADO | `index-B43wJZVi.js` | Mención en R53 | [R53](./ADEX_RONDA_53_TRANSFERENCIAS_SIN_SOCIO.md) |
| 2026-10-20 | CLEAN | NO VERIFICADO | `index-BFPxK5j8.js` (200) | Mención en R53 | [R53](./ADEX_RONDA_53_TRANSFERENCIAS_SIN_SOCIO.md) |
| 2026-10-21 | API + web; CLEAN retirada | Git hasta `3b931e1`; commit desplegado NO VERIFICADO | `index-CcMcoY51.js` · `capital-requests-v1`; CLEAN 404 | Lecturas; BlueLine y Owners intactos | [R59 §5](./ADEX_RONDA_59_DINERO.md) |
| 2026-10-21 | API + web | Web: redespliegue del commit del push (no anotado); API NO VERIFICADO | `index-ktbVB77B.js` · `offline-collector-v1` | E2E 54/54; BlueLine intacta | [R62 §6](./ADEX_RONDA_62_OFFLINE_COBRADOR.md) |
| 2026-10-21 | API + web | Web `e71d5d0`; API NO VERIFICADO | `index-DrYEAZLA.js` · `offline-disbursements-v1` | Lecturas; BlueLine intacta | [R65 §0](./ADEX_RONDA_65_OFFLINE_DESEMBOLSOS.md) |
| 2026-10-22 | API + web | `54944b8` (ambos) | `index-NVUgseqU.js` · `route-map-v1` | Lecturas; BlueLine intacta | [R67 §6](./ADEX_RONDA_67_SUPERADMIN_Y_MAPA.md) |
| 2026-10-22 | Web (despliegue automático del push documental) | `b44379b` | `index-XNxWREae.js` | Consulta R70 (abajo) | este registro |
| 2026-10-23 | `adex-online-api` + `adex-owner-api` (Render) + web | `2fa7152` (los tres; Render según su panel) | `index-DyK4-kHp.js` · `credit-rectification-v1, movements-v1, single-session-v1` · Owner sin cambio de funciones | 401 en los endpoints nuevos sin sesión; recuentos idénticos; BlueLine y Owners intactos | [R73 §8](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md) |

**Ronda 73:** publicada el 2026-10-23. El primer despliegue del Owner falló por autenticación tras migrar; el reintento quedó Live. Ver [R73 §8.3](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md).

**Publicaciones con evidencia:** 15 filas (R73 con commit en los tres servicios). Seis rondas tienen bundle, funciones y verificación documentados (R39, R40, R59, R62, R65, R67); solo en R67 consta además el commit desplegado en Render. El resto es evidencia parcial.

### Estado publicado observado el 2026-10-22 (consulta de solo lectura de la Ronda 70)

| Servicio | Resultado |
|---|---|
| `adex-online-api` `/healthz` | `ok` · `collections-v1, settlements-v1, clean-online-v1, changes-v1, access-links-v1, payment-location-v1, admin-transfers-v1, capital-requests-v1, offline-collector-v1, offline-disbursements-v1, route-map-v1` (las 9 que exige la puerta, presentes) |
| `adex-owner-api` `/healthz` | `ok` · `owner-v1, owner-clean-v1, owner-email-v1` |
| `adex-online.vercel.app` | `index-XNxWREae.js`, compilado de `b44379b` (`VITE_VERCEL_GIT_COMMIT_SHA`); contiene `/admin/mapa`, «Ubicación del cliente» y el aviso offline de 65-C1 |
| `rutacash-clean.vercel.app` | 404 (retirada) |
| Commit desplegado en Render | **DESCONOCIDO** por consulta: `/healthz` no publica el commit. Según R67, `54944b8`; las funciones anunciadas coinciden |

Web y API **no** están en el mismo commit: la web sirve `b44379b` (solo documentación respecto de `54944b8`) y la API, según R67, `54944b8`. Funcionalmente coinciden.

---

## E. Decisiones aprobadas vigentes

Solo se listan decisiones con aprobación escrita. Donde una decisión sustituye a otra, se indica.

| Ámbito | Decisión | Fecha | Fuente |
|---|---|---|---|
| SaaS multiempresa | Visión SaaS comercial, multiempresa, internacional | 2026-10-14 | [Visión §2](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md) |
| SaaS multiempresa | **DS-15:** tablas compartidas + RLS + autorización en la API; infraestructura dedicada solo como excepción | 2026-10-14 | [Visión §4](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md) |
| Arquitectura | **DS-01:** API TypeScript propia + PostgreSQL gestionado; reglas de CLEAN como contrato | 2026-10-14 | [Visión §6](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md) |
| Identidad | **DS-05:** una identidad, varias membresías, contexto activo explícito, sin acumulación de permisos | 2026-10-14 | [Visión §7](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md) |
| Owner / empresa | **DS-17:** mismo PostgreSQL, plano de control separado; el Owner no es membresía ni tiene autoridad financiera; sin impersonación | 2026-10-14 | [`0006`](../saas/db/migrations/0006_control_plane_access.sql) |
| Owner / empresa | API Owner como servicio aparte (`adex-owner-api`) | 2026-10-20 | [R40](./ADEX_RONDA_40_OWNER_ONLINE.md) |
| Owner / empresa | El Owner cambia el correo de un SuperAdmin sin cambiar su identidad | 2026-10-20 | [`0024`](../saas/db/migrations/0024_superadmin_email_change.sql) |
| Datos | **DS-10** documento único de cliente; **DS-11** sin borrados físicos con historia | 2026-10-14 | [Fase 2](./SAAS_FASE_2_RESULTADOS.md) |
| Datos | El SaaS empieza de cero (sin migrar datos de CLEAN) | NO VERIFICADO (sin documento) | — |
| Capital y custodia | Empresa → bolsa del Administrador → custodia del trabajador por ruta, **sin caja de ruta** (C1). **Sustituye** a las cajas de ruta del plan original y al capital por ruta de v16 | 2026-10-15/16 | [C1](./CAPITAL_CENTRALIZADO_C1_2026-10.md), [Fase 3](./SAAS_FASE_3_RESULTADOS.md) |
| Capital y custodia | **F5-D01:** imputación capital/interés acumulada y determinista (clasificación interna, no fiscal) | 2026-10-17 | [Fase 5](./SAAS_FASE_5_RESULTADOS.md) |
| Capital y custodia | **DS-04:** fecha y periodos según la zona horaria de la empresa y el reloj del servidor. **F6-D01:** entregas parciales y varios cuadres por periodo | 2026-10-17 | [Fase 6](./SAAS_FASE_6_RESULTADOS.md) |
| Capital y custodia | **Socio retirado** de ADEX Online (sin rol, sin Caja socios). **Sustituye** la mención a Socios y Caja socios de la Visión §1 y §3 | 2026-10-20 | [R53](./ADEX_RONDA_53_TRANSFERENCIAS_SIN_SOCIO.md) |
| Autorizaciones financieras | Cobrador solo solicita, al 20 %; el 10 % lo fija un autorizador; nadie resuelve su propia solicitud | 2026-10-16 | [Fase 4](./SAAS_FASE_4_RESULTADOS.md) |
| Autorizaciones financieras | Traspasos entre Administradores; el registrado por Secretario requiere a ambos Administradores (R53) | 2026-10-20 | [R53](./ADEX_RONDA_53_TRANSFERENCIAS_SIN_SOCIO.md) |
| Autorizaciones financieras | Quien tiene el dinero lo entrega sin pedir permiso; quien lo necesita lo solicita. El traspaso directo entre Administradores ya no requiere confirmación del destino (**sustituye** esa parte de R53) | 2026-10-21 | [R59](./ADEX_RONDA_59_DINERO.md) |
| Operación offline | Primera versión solo en línea (DS-07 en Fases 4–6). **Sustituida** en R62: el Cobrador registra sin conexión abonos, visitas sin pago y sus gastos | 2026-10-21 | [R62](./ADEX_RONDA_62_OFFLINE_COBRADOR.md) |
| Operación offline | **65-C1:** sin conexión, solo desembolsos de ventas ya aprobadas; clientes y ventas offline prohibidos (**sustituye** R65 original) | 2026-10-21 | [R65 §0](./ADEX_RONDA_65_OFFLINE_DESEMBOLSOS.md) |
| Responsabilidad de cartera | La cartera es de la ruta; sin conexión, la oficina registra clientes y ventas en la ruta que corresponde | 2026-10-21 | [R65 §0](./ADEX_RONDA_65_OFFLINE_DESEMBOLSOS.md) |
| SuperAdmin | En CARTERA, solo Clientes en consulta; no vende, autoriza, cobra ni corrige. Conserva capital, gastos, estructura, cuadres, cierres y reportes | 2026-10-21 | [R67](./ADEX_RONDA_67_SUPERADMIN_Y_MAPA.md) |
| SuperAdmin | **R74 (aprobado; implementado en 0033, sin publicar):** supervisor, no operador financiero. Pierde cuadres, cierres, devoluciones y traspasos de trabajadores, anulaciones de ruta y gastos de ruta o de trabajador. **Sustituye** en esa parte a R67. Conserva por ahora el capital de empresa (única entrada de capital hasta Base por Ruta) | 2026-10-23 | [R74 §5](./ADEX_RONDA_74_INTERVENCION_INTEGRAL.md) |
| Mapa y GPS | **D-UX48-02/03:** ubicación del dispositivo al registrar un abono, como evidencia complementaria; sin ubicación el abono no se bloquea | 2026-10-20 | [R48](./ADEX_RONDA_48_OPTIMIZACION_UX.md) |
| Mapa y GPS | Mapa del Administrador; ubicación de referencia del cliente (GPS en sitio o pin) distinta de la del dispositivo en la venta | 2026-10-21 | [R67](./ADEX_RONDA_67_SUPERADMIN_Y_MAPA.md) |
| Mercados | Brasil y Colombia como mercados iniciales | 2026-10-14 | [Visión §3](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md) |
| Producto | CLEAN retirada como aplicación pública; su código sigue como fuente de Online | 2026-10-21 | [R59](./ADEX_RONDA_59_DINERO.md) |
| Autorizaciones financieras | Quien autoriza con `authorization.modifyConditions` puede cambiar el número de parcelas antes de aprobar (SOC-04) | 2026-10-22 | [R73](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md) |
| Créditos | El **Administrador** corrige una venta desembolsada sin recaudos y cuyo desembolso no está en un cuadre ni cierre (capital entregado, interés, parcelas, calendario), sin borrar la venta ni el asiento original; la eliminación definitiva **no** está autorizada y la anulación excepcional queda fuera de alcance (SOC-09) | 2026-10-22 | [R73](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md) |
| Formularios | Toda venta o solicitud nueva propone 20 parcelas, modificables, sin límite (SOC-03); el **negocio** del cliente es obligatorio al crearlo (SOC-05) | 2026-10-22 | [R73](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md) |
| Identidad | Una sola sesión activa por identidad: iniciar sesión en otro dispositivo revoca la anterior, para todos los perfiles, también Owners (SOC-01) | 2026-10-22 | [R73](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md) |
| Autorizaciones financieras | **D73-01:** sin «Tasa libre», el Cobrador origina con la tasa de su ruta; con «Tasa libre», 10 % o 20 %. **Sustituye** «el Cobrador solo solicita al 20 %» (Fase 4). Solo existen 10 % y 20 % | 2026-10-23 | [R73 §7](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md) |
| Créditos | **D73-02:** la rectificación puede reducir parcelas (las sobrantes quedan sustituidas, nunca borradas). **D73-03:** correcciones excepcionales bloqueadas; casos registrables sin efecto financiero. **D73-06:** la venta real del incidente se corrige desde la interfaz solo si cumple los requisitos | 2026-10-23 | [R73 §7](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md) |
| Operación offline | **D73-04:** las capturas de una sesión desplazada se conservan y solo se envían tras revisión explícita y nueva autenticación en ese dispositivo | 2026-10-23 | [R73 §7](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md) |
| Mapa y GPS | **D73-05:** búsqueda por dirección pospuesta (sin proveedor) | 2026-10-23 | [R73 §7](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md) |
| Créditos | **R74 · bloque A (implementado, sin publicar):** el Administrador corrige ventas con pagos anulados o vigentes; los pagos se conservan; la diferencia de imputación es una reclasificación sin efectivo; el total corregido no baja de lo pagado; reaplicación de pagos anulados bloqueada si la anulación entró en un cuadre. **Sustituye** en parte a SOC-09/D73-03 («sin ningún pago»). D74-A1 (cuadre/custodio solo bloquean si cambia el capital) pendiente de confirmación | 2026-10-23 | [R74 §1](./ADEX_RONDA_74_INTERVENCION_INTEGRAL.md) |
| Capital y custodia | **R74 · dirección aprobada (sin implementar):** Base independiente por Ruta; Caja principal como panel consolidado; SuperAdmin supervisor sin facultades financieras. Diseño técnico y decisiones O1–O11 pendientes. **Sustituirá** a C1 (bolsa del Administrador) cuando se apruebe e implemente | 2026-10-23 | [R74 §4](./ADEX_RONDA_74_INTERVENCION_INTEGRAL.md) |
| Documentos | **SOC-10 suspendida:** no se modifican CPF, RG ni el catálogo documental hasta confirmar el documento real del caso reportado | 2026-10-22 | [R73](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md) |

**Decisiones abiertas según el documento rector** (sin aprobación escrita posterior encontrada): DS-02 (proveedor, plan, copias, PITR), DS-03 (proveedor de identidad), DS-06 (importación de historia), DS-08, DS-09, DS-12 (piloto), DS-13 (residencia de datos y normativa), DS-14 (retención y registro de seguridad), DS-16 (exportación de datos locales).

---

## F. Estado vigente (2026-10-23)

| Componente | Desarrollo | Publicación | Última verificación | Pendiente de validación operativa |
|---|---|---|---|---|
| Identidad, membresías, contexto (DS-05) | Cerrado | Publicado | R67, 2026-10-22 | — |
| Estructura: oficinas, rutas, usuarios, configuración | Cerrado | Publicado | R67 | Uso por el socio |
| Capital centralizado, Caja principal, transferencias, solicitudes | Cerrado | Publicado | R59; vigente en R67 | Uso por el socio |
| Créditos: solicitud, autorización, desembolso | Cerrado | Publicado | R65/R67 | Uso por el socio |
| Recaudos, visitas sin pago, correcciones, gastos | Cerrado | Publicado | R62/R67 | Uso por el socio |
| Cuadres, cierres, reapertura | Cerrado | Publicado | R39 (validación financiera) | Uso por el socio |
| Notificaciones y Consultas | Cerrado | Publicado | R59 | Uso por el socio |
| Offline del Cobrador (abonos, visitas, gastos, desembolsos aprobados) | Cerrado | Publicado | R65-C1, 2026-10-21 | Prueba con teléfonos ([R65 §7](./ADEX_RONDA_65_OFFLINE_DESEMBOLSOS.md), en empresa de prueba, no en BlueLine) |
| SuperAdmin con cartera de solo lectura | Cerrado | Publicado | R67, 2026-10-22 | Uso por el socio |
| Mapa del Administrador y GPS en ventas | Cerrado | Publicado | R67, 2026-10-22 | Uso en campo |
| Plataforma Owner (`/owner`, `adex-owner-api`) | Cerrado | Publicado | Consulta R70 (`/healthz`) | — |
| Empresa Demo | Retirada (R53) | No hay Demo activa | R53 | Recreación: decisión del propietario |
| Empresa BlueLine (pruebas operativas del socio, en paralelo con Listos; registros posiblemente reales, se conservan íntegros) | En ADEX-Staging: 36 ventas, 640 parcelas, 48 pagos, 37 solicitudes, 92 operaciones de capital | — | R73 §8.4 (solo lectura, 2026-10-23) | Evaluación de R73 |
| CLEAN local | Congelada | **Retirada** (404) | Consulta R70 | — |
| R73: SOC-07 (tasa autorizada) y SOC-02 (venta con la bolsa) | Cerrado | Publicado (`2fa7152`) | R73 §8, 2026-10-23 | Corrección de la venta real del incidente por el Administrador (D73-06) |
| R73: parcelas al aprobar, rectificación (0030), Consultas en tabla, negocio obligatorio, sesión única (0031), ubicaciones | Cerrado (incluye D73-01…D73-04) | Publicado (`2fa7152`; 0030/0031 aplicadas) | R73 §8, 2026-10-23 (E2E local 52/52) | Evaluación del socio ([R73 §9](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md)); la tabla B requiere empresa de pruebas autorizada |

---

## G. Trabajos pendientes

Registro, no plan de trabajo. «Confirmado» = pendiente vigente en el documento de ronda más reciente que lo trata.

| Tema | Pendiente | Tipo | Fuente |
|---|---|---|---|
| Validación operativa | Pruebas del socio sobre lo publicado; prueba con teléfonos del offline | Confirmado | [R65 §7](./ADEX_RONDA_65_OFFLINE_DESEMBOLSOS.md), [R67](./ADEX_RONDA_67_SUPERADMIN_Y_MAPA.md) |
| Apertura de cartera existente | Sin importador de saldos iniciales ni procedimiento de discrepancias; importación de historia sin decidir (DS-06) | Confirmado | [R40 §8](./ADEX_RONDA_40_OWNER_ONLINE.md), [R39 §6](./ADEX_RONDA_39_VALIDACION_FINANCIERA_Y_PILOTO.md) |
| Offline: ampliaciones | Registro en servidor de capturas offline no aplicadas; fotos de gastos; ubicación de visitas (sin autorización); venta directa del Cobrador (regla sin decidir); fecha de inicio vencida al sincronizar | Confirmado (propuestas futuras, no tareas) | [R62 §5](./ADEX_RONDA_62_OFFLINE_COBRADOR.md), [R65 §6](./ADEX_RONDA_65_OFFLINE_DESEMBOLSOS.md) |
| Respaldo y continuidad | Copias de seguridad sin verificar; PITR y recuperación probada sin decidir (DS-02, DS-14); Render Free se suspende tras 15 min sin tráfico | Confirmado | [R40 §8](./ADEX_RONDA_40_OWNER_ONLINE.md), [Render](./ADEX_ONLINE_RENDER.md) |
| Seguridad y privacidad | SMTP real (recuperación de contraseña); restablecer contraseña de un usuario activo (decisión); retención de auditoría (DS-14); `demo-accounts.ts` con `rejectUnauthorized: false`; metadatos de Git (incluido el mensaje del commit) visibles en el bundle público (observado en R70, sin evaluar) | Confirmado / observación | [R40 §8–9](./ADEX_RONDA_40_OWNER_ONLINE.md), §D |
| Retención de coordenadas | Plazo de conservación y borrado de ubicaciones; quién las consulta; sin revisión LGPD / Ley 1581 | Confirmado | [R48 §4](./ADEX_RONDA_48_OPTIMIZACION_UX.md), [R67 §5](./ADEX_RONDA_67_SUPERADMIN_Y_MAPA.md) |
| Teselas del mapa | Proveedor para uso intensivo / comercial | Confirmado | [R67 §5](./ADEX_RONDA_67_SUPERADMIN_Y_MAPA.md) |
| Internacionalización | Interfaz solo en español (portugués pendiente); moneda de facturación SaaS sin definir; empresas con rutas en varias zonas horarias | Confirmado | [R40 §8](./ADEX_RONDA_40_OWNER_ONLINE.md), [Visión §9](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md) |
| Suscripciones y comercial | Planes, precios y lanzamiento sin fijar; residencia de datos y normativa (DS-13); `billableRouteCount` (A6/DS-17) | Confirmado | [Visión §3, §16, §20](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md) |
| Capacidad multiempresa | Sin prueba de carga multiempresa documentada; errores 500 intermitentes bajo carga vistos en pruebas (RND-010/011, repetidos sin fallo) | Confirmado (vacío) | [R40 §9](./ADEX_RONDA_40_OWNER_ONLINE.md) |
| Proveedor | Supabase y Render operan Online, pero DS-02 y DS-03 siguen sin aprobación escrita y el proyecto se llama «ADEX-Staging» aunque aloja una empresa real (BlueLine) y los Owners reales. **Contradicción documental**, no de código: la decide el propietario | Confirmado | [Visión §16](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md), [R59](./ADEX_RONDA_59_DINERO.md) |
| Herramientas internas | `scripts/prod-smoke.mjs` y `verify:deploy` apuntan a la URL retirada de CLEAN | Confirmado (no bloqueante) | [R59 §5](./ADEX_RONDA_59_DINERO.md) |
| Ronda 73 · evaluación | Pruebas del socio según [R73 §9](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md); empresa sintética para las pruebas con dinero (requiere autorización) | Pendiente | [R73 §9.3](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md) |
| Ronda 73 · después de publicar | Corregir la venta real del incidente SOC-07 desde la interfaz si cumple los requisitos (D73-06); procedimiento futuro para los casos excepcionales registrados (D73-03); proveedor de búsqueda por dirección (D73-05) | Pendiente | [R73 §7.6](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md) |
| Ronda 74 · decisiones | D74-A1…A4 (rectificación), O1–O11 (Base por Ruta, SuperAdmin, indicadores), D74-H1 (enmienda de DS-05 para «solo el Administrador acumula perfiles») | Pendiente del propietario | [R74 §8](./ADEX_RONDA_74_INTERVENCION_INTEGRAL.md) |
| Ronda 74 · Base por Ruta | Rama `r74-route-base` (local, sin publicar): 0034 (núcleo), 0035 (gastos generales O4F), Caja principal y Transferencias nuevas. Decisiones RB-D1…RB-D9 pendientes. No activar en empresas reales sin publicación autorizada, respaldo y procedimiento O6 | Pendiente | [R74 §14](./ADEX_RONDA_74_INTERVENCION_INTEGRAL.md) |
| Listos (paralelo) | Análisis de los archivos exportados de Listos para la importación inicial (DS-06); no autoriza importar datos | Pendiente | [R74 §0.2](./ADEX_RONDA_74_INTERVENCION_INTEGRAL.md) |
| Ronda 74 · publicación | **Puertas superadas** (regresión limpia, respaldo `adex-20261023T1820` restaurado y verificado, responsables válidos, sin combinaciones de membresías). Aplicar 0032 y 0033 con copia previa, desplegar APIs y web; caso de referencia de BlueLine corregible desde la interfaz | Pendiente de autorización | [R74 §12](./ADEX_RONDA_74_INTERVENCION_INTEGRAL.md) |
| Respaldos (P-05) | La copia cifrada de R73 no es una política: respaldos periódicos, retención, PITR, continuidad; evaluar Supabase Pro de STARCLI sin mezclar productos | Confirmado | [R74 §0.2](./ADEX_RONDA_74_INTERVENCION_INTEGRAL.md) |
| Pruebas HIST-001/002/003 | Fallan igual en `72b6e1b` (antes de R73): escenario Demo fechado (AX413 el 2026-10-06). No es defecto productivo demostrado; el escenario histórico de la Demo debe revisarse | Confirmado (heredado de R72) | [R73 §4](./ADEX_RONDA_73_CORRECCIONES_SOCIO.md) |

**Cerrados que ya no son pendientes:** publicación de R73 y su puerta de recuperación (copia cifrada verificada, R73 §8); SuperAdmin → Clientes solo lectura (pendiente en R65 §6, cerrado en R67); ubicación para el mapa (R65 §6, cerrado en R67); reintento del abono con id nuevo (R48 §4, cerrado en R48.1); recuperación ante `/healthz` incompleto en frío (R53, corregido en R59); Demo Online (retirada por decisión en R53).

### Vacíos históricos identificados

1. Publicaciones de la etapa CLEAN (junio–octubre): sin registro en Git de fechas ni bundles, salvo las constancias de octubre.
2. Rondas sin documento propio: R29, R33, R47 (auditoría UX), R49, R50, R54, R55. Su publicación solo consta de forma indirecta.
3. Primer despliegue de `adex-online-api` en Render: fecha y commit desconocidos.
4. Commit desplegado en Render en R40, R59, R62 y R65: no anotado (solo funciones de `/healthz`).
5. Fase 6: no consta en el documento la publicación del frontend con `settlements-v1`, aunque R17 la da por publicada.
6. La decisión «el SaaS empieza de cero, sin migrar CLEAN» no tiene documento.

---

## H. Cómo mantener este registro

Al cerrar cada ronda (lo hace quien la cierra, en el mismo commit documental):

1. **Línea de tiempo (§B.2):** una fila por ronda: fecha, funcionalidad, commits reales (`git log --oneline`), migraciones, enlace al documento de la ronda.
2. **Migraciones (§C):** una fila por archivo nuevo; «Staging» solo cuando el propietario confirme `staging:migrate` y la huella esté comprobada.
3. **Despliegues (§D):** una fila solo con evidencia. Comprobar:
   - API: `curl https://adex-online-api.onrender.com/healthz` y `https://adex-owner-api.onrender.com/healthz` (funciones);
   - web: nombre del bundle en `https://adex-online.vercel.app/` y su `VITE_VERCEL_GIT_COMMIT_SHA`;
   - el commit desplegado en Render, tomado del panel o del aviso del propietario (la API no lo publica).
4. **Decisiones (§E):** añadir solo lo aprobado por escrito; marcar «sustituye a» cuando corresponda; no borrar filas sustituidas.
5. **Estado (§F) y pendientes (§G):** actualizar; mover a «cerrados» lo que se cierre.
6. **Pruebas:** no copiar resultados; enlazar la sección del documento de la ronda.
7. Ante duda: «NO VERIFICADO». Nunca completar por memoria.
8. **Orden de archivos:** aplicar las reglas R1–R11 de la [auditoría de organización §12](./AUDITORIA_ORGANIZACION_PROYECTO_ADEX.md): salidas en `tmp/rNN/`; al terminar las pruebas, borrar solo las copias de compilación de la ronda y los `tmp/saas-phase01/pgdata-*` de ejecuciones que ya no estén activas (comprobando antes procesos y `postmaster.pid`); conservar arneses, registros finales, instantáneas y capturas finales; nada nuevo en la raíz. Ante duda, conservar y reportar.

---

## I. Esta ronda

| | |
|---|---|
| Alcance | Solo documentación: crear este archivo. Sin cambios de código, migraciones, bases de datos, variables ni despliegues manuales |
| Lecturas remotas | `/healthz` de las dos API; HTML y bundle públicos de `adex-online.vercel.app`; código HTTP de `rutacash-clean.vercel.app` |
| Efecto del push | Vercel recompila `adex-online` (la puerta ve las 9 funciones): el bundle cambia de nombre y de commit incrustado, sin cambio funcional. Render no se despliega solo |
