# RutaCash — Backend mínimo del plano de control SaaS

**Entrega 6 · Septiembre 2026**

Escrito para: quien vaya a implementar el backend (y para quien tenga que decidir si
merece la pena antes de implementarlo).

---

## 1. Qué resuelve este documento, y qué no

RutaCash no tiene backend. Cada navegador guarda todo en su propio IndexedDB y no hay
nada compartido entre dispositivos. Eso tiene una consecuencia concreta para el portal
Owner: **no puede ver lo que ocurre en el equipo de un cliente**.

Este documento define **únicamente** el servidor mínimo que hace falta para que el
Owner administre el SaaS. **No** diseña el backend de la operación de RutaCash
(clientes, ventas, pagos, cartera, caja, liquidaciones). Eso es otro proyecto, mucho
mayor, y mezclarlo aquí sería la forma más rápida de que no se haga ninguno de los dos.

El alcance es deliberadamente pequeño: **nueve campos y ocho operaciones**.

**No se ha elegido proveedor.** Supabase, Firebase, Vercel KV, PostgreSQL, PocketBase
y compañía son decisiones arquitectónicas que deben tomarse explícitamente. Este
contrato es agnóstico: describe operaciones y datos, no tecnología.

---

## 2. La regla que no se puede romper

> Por este canal viajan datos **estructurales y comerciales** de las empresas. Nunca
> datos operativos.

Concretamente, **NO** se sincroniza por aquí: clientes, ventas, pagos de clientes
finales, cuotas, cartera, caja, gastos, transferencias, retiros, documentos,
liquidaciones ni ningún dato de cobradores.

Si alguna vez hace falta sincronizar la operación, será **otro canal, otra
autorización y otro documento**. Mezclarlos convertiría el servidor del Owner en un
espejo de los datos privados de todos los clientes.

---

## 3. Datos

### 3.1 `Company` — ficha de control

Es lo único que el Owner llega a saber de una empresa.

| Campo | Tipo | Obligatorio | Notas |
|---|---|:--:|---|
| `companyId` | string (PK) | sí | Mismo id que el tenant en el cliente |
| `nombre` | string | sí | Nombre comercial |
| `identificacion` | string | no | NIT / identificación fiscal |
| `contacto` | string | no | Persona de contacto |
| `contactoEmail` | string | no | Correo de contacto |
| `createdAt` | ISO 8601 | sí | Fecha de alta en RutaCash |
| `firstLoginAt` | ISO 8601 | no | Primer acceso de la empresa. **Inmutable una vez escrito** |
| `lastLoginAt` | ISO 8601 | no | Último acceso de cualquier usuario del tenant |
| `status` | `trial` \| `active` \| `suspended` | sí | Estado comercial |
| `routeCount` | int ≥ 0 | sí | Rutas existentes (informativo) |
| `billableRouteCount` | int ≥ 0 | sí | **Rutas facturables**: las de estado `activa` |
| `billingPlan` (`billingMode`) | `per_route` \| `fixed` | sí | Modo de cobro |
| `billingRate` | number ≥ 0 | sí | Precio por ruta facturable, o total si `fixed` |
| `nextBillingDate` | `yyyy-MM-dd` | no | Próximo cobro |
| `paymentStatus` | `pending` \| `paid` \| `overdue` | sí | Estado del último cobro |
| `updatedAt` | ISO 8601 | sí | Control de concurrencia |

> `billingPlan` es el nombre del campo en el contrato de API; en el modelo del cliente
> se llama `billingMode`. Es la misma cosa: el modo de facturación.

