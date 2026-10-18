# ADEX Soluciones · Ronda 20 · Panel Owner y Empresa Demo única

Fecha: 2026-10-18. Base: `654f35d`. Entorno: ADEX-Staging (Supabase) + Render + Vercel.

Este documento no contiene secretos, correos personales ni contraseñas. Las credenciales
de la Demo se guardan solo en el equipo del propietario, cifradas.

## 1. Empresa Demo única (HECHO en ADEX-Staging)

### 1.1 Limpieza de las 15 Demos antiguas

- **Autorización:** el propietario autorizó expresamente la eliminación definitiva el
  2026-10-18.
- **Herramienta:** `saas/scripts/demo-purge-retired.ts`. Es una herramienta
  administrativa de un solo uso y no forma parte de la aplicación. Por defecto hace un
  ensayo y lo revierte. Solo con `--commit` confirma, y exige `--expect <n>`.
- **Alcance cerrado:** solo empresas con `is_demo`, `retired_at` informado y
  `status='suspendida'`, cuyo ciclo de vida esté `retired` o `failed` y que ningún hueco
  apunte. Una empresa no Demo nunca entra en el criterio.
- **Impedimento técnico y cómo se resolvió:**
  - El libro es inmutable: hay triggers `reject_mutation` y `no_delete` en 13 tablas y
    todas las tablas tienen `FORCE ROW LEVEL SECURITY`.
  - Las guardas se desactivan y restauran **dentro de una única transacción**, como dueño
    de las tablas (`adex_owner`). `ALTER TABLE` mantiene el bloqueo exclusivo hasta el
    final, así que ninguna otra sesión llega a ver las guardas desactivadas.
  - El borrado lo hace el administrador, que ignora RLS. El script lo exige: como dueño,
    un `DELETE` quedaba filtrado en silencio, y así se descubrió en el primer ensayo.
  - No hay migración ni cambio permanente de protecciones.
- **Comprobaciones antes de confirmar:**
  - quedan 0 filas de las empresas purgadas en las 36 tablas con `company_id`;
  - la huella de todo lo demás es idéntica: 41 tablas y conjuntos, incluidas todas las
    demás empresas, identidades, operadores y auditoría;
  - se cumplen todas las FK diferidas;
  - se restauran exactamente los 92 triggers desactivados.
- **Resultado:**
  - 15 empresas eliminadas, junto con 120 identidades sintéticas de puestos;
  - se borraron los 3 huecos de prueba `stg-*` y 15 asignaciones de personas de prueba;
  - se conserva la auditoría administrativa externa (`adex_demo.events`, solo se añade);
  - las 79 empresas no Demo no cambiaron.
- **Evidencia:** `tmp/accesos/purge-dryrun.log` y `tmp/accesos/purge-commit.log`.

### 1.2 Creación de la Demo y de las seis cuentas

- **Herramienta:** `saas/scripts/demo-accounts.ts`, con los modos `--setup`, `--finish`,
  `--verify` y `--reset <rol>`.
- **Correos:** `demo.superadmin@example.test`, `demo.admin@`, `demo.cobrador@`,
  `demo.supervisor@`, `demo.socio@` y `demo.secretario@`. Además existe el
  `demo.operador@example.test`, que administra el ciclo de vida de la Demo y no es
  miembro de ninguna empresa. `example.test` es un dominio reservado y nunca recibe
  correo. El script se niega a tocar cualquier otro correo.
- **Contraseñas:**
  - son de 20 caracteres, distintas por cuenta y generadas con `crypto.randomInt`;
  - se fijan con la API de administración de Supabase Auth en esas cuentas y nada más,
    sin enviar correos;
  - no se ha cambiado ningún ajuste de Auth.
- **Camino oficial:**
  1. Alta del operador Demo, que es el paso del administrador de la base previsto en
     0011.
  2. Asignación de las 4 personas a los puestos asignables de la API Demo publicada.
  3. Creación de **una** Demo en el hueco `principal`, con el escenario `demo-v1`
     ejecutado por el motor normal y la conciliación exigida.
  4. Socio y Secretario dados de alta por el SuperAdmin Demo con `POST /v1/members`
     (flujo normal de usuarios) en la Ruta Centro.
