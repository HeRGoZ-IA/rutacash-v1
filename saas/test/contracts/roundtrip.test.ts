// CONTRATO DE REPOSITORIO (plan §5.1, base del adaptador del servidor).
//
// Un snapshot con la forma EXACTA de los modelos de CLEAN —tres empresas, las 24
// tablas operativas y las 4 del plano de control, con cada campo relleno al menos
// una vez— se escribe en PostgreSQL y se vuelve a leer IDÉNTICO, salvo las
// diferencias justificadas en `dexieV16.ts` (contraseña, legado `routeId`).
// Además: importar es todo-o-nada y una cifra con decimales se rechaza (no se redondea).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DEXIE_V16_TABLES } from '../../src/model/dexieV16.ts';
import { LossyConversionError, exportCompany, exportOperators, importSnapshot, toSqlValue, type DexieRecord } from '../../src/model/adapter.ts';
import { COMPANIES, companyId, syntheticDataset } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, type TestDb } from '../helpers/db.ts';

function normalize(table: string, rec: DexieRecord, identityEmails: Set<string>): DexieRecord {
  const out: DexieRecord = {};
  const t = DEXIE_V16_TABLES.find((x) => x.dexieTable === table)!;
  const omitted = new Set(t.omitted.map((o) => o.field));
  for (const [k, v] of Object.entries(rec)) if (v !== undefined && !omitted.has(k)) out[k] = v;
  if (table === 'users') {
    const routes = new Set<string>((rec['authorizedRouteIds'] as string[] | undefined) ?? []);
    if (rec['routeId']) routes.add(rec['routeId'] as string);
    if (routes.size) out['authorizedRouteIds'] = [...routes].sort(); else delete out['authorizedRouteIds'];
    if (!identityEmails.has(String(rec['email']).toLowerCase())) delete out['email'];
  }
  return out;
}

const byId = (a: DexieRecord, b: DexieRecord) => String(a['id'] ?? a['companyId']).localeCompare(String(b['id'] ?? b['companyId']));

describe('Fase 0 · contrato de ida y vuelta Dexie v16 ↔ PostgreSQL', () => {
  let db: TestDb;
  const { snapshot, options } = syntheticDataset();
  const identityEmails = new Set(Object.keys(options.identityIds));
  before(async () => { db = await createTestDb('roundtrip'); });
  after(async () => { await db.close(); });

  test('RT-001 · el dataset sintético rellena cada campo mapeado de cada tabla al menos una vez', () => {
    for (const t of DEXIE_V16_TABLES) {
      if (!t.sqlTable) continue;
      const rows = (snapshot[t.dexieTable] ?? []) as DexieRecord[];
      assert.ok(rows.length > 0, `${t.dexieTable}: no synthetic rows`);
      for (const f of t.fields) {
        assert.ok(rows.some((r) => r[f.field] !== undefined), `${t.dexieTable}.${f.field} never populated`);
      }
    }
  });

  test('RT-002 · un importe con decimales o fuera de rango se rechaza, nunca se redondea', () => {
    assert.throws(() => toSqlValue('money', 10.5, 2, 'x'), LossyConversionError);
    assert.throws(() => toSqlValue('money', 2 ** 60, 2, 'x'), LossyConversionError);
    assert.throws(() => toSqlValue('date', '2026-1-1', 2, 'x'), LossyConversionError);
    assert.throws(() => toSqlValue('instant', '2026-10-01 10:00', 2, 'x'), LossyConversionError);
    assert.equal(toSqlValue('money', 1_250_000, 2, 'x'), '125000000');
    assert.equal(toSqlValue('money', -300, 2, 'x'), '-30000');
  });

  test('RT-003 · una importación que falla no deja NADA (todo o nada)', async () => {
    const broken = structuredClone(snapshot);
    (broken['payments'] as DexieRecord[]).push({ ...(broken['payments'] as DexieRecord[])[0]!, id: 'pay-roto', saleId: 'venta-inexistente' });
    const c = await db.admin.connect();
    try {
      await assert.rejects(importSnapshot(c, broken, options));
    } finally {
      c.release();
    }
    assert.equal(await count(db.admin, 'select 1 from adex.companies'), 0);
    assert.equal(await count(db.admin, 'select 1 from adex.identities'), 0);
  });

  test('RT-004 · las tres empresas vuelven idénticas, tabla por tabla y campo por campo', async () => {
    const c = await db.admin.connect();
    try {
      await importSnapshot(c, snapshot, options);
      for (const spec of COMPANIES) {
        const cid = companyId(spec.key);
        const back = await exportCompany(c, cid);
        for (const t of DEXIE_V16_TABLES) {
          if (!t.sqlTable || t.dexieTable === 'platformUsers') continue;
          const original = ((snapshot[t.dexieTable] ?? []) as DexieRecord[])
            .filter((r) => (t.dexieTable === 'tenants' ? r['id'] : t.dexieTable === 'installments'
              ? ((snapshot['sales'] ?? []) as DexieRecord[]).find((s) => s['id'] === r['saleId'])?.['tenantId']
              : (r['tenantId'] ?? r['companyId'])) === cid)
            .map((r) => normalize(t.dexieTable, r, identityEmails)).sort(byId);
          const actual = ((back[t.dexieTable] ?? []) as DexieRecord[]).map((r) => normalize(t.dexieTable, r, identityEmails)).sort(byId);
          assert.ok(original.length > 0, `${spec.key}/${t.dexieTable}: empty fixture`);
          assert.deepEqual(actual, original, `${spec.key}/${t.dexieTable}`);
        }
      }
      const owners = await exportOperators(c);
      assert.deepEqual(owners.map((o) => normalize('platformUsers', o, identityEmails)),
        ((snapshot['platformUsers'] ?? []) as DexieRecord[]).map((o) => normalize('platformUsers', o, identityEmails)));
    } finally {
      c.release();
    }
  });

  test('RT-005 · ninguna contraseña llega a PostgreSQL', async () => {
    const hits = await db.admin.query(
      `select table_schema, table_name, column_name from information_schema.columns
        where table_schema in ('adex', 'adex_control') and column_name ~* 'pass'`);
    assert.equal(hits.rowCount, 0);
    const dump = await db.admin.query(`select count(*)::int n from adex.memberships m where m::text ilike '%NO-SE-IMPORTA%'`);
    assert.equal(dump.rows[0].n, 0);
    const ops = await db.admin.query(`select count(*)::int n from adex_control.platform_operators o where o::text ilike '%NO-SE-IMPORTA%'`);
    assert.equal(ops.rows[0].n, 0);
  });

  test('RT-006 · las parcelas heredan la empresa de su venta (no existe parcela de otra empresa)', async () => {
    const bad = await count(db.admin, `select 1 from adex.installments i join adex.sales s on s.id = i.sale_id where s.company_id <> i.company_id`);
    assert.equal(bad, 0);
    assert.equal(await count(db.admin, 'select 1 from adex.installments'), 9);
  });
});
