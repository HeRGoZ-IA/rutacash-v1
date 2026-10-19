// COMANDOS a la API desde las pantallas de CLEAN.
//
// Las pantallas originales muestran `toast.error(e.message)` cuando un servicio lanza:
// aquí cada fallo de la API se convierte en un `Error` con el MISMO texto en español que
// usan las pantallas Online (`lib/format.ts`). Tras un comando confirmado se invalida la
// proyección de lectura: todas las pantallas vuelven a leer del servidor.
//
//   · `money()`  — comando de DINERO o alta idempotente: lleva `X-Adex-Operation-Id`. Si la
//                   respuesta se pierde, el cliente CONSULTA el resultado por ese id antes
//                   de repetir (nunca duplica). Si tampoco se puede consultar, el error dice
//                   que el resultado es incierto y la pantalla no debe repetir a ciegas.
//   · `plain()`  — comando sin idempotencia en el servidor (aprobar, rechazar, editar…).

import { ApiFailure, NetworkFailure, UncertainOperation } from '../lib/client.ts';
import { errorText } from '../lib/format.ts';
import { api } from './session.ts';
import { invalidate } from './projection.ts';

export class OnlineCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OnlineCommandError';
    this.code = code;
  }
}

function translate(e: unknown): Error {
  if (e instanceof UncertainOperation) {
    return new OnlineCommandError('UNCERTAIN_OPERATION', 'No se pudo confirmar la operación con el servidor. No la repita: recargue la pantalla y compruebe si quedó registrada.');
  }
  if (e instanceof NetworkFailure) return new OnlineCommandError('NETWORK', `${errorText(e)} La operación no se confirmó.`);
  if (e instanceof ApiFailure) return new OnlineCommandError(e.code, errorText(e));
  return e instanceof Error ? e : new Error(String(e));
}

/** Comando de dinero o alta idempotente (un id por intención; reintento seguro con el mismo id). */
export async function money<T = Record<string, unknown>>(method: string, path: string, body: unknown, operationId?: string): Promise<T> {
  try {
    const r = await api().command<T>(method, path, body, operationId && isUuid(operationId) ? operationId : undefined);
    invalidate();
    return r;
  } catch (e) {
    // Un 4xx definitivo también puede haber cambiado el estado visible (p. ej. REQUEST_STATE_INVALID).
    if (e instanceof ApiFailure) invalidate();
    throw translate(e);
  }
}

/** Comando sin idempotencia en el servidor: ante red caída, la pantalla relee el estado. */
export async function plain<T = Record<string, unknown>>(method: string, path: string, body: unknown = {}): Promise<T> {
  try {
    const r = await api().send<T>(method, path, body);
    invalidate();
    return r;
  } catch (e) {
    invalidate();
    throw translate(e);
  }
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
