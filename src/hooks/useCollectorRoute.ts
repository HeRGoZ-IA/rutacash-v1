/**
 * App Cobrador — ruta actualmente seleccionada.
 *
 * NOTA (modelo de roles y permisos): la ruta activa ahora tiene una FUENTE ÚNICA
 * de verdad en `useActiveRoute` (persistida por usuario). Este hook se conserva como
 * alias retrocompatible para no romper las pantallas del cobrador que lo importan.
 */
export { useActiveRoute as useCollectorRoute } from './useActiveRoute'
