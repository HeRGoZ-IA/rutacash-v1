# ADEX — Pendientes consolidados (documento canónico)

| | |
|---|---|
| Creado | 2026-10-24 (el nombre del archivo conserva esa fecha para no romper referencias) |
| Última actualización | **2026-10-27**: decisiones 2.3.9 (no bloquear), 2.1.15 (casilla «Para Cobradores», trabajo 3.14) RB-D10 (opción A), RB-D11 y RB-D12 (anulaciones solo por el Administrador, trabajo 3.17) aprobadas; peticiones del socio 3.15 (pagar por cuotas), 3.16 (fecha del desembolso) 3.18 (gastos ya cerrados en Gastos) y 3.19 (Liquidaciones: nombres y último cierre). Antes, 2026-10-26 (Ronda 76): precisiones del propietario, frente 2 (3.2 y 3.3) y propuesta de respaldos |
| Enlazado desde | [Registro Maestro §G](./REGISTRO_MAESTRO_EVOLUCION_ADEX.md) |

Es el **único** listado de pendientes del proyecto. No se crean versiones paralelas: se actualiza este archivo y se conservan los identificadores. Lo que deja de estar pendiente se marca, no se borra.

Fuentes:
- el Registro Maestro (§E, §F y §G);
- los documentos de cada ronda (R20–R76);
- los documentos SaaS (Visión, Decisiones pendientes, Fases 0–6);
- los documentos de septiembre de la etapa CLEAN.

Los pendientes ya cerrados figuran al final para que no se vuelvan a abrir.

**Tipos de pendiente:**

| Tipo | Significado |
|---|---|
| **Decisión** | La resuelve el propietario. No es trabajo técnico hasta que se decida |
| **Técnico** | Trabajo de desarrollo |
| **Validación** | Probar algo ya construido |
| **Operación** | La hacen los usuarios en la aplicación |
| **Riesgo** | Comportamiento conocido que puede causar un problema. Solo se dice «aceptado» si el propietario lo aceptó expresamente |
| **Orden** | Limpieza y mantenimiento |

**Estados:** técnico (hecho en el código: probado y publicado) y operativo (usado o validado por las personas) se indican por separado cuando difieren.

---

## 1. BlueLine con Base por Ruta

| # | Pendiente | Tipo | Quién | Estado |
|---|---|---|---|---|
| 1.1 | Revisión personal general de Online tras la activación y la normalización de nombres | Validación | Propietario | **HECHA** (2026-10-24/25): revisión satisfactoria, con correcciones en la misma sesión. **No** incluye las pruebas específicas 1.3, 1.5, 4.2 ni un cierre semanal completo, que siguen abiertas |
| 1.2 | Inyección de capital en la Base de Aguas Lindas | Operación | Administrador responsable | **POSPUESTA por el propietario.** No es un defecto ni un requisito de cierre de ninguna ronda. No se ejecuta en nombre de nadie |
| 1.3 | Abrir la conciliación de 26 comprobaciones de la API desde la sesión del SuperAdmin | Validación | SuperAdmin | Pendiente |
| 1.4 | Ajustar las hojas de cálculo que lean los CSV de Liquidación o de cierres: los encabezados cambiaron | Operación | Usuarios | Pendiente |
| 1.5 | Primera operación real completa con Base por Ruta: entrega de Base al Cobrador, recaudo, cuadre y cierre de semana. Desde `bca28d3` el cierre puede incluir el día en curso | Validación | Usuarios de BlueLine | Pendiente |
| 1.6 | Corregir desde la interfaz la venta real del incidente SOC-07, si cumple los requisitos (D73-06) | Operación | Administrador | Pendiente |

## 2. Decisiones del propietario

### 2.1 Dinero, ventas y cuadres

