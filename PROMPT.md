# PROMPT.md — RutaCash (ADEX Soluciones)

## 1. Identidad del proyecto

* Nombre formal: ADEX Soluciones (antes RutaCash)
* Nombre corto: RutaCash / ADEX
* Tipo: PRODUCTO_COMERCIAL / APP_WEB
* Área HRWorkSpace: 01_PRODUCTOS_COMERCIALES
* Estado actual: ACTIVO — desarrollo diario; ADEX Online en uso con la empresa real BlueLine
* Ruta: `C:\HRWorkSpace\01_PRODUCTOS_COMERCIALES\RutaCash`
* Repositorio: GitHub `HeRGoZ-IA/rutacash-v1`, rama `main`
* Propósito: plataforma SaaS multiempresa para negocios de préstamo y cobro diario por rutas. Cada empresa sabe
  cuánto dinero tiene, dónde está y quién responde por él.
* Stack: React + Vite + TypeScript (frontend CLEAN en `src/`, compilado por `online/` con un puente hacia la API);
  API Node/TypeScript en Docker (`saas/`, `deploy/`); PostgreSQL gestionado (Supabase «ADEX-Staging»).
* Despliegue:
  * Vercel: ADEX Online (`adex-online.vercel.app`), se publica solo con cada push a `main`.
  * Render: API de empresas y API Owner, que se despliegan **solo a mano**.
  * Las migraciones de staging las ejecuta el propietario.
* Contexto ampliado: `README.md`, `docs/VISION_Y_PRINCIPIOS_SAAS_ADEX.md` y `docs/REGISTRO_MAESTRO_EVOLUCION_ADEX.md`, que es el índice oficial de rondas, migraciones y despliegues.

## Dónde quedamos

*Actualizado: 2026-10-27 (Ronda 78)*

1. **Objetivo actual:** implementar en el chat Central los pendientes aprobados. Orden recomendado: 3.17 (anulaciones solo por el Administrador, RB-D11/RB-D12; lleva migración y Render), 3.14 (casilla «Para Cobradores» en tipos de gasto; lleva migración) y 3.12 (RB-D13, reembolso entre Administradores).
2. **Qué quedó hecho:**
   * Ronda 78 (`225dbc6`, Vercel, 2026-10-27): peticiones del socio 3.15 (campo «Cuotas a pagar» en el cobro del Cobrador/Supervisor y en «Registrar recaudo» del Administrador; el Secretario no registra abonos) y 3.16 (fecha del desembolso; columna «Inicio de cobro» corregida).
   * Ronda 77 (`bffdfc1`): búsqueda sin acentos en Clientes y Usuarios.
   * Ronda 76: mora al día (`865844a`, Render) y respaldos con la alternativa A activa (copias diarias cifradas en OneDrive, clave de recuperación comprobada, tareas registradas; primera copia automática `adex-20261027T1947`).
   * **Probado:** pruebas financieras (CUOTAS-001…003), las de CLEAN, los tipos y E2E 89/89, 41/41 y 25/25. **No probado:** con datos reales ni por el socio.
3. **Qué falta:**
   * Implementar 3.17, 3.14 y 3.12 (ver arriba). En 3.14, decidir con Helmer qué casillas recibe BlueLine.
   * Petición del socio 3.18 (alta): en Gastos del Cobrador y del Supervisor, separar los gastos ya cerrados en un bloque plegado. Toca la misma pantalla que 3.14.
   * Que el socio valide 3.15, 3.16, el cierre del mismo día y el buscador en su celular.
   * Siguen abiertas RS-4 (Supabase Pro antes de la primera empresa comercial) y RS-5 (PITR).
   * Grupo de chats «ADEX - RutaCash» (2026-10-27): Central, Errores o bugs, Peticiones del socio, Ideas y producto, Respaldos y operación, Decisiones pendientes. Solo Central y Errores tocan código.
   * Resto: `docs/ADEX_PENDIENTES_CONSOLIDADOS_2026-10-24.md`, que es el **listado canónico**.
