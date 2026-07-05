import Dexie, { type Table } from 'dexie'
import type {
  Tenant, Route, User, Client, Sale, Installment, Payment,
  NoPaymentVisit, ExpenseCategory, Expense, CapitalMovement, Transfer,
  Withdrawal, CashboxMovement, WeeklySettlement, AuditLog, SaleRequest,
  PartnerCashMovement,
} from '@/models/types'

export class RutaCashDB extends Dexie {
  tenants!: Table<Tenant>
  routes!: Table<Route>
  users!: Table<User>
  clients!: Table<Client>
  sales!: Table<Sale>
  installments!: Table<Installment>
  payments!: Table<Payment>
  noPaymentVisits!: Table<NoPaymentVisit>
  expenseCategories!: Table<ExpenseCategory>
  expenses!: Table<Expense>
  capitalMovements!: Table<CapitalMovement>
  transfers!: Table<Transfer>
  withdrawals!: Table<Withdrawal>
  cashboxMovements!: Table<CashboxMovement>
  weeklySettlements!: Table<WeeklySettlement>
  auditLogs!: Table<AuditLog>
  saleRequests!: Table<SaleRequest>
  partnerCashMovements!: Table<PartnerCashMovement>

  constructor() {
    super('RutaCashDB')

    this.version(1).stores({
      tenants: 'id, status, plan',
      offices: 'id, tenantId, status',
      routes: 'id, tenantId, officeId, cobradorId, status',
      users: 'id, tenantId, officeId, routeId, email, rol, status',
      clients: 'id, tenantId, officeId, routeId, documento, status',
      sales: 'id, tenantId, officeId, routeId, clientId, status, createdAt',
      installments: 'id, saleId, numero, status',
      payments: 'id, tenantId, saleId, clientId, routeId, collectorId, syncStatus, createdAt',
      noPaymentVisits: 'id, tenantId, saleId, clientId, routeId, collectorId, syncStatus',
      expenseCategories: 'id, tenantId, activa',
      expenses: 'id, tenantId, officeId, routeId, categoryId, userId, syncStatus',
      capitalMovements: 'id, tenantId, officeId, routeId, tipo',
      transfers: 'id, tenantId, officeId, routeOrigenId, routeDestinoId',
      withdrawals: 'id, tenantId, officeId, routeId',
      cashboxMovements: 'id, tenantId, routeId, tipo, fecha',
      weeklySettlements: 'id, tenantId, officeId, routeId, semanaInicio',
      auditLogs: 'id, tenantId, userId, action, entityType, entityId, createdAt',
    })

    // v2 (App Cobrador): nueva tabla de solicitudes de venta. Las tablas
    // existentes se conservan; los campos nuevos opcionales (disbursementStatus,
    // receiptPhotoDataUrl, canCreateDirectSales, etc.) no requieren índices.
    this.version(2).stores({
      saleRequests: 'id, tenantId, routeId, collectorId, clientId, status, requestedAt',
    })

    // v3: se elimina "Oficinas". Se borra la tabla `offices` y se quitan los
    // índices `officeId` de las demás tablas. El campo `officeId` queda como
    // dato legacy opcional dentro de los registros (Dexie lo conserva/ignora).
    this.version(3).stores({
      offices: null,
      routes: 'id, tenantId, cobradorId, status',
      users: 'id, tenantId, routeId, email, rol, status',
      clients: 'id, tenantId, routeId, documento, status',
      sales: 'id, tenantId, routeId, clientId, status, createdAt',
      expenses: 'id, tenantId, routeId, categoryId, userId, syncStatus',
      capitalMovements: 'id, tenantId, routeId, tipo',
      transfers: 'id, tenantId, routeOrigenId, routeDestinoId',
      withdrawals: 'id, tenantId, routeId',
      weeklySettlements: 'id, tenantId, routeId, semanaInicio',
    })

    // v4 (Revisión 2 socio 30-jun): nueva tabla Caja socios. Los campos nuevos
    // opcionales de Transfer (socioOrigenId, origenType, destinoType) no requieren
    // índices; se filtran en memoria. No se toca ninguna tabla existente.
    this.version(4).stores({
      partnerCashMovements: 'id, tenantId, partnerId, type, relatedTransferId, fecha',
    })
  }
}

export const db = new RutaCashDB()

export async function clearAndResetDB() {
  await db.delete()
  return new RutaCashDB()
}
