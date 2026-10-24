// ============================================================
// RUTACASH — ¿QUÉ VERSIÓN ESTÁ SIRVIENDO EL DESPLIEGUE?
// ------------------------------------------------------------
//   node scripts/verify-deploy.mjs https://mi-despliegue.vercel.app
//   npm run verify:deploy -- https://mi-despliegue.vercel.app
//
// POR QUÉ EXISTE ESTE SCRIPT
//
// La suite de pruebas verifica el CÓDIGO DEL REPOSITORIO. Nunca puede saber qué
// bundle está sirviendo Vercel. Esa distinción costó una ronda entera: el código de
// la entrega 6.1 era correcto y sus pruebas pasaban, pero Producción seguía sirviendo
// el bundle anterior, así que /owner/configuracion devolvía a /login y el portal de
// empresa seguía mostrando el borrado retirado.
//
// Este script cierra ese hueco: descarga el index.html publicado, saca el bundle real
// y comprueba sobre él qué entrega está viva. No mira el repositorio.
// ============================================================

const MARCADORES = [
  // [qué buscar, debe estar presente, a partir de qué entrega]
  ['Configuración', true, 'menú Owner con Configuración (6.1)'],
  ['/owner/configuracion', true, 'ruta de configuración del Owner (6.1)'],
  // Rebranding visible a ADEX Soluciones (2026-10-01): el texto de la acción cambia.
  ['Restablecer ADEX Soluciones a cero', true, 'restablecimiento de fábrica del Owner (6.1 · marca ADEX)'],
  ['Restablecer RutaCash a cero', false, 'texto del reset anterior al rebranding ADEX (≤2026-09-30)'],
  ['RESTABLECER', true, 'palabra de confirmación del reset (6.1)'],
  ['Restablecer RutaCash desde cero', false, 'reset retirado del portal de empresa (≤6.0)'],
  ['BORRAR TODO', false, 'confirmación antigua del reset (≤6.0)'],
  ['MODO DEMO', false, 'banner del modo DEMO (≤6.0)'],
  ['superadmin@demo.com', false, 'credenciales del conjunto DEMO (≤6.0)'],
  // Entrega 2026-09-24: regla definitiva del Supervisor + cuadre por trabajador.
  ['Cuadre por trabajador', true, 'pestaña de cuadre por trabajador en Liquidación (2026-09-24)'],
  ['worker-settlements', true, 'pantalla de cuadre de otros trabajadores del Supervisor (2026-09-24)'],
  ['Este faltante continuará pendiente en el siguiente ciclo.', true, 'confirmación de faltante (2026-09-24)'],
  ['cashSettlements', true, 'tabla Dexie v14 cashSettlements (2026-09-24)'],
  ['Indica quién recibió el dinero: tú o el cobrador de la ruta.', false, 'regla must-choose del Supervisor retirada (≤2026-09-22)'],
  // Ajuste previo a Fase 3: acceso móvil del Supervisor al cuadre de trabajadores.
  ['Cuadrar trabajadores', true, 'acceso al cuadre en Inicio de la app operativa (2026-09-24 b)'],
  // Autoridad comercial del Supervisor.
  ['Solicitudes pendientes de la ruta', true, 'autorizaciones móviles del Supervisor (2026-09-24 c)'],
  ['Esta solicitud ya fue resuelta.', true, 'resolución única de solicitudes (2026-09-24 c)'],
  // Entrega 2026-09-29: segundo crédito del Cobrador + Base física por trabajador.
  ['Este cliente ya tiene un crédito activo: la venta debe enviarse como solicitud de autorización.', true, 'regla de crédito activo en dominio (2026-09-29)'],
  ['Este cliente ya tiene una solicitud de venta pendiente. Espera a que se resuelva.', true, 'sin solicitudes duplicadas (2026-09-29)'],
  ['cashCustodyMovements', true, 'tabla Dexie v15 de custodia de Base (2026-09-29)'],
  ['Entregar Base', true, 'entrega de Base física a un trabajador (2026-09-29)'],
  ['Sin asignar (caja de la ruta)', true, 'conciliación Route ↔ trabajadores (2026-09-29)'],
  ['El retiro supera los fondos disponibles de la ruta', true, 'retiros por servicio con control de fondos (2026-09-29)'],
  // Rebranding visual ADEX Soluciones (2026-10-01).
  ['Dashboard ADEX Soluciones', true, 'marca visible ADEX en el portal Owner (2026-10-01)'],
  ['Sobre ADEX Soluciones', true, 'marca visible ADEX en Configuración (2026-10-01)'],
  ['Dashboard RutaCash', false, 'marca visible anterior (≤2026-09-30)'],
  // Ajustes del socio 2026-10-02 · Ronda 1: el Cobrador solo origina al 20%.
  ['El Cobrador solo puede crear créditos al', true, 'tasa del Cobrador validada en dominio (2026-10-02 R1)'],
  // Ronda 2: contexto de crédito activo en las autorizaciones del Secretario.
  ['Solicitada con crédito activo · hoy ya no está activo', true, 'crédito activo visible en Secretaría (2026-10-02 R2)'],
  // Ronda 3: anulación auditable de capital, retiros y transferencias.
  ['Una reversión no se puede anular.', true, 'anulación auditable de movimientos de fondos (2026-10-02 R3)'],
  // Ronda 4: una sola "Base de la ruta" (getRouteBase) y etiquetas unificadas.
  ['La venta supera la Base de la ruta: no hay capital suficiente.', true, 'Base de la ruta como fuente única (2026-10-02 R4)'],
  ['Libro de la ruta', false, 'etiqueta retirada: la conciliación muestra "Base de la ruta" (≤2026-10-02 R3)'],
  // Ronda 5: Base del Supervisor viva y revalidada al enviar la venta.
  ['La Base de la ruta cambió mientras completabas la venta.', true, 'Base viva + revalidación al vender (2026-10-02 R5)'],
  // Ronda 6: traspaso de efectivo entre trabajadores de una misma ruta (custodia).
  ['Traspasar a otro trabajador', true, 'traspaso interno entre trabajadores (2026-10-02 R6)'],
  // Ronda 7: anulación de pagos con recálculo del crédito y control de efectivo.
  ['Pago anulado. El crédito se recalculó.', true, 'anulación de pagos con recálculo del crédito (2026-10-02 R7)'],
  // Ronda 8: sincronización de anulaciones (monotonía del pago + Sync del Cobrador con estados).
  ['no puede volver a otro estado.', true, 'anulación monótona y sincronización causal (2026-10-02 R8)'],
  // Ronda 9: gastos clasificados por atribución económica (empresa / ruta / trabajador).
  ['¿A quién corresponde este gasto?', true, 'clasificación y atribución de gastos (2026-10-02 R9)'],
  // Ronda 10: capital por Administrador (SuperAdmin → Admin → Ruta) y un responsable por ruta.
  ['Asignar a Administrador', true, 'capital por Administrador: SuperAdmin → Admin (2026-10-07 R10)'],
  ['Sin responsable de capital', true, 'responsable de capital por ruta (2026-10-07 R10)'],
  ['capitalLedger', true, 'tabla Dexie v16 capitalLedger (2026-10-07 R10)'],
  ['Inyectar capital', false, 'atajo SuperAdmin → Ruta retirado (≤2026-10-06)'],
  ['usa «Traspaso entre trabajadores»', false, 'acceso confuso desde Transferencias retirado (≤2026-10-06)'],
  // Incidente 2026-10-08: el gasto del trabajador ya no se bloquea por su efectivo en manos.
  ['El gasto supera el efectivo en manos de', false, 'bloqueo de gastos del cobrador retirado (≤2026-10-07)'],
  ['Ese identificador de operación ya corresponde a otro gasto.', true, 'gasto idempotente por id de operación (2026-10-08)'],
  ['Recaudado en efectivo por ti', true, 'Mi efectivo: recaudo solo en efectivo y saldo negativo visible (2026-10-08)'],
  // Ronda 1/6 (2026-10-11): Transferencias con disponible real y guía «Entregar Base».
  ['Neto de transferencias', true, 'tarjetas sin «Saldo neto» ambiguo (2026-10-11 R1/6)'],
  ['Disponible para mover', true, 'disponible real de cada caja de ruta en Transferencias (R1/6 → R4/6)'],
  ['Entregar Base a un trabajador', true, 'guía caja de ruta → trabajador desde Transferencias (2026-10-11 R1/6)'],
  ['Vienes de Transferencias: pulsa', true, 'botón exacto señalado en el cuadre (2026-10-11 R1/6)'],
  ['Entregar en mano a (opcional)', false, 'etiqueta ambigua de entrega en mano retirada (≤2026-10-10)'],
  ['El efectivo entre trabajadores de una misma ruta se traspasa en', false, 'mensaje de rechazo que describía otra operación (≤2026-10-10)'],
  // Ronda 2/6 (2026-10-11): gastos administrativos pagados con la bolsa (D9–D12).
  ['¿Qué bolsa paga?', true, 'gasto de empresa con bolsa explícita (2026-10-11 R2/6)'],
  ['Confirmar gasto administrativo', true, 'confirmación antes de descontar de una bolsa (2026-10-11 R2/6)'],
  ['Histórico · sin bolsa', true, 'gastos históricos identificados sin imputar (D9, 2026-10-11 R2/6)'],
  ['Ese identificador de operación ya corresponde a otro movimiento de capital.', true, 'asignaciones idempotentes por operación (2026-10-11 R2/6)'],
  ['Gasto general de la empresa. No resta la Base', false, 'gasto de empresa sin bolsa (≤2026-10-10)'],
  // Ronda 3/6 (2026-10-11): Caja principal del Administrador.
  ['Conciliación de la bolsa', true, 'Caja principal: conciliación visible (2026-10-11 R3/6)'],
  ['Movimientos de la bolsa', true, 'Caja principal: historial de la bolsa (2026-10-11 R3/6)'],
  ['Capital bajo mi responsabilidad', true, 'Caja principal: indicadores de la bolsa (2026-10-11 R3/6)'],
  // Ronda 4/6 (2026-10-11): Transferencias unificadas con asistente por operación.
  ['Revisé el origen, el destino y el importe', true, 'confirmación consciente antes de registrar (2026-10-11 R4/6)'],
  ['Registrada por el sistema', true, 'resultado confirmado por el servicio (2026-10-11 R4/6)'],
  ['Ese identificador de operación ya corresponde a otra transferencia.', true, 'transferencias idempotentes (2026-10-11 R4/6)'],
  ['Ese identificador de operación ya corresponde a otro movimiento de Base.', true, 'entrega/devolución de Base idempotentes (2026-10-11 R4/6)'],
  // Ronda 5/6 (2026-10-11): historial unificado, comprobantes y Caja socios validada en el servicio.
  ['Historial de movimientos', true, 'historial unificado de registros reales (2026-10-11 R5/6)'],
  ['Comprobante de movimiento registrado', true, 'comprobante imprimible (2026-10-11 R5/6)'],
  ['No acredita la entrega ni la recepción física del efectivo', true, 'comprobante sin recepciones inventadas (2026-10-11 R5/6)'],
  ['Ese identificador de operación ya corresponde a otro movimiento de Caja socios.', true, 'Caja socios validada e idempotente en el servicio (2026-10-11 R5/6)'],
  // Ronda 6/6B (2026-10-11): desembolso una sola vez y estados terminales por servicio.
  ['Esta venta ya fue desembolsada: no se puede confirmar otra vez.', true, 'desembolso único bajo bloqueo (2026-10-11 R6/6B)'],
  ['falta el usuario que registra la pérdida.', true, 'marcar perdida por servicio con permiso y auditoría (2026-10-11 R6/6B)'],
  // Ronda 6/6C (2026-10-12): capital de ruta y efectivo de quien entrega (D25/D26), cierres (D7).
  ['No tienes efectivo suficiente para este desembolso.', true, 'desembolso exige efectivo en mano (2026-10-12 R6/6C, D25)'],
  ['La caja de la ruta no tiene ese efectivo sin asignar', true, 'desembolso administrativo contra la caja de la ruta (2026-10-12 R6/6C)'],
  ['no admite movimientos con fecha', true, 'periodo cerrado protegido en servicios (2026-10-12 R6/6C, D7)'],
  ['falta el usuario que confirma el desembolso.', true, 'desembolso sin usuario rechazado (2026-10-12 R6/6C)'],
  // Ronda 6/6C.1 (2026-10-12): cierre solo de periodos terminados (D29), caja de la ruta solo de su responsable (D30), anulaciones fuera de cierres (D7).
  ['podrá cerrarse a partir del', true, 'cierre semanal solo de periodos terminados (2026-10-12 R6/6C.1, D29)'],
  ['Desembolso desde la caja de la ruta:', true, 'caja de la ruta solo para su responsable o el SuperAdmin (2026-10-12 R6/6C.1, D30)'],
  ['No se puede anular hoy.', true, 'anulaciones fuera de semanas cerradas (2026-10-12 R6/6C.1, D7)'],
  ['No hay un periodo abierto para registrar el ajuste.', true, 'ajustes de pagos fuera de semanas cerradas (2026-10-12 R6/6C.1, D7)'],
  // C1/C2 (2026-10-15): capital centralizado en el Administrador (desactivado por defecto; se activa por empresa).
  ['Con capital centralizado la ruta no recibe capital en su caja', true, 'motor de capital centralizado (C1)'],
  ['adex-respaldo-capital-centralizado-v1', true, 'respaldo verificable previo a la activación (C2)'],
  ['Capital centralizado', true, 'pantalla de diagnóstico y activación (C2)'],
  ['Entregar capital a un trabajador', true, 'entrega de capital bolsa → trabajador (C2)'],
  ['Traspasar saldo heredado a mi bolsa', true, 'vaciado del saldo heredado de la caja de ruta (C2)'],
  ['Base recibida y devuelta en este periodo', true, '«Mi efectivo» con la Base recibida separada del recaudo (C2, nombres N-1)'],
  ['Efectivo de cuadres devuelto a la bolsa', true, 'retornos de cuadre separados de los retiros (C2)'],
  ['Esta ruta quedó bloqueada al activar el capital centralizado', true, 'rutas inconsistentes bloqueadas para capital nuevo (C2)'],
]