| # | Decisión | Situación actual | Fuente |
|---|---|---|---|
| 2.1.1 | **RB-D10.** ¿Un faltante en el acta de entrega de una ruta se carga al Administrador saliente? | **APROBADO por el propietario (2026-10-27): «RB-D10: A»** = se mantiene como «faltante de la ruta», visible y pendiente de conciliar (RB-D3); **no** se carga automáticamente al Administrador saliente ni se crea una cuenta por cobrar. Sin trabajo técnico | R74 §15.7; decisión 2026-10-27 |
| 2.1.1b | **RB-D11.** ¿Quién anula un gasto de ruta registrado por el propio responsable de capital? (la regla de independencia F5-D02 impide que lo anule él mismo, y hoy nadie puede). Faltaba en este listado; se añade el 2026-10-27 | **APROBADO por el propietario (2026-10-27), con su aclaración:** «el ADMIN es el único perfil dentro de TODA la app que puede reversar o anular cualquier movimiento/gasto aún siendo él mismo quien registró dicho movimiento /gasto». Regla resultante: **solo el Administrador** anula o reversa movimientos y gastos, **también los que registró él mismo**; ningún otro perfil (SuperAdmin, Secretario, Supervisor, Cobrador) anula. **Sustituye en parte a F5-D02** (que prohibía anular lo propio y permitía al SuperAdmin) y es coherente con R74 (SuperAdmin sin anulaciones). Se conserva lo demás de F5-D02 (anulación total y auditada, motivo, periodo cerrado con ajuste nuevo, el importe vuelve a la cuenta que pagó). Implementación → **3.17** | R74 §15.7; decisión 2026-10-27 |
| 2.1.2 | **RB-D12.** ¿Anular por partes una operación conjunta de varias rutas con responsables distintos? | **APROBADO por el propietario (2026-10-27):** «El gasto lo puede anular SOLO el admin que lo haya registrado (el acuerdo de anulación sería verbal)». Regla resultante: no hay anulación por partes; el gasto general se anula **completo** y solo por el Administrador que lo registró, aunque no controle todas las rutas aportantes; cada ruta recupera su aporte. **Sustituye** la regla vigente (responsable de todas las rutas, AX434). Si ese Administrador ya está inactivo o dejó de ser responsable, lo anula **el Administrador responsable vigente** de las rutas (propietario, 2026-10-27: «Responsable vigente»). Implementación → **3.17** | R74 §15.7; decisión 2026-10-27 |
| 2.1.3 | **RB-D13.** Reembolso de un Administrador a otro | **APROBADO** por el propietario: un Administrador puede reembolsar a otro **desde las rutas propias del pagador**, sin adquirir acceso financiero a las rutas del beneficiario. La decisión ya no está abierta; lo que falta es la interfaz → **3.12** | R74 §15.7 |
| 2.1.4 | **O10.** ¿Qué es «ganancia retirable»? | Existe un solo «Retiro de Base». Diferida | R74 §13.1 |
| 2.1.5 | **D74-O11T.** Transferencias entre rutas | **Regla vigente: inmediatas** (se aplican en el acto y se avisan al destino). Un estado «en tránsito» con confirmación queda como **propuesta opcional futura** (2.5.6), no como decisión pendiente | R74 §13.2 |
| 2.1.6 | **Indicador «Necesidad de capital» por ruta:** ¿se muestra y cómo se calcula? | Sin definir | R74 §4.7 |
| 2.1.7 | **D74-A2.** ¿Rectificar ventas de periodos ya cerrados? | Bloqueado a propósito | R74 §13.1 |
| 2.1.8 | **D74-A3.** ¿Qué pasa si el total corregido de una venta queda por debajo de lo ya pagado (sobrepagos y devoluciones)? | Bloqueado a propósito | R74 §13.1 |
| 2.1.9 | **P-04 / D73-03.** Conciliaciones excepcionales: reaplicar un pago cuya anulación ya entró en un cuadre, y los casos excepcionales registrados | Bloqueadas | R74 §0.2, R73 §7 |
| 2.1.10 | **Castigo de crédito («marcar perdido»):** cuándo se da por perdida una venta y cómo afecta al resultado | No existe; tampoco se guarda la fecha de pérdida | R24 §5, Fase 4 |
| 2.1.11 | **F6-D03.** ¿Se reembolsa al trabajador el dinero propio que puso para gastos (Base del trabajador negativa)? | Sin reembolso implícito | Decisiones SaaS §6 |
| 2.1.12 | **D27.** ¿Puede el Cobrador pedir Base a su responsable desde la aplicación? | No existe la solicitud | Decisiones SaaS §3 |
| 2.1.13 | **Medios de pago distintos del efectivo** (transferencia, PIX) | Solo efectivo. Habría que añadir una cuenta bancaria al libro | Fase 5 |
| 2.1.14 | **Redondeo en pesos colombianos:** dos decimales técnicos frente a presentación sin centavos | Sin decidir | Visión §9, §16 |
| 2.1.15 | **Tipos de gasto del Cobrador y del Administrador** | **APROBADO por el propietario (2026-10-27):** «Apruebo 2.1.15 como lo propones: un solo listado con casilla «Para Cobradores», el Supervisor igual que el Cobrador, y marcados al inicio Transporte, Alimentación y Combustible». Motivo (socio): los gastos del Cobrador deben ser mínimos; los del Administrador, amplios. Detalle aprobado: (1) un solo catálogo por empresa; el Administrador ve todos los tipos; (2) Cobrador y Supervisor solo ven y usan los marcados «Para Cobradores»; (3) en empresas nuevas nacen marcados Transporte, Alimentación y Combustible, y cada empresa cambia las casillas cuando quiera; (4) la regla la valida también el servidor; (5) desmarcar no altera los gastos ya registrados; (6) un gasto capturado sin conexión con un tipo desmarcado después se acepta al sincronizar, con aviso al Administrador. Los nombres de los 7 tipos iniciales no cambian. Implementación → **3.14** | Auditoría de nombres; decisión 2026-10-27 |
| 2.1.16 | Rótulo del selector «Selecciona tu ruta» del Supervisor | **Ya no es una decisión:** los nombres están aprobados (N-1…N-6). Comprobado en el código el 2026-10-26: en **Online** (`online/src/bridge/pages/collector/CollectorSelectRoutePage.tsx`, `760722b`/`9ca7dc4`) muestra «Base disponible» (Base real de la ruta) y «Base del trabajador» por separado. El rótulo «Base de la ruta» solo sigue en el archivo original de CLEAN (`src/pages/collector/…`), que Online no sirve. Ver 3.11 | R74 §15.6 |

