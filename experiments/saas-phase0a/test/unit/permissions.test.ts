import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, type MembershipGrant } from '../../src/authz/permissions.ts';

const R1 = 'r1';
const R2 = 'r2';
const admin: MembershipGrant = { role: 'admin', scope: 'company', routeIds: [] };
const cobradorR1: MembershipGrant = { role: 'cobrador', scope: 'routes', routeIds: [R1] };
const supervisor: MembershipGrant = { role: 'supervisor', scope: 'company', routeIds: [] };

test('ID-003 [unit] cada membresía tiene sus propios permisos', () => {
  assert.equal(can(admin, 'ledger.deposit', { routeId: null }), true);
  assert.equal(can(cobradorR1, 'ledger.withdraw', { routeId: R1 }), true);
  assert.equal(can(cobradorR1, 'ledger.withdraw', { routeId: R2 }), false, 'fuera de alcance');
  assert.equal(can(cobradorR1, 'account.read', { routeId: null }), false, 'caja de empresa fuera de alcance de rutas');
  assert.equal(can(supervisor, 'account.read', { routeId: R2 }), true);
  assert.equal(can(supervisor, 'ledger.withdraw', { routeId: R2 }), false);
});

test('ID-006 [unit] sin herencia ni acumulación: la API evalúa UNA membresía', () => {
  // La misma persona tiene admin y cobrador. Operando como cobrador NO obtiene nada de admin.
  assert.equal(can(cobradorR1, 'ledger.deposit', { routeId: R1 }), false);
  // `can` acepta una sola membresía: no existe una firma que reciba varias y las una.
  assert.equal(can.length, 3);
  // Un rol desconocido inyectado no concede nada (y lanza, no se degrada a permitido).
  assert.throws(() => can({ role: 'owner' as never, scope: 'company', routeIds: [] }, 'ledger.deposit'));
});
