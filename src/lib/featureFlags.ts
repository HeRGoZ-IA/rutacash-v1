// ============================================================
// RUTACASH — INTERRUPTORES DE FUNCIONALIDAD
// ------------------------------------------------------------
// RutaCash es UNA SOLA APLICACIÓN. No existen modos DEMO ni CLEAN, ni builds
// distintas, ni datos ficticios, ni banners de modo: `npm run build` produce el
// producto, y punto. Una instalación sin datos simplemente está vacía, que es un
// estado normal y esperado, no una "versión" del producto.
//
// Este archivo sustituye al antiguo `lib/appMode.ts`. Lo que queda no son modos sino
// INTERRUPTORES puntuales de funcionalidad, que se apagan sin tocar la arquitectura.
// ============================================================

/**
 * RESTABLECIMIENTO DE FÁBRICA (borrado total de la instalación).
 *
 * Existe porque durante esta etapa las pruebas se hacen en equipos independientes y
 * hace falta poder volver a cero sin abrir DevTools. Es una herramienta de esta fase,
 * no una pieza del producto: cuando deje de hacer falta, se pone en `false` y la
 * opción desaparece de la interfaz sin que nada más cambie.
 *
 * Deliberadamente NO es una variable de entorno: reintroducir `VITE_*` para gobernar
 * comportamiento es exactamente el camino por el que volvieron DEMO y CLEAN. Es una
 * constante, se cambia en el código y queda en el historial de git.
 *
 * Y deliberadamente NO se llama DEMO ni CLEAN: nombra lo que hace.
 */
export const ENABLE_FACTORY_RESET = true

/** Nombre visible del producto. Uno solo, sin sufijos de modo. */
export const APP_NAME = 'RutaCash'
