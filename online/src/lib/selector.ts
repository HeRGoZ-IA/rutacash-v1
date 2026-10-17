// Opciones del selector con las reglas aprobadas (saas/src/client/contextSelector.ts):
// solo membresías activas; empresa suspendida visible con aviso y no elegible.

import { selectorOptions, type SelectableMembership } from '../../../saas/src/client/contextSelector.ts';

export interface ChoiceOption {
  membershipId: string;
  companyName: string;
  role: string;
  countryCode: string;
  isDemo: boolean;
  selectable: boolean;
  notice: string | null;
}

export function decideContextOptions(list: (SelectableMembership & { company: { isDemo?: boolean } })[]): ChoiceOption[] {
  const byId = new Map(list.map((m) => [m.membershipId, m]));
  return selectorOptions(list).map((o) => {
    const m = byId.get(o.membershipId)!;
    return { membershipId: o.membershipId, companyName: m.company.name, role: m.role, countryCode: m.company.countryCode,
      isDemo: m.company.isDemo === true, selectable: o.selectable, notice: o.notice };
  });
}
