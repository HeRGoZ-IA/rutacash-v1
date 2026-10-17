# ADEX Online — primera versión privada: resultados

| | |
|---|---|
| Fecha | 2026-10-16 · base `main` @ `a64406e` (SaaS Fases 0–4) |
| Autorización | Desarrollar, integrar y probar ADEX Online con datos sintéticos; preparar el despliegue privado. **No** contratar, publicar ni hacer push sin aprobación posterior |
| Resultado | Interfaz web independiente + API conectada a PostgreSQL + Empresa Demo administrable, validadas en local y en ADEX-Staging. **Nada publicado ni contratado** |

## 1. Qué se construyó

| Pieza | Dónde | Qué hace |
|---|---|---|
| Servidor ADEX Online | [`saas/src/server/`](../saas/src/server) | Un proceso Node: `/v1/*` (API de empresa), `/demo/v1/*` (administración Demo), `/healthz`, `/readyz`. CORS solo para orígenes configurados, cabeceras de seguridad (HSTS incluido), límite por IP y por token, registro por petición sin tokens, cuerpos, correos ni ids. La API Owner **no** se publica |
| API de empresa | [`saas/src/http/companyApi.ts`](../saas/src/http/companyApi.ts) | Misma tabla de endpoints de las Fases 1–4, ahora montable en el servidor y ejecutable en proceso. Nuevo `GET /v1/operations/:id` para recuperar una operación incierta |
| Empresa Demo | [`0011`](../saas/db/migrations/0011_demo_company_admin.sql) · [`saas/src/demo/`](../saas/src/demo) · [`demoApi.ts`](../saas/src/http/demoApi.ts) | Crear, reiniciar, eliminar y recrear (ver §3) |
| Contexto en un viaje | [`0012`](../saas/db/migrations/0012_request_context_roundtrip.sql) | La resolución del contexto (≈11 consultas secuenciales) pasa a una función con la misma secuencia y bloqueos (ver §6) |
| Interfaz web | [`online/`](../online) | Aplicación React + Vite **independiente** de CLEAN (propio `index.html`, propio bundle, sin Dexie). Solo en línea |
| Despliegue (preparado) | [`deploy/`](../deploy) · [`online/vercel.json`](../online/vercel.json) | Dockerfile del API, especificación de App Platform sin secretos, configuración Vercel del frontend |

CLEAN (`src/`) no se modificó. La API sigue importando las reglas de CLEAN como contrato (DS-01).

## 2. La interfaz

Inicio de sesión con Supabase Auth (la contraseña solo va al proveedor) → selector explícito de empresa · rol · país (DS-05; Demo marcada «datos ficticios») → menú según las capacidades que devuelve el servidor:

| Pantalla | Quién | Contenido |
|---|---|---|
| Clientes | Todos (por rutas) | Listado, búsqueda, alta, ficha con créditos y solicitudes, «Solicitar préstamo» |
| Capital | SuperAdmin, Administrador | Su bolsa (el Admin solo la suya; SuperAdmin además empresa, aportes y asignaciones), entrega anticipada al trabajador, devolución, movimientos por ruta |
| Mi efectivo | Cobrador, Supervisor | Custodia por ruta y movimientos visibles; nunca bolsas |
| Solicitudes | `sale.createRequest` | Nueva solicitud (el Cobrador al 20 %), estado de las solicitudes |
| Autorizaciones | `authorization.approve` | Bandeja de pendientes, aprobar (con tasa si puede modificar condiciones) o rechazar con motivo. Las propias aparecen bloqueadas; el servidor rechaza también la autoaprobación con otra membresía de la misma persona |
| Desembolsos y créditos | `sale.confirmDisbursement` / `sale.viewActive` | Confirmar el dinero efectivamente entregado (casilla obligatoria), créditos originados con cuotas y trazabilidad |
| Próximamente | Todos | Recaudos, gastos, cuadres, cierres y reportes: **no disponibles**, sin simulación |
| Administrar Empresa Demo | Solo operadores Demo | §3 |

Comportamiento en línea: sin caché de negocio; cada pantalla relee del servidor al entrar, cada 15 s con la pestaña visible, al volver a la pestaña y con «Actualizar». Sin WebSockets. Aviso visible de conexión perdida. El navegador guarda solo tokens y la membresía elegida (base `adex-server-mode`); no existe base local financiera. Comandos de dinero y altas con `X-Adex-Operation-Id` por intención: si la respuesta se pierde, se consulta `/v1/operations/:id` **antes** de repetir; si no existe, se repite con el mismo id (seguro); si no se puede comprobar, la interfaz muestra «Comprobar en el servidor» en lugar de «repetir». Aprobar/rechazar (sin idempotencia en el servidor) releen el estado. Si el contexto deja de valer (Demo reiniciada, membresía desactivada), la interfaz vuelve al selector con el motivo.

