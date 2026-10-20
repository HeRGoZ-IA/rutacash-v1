// PUENTE de `src/platform/controlPlane.ts` (CLEAN).
//
// · Bundle de EMPRESAS: el plano de control local de CLEAN no existe en ADEX Online (el
//   Owner es un servicio separado, DS-17). `controlPlane` es inerte: las llamadas de
//   telemetría de las pantallas de empresa no hacen nada (las registra el servidor).
// · Bundle OWNER (Ronda 40): la Plataforma Owner ORIGINAL de CLEAN lee del servicio Owner
//   (`/control/v1/*`). `owner/main.tsx` conecta su cliente con `connectOwnerApi`; solo
//   entonces `controlPlane` responde con datos del servidor. Las escrituras del plano no
//   pasan por aquí: van por las operaciones de `companyControlService` (servidor).
//
// No se reexporta el módulo original en tiempo de ejecución: importaría la base local de
// CLEAN (Dexie / proyección de empresa) en el bundle Owner. Solo sus tipos.

import type { SaaSControlPlane } from '@clean/platform/controlPlane';
import type { CompanyControlRecord, ControlEvent, ControlEventType, PlatformUser, SaaSPayment } from '@clean/platform/types';

export type { SaaSControlPlane, ControlPlaneDatabase } from '@clean/platform/controlPlane';

/** Mínimo que el plano Owner necesita del cliente del servicio Owner. */
export interface OwnerApi {
  get<T>(path: string): Promise<T>;
  send<T>(method: string, path: string, body?: unknown): Promise<T>;
}

let ownerApi: OwnerApi | null = null;

/** Lo llama SOLO el bundle Owner al arrancar. */
export function connectOwnerApi(api: OwnerApi): void { ownerApi = api; }

export function ownerApiOrFail(): OwnerApi {
  if (!ownerApi) throw new Error('El servicio Owner no está conectado.');
  return ownerApi;
}

// ---------- Formas del servidor → modelos de CLEAN ----------
export interface ServerCompany {
  companyId: string; name: string; taxId: string | null; contactName: string | null; contactEmail: string | null; createdAt: string;
  firstLoginAt: string | null; lastLoginAt: string | null; status: CompanyControlRecord['status']; routeCount: number; billableRouteCount: number;
  billingMode: CompanyControlRecord['billingMode']; billingRate: number; nextBillingDate: string | null; paymentStatus: CompanyControlRecord['paymentStatus'];
  updatedAt: string;
}
interface ServerPayment { id: string; companyId?: string; period: string; amount: number; expectedDate: string; paidDate: string | null; status: SaaSPayment['status']; note: string | null; createdAt: string }
export interface ServerLocale { countryCode: string; countryLabel: string; currencyCode: string; timezone: string }
export interface ServerSuperadmin { id: string; email: string; displayName: string; status: 'activo' | 'inactivo'; linkAllowed: boolean; createdAt: string }
export interface ServerDetail {
  company: ServerCompany; locale: ServerLocale | null; superadmins: ServerSuperadmin[];
  events: { type: ControlEventType; at: string; detail: string | null }[]; payments: ServerPayment[];
}

const opt = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? undefined : v);

export function recordFrom(c: ServerCompany): CompanyControlRecord {
  return {
    companyId: c.companyId, nombre: c.name, identificacion: opt(c.taxId), contacto: opt(c.contactName), contactoEmail: opt(c.contactEmail),
    createdAt: c.createdAt, firstLoginAt: opt(c.firstLoginAt), lastLoginAt: opt(c.lastLoginAt), status: c.status, routeCount: c.routeCount,
    billableRouteCount: c.billableRouteCount, billingMode: c.billingMode, billingRate: c.billingRate, nextBillingDate: opt(c.nextBillingDate),
    paymentStatus: c.paymentStatus, updatedAt: c.updatedAt,
  };
}

export function paymentFrom(p: ServerPayment, companyId: string): SaaSPayment {
  return {
    id: p.id, companyId: p.companyId ?? companyId, periodo: p.period, valor: p.amount, fechaEsperada: p.expectedDate,
    fechaPagada: opt(p.paidDate), status: p.status, nota: opt(p.note), createdAt: p.createdAt, updatedAt: p.createdAt,
  };
}

