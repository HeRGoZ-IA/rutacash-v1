// ADEX ONLINE v1 · Empresa Demo administrable y circuito entre dos sesiones, contra
// PostgreSQL REAL (0001–0011) y el servidor compuesto real (CORS, límites, registros).
//
//   DEMO-001…   plano Demo: autoridad propia, aislamiento de roles de base de datos
//   DEMO-010…   crear, escenario con el motor normal, conciliación, participantes
//   ONL-020…    dos sesiones independientes: capital → solicitud → aprobación → desembolso
//   DEMO-030…   reinicio repetido, eliminación, recreación, sin residuos
//   DEMO-040…   bloqueo de operaciones concurrentes, operaciones en curso, fallo y recuperación
//   DEMO-050…   protección de empresas normales y auditoría administrativa persistente

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from '../../src/db/pgTypes.ts';
import { createTestDb, pgAvailable, type TestDb } from '../helpers/db.ts';
import { grantDemoOperator, op, person, startOnline, ORIGIN, type Online } from '../helpers/online.ts';
import { companyId as seededCompany } from '../../db/seeds/synthetic.ts';

const SKIP = pgAvailable() ? false : 'requires real PostgreSQL (npm run test:db)';
type Body = Record<string, unknown>;
type Person = Awaited<ReturnType<typeof person>>;

