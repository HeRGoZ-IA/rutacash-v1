# ADEX Online · Ronda 67 · SuperAdmin con cartera de solo lectura y mapa de rutas del Administrador

Fecha: 2026-10-21/22. Base: `dcb0575` (= origin/main al empezar). Dos entregas independientes del plan original.

## 0. Resumen

- **Entrega A — SuperAdmin:** en CARTERA solo ve **Clientes**, en **consulta** (lista, búsqueda, filtros, ficha con créditos y
  pagos). No crea, edita, borra, cambia de estado ni de ruta clientes; no vende, no autoriza, no cobra, no anula ni corrige
  pagos, no desembolsa ni castiga. Bloqueado en las tres capas: interfaz, API (matriz única) y PostgreSQL (0028). Conserva
  capital, gastos, estructura (oficinas, rutas, usuarios), cuadres, cierres, consultas y reportes.
- **Entrega B — Mapa del Administrador** (Cartera → «Mapa», `/admin/mapa`): clientes de sus rutas en su ubicación de
  referencia, con el resultado más reciente del periodo (bolsa = venta o crédito, check verde = cobro exitoso, X roja =
  visita sin pago, gris = sin actividad), detalle con el historial, filtros por ruta, trabajador, fechas y tipo, clientes sin
  ubicación contados y ubicables, capa opcional con la ubicación del dispositivo, área aproximada de cada ruta y «última
  actividad conocida». **No hay seguimiento continuo ni posición en tiempo real.**
- **GPS al vender en línea:** venta directa y solicitud llevan una lectura del dispositivo de quien registra (evidencia,
  nunca la ubicación del cliente). Sin GPS la venta sigue igual y se guarda la causa.
- **Ubicación de referencia del cliente:** la fija a propósito una persona autorizada de la ruta: el Cobrador o el Supervisor
  «estando en el lugar» (GPS) o el Administrador marcando el punto en el mapa. Historia completa y auditada.

## 1. Diagnóstico inicial (lo que ya existía)

- **Matriz única** `src/lib/permissions.ts`: la usan la interfaz Online (puente que además exige las capacidades del
  servidor) y la API (`saas/src/authz/cleanRules.ts`). Segunda barrera en PostgreSQL: `adex.ctx_can` (0023) y las políticas
  `clients_manage_*` (0007), que incluían al SuperAdmin en **todas** las escrituras de cartera.
- **CARTERA del SuperAdmin** (menú Online, grupo «Cartera»): Clientes, Ventas Activas, Autorizaciones, Ajustes de pago, sin
  protección por URL. La pantalla Clientes ofrecía «Nuevo cliente», «Editar», borrar y «Crear crédito ahora» sin comprobar
  permisos. Accesos indirectos: paso «Crear Venta» de «Primeros pasos» y «Ver Ventas» en la ficha de Oficina.
- **Dependencias reales encontradas:** pruebas SaaS y de CLEAN que vendían, cobraban o anulaban con el SuperAdmin; el
  escenario de la Empresa Demo (puesto «Dirección», SuperAdmin) registraba clientes y una solicitud; la anulación de gastos
  de una semana cerrada exigía `payment.approveAdjustment`. CLEAN y DEMO LOCAL siguen sin publicarse.
- **Ubicación:** solo existía la del abono (`payment_locations`, 0022) y **nadie podía leerla**. Clientes con dirección en
  texto; ventas, desembolsos y visitas sin coordenadas. Ninguna librería cartográfica.

## 2. Entrega A — SuperAdmin: CARTERA = Clientes en consulta

### Cambios
- **Matriz** (`src/lib/permissions.ts`): `CARTERA_WRITE_CAPS` (clientes, ventas, autorizaciones, pagos y la nueva
  `client.setLocation`). El SuperAdmin conserva `client.view`, `sale.viewActive`, `sale.viewHistory`, `payment.viewHistory`
  y pierde el resto; además quedan **incompatibles** para su rol (ni por delegación). `carteraClientsOnly(rol)`.