## 3. Empresa Demo: procedimiento

**Decisión de diseño.** El libro financiero es inmutable incluso para el administrador de la base (0002, 0009, 0010). Habilitar borrados para «limpiar» una Demo exigiría debilitar esa garantía. Por eso:

- **Reiniciar = recrear** con un ID interno NUEVO y el escenario versionado conocido (`demo-v1`), y **retirar** la anterior.
- **Eliminar = retirar** la Demo vigente y dejar el hueco vacío.
- **Recrear** = crear en el hueco vacío (otro ID; no depende de ids ni sesiones anteriores).
- **Retirar** = suspender (REVOKE-004: espera a las operaciones en curso; las siguientes reciben `COMPANY_BLOCKED`), marcar `retired_at` de forma **irreversible** (ningún plano puede reactivarla), ocultarla del selector y desactivar sus identidades sintéticas. Sus filas quedan íntegras, cuadradas e inaccesibles. **No hay borrado físico** de datos financieros, ni para Demos ni para empresas normales.

| Control | Cómo |
|---|---|
| Solo empresas Demo | `companies.is_demo` se fija al crear (solo el ciclo de vida) y es inmutable; el ciclo de vida actúa solo sobre la Demo vigente del hueco |
| Autoridad propia | `adex_demo.operators` (alta solo por el administrador de la base, nunca por la API). No es el Owner ni una membresía; no da acceso a ninguna empresa |
| Rol de base de datos propio | `adex_demo` (login, NOINHERIT, sin privilegios de tabla): solo ejecuta las funciones del ciclo de vida. `adex_api` y `adex_control` no pueden llamarlas |
| Objetivo por ID interno | Reiniciar/eliminar exigen `companyId` y su confirmación idénticos; nunca por nombre |
| Concurrencia | Todo el ciclo de vida serializa sobre el hueco (`DEMO_BUSY` para la segunda operación); congelar espera a las operaciones en curso |
| Fallo | Si el escenario o la conciliación fallan, la Demo nueva se retira y la anterior se descongela intacta |
| Recuperación | Si el proceso se reinicia a mitad, «Recuperar aprovisionamiento interrumpido» lo revierte |
| Auditoría | `adex_demo.events`, fuera de los datos de la empresa y solo de añadido (también rechazos y fallos) |
| Mismo motor | El escenario son llamadas a la API de empresa normal hechas por puestos **sintéticos** (identidades sin cuenta de acceso). Nunca se actúa con el puesto de una persona |
| Conciliación | Tras el escenario se exige `GET /v1/capital/reconciliation` = ok antes de activar |
| Personas | Puestos asignables (SuperAdmin, Admin Centro, Cobrador Centro, Supervisor Centro) para personas **invitadas** por el procedimiento del proveedor (alta sin contraseña; la fija la persona con «primer acceso»). Su identidad global no se toca al reiniciar: reciben membresías en la Demo nueva |

Escenario `demo-v1` (Brasil, BRL, `America/Sao_Paulo`): Ruta Norte (todo sintético, créditos en cada estado: desembolsado, aprobado, pendiente) y Ruta Centro (puestos para las personas, R$ 20.000 en la bolsa del Admin Centro y una solicitud pendiente). 8 clientes ficticios (documentos con prefijo 999), aporte inicial R$ 50.000, asignaciones a las bolsas, entrega al Cobrador Norte.

## 4. Permisos y seguridad

- Registro público deshabilitado en Supabase Auth de ADEX-Staging (`disable_signup: true`, comprobado y probado: el alta pública falla) y usuarios anónimos desactivados.
- Autorización en cada petición: token ES256/JWKS → identidad → membresía → empresa operable → reglas de CLEAN, y RLS por empresa y rol como segunda barrera (sin cambios de las Fases 1–4).
- El navegador no escribe tablas: la API no tiene privilegios de escritura sobre el libro; el dinero solo pasa por `adex.capital_post` y `adex.credit_disburse`.
- Ninguna bolsa visible para el Cobrador (403 en `capital/summary` y `reconciliation`).
- Sin credenciales sensibles en el frontend: solo URL del API, URL de Supabase y la clave **publicable**. La clave secreta y las credenciales de base de datos viven solo en el servidor (variables de entorno).
- Secretos fuera de Git: `saas/.env.staging`, `saas/.env.online` y `online/.env*` ignorados; `.dockerignore` excluye `.env*`.
- Owner sin autoridad financiera adicional; la administración Demo es una autorización separada.

