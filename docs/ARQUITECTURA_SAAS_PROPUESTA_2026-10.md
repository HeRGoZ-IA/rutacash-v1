# ADEX Soluciones — Arquitectura SaaS propuesta (Ronda 6/6D)

| | |
|---|---|
| Fecha | 2026-10-12 · `main` @ `520a331` |
| Estado | **Propuesta para decisión del propietario.** Nada de esto está aprobado ni implementado |
| Actualización 2026-10-14 | La Opción A recomendada en §4 (API TypeScript propia + PostgreSQL gestionado) fue **aprobada como DS-01**. DS-15 **aprobada**: tablas compartidas, aislamiento por empresa con RLS y autorización en la API (la RLS deja de ser opcional). El proveedor (DS-02) y la identidad (DS-03) siguen abiertos. Nada está implementado en producción. Documento rector: [VISION_Y_PRINCIPIOS_SAAS_ADEX.md](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md) |
| Entradas | [Auditoría](./AUDITORIA_PREPARACION_SAAS_2026-10.md) · [Invariantes](./INVARIANTES_FINANCIERAS_2026-10.md) · [Riesgos](./RIESGOS_CONCURRENCIA_SAAS_2026-10.md) · [Plano de control](./CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md) |

## 1. Requisitos que deciden la arquitectura

Salen del código y de las rondas anteriores, no de preferencias:

1. **Transacciones de varias filas con bloqueo.**
   - Un desembolso lee y bloquea la venta, la Base de la ruta, la posición del trabajador, el responsable de capital y los cierres, y escribe la venta y la solicitud.
   - Una transferencia toca dos rutas, Caja socios y custodia.
   - Es un **libro contable relacional**.
2. **Reglas ya escritas y probadas en TypeScript:**
   - `src/lib/*.ts`: `permissions`, `cashSettlementRules`, `capitalAllocation`, `settlementPeriods`, `paymentState`, `activeCredit`…;
   - `src/services/*.ts`: 1.600 pruebas (corrección documental en la Fase 0A.1: antes decía 1.490; ver SAAS_FASE_0A1_RESULTADOS.md §19).
   - Reescribirlas en otro lenguaje duplica la fuente de verdad.
3. **Aislamiento por empresa** con un modelo de roles por ruta y una autoridad de caja por responsable (`routeCashAuthorityError`).
4. **Trabajo de campo con mala conectividad:** el Cobrador registra pagos y visitas sin conexión (`syncStatus: 'pending'`).
5. **Hora y zona horaria del servidor** para cuadres, cierres (D29) y periodos (D7).
6. **Plano de control separado** (Owner ↔ empresas), ya especificado y agnóstico de proveedor.
7. **Equipo pequeño:** la complejidad operativa cuenta tanto como la técnica.

## 2. Opciones evaluadas

### Opción A — API propia en TypeScript + PostgreSQL gestionado
- Servidor TypeScript (Node) que expone **comandos** (`disburse`, `registerPayment`, `closeSettlement`…), cada uno en **una transacción** de PostgreSQL con `SELECT … FOR UPDATE` sobre las filas de saldo (o `SERIALIZABLE` con reintento).
- Reutiliza `src/lib` tal cual; los servicios se portan cambiando Dexie por un repositorio SQL.
- Identidad con una biblioteca o proveedor probado (no hecha a mano).
- Aislamiento en la API (`tenantId` del token) **y** en la base (RLS con variable de sesión, como segunda barrera).
- PostgreSQL en cualquier proveedor gestionado.

### Opción B — Supabase (PostgreSQL + Auth + RLS + funciones)
- Auth, RLS y Realtime incluidos.
- Los comandos financieros se escriben como:
  - **funciones RPC en PL/pgSQL** (una llamada = una transacción), o
  - Edge Functions (Deno/TypeScript) que abren una conexión directa a Postgres para agrupar sentencias en una transacción.
