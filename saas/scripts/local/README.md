# ADEX local · Prueba de «Base por Ruta» en tu navegador

Este entorno levanta **ADEX completo en tu propio equipo** (base de datos, servidor y la misma pantalla de ADEX Online que se publica), con **cuatro empresas inventadas** listas para probar el nuevo sistema de Base por Ruta.

> **Dónde está cada cosa.** Los scripts están versionados en `saas/scripts/local/` (revisados: sin secretos ni datos reales; la única contraseña es la sintética `adex-local-2026`). Todo lo que generan —datos de PostgreSQL, `state.json` con las claves locales de cada instancia, registros, build y capturas— va a `tmp/local/` (ignorada por Git), nunca a la carpeta versionada. Las copias originales de R74 siguen en `tmp/r74/local/` y `tmp/r74/e2e/`.

- Todo es **local y sintético**: no se conecta a Supabase, Render, Vercel ni a BlueLine. Ningún dato real; todos los correos terminan en `@example.test`.
- Los datos **se conservan** entre un arranque y otro (puedes cerrar y seguir mañana). Si quieres empezar de cero, usa `--reset`.
- El **panel Owner** (`/owner`) queda **fuera** de este entorno.

---

## 1. Antes de empezar (solo la primera vez)

1. **Node 24.** En la terminal integrada de VS Code (PowerShell):
   ```powershell
   node --version
   ```
   Debe decir `v24.x`.
2. **Google Chrome** instalado.
3. Las dependencias ya están instaladas en este equipo. Si alguna vez falta algo:
   ```powershell
   cd C:\HRWorkSpace\01_PRODUCTOS_COMERCIALES\RutaCash\saas
   npm install
   cd ..\online
   npm install
   ```

## 2. Arrancar, detener y empezar de cero

**Arrancar** (terminal integrada de VS Code, PowerShell):
```powershell
cd C:\HRWorkSpace\01_PRODUCTOS_COMERCIALES\RutaCash\saas
npm run local:start -- --reset
```
**La primera vez usa `--reset`** (los datos guardados de una prueba anterior son de antes de la conciliación). Las siguientes veces, sin `--reset`, para conservar lo que hayas hecho.
La primera vez tarda 1–2 minutos (crea la base, siembra los datos y prepara la pantalla). Cuando veas el cuadro **«ADEX local listo»**, abre en Chrome:

> **http://127.0.0.1:5600**

**Detener:** en esa misma terminal pulsa **Ctrl+C** (o escribe `stop` y Enter). Se cierran la pantalla, el servidor y la base de datos en orden.

**Empezar de cero** (borra los datos de prueba y los vuelve a crear, con fecha de hoy):
```powershell
npm run local:start -- --reset
```
Las opciones van después de `--` (así `npm` se las pasa al script). Sin `npm`: `node --import ./scripts/register-alias.mjs scripts/local/start-local.mjs --reset`.

Otras opciones (se pueden combinar):

| Opción | Para qué |
|---|---|
| `--reset` | Base nueva con los datos de prueba recién sembrados. Úsala si pasaron días (los datos de «hoy» quedan como de días anteriores) o si algo quedó raro |
| `--build` | Vuelve a preparar la pantalla aunque no detecte cambios (normalmente lo hace solo cuando el código cambió) |
| `--head` | Usa el **último commit** en lugar de los archivos en edición. Úsala si al arrancar aparece un error de una migración «en preparación» o la pantalla no se puede preparar porque hay trabajo a medio hacer |
| `--check` | Arranca todo, muestra el cuadro y se detiene (comprobación rápida) |
| `--instance X --port-base N` | Instancia aparte con sus propios datos (`tmp/local/X/`) y puertos N, N+1, N+2. La usan la prueba de humo y el E2E; nunca tocan la instancia `main` |

Puertos usados: **5600** (pantalla), **5601** (servidor de ADEX), **5602** (base de datos). Todo queda dentro de `tmp/local/` (datos en `main/pgdata/`, estado en `main/state.json`, registros en `logs/`, build en `dist/`).

## 3. Perfiles de prueba

**Contraseña de todos los perfiles: `adex-local-2026`**

