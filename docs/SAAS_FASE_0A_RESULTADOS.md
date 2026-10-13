# ADEX Soluciones — Fase 0A: resultados de la POC de arquitectura, identidad y transacciones

| | |
|---|---|
| Fecha | 2026-10-13 · `main` @ `315099c` |
| Tipo | Prueba técnica de concepto, **experimental y descartable**, con datos 100 % sintéticos |
| Código | [`experiments/saas-phase0a/`](../experiments/saas-phase0a/) (fuera de la aplicación publicada) |
| Veredicto | **Parcialmente validada.** 12 de los 13 criterios de cierre quedan demostrados con PostgreSQL real. El criterio 1 (Supabase Auth real) **no se ejecutó**: el equipo no tiene Docker y no hay autorización para un proyecto remoto |
| Decisiones | Nada de este informe aprueba un proveedor ni inicia la Fase 1. Las recomendaciones son técnicas y esperan decisión del propietario |

Documentos de entrada: [Auditoría](./AUDITORIA_PREPARACION_SAAS_2026-10.md) · [Invariantes](./INVARIANTES_FINANCIERAS_2026-10.md) · [Riesgos](./RIESGOS_CONCURRENCIA_SAAS_2026-10.md) · [Arquitectura](./ARQUITECTURA_SAAS_PROPUESTA_2026-10.md) · [Plan](./PLAN_MIGRACION_SAAS_2026-10.md) · [Decisiones pendientes](./DECISIONES_PENDIENTES_SAAS_2026-10.md) · [Plano de control](./CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md).

---

## Resumen

| Criterio de cierre | Estado | Evidencia |
|---|---|---|
| 1. Supabase Auth autentica una identidad única | **NO EJECUTADO** | `AUTH-REAL-001…004` preparados; quedan `skipped` sin credenciales |
| 2. Una identidad con varias membresías | Validado | ID-001 |
| 3. La API autoriza una sola membresía activa | Validado | ID-002, ID-006, TENANT-005 |
| 4. Sin acumulación de permisos | Validado | ID-003, ID-006 |
| 5. Membresía desactivada no opera (mismo token) | Validado | ID-004, TENANT-004 |
| 6. Acceso entre empresas bloqueado | Validado | TENANT-001…003, TENANT-005, FIN-006 |
| 7. PostgreSQL como segunda barrera (RLS) | Validado | TENANT-004 y mutación 2 (§H.3) |
| 8. Un saldo no se consume dos veces | Validado | FIN-001 (4 variantes) y mutación 1 (§H.3) |
| 9. La idempotencia evita duplicados | Validado | FIN-002, FIN-003 |
| 10. Movimiento y auditoría atómicos | Validado | FIN-004, FIN-005 |
| 11. El esquema admite Brasil y Colombia | Validado | INTL-001…003 |
| 12. CLEAN no cambia | Validado | §I: 26 suites en verde, mismo bundle `index-b05G8Ybt.js` en build y en producción |
| 13. Todo respaldado por pruebas ejecutadas | Validado salvo el criterio 1 | §H |

**Importante:** la autorización por membresía (criterios 2–6) se probó con tokens de un **emisor local** que reproduce el formato de Supabase Auth (ES256, JWKS, claims `sub`, `role`, `aud`, `iss`, `session_id`). Prueba que la API verifica tokens con ese formato y autoriza contra PostgreSQL. **No prueba Supabase Auth.**

---

## A. Estado inicial

| | |
|---|---|
| Rama | `main` |
| HEAD | `315099c29dc9bc7fe572e7151293565f23dfe606` |
| `origin/main` | `315099c…` (igual a HEAD tras `git fetch`) |
| Working tree | Solo archivos ajenos a esta fase |
| Archivos ajenos (no se tocan ni se incluyen) | `D docs/ENTREGABLE_SOCIO_OFICINAS_RUTACASH_2026-09.html` · `?? .impeccable/` · `?? docs/OFICINAS_RUTACASH_2026-09.html` |

## B. Infraestructura experimental

### B.1 Herramientas disponibles

| Herramienta | Estado |
|---|---|
| Node.js | v24.15.0 (ejecuta TypeScript de forma nativa) |
| npm | 11.12.1 |
| Docker | **No instalado** |
| Supabase CLI | **No instalada** (y `supabase start` necesita Docker) |
| PostgreSQL / `psql` | **No instalado** |
| WSL | Sin distribuciones instaladas |
| Usuario | Sin privilegios de administrador |

