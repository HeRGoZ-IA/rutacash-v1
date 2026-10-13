# ADEX Soluciones — Riesgos de concurrencia multiusuario (Ronda 6/6D)

| | |
|---|---|
| Fecha | 2026-10-12 · `main` @ `520a331` |
| Punto de partida | Cada navegador tiene su propia IndexedDB. Dexie serializa las transacciones de escritura **dentro de un navegador** (también entre sus pestañas); **entre dispositivos no hay ninguna coordinación** |
| Regla de esta ronda | No se simula una solución multiusuario con almacenamiento local. Todo lo de este documento requiere servidor |

## 0. Qué protege hoy Dexie y qué no

**Protegido dentro de un mismo navegador** (y demostrado en pruebas):
- relectura del estado dentro de la transacción;
- validaciones de fondos bajo bloqueo (desembolso, entrega de Base, retiro, colocación);
- una sola aprobación por solicitud;
- desembolso único;
- cierres sin duplicado;
- frontera del cuadre por instante;
- idempotencia por `operationId` en 5 servicios.

**Sin protección entre dispositivos:**
- Dos equipos tienen **dos bases distintas**: cada uno valida contra su copia, que no contiene lo que hizo el otro.
- No hay estado compartido que bloquear; ni siquiera llegan a enterarse uno del otro.
- Hoy todos los «conflictos multiusuario» son en realidad **divergencias silenciosas**: las cifras de cada equipo son coherentes por dentro, pero distintas entre sí.

Garantías mínimas que debe dar el servidor en **todos** los casos:
1. Un comando financiero = **una transacción** de base de datos, con lectura del estado y escritura en ella.
2. **Bloqueo** de las filas de saldo afectadas (empresa, bolsa, ruta, trabajador, venta), en orden determinista para evitar interbloqueos, o aislamiento `SERIALIZABLE` con reintento.
3. **Clave de idempotencia** por operación (`operationId`), única por empresa.
4. **Hora del servidor** para instantes y fechas contables, en la zona horaria de la empresa.
5. **Autorización en el servidor**, nunca deducida de lo que envía el cliente.

---

## R1. Dos desembolsos usan el mismo capital de la ruta
1. **Qué ocurre:** con Base 5.000, el Cobrador A (equipo 1) y el Supervisor B (equipo 2) desembolsan 4.000 cada uno. Cada equipo ve 5.000 y acepta: la Base real queda en −3.000 (D26 violada).
2. **Dexie hoy:** dentro de un navegador, el segundo se rechaza (CAP6C-005).
3. **Entre dispositivos:** nada.
4. **Servidor:** `disburse` bloquea la fila de saldo de la ruta (o recalcula la Base dentro de una transacción serializable) antes de comparar con el importe.
5. **Prueba:** N clientes paralelos contra el mismo servidor desembolsan sobre la misma Base; Σ desembolsado ≤ Base y la Base nunca es negativa (equivalente distribuido de CAP6C-005).

## R2. Un desembolso usa efectivo que ya se entregó o devolvió
1. **Qué ocurre:** el responsable registra en su PC la devolución de la Base de Juan mientras Juan, en el celular, desembolsa con esa misma Base (D25 violada). O bien el Administrador desembolsa desde la caja mientras entrega esa caja como Base a un trabajador.
2. **Dexie hoy:** la entrega comprueba el disponible bajo bloqueo; el desembolso comprueba el efectivo bajo bloqueo (G/G3 de la Ronda 6A).
3. **Entre dispositivos:** nada.
4. **Servidor:** la posición del trabajador y la caja de la ruta como filas de saldo bloqueadas por toda operación que las mueva: desembolso, entrega, devolución, traspaso, gasto y cuadre.
5. **Prueba:** entrega o devolución y desembolso concurrentes en los dos órdenes; posición ≥ 0 para el desembolso y `Base = Sin asignar + Σ posiciones` siempre.

