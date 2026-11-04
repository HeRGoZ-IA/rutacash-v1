# ADEX · Diseño: migración de rutas con historial (estado «en migración» por ruta)

**Fecha:** 2026-11-04 · **Estado:** diseño aprobado para escribirse en detalle; **sin código ni migración de base de datos**.
**Primera ruta:** VALPARAISO SOC GAJ (Listos, oficina 20) → BlueLine, oficina Aguas Lindas, Administrador Andrew.
**Decide:** DS-06 (pendientes 2.2.1) con la opción A (saldos de apertura; la historia larga queda en Listos).

Este documento no contiene datos personales. Las cifras son agregadas.

---

## 1. Decisiones de Helmer (2026-11-04)

| # | Decisión |
|---|---|
| M1 | La ruta entra a **BlueLine**, en la oficina **Aguas Lindas**. |
| M2 | El Administrador responsable es **Andrew**; él asigna el cobrador. |
| M3 | El estado de migración es **por ruta**, no por empresa. El resto de BlueLine sigue normal. |
| M4 | Mientras dure la migración, Helmer entrega **reportes diarios** de Listos de esa ruta. |
| M5 | Al terminar, la ruta pasa a estado **normal** y funciona como cualquier otra. |
| M6 | Los abonos individuales de Listos son **opcionales**: manda el saldo. |

## 2. Idea central

Durante la migración **la ruta sigue operando en Listos** (allí se cobra, se presta y se cuadra la caja).
ADEX es un **espejo de la cartera**: clientes, créditos, cuotas y saldos, actualizado con cada reporte diario.

- En ADEX **no se mueve dinero** de esa ruta mientras está en migración: ni caja, ni Base, ni cuadres, ni cierres.
  Si se cobrara en los dos sistemas, el dinero se contaría dos veces.
- La **baja de saldo** de un crédito entre dos reportes es el **recaudo de ese crédito** en ese periodo.
  Se registra para que la historia de la ruta en ADEX sea continua, pero sin pasar por ninguna caja.
- El día del **paso a normal** se cuenta la caja (Base y efectivo del cobrador), se abre en ADEX y
  desde el día siguiente se cobra solo en ADEX.

```
   normal ──(abrir migración)──► en_migracion ──(paso a normal con conteo de caja)──► normal
                                   │   ▲
                                   └───┘  reporte diario: créditos nuevos, saldos, finalizados
```

## 3. Estado de la ruta

- Nueva columna `routes.migration_state`: `'normal'` | `'en_migracion'`. Sigue el mismo patrón que
  `routes.handover_state` (`'normal'` | `'en_entrega'`, migración 0034).
- Una ruta no puede estar `en_migracion` y `en_entrega` a la vez.
- Abrir la migración solo es posible en una ruta **nueva y vacía** (sin ventas, cobros, Base ni movimientos).
  Así la migración no mezcla datos de ADEX con datos de Listos.
- Lo abre y lo cierra el **Owner o el SuperAdmin** de la empresa (Helmer). Andrew lo ve, no lo cambia.

### Qué se bloquea en una ruta `en_migracion`

| Acción | En migración |
|---|---|
| Ver clientes, créditos, cuotas, saldos, mapa, reportes de cartera | **Permitido** (solo lectura) |
| Crear cliente, solicitud de venta, venta o desembolso | Bloqueado («La ruta está en migración») |
| Registrar abono, corrección o anulación | Bloqueado |
| Base: inyección, retiro, traspaso; entregas al trabajador; gastos | Bloqueado |
| Cuadres, liquidaciones y cierres semanales | Bloqueado; la ruta **no cuenta** en los cuadres de la oficina |
| Asignar o cambiar el cobrador (Andrew) | **Permitido**: así el cobrador ya conoce su cartera antes del paso |
| Modo sin conexión del Cobrador | No descarga rutas en migración |

El bloqueo va en la base de datos (triggers y funciones), no solo en la pantalla, igual que el resto de
las reglas de ADEX.

## 4. Datos de entrada (reportes de Listos)