### B.2 Decisión de entorno

- **Supabase local no puede iniciarse.** Impedimento exacto: Supabase local (`supabase start`) levanta contenedores Docker; Docker no está instalado. Instalar Docker Desktop es un programa global y no se autorizó. Crear un proyecto remoto tampoco se autorizó.
- **PostgreSQL real sin instalación global:** el paquete npm `embedded-postgres@17.9.0-beta.17` trae los binarios oficiales de PostgreSQL para Windows dentro de `node_modules`. El arnés crea un clúster efímero en `tmp/saas-phase0a/` (puerto libre aleatorio, contraseñas aleatorias), lo usa y lo borra. No crea servicios de Windows ni toca la configuración del equipo.
  - Servidor probado: `PostgreSQL 17.9 on x86_64-windows, compiled by msvc-19.44.35222, 64-bit`.
  - Es PostgreSQL estándar, **no la imagen de Supabase** (sin sus extensiones, roles predefinidos, Supavisor ni PostgREST). Ver §K.
- **Supabase Auth:** sin Docker ni proyecto, no hay servidor de Auth. Las pruebas reales quedan escritas y marcadas como `skipped`. No se sustituyen por simulaciones.

### B.3 Versiones de las dependencias (exactas, solo en el experimento)

| Paquete | Versión | Uso |
|---|---|---|
| `pg` | 8.23.0 | Driver PostgreSQL |
| `jose` | 6.2.12 | Verificación JWT/JWKS |
| `embedded-postgres` · `@embedded-postgres/windows-x64` | 17.9.0-beta.17 | Binarios de PostgreSQL 17.9 (desarrollo) |
| `typescript` | 6.0.3 | Comprobación de tipos (desarrollo) |
| `@types/pg` · `@types/node` | 8.23.0 · 24.12.0 | Tipos (desarrollo) |

Sin framework HTTP (`node:http`) y sin `supabase-js`: las pruebas de Auth real usan la API REST oficial de Supabase Auth con `fetch`. La aplicación ADEX no gana ni pierde dependencias: su `package.json` y su `package-lock.json` no cambian.

## C. Identidad y membresías

### C.1 Esquema mínimo ([`sql/001_schema.sql`](../experiments/saas-phase0a/sql/001_schema.sql))

| Tabla | Contenido | Garantías |
|---|---|---|
| `currencies` | Código ISO 4217 y decimales (0–4) | Catálogo; sin tasas ni conversión |
| `companies` | Nombre, país (ISO 3166-1 alfa-2), moneda, zona horaria IANA, estado `active/suspended` | `CHECK` de formato de país; zona validada contra `pg_timezone_names`; FK a moneda |
| `identities` | `id` = `sub` del token (en Supabase, `auth.users.id`), correo | Una fila por persona |
| `routes` | Rutas por empresa (solo para el alcance) | `unique (company_id, id)` |
| `memberships` | Identidad, empresa, rol, estado `active/inactive`, alcance `company/routes` | `unique (identity_id, company_id, role)`; varias por identidad |
| `membership_routes` | Rutas del alcance | FK compuestas: no se puede asignar una ruta de otra empresa |
| `accounts` | Libro **sintético**: saldo en unidades menores | `balance_minor bigint check (>= 0)` |
| `operations` | Idempotencia por `(empresa, operationId)`: huella de parámetros, resultado y estado HTTP | PK compuesta |
| `movements` | Movimiento efectivo | Un movimiento por operación (`unique`); FK compuestas a cuenta, operación y membresía de la **misma** empresa; `txid` |
| `audit_log` | Identidad, empresa, **membresía y rol actuantes**, acción, resultado, detalle | FK compuesta a membresía de la misma empresa; `txid` |

`movements` y `audit_log` son **append-only**: el rol de la API no tiene `UPDATE` ni `DELETE`, y un disparador rechaza cualquier modificación incluso del superusuario.

### C.2 Modelo de identidad (DS-05)

- **Una identidad por persona:** el `sub` verificado del token. El cliente nunca la declara.
- **Varias membresías independientes:** en los datos de prueba, Ana es *admin* en Brasil (toda la empresa), *cobradora* en Brasil (solo ruta BR-1) y *supervisora* en Colombia.
- **Contexto activo explícito:** cada petición lleva `X-Adex-Membership: <id>`. Una sola membresía; dos identificadores en el mismo encabezado se rechazan (`INVALID_MEMBERSHIP_ID`).
- **Sin herencia:** la función de permisos recibe **una** membresía. No existe ningún camino de código que una permisos de varias.
- **Auditoría:** cada asiento guarda identidad, empresa, membresía y rol con que se actuó (comprobado en ID-003).