## R3. Pagos sobre un saldo desactualizado
1. **Qué ocurre:** el Cobrador sin conexión y el Administrador en la oficina registran un pago de 300 sobre un saldo de 400. Sin control quedan dos pagos (−200 de saldo, o un tope aplicado dos veces); y con un reintento sin red, el mismo pago se registra dos veces.
2. **Dexie hoy:** tope al saldo dentro de la transacción (`registerPayment`). **No hay `operationId`.**
3. **Entre dispositivos:** nada; tampoco idempotencia ante reintentos.
4. **Servidor:**
   - `operationId` obligatorio;
   - bloqueo de la venta;
   - tope recalculado en el servidor;
   - un pago que llega sin conexión con saldo ya agotado se registra como **excedente para conciliar** (decisión DS-07), nunca como saldo negativo.
5. **Prueba:** dos equipos pagan el mismo crédito a la vez; mismo `operationId` reenviado 3 veces; cola sin conexión enviada después de un pago en línea.

## R4. Transferencias y movimientos de capital simultáneos
1. **Qué ocurre:**
   - dos Ruta → Ruta desde la misma ruta de origen;
   - una colocación y una asignación de capital simultáneas sobre la misma bolsa;
   - dos SuperAdmin retiran capital de la empresa a la vez.
2. **Dexie hoy:** el disponible se relee bajo bloqueo (`fundsTables`, `registrarLedger`).
3. **Entre dispositivos:** nada.
4. **Servidor:** bloqueo de las filas de bolsa y de ruta en orden determinista (por ejemplo, ascendente por id); conservación del capital comprobada al final de cada transacción, en desarrollo y pruebas.
5. **Prueba:** ráfaga de transferencias cruzadas A→B y B→A (detección de interbloqueos); `verifyCapitalInvariants` después de cada ráfaga.

## R5. Cambio de responsable de capital durante una operación
1. **Qué ocurre:** el SuperAdmin traspasa la ruta de Andrés a Beatriz mientras Andrés coloca capital o desembolsa desde la caja en otro equipo. La operación de Andrés se valida con un responsable que ya no lo es (D30 violada) o su capital va a la bolsa equivocada.
2. **Dexie hoy:** el responsable se relee dentro de la transacción (AUTHBOX-006).
3. **Entre dispositivos:** nada.
4. **Servidor:** cada comando de caja lee `capitalControllerAdminId` en su transacción (nunca del token ni de la caché del cliente); el cambio de responsable bloquea la fila de la ruta.
5. **Prueba:** cambio de responsable concurrente con colocaciones y desembolsos administrativos; ninguna operación se acepta con un responsable obsoleto.

## R6. Cierre de un periodo mientras llegan movimientos
1. **Qué ocurre:**
   - se cierra la semana o el cuadre de Juan mientras su celular sube pagos, gastos o desembolsos con fecha o instante de ese periodo;
   - las cifras archivadas no incluyen esos movimientos, o los incluyen dos veces en el ciclo siguiente.
2. **Dexie hoy:**
   - el cuadre bloquea pagos, ventas, gastos y custodia y sella `hasta` bajo bloqueo (CASH-BOUNDARY-*);
   - el cierre semanal calcula y archiva en la misma transacción que el libro (6C.1);
   - los escritores comprueban el periodo dentro de su transacción (`periodGuard`).
3. **Entre dispositivos:**
   - movimientos registrados **sin conexión antes del cierre** que llegan **después**;
   - además, la «hora» es la del dispositivo.
4. **Servidor:**
   - instante y fecha contable asignados por el servidor;
   - el cierre bloquea el periodo;
   - un movimiento capturado sin conexión con fecha de un periodo ya cerrado se acepta **en el periodo abierto** con la fecha de captura como dato informativo, o queda en una cola de conciliación (DS-07/DS-08). Nunca reescribe el cierre.
5. **Prueba:** cierre concurrente con una ráfaga de pagos; Σ(ciclos cerrados + abierto) = Σ movimientos, sin duplicados ni pérdidas (equivalente distribuido de CASH-BOUNDARY-009).

