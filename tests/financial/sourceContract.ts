// ============================================================
// CONTRATO DE FIDELIDAD CON EL CÓDIGO FUENTE — SOLO TEST (lectura, nunca escritura)
// ------------------------------------------------------------
// Lee los archivos REALES de producción y comprueba dos cosas:
//   1) que las transcripciones de `flows.ts` siguen siendo fieles (si producción
//      cambia, la suite lo denuncia en vez de mentir);
//   2) hechos ESTRUCTURALES verificables sin ejecutar nada — en particular que las
//      escrituras del pago NO están dentro de `db.transaction(...)` (RC-BUG-002),
//      que el flujo Admin no valida el desembolso (RC-BUG-003) y que ninguno topa
//      el importe al saldo (RC-BUG-001).
// ============================================================
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export const SRC = {
  activeSales: 'src/pages/admin/ActiveSalesPage.tsx',
  paymentPage: 'src/pages/collector/PaymentPage.tsx',
  paymentService: 'src/services/paymentService.ts',
  reconciliation: 'src/services/financialReconciliation.ts',
  cashbox: 'src/services/cashboxEngine.ts',
  correction: 'src/services/paymentCorrectionService.ts',
  app: 'src/app/App.tsx',
  engine: 'src/services/installmentEngine.ts',
} as const

export function readSource(rel: string): string {
  const p = resolve(process.cwd(), rel)
  if (!existsSync(p)) {
    throw new Error(
      `No se encuentra ${rel} (cwd=${process.cwd()}). Ejecuta la suite desde la raíz del proyecto.`,
    )
  }
  return readFileSync(p, 'utf8')
}

/**
 * Extrae el cuerpo de una función por su cabecera, emparejando llaves.
 *
 * Salta la lista de parámetros (emparejando paréntesis) y luego la anotación de
 * tipo de retorno: el `{` del cuerpo es el primero que aparece con profundidad de
 * ángulos `<>` igual a 0. Sin esto, una firma como
 * `): Promise<{ reversalId: string }> {` haría que se tomara el objeto del tipo
 * de retorno como si fuera el cuerpo.
 */
export function extractFunctionBody(source: string, header: string): string {
  const start = source.indexOf(header)
  if (start === -1) throw new Error(`No se encontró la cabecera: ${header}`)

  // 1) Emparejar la lista de parámetros.
  let i = source.indexOf('(', start)
  if (i === -1) throw new Error(`No se encontró la lista de parámetros de: ${header}`)
  let paren = 0
  for (; i < source.length; i++) {
    if (source[i] === '(') paren++
    else if (source[i] === ')') {
      paren--
      if (paren === 0) { i++; break }
    }
  }

  // 2) Saltar la anotación de tipo de retorno (genéricos incluidos).
  let angle = 0
  let bodyStart = -1
  for (; i < source.length; i++) {
    const c = source[i]
    if (c === '=' && source[i + 1] === '>') { i++; continue } // arrow, no es cierre de genérico
    if (c === '<') angle++
    else if (c === '>') { if (angle > 0) angle-- }
    else if (c === '{' && angle === 0) { bodyStart = i; break }
  }
  if (bodyStart === -1) throw new Error(`No se encontró el cuerpo de: ${header}`)

  // 3) Emparejar las llaves del cuerpo.
  let depth = 0
  for (i = bodyStart; i < source.length; i++) {
    const c = source[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return source.slice(bodyStart, i + 1)
    }
  }
  throw new Error(`Llaves desbalanceadas en: ${header}`)
}

/** Normaliza espacios para comparar líneas de forma robusta. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

export function containsLine(body: string, line: string): boolean {
  return norm(body).includes(norm(line))
}

// ------------------------------------------------------------
// Cuerpos de producción (cacheados)
// ------------------------------------------------------------
let _adminBody: string | null = null
let _opBody: string | null = null
let _serviceBody: string | null = null

export function adminHandlerBody(): string {
  if (_adminBody === null) {
    _adminBody = extractFunctionBody(readSource(SRC.activeSales), 'async function handleQuickPayment()')
  }
  return _adminBody
}

export function operationalHandlerBody(): string {
  if (_opBody === null) {
    _opBody = extractFunctionBody(readSource(SRC.paymentPage), 'async function handlePay()')
  }
  return _opBody
}

/** Cuerpo de `registerPayment`: donde deben vivir TODAS las reglas financieras. */
export function paymentServiceBody(): string {
  if (_serviceBody === null) {
    _serviceBody = extractFunctionBody(readSource(SRC.paymentService), 'export async function registerPayment(')
  }
  return _serviceBody
}

