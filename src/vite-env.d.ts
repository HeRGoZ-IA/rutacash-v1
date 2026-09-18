/// <reference types="vite/client" />

// RutaCash es UNA SOLA APLICACIÓN: no hay variables de entorno que gobiernen modos.
// `VITE_APP_MODE` y `VITE_SEED_DEMO` se eliminaron junto con DEMO y CLEAN. Lo que
// queda configurable vive en `src/lib/featureFlags.ts`, como constantes del código.
interface ImportMetaEnv {
  readonly MODE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.css' {
  const content: string
  export default content
}
