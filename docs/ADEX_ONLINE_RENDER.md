# ADEX Online — API en Render Free: preparación, validación local y guía de despliegue

| | |
|---|---|
| Fecha | 2026-10-16 · base `main` @ `7f26944` (ADEX Online v1 publicada en Git, sin desplegar) |
| Autorización | Adaptar y validar para Render Free; preparar configuración y guía. **No** crear servicios, contratar, añadir medios de pago, desplegar ni hacer push |
| Resultado | Configuración lista y validada **en local**. **Nada creado en Render.** El comportamiento en la infraestructura real de Render queda pendiente de verificar tras el despliegue (§7) |

## 1. Qué cambia respecto de la preparación para DigitalOcean

| Tema | Render Free (documentación oficial, octubre 2026) | Consecuencia para ADEX Online |
|---|---|---|
| Despliegue | Servicio web con **Docker** (Dockerfile en ruta propia, contexto configurable) o Node nativo | Se usa el **mismo Dockerfile** ya preparado (`deploy/adex-online-api/Dockerfile`): fija Node 24.15.0 y solo instala dependencias de producción. Node nativo exigiría instalar a mano las dependencias de CLEAN en la raíz: más frágil |
| Puerto | Por defecto `10000`; el servicio debe escuchar en `0.0.0.0` | El servidor ya lee `PORT` y escucha en `0.0.0.0`. En la guía se fija `PORT=10000` explícitamente |
| HTTPS | Certificado y redirección HTTP→HTTPS gestionados por Render; el balanceador termina TLS | Sin cambios. HSTS lo sigue añadiendo el código |
| Instancia Free | 0,1 CPU y 512 MB; una sola instancia; sin disco persistente; sin shell | Memoria medida: ≈ 109 MiB. **CPU**: el arranque consume ≈ 1,6 s de CPU en este equipo; con 0,1 CPU puede tardar del orden de 15–20 s (estimación, §7) |
| Suspensión | Tras **15 min sin tráfico** se detiene; la siguiente petición la despierta en ≈ 1 min. Render puede reiniciarla **en cualquier momento**. El sistema de archivos se pierde | No hay estado financiero en el servidor: PostgreSQL es la autoridad. Ver §3 (lo probado) y §7 (lo pendiente) |
| Regiones | Oregón, Ohio, **Virginia**, Fráncfort, Singapur. **Ninguna en Sudamérica** | Virginia (EE. UU. este) es la más cercana a la base en São Paulo (§6) |
| Horas | 750 h Free por espacio de trabajo y mes; dormida no consume | Un solo servicio 24/7 = 744 h: **no se agota** |
| Salida de datos (plan Hobby) | **5 GB/mes** incluidos (respuestas a navegadores y tráfico iniciado hacia Internet, p. ej. hacia Supabase). Exceso: US$0,15/GB **si hay medio de pago**; **sin medio de pago, los servicios se detienen** hasta el mes siguiente | Uso esperado de dos personas muy por debajo (§8). Sin medio de pago, nunca hay cargo |
| Compilación | 500 min/mes; sin medio de pago o al llegar al límite de gasto, no se compila más ese mes (lo desplegado sigue) | Cada despliegue manual ≈ unos minutos |
| Despliegue automático | `On Commit` (por defecto), `After CI Checks Pass` u `Off` | **Off**: un push a `main` (que publica CLEAN en Vercel) **no** despliega el API |
| Secretos | Variables de entorno y **archivos secretos** (`/etc/secrets/<nombre>`, máx. 1 MB). Las variables también llegan como argumentos de construcción Docker | Nuevo `ADEX_PG_SSL_CA_FILE`: el certificado de Supabase se sube como archivo secreto (más fiable que pegar un PEM de varias líneas). El Dockerfile no declara `ARG` ni copia esos archivos |
| Salud | Comprobación HTTP a la ruta indicada (2xx/3xx = sano, 5 s de espera). En marcha: 60 s fallando → reinicio | `/healthz` (no toca la base): una caída de Supabase **no** provoca reinicios en bucle. `/readyz` comprueba la base, para diagnóstico |
| Parada | SIGTERM y, tras 30 s por defecto, SIGKILL | El servidor cierra ordenadamente en ≤ 10 s |
| Base de datos | — | **No** se usa Render Postgres ni ningún otro recurso de Render: solo un servicio web |

