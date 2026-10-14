# ADEX SaaS · backend multiempresa (Fases 0 y 1)

Paquete independiente de CLEAN: tiene su propio `package.json`, no lo importa `src/`, no entra en el `tsconfig.json` raíz ni en el bundle de Vite. Solo **lee** reglas de CLEAN (`src/lib`, `src/models`) para reutilizarlas como contrato (DS-01).

Resultados y decisiones: [`docs/SAAS_FASES_0_1_RESULTADOS.md`](../docs/SAAS_FASES_0_1_RESULTADOS.md).

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
node scripts/run-contract-bench.ts   # las 26 suites de CLEAN contra el manifiesto del banco
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

## Roles de base de datos

| Rol | Uso | Atributos |
|---|---|---|
| `adex_owner` | Dueño de los esquemas; sin login | Sin superusuario ni BYPASSRLS |
| `adex_api` | API de empresa | Login, `NOINHERIT`, sin BYPASSRLS, sin DELETE ni TRUNCATE |
| `adex_control` | API del plano Owner | Login, `NOINHERIT`, sin ningún privilegio de tabla sobre `adex` |

Las contraseñas de los roles se generan en cada ejecución y no se guardan.