| Empresa | Modelo | Perfil | Correo | Qué probar primero |
|---|---|---|---|---|
| Cobros Sintéticos Norte | **Base por Ruta** (activada) | SuperAdmin | `sa.norte@example.test` | Panel de rutas (solo lectura) y Modelo de capital |
| Cobros Sintéticos Norte | Base por Ruta | Administrador (Ruta Centro 1 y Centro 2) | `admin1.norte@example.test` | Caja principal y Transferencias |
| Cobros Sintéticos Norte | Base por Ruta | Administrador (Ruta Oeste 1 y Oeste 2) | `admin2.norte@example.test` | Aviso de transferencia recibida; cuadre con sobrante |
| Norte **y** Sur | — | Supervisor en las dos empresas | `supervisor.norte@example.test` | El **selector de empresa/perfil** al entrar |
| Cobros Sintéticos Norte | Base por Ruta | Cobrador (Ruta Centro 1) | `cobrador1.norte@example.test` | Devolución pendiente; venta aprobada por desembolsar |
| Cobros Sintéticos Norte | Base por Ruta | Cobrador (Ruta Oeste 1) | `cobrador2.norte@example.test` | Cobrar y solicitar una venta |
| Cobros Sintéticos Norte | Base por Ruta | Secretario (las 4 rutas) | `secretario.norte@example.test` | Transferencias = solo historial; aprobar una solicitud |
| Préstamos Sintéticos Sur | **Modelo actual** (bolsas) | SuperAdmin | `sa.sur@example.test` | «Capital» como siempre |
| Préstamos Sintéticos Sur | Modelo actual | Administrador (Ruta Sur 1 y Sur 2) | `admin.sur@example.test` | Bolsa y Transferencias de siempre |
| Préstamos Sintéticos Sur | Modelo actual | Cobrador (Ruta Sur 1) | `cobrador.sur@example.test` | Cobrar como siempre |
| Préstamos Sintéticos Sur | Modelo actual | Secretario | `secretario.sur@example.test` | Transferencias del modelo actual |
| Empresa Vacía Sintética | **Sin activar**, todo en cero | SuperAdmin | `sa.vacia@example.test` | Modelo de capital → **activar Base por Ruta** tú mismo |
| Empresa Vacía Sintética | Sin activar | Administrador (Ruta Vacía 1) | `admin.vacia@example.test` | Después de activar: inyectar Base |
| Transición Sintética | **Modelo actual con saldos y custodia** | SuperAdmin | `sa.transicion@example.test` | Modelo de capital → **Migrando → activar** (transición con custodias) |
| Transición Sintética | Modelo actual | Administrador (Transición 1 y 2) | `admin.transicion@example.test` | Después de activar: repartir el saldo sin asignar |
| Transición Sintética | Modelo actual | Cobrador (Transición 1) | `cobrador.transicion@example.test` | Su efectivo en mano no cambia con la transición |

**Consejos para probar varios perfiles a la vez**

- Cada persona tiene **una sola sesión activa** (regla real de ADEX): si entras con el mismo correo en otro navegador, la sesión anterior se cierra.
- En una misma ventana de Chrome, todas las pestañas comparten la sesión. Para tener dos perfiles a la vez abre una **ventana de incógnito** (Ctrl+Shift+N) para el segundo, o usa `http://localhost:5600` en una ventana y `http://127.0.0.1:5600` en otra.
- Si creas un usuario nuevo desde la pantalla «Usuarios», puede entrar directamente con la misma contraseña `adex-local-2026` (el enlace de primer acceso también funciona en este entorno).

## 4. Qué datos encontrarás

**Cobros Sintéticos Norte (Base por Ruta)** — 2 oficinas (Centro y Oeste), 4 rutas. Se activó por el camino real: la empresa tenía bolsas, el SuperAdmin dejó la cuenta de la empresa en cero, comprobó los requisitos y activó con evidencia y una referencia de respaldo sintética. Después:

