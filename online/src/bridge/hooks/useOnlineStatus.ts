// PUENTE de `src/hooks/useOnlineStatus.ts` (CLEAN). En ADEX Online «en línea» significa
// que el SERVIDOR responde (no solo que el navegador tenga red): lo marca la última
// petición a la API.

import { useRuntime } from '../../runtime/session.ts';

export function useOnlineStatus(): boolean {
  return useRuntime((s) => s.online);
}