- **Bóveda:** `C:\Users\Usuario\ADEX_PRIVADO\demo-credenciales.dpapi`. Está cifrada con
  DPAPI de Windows, así que solo ese usuario de ese equipo puede abrirla. Se consulta con
  `VER_CREDENCIALES_DEMO.cmd` en la misma carpeta. Esa carpeta queda fuera del
  repositorio y de OneDrive, y su ACL da acceso solo al usuario y a SYSTEM.
- **Restablecer una cuenta:**
  `node --import ./scripts/register-alias.mjs scripts/demo-accounts.ts --reset <rol>`
  (desde `saas/`). Genera una contraseña nueva, la guarda en la bóveda y la fija en el
  proveedor.

### 1.3 Validación contra lo PUBLICADO

`tmp/accesos/roles.mjs`, con la web de Vercel y la API de Render: **51/51 OK**.

- Hay una única Demo activa.
- Cada cuenta inicia sesión, tiene una sola membresía con su rol y selecciona contexto.
- Los permisos coinciden con las capacidades de CLEAN:
  - «Usuarios» solo con `user.viewAll`;
  - la conciliación de capital, solo para el SuperAdmin;
  - clientes: 8 para el SuperAdmin y como máximo 4 para los roles de la Ruta Centro.
- Ningún rol puede operar con la membresía de otro: no se acumulan permisos.
- Una membresía ajena devuelve 403.
- El operador Demo no tiene membresías y la API publicada no expone `/control/v1`.
- Los 6 roles entran por la web publicada y ven el menú de su rol.
- La Empresa Demo no cambió durante la validación (huella de todas sus filas) y el
  número de empresas no Demo se mantuvo.

Menús comprobados en la web publicada:

| Rol | Menú |
|---|---|
| SuperAdmin y Administrador | Inicio, Clientes, Capital, Solicitudes, Autorizaciones, Desembolsos y créditos, Recaudos, Gastos, Cuadres, Cierres, Usuarios, Rutas, Oficinas, Configuración |
| Cobrador | Inicio, Clientes, Mi efectivo, Solicitudes, Desembolsos, Recaudos, Gastos, Mi cuadre |
| Supervisor | Inicio, Clientes, Mi efectivo, Solicitudes, Autorizaciones, Desembolsos, Recaudos, Gastos, Cuadres, Cierres |
| Socio | Inicio, Clientes, Desembolsos, Recaudos, Cierres |
| Secretario | Inicio, Clientes, Autorizaciones, Desembolsos, Recaudos |

## 2. Panel Owner SaaS (DESARROLLADO Y PROBADO; NO PUBLICADO)

### 2.1 Arquitectura

```
navegador ── /owner (owner.html, bundle propio, sesión propia «adex-owner-mode»)
              │  Supabase Auth (la contraseña solo va al proveedor)
              ▼
        SERVICIO OWNER (proceso propio: src/server/controlMain.ts)
              │  SOLO credenciales adex_control (sin USAGE sobre el esquema adex)
              ▼
        PostgreSQL · esquema adex_control (fichas de control, eventos, cobros SaaS)
```

- **Servicio aparte.** `controlStart.ts` monta solo `/control/v1/*`, `/healthz`
  (`owner-v1`) y `/readyz`. El proceso **se niega a arrancar** en tres casos:
  - si recibe `ADEX_API_DATABASE_URL` o `ADEX_DEMO_DATABASE_URL`;
  - si la base no confirma `current_user = adex_control`;
  - si ese rol tuviera USAGE sobre `adex`.

  A su vez, la API de empresas rechaza `ADEX_CONTROL_DATABASE_URL`.
- **Frontend separado.** `online/owner.html` y `online/src/owner/*` forman otro bundle
  (`owner-*.js`). No importa nada del cliente de empresas, y el bundle de empresas no
  contiene `/control/v1`; ambos se comprobaron en la compilación. La página de empresas
  sigue siendo `index-*.js`, y React y los estilos van en `shared-*.js`.
- **Sin Dexie ni almacenamiento local de negocio.** Todo se lee del servicio Owner.

### 2.2 Funciones (referencia: panel Owner local `src/pages/owner/`)

