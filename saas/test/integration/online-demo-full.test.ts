// ADEX ONLINE · Empresa Demo HISTÓRICA (demo-v2-6m) a ESCALA REAL contra PostgreSQL local
// (ensayo bajo demanda antes de inicializar la Demo de staging). La historia se registra día a día con la API
// normal y el reloj de inicialización de 0018: fechas contables pasadas, cierres
// semanales, cuadres, visitas, solicitudes en cada estado y conciliación del libro. Las
// personas asignadas heredan la historia de su puesto. Fuera del aprovisionamiento, el
// reloj simulado se ignora.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createTestDb, pgAvailable, type TestDb } from '../helpers/db.ts';
import { grantDemoOperator, person, startOnline, type Online } from '../helpers/online.ts';
import { companyId as seededCompany } from '../../db/seeds/synthetic.ts';

const SKIP = pgAvailable() ? false : 'requires real PostgreSQL (npm run test:db)';
type Body = Record<string, unknown>;
type Person = Awaited<ReturnType<typeof person>>;

// Ensayo a ESCALA REAL (182 días, escala 1) solo bajo demanda: ADEX_DEMO_FULL=1 npm run test:db -- online-demo-full
const FULL = process.env['ADEX_DEMO_FULL'] === '1' ? SKIP : 'solo con ADEX_DEMO_FULL=1';
describe('ADEX Online · Empresa Demo histórica (demo-v2-6m, escala real)', { skip: FULL }, () => {
  let db: TestDb;
  let online: Online;
  let operator: Person;
  const people: Record<string, Person> = {};
  const slot = 'principal';
  let demoId = '';
  const n = async (sql: string, p: unknown[] = [demoId]) => Number((await db.admin.query<{ n: string }>(sql, p)).rows[0]!.n);

  before(async () => {
    db = await createTestDb('demofull', { seed: true });
    online = await startOnline(db, { demo: { scenario: 'demo-v2-6m', historyDays: 182, historyScale: 1 } });
    operator = await person(online, 'operador-hist@example.test');
    await grantDemoOperator(db, operator.identityId, operator.email);
    for (const [seat, email] of [['superadmin-invitado', 'sa-hist'], ['admin-centro', 'admin-hist'], ['cobrador-centro', 'cob-hist'],
      ['supervisor-centro', 'sup-hist'], ['socio-invitado', 'socio-hist'], ['secretario-invitado', 'sec-hist']] as const) {
      const p = await person(online, `${email}@example.test`);
      people[seat] = p;
      const r = await online.call('PUT', `/demo/v1/slots/${slot}/participants/${seat}`, { token: operator.token, body: { email: p.email, displayName: email } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
  });
  after(async () => { await online?.close(); await db?.close(); });

  test('HIST-FULL-001 · crear: semanas de operación con fechas contables pasadas, mismo motor y conciliación OK', { timeout: 3_600_000 }, async () => {
    const r = await online.call('POST', `/demo/v1/slots/${slot}/create`, { token: operator.token, body: {} });
    assert.equal(r.status, 200, `${JSON.stringify(r.body)} · ${online.errors.map((e) => (e instanceof Error ? `${e.message} ${(e as { details?: unknown }).details ?? ''}` : String(e))).join(' | ')}`);
    demoId = r.body['companyId'] as string;
    const s = (await online.call('GET', `/demo/v1/slots/${slot}`, { token: operator.token })).body;
    assert.deepEqual([s['state'], s['scenario']], ['active', 'demo-v2-6m']);
    const created = (s['events'] as Body[]).find((e) => e['action'] === 'CREATE' && e['outcome'] === 'succeeded')!;
    assert.equal(((created['detail'] as Body)['reconciliation'] as Body)['ok'], true);
    const company = (await db.admin.query('select country_code, currency_code, timezone from adex.companies where id = $1', [demoId])).rows[0];
    assert.deepEqual(company, { country_code: 'CO', currency_code: 'COP', timezone: 'America/Bogota' });
    // Historia: cobros en muchos días distintos, el primero semanas atrás; la hora de registro es la real.
    const span = (await db.admin.query(`select min(payment_date)::text first, max(payment_date)::text last, count(distinct payment_date)::int days,
                                               bool_and(created_at > now() - interval '1 hour') fresh from adex.payments where company_id = $1`, [demoId])).rows[0];
    assert.ok(span.days >= 140, `cobros en ${span.days} días`);
    assert.ok(span.first < span.last && span.fresh === true, JSON.stringify(span));
    const today = (await db.admin.query(`select (now() at time zone 'America/Bogota')::date::text d`)).rows[0].d;
    assert.ok(span.last <= today);
    // Asientos del libro con su fecha contable pasada (no la de la inicialización).
    assert.ok(await n(`select count(distinct entry_date) n from adex.capital_operations where company_id = $1`) >= 12);
    // Cierres semanales, cuadres, visitas, gastos, solicitudes en cada estado.
    assert.ok(await n(`select count(*) n from adex.weekly_settlements where company_id = $1 and status = 'cerrada'`) >= 6);
    assert.ok(await n(`select count(*) n from adex.custody_settlements where company_id = $1`) >= 3);
    assert.ok(await n(`select count(*) n from adex.no_payment_visits where company_id = $1`) >= 1);
    assert.ok(await n(`select count(*) n from adex.expenses where company_id = $1`) >= 6);
    assert.ok(await n(`select count(*) n from adex.sale_requests where company_id = $1 and status = 'pending'`) >= 1);
    assert.equal(await n(`select count(*) n from adex.sale_requests where company_id = $1 and status = 'approved' and sale_id is null`), 1, 'una aprobada pendiente de desembolso');
    assert.ok(await n(`select count(*) n from adex.sales where company_id = $1 and disbursement_status = 'desembolsado'`) >= 8);
    // Ningún cierre se hizo antes de que terminara su semana (D29 con el reloj simulado).
    assert.equal(await n(`select count(*) n from adex.period_closures where company_id = $1 and business_date <= week_end`), 0);
    // Los clientes son ficticios (cédulas 99…).
    assert.equal(await n(`select count(*) n from adex.clients where company_id = $1 and document not like '99%'`), 0);
  });

  test('HIST-002 · las personas asignadas heredan la historia de su puesto; la auditoría guarda quién actuó', async () => {
    const memberships = async (p: Person) => ((await online.call('GET', '/v1/me/memberships', { token: p.token })).body['memberships'] as Body[])
      .filter((m) => (m['company'] as Body)['id'] === demoId);
    const cob = (await memberships(people['cobrador-centro']!))[0]!;
    assert.equal(cob['role'], 'cobrador');
    assert.ok(await n(`select count(*) n from adex.payments where company_id = $1 and collector_membership_id = $2`, [demoId, cob['membershipId']]) >= 3,
      'el Cobrador invitado ve SUS cobros históricos');
    const socio = (await memberships(people['socio-invitado']!))[0]!;
    const sec = (await memberships(people['secretario-invitado']!))[0]!;
    assert.deepEqual([socio['role'], sec['role']], ['socio', 'secretario']);
    // La historia la registró la identidad sintética del puesto, no la persona.
    const actors = await db.admin.query(`select distinct a.actor_identity_id from adex.audit_log a where a.company_id = $1 and a.actor_membership_id = $2`, [demoId, cob['membershipId']]);
    assert.ok(actors.rows.length >= 1);
    assert.ok(actors.rows.every((r) => r.actor_identity_id !== people['cobrador-centro']!.identityId));
  });

  test('HIST-003 · fuera del aprovisionamiento el reloj simulado se ignora (Demo activa y empresa normal)', async () => {
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('adex.seed_today', '2026-01-05', true)`);
      const real = (await c.query(`select (now() at time zone 'America/Bogota')::date::text d`)).rows[0].d;
      const demo = (await c.query('select adex.business_today($1)::text d', [demoId])).rows[0].d;
      const normal = (await c.query('select adex.business_today($1)::text d', [seededCompany('c1')])).rows[0].d;
      const tz = (await c.query(`select (now() at time zone timezone)::date::text d from adex.companies where id = $1`, [seededCompany('c1')])).rows[0].d;
      assert.equal(demo, real, 'Demo ya activa: fecha real');
      assert.equal(normal, tz, 'empresa normal: fecha real');
      await c.query('rollback');
    } finally { c.release(); }
  });
});
