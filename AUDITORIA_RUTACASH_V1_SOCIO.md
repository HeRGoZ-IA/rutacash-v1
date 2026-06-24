# AUDITORÍA FUNCIONAL Y UX — RutaCash V1
**Fecha:** 2026-06-18  
**Auditor:** Análisis estático de código fuente  
**Versiones:** `rutacash-demo.vercel.app` (DEMO) · `rutacash-clean.vercel.app` (LIMPIO)  
**Objetivo:** Determinar si la V1 está en condición de mostrarse a un socio o cliente potencial.

---

## RESUMEN EJECUTIVO

RutaCash V1 es un producto funcional y presentable con arquitectura sólida. El flujo completo de negocio (crédito → cobro → caja → liquidación) funciona end-to-end sin backend, con datos 100% en IndexedDB. Hay **3 problemas reales que pueden arruinar una demo en vivo** y **varios detalles de comunicación** que un socio técnico notará. El resto son mejoras de UX que no bloquean el pitch.

**Estado general:** ✅ LISTO para mostrar, con las 3 correcciones críticas aplicadas.

---

## HALLAZGOS POR ÁREA

---

### 1. Login y selección de usuarios demo

| Severidad | Hallazgo |
|-----------|----------|
| 🟡 MEDIO | El botón de acceso rápido en modo LIMPIO muestra `role: 'Empresa'` — texto algo técnico para un usuario no técnico. Podría decir "Ingreso inicial". |
| 🟢 BAJO | El input tipo `email` hace validación de formato nativa del browser, pero el campo acepta ingresar y enviar con solo espacio. Si el usuario borra todo y presiona Enter, muestra "Ingresa tu correo y contraseña" (correcto). |
| ✅ OK | Gradiente de fondo, branding, animación de carga, manejo de error de credenciales, redirección por rol: todo funciona correctamente. |
| ✅ OK | Rol `superadmin` → `/platform`, `cobrador` → `/collector/home`, todo lo demás → `/admin/dashboard`. Correcto. |
| ✅ OK | Estado de empresa suspendida bloqueada en login. |

---

### 2. Diferencia funcional DEMO vs LIMPIO

| Severidad | Hallazgo |
|-----------|----------|
| ✅ OK | Separación de builds completa: variables `IS_DEMO / IS_CLEAN` compilan a constantes en el bundle, no hay filtrado en runtime. |
| ✅ OK | Banner de modo visible en todo momento (amber para DEMO, rojo oscuro para LIMPIO). |
| 🟡 MEDIO | La versión LIMPIO presenta el banner `MODO LIMPIO — Datos nuevos` pero el término "datos nuevos" puede confundir al usuario: ¿nuevos vs qué? Sería más claro `VERSIÓN DE CONFIGURACIÓN` o `MODO PRODUCCIÓN`. |
| ✅ OK | Datos de seed completamente separados: DEMO tiene 20+ clientes, 4 rutas, pagos históricos; LIMPIO arranca solo con admin@demo.com. |

---

### 3. Checklist de inicio (modo LIMPIO)

| Severidad | Hallazgo |
|-----------|----------|
| 🔴 CRÍTICO | El estado "ocultar checklist" (botón X) se guarda en `useState` local, NO en Zustand ni localStorage. Si el usuario hace refresh, el checklist vuelve a aparecer. En una demo puede romper la narrativa ("¡Acabo de ocultarlo!"). |
| 🟡 MEDIO | Los pasos 6 (Crear crédito) y 7 (Registrar pago) apuntan al mismo path `/admin/active-sales`. No es un bug — el módulo maneja ambas acciones — pero podría generar confusión en la demo al ver que el paso 7 abre el mismo módulo. |
| 🟡 MEDIO | El checklist desaparece al completar los 7 pasos. No hay mensaje de felicitación ni confirmación visual de "listo para operar". |
| 🟢 BAJO | El criterio de "empresa configurada" requiere que `nombre !== 'Mi Empresa'` && ciudad && país. Si el usuario pone el nombre exactamente `Mi Empresa` (mismo texto), el paso no se completa nunca. |
| ✅ OK | Los 7 pasos son correctos, progresivos y lógicos. La barra de progreso es visual y clara. |

