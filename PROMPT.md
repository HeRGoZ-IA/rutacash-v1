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

*Actualizado: 2026-11-05 (Pendientes puesto al día: 1.7 migración de Valparaíso, DS-06 decidido, 3.25 semana lunes a domingo pendiente, 4.10 validaciones del socio; antes: 3.23, 3.24 y reporte de Ventas publicados)*

1. **Objetivo actual:** barrido de pendientes mientras el socio prueba con BlueLine (va bien: los reportes semanales cuadran igual que en Listos). Grupo B **punto por punto** (pedido de Helmer): 3.20 publicado; 3.5 publicado (solo web); 3.4 publicado (solo web); 3.10 publicado (solo web). **Grupo B terminado.** Grupo D revisado (2026-11-04, solo lectura): 7.4 resuelto; 7.3 y 7.5 obsoletos; decisiones de Helmer (2026-11-04): 7.1 los domingos cuentan (falta: panel y Consultas › Caja con semana lunes–domingo), 7.2 el Supervisor no descarga nada por ahora; 7.6 (D4) sigue esperando. Reporte de Ventas con la fecha del desembolso: **publicado** (`d2adea88`). 3.23 (Informe del día con fecha elegible) **publicado** (`39282b84`, solo web, verify:deploy OK), E2E 97/46/30; falta validación del socio. 3.24 venta olvidada (plan aprobado por Helmer 2026-11-04: los dos casos, máximo 3 días, días cerrados no se reabren): **publicado** (`e173f732`; 0042 aplicada en staging con respaldo `adex-20261104T1659`; Render y Vercel); test:db 607/607, E2E 97/46/32. Falta: validación del socio. Siguiente: limpieza 6.1…6.4 (con permiso). Respaldos nocturnos: DNS corregido (confirmar el de esta noche).
2. **Qué quedó hecho:**
   * 3.10 (**publicado 2026-11-04**, `68f7e654`): la web ya no publica el mensaje ni el autor del commit ni datos del repositorio (lee por nombre solo las 4 variables que usa); el commit sigue visible para `verify:deploy`. Probado: build simulado, tipos, E2E 95/46/30; en producción verify:deploy OK y 0 variables VITE_VERCEL_* en los 81 JS publicados. Falta: nada del socio (no cambia pantallas).
   * 3.4 (2026-11-03, **PUBLICADO** `d8f83211`, verify:deploy OK; falta validación del socio): en Base por Ruta, Detalle de la ruta → «Ver historial de responsables» (cambios con motivo y resultado del conteo). El modelo anterior ya lo tenía desde R26. Solo web. Probado: tipos, E2E 95/46/30 (D-06b). No probado con BlueLine.
   * 3.5 (2026-11-03, **PUBLICADO** `7e5b407f`, verify:deploy OK; falta validación del socio): el aviso de «no se puede eliminar» dice la causa (recaudos, ventas, rutas asignadas…); Rutas y Clientes muestran el aviso del servidor. Las «dos operaciones» de Oficinas ya no existían (pantalla retirada en R26). Solo web. Probado: tipos, CLEAN, E2E 94/46/30. No probado con BlueLine.
   * 3.20 (2026-11-03, **publicado**: `ed237fd1`, 0041 aplicada con respaldo previo `adex-20261103T1532`, Render ambos servicios desplegados a mano por Helmer, Vercel): enlace para cambiar la contraseña de un usuario activo (Usuarios → llave; panel Owner para el SuperAdmin). Al usarlo se reclama la sesión del enlace y se cierran todas las de la persona (ADEX y Supabase). Migración **0041** (evento del Owner). Probado: PostgreSQL 599/0/1, E2E 94/46/29, tipos (3), unitarias 31/31. **No probado:** pantalla Owner en navegador, reversión de 0041, BlueLine.
   * Barrido grupo A (2026-11-03): 3.7 `npm run verify:deploy` comprueba ADEX Online (commit servido, /owner, iconos, módulos de la API; probado contra lo publicado) y `smoke:prod` exige URL de CLEAN local; 3.8 `test:auth-real` bloqueado (escribiría en ADEX-Staging); 3.9 TLS verificado siempre en los scripts de staging (probado con `select 1`); 3.6 lista duplicada `OPERATION_KIND` eliminada (no se usaba); 3.11 «Base disponible» en CLEAN; 6.5 rama y stash de Git limpiados (stash exportado a `tmp/ronda23-respaldo/`). Probado: tipos (3), build Online, CLEAN completa, unitarias saas 31/31. No hace falta Render; no toca a BlueLine.
   * Error 3.21 (2026-10-29, **publicado**: `de7fca0`, Vercel `index-D6d9WyFz.js`, sin migración ni Render): la app del Cobrador abierta o en segundo plano de un día a otro seguía mostrando el día anterior hasta cerrar sesión. Ahora detecta el cambio de fecha (dispositivo y empresa) y relee todo, también sin señal. Probado: E2E 137/137 y 25/25 (A-15b falló sin la corrección), CLEAN, tipos. **No probado:** en el celular del socio.
   * Ronda 81 (2026-10-28, **publicada**: `a12d915`, Render y Vercel `index-DrdhlBol.js`, sin migración): 3.19 Liquidaciones con nombres nuevos, aviso del último cierre y fechas propuestas; 3.18 Gastos del Cobrador y Supervisor separados por el último cierre; 3.12 pago de la obligación de otro Administrador probado en pantalla. Probado: PostgreSQL 595/0/1, CLEAN, tipos, E2E 93/46/25. **No probado:** con BlueLine ni por el socio. El texto «Después del último cierre» se ajustó tras el E2E (solo tipos comprobados).
   * Ronda 80 (2026-10-28, **publicada**): 3.14 (`44f7bae`, migración 0040 aplicada por Helmer, respaldo previo `adex-20261028T1542`; Render y Vercel). Casilla «Para Cobradores» en Categorías de gasto; Cobrador y Supervisor solo ven y usan los marcados (lo valida la API); eliminar un tipo con gastos lo quita de la lista y conserva sus gastos; gasto sin conexión con un tipo desmarcado después se acepta y avisa al Administrador. Probado: PostgreSQL 595/0/1, E2E 93/41/25, reversión 11/11, CLEAN y tipos. BlueLine quedó con 3 de 7 tipos marcados. **No probado:** con BlueLine ni por el socio.
   * Ronda 79 (2026-10-28, **publicada**): 3.17, solo el Administrador anula (`ad1f4e9`, migración 0039 aplicada por Helmer). Respaldo previo `adex-20261028T1409` verificado; 0039 verificada en staging en solo lectura; Render `adex-online-api` Live con `1e0e8cf`; Vercel `index-sDnD_a1d.js`. Probado en local: PostgreSQL 590/0/1, E2E 89/41/25, reversión 10/10. **No probado:** con BlueLine ni por el socio.
   * Ronda 78 (`225dbc6`, Vercel, 2026-10-27): peticiones del socio 3.15 (campo «Cuotas a pagar» en el cobro del Cobrador/Supervisor y en «Registrar recaudo» del Administrador; el Secretario no registra abonos) y 3.16 (fecha del desembolso; columna «Inicio de cobro» corregida).
   * Ronda 77 (`bffdfc1`): búsqueda sin acentos en Clientes y Usuarios.
   * Ronda 76: mora al día (`865844a`, Render) y respaldos con la alternativa A activa (copias diarias cifradas en OneDrive, clave de recuperación comprobada, tareas registradas; primera copia automática `adex-20261027T1947`).
   * **Probado:** pruebas financieras (CUOTAS-001…003), las de CLEAN, los tipos y E2E 89/89, 41/41 y 25/25. **No probado:** con datos reales ni por el socio.
