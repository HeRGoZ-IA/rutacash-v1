import Dexie, { type Table } from 'dexie'
import type {
  Tenant, Route, User, Client, Sale, Installment, Payment,
  NoPaymentVisit, ExpenseCategory, Expense, CapitalMovement, Transfer,
  Withdrawal, CashboxMovement, WeeklySettlement, AuditLog, SaleRequest,
  PartnerCashMovement, PaymentAdjustmentRequest,
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
  paymentAdjustmentRequests!: Table<PaymentAdjustmentRequest>

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

    // ============================================================
    // v5 (MODELO DE ROLES Y PERMISOS): migración ADITIVA y SEGURA.
    //  - Nueva tabla `paymentAdjustmentRequests` (solicitudes de ajuste de pago).
    //  - Índice `state` en `payments` para la corrección controlada.
    //  - Índice `correctionOfPaymentId`/`reversesPaymentId` para trazar enlaces.
    //  - `.upgrade()` migra datos EXISTENTES sin borrar nada:
    //      · Cobradores: canCreateDirectSales → false (ya no crean ventas directas).
    //      · Todos los roles operativos: routeId → authorizedRouteIds (sin duplicar).
    //      · Liquidaciones existentes: status → 'cerrada'.
    //    No se eliminan tablas ni registros; los campos nuevos son opcionales y
    //    conviven con registros anteriores (valores por defecto seguros en runtime).
    // ============================================================
    this.version(5).stores({
      payments: 'id, tenantId, saleId, clientId, routeId, collectorId, syncStatus, state, correctionOfPaymentId, reversesPaymentId, createdAt',
      paymentAdjustmentRequests: 'id, tenantId, routeId, paymentId, saleId, status, requestedAt',
    }).upgrade(async (tx) => {
      // Cobradores: deshabilitar venta directa (toda venta pasa a ser solicitud).
      await tx.table('users').toCollection().modify((u: User) => {
        if (u.rol === 'cobrador') {
          u.canCreateDirectSales = false
          u.maxDirectSaleAmount = undefined
        }
        // routeId legacy → authorizedRouteIds (sin duplicar), para roles con rutas.
        const roleNeedsRoutes = u.rol === 'admin' || u.rol === 'socio' || u.rol === 'supervisor' || u.rol === 'cobrador' || u.rol === 'secretario'
        if (roleNeedsRoutes) {
          const ids = new Set<string>(u.authorizedRouteIds ?? [])
          if (u.routeId) ids.add(u.routeId)
          // Solo fijar la lista si hay algo que preservar (no forzar [] a admin legacy).
          if (ids.size > 0) u.authorizedRouteIds = [...ids]
        }
      })
      // Liquidaciones existentes representan semanas ya cerradas.
      await tx.table('weeklySettlements').toCollection().modify((w: WeeklySettlement) => {
        if (!w.status) w.status = 'cerrada'
      })
      // Pagos existentes → estado 'active' explícito (compatibilidad; el índice `state`
      // trata undefined como no indexado, pero fijarlo evita ambigüedad al filtrar).
      await tx.table('payments').toCollection().modify((p: Payment) => {
        if (!p.state) p.state = 'active'
      })
    })

    // ============================================================
    // v6 (CIERRE DE BRECHAS — FAIL CLOSED del Administrador): aditiva y segura.
    // Trata explícitamente a los Administradores EXISTENTES para eliminar la regla
    // insegura "admin sin rutas = todas". NO otorga acceso global a nadie:
    //   · Con `authorizedRouteIds`: se conservan, se DEDUPLICAN y se VALIDA que las
    //     rutas existan y pertenezcan al tenant del usuario.
    //   · Solo con `routeId` legado: se convierte a `authorizedRouteIds = [routeId]`
    //     (si la ruta existe en su tenant).
    //   · Sin ninguna asignación: se deja SIN acceso operativo (no se inventan rutas).
    //     Los seeds DEMO/CLEAN asignan rutas explícitamente.
    // No cambia datos financieros ni elimina registros.
    // ============================================================
    this.version(6).upgrade(async (tx) => {
      const routes = await tx.table('routes').toArray() as Route[]
      const routeById = new Map(routes.map(r => [r.id, r]))
      const roleNeedsRoutes = (r: string) => r === 'admin' || r === 'socio' || r === 'supervisor' || r === 'cobrador' || r === 'secretario'
      await tx.table('users').toCollection().modify((u: User) => {
        if (!roleNeedsRoutes(u.rol)) return
        const raw = new Set<string>(u.authorizedRouteIds ?? [])
        if (u.routeId) raw.add(u.routeId) // convertir routeId legado
        // Validar existencia y pertenencia al tenant (elimina referencias inconsistentes).
        const valid = [...raw].filter(id => routeById.get(id)?.tenantId === u.tenantId)
        u.authorizedRouteIds = valid.length > 0 ? valid : undefined
      })
    })

    // ============================================================
    // v7 (MODELO PURO: ROL BASE + RUTAS): aditiva y segura. Se eliminan los permisos
    // INDIVIDUALES (grantedCapabilities/revokedCapabilities). `can()` ya los ignora;
    // aquí se LIMPIAN los datos para no dejar arreglos huérfanos. No cambia rol, rutas
    // ni ningún dato financiero; no elimina usuarios. Reporta cuántos se limpiaron.
    // ============================================================
    this.version(7).upgrade(async (tx) => {
      let cleaned = 0
      await tx.table('users').toCollection().modify((u: User) => {
        const had = (u.grantedCapabilities && u.grantedCapabilities.length > 0) ||
                    (u.revokedCapabilities && u.revokedCapabilities.length > 0)
        if (had) {
          u.grantedCapabilities = undefined
          u.revokedCapabilities = undefined
          cleaned++
        }
      })
      console.log(`[RutaCash][migración v7] Permisos individuales eliminados de ${cleaned} usuario(s). Modelo: ROL BASE + RUTAS.`)
    })
  }
}

export const db = new RutaCashDB()

export async function clearAndResetDB() {
  await db.delete()
  return new RutaCashDB()
}
