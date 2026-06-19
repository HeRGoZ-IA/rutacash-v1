// ============================================================
// SEED DATA - Datos demo para RutaCash V1
// ============================================================
import { v4 as uuidv4 } from 'uuid'
import { format, subDays, subWeeks } from 'date-fns'
import { db } from '@/lib/db'
import { generateInstallments, calculateTotalWithInterest, estimateFinalDate } from '@/services/installmentEngine'
import type {
  Tenant, Office, Route, User, Client, Sale, Payment,
  ExpenseCategory, Expense, CapitalMovement, Transfer, Withdrawal,
} from '@/models/types'

const d = (date: Date) => format(date, 'yyyy-MM-dd')
const now = new Date()

// IDs fijos para referencias cruzadas
const TENANT_ID = 'tenant-demo-001'
const OFFICE1_ID = 'office-001'
const OFFICE2_ID = 'office-002'
const ROUTE1_ID = 'route-001'
const ROUTE2_ID = 'route-002'
const ROUTE3_ID = 'route-003'
const ROUTE4_ID = 'route-004'
const USER_SUPER_ID = 'user-super-001'
const USER_ADMIN_ID = 'user-admin-001'
const USER_SUPER2_ID = 'user-supervisor-001'
const USER_COB1_ID = 'user-cobrador-001'
const USER_COB2_ID = 'user-cobrador-002'
const USER_COB3_ID = 'user-cobrador-003'
const USER_COB4_ID = 'user-cobrador-004'

let _seeding = false

