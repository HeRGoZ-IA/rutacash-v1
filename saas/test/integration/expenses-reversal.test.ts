// FASE 5 · F5-D02 (aprobada 2026-10-17): anulación auditada de gastos de trabajador y de
// ruta. Autoridad: el Administrador responsable de capital de la ruta (`expense.correct` +
// `correct`). R74 (0037, regla definitiva): ya no «nunca la PERSONA que registró el gasto»; el responsable anula
// también lo suyo; nadie anula un gasto cargado a SU propia custodia (aunque use otra membresía).
// R74 (cambio de regla en esta intervención): el SuperAdmin ya no anula gastos de ruta ni de
// trabajador ni carga gastos a otros; las pruebas que lo usaban pasan al responsable de la ruta. D7: se asienta hoy, en un periodo abierto; si la semana del gasto está
// cerrada es un ajuste nuevo y exige autoridad de ajustes. El importe vuelve a la cuenta
// que pagó (custodia del trabajador o bolsa que financió el gasto). PostgreSQL real.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf } from '../../db/seeds/synthetic.ts';
import { asApi, count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, parallel, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Fase 5 · F5-D02 · anulación de gastos de trabajador y de ruta', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  let r1 = '';
  let rAna = '';   // ruta de Ana cobradora (la misma persona que Ana administradora)
  let rB = '';     // ruta cuyo responsable cambiará
  let rD7 = '';    // ruta aislada para los cierres
  let cat = '';
  let bruno: Caller, gabi: Caller;
  let $bruno: Money, $ana: Money, $anaCob: Money;
  let carlos: Person, dora: Person, xavier: Person, olga: Person, sofia: Person, tom: Person;

  const custody = (m: string, r = r1) => balance(db.admin, c1, 'custody', m, r);
  const pool = (m: string) => balance(db.admin, c1, 'admin', m);
  const expenseAcc = (r: string) => balance(db.admin, c1, 'expense', null, r);
  const spend = (m: Money, body: Body, op?: string) => m('/v1/expenses', { categoryId: cat, description: 'Gasto', ...body }, op);
  const workerExp = (m: Money, workerId: string, amountMinor: number, route = r1) => spend(m, { scope: 'trabajador', routeId: route, workerId, amountMinor });
  const reverse = (m: Money, id: string, op?: string, reason = 'Registro equivocado') => m(`/v1/expenses/${id}/reverse`, { reason }, op);
  const idOf = (r: { body: Body }) => (r.body['expense'] as Body)['id'] as string;

  before(async () => {
    db = await createTestDb('expreverse', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    r1 = (await db.admin.query(`select id from adex.routes where company_id = $1 and name = 'Ruta 1'`, [c1])).rows[0].id;
    cat = (await db.admin.query(`select id from adex.expense_categories where company_id = $1 and name = 'Combustible'`, [c1])).rows[0].id;
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    $ana = money(caller(api, issuer, 'ana', M.anaAdmin));
    $anaCob = money(caller(api, issuer, 'ana', M.anaCob));
    gabi = caller(api, issuer, 'gabi', M.gabiSec);
    const mk = (email: string, role: string, displayName: string, routeIds: string[]) => newPerson(api, issuer, provider.ids, bruno, { email, role, displayName, routeIds });
    const route = async (name: string) => (await bruno('POST', '/v1/routes', { name, interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [M.anaAdmin] })).body['id'] as string;
    carlos = await mk('carlos-rev@example.test', 'cobrador', 'Carlos', [r1]);
    dora = await mk('dora-rev@example.test', 'supervisor', 'Dora', [r1]);
    xavier = await mk('xavier-rev@example.test', 'admin', 'Xavier', [r1]);
    sofia = await mk('sofia-rev@example.test', 'superadmin', 'Sofía', []);
    rAna = await route('Ruta Ana'); rB = await route('Ruta Bolsa'); rD7 = await route('Ruta Cierres');
    if ((await bruno('PUT', `/v1/members/${M.anaCob}/routes`, { routeIds: [rAna] })).status !== 200) throw new Error('rutas de Ana cobradora');
    olga = await mk('olga-rev@example.test', 'admin', 'Olga', [rB]);
    tom = await mk('tom-rev@example.test', 'cobrador', 'Tom', [rD7]);
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 1_000_000, reason: 'Bolsa de Ana' }],
      ['/v1/capital/allocations', { adminId: olga.membershipId, amountMinor: 100_000, reason: 'Bolsa de Olga' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
    // R74 (H3): Ana Administradora ya no entrega Base a Ana Cobradora (misma persona); su gasto no la necesita.
    for (const [r, w] of [[r1, carlos.membershipId], [rD7, tom.membershipId]] as const) {
      if ((await $ana('/v1/capital/deliveries', { routeId: r, workerId: w, amountMinor: 10_000, reason: 'Base' })).status !== 201) throw new Error('entrega');
    }
  });
  after(async () => { await api.close(); await db.close(); });

  test('REVX-001/007 · el responsable anula un gasto de trabajador registrado por otra persona: espejo enlazado, historia intacta, auditado', async () => {
    const e = idOf(await workerExp(carlos.money, carlos.membershipId, 3_000));
    const [cash, acc] = [await custody(carlos.membershipId), await expenseAcc(r1)];
    const r = await reverse($ana, e);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const rev = r.body['reversal'] as Body;
    assert.deepEqual([rev['amountMinor'], rev['state'], rev['reversesId'], rev['workerId'], rev['registeredBy']], [-3_000, 'anulacion', e, carlos.membershipId, M.anaAdmin]);
    assert.deepEqual([(r.body['original'] as Body)['state'], (r.body['original'] as Body)['amountMinor'], (r.body['original'] as Body)['registeredBy']],
      ['anulado', 3_000, carlos.membershipId], 'el original conserva sus hechos; solo queda enlazado');
    assert.equal(await custody(carlos.membershipId), cash + 3_000);
    assert.equal(await expenseAcc(r1), acc - 3_000);
    const op = (await db.admin.query('select kind, reverses_kind, actor_role, entry_date::text d from adex.capital_operations where expense_id = $1', [rev['id']])).rows[0];
    assert.deepEqual([op.kind, op.reverses_kind, op.actor_role], ['REVERSAL', 'WORKER_EXPENSE', 'admin']);
    const audit = (await db.admin.query(`select reason, metadata->>'registeredBy' reg, metadata->>'periodClosed' closed from adex.audit_log
                                          where action = 'MOVEMENT_REVERSED' and entity_id = $1 and txid is not null`, [e])).rows;
    assert.deepEqual(audit, [{ reason: 'Registro equivocado', reg: carlos.membershipId, closed: 'false' }]);
    assert.equal((await reverse($ana, e)).body['error'], 'ALREADY_REVERSED');
    assert.equal((await reverse($ana, rev['id'] as string)).body['error'], 'REVERSAL_NOT_ALLOWED');
    assert.equal((await $ana(`/v1/expenses/${e}/reverse`, {})).body['error'], 'INVALID_INPUT', 'motivo obligatorio');
  });

  // R74 (cambio de regla en esta intervención): antes lo anulaba el SuperAdmin; ahora el nuevo responsable.
  test('REVX-002/010 · el nuevo responsable anula un gasto de ruta: vuelve a la bolsa que lo financió, aunque el responsable haya cambiado', async () => {
    const e = idOf(await spend($ana, { scope: 'ruta', routeId: rB, amountMinor: 4_000 }));
    const anaAfterSpend = await pool(M.anaAdmin);
    assert.equal((await bruno('PUT', `/v1/routes/${rB}/capital-controller`, { membershipId: olga.membershipId, reason: 'Reorganización' })).status, 200);
    const olgaBefore = await pool(olga.membershipId);
    const $olga = money(caller(api, issuer, olga.identityId, olga.membershipId));
    assert.equal((await reverse($bruno, e)).body['error'], 'CAPITAL_AUTHORITY_REQUIRED', 'R74: el SuperAdmin ya no anula gastos de ruta');
    const r = await reverse($olga, e);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await pool(M.anaAdmin), anaAfterSpend + 4_000, 'vuelve a la bolsa de Ana, que pagó');
    assert.equal(await pool(olga.membershipId), olgaBefore, 'sin transferencias a la bolsa del nuevo responsable');
    // Un gasto que registró la propia responsable: ni Ana (ya no es la responsable) ni el SuperAdmin (R74) lo
    // anulan. R74 (0037, regla definitiva): ELLA sí, como responsable de capital (se retiró la independencia F5-D02).
    const e2 = idOf(await spend($olga, { scope: 'ruta', routeId: rB, amountMinor: 1_000 }));
    assert.equal((await reverse($ana, e2)).body['error'], 'CAPITAL_AUTHORITY_REQUIRED', 'Ana ya no es la responsable de esa ruta');
    assert.equal((await reverse($bruno, e2)).status, 403);
    assert.equal(await pool(olga.membershipId), olgaBefore - 1_000, 'el gasto de Olga sigue pagado por la bolsa de Olga');
    const own = await reverse($olga, e2);
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.equal(await pool(olga.membershipId), olgaBefore, 'la responsable anuló su propio gasto: vuelve a su bolsa');
  });

  // R74 (0037): ya no rige «quien registró no anula»; sigue rigiendo que nadie anula un gasto cargado a SU propia
  // custodia (aquí, la custodia de Ana Cobradora, misma persona que Ana Administradora).
  test('REVX-003 · nadie anula un gasto cargado a su propia custodia, aunque use otra membresía (DS-05)', async () => {
    const own = idOf(await workerExp($anaCob, M.anaCob, 500, rAna));   // Ana como Cobradora
    const r = await reverse($ana, own);                                 // Ana como Administradora responsable
    assert.deepEqual([r.status, r.body['error']], [403, 'SELF_CORRECTION_FORBIDDEN']);
    // R74 (cambio de regla en esta intervención): el SuperAdmin ya no carga gastos a otros; lo hace
    // la Supervisora de la ruta (`settle`), y lo anula otra persona autorizada (la responsable).
    assert.equal((await workerExp($bruno, carlos.membershipId, 400)).status, 403, 'R74: el SuperAdmin no carga gastos a otros');
    const byDora = idOf(await workerExp(dora.money, carlos.membershipId, 400));
    assert.equal((await reverse(dora.money, byDora)).status, 403, 'la Supervisora no anula gastos');
    assert.equal((await reverse($ana, byDora)).status, 201, 'otra persona autorizada sí');
    await asApi(db.api, { identityId: identityOf('ana'), membershipId: M.anaAdmin, companyId: c1 }, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(q.query('select adex.expense_reverse(gen_random_uuid(), $1, $2)', [own, 'Por SQL directo']), { code: 'AX717' }, 'segunda barrera por persona');
      await q.query('rollback to savepoint s');
    });
    // R74: antes lo anulaba otra SuperAdmin; ahora solo la responsable de la ruta, que es la misma persona.
    assert.equal((await reverse(money(caller(api, issuer, sofia.identityId, sofia.membershipId)), own)).body['error'], 'CAPITAL_AUTHORITY_REQUIRED', 'otra SuperAdmin tampoco (R74)');
  });

  test('REVX-004/005/006 · sin autoridad: Administrador no responsable, Supervisor, Cobrador, Secretaria, Owner y otra empresa', async () => {
    const e = idOf(await workerExp(carlos.money, carlos.membershipId, 200));
    const before = await custody(carlos.membershipId);
    assert.equal((await reverse(xavier.money, e)).body['error'], 'CAPITAL_AUTHORITY_REQUIRED', 'Administrador asignado, no responsable');
    assert.equal((await reverse(dora.money, e)).status, 403, 'Supervisor');
    assert.equal((await reverse(carlos.money, e)).status, 403, 'Cobrador (ni el suyo)');
    assert.ok([403, 404].includes((await reverse(money(gabi), e)).status), 'Secretaria');
    assert.equal((await reverse(money(caller(api, issuer, 'carla', M.carlaSa)), e)).status, 404, 'otra empresa');
    await asApi(db.api, { identityId: identityOf('carla'), membershipId: M.carlaSa, companyId: companyId('c2') }, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(q.query('select adex.expense_reverse(gen_random_uuid(), $1, $2)', [e, 'Empresa ajena']), { code: 'AX412' });
      await q.query('rollback to savepoint s');
    });
    await assert.rejects(db.control.query(`select adex.expense_reverse(gen_random_uuid(), $1, 'Owner')`, [e]), { code: '42501' }, 'Owner');
    assert.equal(await custody(carlos.membershipId), before);
    assert.equal(await count(db.admin, 'select 1 from adex.expenses where reverses_id = $1', [e]), 0);
  });

  test('REVX-008 · semana del gasto cerrada (D7): ajuste nuevo en el periodo abierto; el periodo original intacto; sin periodo abierto, nada', async () => {
    const tz = async (zone: string) => { await db.admin.query('update adex.companies set timezone = $2 where id = $1', [c1, zone]); };
    const close = (from: string, to: string) => db.admin.query(
      `insert into adex.weekly_settlements (id, company_id, route_id, week_start, week_end, opening_balance_minor, capital_in_minor, collections_minor,
         loans_disbursed_minor, expenses_minor, transfers_in_minor, transfers_out_minor, withdrawals_minor, closing_balance_minor, created_at, status, closed_at, version)
       values ($1, $2, $3, $4::date, $5::date, 0, 0, 0, 0, 0, 0, 0, 0, 0, now(), 'cerrada', now(), 1)`, [randomUUID(), c1, rD7, from, to]);
    const $tom = tom.money;
    try {
      await tz('Pacific/Kiritimati');
      const day = (await db.admin.query(`select (now() at time zone 'Pacific/Kiritimati')::date::text d`)).rows[0].d;
      const e1 = idOf(await workerExp($tom, tom.membershipId, 800, rD7));
      const e2 = idOf(await workerExp($tom, tom.membershipId, 600, rD7));
      await close(day, day);
      assert.equal((await reverse($ana, e1)).body['error'], 'PERIOD_CLOSED', 'hoy también cerrado: no se inventa otra fecha ni se reabre');
      await tz('Pacific/Pago_Pago');
      const now = (await db.admin.query(`select (now() at time zone 'Pacific/Pago_Pago')::date::text d`)).rows[0].d;
      assert.notEqual(now, day);
      const weeks = await count(db.admin, 'select 1 from adex.weekly_settlements where route_id = $1', [rD7]);
      const cash = await custody(tom.membershipId, rD7);
      const r = await reverse($ana, e1, undefined, 'Corrección tras el cierre');
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal((r.body['reversal'] as Body)['expenseDate'], now, 'el ajuste va al periodo abierto');
      assert.equal(((await db.admin.query('select expense_date::text d, amount_minor::int a from adex.expenses where id = $1', [e1])).rows[0]).d, day, 'el original no cambia');
      assert.equal(await count(db.admin, 'select 1 from adex.weekly_settlements where route_id = $1', [rD7]), weeks, 'sin reapertura');
      assert.equal(await custody(tom.membershipId, rD7), cash + 800);
      const meta = (await db.admin.query(`select metadata->>'periodClosed' c, metadata->>'originalDate' d from adex.audit_log where action = 'MOVEMENT_REVERSED' and entity_id = $1`, [e1])).rows[0];
      assert.deepEqual(meta, { c: 'true', d: day });
      await close(now, now);
      assert.equal((await reverse($ana, e2)).body['error'], 'PERIOD_CLOSED');
    } finally {
      await tz('America/Sao_Paulo');
    }
  });

  test('REVX-009 · negativo del trabajador: la anulación lo corrige exactamente, sin crear efectivo ni tocar otras cuentas', async () => {
    const start = await custody(carlos.membershipId);
    const other = { ana: await pool(M.anaAdmin), dora: await custody(dora.membershipId) };
    const e = idOf(await workerExp(carlos.money, carlos.membershipId, start + 2_500));
    assert.equal(await custody(carlos.membershipId), -2_500);
    assert.equal((await reverse($ana, e)).status, 201);
    assert.equal(await custody(carlos.membershipId), start, 'vuelve exactamente a la posición previa al gasto');
    assert.deepEqual({ ana: await pool(M.anaAdmin), dora: await custody(dora.membershipId) }, other);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('REVX-011/012/013 · simultáneas → una; mismo id → misma respuesta; mismo id con otros datos → 409', async () => {
    const e = idOf(await workerExp(carlos.money, carlos.membershipId, 900));
    const cash = await custody(carlos.membershipId);
    // R74: antes alternaba con el SuperAdmin; ya no anula gastos de trabajador.
    const res = await parallel(5, () => reverse($ana, e));
    assert.equal(res.filter((r) => r.status === 201).length, 1, JSON.stringify(res.map((r) => r.body['error'] ?? r.status)));
    assert.ok(res.filter((r) => r.status !== 201).every((r) => r.body['error'] === 'ALREADY_REVERSED'));
    assert.equal(await custody(carlos.membershipId), cash + 900, 'una sola afectación');
    const e2 = idOf(await workerExp(carlos.money, carlos.membershipId, 300));
    const op = randomUUID();
    const same = await parallel(4, () => reverse($ana, e2, op));
    assert.ok(same.every((r) => r.status === 201));
    assert.equal(new Set(same.map((r) => (r.body['reversal'] as Body)['id'])).size, 1, 'la misma anulación para todos');
    for (const r of same) assert.deepEqual(r.body, same[0]!.body);
    assert.equal(await count(db.admin, 'select 1 from adex.expenses where reverses_id = $1', [e2]), 1);
    const e3 = idOf(await workerExp(carlos.money, carlos.membershipId, 100));
    assert.equal((await reverse($ana, e3, op)).body['error'], 'OPERATION_ID_REUSED', 'otro gasto con la misma clave');
    assert.equal((await reverse($ana, e2, op, 'Otro motivo')).body['error'], 'OPERATION_ID_REUSED', 'otro motivo con la misma clave');
    assert.equal(await count(db.admin, 'select 1 from adex.expenses where reverses_id = $1', [e3]), 0);
  });

  test('REVX-014 · revocación de la membresía que anula, en paralelo: la anulación termina; después ya no opera', async () => {
    // R74 (cambio de regla en esta intervención): antes anulaba una SuperAdmin (Sofía); ahora la
    // responsable de una ruta propia (Pía), con una Cobradora (Rita) que registra sus gastos.
    const pia = await newPerson(api, issuer, provider.ids, bruno, { email: 'pia-rev@example.test', role: 'admin', displayName: 'Pía', routeIds: [] });
    const rRev = (await bruno('POST', '/v1/routes', { name: 'Ruta Revocación', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [pia.membershipId] })).body['id'] as string;
    const rita = await newPerson(api, issuer, provider.ids, bruno, { email: 'rita-rev@example.test', role: 'cobrador', displayName: 'Rita', routeIds: [rRev] });
    const e = idOf(await workerExp(rita.money, rita.membershipId, 250, rRev));
    const e2 = idOf(await workerExp(rita.money, rita.membershipId, 150, rRev));
    const sofia = pia;
    let release!: () => void;
    let arrived!: () => void;
    let pausedOnce = false;
    const reached = new Promise<void>((r) => { arrived = r; });
    const paused = await startCompanyApi(db, issuer, provider, {
      afterContext: async (ctx, path) => {
        if (path.endsWith('/reverse') && ctx.membershipId === sofia.membershipId && !pausedOnce) { pausedOnce = true; arrived(); await new Promise<void>((r) => { release = r; }); }
      },
    });
    try {
      const p = reverse(money(caller(paused, issuer, sofia.identityId, sofia.membershipId)), e);
      await reached;
      const revoke = bruno('POST', `/v1/members/${sofia.membershipId}/deactivate`, {});
      await sleep(300);
      release();
      assert.equal((await p).status, 201, 'autorizada al empezar: la revocación esperó (REVOKE-004)');
      // R74 (0036, RB-D1): la responsable de capital de una ruta no se desactiva (cuentas pendientes); la decisión se
      // toma DESPUÉS de esperar a la anulación en curso.
      assert.deepEqual([(await revoke).status, (await revoke).body['error']], [409, 'ADMIN_HAS_PENDING_ACCOUNTS']);
    } finally { await paused.close(); }
    // Entrega estructural de la ruta a otro Administrador; entonces sí se desactiva.
    const quino = await newPerson(api, issuer, provider.ids, bruno, { email: 'quino-rev@example.test', role: 'admin', displayName: 'Quino', routeIds: [rRev] });
    assert.equal((await bruno('PUT', `/v1/routes/${rRev}/capital-controller`, { membershipId: quino.membershipId, reason: 'Pía deja la ruta' })).status, 200);
    assert.equal((await bruno('POST', `/v1/members/${sofia.membershipId}/deactivate`, {})).status, 200);
    const after = await reverse(money(caller(api, issuer, sofia.identityId, sofia.membershipId)), e2);
    assert.deepEqual([after.status, after.body['error']], [403, 'MEMBERSHIP_INACTIVE']);
  });

  test('REVX-015 · fallo antes del COMMIT: sin efectos parciales; el reintento con el mismo id anula una vez', async () => {
    const e = idOf(await workerExp(carlos.money, carlos.membershipId, 350));
    const failing = await startCompanyApi(db, issuer, provider, { beforeCommit: async (_c, path) => { if (path.endsWith('/reverse')) throw new Error('fallo simulado'); } });
    const snap = async () => ({ cash: await custody(carlos.membershipId), rows: await count(db.admin, 'select 1 from adex.expenses'),
      ops: await count(db.admin, 'select 1 from adex.capital_operations'), audit: await count(db.admin, 'select 1 from adex.audit_log'),
      idem: await count(db.admin, 'select 1 from adex.operations'), state: (await db.admin.query('select reversal_id from adex.expenses where id = $1', [e])).rows[0].reversal_id });
    const op = randomUUID();
    try {
      const before = await snap();
      const r = await reverse(money(caller(failing, issuer, 'ana', M.anaAdmin)), e, op);
      assert.deepEqual([r.status, r.body], [500, { error: 'INTERNAL' }]);
      assert.deepEqual(await snap(), before);
    } finally { await failing.close(); }
    assert.equal((await reverse($ana, e, op)).status, 201);
    assert.equal(await count(db.admin, 'select 1 from adex.expenses where reverses_id = $1', [e]), 1);
  });

  test('REVX-016 · respuesta perdida después del COMMIT: se recupera el resultado por su id; repetir no duplica', async () => {
    const e = idOf(await workerExp(carlos.money, carlos.membershipId, 450));
    const op = randomUUID();
    const token = await issuer.issue('ana');
    const body = JSON.stringify({ reason: 'Respuesta perdida' });
    await new Promise<void>((resolve) => {
      const req = http.request(`${api.base}/v1/expenses/${e}/reverse`, { method: 'POST', headers: {
        authorization: `Bearer ${token}`, 'x-adex-membership': M.anaAdmin, 'x-adex-operation-id': op,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
      req.on('error', () => resolve());
      req.end(body, () => setTimeout(() => { req.destroy(); resolve(); }, 2));
    });
    const retry = await $ana(`/v1/expenses/${e}/reverse`, { reason: 'Respuesta perdida' }, op);
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    const known = await caller(api, issuer, 'ana', M.anaAdmin)('GET', `/v1/operations/${op}`);
    assert.deepEqual([known.status, known.body['outcome'], known.body['httpStatus']], [200, 'approved', 201]);
    assert.deepEqual(known.body['result'], retry.body);
    assert.equal(await count(db.admin, 'select 1 from adex.expenses where reverses_id = $1', [e]), 1);
  });

  test('REVX-017/019 · conciliación, auditoría y gastos de bolsa (D12) sin cambios', async () => {
    // D12 conserva su regla: el Administrador anula los gastos de SU bolsa, aunque los registrara él.
    const p = idOf(await spend($ana, { scope: 'empresa', amountMinor: 2_000, description: 'Arriendo', fundingSource: 'admin', fundingAdminId: M.anaAdmin }));
    const before = await pool(M.anaAdmin);
    assert.equal((await reverse($ana, p)).status, 201);
    assert.equal(await pool(M.anaAdmin), before + 2_000);
    const n = await count(db.admin, `select 1 from adex.audit_log a join adex.expenses x on x.id = a.entity_id
                                      where a.action = 'MOVEMENT_REVERSED' and a.txid is not null and x.reversal_id is not null`);
    const reversed = await count(db.admin, `select 1 from adex.expenses where reversal_id is not null and ledger_operation_id is not null`);
    assert.equal(n, reversed, 'cada anulación tiene su auditoría en la misma transacción');
    const rec = (await bruno('GET', '/v1/capital/reconciliation')).body;
    assert.equal(rec['ok'], true, JSON.stringify(rec));
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    assert.deepEqual(api.errors, []);
  });
});
