# RutaCash — Cambios realizados según revisión

Este documento resume, en lenguaje de negocio, qué se cambió en RutaCash para
resolver las cinco solicitudes de la revisión.

---

## RQ-01 — Creación de rutas sin responsables obligatorios

**Qué se pidió**
Primero, que el Administrador dejara de ser obligatorio al crear una ruta. Después,
en una segunda revisión, que **tampoco el Cobrador** lo fuera: una ruta debe poder
crearse únicamente con sus datos básicos.

**Antes**
La ruta estaba condicionada a tener responsables obligatorios. En la primera
entrega se liberó el Administrador, pero el **Cobrador seguía siendo obligatorio**:
si no se elegía uno, el formulario no dejaba guardar y el servicio rechazaba la
creación. Además, una ruta que se quedara sin Cobrador se consideraba inválida y
no se permitía retirar al último Cobrador asignado.

**Ahora**
Una ruta puede crearse **sin Administrador y sin Cobrador**. Los cuatro casos son
válidos:

| Administrador | Cobrador | Crear ruta |
|---|---|---|
| ninguno | ninguno | permitido |
| ninguno | 1 | permitido |
| 1 o varios | ninguno | permitido |
| 1 o varios | 1 o más | permitido |

Una ruta admite **más de un Administrador**, y una empresa puede tener tantos como
necesite: ver el modelo de múltiples Administradores en
[IMPLEMENTACION_OFICINAS_2026-09.md](IMPLEMENTACION_OFICINAS_2026-09.md).

Crear una ruta requiere únicamente sus **datos básicos** (nombre y parámetros).
Administrador y Cobrador son **opcionales** y pueden asignarse en cualquier momento
posterior, desde el editor de la ruta o desde Gestión de usuarios.

**Advertencias, no bloqueos**
Si faltan responsables, el sistema **avisa pero no impide guardar**. El botón
"Crear" nunca se deshabilita, no se lanza ningún error y no hace falta crear
usuarios previamente:

- Sin Administrador: *"Esta ruta se creará sin Administrador asignado. Podrás
  asignarlo posteriormente."*
- Sin Cobrador: *"Esta ruta se creará sin Cobrador asignado. No tendrá operación de
  cobro hasta que se asigne uno."*
- Si faltan los dos, se muestran ambas advertencias juntas.

La ausencia de responsables se trata como **"ruta creada, pendiente de asignación"**,
nunca como "ruta inválida". Queda constancia en la auditoría del estado con el que
nació la ruta.

**Cómo se identifica una ruta sin Cobrador**
Se marca de forma explícita como **"Sin Cobrador asignado"** en la tarjeta de la
ruta y en el resumen de usuarios asignados. En el panel aparece como un **aviso**
(no como un error): la ruta existe y se gestiona con normalidad.

**Existir no es operar**
La regla es: **la ruta puede existir, pero la operación de cobro requiere Cobrador.**
Una ruta sin Cobrador no queda habilitada para cobrar; eso no impide crearla,
editarla, ni asignarle responsables después. En cuanto se le asigna un Cobrador,
queda operativa.

**Asignación posterior**
Asignar el Cobrador o los Administradores más tarde funciona igual que siempre, con la
misma fuente única de asignaciones. También se puede retirar al último Cobrador de
una ruta: la ruta queda "Sin Cobrador asignado" en vez de bloquear la operación. Lo
único que sigue pidiéndose es elegir un reemplazo cuando se retira al Cobrador
responsable **y quedan otros cobradores** en la ruta (para no adivinar quién
responde por el dinero).

**El Administrador que crea una ruta**
Cuando quien crea la ruta es un **Administrador**, queda asignado a ella de forma
automática. Es una **protección interna**, no una atadura del formulario: el acceso
de un Administrador depende de las rutas que tenga asignadas, así que si creara una
ruta y quedara fuera, perdería el acceso a la ruta que acaba de crear. El formulario
**no** le exige seleccionar Administrador. El **Super Admin** no se autoasigna:
puede crear la ruta sin asignarse ni asignar a nadie.

