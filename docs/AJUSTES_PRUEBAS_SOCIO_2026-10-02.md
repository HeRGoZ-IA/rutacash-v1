# Ajustes de pruebas del socio — 2026-10-02

Backlog de 9 ajustes nacidos de las pruebas reales del socio. Se implementan **en
este orden**, una ronda por punto. Un punto solo se marca cerrado cuando sus
pendientes derivados (1.a, 1.b…) están resueltos.

| Ronda | Estado |
|---|---|
| 1 | Cerrada y publicada (`c8bd1e1`; verify:deploy 32/32; smoke A–H PASS) |
| 2 | Cerrada y publicada (`b3f2ab6`; verify:deploy 33/33; smoke A–H PASS) |
| 3 | Cerrada (commit local, pendiente de revisión antes de push/deploy) |
| 4–9 | Sin iniciar |

## Checklist maestro

- [x] 1. Cobrador solo 20%; 10% vía Secretaría
- [x] 2. Aviso de crédito activo en Secretaría
- [x] 3. Anulación/reversión auditable de movimientos financieros
- [ ] 4. Base unificada entre módulos
- [ ] 5. Auditoría del origen de Base en Supervisor
- [ ] 6. Traspaso de efectivo entre trabajadores de una misma ruta
- [ ] 7. Reversión de pagos y recálculo completo
- [ ] 8. Sincronización de anulaciones
- [ ] 9. Clasificación de gastos

---

## 1. Cobrador solo 20%; 10% vía Secretaría — CERRADO

**Regla implementada** (`src/lib/interestRatePolicy.ts`, pura y única):

- Catálogo global de tasas: `ALLOWED_INTEREST_RATES = [10, 20]` — **no se recorta**.
- Rol `cobrador` origina créditos únicamente al `COLLECTOR_INTEREST_RATE = 20`.
- Resto de roles que originan (`supervisor`, `admin`, `superadmin`): 10% o 20%, sin cambios.
- El 10% para operaciones del Cobrador se aplica en la **autorización**: el
  `secretario` (y los demás autorizadores con `authorization.modifyConditions`)
  cambia la tasa al aprobar la solicitud. Ese flujo ya existía y no se tocó.

Modelo real de roles: no existe un rol "Secretaría"; es `secretario`, que **no
origina** ventas (no tiene `sale.createRequest` ni `sale.createDirect`) y sí aprueba,
rechaza y modifica condiciones. El Cobrador no tiene `sale.createDirect`: toda venta
suya entra como solicitud.

**Validación de dominio** (`src/services/saleRequestService.ts`):
`assertOriginationRate(input, actor)` en `createDirectSale` y `createSaleRequest`,
antes de cualquier lectura de integridad y de toda escritura. La regla mira al
**actor** autenticado, no a `createdByUserId` del payload. No se puso en
`assertSaleIntegrity` porque la aprobación la reutiliza con el Cobrador como
creador y la tasa final del autorizador (que sí puede ser 10%).

**UI** (`CollectorNewSalePage.tsx`, `CollectorNewClientPage.tsx`, compartidas con el
Supervisor): las opciones salen de `originationRatesFor(user.rol)`. Con una sola
tasa (Cobrador) se muestra un campo fijo de solo lectura «Tasa de interés: 20%»; el
Supervisor conserva el selector 10%/20%. Sin textos explicativos añadidos. La
validación del formulario usa `originationRateError`. (No se usa `rol === 'cobrador'`
en la pantalla: la prueba existente MOBILE-PARITY-004 lo prohíbe en la capa operativa.)

**Históricos:** sin migración Dexie (sigue v15), sin recálculo. Los créditos al 10%
conservan su `tasaInteres`, cuotas y saldo; reportes e historiales leen el valor almacenado.

**Archivos modificados**

- `src/lib/interestRatePolicy.ts` (nuevo)
- `src/services/saleRequestService.ts`
- `src/pages/collector/CollectorNewSalePage.tsx`
- `src/pages/collector/CollectorNewClientPage.tsx`
- `tests/interestrate.test.ts` (nuevo) · `package.json` (`test:interestrate`, incluido en `npm test`) · `.gitignore`
- `scripts/verify-deploy.mjs` (marcador de esta entrega)