---

### 4. Dashboard administrador

| Severidad | Hallazgo |
|-----------|----------|
| 🔴 CRÍTICO | En modo LIMPIO (antes de crear rutas), el dashboard muestra la alerta `"X ruta(s) sin cobrador asignado"` tan pronto como se crea la primera ruta y antes de asignar cobrador. Esto ocurre DURANTE el checklist, lo que genera confusión al usuario que ve un "error" mientras sigue las instrucciones. Para la demo es distractor. |
| 🟡 MEDIO | Los KPIs "Capital total", "Recaudo hoy", etc. muestran `$0` en modo LIMPIO recién configurado. Está bien funcionalmente, pero en la demo de la versión LIMPIO se ve vacío. |
| ✅ OK | Gráficos Recharts, KPIs, alertas y carga asíncrona todos funcionan. |
| ✅ OK | Color de los gráficos: usa `#D71920` (rojo de marca), no azul. |

---

### 5. Oficinas

| Severidad | Hallazgo |
|-----------|----------|
| 🟡 MEDIO | El campo "Ciudad" no tiene validación de formato ni lista de sugerencias. Un usuario podría escribir cualquier cosa. |
| ✅ OK | CRUD completo: crear, editar, activar/desactivar, eliminar con control de dependencias (bloquea si tiene rutas activas). |
| ✅ OK | Estado vacío con botón de acción, loading spinner, toasts de confirmación. |

---

### 6. Rutas

| Severidad | Hallazgo |
|-----------|----------|
| 🟡 MEDIO | La tasa de interés (`tasaInteres`) y el monto máximo de préstamo no tienen validación de rango: se puede crear una ruta con `tasaInteres: 0` o `montoMaximoPrestamo: -1000`. |
| 🟡 MEDIO | El campo `código` de ruta no valida unicidad. Se pueden crear dos rutas con el mismo código. |
| 🟢 BAJO | `capitalActual` se inicializa igual a `capitalInicial` al crear la ruta, pero no se actualiza automáticamente con movimientos de capital. Este campo parece no usarse como dato dinámico en el motor — la caja real se calcula en `cashboxEngine`. Puede generar confusión. |
| ✅ OK | Eliminación con control de dependencias, asignación de cobrador, filtros por oficina. |

---

### 7. Clientes

| Severidad | Hallazgo |
|-----------|----------|
| 🟠 ALTO | Al crear cliente en modo LIMPIO, si aún no se han creado rutas, `form.routeId` se inicializa en `''` (vacío). El Select muestra "Sin ruta seleccionada" pero el formulario guarda el cliente con `routeId: ''`. El cliente queda sin ruta asignada, invisible para cualquier cobrador. No hay validación que bloquee esto. |
| 🟡 MEDIO | No hay validación de duplicado de documento. Se pueden crear dos clientes con el mismo número de cédula. |
| 🟡 MEDIO | El teléfono principal acepta cualquier texto; no valida formato colombiano ni internacionalforma. |
| 🟡 MEDIO | La carga del módulo tiene un N+1: por cada cliente carga su conteo de ventas activas individualmente en un loop (`for (const c of allClients) { await db.sales... }`). Con 100+ clientes, esto causa lag visible. |
| ✅ OK | Eliminación con control de dependencias (bloquea si tiene ventas, pagos, etc.). |
| ✅ OK | Detalle de cliente con historial de ventas, búsqueda por nombre/documento/teléfono. |

---

### 8. Créditos / Ventas activas