// La ficha llega en UNA respuesta (control + historial + cobros + país + SuperAdmins); la
// pantalla original la pide en tres llamadas en paralelo: se comparte la misma petición.
const inflight = new Map<string, Promise<ServerDetail | null>>();
export function companyDetail(companyId: string): Promise<ServerDetail | null> {
  let p = inflight.get(companyId);
  if (!p) {
    p = ownerApiOrFail().get<ServerDetail>(`/control/v1/companies/${encodeURIComponent(companyId)}`)
      .catch((e: { status?: number }) => { if (e?.status === 404) return null; throw e; })
      .finally(() => setTimeout(() => inflight.delete(companyId), 1_000));
    inflight.set(companyId, p);
  }
  return p;
}

const serverOnly = (what: string) => async () => { throw new Error(`ADEX Online: «${what}» lo hace el servidor Owner.`); };

const online: SaaSControlPlane = {
  async listCompanies() {
    const r = await ownerApiOrFail().get<{ companies: ServerCompany[] }>('/control/v1/companies');
    return r.companies.map(recordFrom).sort((a, b) => a.nombre.localeCompare(b.nombre));
  },
  async getCompany(companyId) {
    const d = await companyDetail(companyId);
    return d ? recordFrom(d.company) : null;
  },
  async countRoutes(companyId) {
    const c = await ownerApiOrFail().send<ServerCompany>('POST', `/control/v1/companies/${encodeURIComponent(companyId)}/route-counts`, {});
    return { routeCount: c.routeCount, billableRouteCount: c.billableRouteCount };
  },
  async listPayments(companyId) {
    if (companyId) {
      const d = await companyDetail(companyId);
      return (d?.payments ?? []).map((p) => paymentFrom(p, companyId));
    }
    const r = await ownerApiOrFail().get<{ payments: ServerPayment[] }>('/control/v1/payments');
    return r.payments.map((p) => paymentFrom(p, p.companyId ?? ''));
  },
  async listEvents(companyId) {
    const d = await companyDetail(companyId);
    return (d?.events ?? []).map((e, i): ControlEvent => ({ id: `${e.at}-${i}`, companyId, type: e.type, at: e.at, detail: opt(e.detail) }));
  },
  async listOwners() {
    const r = await ownerApiOrFail().get<{ operators: { displayName: string; email: string; status: 'activo' | 'inactivo'; self: boolean;
      firstLoginAt: string | null; lastLoginAt: string | null; createdAt: string }[] }>('/control/v1/operators');
    return r.operators.map((o, i): PlatformUser => ({
      id: o.self ? OWNER_SELF_ID : `owner-${i}`, nombre: o.displayName, email: o.email, password: '', rol: 'owner', status: o.status,
      firstLoginAt: opt(o.firstLoginAt), lastLoginAt: opt(o.lastLoginAt), createdAt: o.createdAt, updatedAt: o.createdAt,
    }));
  },
  async getOwnerByEmail(email) {
    const wanted = email.trim().toLowerCase();
    return (await online.listOwners()).find((o) => o.email.toLowerCase() === wanted) ?? null;
  },
  putCompany: serverOnly('alta de empresa'),
  updateCompany: serverOnly('edición de empresa'),
  addPayment: serverOnly('alta de cobro'),
  updatePayment: serverOnly('edición de cobro'),
  addEvent: serverOnly('historial'),
  addOwner: serverOnly('alta de Owner'),
  updateOwner: serverOnly('edición de Owner'),
};

/** Id con el que el Owner de la sesión aparece en la lista de Owners (marca «· tú»). */
export const OWNER_SELF_ID = 'owner-self';

const inert = new Proxy({}, { get: () => async () => undefined }) as unknown as SaaSControlPlane;

export const controlPlane: SaaSControlPlane = new Proxy({} as SaaSControlPlane, {
  get: (_t, k: string | symbol) => (ownerApi ? online : inert)[k as keyof SaaSControlPlane],
});

/** En ADEX Online el plano de control ES compartido: lo sirve el servidor Owner. */
export const CONTROL_PLANE_IS_SHARED: boolean = true;

export const CONTROL_PLANE_SCOPE_NOTICE = '';

export const ALLOWED_CONTROL_EVENTS: readonly ControlEventType[] = [
  'COMPANY_CREATED', 'COMPANY_ACTIVATED', 'COMPANY_SUSPENDED', 'FIRST_LOGIN', 'LOGIN',
  'ROUTE_CREATED', 'ROUTE_DEACTIVATED', 'ROUTE_DELETED', 'BILLING_UPDATED', 'PAYMENT_REGISTERED',
] as const;
