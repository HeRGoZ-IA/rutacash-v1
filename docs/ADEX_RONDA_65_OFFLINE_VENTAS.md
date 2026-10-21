# ADEX Online · Ronda 65 · Cobrador sin conexión: clientes, solicitudes de venta y desembolsos

Fecha: 2026-10-21. Base: `147a8e4` (= origin/main al empezar).

## 1. Qué cambia para el Cobrador

Sin internet, el Cobrador ya podía registrar abonos, visitas sin pago y gastos (Ronda 62). Desde esta ronda también puede:

- **Registrar un cliente nuevo.** Usa el formulario de siempre. El cliente queda «sin sincronizar» y se puede elegir para una venta.
- **Registrar una venta.** Para el Cobrador, una venta es una **solicitud**, igual que en línea. Queda guardada en el dispositivo. El servidor la recibe **pendiente** y la oficina la aprueba en línea.
- **Entregar el dinero de una venta ya aprobada (desembolso).** Usa el efectivo que tiene en custodia. El dispositivo muestra cuánto puede entregar y no deja usar dos veces el mismo dinero.

Cada registro se muestra «Guardado solo en este dispositivo» hasta que el servidor lo confirma. Nunca se presenta como confirmado antes.

## 2. Diagnóstico inicial (lo que ya existía)

- **Cola cifrada, sincronización, idempotencia, bloqueo, avisos de 12/24 h y service worker** venían de la Ronda 62. Se extendieron sin reconstruirlos.
- **Comandos reutilizados sin cambiar sus reglas:**
  - alta de cliente `POST /v1/clients` (idempotente; unicidad del documento en PostgreSQL);
  - solicitud `POST /v1/credit-requests`;
  - desembolso de una solicitud aprobada `POST /v1/credit-requests/:id/disburse`. Pasa por `adex.credit_disburse`, la única vía que crea créditos: hace crédito, cuotas y asiento en una transacción, contra la custodia de quien entrega y sin contar el faltante arrastrado.
- **Regla vigente que condiciona el diseño:** el Cobrador **no tiene venta directa** (`sale.createDirect` es incompatible con su rol). Toda venta suya es una solicitud que aprueba **otra persona** (`SELF_APPROVAL_FORBIDDEN`). La ronda la respeta:
  - sin conexión, el Cobrador solicita;
  - solo desembolsa lo que ya está aprobado.
  - El encadenado «cliente nuevo → venta → desembolso» se completa así: cliente y solicitud sin conexión → aprobación en línea por la oficina → desembolso, también sin conexión. Cambiar esto sería una decisión del propietario (ver §6).
- **Ubicación:** la única coordenada que guarda el sistema es la del **abono** (`adex.payment_locations`, Ronda 48), que ya viaja en la sincronización de R62.
  - Los clientes solo tienen dirección en texto.
  - Ventas, desembolsos y visitas no tienen coordenadas.
  - Esta ronda no añade almacenamiento nuevo de ubicación (ver §6).

## 3. Implementación

### Servidor (migración 0027, no destructiva)

- Campo `offline: { capturedAt }` en el alta de cliente, en la solicitud y en el desembolso:
  - solo lo admite el **Cobrador** (`OFFLINE_NOT_ALLOWED`);
  - siempre con id de operación (`OPERATION_ID_REQUIRED`);
  - las reglas del comando son las mismas que en línea, evaluadas con el estado **vigente** al sincronizar.
- La hora del dispositivo se guarda como evidencia en `adex.offline_captures`. Se amplió la restricción de tipos: `client`, `credit_request`, `disbursement`. El guardián comprueba que la entidad la registró esa misma membresía en esa misma operación. La fecha contable es la de la empresa al confirmarse.
- `/healthz` anuncia `offline-sales-v1` solo con 0027 aplicada. La puerta de Vercel la exige.
- Un desembolso que ya no cabe (sin efectivo, solicitud cancelada, ruta inactiva, periodo cerrado, Cobrador bloqueado) responde 4xx **sin escribir nada** y **sin consumir el id**. El mismo registro puede entrar después, cuando la oficina resuelva la causa.

