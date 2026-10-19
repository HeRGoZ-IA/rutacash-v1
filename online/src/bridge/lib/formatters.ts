// PUENTE de `src/lib/formatters.ts` (CLEAN): todos los formatos originales, salvo la
// MONEDA, que pasa a ser la de la empresa del contexto (código definido por el
// servidor). CLEAN muestra importes enteros sin decimales: se conserva igual para los
// importes enteros, y solo un importe con fracción real (el servidor admite unidades
// menores) muestra sus decimales en vez de redondearse a una cifra que no es.

import { useRuntime } from '../../runtime/session.ts';

export * from '@clean/lib/formatters';

export function formatCurrency(value: number, currency?: string): string {
  // Cifra que CLEAN calculaba con su libro local y el servidor no tiene (NaN): «—», nunca
  // un número inventado. Cada pantalla explica cuáles son.
  if (Number.isNaN(value)) return '—';
  const company = useRuntime.getState().ctx?.company;
  const code = currency ?? company?.currencyCode ?? 'COP';
  const decimals = Number.isInteger(value) ? 0 : company?.minorUnits ?? 2;
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: code,
    // COP conserva el formato exacto de CLEAN; otra moneda muestra su símbolo (R$, US$…)
    // en vez del código ISO que daría el formato colombiano.
    ...(code === 'COP' ? {} : { currencyDisplay: 'narrowSymbol' as const }),
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}