Cada entrega trae **dos** archivos de la misma ruta, exportados el mismo día al cerrar la jornada:

1. **«ReporteExcelCreditos completo»**: rango de fechas que cubra **todos los créditos con saldo**. Para
   la carga inicial, desde el primer crédito de la ruta. Para los diarios, basta un rango que incluya los
   créditos del día y los activos (ver §6.4).
2. **«ReporteExcelClientesActivos»**: sirve de **control** (saldo por cliente).

Validaciones de forma, antes de leer un solo crédito:
- Encabezado en la fila 8 con las 39 (créditos) o 19 (clientes) columnas conocidas, en ese orden.
- Fila 7: `Ruta: VALPARAISO SOC GAJ` (u `OFICINA: OFICINA 20`); otra ruta → rechazo.
- Montos enteros ≥ 0; fechas válidas; `CÓDIGO CRÉDITO` único dentro de la entrega
  (los repetidos idénticos de los bordes de rango se unen; si difieren, se usa el de la exportación más reciente).

## 5. Carga inicial (apertura de la migración)

### 5.1 Clientes

- Se cargan los **123** clientes de la ruta: los 41 con crédito activo como `activo` y los 82 sin
  crédito activo como `inactivo`. Así, si un cliente antiguo renueva durante la migración, ya existe.
- Campos: nombre, documento, celular (y adicional), dirección, barrio en la dirección.
- Se guarda el **código de cliente de Listos** para emparejar en los reportes diarios (nunca por nombre).
- No se cargan: fecha de nacimiento (es relleno), correo, banco ni coordenadas (440 de 500 están en el
  mismo punto, que no es la casa del cliente). La ubicación se toma en campo con el mapa de ADEX.
- Documento igual al código de cliente (2 casos): se carga y queda marcado para corregir.

### 5.2 Créditos activos → ventas

Cada crédito `ACTIVO` se convierte en una venta de ADEX:

| Listos | ADEX |
|---|---|
| VALOR CRÉDITO | `sale_value_minor` (capital) |
| % INTERÉS (0,20) | `interest_rate` (20 %). Hoy los 41 activos están al 20 %. |
| TOTAL CRÉDITO | `total_value_minor` |
| SALDO | `balance_minor` |
| CUOTAS PACTADAS / VALOR CUOTA | `installments_count` / `installment_value_minor` |
| FORMA PAGO + DÍA DE COBRO | `payment_frequency` + `payment_days` (ver §9, pregunta P2) |
| FECHA (= FECHA DESEMBOLSO) | `start_date` y `disbursement_date` |
| ESTADO ACTIVO | `status = 'activa'`, `disbursement_status = 'desembolsado'` |
| CÓDIGO CRÉDITO | se guarda como código de Listos (para emparejar) |

Activos hoy: 35 diarios, 4 semanales, 1 mensual y 1 diario con día fijo (dato raro de Listos, se revisa a mano).

**Cuotas.** Se genera el calendario completo desde `start_date` según la frecuencia. Lo ya pagado
(`TOTAL − SALDO`) se reparte desde la primera cuota: las primeras quedan `pagada`, la siguiente `parcial`
si hay resto, las demás `pendiente`/`vencida` según la fecha. Esto reproduce exactamente el saldo de Listos.

**Mora.** La mora de ADEX sale del calendario. Puede diferir un poco de «CUOTAS ATRASADAS» de Listos
(Listos y ADEX pueden contar distinto domingos y festivos). Se guarda el dato de Listos como referencia y el
informe de carga muestra las diferencias. **No** se usa «DÍAS VENCIDOS»: en Listos son días desde el final
del plan, no mora real.

**Créditos muy vencidos** (11 con más de 90 días): entran como `activa` y así quedan; ADEX no castiga
(P5). Lo importante es que el retraso se vea claro.

**Cambios técnicos necesarios:**
- El trigger de la migración 0010 rechaza `start_date` anterior a hoy. Se permite solo para ventas con
  origen `migracion`.
