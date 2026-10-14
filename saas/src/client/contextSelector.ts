// Selector mínimo de empresa y rol (DS-05; diseño aprobado el 2026-10-14):
//   · Las membresías se listan como «Empresa · Rol · País».
//   · Una sola membresía ACTIVA y operable → se entra directamente.
//   · Varias → la elección es obligatoria.
//   · Empresa suspendida o vencida → aparece con aviso y NO se puede elegir.
//   · Membresía inactiva → no aparece.
//   · Nunca hay una vista que combine empresas: siempre UNA membresía activa.

export interface SelectableMembership {
  membershipId: string;
  role: string;
  status: 'activo' | 'inactivo';
  company: { id: string; name: string; countryCode: string; operable: boolean };
}

export interface SelectorOption {
  membershipId: string;
  label: string;
  selectable: boolean;
  notice: string | null;
}

export type SelectorDecision =
  | { kind: 'auto'; membershipId: string; options: SelectorOption[] }
  | { kind: 'choose'; options: SelectorOption[] }
  | { kind: 'none'; options: SelectorOption[] };

export const ROLE_LABEL: Record<string, string> = {
  superadmin: 'Super Admin', admin: 'Administrador', socio: 'Socio', supervisor: 'Supervisor', cobrador: 'Cobrador', secretario: 'Secretario',
};

export function selectorOptions(memberships: SelectableMembership[]): SelectorOption[] {
  return memberships
    .filter((m) => m.status === 'activo')
    .map((m) => ({
      membershipId: m.membershipId,
      label: `${m.company.name} · ${ROLE_LABEL[m.role] ?? m.role} · ${m.company.countryCode}`,
      selectable: m.company.operable,
      notice: m.company.operable ? null : 'Servicio suspendido. Contacte al proveedor.',
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function decideContext(memberships: SelectableMembership[]): SelectorDecision {
  const options = selectorOptions(memberships);
  const usable = options.filter((o) => o.selectable);
  if (usable.length === 1 && options.length === 1) return { kind: 'auto', membershipId: usable[0]!.membershipId, options };
  if (usable.length === 0) return { kind: 'none', options };
  return { kind: 'choose', options };
}
