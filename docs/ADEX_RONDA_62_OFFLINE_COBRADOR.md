# ADEX Online · Ronda 62 · Modo sin conexión del Cobrador (primera versión)

Fecha: 2026-10-21. Base: `05d82ca` (= origin/main al empezar).

## 1. Criterios de cierre (fijados al inicio)

| # | Criterio | Evidencia |
|---|---|---|
| C1 | La app abre sin internet (recarga y reinicio del navegador) | E2E E-01, E-07 (service worker) |
| C2 | Consulta de la ruta guardada con la hora de los datos | E-01, E-01b, E-00c |
| C3 | Abonos, visitas sin pago y gastos propios sin internet | E-02, E-03, E-04 |
| C4 | Pendientes que sobreviven a recarga y reinicio | E-06, E-07 |
| C5 | Sincronización automática exactamente una vez | E-08, E-08b, OFF-003 |
| C6 | Respuesta perdida sin duplicar | E-09, E-23, OFF-003 |
| C7 | Conflictos conservados sin falsear saldos | E-10, E-11, OFF-002, OFF-008 |
| C8 | Exclusividad de ruta y autorización del servidor | E-12, E-13, OFF-006, OFF-007, OFF-009, OFF-010 |
| C9 | Avisos de 12 y 24 h sin borrar ni bloquear | E-14 a E-14d |
| C10 | GPS en el origen, sin bloquear | E-08e, E-15, OFF-001 |
| C11 | Estados locales y confirmados distinguibles | E-02, E-06, E-09, E-23c |
| C12 | IndexedDB no es libro financiero (cifrado, sin saldos) | E-21, SEC5-003 |
| C13 | Visitas sin pago en línea verificadas y corregidas | E-20 a E-20c, OF-001/002, OFF-008 |
| C14 | Pruebas financieras y de permisos | suite SaaS completa |
| C15 | BlueLine y las cuentas Owner intactas | `tmp/r62/snapshot-*.json` (solo lectura) |

## 2. Diagnóstico inicial

- **IndexedDB/Dexie en Online:** `dexie` estaba prohibido en el bundle (sustituto que falla al abrir una base). El único IndexedDB era la sesión (`adex-server-mode`: tokens y membresía elegida). La proyección de lectura vivía solo en memoria. Excepción de R48.1: un registro por abono «en vuelo» en `localStorage`. **No había service worker:** sin internet, la app no abría.
- **Escrituras del Cobrador:** abono `POST /v1/collections` (`PaymentGuard`, R48.1), visita `POST /v1/no-payment-visits`, gasto `POST /v1/expenses`. Todos con `X-Adex-Operation-Id` y la idempotencia genérica `withOperation` (`adex.operations`, misma transacción; un rechazo 4xx no consume el id).
- **Visitas sin pago en línea:** el servidor las registraba bien (OF-001/002). **Defectos encontrados:** (1) ninguna pantalla las mostraba, ni en CLEAN ni en Online; (2) la pantalla generaba un id nuevo en cada toque, así que reintentar tras un fallo de red podía duplicar la visita; (3) cualquier error se mostraba como «Error al guardar»; (4) el servidor admitía visitas en una ruta inactiva (los abonos no).
- **Otros defectos relevantes:** al caducar el token sin red, `freshToken()` **borraba la sesión** (sin internet, el Cobrador perdía el acceso). El servidor **topa** un abono al saldo, algo inaceptable para un abono capturado horas antes. La hora GPS se descartaba si tenía más de 15 min.
- **Exclusividad:** no existía. Un Supervisor podía cobrar en la ruta de un Cobrador activo (AX708 solo comprobaba la custodia).

## 3. Qué se implementó

