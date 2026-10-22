// PUERTA DE LA FASE 0 (plan §2): «el esquema revisado reproduce las 28 tablas (o
// justifica las que desaparecen)».
//
// Tres fuentes independientes deben coincidir:
//   1. Las tablas REALES de `RutaCashDB` (src/lib/db.ts, `this.version(n).stores`).
//   2. Los campos REALES de cada interfaz (compilador de TypeScript, con herencia).
//   3. Las columnas REALES de PostgreSQL tras aplicar las migraciones.
// Cualquier campo nuevo en CLEAN o columna nueva en SQL sin reflejo en el mapa rompe
// esta prueba hasta que se mapee o se justifique.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { DEXIE_V16_TABLES, plainColumns } from '../../src/model/dexieV16.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCES = {
  models: path.join(repo, 'src', 'models', 'types.ts'),
  platform: path.join(repo, 'src', 'platform', 'types.ts'),
};

function interfaceFields(): Map<string, string[]> {
  const program = ts.createProgram(Object.values(SOURCES), { strict: true, noEmit: true, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const out = new Map<string, string[]>();
  for (const file of Object.values(SOURCES)) {
    const sf = program.getSourceFile(file);
    assert.ok(sf, `missing ${file}`);
    ts.forEachChild(sf, (node) => {
      if (ts.isInterfaceDeclaration(node)) {
        const type = checker.getTypeAtLocation(node.name);
        out.set(node.name.text, checker.getPropertiesOfType(type).map((p) => p.name).sort());
      }
    });
  }
  return out;
}

function dexieTables(): string[] {
  const src = readFileSync(path.join(repo, 'src', 'lib', 'db.ts'), 'utf8');
  const tables = new Set<string>();
  const removed = new Set<string>();
  for (const block of src.matchAll(/stores\(\{([\s\S]*?)\}\)/g)) {
    for (const m of block[1]!.matchAll(/^\s*(\w+):\s*(null|'[^']*')/gm)) {
      if (m[2] === 'null') { tables.delete(m[1]!); removed.add(m[1]!); } else tables.add(m[1]!);
    }
  }
  // `offices` se borró en v3 y volvió en v11: cuenta el último estado.
  for (const block of src.matchAll(/version\(11\)\.stores\(\{([\s\S]*?)\}\)/g)) {
    for (const m of block[1]!.matchAll(/^\s*(\w+):\s*'/gm)) tables.add(m[1]!);
  }
  return [...tables].sort();
}

describe('Fase 0 · esquema completo frente a Dexie v16', () => {
  test('SCHEMA-001 · el mapa cubre exactamente las 28 tablas de RutaCashDB v16', () => {
    const real = dexieTables();
    assert.equal(real.length, 28, `RutaCashDB declares ${real.length} tables: ${real.join(', ')}`);
    assert.deepEqual(DEXIE_V16_TABLES.map((t) => t.dexieTable).sort(), real);
  });

  test('SCHEMA-002 · cada campo de cada interfaz está mapeado u omitido con justificación, sin sobrantes', () => {
    const fields = interfaceFields();
    for (const t of DEXIE_V16_TABLES) {
      const real = fields.get(t.entity);
      assert.ok(real, `interface ${t.entity} not found`);
      if (!t.sqlTable) {
        assert.ok(t.dropped && t.dropped.length > 40, `${t.dexieTable}: dropped table needs a justification`);
        continue;
      }
      const mapped = [...t.fields.map((f) => f.field), ...t.omitted.map((o) => o.field)].sort();
      assert.deepEqual(mapped, real, `${t.entity}: fields mapped/omitted must equal the interface`);
      assert.equal(new Set(mapped).size, mapped.length, `${t.entity}: duplicated field`);
      for (const o of t.omitted) assert.ok(o.reason.length > 30, `${t.entity}.${o.field}: omission needs a justification`);
    }
  });

  test('SCHEMA-003 · `cashboxMovements` (la única tabla que desaparece) no tiene escritores en src/', () => {
    const writer = /cashboxMovements['"]?\)?\s*\.\s*(add|put|bulkAdd|bulkPut|update|modify|delete|clear)\b/;
    const hits: string[] = [];
    const files = readdirSync(path.join(repo, 'src'), { recursive: true, encoding: 'utf8' }).filter((f) => /\.(ts|tsx)$/.test(f));
    assert.ok(files.length > 100, 'src/ scan found too few files');
    for (const f of files) {
      readFileSync(path.join(repo, 'src', f), 'utf8').split('\n').forEach((line, i) => {
        if (writer.test(line)) hits.push(`${f}:${i + 1}`);
      });
    }
    assert.deepEqual(hits, []);
  });

  describe('con PostgreSQL real', () => {
    let db: TestDb;
    before(async () => { db = await createTestDb('coverage'); });
    after(async () => { await db.close(); });

    test('SCHEMA-004 · cada columna del mapa existe y cada columna de la tabla está mapeada o justificada', async () => {
      for (const t of DEXIE_V16_TABLES) {
        if (!t.sqlTable) continue;
        const [schema, table] = t.sqlTable.split('.') as [string, string];
        const cols = (await db.admin.query<{ column_name: string }>(
          'select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by 1', [schema, table],
        )).rows.map((r) => r.column_name);
        assert.ok(cols.length > 0, `${t.sqlTable} does not exist`);
        const expected = new Set([...plainColumns(t), ...t.added.map((a) => a.column)]);
        if (t.source === 'models' && t.dexieTable !== 'tenants') expected.add('company_id');
        assert.deepEqual(cols, [...expected].sort(), `${t.sqlTable}: columns vs map`);
        for (const a of t.added) assert.ok(a.reason.length > 30, `${t.sqlTable}.${a.column}: needs a justification`);
      }
    });

    test('SCHEMA-005 · las únicas tablas sin equivalente Dexie son de infraestructura del servidor', async () => {
      const mapped = new Set(DEXIE_V16_TABLES.flatMap((t) => (t.sqlTable ? [t.sqlTable] : [])));
      const real = (await db.admin.query<{ t: string }>(
        `select schemaname || '.' || tablename t from pg_tables where schemaname in ('adex', 'adex_control') order by 1`,
      )).rows.map((r) => r.t);
      const extra = real.filter((t) => !mapped.has(t)).sort();
      // Fase 0: catálogo, identidad (DS-05), rutas autorizadas, idempotencia. Fase 1: sesiones revocadas.
      // Fase 2: catálogo de tipos de documento por país (DS-10). Fase 3: libro de capital y
      // custodia de doble entrada (sin equivalente Dexie: CLEAN reparte el modelo C1 en
      // capitalMovements/withdrawals/cashCustodyMovements; el servidor no recrea esa caja de ruta).
      // Fase 6: cuadres del servidor (tramo del libro y posición con signo; `cash_settlements`
      // sigue siendo el histórico importado) y archivo de cifras de cada cierre de periodo.
      // ADEX Online (0017): permiso de UN SOLO USO de cada paso de una corrección de pago.
      // Ronda 48 (0022): ubicación del cobro (evidencia complementaria; CLEAN la guarda en payments.lat/lng).
      // Ronda 53 (0023): traspasos entre Administradores con confirmaciones (CLEAN no los tiene).
      // Ronda 62 (0026): evidencia de captura sin conexión y llave por membresía para cifrar el dispositivo.
      // Ronda 67 (0029): ubicación de referencia del cliente (historia) y del dispositivo al vender (mapa).
      assert.deepEqual(extra, ['adex.admin_transfers', 'adex.capital_accounts', 'adex.capital_entries', 'adex.capital_operations', 'adex.capital_requests', 'adex.client_locations', 'adex.correction_steps', 'adex.currencies', 'adex.custody_settlements',
        'adex.document_types', 'adex.identities', 'adex.membership_routes', 'adex.offline_captures', 'adex.offline_keys', 'adex.operations', 'adex.payment_locations', 'adex.period_closures', 'adex.revoked_sessions', 'adex.sale_locations']);
    });

    test('SCHEMA-006 · toda tabla operativa lleva company_id NOT NULL y clave (company_id, id)', async () => {
      const rows = (await db.admin.query<{ table_name: string; nullable: string }>(
        `select c.table_name, c.is_nullable nullable from information_schema.columns c
          where c.table_schema = 'adex' and c.column_name = 'company_id'`)).rows;
      const operational = DEXIE_V16_TABLES.filter((t) => t.source === 'models' && t.sqlTable && t.dexieTable !== 'tenants')
        .map((t) => t.sqlTable!.split('.')[1]!);
      for (const t of operational) {
        assert.equal(rows.find((r) => r.table_name === t)?.nullable, 'NO', `adex.${t}.company_id must be NOT NULL`);
        const uq = await db.admin.query(
          `select 1 from pg_constraint where conrelid = ('adex.' || $1)::regclass and contype in ('u', 'p')
              and pg_get_constraintdef(oid) ~ '^(UNIQUE|PRIMARY KEY) \\(company_id, id\\)'`, [t]);
        if (t !== 'membership_routes') assert.equal(uq.rowCount, 1, `adex.${t} needs unique (company_id, id)`);
      }
    });
  });
});
