// [pg+api] País, moneda, zona horaria e importes exactos sobre PostgreSQL REAL.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { balanceOf, createTestDb, type TestDb } from '../helpers/db.ts';
import { startApi, type TestApi } from '../helpers/api.ts';
import { createLocalIssuer, type LocalIssuer } from '../helpers/issuer.ts';
import { setDbContext, withTransaction } from '../../src/db/tx.ts';
import * as F from '../helpers/fixtures.ts';

let db: TestDb;
let iss: LocalIssuer;
let api: TestApi;

before(async () => {
  db = await createTestDb('intl');
  await F.seed(db.superPool);
  iss = await createLocalIssuer();
  api = await startApi(db.apiPool, iss.verifier);
});
after(async () => {
  // Cerrar SIEMPRE antes de comprobar: un pool abierto impediría que el proceso termine.
  const errors = [...api.errors];
  await api.close();
  await db.close();
  assert.deepEqual(errors, [], 'la API no debe producir errores internos inesperados');
});

const companyOf = async (token: string, membership: string) =>
  (await api.call('GET', '/v1/context', { token, membership })).body['company'] as Record<string, unknown>;

test('INTL-001 [pg+api] empresa BR / BRL / America/Sao_Paulo', async () => {
  const ana = await iss.issue(F.ANA);
  assert.deepEqual(await companyOf(ana, F.M_ANA_BR_ADMIN), {
    id: F.COMPANY_BR, name: 'Empresa Sintética Brasil', countryCode: 'BR', currencyCode: 'BRL', minorUnits: 2, timezone: 'America/Sao_Paulo',
  });
  const acc = await api.call('GET', `/v1/accounts/${F.ACC_BR_COMPANY}`, { token: ana, membership: F.M_ANA_BR_ADMIN });
  assert.deepEqual([acc.body['balance'], acc.body['currency']], ['5000.00', 'BRL']);
});

test('INTL-002 [pg+api] empresa CO / COP / America/Bogota', async () => {
  const bruno = await iss.issue(F.BRUNO);
  assert.deepEqual(await companyOf(bruno, F.M_BRUNO_CO_ADMIN), {
    id: F.COMPANY_CO, name: 'Empresa Sintética Colombia', countryCode: 'CO', currencyCode: 'COP', minorUnits: 2, timezone: 'America/Bogota',
  });
  const acc = await api.call('GET', `/v1/accounts/${F.ACC_CO_COMPANY}`, { token: bruno, membership: F.M_BRUNO_CO_ADMIN });
  assert.deepEqual([acc.body['balance'], acc.body['currency']], ['5000.00', 'COP']);
});

test('INTL-001/002 [pg] la fecha contable depende de la zona horaria de cada empresa', async () => {
  const instant = '2026-10-13T04:00:00Z'; // 01:00 en São Paulo, 23:00 del día anterior en Bogotá
  const localDate = (identityId: string, membershipId: string, companyId: string) => withTransaction(db.apiPool, async (c) => {
    await setDbContext(c, { identityId, membershipId, companyId });
    const r = await c.query(`select (($1::timestamptz) at time zone timezone)::date::text d from adex.companies`, [instant]);
    return r.rows.map((x) => x.d);
  });
  assert.deepEqual(await localDate(F.ANA, F.M_ANA_BR_ADMIN, F.COMPANY_BR), ['2026-10-13']);
  assert.deepEqual(await localDate(F.BRUNO, F.M_BRUNO_CO_ADMIN, F.COMPANY_CO), ['2026-10-12']);
});

test('INTL-001/002 [pg] el esquema rechaza país, moneda o zona inválidos', async () => {
  const bad = [
    ['Brasil', 'BRL', 'America/Sao_Paulo', '23514'],
    ['BR', 'XXX', 'America/Sao_Paulo', '23503'],     // moneda no registrada
    ['CO', 'COP', 'America/Medellin_Fake', '23514'],
    ['co', 'COP', 'America/Bogota', '23514'],
  ];
  for (const [country, currency, tz, code] of bad) {
    await assert.rejects(
      db.superPool.query('insert into adex.companies (name, country_code, currency_code, timezone) values ($1, $2, $3, $4)', ['x', country, currency, tz]),
      (e: { code?: string }) => e.code === code || (code === '23514' && e.code === '22001'),
      `${country}/${currency}/${tz}`,
    );
  }
});