**Tests agregados** (`npm run test:interestrate`, Dexie real): TASA-001 … TASA-008, 8/8 PASS.
Prueba de mutación: con la validación de servicio desactivada fallan TASA-002, 007 y 008.

**Decisiones técnicas**

- Admin/SuperAdmin (`ActiveSalesPage`, `ClientsPage`) sin cambios: siguen con 10/20.
- Límite conocido (no es un pendiente de esta ronda): la app es local-first sin
  backend; una escritura directa a IndexedDB desde DevTools no pasa por ningún
  servicio. La regla cubre todos los caminos de la aplicación (servicio, payload,
  estado, capacidades delegadas). Blindarlo contra escritura cruda exige backend.

**Pendientes derivados:** ninguno.

---

## 2. Aviso de crédito activo en Secretaría — CERRADO

**Diagnóstico**

- La solicitud guardaba `activeCreditSaleIds` (IDs de los créditos activos, leídos
  en la misma transacción) y `authorizationReason: 'active-credit'`. **No** guardaba
  saldo ni estado de esos créditos: con eso solo se podía mostrar el estado actual.
- `SecretarioAuthorizationsPage` (modal "Solicitud de venta") no usaba esos campos.
  Sí cargaba las ventas del cliente para un "Historial", pero sin filtrar por empresa
  ni por ruta, y sin limpiar el estado al abrir otra solicitud (podía mostrar un
  instante el historial del cliente anterior).
- Solo el listado móvil del Supervisor (`CollectorAuthorizationsPage`) mostraba una
  línea "Cliente con crédito activo".

**Solución**

- Fotografía mínima al solicitar: `SaleRequest.activeCreditSnapshot`
  (`saleId`, `saldo`, `valorTotal`, `status`), escrita en `createSaleRequest` dentro
  de la misma transacción que ya leía los créditos. Campo opcional y sin índice:
  **sin cambio de esquema** (Dexie sigue en v15). No cambia ninguna regla.
- `src/lib/activeCreditContext.ts` (puro): combina **al solicitar** (IDs + fotografía)
  con **ahora** (ventas leídas en vivo). Incluye también créditos activos aparecidos
  después de la solicitud. Excluye la venta nacida de la propia solicitud. Devuelve
  `null` si no hay nada que mostrar.
- `getActiveCreditContext(requestId, actor)` en `saleRequestService`: relee la
  solicitud; exige misma empresa y `authorization.access` sobre su ruta; filtra
  ventas por empresa; de rutas sin `sale.viewActive` solo informa que el crédito existe.
- `ActiveCreditNotice` en el detalle de la solicitud, debajo del valor solicitado y
  antes de Condiciones / Aprobar / Rechazar (también visible en modo rechazo).

**Snapshot vs estado actual (decisión)**

- Cada crédito se muestra con su estado **actual** (monto, ruta, estado, saldo de
  total, fecha de inicio).
- El valor **al solicitar** solo aparece cuando difiere ("al solicitar: saldo X"); si
  coincide no se duplica.
- Crédito activo al solicitar y ya no activo ahora: cabecera gris "Solicitada con
  crédito activo · hoy ya no está activo" + estado real (p. ej. Finalizado). El
  motivo histórico (`authorizationReason`, IDs, fotografía) no se modifica.
- Varios créditos: "Cliente con N créditos activos" y una fila por crédito, sin límite.
- Solicitudes anteriores a esta ronda (solo IDs): estado actual, sin inventar valores
  del pasado.

**Pendiente derivado resuelto en la ronda**

- 2.a Historial del cliente del mismo modal: ahora filtrado por empresa y por las
  rutas visibles del Secretario (igual que el aviso), y vaciado al cambiar de
  solicitud (se descartan respuestas tardías de la anterior).

**Archivos**