- Cada Administrador **repartió** parte de su saldo anterior «sin asignar» a sus rutas y **todavía le queda** algo para que lo pruebes (Admin Uno ≈ R$ 4.000; Admin Dos ≈ R$ 3.000). Hubo **inyecciones** de Base en Centro 1 y Oeste 1.
- **Entregas** de Base a los dos Cobradores; **7 ventas** desembolsadas (4 por solicitud del Cobrador, 3 directas del Administrador desde la Base) y cobros.
- **«Cliente Sintético Centro C (pagos anulados)»**: venta con dos pagos anulados (para corregir la venta y reaplicar pagos). **«Cliente Sintético Centro A»**: venta con pagos vigentes. Un pago anulado en «Oeste A».
- Gastos de ruta (Centro 1, Oeste 2) y un gasto del Cobrador Uno.
- Gastos generales: **A** (Admin Uno, con aportes de Centro 1 y Centro 2), **C1** (contador, aportes de rutas de cada Admin), **C2** con dinero propio (Admin Uno R$ 250, de los que ya se reembolsó R$ 100 a sí mismo desde Centro 2 → **quedan R$ 150 pendientes**; Admin Dos R$ 80 pendientes).
- Transferencias: Centro 1 → Centro 2 (mismo responsable) y Centro 2 → **Oeste 1 (otro responsable)**; un retiro de Base en Oeste 2.
- Cuadres: **Cobrador Uno con faltante de R$ 30** y **Cobrador Dos con sobrante de R$ 20** (retenido en control).
- Pendientes: **solicitud de devolución** de R$ 200 al Cobrador Uno; una **solicitud de venta por aprobar** («Oeste B») y una **aprobada sin desembolsar** («Centro E»).

**Préstamos Sintéticos Sur (modelo actual)** — 1 oficina, 2 rutas, bolsa del Administrador, 3 ventas, cobros, un gasto, un cuadre exacto y un gasto C2 con reembolso parcial desde la bolsa.

**Empresa Vacía Sintética** — 1 oficina, 1 ruta, su Administrador y **todo en cero**, sin activar.

**Transición Sintética (modelo actual, para probar la transición)** — 1 oficina, 2 rutas. Bolsa del Administrador ≈ R$ 20.550, **Cobrador con efectivo en mano** (≈ R$ 3.100), 2 ventas con cobros y la cuenta de empresa **en cero**. Sirve para recorrer la transición completa con custodias distintas de cero (ver 5.11).

## 5. Recorrido guiado

Marca cada punto cuando lo hayas probado. Todo lo de esta lista se puede hacer desde el navegador.

### 5.1 SuperAdmin de Norte (`sa.norte@example.test`)
- [ ] **Caja principal** → ahora se llama **«Panel de rutas»**: es de **solo lectura**. Ves el resumen global, «Rutas que requieren atención» y cada ruta con sus estados. No hay botón de Transferencias ni «Realizar movimientos».
- [ ] Abre el **Detalle** de una ruta: Base, custodias, movimientos del periodo.
- [ ] **Cambiar responsable** de una ruta (acto estructural): la ruta queda «en entrega» y el nuevo Administrador debe **confirmar el conteo** (puede registrar un faltante/sobrante con nota). La Base no se mueve.
- [ ] **Modelo de capital**: muestra «Base por Ruta» y ya no ofrece formulario (la activación es irreversible).
- [ ] Intenta registrar cualquier movimiento de dinero: no debe ser posible para el SuperAdmin.

### 5.2 Activar la Empresa Vacía (`sa.vacia@example.test`)
- [ ] **Caja principal → Modelo de capital**: la lista de **requisitos** debe salir toda en verde («Todos cumplidos»).
- [ ] Lee las advertencias (irreversible; el SuperAdmin deja de mover dinero).
- [ ] Escribe la **evidencia** de tu autorización, una **referencia de respaldo** (inventada, por ejemplo `respaldo-prueba-1`) y **ACTIVAR**. Pulsa activar: aparece «Base por Ruta activada».
- [ ] Entra como `admin.vacia@example.test` → **Transferencias → Inyección de Base** en «Ruta Vacía 1» y mira cómo aparece en la Caja principal.

### 5.3 Administrador Norte Uno (`admin1.norte@example.test`)

**Caja principal**
- [ ] Consolidado: **Base disponible + Efectivo en custodias = Efectivo de las rutas**. La cartera aparece aparte («no es efectivo»).
- [ ] Ruta Centro 1 muestra **«Resultado operativo negativo»** y **«Faltante arrastrado»**; Ruta Centro 2 muestra **«Flujo negativo por crecimiento de cartera»** (una venta no es pérdida).
- [ ] El resultado operativo dice «No es utilidad contable ni dinero retirable».
- [ ] Toca la cifra de Base de una ruta: se abre el detalle (inyecciones, entregas, devoluciones, transferencias, retiros, saldo final) con enlaces a Consultas.
- [ ] Recuadro **«Saldo sin asignar»** (≈ R$ 4.000) con el botón «Repartir a una ruta».

