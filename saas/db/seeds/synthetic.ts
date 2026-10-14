// ============================================================
// Datos SINTÉTICOS y DETERMINISTAS (Fases 0 y 1). Ningún dato real.
// ------------------------------------------------------------
// Registros con la forma EXACTA de los modelos de CLEAN (tipados con
// src/models/types.ts y src/platform/types.ts), para tres empresas:
//
//   c1 · Alfa Cobranças   · BR · BRL · America/Sao_Paulo
//   c2 · Beta Créditos    · CO · COP · America/Bogota
//   c3 · Gamma Préstamos  · CO · COP · America/Bogota
//
// Personas (una identidad cada una, DS-05):
//   ana    → admin c1 (rutas r1, r2) + cobradora c1 (solo r1) + supervisora c2 (r1)
//   bruno  → superadmin c1 · carla → superadmin c2 · diego → superadmin c3
//   elisa  → cobradora c2 (r1) · fabio → socio c1 · gabi → secretaria c1
//   hugo   → admin c2 (responsable de capital de c2/r1) · irene → admin c3
//   owner  → Owner del plano de control (sin membresías)
//   + una membresía HISTÓRICA sin identidad (c1, cobrador inactivo)
//
// Ids deterministas (`uid`), importes enteros en unidades de la moneda (como CLEAN)
// y correos `@example.test`. Cada campo de cada tabla aparece relleno al menos una
// vez (lo exige test/contracts/roundtrip).
// ============================================================

import { createHash } from 'node:crypto';
import type {
  AuditLog, CapitalLedgerEntry, CapitalMovement, CashCustodyMovement, CashSettlement, Client, Expense, ExpenseCategory,
  Installment, NoPaymentVisit, Office, PartnerCashMovement, Payment, PaymentAdjustmentRequest, Route,
  RouteCapitalControllerEvent, Sale, SaleRequest, Tenant, Transfer, User, WeeklySettlement, Withdrawal,
} from '@/models/types';
import type { CompanyControlRecord, ControlEvent, PlatformUser, SaaSPayment } from '@/platform/types';
import type { DexieSnapshot, ImportOptions } from '../../src/model/adapter.ts';

