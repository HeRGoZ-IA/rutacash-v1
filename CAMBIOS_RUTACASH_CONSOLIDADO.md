# RutaCash V1 — Documento consolidado de cambios

**Última actualización:** 2026-06-23
**Ruta del proyecto:** `C:\HRWorkSpace\01_PRODUCTOS_COMERCIALES\RutaCash`
**Stack:** React + Vite + TypeScript + Tailwind + Zustand + Dexie (IndexedDB, local-first).

Este documento **unifica** todos los cambios realizados (paquetes 1, 2, 2.5, 3, App Cobrador,
Administrador, eliminación de Oficinas y capital), evitando redundancias. Reemplaza a los
`CAMBIOS_*`/`AUDITORIA_*` individuales (quedan como punteros a este archivo).

> **Restricciones respetadas en todo momento:** sin backend/Supabase, sin auth real, sin sync real,
> sin commit/push/deploy, sin tocar GitHub/Vercel. No se rompió la lógica financiera validada
> (parcelas/abonos/caja/liquidación). Dinero **entero sin centavos**.

---

## 0. Migración
Proyecto migrado el **2026-06-20** desde `C:\TradingBot\CobrosApp` →
`C:\HRWorkSpace\01_PRODUCTOS_COMERCIALES\RutaCash` (detalle de git/env en
`README_MIGRACION_RUTACASH.md`). Contexto de producto en `AUDITORIA_RUTACASH_V1_SOCIO.md`.
Instalar/ejecutar:
```
npm install
npm run dev:demo     # datos de demostración
npm run dev:clean    # base limpia (1 admin)
npm run build        # tsc + vite (validación obligatoria)
```

## 1. Modelo de datos y versiones Dexie
- **Empresa = `tenant`**. Jerarquía actual: **Empresa → Rutas → Clientes → Ventas → Parcelas/Abonos**.
- **Versiones IndexedDB:**
  - **v1**: esquema base.
  - **v2**: + tabla `saleRequests` (solicitudes de venta).
  - **v3**: se **elimina la tabla `offices`** y los índices `officeId`. `officeId` queda como campo
    **legacy opcional** ignorado por la app.
- Campos nuevos relevantes (opcionales, sin migración de datos): `Sale.disbursementStatus`,
  `Sale.saleRequestId`, `User.authorizedRouteIds`, `User.canCreateDirectSales`,
  `User.maxDirectSaleAmount`, `Client.fotoDocumentoUrl/fotoNegocioUrl`,
  `Expense.receiptPhotoDataUrl`.

---

## 2. Paquete 1 — Identidad y datos base
- Colorimetría **azul** restaurada.
- **Configuración de empresa** simplificada (nombre, país, ciudad, moneda, etc. en `Tenant`).
- Cliente exige **dirección de residencia** y **dirección de negocio/cobro**.
- Ventas con **tasa seleccionable 10% / 20%** (sin tasa libre en la UI principal).
- **Fecha de inicio** de cobro no permite fechas anteriores a hoy.
- Se añadió `Sale.paymentDays: number[]` (días de cobro).

## 3. Paquete 2 — Días de pago operativos + venta desde Nuevo Cliente
- `paymentDays` operativo en el **motor de parcelas** (`computeInstallmentDates`), respetando
  frecuencia (diaria/semanal/quincenal/mensual). Ventas antiguas sin `paymentDays` siguen igual.
- La **app del cobrador** considera días programados y parcelas vencidas.
- Se puede **crear cliente + venta + parcelas** desde el módulo Clientes con **transacción Dexie**
  (atómica). Ventas antiguas no se rompen.

## 4. Paquete 2.5 — Pulido de formularios y datos base
- **Modales** Nuevo cliente / Nueva venta con ancho equilibrado (`mdPlus`).
- **Documento como primer campo** en alta de cliente.
- **Validación global de documento duplicado** (mismo tenant, normaliza espacios/puntos/guiones;
  bloquea y muestra el cliente existente; permite conservar el propio al editar).
- **Fotos del cliente** (documento y negocio): `PhotoInput` + compresión con canvas
  (`resizeImageToDataUrl`, ≤1280px, JPEG ~0.78), guardadas como Data URL. Visibles en la ficha.
- **Inputs monetarios** con formato moneda (`MoneyInput` + `parseCurrencyInput`/
  `formatCurrencyInput`): muestran separadores y símbolo, guardan **números enteros**.
- **Lista de monedas** ampliada (Suramérica y Centroamérica): COP, USD, EUR, MXN, PEN, ARS, VES,
  CLP, BRL, UYU, PYG, BOB, CRC, GTQ, HNL, NIO, PAB, DOP, SVC.

## 5. Paquete 3 — Supervisor, capital agrupado, gastos predeterminados
- **Supervisor** con **rutas autorizadas**: sección propia `/supervisor` (experiencia tipo
  cobrador, solo lectura), sin acceso al panel admin ni a oficinas/usuarios/configuración.
