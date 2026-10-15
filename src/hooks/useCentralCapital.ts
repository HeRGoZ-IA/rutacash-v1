// ============================================================
// useCentralCapital — ¿esta empresa opera con capital centralizado? (C2)
// ------------------------------------------------------------
// Las pantallas eligen el circuito (v16 o centralizado) con este estado, leído de la
// empresa en ESTE navegador. Se relee si cambia la empresa (activación, bloqueos).
// `listo` evita ofrecer botones del circuito equivocado mientras se carga.
// ============================================================
import { useEffect, useState } from 'react'
import { db } from '@/lib/db'
import { isCentralCapitalActive } from '@/lib/centralCapital'
import { useDataRevision } from '@/hooks/useDataRevision'
import type { CentralCapitalRouteBlock } from '@/models/types'

export interface CentralCapitalState {
  listo: boolean
  activo: boolean
  desde?: string
  bloqueos: Record<string, CentralCapitalRouteBlock>
  heredadoAlActivar: Record<string, number>
}

const TABLAS = ['tenants'] as const

export function useCentralCapital(tenantId: string): CentralCapitalState {
  const revision = useDataRevision(TABLAS)
  const [estado, setEstado] = useState<CentralCapitalState>({ listo: false, activo: false, bloqueos: {}, heredadoAlActivar: {} })
  useEffect(() => {
    let alive = true
    if (!tenantId) { setEstado({ listo: true, activo: false, bloqueos: {}, heredadoAlActivar: {} }); return }
    db.tenants.get(tenantId).then(t => {
      if (!alive) return
      setEstado({
        listo: true, activo: isCentralCapitalActive(t), desde: t?.centralCapitalStartAt,
        bloqueos: t?.centralCapitalRouteBlocks ?? {}, heredadoAlActivar: t?.centralCapitalHeritage ?? {},
      })
    }, () => { if (alive) setEstado(e => ({ ...e, listo: true })) })
    return () => { alive = false }
  }, [tenantId, revision])
  return estado
}
