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
    default: return null;
  }
}