3. **Qué falta:**
   * **Para el chat Central:** 3.29 (Alta, petición del socio 2026-11-05): nueva base de 50 tipos de gasto, 11 «Para Cobradores», para empresas nuevas y BlueLine (sin borrar nada; BlueLine requiere el permiso de Helmer). Lista: `docs/GASTOS_BASE_INICIAL_SOCIO_2026-11-05.md`.
   * 3.26 (Alta, petición del socio 2026-11-05): manuales interactivos en HTML (Cobrador primero, después Admin), con botón ES/PT, que se vean bien en el celular y se envíen por WhatsApp. Las listas de tareas están por confirmar con el socio.
   * **Para el chat Central:** 3.23 (Alta, petición del socio 2026-11-04): fecha elegible en «Informe del día» (Cobrador y Supervisor, cualquier fecha pasada, sigue siendo personal).
   * **Para el chat Central:** 3.22, hacer ADEX Online instalable como app (manifiesto web). Esperando la respuesta del socio: Android o iPhone, impresión de recibos y recorrido en mapa.
   * Que el socio compruebe 3.21 (4.9): dejar la app abierta hasta el día siguiente.
   * Actualizar la guía del socio con los nombres nuevos de Liquidaciones (3.19): Helmer dijo «Ahora no» (2026-10-28).
   * Que el socio valide 3.12, 3.14, 3.15, 3.16, 3.17, 3.18, 3.19, el cierre del mismo día y el buscador en su celular.
   * **Respaldos nocturnos:** fallaron del 31/10 al 3/11 por el DNS del proveedor (rechazaba la dirección del pooler). **Corregido 2026-11-03:** Helmer puso DNS 1.1.1.1 y 8.8.8.8 en Ethernet y Wi-Fi; 20/20 búsquedas bien y respaldo diario lanzado a mano OK (`adex-20261103T1703`). Confirmar mañana que el de las 9:30 pm salió bien.
   * DS-06 (cargar la cartera de una empresa nueva): en espera de la opinión del socio; preferida la opción A (saldos de apertura), sin aprobar. El archivo completo de Listos sirve para esa opción. **2026-11-03:** Helmer pidió un sistema de migración de rutas con historial; el chat «ADEX · Migración de rutas con historial» propuso un plan por fases (diseño → plantilla → validación sin escribir → empresa sintética → empresa real) y espera sus respuestas y su «sí». Sin código ni migración todavía. Hallazgos: los abonos antiguos no pueden entrar como recaudos (moverían efectivo y bloquean la rectificación, AX526); la venta no admite `start_date` pasada (trigger de 0010); hace falta una operación de apertura nueva (cartera de la ruta contra financiación). **2026-11-04:** Helmer dijo que los archivos anteriores eran de prueba y entregó `Downloads\Reportes.zip` (12 Excel de Listos, ruta «VALPARAISO SOC GAJ», oficina 20): análisis desde cero, solo cifras agregadas, sin estrategia elegida. 500 créditos del 2025-12-03 al 2026-10-31 (35 activos, saldo 56.153) + Clientes activos (123 clientes; 41 créditos activos, saldo 63.773). Faltan 6 activos anteriores a dic-2025 (saldo 7.620) y unos 387 pagados de 2025; no hay abonos individuales, Base ni caja. **2026-11-04 (2):** con `Reportes_2.zip` (11 meses de 2025) la ruta quedó **completa**: 893 créditos del 2025-01-14 al 2026-10-31, 852 pagados y 41 activos, saldo 63.773; cuadra al 100 % con Clientes activos (123 clientes). Plan de ejecución para Valparaíso propuesto (diseño → carga en staging con datos inventados → corte real); Abonos individuales: opcionales (decidido con Helmer). **2026-11-04 (3), decisiones de Helmer:** la ruta va a BlueLine, en la oficina de Aguas Lindas; el Administrador es Andrew y él asigna el cobrador; el estado «en migración» es **por ruta** (no por empresa); durante la migración Helmer sube reportes diarios de Listos; al terminar, la ruta pasa a estado normal. Helmer aprobó el enfoque: durante la migración ADEX solo refleja la cartera (sin dinero ni caja); la caja se abre el día del paso a normal, con conteo físico y el cuadre de Listos. **Diseño escrito** en `docs/ADEX_DISENO_MIGRACION_RUTAS_2026-11.md`, sin commit: estado de ruta `en_migracion`, operaciones MIGRATION_OPENING / MIGRATION_COLLECTION / MIGRATION_CASH_OPENING contra `route_funding`, pagados al historial de Listos, controles diarios y pasos A–G. **2026-11-04 (4):** respuestas de Helmer: hay reporte de caja y cuadre de Listos (Valparaíso: caja −1.580 y cartera 63.773 al 3/11); los créditos diarios cuentan los 7 días (comprobado con los datos: 34/36); ADEX no castiga créditos, solo muestra el retraso; la migración dura hasta el domingo 8 y la ruta cobra en ADEX desde el **lunes 9**. **Parte 1 publicada en Git (091d4e37, 2026-11-04; Vercel index-BU3U6Xkc.js con el botón):** migración **0043** (0042 ya era la venta tardía) con el estado «en migración» por ruta y el bloqueo de escrituras en PostgreSQL; API (abrir, cancelar y listar; solo SuperAdmin); botón y aviso «En migración» en Rutas (Online). Probado: test:db completo 608/612 (los 3 fallos eran listas fijas del esquema; corregidas y repetidas: 14/14 en esas suites), `route-migration.test.ts` 4/4, tipos (3), unitarias 31/31, build Online. No probado: el botón en un navegador. Render desplegado con 091d4e37 (19:26) ANTES de que 0043 estuviera en staging: la lista de rutas falló unos minutos; 0043 aplicada por Claude con permiso de Helmer a las 19:50 (respaldo adex-20261104T1949) y comprobada. En BlueLine la oficina es «Oficina 20» y Aguas Lindas es una RUTA; **Valparaíso (RT-002, Oficina 20, Andrew) quedó «En migración» en BlueLine** (lo vio Helmer). 8a04d2d5 (Vercel index-joD9uHQh.js): el botón solo aparece en rutas vacías (pedido de Helmer: Aguas Lindas no debe ofrecerlo). **Parte 2 (0044) PUBLICADA (76718ceb, 2026-11-04; 0044 en staging con respaldo adex-20261104T2058; Render y Vercel con 76718ce):** carga FINAL única con el reporte del cierre (los diarios solo se revisan, sin guardar, para no mezclar cobros de Listos con el recaudo de ADEX); ventas por lo que falta cobrar con las fechas originales; asiento MIGRATION_OPENING (cartera/financiación, sin caja); pagados al historial; API vista previa + carga; botón «Cargar datos de Listos»; lector `saas/scripts/migracion/listos_a_adex.py`; diseño §14. Probado: route-migration 5/5, unitarias 31/31, tipos, build Online; carga REAL de Valparaíso (3/11) en base local desechable: 41 activos, R$ 63.773, 852 pagados, conciliación limpia. test:db 612/613 (1 omitida). No probado: el botón de carga en navegador. **Corrección 0045 PUBLICADA (4dd637e2, 2026-11-04; 0045 en staging con respaldo adex-20261104T2240; Render y Vercel con 4dd637e), pedido de Helmer:** se carga UN CIERRE POR DÍA y la ruta se ve cada día (sigue en migración); bajas de saldo = «Abono en Listos» (MIGRATION_COLLECTION, sin caja); «Terminar migración» aparte; diseño §15. Archivos de la migración (reportes de Listos y cierres .json, con datos personales; fuera de Git): `Migraciones/Valparaiso/`; **cierre del 3/11 CARGADO en BlueLine por Helmer (2026-11-04 20:04 hora Brasil): 123 clientes (41 activos), 41 créditos, saldo R$ 63.773, 852 pagados al historial; ruta sigue en migración.** **2026-11-05:** el lector tiene **modo diario** (`--anterior` cierre previo + Clientes activos del día + «Reporte excel créditos» de los días nuevos; abonos y pagados se deducen por cliente y se detiene si es ambiguo), sin commit; el modo completo reproduce idéntico el cierre del 3/11. Reportes del 4/11 en `Migraciones/Valparaiso/reportes_listos/2026-11-04/`: 7 clientes cambiaron; falta el «Reporte excel créditos» del **3/11** (una renovación hecha después de la descarga de las 10 PM; saldo 1.440 → 1.680). Falta: ese reporte → cierre del 4/11 → Helmer lo carga; luego 5, 6, 7 y el domingo 8 (último cierre + «Terminar migración» + Andrew inyecta la Base contada).
   * RS-4 aprobada: trasladar el proyecto a Supabase Pro de Starcli **solo cuando Helmer lo ordene** (no mientras se prueba la app).
   * Grupo de chats «ADEX - RutaCash» (2026-10-27): Central, Errores o bugs, Peticiones del socio, Ideas y producto, Respaldos y operación, Decisiones pendientes. Solo Central y Errores tocan código.
   * Barrido: grupo B (3.20 con 2 detalles por confirmar, 3.5, 3.4, 3.10), grupo D (vigencia de 7.1…7.6) y al final la limpieza 6.1…6.4, que necesita permiso. Decisiones abiertas: 2.1.4, 2.1.11, 2.1.12, 2.1.13 y 2.2.1.
   * Resto: `docs/ADEX_PENDIENTES_CONSOLIDADOS_2026-10-24.md`, que es el **listado canónico**.
