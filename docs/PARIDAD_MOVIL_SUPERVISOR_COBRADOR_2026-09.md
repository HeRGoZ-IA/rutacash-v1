# RUTACASH — PARIDAD MÓVIL SUPERVISOR / COBRADOR

**Fecha:** 2026-09-24 · **Ajuste previo a Fase 3**
**Decisión de negocio:** el Supervisor hace su recorrido físicamente, con el teléfono y
sin PC. Su experiencia operativa debe ser **la misma** que la del Cobrador. Mismos
permisos **no**: misma app operativa, con funciones adicionales gobernadas por
capacidades.

---

## 1. Arquitectura compartida

Ya era compartida; esta entrega la **verifica y la bloquea con pruebas**.

```
App.tsx
 ├─ /collector   → <RequireAuth roles={['cobrador']}>   <CollectorLayout/>  {operationalRoutes()}
 └─ /supervisor  → <RequireAuth roles={['supervisor']}> <SupervisorLayout/> {operationalRoutes()}

SupervisorLayout.tsx:  export { CollectorLayout as SupervisorLayout } from './CollectorLayout'
useOpBase():           '/collector' | '/supervisor' según la URL (enlaces relativos a la capa)
```

- **Una** definición de rutas (`operationalRoutes()`), montada dos veces.
- **Un** layout (el del Supervisor es un re-export).
- **Una** carpeta de páginas operativas (`src/pages/collector`, 16 pantallas). No existe
  `src/pages/supervisor`, ni páginas "Supervisor*", ni rutas duplicadas.
- Las diferencias se expresan con `can(user, …)` (9 guardas en la capa operativa). Las
  únicas comparaciones de rol son **etiquetas de texto** (título "Supervisor/Cobrador"
  en la cabecera y el rol del trabajador en el selector del cuadre), nunca acceso
  (`MOBILE-PARITY-004`).
- No hay build, layout de escritorio ni app aparte para el Supervisor.

## 2. Matriz de pantallas

| Pantalla / función | Cobrador | Supervisor | Mismo componente | Diferencia | Justificada |
|---|---|---|---|---|---|
| Inicio | ✅ | ✅ | `CollectorHomePage` | Supervisor ve además el acceso "Cuadrar trabajadores" | ✅ `cashSettlement.close` |
| Selección de Route | ✅ | ✅ | `CollectorSelectRoutePage` | Supervisor ve **Base** en la tarjeta (Cartera debajo); Cobrador ve Cartera | ✅ `cashbox.viewRoute` |
| Recaudo (clientes de la ruta) | ✅ | ✅ | `CollectorRoutePage` | — | — |
| Detalle de cliente | ✅ | ✅ | `ClientDetailPage` | — | — |
| Nuevo cliente | ✅ | ✅ | `CollectorNewClientPage` | — (ninguno tiene venta directa) | — |
| Nueva venta / solicitud | ✅ | ✅ | `CollectorNewSalePage` | — (ambos crean solicitud) | — |
| Desembolsos | ✅ | ✅ | `CollectorDisbursementsPage` | — | — |
| Pagos | ✅ | ✅ | `PaymentPage` | — (ninguno ve selector: responde quien registra) | — |
| No pago | ✅ | ✅ | `NoPaymentPage` | — | — |
| Histórico de abonos | ✅ | ✅ | `CollectorPaymentHistoryPage` | — | — |
| Gastos | ✅ | ✅ | `CollectorExpensesPage` | — | — |
| Informe del día | ✅ | ✅ | `CollectorDailyReportPage` | — | — |
| Mi efectivo | ✅ | ✅ | `CollectorCashClosePage` | Supervisor ve además "Caja de la Ruta" (separada) y "Cuadrar a otro trabajador" | ✅ `cashbox.viewRoute`, `cashSettlement.close` |
| Sincronización | ✅ | ✅ | `CollectorSyncPage` | — | — |
| Cuadre por trabajador | 🚫 (mensaje "sin acceso") | ✅ | `CollectorWorkerSettlementsPage` | Solo quien puede cuadrar a otros | ✅ `cashSettlement.view` |
| Cuenta / perfil | ✅ | ✅ | `OperationalAccountPage` | — | — |
| Barra inferior | ✅ | ✅ | `CollectorLayout` | Idéntica: Inicio · Recaudo · Desembolsos · Gastos · Cuadre | — |
| Botón atrás / volver | ✅ | ✅ | mismas páginas | — | — |
| Encabezado | ✅ | ✅ | `CollectorLayout` | Solo el título ("Cobrador" / "Supervisor") | ✅ etiqueta |
| Cambio de Route | ✅ | ✅ | cabecera → selección | — | — |