| Pantalla | Qué hace | Backend |
|---|---|---|
| Inicio de sesión | Correo y contraseña en Supabase Auth. Si la identidad no es Owner activo, rechaza y no deja sesión. | `GET /control/v1/me` (nuevo) |
| Primer acceso / olvidé mi contraseña | Pide el enlace al proveedor. Al volver con `#access_token…type=recovery`, la pantalla «Fijar contraseña» la envía solo al proveedor. | Supabase Auth |
| Panel general | Empresas por estado, rutas, rutas facturables, cobro esperado por periodo, cobros abiertos y próximos cobros | `GET /control/v1/companies`, `/payments` |
| Empresas | Lista con búsqueda y filtro, y alta de empresa (nace «En prueba») | existente |
| Detalle | Ficha de control, activar, suspender (con confirmación) o pasar a prueba, recontar rutas, facturación, cobros, invitación del primer SuperAdmin e historial | `GET /control/v1/companies/:id`, `PUT …/billing`, `POST …/payments`, `POST /control/v1/payments/:id/status` (nuevos) |
| Facturación | Todos los cobros SaaS con totales pendiente, vencido y cobrado | `GET /control/v1/payments` (nuevo) |
| Configuración | Perfil, cambio de contraseña (en el proveedor) y cierre de sesión local o global | existente |

- **Facturación SaaS.** Solo se construyó porque el backend ya la soportaba (0006): los
  permisos de `adex_control` sobre las columnas de facturación de `company_control` y
  sobre `saas_payments`. No hay migración nueva. Son cobros de ADEX a sus clientes, no
  dinero de las empresas, y la prueba OWP-005 comprueba que no tocan ninguna tabla
  financiera.
- **Lo que no tiene el panel:**
  - clientes, préstamos, capital, recaudos ni gastos;
  - impersonación;
  - alta de otros Owners: es un procedimiento del administrador, ver §3.

  El Owner tampoco se convierte en SuperAdmin: la base lo impide (OWN-004) y el alta
  rechaza correos que ya tienen membresías.
- **Empresas visibles.** El panel lista las empresas creadas por el plano de control. Las
  empresas sintéticas de rondas anteriores, creadas por scripts de prueba, y la Empresa
  Demo no tienen ficha de control y no aparecen.

### 2.3 Pruebas

- **PostgreSQL real** (`npm run test:db owner`): 18/18.
  - OWP-001…010 son nuevas: perfil, ficha sin datos operativos, facturación validada,
    cobros, sin tocar dinero, sin membresías, servicio separado (solo `/control/v1`,
    CORS), configuración cruzada rechazada, rol verificado y ciclo suspender, prueba y
    activa.
  - OWN-001…008 ya existían.
- **E2E con navegador** (`tmp/accesos/owner-e2e.mjs`): 35/35. Usa el servicio Owner
  local contra ADEX-Staging y el panel compilado, servido con las reescrituras de Vercel.
  - El Owner sintético se dio de alta con el procedimiento real (`owner-register.ts`), y
    la contraseña no se imprime.
  - El servicio Owner no arranca con credenciales de empresa ni con el rol `adex_api`.
  - Se recorrió el flujo completo de pantallas:
    - inicio de sesión, alta de empresa, facturación, cobro y marcarlo como pagado;
    - suspender y reactivar, e invitar al SuperAdmin;
    - cambio de contraseña y nuevo inicio de sesión;
    - fijar la contraseña mediante el enlace de recuperación.
  - Rechazos y aislamiento:
    - el SuperAdmin Demo es rechazado en el panel y no le queda sesión;
    - el Owner no tiene membresías y no puede usar la membresía del SuperAdmin Demo
      (API publicada);
    - el servicio Owner no tiene rutas operativas, `/v1` ni `/demo/v1`;
    - un usuario de empresa recibe `OPERATOR_REQUIRED`.
  - No hay errores de JavaScript.
  - Datos: dinero, clientes y membresías de la Demo quedaron intactos. Solo se añadió la
    empresa sintética de la prueba (`Empresa Owner R20 <run>`). Se limpiaron los Owners
    y usuarios Auth sintéticos.

- **Regresión:**
  - Suite completa del SaaS (`npm test`): 13 unitarias y 312 con PostgreSQL real. Todas
    pasan salvo 1 SKIP, el habitual.
  - E2E de la administración de empresas de la Ronda 17 (`tmp/adm/e2e.mjs`), con el
    frontend compilado en dos páginas y la API de empresas con el código nuevo: 65/66. La
    única falla, CLEAN-AUTH, exige que Auth quede vacío, y ahora contiene a propósito las
    7 cuentas Demo (comprobado: solo `demo.*@example.test`).

