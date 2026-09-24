import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Lock, LockOpen, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Select } from '@/components/ui/Input'
import { toast } from '@/components/ui/Toast'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useDataRevision } from '@/hooks/useDataRevision'
import { can } from '@/lib/permissions'
import { formatCurrency, formatDateTime } from '@/lib/formatters'
import { settlementOutcome, reopenCashBlockedReason, MIN_CASH_REASON } from '@/lib/cashSettlementRules'
import {
  closeCashSettlement, getPendingShortagesForUser, listCashSettlementsForUser, listSettleableWorkers,
  previewCashSettlement, reopenCashSettlement, type CashSettlementPreview,
} from '@/services/cashSettlementService'
import { db } from '@/lib/db'
import type { CashSettlement, User } from '@/models/types'

/**
 * CUADRE POR TRABAJADOR — Ruta → Trabajador → Vista previa → Entregado → Confirmar.
 *
 * Se monta dentro de Liquidación (Admin/Super Admin) y en la app del Supervisor.
 * La RUTA la decide quien lo monta (selector Oficina → Ruta o ruta activa). Aquí no
 * se calcula nada financiero: la vista previa y el cierre salen del servicio, que
 * recalcula el esperado en el instante del cierre.
 */
export function WorkerCashSettlementPanel({ routeId }: { routeId: string }) {
  const { user } = useAuth()
  const { tenantId, currency } = useTenant()
  const revision = useDataRevision()
  const money = (n: number) => formatCurrency(n, currency)

  const [workers, setWorkers] = useState<{ user: User; esPropio: boolean }[]>([])
  /** Nombres de la empresa (trabajadores y quien cerró: Admin, Super Admin…). */
  const [nombres, setNombres] = useState<Map<string, string>>(new Map())
  const [userId, setUserId] = useState('')
  const [preview, setPreview] = useState<CashSettlementPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [entregado, setEntregado] = useState(0)
  const [motivo, setMotivo] = useState('')
  const [confirmando, setConfirmando] = useState(false)
  const [cerrando, setCerrando] = useState(false)
  const [historial, setHistorial] = useState<CashSettlement[]>([])
  const [reabrir, setReabrir] = useState<CashSettlement | null>(null)
  const [motivoReabrir, setMotivoReabrir] = useState('')
  const [reabriendo, setReabriendo] = useState(false)

  const puedeCerrar = can(user, 'cashSettlement.close', { routeId, tenantId })
  const puedeReabrir = can(user, 'cashSettlement.reopen', { routeId, tenantId })
  const seleccionado = workers.find(w => w.user.id === userId)

  // Trabajadores de la ruta (con caja personal y asignados).
  useEffect(() => {
    let alive = true
    Promise.all([
      listSettleableWorkers(user, tenantId, routeId),
      db.users.where('tenantId').equals(tenantId).toArray(),
    ]).then(([list, users]) => {
      if (!alive) return
      setWorkers(list)
      setNombres(new Map(users.map(u => [u.id, u.nombre])))
      if (!list.some(w => w.user.id === userId)) setUserId('')
    })
    return () => { alive = false }
  }, [user, tenantId, routeId, revision])  // eslint-disable-line react-hooks/exhaustive-deps

  // Vista previa viva: se recalcula si llega un cobro, desembolso o gasto.
  useEffect(() => {
    let alive = true
    if (!userId) { setPreview(null); setPreviewError(null); return }
    previewCashSettlement({ actor: user, tenantId, routeId, userId })
      .then(p => { if (alive) { setPreview(p); setPreviewError(null) } })
      .catch(e => { if (alive) { setPreview(null); setPreviewError(e instanceof Error ? e.message : 'No se pudo calcular') } })
    return () => { alive = false }
  }, [user, tenantId, routeId, userId, revision])

  // Histórico compacto de la ruta.
  useEffect(() => {
    let alive = true
    listCashSettlementsForUser(user, tenantId).then(list => {
      if (alive) setHistorial(list.filter(s => s.routeId === routeId))
    })
    return () => { alive = false }
  }, [user, tenantId, routeId, revision])

  const outcome = useMemo(() => preview ? settlementOutcome(preview.esperado, entregado) : null, [preview, entregado])
  const motivoRequerido = Boolean(outcome && outcome.diferencia !== 0)
  const motivoValido = !motivoRequerido || motivo.trim().length >= MIN_CASH_REASON
  const nombreDe = (id: string) => nombres.get(id) ?? id

  async function cerrar() {
    if (!preview) return
    setCerrando(true)
    try {
      const doc = await closeCashSettlement({
        actor: user, tenantId, routeId, userId, entregado, motivo, esperadoVisto: preview.esperado,
      })
      toast.success(doc.diferencia === 0
        ? `Cuadre de ${preview.userName} cerrado: exacto.`
        : doc.diferencia < 0
          ? `Cuadre cerrado con FALTANTE de ${money(doc.faltante)}. Continúa pendiente.`
          : `Cuadre cerrado con SOBRANTE de ${money(doc.sobrante)}.`)
      setConfirmando(false)
      setEntregado(0)
      setMotivo('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cerrar el cuadre.')
    } finally { setCerrando(false) }
  }

  async function confirmarReapertura() {
    if (!reabrir) return
    setReabriendo(true)
    try {
      await reopenCashSettlement({ actor: user, settlementId: reabrir.id, motivo: motivoReabrir })
      toast.success('Cuadre reabierto. El siguiente cierre vuelve a cubrir ese periodo.')
      setReabrir(null)
      setMotivoReabrir('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo reabrir el cuadre.')
    } finally { setReabriendo(false) }
  }

  const Row = ({ label, value, tone = 'text-gray-800' }: { label: string; value: string; tone?: string }) => (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-sm text-gray-600">{label}</span>
      <span className={`text-sm font-semibold ${tone}`}>{value}</span>
    </div>
  )

  return (
    <div className="space-y-5">
      <Select
        label="Trabajador"
        value={userId}
        onChange={e => { setUserId(e.target.value); setEntregado(0); setMotivo('') }}
        options={workers.map(w => ({
          value: w.user.id,
          label: `${w.user.nombre} · ${w.user.rol === 'supervisor' ? 'Supervisor' : 'Cobrador'}${w.esPropio ? ' (tú)' : ''}${w.user.status !== 'activo' ? ' · inactivo' : ''}`,
        }))}
        placeholder={workers.length ? 'Selecciona a quién cuadrar' : 'Esta ruta no tiene trabajadores con efectivo'}
      />

      {previewError && <p className="text-sm text-red-600">{previewError}</p>}

      {preview && outcome && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden divide-y divide-gray-50">
            <div className="px-4 py-3 bg-gray-50 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
              <span className="flex items-center gap-1 text-sm font-semibold text-gray-800">
                <UserRound className="w-4 h-4 text-gray-400" /> {preview.userName}
              </span>
              <span>Ruta {preview.routeName}</span>
              <span>
                {preview.origenDesde === 'ultimo-cierre' ? 'Desde el último cuadre' : 'Desde el inicio del modelo personal'}:
                {' '}<b className="text-gray-700">{formatDateTime(preview.desde)}</b>
              </span>
              <span>Hasta: <b className="text-gray-700">{formatDateTime(preview.hasta)}</b></span>
            </div>
            <Row label="Arrastre pendiente (faltante anterior)" value={money(preview.arrastreAnterior)} tone={preview.arrastreAnterior > 0 ? 'text-amber-600' : 'text-gray-800'} />
            <Row label="(+) Recaudado" value={money(preview.recaudado)} tone="text-emerald-600" />
            <Row label="(−) Desembolsado" value={money(preview.desembolsado)} tone="text-blue-600" />
            <Row label="(−) Gastos" value={money(preview.gastos)} tone="text-red-500" />
            <div className="flex items-center justify-between px-4 py-3 bg-primary-50">
              <span className="text-sm font-semibold text-gray-800">Esperado a entregar</span>
              <span className="text-base font-bold text-primary-700">{money(preview.esperado)}</span>
            </div>
          </div>

          {seleccionado?.esPropio ? (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
              Este es tu propio cuadre: debe cerrarlo otra persona autorizada.
            </p>
          ) : puedeCerrar ? (
            <div className="space-y-3">
              <MoneyInput label="Entregado" value={entregado} onValueChange={setEntregado} currency={currency} min={0} />
              <ResultBanner resultado={outcome.resultado} faltante={outcome.faltante} sobrante={outcome.sobrante} money={money} />
              {motivoRequerido && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1.5">Motivo de la diferencia (obligatorio)</label>
                  <textarea value={motivo} onChange={e => setMotivo(e.target.value)} rows={2}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                    placeholder="Ej.: faltaron billetes, se descontará en la próxima entrega." />
                  <p className="mt-1 text-xs text-gray-400">Mínimo {MIN_CASH_REASON} caracteres.</p>
                </div>
              )}
              <Button onClick={() => setConfirmando(true)} disabled={!motivoValido} icon={<Lock className="w-4 h-4" />}>
                Cerrar cuadre
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {/* ---------- HISTÓRICO COMPACTO ---------- */}
      {historial.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-700">Cuadres de trabajadores en esta ruta</h3>
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Fecha/hora</th>
                  <th className="text-left font-medium px-3 py-2">Trabajador</th>
                  <th className="text-right font-medium px-3 py-2">Esperado</th>
                  <th className="text-right font-medium px-3 py-2">Entregado</th>
                  <th className="text-right font-medium px-3 py-2">Diferencia</th>
                  <th className="text-left font-medium px-3 py-2">Cerró</th>
                  <th className="text-left font-medium px-3 py-2">Motivo</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {historial.map(s => {
                  const puede = puedeReabrir && !reopenCashBlockedReason(s, historial)
                  return (
                    <tr key={s.id} className={s.status === 'reabierta' ? 'text-gray-400' : ''}>
                      <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(s.closedAt)} <span className="text-gray-400">v{s.version}</span></td>
                      <td className="px-3 py-2">{nombreDe(s.userId)}</td>
                      <td className="px-3 py-2 text-right">{money(s.esperado)}</td>
                      <td className="px-3 py-2 text-right">{money(s.entregado)}</td>
                      <td className={`px-3 py-2 text-right font-semibold ${s.diferencia < 0 ? 'text-red-600' : s.diferencia > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                        {s.diferencia === 0 ? 'Exacto' : s.diferencia < 0 ? `Faltante ${money(s.faltante)}` : `Sobrante ${money(s.sobrante)}`}
                      </td>
                      <td className="px-3 py-2">{nombreDe(s.closedByUserId)}</td>
                      <td className="px-3 py-2 max-w-[220px] truncate" title={s.motivo ?? ''}>
                        {s.status === 'reabierta' ? `Reabierto: ${s.reopenReason ?? ''}` : s.motivo ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {puede && (
                          <button onClick={() => { setReabrir(s); setMotivoReabrir('') }} className="text-amber-600 hover:underline">
                            Reabrir
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------- CONFIRMACIÓN ---------- */}
      <Modal open={confirmando} onClose={() => setConfirmando(false)} title="Confirmar cuadre"
        footer={<div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmando(false)}>Cancelar</Button>
          <Button onClick={cerrar} loading={cerrando} icon={<Lock className="w-4 h-4" />}>Confirmar cierre</Button>
        </div>}>
        {preview && outcome && (
          <div className="space-y-2 text-sm">
            <p>Trabajador: <b>{preview.userName}</b></p>
            <p>Esperado: <b>{money(preview.esperado)}</b></p>
            <p>Entregado: <b>{money(entregado)}</b></p>
            {outcome.resultado === 'exacto' && <p className="text-emerald-700 font-semibold">Cuadre exacto.</p>}
            {outcome.resultado === 'faltante' && (
              <>
                <p className="text-red-600 font-semibold">Faltante: {money(outcome.faltante)}</p>
                <p className="text-gray-600">Este faltante continuará pendiente en el siguiente ciclo.</p>
              </>
            )}
            {outcome.resultado === 'sobrante' && (
              <>
                <p className="text-amber-600 font-semibold">Sobrante: {money(outcome.sobrante)}</p>
                <p className="text-gray-600">El sobrante queda registrado con su motivo. No se convierte en saldo a favor del trabajador.</p>
              </>
            )}
          </div>
        )}
      </Modal>

      {/* ---------- REAPERTURA ---------- */}
      <Modal open={Boolean(reabrir)} onClose={() => setReabrir(null)} title="Reabrir cuadre"
        footer={<div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setReabrir(null)}>Cancelar</Button>
          <Button onClick={confirmarReapertura} loading={reabriendo}
            disabled={motivoReabrir.trim().length < MIN_CASH_REASON} icon={<LockOpen className="w-4 h-4" />}>Reabrir</Button>
        </div>}>
        {reabrir && (
          <div className="space-y-3 text-sm">
            <p className="text-gray-600">
              Cuadre de <b>{nombreDe(reabrir.userId)}</b> del {formatDateTime(reabrir.closedAt)} (v{reabrir.version}).
              El documento se conserva; el próximo cierre volverá a cubrir ese periodo.
            </p>
            <textarea value={motivoReabrir} onChange={e => setMotivoReabrir(e.target.value)} rows={3}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              placeholder="Motivo de la reapertura (obligatorio)" />
            <p className="text-xs text-gray-400">Mínimo {MIN_CASH_REASON} caracteres.</p>
          </div>
        )}
      </Modal>
    </div>
  )
}

function ResultBanner({ resultado, faltante, sobrante, money }: {
  resultado: 'exacto' | 'faltante' | 'sobrante'; faltante: number; sobrante: number; money: (n: number) => string
}) {
  if (resultado === 'exacto') {
    return <div className="flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-100 px-3 py-2 text-sm font-semibold text-emerald-700">
      <CheckCircle2 className="w-4 h-4" /> CUADRE EXACTO
    </div>
  }
  return <div className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold ${resultado === 'faltante' ? 'bg-red-50 border border-red-100 text-red-700' : 'bg-amber-50 border border-amber-100 text-amber-700'}`}>
    <AlertTriangle className="w-4 h-4" />
    {resultado === 'faltante' ? `FALTANTE ${money(faltante)}` : `SOBRANTE ${money(sobrante)}`}
  </div>
}

/**
 * Aviso de FALTANTES pendientes (Admin/Super Admin/Supervisor). No bloquea a nadie:
 * solo identifica a quién le quedó dinero por entregar.
 */
export function PendingShortagesNotice() {
  const { user } = useAuth()
  const { tenantId, currency } = useTenant()
  const revision = useDataRevision()
  const [filas, setFilas] = useState<{ s: CashSettlement; nombre: string; ruta: string }[]>([])

  useEffect(() => {
    let alive = true
    ;(async () => {
      const pendientes = await getPendingShortagesForUser(user, tenantId)
      const [users, routes] = await Promise.all([
        db.users.where('tenantId').equals(tenantId).toArray(),
        db.routes.where('tenantId').equals(tenantId).toArray(),
      ])
      if (!alive) return
      setFilas(pendientes.map(s => ({
        s,
        nombre: users.find(u => u.id === s.userId)?.nombre ?? s.userId,
        ruta: routes.find(r => r.id === s.routeId)?.nombre ?? s.routeId,
      })))
    })().catch(() => { if (alive) setFilas([]) })
    return () => { alive = false }
  }, [user, tenantId, revision])

  if (filas.length === 0) return null
  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-red-200 bg-red-50">
      <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-500" />
      <div className="min-w-0 text-sm text-red-800">
        <p className="font-medium">{filas.length} trabajador(es) con faltante pendiente</p>
        <ul className="mt-1 space-y-0.5 text-xs text-red-700">
          {filas.map(f => (
            <li key={f.s.id}>{f.nombre} · {f.ruta} — Faltante pendiente: <b>{formatCurrency(f.s.faltante, currency)}</b></li>
          ))}
        </ul>
      </div>
    </div>
  )
}
