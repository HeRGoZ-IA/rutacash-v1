# ADEX Soluciones — Fases 0 y 1 del SaaS: resultados

| | |
|---|---|
| Fecha | 2026-10-14 · base `main` @ `3ce1df6` |
| Autorización | Inicio de las Fases 0 y 1 aprobado expresamente por el propietario (alcance limitado: staging, datos sintéticos, sin comandos financieros) |
| Código | [`saas/`](../saas/): paquete independiente de CLEAN |
| Plan | [PLAN_MIGRACION_SAAS_2026-10.md](./PLAN_MIGRACION_SAAS_2026-10.md) · Documento rector: [VISION_Y_PRINCIPIOS_SAAS_ADEX.md](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md) |

## Fase 0 — Esquema y banco de contratos: **CERRADA**

### Puerta del plan

> «Decisiones de las que depende esta fase firmadas; el esquema revisado reproduce las 28 tablas (o justifica las que desaparecen, como `cashboxMovements`, legado sin escritores).»

| Criterio | Evidencia | Estado |
|---|---|---|
| Esquema reproducible desde Git | 4 migraciones versionadas con SHA-256 (`adex_meta.schema_migrations`). MIG-001: base vacía → migraciones; repetir no aplica nada. MIG-002: dos bases construidas desde Git tienen la misma huella de esquema. MIG-003: un archivo aplicado que cambia detiene el proceso | PASS |
| 28 tablas reproducidas o justificadas | SCHEMA-001…006: 27 tablas mapeadas campo a campo contra las interfaces reales (compilador de TypeScript) y las columnas reales de PostgreSQL. `cashboxMovements` se elimina: SCHEMA-003 confirma que no tiene escritores en `src/` | PASS |
| Sin pérdida injustificada de entidades o relaciones | RT-004: las 3 empresas sintéticas, con cada campo de cada tabla relleno al menos una vez (RT-001), vuelven idénticas de PostgreSQL. Diferencias, todas justificadas en [`dexieV16.ts`](../saas/src/model/dexieV16.ts): `password` y `mustChangePassword` no se importan (DS-03); `User.routeId` se une a las rutas autorizadas | PASS |
| Aislamiento por empresa | `company_id NOT NULL` y clave `(company_id, id)` en toda tabla operativa; FK compuestas (INV-001). RLS habilitada y forzada en las 31 tablas (TEN-002). Cada SuperAdmin ve solo su empresa en las 24 tablas (TEN-004); sin contexto o con contexto falsificado, nada (TEN-005); alcance por rutas (TEN-006); DS-05 sin acumulación (TEN-007); membresía inactiva, identidad desactivada o empresa suspendida o vencida → nada (TEN-009) | PASS |
| Privilegios controlados | `adex_api` y `adex_control` sin superusuario, BYPASSRLS ni herencia; la Data API no puede asumirlos (TEN-001). Sin DELETE ni TRUNCATE; en la Fase 0 la API solo lee (TEN-003, TEN-008); el plano Owner no tiene privilegios de tabla sobre `adex` | PASS |
| Banco de contratos | [`suiteManifest.ts`](../saas/src/contracts/suiteManifest.ts): las 26 suites con su fase de destino en el servidor. `run-contract-bench.ts` ejecuta `npm test` de CLEAN y contrasta cada total: **1.600 / 1.600, 0 fallos**. Ninguna suite corre todavía contra el servidor (no hay comandos financieros: BENCH-003) | PASS |
| Reglas aprobadas conservadas | Restricciones del esquema (INV-002…009): sin borrado físico (D28); cierres inmutables y versionados (D7); monotonía de pagos; asientos espejo una sola vez; forma de la custodia; atribución de gastos; aritmética del cuadre; una solicitud pendiente por cliente. Las reglas que dependen de saldos (D24–D26, D30) son de los comandos de las fases 3–6 | PASS |
| Ningún dato real | MIG-005: solo correos `@example.test`; sin contraseñas ni direcciones en migraciones | PASS |
| CLEAN sin alteraciones | Ningún archivo de `src/`, `tests/`, `package.json` ni `package-lock.json` de la aplicación cambió | PASS |

### Componentes