/** UUID determinista (formato v5, SHA-1 sobre un espacio fijo de ADEX). */
export function uid(name: string): string {
  const h = createHash('sha1').update(`adex-synthetic:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

export const PEOPLE = ['ana', 'bruno', 'carla', 'diego', 'elisa', 'fabio', 'gabi', 'hugo', 'irene', 'owner'] as const;
export type Person = (typeof PEOPLE)[number];
export const emailOf = (p: Person) => `${p}@example.test`;
export const identityOf = (p: Person) => uid(`identity:${p}`);

interface CompanySpec {
  key: 'c1' | 'c2' | 'c3';
  name: string;
  country: string;
  countryCode: string;
  currency: 'BRL' | 'COP';
  timezone: string;
  /** Escala de importes: BRL en reales, COP en pesos. */
  k: number;
  members: { key: string; person: Person | null; rol: User['rol']; routes: string[]; status?: User['status'] }[];
}

export const COMPANIES: readonly CompanySpec[] = [
  {
    key: 'c1', name: 'Alfa Cobranças', country: 'Brasil', countryCode: 'BR', currency: 'BRL', timezone: 'America/Sao_Paulo', k: 1,
    members: [
      { key: 'bruno-sa', person: 'bruno', rol: 'superadmin', routes: [] },
      { key: 'ana-admin', person: 'ana', rol: 'admin', routes: ['r1', 'r2'] },
      { key: 'ana-cob', person: 'ana', rol: 'cobrador', routes: ['r1'] },
      { key: 'fabio-socio', person: 'fabio', rol: 'socio', routes: ['r1', 'r2'] },
      { key: 'gabi-sec', person: 'gabi', rol: 'secretario', routes: ['r1'] },
      { key: 'ivan-hist', person: null, rol: 'cobrador', routes: ['r2'], status: 'inactivo' },
    ],
  },
  {
    key: 'c2', name: 'Beta Créditos', country: 'Colombia', countryCode: 'CO', currency: 'COP', timezone: 'America/Bogota', k: 1000,
    members: [
      { key: 'carla-sa', person: 'carla', rol: 'superadmin', routes: [] },
      { key: 'hugo-admin', person: 'hugo', rol: 'admin', routes: ['r1', 'r2'] },
      { key: 'ana-sup', person: 'ana', rol: 'supervisor', routes: ['r1'] },
      { key: 'elisa-cob', person: 'elisa', rol: 'cobrador', routes: ['r1'] },
    ],
  },
  {
    key: 'c3', name: 'Gamma Préstamos', country: 'Colombia', countryCode: 'CO', currency: 'COP', timezone: 'America/Bogota', k: 1000,
    members: [
      { key: 'diego-sa', person: 'diego', rol: 'superadmin', routes: [] },
      { key: 'irene-admin', person: 'irene', rol: 'admin', routes: ['r1', 'r2'] },
      { key: 'irene-cob', person: 'irene', rol: 'cobrador', routes: ['r2'] },
    ],
  },
];

const T0 = Date.parse('2026-09-21T12:00:00.000Z');
/** Instante determinista: `d` días y `h` horas después de T0. */
const at = (d: number, h = 0) => new Date(T0 + d * 86_400_000 + h * 3_600_000).toISOString();
/** Fecha contable determinista. */
const day = (d: number) => at(d).slice(0, 10);

function companyRecords(c: CompanySpec): DexieSnapshot {
  const id = (s: string) => uid(`${c.key}:${s}`);
  const m = (key: string) => id(`member:${key}`);
  const tenantId = id('tenant');
  const r = (n: 1 | 2 | 3) => id(`route:r${n}`);
  const sa = m(c.members[0]!.key);
  const admin = m(c.members[1]!.key);
  const worker = m(c.members.find((x) => x.rol === 'cobrador' || x.rol === 'supervisor')!.key);
  const v = (n: number) => n * c.k;

  const tenant: Required<Tenant> = {
    id: tenantId, nombre: c.name, nombreLegal: `${c.name} Ltda.`, nit: `${c.key.toUpperCase()}-900123`, email: `contacto-${c.key}@example.test`,
    telefono: '+00 000 0000', plan: 'operativo', status: 'activa', fechaVencimiento: '2027-12-31', logo: 'data:image/png;base64,AAAA',
    pais: c.country, ciudad: 'Ciudad Sintética', moneda: c.currency, direccion: 'Calle Ficticia 1', responsable: 'Responsable Sintético',
    cashModelStartAt: at(0), baseCustodyStartAt: at(0), createdAt: at(-30), updatedAt: at(0),
  };
  const offices: Required<Office>[] = [
    { id: id('office:1'), tenantId, nombre: 'Oficina Centro', codigo: 'OF-1', status: 'activa', createdAt: at(-30), updatedAt: at(-30) },
    { id: id('office:2'), tenantId, nombre: 'Oficina Norte', codigo: 'OF-2', status: 'inactiva', createdAt: at(-30), updatedAt: at(-2) },
  ];
  const users: User[] = c.members.map((x) => ({
    id: m(x.key), tenantId, nombre: `${x.person ?? 'ivan'} ${x.rol}`, email: x.person ? emailOf(x.person) : `ivan-${c.key}@example.test`,
    password: 'NO-SE-IMPORTA', rol: x.rol, telefono: '+00 111 1111', avatar: 'data:image/png;base64,BBBB',
    ...(x.routes.length ? { authorizedRouteIds: x.routes.map((k) => id(`route:${k}`)) } : {}),
    grantedCapabilities: [], revokedCapabilities: [], status: x.status ?? 'activo', createdAt: at(-29), updatedAt: at(-29),
  }));
  // Un usuario con TODOS los campos (incluidos los legados) para el contrato.
  const legacy = users.find((u) => u.id === worker)!;
  Object.assign(legacy, { routeId: legacy.authorizedRouteIds![0], canCreateDirectSales: false, maxDirectSaleAmount: v(100),
    grantedCapabilities: ['cashbox.viewOwnCollection'], revokedCapabilities: ['client.create'], mustChangePassword: false } satisfies Partial<User>);

  const routes: Required<Route>[] = ([1, 2, 3] as const).map((n) => ({
    id: r(n), tenantId, officeId: n === 3 ? (undefined as unknown as string) : offices[n === 1 ? 0 : 1]!.id, nombre: `Ruta ${n}`, codigo: `R${n}`,
    ciudad: 'Ciudad Sintética', email: `ruta${n}-${c.key}@example.test`, telefono: '+00 222 2222', tasaInteres: 20, tasaLibre: n === 2,
    montoMaximoPrestamo: v(2000), capitalInicial: v(5000), capitalActual: v(5000),
    cobradorId: n === 1 ? worker : (undefined as unknown as string),
    capitalControllerAdminId: n === 3 ? (undefined as unknown as string) : admin,
    capitalControllerSince: n === 3 ? (undefined as unknown as string) : at(-28),
    status: n === 3 ? 'inactiva' : 'activa', createdAt: at(-30), updatedAt: at(-28),
  }));
  for (const route of routes) for (const k of Object.keys(route) as (keyof Route)[]) if (route[k] === undefined) delete route[k];

  const categories: Required<ExpenseCategory>[] = [
    { id: id('cat:fuel'), tenantId, nombre: 'Combustible', icono: 'fuel', activa: true },
    { id: id('cat:office'), tenantId, nombre: 'Papelería', icono: 'paper', activa: false },
  ];
  const clients: Required<Client>[] = [1, 2, 3].map((n) => ({
    id: id(`client:${n}`), tenantId, routeId: n === 3 ? r(2) : r(1), nombre: `Cliente ${n}`, documento: `${c.key}-DOC-${n}`,
    telefonoPrincipal: '+00 333 3333', telefonoSecundario: '+00 444 4444', direccionPrincipal: 'Calle 1', direccionSecundaria: 'Calle 2',
    negocio: 'Tienda', fotoDocumentoUrl: 'data:image/png;base64,CCCC', fotoNegocioUrl: 'data:image/png;base64,DDDD',
    status: n === 2 ? 'moroso' : 'activo', notas: 'Sintético', createdAt: at(-20), updatedAt: at(-20),
  }));

  const saleApproved = id('sale:1');
  const salePending = id('sale:2');
  const saleLost = id('sale:3');
  const saleRequests: SaleRequest[] = [
    {
      id: id('request:1'), tenantId, clientId: clients[0]!.id, routeId: r(1), collectorId: worker, amount: v(1000), interestRate: 20,
      totalAmount: v(1200), installmentsCount: 24, installmentValue: v(50), frequency: 'diaria', startDate: day(1), paymentDays: [1, 2, 3, 4, 5, 6],
      status: 'disbursed', requestedAt: at(-1), reviewedAt: at(-1, 2), reviewedBy: admin, approvalNotes: 'OK', saleId: saleApproved,
      requestedBy: worker, requestedInterestRate: 20, requestedFrequency: 'diaria', requestedPaymentDays: [1, 2, 3, 4, 5, 6],
      approvedInterestRate: 20, approvedFrequency: 'diaria', approvedPaymentDays: [1, 2, 3, 4, 5, 6], phoneConfirmed: true,
      phoneConfirmationNote: 'Confirmado', activeCreditSaleIds: [saleLost],
      activeCreditSnapshot: [{ saleId: saleLost, saldo: v(600), valorTotal: v(600), status: 'activa' }], authorizationReason: 'active-credit',
    },
    {
      id: id('request:2'), tenantId, clientId: clients[1]!.id, routeId: r(1), collectorId: worker, amount: v(500), interestRate: 20,
      totalAmount: v(600), installmentsCount: 12, installmentValue: v(50), frequency: 'semanal', startDate: day(3), status: 'approved',
      requestedAt: at(0), reviewedAt: at(0, 1), reviewedBy: admin, saleId: salePending, requestedBy: worker, authorizationReason: 'no-direct-capability',
    },
    {
      id: id('request:3'), tenantId, clientId: clients[2]!.id, routeId: r(2), collectorId: worker, amount: v(300), interestRate: 20,
      totalAmount: v(360), installmentsCount: 12, installmentValue: v(30), frequency: 'diaria', startDate: day(2), status: 'rejected',
      requestedAt: at(0), reviewedAt: at(0, 3), reviewedBy: admin, rejectionReason: 'Sin referencias',
    },
    {
      id: id('request:4'), tenantId, clientId: clients[2]!.id, routeId: r(2), collectorId: worker, amount: v(200), interestRate: 20,
      totalAmount: v(240), installmentsCount: 8, installmentValue: v(30), frequency: 'quincenal', startDate: day(4), status: 'pending',
      requestedAt: at(1), authorizationReason: 'over-limit',
    },
  ];
  const sales: Sale[] = [
    {
      id: saleApproved, tenantId, routeId: r(1), clientId: clients[0]!.id, createdByUserId: admin, valorVenta: v(1000), tasaInteres: 20,
      valorInteres: v(200), valorTotal: v(1200), saldo: v(1100), numeroCuotas: 24, valorCuota: v(50), frecuenciaPago: 'diaria',
      paymentDays: [1, 2, 3, 4, 5, 6], fechaInicio: day(1), fechaFinalEstimada: day(29), status: 'activa', disbursementStatus: 'desembolsado',
      disbursedByCollectorId: worker, disbursedByUserId: worker, fechaDesembolso: day(0), disbursedAt: at(0, 4), saleRequestId: id('request:1'),
      createdAt: at(-1, 2), updatedAt: at(2),
    },
    {
      id: salePending, tenantId, routeId: r(1), clientId: clients[1]!.id, createdByUserId: admin, valorVenta: v(500), tasaInteres: 20,
      valorInteres: v(100), valorTotal: v(600), saldo: v(600), numeroCuotas: 12, valorCuota: v(50), frecuenciaPago: 'semanal',
      fechaInicio: day(3), fechaFinalEstimada: day(87), status: 'activa', disbursementStatus: 'pendiente', saleRequestId: id('request:2'),
      createdAt: at(0, 1), updatedAt: at(0, 1),
    },
    {
      id: saleLost, tenantId, routeId: r(2), clientId: clients[2]!.id, createdByUserId: admin, valorVenta: v(500), tasaInteres: 20,
      valorInteres: v(100), valorTotal: v(600), saldo: v(600), numeroCuotas: 12, valorCuota: v(50), frecuenciaPago: 'diaria',
      fechaInicio: day(-15), fechaFinalEstimada: day(-3), fechaFinalizacion: day(-4), status: 'perdida', motivoPerdida: 'Cliente ilocalizable',
      lostAt: at(1), lostByUserId: admin, createdAt: at(-16), updatedAt: at(1),
    },
  ];
  const installments: Required<Installment>[] = [1, 2, 3].map((n) => ({
    id: id(`inst:${n}`), saleId: saleApproved, numero: n, fechaVencimiento: day(n), valor: v(50), pagado: n === 1 ? v(50) : n === 2 ? v(50) : 0,
    saldo: n === 3 ? v(50) : 0, status: n === 3 ? 'vencida' : 'pagada', diasMora: n === 3 ? 1 : 0,
  }));

  // Pagos: original corregido (reversed) → reversión (negativa) + corrección.
  const p1 = id('pay:1'), p2 = id('pay:2'), p3 = id('pay:3'), p4 = id('pay:4');
  const payments: Payment[] = [
    { id: p1, tenantId, saleId: saleApproved, clientId: clients[0]!.id, routeId: r(1), collectorId: worker, createdByUserId: worker,
      valor: v(60), fecha: day(1), tipo: 'efectivo', observacion: 'Abono', lat: -23.55, lng: -46.63, syncStatus: 'synced', createdAt: at(1, 3),
      state: 'reversed', correctedByPaymentId: p3, reversalPaymentId: p2, correctionReason: 'Valor digitado mal', correctedBy: admin, correctedAt: at(1, 5) },
    { id: p2, tenantId, saleId: saleApproved, clientId: clients[0]!.id, routeId: r(1), collectorId: worker, createdByUserId: admin,
      valor: v(-60), fecha: day(1), tipo: 'efectivo', syncStatus: 'synced', createdAt: at(1, 5), state: 'reversal', reversesPaymentId: p1,
      correctionReason: 'Valor digitado mal', correctedBy: admin, correctedAt: at(1, 5) },
    { id: p3, tenantId, saleId: saleApproved, clientId: clients[0]!.id, routeId: r(1), collectorId: worker, createdByUserId: admin,
      valor: v(50), fecha: day(1), tipo: 'efectivo', syncStatus: 'synced', createdAt: at(1, 5), state: 'correction', correctionOfPaymentId: p1 },
    { id: p4, tenantId, saleId: saleApproved, clientId: clients[0]!.id, routeId: r(1), collectorId: worker, valor: v(50), fecha: day(2),
      tipo: 'transferencia', syncStatus: 'pending', createdAt: at(2, 3) },
  ];
  const adjustments: Required<PaymentAdjustmentRequest>[] = [{
    id: id('adj:1'), tenantId, routeId: r(1), paymentId: p1, clientId: clients[0]!.id, saleId: saleApproved,
    requestedBy: m(c.members.find((x) => x.rol === 'secretario')?.key ?? c.members[1]!.key),
    requestedByRole: c.members.find((x) => x.rol === 'secretario') ? 'secretario' : 'admin', requestedAt: at(1, 4), originalValor: v(60),
    originalFecha: day(1), reason: 'Valor digitado mal', newValor: v(50), newFecha: day(1), observacion: 'Soporte adjunto', status: 'approved',
    reviewedBy: admin, reviewedAt: at(1, 5), rejectionReason: '', resultingReversalId: p2, resultingPaymentId: p3,
  }];
  const visits: Required<NoPaymentVisit>[] = [{
    id: id('visit:1'), tenantId, saleId: saleApproved, clientId: clients[0]!.id, routeId: r(1), collectorId: worker, motivo: 'promesa_pago',
    fechaPromesaPago: day(4), observacion: 'Volver el jueves', fecha: day(3), syncStatus: 'synced', createdAt: at(3, 2),
  }];

  // Transferencias: Ruta→Ruta (mismo responsable) y Socio→Ruta (origen '' en Dexie).
  const partner = m(c.members.find((x) => x.rol === 'socio')?.key ?? c.members[0]!.key);
  const tr1 = id('transfer:1'), tr2 = id('transfer:2'), tr2rev = id('transfer:2:rev'), tr3 = id('transfer:3');
  const transfers: Transfer[] = [
    { id: tr1, tenantId, routeOrigenId: r(1), routeDestinoId: r(2), origenType: 'route', destinoType: 'route', valor: v(200),
      descripcion: 'Refuerzo', fecha: day(1), userId: admin, createdAt: at(1, 1), adminId: admin },
    { id: tr2, tenantId, routeOrigenId: '', socioOrigenId: partner, routeDestinoId: r(1), origenType: 'partner', destinoType: 'route',
      valor: v(300), fecha: day(2), userId: admin, createdAt: at(2, 1), reversalId: tr2rev, reversedAt: at(2, 6), reversedByUserId: admin,
      reversalReason: 'Duplicado' },
    { id: tr2rev, tenantId, routeOrigenId: '', socioOrigenId: partner, routeDestinoId: r(1), origenType: 'partner', destinoType: 'route',
      valor: v(-300), fecha: day(2), userId: admin, createdAt: at(2, 6), reversalReason: 'Duplicado', reversesId: tr2 },
    { id: tr3, tenantId, routeOrigenId: r(1), socioDestinoId: partner, origenType: 'route', destinoType: 'partner', valor: v(100),
      fecha: day(3), userId: admin, createdAt: at(3, 1) },
  ];
  const capitalMovements: CapitalMovement[] = [
    { id: id('cap:1'), tenantId, routeId: r(1), tipo: 'ingresoCapital', valor: v(5000), descripcion: 'Colocación', fecha: day(-28),
      userId: admin, createdAt: at(-28), adminId: admin, reversalId: id('cap:1:rev'), reversedAt: at(-27), reversedByUserId: admin, reversalReason: 'Error' },
    { id: id('cap:1:rev'), tenantId, routeId: r(1), tipo: 'ingresoCapital', valor: v(-5000), fecha: day(-27), userId: admin, createdAt: at(-27),
      adminId: admin, reversalReason: 'Error', reversesId: id('cap:1') },
    { id: id('cap:2'), tenantId, routeId: r(1), tipo: 'ingresoCapital', valor: v(5000), fecha: day(-27), userId: admin, createdAt: at(-27, 1), adminId: admin },
    { id: id('cap:3'), tenantId, routeId: r(2), tipo: 'ajusteCapital', valor: v(-100), fecha: day(-20), userId: admin, createdAt: at(-20) },
  ];
  const withdrawals: Withdrawal[] = [
    { id: id('wd:1'), tenantId, routeId: r(1), valor: v(400), descripcion: 'Retiro a bolsa', fecha: day(2), userId: admin, createdAt: at(2, 2),
      adminId: admin, reversalId: id('wd:1:rev'), reversedAt: at(2, 3), reversedByUserId: admin, reversalReason: 'Error de ruta' },
    { id: id('wd:1:rev'), tenantId, routeId: r(1), valor: v(-400), fecha: day(2), userId: admin, createdAt: at(2, 3), adminId: admin,
      reversalReason: 'Error de ruta', reversesId: id('wd:1') },
  ];
  const ledger: CapitalLedgerEntry[] = [
    { id: id('led:dep'), tenantId, tipo: 'COMPANY_DEPOSIT', amount: v(20000), descripcion: 'Aporte inicial', fecha: day(-29), createdAt: at(-29),
      actorUserId: sa, actorRole: 'superadmin', status: 'aplicado', syncStatus: 'synced' },
    { id: id('led:alloc'), tenantId, tipo: 'ADMIN_ALLOCATION', amount: v(10000), toAdminId: admin, fecha: day(-29), createdAt: at(-29, 1),
      actorUserId: sa, actorRole: 'superadmin', status: 'aplicado', syncStatus: 'synced', reversalId: id('led:alloc:rev'), reversedAt: at(-29, 2),
      reversedByUserId: sa, reversalReason: 'Monto equivocado' },
    { id: id('led:alloc:rev'), tenantId, tipo: 'ADMIN_ALLOCATION', amount: v(-10000), toAdminId: admin, fecha: day(-29), createdAt: at(-29, 2),
      actorUserId: sa, actorRole: 'superadmin', status: 'aplicado', syncStatus: 'synced', reversalReason: 'Monto equivocado', reversesId: id('led:alloc') },
    { id: id('led:alloc2'), tenantId, tipo: 'ADMIN_ALLOCATION', amount: v(12000), toAdminId: admin, fecha: day(-29), createdAt: at(-29, 3),
      actorUserId: sa, actorRole: 'superadmin', status: 'aplicado', syncStatus: 'synced' },
    { id: id('led:ret'), tenantId, tipo: 'ADMIN_RETURN', amount: v(1000), fromAdminId: admin, fecha: day(-10), createdAt: at(-10),
      actorUserId: sa, actorRole: 'superadmin', status: 'aplicado', syncStatus: 'synced' },
    { id: id('led:wd'), tenantId, tipo: 'COMPANY_WITHDRAWAL', amount: v(500), fecha: day(-9), createdAt: at(-9), actorUserId: sa,
      actorRole: 'superadmin', status: 'aplicado', syncStatus: 'synced' },
    { id: id('led:rct'), tenantId, tipo: 'ROUTE_CONTROL_TRANSFER', amount: v(0), toAdminId: admin, routeId: r(2), relatedEventId: id('rce:1'),
      descripcion: 'Migración v16', fecha: day(-28), createdAt: at(-28), actorUserId: 'system:migration-v16', actorRole: 'system',
      status: 'aplicado', syncStatus: 'synced' },
  ];
  const controllerEvents: RouteCapitalControllerEvent[] = [
    { id: id('rce:1'), tenantId, routeId: r(2), kind: 'MIGRATION', toAdminId: admin, capitalTransferido: 0, ledgerEntryId: id('led:rct'),
      motivo: 'Migración v16', createdAt: at(-28), actorUserId: 'system:migration-v16', actorRole: 'system', syncStatus: 'synced' },
    { id: id('rce:2'), tenantId, routeId: r(1), kind: 'CHANGE', fromAdminId: admin, toAdminId: admin, capitalTransferido: v(5000),
      baseAlCambio: v(4800), motivo: 'Reasignación de prueba', createdAt: at(-28, 2), actorUserId: sa, actorRole: 'superadmin', syncStatus: 'synced' },
  ];
  const partnerCash: PartnerCashMovement[] = [
    { id: id('pcm:1'), tenantId, partnerId: partner, type: 'salida', category: 'transferencia', amount: v(300), description: 'Aporte a Ruta 1',
      relatedTransferId: tr2, fecha: day(2), createdAt: at(2, 1), createdBy: admin, reversalId: id('pcm:1:rev'), reversedAt: at(2, 6),
      reversedByUserId: admin, reversalReason: 'Duplicado' },
    { id: id('pcm:1:rev'), tenantId, partnerId: partner, type: 'salida', category: 'transferencia', amount: v(-300), relatedTransferId: tr2,
      fecha: day(2), createdAt: at(2, 6), createdBy: admin, reversalReason: 'Duplicado', reversesId: id('pcm:1') },
    { id: id('pcm:2'), tenantId, partnerId: partner, type: 'ingreso', category: 'transferencia', amount: v(100), relatedTransferId: tr3,
      fecha: day(3), createdAt: at(3, 1), createdBy: admin },
  ];
  const second = c.members.filter((x) => x.rol === 'cobrador' || x.rol === 'supervisor')[1];
  const custody: CashCustodyMovement[] = [
    { id: id('cust:1'), tenantId, routeId: r(1), tipo: 'BASE_ASSIGNMENT', amount: v(300), toUserId: worker, origen: 'route-cash', motivo: 'Base del día',
      fecha: day(1), createdAt: at(1, 0), createdByUserId: admin },
    { id: id('cust:2'), tenantId, routeId: r(1), tipo: 'BASE_ASSIGNMENT', amount: v(100), toUserId: worker, origen: 'transfer', relatedTransferId: tr1,
      motivo: 'Entrega en mano', fecha: day(1), createdAt: at(1, 1), createdByUserId: admin, reversalId: id('cust:2:rev'), reversedAt: at(1, 2),
      reversedByUserId: admin, reversalReason: 'Persona equivocada' },
    { id: id('cust:2:rev'), tenantId, routeId: r(1), tipo: 'BASE_ASSIGNMENT', amount: v(-100), toUserId: worker, origen: 'transfer',
      relatedTransferId: tr1, motivo: 'Persona equivocada', fecha: day(1), createdAt: at(1, 2), createdByUserId: admin, reversesId: id('cust:2') },
    { id: id('cust:3'), tenantId, routeId: r(1), tipo: 'BASE_RETURN', amount: v(50), fromUserId: worker, origen: 'route-cash', motivo: 'Devolución',
      fecha: day(2), createdAt: at(2, 8), createdByUserId: admin },
    ...(second ? [{ id: id('cust:4'), tenantId, routeId: r(1), tipo: 'PERSON_TO_PERSON' as const, amount: v(20), fromUserId: worker,
      toUserId: m(second.key), origen: 'route-cash' as const, motivo: 'Traspaso', fecha: day(2), createdAt: at(2, 9), createdByUserId: admin }] : []),
  ];
  const expenses: Expense[] = [
    { id: id('exp:worker'), tenantId, routeId: r(1), scope: 'trabajador', categoryId: categories[0]!.id, valor: v(30), descripcion: 'Gasolina',
      receiptPhotoDataUrl: 'data:image/png;base64,EEEE', fecha: day(1), userId: worker, collectorId: worker, referencia: 'F-1',
      syncStatus: 'synced', createdAt: at(1, 6) },
    { id: id('exp:route'), tenantId, routeId: r(1), scope: 'ruta', categoryId: categories[0]!.id, valor: v(20), fecha: day(1), userId: admin,
      syncStatus: 'synced', createdAt: at(1, 7), reversalId: id('exp:route:rev'), reversedAt: at(1, 8), reversedByUserId: admin, reversalReason: 'Mal clasificado' },
    { id: id('exp:route:rev'), tenantId, routeId: r(1), scope: 'ruta', categoryId: categories[0]!.id, valor: v(-20), fecha: day(1), userId: admin,
      syncStatus: 'synced', createdAt: at(1, 8), reversalReason: 'Mal clasificado', reversesId: id('exp:route') },
    { id: id('exp:pool'), tenantId, scope: 'empresa', categoryId: categories[1]!.id, valor: v(40), fecha: day(1), userId: admin, funding: 'admin',
      fundingAdminId: admin, syncStatus: 'synced', createdAt: at(1, 9) },
    { id: id('exp:pool:refund'), tenantId, scope: 'empresa', categoryId: categories[1]!.id, valor: v(-10), fecha: day(2), userId: admin,
      funding: 'admin', fundingAdminId: admin, refundsExpenseId: id('exp:pool'), syncStatus: 'synced', createdAt: at(2, 9) },
    { id: id('exp:company'), tenantId, scope: 'empresa', categoryId: categories[1]!.id, valor: v(15), fecha: day(2), userId: sa, funding: 'empresa',
      syncStatus: 'synced', createdAt: at(2, 10) },
    { id: id('exp:historic'), tenantId, routeId: r(2), categoryId: categories[1]!.id, valor: v(5), fecha: day(-25), userId: admin,
      syncStatus: 'synced', createdAt: at(-25) },
  ];
  const cs1 = id('cs:1'), cs2 = id('cs:2'), cs3 = id('cs:3');
  const cashSettlements: CashSettlement[] = [
    { id: cs1, tenantId, routeId: r(1), userId: worker, desde: at(0), hasta: at(1, 10), origenDesde: 'inicio-modelo', arrastreAnterior: 0,
      baseRecibida: v(300), baseDevuelta: 0, recaudado: v(50), desembolsado: 0, gastos: v(30), esperado: v(320), entregado: v(300),
      diferencia: v(-20), faltante: v(20), sobrante: 0, motivo: 'Faltante reconocido', status: 'reabierta', version: 1, supersededBy: cs2,
      createdAt: at(1, 10), closedAt: at(1, 10), closedByUserId: admin, reopenedAt: at(1, 11), reopenedByUserId: admin,
      reopenReason: 'Pago omitido', capitalControllerAdminIdAtClose: admin },
    { id: cs2, tenantId, routeId: r(1), userId: worker, desde: at(0), hasta: at(1, 12), origenDesde: 'inicio-modelo', arrastreAnterior: 0,
      recaudado: v(70), desembolsado: 0, gastos: v(30), esperado: v(340), entregado: v(340), diferencia: 0, faltante: 0, sobrante: 0,
      status: 'cerrada', version: 2, createdAt: at(1, 12), closedAt: at(1, 12), closedByUserId: admin, capitalControllerAdminIdAtClose: admin },
    { id: cs3, tenantId, routeId: r(1), userId: worker, desde: at(1, 12), hasta: at(2, 12), origenDesde: 'ultimo-cierre', previousSettlementId: cs2,
      arrastreAnterior: 0, recaudado: v(50), desembolsado: 0, gastos: 0, esperado: v(50), entregado: v(55), diferencia: v(5), faltante: 0,
      sobrante: v(5), motivo: 'Sobrante sin explicar', status: 'cerrada', version: 1, createdAt: at(2, 12), closedAt: at(2, 12), closedByUserId: admin },
  ];
  const w1 = id('week:1'), w2 = id('week:2');
  const weekly: WeeklySettlement[] = [
    { id: w1, tenantId, routeId: r(1), semanaInicio: day(-7), semanaFin: day(-2), saldoAnterior: 0, ingresoCapital: v(5000), cobros: v(100),
      prestamosEntregados: v(1000), gastos: v(30), transferenciasEntradas: 0, transferenciasSalidas: v(200), retiros: 0, saldoFinal: v(3870),
      createdAt: at(-1), status: 'reabierta', createdByUserId: admin, closedAt: at(-1), closedByUserId: admin, reopenedAt: at(-1, 2),
      reopenedByUserId: admin, reopenReason: 'Corrección de pago', version: 1, supersededBy: w2, officeIdAtClose: offices[0]!.id,
      officeNameAtClose: offices[0]!.nombre, officeCodeAtClose: 'OF-1', capitalControllerAdminIdAtClose: admin },
    { id: w2, tenantId, routeId: r(1), semanaInicio: day(-7), semanaFin: day(-2), saldoAnterior: 0, ingresoCapital: v(5000), cobros: v(90),
      prestamosEntregados: v(1000), gastos: v(30), transferenciasEntradas: 0, transferenciasSalidas: v(200), retiros: 0, saldoFinal: v(3860),
      createdAt: at(-1, 3), status: 'cerrada', createdByUserId: admin, closedAt: at(-1, 3), closedByUserId: admin, version: 2,
      officeIdAtClose: offices[0]!.id, officeNameAtClose: offices[0]!.nombre, officeCodeAtClose: 'OF-1' },
    { id: id('week:legacy'), tenantId, routeId: r(2), semanaInicio: day(-14), semanaFin: day(-9), saldoAnterior: 0, ingresoCapital: 0, cobros: 0,
      prestamosEntregados: 0, gastos: 0, transferenciasEntradas: 0, transferenciasSalidas: 0, retiros: 0, saldoFinal: 0, createdAt: at(-8),
      officeNameAtClose: 'Sin Oficina' },
  ];
  const audit: AuditLog[] = [
    { id: id('audit:1'), tenantId, userId: admin, userRole: 'admin', routeId: r(1), action: 'CORRECT_PAYMENT', entityType: 'payment', entityId: p1,
      descripcion: 'Corrección de pago', before: { valor: v(60) }, after: { valor: v(50) }, motivo: 'Valor digitado mal',
      metadata: { reversal: p2 }, createdAt: at(1, 5) },
    { id: id('audit:2'), tenantId, userId: 'system:migration-v16', action: 'ROUTE_CAPITAL_CONTROLLER_CHANGED', entityType: 'route', entityId: r(2),
      descripcion: 'Migración v16', createdAt: at(-28) },
  ];

  return {
    tenants: [tenant], offices, users, routes, expenseCategories: categories, clients, saleRequests, sales, installments, payments,
    paymentAdjustmentRequests: adjustments, noPaymentVisits: visits, expenses, capitalMovements, transfers, withdrawals, capitalLedger: ledger,
    routeCapitalControllerEvents: controllerEvents, partnerCashMovements: partnerCash, cashCustodyMovements: custody,
    cashSettlements, weeklySettlements: weekly, auditLogs: audit,
    companyControl: [{
      companyId: tenantId, nombre: c.name, identificacion: tenant.nit, contacto: 'Responsable Sintético', contactoEmail: tenant.email,
      createdAt: at(-30), firstLoginAt: at(-29), lastLoginAt: at(3), status: 'active', routeCount: 3, billableRouteCount: 2,
      billingMode: 'per_route', billingRate: 49.9, nextBillingDate: '2026-11-01', paymentStatus: 'paid', updatedAt: at(3),
    } satisfies Required<CompanyControlRecord>],
    saasPayments: [{
      id: id('saas:2026-09'), companyId: tenantId, periodo: '2026-09', valor: 99.8, fechaEsperada: '2026-10-01', fechaPagada: '2026-10-02',
      status: 'paid', nota: 'Transferencia', createdAt: at(-1), updatedAt: at(1),
    } satisfies Required<SaaSPayment>],
    controlEvents: [
      { id: id('ev:created'), companyId: tenantId, type: 'COMPANY_CREATED', at: at(-30), detail: 'Alta sintética' } satisfies Required<ControlEvent>,
      { id: id('ev:login'), companyId: tenantId, type: 'FIRST_LOGIN', at: at(-29) },
    ],
  };
}

export function companyId(key: 'c1' | 'c2' | 'c3'): string {
  return uid(`${key}:tenant`);
}
export function membershipId(company: 'c1' | 'c2' | 'c3', key: string): string {
  return uid(`${company}:member:${key}`);
}
export function routeId(company: 'c1' | 'c2' | 'c3', n: 1 | 2 | 3): string {
  return uid(`${company}:route:r${n}`);
}

export const OWNER: PlatformUser = {
  id: uid('platform:owner'), nombre: 'Owner Sintético', email: emailOf('owner'), password: 'NO-SE-IMPORTA', rol: 'owner', status: 'activo',
  firstLoginAt: '2026-09-01T12:00:00.000Z', lastLoginAt: '2026-10-01T12:00:00.000Z', createdAt: '2026-08-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
};

/** Snapshot completo de las tres empresas + Owner, y opciones de importación. */
export function syntheticDataset(): { snapshot: DexieSnapshot; options: ImportOptions } {
  const snapshot: DexieSnapshot = {};
  for (const c of COMPANIES) {
    for (const [table, rows] of Object.entries(companyRecords(c))) {
      (snapshot[table] ??= []).push(...(rows ?? []));
    }
  }
  snapshot['platformUsers'] = [OWNER as unknown as Record<string, unknown>];
  const identityIds: Record<string, string> = {};
  for (const p of PEOPLE) identityIds[emailOf(p)] = identityOf(p);
  const companyIntl: ImportOptions['companyIntl'] = {};
  for (const c of COMPANIES) companyIntl[companyId(c.key)] = { countryCode: c.countryCode, timezone: c.timezone };
  return { snapshot, options: { identityIds, companyIntl } };
}
