// 3.28 · «Pérdida por créditos (capital)» en Liquidaciones. En CLEAN (motor local) no existe el castigo con asiento:
// no muestra nada. ADEX Online lo sustituye por `online/src/bridge/components/settlement/CreditLossNote.tsx`.
export function CreditLossNote(_props: { routeId: string; from: string; to: string; currency?: string }) {
  return null
}
