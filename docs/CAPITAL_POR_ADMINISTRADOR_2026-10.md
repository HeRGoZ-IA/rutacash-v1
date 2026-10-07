# Capital por Administrador (v16) — 2026-10-07

Cadena de capital: **SuperAdmin → Administrador responsable → Ruta**. Cada ruta tiene como máximo **un** Administrador responsable de su capital y de su caja.

## Flujo anterior (≤ 2026-10-06)

```
SuperAdmin ─┐
Admin A  ───┼──► capital.manage ──► CapitalMovement / Withdrawal en CUALQUIER ruta asignada
Admin B  ───┘
Supervisor ──► cashCustody.manage ──► entregaba Base sacándola de la caja de la ruta
```

- No existía una bolsa por Administrador. El capital entraba directamente a la ruta (incluso desde el SuperAdmin) y el retiro salía sin destino.
- Todos los Admins asignados a una ruta tenían el mismo poder sobre su caja.

## Flujo nuevo

```
externo ─COMPANY_DEPOSIT─► bolsa empresa ─ADMIN_ALLOCATION─► bolsa Admin ─CapitalMovement(adminId)─► Ruta
                          ◄─ADMIN_RETURN──                   ◄─Withdrawal(adminId)───────────
                ◄─COMPANY_WITHDRAWAL─
Cambio de responsable: ROUTE_CONTROL_TRANSFER (bolsa anterior → bolsa nueva) + RouteCapitalControllerEvent
```

| Concepto | Dónde vive |
|---|---|
| Responsable de capital de la ruta | `Route.capitalControllerAdminId` (+ `capitalControllerSince`) |
| Empresa ↔ Admin, traspasos de responsabilidad | tabla `capitalLedger` (inmutable) |
| Historial de responsables | tabla `routeCapitalControllerEvents` |
| Admin → Ruta / Ruta → Admin | `CapitalMovement.adminId` / `Withdrawal.adminId` |
| Traslado Ruta → Ruta (mismo responsable) | `Transfer.adminId` |
| Foto del responsable al cerrar | `CashSettlement` / `WeeklySettlement.capitalControllerAdminIdAtClose` |

Las fórmulas están en `src/lib/capitalAllocation.ts` (puras) y el dominio en `src/services/capitalControlService.ts`.

## Definiciones e invariantes

Para un Administrador *a*:

- `disponible(a) = asignaciones − devoluciones − capital colocado + retiros recibidos`
- `enRutas(a) = Σ capital colocado en las rutas que controla`, incluidos los traspasos de responsabilidad
- `asignado(a) = disponible(a) + enRutas(a)`

**Capital colocado en una ruta** = capital − retiros ± traslados Ruta↔Ruta.

Los aportes y salidas de **socios** pertenecen a Caja socios: mueven la Base de la ruta, pero no las bolsas de los Administradores. Cobros, desembolsos y gastos son operación, no capital.

Invariantes (`verifyCapitalInvariants`, comprobados en pruebas tras cada operación):

1. `depósitos − retiros de la empresa + capital histórico pre-v16 = disponible empresa + Σ asignado(a) + Σ capital sin responsable`
2. Disponible de la empresa ≥ 0 y disponible de cada Admin ≥ 0. Se validan dentro de la transacción Dexie, así que dos operaciones simultáneas no gastan el mismo saldo.
3. El capital de una ruta solo figura en la bolsa de su responsable actual. Si la ruta no tiene responsable, figura como "sin responsable".

Si una ruta devolvió más de lo que recibió (utilidades retiradas), su capital colocado es negativo y el excedente aparece como disponible del Admin. Es lo que el libro justifica: no se inventa otra fórmula.

## Cambio de responsable

Operación atómica, solo del SuperAdmin, con motivo obligatorio. El capital colocado en la ruta **viaja con ella**: la bolsa del anterior baja X y la del nuevo sube X. No consume ni crea disponible, así que un Admin "sin capacidad" puede recibir una ruta sin quedar en negativo.

Se registran el evento (anterior, nuevo, actor, instante, capital traspasado, Base al cambio, motivo) y el asiento del libro. Los movimientos, cuadres y liquidaciones anteriores conservan su `adminId` o su foto del responsable de entonces.

## Autoridad sobre la caja de una ruta (`routeCashAuthorityError`)

| Rol | Estructural (capital, retiro, transferencia, entregar Base, gasto de ruta) | Cuadre (cerrar cuadre, recibir devolución, traspaso entre trabajadores, gasto de otro trabajador) | Corrección (anular, reabrir cuadre, cerrar/reabrir liquidación) |
|---|---|---|---|
| SuperAdmin | no (asigna al Admin) | sí | sí |
| Admin responsable | sí | sí | sí |
| Admin secundario de la ruta | no | no | no |
| Admin de otra ruta / sin rutas | no | no | no |
| Supervisor de la ruta | no (antes sí entregaba Base) | sí | no |
| Cobrador, Socio, Secretario | no | no | no |
| Cualquiera, ruta sin responsable válido | no | no | no |

La regla se valida en los servicios (no solo en React) y se suma a `can()`. Solo el SuperAdmin tiene las capacidades nuevas `capital.allocateAdmins` y `capital.assignController`; son incompatibles con los demás roles, también por delegación.

## Asignación de Administradores

- **Primer Admin:** si la ruta no tiene responsable, el primer Admin válido asignado pasa a serlo y queda persistido. Se toma el orden de selección de la operación y, si no lo hay, el usuario creado antes y luego el id.
- **Un segundo Admin no reemplaza al responsable.**
- **Retirar, desactivar o cambiar el rol del responsable cuando quedan otros Admins:** se rechaza hasta que el SuperAdmin elija otro responsable. En el editor de ruta puede hacerlo en la misma operación.
- **Retirar al último Admin:** la ruta queda "Sin responsable de capital", su capital pasa a "sin responsable" y sus operaciones de caja se bloquean. Al asignar un Admin nuevo, el capital se reconoce en su bolsa.
- Estas reglas se aplican en Rutas, Usuarios (guardar y activar/desactivar) y Oficinas, dentro de la misma transacción que el cambio de asignaciones (`withCapitalControllerGuard`).

## Migración v16

Determinista, idempotente y sin borrar ni editar datos (`planCapitalMigrationV16`):

- Ruta con un Admin válido → ese Admin es el responsable.
- Ruta con varios → el primero según la auditoría (`ASSIGN_ROUTE` / `CREATE_ROUTE.adminIds`); sin auditoría, el usuario creado antes.
- Ruta sin Admin → sin responsable.
- El capital existente de cada ruta con responsable se reconoce en su bolsa con un `ROUTE_CONTROL_TRANSFER` sin origen (ids `mig16-*`, actor `system:migration-v16`). No se crea dinero: el total sigue siendo el capital histórico.

## "Traspaso entre trabajadores"

El botón de Transferencias solo navegaba a Liquidación → Cuadre por trabajador. Se retiró.

La operación real (`transferBaseBetweenWorkers`, custodia `PERSON_TO_PERSON`) se conserva en el cuadre por trabajador como operación de nivel "cuadre".

## Pendiente conocido

`setUserRouteMembership` (`src/services/routeAssignment.ts`) no tiene llamadores. Si alguien vuelve a usarlo, debe envolverse en `withCapitalControllerGuard`.

La sincronización remota de estas tablas sigue el mismo pendiente histórico que el resto. Los registros ya llevan id estable, instante y `syncStatus: 'pending'`.
