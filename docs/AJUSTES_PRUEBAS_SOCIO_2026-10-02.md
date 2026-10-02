# Ajustes de pruebas del socio — 2026-10-02

Backlog de 9 ajustes nacidos de las pruebas reales del socio. Se implementan **en
este orden**, una ronda por punto. Un punto solo se marca cerrado cuando sus
pendientes derivados (1.a, 1.b…) están resueltos.

| Ronda | Estado |
|---|---|
| 1 | Cerrada (commit local, pendiente de revisión antes de push/deploy) |
| 2–9 | Sin iniciar |

## Checklist maestro

- [x] 1. Cobrador solo 20%; 10% vía Secretaría
- [ ] 2. Aviso de crédito activo en Secretaría
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

## Hallazgos registrados para rondas posteriores (sin implementar)

- **Punto 2:** `SaleRequest.activeCreditSaleIds` y `authorizationReason: 'active-credit'`
  ya se guardan al crear la solicitud, y existe `findActiveSaleForClient`. Son la base
  natural para el aviso en `SecretarioAuthorizationsPage`.