- Estas ventas no nacen de una solicitud ni de un desembolso en caja (no tocan Base ni custodia).

### 5.3 Créditos pagados (852)

No se crean como ventas: eso exigiría inventar sus abonos y su contabilidad. Se guardan en una tabla de
**historial de Listos** de solo lectura (código, fechas, montos, estado), visible en la ficha del cliente
como «Historial anterior (Listos): N créditos pagados». Sirve para la decisión de crédito sin mezclarse con
el dinero de ADEX.

### 5.4 Contabilidad de la apertura

Nueva operación **`MIGRATION_OPENING`** por crédito (o una por carga, con detalle por crédito):

| Cuenta | Movimiento |
|---|---|
| Cartera de la ruta (`portfolio`) | + capital pendiente |
| Financiación de la ruta (`route_funding`) | − capital pendiente |

- **Capital pendiente** = `round(SALDO × VALOR / TOTAL)`, la misma proporción que usa el cobro (0013).
- El interés pendiente **no** se contabiliza (igual que en un desembolso normal: entra como ingreso al cobrarse).
- `route_funding` queda como «capital que la ruta tiene puesto en la calle y vino de Listos», atribuido a
  Andrew como Administrador responsable (regla de capital por Admin, R10).
- No pasa por ninguna caja: ni Base, ni custodia, ni la cuenta del Administrador.
- Tiene su propio asiento, así que **no** es un abono sin asiento (`LEGACY_PAYMENTS`) y no bloquea la
  rectificación (AX526).

## 6. Reporte diario (mientras dure la migración)

### 6.1 Cómo se compara

Se empareja cada crédito del reporte con su venta por **código de crédito de Listos**:

| Caso | Qué hace ADEX |
|---|---|
| Crédito nuevo (código no visto) y activo | Cliente nuevo si hace falta + venta + `MIGRATION_OPENING` |
| Mismo crédito, saldo **menor** | «Abono de migración» por la diferencia (§6.2) |
| Mismo crédito, saldo igual | Nada |
| Crédito pasa a PAGADO (saldo 0) | Abono de migración por el resto; venta `finalizada`; copia al historial |
| Saldo **mayor** que el anterior | **Se detiene** y se avisa (corrección en Listos): se revisa a mano |
| Activo de ADEX que ya no aparece en el reporte | **Se detiene** y se avisa (rango corto o crédito anulado en Listos) |
| Crédito nuevo que ya llega PAGADO | Solo al historial |

### 6.2 «Abono de migración»

- Se guarda como abono con origen `migracion` y fecha = fecha del reporte (o «FECHA ÚLTIMO ABONO» si es
  posterior al reporte anterior). Las cuotas se actualizan igual que con un abono normal.
- Asiento **`MIGRATION_COLLECTION`**: cartera de la ruta − parte de capital; financiación de la ruta + parte de capital.
  La parte de interés no se registra en ADEX (ese ingreso quedó en la caja de Listos).
- No entra en caja, cuadres, recaudo del cobrador ni comisiones. En los reportes aparece como
  «Recaudo en Listos (migración)», separado del recaudo de ADEX.
- Si un día el cliente pagó varias veces, ADEX ve una sola baja de saldo: es suficiente (M6).

### 6.3 Controles de cada reporte (deben cumplirse para guardar)

1. Σ saldos de ventas activas en ADEX = Σ «SALDO ACTIVOS» del reporte de Clientes (al peso).
2. Por cliente: saldo y número de activos iguales.
3. Cartera de la ruta en el libro = Σ capital pendiente de las ventas activas.
4. Ningún saldo sube, ningún activo desaparece (o se aprobaron a mano).
5. La fecha del reporte es posterior a la del anterior.

La carga es **todo o nada**: si algo falla, no se guarda nada. Volver a cargar el mismo reporte no
duplica nada (se reconoce por el contenido del archivo y por los códigos).

### 6.4 Rango del reporte diario