**Lo que NO cambió — scoping y permisos**
Permitir una ruta sin usuarios **no relaja ningún permiso**:

- Un Administrador **no asignado** no ve esa ruta ni sus clientes, ventas, caja o
  reportes (fail-closed intacto).
- Un Cobrador **no asignado** no puede operarla ni registrar pagos en ella.
- El **Super Admin** sí puede gestionarla y editarla.
- Se mantienen el aislamiento por empresa (tenant), `authorizedRouteIds` y el
  scoping por ruta.

Todo esto está cubierto por pruebas ejecutables (grupo **ROUTE-FREE**, que ejercita
el servicio real de creación de rutas, no una simulación).

---

## RQ-02 — Liquidación semanal por ruta

**Qué se pidió**
La pantalla de Liquidación Semanal permitía elegir fechas, pero no la ruta que se
quería liquidar.

**Qué se cambió**
- Se agregó un **selector de ruta**, y elegir una es **obligatorio**. No existe la
  opción "todas las rutas": una liquidación consolidada mezclaría cajas que son
  independientes entre sí.
- El selector solo muestra **las rutas a las que el usuario tiene acceso**.
- La pantalla ahora presenta la liquidación de **una sola ruta**, con su detalle
  completo: saldo anterior, capital, cobros, préstamos entregados, gastos,
  transferencias, retiros y saldo final.
- El **CSV** corresponde exclusivamente a esa ruta, incluye su nombre y código, y el
  nombre del archivo lleva el código de la ruta.

**Cómo funciona ahora**
Se elige la ruta y el rango de la semana, y se genera. Todas las cifras
corresponden únicamente a esa ruta: los movimientos de una ruta nunca entran en la
liquidación de otra, ni siquiera en el saldo anterior.

**Sobre la seguridad de los datos**
La comprobación de acceso no vive solo en la pantalla: también está en el motor de
cálculo. Si de alguna forma se solicitara la liquidación de una ruta ajena, el
sistema no devuelve cifras. Está cubierto con pruebas.

---

## RQ-03 — Reportes por ruta

**Qué se pidió**
El módulo de Reportes permitía escoger tipo de reporte y fechas, pero no indicaba
para qué ruta se generaba.

**Qué se cambió**
- Se agregó un **selector de ruta** con dos modos: una ruta específica o
  **"Todas las rutas"**.
- "Todas las rutas" significa **todas las rutas autorizadas para ese usuario**, no
  todas las de la empresa:
  - un Administrador con 3 rutas ve exactamente esas 3;
  - el Super Admin ve todas las de la empresa en la que está trabajando.
- El filtro se aplica a los cuatro reportes: **pagos, ventas, gastos y caja diaria**.
- El **CSV respeta exactamente el mismo filtro** que se ve en pantalla, conserva la
  columna Ruta e incluye la ruta en el nombre del archivo.

**Una corrección adicional en el reporte de pagos**
Cuando un abono se corrige, el sistema conserva el original, el asiento que lo anula
y el abono corregido — así debe ser, porque nada se borra. Pero el reporte los
mostraba como **tres movimientos**, uno de ellos en negativo. El total siempre fue
correcto; lo confuso era la lectura. Ahora el reporte muestra **solo el movimiento
vigente**, con el valor correcto.

**Un detalle documentado, no modificado**
El reporte de Ventas filtra por la fecha en que la venta se registró, mientras que
la Liquidación usa la fecha de arranque del crédito. Un mismo crédito puede quedar
en semanas distintas según el módulo. Se dejó como está a propósito, para no alterar
cifras históricas sin una decisión suya; queda anotado como punto a definir.

---

## RQ-04 — Historial de créditos del cliente

**Qué se pidió**
Poder buscar un cliente desde las áreas administrativas y ver cuántos créditos ha
tenido, el valor de cada uno, cuándo se creó y cuándo terminó.

