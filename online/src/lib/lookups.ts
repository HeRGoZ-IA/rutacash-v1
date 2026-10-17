// Catálogos que las pantallas necesitan para mostrar nombres (rutas, clientes,
// personas). Siempre del servidor y con el alcance del contexto activo.

import { useApp, useResource } from './app.tsx';

export interface RouteView { id: string; name: string; code: string; collectorId: string | null; capitalControllerId: string | null; interestRate: number; maxLoanMinor: number; status: string }
export interface ClientView { id: string; routeId: string; name: string; document: string; documentType: string | null; phonePrimary: string; addressPrimary: string; addressSecondary: string | null; business: string | null; status: string; notes: string | null; createdAt: string }
export interface MemberView { membershipId: string; role: string; status: string; displayName: string; routeIds: string[] }

export function useRoutes() {
  const { client } = useApp();
  return useResource(async () => (await client.get<{ routes: RouteView[] }>('/v1/routes')).routes, [], 60_000);
}

export function useClients() {
  const { client } = useApp();
  return useResource(async () => (await client.get<{ clients: ClientView[] }>('/v1/clients')).clients, [], 30_000);
}

/** Personas de la empresa (solo roles con `user.viewAll`); el resto recibe una lista vacía. */
export function useMembers(enabled: boolean) {
  const { client } = useApp();
  return useResource(async () => (enabled ? (await client.get<{ members: MemberView[] }>('/v1/members')).members : []), [enabled], 60_000);
}

export function nameOf<T extends { id: string; name: string }>(list: T[] | null, id: string | null | undefined): string {
  if (!id) return '—';
  return list?.find((x) => x.id === id)?.name ?? 'Fuera de su alcance';
}