El reporte de créditos de Listos filtra por **fecha de otorgamiento**. Para ver el saldo de **todos** los
activos, el rango debe empezar en el crédito activo más antiguo (hoy, 2025-02-28; 17 de los 41 activos
son de octubre de 2026). Recomendación: exportar siempre **desde el 2025-01-01 hasta el día**; es un solo
archivo y cubre todo.
Si queda muy pesado, ADEX dirá en cada carga desde qué fecha hace falta exportar.

### 6.5 Qué ve Helmer después de cada carga

Un resumen corto: créditos nuevos, finalizados, recaudo en Listos del día, saldo total, cartera,
diferencias de mora con Listos, y los avisos que requieran revisión.

## 7. Paso a normal (cierre de la migración)

Se hace al **cierre de un día** acordado (día C):

1. Último reporte del día C, cargado y cuadrado (§6.3).
2. **Conteo de caja** al cierre del día C, comparado con Listos:
   - **Base de la ruta** (dinero disponible para prestar).
   - **Efectivo del cobrador** (lo cobrado aún no entregado).
   - **Gastos** del día aún no descontados.
3. Asiento **`MIGRATION_CASH_OPENING`**:
   - Base contada: Base de la ruta (`route_base`) + / financiación de la ruta −.
   - Efectivo del cobrador: su custodia + / financiación de la ruta −.
   - Si el conteo no coincide con Listos: se abre con **lo contado** y la diferencia queda anotada
     (con la caja de Listos de ese día) en el registro de la migración, sin movimiento contable: la cuenta
     `route_difference` solo admite conciliaciones de actas y cuadres (control `conciliationDrift`).
4. `migration_state = 'normal'`. Se levantan los bloqueos.
5. Desde el día C+1: se cobra **solo en ADEX** y la ruta deja de usarse en Listos.
6. Seguimiento: los **2 primeros cierres semanales** se comparan con lo que habría dado Listos.

Al final, `route_funding` de la ruta = capital de la cartera + Base + efectivo: es **el capital total de
la ruta que vino de Listos**, a cargo de Andrew.

## 8. Cómo se construye (por pasos, cada uno con el «sí» de Helmer)

| Paso | Qué | Dónde | ¿Toca BlueLine? |
|---|---|---|---|
| A | Migración de base de datos 0042: estado de ruta, tablas de migración (aperturas, cargas, códigos de Listos, historial), operaciones nuevas, bloqueos, excepción de `start_date` | Repositorio; la aplica **Helmer**, con respaldo previo | No (solo estructura) |
| B | Lector de reportes de Listos + modo **revisar** (no guarda nada, muestra el resumen y los controles) | `saas/scripts/migracion/` | No (solo lee) |
| C | Modo **aplicar** (todo o nada, sin duplicados) + pruebas automáticas | Empresa sintética local | No |
| D | Ensayo completo en una **empresa sintética** de staging con nombres y documentos **inventados** y los mismos montos: carga inicial, 3–5 reportes diarios simulados, paso a normal, un cierre semanal | Staging, empresa sintética autorizada | No |
| E | Pantallas: aviso «En migración» en la ruta, botones bloqueados con el motivo, ficha con historial de Listos, resumen de cada carga | Online (Vercel) + API (Render, despliegue manual autorizado) | No |
| F | **Carga real** de Valparaíso en BlueLine: respaldo (`npm run backup -- crear --motivo manual`), revisar, firma de Helmer, aplicar | Staging, BlueLine | **Sí**, con autorización |
| G | Reportes diarios hasta el día C, y paso a normal | BlueLine | Sí |

Primero se hace por script (pasos B–D) y Helmer me envía los archivos. Una pantalla para que Helmer
suba los reportes él mismo puede venir después (no es necesaria para la primera ruta).

Costo: ninguno (todo cabe en los planes actuales).

## 9. Respuestas de Helmer (2026-11-04) y lo que se dedujo de los datos