- `src/models/types.ts` (`ActiveCreditSnapshot`, `SaleRequest.activeCreditSnapshot`)
- `src/services/saleRequestService.ts` (fotografía + `getActiveCreditContext`)
- `src/lib/activeCreditContext.ts` (nuevo)
- `src/components/ui/ActiveCreditNotice.tsx` (nuevo)
- `src/pages/secretario/SecretarioAuthorizationsPage.tsx`
- `tests/activecredit.test.ts` (nuevo) · `package.json` (`test:activecredit` en `npm test`) · `.gitignore`
- `scripts/verify-deploy.mjs` (marcador R2)

**Tests**: `npm run test:activecredit`, CREDITO-ACTIVO-SEC-001 … 010, 10/10 PASS.
Mutación: sin fotografía o sin recorte por ruta fallan 003, 005, 006 y 007.
Verificado además en la app real (Chrome headless, 420 px): sin crédito → sin aviso
(también justo después de abrir uno con aviso); abono posterior; dos créditos;
crédito cancelado.

**Pendientes derivados:** ninguno abierto.

---

## 3. Anulación/reversión auditable de movimientos financieros — CERRADO

**Diagnóstico**

- Tipos existentes: `capitalMovements` (`ingresoCapital`; `ajusteCapital` existe en el
  tipo pero nada lo crea), `withdrawals`, `transfers` (Ruta↔Ruta, Socio→Ruta,
  Ruta→Socio, Socio↔Socio) y `partnerCashMovements`. Se crean solo desde
  `routeFundsService` (y el capital inicial en `routeService.createRoute`).
- Una transferencia tiene hasta tres patas en UNA transacción: la `Transfer`, 0–2
  `PartnerCashMovement` (`relatedTransferId`) y, si se entregó en mano, una
  `CashCustodyMovement` BASE_ASSIGNMENT (`relatedTransferId`).
- Todos los agregados suman algebraicamente sin filtrar: `getCashboxSummary` (Base),
  `computeRouteCashReconciliation`, liquidación semanal, Caja socios
  (`buildPartnerSummaries`), custodia (`custodyInCycle`) y los totales de pantalla.
- No existía ninguna edición ni borrado de estos movimientos (nada que bloquear).
- El modal del socio ("Movimientos · Barreiro", Entrante/Saliente/Neto) es el de
  **Transferencias**: los +21.000 / +21.500 eran aportes Socio → Barreiro.

**Modelo de reversión** (`MovementReversalFields`, campos opcionales sin índice)

- Original: `reversalId`, `reversedAt`, `reversedByUserId`, `reversalReason` → ANULADO.
- Reversión: asiento espejo (mismo tipo, mismos extremos, importe NEGADO, fecha de
  la anulación) con `reversesId` → original y el mismo motivo.
- Registros antiguos sin campos = vigentes. **Sin migración** (Dexie sigue en v15).

**Estrategia contable (única):** el libro conserva original y reversión; los
agregados los suman (neto 0). El estado ANULADO es solo auditoría/presentación:
ningún agregador filtra por estado (no hay doble corrección). Ningún agregador se
modificó. La reversión lleva la fecha de HOY: no reescribe periodos ya liquidados.

**Servicio** `movementReversalService` (`reverseCapitalMovement`, `reverseWithdrawal`,
`reverseTransfer`)

- Una transacción Dexie por anulación; el original se relee dentro y se exige
  vigente → doble anulación y doble clic concurrente dan una sola reversión.
- Una reversión no es anulable (sin cadenas A→B→A).
- Motivo obligatorio (recortado, máx. 200), persistido en original y reversión.
- Transferencia: revierte la transferencia + sus patas de Caja socios + la custodia
  en mano (devolución técnica BASE_RETURN de esa persona), todo o nada.
- Si la anulación SACA dinero de una Route rige la regla del retiro: no puede
  superar la caja no asignada. Lo entregado en mano solo se revierte si la persona
  aún lo tiene; si no, se rechaza con mensaje claro.
- Bitácora: `MOVEMENT_REVERSED` con motivo y vínculo.

