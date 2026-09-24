// ============================================================
// useDataRevision — "la base cambió, vuelve a leer"
// ------------------------------------------------------------
// Contador que sube cada vez que se confirma una escritura en las tablas indicadas
// (en esta pestaña o en otra del mismo navegador). Las pantallas lo añaden a las
// dependencias del efecto que ya tenían para cargar datos: así el cálculo sigue
// siendo EL MISMO y solo cambia CUÁNDO se repite.
//
// Se agrupan ráfagas (un pago toca payments + installments + sales + auditLogs en
// una sola transacción, pero un flujo puede encadenar varias) para no recalcular
// la pantalla varias veces seguidas.
// ============================================================
import { useEffect, useState } from 'react'
import { OPERATIONAL_TABLES, subscribeDataChanges } from '@/lib/dataRevision'

export function useDataRevision(tables: readonly string[] = OPERATIONAL_TABLES, debounceMs = 150): number {
  const [revision, setRevision] = useState(0)
  const key = tables.join(',')

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeDataChanges(tables, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setRevision(r => r + 1), debounceMs)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
    // `key` representa `tables`: una lista nueva con el mismo contenido no
    // resuscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, debounceMs])

  return revision
}