| # | Pregunta | Respuesta |
|---|---|---|
| P1 | ¿Reporte de caja o cuadre? | **Sí.** Dos reportes de Listos: «Reporte saldo caja por ruta» (PDF, total caja y cartera por ruta a una fecha) y «ReporteExcelCuadreRuta» (una fila por día). Ver §11. |
| P2 | ¿DIARIO cobra de lunes a sábado? | Helmer no lo sabe. **Los datos dicen que Listos cuenta los 7 días**: con domingos incluidos y sin contar como atrasada una cuota con abono parcial, el cálculo da las mismas «CUOTAS ATRASADAS» que Listos en 34 de 36 créditos diarios activos (sin domingos: 19 de 36). En ADEX: `payment_days = [0..6]`. |
| P3 | ¿Andrew y la oficina Aguas Lindas existen en BlueLine? | **Sí.** |
| P4 | ¿Cuánto dura la migración? | **4 días, hasta el domingo 8 de noviembre de 2026.** La ruta empieza a cobrar en ADEX el **lunes 9**. |
| P5 | ¿Castigos? | **ADEX no castiga créditos.** Todo crédito con saldo entra y queda `activa`, mostrando claramente su **retraso** (cuotas y días). Hay clientes que pagan después de un año. |
| — | Meta inmediata | Ver la ruta Valparaíso en ADEX en estado **«En migración»**. |

## 11. Reportes de caja de Listos

**«Reporte saldo caja por ruta»** (oficina 20, 2026-11-03): una fila por ruta con TOTAL CAJA y CARTERA.
Valparaíso: caja **−1.580**, cartera **63.773** (igual al saldo de los 41 activos: cuadra).

**«ReporteExcelCuadreRuta»** (muestra de otra ruta de la misma oficina, 8 días): columnas FECHA, ABONOS,
OTROS ABONOS, DESEMBOLSOS, INGRESOS, EGRESOS, ANULACIÓN INGRESOS, ANULACIÓN EGRESOS, PROMEDIO DEL COBRO DÍA
ANTERIOR, PORCENTAJE ABONOS, CAJA ANTERIOR, TOTAL CAJA, CARTERA. Comprobado en los 8 días:

- `TOTAL CAJA = CAJA ANTERIOR + ABONOS + OTROS ABONOS − DESEMBOLSOS + INGRESOS − EGRESOS` (8 de 8).
- CARTERA es la del **inicio** del día: `CARTERA(d+1) = CARTERA(d) − ABONOS(d) + total de los créditos nuevos(d)` (7 de 8; un día con 60 de diferencia, por explicar).

Uso en la migración:
- **Control diario extra** (cuando Helmer tenga acceso al cuadre de Valparaíso): ABONOS del día = Σ bajas de
  saldo del día; DESEMBOLSOS = Σ capital de los créditos nuevos; CARTERA = Σ saldos.
- **Caja negativa** (−1.580): en Listos la caja es una sola bolsa por ruta; negativa significa que se prestó
  más de lo que había y el dinero salió de afuera (Administrador o socio) sin registrarse como ingreso. ADEX no
  admite Base negativa: el día C se abre con el **dinero contado** (≥ 0). Lo puesto desde afuera ya queda
  dentro de la financiación de la ruta (capital de la cartera). Se anota la caja de Listos de ese día como referencia.
- Lo que Listos llama «caja» = Base + efectivo del cobrador en ADEX. El día C se separa según el conteo.

## 13. Avance

**Parte 1 (estado «en migración») — hecha en local, 2026-11-04, sin commit.** La migración 0042 ya la usó la
venta tardía (3.24), así que esta es la **0043**.

- `saas/db/migrations/0043_route_migration_state.sql`: columna `routes.migration_state`, tabla
  `route_migrations`, bloqueo de altas en 20 tablas con ruta (y de cambios en ventas y abonos), funciones
  `route_migration_open` / `route_migration_cancel` (solo SuperAdmin; ruta activa, vacía, sin entrega
  pendiente, empresa con Base por Ruta). Errores nuevos: AX443 `ROUTE_IN_MIGRATION`, AX444
  `ROUTE_MIGRATION_NOT_ALLOWED`.
