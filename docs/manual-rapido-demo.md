# RutaCash V1 — Manual Rápido de Demo

> **Para compartir con el cliente.**
> Esta guía explica cómo ejecutar la aplicación, qué usuarios usar y qué puede probar en cada módulo durante la demostración.

---

## 1. Cómo ejecutar la aplicación

### Requisitos previos
- Tener instalado **Node.js 18+** (verificar con `node -v` en la terminal)
- Tener el proyecto en la carpeta `c:\TradingBot\CobrosApp`

### Pasos para iniciar

Abrir una terminal (PowerShell o CMD) y ejecutar:

```
cd c:\TradingBot\CobrosApp
npm install
npm run dev
```

Luego abrir el navegador en: **http://localhost:3000**

> La primera vez que cargue, la app crea automáticamente todos los datos de demostración. No hay nada que configurar manualmente.

### Notas importantes
- Usar **Google Chrome** o **Microsoft Edge** para la mejor experiencia.
- Para la app del cobrador, usar las herramientas de desarrollo del navegador (F12 → ícono de móvil) para simular pantalla de celular.
- Los datos se guardan en el navegador (IndexedDB). Si se borra el historial del navegador, los datos se pierden. Para recuperarlos, ir a **Configuración → Restaurar datos demo**.

---

## 2. Usuarios demo disponibles

Todos los usuarios ya vienen creados automáticamente. No hay que crearlos manualmente.

| Email | Contraseña | Rol | Accede a | Ruta inicial |
|---|---|---|---|---|
| superadmin@demo.com | 123456 | Super Administrador | Panel de plataforma (gestión de empresas) | /platform |
| admin@demo.com | 123456 | Administrador | Panel admin completo (todos los módulos) | /admin/dashboard |
| supervisor@demo.com | 123456 | Supervisor | Panel admin sin Capital, Transferencias, Retiros ni Usuarios | /admin/dashboard |
| cobrador@demo.com | 123456 | Cobrador | App móvil del cobrador | /collector/home |

### Preguntas frecuentes sobre usuarios

**¿Dónde se crean nuevos usuarios?**
En el panel admin, módulo **Usuarios** (menú lateral, ícono de personas). Solo visible para el rol Administrador.

**¿Se puede cambiar la contraseña?**
En V1 no existe pantalla de cambio de contraseña. Al crear un usuario nuevo, la contraseña por defecto es `123456`. Esto es una limitación conocida de la versión demo; en V2 habrá autenticación real con contraseñas seguras.

**¿Se pueden crear más cobradores?**
Sí, desde el módulo Usuarios → Nueva persona → seleccionar rol "Cobrador" y asignarle una ruta.

---

## 3. Guía: Super Administrador de Plataforma

**Usuario:** superadmin@demo.com / 123456

Este rol representa al **dueño de RutaCash** (no al cliente prestamista). Sirve para gestionar qué empresas (prestamistas) están usando el sistema.

### Paso a paso

1. Ingresar con `superadmin@demo.com` / `123456`.
2. El sistema redirige automáticamente a `/platform` — **Panel de Plataforma**.
3. Se verá la tarjeta de la empresa demo: **"Credirutas Norte"**.

### Qué puede revisar el cliente aquí

| Acción | Cómo hacerlo | Resultado esperado |
|---|---|---|
| Ver empresa registrada | La tarjeta ya está visible | Muestra nombre, email, plan "profesional", estado "activa" |
| Ver métricas de la empresa | En la misma tarjeta | Muestra 2 oficinas, 4 rutas, 7 usuarios, 20 clientes, 12 ventas activas |
| Suspender empresa | Clic en botón rojo "Suspender" | El estado cambia a "suspendida" |
| Reactivar empresa | Clic en botón verde "Activar" | El estado vuelve a "activa" |
| Crear nueva empresa | Botón "Nueva empresa" (arriba a la derecha) | Se abre formulario con nombre, email, plan y fecha de vencimiento |

