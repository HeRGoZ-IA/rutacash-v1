import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
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
// Tres páginas y tres bundles: empresas (index.html, CLEAN conectado), operaciones de
// transición (operaciones.html, pantallas Online anteriores) y Owner (owner.html,
// intacto). Ninguna importa a otra; comparten solo la sesión de empresa.
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

/** Puente CLEAN → Online: override por ruta, original en todo lo demás. */
function cleanBridge(): Plugin {
  const fromClean = (rest: string) => findFile(path.join(BRIDGE, rest)) ?? findFile(path.join(CLEAN_SRC, rest));
  return {
    name: 'adex-clean-bridge',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id === 'dexie' || id.startsWith('dexie/')) return path.join(BRIDGE, 'vendor', 'dexie.ts');
      if (id === 'dexie-react-hooks') return path.join(BRIDGE, 'vendor', 'dexie-react-hooks.ts');
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

/** En desarrollo y vista previa, `/operaciones/*` sirve su propia página (en Vercel: vercel.json). */
function transitionPage(): Plugin {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    if (req.url && /^\/operaciones(\/|$|\?)/.test(req.url) && !req.url.startsWith('/operaciones.html')) req.url = '/operaciones.html';
    next();
  };
  return {
    name: 'adex-transition-page',
    configureServer(server) { server.middlewares.use(rewrite); },
    configurePreviewServer(server) { server.middlewares.use(rewrite); },
  };
}

export default defineConfig({
  root: __dirname,
  plugins: [cleanBridge(), transitionPage(), react()],
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
        operaciones: path.resolve(__dirname, 'operaciones.html'),
        owner: path.resolve(__dirname, 'owner.html'),
      },
      output: { chunkFileNames: 'assets/shared-[hash].js' } } },
});