- Las llamadas desde el cliente con `supabase-js` son peticiones separadas: **no** sirven para componer un comando de varias filas.
- RLS por empresa y por ruta, escrito en SQL.

### Opción C — Capa de sincronización local-first sobre PostgreSQL
Motor de réplica (familia PowerSync, ElectricSQL o Replicache):
- conserva una copia local para leer sin conexión;
- envía las escrituras por una cola que procesa **un servidor propio**.

**No es alternativa a A o B, sino un complemento.** Las escrituras financieras siguen necesitando un servidor que valide y bloquee. Se evalúa porque el requisito 4 (trabajo sin conexión) es real.

**No evaluadas en profundidad:** bases documentales (por ejemplo, Firestore). El dominio es un libro contable relacional con agregados por ruta y trabajador, y conservación entre tablas; un modelo documental obligaría a duplicar saldos y a reimplementar invariantes que SQL expresa de forma natural.

## 3. Comparación

| Criterio | A · API TS + Postgres | B · Supabase | C · Sincronización local-first (complemento) |
|---|---|---|---|
| **Integridad financiera** | Alta: transacciones y bloqueos explícitos en código probado | Alta si los comandos son RPC o funciones con conexión directa; **baja** si se escribe desde el cliente | La define el servidor que procesa la cola; sin él, ninguna |
| **Reutilización de reglas y pruebas** | **Máxima**: `src/lib` sin cambios y servicios portados | Baja con PL/pgSQL (todo se reescribe en SQL); media con Edge Functions (Deno + conexión directa) | Igual que su servidor |
| **Aislamiento por empresa** | API + RLS opcional (doble barrera; requiere disciplina) | **RLS nativa** muy sólida; el modelo por ruta se escribe en SQL | Reglas de réplica por empresa y ruta (otra capa más que configurar) |
| **Transacciones y concurrencia** | Completas (Postgres) | Completas dentro de una RPC o función | Las resuelve el servidor; además, conflictos de réplica |
| **Seguridad e identidad** | Hay que integrar una solución (biblioteca o IdP) | Auth incluida (contraseñas con hash, recuperación, sesiones) | No aporta identidad |
| **Sin conexión** | Hay que construir una cola con `operationId` (acotada por política) | Igual que A | **Su punto fuerte**: lectura sin conexión y cola gestionada |
| **Coste relativo** | Medio: hosting de la API + Postgres gestionado | Bajo al inicio (plan gestionado único); crece con uso y funciones | Alto: otra licencia o servicio y más operación |
| **Complejidad inicial** | Media-alta (API, despliegue, autenticación) | Baja para CRUD; **alta** para comandos financieros en SQL | Alta |
| **Mantenimiento** | Un solo lenguaje (TS) cliente/servidor; pruebas compartidas | Dos lenguajes (TS + SQL) para la lógica de dinero; políticas RLS que mantener | Una pieza más que versionar y monitorizar |
| **Migración desde Dexie** | Directa: los servicios ya tienen forma de comando y transacción | Exige traducir reglas a SQL o montar funciones con conexión directa | Su modelo local es SQLite o su propio esquema: hay que remapear |
| **Crecimiento** | Escala horizontal de la API; Postgres vertical + réplicas | Igual (es Postgres) con límites del plan | Depende del proveedor |
| **Dependencia del proveedor** | Baja (Postgres estándar) | Media (Auth, RLS y Realtime de Supabase; los datos son Postgres portable) | Media-alta |

## 4. Recomendación (para aprobar o rechazar)

**Recomendada: Opción A como arquitectura**:
- **PostgreSQL como sistema de registro único**;
- **API TypeScript con comandos financieros transaccionales** que reutilizan `src/lib` y la lógica de `src/services`;
- **identidad con una solución probada**;
- **RLS por empresa como segunda barrera**.

El proveedor de PostgreSQL gestionado queda **abierto** (DS-02).

