import Dexie, { type Table } from 'dexie'
import { lastEffectivePaymentDate } from '@/lib/paymentState'
import type {
  Tenant, Office, Route, User, Client, Sale, Installment, Payment,
  NoPaymentVisit, ExpenseCategory, Expense, CapitalMovement, Transfer,
  Withdrawal, CashboxMovement, WeeklySettlement, AuditLog, SaleRequest,
  PartnerCashMovement, PaymentAdjustmentRequest, CashSettlement,
} from '@/models/types'
import type {
  PlatformUser, CompanyControlRecord, SaaSPayment, ControlEvent,
} from '@/platform/types'

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
  saleRequests!: Table<SaleRequest>
  partnerCashMovements!: Table<PartnerCashMovement>
  paymentAdjustmentRequests!: Table<PaymentAdjustmentRequest>
  /** Cuadre real por trabajador (v14). Route + persona + periodo por instantes. */
  cashSettlements!: Table<CashSettlement>

  // ------------------------------------------------------------
  // PLANO DE CONTROL SaaS (NIVEL PLATAFORMA — v13)
  // ------------------------------------------------------------
  // Tablas del Owner. Están en la misma base local porque HOY NO HAY BACKEND, pero
  // son conceptualmente otra base: ninguna entidad operativa las referencia y ellas
  // no referencian ninguna entidad operativa. Cuando exista servidor compartido, se
  // van enteras al servidor sin arrastrar nada de la operación.
  platformUsers!: Table<PlatformUser>
  companyControl!: Table<CompanyControlRecord>
  saasPayments!: Table<SaaSPayment>
  controlEvents!: Table<ControlEvent>

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
    //
    // NOTA (histórica): esta decisión se REVIRTIÓ en la v11, que vuelve a crear
    // `offices` con el modelo Empresa → Oficina → Ruta. Aquel `officeId` legado
    // disperso por nueve entidades se limpia allí: hoy solo `Route.officeId` existe.
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

    // ============================================================
    // v8 (CONSISTENCIA Usuario↔Ruta): aditiva y segura. Reconcilia route.cobradorId
    // (cobrador RESPONSABLE legado) con la fuente única User.authorizedRouteIds:
    //   · Si route.cobradorId apunta a un usuario inexistente o de OTRO tenant → se
    //     limpia (evita datos contradictorios).
    //   · Si el cobrador responsable NO tiene routeId en authorizedRouteIds → se agrega
    //     (sincronización inequívoca: el responsable es, por definición, miembro).
    //   · NO se inventa responsable para rutas con cobradores asignados y cobradorId
    //     vacío (no se elige arbitrariamente si hay varios). NO se borran asignaciones.
    // No cambia datos financieros ni elimina usuarios/rutas.
    // ============================================================
    this.version(8).upgrade(async (tx) => {
      const [routes, users] = await Promise.all([
        tx.table('routes').toArray() as Promise<Route[]>,
        tx.table('users').toArray() as Promise<User[]>,
      ])
      const userById = new Map(users.map(u => [u.id, u]))
      let cleared = 0
      let synced = 0
      for (const r of routes) {
        if (!r.cobradorId) continue
        const u = userById.get(r.cobradorId)
        if (!u || u.tenantId !== r.tenantId) {
          await tx.table('routes').update(r.id, { cobradorId: undefined })
          cleared++
          continue
        }
        const ids = new Set<string>(u.authorizedRouteIds ?? [])
        if (u.routeId) ids.add(u.routeId)
        if (!ids.has(r.id)) {
          ids.add(r.id)
          const list = [...ids]
          await tx.table('users').update(u.id, { authorizedRouteIds: list })
          u.authorizedRouteIds = list // por si el mismo cobrador es responsable de varias rutas
          synced++
        }
      }
      console.log(`[RutaCash][migración v8] cobradorId inválidos limpiados: ${cleared}; membresías de responsable sincronizadas: ${synced}.`)
    })

    // ============================================================
    // v9 (FECHA REAL DE FINALIZACIÓN DEL CRÉDITO): aditiva y segura.
    // `Sale.fechaFinalizacion` es un campo NUEVO y OPCIONAL: no cambia índices, no
    // borra nada y no toca importes. Esta migración solo rellena el dato histórico
    // de las ventas que YA estaban finalizadas:
    //   · Se toma la fecha CONTABLE del ÚLTIMO PAGO VIGENTE de la venta
    //     (`lastEffectivePaymentDate`: excluye originales revertidos y asientos de
    //     reversión, misma semántica que la corrección controlada).
    //   · Si la venta no tiene ningún pago vigente, se DEJA VACÍA. No se inventa una
    //     fecha, y NUNCA se usa `updatedAt` (cambia con cualquier actualización
    //     posterior y no representa el cierre).
    //   · Ventas activas, perdidas o refinanciadas no reciben fecha: no han
    //     terminado de pagarse.
    // Se ejecuta UNA sola vez; a partir de aquí la fecha la sellan `paymentService`
    // (al saldar) y `paymentCorrectionService` (al recomputar).
    // ============================================================
    this.version(9).upgrade(async (tx) => {
      const sales = await tx.table('sales').toArray() as Sale[]
      const pendientes = sales.filter(s => s.status === 'finalizada' && !s.fechaFinalizacion)
      if (pendientes.length === 0) {
        console.log('[RutaCash][migración v9] No hay ventas finalizadas sin fecha real de finalización.')
        return
      }
      const payments = await tx.table('payments').toArray() as Payment[]
      const porVenta = new Map<string, Payment[]>()
      for (const p of payments) {
        const arr = porVenta.get(p.saleId) ?? []
        arr.push(p)
        porVenta.set(p.saleId, arr)
      }
      let selladas = 0
      let sinFuente = 0
      for (const s of pendientes) {
        const fecha = lastEffectivePaymentDate(porVenta.get(s.id) ?? [])
        if (!fecha) { sinFuente++; continue }   // sin fuente fiable → se deja vacía
        await tx.table('sales').update(s.id, { fechaFinalizacion: fecha })
        selladas++
      }
      console.log(`[RutaCash][migración v9] Fecha real de finalización inferida en ${selladas} venta(s); ${sinFuente} sin pago vigente del que inferirla (quedan vacías).`)
    })

    // ============================================================
    // v10 (ATRIBUCIÓN DEL EFECTIVO: REGISTRAR ≠ RESPONDER): aditiva y segura.
    // Se separan dos conceptos que antes compartían un solo campo. NO se reinterpreta
    // ningún dato histórico ni se mueve dinero de una caja a otra:
    //
    //   · payments.createdByUserId ← collectorId
    //     EQUIVALENCIA LEGACY EXPLÍCITA: antes de esta versión `collectorId` guardaba
    //     el id de quien DIGITABA el abono, que en la práctica era casi siempre el
    //     propio cobrador. Se conserva `collectorId` intacto (sigue siendo el
    //     responsable del dinero) y se copia en `createdByUserId` porque es la única
    //     fuente histórica de quién registró. A partir de aquí ambos se escriben por
    //     separado y pueden diferir.
    //
    //   · expenses.collectorId ← userId, SOLO si ese usuario es cobrador.
    //     Un gasto registrado por un Admin no se carga a la caja personal de nadie.
    //
    //   · sales.disbursedByCollectorId / fechaDesembolso para ventas ya desembolsadas.
    //     El responsable se infiere de `createdByUserId` cuando es cobrador; la fecha,
    //     de `fechaInicio` (fecha contable de arranque del crédito). Es la mejor
    //     aproximación disponible y queda documentada como comportamiento legacy.
    //
    // No se borra nada, no se cambian importes y ninguna venta cambia de estado.
    // ============================================================
    this.version(10).upgrade(async (tx) => {
      const users = await tx.table('users').toArray() as User[]
      const esCobrador = new Set(users.filter(u => u.rol === 'cobrador').map(u => u.id))

      let pagos = 0
      await tx.table('payments').toCollection().modify((p: Payment) => {
        if (!p.createdByUserId) { p.createdByUserId = p.collectorId; pagos++ }
      })

      let gastos = 0
      await tx.table('expenses').toCollection().modify((e: Expense) => {
        if (e.collectorId === undefined && esCobrador.has(e.userId)) { e.collectorId = e.userId; gastos++ }
      })

      let ventas = 0
      await tx.table('sales').toCollection().modify((s: Sale) => {
        if (s.disbursementStatus === 'pendiente') return
        if (s.disbursedByCollectorId !== undefined || s.fechaDesembolso !== undefined) return
        if (esCobrador.has(s.createdByUserId)) s.disbursedByCollectorId = s.createdByUserId
        s.disbursedByUserId = s.createdByUserId
        s.fechaDesembolso = s.fechaInicio
        ventas++
      })

      console.log(`[RutaCash][migración v10] Atribución separada: ${pagos} pago(s), ${gastos} gasto(s) y ${ventas} venta(s) desembolsada(s). Los valores históricos conservan la equivalencia legacy (registrador = responsable).`)
    })

    // ============================================================
    // v11 (OFICINAS: Empresa → Oficina → Ruta): aditiva y segura.
    //
    // RECREA la tabla `offices`, que la v3 eliminó (`offices: null`). Declararla de
    // nuevo aquí es legal en Dexie y está cubierto por OFFICE-MIG-001, que migra una
    // base v1 → v11 pasando por el borrado de la v3.
    //
    // SANEAMIENTO (no destructivo). Antes de esta versión, `officeId` era un campo
    // legacy duplicado en nueve entidades, con valores que apuntaban a oficinas
    // inexistentes (el seed DEMO sembraba 'office-001'/'office-002' sin tabla que los
    // respaldara). A partir de aquí SOLO `Route.officeId` existe:
    //   · Rutas cuyo `officeId` no apunte a una Oficina REAL → `undefined`
    //     ("Sin Oficina"). NO se inventan Oficinas para rescatar ids colgantes: las
    //     rutas existentes quedan sin Oficina, tal como se decidió.
    //   · Se borra `officeId` de users, clients, sales, expenses, capitalMovements,
    //     transfers, withdrawals y weeklySettlements. La Oficina de cualquiera de
    //     ellos se DERIVA por `routeId → Route.officeId`.
    //
    // No se borra ningún registro, no se tocan importes, estados ni `routeId`, y
    // ninguna asignación de usuario (`authorizedRouteIds`) cambia.
    // ============================================================
    this.version(11).stores({
      offices: 'id, tenantId, status',
    }).upgrade(async (tx) => {
      // 1) Rutas: conservar solo las Oficinas que existan de verdad.
      const offices = await tx.table('offices').toArray() as Office[]
      const officeIds = new Set(offices.map(o => o.id))
      let rutasLimpiadas = 0
      await tx.table('routes').toCollection().modify((r: Route) => {
        if (r.officeId && !officeIds.has(r.officeId)) {
          r.officeId = undefined
          rutasLimpiadas++
        }
      })

      // 2) Resto de entidades: el campo desaparece del modelo.
      const CON_OFFICE_LEGACY = [
        'users', 'clients', 'sales', 'expenses',
        'capitalMovements', 'transfers', 'withdrawals', 'weeklySettlements',
      ] as const
      let registrosLimpiados = 0
      for (const tabla of CON_OFFICE_LEGACY) {
        await tx.table(tabla).toCollection().modify((row: Record<string, unknown>) => {
          if ('officeId' in row) {
            delete row.officeId
            registrosLimpiados++
          }
        })
      }

      console.log(
        `[RutaCash][migración v11] Oficinas habilitadas. ` +
        `Rutas con Oficina inexistente → "Sin Oficina": ${rutasLimpiadas}. ` +
        `officeId legado eliminado de ${registrosLimpiados} registro(s) de otras entidades. ` +
        `Ninguna Oficina se creó automáticamente.`,
      )
    })

    // ============================================================
    // v12 (LIQUIDACIONES PERSISTENTES): aditiva y segura.
    //
    // Los campos nuevos de `WeeklySettlement` (trazabilidad del cierre, versionado
    // y snapshot histórico de Oficina) son OPCIONALES y no requieren índices. Esta
    // migración solo NORMALIZA las liquidaciones que ya existieran para que el
    // historial las muestre de forma coherente:
    //   · `status` ausente → 'cerrada' (ya era la interpretación vigente).
    //   · `version` ausente → 1.
    //   · `closedAt` ausente → `createdAt` (la única fecha disponible).
    //
    // NO se inventa el snapshot de Oficina de los cierres heredados: no se sabe en
    // qué Oficina estaba la ruta entonces, y deducirlo de la Oficina ACTUAL sería
    // falsear el histórico. Esos cierres se muestran sin Oficina histórica.
    // No se borra nada y no se toca ningún importe.
    // ============================================================
    this.version(12).upgrade(async (tx) => {
      let normalizadas = 0
      await tx.table('weeklySettlements').toCollection().modify((w: WeeklySettlement) => {
        let tocada = false
        if (!w.status) { w.status = 'cerrada'; tocada = true }
        if (w.version === undefined) { w.version = 1; tocada = true }
        if (!w.closedAt && w.status === 'cerrada') { w.closedAt = w.createdAt; tocada = true }
        if (tocada) normalizadas++
      })
      console.log(
        `[RutaCash][migración v12] Liquidaciones normalizadas: ${normalizadas}. ` +
        `El snapshot de Oficina NO se deduce para cierres heredados: se desconoce la ` +
        `Oficina del momento y deducirla de la actual falsearía el histórico.`,
      )
    })

    // ============================================================
    // v13 (SEPARACIÓN PLATAFORMA / EMPRESA): estructural y NO destructiva.
    //
    // Corrige la confusión de niveles que arrastraba el modelo: el Super Admin
    // mezclaba "dueño de RutaCash" con "máxima autoridad de una empresa". A partir
    // de aquí son dos cosas distintas y viven en tablas distintas:
    //
    //   · OWNER      → `platformUsers`. Dueño del SaaS. Sin tenantId, sin rutas.
    //   · SUPERADMIN → `users`, SIEMPRE con el tenantId de SU empresa.
    //
    // QUÉ HACE CON LOS SUPER ADMIN HEREDADOS (los que llevan tenantId 'platform'):
    //
    //   1) Se COPIA su cuenta a `platformUsers` como Owner, conservando nombre,
    //      correo y contraseña. Es deliberado: esa persona es, de hecho, el dueño de
    //      la instalación, y así conserva su acceso por `/owner/login` sin que nadie
    //      le invente credenciales nuevas. NO se crea ninguna cuenta con contraseña
    //      conocida: se reutiliza exactamente la que esa persona ya eligió.
    //
    //   2) Su fila en `users` se REUBICA en una empresa real, para que esa empresa
    //      conserve un Super Admin:
    //        · 1 empresa    → se le asigna esa empresa.
    //        · 0 empresas   → no hay empresa que administrar: la fila se elimina de
    //                         `users`. La persona sigue existiendo como Owner y desde
    //                         el portal creará su primera empresa con su Super Admin.
    //        · >1 empresas  → se asigna a la MÁS ANTIGUA y se deja constancia en
    //                         consola. Las demás quedan sin Super Admin y el Owner
    //                         debe crearles uno: no se puede clonar la cuenta a
    //                         varias empresas porque el correo es la clave de acceso
    //                         y se duplicaría. Documentado, no disimulado.
    //
    //   3) Se crea la FICHA DE CONTROL (`companyControl`) de cada empresa existente,
    //      derivando su estado comercial del `Tenant.status` actual y contando sus
    //      rutas reales. Sin fecha de primer/último ingreso: no existían y no se
    //      inventan (quedan vacías hasta el primer acceso real).
    //
    //   4) Se apaga `mustChangePassword` en todos los usuarios: RutaCash ya no fuerza
    //      cambios de contraseña al entrar (la gestión vive en Usuarios). El campo se
    //      conserva en el esquema por compatibilidad, pero deja de tener efecto.
    //
    // No se borra ninguna empresa, ruta, cliente, venta, pago ni liquidación.
    // ============================================================
    this.version(13).stores({
      platformUsers: 'id, email, status',
      companyControl: 'companyId, status',
      saasPayments: 'id, companyId, periodo, status',
      controlEvents: 'id, companyId, type, at',
    }).upgrade(async (tx) => {
      const PLATFORM_SENTINEL = 'platform'
      const ahora = new Date().toISOString()

      const [users, tenants, routes] = await Promise.all([
        tx.table('users').toArray() as Promise<User[]>,
        tx.table('tenants').toArray() as Promise<Tenant[]>,
        tx.table('routes').toArray() as Promise<Route[]>,
      ])

      // --- 1) Empresas reales (el centinela nunca fue una empresa). ---
      const empresas = tenants
        .filter(t => t.id !== PLATFORM_SENTINEL)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))

      // --- 2) Ficha de control de cada empresa existente. ---
      const rutasPorEmpresa = new Map<string, Route[]>()
      for (const r of routes) {
        const arr = rutasPorEmpresa.get(r.tenantId) ?? []
        arr.push(r)
        rutasPorEmpresa.set(r.tenantId, arr)
      }
      const estadoComercial = (s: string) =>
        s === 'prueba' ? 'trial' : s === 'suspendida' ? 'suspended' : 'active'

      for (const t of empresas) {
        const suyas = rutasPorEmpresa.get(t.id) ?? []
        await tx.table('companyControl').put({
          companyId: t.id,
          nombre: t.nombre,
          identificacion: t.nit,
          contacto: t.responsable,
          contactoEmail: t.email,
          createdAt: t.createdAt || ahora,
          status: estadoComercial(t.status),
          routeCount: suyas.length,
          // Regla comercial: se factura la ruta ACTIVA (ver platform/billing.ts).
          billableRouteCount: suyas.filter(r => r.status === 'activa').length,
          billingMode: 'per_route',
          billingRate: 0,
          paymentStatus: 'pending',
          updatedAt: ahora,
        })
      }

      // --- 3) Super Admin heredados de plataforma → Owner + reubicación. ---
      const heredados = users.filter(u => u.rol === 'superadmin' && u.tenantId === PLATFORM_SENTINEL)
      const destino = empresas[0]
      let promovidos = 0
      let reubicados = 0
      let eliminados = 0

      for (const u of heredados) {
        await tx.table('platformUsers').put({
          id: `owner-${u.id}`,
          nombre: u.nombre,
          email: u.email,
          password: u.password,     // la MISMA que esa persona ya eligió
          rol: 'owner',
          status: u.status === 'inactivo' ? 'inactivo' : 'activo',
          createdAt: u.createdAt || ahora,
          updatedAt: ahora,
        })
        promovidos++

        if (destino) {
          await tx.table('users').update(u.id, { tenantId: destino.id, updatedAt: ahora })
          reubicados++
        } else {
          await tx.table('users').delete(u.id)
          eliminados++
        }
      }

      // --- 4) Se acabó el cambio obligatorio de contraseña. ---
      let desbloqueados = 0
      await tx.table('users').toCollection().modify((u: User) => {
        if (u.mustChangePassword === true) { u.mustChangePassword = false; desbloqueados++ }
      })

      console.log(
        `[RutaCash][migración v13] Plataforma y empresa separadas. ` +
        `Owners creados desde Super Admin heredados: ${promovidos}. ` +
        `Super Admin reubicados en una empresa: ${reubicados}. ` +
        `Super Admin sin empresa que administrar (eliminados de users, conservados como Owner): ${eliminados}. ` +
        `Fichas de control creadas: ${empresas.length}. ` +
        `Cambio obligatorio de contraseña apagado en ${desbloqueados} usuario(s).` +
        (empresas.length > 1 && heredados.length > 0
          ? ` AVISO: hay ${empresas.length} empresas y el Super Admin heredado solo pudo asignarse a "${destino?.nombre}". ` +
            `Las demás quedan sin Super Admin: créalos desde el portal Owner.`
          : ''),
      )
    })

    // ============================================================
    // v14 (CUADRE REAL POR TRABAJADOR): aditiva.
    //
    //   1) Tabla nueva `cashSettlements`. Índices: los que filtra el servicio
    //      (empresa, ruta, persona, estado) y el compuesto [routeId+userId], que es
    //      la llave de un ciclo de efectivo. SIN `officeId`: la Oficina se deriva
    //      por la ruta, igual que en el resto del modelo.
    //
    //   2) NO SE INVENTA HISTÓRICO. No se crea ningún cuadre para el pasado: la
    //      atribución anterior a la regla definitiva del Supervisor no es fiable y
    //      reconstruir cierres sería fabricar hechos. En su lugar se marca en cada
    //      empresa el INICIO DEL MODELO PERSONAL (`cashModelStartAt`) = instante de
    //      esta actualización. El primer cuadre de cada trabajador parte de ahí con
    //      arrastre 0.
    //
    // No se borra ni se modifica ningún pago, venta, gasto ni liquidación.
    // ============================================================
    this.version(14).stores({
      cashSettlements: 'id, tenantId, routeId, userId, status, [routeId+userId]',
    }).upgrade(async (tx) => {
      const inicio = new Date().toISOString()
      let marcadas = 0
      await tx.table('tenants').toCollection().modify((t: Tenant) => {
        if (!t.cashModelStartAt) { t.cashModelStartAt = inicio; marcadas++ }
      })
      console.log(
        `[RutaCash][migración v14] Cuadre por trabajador habilitado. Inicio del modelo personal ` +
        `fijado en ${marcadas} empresa(s) a ${inicio}. No se crearon cuadres históricos.`,
      )
    })
  }
}

export const db = new RutaCashDB()

export async function clearAndResetDB() {
  await db.delete()
  return new RutaCashDB()
}
