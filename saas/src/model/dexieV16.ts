// ============================================================
// Correspondencia Dexie v16 → PostgreSQL (puerta de la Fase 0)
// ------------------------------------------------------------
// Una entrada por cada una de las 28 tablas de `RutaCashDB` (src/lib/db.ts):
// 24 operativas (src/models/types.ts) y 4 del plano de control (src/platform/types.ts).
//
// Cada campo de la interfaz TypeScript aparece UNA vez: en `fields` (columna y tipo)
// o en `omitted` (con su justificación). `added` lista las columnas nuevas del
// servidor y por qué existen. Una tabla sin destino lleva `dropped`.
//
// Lo verifica `test/contracts/schema-coverage.test.ts` contra:
//   · las interfaces REALES (compilador de TypeScript, incluidas las heredadas);
//   · las columnas REALES de PostgreSQL (information_schema) tras las migraciones.
// Y `test/contracts/roundtrip.test.ts` comprueba que un registro con TODOS sus
// campos rellenos va a PostgreSQL y vuelve idéntico (salvo lo justificado aquí).
// ============================================================

export type FieldKind =
  | 'id'          // adex.eid
  | 'idOrEmpty'   // '' en Dexie ↔ NULL (Transfer.routeOrigenId de un modelo anterior a la Ronda 53)
  | 'text'
  | 'money'       // número entero de la moneda ↔ bigint en unidades menores
  | 'int'
  | 'num'         // numeric ↔ number (tasas)
  | 'decimal'     // numeric(14,2) del plano de control (cobros de ADEX, sin moneda de empresa)
  | 'float'
  | 'bool'
  | 'date'        // yyyy-MM-dd ↔ date
  | 'instant'     // ISO 8601 ↔ timestamptz
  | 'json'
  | 'days'        // number[] (0–6) ↔ smallint[]
  | 'texts'       // string[] ↔ text[]
  | 'actor'       // id de usuario o `system:*` ↔ actor_membership_id / actor_system
  | 'identityEmail' // correo ↔ adex.identities.email (vía identity_id)
  | 'routeList';  // string[] ↔ adex.membership_routes

export interface FieldMap {
  field: string;
  /** Columna (para `actor`: prefijo; para `identityEmail`/`routeList`: tabla relacionada). */
  column: string;
  kind: FieldKind;
}

export interface Omission {
  field: string;
  reason: string;
}

export interface TableMap {
  dexieTable: string;
  entity: string;
  source: 'models' | 'platform';
  /** `schema.table`, o null si la tabla no pasa al servidor. */
  sqlTable: string | null;
  /** Columna que guarda la empresa (siempre `company_id`). */
  fields: FieldMap[];
  omitted: Omission[];
  added: { column: string; reason: string }[];
  dropped?: string;
}

const f = (field: string, column: string, kind: FieldKind = 'text'): FieldMap => ({ field, column, kind });
const id = (field: string, column: string) => f(field, column, 'id');
const money = (field: string, column: string) => f(field, column, 'money');
const instant = (field: string, column: string) => f(field, column, 'instant');
const date = (field: string, column: string) => f(field, column, 'date');
const tenant = id('tenantId', 'company_id');
const created = instant('createdAt', 'created_at');
const updated = instant('updatedAt', 'updated_at');
const REVERSAL = [
  id('reversalId', 'reversal_id'),
  instant('reversedAt', 'reversed_at'),
  id('reversedByUserId', 'reversed_by_membership_id'),
  f('reversalReason', 'reversal_reason'),
  id('reversesId', 'reverses_id'),
];
const AUDIT_ADDED = [
  { column: 'actor_identity_id', reason: 'Auditoría del servidor (DS-05): identidad verificada del token. NULL en la auditoría local importada' },
  { column: 'operation_id', reason: 'Idempotencia: el comando que originó la entrada' },
  { column: 'txid', reason: 'Transacción PostgreSQL del comando: prueba que movimiento y auditoría son atómicos (0A FIN-005)' },
];