**Transferencias** (cada acción explica de dónde sale, a dónde llega, quién registra, quién responde y qué saldo cambia)
- [ ] **Inyección de Base** (ej. R$ 1.000 en Centro 2).
- [ ] **Retiro de Base** (prueba también un valor mayor que la Base: debe impedirlo).
- [ ] **Entrega de Base a Cobrador** (Cobrador Norte Uno, Centro 1).
- [ ] **Recepción de devolución de Cobrador** (Cobrador Norte Uno).
- [ ] **Transferencia entre rutas propias**: Centro 1 → Centro 2.
- [ ] **Transferencia hacia otro responsable**: Centro 2 → Oeste 1 (el Admin Dos recibe un aviso).
- [ ] **Reparto de saldo sin asignar** a una de tus rutas (pide evidencia y confirmación).
- [ ] **Historial y comprobantes**.

**Ventas, desembolsos y recaudo**
- [ ] **Autorizaciones**: aprueba o rechaza solicitudes de tus rutas.
- [ ] **Venta directa** en Centro 2 (sale de la Base de esa ruta; si supera la Base, se rechaza).
- [ ] **Cobro** en una venta de Centro 2 (ruta sin Cobrador): el dinero entra a la Base de la ruta.

**Gastos**
- [ ] **Gasto de ruta** en Centro 1: se paga con la Base de esa ruta.
- [ ] **Caja principal → «Gastos generales y reembolsos» → pestaña «Gastos generales» → Registrar.** Elige por separado el **alcance** (general del Administrador o de empresa) y la **fuente**:
  - **Aportes de rutas (A / C1):** solo aparecen **tus** rutas, cada una con su Base disponible. Reparte el importe; el contador dice «Faltan / Sobran / Cuadra» y «Registrar» se apaga si un aporte supera la Base de esa ruta.
  - **Dinero propio (C2):** no mueve efectivo; crea un **saldo a favor** tuyo («Reembolsos pendientes a Administradores · no es efectivo»).
- [ ] Pestaña **«Reembolsos pendientes»** → reembolsa tu saldo a favor **parcial o total** con aportes de tus rutas (reembolso propio, RB-D8). Un segundo reembolso sobre lo ya pagado se rechaza.
- [ ] **Anular** un gasto general o un reembolso (con motivo). Si las rutas aportantes son de distintos Administradores, la pantalla explica qué ruta es de quién y no anula a medias (RB-D7).
- [ ] Como `admin2.norte`: intenta un aporte desde una ruta del Admin Uno: no aparece en la lista (y el servidor lo rechaza).
- [ ] Menú **Gastos**: el total de cabecera indica que **no incluye** los gastos generales (se listan aparte).

**Corrección de ventas con pagos (R74)**
- [ ] **Ventas Activas → «Cliente Sintético Centro C (pagos anulados)» → Corregir venta**: el diálogo muestra el diagnóstico del servidor (0 vigentes, 2 anulados) y deja corregir la tasa o el valor.
- [ ] En esa misma venta, **reaplicar** un pago anulado (si el pago sí se recibió).
- [ ] **«Cliente Sintético Centro A»**: corregir una venta con pagos **vigentes** (el servidor recalcula y avisa de bloqueos, por ejemplo sobrepago).

**Cuadres y diferencias**
- [ ] **Liquidación / cuadres**: verás el cuadre del Cobrador Uno con **faltante de R$ 30** (queda como «faltante arrastrado», no gastable).
- [ ] **Menú «Diferencias»** (grupo Control; también desde el aviso «Diferencias por conciliar» de la Caja principal). Abre el faltante de Centro 1 → elige **«Reconocer como faltante de la ruta»** o **«El trabajador repone»** (este último no mueve dinero) → mira la vista previa (esperado, contado, diferencia, qué se mueve) → escribe un motivo (mín. 10 caracteres) → Confirmar. **Sin aprobación de nadie.**
- [ ] Después: el aviso desaparece, la ruta sigue operando (haz una entrega o un cobro) y **Consultas** muestra «Conciliación de diferencia». Abajo queda el historial con comprobante.
- [ ] Como `sa.norte` o el Supervisor: la misma pantalla en **solo lectura** (sin botones de resolver).

**Consultas**
- [ ] **Consultas** con perspectiva de una ruta: incluye su Base; las operaciones de Base muestran origen y destino legibles.

