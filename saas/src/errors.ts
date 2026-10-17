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
    // Fase 4 · solicitudes y desembolsos.
    case 'AX501': return new ApiError(409, 'REQUEST_STATE_INVALID');
    case 'AX502': return new ApiError(400, 'INTEREST_RATE_NOT_ALLOWED');
    case 'AX503': return new ApiError(400, 'INVALID_CONDITIONS');
    case 'AX504': return new ApiError(409, 'CLIENT_NOT_ACTIVE');
    case 'AX505': return new ApiError(403, 'SELF_APPROVAL_FORBIDDEN');
    case 'AX506': return new ApiError(409, 'REQUEST_NOT_DISBURSABLE');
    case 'AX507': return new ApiError(409, 'DIRECT_SALE_LIMIT');
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
    // ADEX Online v1 · ciclo de vida de la Empresa Demo (0011).
    case 'AX601': return new ApiError(409, 'DEMO_BUSY');
    case 'AX603': return new ApiError(409, 'DEMO_TARGET_MISMATCH');
    case 'AX604': return new ApiError(409, 'DEMO_NOT_LIVE');
    case 'AX611': return new ApiError(400, 'INVALID_INPUT');
    case 'AX612': return new ApiError(409, 'PARTICIPANT_NOT_USABLE');
    default: return null;
  }
}