**Qué se cambió**

**La búsqueda.** El módulo Secretario ya tenía buscador de clientes; ahora cada
cliente tiene un botón **"Historial"** que abre su historial de créditos. Lo mismo
en Clientes del Administrador y del Socio. Es **la misma pantalla en los tres
sitios**: antes cada módulo mostraba una versión distinta.

**Lo que muestra el historial:**
- cantidad de créditos que ha tenido el cliente;
- valor de cada crédito;
- fecha de creación;
- fecha estimada de fin;
- **fecha real de finalización**;
- estado: Activo, Finalizado, Perdido o Refinanciado;
- total prestado, total abonado y saldo pendiente.

**La fecha de finalización real: lo importante**
Esta fecha **no existía** en el sistema. Lo que había era la *fecha estimada de fin*,
que se calcula al crear el crédito y significa "cuándo debería terminar", no "cuándo
terminó". En una pantalla incluso aparecía rotulada simplemente como "Fin", lo que
se prestaba a confusión. Eso se corrigió.

Ahora el sistema **guarda la fecha real** en el momento en que el crédito se termina
de pagar, usando la fecha del abono que lo cerró. Una vez guardada **no se
reescribe**. La única excepción es que una corrección posterior reabra el crédito
(vuelva a tener saldo): en ese caso deja de estar finalizado y la fecha se retira,
porque mantenerla sería un dato falso; si vuelve a saldarse, se registra la nueva
fecha real.

**Para los créditos ya cerrados antes de este cambio**, el sistema hizo una
conversión: tomó la fecha del último abono válido de cada crédito. Si un crédito no
tiene ningún abono del que deducirla, **la fecha queda vacía** y se muestra "—".
**No se inventó ninguna fecha.**

**Créditos perdidos:** no muestran fecha de finalización. No hay un dato confiable
para ella y no se inventa.

**Créditos activos:** nunca aparecen como finalizados y su fecha real aparece "—".

**Clientes con el mismo nombre**
El historial se consulta siempre por el identificador interno del cliente, nunca por
el nombre. Dos clientes que se llamen igual —o incluso que compartan documento— no
mezclan sus historiales. Está verificado con pruebas.

**Permisos**
No hizo falta crear permisos nuevos: se usan los que ya existían para consultar
clientes y ver historial de ventas. Cada usuario ve únicamente clientes de sus rutas
autorizadas.

Esta vista **no se agregó a la aplicación del Cobrador**, tal como se indicó.

---

## RQ-05 — Caja del Cobrador

### ANTES

El Cobrador veía la información financiera completa de la ruta:

- el **capital inicial** de la ruta ("Base actual"),
- la **caja consolidada** de toda la ruta,
- el **capital disponible** exacto al crear una venta,
- y el **"Abonado hoy"** sumaba lo recaudado por **todos** los cobradores de la
  ruta, no solo lo suyo.

Si Fabio recaudaba $100.000 y su compañero $200.000 en la misma ruta, **ambos veían
$300.000**.

### AHORA

El Cobrador ve únicamente **su operación de caja**: el efectivo que está bajo su
responsabilidad y que debe entregar.

```
Recaudado por él        $500.000
Desembolsado por él    -$200.000
Sus gastos              -$20.000
──────────────────────────────────
Efectivo a entregar     $280.000
```

Con el ejemplo anterior: **Fabio ve $100.000 y su compañero ve $200.000**. Cada uno
cuadra lo suyo.

### El capital inicial ya no se muestra — ni se consulta

Este es un punto que se atendió a fondo. No bastaba con ocultar la tarjeta: el dato
se seguía calculando y quedaba disponible en el dispositivo. Ahora **el cálculo de
la caja del Cobrador ni siquiera consulta** el capital de la ruta, los movimientos
de capital, las transferencias ni los retiros. La información no se oculta: no se
pide.

