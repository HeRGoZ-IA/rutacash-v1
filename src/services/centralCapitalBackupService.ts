// ============================================================
// CAPITAL CENTRALIZADO (C2) — RESPALDO VERIFICABLE PREVIO A LA ACTIVACIÓN
// ------------------------------------------------------------
// Antes de activar el modelo en un navegador con datos, el SuperAdmin exporta un
// respaldo de SU empresa y lo vuelve a cargar para comprobarlo. Todo ocurre en el
// navegador: nada se envía a ningún servidor.
//
//   buildCentralCapitalBackup   arma el archivo (todas las tablas de la empresa,
//                               contraseñas excluidas) y guarda su recibo en la empresa
//   verifyCentralCapitalBackup  relee el archivo: formato, empresa, huella de
//                               integridad y que los datos financieros NO cambiaron
//   centralCapitalBackupStatus  ¿hay respaldo verificado y vigente? (lo exige la activación)
//
// Huellas SHA-256 sobre una serialización canónica (claves ordenadas, filas por id):
//   · integridad       → todo el contenido exportado; detecta un archivo alterado.
//   · huellaFinanciera → tablas financieras; si cambia, hubo movimientos después del
//                        respaldo y hay que exportar otro antes de activar.
// ============================================================
import { db, type RutaCashDB } from '@/lib/db'
import { nowISO } from '@/lib/formatters'
import { can } from '@/lib/permissions'
import { AuthzError } from '@/services/authz'
import { logAction } from '@/services/auditService'
import type { CentralCapitalBackupReceipt, Tenant, User } from '@/models/types'

export const BACKUP_FORMAT = 'adex-respaldo-capital-centralizado-v1'

/** Tablas con `tenantId` que forman el respaldo (las cuotas van por sus ventas). */
const TABLAS_EMPRESA = [
  'offices', 'routes', 'users', 'clients', 'sales', 'payments', 'noPaymentVisits', 'expenseCategories', 'expenses',
  'capitalMovements', 'transfers', 'withdrawals', 'cashboxMovements', 'weeklySettlements', 'auditLogs', 'saleRequests',
  'partnerCashMovements', 'paymentAdjustmentRequests', 'cashSettlements', 'cashCustodyMovements', 'capitalLedger',
  'routeCapitalControllerEvents',
] as const

/** Tablas cuya modificación invalida el respaldo para activar (dinero, cuadres, responsables). */
export const TABLAS_FINANCIERAS = [
  'routes', 'sales', 'installments', 'payments', 'expenses', 'capitalMovements', 'transfers', 'withdrawals',
  'weeklySettlements', 'saleRequests', 'partnerCashMovements', 'paymentAdjustmentRequests', 'cashSettlements',
  'cashCustodyMovements', 'capitalLedger', 'routeCapitalControllerEvents',
] as const

/** Campos de la empresa que no forman parte del respaldo (el propio recibo y la activación). */
const CAMPOS_EMPRESA_EXCLUIDOS = ['centralCapitalBackup', 'centralCapitalRouteBlocks', 'centralCapitalStartAt', 'centralCapitalHeritage'] as const

export class CentralCapitalBackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CentralCapitalBackupError'
  }
}

export interface CentralCapitalBackupFile {
  formato: typeof BACKUP_FORMAT
  tenantId: string
  empresa: string
  exportedAt: string
  exportedBy: string
  dexieVersion: number
  integridad: string
  huellaFinanciera: string
  conteos: Record<string, number>
  tablas: Record<string, unknown[]>
}

// ------------------------------------------------------------
// Serialización canónica y huellas
// ------------------------------------------------------------
function canonico(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonico).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonico(o[k])}`).join(',')}}`
}

