# ADEX Soluciones — Fase 0A.1: validación de Supabase Auth y PostgreSQL gestionado

| | |
|---|---|
| Fecha | 2026-10-13 · `main` @ `78a6401` |
| Tipo | Continuación técnica limitada de la Fase 0A. Experimental, datos 100 % sintéticos |
| Código | [`experiments/saas-phase0a/`](../experiments/saas-phase0a/) (fuera de la aplicación publicada) |
| Veredicto | **BLOQUEADA en su parte remota. Preparación completa.** El proyecto Supabase no se creó: hace falta que el propietario inicie sesión en su cuenta de Supabase. Ninguna prueba contra Supabase real se ejecutó. Todo lo que no depende del proyecto remoto está hecho y probado (§J) |
| Costo | 0. No se creó ningún recurso remoto |
| Decisiones | Este informe no aprueba DS-02 ni DS-03 ni inicia la Fase 1 |

Entrada: [Fase 0A](./SAAS_FASE_0A_RESULTADOS.md) · [Arquitectura](./ARQUITECTURA_SAAS_PROPUESTA_2026-10.md) · [Riesgos](./RIESGOS_CONCURRENCIA_SAAS_2026-10.md) · [Decisiones pendientes](./DECISIONES_PENDIENTES_SAAS_2026-10.md).

---

## Resumen de los criterios de aceptación

| # | Criterio | Estado | Evidencia / causa |
|---|---|---|---|
| 1 | Proyecto Supabase gratuito y aislado | **BLOQUEADO** | Requiere el inicio de sesión del propietario (§2). El arnés verifica nombre, plan, región, usuarios y base antes de cualquier SQL |
| 2 | Identidad real mediante Supabase Auth | **BLOQUEADO** | AUTH-REAL-001 preparado y ampliado; `skipped` sin credenciales |
| 3 | JWT real firmado y validado (JWKS) | **BLOQUEADO** | AUTH-REAL-001/002 preparados (alg, `kid`, JWKS, iss, aud, exp, alterados, `alg none`, HS256) |
| 4 | Auth → API → membresía | **BLOQUEADO** | AUTH-REAL-004 preparado |
| 5 | Desactivación efectiva de membresía | PASS local · BLOQUEADO gestionado | ID-004, TENANT-004 (Fase 0A), REVOKE-001…004 (nuevas). Con token real: AUTH-REAL-004 pendiente |
| 6 | Cero herencia de permisos | PASS local · BLOQUEADO gestionado | ID-003, ID-006; MANAGED-ID-001 y AUTH-REAL-004 pendientes |
| 7 | Aislamiento entre empresas | PASS local · BLOQUEADO gestionado | TENANT-001…005; MANAGED-RLS-001 pendiente |
| 8 | RLS en PostgreSQL gestionado | **BLOQUEADO** | MANAGED-ROLE-001, MANAGED-RLS-001 preparados. Ensayados en local (§J.3), lo que no es evidencia de Supabase |
| 9 | Sin acceso directo por la Data API | **BLOQUEADO** | MANAGED-DATAAPI-001 preparado (REST con publicable, usuario real y secreta; RPC; GraphQL; grants) |
| 10 | Transacción financiera sintética | PASS local · BLOQUEADO gestionado | FIN-001…006 (Fase 0A); MANAGED-FIN-001…004 pendientes |
| 11 | Auditoría atómica | PASS local · BLOQUEADO gestionado | FIN-005; MANAGED-FIN-005 pendiente |
| 12 | CLEAN sin modificaciones | **PASS** | §K: 26 suites, 1.600 casos, mismo bundle `index-b05G8Ybt.js` en build y producción |
| 13 | Credenciales protegidas | **PASS** | No existe ninguna credencial. Arnés: `.env.managed` ignorado, contraseña de `adex_api` efímera, evidencia redactada (§L) |
| 14 | Sin costos ni contrataciones | **PASS** | Nada contratado ni creado |

**La Fase 0A.1 no está terminada.** Los criterios 1–4, 8 y 9 dependen del proyecto remoto. Con el proyecto creado, `npm run test:managed` los ejecuta sin cambiar código (§2.3).

---

## 1. Estado inicial

| | |
|---|---|
| Rama | `main` |
| HEAD | `78a64014636a70123b768e4fcf3eb83ad4276af1` |
| `origin/main` | Igual a HEAD tras `git fetch`. Sin commits posteriores a `78a6401` |
| Archivos ajenos (no se tocan ni se incluyen) | `D docs/ENTREGABLE_SOCIO_OFICINAS_RUTACASH_2026-09.html` · `?? .impeccable/` · `?? docs/OFICINAS_RUTACASH_2026-09.html` |
| POC anterior | Completa: SQL, `src/`, arnés y pruebas. Línea base reproducida antes de editar: typecheck 0 errores, 22 unitarias PASS, 49 integración PASS, 4 AUTH-REAL `skipped` |

## 2. Proyecto de prueba: bloqueo y pasos del propietario

### 2.1 Por qué no se creó