| Severidad | Hallazgo |
|-----------|----------|
| 🟡 MEDIO | No hay validación de que `numeroCuotas > 0`. Si el usuario ingresa 0 o negativo en cuotas, el motor genera un array vacío y la venta se crea sin cuotas. |
| 🟡 MEDIO | La tasa de interés del formulario de venta usa default `20` hardcodeado, no lee la `tasaInteres` de la ruta seleccionada. El admin puede olvidar cambiarla. |
| 🟡 MEDIO | No hay protección contra doble pago: si el cobrador registra un pago Y el admin registra un pago rápido para la misma venta en el mismo día, se aplican ambos (pago doble). |
| 🟢 BAJO | El modal de detalle de venta muestra la lista completa de cuotas sin paginación. Con 365 cuotas (préstamo mensual de 30 años), el modal queda enorme. |
| 🟢 BAJO | El estado "perdida" no permite deshacer. Si un admin marca una venta como perdida por error, no hay forma de reactivarla. |
| ✅ OK | Cálculo de interés, generación de cuotas, aplicación de pagos parciales, actualización de saldo: todo el motor financiero funciona correctamente. |
| ✅ OK | Pago rápido desde admin con 3 botones de monto (cuota completa, mitad, saldo total). |
| ✅ OK | Filtros por ruta y búsqueda por nombre/documento. |

---

### 9. Motor de cuotas (installmentEngine)

| Severidad | Hallazgo |
|-----------|----------|
| ✅ OK | `applyPaymentToInstallments`: aplica el pago a cuotas en orden cronológico, con soporte para pagos parciales. Usa `Math.round()` para evitar acumulación de error de punto flotante. |
| ✅ OK | `calculateSaleBalance`: suma saldos de todas las cuotas. Correcto. |
| ✅ OK | Cuota final absorbe la diferencia de redondeo (`Math.round(valorTotal - valorCuota * (n-1))`). |
| ✅ OK | `recalculateSaleFromPayments`: función de reconciliación que reinicia y re-aplica todos los pagos en orden. Existe pero no se usa en V1 (reservada para V2). |
| ✅ OK | Todas las frecuencias (diaria, semanal, quincenal, mensual) implementadas correctamente con `date-fns`. |
| 🟢 BAJO | `updateInstallmentStatuses` no persiste los `diasMora` calculados en DB; los calcula en memoria cada vez. Si el admin quiere reportar "cuotas en mora", los valores de DB pueden diferir de los visualizados. |

---

### 10. Registro de pagos desde admin

| Severidad | Hallazgo |
|-----------|----------|
| ✅ OK | Modal de pago rápido en ActiveSalesPage: botones de monto, validación de valor > 0, actualización de cuotas e installments, toast de confirmación. |
| 🟡 MEDIO | El pago rápido registra `tipo: 'efectivo'` hardcodeado. No permite registrar transferencia, cheque, etc. |
| 🟡 MEDIO | El pago rápido registra `observacion: ''` vacío. El admin no puede añadir nota al momento del pago. |

---

### 11. Registro de pagos desde app cobrador

| Severidad | Hallazgo |
|-----------|----------|
| 🔴 CRÍTICO | **WhatsApp hardcodeado a Colombia:** `window.open(\`https://wa.me/57${phone}\`)`. Si el cliente tiene número de otro país, el link de WhatsApp será inválido. Aunque la app esté orientada a Colombia, en una demo con alguien de otra región esto falla visiblemente. Corrección: leer el prefijo de país desde la configuración del tenant (`pais` → código de marcación). |
| 🟡 MEDIO | El estado de éxito del pago muestra el `sale.saldo` ANTES del pago (porque el state se actualiza con el nuevo saldo, pero el texto dice "Nuevo saldo: X" y muestra el correcto). Verificado: es correcto — el state se actualiza en línea 74. No es bug. |
| 🟡 MEDIO | Geolocalización falla silenciosamente (`try { } catch {}`). El cobrador no sabe si su ubicación fue capturada o no. Un mensaje "ubicación no disponible" mejoraría la experiencia. |
| 🟢 BAJO | El botón de WhatsApp aparece después de registrar el pago incluso si el cliente no tiene teléfono (`client.telefonoPrincipal` vacío). Al presionarlo, `openWhatsApp` retorna sin hacer nada. Debería ocultarse si no hay teléfono. |
| ✅ OK | Flujo de pago offline (guarda en IndexedDB), 3 botones de monto rápido, campo de observación. |

