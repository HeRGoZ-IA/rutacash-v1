# ADEX Online · Ronda 39 — Validación financiera multiusuario y preparación del primer piloto

| Campo | Valor |
|---|---|
| Fecha | 2026-10-19 |
| Base | `origin/main` 1018391 (sin cambios de código en esta ronda) |
| API publicada | https://adex-online-api.onrender.com · `collections-v1, settlements-v1, clean-online-v1, changes-v1` |
| Web publicada | https://adex-online.vercel.app · `index-BBRl2Vjp.js` |
| CLEAN / DEMO | `index-C1zR2rb4.js` (sin cambios) |
| Base de datos | Supabase ADEX-Staging `hyqaufsagtsucztjfjvc`, migraciones 0001–0020 |
| Estado | **Validación financiera superada. El piloto real NO está listo**: faltan los requisitos de §7 |

## 1. Método

- Arnés `tmp/r39/fin.mjs` (no versionado, `tmp/` está en `.gitignore`). En cada ejecución crea dos empresas sintéticas nuevas, `stg-r39-<run>-a` (CO/COP, America/Bogota) y `-b` (BR/BRL).
- Personas `@example.test`: 2 SuperAdmin, 2 Administradores (uno responsable de capital y otro no), 2 Cobradores, Supervisora, Secretario y Socio en A, más una SuperAdmin en B. Se borran de Auth al terminar.
- La empresa, sus membresías y sus rutas se dan de alta por SQL, igual que en la Fase 6: la API de empresa no permite crear empresas y el Owner no está desplegado (§5).
- **Todo lo financiero pasa por la API publicada en Render**, con tokens reales de Supabase Auth. Los efectos se comprueban en PostgreSQL (saldos de cuentas, créditos, pagos) además de en las respuestas.
- Navegador: Chrome sin interfaz con dos contextos aislados, Administradora a 1366 px y Cobrador a 412 px, sobre la interfaz CLEAN publicada.
- Ejecución de referencia: `run-126d99`, con **61/62 OK**. Evidencia en `tmp/r39/run-126d99/` (`run.log`, `results.json` y 7 capturas).
- Las ejecuciones anteriores sirvieron para depurar el arnés. Ninguna mostró un fallo del producto: los fallos venían de supuestos míos (la cabecera de idempotencia, la capacidad del Secretario y los selectores de la interfaz Fase 6).

## 2. Operaciones financieras (API publicada + verificación SQL)

| Id | Prueba | Resultado |
|---|---|---|
| F-01 | Depósito de 30 M y asignación de 12 M a la Administradora responsable | OK |
| F-02 | Retiro mayor que el disponible: `409 INSUFFICIENT_FUNDS`, sin movimiento | OK |
| F-03 | Entrega de base de 2 M de la bolsa al Cobrador | OK |
| F-05 | No se desembolsa una solicitud sin aprobar (`REQUEST_NOT_DISBURSABLE`) | OK |
| F-04 | Ni el Cobrador ni el Socio aprueban (403/404) | OK |
| F-04b | El Secretario sí aprueba: tiene `authorization.approve`, igual que en CLEAN | OK |
| F-06 | Confirmación: 500.000 al 20 % = 600.000 en 10 cuotas; custodia −500.000 | OK |
| F-07 | Venta directa de 300.000: se debita un solo origen por el importe exacto | OK |
| F-08 | Abono de 60.000: saldo 540.000 y custodia +60.000 | OK |
| F-09 | Abono mayor que el saldo: se aplica solo el saldo (`capped`) y el crédito queda en 0 | OK |
| F-10 | Abono a un crédito terminado: rechazado | OK |
| F-11/12 | Gasto del trabajador; su anulación restituye la custodia; una segunda anulación da `ALREADY_REVERSED` | OK |
| F-13 | Gasto de ruta pagado de la bolsa de la Administradora | OK |
| F-14/15 | Transferencia entre trabajadores y su reversión: la suma se mantiene constante | OK |
| F-16 | Administrador no responsable: `CAPITAL_AUTHORITY_REQUIRED` (v16) | OK |
| F-17 | Devolución del trabajador a la bolsa | OK |
| F-18 | Anulación autorizada de un abono: saldo y custodia vuelven exactamente a su valor | OK |
| F-19 | Corrección de 50.000 a 45.000 (reversión + reemplazo): saldo y custodia exactos | OK |
| H-01 | Cierre semanal: el Cobrador recibe 403, la Administradora cierra y no hay duplicado (`PERIOD_OVERLAP`) | OK |
| H-02 | Anular un abono de un periodo cerrado: el archivo del cierre no cambia (md5 de la fila) y la reversión se fecha hoy | OK |
| H-03 | `UPDATE` sobre `period_closures` rechazado incluso como superusuario de la base | OK |
| R-01/02/03 | Conciliación del servidor sin diferencias; ninguna caja de empresa ni bolsa negativa; ningún crédito con saldo negativo | OK |