Además, el permiso que daba al Cobrador acceso a la caja financiera de la ruta **se
le retiró**, y se creó uno nuevo para su caja personal. De modo que la restricción
está en tres capas: los permisos, el cálculo y la pantalla.

### Se distingue quién cobró de quién registró

Este era un problema de fondo del modelo. El sistema guardaba un solo dato: el
usuario que **digitaba** el abono. Si un Supervisor registraba un cobro que había
hecho Fabio, el dinero desaparecía de la caja de Fabio y aparecía en la del
Supervisor — un descuadre real de efectivo.

Ahora se guardan **dos datos distintos**:

- **quién recibió el dinero** (el cobrador responsable), y
- **quién registró la operación**.

Si Fabio cobra $100.000 y el Supervisor lo digita, **los $100.000 quedan en la caja
de Fabio**, y queda constancia de que fue el Supervisor quien lo registró.

Cuando quien registra no es cobrador, el sistema pregunta quién recibió el dinero:
- si la ruta tiene **un solo** cobrador, lo propone automáticamente;
- si tiene **varios**, **exige elegir**. No adivina, y nunca atribuye el dinero al
  Administrador o al Supervisor solo por haberlo escrito.

Lo mismo se aplicó a **desembolsos** (se registra qué cobrador entregó el dinero y
en qué fecha) y a **gastos** (a qué caja se cargan), para que el cuadre cierre.

Los datos históricos se conservan tal como estaban: no se reinterpretó ni se movió
dinero de una caja a otra.

### La validación de capital sigue protegida

Un Cobrador **sigue sin poder crear una venta por encima del capital disponible de
la ruta**. Esa regla no se tocó. Lo que cambió es que ya no se le muestra la cifra
del capital: si intenta una venta que lo supera, ve un mensaje claro —
*"La venta supera el capital disponible actualmente"*— en lugar del monto financiero
de la ruta. No quedó ningún error inexplicable.

### Lo que el Cobrador sigue viendo

Toda su información operativa: su cartera de trabajo, clientes, ventas, parcelas,
saldos, pendientes del día y desembolsos por confirmar. **Cartera no es capital**: la
cartera es lo que necesita para salir a cobrar y sigue disponible.

### El Administrador no perdió nada

Administrador, Supervisor, Socio y Super Admin conservan íntegras sus capacidades
financieras: caja de ruta, caja consolidada, liquidaciones y reportes, siempre
dentro de sus rutas autorizadas.

---

## Validaciones

| Concepto | Antes | Después |
|---|---|---|
| Pruebas automáticas | 353 | **678** |
| Resultado | PASS | **678 PASS · 0 FAIL** |
| Verificación de tipos (aplicación) | Sin errores | **Sin errores** |
| Verificación de tipos (pruebas) | Sin errores | **Sin errores** |
| Build de producción | OK | **OK** |

Detalle de las 678 pruebas:

- **349** de permisos, reglas de acceso, agrupación por oficina y modelo de
  múltiples Administradores
- **151** financieras (pagos, caja, liquidación, reportes, historial, caja del
  cobrador, registro de abonos de la App Cobrador)
- **155** de arranque, instalación, gestión de oficinas y administradores
- **23** de migración de base de datos y recorridos completos (smoke), ejecutadas
  sobre el motor real de la base, no simulado

Entre las pruebas nuevas se verifica que: una ruta puede crearse **sin
Administrador y sin Cobrador**; una ruta sin Cobrador se identifica como
pendiente de asignación y **no** rompe listados ni panel; se le pueden asignar
responsables después; un Administrador sin rutas sigue sin acceso; un Cobrador no
asignado no puede operar la ruta; el Super Admin sí puede gestionarla; la
liquidación de una ruta nunca incluye movimientos de otra; los reportes y sus CSV
respetan la ruta y los permisos; un crédito activo nunca aparece como finalizado;
un crédito perdido no inventa fecha; dos clientes con el mismo nombre no mezclan
historiales; dos cobradores de la misma ruta ven cada uno su propio efectivo; y el
Cobrador puede registrar abonos de extremo a extremo sobre datos CLEAN nuevos.

