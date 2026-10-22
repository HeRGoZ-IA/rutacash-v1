// UBICACIÓN DEL DISPOSITIVO en comandos en línea (Ronda 67): una lectura por intención, con el
// procedimiento estándar del navegador (`src/lib/geolocation.ts`, el mismo del abono). Nunca
// bloquea el comando: sin posición viaja la causa (`denied`, `timeout`…), sin coordenadas
// inventadas. La lectura va en el MISMO cuerpo del comando: un reintento con el mismo id de
// operación repite exactamente lo mismo y el servidor no duplica nada.
//
// Es la ubicación de QUIEN REGISTRA, no la del cliente: el servidor la guarda aparte y nunca la
// convierte en la ubicación de referencia del cliente.

import { captureLocation, type GeoCapture } from '@/lib/geolocation';

/** Cuerpo `location` que espera la API a partir de una lectura del dispositivo. */
export function locationBody(g: GeoCapture | undefined): Record<string, unknown> | undefined {
  if (!g) return undefined;
  const loc: Record<string, unknown> = { status: g.status };
  if (g.status === 'captured') {
    loc['lat'] = g.lat; loc['lng'] = g.lng;
    if (g.accuracyM != null) loc['accuracyM'] = g.accuracyM;
    if (g.capturedAt) loc['capturedAt'] = g.capturedAt;
  } else if (g.reason) {
    loc['reason'] = g.reason.slice(0, 200);
  }
  return loc;
}

/** Lectura para una venta en línea (siempre resuelve; nunca lanza). */
export async function saleDeviceLocation(): Promise<Record<string, unknown> | undefined> {
  return locationBody(await captureLocation());
}
