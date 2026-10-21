import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import tailwindConfig from './tailwind.config.js';

// ADEX Online = el FRONTEND REAL DE CLEAN (`../src`) servido contra la API SaaS.
//
//   · Las pantallas, layouts, componentes, estilos y logos se toman DIRECTAMENTE de
//     `../src` (los mismos archivos que compila CLEAN; no hay copias).
//   · Solo la capa de datos y sesión se sustituye: si existe `src/bridge/<ruta>`, un
//     import de CLEAN a `@/<ruta>` (o relativo a ese archivo) se resuelve allí. Todo lo
//     demás se resuelve al original. `@clean/<ruta>` apunta SIEMPRE al original (para
//     que un puente reutilice el módulo al que envuelve).
//   · `dexie` queda prohibido en este bundle: ningún dato financiero se guarda ni se
//     calcula sobre una base local (DS-07). El único almacenamiento local es la sesión
//     (tokens y membresía elegida) del cliente de modo servidor.
//
// Dos páginas y dos bundles: empresas (index.html, CLEAN conectado) y Owner (owner.html,
// plano separado). Ninguna importa a la otra. La interfaz Online de transición
// (operaciones.html) se retiró en la Ronda 26: todas las pantallas son las de CLEAN.
const CLEAN_SRC = path.resolve(__dirname, '../src');
const BRIDGE = path.resolve(__dirname, 'src/bridge');
const EXT = ['.ts', '.tsx', '.js', '.jsx'];

function findFile(base: string): string | null {
  for (const e of ['', ...EXT]) {
    const f = base + e;
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  for (const e of EXT) {
    const f = path.join(base, `index${e}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// Plano OWNER (Ronda 40): sus archivos no leen la sesión de empresa. El puente de
// `lib/formatters` toma la moneda de la empresa del contexto (sesión de empresa); para el
// plano Owner se usa el ORIGINAL, así el bundle Owner no arrastra la sesión ni los datos de
// empresa (y los importes comerciales de ADEX conservan el formato de CLEAN).
const OWNER_PLANE = [
  path.join(CLEAN_SRC, 'pages', 'owner'), path.join(CLEAN_SRC, 'platform'), path.join(CLEAN_SRC, 'components', 'owner'),
  path.join(BRIDGE, 'pages', 'owner'), path.join(BRIDGE, 'platform'), path.resolve(__dirname, 'src/owner'),
];
const inOwnerPlane = (importer: string) => OWNER_PLANE.some((d) => path.resolve(importer.split('?')[0]!).startsWith(d + path.sep));

/** Puente CLEAN → Online: override por ruta, original en todo lo demás. */
function cleanBridge(): Plugin {
  const fromClean = (rest: string) => findFile(path.join(BRIDGE, rest)) ?? findFile(path.join(CLEAN_SRC, rest));
  return {
    name: 'adex-clean-bridge',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id === 'dexie' || id.startsWith('dexie/')) return path.join(BRIDGE, 'vendor', 'dexie.ts');
      if (id === 'dexie-react-hooks') return path.join(BRIDGE, 'vendor', 'dexie-react-hooks.ts');
      if (id === '@/lib/formatters' && importer && inOwnerPlane(importer)) return findFile(path.join(CLEAN_SRC, 'lib', 'formatters'));
      // El alta local de CLEAN escribía las categorías de gasto en la base del navegador; en
      // Online las crea el servidor. Sin este sustituto, el plano Owner arrastraría la base de empresa.
      if (id === '@/lib/expenseCategoryDefaults' && importer && inOwnerPlane(importer)) return path.resolve(__dirname, 'src/owner/plane/expenseCategoryDefaults.ts');
      if (id.startsWith('@clean/')) return findFile(path.join(CLEAN_SRC, id.slice('@clean/'.length)));
      if (id.startsWith('@/')) return fromClean(id.slice(2));
      // Import relativo DENTRO de CLEAN (p. ej. `./useAuth` desde `hooks/useTenant.ts`).
      if (importer && id.startsWith('.')) {
        const abs = path.resolve(path.dirname(importer.split('?')[0]!), id);
        const rel = path.relative(CLEAN_SRC, abs);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return fromClean(rel);
      }
      return null;
    },
  };
}

/**
 * Ronda 62 · SERVICE WORKER del panel de empresas (modo sin conexión del Cobrador): sin él, una
 * recarga sin internet no podría abrir la aplicación. Se genera en cada build con la lista EXACTA
 * de archivos del panel (nunca los del plano Owner). Navegación: red primero (siempre la versión
 * publicada) y, sin red, la copia de `index.html`. Recursos con hash: copia primero (inmutables).
 * Las peticiones a la API (otro origen) y todo lo que no sea GET no pasan por aquí: los datos
 * nunca se guardan en esta caché. Cada build cambia `sw.js`, y el navegador instala la nueva
 * versión y borra la caché anterior.
 */
function shellServiceWorker(): Plugin {
  return {
    name: 'adex-shell-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.values(bundle)
        .filter((f) => f.fileName !== 'owner.html' && !f.fileName.startsWith('assets/owner-'))
        .map((f) => `/${f.fileName}`)
        .filter((f) => f !== '/index.html' && !f.endsWith('.map'));
      const precache = ['/index.html', ...files.sort(), '/favicon-32x32.png', '/favicon-16x16.png', '/favicon.ico', '/apple-touch-icon.png'];
      const version = createHash('sha256').update(JSON.stringify(precache)).digest('hex').slice(0, 16);
      const source = `// Generado en el build (vite.config.ts · shellServiceWorker). No editar.
const SHELL = 'adex-shell-${version}';
const PRECACHE = ${JSON.stringify(precache)};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('adex-shell-') && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
const isOwner = (p) => p === '/owner' || p.startsWith('/owner/') || p === '/owner.html' || p.startsWith('/assets/owner-');
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || isOwner(url.pathname) || url.pathname === '/sw.js') return;
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      try {
        return await fetch(req, { signal: ctl.signal });
      } catch {
        return (await caches.match('/index.html', { cacheName: SHELL })) || (await caches.match('/index.html')) || Response.error();
      } finally {
        clearTimeout(timer);
      }
    })());
    return;
  }
  if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && url.pathname.startsWith('/assets/')) { const copy = res.clone(); void caches.open(SHELL).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  root: __dirname,
  plugins: [cleanBridge(), react(), shellServiceWorker()],
  // Los iconos y favicons son los de CLEAN.
  publicDir: path.resolve(__dirname, '../public'),
  // Las dependencias se resuelven SIEMPRE desde online/ (en Vercel solo se instala
  // online/): una sola copia de React para los archivos de CLEAN y los del puente.
  resolve: { dedupe: ['react', 'react-dom', 'react-router-dom', 'lucide-react', 'recharts', 'date-fns', 'clsx', 'zustand', 'uuid', 'zod'] },
  // Tailwind con el tema de CLEAN (tailwind.config.js de la raíz). Las hojas de estilo
  // de las páginas anteriores no usan directivas de Tailwind: pasan sin cambios.
  css: { postcss: { plugins: [tailwindcss(tailwindConfig), autoprefixer()] } },
  server: { port: 5180, strictPort: true, fs: { allow: [path.resolve(__dirname, '..')] } },
  preview: { port: 5181, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false,
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, 'index.html'),
        owner: path.resolve(__dirname, 'owner.html'),
      },
      output: { chunkFileNames: 'assets/shared-[hash].js' } } },
});