## 3. Concurrencia e idempotencia (sobre la API publicada)

| Id | Escenario | Resultado |
|---|---|---|
| C-01 | **Dos personas, misma custodia** de 150.000: el Cobrador desembolsa 100.000 mientras la Administradora recoge 100.000 | Gana una; la otra recibe `INSUFFICIENT_FUNDS`; custodia final 50.000 |
| C-02 | **Dos SuperAdmin distintos** asignan a la vez todo el disponible (18 M) a dos administradores | Una sola asignación; disponible 0 |
| C-03 | La Administradora entrega toda su bolsa mientras el SuperAdmin la devuelve a la empresa | Una sola salida; bolsa 0 |
| C-04 | 8 confirmaciones simultáneas de la misma solicitud | 1 crédito (201 ×1, 409 ×7) |
| C-05 | 5 envíos simultáneos del mismo abono con el mismo `operationId` | 1 pago; las 5 respuestas son la misma |
| C-06 | Reintento posterior con el mismo id / mismo id con otro cuerpo | Devuelve el mismo pago / `OPERATION_ID_REUSED` |
| C-07 | Depósito repetido ×3 con el mismo `operationId` | Un solo asiento |
| C-08 | Dos anulaciones simultáneas del mismo abono (Administradora y SuperAdmin) | Una reversión; la otra recibe `ALREADY_REVERSED` |
| C-09 | Dos cobradores abonan 45.000 cada uno a la vez a un crédito de 60.000 | Se aplican 45.000 + 15.000 = 60.000; saldo 0 |
| C-10 | Dos cuadres simultáneos del mismo trabajador | Uno cerrado; el otro recibe `SETTLEMENT_STALE`; la bolsa recibe una sola vez |
| C-11 | El Cobrador intenta cerrar un cuadre | 403 |
| W-03 | Triple toque en «Registrar abono» desde la interfaz del Cobrador | Un solo pago |

Ninguna respuesta 5xx en las ejecuciones de esta ronda.

Suite local con PostgreSQL embebido: typecheck correcto, unitarias 13/13 y DB **327/327 con 1 omitida** (la de staging remoto). La primera ejecución completa marcó `credits.test.ts` como fallido al cargar (1,4 s y ningún caso ejecutado). Ese archivo pasó completo al ejecutarlo aislado y también en la segunda ejecución completa, así que se trata como un fallo de arranque bajo carga, no de lógica. La salida 1 del script se debe a un `EPERM` al borrar el directorio temporal de PostgreSQL en Windows.

## 4. Actualización entre usuarios, roles y aislamiento

### Actualización entre usuarios

| Id | Comprobación | Resultado |
|---|---|---|
| X-01 | Un abono del Cobrador cambia la huella `/v1/changes` de la Administradora; ella lo ve en su historial y la Supervisora ve el saldo nuevo | OK |
| X-02 | La huella de la empresa B no cambia con la actividad de A | OK |
| W-04 | Abono hecho en la interfaz del Cobrador: el Dashboard de la Administradora pasa de 565.122 a 569.345 **sin recargar** | En 4 s |
| W-05 | Anulación de la Administradora: «Mi recaudo hoy» del Cobrador pasa de 534.345 a 530.122 **sin recargar** | En 17 s; correcto también tras recargar |
| W-05c | El Dashboard de la Administradora descuenta la anulación sin recargar | OK |
| W-06 | Sin base financiera local en el dispositivo del Cobrador (solo `adex-server-mode`) | OK |

### Roles, aislamiento y datos ajenos

