# RutaCash — Separación Plataforma / Empresa

**Entrega 6 · Septiembre 2026**

Escrito para: el equipo que mantiene RutaCash (desarrollo y producto).

---

## 1. El problema que corrige esta entrega

Hasta ahora el rol `superadmin` mezclaba dos responsabilidades que no tienen nada que
ver entre sí:

- ser **dueño de RutaCash** (crear empresas clientes, suspenderlas, cobrarles), y
- ser **la máxima autoridad dentro de una empresa cliente** (crear usuarios,
  configurar la operación, cerrar liquidaciones).

Ese usuario llevaba el `tenantId` centinela `'platform'`, que nunca correspondió a
ninguna fila real de `tenants`, y desde ahí "entraba" al panel de cualquier empresa.
Mientras solo existió una empresa el modelo se sostuvo; con varias, deja de ser
defendible: quien administra el negocio de RutaCash acaba con acceso completo a la
operación privada de todos sus clientes.

A partir de esta entrega hay **dos niveles** y no se tocan.

---

## 2. El modelo

```
NIVEL 1 · PLATAFORMA                     NIVEL 2 · EMPRESA CLIENTE
────────────────────                     ─────────────────────────
OWNER                                    SUPER ADMIN
tabla `platformUsers`                    tabla `users`, tenantId = SU empresa
sin tenantId, sin rutas                        ↓
entra por /owner/login                   ADMIN
                                               ↓
administra el SaaS:                      SUPERVISOR · SECRETARIO · SOCIO · COBRADOR
 · empresas                              entran por /login
 · estado comercial
 · rutas facturables
 · cobros de RutaCash
```

**No hay puente entre los dos niveles.** No existe impersonación, ni "modo cliente",
ni un botón para entrar como cliente. Si el dueño de RutaCash quiere usar el producto
como cliente, se crea una cuenta normal de empresa y entra por `/login`, igual que
cualquier otro. Es intencionado.

### Owner

- Vive en `platformUsers`. **No es un `UserRole`**: no aparece en ningún selector de
  roles empresariales porque no forma parte de ese tipo.
- No tiene `tenantId` ni `authorizedRouteIds`.
- No puede ser creado por un Super Admin, ni un usuario normal puede convertirse en
  uno. El primero lo crea una persona en `/owner/login` sobre una instalación virgen;
  los siguientes los crea un Owner autenticado (`createAdditionalOwner`).
- **No hay nombres cableados en el código.** Helmer y Andrés son registros reales de
  autenticación, no una condición `if` en un guard.

### Super Admin

- Máxima autoridad de **una** empresa, y nada más.
- `tenantId` obligatorio y real, siempre el de su empresa.
- Puede crear, editar, desactivar y restablecer la contraseña de cualquier perfil de
  su empresa, **incluidos otros Super Admin**.
- No accede a la plataforma, no crea empresas y no reactiva su propia empresa si el
  Owner la suspendió. Las capacidades `platform.access`, `company.create` y
  `company.suspend` están declaradas **incompatibles** con el rol: aunque alguien
  manipulara el dato, `can()` las rechaza.
- `company.edit` sí la conserva: significa "editar la configuración de MI empresa" y
  `can()` la valida contra su propio tenant como cualquier otra capacidad.

### Cambio de fondo en `can()`

El chequeo de empresa dejó de tener excepción:

```ts
// antes: if (ctx?.tenantId && user.rol !== 'superadmin' && user.tenantId !== ctx.tenantId)
if (ctx?.tenantId && user.tenantId !== ctx.tenantId) return false
```

Lo mismo en `canManageUser`. Ningún rol de `users` puede operar sobre una empresa
ajena. `authenticateUser` también dejó de exentar al Super Admin del bloqueo por
empresa suspendida o vencida.

---

## 3. Los dos portales

| Ruta | Guard | Sesión | Destino |
|---|---|---|---|
| `/owner/login` | — | `useOwnerAuth` (`rutacash-owner-auth`) | Dashboard RutaCash |
| `/owner/*` | `RequireOwner` | `useOwnerAuth` | Portal de plataforma |
| `/login` | — | `useAuth` (`rutacash-auth`) | Panel de la empresa |
| `/admin/*`, `/collector/*`, … | `RequireAuth` | `useAuth` | Operación del tenant |

