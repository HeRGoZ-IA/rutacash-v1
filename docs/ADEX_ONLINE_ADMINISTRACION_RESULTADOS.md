# ADEX Online — Administración operativa de la empresa: resultados

| | |
|---|---|
| Fecha | 2026-10-18 · base `main` @ `8ffecff` |
| Autorización | «Entrega de administración operativa de ADEX Online» (propietario, 2026-10-18) |
| Alcance | Pantallas conectadas a los comandos existentes de la Fase 2. **Solo frontend** (`online/`): sin cambios en `saas/`, sin migraciones, sin cambios en CLEAN (`src/`) |
| Pantallas | [`People.tsx`](../online/src/screens/People.tsx) · [`RoutesAdmin.tsx`](../online/src/screens/RoutesAdmin.tsx) · [`Offices.tsx`](../online/src/screens/Offices.tsx) · [`Settings.tsx`](../online/src/screens/Settings.tsx) · apoyo [`lib/admin.ts`](../online/src/lib/admin.ts) |

## 1. Punto de partida

El backend ya tenía todos los comandos administrativos (Fase 2, `saas/src/http/companyApi.ts`) con autorización de CLEAN, RLS, auditoría e idempotencia. ADEX Online no tenía **ninguna** pantalla para usarlos. No faltaba ningún endpoint para el alcance aprobado, así que no se tocó el servidor (y la publicación no necesita redesplegar Render).

## 2. Pantallas

Visibles según las capacidades que devuelve el servidor para el contexto activo. Ocultarlas es solo comodidad: el servidor vuelve a autorizar cada comando.

| Menú | Capacidad | Qué permite | Comandos |
|---|---|---|---|
| Usuarios | `user.viewAll` | Listar y filtrar membresías. Alta por correo con rol permitido y rutas. Editar nombre y teléfono. Rutas autorizadas, directamente o desde una oficina. Desactivar y reactivar. Eliminar (solo Super Admin; el servidor lo rechaza si hay historia). Muestra las otras membresías de la misma persona y recuerda que no se suman | `GET/POST /v1/members`, `PATCH /v1/members/:id`, `…/deactivate`, `…/reactivate`, `PUT …/routes`, `PUT …/office-routes`, `POST …/delete` |
| Rutas | `route.create` o `route.edit` | Alta sin capital inicial (no hay caja de ruta), con código automático. Datos, oficina, tasa y préstamo máximo. Personas asignadas y Cobrador responsable. Responsable de capital, con motivo y confirmación (solo `capital.assignController`). Activar y desactivar. Eliminar sin historia | `GET/POST /v1/routes`, `GET/PATCH /v1/routes/:id`, `…/status`, `…/delete`, `PUT …/capital-controller` |
| Oficinas | `office.create` o `office.edit` | Alta, datos, rutas de la oficina, activar y desactivar. Eliminar: las rutas quedan «Sin oficina», nunca se borran | `GET/POST /v1/offices`, `PATCH …/:id`, `…/status`, `…/delete`, `POST /v1/offices/assign-routes` |
| Configuración | `settings.access` | Datos de contacto de la empresa (solo los campos cambiados). País, moneda, zona horaria, plan y estado solo en lectura. Categorías de gasto: alta, renombrar, activar y desactivar, eliminar sin gastos | `GET/PATCH /v1/company`, `GET/POST /v1/expense-categories`, `PATCH …/:id`, `…/delete` |

Criterios de diseño:

- **Sin contraseñas.** El alta crea la identidad en el proveedor sin credencial. La pantalla explica el primer acceso («Olvidé mi contraseña / primer acceso»).
- **El rol no se cambia** (DS-05): se crea otra membresía y se desactiva la anterior. La pantalla lo indica.
- **Confirmación en dos pasos** antes de desactivar, eliminar o cambiar el responsable de capital. Ningún éxito se muestra hasta que el servidor confirma.
- **Altas idempotentes por intención** (`useIntent`). El `X-Adex-Operation-Id` se conserva mientras el formulario no cambie, así que volver a pulsar tras una respuesta perdida repite la misma operación. Ante una respuesta perdida, el cliente consulta `/v1/operations/:id` y, si no puede, ofrece «Comprobar en el servidor».
- **Formularios resincronizados con el servidor** (`useSynced`). Las listas se releen tras cada comando y periódicamente. Un cambio hecho en otro dispositivo aparece sin caché local.
- Errores del servidor traducidos al español: último Super Admin, historia protegida, responsable de capital requerido o inválido, duplicados, campo concreto inválido…

