# Auditoría de botones y acciones — RutaCash

## Hallazgo raíz (Editar Ruta)

El modal usa el componente `Modal` (que **no es un `<form>`**). Por tanto X y Cancelar
**no podían** "enviar" el formulario: en el código, X (`onClose`) y Cancelar solo hacían
`setModalOpen(false)` y Actualizar llamaba `handleSave` (que sí persiste con `await`).

La causa real de que "X y Cancelar parecieran guardar" es la sección **"Usuarios
asignados a esta ruta"**, que **persiste de inmediato** (`setUserRouteMembership`) al
alternar cada usuario: al cerrar con X/Cancelar, esas asignaciones ya estaban guardadas.
"Actualizar no guarda" no se reproduce en el código actual de campos generales; se
debía a la confusión con las asignaciones inmediatas (comportamiento híbrido invisible).

## Correcciones aplicadas

- `Button` ahora tiene **`type="button"` por defecto** (override explícito a `type="submit"`
  solo donde hay `<form>`: LoginPage, ChangePasswordCard). Elimina cualquier submit accidental.
- Patrón reutilizable **dirty-state**: `useDirtyForm`/`shallowDirty` + `ConfirmDiscardModal`.
- Editar Ruta / Empresa / Usuario / Cliente: X y Cancelar **no guardan**; si hay cambios
  generales sin guardar, piden confirmación ("Hay cambios sin guardar. ¿Deseas descartarlos?").
  Guardar/Actualizar/Crear **espera** la operación y **cierra solo tras el éxito**; ante error
  el modal permanece abierto con los datos.
- Asignaciones Usuario↔Ruta (en Editar Ruta): se mantienen **inmediatas** (fuente única
  `User.authorizedRouteIds`, igual que en Usuarios) con **aviso explícito** y la confirmación
  de descarte aclara que solo descarta datos generales.

## Modelo de persistencia inmediata (documentado)

| Acción | Modelo | Motivo |
|---|---|---|
| Asignar/Retirar usuario en Editar Ruta | **Inmediato** (guarda al alternar) | Fuente única `authorizedRouteIds`, sincroniza con Usuarios; con aviso y `type="button"`, deshabilitado durante guardado |
| Rutas autorizadas en Editar Usuario | **Draft** (guarda con Actualizar) | Forma parte del formulario del usuario |
| Datos generales de Ruta/Empresa/Usuario/Cliente | **Draft** (guarda con Actualizar/Crear) | Editor con confirmación de descarte |

## Matriz de controles

| Módulo | Pantalla | Control | Acción esperada | Handler real | Persistencia | Resultado |
|---|---|---|---|---|---|---|
| Rutas | Editar ruta | X / Cancelar | Cerrar (confirmar si sucio) | `tryCloseModal` | No guarda | ✅ corregido |
| Rutas | Editar ruta | Actualizar | Guardar y cerrar | `handleSave` (await) | `db.routes.update` | ✅ |
| Rutas | Editar ruta | Asignar/Retirar | Guardar de inmediato | `toggleUserRoute` | `setUserRouteMembership` | ✅ (aviso explícito) |
| Rutas | Lista | Nueva ruta | Abrir modal / bloqueada sin admin | `openCreate` | — | ✅ |
| Rutas | Lista | Eliminar | Confirmación (solo Super Admin, sin movimientos) | `requestDelete/confirmDelete` | `db.routes.delete` | ✅ |
| Plataforma | Empresa | Crear/Guardar | Persistir | `handleSave` (await) | `db.tenants` | ✅ |
| Plataforma | Empresa | X / Cancelar | Cerrar (confirmar si sucio) | `tryCloseModal` | No guarda | ✅ |
| Plataforma | Tarjeta | Entrar / Editar / Suspender-Activar | Navegar / abrir / cambiar estado | dedicados | según acción | ✅ |
| Usuarios | Crear/Editar | Actualizar/Crear | Persistir y cerrar en éxito | `handleSave` (await) | `db.users` + rutas | ✅ |
| Usuarios | Crear/Editar | X / Cancelar | Cerrar (confirmar si sucio) | `tryCloseModal` | No guarda | ✅ |
| Usuarios | Lista | Reset contraseña / Bloquear / Eliminar | Acción con confirmación/jerarquía | dedicados | según acción | ✅ |
| Clientes | Crear/Editar | Guardar/Actualizar | Persistir y cerrar en éxito | `handleSave` (await) | `db.clients` (+venta) | ✅ |
| Clientes | Crear/Editar | X / Cancelar | Cerrar (confirmar si sucio) | `tryCloseModal` | No guarda | ✅ |
| Autorizaciones | Detalle | Aprobar / Rechazar / Cerrar | Aprobar / rechazar (motivo) / cerrar | `handleApprove/handleReject` | servicios | ✅ (sin inversión) |
| Ajustes de pago | Lista/Modal | Aprobar / Rechazar / Cancelar | Aprobar / rechazar / cerrar | dedicados | servicios | ✅ |
| Corrección de pago | Modal | Corregir/Solicitar / Cancelar | Ejecutar / cerrar | `handleSubmit` / `setTarget(null)` | reversión+reemplazo | ✅ |
| Config | Empresa | Guardar | Persistir | `handleSaveTenant` (await) | `db.tenants` | ✅ |
| Config | Datos sistema | Restaurar DEMO / Restablecer CLEAN | Confirmación reforzada | modales dedicados | reset local | ✅ |
| Login | — | Ingresar (submit) / Mostrar contraseña (button) / Demo | Login / toggle / rellenar | `handleSubmit` / type=button | — | ✅ |

## Reglas técnicas verificadas

- Botones fuera de submit → `type="button"` (por defecto en `Button`; añadido en los `<button>` crudos de Login).
- Guardado asíncrono con `await`, `loading`, deshabilitado durante la operación, cierre solo en éxito, error mantiene abierto.
- Estado inmutable: se edita un **draft** (`form`) y un **snapshot original**; Cancelar descarta, Guardar persiste. No se muta el objeto Dexie.
- Modales con semántica consistente: X = cerrar/descartar; Cancelar = descartar; Guardar/Crear/Actualizar = persistir; Eliminar/Anular = destructivo confirmado.
- Autorización intacta: `can()`, `assertCan`, `assertRouteAccess`, tenant activo y rutas siguen aplicándose.

## QA manual dirigido (pendiente por navegador)

Para cada editor (Empresa, Ruta, Usuario, Cliente, y por extensión Venta/Autorización/Pago/Gasto/Transferencia):

1. Modificar un campo → pulsar **X** → confirmar descarte → reabrir → **no** guardó. ✅ esperado
2. Modificar un campo → pulsar **Cancelar** → confirmar descarte → reabrir → **no** guardó. ✅ esperado
3. Abrir y cerrar **sin** cambios → **no** debe pedir confirmación. ✅ esperado
4. Modificar → **Guardar/Actualizar** → reabrir → **sí** guardó. ✅ esperado
5. Simular error (p. ej. ruta no autorizada) → el modal **permanece abierto**, sin mensaje de éxito. ✅ esperado
6. Editar Ruta → **Asignar/Retirar** un usuario → se guarda de inmediato (aviso visible); X/Cancelar no lo revierten. ✅ esperado

Estas interacciones requieren navegador; la lógica de dirty-state y de wiring de handlers está cubierta por `npm run test:permissions`.
