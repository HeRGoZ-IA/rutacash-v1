// ============================================================
// SHIMS DE TIPOS PARA NODE — SOLO TEST
// ------------------------------------------------------------
// `@types/node` no es dependencia del proyecto y añadir dependencias está fuera del
// alcance de esta etapa. Aquí se declara ÚNICAMENTE lo que usa la suite financiera.
// esbuild elimina los tipos al compilar, así que esto no afecta al runtime ni al
// bundle de producción (el tsconfig raíz solo incluye src/).
// ============================================================

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function existsSync(path: string): boolean
  // La suite de plataforma recorre `src/platform/**` y `src/pages/owner/**` para
  // verificar sus imports reales (guardianes de privacidad del Owner).
  export function readdirSync(path: string): string[]
  export function statSync(path: string): { isDirectory(): boolean }
}

declare module 'node:path' {
  export function resolve(...paths: string[]): string
  export function join(...paths: string[]): string
}

declare const process: {
  cwd(): string
  exit(code?: number): never
  argv: string[]
}

declare const console: {
  log(...args: unknown[]): void
  error(...args: unknown[]): void
}

declare function structuredClone<T>(value: T): T
