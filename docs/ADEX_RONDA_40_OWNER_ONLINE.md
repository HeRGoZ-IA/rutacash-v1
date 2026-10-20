# ADEX Soluciones · Ronda 40 · Plataforma Owner original en ADEX Online y primer acceso

Fecha: 2026-10-19. Base: `origin/main` 1018391 + 23abb2e (informe R39, solo documentación).

**Estado: BLOQUEADA POR ACCIÓN MANUAL.** El código, la migración y las pruebas locales están
completos (Owner y servidor 31/31, E2E local 50/50). Para publicarlo, el propietario tiene que
hacer cinco pasos (§7). Mientras no los haga, ADEX Online, CLEAN y la DEMO local siguen sirviendo
exactamente lo mismo que antes. Las cuatro barreras que lo garantizan:

- La puerta de Vercel omite el frontend hasta que la API declara `access-links-v1`.
- Render tiene el despliegue automático desactivado.
- CLEAN no cambia: `src/` no se ha tocado.
- La migración la aplica el propietario.

## 1. Qué se reutilizó

Antes había dos implementaciones del Owner:

- **CLEAN:** la original, en `src/pages/owner/*` y `src/platform/*`, sobre la base local del navegador.
- **ADEX Online:** una reescritura propia, `online/src/owner/{OwnerApp,access,kit,screens}.tsx`, con otra interfaz.

Esta ronda **retira la reescritura** y publica las **pantallas originales de CLEAN**. El mecanismo
es el mismo puente que ya usan las pantallas de empresa desde la R24: se sustituyen la sesión y
los datos, no los componentes.

| Elemento Owner original (CLEAN) | Situación en Online | Acción |
|---|---|---|
| `OwnerAuthEntry`, `OwnerLoginPage` | Reutilizados tal cual | Se conecta `useOwnerAuth` al servicio Owner (Supabase Auth + `/control/v1/me`) |
| `OwnerSetupPage` (crear el primer Owner) | Reutilizado, pero no se muestra | La instalación es el servidor y ya tiene dueño. Los Owners se crean con `owner-register` y no hay alta pública |
| `OwnerLayout` (marco, menú, salir) | Reutilizado tal cual | `CONTROL_PLANE_IS_SHARED = true`: desaparece el aviso «datos de este dispositivo» |
| `OwnerDashboardPage` | Reutilizado tal cual | `controlPlane` lee del servidor |
| `OwnerCompaniesPage` (lista y alta) | **Copia marcada** | Cambios marcados «ADEX Online:»: País, Moneda y Zona horaria, solo con los valores que el servidor admite (COP y BRL); un **enlace de primer acceso** sustituye a la contraseña inicial |
| `OwnerCompanyDetailPage` (ficha) | **Copia marcada** | Se añaden país, moneda y zona (solo lectura) y el bloque «Super Admin» con «Enlace de primer acceso» |
| `OwnerBillingPage` (cobros SaaS) | Reutilizado tal cual | Los cobros los guarda el servidor |
| `OwnerSettingsPage` | **Copia marcada** | La lista de Owners sale del servidor. «Nuevo Owner» explica el procedimiento del servidor en lugar de pedir una contraseña. No hay «Zona de pruebas», porque no existe base local |
| `companyControlService` / `controlPlane` | Puente | Mismas firmas que en CLEAN; las operaciones van a `/control/v1/*`. `ownerKpis`, `billing` y los tipos son los originales |
| `RequireOwner` | La misma regla, escrita en `owner/main.tsx` | `guardRules.ts` también contiene las reglas de empresa y arrastraría la sesión de empresa al bundle Owner |

### Separación de bundles

Los dos bundles están separados y la prueba B-03 lo comprueba. El bundle Owner (`owner-*.js` +
`shared-*.js`) no contiene la sesión de empresa, la proyección de datos ni los comandos `/v1/*`.
Para lograrlo, en el plano Owner se resuelven al original o a un sustituto dos módulos:
`lib/formatters` y `lib/expenseCategoryDefaults`. La regla está en `online/vite.config.ts`.

## 2. Seguridad y separación Owner / empresa

