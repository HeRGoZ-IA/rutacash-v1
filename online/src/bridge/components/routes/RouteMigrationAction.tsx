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

import { useEffect, useState } from 'react'
import { ArrowRightLeft, CheckCircle2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { toast } from '@/components/ui/Toast'
import { formatCurrency } from '@/lib/formatters'
import type { Route } from '@/models/types'
import { OnlineCommandError, money, plain } from '../../../runtime/commands.ts'
import { api } from '../../../runtime/session.ts'

const MESSAGES: Record<string, string> = {
  ROUTE_MIGRATION_NOT_ALLOWED: 'La ruta debe estar activa, sin clientes, ventas ni movimientos, y sin una entrega pendiente.',
  ROUTE_MIGRATION_INVALID_DATA: 'Los datos del archivo no cuadran. Revise la vista previa.',
  BODY_TOO_LARGE: 'El archivo es demasiado grande.',
  PERMISSION_DENIED: 'Solo el SuperAdmin puede hacerlo.',
  INVALID_INPUT: 'Revise los datos.',
}

type Preview = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0))
const brl = (minor: unknown) => formatCurrency(num(minor) / 100, 'BRL')

// `inUse`: la ruta ya tiene Base, cartera, ventas o clientes activos. Solo se ofrece «Poner en migración» en rutas
// nuevas y vacías (pedido de Helmer, 2026-11-04); el servidor lo rechaza igual (AX444) si queda algún dato.
export function RouteMigrationAction({ route, isSuperadmin, inUse = true }: { route: Route; isSuperadmin: boolean; inUse?: boolean }) {
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
  const [reload, setReload] = useState(0)
  const inMigration = route.migrationState === 'en_migracion'
  // Cierres ya cargados (para la fecha del último y para permitir terminar).
  useEffect(() => {
    if (!isSuperadmin || !inMigration) return
    let alive = true
    api().get<{ migrations: { status: string; loads?: { reportDate: string; summary: Preview }[] }[] }>(`/v1/route-migrations?routeId=${encodeURIComponent(route.id)}`)
      .then((r) => { if (alive) setLoads(r.migrations.find((m) => m.status === 'en_migracion')?.loads ?? []) })
      .catch(() => { if (alive) setLoads([]) })
    return () => { alive = false }
  }, [isSuperadmin, inMigration, route.id, reload])
  if (!isSuperadmin) return null
  if (!inMigration && (route.status !== 'activa' || inUse)) return null

  const fail = (e: unknown) => {
    const code = e instanceof OnlineCommandError ? e.code : ''
    toast.error(MESSAGES[code] ?? (e instanceof Error ? e.message : 'No se pudo completar.'))
  }

  const start = () => { setText(inMigration ? '' : route.nombre); setOperationId(crypto.randomUUID()); setOpen(true) }
  const submit = async () => {
    const value = text.trim()
    if (inMigration ? value.length < 10 : value.length < 2) {
      toast.error(inMigration ? 'Escriba el motivo (mínimo 10 caracteres).' : 'Escriba el nombre de la ruta en Listos.')
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
  const confirmClose = async () => {
    setSaving(true)
    try {
      await money('POST', `/v1/routes/${route.id}/migration/close`, {}, operationId)
      toast.success(`${route.nombre} terminó la migración y quedó en estado normal. Falta abrir la caja: inyecte la Base contada.`)
      setCloseOpen(false)
    } catch (e) {
      fail(e)
    } finally {
      setSaving(false)
    }
  }
  const last = loads[0]
  const listos = (preview?.['listos'] ?? {}) as Record<string, unknown>
  const dups = Array.isArray(preview?.['duplicateDocuments']) ? (preview['duplicateDocuments'] as unknown[]).length : 0

  return (
    <>
      {inMigration && last && (
        <p className="w-full text-xs text-gray-500" data-testid={`route-migration-last-${route.id}`}>
          Último cierre de Listos cargado: {last.reportDate} · {num(last.summary['activeCredits'])} créditos activos · saldo {brl(last.summary['balanceMinor'])}
        </p>
      )}
      {inMigration && (
        <Button variant="ghost" size="sm" onClick={startLoad} icon={<Upload className="w-3.5 h-3.5" />} data-testid={`route-migration-load-${route.id}`}>
          Cargar cierre de Listos
        </Button>
      )}
      {inMigration && last && (
        <Button variant="ghost" size="sm" onClick={startClose} icon={<CheckCircle2 className="w-3.5 h-3.5" />} data-testid={`route-migration-close-${route.id}`}>
          Terminar migración
        </Button>
      )}
      {!(inMigration && last) && (
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
              <p>La ruta <strong>{route.nombre}</strong> seguirá operando en Listos. En ADEX quedará <strong>solo de consulta</strong>:
                nadie podrá crear clientes, ventas, abonos, gastos ni mover la Base hasta terminar la migración.</p>
              <p>Debe ser una ruta nueva y vacía.</p>
            </>
          )}
          <Input label={inMigration ? 'Motivo' : 'Nombre de la ruta en Listos'} value={text} onChange={(e) => setText(e.target.value)}
            maxLength={inMigration ? 500 : 120} autoFocus />
        </div>
      </Modal>
      <Modal open={loadOpen} onClose={() => !saving && setLoadOpen(false)} title="Cargar cierre de Listos"
        footer={<><Button variant="secondary" onClick={() => setLoadOpen(false)} disabled={saving}>Volver</Button>
          <Button onClick={() => void confirmLoad()} loading={saving} disabled={!preview || preview['valid'] !== true}
            data-testid={`route-migration-confirm-${route.id}`}>Guardar cierre</Button></>}>
        <div className="space-y-3 text-sm text-gray-700">
          <p>Suba el archivo (<strong>.json</strong>) preparado con los reportes de Listos del cierre de un día. Primero verá una
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
              {preview['firstLoad'] !== true && (
                <p>Desde el cierre anterior: {num(preview['newCredits'])} créditos nuevos · {num(preview['creditsWithPayments'])} con abonos ·
                  {' '}{num(preview['creditsPaidOff'])} pagados · cobrado en Listos <strong>{brl(preview['collectedInListosMinor'])}</strong></p>
              )}
              <p>Clientes: <strong>{num(preview['clients'])}</strong> ({num(preview['activeClients'])} con crédito activo)</p>
              <p>Créditos activos: <strong>{num(preview['activeCredits'])}</strong> · saldo <strong>{brl(preview['balanceMinor'])}</strong></p>
              <p>Capital pendiente (Cartera activa): <strong>{brl(preview['principalMinor'])}</strong></p>
              <p>Créditos con cuotas vencidas: {num(preview['creditsOverdue'])}</p>
              <p>Créditos pagados (historial de Listos): {num(preview['paidCredits'])}</p>
              {dups > 0 && <p className="text-amber-700">Documentos ya usados en la empresa: {dups} (se cargan marcados, sin fusionar).</p>}
              {(listos['cajaMinor'] != null || listos['carteraMinor'] != null) && (
                <p className="text-gray-500">Listos ese día: caja {listos['cajaMinor'] != null ? brl(listos['cajaMinor']) : '—'} · cartera {listos['carteraMinor'] != null ? brl(listos['carteraMinor']) : '—'}</p>
              )}
              <p className="pt-1 text-gray-600">Al guardar, la ruta queda igual que en Listos ese día y <strong>sigue en migración</strong>
                (solo lectura). Los abonos de esos días quedan como «Abono en Listos»: no entran en ninguna caja.</p>
            </div>
          )}
        </div>
      </Modal>
      <Modal open={closeOpen} onClose={() => !saving && setCloseOpen(false)} title="Terminar migración"
        footer={<><Button variant="secondary" onClick={() => setCloseOpen(false)} disabled={saving}>Volver</Button>
          <Button onClick={() => void confirmClose()} loading={saving} data-testid={`route-migration-close-confirm-${route.id}`}>Terminar migración</Button></>}>
        <div className="space-y-3 text-sm text-gray-700">
          <p>La ruta <strong>{route.nombre}</strong> queda en <strong>estado normal</strong> con el último cierre cargado
            ({last?.reportDate ?? '—'}) y empieza a operar en ADEX. Después de esto ya no se cargan más cierres de Listos.</p>
          <p>Luego, el Administrador abre la caja con <strong>Inyectar Base</strong> por el dinero contado al cierre.</p>
        </div>
      </Modal>
    </>
  )
}
