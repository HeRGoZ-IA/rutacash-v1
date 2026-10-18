// Ayudas de las pantallas de administración. Solo deciden qué controles se MUESTRAN:
// cada comando lo vuelve a autorizar el servidor con las reglas de CLEAN.

import { useRef, useState } from 'react';
import { parseMoney } from './format.ts';
import type { MemberView, RouteView } from './lookups.ts';

/** Roles que cada rol puede gestionar (copia de `MANAGEABLE_ROLES` de src/lib/permissions.ts). */
const MANAGEABLE: Record<string, string[]> = {
  superadmin: ['superadmin', 'admin', 'socio', 'supervisor', 'cobrador', 'secretario'],
  admin: ['socio', 'supervisor', 'cobrador', 'secretario'],
};

export const ROLE_ORDER = ['superadmin', 'admin', 'socio', 'supervisor', 'cobrador', 'secretario'];

export function manageableRoles(actorRole: string): string[] {
  return MANAGEABLE[actorRole] ?? [];
}

export function manages(actorRole: string, targetRole: string): boolean {
  return manageableRoles(actorRole).includes(targetRole);
}

export function memberName(members: MemberView[] | null, id: string | null | undefined): string {
  if (!id) return '—';
  return members?.find((m) => m.membershipId === id)?.displayName ?? 'Persona fuera de su alcance';
}

export function routeLabel(r: Pick<RouteView, 'name' | 'code'>): string {
  return r.code ? `${r.name} (${r.code})` : r.name;
}

/** Texto plano → unidades menores (admite 0, a diferencia de `parseMoney`). */
export function parseLimit(text: string, minorUnits: number): number | null {
  const t = text.replace(/\s/g, '');
  if (t === '' || /^0+([.,]0*)?$/.test(t)) return 0;
  return parseMoney(t, minorUnits);
}

/** Unidades menores → texto editable sin separadores de miles. */
export function minorToText(minor: number, minorUnits: number): string {
  if (!minorUnits) return String(minor);
  return `${Math.trunc(minor / 10 ** minorUnits)},${String(minor % 10 ** minorUnits).padStart(minorUnits, '0')}`;
}

/** Tasa porcentual («20», «20,5» o «20.5») → número; null si no es válida. */
export function parseRate(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,4})?$/.test(t)) return null;
  const v = Number(t);
  return v <= 1000 ? v : null;
}

/**
 * Un `X-Adex-Operation-Id` por INTENCIÓN de alta: se conserva mientras el contenido del
 * formulario no cambie, así que pulsar otra vez tras una respuesta perdida repite la
 * MISMA operación (el servidor devuelve la ya confirmada, sin duplicar). `confirmed()`
 * lo descarta cuando el servidor confirma: la siguiente alta lleva un id nuevo.
 */
export function useIntent(content: unknown): { operationId: string; confirmed: () => void } {
  const key = JSON.stringify(content);
  const ref = useRef<{ key: string; id: string } | null>(null);
  if (!ref.current || ref.current.key !== key) ref.current = { key, id: crypto.randomUUID() };
  return { operationId: ref.current.id, confirmed: () => { ref.current = null; } };
}

/**
 * Estado editable que se resincroniza cuando cambia lo que dice el servidor (otra
 * sesión, o el resultado de un comando), sin remontar el formulario ni perder su mensaje.
 */
export function useSynced<T>(server: T): [T, (v: T) => void] {
  const key = JSON.stringify(server);
  const [s, setS] = useState({ key, v: server });
  if (s.key !== key) {
    setS({ key, v: server });
    return [server, (v) => setS({ key, v })];
  }
  return [s.v, (v) => setS({ key, v })];
}
