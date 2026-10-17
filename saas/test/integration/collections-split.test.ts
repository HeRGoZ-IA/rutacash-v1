// FASE 5 · reparto capital / interés de los recaudos (observación A del cierre). Lo que
// CLEAN fija y debe reproducirse exactamente: efectivo recibido, cascada por cuota,
// saldo del crédito y tope. Lo que CLEAN NO fija: qué parte de cada abono es capital
// (su única proporción es la ESTIMACIÓN `interesPorCobrarEstimado`). El servidor aplica
// provisionalmente la proporción capital/total acumulada; estas pruebas demuestran sus
// efectos exactos y que el resto de cifras no dependen de ella.
//
// Crédito de referencia: capital 100.000, interés 20 % = 20.000, total 120.000.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('Fase 5 · reparto capital / interés de los recaudos', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  let r1 = '';
  let bruno: Caller;
  let $bruno: Money, $ana: Money;
  let carlos: Person;
  let today = '';

  const portfolio = () => balance(db.admin, c1, 'portfolio', null, r1);
  const income = () => balance(db.admin, c1, 'income', null, r1);
  const custody = () => balance(db.admin, c1, 'custody', carlos.membershipId, r1);
  const credit = async (amountMinor: number, installmentsCount: number, interestRate = 20) => {
    const client = (await bruno('POST', '/v1/clients', { routeId: r1, name: `Cliente ${randomUUID().slice(0, 6)}`, documentType: 'CPF',
      document: String(randomInt(10_000_000_000, 99_999_999_999)), phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b' })).body['id'];
    const r = await $ana('/v1/credits/direct', { routeId: r1, clientId: client, amountMinor, interestRate, installmentsCount, frequency: 'diaria',
      startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return (r.body['credit'] as Body)['id'] as string;
  };
  /** Cobra y devuelve [capital, interés] del asiento, comprobando el resto de efectos. */
  const pay = async (s: string, amountMinor: number): Promise<[number, number]> => {
    const [p0, i0, c0] = [await portfolio(), await income(), await custody()];
    const r = await carlos.money('/v1/collections', { saleId: s, amountMinor });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const p = r.body['payment'] as Body;
    const split: [number, number] = [p['principalMinor'] as number, p['interestMinor'] as number];
    assert.equal(split[0] + split[1], r.body['appliedMinor'], 'capital + interés = lo aplicado');
    assert.equal(await custody(), c0 + (r.body['appliedMinor'] as number), 'el efectivo es todo lo aplicado, sin depender del reparto');
    assert.equal(await portfolio(), p0 - split[0], 'la cartera baja solo por el capital');
    assert.equal(await income(), i0 - split[1], 'el interés va a su cuenta');
    return split;
  };
  const state = async (s: string) => {
    const x = (await db.admin.query(`select s.status, s.balance_minor::int bal, s.finished_on::text fin, s.sale_value_minor::int cap, s.total_value_minor::int tot,
        coalesce((select sum(p.amount_minor) from adex.payments p where p.sale_id = s.id), 0)::int paid,
        coalesce((select sum(p.principal_minor) from adex.payments p where p.sale_id = s.id), 0)::int principal,
        coalesce((select sum(p.interest_minor) from adex.payments p where p.sale_id = s.id), 0)::int interest,
        (select sum(balance_minor) from adex.installments i where i.sale_id = s.id)::int inst
      from adex.sales s where s.id = $1`, [s])).rows[0];
    // Invariantes que no dependen de la política de reparto (CLEAN):
    assert.equal(x.bal, x.inst, 'saldo = Σ cuotas');
    assert.equal(x.bal, x.tot - x.paid, 'saldo = total − pagado');
    // Invariante de la proporción aplicada: capital reconocido = round(pagado × capital / total).
    assert.equal(x.principal, Math.round((x.paid * x.cap) / x.tot));
    assert.equal(x.principal + x.interest, x.paid);
    return x;
  };

  before(async () => {
    db = await createTestDb('collsplit', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    r1 = (await db.admin.query(`select id from adex.routes where company_id = $1 and name = 'Ruta 1'`, [c1])).rows[0].id;
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    $ana = money(caller(api, issuer, 'ana', M.anaAdmin));
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    carlos = await newPerson(api, issuer, provider.ids, bruno, { email: 'carlos-split@example.test', role: 'cobrador', displayName: 'Carlos', routeIds: [r1] });
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 9_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 5_000_000, reason: 'Bolsa de Ana' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
  });
  after(async () => { await api.close(); await db.close(); });

  test('SPLIT-A · capital 100.000 + interés 20.000; recaudo 30.000 → 25.000 capital y 5.000 interés; tres cuotas pagadas', async () => {
    const p0 = await portfolio();
    const s = await credit(100_000, 12);
    assert.equal(await portfolio(), p0 + 100_000, 'Fase 4: la cartera inicial es solo el capital');
    assert.deepEqual(await pay(s, 30_000), [25_000, 5_000]);
    const x = await state(s);
    assert.deepEqual([x.bal, x.status], [90_000, 'activa']);
    const inst = (await db.admin.query('select status from adex.installments where sale_id = $1 order by number', [s])).rows.map((i) => i.status);
    assert.deepEqual(inst.slice(0, 4), ['pagada', 'pagada', 'pagada', 'pendiente']);
  });

  test('SPLIT-B/F · pagos parciales desiguales hasta extinguir: capital exacto 100.000, interés exacto 20.000, cartera del crédito en 0', async () => {
    const s = await credit(100_000, 12);
    const [p0, i0] = [await portfolio(), await income()];
    const splits = [];
    for (const amt of [7_777, 13_001, 50_000, 49_222]) splits.push(await pay(s, amt));
    assert.deepEqual(splits, [[6_481, 1_296], [10_834, 2_167], [41_667, 8_333], [41_018, 8_204]]);
    const x = await state(s);
    assert.deepEqual([x.status, x.bal, x.fin, x.principal, x.interest], ['finalizada', 0, today, 100_000, 20_000]);
    assert.equal(await portfolio(), p0 - 100_000, 'el último pago deja la cartera de este crédito exactamente en 0');
    assert.equal(await income(), i0 - 20_000);
  });

  test('SPLIT-C · crédito pagado completo en una sola operación', async () => {
    const s = await credit(100_000, 12);
    assert.deepEqual(await pay(s, 120_000), [100_000, 20_000]);
    assert.deepEqual([(await state(s)).status, (await state(s)).bal], ['finalizada', 0]);
  });

  test('SPLIT-D · importes con redondeo (capital 10.001 al 10 %, 7 cuotas y abonos de 1): nunca negativo, total exacto', async () => {
    const s = await credit(10_001, 7, 10);   // interés round(1.000,1) = 1.000 · total 11.001 · cuotas 1.572 ×6 + 1.569
    const amounts = (await db.admin.query('select amount_minor::int a from adex.installments where sale_id = $1 order by number', [s])).rows.map((r) => r.a);
    assert.deepEqual(amounts, [1_572, 1_572, 1_572, 1_572, 1_572, 1_572, 1_569]);
    const seen: [number, number][] = [];
    for (const amt of [1, 1, 1, 3, 1_571, 1_572, 999, 2_145, 1_572]) {
      const sp = await pay(s, amt);
      assert.ok(sp[0] >= 0 && sp[1] >= 0, `sin partes negativas (${sp})`);
      seen.push(sp);
      await state(s);
    }
    assert.deepEqual(seen.slice(0, 3), [[1, 0], [1, 0], [1, 0]], 'abonos mínimos: el redondeo los imputa a capital');
    const rest = (await state(s)).bal;
    await pay(s, rest);
    const x = await state(s);
    assert.deepEqual([x.status, x.principal, x.interest], ['finalizada', 10_001, 1_000], 'al final, capital e interés exactos pese a los redondeos');
  });

  test('SPLIT-E · anular el abono parcial y volver a cobrar: espejo exacto y mismo reparto', async () => {
    const s = await credit(100_000, 12);
    const [p0, i0] = [await portfolio(), await income()];
    assert.deepEqual(await pay(s, 30_000), [25_000, 5_000]);
    const pid = (await db.admin.query('select id from adex.payments where sale_id = $1', [s])).rows[0].id;
    const r = await $ana(`/v1/collections/${pid}/reverse`, { reason: 'Error de digitación' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const rev = r.body['reversal'] as Body;
    assert.deepEqual([rev['amountMinor'], rev['principalMinor'], rev['interestMinor']], [-30_000, -25_000, -5_000]);
    assert.deepEqual([await portfolio(), await income()], [p0, i0], 'la cartera y el interés vuelven exactamente');
    assert.deepEqual([(await state(s)).bal, (await state(s)).status], [120_000, 'activa']);
    assert.deepEqual(await pay(s, 30_000), [25_000, 5_000]);
    assert.equal((await state(s)).bal, 90_000);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    const rec = (await bruno('GET', '/v1/capital/reconciliation')).body;
    assert.equal(rec['ok'], true, JSON.stringify(rec));
    assert.deepEqual(api.errors, []);
  });
});
