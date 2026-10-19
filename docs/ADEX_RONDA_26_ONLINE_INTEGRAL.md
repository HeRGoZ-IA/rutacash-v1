# Ronda 26 · ADEX Online integral: todas las pantallas de CLEAN sobre el servidor

Fecha: 2026-10-19 · Base: `3c7f9fe` (Rondas 24 y 25) · Estado: ver §8.

## 1. Resultado

ADEX Online es una sola aplicación: **el frontend original de CLEAN** (sus pantallas, layouts, componentes y textos) compilado contra la API SaaS. Ya no hay módulos «pendiente de conexión» ni enlaces a la interfaz Online provisional, que se retiró (`/operaciones` redirige al inicio).

| Rol | Pantallas originales de CLEAN en uso |
|---|---|
| SuperAdmin / Administrador | Dashboard, Oficinas, Rutas, Clientes, Ventas activas, Autorizaciones, **Ajustes de pago**, Capital / Caja principal, Gastos, Categorías, Transferencias, Historial, Comprobante, **Caja socios**, Retiros, **Caja**, **Reportes**, **Liquidación semanal**, Usuarios, Configuración |
| Cobrador y Supervisor | **Toda la capa operativa** (`/collector`, `/supervisor`): Inicio, Recaudo, Abonar, No pagó, Ficha del cliente, Nuevo cliente, Nueva venta, Desembolsos, Gastos, Cuadre («Mi efectivo»), Cuadrar trabajadores, Autorizaciones, Informe del día, Historial de abonos, Sincronización, Mi cuenta |
| Secretario | **Clientes, Autorizaciones, Corrección de pagos, Mi cuenta** |
| Socio | **Resumen, Clientes, Reportes, Mi caja, Mi cuenta** |

En negrita, lo nuevo de esta ronda. CLEAN no cambió (`git status src/` vacío).

## 2. Adaptaciones visibles (todas marcadas «ADEX Online:» en el código)

| Dónde | Cambio | Motivo |
|---|---|---|
| Alta de cliente (Administrador y Cobrador) | Campo **Tipo de documento** (Cédula de ciudadanía por defecto en Colombia) | El servidor valida el número y su unicidad por tipo y país (DS-10). Es el único campo añadido. |
| Layout del Cobrador y Supervisor | Aviso sin conexión veraz («nada se guarda en este dispositivo»), aviso de servidor despertando, banda de Empresa Demo, «Cambiar empresa o rol» con varias membresías | Mismos cambios que ya tenía el layout del Administrador (DS-05, DS-07). |
| Sincronización | El aviso dice que cada registro se confirma en el servidor | CLEAN decía que se guardaba en el dispositivo. |
| Caja socios (Administrador) | «Nuevo movimiento» manual explica que falta la decisión **D1** y no registra nada | Ver §6. |
| Corrección de pagos | El pago corregido queda con la fecha de hoy | El servidor no fecha asientos en el pasado (DS-04). |

Se **retiró** la copia del Dashboard: «Rutas con mora» ya se calcula (regla original de CLEAN sobre las cuotas del servidor), así que vuelve a usarse la pantalla original sin cambios.

## 3. Servidor (migraciones 0015–0019, aditivas)

| Migración | Qué añade |
|---|---|
| 0015 | Alta de **visitas sin pago** (`POST/GET /v1/no-payment-visits`): solo quien cobra, venta activa de esa ruta, fecha de la empresa, sin UPDATE ni DELETE. |
| 0016 | **Reapertura de una semana cerrada** (`POST /v1/periods/:id/reopen`): responsable o SuperAdmin, motivo ≥ 10, el archivo del cierre no cambia; volver a cerrar crea la versión 2. |
| 0017 | **Corrección de pagos** en una transacción (`POST /v1/collections/:id/correct`) y **solicitudes de ajuste** (`/v1/payment-adjustments`: crear, aprobar = corregir, rechazar). Reutiliza los motores de 0013 sin copiarlos. `payment.correct` en la segunda barrera SQL. |
| 0018 | Una sola fuente de la **fecha contable** (`adex.business_today`) y el **reloj de inicialización de la Empresa Demo** (§5). Para cualquier otra empresa la fecha es la real, como antes. |
| 0019 | **Conciliación de capital a escala**: las comprobaciones que recorren el libro (posiciones, operaciones, custodias, cuadres, sobrantes, periodos cerrados) se ejecutan en una sola función del propietario, reservada al SuperAdmin del contexto. Las consultas son las mismas, con el mismo resultado. Antes, la evaluación fila a fila de la seguridad por filas superaba el tope de 2 min con seis meses de datos. |

