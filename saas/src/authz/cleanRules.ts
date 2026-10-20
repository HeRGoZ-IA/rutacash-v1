// Puente a las reglas de autorización de CLEAN (DS-01: reutilizar `src/lib` como
// contrato). El servidor NO reimplementa la matriz de roles: llama a las mismas
// funciones que la aplicación local (`can`, `canManageUser`, protección del último
// SuperAdmin), con un `User` construido desde UNA membresía activa (DS-05).
//
// El objeto `User` que se construye aquí vive solo en memoria del servidor y no
// lleva contraseña: CLEAN no la consulta para autorizar.

import {
  ROLE_CAPABILITIES, can, canManageUser, isCapabilityCompatible, isRouteUnrestricted,
  type Capability, type PermissionContext,
} from '@/lib/permissions';
import { blockIfLastSuperadmin } from '@/lib/superadminProtection';
import type { User, UserRole } from '@/models/types';

export type { Capability, UserRole };

// Roles de ADEX Online. Socio se retiró en la Ronda 53 (sigue existiendo en el tipo de CLEAN,
// que CLEAN conserva para su propio uso; el servidor no lo acepta: 0023 lo excluye del esquema).
export const USER_ROLES: readonly UserRole[] = ['superadmin', 'admin', 'supervisor', 'cobrador', 'secretario'];

export interface MembershipFacts {
  membershipId: string;
  companyId: string;
  role: UserRole;
  status: 'activo' | 'inactivo';
  displayName: string;
  routeIds: readonly string[];
  createdAt?: string;
}

export function toCleanUser(m: MembershipFacts): User {
  return {
    id: m.membershipId,
    tenantId: m.companyId,
    rol: m.role,
    status: m.status,
    nombre: m.displayName,
    authorizedRouteIds: [...m.routeIds],
    createdAt: m.createdAt ?? '',
    updatedAt: m.createdAt ?? '',
  } as Partial<User> as User;
}

/** `can()` de CLEAN, siempre dentro de la empresa del contexto. */
export function allowed(actor: MembershipFacts, capability: Capability, ctx: Omit<PermissionContext, 'tenantId'> = {}): boolean {
  return can(toCleanUser(actor), capability, { ...ctx, tenantId: actor.companyId });
}

export function mayManage(actor: MembershipFacts, target: MembershipFacts): boolean {
  return canManageUser(toCleanUser(actor), toCleanUser(target));
}

export function lastSuperadminBlock(target: MembershipFacts, companyMembers: MembershipFacts[]) {
  return blockIfLastSuperadmin(toCleanUser(target), companyMembers.map(toCleanUser));
}

export function routeUnrestricted(actor: MembershipFacts): boolean {
  return isRouteUnrestricted(toCleanUser(actor));
}

/** Capacidades efectivas del rol (modelo puro ROL + RUTAS: `can()` ignora otorgadas/retiradas). */
export function capabilitiesOf(role: UserRole): Capability[] {
  return (ROLE_CAPABILITIES[role] ?? []).filter((c) => isCapabilityCompatible(role, c));
}