- **Interfaz:** menú (Ventas Activas, Autorizaciones y Ajustes de pago solo para el Administrador); las URL retiradas llevan
  a Clientes (`CarteraOperativa` en `CleanOnlineApp.tsx`); Clientes sin «Nuevo cliente», sin «Editar», sin borrar y con las
  funciones protegidas aunque se llamen; sin «Crear Venta/Cliente» en «Primeros pasos» ni «Ver Ventas» en Oficinas.
- **API:** sin cambios de código: la matriz única hace que cada comando responda 403 (o 404 si ni siquiera ve el registro).
- **PostgreSQL — 0028** `0028_superadmin_portfolio_read_only.sql`:
  - `clients_manage_insert/update/delete` sin `superadmin`;
  - `adex.ctx_can` (de 0023) sin `superadmin` en ventas, autorizaciones y pagos. Las funciones de crédito, cobro, visita,
    corrección y ajuste ya consultan `ctx_can`, así que rechazan al SuperAdmin aunque alguien se salte la API;
  - `sale_requests_ctx`: el SuperAdmin **conserva la lectura** de solicitudes (antes venía de `authorization.access`); escribir, no;
  - `adex.expense_correctable` (de 0013) con una sola diferencia: el SuperAdmin sigue anulando gastos de semanas cerradas
    (facultad de DINERO que conserva). Para los demás roles la regla es idéntica.
- **Demo (código conservado para la futura Demo SaaS):** el Administrador sintético no asignable registra los clientes y la
  solicitud del escenario; el SuperAdmin solo hace capital y estructura.

### Pruebas (criterios 1–13)
`superadmin-readonly.test.ts` SA-RO-001…007 (consulta, 15 escrituras directas rechazadas sin cambiar nada, barrera SQL,
DS-05 con otra membresía, Administrador y demás roles intactos, capital y gastos del SuperAdmin, aislamiento); E2E A-01…A-11.

## 3. Entrega B — Mapa del Administrador

### Ubicación en la interfaz
Grupo **Cartera** → **Mapa** (`/admin/mapa`), solo Administrador (`map.view`). El SuperAdmin no lo ve ni entra por URL.

### Datos (0029 `0029_route_map_locations.sql`)
| Tabla | Qué es | Quién escribe | Quién lee |
|---|---|---|---|
| `adex.client_locations` | Referencia del cliente: origen `gps_on_site` o `map_pin`, autor, rol, fecha; historia (vigente = última) | Administrador, Supervisor y Cobrador de la ruta (`client.setLocation`) | Esos mismos roles, por la ruta **vigente** del cliente |
| `adex.sale_locations` | Dispositivo al registrar una venta directa o una solicitud en línea; mismos estados que el abono | Quien registró esa venta (guardián AX803) | Solo el Administrador de la ruta (`map.view`) |
| `adex.payment_locations` (0022) | Dispositivo al registrar el abono | Sin cambios | **Nuevo:** solo el Administrador de la ruta (`map.view`) |

Todo es solo de añadido (sin UPDATE/DELETE/TRUNCATE). Las coordenadas **no** van a la auditoría (solo el origen). Políticas
con el patrón de 0020 (contexto evaluado una vez). El plano Owner no tiene acceso al esquema `adex`.

### API
- `GET /v1/map?routeId&workerId&from&to&kinds` (rango ≤ 93 días; por defecto los últimos 7): rutas, trabajadores,
  clientes con su referencia o `null`, actividad (ventas por fecha contable de desembolso, abonos **válidos** —sin los
  anulados ni sus espejos—, visitas sin pago) y última actividad conocida con ubicación por Cobrador/Supervisor.
- `POST /v1/clients/:id/location` (id de operación obligatorio, idempotente) y `GET /v1/clients/:id/location` (vigente e historia).
- `POST /v1/credits/direct` y `POST /v1/credit-requests` admiten `location`; se guarda bajo savepoint: un fallo de GPS o de
  esquema **nunca** tumba la venta ni la duplica. `offline` sigue rechazado en ventas (65-C1).
- `/healthz` anuncia `route-map-v1` solo con 0029 aplicada; la puerta de Vercel la exige.

### Interfaz
- **Marcadores aprobados**, uno por cliente (sin amontonar): el resultado más reciente del filtro. Detalle: cliente, ruta,
  dirección, origen de la referencia, historial del periodo con fecha y hora, tipo, trabajador, importe o motivo, y para cada
  operación con GPS la distancia del dispositivo a la referencia. La visita sin pago se rotula «Sin GPS propio».
