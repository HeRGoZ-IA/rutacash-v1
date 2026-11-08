// 0049 · Estado del cliente automático (propietario y su socio, 2026-11-07), contra PostgreSQL real y la API (datos sintéticos).
//   · «activo» = tiene un crédito activo (venta activa o solicitud aprobada sin entregar); si no, «inactivo».
//   · Cambia solo; nadie lo fija a mano; «inactivo» no impide darle crédito.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, routeId } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { money, newPerson, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('0049 · estado del cliente según sus créditos', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  let bruno: Caller, ana: Caller, $bruno: Money, $ana: Money;
  let carlos: Person;
  let today = '';
  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const newClient = async () => {
    const r = await ana('POST', '/v1/clients', { routeId: r1, name: `Cliente ${randomUUID().slice(0, 6)}`, documentType: 'CPF', document: cpf(),
      phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body as Body;
  };
  const saleBody = (clientId: string, amountMinor = 50_000): Body => ({ routeId: r1, clientId, amountMinor, interestRate: 20, installmentsCount: 12,
    frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
  const status = async (id: string) => (await db.admin.query<{ s: string }>('select status s from adex.clients where id = $1', [id])).rows[0]!.s;
  const apiStatus = async (id: string) => (await ana('GET', `/v1/clients/${id}`)).body['status'];
  const direct = async (clientId: string, amountMinor = 50_000) => {
    const r = await $ana('/v1/credits/direct', saleBody(clientId, amountMinor));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const credit = r.body['credit'] as Body;
    return { id: credit['id'] as string, total: Number(credit['totalValueMinor']) };
  };
  const payOff = async (sale: { id: string; total: number }) => {
    const r = await carlos.money('/v1/collections', { saleId: sale.id, amountMinor: sale.total });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  };

  before(async () => {
    db = await createTestDb('client_status', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    carlos = await newPerson(api, issuer, provider.ids, bruno, { email: 'carlos-cs@example.test', role: 'cobrador', displayName: 'Carlos', routeIds: [r1] });
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 3_000_000, reason: 'Bolsa de Ana' }],
    ] as const) {
      const r = await $bruno(path, body);
      assert.equal(r.status, 201, `${path}: ${JSON.stringify(r.body)}`);
    }
  });
  after(async () => { await api?.close(); await db?.close(); });

  test('CS-001 · todos los clientes de la base llevan el estado de sus créditos (recalculo de 0049 y semilla)', async () => {
    const wrong = await db.admin.query(`select id, status from adex.clients where status is distinct from adex.client_derived_status(company_id, id)`);
    assert.deepEqual(wrong.rows, []);
    const n = await db.admin.query<{ s: string; n: string }>(`select status s, count(*) n from adex.clients group by 1 order by 1`);
    assert.ok(n.rows.every((x) => x.s === 'activo' || x.s === 'inactivo'), JSON.stringify(n.rows));
  });

  test('CS-002 · cliente nuevo inactivo; venta directa → activo; termina de pagar → inactivo; renueva → activo', async () => {
    const c = await newClient();
    assert.equal(c['status'], 'inactivo', 'la API devuelve el estado real');
    assert.equal(await status(c['id'] as string), 'inactivo');
    const s1 = await direct(c['id'] as string);
    assert.equal(await apiStatus(c['id'] as string), 'activo', 'inactivo no impide el crédito y pasa a activo');
    const s2 = await direct(c['id'] as string, 20_000);
    await payOff(s1);
    assert.equal(await status(c['id'] as string), 'activo', 'le queda otro crédito activo');
    await payOff(s2);
    assert.equal(await status(c['id'] as string), 'inactivo', 'sin créditos activos');
    await direct(c['id'] as string);
    assert.equal(await status(c['id'] as string), 'activo', 'renueva');
  });

  test('CS-003 · solicitudes: pendiente no cuenta; aprobada sí; cancelada o rechazada vuelve a inactivo', async () => {
    const c = (await newClient())['id'] as string;
    const req = await carlos.call('POST', '/v1/credit-requests', saleBody(c));
    assert.equal(req.status, 201, JSON.stringify(req.body));
    assert.equal(await status(c), 'inactivo', 'pendiente');
    assert.equal((await ana('POST', `/v1/credit-requests/${req.body['id']}/approve`, {})).status, 200);
    assert.equal(await status(c), 'activo', 'aprobada sin entregar');
    const cancel = await ana('POST', `/v1/credit-requests/${req.body['id']}/cancel`, { reason: 'El cliente ya no quiere el crédito' });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    assert.equal(await status(c), 'inactivo', 'cancelada');
    const req2 = await carlos.call('POST', '/v1/credit-requests', saleBody(c));
    assert.equal(req2.status, 201, JSON.stringify(req2.body));
    assert.equal((await ana('POST', `/v1/credit-requests/${req2.body['id']}/reject`, { reason: 'No cumple las condiciones' })).status, 200);
    assert.equal(await status(c), 'inactivo', 'rechazada');
  });

  test('CS-004 · nadie lo fija a mano: la API responde STATUS_IS_DERIVED y PostgreSQL lo recalcula', async () => {
    const c = (await newClient())['id'] as string;
    const r = await ana('POST', `/v1/clients/${c}/status`, { status: 'activo' });
    assert.deepEqual([r.status, r.body['error']], [409, 'STATUS_IS_DERIVED']);
    await db.admin.query(`update adex.clients set status = 'activo' where id = $1`, [c]);
    assert.equal(await status(c), 'inactivo', 'ni el administrador de la base lo cambia');
    const edit = await ana('PATCH', `/v1/clients/${c}`, { notes: 'Editado' });
    assert.equal(edit.status, 200);
    assert.equal(edit.body['status'], 'inactivo');
    const audit = await db.admin.query(`select count(*)::int n from adex.audit_log where entity_id = $1 and action = 'BLOCK_CLIENT'`, [c]);
    assert.equal(audit.rows[0].n, 0);
  });
});
