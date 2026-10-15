// ============================================================
// DESGLOSE DE CAPITAL Y RETIROS DE UNA RUTA (C2, puro)
// ------------------------------------------------------------
// `getCashboxSummary` suma en "Ingreso capital" y "Retiros" registros de naturaleza
// distinta desde el capital centralizado. Este desglose los separa por su operación
// (`centralLink`) con el MISMO filtro de fechas, de modo que:
//
//   Σ capital = ingresoCapital      Σ retiros = retiros      (del mismo periodo)
//
// No es otra fórmula ni otra caja: solo explica los totales que ya existen. Un
// retorno de cuadre no se presenta como un retiro voluntario.
// ============================================================
import type { CapitalMovement, CentralCapitalKind, Withdrawal } from '@/models/types'

export interface CapitalFlowBreakdown {
  capital: {
    /** Capital a la caja de la ruta (modelo v16) y su anulación. */
    aCajaDeRuta: number
    entregasATrabajadores: number
    desembolsosDelAdministrador: number
    gastosDeRutaConBolsa: number
  }
  retiros: {
    /** Retiro desde la caja de la ruta (v16 o vaciado del saldo heredado). */
    retirosDeCaja: number
    devolucionesDeTrabajadores: number
    retornosDeCuadre: number
    cobrosNoEnEfectivo: number
  }
  /** Hay registros del modelo centralizado en el periodo. */
  hayCentralizados: boolean
}

const enRango = (fecha: string, desde: string, hasta: string) => fecha >= desde && fecha <= hasta

function claseCapital(k: CentralCapitalKind | undefined): keyof CapitalFlowBreakdown['capital'] {
  if (k === 'ENTREGA_TRABAJADOR' || k === 'ANULACION_ENTREGA') return 'entregasATrabajadores'
  if (k === 'DESEMBOLSO_ADMIN') return 'desembolsosDelAdministrador'
  if (k === 'GASTO_RUTA') return 'gastosDeRutaConBolsa'
  return 'aCajaDeRuta'
}

function claseRetiro(k: CentralCapitalKind | undefined): keyof CapitalFlowBreakdown['retiros'] {
  if (k === 'DEVOLUCION_TRABAJADOR') return 'devolucionesDeTrabajadores'
  if (k === 'CUADRE' || k === 'REAPERTURA_CUADRE') return 'retornosDeCuadre'
  if (k === 'COBRO_NO_PERSONAL' || k === 'ANULACION_COBRO') return 'cobrosNoEnEfectivo'
  return 'retirosDeCaja'
}

export function capitalFlowBreakdown(
  capital: Pick<CapitalMovement, 'valor' | 'fecha' | 'centralLink'>[],
  retiros: Pick<Withdrawal, 'valor' | 'fecha' | 'centralLink'>[],
  desde: string,
  hasta: string,
): CapitalFlowBreakdown {
  const out: CapitalFlowBreakdown = {
    capital: { aCajaDeRuta: 0, entregasATrabajadores: 0, desembolsosDelAdministrador: 0, gastosDeRutaConBolsa: 0 },
    retiros: { retirosDeCaja: 0, devolucionesDeTrabajadores: 0, retornosDeCuadre: 0, cobrosNoEnEfectivo: 0 },
    hayCentralizados: false,
  }
  for (const m of capital) {
    if (!enRango(m.fecha, desde, hasta)) continue
    out.capital[claseCapital(m.centralLink?.kind)] += m.valor
    if (m.centralLink) out.hayCentralizados = true
  }
  for (const w of retiros) {
    if (!enRango(w.fecha, desde, hasta)) continue
    out.retiros[claseRetiro(w.centralLink?.kind)] += w.valor
    if (w.centralLink) out.hayCentralizados = true
  }
  return out
}

export const CAPITAL_FLOW_LABELS = {
  capital: {
    aCajaDeRuta: 'Capital a la caja de la ruta',
    entregasATrabajadores: 'Capital entregado a trabajadores',
    desembolsosDelAdministrador: 'Préstamos del Administrador (con su bolsa)',
    gastosDeRutaConBolsa: 'Gastos de ruta pagados con la bolsa',
  },
  retiros: {
    retirosDeCaja: 'Retiros de la caja de la ruta',
    devolucionesDeTrabajadores: 'Devoluciones de trabajadores a la bolsa',
    retornosDeCuadre: 'Efectivo de cuadres devuelto a la bolsa',
    cobrosNoEnEfectivo: 'Cobros no en efectivo enviados a la bolsa',
  },
} as const
