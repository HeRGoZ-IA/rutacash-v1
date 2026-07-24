# Manual de validación — Roles y permisos (RutaCash)

Guía ejecutable de pruebas. El proyecto aún no tiene infraestructura e2e; esta guía
combina una **prueba automatizada** de la matriz de permisos y un **checklist manual**
por rol. Todas las credenciales son **ficticias** (modo DEMO).

## Prueba automatizada (matriz de permisos)

```bash
npm run test:permissions
```

Debe imprimir `PRUEBA DE PERMISOS: 107 OK, 0 FALLIDAS` (exit 0). Cubre venta directa vs
solicitud, solo-lectura del socio, corrección de pagos en periodo abierto/cerrado,
restricción por rutas, jerarquía de usuarios, delegación de capacidades, aislamiento
por empresa, expulsión de usuario inactivo, redirección por rol y, tras el cierre de
brechas: **Administrador sin rutas = cero acceso (fail-closed)**, admin con 1 / varias
rutas (scoping y agregaciones), **operación completa del Supervisor**, **capacidades
incompatibles no delegables ni activables por manipulación**, y alcance de
transferencias y caja de socios (relación socio↔ruta).

## Ejecución realizada en este entorno

| Verificación | Comando | Resultado |
|---|---|---|
| Matriz de permisos (107 casos) | `npm run test:permissions` | ✅ 107 OK, 0 FALLIDAS |
| Compilación de tipos | `tsc --noEmit` | ✅ sin errores |
| Build de producción | `vite build` | ✅ correcto |

Las interacciones de navegador (login por rol, clic real en pantallas) NO se ejecutan
en este entorno headless: el checklist manual de abajo queda listo para QA humano.

## Compilación

```bash
npm run build   # tsc + vite build → debe terminar sin errores
```

## Credenciales DEMO (todas password: 123456)

| Rol | Email | App |
|-----|-------|-----|
| Super Admin | superadmin@demo.com | /platform |
| Administrador | admin@demo.com | /admin/dashboard |
| Socio | socio1@demo.com · socio2@demo.com | /socio |
| Supervisor | supervisor@demo.com | /supervisor/home |
| Cobrador | cobrador@demo.com | /collector/home |
| Secretario | secretario@demo.com | /secretario |

CLEAN: `superadmin@demo.com` (plataforma) y `admin@demo.com` (empresa inicial).

## Checklist manual

### A. Acceso por rol
- [ ] Cada rol entra a su app y es redirigido correctamente.
- [ ] Navegación directa por URL a un módulo no autorizado redirige a la home del rol
      (p. ej. socio → `/admin/users` → vuelve a `/socio`).
- [ ] Los menús coinciden con las capacidades del rol.

### B. Rutas
- [ ] Cobrador con 1 ruta: autoselección; con varias: pide selección; con 0: estado sin acceso.
- [ ] La selección de ruta persiste por usuario (otro usuario en el mismo navegador no la comparte).
- [ ] Socio/Secretario solo ven datos de sus rutas autorizadas.
- [ ] Administrador crea una ruta → queda en sus rutas autorizadas (mensaje visible en el formulario).
- [ ] Super Admin puede retirarle la ruta desde Gestión de usuarios.

### C. Usuarios
- [ ] Super Admin crea los 6 roles.
- [ ] Administrador solo ve/crea socio, supervisor, cobrador, secretario (no admin ni superadmin).
- [ ] Administrador no puede otorgar una capacidad que él no posee.
- [ ] Bloquear (inactivar) un usuario: al recargar/revalidar, su sesión se cierra.
- [ ] Cambio de contraseña propia funciona en todos los perfiles (pestaña Cuenta / Configuración).
- [ ] Restablecer contraseña respeta la jerarquía (admin no resetea a admin/superadmin).

### D. Ventas
- [ ] Supervisor/Cobrador solo generan solicitud (no hay botón de venta directa).
- [ ] Intento directo desde servicio (`createDirectSale` con actor cobrador) es rechazado.
- [ ] Secretario aprueba y puede modificar porcentaje/frecuencia/días + confirmación telefónica.
- [ ] Los cambios de condiciones quedan auditados (solicitadas vs aprobadas).
- [ ] Secretario solo ve autorizaciones de sus rutas.

### E. Pagos
- [ ] Registro normal de pago (cobrador).
- [ ] Corrección en periodo abierto (secretario): el pago original permanece; se crean
      reversión + pago corregido; saldos y caja se recalculan.
