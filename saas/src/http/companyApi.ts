// API de EMPRESA (Fase 1: identidad, contexto y membresías · Fase 2: estructura y
// catálogo · Fase 3: capital centralizado y custodia · Fase 4: créditos · ADEX
// Online v1: consulta de operaciones inciertas · Fase 5: recaudos y gastos · Fase 6:
// cuadres y cierres). Sin framework.
//
//   Authorization: Bearer <token de acceso del proveedor de identidad>
//   X-Adex-Membership: <membresía con la que se opera>   (contexto explícito, DS-05)
//   X-Adex-Operation-Id: <uuid>   (altas: opcional; comandos de dinero: OBLIGATORIO. Idempotencia P3)
//
// El cliente nunca envía empresa, rol ni rutas: se ignoran los encabezados ajenos y
// se rechaza cualquier campo de cuerpo desconocido. Todo con `adex_api` (sin BYPASSRLS).

import { createHash } from 'node:crypto';
import http from 'node:http';
import type pg from 'pg';
import { ApiError, fromPgError } from '../errors.ts';
import { withTransaction } from '../db/tx.ts';
import { bearer, type TokenVerifier } from '../auth/jwt.ts';
import type { SessionClaims } from '../db/tx.ts';
import type { IdentityProvider } from '../auth/provider.ts';
import { listOwnMemberships, resolveContext, resolveIdentity, type ActiveContext } from '../authz/context.ts';
import { capabilitiesOf } from '../authz/cleanRules.ts';
import {
  createMember, deleteMember, listMembers, logout, memberAccessLink, setMemberOfficeRoutes, setMemberRoutes, setMemberStatus, updateMember,
} from '../identity/service.ts';
import { COMPANY_FIELDS, getCompany, updateCompany } from '../structure/company.ts';
import {
  assignOfficeRoutes, createOffice, deleteOffice, getOffice, listOffices, setOfficeStatus, updateOffice,
} from '../structure/offices.ts';
import {
  CREATE_ROUTE_FIELDS, UPDATE_ROUTE_FIELDS, changeRouteController, createRoute, deleteRoute, getRoute, listRoutes, setRouteStatus, updateRoute,
} from '../structure/routes.ts';
import { createCategory, deleteCategory, listCategories, updateCategory } from '../structure/categories.ts';
import {
  CLIENT_FIELDS, createClient, deleteClient, documentTypes, getClient, listClients, setClientStatus, updateClient,
} from '../structure/clients.ts';
import {
  allocateToAdmin, capitalReconciliation, capitalSummary, companyDeposit, companyWithdrawal, deliverToWorker, getOperation, listControllerEvents, listCustody,
  listOperations, OWN_RETURN_FIELDS, reassignBetweenRoutes, returnFromAdmin, returnFromWorker, returnOwnCash, reverseOperation, transferBetweenWorkers,
} from '../capital/service.ts';
import {
  REQUEST_FIELDS, closeRequest as closeCapitalRequest, createRequest as createCapitalRequest, getRequest as getCapitalRequest,
  listRequests as listCapitalRequests,
} from '../capital/requests.ts';
import { notificationCount, notifications } from '../capital/notifications.ts';
import {
  REGISTER_FIELDS, adminDirectory, cancelAdminTransfer, decideAdminTransfer, getAdminTransfer, listAdminTransfers, registerAdminTransfer,
} from '../capital/adminTransfers.ts';
import {
  APPROVE_FIELDS, CREATE_REQUEST_FIELDS, DIRECT_FIELDS, DISBURSE_FIELDS, approveRequest, cancelRequest, createRequest, directSale, disburseRequest, getCredit,
  getRequest, listCredits, listInstallments, listRequests, rejectRequest,
} from '../credits/service.ts';
import { COLLECTION_FIELDS, getCollection, listCollections, registerCollection, reverseCollection } from '../collections/service.ts';
import { VISIT_FIELDS, listVisits, registerVisit } from '../collections/visits.ts';
import { offlineKey } from '../offline/capture.ts';
import { ADJUSTMENT_FIELDS, CORRECTION_FIELDS, approveAdjustment, correctCollection, createAdjustment, listAdjustments, rejectAdjustment } from '../collections/adjustments.ts';
import { EXPENSE_FIELDS, createExpense, getExpense, listExpenses, refundExpense, reverseExpense } from '../expenses/service.ts';
import {
  PERIOD_CLOSE_FIELDS, SETTLEMENT_FIELDS, closePeriod, closeSettlement, getClosure, getSettlement, liquidation, listClosures, listSettlements, reopenPeriod,
  periodCalendar, previewSettlement, reopenSettlement, settleableWorkers,
} from '../settlements/service.ts';
import { checkFields, readJson, readJsonObject, scopeOf, send } from './common.ts';

export interface CompanyApiOptions {
  pool: pg.Pool;
  verifyToken: TokenVerifier;
  provider: IdentityProvider;
  lockTimeoutMs?: number;
  /** Solo pruebas: se ejecuta con el contexto resuelto y los bloqueos tomados. */
  afterContext?: (ctx: ActiveContext, path: string) => Promise<void>;
  /** Solo pruebas: tras el comando y antes del COMMIT (un fallo aquí revierte todo). */
  beforeCommit?: (ctx: ActiveContext, path: string) => Promise<void>;
  onError?: (err: unknown) => void;
}

type Result = { status: number; body: unknown };
type Handler = (client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, query: URLSearchParams, operationId: string | null) => Promise<Result>;

