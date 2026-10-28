// Vistas del servidor → modelos de CLEAN (`src/models/types.ts`).
//
// Solo cambian NOMBRES y UNIDADES: el servidor trabaja en unidades menores enteras
// (`amountMinor`) y CLEAN en unidades de la moneda. Ninguna cifra se recalcula aquí:
// saldos, cuotas y estados son los que devuelve PostgreSQL. Los campos de CLEAN que no
// tienen equivalente en el servidor quedan vacíos (nunca se inventan).

import type {
  CashSettlement, Client, Expense, ExpenseCategory, WeeklySettlement, Installment, NoPaymentVisit, Office, Payment, PaymentAdjustmentRequest, Route, RouteCapitalControllerEvent, Sale, SaleRequest, Tenant, User, UserRole,
} from '@clean/models/types';
import { useRuntime } from './session.ts';
import { cashboxFromFigures } from './cashboxFigures.ts';

export function minorUnits(): number {
  return useRuntime.getState().ctx?.company.minorUnits ?? 0;
}
/** Unidades menores del servidor → importe de CLEAN. */
export function toMajor(minor: number | null | undefined): number {
  if (minor === null || minor === undefined) return 0;
  return minor / 10 ** minorUnits();
}
/** Importe de CLEAN → unidades menores del servidor (entero). */
export function toMinor(major: number): number {
  return Math.round(major * 10 ** minorUnits());
}

const tenantId = () => useRuntime.getState().ctx?.company.id ?? '';
const s = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = Record<string, any>;

export interface CompanyView { id: string; name: string; legalName: string | null; taxId: string | null; email: string | null; phone: string | null; city: string | null;
  address: string | null; contactName: string | null; countryCode: string; countryLabel?: string; currencyCode: string; timezone: string; plan: string; status: string }

/**
 * La empresa vista por un rol SIN acceso a sus datos de contacto (Configuración, p. ej.
 * Cobrador o Supervisor): solo lo que el servidor ya le da en su contexto validado
 * (nombre, país, moneda, zona). Nunca se pide ni se inventa lo demás.
 */
export function companyFromContext(): CompanyView {
  const c = useRuntime.getState().ctx!.company;
  return { id: c.id, name: c.name, legalName: null, taxId: null, email: null, phone: null, city: null, address: null, contactName: null,
    countryCode: c.countryCode, currencyCode: c.currencyCode, timezone: c.timezone, plan: 'operativo', status: 'activa' };
}

export function tenantFrom(c: CompanyView): Tenant {
  return {
    id: c.id, nombre: c.name, nombreLegal: s(c.legalName), nit: s(c.taxId), email: c.email ?? '', telefono: s(c.phone),
    plan: c.plan as Tenant['plan'], status: (c.status === 'activa' ? 'activa' : c.status === 'prueba' ? 'prueba' : 'suspendida'),
    pais: c.countryCode, ciudad: s(c.city), moneda: c.currencyCode, direccion: s(c.address), responsable: s(c.contactName),
    // El SaaS opera SIEMPRE con capital centralizado (Fase 3): la bolsa del Administrador
    // responsable entrega al trabajador y recibe de él, sin caja intermedia de ruta. Es el
    // mismo modelo que CLEAN activa con `centralCapitalStartAt` (C1), así que las pantallas
    // muestran su variante centralizada. No es una fecha de activación real.
    centralCapitalStartAt: '1970-01-01T00:00:00.000Z',
    createdAt: '', updatedAt: '',
  };
}

export function userFrom(m: V): User {
  const routeIds: string[] = m.routeIds ?? [];
  return {
    id: m.membershipId, tenantId: tenantId(), nombre: m.displayName ?? '', email: m.email ?? '', password: '',
    rol: m.role as UserRole, telefono: s(m.phone), authorizedRouteIds: routeIds, routeId: routeIds[0],
    status: m.status === 'activo' ? 'activo' : 'inactivo', createdAt: '', updatedAt: '',
  };
}