Crear un proyecto exige una sesión autenticada en la cuenta Supabase del propietario (panel, CLI con `supabase login` o un token personal). En este equipo:

- no hay Supabase CLI ni Docker;
- no hay ninguna sesión ni token de Supabase configurado;
- crear una cuenta o iniciar sesión en nombre del propietario no corresponde a este agente.

No se buscaron ni se usaron credenciales almacenadas en el equipo. Ninguna prueba se presentó como ejecutada.

### 2.2 Documentación oficial consultada (2026-10-13)

| Tema | Lo que dice la documentación | Fuente |
|---|---|---|
| Plan Free | 2 proyectos activos; 500 MB de base; 50.000 MAU; 5 GB de egress; cómputo compartido de 500 MB RAM; **pausa tras 1 semana de inactividad** | supabase.com/pricing |
| Regiones | `sa-east-1` (São Paulo) es región específica y hay que elegirla directamente. «La región es un control de ubicación de datos, no prueba de cumplimiento regulatorio». No hay región en Colombia | docs/guides/platform/regions |
| Claves de firma | ES256 (recomendada) y RS256; EdDSA «próximamente»; HS256 no recomendada. JWKS en `/auth/v1/.well-known/jwks.json`, caché de hasta 20 min. Migración: «Migrate JWT secret» → clave en espera → «Rotate keys»; los cambios se limitan a uno cada ~5 min. No se revoca el secreto legado sin desactivar antes `anon`/`service_role` | docs/guides/auth/signing-keys |
| Claves de API | `sb_publishable_…` (anon/authenticated, sujeta a RLS) y `sb_secret_…` (service_role, **ignora RLS**). Van en el encabezado `apikey`, no en `Authorization`. Conviven con las legadas | docs/guides/api/api-keys |
| Conexiones | Directa `db.<ref>.supabase.co:5432` **solo IPv6** sin el complemento IPv4 (de pago). Pooler compartido **IPv4 en todos los planes**: sesión (5432) y transacción (6543). Transacción: sin sentencias preparadas con nombre ni estado de sesión. Rol propio por el pooler: usuario `<rol>.<ref>` | docs/guides/database/connecting-to-postgres |
| Roles | `postgres` «tiene privilegios de administrador»; se pueden crear roles con `LOGIN` y contraseña. La documentación **no** dice si `postgres` tiene BYPASSRLS: se comprueba en `pg_roles` (MANAGED-ROLE-001) | docs/guides/database/postgres/roles |
| Data API | Solo `public` se expone por defecto. Un esquema propio se expone solo si se añade en «Exposed schemas» y se conceden permisos | docs/guides/api/using-custom-schemas |
| Sesiones | Al cerrar sesión se borra la sesión. El access token sigue siendo un JWT válido hasta `exp`; para cortarlo hay que comprobar `session_id` contra `auth.sessions`. Duración por defecto 1 h. **Sesiones acotadas e inactividad: solo Pro o superior** | docs/guides/auth/sessions |

### 2.3 Pasos exactos para el propietario

1. **Cuenta y organización.** Iniciar sesión en supabase.com. En la organización elegida, *Billing* debe mostrar **Free** y ningún método de pago. Si no existe una organización gratuita sin otros productos, crear una nueva en plan Free. No introducir tarjeta.
2. **Límite de proyectos.** El plan Free admite 2 proyectos activos. Si la organización ya tiene 2 activos de otros productos (Starcli u otros), **detenerse**: pausarlos o usarlos no está autorizado.
3. **Crear el proyecto:**
   - nombre exacto `ADEX-SaaS-POC-0A1`;
   - región *South America (São Paulo)*;
   - contraseña de base generada por el panel, guardada en el gestor de contraseñas.
   - São Paulo es la única región sudamericana. Elegirla **no** decide DS-13.
4. **Auth:**
   - en *Authentication → Sign In / Providers*, desactivar *Allow new users to sign up*. El arnés crea los usuarios sintéticos con la API de administración.
   - en *Project Settings → JWT Keys*, comprobar la clave en uso. Si es *Legacy HS256*: *Migrate JWT secret* → esperar → *Rotate keys*, para que firme con ES256. No revocar el secreto legado (no hace falta para la prueba).
5. **Data API:** en *Project Settings → Data API*, dejar los esquemas expuestos por defecto. **No añadir `adex`**.
6. **Claves:** en *Project Settings → API Keys*, copiar la clave publicable (`sb_publishable_…`) y crear o copiar una secreta (`sb_secret_…`).
7. **Conexión:**
   - en *Connect → Session pooler*, anotar el host (`aws-…-sa-east-1.pooler.supabase.com`);
   - opcional: en *Database Settings → SSL*, descargar el certificado y guardarlo **fuera del repositorio**.
8. **Verificación automática (recomendada):** crear un token en *Account → Access Tokens* con caducidad corta (1 día).
   - El arnés lo usa solo para **leer** nombre, región, plan, configuración de Auth, esquemas expuestos y claves de firma.
   - Ese tipo de token no tiene un alcance de solo lectura: revocarlo al terminar.
   - Sin token, el propietario declara `ADEX_POC_OWNER_ATTESTATION=free:<ref>:sa-east-1`. El informe lo registrará como declarado, no verificado.
