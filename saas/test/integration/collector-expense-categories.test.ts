// 3.14 (0040) · tipos de gasto «Para Cobradores» y eliminación que conserva la historia, contra PostgreSQL
// real y la API. Decisión 2.1.15 (propietario 2026-10-27) y alcance de 2026-10-28: el Administrador organiza
// la lista (crear, editar, eliminar); eliminar un tipo con gastos no borra ni cambia esos gastos.
// Datos 100 % sintéticos.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, uid } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, startControlApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { money, newPerson, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;
type Cat = { id: string; name: string; active: boolean; forCollectors: boolean; deleted: boolean };

describe('3.14 · tipos de gasto «Para Cobradores» (0040)', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  let control: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  let r1 = '';
  let bruno: Caller, ana: Caller;
  let $bruno: Money, $ana: Money;
  let carlos: Person, dora: Person;
  let peajes = '', pasajes = '';

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const cats = async (who: Caller | Person = ana) => {
    const r = typeof who === 'function' ? await who('GET', '/v1/expense-categories') : await who.call('GET', '/v1/expense-categories');
    return r.body['categories'] as Cat[];
  };
  const own = (p: Person, categoryId: string, extra: Body = {}) =>
    p.money('/v1/expenses', { scope: 'trabajador', routeId: r1, workerId: p.membershipId, categoryId, amountMinor: 1_500, description: 'Gasto sintético', ...extra });
  const expensesOf = (categoryId: string) => count(db.admin, 'select 1 from adex.expenses where company_id = $1 and category_id = $2', [c1, categoryId]);

  before(async () => {
    db = await createTestDb('collector_categories', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    control = await startControlApi(db, issuer, provider);
    r1 = (await db.admin.query(`select id from adex.routes where company_id = $1 and name = 'Ruta 1'`, [c1])).rows[0].id;
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    carlos = await newPerson(api, issuer, provider.ids, bruno, { email: 'carlos-cat@example.test', role: 'cobrador', displayName: 'Carlos', routeIds: [r1] });
    dora = await newPerson(api, issuer, provider.ids, bruno, { email: 'dora-cat@example.test', role: 'supervisor', displayName: 'Dora', routeIds: [r1] });
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 3_000_000, reason: 'Bolsa de Ana' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
  });
  after(async () => { await api.close(); await control.close(); await db.close(); });

  test('CEC-001 · la casilla viaja en el catálogo: existentes por nombre (Combustible sí, Papelería no); empresas nuevas con Transporte, Alimentación y Combustible', async () => {
    const list = await cats(carlos);
    const by = Object.fromEntries(list.map((c) => [c.name, c]));
    assert.equal(by['Combustible']!.forCollectors, true);
    assert.equal(by['Papelería']!.forCollectors, false);
    assert.ok(list.every((c) => c.deleted === false));
    const owner = await issuer.issue('owner');
    const created = await control.call('POST', '/control/v1/companies', { token: owner, body: {
      name: 'Zeta Cobros', email: 'zeta@example.test', countryCode: 'CO', countryLabel: 'Colombia', currencyCode: 'COP',
      timezone: 'America/Bogota', billingMode: 'per_route', billingRate: 10 } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const marked = (await db.admin.query('select name from adex.expense_categories where company_id = $1 and for_collectors order by name', [created.body['companyId']])).rows.map((r) => r.name);
    assert.deepEqual(marked, ['Alimentación', 'Combustible', 'Transporte']);
    assert.equal(await count(db.admin, 'select 1 from adex.expense_categories where company_id = $1 and not for_collectors', [created.body['companyId']]), 4);
  });

  test('CEC-002 · Cobrador y Supervisor solo registran con tipos marcados; el Administrador usa todos; marcar lo habilita al momento', async () => {
    const a = await ana('POST', '/v1/expense-categories', { name: 'Peajes', forCollectors: false });
    const b = await ana('POST', '/v1/expense-categories', { name: 'Pasajes', forCollectors: true });
    assert.deepEqual([a.status, a.body['forCollectors'], b.status, b.body['forCollectors']], [201, false, 201, true]);
    peajes = a.body['id'] as string; pasajes = b.body['id'] as string;
    const no = await own(carlos, peajes);
    assert.deepEqual([no.status, no.body['error']], [403, 'CATEGORY_NOT_FOR_COLLECTORS']);
    const noSup = await own(dora, peajes);
    assert.deepEqual([noSup.status, noSup.body['error']], [403, 'CATEGORY_NOT_FOR_COLLECTORS']);
    assert.equal(await expensesOf(peajes), 0, 'nada se registró');
    assert.equal((await own(carlos, pasajes)).status, 201);
    assert.equal((await own(dora, pasajes)).status, 201);
    const adm = await $ana('/v1/expenses', { scope: 'ruta', routeId: r1, categoryId: peajes, amountMinor: 2_000, description: 'Peaje de la ruta' });
    assert.equal(adm.status, 201, JSON.stringify(adm.body));
    const mark = await ana('PATCH', `/v1/expense-categories/${peajes}`, { forCollectors: true });
    assert.equal(mark.body['forCollectors'], true);
    assert.equal((await own(carlos, peajes)).status, 201);
    assert.equal((await carlos.call('PATCH', `/v1/expense-categories/${peajes}`, { forCollectors: false })).status, 403, 'el Cobrador no cambia la lista');
    assert.equal((await ana('PATCH', `/v1/expense-categories/${peajes}`, { forCollectors: false })).body['forCollectors'], false);
    // Desmarcar no altera los gastos ya registrados.
    assert.equal(await expensesOf(peajes), 2);
  });

  test('CEC-003 · nadie registra con un tipo inactivo (tampoco el Administrador)', async () => {
    const r = await $ana('/v1/expenses', { scope: 'ruta', routeId: r1, categoryId: uid('c1:cat:office'), amountMinor: 1_000, description: 'Con tipo inactivo' });
    assert.deepEqual([r.status, r.body['error']], [400, 'CATEGORY_INACTIVE']);
  });

  test('CEC-004 · sin conexión con un tipo desmarcado después: se acepta al sincronizar y avisa al Administrador de la ruta', async () => {
    assert.equal((await ana('PATCH', `/v1/expense-categories/${pasajes}`, { forCollectors: false })).body['forCollectors'], false);
    const online = await own(carlos, pasajes);
    assert.equal(online.status, 403);
    const off = await own(carlos, pasajes, { offline: { capturedAt: hoursAgo(3) } });
    assert.equal(off.status, 201, JSON.stringify(off.body));
    const expenseId = (off.body['expense'] as Body)['id'];
    const cap = (await db.admin.query('select category_outside_list from adex.offline_captures where operation_id = $1', [off.operationId])).rows[0];
    assert.equal(cap.category_outside_list, true);
    // Una captura con un tipo marcado no avisa.
    const fine = await own(carlos, uid('c1:cat:fuel'), { offline: { capturedAt: hoursAgo(2) } });
    assert.equal(fine.status, 201);
    assert.equal((await db.admin.query('select category_outside_list from adex.offline_captures where operation_id = $1', [fine.operationId])).rows[0].category_outside_list, false);
    const inbox = await ana('GET', '/v1/notifications');
    const notices = (inbox.body['info'] as Body[]).filter((n) => n['type'] === 'offline-expense-outside-list');
    assert.equal(notices.length, 1, JSON.stringify(inbox.body['info']));
    const e = notices[0]!['expense'] as Body;
    assert.deepEqual([e['id'], e['categoryName'], e['workerName'], e['amountMinor']], [expenseId, 'Pasajes', 'Carlos', 1_500]);
    // Solo el Administrador: ni el Cobrador ni el SuperAdmin lo ven.
    for (const who of [carlos.call, bruno]) {
      const other = await who('GET', '/v1/notifications');
      assert.equal((other.body['info'] as Body[]).filter((n) => n['type'] === 'offline-expense-outside-list').length, 0);
    }
  });

  test('CEC-005 · eliminar con gastos: sale de la lista, los gastos conservan tipo y nombre, el nombre queda libre; sin gastos se borra', async () => {
    const before = await expensesOf(pasajes);
    assert.ok(before >= 3);
    const del = await ana('POST', `/v1/expense-categories/${pasajes}/delete`, {});
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.deepEqual(del.body, { deleted: pasajes, kept: true });
    assert.equal(await expensesOf(pasajes), before, 'ningún gasto desaparece ni cambia de tipo');
    const gone = (await cats()).find((c) => c.id === pasajes)!;
    assert.deepEqual([gone.name, gone.active, gone.deleted], ['Pasajes', false, true]);
    // El historial sigue mostrando el nombre (Consultas lee el tipo por su id).
    const names = (await db.admin.query(`select distinct k.name from adex.expenses e join adex.expense_categories k on k.company_id = e.company_id and k.id = e.category_id
                                          where e.company_id = $1 and e.category_id = $2`, [c1, pasajes])).rows.map((r) => r.name);
    assert.deepEqual(names, ['Pasajes']);
    assert.deepEqual([(await ana('PATCH', `/v1/expense-categories/${pasajes}`, { name: 'Otro' })).body['error']], ['CATEGORY_DELETED']);
    assert.deepEqual((await ana('POST', `/v1/expense-categories/${pasajes}/delete`, {})).body, { deleted: pasajes, kept: true }, 'repetir no falla');
    const reuse = await ana('POST', '/v1/expense-categories', { name: 'Pasajes', forCollectors: true });
    assert.equal(reuse.status, 201, 'el nombre de un tipo eliminado queda libre');
    const old = await own(carlos, pasajes);
    assert.deepEqual([old.status, old.body['error']], [400, 'CATEGORY_INACTIVE']);
    await assert.rejects(db.admin.query('update adex.expense_categories set active = true where id = $1', [pasajes]), (e: { code?: string }) => e.code === 'AX720');
    const tmp = await ana('POST', '/v1/expense-categories', { name: `Temporal ${randomUUID().slice(0, 4)}` });
    assert.deepEqual((await ana('POST', `/v1/expense-categories/${tmp.body['id']}/delete`, {})).body, { deleted: tmp.body['id'], kept: false });
    assert.equal(await count(db.admin, 'select 1 from adex.expense_categories where id = $1', [tmp.body['id']]), 0);
  });
});
