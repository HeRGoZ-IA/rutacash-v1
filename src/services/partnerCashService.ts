// ============================================================
// Caja socios (Revisión 2 socio 30-jun)
// Módulo SEPARADO de la caja de rutas. Registra el dinero asociado a cada
// socio (usuario con rol 'socio'). Se alimenta de movimientos creados
// directamente aquí y de movimientos generados por Transferencias.
// ============================================================
import { db, type RutaCashDB } from '@/lib/db'
import { nowISO, today } from '@/lib/formatters'
import { authorizedRouteIdsOf, can, isPartnerInScope } from '@/lib/permissions'
import { AuthzError } from '@/services/authz'
import { logAction } from '@/services/auditService'
import { operationIdOf } from '@/services/capitalControlService'
import type {
  PartnerCashMovement, PartnerCashType, PartnerCashCategory, User,
} from '@/models/types'

/** Socios de la empresa: usuarios con rol 'socio'. */
export async function getPartners(tenantId: string): Promise<User[]> {
  const users = await db.users.where('tenantId').equals(tenantId).toArray()
  return users.filter(u => u.rol === 'socio')
}

export interface PartnerCashSummary {
  partnerId: string
  nombre: string
  totalIngresos: number
  totalSalidas: number
  saldo: number
  cantidad: number
  ultimoMovimiento?: string
  movements: PartnerCashMovement[]
}

/**
 * Resumen por socio a partir de sus movimientos de caja.
 * saldo = ingresos - salidas. Incluye socios sin movimientos (saldo 0) y
 * un grupo "Sin socio" para movimientos cuyo socio ya no existe.
 */
export function buildPartnerSummaries(
  partners: Pick<User, 'id' | 'nombre'>[],
  movements: PartnerCashMovement[],
): PartnerCashSummary[] {
  const byPartner = new Map<string, PartnerCashMovement[]>()
  for (const m of movements) {
    const arr = byPartner.get(m.partnerId) ?? []
    arr.push(m)
    byPartner.set(m.partnerId, arr)
  }

  const build = (partnerId: string, nombre: string): PartnerCashSummary => {
    const movs = (byPartner.get(partnerId) ?? []).slice().sort((a, b) => b.fecha.localeCompare(a.fecha))
    const totalIngresos = movs.filter(m => m.type === 'ingreso').reduce((s, m) => s + m.amount, 0)
    const totalSalidas = movs.filter(m => m.type === 'salida').reduce((s, m) => s + m.amount, 0)
    return {
      partnerId, nombre,
      totalIngresos, totalSalidas,
      saldo: totalIngresos - totalSalidas,
      cantidad: movs.length,
      ultimoMovimiento: movs[0]?.fecha,
      movements: movs,
    }
  }

  const list = partners.map(p => build(p.id, p.nombre))

  // Movimientos cuyo socio ya no existe → grupo "Sin socio".
  const knownIds = new Set(partners.map(p => p.id))
  const orphan = movements.filter(m => !knownIds.has(m.partnerId))
  if (orphan.length > 0) {
    list.push(build('__none__', 'Sin socio'))
    // Ajuste: build usó byPartner por id real; recomputamos el grupo huérfano.
    const g = list[list.length - 1]
    g.movements = orphan.slice().sort((a, b) => b.fecha.localeCompare(a.fecha))
    g.totalIngresos = orphan.filter(m => m.type === 'ingreso').reduce((s, m) => s + m.amount, 0)
    g.totalSalidas = orphan.filter(m => m.type === 'salida').reduce((s, m) => s + m.amount, 0)
    g.saldo = g.totalIngresos - g.totalSalidas
    g.cantidad = orphan.length
    g.ultimoMovimiento = g.movements[0]?.fecha
  }

  return list
}

/**
 * SALDO de un socio en Caja socios = ingresos − salidas, ALGEBRAICO (las
 * reversiones son asientos negados del mismo tipo). Fuente única para validar
 * salidas y aportes (Ronda 5/6).
 */
