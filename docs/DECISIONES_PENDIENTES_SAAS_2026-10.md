# ADEX Soluciones — Decisiones pendientes para la transformación SaaS (Ronda 6/6D)

| | |
|---|---|
| Fecha | 2026-10-12 · `main` @ `520a331` |
| Estado | Redactado con todas las decisiones abiertas. **Actualización 2026-10-14:** DS-01 y DS-05 están **aprobadas** por el propietario (registradas en la Fase 0A, 2026-10-13). DS-15 **aprobada** el 2026-10-14. Las demás siguen abiertas. Las «propuestas» son recomendaciones técnicas, no decisiones |
| Documento rector | [VISION_Y_PRINCIPIOS_SAAS_ADEX.md](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md) |
| Contexto | [Auditoría](./AUDITORIA_PREPARACION_SAAS_2026-10.md) · [Invariantes](./INVARIANTES_FINANCIERAS_2026-10.md) · [Riesgos](./RIESGOS_CONCURRENCIA_SAAS_2026-10.md) · [Arquitectura](./ARQUITECTURA_SAAS_PROPUESTA_2026-10.md) · [Plan](./PLAN_MIGRACION_SAAS_2026-10.md) |

## 1. Decisiones necesarias antes de iniciar la Fase 1

| ID | Pregunta | Opciones | Propuesta técnica | Bloquea |
|---|---|---|---|---|
| **DS-01** · **APROBADA** | ¿Qué arquitectura se adopta? **Aprobado:** API TypeScript propia con comandos transaccionales + PostgreSQL gestionado como sistema de registro | A: API TypeScript + PostgreSQL · B: Supabase con funciones · Híbrido A+B · Otra | A (o el híbrido A+B si conviene por coste u operación): reutiliza las reglas y pruebas TypeScript y permite transacciones de varias filas con bloqueo | Todo |
| **DS-02** · **Aprobada solo para staging** (2026-10-14: Supabase PostgreSQL Free, `sa-east-1`, datos sintéticos; producción, presupuesto y PITR siguen abiertos) | ¿Qué proveedor de PostgreSQL y de hosting de la API? ¿Qué presupuesto mensual? **Supabase PostgreSQL: candidato validado técnicamente (Fase 0A.1), sin aprobación comercial ni operativa** | Cualquier Postgres gestionado con copias y PITR; hosting de procesos persistentes o serverless con pooler | Elegir por copias y recuperación, región, coste y pooler; sin dependencia de funciones propietarias para la lógica de dinero | Fase 0 |
| **DS-03** · **Aprobada** (2026-10-14: Supabase Auth, ES256/JWKS, sin migrar contraseñas; corte de sesión por registro ADEX en PostgreSQL, ver [Fases 0–1](./SAAS_FASES_0_1_RESULTADOS.md)) | ¿Cómo se gestiona la identidad? **Supabase Auth: candidato validado técnicamente (Fase 0A.1), sin aprobación comercial ni operativa** | Proveedor externo (IdP) · Auth de Supabase · biblioteca propia sobre Postgres | Solución probada (no hecha a mano): contraseñas con hash, sesiones revocables, recuperación. **Las contraseñas actuales no se migran**: cada usuario las restablece | Fase 1 |
| **DS-04** | ¿Qué hora y calendario rigen los periodos? | Zona horaria por empresa · por oficina · fija | **Zona horaria por empresa**, guardada en el servidor; semanas como hoy (rango propio de cada cierre; la interfaz propone lunes–sábado). El reloj del dispositivo deja de contar | Fase 6 |
| **DS-05** · **APROBADA** | ¿Una cuenta por rol (como hoy) o una persona con varias membresías? **Aprobado:** identidad única por persona, membresías independientes por empresa y rol, contexto activo explícito, sin herencia ni acumulación de permisos | Mantener cuentas separadas (correo único por cuenta) · identidad única con roles por empresa | Identidad única con **membresías separadas y sin herencia de permisos**: el usuario elige con qué rol opera y queda auditado con ese rol. Mantener las cuentas separadas también es válido; decidir antes del modelo de identidad | Fase 1 |
| **DS-06** | ¿Cómo se importa la historia? | Histórico completo como movimientos vivos · histórico como legado de solo lectura + saldos de apertura validados · solo saldos de apertura | Legado de solo lectura + saldos de apertura firmados por el propietario. Movimientos vivos solo si el diagnóstico sale limpio | Fase 7 |
| **DS-07** | ¿Qué operaciones se permiten sin conexión? | Ninguna · pagos y visitas · pagos, visitas y gastos de trabajador · más | Pagos en efectivo y visitas sin pago, con `operationId` y validación al llegar. **Nunca** desembolsos, Base, capital, cierres ni correcciones | Fase 4 |
| **DS-08** | ¿Qué pasa con una operación sin conexión que llega después de cerrar su periodo o con el saldo agotado? | Rechazar · registrar en el periodo abierto con la fecha de captura informativa · cola de conciliación | Pagos: registrar en el periodo abierto si caben en el saldo; si no, cola **para conciliar** (sin dinero fuera de reglas) | Fases 4 y 6 |
| **DS-09** | ¿Qué notificaciones y por qué canal? | En la app · correo · mensajería · push | Empezar en la app (eventos por empresa y ruta); otros canales después | Funcionalidades futuras |
| **DS-10** | ¿Debe ser único el documento del cliente por empresa? | Sí · no (solo aviso) | Único por empresa con excepción auditada: evita duplicados entre dispositivos (R10) | Fase 2 |
| **DS-11** | ¿Se permiten borrados físicos de usuarios, rutas y clientes con historia? | Mantener (como hoy en `UsersPage`, `RoutesPage`, `ClientsPage`) · solo desactivar si tienen historia | Solo desactivación cuando existan movimientos; borrado físico únicamente de registros sin historia | Fase 2 |
| **DS-12** | ¿Cuál es la empresa piloto, cuánto dura el piloto y qué cuenta como éxito? | — | Una empresa con pocas rutas; periodo mínimo de dos cierres semanales completos; criterio: conciliación diaria `cuadra` y cero incidencias críticas | Fase 7 |