interface Endpoint {
  method: string;
  pattern: RegExp;
  /** Campos de cuerpo admitidos; null = sin cuerpo. */
  fields: readonly string[] | null;
  /** Clave estable del comando para la idempotencia (altas y comandos de dinero). */
  idempotent?: string;
  /** Comando de dinero: sin `X-Adex-Operation-Id` se rechaza (un reintento nunca duplica). */
  requiresOperation?: boolean;
  handler: (params: string[], provider: IdentityProvider) => Handler;
}

const ok = (body: unknown): Result => ({ status: 200, body });
const created = (body: unknown): Result => ({ status: 201, body });
const ID = '([^/]+)';

function contextView(ctx: ActiveContext) {
  return {
    identityId: ctx.claims.identityId, membershipId: ctx.membershipId, role: ctx.role, displayName: ctx.displayName, routeIds: ctx.routeIds,
    company: ctx.company, capabilities: capabilitiesOf(ctx.role),
  };
}

const ENDPOINTS: readonly Endpoint[] = [
  // ---------- Contexto (Fase 1) ----------
  { method: 'GET', pattern: /^\/v1\/context$/, fields: null, handler: () => async (_c, ctx) => ok(contextView(ctx)) },
  { method: 'POST', pattern: /^\/v1\/context\/select$/, fields: [], handler: () => async (c, ctx) => {
    // Telemetría estructural para el plano Owner (FIRST_LOGIN / LOGIN). Nada operativo.
    await c.query('select adex_control.record_company_login()');
    return ok(contextView(ctx));
  } },
  // Huella de actividad de la empresa del contexto (0020): cambia cuando algo se registra.
  // Solo dice «hubo cambios»; los datos se siguen leyendo con su propia autorización.
  { method: 'GET', pattern: /^\/v1\/changes$/, fields: null, handler: () => async (c) =>
    ok({ marker: (await c.query<{ m: string | null }>('select adex.ctx_change_marker() m')).rows[0]!.m }) },
  // ---------- Empresa ----------
  { method: 'GET', pattern: /^\/v1\/company$/, fields: null, handler: () => async (c, ctx) => ok(await getCompany(c, ctx)) },
  { method: 'PATCH', pattern: /^\/v1\/company$/, fields: COMPANY_FIELDS, handler: () => async (c, ctx, b) => ok(await updateCompany(c, ctx, b)) },
  // ---------- Oficinas ----------
  { method: 'GET', pattern: /^\/v1\/offices$/, fields: null, handler: () => async (c, ctx) => ok({ offices: await listOffices(c, ctx) }) },
  { method: 'POST', pattern: /^\/v1\/offices$/, fields: ['name', 'code'], idempotent: 'offices.create',
    handler: () => async (c, ctx, b) => created(await createOffice(c, ctx, b)) },
  { method: 'POST', pattern: /^\/v1\/offices\/assign-routes$/, fields: ['officeId', 'routeIds'],
    handler: () => async (c, ctx, b) => ok(await assignOfficeRoutes(c, ctx, b)) },
  { method: 'GET', pattern: new RegExp(`^/v1/offices/${ID}$`), fields: null, handler: ([id]) => async (c, ctx) => ok(await getOffice(c, ctx, id!)) },
  { method: 'PATCH', pattern: new RegExp(`^/v1/offices/${ID}$`), fields: ['name', 'code'], handler: ([id]) => async (c, ctx, b) => ok(await updateOffice(c, ctx, id!, b)) },
  { method: 'POST', pattern: new RegExp(`^/v1/offices/${ID}/status$`), fields: ['status'], handler: ([id]) => async (c, ctx, b) => ok(await setOfficeStatus(c, ctx, id!, b)) },
  { method: 'POST', pattern: new RegExp(`^/v1/offices/${ID}/delete$`), fields: ['detachRoutes'], handler: ([id]) => async (c, ctx, b) => ok(await deleteOffice(c, ctx, id!, b)) },
  // ---------- Rutas ----------
  { method: 'GET', pattern: /^\/v1\/routes$/, fields: null, handler: () => async (c, ctx) => ok({ routes: await listRoutes(c, ctx) }) },
  { method: 'POST', pattern: /^\/v1\/routes$/, fields: CREATE_ROUTE_FIELDS, idempotent: 'routes.create',
    handler: () => async (c, ctx, b) => created(await createRoute(c, ctx, b)) },
  { method: 'GET', pattern: new RegExp(`^/v1/routes/${ID}$`), fields: null, handler: ([id]) => async (c, ctx) => ok(await getRoute(c, ctx, id!)) },
  { method: 'PATCH', pattern: new RegExp(`^/v1/routes/${ID}$`), fields: UPDATE_ROUTE_FIELDS, handler: ([id]) => async (c, ctx, b) => ok(await updateRoute(c, ctx, id!, b)) },
  { method: 'POST', pattern: new RegExp(`^/v1/routes/${ID}/status$`), fields: ['status'], handler: ([id]) => async (c, ctx, b) => ok(await setRouteStatus(c, ctx, id!, b)) },
  { method: 'POST', pattern: new RegExp(`^/v1/routes/${ID}/delete$`), fields: [], handler: ([id]) => async (c, ctx) => ok(await deleteRoute(c, ctx, id!)) },
  { method: 'PUT', pattern: new RegExp(`^/v1/routes/${ID}/capital-controller$`), fields: ['membershipId', 'reason'],
    handler: ([id]) => async (c, ctx, b) => ok(await changeRouteController(c, ctx, id!, b)) },
  // ---------- Membresías (Fase 1 + Fase 2) ----------
  { method: 'GET', pattern: /^\/v1\/members$/, fields: null, handler: () => async (c, ctx) => ok({ members: await listMembers(c, ctx) }) },
  { method: 'POST', pattern: /^\/v1\/members$/, fields: ['email', 'role', 'displayName', 'phone', 'routeIds'], idempotent: 'members.create',
    handler: (_p, provider) => async (c, ctx, b) => created(await createMember(c, ctx, b, provider)) },
  { method: 'PATCH', pattern: new RegExp(`^/v1/members/${ID}$`), fields: ['displayName', 'phone'], handler: ([id]) => async (c, ctx, b) => ok(await updateMember(c, ctx, id!, b)) },
  { method: 'POST', pattern: new RegExp(`^/v1/members/${ID}/(deactivate|reactivate)$`), fields: [],
    handler: ([id, action]) => async (c, ctx) => ok(await setMemberStatus(c, ctx, id!, action === 'deactivate' ? 'inactivo' : 'activo')) },
  { method: 'PUT', pattern: new RegExp(`^/v1/members/${ID}/routes$`), fields: ['routeIds'], handler: ([id]) => async (c, ctx, b) => ok(await setMemberRoutes(c, ctx, id!, b['routeIds'])) },
  { method: 'PUT', pattern: new RegExp(`^/v1/members/${ID}/office-routes$`), fields: ['officeId', 'selectedRouteIds'],
    handler: ([id]) => async (c, ctx, b) => ok(await setMemberOfficeRoutes(c, ctx, id!, b)) },
  { method: 'POST', pattern: new RegExp(`^/v1/members/${ID}/delete$`), fields: [], handler: ([id]) => async (c, ctx) => ok(await deleteMember(c, ctx, id!)) },
  // Ronda 40: enlace de primer acceso (no idempotente: el token nunca se guarda en `operations`).
  { method: 'POST', pattern: new RegExp(`^/v1/members/${ID}/access-link$`), fields: [],
    handler: ([id], provider) => async (c, ctx) => ok(await memberAccessLink(c, ctx, id!, provider)) },
  // ---------- Categorías de gasto ----------
  { method: 'GET', pattern: /^\/v1\/expense-categories$/, fields: null, handler: () => async (c, ctx) => ok({ categories: await listCategories(c, ctx) }) },
  { method: 'POST', pattern: /^\/v1\/expense-categories$/, fields: ['name', 'icon'], idempotent: 'expense_categories.create',
    handler: () => async (c, ctx, b) => created(await createCategory(c, ctx, b)) },
  { method: 'PATCH', pattern: new RegExp(`^/v1/expense-categories/${ID}$`), fields: ['name', 'icon', 'active'],
    handler: ([id]) => async (c, ctx, b) => ok(await updateCategory(c, ctx, id!, b)) },
  { method: 'POST', pattern: new RegExp(`^/v1/expense-categories/${ID}/delete$`), fields: [], handler: ([id]) => async (c, ctx) => ok(await deleteCategory(c, ctx, id!)) },
  // ---------- Clientes ----------
  { method: 'GET', pattern: /^\/v1\/document-types$/, fields: null, handler: () => async (c, ctx) => ok({ documentTypes: await documentTypes(c, ctx) }) },
  { method: 'GET', pattern: /^\/v1\/clients$/, fields: null, handler: () => async (c, ctx, _b, q) => ok({ clients: await listClients(c, ctx, q) }) },
  { method: 'POST', pattern: /^\/v1\/clients$/, fields: CLIENT_FIELDS, idempotent: 'clients.create',
    handler: () => async (c, ctx, b) => created(await createClient(c, ctx, b)) },
  { method: 'GET', pattern: new RegExp(`^/v1/clients/${ID}$`), fields: null, handler: ([id]) => async (c, ctx) => ok(await getClient(c, ctx, id!)) },
  { method: 'PATCH', pattern: new RegExp(`^/v1/clients/${ID}$`), fields: CLIENT_FIELDS, handler: ([id]) => async (c, ctx, b) => ok(await updateClient(c, ctx, id!, b)) },
  { method: 'POST', pattern: new RegExp(`^/v1/clients/${ID}/status$`), fields: ['status'], handler: ([id]) => async (c, ctx, b) => ok(await setClientStatus(c, ctx, id!, b)) },
  { method: 'POST', pattern: new RegExp(`^/v1/clients/${ID}/delete$`), fields: [], handler: ([id]) => async (c, ctx) => ok(await deleteClient(c, ctx, id!)) },
  // ---------- Capital centralizado y custodia (Fase 3) ----------
  { method: 'GET', pattern: /^\/v1\/capital\/summary$/, fields: null, handler: () => async (c, ctx) => ok(await capitalSummary(c, ctx)) },
  { method: 'GET', pattern: /^\/v1\/capital\/reconciliation$/, fields: null, handler: () => async (c, ctx) => ok(await capitalReconciliation(c, ctx)) },
  { method: 'GET', pattern: /^\/v1\/capital\/controller-events$/, fields: null, handler: () => async (c, ctx, _b, q) => ok({ events: await listControllerEvents(c, ctx, q) }) },
  { method: 'GET', pattern: /^\/v1\/capital\/custody$/, fields: null, handler: () => async (c, ctx, _b, q) => ok({ positions: await listCustody(c, ctx, q) }) },
  { method: 'GET', pattern: /^\/v1\/capital\/operations$/, fields: null, handler: () => async (c, ctx, _b, q) => ok({ operations: await listOperations(c, ctx, q) }) },
  { method: 'GET', pattern: new RegExp(`^/v1/capital/operations/${ID}$`), fields: null, handler: ([id]) => async (c, ctx) => ok(await getOperation(c, ctx, id!)) },
  { method: 'POST', pattern: /^\/v1\/capital\/company\/deposits$/, fields: ['amountMinor', 'reason'], idempotent: 'capital.company_deposit', requiresOperation: true,
    handler: () => async (c, ctx, b, _q, op) => created(await companyDeposit(c, ctx, b, op)) },
  { method: 'POST', pattern: /^\/v1\/capital\/company\/withdrawals$/, fields: ['amountMinor', 'reason'], idempotent: 'capital.company_withdrawal', requiresOperation: true,
    handler: () => async (c, ctx, b, _q, op) => created(await companyWithdrawal(c, ctx, b, op)) },
  { method: 'POST', pattern: /^\/v1\/capital\/allocations$/, fields: ['adminId', 'amountMinor', 'reason', 'requestId'], idempotent: 'capital.admin_allocation', requiresOperation: true,
    handler: () => async (c, ctx, b, _q, op) => created(await allocateToAdmin(c, ctx, b, op)) },
  // SuperAdmin: recoge de un Administrador. Administrador (Ronda 59): devuelve de SU bolsa, sin aprobación.
  { method: 'POST', pattern: /^\/v1\/capital\/admin-returns$/, fields: ['adminId', 'amountMinor', 'reason', 'requestId'], idempotent: 'capital.admin_return', requiresOperation: true,
    handler: () => async (c, ctx, b, _q, op) => created(await returnFromAdmin(c, ctx, b, op)) },
  // Ronda 59: el Cobrador entrega SU efectivo al responsable de la ruta, sin aprobación.
  { method: 'POST', pattern: /^\/v1\/capital\/own-returns$/, fields: OWN_RETURN_FIELDS, idempotent: 'capital.own_return', requiresOperation: true,
    handler: () => async (c, ctx, b, _q, op) => created(await returnOwnCash(c, ctx, b, op)) },
  { method: 'POST', pattern: /^\/v1\/capital\/deliveries$/, fields: ['routeId', 'workerId', 'amountMinor', 'reason', 'saleRequestId'],
    idempotent: 'capital.worker_delivery', requiresOperation: true, handler: () => async (c, ctx, b, _q, op) => created(await deliverToWorker(c, ctx, b, op)) },
  { method: 'POST', pattern: /^\/v1\/capital\/returns$/, fields: ['routeId', 'workerId', 'amountMinor', 'reason'], idempotent: 'capital.worker_return', requiresOperation: true,
    handler: () => async (c, ctx, b, _q, op) => created(await returnFromWorker(c, ctx, b, op)) },
  { method: 'POST', pattern: /^\/v1\/capital\/worker-transfers$/, fields: ['routeId', 'fromWorkerId', 'toWorkerId', 'amountMinor', 'reason'],
    idempotent: 'capital.worker_transfer', requiresOperation: true, handler: () => async (c, ctx, b, _q, op) => created(await transferBetweenWorkers(c, ctx, b, op)) },
  { method: 'POST', pattern: /^\/v1\/capital\/route-reassignments$/, fields: ['fromRouteId', 'toRouteId', 'fromWorkerId', 'toWorkerId', 'amountMinor', 'reason'],
    idempotent: 'capital.route_reassignment', requiresOperation: true, handler: () => async (c, ctx, b, _q, op) => created(await reassignBetweenRoutes(c, ctx, b, op)) },
  { method: 'POST', pattern: new RegExp(`^/v1/capital/operations/${ID}/reverse$`), fields: ['reason'], idempotent: 'capital.reversal', requiresOperation: true,
    handler: ([id]) => async (c, ctx, b, _q, op) => created(await reverseOperation(c, ctx, id!, b, op)) },
  // ---------- Traspasos entre Administradores (Ronda 53, D2): compromiso → confirmaciones → aplicación ----------
  { method: 'GET', pattern: /^\/v1\/capital\/admin-directory$/, fields: null, handler: () => async (c, ctx) => ok({ admins: await adminDirectory(c, ctx) }) },
  { method: 'GET', pattern: /^\/v1\/capital\/admin-transfers$/, fields: null, handler: () => async (c, ctx, _b, q) => ok({ transfers: await listAdminTransfers(c, ctx, q) }) },
  { method: 'POST', pattern: /^\/v1\/capital\/admin-transfers$/, fields: REGISTER_FIELDS, idempotent: 'capital.admin_transfer_register', requiresOperation: true,
    handler: () => async (c, ctx, b, _q, op) => created(await registerAdminTransfer(c, ctx, b, op)) },
  { method: 'GET', pattern: new RegExp(`^/v1/capital/admin-transfers/${ID}$`), fields: null, handler: ([id]) => async (c, ctx) => ok(await getAdminTransfer(c, ctx, id!)) },
  { method: 'POST', pattern: new RegExp(`^/v1/capital/admin-transfers/${ID}/confirm$`), fields: [], idempotent: 'capital.admin_transfer_confirm', requiresOperation: true,
    handler: ([id]) => async (c, ctx, b, _q, op) => ok(await decideAdminTransfer(c, ctx, id!, 'confirm', b, op)) },
  { method: 'POST', pattern: new RegExp(`^/v1/capital/admin-transfers/${ID}/reject$`), fields: ['reason'], idempotent: 'capital.admin_transfer_reject', requiresOperation: true,
    handler: ([id]) => async (c, ctx, b, _q, op) => ok(await decideAdminTransfer(c, ctx, id!, 'reject', b, op)) },
  { method: 'POST', pattern: new RegExp(`^/v1/capital/admin-transfers/${ID}/cancel$`), fields: ['reason'], idempotent: 'capital.admin_transfer_cancel', requiresOperation: true,
    handler: ([id]) => async (c, ctx, b, _q, op) => ok(await cancelAdminTransfer(c, ctx, id!, b, op)) },
  // ---------- Solicitudes de capital y notificaciones (Ronda 59): pedir no mueve dinero ----------
  { method: 'GET', pattern: /^\/v1\/capital\/requests$/, fields: null, handler: () => async (c, ctx, _b, q) => ok({ requests: await listCapitalRequests(c, ctx, q) }) },
  { method: 'POST', pattern: /^\/v1\/capital\/requests$/, fields: REQUEST_FIELDS, idempotent: 'capital.request_create', requiresOperation: true,
    handler: () => async (c, ctx, b, _q, op) => created(await createCapitalRequest(c, ctx, b, op)) },
  { method: 'GET', pattern: new RegExp(`^/v1/capital/requests/${ID}$`), fields: null, handler: ([id]) => async (c, ctx) => ok(await getCapitalRequest(c, ctx, id!)) },
  { method: 'POST', pattern: new RegExp(`^/v1/capital/requests/${ID}/(reject|cancel)$`), fields: ['reason'], idempotent: 'capital.request_close', requiresOperation: true,
    handler: ([id, action]) => async (c, ctx, b, _q, op) => ok(await closeCapitalRequest(c, ctx, id!, action as 'reject' | 'cancel', b, op)) },
  { method: 'GET', pattern: /^\/v1\/notifications$/, fields: null, handler: () => async (c, ctx) => ok(await notifications(c, ctx)) },
  { method: 'GET', pattern: /^\/v1\/notifications\/count$/, fields: null, handler: () => async (c, ctx) => ok(await notificationCount(c, ctx)) },
  // ---------- Créditos: solicitud, autorización y desembolso (Fase 4, solo en línea) ----------
  { method: 'GET', pattern: new RegExp(`^/v1/credit-requests$`), fields: null, handler: () => async (c, ctx, _b, q) => ok({ requests: await listRequests(c, ctx, q) }) },
  { method: 'POST', pattern: new RegExp(`^/v1/credit-requests$`), fields: CREATE_REQUEST_FIELDS, idempotent: 'credit_requests.create',
    handler: () => async (c, ctx, b) => created(await createRequest(c, ctx, b)) },
  { method: 'GET', pattern: new RegExp(`^/v1/credit-requests/${ID}$`), fields: null, handler: ([id]) => async (c, ctx) => ok(await getRequest(c, ctx, id!)) },
  { method: 'POST', pattern: new RegExp(`^/v1/credit-requests/${ID}/approve$`), fields: APPROVE_FIELDS,
    handler: ([id]) => async (c, ctx, b) => ok(await approveRequest(c, ctx, id!, b)) },
  { method: 'POST', pattern: new RegExp(`^/v1/credit-requests/${ID}/reject$`), fields: ['reason'], handler: ([id]) => async (c, ctx, b) => ok(await rejectRequest(c, ctx, id!, b)) },
  { method: 'POST', pattern: new RegExp(`^/v1/credit-requests/${ID}/cancel$`), fields: ['reason'], handler: ([id]) => async (c, ctx, b) => ok(await cancelRequest(c, ctx, id!, b)) },
  // Ronda 65: `offline` = entregado sin conexión por el Cobrador con su efectivo en custodia.
  { method: 'POST', pattern: new RegExp(`^/v1/credit-requests/${ID}/disburse$`), fields: DISBURSE_FIELDS, idempotent: 'credits.disburse', requiresOperation: true,
    handler: ([id]) => async (c, ctx, b, _q, op) => created(await disburseRequest(c, ctx, id!, op, b)) },
  { method: 'POST', pattern: new RegExp(`^/v1/credits/direct$`), fields: DIRECT_FIELDS, idempotent: 'credits.direct', requiresOperation: true,
    handler: () => async (c, ctx, b, _q, op) => created(await directSale(c, ctx, b, op)) },
  { method: 'GET', pattern: new RegExp(`^/v1/credits$`), fields: null, handler: () => async (c, ctx, _b, q) => ok({ credits: await listCredits(c, ctx, q) }) },
  { method: 'GET', pattern: new RegExp(`^/v1/credits/${ID}$`), fields: null, handler: ([id]) => async (c, ctx) => ok(await getCredit(c, ctx, id!)) },
  { method: 'GET', pattern: /^\/v1\/installments$/, fields: null, handler: () => async (c, ctx, _b, q) => ok({ installments: await listInstallments(c, ctx, q) }) },
  // ---------- Recaudos y gastos (Fase 5, solo en línea) ----------
  { method: 'GET', pattern: /^\/v1\/collections$/, fields: null, handler: () => async (c, ctx, _b, q) => ok({ collections: await listCollections(c, ctx, q) }) },
  { method: 'POST', pattern: /^\/v1\/collections$/, fields: COLLECTION_FIELDS, idempotent: 'collections.register', requiresOperation: true,
    handler: () => async (c, ctx, b, _q, op) => created(await registerCollection(c, ctx, b, op)) },
  { method: 'GET', pattern: new RegExp(`^/v1/collections/${ID}$`), fields: null, handler: ([id]) => async (c, ctx) => ok(await getCollection(c, ctx, id!)) },
  { method: 'POST', pattern: new RegExp(`^/v1/collections/${ID}/reverse$`), fields: ['reason'], idempotent: 'collections.reverse', requiresOperation: true,
    handler: ([id]) => async (c, ctx, b, _q, op) => created(await reverseCollection(c, ctx, id!, b, op)) },
  // Corrección de pagos y solicitudes de ajuste (ADEX Online, 0017).
  { method: 'POST', pattern: new RegExp(`^/v1/collections/${ID}/correct$`), fields: CORRECTION_FIELDS, idempotent: 'collections.correct', requiresOperation: true,
    handler: ([id]) => async (c, ctx, b, _q, op) => created(await correctCollection(c, ctx, id!, b, op)) },
  { method: 'GET', pattern: /^\/v1\/payment-adjustments$/, fields: null, handler: () => async (c, ctx, _b, q) => ok({ adjustments: await listAdjustments(c, ctx, q) }) },
  { method: 'POST', pattern: /^\/v1\/payment-adjustments$/, fields: ADJUSTMENT_FIELDS, idempotent: 'payment_adjustments.create', requiresOperation: true,
    handler: () => async (c, ctx, b) => created(await createAdjustment(c, ctx, b)) },
  { method: 'POST', pattern: new RegExp(`^/v1/payment-adjustments/${ID}/approve$`), fields: [], idempotent: 'payment_adjustments.approve', requiresOperation: true,
    handler: ([id]) => async (c, ctx, _b, _q, op) => ok(await approveAdjustment(c, ctx, id!, op)) },
  { method: 'POST', pattern: new RegExp(`^/v1/payment-adjustments/${ID}/reject$`), fields: ['reason'], handler: ([id]) => async (c, ctx, b) => ok(await rejectAdjustment(c, ctx, id!, b)) },
  // Visitas sin pago (ADEX Online, 0015): no mueven dinero; idempotentes como cualquier alta.
  { method: 'GET', pattern: /^\/v1\/no-payment-visits$/, fields: null, handler: () => async (c, ctx, _b, q) => ok({ visits: await listVisits(c, ctx, q) }) },
  { method: 'POST', pattern: /^\/v1\/no-payment-visits$/, fields: VISIT_FIELDS, idempotent: 'no_payment_visits.register', requiresOperation: true,
    handler: () => async (c, ctx, b, _q, op) => created(await registerVisit(c, ctx, b, op)) },
  { method: 'GET', pattern: /^\/v1\/expenses$/, fields: null, handler: () => async (c, ctx, _b, q) => ok({ expenses: await listExpenses(c, ctx, q) }) },
  { method: 'POST', pattern: /^\/v1\/expenses$/, fields: EXPENSE_FIELDS, idempotent: 'expenses.create', requiresOperation: true,
    handler: () => async (c, ctx, b, _q, op) => created(await createExpense(c, ctx, b, op)) },
  { method: 'GET', pattern: new RegExp(`^/v1/expenses/${ID}$`), fields: null, handler: ([id]) => async (c, ctx) => ok(await getExpense(c, ctx, id!)) },
  { method: 'POST', pattern: new RegExp(`^/v1/expenses/${ID}/reverse$`), fields: ['reason'], idempotent: 'expenses.reverse', requiresOperation: true,
    handler: ([id]) => async (c, ctx, b, _q, op) => created(await reverseExpense(c, ctx, id!, b, op)) },
  { method: 'POST', pattern: new RegExp(`^/v1/expenses/${ID}/refunds$`), fields: ['amountMinor', 'reason'], idempotent: 'expenses.refund', requiresOperation: true,
    handler: ([id]) => async (c, ctx, b, _q, op) => created(await refundExpense(c, ctx, id!, b, op)) },
  // ---------- Cuadres y cierres (Fase 6, solo en línea) ----------
  { method: 'GET', pattern: /^\/v1\/settlements\/workers$/, fields: null, handler: () => async (c, ctx, _b, q) => ok(await settleableWorkers(c, ctx, q)) },
  { method: 'GET', pattern: /^\/v1\/settlements\/preview$/, fields: null, handler: () => async (c, ctx, _b, q) => ok(await previewSettlement(c, ctx, q)) },
  { method: 'GET', pattern: /^\/v1\/settlements$/, fields: null, handler: () => async (c, ctx, _b, q) => ok({ settlements: await listSettlements(c, ctx, q) }) },
  { method: 'POST', pattern: /^\/v1\/settlements$/, fields: SETTLEMENT_FIELDS, idempotent: 'settlements.close', requiresOperation: true,
    handler: () => async (c, ctx, b, _q, op) => created(await closeSettlement(c, ctx, b, op)) },
  { method: 'GET', pattern: new RegExp(`^/v1/settlements/${ID}$`), fields: null, handler: ([id]) => async (c, ctx) => ok(await getSettlement(c, ctx, id!)) },
  { method: 'POST', pattern: new RegExp(`^/v1/settlements/${ID}/reopen$`), fields: ['reason'], idempotent: 'settlements.reopen', requiresOperation: true,
    handler: ([id]) => async (c, ctx, b, _q, op) => created(await reopenSettlement(c, ctx, id!, b, op)) },
  { method: 'GET', pattern: /^\/v1\/periods\/calendar$/, fields: null, handler: () => async (c, ctx) => ok(await periodCalendar(c, ctx)) },
  { method: 'GET', pattern: /^\/v1\/periods\/liquidation$/, fields: null, handler: () => async (c, ctx, _b, q) => ok(await liquidation(c, ctx, q)) },
  { method: 'GET', pattern: /^\/v1\/periods$/, fields: null, handler: () => async (c, ctx, _b, q) => ok({ closures: await listClosures(c, ctx, q) }) },
  { method: 'POST', pattern: /^\/v1\/periods\/close$/, fields: PERIOD_CLOSE_FIELDS, idempotent: 'periods.close', requiresOperation: true,
    handler: () => async (c, ctx, b, _q, op) => created(await closePeriod(c, ctx, b, op)) },
  { method: 'GET', pattern: new RegExp(`^/v1/periods/${ID}$`), fields: null, handler: ([id]) => async (c, ctx) => ok(await getClosure(c, ctx, id!)) },
  { method: 'POST', pattern: new RegExp(`^/v1/periods/${ID}/reopen$`), fields: ['reason'], idempotent: 'periods.reopen', requiresOperation: true,
    handler: ([id]) => async (c, ctx, b, _q, op) => ok(await reopenPeriod(c, ctx, id!, b, op)) },
  // ---------- Operaciones inciertas (ADEX Online v1) ----------
  // Si la respuesta de un comando se pierde (red caída), el cliente consulta aquí su
  // `X-Adex-Operation-Id` ANTES de repetirlo. 404 = el comando no llegó a confirmarse
  // (su transacción se revirtió entera): repetirlo con el mismo id es seguro.
  { method: 'GET', pattern: new RegExp(`^/v1/operations/${ID}$`), fields: null, handler: ([id]) => async (c, ctx) => ok(await getOperationOutcome(c, ctx, id!)) },
  // ---------- Modo sin conexión del Cobrador (Ronda 62, 0026) ----------
  // Llave con la que el dispositivo cifra su copia de consulta y sus pendientes. Solo la
  // membresía del contexto (Cobrador activo) la obtiene; no se guarda en `operations`.
  { method: 'POST', pattern: /^\/v1\/offline\/key$/, fields: [], handler: () => async (c, ctx) => ok(await offlineKey(c, ctx)) },
];

