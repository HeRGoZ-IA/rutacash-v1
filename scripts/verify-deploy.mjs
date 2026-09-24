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
  ['Restablecer RutaCash a cero', true, 'restablecimiento de fábrica del Owner (6.1)'],
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

  if (fallos > 0) {
    console.log(`\n  ${fallos} comprobación(es) fallida(s): el despliegue NO está sirviendo la entrega 6.1 o posterior.`)
    console.log('  Revisa en Vercel que el último build haya terminado CORRECTAMENTE; si falló,')
    console.log('  Vercel sigue sirviendo el despliegue anterior sin avisar en la URL.\n')
    process.exit(1)
  }
  console.log('\n  El despliegue sirve la entrega 6.1 o posterior.\n')
}

main().catch(e => { console.error(`\n  Error: ${e.message}\n`); process.exit(1) })
