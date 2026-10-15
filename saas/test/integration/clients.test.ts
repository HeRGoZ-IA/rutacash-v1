// FASE 2 · catálogo de clientes y DS-10 (documento único por empresa, tipo y número
// normalizado), de extremo a extremo y en la propia base.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf, routeId, uid } from '../../db/seeds/synthetic.ts';
import { asApi, count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, parallel, type Caller } from '../helpers/phase2.ts';

const base = (routeIdValue: string, documentType: string, document: string, name = 'Cliente') => ({
  routeId: routeIdValue, name, documentType, document, phonePrimary: '+55 11 9999-0000', addressPrimary: 'Rua 1', addressSecondary: 'Loja 2',
});

describe('Fase 2 · clientes y DS-10', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  let bruno: Caller, ana: Caller, anaCob: Caller, fabio: Caller, gabi: Caller, carla: Caller, anaSup: Caller;
  const r1 = routeId('c1', 1);
  before(async () => {
    db = await createTestDb('clients', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, createMemoryProvider());
    bruno = caller(api, issuer, 'bruno', M.brunoSa);
    ana = caller(api, issuer, 'ana', M.anaAdmin);
    anaCob = caller(api, issuer, 'ana', M.anaCob);
    fabio = caller(api, issuer, 'fabio', M.fabioSocio);
    gabi = caller(api, issuer, 'gabi', M.gabiSec);
    carla = caller(api, issuer, 'carla', M.carlaSa);
    anaSup = caller(api, issuer, 'ana', M.anaSup);
  });
  after(async () => { await api.close(); await db.close(); });

  test('CLI-001 · alta: roles con client.create en rutas autorizadas; el resto no', async () => {
    assert.equal((await bruno('POST', '/v1/clients', base(r1, 'CPF', '529.982.247-25'))).status, 201);
    assert.equal((await ana('POST', '/v1/clients', base(r1, 'CPF', '168.995.350-09'))).status, 201);
    const cob = await anaCob('POST', '/v1/clients', base(r1, 'CPF', '390.533.447-05'));
    assert.equal(cob.status, 201, JSON.stringify(cob.body));
    assert.equal((await anaSup('POST', '/v1/clients', base(routeId('c2', 1), 'CC', '1020304050'))).status, 201, 'Supervisor en Colombia');
    assert.equal((await anaCob('POST', '/v1/clients', base(routeId('c1', 2), 'CPF', '111.111.111-11'))).status, 403, 'ruta no autorizada');
    for (const who of [fabio, gabi]) assert.equal((await who('POST', '/v1/clients', base(r1, 'CPF', '222.222.222-22'))).status, 403);
    const missing = await bruno('POST', '/v1/clients', { ...base(r1, 'CPF', '333.333.333-33'), addressSecondary: '' });
    assert.equal(missing.status, 400, 'dirección de cobro/negocio obligatoria (CLEAN)');
    const audit = await db.admin.query(`select route_id, actor_role, txid is not null t from adex.audit_log where action = 'CREATE_CLIENT' and entity_id = $1`, [cob.body['id']]);
    assert.deepEqual(audit.rows, [{ route_id: r1, actor_role: 'cobrador', t: true }]);
  });

  test('DS10-001 · mismo tipo y número en la misma empresa → el segundo se rechaza, sin importar el formato', async () => {
    const first = await bruno('POST', '/v1/clients', base(r1, 'CPF', '714.602.380-01', 'Original'));
    assert.equal(first.status, 201);
    assert.equal(first.body['document'], '714.602.380-01', 'el documento original se conserva tal cual');
    assert.equal(first.body['documentNormalized'], '71460238001');
    for (const variant of ['71460238001', ' 714 602 380 01 ', '714-602-380/01']) {
      const dup = await ana('POST', '/v1/clients', base(r1, 'CPF', variant, 'Duplicado'));
      assert.equal(dup.body['error'], 'DOCUMENT_DUPLICATE', variant);
    }
    assert.equal(await count(db.admin, `select 1 from adex.clients where company_id = $1 and document_normalized = '71460238001'`, [companyId('c1')]), 1);
  });

  test('DS10-002 · el mismo documento en empresas distintas está permitido (cada empresa registra a la persona)', async () => {
    assert.equal((await bruno('POST', '/v1/clients', base(r1, 'PAS', 'ab-123456'))).status, 201);
    const c2 = await carla('POST', '/v1/clients', base(routeId('c2', 1), 'PAS', 'AB123456'));
    assert.equal(c2.status, 201, JSON.stringify(c2.body));
    assert.equal(c2.body['documentNormalized'], 'AB123456');
    assert.equal(await count(db.admin, `select 1 from adex.clients where document_type = 'PAS' and document_normalized = 'AB123456'`), 2);
  });

  test('DS10-003 · alta concurrente del mismo documento: solo UNA operación lo crea', async () => {
    const variants = ['987.654.321-00', '98765432100', '987 654 321 00', '987-654-321-00'];
    const results = await parallel(12, (i) => (i % 2 ? bruno : ana)('POST', '/v1/clients', base(r1, 'CPF', variants[i % variants.length]!, `Carrera ${i}`)));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, ...Array(11).fill(409)]);
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.body['error'] === 'DOCUMENT_DUPLICATE'));
    assert.equal(await count(db.admin, `select 1 from adex.clients where document_normalized = '98765432100'`), 1);
  });

  test('DS10-004 · otro tipo de documento con el mismo número: es otra identificación (clave = empresa + tipo + número)', async () => {
    assert.equal((await bruno('POST', '/v1/clients', base(r1, 'CPF', '12345678909'))).status, 201);
    const rg = await bruno('POST', '/v1/clients', base(r1, 'RG', '12345678909'));
    assert.equal(rg.status, 201, JSON.stringify(rg.body));
    assert.equal((await bruno('POST', '/v1/clients', base(r1, 'RG', '12.345.678-909'))).body['error'], 'DOCUMENT_DUPLICATE');
  });

  test('DS10-005 · una actualización que produciría un duplicado se rechaza, también en paralelo', async () => {
    const a = (await bruno('POST', '/v1/clients', base(r1, 'CPF', '100.000.000-01', 'A'))).body;
    const b = (await bruno('POST', '/v1/clients', base(r1, 'CPF', '100.000.000-02', 'B'))).body;
    const dup = await bruno('PATCH', `/v1/clients/${b['id']}`, { documentType: 'CPF', document: '10000000001' });
    assert.equal(dup.body['error'], 'DOCUMENT_DUPLICATE');
    assert.equal((await db.admin.query('select document from adex.clients where id = $1', [b['id']])).rows[0].document, '100.000.000-02');
    const race = await Promise.all([a, b].map((x) => bruno('PATCH', `/v1/clients/${x['id']}`, { documentType: 'CPF', document: '100.000.000-99' })));
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await count(db.admin, `select 1 from adex.clients where document_normalized = '10000000099'`), 1);
  });

  test('DS10-006 · tipo del país de la empresa, formato del tipo y longitud; nada se «arregla» ni se inventa', async () => {
    assert.equal((await bruno('POST', '/v1/clients', base(r1, 'CC', '1020304050'))).body['error'], 'INVALID_DOCUMENT_TYPE', 'CC no es de Brasil');
    assert.equal((await bruno('POST', '/v1/clients', base(r1, 'CPF', '123.456.789-0A'))).body['error'], 'INVALID_DOCUMENT', 'letras en un tipo numérico');
    assert.equal((await bruno('POST', '/v1/clients', base(r1, 'CPF', '1234567890'))).body['error'], 'INVALID_DOCUMENT', 'CPF de 10 dígitos');
    assert.equal((await bruno('POST', '/v1/clients', base(r1, 'CNPJ', '11.222.333/0001-81'))).status, 201);
    const noType = await bruno('POST', '/v1/clients', { ...base(r1, 'CPF', '555.555.555-55'), documentType: undefined });
    assert.equal(noType.status, 400, 'sin tipo no hay alta');
    const types = (await anaCob('GET', '/v1/document-types')).body['documentTypes'] as { code: string }[];
    assert.deepEqual(types.map((t) => t.code), ['CNPJ', 'CPF', 'PAS', 'RG', 'RNM']);
    assert.deepEqual(((await carla('GET', '/v1/document-types')).body['documentTypes'] as { code: string }[]).map((t) => t.code), ['CC', 'CE', 'NIT', 'PAS', 'PPT']);
  });

  test('DS10-007 · clientes importados sin tipo: se conservan; cambiar su documento exige tipo; no se fusionan duplicados históricos', async () => {
    const legacy = uid('c1:client:1');
    const row = (await db.admin.query('select document, document_type, document_normalized from adex.clients where id = $1', [legacy])).rows[0];
    assert.deepEqual(row, { document: 'c1-DOC-1', document_type: null, document_normalized: 'c1doc1' }, 'regla normalizeDoc de CLEAN');
    assert.equal((await bruno('PATCH', `/v1/clients/${legacy}`, { notes: 'Editado' })).status, 200, 'editar otros datos no exige tipo');
    assert.equal((await bruno('PATCH', `/v1/clients/${legacy}`, { document: '000.000.001-91' })).status, 400, 'cambiar el documento exige tipo');
    // Importación (administrador): dos clientes históricos con el mismo documento.
    // Sin marcar, PostgreSQL lo impide; marcado como duplicado histórico, se conserva sin fusionar.
    const ins = (id: string, flag: boolean) => db.admin.query(
      `insert into adex.clients (id, company_id, route_id, name, document, phone_primary, address_primary, status, created_at, updated_at, document_legacy_duplicate)
       values ($1, $2, $3, 'Histórico', 'c1-doc-1', '1', 'a', 'activo', now(), now(), $4)`, [id, companyId('c1'), r1, flag]);
    await assert.rejects(ins('legacy-dup-a', false), { code: '23505' });
    await ins('legacy-dup-b', true);
    assert.equal(await count(db.admin, `select 1 from adex.clients where document_normalized = 'c1doc1'`), 2);
    // La API no puede marcar duplicados ni dar de alta sin tipo (segunda barrera).
    await asApi(db.api, { identityId: identityOf('bruno'), membershipId: M.brunoSa, companyId: companyId('c1') }, async (q) => {
      for (const sql of [
        `insert into adex.clients (id, company_id, route_id, name, document, phone_primary, address_primary, status, created_at, updated_at)
         values ('api-x', '${companyId('c1')}', '${r1}', 'x', '999', '1', 'a', 'activo', now(), now())`,
        `update adex.clients set document_legacy_duplicate = true where id = '${legacy}'`,
      ]) {
        await q.query('savepoint s');
        await assert.rejects(q.query(sql), (e: { code?: string }) => e.code === '42501' || e.code === 'AX201', sql);
        await q.query('rollback to savepoint s');
      }
    });
  });

  test('CLI-010 · Secretario: edición limitada a datos operativos (API y disparador)', async () => {
    const id = uid('c1:client:2');
    const ok = await gabi('PATCH', `/v1/clients/${id}`, { name: 'Nombre Corregido', phonePrimary: '+55 0' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    for (const body of [{ documentType: 'CPF', document: '529.982.247-25' }, { routeId: routeId('c1', 2) }, { documentPhotoUrl: 'https://x/y.png' }]) {
      assert.equal((await gabi('PATCH', `/v1/clients/${id}`, body)).status, 403, JSON.stringify(body));
    }
    assert.equal((await gabi('POST', `/v1/clients/${id}/status`, { status: 'inactivo' })).status, 403);
    await asApi(db.api, { identityId: identityOf('gabi'), membershipId: M.gabiSec, companyId: companyId('c1') }, async (q) => {
      await assert.rejects(q.query(`update adex.clients set status = 'inactivo' where id = $1`, [id]), { code: '42501' });
    });
    const a = await db.admin.query(`select description, actor_role from adex.audit_log where action = 'UPDATE_CLIENT' and entity_id = $1`, [id]);
    assert.deepEqual(a.rows.map((r) => r.actor_role), ['secretario']);
  });

  test('CLI-011 · estado: activo ↔ inactivo con client.deactivate; moroso/perdido son derivados', async () => {
    const id = uid('c1:client:1');
    assert.equal((await anaCob('POST', `/v1/clients/${id}/status`, { status: 'inactivo' })).status, 403);
    assert.equal((await ana('POST', `/v1/clients/${id}/status`, { status: 'inactivo' })).body['status'], 'inactivo');
    assert.equal((await ana('POST', `/v1/clients/${id}/status`, { status: 'activo' })).body['status'], 'activo');
    assert.equal((await ana('POST', `/v1/clients/${id}/status`, { status: 'moroso' })).status, 400);
    await db.admin.query(`update adex.clients set status = 'moroso' where id = $1`, [id]);
    assert.equal((await ana('POST', `/v1/clients/${id}/status`, { status: 'activo' })).body['error'], 'STATUS_IS_DERIVED');
  });

  test('CLI-012 · rutas que no admiten operaciones nuevas: ni altas ni traslados', async () => {
    assert.equal((await bruno('POST', '/v1/clients', base(routeId('c1', 3), 'CPF', '444.444.444-44'))).body['error'], 'ROUTE_NOT_OPERATIONAL', 'ruta inactiva');
    assert.equal((await bruno('POST', '/v1/clients', base(routeId('c1', 2), 'CPF', '444.444.444-45'))).body['error'], 'ROUTE_NOT_OPERATIONAL', 'Oficina inactiva');
    const moved = await bruno('PATCH', `/v1/clients/${uid('c1:client:2')}`, { routeId: routeId('c1', 3) });
    assert.equal(moved.body['error'], 'ROUTE_NOT_OPERATIONAL');
    assert.equal((await anaCob('PATCH', `/v1/clients/${uid('c1:client:2')}`, { routeId: routeId('c1', 2) })).status, 403);
    // También en la base: un traslado directo a una ruta inactiva falla (disparador).
    await assert.rejects(db.admin.query(`update adex.clients set route_id = $1 where id = $2`, [routeId('c1', 3), uid('c1:client:2')]), { code: 'AX301' });
  });

  test('CLI-020 · aislamiento y alcance: otra empresa y otras rutas son inexistentes', async () => {
    const c1Client = uid('c1:client:1');
    assert.equal((await carla('GET', `/v1/clients/${c1Client}`)).status, 404);
    assert.equal((await carla('PATCH', `/v1/clients/${c1Client}`, { name: 'Robado' })).status, 404);
    assert.equal((await carla('POST', `/v1/clients/${c1Client}/delete`, {})).status, 404);
    assert.equal((await carla('POST', '/v1/clients', base(r1, 'CC', '1020304051'))).status, 404, 'ruta de otra empresa = inexistente');
    const mine = (await anaCob('GET', '/v1/clients')).body['clients'] as { routeId: string }[];
    assert.ok(mine.length > 0 && mine.every((c) => c.routeId === r1));
    assert.equal((await anaCob('GET', `/v1/clients/${uid('c1:client:3')}`)).status, 404, 'cliente de r2: fuera del alcance de la cobradora');
    assert.equal((await anaCob('GET', `/v1/clients?routeId=${routeId('c1', 2)}`)).status, 403);
  });

  test('CLI-099 · sin errores inesperados en el servidor', () => {
    assert.deepEqual(api.errors, []);
  });
});
