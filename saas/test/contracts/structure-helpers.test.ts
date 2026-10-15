// FASE 2 · 0008: las funciones auxiliares SECURITY DEFINER de estructura y catálogo
// no revelan nada de otra empresa a la API (`adex_api`) sin contexto válido o con una
// empresa distinta de la del contexto. El administrador (importación) no cambia, y la
// comprobación del responsable al COMMIT no depende del alcance.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf, membershipId, routeId, uid } from '../../db/seeds/synthetic.ts';
import { asApi, createTestDb, type TestDb } from '../helpers/db.ts';

describe('Fase 2 · funciones auxiliares atadas al contexto (0008)', () => {
  let db: TestDb;
  const c1 = companyId('c1');
  const bruno = { identityId: identityOf('bruno'), membershipId: membershipId('c1', 'bruno-sa'), companyId: c1 };
  const carla = { identityId: identityOf('carla'), membershipId: membershipId('c2', 'carla-sa'), companyId: companyId('c2') };
  before(async () => { db = await createTestDb('helpers', { seed: true }); });
  after(async () => { await db.close(); });

  const probe = `select adex.route_operational($1, $2) op, adex.membership_active_role($1, $3) role,
                        adex.company_country($1) country, adex.route_controller_valid($1, $2) ctl`;
  const args = [c1, routeId('c1', 1), membershipId('c1', 'ana-admin')];

  test('HLP-001 · con el contexto de SU empresa, la API obtiene los valores reales', async () => {
    const r = await asApi(db.api, bruno, (q) => q.query(probe, args));
    assert.deepEqual(r.rows[0], { op: true, role: 'admin', country: 'BR', ctl: true });
    const refs = await asApi(db.api, bruno, (q) => q.query("select adex.protected_references('adex.clients'::regclass, $1, $2) r", [c1, uid('c1:client:1')]));
    assert.ok((refs.rows[0].r as string[]).includes('sales.client_id'));
  });

  test('HLP-002 · sin contexto, o con el de otra empresa, nada (ni booleanos, ni rol, ni país, ni referencias)', async () => {
    for (const ctx of [{}, carla, { ...carla, companyId: c1 }]) {
      const r = await asApi(db.api, ctx, (q) => q.query(probe, args));
      assert.deepEqual(r.rows[0], { op: false, role: null, country: null, ctl: null }, JSON.stringify(ctx));
      await asApi(db.api, ctx, async (q) => {
        await assert.rejects(q.query("select adex.protected_references('adex.clients'::regclass, $1, $2)", [c1, uid('c1:client:1')]), { code: '42501' });
      });
    }
    await asApi(db.api, bruno, async (q) => {
      await assert.rejects(q.query('select adex.route_controller_valid_internal($1, $2)', [c1, routeId('c1', 1)]), { code: '42501' }, 'la versión interna no es de la API');
    });
  });

  test('HLP-003 · el administrador del proyecto (importación) sigue viendo los valores reales', async () => {
    const r = await db.admin.query(probe, args);
    assert.deepEqual(r.rows[0], { op: true, role: 'admin', country: 'BR', ctl: true });
  });
});
