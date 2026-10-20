// PUENTE de `src/components/owner/FactoryResetDialog.tsx` (CLEAN): en ADEX Online no hay
// base local que restablecer (ver `lib/featureFlags.ts`). Nunca se muestra.
export const FACTORY_RESET_PHRASE = 'RESTABLECER'
export function matchesFactoryResetPhrase(input: string): boolean { return input.trim() === FACTORY_RESET_PHRASE }
export function FactoryResetDialog(_props: { open: boolean; onClose: () => void }) { return null }
