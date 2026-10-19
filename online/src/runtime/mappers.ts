// Vistas del servidor → modelos de CLEAN (`src/models/types.ts`).
//
// Solo cambian NOMBRES y UNIDADES: el servidor trabaja en unidades menores enteras
// (`amountMinor`) y CLEAN en unidades de la moneda. Ninguna cifra se recalcula aquí:
// saldos, cuotas y estados son los que devuelve PostgreSQL. Los campos de CLEAN que no
// tienen equivalente en el servidor quedan vacíos (nunca se inventan).

import type {
  CashSettlement, Client, Expense, ExpenseCategory, WeeklySettlement, Installment, Office, Payment, Route, Sale, SaleRequest, Tenant, User, UserRole,
} from '@clean/models/types';
import { useRuntime } from './session.ts';

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
  };
}

export function installmentFrom(saleId: string, i: V): Installment {
  return {
    id: `${saleId}:${i.number}`, saleId, numero: i.number, fechaVencimiento: i.dueDate, valor: toMajor(i.amountMinor),
    pagado: toMajor(i.paidMinor), saldo: toMajor(i.balanceMinor), status: i.status, diasMora: i.daysOverdue ?? 0,
  };
}

export function paymentFrom(p: V): Payment {
  const state = p.state as Payment['state'];
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
  return { id: c.id, tenantId: tenantId(), nombre: c.name, icono: s(c.icon), activa: c.active !== false };
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
 * Cierre de periodo del servidor → `WeeklySettlement`. Saldo de apertura y de cierre son
 * los archivados por el servidor; el desglose de CLEAN (capital, transferencias, retiros…)
 * no tiene equivalente uno a uno en el libro central y NO se rellena (queda NaN: una
 * pantalla que lo mostrara fallaría a la vista en vez de enseñar un cero falso).
 */
export function weeklySettlementFrom(c: V): WeeklySettlement {
  const f = (c.figures ?? {}) as V;
  const credit = (f.credit ?? {}) as V;
  const has = (k: string) => typeof credit[k] === 'number';
  return {
    id: c.id, tenantId: tenantId(), routeId: c.routeId, semanaInicio: c.weekStart, semanaFin: c.weekEnd,
    saldoAnterior: toMajor(c.openingMinor), saldoFinal: toMajor(c.closingMinor),
    cobros: has('principalCollectedMinor') ? toMajor(credit.principalCollectedMinor + (credit.interestCollectedMinor ?? 0)) : NaN,
    prestamosEntregados: has('principalDisbursedMinor') ? toMajor(credit.principalDisbursedMinor) : NaN,
    gastos: has('expensesMinor') ? toMajor(credit.expensesMinor) : NaN,
    ingresoCapital: NaN, transferenciasEntradas: NaN, transferenciasSalidas: NaN, retiros: NaN,
    createdAt: c.closedAt ?? '', status: c.status, closedAt: c.closedAt ?? undefined, closedByUserId: c.closedBy ?? undefined,
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