Fuentes: [Free](https://render.com/docs/free), [Web services](https://render.com/docs/web-services), [Docker](https://render.com/docs/docker), [Blueprint spec](https://render.com/docs/blueprint-spec), [Deploys](https://render.com/docs/deploys), [Health checks](https://render.com/docs/health-checks), [Environment variables](https://render.com/docs/configure-environment-variables), [Regions](https://render.com/docs/regions), [Outbound bandwidth](https://render.com/docs/outbound-bandwidth), [Build pipeline](https://render.com/docs/build-pipeline). Las cifras de planes cambiaron en abril de 2026 (la salida incluida en Hobby bajó a 5 GB): **confírmelas en la página de facturación de su espacio de trabajo antes de crear el servicio**.

## 2. Cambios en el código (estrictamente de compatibilidad)

| Archivo | Cambio | Por qué |
|---|---|---|
| [`saas/src/db/tx.ts`](../saas/src/db/tx.ts) | Mientras una conexión está **en uso**, se escucha su evento de error; si se rompe, se **descarta** en vez de devolverla al pool | **Fallo real encontrado** (RND-040): si el pooler cortaba conexiones durante transacciones en curso, el evento de error sin oyente **tumbaba el proceso**. En Render Free (reinicios, conexiones largas a São Paulo) habría dejado el API caído hasta el siguiente reinicio. BEGIN/COMMIT/ROLLBACK, reintentos y bloqueos no cambian |
| [`online/src/lib/client.ts`](../online/src/lib/client.ts) | Un **5xx** en un comando idempotente se trata como **resultado desconocido**: se consulta `/v1/operations/:id` antes de repetir (antes solo se hacía ante falta de respuesta) | Si la conexión con PostgreSQL se corta **durante el COMMIT**, el API responde 500 aunque la operación pudo quedar confirmada. Antes la interfaz lo mostraba como error definitivo y un nuevo clic generaba **otro id** (riesgo de duplicar una entrega). Ahora nunca se repite con un id nuevo. Un 4xx sigue siendo definitivo |
| `online/src/lib/client.ts`, [`app.tsx`](../online/src/lib/app.tsx), [`App.tsx`](../online/src/App.tsx) | Si una petición tarda más de 4 s: aviso «Activando el servidor… No repita la operación» | La primera visita tras 15 min sin uso tarda ≈ 1 min |
| [`saas/src/server/start.ts`](../saas/src/server/start.ts) | `ADEX_PG_SSL_CA_FILE`: ruta del certificado raíz (archivo secreto de Render). `ADEX_PG_SSL_CA_PEM` sigue valiendo | Subir un archivo es más sencillo y seguro que pegar un PEM multilínea |
| [`deploy/render/render.yaml`](../deploy/render/render.yaml) | Especificación de referencia: un único servicio `web`, `runtime: docker`, `plan: free`, `region: virginia`, `autoDeployTrigger: off`, secretos `sync: false`. **Sin bases de datos ni otros recursos** | Reproducible y revisable. Está fuera de la raíz: Render no la aplica sola |
| [`deploy/adex-online-api/Dockerfile`](../deploy/adex-online-api/Dockerfile), [`.dockerignore`](../.dockerignore) | Comentarios para Render; `.dockerignore` excluye también `*.key` | Los archivos secretos de Render se copian a la raíz del contexto de construcción; nunca entran en la imagen |
| [`saas/test/integration/render-resilience.test.ts`](../saas/test/integration/render-resilience.test.ts), [`saas/test/helpers/render.ts`](../saas/test/helpers/render.ts) | Nueva batería (§3) | — |

Nada cambia en reglas financieras, migraciones, RLS, autorización, idempotencia del servidor ni CLEAN (`src/`).

## 3. Pruebas de resiliencia (reproducidas EN LOCAL)

El servidor **real** (`saas/src/server/main.ts`) se lanza como proceso aparte, configurado **solo por variables de entorno** (como en Render), contra **PostgreSQL 17 real** detrás de un proxy que **exige TLS** con un certificado propio verificado por `ADEX_PG_SSL_CA_FILE` (imita al pooler) y que puede cortar conexiones. El cliente es la clase real de la interfaz web (`OnlineClient`). **Esto no es Render**: reproduce sus efectos sobre el proceso y las conexiones.

| Prueba | Qué se provoca | Resultado |
|---|---|---|
| RND-001 | Arranque con `PORT` asignado | Escucha en ese puerto y en `0.0.0.0`; `/healthz` 200 sin base; `/readyz` 200 por TLS verificado; HSTS; CORS solo para el origen configurado (otro origen → 403 sin cabecera CORS); sin token o con token falsificado → 401; registros sin contraseña, clave secreta ni token. Arranque hasta escuchar: 0,8–2,8 s en este equipo |
| RND-002 | Falta el certificado, archivo inexistente, falta la base; certificado de otra autoridad | No arranca (código 1) con mensaje claro y **sin secretos**. Con certificado ajeno: TLS rechazado, `/readyz` 503, el proceso sigue vivo y **ningún** movimiento se registra |
| RND-010 | Suspensión: proceso muerto | Las peticiones no obtienen respuesta. Al relanzarlo: pool nuevo, saldos idénticos, el resultado de la última operación se recupera por id y repetirla con el mismo id devuelve lo mismo sin otro movimiento. Conciliación limpia |
| RND-011 | Respuesta **perdida** y **503** después del COMMIT (proxy de fallos) | El cliente web consulta por id y devuelve el resultado: **exactamente un** depósito en cada caso. Un 4xx sigue siendo definitivo |
| RND-012 | Servidor caído durante un comando | El cliente no repite a ciegas: `UncertainOperation` («Comprobar en el servidor»). Tras reactivar, «Comprobar» lo confirma **una vez**; pulsarlo de nuevo no duplica |
| RND-020 | **Muerte abrupta** (SIGKILL) del proceso a los 0–300 ms de 13 comandos de dinero | 6 ya estaban confirmados al morir (recuperados por id) y 7 no (repetidos con el mismo id): **13 depósitos exactos**, saldo exacto, conciliación limpia |
| RND-030 | Dos asignaciones simultáneas del 60 % del capital disponible; tres envíos simultáneos con el **mismo** id | Una 201 y otra `409 INSUFFICIENT_FUNDS`; saldos exactos. Mismo id: tres respuestas idénticas y **un** movimiento |
| RND-040 | El pooler corta todas las conexiones; base inaccesible; corte con **12 transacciones en curso** | Conexiones viejas descartadas (siguientes lecturas 200). Base caída: `/healthz` 200 (sin reinicios en bucle), `/readyz` 503, comando 5xx sin movimiento, luego se repite con el mismo id. Corte en curso: 4 respuestas ok y 8 5xx; tras consultar, 4 ya confirmadas y 8 repetidas: **12 exactas**. **El proceso sobrevive** (antes de corregir `tx.ts`, moría aquí) |
| RND-050 | El API muere justo después de iniciar un **reinicio de la Empresa Demo** | Tras relanzar: hueco en `resetting`, sin trabajo vivo; otro reinicio → `DEMO_BUSY`. «Recuperar aprovisionamiento interrumpido» retira la Demo a medio crear y la anterior vuelve operativa. Nuevo reinicio: empresa con **otro id**, cuadrada; las dos anteriores retiradas (irreversible), todas marcadas Demo; auditoría fuera de la empresa; empresas normales intactas |
| RND-060 | SIGTERM | **Omitida en Windows** (no hay señales POSIX); el código cierra en ≤ 10 s. Pendiente de ver en Render (Linux) |

Además, réplica de la **estructura exacta de la imagen** fuera del repositorio (mismos `COPY`, `npm ci --omit=dev`: solo `date-fns`, `uuid`, `jose`, `pg` y sus dependencias), arrancada con `PORT=10000` y `NODE_ENV=production`: escucha en 1,1 s, **1,6 s de CPU** hasta escuchar, **109 MiB** de memoria; `/healthz` 200, `/readyz` 503 (base inaccesible, como se esperaba), sin token 401, origen ajeno 403, ruta desconocida 404, sin secretos en registros. **La imagen Docker en sí no se construyó** (no hay Docker en este equipo): la primera construcción real será la de Render.

## 4. Regresión

| Batería | Resultado |
|---|---|
| SaaS (`saas: npm test`: typecheck + unitarias + PostgreSQL 17 real 0001–0012, con la batería nueva) | typecheck OK · **13/13** unitarias · **223 PASS / 0 FAIL / 1 SKIP** de 224 (SKIP = RND-060, SIGTERM en Windows). Las 214 anteriores siguen en verde con el cambio de `tx.ts` |
| Batería Render sola (`npm run test:db -- render-resilience`) | 9 PASS / 1 SKIP en 4 ejecuciones del archivo completo y 4 de RND-050 aislada. **Una** ejecución completa anterior falló una vez en RND-050 con `ECONNRESET` en una petición del cliente de prueba, sin reproducirse después; causa no determinada (el diagnóstico ampliado de la prueba la mostrará si reaparece) |
| Interfaz `online/` (`npm run build`: typecheck + Vite) | OK |
| CLEAN | `src/` sin cambios; `npm test` termina en 0; `npm run build` produce `index-C1zR2rb4.js` (el publicado) |

## 5. Guía para el propietario: crear el servicio en Render

> **Antes de empezar.** Render construye desde GitHub: el commit con estos cambios debe estar **publicado en `main`** (requiere su autorización de push). Nunca escriba claves, contraseñas, tokens ni cadenas de conexión en un chat (tampoco en ChatGPT): se copian **solo** de su fuente (Supabase o el archivo local) al panel de Render.

### 5.1 Facturación (antes de crear nada)

1. En Render, abra su espacio de trabajo → **Billing**. Compruebe el plan (**Hobby**) y si hay un **método de pago** registrado.
2. **Recomendado: sin método de pago.** Así, si algún día se superan los 5 GB de salida o los 500 min de compilación, Render **detiene** el servicio hasta el mes siguiente en lugar de cobrar.
3. Si ya hay una tarjeta: en **Workspace Settings → Build Pipeline → Set spend limit** fije el límite de compilación en US$0. Para la salida de datos Render **no ofrece tope**: revise el consumo en Billing de vez en cuando (§8).

### 5.2 Datos que necesitará (sin copiarlos a ningún otro sitio)

| Dato | Dónde se obtiene |
|---|---|
| Certificado raíz de Supabase | Supabase → proyecto **ADEX-Staging** → Project Settings → **Database** → SSL Configuration → **Download certificate**. Guárdelo con el nombre `supabase-ca.crt` |
| `SUPABASE_URL` | Supabase → ADEX-Staging → Project Settings → **API** (o Data API): *Project URL* (`https://<ref>.supabase.co`) |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase → ADEX-Staging → Project Settings → **API Keys**: clave *publishable* (`sb_publishable_…`) |
| `SUPABASE_SECRET_KEY` | Misma página: clave *secret* (`sb_secret_…`). Solo para invitar personas; nunca llega al navegador |
| `ADEX_API_DATABASE_URL` y `ADEX_DEMO_DATABASE_URL` | Archivo local `saas/.env.online` de este equipo (generado al preparar ADEX Online; ignorado por Git). Copie cada valor completo, tal cual |
| `ADEX_ALLOWED_ORIGINS` | La dirección del frontend en Vercel (p. ej. `https://<proyecto>.vercel.app`), **sin barra final**. Si aún no existe, ver §5.5 |

### 5.3 «Deploy a Web Service»: qué seleccionar

1. **New → Web Service** (o «Deploy a Web Service»).
2. **Source Code → Git Provider → GitHub**: si Render pide acceso, conceda acceso **solo** al repositorio **`HeRGoZ-IA/rutacash-v1`**. Selecciónelo.
3. Rellene:

| Campo | Valor |
|---|---|
| Name | `adex-online-api` (será `https://adex-online-api.onrender.com` si el nombre está libre; si no, Render añade un sufijo: anote la URL real) |
| Project | Ninguno, o uno nuevo «ADEX Online» |
| Language | **Docker** |
| Branch | `main` |
| Region | **Virginia (US East)**. No se puede cambiar después |
| Root Directory | **vacío** (la raíz del repositorio: el API usa las reglas de CLEAN de `src/`) |
| Instance Type | **Free** |

4. Abra **Advanced** y rellene:

| Campo | Valor |
|---|---|
| Dockerfile Path | `./deploy/adex-online-api/Dockerfile` |
| Docker Build Context Directory | `.` (la raíz) |
| Docker Command | **vacío** (usa el del Dockerfile) |
| Health Check Path | `/healthz` |
| Pre-Deploy Command | vacío |
| Auto-Deploy | **Off** |

5. **Environment Variables** (*Add Environment Variable*; el nombre exactamente así):

| Nombre | Valor |
|---|---|
| `PORT` | `10000` |
| `ADEX_TRUST_PROXY` | `1` |
| `ADEX_API_POOL_MAX` | `8` |
| `ADEX_PG_SSL_CA_FILE` | `/etc/secrets/supabase-ca.crt` |
| `ADEX_ALLOWED_ORIGINS` | según §5.2 |
| `SUPABASE_URL` | según §5.2 |
| `SUPABASE_PUBLISHABLE_KEY` | según §5.2 |
| `SUPABASE_SECRET_KEY` | según §5.2 |
| `ADEX_API_DATABASE_URL` | según §5.2 |
| `ADEX_DEMO_DATABASE_URL` | según §5.2 |

   **No** añada `ADEX_PG_SSL_INSECURE` (solo para pruebas locales).

6. **Secret Files → Add Secret File**: nombre **`supabase-ca.crt`** y como contenido el texto completo del certificado descargado (de `-----BEGIN CERTIFICATE-----` a `-----END CERTIFICATE-----`).
7. Pulse **Deploy Web Service**. Render construirá la imagen (unos minutos la primera vez).

### 5.4 Comprobar el despliegue

1. **Events**: debe terminar en *Deploy live*. **Logs**: una línea con `"msg":"adex-online listening","port":10000`.
2. En el navegador: `https://<su-servicio>.onrender.com/healthz` → `{"status":"ok"}`.
3. `https://<su-servicio>.onrender.com/readyz` → `{"status":"ready"}` (la base responde por TLS verificado).
4. `https://<su-servicio>.onrender.com/v1/me/memberships` → `{"error":"MISSING_TOKEN"}` (correcto: sin sesión no hay datos).

### 5.5 Frontend y CORS

El frontend (`online/`) se publica después en un **proyecto Vercel nuevo** (directorio raíz `online`, variables `VITE_ADEX_API_URL` = URL de Render sin barra final, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`). Si el API se crea antes que el frontend, ponga en `ADEX_ALLOWED_ORIGINS` la dirección prevista y, cuando Vercel asigne la definitiva, cámbiela en Render → **Environment** → **Save and deploy** (reinicia con el valor nuevo). Añada también esa dirección en Supabase → Authentication → URL Configuration (para «primer acceso»). Varios orígenes: separados por comas.

### 5.6 Errores habituales (sin revelar secretos)

| Síntoma | Dónde se ve | Causa probable |
|---|---|---|
| Falla la construcción: *failed to read dockerfile* / *not found* | Events / Logs de build | Dockerfile Path o Build Context mal escritos (§5.3 paso 4) |
| `startup failed: missing environment variable X` | Logs | Falta la variable X o está vacía |
| `startup failed: ADEX_PG_SSL_CA_FILE cannot be read` / `is not a PEM certificate` | Logs | El archivo secreto no se llama `supabase-ca.crt` o su contenido no es el certificado |
| `startup failed: invalid origin …` | Logs | `ADEX_ALLOWED_ORIGINS` con barra final, ruta o `*` |
| *No open ports detected* / el despliegue no termina | Events | Falta `PORT=10000` |
| `/healthz` ok pero `/readyz` → `{"error":"UNAVAILABLE"}` | Navegador | Cadena de conexión incompleta, certificado equivocado o base inaccesible. Los registros muestran solo `{"level":"error",…,"code":…}`, nunca valores |
| En el navegador: error CORS o «Conexión perdida» siempre | Consola del navegador | El origen del frontend no coincide exactamente con `ADEX_ALLOWED_ORIGINS` |
| La primera carga tarda ≈ 1 min y aparece «Activando el servidor» | Interfaz | Normal en Free tras 15 min sin uso. **No repita** la operación: la interfaz la comprueba sola |
| `429 RATE_LIMITED` | Interfaz | Demasiadas peticiones por minuto (límite por IP/token). Espere un minuto |
| Servicio detenido a mitad de mes | Panel | Se agotaron los 5 GB de salida sin método de pago (§8) |

Para cambiar algo: **Environment** → *Save, rebuild, and deploy* (si cambia el código) o *Save and deploy* (solo variables). Para desplegar un commit nuevo: **Manual Deploy → Deploy latest commit**.

## 6. Región y latencia

Render no tiene región en Sudamérica; **Virginia** es la más cercana a São Paulo (≈ 110–125 ms de ida y vuelta publicados entre la costa este de EE. UU. y São Paulo; desde este equipo, 138 ms). Con la optimización 0012, desde aquí se midió: lecturas 0,4–0,7 s y comandos de dinero 1,2–1,6 s. Desde Virginia se espera **similar** (≈ 0,5–0,9 s lecturas, ≈ 1,3–2 s dinero), algo más por la CPU de 0,1. Primera petición tras suspensión: ≈ 1 min de Render + el arranque del proceso (§7). **No medido aún desde Render.**

## 7. Pendiente de verificar en Render real (no afirmado)

1. Construcción real de la imagen con BuildKit en Render.
2. Tiempo de arranque con 0,1 CPU (estimado 15–20 s de proceso, sobre ≈ 1 min de reactivación de Render).
3. Qué recibe el navegador mientras el servicio despierta (petición retenida hasta arrancar o error sin cabeceras CORS). En ambos casos la interfaz es segura: espera, o trata el comando como incierto y consulta por id (RND-011/012).
4. Que las comprobaciones de salud de Render no mantengan despierta la instancia (la documentación no lo dice).
5. Cierre con SIGTERM en Linux.
6. TLS con el certificado de Supabase desde Render y latencia real Virginia ↔ São Paulo.
7. Consumo real de salida (incluye el tráfico hacia Supabase).

## 8. Coste previsto

| Concepto | Previsto |
|---|---|
| Instancia Free | **US$0** |
| Salida | 5 GB/mes incluidos. Estimación para dos personas (≈ 8 h/día, pantallas que se refrescan cada 15 s con la pestaña visible): del orden de 1–2 GB/mes. **Cierre las pestañas que no use**: cada pestaña visible consulta al servidor y además lo mantiene despierto |
| Compilación | 500 min/mes; un despliegue manual consume unos minutos |
| Supabase ADEX-Staging | Sin cambios (Free) |
| Riesgo de cargo | **Ninguno sin medio de pago** (Render detiene en vez de cobrar). Con medio de pago: salida por encima de 5 GB a US$0,15/GB y minutos de compilación adicionales salvo límite de gasto |

Mantener el servicio siempre despierto con «pings» externos es técnicamente posible dentro de las 750 h, pero consume salida y no se ha configurado: es una decisión del propietario.