export function routeFrom(r: V): Route {
  return {
    id: r.id, tenantId: tenantId(), officeId: r.officeId ?? undefined, nombre: r.name, codigo: r.code ?? '', ciudad: s(r.city),
    email: s(r.email), telefono: s(r.phone), tasaInteres: Number(r.interestRate), tasaLibre: r.freeRate === true,
    montoMaximoPrestamo: toMajor(r.maxLoanMinor),
    // Sin caja de ruta en el SaaS (capital centralizado): no hay capital inicial ni actual.
    capitalInicial: 0, capitalActual: 0,
    cobradorId: r.collectorId ?? undefined, capitalControllerAdminId: r.capitalControllerId ?? undefined,
    capitalControllerSince: r.capitalControllerSince ?? undefined, status: r.status, createdAt: r.createdAt ?? '', updatedAt: r.updatedAt ?? '',
  };
}

export function officeFrom(o: V): Office {
  return { id: o.id, tenantId: tenantId(), nombre: o.name, codigo: s(o.code), status: o.status, createdAt: o.createdAt ?? '', updatedAt: o.updatedAt ?? '' };
}

export function clientFrom(c: V): Client {
  return {
    id: c.id, tenantId: tenantId(), routeId: c.routeId, nombre: c.name, documento: c.document ?? '', telefonoPrincipal: c.phonePrimary ?? '',
    telefonoSecundario: s(c.phoneSecondary), direccionPrincipal: c.addressPrimary ?? '', direccionSecundaria: s(c.addressSecondary),
    negocio: s(c.business), fotoDocumentoUrl: s(c.documentPhotoUrl), fotoNegocioUrl: s(c.businessPhotoUrl), status: c.status, notas: s(c.notes),
    createdAt: c.createdAt ?? '', updatedAt: c.updatedAt ?? '',
  };
}

export function saleFrom(c: V): Sale {
  return {
    id: c.id, tenantId: tenantId(), routeId: c.routeId, clientId: c.clientId, createdByUserId: c.createdBy,
    valorVenta: toMajor(c.saleValueMinor), tasaInteres: Number(c.interestRate), valorInteres: toMajor(c.interestValueMinor),
    valorTotal: toMajor(c.totalValueMinor), saldo: toMajor(c.balanceMinor), numeroCuotas: c.installmentsCount,
    valorCuota: toMajor(c.installmentValueMinor), frecuenciaPago: c.frequency, paymentDays: c.paymentDays ?? undefined,
    fechaInicio: c.startDate, fechaFinalEstimada: c.estimatedEndDate ?? '', fechaFinalizacion: s(c.finishedOn),
    status: c.status, disbursementStatus: c.disbursementStatus ?? undefined, disbursedByCollectorId: c.disbursedByCollectorId ?? undefined,
    disbursedByUserId: c.disbursedBy ?? undefined, fechaDesembolso: c.disbursementDate ?? undefined, disbursedAt: c.disbursedAt ?? undefined,
    saleRequestId: c.saleRequestId ?? undefined, motivoPerdida: s(c.lossReason), createdAt: c.createdAt ?? '', updatedAt: c.updatedAt ?? c.createdAt ?? '',
    rectificationCount: Number(c.rectificationCount ?? 0),
  };
}

/**
 * Solicitud APROBADA y aún sin desembolsar → la venta «pendiente de desembolso» de CLEAN.
 *
 * En CLEAN aprobar crea la venta con `disbursementStatus: 'pendiente'`; en el servidor
 * (Fase 4) el crédito nace al DESEMBOLSAR y hasta entonces solo existe la solicitud
 * aprobada con sus condiciones. Para el negocio es el mismo estado, así que las
 * pantallas originales la ven igual: misma lista de desembolsos, mismo contador.
 * El id es el de la SOLICITUD (`saleRequestId` también): confirmar el desembolso es
 * `POST /v1/credit-requests/:id/disburse`. No tiene cuotas ni saldo en el libro todavía.
 */