**Permisos:** la misma capacidad y alcance que para registrar ese movimiento —
`capital.manage` + ruta autorizada (capital, retiros); `transfer.create` +
`isTransferInScope` (transferencias). Hoy: Super Admin y Admin (en sus rutas).
Supervisor, Cobrador, Secretario y Socio no pueden (incompatibles en la matriz).

**UI:** Capital, Retiros y Transferencias → "Ver movimientos": acción "Anular" por
fila (solo si el usuario puede y el movimiento es vigente), confirmación con tipo,
valor, fecha, origen/destino y motivo obligatorio, botón bloqueado mientras procesa.
El original queda tachado con etiqueta "Anulado" y debajo su reversión (valor,
fecha, quién, motivo). Totales de tarjeta y modal = efecto vigente. Caja socios
(Admin y Socio) muestra las patas revertidas con su signo y "Anulado".

**Caso real reproducido:** aportes Socio → Barreiro 21.000 + 21.500 (Entrante y Neto
42.500). Anular 21.500 → Entrante 21.000, Neto 21.000, el 21.500 sigue visible como
anulado con su reversión, Caja socios del socio neteada.

**Archivos**

- `src/models/types.ts` (`MovementReversalFields`, acción `MOVEMENT_REVERSED`)
- `src/lib/movementReversal.ts`, `src/lib/transferTotals.ts` (nuevos, puros)
- `src/services/movementReversalService.ts` (nuevo)
- `src/components/ui/MovementReversal.tsx` (nuevo)
- `src/pages/admin/TransfersPage.tsx`, `CapitalPage.tsx`, `WithdrawalsPage.tsx`,
  `PartnerCashPage.tsx`, `src/pages/socio/SocioPartnerCashPage.tsx`
- `tests/financialreversal.test.ts` (nuevo) · `package.json` · `.gitignore` ·
  `scripts/verify-deploy.mjs` (marcador R3)

**Tests:** `npm run test:financialreversal`, FIN-REV-001 … 015, 15/15 PASS.
Mutaciones: sin la validación de estado fallan 005 y 011; sin el control de fondos
falla 015. Verificado en la app real (1280 px y 420 px): caso Barreiro, motivo
obligatorio (botón deshabilitado), doble clic → 1 reversión, anulado visible,
Admin con otra ruta no ve Barreiro, Socio no entra al panel.

**Límites (decisiones, no inconsistencias)**

- Anular dinero que ya no está en la caja no asignada (prestado o entregado como
  Base) se rechaza, igual que un retiro. Primero debe volver a la caja.
- Con filtro de fechas que excluya el día de la anulación, la vista muestra el
  original (anulado) sin su reversión; sin filtro, el efecto vigente.
- Movimientos creados directamente en Caja socios (no por transferencia) no se
  anulan en esta ronda: no son capital/retiro/transferencia.

**Pendientes derivados:** ninguno.

---

## Hallazgos registrados para rondas posteriores (sin implementar)

- **Punto 4/5 (Base):** conviven dos "Base": el libro (`getCashboxSummary.saldoActual`,
  que muestran Capital y Retiros como "Base actual") y la caja no asignada
  (`computeRouteCashReconciliation.disponible`, que limita retiros y anulaciones).
  `Route.capitalActual` está deprecado pero sigue persistido.
- **Punto 6:** ya existe `transferBaseBetweenWorkers` (custodia PERSON_TO_PERSON) en
  `cashCustodyService`; revisar si falta solo la UI.
- **Punto 7:** los pagos usan otra convención de reversión (`state`
  'reversed'/'reversal', y los reportes FILTRAN ambos). `getCashboxSummary` suma los
  pagos en bruto: equivale solo mientras la reversión tenga importe negado y caiga
  en el mismo rango de fechas que el original. Revisar al tratar la reversión de pagos.
- (Ronda 2) Fuera del backlog: la pantalla de autorizaciones del Admin (`SaleAuthorizationsPage`)
  y el detalle móvil del Supervisor (`CollectorAuthorizationsPage`) podrían reutilizar
  `ActiveCreditNotice`/`getActiveCreditContext`; hoy el Admin no ve el aviso y el
  Supervisor solo ve una línea en el listado. No se tocó (el punto 2 es Secretaría).