### 5.4 Administrador Norte Dos (`admin2.norte@example.test`)
- [ ] **Notificaciones**: «Transferencia de Base recibida» (desde Centro 2).
- [ ] Caja principal: Oeste 1 con el **sobrante de R$ 20** del Cobrador Dos retenido en control; Oeste 2 con el retiro de Base.
- [ ] Intenta mover la Base de una ruta del Admin Uno: no debe permitirlo (una ruta no consume la Base de otra).
- [ ] **Diferencias** → el sobrante de Oeste 1 → **«Incorporar el sobrante a la Base de la ruta»** o **«Devolver el sobrante a su dueño»** (sale del control; no es ingreso).

### 5.5 Cobrador Norte Uno (`cobrador1.norte@example.test`)
- [ ] Panel del Cobrador: su ruta, su efectivo en mano y el faltante arrastrado.
- [ ] **Solicitud de devolución pendiente** de R$ 200: entrega el dinero (la devolución mueve el dinero una sola vez; la solicitud por sí sola no mueve nada).
- [ ] **Desembolsar** la venta aprobada «Cliente Sintético Centro E» (sale de su efectivo en mano).
- [ ] **Cobrar** una cuota y registrar un **gasto propio**.
- [ ] **Sin conexión**: en Chrome pulsa F12 → pestaña *Network* → *Offline*. Sin conexión puede **cobrar** y **desembolsar ventas ya aprobadas**; **no** puede crear clientes ni ventas nuevas. Vuelve a *No throttling* y la cola se sincroniza.

### 5.6 Cobrador Norte Dos (`cobrador2.norte@example.test`)
- [ ] Cobrar en «Cliente Sintético Oeste A» y **solicitar una venta nueva** (queda para aprobación).

### 5.7 Secretario Norte (`secretario.norte@example.test`)
- [ ] **Transferencias**: con Base por Ruta es **solo historial** (explica que no hay transferencias entre Administradores y no ofrece «Registrar»).
- [ ] **Autorizaciones**: aprueba la solicitud «Cliente Sintético Oeste B (pendiente de aprobar)».

### 5.8 Supervisor (`supervisor.norte@example.test`)
- [ ] Al entrar aparece el **selector**: «Cobros Sintéticos Norte» y «Préstamos Sintéticos Sur». Cambia de empresa con «Cambiar empresa o rol».
- [ ] En **Norte**, «Selecciona tu ruta»: cada tarjeta muestra **«Base disponible»** (la Base real de la ruta, igual que en la Caja principal) y, aparte, **«Efectivo en custodias»** (en manos de trabajadores). No se suman una dentro de la otra.
- [ ] En **Sur** (modelo actual), la misma tarjeta dice **«Efectivo en custodias»**: en ese modelo la ruta no tiene Base propia.

### 5.9 Empresa Sur sin cambios (modelo actual)
- [ ] `admin.sur@example.test` → **Caja principal** muestra la **bolsa** de siempre; **Transferencias** muestra «Nueva operación» con el catálogo anterior (devolver al SuperAdmin, pedir capital…).
- [ ] `sa.sur@example.test` → «Capital de la empresa» y «Realizar movimientos» como antes; el menú sigue diciendo «Capital».
- [ ] Nada de «Base por Ruta» debe aparecer en esta empresa.

### 5.10 Desactivar un Administrador con cuentas pendientes
- [ ] Como `sa.norte`: **Usuarios → Administrador Norte Dos → Desactivar.** Aparece «No se puede desactivar: tiene cuentas pendientes» con la lista. Cómo despejar cada punto **desde la pantalla**:
  - *Saldo sin asignar* → Admin Dos: Transferencias → **Reparto de saldo sin asignar** a una de sus rutas.
  - *Reembolso pendiente* → Admin Dos: Caja principal → Gastos generales y reembolsos → **Reembolsos pendientes** → reembolsar.
  - *Diferencias sin conciliar* → Admin Dos: **Diferencias** → conciliar.
  - *Responsable de rutas* → SA: **Usuarios → Administrador Norte Uno** → añadirle Oeste 1 y Oeste 2; luego **Panel de rutas → Detalle → «Cambiar responsable»** para cada ruta del Admin Dos.
  - *Entrega pendiente* → Admin Uno: confirma el **conteo** desde el aviso de entrega de su Caja principal.
- [ ] Vuelve a **Desactivar**: ahora queda «Usuario inactivo».

