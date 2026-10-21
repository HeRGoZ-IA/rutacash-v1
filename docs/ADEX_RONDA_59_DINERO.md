# ADEX Online · Ronda 59: DINERO, Transferencias, Notificaciones y Consultas

Fecha: 2026-10-20. Base: `origin/main` 896d806 (R55 publicada, staging 0001–0024).

Alcance: **ADEX Online** (`online/`, `saas/`) y la retirada pública de **CLEAN**. Offline queda fuera.
Pruebas solo en bases aisladas (PostgreSQL embebido) y pila local; en Online, solo lecturas.

## 1. Criterios de cierre (fijados antes de modificar código)

| Bloque | Se cierra cuando |
|---|---|
| A · Entregas voluntarias (servidor) | (1) El traspaso **directo** entre Administradores se aplica al registrarse (sin confirmación del destino), con idempotencia, saldo suficiente bajo bloqueo y sin doble consumo. (2) El Administrador devuelve capital de **su** bolsa al SuperAdmin (`ADMIN_RETURN`, mismo comando) sin aprobación. (3) El Cobrador registra la entrega de efectivo de **su** custodia al responsable de la ruta (`WORKER_RETURN`, mismo comando) sin aprobación; nunca la de otro. (4) La conciliación da `ok` tras cada caso. |
| B · Solicitudes | Solicitar no mueve dinero. Solo quien tiene el capital la atiende, con el comando ordinario y el id de la solicitud **en la misma transacción**; una solicitud se atiende una sola vez (doble clic, reintento y concurrencia probados); rechazar y cancelar exigen motivo; resueltas o con solicitante inactivo se rechazan; todo auditado. |
| C · Secretario | El registro por Secretario sigue pendiente de ambos Administradores; el Secretario no decide; sus pruebas de R53 siguen pasando. |
| D · Notificaciones | `GET /v1/notifications` devuelve, para el contexto activo, «Requieren acción» (solicitudes a atender y confirmaciones de Secretario) e «Informativas» (movimientos recibidos, resoluciones); el contador solo cuenta lo que requiere acción; sin saldos ajenos ni otra empresa. Pestaña en DINERO (Administrador y SuperAdmin) y en el Cobrador, con globo. |
| E · Administrador | DINERO = Caja principal, Gastos, Transferencias, Notificaciones, Consultas. Caja principal: resumen fiable (recibido, disponible, a cargo de trabajadores, gastos), sin «Conciliación de la bolsa» ni historiales largos. |
| F · SuperAdmin | DINERO = Capital, Gastos, Notificaciones, Consultas. Capital con un único botón **Realizar movimientos** (mismo formulario). Sin Transferencias ni Retiros en su menú. |
| G · Transferencias | Un único **Nueva operación** con el catálogo del rol (entregar a trabajador, recibir devolución, transferir a otro Administrador, devolver al SuperAdmin y solicitudes); las operaciones no se ocultan por saldo cero o falta de rutas: dicen por qué no se pueden hacer. **Ver movimientos** lleva a Consultas. |
| H · Consultas | La pestaña Caja pasa a **Consultas** («Movimientos, caja por ruta, historial y filtros»), sin «Caja rutas» ni pestañas heredadas; concentra el historial con filtros y la caja por ruta; Historial y Retiros redirigen aquí. |
| I · Retiros heredados | Sin entrada, pantalla ni textos del saldo heredado de antiguas cajas de ruta; las operaciones legítimas (retiro de capital de la empresa, devoluciones) siguen donde corresponden. |
| J · CLEAN | `rutacash-clean.vercel.app` deja de servir CLEAN; ADEX Online y Owner siguen respondiendo; el código compartido sigue compilando. |
| K · Pruebas y publicación | typecheck, unitarias, PostgreSQL real, CLEAN y Online pasan; navegador sobre pila local; publicación comprobada por `/healthz` y bundle servido. BlueLine y las dos cuentas Owner intactas (solo lecturas). |

## 2. Contrato de las entregas y solicitudes (migración 0025)