## 2. Decisiones de seguridad, cumplimiento y operación

| ID | Pregunta | Nota |
|---|---|---|
| **DS-13** | ¿Dónde residen los datos y qué legislación de protección de datos aplica? Mercados iniciales: **Brasil y Colombia**; expansión prevista: otros países de Sudamérica (ver [visión](./VISION_Y_PRINCIPIOS_SAAS_ADEX.md)). Por ejemplo, la LGPD en Brasil y la normativa colombiana de protección de datos personales | Condiciona la región del proveedor, los contratos y la retención. **No hay residencia de datos elegida ni cumplimiento legal evaluado o aprobado.** Debe confirmarlo el propietario, con asesoría si hace falta |
| **DS-14** | ¿Retención y acceso de auditoría y copias de seguridad (plazos, quién las consulta)? | El servidor auditará en la misma transacción que cada comando |
| **DS-15** · **APROBADA** | Multiempresa: ¿esquema compartido con `tenant_id` + RLS, o una base o esquema por empresa? | **Aprobado (2026-10-14):** PostgreSQL con tablas compartidas, aislamiento por empresa mediante RLS y autorización en la API. La infraestructura dedicada a una empresa es una excepción justificada |
| **DS-16** | ¿Quién puede ejecutar la herramienta de exportación y diagnóstico en los equipos actuales, y cómo se transportan los archivos? | Los datos de clientes viajan fuera del navegador: se necesita un procedimiento acordado |
| **DS-17** · **Aprobada** (2026-10-14: mismo PostgreSQL, plano separado —esquema y rol propios—; `billableRouteCount` lo calcula el servidor) | ¿Se integra el plano de control (Owner) en el mismo servidor o se mantiene separado como define `CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md`? | Ese documento exige canales separados para datos estructurales y operativos; la propuesta lo respeta. **Revisión pendiente al resolver DS-17:** ese documento (§3.1) hace que el servidor reciba `billableRouteCount` ya calculado por el cliente; con PostgreSQL central habrá que decidir si lo calcula el servidor. La regla de facturación (`status === 'activa'`) no cambia |