export async function seedDatabase() {
  // Check si ya hay datos
  const existing = await db.tenants.count()
  if (existing > 0) return
  if (_seeding) return
  _seeding = true

  // ---- TENANT ----
  const tenant: Tenant = {
    id: TENANT_ID,
    nombre: 'Credirutas Norte',
    nombreLegal: 'Credirutas del Norte S.A.S.',
    email: 'admin@credirutasnorte.com',
    telefono: '3001234567',
    plan: 'profesional',
    status: 'activa',
    fechaVencimiento: d(new Date(now.getFullYear(), 11, 31)),
    pais: 'Colombia',
    moneda: 'COP',
    createdAt: new Date(2025, 0, 1).toISOString(),
    updatedAt: now.toISOString(),
  }

  // ---- OFFICES ----
  const offices: Office[] = [
    {
      id: OFFICE1_ID,
      tenantId: TENANT_ID,
      nombre: 'Oficina Central Barranquilla',
      pais: 'Colombia',
      ciudad: 'Barranquilla',
      responsable: 'Carlos Mendoza',
      telefono: '3001112233',
      email: 'baq@credirutas.com',
      status: 'activa',
      createdAt: new Date(2025, 0, 1).toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: OFFICE2_ID,
      tenantId: TENANT_ID,
      nombre: 'Oficina Soledad',
      pais: 'Colombia',
      ciudad: 'Soledad',
      responsable: 'María Torres',
      telefono: '3009998877',
      email: 'sol@credirutas.com',
      status: 'activa',
      createdAt: new Date(2025, 1, 1).toISOString(),
      updatedAt: now.toISOString(),
    },
  ]

  // ---- ROUTES ----
  const routes: Route[] = [
    {
      id: ROUTE1_ID,
      tenantId: TENANT_ID,
      officeId: OFFICE1_ID,
      nombre: 'Ruta Norte',
      codigo: 'RN-001',
      ciudad: 'Barranquilla',
      tasaInteres: 20,
      tasaLibre: false,
      montoMaximoPrestamo: 500000,
      capitalInicial: 3000000,
      capitalActual: 2800000,
      cobradorId: USER_COB1_ID,
      status: 'activa',
      createdAt: new Date(2025, 0, 5).toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: ROUTE2_ID,
      tenantId: TENANT_ID,
      officeId: OFFICE1_ID,
      nombre: 'Ruta Sur',
      codigo: 'RS-001',
      ciudad: 'Barranquilla',
      tasaInteres: 20,
      tasaLibre: false,
      montoMaximoPrestamo: 600000,
      capitalInicial: 4000000,
      capitalActual: 3700000,
      cobradorId: USER_COB2_ID,
      status: 'activa',
      createdAt: new Date(2025, 0, 5).toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: ROUTE3_ID,
      tenantId: TENANT_ID,
      officeId: OFFICE2_ID,
      nombre: 'Ruta Soledad Centro',
      codigo: 'SC-001',
      ciudad: 'Soledad',
      tasaInteres: 20,
      tasaLibre: true,
      montoMaximoPrestamo: 400000,
      capitalInicial: 2500000,
      capitalActual: 2200000,
      cobradorId: USER_COB3_ID,
      status: 'activa',
      createdAt: new Date(2025, 1, 5).toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: ROUTE4_ID,
      tenantId: TENANT_ID,
      officeId: OFFICE2_ID,
      nombre: 'Ruta Soledad Industrial',
      codigo: 'SI-001',
      ciudad: 'Soledad',
      tasaInteres: 20,
      tasaLibre: false,
      montoMaximoPrestamo: 800000,
      capitalInicial: 5000000,
      capitalActual: 4800000,
      cobradorId: USER_COB4_ID,
      status: 'activa',
      createdAt: new Date(2025, 1, 5).toISOString(),
      updatedAt: now.toISOString(),
    },
  ]

  // ---- USERS ----
  const users: User[] = [
    {
      id: USER_SUPER_ID,
      tenantId: 'platform',
      email: 'superadmin@demo.com',
      password: '123456',
      nombre: 'Super Admin',
      rol: 'superadmin',
      status: 'activo',
      createdAt: new Date(2024, 11, 1).toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: USER_ADMIN_ID,
      tenantId: TENANT_ID,
      officeId: OFFICE1_ID,
      email: 'admin@demo.com',
      password: '123456',
      nombre: 'Admin Credirutas',
      rol: 'admin',
      telefono: '3001234567',
      status: 'activo',
      createdAt: new Date(2025, 0, 1).toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: USER_SUPER2_ID,
      tenantId: TENANT_ID,
      officeId: OFFICE1_ID,
      email: 'supervisor@demo.com',
      password: '123456',
      nombre: 'Laura Supervisora',
      rol: 'supervisor',
      telefono: '3015556677',
      status: 'activo',
      createdAt: new Date(2025, 0, 10).toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: USER_COB1_ID,
      tenantId: TENANT_ID,
      officeId: OFFICE1_ID,
      routeId: ROUTE1_ID,
      email: 'cobrador@demo.com',
      password: '123456',
      nombre: 'Juan Cobrador',
      rol: 'cobrador',
      telefono: '3024445566',
      status: 'activo',
      createdAt: new Date(2025, 0, 5).toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: USER_COB2_ID,
      tenantId: TENANT_ID,
      officeId: OFFICE1_ID,
      routeId: ROUTE2_ID,
      email: 'cobrador2@demo.com',
      password: '123456',
      nombre: 'Pedro Cobrador',
      rol: 'cobrador',
      telefono: '3033334455',
      status: 'activo',
      createdAt: new Date(2025, 0, 5).toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: USER_COB3_ID,
      tenantId: TENANT_ID,
      officeId: OFFICE2_ID,
      routeId: ROUTE3_ID,
      email: 'cobrador3@demo.com',
      password: '123456',
      nombre: 'Ana Cobradora',
      rol: 'cobrador',
      telefono: '3042223344',
      status: 'activo',
      createdAt: new Date(2025, 1, 5).toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: USER_COB4_ID,
      tenantId: TENANT_ID,
      officeId: OFFICE2_ID,
      routeId: ROUTE4_ID,
      email: 'cobrador4@demo.com',
      password: '123456',
      nombre: 'Luis Cobrador',
      rol: 'cobrador',
      telefono: '3051112233',
      status: 'activo',
      createdAt: new Date(2025, 1, 5).toISOString(),
      updatedAt: now.toISOString(),
    },
  ]

  // ---- CLIENTS (20 clientes) ----
  const clientsData = [
    { nombre: 'María García', doc: '1234567890', tel: '3101234567', dir: 'Cll 45 #23-12 Barranquilla', negocio: 'Tienda de ropa', routeId: ROUTE1_ID, officeId: OFFICE1_ID },
    { nombre: 'Carlos López', doc: '0987654321', tel: '3209876543', dir: 'Cra 54 #78-90 Barranquilla', negocio: 'Frutería El Mango', routeId: ROUTE1_ID, officeId: OFFICE1_ID },
    { nombre: 'Ana Martínez', doc: '1122334455', tel: '3311234567', dir: 'Cll 72 #45-23 Barranquilla', negocio: 'Peluquería Bella', routeId: ROUTE1_ID, officeId: OFFICE1_ID },
    { nombre: 'Luis Herrera', doc: '5544332211', tel: '3405554433', dir: 'Cra 38 #12-56 Barranquilla', negocio: 'Taller de motos', routeId: ROUTE1_ID, officeId: OFFICE1_ID },
    { nombre: 'Sandra Díaz', doc: '6677889900', tel: '3506677889', dir: 'Cll 30 #89-12 Barranquilla', negocio: 'Restaurante La Costa', routeId: ROUTE1_ID, officeId: OFFICE1_ID },
    { nombre: 'Jorge Peña', doc: '2233445566', tel: '3612233445', dir: 'Cra 46 #34-78 Barranquilla', negocio: 'Ferretería Don Jorge', routeId: ROUTE2_ID, officeId: OFFICE1_ID },
    { nombre: 'Rosa Torres', doc: '7788990011', tel: '3717889900', dir: 'Cll 84 #56-90 Barranquilla', negocio: 'Miscelánea La Rosa', routeId: ROUTE2_ID, officeId: OFFICE1_ID },
    { nombre: 'Miguel Vargas', doc: '3344556677', tel: '3823344556', dir: 'Cra 19 #67-34 Barranquilla', negocio: 'Cyber Café Tech', routeId: ROUTE2_ID, officeId: OFFICE1_ID },
    { nombre: 'Claudia Ríos', doc: '8899001122', tel: '3918990011', dir: 'Cll 52 #23-45 Barranquilla', negocio: 'Estética Claudia', routeId: ROUTE2_ID, officeId: OFFICE1_ID },
    { nombre: 'Roberto Silva', doc: '4455667788', tel: '3124455667', dir: 'Cra 27 #89-12 Barranquilla', negocio: 'Distribuidora Silva', routeId: ROUTE2_ID, officeId: OFFICE1_ID },
    { nombre: 'Patricia Mora', doc: '9900112233', tel: '3139901122', dir: 'Cll 18 #45-67 Soledad', negocio: 'Panadería La Esperanza', routeId: ROUTE3_ID, officeId: OFFICE2_ID },
    { nombre: 'Andrés Castro', doc: '5566778899', tel: '3145566778', dir: 'Cra 12 #78-90 Soledad', negocio: 'Taller Electrónica', routeId: ROUTE3_ID, officeId: OFFICE2_ID },
    { nombre: 'Carolina Ramos', doc: '1100223344', tel: '3151100223', dir: 'Cll 25 #34-56 Soledad', negocio: 'Venta de ropa', routeId: ROUTE3_ID, officeId: OFFICE2_ID },
    { nombre: 'Felipe Jiménez', doc: '6655443322', tel: '3166655443', dir: 'Cra 33 #12-23 Soledad', negocio: 'Heladería Fría', routeId: ROUTE3_ID, officeId: OFFICE2_ID },
    { nombre: 'Gloria Medina', doc: '2211334455', tel: '3172211334', dir: 'Cll 41 #90-12 Soledad', negocio: 'Cosméticos Gloria', routeId: ROUTE3_ID, officeId: OFFICE2_ID },
    { nombre: 'Oscar Romero', doc: '7766554433', tel: '3187766554', dir: 'Cra 58 #23-45 Soledad', negocio: 'Carpintería Romero', routeId: ROUTE4_ID, officeId: OFFICE2_ID },
    { nombre: 'Viviana Suárez', doc: '3322114455', tel: '3193322114', dir: 'Cll 67 #56-78 Soledad', negocio: 'Consultorio Odonto', routeId: ROUTE4_ID, officeId: OFFICE2_ID },
    { nombre: 'Hernando Cruz', doc: '8877665544', tel: '3208877665', dir: 'Cra 74 #78-90 Soledad', negocio: 'Supermercado El Rey', routeId: ROUTE4_ID, officeId: OFFICE2_ID },
    { nombre: 'Natalia Rojas', doc: '4433221100', tel: '3214433221', dir: 'Cll 89 #12-34 Soledad', negocio: 'Tienda Naturista', routeId: ROUTE4_ID, officeId: OFFICE2_ID },
    { nombre: 'Jaime Bonilla', doc: '9988776655', tel: '3229988776', dir: 'Cra 91 #34-56 Soledad', negocio: 'Librería Bonilla', routeId: ROUTE4_ID, officeId: OFFICE2_ID },
  ]

  const clientIds: string[] = clientsData.map(() => uuidv4())
  const clients: Client[] = clientsData.map((c, i) => ({
    id: clientIds[i],
    tenantId: TENANT_ID,
    officeId: c.officeId,
    routeId: c.routeId,
    nombre: c.nombre,
    documento: c.doc,
    telefonoPrincipal: c.tel,
    direccionPrincipal: c.dir,
    negocio: c.negocio,
    status: 'activo' as const,
    createdAt: subDays(now, 60 - i * 2).toISOString(),
    updatedAt: now.toISOString(),
  }))

  // ---- SALES (12 ventas activas) ----
  const salesData = [
    { clientIdx: 0, routeId: ROUTE1_ID, officeId: OFFICE1_ID, valor: 300000, dias: 30, cuotas: 30, freq: 'diaria' as const, cobradorId: USER_COB1_ID, daysAgo: 15 },
    { clientIdx: 1, routeId: ROUTE1_ID, officeId: OFFICE1_ID, valor: 500000, dias: 30, cuotas: 30, freq: 'diaria' as const, cobradorId: USER_COB1_ID, daysAgo: 10 },
    { clientIdx: 2, routeId: ROUTE1_ID, officeId: OFFICE1_ID, valor: 200000, dias: 20, cuotas: 20, freq: 'diaria' as const, cobradorId: USER_COB1_ID, daysAgo: 5 },
    { clientIdx: 3, routeId: ROUTE1_ID, officeId: OFFICE1_ID, valor: 400000, dias: 30, cuotas: 30, freq: 'diaria' as const, cobradorId: USER_COB1_ID, daysAgo: 20 },
    { clientIdx: 5, routeId: ROUTE2_ID, officeId: OFFICE1_ID, valor: 600000, dias: 30, cuotas: 30, freq: 'diaria' as const, cobradorId: USER_COB2_ID, daysAgo: 8 },
    { clientIdx: 6, routeId: ROUTE2_ID, officeId: OFFICE1_ID, valor: 350000, dias: 30, cuotas: 30, freq: 'diaria' as const, cobradorId: USER_COB2_ID, daysAgo: 12 },
    { clientIdx: 7, routeId: ROUTE2_ID, officeId: OFFICE1_ID, valor: 250000, dias: 25, cuotas: 25, freq: 'diaria' as const, cobradorId: USER_COB2_ID, daysAgo: 3 },
    { clientIdx: 10, routeId: ROUTE3_ID, officeId: OFFICE2_ID, valor: 200000, dias: 20, cuotas: 20, freq: 'diaria' as const, cobradorId: USER_COB3_ID, daysAgo: 7 },
    { clientIdx: 11, routeId: ROUTE3_ID, officeId: OFFICE2_ID, valor: 300000, dias: 30, cuotas: 30, freq: 'diaria' as const, cobradorId: USER_COB3_ID, daysAgo: 14 },
    { clientIdx: 15, routeId: ROUTE4_ID, officeId: OFFICE2_ID, valor: 500000, dias: 30, cuotas: 30, freq: 'diaria' as const, cobradorId: USER_COB4_ID, daysAgo: 6 },
    { clientIdx: 16, routeId: ROUTE4_ID, officeId: OFFICE2_ID, valor: 400000, dias: 30, cuotas: 30, freq: 'diaria' as const, cobradorId: USER_COB4_ID, daysAgo: 18 },
    { clientIdx: 17, routeId: ROUTE4_ID, officeId: OFFICE2_ID, valor: 700000, dias: 30, cuotas: 30, freq: 'diaria' as const, cobradorId: USER_COB4_ID, daysAgo: 2 },
  ]

  const salesWithInstallments: Array<{ sale: Sale; installments: ReturnType<typeof generateInstallments> }> = []

  for (const sd of salesData) {
    const saleId = uuidv4()
    const fechaInicio = d(subDays(now, sd.daysAgo))
    const { valorInteres, valorTotal } = calculateTotalWithInterest({ valorVenta: sd.valor, tasaInteres: 20 })
    const valorCuota = Math.round(valorTotal / sd.cuotas)
    const fechaFinalEstimada = estimateFinalDate({ fechaInicio, numeroCuotas: sd.cuotas, frecuencia: sd.freq })
    const installments = generateInstallments({ saleId, valorTotal, numeroCuotas: sd.cuotas, valorCuota, frecuencia: sd.freq, fechaInicio })

    // Simular pagos de cuotas pasadas
    let saldo = valorTotal
    for (const inst of installments) {
      if (inst.fechaVencimiento <= d(subDays(now, 1))) {
        inst.pagado = inst.valor
        inst.saldo = 0
        inst.status = 'pagada'
        saldo -= inst.valor
      }
    }

    const sale: Sale = {
      id: saleId,
      tenantId: TENANT_ID,
      officeId: sd.officeId,
      routeId: sd.routeId,
      clientId: clientIds[sd.clientIdx],
      createdByUserId: sd.cobradorId,
      valorVenta: sd.valor,
      tasaInteres: 20,
      valorInteres,
      valorTotal,
      saldo: Math.max(0, saldo),
      numeroCuotas: sd.cuotas,
      valorCuota,
      frecuenciaPago: sd.freq,
      fechaInicio,
      fechaFinalEstimada,
      status: 'activa',
      createdAt: subDays(now, sd.daysAgo).toISOString(),
      updatedAt: now.toISOString(),
    }
    salesWithInstallments.push({ sale, installments })
  }

  // ---- EXPENSE CATEGORIES ----
  const expenseCategories: ExpenseCategory[] = [
    { id: uuidv4(), tenantId: TENANT_ID, nombre: 'Gasolina', icono: 'fuel', activa: true },
    { id: uuidv4(), tenantId: TENANT_ID, nombre: 'Aceite', icono: 'droplets', activa: true },
    { id: uuidv4(), tenantId: TENANT_ID, nombre: 'Despinchada', icono: 'circle', activa: true },
    { id: uuidv4(), tenantId: TENANT_ID, nombre: 'Comisión', icono: 'percent', activa: true },
    { id: uuidv4(), tenantId: TENANT_ID, nombre: 'Pago policía', icono: 'shield', activa: true },
    { id: uuidv4(), tenantId: TENANT_ID, nombre: 'Transporte', icono: 'car', activa: true },
    { id: uuidv4(), tenantId: TENANT_ID, nombre: 'Otro', icono: 'more-horizontal', activa: true },
  ]

  // ---- EXPENSES ----
  const expenses: Expense[] = [
    { id: uuidv4(), tenantId: TENANT_ID, officeId: OFFICE1_ID, routeId: ROUTE1_ID, categoryId: expenseCategories[0].id, valor: 20000, descripcion: 'Gasolina ruta mañana', fecha: d(subDays(now, 1)), userId: USER_COB1_ID, syncStatus: 'synced', createdAt: subDays(now, 1).toISOString() },
    { id: uuidv4(), tenantId: TENANT_ID, officeId: OFFICE1_ID, routeId: ROUTE1_ID, categoryId: expenseCategories[0].id, valor: 25000, descripcion: 'Gasolina ruta tarde', fecha: d(subDays(now, 3)), userId: USER_COB1_ID, syncStatus: 'synced', createdAt: subDays(now, 3).toISOString() },
    { id: uuidv4(), tenantId: TENANT_ID, officeId: OFFICE1_ID, routeId: ROUTE2_ID, categoryId: expenseCategories[0].id, valor: 30000, descripcion: 'Gasolina', fecha: d(subDays(now, 2)), userId: USER_COB2_ID, syncStatus: 'synced', createdAt: subDays(now, 2).toISOString() },
    { id: uuidv4(), tenantId: TENANT_ID, officeId: OFFICE1_ID, routeId: ROUTE1_ID, categoryId: expenseCategories[2].id, valor: 15000, descripcion: 'Despinchada av principal', fecha: d(subDays(now, 4)), userId: USER_COB1_ID, syncStatus: 'synced', createdAt: subDays(now, 4).toISOString() },
    { id: uuidv4(), tenantId: TENANT_ID, officeId: OFFICE2_ID, routeId: ROUTE3_ID, categoryId: expenseCategories[0].id, valor: 22000, descripcion: 'Gasolina semana', fecha: d(subDays(now, 1)), userId: USER_COB3_ID, syncStatus: 'synced', createdAt: subDays(now, 1).toISOString() },
    { id: uuidv4(), tenantId: TENANT_ID, officeId: OFFICE2_ID, routeId: ROUTE4_ID, categoryId: expenseCategories[5].id, valor: 10000, descripcion: 'Bus para segunda vuelta', fecha: d(now), userId: USER_COB4_ID, syncStatus: 'pending', createdAt: now.toISOString() },
  ]

  // ---- CAPITAL MOVEMENTS ----
  const capitalMovements: CapitalMovement[] = [
    { id: uuidv4(), tenantId: TENANT_ID, officeId: OFFICE1_ID, routeId: ROUTE1_ID, tipo: 'ingresoCapital', valor: 3000000, descripcion: 'Capital inicial ruta norte', fecha: d(subWeeks(now, 4)), userId: USER_ADMIN_ID, createdAt: subWeeks(now, 4).toISOString() },
    { id: uuidv4(), tenantId: TENANT_ID, officeId: OFFICE1_ID, routeId: ROUTE2_ID, tipo: 'ingresoCapital', valor: 4000000, descripcion: 'Capital inicial ruta sur', fecha: d(subWeeks(now, 4)), userId: USER_ADMIN_ID, createdAt: subWeeks(now, 4).toISOString() },
    { id: uuidv4(), tenantId: TENANT_ID, officeId: OFFICE2_ID, routeId: ROUTE3_ID, tipo: 'ingresoCapital', valor: 2500000, descripcion: 'Capital inicial Soledad Centro', fecha: d(subWeeks(now, 3)), userId: USER_ADMIN_ID, createdAt: subWeeks(now, 3).toISOString() },
    { id: uuidv4(), tenantId: TENANT_ID, officeId: OFFICE2_ID, routeId: ROUTE4_ID, tipo: 'ingresoCapital', valor: 5000000, descripcion: 'Capital inicial Soledad Industrial', fecha: d(subWeeks(now, 3)), userId: USER_ADMIN_ID, createdAt: subWeeks(now, 3).toISOString() },
    { id: uuidv4(), tenantId: TENANT_ID, officeId: OFFICE1_ID, routeId: ROUTE1_ID, tipo: 'ingresoCapital', valor: 500000, descripcion: 'Inyección capital semana 2', fecha: d(subWeeks(now, 2)), userId: USER_ADMIN_ID, createdAt: subWeeks(now, 2).toISOString() },
  ]

  // ---- PAYMENTS (pagos demo) ----
  const demoPayments: Payment[] = []
  for (const { sale, installments } of salesWithInstallments) {
    for (const inst of installments) {
      if (inst.status === 'pagada') {
        demoPayments.push({
          id: uuidv4(),
          tenantId: TENANT_ID,
          saleId: sale.id,
          clientId: sale.clientId,
          routeId: sale.routeId,
          collectorId: sale.createdByUserId,
          valor: inst.valor,
          fecha: inst.fechaVencimiento,
          tipo: 'efectivo',
          syncStatus: 'synced',
          createdAt: new Date(inst.fechaVencimiento).toISOString(),
        })
      }
    }
  }

  // Algunos pagos pendientes de sync
  demoPayments.push({
    id: uuidv4(),
    tenantId: TENANT_ID,
    saleId: salesWithInstallments[0].sale.id,
    clientId: clientIds[0],
    routeId: ROUTE1_ID,
    collectorId: USER_COB1_ID,
    valor: salesWithInstallments[0].sale.valorCuota,
    fecha: d(now),
    tipo: 'efectivo',
    observacion: 'Pago sin conexión',
    syncStatus: 'pending',
    createdAt: now.toISOString(),
  })

  // ---- TRANSFERS ----
  const transfers: Transfer[] = [
    {
      id: uuidv4(),
      tenantId: TENANT_ID,
      officeId: OFFICE1_ID,
      routeOrigenId: ROUTE1_ID,
      routeDestinoId: ROUTE2_ID,
      valor: 200000,
      descripcion: 'Refuerzo capital ruta sur',
      fecha: d(subDays(now, 5)),
      userId: USER_ADMIN_ID,
      createdAt: subDays(now, 5).toISOString(),
    },
  ]

  // ---- WITHDRAWALS ----
  const withdrawals: Withdrawal[] = [
    {
      id: uuidv4(),
      tenantId: TENANT_ID,
      officeId: OFFICE1_ID,
      routeId: ROUTE1_ID,
      valor: 150000,
      descripcion: 'Retiro semanal socio',
      fecha: d(subDays(now, 7)),
      userId: USER_ADMIN_ID,
      createdAt: subDays(now, 7).toISOString(),
    },
    {
      id: uuidv4(),
      tenantId: TENANT_ID,
      officeId: OFFICE2_ID,
      routeId: ROUTE4_ID,
      valor: 300000,
      descripcion: 'Retiro ganancia semana',
      fecha: d(subDays(now, 7)),
      userId: USER_ADMIN_ID,
      createdAt: subDays(now, 7).toISOString(),
    },
  ]

  // ---- INSERTAR EN DB ----
  await db.transaction('rw', [
    db.tenants, db.offices, db.routes, db.users, db.clients,
    db.sales, db.installments, db.payments, db.expenseCategories,
    db.expenses, db.capitalMovements, db.transfers, db.withdrawals,
  ], async () => {
    await db.tenants.add(tenant)
    await db.offices.bulkAdd(offices)
    await db.routes.bulkAdd(routes)
    await db.users.bulkAdd(users)
    await db.clients.bulkAdd(clients)

    for (const { sale, installments } of salesWithInstallments) {
      await db.sales.add(sale)
      await db.installments.bulkAdd(installments)
    }

    await db.payments.bulkAdd(demoPayments)
    await db.expenseCategories.bulkAdd(expenseCategories)
    await db.expenses.bulkAdd(expenses)
    await db.capitalMovements.bulkAdd(capitalMovements)
    await db.transfers.bulkAdd(transfers)
    await db.withdrawals.bulkAdd(withdrawals)
  })

  console.log('[RutaCash] Datos demo cargados exitosamente')
  _seeding = false
}

