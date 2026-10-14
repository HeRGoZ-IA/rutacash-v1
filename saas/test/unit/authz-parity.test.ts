// La autorización del servidor ES la de CLEAN: el puente (`cleanRules.ts`) construye
// el `User` desde una membresía sin perder nada que `can()` consulte. Se compara,
// para los 6 roles × todas las capacidades × (sin ruta, ruta autorizada, ruta ajena,
// otra empresa), la decisión del servidor con `can()` sobre un `User` completo de CLEAN.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ROLE_CAPABILITIES, can, type Capability } from '@/lib/permissions';
import type { User } from '@/models/types';
import { USER_ROLES, allowed, capabilitiesOf, type MembershipFacts } from '../../src/authz/cleanRules.ts';

const ALL_CAPS = [...new Set(Object.values(ROLE_CAPABILITIES).flat())].sort() as Capability[];

describe('paridad de autorización servidor ↔ CLEAN', () => {
  test('AUTHZ-001 · misma decisión para 6 roles × todas las capacidades × 4 contextos', () => {
    let checked = 0;
    for (const role of USER_ROLES) {
      const facts: MembershipFacts = { membershipId: `m-${role}`, companyId: 'empresa-a', role, status: 'activo', displayName: role, routeIds: ['r1'] };
      const full: User = {
        id: facts.membershipId, tenantId: 'empresa-a', rol: role, status: 'activo', nombre: role, email: `${role}@example.test`,
        password: 'irrelevante-para-autorizar', authorizedRouteIds: ['r1'], grantedCapabilities: ['user.viewAll'], revokedCapabilities: ['route.viewAssigned'],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      };
      for (const cap of ALL_CAPS) {
        for (const ctx of [{}, { routeId: 'r1' }, { routeId: 'r9' }]) {
          assert.equal(allowed(facts, cap, ctx), can(full, cap, { ...ctx, tenantId: 'empresa-a' }), `${role} ${cap} ${JSON.stringify(ctx)}`);
          checked++;
        }
        assert.equal(can(full, cap, { tenantId: 'empresa-b' }), false, 'nunca otra empresa');
      }
    }
    assert.ok(checked > 500);
  });

  test('AUTHZ-002 · una membresía inactiva no puede nada; las capacidades expuestas son las del rol', () => {
    for (const role of USER_ROLES) {
      const facts: MembershipFacts = { membershipId: 'x', companyId: 'a', role, status: 'inactivo', displayName: 'x', routeIds: ['r1'] };
      for (const cap of ALL_CAPS) assert.equal(allowed(facts, cap), false);
      assert.deepEqual(new Set(capabilitiesOf(role)), new Set(ROLE_CAPABILITIES[role].filter((c) => can(
        { id: 'x', tenantId: 'a', rol: role, status: 'activo', authorizedRouteIds: [] } as unknown as User, c))));
    }
  });
});