### 2.2 Datos, clientes y apertura

| # | Decisión | Fuente |
|---|---|---|
| 2.2.1 | **DS-06.** Cómo se carga la cartera existente de una empresa nueva: importador de saldos iniciales o importación de historia | R39 §6, R40 §8 |
| 2.2.2 | Procedimiento escrito para resolver diferencias entre ADEX y el sistema oficial durante el piloto (bloqueo 6 del piloto) | R39 §6, R40 §8 |
| 2.2.3 | **Listos: análisis inicial HECHO; falta definir la incorporación** (DS-06). No autoriza importar ni volver a analizar los Excel. Ver el análisis conservado abajo | R74 §0.2; análisis comunicado por el propietario (2026-10) |
| 2.2.4 | **SOC-10** (documento de 7 dígitos, CPF/RG): suspendida hasta confirmar el documento real del caso | R73 |
| 2.2.5 | **DS-16.** Exportación de datos locales | Registro §E |
| 2.2.6 | ¿Se recrea una Empresa Demo? | R53 |

**Análisis conocido de Listos (2.2.3).** Se conserva tal como se comunicó; no se volvió a analizar:
- Dos exportaciones con las mismas 35 ventas. El archivo corto tiene 12 columnas y el completo 24.
- Saldo agregado 48.539; **la moneda está pendiente de confirmación explícita**.
- En ocho ventas no se cumple «saldo = parcelas pendientes × cuota».
- No hay movimientos individuales de recaudo ni calendario detallado.
- No hay documento o ID de cliente utilizable, ni Base o custodias.
- **Incorporación prioritaria propuesta:**
  - clientes y ventas vigentes;
  - valores y saldos al corte;
  - calendario pendiente;
  - posiciones actuales de efectivo, sin duplicación.
- El histórico completo lo conserva el usuario en Listos.

### 2.3 Plataforma, seguridad y normativa

| # | Decisión | Fuente |
|---|---|---|
| 2.3.1 | **P-05 / DS-02 / DS-14 · Respaldos.** Las copias puntuales y su restauración aislada **están verificadas** (`adex-20261024T1408` y `adex-20261024T1551`). Lo pendiente es la **política recurrente**: frecuencia, retención, destino independiente, recuperación de la clave, ensayos, RPO/RTO y PITR. **Propuesta lista:** [ADEX_PROPUESTA_RESPALDOS_Y_RECUPERACION.md](./ADEX_PROPUESTA_RESPALDOS_Y_RECUPERACION.md). **RS-1…RS-3 aprobadas e implementadas el 2026-10-26** (copia `adex-20261026T1535` verificada y en OneDrive). Activación **completada** por el propietario: clave de recuperación creada y comprobada («CORRECTA»), guardada en Bitwarden y en su libreta; tareas programadas registradas (§8 de la propuesta). Siguen abiertas RS-4 (Supabase Pro) y RS-5 (PITR) | R74 §0.2, R40 §8, R76 |
| 2.3.2 | **Proveedor (DS-02, DS-03):** Supabase y Render operan sin aprobación escrita. Además, el proyecto se llama «ADEX-Staging» y aloja una empresa real | Registro §G |
| 2.3.3 | **Render Free:** se suspende tras 15 minutos sin uso y tarda en despertar. ¿Pasar a un plan de pago antes de abrir a más empresas? | ADEX_ONLINE_RENDER |
| 2.3.4 | **SMTP real** para recuperar contraseñas. Decidir también si un administrador puede restablecer la contraseña de un usuario activo | R40 §8 |
| 2.3.5 | **Privacidad y retención de datos (DS-14):** auditoría y coordenadas GPS (plazo, borrado, quién las consulta), con revisión de LGPD (Brasil) y Ley 1581 (Colombia) | R48 §4, R67 §5 |
| 2.3.6 | **DS-13.** Residencia de datos y normativa | Visión §16 |
| 2.3.7 | Mapas y direcciones: proveedor de búsqueda por dirección (D73-05) y proveedor de mapas para uso comercial | R73 §7, R67 §5 |
| 2.3.8 | Revisión de seguridad antes de abrir el producto al público (recomendada, no ejecutada) | Reglas del espacio de trabajo |
| 2.3.9 | **Desactivación de trabajadores con efectivo.** **APROBADO por el propietario (2026-10-27): «Me quedo con la opción A»** = **no se bloquea**. Se mantiene el comportamiento vigente de 3.3: desactivar corta el acceso al instante y el efectivo sigue visible, cuadrable y a nombre del trabajador. Sin trabajo técnico | R76; decisión 2026-10-27 |