export async function resetToDemo() {
  await db.delete()
  location.reload()
}

// ---- SEED LIMPIO: solo tenant placeholder + admin inicial ----
const CLEAN_TENANT_ID = 'tenant-main-001'
const CLEAN_ADMIN_ID = 'user-admin-main-001'

export async function seedCleanDatabase() {
  const existing = await db.users.count()
  if (existing > 0) return

  const now = new Date()

  const tenant: Tenant = {
    id: CLEAN_TENANT_ID,
    nombre: 'Mi Empresa',
    nombreLegal: '',
    email: 'admin@demo.com',
    telefono: '',
    plan: 'profesional',
    status: 'activa',
    fechaVencimiento: d(new Date(now.getFullYear() + 1, 11, 31)),
    pais: 'Colombia',
    moneda: 'COP',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }

  const admin: User = {
    id: CLEAN_ADMIN_ID,
    tenantId: CLEAN_TENANT_ID,
    email: 'admin@demo.com',
    password: '123456',
    nombre: 'Administrador',
    rol: 'admin',
    status: 'activo',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }

  await db.transaction('rw', [db.tenants, db.users], async () => {
    await db.tenants.add(tenant)
    await db.users.add(admin)
  })

  console.log('[RutaCash] Base de datos limpia inicializada')
}

