// PUENTE de `src/lib/transferOperations.ts` (CLEAN). Mismo catálogo y mismas reglas; solo cambian
// las ayudas de las dos operaciones que ADEX Online usa (Ronda 59): sin explicaciones del modelo
// anterior («nunca el propio trabajador» ya no es cierto: el Cobrador registra su propia entrega).
import * as Clean from '@clean/lib/transferOperations';
import type { TransferMode, TransferOperationDef, TransferOperationKind } from '@clean/lib/transferOperations';

export * from '@clean/lib/transferOperations';

const AYUDA: Partial<Record<TransferOperationKind, string>> = {
  'entregar-capital': 'De tu caja a un cobrador o supervisor de tu ruta. No crea ningún préstamo.',
  'devolver-capital': 'Efectivo que un trabajador de tu ruta te entrega.',
};

export const TRANSFER_OPERATIONS: Record<TransferOperationKind, TransferOperationDef> = Object.fromEntries(
  Object.entries(Clean.TRANSFER_OPERATIONS).map(([k, d]) => [k, AYUDA[k as TransferOperationKind] ? { ...d, ayuda: AYUDA[k as TransferOperationKind]! } : d]),
) as Record<TransferOperationKind, TransferOperationDef>;

export function operationDef(kind: TransferOperationKind, modo?: TransferMode): TransferOperationDef {
  const d = Clean.operationDef(kind, modo);
  return AYUDA[kind] ? { ...d, ayuda: AYUDA[kind]! } : d;
}