### 2.4 Comercial SaaS

| # | Decisión | Fuente |
|---|---|---|
| 2.4.1 | Suscripciones, planes, precios y fecha de lanzamiento; cobro por ruta (`billableRouteCount`, DS-17) | Visión §3, §20 |
| 2.4.2 | Moneda de facturación del SaaS | Visión §9 |
| 2.4.3 | Internacionalización: interfaz en portugués (BlueLine opera en Brasil; la interfaz solo está en español) | Visión §9 |
| 2.4.4 | Empresas con rutas en varias zonas horarias | Visión §9 |
| 2.4.5 | **DS-08, DS-09 y DS-12** (piloto): siguen sin aprobación escrita | Registro §E |
| 2.4.6 | Capacidad multiempresa: prueba de carga (4.4) y plan de Render y Supabase (2.3.3, RS-4) antes de incorporar empresas comerciales | R40 §9, R76 |

### 2.5 Ampliaciones del modo offline (propuestas, no tareas)

| # | Propuesta | Fuente |
|---|---|---|
| 2.5.1 | Registro en el servidor de las capturas offline que no se aplicaron | R62 §5 |
| 2.5.2 | Fotos de gastos | R62 §5 |
| 2.5.3 | Ubicación de las visitas (requiere autorización) | R65 §6 |
| 2.5.4 | ~~Venta directa del Cobrador sin conexión~~ → **Retirado:** crear clientes o ventas sin conexión está **prohibido por decisión vigente** (R65). No es una ampliación pendiente; ver §8 | R65 §6 |
| 2.5.5 | Qué hacer si la fecha de inicio de una venta venció al sincronizar | R65 §6 |
| 2.5.6 | Estado «en tránsito» con confirmación del destino en las transferencias entre rutas (opcional, futuro; ver 2.1.5) | R74 §13.2 |

## 3. Trabajo técnico (no depende de decisiones)

