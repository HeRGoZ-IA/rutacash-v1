// `useLiveQuery` de dexie-react-hooks con el mismo contrato (undefined mientras carga,
// se repite al cambiar las dependencias), pero «vivo» respecto al SERVIDOR: la consulta
// se repite cuando la proyección de lectura cambia (comando confirmado o refresco).

import { useEffect, useState } from 'react';
import { currentRevision, subscribe } from '../../runtime/projection.ts';

export function useLiveQuery<T, D = undefined>(querier: () => Promise<T> | T, deps: unknown[] = [], defaultResult?: D): T | D {
  const [rev, setRev] = useState(currentRevision);
  const [value, setValue] = useState<T | D>(defaultResult as D);
  useEffect(() => subscribe(() => setRev(currentRevision())), []);
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(querier)
      .then((v) => { if (alive) setValue(v); })
      .catch((e) => { if (alive) console.error('[ADEX Online] lectura', e); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, rev]);
  return value;
}