## 3. Pruebas

### 3.1 E2E con navegador real + seguridad contra la API publicada — 65/66

`tmp/adm/e2e.mjs`, ejecución `run-ad7e3f` (registro en `tmp/adm/e2e-run4.log`).

- **Cadena UI:** Chrome → frontend nuevo (`vite preview`, bundle verificado) → API local (mismo código que la publicada) → ADEX-Staging (Supabase Auth real + PostgreSQL).
- **Dispositivos:** tres contextos de navegador aislados: Super Admin a 1366 px; Administradora/Cobradora y Cobrador a 412 px.
- **Seguridad:** contra `https://adex-online-api.onrender.com`.
- **Datos:** solo empresas sintéticas `stg-adm-<run>-a/b` y usuarios `@example.test`, borrados al terminar.

| Bloque | Verificaciones |
|---|---|
| Configuración | Datos de la empresa editados; reservados intactos; cabecera actualizada; categorías: alta, duplicado rechazado, renombrar, desactivar, eliminar |
| Oficinas | Alta, duplicado rechazado, rutas de la oficina, desactivar/reactivar con confirmación |
| Rutas | Altas con código automático, límite en unidades menores, sin capital; aviso «Sin responsable de capital»; datos editados; desactivar/reactivar; eliminación sin historia OK y con historia rechazada |
| Respuestas perdidas | 502 tras confirmar → consulta la operación y no duplica; sin red → «Comprobar» y re-pulsar no duplica (rutas y usuarios) |
| Usuarios | Altas por la pantalla de Administrador, Cobrador, Supervisor, Socio y Secretario; misma persona con dos membresías independientes; mismo rol otra vez rechazado; sin campos de contraseña; primera Administradora → primera responsable de capital; asignación directa, desde la ruta y desde la oficina |
| Responsable de capital | Cambio con motivo y confirmación (evento `CHANGE`, sin operaciones ni asientos de dinero); retirar al responsable con otro Admin asignado → rechazo comprensible, nada cambia |
| Dos dispositivos | Cambio en A visible en B al actualizar; la Administradora no ve controles sobre otro Administrador; su membresía de Administradora no ve la ruta de su membresía de Cobradora; sin desbordamiento a 412 px |
| Estados | Desactivar a Carlos lo expulsa de su propio dispositivo; reactivar; último Super Admin protegido; eliminar con historia rechazado y sin historia OK |
| Cobradora (misma persona) | Menú sin administración; acceso directo a `/app/usuarios` → «Su rol no permite esta operación» |
| API-01/02 aislamiento | Empresa B: 404 en todo lo de A (rutas, miembros, oficinas, categorías, responsable); encabezado de membresía ajena → 403 |
| API-03/04 manipulación | Cobradora con encabezados `x-adex-role/company/route-ids` falsos: todo 403/404; campos extra (`role`, `companyId`) → `UNKNOWN_FIELD`; sin rastro en BD |
| API-05/06 no acumulación | La Administradora no usa la ruta de su membresía de Cobradora, no gestiona Administradores ni responsables; control positivo: sí edita a un Cobrador |
| API-07 desactivación | `MEMBERSHIP_INACTIVE` al instante; su membresía en otra empresa sigue activa |
| API-08/09/10 Owner | Ver §3.3 |
| API-11 responsable | Rechazados: Cobrador, Admin no asignado, el mismo, otra empresa, sin motivo; 0 operaciones de capital |
| API-12 idempotencia | Mismo id en serie y 5 en paralelo → una fila; mismo id con otros datos → `OPERATION_ID_REUSED` |
| API-13 plano reservado | `countryCode`, `currencyCode`, `timezone`, `plan`, `status`, `companyId` → `UNKNOWN_FIELD` |
| API-14/15 fugas | 50 respuestas de error: solo `{error, details}`, sin SQL, trazas ni secretos; el registro de la API local no contiene contraseñas ni tokens |
| API-16 auditoría | Todas las acciones administrativas auditadas con autor |
| INT-01/02/03 | Sin dinero creado (Σ saldos = 0, 0 operaciones); Empresa Demo intacta (hash); ninguna otra empresa cambió (hash de miembros, rutas, oficinas, asignaciones, categorías y empresas) |