Los roles `admin`, `supervisor` y `cobrador` y su matriz son **experimentales** ([`src/authz/permissions.ts`](../experiments/saas-phase0a/src/authz/permissions.ts)). No reflejan ni modifican los roles de CLEAN.

## D. Autorización y aislamiento

Flujo de cada petición ([`src/http/server.ts`](../experiments/saas-phase0a/src/http/server.ts), [`src/authz/context.ts`](../experiments/saas-phase0a/src/authz/context.ts)):

1. `Authorization: Bearer <token>`. Sin token → 401, incluso en rutas desconocidas.
2. Verificación local del token ([`src/auth/supabaseJwt.ts`](../experiments/saas-phase0a/src/auth/supabaseJwt.ts)):
   - firma con la clave pública del JWKS (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`), algoritmos ES256/RS256;
   - `iss`, `aud = authenticated`, `exp`, `iat`;
   - `role = authenticated` (se rechazan `anon` y `service_role`);
   - `sub` con formato UUID.
   - HS256 (clave legada de Supabase) solo si se configura el secreto; si no, se rechaza (evita la confusión de algoritmos). `alg: none` se rechaza.
3. Se abre **una transacción**. Dentro de ella:
   - se fija el contexto de RLS con `set_config(..., true)` (local a la transacción);
   - se comprueba que la identidad está aprovisionada;
   - se lee la membresía elegida (RLS solo deja ver las de esa identidad);
   - se comprueba que la membresía y la empresa están activas;
   - empresa, rol, alcance, moneda y zona horaria **salen de PostgreSQL**.
4. Se aplican los permisos de esa membresía y se ejecuta la operación en la misma transacción.

**El cliente no tiene autoridad:**
- los encabezados inventados (`x-adex-role`, `x-adex-company`) y los parámetros de consulta (`?companyId=`) se ignoran;
- un campo desconocido en el cuerpo (`companyId`, `role`, `membershipId`, `routeIds`) se rechaza con `UNKNOWN_FIELD`;
- una cuenta de otra empresa o fuera del alcance responde 404: no se revela su existencia.

### D.1 Revocación de membresía frente a revocación de sesión

| | Revocación de membresía (probada) | Revocación de sesión de Supabase Auth (no probada) |
|---|---|---|
| Qué cambia | `memberships.status = 'inactive'` (o empresa `suspended`) en PostgreSQL | La sesión y los *refresh tokens* en Supabase Auth (cierre de sesión, baja del usuario) |
| Efecto en la API | La **siguiente** petición con el mismo token se rechaza (`MEMBERSHIP_INACTIVE` / `COMPANY_SUSPENDED`); RLS tampoco devuelve filas | El token de acceso ya emitido **sigue verificando** con la clave pública hasta su `exp`. Solo deja de renovarse |
| Latencia | Inmediata para transacciones que empiezan después del cambio confirmado | Hasta la expiración del token (1 h por defecto en Supabase, configurable) |
| Cómo cerrarla | — | Tokens cortos; o consultar `/auth/v1/user` en operaciones sensibles (coste: una llamada de red); o una lista de sesiones revocadas en PostgreSQL |

Por eso la autoridad de permisos es la membresía en la base y **nunca** un claim del token. AUTH-REAL-003 está preparado para demostrar esta diferencia con Supabase real.

Ventana residual: una operación cuya transacción ya leyó la membresía antes de que se confirme la desactivación puede terminar. RLS vuelve a comprobar la membresía en **cada sentencia**, así que la ventana queda entre la última sentencia y el `COMMIT`. Ver §K.

## E. RLS ([`sql/002_rls.sql`](../experiments/saas-phase0a/sql/002_rls.sql))

- **Roles:**
  - `adex_owner` es propietario del esquema;
  - `adex_api` es el rol con que se conecta la API.
  - Ninguno es superusuario ni tiene `BYPASSRLS`. `adex_api` no es propietario de ninguna tabla y tiene privilegios mínimos por columna: solo actualiza `balance_minor`/`updated_at` y el resultado de la operación.
- **`ENABLE` + `FORCE ROW LEVEL SECURITY` en las 10 tablas:** el propietario también queda sujeto. Comprobado: el catálogo de monedas no se pudo sembrar como propietario y se siembra como superusuario del arnés.
- **Contexto:** `adex.identity_id`, `adex.membership_id` y `adex.company_id` mediante `set_config(..., true)`. Es local a la transacción, así que es compatible con un pooler en modo transacción.
- **Validez del contexto** (`ctx_membership_active()`): la membresía es de esa identidad, de esa empresa, está activa y la empresa está activa. Una empresa «forzada» en el contexto sin membresía válida no ve nada.
- **Alcance por rutas también en RLS** (`ctx_route_allowed`): una cobradora de BR-1 no ve ni actualiza la caja de BR-2 aunque la API fallara.
- **Inserciones:**
  - `WITH CHECK` exige empresa, identidad y membresía del contexto en `operations`, `movements` y `audit_log`;
  - no se puede fabricar un asiento a nombre de otra membresía ni de otra empresa.
- **Sin recursión:** `companies` consulta `memberships`, y `memberships` solo usa la identidad.

## F. Transacciones PostgreSQL

Comando de retiro o depósito ([`src/ledger/service.ts`](../experiments/saas-phase0a/src/ledger/service.ts)). Todo ocurre en **una transacción `READ COMMITTED`** con este orden fijo:

1. Permiso del rol de la membresía activa.
2. Reclamar la clave de idempotencia: `INSERT … ON CONFLICT DO NOTHING` en `operations`. Un duplicado concurrente **espera** en el índice único hasta que la primera transacción confirme o revierta.
3. `SELECT … FOR UPDATE` de la fila de saldo. La segunda petición espera el bloqueo y después lee el saldo **ya actualizado**.
4. Regla de negocio: saldo suficiente.
5. `UPDATE` del saldo → `INSERT` del movimiento → `INSERT` de la auditoría → resultado en `operations`.

**Bloqueos y deadlocks:**
- Todos los comandos bloquean en el mismo orden (clave de idempotencia → fila de saldo), así que dos comandos de una cuenta no pueden interbloquearse.
- Para comandos de varias filas (futuras transferencias) la regla es bloquear en **orden determinista** (empresa → bolsa → ruta → trabajador → venta; dentro de cada nivel, por id).
- `withTransaction` ([`src/db/tx.ts`](../experiments/saas-phase0a/src/db/tx.ts)) reintenta la transacción **completa** ante `40P01` (deadlock) y `40001` (serialización), con un máximo de 3 intentos y espera aleatoria. Es seguro porque la transacción abortada no dejó nada escrito.
- LOCK-001 lo demuestra: dos transacciones en orden opuesto producen el deadlock, PostgreSQL lo detecta (`deadlock_timeout` 200 ms en la prueba), una se reintenta y cada efecto se aplica exactamente una vez. En orden determinista no hay deadlock ni reintentos.

**Por qué `FOR UPDATE` y no `SERIALIZABLE`:**
- el bloqueo pesimista de la fila de saldo hace que la segunda petición espere y responda con la regla de negocio (saldo insuficiente), en vez de abortar con error de serialización;
- `SERIALIZABLE` sigue siendo una opción con reintento, y `withTransaction` ya lo soporta.

**Resultados de concurrencia (FIN-001), siempre con conexiones independientes a PostgreSQL real:**

| Variante | Resultado |
|---|---|
| 2 peticiones HTTP simultáneas (Ana *admin* y Eva *cobradora*), 4.000 cada una sobre 5.000, **10 rondas** | En las 10: una 201 y una 422 `INSUFFICIENT_FUNDS`; saldo final 1.000,00; un único movimiento (400000 → 100000); una auditoría aprobada y una rechazada |
| Intercalado determinista: A se pausa con la fila bloqueada | `pg_stat_activity` muestra a B en `wait_event_type = 'Lock'` sobre el `FOR UPDATE`. Al liberar A, B responde 422 con saldo 1.000,00. Dos backends distintos (`pg_backend_pid`) |
| Estrés: 20 retiros simultáneos de 400 sobre 5.000 | 12 aprobados, 8 rechazados, saldo final 200,00 = 5.000 − Σ movimientos (4.800) |
| Control negativo: la misma carrera **sin** `FOR UPDATE` (código solo de prueba) | Dos retiros de 4.000 aprobados sobre 5.000 y saldo final 1.000 (actualización perdida). La prueba sabe distinguir el error real |

## G. Idempotencia y auditoría

| Prueba | Resultado |
|---|---|
| FIN-002 secuencial | Mismo `operationId` dos veces: segunda respuesta 201 `replayed: true` con el mismo `movementId` y saldo; 1 movimiento, 1 auditoría, 1 operación |
| FIN-002 rechazo registrado | Retiro de 2.000 sin saldo → 422. Se deposita después y se repite el mismo `operationId` → sigue 422 `replayed`, sin escrituras nuevas |
| FIN-002 concurrente | 5 copias simultáneas de la misma operación → 5 respuestas 201, un solo `movementId`, 4 `replayed`, 1 movimiento |
| FIN-003 colisión | Mismo `operationId` con otro importe, otra cuenta, otro tipo u otra membresía → 409 `IDEMPOTENCY_KEY_REUSED`; saldos y recuentos intactos |
| FIN-004 rollback | Fallo inyectado tras el `UPDATE` del saldo (y en otra variante tras el `INSERT` del movimiento). Dentro de la transacción el saldo **sí** había cambiado (3.500,00); después del fallo vuelve a 5.000,00, con 0 movimientos, 0 auditorías y 0 operaciones. La clave no queda consumida: el reintento con el mismo `operationId` funciona |
| FIN-005 fallo real de la auditoría | Una restricción temporal hace fallar el `INSERT` de la auditoría en PostgreSQL → 500; ni saldo, ni movimiento, ni operación |
| FIN-005 coherencia global | Cada movimiento de la base tiene **exactamente una** auditoría aprobada con el mismo `txid`, membresía, identidad y rol (excluidos los del control negativo) |
| FIN-005 append-only | El propietario no alcanza filas (FORCE RLS sin política de UPDATE/DELETE); el superusuario es rechazado por el disparador (`42501`) |
| FIN-006 libros aislados | El mismo `operationId` en BR y CO son dos operaciones independientes (clave por empresa). Retirar de la caja de CO con contexto BR → 404 y saldo intacto. Bajo RLS el contexto CO solo ve movimientos y auditoría de CO |

**Decisión de diseño de la POC, pendiente de validar:**
- un **rechazo de negocio** (saldo insuficiente) se registra con su `operationId` y se devuelve igual en cada reintento;
- los errores de validación, autorización o técnicos **no** consumen la clave.
- El cliente debe generar un `operationId` nuevo para un intento nuevo.

## H. Resultados de pruebas

Ejecución final: 2026-10-13, en este equipo (Windows 11, Node 24.15.0, PostgreSQL 17.9). Las salidas completas quedan en `tmp/saas-phase0a/evidence/` (local, no versionado); la misma batería se reproduce con `npm test` (§16).

### H.1 Por nivel de evidencia

| Nivel | Qué ejercita | Archivo | Resultado |
|---|---|---|---|
| Comprobación de tipos | `tsc` estricto sobre `src`, `scripts`, `test` | `tsconfig.json` | 0 errores |
| **Unitarias** (sin servicios) | Dinero exacto, matriz de permisos, verificación JWT con emisor local y JWKS remoto local | `test/unit/*` | **22 PASS · 0 FAIL** |
| **Integración PostgreSQL real** (`[pg]`, `[pg-rls]`, `[pg+api]`) | API HTTP real + PostgreSQL 17.9 real, rol sin privilegios, conexiones independientes. Tokens del **emisor local** | `test/integration/*` | **49 PASS · 0 FAIL** (pruebas y subpruebas) en 18,7 s |
| **Supabase Auth real** (`[supabase-auth]`) | Registro, inicio de sesión, `sub` estable, cierre de sesión y extremo a extremo con PostgreSQL | `test/auth-real/*` | **4 NO EJECUTADAS** (`skipped`: faltan `SUPABASE_URL`, claves) |

### H.2 Por identificador

| ID | Nivel | Estado |
|---|---|---|
| ID-001 identidad con múltiples membresías | pg+api | PASS |
| ID-002 selección de contexto | pg+api | PASS |
| ID-003 permisos independientes | unit + pg+api | PASS |
| ID-004 membresía desactivada (mismo token; también empresa suspendida y reactivación) | pg+api | PASS |
| ID-005 token inválido (firma ajena, expirado, emisor, audiencia, `anon`, `service_role`, `sub` no UUID, `alg none`, HS256 sin secreto, basura, Basic; identidad no aprovisionada; identidad sin membresías) | unit + pg+api | PASS |
| ID-006 sin herencia entre roles | unit + pg+api | PASS |
| TENANT-001 lectura autorizada | pg+api | PASS |
| TENANT-002 lectura entre empresas rechazada | pg+api | PASS |
| TENANT-003 escritura entre empresas rechazada sin efectos | pg+api | PASS |
| TENANT-004 RLS bajo rol no privilegiado (8 subpruebas) | pg-rls | PASS |
| TENANT-005 manipulación de contexto | pg+api | PASS |
| FIN-001 doble retiro concurrente (4 variantes) | pg+api | PASS |
| FIN-002 reintento con `operationId` (3 variantes) | pg+api | PASS |
| FIN-003 colisión de identificador | pg+api | PASS |
| FIN-004 rollback provocado (2 puntos de fallo) | pg+api | PASS |
| FIN-005 auditoría atómica (3 subpruebas) | pg+api | PASS |
| FIN-006 aislamiento de libros | pg+api | PASS |
| LOCK-001 (complementaria) deadlock y reintento | pg | PASS |
| INTL-001 BR/BRL/America/Sao_Paulo | pg+api | PASS |
| INTL-002 CO/COP/America/Bogota | pg+api | PASS |
| INTL-001/002 fecha contable por zona; validación de país, moneda y zona | pg | PASS |
| INTL-003 importes exactos (unidades menores, sin float, > 2^53, desbordamiento, 0 y 4 decimales) | unit + pg+api | PASS |
| AUTH-REAL-001 identidad única con Supabase Auth | supabase-auth | **NO EJECUTADA** |
| AUTH-REAL-002 credenciales erróneas | supabase-auth | **NO EJECUTADA** |
| AUTH-REAL-003 cierre de sesión frente a verificación local | supabase-auth | **NO EJECUTADA** |
| AUTH-REAL-004 token real → API → membresía → revocación | supabase-auth+pg+api | **NO EJECUTADA** |

### H.3 Las pruebas detectan los fallos que dicen detectar (mutaciones)

Se introdujeron dos defectos de forma temporal, se ejecutaron las pruebas y se restauró el código. La restauración se comprobó con `diff`.

| Mutación | Resultado |
|---|---|
| 1. Quitar `FOR UPDATE` del comando | FIN-001: las 3 variantes con bloqueo **fallan**; el control negativo sigue mostrando el doble gasto. FIN-002…006 siguen en verde |
| 2. Debilitar la política `accounts_read` a `using (true)` | TENANT-004: **fallan** 5 subpruebas (sin contexto, contexto BR, contexto falsificado, alcance por rutas, membresía inactiva). TENANT-001/002/003/005 (vía API) **siguen en verde**: la barrera de la API funciona sola y la de RLS también. Son independientes |

Durante esta verificación aparecieron dos defectos del propio arnés, ya corregidos:
- una prueba en pausa no se liberaba si fallaba una aserción;
- los pools quedaban abiertos si el desmontaje fallaba.

Ahora el arnés libera siempre, usa `allowExitOnIdle` y `--test-timeout`, y detiene PostgreSQL ante `SIGINT`/`SIGTERM`.

## I. Regresiones de ADEX

| Gate | Resultado |
|---|---|
| `npm test` | **26 suites en verde, 0 fallos, exit 0.** Totales que imprime cada suite: permisos 559 · financial 180 · bootstrap 159 · workercash 123 · platform 64 · migrations 62 · capitalcontrol 47 · basecash 45 · settlements 40 · paymentreversal 31 · paymentsync 31 · expenseclassification 31 · periodauthority 30 · capitalcustody 28 · workertransfer 22 · routebase 21 · supervisorbase 20 · adminexpense 19 · financialreversal 15 · expensecash 14 · disbursement 13 · activecredit 10 · transferops 10 · movementhistory 10 · interestrate 8 · adminpool 8 = **1.600 casos** |
| `npx tsc --noEmit` | 0 errores |
| `npm run build` | Correcto. Bundle **`index-b05G8Ybt.js`**, idéntico al de la línea base |
| `npm run verify:deploy -- https://rutacash-clean.vercel.app` | 81 marcadores OK, 0 fallos. Producción sirve `/assets/index-b05G8Ybt.js` |
| Tests existentes | Sin modificar |

**Discrepancia con la línea base:**
- la línea base documentada dice «1.490 casos», pero los totales que imprimen las propias suites suman **1.600**;
- `src/`, `tests/`, `package.json` y `package-lock.json` no tienen ningún cambio respecto de `315099c`, así que la diferencia está en el conteo documentado anteriormente, no en el código;
- no se corrigen aquí los documentos de la Ronda 6D: se deja anotado para que el propietario decida.

## J. Cambios realizados

- **Añadido** `experiments/saas-phase0a/` (código, SQL, pruebas, `package.json` y `package-lock.json` propios, `README.md`, `.gitignore`, `.npmrc`).
- **Añadido** este informe.
- **Sin cambios** en:
  - `src/`, `tests/`, `scripts/`, `package.json`, `package-lock.json`, `tsconfig*.json`, `vite.config.ts` y `vercel.json`;
  - las 28 tablas Dexie;
  - los servicios financieros, D7 y D24–D30, y los roles de CLEAN.
- **Sin datos reales:** ni usuarios, ni contraseñas, ni cartera, ni movimientos.
- **Nada desplegado:** ni proyectos remotos, ni infraestructura contratada, ni secretos.
- La aplicación no importa nada del experimento. `tsconfig.json` raíz incluye solo `src`, y Vite construye desde `index.html`. El hash del bundle no cambió.

## K. Riesgos y limitaciones

| # | Limitación | Consecuencia |
|---|---|---|
| 1 | **Supabase Auth no se ejecutó** | El criterio 1 sigue abierto. La verificación del formato de token está probada con un emisor local; falta comprobarla contra el emisor real (claves de firma, `iss` exacto, expiración, cierre de sesión) |
| 2 | PostgreSQL estándar en Windows, no la plataforma Supabase | No se probaron: Supavisor (pooler), la red de Supabase (conexión directa solo IPv6 salvo complemento IPv4), los roles predefinidos (`anon`, `authenticated`, `service_role`), PostgREST, ni la creación de roles propios (`adex_api`) dentro de un proyecto Supabase |
| 3 | La Data API de Supabase expone por defecto el esquema `public` | La POC usa el esquema `adex`, sin privilegios para `public`. En Supabase habría que mantenerlo **fuera** de los esquemas expuestos y revocar todo a `anon`/`authenticated`, o los clientes podrían leer o escribir saltándose la API |
| 4 | Comandos de **una** fila de saldo | Los comandos reales (desembolso, transferencia) bloquean varias filas. El orden determinista y el reintento solo se demostraron en LOCK-001 |
| 5 | Ventana entre la desactivación de una membresía y el `COMMIT` de una transacción ya en curso | Acotada a la última sentencia (RLS revalida por sentencia). Si se exige más, bloquear la membresía con `FOR SHARE` (requiere privilegio adicional) |
| 6 | Los intentos rechazados sin contexto válido (token inválido, membresía ajena) no se auditan | RLS impide escribirlos en `audit_log`. Haría falta un registro de seguridad separado |
| 7 | Los puntos de inyección de fallos (`LedgerHooks`) viven en el código del servicio | La API de producción no los configura, pero es superficie de código. En la Fase 1, inyección por pruebas o por base |
| 8 | COP se registró con 2 decimales (ISO 4217) | Operativamente en Colombia se trabaja sin centavos. Es una decisión de presentación y de redondeo pendiente; el modelo admite 0–4 |
| 9 | Carga limitada (20 peticiones simultáneas) | No hay medición de rendimiento, tamaño de pool ni latencia entre regiones |
| 10 | `embedded-postgres` es un empaquetado beta | Útil solo para pruebas locales; no es una opción de despliegue |

## L. Costos y requisitos futuros

**Observado en esta fase:**
- Costo monetario 0: nada remoto ni contratado.
- Disco: ~128 MB en `node_modules` del experimento (~100 MB son los binarios de PostgreSQL), fuera de Git.
- Tiempo: arranque del clúster ~6–8 s; batería de integración completa ~19 s. Memoria no medida.

**No verificado, para la decisión DS-02:**
- **Precios vigentes de Supabase:**
  - el plan gratuito pausa proyectos inactivos y no es apto para producción;
  - copias con PITR, el complemento IPv4 y la capacidad de cómputo se cobran aparte.
  - Hay que consultar las tarifas oficiales y el presupuesto del propietario.
- **Región y residencia (DS-13):** Supabase ofrece São Paulo (`sa-east-1`); no hay región en Colombia. La latencia Bogotá–São Paulo y las obligaciones LGPD y colombianas siguen sin evaluar.

**Para ejecutar los criterios pendientes hace falta una autorización del propietario**, una de estas dos:
- **(a)** instalar Docker Desktop en el equipo de desarrollo y usar `supabase start` (local, sin costo, pero es un programa global); o
- **(b)** crear un proyecto Supabase gratuito **solo con datos sintéticos** y entregar las claves por variables de entorno.

Con cualquiera de las dos, `npm run test:integration` ejecuta AUTH-REAL-001…004 sin cambiar código.

## M. Commit y estado remoto

- Commit independiente: `test(architecture): validate SaaS identity and transactional API`.
- Contenido: solo `experiments/saas-phase0a/` (sin `node_modules`) y este informe. Los archivos ajenos de §A quedan fuera.
- Tras el push: verificar `origin/main = HEAD` y que producción CLEAN sigue sirviendo `index-b05G8Ybt.js`. La API experimental no se despliega.

## N. Recomendación de arquitectura (técnica, no aprobada)

1. **La arquitectura aprobada (DS-01) se sostiene con evidencia:**
   - API TypeScript con comandos transaccionales;
   - PostgreSQL como fuente de verdad;
   - `FOR UPDATE` con orden de bloqueo fijo;
   - idempotencia por `(empresa, operationId)` dentro de la misma transacción;
   - auditoría en la misma transacción y RLS como segunda barrera.
   - El patrón resolvió el escenario 5.000 − 4.000 − 4.000 de forma determinista y bajo estrés, y la mutación 1 prueba que sin el bloqueo falla.
2. **Supabase PostgreSQL es técnicamente apto como candidato (DS-02)**, en el sentido de que todo lo usado es PostgreSQL estándar:
   - RLS forzada, `set_config` local y roles propios;
   - no se usó nada propietario, así que el proveedor sigue siendo sustituible.
   - Condiciones si se elige:
     - esquema fuera de la Data API;
     - rol propio sin `BYPASSRLS` para la API;
     - conexión por el pooler en modo transacción (compatible con el contexto local a la transacción);
     - verificar en una prueba equivalente sobre la plataforma real (limitación 2).
3. **Supabase Auth (DS-03): sin evidencia propia todavía.**
   - El diseño ya no depende de claims de permisos: solo usa `sub` y la membresía en PostgreSQL. Cambiar de proveedor de identidad afectaría únicamente a `src/auth/`.
   - Recomendación: no decidir DS-03 hasta ejecutar AUTH-REAL-001…004 (§L).
   - Si se elige, usar **claves de firma asimétricas** (JWKS) y no la clave HS256 compartida.
4. **No poner permisos en el token** (por ejemplo, con *custom access token hooks*): quedarían obsoletos hasta `exp`. La revocación de membresía solo es inmediata porque se relee en la base.

## O. Decisiones pendientes

| Tema | Pregunta para el propietario |
|---|---|
| Ejecutar el criterio 1 | ¿Se autoriza Docker Desktop local **o** un proyecto Supabase gratuito con datos sintéticos? |
| DS-02 | Proveedor, región y presupuesto de PostgreSQL. Esta fase solo muestra que Supabase PostgreSQL es apto técnicamente |
| DS-03 | Proveedor de identidad, tras AUTH-REAL. Tiempo de vida del token de acceso y si las operaciones sensibles consultan la sesión en el servidor de Auth |
| DS-05 (detalle) | Cómo presenta el cliente el selector de contexto. La POC no expone nombres de empresas ajenas al contexto activo; un selector necesitará una vista mínima de «mis empresas» |
| DS-13 | Residencia de datos (Brasil y Colombia) y normativa aplicable |
| DS-14 | Registro de intentos denegados sin contexto (limitación 6) y retención de auditoría |
| Idempotencia | ¿Un rechazo de negocio consume el `operationId` (como en la POC) o el cliente puede reintentar con el mismo identificador? |
| Moneda COP | ¿Se opera con 0 decimales (uso local) o con 2 (ISO 4217)? |
| Línea base de pruebas | Las suites informan 1.600 casos, no 1.490: ¿se corrige la cifra en los documentos de la Ronda 6D? |
| Fase 1 | **No se inicia.** Requiere aprobación expresa |
