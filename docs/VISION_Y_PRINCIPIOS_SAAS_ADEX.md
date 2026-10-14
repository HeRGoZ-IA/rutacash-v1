# ADEX Soluciones — Visión y principios de la plataforma SaaS

| | |
|---|---|
| Fecha | 2026-10-14 · `main` @ `f4357ba` |
| Estado | **APROBADO** por el propietario (revisión 2, 2026-10-14) |
| Carácter | **Documento rector.** Orienta la evolución del producto. No sustituye a la documentación técnica: la encuadra |
| Alcance | Solo documental. No aprueba proveedores, no inicia la Fase 1 y no cambia ninguna decisión técnica previa |
| Documentos técnicos | [Auditoría](./AUDITORIA_PREPARACION_SAAS_2026-10.md) · [Invariantes](./INVARIANTES_FINANCIERAS_2026-10.md) · [Riesgos](./RIESGOS_CONCURRENCIA_SAAS_2026-10.md) · [Arquitectura](./ARQUITECTURA_SAAS_PROPUESTA_2026-10.md) · [Plan](./PLAN_MIGRACION_SAAS_2026-10.md) · [Decisiones pendientes](./DECISIONES_PENDIENTES_SAAS_2026-10.md) · [Fase 0A](./SAAS_FASE_0A_RESULTADOS.md) · [Fase 0A.1](./SAAS_FASE_0A1_RESULTADOS.md) · [Plano de control](./CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md) |

## Cómo leer este documento

Cada afirmación lleva uno de estos cuatro estados. Ninguno implica a otro.

| Estado | Significado |
|---|---|
| **APROBADO** | Decisión confirmada expresamente por el propietario |
| **VALIDADO TÉCNICAMENTE** | Respaldado por pruebas. **No** significa que funcione en la aplicación productiva ni que esté aprobado como proveedor |
| **PENDIENTE** | Funcionalidad, decisión, prueba o aprobación no completada |
| **OBJETIVO ESTRATÉGICO** | Capacidad que se busca alcanzar. **No** se ha conseguido todavía |

Si este documento y un documento técnico parecen contradecirse, prevalece la decisión con estado **APROBADO** más reciente. Si ninguno de los dos es una decisión aprobada, la contradicción se eleva al propietario; no se resuelve por interpretación.

---

## 1. Identidad y propósito del producto

**ADEX Soluciones** (antes RutaCash) es una plataforma para empresas que prestan dinero y lo cobran en la calle, en rutas diarias. Gestiona:

- préstamos (ventas), sus solicitudes, aprobación y desembolso;
- cobros diarios, visitas y cartera;
- capital de la empresa, de cada Administrador y de cada ruta;
- trabajadores (Cobradores, Supervisores, Secretarios) y su efectivo en mano;
- gastos, transferencias, retiros y la Caja socios;
- cuadres por trabajador y cierres semanales.

Su propósito es que una empresa sepa, en todo momento y sin discusión, **cuánto dinero tiene, dónde está y quién responde de él**.

## 2. Visión comercial a largo plazo — **APROBADO**

> ADEX Soluciones será una **plataforma SaaS comercial multiempresa, escalable e internacional**, que preste servicio a numerosas empresas independientes desde una **infraestructura central compartida**.

Esto significa, en concreto:

| ADEX **sí** se construye para… | ADEX **no** se construye como… |
|---|---|
| Muchas empresas independientes que contratan el servicio | Una herramienta para que dos personas o dos equipos compartan datos |
| Una sola plataforma que se opera y mejora una vez para todos | Un producto a medida de una empresa piloto |
| Infraestructura compartida con aislamiento estricto entre empresas | Una instalación independiente por cada empresa como modelo predeterminado |

Las pruebas con dos equipos, dos empresas o una empresa piloto son **pasos de validación**, no el destino del producto (ver P9).

## 3. Clientes y mercados objetivo