**Único fallo (UI-40):** tres lecturas `GET` recibieron 500 porque el DNS local no resolvió el pooler de Supabase durante un instante (`ENOTFOUND` en `api.log`). Es el corte de red local ya conocido de rondas anteriores. La pantalla mostró «Reintentar», la lectura siguiente funcionó y todas las verificaciones de esos pasos pasaron. No afectó a ninguna escritura.

Las ejecuciones 1–3 (`run-83249a`, `run-0e5899`, `run-61992d`) **no son válidas como evidencia del frontend final**. La vista previa de la ejecución 1 quedó viva en el puerto 5185 y siguió sirviendo su bundle. Sirvieron para encontrar dos defectos reales de UX, ya corregidos:

1. El aviso de alta desaparecía al cerrarse el formulario.
2. El filtro «Activos» ocultaba a la persona recién desactivada, junto con su botón «Reactivar».

La prueba ahora comprueba que se sirve el bundle recién compilado y espera la limpieza de procesos. La ejecución 2 se cortó antes de limpiar; sus usuarios de Auth se borraron después con `tmp/adm/cleanup-auth.mjs` (Auth = 0).

### 3.2 Regresión del backend reutilizado — 91/91

`npm run typecheck` (saas) OK. PostgreSQL real local:

```
run-db-tests.ts structure members-phase2 identity owner authz-matrix revocation capital-guard client
```

**91 pass / 0 fail.** Evidencia en `tmp/saas-phase01/evidence/db-tests-2026-10-18T13-26-03-467Z.log`.

### 3.3 Comprobación Owner (pendiente de la Ronda 15)

**Causa del fallo anterior.** En `tmp/f6/published2.mjs` la URL de `adex_control` estaba bien construida y la contraseña era la vigente. El `28P01` era el mensaje de Supavisor al refrescar su secreto en caché («reconnect»). Además, la prueba daba OK con cualquier error, lo que la hacía no probatoria.

**Prueba nueva.** Se usa un Owner **comercial**: una identidad sintética dada de alta en `adex_control.platform_operators` y retirada al final. No se usa el rol técnico `adex_owner`.

- **API-08.** Su token en la API publicada: `/v1/me/memberships` = `[]`. Contexto, miembros, rutas, altas, capital y empresa → `403 MEMBERSHIP_NOT_FOUND`.
- **API-09.** El plano de control no está expuesto en Render (404).
- **API-10.** Conexión real como `adex_control` (primer intento) con el contexto del operador:
  - `operator_status() = ok`;
  - `has_schema_privilege('adex','USAGE') = false`;
  - `42501` al leer `memberships`, `routes`, `offices`, `capital_accounts`, `capital_operations`, `custody_settlements`, `clients`, `sales` y `audit_log`.

**Resultado: el Owner comercial no tiene acceso operativo ni financiero.**

### 3.4 Compilación

`online`: `tsc` OK y `vite build` OK.

## 4. Estado de CLEAN y de la Empresa Demo

- **CLEAN:** sin cambios en `src/`, ni en sus pruebas, ni en `RutaCashDB` o su despliegue. El commit solo toca `online/` y este documento.
- **Empresa Demo SaaS:** hash de `adex_demo.slots` + empresas demo idéntico antes y después. No se reinició ni se usó.

## 5. Publicación

Todo lo cambiado es frontend y es compatible con la API ya publicada.

`online/vercel.json` → `deploy-gate.mjs` exige `settlements-v1`, y la API publicada ya lo declara. Por tanto, **un `push` a `main` desplegará el frontend en producción de inmediato** (además de reconstruir CLEAN y DEMO, que no cambian). Render no necesita nada.

Pasos tras la autorización del propietario:

1. `git push`.
2. Comprobar que Vercel `adex-online` queda READY con el nuevo bundle.
3. Comprobar que CLEAN/DEMO siguen en `index-C1zR2rb4.js`.

## 6. Pendientes

**Bloqueantes:** ninguno para el alcance aprobado.

**Mejoras menores:**

1. Asignar rutas a una oficina hace dos comandos (quitar y luego añadir). Si falla el segundo, la pantalla muestra lo que tiene el servidor; no hay pérdida de datos, pero no es atómico.
2. El listado de rutas no trae las personas asignadas; la ficha las lee al abrirse.
3. Mensajes de causa del rechazo de eliminación: hoy se muestra «Tiene historia» sin detallar qué referencias.
4. Quedan en ADEX-Staging las empresas sintéticas `stg-adm-*` (no hay borrado físico por diseño), igual que en rondas anteriores.