async function sha256(texto: string): Promise<string> {
  const bytes = new TextEncoder().encode(texto)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

const ordenar = (rows: unknown[]) => [...rows].sort((a, b) =>
  String((a as { id?: unknown }).id ?? '').localeCompare(String((b as { id?: unknown }).id ?? '')))

async function huellaDe(tablas: Record<string, unknown[]>, nombres: readonly string[]): Promise<string> {
  return sha256(canonico(Object.fromEntries(nombres.map(n => [n, ordenar(tablas[n] ?? [])]))))
}

/** Lee las tablas de la empresa (contraseñas excluidas). */
async function leerEmpresa(tenantId: string, database: RutaCashDB): Promise<{ tenant: Tenant; tablas: Record<string, unknown[]> }> {
  const tenant = await database.tenants.get(tenantId)
  if (!tenant) throw new CentralCapitalBackupError('La empresa no existe.')
  const tablas: Record<string, unknown[]> = {}
  for (const nombre of TABLAS_EMPRESA) {
    const t = (database as unknown as Record<string, { where(i: string): { equals(v: string): { toArray(): Promise<unknown[]> } } }>)[nombre]
    tablas[nombre] = ordenar(await t.where('tenantId').equals(tenantId).toArray())
  }
  tablas.users = (tablas.users as User[]).map(u => ({ ...u, password: undefined }))
  const saleIds = (tablas.sales as { id: string }[]).map(s => s.id)
  tablas.installments = ordenar(saleIds.length ? await database.installments.where('saleId').anyOf(saleIds).toArray() : [])
  const empresa: Record<string, unknown> = { ...tenant }
  for (const k of CAMPOS_EMPRESA_EXCLUIDOS) delete empresa[k]
  tablas.tenants = [empresa]
  return { tenant, tablas }
}

/** Huella financiera ACTUAL de la empresa (para saber si hubo movimientos). */
export async function currentFinancialFingerprint(tenantId: string, database: RutaCashDB = db): Promise<string> {
  const { tablas } = await leerEmpresa(tenantId, database)
  return huellaDe(tablas, TABLAS_FINANCIERAS)
}

function exigirSuperAdmin(actor: User | null | undefined, tenantId: string): User {
  if (!actor) throw new AuthzError('Acción no autorizada: falta el usuario.')
  if (actor.tenantId !== tenantId || !can(actor, 'capital.allocateAdmins', { tenantId })) {
    throw new AuthzError('Solo el SuperAdmin de la empresa prepara la activación del capital centralizado.')
  }
  return actor
}

// ------------------------------------------------------------
// Exportación
// ------------------------------------------------------------
/**
 * Arma el respaldo de la empresa y guarda su recibo (sin verificar). La descarga la
 * hace la pantalla con el texto devuelto; el archivo no sale del navegador.
 */
export async function buildCentralCapitalBackup(
  params: { actor: User | null | undefined; tenantId: string },
  database: RutaCashDB = db,
): Promise<{ file: CentralCapitalBackupFile; text: string; receipt: CentralCapitalBackupReceipt }> {
  const actor = exigirSuperAdmin(params.actor, params.tenantId)
  const { tenant, tablas } = await leerEmpresa(params.tenantId, database)
  if (tenant.centralCapitalStartAt) throw new CentralCapitalBackupError('El capital centralizado ya está activo en esta empresa.')
  const exportedAt = nowISO()
  const conteos = Object.fromEntries(Object.entries(tablas).map(([k, v]) => [k, v.length]))
  const integridad = await huellaDe(tablas, Object.keys(tablas).sort())
  const huellaFinanciera = await huellaDe(tablas, TABLAS_FINANCIERAS)
  const file: CentralCapitalBackupFile = {
    formato: BACKUP_FORMAT, tenantId: params.tenantId, empresa: tenant.nombre, exportedAt, exportedBy: actor.id,
    dexieVersion: database.verno, integridad, huellaFinanciera, conteos, tablas,
  }
  const receipt: CentralCapitalBackupReceipt = { integridad, huellaFinanciera, exportedAt, exportedByUserId: actor.id, conteos }
  await database.tenants.update(params.tenantId, { centralCapitalBackup: receipt })
  await logAction({
    tenantId: params.tenantId, userId: actor.id, userRole: actor.rol, action: 'CENTRAL_CAPITAL_BACKUP_EXPORTED',
    entityType: 'tenant', entityId: params.tenantId,
    descripcion: `Respaldo previo al capital centralizado exportado (${Object.values(conteos).reduce((s, n) => s + n, 0)} registros).`,
    metadata: { integridad, huellaFinanciera, conteos },
  }).catch(() => undefined)
  return { file, text: JSON.stringify(file), receipt }
}

// ------------------------------------------------------------
// Verificación
// ------------------------------------------------------------
export interface BackupVerification {
  ok: boolean
  problemas: string[]
  receipt?: CentralCapitalBackupReceipt
}

/**
 * Comprueba el archivo exportado. Solo lo marca verificado si: es de este formato y
 * de esta empresa; su contenido produce la huella declarada; coincide con el último
 * recibo; y los datos financieros actuales siguen siendo los del respaldo.
 */
export async function verifyCentralCapitalBackup(
  params: { actor: User | null | undefined; tenantId: string; text: string },
  database: RutaCashDB = db,
): Promise<BackupVerification> {
  const actor = exigirSuperAdmin(params.actor, params.tenantId)
  const problemas: string[] = []
  let file: CentralCapitalBackupFile | null = null
  try { file = JSON.parse(params.text) as CentralCapitalBackupFile } catch { problemas.push('El archivo no es un respaldo válido (JSON ilegible).') }
  const tenant = await database.tenants.get(params.tenantId)
  const recibo = tenant?.centralCapitalBackup
  if (file) {
    if (file.formato !== BACKUP_FORMAT) problemas.push('El archivo no es un respaldo del capital centralizado.')
    if (file.tenantId !== params.tenantId) problemas.push('El respaldo es de otra empresa.')
    if (!file.tablas || typeof file.tablas !== 'object') problemas.push('El respaldo no contiene tablas.')
    else {
      const integridad = await huellaDe(file.tablas, Object.keys(file.tablas).sort())
      if (integridad !== file.integridad) problemas.push('El contenido del archivo no coincide con su huella: el respaldo está alterado o incompleto.')
      const huella = await huellaDe(file.tablas, TABLAS_FINANCIERAS)
      if (huella !== file.huellaFinanciera) problemas.push('La huella financiera del archivo no coincide con su contenido.')
    }
    if (!recibo) problemas.push('No hay un respaldo exportado registrado en este navegador para la empresa.')
    else if (recibo.integridad !== file.integridad) problemas.push('Este archivo no es el último respaldo exportado: exporta y carga el más reciente.')
  }
  if (recibo && problemas.length === 0) {
    const actual = await currentFinancialFingerprint(params.tenantId, database)
    if (actual !== recibo.huellaFinanciera) problemas.push('Hubo movimientos financieros después del respaldo: exporta uno nuevo antes de activar.')
  }
  if (problemas.length > 0) return { ok: false, problemas }
  const verificado: CentralCapitalBackupReceipt = { ...recibo!, verifiedAt: nowISO(), verifiedByUserId: actor.id }
  await database.tenants.update(params.tenantId, { centralCapitalBackup: verificado })
  await logAction({
    tenantId: params.tenantId, userId: actor.id, userRole: actor.rol, action: 'CENTRAL_CAPITAL_BACKUP_VERIFIED',
    entityType: 'tenant', entityId: params.tenantId, descripcion: 'Respaldo previo al capital centralizado verificado.',
    metadata: { integridad: verificado.integridad, huellaFinanciera: verificado.huellaFinanciera },
  }).catch(() => undefined)
  return { ok: true, problemas: [], receipt: verificado }
}

export interface BackupStatus {
  /** Hay un respaldo verificado y los datos financieros no cambiaron desde entonces. */
  vigente: boolean
  receipt?: CentralCapitalBackupReceipt
  motivo?: string
}

/** ¿El respaldo permite activar ahora? (lo revalida la activación). */
export async function centralCapitalBackupStatus(tenantId: string, database: RutaCashDB = db): Promise<BackupStatus> {
  const receipt = (await database.tenants.get(tenantId))?.centralCapitalBackup
  if (!receipt) return { vigente: false, motivo: 'Falta exportar el respaldo de la empresa.' }
  if (!receipt.verifiedAt) return { vigente: false, receipt, motivo: 'El respaldo se exportó pero falta cargarlo para verificarlo.' }
  if (await currentFinancialFingerprint(tenantId, database) !== receipt.huellaFinanciera) {
    return { vigente: false, receipt, motivo: 'Hubo movimientos financieros después del respaldo: exporta y verifica uno nuevo.' }
  }
  return { vigente: true, receipt }
}
