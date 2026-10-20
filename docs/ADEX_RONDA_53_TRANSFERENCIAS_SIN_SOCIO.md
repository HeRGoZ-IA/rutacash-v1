# ADEX Online · Ronda 53: Transferencias, traspasos entre Administradores y retirada de Socio y DEMO

Fecha: 2026-10-20. Base: `origin/main` f3b3b9f (R48–R50 publicadas, staging 0001–0022).

Alcance: **ADEX Online** (`online/`, `saas/`). **CLEAN** (`src/`) no se modifica en esta ronda: el socio del
propietario la sigue usando, con su rol Socio incluido. Offline queda fuera.

## 1. Criterios de aceptación (fijados antes de modificar código)

| Bloque | Se cierra cuando |
|---|---|
| A · Socio | (1) `adex.memberships` no admite el rol `socio` y no queda ninguna membresía Socio. (2) No existen Caja socios (`partner_cash_movements`), cuentas `partner`, columnas de socio en `transfers` ni el comando `PARTNER_CONTRIBUTION` (API y `capital_post`). (3) `ctx_can` y ninguna política RLS mencionan `socio`. (4) La API no ofrece ningún endpoint de Socio y rechaza crear un Socio. (5) Online no tiene rutas `/socio`, ni «Caja socios», ni el rol en el selector. (6) La conciliación de capital de las empresas que quedan da `ok` (conservación incluida). |
| B · Transferencias | Un único botón **Nueva operación** que solo lista lo que el rol activo puede ejecutar; cada opción abre su formulario; sin botones de operación repetidos en tarjetas; **Ver movimientos** abre una ventana amplia con filtros (tipo, estado, fechas, ruta, participante) y enlace al Historial general; el historial no se pinta en la pantalla principal. |
| C · Entre Administradores | Traspaso con estado; el capital comprometido sale de la bolsa de origen al registrarse (no se puede usar dos veces); se aplica solo con la confirmación del destino; rechazo o cancelación lo devuelven al origen; idempotencia por id de operación; dos decisiones simultáneas no aplican dos veces; todo queda en el libro y en la auditoría. |
| D · Secretario | El Secretario registra origen, destino e importe; queda pendiente de AMBOS Administradores; cada decisión se guarda aparte (quién, cuándo); el Secretario no puede confirmar; la misma persona no puede registrar y ser parte; rechazo, reintento y concurrencia probados. |
| E · Gastos y Retiros | En escritorio, filtros en una fila (Gastos: Oficina, Ruta, Tipo, Desde, Hasta; Retiros: Oficina, Ruta, Desde, Hasta); en tablet y móvil se reordenan; sin desbordes ni texto cortado; misma lógica de filtrado. |
| F · Textos | Fuera de las pantallas que se tocan, sin párrafos de ayuda permanentes que repiten el botón o explican la arquitectura; se conservan saldos, avisos financieros, estados pendientes, errores y confirmaciones. |
| G · DEMO | Empresas Demo de staging borradas con copia recuperable previa y huella idéntica del resto; cuentas `demo.*` retiradas de Auth; proyecto Vercel `rutacash-demo` (DEMO LOCAL) eliminado; CLEAN, APIs Online y Owner siguen respondiendo. |

## 2. Contrato del traspaso entre Administradores (D2 · R53)

La decisión D2 («movimientos entre Administradores distintos») estaba abierta. La ronda 53 la aprueba con este
contrato, que no crea ni destruye dinero y no aplica nada definitivo sin la validación de quien recibe:

| Paso | Libro | Estado |
|---|---|---|
| Registrar (Administrador origen, **directo**) | `ADMIN_TRANSFER_HOLD`: bolsa origen → cuenta de tránsito de la empresa | `pendiente`; origen = confirmado (es quien registra) |
| Registrar (**Secretario**, por cuenta de ambos) | Igual (el actor del asiento es el Secretario) | `pendiente`; origen y destino pendientes |
| Confirmar (cada parte, una sola vez) | Con todas las confirmaciones: `ADMIN_TRANSFER_APPLY` tránsito → bolsa destino | `aplicada` |
| Rechazar (cualquiera de las partes) | `ADMIN_TRANSFER_RELEASE` tránsito → bolsa origen | `rechazada` (se guarda quién y el motivo) |
| Cancelar (quien registró, mientras siga pendiente) | `ADMIN_TRANSFER_RELEASE` | `cancelada` |

- **Capital comprometido:** al registrar, el importe sale del disponible de la bolsa de origen (el sobregiro lo impide
  la misma restricción de la bolsa). Nadie puede gastarlo ni volver a transferirlo mientras esté pendiente.
- **Saldo suficiente:** se comprueba al registrar, bajo bloqueo. El error nunca revela el saldo ajeno (el Secretario no
  ve bolsas).
- **Idempotencia:** cada comando lleva su `X-Adex-Operation-Id`; repetirlo devuelve el mismo resultado. Una segunda
  decisión sobre la misma parte responde «ya decidida» y no mueve nada.
- **Concurrencia:** la fila del traspaso se bloquea (`FOR UPDATE`) antes de decidir; las cuentas, en orden global.
- **Separación de personas:** origen ≠ destino (también por identidad, DS-05); el Secretario que registra no puede ser
  ninguna de las partes; nadie decide por otro.
