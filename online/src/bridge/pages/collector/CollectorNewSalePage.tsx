// ADEX Online: envoltorio de src/pages/collector/CollectorNewSalePage.tsx (CLEAN), que se usa SIN cambios.
// Ronda 65-C1 (decisión del propietario): el COBRADOR sin servidor al alcance no registra ventas; en
// lugar del formulario ve «Operación no disponible sin internet» y llama a la oficina. Con conexión,
// la pantalla original con sus permisos y reglas de siempre.
import { useNavigate } from 'react-router-dom'
import CleanCollectorNewSalePage from '@clean/pages/collector/CollectorNewSalePage'
import { OfflineOperationBlocked, useNewClientsAndSalesBlocked } from '../../../offline/ui.tsx'

export default function CollectorNewSalePage() {
  const navigate = useNavigate()
  const blocked = useNewClientsAndSalesBlocked()
  return blocked ? <OfflineOperationBlocked onBack={() => navigate(-1)} /> : <CleanCollectorNewSalePage />
}
