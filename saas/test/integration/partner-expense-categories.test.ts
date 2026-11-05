// 3.29 (0047) · lista de tipos de gasto del socio, contra PostgreSQL real. Datos 100 % sintéticos.
// El ajuste de empresas existentes (`adex.apply_partner_expense_categories`) se prueba sobre una empresa con la lista
// anterior, igual que BlueLine: Combustible con gastos, Otros solo Administrador y los tipos viejos sin gastos.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { companyId } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

type Row = { id: string; name: string; active: boolean; for_collectors: boolean };

describe('3.29 · lista de tipos de gasto del socio (0047)', () => {
  let db: TestDb;
  const c1 = companyId('c1');
  const rows = async () =>
    (await db.admin.query<Row>('select id, name, active, for_collectors from adex.expense_categories where company_id = $1 and deleted_at is null order by name', [c1])).rows;
  const byName = (list: Row[], n: string) => list.find((r) => r.name === n);

  before(async () => {
    db = await createTestDb('partner_categories', { seed: true });
    // La empresa sintética nace con Combustible (activo) y Papelería (inactivo). Se completa como BlueLine.
    for (const [name, active, fc] of [['Transporte', true, true], ['Alimentación', true, true], ['Comunicación', true, false],
      ['Mantenimiento', true, false], ['Otros', true, false]] as const) {
      await db.admin.query('insert into adex.expense_categories (id, company_id, name, active, for_collectors) values (gen_random_uuid()::text, $1, $2, $3, $4)', [c1, name, active, fc]);
    }
  });
  after(async () => { await db.close(); });

  test('PEC-001 · la lista tiene 50 tipos, 11 «Para Cobradores», sin nombres repetidos (sin tildes ni mayúsculas)', async () => {
    const p = (await db.admin.query<{ name: string; for_collectors: boolean; key: string }>(
      'select name, for_collectors, adex.expense_category_key(name) key from adex.partner_expense_categories()')).rows;
    assert.equal(p.length, 50);
    assert.deepEqual(p.filter((x) => x.for_collectors).map((x) => x.name).sort(), ['Aceite', 'Arriendo funcionario', 'Despinchada moto', 'Gasolina',
      'Impuesto CNPJ', 'Mantenimiento moto', 'Medicamentos', 'Otros', 'Pago cadena', 'Recarga celular', 'Seguro de moto']);
    assert.equal(new Set(p.map((x) => x.key)).size, 50);
    assert.equal((await db.admin.query(`select adex.expense_category_key('  ALIMENTACIÓN ') k`)).rows[0].k, 'alimentacion');
  });

  test('PEC-002 · empresa existente: Combustible pasa a Gasolina (mismo tipo, mismos gastos), viejos desactivados, Otros para Cobradores, sin duplicados', async () => {
    const before = await rows();
    const fuel = byName(before, 'Combustible')!;
    const expensesBefore = (await db.admin.query('select id, category_id, amount_minor from adex.expenses where company_id = $1 order by id', [c1])).rows;
    await db.admin.query('select adex.apply_partner_expense_categories()');
    const list = await rows();
    const gas = byName(list, 'Gasolina')!;
    assert.equal(gas.id, fuel.id, 'Gasolina es el mismo tipo que Combustible');
    assert.equal(gas.for_collectors, fuel.for_collectors);
    assert.equal(byName(list, 'Combustible'), undefined);
    for (const n of ['Transporte', 'Alimentación', 'Comunicación', 'Mantenimiento', 'Papelería']) assert.equal(byName(list, n)!.active, false, n);
    assert.equal(byName(list, 'Otros')!.for_collectors, true);
    assert.equal(list.length, 50 + 5, '50 de la lista + 5 viejos desactivados');
    const keys = (await db.admin.query('select adex.expense_category_key(name) k from adex.expense_categories where company_id = $1 and deleted_at is null', [c1])).rows.map((r) => r.k);
    assert.equal(new Set(keys).size, keys.length, 'sin duplicados');
    assert.equal(byName(list, 'Aceite')!.for_collectors, true);
    assert.equal(byName(list, 'Uber')!.for_collectors, false);
    const expensesAfter = (await db.admin.query('select id, category_id, amount_minor from adex.expenses where company_id = $1 order by id', [c1])).rows;
    assert.deepEqual(expensesAfter, expensesBefore, 'ningún gasto cambia');
  });

  test('PEC-003 · aplicarlo otra vez no cambia nada; un tipo creado por el Administrador con nombre de la lista se respeta', async () => {
    await db.admin.query(`update adex.expense_categories set for_collectors = false where company_id = $1 and name = 'Aceite'`, [c1]);
    const before = await rows();
    await db.admin.query('select adex.apply_partner_expense_categories()');
    assert.deepEqual(await rows(), before);
  });
});