export function partnerBalance(movs: Pick<PartnerCashMovement, 'type' | 'amount'>[]): number {
  return movs.reduce((s, m) => s + (m.type === 'ingreso' ? m.amount : -m.amount), 0)
}

export class PartnerCashError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PartnerCashError'
  }
}

export interface CreatePartnerMovementInput {
  /** Quién registra (Ronda 5/6: obligatorio; el servicio valida permiso y alcance). */
  actor: User | null | undefined
  /** Id de la operación: reintentos y doble clic no duplican el movimiento. */
  operationId?: string
  tenantId: string
  partnerId: string
  type: PartnerCashType
  category: PartnerCashCategory
  amount: number
  description?: string
  fecha: string
  relatedTransferId?: string
  createdBy?: string
}

/**
 * Registra un movimiento MANUAL de Caja socios (Ronda 5/6: validado en el servicio).
 * Antes solo validaba la pantalla: cualquier llamada podía registrar una salida sin
 * saldo. Ahora, de forma conservadora (sin rediseñar el circuito, decisión D1):
 *   · actor activo de la empresa con `partnerCash.registerMovement`;
 *   · socio de la empresa, con rol socio y dentro del alcance del actor;
 *   · importe entero > 0; fecha válida y no futura;
 *   · El SALDO no se exige (ni en salidas): si Caja socios puede quedar en negativo
 *     es la decisión D1 pendiente — los aportes Socio → Ruta reales ya la dejan así.
 *   · id de operación: un reintento devuelve el mismo movimiento.
 * Un INGRESO manual sigue siendo una declaración de dinero externo del socio.
 */
export async function createPartnerMovement(input: CreatePartnerMovementInput, database: RutaCashDB = db): Promise<PartnerCashMovement> {
  const { actor, tenantId } = input
  if (!actor || actor.tenantId !== tenantId || !can(actor, 'partnerCash.registerMovement', { tenantId })) {
    throw new AuthzError('Acción no autorizada (Caja socios).')
  }
  const socio = await database.users.get(input.partnerId)
  if (!socio || socio.tenantId !== tenantId || socio.rol !== 'socio') throw new PartnerCashError('El socio indicado no existe en esta empresa.')
  if (!isPartnerInScope(actor, authorizedRouteIdsOf(socio))) throw new AuthzError('El socio está fuera de tu alcance.')
  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount) !== amount) throw new PartnerCashError('El valor debe ser un entero mayor a 0.')
  if (input.type !== 'ingreso' && input.type !== 'salida') throw new PartnerCashError('Tipo de movimiento inválido.')
  const fecha = input.fecha || today()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || fecha > today()) throw new PartnerCashError('La fecha no es válida o es futura.')
  const id = operationIdOf(input.operationId, m => new PartnerCashError(m))
  let mov!: PartnerCashMovement
  let reintento = false
  await database.transaction('rw', [database.partnerCashMovements, database.users], async () => {
    const previo = input.operationId !== undefined ? await database.partnerCashMovements.get(id) : undefined
    if (previo) {
      if (previo.tenantId !== tenantId || previo.partnerId !== input.partnerId || previo.type !== input.type || previo.amount !== amount) {
        throw new PartnerCashError('Ese identificador de operación ya corresponde a otro movimiento de Caja socios.')
      }
      mov = previo
      reintento = true
      return
    }
    mov = {
      id, tenantId, partnerId: input.partnerId, type: input.type, category: input.category, amount,
      description: input.description?.trim() || undefined, relatedTransferId: input.relatedTransferId,
      fecha, createdAt: nowISO(), createdBy: actor.id,
    }
    await database.partnerCashMovements.add(mov)
  })
  if (!reintento) {
    await logAction({
      tenantId, userId: actor.id, userRole: actor.rol, action: 'PARTNER_CASH_MOVEMENT', entityType: 'partnerCashMovement', entityId: mov.id,
      descripcion: `Caja socios: ${mov.type} ${mov.amount} de ${socio.nombre}.`, after: { type: mov.type, amount: mov.amount, category: mov.category, fecha },
    }).catch(() => undefined)
  }
  return mov
}