async function getOperationOutcome(c: pg.PoolClient, ctx: ActiveContext, operationId: string) {
  if (!UUID_RE.test(operationId)) throw new ApiError(400, 'INVALID_OPERATION_ID');
  // RLS (`operations_ctx`): solo las operaciones de ESTA membresía.
  const r = await c.query<{ kind: string; outcome: string; http_status: number | null; result: unknown; created_at: Date }>(
    'select kind, outcome, http_status, result, created_at from adex.operations where company_id = $1 and operation_id = $2 and membership_id = $3',
    [ctx.companyId, operationId.toLowerCase(), ctx.membershipId]);
  const row = r.rows[0];
  if (!row) throw new ApiError(404, 'OPERATION_NOT_FOUND');
  return { operationId: operationId.toLowerCase(), kind: row.kind, outcome: row.outcome, httpStatus: row.http_status, result: row.result,
    createdAt: row.created_at.toISOString() };
}

function match(method: string, path: string): { e: Endpoint; params: string[] } | null {
  for (const e of ENDPOINTS) {
    if (e.method !== method) continue;
    const m = e.pattern.exec(path);
    if (!m) continue;
    let params: string[];
    try { params = m.slice(1).map((p) => decodeURIComponent(p)); } catch { throw new ApiError(404, 'NOT_FOUND'); }
    return { e, params };
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Idempotencia (P3): el registro de la operación y el comando viven en la MISMA
 * transacción. Un reintento con el mismo id y los mismos parámetros devuelve el
 * resultado guardado sin repetir nada; con otros parámetros (u otra membresía), 409.
 * Dos reintentos simultáneos se serializan en la clave primaria de `operations`.
 */
async function withOperation(c: pg.PoolClient, ctx: ActiveContext, operationId: string, kind: string, path: string, body: unknown, run: () => Promise<Result>): Promise<Result> {
  // La ruta de la URL forma parte de los parámetros: en `…/:id/disburse` o `…/:id/reverse`
  // el recurso va en la URL, no en el cuerpo (Fase 4, CC4-002).
  const hash = createHash('sha256').update(JSON.stringify([kind, path, body])).digest('hex');
  const ins = await c.query(
    `insert into adex.operations (company_id, operation_id, kind, request_hash, membership_id, outcome)
     values ($1, $2, $3, $4, $5, 'pending') on conflict do nothing`, [ctx.companyId, operationId, kind, hash, ctx.membershipId]);
  if (ins.rowCount === 0) {
    const prev = await c.query<{ kind: string; request_hash: string; http_status: number; result: unknown }>(
      'select kind, request_hash, http_status, result from adex.operations where company_id = $1 and operation_id = $2', [ctx.companyId, operationId]);
    const row = prev.rows[0];
    if (!row || row.kind !== kind || row.request_hash !== hash) throw new ApiError(409, 'OPERATION_ID_REUSED');
    return { status: row.http_status, body: row.result };
  }
  const result = await run();
  await c.query(`update adex.operations set outcome = 'approved', http_status = $3, result = $4 where company_id = $1 and operation_id = $2`,
    [ctx.companyId, operationId, result.status, JSON.stringify(result.body)]);
  return result;
}

/** Petición ya autenticada (token verificado) y con el cuerpo ya leído. */
export interface CompanyCall {
  method: string;
  path: string;
  query?: URLSearchParams;
  membershipId: string | undefined;
  operationId?: string | null;
  /** Cuerpo JSON (objeto) o `undefined` si no hay. */
  body?: Record<string, unknown>;
  /**
   * SOLO la inicialización de la Empresa Demo (en proceso, nunca desde HTTP): día contable
   * simulado de esta llamada. PostgreSQL lo acepta únicamente para una Demo en
   * aprovisionamiento (`adex.business_today`, 0018); cualquier otra empresa lo ignora.
   */
  seedDay?: string;
}

export type CompanyExecutor = (claims: SessionClaims, call: CompanyCall) => Promise<Result>;

/**
 * Núcleo de la API de empresa: misma tabla de endpoints, mismas validaciones, misma
 * transacción con contexto e idempotencia, con o sin HTTP. El servidor HTTP lo usa
 * para cada petición; el aprovisionamiento de la Empresa Demo lo usa para ejecutar su
 * escenario con el MISMO motor (nunca uno de simulación).
 */
export function createCompanyExecutor(opts: CompanyApiOptions): CompanyExecutor {
  const txOpts = { lockTimeoutMs: opts.lockTimeoutMs };
  return async function execute(claims, call) {
    const found = match(call.method, call.path);
    if (!found) throw new ApiError(404, 'NOT_FOUND');
    const membershipId = call.membershipId?.trim();
    if (!membershipId) throw new ApiError(400, 'MEMBERSHIP_REQUIRED');
    const operationId = call.operationId?.trim() ? call.operationId.trim().toLowerCase() : null;
    if (operationId && (!UUID_RE.test(operationId) || !found.e.idempotent)) throw new ApiError(400, 'INVALID_OPERATION_ID');
    if (found.e.requiresOperation && !operationId) throw new ApiError(400, 'OPERATION_ID_REQUIRED');
    let body: Record<string, unknown> = {};
    if (found.e.fields) {
      if (call.body === undefined) throw new ApiError(415, 'JSON_REQUIRED');
      body = checkFields(call.body, found.e.fields);
    }
    const handler = found.e.handler(found.params, opts.provider);
    const query = call.query ?? new URLSearchParams();
    return withTransaction(opts.pool, async (c) => {
      const ctx = await resolveContext(c, claims, membershipId);
      if (call.seedDay) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(call.seedDay)) throw new ApiError(400, 'INVALID_INPUT', 'seedDay is invalid');
        await c.query(`select set_config('adex.seed_today', $1, true)`, [call.seedDay]);
      }
      await opts.afterContext?.(ctx, call.path);
      const run = () => handler(c, ctx, body, query, operationId);
      const out = operationId ? await withOperation(c, ctx, operationId, found.e.idempotent!, call.path, body, run) : await run();
      await opts.beforeCommit?.(ctx, call.path);
      return out;
    }, txOpts);
  };
}

