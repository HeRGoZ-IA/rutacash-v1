# Respuesta de Claude Code — sesión del 2026-10-24 (cierre de R74)

Este informe responde al encargo anterior: terminar la publicación de R74 (Base por Ruta), activarla en BlueLine, actualizar documentación y responder al propietario. Cubre solo lo hecho en esta sesión. Los usuarios reales aparecen por su rol.

## 1. Verificación inicial

| Punto | Resultado |
|---|---|
| Git | `main` = `r74-route-base` = `origin/main` = `8d37c05`; árbol limpio |
| Migraciones | 0032–0037 ya aplicadas en ADEX-Staging (15:53 UTC), con checksums iguales a los del repositorio. **No se reaplicó nada** |
| Respaldo | `adex-20261024T1551`, tomado justo antes de migrar. Restaurado en base aislada: 82 tablas y 2.233 filas idénticas. Fotos de solo lectura posteriores: sin movimientos después del respaldo |
| Render | `adex-online-api` y `adex-owner-api` live en `8d37c05`, con todas las funciones nuevas en `/healthz` |
| Vercel | El build de `8d37c05` estaba **cancelado por la puerta** (la API no anunciaba aún sus funciones); se servía la web de R73 |
| Procesos de la sesión anterior | No se detuvo ninguno por lista de PID antigua |

## 2. Publicación de la web

Se redesplegó en Vercel el build cancelado (mismo commit). La puerta lo dejó pasar y los tres servicios quedaron en `8d37c05`.

## 3. Regresión completa sobre `8d37c05`

| Suite | Resultado |
|---|---|
| SaaS PostgreSQL | 585 pruebas: 584 ✔, 0 ✖, 1 omitida (igual que la línea base) |
| SaaS unidad | 31/31 |
| CLEAN | Todas en verde. Una prueba (WORKER-XFER-017) falló una vez al correr en paralelo con la suite de PostgreSQL; aislada, 3/3 en verde |
| Tipos (SaaS, Online, CLEAN) | Sin errores |
| E2E de navegador, 3 partes | 83/83, 41/41, 25/25 (dos intentos previos se cortaron porque la base local murió al lanzar otros comandos en paralelo; repetidos sin interferencia) |

## 4. Activación de Base por Ruta en BlueLine

**Situación previa (solo lectura):** cuenta de la empresa R$ 32.995; bolsa del Administrador responsable R$ 123; efectivo del Cobrador R$ 6.959; cartera R$ 37.944,99.

**Decisiones del propietario:**
- La bolsa del Administrador responsable corresponde a Aguas Lindas.
- Los R$ 32.995 de la empresa: primero dijo asignarlos a la Base de Aguas Lindas; luego lo corrigió: **retirarlos** de la empresa y volver a aportarlos después, ya con el sistema nuevo.

**Ejecución:** la hicieron los propios usuarios desde sus sesiones, siguiendo un procedimiento paso a paso que se les entregó. Claude Code no ejecutó operaciones en nombre de nadie.

1. SuperAdmin: retiro de R$ 32.995 de la empresa.
2. SuperAdmin: modelo «Migrando» y luego «Base por Ruta» (17:16 UTC), con la referencia del respaldo.
3. Administrador responsable: una inyección de R$ 123 por error, que él mismo revirtió (la autocorrección de 0037 funcionó en producción).
4. Administrador responsable: reparto de los R$ 123 a Aguas Lindas.

**Resultado verificado (solo lectura):** Base de Aguas Lindas R$ 123; efectivo del Cobrador R$ 6.959; efectivo total R$ 7.082; cartera, ingresos, gastos, ventas, pagos, cuotas y clientes sin cambios; libro sin diferencias, sin saldos negativos ni asientos desbalanceados.

**No ejecutado:** la conciliación de 26 comprobaciones de la API, porque exige la sesión del SuperAdmin.

**El propietario decidió no inyectar capital** hasta verificar todo personalmente.

## 5. Ajustes pedidos por el propietario tras la activación (publicados)