### Servidor (migración 0026 · `saas/src/offline/capture.ts`)
- Los comandos no cambian. Hay un campo nuevo `offline: { capturedAt, knownBalanceMinor? }` en abono, visita y gasto. Solo lo admite el **Cobrador** (`OFFLINE_NOT_ALLOWED`); en un gasto, solo su gasto propio de trabajador.
- **El servidor decide con el estado vigente:** membresía, rol, ruta asignada, ruta operativa, crédito y periodo. Un abono sin conexión que ya no cabe en el saldo **se rechaza** (`409 OFFLINE_AMOUNT_EXCEEDS_BALANCE`). Nunca se topa ni se reescribe; el saldo se lee con el mismo orden de bloqueos que `collection_post` (`adex.offline_collection_balance`).
- **Fecha contable:** la de la empresa al confirmarse, de modo que un periodo cerrado nunca se toca. La hora del dispositivo se guarda como evidencia no confiable en `adex.offline_captures` (append-only, bajo savepoint; reloj fuera de rango → sin hora y con nota).
- **Ubicación:** con `offline`, la hora GPS se valida contra la hora de la captura, no contra la de llegada.
- **Llave del dispositivo:** `POST /v1/offline/key` (`adex.offline_key()`): 32 bytes por membresía. Solo la obtiene la misma membresía, activa y Cobrador. Sin privilegios directos sobre la tabla.
- **Visitas:** el guardián exige ruta operativa (AX301).
- **Exclusividad (nueva regla):** un Supervisor recibe `409 ROUTE_HAS_ACTIVE_COLLECTOR` al registrar abonos o visitas en una ruta con un Cobrador activo asignado. Las operaciones de oficina (Administrador/SuperAdmin, incluido cobrar a nombre del Cobrador) no cambian.
- `/healthz` anuncia `offline-collector-v1` solo con 0026 aplicada. La puerta de Vercel la exige.

### Cliente (`online/src/offline/`)
- **`vault.ts`**: IndexedDB propia `adex-offline`, **cifrada con AES-GCM**. La llave del servidor se importa como no extraíble. Contiene la copia de consulta, la cola y el contexto. En claro solo quedan el id, la identidad, la membresía, la hora de captura y el estado. El esquema solo crece: ninguna actualización borra pendientes.
- **`cache.ts`**: cada lectura de las tablas del Cobrador se guarda cifrada; **solo ante falta de conexión** se responde con la copia (un 403/404/409 nunca se tapa). Al entrar, en línea, se precargan todas las tablas necesarias.
- **`state.ts`**: estados `local`, `sending`, `confirmed`, `review` y `rejected`; avisos de 12 y 24 h con los textos aprobados; «Ya lo revisé» (deja de avisar y no borra).
- **`sync.ts`**:
  - comprueba la disponibilidad real con `GET /v1/context`, que además revalida membresía y rutas;
  - envía en orden de captura, con el mismo id y el mismo cuerpo, y consulta `/v1/operations/:id` si se pierde la respuesta;
  - un abono posterior del mismo crédito **espera** si uno anterior está en revisión;
  - una sola sincronización a la vez entre pestañas (Web Locks);
  - se dispara al volver la red, al mostrarse la pestaña y cada 15 s si hay pendientes.
- **Service worker** generado en el build. Navegación: red primero y, sin red, la copia de `index.html`. Recursos con hash: caché. Excluye el portal Owner y nunca guarda datos de la API.
- **Sesión:**
  - sin red, el Cobrador abre su ruta con el contexto guardado, que el servidor revalida al volver;
  - al cerrar sesión se borran la llave y la copia de consulta, y los **pendientes quedan cifrados**;
  - otra persona en el mismo dispositivo no puede leerlos, y el acceso solo informa cuántos hay;
  - si otra identidad entra sin que la anterior cerrara sesión, se borran las llaves y copias de la anterior;
  - si se pierde la membresía (bloqueo), se borra su copia de consulta y los pendientes se conservan.
- **Pantallas** (copias en el puente):
  - abono: «Abono guardado en este dispositivo», nunca «¡Abono registrado!»; no admite más que el saldo conocido menos lo pendiente; muestra lo pendiente del crédito;
  - visita: un id por intención;
  - gastos: los pendientes van aparte y no se suman;
  - ruta: «Visitado hoy · no pagó» y «Sin sincronizar»;
  - detalle del cliente: visitas;
  - «Pendientes» (`/collector/sync`): estado, motivo, Reintentar y Ya lo revisé;
  - indicador del encabezado y confirmación al cerrar sesión con pendientes.
