// ============================================================
// Diff de asignaciones de ruta (PURO, sin dependencias de DB) — testeable.
// ------------------------------------------------------------
// Dada la membresía DESEADA (borrador) y la ACTUAL, calcula qué usuarios se agregan
// y cuáles se retiran. El cobrador responsable siempre queda como miembro. Solo se
// consideran retiros dentro de `assignableUserIds` (+ cobradores prev/nuevo), para no
// tocar asignaciones fuera del alcance del actor.
// ============================================================

export interface RouteAssignmentDiffParams {
  routeId: string
  assignableUserIds: string[]
  assignedUserIds: string[]
  cobradorId?: string
  prevCobradorId?: string
  /** Rutas actuales (authorizedRouteIds) de cada usuario. */
  membershipOf: (userId: string) => string[]
}

export function computeRouteAssignmentDiff(params: RouteAssignmentDiffParams): { added: string[]; removed: string[] } {
  const affected = new Set<string>(params.assignableUserIds)
  if (params.prevCobradorId) affected.add(params.prevCobradorId)
  if (params.cobradorId) affected.add(params.cobradorId)
  const finalMembers = new Set(params.assignedUserIds)
  if (params.cobradorId) finalMembers.add(params.cobradorId)
  const added: string[] = []
  const removed: string[] = []
  for (const id of affected) {
    const current = params.membershipOf(id).includes(params.routeId)
    const desired = finalMembers.has(id)
    if (desired && !current) added.push(id)
    else if (!desired && current) removed.push(id)
  }
  return { added, removed }
}
