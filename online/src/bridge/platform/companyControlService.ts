// PUENTE de `src/platform/companyControlService.ts` (CLEAN).
//
// · Bundle de EMPRESAS: el plano Owner es OTRO servicio (DS-17): la empresa nunca escribe
//   en él. La telemetría que CLEAN registraba desde el navegador (último ingreso, métricas
//   de rutas) la produce el servidor (`record_company_login` al elegir contexto; las rutas
//   las cuenta un disparador del plano de control, 0021). Aquí no se hace nada.
// · Bundle OWNER (Ronda 40): las operaciones de la Plataforma Owner original (alta de
//   empresa con su primer Super Admin, estado comercial, datos comerciales y cobros) con
//   las MISMAS firmas, ejecutadas por el servidor Owner. Diferencias, todas del servidor:
//     - el primer Super Admin NO recibe contraseña de nadie: se le entrega un ENLACE DE
//       PRIMER ACCESO de un solo uso para que fije la suya (`access`);
//     - país, moneda y zona horaria se fijan en el alta y no cambian después.

export * from '@clean/platform/companyControlService';
import type * as Clean from '@clean/platform/companyControlService';
import type { CompanyCommercialStatus, CompanyControlRecord, PlatformUser, SaaSPayment } from '@clean/platform/types';
import type { Tenant, User } from '@clean/models/types';
import { today } from '@clean/lib/formatters';
import { ownerApiOrFail, paymentFrom, recordFrom, type ServerCompany } from '@/platform/controlPlane';

async function noop(): Promise<void> { /* lo registra el servidor */ }

export const recordTenantLogin = noop as unknown as typeof Clean.recordTenantLogin;
export const syncRouteMetrics = noop as unknown as typeof Clean.syncRouteMetrics;

// ---------- Plataforma Owner (servidor) ----------

/** Monedas y países que el servidor admite hoy (tabla `adex.currencies`: BRL y COP). */
export const ONLINE_COUNTRIES = [
  { code: 'CO', label: 'Colombia', currency: 'COP', timezones: ['America/Bogota'] },
  { code: 'BR', label: 'Brasil', currency: 'BRL',
    timezones: ['America/Sao_Paulo', 'America/Bahia', 'America/Fortaleza', 'America/Recife', 'America/Maceio', 'America/Belem',
      'America/Araguaina', 'America/Santarem', 'America/Manaus', 'America/Cuiaba', 'America/Campo_Grande', 'America/Porto_Velho',
      'America/Boa_Vista', 'America/Rio_Branco', 'America/Noronha'] },
] as const;
export const ONLINE_CURRENCIES = ['COP', 'BRL'] as const;

/** Resultado de un enlace de primer acceso. El enlace se muestra UNA vez y no se guarda. */
export type AccessLinkResult =
  | { status: 'issued'; url: string }
  | { status: 'already_active' }
  | { status: 'existing' }
  | { status: 'failed'; message: string };

export function accessLinkUrl(tokenHash: string): string {
  return `${window.location.origin}/activar#t=${encodeURIComponent(tokenHash)}`;
}

const MESSAGES: Record<string, string> = {
  NETWORK: 'Sin conexión con el servicio Owner. Intente de nuevo.',
  INVALID_NAME: 'Escribe el nombre de la empresa.',
  INVALID_EMAIL: 'Escribe un correo válido (empresa y Super Admin).',
  INVALID_DISPLAYNAME: 'Escribe el nombre del Super Admin.',
  INVALID_COUNTRYCODE: 'Elige el país de la empresa.',
  INVALID_CURRENCYCODE: 'Elige una moneda admitida (COP o BRL).',
  INVALID_TIMEZONE: 'Elige la zona horaria.',
  INVALID_CONTACTEMAIL: 'Escribe un correo de contacto válido.',
  CONFLICT: 'Ya existe una empresa o una persona con esos datos.',
  PERMISSION_DENIED: 'Operación no permitida: un Owner no puede ser Super Admin de una empresa.',
  OPERATOR_REQUIRED: 'Tu cuenta ya no es Owner activo de la plataforma.',
  IDENTITY_SHARED: 'Esa persona ya usa ADEX en otra empresa: entra con su propia contraseña y verá esta empresa al elegir el contexto.',
  MEMBERSHIP_INACTIVE: 'Ese Super Admin está inactivo.',
  NOT_FOUND: 'No existe en el plano de control.',
  IDENTITY_PROVIDER_ERROR: 'El proveedor de identidad no respondió. Intente de nuevo.',
};
export function ownerErrorText(e: unknown): string {
  const code = (e as { code?: string })?.code ?? '';
  return MESSAGES[code] ?? (code ? `No se pudo completar la operación (${code}).` : 'No se pudo completar la operación.');
}