9. **Variables locales:** copiar `experiments/saas-phase0a/.env.example` a `.env.managed` en la misma carpeta y rellenarlo. Está ignorado por Git y no se pega en ningún chat.
10. **Ejecutar** en `experiments/saas-phase0a`:
    - `npm run test:managed -- --check` → solo comprobaciones, sin escrituras;
    - `npm run test:managed` → prueba completa.
    - La evidencia queda redactada en `tmp/saas-phase0a1/evidence/`. Basta con indicar que existe para que se complete este informe; las credenciales no hacen falta.
11. **Al terminar:**
    - `npm run test:managed -- --teardown`;
    - revocar el token personal;
    - rotar la clave secreta y la contraseña de la base;
    - pausar o borrar el proyecto.

### 2.4 Controles que el arnés aplica antes de cualquier SQL

[`scripts/run-managed.ts`](../experiments/saas-phase0a/scripts/run-managed.ts) se detiene con `BLOQUEADO` y no ejecuta SQL si:

- `SUPABASE_URL` no es exactamente `https://<ADEX_POC_PROJECT_REF>.supabase.co`;
- el nombre no es `ADEX-SaaS-POC-0A1`, o hay más de un proyecto con ese nombre;
- el plan de la organización no es `free` según la Management API (o, sin token, no hay declaración del propietario para ese `ref`);
- el esquema `adex` aparece entre los expuestos por la Data API;
- Supabase Auth tiene algún usuario que no sea `@example.test`;
- `public` tiene tablas, o existe un esquema `adex` sin la marca de esta POC.

Comprobado sin credenciales: `npm run test:managed -- --check` → `BLOQUEADO: falta ADEX_POC_PROJECT_REF`.

## 3. Plan gratuito, 4. Región

No verificados: no hay proyecto. Región prevista: `sa-east-1` (São Paulo). Es la única región sudamericana y la más cercana a Brasil. Para Colombia la latencia queda sin medir. No es la decisión DS-13.

## 5. Herramientas

Las mismas de la Fase 0A: Node 24.15.0, npm 11.12.1, `pg` 8.23.0, `jose` 6.2.12, `embedded-postgres` 17.9.0-beta.17, TypeScript 6.0.3. **Sin dependencias nuevas**, sin Docker y sin Supabase CLI. Las pruebas usan la API REST oficial de Supabase Auth y la Management API con `fetch`.

## 6–8. Auth, algoritmo JWT y JWKS

Sin ejecutar. Lo que las pruebas exigirán al proyecto real ([`test/auth-real/supabase-auth.test.ts`](../experiments/saas-phase0a/test/auth-real/supabase-auth.test.ts)):

- **Algoritmo:** la cabecera del token real debe ser ES256 o RS256. Si el proyecto firma con HS256 legado, la prueba **falla** con ese motivo y el criterio JWKS no se da por superado.
- **JWKS:**
  - el `kid` del token debe estar publicado en el JWKS oficial;
  - ninguna clave del JWKS puede contener material privado (`d`, `p`, `q`, …).
- **Claims:**
  - `iss = https://<ref>.supabase.co/auth/v1`, `aud = authenticated`, `role = authenticated`;
  - `sub` = id del usuario creado; `exp` futuro;
  - la vida del token se registra.
- **Ninguna autoridad en claims:**
  - no hay `company_id`, `membership_id`, `permissions` ni `adex_role`;
  - `app_metadata` solo contiene `provider`/`providers`.
- **Verificador de la API:**
  - se configura **sin** secreto HS256;
  - acepta solo ES256/RS256 con el JWKS remoto y comprueba `iss`, `aud`, `exp` e `iat`.

## 9. Pruebas AUTH-REAL (preparadas, NO EJECUTADAS)

| ID | Qué comprueba con Supabase real |
|---|---|
| AUTH-REAL-001 | Identidad sintética creada con la API de administración. Dos inicios de sesión: mismo `sub` y `session_id` distintos; otra identidad, otro `sub`. Algoritmo, `kid`, JWKS y claims (§6–8) |
| AUTH-REAL-002 | **Credenciales:** contraseña errónea y usuario inexistente → sin token y con el mismo estado HTTP (no permite enumerar usuarios). **Tokens rechazados por el verificador y por la API (401):** basura, `sub` alterado con la firma original, `role` alterado a `service_role`, firma de otra clave con el mismo `kid`, HS256 firmado con la clave publicable, `alg none`, sin token. **Expiración determinista:** el mismo token real evaluado con el reloj en `exp + 60 s` → rechazado; en `iat + 1 s` → aceptado (control). `iss` y `aud` ajenos → rechazados |
| AUTH-REAL-003 | Cierre de sesión `scope=local`: el refresh token deja de servir; se registra lo que responde `/auth/v1/user`; el access token **sigue verificando** con el JWKS hasta `exp`. `scope=global`: la otra sesión tampoco se renueva, pero su access token sigue verificando |
| AUTH-REAL-004 | Una identidad real con tres membresías (admin BR, cobradora BR solo de su ruta, supervisora CO). La API resuelve la identidad desde el `sub`. Empresa y rol salen de PostgreSQL. Sin acumulación: 201 / 404 / `PERMISSION_DENIED` / 404. La auditoría guarda identidad, empresa, membresía y rol. **Tras cerrar sesión, la API sigue aceptando el JWT** (verificación local). Al desactivar la membresía admin, el mismo JWT recibe `MEMBERSHIP_INACTIVE` con **cero efectos** (saldos, movimientos y auditorías iguales). Las otras membresías siguen operativas |