| Commit | Cambio |
|---|---|
| `760722b` | Caja principal, Transferencias, Notificaciones y Diferencias a todo el ancho. Tarjeta de cada ruta con tres cifras separadas (Base, Base del trabajador, Cartera activa). «Custodias» → «Base del trabajador». Bloque «Saldo sin asignar» solo si queda saldo del modelo anterior |
| `46ece56` | La tarjeta de la ruta dice «Base disponible», como la Caja principal |
| `5a15ac5` | Auditoría de nombres de toda la interfaz (`docs/ADEX_AUDITORIA_NOMBRES_UI.md`): sinónimos, homónimos y 11 rótulos que mostraban una cifra distinta de la que nombraban |
| `9ca7dc4` | Normalización aplicada según las decisiones del propietario (abajo) |

**Vocabulario decidido por el propietario:**
- **Base disponible:** dinero de la ruta.
- **Base del trabajador:** dinero de un Cobrador o Supervisor, visto por el Administrador. El trabajador lo ve como **Mi efectivo**.
- **Recaudo:** recibir dinero por una cuota (pago completo, abono o liquidación). Reemplaza a «Cobros», «Cobranza», «Pagos recibidos»…
- **Venta:** desembolsar un crédito. Desaparecen «Crédito» y «Préstamo» como nombres.
- **Cartera:** siempre las dos cifras: **Capital colocado** (sin interés) y **Cartera activa** (con interés).

Se corrigieron los rótulos del Cuadre del trabajador, la Liquidación semanal, la Oficina (cuyo «Total controlado» ahora incluye la Base disponible), Caja principal, Consultas y mensajes. **Efecto visible:** los CSV de Liquidación y de cierres tienen encabezados nuevos.

**Pruebas de los ajustes:** CLEAN en verde, tipos sin errores, E2E 86/86, 41/41 y 25/25 (con pruebas nuevas de textos, ancho y de que la tarjeta de Rutas coincide con PostgreSQL). Se comprobó que la web servida corresponde a cada commit. La API no cambió.

**No se cambió:** textos que solo ven empresas en el modelo antiguo de bolsas, nombres de los tipos de gasto (sin decisión) y nombres internos del código.

## 6. Documentación actualizada

- `docs/ADEX_RONDA_74_INTERVENCION_INTEGRAL.md` §16: estado, publicación, respaldo, regresión, decisiones, activación, pendientes y ajustes.
- `docs/REGISTRO_MAESTRO_EVOLUCION_ADEX.md`: migraciones 0032–0037 aplicadas, despliegue, estado y pendientes.
- `docs/ADEX_AUDITORIA_NOMBRES_UI.md`: auditoría, decisiones y lo aplicado.

**Estado de Git al cerrar:** `main` = `origin/main` = `9ca7dc4`. Solo quedan sin commit este informe y dos filas corregidas del Registro Maestro.

## 7. Qué quedó probado y qué no

| Probado | No probado |
|---|---|
| Toda la lógica y las pantallas con datos sintéticos (suites y navegador) | La revisión visual del propietario con los datos reales tras la normalización |
| Migraciones, respaldo y restauración | La conciliación de 26 comprobaciones sobre BlueLine (sesión del SuperAdmin) |
| Saldos e invariantes de BlueLine antes y después de activar (solo lectura) | Operación real con Base por Ruta: inyección, entregas a trabajadores, cuadres y cierres |
| La web servida coincide con el último commit | — |

## 8. Pendientes que deja esta sesión

| Pendiente | Responsable |
|---|---|
| Verificación personal del propietario en BlueLine | Propietario |
| Inyección de capital en la Base de Aguas Lindas (pospuesta hasta esa verificación) | Administrador responsable |
| Conciliación de 26 comprobaciones desde la sesión del SuperAdmin | SuperAdmin |
| Ajustar hojas de cálculo que lean los CSV con encabezados anteriores | Usuarios |
| Decisiones: RB-D10 (faltante de acta cargable al Administrador saliente), RB-D12 (anulación por partes de una operación conjunta), RB-D13 (pagar desde la pantalla el reembolso de otro Administrador), nombres de los tipos de gasto, política de respaldos (hoy manuales, sin PITR) | Propietario |
| Rótulo «Base de la ruta» en «Selecciona tu ruta» del Supervisor: muestra el efectivo de los trabajadores, no la Base real (archivo compartido con CLEAN, sin cambiar) | Decisión de texto o cifra |
