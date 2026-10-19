// Escenario de la EMPRESA DEMO (ADEX Online v1). Datos 100 % FICTICIOS.
//
// El escenario no escribe nada por su cuenta: es una lista de llamadas a la API de
// empresa (mismos endpoints, mismas reglas, mismo motor financiero que cualquier
// empresa) ejecutadas por puestos SINTÉTICOS. Los puestos asignables (los que
// ocuparán las personas invitadas) nunca actúan en el escenario: solo se les asigna
// estructura (rutas) y capital en su bolsa, como haría la Dirección de una empresa.
//
//   Ruta Norte  → Admin Norte (responsable), Cobrador Norte, Supervisor Norte: todo sintético,
//                 con créditos de ejemplo en cada estado (desembolsado, aprobado, pendiente).
//   Ruta Centro → puestos asignables: Admin Centro (responsable), Cobrador Centro,
//                 Supervisor Centro. Capital en la bolsa del Admin Centro y una
//                 solicitud pendiente (creada por la Dirección) para probar autorizaciones.
//   SuperAdmin invitado (asignable): ve toda la empresa (aporte y asignación de capital).
//
// Cambiar este archivo = nueva versión de escenario (SCENARIO_VERSION).

export const SCENARIO_VERSION = 'demo-v1';

export interface SeatSpec {
  seat: string;
  role: 'superadmin' | 'admin' | 'supervisor' | 'cobrador' | 'socio' | 'secretario';
  displayName: string;
  assignable: boolean;
}

export const SEATS: readonly SeatSpec[] = [
  { seat: 'direccion', role: 'superadmin', displayName: 'Dirección Demo (sintética)', assignable: false },
  { seat: 'admin-norte', role: 'admin', displayName: 'Admin Norte (sintético)', assignable: false },
  { seat: 'cobrador-norte', role: 'cobrador', displayName: 'Cobrador Norte (sintético)', assignable: false },
  { seat: 'supervisor-norte', role: 'supervisor', displayName: 'Supervisor Norte (sintético)', assignable: false },
  { seat: 'superadmin-invitado', role: 'superadmin', displayName: 'SuperAdmin (puesto libre)', assignable: true },
  { seat: 'admin-centro', role: 'admin', displayName: 'Admin Centro (puesto libre)', assignable: true },
  { seat: 'cobrador-centro', role: 'cobrador', displayName: 'Cobrador Centro (puesto libre)', assignable: true },
  { seat: 'supervisor-centro', role: 'supervisor', displayName: 'Supervisor Centro (puesto libre)', assignable: true },
];

export const ASSIGNABLE_SEATS = SEATS.filter((s) => s.assignable).map((s) => s.seat);

export interface DemoCompanySpec {
  name: string;
  countryCode: string;
  countryLabel: string;
  currencyCode: string;
  timezone: string;
}

export const DEFAULT_COMPANY: DemoCompanySpec = {
  name: 'Empresa Demo ADEX', countryCode: 'BR', countryLabel: 'Brasil', currencyCode: 'BRL', timezone: 'America/Sao_Paulo',
};

/** Paso del escenario: un puesto SINTÉTICO llama a un endpoint de la API de empresa. */
export interface ScenarioCall {
  seat: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  path: string;
  body?: Record<string, unknown>;
  /** Comando de dinero o alta: se envía con un `X-Adex-Operation-Id` nuevo. */
  operation?: boolean;
  /** Escenario histórico (demo-v2-6m): día contable simulado de la llamada (0018). */
  day?: string;
}

export type CallRunner = (call: ScenarioCall) => Promise<Record<string, unknown>>;

// Clientes ficticios: nombres inventados, documentos con prefijo 999 (no asignados),
// teléfonos y direcciones de ejemplo.
const CLIENTS: readonly { route: 'norte' | 'centro'; name: string; doc: string; business: string }[] = [
  { route: 'norte', name: 'Ana Ficticia Souza', doc: '999.000.001-01', business: 'Quiosco de frutas (ficticio)' },
  { route: 'norte', name: 'Bruno Ejemplo Lima', doc: '999.000.002-02', business: 'Taller de bicicletas (ficticio)' },
  { route: 'norte', name: 'Carla Prueba Rocha', doc: '999.000.003-03', business: 'Panadería (ficticia)' },
  { route: 'norte', name: 'Davi Simulado Alves', doc: '999.000.004-04', business: 'Venta de ropa (ficticia)' },
  { route: 'centro', name: 'Elena Demo Costa', doc: '999.000.005-05', business: 'Tienda de barrio (ficticia)' },
  { route: 'centro', name: 'Fábio Inventado Reis', doc: '999.000.006-06', business: 'Lavandería (ficticia)' },
  { route: 'centro', name: 'Gisele Muestra Pinto', doc: '999.000.007-07', business: 'Salón de belleza (ficticio)' },
  { route: 'centro', name: 'Hugo Ilustrativo Dias', doc: '999.000.008-08', business: 'Carrito de comidas (ficticio)' },
];

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v) throw new Error(`scenario: missing ${what}`);
  return v;
};

/**
 * Ejecuta el escenario. `today` es la fecha local de la empresa (las solicitudes no
 * pueden empezar antes de hoy). Devuelve un resumen sin cifras sensibles.
 */