> **Nota para el cliente:** Este panel es el que usaría el equipo de RutaCash para gestionar cada empresa que contrate el servicio. Como cliente prestamista, el día a día se maneja desde el panel de Administrador, no desde aquí.

---

## 4. Guía: Administrador / Prestamista

**Usuario:** admin@demo.com / 123456

Este es el rol principal del sistema. El administrador gestiona toda la operación de la empresa de cobradiario.

---

### 4.1 Dashboard principal

**Ruta:** `/admin/dashboard`

**Para qué sirve:** Vista general del negocio en tiempo real.

**Qué puede revisar:**
- Tarjetas de resumen: Capital total, Cartera activa, Cobrado hoy, Cobrado esta semana, Ventas activas, Clientes activos, Gastos de la semana.
- Alertas automáticas (pagos pendientes de sync, rutas sin cobrador, rutas en mora).
- Gráfico de barras: cobros de los últimos 7 días (en español: lun, mar, mié...).
- Gráfico de barras: top rutas por recaudo semanal.

**Datos demo que verá:** Los cobros simulados de las 12 ventas activas aparecen en el gráfico. Las alertas mostrarán al menos 1 pago pendiente de sincronización.

---

### 4.2 Oficinas

**Ruta:** `/admin/offices` — Solo visible para Administrador

**Para qué sirve:** Gestionar las sucursales o puntos de operación.

**Qué puede revisar:**
- Lista de oficinas: **Oficina Central Barranquilla** y **Oficina Soledad**.
- Crear una nueva oficina con el botón "+ Nueva oficina".
- Editar nombre, ciudad, responsable, teléfono.
- Activar o inactivar una oficina.

---

### 4.3 Rutas

**Ruta:** `/admin/routes`

**Para qué sirve:** Cada ruta es un conjunto de clientes que recorre un cobrador. Se configura aquí la tasa de interés base y el cobrador asignado.

**Rutas demo disponibles:**

| Ruta | Oficina | Cobrador asignado | Tasa interés |
|---|---|---|---|
| Ruta Norte | Barranquilla | Juan Cobrador | 20% |
| Ruta Sur | Barranquilla | Pedro Cobrador | 20% |
| Ruta Soledad Centro | Soledad | Ana Cobradora | 20% |
| Ruta Soledad Industrial | Soledad | Luis Cobrador | 20% |

**Qué puede probar:**
- Ver las 4 rutas existentes.
- Crear una nueva ruta asignando cobrador y tasa de interés.
- Editar una ruta existente.

---

### 4.4 Clientes

**Ruta:** `/admin/clients`

**Para qué sirve:** Directorio de todos los clientes (deudores) de la empresa.

**Qué puede revisar:**
- 20 clientes precargados, con nombre, documento, negocio, teléfono y dirección.
- Buscar por nombre o número de documento.
- Filtrar por ruta.
- Ver el detalle de un cliente (botón ojo) para ver su historial de ventas y cuotas.

**Qué puede probar:**
- Crear un nuevo cliente con el botón "+ Nuevo cliente".
- Buscar a "María García" y ver su detalle — tiene 1 crédito activo.

---

### 4.5 Ventas / Créditos

**Ruta:** `/admin/active-sales`

**Para qué sirve:** Ver y gestionar todos los créditos entregados. Aquí se crea un nuevo crédito y se consulta el estado de cada uno.

**Datos demo:** 12 ventas activas con diferentes montos, tasas y estados de cuotas.

**Qué puede probar:**

**Ver un crédito existente:**
1. Buscar cualquier cliente en la lista.
2. Hacer clic en el botón ojo (Ver detalle).
3. Ver: valor del préstamo, total con interés, saldo pendiente, valor de cuota y lista de cuotas.
4. Las cuotas pasadas están marcadas como "pagada", las futuras como "pendiente".

**Crear un nuevo crédito:**
1. Clic en "+ Nueva venta".
2. Seleccionar cliente y ruta.
3. Ingresar valor del préstamo (ej: $300.000).
4. La tasa de interés se toma de la ruta (20% por defecto).
5. Definir número de cuotas (ej: 30) y frecuencia (diaria).
6. El sistema calcula automáticamente: interés, total a pagar, valor de cuota y fecha estimada de finalización.
7. Confirmar con "Crear venta" — las 30 cuotas se generan automáticamente.