El aislamiento **no es una comprobación de rol, es una separación de almacenamiento**:
`RequireAuth` solo lee `useAuth` y `RequireOwner` solo lee `useOwnerAuth`. Un Owner
autenticado sencillamente no existe en la sesión de empresa, y viceversa. Las dos
sesiones se persisten con claves distintas y cerrar una no cierra la otra.

`homePathForRole('superadmin')` pasó de `/platform` a `/admin/dashboard`. La ruta
`/platform` y la página `PlatformPage` desaparecieron.

---

## 4. Onboarding

**Antes:** `/login` detectaba una instalación sin Super Admin y mostraba una pantalla
de configuración inicial que creaba un Super Admin global.

**Ahora:**

```
1. Instalación virgen → /owner/login muestra «Configurar RutaCash»
                      → una persona crea su Owner (elige su propia contraseña)
2. Owner → Empresas → Nueva empresa
         → datos comerciales mínimos + primer Super Admin (nombre, correo, clave)
         → se entregan las credenciales al cliente
3. Super Admin → /login → configura su empresa, crea Oficinas, Rutas y su equipo
```

El alta (`createCompanyWithFirstSuperAdmin`) crea en **una sola transacción**: la
empresa, sus categorías de gasto, su ficha de control comercial y su primer Super
Admin. Y **nada más**: ni Oficinas, ni Rutas, ni otros usuarios. El Owner no organiza
la operación del cliente porque no es asunto suyo.

`/login` sobre una instalación sin ningún usuario de empresa muestra una nota breve
con un enlace al portal de plataforma, en vez de un formulario de acceso para el que
no existe ninguna cuenta.

---

## 5. Contraseñas

Se eliminó por completo el cambio obligatorio de contraseña:

- `PasswordChangeGate.tsx` **borrado**. `RequireAuth` ya no consulta
  `mustChangePassword`.
- Los usuarios nuevos nacen con `mustChangePassword: false` y su contraseña inicial es
  utilizable tal cual.
- `resetUserPassword` ya no activa el flag.
- El campo se conserva en el modelo por compatibilidad de esquema, pero **no tiene
  efecto en ningún guard**. La migración v13 lo apaga en todos los usuarios existentes.

Toda la gestión administrativa de contraseñas vive en **Usuarios**:

| Actor | Puede restablecer |
|---|---|
| Super Admin | Cualquier usuario de SU empresa, incluidos otros Super Admin |
| Admin | Solo Supervisor, Secretario, Socio y Cobrador |
| Cualquiera | La suya propia, desde Mi Perfil (voluntario, sin modal) |

La contraseña actual **nunca se muestra**: no se lee ni se devuelve en ningún punto,
solo se sobrescribe.

> **Deuda de seguridad auditada, no resuelta aquí:** las contraseñas siguen
> guardándose en texto plano en IndexedDB, en los dos niveles. Esto no es seguridad
> real frente a manipulación directa del navegador y no lo era antes de esta entrega.
> Corregirlo exige el backend; ampliar esta entrega a un rediseño criptográfico sobre
> una base local no aportaría protección real.

---

## 6. Múltiples Super Admin y `LAST_SUPERADMIN_PROTECTION`

Una empresa puede tener varios Super Admin: lo decide el cliente. Lo que no puede es
quedarse con **cero activos**, porque nadie podría recuperarla — el Owner no entra en
las empresas, solo podría crearle otro Super Admin dejando huérfanas las cuentas
anteriores.

`src/lib/superadminProtection.ts` bloquea los tres caminos que llevan al mismo
agujero, y se aplica en `UsersPage`:

- desactivar al último Super Admin activo,
- eliminarlo,
- degradarle el rol.

Con dos o más, cualquiera de las tres es legítima.

