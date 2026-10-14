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