export function pendingSaleFrom(r: SaleRequest): Sale {
  return {
    id: r.id, tenantId: r.tenantId, routeId: r.routeId, clientId: r.clientId, createdByUserId: r.requestedBy ?? r.collectorId,
    valorVenta: r.amount, tasaInteres: r.approvedInterestRate ?? r.interestRate, valorInteres: r.totalAmount - r.amount,
    valorTotal: r.totalAmount, saldo: r.totalAmount, numeroCuotas: r.installmentsCount, valorCuota: r.installmentValue,
    frecuenciaPago: (r.approvedFrequency ?? r.frequency) as Sale['frecuenciaPago'], paymentDays: r.approvedPaymentDays ?? r.paymentDays,
    fechaInicio: r.startDate, fechaFinalEstimada: '', status: 'activa', disbursementStatus: 'pendiente', saleRequestId: r.id,
    createdAt: r.reviewedAt ?? r.requestedAt, updatedAt: r.reviewedAt ?? r.requestedAt,
  };
}

export function noPaymentVisitFrom(v: V): NoPaymentVisit {
  return {
    id: v.id, tenantId: tenantId(), saleId: v.saleId, clientId: v.clientId, routeId: v.routeId, collectorId: v.collectorId,
    motivo: v.reason, fechaPromesaPago: s(v.promisedPaymentDate), observacion: s(v.note), fecha: v.visitDate,
    syncStatus: 'synced', createdAt: v.createdAt,
  };
}

export function installmentFrom(saleId: string, i: V): Installment {
  return {
    id: `${saleId}:${i.number}`, saleId, numero: i.number, fechaVencimiento: i.dueDate, valor: toMajor(i.amountMinor),
    pagado: toMajor(i.paidMinor), saldo: toMajor(i.balanceMinor), status: i.status, diasMora: i.daysOverdue ?? 0,
  };
}

/**
 * ¿La fecha del pago cae en una semana CERRADA de su ruta? Lo dice el servidor en cada pago
 * (`periodClosed`): un rol sin acceso a los cierres (Secretario) decide igual que CLEAN si
 * corrige directamente o pide un ajuste.
 */
export const paymentPeriodClosed = new Map<string, boolean>();

export function paymentFrom(p: V): Payment {
  const state = p.state as Payment['state'];
  if (typeof p.periodClosed === 'boolean') paymentPeriodClosed.set(p.id, p.periodClosed);
  return {
    id: p.id, tenantId: tenantId(), saleId: p.saleId, clientId: p.clientId, routeId: p.routeId, collectorId: p.collectorId,
    createdByUserId: p.createdBy ?? undefined,
    // El servidor guarda la reversión con importe NEGADO, igual que CLEAN.
    valor: toMajor(p.amountMinor),
    fecha: p.paymentDate, tipo: p.paymentType ?? 'efectivo', observacion: s(p.note),
    // Confirmado por el servidor: en ADEX Online no existe cola de sincronización.
    syncStatus: 'synced', createdAt: p.createdAt, state,
    reversesPaymentId: p.reversesPaymentId ?? undefined, reversalPaymentId: p.reversalPaymentId ?? undefined,
    correctionReason: s(p.correctionReason), correctedBy: p.correctedBy ?? undefined, correctedAt: p.correctedAt ?? undefined,
    correctedByPaymentId: p.correctedByPaymentId ?? undefined, correctionOfPaymentId: p.correctionOfPaymentId ?? undefined,
    reappliesPaymentId: p.reappliesPaymentId ?? undefined,
  };
}