## 5. Pruebas

| Batería | Resultado |
|---|---|
| SaaS local (`npm test`: typecheck + unitarias + PostgreSQL 17 real, 0001–0012) | **13 + 214 PASS · 0 FAIL**. Nuevas (17): DEMO-001/002/010/011/030/031/032/040/041/042/050/051, ONL-020/021/060/061/062 |
| ADEX-Staging (`staging:test`, Auth real + pooler, 0001–0012) | **39/39 PASS** (34 de Fases 1–4 + STG-ONL-001…005). Una ejecución anterior falló por DNS local hacia el pooler (`ENOTFOUND`, ya documentado en la Fase 4); el aprovisionamiento abortó limpio, como debe |
| E2E navegador real (Chrome, dos contextos aislados = dos dispositivos, API local → ADEX-Staging) | **27/27 OK** en dos ejecuciones consecutivas (Administrador a 1366 px, Cobrador a 412 px). Script y capturas: `tmp/adex-online-v1/e2e/` (fuera de Git) |
| CLEAN | Ver §8 |

Cobertura pedida: login y sesiones (AUTH-STG, E2E-01/03), selección de membresía (E2E-09/10, DEMO-011), aislamiento (ONL-021, STG-RLS), permisos por rol (ONL-020, E2E-13), entregas y custodia (ONL-020, E2E-11/12), solicitudes y aprobaciones con autoaprobación bloqueada (ONL-020, STG-ONL-003), desembolsos (E2E-17/20), idempotencia y operaciones inciertas (ONL-020, STG-ONL-003), dos clientes independientes (ONL-020, STG-ONL-003, E2E), reinicio repetido (DEMO-031, STG-ONL-004), eliminación y recreación (DEMO-032), bloqueo durante el reinicio (DEMO-040/041), protección de empresas normales (DEMO-050), auditoría persistente (DEMO-051), conciliación tras reiniciar (DEMO-031, STG-ONL-004), sin escritura financiera desde el navegador (ONL-020, E2E-04).

## 6. Alojamiento: verificación de DigitalOcean App Platform

| Requisito | Comprobado |
|---|---|
| ¿Funciona la API? | Sí. Imagen con Dockerfile (App Platform lo admite). Reproduje la estructura de la imagen fuera del repositorio solo con dependencias de producción (`jose`, `pg`, más `uuid` y `date-fns` que usa el motor de cuotas de CLEAN): arranca y carga todo el código. No se construyó la imagen Docker (no hay Docker en este equipo) |
| Node | 24.15.0 (el buildpack admite 24.x; la imagen fija `node:24.15.0-bookworm-slim`). Sin paso de compilación: Node ejecuta el TypeScript |
| Comandos | Instalación `npm ci --omit=dev`; arranque `node --import ./scripts/register-alias.mjs src/server/main.ts`; puerto `PORT` (8080), enlazado a `0.0.0.0` |
| RAM/CPU | Proceso medido: **102 MiB en reposo, 109 MiB en ráfaga** de 200 lecturas con 20 concurrentes. Cabe holgado en 512 MiB. Pool de 8 conexiones al pooler de transacciones |
| Plan de US$5 | `apps-s-1vcpu-0.5gb`: 1 vCPU compartida, 512 MiB, un solo contenedor (sin escalado), 50 GiB de salida incluidos. Suficiente para propietario y socio |
| Región y latencia | **App Platform no tiene región en São Paulo** (NYC, ATL, RIC, TOR, SFO, AMS, LON, FRA, BLR, SGP, SYD, MKC). RTT Nueva York ↔ São Paulo ≈ 107–122 ms (publicado); desde este equipo medí 138 ms. Con la 0012, desde aquí: lecturas 0,4–0,7 s, comandos de dinero 1,2–1,6 s, crear/reiniciar la Demo ≈ 44 s (asíncrono, la interfaz muestra el progreso). Desde NYC se espera algo similar o algo menor |
| HTTPS, secretos, logs, CORS | HTTPS lo pone App Platform; HSTS lo añade el código (App Platform no lo hace). Secretos como variables cifradas. Registros JSON sin datos. CORS por lista exacta |
| Pooler de Supabase | Modo transacción (6543) validado; TLS verificado con el certificado raíz de Supabase (`ADEX_PG_SSL_CA_PEM`, obligatorio salvo prueba explícita) |
| Salud y reinicios | `/healthz` (vida) para App Platform; `/readyz` (base); cierre ordenado con SIGTERM; reconexión del pool ante errores |
| Acceso privado | Registro público cerrado; solo identidades invitadas; operadores Demo solo por la base |
| Cargos adicionales | Salida por encima de 50 GiB: US$0,02/GiB (irrelevante a este volumen). IP de salida dedicada no necesaria. **DigitalOcean no ofrece tope de gasto**: solo alertas de gasto (configurar alertas bajas) |