const isOwner = (a: PlatformUser | null | undefined) => Boolean(a && a.rol === 'owner' && a.status === 'activo');
const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/** Enlace de primer acceso de un Super Admin (lo pide el Owner; el servidor decide). */
export async function issueSuperadminAccessLink(companyId: string, membershipId: string): Promise<AccessLinkResult> {
  try {
    const r = await ownerApiOrFail().send<{ status: 'issued'; tokenHash: string } | { status: 'already_active' }>('POST',
      `/control/v1/companies/${encodeURIComponent(companyId)}/superadmins/${encodeURIComponent(membershipId)}/access-link`, {});
    return r.status === 'issued' ? { status: 'issued', url: accessLinkUrl(r.tokenHash) } : { status: 'already_active' };
  } catch (e) {
    return { status: 'failed', message: ownerErrorText(e) };
  }
}

export type OnlineCreateCompanyInput = Clean.CreateCompanyInput & { zonaHoraria?: string };
export type OnlineCreateCompanyResult =
  | { ok: true; tenant: Tenant; superAdmin: User; record: CompanyControlRecord; access: AccessLinkResult }
  | Clean.CreateCompanyFailure;

async function createOnline(actor: PlatformUser, input: OnlineCreateCompanyInput): Promise<OnlineCreateCompanyResult> {
  const fail = (code: Clean.CreateCompanyRejectionCode, message: string): Clean.CreateCompanyFailure => ({ ok: false, code, message });
  if (!isOwner(actor)) return fail('NOT_OWNER', 'Solo un Owner activo puede dar de alta empresas.');
  if (!input.nombre?.trim()) return fail('INVALID_COMPANY_NAME', 'Escribe el nombre de la empresa.');
  if (!emailOk(input.email ?? '')) return fail('INVALID_COMPANY_EMAIL', 'Escribe un correo de empresa válido.');
  if (!input.superAdmin?.nombre?.trim()) return fail('INVALID_ADMIN_NAME', 'Escribe el nombre del Super Admin.');
  if (!emailOk(input.superAdmin?.email ?? '')) return fail('INVALID_ADMIN_EMAIL', 'Escribe un correo válido para el Super Admin.');
  const country = ONLINE_COUNTRIES.find((c) => c.code === input.pais);
  if (!country) return fail('WRITE_FAILED', 'Elige el país de la empresa.');
  const currency = input.moneda ?? country.currency;
  if (!(ONLINE_CURRENCIES as readonly string[]).includes(currency)) return fail('WRITE_FAILED', 'Elige una moneda admitida (COP o BRL).');
  const timezone = input.zonaHoraria ?? country.timezones[0];
  const body: Record<string, unknown> = {
    name: input.nombre.trim(), email: input.email.trim().toLowerCase(), countryCode: country.code, countryLabel: country.label,
    currencyCode: currency, timezone, billingMode: input.billingMode ?? 'per_route', billingRate: input.billingRate ?? 0,
    status: input.status === 'active' ? 'active' : 'trial',
    superAdmin: { email: input.superAdmin.email.trim().toLowerCase(), displayName: input.superAdmin.nombre.trim() },
  };
  if (input.identificacion?.trim()) body['taxId'] = input.identificacion.trim();
  if (input.contacto?.trim()) body['contactName'] = input.contacto.trim();
  let created: ServerCompany & { superAdmin: { membershipId: string; identity: 'new' | 'existing' } };
  try {
    created = await ownerApiOrFail().send('POST', '/control/v1/companies', body);
  } catch (e) {
    return fail('WRITE_FAILED', ownerErrorText(e));
  }
  const access: AccessLinkResult = created.superAdmin.identity === 'existing'
    ? { status: 'existing' }
    : await issueSuperadminAccessLink(created.companyId, created.superAdmin.membershipId);
  const record = recordFrom(created);
  return {
    ok: true, record, access,
    tenant: { id: created.companyId, nombre: created.name } as Tenant,
    superAdmin: { id: created.superAdmin.membershipId, nombre: input.superAdmin.nombre.trim(), email: input.superAdmin.email.trim().toLowerCase() } as User,
  };
}
export const createCompanyWithFirstSuperAdmin = createOnline as unknown as typeof Clean.createCompanyWithFirstSuperAdmin;

async function setStatusOnline(actor: PlatformUser, companyId: string, status: CompanyCommercialStatus): Promise<{ ok: boolean; error?: string }> {
  if (!isOwner(actor)) return { ok: false, error: 'Solo un Owner activo puede cambiar el estado del servicio.' };
  try {
    await ownerApiOrFail().send('POST', `/control/v1/companies/${encodeURIComponent(companyId)}/status`, { status });
    return { ok: true };
  } catch (e) { return { ok: false, error: ownerErrorText(e) }; }
}
export const setCompanyCommercialStatus = setStatusOnline as unknown as typeof Clean.setCompanyCommercialStatus;