- API: `GET /v1/route-migrations`, `POST /v1/routes/{id}/migration`, `POST /v1/routes/{id}/migration/cancel`;
  la ruta trae `migrationState`.
- Online: en **Rutas**, aviso «En migración» y botón «Poner en migración» / «Cancelar migración» (solo SuperAdmin).
- Prueba: `saas/test/integration/route-migration.test.ts` (4/4 con PostgreSQL real).

Para verlo en BlueLine: (1) Helmer aplica 0043 en staging con respaldo; (2) despliegue manual de la API en
Render; (3) push → Vercel; (4) Helmer crea la ruta Valparaíso en la oficina Aguas Lindas con Andrew y pulsa
«Poner en migración».

**Parte 1 publicada** (091d4e37, 0043 en staging, 2026-11-04). Valparaíso (RT-002, Oficina 20, Andrew) quedó «En migración».

**Parte 2 (0044) — hecha en local, 2026-11-04.** Ver §14.

## 14. Parte 2: carga final (0044) — cómo quedó

**Cambio respecto de §5–§6 (decisión técnica, 2026-11-04):** la ruta se escribe **una sola vez, al final**, con el reporte
del cierre del domingo 8. Los reportes diarios del jueves al sábado se **revisan** (vista previa, sin guardar).
Motivo: un cobro hecho en Listos no debe convertirse en un abono de ADEX; si no, se mezclaría con el recaudo, los
cuadres, las comisiones y los informes de ADEX. Así no hace falta `MIGRATION_COLLECTION` ni marcar abonos.

- **Créditos activos** → ventas de ADEX por **lo que falta cobrar**: total = saldo de Listos; capital = capital
  pendiente (`valor − round(pagado × valor / total)`, la misma proporción del cobro); cuotas = las que faltan, con
  sus **fechas originales** (el retraso se ve tal cual). Las cifras originales (valor, total, cuotas pactadas, mora de
  Listos, último abono) quedan en `adex.route_migration_items` (tipo `credit`).
- **Asiento `MIGRATION_OPENING`** por venta: cartera de la ruta + capital pendiente / financiación de la ruta −. No toca
  ninguna caja. La conciliación lo trata como el desembolso de esa venta.
- **Créditos pagados** → solo historial (`route_migration_items`, tipo `paid_credit`). **Clientes**: los activos como
  `activo`, el resto `inactivo`; documento repetido en la empresa → se carga marcado (`document_legacy_duplicate`).
- `adex.route_migration_finish` (solo SuperAdmin, por la API): comprueba todo (controles del reporte, calendario de
  cada crédito, Σ saldos), cierra la migración (`finalizada`) y deja la ruta en **estado normal** en la misma
  transacción: **todo o nada**. Error nuevo AX445 `ROUTE_MIGRATION_INVALID_DATA`.
- API: `POST /v1/routes/{id}/migration/preview` (vista previa: corre la carga y la deshace; dice qué falla) y
  `POST /v1/routes/{id}/migration/finish` (idempotente). Cuerpo `{ payload }` hasta 2 MB.
- **Lector**: `saas/scripts/migracion/listos_a_adex.py` (Python con openpyxl). Une los reportes de créditos (gana la
  exportación más reciente), cruza con «Clientes activos» (Σ saldos y activos por cliente), arma el calendario y
  escribe el `.json` (fuera del repositorio: datos personales). Imprime solo cifras.
- **Online**: en Rutas, con la ruta en migración, el SuperAdmin ve «Cargar datos de Listos» → sube el `.json` → vista
  previa → «Confirmar carga».
- **Caja (paso a normal)**: después de la carga, Andrew inyecta la **Base contada** con la inyección de Base normal
  («Inyectar Base»). No hace falta un asiento nuevo.

**Probado (local, PostgreSQL real):** `route-migration.test.ts` 5/5 (RM-005: vista previa con errores, todo o nada,
idempotencia, ventas por lo que falta, retraso visible, inyección de Base y cobro posterior, conciliación limpia).
Con los reportes **reales** de Valparaíso del 3/11 en una base local desechable: 123 clientes, 41 activos, saldo
R$ 63.773 (= cartera de Listos), 852 pagados, capital pendiente R$ 53.144,17; carga en < 1 s; conciliación limpia.
Mora: con la regla de Listos (sin la cuota con abono parcial) coinciden 37 de 41 créditos.