export async function resetCleanDatabase(tenantId: string) {
  const now = new Date().toISOString()

  await db.offices.where('tenantId').equals(tenantId).delete()
  await db.routes.where('tenantId').equals(tenantId).delete()
  await db.clients.where('tenantId').equals(tenantId).delete()
  await db.sales.where('tenantId').equals(tenantId).delete()
  await db.payments.where('tenantId').equals(tenantId).delete()
  await db.noPaymentVisits.where('tenantId').equals(tenantId).delete()
  await db.expenseCategories.where('tenantId').equals(tenantId).delete()
  await db.expenses.where('tenantId').equals(tenantId).delete()
  await db.capitalMovements.where('tenantId').equals(tenantId).delete()
  await db.transfers.where('tenantId').equals(tenantId).delete()
  await db.withdrawals.where('tenantId').equals(tenantId).delete()
  await db.cashboxMovements.where('tenantId').equals(tenantId).delete()
  await db.weeklySettlements.where('tenantId').equals(tenantId).delete()
  await db.auditLogs.where('tenantId').equals(tenantId).delete()

  // installments no tiene tenantId — en modo limpio (tenant único) se vacía completo
  await db.installments.clear()

  // Eliminar usuarios que no sean el admin inicial
  await db.users
    .where('tenantId').equals(tenantId)
    .and(u => u.email !== 'admin@demo.com')
    .delete()

  // Devolver el tenant al estado inicial limpio (checklist vuelve a 0/7)
  await db.tenants.update(tenantId, {
    nombre: 'Mi Empresa',
    nombreLegal: '',
    nit: undefined,
    ciudad: undefined,
    telefono: '',
    direccion: undefined,
    responsable: undefined,
    updatedAt: now,
  })
}

