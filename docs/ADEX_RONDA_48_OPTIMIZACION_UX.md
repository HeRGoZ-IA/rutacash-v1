# ADEX — Ronda 48: optimización UX (seguridad operativa, ubicación del cobro y filtros compactos)

Fecha: 2026-10-20. Base: `9bcca96` (local, sobre `origin/main` `b6b09d3`). Estado: **implementado y validado localmente; NO publicado**.

Decisiones aplicadas: D-UX48-01 (identidad visual intacta), D-UX48-02 (ubicación al registrar un abono), D-UX48-03 (sin ubicación el abono no se bloquea). D-UX48-04 (publicación) **no aprobada**.

## 1. Qué cambia

### Bloque A — prevención de errores
| Hallazgo R47 | Cambio | Archivos |
|---|---|---|
| H-01 Suspender/Reactivar con un clic (Owner) | Confirmación con empresa, acción, efecto real (empresa no operable: nadie entra ni registra), Cancelar con foco, sin doble envío; éxito solo tras la respuesta | `src/components/owner/CompanyStatusConfirmModal.tsx`; listado y ficha en `src/pages/owner/*` y `online/src/bridge/pages/owner/*` |
| H-03 Aprobar desde la fila | La fila solo ofrece «Revisar»; «Aprobar $X» está en el detalle (cliente, condiciones, indicadores, historial) y se habilita cuando el historial cargó | `src/pages/admin/SaleAuthorizationsPage.tsx` |
| H-04 Cerrar semana sin confirmar | Resumen con empresa, oficina·ruta, período, estado (abierto / reabierto), totales de la vista previa del mismo servicio, faltantes informativos y consecuencia; el cierre lo recalcula y archiva el servicio de siempre | `src/pages/admin/WeeklySettlementPage.tsx` |
| H-05 Abono sin eco del importe | Resumen cliente / a registrar / saldo previsto (solo presentación), chip de importe marcado, botón «Registrar $X», confirmación extra SOLO si el abono liquida la deuda | `src/pages/collector/PaymentPage.tsx` |

### Bloque B — WhatsApp y ubicación
- **B1** `src/lib/whatsapp.ts`: destinatario según el país de la EMPRESA (CO 57, BR 55), sin duplicar prefijos, respetando números escritos como internacionales; fijos, cortos, con código de operadora o de otro país → **no se construye enlace** y se explica. El destinatario se muestra antes de abrir WhatsApp (abono y ficha del cliente).
- **B2/B6** `src/lib/geolocation.ts` + `PaymentPage`: una lectura al pulsar Registrar (sin precarga ni seguimiento). Estados: `captured`, `denied`, `unavailable`, `timeout`, `unsupported` (+ `invalid` y `not_stored` del servidor). Texto veraz: finalidad informada y «si no está disponible, el abono se registra igual». El estado de ubicación se muestra aparte del resultado financiero, que siempre es el del servidor.
- **B3** Servidor (`saas/`):
  - Migración **0022** `adex.payment_locations` (tabla aparte; `payments` y `collection_post` intactos): RLS forzada, solo INSERT por la membresía que registró el abono, guarda de pago activo, hora de recepción del servidor, append-only (sin UPDATE/DELETE/TRUNCATE), **sin SELECT** para `adex_api`, `adex_control` ni `adex_demo`.
  - `POST /v1/collections` acepta `location` en el MISMO cuerpo idempotente: un reintento con el mismo id devuelve el resultado guardado (ni abono ni ubicación duplicados); otro cuerpo con el mismo id → 409.
  - `saas/src/collections/location.ts`: la lectura es dato NO confiable; malformada → `invalid` sin coordenadas; reloj del teléfono desfasado → se conservan coordenadas, no su hora, con motivo. Se guarda bajo SAVEPOINT después del abono: un fallo de ubicación **no revierte** el abono (`not_stored`, con SQLSTATE en el log, sin coordenadas). La auditoría guarda solo el estado.
- **B5** `online/vercel.json`: `Permissions-Policy … geolocation=(self)` (solo el propio origen; iframes de otros orígenes siguen bloqueados).
- **Puerta de despliegue**: `/healthz` anuncia `payment-location-v1` **solo si la base ya tiene 0022**; `online/scripts/deploy-gate.mjs` la exige.

### Bloque C — filtros y espacio
- `Input`/`Select`: prop opcional `containerClassName` (por defecto, igual que antes). `OfficeSelector`/`RouteSelector` aplican su ancho al contenedor.
- `OfficeRouteFilterBar`: hueco `search`; escritorio en una fila (buscador ancho, Oficina, Ruta, filtros extra), tableta 3 columnas, móvil una columna (< 640 px) sin recortar textos.
- Clientes (original y copia Online), Ventas activas, Clientes de Secretario y Socio usan el buscador en la barra; Historial con anchos según contenido; Caja, Reportes, Liquidación, Rutas y Asignar oficina recuperan su fila compacta.
- Formularios financieros: sin cambios de disposición.

## 2. Validación local (sin entornos compartidos)
| Prueba | Resultado |
|---|---|
| Typecheck CLEAN / Online / SaaS | OK |
| Build CLEAN y Online (a `tmp/r48/build-*`) | OK; bundle Owner sin código de cobros |
| CLEAN `npm test` | 27 suites · 1.637 casos · 0 fallos |
| SaaS unit | 23/23 |
| SaaS con PostgreSQL real (`test:db`, incluye 13 pruebas nuevas LOC-001…013) | 349 · 348 pass · 0 fallos · 1 omitida (Auth real de staging) |
| E2E Chrome (sandbox local efímero, datos sintéticos) `tmp/r48/e2e.mjs` | 31/31 |
| Política de navegador (`tmp/r48/policy-check.mjs`) | antes: bloqueada; después: permitida en el propio origen, bloqueada en iframes ajenos |
| Comparativa visual antes/después (`tmp/r47/shots` vs `tmp/r48/shots`) | Clientes escritorio: primera fila 440 → 282 px; sin scroll horizontal; 0 errores de consola |

## 3. Publicación (pendiente de autorización expresa del propietario)
Orden obligatorio:
1. `cd saas; npm run staging:migrate` (aplica **0022**). Reversión: `saas/db/rollback/0022_payment_locations.down.sql`.
2. Desplegar la API en Render (adex-online-api) y comprobar que `/healthz` incluye `payment-location-v1`.
3. `git push` (Vercel construye el frontend solo si la puerta ve `payment-location-v1`). El push también redespliega CLEAN/DEMO desde `main`.
4. Verificación publicada: abono con permiso concedido y denegado en un dispositivo real (HTTPS), Owner suspender/cancelar en una empresa de prueba, cierre de semana en una ruta sintética.

## 4. Decisiones pendientes
- Quién puede consultar coordenadas y con qué pantalla (hoy nadie: no hay lectura).
- Plazo de conservación y borrado de ubicaciones (la tabla es append-only; una política de retención exigirá una migración). Sin revisión jurídica LGPD / Ley 1581.
- Fuera de alcance (anterior a R48): ante una respuesta incierta del servidor, la pantalla de abono permite reintentar con un id nuevo (`online/src/bridge/services/paymentService.ts`).
