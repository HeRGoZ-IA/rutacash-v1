// Puerta de despliegue del frontend en Vercel («Ignored Build Step», `ignoreCommand` de
// vercel.json). Convención de Vercel: salir con 0 = NO construir; con 1 = construir.
//
// Incidente de la Fase 5: un push publicó el frontend antes de que Render actualizara la
// API (y `createDeployments: "disabled"` no lo impidió). Esta puerta viaja EN el commit:
// el frontend solo se construye cuando la API publicada declara en /healthz los módulos
// que este frontend necesita. Si la API aún no los tiene (o no responde), se omite el
// despliegue y el frontend anterior sigue publicado; tras actualizar la API basta con
// volver a desplegar el mismo commit.
//
// Sin `process.exit`: el código se fija y el proceso termina solo (salir con un
// temporizador pendiente abortó Node en Windows, y un código anómalo significaría «construir»).

const API = process.env.ADEX_DEPLOY_GATE_API ?? 'https://adex-online-api.onrender.com';
const REQUIRED = ['settlements-v1'];

async function decide() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120_000);   // Render Free puede tardar en despertar
  try {
    const res = await fetch(`${API}/healthz`, { signal: ctl.signal });
    const body = await res.json();
    const features = Array.isArray(body?.features) ? body.features : [];
    const missing = REQUIRED.filter((f) => !features.includes(f));
    if (res.ok && missing.length === 0) return { build: true, why: `la API publicada sirve ${REQUIRED.join(', ')}` };
    return { build: false, why: `a la API publicada le falta ${missing.join(', ') || '(no responde bien)'}` };
  } catch (e) {
    return { build: false, why: `no se pudo comprobar la API (${e instanceof Error ? e.message : e})` };
  } finally {
    clearTimeout(timer);
  }
}

const d = await decide();
console.log(`deploy-gate: ${d.why} → ${d.build ? 'se construye el frontend' : 'se OMITE este despliegue'}`);
process.exitCode = d.build ? 1 : 0;