export async function runScenario(call: CallRunner, seatMembership: (seat: string) => string, today: string) {
  const m = seatMembership;
  // 1. Estructura: dos rutas con su responsable de capital, Cobrador y Supervisor.
  const norte = await call({ seat: 'direccion', method: 'POST', path: '/v1/routes', operation: true, body: {
    name: 'Ruta Norte (demo)', city: 'Ciudad Ficticia', interestRate: 20, freeRate: false, maxLoanMinor: 300_000,
    adminIds: [m('admin-norte')], collectorId: m('cobrador-norte') } });
  const centro = await call({ seat: 'direccion', method: 'POST', path: '/v1/routes', operation: true, body: {
    name: 'Ruta Centro (demo)', city: 'Ciudad Ficticia', interestRate: 20, freeRate: false, maxLoanMinor: 300_000,
    adminIds: [m('admin-centro')], collectorId: m('cobrador-centro') } });
  const routes = { norte: str(norte['id'], 'route norte'), centro: str(centro['id'], 'route centro') };
  await call({ seat: 'direccion', method: 'PUT', path: `/v1/members/${m('supervisor-norte')}/routes`, body: { routeIds: [routes.norte] } });
  await call({ seat: 'direccion', method: 'PUT', path: `/v1/members/${m('supervisor-centro')}/routes`, body: { routeIds: [routes.centro] } });

  // 2. Clientes ficticios.
  const clients: Record<string, string[]> = { norte: [], centro: [] };
  for (const [i, c] of CLIENTS.entries()) {
    const created = await call({ seat: 'direccion', method: 'POST', path: '/v1/clients', operation: true, body: {
      routeId: routes[c.route], name: c.name, documentType: 'CPF', document: c.doc, phonePrimary: `(00) 90000-00${String(i + 1).padStart(2, '0')}`,
      addressPrimary: `Rua Imaginária ${100 + i}, Bairro Exemplo`, addressSecondary: `Rua Imaginária ${100 + i}, Bairro Exemplo (cobro)`,
      business: c.business, notes: 'Cliente ficticio de la Empresa Demo' } });
    clients[c.route]!.push(str(created['id'], 'client'));
  }

  // 3. Capital: aporte inicial de la empresa y asignación a las bolsas de los Administradores.
  await call({ seat: 'direccion', method: 'POST', path: '/v1/capital/company/deposits', operation: true,
    body: { amountMinor: 5_000_000, reason: 'Aporte inicial ficticio de la Empresa Demo' } });
  await call({ seat: 'direccion', method: 'POST', path: '/v1/capital/allocations', operation: true,
    body: { adminId: m('admin-norte'), amountMinor: 2_000_000, reason: 'Asignación inicial (demo)' } });
  await call({ seat: 'direccion', method: 'POST', path: '/v1/capital/allocations', operation: true,
    body: { adminId: m('admin-centro'), amountMinor: 2_000_000, reason: 'Asignación inicial (demo)' } });

  // 4. Ruta Norte: entrega anticipada al Cobrador y créditos de ejemplo en cada estado.
  await call({ seat: 'admin-norte', method: 'POST', path: '/v1/capital/deliveries', operation: true,
    body: { routeId: routes.norte, workerId: m('cobrador-norte'), amountMinor: 500_000, reason: 'Capital del día (demo)' } });
  const request = (clientId: string, amountMinor: number, installmentsCount: number) => ({
    routeId: routes.norte, clientId, amountMinor, interestRate: 20, installmentsCount, frequency: 'diaria', startDate: today, paymentDays: [1, 2, 3, 4, 5, 6] });
  const r1 = await call({ seat: 'cobrador-norte', method: 'POST', path: '/v1/credit-requests', operation: true, body: request(clients['norte']![0]!, 100_000, 20) });
  const r2 = await call({ seat: 'cobrador-norte', method: 'POST', path: '/v1/credit-requests', operation: true, body: request(clients['norte']![1]!, 80_000, 20) });
  await call({ seat: 'cobrador-norte', method: 'POST', path: '/v1/credit-requests', operation: true, body: request(clients['norte']![2]!, 60_000, 15) });
  await call({ seat: 'supervisor-norte', method: 'POST', path: `/v1/credit-requests/${str(r1['id'], 'r1')}/approve`, body: { notes: 'Aprobada (demo)' } });
  await call({ seat: 'admin-norte', method: 'POST', path: `/v1/credit-requests/${str(r2['id'], 'r2')}/approve`, body: { notes: 'Aprobada (demo)' } });
  await call({ seat: 'cobrador-norte', method: 'POST', path: `/v1/credit-requests/${str(r1['id'], 'r1')}/disburse`, operation: true, body: {} });

  // 5. Ruta Centro: una solicitud pendiente para la bandeja de autorizaciones.
  await call({ seat: 'direccion', method: 'POST', path: '/v1/credit-requests', operation: true, body: {
    routeId: routes.centro, clientId: clients['centro']![0]!, amountMinor: 50_000, interestRate: 20, installmentsCount: 10, frequency: 'diaria',
    startDate: today, paymentDays: [1, 2, 3, 4, 5, 6] } });

  return { routes: 2, clients: CLIENTS.length, creditRequests: 4, disbursedCredits: 1 };
}