Funciona con PostgreSQL local (`npm run test:integration`) o con el del proyecto (`npm run test:managed`).

## 10. Compatibilidad con la API

Cambio en `src/` del experimento: una opción `now` del verificador, solo para evaluar la expiración de un token real sin esperar. El flujo de la API no cambió. La API sigue leyendo identidad, membresía, empresa, rol, estado y rutas desde PostgreSQL en cada petición (Fase 0A §D).

## 11. Modelo DS-05

Sin cambios de diseño:

- una identidad (`sub`) con varias membresías;
- contexto activo explícito con `X-Adex-Membership`;
- una membresía por petición y sin acumulación;
- auditoría con identidad, empresa, membresía y rol.

**Nuevo:** el caso del encargo (admin y cobradora en Brasil, supervisora en Colombia) queda cubierto con datos sintéticos de dos formas:

- con un token **real** en AUTH-REAL-004;
- sobre PostgreSQL gestionado en MANAGED-ID-001.

No se construyó selector visual.

## 12–14. RLS gestionada, rol utilizado y Data API (preparados)

Batería [`test/managed/managed.test.ts`](../experiments/saas-phase0a/test/managed/managed.test.ts):

| ID | Comprueba |
|---|---|
| MANAGED-ROLE-001 | **`adex_api`:** sin superusuario ni BYPASSRLS, `NOINHERIT`, `LOGIN`, sin pertenencia a otros roles. **Data API:** `authenticator`, `anon`, `authenticated` y `service_role` no pueden asumir `adex_api` ni `adex_owner`. **Conexión:** la API conecta de verdad como `adex_api` por el pooler. **Tablas:** propietario `adex_owner`, RLS habilitada y forzada en las 10. **Privilegios:** sin DELETE/TRUNCATE; sin UPDATE en `movements`/`audit_log`. **Registro:** atributos de `postgres`, `service_role` y demás |
| MANAGED-CONN-001 | Pooler en modo transacción (6543) y en modo sesión (5432) como `adex_api`. El contexto `set_config(…, true)` no se filtra entre transacciones del pooler (15 rondas). Conexión directa IPv6: si la red no la permite, `SKIP` con la causa; no se contrata IPv4 |
| MANAGED-RLS-001 | Sin contexto, ninguna fila. Contexto BR: solo BR, y CO es invisible e inmodificable. Inserciones con empresa o membresía ajena → `42501`. Contexto falsificado → nada. Alcance por rutas. Append-only y sin DELETE. Membresía inactiva → nada |
| MANAGED-DATAAPI-001 | **Grants:** `anon`, `authenticated`, `service_role` y `authenticator` sin `USAGE` en `adex`, sin SELECT/INSERT/UPDATE/DELETE en las 10 tablas y sin EXECUTE en sus funciones. **REST** con clave publicable, con usuario autenticado **real** y con clave **secreta**: GET con `Accept-Profile: adex`, GET en `public`, PATCH, POST y RPC → todos ≥ 400 y sin datos. **GraphQL:** no refleja tipos de `adex`. **Efectos:** el saldo no cambia |

**Rol utilizado.** El esquema lo crea `postgres` con `authorization adex_owner`, y las tablas y políticas las crea `adex_owner` (`set role`). La API solo usa `adex_api`.

**Detalles del rol:**
- La contraseña de `adex_api` se genera en cada ejecución y no se guarda.
- Si `postgres` no tuviera BYPASSRLS en Supabase, sembrar el catálogo fallaría y el arnés lo reportaría como `BLOQUEADO`. No se sustituye por `service_role`.

**Defecto encontrado y corregido antes de usar el proyecto.** En PostgreSQL 16+, un administrador sin superusuario no puede escribir `NOSUPERUSER` ni `NOBYPASSRLS` en `ALTER ROLE`, ni siquiera para quitarlos (`permission denied to alter role`). Así:
- los atributos se fijan solo en `CREATE ROLE`;
- el `ALTER ROLE` cambia únicamente login, límite y contraseña;
- después se comprueba que `adex_api` no tenga atributos privilegiados.

Lo detectó el ensayo local (§J.3).

## 15–16. Concurrencia, transacciones y auditoría atómica

