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

*Actualizado: 2026-10-28 (Ronda 81, publicada)*

1. **Objetivo actual:** sin trabajo en curso. Siguiente: actualizar la guía del socio (`docs/GUIA_SOCIO_LIQUIDACIONES_Y_CIERRES.md`) con los nombres nuevos, y el resto del listado canónico (`docs/ADEX_PENDIENTES_CONSOLIDADOS_2026-10-24.md`).
2. **Qué quedó hecho:**
   * Ronda 81 (2026-10-28, **publicada**: `a12d915`, Render y Vercel `index-DrdhlBol.js`, sin migración): 3.19 Liquidaciones con nombres nuevos, aviso del último cierre y fechas propuestas; 3.18 Gastos del Cobrador y Supervisor separados por el último cierre; 3.12 pago de la obligación de otro Administrador probado en pantalla. Probado: PostgreSQL 595/0/1, CLEAN, tipos, E2E 93/46/25. **No probado:** con BlueLine ni por el socio. El texto «Después del último cierre» se ajustó tras el E2E (solo tipos comprobados).
   * Ronda 80 (2026-10-28, **publicada**): 3.14 (`44f7bae`, migración 0040 aplicada por Helmer, respaldo previo `adex-20261028T1542`; Render y Vercel). Casilla «Para Cobradores» en Categorías de gasto; Cobrador y Supervisor solo ven y usan los marcados (lo valida la API); eliminar un tipo con gastos lo quita de la lista y conserva sus gastos; gasto sin conexión con un tipo desmarcado después se acepta y avisa al Administrador. Probado: PostgreSQL 595/0/1, E2E 93/41/25, reversión 11/11, CLEAN y tipos. BlueLine quedó con 3 de 7 tipos marcados. **No probado:** con BlueLine ni por el socio.
   * Ronda 79 (2026-10-28, **publicada**): 3.17, solo el Administrador anula (`ad1f4e9`, migración 0039 aplicada por Helmer). Respaldo previo `adex-20261028T1409` verificado; 0039 verificada en staging en solo lectura; Render `adex-online-api` Live con `1e0e8cf`; Vercel `index-sDnD_a1d.js`. Probado en local: PostgreSQL 590/0/1, E2E 89/41/25, reversión 10/10. **No probado:** con BlueLine ni por el socio.
   * Ronda 78 (`225dbc6`, Vercel, 2026-10-27): peticiones del socio 3.15 (campo «Cuotas a pagar» en el cobro del Cobrador/Supervisor y en «Registrar recaudo» del Administrador; el Secretario no registra abonos) y 3.16 (fecha del desembolso; columna «Inicio de cobro» corregida).
   * Ronda 77 (`bffdfc1`): búsqueda sin acentos en Clientes y Usuarios.
   * Ronda 76: mora al día (`865844a`, Render) y respaldos con la alternativa A activa (copias diarias cifradas en OneDrive, clave de recuperación comprobada, tareas registradas; primera copia automática `adex-20261027T1947`).
   * **Probado:** pruebas financieras (CUOTAS-001…003), las de CLEAN, los tipos y E2E 89/89, 41/41 y 25/25. **No probado:** con datos reales ni por el socio.
3. **Qué falta:**
   * Actualizar la guía del socio con los nombres nuevos de Liquidaciones (3.19).
   * Que el socio valide 3.12, 3.14, 3.15, 3.16, 3.17, 3.18, 3.19, el cierre del mismo día y el buscador en su celular.
   * **Para el chat Central:** implementar 3.20, enlace de restablecimiento de contraseña para usuarios activos (2.3.4 aprobada).
   * RS-4 aprobada: trasladar el proyecto a Supabase Pro de Starcli **solo cuando Helmer lo ordene** (no mientras se prueba la app).
   * Grupo de chats «ADEX - RutaCash» (2026-10-27): Central, Errores o bugs, Peticiones del socio, Ideas y producto, Respaldos y operación, Decisiones pendientes. Solo Central y Errores tocan código.
   * Resto: `docs/ADEX_PENDIENTES_CONSOLIDADOS_2026-10-24.md`, que es el **listado canónico**.