### Dispositivo (`online/src/offline/`)

- **`sales.ts`**: capturas de cliente, solicitud y desembolso.
  - Un cliente sin sincronizar tiene id `local:<operación>` y aparece en la lista de clientes marcado «(sin sincronizar)».
  - Se rechaza en el dispositivo:
    - un documento ya conocido;
    - una segunda solicitud del mismo cliente pendiente;
    - un segundo desembolso de la misma solicitud. Nunca se crea otro id para lo mismo, aunque el primero esté en revisión.
- **`custody.ts`** calcula el efectivo disponible sin conexión. Parte de la última cifra del servidor (`GET /v1/capital/custody`, saldo menos faltante arrastrado, la misma regla que `credit_disburse`) y le aplica:
  - **resta** los desembolsos y gastos propios capturados que el servidor aún no tiene. También los que están en revisión, porque ese dinero ya salió de la mano del Cobrador;
  - **suma** los abonos capturados que siguen pendientes. Un abono rechazado no suma.

  Ante la duda cuenta de menos, nunca dos veces. El servidor sigue decidiendo al sincronizar.
- **`sync.ts`**:
  - la solicitud de un cliente nuevo espera a que el servidor confirme el alta. Entonces fija el id real **una vez**, antes del primer envío, y el cuerpo ya no cambia;
  - si el alta se rechaza (por ejemplo, porque el documento ya existe), la solicitud queda **retenida** con su motivo y nunca llega huérfana al servidor.
- **En línea**, el desembolso del Cobrador va directo al servidor y el dispositivo lo recuerda, para no contar dos veces el efectivo. Si la respuesta se pierde, pasa a la cola con el **mismo id**. Lo mismo vale para el alta de cliente y la solicitud.
- **Pantallas:**
  - «Nuevo cliente» (con «Crear venta ahora»), copia de puente existente;
  - «Nueva venta» y «Desembolsos», copias de puente nuevas, con los cambios marcados.
  - «Desembolsos» muestra:
    - «Efectivo disponible para entregar», con la hora de la cifra del servidor y lo descontado o sumado después;
    - el estado de lo ya entregado.
  - «Pendientes» añade los tipos Cliente nuevo, Solicitud de venta y Desembolso. Una solicitud confirmada se explica como **recibida, no aprobada**.

## 4. Garantías financieras

| Riesgo | Cómo se impide |
|---|---|
| Doble consumo de capital | Dispositivo: disponible = cifra del servidor − lo entregado o gastado después. Servidor: `credit_disburse` bloquea la cuenta de custodia y exige saldo − faltante ≥ importe (OFS-008, también en paralelo). |
| Desembolso duplicado | Un id por intención y la idempotencia `adex.operations`. La solicitud pasa a `disbursed` en la misma transacción. Un segundo intento en el dispositivo se bloquea (OFS-006, G-08). |
| Crédito sin respaldo | El crédito solo nace en `credit_disburse` junto con su asiento. Sin fondos, 409 y nada escrito (OFS-007). |
| Confirmación falsa tras perder la conexión | Sin respuesta, el registro queda «Sincronizando» y se comprueba con el mismo id (G-08). |
| Registro financiero de lo rechazado | Un 4xx revierte la transacción entera y no consume el id. En el dispositivo queda «Requiere revisión» con su motivo, sin borrarse (OFS-009/010, G-09/G-10/G-11). |
| Cartera de la ruta | El crédito pertenece a la ruta. Quien registra la venta queda como creador, sin custodia ficticia (OFS-013). |

## 5. Pruebas

- **SaaS (PostgreSQL real):**
  - `offline-sales.test.ts`, OFS-001…014: 14/14;
  - suite completa: 410 pruebas, 409 OK, 0 fallos, 1 omitida (Supabase real sin staging);
  - tipos y unitarias: OK.