## 3. Diferencias justificadas

Todas son **funciones adicionales** del Supervisor, añadidas de forma discreta dentro de
las pantallas comunes:

| Función extra | Dónde aparece | Guarda |
|---|---|---|
| Ver Base de la Route | tarjeta de selección de ruta · bloque "Caja de la Ruta" en Mi efectivo | `cashbox.viewRoute` |
| Cuadrar a otro trabajador | chip en Inicio ("Gastos y cuadre") · enlace en Mi efectivo · `/supervisor/worker-settlements` | `cashSettlement.view` / `.close` |
| Exportar reportes | **no existe en la capa operativa** (solo en `/admin/reports`, al que el Supervisor no entra). No hace falta para el recorrido; queda como pendiente si el negocio lo quiere en móvil | `report.export` |

**Base ≠ Mi efectivo** se mantiene: la Base es de la ruta y se muestra en un bloque
aparte con el aviso "Este dinero no forma parte de tu efectivo".

## 4. Pruebas responsive

Chrome real, emulación táctil (`isMobile`, `hasTouch`, DPR 2), vertical, datos sembrados
con el código de la app. En cada pantalla se comprobó: `scrollWidth ≤ ancho de
pantalla`, ningún elemento fuera del ancho (salvo dentro de contenedores con scroll
propio), y que el `padding-bottom` del contenido (64 px) supera la altura de la barra
inferior (55 px), que además respeta `safe-area-inset-bottom`.

| Tamaño | Comprobaciones | Resultado |
|---|---|---|
| 360 × 800 | 34 | ✅ 34 PASS |
| 390 × 844 | 34 | ✅ 34 PASS |
| 412 × 915 | 34 | ✅ 34 PASS |

| Smoke | Qué se hizo | Resultado (los tres tamaños) |
|---|---|---|
| MOBILE-SMOKE-01 | Supervisor login → selección de Route → home | ✅ Tarjeta con Base; barra inferior de 5 ítems; acceso "Cuadrar trabajadores" |
| MOBILE-SMOKE-02 | Recaudo → cliente → pago de $50.000 por la UI | ✅ Sin selector; `collectorId = createdBy = Supervisor` |
| MOBILE-SMOKE-03 | Gasto de $20.000 por la UI | ✅ Cargado a su caja, instante sellado |
| MOBILE-SMOKE-04 | Mi efectivo | ✅ $30.000 (50.000 − 20.000), "Mi recaudo hoy" aparte, Caja de la Ruta separada |
| MOBILE-SMOKE-05 | Cambiar de Route desde la cabecera | ✅ Norte → Sur → Norte |
| MOBILE-SMOKE-06 | Cuadre de otro trabajador | ✅ Propio bloqueado; Juan exacto; modal con botón visible y táctil; histórico en tarjetas |
| MOBILE-SMOKE-07 | Cobrador, flujo equivalente | ✅ Misma barra; sin "Cuadrar trabajadores"; pago sin selector; **sin Base**; su Mi efectivo parte del cuadre que cerró la Supervisora; la URL de cuadre no le da acceso |

Sin errores de página en ningún tamaño. Capturas en la carpeta de trabajo de la sesión.

## 5. Navegación móvil

- **Misma estructura para ambos roles.** La barra inferior es idéntica: Inicio ·
  Recaudo · Desembolsos · Gastos · Cuadre. No cambia ningún ítem por rol.
- **Cinco ítems es el límite razonable**: no se añadió un sexto. La función extra del
  Supervisor (cuadrar trabajadores) entra como **chip en Inicio** y **enlace en Mi
  efectivo** (la pestaña "Cuadre"), no como botón nuevo en la barra. No hacía falta un
  menú "Más".