Un **híbrido A+B** es compatible: usar Supabase solo como Postgres gestionado + Auth + RLS, manteniendo los comandos de dinero en la API TypeScript con conexión directa. Se elegiría por coste u operación, no por el modelo de datos.

**Por qué:**
1. **Las reglas ya existen y están probadas en TypeScript.** Traducirlas a PL/pgSQL (B puro) reabriría D24–D30 y D7 en otro lenguaje sin las 1.600 pruebas que hoy las sostienen.
2. **Los comandos necesitan transacciones de varias filas con bloqueo**: es lo que A da de forma directa y B solo dentro de RPC o funciones con conexión directa.
3. **El aislamiento por empresa merece dos barreras** (API + RLS), y PostgreSQL ofrece RLS en cualquier proveedor.
4. **El trabajo sin conexión es acotado:** una cola propia con `operationId` para pocas operaciones (pagos y visitas) cubre el requisito sin incorporar la Opción C. C queda como evolución si la operación sin conexión necesita más que eso (DS-07).

**Riesgos explícitos de la recomendación:**

| Riesgo | Mitigación |
|---|---|
| Más trabajo de operación que B (despliegue, monitorización, copias) | Postgres gestionado con copias y PITR; API sin estado; observabilidad desde el día 1 |
| Implementar identidad mal | No escribirla a mano: biblioteca o IdP probado; hash fuerte; sesiones revocables |
| Conexiones a Postgres desde funciones serverless | Pooler de conexiones; o API en un proceso persistente |
| Interbloqueos al bloquear varias filas | Orden de bloqueo determinista (empresa → bolsa → ruta → trabajador → venta) y reintentos acotados |
| Divergencia entre cliente y servidor durante la transición | Los clientes dejan de escribir dinero en local por fases, con banderas y pruebas de doble dispositivo (ver el [plan](./PLAN_MIGRACION_SAAS_2026-10.md)) |
| Hora del servidor frente a la zona del negocio | Zona horaria por empresa almacenada; todas las fechas contables se calculan en el servidor |

## 5. Forma del sistema propuesto

```
Cliente (React, misma UI)
   ├─ Lecturas: API de consultas (proyecciones por empresa y ruta) + caché local de solo lectura
   ├─ Comandos: API de comandos con operationId → nunca escriben dinero en local
   └─ Cola sin conexión (solo operaciones aprobadas en DS-07): pagos, visitas
API TypeScript
   ├─ Autenticación (identidad central) → contexto: empresa, rol, rutas
   ├─ Comandos financieros: una transacción, bloqueos ordenados, reglas de src/lib,
   │   auditoría en la misma transacción, idempotencia por (empresa, operationId)
   └─ Eventos de cambio por empresa y ruta (invalidación o suscripción)
PostgreSQL (sistema de registro)
   ├─ Tablas con tenant_id obligatorio + RLS por empresa
   ├─ Libro append-only (capital, custodia, transferencias, pagos, gastos) + marcas de anulación
   ├─ Filas de saldo materializadas y verificables contra el libro (Base, bolsa, posición)
   └─ Tabla de operaciones idempotentes; auditoría
Plano de control (Owner) — canal separado (CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md)
```

**Modelo de saldos:**
- El libro sigue siendo la fuente de verdad (como hoy, sumas sobre tablas).
- Para bloquear con eficiencia se proponen **filas de saldo materializadas**: ruta, bolsa, posición de trabajador y venta. Se actualizan en la misma transacción y se verifican periódicamente contra el libro (equivalente de `verifyCapitalInvariants` y `computeRouteCashReconciliation`).
- Es un detalle de diseño que se valida en la fase 1 del plan.

## 6. Lo que esta propuesta NO decide

Proveedor de Postgres y de hosting, proveedor de identidad, política de operación sin conexión, residencia de datos, estrategia de importación histórica y modelo de cuentas por persona. Todo está en [decisiones pendientes](./DECISIONES_PENDIENTES_SAAS_2026-10.md).