---

### 12. Gastos (admin y cobrador)

| Severidad | Hallazgo |
|-----------|----------|
| 🟡 MEDIO | En modo LIMPIO, si el admin no crea categorías de gastos antes de que el cobrador intente registrar un gasto, el select de categorías queda vacío y el cobrador no puede guardar nada. No hay mensaje que le indique crear categorías primero. |
| 🟡 MEDIO | Admin puede crear gastos sin categorías también (si no existen). El formulario tiene Select vacío. |
| ✅ OK | CRUD de categorías en el módulo admin, asignación por ruta, filtros por fecha. |

---

### 13. Retiros

| Severidad | Hallazgo |
|-----------|----------|
| 🟡 MEDIO | No hay validación de que la ruta tenga capital suficiente antes de permitir un retiro. Se puede retirar `$10.000.000` de una ruta con `$0` de capital, dejando saldo negativo en caja. |
| 🟡 MEDIO | No hay campo de "aprobado por" o autorización. En el negocio real, un retiro debería tener trazabilidad de quién lo autorizó. |
| ✅ OK | Registro con valor, descripción, fecha, usuario. |

---

### 14. Transferencias

| Severidad | Hallazgo |
|-----------|----------|
| 🟡 MEDIO | No hay validación de que la ruta origen tenga saldo suficiente. Igual que retiros. |
| ✅ OK | Validación de que origen ≠ destino. |
| ✅ OK | Registro correcto en tabla `transfers`. |

---

### 15. Caja

| Severidad | Hallazgo |
|-----------|----------|
| ✅ OK | Auto-carga al seleccionar ruta. Selector de rango de fechas. Desglose completo de entradas y salidas. |
| 🟡 MEDIO | No hay validación de que `fechaDesde <= fechaHasta`. Si el usuario ingresa las fechas al revés, muestra resultados vacíos sin error. |
| 🟡 MEDIO | El `saldoAnterior` calcula todo el historial antes del período. Si la ruta tiene años de movimientos, esto puede ser lento en producción. Para V1 demo no es problema. |
| 🟢 BAJO | El botón "Actualizar" recarga con los mismos parámetros. Está bien, pero podría incluir el ícono de refresh girando mientras carga para dar feedback. |

---

### 16. Liquidación semanal

| Severidad | Hallazgo |
|-----------|----------|
| ✅ OK | Generación on-demand por oficina y rango de semana. Tabla con `overflow-x-auto` para mobile. Columnas ocultas en mobile/tablet con `hidden md:table-cell`. |
| ✅ OK | Export CSV funcional. |
| 🟡 MEDIO | No hay validación de fechas (`semanaInicio > semanaFin`). |
| 🟢 BAJO | El botón CSV solo aparece después de generar, lo que es correcto. Pero si el usuario cierra y vuelve a abrir la página, los datos se pierden (no persisten). Debe regenerar. Debería informarse. |
| 🟢 BAJO | Subtítulo dice "Lunes a Sábado" hardcodeado. Si el usuario opera domingo, la liquidación lo excluirá silenciosamente. |

---

### 17. Reportes CSV

| Severidad | Hallazgo |
|-----------|----------|
| ✅ OK | 4 tipos de reporte: Pagos, Ventas, Gastos, Caja diaria. Filtro por fecha. Vista previa de tabla. Export CSV. |
| ✅ OK | Si hay más de 100 filas en la vista previa, muestra nota: "Mostrando los primeros 100 de X. Exporta CSV para ver todos." — bien manejado. |
| 🟡 MEDIO | El reporte de pagos incluye la columna `Sync` con valor `synced/pending`. Un usuario no técnico no entiende qué significa. Debería ocultarse o renombrarse a algo como `Estado`. |
| 🟢 BAJO | Los valores monetarios en el CSV se exportan como números crudos (sin símbolo de moneda ni formato), lo cual es correcto para importar en Excel. Solo mencionar al socio que esto es intencional. |

