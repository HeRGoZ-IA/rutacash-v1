# ADEX SaaS · Fase 0A · POC experimental

**Descartable.** No forma parte de la aplicación publicada: no la importa `src/`, no está en `tsconfig.json` raíz, no entra en el bundle de Vite y tiene su propio `package.json`.

Resultados e interpretación: [`docs/SAAS_FASE_0A_RESULTADOS.md`](../../docs/SAAS_FASE_0A_RESULTADOS.md).

## Requisitos

- Node.js ≥ 24 (ejecuta TypeScript de forma nativa, sin compilación).
- Nada global: PostgreSQL 17 se descarga como dependencia (`embedded-postgres`, ~100 MB) dentro de `node_modules`.

## Uso

```bash
cd experiments/saas-phase0a
npm ci
npm test                    # typecheck + unitarias + integración (PostgreSQL real) + Auth real
npm run test:unit           # sin base de datos
npm run test:integration    # levanta PostgreSQL efímero; datos y evidencia en ../../tmp/saas-phase0a/
npm run test:integration -- finance   # solo los archivos que empiezan por "finance"
```

Pruebas contra **Supabase Auth real** (`test/auth-real`): se marcan `skipped` (NO EJECUTADAS) salvo que existan
`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` en el entorno (nunca en Git). Con `supabase start`:

```bash
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... npm run test:integration
```

## Estructura

| Ruta | Contenido |
|---|---|
| `sql/001_schema.sql` | Esquema mínimo: monedas, empresas, identidades, rutas, membresías, libro sintético, idempotencia, auditoría |
| `sql/002_rls.sql` | Políticas RLS (FORCE) y privilegios mínimos del rol `adex_api` |
| `src/money.ts` | Dinero exacto en unidades menores (`bigint`) |
| `src/auth/supabaseJwt.ts` | Verificación del token de Supabase Auth (JWKS ES256/RS256; HS256 legado opcional) |
| `src/authz/` | Matriz experimental de permisos y resolución del contexto activo en PostgreSQL |
| `src/ledger/service.ts` | Comandos de depósito y retiro: una transacción, `FOR UPDATE`, idempotencia, auditoría |
| `src/http/server.ts` | API HTTP experimental (`node:http`) |
| `scripts/run-integration.ts` | Arnés: PostgreSQL efímero, roles, plantilla, ejecución y evidencia |
| `test/unit`, `test/integration`, `test/auth-real` | Pruebas por nivel de evidencia |

Los datos de prueba son sintéticos (`test/helpers/fixtures.ts`). Las contraseñas del clúster se generan al azar en cada ejecución.