**Sobre Supabase gestionado: BLOQUEADO.** El subconjunto preparado es volumen pequeño, adecuado al plan Free:

| ID | Contenido |
|---|---|
| MANAGED-FIN-001 | 5.000 − 4.000 − 4.000 en 5 rondas. Interbloqueo determinista: B espera el bloqueo visible en `pg_locks` y lee el saldo actualizado; dos backends distintos tras el pooler. 10 retiros de 400 sobre 2.000 → 5 aprobados, saldo 0 |
| MANAGED-FIN-002 | Idempotencia secuencial, rechazo de negocio conservado bajo el mismo `operationId`, 5 copias concurrentes → un movimiento |
| MANAGED-FIN-003 | Colisión con otro importe, cuenta, tipo o membresía → 409 sin efectos |
| MANAGED-FIN-004 | Fallo inyectado tras el UPDATE: el saldo cambió dentro de la transacción y queda intacto después; la clave no se consume |
| MANAGED-FIN-005 | Cada movimiento con exactamente una auditoría aprobada del mismo `txid`, membresía, identidad y rol. El administrador del proyecto tampoco reescribe el libro (disparador `42501`) |
| MANAGED-ID-001 | Sin herencia entre las membresías de Ana. Membresía desactivada: mismo token → `MEMBERSHIP_INACTIVE`, cero efectos |

Los tokens de esta batería son del **emisor local**: prueban PostgreSQL gestionado, no Auth. El recorrido con token real es AUTH-REAL-004.

## 17. Revocación de sesión

| Garantía | Quién la da | Alcance |
|---|---|---|
| El refresh token y la sesión dejan de servir tras el logout | Supabase Auth | Se comprobará en AUTH-REAL-003 |
| El access token ya emitido deja de verificar | **Nadie** antes de `exp` | Es un JWT firmado. La verificación local con JWKS lo acepta hasta `exp` (1 h por defecto) |
| Las operaciones dejan de ejecutarse | **ADEX** | Por membresía en PostgreSQL (§18) o por un control de sesión adicional |

Controles posibles para operaciones sensibles en la Fase 1, sin decidir:

- **(a)** Tokens de 5–15 min. Con la Fase 1 en Free, las sesiones acotadas y el timeout por inactividad no están disponibles: son de Pro o superior.
- **(b)** Comprobar `session_id` contra `auth.sessions` en la misma base, sin llamada de red.
- **(c)** Llamar a `/auth/v1/user` en los comandos financieros, con una llamada de red por comando.

La opción (b) encaja con el diseño, pero la API tendría que leer el esquema `auth`. Ese privilegio hay que verificarlo en el proyecto real.

## 18. Revocación de membresía (§17 del encargo)

Pruebas nuevas [`test/integration/revocation.test.ts`](../experiments/saas-phase0a/test/integration/revocation.test.ts), ejecutadas en PostgreSQL 17.9 local:

| ID | Resultado | Lectura |
|---|---|---|
| REVOKE-001 | PASS | Revocación confirmada mientras la operación tiene el saldo bloqueado → la operación responde `404 ACCOUNT_NOT_FOUND` y no deja efectos. RLS revalida la membresía en cada sentencia (`READ COMMITTED`) y el UPDATE ya no ve la cuenta. El código de error es engañoso: en la Fase 1 debería responder `MEMBERSHIP_REVOKED` |
| REVOKE-002 | PASS | **La ventana existe:** con todas las escrituras hechas, se confirma la revocación y después el COMMIT de la operación → la operación queda confirmada |
| REVOKE-003 | PASS | `SELECT … FOR SHARE` sobre la membresía falla para `adex_api` con `42501`: PostgreSQL exige privilegio UPDATE. Además, las FK hacia `memberships` toman `FOR KEY SHARE`, que **no** bloquea un UPDATE de `status` |
| REVOKE-004 | PASS | **Alternativa:** bloqueo consultivo de transacción. La operación toma `pg_advisory_xact_lock_shared(hash(membresía))` y la revocación toma el exclusivo. (1) La revocación espera a la operación en curso y confirma después. (2) Una operación que empieza durante la revocación espera y, al continuar, ya ve la membresía inactiva |

| | |
|---|---|
| Escenario | Una operación ya superó todas sus sentencias cuando otra transacción confirma la desactivación |
| Duración | El viaje de red entre la última sentencia y el COMMIT: milisegundos con el servidor cerca, decenas por el pooler remoto |
| Consecuencia | Una operación autorizada por una membresía que se desactiva *en ese instante* queda confirmada. No hay pérdida de aislamiento entre empresas ni doble gasto: la operación es anterior a la revocación por pocos milisegundos |
| Alternativa técnica | El bloqueo consultivo de REVOKE-004. Es compatible con el pooler en modo transacción porque es local a la transacción, y no amplía privilegios de tabla. Exige que **todas** las vías de revocación lo tomen: desactivar la membresía y suspender la empresa (con otra clave por empresa). La otra opción, dar UPDATE sobre `memberships` a `adex_api` para usar `FOR SHARE`, amplía privilegios y no se recomienda |
| Prueba para la Fase 1 | REVOKE-004 contra la base gestionada y por el pooler, con todas las vías de revocación. Medir la espera de la revocación con operaciones lentas y fijar `lock_timeout` |

