# ADEX Online — Auditoría de nombres de la interfaz

| | |
|---|---|
| Fecha | 2026-10-24 |
| Encargo | «Quiero saber si hay otros nombres que significan lo mismo, o un mismo nombre que dice dos cosas diferentes» |
| Alcance | Textos visibles de ADEX Online: `online/src/**` y las pantallas de CLEAN (`src/`) que Online compila. Quedan fuera las pantallas que solo usaba CLEAN y el Socio |
| Método | Revisión de solo lectura del código, contrastando cada rótulo con el valor que muestra. Los hallazgos graves (§3) se verificaron uno a uno. **No se cambió nada** |
| Estado | Propuesta. Requiere aprobación del propietario antes de aplicarse |

## 1. Vocabulario propuesto (un concepto, un nombre)

| Concepto | Nombre único propuesto | Hoy también se llama |
|---|---|---|
| Dinero propio de la ruta (`route_base`) | **Base disponible** | Base de la ruta, Base de ‹ruta›, su Base, Caja de la ruta, fondos de la ruta |
| Dinero en manos de un trabajador (`custody`) | **Base del trabajador** | custodia(s), Efectivo en custodias, Efectivo del trabajador / del Cobrador, En manos de…, A cargo de trabajadores, Mi efectivo, Efectivo a tu cargo, caja del trabajador, Capital recibido |
| Base disponible + Base del trabajador | **Efectivo de la ruta** (consolidado: **Efectivo de las rutas**) | Efectivo total, Dinero de la ruta |
| Saldo que quedó de antes de Base por Ruta | **Saldo sin asignar** | Saldo anterior de X, Saldo del Administrador, el saldo de X, Anterior a Base por Ruta, Empresa (anterior…) |
| Capital pendiente de los créditos, sin interés | **Capital colocado** | Cartera pendiente, Prestado (cartera) |
| Saldo pendiente de los créditos, con interés | **Cartera activa** | Cartera, Cartera en calle, Cartera con interés, Saldo pendiente |
| Dinero cobrado a clientes | **Recaudo** | Cobros, Cobranza, Abonos, Pagos recibidos, Total cobrado |
| Dinero entregado al cliente al prestar | **Desembolso** | Préstamos entregados, Préstamos |
| El producto | Decisión pendiente: **Venta** o **Crédito** | Venta, Crédito, Préstamo (los tres conviven) |
| Base disponible → trabajador | **Entrega de Base** | Entrega a trabajador, Entregar capital, Capital recibido |
| Trabajador → Base disponible | **Devolución de Base** | Recepción de devolución de Cobrador, Devolución del trabajador, Devolución de base |
| Dinero externo que entra a una ruta | **Inyección de Base** | Aporte externo, Aportes a la Base, Ingreso de capital |
| Base de una ruta → otra ruta | **Transferencia entre rutas** | Transferencia de Base entre rutas (y «Traspaso entre rutas», que es otra operación) |
| Persona que maneja efectivo en la ruta | **Trabajador** (y Cobrador o Supervisor solo cuando importa el rol) | En Transferencias se dice «Cobrador» aunque la lista incluye Supervisores |
| Administrador que responde por el dinero de la ruta | **Responsable de capital** | Responsable, Responsable de la ruta, responsable vigente |
| Arqueo del trabajador / cierre semanal de ruta | **Cuadre** / **Liquidación** | El Cobrador ve «Cuadre» en el menú y «Mi efectivo» como título |

## 2. Un mismo nombre para cosas distintas

| Nombre | Significados que tiene hoy | Riesgo |
|---|---|---|
| **Cartera** | Solo capital (Dashboard: «Cartera pendiente»; Capital: «Prestado (cartera)») · capital + interés (Rutas, Selector de ruta, Cuadre del Cobrador: «Cartera activa») · capital + interés calculado por parcelas (Oficinas) | **Alto**: el Dashboard dice R$ 37.944,99 y Rutas R$ 45.444 para la misma ruta |
| **Base de la ruta** | Base disponible (Transferencias, Diferencias, Reportes, Gastos) · suma de la Base del trabajador (Cuadre del Cobrador «Caja de la Ruta», Liquidación → Cuadre por trabajador, Rutas si falla el panel) | **Alto** (§3) |
| **Efectivo de la ruta** | Base disponible + Base del trabajador (Caja principal) · solo Base del trabajador (Liquidación → Cuadre por trabajador) | **Alto** |
| **Total controlado** | Base disponible + Base del trabajador + Cartera activa (Rutas) · Base del trabajador + Cartera activa, sin Base disponible (Oficina) | Medio: Rutas y Oficina no coinciden |
| **Retiros** | Retiro de Base (Caja principal) · devoluciones de trabajadores (Liquidación y Consultas «Caja por ruta») · retiro de capital de la empresa | Medio |
| **Saldo final / anterior** | Base del trabajador de la ruta (Liquidación) · saldo de la perspectiva (Consultas) · Base disponible (detalle de Caja principal) · bolsa heredada («Saldo anterior de X») | Medio |
| **Aporte** | Inyección de Base · aporte de una ruta a un gasto general · capital externo de la empresa | Bajo-medio |
| **Entrega** | Cambio de responsable de una ruta («Ruta en entrega») · Entrega de Base a un trabajador · lo que el trabajador entrega al cuadrar | Medio |
| **A cargo de trabajadores** | Base del trabajador (Capital, modelo anterior) · faltantes que el trabajador debe reponer (Diferencias), que no son efectivo | Medio |
| **Capital colocado** | Capital pendiente de los créditos (Caja principal) · dinero puesto en la ruta (ayuda del editor de Rutas) | Bajo |
| **Responsable** (columna de Consultas · Dinero) | Muestra quién **registró** la operación, no el responsable de capital | Medio |
| **Faltantes pendientes** | Faltantes por conciliar, o faltantes arrastrados, según los datos disponibles | Bajo |

