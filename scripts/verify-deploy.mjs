// ============================================================
// ADEX ONLINE — ¿QUÉ VERSIÓN ESTÁ SIRVIENDO EL DESPLIEGUE?
// ------------------------------------------------------------
//   npm run verify:deploy                       (adex-online.vercel.app, origin/main)
//   npm run verify:deploy -- https://otra-url   (otro despliegue)
//   npm run verify:deploy -- --expect a12d915   (commit esperado)
//
// POR QUÉ EXISTE ESTE SCRIPT
//
// Las pruebas verifican el CÓDIGO DEL REPOSITORIO; no saben qué está sirviendo Vercel ni
// qué API está viva en Render. Este script solo LEE lo publicado:
//   1. descarga el index.html y TODOS los paquetes JS que cuelgan de él (los fragmentos se
//      importan entre sí, así que se siguen de forma recursiva);
//   2. busca el commit que Vercel incrusta en el paquete (VITE_VERCEL_GIT_COMMIT_SHA) y lo
//      compara con el esperado (por defecto, origin/main);
//   3. pide /healthz a la API y comprueba que anuncia los módulos que exige la puerta de
//      despliegue (online/scripts/deploy-gate.mjs, lista REQUIRED).
//
// Hasta la Ronda 59 este script comprobaba marcadores de texto de CLEAN en
// rutacash-clean.vercel.app, que ya está retirada (404).
// ============================================================
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined }
const expectArg = flag('--expect')
const API = (flag('--api') ?? 'https://adex-online-api.onrender.com').replace(/\/+$/, '')
const url = (args[0] ?? 'https://adex-online.vercel.app').replace(/\/+$/, '')

// La lista de módulos se lee del propio archivo de la puerta (no se importa: al importarlo
// se ejecutaría la decisión de despliegue).
function requiredFeatures() {
  const src = readFileSync(resolve(ROOT, 'online/scripts/deploy-gate.mjs'), 'utf8')
  const block = src.match(/const REQUIRED = \[([\s\S]*?)\];/)
  if (!block) throw new Error('no se encontró REQUIRED en online/scripts/deploy-gate.mjs')
  return [...block[1].replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((m) => m[1])
}

function expectedCommit() {
  if (expectArg) return expectArg
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: ROOT, stdio: 'ignore' })
  } catch { /* sin red: se usa la referencia local */ }
  return execFileSync('git', ['rev-parse', 'origin/main'], { cwd: ROOT, encoding: 'utf8' }).trim()
}

async function get(u) {
  const res = await fetch(u, { headers: { 'cache-control': 'no-cache' } })
  return { ok: res.ok, status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() }
}

async function bundle() {
  const index = await get(`${url}/`)
  if (!index.ok) throw new Error(`no se pudo leer el index (HTTP ${index.status})`)
  const pending = [...index.text.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1])
  if (pending.length === 0) throw new Error('el index no referencia ningún paquete JS')
  const seen = new Set()
  let code = ''
  while (pending.length) {
    const p = pending.shift()
    if (seen.has(p)) continue
    seen.add(p)
    const r = await get(`${url}${p}`)
    // Con el rewrite SPA, un fragmento inexistente responde 200 con el index.html.
    if (!r.ok || r.type.includes('html')) continue
    code += r.text
    for (const m of r.text.matchAll(/["'(/]\.?\/?((?:assets\/)?[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.js)["')]/g)) {
      const name = m[1].replace(/^assets\//, '')
      pending.push(`/assets/${name}`)
    }
  }
  return { code, files: [...seen] }
}

async function main() {
  let fallos = 0
  const ok = (cond, msg) => { if (!cond) fallos++; console.log(`  ${cond ? 'OK  ' : 'MAL '} ${msg}`) }

  console.log(`\n  Web: ${url}\n  API: ${API}\n`)

  const expected = expectedCommit()
  const { code, files } = await bundle()
  const entry = files.find((f) => /\/index-/.test(f)) ?? files[0]
  console.log(`  paquete principal: ${entry} · ${files.length} archivo(s) · ${(code.length / 1024).toFixed(0)} KB`)
  const sha = code.match(/VITE_VERCEL_GIT_COMMIT_SHA["']?\s*:\s*["'`]([0-9a-f]{7,40})["'`]/)?.[1]
  if (sha) ok(sha.startsWith(expected) || expected.startsWith(sha), `commit servido ${sha.slice(0, 7)} · esperado ${expected.slice(0, 7)}`)
  else ok(false, 'el paquete no trae VITE_VERCEL_GIT_COMMIT_SHA (¿se ocultaron los metadatos de Git? compara a mano)')

  const owner = await get(`${url}/owner`)
  ok(owner.status === 200 && owner.type.includes('html'), `/owner responde HTTP ${owner.status}`)
  for (const icono of ['/favicon-32x32.png', '/apple-touch-icon.png']) {
    const r = await get(`${url}${icono}`)
    ok(r.status === 200 && r.type.startsWith('image/'), `${icono} → HTTP ${r.status} ${r.type}`)
  }

  // Render Free puede tardar en despertar: un intento largo antes de dar la API por caída.
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 120_000)
  try {
    const res = await fetch(`${API}/healthz`, { signal: ctl.signal })
    const list = (await res.json())?.features ?? []
    const missing = requiredFeatures().filter((f) => !list.includes(f))
    ok(res.ok && missing.length === 0, missing.length ? `a la API le falta: ${missing.join(', ')}` : `la API anuncia los ${list.length} módulos (incluidos todos los que exige la puerta)`)
  } catch (e) {
    ok(false, `la API no respondió (${e instanceof Error ? e.message : e})`)
  } finally {
    clearTimeout(timer)
  }

  if (fallos > 0) {
    console.log(`\n  ${fallos} comprobación(es) fallida(s).`)
    console.log('  Si el commit no coincide: la puerta pudo cancelar el build (API sin actualizar) o Vercel')
    console.log('  sigue en el despliegue anterior. Revisa el último despliegue en Vercel y el /healthz de Render.\n')
    process.exit(1)
  }
  console.log('\n  El despliegue sirve el commit esperado y la API está al día.\n')
}

main().catch((e) => { console.error(`\n  Error: ${e.message}\n`); process.exit(1) })
