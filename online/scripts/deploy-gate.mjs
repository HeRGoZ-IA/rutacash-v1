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
// Ronda 48: el frontend envía la ubicación del cobro (campo `location`). Una API anterior
// la rechazaría (UNKNOWN_FIELD) y bloquearía los abonos. La API publicada solo anuncia
// `payment-location-v1` cuando su base YA tiene la tabla de 0022 (saas/src/server/start.ts),
// así que el orden obligatorio es: aplicar 0022 → desplegar la API → desplegar el frontend.
// Ronda 53: sin Socio y con traspasos entre Administradores (0023 → API → frontend).
// Ronda 59: entregas voluntarias, solicitudes y notificaciones (0025 → API → frontend).
// Ronda 62: modo sin conexión del Cobrador (campo `offline`, llave del dispositivo; 0026 → API → frontend).
// Ronda 65: desembolsos sin conexión de solicitudes aprobadas (`offline` en /disburse; 0027 → API → frontend).
const REQUIRED = ['settlements-v1', 'clean-online-v1', 'access-links-v1', 'payment-location-v1', 'admin-transfers-v1', 'capital-requests-v1', 'offline-collector-v1', 'offline-disbursements-v1'];
// Ronda 40: si este despliegue activa la Plataforma Owner (VITE_ADEX_CONTROL_URL), el
// servicio Owner publicado tiene que servir la versión que usan las pantallas originales.
const CONTROL = (process.env.VITE_ADEX_CONTROL_URL ?? '').replace(/\/$/, '');
// Ronda 54: la ficha permite cambiar el correo del Super Admin (0024 → servicio Owner → frontend).
const CONTROL_REQUIRED = ['owner-clean-v1', 'owner-email-v1'];

async function features(base, signal) {
  const res = await fetch(`${base}/healthz`, { signal });
  const body = await res.json();
  return { ok: res.ok, list: Array.isArray(body?.features) ? body.features : [] };
}

async function decide() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120_000);   // Render Free puede tardar en despertar
  try {
    const api = await features(API, ctl.signal);
    const missing = REQUIRED.filter((f) => !api.list.includes(f));
    if (!api.ok || missing.length) return { build: false, why: `a la API publicada le falta ${missing.join(', ') || '(no responde bien)'}` };
    if (CONTROL) {
      const owner = await features(CONTROL, ctl.signal);
      const lack = CONTROL_REQUIRED.filter((f) => !owner.list.includes(f));
      if (!owner.ok || lack.length) return { build: false, why: `al servicio Owner publicado le falta ${lack.join(', ') || '(no responde bien)'}` };
    }
    return { build: true, why: `la API publicada sirve ${REQUIRED.join(', ')}${CONTROL ? ` y el servicio Owner ${CONTROL_REQUIRED.join(', ')}` : ''}` };
  } catch (e) {
    return { build: false, why: `no se pudo comprobar la API (${e instanceof Error ? e.message : e})` };
  } finally {
    clearTimeout(timer);
  }
}

const d = await decide();
console.log(`deploy-gate: ${d.why} → ${d.build ? 'se construye el frontend' : 'se OMITE este despliegue'}`);
process.exitCode = d.build ? 1 : 0;
