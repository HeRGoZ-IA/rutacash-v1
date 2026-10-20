// PUENTE de `src/platform/localDatabases.ts` (CLEAN). En ADEX Online el plano de control no
// toca ninguna base del navegador: las operaciones las ejecuta el servidor Owner. Se exportan
// objetos vacíos con los mismos nombres; las operaciones del puente los ignoran.
import type { CompanyProvisioningDatabase, StatusChangeDatabase } from '@clean/platform/companyControlService'

export const provisioningDatabase = {} as CompanyProvisioningDatabase
export const statusDatabase = {} as StatusChangeDatabase