| # | Trabajo | Prioridad sugerida | Estado | Fuente |
|---|---|---|---|---|
| 3.1 | Búsqueda sin acentos: «joao» no encontraba «JOÃO» | Media | **HECHO** (2026-10-27, `bffdfc1`): Clientes del Administrador y del Secretario y Usuarios usan la misma función que el Cobrador y Ventas (`c1976db`). E2E A-16b. Técnico: publicado en Vercel. Operativo: sin validar por usuarios | R74 §3 |
| 3.2 | La mora (`days_overdue` y el estado «vencida» de las cuotas) solo se recalculaba al registrar algo en la venta | Alta | **CORREGIDO (R76).** La API calcula estado y días al leer, con la fecha contable de la empresa. No escribe ni mueve dinero. Pruebas MORA-001…003. Técnico: publicado en Render (ver Registro). Operativo: sin validar por usuarios | R24 §5, R76 |
| 3.3 | Desactivar un Cobrador o Supervisor que aún tiene efectivo no se bloquea; la regla RB-D1 solo existe para Administradores | Alta | **RESUELTO POR DISEÑO, con evidencia (R76).** Desactivar corta el acceso al instante, pero no mueve, perdona ni oculta el efectivo. El trabajador sigue en el cuadre de la ruta («· inactivo»), el responsable recibe lo que entrega y el faltante queda a su nombre pendiente de conciliar. PostgreSQL lo admite expresamente («nunca se deja dinero varado»). Pruebas SEC3-006 (bolsas) y RB-021 (Base por Ruta). Sin cambios funcionales. Bloquearlo es una opción del propietario (2.3.9) | Fase 3, R74 §15, R76 |
| 3.4 | Consulta del historial de responsables de una ruta | Media | Pendiente | R25 §4 |
| 3.5 | Asignar rutas a una oficina hace dos operaciones no atómicas, y el rechazo «Tiene historia» no explica la causa | Media | Pendiente | ADEX_ONLINE_ADMINISTRACION §6 |
| 3.6 | Comprobar que los textos de tipos de movimiento coinciden entre los mensajes y Consultas | Baja | Probablemente resuelto con `9ca7dc4`; **sin verificar** | R74 §7 |
| 3.7 | `prod-smoke` y `verify:deploy` todavía apuntan a la URL retirada de CLEAN | Baja | Pendiente | R59 §5 |
| 3.8 | Las pruebas `auth-real` suponen un SuperAdmin que escribe; ya no es así | Baja | Pendiente | R67 §5 |
| 3.9 | Un script interno (`demo-accounts.ts`) desactiva la verificación TLS | Baja | Pendiente | R40 §9 |
| 3.10 | Los metadatos de Git (incluido el mensaje del commit) son visibles en el código público de la web. Evaluar si conviene ocultarlos | Baja | Pendiente | R70 |
| 3.11 | Archivo CLEAN `src/pages/collector/CollectorSelectRoutePage.tsx`: conserva «Base de la ruta» | Baja | Online usa su copia corregida, así que solo afecta a CLEAN, que está retirada. No exige decisión | R74 §15.6 |
| 3.12 | **RB-D13 en la interfaz:** pantalla para que un Administrador reembolse a otro desde sus propias rutas (aprobado, 2.1.3) | Media | Pendiente; no implementado | R74 §15.7 |
| 3.13 | Versionar el script de copia cifrada y su ensayo de restauración (propuesta de respaldos §3) | Alta | **HECHO** (`saas/scripts/backup/`). Activado el 2026-10-26 (clave y tareas) | R76 |
| 3.14 | **Tipos de gasto «Para Cobradores» (2.1.15, aprobado):** casilla por tipo en «Categorías de gasto»; filtrar los tipos en la pantalla de gastos de Cobrador y Supervisor (también la captura sin conexión); validar en la API; nuevas empresas con Transporte, Alimentación y Combustible marcados; aceptar con aviso al Administrador las capturas offline con un tipo desmarcado después. Requiere migración (la ejecuta el propietario) y despliegue manual en Render. **Por definir en el chat Central:** qué casillas reciben las empresas existentes, como BlueLine (propuesta: las mismas tres, si existen con ese nombre) | Media | Pendiente; para el chat Central | Decisión 2026-10-27 |
| 3.15 | **Pagar por número de cuotas (petición del socio):** en «Registrar recaudo», un campo «Cuotas a pagar» para **todos los roles que registran abonos** (Cobrador, Administrador y Secretario; confirmado por el propietario el 2026-10-27): al escribir, por ejemplo, 5, el valor del recaudo se llena solo. Regla aprobada por el propietario: lo que falta de la parcela actual (si tiene abono parcial) más las 4 siguientes, con el saldo real y nunca por encima del total de la deuda. Sin conexión respeta el mismo tope que hoy. Hoy solo existen «Completar parcela», «Mitad» y «Total deuda» (`online/src/bridge/pages/collector/PaymentPage.tsx`, `quickAmounts`). Urgencia alta (propietario, 2026-10-27) | Alta | **HECHO** (2026-10-27, `225dbc6`): campo «Cuotas a pagar» en el cobro del Cobrador y del Supervisor y en «Registrar recaudo» del Administrador (el Secretario no registra abonos: no tiene esa pantalla ni ese permiso). Pruebas CUOTAS-001…003 y E2E A-14b. Técnico: publicado en Vercel. Operativo: sin validar por el socio | Socio, 2026-10-27 |
| 3.16 | **Mostrar la fecha del desembolso (petición del socio):** el dato ya existe (`fechaDesembolso`, llega a Online por `online/src/runtime/mappers.ts`) pero no se muestra. Mostrar solo el día en: «Registrar recaudo» del Cobrador; detalle del cliente del Cobrador; historial de créditos del cliente (Administrador y Secretario, `src/components/ui/ClientCreditHistory.tsx`). En el mismo trabajo, corregir en esa tabla el encabezado «Fecha de creación», que en realidad muestra la fecha de **inicio de cobro**. Sin cambios de dinero ni de API previstos | Alta | **HECHO** (2026-10-27, `225dbc6`): «Desembolsada el …» en el cobro y en el detalle del cliente del Cobrador; columna «Desembolso» en el historial de ventas, y la columna mal rotulada pasa a «Inicio de cobro». E2E A-14c. Técnico: publicado en Vercel. Operativo: sin validar por el socio | Socio, 2026-10-27 |
| 3.17 | **Anulaciones solo por el Administrador (RB-D11 y RB-D12, aprobadas):** permitir que el Administrador anule o reverse movimientos y gastos que él mismo registró (retirar el bloqueo de identidad de F5-D02/AX717); quitar la anulación a cualquier otro perfil donde aún exista; gasto general (operación conjunta) anulable completo solo por el Administrador que lo registró, sin exigir que controle todas las rutas (cambia AX434). Revisar en el chat Central qué Administrador corresponde en cada tipo de movimiento (responsable vigente de la ruta frente a quien registró) (el caso del Administrador inactivo ya está decidido: responsable vigente de las rutas), y confirmarlo con el propietario antes de publicar. Requiere migración y despliegue manual en Render | Alta | **PUBLICADO** 2026-10-28 (`ad1f4e9`; migración 0039 aplicada por el propietario y verificada en solo lectura; Render `adex-online-api` y Vercel `index-sDnD_a1d.js`). Decisiones del propietario al revisar el alcance (2026-10-27): (a) gasto general de varias rutas: lo anula completo quien lo registró; si ya no está o ya no responde por esas rutas, **cualquiera** de sus responsables vigentes; (b) cobros: sin cambio, cualquier Administrador con la ruta; (c) transferencia entre rutas y reembolso pagado con rutas: misma regla que (a), sin anulación coordinada; (d) SuperAdmin: sin ninguna anulación (solo afectaba al modelo de bolsas); el Secretario conserva cancelar un traspaso PENDIENTE que registró; (e) corrección de pagos del Secretario: **siempre** como solicitud de ajuste que aprueba un Administrador. Se conservan las barreras sobre el propio efectivo (AX717, AX801). Pruebas: PostgreSQL 590/0/1, E2E 89/41/25, reversión 10/10. Respaldo previo `adex-20261028T1409` verificado. No probado con BlueLine ni por el socio | Decisión 2026-10-27 |
| 3.18 | **Gastos ya cerrados en la pantalla Gastos (petición del socio):** la lista de «Gastos» del Cobrador y del Supervisor (`online/src/bridge/pages/collector/CollectorExpensesPage.tsx`) muestra todos los gastos de la ruta desde siempre, mezclando los ya incluidos en un cuadre o cierre con los del periodo abierto. No se suman dos veces (el total «Hoy» solo cuenta los de hoy), pero confunde. **Opción A aprobada por el propietario (2026-10-27):** arriba los gastos del periodo abierto; abajo, en un bloque plegado, los ya cerrados con la etiqueta «Incluido en el cierre del dd/mm». No se oculta ni se borra nada; solo presentación, sin cambios de dinero. Aplica a Cobrador y Supervisor. **Corte aprobado (2026-10-27):** el **último cierre de ruta realizado** (Liquidación → Cierre de ruta), de cualquier rango; no el cuadre del trabajador. Coordinar con 3.14, que toca la misma pantalla | Alta | Pendiente; para el chat Central | Socio, 2026-10-27 |
| 3.19 | **Liquidaciones: vocabulario y último cierre (petición del socio, nombres aprobados por el propietario el 2026-10-27):** el socio cierra cuando quiere, no solo por semana (el servidor ya lo admite: cualquier rango sin solapes que no termine en el futuro). En `src/pages/admin/WeeklySettlementPage.tsx`: menú **«Liquidación» sin cambio**; título «Liquidación Semanal · Lunes a Sábado · por ruta» → **«Liquidaciones»**; pestaña «Liquidación de ruta» → **«Cierre de ruta»**; «Cuadre por trabajador» sin cambio; «Inicio semana»/«Fin semana» → **«Desde»/«Hasta»**; «Cerrar semana» → **«Hacer cierre»**; «Liquidaciones archivadas» → **«Cierres realizados»**; aviso visible **«Último cierre: dd/mm – dd/mm»** o **«Esta ruta aún no tiene cierres»** (hoy, sin cierres, la tabla simplemente no aparece). Fechas propuestas: «Desde» = día siguiente al último cierre, fijo, para no dejar huecos (hoy se proponen lunes–sábado de la semana actual y un domingo puede quedar sin cierre); «Hasta» = hoy, editable. **A resolver en el chat Central:** el primer cierre de una ruta (sin cierre previo, «Desde» editable) y volver a cerrar un periodo reabierto (mismo rango). **Los encabezados del CSV no cambian** (1.4). Sustituye en esta pantalla el rótulo «Liquidación» de la auditoría de nombres. Guía para el socio: [GUIA_SOCIO_LIQUIDACIONES_Y_CIERRES.md](./GUIA_SOCIO_LIQUIDACIONES_Y_CIERRES.md) | Alta | Pendiente; para el chat Central | Socio, 2026-10-27 |