### 5.11 Transición con custodias (`sa.transicion@example.test`, luego `admin.transicion@example.test`)
- [ ] Antes de empezar, anota la bolsa del Administrador y el efectivo en mano del Cobrador (Caja principal / Cuadre).
- [ ] **Caja principal → Modelo de capital**: el requisito «activación directa o Migrando» sale en rojo (hay saldos): «Activar» queda deshabilitado.
- [ ] **Congelar bolsas** (Migrando) con evidencia: no se mueve dinero.
- [ ] **Activar Base por Ruta** con evidencia y referencia de respaldo.
- [ ] Como `admin.transicion`: aparece el **Saldo sin asignar** = la bolsa anterior. **Transferencias → Reparto de saldo sin asignar** entre Transición 1 y 2 hasta dejarlo en cero.
- [ ] Comprueba: Base disponible + Efectivo en custodias + sin asignar = bolsa + custodia de antes; el efectivo del Cobrador no cambió; no aparece ningún ingreso nuevo.

## 6. Si algo no va bien

| Lo que ves | Qué hacer |
|---|---|
| «migration … failed» o «changed after being applied» | Otro trabajo está cambiando las migraciones. Arranca con `--head` (último commit) o, si dice «changed», añade `--reset` |
| «El build de ADEX Online falló» | Arranca con `--head` |
| «No se pudo abrir el puerto 5600/5601» | Ya hay otro entorno abierto: ciérralo (Ctrl+C en su terminal) |
| La pantalla te saca a «Iniciar sesión» | Entraste con el mismo correo en otra ventana (sesión única), o reiniciaste el entorno: vuelve a entrar |
| Datos de «Hoy» vacíos | Los datos se sembraron otro día: usa `--reset` |

Registros de cada arranque: `tmp/local/logs/` (`main-*.log`, `postgres-main.log`, `build-*.log`).

---

## 7. Para el equipo técnico

- `start-local.mjs`: PostgreSQL de `embedded-postgres` gestionado con `pg_ctl` (persistente en `tmp/local/<instancia>/pgdata`, parada `-m fast`), migraciones 0001–última de `saas/db/migrations` (avisa de las que no tienen commit), API de empresa real (`createCompanyHandler`), emisor ES256 local con clave persistida en `state.json` y endpoints con forma de Supabase (`/auth/v1/token`, `verify`, `user`, `logout`), build de producción de `online/` con la URL de la API sustituida al servir (un solo build para cualquier puerto).
- `seed.mjs`: siembra por la API real (API Owner para las empresas; API de empresa para todo lo demás). Única escritura SQL directa: el operador Owner sintético (`owner.local@example.test`), que no puede iniciar sesión aquí.
- `smoke-local.mjs`: instancia aparte (`--instance smoke`, puertos 5610–5612, datos en `tmp/local/smoke/`; se pueden cambiar con `--instance X --port-base N`), entra con cada perfil por la API, recorre pantallas clave en Chrome headless (incluida la activación de la Empresa Vacía) y comprueba la parada limpia. Resultados en `tmp/local/logs/smoke-*-results.json`, capturas en `tmp/local/<instancia>/shots/`:
  ```powershell
  cd C:\HRWorkSpace\01_PRODUCTOS_COMERCIALES\RutaCash\saas
  npm run local:smoke
  npm run local:smoke -- --head
  ```
- `e2e-routebase.mjs`: E2E completo de Base por Ruta en Chrome (instancia `e2e`, puertos 5620–5622). Por el límite de tiempo de los procesos se ejecuta por partes; la parte 2 continúa sobre los datos de la parte 1 y la 3 empieza de cero:
  ```powershell
  npm run e2e:routebase -- --part 1
  npm run e2e:routebase -- --part 2
  npm run e2e:routebase -- --part 3
  ```
  Parte 1: bloques A–E (Base, transferencias, gastos generales, diferencias). Parte 2: F–Z (desactivación, offline, activación y transición de Sur, aislamiento, concurrencia, libro). Parte 3: transición de «Transición Sintética» con custodias ≠ 0, «Devolver el sobrante a su dueño» desde Diferencias e indicador del Supervisor en «Selecciona tu ruta». Salida en `tmp/local/e2e-routebase/` (o `--out tmp/...`). Chrome se toma de `C:/Program Files/Google/Chrome/Application/chrome.exe` o de la variable `CHROME_PATH`.
- Comprobación rápida del arranque en una instancia desechable: `npm run local:start -- --check --reset --instance prueba --port-base 5640`.
