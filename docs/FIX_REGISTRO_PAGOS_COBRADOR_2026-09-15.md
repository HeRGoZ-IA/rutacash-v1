# Incidente — La App Cobrador no podía registrar abonos (15/09/2026)

Documento **interno** de mantenimiento. No se comparte fuera del equipo.

---

## Síntoma

En producción CLEAN, un Cobrador entraba a registrar un abono, escribía un valor
válido (por ejemplo $400), pulsaba **Registrar abono** y siempre obtenía:

> Error al registrar el pago. No se guardó ningún cambio.

El rollback era correcto —no quedaba nada a medias— pero **ningún pago podía
registrarse**. El mensaje era el fallback genérico `WRITE_FAILED`, que no decía nada
sobre la causa.

Alcance real, mayor de lo reportado: afectaba a **todos los roles** (Cobrador,
Supervisor, Administrador) y a **DEMO y CLEAN por igual**. El socio lo detectó en
CLEAN porque era donde estaba probando.

---

## Causa raíz

`src/services/paymentService.ts` → `registerPayment`.

La transacción se abría declarando tres tablas:

```ts
database.transaction('rw', [database.payments, database.installments, database.sales], ...)
```

y **dentro** de ese ámbito, el paso 4.b (resolución del cobrador responsable,
introducido con RQ-05) leía una cuarta tabla no declarada:

```ts
const routeCollectors = (await database.users.where('tenantId').equals(sale.tenantId).toArray())
```

Dexie solo permite usar las tablas **declaradas** en el alcance de la transacción.
Al tocar `users`, lanza:

```
NotFoundError: Table users not part of transaction
```

Ver `node_modules/dexie/dist/dexie.js`: `Table.prototype._trans` (línea ~1340) y
`Transaction.prototype.table` (línea ~2837).

Ese error **no** es un rechazo de negocio (`PaymentRejection`), así que caía en el
`catch` genérico, se traducía a `WRITE_FAILED` y abortaba el pago completo.

### Relación con RQ-05

**Sí fue consecuencia directa de RQ-05.** La lectura de `users` dentro de la
transacción se añadió al separar `collectorId` (quién recibió el dinero) de
`createdByUserId` (quién lo registró). La separación es correcta; lo que faltó fue
declarar `users` en el alcance de la transacción.

### Por qué no lo detectó la suite

El harness de pruebas (`tests/financial/harness.ts`) replicaba la superficie de
Dexie —incluido el rollback— **menos esta regla**: su `transaction()` ignoraba la
lista de tablas declaradas. Una tabla fuera de alcance pasaba en las pruebas y
reventaba en el navegador.

---

## Corrección

1. **`src/services/paymentService.ts`** — `users` se declara en el alcance de la
   transacción. Solo se lee; ninguna escritura la toca. Se mantiene la lectura
   dentro del ámbito atómico (garantía de lectura fresca de RQ-05).
2. **`src/services/paymentService.ts`** — el `catch` genérico ya no se traga la
   causa: registra en consola `saleId`, actor, importe y el error real. El usuario
   sigue viendo un mensaje amable; los rechazos de negocio conservan sus mensajes
   específicos (sin permiso, venta no activa, indicar quién cobró, etc.).
3. **`tests/financial/harness.ts`** — la base en memoria ahora **replica el
   contrato de alcance de Dexie**: lanza `NotFoundError: Table X not part of
   transaction` igual que Dexie, y el rollback restaura **todas** las tablas del
   alcance (antes solo un trío fijo).

No se tocó ninguna validación financiera ni de permisos. No se cambió la
atribución: `collectorId` sigue siendo el cobrador responsable y `createdByUserId`
el actor que registra.

### Auditoría del resto del código

Se revisaron las **18** transacciones Dexie del proyecto comparando alcance
declarado contra tablas usadas: `paymentService` era la **única** con una tabla
fuera de alcance. El resto está correcto.

---

## Pruebas

Grupo nuevo **PAY-COLL-REG** en `tests/payments.test.ts` (13 casos):

| ID | Cubre |
|---|---|
| PAY-COLL-REG-001 | El Cobrador registra su propio abono; `collectorId` = `createdByUserId` = su id |
| PAY-COLL-REG-002 | Abono parcial: saldo baja exactamente lo abonado |
| PAY-COLL-REG-003 | Abono que cierra la parcela y avanza a la siguiente |
| PAY-COLL-REG-004 | Abono que salda la venta: finaliza y sella `fechaFinalizacion` |
| PAY-COLL-REG-005 | Abono superior al saldo: se topa, nunca sobrepaga |
| PAY-COLL-REG-006 | Cobrador de otra ruta: rechazo controlado `NOT_AUTHORIZED`, sin escrituras |
| PAY-COLL-REG-007 | Ruta con varios cobradores: el propio Cobrador no debe elegir responsable |
| PAY-COLL-REG-008 | Supervisor registra cobro de otro: exige responsable, `createdByUserId` = Supervisor |
| PAY-COLL-REG-009 | Fallo a mitad de la escritura: rollback total |
| PAY-COLL-REG-010 | Pago reversado: la atribución del Cobrador se conserva |
| PAY-COLL-REG-011 | La caja personal del Cobrador refleja el abono |
| PAY-COLL-REG-012 | CLEAN de extremo a extremo: ruta sin Cobrador → asignarlo → cliente → venta → abono |
| PAY-COLL-REG-013 | Contrato: el servicio declara todas las tablas que usa dentro de la transacción |

**Verificación de que las pruebas no son vacías:** revirtiendo solo la línea del
alcance, la suite financiera pasa de 136 PASS a **98 PASS / 38 FAIL**, con
`PAY-COLL-REG-001`, `-012` y `-013` entre las fallidas.

### Resultado

| Suite | Antes | Después |
|---|---|---|
| Permisos | 229 | 229 |
| Financiera | 123 | **136** |
| Arranque | 101 | 101 |
| **Total** | **453** | **466 PASS · 0 FAIL** |

`npx tsc --noEmit` ✅ · `npx tsc --noEmit -p tests` ✅ · `npm run build` ✅

---

## Smoke test manual (CLEAN)

Automatizado en `PAY-COLL-REG-012` sobre base vacía. Para repetirlo en el
despliegue real:

1. Entrar como **Super Admin** y crear una ruta (puede ir sin responsables).
2. Crear un usuario con rol **Cobrador**.
3. Editar la ruta y asignarle ese Cobrador como responsable.
4. Entrar como ese **Cobrador** (cambiar la contraseña temporal si la pide).
5. Crear un **cliente** en la ruta y una **venta**; confirmar el desembolso.
6. Abrir la venta → **Registrar abono** con un valor menor al saldo.
7. Comprobar: aparece la confirmación, no el error; el saldo baja lo abonado; la
   parcela actual avanza si se completó.
8. Volver a la venta y verificar saldo y parcelas persistidos.
9. Abrir la **caja del Cobrador** del día: el abono debe estar sumado en lo
   recaudado y en el efectivo a entregar.

Si el navegador conserva una versión cacheada, recargar con Ctrl+F5.

---

## Commit

`fix(collector): restore payment registration flow`
