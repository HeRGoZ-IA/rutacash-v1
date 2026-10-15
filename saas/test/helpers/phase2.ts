// Atajos de las pruebas de la Fase 2: llamar a la API como una persona sintética
// con una de sus membresías.

import { membershipId, type Person } from '../../db/seeds/synthetic.ts';
import type { ApiResponse, LocalIssuer, TestServer } from './auth.ts';

export const M = {
  brunoSa: membershipId('c1', 'bruno-sa'), anaAdmin: membershipId('c1', 'ana-admin'), anaCob: membershipId('c1', 'ana-cob'),
  fabioSocio: membershipId('c1', 'fabio-socio'), gabiSec: membershipId('c1', 'gabi-sec'), ivanHist: membershipId('c1', 'ivan-hist'),
  carlaSa: membershipId('c2', 'carla-sa'), hugoAdmin: membershipId('c2', 'hugo-admin'), anaSup: membershipId('c2', 'ana-sup'),
  elisaCob: membershipId('c2', 'elisa-cob'), diegoSa: membershipId('c3', 'diego-sa'),
};

export type Caller = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<ApiResponse>;

export function caller(api: TestServer, issuer: LocalIssuer, person: Person | string, membership: string): Caller {
  let token: string | null = null;
  return async (method, path, body, headers) => {
    token ??= await issuer.issue(person);
    return api.call(method, path, { token, membership, body: body ?? (method === 'GET' ? undefined : {}), headers });
  };
}

/** Lanza N peticiones a la vez (clientes paralelos reales contra la API). */
export function parallel<T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
}