### Pruebas antiguas modificadas conscientemente

Ninguna prueba existente fue eliminada. Se modificaron **a propósito** las que
afirmaban reglas ya derogadas:

- La que exigía **Administrador** para crear una ruta.
- Las que exigían **al menos un Cobrador** para que la ruta fuera válida
  (`COB CASO 5`, `COB CASO 7` y `ONB-ROUTE-007`): cero cobradores es ahora un
  estado aceptado.
- La que impedía **retirar al último Cobrador** (`COB CASO 1`): el retiro está
  permitido y la ruta queda pendiente de asignación.

Cada una se reescribió para afirmar la regla vigente, no se borró.

---

## Hallazgos pendientes

Se detectaron durante el trabajo, **no forman parte de este paquete** y se dejan
documentados para tratarlos por separado.

### 1. Las liquidaciones semanales no se están guardando (prioridad alta)

La pantalla de Liquidación Semanal **calcula y muestra** la liquidación, pero no la
**archiva**. Esto tiene una consecuencia que conviene conocer:

El sistema tiene una regla de control según la cual, una vez cerrada una semana, el
Secretario no puede corregir directamente un pago de esa semana: debe pedir
autorización a un Administrador. Esa regla está implementada y probada, pero
**depende de que existan liquidaciones archivadas**. Como no se guarda ninguna, en
la práctica **la regla nunca se activa** y el Secretario puede corregir pagos de
cualquier semana sin solicitud de ajuste.

No se corrigió dentro de este paquete porque implica una decisión suya: definir qué
significa exactamente "cerrar una semana", quién la cierra y si se puede reabrir.
**Se recomienda tratarlo como el siguiente paquete.**

### 2. Fechas distintas para el mismo crédito según el módulo

Reportes usa la fecha de registro de la venta; la Liquidación usa la fecha de
arranque del crédito. Un mismo crédito puede caer en semanas distintas según dónde
se mire. Se conservó el comportamiento actual para no alterar cifras históricas.
Requiere decidir cuál de las dos es la fecha oficial.

### 3. Selectores de ruta duplicados

Existen varias pantallas antiguas (Caja, Gastos, Retiros, Capital) con su propio
selector de ruta. En esta entrega se creó **un selector compartido** y se usa en
Liquidación y Reportes. Unificar el resto es una limpieza pendiente, sin impacto
funcional.

### 4. Fecha de pérdida de un crédito

Un crédito marcado como perdido no guarda la fecha en que se dio por perdido. Por
eso el historial muestra "—" en su fecha de finalización. Si el negocio necesita esa
fecha, es un cambio aparte.

---

## Nota de mantenimiento

**15/09/2026 — La App Cobrador no podía registrar abonos.** Tras RQ-05, la
resolución del cobrador responsable leía la tabla `users` dentro de una transacción
que no la declaraba en su alcance; Dexie la rechazaba y todo abono terminaba en
«Error al registrar el pago». Corregido declarando la tabla, con diagnóstico
interno del error real y 13 pruebas de regresión. Detalle completo en
[FIX_REGISTRO_PAGOS_COBRADOR_2026-09-15.md](FIX_REGISTRO_PAGOS_COBRADOR_2026-09-15.md).

---

## Nota de mantenimiento — Oficinas

**Septiembre 2026 — Empresa → Oficina → Ruta.** Se introdujo la entidad Oficina
como agrupación de rutas. Los usuarios siguen siendo generales de la empresa y el
acceso sigue naciendo solo de las rutas autorizadas: pertenecer a una oficina no
concede ninguna ruta. Una ruta puede existir sin oficina, y las rutas que ya
existían quedaron todas "Sin Oficina". Detalle completo en
[IMPLEMENTACION_OFICINAS_2026-09.md](IMPLEMENTACION_OFICINAS_2026-09.md).
