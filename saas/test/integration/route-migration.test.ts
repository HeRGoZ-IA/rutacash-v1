// 0043 · Migración de rutas con historial, parte 1: estado «en migración» por ruta (decisiones de Helmer 2026-11-04),
// contra PostgreSQL real y la API (datos 100 % sintéticos).
//   · Solo el SuperAdmin abre y cancela; solo sobre una ruta activa, vacía y con Base por Ruta.
//   · En migración la ruta es de solo lectura (bloqueo en PostgreSQL); el resto de la empresa sigue igual.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf, routeId } from '../../db/seeds/synthetic.ts';
import { asApi, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('0043 · ruta en migración', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const [r1, r3] = [routeId('c1', 1), routeId('c1', 3)];
  let bruno: Caller, $bruno: Money, ana: Caller, $ana: Money;
  let edu: Person;
  let rm = '';

  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const newClient = (who: Caller, route: string) => who('POST', '/v1/clients', {
    routeId: route, name: `CLIENTE MIGRACION ${randomUUID().slice(0, 6)}`, documentType: 'CPF', document: cpf(),
    phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' });
  const expectCode = (r: { status: number; body: Body }, status: number, code: string, label: string) => {
    assert.equal(r.status, status, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body['error'], code, `${label}: ${JSON.stringify(r.body)}`);
  };
  const state = async (route: string) => (await db.admin.query<{ s: string }>('select migration_state s from adex.routes where id = $1', [route])).rows[0]!.s;
  const open = (who: Money, route: string, body: Body = {}, op?: string) =>
    who(`/v1/routes/${route}/migration`, { sourceRouteName: 'VALPARAISO SOC GAJ (sintética)', note: 'Prueba local', ...body }, op);
  const cancel = (who: Money, route: string, reason = 'Prueba local: se cancela la migración', op?: string) =>
    who(`/v1/routes/${route}/migration/cancel`, { reason }, op);

  before(async () => {
    db = await createTestDb('route_migration', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    // Base por Ruta (como en r74-consultas-routebase): r3 activa con responsable, disponible de la empresa a cero, «migrando» y corte.
    edu = await newPerson(api, issuer, provider.ids, bruno, { email: 'edu-rm@example.test', role: 'admin', displayName: 'Edu', routeIds: [r3] });
    const of2 = (await db.admin.query(`select id from adex.offices where company_id = $1 and code = 'OF-2'`, [c1])).rows[0].id as string;
    assert.equal((await bruno('POST', `/v1/offices/${of2}/status`, { status: 'activa' })).status, 200);
    assert.equal((await bruno('POST', `/v1/routes/${r3}/status`, { status: 'activa' })).status, 200);
    const r3ctrl = (await db.admin.query('select capital_controller_membership_id c from adex.routes where id = $1', [r3])).rows[0].c;
    if (r3ctrl !== edu.membershipId) {
      assert.equal((await bruno('PUT', `/v1/routes/${r3}/capital-controller`, { membershipId: edu.membershipId, reason: 'Responsable de r3' })).status, 200);
    }
    const company = await balance(db.admin, c1, 'company', null);
    if (company > 0) assert.equal((await $bruno('/v1/capital/company/withdrawals', { amountMinor: company, reason: 'Disponible a cero antes del corte' })).status, 201);
    const mig = await $bruno('/v1/capital/model', { target: 'migrating', evidence: 'Migración autorizada para la prueba local', backupReference: 'backup-local-rm' });
    assert.equal(mig.status, 200, JSON.stringify(mig.body));
    const act = await $bruno('/v1/capital/model', { target: 'route_base', evidence: 'Corte autorizado para la prueba local', backupReference: 'backup-local-rm' });
    assert.equal(act.status, 200, JSON.stringify(act.body));
    // Ruta nueva y vacía para la migración, con Ana como Administradora (responsable).
    const r = await bruno('POST', '/v1/routes', { name: 'Ruta Migrada', interestRate: 20, freeRate: false, maxLoanMinor: 500_000, adminIds: [M.anaAdmin] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    rm = r.body['id'] as string;
    assert.equal(r.body['migrationState'], 'normal');
  });
  after(async () => { await api?.close(); await db?.close(); });

  test('RM-001 · solo el SuperAdmin abre la migración, y solo sobre una ruta activa y vacía', async () => {
    expectCode(await open($ana, rm), 403, 'PERMISSION_DENIED', 'Administradora');
    expectCode(await bruno('POST', `/v1/routes/${rm}/migration`, { sourceRouteName: 'Sin operación' }), 400, 'OPERATION_ID_REQUIRED', 'sin X-Adex-Operation-Id');
    expectCode(await open($bruno, rm, { sourceRouteName: ' ' }), 400, 'INVALID_INPUT', 'sin nombre de origen');
    // r1 tiene clientes, ventas y movimientos: no se puede poner en migración.
    const busy = await open($bruno, r1);
    expectCode(busy, 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'ruta con datos');
    assert.equal(await state(r1), 'normal');

    const op = randomUUID();
    const ok = await open($bruno, rm, {}, op);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body['status'], 'en_migracion');
    assert.equal(ok.body['sourceRouteName'], 'VALPARAISO SOC GAJ (sintética)');
    assert.equal(await state(rm), 'en_migracion');
    // Reintento con la misma operación: misma respuesta, nada duplicado.
    const again = await open($bruno, rm, {}, op);
    assert.equal(again.status, 201);
    assert.deepEqual(again.body, ok.body);
    expectCode(await open($bruno, rm), 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'ya en migración');
    assert.equal(Number((await db.admin.query(`select count(*) n from adex.route_migrations where route_id = $1`, [rm])).rows[0].n), 1);
    // La ruta muestra su estado y la migración es visible para el SuperAdmin y para la Administradora de la ruta.
    const route = await bruno('GET', `/v1/routes/${rm}`);
    assert.equal(route.body['migrationState'], 'en_migracion', JSON.stringify(route.body));
    for (const who of [bruno, ana]) {
      const l = await who('GET', `/v1/route-migrations?routeId=${rm}`);
      assert.equal(l.status, 200, JSON.stringify(l.body));
      assert.deepEqual((l.body['migrations'] as Body[]).map((m) => [m['routeId'], m['status']]), [[rm, 'en_migracion']]);
    }
    const audit = (await db.admin.query(`select action from adex.audit_log where route_id = $1 and action like 'ROUTE_MIGRATION%'`, [rm])).rows.map((x) => x.action);
    assert.deepEqual(audit, ['ROUTE_MIGRATION_OPENED']);
  });

  test('RM-002 · en migración la ruta es de solo lectura (PostgreSQL); las demás rutas siguen igual', async () => {
    expectCode(await newClient(ana, rm), 409, 'ROUTE_IN_MIGRATION', 'cliente nuevo');
    expectCode(await $ana('/v1/capital/route-base/injections', { routeId: rm, amountMinor: 10_000, reason: 'Base en ruta migrada' }), 409, 'ROUTE_IN_MIGRATION', 'inyección de Base');
    assert.equal(await balance(db.admin, c1, 'route_base', null, rm), 0);
    // Segunda barrera sin la API: adex_api con contexto no cambia el estado de migración.
    await assert.rejects(asApi(db.api, { identityId: identityOf('bruno'), membershipId: M.brunoSa, companyId: c1 },
      (q) => q.query(`update adex.routes set migration_state = 'normal' where id = $1`, [rm])), { code: '42501' }, 'adex_api no cambia el estado');
    assert.equal(await state(rm), 'en_migracion');
    // Ni el propietario del esquema escribe ventas en la ruta fuera de una carga de migración.
    await assert.rejects(db.admin.query(
      `insert into adex.clients (id, company_id, route_id, name, document, phone_primary, address_primary, status, created_at, updated_at)
       values ($1, $2, $3, 'X', '1', '1', 'a', 'activo', now(), now())`, [randomUUID(), c1, rm]), { code: 'AX443' }, 'alta directa bloqueada');
    // El resto de la empresa sigue normal.
    assert.equal((await newClient(ana, r1)).status, 201, 'cliente en otra ruta');
    // Editar la ruta (nombre) sigue permitido.
    const put = await bruno('PATCH', `/v1/routes/${rm}`, { name: 'Ruta Migrada Valparaíso' });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body['migrationState'], 'en_migracion');
  });

  test('RM-003 · cancelar: solo el SuperAdmin, con motivo; la ruta vuelve a normal y ya no está vacía para reabrir', async () => {
    expectCode(await cancel($ana, rm), 403, 'PERMISSION_DENIED', 'Administradora');
    expectCode(await cancel($bruno, rm, 'corto'), 400, 'INVALID_INPUT', 'motivo corto');
    const ok = await cancel($bruno, rm);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body['status'], 'cancelada');
    assert.equal(await state(rm), 'normal');
    expectCode(await cancel($bruno, rm), 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'sin migración abierta');
    assert.equal((await newClient(ana, rm)).status, 201, 'la ruta vuelve a operar');
    expectCode(await open($bruno, rm), 409, 'ROUTE_MIGRATION_NOT_ALLOWED', 'ya tiene clientes');
    const l = await bruno('GET', `/v1/route-migrations?routeId=${rm}`);
    assert.deepEqual((l.body['migrations'] as Body[]).map((m) => m['status']), ['cancelada']);
  });

  test('RM-004 · conciliación limpia', async () => {
    const r = await bruno('GET', '/v1/capital/reconciliation');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((r.body['checks'] as Body[]).filter((c) => !c['ok']), []);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });
});