export const DEXIE_V16_TABLES: readonly TableMap[] = [
  {
    dexieTable: 'tenants', entity: 'Tenant', source: 'models', sqlTable: 'adex.companies',
    fields: [
      id('id', 'id'), f('nombre', 'name'), f('nombreLegal', 'legal_name'), f('nit', 'tax_id'), f('email', 'email'),
      f('telefono', 'phone'), f('plan', 'plan'), f('status', 'status'), date('fechaVencimiento', 'expires_on'),
      f('logo', 'logo'), f('pais', 'country_label'), f('ciudad', 'city'), f('moneda', 'currency_code'),
      f('direccion', 'address'), f('responsable', 'contact_name'), instant('cashModelStartAt', 'cash_model_start_at'),
      instant('baseCustodyStartAt', 'base_custody_start_at'), created, updated,
    ],
    omitted: [{ field: 'centralCapitalStartAt', reason: 'Capital centralizado C1/C2 de CLEAN (2026-10-15): estado local por navegador. El SaaS empieza de cero y la Fase 3 implementa el modelo en PostgreSQL con su propio esquema; no se importa' }, { field: 'centralCapitalBackup', reason: 'Capital centralizado C1/C2 de CLEAN (2026-10-15): estado local por navegador. El SaaS empieza de cero y la Fase 3 implementa el modelo en PostgreSQL con su propio esquema; no se importa' }, { field: 'centralCapitalRouteBlocks', reason: 'Capital centralizado C1/C2 de CLEAN (2026-10-15): estado local por navegador. El SaaS empieza de cero y la Fase 3 implementa el modelo en PostgreSQL con su propio esquema; no se importa' }, { field: 'centralCapitalHeritage', reason: 'Capital centralizado C1/C2 de CLEAN (2026-10-15): estado local por navegador. El SaaS empieza de cero y la Fase 3 implementa el modelo en PostgreSQL con su propio esquema; no se importa' }],
    added: [
      { column: 'country_code', reason: 'P6: país ISO 3166-1. `Tenant.pais` es texto libre y se conserva en country_label; el código lo fija el alta o la importación' },
      { column: 'timezone', reason: 'P6/DS-04: zona IANA de la empresa, reloj de los periodos. No existe en Dexie (hoy manda el dispositivo)' },
      { column: 'is_demo', reason: 'ADEX Online v1 (0011): Empresa Demo con datos ficticios, ciclo de vida en adex_demo. Inmutable; una importación de CLEAN siempre es false' },
      { column: 'retired_at', reason: 'ADEX Online v1 (0011): retirada definitiva de una Empresa Demo (reinicio = recreación). Solo Demos; NULL en toda empresa importada' },
    ],
  },
  {
    dexieTable: 'offices', entity: 'Office', source: 'models', sqlTable: 'adex.offices',
    fields: [id('id', 'id'), tenant, f('nombre', 'name'), f('codigo', 'code'), f('status', 'status'), created, updated],
    omitted: [], added: [],
  },
  {
    dexieTable: 'routes', entity: 'Route', source: 'models', sqlTable: 'adex.routes',
    fields: [
      id('id', 'id'), tenant, id('officeId', 'office_id'), f('nombre', 'name'), f('codigo', 'code'), f('ciudad', 'city'),
      f('email', 'email'), f('telefono', 'phone'), f('tasaInteres', 'interest_rate', 'num'), f('tasaLibre', 'free_rate', 'bool'),
      money('montoMaximoPrestamo', 'max_loan_minor'), money('capitalInicial', 'initial_capital_minor'),
      money('capitalActual', 'legacy_capital_actual_minor'), id('cobradorId', 'collector_membership_id'),
      id('capitalControllerAdminId', 'capital_controller_membership_id'), instant('capitalControllerSince', 'capital_controller_since'),
      f('status', 'status'), created, updated,
    ],
    omitted: [], added: [],
  },
  {
    dexieTable: 'users', entity: 'User', source: 'models', sqlTable: 'adex.memberships',
    fields: [
      id('id', 'id'), tenant, f('nombre', 'display_name'), f('email', 'adex.identities', 'identityEmail'), f('rol', 'role'),
      f('telefono', 'phone'), f('avatar', 'avatar'), f('authorizedRouteIds', 'adex.membership_routes', 'routeList'),
      f('canCreateDirectSales', 'legacy_can_create_direct_sales', 'bool'), money('maxDirectSaleAmount', 'legacy_max_direct_sale_minor'),
      f('grantedCapabilities', 'granted_capabilities', 'texts'), f('revokedCapabilities', 'revoked_capabilities', 'texts'),
      f('status', 'status'), created, updated,
    ],
    omitted: [
      { field: 'password', reason: 'DS-03: contraseña en texto plano del modelo local. NO se importa ni se guarda: la gestiona el proveedor de identidad y cada persona la restablece' },
      { field: 'mustChangePassword', reason: 'Sin efecto desde v13 (ningún guard lo consume); el cambio de contraseña lo gestiona el proveedor' },
      { field: 'routeId', reason: 'Legado: se UNE a las rutas autorizadas (adex.membership_routes), igual que `authorizedRouteIdsOf` (sin duplicar)' },
    ],
    added: [
      { column: 'identity_id', reason: 'DS-05: la persona (identidad única) detrás de la membresía. NULL = membresía histórica sin acceso' },
    ],
  },
  {
    dexieTable: 'clients', entity: 'Client', source: 'models', sqlTable: 'adex.clients',
    fields: [
      id('id', 'id'), tenant, id('routeId', 'route_id'), f('nombre', 'name'), f('documento', 'document'),
      f('telefonoPrincipal', 'phone_primary'), f('telefonoSecundario', 'phone_secondary'), f('direccionPrincipal', 'address_primary'),
      f('direccionSecundaria', 'address_secondary'), f('negocio', 'business'), f('fotoDocumentoUrl', 'document_photo_url'),
      f('fotoNegocioUrl', 'business_photo_url'), f('status', 'status'), f('notas', 'notes'), created, updated,
    ],
    omitted: [],
    added: [
      { column: 'document_type', reason: 'DS-10 (Fase 2): tipo de documento del catálogo del país (adex.document_types). NULL = cliente importado de CLEAN sin tipo declarado' },
      { column: 'document_normalized', reason: 'DS-10: número normalizado por PostgreSQL (disparador); clave de unicidad (empresa, tipo, número). El documento original sigue en `document`' },
      { column: 'document_legacy_duplicate', reason: 'DS-10: duplicado histórico marcado en la importación (Fase 7); se conserva sin fusionar y queda fuera de la unicidad' },
    ],
  },
  {
    dexieTable: 'sales', entity: 'Sale', source: 'models', sqlTable: 'adex.sales',
    fields: [
      id('id', 'id'), tenant, id('routeId', 'route_id'), id('clientId', 'client_id'), id('createdByUserId', 'created_by_membership_id'),
      money('valorVenta', 'sale_value_minor'), f('tasaInteres', 'interest_rate', 'num'), money('valorInteres', 'interest_value_minor'),
      money('valorTotal', 'total_value_minor'), money('saldo', 'balance_minor'), f('numeroCuotas', 'installments_count', 'int'),
      money('valorCuota', 'installment_value_minor'), f('frecuenciaPago', 'payment_frequency'), f('paymentDays', 'payment_days', 'days'),
      date('fechaInicio', 'start_date'), date('fechaFinalEstimada', 'estimated_end_date'), date('fechaFinalizacion', 'finished_on'),
      f('status', 'status'), f('disbursementStatus', 'disbursement_status'), id('disbursedByCollectorId', 'disbursed_by_collector_id'),
      id('disbursedByUserId', 'disbursed_by_membership_id'), date('fechaDesembolso', 'disbursement_date'), instant('disbursedAt', 'disbursed_at'),
      id('saleRequestId', 'sale_request_id'), f('motivoPerdida', 'lost_reason'), instant('lostAt', 'lost_at'),
      id('lostByUserId', 'lost_by_membership_id'), created, updated,
    ],
    omitted: [], added: [
      { column: 'ledger_operation_id', reason: 'Fase 4: asiento de desembolso del libro de capital del servidor (capital_operations); CLEAN no tiene libro de doble entrada' },
    ],
  },
  {
    dexieTable: 'installments', entity: 'Installment', source: 'models', sqlTable: 'adex.installments',
    fields: [
      id('id', 'id'), id('saleId', 'sale_id'), f('numero', 'number', 'int'), date('fechaVencimiento', 'due_date'),
      money('valor', 'amount_minor'), money('pagado', 'paid_minor'), money('saldo', 'balance_minor'), f('status', 'status'),
      f('diasMora', 'days_overdue', 'int'),
    ],
    omitted: [],
    added: [{ column: 'company_id', reason: 'P1/DS-15: aislamiento por empresa. En Dexie la parcela no lleva `tenantId`; se deriva de la venta y la FK compuesta (company_id, sale_id) impide otra empresa' }],
  },
  {
    dexieTable: 'payments', entity: 'Payment', source: 'models', sqlTable: 'adex.payments',
    fields: [
      id('id', 'id'), tenant, id('saleId', 'sale_id'), id('clientId', 'client_id'), id('routeId', 'route_id'),
      id('collectorId', 'collector_membership_id'), id('createdByUserId', 'created_by_membership_id'), money('valor', 'amount_minor'),
      date('fecha', 'payment_date'), f('tipo', 'payment_type'), f('observacion', 'note'), f('lat', 'lat', 'float'), f('lng', 'lng', 'float'),
      f('syncStatus', 'sync_status'), created, f('state', 'state'), id('reversesPaymentId', 'reverses_payment_id'),
      id('correctedByPaymentId', 'corrected_by_payment_id'), id('reversalPaymentId', 'reversal_payment_id'),
      id('correctionOfPaymentId', 'correction_of_payment_id'), f('correctionReason', 'correction_reason'),
      id('correctedBy', 'corrected_by_membership_id'), instant('correctedAt', 'corrected_at'),
    ],
    omitted: [], added: [
      { column: 'ledger_operation_id', reason: 'Fase 5: asiento COLLECTION (o su anulación) del libro de capital del servidor; CLEAN no tiene libro de doble entrada' },
      { column: 'principal_minor', reason: 'Fase 5: parte del abono que reduce la cartera (capital), en la proporción capital/total del crédito, acumulada' },
      { column: 'interest_minor', reason: 'Fase 5: parte del abono que es interés cobrado (cuenta income de la ruta); el interés solo existe como dinero al cobrarse' },
    ],
  },
  {
    dexieTable: 'noPaymentVisits', entity: 'NoPaymentVisit', source: 'models', sqlTable: 'adex.no_payment_visits',
    fields: [
      id('id', 'id'), tenant, id('saleId', 'sale_id'), id('clientId', 'client_id'), id('routeId', 'route_id'),
      id('collectorId', 'collector_membership_id'), f('motivo', 'reason'), date('fechaPromesaPago', 'promised_payment_date'),
      f('observacion', 'note'), date('fecha', 'visit_date'), f('syncStatus', 'sync_status'), created,
    ],
    omitted: [], added: [],
  },
  {
    dexieTable: 'expenseCategories', entity: 'ExpenseCategory', source: 'models', sqlTable: 'adex.expense_categories',
    fields: [id('id', 'id'), tenant, f('nombre', 'name'), f('icono', 'icon'), f('activa', 'active', 'bool')],
    omitted: [], added: [],
  },
  {
    dexieTable: 'expenses', entity: 'Expense', source: 'models', sqlTable: 'adex.expenses',
    fields: [
      id('id', 'id'), tenant, id('routeId', 'route_id'), f('scope', 'scope'), id('categoryId', 'category_id'), money('valor', 'amount_minor'),
      f('descripcion', 'description'), f('receiptPhotoDataUrl', 'receipt_photo_data_url'), date('fecha', 'expense_date'),
      id('userId', 'registered_by_membership_id'), id('collectorId', 'collector_membership_id'), f('funding', 'funding'),
      id('fundingAdminId', 'funding_admin_membership_id'), id('refundsExpenseId', 'refunds_expense_id'), f('referencia', 'reference'),
      f('syncStatus', 'sync_status'), created, ...REVERSAL,
    ],
    omitted: [], added: [
      { column: 'ledger_operation_id', reason: 'Fase 5: asiento del gasto (custodia, bolsa o empresa → cuenta de gastos) en el libro de capital del servidor' },
    ],
  },
  {
    dexieTable: 'capitalMovements', entity: 'CapitalMovement', source: 'models', sqlTable: 'adex.capital_movements',
    fields: [
      id('id', 'id'), tenant, id('routeId', 'route_id'), f('tipo', 'kind'), money('valor', 'amount_minor'), f('descripcion', 'description'),
      date('fecha', 'movement_date'), id('userId', 'registered_by_membership_id'), created, id('adminId', 'admin_membership_id'), ...REVERSAL,
    ],
    omitted: [{ field: 'centralLink', reason: 'Capital centralizado C1/C2 de CLEAN (2026-10-15): estado local por navegador. El SaaS empieza de cero y la Fase 3 implementa el modelo en PostgreSQL con su propio esquema; no se importa' }], added: [],
  },
  {
    dexieTable: 'transfers', entity: 'Transfer', source: 'models', sqlTable: 'adex.transfers',
    fields: [
      id('id', 'id'), tenant, f('routeOrigenId', 'route_origin_id', 'idOrEmpty'), id('routeDestinoId', 'route_destination_id'),
      f('origenType', 'origin_type'), f('destinoType', 'destination_type'), money('valor', 'amount_minor'), f('descripcion', 'description'),
      date('fecha', 'transfer_date'), id('userId', 'registered_by_membership_id'), created, id('adminId', 'admin_membership_id'), ...REVERSAL,
    ],
    omitted: [
      { field: 'socioOrigenId', reason: `Ronda 53 (2026-10-20): el rol Socio y Caja socios se retiraron de ADEX Online por decisión del propietario; la migración 0023 eliminó las columnas de socio: en el servidor solo existe Ruta → Ruta` },
      { field: 'socioDestinoId', reason: `Ronda 53 (2026-10-20): el rol Socio y Caja socios se retiraron de ADEX Online por decisión del propietario; la migración 0023 eliminó las columnas de socio: en el servidor solo existe Ruta → Ruta` },
    ], added: [],
  },
  {
    dexieTable: 'withdrawals', entity: 'Withdrawal', source: 'models', sqlTable: 'adex.withdrawals',
    fields: [
      id('id', 'id'), tenant, id('routeId', 'route_id'), money('valor', 'amount_minor'), f('descripcion', 'description'),
      date('fecha', 'withdrawal_date'), id('userId', 'registered_by_membership_id'), created, id('adminId', 'admin_membership_id'), ...REVERSAL,
    ],
    omitted: [{ field: 'centralLink', reason: 'Capital centralizado C1/C2 de CLEAN (2026-10-15): estado local por navegador. El SaaS empieza de cero y la Fase 3 implementa el modelo en PostgreSQL con su propio esquema; no se importa' }], added: [],
  },
  {
    dexieTable: 'cashboxMovements', entity: 'CashboxMovement', source: 'models', sqlTable: null,
    fields: [], omitted: [], added: [],
    dropped: 'Legado sin escritores: ningún servicio de src/ escribe en `cashboxMovements` (la Base sale de `getRouteBase` sobre los movimientos reales). El plan de migración (Fase 0) prevé que desaparezca. Si una base local tuviera filas, la importación las reporta como anomalía y no las convierte en dinero',
  },
  {
    dexieTable: 'weeklySettlements', entity: 'WeeklySettlement', source: 'models', sqlTable: 'adex.weekly_settlements',
    fields: [
      id('id', 'id'), tenant, id('routeId', 'route_id'), date('semanaInicio', 'week_start'), date('semanaFin', 'week_end'),
      money('saldoAnterior', 'opening_balance_minor'), money('ingresoCapital', 'capital_in_minor'), money('cobros', 'collections_minor'),
      money('prestamosEntregados', 'loans_disbursed_minor'), money('gastos', 'expenses_minor'),
      money('transferenciasEntradas', 'transfers_in_minor'), money('transferenciasSalidas', 'transfers_out_minor'),
      money('retiros', 'withdrawals_minor'), money('saldoFinal', 'closing_balance_minor'), created, f('status', 'status'),
      id('createdByUserId', 'created_by_membership_id'), instant('closedAt', 'closed_at'), id('closedByUserId', 'closed_by_membership_id'),
      instant('reopenedAt', 'reopened_at'), id('reopenedByUserId', 'reopened_by_membership_id'), f('reopenReason', 'reopen_reason'),
      f('version', 'version', 'int'), id('supersededBy', 'superseded_by'), id('officeIdAtClose', 'office_id_at_close'),
      f('officeNameAtClose', 'office_name_at_close'), f('officeCodeAtClose', 'office_code_at_close'),
      id('capitalControllerAdminIdAtClose', 'capital_controller_at_close_id'),
    ],
    omitted: [], added: [],
  },
  {
    dexieTable: 'auditLogs', entity: 'AuditLog', source: 'models', sqlTable: 'adex.audit_log',
    fields: [
      id('id', 'id'), tenant, f('userId', 'actor', 'actor'), f('userRole', 'actor_role'), id('routeId', 'route_id'), f('action', 'action'),
      f('entityType', 'entity_type'), f('entityId', 'entity_id'), f('descripcion', 'description'), f('before', 'before_data', 'json'),
      f('after', 'after_data', 'json'), f('motivo', 'reason'), f('metadata', 'metadata', 'json'), created,
    ],
    omitted: [], added: AUDIT_ADDED,
  },
  {
    dexieTable: 'saleRequests', entity: 'SaleRequest', source: 'models', sqlTable: 'adex.sale_requests',
    fields: [
      id('id', 'id'), tenant, id('clientId', 'client_id'), id('routeId', 'route_id'), id('collectorId', 'collector_membership_id'),
      money('amount', 'amount_minor'), f('interestRate', 'interest_rate', 'num'), money('totalAmount', 'total_amount_minor'),
      f('installmentsCount', 'installments_count', 'int'), money('installmentValue', 'installment_value_minor'), f('frequency', 'frequency'),
      date('startDate', 'start_date'), f('paymentDays', 'payment_days', 'days'), f('status', 'status'), instant('requestedAt', 'requested_at'),
      instant('reviewedAt', 'reviewed_at'), id('reviewedBy', 'reviewed_by_membership_id'), f('rejectionReason', 'rejection_reason'),
      f('approvalNotes', 'approval_notes'), id('saleId', 'sale_id'), id('requestedBy', 'requested_by_membership_id'),
      f('requestedInterestRate', 'requested_interest_rate', 'num'), f('requestedFrequency', 'requested_frequency'),
      f('requestedPaymentDays', 'requested_payment_days', 'days'), f('approvedInterestRate', 'approved_interest_rate', 'num'),
      f('approvedFrequency', 'approved_frequency'), f('approvedPaymentDays', 'approved_payment_days', 'days'),
      f('phoneConfirmed', 'phone_confirmed', 'bool'), f('phoneConfirmationNote', 'phone_confirmation_note'),
      f('activeCreditSaleIds', 'active_credit_sale_ids', 'texts'), f('activeCreditSnapshot', 'active_credit_snapshot_units', 'json'),
      f('authorizationReason', 'authorization_reason'),
    ],
    omitted: [], added: [
      { column: 'cancelled_at', reason: 'Fase 4: cancelación auditada de una solicitud aprobada sin desembolsar (en CLEAN, venta pendiente marcada perdida)' },
      { column: 'cancelled_by_membership_id', reason: 'Fase 4: quién canceló la solicitud aprobada (autoridad sale.cancel, Administrador o SuperAdmin)' },
      { column: 'cancel_reason', reason: 'Fase 4: motivo obligatorio de la cancelación de una solicitud aprobada que no se entregará' },
    ],
  },
  {
    dexieTable: 'partnerCashMovements', entity: 'PartnerCashMovement', source: 'models', sqlTable: null,
    fields: [], omitted: [], added: [],
    dropped: `Ronda 53 (2026-10-20): el rol Socio y Caja socios se retiraron de ADEX Online por decisión del propietario; la migración 0023 eliminó adex.partner_cash_movements (Caja socios). CLEAN la conserva para su propio uso`,
  },
  {
    dexieTable: 'paymentAdjustmentRequests', entity: 'PaymentAdjustmentRequest', source: 'models', sqlTable: 'adex.payment_adjustment_requests',
    fields: [
      id('id', 'id'), tenant, id('routeId', 'route_id'), id('paymentId', 'payment_id'), id('clientId', 'client_id'), id('saleId', 'sale_id'),
      id('requestedBy', 'requested_by_membership_id'), f('requestedByRole', 'requested_by_role'), instant('requestedAt', 'requested_at'),
      money('originalValor', 'original_amount_minor'), date('originalFecha', 'original_date'), f('reason', 'reason'),
      money('newValor', 'new_amount_minor'), date('newFecha', 'new_date'), f('observacion', 'note'), f('status', 'status'),
      id('reviewedBy', 'reviewed_by_membership_id'), instant('reviewedAt', 'reviewed_at'), f('rejectionReason', 'rejection_reason'),
      id('resultingReversalId', 'resulting_reversal_id'), id('resultingPaymentId', 'resulting_payment_id'),
    ],
    omitted: [], added: [],
  },
  {
    dexieTable: 'cashSettlements', entity: 'CashSettlement', source: 'models', sqlTable: 'adex.cash_settlements',
    fields: [
      id('id', 'id'), tenant, id('routeId', 'route_id'), id('userId', 'worker_membership_id'), instant('desde', 'period_from'),
      instant('hasta', 'period_to'), f('origenDesde', 'period_from_origin'), id('previousSettlementId', 'previous_settlement_id'),
      money('arrastreAnterior', 'carried_over_minor'), money('baseRecibida', 'base_received_minor'), money('baseDevuelta', 'base_returned_minor'),
      money('recaudado', 'collected_minor'), money('desembolsado', 'disbursed_minor'), money('gastos', 'expenses_minor'),
      money('esperado', 'expected_minor'), money('entregado', 'delivered_minor'), money('diferencia', 'difference_minor'),
      money('faltante', 'shortage_minor'), money('sobrante', 'surplus_minor'), f('motivo', 'reason'), f('status', 'status'),
      f('version', 'version', 'int'), id('supersededBy', 'superseded_by'), created, instant('closedAt', 'closed_at'),
      id('closedByUserId', 'closed_by_membership_id'), instant('reopenedAt', 'reopened_at'), id('reopenedByUserId', 'reopened_by_membership_id'),
      f('reopenReason', 'reopen_reason'), id('capitalControllerAdminIdAtClose', 'capital_controller_at_close_id'),
    ],
    omitted: [], added: [],
  },
  {
    dexieTable: 'cashCustodyMovements', entity: 'CashCustodyMovement', source: 'models', sqlTable: 'adex.cash_custody_movements',
    fields: [
      id('id', 'id'), tenant, id('routeId', 'route_id'), f('tipo', 'kind'), money('amount', 'amount_minor'), id('fromUserId', 'from_membership_id'),
      id('toUserId', 'to_membership_id'), f('origen', 'origin'), id('relatedTransferId', 'related_transfer_id'), f('motivo', 'reason'),
      date('fecha', 'movement_date'), created, id('createdByUserId', 'created_by_membership_id'), ...REVERSAL,
    ],
    omitted: [{ field: 'centralLink', reason: 'Capital centralizado C1/C2 de CLEAN (2026-10-15): estado local por navegador. El SaaS empieza de cero y la Fase 3 implementa el modelo en PostgreSQL con su propio esquema; no se importa' }, { field: 'saleRequestId', reason: 'Capital centralizado C1/C2 de CLEAN (2026-10-15): estado local por navegador. El SaaS empieza de cero y la Fase 3 implementa el modelo en PostgreSQL con su propio esquema; no se importa' }], added: [],
  },
  {
    dexieTable: 'capitalLedger', entity: 'CapitalLedgerEntry', source: 'models', sqlTable: 'adex.capital_ledger',
    fields: [
      id('id', 'id'), tenant, f('tipo', 'kind'), money('amount', 'amount_minor'), id('fromAdminId', 'from_admin_membership_id'),
      id('toAdminId', 'to_admin_membership_id'), id('routeId', 'route_id'), id('relatedEventId', 'related_event_id'),
      f('descripcion', 'description'), date('fecha', 'entry_date'), created, f('actorUserId', 'actor', 'actor'), f('actorRole', 'actor_role'),
      f('status', 'status'), f('syncStatus', 'sync_status'), ...REVERSAL,
    ],
    omitted: [{ field: 'partnerId', reason: 'Capital centralizado C1/C2 de CLEAN (2026-10-15): estado local por navegador. El SaaS empieza de cero y la Fase 3 implementa el modelo en PostgreSQL con su propio esquema; no se importa' }], added: [],
  },
  {
    dexieTable: 'routeCapitalControllerEvents', entity: 'RouteCapitalControllerEvent', source: 'models', sqlTable: 'adex.route_capital_controller_events',
    fields: [
      id('id', 'id'), tenant, id('routeId', 'route_id'), f('kind', 'kind'), id('fromAdminId', 'from_admin_membership_id'),
      id('toAdminId', 'to_admin_membership_id'), money('capitalTransferido', 'capital_transferred_minor'),
      money('baseAlCambio', 'base_at_change_minor'), id('ledgerEntryId', 'ledger_entry_id'), f('motivo', 'reason'), created,
      f('actorUserId', 'actor', 'actor'), f('actorRole', 'actor_role'), f('syncStatus', 'sync_status'),
    ],
    omitted: [], added: [],
  },
  // ---------- Plano de control (Dexie v13) ----------
  {
    dexieTable: 'platformUsers', entity: 'PlatformUser', source: 'platform', sqlTable: 'adex_control.platform_operators',
    fields: [
      id('id', 'id'), f('nombre', 'display_name'), f('email', 'adex.identities', 'identityEmail'), f('rol', 'role'), f('status', 'status'),
      instant('firstLoginAt', 'first_login_at'), instant('lastLoginAt', 'last_login_at'), created, updated,
    ],
    omitted: [{ field: 'password', reason: 'DS-03 y CONTROL_PLANE §3.4: «no debe portarse el esquema actual». La credencial la gestiona el proveedor de identidad' }],
    added: [{ column: 'identity_id', reason: 'El Owner se autentica con el proveedor central; su identidad NO es una membresía de empresa' }],
  },
  {
    dexieTable: 'companyControl', entity: 'CompanyControlRecord', source: 'platform', sqlTable: 'adex_control.company_control',
    fields: [
      id('companyId', 'company_id'), f('nombre', 'name'), f('identificacion', 'tax_id'), f('contacto', 'contact_name'),
      f('contactoEmail', 'contact_email'), created, instant('firstLoginAt', 'first_login_at'), instant('lastLoginAt', 'last_login_at'),
      f('status', 'status'), f('routeCount', 'route_count', 'int'), f('billableRouteCount', 'billable_route_count', 'int'),
      f('billingMode', 'billing_mode'), f('billingRate', 'billing_rate', 'decimal'), date('nextBillingDate', 'next_billing_date'),
      f('paymentStatus', 'payment_status'), updated,
    ],
    omitted: [], added: [],
  },
  {
    dexieTable: 'saasPayments', entity: 'SaaSPayment', source: 'platform', sqlTable: 'adex_control.saas_payments',
    fields: [
      id('id', 'id'), id('companyId', 'company_id'), f('periodo', 'period'), f('valor', 'amount', 'decimal'), date('fechaEsperada', 'expected_date'),
      date('fechaPagada', 'paid_date'), f('status', 'status'), f('nota', 'note'), created, updated,
    ],
    omitted: [], added: [],
  },
  {
    dexieTable: 'controlEvents', entity: 'ControlEvent', source: 'platform', sqlTable: 'adex_control.control_events',
    fields: [id('id', 'id'), id('companyId', 'company_id'), f('type', 'type'), instant('at', 'at'), f('detail', 'detail')],
    omitted: [],
    added: [{ column: 'actor_identity_id', reason: 'Ronda 40 (0021): autor de cada evento administrativo, sellado por el servidor con la identidad del contexto; CLEAN no lo registraba' }],
  },
];

export function tableMap(dexieTable: string): TableMap {
  const t = DEXIE_V16_TABLES.find((x) => x.dexieTable === dexieTable);
  if (!t) throw new Error(`unknown Dexie table ${dexieTable}`);
  return t;
}

/** Columnas SQL «planas» que produce el mapa (sin relaciones ni actor). */
export function plainColumns(t: TableMap): string[] {
  const cols: string[] = [];
  for (const m of t.fields) {
    if (m.kind === 'identityEmail' || m.kind === 'routeList') continue;
    if (m.kind === 'actor') cols.push(`${m.column}_membership_id`, `${m.column}_system`);
    else cols.push(m.column);
  }
  return cols;
}