**Marcar crédito como perdido:**
1. Abrir el detalle de cualquier venta activa.
2. Clic en "Marcar perdida".
3. Ingresar el motivo (ej: "Cliente desapareció").
4. La venta cambia de estado a "perdida".

---

### 4.6 Capital / Base por ruta

**Ruta:** `/admin/capital` — Solo visible para Administrador

**Para qué sirve:** Registrar cuándo el administrador inyecta dinero (capital) a una ruta para que el cobrador pueda prestar.

**Datos demo:** Hay 5 movimientos de capital precargados (entre $2.500.000 y $5.000.000 por ruta).

**Qué puede probar:**
- Ver el historial de inyecciones de capital por ruta.
- Registrar un nuevo ingreso de capital seleccionando ruta, valor y fecha.

---

### 4.7 Gastos

**Ruta:** `/admin/expenses`

**Para qué sirve:** Registrar los gastos operativos de cada ruta (gasolina, despinchadas, comisiones, etc.).

**Datos demo:** 6 gastos precargados en diferentes rutas (gasolina, transporte, etc.).

**Qué puede probar:**
- Ver el listado de gastos con fecha, ruta y categoría.
- Registrar un nuevo gasto con el botón "+ Nuevo gasto".

---

### 4.8 Transferencias entre rutas

**Ruta:** `/admin/transfers` — Solo visible para Administrador

**Para qué sirve:** Mover dinero de una ruta a otra cuando una necesita refuerzo de capital.

**Datos demo:** 1 transferencia de $200.000 de Ruta Norte a Ruta Sur.

**Qué puede probar:**
- Ver la transferencia existente.
- Crear una nueva transferencia seleccionando ruta origen, ruta destino y valor.

---

### 4.9 Retiros

**Ruta:** `/admin/withdrawals` — Solo visible para Administrador

**Para qué sirve:** Registrar cuando el dueño retira ganancias de una ruta.

**Datos demo:** 2 retiros precargados ($150.000 de Ruta Norte y $300.000 de Ruta Soledad Industrial).

**Qué puede probar:**
- Ver los retiros existentes.
- Registrar un nuevo retiro.

---

### 4.10 Caja

**Ruta:** `/admin/cashbox`

**Para qué sirve:** Ver el estado financiero de una ruta en un período de tiempo. Muestra de dónde viene y a dónde va el dinero.

**Cómo usarlo:**
1. Seleccionar una ruta (ej: Ruta Norte).
2. Definir rango de fechas (por defecto: la semana actual).
3. Clic en "Actualizar".

**Qué verá:**

| Concepto | Descripción |
|---|---|
| Saldo anterior | Lo que había en caja antes del período |
| (+) Ingreso capital | Dinero inyectado por el administrador |
| (+) Cobros recibidos | Total de pagos de clientes en el período |
| (+) Transferencias entrantes | Dinero recibido de otras rutas |
| (-) Préstamos entregados | Dinero prestado a clientes nuevos |
| (-) Gastos | Gastos operativos de la ruta |
| (-) Transferencias salientes | Dinero enviado a otras rutas |
| (-) Retiros | Ganancias retiradas por el dueño |
| **SALDO ACTUAL** | **Resultado final: dinero disponible en la ruta** |

> **Resultado esperado:** La Ruta Norte mostrará un saldo positivo calculado desde todos los movimientos reales de los datos demo.

---

### 4.11 Reportes

**Ruta:** `/admin/reports`

**Para qué sirve:** Generar reportes en tabla y exportarlos a Excel (CSV).

**Tipos de reportes disponibles:**
- **Pagos:** Lista de todos los cobros en un rango de fechas, con cliente, ruta y valor.
- **Ventas:** Lista de créditos creados en el período.
- **Gastos:** Lista de gastos operativos.
- **Caja diaria:** Resumen diario por ruta.