| Requisito | Cómo se cumple | Prueba |
|---|---|---|
| Identidad validada por el servidor | JWT de Supabase verificado en el servicio Owner. El rol Owner sale de `adex_control.platform_operators` | OWP-001, A-06 |
| Solo Owners autorizados | Un Super Admin recibe `OPERATOR_REQUIRED` y la pantalla dice «Esta cuenta no es Owner de la plataforma» | A-06, A-07 |
| Sin permisos financieros | El servicio Owner solo usa el rol `adex_control`, sin USAGE sobre `adex`. Las rutas operativas devuelven 404. En la API de empresa, el Owner recibe 403 y no tiene membresías | OWN-002, OWO-007, I-04, I-05, I-06 |
| Sin suplantación | Un Owner no puede ser Super Admin (0021). El enlace solo se emite a quien nunca ha iniciado sesión: tras el primer acceso, el Owner recibe `already_active` | OWO-002, OWO-004, A-05 |
| Revocación efectiva | `owner-register --deactivate`: la siguiente petición devuelve 403 y el portal vuelve al acceso | OWO-008, R-01, R-02 |
| Registro de operaciones sensibles | `control_events` tiene autor (`actor_identity_id`) y recoge: alta, estado, Super Admin asignado, enlace emitido, datos editados, facturación, cobros, rutas | OWO-001, OWO-005, O-13 |
| Alta solo por Owners | Todas las funciones exigen `assert_operator()` | OWO-002 |
| Sin secretos en el frontend | Solo URL y clave publicable | B-04 |

El socio no recibe privilegios de Owner. El único mecanismo es explícito: `owner-register`,
que ejecuta el propietario.

## 3. Primer acceso y recuperación

Se usan capacidades nativas del proveedor de identidad: `admin/generate_link` para emitir y
`verify` con `token_hash` para canjear. Se comprobó en el Supabase Auth de staging
(`tmp/r40/auth-probe.mjs`):

- un solo uso: al reutilizarlo responde `403 otp_expired`;
- emitir un enlace nuevo invalida el anterior;
- el correo queda confirmado;
- el inicio de sesión funciona con la contraseña elegida.

**Flujo.** El Owner crea la empresa con su primer Super Admin; el Super Admin, o un Administrador,
crea otros usuarios. En los dos casos el servidor crea la identidad sin contraseña y la membresía
propia en esa empresa. Quien da el alta recibe **una vez** el enlace `https://…/activar#t=<token>`
y se lo entrega a la persona por un canal privado. La persona fija **su** contraseña en
`/activar` (la contraseña va directamente al proveedor) y después entra por `/login`.

**Reglas del servidor:**

- El enlace solo se emite si la identidad es **exclusiva de esa empresa** (no pertenece a otra empresa ni es Owner) y **nunca ha iniciado sesión**.
- El token no se guarda en ninguna tabla ni en los registros. Las pruebas O-14 y OWO-004 lo comprueban sobre `control_events`, `audit_log` y `operations`.
- La emisión queda auditada:
  - plano Owner: `ACCESS_LINK_ISSUED`;
  - empresa: `ISSUE_ACCESS_LINK`.
- La revocación de una membresía sigue funcionando y una membresía inactiva no recibe enlace.

**Recuperación** («¿Olvidaste tu contraseña?» en `/login`). El proveedor envía el enlace a
`/activar`. Para que funcione con correos reales falta configurar el envío de correo del
proveedor (§8).

**Validez del enlace.** Caduca según la configuración del proveedor: 1 hora por defecto. Si
caduca, se genera otro desde la ficha o desde Usuarios.

## 4. Migración 0021 (aditiva)

`saas/db/migrations/0021_owner_online_access.sql`; la reversión está en
`saas/db/rollback/0021_owner_online_access.down.sql`.

- **Historial de control:** tipos nuevos y autor.
- **Disparadores:** de facturación, de cobros SaaS y de rutas. Estos últimos solo actualizan el recuento y el evento, nunca leen datos de la ruta.
- **Funciones nuevas:**
  - `company_superadmins`, `record_access_link`, `update_company_profile`, `company_locale`, `list_operators`, `record_operator_login`;
  - `adex.access_link_target` e `identity_exclusive`.
- **Arreglo:** la política de 0006 que debía sellar el acceso del Owner no podía evaluarse como `adex_control`; ahora lo hace una función del propietario.
- **Sin efecto financiero:** no toca ninguna tabla ni regla financiera (D7, D24–D26, D28–D30 y v16 sin cambios). Las cargas sin contexto no generan eventos, así que las semillas siguen siendo deterministas (MIG-004).

## 5. Pruebas

| Conjunto | Resultado |
|---|---|
| `saas` typecheck + unit | OK · 13/13 |
| Pruebas Owner + migraciones (`owner-online`, `owner-panel`, `owner`, `migrations`) | **31/31** |
| Suite SaaS completa con PostgreSQL real | 332/336 en la primera pasada. Fallaron: SCHEMA-004, por la columna nueva (corregido: justificada en el mapa), y RND-010/011, cortes de proceso por tiempos bajo carga. Al repetir esos archivos: **15/15 + 1 omitida** (solo POSIX) |
| `online` typecheck | OK |
| **E2E local** `tmp/r40/e2e-local.mjs` | **50/50** (`tmp/r40/local-103f31/`) |

El E2E local monta procesos reales con los mismos arranques que Render, el frontend compilado,
el Auth de staging y un navegador real. Comprueba:

- el Owner entra a las pantallas originales;
- alta de la empresa Brasil (BRL, America/Sao_Paulo) desde la interfaz;
- el enlace, activación en otro navegador y rechazo de su reutilización;
- el Super Admin en su panel;
- oficina, Administrador, ruta y Cobrador (alta desde la pantalla Usuarios de CLEAN, con enlace);
- capital por comandos ordinarios: aporte → Administrador → entrega al Cobrador; solo existen esas 3 operaciones;
- el Cobrador en su app;
- recuento de rutas visto desde el Owner;
- aislamiento frente a otra empresa;
- sin acceso financiero del Owner;
- revocación del Owner y de una membresía;
- sin errores de JavaScript.

Al terminar, las identidades sintéticas se borran del proveedor.

No se repitieron las pruebas de rendimiento ni las financieras de la R39: esta ronda no toca
ninguna regla financiera.

## 6. Commits

Los commits de la ronda se describen en el informe de entrega. `23abb2e` (informe R39) es solo
documentación y se publica con ellos.

## 7. Acciones manuales del propietario (en este orden)

1. **Migración 0021 en ADEX-Staging**, desde la raíz:
   `cd saas` y después `npm run staging:migrate`. Debe responder «migraciones aplicadas: 0021_owner_online_access.sql».
2. **Render, `adex-online-api`:** «Manual Deploy → Deploy latest commit». Comprobar que
   `https://adex-online-api.onrender.com/healthz` incluye `access-links-v1`.
3. **Render, crear el Web Service `adex-owner-api`** con la especificación de
   `deploy/render/render.yaml`, servicio Owner:
   - misma imagen y Dockerfile;
   - **Docker Command:** `node --import ./scripts/register-alias.mjs src/server/controlMain.ts`;
   - plan Free y Auto-Deploy desactivado;
   - variables: las del archivo privado `ADEX_PRIVADO\RENDER_OWNER_VARIABLES.txt`;
   - archivo secreto `supabase-ca.crt`;
   - **no** añadir `ADEX_API_DATABASE_URL` ni `ADEX_DEMO_DATABASE_URL`: el proceso se negaría a arrancar.

   Comprobar que `https://adex-owner-api.onrender.com/healthz` incluye `owner-clean-v1`.
   Después, borrar el archivo privado de variables.
4. **Vercel, proyecto `adex-online`:** añadir la variable de entorno de producción
   `VITE_ADEX_CONTROL_URL=https://adex-owner-api.onrender.com` y pulsar «Redeploy». La puerta
   comprueba la API y el servicio Owner antes de construir.
5. **Alta del Owner real**, en el equipo del propietario:
   `cd saas` y después `node --import ./scripts/register-alias.mjs scripts/owner-register.ts`.
   El script pide el correo, el nombre y la contraseña sin eco.

Al terminar los cinco pasos, ejecutar `node tmp/r40/e2e-published.mjs` desde la raíz. Es la
verificación publicada:

- el Owner temporal sintético se da de alta y de baja con `owner-register`;
- se crea «Empresa Prueba Brasil R40 … (sintética)» desde `/owner`;
- el primer acceso se hace en otro navegador;
- oficina, ruta, usuarios y capital por los flujos ordinarios;
- DEMO intacta (huella), CLEAN y DEMO local sirviendo `index-C1zR2rb4.js`.

La ronda pasa a **CERRADA** solo con ese resultado.

## 8. Pendiente y decisiones del propietario

- **Correo real (SMTP del proveedor de identidad).**
  - **Necesario para:** «¿Olvidaste tu contraseña?» con correos reales.
  - **Sin él:** el primer acceso funciona con enlace entregado a mano.
  - **Sin resolver:** quien ya entró y olvida la contraseña no tiene recuperación.
  - Configurarlo implica un proveedor externo, que no se contrata sin autorización.
- **URL de recuperación en Supabase:** añadir `https://adex-online.vercel.app/activar` en Auth → URL Configuration → Redirect URLs. El primer acceso por enlace no lo necesita.
- **Validez del enlace:** 1 hora por defecto en Supabase (Auth → Email OTP Expiration, máximo 24 h).
- **Restablecer la contraseña de un usuario activo:** decisión del propietario. Ni el Owner ni la empresa pueden hacerlo hoy, y es deliberado (evita la suplantación). CLEAN sí lo permitía al Super Admin.
- **Moneda de la tarifa SaaS:** la ficha muestra la tarifa con el formato de CLEAN (`$`). La moneda en que ADEX factura a cada empresa no está definida.
- **Portugués:** la interfaz sigue en español; la traducción no forma parte de esta ronda.
- **Bloqueos para una empresa real:** siguen los de la R39. La decisión de entorno (DS-13) y el SMTP indicado arriba, más:
  - copias de seguridad sin verificar;
  - sin importador de saldos iniciales;
  - sin procedimiento de discrepancias.

Superar estas pruebas sintéticas no significa que una empresa real esté lista para operar.