- **Migraciones** (`saas/db/migrations/`):
  - `0001` núcleo multiempresa: empresas (país ISO, moneda, zona IANA), identidades, membresías (DS-05), Oficinas, rutas y rutas autorizadas;
  - `0002` las 19 tablas operativas restantes, idempotencia y restricciones de inmutabilidad;
  - `0003` RLS forzada y privilegios mínimos;
  - `0004` plano de control Owner en el esquema `adex_control`.
- **Semillas** (`saas/db/seeds/synthetic.ts`): Alfa Cobranças (BR, BRL), Beta Créditos y Gamma Préstamos (CO, COP). Ana tiene tres membresías en dos empresas.
- **Adaptador** Dexie ↔ PostgreSQL sin pérdidas: dinero en unidades menores exactas; un importe con decimales se rechaza (RT-002); importación todo o nada (RT-003).

### Decisiones de diseño del esquema

| Tema | Decisión | Motivo |
|---|---|---|
| Identificadores | Texto (`adex.eid`), conservando los ids locales | Plan §4.2.4: importación con identificadores conservados |
| Dinero | `bigint` en unidades menores ISO 4217 (BRL y COP = 2) | El motor local trabaja en enteros: conversión exacta. La presentación de COP sigue pendiente |
| `User` | Membresía (empresa + rol) + identidad (persona) | DS-05. Una membresía sin identidad conserva la trazabilidad histórica pero no puede iniciar sesión |
| Filas sin ruta (bolsas, libro de empresa, Caja socios) | Visibles solo para el SuperAdmin en esta fase | Fallo cerrado; se amplían por comando en las fases 3–6, con sus pruebas |
| Documento único del cliente | Solo índice | DS-10 sigue abierta |
| Caja socios | Sin control de saldo | D1 sigue abierta |

### Limitaciones

1. El clúster local imita los roles de Supabase, pero no es Supabase: no hay Supavisor, PostgREST ni Auth.
2. La importación de datos reales (Fase 7) necesitará decidir cómo tratar las referencias a usuarios borrados físicamente (DS-11) y las anomalías del plan §4.3: el esquema las rechaza, no las corrige.

---

## Fase 1 — Identidad central y autorización multiempresa: **CERRADA** (2026-10-14)

Todos los criterios pasan con PostgreSQL real, la API real y, desde el 2026-10-14, contra **Supabase gestionado real en ADEX-Staging** (ver «Validación remota en ADEX-Staging»).

### Decisiones aprobadas por el propietario (2026-10-14)

| Tema | Decisión |
|---|---|
| Revocación de sesión | Registro ADEX en PostgreSQL: sesiones revocadas (`session_id`) y corte por identidad (`sessions_valid_after`), comprobados en la transacción de cada operación **y** en RLS. Sin llamadas de red por operación |
| REVOKE-004 | Bloqueo consultivo de transacción: compartido en cada operación (identidad, empresa y membresía) y exclusivo en **todas** las vías de revocación, impuesto por disparadores |
| DS-17 | Mismo PostgreSQL, plano separado: esquema `adex_control`, rol `adex_control` sin privilegios sobre `adex`, API Owner propia. `billableRouteCount` lo calcula el servidor (rutas `activa`) |
| Selector | «Empresa · Rol · País». Con una membresía activa se entra directamente; con varias, la elección es obligatoria. Una empresa suspendida aparece con aviso y no se puede elegir. Cambiar de contexto vacía la caché |

### Componentes

| Pieza | Archivo | Qué hace |
|---|---|---|
| Migración 0005 | `db/migrations/0005_identity_sessions_revocation.sql` | Sesiones revocables, bloqueos REVOKE-004, escrituras mínimas de identidad y membresías, auditoría con `txid` |
| Migración 0006 | `db/migrations/0006_control_plane_access.sql` | Acceso del Owner por funciones revisadas: alta de empresa, primer SuperAdmin, estado comercial, recuento de rutas y telemetría de acceso |
| Verificación de tokens | `src/auth/jwt.ts` | ES256/RS256 con JWKS; `iss`, `aud`, `exp`, `iat`, `sub`, `session_id` y `role = authenticated` obligatorios. HS256 y `alg none` rechazados |
| Proveedor | `src/auth/provider.ts` | Supabase Auth: alta sin contraseña conocida (la persona la fija con la recuperación del proveedor) y cierre de sesión |
| Contexto activo | `src/authz/context.ts` | Una membresía por petición (`X-Adex-Membership`), releída en PostgreSQL con los bloqueos tomados |
| Reglas de CLEAN | `src/authz/cleanRules.ts` | El servidor llama a `can()`, `canManageUser` y a la protección del último SuperAdmin de `src/lib`, sin copiarlos |
| Membresías | `src/identity/service.ts` | Alta, desactivación, reactivación y rutas autorizadas; auditoría en la misma transacción |
| API de empresa / Owner | `src/http/companyApi.ts`, `src/http/controlApi.ts` | Servidores y roles de base de datos separados |
| Cliente de modo servidor | `src/client/` | Sesión con solo tokens, IndexedDB propia (`adex-server-mode`) que rechaza secretos, selector y recuperación de acceso |

