// ============================================================
// RUTACASH — ÚNICO PUNTO DONDE EL PLANO DE CONTROL TOCA LA BASE LOCAL
// ------------------------------------------------------------
// Frontera de importación, y es deliberada: NINGUNA pantalla del portal Owner
// importa `@/lib/db`. Si lo hiciera tendría en la mano el objeto Dexie completo —con
// `clients`, `sales`, `payments`, `cashboxMovements`…— y la privacidad del cliente
// pasaría a depender de que nadie escribiera la línea equivocada.
//
// En su lugar, aquí se hace UNA conversión, a tipos que solo declaran las tablas
// imprescindibles. Lo que el Owner recibe no es "la base": es una superficie en la
// que las tablas operativas ni siquiera existen como propiedad.
//
// La prueba OWNER-PRIVACY-* comprueba exactamente esto leyendo los imports reales:
// `src/pages/owner/**` no puede importar `@/lib/db`, y este archivo es la única
// excepción autorizada junto con `controlPlane.ts`.
//
// Cuando exista backend compartido, este archivo desaparece: las implementaciones
// pasan a hablar con el servidor y nadie vuelve a convertir un objeto Dexie.
// ============================================================
import { db } from '@/lib/db'
import type { CompanyProvisioningDatabase, StatusChangeDatabase } from '@/platform/companyControlService'

/** Tablas mínimas del alta de empresa: tenants, users, expenseCategories, companyControl. */
export const provisioningDatabase = db as unknown as CompanyProvisioningDatabase

/** Tabla mínima del cambio de estado comercial: tenants. */
export const statusDatabase = db as unknown as StatusChangeDatabase