- **Capital agrupado por ruta** (una tarjeta por ruta con su detalle de movimientos).
- **Gastos predeterminados** (categorías genéricas) sembradas en modo limpio/reset si no existen.

---

## 6. App Cobrador (actualización mayor + UX + pulido)
- **Selección de ruta primero**: al iniciar sesión el cobrador elige ruta (si tiene varias) o entra
  directo (si tiene una). Sin rutas → mensaje claro. **Ruta activa** persistida; "Cambiar ruta" en
  el encabezado. Todas las vistas respetan la ruta activa.
- **Dashboard en 4 bloques** (sin lista larga): **Recaudo**, **Clientes y ventas**, **Gastos y
  cuadre**, **Sincronización**. KPIs superiores (Pendientes / Abonado hoy / Ventas activas)
  uniformes y compactos con fondos tenues (ámbar/verde/azul).
- **Nuevo cliente** desde el cobrador (documento primero, fotos, validación de duplicado) y opción
  **"Crear venta ahora"** en el mismo flujo.
- **Nueva venta / Solicitud de venta** según autorización:
  - Config por usuario: `canCreateDirectSales` + `maxDirectSaleAmount`. Por defecto **siempre
    solicita** (más seguro).
  - Dentro de límite y autorizado → **venta directa**; si no → **solicitud** ("Esta venta requiere
    autorización del administrador").
- **Desembolsos**: al aprobar una solicitud se crea la venta como `disbursementStatus: 'pendiente'`
  (no cobrable) hasta que el cobrador **confirma el desembolso** → pasa a `desembolsado`.
- **Recaudo** con estados **verde/amarillo/rojo** (verde sin atraso, amarillo 1–3 días, rojo >3 o
  vencida), saldo, valor de parcela, último abono y parcelas atrasadas; respeta días programados y
  cuotas vencidas. No lista ventas no desembolsadas.
- **Abonos** (vocabulario "Abono/Parcela"), parcial/completo/total; no permite abonar ventas no
  desembolsadas.
- **Gastos** con **foto de soporte** (`receiptPhotoDataUrl`).
- **Informe del día**, **Cuadre** (saldo esperado = abonos − ventas desembolsadas − gastos) e
  **Histórico de abonos** por cliente/venta.
- **Badge de Desembolsos** dinámico (bloque y menú inferior), por ruta activa.

## 7. Administrador
- **Autorizaciones de ventas** (menú "Autorizaciones" con **badge** de pendientes): lista + detalle
  (datos/fotos del cliente, condiciones, historial de ventas) + **aprobar/rechazar** con motivo.
- **Tablas con filas clicables** (hover + cursor) en Clientes, Ventas Activas, Autorizaciones y
  Usuarios; se quitaron iconos ver/editar/ojito/lápiz/Revisar (acciones críticas con
  `stopPropagation`).
- **Ficha de Cliente** profesional: encabezado, contacto, **fotos/placeholder**, resumen financiero
  (ventas totales/activas/cerradas/perdidas, total trabajado, total abonado, saldo), historial de
  ventas y abonos recientes.
- **Ventas Activas**: columna **Fecha**; el detalle se abre por clic de fila.
- **Usuarios**: fila → edición; **columna central de badges** por rol (rutas asignadas/autorizadas,
  venta directa/límite, estado).
- **KPIs/badges** consistentes (componente `CountBadge`, ámbar).

## 8. Rutas asignadas y sincronización Ruta ↔ Cobrador
- Un **cobrador puede tener una o muchas rutas asignadas** (concepto "rutas asignadas", se eliminó
  "ruta principal/alterna"). Helper canónico `getAssignedRouteIds` (consolida `authorizedRouteIds`
  + `routeId` legacy). La App Cobrador usa esta lógica.
- **Sincronización bidireccional** (`routeAssignment.ts`): asignar cobrador en una ruta lo agrega a
  sus rutas (sin borrar las demás) y lo quita del anterior; cambiar las rutas del cobrador deja
  `route.cobradorId` coherente. En conflicto gana la asignación más reciente.

## 9. Administrador con acceso a todas las oficinas → Eliminación de Oficinas
- Se confirmó que **Oficina = Empresa**. Se **eliminó "Oficinas"** como entidad operativa:
  - **Paso A (funcional):** se quitaron el módulo Oficinas, el selector de oficina, los filtros por
    oficina y los campos de oficina en formularios; **Liquidación** corre sobre **todas las rutas
    del tenant**; checklist y métrica de plataforma sin oficina.
  - **Paso B (técnico):** **Dexie v3** elimina la tabla `offices` e índices `officeId`; se quitaron
    `Office`/`OfficeStatus`/`'DELETE_OFFICE'` y `useAuth.office`/`selectOffice`; `officeId` quedó
    opcional legacy; el seed ya no crea oficinas; el backup no las incluye.
  - Cobrador (rutas asignadas), Supervisor (rutas autorizadas) y Plataforma intactos.

## 10. Capital de las Rutas
- **Tope por capital disponible**: no se permite crear una venta mayor al **capital disponible** de
  la ruta. Se muestra aviso y se **bloquea** la creación (admin Ventas y Crear crédito; cobrador
  venta directa). Las **solicitudes** sí pueden enviarse (las decide el admin).
- **Capital disponible** = saldo de caja calculado (`getRouteAvailableCapital`):
  `capital + cobros + transf. entrantes − préstamos entregados − gastos − transf. salientes − retiros`.
- **Corrección visual:** antes "Capital actual" leía `route.capitalActual` (estático, no cambiaba).
  Ahora **Capital/Rutas muestran el disponible calculado** (refleja inyecciones, ventas, abonos,
  gastos y retiros). `route.capitalActual` queda legacy sin uso visual.

## 11. Rutas — código interno automático
- **Ya no se pide código** de ruta al usuario. Se genera **interno y ordenado**:
  **`RT-00001`, `RT-00002`, …** (secuencial por ruta creada, `padStart` a 5 dígitos). El formulario
  de ruta pide nombre y ciudad; el código se muestra solo como referencia al editar.

## 11-bis. Restablecer app limpia (reset local del navegador)
Botón seguro (Configuración + banner) que borra **todos los datos locales de RutaCash en el
navegador**: IndexedDB/Dexie, `localStorage`/`sessionStorage` con prefijo `rutacash-`, Cache Storage
y Service Workers del dominio; luego recarga a `/login` y la semilla del modo se reinicializa.
En **CLEAN** deja solo el admin inicial + categorías base (sin rutas/clientes/ventas/abonos); en
**DEMO** el equivalente “Restaurar datos demo” recarga los datos ficticios. Helper
`src/lib/resetApp.ts` (`resetLocalAppData`). Detalle: `CAMBIOS_RESET_APP_LIMPIA.md`. No borra el
caché global del navegador ni datos de otros sitios; requiere confirmación (no es automático).

---

## 12. Vocabulario (UI)
Clientes · Rutas · Ventas · **Parcelas** · **Abonos** · **Desembolsos** · Gastos · **Cuadre** ·
Cobrador · Administrador. Se evita "crédito/cuota/pago/préstamo" en la App Cobrador cuando hay
alternativa. Nombres técnicos internos (sales, installments, payments) se conservan.

## 13. Archivos clave creados/modificados (referencia rápida)
- **Componentes UI:** `MoneyInput`, `PhotoInput`, `KpiCard`, `CountBadge`, `Modal` (tamaño `mdPlus`).
- **Hooks:** `useCollectorRoute` (ruta activa), `useRouteCapital` (capital disponible),
  `useTenant`, `useAuth`. (`useOfficeFilter` quedó huérfano tras eliminar oficinas.)
- **Servicios:** `installmentEngine` (parcelas + estados verde/amarillo/rojo + desembolso),
  `cashboxEngine` (`getRouteAvailableCapital`), `weeklySettlementEngine` (por tenant),
  `saleRequestService` (ventas/solicitudes/desembolso), `routeAssignment` (sync ruta↔cobrador).
- **Datos:** `db.ts` (Dexie v1/v2/v3), `seed.ts`, `lib/roles.ts`, `lib/formatters.ts`,
  `lib/image.ts`.
- **Páginas:** admin (Dashboard, Rutas, Clientes, ActiveSales, SaleAuthorizations, Capital,
  Expenses, Transfers, Withdrawals, Cashbox, Reports, WeeklySettlement, Users, Settings) y
  collector (Home, SelectRoute, Route/Recaudo, NewClient, NewSale, Disbursements, Payment,
  DailyReport, CashClose, PaymentHistory, Expenses).

## 14. Pendientes para V2
- Cierre semanal / bloqueo de domingo (con diseño claro).
- Registro de pagos por el supervisor (hoy solo revisa).
- CRUD de categorías de gasto; listado final de gastos del socio.
- Fecha real de desembolso y parcela exacta por abono (informes más precisos).
- Backend/Supabase, sync real, permisos granulares, code-splitting del bundle.
- Eliminar físicamente huérfanos `useOfficeFilter.ts` y el stub `OfficesPage.tsx`; quitar `officeId`
  legacy del modelo si se desea.

## 15. Pruebas manuales clave
- [ ] `npm run dev:demo` y `npm run dev:clean` funcionan; `npm run build` sin errores.
- [ ] Login admin/cobrador/supervisor; cobrador elige ruta y opera (recaudo/abono/gastos/cuadre).
- [ ] Cliente: documento primero, duplicado bloqueado, fotos visibles; ficha completa.
- [ ] Venta directa vs solicitud según autorización; aprobar → desembolsar → recaudo.
- [ ] **Capital**: inyectar capital sube el **Capital disponible**; venta lo baja; abono lo sube;
      venta mayor al disponible se **bloquea**.
- [ ] **Rutas**: crear ruta genera código `RT-00001…` sin pedirlo; no hay "Oficinas" en la app.
- [ ] Admin/Supervisor/Plataforma sin romperse; build final exitoso.
