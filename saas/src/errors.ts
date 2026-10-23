export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Datos estructurados para el cliente (p. ej. referencias que impiden un borrado). */
  readonly details?: Record<string, unknown>;
  constructor(status: number, code: string, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Unicidades con significado de negocio: el índice que salta dice qué está duplicado.
const UNIQUE_CODES: Record<string, string> = {
  clients_document_key: 'DOCUMENT_DUPLICATE',                    // DS-10
  offices_company_name_key: 'OFFICE_NAME_DUPLICATE',
  offices_company_code_key: 'OFFICE_CODE_DUPLICATE',
  expense_categories_company_name_key: 'CATEGORY_NAME_DUPLICATE',
  sale_requests_one_pending_per_client: 'PENDING_REQUEST_EXISTS',     // una solicitud pendiente por cliente
  identities_email_key: 'EMAIL_TAKEN',                                // Ronda 54: el correo ya es de otra identidad
};

/** Traduce errores de PostgreSQL que la API sabe explicar; el resto es 500. */
export function fromPgError(err: unknown): ApiError | null {
  const e = typeof err === 'object' && err !== null ? (err as { code?: string; constraint?: string; message?: string }) : {};
  switch (e.code) {
    case '42501': return new ApiError(403, 'PERMISSION_DENIED');       // segunda barrera (RLS/privilegios)
    case '55P03': return new ApiError(503, 'REVOCATION_IN_PROGRESS');  // lock_timeout: una revocación tiene el bloqueo
    case '23505': return new ApiError(409, UNIQUE_CODES[e.constraint ?? ''] ?? 'CONFLICT');
    case '23503': return new ApiError(404, 'NOT_FOUND');
    case '23514': return new ApiError(400, 'INVALID_INPUT');
    case '2BP01': return new ApiError(409, 'HAS_HISTORY');             // DS-11: historia protegida
    case 'AX101': return new ApiError(409, 'CAPITAL_CONTROLLER_INVALID'); // v16, comprobado al COMMIT
    case 'AX201': return new ApiError(400, 'INVALID_DOCUMENT_TYPE');
    case 'AX202': return new ApiError(400, 'INVALID_DOCUMENT');
    case 'AX301': return new ApiError(409, 'ROUTE_NOT_OPERATIONAL');
    case 'AX302': return new ApiError(400, 'INVALID_COLLECTOR');
    // D74-H1/O7 (DS-05 enmendada): varios perfiles en una empresa solo para el Administrador; nunca con SuperAdmin.
    case 'AX313': return new ApiError(409, 'ROLE_ACCUMULATION_FORBIDDEN');
    // Fase 3 · `adex.capital_post` (segunda barrera, bajo bloqueo). Sin cifras de saldos.
    case 'AX401': return new ApiError(409, 'INSUFFICIENT_FUNDS');
    case 'AX402': return new ApiError(403, 'CAPITAL_AUTHORITY_REQUIRED');
    case 'AX403': return new ApiError(400, 'CUSTODIAN_INVALID');
    case 'AX404': return new ApiError(409, 'REVERSAL_NOT_ALLOWED');
    case 'AX405': return new ApiError(409, 'ALREADY_REVERSED');
    case 'AX406': return new ApiError(409, 'DECISION_PENDING_D2');
    case 'AX407': return new ApiError(409, 'PERIOD_CLOSED');
    case 'AX408': return new ApiError(409, 'CAPITAL_CONTROLLER_MISSING');
    case 'AX409': return new ApiError(409, 'OPERATION_ID_REUSED');
    case 'AX410': return new ApiError(403, 'SELF_REDUCTION_FORBIDDEN');
    case 'AX411': return new ApiError(400, 'INVALID_INPUT');
    case 'AX412': return new ApiError(404, 'NOT_FOUND');
    case 'AX413': return new ApiError(409, 'FUNDS_ALREADY_USED');
    // Ronda 53 · traspasos entre Administradores.
    case 'AX414': return new ApiError(409, 'TRANSFER_NOT_PENDING');
    case 'AX415': return new ApiError(409, 'DECISION_ALREADY_REGISTERED');
    case 'AX416': return new ApiError(403, 'REGISTRANT_CANNOT_BE_PARTY');
    // Ronda 59 · solicitudes de capital (no mueven dinero; se atienden con el comando ordinario).
    case 'AX417': return new ApiError(409, 'REQUEST_NOT_PENDING');
    case 'AX418': return new ApiError(409, 'REQUEST_MISMATCH');
    // R74 (0033, DS-05): nadie entrega capital a su propia custodia, tampoco con otra membresía.
    case 'AX419': return new ApiError(403, 'SELF_DELIVERY_FORBIDDEN');   // entregar o traspasar efectivo a la propia custodia
    // R74 · Base por Ruta (0034). Sin cifras de saldos.
    case 'AX421': return new ApiError(409, 'CAPITAL_MODEL_OPERATION_REFUSED');  // capital de empresa / bolsas con `route_base`
    case 'AX422': return new ApiError(409, 'CAPITAL_MIGRATION_IN_PROGRESS');    // empresa en `migrating`
    case 'AX423': return new ApiError(409, 'ROUTE_IN_HANDOVER');                // ruta «en entrega»: falta el conteo del nuevo responsable
    case 'AX424': return new ApiError(409, 'ROUTE_SCOPE_VIOLATION');            // una pata de otra ruta (segunda barrera)
    case 'AX425': return new ApiError(409, 'ACTIVATION_PREREQUISITES_FAILED');  // activar `route_base` sin cumplir requisitos
    case 'AX426': return new ApiError(409, 'GENERAL_EXPENSE_FUNDING_PENDING');  // O4: financiación del gasto general sin decidir
    case 'AX427': return new ApiError(409, 'HANDOVER_NOT_PENDING');
    case 'AX428': return new ApiError(409, 'ROUTE_BASE_NOT_ACTIVE');            // comando de Base en una empresa sin `route_base`
    // Fase 4 · solicitudes y desembolsos.
    case 'AX501': return new ApiError(409, 'REQUEST_STATE_INVALID');
    case 'AX502': return new ApiError(400, 'INTEREST_RATE_NOT_ALLOWED');
    case 'AX503': return new ApiError(400, 'INVALID_CONDITIONS');
    case 'AX504': return new ApiError(409, 'CLIENT_NOT_ACTIVE');
    case 'AX505': return new ApiError(403, 'SELF_APPROVAL_FORBIDDEN');
    case 'AX506': return new ApiError(409, 'REQUEST_NOT_DISBURSABLE');
    case 'AX507': return new ApiError(409, 'DIRECT_SALE_LIMIT');
    // Ronda 73 · rectificación de créditos desembolsados (0030).
    case 'AX520': return new ApiError(409, 'CREDIT_HAS_COLLECTIONS');
    case 'AX521': return new ApiError(409, 'DISBURSEMENT_SETTLED');
    case 'AX522': return new ApiError(409, 'CUSTODIAN_CHANGED');
    case 'AX523': return new ApiError(409, 'CREDIT_CHANGED');
    case 'AX524': return new ApiError(400, 'NOTHING_TO_RECTIFY');
    // Bloque A post-R73 (0032): rectificación con pagos y reaplicación de pagos anulados.
    case 'AX525': return new ApiError(409, 'OVERPAYMENT');
    case 'AX526': return new ApiError(409, 'LEGACY_PAYMENTS');
    case 'AX527': return new ApiError(409, 'PAYMENT_ADJUSTMENT_PENDING');
    case 'AX528': return new ApiError(409, 'PAYMENT_NOT_REAPPLICABLE');
    case 'AX529': return new ApiError(409, 'REVERSAL_SETTLED');
    // Fase 5 · recaudos y gastos (0013). Sin cifras de saldos.
    case 'AX701': return new ApiError(409, 'CREDIT_NOT_ACTIVE');
    case 'AX702': return new ApiError(409, 'CREDIT_NOT_DISBURSED');
    case 'AX703': return new ApiError(409, 'CREDIT_NOT_LEDGERED');
    case 'AX704': return new ApiError(409, 'CREDIT_WITHOUT_INSTALLMENTS');
    case 'AX705': return new ApiError(409, 'CREDIT_NO_BALANCE');
    case 'AX706': return new ApiError(409, 'NOT_CORRECTABLE_HERE');
    case 'AX707': return new ApiError(400, 'COLLECTOR_REQUIRED');
    case 'AX708': return new ApiError(400, 'COLLECTOR_INVALID');
    case 'AX711': return new ApiError(400, 'CATEGORY_INVALID');
    case 'AX712': return new ApiError(403, 'POOL_NOT_ALLOWED');
    case 'AX713': return new ApiError(409, 'REFUND_NOT_ALLOWED');
    case 'AX714': return new ApiError(409, 'REFUND_EXCEEDS_EXPENSE');
    case 'AX715': return new ApiError(409, 'EXPENSE_HAS_REFUNDS');
    case 'AX717': return new ApiError(403, 'SELF_CORRECTION_FORBIDDEN');   // F5-D02: quien registró no anula
    // Fase 6 · cuadres y cierres (0014). Sin cifras de saldos.
    case 'AX801': return new ApiError(403, 'SELF_SETTLEMENT_FORBIDDEN');   // nadie se cuadra (ni reabre) a sí mismo
    case 'AX802': return new ApiError(409, 'SETTLEMENT_STALE');            // las cifras cambiaron desde la vista previa
    case 'AX803': return new ApiError(400, 'REASON_REQUIRED');
    case 'AX804': return new ApiError(409, 'PERIOD_NOT_ENDED');            // D29
    case 'AX805': return new ApiError(409, 'PERIOD_OVERLAP');
    case 'AX806': return new ApiError(409, 'SETTLEMENT_NOT_REOPENABLE');
    // ADEX Online · corrección de pagos (0017).
    case 'AX807': return new ApiError(409, 'ADJUSTMENT_REQUIRED');         // periodo cerrado: solicitud de ajuste
    // ADEX Online v1 · ciclo de vida de la Empresa Demo (0011).
    case 'AX601': return new ApiError(409, 'DEMO_BUSY');
    case 'AX603': return new ApiError(409, 'DEMO_TARGET_MISMATCH');
    case 'AX604': return new ApiError(409, 'DEMO_NOT_LIVE');
    case 'AX611': return new ApiError(400, 'INVALID_INPUT');
    case 'AX612': return new ApiError(409, 'PARTICIPANT_NOT_USABLE');
    default: return null;
  }
}
