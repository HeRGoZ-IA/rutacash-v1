# ADEX SaaS · backend multiempresa (Fases 0 a 4 + ADEX Online v1)

Paquete independiente de CLEAN: tiene su propio `package.json`, no lo importa `src/`, no entra en el `tsconfig.json` raíz ni en el bundle de Vite. Solo **lee** reglas de CLEAN (`src/lib`, `src/models`) para reutilizarlas como contrato (DS-01).

Resultados y decisiones: [`docs/SAAS_FASES_0_1_RESULTADOS.md`](../docs/SAAS_FASES_0_1_RESULTADOS.md) · [`docs/SAAS_FASE_2_RESULTADOS.md`](../docs/SAAS_FASE_2_RESULTADOS.md) · [`docs/SAAS_FASE_3_RESULTADOS.md`](../docs/SAAS_FASE_3_RESULTADOS.md) · [`docs/SAAS_FASE_4_RESULTADOS.md`](../docs/SAAS_FASE_4_RESULTADOS.md) · [`docs/ADEX_ONLINE_V1_RESULTADOS.md`](../docs/ADEX_ONLINE_V1_RESULTADOS.md).

## Requisitos

- Node.js ≥ 24 (ejecuta TypeScript sin compilar).
- PostgreSQL 17 se descarga como dependencia (`embedded-postgres`); no hace falta nada global.

## Uso

```bash
cd saas
npm ci
npm test                 # typecheck + unitarias + pruebas con PostgreSQL real
npm run test:db -- tenancy   # solo los archivos que empiezan por «tenancy»
npm run db:rebuild       # base vacía → migraciones → semillas sintéticas → recuento y huella
npm run bench            # las 26 suites de CLEAN contra el manifiesto del banco
npm run staging:check    # ADEX-Staging: controles previos (BLOQUEADO sin saas/.env.staging)
node --import ./scripts/register-alias.mjs scripts/staging.ts --online-credentials   # credenciales estables de ADEX Online → saas/.env.online
node --import ./scripts/register-alias.mjs scripts/staging.ts --test online          # solo la batería de ADEX Online
node --import ./scripts/register-alias.mjs src/server/main.ts                       # servidor ADEX Online (variables en src/server/start.ts)
```

El clúster local imita los roles de Supabase (`postgres` sin superusuario, con BYPASSRLS; `anon`, `authenticated`, `service_role`, `authenticator`) y se borra al terminar. Datos y evidencia en `../tmp/saas-phase01/`.

## Estructura

| Ruta | Contenido |
|---|---|
| `db/migrations/` | Esquema versionado. Cada archivo se aplica una vez, con `set local role adex_owner`, y queda registrado con su SHA-256 en `adex_meta.schema_migrations` |
| `db/seeds/synthetic.ts` | 3 empresas sintéticas (BR, CO, CO) con las 24 tablas operativas y el plano Owner. Deterministas |
| `src/model/dexieV16.ts` | Correspondencia campo a campo de las 28 tablas Dexie v16 con su justificación |
| `src/model/adapter.ts` | Adaptador Dexie ↔ PostgreSQL sin pérdidas (base del banco de contratos) |
| `src/db/` | Migraciones, privilegios esperados, tipos de `pg` |
| `src/contracts/suiteManifest.ts` | Las 26 suites de CLEAN y la fase en la que deben pasar contra el servidor |
| `test/contracts/` | Puertas de la Fase 0: cobertura del esquema, ida y vuelta, aislamiento, invariantes, reproducibilidad |
| `src/auth/`, `src/authz/` | Fase 1: verificación de tokens (ES256/JWKS), proveedor de identidad, contexto activo y reglas de CLEAN |
| `src/identity/`, `src/control/`, `src/http/` | Fase 1: membresías y sesiones, plano Owner, API de empresa y API Owner (servidores separados) |
| `src/client/` | Fase 1: cliente de modo servidor (solo tokens; IndexedDB `adex-server-mode`; selector) |
| `src/structure/` | Fase 2: comandos de empresa, Oficinas, rutas, categorías, clientes (DS-10/DS-11) y responsable de capital (`capitalGuard.ts`) |
| `test/integration/` | Fase 1: identidad, REVOKE-004, plano Owner, cliente sin contraseñas · Fase 2: estructura, clientes, DS-11, responsable de capital, matriz de permisos contra el servidor |
| `src/credits/` | Fase 4: solicitudes, autorización y desembolso (solo en línea). Créditos solo por `adex.credit_disburse` (0010) |
| `src/capital/` | Fase 3: capital centralizado y custodia (Empresa → bolsa del Administrador → custodia del trabajador por ruta, sin caja de ruta). Escritura solo por `adex.capital_post` (0009) |
| `src/server/`, `src/http/demoApi.ts` | ADEX Online v1: servidor compuesto (API de empresa + administración Demo, CORS, límites, salud, registros sin datos). Imagen: `../deploy/adex-online-api/Dockerfile` |
| `src/demo/` | ADEX Online v1: ciclo de vida de la Empresa Demo (0011) y escenario `demo-v1` ejecutado con la API normal por puestos sintéticos |
| `test/auth-real/`, `scripts/staging.ts` | Supabase Auth real, RLS gestionada y Fase 2 en ADEX-Staging: 19/19 PASS en tres ejecuciones consecutivas (2026-10-14) |

## Roles de base de datos

| Rol | Uso | Atributos |
|---|---|---|
| `adex_owner` | Dueño de los esquemas; sin login | Sin superusuario ni BYPASSRLS |
| `adex_api` | API de empresa | Login, `NOINHERIT`, sin BYPASSRLS ni TRUNCATE; DELETE solo en asignaciones y catálogo sin historia (DS-11); escrituras según `src/db/privileges.ts` |
| `adex_control` | API del plano Owner | Login, `NOINHERIT`, sin ningún privilegio de tabla sobre `adex` |
| `adex_demo` | Administración de la Empresa Demo (0011) | Login, `NOINHERIT`, sin privilegios de tabla: solo ejecuta las funciones `adex_demo.*` |

Las contraseñas de los roles se generan en cada ejecución y no se guardan, salvo las de ADEX-Staging para ADEX Online: `--online-credentials` las escribe solo en `saas/.env.online` (ignorado por Git) y, mientras exista, `--migrate` y `--test` las reutilizan en lugar de rotarlas.