| Comprobación | Resultado |
|---|---|
| Administradora, Cobrador, Supervisora, Secretario y Socio intentan depositar o asignar capital de empresa | 403 en todos los casos; disponible sin cambio |
| El Cobrador anula un pago o registra un gasto de ruta | 403 |
| El Socio registra un cobro | 403 |
| Cobrador sin la ruta 2 | No ve sus créditos |
| SuperAdmin de B lee, anula, cobra o entrega sobre objetos de A | 404 en los 5 casos |
| Usar la membresía de otra persona | `MEMBERSHIP_NOT_FOUND` |
| Petición sin token | 401 |
| Membresía desactivada | `MEMBERSHIP_INACTIVE` |
| Recuento de empresas, operaciones de capital, pagos, créditos y gastos de las empresas ajenas, antes y después | Idéntico |
| Empresa DEMO (`tmp/r39/demo-fingerprint.mjs`, transacción de solo lectura) | md5 **6191a23952dbbc641cd40d4a5b5b3f5a** antes y después: igual al de la Ronda 33 |
| CLEAN y DEMO local | Siguen en `index-C1zR2rb4.js` |
| Auth | Al terminar quedan las 7 cuentas `demo.*` y 3 `stg-r24-*` de una ronda anterior, que no se tocaron |

### Observaciones (sin defecto financiero)

- **O-1:** un Administrador asignado a la ruta pero no responsable de su capital (Xavier) puede aprobar solicitudes. La aprobación no mueve dinero y la capacidad pertenece al rol en CLEAN. Si el negocio quiere que solo apruebe el responsable, es una decisión pendiente.
- **O-2 · W-07:** `online/vercel.json` envía `Permissions-Policy: geolocation=()`. La pantalla de cobro de CLEAN intenta leer el GPS y el navegador lo bloquea, como se ve en la consola. La API tampoco tiene campo de ubicación en los cobros, así que ADEX Online no registra el GPS de los abonos. Es una divergencia frente a CLEAN; decidir si se necesita.

## 5. Owner Online y creación de empresas

| Elemento | En el repositorio | Publicado |
|---|---|---|
| Servicio Owner (`saas/src/server/controlMain.ts`, rol `adex_control`, `/control/v1/*`) | Sí | **No.** `adex-owner-api.onrender.com` responde 404 y `render.yaml` lo marca como «PREPARADO, NO CREADO» |
| Panel `/owner`: empresas, alta, SuperAdmin, estado, facturación y pagos | Sí | El bundle `owner-DExSjxwO.js` se sirve, pero muestra «El panel Owner no está activado en este despliegue» porque falta `VITE_ADEX_CONTROL_URL` |
| Alta de empresa (`POST /control/v1/companies` → `adex_control.create_company`) | Sí | No disponible |
| Primer SuperAdmin (`POST …/superadmins`): crea el usuario de Auth **sin contraseña y sin enviar correo** | Sí | No disponible |
| Operador Owner (`saas/scripts/owner-register.ts`) | Script local, solo para ADEX-Staging | No ejecutado |
| Administradores, cobradores y rutas (`POST /v1/members`, `/v1/routes`, `/v1/offices` desde la app de la empresa) | Sí | Sí. Los miembros nuevos tienen el mismo problema de primer acceso |
| País, moneda y zona horaria | Se fijan en el alta y no se editan después. Monedas sembradas: **solo COP y BRL**; el formulario Owner ofrece MXN, PEN y USD, que fallarían | — |
| Idioma | No existe; la interfaz está en español con formato `es-CO` | — |
| Capital inicial | Depósito del SuperAdmin → asignación → entrega. Las rutas no aceptan `initialCapitalMinor > 0` | Sí |
| Créditos vivos y saldos de apertura | **No hay importación.** `start_date` no puede ser anterior a hoy, la tasa solo puede ser 10 o 20, DS-06 sigue abierta y el importador de la Fase 7 no está construido | — |

Diferencias frente a CLEAN:

- CLEAN crea la empresa y su SuperAdmin en una sola transacción local, con una contraseña inicial que se usa de inmediato, y ofrece la guía «Primeros pasos».
- ADEX separa el alta en dos pasos y no tiene paso de contraseña. La app de empresa no tiene «olvidé mi contraseña» ni página para recibir el enlace; solo `/owner` la tiene.
- La pantalla dice «SuperAdmin invitado» aunque no se envía ningún correo.

## 6. Bloqueos para crear la primera empresa del socio

1. **Entorno de datos reales.** Solo existe ADEX-Staging, que por política contiene únicamente datos sintéticos. Hace falta decidir si se autoriza ese proyecto como entorno del piloto o se crea uno de producción. Antes hay que resolver DS-13: residencia de los datos y normativa de protección de datos de Colombia.
2. **Owner sin desplegar.** Faltan el servicio en Render, `VITE_ADEX_CONTROL_URL` en Vercel, la URL de redirección en Supabase y el registro del operador. Sin esto, la empresa solo puede crearse por SQL.
3. **Primer acceso imposible para personas reales.** No hay página para establecer la contraseña en la app de empresa y no se envían correos: Supabase sin SMTP propio no llega a destinatarios reales.
4. **Recuperación sin verificar.** No se pudo comprobar si hay copias de seguridad o PITR: el token de gestión de Supabase responde 401. Tampoco se ha hecho ninguna prueba de restauración.
5. **Saldos iniciales.** No existe un procedimiento ni una herramienta para cargar créditos vivos, cuotas, base y custodia. Esto **no bloquea la etapa de observación**, pero sí la de contraste.
6. **Procedimiento de discrepancias** frente al sistema oficial: no está definido.