**Conclusión.** DigitalOcean App Platform (US$5) **cumple** en memoria, CPU, Node, HTTPS, secretos y operación. Su punto débil es la **latencia**: la base está en São Paulo y App Platform no. Con la optimización 0012 la experiencia es usable (≈0,5 s lecturas, ≈1,5 s operaciones de dinero). Si se quiere respuesta inmediata, la alternativa es alojar el API en **São Paulo** junto a la base (por ejemplo Google Cloud Run en `southamerica-east1`, servicios de AWS en `sa-east-1` o Fly.io `gru`), donde cada petición tardaría decenas de milisegundos. **Precios y condiciones de esas alternativas no verificados**: hay que confirmarlos antes de elegir. Recomendación: empezar con DigitalOcean NYC (o ATL) si se prioriza coste fijo y simplicidad; reconsiderar al pasar a uso diario de Cobradores.

## 7. Coste esperado y contratación manual

- API: **US$5/mes** (App Platform `apps-s-1vcpu-0.5gb`). Requiere cuenta de DigitalOcean con método de pago: **no se contrató**.
- Frontend: proyecto Vercel nuevo (sitio estático) en el plan actual, sin coste adicional previsto. **No se creó**.
- PostgreSQL y Auth: ADEX-Staging (Supabase Free, São Paulo), sin cambios de plan.

## 8. Estado de CLEAN

`src/` sin cambios. Las 27 suites de CLEAN en verde sobre este árbol (`npm test` termina en 0, ninguna línea de fallo; entre ellas `permissions` 559/559 y `centralcapital` 37/37). `npm run build` produce el mismo bundle publicado, `index-C1zR2rb4.js`. El capital centralizado de CLEAN sigue inactivo para sus empresas; no se importó nada de CLEAN. `online/` es un proyecto aparte: el build y el `tsconfig` de CLEAN no lo incluyen.

## 9. Bloqueos reales

Ninguno técnico. Pendiente de decisión del propietario: contratación del alojamiento y región, publicación, invitación de las dos personas reales, y si se desea en el futuro un borrado físico de Demos retiradas (hoy no existe por diseño).

## 10. Pasos para publicar (cuando se autorice)

> **Actualización:** el propietario eligió **Render Free** para el API en lugar de DigitalOcean. La configuración, las pruebas de suspensión y reinicio y la guía del panel están en [ADEX_ONLINE_RENDER.md](ADEX_ONLINE_RENDER.md); sustituyen al paso 2. Los demás pasos siguen vigentes.

1. **ADEX-Staging**: credenciales estables ya generadas (`saas/.env.online`, local). Descargar el certificado raíz de Supabase (Database settings → SSL) para `ADEX_PG_SSL_CA_PEM`.
2. **DigitalOcean** (con su cuenta y método de pago): crear la app desde `deploy/digitalocean/app.yaml` (repositorio `HeRGoZ-IA/rutacash-v1`, rama `main`, despliegue manual), elegir región (NYC o ATL), rellenar los secretos: `ADEX_API_DATABASE_URL`, `ADEX_DEMO_DATABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `ADEX_PG_SSL_CA_PEM`. Configurar alertas de gasto. Verificar `https://<app>/healthz` y `/readyz`.
3. **Vercel**: proyecto nuevo con directorio raíz `online`, variables `VITE_ADEX_API_URL` (URL del paso 2), `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`. Poner su dominio en `ADEX_ALLOWED_ORIGINS` del API y en Supabase Auth → URL Configuration (Site URL / redirect) para el «primer acceso».
4. **Staging admite personas reales**: el control previo de `staging.ts` bloquea si Auth tiene correos que no sean `@example.test`; al invitar al propietario y al socio hay que ampliar ese control con una lista explícita de correos autorizados.
5. **Operador Demo**: el administrador de la base da de alta la identidad del propietario en `adex_demo.operators`.
6. **Invitar y crear**: en «Administrar Empresa Demo», asignar los puestos (propietario: SuperAdmin + Admin Centro; socio: Cobrador Centro + Supervisor Centro), «Crear Empresa Demo». Cada persona usa «Olvidé mi contraseña / primer acceso» para fijar su contraseña.
7. Push de los commits locales (requiere autorización): Vercel CLEAN se redespliega con `main`, pero no cambia (CLEAN intacto); el API no se despliega solo (`deploy_on_push: false`).