**Qué puede probar:**
1. Seleccionar tipo "Pagos", dejar el rango de fechas de la semana.
2. Clic en "Generar".
3. Ver la tabla de resultados (primeras 100 filas).
4. Clic en "Exportar CSV" para descargar el archivo.
5. Abrir en Excel — el archivo incluye caracteres especiales correctamente (tildes, ñ).

---

### 4.12 Liquidación Semanal

**Ruta:** `/admin/weekly-settlement`

**Para qué sirve:** El resumen financiero de todas las rutas de una oficina para la semana (lunes a sábado). Es el "cierre de semana" del cobrador.

**Cómo usarlo:**
1. Seleccionar una oficina (ej: Oficina Central Barranquilla).
2. Verificar las fechas de inicio y fin de semana (ya vienen precargadas).
3. Clic en "Generar".

**Qué verá:**
- Una fila por ruta con: saldo anterior, capital, cobros, préstamos, gastos, transferencias, retiros y **saldo final**.
- Totales al inicio: total cobros, total gastos, saldo global.

**Qué puede probar:**
- Generar la liquidación de la semana actual.
- Cambiar las fechas para ver una semana anterior.
- Exportar a CSV con el botón "CSV".

---

### 4.13 Usuarios

**Ruta:** `/admin/users` — Solo visible para Administrador

**Para qué sirve:** Gestionar quién tiene acceso al sistema y con qué rol.

**Usuarios demo existentes:** 7 usuarios (1 super admin, 1 admin, 1 supervisor, 4 cobradores).

**Qué puede probar:**
- Ver la lista de usuarios con rol y estado.
- Crear un nuevo usuario con el botón "+ Nuevo usuario".
- Editar nombre, email o ruta asignada de un usuario existente.
- Activar o inactivar un usuario.

> **Nota:** La contraseña se asigna al crear el usuario. Por defecto: `123456`. En V1 no existe opción de cambio de contraseña desde el perfil.

---

### 4.14 Configuración

**Ruta:** `/admin/settings`

**Para qué sirve:** Opciones de sistema para la demo.

**Funciones disponibles:**

| Función | Qué hace |
|---|---|
| Restaurar datos demo | Borra todo y vuelve al estado inicial (útil para reiniciar la demo) |
| Exportar backup JSON | Descarga todos los datos actuales en un archivo JSON |

**Qué puede probar:**
- Exportar el backup para ver la estructura de los datos.
- Después de hacer pruebas, restaurar datos demo para dejar todo limpio.

> **Importante:** "Restaurar datos demo" borra TODO lo que se haya registrado en la demo. Solo usar al final de una sesión de prueba.

---

## 5. Guía: Supervisor

**Usuario:** supervisor@demo.com / 123456

El supervisor ve el mismo panel que el administrador, con las siguientes excepciones:

**Módulos que NO puede ver el supervisor (ocultos en el menú):**
- Oficinas
- Capital
- Transferencias
- Retiros
- Usuarios

**Módulos que SÍ puede ver:**
Dashboard, Rutas, Clientes, Ventas Activas, Gastos, Caja, Reportes, Liquidación Semanal, Configuración.

> **Nota para el cliente:** En V1, si el supervisor conoce la URL directa de un módulo restringido, podría acceder. El control de acceso a nivel de URL por rol se reforzará en V2 con autenticación de backend.

**Caso de uso típico del supervisor:**
- Revisar la caja de cada ruta al cierre del día.
- Consultar clientes en mora.
- Ver el avance de cobros en tiempo real.
- Generar la liquidación semanal para presentarla al administrador.

---

## 6. Guía: Cobrador — App Móvil

**Usuario:** cobrador@demo.com / 123456

La app del cobrador está diseñada para usarse en el **celular**. En la computadora, activar la vista móvil:
- Chrome/Edge: presionar **F12** → hacer clic en el ícono de celular (arriba a la izquierda del inspector) → seleccionar "iPhone 12" o similar.

El cobrador demo (**Juan Cobrador**) tiene asignada la **Ruta Norte** con 5 clientes activos.

---

### 6.1 Inicio (Home)