## 7. Propuesta de piloto paralelo (una empresa y una ruta)

### Etapa 1 · Observación

ADEX no es autoridad de nada en esta etapa.

- Se crea la empresa del socio: COP, America/Bogota. Hay que confirmar el país.
- Se crea una ruta con su nombre real y las personas reales: SuperAdmin, Administrador y Cobrador.
- Los clientes y créditos son **ficticios**. No se cargan datos personales de clientes.
- Se validan el acceso desde el teléfono del cobrador, los permisos por rol, la navegación, los tiempos (incluido el arranque en frío de Render, ~23 s) y la comprensión de las pantallas.
- Requisitos previos: los bloqueos 1 (para datos de usuarios), 2 (o un alta controlada por script hecha por el propietario) y 3.
- Salida: lista de diferencias de uso frente a la app actual. Ningún dinero real.

### Etapa 2 · Contraste

ADEX sigue sin ser autoridad.

- La app actual sigue siendo el libro oficial.
- Cualquier carga real tendrá un origen definido: una exportación del sistema actual, con el permiso del titular de los datos (DS-16).
- Pasos: diagnóstico, carga de **saldos de apertura** (no de historia, DS-06) a una fecha de corte, y conciliación diaria contra la app oficial.
- Las diferencias se registran y se corrigen solo con operaciones auditadas (anulación o corrección). Nunca editando la base.
- Requisitos previos:
  - Importador de saldos de apertura con conciliación firmada por el propietario.
  - Copias de seguridad verificadas con una restauración de prueba.
  - Procedimiento escrito de discrepancias.
  - DS-13 resuelta.
- No se habilitan dos libros autoritativos: lo que registre ADEX no tiene efecto sobre el dinero real.

### Etapa 3 · Operación controlada

- Requiere una **nueva autorización explícita** del propietario.
- Condiciones: al menos dos cierres semanales completos en contraste con conciliación «cuadra» y cero incidencias críticas (propuesta DS-12).

### Datos que habría que conocer del sistema actual

Para la etapa 2; todavía no se solicitan. Solo descripción de campos y volúmenes, no archivos.

- Clientes con créditos vivos: identificación y datos de contacto.
- Por crédito: valor prestado, tasa, total, número y valor de cuotas, frecuencia, días de cobro, fecha de inicio, cuotas pagadas y saldo pendiente.
- Calendario de cuotas pendientes y atrasos.
- Pagos previos necesarios para reconstruir la cuota en curso y el estado de mora.
- Base de la ruta, efectivo en poder del cobrador y capital en la bolsa del administrador o socio.
- Gastos y transferencias abiertos a la fecha de corte.
- Último cuadre y último cierre semanal, con sus cifras.
- Tasas usadas. ADEX solo admite 10 % y 20 %; si el socio usa otras, es un bloqueo para el contraste.

## 8. Próxima entrega mínima recomendada

**Ronda 40 · Habilitar la etapa de observación.**

1. Decisión del propietario sobre el entorno del piloto (staging autorizado o producción) y sobre DS-13.
2. Primer acceso en la app de empresa: enlace «Establecer o recuperar contraseña» y página de destino. Es un cambio pequeño que reutiliza `OnlineClient.recover()` y el patrón de `/owner`.
3. Publicación del Owner. Los pasos 2–5 de `ADEX_RONDA_20_OWNER_Y_DEMO.md` §4 los ejecuta el propietario. Corregir de paso el texto «SuperAdmin invitado» y limitar las monedas a las sembradas.
4. Verificar las copias de seguridad del proyecto y hacer una prueba de restauración.

El importador de saldos de apertura (Fase 7) va después, y solo cuando se pase a la etapa de contraste.

## 9. Limpieza pendiente (propietario)

- En ADEX-Staging quedan 12 empresas sintéticas `stg-r39-*` de esta ronda (6 ejecuciones, dos por ejecución), como en las rondas anteriores. Sus usuarios de Auth ya están borrados.
- Siguen en Auth 3 usuarios `stg-r24-*` de una ronda anterior.