| Elemento | Estado |
|---|---|
| Cliente: empresas de préstamo y cobro diario por rutas, con Administradores, Supervisores, Cobradores, Secretarios y Socios | APROBADO (es el dominio actual del producto) |
| Mercados iniciales: **Brasil** y **Colombia** | APROBADO |
| Expansión prevista: otros países de Sudamérica | OBJETIVO ESTRATÉGICO (sin países ni fechas definidos) |
| Planes, precios, número de clientes y fechas de lanzamiento | PENDIENTE — este documento no los fija |

## 4. Modelo SaaS multiempresa

Cada empresa contratante es un **ámbito operativo independiente** (*tenant*). Comparte la infraestructura, nunca los datos.

| Aspecto | Qué significa | Estado |
|---|---|---|
| Aislamiento de datos, operaciones, permisos, capital y registros financieros | Una empresa no puede leer, escribir ni inferir datos de otra | APROBADO como principio (P1) |
| Doble barrera: la API filtra por empresa y PostgreSQL lo vuelve a imponer con RLS | Un fallo en una capa no basta para mezclar empresas | VALIDADO TÉCNICAMENTE (Fase 0A: TENANT-001…005; Fase 0A.1: MANAGED-RLS-001) |
| Tablas compartidas en PostgreSQL con aislamiento por empresa mediante RLS y autorización en la API | Modelo predeterminado de la plataforma | **APROBADO** (DS-15, 2026-10-14) |
| Instalación o base dedicada para una empresa concreta | Excepción justificada, no modelo predeterminado | APROBADO como excepción (DS-15) |

## 5. Experiencia esperada para empresas y trabajadores — OBJETIVO ESTRATÉGICO

- **Un mismo dato para todos.** El Administrador en la oficina, el Supervisor y el Cobrador en la calle ven la misma Base, la misma cartera y el mismo cuadre, aunque usen equipos distintos. Hoy **no** ocurre: cada navegador tiene su propia copia (ver §13).
- **Trabajo de campo con mala conectividad.** El Cobrador podrá registrar ciertas operaciones sin conexión. Cuáles exactamente es una decisión abierta (DS-07); la propuesta técnica las limita a pagos en efectivo y visitas. Desembolsos, Base, capital, cierres y correcciones exigirán conexión.
- **Una persona, varios papeles.** Quien trabaja para dos empresas, o con dos roles en la misma, entra una sola vez y elige con qué empresa y rol opera (P4).
- **Las mismas reglas que hoy.** La transición al servidor no cambia cómo se cuadra, se cierra o se desembolsa (P3, P8).
- **Idioma, moneda y hora locales** de cada empresa (P6).

## 6. Arquitectura estratégica

| Elemento | Estado |
|---|---|
| **DS-01:** API propia en TypeScript con comandos financieros transaccionales + PostgreSQL gestionado como sistema de registro | **APROBADO** |
| Reutilizar las reglas de `src/lib` y la lógica de `src/services`, con las 26 suites (1.600 casos) como contrato del servidor | APROBADO como parte de DS-01 |
| El patrón (transacción única, bloqueo ordenado, idempotencia, auditoría en la misma transacción, RLS) resuelve el doble consumo de saldo | VALIDADO TÉCNICAMENTE (Fase 0A FIN-001…006; Fase 0A.1 MANAGED-FIN-001…005) |
| **Supabase PostgreSQL** como proveedor gestionado | VALIDADO TÉCNICAMENTE como **candidato**. Selección comercial y operativa **PENDIENTE** (DS-02) |
| Hosting de la API, presupuesto, copias y recuperación a un punto en el tiempo (PITR) | PENDIENTE (DS-02) |
| Capa de sincronización local-first de terceros (Opción C) | No adoptada; solo como evolución si DS-07 lo exige |