## 4. Validaciones pendientes

| # | Validación | Fuente |
|---|---|---|
| 4.1 | Pruebas del socio sobre lo publicado en R73 y R74 (guía R73 §9). Las pruebas con dinero van en una empresa sintética autorizada, nunca en BlueLine | R73 §9 |
| 4.2 | Modo offline en teléfonos reales, en una empresa de prueba | R65 §7 |
| 4.3 | Mapa y GPS en uso de campo | R67 |
| 4.4 | Prueba de carga con varias empresas. En pruebas anteriores aparecieron errores 500 intermitentes bajo carga | R40 §9 |
| 4.5 | Render real: apagado ordenado del servidor (RND-060 sigue omitida), latencia entre Virginia y São Paulo, y consumo de salida | ADEX_ONLINE_RENDER §7 |
| 4.6 | Primer cierre real del mismo día (`bca28d3`): el socio ve el aviso y, después, mueve al día siguiente lo que falte | R75 |
| 4.7 | Socio: buscador de clientes en su celular (`c1976db`) | R75 |
| 4.8 | Validaciones del socio en general (identificación de clientes, SOC-10 incluida, cuando se confirme el documento) | R73 |

## 5. Riesgos documentados (sin aceptación expresa del propietario)

Ninguno de estos riesgos fue aceptado expresamente. Se mantienen documentados hasta que el propietario los acepte o pida corregirlos.

