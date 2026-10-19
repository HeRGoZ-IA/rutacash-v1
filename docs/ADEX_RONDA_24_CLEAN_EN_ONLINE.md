# Ronda 24 · ADEX Online construido sobre el frontend real de CLEAN

Fecha: 2026-10-18 · Base: `095ab5b` · Estado: **demostración local, sin commit ni publicación**, a la espera de aprobación del propietario.

## 1. Decisión técnica

ADEX Online compila **los archivos originales de CLEAN** (`src/`) y solo sustituye la capa de datos y sesión.

- `online/vite.config.ts` resuelve cada import de CLEAN (`@/…` o relativo) así: si existe `online/src/bridge/<misma ruta>`, usa el puente; si no, usa el **archivo original** de `src/`. No hay copias de pantallas salvo las cinco indicadas en el punto 3.
- `dexie` está prohibido en el bundle de empresas (un módulo que intentara abrir una base local falla en el acto). El único almacenamiento del navegador es la sesión del cliente de modo servidor (`adex-server-mode`: tokens y membresía elegida).
- Tailwind usa el `tailwind.config.js` de CLEAN; la hoja de estilos es `src/styles/globals.css` original; `index.html` repite la cabecera de CLEAN (fuente Inter, iconos).
- CLEAN no se modificó: `git status` de `src/`, `public/`, configuración raíz y `saas/` está vacío.

Medido sobre el grafo de módulos de una compilación: **116 archivos originales de CLEAN** entran tal cual en el bundle de empresas (9 páginas de administración sin ningún cambio, 27 componentes de interfaz, guardas, hooks, bibliotecas, servicios, logos y estilos) y **26 archivos de puente**.

## 2. Capa de datos sustituida (`online/src/bridge`, `online/src/runtime`)

| Original de CLEAN | En ADEX Online |
|---|---|
| `lib/db.ts` (Dexie) | Proyección de **solo lectura y solo memoria** del servidor con la misma API (`where/equals/toArray/get/count…`). Escrituras: solo una lista blanca traducida a comandos de la API (`runtime/writeAdapters.ts`); el resto falla cerrada. Las tablas del libro local sin equivalente (movimientos de capital, custodia, retiros, transferencias…) lanzan «dato pendiente». |
| `dexie-react-hooks`, `lib/dataRevision.ts` | Mismo contrato; se refresca tras cada comando confirmado y cada 20 s con la pestaña visible. |
| `hooks/useAuth.ts` | Mismo store; acceso con el proveedor de identidad y contexto validado por el servidor (DS-05). `user` = membresía activa. |
| `hooks/useOnlineStatus.ts` | «En línea» = el servidor responde. |
| `lib/permissions.ts` | Reglas originales y, además, solo las capacidades que el servidor devuelve para el contexto (restricción, nunca ampliación). |
| `lib/formatters.ts` | Moneda de la empresa del servidor (COP idéntico a CLEAN). |
| `services/cashboxEngine.ts` | Base de la ruta = Σ custodia del servidor; Cartera = fórmula original de CLEAN sobre los saldos de crédito del servidor. |
| `services/adminDashboardService.ts` | Misma interfaz; cifras del servidor (ver punto 6). |
| `services/routeService`, `officeService`, `routeAssignment`, `saleRequestService`, `paymentService`, `paymentCorrectionService`, `expenseService` | Escrituras → comandos de la API (idempotentes con id de operación en los de dinero). Consultas originales conservadas. |
| `services/capitalControlService.ts` | Solo el disponible de la empresa y de cada bolsa (mismo significado). El resto sin conectar. |
| `services/auditService`, `platform/companyControlService`, `platform/controlPlane` | Sin escritura local: el servidor audita cada comando en su transacción; la telemetría Owner no sale de la empresa (DS-17). |

## 3. Pantallas originales con cambios mínimos (copias marcadas «ADEX Online:»)

