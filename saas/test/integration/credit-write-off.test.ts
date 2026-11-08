// 3.28 (0053) · Castigo de créditos «Dar por perdida», deshacer y recuperación (diseño aprobado por el propietario el
// 2026-11-08), contra PostgreSQL real y la API. Datos 100 % sintéticos.
//   · Castigar no mueve dinero: el capital pendiente pasa de la cartera a «Pérdida por créditos».
//   · Solo el Administrador responsable; motivo obligatorio («Otro» con explicación).
//   · La venta perdida no acepta cobros normales; la recuperación la registra el Administrador y entra a la caja.
//   · Un pago de recuperación no se anula; con recuperaciones no se deshace el castigo.
//   · Deshacer devuelve la venta a activa y el capital a la cartera. Liquidación: «creditLossMinor». Conciliación limpia.
//
// Importes en unidades menores (BRL): R$ 600 = 60_000.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, routeId } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('3.28 · castigo de créditos (0053)', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  let ana: Caller, $ana: Money, gabi: Caller, $gabi: Money, bruno: Caller, $bruno: Money;
  let today = '';
  let cob: Person;

  const acct = async (kind: string) => Number((await db.admin.query(
    `select coalesce(sum(balance_minor), 0)::text b from adex.capital_accounts where company_id = $1 and kind = $2 and route_id = $3`, [c1, kind, r1])).rows[0].b);
  const cash = async () => Number((await db.admin.query(
    `select coalesce(sum(balance_minor), 0)::text b from adex.capital_accounts where company_id = $1 and kind in ('admin', 'route_base', 'custody', 'company')`, [c1])).rows[0].b);
  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const newClient = async () => {
    const r = await ana('POST', '/v1/clients', { routeId: r1, name: `CLIENTE CASTIGO ${randomUUID().slice(0, 6)}`, documentType: 'CPF', document: cpf(),
      phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body['id'] as string;
  };
  // R$ 600 al 20 % = R$ 720 en 10 cuotas diarias de R$ 72.
  const direct = async () => {
    const r = await $ana('/v1/credits/direct', { routeId: r1, clientId: await newClient(), amountMinor: 60_000, interestRate: 20, installmentsCount: 10,
      frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return (r.body['credit'] as Body)['id'] as string;
  };
  // El Cobrador de la ruta registra el cobro normal (el efectivo queda en su custodia).
  const collect = (saleId: string, amountMinor: number) => cob.money('/v1/collections', { saleId, amountMinor });
  const writeOff = (id: string, o: Body = {}, as: Money = $ana) => as(`/v1/credits/${id}/write-off`, { reasonKind: 'fallecio', reason: '', ...o });
  const undo = (id: string, o: Body = {}) => $ana(`/v1/credits/${id}/write-off/undo`, { reason: 'Se marcó por error la venta equivocada', ...o });
  const recover = (id: string, amountMinor: number) => $ana(`/v1/credits/${id}/recovery`, { amountMinor, note: 'El cliente volvió y pagó' });
  const sale = async (id: string) => (await db.admin.query<{ status: string; balance: string; lost: string | null; kind: string | null; op: string | null }>(
    `select status, balance_minor::text balance, lost_principal_minor::text lost, lost_kind kind, lost_operation_id op from adex.sales where id = $1`, [id])).rows[0]!;
  const ledgerChecks = async () => {
    const r = await bruno('GET', '/v1/capital/reconciliation');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((r.body['checks'] as Body[]).filter((c) => !c['ok']), [], 'conciliación del SuperAdmin sin fallos');
    assert.ok((r.body['checks'] as Body[]).some((c) => c['name'] === 'credit-loss-matches-write-offs'), 'comprobación nueva presente');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  };
  const lossInLiquidation = async () => {
    const r = await ana('GET', `/v1/periods/liquidation?routeId=${r1}&from=${today}&to=${today}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const fig = (r.body['figures'] ?? r.body) as Body;
    return Number(((fig['credit'] ?? (r.body['credit'] as Body)) as Body)['creditLossMinor']);
  };

  before(async () => {
    db = await createTestDb('creditwriteoff', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    gabi = caller(api, issuer, 'gabi', M.gabiSec); $gabi = money(gabi);
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text t`)).rows[0].t;
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 3_000_000, reason: 'Bolsa de Ana' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
    cob = await newPerson(api, issuer, provider.ids, bruno, { email: 'wo-cobrador@example.test', role: 'cobrador', displayName: 'COBRADOR CASTIGO', routeIds: [r1] });
  });
  after(async () => { await api?.close(); await db?.close(); });

  test('WO-001 · «Dar por perdida»: el capital pendiente sale de la cartera a «Pérdida por créditos»; el dinero no se mueve', async () => {
    const id = await direct();
    assert.equal((await collect(id, 7_200)).status, 201);          // una cuota: R$ 60 de capital y R$ 12 de interés
    const [p0, l0, c0] = [await acct('portfolio'), await acct('credit_loss'), await cash()];
    const r = await writeOff(id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const wo = r.body['writeOff'] as Body;
    assert.equal(wo['principalMinor'], 54_000, 'capital pendiente = 600 − 60');
    assert.equal(wo['balanceMinor'], 64_800, 'saldo con interés = 720 − 72');
    assert.equal(wo['reason'], 'Falleció');
    assert.equal((r.body['credit'] as Body)['status'], 'perdida');
    assert.equal((r.body['credit'] as Body)['lossKind'], 'fallecio');
    assert.equal(await acct('portfolio'), p0 - 54_000);
    assert.equal(await acct('credit_loss'), l0 + 54_000);
    assert.equal(await cash(), c0, 'ninguna caja cambia');
    const s = await sale(id);
    assert.deepEqual([s.status, s.balance, s.lost, s.kind], ['perdida', '64800', '54000', 'fallecio'], 'el saldo del cliente se conserva');
    const h = (await db.admin.query(`select kind, reason_kind, principal_minor::text p from adex.sale_write_offs where sale_id = $1`, [id])).rows;
    assert.deepEqual(h, [{ kind: 'WRITE_OFF', reason_kind: 'fallecio', p: '54000' }]);
    const audit = (await db.admin.query(`select count(*)::int n from adex.audit_log where action = 'WRITE_OFF_CREDIT' and entity_id = $1`, [id])).rows[0].n;
    assert.equal(audit, 1);
    await ledgerChecks();
  });

  test('WO-002 · reglas: solo el Administrador; «Otro» exige explicación; una venta perdida no se vuelve a castigar ni acepta cobros normales', async () => {
    const id = await direct();
    assert.equal((await writeOff(id, {}, $gabi)).status, 403, 'el Secretario no castiga');
    const otro = await writeOff(id, { reasonKind: 'otro', reason: 'corto' });
    assert.equal(otro.status, 400, JSON.stringify(otro.body));
    assert.equal((await writeOff(id, { reasonKind: 'congelado' })).status, 400);
    assert.equal((await writeOff(id, { reasonKind: 'otro', reason: 'El cliente cerró el negocio y desapareció' })).status, 200);
    const again = await writeOff(id);
    assert.equal(again.status, 409); assert.equal(again.body['error'], 'CREDIT_NOT_WRITABLE_OFF');
    const pay = await collect(id, 7_200);
    assert.equal(pay.status, 409); assert.equal(pay.body['error'], 'CREDIT_NOT_ACTIVE');
    await ledgerChecks();
  });

  test('WO-003 · recuperación: entra a la caja, reduce la pérdida con su capital y el interés va a intereses; no se anula; con ella no se deshace', async () => {
    const id = await direct();
    assert.equal((await writeOff(id, { reasonKind: 'se_fue_del_pais' })).status, 200);
    const [l0, c0, i0] = [await acct('credit_loss'), await cash(), await acct('income')];
    const r = await recover(id, 14_400);                                // dos cuotas: R$ 120 de capital y R$ 24 de interés
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const rec = r.body['recovery'] as Body;
    assert.deepEqual([rec['appliedMinor'], rec['principalMinor'], rec['interestMinor']], [14_400, 12_000, 2_400]);
    assert.equal(await acct('credit_loss'), l0 - 12_000);
    assert.equal(await cash(), c0 + 14_400, 'el dinero entra a la caja de la ruta');
    assert.equal(await acct('income'), i0 - 2_400);
    assert.equal((await sale(id)).status, 'perdida');
    const rev = await $ana(`/v1/collections/${rec['paymentId']}/reverse`, { reason: 'Prueba de anulación de una recuperación' });
    assert.equal(rev.status, 409, JSON.stringify(rev.body)); assert.equal(rev.body['error'], 'RECOVERY_NOT_REVERSIBLE');
    const u = await undo(id);
    assert.equal(u.status, 409); assert.equal(u.body['error'], 'WRITE_OFF_HAS_RECOVERIES');
    // Una venta activa no recibe «recuperación».
    const other = await direct();
    const bad = await recover(other, 7_200);
    assert.equal(bad.status, 409); assert.equal(bad.body['error'], 'RECOVERY_NOT_ALLOWED');
    await ledgerChecks();
  });

  test('WO-004 · recuperación total: la venta queda finalizada y su pérdida en cero', async () => {
    const id = await direct();
    assert.equal((await writeOff(id)).status, 200);
    const l0 = await acct('credit_loss');
    const r = await recover(id, 999_999);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((r.body['recovery'] as Body)['appliedMinor'], 72_000, 'tope al saldo');
    assert.equal(await acct('credit_loss'), l0 - 60_000);
    assert.equal((await sale(id)).status, 'finalizada');
    await ledgerChecks();
  });

  test('WO-005 · deshacer: la venta vuelve a activa, el capital a la cartera y vuelve a aceptar cobros', async () => {
    const id = await direct();
    const [p0, l0] = [await acct('portfolio'), await acct('credit_loss')];
    assert.equal((await writeOff(id)).status, 200);
    const short = await undo(id, { reason: 'corto' });
    assert.equal(short.status, 400);
    const u = await undo(id);
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal((u.body['credit'] as Body)['status'], 'activa');
    assert.equal((u.body['credit'] as Body)['lossReason'], null);
    assert.equal(await acct('portfolio'), p0);
    assert.equal(await acct('credit_loss'), l0);
    const s = await sale(id);
    assert.deepEqual([s.status, s.lost, s.op], ['activa', null, null]);
    assert.equal((await collect(id, 7_200)).status, 201, 'vuelve a aceptar cobros');
    const again = await undo(id);
    assert.equal(again.status, 409); assert.equal(again.body['error'], 'CREDIT_NOT_WRITTEN_OFF');
    const h = (await db.admin.query(`select kind from adex.sale_write_offs where sale_id = $1 order by created_at`, [id])).rows.map((x) => x.kind);
    assert.deepEqual(h, ['WRITE_OFF', 'UNDO']);
    await ledgerChecks();
  });

  test('WO-006 · Liquidación del día: «Pérdida por créditos» = castigado − deshecho − capital recuperado', async () => {
    // WO-001 54.000 + WO-002 60.000 + WO-003 60.000 − 12.000 + WO-004 60.000 − 60.000 + WO-005 (60.000 − 60.000) = 162.000
    assert.equal(await lossInLiquidation(), 162_000);
    assert.equal(await acct('credit_loss'), 162_000);
  });
});
