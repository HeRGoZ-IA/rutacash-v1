// Presentación. Los importes llegan y se envían en UNIDADES MENORES (enteros); aquí
// solo se convierten para mostrarlos o leerlos de un campo de texto.

const ERRORS: Record<string, string> = {
  INVALID_CREDENTIALS: 'Correo o contraseña incorrectos.',
  AUTH_UNAVAILABLE: 'El servicio de acceso no responde. Inténtelo de nuevo.',
  SESSION_EXPIRED: 'La sesión caducó. Inicie sesión de nuevo.',
  SESSION_REVOKED: 'La sesión se cerró (por ejemplo, porque se inició sesión en otro dispositivo). Inicie sesión de nuevo.',
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
  CORRECTION_REQUEST_REQUIRED: 'Solo un Administrador corrige pagos directamente: envía una solicitud de ajuste.',
  SELF_APPROVAL_FORBIDDEN: 'Nadie puede resolver su propia solicitud (tampoco con otra membresía).',
  SELF_ASSIGNMENT_FORBIDDEN: 'Nadie se asigna a sí mismo un perfil, una reactivación ni rutas de otra de sus membresías. Debe hacerlo otra persona con autoridad.',
  SELF_DELIVERY_FORBIDDEN: 'Nadie entrega ni traspasa efectivo a su propia caja de cobro, tampoco con otra membresía.',
  ROLE_ACCUMULATION_FORBIDDEN: 'En una misma empresa solo un Administrador puede tener varios perfiles, y el SuperAdmin no se combina con otros perfiles.',
  SELF_REDUCTION_FORBIDDEN: 'Nadie registra la reducción de su propio efectivo.',
  REQUEST_STATE_INVALID: 'La solicitud cambió de estado. Se recargó la información.',
  REQUEST_NOT_DISBURSABLE: 'La solicitud ya no se puede desembolsar.',
  // Ronda 73 · corrección de ventas desembolsadas (SOC-09).
  CREDIT_HAS_COLLECTIONS: 'La venta ya tiene cobros registrados: no se puede corregir.',
  OVERPAYMENT: 'El total corregido quedaría por debajo de lo ya pagado (o el pago superaría el saldo). No hay política de sobrepagos aprobada.',
  LEGACY_PAYMENTS: 'La venta tiene pagos sin asiento en el libro: no se puede recalcular.',
  PAYMENT_ADJUSTMENT_PENDING: 'Hay una solicitud de ajuste de pago pendiente en esta venta.',
  PAYMENT_NOT_REAPPLICABLE: 'Ese pago no se puede reaplicar (no está anulado, fue corregido o ya se reaplicó).',
  REVERSAL_SETTLED: 'La anulación ya entró en un cuadre: el pago no se reaplica sin una política de conciliación.',
  DISBURSEMENT_SETTLED: 'El desembolso ya está incluido en un cuadre: no se puede corregir.',
  CUSTODIAN_CHANGED: 'El trabajador que entregó el dinero ya no tiene Base del trabajador en esta ruta: la corrección necesita una revisión aparte.',
  CREDIT_CHANGED: 'La venta cambió mientras la corregía. Vuelva a abrirla y revise los datos.',
  NOTHING_TO_RECTIFY: 'No hay cambios que corregir.',
  PENDING_REQUEST_EXISTS: 'Ese cliente ya tiene una solicitud pendiente.',
  INTEREST_RATE_NOT_ALLOWED: 'Tasa no permitida: solo 10 % o 20 %, y el Cobrador usa la tasa de su ruta salvo que la ruta tenga «Tasa libre».',
  INVALID_CONDITIONS: 'Condiciones no válidas (la fecha de inicio no puede ser anterior a hoy).',
  CLIENT_NOT_ACTIVE: 'El cliente no está activo.',
  DOCUMENT_DUPLICATE: 'Ya existe un cliente con ese documento en la empresa.',
  INVALID_DOCUMENT: 'El documento no es válido para el tipo elegido.',
  ROUTE_NOT_OPERATIONAL: 'La ruta no admite operaciones nuevas.',
  PERIOD_CLOSED: 'El periodo de esta ruta está cerrado: no admite movimientos de esa fecha. Si se cerró hoy, regístralo mañana y entrará en el próximo cierre.',
  OPERATION_ID_REUSED: 'Operación duplicada con otros datos.',
  REVOCATION_IN_PROGRESS: 'Hay un cambio de permisos en curso. Inténtelo en unos segundos.',
  RATE_LIMITED: 'Demasiadas peticiones. Espere un momento.',
  DEMO_BUSY: 'La Empresa Demo está ocupada con otra operación administrativa.',
  DEMO_TARGET_MISMATCH: 'El ID no corresponde a la Empresa Demo vigente.',
  CONFIRMATION_MISMATCH: 'La confirmación no coincide con el ID interno.',
  DEMO_OPERATOR_REQUIRED: 'Su usuario no administra la Empresa Demo.',
  DEMO_PROVISIONING_FAILED: 'No se pudo preparar la Empresa Demo. La anterior se mantuvo.',
  CREDIT_NOT_ACTIVE: 'Esta venta no está activa: no admite recaudos.',
  CREDIT_NOT_DISBURSED: 'Esta venta aún no está desembolsada.',
  CREDIT_NOT_LEDGERED: 'Esta venta no se originó en el servidor: no admite recaudos aquí.',
  CREDIT_WITHOUT_INSTALLMENTS: 'La venta no tiene parcelas generadas.',
  CREDIT_NO_BALANCE: 'Esta venta ya no tiene saldo pendiente.',
  COLLECTOR_REQUIRED: 'Indique quién recibió el dinero.',
  COLLECTOR_INVALID: 'Esa persona no puede responder por el efectivo de esta ruta (los cobros que registra un trabajador son suyos).',
  CUSTODIAN_INVALID: 'Esa persona no puede tener efectivo en esta ruta.',
  FUNDS_ALREADY_USED: 'Ese efectivo ya no está en la Base del trabajador que lo recibió (fue entregado, usado o cubre un negativo).',
  ALREADY_REVERSED: 'Ya estaba anulado.',
  REVERSAL_NOT_ALLOWED: 'Este movimiento no se puede anular por esta vía.',
  NOT_CORRECTABLE_HERE: 'Registro histórico o importado: no se corrige desde aquí.',
  CATEGORY_INVALID: 'Seleccione una categoría válida.',
  POOL_NOT_ALLOWED: 'No puede pagar con esa bolsa (cada Administrador solo con la suya).',
  REFUND_NOT_ALLOWED: 'Solo los gastos administrativos (de bolsa) admiten reintegros.',
  REFUND_EXCEEDS_EXPENSE: 'El reintegro supera lo que queda por reintegrar de este gasto.',
  EXPENSE_HAS_REFUNDS: 'El gasto ya tiene reintegros: registre un reintegro por el resto en lugar de anularlo.',
  // R74 (0037): el responsable de capital anula también lo que él registró; solo un gasto cargado a la propia custodia queda fuera.
  SELF_CORRECTION_FORBIDDEN: 'Nadie anula un gasto pagado con su propio efectivo (tampoco con otra membresía).',
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
  OFFLINE_AMOUNT_EXCEEDS_BALANCE: 'El recaudo ya no cabe en el saldo actual de la venta (la oficina registró otro movimiento). No se registró: revíselo con la oficina.',
  OFFLINE_NOT_ALLOWED: 'Solo el Cobrador puede registrar operaciones sin conexión.',
  ROUTE_HAS_ACTIVE_COLLECTOR: 'La ruta tiene un Cobrador activo: solo él registra abonos y visitas. Para sustituirlo, la oficina debe bloquearlo antes.',
  OFFLINE_KEY_UNAVAILABLE: 'No se pudo preparar el modo sin conexión en este dispositivo.',
  // Ronda 74 · Base por Ruta (0034, AX421–AX428).
  CAPITAL_MODEL_OPERATION_REFUSED: 'Con Base por Ruta el capital de empresa y las bolsas de Administradores no se mueven: el dinero está en la Base de cada ruta.',
  CAPITAL_MIGRATION_IN_PROGRESS: 'La empresa está pasando a Base por Ruta: las bolsas están congeladas hasta que el SuperAdmin complete la activación.',
  ROUTE_IN_HANDOVER: 'La ruta está en entrega: el nuevo responsable debe contar la Base y confirmar antes de mover dinero.',
  ROUTE_SCOPE_VIOLATION: 'Una ruta no puede usar la Base de otra ruta.',
  ACTIVATION_PREREQUISITES_FAILED: 'No se cumplen los requisitos para activar Base por Ruta. Revise la lista y vuelva a comprobar (con saldos, pasa primero por «Migrando»).',
  GENERAL_EXPENSE_FUNDING_PENDING: 'Con Base por Ruta, un gasto general se paga con aportes de tus rutas o con tu dinero propio (reembolsable). Elige una de esas dos fuentes.',
  HANDOVER_NOT_PENDING: 'Esta ruta ya no tiene una entrega pendiente de confirmar.',
  ROUTE_BASE_NOT_ACTIVE: 'La empresa no usa Base por Ruta: esta operación no está disponible.',
  // Ronda 74 · gastos generales y reembolsos (0035, AX429–AX432).
  CONTRIBUTIONS_INVALID: 'Los aportes no son válidos: cada ruta aporta una sola vez, con un valor mayor que cero, y la suma debe ser igual al total.',
  CONTRIBUTION_ROUTE_NOT_ALLOWED: 'Solo aportan las rutas de las que eres el responsable vigente. Para anular, debes seguir siendo el responsable de cada ruta aportante.',
  REIMBURSEMENT_EXCEEDS_PENDING: 'El reembolso supera lo que la empresa le debe a ese Administrador.',
  PAYABLE_ALREADY_REIMBURSED: 'Este gasto ya fue reembolsado (total o parcialmente): se anula junto con su reembolso (o primero el reembolso, si lo pagó otro Administrador).',
  // Ronda 74 · autoridad del Administrador (0036: conciliación de diferencias, desactivación, operaciones conjuntas).
  ADMIN_HAS_PENDING_ACCOUNTS: 'Este Administrador tiene cuentas pendientes: debe saldarlas y entregarlas antes de desactivarlo.',
  JOINT_OPERATION_MIXED_CONTROLLERS: 'La operación abarca rutas de distintos Administradores: se anula con una anulación conjunta que cada responsable confirma desde su pantalla.',
  DIFFERENCE_NOT_PENDING: 'Esta diferencia ya no está pendiente (ya se concilió o fue sustituida). Se recargó la lista.',
  RESOLUTION_NOT_ALLOWED: 'Esa resolución no aplica a esta diferencia.',
  DIFFERENCE_AMOUNT_MISMATCH: 'El importe pendiente cambió desde la vista previa. Revise de nuevo antes de confirmar.',
  // Ronda 74 · regla definitiva del responsable de capital (0037): anulación conjunta.
  JOINT_REVERSAL_NOT_NEEDED: 'Eres el responsable de todas las rutas de esta operación: anúlala directamente.',
  JOINT_REVERSAL_PENDING_EXISTS: 'Ya hay una anulación conjunta pendiente para esta operación: confírmala o espera a que la cancelen.',
  JOINT_REVERSAL_NOT_PENDING: 'Esta anulación conjunta ya no está pendiente (se asentó, se canceló o caducó).',
};