async function currentRecord(companyId: string): Promise<ServerCompany> {
  const r = await ownerApiOrFail().get<{ company: ServerCompany }>(`/control/v1/companies/${encodeURIComponent(companyId)}`);
  return r.company;
}

async function putBilling(companyId: string, c: ServerCompany, changes: Partial<{ billingMode: string; billingRate: number; nextBillingDate: string | null; paymentStatus: string }>) {
  await ownerApiOrFail().send('PUT', `/control/v1/companies/${encodeURIComponent(companyId)}/billing`, {
    billingMode: changes.billingMode ?? c.billingMode, billingRate: changes.billingRate ?? c.billingRate,
    nextBillingDate: changes.nextBillingDate === undefined ? c.nextBillingDate : changes.nextBillingDate,
    paymentStatus: changes.paymentStatus ?? c.paymentStatus,
  });
}

async function updateBillingOnline(actor: PlatformUser, companyId: string, changes: Clean.BillingUpdate): Promise<{ ok: boolean; error?: string }> {
  if (!isOwner(actor)) return { ok: false, error: 'Solo un Owner activo puede editar los datos comerciales.' };
  try {
    const c = await currentRecord(companyId);
    const profileKeys = ['nombre', 'identificacion', 'contacto', 'contactoEmail'] as const;
    if (profileKeys.some((k) => k in changes)) {
      await ownerApiOrFail().send('PUT', `/control/v1/companies/${encodeURIComponent(companyId)}/profile`, {
        name: changes.nombre ?? c.name, taxId: changes.identificacion ?? c.taxId ?? '', contactName: changes.contacto ?? c.contactName ?? '',
        contactEmail: changes.contactoEmail ?? c.contactEmail ?? '',
      });
    }
    if (['billingMode', 'billingRate', 'nextBillingDate', 'paymentStatus'].some((k) => k in changes)) {
      await putBilling(companyId, c, {
        billingMode: changes.billingMode, billingRate: changes.billingRate, paymentStatus: changes.paymentStatus,
        nextBillingDate: 'nextBillingDate' in changes ? (changes.nextBillingDate || null) : undefined,
      });
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: ownerErrorText(e) }; }
}
export const updateCompanyBilling = updateBillingOnline as unknown as typeof Clean.updateCompanyBilling;

async function registerPaymentOnline(actor: PlatformUser, input: Clean.RegisterPaymentInput): Promise<{ ok: boolean; error?: string; payment?: SaaSPayment }> {
  if (!isOwner(actor)) return { ok: false, error: 'Solo un Owner activo puede registrar cobros.' };
  if (!/^\d{4}-\d{2}$/.test(input.periodo)) return { ok: false, error: 'El período debe tener el formato AAAA-MM.' };
  if (!(input.valor > 0)) return { ok: false, error: 'El valor debe ser mayor que cero.' };
  if (!input.fechaEsperada) return { ok: false, error: 'Indica la fecha esperada de pago.' };
  try {
    const p = await ownerApiOrFail().send<Parameters<typeof paymentFrom>[0]>('POST', `/control/v1/companies/${encodeURIComponent(input.companyId)}/payments`, {
      period: input.periodo, amount: input.valor, expectedDate: input.fechaEsperada, status: input.status,
      ...(input.status === 'paid' ? { paidDate: today() } : {}), ...(input.nota?.trim() ? { note: input.nota.trim() } : {}),
    });
    // Como en CLEAN: el estado de pago de la empresa sigue al último cobro registrado.
    await putBilling(input.companyId, await currentRecord(input.companyId), { paymentStatus: input.status });
    return { ok: true, payment: paymentFrom(p, input.companyId) };
  } catch (e) { return { ok: false, error: ownerErrorText(e) }; }
}
export const registerSaaSPayment = registerPaymentOnline as unknown as typeof Clean.registerSaaSPayment;

async function markPaidOnline(actor: PlatformUser, payment: SaaSPayment, fechaPagada?: string): Promise<{ ok: boolean; error?: string }> {
  if (!isOwner(actor)) return { ok: false, error: 'Solo un Owner activo puede registrar cobros.' };
  try {
    await ownerApiOrFail().send('POST', `/control/v1/payments/${encodeURIComponent(payment.id)}/status`, { status: 'paid', paidDate: fechaPagada || today() });
    await putBilling(payment.companyId, await currentRecord(payment.companyId), { paymentStatus: 'paid' });
    return { ok: true };
  } catch (e) { return { ok: false, error: ownerErrorText(e) }; }
}
export const markPaymentPaid = markPaidOnline as unknown as typeof Clean.markPaymentPaid;