export function controllerEventFrom(e: V): RouteCapitalControllerEvent {
  return {
    id: e.id, tenantId: tenantId(), routeId: e.routeId, kind: e.kind, fromAdminId: e.fromAdminId ?? undefined, toAdminId: e.toAdminId ?? undefined,
    capitalTransferido: toMajor(e.capitalTransferredMinor), baseAlCambio: e.baseAtChangeMinor === null || e.baseAtChangeMinor === undefined ? undefined : toMajor(e.baseAtChangeMinor),
    ledgerEntryId: e.ledgerEntryId ?? undefined, motivo: s(e.reason), createdAt: e.createdAt, actorUserId: e.actorId ?? e.actorSystem ?? '',
    actorRole: e.actorRole ?? undefined, syncStatus: 'synced',
  };
}

export function adjustmentFrom(a: V): PaymentAdjustmentRequest {
  return {
    id: a.id, tenantId: tenantId(), routeId: a.routeId, paymentId: a.paymentId, clientId: a.clientId, saleId: a.saleId,
    requestedBy: a.requestedBy, requestedByRole: a.requestedByRole, requestedAt: a.requestedAt,
    originalValor: toMajor(a.originalAmountMinor), originalFecha: a.originalDate, reason: a.reason, newValor: toMajor(a.newAmountMinor),
    newFecha: a.newDate ?? undefined, observacion: s(a.note), status: a.status, reviewedBy: a.reviewedBy ?? undefined,
    reviewedAt: a.reviewedAt ?? undefined, rejectionReason: s(a.rejectionReason), resultingReversalId: a.resultingReversalId ?? undefined,
    resultingPaymentId: a.resultingPaymentId ?? undefined,
  };
}

export function expenseFrom(e: V): Expense {
  return {
    id: e.id, tenantId: tenantId(), routeId: e.routeId ?? undefined, scope: e.scope ?? undefined, categoryId: e.categoryId,
    // Reversiones y reintegros llegan NEGADOS del servidor (misma convención que CLEAN).
    valor: toMajor(e.amountMinor),
    descripcion: s(e.description), fecha: e.expenseDate, userId: e.registeredBy, collectorId: e.workerId ?? undefined,
    funding: e.funding ?? undefined, fundingAdminId: e.fundingAdminId ?? undefined, refundsExpenseId: e.refundsExpenseId ?? undefined,
    referencia: s(e.reference), syncStatus: 'synced', createdAt: e.createdAt,
    reversalId: e.reversalId ?? undefined, reversedAt: e.reversedAt ?? undefined, reversedByUserId: e.reversedBy ?? undefined,
    reversalReason: s(e.reversalReason), reversesId: e.reversesId ?? undefined,
  };
}

export function categoryFrom(c: V): ExpenseCategory {
  // 3.14 (0040): sin el dato (API anterior) el tipo sirve a todos, como antes; uno eliminado nunca está activo.
  return { id: c.id, tenantId: tenantId(), nombre: c.name, icono: s(c.icon), activa: c.active !== false && c.deleted !== true,
    paraCobradores: c.forCollectors !== false, eliminada: c.deleted === true };
}

export function saleRequestFrom(r: V): SaleRequest {
  return {
    id: r.id, tenantId: tenantId(), clientId: r.clientId, routeId: r.routeId, collectorId: r.requestedBy,
    amount: toMajor(r.amountMinor), interestRate: Number(r.interestRate), totalAmount: toMajor(r.totalAmountMinor),
    installmentsCount: r.installmentsCount, installmentValue: toMajor(r.installmentValueMinor), frequency: r.frequency,
    startDate: r.startDate, paymentDays: r.paymentDays ?? undefined, status: r.status, requestedAt: r.requestedAt,
    reviewedAt: r.reviewedAt ?? undefined, reviewedBy: r.reviewedBy ?? undefined, rejectionReason: s(r.rejectionReason),
    approvalNotes: s(r.approvalNotes), saleId: r.saleId ?? undefined, requestedBy: r.requestedBy,
    requestedInterestRate: r.requested?.interestRate, requestedFrequency: r.requested?.frequency, requestedPaymentDays: r.requested?.paymentDays,
    approvedInterestRate: r.approved?.interestRate, approvedFrequency: r.approved?.frequency, approvedPaymentDays: r.approved?.paymentDays,
    phoneConfirmed: r.phoneConfirmed ?? undefined, phoneConfirmationNote: s(r.phoneConfirmationNote),
    activeCreditSaleIds: r.activeCreditSaleIdsAtRequest ?? undefined, authorizationReason: r.authorizationReason ?? undefined,
  };
}

