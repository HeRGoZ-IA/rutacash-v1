// PUERTA DE LA FASE 2 (plan §2): «`permissions` en verde contra el servidor».
//
// La suite `permissions` de CLEAN (559 casos) prueba la matriz pura de `can()`. Aquí
// se comprueba que el SERVIDOR la aplica de verdad: para cada comando de estructura y
// catálogo, cada uno de los 6 roles y una ruta dentro y otra fuera de su alcance, la
// respuesta HTTP real (con RLS como segunda barrera) coincide con la decisión de
// `can()` de src/lib/permissions.ts, importada tal cual. Un comando que se olvide la
// capacidad, use la equivocada o pierda el contexto de ruta rompe esta prueba.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { can, type Capability } from '@/lib/permissions';
import type { User, UserRole } from '@/models/types';
import { companyId, routeId, uid, type Person } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';

interface Actor { person: Person; membership: string; company: 'c1' | 'c2'; role: UserRole }
const ACTORS: Actor[] = [
  { person: 'bruno', membership: M.brunoSa, company: 'c1', role: 'superadmin' },
  { person: 'ana', membership: M.anaAdmin, company: 'c1', role: 'admin' },
  { person: 'fabio', membership: M.fabioSocio, company: 'c1', role: 'socio' },
  { person: 'ana', membership: M.anaSup, company: 'c2', role: 'supervisor' },
  { person: 'ana', membership: M.anaCob, company: 'c1', role: 'cobrador' },
  { person: 'gabi', membership: M.gabiSec, company: 'c1', role: 'secretario' },
];

interface Scope { route: string; client: string; office: string; category: string }
interface Command {
  name: string;
  /** Capacidades de CLEAN (cualquiera basta) y si se evalúan con la ruta. */
  caps: Capability[];
  routeScoped?: boolean;
  /** `true` si el comando no admite ruta fuera de alcance (solo se prueba dentro). */
  run: (call: Caller, s: Scope, i: number) => Promise<{ status: number }>;
  /** Estados que cuentan como «autorizado» además de 2xx (p. ej. validación posterior). */
  allowedAlso?: number[];
}