**`billableRouteCount` es la cifra que se cobra.** Su regla está fijada en
`src/platform/billing.ts` y explicada en
[`ARQUITECTURA_OWNER_SUPERADMIN_2026-09.md`](./ARQUITECTURA_OWNER_SUPERADMIN_2026-09.md#7-métricas-qué-se-factura):
se factura la ruta con `status === 'activa'`. El servidor **no** decide esta regla: la
recibe ya calculada, porque quien conoce el estado real de las rutas es el cliente.

### 3.2 `SaaSPayment` — cobro de RutaCash a una empresa

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string (PK) | |
| `companyId` | string (FK) | |
| `periodo` | `yyyy-MM` | Período facturado |
| `valor` | number > 0 | |
| `fechaEsperada` | `yyyy-MM-dd` | |
| `fechaPagada` | `yyyy-MM-dd` | Ausente mientras no se pague |
| `status` | `pending` \| `paid` \| `overdue` | |
| `nota` | string | Opcional |

**Esto no es la Caja del cliente.** Un cobro de RutaCash a una empresa y un pago de un
cliente final a esa empresa son conceptos distintos y no deben compartir tabla ni
endpoint.

### 3.3 `ControlEvent` — historial estructural y comercial

| Campo | Tipo |
|---|---|
| `id` | string (PK) |
| `companyId` | string (FK) |
| `type` | ver lista |
| `at` | ISO 8601 |
| `detail` | string, opcional |

Tipos permitidos, y **solo** estos:

```
COMPANY_CREATED · COMPANY_ACTIVATED · COMPANY_SUSPENDED
FIRST_LOGIN · LOGIN
ROUTE_CREATED · ROUTE_DEACTIVATED · ROUTE_DELETED
BILLING_UPDATED · PAYMENT_REGISTERED
```

El servidor debe **rechazar** cualquier otro tipo. Es la barrera que impide que un
día alguien empiece a mandar `SALE` o `CLIENT_CREATED` "porque ya que estamos".

### 3.4 `PlatformUser` — Owner

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string (PK) | |
| `nombre` | string | |
| `email` | string (único) | Normalizado en minúsculas |
| `rol` | `owner` | |
| `status` | `activo` \| `inactivo` | |
| `firstLoginAt` / `lastLoginAt` | ISO 8601 | Telemetría de acceso al portal |

**Autenticación:** la implementación actual guarda la contraseña en texto plano en la
base local, lo cual no es seguridad real y está documentado como tal. El backend es
justamente el momento de corregirlo: hash con algoritmo moderno (argon2id o bcrypt),
sesiones con expiración y rate limiting en el login. No debe portarse el esquema
actual tal cual.

---

## 4. Operaciones

Ocho, que se corresponden una a una con los métodos de `SaaSControlPlane`
(`src/platform/controlPlane.ts`). Implementarlas es todo lo que hace falta para que el
Owner funcione cross-device.

| Operación | Quién la invoca | Entrada | Salida |
|---|---|---|---|
| `createCompany` | Owner | Datos comerciales + primer Super Admin | `Company` creada |
| `getCompanies` | Owner | — | `Company[]` |
| `getCompany` | Owner | `companyId` | `Company` |
| `updateCompanyStatus` | Owner | `companyId`, `status` | `Company` |
| `recordTenantLogin` | **Cliente (tenant)** | `companyId`, `at` | — |
| `updateRouteMetrics` | **Cliente (tenant)** | `companyId`, `routeCount`, `billableRouteCount`, `event` | — |
| `getBilling` | Owner | `companyId?` | `SaaSPayment[]` |
| `registerSaaSPayment` | Owner | Datos del cobro | `SaaSPayment` |

### Notas de implementación que importan

**`createCompany` es transaccional y cruza la frontera.** Crea la ficha de control (en
el servidor) y el primer Super Admin (en el tenant). Mientras el tenant siga siendo
local, la parte de `users` se escribe en el cliente. Es el único punto donde ambos
niveles se tocan y merece un diseño explícito: lo más simple es que el servidor
devuelva la `Company` creada y el cliente escriba su `users` en la misma operación de
UI, con reintento idempotente si una de las dos partes falla.

**`recordTenantLogin` y `updateRouteMetrics` las invoca el cliente, no el Owner.** Son
las dos únicas escrituras que un tenant hace contra el plano de control, y ambas deben
ser:

- **fail-safe**: si el servidor no responde, el usuario entra igual y la empresa crea
  su ruta igual. La telemetría comercial jamás puede bloquear a un cliente. Así está
  implementado hoy (`recordTenantLogin`, `syncRouteMetrics`) y debe seguir así.
- **idempotentes**: `firstLoginAt` se escribe una sola vez, y las métricas de rutas se
  envían como valor absoluto recalculado, nunca como incremento. Reenviar la misma
  petición dos veces no puede alterar el resultado.

**Autorización — regla dura:**

- Un tenant solo puede escribir sobre **su propio** `companyId`, y solo mediante
  `recordTenantLogin` y `updateRouteMetrics`. Ninguna otra operación.
- Un tenant **nunca** puede leer la lista de empresas, ni la ficha de otra empresa, ni
  los cobros.
- Solo un Owner activo puede invocar las seis operaciones restantes.

**Conflictos.** Dos dispositivos del mismo tenant pueden enviar métricas casi a la vez.
Como se envía el valor absoluto recalculado, gana el último y el resultado converge;
basta con un `updatedAt` para descartar escrituras claramente viejas. No hace falta
resolución de conflictos elaborada para nueve campos.

---

## 5. Cómo se conecta (sin tocar la UI)

Todo el portal Owner habla con la interfaz `SaaSControlPlane`. Hoy hay una sola
implementación:

```ts
export const controlPlane: SaaSControlPlane = new LocalControlPlane(db)
export const CONTROL_PLANE_IS_SHARED = false
```

Activarlo consiste en:

1. Escribir `HttpControlPlane implements SaaSControlPlane` contra los endpoints de
   arriba.
2. Cambiar el valor por defecto de `controlPlane`.
3. Poner `CONTROL_PLANE_IS_SHARED = true` — **y no antes**: esa constante gobierna el
   aviso que el portal muestra al Owner sobre el alcance de lo que está viendo.
4. Borrar `src/platform/localDatabases.ts`, que deja de tener sentido.

**Ninguna pantalla cambia.** Esa es la razón de que la abstracción exista.

---

## 6. Qué desbloquea, en una frase

Que el smoke de métricas deje de ser "funciona en el mismo navegador" y pase a ser
"el Super Admin crea tres rutas en Barranquilla y el Owner las ve desde Bogotá". Hasta
que ese backend exista, el informe debe seguir respondiendo **NO** a la pregunta
cross-device.
