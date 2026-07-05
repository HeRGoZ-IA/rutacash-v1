// ============================================================
// Caja socios (Revisión 2 socio 30-jun)
// Módulo SEPARADO de la caja de rutas. Registra el dinero asociado a cada
// socio (usuario con rol 'socio'). Se alimenta de movimientos creados
// directamente aquí y de movimientos generados por Transferencias.
// ============================================================
import { db } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { nowISO } from '@/lib/formatters'
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

export interface CreatePartnerMovementInput {
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

/** Crea (persiste) un movimiento de Caja socios. */
export async function createPartnerMovement(input: CreatePartnerMovementInput): Promise<PartnerCashMovement> {
  const mov: PartnerCashMovement = {
    id: generateId(),
    tenantId: input.tenantId,
    partnerId: input.partnerId,
    type: input.type,
    category: input.category,
    amount: input.amount,
    description: input.description,
    relatedTransferId: input.relatedTransferId,
    fecha: input.fecha,
    createdAt: nowISO(),
    createdBy: input.createdBy,
  }
  await db.partnerCashMovements.add(mov)
  return mov
}