**Pendiente conocido:** las ventas migradas tienen como fecha de venta la de Listos; los informes de ventas por fecha
de esos días antiguos las incluyen (con el valor pendiente, no el original). Ficha del cliente con el historial de
Listos: después.

## 15. Corrección (0045): un cierre por día, la ruta se ve cada día

Helmer (2026-11-04) rechazó la carga única del §14: quiere ver la ruta **cada día** con el cierre de Listos y que el
domingo solo falte el último cierre y la caja. Se vuelve al diseño aprobado (§6), así:

- `adex.route_migration_load` carga **un cierre** (un día). La ruta **sigue «en migración»** (solo lectura).
  Primera carga: clientes, créditos activos (por lo que falta cobrar) e historial. Siguientes, por código de Listos:
  cliente nuevo → alta; crédito nuevo → venta nueva; saldo menor → **«Abono en Listos»** por la diferencia (fecha =
  día del cierre); crédito pagado → abono por el resto y venta finalizada; saldo mayor o activo que desaparece sin
  estar pagado → **se detiene** (AX445). Control: Σ saldos de la ruta en ADEX = reporte.
- **«Abono en Listos»** = pago de ADEX (saldo, cuotas y retraso reales) con asiento `MIGRATION_COLLECTION`: cartera −
  capital, interés − interés, financiación de la ruta + importe. **No toca ninguna caja**. Cobrador del pago = el
  Administrador responsable (Andrew); tipo `otro`; nota «Abono en Listos (migración, crédito N)». En los informes de
  recaudo por fecha de esos días aparece como recaudo de la ruta (es un cobro real, hecho en Listos).
- `adex.route_migration_close` termina la migración (estado normal). La caja: inyección de Base de Andrew.
- Cancelar la migración solo antes del primer cierre. `route_migration_finish` (0044) se retira.
- API: `POST /v1/routes/{id}/migration/preview`, `POST …/migration/loads` (idempotente), `POST …/migration/close`;
  `GET /v1/route-migrations` trae los cierres cargados.
- Online: «Cargar cierre de Listos» (vista previa → «Guardar cierre»), fecha del último cierre, «Terminar migración».

**Probado:** `route-migration.test.ts` 5/5 (dos cierres: abono, crédito pagado, cliente que renueva, saldo que sube,
cierre repetido, terminar, Base y cobro, conciliación limpia). Reales del 3/11 en base local: cierre 1 en < 1 s,
cierre 2 sin cambios, terminar, conciliación limpia.

## 12. Calendario (meta: cobrar en ADEX el lunes 9)

| Día | Qué |
|---|---|
| Mié 4 | Paso A: migración 0042 escrita y probada en Postgres local. Helmer la revisa. |
| Jue 5 | Helmer aplica 0042 en staging (con respaldo). Pasos B–C: lector, revisar/aplicar, pruebas. Paso E mínimo: aviso «En migración» en Online. |
| Vie 6 | Paso D: ensayo en empresa sintética. Despliegue (Render manual, con autorización). **Carga inicial real** con los reportes del jueves → la ruta se ve «En migración». |
| Sáb 7 | Reporte diario. |
| Dom 8 | Último reporte al cierre + cuadre de caja + conteo físico → **paso a normal**. |
| Lun 9 | La ruta cobra en ADEX. |

Si un paso falla, la ruta sigue en Listos el lunes y se corre todo una semana: no hay riesgo para BlueLine.

## 10. Lo que no cambia

- BlueLine nunca recibe datos ficticios; las pruebas van en una empresa sintética.
- Las migraciones de base de datos las aplica Helmer; nada en Render sin su autorización.
- Ninguna otra ruta de BlueLine se ve afectada: el estado es por ruta.
