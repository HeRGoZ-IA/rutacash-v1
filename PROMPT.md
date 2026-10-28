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

*Actualizado: 2026-10-27 (Ronda 77)*

1. **Objetivo actual:** R76 cerrada.
   * Listado canónico de pendientes al día.
   * Mora al día publicada.
   * Desactivación de trabajadores con efectivo resuelta por diseño.
   * Propuesta de respaldos lista. Falta que Helmer decida RS-1…RS-5.
2. **Qué quedó hecho:**
   * `865844a`: la API calcula el estado «vencida» y los días de mora al leer, con la fecha contable de la empresa.
     * No escribe nada ni mueve dinero.
     * Desplegado a mano en Render `adex-online-api`.
   * Prueba RB-021: un Cobrador desactivado sigue en el cuadre («· inactivo») y su efectivo se puede recibir.
     * Sin cambios funcionales.
   * Antes, en R75: cierre del mismo día publicado (`bca28d3`, migración 0038 en staging).
   * **Probado:**
     * PostgreSQL: 589 aprobadas, 0 fallidas, 1 omitida.
     * Pruebas unitarias 31/31.
     * E2E 86/86, 41/41 y 25/25.
     * Pruebas nuevas MORA-001…003 y RB-021.
   * **No probado:** la mora con datos reales de BlueLine (no se escribió nada en BlueLine).
3. **Qué falta:**
   * **Respaldos: alternativa A activa (2026-10-26).** Clave de recuperación creada y comprobada (en Bitwarden y en la libreta de Helmer). Tareas registradas: copia diaria a las 21:30, ensayo los lunes a las 10:00 y vigilancia. Revisar el primer resultado automático (`npm run backup -- estado` y `ADEX-respaldos/registro.log`).
   * **Siguiente trabajo propuesto (3.1):** búsqueda sin acentos en Clientes del Administrador (`online/src/bridge/pages/admin/ClientsPage.tsx`), Clientes del Secretario (`src/pages/secretario/SecretarioClientsPage.tsx`) y Usuarios (`online/src/bridge/pages/admin/UsersPage.tsx`). Usar `foldText` de `src/lib/searchFilter.ts`. Verificado en el código el 2026-10-26: no está hecho. Espera el «sí» de Helmer.
   * **Para el chat Central:** implementar 3.14, la casilla «Para Cobradores» de los tipos de gasto (2.1.15 aprobada), y 3.17, anulaciones solo por el Administrador (RB-D11 y RB-D12).
   * **Peticiones del socio (2026-10-27), para el chat Central:** 3.16 mostrar la fecha del desembolso y 3.15 pagar por número de cuotas en todos los roles que registran abonos. Las dos con prioridad alta y ya definidas.
   * Siguen abiertas RS-4 (Supabase Pro antes de la primera empresa comercial) y RS-5 (PITR).
   * El socio prueba un cierre real del mismo día y el buscador en el celular.
   * Resto: `docs/ADEX_PENDIENTES_CONSOLIDADOS_2026-10-24.md`, que es el **listado canónico**.
4. **Decisiones tomadas:**
   * 2026-10-27:
     * No se bloquea la desactivación de trabajadores con efectivo (2.3.9, opción A).
     * Tipos de gasto: un solo listado con casilla «Para Cobradores»; el Supervisor igual que el Cobrador; marcados al inicio Transporte, Alimentación y Combustible (2.1.15).
     * El faltante de un acta de entrega queda como faltante de la ruta; no se carga al Administrador saliente (RB-D10, opción A).
     * Solo el Administrador anula o reversa movimientos y gastos, también los que registró él mismo; sustituye en parte a F5-D02 (RB-D11). Un gasto general se anula completo y solo por el Administrador que lo registró (RB-D12).
     * Pagar por cuotas: «N cuotas» = lo que falta de la parcela actual más las siguientes, sin pasar del total; aplica a Cobrador, Administrador y Secretario (3.15).
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
