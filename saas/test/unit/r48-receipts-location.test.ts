// RONDA 48 · reglas de presentación compartidas por CLEAN y ADEX Online (src/lib):
//   · destinatario de WhatsApp para recibos (H-02): Colombia y Brasil, sin adivinar;
//   · lectura de ubicación del dispositivo (D-UX48-02/03): siempre resuelve, con causa.
// Números de teléfono 100 % sintéticos.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { companyWhatsAppCountry, resolveWhatsAppRecipient, whatsAppLink } from '@/lib/whatsapp';
import { captureLocation } from '@/lib/geolocation';

const digits = (phone: string, pais: string) => {
  const r = resolveWhatsAppRecipient(phone, pais);
  return r.ok ? r.digits : null;
};

describe('Ronda 48 · destinatario de WhatsApp', () => {
  test('WA-001 · Colombia: móvil nacional, con 57 y con + producen el mismo destino; nunca se duplica el prefijo', () => {
    for (const p of ['300 123 4567', '3001234567', '(300) 123-4567', '57 300 123 4567', '573001234567', '+57 300 123 4567', '0057 3001234567']) {
      assert.equal(digits(p, 'CO'), '573001234567', p);
    }
    assert.equal(digits('300 123 4567', 'Colombia'), '573001234567', 'CLEAN guarda el país por nombre');
  });

  test('WA-002 · Brasil: DDD + 9 dígitos, con 0 de larga distancia, con 55 y con +', () => {
    for (const p of ['11 98765-4321', '11987654321', '(11) 98765-4321', '0 11 98765-4321', '55 11 98765-4321', '5511987654321', '+55 11 98765 4321']) {
      assert.equal(digits(p, 'BR'), '5511987654321', p);
    }
    assert.equal(digits('(55) 99123-4567', 'BR'), '5555991234567', 'DDD 55 (RS) no se confunde con el prefijo del país');
    assert.equal(digits('11 98765-4321', 'Brasil'), '5511987654321');
  });

  test('WA-003 · el número de una empresa de Brasil NUNCA sale hacia Colombia (el fallo de antes: wa.me/57 fijo)', () => {
    const r = resolveWhatsAppRecipient('11 98765-4321', 'BR');
    assert.ok(r.ok && r.digits.startsWith('55') && !r.digits.startsWith('57'));
    // Un móvil colombiano escrito como internacional en una empresa de Brasil va a Colombia, como se escribió.
    assert.equal(digits('+57 300 123 4567', 'BR'), '573001234567');
  });

  test('WA-004 · ambiguos o inválidos: no se construye destinatario', () => {
    const casos: [string | null | undefined, string][] = [
      ['', 'CO'], [null, 'CO'], [undefined, 'BR'],
      ['1', 'CO'],                       // dato de relleno
      ['601 234 5678', 'CO'],            // fijo de Colombia
      ['300 123 456', 'CO'],             // falta un dígito
      ['11 3456-7890', 'BR'],            // fijo de Brasil (8 dígitos sin 9)
      ['20 98765-4321', 'BR'],           // DDD inexistente
      ['0 21 11 98765-4321', 'BR'],      // con código de operadora
      ['+1 415 555 0100', 'CO'],         // país fuera de la plataforma
      ['300 123 4567 ext 2', 'CO'],      // texto añadido
      ['300 123 4567', ''],              // empresa sin país conocido
      ['300 123 4567', 'Argentina'],
    ];
    for (const [phone, pais] of casos) {
      const r = resolveWhatsAppRecipient(phone, pais);
      assert.equal(r.ok, false, `${phone} / ${pais}`);
      if (!r.ok) assert.ok(r.reason.length > 10);
    }
  });

  test('WA-005 · enlace y texto visible del destinatario', () => {
    const r = resolveWhatsAppRecipient('300 123 4567', 'CO');
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.display, '+57 300 123 4567');
      assert.equal(whatsAppLink(r, 'Pago $ 10.000'), 'https://wa.me/573001234567?text=Pago%20%24%2010.000');
    }
    const b = resolveWhatsAppRecipient('11987654321', 'BR');
    assert.ok(b.ok && b.display === '+55 11 98765-4321');
    assert.deepEqual([companyWhatsAppCountry('co'), companyWhatsAppCountry('Brasil'), companyWhatsAppCountry('PE')], ['CO', 'BR', null]);
  });
});