| # | Riesgo | Fuente |
|---|---|---|
| 5.1 | Si se borran los datos del navegador antes de sincronizar, se pierde lo pendiente del modo offline | R62 §5 |
| 5.2 | El «wifi sin internet» se detecta solo por tiempo de espera | R62 §5 |
| 5.3 | Un abono que aún no se confirmó con el servidor no tiene recibo de WhatsApp | R62 §5 |
| 5.4 | Si se pierde la respuesta al crear un cliente con «Crear venta ahora», la pantalla avisa que el resultado es incierto y no reintenta | R65 §6 |
| 5.5 | Con husos horarios distintos, la venta propone como inicio el «hoy» del dispositivo | R67 §5 |
| 5.6 | Secretario: no existe un estado «en disputa» si el dinero se movió físicamente y el Administrador lo rechaza. En Base por Ruta el Secretario solo ve el historial, así que solo aplica al modelo de bolsas | R53 §2 |
| 5.7 | Tras un cierre del mismo día, las capturas offline de ese día que lleguen después se rechazan con PERIOD_CLOSED | R75 |
| 5.8 | ~~Todas las copias y su clave en un solo equipo; sin copia posterior a la activación~~ → **mitigado** el 2026-10-26: hay copia nueva y copia en OneDrive. Clave de recuperación creada y comprobada: las copias de OneDrive se pueden abrir sin este equipo. Queda el límite de que las tareas solo corren con la sesión de Windows iniciada | R76 |

## 6. Orden y limpieza (mantenimiento y evidencias)

| # | Pendiente | Tipo | Fuente |
|---|---|---|---|
| 6.1 | Limpieza histórica de la prueba de concepto de la Fase 0A.1 en Supabase. **No autoriza** borrar esquemas, revocar credenciales, rotar contraseñas ni pausar o borrar **el proyecto actual** («ADEX-Staging», que aloja BlueLine). Antes de cualquier actuación hay que identificar qué proyecto, esquema y credencial es de la POC y qué depende de cada uno | Decisión | SAAS_FASE_0A1 §R.7–R.12 |
| 6.2 | Restos sintéticos de pruebas en la base gestionada: empresas `stg-*`, «Empresa Prueba Brasil R40», el Owner temporal y operadores Demo inactivos. Por diseño no se borran físicamente: ¿se archivan o se dejan? | Decisión | R39 §9, R40 §9 |
| 6.3 | Borrar una transcripción de variables del servicio Owner que quedó en la carpeta privada | Decisión | R40 §9 |
| 6.4 | Reorganización: bloque 0 (respaldo privado de `tmp/`) y bloque 4 (poda de evidencias). También `tmp/accesos/` y capturas con datos reales | Decisión | AUDITORIA_ORGANIZACION §8, §11 |
| 6.5 | Git: el respaldo guardado de la Ronda 23 (rechazada) sigue en `git stash`. La rama `r74-route-base` ya está incluida en `main` y puede borrarse | Orden | Git |
| 6.6 | ~~Git: sin guardar el informe para ChatGPT, este listado y dos filas del Registro Maestro~~ → **Hecho en R76**: se versionan este listado y el Registro Maestro. El informe del 2026-10-24 se versiona como referencia histórica | Orden | R76 |
| 6.7 | Vacíos históricos del Registro Maestro: rondas sin documento propio, fechas de despliegue desconocidas | Orden (solo documentación) | Registro §G |