const COMMANDS: Command[] = [
  { name: 'GET /v1/company', caps: ['settings.access'], run: (c) => c('GET', '/v1/company') },
  { name: 'PATCH /v1/company', caps: ['settings.access'], run: (c, _s, i) => c('PATCH', '/v1/company', { city: `Ciudad ${i}` }) },
  { name: 'POST /v1/offices', caps: ['office.create'], run: (c, _s, i) => c('POST', '/v1/offices', { name: `Matriz ${i}` }) },
  { name: 'PATCH /v1/offices/:id', caps: ['office.edit'], run: (c, s, i) => c('PATCH', `/v1/offices/${s.office}`, { code: `MX-${i}` }) },
  { name: 'POST /v1/offices/:id/status', caps: ['office.changeStatus'], run: (c, s) => c('POST', `/v1/offices/${s.office}/status`, { status: 'activa' }) },
  { name: 'POST /v1/routes', caps: ['route.create'], run: (c, _s, i) => c('POST', '/v1/routes', { name: `Matriz ${i}`, interestRate: 20, freeRate: false, maxLoanMinor: 1000 }) },
  { name: 'GET /v1/routes/:id', caps: ['route.viewAssigned', 'route.viewAll'], routeScoped: true, run: (c, s) => c('GET', `/v1/routes/${s.route}`) },
  { name: 'PATCH /v1/routes/:id', caps: ['route.edit'], routeScoped: true, run: (c, s, i) => c('PATCH', `/v1/routes/${s.route}`, { city: `Matriz ${i}` }) },
  { name: 'POST /v1/routes/:id/status', caps: ['route.block'], routeScoped: true, run: (c, s) => c('POST', `/v1/routes/${s.route}/status`, { status: 'activa' }) },
  { name: 'PUT /v1/routes/:id/capital-controller', caps: ['capital.assignController'], routeScoped: true, allowedAlso: [409],
    run: (c, s) => c('PUT', `/v1/routes/${s.route}/capital-controller`, { membershipId: M.gabiSec, reason: 'Matriz de permisos' }) },
  { name: 'GET /v1/members', caps: ['user.viewAll'], run: (c) => c('GET', '/v1/members') },
  { name: 'POST /v1/expense-categories', caps: ['settings.access'], run: (c, _s, i) => c('POST', '/v1/expense-categories', { name: `Matriz ${i}` }) },
  { name: 'PATCH /v1/expense-categories/:id', caps: ['settings.access'], run: (c, s, i) => c('PATCH', `/v1/expense-categories/${s.category}`, { icon: `i${i}` }) },
  { name: 'GET /v1/clients', caps: ['client.view'], run: (c) => c('GET', '/v1/clients') },
  { name: 'GET /v1/clients/:id', caps: ['client.view'], routeScoped: true, run: (c, s) => c('GET', `/v1/clients/${s.client}`) },
  { name: 'POST /v1/clients', caps: ['client.create'], routeScoped: true,
    run: (c, s, i) => c('POST', '/v1/clients', { routeId: s.route, name: `Matriz ${i}`, documentType: 'PAS', document: `MX${String(i).padStart(6, '0')}`,
      phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b' }) },
  { name: 'PATCH /v1/clients/:id', caps: ['client.edit', 'client.editLimited'], routeScoped: true, run: (c, s, i) => c('PATCH', `/v1/clients/${s.client}`, { notes: `Matriz ${i}` }) },
  { name: 'POST /v1/clients/:id/status', caps: ['client.deactivate'], routeScoped: true, run: (c, s) => c('POST', `/v1/clients/${s.client}/status`, { status: 'activo' }) },
];

describe('Fase 2 · puerta `permissions`: la matriz de CLEAN aplicada por el servidor', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const scopes: Record<'c1' | 'c2', { inside: Scope; outside: Scope }> = {} as never;
  before(async () => {
    db = await createTestDb('authzmatrix', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, createMemoryProvider());
    // Datos de cada empresa: ruta y cliente DENTRO del alcance de todos sus roles (r1)
    // y FUERA del alcance de los roles limitados (r3, sin nadie asignado). r3 está
    // inactiva: se reactiva para que la operación nueva no la bloquee por estado.
    await db.admin.query(`update adex.routes set status = 'activa' where id = any($1)`, [[routeId('c1', 3), routeId('c2', 3)]]);
    for (const c of ['c1', 'c2'] as const) {
      const outsideClient = `matrix-out-${c}`;
      await db.admin.query(
        `insert into adex.clients (id, company_id, route_id, name, document, document_type, phone_primary, address_primary, status, created_at, updated_at)
         values ($1, $2, $3, 'Fuera', $4, 'PAS', '1', 'a', 'activo', now(), now())`, [outsideClient, companyId(c), routeId(c, 3), `OUT${c.toUpperCase()}001`]);
      const shared = { office: uid(`${c}:office:1`), category: uid(`${c}:cat:fuel`) };
      scopes[c] = {
        inside: { route: routeId(c, 1), client: uid(`${c}:client:1`), ...shared },
        outside: { route: routeId(c, 3), client: outsideClient, ...shared },
      };
    }
  });
  after(async () => { await api.close(); await db.close(); });

  let n = 0;
  const tally = { allowed: 0, denied: 0, deniedOutOfScope: 0 };
  for (const cmd of COMMANDS) {
    test(`AUTHZ-P2 · ${cmd.name}`, async () => {
      for (const a of ACTORS) {
        const facts = (await db.admin.query<{ route_id: string }>('select route_id from adex.membership_routes where membership_id = $1', [a.membership])).rows.map((r) => r.route_id);
        const user = { id: a.membership, tenantId: companyId(a.company), rol: a.role, status: 'activo', nombre: a.role, authorizedRouteIds: facts,
          createdAt: '', updatedAt: '' } as Partial<User> as User;
        const call = caller(api, issuer, a.person, a.membership);
        for (const where of (cmd.routeScoped ? ['inside', 'outside'] : ['inside']) as ('inside' | 'outside')[]) {
          const scope = scopes[a.company][where];
          const expected = cmd.caps.some((cap) => can(user, cap, { tenantId: companyId(a.company), ...(cmd.routeScoped ? { routeId: scope.route } : {}) }));
          const r = await cmd.run(call, scope, n++);
          const authorized = (r.status >= 200 && r.status < 300) || (cmd.allowedAlso ?? []).includes(r.status);
          const label = `${cmd.name} · ${a.role} · ruta ${where}: can()=${expected}, HTTP ${r.status} ${JSON.stringify((r as { body?: unknown }).body ?? '')}`;
          if (expected) tally.allowed++; else { tally.denied++; if (where === 'outside') tally.deniedOutOfScope++; }
          if (expected) assert.ok(authorized, label);
          else assert.ok(r.status === 403 || r.status === 404, label);
        }
      }
    });
  }

  test('AUTHZ-P2 · cobertura: los 6 roles y cada capacidad de estructura y catálogo usada por la API', () => {
    assert.deepEqual([...new Set(ACTORS.map((a) => a.role))].sort(), ['admin', 'cobrador', 'secretario', 'socio', 'superadmin', 'supervisor']);
    const caps = new Set(COMMANDS.flatMap((c) => c.caps));
    for (const cap of ['settings.access', 'office.create', 'office.edit', 'office.changeStatus', 'route.create', 'route.edit', 'route.block',
      'capital.assignController', 'user.viewAll', 'client.view', 'client.create', 'client.edit', 'client.editLimited', 'client.deactivate'] as Capability[]) {
      assert.ok(caps.has(cap), cap);
    }
  });

  test('AUTHZ-P2 · la matriz ejerce ambos lados: permitidos, denegados por rol y denegados por ruta', () => {
    assert.ok(tally.allowed >= 40, JSON.stringify(tally));
    assert.ok(tally.denied >= 60, JSON.stringify(tally));
    assert.ok(tally.deniedOutOfScope >= 15, JSON.stringify(tally));
    console.log(`# matriz Fase 2: ${tally.allowed + tally.denied} decisiones (${tally.allowed} permitidas, ${tally.denied} denegadas, ${tally.deniedOutOfScope} por ruta)`);
  });

  test('AUTHZ-P2 · sin errores inesperados en el servidor', () => {
    assert.deepEqual(api.errors, []);
  });
});