const FIELD: Record<string, string> = {
  name: 'Nombre', code: 'Código', city: 'Ciudad', email: 'Correo', phone: 'Teléfono', interestRate: 'Tasa de interés', freeRate: 'Tasa libre',
  maxLoanMinor: 'Venta máxima', officeId: 'Oficina', collectorId: 'Cobrador', memberIds: 'Personas asignadas', adminIds: 'Administradores',
  capitalControllerId: 'Responsable de capital', membershipId: 'Responsable de capital', reason: 'Motivo', displayName: 'Nombre', icon: 'Icono',
  legalName: 'Razón social', taxId: 'Identificación tributaria', address: 'Dirección', contactName: 'Persona de contacto', routeIds: 'Rutas',
  selectedRouteIds: 'Rutas', status: 'Estado',
  routeId: 'Ruta', fromRouteId: 'Ruta de origen', toRouteId: 'Ruta destino', amountMinor: 'Valor', evidence: 'Evidencia',
  backupReference: 'Referencia del respaldo', companyBalanceNote: 'Nota sobre el capital de la empresa', countedMinor: 'Valor contado',
  expectedSeenMinor: 'Base esperada', note: 'Nota', sourceNote: 'Origen del dinero', workerId: 'Cobrador', target: 'Cambio de modelo',
  contributions: 'Aportes de rutas', adminId: 'Administrador', description: 'Descripción', categoryId: 'Categoría', fundingSource: 'Fuente del dinero',
  scope: 'Alcance', reference: 'Referencia',
  sourceKind: 'Origen de la diferencia', sourceId: 'Diferencia', resolution: 'Resolución',
};

