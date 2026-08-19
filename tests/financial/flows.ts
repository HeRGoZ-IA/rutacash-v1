// ============================================================
// ADAPTADORES DE INTERFAZ — SOLO TEST
// ------------------------------------------------------------
// Tras centralizar los pagos, estos adaptadores YA NO transcriben lógica: ejecutan
// el servicio de producción `registerPayment` con exactamente los mismos argumentos
// que pasa cada pantalla real, sobre la base en memoria del harness.
//
//   Admin      → ActiveSalesPage.handleQuickPayment  → registerPayment({saleId, requestedAmount, actor})
//   Operativo  → PaymentPage.handlePay               → registerPayment({..., observacion, lat, lng, syncStatus})
//
// La única diferencia entre ambos es metadato NO financiero (observación,
// geolocalización y estado de sincronización). Toda la regla de dinero vive en el
// servicio, así que la paridad es estructural, no una coincidencia.
//
// `sourceContract.ts` verifica en cada ejecución que las pantallas reales sigan
// llamando al servicio y no hayan reintroducido escrituras propias.
// ============================================================
import { registerPayment, type PaymentDatabase, type PaymentRejectionCode, type RegisterPaymentSuccess } from '@/services/paymentService'
import type { Installment, Sale, User } from '@/models/types'
import type { MemoryDb } from './harness'

export interface FlowOutcome {
  /** true si el pago se registró. */
  ok: boolean
  /** Código de rechazo del dominio (si lo hubo). */
  rejected?: PaymentRejectionCode
  /** Mensaje que mostraría la UI. */
  message: string
  /** Detalle financiero devuelto por el servicio. */
  result?: RegisterPaymentSuccess
}

const asDb = (db: MemoryDb) => db as unknown as PaymentDatabase

// ============================================================
// FLUJO A — ADMINISTRADOR / SUPER ADMIN
// Origen: src/pages/admin/ActiveSalesPage.tsx · handleQuickPayment()
// ============================================================
export async function adminQuickPaymentFlow(
  db: MemoryDb,
  ctx: { paymentValor: number; paymentSale: Sale | null; user: User | null },
): Promise<FlowOutcome> {
  // --- verbatim del componente: if (!paymentSale) return
  if (!ctx.paymentSale) return { ok: false, rejected: 'SALE_NOT_FOUND', message: 'sin venta seleccionada' }

  // --- verbatim: la pantalla solo entrega el id de la venta y el importe escrito.
  //     NO envía saldo, ni parcelas, ni estado: el servicio los relee de la base.
  const result = await registerPayment({
    saleId: ctx.paymentSale.id,
    requestedAmount: ctx.paymentValor,
    actor: ctx.user,
  }, asDb(db))

  if (!result.ok) return { ok: false, rejected: result.code, message: result.message }
  return {
    ok: true,
    message: result.capped ? 'El pago se limitó al saldo pendiente' : 'Pago registrado correctamente',
    result,
  }
}

// ============================================================
// FLUJO B — COBRADOR Y SUPERVISOR (mismo componente, misma función)
// Origen: src/pages/collector/PaymentPage.tsx · handlePay()
// App.tsx monta operationalRoutes() bajo /collector y /supervisor con el MISMO
// <PaymentPage />; `useOpBase` solo resuelve el prefijo de navegación.
// ============================================================
export async function operationalPaymentFlow(
  db: MemoryDb,
  ctx: {
    valor: number
    sale: Sale | null
    user: User | null
    /** Estado React de la pantalla. Se acepta para poder probar que el servicio lo IGNORA. */
    installments?: Installment[]
    observacion?: string
    online?: boolean
  },
): Promise<FlowOutcome> {
  // --- verbatim del componente: if (!sale) return
  if (!ctx.sale) return { ok: false, rejected: 'SALE_NOT_FOUND', message: 'sin venta cargada' }

  // --- verbatim: `installments` del estado React NO se pasa al servicio.
  //     Es exclusivamente presentación (número de parcela, montos rápidos).
  void ctx.installments

  const result = await registerPayment({
    saleId: ctx.sale.id,
    requestedAmount: ctx.valor,
    actor: ctx.user,
    observacion: ctx.observacion,
    syncStatus: (ctx.online ?? true) ? 'synced' : 'pending',
  }, asDb(db))

  if (!result.ok) return { ok: false, rejected: result.code, message: result.message }
  return {
    ok: true,
    message: result.capped ? 'Abono limitado al saldo pendiente' : '¡Abono registrado!',
    result,
  }
}

export const FLOWS = [
  { id: 'ADMIN', label: 'Administrador / Super Admin', run: adminQuickPaymentFlow },
  { id: 'OPERATIVO', label: 'Cobrador / Supervisor', run: operationalPaymentFlow },
] as const