| Pantalla | Cambio y motivo |
|---|---|
| `AdminLayout` | Banda «sin conexión» veraz (nada se guarda en el dispositivo); banda «activando el servidor»; banda de Empresa Demo; «Cambiar empresa o rol» solo con varias membresías. |
| `DashboardPage` | «Rutas con mora» muestra «—» y «Pendiente en el servidor». |
| `UsersPage` | Sin contraseña inicial ni restablecimiento (proveedor de identidad); correo y rol fijos al editar (DS-05); al eliminar, el error muestra el motivo del servidor. |
| `SettingsPage` | País, moneda, estado y vigencia de solo lectura; «Sobre ADEX Soluciones» indica servidor central; exportación avisa que no existe. |
| `LoginPage` | «App cobrador offline / funciona sin internet» → «App cobrador en línea» (DS-07). |

Nuevas, con el marco visual de CLEAN: selección de empresa y rol (`/contexto`, mismo marco que LoginPage) y el aviso de módulo pendiente (mismo marco que `AdminNoRoutes`).

## 4. Estado de las pantallas del Super Admin

**Funcionan con el servidor (pantalla original), probado de punta a punta:**

| Pantalla | Probado en `tmp/r24/e2e.mjs` | Conectado, sin prueba E2E todavía |
|---|---|---|
| Dashboard | cifras = API (Base, Cartera, Recaudo hoy), mora pendiente | — |
| Oficinas / Sin Oficina / detalle | alta, editar código, inactivar, reactivar, alta y eliminación de oficina vacía, panel de la Oficina | organizar rutas en bloque, asignar rutas a personas desde la Oficina |
| Rutas | alta con Oficina, Administrador y Cobrador; editar; desactivar y reactivar | cambiar responsable de capital, eliminar |
| Clientes | consulta, editar teléfono; alta rechazada con la brecha declarada | eliminar |
| Ventas activas | consulta, venta directa, registrar abono, anular abono | — |
| Autorizaciones | aprobar, rechazar con motivo | — |
| Gastos | de trabajador, administrativo (bolsa empresa), anular, reintegro | de ruta (lo registra el Administrador responsable) |
| Categorías de gasto | alta, renombrar, inactivar | eliminar |
| Usuarios | alta (Administrador, Cobrador, Socio, Secretario), editar nombre, inactivar, eliminar sin historia, rechazo con historia | rutas desde el formulario de la persona |
| Configuración | guardar datos de la empresa; país y moneda de solo lectura | — |

**Pendientes, con aviso y acceso a la pantalla de transición** (`/operaciones`, mismas pantallas Online anteriores, misma sesión): Capital, Transferencias, Historial, Retiros, Caja, Reportes, Liquidación, Ajustes de pago, Transición al capital centralizado, Comprobante.

**Otros roles** (Administrador usa el mismo panel y funciona con su alcance; Cobrador, Supervisor, Socio y Secretario): aviso de conversión pendiente y acceso a las pantallas de transición.

## 5. Brechas revalidadas contra el código

Clasificación: (1) implementado y utilizable · (2) en servidor, sin interfaz original conectada · (3) no implementado en servidor · (4) diferencia deliberada.