## 3. Alta del Owner con su correo personal (procedimiento preparado)

`saas/scripts/owner-register.ts` lo ejecuta **el propietario en su equipo**, desde `saas/`:

```
node --import ./scripts/register-alias.mjs scripts/owner-register.ts
```

1. Pide el correo y el nombre en la terminal. No pasan por chats ni por el repositorio.
2. Crea o reutiliza la identidad en Supabase Auth y registra la fila Owner. **No** crea
   membresías, y se detiene si ese correo ya es miembro de alguna empresa.
3. La contraseña se puede fijar de dos maneras:
   - escribiéndola dos veces sin eco; va solo al proveedor;
   - con `--send-link`, el proveedor envía un enlace al correo que vuelve a `/owner/`
     para fijarla. Esta opción requiere el paso 4 de §4.
4. Añade el **id** (no el correo) a `ADEX_STAGING_REAL_OWNER_IDS` en `saas/.env.staging`,
   que es local y está ignorado por Git. Así `staging:check` admite esa única identidad
   real.

Para retirar el rol Owner: `--deactivate`.

## 4. Publicación pendiente (requiere autorización expresa)

| # | Paso | Quién | Efecto |
|---|---|---|---|
| 1 | `git push` del commit de esta ronda | Claude, con autorización | Vercel vuelve a desplegar `adex-online` (la puerta `deploy-gate` ya se cumple). La página de empresas no cambia de comportamiento. `/owner` muestra «Panel Owner no activado» hasta el paso 3. CLEAN y la DEMO anterior se vuelven a desplegar sin cambios (`src/` no se toca). |
| 2 | Render: crear el Web Service `adex-owner-api` | Propietario (panel de Render) | Misma imagen y Dockerfile. **Docker Command:** `node --import ./scripts/register-alias.mjs src/server/controlMain.ts`. Variables: las de `deploy/render/render.yaml` (servicio Owner). `ADEX_CONTROL_DATABASE_URL` = URL del pooler con el usuario `adex_control.<ref>` y la contraseña `ADEX_ONLINE_CONTROL_PASSWORD` de `saas/.env.online`. `ADEX_ALLOWED_ORIGINS=https://adex-online.vercel.app`. Archivo secreto `supabase-ca.crt`. **No** añadir `ADEX_API_DATABASE_URL` ni `ADEX_DEMO_DATABASE_URL`. |
| 3 | Vercel `adex-online`: variable `VITE_ADEX_CONTROL_URL=https://<servicio-owner>.onrender.com` y volver a desplegar | Propietario o Claude con autorización | Activa `/owner`. |
| 4 | Supabase Auth → URL Configuration: añadir `https://adex-online.vercel.app/owner/` a Redirect URLs | Propietario | Solo si se quiere el alta por enlace (`--send-link`) o «olvidé mi contraseña» desde `/owner`. |
| 5 | `owner-register.ts` con su correo personal | Propietario, en su equipo | Owner activo. |
| 6 | Verificación posterior: `/healthz` del servicio Owner, inicio de sesión en `/owner` y comprobación de la API de empresas | Claude | — |

La API de empresas publicada (Render) **no necesita** volver a desplegarse: su
comportamiento no cambia. Solo se separó su configuración y ahora rechaza credenciales
del Owner.

## 5. Pendientes conocidos (fuera del alcance de esta ronda)

- **ADEX Online (empresas)** no procesa todavía el enlace de recuperación del proveedor:
  falta la pantalla «fijar contraseña» que sí tiene `/owner`. Hasta que exista, un usuario
  real de empresa invitado sin contraseña no puede completar su primer acceso solo por
  correo.
- **Correo de Supabase.** El servicio de correo por defecto envía con límites bajos y solo
  a miembros del equipo del proyecto. Para correos de clientes reales hará falta SMTP
  propio.
- **Restos sintéticos de rondas anteriores:**
  - empresas `stg-*`, `Empresa ADM *`, `Empresa R17 *` y `Empresa Owner R20 *`;
  - el Owner sintético `owner@example.test` (activo, sin cuenta Auth);
  - 7 operadores Demo inactivos.

  No impiden nada.