## 3. Decisiones de negocio anteriores que siguen abiertas

| ID | Pregunta | Origen | Impacto en el SaaS |
|---|---|---|---|
| **D1** | ¿Caja socios debe tener fondos? ¿Ruta ↔ Socio pasa por la bolsa? | Especificación V2 | Define una restricción del comando `transfer` (hoy sin control de saldo, caso Barreiro) |
| **D2** | Movimientos entre Administradores distintos (hoy en varios pasos) | Especificación V2 | Ratificación entre dos personas: requiere servidor |
| **D3** | ¿Confirmación de recepción del trabajador? | Especificación V2 | Solo verificable con servidor |
| **D4** | ¿El Supervisor registra entregas desde su posición? ¿Su cierre de cuadre le acredita el efectivo? | Especificación V2 | Autoridad `settle` del comando de custodia |
| **D19–D23** | Aviso de aporte no financiero, registro por la cuenta Socio, cuenta en sesión visible, aviso al cuadrar con aporte abierto, aviso de duplicado | Pre-Ronda 6 | Flujos entre dispositivos |
| **D27** | Solicitud de Base del trabajador al responsable | Ronda 6A | Solo útil con servidor |
| **Secretario** | **Hipótesis no aprobada:** el Secretario registra un movimiento físico ya ocurrido, las partes lo ratifican y un rechazo lo deja en disputa sin revertir fondos | Ronda 6A | Debe decidirse antes de dar al Secretario cualquier comando financiero. Hoy no tiene ninguno |

## 4. Lo que el propietario necesita aprobar para autorizar la primera entrega

1. **DS-01** (arquitectura): **aprobada**. **DS-02** (proveedor y presupuesto): abierta.
2. **DS-03** (identidad): abierta. **DS-05** (modelo de cuentas): **aprobada**.
3. **DS-13** (residencia de datos y legislación).
4. Alcance de la primera entrega: **Fase 0 + Fase 1** (esquema, banco de pruebas de contratos e identidad central) en staging, **sin ninguna empresa real**.

Hasta esa aprobación no se escribe código de servidor ni se instala ninguna dependencia.

> **Nota (2026-10-14).** Las Fases 0A y 0A.1 (`experiments/saas-phase0a/`) fueron autorizadas expresamente como **prueba de concepto sintética y descartable**. Validan el patrón transaccional, pero **no son el backend financiero multiusuario de ADEX, que todavía no existe**, ni inician la Fase 1.

## 5. Decisiones de la Fase 5 aprobadas por el propietario (2026-10-17)

Identificadores propios de la Fase 5 (no se usan en las series D1–D30 ni DS-01…DS-17). Detalle y pruebas en [SAAS_FASE_5_RESULTADOS.md](./SAAS_FASE_5_RESULTADOS.md).

| ID | Decisión | Estado |
|---|---|---|
| **F5-D01** | Reparto de cada recaudo entre capital e interés: proporcional acumulado. Capital acumulado = redondeo determinista de pagado acumulado × capital / total pactado; interés = pagado − capital; cada pago imputa la diferencia de acumulados. Clasificación financiera interna del SaaS, no política fiscal o contable legal | **APROBADA** |
| **F5-D02** | Anulación auditada de gastos de trabajador y de ruta por el Administrador responsable de capital de la ruta o el SuperAdmin, nunca por la persona que registró el gasto (comparación por identidad). Periodo cerrado (D7): ajuste nuevo en el periodo abierto con autoridad de ajustes, sin reabrir. El importe vuelve a la cuenta que pagó | **APROBADA** |