## R7. Ajustes concurrentes
1. **Qué ocurre:** dos personas anulan o corrigen el mismo pago o movimiento, o un Secretario solicita un ajuste mientras un Administrador anula el pago.
2. **Dexie hoy:** anulaciones con `assertVigente` y corrección con revalidación bajo bloqueo (REVPER-010).
3. **Entre dispositivos:** nada.
4. **Servidor:** bloqueo de la fila original; una solicitud de ajuste aprobada sobre un original ya anulado se rechaza; idempotencia por `operationId`.
5. **Prueba:** N anulaciones o correcciones simultáneas del mismo original → exactamente 1.

## R8. Carteras inconsistentes entre pantallas
1. **Qué ocurre:** el Administrador ve una cartera, una Base y unas posiciones distintas de las que ve el Supervisor en ruta, porque cada uno ve su propia base. Se decide (aprobar, cerrar, entregar Base) con cifras ajenas a la realidad.
2. **Dexie hoy:** una sola fuente de cálculo (`getRouteBase`, `computeRouteCashReconciliation`) y reactividad entre pestañas.
3. **Entre dispositivos:** no hay propagación.
4. **Servidor:**
   - lecturas desde la base central;
   - invalidación o suscripción de cambios por empresa y ruta;
   - las cifras que muestra el cliente son **orientativas**: toda decisión se revalida en el comando (como hoy en el servicio).
5. **Prueba:** un cambio en el dispositivo A se ve en B en menos de N segundos; un comando de B con cifras viejas se rechaza o se recalcula.

## R9. Operar sin autorización efectiva del servidor
1. **Qué ocurre:**
   - cualquier persona con el navegador puede leer o editar IndexedDB y `localStorage`, donde están las contraseñas en claro y la sesión con la contraseña;
   - un usuario desactivado sigue operando en un equipo que tenga la sesión guardada.
2. **Dexie hoy:** los servicios validan permisos, pero sobre datos que el propio usuario controla.
3. **Entre dispositivos:** no existe revocación.
4. **Servidor:**
   - identidad central con contraseñas con hash;
   - sesiones revocables y de corta duración;
   - autorización en cada comando (rol, ruta, empresa, autoridad de caja);
   - aislamiento por empresa en la base (RLS o equivalente) **además** de en la API.
5. **Prueba:** un token de la empresa A no lee ni escribe en B; un usuario desactivado es rechazado en el comando siguiente; manipular el rol en el cliente no concede nada.

## R10. Duplicados y altas paralelas
1. **Qué ocurre:**
   - el mismo cliente se da de alta en dos equipos;
   - dos ventas directas al mismo cliente (permitido para el Supervisor) por un doble envío;
   - dos solicitudes pendientes para el mismo cliente desde dos equipos.
2. **Dexie hoy:** una solicitud pendiente por cliente, comprobada en la transacción. Las altas no son idempotentes.
3. **Entre dispositivos:** nada.
4. **Servidor:** `operationId` en altas y ventas; unicidad (empresa, documento del cliente) a decidir (DS-10); restricción «una solicitud pendiente por cliente» en la base.
5. **Prueba:** alta simultánea del mismo documento; solicitudes simultáneas para el mismo cliente.

## R11. Cola sin conexión y orden causal
1. **Qué ocurre:** un pago capturado sin conexión y su corrección llegan en desorden; o la corrección llega antes que el pago.
2. **Dexie hoy:** `syncService` confirma por crédito y respeta la causalidad (`dependentSyncStatus`), pero solo localmente.
3. **Servidor:** la cola del cliente envía las operaciones en orden por entidad, con `operationId`; el servidor rechaza una corrección cuyo original no existe y la deja reintentable.
4. **Prueba:** cola reordenada a propósito; resultado final idéntico al orden correcto o rechazo explícito.

---

## Resumen de prioridades

| Riesgo | Daño posible | Prioridad |
|---|---|---|
| R1, R2 | Dinero entregado sin respaldo (Base o efectivo negativos) | **Crítica** |
| R3, R11 | Pagos duplicados o perdidos; saldos de clientes incorrectos | **Crítica** |
| R9 | Acceso indebido y fuga de datos entre empresas | **Crítica** |
| R6 | Cierres que no cuadran con la realidad | Alta |
| R4, R5, R7 | Capital mal atribuido; ajustes dobles | Alta |
| R8, R10 | Decisiones sobre cifras desactualizadas; duplicados | Media |