Lecturas nuevas: cuotas en bloque por ruta (`GET /v1/installments`), páginas con cursor y filtro por fecha en recaudos, gastos y créditos, `periodClosed` en cada pago, historial de responsables de capital (`GET /v1/capital/controller-events`), nombre del responsable en el listado de trabajadores cuadrables y nombre de la persona en el contexto.

## 4. Pruebas

| Prueba | Resultado |
|---|---|
| SaaS `npm run test:db` (PostgreSQL real, migraciones 0001–0019) | 322/323 · 0 fallos · 1 omitida (`tmp/saas-phase01/evidence/db-tests-2026-10-19T07-04-53-481Z.log`) |
| E2E Cobrador · Supervisor · Caja · Liquidación (`tmp/r26/e2e-campo.mjs`, Chrome real, staging) | 37/37 |
| E2E Secretario · Socio · Ajustes · Caja socios · Reportes · Dashboard (`tmp/r26/e2e-oficina.mjs`) | 26/26 |
| Regresión Ronda 24 (`tmp/r24/e2e.mjs`) | 61/62 → caso UI-35 actualizado (la Caja ya no es pendiente) |
| Regresión Ronda 25 (`tmp/r25/e2e-capital.mjs`) | 50/50 |

Garantías comprobadas en cada E2E: un triple toque no cobra ni desembolsa dos veces; en el navegador solo hay la sesión (y la ruta activa elegida); sin errores de JavaScript; conciliación del servidor OK; Empresa Demo y demás empresas intactas por huella; usuarios de prueba eliminados de Auth.

## 5. Empresa DEMO de seis meses

(Se completa al terminar la inicialización.)

## 6. Decisión de negocio pendiente: D1 (Caja socios)

Lo que funciona: el **aporte de un socio** a la bolsa del Administrador responsable de una ruta (Transferencias), su anulación, y su reflejo como «salida» en la Caja del socio (igual que CLEAN con capital centralizado).

Lo que no se registra: los **ingresos y salidas manuales** de Caja socios. Decidir si la caja de un socio debe tener fondos, de dónde salen y cómo se concilia con el capital de la empresa es D1. Alternativas compatibles con el modelo actual:

| | Alternativa | Efecto financiero |
|---|---|---|
| A | La Caja socios es un **registro informativo** de lo que el socio aportó y retiró (sin saldo propio en el libro) | Ningún cambio en el capital; los ingresos/salidas no mueven dinero de la empresa. Es lo que hace hoy CLEAN cuando el saldo queda negativo (caso Barreiro). |
| B | La Caja socios es una **cuenta del libro** (el socio deposita en ella y desde ella aporta a bolsas) | Exige saldo para aportar; un ingreso manual es capital que entra a la empresa por el socio; requiere conciliación socio ↔ empresa. |
| C | Sin Caja socios propia: **solo aportes y retiros de socio** contra el capital de la empresa | Los movimientos de socio son depósitos/retiros de capital etiquetados con el socio. |

## 7. Pendientes reales

| # | Pendiente | Tipo | Qué hace falta |
|---|---|---|---|
| P1 | **D1 · Caja socios**: ingresos y salidas manuales (§6) | Decisión de negocio | Elegir A, B o C. Hasta entonces la pantalla original muestra los aportes y rechaza los movimientos manuales con un mensaje claro. |
| P2 | **Indicadores de Capital «Asignado / En rutas / Colocado»** | Definición pendiente | En CLEAN salen de la colocación heredada por ruta, que en una empresa nativa del servidor vale 0. No se inventa una fórmula: las cifras reales del libro (bolsas, custodia, cartera, interés, gastos) sí se muestran. Hay que decidir qué cuenta del libro corresponde a cada indicador. |
| P3 | **Sobrante de cuadre sin identificar** (F6-D02) | Decisión de negocio heredada | Queda en control, sin gastarse, como hasta ahora. |
| P4 | **Despliegue del API en Render** | Acción del propietario | El servidor publicado aún no tiene las migraciones del API nuevo (0015–0018 ya están en staging). La publicación del frontend está bloqueada por la compuerta hasta que /healthz anuncie `clean-online-v1`. |
| P5 | **Proyecto gratuito de Supabase** | Riesgo operativo | La inicialización larga de la Demo mostró bloqueos de hasta 2 min en el proyecto gratuito. Para el uso real conviene un plan con recursos garantizados. |

## 8. Estado de publicación

(Se completa al final.)
