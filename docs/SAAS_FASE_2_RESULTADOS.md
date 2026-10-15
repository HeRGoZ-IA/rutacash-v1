# ADEX Soluciones — Fase 2 del SaaS (estructura y catálogo): resultados

| | |
|---|---|
| Fecha | 2026-10-14 · base `main` @ `f17d53d` |
| Autorización | Fase 2 aprobada expresamente por el propietario: estructura y catálogo, staging sintético, sin comandos financieros |
| Plan | [PLAN_MIGRACION_SAAS_2026-10.md](./PLAN_MIGRACION_SAAS_2026-10.md) §2, fila 2 · Fases anteriores: [SAAS_FASES_0_1_RESULTADOS.md](./SAAS_FASES_0_1_RESULTADOS.md) |
| Código | [`saas/`](../saas/) (CLEAN no cambia) |

## Puerta del plan

> «Oficinas, rutas (con responsable de capital), asignaciones, categorías, clientes. Las 20 escrituras directas de pantallas pasan a comandos. Se acaban los borrados físicos de usuarios, rutas y clientes con historia (DS-11). Puerta: `permissions` (559) en verde contra el servidor; `withCapitalControllerGuard` como restricción transaccional.»

| Criterio | Evidencia | Estado |
|---|---|---|
| `permissions` contra el servidor | `test/integration/authz-matrix.test.ts`: 18 comandos × 6 roles × ruta dentro/fuera de alcance = **156 decisiones** (58 permitidas, 98 denegadas, 40 por ruta); la respuesta HTTP real coincide siempre con `can()` de `src/lib/permissions.ts`, importado sin copiar. La suite local sigue en 559/559 | PASS |
| `withCapitalControllerGuard` transaccional | El responsable se fija, protege, cambia y libera en la transacción del comando (`capitalGuard.ts`, reglas puras de CLEAN). PostgreSQL lo vuelve a comprobar al COMMIT con disparadores diferidos (AX101), también frente al administrador de la base (CAP-001…006, STG-P2-004) | PASS |
| Escrituras directas de pantallas → comandos | Usuarios, rutas (estado y borrado), clientes (admin, cobrador, secretario), categorías y empresa. Quedan fuera, por el plan: visitas sin pago (Fase 4, cobro) y contraseña propia (proveedor de identidad, Fase 1) | PASS |
| Sin borrados físicos con historia (DS-11) | DS11-001…007, STG-P2-003 | PASS |

## Qué se construyó

| Pieza | Contenido |
|---|---|
| `db/migrations/0007_structure_catalog.sql` | DS-10 (catálogo de tipos por país, normalización en PostgreSQL, índice único), DS-11 (historia derivada del catálogo de FK + auditoría de membresías, disparador de borrado, sin TRUNCATE), guardas de entidades inactivas, responsable de capital diferido (AX101), escrituras por columna y RLS de Fase 2, categorías predeterminadas en el alta de empresa |
| `db/migrations/0008_structure_helpers_context.sql` | Las funciones auxiliares de 0007 no revelan nada de otra empresa a la API sin contexto válido; la comprobación del COMMIT usa una función interna sin acceso para la API |
| `src/structure/` | Comandos: empresa, Oficinas, rutas, categorías, clientes y responsable de capital |
| `src/identity/service.ts` | Membresías: rutas de Administradores con el responsable de capital, Cobrador responsable (`setCobradorRoutes`), datos de contacto, asignación desde una Oficina, borrado DS-11 |
| `src/http/companyApi.ts` | 36 rutas HTTP; idempotencia `X-Adex-Operation-Id` en las altas (P3) |

## DS-10 · documento único por empresa

- Clave: (empresa, tipo de documento, número normalizado), con índice único: dos altas simultáneas no crean el mismo documento (DS10-003: 12 en paralelo → 1; STG-P2-002: 8 en paralelo por el pooler → 1).
- Normalización en PostgreSQL. Solo se quitan separadores (espacio, punto, guion, barra). Un documento con caracteres ajenos a su tipo se rechaza: nunca se «arregla». El original se guarda tal cual en `document`.
- Catálogo inicial (`adex.document_types`), ampliable con una migración. BR: CPF (11 dígitos), CNPJ (14), RG, RNM y PAS. CO: CC, CE, NIT, PPT y PAS. No se valida el dígito verificador.
- Otro tipo con el mismo número es otra identificación. Otra empresa puede registrar a la misma persona.
- Clientes importados sin tipo: se conservan y se normalizan con la regla de CLEAN (`normalizeDoc`). Para cambiar su documento hay que declarar el tipo. Los duplicados históricos se marcan en la importación (`document_legacy_duplicate`) y se conservan sin fusionar. La API no puede marcarlos.

## DS-11 · historia protegida

- Clientes, membresías, rutas, Oficinas y categorías: un disparador `BEFORE DELETE` busca referencias en **todas** las FK compuestas que apuntan a la entidad (una tabla nueva queda protegida sin tocar nada) y, para las membresías, también las decisiones auditadas sobre la persona. Si hay historia, el borrado se rechaza (`2BP01` → 409 `HAS_HISTORY`, con las referencias). Vale también para el SuperAdmin y para el administrador de la base.
- Sin borrado masivo ni en cascada: no hay `TRUNCATE` (sin privilegio, y un disparador lo rechaza). Un `DELETE` masivo falla en la primera fila con historia y no borra nada.
- Concurrencia (DS11-007): una referencia sin confirmar hace esperar al borrado, que después ve la historia. Un borrado sin confirmar hace fallar a la referencia (`23503`). En 6 carreras API contra API entre borrar una ruta y asignarla, nunca se dieron ambas.
- Sin historia: borrado solo para el rol autorizado (cliente: Administrador o SuperAdmin de la ruta; ruta y membresía: solo el SuperAdmin, nunca la propia), auditado en la misma transacción. La identidad de la persona no se borra.