4. **Decisiones tomadas:**
   * 2026-10-28: respaldos RS-5, PITR no por ahora; RS-4, el proyecto actual se trasladará a la organización Pro de Starcli como proyecto propio de ADEX, sin mezclar nada con Starcli Loyalty, cuando valga la pena (aún se prueba la app). Antes de cualquier pago se le dice a Helmer el costo.
   * 2026-10-28: Supabase y Render, proveedores oficiales (2.3.2, DS-02); el nombre «ADEX-Staging» se cambia al trasladar (RS-4). Render sigue Free durante las pruebas; luego solo `adex-online-api` a Starter, ~US$ 7/mes, con orden expresa de Helmer (2.3.3).
   * 2026-10-28: contraseña olvidada (2.3.4, opción B): quien da de alta emite un enlace de restablecimiento auditado para usuarios activos; el correo automático (SMTP) queda para cuando haya dominio propio. Trabajo 3.20 para Central.
   * 2026-10-28: Liquidaciones (3.19): el primer cierre de una ruta tiene «Desde» editable; un cierre reabierto se vuelve a cerrar con fechas libres (el servidor impide solapes).
   * 2026-10-28: tipos de gasto (3.14): BlueLine y las empresas existentes quedan con Transporte, Alimentación y Combustible marcados; el Administrador organiza la lista; eliminar un tipo con gastos nunca borra esos gastos (sale de la lista y conserva el nombre en el historial).
   * 2026-10-27:
     * No se bloquea la desactivación de trabajadores con efectivo (2.3.9, opción A).
     * Tipos de gasto: un solo listado con casilla «Para Cobradores»; el Supervisor igual que el Cobrador; marcados al inicio Transporte, Alimentación y Combustible (2.1.15).
     * El faltante de un acta de entrega queda como faltante de la ruta; no se carga al Administrador saliente (RB-D10, opción A).
     * Solo el Administrador anula o reversa movimientos y gastos, también los que registró él mismo; sustituye en parte a F5-D02 (RB-D11). Un gasto general se anula completo y solo por el Administrador que lo registró; si ya no está, por el responsable vigente de las rutas (RB-D12).
     * Pagar por cuotas: «N cuotas» = lo que falta de la parcela actual más las siguientes, sin pasar del total; aplica a todos los roles que registran abonos (3.15). El Secretario no registra abonos.
     * Gastos ya cerrados: se muestran aparte y plegados, no se ocultan (3.18, opción A).
     * «Cierre» = cierre de ruta de cualquier rango (no solo semanal); «Cuadre» = entrega del trabajador. Menú «Liquidación», ventana «Liquidaciones», pestañas «Cierre de ruta» y «Cuadre por trabajador» (3.19).
   * 2026-10-26:
     * Respaldos: alternativa A con OneDrive y clave de recuperación en el gestor de Helmer (RS-1…RS-3).
     * RB-D13 está aprobado (falta su interfaz).
     * La inyección de Aguas Lindas queda pospuesta: no es un defecto.
     * Las transferencias entre rutas son inmediatas.
     * Prohibido crear clientes o ventas sin conexión.
     * Los riesgos no están aceptados salvo que Helmer lo diga.
   * 2026-10-25: cierre del mismo día con el día bloqueado después.
   * En BlueLine nunca se crean datos ficticios ni se hace una purga global.
5. **Archivos tocados (R81):**
   * `src/pages/admin/WeeklySettlementPage.tsx`, `src/lib/settlementPeriods.ts` (`suggestClosureRange`), `src/components/ui/PendingSettlementsNotice.tsx`, `src/pages/admin/OfficeDetailPage.tsx`
   * `online/src/bridge/pages/collector/CollectorExpensesPage.tsx`; `saas/src/settlements/service.ts` (`listClosedRanges`), `saas/src/http/companyApi.ts`
   * Pruebas: `tests/settlements.test.ts` (SUGGEST-001…004), `saas/test/integration/settlements.test.ts` (DS4-002), E2E I-02a, F-04b, J-01…J-03. Evidencias en `tmp/r80/`.

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

### 2026-10-28 — Ronda 81: Liquidaciones, gastos ya cerrados y RB-D13 (publicada)

* 3.19, 3.18 y 3.12: `a12d915`, sin migración. Publicado en Render y Vercel.

### 2026-10-28 — Ronda 80: tipos de gasto «Para Cobradores» (publicada)

* 3.14: `44f7bae` + migración 0040. Publicado en Render y Vercel tras respaldo verificado.

### 2026-10-28 — Ronda 79: solo el Administrador anula (publicada)

* 3.17 (RB-D11/RB-D12): `ad1f4e9` + migración 0039. Publicado en Render y Vercel tras respaldo verificado.

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
