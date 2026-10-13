// Dinero exacto: unidades menores en bigint. Nunca number/float.
// El número de decimales viene de la moneda (ISO 4217), no se supone 2.

export class MoneyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const MAX_INT8 = 9223372036854775807n; // límite de bigint en PostgreSQL
const AMOUNT_RE = /^(0|[1-9][0-9]{0,18})(?:\.([0-9]+))?$/;

function assertMinorUnits(minorUnits: number): void {
  if (!Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) {
    throw new MoneyError('INVALID_MINOR_UNITS', `minor units must be an integer 0..4, got ${minorUnits}`);
  }
}

/** "4000.00" (BRL, 2 decimales) → 400000n. Solo cadenas decimales; rechaza números JS. */
export function parseAmount(input: unknown, minorUnits: number): bigint {
  assertMinorUnits(minorUnits);
  if (typeof input !== 'string') {
    throw new MoneyError('AMOUNT_MUST_BE_STRING', 'amount must be a decimal string, never a JSON number');
  }
  const m = AMOUNT_RE.exec(input);
  if (!m) throw new MoneyError('INVALID_AMOUNT_FORMAT', `invalid amount "${input}"`);
  const fraction = m[2] ?? '';
  if (fraction.length > minorUnits) {
    throw new MoneyError('TOO_MANY_DECIMALS', `amount "${input}" has more than ${minorUnits} decimals`);
  }
  const minor = BigInt(m[1] as string) * 10n ** BigInt(minorUnits) + BigInt(fraction.padEnd(minorUnits, '0') || '0');
  if (minor > MAX_INT8) throw new MoneyError('AMOUNT_OUT_OF_RANGE', `amount "${input}" exceeds bigint range`);
  return minor;
}

/** 400000n con 2 decimales → "4000.00"; con 0 decimales → "400000". */
export function formatMinor(minor: bigint, minorUnits: number): string {
  assertMinorUnits(minorUnits);
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString();
  if (minorUnits === 0) return (negative ? '-' : '') + digits;
  const padded = digits.padStart(minorUnits + 1, '0');
  const intPart = padded.slice(0, padded.length - minorUnits);
  const fracPart = padded.slice(padded.length - minorUnits);
  return `${negative ? '-' : ''}${intPart}.${fracPart}`;
}
