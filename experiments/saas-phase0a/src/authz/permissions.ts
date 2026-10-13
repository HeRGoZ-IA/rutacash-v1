// Matriz EXPERIMENTAL de la POC. No refleja ni modifica los roles de CLEAN
// (src/lib/permissions.ts). Sirve solo para demostrar que los permisos se
// evalúan con UNA membresía activa y nunca se acumulan.

export type Role = 'admin' | 'supervisor' | 'cobrador';
export type Permission = 'account.read' | 'ledger.deposit' | 'ledger.withdraw';

const MATRIX: Readonly<Record<Role, readonly Permission[]>> = {
  admin: ['account.read', 'ledger.deposit', 'ledger.withdraw'],
  supervisor: ['account.read'],
  cobrador: ['account.read', 'ledger.withdraw'],
};

export interface MembershipGrant {
  role: Role;
  scope: 'company' | 'routes';
  routeIds: readonly string[];
}

export function roleAllows(role: Role, permission: Permission): boolean {
  return MATRIX[role].includes(permission);
}

/** Recibe UNA membresía, no una lista: no hay forma de unir permisos de varias. */
export function can(grant: MembershipGrant, permission: Permission, target?: { routeId: string | null }): boolean {
  if (!roleAllows(grant.role, permission)) return false;
  if (!target || grant.scope === 'company') return true;
  return target.routeId !== null && grant.routeIds.includes(target.routeId);
}
