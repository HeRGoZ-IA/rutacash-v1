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

## Fase 1 — Identidad central y autorización multiempresa: **CONSTRUIDA · cierre BLOQUEADO por un criterio**

Todos los criterios pasan con PostgreSQL real y la API real, salvo uno: **la autenticación con Supabase Auth real en staging no se pudo ejecutar**, porque ADEX-Staging no se puede crear sin una decisión del propietario (ver «Qué queda bloqueado»). La Fase 1 no se declara cerrada hasta que AUTH-STG-001…004 pasen.

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
| Autenticación con el proveedor central | Verificador: IDN-001. Cliente → proveedor → API: CLI-010. **Con Supabase Auth real:** AUTH-STG-001…004 preparadas | **PASS en local** · real **BLOQUEADO** (sin ADEX-Staging) |
| Tokens verificados correctamente | IDN-001: firma ajena, `alg none`, HS256, caducado, `iss`/`aud` ajenos, `anon`/`service_role`, sin `session_id` o `iat` → 401 | PASS (emisor local con formato Supabase; en 0A.1 ya se verificó con tokens reales de Supabase) |
| La empresa A no accede a la B | IDN-020 (membresía, ruta, miembros y encabezados inyectados), TEN-004/005, OWN-003 | PASS |
| Un usuario desactivado no sigue operando | Membresía: IDN-033, REV-001/002. Persona: IDN-042, REV-005. Empresa suspendida: REV-004 | PASS |
| Sin herencia ni acumulación | IDN-021 (Ana: cobradora, administradora, supervisora), IDN-022 (los claims del token no conceden nada), TEN-007, AUTHZ-001 (paridad con `can()` en 6 roles × todas las capacidades) | PASS |
| Restricción por rutas | IDN-021, IDN-035 (quitar una ruta corta la siguiente petición), REV-003, TEN-006 | PASS |
| Revocación de membresías y sesiones | REV-001…006 (REVOKE-004 por cada vía y `lock_timeout`), IDN-040/041 (cierre local y global; el mismo token deja de servir), OWN-007 | PASS |
| Ninguna contraseña en el cliente de modo servidor | CLI-010: tras iniciar sesión, elegir y cambiar de contexto y cerrar sesión, la contraseña no aparece en la memoria de la sesión ni en ninguna base IndexedDB. CLI-002/003: el almacén rechaza claves de contraseña y no abre `RutaCashDB`. RT-005: ninguna columna de contraseña en PostgreSQL | PASS |
| Plano Owner sin autoridad financiera | OWN-001…007: solo campos estructurales; el rol de control no lee nada de `adex`; sin impersonación; no puede darse membresía | PASS |
| Reconstruible desde migraciones y semillas | MIG-001…005 con las 6 migraciones; `npm run db:rebuild` | PASS |
| Independencia de CLEAN | Ver «Verificación final» | PASS |
| Batería previa intacta y nuevas pruebas de aislamiento | Banco: 1.600/1.600. Paquete SaaS: 81 PASS, 0 FAIL | PASS |

### Qué queda bloqueado y por qué

**ADEX-Staging no se pudo crear.** El plan Free admite **2 proyectos activos en total** entre todas las organizaciones en las que el propietario es Owner o Administrador; crear otra organización no da más plazas. La organización ya tiene 2 activos: `ADEX-SaaS-POC-0A1` y el proyecto DEV de otro producto (0A.1 §R.1). Sin autorización no se pausa, borra ni reutiliza ninguno de los dos.

Consecuencias:
- AUTH-STG-001…004 (inicio de sesión real ES256, cierre de sesión ADEX con token real, recuperación de acceso y aprovisionamiento) están **preparadas y NO EJECUTADAS**.
- La API no se ha probado contra Supabase gestionado con las migraciones de las Fases 0 y 1; el clúster local imita sus roles (`postgres` sin superusuario, con BYPASSRLS) pero no es Supabase.

**Para desbloquear, el propietario decide una de estas opciones:**
1. Pausar el proyecto DEV del otro producto (deja de contar mientras está pausado).
2. Autorizar que la POC deje de ser POC: ejecutar su `--teardown` y pausarla o borrarla. Así queda libre la plaza para ADEX-Staging.
3. Usar otra cuenta de Supabase cuyo propietario no tenga 2 proyectos Free activos.

Después, pasos del propietario (sin compartir secretos en el chat):
1. Crear el proyecto `ADEX-Staging` en *South America (São Paulo)*, plan Free y sin método de pago.
2. En *Authentication*: desactivar el registro público y comprobar que la clave de firma en uso es ES256.
3. En *Data API*: no exponer `adex` ni `adex_control` (o deshabilitar la Data API).
4. Copiar `saas/.env.example` a `saas/.env.staging` y rellenarlo en local.
5. Ejecutar en `saas/`: `npm run staging:check`, `npm run staging:migrate` y `npm run staging:test`.

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
| Paquete `saas/`: `npm test` (typecheck + unitarias + PostgreSQL 17 real) | 13 unitarias + 68 con base de datos = **81 PASS · 0 FAIL**. Supabase Auth real: **BLOQUEADA / NO EJECUTADA** |
| Banco de contratos (`npm test` de CLEAN, 26 suites) | **1.600 / 1.600, 0 fallos** |
| CLEAN `npx tsc --noEmit` | 0 errores |
| CLEAN `npm run build` | Correcto. Bundle **`index-b05G8Ybt.js`**, el mismo que antes |
| `verify:deploy` contra https://rutacash-clean.vercel.app (solo lectura) | 81 OK, 0 fallos. Sirve `index-b05G8Ybt.js` |
| `src/`, `tests/`, `package.json`, `package-lock.json` de CLEAN | Sin cambios |
| POC `ADEX-SaaS-POC-0A1` y proyecto de Starcli | No se tocaron. No se usaron sus credenciales ni se ejecutó `--teardown` |
| Push y despliegue | No se hizo ninguno |