- **Abono en línea sin respuesta (R48.1):** para el Cobrador pasa a la misma cola cifrada con su mismo id y se confirma solo. Antes quedaba en el panel «Abono sin confirmar» con un botón manual y en `localStorage` en claro.

## 4. Pruebas

- SaaS con PostgreSQL real: `offline-collector.test.ts` OFF-001…013 (13/13) y la suite completa (ver §6).
- Ajustes de pruebas existentes por la regla nueva de exclusividad:
  - CC5-001/008/009/011 y COL-010 usan ahora a la oficina cobrando a nombre del Cobrador, o al Supervisor en una ruta sin Cobrador;
  - los inventarios SCHEMA-005 y TEN-003, `RND-001` y SEC5-003 admiten el almacén cifrado.
- E2E en Chrome real (`tmp/r62/e2e-offline.mjs`) con el build de producción y el service worker, servidor web y API apagables, datos sintéticos locales y 390 px. Cubre:
  - recarga y reinicio sin internet;
  - abono, visita y gasto;
  - doble toque;
  - GPS denegado;
  - avisos de 12 y 24 h;
  - sincronización automática;
  - respuesta perdida;
  - conflicto de saldo;
  - dependencia;
  - bloqueo;
  - cambio de ruta;
  - cambio de sesión;
  - cifrado;
  - visita en línea;
  - abono en línea sin respuesta;
  - abono en línea normal.
- Ningún dato sintético se creó en ADEX-Staging ni en BlueLine. Las verificaciones remotas son de solo lectura.

## 5. Limitaciones reales y ampliaciones futuras

- No se promete persistencia absoluta: si el sistema o la persona borran los datos del navegador antes de sincronizar, lo pendiente se pierde. Se pide `navigator.storage.persist()` y se avisa a las 12 y 24 h.
- La oficina no ve los rechazos de sincronización: quedan en el dispositivo con su motivo. Un registro de servidor de «operaciones sin conexión no aplicadas» es una ampliación pendiente (importante en el caso de bloqueo).
- Sin internet no se adjuntan fotos de gastos (en línea tampoco hay almacenamiento de archivos). No hay recibo por WhatsApp de un abono no confirmado.
- La ubicación de las visitas no se registra: no hay autorización del propietario (la de R48 cubre abonos).
- Con «wifi sin internet», detectar la falta de conexión depende del tiempo de espera del navegador. Mientras tanto, el abono sigue el camino en línea y, si no hay respuesta, pasa a la cola.
- Fuera de alcance, como parte del objetivo futuro: clientes, créditos, desembolsos, transferencias, cuadres y operación de otros roles sin conexión.

## 6. Publicación

Orden obligatorio: aplicar 0026 en staging (propietario: `cd saas; npm run staging:migrate`) → desplegar `adex-online-api` en Render → `/healthz` con `offline-collector-v1` → frontend en Vercel (la puerta lo exige) → verificación HTTPS de solo lectura. El estado final se registra en el informe de la ronda.

### Estado final verificado (2026-10-21, solo lectura sobre HTTPS)

- ADEX-Staging: migraciones 0001–0026 (0026 aplicada por el propietario con `staging:migrate`).
- `adex-online-api` (Render, despliegue manual del propietario): `/healthz` incluye `offline-collector-v1`; `POST /v1/offline/key` sin token → 401.
- `adex-online.vercel.app`: la puerta canceló el despliegue del push (API aún sin la función) y se volvió a desplegar el mismo commit; sirve `index-ktbVB77B.js` con el modo sin conexión y `/sw.js` (JavaScript, `no-store`) sin ningún recurso del plano Owner en su lista; `/owner` responde 200.
- Pruebas finales: SaaS 380 OK / 1 omitida (`collections.test.ts` se cortó una vez en la corrida larga; 15/15 dos veces aislado); OFF-001…013 13/13; E2E `tmp/r62/e2e-offline.mjs` 54/54.
- BlueLine y las dos cuentas Owner: huellas idénticas antes y después (`tmp/r62/snapshot-antes.json` = `snapshot-final.json`).