Regla del propietario: **quien tiene el dinero lo entrega sin pedir autorización; quien lo necesita, lo solicita.**

| Operación | Quién la registra | Asiento (mismo libro) | Aprobación del receptor |
|---|---|---|---|
| Asignar capital a un Administrador | SuperAdmin | `ADMIN_ALLOCATION` empresa → caja | No |
| Devolver capital al SuperAdmin | Administrador (de **su** caja) | `ADMIN_RETURN` caja → empresa | No |
| Recoger capital de un Administrador | SuperAdmin | `ADMIN_RETURN` | No (sin cambios) |
| Entregar capital a un trabajador | Administrador responsable de la ruta | `WORKER_DELIVERY` | No (sin cambios) |
| Entregar efectivo al Administrador | **Cobrador** (de **su** custodia) | `WORKER_RETURN` custodia → caja del responsable | No |
| Transferir a otro Administrador | Administrador origen | `ADMIN_TRANSFER_HOLD` + `ADMIN_TRANSFER_APPLY` en la misma transacción | No (`not_required`) |
| Transferencia registrada por Secretario | Secretario | HOLD al registrar; APPLY con las dos confirmaciones | **Sí, ambos** (sin cambios, R53) |

- **Saldo suficiente, sin doble consumo:** la restricción de sobregiro de cada caja y el bloqueo de cuentas en orden global
  (sin cambios). La custodia del Cobrador no baja de su arrastre (0014) ni queda negativa (0013).
- **Cobrador:** solo su efectivo, solo en sus rutas, y nunca hacia una caja de la misma persona (AX410). El responsable
  queda avisado y, si no lo recibió, la **anula** desde Consultas (asiento espejo).
- **Recaudo y devolución de base** son dos conceptos del mismo asiento `WORKER_RETURN`: quedan en el motivo
  («Entrega de recaudo» / «Devolución de base») y en la auditoría.
- **Directos pendientes de la regla anterior:** 0025 no toca datos; si existe alguno, se sigue confirmando o rechazando.

### Solicitudes (`adex.capital_requests`)

| Tipo | Pide | Atiende (tiene el capital) | Se atiende con |
|---|---|---|---|
| `admin_allocation` | Administrador | cualquier SuperAdmin | la asignación ordinaria |
| `admin_return` | SuperAdmin | el Administrador | su devolución ordinaria |
| `admin_transfer` | Administrador | otro Administrador | la transferencia directa ordinaria |
| `worker_return` | Administrador responsable de la ruta | el Cobrador | su entrega ordinaria (concepto recaudo o base) |

- Pedir **no mueve dinero**. Atender = el comando ordinario con `requestId`; en la MISMA transacción el servidor bloquea
  la solicitud (`capital_request_lock`), ejecuta el comando y la enlaza (`capital_request_fulfill`), comprobando que la
  operación es la pedida (tipo, partes, ruta). Si falla cualquier paso, nada queda escrito.
- Una solicitud se atiende **una vez** (doble clic, reintento y concurrencia probados) y una operación atiende **una**
  solicitud (índices únicos). Rechazar (quien tiene el capital) y cancelar (quien pidió) exigen motivo. Resueltas, o con
  el solicitante inactivo, ya no se atienden (`REQUEST_NOT_PENDING`).
- Visibilidad (RLS): quien pide y quien tiene el capital; el SuperAdmin, todas las de su empresa. Nunca saldos ajenos.

### Notificaciones (`GET /v1/notifications`, `GET /v1/notifications/count`)

Derivadas de los registros del servidor con la RLS del contexto activo; no hay una tabla de avisos.

- **Requieren acción** (cuentan en el globo): solicitudes que le toca atender y confirmaciones de traspasos registrados
  por Secretario.
- **Enviadas:** sus solicitudes pendientes (puede cancelarlas).
- **Informativas** (30 días): capital recibido, recogido o devuelto, entregas de efectivo del Cobrador, transferencias
  recibidas y resoluciones de sus solicitudes.
