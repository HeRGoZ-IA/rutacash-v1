import Dexie, { type Table } from 'dexie'
import type {
  Tenant, Office, Route, User, Client, Sale, Installment, Payment,
  NoPaymentVisit, ExpenseCategory, Expense, CapitalMovement, Transfer,
  Withdrawal, CashboxMovement, WeeklySettlement, AuditLog,
} from '@/models/types'

export class RutaCashDB extends Dexie {
  tenants!: Table<Tenant>
  offices!: Table<Office>
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
  }
}

export const db = new RutaCashDB()

export async function clearAndResetDB() {
  await db.delete()
  return new RutaCashDB()
}
