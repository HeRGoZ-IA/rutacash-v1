// Escenario HISTÓRICO de la EMPRESA DEMO (demo-v2-6m). Datos 100 % FICTICIOS.
//
// Seis meses de operación de una empresa de cobro diario, registrados día a día con la
// API de empresa NORMAL (mismos comandos, validaciones, cierres, idempotencia y auditoría
// que cualquier empresa). Cada llamada lleva su DÍA contable (`day`): PostgreSQL solo lo
// acepta mientras la Demo está en aprovisionamiento (0018). Nada se escribe por fuera.
//
// A diferencia de demo-v1, los puestos ASIGNABLES también actúan: así cada persona
// invitada (SuperAdmin, Administrador, Cobrador, Supervisor, Socio, Secretario) encuentra
// SU historia (sus cobros, su efectivo, sus cuadres, sus autorizaciones). La auditoría
// conserva la identidad sintética que actuó antes de la asignación.
//
// Determinista: misma semilla → misma historia relativa a la fecha de hoy.
//
//   Oficina Principal → Ruta Centro (Adm. responsable: puesto «admin-centro»; Cobrador y
//                       Supervisor: puestos asignables) y Ruta Norte (responsable Jorge
//                       hasta el cambio de responsable a Marta a mitad del periodo;
//                       «admin-centro» asignado como Administrador secundario).
//   Oficina Sur       → Ruta Sur (Marta).
//   Sin Oficina       → Ruta Expansión (abre en el último mes, sin Cobrador: el
//                       Administrador vende y cobra con su bolsa).

import type { DemoCompanySpec, ScenarioCall, SeatSpec } from './scenario.ts';

export const HISTORY_VERSION = 'demo-v2-6m';

export const HISTORY_COMPANY: DemoCompanySpec = {
  name: 'Empresa Demo ADEX', countryCode: 'CO', countryLabel: 'Colombia', currencyCode: 'COP', timezone: 'America/Bogota',
};

export const HISTORY_SEATS: readonly SeatSpec[] = [
  { seat: 'direccion', role: 'superadmin', displayName: 'Dirección Demo (sintética)', assignable: false },
  { seat: 'superadmin-invitado', role: 'superadmin', displayName: 'SuperAdmin (puesto libre)', assignable: true },
  { seat: 'admin-centro', role: 'admin', displayName: 'Administrador Centro (puesto libre)', assignable: true },
  { seat: 'cobrador-centro', role: 'cobrador', displayName: 'Cobrador Centro (puesto libre)', assignable: true },
  { seat: 'supervisor-centro', role: 'supervisor', displayName: 'Supervisor Centro (puesto libre)', assignable: true },
  { seat: 'socio-invitado', role: 'socio', displayName: 'Socio (puesto libre)', assignable: true },
  { seat: 'secretario-invitado', role: 'secretario', displayName: 'Secretario (puesto libre)', assignable: true },
  { seat: 'admin-anterior', role: 'admin', displayName: 'Jorge Restrepo (Adm. anterior, sintético)', assignable: false },
  { seat: 'admin-norte', role: 'admin', displayName: 'Marta Gil (Adm. Norte y Sur, sintética)', assignable: false },
  { seat: 'cobrador-norte', role: 'cobrador', displayName: 'Wilmer Ortiz (Cobrador Norte, sintético)', assignable: false },
  { seat: 'cobrador-sur', role: 'cobrador', displayName: 'Yamile Duarte (Cobradora Sur, sintética)', assignable: false },
  { seat: 'supervisor-norte', role: 'supervisor', displayName: 'Hernán Pardo (Supervisor Norte, sintético)', assignable: false },
  { seat: 'socio-fundador', role: 'socio', displayName: 'Alberto Fundador (Socio, sintético)', assignable: false },
];

export interface HistoryOptions {
  /** Hoy (fecha contable real de la empresa). */
  today: string;
  /** Días de historia (180 ≈ seis meses). Las pruebas usan menos. */
  days: number;
  /** Clientes por ruta (las pruebas usan menos). */
  scale?: number;
  onProgress?: (info: { day: string; index: number; total: number; calls: number }) => void;
}

export type StrictRunner = (call: ScenarioCall) => Promise<Record<string, unknown>>;