export function errorText(err: unknown): string {
  const code = (err as { code?: string })?.code ?? (err as Error)?.message ?? 'ERROR';
  if (code === 'INVALID_INPUT') {
    const field = (err as { details?: { field?: unknown } })?.details?.field;
    return typeof field === 'string' ? `Revise el campo «${FIELD[field] ?? field}».` : 'Hay datos no válidos. Revise el formulario.';
  }
  // 0039 (RB-D12): una operación de varias rutas la anula quien la registró (o, si ya no responde, un responsable vigente).
  const admins = (err as { details?: { authorizedAdmins?: unknown } })?.details?.authorizedAdmins;
  if (code === 'CAPITAL_AUTHORITY_REQUIRED' && Array.isArray(admins) && admins.length > 0) {
    return `Solo puede anularla ${admins.join(' o ')}: quien la registró o, si ya no responde por esas rutas, su responsable actual.`;
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
  REVERSAL: 'Anulación', LOAN_DISBURSEMENT: 'Desembolso de venta',
  COLLECTION: 'Recaudo', WORKER_EXPENSE: 'Gasto de trabajador', ROUTE_EXPENSE: 'Gasto de la ruta', COMPANY_EXPENSE: 'Gasto administrativo',
  EXPENSE_REFUND: 'Reintegro de gasto', SETTLEMENT_RETURN: 'Efectivo entregado en cuadre', SETTLEMENT_SURPLUS: 'Sobrante de cuadre (en control)',
  ADMIN_TRANSFER_HOLD: 'Transferencia a otro Administrador (comprometida)', ADMIN_TRANSFER_APPLY: 'Transferencia recibida de otro Administrador',
  ADMIN_TRANSFER_RELEASE: 'Transferencia entre Administradores liberada',
  ROUTE_BASE_INJECTION: 'Inyección de Base', ROUTE_BASE_WITHDRAWAL: 'Retiro de Base', ROUTE_TRANSFER: 'Transferencia entre rutas',
  LEGACY_POOL_TO_ROUTE: 'Reparto de saldo sin asignar',
  GENERAL_EXPENSE_CONTRIBUTION: 'Aporte de ruta a gasto general', GENERAL_EXPENSE_OWN_MONEY: 'Gasto general con dinero propio',
  ADMIN_REIMBURSEMENT: 'Reembolso a Administrador',
};
