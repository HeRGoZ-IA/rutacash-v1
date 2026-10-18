import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// ADEX Online: aplicación INDEPENDIENTE de CLEAN (su propio index.html, su propio
// bundle, sin `@/` de CLEAN ni Dexie). Reutiliza solo el cliente de modo servidor de
// `saas/src/client` (tokens, selector de contexto), que no toca RutaCashDB.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  // Sin el PostCSS/Tailwind de CLEAN (raíz del repositorio): estilos propios.
  css: { postcss: { plugins: [] } },
  server: { port: 5180, strictPort: true },
  preview: { port: 5181, strictPort: true },
  // Dos páginas y dos bundles: la de empresas (index.html) y el panel Owner (owner.html).
  // Ninguna importa a la otra; cada una tiene su propia sesión.
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false,
    rollupOptions: { input: { index: path.resolve(__dirname, 'index.html'), owner: path.resolve(__dirname, 'owner.html') },
      output: { chunkFileNames: 'assets/shared-[hash].js' } } },
});
