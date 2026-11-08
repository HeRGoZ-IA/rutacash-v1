// Puente de ADEX Online · migración de rutas con historial (SaaS 0043 y 0044).
//
// Solo el SuperAdmin pone una ruta «en migración», la cancela o hace la CARGA FINAL desde Listos. El servidor comprueba
// todo (ruta activa, vacía, sin entrega pendiente, Base por Ruta; en la carga, los controles del reporte y el calendario
// de cada crédito) y bloquea en PostgreSQL cualquier escritura en la ruta mientras está en migración. Aquí solo se pide
// el dato, se muestra la vista previa y el resultado.
//
// Cierres diarios (0045): el archivo `.json` lo arma `saas/scripts/migracion/listos_a_adex.py` con los reportes de Listos
// de un día. Primero se ve la VISTA PREVIA (no guarda nada); «Guardar cierre» escribe todo o nada y la ruta SIGUE en
// migración. «Terminar migración» la deja en estado normal (después se abre la caja con una inyección de Base).
//
// Diferencias (0048, 3.27): un cierre que no cuadra en un crédito (saldo que sube, crédito que desaparece sin estar
// pagado, pagado que vuelve a estar activo) se carga igual y el crédito queda con una diferencia abierta, sin mover
// dinero. La vista previa lo avisa. «Diferencias por revisar (N)» la ven el SuperAdmin y el Administrador responsable
// de la ruta, que la corrigen con motivo. «Terminar migración» queda desactivado mientras haya diferencias abiertas.

import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowRightLeft, CheckCircle2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { toast } from '@/components/ui/Toast'
import { formatCurrency } from '@/lib/formatters'
import { useAuth } from '@/hooks/useAuth'
import type { Route } from '@/models/types'
import { OnlineCommandError, money, plain } from '../../../runtime/commands.ts'
import { api } from '../../../runtime/session.ts'

const MESSAGES: Record<string, string> = {
  ROUTE_MIGRATION_NOT_ALLOWED: 'La ruta debe estar activa, sin clientes, ventas ni movimientos, y sin una entrega pendiente.',
  ROUTE_MIGRATION_INVALID_DATA: 'Los datos del archivo no cuadran. Revise la vista previa.',
  BODY_TOO_LARGE: 'El archivo es demasiado grande.',
  PERMISSION_DENIED: 'Solo el SuperAdmin puede hacerlo.',
  CAPITAL_AUTHORITY_REQUIRED: 'Solo el Administrador responsable de la ruta o el SuperAdmin pueden corregir una diferencia.',
  INVALID_INPUT: 'Revise los datos.',
}

// ---------- 0048 · diferencias ----------
export interface MigrationDifference {
  id: string; code: string; clientName: string; kind: 'balance_up' | 'missing' | 'reappeared'; status: 'abierta' | 'resuelta'
  adexBalanceMinor: number; currentStatus: string; currentBalanceMinor: number
  sourceStatus: 'active' | 'missing' | 'paid'; sourceBalanceMinor: number | null
  detectedReportDate: string; sourceReportDate: string; action: string | null; reason: string | null
}

const KIND_TEXT: Record<string, string> = {
  balance_up: 'El saldo subió en el sistema anterior',
  missing: 'Desapareció del sistema anterior sin estar pagado',
  reappeared: 'Estaba pagado y volvió a estar activo',
}