const url = (process.argv[2] ?? '').replace(/\/+$/, '')
if (!url) {
  console.error('\n  Uso: node scripts/verify-deploy.mjs <https://tu-despliegue>\n')
  process.exit(2)
}

async function main() {
  console.log(`\n  Comprobando ${url}\n`)

  const indexRes = await fetch(`${url}/`, { headers: { 'cache-control': 'no-cache' } })
  if (!indexRes.ok) {
    console.error(`  No se pudo leer el index (HTTP ${indexRes.status}).\n`)
    process.exit(1)
  }
  const html = await indexRes.text()

  const assets = [...html.matchAll(/src="([^"]+\.js)"/g)].map(m => m[1])
  if (assets.length === 0) {
    console.error('  El index no referencia ningún bundle JS. ¿Es realmente RutaCash?\n')
    process.exit(1)
  }

  let bundle = ''
  for (const a of assets) {
    const res = await fetch(a.startsWith('http') ? a : `${url}${a.startsWith('/') ? '' : '/'}${a}`)
    if (res.ok) bundle += await res.text()
  }
  console.log(`  bundle(s): ${assets.join(', ')}`)
  console.log(`  tamaño   : ${(bundle.length / 1024).toFixed(0)} KB\n`)

  let fallos = 0
  for (const [aguja, debeEstar, descripcion] of MARCADORES) {
    const presente = bundle.includes(aguja)
    const ok = presente === debeEstar
    if (!ok) fallos++
    console.log(`  ${ok ? 'OK  ' : 'MAL '} ${presente ? 'presente' : 'ausente '} · ${descripcion}`)
  }

  // Comprobación de routing: /owner/configuracion debe servir la aplicación (200),
  // no un 404. Con el rewrite SPA, cualquier ruta devuelve el index.
  const ruta = await fetch(`${url}/owner/configuracion`, { headers: { 'cache-control': 'no-cache' } })
  const rutaOk = ruta.status === 200
  if (!rutaOk) fallos++
  console.log(`  ${rutaOk ? 'OK  ' : 'MAL '} /owner/configuracion responde HTTP ${ruta.status}`)

  // Favicons (2026-10-01): deben ser IMÁGENES reales. Con el rewrite SPA, un icono
  // inexistente responde 200 con el index.html (así estuvo roto /favicon.svg).
  for (const icono of ['/favicon-32x32.png', '/favicon-16x16.png', '/favicon.ico', '/apple-touch-icon.png']) {
    const r = await fetch(`${url}${icono}`, { headers: { 'cache-control': 'no-cache' } })
    const tipo = r.headers.get('content-type') ?? ''
    const ok = r.status === 200 && tipo.startsWith('image/')
    if (!ok) fallos++
    console.log(`  ${ok ? 'OK  ' : 'MAL '} ${icono} → HTTP ${r.status} ${tipo}`)
  }

  if (fallos > 0) {
    console.log(`\n  ${fallos} comprobación(es) fallida(s): el despliegue NO está sirviendo la entrega 6.1 o posterior.`)
    console.log('  Revisa en Vercel que el último build haya terminado CORRECTAMENTE; si falló,')
    console.log('  Vercel sigue sirviendo el despliegue anterior sin avisar en la URL.\n')
    process.exit(1)
  }
  console.log('\n  El despliegue sirve la entrega 6.1 o posterior.\n')
}

main().catch(e => { console.error(`\n  Error: ${e.message}\n`); process.exit(1) })