## Diferencias con CLEAN (justificadas)

| Tema | Servidor | Motivo |
|---|---|---|
| Capital inicial de una ruta nueva | Se rechaza si es mayor que 0 (`REQUIRES_PHASE_3_CAPITAL`) | Colocar capital es un comando de la Fase 3 (sale de la bolsa del responsable) |
| Cambiar el rol de una membresía | No existe; se crea otra membresía | DS-05: una membresía por empresa y rol; la anterior conserva su historia |
| Borrado de rutas y membresías | Las asignaciones y el responsable de capital cuentan como historia | DS-11 protege la trazabilidad de quién tuvo acceso o responsabilidad |
| Auditoría del ciclo de vida de la ruta | Alta, datos, Oficina y estado se auditan sin `route_id` (la ruta va en `entity_id`) | Con la FK, ninguna ruta podría borrarse aunque no tuviera historia |
| Estado, plan, vencimiento, país y moneda de la empresa | No se editan desde la API de empresa | Los tres primeros son del plano Owner (DS-17); país y moneda son estructurales |
| Fotos de cliente | Solo URL `https` | El almacenamiento de archivos no es de esta fase |
| `base_at_change_minor` del evento de responsable | NULL | La Base de la ruta la calcula el servidor desde la Fase 3; es informativo |

## Pruebas ejecutadas

| Batería | Resultado |
|---|---|
| Paquete SaaS local (`npm test`: typecheck + unitarias + PostgreSQL 17 real, migraciones 0001–0008) | **149 PASS · 0 FAIL** (13 + 136). Nuevas: STR-* (12), CAT-001, CLI-*/DS10-* (13), DS11-* (8), CAP-* (7), AUTHZ-P2 (21), MEM-* (4), HLP-* (3) |
| Fases 0 y 1 | En verde. Se actualizaron cuatro aserciones que fijaban límites que la Fase 2 debía levantar: SCHEMA-005 (tabla de tipos de documento), TEN-008 (la API ya escribe estructura propia, nunca finanzas ni datos de otra empresa), IDN-032 (rutas de Administrador con responsable de capital, antes 409 `REQUIRES_PHASE_2_CAPITAL_GUARD`) y BENCH-003 (`permissions` contra el servidor) |
| ADEX-Staging (`staging:test`: Auth real + RLS gestionada + Fase 2) | **19/19 PASS en tres ejecuciones consecutivas** (10, 11 y 12) con 0001–0008 aplicadas. Ejecuciones anteriores, para que conste: la 1 tuvo un fallo de tipo en la propia prueba (corregido); la 3 y la 6 se cortaron por fallos de red local (DNS `ENOTFOUND` del pooler y un proceso caído sin rastro, después de lo cual se añadieron escuchas de error a los pools de prueba); la 2, la 4, la 5 y de la 7 a la 9 pasaron completas |
| Banco de contratos de CLEAN | **1.600 / 1.600, 0 fallos** |
| CLEAN `tsc --noEmit` / `npm run build` | 0 errores. Bundle **`index-b05G8Ybt.js`**, el mismo |

## ADEX-Staging

- Identidad del destino demostrada **sin token de la Management API** (el temporal de la Fase 1 se retiró). Se comprobó: la referencia documentada; un pooler de sa-east-1, que enruta por referencia y solo acepta la contraseña de ese proyecto; Auth del mismo proyecto, con solo usuarios sintéticos; y la huella SHA-256 exacta de las migraciones aplicadas antes de escribir. La Data API no responde para `adex`, `adex_control` ni `adex_meta` (503).
- `staging:migrate` aplicó 0007 y 0008 (las demás se omitieron). Las semillas ya existían.
- Al terminar: 0 usuarios en Auth (cada prueba borra el suyo). Las filas sintéticas creadas por las pruebas se conservan: son datos de staging y DS-11 protege las que tienen historia.
- Corrección del arnés: la comprobación de exposición de la Data API (vía con token) tenía bytes de retroceso literales en la expresión regular y nunca podía detectar `adex`. Corregido.

## Límites conocidos (no bloquean)

1. El registro de intentos denegados (DS-14) sigue sin implementarse: un rechazo revierte su transacción y no deja auditoría.
2. Clientes importados sin tipo de documento: su unicidad se evalúa entre ellos (regla de CLEAN), no contra los clientes con tipo. La Fase 7 asigna tipos al importar.
3. Altas de cliente con crédito y visitas sin pago: Fase 4.
4. Las suites `bootstrap` y `platform` siguen locales. Sus equivalentes del servidor son OWN-*, CAT-001 y STR-*. La instalación local con contraseñas no existe en el servidor (DS-03).

## Costos incrementales

**0.** Supabase Free existente (ADEX-Staging); no se creó ni contrató nada.
