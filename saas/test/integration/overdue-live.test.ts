// Pendiente 3.2 (2026-10-26) · la mora se calcula AL LEER con la fecha contable de la empresa.
// Lo guardado en `adex.installments` (status, days_overdue) solo se recalcula al registrar o anular
// un pago; sin movimientos, una cuota vencida seguía «pendiente» con 0 días. Las lecturas de la API
// (`GET /v1/installments`, `GET /v1/credits/:id` y la respuesta del recaudo) derivan ahora el estado
// y los días con la misma regla que `adex.credit_recompute`, sin escribir nada.
// «Pasan los días» desplazando los vencimientos hacia atrás en la base de prueba (datos sintéticos).

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { money, newPerson, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;
type Inst = { number: number; dueDate: string; status: string; daysOverdue?: number; balanceMinor: number };

describe('Mora al día (pendiente 3.2)', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  let r1 = '';
  let bruno: Caller, ana: Caller, $bruno: Money, $ana: Money;
  let carlos: Person;

  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const credit = async () => {
    const c = await ana('POST', '/v1/clients', { routeId: r1, name: `Cliente ${randomUUID().slice(0, 6)}`, documentType: 'CPF', document: cpf(),
      phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const today = (await db.admin.query('select adex.business_today($1)::text d', [c1])).rows[0].d;
    const r = await $ana('/v1/credits/direct', { routeId: r1, clientId: c.body['id'], amountMinor: 50_000, interestRate: 20, installmentsCount: 12,
      frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return (r.body['credit'] as Body)['id'] as string;
  };
  /** «Pasan N días sin movimientos»: los vencimientos retroceden N días. */
  const daysPass = (sale: string, n: number) => db.admin.query('update adex.installments set due_date = due_date - $2::int where sale_id = $1', [sale, n]);
  /** Lo esperado según la fecha contable de la empresa, calculado aparte en SQL. */
  const expected = async (sale: string) => (await db.admin.query<{ number: number; status: string; days: number }>(
    `select number, case when paid_minor = 0 and due_date < adex.business_today(company_id) then 'vencida'
                         when balance_minor = 0 then 'pagada' when paid_minor > 0 then 'parcial' else 'pendiente' end status,
            case when balance_minor = 0 then 0 else greatest(0, adex.business_today(company_id) - due_date) end days
       from adex.installments where sale_id = $1 and status <> 'sustituida' order by number`, [sale])).rows;
  const listed = async (sale: string) => ((await ana('GET', `/v1/installments?saleId=${sale}`)).body['installments'] as Inst[]);
  const stored = async (sale: string) => (await db.admin.query('select status, days_overdue from adex.installments where sale_id = $1 order by number', [sale])).rows;
  const ledger = async () => (await db.admin.query(`select (select count(*) from adex.capital_operations where company_id = $1)::int ops,
      (select coalesce(sum(balance_minor), 0) from adex.sales where company_id = $1)::bigint::text sales`, [c1])).rows[0];

  before(async () => {
    db = await createTestDb('overdue_live', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    r1 = (await db.admin.query(`select id from adex.routes where company_id = $1 and name = 'Ruta 1'`, [c1])).rows[0].id;
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    carlos = await newPerson(api, issuer, provider.ids, bruno, { email: 'carlos-mora@example.test', role: 'cobrador', displayName: 'Carlos', routeIds: [r1] });
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 3_000_000, reason: 'Bolsa de Ana' }],
    ] as const) assert.equal((await $bruno(path, body)).status, 201, path);
  });
  after(async () => { await api?.close(); await db?.close(); });

  test('MORA-001 · venta que cruza el vencimiento sin movimientos: vencida y días al leer; nada se escribe ni se mueve', async () => {
    const s = await credit();
    await daysPass(s, 3);
    const before = await ledger();
    const exp = await expected(s);
    assert.ok(exp.filter((e) => e.status === 'vencida').length >= 2, `hay cuotas vencidas: ${JSON.stringify(exp)}`);
    const got = await listed(s);
    assert.deepEqual(got.map((i) => [i.number, i.status, i.daysOverdue]), exp.map((e) => [e.number, e.status, e.days]), 'GET /v1/installments?saleId');
    const byRoute = ((await ana('GET', `/v1/installments?routeId=${r1}`)).body['installments'] as (Inst & { saleId: string })[]).filter((i) => i.saleId === s);
    assert.deepEqual(byRoute.map((i) => [i.status, i.daysOverdue]), exp.map((e) => [e.status, e.days]), 'listado por ruta (proyección de Online)');
    const det = (await ana('GET', `/v1/credits/${s}`)).body['installments'] as Inst[];
    assert.deepEqual(det.map((i) => i.status), exp.map((e) => e.status), 'detalle del crédito');
    // Solo lectura: lo guardado sigue igual, sin operaciones nuevas ni cambios de saldo.
    assert.ok((await stored(s)).every((x) => x.status === 'pendiente' && x.days_overdue === 0), 'la lectura no escribe');
    assert.deepEqual(await ledger(), before, 'actualizar la mora no mueve dinero');
  });

  test('MORA-002 · pago parcial y venta saldada: parcial conserva sus días; saldada queda en 0', async () => {
    const s = await credit();
    await daysPass(s, 4);
    const p = await carlos.money('/v1/collections', { saleId: s, amountMinor: 2_000 });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const exp = await expected(s);
    assert.equal(exp[0]!.status, 'parcial');
    assert.ok(exp[0]!.days >= 3, JSON.stringify(exp[0]));
    const after = await listed(s);
    assert.deepEqual(after.map((i) => [i.status, i.daysOverdue]), exp.map((e) => [e.status, e.days]));
    // Saldar la venta: todo pagado y sin mora.
    const bal = Number((await db.admin.query('select balance_minor from adex.sales where id = $1', [s])).rows[0].balance_minor);
    const all = await carlos.money('/v1/collections', { saleId: s, amountMinor: bal });
    assert.equal(all.status, 201, JSON.stringify(all.body));
    assert.ok((all.body['installments'] as Inst[] | undefined ?? await listed(s)).every((i) => i.status === 'pagada' && (i.daysOverdue ?? 0) === 0));
    assert.ok((await listed(s)).every((i) => i.status === 'pagada' && i.daysOverdue === 0));
  });

  test('MORA-003 · cambio de fecha contable y zona horaria de la empresa: manda la fecha de la empresa, no la del equipo', async () => {
    const s = await credit();
    await daysPass(s, 2);
    const tz0 = (await db.admin.query('select timezone from adex.companies where id = $1', [c1])).rows[0].timezone as string;
    const c2tz = (await db.admin.query('select timezone from adex.companies where id = $1', [companyId('c2')])).rows[0].timezone as string;
    const seen: Record<string, number> = {};
    try {
      for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
        await db.admin.query('update adex.companies set timezone = $2 where id = $1', [c1, tz]);
        const exp = await expected(s);
        const got = await listed(s);
        assert.deepEqual(got.map((i) => [i.status, i.daysOverdue]), exp.map((e) => [e.status, e.days]), tz);
        seen[tz] = got[0]!.daysOverdue ?? -1;
      }
    } finally {
      await db.admin.query('update adex.companies set timezone = $2 where id = $1', [c1, tz0]);
    }
    assert.ok(seen['Pacific/Kiritimati']! > seen['Pacific/Pago_Pago']!, `UTC+14 va por delante de UTC−11: ${JSON.stringify(seen)}`);
    assert.equal((await db.admin.query('select timezone from adex.companies where id = $1', [companyId('c2')])).rows[0].timezone, c2tz, 'otra empresa no cambia');
  });
});