## 7. Hallazgos de informes antiguos: pendientes de comprobar vigencia

Vienen de documentos de septiembre (etapa CLEAN). **No son defectos actuales confirmados**: antes de trabajar en ellos hay que comprobar si siguen vigentes en Online.

| # | Tema | Fuente |
|---|---|---|
| 7.1 | ¿Las rutas cobran en domingo? | PARIDAD_MOVIL §9 |
| 7.2 | Exportar reportes desde el móvil del Supervisor | PARIDAD_MOVIL §9, SUPERVISOR_MOVIL |
| 7.3 | ¿La fecha oficial de una venta es la de registro o la de inicio? | REVISION_SOCIO_RQ01_RQ05 |
| 7.4 | Supervisor como responsable del efectivo (D-1, D-2 y D-6) | AUDITORIA_CUADRE_CAJA_SUPERVISOR §36 |
| 7.5 | A quién se atribuyen los cobros históricos de los Supervisores | IMPLEMENTACION_SUPERVISOR §12 |
| 7.6 | **D4 Supervisor** | Decisiones SaaS |

## 8. Cerrados (no volver a abrir)

| Tema | Dónde se cerró |
|---|---|
| Sobrante sin identificar (F6-D02) | R74: el Administrador concilia (RB-D3, 0036) |
| Caja de socios, D1 y D19–D23 | R53: se retiró el Socio |
| D2 entre Administradores y D3 confirmación de recepción | R53 / R59 |
| DS-04, DS-07, DS-10 y DS-11 | Fases 2–6, R62 / R65 |
| Administrador no responsable que aprueba (R39 O-1) | 0037: conserva permisos operativos sin autoridad de capital |
| Owner sin desplegar (bloqueo 2 del piloto) | R40 |
| Riesgos de concurrencia R1–R11 y fin de periodo por el reloj del dispositivo | Servidor (Fases 2–6) |
| Indicadores «Asignado / En rutas / Colocado» | R59 y R74 (panel de rutas) |
| Pruebas HIST-001/002/003 | `8d37c05` |
| Normalización de nombres (N-1 a N-6) | `9ca7dc4`. Los tipos de gasto (2.1.15) se decidieron el 2026-10-27: conservan sus nombres y se añade la casilla «Para Cobradores» (3.14). El rótulo de CLEAN (3.11) no afecta a Online |
| Publicación de R73 y R74 | `2fa7152`, `8d37c05` |
| Revisión personal general de Online (1.1) | Propietario, 2026-10-24/25 |
| RB-D13 como decisión (la interfaz sigue en 3.12) | Propietario |
| RB-D10: faltante de acta queda como faltante de la ruta | Propietario, 2026-10-27 |
| RB-D11 y RB-D12 como decisión: solo el Administrador anula, también lo propio; gasto general completo por quien lo registró (la implementación sigue en 3.17) | Propietario, 2026-10-27 |
| Transferencias entre rutas inmediatas (regla vigente) | R59 / R74 |
| Crear clientes o ventas sin conexión: **prohibido** | R65 (decisión vigente) |
| Nombres de Liquidación: menú «Liquidación», ventana «Liquidaciones», pestañas «Cierre de ruta» y «Cuadre por trabajador»; «cierre» = cualquier rango, no solo semanal (implementación en 3.19) | Propietario, 2026-10-27 |
| Cierre de periodo que incluye el día en curso | `bca28d3` + 0038 (2026-10-26) |
| Búsqueda sin acentos en todos los buscadores (3.1) | `c1976db` + `bffdfc1` (2026-10-27) |
| Pagar por número de cuotas (3.15) y fecha del desembolso (3.16) | `225dbc6` (2026-10-27) |
| Mora al día (3.2) | R76 |
| Desactivación de trabajadores con efectivo (3.3 y 2.3.9): no se bloquea; efectivo visible y cuadrable | R76 (por diseño) + propietario 2026-10-27 (2.3.9, opción A) |