/** Error de la API → respuesta (los errores de PostgreSQL conocidos se traducen; el resto es 500). */
export function errorResponse(err: unknown, onError?: (err: unknown) => void): Result {
  const e = err instanceof ApiError ? err : fromPgError(err);
  if (e) return { status: e.status, body: e.details ? { error: e.code, details: e.details } : { error: e.code } };
  onError?.(err);
  return { status: 500, body: { error: 'INTERNAL' } };
}

/** Manejador HTTP de la API de empresa (montable en el servidor compuesto de ADEX Online). */
export function createCompanyHandler(opts: CompanyApiOptions): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const txOpts = { lockTimeoutMs: opts.lockTimeoutMs };
  const execute = createCompanyExecutor(opts);
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      // Ruta conocida o no: sin token válido no se revela nada.
      const token = bearer(req.headers['authorization']);
      const claims = await opts.verifyToken(token);

      if (method === 'GET' && url.pathname === '/v1/me/memberships') {
        const memberships = await withTransaction(opts.pool, (c) => listOwnMemberships(c, claims), txOpts);
        return send(res, 200, { identityId: claims.identityId, memberships });
      }
      if (method === 'POST' && url.pathname === '/v1/session/logout') {
        const scope = scopeOf(await readJson(req, ['scope']));
        await withTransaction(opts.pool, async (c) => {
          await resolveIdentity(c, claims);
          await logout(c, claims, scope);
        }, txOpts);
        // ADEX ya cortó la sesión; el proveedor es segundo paso y no la «desrevoca» si falla.
        let providerRevoked = true;
        try { await opts.provider.signOut(token, scope); } catch (e) { providerRevoked = false; opts.onError?.(e); }
        return send(res, 200, { revoked: true, scope, providerRevoked });
      }

      const found = match(method, url.pathname);
      if (!found) throw new ApiError(404, 'NOT_FOUND');
      const membershipHeader = req.headers['x-adex-membership'];
      if (typeof membershipHeader !== 'string' || membershipHeader.trim() === '') throw new ApiError(400, 'MEMBERSHIP_REQUIRED');
      const opHeader = req.headers['x-adex-operation-id'];
      const operationId = typeof opHeader === 'string' ? opHeader : null;
      // Mismo orden de rechazos que antes del cuerpo: un id inválido no lee nada.
      if (operationId?.trim() && (!UUID_RE.test(operationId.trim()) || !found.e.idempotent)) throw new ApiError(400, 'INVALID_OPERATION_ID');
      if (found.e.requiresOperation && !operationId?.trim()) throw new ApiError(400, 'OPERATION_ID_REQUIRED');
      const body = found.e.fields ? await readJsonObject(req) : undefined;
      const result = await execute(claims, { method, path: url.pathname, query: url.searchParams, membershipId: membershipHeader, operationId, body });
      send(res, result.status, result.body);
    } catch (err) {
      const r = errorResponse(err, opts.onError);
      send(res, r.status, r.body);
    }
  };
}

export function createCompanyApi(opts: CompanyApiOptions): http.Server {
  const handle = createCompanyHandler(opts);
  return http.createServer((req, res) => { void handle(req, res); });
}