4. **Decisiones tomadas:**
   * 2026-11-04: las ideas de producto se guardan en `docs/ADEX_IDEAS_DE_PRODUCTO.md`, **no** como pendientes. IDEA-01: venta a crédito con cobrador como segundo tipo de cliente, para retomar más adelante.
   * 2026-11-03: una sola aplicación web instalable para todos los roles; sin programa de escritorio; apps de tienda solo si hacen falta, construidas sobre la misma web (2.4.7, trabajo 3.22).
   * 2026-11-03 (3.20): al usar el enlace de restablecimiento se cierran todas las sesiones de la persona; el enlace de un Administrador solo lo emite el SuperAdmin, el de un SuperAdmin solo el Owner.
   * 2026-11-03: la normativa (SOC 2, ISO 27001/27701) se toma solo como guía de calidad, sin certificarse; el análisis de brechas queda para después de la prueba de BlueLine.
   * 2026-10-28: solo se deciden ahora las que afectan a BlueLine hoy (2.1.13 PIX, 2.1.11, 2.1.4, 2.1.12); el resto quedó marcado «PARA DESPUÉS» en el listado canónico con su momento de regreso. No volver a proponerlas antes de ese momento.
   * 2026-10-28: respaldos RS-5, PITR no por ahora; RS-4, el proyecto actual se trasladará a la organización Pro de Starcli como proyecto propio de ADEX, sin mezclar nada con Starcli Loyalty, cuando valga la pena (aún se prueba la app). Antes de cualquier pago se le dice a Helmer el costo.
   * 2026-10-28: Supabase y Render, proveedores oficiales (2.3.2, DS-02); el nombre «ADEX-Staging» se cambia al trasladar (RS-4). Render sigue Free durante las pruebas; luego solo `adex-online-api` a Starter, ~US$ 7/mes, con orden expresa de Helmer (2.3.3).
   * 2026-10-28: contraseña olvidada (2.3.4, opción B): quien da de alta emite un enlace de restablecimiento auditado para usuarios activos; el correo automático (SMTP) queda para cuando haya dominio propio. Trabajo 3.20 para Central.
   * 2026-10-28: revisión de seguridad profunda una sola vez antes de la primera empresa comercial, y rápida en cambios grandes con dinero; nunca sin que Helmer la pida (2.3.8, opción B).
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
5. **Archivos tocados (3.24):**
   * `saas/db/migrations/0042_late_sale_delivery_date.sql`, `saas/src/credits/service.ts` (`lateSale`, `correctDeliveryDate`), `saas/src/http/companyApi.ts`, `saas/src/errors.ts`, `saas/src/server/{app,start}.ts`, `saas/src/collections/location.ts`, `saas/src/model/dexieV16.ts`, `saas/db/seeds/synthetic.ts`, `src/models/types.ts` (`deliveredOn`).
   * Web: `online/src/bridge/pages/admin/ActiveSalesPage.tsx` (nuevo puente), `online/src/bridge/services/saleRequestService.ts`, `online/src/runtime/mappers.ts`, `online/src/lib/format.ts`, `online/scripts/deploy-gate.mjs`.
   * Pruebas: `saas/test/integration/late-sale.test.ts` (nueva), `schema-coverage`, `rls-performance`, `render-resilience`; E2E etapa L (LT-01, LT-02).

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