Al ingresar, el cobrador ve:
- Saludo personalizado con la hora del día.
- Nombre de la ruta asignada (Ruta Norte).
- 3 tarjetas: pendientes de cobrar, cobrado hoy, ventas activas.
- Botón grande "Iniciar ruta".
- Accesos directos: ver ruta completa, registrar gasto, sincronizar pagos.

---

### 6.2 Lista de ruta

Clic en **"Iniciar ruta"** o **"Ver mi ruta completa"**.

**Qué verá:**
- Barra superior: cuántos clientes pendientes vs. cobrados hoy.
- Lista de clientes ordenada: primero los pendientes, luego los ya cobrados (aparecen opacos).
- Cada tarjeta muestra: nombre del cliente, negocio, saldo pendiente, valor de cuota y número de cuota actual.
- Badges de estado: **Pendiente** (normal), **Vencida** (borde rojo), **Cobrado** (opaco).

**Qué puede probar:**
- Buscar un cliente por nombre o documento con la barra de búsqueda.
- Identificar qué clientes tienen cuotas vencidas (borde rojo).

---

### 6.3 Ver detalle del cliente

Desde la lista de ruta, tocar el botón ojo (Ver) en cualquier cliente.

**Qué verá:**
- Cabecera con nombre y negocio.
- Tarjeta de crédito activo: saldo, valor de cuota, progreso (cuota X de Y).
- Botones: "Registrar pago" y "WhatsApp".
- Información de contacto: teléfono, dirección, documento.
- Últimas 10 cuotas con estado (pagada / pendiente / vencida).

---

### 6.4 Registrar pago completo

Desde la lista de ruta, tocar **"Cobrar"** en cualquier cliente pendiente.

1. La pantalla muestra el saldo y la cuota actual del cliente.
2. El valor de la cuota ya viene precargado en el campo.
3. Hay 3 botones rápidos: **Cuota completa**, **Mitad**, **Total** (pagar todo el saldo).
4. Opcionalmente escribir una observación.
5. Tocar **"Registrar pago"**.
6. La app pide permiso de ubicación (para registrar dónde se hizo el cobro).
7. Aparece pantalla de confirmación con el nuevo saldo.
8. Botón "Enviar recibo por WhatsApp" (abre WhatsApp con mensaje prellenado).
9. Tocar "Volver a la ruta" — el cliente aparece ahora como "Cobrado".

---

### 6.5 Registrar pago parcial

Mismo flujo que el pago completo, pero en el campo de valor ingresar un monto menor a la cuota.

**Ejemplo:** cuota = $16.000, pagar $8.000 (mitad). Tocar el botón "Mitad" o escribir manualmente.

El sistema aplica el pago parcialmente a la cuota actual. La cuota queda en estado "parcial" y el saldo se reduce en el valor pagado.

---

### 6.6 Registrar "No pagó"

Desde la lista de ruta, tocar el botón rojo **"No pagó"** junto al cliente.

1. Seleccionar el motivo:
   - No estaba
   - Sin dinero
   - Negocio cerrado
   - Promesa de pago *(si se selecciona, aparece un campo para ingresar la fecha prometida)*
   - Otro
2. Opcionalmente agregar una observación.
3. Tocar "Registrar no pago".
4. El sistema guarda la visita sin pago. El cliente sigue apareciendo como pendiente en la ruta.

---

### 6.7 Registrar gasto

Desde el menú inferior del cobrador, tocar **"Gastos"**, o desde Home → "Registrar gasto".

1. Tocar el botón "+" para agregar un gasto.
2. Seleccionar categoría (Gasolina, Aceite, Despinchada, Comisión, Pago policía, Transporte, Otro).
3. Ingresar el valor y una descripción.
4. Tocar "Guardar".

El gasto queda registrado en la ruta del cobrador y visible para el administrador en el módulo Gastos y en la Caja.

---

### 6.8 Sincronización de pagos

Desde el menú inferior, tocar **"Sync"**.

