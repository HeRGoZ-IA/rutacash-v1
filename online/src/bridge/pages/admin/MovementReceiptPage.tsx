// PUENTE de `src/pages/admin/MovementReceiptPage.tsx` (CLEAN). `/comprobante/operacion/<id>` (R74) es el
// comprobante de una OPERACIÓN del libro del servidor (tipos de Base por Ruta y de gastos generales, y con Base por
// Ruta toda operación); cualquier otra fuente usa la página original de CLEAN sin cambios.
import { useParams } from 'react-router-dom'
import CleanMovementReceiptPage from '@clean/pages/admin/MovementReceiptPage'
import { OperationReceipt } from '../../../runtime/routeBase/OperationReceipt.tsx'

export default function MovementReceiptPage() {
  const { fuente } = useParams()
  return fuente === 'operacion' ? <OperationReceipt /> : <CleanMovementReceiptPage />
}