**No se declara revocación transaccional absoluta.** El servicio de la POC no cambió: el bloqueo consultivo solo existe en la prueba.

## 19. Corrección del conteo documental

- **Verificado otra vez** (`npm test`, 2026-10-13): 26 suites, 0 fallos.
- Totales impresos por cada suite: permisos 559 · financial 180 · bootstrap 159 · workercash 123 · platform 64 · migrations 62 · capitalcontrol 47 · basecash 45 · settlements 40 · paymentreversal 31 · paymentsync 31 · expenseclassification 31 · periodauthority 30 · capitalcustody 28 · workertransfer 22 · routebase 21 · supervisorbase 20 · adminexpense 19 · financialreversal 15 · expensecash 14 · disbursement 13 · activecredit 10 · transferops 10 · movementhistory 10 · interestrate 8 · adminpool 8 = **1.600**.
- `git diff 315099c HEAD -- src tests package.json package-lock.json` está vacío. La cifra 1.490 se escribió en `315099c` con el mismo código de pruebas, así que la diferencia es de suma en el documento, no de cobertura.
- **Corrección documental únicamente.** Cifras cambiadas de 1.490 a 1.600:
  - [AUDITORIA_PREPARACION_SAAS_2026-10.md](./AUDITORIA_PREPARACION_SAAS_2026-10.md): líneas 7 y 23;
  - [ARQUITECTURA_SAAS_PROPUESTA_2026-10.md](./ARQUITECTURA_SAAS_PROPUESTA_2026-10.md): líneas 19 y 83;
  - [PLAN_MIGRACION_SAAS_2026-10.md](./PLAN_MIGRACION_SAAS_2026-10.md): línea 92.
- No se tocaron tests, código ni resultados históricos. El informe de la Fase 0A conserva su anotación original.

## Registro de rechazos (§16 del encargo)

| Rechazo | Identidad verificada | Qué se puede registrar sin riesgo |
|---|---|---|
| Sin token, token mal formado, firma inválida, expirado, `iss`/`aud` ajenos | No | Fecha, ruta, método, código de motivo, IP truncada o con hash y `kid` de la cabecera. **Nunca** el token ni sus claims (no son de fiar) |
| Identidad no aprovisionada, membresía inexistente, ajena, inactiva o empresa suspendida | Sí (`sub`) | Lo anterior más `identity_id` verificado y el `membershipId` pedido (UUID validado) |
| Permiso denegado, recurso fuera del alcance o de otra empresa | Sí, con contexto | Lo anterior más empresa, membresía y rol activos y el recurso pedido |
| Inicio de sesión fallido | — | Ocurre en Supabase Auth, no en la API. Supabase lleva su propio registro de auditoría de Auth (retención según plan; no verificado) |

**Separación propuesta para la Fase 1:**
- `audit_log` sigue siendo **solo** financiero.
- Los eventos de seguridad van a una tabla aparte (por ejemplo `adex_sec.security_events`), append-only, en un esquema no expuesto. Se escribe por una única función `SECURITY DEFINER` con parámetros tipados.
- El evento se escribe en una **transacción propia, después del ROLLBACK** de la petición rechazada. Dentro de ella se perdería, que es justo la razón por la que hoy no se registra.
- Muestreo o límite por origen, para que un ataque no convierta el registro en amplificador.
- **Nunca se registran:** contraseñas, tokens de acceso o refresco, el encabezado `Authorization` ni cuerpos de petición.
- La retención es parte de DS-14.

No se implementó nada.

## Idempotencia y moneda (sin ampliar alcance)

- **Rechazos de negocio:** se mantiene el comportamiento experimental de que un rechazo por fondos se conserva bajo su `operationId` (MANAGED-FIN-002 lo repite). No es política definitiva para todos los comandos.
- **COP:**
  - la POC almacena unidades menores enteras según `currencies.minor_units` (COP = 2, ISO 4217). Esa es la **precisión de almacenamiento**;
  - la **presentación** (mostrar COP sin centavos) y el **redondeo comercial** son decisiones aparte, pendientes;
  - con 2 decimales técnicos se puede presentar sin centavos, sin perder exactitud, siempre que las reglas de redondeo se definan antes de aceptar importes con centavos;
  - CLEAN no cambia.

## 19 bis. Limitaciones