### Evidencia de los criterios

| Criterio | Pruebas | Estado |
|---|---|---|
| Autenticación con el proveedor central | Verificador: IDN-001. Cliente → proveedor → API: CLI-010. **Con Supabase Auth real:** AUTH-STG-001…004 preparadas | PASS (local y Supabase Auth real) |
| Tokens verificados correctamente | IDN-001: firma ajena, `alg none`, HS256, caducado, `iss`/`aud` ajenos, `anon`/`service_role`, sin `session_id` o `iat` → 401 | PASS (emisor local con formato Supabase; en 0A.1 ya se verificó con tokens reales de Supabase) |
| La empresa A no accede a la B | IDN-020 (membresía, ruta, miembros y encabezados inyectados), TEN-004/005, OWN-003. En gestionado: STG-RLS-003…006 | PASS |
| Un usuario desactivado no sigue operando | Membresía: IDN-033, REV-001/002. Persona: IDN-042, REV-005. Empresa suspendida: REV-004 | PASS |
| Sin herencia ni acumulación | IDN-021 (Ana: cobradora, administradora, supervisora), IDN-022 (los claims del token no conceden nada), TEN-007, AUTHZ-001 (paridad con `can()` en 6 roles × todas las capacidades) | PASS |
| Restricción por rutas | IDN-021, IDN-035 (quitar una ruta corta la siguiente petición), REV-003, TEN-006 | PASS |
| Revocación de membresías y sesiones | REV-001…006 (REVOKE-004 por cada vía y `lock_timeout`), IDN-040/041 (cierre local y global; el mismo token deja de servir), OWN-007 | PASS |
| Ninguna contraseña en el cliente de modo servidor | CLI-010: tras iniciar sesión, elegir y cambiar de contexto y cerrar sesión, la contraseña no aparece en la memoria de la sesión ni en ninguna base IndexedDB. CLI-002/003: el almacén rechaza claves de contraseña y no abre `RutaCashDB`. RT-005: ninguna columna de contraseña en PostgreSQL | PASS |
| Plano Owner sin autoridad financiera | OWN-001…007: solo campos estructurales; el rol de control no lee nada de `adex`; sin impersonación; no puede darse membresía | PASS |
| Reconstruible desde migraciones y semillas | MIG-001…005 con las 6 migraciones; `npm run db:rebuild`. ADEX-Staging construido desde vacío con `staging:migrate`; STG-RLS-001 comprueba las 6 huellas | PASS |
| Independencia de CLEAN | Ver «Verificación final» | PASS |
| Batería previa intacta y nuevas pruebas de aislamiento | Banco: 1.600/1.600. Paquete SaaS: 81 PASS, 0 FAIL | PASS |

### Validación remota en ADEX-Staging (2026-10-14)

Proyecto `ADEX-Staging` (`hyqaufsagtsucztjfjvc`), São Paulo (`sa-east-1`), plan Free, datos sintéticos. La POC `ADEX-SaaS-POC-0A1` quedó pausada por el propietario para liberar la plaza.

| Paso | Resultado |
|---|---|
| `staging:check` | Nombre, región y estado `ACTIVE_HEALTHY` **demostrados** por la Management API (token obligatorio, solo lectura, limitado al proyecto); `public` vacío; 0 usuarios no sintéticos; Data API sin esquemas expuestos |
| `staging:migrate` | 0001…0006 aplicadas sobre un proyecto vacío, 0 omitidas; semillas sintéticas importadas |
| `staging:test` | **11/11 PASS** en tres ejecuciones consecutivas: AUTH-STG-001…004 y STG-RLS-001…007 |