### 2026-11-05 — Pendientes puesto al día

* Solo documentación: migración de rutas reflejada (1.7, DS-06 decidido, 2.1.10/2.2.2/2.2.4 vuelven por su disparador), 3.25 (semana lunes a domingo, decisión 7.1), 4.10 (validaciones del socio de lo publicado el 3 y 4/11), riesgo 5.9. Respaldo diario `adex-20261105T0230` correcto.

### 2026-11-04 — 3.24 venta registrada tarde y fecha de entrega (publicado)

* `e173f732` + migración 0042 (respaldo previo `adex-20261104T1659`). Solo Administrador; máximo 3 días; días cerrados no se reabren; el libro conserva sus fechas. test:db 607/607, E2E 97/46/32. Render `adex-online-api` desplegado; Vercel tras el commit de documentación (la puerta canceló el build del push anterior a Render).

### 2026-11-04 — 3.23 y reporte de Ventas (publicados)

* Solo web (`d2adea88`, `39282b84`), sin migración. Informe del día con fecha elegible y hora local; Ventas por fecha del desembolso. E2E 97/46/30 (A-15c, A-15d). Verify:deploy OK (39282b8).

### 2026-11-04 — 3.10: la web deja de publicar metadatos de Git (publicado)

* Solo web (`68f7e654`), sin migración. E2E 95/46/30. Verify:deploy OK (68f7e65); el JS publicado no contiene ninguna variable VITE_VERCEL_*. Grupo B terminado.

### 2026-11-03 — 3.4: historial de responsables en Base por Ruta (publicado)

* Solo web (`d8f83211`), sin migración. E2E 95/46/30 (D-06b). Verify:deploy OK. Falta validación del socio.

### 2026-11-03 — 3.5: el aviso de eliminar dice la causa (publicado)

* Solo web (`7e5b407f`), sin migración. E2E 94/46/30. Verify:deploy OK. Falta validación del socio.

### 2026-11-03 — Barrido de pendientes, grupo A

* 3.6, 3.7, 3.8, 3.9, 3.11 y 6.5: scripts de verificación para Online, candados contra el servidor real, TLS verificado, limpieza de código y de Git. Sin migración ni Render.

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