- **Clientes sin ubicación:** contados («Sin ubicación: N»), listados y ubicables («Ubicar» → tocar el mapa → confirmar →
  «punto marcado en el mapa»). Nunca se dibujan en la oficina ni en coordenadas por defecto.
- **Capas opcionales:** ubicación del dispositivo (rotulada «no es la del cliente») y área aproximada de cada ruta (contorno de
  sus clientes; «no es un recorrido»).
- **Última actividad conocida:** «Última operación registrada con ubicación del dispositivo. No es una ubicación en tiempo real.»
- **Cobrador/Supervisor:** ficha del cliente → «Ubicación del cliente» → «Estoy en el lugar del cliente» (una lectura,
  confirmada; nada automático). Solo con conexión.
- **GPS al vender:** una lectura por venta antes de escribir nada, en el mismo cuerpo del comando (reintento idéntico).

### Cartografía y privacidad
Leaflet 1.9.4 (BSD, sin claves ni pagos) con teselas de **OpenStreetMap**. Las teselas reciben solo la cuadrícula visible y
el **origen** del sitio (`strict-origin-when-cross-origin` en las teselas; la página sigue con `no-referrer`); nunca datos de
clientes ni coordenadas exactas. Leaflet viaja solo en el paquete bajo demanda del mapa. **Límite:** la política de uso de las
teselas públicas de OSM admite uso ligero; con volumen comercial hará falta un proveedor de teselas (decisión del propietario,
sin coste contratado hoy).

### Pruebas (criterios 1–20)
`route-map.test.ts` MAP-001…009 (referencia con historia y auditoría, quién no puede, lecturas inválidas, GPS al vender sin
duplicar ni alterar importes, marcadores y abono anulado, filtros y rango, sin ubicación, última actividad, seguridad API y
SQL, volumen 318 clientes / 517 actividades en 135 ms); E2E B-01…B-17 y C-01…C-07.

## 4. Pruebas (cifras finales en el informe de cierre)

- SaaS (PostgreSQL real): tipos, unitarias y la suite completa de base de datos.
- CLEAN / motor compartido: `npm test` de la raíz.
- Navegador (Chrome real, build de producción, API local, datos sintéticos, teselas interceptadas): `tmp/r67/e2e.mjs`.

**Pruebas adaptadas a la regla nueva (marcadas «Ronda 67» / «[MODIFICADO Ronda 67]»):** las que usaban al SuperAdmin para
registrar clientes, vender, cobrar, anular, castigar o desembolsar ahora lo hacen con el Administrador o comprueban el
rechazo; LOC-010 (lectura de coordenadas por la política del mapa) y PERF-SQL-001 (la reversión de 0020 retira antes las
políticas posteriores que dependen de sus funciones).

## 5. Límites y pendientes reales

- **Conservación de coordenadas:** sigue pendiente de decisión del propietario (como en 0022).
- **Proveedor de teselas** para uso intensivo (ver §3).
- Las pruebas de staging con identidades reales (`test/auth-real/*`) siguen suponiendo un SuperAdmin escritor; no se ejecutan
  contra ADEX Online por decisión del propietario.
- La venta en línea de una empresa cuyo huso horario difiere del del dispositivo puede proponer como inicio el «hoy» del
  dispositivo (comportamiento previo de CLEAN, no de esta ronda).

## 6. Publicación

Orden obligatorio:
1. Aplicar 0028 y 0029 en staging (lo ejecuta el propietario: `cd saas; npm run staging:migrate`).
2. Desplegar `adex-online-api` en Render.
3. Comprobar que `/healthz` incluye `route-map-v1`.
4. Desplegar el frontend en Vercel (la puerta lo exige; si canceló el despliegue del push, se vuelve a desplegar el mismo commit).
5. Verificación de solo lectura (BlueLine y Owners intactos; bundle publicado).

La API nueva sobre una base sin 0028/0029 sigue funcionando: la matriz ya bloquea al SuperAdmin, no anuncia `route-map-v1`
y la ubicación de una venta, si la tabla aún no existe, se descarta bajo savepoint sin afectar la venta.