describe('ADEX Online v1 · Empresa Demo y circuito en línea', { skip: SKIP }, () => {
  let db: TestDb;
  let online: Online;
  let operator: Person;
  let owner: Person;
  let partner: Person;
  let stranger: Person;
  const slot = 'principal';
  let demoId = '';
  const companies: string[] = [];

  const status = async () => (await online.call('GET', `/demo/v1/slots/${slot}`, { token: operator.token })).body;
  const memberships = async (p: Person) => ((await online.call('GET', '/v1/me/memberships', { token: p.token })).body['memberships'] as Body[]);
  const seat = async (p: Person, role: string) => {
    const m = (await memberships(p)).find((x) => (x['company'] as Body)['isDemo'] === true && x['role'] === role);
    assert.ok(m, `${p.email} has a ${role} membership in the live demo`);
    return m['membershipId'] as string;
  };
  const as = (p: Person, membership: string) => ({
    get: (path: string) => online.call('GET', path, { token: p.token, membership }),
    post: (path: string, body: Body = {}, operation?: string) => online.call('POST', path, { token: p.token, membership, body, op: operation }),
  });

  before(async () => {
    db = await createTestDb('online', { seed: true });
    online = await startOnline(db);
    operator = await person(online, 'operador-demo@example.test');
    owner = await person(online, 'propietario@example.test');
    partner = await person(online, 'socio@example.test');
    stranger = await person(online, 'ajeno@example.test');
    await grantDemoOperator(db, operator.identityId, operator.email);
  });
  after(async () => { await online?.close(); await db?.close(); });

  // ---------------------------------------------------------------- plano Demo
  test('DEMO-001 · solo un operador Demo administra; ni el Owner ni la API de empresa pueden', async () => {
    for (const p of [owner, stranger]) {
      const r = await online.call('GET', `/demo/v1/slots/${slot}`, { token: p.token });
      assert.equal(r.status, 403);
      assert.equal(r.body['error'], 'DEMO_OPERATOR_REQUIRED');
    }
    assert.equal((await online.call('GET', `/demo/v1/slots/${slot}`)).status, 401);
    // Un Owner del plano de control no es operador Demo.
    const owners = await db.admin.query<{ identity_id: string }>('select identity_id from adex_control.platform_operators limit 1');
    if (owners.rows[0]) {
      const t = await online.issuer.issue(owners.rows[0].identity_id);
      assert.equal((await online.call('GET', `/demo/v1/slots/${slot}`, { token: t })).status, 403);
    }
    // Roles de base de datos: ni adex_api ni adex_control ejecutan el ciclo de vida; adex_demo no lee tablas.
    for (const pool of [db.api, db.control]) {
      await assert.rejects(pool.query(`select adex_demo.delete_company('principal', 'x')`), /permission denied/);
    }
    await assert.rejects(db.demo.query('select * from adex.companies limit 1'), /permission denied/);
    await assert.rejects(db.demo.query('select * from adex_demo.events limit 1'), /permission denied/);
    await assert.rejects(db.demo.query(`select adex_demo.provision_company('principal','x','x','BR','Brasil','BRL','America/Sao_Paulo','v','[]')`), /permission denied/);
    // Sin sesión de operador las funciones del plano Demo fallan cerradas.
    await assert.rejects(db.demo.query(`select adex_demo.status('principal')`), /no active demo operator/);
  });

  test('DEMO-002 · participantes por invitación (sin contraseña) y validación de puestos', async () => {
    const put = (seatName: string, p: Person, displayName: string) =>
      online.call('PUT', `/demo/v1/slots/${slot}/participants/${seatName}`, { token: operator.token, body: { email: p.email, displayName } });
    assert.equal((await put('direccion', owner, 'X')).body['error'], 'SEAT_NOT_ASSIGNABLE');
    for (const [s, p, n] of [['superadmin-invitado', owner, 'Propietario'], ['admin-centro', owner, 'Propietario'],
      ['cobrador-centro', partner, 'Socio'], ['supervisor-centro', partner, 'Socio']] as const) {
      const r = await put(s, p, n);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    // Una persona no ocupa dos puestos del mismo rol en la misma empresa (DS-05).
    const dup = await online.call('PUT', `/demo/v1/slots/${slot}/participants/superadmin-invitado`, { token: operator.token, body: { email: partner.email, displayName: 'Socio' } });
    assert.equal(dup.status, 200);
    const back = await put('superadmin-invitado', owner, 'Propietario');
    assert.equal(back.status, 200);
    const s = await status();
    assert.equal((s['participants'] as unknown[]).length, 4);
  });

  // ---------------------------------------------------------------- crear
  test('DEMO-010 · crear: empresa Demo real, escenario con el motor normal y conciliación', async () => {
    assert.equal((await status())['state'], 'empty');
    const r = await online.call('POST', `/demo/v1/slots/${slot}/create`, { token: operator.token, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    demoId = r.body['companyId'] as string;
    companies.push(demoId);
    const s = await status();
    assert.equal(s['state'], 'active');
    assert.equal((s['company'] as Body)['id'], demoId);
    assert.equal((s['company'] as Body)['operable'], true);
    // El escenario pasó por los mismos comandos: libro, créditos y auditoría reales.
    const n = async (sql: string) => Number((await db.admin.query<{ n: string }>(sql, [demoId])).rows[0]!.n);
    assert.equal(await n('select count(*) n from adex.clients where company_id = $1'), 8);
    assert.equal(await n('select count(*) n from adex.sale_requests where company_id = $1'), 4);
    assert.equal(await n(`select count(*) n from adex.sales where company_id = $1 and disbursement_status = 'desembolsado'`), 1);
    assert.equal(await n('select coalesce(sum(balance_minor), 0) n from adex.capital_accounts where company_id = $1'), 0);
    assert.ok(await n(`select count(*) n from adex.audit_log where company_id = $1 and action = 'CONFIRM_DISBURSEMENT'`) === 1);
    assert.equal(await n('select count(*) n from adex.companies where id = $1 and is_demo and retired_at is null'), 1);
    // Los clientes son ficticios (prefijo de documento 999, nombres de ejemplo).
    assert.equal(await n(`select count(*) n from adex.clients where company_id = $1 and document not like '999.%'`), 0);
    // Los puestos de personas no actuaron en el escenario: ninguna entrada de auditoría a su nombre.
    assert.equal(await n(`select count(*) n from adex.audit_log a join adex_demo.seats s on s.company_id = a.company_id and s.membership_id = a.actor_membership_id
                           where a.company_id = $1 and s.assignable`), 0);
    const events = s['events'] as Body[];
    const created = events.find((e) => e['action'] === 'CREATE' && e['outcome'] === 'succeeded');
    assert.ok(created);
    assert.equal(((created['detail'] as Body)['reconciliation'] as Body)['ok'], true);
  });

  test('DEMO-011 · personas: ven la Demo (marcada) solo con sus membresías; las sintéticas no inician sesión', async () => {
    const mine = await memberships(owner);
    assert.deepEqual(mine.filter((m) => (m['company'] as Body)['isDemo']).map((m) => m['role']).sort(), ['admin', 'superadmin']);
    const theirs = await memberships(partner);
    assert.deepEqual(theirs.filter((m) => (m['company'] as Body)['isDemo']).map((m) => m['role']).sort(), ['cobrador', 'supervisor']);
    // Sin membresías la identidad ni siquiera está aprovisionada en ADEX: nada que listar.
    const none = await online.call('GET', '/v1/me/memberships', { token: stranger.token });
    assert.equal(none.status, 403);
    assert.equal(none.body['error'], 'IDENTITY_NOT_PROVISIONED');
    // Marcadores sustituidos: desactivados. Identidades sintéticas sin cuenta en el proveedor.
    const disabled = await db.admin.query<{ n: string }>(
      `select count(*) n from adex_demo.seats s join adex.identities i on i.id = s.placeholder_identity_id where s.company_id = $1 and not s.synthetic and i.status = 'disabled'`, [demoId]);
    assert.equal(Number(disabled.rows[0]!.n), 4);
    const synthetic = await db.admin.query<{ email: string }>(`select i.email from adex_demo.seats s join adex.identities i on i.id = s.identity_id where s.company_id = $1 and s.synthetic`, [demoId]);
    for (const r of synthetic.rows) assert.ok(!online.provider.ids.has(r.email), 'synthetic identity has no provider account');
  });

  // ---------------------------------------------------------------- dos sesiones
  test('ONL-020 · dos sesiones independientes comparten los mismos registros: capital → solicitud → aprobación → desembolso', async () => {
    const ownerAdmin = as(owner, await seat(owner, 'admin'));
    const ownerSa = as(owner, await seat(owner, 'superadmin'));
    const partnerCob = as(partner, await seat(partner, 'cobrador'));
    const partnerSup = as(partner, await seat(partner, 'supervisor'));
    const routes = ((await ownerAdmin.get('/v1/routes')).body['routes'] as Body[]);
    const centro = routes.find((r) => String(r['name']).startsWith('Ruta Centro'))!;
    assert.ok(centro, 'admin sees Ruta Centro');
    const cobradorId = await seat(partner, 'cobrador');

    // 1. Bolsa del Administrador (solo la suya) y entrega anticipada al Cobrador.
    const pool = (await ownerAdmin.get('/v1/capital/summary')).body;
    assert.equal((pool['admins'] as Body[]).length, 1);
    assert.equal(pool['company'], undefined, 'an Administrator never sees the company position');
    const delivery = await ownerAdmin.post('/v1/capital/deliveries', { routeId: centro['id'], workerId: cobradorId, amountMinor: 300_000, reason: 'Capital del día' }, op());
    assert.equal(delivery.status, 201, JSON.stringify(delivery.body));

    // 2. El Cobrador ve la entrega en SU custodia (y nada de bolsas).
    const custody = (await partnerCob.get('/v1/capital/custody')).body['positions'] as Body[];
    assert.deepEqual(custody.map((p) => [p['routeId'], p['balanceMinor']]), [[centro['id'], 300_000]]);
    assert.equal((await partnerCob.get('/v1/capital/summary')).status, 403, 'no private pools for the Cobrador');
    assert.equal((await partnerCob.get('/v1/capital/reconciliation')).status, 403);

    // 3. El Cobrador solicita un crédito para un cliente ficticio de su ruta.
    const clients = (await partnerCob.get('/v1/clients')).body['clients'] as Body[];
    assert.ok(clients.length >= 4 && clients.every((c) => c['routeId'] === centro['id']));
    const target = clients.find((c) => c['name'] === 'Fábio Inventado Reis')!;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const created = await partnerCob.post('/v1/credit-requests', { routeId: centro['id'], clientId: target['id'], amountMinor: 120_000, interestRate: 20,
      installmentsCount: 20, frequency: 'diaria', startDate: today, paymentDays: [1, 2, 3, 4, 5, 6] }, op());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const requestId = created.body['id'] as string;

    // Protección contra autoaprobación: la misma persona con OTRA membresía (Supervisor) no aprueba.
    const self = await partnerSup.post(`/v1/credit-requests/${requestId}/approve`, {});
    assert.equal(self.status, 403);
    assert.equal(self.body['error'], 'SELF_APPROVAL_FORBIDDEN');

    // 4. El propietario (Administrador) la ve en su bandeja y la aprueba con condiciones.
    const inbox = (await ownerAdmin.get('/v1/credit-requests?status=pending')).body['requests'] as Body[];
    assert.ok(inbox.some((r) => r['id'] === requestId));
    const approved = await ownerAdmin.post(`/v1/credit-requests/${requestId}/approve`, { notes: 'Aprobada en la demo' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body['status'], 'approved');

    // 5. El Cobrador confirma el desembolso. Respuesta «perdida»: se consulta por id antes de repetir.
    const disburseOp = op();
    const missing = await partnerCob.get(`/v1/operations/${op()}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body['error'], 'OPERATION_NOT_FOUND');
    const disbursed = await partnerCob.post(`/v1/credit-requests/${requestId}/disburse`, {}, disburseOp);
    assert.equal(disbursed.status, 201, JSON.stringify(disbursed.body));
    const outcome = await partnerCob.get(`/v1/operations/${disburseOp}`);
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body['httpStatus'], 201);
    assert.deepEqual(outcome.body['result'], disbursed.body);
    const retry = await partnerCob.post(`/v1/credit-requests/${requestId}/disburse`, {}, disburseOp);
    assert.equal(retry.status, 201);
    assert.deepEqual(retry.body, disbursed.body, 'a retry with the same id never disburses twice');
    // La operación de otra membresía no se puede consultar.
    assert.equal((await ownerAdmin.get(`/v1/operations/${disburseOp}`)).status, 404);

    // 6. Ambas sesiones ven el mismo estado central.
    const fromOwner = (await ownerAdmin.get(`/v1/credit-requests/${requestId}`)).body;
    const fromPartner = (await partnerCob.get(`/v1/credit-requests/${requestId}`)).body;
    assert.equal(fromOwner['status'], 'disbursed');
    assert.equal(fromPartner['status'], 'disbursed');
    assert.equal(fromOwner['saleId'], fromPartner['saleId']);
    const credit = (await ownerAdmin.get(`/v1/credits/${fromOwner['saleId']}`)).body;
    assert.equal((credit['credit'] as Body)['id'], fromOwner['saleId']);
    assert.equal((credit['credit'] as Body)['saleValueMinor'], 120_000);
    assert.equal((credit['installments'] as unknown[]).length, 20);
    const afterCustody = (await partnerCob.get('/v1/capital/custody')).body['positions'] as Body[];
    assert.equal(afterCustody[0]!['balanceMinor'], 180_000);
    const ops = (await ownerAdmin.get(`/v1/capital/operations?routeId=${centro['id']}`)).body['operations'] as Body[];
    assert.ok(ops.some((o) => o['kind'] === 'LOAN_DISBURSEMENT'));
    // Conciliación del libro con el SuperAdmin invitado.
    const rec = (await ownerSa.get('/v1/capital/reconciliation')).body;
    assert.equal(rec['ok'], true, JSON.stringify(rec));
    // Ninguna escritura financiera directa: la API no tiene privilegios de tabla sobre el libro.
    await assert.rejects(db.api.query(`insert into adex.capital_operations (id) values ('x')`), /permission denied/);
    assert.deepEqual(online.errors, []);
  });

  test('ONL-021 · aislamiento: la Demo no ve otras empresas y otra empresa no ve la Demo', async () => {
    const ownerSa = as(owner, await seat(owner, 'superadmin'));
    const clients = (await ownerSa.get('/v1/clients')).body['clients'] as Body[];
    const ids = new Set((await db.admin.query<{ id: string }>('select id from adex.clients where company_id = $1', [demoId])).rows.map((r) => r.id));
    assert.ok(clients.length > 0 && clients.every((c) => ids.has(c['id'] as string)));
    // Membresía ajena (de una empresa sembrada) en la cabecera: indistinguible de inexistente.
    const foreign = (await db.admin.query<{ id: string }>('select id from adex.memberships where company_id = $1 limit 1', [seededCompany('c1')])).rows[0]!.id;
    const r = await online.call('GET', '/v1/clients', { token: owner.token, membership: foreign });
    assert.equal(r.status, 403);
    assert.equal(r.body['error'], 'MEMBERSHIP_NOT_FOUND');
  });

  // ---------------------------------------------------------------- reiniciar
  test('DEMO-030 · reiniciar: exige el ID interno confirmado; recrea con otra identidad y retira la anterior', async () => {
    const reset = (body: Body) => online.call('POST', `/demo/v1/slots/${slot}/reset`, { token: operator.token, body });
    assert.equal((await reset({ companyId: demoId })).body['error'], 'CONFIRMATION_MISMATCH');
    assert.equal((await reset({ name: 'Empresa Demo ADEX' })).body['error'], 'COMPANY_ID_REQUIRED');
    const wrong = seededCompany('c1');
    const w = await reset({ companyId: wrong, confirm: wrong });
    // Ids de empresas sembradas no tienen forma de UUID → 400; con un UUID ajeno → 409.
    assert.ok(w.status === 400 || w.status === 409);
    const foreignUuid = '00000000-0000-4000-8000-000000000000';
    assert.equal((await reset({ companyId: foreignUuid, confirm: foreignUuid })).body['error'], 'DEMO_TARGET_MISMATCH');

    const oldAdmin = await seat(owner, 'admin');
    const r = await reset({ companyId: demoId, confirm: demoId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const next = r.body['companyId'] as string;
    assert.notEqual(next, demoId);
    assert.equal(r.body['previousCompanyId'], demoId);
    // Contexto anterior invalidado: la empresa retirada rechaza toda operación…
    const stale = await online.call('GET', '/v1/routes', { token: owner.token, membership: oldAdmin });
    assert.equal(stale.status, 403);
    // …y desaparece del selector; la nueva aparece. Las identidades siguen intactas.
    const listed = (await memberships(owner)).filter((m) => (m['company'] as Body)['isDemo']);
    assert.deepEqual([...new Set(listed.map((m) => (m['company'] as Body)['id']))], [next]);
    const ids = await db.admin.query<{ status: string }>('select status from adex.identities where id = any($1)', [[owner.identityId, partner.identityId]]);
    assert.deepEqual(ids.rows.map((x) => x.status), ['active', 'active']);
    // La retirada es definitiva y el escenario vuelve a la versión conocida.
    const old = (await db.admin.query<{ status: string; retired_at: Date | null }>('select status, retired_at from adex.companies where id = $1', [demoId])).rows[0]!;
    assert.equal(old.status, 'suspendida');
    assert.ok(old.retired_at);
    const pending = await db.admin.query<{ n: string }>(`select count(*) n from adex.sale_requests where company_id = $1`, [next]);
    assert.equal(Number(pending.rows[0]!.n), 4, 'fresh scenario: the requests of the previous demo are not carried over');
    demoId = next;
    companies.push(next);
  });

  test('DEMO-031 · reinicio repetido (3 veces): siempre cuadra, sin residuos ni referencias huérfanas', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await online.call('POST', `/demo/v1/slots/${slot}/reset`, { token: operator.token, body: { companyId: demoId, confirm: demoId } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      demoId = r.body['companyId'] as string;
      companies.push(demoId);
    }
    const s = await status();
    assert.equal((s['company'] as Body)['id'], demoId);
    assert.equal(Number(s['retiredCount']), companies.length - 1);
    // Cada empresa (vigente o retirada) conserva su libro cuadrado y completo.
    for (const id of companies) {
      const q = async (sql: string) => Number((await db.admin.query<{ n: string }>(sql, [id])).rows[0]!.n);
      assert.equal(await q('select coalesce(sum(balance_minor), 0) n from adex.capital_accounts where company_id = $1'), 0, `conservation ${id}`);
      assert.equal(await q(`select count(*) n from adex.capital_accounts a where a.company_id = $1 and a.balance_minor <> coalesce(
        (select sum(e.amount_minor) from adex.capital_entries e where e.company_id = a.company_id and e.account_id = a.id), 0)`), 0);
      assert.equal(await q(`select count(*) n from adex.sales s where s.company_id = $1 and not exists (
        select 1 from adex.capital_operations o where o.company_id = s.company_id and o.id = s.ledger_operation_id)`), 0);
    }
    // Sin cruces entre empresas: ninguna fila de la Demo vigente apunta a otra empresa (FK compuestas).
    const crossed = await db.admin.query<{ n: string }>(
      `select count(*) n from adex.membership_routes mr join adex.memberships m on m.id = mr.membership_id where mr.company_id = $1 and m.company_id <> $1`, [demoId]);
    assert.equal(Number(crossed.rows[0]!.n), 0);
    // Exactamente una Demo viva por hueco.
    const live = await db.admin.query<{ n: string }>(`select count(*) n from adex.companies where is_demo and retired_at is null`);
    assert.equal(Number(live.rows[0]!.n), 1);
  });

  // ---------------------------------------------------------------- concurrencia
  test('DEMO-040 · durante un reinicio: otro reinicio o eliminación → DEMO_BUSY; operaciones sobre la Demo vieja → bloqueadas', async () => {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const atStep = new Promise<void>((r) => { reached = r; });
    const local = await startOnline(db, { demo: { onScenarioStep: async (call) => { if (call.path === '/v1/capital/company/deposits') { reached(); await gate; } } } });
    try {
      const tok = await local.issuer.issue(operator.identityId);
      const ownerTok = await local.issuer.issue(owner.identityId);
      const oldAdmin = (await (await local.call('GET', '/v1/me/memberships', { token: ownerTok })).body['memberships'] as Body[])
        .find((m) => (m['company'] as Body)['isDemo'] && m['role'] === 'admin')!['membershipId'] as string;
      const running = local.call('POST', `/demo/v1/slots/${slot}/reset`, { token: tok, body: { companyId: demoId, confirm: demoId } });
      await atStep;
      const second = await local.call('POST', `/demo/v1/slots/${slot}/reset`, { token: tok, body: { companyId: demoId, confirm: demoId } });
      assert.equal(second.body['error'], 'DEMO_BUSY');
      const del = await local.call('POST', `/demo/v1/slots/${slot}/delete`, { token: tok, body: { companyId: demoId, confirm: demoId } });
      assert.equal(del.body['error'], 'DEMO_BUSY');
      const create = await local.call('POST', `/demo/v1/slots/${slot}/create`, { token: tok, body: {} });
      assert.equal(create.body['error'], 'DEMO_BUSY');
      const blocked = await local.call('GET', '/v1/routes', { token: ownerTok, membership: oldAdmin });
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body['error'], 'COMPANY_BLOCKED');
      const st = (await local.call('GET', `/demo/v1/slots/${slot}`, { token: tok })).body;
      assert.equal(st['state'], 'resetting');
      assert.equal(st['jobRunning'], true);
      release();
      const r = await running;
      assert.equal(r.status, 200, JSON.stringify(r.body));
      demoId = r.body['companyId'] as string;
      companies.push(demoId);
      const rejected = ((await local.call('GET', `/demo/v1/slots/${slot}`, { token: tok })).body['events'] as Body[])
        .filter((e) => e['outcome'] === 'rejected').map((e) => e['action']);
      assert.ok(['RESET', 'DELETE', 'CREATE'].every((a) => rejected.includes(a)), 'rejections are audited');
    } finally {
      release();
      await local.close();
    }
  });

  test('DEMO-041 · una operación en curso termina antes de congelar; las siguientes se rechazan', async () => {
    let release!: () => void;
    let inside!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { inside = r; });
    const local = await startOnline(db, { company: { afterContext: async (_ctx, path) => { if (path === '/v1/capital/deliveries') { inside(); await gate; } } } });
    try {
      const tok = await local.issuer.issue(operator.identityId);
      const ownerTok = await local.issuer.issue(owner.identityId);
      const partnerTok = await local.issuer.issue(partner.identityId);
      const mine = (await local.call('GET', '/v1/me/memberships', { token: ownerTok })).body['memberships'] as Body[];
      const admin = mine.find((m) => (m['company'] as Body)['isDemo'] && m['role'] === 'admin')!['membershipId'] as string;
      const cob = ((await local.call('GET', '/v1/me/memberships', { token: partnerTok })).body['memberships'] as Body[])
        .find((m) => (m['company'] as Body)['isDemo'] && m['role'] === 'cobrador')!['membershipId'] as string;
      const centro = ((await local.call('GET', '/v1/routes', { token: ownerTok, membership: admin })).body['routes'] as Body[])
        .find((r) => String(r['name']).startsWith('Ruta Centro'))!['id'];
      const inflight = local.call('POST', '/v1/capital/deliveries', { token: ownerTok, membership: admin, op: op(),
        body: { routeId: centro, workerId: cob, amountMinor: 10_000, reason: 'En curso' } });
      await entered;
      const reset = local.call('POST', `/demo/v1/slots/${slot}/reset`, { token: tok, body: { companyId: demoId, confirm: demoId, wait: false } });
      await new Promise((r) => setTimeout(r, 300));
      release();
      const done = await inflight;
      assert.equal(done.status, 201, 'the in-flight operation commits before the freeze');
      const started = await reset;
      assert.equal(started.status, 202);
      const after = await local.call('POST', '/v1/capital/deliveries', { token: ownerTok, membership: admin, op: op(),
        body: { routeId: centro, workerId: cob, amountMinor: 10_000, reason: 'Tarde' } });
      assert.equal(after.status, 403, 'operations after the freeze are rejected');
      // Espera a que el reinicio en segundo plano termine.
      for (let i = 0; i < 200; i++) {
        const st = (await local.call('GET', `/demo/v1/slots/${slot}`, { token: tok })).body;
        if (st['state'] === 'active' && !st['jobRunning']) { demoId = (st['company'] as Body)['id'] as string; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(started.body['companyId'], demoId);
      companies.push(demoId);
    } finally {
      release();
      await local.close();
    }
  });

  test('DEMO-042 · fallo durante el escenario: la Demo nueva se retira y la anterior sigue intacta', async () => {
    const local = await startOnline(db, { demo: { onScenarioStep: async (call) => { if (call.path === '/v1/capital/allocations') throw new Error('fallo simulado'); } } });
    try {
      const tok = await local.issuer.issue(operator.identityId);
      const r = await local.call('POST', `/demo/v1/slots/${slot}/reset`, { token: tok, body: { companyId: demoId, confirm: demoId } });
      assert.equal(r.status, 500);
      assert.equal(r.body['error'], 'DEMO_PROVISIONING_FAILED');
      const st = (await local.call('GET', `/demo/v1/slots/${slot}`, { token: tok })).body;
      assert.equal(st['state'], 'active');
      assert.equal((st['company'] as Body)['id'], demoId, 'the previous demo is restored');
      assert.equal((st['company'] as Body)['operable'], true);
      const failed = await db.admin.query<{ n: string }>(`select count(*) n from adex_demo.companies where state = 'failed'`);
      assert.equal(Number(failed.rows[0]!.n), 1);
      const ownerTok = await local.issuer.issue(owner.identityId);
      const live = ((await local.call('GET', '/v1/me/memberships', { token: ownerTok })).body['memberships'] as Body[]).filter((m) => (m['company'] as Body)['isDemo']);
      assert.ok(live.every((m) => (m['company'] as Body)['id'] === demoId && (m['company'] as Body)['operable'] === true));
    } finally {
      await local.close();
    }
  });

  // ---------------------------------------------------------------- eliminar y recrear
  test('DEMO-032 · eliminar y recrear: sin la anterior, con identidad nueva y los mismos participantes', async () => {
    const del = await online.call('POST', `/demo/v1/slots/${slot}/delete`, { token: operator.token, body: { companyId: demoId, confirm: demoId } });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal((await status())['state'], 'empty');
    assert.deepEqual((await memberships(owner)).filter((m) => (m['company'] as Body)['isDemo']), []);
    const again = await online.call('POST', `/demo/v1/slots/${slot}/delete`, { token: operator.token, body: { companyId: demoId, confirm: demoId } });
    assert.equal(again.body['error'], 'DEMO_BUSY');
    const r = await online.call('POST', `/demo/v1/slots/${slot}/create`, { token: operator.token, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!companies.includes(r.body['companyId'] as string));
    demoId = r.body['companyId'] as string;
    companies.push(demoId);
    assert.equal((await memberships(partner)).filter((m) => (m['company'] as Body)['isDemo']).length, 2);
  });

  // ---------------------------------------------------------------- protección y auditoría
  test('DEMO-050 · empresas normales: ni reinicio, ni eliminación, ni marca Demo; una Demo retirada no se reactiva', async () => {
    const normal = seededCompany('c1');
    // El ciclo de vida solo actúa sobre la Demo vigente del hueco (ID exacto).
    const c = await db.demo.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('adex.identity_id', $1, true), set_config('adex.session_id', gen_random_uuid()::text, true),
                            set_config('adex.token_iat', extract(epoch from now())::bigint::text, true)`, [operator.identityId]);
      await assert.rejects(c.query('select adex_demo.delete_company($1, $2)', [slot, normal]), /target is not the live demo/);
      await c.query('rollback');
    } finally { c.release(); }
    // Nadie marca una empresa normal como Demo ni la retira.
    const a = await db.admin.connect();
    try {
      await a.query('begin');
      await a.query('set local role adex_owner');
      await assert.rejects(a.query('update adex.companies set is_demo = true where id = $1', [normal]), /is_demo is immutable/);
      await a.query('rollback');
      await a.query('begin');
      await a.query('set local role adex_owner');
      await assert.rejects(a.query(`update adex.companies set retired_at = now(), status = 'suspendida' where id = $1`, [normal]), /companies_retired_only_demo|retired/);
      await a.query('rollback');
      // Una Demo retirada es definitiva, incluso para el dueño del esquema con la marca del ciclo de vida.
      await a.query('begin');
      await a.query('set local role adex_owner');
      await a.query(`select set_config('adex_demo.lifecycle', 'on', true)`);
      await assert.rejects(a.query(`update adex.companies set status = 'activa' where id = $1`, [companies[0]]), /retired demo company is final/);
      await a.query('rollback');
      // Una Demo viva no cambia de estado fuera del ciclo de vida (p. ej. desde el plano Owner).
      await a.query('begin');
      await a.query('set local role adex_owner');
      await assert.rejects(a.query(`update adex.companies set status = 'suspendida' where id = $1`, [demoId]), /only through the demo lifecycle/);
      await a.query('rollback');
      // Crear una empresa Demo fuera del ciclo de vida: imposible.
      await a.query('begin');
      await a.query('set local role adex_owner');
      await assert.rejects(a.query(`insert into adex.companies (id, name, email, plan, status, country_code, country_label, currency_code, timezone, is_demo, created_at, updated_at)
        values ('fake-demo', 'X', 'x@example.test', 'basico', 'activa', 'BR', 'Brasil', 'BRL', 'America/Sao_Paulo', true, now(), now())`), /only by the demo lifecycle/);
      await a.query('rollback');
    } finally { a.release(); }
    // Ningún borrado físico: el libro de la Demo sigue siendo inmutable.
    await assert.rejects(db.admin.query('delete from adex.capital_entries where company_id = $1', [companies[0]]), /immutable/);
    // La API de empresa no puede escribir las columnas del ciclo de vida.
    await assert.rejects(db.api.query('update adex.companies set is_demo = false'), /permission denied/);
  });

  test('DEMO-051 · auditoría administrativa externa y solo de añadido', async () => {
    const events = (await db.admin.query<{ action: string; outcome: string; company_id: string | null }>(
      'select action, outcome, company_id from adex_demo.events order by id')).rows;
    const ok = (action: string) => events.filter((e) => e.action === action && e.outcome === 'succeeded').length;
    assert.ok(ok('CREATE') >= 2 && ok('RESET') >= 5 && ok('DELETE') >= 1 && ok('SET_PARTICIPANT') >= 4);
    assert.ok(events.some((e) => e.outcome === 'failed'));
    // Sobrevive a la retirada de la empresa: eventos de empresas ya retiradas siguen ahí.
    assert.ok(events.some((e) => e.company_id === companies[0]));
    await assert.rejects(db.admin.query('delete from adex_demo.events'), /not allowed/);
    await assert.rejects(db.admin.query(`update adex_demo.events set outcome = 'failed'`), /not allowed/);
    await assert.rejects(db.admin.query('truncate adex_demo.events'), /not allowed/);
  });

  // ---------------------------------------------------------------- servidor
  test('ONL-060 · CORS solo para el origen configurado, cabeceras de seguridad y registros sin datos', async () => {
    const pre = await fetch(`${online.base}/v1/routes`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /x-adex-operation-id/);
    const evil = await fetch(`${online.base}/v1/routes`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const evilGet = await online.call('GET', '/v1/me/memberships', { token: owner.token, headers: { origin: 'https://evil.example' } });
    assert.equal(evilGet.status, 403);
    const okGet = await online.call('GET', '/v1/me/memberships', { token: owner.token, headers: { origin: ORIGIN } });
    assert.equal(okGet.status, 200);
    assert.equal(okGet.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(okGet.headers.get('strict-transport-security') ?? '', /max-age=/);
    assert.equal(okGet.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await online.call('GET', '/healthz')).body['status'], 'ok');
    assert.equal((await online.call('GET', '/readyz')).body['status'], 'ready');
    assert.equal((await online.call('GET', '/control/v1/companies', { token: owner.token })).status, 404, 'the Owner API is not published');
    const text = JSON.stringify(online.logs);
    for (const secret of [owner.token, partner.token, operator.token, owner.email, 'Fábio', demoId]) assert.ok(!text.includes(secret), 'logs carry no tokens, e-mails, names or ids');
    assert.ok(online.logs.every((l) => Object.keys(l).sort().join() === 'id,m,ms,r,s,t'));
  });

  test('ONL-062 · viajes a la base por petición: contexto en uno solo (0012)', async () => {
    const sa = await seat(owner, 'superadmin');
    const proto = pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
    const original = proto.query;
    let n = 0;
    proto.query = function (this: unknown, ...a: unknown[]) { n++; return original.apply(this, a); };
    try {
      const counts: Record<string, number> = {};
      for (const path of ['/v1/capital/summary', '/v1/routes', '/v1/credit-requests?status=pending']) {
        n = 0;
        const r = await online.call('GET', path, { token: owner.token, membership: sa });
        assert.equal(r.status, 200);
        counts[path] = n;
      }
      // begin+lock_timeout (1) + contexto (1) + consultas del comando + commit (1).
      for (const [path, c] of Object.entries(counts)) assert.ok(c <= 6, `${path}: ${c} round trips`);
    } finally {
      proto.query = original;
    }
  });

  test('ONL-061 · límite de peticiones por IP y por token', async () => {
    const local = await startOnline(db, { rateLimit: { perIpPerMinute: 1000, perTokenPerMinute: 5 } });
    try {
      const t = await local.issuer.issue(owner.identityId);
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await local.call('GET', '/v1/me/memberships', { token: t })).status);
      assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
    } finally { await local.close(); }
  });
});
