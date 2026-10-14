// Hooks de resolución: `@/x` → <repo>/src/x(.ts|.tsx|/index.ts). Los imports
// relativos SIN extensión dentro de <repo>/src reciben el mismo tratamiento,
// porque el código de CLEAN se escribió para Vite/esbuild.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function candidates(base) {
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')];
}

function firstFile(base) {
  for (const c of candidates(base)) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const file = firstFile(path.join(repoSrc, specifier.slice(2)));
    if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    const parent = fileURLToPath(context.parentURL);
    if (parent.startsWith(repoSrc) && path.extname(specifier) === '') {
      const file = firstFile(path.resolve(path.dirname(parent), specifier));
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