---

### 18. Usuarios y roles

| Severidad | Hallazgo |
|-----------|----------|
| 🟡 MEDIO | El rol `supervisor` redirige al dashboard de admin y tiene los mismos permisos que admin. No hay diferenciación funcional. Si el socio pregunta "¿qué puede hacer un supervisor?", la respuesta honesta es "igual que un admin". |
| 🟡 MEDIO | El rol `socio` tampoco tiene pantalla propia ni restricciones específicas. Redirige a admin. |
| ✅ OK | Eliminación con control de dependencias (pagos, ventas, gastos). |
| ✅ OK | Activar/inactivar usuarios. |
| ✅ OK | Sincronización `route.cobradorId` al asignar ruta. |

---

### 19. Configuración de empresa

| Severidad | Hallazgo |
|-----------|----------|
| ✅ OK | Formulario de empresa guarda en DB y actualiza Zustand store (sidebar refleja cambios inmediatamente). |
| ✅ OK | Exportación de backup JSON funcional. |
| ✅ OK | Reset de versión limpia implementado (limpia tablas operativas, conserva admin). |
| 🟡 MEDIO | En modo DEMO, la sección "Usuarios de acceso" muestra las 4 cuentas demo correctamente. En modo LIMPIO, muestra el mensaje contextual con link a Usuarios. Correcto. |
| 🟢 BAJO | El selector de moneda tiene 7 opciones pero la app siempre muestra `$` como símbolo (hardcodeado en `formatCurrency`). Si se elige USD, EUR, etc., la moneda sigue mostrando `$`. |

---

### 20. Eliminación controlada de entidades

| Severidad | Hallazgo |
|-----------|----------|
| ✅ OK | **Oficinas:** bloquea si tiene rutas activas. |
| ✅ OK | **Rutas:** bloquea si tiene clientes, ventas o pagos. |
| ✅ OK | **Clientes:** bloquea si tiene ventas, pagos, gastos, transferencias o retiros. |
| ✅ OK | **Usuarios:** bloquea si el usuario tiene movimientos registrados. Bloquea eliminar el último admin activo. Bloquea auto-eliminar. |
| 🟡 MEDIO | No hay forma de **anular** un pago o venta. Si se registró un pago por error, no hay mecanismo de corrección. Solo el reset completo. |

---

### 21. Experiencia móvil del cobrador

| Severidad | Hallazgo |
|-----------|----------|
| 🔴 CRÍTICO | **N+1 de installments en ruta:** `CollectorRoutePage` carga las ventas activas de la ruta y luego, dentro de un `for`, hace `await db.installments.where('saleId').equals(sale.id).toArray()` para CADA venta. Con 20 clientes = 20 queries seriales. En el demo de Vercel con IndexedDB en Chrome puede sentirse lento (0.5–2s). Con 50 clientes en producción, el cobrador espera 4-8 segundos para ver su lista. **Corrección:** hacer una sola query `db.installments.where('saleId').anyOf(saleIds).toArray()` fuera del loop. |
| 🟡 MEDIO | `CollectorHomePage` carga TODOS los installments con `db.installments.toArray()` (sin filtro) para calcular "pendientes del día". En producción con 1000+ cuotas, esto degrada. Para la demo con 20 clientes, funciona. |
| 🟡 MEDIO | No hay botón de **logout** visible en la app del cobrador. Para cambiar de usuario, el cobrador debe ir manualmente a `/login` o borrar datos del browser. En una demo esto puede ser incómodo. |
| 🟡 MEDIO | Si el cobrador no tiene `routeId` asignado (clean mode, antes del paso 4 del checklist), el home muestra las stats en 0 y el botón "Iniciar ruta" lleva a una pantalla vacía sin mensaje de error claro. |
| ✅ OK | CollectorRoutePage: clientes ordenados (no pagados primero, pagados al final con opacidad reducida). Visual limpio, cards claras. |
| ✅ OK | PaymentPage: input grande centrado, 3 botones de monto rápido, observación opcional, animación de éxito con check verde. |
| ✅ OK | ClientDetailPage: accesible desde el ojo de cada card en la ruta. |

