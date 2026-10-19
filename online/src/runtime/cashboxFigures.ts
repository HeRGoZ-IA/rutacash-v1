// CAJA DE UNA RUTA (CLEAN `getCashboxSummary` con capital centralizado) desde las cifras
// del libro del servidor (`adex.route_period_figures`: liquidación de un rango y archivo
// de cada cierre). No es otra fórmula: es el MISMO desglose que CLEAN documenta en
// `lib/capitalFlowBreakdown.ts` para el modelo centralizado, con cada línea tomada del
// agregado del servidor que le corresponde:
//
//   (+) Ingreso de capital  = entregas a trabajadores + préstamos del Administrador con su
//                             bolsa + gastos de ruta pagados con la bolsa
//   (+) Cobros recibidos    = cobros en custodia + cobros no personales (a la bolsa)
//   (+/−) Transferencias    = traspasos y reasignaciones recibidos / entregados
//   (−) Préstamos           = desembolsos desde custodia + desde la bolsa
//   (−) Gastos              = gastos de trabajador + gastos de ruta con la bolsa
//   (−) Retiros y retornos  = devoluciones parciales + retornos de cuadre + cobros no personales
//
// Saldo anterior y saldo al cierre = custodia de la ruta (la «Base»: el efectivo de la
// ruta esté donde esté), así que apertura + entradas − salidas = cierre, como en CLEAN.

import type { CapitalFlowBreakdown } from '@clean/lib/capitalFlowBreakdown';
import type { CashboxSummary } from '@clean/models/types';
import { toMajor } from './mappers.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Figures = { custody?: Record<string, number>; pool?: Record<string, number> } & Record<string, any>;

const n = (o: Record<string, number> | undefined, k: string) => Number(o?.[k] ?? 0);

export function cashboxFromFigures(routeId: string, f: Figures): CashboxSummary {
  const c = f.custody;
  const p = f.pool;
  const poolLoans = n(p, 'disbursedFromPoolMinor');
  const poolExpenses = n(p, 'routeExpensesMinor');
  const poolCollections = n(p, 'collectionsReceivedMinor');
  return {
    routeId,
    saldoAnterior: toMajor(n(c, 'openingMinor')),
    ingresoCapital: toMajor(n(c, 'deliveriesMinor') + poolLoans + poolExpenses),
    cobros: toMajor(n(c, 'collectionsMinor') + poolCollections),
    transferenciasEntradas: toMajor(n(c, 'transfersInMinor')),
    prestamosEntregados: toMajor(n(c, 'disbursementsMinor') + poolLoans),
    gastos: toMajor(n(c, 'workerExpensesMinor') + poolExpenses),
    transferenciasSalidas: toMajor(n(c, 'transfersOutMinor')),
    retiros: toMajor(n(c, 'partialReturnsMinor') + n(c, 'settlementReturnsMinor') + poolCollections),
    // Movimientos sin clasificar de la custodia (el servidor no deja cerrar con ellos) entran
    // en el saldo final, que es SIEMPRE el del libro.
    saldoActual: toMajor(n(c, 'closingMinor')),
  };
}

export function flowFromFigures(f: Figures): CapitalFlowBreakdown {
  const c = f.custody;
  const p = f.pool;
  return {
    capital: {
      aCajaDeRuta: 0,
      entregasATrabajadores: toMajor(n(c, 'deliveriesMinor')),
      desembolsosDelAdministrador: toMajor(n(p, 'disbursedFromPoolMinor')),
      gastosDeRutaConBolsa: toMajor(n(p, 'routeExpensesMinor')),
    },
    retiros: {
      retirosDeCaja: 0,
      devolucionesDeTrabajadores: toMajor(n(c, 'partialReturnsMinor')),
      retornosDeCuadre: toMajor(n(c, 'settlementReturnsMinor')),
      cobrosNoEnEfectivo: toMajor(n(p, 'collectionsReceivedMinor')),
    },
    // ADEX Online opera siempre con capital centralizado.
    hayCentralizados: true,
  };
}