La regla vive separada de `canManageUser` a propósito: aquella responde *"¿tengo
autoridad sobre esta persona?"*; esta responde *"¿puede la empresa permitirse
perderla?"*. Son preguntas distintas y confundirlas produce agujeros.

---

## 7. Métricas: qué se factura

**Decisión comercial explícita** (`src/platform/billing.ts`):

```
billableRouteCount = rutas de la empresa con status === 'activa'
routeCount         = todas sus rutas, en cualquier estado (informativo)
```

Por qué:

- Una ruta **eliminada** no existe: no se cobra.
- Una ruta **inactiva** es capacidad que el cliente apagó deliberadamente
  (`RoutesPage` la bloquea para operaciones nuevas). Cobrarla sería indefendible.
- Contar "rutas existentes" empujaría al cliente a **borrar** rutas en vez de
  archivarlas, perdiendo su histórico. La regla no debe incentivar destruir datos.

El contador se **recalcula** contando de nuevo, nunca se incrementa. Un contador
acumulativo se desincroniza a la primera operación que falle a medias, y aquí la cifra
es la base del cobro.

Se dispara desde las operaciones de ruta del tenant:

| Operación | Evento | Efecto |
|---|---|---|
| Crear ruta (`routeService`) | `ROUTE_CREATED` | +1 facturable |
| Activar (`RoutesPage`) | `ROUTE_CREATED` | +1 facturable |
| Desactivar (`RoutesPage`) | `ROUTE_DEACTIVATED` | −1 facturable, `routeCount` intacto |
| Eliminar (`RoutesPage`) | `ROUTE_DELETED` | −1 en ambas cifras |

Es **fail-safe**: si el plano de control falla, la operación de ruta del cliente no se
revierte. La métrica comercial no puede impedir que una empresa cree una ruta.

### Primer y último ingreso

- `firstLoginAt` = primer login correcto de **cualquier** usuario del tenant. Se sella
  una sola vez y no se reescribe nunca.
- `lastLoginAt` = último login correcto de cualquier usuario del tenant.

Se eligió "la empresa" y no "el Super Admin inicial" porque lo que tiene valor
comercial es cuándo el cliente **empezó a usar el producto**, no cuándo entró una
persona concreta. No se guarda historial de accesos: el Owner necesita dos fechas, no
una bitácora de quién entra y cuándo, que además rozaría la privacidad del cliente.

---

## 8. Estado de la empresa y suspensión

Dos relojes, escritos **siempre juntos** desde `setCompanyCommercialStatus`:

| Comercial (`CompanyControlRecord.status`) | Operativo (`Tenant.status`) |
|---|---|
| `trial` | `prueba` |
| `active` | `activa` |
| `suspended` | `suspendida` |

Uno es la decisión del Owner; el otro, su efecto en la aplicación del cliente. No son
dos verdades: por eso los escribe un único punto del código.

Al suspender: **no se borra nada**. Los usuarios de la empresa dejan de poder entrar,
con un mensaje corto y sin detalles comerciales — *"Servicio suspendido. Contacte al
proveedor."* El Super Admin no puede revertirlo.

---

## 9. Privacidad del Owner

Lo que el Owner ve de una empresa está en `CompanyControlRecord` y en
`ControlEvent`, y nada más. No hay acceso a clientes, ventas, pagos de clientes
finales, cartera, caja, gastos, documentos ni cobradores.

Esto **no depende de la disciplina de quien escribe código**. Tres barreras:

1. **Tipos.** `ControlPlaneDatabase` no declara `clients`, `sales`, `payments`,
   `installments`, `cashboxMovements`, `expenses` ni `withdrawals`. No es que estén
   prohibidas: no existen como propiedad.
2. **Frontera de importación.** Ninguna pantalla de `src/pages/owner/**` importa
   `@/lib/db`. Solo `controlPlane.ts` y `localDatabases.ts` lo hacen, y ahí la
   superficie se estrecha a los tipos mínimos.
3. **Pruebas guardianas.** `OWNER-PRIVACY-001..007` leen los imports reales de
   `src/platform/**` y `src/pages/owner/**` y fallan si aparece cualquier módulo
   operativo.