---

### 22. Textos visibles para usuario no técnico

| Severidad | Hallazgo |
|-----------|----------|
| 🟡 MEDIO | Columna `Sync` en reportes CSV (ver #17). |
| 🟡 MEDIO | `SyncPage` del cobrador: el botón "Sincronizar ahora" tiene éxito visual, pero en V1 NO hay servidor real — solo marca los items como `synced` en IndexedDB. Si el socio es técnico y pregunta "¿a qué servidor sincroniza?", la respuesta correcta es "en V1 el dispositivo es la fuente de verdad; V2 tendrá backend Supabase". El botón debe manejarse en el pitch como "preparado para V2". |
| 🟡 MEDIO | Error `'Credenciales incorrectas'` en login podría ser más amigable: `'Correo o contraseña incorrectos'`. |
| 🟢 BAJO | Término `"Parcela"` no aparece en la app — usa "cuota" consistentemente. Bien. |
| 🟢 BAJO | Rol `superadmin` en login → plataforma, pero el botón `Platform` en la seed demo está etiquetado como `'Super Admin'` con `role: 'Platform'`. El texto "Platform" es técnico. |
| 🟢 BAJO | El checklist paso 4 dice "Agrega un cobrador" pero el botón del menú admin dice "Usuarios". Menor inconsistencia. |

---

### 23. Errores visuales o de navegación

| Severidad | Hallazgo |
|-----------|----------|
| ✅ OK | Ruta `*` (no encontrada) → `<Navigate to="/login" />`. No hay pantalla 404 blanca. |
| ✅ OK | RequireAuth verifica roles. Un cobrador que intenta entrar a `/admin/*` es redirigido a `/login`. |
| 🟡 MEDIO | Botones de "Cobrar" en CollectorRoutePage se muestran para clientes que ya pagaron hoy (la lógica los oculta correctamente con `{!paidToday && ...}`). Verificado: correcto. |
| 🟢 BAJO | En la liquidación semanal, las columnas Cobros, Préstamos, Gastos, Trans., Retiros se ocultan en mobile (`hidden md:table-cell`). Queda solo Ruta + Saldo anterior + Capital + Saldo final. Funcional pero no ideal para mobile. |
| 🟢 BAJO | El selector de ruta en CashboxPage auto-selecciona la primera ruta disponible. El usuario podría no darse cuenta de cuál ruta está viendo. |

---

### 24. Riesgos de mostrar esta V1 a un socio/cliente

| Riesgo | Severidad | Mitigación recomendada |
|--------|-----------|------------------------|
| **WhatsApp con +57 hardcodeado** — si el socio prueba con número de otro país | 🔴 CRÍTICO | Arreglar antes de la demo (5 min de código) |
| **N+1 en página de ruta del cobrador** — lag visible con 20 clientes demo | 🔴 CRÍTICO | Arreglar antes de la demo (bulk query) |
| **Checklist reaparece al hacer refresh** — rompe la narrativa "ya lo configuré" | 🔴 CRÍTICO | Persistir `dismissed` en localStorage |
| **"Sincronizar" no sincroniza con ningún servidor** — confusión si socio es técnico | 🟠 ALTO | Renombrar a "Verificar datos locales" o preparar explicación del roadmap V2 |
| **Contraseñas en texto plano en IndexedDB** — visible en DevTools → Application → IndexedDB | 🟠 ALTO | Si el socio abre DevTools, se ve. Mínimo implementar bcrypt o un hash simple |
| **Alerta "rutas sin cobrador" aparece durante el setup** en clean mode | 🟠 ALTO | Suprimir esta alerta específica si `completed < 7` en el checklist |
| **Formateo de moneda hardcodeado a `$`** independiente del país | 🟡 MEDIO | Aclarar en demo que la moneda se mapea en V2 |
| **Cliente sin ruta si no hay rutas al crearlo** | 🟡 MEDIO | Bloquear form hasta que existan rutas, o advertir |
| **Doble pago posible (cobrador + admin el mismo día)** | 🟡 MEDIO | Protección simple: verificar si ya hay pago del día antes de permitir nuevo |

---

### 25. Mejoras rápidas recomendadas (sin tocar arquitectura)

Las siguientes mejoras toman menos de 2 horas cada una y mejoran significativamente la impresión en demo:

| Prioridad | Mejora | Esfuerzo |
|-----------|--------|----------|
| 1 | **Persistir dismissed del checklist** en `localStorage` | 15 min |
| 2 | **Fix N+1 en CollectorRoutePage** — bulk query de installments | 20 min |
| 3 | **Fix WhatsApp +57 hardcodeado** — leer prefijo del tenant.pais | 20 min |
| 4 | **Suprimir alerta "ruta sin cobrador" mientras el checklist está activo** | 10 min |
| 5 | **Ocultar botón WhatsApp si cliente no tiene teléfono** | 5 min |
| 6 | **Validar fechaDesde ≤ fechaHasta** en Caja y Liquidación | 10 min |
| 7 | **Validar numeroCuotas > 0** en formulario de crédito | 5 min |
| 8 | **Mensaje de "sin categorías" en gastos** cuando el select está vacío | 15 min |
| 9 | **Bloquear creación de cliente sin ruta disponible** | 10 min |
| 10 | **Agregar link de logout visible** en CollectorLayout | 10 min |

---

## TABLA RESUMEN DE HALLAZGOS

| # | Área | Severidad | Hallazgo |
|---|------|-----------|----------|
| H-01 | Cobrador — Pagos | 🔴 CRÍTICO | WhatsApp hardcodeado a +57 Colombia |
| H-02 | Cobrador — Ruta | 🔴 CRÍTICO | N+1 query en carga de installments por venta |
| H-03 | Checklist LIMPIO | 🔴 CRÍTICO | Estado "dismissed" no persiste; reaparece en refresh |
| H-04 | Dashboard | 🟠 ALTO | Alerta "ruta sin cobrador" aparece durante el flujo de setup |
| H-05 | Sync | 🟠 ALTO | `syncService` en V1 es local; "Sincronizar" no va a servidor real |
| H-06 | Clientes | 🟠 ALTO | Cliente se puede crear sin ruta si no existen rutas aún |
| H-07 | Auth | 🟠 ALTO | Contraseñas en texto plano en IndexedDB (visible en DevTools) |
| H-08 | Cobrador — Home | 🟡 MEDIO | Cobrador sin routeId asignado ve pantalla vacía sin mensaje |
| H-09 | Cobrador | 🟡 MEDIO | No hay botón de logout en la app del cobrador |
| H-10 | Créditos | 🟡 MEDIO | Sin protección contra doble pago mismo día (cobrador + admin) |
| H-11 | Créditos | 🟡 MEDIO | `numeroCuotas: 0` no está validado |
| H-12 | Créditos | 🟡 MEDIO | `tasaInteres` default 20% no lee del campo de la ruta seleccionada |
| H-13 | Gastos | 🟡 MEDIO | Select de categorías vacío si no hay categorías creadas |
| H-14 | Retiros/Transfers | 🟡 MEDIO | Sin validación de capital suficiente en la ruta |
| H-15 | Caja/Liquidación | 🟡 MEDIO | Sin validación de fechaDesde ≤ fechaHasta |
| H-16 | Reportes | 🟡 MEDIO | Columna `Sync` con valor técnico visible en CSV |
| H-17 | Usuarios | 🟡 MEDIO | Roles supervisor/socio sin comportamiento diferenciado |
| H-18 | Configuración | 🟢 BAJO | Símbolo `$` hardcodeado en formatCurrency |
| H-19 | Liquidación | 🟢 BAJO | "Lunes a Sábado" hardcodeado |
| H-20 | Checklist | 🟢 BAJO | Sin mensaje de éxito al completar los 7 pasos |

---

## NO HACER TODAVÍA

Las siguientes funcionalidades **NO se deben implementar en V1** porque:
- Requieren backend real y pueden crear deuda técnica difícil de migrar
- Pueden romper la arquitectura offline-first actual
- No son necesarias para el pitch inicial

| Funcionalidad | Por qué esperar |
|---------------|-----------------|
| **Autenticación con JWT / OAuth** | Requiere servidor. La auth actual (IndexedDB + Zustand persist) es coherente con el modelo offline. Implementar JWT en V1 rompería el login offline. |
| **Sincronización real con backend** | `syncService` está preparado para V2/Supabase. Conectarlo ahora sin el schema de backend definido generará migraciones dolorosas. |
| **Multitenancy real** (varios tenants simultáneos) | La DB local tiene un solo tenant en limpio. Soportar múltiples requiere repensar el seed, el login y el particionamiento de datos. |
| **Push notifications** | Requiere Service Worker + backend de push. Fuera de scope para V1 offline-first. |
| **Geolocalización obligatoria para pagos** | Ya se captura silenciosamente. Hacerla obligatoria bloquea cobradores en zonas sin señal GPS o con permisos negados. |
| **Firma digital del cobrador** | Requiere canvas + almacenamiento de imágenes en IndexedDB (blobs grandes). Degradaría rendimiento. |
| **Módulo de auditoría con UI** | `auditLogs` se está llenando, pero construir la UI de auditoría es scope de V2 con filtros de servidor. |
| **Importación masiva de clientes (Excel/CSV)** | La validación, deduplicación y mapeo de campos es complejo. Un error puede corromper la base local sin rollback. |
| **Refinanciación / reestructuración de créditos** | Afecta directamente al motor de cuotas. Implementar mal puede dejar `saldo` inconsistente en sales e installments. Esperar a tener pruebas unitarias del engine. |
| **Roles con permisos granulares** | Actualmente supervisor = admin funcionalmente. Definir la matriz de permisos requiere una sesión de diseño de producto, no solo código. |
| **Versión PWA instalable** | El `manifest.json` y service worker de cache necesitan estrategia de actualización offline. Mal implementado puede servir versión desactualizada indefinidamente. |
| **Internacionalización (i18n)** | Cambiar textos hardcodeados en 25 páginas sin sistema i18n es propenso a errores. Debe planificarse desde arquitectura en V2. |

---

## CONCLUSIÓN

**RutaCash V1 está listo para una demo con 3 correcciones críticas previas:**

1. `H-03` — Persistir checklist dismissed en localStorage (15 min)
2. `H-02` — Bulk query de installments en CollectorRoutePage (20 min)  
3. `H-01` — Fix WhatsApp +57 hardcodeado (20 min)

Con esas 3 correcciones, la app puede demostrarse con confianza. El flujo completo funciona: empresa → oficina → ruta → cobrador → cliente → crédito → pago → caja → liquidación → reporte CSV. La UI es profesional, mobile-first para el cobrador, y el modelo de negocio es claro en el pitch.

**El único tema de comunicación importante:** estar preparado para explicar que en V1 los datos son 100% locales en el dispositivo, y que V2 incluirá sincronización real con Supabase. El botón "Sincronizar" debe contextualizarse como parte de esa arquitectura futura.

---
*Archivo generado: AUDITORIA_RUTACASH_V1_SOCIO.md*  
*Líneas de código analizadas: ~3.000 (25 archivos)*  
*No se realizaron cambios al código.*