/** ¿El cuerpo delega el registro del pago en el servicio central? */
export function delegatesToPaymentService(body: string): boolean {
  return /registerPayment\s*\(/.test(body)
}

/**
 * Cuerpo del callback de la PRIMERA `db.transaction(...)` encontrada.
 * Sirve para comprobar qué escrituras quedan realmente dentro del ámbito atómico.
 */
export function extractTransactionScope(body: string): string {
  const at = body.search(/\b(?:db|database)\.transaction\s*\(/)
  if (at === -1) throw new Error('No se encontró ninguna db.transaction(...) en el cuerpo')
  const arrow = body.indexOf('=>', at)
  if (arrow === -1) throw new Error('No se encontró el callback de la transacción')
  let i = body.indexOf('{', arrow)
  if (i === -1) throw new Error('No se encontró el cuerpo del callback')
  let depth = 0
  const from = i
  for (; i < body.length; i++) {
    if (body[i] === '{') depth++
    else if (body[i] === '}') {
      depth--
      if (depth === 0) return body.slice(from, i + 1)
    }
  }
  throw new Error('Llaves desbalanceadas en el callback de la transacción')
}

/**
 * ¿`executeCorrection` recomputa la venta DENTRO de su transacción?
 * Antes `recomputeSale()` corría fuera y podía dejar pagos corregidos con parcelas
 * y saldo antiguos si fallaba.
 */
export function correctionRecomputesInsideTransaction(): boolean {
  const body = extractFunctionBody(readSource(SRC.correction), 'async function executeCorrection(')
  const scope = extractTransactionScope(body)
  return /recomputeSale\s*\(/.test(scope)
}

/**
 * ¿El cuerpo abre una transacción Dexie? Se busca `db.transaction(` de forma
 * literal; es la única forma que usa el proyecto (verificado en seed.ts,
 * saleRequestService.ts, routeService.ts y paymentCorrectionService.ts).
 */
export function opensDexieTransaction(body: string): boolean {
  return /\b(?:db|database)\.transaction\s*\(/.test(body)
}

/** Escrituras detectadas en un cuerpo, en orden de aparición. */
export function writeSequence(body: string): string[] {
  const re = /\b(?:db|database)\.(payments|installments|sales)\.(add|update|bulkAdd|put|delete)\s*\(/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) out.push(`${m[1]}.${m[2]}`)
  return out
}

/** ¿El cuerpo limita el importe al saldo pendiente de alguna forma reconocible? */
export function capsAmountToBalance(body: string): boolean {
  return /Math\.min\s*\([^)]*(saldo|Balance)/i.test(body) || /valorPagoEfectivo/.test(body)
}

/** ¿El cuerpo valida el estado de desembolso de la venta? */
export function validatesDisbursement(body: string): boolean {
  return /disbursementStatus/.test(body)
}

/** ¿El cuerpo valida que la venta esté activa? */
export function validatesSaleStatus(body: string): boolean {
  return /\.status\s*(===|!==)\s*'(activa|finalizada|perdida)'/.test(body)
}

/** ¿El cuerpo verifica la capacidad `payment.register`? */
export function checksPaymentCapability(body: string): boolean {
  return /can\s*\([^)]*payment\.register/.test(body) || /assertCan\s*\([^)]*payment\.register/.test(body)
}

/** ¿El cuerpo relee las parcelas desde la BD antes de aplicar? */
export function refetchesInstallments(body: string): boolean {
  return /\b(?:db|database)\.installments\.where\s*\(\s*'saleId'\s*\)/.test(body)
}

/**
 * Comprueba que Cobrador y Supervisor montan el MISMO componente de pago.
 * En App.tsx, `operationalRoutes()` declara <PaymentPage /> una sola vez y se
 * invoca bajo /supervisor y bajo /collector.
 */
export function supervisorSharesPaymentComponent(): { shares: boolean; mounts: number; declarations: number } {
  const app = readSource(SRC.app)
  const mounts = (app.match(/\{operationalRoutes\(\)\}/g) ?? []).length
  const declarations = (app.match(/element=\{<PaymentPage \/>\}/g) ?? []).length
  return { shares: mounts === 2 && declarations === 1, mounts, declarations }
}

/**
 * Operaciones de ESCRITURA sobre Dexie encontradas en un archivo. Se usa para
 * garantizar que el módulo de conciliación es estrictamente de solo lectura.
 */
export function dexieWriteOperations(source: string): string[] {
  const re = /\b(?:db|database)\.[A-Za-z]+\.(add|put|update|delete|clear|bulkAdd|bulkPut|bulkDelete)\s*\(/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) out.push(m[0].replace(/\s*\($/, ''))
  return out
}

/** ¿El servicio de pagos audita FUERA de la transacción financiera? */
export function auditsOutsideTransaction(): boolean {
  const body = paymentServiceBody()
  const scope = extractTransactionScope(body)
  const auditInScope = /auditSink\s*\(/.test(scope)
  const auditInBody = /auditSink\s*\(/.test(body)
  return auditInBody && !auditInScope
}

/** ¿`cashboxEngine` suma `payments.valor` sin tope ni filtro de estado? */
export function cashboxSumsRawPaymentValor(): boolean {
  const src = readSource(SRC.cashbox)
  const body = extractFunctionBody(src, 'export async function getCashboxSummary(')
  const sumsRaw = /\.reduce\(\(sum, p\) => sum \+ p\.valor, 0\)/.test(body)
  const filtersState = /p\.state/.test(body)
  return sumsRaw && !filtersState
}