4. **Decisiones tomadas:**
   * 2026-10-27:
     * No se bloquea la desactivación de trabajadores con efectivo (2.3.9, opción A).
     * Tipos de gasto: un solo listado con casilla «Para Cobradores»; el Supervisor igual que el Cobrador; marcados al inicio Transporte, Alimentación y Combustible (2.1.15).
     * El faltante de un acta de entrega queda como faltante de la ruta; no se carga al Administrador saliente (RB-D10, opción A).
     * Solo el Administrador anula o reversa movimientos y gastos, también los que registró él mismo; sustituye en parte a F5-D02 (RB-D11). Un gasto general se anula completo y solo por el Administrador que lo registró; si ya no está, por el responsable vigente de las rutas (RB-D12).
     * Pagar por cuotas: «N cuotas» = lo que falta de la parcela actual más las siguientes, sin pasar del total; aplica a todos los roles que registran abonos (3.15). El Secretario no registra abonos.
     * Gastos ya cerrados: se muestran aparte y plegados, no se ocultan (3.18, opción A).
   * 2026-10-26:
     * Respaldos: alternativa A con OneDrive y clave de recuperación en el gestor de Helmer (RS-1…RS-3).
     * RB-D13 está aprobado (falta su interfaz).
     * La inyección de Aguas Lindas queda pospuesta: no es un defecto.
     * Las transferencias entre rutas son inmediatas.
     * Prohibido crear clientes o ventas sin conexión.
     * Los riesgos no están aceptados salvo que Helmer lo diga.
   * 2026-10-25: cierre del mismo día con el día bloqueado después.
   * En BlueLine nunca se crean datos ficticios ni se hace una purga global.
5. **Archivos tocados (R76):**
   * `saas/src/credits/service.ts`
   * `saas/src/collections/service.ts`
   * `saas/test/integration/overdue-live.test.ts` (nuevo)
   * `saas/test/integration/r74-route-base.test.ts`
   * `docs/ADEX_PENDIENTES_CONSOLIDADOS_2026-10-24.md`
   * `docs/ADEX_PROPUESTA_RESPALDOS_Y_RECUPERACION.md` (nuevo)
   * `docs/REGISTRO_MAESTRO_EVOLUCION_ADEX.md`
   * Evidencias en `tmp/r76/`.

## Reglas del proyecto

* Requieren autorización expresa de Helmer:
  * las migraciones;
  * las operaciones sobre dinero real;
  * las empresas reales;
  * las cuentas Owner.
* No se reaplican migraciones ni se duplican operaciones financieras.
* Nunca se versionan los archivos `.env*` (salvo `.env.example`), las claves, los datos reales ni `tmp/`.
* Las evidencias de pruebas van en `tmp/` y la documentación en `docs/`.
* No se ejecutan otros comandos mientras corre el E2E local.

## Mantenimiento del índice

Este proyecto aparece en tres sitios:

* `C:\HRWorkSpace\INDICE_HRWORKSPACE.md`
* `00_ADMIN_WORKSPACE\ESTADO_OFICIAL_HRWORKSPACE.md`
* `01_PRODUCTOS_COMERCIALES\README.md`

Si cambia su estado, su propósito, su despliegue o su ubicación, o si se elimina, actualiza también esas filas. La regla completa está en `C:\HRWorkSpace\CLAUDE.md`. Si trabajas desde Claude.ai sin acceso a los archivos, entrega al final el texto actualizado de esas filas para que Claude Code lo aplique.

## Changelog

El historial detallado por rondas está en `docs/REGISTRO_MAESTRO_EVOLUCION_ADEX.md`.

### 2026-10-26 — Ronda 76.1: respaldos

* Script de respaldo versionado.
* Copia `adex-20261026T1535` verificada y en OneDrive.

### 2026-10-26 — Ronda 76

* `865844a`: mora al día (API en Render).
* Desactivación con efectivo resuelta por diseño (RB-021).
* Listado canónico de pendientes actualizado y propuesta de respaldos.

### 2026-10-26 — Cierre del mismo día (publicado)

* Commit `bca28d3` publicado; 0038 aplicada en staging.
* Se implementó la migración 0038 con el aviso en la confirmación. Además se corrigió el enlace «Ir a Liquidación semanal».
* Pruebas en verde en local. Falta aplicar la migración en staging y hacer el push.

### 2026-10-25 — Creación de este PROMPT.md

* Se crea con el bloque de identidad, «Dónde quedamos», las reglas del proyecto y «Mantenimiento del índice», según la regla «Continuidad entre chats» del workspace.

### 2026-10-24 — Buscador de clientes en el celular

* `c1976db`: se cambia el `<select>` nativo por un buscador en el que se puede escribir.
* La búsqueda no distingue acentos. Publicado en Vercel.

### 2026-10-24 — Normalización de nombres de la interfaz

* `9ca7dc4`: se aplican los nombres decididos por Helmer (N-1 a N-6).
* Ejemplos: «Base disponible», «Mi efectivo», «Recaudo», «Capital colocado» frente a «Cartera activa».

### 2026-10 — Ronda 74: Base por Ruta

* Publicada en `8d37c05`.
* Base por Ruta activada en BlueLine; la inyección de capital quedó pospuesta.
