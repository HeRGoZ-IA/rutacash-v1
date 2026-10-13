import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MoneyError, formatMinor, parseAmount } from '../../src/money.ts';

const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof MoneyError ? e.code : 'OTHER'; }
  return 'NO_ERROR';
};

test('INTL-003 [unit] importes exactos en unidades menores, sin coma flotante', async (t) => {
  await t.test('BRL/COP (2 decimales): "4000.00" → 400000n y vuelta', () => {
    assert.equal(parseAmount('4000.00', 2), 400000n);
    assert.equal(parseAmount('4000', 2), 400000n);
    assert.equal(parseAmount('0.01', 2), 1n);
    assert.equal(formatMinor(400000n, 2), '4000.00');
    assert.equal(formatMinor(1n, 2), '0.01');
    assert.equal(formatMinor(0n, 2), '0.00');
  });
  await t.test('0.1 + 0.2 es exactamente 0.3 (en float no lo es)', () => {
    assert.notEqual(0.1 + 0.2, 0.3);
    assert.equal(formatMinor(parseAmount('0.10', 2) + parseAmount('0.20', 2), 2), '0.30');
  });
  await t.test('monedas con 0 y 4 decimales (no se supone 2)', () => {
    assert.equal(parseAmount('1500', 0), 1500n);
    assert.equal(code(() => parseAmount('1500.5', 0)), 'TOO_MANY_DECIMALS');
    assert.equal(formatMinor(1500n, 0), '1500');
    assert.equal(parseAmount('1.2345', 4), 12345n);
    assert.equal(formatMinor(12345n, 4), '1.2345');
  });
  await t.test('valores mayores que Number.MAX_SAFE_INTEGER se conservan exactos', () => {
    const big = '92233720368547758.07'; // = 2^63 - 1 en centavos
    assert.equal(parseAmount(big, 2), 9223372036854775807n);
    assert.equal(formatMinor(parseAmount(big, 2), 2), big);
    assert.equal(code(() => parseAmount('92233720368547758.08', 2)), 'AMOUNT_OUT_OF_RANGE');
  });
  await t.test('rechaza números JS, negativos, exponentes y formatos ambiguos', () => {
    assert.equal(code(() => parseAmount(4000, 2)), 'AMOUNT_MUST_BE_STRING');
    assert.equal(code(() => parseAmount(40.5, 2)), 'AMOUNT_MUST_BE_STRING');
    for (const bad of ['-1.00', '1e3', '1,00', '01.00', '.5', '1.', ' 1', '1.000', '', 'NaN', 'Infinity']) {
      assert.notEqual(code(() => parseAmount(bad, 2)), 'NO_ERROR', bad);
    }
  });
  await t.test('decimales de moneda fuera de 0..4 se rechazan', () => {
    assert.equal(code(() => parseAmount('1', 5)), 'INVALID_MINOR_UNITS');
    assert.equal(code(() => parseAmount('1', 1.5)), 'INVALID_MINOR_UNITS');
  });
});