- El globo se relee con el refresco normal de ADEX (comandos propios y huella `/v1/changes`), sin sondeos propios.
- Atender abre el formulario ORDINARIO con los datos precargados; la bandeja no mueve dinero.

### API y despliegue

`POST /v1/capital/own-returns` (Cobrador) · `requestId` en `allocations`, `admin-returns` y `admin-transfers` ·
`GET|POST /v1/capital/requests`, `GET /v1/capital/requests/:id`, `POST …/:id/reject|cancel` · `GET /v1/notifications`
y `/count`. `/healthz` anuncia `capital-requests-v1` solo con 0025 aplicada; la puerta de Vercel lo exige.
Errores nuevos: `AX417 REQUEST_NOT_PENDING`, `AX418 REQUEST_MISMATCH`.

## 3. Interfaz (ADEX Online)

| Rol | DINERO |
|---|---|
| Administrador | Caja principal · Gastos · Transferencias · Notificaciones · Consultas |
| SuperAdmin | Capital · Gastos · Notificaciones · Consultas |
| Cobrador | «Avisos» en su barra (Notificaciones + «Entregar efectivo») |

- **Caja principal:** capital disponible, capital recibido (neto), a cargo de trabajadores, gastos pagados y, si existen,
  transferencias con otros Administradores; «Registrar gasto» y «Ver movimientos». Sin «Conciliación de la bolsa».
- **Capital (SuperAdmin):** cifras del servidor (aportado neto, sin asignar, en cajas, a cargo de trabajadores,
  cartera), Administradores y responsables de ruta; un único **Realizar movimientos** (ingreso, asignación, recogida,
  retiro y la solicitud de devolución). Sin historial largo: «Ver movimientos» lleva a Consultas.
- **Transferencias (Administrador):** un único **Nueva operación** con todo el catálogo; las operaciones imposibles en
  ese momento se ven y dicen por qué. Sin historial: «Ver movimientos» lleva a Consultas.
- **Consultas** (antes Caja): Movimientos (historial con filtros y comprobantes), Transferencias (con anulación para el
  responsable) y Caja por ruta. `/admin/cashbox`, `/admin/movements`, `/admin/withdrawals` y `/admin/partner-cash`
  llevan aquí con sus filtros.
- **Retiros** (saldo heredado de antiguas cajas de ruta): eliminado de Online (menú, pantalla y textos, también en la
  tarjeta de efectivo de ruta del Cuadre). El retiro de capital de la empresa y las devoluciones siguen donde corresponden.
- CLEAN (`src/`) no se modifica: Online lo compila con puentes.

## 4. Pruebas (fuera de ADEX Online: PostgreSQL embebido y pila local)

| Ámbito | Resultado |
|---|---|
| API · typecheck y unitarias | OK · 23/23 |
| API · PostgreSQL real (contratos + integración) | 382/383 (1 omitida: Auth real), 0 fallos |
| Entregas voluntarias y solicitudes (`capital-requests.test.ts`) | 7/7: devolución del Administrador, entrega del Cobrador (recaudo/base, límites, misma persona, anulación), solicitudes de los 4 tipos, atender una sola vez, concurrencia, discrepancia, rechazo/cancelación, aislamiento, Secretario, inmutabilidad, conciliación |
| Traspasos (`admin-transfers.test.ts`, reescrita) | directo aplicado en el acto, idempotencia, doble consumo, concurrencia; Secretario sin cambios |
| Online en Chrome real (`tmp/r59/visual.mjs`, Online compilado + API local) | 61/61: menús por rol, Caja principal, Transferencias, operación sin capital, solicitudes atendidas, Cobrador móvil, Secretario, Consultas y redirecciones, anulación, móvil/tableta sin desbordes, Gastos sin cambios, sin errores JS |
| Huella de staging (solo lectura) antes de publicar | 0001–0024; solo BlueLine (1 ruta, 6 miembros, 0 operaciones de capital, 0 directos pendientes); 2 Owners reales activos |