// ---------- Ubicación: navegador simulado ----------
type GeoStub = { getCurrentPosition: (ok: (p: unknown) => void, err: (e: { code: number; message: string }) => void, o?: unknown) => void };
const g = globalThis as unknown as { navigator?: unknown; window?: unknown; document?: unknown };
const original = { navigator: g.navigator, window: g.window, document: g.document };
function browser(geo: GeoStub | null, { secure = true, policyAllows = true } = {}) {
  Object.defineProperty(globalThis, 'navigator', { value: geo ? { geolocation: geo } : {}, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: { isSecureContext: secure }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: { permissionsPolicy: { allowsFeature: () => policyAllows } }, configurable: true, writable: true });
}
afterEach(() => {
  for (const k of ['navigator', 'window', 'document'] as const) {
    Object.defineProperty(globalThis, k, { value: original[k], configurable: true, writable: true });
  }
});

describe('Ronda 48 · lectura de ubicación', () => {
  test('GEO-001 · posición real: lat, lng, precisión y hora; nada inventado', async () => {
    const ts = Date.now();
    browser({ getCurrentPosition: (ok) => ok({ coords: { latitude: 4.711, longitude: -74.0721, accuracy: 23.6 }, timestamp: ts }) });
    const r = await captureLocation();
    assert.deepEqual(r, { status: 'captured', lat: 4.711, lng: -74.0721, accuracyM: 24, capturedAt: new Date(ts).toISOString() });
  });

  test('GEO-002 · cada error del navegador se traduce a su causa; nunca lanza', async () => {
    const casos: [number, string, string][] = [
      [1, 'User denied Geolocation', 'denied'],
      [1, 'Geolocation has been disabled in this document by permissions policy.', 'unsupported'],
      [2, 'Position unavailable', 'unavailable'],
      [3, 'Timeout expired', 'timeout'],
    ];
    for (const [code, message, status] of casos) {
      browser({ getCurrentPosition: (_ok, err) => err({ code, message }) });
      const r = await captureLocation();
      assert.equal(r.status, status, message);
      assert.equal(r.lat, undefined);
      assert.ok(r.reason);
    }
  });

  test('GEO-003 · sin API, sin HTTPS o bloqueada por la política del sitio: «unsupported» sin pedir nada', async () => {
    let asked = false;
    const geo = { getCurrentPosition: () => { asked = true; } };
    browser(null);
    assert.equal((await captureLocation()).status, 'unsupported');
    browser(geo, { secure: false });
    assert.equal((await captureLocation()).status, 'unsupported');
    browser(geo, { policyAllows: false });
    assert.equal((await captureLocation()).status, 'unsupported');
    assert.equal(asked, false);
  });

  test('GEO-004 · aviso de permiso sin respuesta: se corta a tiempo con «timeout» y el abono no espera para siempre', async () => {
    browser({ getCurrentPosition: () => { /* el usuario no responde al aviso */ } });
    const t0 = Date.now();
    const r = await captureLocation({ promptLimitMs: 80 });
    assert.equal(r.status, 'timeout');
    assert.ok(Date.now() - t0 < 2000);
  });

  test('GEO-005 · coordenadas no numéricas del dispositivo: «unavailable», nunca se guardan', async () => {
    browser({ getCurrentPosition: (ok) => ok({ coords: { latitude: Number.NaN, longitude: 1, accuracy: 5 }, timestamp: Date.now() }) });
    const r = await captureLocation();
    assert.equal(r.status, 'unavailable');
    assert.equal(r.lat, undefined);
  });

});
