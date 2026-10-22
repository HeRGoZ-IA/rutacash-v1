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
  // Ronda 53 · transferencias entre Administradores.
  TRANSFER_NOT_PENDING: 'Esta transferencia ya no está pendiente.',
  DECISION_ALREADY_REGISTERED: 'Tu decisión ya estaba registrada.',
  REGISTRANT_CANNOT_BE_PARTY: 'Quien registra la transferencia no puede ser una de las partes.',
  CAPITAL_AUTHORITY_REQUIRED: 'Solo el Administrador responsable de la ruta puede hacerlo.',
  SELF_APPROVAL_FORBIDDEN: 'Nadie puede resolver su propia solicitud (tampoco con otra membresía).',
  SELF_REDUCTION_FORBIDDEN: 'Nadie registra la reducción de su propia custodia.',
  REQUEST_STATE_INVALID: 'La solicitud cambió de estado. Se recargó la información.',
  REQUEST_NOT_DISBURSABLE: 'La solicitud ya no se puede desembolsar.',
  // Ronda 73 · corrección de ventas desembolsadas (SOC-09).
  CREDIT_HAS_COLLECTIONS: 'La venta ya tiene cobros registrados: no se puede corregir.',
  DISBURSEMENT_SETTLED: 'El desembolso ya está incluido en un cuadre: no se puede corregir.',
  CUSTODIAN_CHANGED: 'El trabajador que entregó el dinero ya no tiene caja en esta ruta: la corrección necesita una revisión aparte.',
  CREDIT_CHANGED: 'La venta cambió mientras la corregía. Vuelva a abrirla y revise los datos.',
  NOTHING_TO_RECTIFY: 'No hay cambios que corregir.',
  INSTALLMENTS_REDUCTION_BLOCKED: 'No se puede reducir el número de parcelas de una venta desembolsada (decisión pendiente del propietario).',
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
  CREDIT_NOT_ACTIVE: 'Este crédito no está activo: no admite abonos.',
  CREDIT_NOT_DISBURSED: 'Este crédito aún no está desembolsado.',
  CREDIT_NOT_LEDGERED: 'Este crédito no se originó en el servidor: no admite abonos aquí.',
  CREDIT_WITHOUT_INSTALLMENTS: 'El crédito no tiene cuotas generadas.',
  CREDIT_NO_BALANCE: 'Este crédito ya no tiene saldo pendiente.',
  COLLECTOR_REQUIRED: 'Indique quién recibió el dinero.',
  COLLECTOR_INVALID: 'Esa persona no puede responder por el efectivo de esta ruta (los cobros que registra un trabajador son suyos).',
  CUSTODIAN_INVALID: 'Esa persona no puede tener efectivo en esta ruta.',
  FUNDS_ALREADY_USED: 'Ese efectivo ya no está en manos de quien lo recibió (fue entregado, usado o cubre un negativo).',
  ALREADY_REVERSED: 'Ya estaba anulado.',
  REVERSAL_NOT_ALLOWED: 'Este movimiento no se puede anular por esta vía.',
  NOT_CORRECTABLE_HERE: 'Registro histórico o importado: no se corrige desde aquí.',
  CATEGORY_INVALID: 'Seleccione una categoría válida.',
  POOL_NOT_ALLOWED: 'No puede pagar con esa bolsa (cada Administrador solo con la suya).',
  REFUND_NOT_ALLOWED: 'Solo los gastos administrativos (de bolsa) admiten reintegros.',
  REFUND_EXCEEDS_EXPENSE: 'El reintegro supera lo que queda por reintegrar de este gasto.',
  EXPENSE_HAS_REFUNDS: 'El gasto ya tiene reintegros: registre un reintegro por el resto en lugar de anularlo.',
  SELF_CORRECTION_FORBIDDEN: 'Quien registró el gasto no puede anularlo (tampoco con otra membresía): debe hacerlo otra persona autorizada.',
  CAPITAL_CONTROLLER_MISSING: 'La ruta no tiene Administrador responsable de capital válido.',
  MEMBER_INACTIVE: 'Esa persona está inactiva.',
  SELF_SETTLEMENT_FORBIDDEN: 'Nadie cuadra (ni reabre) su propio efectivo, tampoco con otra membresía: debe hacerlo otra persona autorizada.',
  SETTLEMENT_STALE: 'Las cifras cambiaron desde la vista previa (hubo movimientos nuevos u otro cuadre). Revise el nuevo esperado antes de cerrar.',
  REASON_REQUIRED: 'Explique el motivo (mínimo 10 caracteres).',
  PERIOD_NOT_ENDED: 'Ese periodo todavía no ha terminado en la fecha de la empresa: aún no se puede cerrar.',
  PERIOD_OVERLAP: 'Ese rango ya está cerrado o se solapa con un periodo cerrado.',
  SETTLEMENT_NOT_REOPENABLE: 'Solo se puede reabrir el último cuadre vigente de esa persona.',
  NOT_FOUND: 'No encontrado o fuera de su alcance.',
  NETWORK: 'Sin conexión con el servidor.',
  UNCERTAIN_OPERATION: 'No se pudo confirmar la operación. Compruebe antes de repetirla.',
  // Administración de la empresa (usuarios, oficinas, rutas, categorías, datos).
  INVALID_EMAIL: 'El correo no es válido.',
  INVALID_ROLE: 'Seleccione un rol válido.',
  INVALID_NAME: 'Indique el nombre de la persona.',
  INVALID_ROUTES: 'La selección de rutas no es válida.',
  CONFLICT: 'Ya existe un registro igual. Si es una persona: ya tiene una membresía con ese rol en esta empresa.',
  IDENTITY_PROVIDER_ERROR: 'El servicio de identidad no respondió: la persona no se dio de alta. Inténtelo de nuevo.',
  LAST_SUPERADMIN: 'La empresa no puede quedarse sin ningún Super Admin activo.',
  CANNOT_DELETE_SELF: 'No puede eliminar su propia membresía.',
  HAS_HISTORY: 'Tiene historia (movimientos, asignaciones o actos registrados): no se puede eliminar. Desactívelo en su lugar.',
  SUPERADMIN_IS_UNRESTRICTED: 'El Super Admin accede a todas las rutas: no se le asignan rutas.',
  OFFICE_NAME_DUPLICATE: 'Ya existe una oficina con ese nombre.',
  OFFICE_CODE_DUPLICATE: 'Ya existe una oficina con ese código.',
  OFFICE_HAS_ROUTES: 'La oficina tiene rutas: confirme que queden «Sin oficina» para poder eliminarla.',
  OFFICE_NOT_FOUND: 'La oficina no existe o fue eliminada.',
  ROUTE_NOT_FOUND: 'Alguna ruta no existe o fue eliminada.',
  CATEGORY_NAME_DUPLICATE: 'Ya existe una categoría con ese nombre.',
  INVALID_ADMIN: 'El Administrador elegido no es válido (debe estar activo y tener el rol Administrador).',
  INVALID_COLLECTOR: 'El Cobrador responsable no es válido: debe estar activo, tener el rol Cobrador y quedar asignado a la ruta.',
  ROUTE_INITIAL_CAPITAL_NOT_ALLOWED: 'La ruta no tiene caja propia: el capital se entrega a los trabajadores desde la bolsa del Administrador responsable.',
  CAPITAL_CONTROLLER_REQUIRED: 'Esa persona es la responsable de capital de la ruta y quedan otros Administradores asignados: elija antes el nuevo responsable.',
  CAPITAL_CONTROLLER_INVALID: 'El responsable de capital debe ser un Administrador activo asignado a la ruta.',
  ALREADY_CONTROLLER: 'Esa persona ya es la responsable de capital de la ruta.',
  UNKNOWN_FIELD: 'El servidor rechazó un dato no admitido.',
  // Ronda 62: modo sin conexión del Cobrador y exclusividad de ruta.
  OFFLINE_AMOUNT_EXCEEDS_BALANCE: 'El abono ya no cabe en el saldo actual del crédito (la oficina registró otro movimiento). No se registró: revíselo con la oficina.',
  OFFLINE_NOT_ALLOWED: 'Solo el Cobrador puede registrar operaciones sin conexión.',
  ROUTE_HAS_ACTIVE_COLLECTOR: 'La ruta tiene un Cobrador activo: solo él registra abonos y visitas. Para sustituirlo, la oficina debe bloquearlo antes.',
  OFFLINE_KEY_UNAVAILABLE: 'No se pudo preparar el modo sin conexión en este dispositivo.',
};