## 3. Rótulos que contradicen la cifra (verificados)

Son pantallas compartidas con CLEAN que no se adaptaron a Base por Ruta. En BlueLine muestran cifras con nombres equivocados:

| # | Pantalla | Qué dice | Qué muestra en realidad |
|---|---|---|---|
| C1 | Cobrador/Supervisor → Cuadre («Mi efectivo»), bloque «Caja de la Ruta» (`src/pages/collector/CollectorCashClosePage.tsx:235`) | «Base de la ruta» | Base del trabajador de toda la ruta, incluida la del propio usuario. No es la Base disponible |
| C2 | Liquidación → Cuadre por trabajador, y Cuadre del Supervisor (`online/src/bridge/components/settlement/RouteCashReconciliationCard.tsx:56,62`) | «Efectivo de la ruta» / «Base de la ruta» | Solo la Base del trabajador. Falta la Base disponible |
| C3 | Oficinas → detalle (`src/pages/admin/OfficeDetailPage.tsx:371`) | «Base total» | Solo la Base del trabajador |
| C4 | Liquidación semanal y Consultas → Caja por ruta (`WeeklySettlementPage.tsx:464,475`, `ConsultasCashbox.tsx:112,118`) | «(+) Ingreso de capital», «(−) Retiros y retornos a la bolsa», «Saldo final» | Entregas de Base a trabajadores, devoluciones (en Base por Ruta ya no hay bolsa) y solo la Base del trabajador |
| C5 | Cuadre del Cobrador (`CollectorCashClosePage.tsx:136–175`) | «Capital recibido del Administrador», «Capital devuelto» | Entrega y Devolución de Base. El panel de cuadre de la misma ruta dice «Base recibida» |
| C6 | Notificaciones del trabajador (`online/src/runtime/NotificationsPage.tsx:208`) | «Capital recibido de tu Administrador» | Entrega de Base |
| C7 | Consultas → Transferencias, anulación (`online/src/runtime/TransfersHistory.tsx:88`) | «Entrega de capital a trabajador» | Entrega de Base |
| C8 | Gastos del Cobrador/Supervisor (`online/src/bridge/pages/collector/CollectorExpensesPage.tsx:144,192`) | «Caja de la ruta (sin trabajador)» | Base disponible |
| C9 | Editor de Rutas, ayuda (`src/pages/admin/RoutesPage.tsx:727`) | «el capital colocado pasa a su bolsa» | En Base por Ruta no hay bolsa; la Base sigue en la ruta |
| C10 | Dashboard (`DashboardPage.tsx:125`) frente a Rutas, Oficinas y Cobrador | «Cartera pendiente» | Solo capital, mientras «Cartera activa» en las demás pantallas incluye interés |
| C11 | Textos sueltos (`ConsultasDinero.tsx:187`, `routeBase/Corrections.tsx:40`, `RectifySaleModal.tsx:144`, `CollectorSelectRoutePage.tsx:176`) | «custodia(s)», «Efectivo en custodias» | Base del trabajador |

## 4. Decisiones que necesito del propietario

1. **Cartera:** ¿se muestran las dos cifras con los nombres «Capital colocado» (sin interés) y «Cartera activa» (con interés) en todas las pantallas? ¿O se elige una sola cifra para los resúmenes?
2. **El producto:** ¿«Venta» o «Crédito»? Hoy conviven Venta, Crédito y Préstamo.
3. **Recaudo / Abono / Pago:** propuesta: «Recaudo» para el total cobrado y «Abono» para cada pago individual del cliente. ¿Está bien?
4. **Trabajador / Cobrador:** propuesta: «trabajador» cuando incluye Cobradores y Supervisores, y el rol solo cuando importa. ¿Está bien?
5. **Pantallas compartidas (§3):** ¿se adaptan ya a Base por Ruta? Recomendado: sí, empezando por C1–C4, que muestran cifras con nombres equivocados en BlueLine.

## 5. Cómo se aplicaría

- Una ronda de solo textos, por grupos: primero §3, después §2 y luego los sinónimos de §1.
- En C2 y C3, además del texto, hay que sumar la Base disponible al «Efectivo de la ruta» o a la «Base total» con Base por Ruta. Es un cambio de cifra mostrada, no de dinero: el libro no se toca.
- Cada grupo con su prueba en el E2E (`saas/scripts/local/e2e-routebase.mjs`) y en la guarda BASE-020 de CLEAN (`tests/routebase.test.ts`), que ya impide reintroducir etiquetas retiradas.