**Qué verá:**
- Estado de conexión (verde: conectado, gris: sin conexión).
- Conteo de pagos pendientes de sincronizar vs. sincronizados.
- Historial de todos los pagos registrados en la ruta.

**Qué puede probar — flujo offline:**

1. **Desactivar internet** (modo avión o desconectar WiFi).
2. En la app del cobrador, registrar un pago normalmente.
3. Ir a "Sync" — el pago aparece como **"Pendiente"** con ícono naranja.
4. **Activar internet** de nuevo.
5. Tocar **"Sincronizar ahora"**.
6. El mensaje cambia a "X item(s) sincronizados".
7. El pago ahora aparece como **"Sincronizado"** con ícono verde.

> **Nota:** En V1, la sincronización es simulada. El pago se guarda localmente desde el principio; la sincronización solo cambia el estado visual de "pendiente" a "sincronizado". En V2, este paso enviará los datos al servidor real.

---

### 6.9 Enviar recibo por WhatsApp

Disponible en dos lugares:
- Pantalla de confirmación de pago (después de cobrar).
- Detalle del cliente (botón "WhatsApp").

Al tocar el botón, se abre WhatsApp con un mensaje prellenado que incluye: nombre del cliente, valor pagado, nuevo saldo y número de cuota. El cobrador solo debe presionar enviar.

> **Requisito:** WhatsApp debe estar instalado en el dispositivo. El sistema usa el número de teléfono registrado del cliente.

---

## 7. Checklist de evaluación para el cliente

Durante la demo, el cliente puede revisar los siguientes puntos:

### Flujo general
- [ ] ¿El inicio de sesión es claro y rápido?
- [ ] ¿La navegación entre módulos es intuitiva?
- [ ] ¿Los términos usados (cuota, saldo, ruta, cobrador) coinciden con el lenguaje del negocio?

### Panel del administrador
- [ ] ¿El dashboard muestra la información que necesito ver a diario?
- [ ] ¿La ficha del cliente tiene los datos relevantes?
- [ ] ¿La creación de un nuevo crédito es fácil de entender?
- [ ] ¿La pantalla de cuotas muestra claramente qué está pagado y qué está pendiente?
- [ ] ¿El pago parcial funciona como se espera en el negocio?
- [ ] ¿La caja refleja correctamente los movimientos?
- [ ] ¿La liquidación semanal sirve para el cierre con los cobradores?
- [ ] ¿Los reportes en Excel son suficientes para la operación actual?

### App del cobrador
- [ ] ¿La app del cobrador es suficientemente simple para el día a día?
- [ ] ¿La lista de clientes pendientes es clara?
- [ ] ¿El registro de pago es rápido (menos de 5 pasos)?
- [ ] ¿El flujo offline es comprensible?
- [ ] ¿El mensaje de WhatsApp prellenado es útil?

### Comparación con sistema actual
- [ ] ¿Qué módulo se parece más a lo que usan en Giper o en el sistema actual?
- [ ] ¿Qué módulo o dato falta?
- [ ] ¿Qué módulo debe mejorarse antes de usar en producción?
- [ ] ¿El diseño es lo suficientemente profesional para presentarlo a cobradores?

---

## 8. Funcionalidades listas en V1

Lo que ya está construido y funciona localmente:

- Inicio de sesión con 4 roles (Super Admin, Administrador, Supervisor, Cobrador)
- Gestión de empresas (plataforma multi-tenant)
- Gestión de oficinas
- Gestión de rutas con asignación de cobrador y tasa de interés
- Gestión completa de clientes
- Creación de créditos con generación automática de cuotas
- Cálculo automático de interés, total, valor de cuota y fecha estimada de fin
- Registro de pagos (completos, parciales, saldo total)
- Motor de cuotas: aplicación de pagos, detección de mora, recalculación
- Registro de visitas sin pago con motivo y promesa de pago
- Historial de cuotas por venta
- Capital: registro de inyecciones de dinero por ruta
- Gastos operativos con categorías
- Transferencias entre rutas
- Retiros de ganancias
- Motor de caja: cálculo dinámico de saldo por ruta y período
- Liquidación semanal por oficina con exportación CSV
- Reportes en tabla y exportación CSV compatible con Excel
- App móvil del cobrador (lista de ruta, cobro, no-pago, gastos, sync)
- Detección de conexión/desconexión con banner visual
- Cola offline: pagos y gastos quedan en estado "pendiente" sin conexión
- Sincronización simulada (visual)
- Captura de geolocalización al registrar pagos
- Generación de mensaje de WhatsApp prellenado
- Gestión de usuarios (crear, editar, activar/inactivar)
- Restaurar datos demo desde Configuración
- Exportar backup en JSON
- Datos demo completos: 1 empresa, 2 oficinas, 4 rutas, 20 clientes, 12 créditos activos

