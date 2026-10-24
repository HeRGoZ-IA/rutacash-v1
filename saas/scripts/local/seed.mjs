// Siembra SINTÉTICA del entorno local de Base por Ruta, SIEMPRE por la API real (Owner → empresa → estructura →
// dinero). La única escritura directa la hace start-local.mjs: el operador Owner sintético que da de alta las
// empresas. Importes en unidades menores (BRL: centavos). Correos @example.test; ningún nombre real.
import { randomUUID } from 'node:crypto';

export async function seed({ API, CONTROL, issuer, provider, ownerId, log, logOnly }) {
  const warnings = [];
  const facts = {};
  const tokens = new Map();
  const tokenOf = (id) => {
    if (!tokens.has(id)) tokens.set(id, issuer.issue(id, provider.emailOf(id)).token);
    return tokens.get(id);
  };
  async function call(base, method, p, { id, membership, body, op } = {}) {
    const headers = { authorization: `Bearer ${tokenOf(id)}` };
    if (membership) headers['x-adex-membership'] = membership;
    if (op) headers['x-adex-operation-id'] = randomUUID();
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 300) }; }
    logOnly(`[seed] ${method} ${p} → ${r.status}${r.status >= 300 ? ' ' + JSON.stringify(json).slice(0, 300) : ''}`);
    return { status: r.status, body: json };
  }
  const expect = (r, what, statuses = [200, 201]) => {
    if (!statuses.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
    return r.body;
  };
  /** Paso opcional: si la API aún no lo admite (trabajo en curso) queda como aviso y la siembra sigue. */
  const soft = async (label, fn) => {
    try { return await fn(); } catch (e) { warnings.push(`${label}: ${String(e.message ?? e).slice(0, 300)}`); log(`  aviso · ${label}: ${String(e.message ?? e).slice(0, 160)}`); return null; }
  };
  /** Llamador de una persona con una membresía (contexto explícito, como el navegador). */
  const as = (who) => ({
    get: (p) => call(API, 'GET', p, { id: who.id, membership: who.m }),
    post: (p, body = {}) => call(API, 'POST', p, { id: who.id, membership: who.m, body }),
    put: (p, body = {}) => call(API, 'PUT', p, { id: who.id, membership: who.m, body }),
    money: (p, body = {}) => call(API, 'POST', p, { id: who.id, membership: who.m, body, op: true }),
  });
  const ctl = (method, p, body) => call(CONTROL, method, p, { id: ownerId, body });

  const today = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  let docSeq = 0;
  const profiles = [];
  const companies = {};

  // ------------------------------------------------------------ ayudantes de negocio
  async function company(spec) {
    expect(await ctl('POST', '/control/v1/session/start', {}), 'sesión del Owner sintético');
    const b = expect(await ctl('POST', '/control/v1/companies', {
      name: spec.name, email: spec.email, countryCode: 'BR', countryLabel: 'Brasil', currencyCode: 'BRL', timezone: 'America/Sao_Paulo',
      billingMode: 'per_route', billingRate: 10, status: 'active', contactName: spec.contact,
      superAdmin: { email: spec.sa[0], displayName: spec.sa[1] },
    }), `alta de la empresa ${spec.name}`);
    const sa = { email: spec.sa[0], id: provider.ids.get(spec.sa[0]), m: b.superAdmin.membershipId, role: 'superadmin' };
    companies[spec.key] = { id: b.companyId, name: spec.name, model: 'admin_pool' };
    log(`  · ${spec.name}: empresa y SuperAdmin creados`);
    return { id: b.companyId, sa, tz: 'America/Sao_Paulo' };
  }
  async function member(by, email, role, displayName, routeIds = []) {
    const b = expect(await as(by).post('/v1/members', { email, role, displayName, routeIds }), `alta de ${email}`, [201]);
    return { email, id: provider.ids.get(email), m: b.membershipId, role, displayName };
  }
  const office = async (by, name, code) => expect(await as(by).post('/v1/offices', { name, code }), `oficina ${name}`, [201]).id;
  async function route(by, { name, code, city, officeId, admin, collector }) {
    const body = { name, code, city, interestRate: 20, freeRate: false, maxLoanMinor: 500_000, officeId, adminIds: [admin.m] };
    if (collector) body.collectorId = collector.m;
    return expect(await as(by).post('/v1/routes', body), `ruta ${name}`, [201]).id;
  }
  const setRoutes = async (by, who, routeIds) => expect(await as(by).put(`/v1/members/${who.m}/routes`, { routeIds }), `rutas de ${who.email}`);
  async function client(by, routeId, name) {
    docSeq += 1;
    const b = expect(await as(by).post('/v1/clients', {
      routeId, name, documentType: 'CPF', document: `9${String(docSeq).padStart(10, '0')}`, phonePrimary: `1190000${String(docSeq).padStart(4, '0')}`,
      addressPrimary: `Rua Sintética, ${docSeq * 10}`, addressSecondary: 'Sala 1', business: 'Comércio sintético',
    }), `cliente ${name}`, [201]);
    return b.id;
  }
  const cond = (tz, amountMinor, o = {}) => ({ amountMinor, interestRate: 20, installmentsCount: 10, frequency: 'diaria', startDate: today(tz), paymentDays: [0, 1, 2, 3, 4, 5, 6], ...o });
  /** Venta por solicitud: el Cobrador solicita, quien aprueba aprueba y el Cobrador desembolsa (desde su custodia). */
  async function requestSale(tz, cob, approver, routeId, name, amountMinor, { approve = true, disburse = true } = {}) {
    const clientId = await client(approver.role === 'secretario' ? cob.admin : approver, routeId, name);
    const r = expect(await as(cob).post('/v1/credit-requests', { routeId, clientId, ...cond(tz, amountMinor) }), `solicitud ${name}`, [201]);
    if (!approve) return { requestId: r.id };
    expect(await as(approver).post(`/v1/credit-requests/${r.id}/approve`, {}), `aprobación ${name}`);
    if (!disburse) return { requestId: r.id };
    const d = expect(await as(cob).money(`/v1/credit-requests/${r.id}/disburse`, {}), `desembolso ${name}`, [201]);
    return { requestId: r.id, saleId: d.credit.id };
  }
  async function directSale(tz, admin, routeId, name, amountMinor) {
    const clientId = await client(admin, routeId, name);
    return expect(await as(admin).money('/v1/credits/direct', { routeId, clientId, ...cond(tz, amountMinor) }), `venta directa ${name}`, [201]).credit.id;
  }
  async function pay(who, saleId, amountMinor) {
    const b = expect(await as(who).money('/v1/collections', { saleId, amountMinor }), `cobro ${amountMinor}`, [201]);
    return b.paymentId ?? b.payment?.id;
  }
  async function categories(by) {
    const list = expect(await as(by).get('/v1/expense-categories'), 'categorías').categories ?? [];
    const find = (n) => (list.find((c) => c.name === n) ?? list[0])?.id;
    return { fuel: find('Combustible'), food: find('Alimentación'), paper: find('Papelería'), other: find('Otros'), transport: find('Transporte') };
  }
  async function settle(admin, cob, routeId, delta, reason) {
    const p = expect(await as(admin).get(`/v1/settlements/preview?routeId=${routeId}&workerId=${cob.m}`), 'vista previa del cuadre');
    const expected = Number(p.expectedPositionMinor);
    const body = { routeId, workerId: cob.m, deliveredMinor: Math.max(0, expected + delta), expectedSeenMinor: expected, previousSettlementId: p.previousSettlementId ?? null };
    if (reason) body.reason = reason;
    const s = expect(await as(admin).money('/v1/settlements', body), `cuadre de ${cob.email}`, [201]);
    return { expected, delivered: body.deliveredMinor, id: s.settlement?.id, result: s.settlement?.result };
  }

  // ============================================================ Empresa A · Cobros Sintéticos Norte (route_base)
  log('Empresa A «Cobros Sintéticos Norte» (se activará Base por Ruta) ...');
  const A = await company({ key: 'A', name: 'Cobros Sintéticos Norte', email: 'contacto.norte@example.test', contact: 'Contacto Sintético Norte', sa: ['sa.norte@example.test', 'SuperAdmin Norte'] });
  const saA = A.sa;
  const ofCentro = await office(saA, 'Oficina Centro', 'OF-CEN');
  const ofOeste = await office(saA, 'Oficina Oeste', 'OF-OES');
  const ad1 = await member(saA, 'admin1.norte@example.test', 'admin', 'Administrador Norte Uno');
  const ad2 = await member(saA, 'admin2.norte@example.test', 'admin', 'Administrador Norte Dos');
  const supN = await member(saA, 'supervisor.norte@example.test', 'supervisor', 'Supervisor Norte');
  const cob1 = await member(saA, 'cobrador1.norte@example.test', 'cobrador', 'Cobrador Norte Uno');
  const cob2 = await member(saA, 'cobrador2.norte@example.test', 'cobrador', 'Cobrador Norte Dos');
  const secN = await member(saA, 'secretario.norte@example.test', 'secretario', 'Secretario Norte');
  cob1.admin = ad1; cob2.admin = ad2;
  const rC1 = await route(saA, { name: 'Ruta Centro 1', code: 'CEN-1', city: 'São Paulo', officeId: ofCentro, admin: ad1, collector: cob1 });
  const rC2 = await route(saA, { name: 'Ruta Centro 2', code: 'CEN-2', city: 'São Paulo', officeId: ofCentro, admin: ad1 });
  const rO1 = await route(saA, { name: 'Ruta Oeste 1', code: 'OES-1', city: 'Osasco', officeId: ofOeste, admin: ad2, collector: cob2 });
  const rO2 = await route(saA, { name: 'Ruta Oeste 2', code: 'OES-2', city: 'Osasco', officeId: ofOeste, admin: ad2 });
  await setRoutes(saA, supN, [rC1, rO1]);
  await setRoutes(saA, secN, [rC1, rC2, rO1, rO2]);
  facts.A = { routes: { 'Ruta Centro 1': rC1, 'Ruta Centro 2': rC2, 'Ruta Oeste 1': rO1, 'Ruta Oeste 2': rO2 } };
  log('  · estructura: 2 oficinas, 4 rutas, 7 perfiles');

  // --- historia en el modelo actual (bolsas), y cuenta de empresa a cero (RB-D2)
  const $saA = (p, b) => as(saA).money(p, b);
  expect(await $saA('/v1/capital/company/deposits', { amountMinor: 6_000_000, reason: 'Capital inicial sintético de la empresa' }), 'depósito de capital');
  expect(await $saA('/v1/capital/allocations', { adminId: ad1.m, amountMinor: 3_000_000, reason: 'Bolsa del Administrador Norte Uno' }), 'asignación a Admin 1');
  expect(await $saA('/v1/capital/allocations', { adminId: ad2.m, amountMinor: 2_000_000, reason: 'Bolsa del Administrador Norte Dos' }), 'asignación a Admin 2');
  expect(await as(ad1).money('/v1/capital/deliveries', { routeId: rC1, workerId: cob1.m, amountMinor: 100_000, reason: 'Base del Cobrador antes del corte' }), 'entrega previa al corte');
  expect(await $saA('/v1/capital/company/withdrawals', { amountMinor: 1_000_000, reason: 'Disponible de la empresa a cero antes del corte (RB-D2)' }), 'retiro de la empresa a cero');
  // RB-D6 (0036): con saldos en las bolsas, primero «Migrando»; la activación directa solo vale con todo en cero
  expect(await $saA('/v1/capital/model', { target: 'migrating', evidence: 'Congelamos las bolsas para el corte sintético' }), 'paso a Migrando', [200]);
  const pre = expect(await as(saA).get('/v1/capital/model/prerequisites'), 'requisitos de activación');
  if (pre.ok !== true) throw new Error(`requisitos de activación pendientes: ${JSON.stringify((pre.checks ?? []).filter((c) => !c.ok))}`);
  // --- activación por el camino real del SuperAdmin (evidencia + referencia de respaldo sintética)
  const act = expect(await $saA('/v1/capital/model', { target: 'route_base', evidence: 'Corte autorizado por el propietario para el entorno local sintético', backupReference: 'respaldo-local-sintetico-0001' }), 'activación de Base por Ruta');
  if (act.model !== 'route_base') throw new Error(`activación: modelo ${act.model}`);
  companies.A.model = 'route_base';
  log('  · Base por Ruta ACTIVADA (requisitos en verde, evidencia y respaldo sintético)');

  // --- reparto del saldo «sin asignar» (queda una parte para que el propietario lo pruebe) e inyecciones
  const $ad1 = (p, b) => as(ad1).money(p, b), $ad2 = (p, b) => as(ad2).money(p, b);
  const assign = async (who, routeId, amountMinor, name) => expect(await who('/v1/capital/route-base/unassigned-assignments', {
    routeId, amountMinor, reason: `Reparto del saldo anterior a la ${name}`, evidence: `Conteo del sistema anterior: la ${name} usaba esta bolsa` }), `reparto a ${name}`);
  await assign($ad1, rC1, 1_500_000, 'Ruta Centro 1');
  await assign($ad1, rC2, 1_000_000, 'Ruta Centro 2');
  await assign($ad2, rO1, 1_200_000, 'Ruta Oeste 1');
  await assign($ad2, rO2, 500_000, 'Ruta Oeste 2');
  expect(await $ad1('/v1/capital/route-base/injections', { routeId: rC1, amountMinor: 500_000, reason: 'Inyección de Base de la Ruta Centro 1', sourceNote: 'Aporte sintético del socio' }), 'inyección C1');
  expect(await $ad2('/v1/capital/route-base/injections', { routeId: rO1, amountMinor: 300_000, reason: 'Inyección de Base de la Ruta Oeste 1', sourceNote: 'Aporte sintético del socio' }), 'inyección O1');
  expect(await $ad1('/v1/capital/deliveries', { routeId: rC1, workerId: cob1.m, amountMinor: 300_000, reason: 'Base del día para cobrar' }), 'entrega a Cobrador 1');
  expect(await $ad2('/v1/capital/deliveries', { routeId: rO1, workerId: cob2.m, amountMinor: 200_000, reason: 'Base del día para cobrar' }), 'entrega a Cobrador 2');
  log('  · Base repartida e inyectada en las 4 rutas; entregas a los Cobradores');

  // --- clientes, ventas y recaudos
  const tz = A.tz;
  const sA = await requestSale(tz, cob1, secN, rC1, 'Cliente Sintético Centro A', 60_000);
  const sB = await requestSale(tz, cob1, secN, rC1, 'Cliente Sintético Centro B', 80_000);
  const sCorr = await requestSale(tz, cob1, secN, rC1, 'Cliente Sintético Centro C (pagos anulados)', 60_000);
  const sD = await directSale(tz, ad1, rC1, 'Cliente Sintético Centro D', 50_000);
  const sC2 = await directSale(tz, ad1, rC2, 'Cliente Sintético Centro 2 A', 40_000);
  const sO1 = await requestSale(tz, cob2, secN, rO1, 'Cliente Sintético Oeste A', 50_000);
  const sO2 = await directSale(tz, ad2, rO2, 'Cliente Sintético Oeste 2 A', 30_000);
  await pay(cob1, sA.saleId, 6_000); await pay(cob1, sA.saleId, 6_000);
  await pay(cob1, sB.saleId, 8_000);
  await pay(cob1, sD, 5_000);
  const pC1 = await pay(cob1, sCorr.saleId, 6_000);
  const pC2 = await pay(cob1, sCorr.saleId, 13_200);
  await pay(ad1, sC2, 4_000);
  await pay(cob2, sO1.saleId, 5_000);
  const pO1b = await pay(cob2, sO1.saleId, 5_000);
  await pay(ad2, sO2, 3_000);
  facts.A.sales = { conPagosVigentes: 'Cliente Sintético Centro A', conPagosAnulados: 'Cliente Sintético Centro C (pagos anulados)' };
  log('  · 7 ventas desembolsadas (4 por solicitud, 3 directas desde la Base) y 10 cobros');

  // --- pagos anulados (corrección de ventas con pagos y reaplicación, R74)
  await soft('anular dos pagos de «Centro C» (para corregir la venta / reaplicar)', async () => {
    for (const p of [pC1, pC2]) expect(await $ad1(`/v1/collections/${p}/reverse`, { reason: 'Tasa mal registrada: se corrige la venta' }), 'anulación');
  });
  await soft('anular un pago de «Oeste A»', async () => expect(await $ad2(`/v1/collections/${pO1b}/reverse`, { reason: 'Pago registrado dos veces por error' }), 'anulación'));

  // --- gastos de ruta y del trabajador
  const catA = await categories(ad1);
  await soft('gasto de ruta (Centro 1)', async () => expect(await $ad1('/v1/expenses', { scope: 'ruta', routeId: rC1, categoryId: catA.fuel, amountMinor: 5_000, description: 'Combustible de la moto de la ruta' }), 'gasto de ruta'));
  await soft('gasto de ruta (Oeste 2)', async () => expect(await $ad2('/v1/expenses', { scope: 'ruta', routeId: rO2, categoryId: catA.transport, amountMinor: 2_500, description: 'Transporte del Administrador a la ruta' }), 'gasto de ruta'));
  await soft('gasto del trabajador (Cobrador 1)', async () => expect(await as(cob1).money('/v1/expenses', { scope: 'trabajador', routeId: rC1, workerId: cob1.m, categoryId: catA.food, amountMinor: 2_000, description: 'Almuerzo del Cobrador' }), 'gasto del trabajador'));

  // --- gastos generales (D74-O4F): A, C1, C2 y reembolso propio (RB-D8)
  await soft('gasto general A (Admin 1, aportes de Centro 1 y Centro 2)', async () => expect(await $ad1('/v1/expenses', {
    scope: 'administrador', fundingSource: 'routes', categoryId: catA.paper, amountMinor: 10_000, description: 'Papelería del Administrador Norte Uno',
    contributions: [{ routeId: rC1, amountMinor: 7_000 }, { routeId: rC2, amountMinor: 3_000 }] }), 'gasto general A'));
  await soft('gasto general de empresa C1 (Admin 1)', async () => expect(await $ad1('/v1/expenses', {
    scope: 'empresa', fundingSource: 'routes', categoryId: catA.other, amountMinor: 20_000, description: 'Honorarios del contador (parte del Administrador Norte Uno)',
    contributions: [{ routeId: rC1, amountMinor: 20_000 }] }), 'gasto general C1'));
  await soft('gasto general de empresa C1 (Admin 2)', async () => expect(await $ad2('/v1/expenses', {
    scope: 'empresa', fundingSource: 'routes', categoryId: catA.other, amountMinor: 15_000, description: 'Honorarios del contador (parte del Administrador Norte Dos)',
    contributions: [{ routeId: rO1, amountMinor: 15_000 }] }), 'gasto general C1'));
  await soft('gasto general C2 con dinero propio (Admin 1)', async () => expect(await $ad1('/v1/expenses', {
    scope: 'empresa', fundingSource: 'own_money', categoryId: catA.other, amountMinor: 25_000, description: 'Arriendo de la oficina pagado por el Administrador Norte Uno' }), 'gasto general C2'));
  await soft('gasto general C2 con dinero propio (Admin 2)', async () => expect(await $ad2('/v1/expenses', {
    scope: 'administrador', fundingSource: 'own_money', categoryId: catA.transport, amountMinor: 8_000, description: 'Viáticos de supervisión pagados por el Administrador Norte Dos' }), 'gasto general C2'));
  await soft('reembolso parcial al propio Admin 1 desde Centro 2 (RB-D8)', async () => expect(await $ad1('/v1/capital/reimbursements', {
    adminId: ad1.m, contributions: [{ routeId: rC2, amountMinor: 10_000 }], reason: 'Reembolso parcial del arriendo de la oficina' }), 'reembolso'));

  // --- transferencias entre rutas (propia y hacia otro responsable) y retiro de Base
  await soft('transferencia Centro 1 → Centro 2 (mismo responsable)', async () => expect(await $ad1('/v1/capital/route-base/transfers', { fromRouteId: rC1, toRouteId: rC2, amountMinor: 50_000, reason: 'Refuerzo de la Ruta Centro 2' }), 'transferencia'));
  await soft('transferencia Centro 2 → Oeste 1 (otro responsable)', async () => expect(await $ad1('/v1/capital/route-base/transfers', { fromRouteId: rC2, toRouteId: rO1, amountMinor: 30_000, reason: 'Apoyo a la Ruta Oeste 1 del Administrador Norte Dos' }), 'transferencia'));
  await soft('retiro de Base (Oeste 2)', async () => expect(await $ad2('/v1/capital/route-base/withdrawals', { routeId: rO2, amountMinor: 20_000, reason: 'Retiro de Base entregado al socio' }), 'retiro'));

  // --- cuadres: uno con FALTANTE (Centro 1) y otro con SOBRANTE retenido en control (Oeste 1)
  const shortage = await soft('cuadre con faltante (Cobrador 1)', () => settle(ad1, cob1, rC1, -3_000, 'Faltante de R$ 30 en el conteo (dato sintético)'));
  const surplus = await soft('cuadre con sobrante (Cobrador 2)', () => settle(ad2, cob2, rO1, 2_000, 'Sobrante de R$ 20 en el conteo (dato sintético)'));
  facts.A.settlements = { shortage, surplus };

  // --- después del cuadre: nueva entrega, un cobro y una solicitud de devolución PENDIENTE (RB-D4)
  await soft('entrega posterior al cuadre (Cobrador 1)', async () => expect(await $ad1('/v1/capital/deliveries', { routeId: rC1, workerId: cob1.m, amountMinor: 40_000, reason: 'Base para la tarde' }), 'entrega'));
  await soft('cobro posterior al cuadre', async () => pay(cob1, sA.saleId, 6_000));
  await soft('solicitud de devolución al Cobrador 1 (pendiente)', async () => expect(await $ad1('/v1/capital/requests', {
    kind: 'worker_return', holderId: cob1.m, routeId: rC1, concept: 'base', amountMinor: 20_000, note: 'Devolver parte de la Base al cerrar el día' }), 'solicitud de devolución'));
  // --- solicitudes de venta: una pendiente de aprobar y otra aprobada sin desembolsar
  await soft('solicitud de venta pendiente (Oeste 1)', () => requestSale(tz, cob2, secN, rO1, 'Cliente Sintético Oeste B (pendiente de aprobar)', 40_000, { approve: false }));
  await soft('solicitud aprobada sin desembolsar (Centro 1)', () => requestSale(tz, cob1, secN, rC1, 'Cliente Sintético Centro E (aprobada, sin desembolsar)', 30_000, { disburse: false }));
  log('  · gastos, gastos generales, reembolso, transferencias, cuadres y pendientes preparados');

  // ============================================================ Empresa B · Préstamos Sintéticos Sur (admin_pool)
  log('Empresa B «Préstamos Sintéticos Sur» (modelo actual, bolsas) ...');
  const B = await company({ key: 'B', name: 'Préstamos Sintéticos Sur', email: 'contacto.sur@example.test', contact: 'Contacto Sintético Sur', sa: ['sa.sur@example.test', 'SuperAdmin Sur'] });
  const saB = B.sa;
  const ofSur = await office(saB, 'Oficina Sur', 'OF-SUR');
  const adS = await member(saB, 'admin.sur@example.test', 'admin', 'Administrador Sur');
  const cobS = await member(saB, 'cobrador.sur@example.test', 'cobrador', 'Cobrador Sur');
  const secS = await member(saB, 'secretario.sur@example.test', 'secretario', 'Secretario Sur');
  // Varias membresías: el Supervisor de Norte también supervisa en Sur (selector de contexto).
  const supS = await member(saB, 'supervisor.norte@example.test', 'supervisor', 'Supervisor Norte');
  cobS.admin = adS;
  const rS1 = await route(saB, { name: 'Ruta Sur 1', code: 'SUR-1', city: 'Campinas', officeId: ofSur, admin: adS, collector: cobS });
  const rS2 = await route(saB, { name: 'Ruta Sur 2', code: 'SUR-2', city: 'Campinas', officeId: ofSur, admin: adS });
  await setRoutes(saB, secS, [rS1, rS2]);
  await setRoutes(saB, supS, [rS1]);
  const $saB = (p, b) => as(saB).money(p, b), $adS = (p, b) => as(adS).money(p, b);
  expect(await $saB('/v1/capital/company/deposits', { amountMinor: 4_000_000, reason: 'Capital inicial sintético de la empresa' }), 'depósito B');
  expect(await $saB('/v1/capital/allocations', { adminId: adS.m, amountMinor: 3_000_000, reason: 'Bolsa del Administrador Sur' }), 'asignación B');
  expect(await $adS('/v1/capital/deliveries', { routeId: rS1, workerId: cobS.m, amountMinor: 300_000, reason: 'Base del día para cobrar' }), 'entrega B');
  const sS1 = await requestSale(B.tz, cobS, secS, rS1, 'Cliente Sintético Sur A', 60_000);
  const sS2 = await requestSale(B.tz, cobS, secS, rS1, 'Cliente Sintético Sur B', 50_000);
  const sS3 = await directSale(B.tz, adS, rS2, 'Cliente Sintético Sur C', 40_000);
  await pay(cobS, sS1.saleId, 6_000); await pay(cobS, sS2.saleId, 5_000); await pay(adS, sS3, 4_000);
  const catB = await categories(adS);
  await soft('B · gasto de ruta', async () => expect(await $adS('/v1/expenses', { scope: 'ruta', routeId: rS1, categoryId: catB.fuel, amountMinor: 4_000, description: 'Combustible de la moto de la ruta' }), 'gasto'));
  await soft('B · cuadre exacto', () => settle(adS, cobS, rS1, 0, null));
  await soft('B · gasto general C2 con dinero propio', async () => expect(await $adS('/v1/expenses', { scope: 'empresa', fundingSource: 'own_money', categoryId: catB.other, amountMinor: 8_000, description: 'Software de la oficina pagado por el Administrador Sur' }), 'gasto C2'));
  await soft('B · reembolso parcial desde la bolsa (RB-D9)', async () => expect(await $adS('/v1/capital/reimbursements', { adminId: adS.m, amountMinor: 3_000, reason: 'Reembolso parcial desde la bolsa' }), 'reembolso'));
  log('  · estructura, bolsa, 3 ventas, cobros, gasto, cuadre y reembolso (modelo actual)');

  // ============================================================ Empresa C · Empresa Vacía Sintética (sin activar)
  log('Empresa C «Empresa Vacía Sintética» (sin movimientos, sin activar) ...');
  const C = await company({ key: 'C', name: 'Empresa Vacía Sintética', email: 'contacto.vacia@example.test', contact: 'Contacto Sintético Vacía', sa: ['sa.vacia@example.test', 'SuperAdmin Vacía'] });
  const ofV = await office(C.sa, 'Oficina Única', 'OF-UNI');
  const adV = await member(C.sa, 'admin.vacia@example.test', 'admin', 'Administrador Vacía');
  await route(C.sa, { name: 'Ruta Vacía 1', code: 'VAC-1', city: 'Santos', officeId: ofV, admin: adV });
  log('  · 1 oficina, 1 ruta y su Administrador; saldos en cero');

  // ============================================================ Empresa D · Transición Sintética (admin_pool con custodias)
  // Para probar la TRANSICIÓN con custodias distintas de cero (C-13): bolsa del Administrador con saldo, un Cobrador
  // con efectivo en mano, cartera activa y la cuenta de empresa en cero. Queda en el modelo actual (sin activar).
  log('Empresa D «Transición Sintética» (modelo actual con bolsa y custodia; para probar la transición) ...');
  const D = await company({ key: 'D', name: 'Transición Sintética', email: 'contacto.transicion@example.test', contact: 'Contacto Sintético Transición', sa: ['sa.transicion@example.test', 'SuperAdmin Transición'] });
  const ofT = await office(D.sa, 'Oficina Transición', 'OF-TRA');
  const adT = await member(D.sa, 'admin.transicion@example.test', 'admin', 'Administrador Transición');
  const cobT = await member(D.sa, 'cobrador.transicion@example.test', 'cobrador', 'Cobrador Transición');
  cobT.admin = adT;
  const rT1 = await route(D.sa, { name: 'Ruta Transición 1', code: 'TRA-1', city: 'Sorocaba', officeId: ofT, admin: adT, collector: cobT });
  const rT2 = await route(D.sa, { name: 'Ruta Transición 2', code: 'TRA-2', city: 'Sorocaba', officeId: ofT, admin: adT });
  const $saD = (p, b) => as(D.sa).money(p, b), $adT = (p, b) => as(adT).money(p, b);
  expect(await $saD('/v1/capital/company/deposits', { amountMinor: 3_000_000, reason: 'Capital inicial sintético de la empresa' }), 'depósito D');
  expect(await $saD('/v1/capital/allocations', { adminId: adT.m, amountMinor: 2_500_000, reason: 'Bolsa del Administrador Transición' }), 'asignación D');
  expect(await $saD('/v1/capital/company/withdrawals', { amountMinor: 500_000, reason: 'Disponible de la empresa a cero (RB-D2)' }), 'retiro D a cero');
  expect(await $adT('/v1/capital/deliveries', { routeId: rT1, workerId: cobT.m, amountMinor: 400_000, reason: 'Base del día para cobrar' }), 'entrega D');
  const sT1 = await requestSale(D.tz, cobT, adT, rT1, 'Cliente Sintético Transición A', 100_000);
  await pay(cobT, sT1.saleId, 10_000);
  const sT2 = await directSale(D.tz, adT, rT2, 'Cliente Sintético Transición B', 50_000);
  await pay(adT, sT2, 5_000);
  facts.D = { routes: { 'Ruta Transición 1': rT1, 'Ruta Transición 2': rT2 } };
  log('  · bolsa con saldo, Cobrador con efectivo en mano (custodia > 0), 2 ventas y cobros; empresa en cero; sin activar');

  // ============================================================ perfiles
  const N = 'Cobros Sintéticos Norte', SU = 'Préstamos Sintéticos Sur', V = 'Empresa Vacía Sintética', TR = 'Transición Sintética';
  profiles.push(
    { company: N, role: 'SuperAdmin', email: saA.email, tryFirst: 'Panel de rutas (solo lectura) y Modelo de capital' },
    { company: N, role: 'Administrador (Centro 1 y 2)', email: ad1.email, tryFirst: 'Caja principal y Transferencias' },
    { company: N, role: 'Administrador (Oeste 1 y 2)', email: ad2.email, tryFirst: 'Aviso de transferencia recibida; cuadre con sobrante' },
    { company: 'Norte y Sur (2 empresas)', role: 'Supervisor (2 empresas)', email: supN.email, tryFirst: 'Selector de empresa/perfil al entrar' },
    { company: N, role: 'Cobrador (Centro 1)', email: cob1.email, tryFirst: 'Devolución pendiente; venta aprobada por desembolsar' },
    { company: N, role: 'Cobrador (Oeste 1)', email: cob2.email, tryFirst: 'Cobrar y solicitar venta' },
    { company: N, role: 'Secretario (4 rutas)', email: secN.email, tryFirst: 'Transferencias = solo historial; aprobar solicitud' },
    { company: SU, role: 'SuperAdmin', email: saB.email, tryFirst: 'Capital como siempre (modelo actual)' },
    { company: SU, role: 'Administrador (Sur 1 y 2)', email: adS.email, tryFirst: 'Bolsa y Transferencias de siempre' },
    { company: SU, role: 'Cobrador (Sur 1)', email: cobS.email, tryFirst: 'Cobrar como siempre' },
    { company: SU, role: 'Secretario', email: secS.email, tryFirst: 'Transferencias del modelo actual' },
    { company: V, role: 'SuperAdmin', email: C.sa.email, tryFirst: 'Modelo de capital → activar Base por Ruta' },
    { company: V, role: 'Administrador (Vacía 1)', email: adV.email, tryFirst: 'Tras activar: inyectar Base' },
    { company: TR, role: 'SuperAdmin', email: D.sa.email, tryFirst: 'Transición: Migrando → activar (con custodias)' },
    { company: TR, role: 'Administrador (Transición 1 y 2)', email: adT.email, tryFirst: 'Tras activar: repartir el saldo sin asignar' },
    { company: TR, role: 'Cobrador (Transición 1)', email: cobT.email, tryFirst: 'Su efectivo en mano no cambia con la transición' },
  );
  return { profiles, companies, warnings, facts };
}