- [ ] Corrección de un pago en periodo cerrado (Ruta Norte, semana cerrada del seed):
      se genera **Solicitud de ajuste**, no corrección directa.
- [ ] Admin/Super Admin aprueba el ajuste desde `/admin/payment-adjustments` y se aplica.
- [ ] No existe eliminación física de pagos (solo estados reversed/reversal/correction).

### F. Socio
- [ ] Login funcional; experiencia propia (Resumen, Clientes, Reportes, Mi caja, Cuenta).
- [ ] Solo lectura: no hay acciones de crear/editar/pagar/transferir.
- [ ] Solo rutas autorizadas; solo su propia caja de socio.
- [ ] Exporta reportes (CSV).

### G. DEMO y CLEAN
- [ ] Reset DEMO (Configuración → reset) resiembra los 6 perfiles.
- [ ] CLEAN deja Super Admin + empresa inicial + Administrador (acceso inicial funcional).
- [ ] Migración de una base v4/v5 existente a v6 no pierde datos (usuarios, pagos, ventas, caja).

## Checklist manual del CIERRE DE BRECHAS (para QA humano)

| # | Caso | Usuario | Ruta | Acción | Resultado esperado | Estado |
|---|---|---|---|---|---|---|
| 1 | Login Super Admin | superadmin@demo.com | — | Entrar | Ve /platform; puede entrar a empresa y ver TODAS las rutas | Pendiente QA |
| 2 | Login Admin con rutas | admin@demo.com | R1–R4 | Dashboard | KPIs solo de sus rutas | Pendiente QA |
| 3 | Login Admin sin rutas | (crear admin sin rutas) | 0 | Cualquier módulo | Pantalla "No tienes rutas autorizadas" + solo cambiar contraseña | Pendiente QA |
| 4 | Login Socio | socio1@demo.com | R1,R2 | Navegar | Solo lectura, solo sus rutas | Pendiente QA |
| 5 | Login Supervisor | supervisor@demo.com | R1,R2 | Navegar | App operativa (Recaudo/Desembolsos/Gastos/Cuadre) | Pendiente QA |
| 6 | Login Cobrador | cobrador@demo.com | R1 | Navegar | App operativa; sin venta directa | Pendiente QA |
| 7 | Login Secretario | secretario@demo.com | R1,R2 | Navegar | Clientes / Autorizaciones / Corrección | Pendiente QA |
| 8 | URL no autorizada | socio | — | Ir a /admin/users | Redirige a home del rol | Pendiente QA |
| 9 | Admin consulta dashboard | admin | R1 | Ver KPIs | Solo cifras de R1 (agregado tras filtro) | Pendiente QA |
| 10 | Admin abre cliente ajeno | admin (R1) | R2 | Ver cliente de R2 | No aparece en listas; acción sobre R2 rechazada | Pendiente QA |
| 11 | Supervisor crea cliente | supervisor | R1 | Nuevo cliente | Se crea en ruta activa | Pendiente QA |
| 12 | Supervisor crea solicitud | supervisor | R1 | Nueva venta | Se envía como solicitud (no directa) | Pendiente QA |
| 13 | Supervisor intenta venta directa | supervisor | R1 | — | No hay botón; servicio rechaza createDirectSale | Pendiente QA |
| 14 | Supervisor registra pago | supervisor | R1 | Recaudo → abono | Pago registrado | Pendiente QA |
| 15 | Supervisor registra gasto | supervisor | R1 | Gastos | Gasto registrado | Pendiente QA |
| 16 | Secretario corrige pago abierto | secretario | R1 | Corrección | Reversión + reemplazo, original intacto | Pendiente QA |
| 17 | Secretario solicita ajuste cerrado | secretario | R1 (semana cerrada) | Corrección | Genera solicitud de ajuste | Pendiente QA |
| 18 | Admin aprueba ajuste autorizado | admin | R1 | Ajustes de pago | Se aplica la corrección | Pendiente QA |
| 19 | Admin intenta ajuste de ruta ajena | admin (R1) | R2 | Aprobar | Servicio rechaza (fuera de alcance) | Pendiente QA |
| 20 | Reset DEMO | superadmin | — | Reset | 6 perfiles resembrados | Pendiente QA |
| 21 | Reset CLEAN | superadmin | — | Reset | Super Admin + empresa + Admin | Pendiente QA |

Los casos 3, 10, 13, 19 (fail-closed y rechazos de servicio) están además cubiertos por
la prueba automatizada de la matriz de permisos.