| Prueba | Qué demuestra |
|---|---|
| AUTH-STG-001 | Inicio de sesión real; token ES256 verificado por JWKS; sin claims de autoridad |
| AUTH-STG-002 | Token real → API → membresía; contexto ajeno 403; el cierre de sesión ADEX corta el mismo token y el proveedor no renueva |
| AUTH-STG-003 | El cliente ADEX responde igual exista o no el correo; recuperación completa real (token del proveedor → verificación → nueva contraseña; la anterior deja de servir) |
| AUTH-STG-004 | Alta sin contraseña conocida y reutilización del `sub` existente |
| STG-RLS-001…007 | Huellas de las 6 migraciones; roles sin superusuario/BYPASSRLS/herencia y no asumibles por la Data API; RLS forzada en todas las tablas; privilegios exactamente los del contrato; aislamiento por empresa; contexto falsificado sin filas; DS-05 (otra membresía, nunca la suma); membresía desactivada sin datos al instante |

Ajustes del arnés durante la validación (sin cambios en `src/`):
1. El token de la Management API es obligatorio: la identidad del destino se demuestra, no se declara.
2. `--test` espera a que Supavisor acepte la contraseña rotada de `adex_api` (antes, 1 de cada 3 ejecuciones fallaba con `password authentication failed`).
3. AUTH-STG-003: la respuesta cruda de `/recover` difiere para un correo existente porque el SMTP integrado de Supabase rechaza el dominio reservado `example.test` (`email_address_invalid`) o agota su cupo horario (`over_email_send_rate_limit`). La prueba admite solo esas dos diferencias y exige además la recuperación completa real.

**Condición para producción (no bloquea la Fase 1):** con el SMTP integrado de Supabase, `/recover` responde distinto para correos existentes no entregables; además, solo envía a direcciones del equipo y con cupo horario mínimo. Producción exige SMTP propio y que el cliente use siempre la ruta de ADEX (ya normaliza la respuesta).

### Límites conocidos (no bloquean)

1. Un token emitido en el **mismo segundo** que un cierre global también queda revocado (`iat` tiene resolución de segundos): la persona vuelve a iniciar sesión un segundo después.
2. Un cierre de sesión hecho directamente en Supabase, sin pasar por la API de ADEX, solo corta al caducar el token. El cliente de modo servidor siempre cierra la sesión a través de ADEX.
3. Cambiar las rutas de un Administrador se rechaza con 409 hasta la Fase 2, porque decide el responsable de capital (`withCapitalControllerGuard`).
4. La lectura de filas operativas sin ruta (bolsas, libro de empresa, Caja socios) queda solo para el SuperAdmin hasta los comandos de las fases 3–6.
5. El registro de intentos denegados (DS-14) no está implementado.

### Costos incrementales

**0.** No se creó ningún proyecto ni se contrató nada. Todo se ejecutó con PostgreSQL 17 local y efímero.

---

## Verificación final (2026-10-14)

| Comprobación | Resultado |
|---|---|
| Paquete `saas/`: `npm test` (typecheck + unitarias + PostgreSQL 17 real) | 13 unitarias + 68 con base de datos = **81 PASS · 0 FAIL**. Supabase real (ADEX-Staging, `npm run staging:test`): **11/11 PASS** en tres ejecuciones consecutivas |
| Banco de contratos (`npm test` de CLEAN, 26 suites) | **1.600 / 1.600, 0 fallos** |
| CLEAN `npx tsc --noEmit` | 0 errores |
| CLEAN `npm run build` | Correcto. Bundle **`index-b05G8Ybt.js`**, el mismo que antes |
| `verify:deploy` contra https://rutacash-clean.vercel.app (solo lectura) | 81 OK, 0 fallos. Sirve `index-b05G8Ybt.js` |
| `src/`, `tests/`, `package.json`, `package-lock.json` de CLEAN | Sin cambios |
| POC `ADEX-SaaS-POC-0A1` y proyecto de Starcli | No se tocaron. No se usaron sus credenciales ni se ejecutó `--teardown` |
| Push y despliegue | No se hizo ninguno |