La forma del sistema propuesto está en [ARQUITECTURA_SAAS_PROPUESTA_2026-10.md §5](./ARQUITECTURA_SAAS_PROPUESTA_2026-10.md#5-forma-del-sistema-propuesto).

## 7. Identidad, membresías y seguridad

| Elemento | Estado |
|---|---|
| **DS-05:** una identidad por persona; varias membresías independientes por empresa y rol; **contexto activo explícito** en cada operación; **sin herencia ni acumulación de permisos** | **APROBADO** |
| Membresía desactivada deja de operar de inmediato, aunque el token siga vigente | VALIDADO TÉCNICAMENTE (ID-004, MANAGED-ID-001) |
| Los permisos no viajan en el token: se releen en PostgreSQL en cada operación | VALIDADO TÉCNICAMENTE (Fase 0A §N.4) |
| **Supabase Auth** como proveedor de identidad (ES256/JWKS, logout que revoca la sesión) | VALIDADO TÉCNICAMENTE como **candidato**. Selección **PENDIENTE** (DS-03), con una condición abierta: cómo cortar el token de acceso antes de su caducidad en operaciones financieras |
| Las contraseñas locales actuales (texto plano) **no se migran**: cada usuario restablece la suya | Propuesta técnica (DS-03); PENDIENTE de aprobación junto con DS-03 |
| Cómo presenta la interfaz el selector de empresa y rol | PENDIENTE (detalle de DS-05) |
| Registro de intentos denegados y retención de auditoría | PENDIENTE (DS-14) |

## 8. Integridad financiera y fuente de verdad

| Elemento | Estado |
|---|---|
| **El PostgreSQL central será la única autoridad del estado financiero.** Ningún navegador mantendrá un libro propio que se considere autoritativo | APROBADO como principio (P2) |
| Reglas de negocio vigentes D7, D24, D25, D26, D28, D29, D30 y el modelo de capital por Administrador (v16) se trasladan **tal cual** | APROBADO (rondas anteriores) |
| Todo movimiento de dinero: autorizado en el servidor, validado, atómico, idempotente y auditado en la misma transacción | APROBADO como principio (P3); VALIDADO TÉCNICAMENTE en la POC |
| Backend financiero multiusuario de ADEX | **No existe todavía.** La POC de las Fases 0A/0A.1 es sintética y descartable: valida el patrón, no es el backend. Se construye en las fases 1–6 del plan |
| Motor financiero multiusuario real funcionando en producción | **PENDIENTE** (fases 2–6 del plan) |
| Decisiones de negocio abiertas que afectan a comandos financieros: D1 (Caja socios), D2–D4, D19–D23, D27, Secretario | PENDIENTE — no se resuelven por el paso al servidor |

El catálogo exigible está en [INVARIANTES_FINANCIERAS_2026-10.md](./INVARIANTES_FINANCIERAS_2026-10.md) y los riesgos que el servidor debe cerrar en [RIESGOS_CONCURRENCIA_SAAS_2026-10.md](./RIESGOS_CONCURRENCIA_SAAS_2026-10.md) (R1–R11).

## 9. Internacionalización

| Elemento | Estado |
|---|---|
| Cada empresa tiene país, moneda, zona horaria e idioma | OBJETIVO ESTRATÉGICO (P6) |
| El esquema de la POC admite Brasil (BR, BRL, `America/Sao_Paulo`) y Colombia (CO, COP, `America/Bogota`), con fecha contable por zona | VALIDADO TÉCNICAMENTE (INTL-001…003) |
| Zona horaria por empresa como reloj de los periodos (el dispositivo deja de contar) | PENDIENTE (DS-04). Abierto también: empresas con rutas en varias zonas horarias (Brasil tiene más de una) |
| COP: precisión de almacenamiento (2 decimales ISO 4217) frente a presentación y redondeo comercial (uso local sin centavos) | PENDIENTE |
| Idiomas de la interfaz (hoy español) y portugués para Brasil | PENDIENTE |
| Documentos de identificación, formatos y requisitos legales o regulatorios por país | PENDIENTE — no se implementa nada sin aprobación |
| Conversión entre monedas | **No prevista.** Cada empresa opera en una sola moneda; no se implementa conversión sin decisión expresa |

## 10. Escalabilidad, rendimiento y continuidad

**Escalar a numerosas empresas es un OBJETIVO ESTRATÉGICO y un requisito de diseño. No es una capacidad demostrada.** Este documento no afirma que la plataforma soporte hoy 100, 1.000 ni ninguna otra cifra de empresas.

| Elemento | Estado |
|---|---|
| Concurrencia correcta con hasta 20 operaciones simultáneas sobre un mismo saldo | VALIDADO TÉCNICAMENTE (escala de prueba, no de producción) |
| Medición de rendimiento, tamaño de *pool*, latencia entre países (Bogotá ↔ São Paulo) | PENDIENTE (Fase 0A, limitación 9; Fase 0A.1, limitación 5) |
| Pruebas progresivas de carga con muchas empresas, rutas y operaciones concurrentes | PENDIENTE |
| Copias, PITR, procedimiento de recuperación probado y objetivos de recuperación | PENDIENTE (DS-02, DS-14) |
| Observabilidad desde el primer día (métricas, registros, alertas) | OBJETIVO ESTRATÉGICO |

Principio de crecimiento (P7): crecer por **evolución controlada** —módulos con contratos claros, índices y consultas eficientes, API sin estado, capacidad de aumentar recursos— y no reconstruyendo el sistema por cada cliente o país. No se promete que nunca hará falta rediseñar una parte.

## 11. Administración comercial y plano de control

| Elemento | Estado |
|---|---|
| ADEX tiene un plano de control **Owner** para empresas, suscripciones y configuración comercial | APROBADO (existe en local; [ARQUITECTURA_OWNER_SUPERADMIN_2026-09.md](./ARQUITECTURA_OWNER_SUPERADMIN_2026-09.md)) |
| **Ser Owner no da autoridad financiera sobre las empresas.** No hay impersonación ni «modo cliente» | APROBADO (documento Owner/SuperAdmin) |
| Por el canal del plano de control viajan solo datos estructurales y comerciales; nunca datos operativos | APROBADO ([CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md §2](./CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md#2-la-regla-que-no-se-puede-romper)) |
| Plano de control en el mismo servidor que la operación, o separado | PENDIENTE (DS-17) |
| Plano de control compartido entre dispositivos (hoy es local) | PENDIENTE |
| Planes de suscripción y precios | PENDIENTE — no los fija este documento |

## 12. Principios de migración desde la aplicación local

- **CLEAN sigue funcionando con datos locales** e independiente durante toda la transición (P8).
- Las fases 1–6 se construyen en *staging* con datos sintéticos. **Ninguna empresa real** usa el servidor antes de la Fase 7.
- Cada tipo de operación pasa del modo local al servidor de una sola vez y por empresa; nunca coexisten escrituras de dinero locales y del servidor sobre el mismo dato.
- **Ningún navegador es fuente de verdad automática.** Cada empresa real se migra solo tras exportación, diagnóstico, conciliación y **aprobación firmada del propietario**. Las anomalías se reportan, no se corrigen con asientos automáticos.
- El procedimiento está en [PLAN_MIGRACION_SAAS_2026-10.md §4](./PLAN_MIGRACION_SAAS_2026-10.md#4-datos-históricos-diagnóstico-exportación-y-conciliación).

## 13. Estado actual del desarrollo (2026-10-14)

| Pieza | Situación |
|---|---|
| Producción CLEAN | https://rutacash-clean.vercel.app, bundle `index-b05G8Ybt.js` (verificado en el cierre de la Fase 0A.1). Aplicación **local-first**: cada navegador guarda todo en su IndexedDB (Dexie v16) |
| Motor financiero local | Saneado (rondas 6A–6C.1) y cubierto por **26 suites, 1.600 casos, 0 fallos** |
| Arquitectura SaaS | Documentada (Ronda 6D, `315099c`). DS-01, DS-05 y DS-15 aprobadas |
| Fase 0A (`78a6401`) | POC con PostgreSQL real local: 12 de 13 criterios validados |
| Fase 0A.1 (`f4357ba`) | Supabase gestionado real: 50 PASS · 0 FAIL · 1 SKIP, aceptado por el propietario. Proyecto, esquema `adex` y roles **se conservan** para revisión; `--teardown` no ejecutado |
| Backend financiero multiusuario | **No existe.** Lo que hay es la POC transaccional sintética de las Fases 0A/0A.1 (`experiments/saas-phase0a/`), descartable y fuera de la aplicación publicada |
| Fase 1 | **No iniciada** |
| Hoy entre dispositivos | **No hay datos compartidos.** Dos equipos tienen dos bases distintas; las diferencias son divergencias silenciosas, no conflictos resueltos |

## 14. Capacidades demostradas frente a capacidades pendientes

«Validado técnicamente» se refiere a la POC sintética, no al backend de ADEX, que todavía no existe.

| Capacidad | Validado técnicamente (POC, datos sintéticos) | En producción |
|---|---|---|
| Una identidad con varias membresías, sin herencia de permisos | Sí | No |
| Aislamiento entre empresas (API + RLS) | Sí | No |
| Un saldo no se consume dos veces bajo concurrencia | Sí | No (solo dentro de un navegador) |
| Idempotencia por operación | Sí | Parcial: 5 servicios locales; los pagos no |
| Movimiento y auditoría atómicos | Sí | Solo local |
| Autenticación real con proveedor gestionado | Sí (Supabase Auth) | No: contraseñas locales en texto plano |
| Brasil y Colombia en el modelo de datos | Sí (esquema POC) | No |
| Rendimiento y capacidad con muchas empresas | **No medido** | No |
| Recuperación ante desastres | **No probada** | No |
| Reglas financieras D24–D30, D7, capital v16 | Sí (1.600 casos, motor local) | Sí, **en local por navegador** |

## 15. Decisiones aprobadas

| Decisión | Contenido |
|---|---|
| **Visión SaaS** (este documento) | Plataforma comercial multiempresa, escalable e internacional, sobre infraestructura central compartida |
| **Mercados iniciales** | Brasil y Colombia; expansión prevista por Sudamérica |
| **Principios P1–P10** | §19 |
| **DS-01** | API TypeScript propia + PostgreSQL gestionado |
| **DS-05** | Identidad única, membresías independientes, contexto activo explícito, sin herencia |
| **DS-15** | Tablas compartidas en PostgreSQL, aislamiento por empresa con RLS y autorización en la API; infraestructura dedicada solo como excepción justificada |
| **Reglas de negocio** | D7, D24, D25, D26, D28, D29, D30 y capital por Administrador (v16) |
| **Separación Owner / empresa** | Sin impersonación; el canal Owner no transporta datos operativos |

## 16. Decisiones todavía abiertas

| ID | Tema | Relación con la visión |
|---|---|---|
| DS-02 | Proveedor de PostgreSQL y hosting, plan, presupuesto, copias y PITR | Supabase es candidato validado, no elegido |
| DS-03 | Proveedor de identidad y corte del token en operaciones financieras | Supabase Auth es candidato validado, no elegido |
| DS-04 | Zona horaria de los periodos | Necesaria para operar en varios países |
| DS-06 | Importación de la historia | Condiciona la primera empresa real |
| DS-07, DS-08 | Operación sin conexión y su conciliación | Experiencia del Cobrador |
| DS-09 | Notificaciones | — |
| DS-10, DS-11 | Documento único de cliente; borrados físicos | Integridad de datos |
| DS-12 | Empresa piloto y criterio de éxito | Es una **validación**, no el objetivo comercial (P9) |
| DS-13 | Residencia de datos y normativa aplicable | Ampliada a **Brasil y Colombia** y a la expansión sudamericana. Sin residencia elegida ni cumplimiento evaluado |
| DS-14 | Retención de auditoría y copias; registro de seguridad | Requisito antes de comercializar (P10) |
| DS-16 | Procedimiento de exportación de datos locales | Migración |
| DS-17 | Plano de control integrado o separado | Al resolverla, revisar quién calcula `billableRouteCount` (A6) |
| D1–D4, D19–D23, D27, Secretario | Decisiones de negocio previas | No se resuelven por migrar |
| COP | Decimales de presentación y redondeo | Colombia |
| Fase 1 | Inicio | Requiere aprobación expresa |
| Limpieza 0A.1 | Cuándo ejecutar `--teardown`, revocar el token y pausar o borrar el proyecto Supabase | Decisión del propietario |

## 17. Criterios estratégicos para evaluar nuevas funcionalidades

Antes de aprobar una funcionalidad, responder:

1. **¿Funciona para muchas empresas o solo para una?** Lo específico de un cliente se resuelve con configuración por empresa, no con ramas de código.
2. **¿Respeta el aislamiento?** Ningún dato, permiso, capital ni informe puede cruzar empresas.
3. **¿Mueve dinero?** Si sí: comando de servidor, transacción, idempotencia, auditoría y prueba de concurrencia. Nunca escritura local autoritativa.
4. **¿Conserva las reglas aprobadas?** Si cambia una regla D, requiere decisión expresa y documentada.
5. **¿Depende del país?** Moneda, zona horaria, idioma, formatos y normativa se parametrizan por empresa, no se fijan en el código.
6. **¿Escala?** Consultas indexadas y acotadas por empresa y ruta; sin procesos que recorran todas las empresas en una operación interactiva.
7. **¿Funciona con mala conectividad?** Y si no debe funcionar sin conexión, ¿lo impide de forma clara?
8. **¿Se puede probar con más de dos empresas y más de dos equipos?**
9. **¿Introduce dependencia de proveedor?** Preferir PostgreSQL estándar y contratos propios.
10. **¿Respeta la frontera Owner / empresa?**

## 18. Referencias a documentación técnica vigente

| Documento | Para qué |
|---|---|
| [AUDITORIA_PREPARACION_SAAS_2026-10.md](./AUDITORIA_PREPARACION_SAAS_2026-10.md) | Estado del código local y del modelo Dexie v16 |
| [INVARIANTES_FINANCIERAS_2026-10.md](./INVARIANTES_FINANCIERAS_2026-10.md) | Reglas que el servidor debe garantizar |
| [RIESGOS_CONCURRENCIA_SAAS_2026-10.md](./RIESGOS_CONCURRENCIA_SAAS_2026-10.md) | Riesgos R1–R11 entre dispositivos |
| [ARQUITECTURA_SAAS_PROPUESTA_2026-10.md](./ARQUITECTURA_SAAS_PROPUESTA_2026-10.md) | Opciones evaluadas y forma del sistema |
| [PLAN_MIGRACION_SAAS_2026-10.md](./PLAN_MIGRACION_SAAS_2026-10.md) | Fases, puertas de aceptación y migración |
| [DECISIONES_PENDIENTES_SAAS_2026-10.md](./DECISIONES_PENDIENTES_SAAS_2026-10.md) | Registro de decisiones DS y D |
| [SAAS_FASE_0A_RESULTADOS.md](./SAAS_FASE_0A_RESULTADOS.md) | Evidencia de la POC con PostgreSQL |
| [SAAS_FASE_0A1_RESULTADOS.md](./SAAS_FASE_0A1_RESULTADOS.md) | Evidencia con Supabase gestionado |
| [CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md](./CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md) | Contrato del plano de control Owner |
| [ARQUITECTURA_OWNER_SUPERADMIN_2026-09.md](./ARQUITECTURA_OWNER_SUPERADMIN_2026-09.md) | Separación Plataforma / Empresa |

---

## 19. Principios no negociables

| # | Principio | Contenido exigible |
|---|---|---|
| **P1** | Multiempresa desde la arquitectura | Cada empresa es un ámbito independiente. Aislamiento estricto de datos, operaciones, permisos, capital y registros financieros. La infraestructura se comparte; las empresas no se mezclan |
| **P2** | Única fuente de verdad financiera | El PostgreSQL central es la autoridad del estado financiero. Ningún navegador mantiene un libro independiente que se considere autoritativo a la vez |
| **P3** | Integridad financiera | Se conservan las reglas aprobadas y probadas. Cada movimiento: autorización, validación, atomicidad, idempotencia y auditoría. Sin dobles desembolsos, pagos duplicados ni consumo concurrente del mismo capital |
| **P4** | Identidad única y roles independientes | DS-05: una persona, varias membresías, contexto activo explícito en cada operación. Sin acumular ni heredar permisos entre roles o empresas |
| **P5** | Administración comercial central | Plano de control Owner para empresas, suscripciones y configuración comercial. El acceso de plataforma **no** equivale a autoridad financiera sobre las empresas |
| **P6** | Preparación internacional | País, moneda, zona horaria, idioma, formatos e identificación por país, y requisitos legales aplicables. No se implementan regulaciones, integraciones ni conversiones no aprobadas |
| **P7** | Crecimiento sin reconstrucción innecesaria | Arquitectura modular, contratos claros, observabilidad, consultas eficientes, recuperación y capacidad de aumentar recursos. Evolución controlada; no se promete que nunca habrá rediseños |
| **P8** | Desarrollo y migración gradual | Se conservan las funcionalidades y reglas existentes. CLEAN independiente durante la transición. Ninguna empresa real se migra sin diagnóstico, conciliación y autorización |
| **P9** | Pruebas representativas del objetivo comercial | Dos equipos o dos empresas son validaciones iniciales, no el objetivo. Las fases futuras incluyen pruebas con múltiples empresas, concurrencia financiera, aislamiento, rendimiento, recuperación y capacidad |
| **P10** | Seguridad y cumplimiento antes de comercializar | Autenticación central, autorización en el servidor, protección de datos y trazabilidad. Infraestructura y residencia evaluadas para Brasil, Colombia y futuros mercados. **No se declara cumplimiento legal sin evaluación** |

## 20. Aclaraciones sobre documentos anteriores (resueltas por el propietario el 2026-10-14)

| # | Documento | Diferencia | Resolución |
|---|---|---|---|
| A1 | `DECISIONES_PENDIENTES_SAAS_2026-10.md` | Decía «Todas abiertas», pero DS-01 y DS-05 se aprobaron después | **Aplicada:** DS-01 y DS-05 registradas como aprobadas. DS-02 y DS-03 siguen como candidatos validados técnicamente, sin aprobación |
| A2 | `DECISIONES_PENDIENTES_SAAS_2026-10.md` (DS-15) | La visión es coherente con la propuesta de esquema compartido + RLS | **Aprobada por el propietario el 2026-10-14:** tablas compartidas + RLS + autorización en la API; infraestructura dedicada como excepción justificada |
| A3 | `DECISIONES_PENDIENTES_SAAS_2026-10.md` (DS-13) | Solo mencionaba Brasil | **Aplicada:** Brasil y Colombia como mercados iniciales y Sudamérica como expansión. Sin residencia ni cumplimiento asumidos |
| A4 | DS-12 y fases 7–8 del plan | El piloto podría leerse como objetivo del producto | **Mantenida:** el piloto es una validación (P9) |
| A5 | `future-roadmap.md` | Proponía Edge Functions y sincronización bidireccional | **Aplicada:** advertencia de documento histórico al inicio; contenido original intacto |
| A6 | `CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md` §3.1 | El servidor recibe `billableRouteCount` ya calculado por el cliente | **Documentada** como revisión pendiente en DS-17. Sin cambios de código ni de reglas de facturación |
| A7 | `database-schema.md` | Ya marcado como desactualizado | Sin acción |

Ajustes adicionales de esta revisión, en [PLAN_MIGRACION_SAAS_2026-10.md](./PLAN_MIGRACION_SAAS_2026-10.md):
- Se distinguen las reglas vigentes (D7, D24–D26, D28–D30, capital v16) de las decisiones abiertas (D1–D4, D19–D23, D27, Secretario).
- La Fase 0 ya no exige aprobar todas las DS-01…DS-12 de antemano: cada decisión se aprueba antes de la implementación que depende de ella. Las puertas de aceptación se mantienen.
- Se separa la POC transaccional sintética del backend financiero multiusuario, que todavía no existe.
