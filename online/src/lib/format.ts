// Presentación. Los importes llegan y se envían en UNIDADES MENORES (enteros); aquí
// solo se convierten para mostrarlos o leerlos de un campo de texto.

const ERRORS: Record<string, string> = {
  INVALID_CREDENTIALS: 'Correo o contraseña incorrectos.',
  AUTH_UNAVAILABLE: 'El servicio de acceso no responde. Inténtelo de nuevo.',
  SESSION_EXPIRED: 'La sesión caducó. Inicie sesión de nuevo.',
  SESSION_REVOKED: 'La sesión fue cerrada. Inicie sesión de nuevo.',
  IDENTITY_NOT_PROVISIONED: 'Su usuario todavía no tiene acceso a ninguna empresa.',
  IDENTITY_DISABLED: 'Su usuario está desactivado.',
  COMPANY_BLOCKED: 'La empresa no está disponible (suspendida, en mantenimiento o retirada).',
  MEMBERSHIP_INACTIVE: 'Esa membresía ya no está activa.',
  MEMBERSHIP_NOT_FOUND: 'Esa membresía ya no existe.',
  PERMISSION_DENIED: 'Su rol no permite esta operación.',
  INSUFFICIENT_FUNDS: 'No hay fondos suficientes para esta operación.',
  CAPITAL_AUTHORITY_REQUIRED: 'Solo el Administrador responsable de la ruta puede hacerlo.',
  SELF_APPROVAL_FORBIDDEN: 'Nadie puede resolver su propia solicitud (tampoco con otra membresía).',
  SELF_REDUCTION_FORBIDDEN: 'Nadie registra la reducción de su propia custodia.',
  REQUEST_STATE_INVALID: 'La solicitud cambió de estado. Se recargó la información.',
  REQUEST_NOT_DISBURSABLE: 'La solicitud ya no se puede desembolsar.',
  PENDING_REQUEST_EXISTS: 'Ese cliente ya tiene una solicitud pendiente.',
  INTEREST_RATE_NOT_ALLOWED: 'Tasa no permitida para su rol (el Cobrador solicita al 20 %).',
  INVALID_CONDITIONS: 'Condiciones no válidas (la fecha de inicio no puede ser anterior a hoy).',
  CLIENT_NOT_ACTIVE: 'El cliente no está activo.',
  DOCUMENT_DUPLICATE: 'Ya existe un cliente con ese documento en la empresa.',
  INVALID_DOCUMENT: 'El documento no es válido para el tipo elegido.',
  ROUTE_NOT_OPERATIONAL: 'La ruta no admite operaciones nuevas.',
  PERIOD_CLOSED: 'El periodo está cerrado.',
  OPERATION_ID_REUSED: 'Operación duplicada con otros datos.',
  REVOCATION_IN_PROGRESS: 'Hay un cambio de permisos en curso. Inténtelo en unos segundos.',
  RATE_LIMITED: 'Demasiadas peticiones. Espere un momento.',
  DEMO_BUSY: 'La Empresa Demo está ocupada con otra operación administrativa.',
  DEMO_TARGET_MISMATCH: 'El ID no corresponde a la Empresa Demo vigente.',
  CONFIRMATION_MISMATCH: 'La confirmación no coincide con el ID interno.',
  DEMO_OPERATOR_REQUIRED: 'Su usuario no administra la Empresa Demo.',
  DEMO_PROVISIONING_FAILED: 'No se pudo preparar la Empresa Demo. La anterior se mantuvo.',
  NETWORK: 'Sin conexión con el servidor.',
  UNCERTAIN_OPERATION: 'No se pudo confirmar la operación. Compruebe antes de repetirla.',
};

export function errorText(err: unknown): string {
  const code = (err as { code?: string })?.code ?? (err as Error)?.message ?? 'ERROR';
  return ERRORS[code] ?? `No se pudo completar (${code}).`;
}

export function money(minor: number | null | undefined, currency: string, minorUnits: number): string {
  if (minor === null || minor === undefined || Number.isNaN(minor)) return '—';
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, minimumFractionDigits: minorUnits, maximumFractionDigits: minorUnits })
    .format(minor / 10 ** minorUnits);
}

/**
 * Texto → unidades menores. Acepta «1.234,56», «1,234.56», «1234.5» o «1234».
 * El último separador seguido de 1–minorUnits dígitos es el decimal.
 */
export function parseMoney(text: string, minorUnits: number): number | null {
  const t = text.replace(/\s/g, '');
  if (!/^\d[\d.,]*$/.test(t)) return null;
  const last = Math.max(t.lastIndexOf(','), t.lastIndexOf('.'));
  let units = t;
  let decimals = '';
  if (last >= 0 && t.length - last - 1 >= 1 && t.length - last - 1 <= minorUnits) {
    units = t.slice(0, last);
    decimals = t.slice(last + 1);
  }
  units = units.replace(/[.,]/g, '');
  if (!units) units = '0';
  const value = Number(units) * 10 ** minorUnits + Number(decimals.padEnd(minorUnits, '0') || '0');
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return d.toLocaleString('es-CO', iso.length === 10 ? { dateStyle: 'medium' } : { dateStyle: 'short', timeStyle: 'short' });
}

export function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export const ROLE: Record<string, string> = {
  superadmin: 'Super Admin', admin: 'Administrador', socio: 'Socio', supervisor: 'Supervisor', cobrador: 'Cobrador', secretario: 'Secretario',
};

export const REQUEST_STATUS: Record<string, string> = {
  pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada', disbursed: 'Desembolsada', cancelled: 'Cancelada',
};

export const FREQUENCY: Record<string, string> = {
  diaria: 'Diaria', semanal: 'Semanal', quincenal: 'Quincenal', mensual: 'Mensual', personalizada: 'Personalizada',
};

export const OPERATION_KIND: Record<string, string> = {
  COMPANY_DEPOSIT: 'Aporte a la empresa', COMPANY_WITHDRAWAL: 'Retiro de la empresa', ADMIN_ALLOCATION: 'Asignación a bolsa',
  ADMIN_RETURN: 'Devolución de bolsa', PARTNER_CONTRIBUTION: 'Aporte de socio', WORKER_DELIVERY: 'Entrega al trabajador',
  WORKER_RETURN: 'Devolución del trabajador', WORKER_TRANSFER: 'Traspaso entre trabajadores', ROUTE_REASSIGNMENT: 'Reasignación entre rutas',
  REVERSAL: 'Anulación', LOAN_DISBURSEMENT: 'Desembolso de crédito',
};