- Cuenta y cierre de sesión en la cabecera; cambio de ruta tocando el nombre de la ruta
  en la cabecera. Igual para ambos.
- Ninguna pantalla operativa enlaza a `/admin/*` (`MOBILE-PARITY-010`).

## 6. Funciones extra del Supervisor en móvil

| Puede | Cómo |
|---|---|
| Seleccionar / cambiar Route | cabecera → "Trabajar esta ruta" |
| Ver clientes, abrir cliente, registrar pagos | Recaudo → cliente → "Registrar abono" |
| Registrar gasto | Gastos → + |
| Gestionar desembolsos | Desembolsos (`sale.confirmDisbursement`) |
| Ver histórico | Inicio → "Histórico de abonos" |
| Ver Mi efectivo | pestaña Cuadre |
| Ver Base | tarjeta de ruta · Mi efectivo → Caja de la Ruta |
| Cuadrar a otro trabajador | Inicio → "Cuadrar trabajadores" |
| **No** puede cerrar su propio cuadre | aparece marcado "(tú)", sin botón de cierre (regla intacta) |

## 7. Problemas encontrados

| # | Problema | Afectaba a |
|---|---|---|
| P1 | Con **una sola ruta**, el layout redirigía a "Selecciona tu ruta" en el primer render, antes de que se ejecutara la autoselección. El comentario del código decía "entra directo" y no era así: había que pulsar "Entrar a la ruta" en cada inicio de sesión | Cobrador **y** Supervisor |
| P2 | "Cuadrar trabajadores" solo era alcanzable desde un enlace al final de Mi efectivo | Supervisor |
| P3 | Histórico de cuadres como **tabla de 8 columnas** con scroll lateral dentro de la tarjeta | Supervisor en móvil |
| P4 | Importes de 8+ dígitos (p. ej. `$ 12.500.000`) al borde del recuadro de Base/Cartera a 360 px | Ambos (Base: Supervisor) |
| P5 | Tras cerrar un cuadre, el panel seguía con el trabajador elegido, un ciclo nuevo en $0 y "Cerrar cuadre" activo: invitaba a cerrar un cuadre vacío | Supervisor y Admin |

## 8. Correcciones realizadas (sin rediseño)

| # | Corrección | Archivo |
|---|---|---|
| P1 | Con una sola ruta se muestra un indicador de carga en vez de redirigir; la autoselección existente hace el resto | `CollectorLayout.tsx` |
| P2 | Chip "Cuadrar trabajadores" en el bloque "Gastos y cuadre" de Inicio, visible solo con `cashSettlement.close` | `CollectorHomePage.tsx` |
| P3 | Tarjetas compactas por debajo de `sm`; la tabla se conserva desde `sm` (Admin en escritorio) | `WorkerCashSettlementPanel.tsx` |
| P4 | Tamaño fluido (`clamp(11px, 3.4vw, 14px)`) y corte seguro en los importes de la tarjeta | `CollectorSelectRoutePage.tsx` |
| P5 | Tras un cierre correcto se vuelve a la selección de trabajador | `WorkerCashSettlementPanel.tsx` |

No se tocaron: regla de responsabilidad (el Supervisor sigue respondiendo por lo que
registra, sin selector), `useDataRevision` (reactividad verificada de nuevo con dos
pestañas: Dashboard $0 → $300.000 sin F5), regla de domingo, sesión por pestaña.

## 9. Pendientes

- **Domingo:** pendiente confirmar si las Routes operan/cobran los domingos.
- **Exportar reportes desde el móvil** del Supervisor: no existe; decidir si se quiere.
- **Sesión por pestaña:** sin cambios (la sesión sigue en `localStorage` compartido).
- Base personal, Capital/Transferencias/Retiros como servicios, reconciliación Ruta ↔
  trabajadores, backend/cross-device: Fase 3 y posteriores.
- Teclado virtual: los formularios usan el flujo nativo del navegador (el campo con foco
  se desplaza a la vista); no se añadió gestión propia porque el patrón actual lo permite.