export const DIFFERENCE_OPTIONS: Record<string, { action: string; label: string; help: string }[]> = {
  balance_up: [
    { action: 'accept_source', label: 'Aceptar el saldo del sistema anterior',
      help: 'Se anulan abonos previos a la migración por el importe exacto. Si no alcanzan, el resto sube como ajuste de interés.' },
    { action: 'keep_adex', label: 'Mantener el saldo de ADEX', help: 'No cambia nada: ADEX estaba bien.' },
  ],
  missing: [
    { action: 'paid', label: 'Fue pagado', help: 'Se registra un abono previo a la migración por el resto y el crédito queda pagado.' },
    { action: 'void', label: 'Nunca debió existir (anular)', help: 'La venta sale de la cartera y el capital pendiente vuelve a la financiación de la ruta.' },
    { action: 'still_active', label: 'Sigue activo', help: 'No cambia nada; el crédito se cobra en ADEX.' },
  ],
  reappeared: [
    { action: 'reopen', label: 'Reabrir con el saldo del sistema anterior', help: 'Se anula el abono final y el crédito vuelve a estar activo con ese saldo.' },
    { action: 'keep_paid', label: 'Mantener pagado', help: 'No cambia nada.' },
  ],
}

type Preview = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0))
const brl = (minor: unknown) => formatCurrency(num(minor) / 100, 'BRL')
const adexValue = (d: MigrationDifference) => (d.currentStatus === 'activa' ? brl(d.currentBalanceMinor) : 'Pagado')
const sourceValue = (d: Pick<MigrationDifference, 'sourceStatus' | 'sourceBalanceMinor'>) =>
  d.sourceStatus === 'active' ? brl(d.sourceBalanceMinor) : d.sourceStatus === 'paid' ? 'Pagado' : 'No aparece'
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// `inUse`: la ruta ya tiene Base, cartera, ventas o clientes activos. Solo se ofrece «Poner en migración» en rutas
// nuevas y vacías (pedido de Helmer, 2026-11-04); el servidor lo rechaza igual (AX444) si queda algún dato.
export function RouteMigrationAction({ route, isSuperadmin, inUse = true }: { route: Route; isSuperadmin: boolean; inUse?: boolean }) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [operationId, setOperationId] = useState('')
  const [loadOpen, setLoadOpen] = useState(false)
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null)
  const [fileName, setFileName] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [closeOpen, setCloseOpen] = useState(false)
  const [loads, setLoads] = useState<{ reportDate: string; summary: Preview }[]>([])
  const [diffs, setDiffs] = useState<MigrationDifference[]>([])
  const [diffsOpen, setDiffsOpen] = useState(false)
  const [fixing, setFixing] = useState<MigrationDifference | null>(null)
  const [fixAction, setFixAction] = useState('')
  const [reload, setReload] = useState(0)
  const inMigration = route.migrationState === 'en_migracion'
  // Corrigen una diferencia: el SuperAdmin o el Administrador responsable de la ruta (decisión de Helmer, 2026-11-05).
  const canResolve = isSuperadmin || (user?.rol === 'admin' && !!user.id && route.capitalControllerAdminId === user.id)
  // Cierres ya cargados (para la fecha del último y para permitir terminar) y diferencias.
  useEffect(() => {
    if (!canResolve || !inMigration) return
    let alive = true
    api().get<{ migrations: { status: string; loads?: { reportDate: string; summary: Preview }[]; differences?: MigrationDifference[] }[] }>(
      `/v1/route-migrations?routeId=${encodeURIComponent(route.id)}`)
      .then((r) => {
        if (!alive) return
        const m = r.migrations.find((x) => x.status === 'en_migracion')
        setLoads(m?.loads ?? [])
        setDiffs(m?.differences ?? [])
      })
      .catch(() => { if (alive) { setLoads([]); setDiffs([]) } })
    return () => { alive = false }
  }, [canResolve, inMigration, route.id, reload])
  if (!canResolve) return null
  if (!inMigration && (!isSuperadmin || route.status !== 'activa' || inUse)) return null
  const openDiffs = diffs.filter((d) => d.status === 'abierta')

  const fail = (e: unknown) => {
    const code = e instanceof OnlineCommandError ? e.code : ''
    toast.error(MESSAGES[code] ?? (e instanceof Error ? e.message : 'No se pudo completar.'))
  }

  const start = () => { setText(inMigration ? '' : route.nombre); setOperationId(crypto.randomUUID()); setOpen(true) }
  const submit = async () => {
    const value = text.trim()
    if (inMigration ? value.length < 10 : value.length < 2) {
      toast.error(inMigration ? 'Escriba el motivo (mínimo 10 caracteres).' : 'Escriba el nombre de la ruta en el sistema anterior.')
      return
    }
    setSaving(true)
    try {
      if (inMigration) await money('POST', `/v1/routes/${route.id}/migration/cancel`, { reason: value }, operationId)
      else await money('POST', `/v1/routes/${route.id}/migration`, { sourceRouteName: value }, operationId)
      toast.success(inMigration ? `${route.nombre}: migración cancelada.` : `${route.nombre} quedó «En migración».`)
      setOpen(false)
    } catch (e) {
      fail(e)
    } finally {
      setSaving(false)
    }
  }

  const startLoad = () => { setPayload(null); setPreview(null); setFileName(''); setOperationId(crypto.randomUUID()); setLoadOpen(true) }
  const pickFile = async (file: File | undefined) => {
    setPayload(null); setPreview(null)
    if (!file) return
    setFileName(file.name)
    let data: unknown
    try { data = JSON.parse(await file.text()) } catch { toast.error('El archivo no es un archivo de carga válido (.json).'); return }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) { toast.error('El archivo no es un archivo de carga válido.'); return }
    setSaving(true)
    try {
      const p = await plain<Preview>('POST', `/v1/routes/${route.id}/migration/preview`, { payload: data })
      setPayload(data as Record<string, unknown>)
      setPreview(p)
    } catch (e) {
      fail(e)
    } finally {
      setSaving(false)
    }
  }
  const confirmLoad = async () => {
    if (!payload || !preview || preview['valid'] !== true) return
    setSaving(true)
    try {
      await money('POST', `/v1/routes/${route.id}/migration/loads`, { payload }, operationId)
      toast.success(`${route.nombre}: cierre del ${String(preview['reportDate'])} cargado. La ruta sigue en migración.`)
      setLoadOpen(false)
      setReload((n) => n + 1)
    } catch (e) {
      fail(e)
    } finally {
      setSaving(false)
    }
  }

  const startClose = () => { setOperationId(crypto.randomUUID()); setCloseOpen(true) }
  const startFix = (d: MigrationDifference) => { setFixing(d); setFixAction(''); setText(''); setOperationId(crypto.randomUUID()) }
  const confirmFix = async () => {
    if (!fixing) return
    const reason = text.trim()
    if (!fixAction) { toast.error('Elija qué hacer con la diferencia.'); return }
    if (reason.length < 10) { toast.error('Escriba el motivo (mínimo 10 caracteres).'); return }
    setSaving(true)
    try {
      await money('POST', `/v1/routes/${route.id}/migration/differences/${fixing.id}/resolve`, { action: fixAction, reason }, operationId)
      toast.success(`Crédito ${fixing.code}: diferencia corregida.`)
      setFixing(null)
      setReload((n) => n + 1)
    } catch (e) {
      const code = e instanceof OnlineCommandError ? e.code : ''
      if (code === 'ROUTE_MIGRATION_NOT_ALLOWED') {
        toast.error('No se pudo aplicar esa opción (la diferencia ya estaba corregida o el sistema anterior ya no muestra ese crédito). Recargue y revise.')
        setReload((n) => n + 1)
      } else fail(e)
    } finally {
      setSaving(false)
    }
  }

  const confirmClose = async () => {
    setSaving(true)
    try {
      await money('POST', `/v1/routes/${route.id}/migration/close`, {}, operationId)
      toast.success(`${route.nombre} terminó la migración y quedó en estado normal. Falta abrir la caja: inyecte la Base contada.`)
      setCloseOpen(false)
    } catch (e) {
      const code = e instanceof OnlineCommandError ? e.code : ''
      if (code === 'ROUTE_MIGRATION_NOT_ALLOWED') {
        toast.error('No se puede terminar: hay diferencias por revisar o falta cargar un cierre.')
        setCloseOpen(false)
        setReload((n) => n + 1)
      } else fail(e)
    } finally {
      setSaving(false)
    }
  }
  const last = loads[0]
  const listos = (preview?.['listos'] ?? {}) as Record<string, unknown>
  const dups = Array.isArray(preview?.['duplicateDocuments']) ? (preview['duplicateDocuments'] as unknown[]).length : 0
  const previewDiffs = Array.isArray(preview?.['differences']) ? (preview['differences'] as MigrationDifference[]) : []
  const newDiffs = num(preview?.['newDifferences'])
  // 0050: caja de la ruta frente al cuadre del sistema anterior.
  const cash = (preview?.['cash'] ?? null) as Record<string, unknown> | null
  const lastCash = (last?.summary['cash'] ?? null) as Record<string, unknown> | null
  const cashOff = (k: Record<string, unknown> | null) => !!k && (num(k['differenceMinor']) !== 0
    || (k['collectionsDifferenceMinor'] != null && num(k['collectionsDifferenceMinor']) !== 0)
    || (k['disbursementsDifferenceMinor'] != null && num(k['disbursementsDifferenceMinor']) !== 0))

  return (
    <>
      {inMigration && last && (
        <p className="w-full text-xs text-gray-500" data-testid={`route-migration-last-${route.id}`}>
          Último cierre cargado: {last.reportDate} · {num(last.summary['activeCredits'])} créditos activos · saldo {brl(last.summary['balanceMinor'])}
          {lastCash && <> · Base {brl(lastCash['baseMinor'])}{cashOff(lastCash) ? ' · la caja no cuadra' : ''}</>}
        </p>
      )}
      {inMigration && openDiffs.length > 0 && (
        <Button variant="ghost" size="sm" onClick={() => setDiffsOpen(true)} icon={<AlertTriangle className="w-3.5 h-3.5 text-amber-500" />}
          className="text-amber-700" data-testid={`route-migration-diffs-${route.id}`}>
          Diferencias por revisar ({openDiffs.length})
        </Button>
      )}
      {inMigration && isSuperadmin && (
        <Button variant="ghost" size="sm" onClick={startLoad} icon={<Upload className="w-3.5 h-3.5" />} data-testid={`route-migration-load-${route.id}`}>
          Cargar cierre
        </Button>
      )}
      {inMigration && isSuperadmin && last && (
        <Button variant="ghost" size="sm" onClick={startClose} icon={<CheckCircle2 className="w-3.5 h-3.5" />} disabled={openDiffs.length > 0}
          title={openDiffs.length > 0 ? 'Resuelva las diferencias antes de terminar' : undefined} data-testid={`route-migration-close-${route.id}`}>
          Terminar migración
        </Button>
      )}
      {inMigration && isSuperadmin && last && openDiffs.length > 0 && (
        <p className="w-full text-xs text-amber-700" data-testid={`route-migration-close-blocked-${route.id}`}>
          «Terminar migración» está desactivado: hay {plural(openDiffs.length, 'diferencia', 'diferencias')} por revisar.
        </p>
      )}
      {isSuperadmin && !(inMigration && last) && (
        <Button variant="ghost" size="sm" onClick={start} icon={<ArrowRightLeft className="w-3.5 h-3.5" />} data-testid={`route-migration-action-${route.id}`}>
          {inMigration ? 'Cancelar migración' : 'Poner en migración'}
        </Button>
      )}
      <Modal open={open} onClose={() => !saving && setOpen(false)} title={inMigration ? 'Cancelar migración' : 'Poner la ruta en migración'}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>Volver</Button>
          <Button onClick={() => void submit()} loading={saving}>{inMigration ? 'Cancelar migración' : 'Poner en migración'}</Button></>}>
        <div className="space-y-3 text-sm text-gray-700">
          {inMigration ? (
            <p>La ruta <strong>{route.nombre}</strong> vuelve a su estado normal. Solo es posible mientras no se hayan cargado datos.</p>
          ) : (
            <>
              <p>La ruta <strong>{route.nombre}</strong> seguirá operando en el sistema anterior. En ADEX quedará <strong>solo de consulta</strong>:
                nadie podrá crear clientes, ventas, abonos, gastos ni mover la Base hasta terminar la migración.</p>
              <p>Debe ser una ruta nueva y vacía.</p>
            </>
          )}
          <Input label={inMigration ? 'Motivo' : 'Nombre de la ruta en el sistema anterior'} value={text} onChange={(e) => setText(e.target.value)}
            maxLength={inMigration ? 500 : 120} autoFocus />
        </div>
      </Modal>
      <Modal open={loadOpen} onClose={() => !saving && setLoadOpen(false)} title="Cargar cierre"
        footer={<><Button variant="secondary" onClick={() => setLoadOpen(false)} disabled={saving}>Volver</Button>
          <Button onClick={() => void confirmLoad()} loading={saving} disabled={!preview || preview['valid'] !== true}
            data-testid={`route-migration-confirm-${route.id}`}>Guardar cierre</Button></>}>
        <div className="space-y-3 text-sm text-gray-700">
          <p>Suba el archivo (<strong>.json</strong>) preparado con los reportes del sistema anterior del cierre de un día. Primero verá una
            vista previa; no se guarda nada hasta que pulse <strong>Guardar cierre</strong>.</p>
          {last && <p className="text-gray-500">Último cierre cargado: {last.reportDate}. El nuevo debe ser de una fecha posterior.</p>}
          <input type="file" accept=".json,application/json" disabled={saving} onChange={(e) => void pickFile(e.target.files?.[0])}
            className="block w-full text-sm" data-testid={`route-migration-file-${route.id}`} />
          {fileName && !preview && saving && <p className="text-gray-500">Revisando {fileName}…</p>}
          {preview && preview['valid'] !== true && (
            <div className="rounded-xl bg-red-50 p-3 text-red-700">
              <p className="font-semibold">El archivo no cuadra. No se puede cargar.</p>
              <p className="mt-1 break-words">{String(preview['problem'] ?? '')}</p>
            </div>
          )}
          {preview && preview['valid'] === true && (
            <div className="rounded-xl bg-gray-50 p-3 space-y-1" data-testid={`route-migration-preview-${route.id}`}>
              <p className="font-semibold text-gray-800">Vista previa · cierre del {String(preview['reportDate'])}</p>
              {newDiffs > 0 && (
                <div className="rounded-lg bg-amber-50 p-2 text-amber-800" data-testid={`route-migration-preview-diffs-${route.id}`}>
                  <p className="font-semibold">Este cierre tiene {plural(newDiffs, 'diferencia', 'diferencias')}. Se cargará igual y
                    {newDiffs === 1 ? ' quedará' : ' quedarán'} para revisar.</p>
                  <p className="mt-1">Esos créditos no cambian en ADEX hasta que se corrijan en «Diferencias por revisar».</p>
                  <ul className="mt-1 list-disc pl-5">
                    {previewDiffs.map((d) => (
                      <li key={d.id}>Crédito {d.code} ({d.clientName}): {KIND_TEXT[d.kind] ?? d.kind} · ADEX {adexValue(d)} · sistema anterior {sourceValue(d)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {preview['firstLoad'] !== true && (
                <p>Desde el cierre anterior: {num(preview['newCredits'])} créditos nuevos · {num(preview['creditsWithPayments'])} con abonos ·
                  {' '}{num(preview['creditsPaidOff'])} pagados · abonos durante la migración <strong>{brl(preview['collectedInListosMinor'])}</strong></p>
              )}
              {preview['firstLoad'] === true && (
                <p>Lo ya pagado de cada crédito (un abono previo a la migración por crédito): <strong>{brl(preview['paidBeforeMigrationMinor'])}</strong></p>
              )}
              {cash && (
                <div className={`rounded-lg p-2 ${cashOff(cash) ? 'bg-amber-50 text-amber-800' : 'bg-white text-gray-700'}`} data-testid={`route-migration-preview-cash-${route.id}`}>
                  <p className="font-semibold">Caja de la ruta</p>
                  <p>Sistema anterior al cierre: {brl(cash['sourceClosingMinor'])} · deuda con el socio: {brl(cash['partnerDebtMinor'])}
                    {num(cash['partnerCoverMinor']) > 0 && <> (este cierre: {brl(cash['partnerCoverMinor'])})</>}</p>
                  <p>Base en ADEX: <strong>{brl(cash['baseMinor'])}</strong> · esperada {brl(cash['expectedBaseMinor'])} · diferencia {brl(cash['differenceMinor'])}</p>
                  {preview['firstLoad'] !== true && (
                    <p>Cuadre de esos días: abonos {brl(cash['sourceCollectionsMinor'])} (ADEX {brl(cash['collectionsMinor'])}) · créditos entregados
                      {' '}{brl(cash['sourceDisbursementsMinor'])} (ADEX {brl(cash['disbursementsMinor'])}) · gastos {brl(cash['expensesMinor'])} · ingresos {brl(cash['incomeMinor'])}</p>
                  )}
                  {cashOff(cash) && <p className="font-semibold">La caja no coincide con el cuadre del sistema anterior: «Terminar migración» no se podrá usar
                    hasta que coincida.</p>}
                </div>
              )}
              <p>Clientes: <strong>{num(preview['clients'])}</strong> ({num(preview['activeClients'])} con crédito activo)</p>
              <p>Créditos activos: <strong>{num(preview['activeCredits'])}</strong> · saldo <strong>{brl(preview['balanceMinor'])}</strong></p>
              <p>Capital pendiente (Cartera activa): <strong>{brl(preview['principalMinor'])}</strong></p>
              <p>Créditos con cuotas vencidas: {num(preview['creditsOverdue'])}</p>
              <p>Créditos pagados (historial): {num(preview['paidCredits'])}</p>
              {dups > 0 && <p className="text-amber-700">Documentos ya usados en la empresa: {dups} (se cargan marcados, sin fusionar).</p>}
              {(listos['cajaMinor'] != null || listos['carteraMinor'] != null) && (
                <p className="text-gray-500">Sistema anterior ese día: caja {listos['cajaMinor'] != null ? brl(listos['cajaMinor']) : '—'} · cartera {listos['carteraMinor'] != null ? brl(listos['carteraMinor']) : '—'}</p>
              )}
              <p className="pt-1 text-gray-600">Al guardar, la ruta queda igual que en el sistema anterior ese día y <strong>sigue en migración</strong>
                (solo lectura). Cada venta queda por su valor registrado. En el primer cierre, lo ya pagado es un «Abono previo a la migración»; desde
                el segundo, los abonos («Abono durante la migración»), los créditos entregados, los gastos y los ingresos pasan por la Base de la ruta.
                Si la caja del sistema anterior es negativa, lo que falta lo puso el socio: queda como deuda con el Administrador responsable.</p>
            </div>
          )}
        </div>
      </Modal>
      <Modal open={closeOpen} onClose={() => !saving && setCloseOpen(false)} title="Terminar migración"
        footer={<><Button variant="secondary" onClick={() => setCloseOpen(false)} disabled={saving}>Volver</Button>
          <Button onClick={() => void confirmClose()} loading={saving} data-testid={`route-migration-close-confirm-${route.id}`}>Terminar migración</Button></>}>
        <div className="space-y-3 text-sm text-gray-700">
          <p>La ruta <strong>{route.nombre}</strong> queda en <strong>estado normal</strong> con el último cierre cargado
            ({last?.reportDate ?? '—'}) y empieza a operar en ADEX. Después de esto ya no se cargan más cierres.</p>
          <p>La Base de la ruta ya tiene la caja del sistema anterior{lastCash ? <> (<strong>{brl(lastCash['baseMinor'])}</strong>; deuda con el socio
            {' '}{brl(lastCash['partnerDebtMinor'])})</> : null}. Al terminar, el cobrador cuenta el dinero y se compara con esa Base.</p>
        </div>
      </Modal>
      <Modal open={diffsOpen && !fixing} onClose={() => setDiffsOpen(false)} title={`Diferencias por revisar (${openDiffs.length})`} size="lg"
        footer={<Button variant="secondary" onClick={() => setDiffsOpen(false)}>Cerrar</Button>}>
        <div className="space-y-3 text-sm text-gray-700" data-testid={`route-migration-diffs-list-${route.id}`}>
          <p>Estos créditos no coincidieron con el cierre del sistema anterior. En ADEX siguen como estaban, sin mover dinero, hasta que
            se corrijan. Corregir un abono durante la migración ajusta la Base de la ruta. «Terminar migración» exige que no quede ninguna.</p>
          {openDiffs.length === 0 && <p className="text-gray-500">No hay diferencias por revisar.</p>}
          {openDiffs.map((d) => (
            <div key={d.id} className="rounded-xl border border-gray-200 p-3 space-y-1" data-testid={`route-migration-diff-${d.code}`}>
              <p className="font-semibold text-gray-800">{d.clientName} · crédito {d.code}</p>
              <p className="text-amber-700">{KIND_TEXT[d.kind] ?? d.kind}</p>
              <p>Valor en ADEX: <strong>{adexValue(d)}</strong> · Valor en el sistema anterior: <strong>{sourceValue(d)}</strong></p>
              <p className="text-xs text-gray-500">Cierre del {d.detectedReportDate}{d.sourceReportDate !== d.detectedReportDate ? ` · último cierre ${d.sourceReportDate}` : ''}</p>
              <div className="pt-1">
                <Button size="sm" onClick={() => startFix(d)} data-testid={`route-migration-fix-${d.code}`}>Corregir</Button>
              </div>
            </div>
          ))}
        </div>
      </Modal>
      <Modal open={!!fixing} onClose={() => !saving && setFixing(null)} title={fixing ? `Corregir la diferencia · crédito ${fixing.code}` : 'Corregir la diferencia'}
        footer={<><Button variant="secondary" onClick={() => setFixing(null)} disabled={saving}>Volver</Button>
          <Button onClick={() => void confirmFix()} loading={saving} disabled={!fixAction || text.trim().length < 10}
            data-testid="route-migration-fix-confirm">Guardar corrección</Button></>}>
        {fixing && (
          <div className="space-y-3 text-sm text-gray-700">
            <p><strong>{fixing.clientName}</strong> · {KIND_TEXT[fixing.kind] ?? fixing.kind}</p>
            <p>Valor en ADEX: <strong>{adexValue(fixing)}</strong> · Valor en el sistema anterior: <strong>{sourceValue(fixing)}</strong></p>
            <fieldset className="space-y-2">
              <legend className="font-medium text-gray-800">¿Qué hacer?</legend>
              {(DIFFERENCE_OPTIONS[fixing.kind] ?? []).map((o) => (
                <label key={o.action} className="flex items-start gap-2 rounded-lg border border-gray-200 p-2 cursor-pointer">
                  <input type="radio" name="migration-fix" value={o.action} checked={fixAction === o.action} onChange={() => setFixAction(o.action)}
                    className="mt-1" data-testid={`route-migration-fix-option-${o.action}`} />
                  <span><span className="font-medium">{o.label}</span><br /><span className="text-xs text-gray-500">{o.help}</span></span>
                </label>
              ))}
            </fieldset>
            <Input label="Motivo (obligatorio, queda en la auditoría)" value={text} onChange={(e) => setText(e.target.value)} maxLength={500}
              data-testid="route-migration-fix-reason" />
            <p className="text-xs text-gray-500">Ningún ajuste toca la caja: solo la cartera de la ruta.</p>
          </div>
        )}
      </Modal>
    </>
  )
}