// ------------------------------------------------------------------ utilidades
const DAY = 86_400_000;
const parse = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => fmt(parse(d) + n * DAY);
const weekday = (d: string) => new Date(parse(d)).getUTCDay(); // 0 = domingo
const nextBusiness = (d: string) => { let x = addDays(d, 1); while (weekday(x) === 0) x = addDays(x, 1); return x; };
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v) throw new Error(`scenario v2: missing ${what}`);
  return v;
};
/** PRNG determinista (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const COP = (pesos: number) => Math.round(pesos) * 100; // unidades menores (centavos)
const round1000 = (pesos: number) => Math.round(pesos / 1000) * 1000;

// ------------------------------------------------------------------ datos ficticios
const FIRST = ['Luz Marina', 'José Ancízar', 'Blanca Nubia', 'Édgar', 'Rosalba', 'Fabio', 'Gloria Inés', 'Wilson', 'Martha Lucía', 'Orlando',
  'Diana Patricia', 'Héctor', 'Yolanda', 'Jairo', 'Sandra Milena', 'Rubén Darío', 'Claudia', 'Nelson', 'Adriana', 'Gustavo', 'Liliana', 'Arley',
  'Doris', 'Fredy', 'Luz Dary', 'Jhon Jairo', 'Nancy', 'Over', 'Mireya', 'Alirio'];
const LAST = ['Ospina', 'Cardona', 'Giraldo', 'Ríos', 'Zuluaga', 'Arango', 'Henao', 'Quintero', 'Valencia', 'Muñoz', 'Correa', 'Betancur',
  'Londoño', 'Castaño', 'Agudelo', 'Montoya', 'Salazar', 'Patiño', 'Cano', 'Marín'];
const BUSINESS = ['Tienda de barrio', 'Venta de arepas', 'Peluquería', 'Taller de motos', 'Miscelánea', 'Venta de frutas', 'Modistería',
  'Cafetería', 'Venta de minutos', 'Panadería', 'Carnicería', 'Droguería', 'Papelería', 'Venta de empanadas', 'Zapatería'];

type RouteKey = 'centro' | 'norte' | 'sur' | 'expansion';
type Profile = 'puntual' | 'irregular' | 'moroso';

interface ClientState {
  route: RouteKey; idx: number; id: string; name: string; profile: Profile; weekly: boolean; weekDay: number;
  credit: CreditState | null; renewOn: string | null; credits: number; rejectedOnce: boolean;
}
interface CreditState {
  id: string; installmentMinor: number; balanceMinor: number; due: string[]; paidMinor: number;
}

export async function runHistoryScenario(call: StrictRunner, m: (seat: string) => string, opts: HistoryOptions) {
  const rand = rng(20261018);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  let calls = 0;
  // Si una ruta falla, las demás se detienen en su siguiente paso (la inicialización se aborta entera).
  let failed: unknown = null;
  const c = async (x: ScenarioCall) => {
    if (failed) throw failed;
    calls++;
    try {
      return await call(x);
    } catch (e) {
      failed = failed ?? e;
      throw e;
    }
  };

  // Primer lunes de la historia; el último día es HOY.
  let day0 = addDays(opts.today, -opts.days);
  while (weekday(day0) !== 1) day0 = addDays(day0, -1);
  const total = Math.round((parse(opts.today) - parse(day0)) / DAY) + 1;
  const at = (i: number) => addDays(day0, i);
  const scale = opts.scale ?? 1;
  const lateStart = Math.max(Math.floor(total * 0.8), 7);

  // ============================================================ 1. Estructura
  const d0 = day0;
  const offPrincipal = await c({ seat: 'direccion', method: 'POST', path: '/v1/offices', operation: true, day: d0, body: { name: 'Oficina Principal', code: 'OP' } });
  const offSur = await c({ seat: 'direccion', method: 'POST', path: '/v1/offices', operation: true, day: d0, body: { name: 'Oficina Sur', code: 'OS' } });
  const mkRoute = async (name: string, code: string, officeId: string | null, adminIds: string[], collectorId: string | null) => str((await c({
    seat: 'direccion', method: 'POST', path: '/v1/routes', operation: true, day: d0, body: {
      name, code, city: 'Medellín (ficticia)', interestRate: 20, freeRate: false, maxLoanMinor: COP(2_000_000),
      ...(officeId ? { officeId } : {}), adminIds, ...(collectorId ? { collectorId } : {}) } }))['id'], name);
  const routes: Record<RouteKey, string> = {
    centro: await mkRoute('Ruta Centro', 'RC', str(offPrincipal['id'], 'office'), [m('admin-centro')], m('cobrador-centro')),
    norte: await mkRoute('Ruta Norte', 'RN', str(offPrincipal['id'], 'office'), [m('admin-anterior'), m('admin-norte'), m('admin-centro')], m('cobrador-norte')),
    sur: await mkRoute('Ruta Sur', 'RS', str(offSur['id'], 'office'), [m('admin-norte')], m('cobrador-sur')),
    expansion: '',
  };
  const setRoutes = (seat: string, ids: string[]) => c({ seat: 'direccion', method: 'PUT', path: `/v1/members/${m(seat)}/routes`, day: d0, body: { routeIds: ids } });
  await setRoutes('supervisor-centro', [routes.centro]);
  await setRoutes('supervisor-norte', [routes.norte]);
  await setRoutes('socio-invitado', [routes.centro, routes.norte]);
  await setRoutes('socio-fundador', [routes.centro, routes.norte, routes.sur]);
  await setRoutes('secretario-invitado', [routes.centro, routes.norte, routes.sur]);
  // El responsable de capital inicial de cada ruta es su primer Administrador.
  const controller: Record<RouteKey, string> = { centro: 'admin-centro', norte: 'admin-anterior', sur: 'admin-norte', expansion: 'admin-centro' };
  const collector: Record<RouteKey, string | null> = { centro: 'cobrador-centro', norte: 'cobrador-norte', sur: 'cobrador-sur', expansion: null };
  const approver: Record<RouteKey, string> = { centro: 'supervisor-centro', norte: 'supervisor-norte', sur: 'admin-norte', expansion: 'admin-centro' };
  const settler: Record<RouteKey, string> = { centro: 'supervisor-centro', norte: 'supervisor-norte', sur: 'admin-norte', expansion: 'admin-centro' };

  const categories = ((await c({ seat: 'direccion', method: 'GET', path: '/v1/expense-categories', day: d0 }))['categories'] as { id: string; name: string }[]);
  const cat = (name: string) => categories.find((x) => x.name === name)?.id ?? str(categories[0]?.id, 'category');

  // Clientes ficticios (cédulas 99xxxxxx, no asignadas).
  const clients: ClientState[] = [];
  const perRoute: Record<RouteKey, number> = { centro: Math.max(2, Math.round(22 * scale)), norte: Math.max(2, Math.round(20 * scale)), sur: Math.max(2, Math.round(16 * scale)), expansion: 0 };
  let n = 0;
  const addClient = async (route: RouteKey, day: string) => {
    n++;
    const name = `${FIRST[(n * 7) % FIRST.length]} ${LAST[(n * 3) % LAST.length]} ${LAST[(n * 11 + 5) % LAST.length]}`;
    const r = rand();
    const profile: Profile = r < 0.55 ? 'puntual' : r < 0.86 ? 'irregular' : 'moroso';
    const weekly = rand() < 0.35;
    const created = await c({ seat: collector[route] ?? controller[route], method: 'POST', path: '/v1/clients', operation: true, day, body: {
      routeId: routes[route], name, documentType: 'CC', document: String(99_000_000 + n * 37), phonePrimary: `300 ${String(1_000_000 + n * 131).slice(0, 7)}`,
      addressPrimary: `Calle ${10 + (n % 80)} # ${n % 50}-${10 + (n % 60)}, Barrio Ficticio`, addressSecondary: `Carrera ${20 + (n % 40)} # ${n % 30}-${n % 90}, local ${n % 9 + 1}`,
      business: `${pick(BUSINESS)} (ficticio)`, notes: 'Cliente ficticio de la Empresa Demo' } });
    const st: ClientState = { route, idx: n, id: str(created['id'], 'client'), name, profile, weekly, weekDay: 1 + (n % 6), credit: null, renewOn: null, credits: 0, rejectedOnce: false };
    clients.push(st);
    return st;
  };
  for (const route of ['centro', 'norte', 'sur'] as const) for (let i = 0; i < perRoute[route]; i++) await addClient(route, d0);
  // Dos clientes registrados que nunca llegan a tener crédito; uno queda inactivo.
  const idle = await addClient('centro', d0);
  clients.splice(clients.indexOf(idle), 1);
  await c({ seat: 'direccion', method: 'POST', path: `/v1/clients/${idle.id}/status`, day: d0, body: { status: 'inactivo' } });

  // ============================================================ 2. Capital inicial
  await c({ seat: 'direccion', method: 'POST', path: '/v1/capital/company/deposits', operation: true, day: d0, body: { amountMinor: COP(60_000_000 * Math.max(scale, 0.3)), reason: 'Capital inicial de los socios (ficticio)' } });
  const alloc = (seat: string, pesos: number, day: string, reason: string) =>
    c({ seat: 'direccion', method: 'POST', path: '/v1/capital/allocations', operation: true, day, body: { adminId: m(seat), amountMinor: COP(pesos * Math.max(scale, 0.3)), reason } });
  await alloc('admin-centro', 18_000_000, d0, 'Bolsa inicial de Ruta Centro');
  await alloc('admin-anterior', 15_000_000, d0, 'Bolsa inicial de Ruta Norte');
  await alloc('admin-norte', 13_000_000, d0, 'Bolsa inicial de Ruta Sur');

  // ============================================================ 3. Día a día
  const summary = { days: total, credits: 0, collections: 0, visits: 0, requests: 0, rejected: 0, settlements: 0, closures: 0, expenses: 0 };
  const lastPayment: Record<RouteKey, { id: string; day: string }[]> = { centro: [], norte: [], sur: [], expansion: [] };
  const amountFor = (cl: ClientState) => round1000((cl.credits === 0 ? 300_000 + rand() * 500_000 : 400_000 + rand() * 700_000) * (cl.profile === 'puntual' ? 1.1 : 1));
  const conditions = (cl: ClientState, amount: number, day: string) => ({
    routeId: routes[cl.route], clientId: cl.id, amountMinor: COP(amount), interestRate: 20,
    installmentsCount: cl.weekly ? 8 : 24, frequency: cl.weekly ? 'semanal' : 'diaria', startDate: nextBusiness(day),
    paymentDays: cl.weekly ? [cl.weekDay] : [1, 2, 3, 4, 5, 6] });
  const track = (cl: ClientState, res: Record<string, unknown>) => {
    const credit = res['credit'] as Record<string, unknown>;
    const inst = (res['installments'] as { dueDate: string; amountMinor: number }[]) ?? [];
    cl.credit = { id: str(credit['id'], 'credit'), installmentMinor: inst[0]?.amountMinor ?? 0, balanceMinor: Number(credit['balanceMinor']), due: inst.map((x) => x.dueDate), paidMinor: 0 };
    cl.credits++;
    summary.credits++;
  };

  /**
   * Antes de entregar capital o vender con la bolsa: si la bolsa del Administrador no
   * alcanza, la Dirección le asigna más; si la empresa tampoco tiene, los socios aportan.
   */
  async function ensurePool(seat: string, needMinor: number, day: string) {
    const s = await c({ seat: 'direccion', method: 'GET', path: '/v1/capital/summary', day });
    const pool = ((s['admins'] as { adminId: string; availableMinor: number }[]) ?? []).find((a) => a.adminId === m(seat))?.availableMinor ?? 0;
    if (pool >= needMinor + COP(200_000)) return;
    const allocation = Math.max(COP(5_000_000), Math.ceil((needMinor - pool + COP(2_000_000)) / COP(1_000_000)) * COP(1_000_000));
    const company = Number((s['company'] as { availableMinor?: number } | undefined)?.availableMinor ?? 0);
    if (company < allocation) {
      await c({ seat: 'direccion', method: 'POST', path: '/v1/capital/company/deposits', operation: true, day, body: {
        amountMinor: Math.max(COP(20_000_000), allocation * 2), reason: 'Aporte adicional de capital de los socios' } });
    }
    await alloc(seat, allocation / 100 / Math.max(scale, 0.3), day, 'Refuerzo de capital para la operación');
  }

  // Ruta de un día: mañana (entregas y desembolsos) → cobros y visitas → gastos → sábado: cuadre.
  async function routeDay(route: RouteKey, day: string, index: number) {
    const wd = weekday(day);
    const col = collector[route];
    const ctl = controller[route];
    const mine = clients.filter((x) => x.route === route);
    // ---- Lunes: cierre de la semana anterior (lunes a sábado) por el responsable.
    if (wd === 1 && index >= 7) {
      const weekStart = addDays(day, -7);
      const weekEnd = addDays(day, -2);
      await c({ seat: ctl, method: 'POST', path: '/v1/periods/close', operation: true, day, body: { routeId: routes[route], weekStart, weekEnd, note: 'Cierre semanal' } });
      summary.closures++;
    }
    // ---- Solicitudes y desembolsos del día.
    const toOpen = mine.filter((cl) => !cl.credit && (cl.renewOn === null ? cl.credits === 0 && index <= 12 && (cl.idx + index) % 6 === 0 : cl.renewOn <= day));
    const plans: { cl: ClientState; amount: number; direct: boolean }[] = [];
    for (const cl of toOpen) {
      if (index > total - 3 && cl.credits > 0) continue;
      plans.push({ cl, amount: amountFor(cl), direct: cl.credits === 0 || !col });
    }
    const viaCollector = plans.filter((p) => !p.direct);
    const need = viaCollector.reduce((s, p) => s + COP(p.amount), 0);
    const directNeed = plans.filter((p) => p.direct).reduce((s, p) => s + COP(p.amount), 0);
    if (need + directNeed > 0) await ensurePool(ctl, need + directNeed, day);
    if (col && need > 0) {
      // Lo que el trabajador ya tiene disponible (sin el faltante arrastrado, que no financia
      // desembolsos) se usa primero; el responsable entrega solo lo que falta.
      const missing = need - (await available(route, col));
      if (missing > 0) {
        await c({ seat: ctl, method: 'POST', path: '/v1/capital/deliveries', operation: true, day, body: { routeId: routes[route], workerId: m(col), amountMinor: missing, reason: 'Capital para desembolsos del día' } });
      }
    }
    for (const p of plans) {
      const cl = p.cl;
      if (p.direct) {
        track(cl, await c({ seat: ctl, method: 'POST', path: '/v1/credits/direct', operation: true, day, body: conditions(cl, p.amount, day) }));
        cl.renewOn = null;
        continue;
      }
      summary.requests++;
      const req = await c({ seat: col!, method: 'POST', path: '/v1/credit-requests', operation: true, day, body: conditions(cl, p.amount, day) });
      const reqId = str(req['id'], 'request');
      // Rechazo ocasional (el cliente vuelve a intentarlo una semana después).
      if (!cl.rejectedOnce && cl.profile === 'irregular' && rand() < 0.15) {
        cl.rejectedOnce = true;
        await c({ seat: approver[route], method: 'POST', path: `/v1/credit-requests/${reqId}/reject`, day, body: { reason: pick(['Capacidad de pago insuficiente', 'Referencias sin verificar', 'Atrasos en el crédito anterior']) } });
        summary.rejected++;
        cl.renewOn = addDays(day, 7);
        // El capital entregado para ese desembolso vuelve a la bolsa al cuadrar.
        continue;
      }
      const tenPercent = cl.profile === 'puntual' && cl.credits >= 2 && rand() < 0.3;
      await c({ seat: approver[route], method: 'POST', path: `/v1/credit-requests/${reqId}/approve`, day, body: {
        notes: tenPercent ? 'Cliente puntual: tasa preferencial' : 'Aprobada tras verificar referencias', ...(tenPercent ? { interestRate: 10 } : {}),
        // La confirmación telefónica es del Supervisor o del Secretario (`authorization.phoneConfirm`).
        ...(approver[route].startsWith('supervisor') ? { phoneConfirmed: true, phoneConfirmationNote: 'Confirmado por teléfono' } : {}) } });
      track(cl, await c({ seat: col!, method: 'POST', path: `/v1/credit-requests/${reqId}/disburse`, operation: true, day, body: {} }));
      cl.renewOn = null;
    }
    // ---- Cobros y visitas.
    const payer = col ?? ctl;
    for (const cl of mine) {
      const cr = cl.credit;
      if (!cr || day < (cr.due[0] ?? '9999')) continue;
      const dueTodayN = cr.due.filter((d) => d === day).length;
      const expected = cr.due.filter((d) => d <= day).length * cr.installmentMinor;
      const overdue = Math.max(0, expected - cr.paidMinor);
      // Sin cuota hoy, solo se cobra si hay atraso: el cliente que falló un día se pone al día
      // (el puntual casi siempre; el irregular a veces). Sin esto, un crédito vencido después de su
      // última fecha nunca terminaría ni se renovaría.
      const lastDue = cr.due[cr.due.length - 1] ?? day;
      if (dueTodayN === 0 && !(overdue > 0 && (day > lastDue || (cl.profile === 'puntual' ? rand() < 0.8 : cl.profile === 'irregular' && rand() < 0.25)))) continue;
      const stops = cl.profile === 'moroso' && index > total - 40;
      const p = cl.profile === 'puntual' ? 0.95 : cl.profile === 'irregular' ? 0.72 : 0.6;
      if (stops || rand() > p) {
        if (col && rand() < 0.5) {
          const reason = stops ? pick(['sin_dinero', 'negocio_cerrado', 'no_estaba'] as const) : pick(['no_estaba', 'sin_dinero', 'promesa_pago'] as const);
          await c({ seat: col, method: 'POST', path: '/v1/no-payment-visits', operation: true, day, body: {
            saleId: cr.id, reason, ...(reason === 'promesa_pago' ? { promisedPaymentDate: nextBusiness(day) } : {}), note: reason === 'promesa_pago' ? 'Promete pagar mañana' : '' } });
          summary.visits++;
        }
        continue;
      }
      let k = 1;
      if (cl.profile === 'irregular') k = rand() < 0.25 ? 0.5 : overdue >= 2 * cr.installmentMinor && rand() < 0.4 ? 2 : 1;
      // El puntual paga lo vencido completo (cuota de hoy incluida); el resto, su patrón.
      const owed = cl.profile === 'puntual' ? Math.max(overdue, cr.installmentMinor * dueTodayN) : cr.installmentMinor * k;
      const amount = Math.min(cr.balanceMinor, Math.max(100, Math.round(owed / 100) * 100));
      const r = await c({ seat: payer, method: 'POST', path: '/v1/collections', operation: true, day, body: { saleId: cr.id, amountMinor: amount } });
      summary.collections++;
      cr.paidMinor += Number(r['appliedMinor'] ?? amount);
      cr.balanceMinor = Number(r['newBalanceMinor'] ?? cr.balanceMinor - amount);
      lastPayment[route].push({ id: str(r['paymentId'], 'payment'), day });
      if (cr.balanceMinor <= 0) {
        cl.credit = null;
        let gap = 1 + Math.floor(rand() * 4);
        let d = day;
        while (gap-- > 0) d = nextBusiness(d);
        cl.renewOn = d;
      }
    }
    // ---- Gastos del trabajador (martes y viernes) y de la ruta (primer lunes del mes).
    if (col && (wd === 2 || wd === 5)) {
      await c({ seat: col, method: 'POST', path: '/v1/expenses', operation: true, day, body: {
        scope: 'trabajador', routeId: routes[route], workerId: m(col), categoryId: cat(wd === 2 ? 'Transporte' : 'Alimentación'),
        amountMinor: COP(wd === 2 ? 12_000 : 15_000), description: wd === 2 ? 'Pasajes del recorrido' : 'Almuerzo en ruta' } });
      summary.expenses++;
    }
    if (wd === 1 && Number(day.slice(8, 10)) <= 7) {
      await c({ seat: ctl, method: 'POST', path: '/v1/expenses', operation: true, day, body: {
        scope: 'ruta', routeId: routes[route], categoryId: cat('Papelería'), amountMinor: COP(35_000), description: 'Talonarios y papelería del mes' } });
      summary.expenses++;
    }
    // ---- Sábado: cuadre del trabajador (exacto casi siempre; faltante o sobrante a veces).
    if (col && wd === 6) {
      const prev = await c({ seat: settler[route], method: 'GET', path: `/v1/settlements/preview?routeId=${routes[route]}&workerId=${m(col)}`, day });
      const expectedMinor = Number(prev['expectedCashMinor'] ?? 0);
      const positionMinor = Number(prev['expectedPositionMinor'] ?? expectedMinor);
      const entries = Number(((prev['cycle'] ?? {}) as Record<string, unknown>)['entries'] ?? 0);
      const roll = rand();
      if (expectedMinor <= 0 && entries === 0) return;
      const delivered = roll < 0.08 && expectedMinor > COP(30_000) ? expectedMinor - COP(20_000) : roll > 0.96 && expectedMinor > 0 ? expectedMinor + COP(5_000) : expectedMinor;
      await c({ seat: settler[route], method: 'POST', path: '/v1/settlements', operation: true, day, body: {
        routeId: routes[route], workerId: m(col), deliveredMinor: delivered, expectedSeenMinor: positionMinor,
        ...(prev['previousSettlementId'] ? { previousSettlementId: prev['previousSettlementId'] } : {}),
        ...(delivered !== expectedMinor ? { reason: delivered < expectedMinor ? 'Faltaron billetes en la entrega' : 'Sobrante por vueltos de clientes' } : {}) } });
      summary.settlements++;
    }
  }

  // Eventos de la empresa y excepciones, por índice de día (relativos a la longitud).
  const at01 = Math.floor(total * 0.1);
  const at30 = Math.floor(total * 0.3);
  const at45 = Math.floor(total * 0.45);
  const at50 = Math.floor(total * 0.5);
  const at60 = Math.floor(total * 0.6);
  const at75 = Math.floor(total * 0.75);
  const at90 = Math.floor(total * 0.9);
  let norteChange = Math.floor(total * 0.5);
  while (weekday(at(norteChange)) !== 2) norteChange++; // un martes, con la semana anterior ya cerrada
  const firstMonday = (i: number) => weekday(at(i)) === 1 && Number(at(i).slice(8, 10)) <= 7;

  for (let i = 0; i < total; i++) {
    const day = at(i);
    const wd = weekday(day);
    opts.onProgress?.({ day, index: i, total, calls });
    if (wd === 0) continue; // domingo: no se trabaja
    // ---- Empresa (antes que las rutas).
    if (firstMonday(i) && i > 0) {
      await c({ seat: 'direccion', method: 'POST', path: '/v1/expenses', operation: true, day, body: {
        scope: 'empresa', categoryId: cat('Otros'), amountMinor: COP(900_000), description: 'Arriendo de la oficina', fundingSource: 'empresa' } });
      summary.expenses++;
    }
    if (i === at01 + 2) await alloc('admin-centro', 4_000_000, day, 'Refuerzo de capital Ruta Centro');
    if (i === at30) {
      await c({ seat: 'direccion', method: 'POST', path: '/v1/capital/company/deposits', operation: true, day, body: { amountMinor: COP(10_000_000 * Math.max(scale, 0.3)), reason: 'Nuevo aporte de capital de los socios' } });
      await c({ seat: 'admin-centro', method: 'POST', path: '/v1/capital/partner-contributions', operation: true, day, body: {
        partnerId: m('socio-invitado'), routeId: routes.centro, amountMinor: COP(3_000_000 * Math.max(scale, 0.3)), reason: 'Aporte del socio para Ruta Centro' } });
    }
    if (i === at45) {
      const dup = await c({ seat: 'admin-centro', method: 'POST', path: '/v1/capital/partner-contributions', operation: true, day, body: {
        partnerId: m('socio-fundador'), routeId: routes.centro, amountMinor: COP(1_500_000), reason: 'Aporte registrado dos veces' } });
      await c({ seat: 'admin-centro', method: 'POST', path: `/v1/capital/operations/${str((dup['operation'] as Record<string, unknown>)?.['id'], 'op')}/reverse`, operation: true, day, body: { reason: 'Registro duplicado del aporte' } });
    }
    if (i === at60) await c({ seat: 'direccion', method: 'POST', path: '/v1/capital/company/withdrawals', operation: true, day, body: { amountMinor: COP(2_000_000), reason: 'Distribución parcial de utilidades' } });
    // ---- Cambio de responsable de Ruta Norte (Jorge → Marta) y baja de Jorge.
    if (i === norteChange) {
      await c({ seat: 'direccion', method: 'PUT', path: `/v1/routes/${routes.norte}/capital-controller`, day, body: { membershipId: m('admin-norte'), reason: 'Jorge deja la empresa; Marta asume Ruta Norte' } });
      controller.norte = 'admin-norte';
      const s = await c({ seat: 'direccion', method: 'GET', path: '/v1/capital/summary', day });
      const jorge = ((s['admins'] as { adminId: string; availableMinor: number }[]) ?? []).find((a) => a.adminId === m('admin-anterior'));
      if (jorge && jorge.availableMinor > 0) {
        await c({ seat: 'direccion', method: 'POST', path: '/v1/capital/admin-returns', operation: true, day, body: { adminId: m('admin-anterior'), amountMinor: jorge.availableMinor, reason: 'Devolución de la bolsa al retirarse' } });
      }
      await c({ seat: 'direccion', method: 'PUT', path: `/v1/members/${m('admin-anterior')}/routes`, day, body: { routeIds: [] } });
      await c({ seat: 'direccion', method: 'POST', path: `/v1/members/${m('admin-anterior')}/deactivate`, day, body: {} });
    }
    // ---- Ruta Expansión (último tramo, sin Oficina ni Cobrador).
    if (i === lateStart && !routes.expansion) {
      routes.expansion = await mkRouteOn('Ruta Expansión', 'RE', day);
      for (let k = 0; k < Math.max(2, Math.round(4 * scale)); k++) {
        const cl = await addClient('expansion', day);
        cl.profile = 'puntual';
      }
    }

    // ---- Rutas en paralelo (cada una con sus propias cuentas; la bolsa compartida se
    // serializa en PostgreSQL).
    await Promise.all((Object.keys(routes) as RouteKey[]).filter((r) => routes[r]).map((r) => routeDay(r, day, i)));

    // ---- Excepciones por ruta (después de la operación del día).
    if (i === at30 + 1 && wd !== 6) {
      // Entrega duplicada anulada el mismo día.
      await ensurePool('admin-centro', COP(200_000), day);
      const del = await c({ seat: 'admin-centro', method: 'POST', path: '/v1/capital/deliveries', operation: true, day, body: { routeId: routes.centro, workerId: m('cobrador-centro'), amountMinor: COP(200_000), reason: 'Capital adicional' } });
      await c({ seat: 'admin-centro', method: 'POST', path: `/v1/capital/operations/${str((del['operation'] as Record<string, unknown>)?.['id'], 'op')}/reverse`, operation: true, day, body: { reason: 'Entrega registrada por error' } });
    }
    if (i === at45 + 1 && wd !== 6) {
      // Abono a cliente equivocado: lo anula el Administrador mientras el Cobrador aún tiene el dinero.
      const p = lastPayment.centro.filter((x) => x.day === day).pop();
      if (p) await c({ seat: 'admin-centro', method: 'POST', path: `/v1/collections/${p.id}/reverse`, operation: true, day, body: { reason: 'Abono registrado a otro cliente' } });
    }
    if (i === at50 && wd !== 6) {
      // Corrección de un abono por la Secretaria (semana abierta): valor mal digitado.
      const p = lastPayment.norte.filter((x) => x.day === day).pop();
      if (p) await c({ seat: 'secretario-invitado', method: 'POST', path: `/v1/collections/${p.id}/correct`, operation: true, day, body: { newAmountMinor: 0 + (await paymentAmount(p.id)) - COP(1_000), reason: 'Valor mal digitado por el cobrador' } });
    }
    if (i === at60 + 1 || i === at75 || i === total - 2) {
      // Solicitudes de ajuste de pagos de semanas CERRADAS: una aprobada, una rechazada, una pendiente.
      const route: RouteKey = i === at75 ? 'norte' : 'centro';
      const old = lastPayment[route].find((x) => x.day <= addDays(day, -14));
      if (old) {
        const a = await c({ seat: 'secretario-invitado', method: 'POST', path: '/v1/payment-adjustments', operation: true, day, body: {
          paymentId: old.id, newAmountMinor: Math.max(100, (await paymentAmount(old.id)) - COP(2_000)), reason: 'El cliente presentó el recibo con otro valor' } });
        lastPayment[route] = lastPayment[route].filter((x) => x.id !== old.id);
        if (i === at60 + 1) {
          await ensurePool('admin-centro', await paymentAmount(old.id), day);
          await c({ seat: 'admin-centro', method: 'POST', path: '/v1/capital/deliveries', operation: true, day, body: {
            routeId: routes.centro, workerId: m('cobrador-centro'), amountMinor: await paymentAmount(old.id), reason: 'Base para cubrir la corrección aprobada' } });
          await c({ seat: 'admin-centro', method: 'POST', path: `/v1/payment-adjustments/${str(a['id'], 'adj')}/approve`, operation: true, day, body: {} });
        }
        if (i === at75) await c({ seat: 'admin-norte', method: 'POST', path: `/v1/payment-adjustments/${str(a['id'], 'adj')}/reject`, day, body: { reason: 'El recibo no corresponde a este cliente' } });
      }
    }
    if (i === at90 && wd !== 6 && wd !== 1 && (await available('norte', 'cobrador-norte')) >= COP(50_000)) {
      // Traspasos: del Cobrador Norte al Supervisor (efectivo para un desembolso en campo) y
      // reasignación entre rutas de la misma responsable (Norte → Sur), una de ellas anulada.
      await c({ seat: 'admin-norte', method: 'POST', path: '/v1/capital/worker-transfers', operation: true, day, body: {
        routeId: routes.norte, fromWorkerId: m('cobrador-norte'), toWorkerId: m('supervisor-norte'), amountMinor: COP(20_000), reason: 'Efectivo para un desembolso del Supervisor' } });
      await c({ seat: 'admin-norte', method: 'POST', path: '/v1/capital/worker-transfers', operation: true, day, body: {
        routeId: routes.norte, fromWorkerId: m('supervisor-norte'), toWorkerId: m('cobrador-norte'), amountMinor: COP(20_000), reason: 'Devuelve el efectivo no usado' } });
      // Reasignación entre dos rutas de la misma responsable (Norte → Sur).
      await c({ seat: 'admin-norte', method: 'POST', path: '/v1/capital/route-reassignments', operation: true, day, body: {
        fromRouteId: routes.norte, toRouteId: routes.sur, fromWorkerId: m('cobrador-norte'), toWorkerId: m('cobrador-sur'), amountMinor: COP(30_000),
        reason: 'Refuerzo de efectivo para Ruta Sur' } });
    }
  }

  // ============================================================ 4. Estado de HOY
  // Solicitudes pendientes (bandeja de autorizaciones) y una aprobada sin desembolsar.
  const today = opts.today;
  const lastDay = weekday(today) === 0 ? addDays(today, -1) : today;
  // Tres prospectos nuevos de Ruta Centro: sus solicitudes quedan en la bandeja (una aprobada sin desembolsar).
  const prospects: ClientState[] = [];
  for (let k = 0; k < 3; k++) {
    const cl = await addClient('centro', lastDay);
    cl.profile = 'puntual';
    prospects.push(cl);
  }
  for (const [k, cl] of prospects.entries()) {
    const req = await c({ seat: 'cobrador-centro', method: 'POST', path: '/v1/credit-requests', operation: true, day: lastDay, body: conditions(cl, amountFor(cl), lastDay) });
    summary.requests++;
    if (k === 0) await c({ seat: 'supervisor-centro', method: 'POST', path: `/v1/credit-requests/${str(req['id'], 'req')}/approve`, day: lastDay, body: { notes: 'Aprobada; desembolso pendiente', phoneConfirmed: true } });
  }
  return { ...summary, calls, firstDay: day0, lastDay: today };

  async function mkRouteOn(name: string, code: string, day: string) {
    return str((await c({ seat: 'direccion', method: 'POST', path: '/v1/routes', operation: true, day, body: {
      name, code, city: 'Bello (ficticia)', interestRate: 20, freeRate: false, maxLoanMinor: COP(2_000_000), adminIds: [m('admin-centro')] } }))['id'], name);
  }
  async function available(route: RouteKey, seat: string): Promise<number> {
    const w = await c({ seat: 'direccion', method: 'GET', path: `/v1/settlements/workers?routeId=${routes[route]}` });
    return Number(((w['workers'] as { workerId: string; availableMinor: number }[]) ?? []).find((x) => x.workerId === m(seat))?.availableMinor ?? 0);
  }
  async function paymentAmount(id: string): Promise<number> {
    const p = await c({ seat: 'direccion', method: 'GET', path: `/v1/collections/${id}` });
    return Number((p['payment'] as Record<string, unknown>)?.['amountMinor'] ?? 0);
  }
}