| Tema | Clase | Detalle |
|---|---|---|
| Visitas sin pago | 3 | No hay endpoint. |
| Reportes completos y exportaciones | 3 | No hay endpoints. |
| Mora | 3 (parcial) | `installments.days_overdue/status` solo se recalculan al registrar un abono; no hay dato diario fiable. El Dashboard no muestra cifra. La «cartera vencida» del panel de Oficinas es la fórmula original de CLEAN (saldo de cuotas con vencimiento anterior a hoy) sobre las cuotas del servidor. |
| Cartera con interés | 1 | Saldo por crédito (capital + interés) del servidor; el total lo suma la pantalla (listado de hasta 500 créditos). `portfolioMinor` del resumen de capital es solo capital pendiente y **no** se etiqueta como cartera. |
| Corrección de pagos por solicitud | 3 | Solo existe la anulación directa (conectada). |
| Transferencias y operaciones de bolsas | 2 | Entregas, devoluciones, traspasos, reasignaciones, aportes, retiros: endpoints listos; falta el asistente original. |
| Capital (pantalla) | 2 + decisión | Disponible de empresa y bolsas: mismo significado. «Capital total controlado», «Asignado», «En rutas», colocado por ruta, saldo heredado: sin cifra equivalente en el servidor. Requiere decidir su definición. |
| Caja y Liquidación | 2 | Liquidación por ruta y rango, cierre de periodo y cuadres existen; falta adaptar las pantallas. |
| Historial unificado y comprobantes | 3 (parcial) | Listados separados por tipo; sin historial unificado ni comprobantes. |
| Alta de cliente desde el formulario original | 2 | El servidor exige tipo de documento; el formulario de CLEAN no lo tiene (añadir el campo requiere aprobación). Edición y eliminación conectadas. |
| Fotos de cliente y soportes de gasto | 3 | No hay almacenamiento de archivos. |
| Contraseñas, restablecimiento | 3 | Gestionadas por el proveedor; falta la pantalla de llegada del enlace de recuperación en la aplicación de empresas. |
| Castigo de crédito (marcar perdido) | 3 | No hay endpoint. |
| Cambio de rol de una persona | 4 | DS-05: nueva membresía + desactivar la anterior. |
| Fecha de abonos y gastos | 4 | La fija el servidor (fecha de la empresa). |
| Aprobar solicitud | 4 | El crédito nace al desembolsar (Fase 4); el estado para el negocio es el mismo. |
| Socio y Secretario | 2 | Interfaces CLEAN sin convertir en esta entrega. |

## 6. Cifras del Dashboard

| Tarjeta | Fuente |
|---|---|
| Base total | Σ posiciones de custodia del servidor de las rutas visibles. |
| Cartera activa | Σ saldo de créditos activos desembolsados (fórmula de CLEAN, saldos del servidor). |
| Recaudo hoy / semanal / 7 días / top rutas | Fórmula de CLEAN sobre los abonos del servidor (fecha de la empresa); si el listado no cubre el periodo, agregado de liquidación del servidor. |
| Gastos semana | Igual, con los gastos con ruta. |
| Pendiente sync | 0: ADEX Online no tiene cola local. |
| Rutas con mora | Pendiente en el servidor. |

## 7. Pruebas

- `tmp/r24/e2e.mjs`: **62/62** (empresa sintética `stg-r24-*`, Chrome real, bundle compilado). Cada acción de la tabla del punto 4 verificada en la API; capital, solicitudes y desembolso preparados por API como lo harían los otros roles; Dashboard = API; Capital → pantalla de transición con la misma sesión; en el navegador solo existe la base de sesión; sin errores JS; Empresa Demo (13 tablas) y demás empresas intactas por huella; usuarios de Auth temporales eliminados.
- `tmp/r24/compare.mjs`: **23/23** pantalla×ventana (acceso + 11 pantallas × 2 ventanas) con textos fijos y estilos medidos iguales a CLEAN (1366×900 y 390×844). Online en solo lectura (única petición: elegir contexto).
- Typecheck de `online/`: 0 errores. Typecheck de CLEAN: 0 errores. `npm test` de CLEAN: todas las suites PASS (835+ casos, 0 fallos).
- Panel Owner: hoja de estilos idéntica byte a byte a la de `095ab5b`; su JS solo cambia en los alias del fragmento compartido de React.

## 8. Demostración local

`tmp/r24/ABRIR_ADEX_ONLINE_CLEAN.cmd` → http://localhost:5192 (cuenta `demo.superadmin`, `VER_CREDENCIALES_DEMO.cmd`). Está conectada a la Empresa Demo de ADEX-Staging: lo que se confirme allí se registra. Comparación: `tmp/r24/compare/comparacion.html`.

## 9. Ronda 23

Sus cambios están respaldados en `git stash` («ronda23-rechazada-clean-imitacion (respaldo)») y en `tmp/ronda23-respaldo/`. No se usaron.