| # | Limitación |
|---|---|
| 1 | Nada se ejecutó contra Supabase: ni Auth, ni PostgreSQL gestionado, ni Data API, ni pooler |
| 2 | Las pruebas AUTH-REAL y MANAGED nunca se ejecutaron contra el servicio real. Pueden necesitar ajustes de detalle en la primera ejecución (códigos HTTP exactos, forma de las respuestas de la Management API). Cualquier ajuste se documentará y no se convertirá en un PASS forzado |
| 3 | El control de plan Free usa el campo `plan` de la organización en la Management API. Si el campo no existe, el arnés se bloquea (falla de forma segura) y hace falta la declaración del propietario |
| 4 | Sin el certificado del proyecto, la conexión va cifrada pero sin verificar el servidor; queda registrado en la evidencia |
| 5 | El ensayo local imita los roles de Supabase pero **no** es Supabase: no hay Supavisor, PostgREST, `pg_graphql`, extensiones ni los privilegios por defecto reales |
| 6 | La ventana residual de revocación (§18) sigue existiendo en el servicio de la POC |

## 20. Recursos consumidos · 21. Costos reales observados

- **Remotos:** ninguno. **Costo: 0.**
- **Locales:** clústeres efímeros de PostgreSQL en `tmp/` (borrados al terminar) y evidencia local, no versionada.
- **Previsto en el proyecto real:**
  - un proyecto Free;
  - menos de 1 MB de datos sintéticos;
  - unas 10 identidades sintéticas;
  - unas 30 peticiones a Auth y unas 300 transacciones cortas por ejecución.
- La pausa del plan Free tras una semana de inactividad no afecta a una prueba puntual.

## 22. Riesgos para la Fase 1

1. **DS-03 sin evidencia:** sigue sin probarse la emisión real de tokens, el algoritmo del proyecto y el comportamiento tras el logout.
2. **Revocación de sesión:** el access token vive hasta `exp`. En Free no hay sesiones acotadas. Hace falta decidir el control (a/b/c de §17) para operaciones financieras.
3. **Ventana de revocación de membresía:** se puede cerrar con un bloqueo consultivo (REVOKE-004), aún no probado por el pooler real.
4. **`postgres` y BYPASSRLS:** el modelo de sembrado y administración depende de un atributo que la documentación no confirma.
5. **Conexión directa solo IPv6:** la API dependerá del pooler (IPv4) o del complemento IPv4 de pago.
6. **Clave secreta (`sb_secret_`):** ignora RLS. Debe quedar fuera de la API financiera, como en la POC.
7. **Error de revocación engañoso** (`404` en vez de un motivo explícito), visto en REVOKE-001.

## 23. Recomendación respecto a DS-02 (técnica, no aprobada)

**Sin cambio respecto a la Fase 0A: candidato técnicamente apto, no validado en la plataforma.** La documentación vigente confirma tres condiciones necesarias para el diseño:

- pooler IPv4 en modo transacción en todos los planes;
- roles propios con login por el pooler;
- esquemas no expuestos por defecto.

Falta la evidencia: MANAGED-ROLE-001, MANAGED-RLS-001, MANAGED-DATAAPI-001 y MANAGED-FIN-001…005 en el proyecto real. No decidir DS-02 sin esas pruebas, la región (DS-13) y el presupuesto.

## 24. Recomendación respecto a DS-03 (técnica, no aprobada)

**No hay evidencia para decidir.** La documentación indica que Supabase Auth admite ES256 con JWKS público, que es lo que el diseño necesita. En contra:

- en Free no hay control de duración de sesión;
- el access token no se revoca antes de `exp`.

El diseño de ADEX no depende de claims de permisos: cambiar de proveedor afectaría solo a `src/auth/`. Recomendación: ejecutar AUTH-REAL-001…004 antes de decidir.

## 25. Decisiones todavía pendientes

| Tema | Pregunta para el propietario |
|---|---|
| **Desbloquear esta fase** | Crear el proyecto según §2.3 y preparar `.env.managed` |
| Verificación del plan | ¿Token personal temporal de la Management API o declaración del propietario? |
| DS-02 / DS-03 | Siguen como candidatos |
| DS-13 | Región y residencia de datos. São Paulo solo para la prueba |
| Sesión | ¿Tokens cortos, comprobación de `auth.sessions` o consulta a Auth en comandos financieros? |
| Revocación | ¿Se adopta el bloqueo consultivo en la Fase 1? |
| DS-14 | Registro de seguridad separado y retención |
| Idempotencia | ¿Un rechazo de negocio consume el `operationId` en todos los comandos? |
| COP | 0 o 2 decimales de presentación y reglas de redondeo |
| Fase 1 | **No se inicia** |

---

## J. Pruebas: PASS / FAIL / SKIP / BLOQUEADO

### J.1 Experimento local (PostgreSQL 17.9 real, `embedded-postgres`)

| Nivel | Resultado |
|---|---|
| `tsc` estricto | 0 errores |
| Unitarias | **22 PASS · 0 FAIL** |
| Integración (`npm run test:integration`) | **55 PASS · 0 FAIL · 4 SKIP**. Los 55 son las 49 de la Fase 0A más REVOKE-001…004 y 2 subpruebas. Los 4 SKIP son AUTH-REAL-001…004 |
| Concurrencia existente | FIN-001 (4 variantes), LOCK-001: PASS |

### J.2 Supabase real