Los eventos de control son estructurales y comerciales. `SALE`, `CLIENT_CREATED`,
`COLLECTION`, `EXPENSE` y el `PAYMENT` del cliente final **no pueden viajar por este
canal**, y hay una prueba que lo verifica sobre el tipo. Un cobro de RutaCash a una
empresa y un pago de un cliente a esa empresa son cosas distintas y no comparten
tabla, ruta ni vocabulario.

---

## 10. Cross-device: el límite real

> **¿Ve el Owner, desde su dispositivo, los cambios hechos desde otro dispositivo?**
>
> ## NO.

RutaCash es local-first: cada navegador tiene su propio IndexedDB y **no existe
ningún backend compartido**. `syncService` no sincroniza nada — marca registros como
`synced` dentro de la misma base local.

Consecuencia concreta y sin adornos: si un Super Admin crea tres rutas en su equipo,
el Owner **no** verá "Rutas = 3" en el suyo. Lo verá únicamente si ambos usan el mismo
navegador del mismo dispositivo.

Lo que sí está hecho, y funciona:

- El **modelo** de métricas es correcto y está probado de extremo a extremo
  (`OWNER-METRICS-001/002`): crear, activar, desactivar y eliminar rutas mueve
  `billableRouteCount` exactamente como debe.
- El acceso a datos está detrás de `SaaSControlPlane`, un repositorio **inyectable**.
  Hoy solo existe `LocalControlPlane`. Cuando haya servidor, se escribe
  `HttpControlPlane` y se cambia el valor por defecto: ni una pantalla cambia.
- `CONTROL_PLANE_IS_SHARED = false` es la fuente única de esa verdad, y el portal
  Owner **muestra el aviso en pantalla**, no en un comentario.

Lo que falta es exclusivamente el **transporte**: un backend compartido. El contrato
mínimo está en
[`CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md`](./CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md).

No se eligió proveedor (Supabase, Firebase, PostgreSQL, PocketBase…) porque esa es una
decisión arquitectónica que corresponde tomar explícitamente, no deslizarla dentro de
una entrega de separación de roles.

`CROSS-DEVICE-002` deja esta limitación **probada**: monta dos almacenamientos
independientes, crea una ruta en uno y verifica que el otro no se entera. No es un
fallo: es el límite documentado, escrito de forma que nadie pueda maquillarlo en un
informe futuro.

---

## 11. Migración v13

Aditiva y no destructiva. Crea `platformUsers`, `companyControl`, `saasPayments` y
`controlEvents`, y reordena lo heredado:

1. Cada Super Admin con el centinela `'platform'` se **copia** a `platformUsers` como
   Owner, conservando nombre, correo y contraseña. No se inventa ninguna credencial:
   se reutiliza exactamente la que esa persona ya eligió.
2. Su fila en `users` se **reubica** en una empresa real:
   - 1 empresa → se le asigna esa empresa;
   - 0 empresas → no hay nada que administrar: la fila se elimina de `users` y la
     persona sigue existiendo como Owner;
   - **>1 empresas** → se asigna a la más antigua y se deja aviso en consola. Las
     demás quedan sin Super Admin y el Owner debe crearles uno desde el portal. No se
     puede clonar la cuenta a varias empresas porque el correo es la clave de acceso y
     se duplicaría. **Limitación conocida y documentada.**
3. Se crea la ficha de control de cada empresa existente, derivando su estado comercial
   del `Tenant.status` actual y contando sus rutas reales. Sin fechas de acceso: no
   existían y no se inventan.
4. Se apaga `mustChangePassword` en todos los usuarios.

No se borra ninguna empresa, ruta, cliente, venta, pago ni liquidación.

---

## 12. Lo que NO cambió

Intacto y protegido por sus suites: Oficinas (CRUD, Sin Oficina, OfficeDetail,
Office → Route, indicadores, roles, actividad, exportaciones, barra sticky,
multi-Admin), Liquidaciones (cierre, reapertura, versionado, correcciones, snapshots)
y todo el scoping por rutas autorizadas.