---

## 9. Funcionalidades pendientes para V2

Las siguientes características **no están en esta versión** pero están planeadas:

| Funcionalidad | Estado en V1 | V2 |
|---|---|---|
| Backend real | Los datos solo existen en el navegador | Supabase / PostgreSQL |
| Autenticación segura | Contraseñas en texto plano, sin encriptación | JWT + tokens seguros |
| Cambio de contraseña | No disponible | Disponible desde perfil |
| App Android nativa | PWA en navegador | App instalable en celular |
| WhatsApp Business API | Abre WhatsApp manualmente | Envío automático vía API |
| Reportes en PDF | Solo CSV/Excel | PDF con logo de la empresa |
| Mapa GPS de la ruta | Geolocalización solo se guarda | Mapa visual de recorrido |
| Sincronización real | Visual/simulada | Sincronización real con servidor |
| Multiempresa en producción | Demo de 1 empresa | Multiempresa real con aislamiento de datos |
| Permisos avanzados por rol | Ocultar menús | Control total por acción y módulo |
| Notificaciones push | No disponibles | Alertas de mora, pagos, etc. |
| Integración contable | No disponible | Conexión con sistemas de contabilidad |

---

## 10. Advertencias importantes para la demo

> Leer antes de compartir con el cliente.

**Esta versión es un prototipo funcional para validación.** No usar con datos reales de clientes o dinero real.

1. **Los datos viven en el navegador.** Si se limpia el caché o se cambia de computador, los datos desaparecen. Para recuperarlos, usar **Configuración → Restaurar datos demo**.

2. **No es una app en internet.** Debe ejecutarse localmente con `npm run dev`. No es accesible desde otro computador o celular a menos que se configure una red local.

3. **Las contraseñas no son seguras.** En V1, las contraseñas se guardan en texto plano. Nunca registrar contraseñas reales en esta versión.

4. **La sincronización offline es visual.** El botón "Sincronizar" cambia el estado de los pagos de "pendiente" a "sincronizado" pero no envía datos a ningún servidor real. En V2 esto será una sincronización real.

5. **Los datos demo son ficticios.** Los clientes, rutas y montos son inventados para ilustrar el flujo. No representan datos reales de ningún negocio.

6. **El objetivo de esta V1** es validar con el cliente:
   - ¿El flujo de trabajo tiene sentido?
   - ¿Los módulos cubren las necesidades del negocio?
   - ¿El diseño es suficientemente claro para cobradores y administradores?
   - ¿Qué debe ajustarse antes de desarrollar el backend real?

---

## 11. Inicio rápido — Resumen en 3 pasos

```
1. Abrir terminal y ejecutar:
   cd c:\TradingBot\CobrosApp
   npm run dev

2. Abrir en el navegador: http://localhost:3000

3. Ingresar con cualquiera de estos usuarios:
   admin@demo.com     / 123456  → Panel administrativo completo
   cobrador@demo.com  / 123456  → App móvil del cobrador
   supervisor@demo.com/ 123456  → Panel admin (sin Capital/Retiros/Usuarios)
   superadmin@demo.com/ 123456  → Panel de plataforma (gestión de empresas)
```

Para reiniciar los datos demo en cualquier momento:
**Admin → Configuración → Restaurar datos demo**

---

*RutaCash V1 — Documento de demo | Versión 1.0.0*