| Batería | Estado |
|---|---|
| AUTH-REAL-001…004 | **BLOQUEADO** (`skipped`: sin proyecto ni credenciales) |
| MANAGED-ROLE-001, CONN-001, RLS-001, DATAAPI-001, FIN-001…005, ID-001 | **BLOQUEADO** (`skipped` fuera del arnés gestionado) |
| REVOKE-001…004 sobre la base gestionada | **BLOQUEADO** |

### J.3 Ensayo local del arnés gestionado (no es evidencia de Supabase)

`npm run test:managed:rehearse`:

- un PostgreSQL efímero con `postgres` sin superusuario (CREATEROLE, BYPASSRLS) y los roles `anon`, `authenticated`, `service_role` y `authenticator`;
- el esquema se prepara con el **mismo** código que el proyecto real ([`scripts/managed-schema.ts`](../experiments/saas-phase0a/scripts/managed-schema.ts));
- resultado: **34 PASS · 0 FAIL**. Se omite MANAGED-DATAAPI-001, que necesita la Data API real.

Sirvió para encontrar y corregir el defecto de `ALTER ROLE` (§12–14).

## K. Regresiones de ADEX

| Gate | Resultado |
|---|---|
| `npm test` | 26 suites, **1.600 casos, 0 fallos**, exit 0 |
| `npx tsc --noEmit` | 0 errores |
| `npm run build` | Correcto. Bundle **`index-b05G8Ybt.js`**, igual que la línea base |
| `npm run verify:deploy -- https://rutacash-clean.vercel.app` | 81 OK, 0 fallos. Producción sirve `/assets/index-b05G8Ybt.js` |
| `src/`, `tests/`, `package.json`, `package-lock.json` de la aplicación | Sin cambios |

## L. Secretos y seguridad

- No existe ninguna credencial de Supabase en el equipo ni en el repositorio. Nada se filtró y no hay nada que rotar.
- **Guardado:** `.env.managed` (y cualquier `.env.*`, `*.crt` o `*.pem`) queda ignorado por Git. Solo se versiona `.env.example`, con nombres y sin valores.
- **Uso de las claves:**
  - la contraseña de `adex_api` se genera en cada ejecución y no se guarda;
  - la clave secreta solo crea y borra usuarios sintéticos y nunca llega a la API;
  - la API no usa `postgres` ni `service_role`.
- **Redacción de la evidencia:** se sustituyen los valores de los secretos, cualquier JWT, las claves `sb_secret_`/`sb_publishable_`, los tokens `sbp_` y las URL de conexión.
- **Usuarios de prueba:** son `@example.test`, se borran al terminar cada archivo y `--teardown` borra los que queden.

## O. Archivos modificados

| Archivo | Cambio |
|---|---|
| `docs/SAAS_FASE_0A1_RESULTADOS.md` | Nuevo (este informe) |
| `docs/AUDITORIA_PREPARACION_SAAS_2026-10.md`, `docs/ARQUITECTURA_SAAS_PROPUESTA_2026-10.md`, `docs/PLAN_MIGRACION_SAAS_2026-10.md` | Solo la cifra 1.490 → 1.600 (§19) |
| `experiments/saas-phase0a/scripts/run-managed.ts`, `managed-schema.ts`, `rehearse-managed.ts` | Nuevos: arnés gestionado, preparación compartida, ensayo |
| `experiments/saas-phase0a/test/managed/managed.test.ts` | Nueva batería gestionada |
| `experiments/saas-phase0a/test/integration/revocation.test.ts` | Nuevas REVOKE-001…004 |
| `experiments/saas-phase0a/test/auth-real/supabase-auth.test.ts` | AUTH-REAL-001…004 ampliadas (mismos IDs, sin mocks) |
| `experiments/saas-phase0a/test/helpers/db.ts` | Modo gestionado y TLS |
| `experiments/saas-phase0a/src/auth/supabaseJwt.ts` | Opción `now` (reloj de verificación, solo pruebas) |
| `experiments/saas-phase0a/package.json`, `.gitignore`, `.env.example`, `README.md` | Scripts `test:managed` y `test:managed:rehearse`; exclusiones; nombres de variables; uso |

Ningún cambio en la aplicación ADEX, en servicios financieros, en roles de CLEAN ni en el Owner.

## P. Commit y publicación

**Commit de preparación parcial, aprobado expresamente por el propietario:** `test(architecture): prepare managed Supabase validation`.

- **No declara completada la validación de Supabase.** Las pruebas contra Supabase real siguen **BLOQUEADAS / NO EJECUTADAS** (§J.2).
- **Contenido:**
  - `experiments/saas-phase0a/` (sin `node_modules` ni `.env.managed`);
  - este informe;
  - las tres correcciones del conteo de pruebas.
- **Fuera del commit:** los archivos ajenos de §1.
- **Push a `main`:** dispara un despliegue en Vercel; el bundle no cambia (`index-b05G8Ybt.js`) y se comprueba con `verify:deploy`.
- **Siguiente paso:** cuando exista el proyecto, la ejecución real tendrá su propio commit, `test(architecture): verify managed Supabase Auth and RLS`.