const FIELD: Record<string, string> = {
  name: 'Nombre', code: 'Código', city: 'Ciudad', email: 'Correo', phone: 'Teléfono', interestRate: 'Tasa de interés', freeRate: 'Tasa libre',
  maxLoanMinor: 'Préstamo máximo', officeId: 'Oficina', collectorId: 'Cobrador', memberIds: 'Personas asignadas', adminIds: 'Administradores',
  capitalControllerId: 'Responsable de capital', membershipId: 'Responsable de capital', reason: 'Motivo', displayName: 'Nombre', icon: 'Icono',
  legalName: 'Razón social', taxId: 'Identificación tributaria', address: 'Dirección', contactName: 'Persona de contacto', routeIds: 'Rutas',
  selectedRouteIds: 'Rutas', status: 'Estado',
};

export function errorText(err: unknown): string {
  const code = (err as { code?: string })?.code ?? (err as Error)?.message ?? 'ERROR';
  if (code === 'INVALID_INPUT') {
    const field = (err as { details?: { field?: unknown } })?.details?.field;
    return typeof field === 'string' ? `Revise el campo «${FIELD[field] ?? field}».` : 'Hay datos no válidos. Revise el formulario.';
  }
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
  ADMIN_RETURN: 'Devolución de bolsa', PARTNER_CONTRIBUTION: 'Aporte externo (histórico)', WORKER_DELIVERY: 'Entrega al trabajador',
  WORKER_RETURN: 'Devolución del trabajador', WORKER_TRANSFER: 'Traspaso entre trabajadores', ROUTE_REASSIGNMENT: 'Reasignación entre rutas',
  REVERSAL: 'Anulación', LOAN_DISBURSEMENT: 'Desembolso de crédito',
  COLLECTION: 'Recaudo', WORKER_EXPENSE: 'Gasto de trabajador', ROUTE_EXPENSE: 'Gasto de la ruta', COMPANY_EXPENSE: 'Gasto administrativo',
  EXPENSE_REFUND: 'Reintegro de gasto', SETTLEMENT_RETURN: 'Efectivo entregado en cuadre', SETTLEMENT_SURPLUS: 'Sobrante de cuadre (en control)',
  ADMIN_TRANSFER_HOLD: 'Transferencia a otro Administrador (comprometida)', ADMIN_TRANSFER_APPLY: 'Transferencia recibida de otro Administrador',
  ADMIN_TRANSFER_RELEASE: 'Transferencia entre Administradores liberada',
};
