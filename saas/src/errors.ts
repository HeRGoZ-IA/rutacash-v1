export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

/** Traduce errores de PostgreSQL que la API sabe explicar; el resto es 500. */
export function fromPgError(err: unknown): ApiError | null {
  const code = typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
  switch (code) {
    case '42501': return new ApiError(403, 'PERMISSION_DENIED');       // segunda barrera (RLS/privilegios)
    case '55P03': return new ApiError(503, 'REVOCATION_IN_PROGRESS');  // lock_timeout: una revocación tiene el bloqueo
    case '23505': return new ApiError(409, 'CONFLICT');
    case '23503': return new ApiError(404, 'NOT_FOUND');
    case '23514': return new ApiError(400, 'INVALID_INPUT');
    default: return null;
  }
}
