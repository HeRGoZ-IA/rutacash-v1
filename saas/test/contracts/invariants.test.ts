// PUERTA DE LA FASE 0: «sin cambios en reglas financieras aprobadas» y «modelo que
// preserve las reglas y su trazabilidad». Lo que el ESQUEMA garantiza por sí mismo,
// para cualquier escritor futuro (incluido el administrador del proyecto):
//   D7  lo cerrado es inmutable; correcciones como asientos nuevos y enlazados
//   D28 castigar no borra la historia (sin borrado físico de nada financiero)
//   monotonía de pagos (`assertPaymentTransitionAllowed`), forma de la custodia,
//   atribución de gastos, aritmética del cuadre, FK que no cruzan empresas.
// Las reglas que dependen de saldos (D24–D26, D30) son de los comandos (fases 3–6).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { companyId, membershipId, routeId, uid } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

const c1 = companyId('c1');
const c2 = companyId('c2');
const id1 = (s: string) => uid(`c1:${s}`);
const admin1 = membershipId('c1', 'ana-admin');
const worker1 = membershipId('c1', 'ana-cob');

describe('Fase 0 · invariantes estructurales del modelo financiero', () => {
  let db: TestDb;
  before(async () => { db = await createTestDb('invariants', { seed: true }); });
  after(async () => { await db.close(); });

  /** Ejecuta como ADMINISTRADOR (BYPASSRLS): ni él puede saltarse estas reglas. */
  async function rejects(sql: string, code: string, params: unknown[] = []): Promise<void> {
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await assert.rejects(c.query(sql, params).then(() => c.query('set constraints all immediate')), { code }, sql);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  }
  async function ok(sql: string, params: unknown[] = []): Promise<void> {
    await db.admin.query(sql, params);
  }

  test('INV-001 · una fila nunca apunta a otra empresa (FK compuestas)', async () => {
    const saleC2 = uid('c2:sale:1');
    await rejects(`insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, amount_minor, payment_date, payment_type, sync_status, created_at)
                   values ('x-pay', $1, $2, $3, $4, $5, 100, '2026-10-01', 'efectivo', 'synced', now())`, '23503',
      [c1, saleC2, id1('client:1'), routeId('c1', 1), worker1]);
    await rejects(`insert into adex.membership_routes (company_id, membership_id, route_id) values ($1, $2, $3)`, '23503',
      [c1, worker1, routeId('c2', 1)]);
    await rejects(`update adex.routes set capital_controller_membership_id = $1 where id = $2`, '23503',
      [membershipId('c2', 'hugo-admin'), routeId('c1', 1)]);
  });

  test('INV-002 · D28/D7: nada financiero se borra físicamente, ni por el administrador', async () => {
    for (const t of ['payments', 'sales', 'expenses', 'capital_ledger', 'cash_settlements', 'weekly_settlements', 'audit_log', 'transfers', 'installments']) {
      await rejects(`delete from adex.${t} where company_id = $1`, '42501', [c1]);
      await rejects(`truncate adex.${t} cascade`, '42501');
    }
  });

  test('INV-003 · monotonía de pagos: un anulado o una reversión no cambian de estado ni de vínculo; los hechos no se reescriben', async () => {
    await rejects(`update adex.payments set state = 'active' where id = $1`, '42501', [id1('pay:1')]);
    await rejects(`update adex.payments set state = 'active' where id = $1`, '42501', [id1('pay:2')]);
    await rejects(`update adex.payments set reverses_payment_id = $2 where id = $1`, '42501', [id1('pay:2'), id1('pay:4')]);
    await rejects(`update adex.payments set reversal_payment_id = $2 where id = $1`, '42501', [id1('pay:1'), id1('pay:4')]);
    await rejects(`update adex.payments set amount_minor = 1 where id = $1`, '42501', [id1('pay:4')]);
    await rejects(`update adex.payments set payment_date = '2026-01-01' where id = $1`, '42501', [id1('pay:4')]);
    // Una reversión positiva o un pago normal negativo violan la forma del asiento.
    await rejects(`insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, amount_minor, payment_date, payment_type, sync_status, created_at, state, reverses_payment_id)
                   values ('x-rev', $1, $2, $3, $4, $5, 100, '2026-10-01', 'efectivo', 'synced', now(), 'reversal', $6)`, '23514',
      [c1, id1('sale:1'), id1('client:1'), routeId('c1', 1), worker1, id1('pay:4')]);
    await rejects(`insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, amount_minor, payment_date, payment_type, sync_status, created_at)
                   values ('x-neg', $1, $2, $3, $4, $5, -100, '2026-10-01', 'efectivo', 'synced', now())`, '23514',
      [c1, id1('sale:1'), id1('client:1'), routeId('c1', 1), worker1]);
    // Un pago no tiene dos reversiones.
    await rejects(`insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, amount_minor, payment_date, payment_type, sync_status, created_at, state, reverses_payment_id)
                   values ('x-rev2', $1, $2, $3, $4, $5, -6000, '2026-10-01', 'efectivo', 'synced', now(), 'reversal', $6)`, '23505',
      [c1, id1('sale:1'), id1('client:1'), routeId('c1', 1), worker1, id1('pay:1')]);
  });

  test('INV-004 · movimientos anulables: solo se marca la reversión, una vez; una reversión no se anula', async () => {
    await rejects(`update adex.capital_movements set amount_minor = 1 where id = $1`, '42501', [id1('cap:2')]);
    await rejects(`update adex.capital_movements set reversal_id = null where id = $1`, '42501', [id1('cap:1')]);
    await rejects(`update adex.capital_movements set reversal_reason = 'otro' where id = $1`, '42501', [id1('cap:1')]);
    await rejects(`update adex.withdrawals set reversal_id = $2 where id = $1`, '42501', [id1('wd:1:rev'), id1('wd:1')]);
    await rejects(`update adex.capital_ledger set amount_minor = 1 where id = $1`, '42501', [id1('led:dep')]);
    // Un asiento espejo sin `reverses_id` con importe negativo no es válido.
    await rejects(`insert into adex.withdrawals (id, company_id, route_id, amount_minor, withdrawal_date, registered_by_membership_id, created_at)
                   values ('x-wd', $1, $2, -5, '2026-10-01', $3, now())`, '23514', [c1, routeId('c1', 1), admin1]);
    await rejects(`insert into adex.capital_ledger (id, company_id, kind, amount_minor, entry_date, created_at, actor_membership_id, status, sync_status)
                   values ('x-led', $1, 'ADMIN_ALLOCATION', 0, '2026-10-01', now(), $2, 'aplicado', 'synced')`, '23514', [c1, admin1]);
  });

  test('INV-005 · auditoría, historial de responsables y eventos de control: append-only', async () => {
    await rejects(`update adex.audit_log set description = 'x' where company_id = $1`, '42501', [c1]);
    await rejects(`update adex.route_capital_controller_events set reason = 'x' where company_id = $1`, '42501', [c1]);
    await rejects(`update adex_control.control_events set detail = 'x' where company_id = $1`, '42501', [c1]);
    await rejects(`delete from adex_control.control_events where company_id = $1`, '42501', [c1]);
  });

  test('INV-006 · D7: un cierre no se sobrescribe; solo se reabre con motivo y se versiona', async () => {
    await rejects(`update adex.weekly_settlements set collections_minor = 0 where id = $1`, '42501', [id1('week:2')]);
    await rejects(`update adex.weekly_settlements set status = 'cerrada' where id = $1`, '42501', [id1('week:1')]);
    await rejects(`update adex.weekly_settlements set superseded_by = $2 where id = $1`, '42501', [id1('week:1'), id1('week:legacy')]);
    await rejects(`update adex.weekly_settlements set status = 'reabierta' where id = $1`, '23514', [id1('week:2')]);
    await rejects(`update adex.cash_settlements set delivered_minor = 1 where id = $1`, '42501', [id1('cs:2')]);
    await rejects(`update adex.cash_settlements set status = 'cerrada', reopened_at = null where id = $1`, '42501', [id1('cs:1')]);
    // Reapertura legítima: estado, quién, cuándo y motivo.
    await ok(`update adex.weekly_settlements set status = 'reabierta', reopened_at = now(), reopened_by_membership_id = $2, reopen_reason = 'Prueba' where id = $1`,
      [id1('week:2'), admin1]);
  });

  test('INV-007 · forma de custodia, atribución de gastos y aritmética del cuadre', async () => {
    const base = [c1, routeId('c1', 1), worker1, admin1];
    await rejects(`insert into adex.cash_custody_movements (id, company_id, route_id, kind, amount_minor, from_membership_id, to_membership_id, origin, reason, movement_date, created_at, created_by_membership_id)
                   values ('x-c', $1, $2, 'BASE_RETURN', 100, $3, $3, 'route-cash', 'x', '2026-10-01', now(), $4)`, '23514', base);
    await rejects(`insert into adex.cash_custody_movements (id, company_id, route_id, kind, amount_minor, from_membership_id, to_membership_id, origin, reason, movement_date, created_at, created_by_membership_id)
                   values ('x-c', $1, $2, 'PERSON_TO_PERSON', 100, $3, $3, 'route-cash', 'x', '2026-10-01', now(), $4)`, '23514', base);
    await rejects(`insert into adex.expenses (id, company_id, route_id, scope, category_id, amount_minor, expense_date, registered_by_membership_id, sync_status, created_at)
                   values ('x-e', $1, $2, 'empresa', $3, 100, '2026-10-01', $4, 'synced', now())`, '23514', [c1, routeId('c1', 1), id1('cat:fuel'), admin1]);
    await rejects(`insert into adex.expenses (id, company_id, route_id, scope, category_id, amount_minor, expense_date, registered_by_membership_id, sync_status, created_at)
                   values ('x-e', $1, $2, 'trabajador', $3, 100, '2026-10-01', $4, 'synced', now())`, '23514', [c1, routeId('c1', 1), id1('cat:fuel'), admin1]);
    await rejects(`insert into adex.cash_settlements (id, company_id, route_id, worker_membership_id, period_from, period_to, period_from_origin, carried_over_minor,
                     collected_minor, disbursed_minor, expenses_minor, expected_minor, delivered_minor, difference_minor, shortage_minor, surplus_minor,
                     status, version, created_at, closed_at, closed_by_membership_id)
                   values ('x-cs', $1, $2, $3, now() - interval '1 day', now(), 'ultimo-cierre', 0, 100, 0, 0, 100, 90, -10, 0, 0, 'cerrada', 1, now(), now(), $4)`,
      '23514', base);
    // Diferencia sin motivo.
    await rejects(`insert into adex.cash_settlements (id, company_id, route_id, worker_membership_id, period_from, period_to, period_from_origin, carried_over_minor,
                     collected_minor, disbursed_minor, expenses_minor, expected_minor, delivered_minor, difference_minor, shortage_minor, surplus_minor,
                     status, version, created_at, closed_at, closed_by_membership_id)
                   values ('x-cs', $1, $2, $3, now() - interval '1 day', now(), 'ultimo-cierre', 0, 100, 0, 0, 100, 90, -10, 10, 0, 'cerrada', 1, now(), now(), $4)`,
      '23514', base);
  });

  test('INV-008 · una sola solicitud pendiente por cliente; una venta por solicitud', async () => {
    await rejects(`insert into adex.sale_requests (id, company_id, client_id, route_id, collector_membership_id, amount_minor, interest_rate, total_amount_minor,
                     installments_count, installment_value_minor, frequency, start_date, status, requested_at)
                   values ('x-r', $1, $2, $3, $4, 100, 20, 120, 2, 60, 'diaria', '2026-10-20', 'pending', now())`, '23505',
      [c1, id1('client:3'), routeId('c1', 2), worker1]);
    await rejects(`update adex.sales set sale_request_id = $2 where id = $1`, '23505', [id1('sale:3'), id1('request:1')]);
  });

  test('INV-009 · plano de control: solo los 10 tipos de evento; primer acceso inmutable', async () => {
    await rejects(`insert into adex_control.control_events (id, company_id, type, at) values ('x-ev', $1, 'SALE', now())`, '23514', [c1]);
    await rejects(`update adex_control.company_control set first_login_at = now() where company_id = $1`, '42501', [c1]);
  });

  test('INV-010 · dinero en unidades menores exactas por moneda (COP y BRL con 2 decimales ISO)', async () => {
    const r = await db.admin.query<{ company_id: string; sale_value_minor: string }>(
      `select company_id, sale_value_minor from adex.sales where id in ($1, $2)`, [id1('sale:1'), uid('c2:sale:1')]);
    const byCompany = Object.fromEntries(r.rows.map((x) => [x.company_id, x.sale_value_minor]));
    assert.equal(byCompany[c1], '100000');       // 1.000 BRL
    assert.equal(byCompany[c2], '100000000');    // 1.000.000 COP
  });
});
