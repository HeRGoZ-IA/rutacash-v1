# Ajustes de pruebas del socio — 2026-10-02

Backlog de 9 ajustes nacidos de las pruebas reales del socio. Se implementan **en
este orden**, una ronda por punto. Un punto solo se marca cerrado cuando sus
pendientes derivados (1.a, 1.b…) están resueltos.

| Ronda | Estado |
|---|---|
| 1 | Cerrada y publicada (`c8bd1e1`; verify:deploy 32/32; smoke A–H PASS) |
| 2 | Cerrada (commit local, pendiente de revisión antes de push/deploy) |
| 3–9 | Sin iniciar |

## Checklist maestro

- [x] 1. Cobrador solo 20%; 10% vía Secretaría
- [x] 2. Aviso de crédito activo en Secretaría
- [ ] 3. Anulación/reversión auditable de movimientos financieros
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

## Hallazgos registrados para rondas posteriores (sin implementar)

- Fuera del backlog: la pantalla de autorizaciones del Admin (`SaleAuthorizationsPage`)
  y el detalle móvil del Supervisor (`CollectorAuthorizationsPage`) podrían reutilizar
  `ActiveCreditNotice`/`getActiveCreditContext`; hoy el Admin no ve el aviso y el
  Supervisor solo ve una línea en el listado. No se tocó (el punto 2 es Secretaría).
- Sin hallazgos nuevos para los puntos 3–9 en esta ronda.
