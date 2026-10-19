// Escrituras permitidas al rol de la API de empresa (`adex_api`), por tabla. Es el
// CONTRATO que verifica test/contracts/tenancy (TEN-003) contra los GRANT reales:
// cualquier privilegio nuevo exige actualizar esta lista en el mismo cambio.
//
//   Fase 0: ninguna (solo lectura).
//   Fase 1 (0005): identidad, membresías, rutas autorizadas, sesiones revocadas y
//   auditoría del servidor. DELETE solo en la asignación de rutas (no es historia
//   financiera; la baja queda auditada en la misma transacción).
//   Fase 2 (0007): estructura y catálogo (empresa, Oficinas, rutas, categorías,
//   clientes), idempotencia y el responsable de capital (evento + traspaso
//   ROUTE_CONTROL_TRANSFER, único asiento permitido por RLS). DELETE solo sobre
//   entidades de catálogo, y PostgreSQL lo rechaza si tienen historia (DS-11).
//   Fase 3 (0009): NINGÚN privilegio de escritura nuevo. El libro de capital y la
//   custodia (capital_accounts, capital_operations, capital_entries) solo se escriben
//   con la función SECURITY DEFINER `adex.capital_post` (EXECUTE, no tabla).
//   Fase 4 (0010): solicitudes de crédito (alta y resolución, columnas concretas y
//   guardia de transiciones). Créditos y cuotas: SOLO `adex.credit_disburse`.
//   Fase 6 (0014): NINGÚN privilegio de escritura nuevo. Cuadres y cierres solo con
//   `adex.custody_settle`, `custody_settlement_reopen` y `period_close`.
//   ADEX Online (0015): alta de visitas sin pago (INSERT, columnas concretas; no mueven
//   dinero). Sin UPDATE ni DELETE: es historia.
//   ADEX Online (0017): solicitudes de ajuste de pago (INSERT; UPDATE solo de su estado
//   de revisión para el rechazo). La corrección del pago solo con `adex.collection_correct`.
// Nunca TRUNCATE. Nunca DELETE ni UPDATE sobre datos financieros.
export const EXPECTED_API_WRITES: Record<string, string[]> = {
  'adex.audit_log': ['INSERT'],
  'adex.capital_ledger': ['INSERT'],
  'adex.clients': ['DELETE', 'INSERT', 'UPDATE'],
  'adex.companies': ['UPDATE'],
  'adex.expense_categories': ['DELETE', 'INSERT', 'UPDATE'],
  'adex.identities': ['INSERT', 'UPDATE'],
  'adex.membership_routes': ['DELETE', 'INSERT'],
  'adex.memberships': ['DELETE', 'INSERT', 'UPDATE'],
  'adex.no_payment_visits': ['INSERT'],
  'adex.offices': ['DELETE', 'INSERT', 'UPDATE'],
  'adex.payment_adjustment_requests': ['INSERT', 'UPDATE'],
  'adex.operations': ['INSERT', 'UPDATE'],
  'adex.revoked_sessions': ['INSERT'],
  'adex.route_capital_controller_events': ['INSERT'],
  'adex.routes': ['DELETE', 'INSERT', 'UPDATE'],
  'adex.sale_requests': ['INSERT', 'UPDATE'],
};

/** Tablas financieras: la API nunca las borra ni las reescribe (D7, D28). */
export const FINANCIAL_TABLES = [
  'adex.sales', 'adex.installments', 'adex.payments', 'adex.payment_adjustment_requests', 'adex.no_payment_visits', 'adex.expenses',
  'adex.capital_movements', 'adex.transfers', 'adex.withdrawals', 'adex.capital_ledger', 'adex.route_capital_controller_events',
  'adex.partner_cash_movements', 'adex.cash_custody_movements', 'adex.cash_settlements', 'adex.weekly_settlements', 'adex.sale_requests',
  'adex.capital_accounts', 'adex.capital_operations', 'adex.capital_entries', 'adex.custody_settlements', 'adex.period_closures',
] as const;