test('INTL-003 [pg+api] valores monetarios exactos de extremo a extremo', async (t) => {
  const ana = await iss.issue(F.ANA);
  const dep = (acc: string, amount: unknown, membership = F.M_ANA_BR_ADMIN) =>
    api.call('POST', `/v1/accounts/${acc}/deposits`, { token: ana, membership, body: { operationId: randomUUID(), amount } });

  await t.test('las columnas de dinero son bigint; no hay float/real/double en el esquema', async () => {
    const r = await db.superPool.query(`select column_name, data_type from information_schema.columns where table_schema = 'adex' and column_name like '%_minor'`);
    assert.ok(r.rows.length >= 3);
    assert.ok(r.rows.every((x) => x.data_type === 'bigint'), JSON.stringify(r.rows));
    const floats = await db.superPool.query(`select 1 from information_schema.columns where table_schema = 'adex' and data_type in ('real', 'double precision')`);
    assert.equal(floats.rowCount, 0);
  });
  await t.test('0.10 + 0.20 = 0.30 exacto; JSON number rechazado; exceso de decimales rechazado', async () => {
    const acc = randomUUID();
    await db.superPool.query(`insert into adex.accounts (id, company_id, route_id, name) values ($1, $2, null, 'intl')`, [acc, F.COMPANY_BR]);
    assert.equal((await dep(acc, '0.10')).status, 201);
    const r = await dep(acc, '0.20');
    assert.equal(r.body['balanceAfter'], '0.30');
    assert.equal((await dep(acc, 0.1)).body['error'], 'AMOUNT_MUST_BE_STRING');
    assert.equal((await dep(acc, '0.001')).body['error'], 'TOO_MANY_DECIMALS');
    assert.equal((await dep(acc, '0.00')).body['error'], 'AMOUNT_NOT_POSITIVE');
    assert.equal(await balanceOf(db.superPool, acc), 30n);
  });
  await t.test('importes por encima de 2^53 se guardan y devuelven exactos', async () => {
    const acc = randomUUID();
    await db.superPool.query(`insert into adex.accounts (id, company_id, route_id, name) values ($1, $2, null, 'big')`, [acc, F.COMPANY_BR]);
    const r = await dep(acc, '90071992547409.93'); // 9007199254740993 unidades menores = 2^53 + 1
    assert.equal(r.body['balanceAfter'], '90071992547409.93');
    assert.equal(await balanceOf(db.superPool, acc), 9007199254740993n);
    // Desbordamiento de bigint → rechazo controlado, sin escritura.
    await db.superPool.query('update adex.accounts set balance_minor = 9223372036854775000 where id = $1', [acc]);
    assert.equal((await dep(acc, '100.00')).body['error'], 'AMOUNT_OUT_OF_RANGE');
    assert.equal(await balanceOf(db.superPool, acc), 9223372036854775000n);
  });
  await t.test('monedas con 0 y 4 decimales (empresas sintéticas solo de esta prueba)', async () => {
    await db.superPool.query(`insert into adex.currencies (code, minor_units) values ('CLP', 0), ('UYW', 4)`);
    const cases = [
      { cur: 'CLP', country: 'CL', tz: 'America/Santiago', ok: '1500', okFmt: '1500', bad: '1500.5' },
      { cur: 'UYW', country: 'UY', tz: 'America/Montevideo', ok: '1.2345', okFmt: '1.2345', bad: '1.23456' },
    ];
    for (const c of cases) {
      const company = randomUUID();
      const membership = randomUUID();
      const acc = randomUUID();
      await db.superPool.query(`insert into adex.companies (id, name, country_code, currency_code, timezone) values ($1, $2, $3, $4, $5)`, [company, `Sintética ${c.cur}`, c.country, c.cur, c.tz]);
      await db.superPool.query(`insert into adex.memberships (id, identity_id, company_id, role, scope) values ($1, $2, $3, 'admin', 'company')`, [membership, F.ANA, company]);
      await db.superPool.query(`insert into adex.accounts (id, company_id, route_id, name) values ($1, $2, null, 'x')`, [acc, company]);
      const ok = await dep(acc, c.ok, membership);
      assert.equal(ok.status, 201, c.cur);
      assert.equal(ok.body['balanceAfter'], c.okFmt);
      assert.equal(ok.body['currency'], c.cur);
      assert.equal((await dep(acc, c.bad, membership)).body['error'], 'TOO_MANY_DECIMALS');
    }
  });
});