- **Visibilidad:** cada Administrador ve los traspasos en que participa; el Secretario, los registrados por Secretarios;
  el SuperAdmin, todos. Ninguno ve saldos de bolsas ajenas.

**Punto que sigue abierto (no bloquea):** si el dinero ya se movió físicamente (el Secretario hizo la transferencia
bancaria) y uno de los Administradores rechaza, ADEX no traslada nada y lo deja `rechazada`. Cómo se resuelve esa
diferencia fuera de ADEX (o si debe existir un estado «en disputa») es una decisión del propietario.

## 3. Socio: tratamiento de los datos existentes (staging)

Diagnóstico de solo lectura (`tmp/r53/diag.ts`, `tmp/r53/diag-socio.ts`):

- 8 empresas Demo (1 activa, 7 retiradas o fallidas, todas «Empresa Demo ADEX»): se borran enteras (bloque G).
- 40 membresías Socio en 28 empresas sintéticas `stg-*` y semillas:
  - 29 solo tienen rutas asignadas: se borran.
  - 10 (empresas e2e R25/R26o) son la contrapartida de un aporte histórico de 7.000.000 a la bolsa de un Administrador.
    El aporte de un socio es capital externo: su pata pasa a la cuenta **externa** de la empresa (mismo importe, fecha,
    actor y bolsa) y se conserva el tipo histórico `PARTNER_CONTRIBUTION`, que ya no se puede crear ni anular. La bolsa
    no cambia; la conservación se mantiene.
  - 1 (semilla «Alfa Cobranças») tiene Caja socios y transferencias Ruta↔Socio importadas: se borran con la tabla.

## 4. Resultado

### Commits

| Commit | Contenido |
|---|---|
| f3c1fc2 | Servidor: 0023, módulo `capital/adminTransfers.ts`, endpoints, `/healthz` `admin-transfers-v1`, puerta de Vercel, pruebas |
| 0a8d106 | Online: Transferencias, Secretario, filtros en una fila, sin Socio (CLEAN `src/` sin cambios) |
| 07ceffe | 0023 ordena Caja socios → transferencias y comprueba restricciones diferidas; script de retirada de la Demo |

### Endpoints nuevos (API de empresa)

`GET /v1/capital/admin-directory` · `GET|POST /v1/capital/admin-transfers` · `GET /v1/capital/admin-transfers/:id` ·
`POST …/:id/confirm|reject|cancel` (todos los POST con `X-Adex-Operation-Id`). Retirado: `POST /v1/capital/partner-contributions`.

### Pruebas

| Ámbito | Resultado |
|---|---|
| API · unitarias | 23/23 |
| API · PostgreSQL real (contratos + integración) | 375/376 (1 omitida: Auth real), 0 fallos |
| Traspasos (`admin-transfers.test.ts`) | 9/9: directo, Secretario, rechazo, cancelación, idempotencia, doble consumo, 3 casos de concurrencia, aislamiento, separación de personas, inmutabilidad |
| Online en Chrome real sobre pila local (`tmp/r53/visual.mjs`) | 36/36: flujo completo por la interfaz, sin Socio, filtros en una fila (1440), sin desbordes (768 y 390) |
| Ensayo de 0023 sobre staging real (ROLLBACK) | 40 → 0 membresías Socio; 105 empresas con capital: bolsas y custodias iguales, conservación 0 |

### Retirada de DEMO

| Recurso | Estado |
|---|---|
| 8 empresas «Empresa Demo ADEX» (1 activa, 7 retiradas o fallidas) | Borradas de staging (`scripts/demo-retire-r53.ts`): 136.944 filas, copia recuperable en `ADEX_PRIVADO\respaldos\r53-demo-online-2026-10-20T19-58-53-657Z.json.gz`; 39 tablas ajenas con huella idéntica; 105 guardas restauradas |
| Hueco Demo `principal` | Vacío y sin participantes (la Demo se puede recrear con el escenario sin Socio) |
| Acceso público (6 cuentas `demo.*` de rol) | Retiradas de Supabase Auth. Se conserva `demo.operador` (solo recrea la Demo; no da acceso a empresas) |
| DEMO LOCAL (`rutacash-demo.vercel.app`) | Proyecto Vercel eliminado; responde 404 |
| CLEAN (`rutacash-clean.vercel.app`) | 200, mismo bundle `index-BFPxK5j8.js` |

### Publicación

- `origin/main` = 07ceffe. Staging 0001–0023.
- Pendiente del propietario: **Manual Deploy** de `adex-online-api` en Render. Hasta entonces la API publicada no
  anuncia `admin-transfers-v1` y la puerta de Vercel mantiene el Online anterior (`index-B43wJZVi.js`), como debe.
- Después: redespliegue del frontend y `node --require ./tmp/r26/dns-fix.cjs tmp/r53/pub.mjs` (verificación publicada).

### Pendientes no bloqueantes

- Disputa tras un rechazo cuando el dinero ya se movió (ver §2): decisión del propietario.
- Los aportes históricos de socio de las empresas e2e `stg-*` se muestran como «Aporte externo (histórico)».
- `/healthz` calcula sus funciones al arrancar: si la base no responde en ese momento (Render Free en frío), una
  función puede faltar hasta el siguiente reinicio (visto hoy con `payment-location-v1` en la API anterior).
