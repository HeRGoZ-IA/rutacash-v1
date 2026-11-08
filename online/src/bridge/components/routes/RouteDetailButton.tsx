// 3.37 (pedido de Helmer, 2026-11-08): «Ver detalle» junto a «Editar» en las tarjetas de Rutas. Abre la MISMA ventana
// de detalle de ruta que Caja principal (`runtime/routeBase/RouteDetail.tsx`): un solo componente, no una copia.
import { useState } from 'react'
import { Eye } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { RouteDetailLoader } from '../../../runtime/routeBase/RouteDetail.tsx'

export function RouteDetailButton({ routeId }: { routeId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} icon={<Eye className="w-3.5 h-3.5" />} className="flex-1 whitespace-nowrap" data-testid="route-card-detail">Ver detalle</Button>
      <RouteDetailLoader routeId={open ? routeId : null} onClose={() => setOpen(false)} />
    </>
  )
}
