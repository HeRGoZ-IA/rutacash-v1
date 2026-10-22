// RONDA 73 · SOC-08: Consultas como tabla. `GET /v1/movements` contra PostgreSQL real y la API
// (datos 100 % sintéticos): una fila por operación lógica (la entrega a un trabajador NO aparece dos
// veces), operaciones distintas con el mismo importe y fecha NO se fusionan, eventos sin dinero
// marcados, filtros y orden en el servidor, paginación, permisos por rol y aislamiento por empresa.

import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, routeId } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { money, newPerson, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('Ronda 73 · Consultas: movimientos y eventos en tabla', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  let ana: Caller, $ana: Money, bruno: Caller, $bruno: Money, gabi: Caller, hugo: Caller;
  let w: Person;
  let today = '';
  const ids: Record<string, string> = {};

  const feed = async (who: Caller, qs = '') => {
    const r = await who('GET', `/v1/movements${qs ? `?${qs}` : ''}`);
    return r;
  };
  const rows = async (who: Caller, qs = '') => {
    const r = await feed(who, qs);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body['movements'] as Body[];
  };

  before(async () => {
    db = await createTestDb('r73movements', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    gabi = caller(api, issuer, 'gabi', M.gabiSec);
    hugo = caller(api, issuer, 'hugo', M.hugoAdmin);
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    w = await newPerson(api, issuer, provider.ids, bruno, { email: 'r73-mov-w@example.test', role: 'cobrador', displayName: 'Cobrador Mov', routeIds: [r1] });
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 10_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 8_000_000, reason: 'Bolsa de Ana' }],
    ] as const) assert.equal((await $bruno(path, body)).status, 201, path);
    // Caso reportado: R$ 59.005 y R$ 8.000 entregados al trabajador; además dos entregas IGUALES distintas.
    for (const [k, amountMinor] of [['big', 5_900_500], ['small', 800_000], ['twinA', 12_345], ['twinB', 12_345]] as const) {
      const r = await $ana('/v1/capital/deliveries', { routeId: r1, workerId: w.membershipId, amountMinor, reason: `Entrega ${k}` });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      ids[k] = (r.body['operation'] as Body)['id'] as string;
    }
    const client = (await ana('POST', '/v1/clients', { routeId: r1, name: 'Cliente Consultas', documentType: 'CPF', document: String(randomInt(10_000_000_000, 99_999_999_999)),
      phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Mercado' })).body['id'] as string;
    ids['client'] = client;
    const req = await w.call('POST', '/v1/credit-requests', { routeId: r1, clientId: client, amountMinor: 50_000, interestRate: 20, installmentsCount: 20, frequency: 'diaria', startDate: today, paymentDays: [1, 2, 3, 4, 5, 6] });
    ids['request'] = req.body['id'] as string;
    assert.equal((await gabi('POST', `/v1/credit-requests/${ids['request']}/approve`, { interestRate: 10 })).status, 200);
    const d = await w.money(`/v1/credit-requests/${ids['request']}/disburse`, {});
    assert.equal(d.status, 201, JSON.stringify(d.body));
    ids['sale'] = ((d.body['credit'] as Body)['id']) as string;
    assert.equal((await w.money('/v1/collections', { saleId: ids['sale'], amountMinor: 2_750 })).status, 201);
  });
  after(async () => { await api?.close(); await db?.close(); });

  test('R73-MOV-001 · la entrega de la bolsa al trabajador es UNA fila (sus dos patas siguen en el libro y en el detalle)', async () => {
    const all = await rows(ana, 'limit=200');
    for (const k of ['big', 'small']) {
      const mine = all.filter((m) => m['id'] === ids[k]);
      assert.equal(mine.length, 1, `${k}: una sola fila`);
      assert.deepEqual([mine[0]!['kind'], mine[0]!['money'], mine[0]!['workerId'], mine[0]!['adminId']], ['WORKER_DELIVERY', true, w.membershipId, M.anaAdmin]);
    }
    assert.equal(all.filter((m) => m['amountMinor'] === 5_900_500).length, 1, 'R$ 59.005 no aparece dos veces');
    const legs = (await db.admin.query('select count(*)::int n from adex.capital_entries where operation_id = $1', [ids['big']])).rows[0].n;
    assert.equal(legs, 2, 'el libro conserva ambas patas');
    const detail = await ana('GET', `/v1/capital/operations/${ids['big']}`);
    assert.equal((detail.body['entries'] as Body[]).length, 2, 'el detalle muestra origen y destino');
  });

  test('R73-MOV-002 · dos operaciones distintas con el mismo importe y fecha NO se fusionan', async () => {
    const twins = (await rows(ana, 'kind=WORKER_DELIVERY&limit=200')).filter((m) => m['amountMinor'] === 12_345);
    assert.deepEqual(twins.map((m) => m['id']).sort(), [ids['twinA'], ids['twinB']].sort());
  });

  test('R73-MOV-003 · eventos sin dinero (solicitud, autorización) marcados; desembolso y recaudo con su cliente', async () => {
    const all = await rows(ana, 'limit=200');
    const ev = all.filter((m) => m['reference'] === ids['request'] && !m['money']);
    assert.deepEqual(ev.map((m) => m['kind']).sort(), ['SALE_APPROVAL', 'SALE_REQUEST']);
    assert.match(String(ev.find((m) => m['kind'] === 'SALE_APPROVAL')!['concept']), /10 %/);
    const disb = all.find((m) => m['kind'] === 'LOAN_DISBURSEMENT' && m['saleId'] === ids['sale'])!;
    assert.deepEqual([disb['money'], disb['clientId'], disb['amountMinor']], [true, ids['client'], 50_000]);
    assert.ok(all.some((m) => m['kind'] === 'COLLECTION' && m['clientId'] === ids['client']));
    assert.ok((await rows(ana, 'money=no&limit=200')).every((m) => m['money'] === false));
    assert.ok((await rows(ana, 'money=yes&limit=200')).every((m) => m['money'] === true));
  });

  test('R73-MOV-004 · filtros combinados, orden y paginación en el servidor (sin solapes)', async () => {
    const byWorker = await rows(ana, `workerId=${w.membershipId}&kind=WORKER_DELIVERY&from=${today}&to=${today}&routeId=${r1}`);
    assert.equal(byWorker.length, 4);
    const big = await rows(ana, 'minAmount=1000000');
    assert.ok(big.length >= 1 && big.every((m) => Math.abs(m['amountMinor'] as number) >= 1_000_000));
    assert.deepEqual((await rows(ana, 'q=Entrega%20twin')).map((m) => m['id']).sort(), [ids['twinA'], ids['twinB']].sort());
    assert.deepEqual((await rows(ana, `clientId=${ids['client']}&money=yes`)).map((m) => m['kind']).sort(), ['COLLECTION', 'LOAN_DISBURSEMENT']);
    const desc = await rows(ana, 'sort=amount_desc&money=yes&limit=5');
    assert.ok(desc.every((m, i) => i === 0 || (desc[i - 1]!['amountMinor'] as number) >= (m['amountMinor'] as number)));
    const p1 = await feed(ana, 'limit=3');
    const p2 = await feed(ana, 'limit=3&offset=3');
    assert.equal(p1.body['hasMore'], true);
    const a = (p1.body['movements'] as Body[]).map((m) => m['id']);
    const b = (p2.body['movements'] as Body[]).map((m) => m['id']);
    assert.equal(new Set([...a, ...b]).size, 6, 'páginas sin solapes');
    assert.ok((await rows(ana, `from=2099-01-01`)).length === 0);
  });

  test('R73-MOV-005 · permisos y aislamiento: Cobrador y Secretario sin acceso; otra empresa no ve nada de c1', async () => {
    assert.equal((await feed(w.call)).status, 403, 'Cobrador');
    assert.equal((await feed(gabi)).status, 403, 'Secretaria');
    const theirs = await rows(hugo, 'limit=200');
    assert.ok(theirs.every((m) => ![ids['big'], ids['small'], ids['twinA'], ids['twinB'], `req:${ids['request']}`].includes(m['id'] as string)));
    const sa = await rows(bruno, 'limit=200');
    assert.ok(sa.some((m) => m['id'] === ids['big']), 'el SuperAdmin de c1 sí lo ve');
  });

  test('R73-MOV-006 · entradas inválidas: 400', async () => {
    for (const qs of ['from=2026-13-40', 'money=maybe', 'sort=random', 'kind=drop%20table', 'minAmount=1.5', `offset=999999`, `q=${'x'.repeat(101)}`]) {
      assert.equal((await feed(ana, qs)).status, 400, qs);
    }
  });
});