- **Navegador, Chrome automatizado** (`tmp/r65/e2e-r65.mjs`): build de producción con service worker, API real local, datos sintéticos y 390 px. Resultado: **39/39**. Cubre:
  - cliente y solicitud sin internet;
  - documento duplicado;
  - cliente sin sincronizar seleccionable;
  - segunda solicitud bloqueada;
  - desembolso de R$ 400 con R$ 1.000, con R$ 600 restantes;
  - R$ 700 bloqueado;
  - reinicio del navegador sin red;
  - sincronización encadenada con el id real;
  - respuesta perdida;
  - solicitud cancelada;
  - efectivo retirado por la oficina, resuelto con «Reintentar»;
  - cliente rechazado con solicitud retenida;
  - Cobrador bloqueado y reactivado;
  - desembolso en línea;
  - conciliación del libro limpia.
- **Regresión de la Ronda 62** (`tmp/r65/e2e-r62-regresion.mjs`, los mismos pasos): **54/54**.
- No se probó en teléfonos físicos. Ver §7.

## 6. Pendiente y límites (no son fallos de esta entrega)

- **SuperAdmin → Clientes solo lectura: PENDIENTE.** Hoy el SuperAdmin tiene alta, edición y baja de clientes por la matriz de roles compartida (`src/lib/permissions.ts`), que usan el servidor y la segunda barrera de PostgreSQL (`clients_manage_*`). Hacerlo bien exige:
  - cambiar esa matriz;
  - cambiar las tres políticas en una migración;
  - adaptar 51 altas de clientes del SuperAdmin en 14 suites de pruebas;
  - adaptar el motor de la Empresa Demo.

  Es la reestructuración amplia que la instrucción pidió no mezclar con el núcleo financiero. Se propone como ronda corta propia.
- **Venta directa del Cobrador sin conexión:** no existe porque el Cobrador no tiene venta directa (decisión vigente). Si el propietario quiere que el Cobrador venda y entregue en el acto sin aprobación previa, hay que decidir esa regla. Los límites, el segundo crédito y quién aprueba deben quedar definidos.
- **Fecha de inicio:** una solicitud capturada hoy y sincronizada otro día con fecha de inicio ya pasada se rechaza (regla vigente `INVALID_CONDITIONS`). Queda en Pendientes con el motivo.
- **Ubicación para el mapa:** no se capturan coordenadas de cliente, venta ni visita. Para el mapa hay que decidir dos cosas:
  - qué es la «ubicación estable del cliente»;
  - si se guarda la del dispositivo al vender o desembolsar.

  Se haría con el mismo patrón de `payment_locations`.
- **Recorrido no cubierto:** si en línea se pierde la respuesta del alta de cliente con «Crear venta ahora», el resultado sigue siendo el de antes: aviso de incierto, sin cola.

## 7. Validación con teléfonos (propietario y socio)

Hacerla en una empresa de prueba, **no en BlueLine**:

1. Prepara el teléfono con internet. Inicia sesión como Cobrador y abre «Desembolsos»: anota el efectivo disponible.
2. Activa el modo avión.
3. Registra un cliente nuevo con «Crear venta ahora». Debe decir «guardados en este dispositivo».
4. Entrega una venta ya aprobada por un importe menor que tu efectivo. La cifra debe bajar. Intenta otra por más de lo que queda: debe impedirlo.
5. Cierra y vuelve a abrir la aplicación sin internet. «Pendientes» debe seguir mostrándolo todo.
6. Desactiva el modo avión. Todo debe pasar a «Confirmado por el servidor».
7. En la oficina, comprueba:
   - el cliente aparece una vez;
   - la solicitud está pendiente de aprobación;
   - el crédito existe una vez;
   - el efectivo del Cobrador bajó lo entregado.

## 8. Publicación

Orden obligatorio:

1. Aplicar 0027 en staging (lo ejecuta el propietario: `cd saas; npm run staging:migrate`).
2. Desplegar `adex-online-api` en Render.
3. Comprobar que `/healthz` incluye `offline-sales-v1`.
4. Desplegar el frontend en Vercel. La puerta lo exige; si canceló el despliegue del push, se vuelve a desplegar el mismo commit.
5. Verificación de solo lectura.

La API nueva sobre una base sin 0027 sigue funcionando: no anuncia la función, y el frontend publicado no envía `offline` en estos comandos.