/**
 * Cierre de periodo del servidor → `WeeklySettlement`. Cierres del servidor (Fase 6): las
 * cifras salen del ARCHIVO del cierre (el libro tal como quedó), con el mismo desglose que
 * la Caja (`cashboxFromFigures`). Cierres importados sin archivo: solo los saldos de
 * apertura y cierre que guardó CLEAN; el resto queda NaN (una pantalla que lo mostrara
 * fallaría a la vista en vez de enseñar un cero falso).
 */
export function weeklySettlementFrom(c: V): WeeklySettlement {
  const f = c.figures as V | null;
  const caja = f && f.custody ? cashboxFromFigures(c.routeId, f) : null;
  return {
    id: c.id, tenantId: tenantId(), routeId: c.routeId, semanaInicio: c.weekStart, semanaFin: c.weekEnd,
    saldoAnterior: toMajor(c.openingMinor), saldoFinal: toMajor(c.closingMinor),
    cobros: caja ? caja.cobros : NaN, prestamosEntregados: caja ? caja.prestamosEntregados : NaN, gastos: caja ? caja.gastos : NaN,
    ingresoCapital: caja ? caja.ingresoCapital : NaN, transferenciasEntradas: caja ? caja.transferenciasEntradas : NaN,
    transferenciasSalidas: caja ? caja.transferenciasSalidas : NaN, retiros: caja ? caja.retiros : NaN,
    createdAt: c.closedAt ?? '', status: c.status, closedAt: c.closedAt ?? undefined, closedByUserId: c.closedBy ?? undefined,
    reopenedAt: c.reopenedAt ?? undefined, reopenedByUserId: c.reopenedBy ?? undefined, reopenReason: c.reopenReason ?? undefined,
    version: c.version, supersededBy: c.supersededBy ?? undefined,
  };
}

/** Cuadre por trabajador del servidor (Fase 6, misma entidad que `cashSettlements` de CLEAN). */
export function cashSettlementFrom(s: V): CashSettlement {
  return {
    id: s.id, tenantId: tenantId(), routeId: s.routeId, userId: s.workerId,
    // El servidor corta los cuadres por secuencia del libro, no por instantes: el inicio del
    // tramo no existe como fecha. Se deja vacío en vez de inventarlo.
    desde: '', hasta: s.closedAt, origenDesde: s.previousSettlementId ? 'ultimo-cierre' : 'inicio-modelo',
    previousSettlementId: s.previousSettlementId ?? undefined,
    arrastreAnterior: toMajor(s.openingCarriedMinor), baseRecibida: toMajor(s.baseReceivedMinor), baseDevuelta: toMajor(s.baseReturnedMinor),
    recaudado: toMajor(s.collectedMinor), desembolsado: toMajor(s.disbursedMinor), gastos: toMajor(s.expensesMinor),
    esperado: toMajor(s.expectedCashMinor), entregado: toMajor(s.deliveredMinor), diferencia: toMajor(s.differenceMinor),
    faltante: toMajor(s.shortageMinor), sobrante: toMajor(s.surplusMinor), motivo: s.reason ?? undefined,
    status: s.status, version: s.version, supersededBy: s.supersededBy ?? undefined,
    createdAt: s.closedAt, closedAt: s.closedAt, closedByUserId: s.closedBy,
    reopenedAt: s.reopenedAt ?? undefined, reopenedByUserId: s.reopenedBy ?? undefined, reopenReason: s.reopenReason ?? undefined,
  };
}
