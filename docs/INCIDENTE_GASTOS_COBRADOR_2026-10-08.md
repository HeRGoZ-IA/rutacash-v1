# Incidente 2026-10-08 — «El gasto supera el efectivo en manos del cobrador»

## Reporte

Un cobrador recaudó R$ 886 en el día e intentó registrar R$ 100 de combustible. La
app lo rechazó con «El gasto supera el efectivo en manos de …». Antes se permitía
registrar gastos aunque dejaran el saldo en negativo, y se reflejaba en la contabilidad.

## Causa raíz (comprobada)

1. **Validación nueva y bloqueante (regresión).** `e7708c2` (2026-10-03,
   «classify financial attribution») añadió a `createExpense` un tope duro: un gasto de
   trabajador no podía superar `transferableCash(personalCashPosition)`. Antes de ese
   commit, `addExpenseStamped` no tenía ningún control de fondos.
2. **El tope se medía contra otra cifra, no contra la que ve el cobrador.** La posición
   es la del **ciclo** desde el último cuadre (Base recibida − devuelta + recaudo −
   desembolsos − gastos), no «Mi recaudo hoy». Basta con haber desembolsado un crédito o
   entregado efectivo durante el ciclo para que la posición quede por debajo de R$ 100
   aunque el KPI diario muestre R$ 886. Reproducido: recaudo 886, entrega 800 → posición
   86 → gasto 100 **rechazado** (`EXP-CASH-004` contra el código anterior).
   El caso puro (886 en efectivo, nada más) ya se aceptaba: la fórmula no estaba rota.
   El bloqueo lo producía la validación.
3. **Defecto latente en el cálculo.** El recaudo personal sumaba pagos de cualquier
   `tipo` (`efectivo`, `transferencia`, `otro`). Hoy la app solo crea pagos en efectivo,
   así que ningún dato real cambia. Pero una transferencia se habría contado como
   efectivo en manos.

No hubo datos desactualizados: la posición se relee dentro de la transacción del gasto.

## Corrección

| Capa | Cambio |
|---|---|
| `expenseService.createExpense` | Se retira el tope del gasto de **trabajador**. Se conservan forma, empresa, valor > 0, categoría, permisos, ruta/Oficina activa, persona asignada y «el Cobrador solo se carga a sí mismo». El gasto de **ruta** (caja de la ruta = capital) sigue limitado a lo Sin asignar. |
| `expenseService.createExpense` | Idempotencia: `operationId` es el id del gasto. Un reintento con los mismos datos devuelve el ya guardado (sin otra fila ni otra auditoría). Si el mismo id llega con otros datos, se rechaza. |
| `cashSettlementRules.isCashPayment` + `getCollectorCashSummary` | El recaudo personal solo suma pagos en efectivo (o sin tipo, históricos). Las reversiones copian el tipo del original y se netean igual. |
| `CollectorExpensesPage` | Id de operación estable por formulario, reutilizado en cada reintento. |
| `CollectorCashClosePage` | «Recaudado en efectivo por ti» y aviso visible cuando el saldo es negativo. |

## Fórmula verificada (fuente única: `personalCashPosition` → `computeExpected`)

```
efectivo en manos = faltante arrastrado del último cuadre
                  + Base recibida (de la ruta o de un compañero)
                  − Base devuelta / entregada / traspasada
                  + recaudos EN EFECTIVO del ciclo
                  − desembolsos hechos por la persona
                  − gastos atribuidos a la persona
```

La misma función alimenta «Mi efectivo», el cuadre por trabajador, la custodia, los
traspasos y la conciliación de la ruta. No hay fórmulas paralelas.

## Saldos negativos

- Se registran y se muestran tal cual (`esperado < 0`). No crean Base, capital ni
  custodia. La caja Sin asignar de la ruta no cambia. La Base de la ruta baja una sola vez.
- Un negativo **no** ofrece efectivo traspasable ni devolvible (`transferableCash = 0`).
- Lo «Disponible» de la ruta es `min(Base, Sin asignar)`. Con un trabajador en negativo
  baja por el importe del gasto: es conservador y nunca sube.
- **En el cuadre:** con esperado −100 y entregado 0, la diferencia es +100. Las reglas
  vigentes lo registran como **sobrante con motivo obligatorio** (p. ej. «pagó el
  combustible de su bolsillo»). El ciclo siguiente parte de 0 y el efectivo físico sin
  asignar no cambia (`EXP-CASH-010`). Si la empresa reembolsa ese adelanto, se decide
  fuera del sistema. Es una decisión de negocio pendiente: hoy un sobrante no se
  convierte en saldo a favor.

## Pruebas

`npm run test:expensecash` (14 casos) cubre los diez escenarios del reporte, los
controles de capital que deben seguir activos y los contratos de pantalla.
`EXP-CLASS-015` se actualizó: antes exigía el bloqueo y ahora exige el negativo para
el gasto de trabajador y el rechazo para el gasto de ruta.
