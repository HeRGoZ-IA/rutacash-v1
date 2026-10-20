import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Download, FileCheck2, Lock, LockOpen, ShieldCheck, Upload } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useDataRevision } from '@/hooks/useDataRevision'
import { can } from '@/lib/permissions'
import { formatCurrency, formatDateTime } from '@/lib/formatters'
import { exportJSON } from '@/lib/utils'
import {
  activateCentralCapitalModel, diagnoseCentralCapitalTransition, getActivationReadiness, releaseCentralCapitalRoute,
  type ActivationReadiness, type CentralCapitalDiagnosis, type RouteTransitionDiagnosis,
} from '@/services/centralCapitalService'
import { buildCentralCapitalBackup, verifyCentralCapitalBackup } from '@/services/centralCapitalBackupService'
import type { RouteTransitionStatus } from '@/lib/centralCapital'
import type { User } from '@/models/types'

const ESTADO: Record<RouteTransitionStatus, { label: string; variant: 'success' | 'info' | 'warning' | 'danger' }> = {
  limpia: { label: 'Limpia', variant: 'success' },
  'saldo-heredado': { label: 'Saldo heredado', variant: 'info' },
  inconsistente: { label: 'Inconsistente', variant: 'danger' },
  'sin-responsable': { label: 'Sin responsable', variant: 'warning' },
}

const PALABRA = 'ACTIVAR'

/**
 * CAPITAL CENTRALIZADO — DIAGNÓSTICO, RESPALDO Y ACTIVACIÓN (C2).
 *
 *   1. Diagnóstico por ruta (solo lectura; el Administrador ve las que controla).
 *   2. Respaldo de la empresa: exportar y volver a cargar para verificarlo (SuperAdmin).
 *   3. Activación explícita del SuperAdmin, con confirmación escrita. Nada se activa
 *      solo ni se corrige automáticamente; las rutas inconsistentes o sin responsable
 *      quedan bloqueadas para capital nuevo hasta revisarlas y liberarlas.
 *
 * Todo ocurre en este navegador: el respaldo se descarga al equipo y se vuelve a leer
 * desde el equipo. Ningún dato se envía a otro servidor.
 */
export default function CentralCapitalTransitionPage() {
  const { user } = useAuth()
  const { tenantId, currency } = useTenant()
  const money = (n: number) => formatCurrency(n, currency)
  const esSuperAdmin = can(user, 'capital.allocateAdmins', { tenantId })
  const revision = useDataRevision()
  const tenantsRev = useDataRevision(['tenants'])

  const [diag, setDiag] = useState<CentralCapitalDiagnosis | null>(null)
  const [listo, setListo] = useState<ActivationReadiness | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [error, setError] = useState<string | null>(null)
  const [trabajando, setTrabajando] = useState(false)
  const [problemas, setProblemas] = useState<string[]>([])
  const [motivo, setMotivo] = useState('')
  const [palabra, setPalabra] = useState('')
  const [entendido, setEntendido] = useState(false)
  const [liberar, setLiberar] = useState<RouteTransitionDiagnosis | null>(null)
  const [motivoLiberar, setMotivoLiberar] = useState('')
  const [aceptar, setAceptar] = useState(false)
  const archivo = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      if (!user) return
      try {
        const [d, us, l] = await Promise.all([
          diagnoseCentralCapitalTransition({ actor: user, tenantId }),
          db.users.where('tenantId').equals(tenantId).toArray(),
          esSuperAdmin ? getActivationReadiness({ actor: user, tenantId }) : Promise.resolve(null),
        ])
        if (!alive) return
        setDiag(d); setUsers(us); setListo(l); setError(null)
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : 'No se pudo calcular el diagnóstico.') }
    })()
    return () => { alive = false }
  }, [user, tenantId, revision, tenantsRev, esSuperAdmin])

  const nombre = (id?: string) => (id ? users.find(u => u.id === id)?.nombre ?? id : '—')

  async function exportar() {
    setTrabajando(true)
    try {
      const { file } = await buildCentralCapitalBackup({ actor: user, tenantId })
      exportJSON(file, `adex-respaldo-capital-${tenantId}-${file.exportedAt.slice(0, 10)}.json`)
      setProblemas([])
      toast.success('Respaldo exportado. Ahora cárgalo para verificarlo.')
      setListo(await getActivationReadiness({ actor: user, tenantId }))
    } catch (e) { toast.error(e instanceof Error ? e.message : 'No se pudo exportar el respaldo.') } finally { setTrabajando(false) }
  }

  async function verificar(f: File | undefined) {
    if (!f) return
    setTrabajando(true)
    try {
      const r = await verifyCentralCapitalBackup({ actor: user, tenantId, text: await f.text() })
      setProblemas(r.problemas)
      if (r.ok) toast.success('Respaldo verificado.')
      setListo(await getActivationReadiness({ actor: user, tenantId }))
    } catch (e) { toast.error(e instanceof Error ? e.message : 'No se pudo verificar el respaldo.') } finally {
      setTrabajando(false)
      if (archivo.current) archivo.current.value = ''
    }
  }

  async function activar() {
    setTrabajando(true)
    try {
      await activateCentralCapitalModel({ actor: user, tenantId, motivo })
      toast.success('Capital centralizado activado en esta empresa.')
      setPalabra(''); setEntendido(false)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'No se pudo activar.') } finally { setTrabajando(false) }
  }

  async function confirmarLiberacion() {
    if (!liberar) return
    setTrabajando(true)
    try {
      await releaseCentralCapitalRoute({ actor: user, tenantId, routeId: liberar.routeId, motivo: motivoLiberar, aceptarInconsistencia: aceptar })
      toast.success(`Ruta ${liberar.nombre} liberada.`)
      setLiberar(null); setMotivoLiberar(''); setAceptar(false)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'No se pudo liberar la ruta.') } finally { setTrabajando(false) }
  }

  const activo = diag?.activo ?? false
  const respaldo = listo?.respaldo
  const puedeConfirmar = !!listo?.puedeActivar && entendido && palabra.trim().toUpperCase() === PALABRA && motivo.trim().length >= 3

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-5xl">
      <div className="space-y-1">
        <Link to="/admin/capital" className="text-sm text-primary-700 hover:underline">← Capital</Link>
        <h1 className="text-xl font-bold text-gray-900">Capital centralizado</h1>
        <p className="text-sm text-gray-500">
          Las rutas dejan de tener caja propia: el Administrador responsable entrega capital de su bolsa a los trabajadores y recibe lo que devuelven.
          Esta pantalla muestra el estado de cada ruta y, para el SuperAdmin, prepara la activación.
        </p>
        <p className={`inline-flex items-center gap-1.5 text-sm font-semibold ${activo ? 'text-emerald-700' : 'text-gray-700'}`} data-testid="central-status">
          {activo ? <><CheckCircle2 className="w-4 h-4" />Activo desde {diag?.activoDesde ? formatDateTime(diag.activoDesde) : '—'}</> : <><Lock className="w-4 h-4" />No activado en esta empresa</>}
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* 1. DIAGNÓSTICO (solo lectura) */}
      <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-3" data-testid="central-diagnosis">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-900">1. Diagnóstico por ruta</h2>
          <span className="text-xs text-gray-500">Solo lectura: no mueve ni corrige dinero</span>
        </div>
        {!diag ? <p className="text-sm text-gray-400">Calculando…</p> : diag.rutas.length === 0 ? <p className="text-sm text-gray-400">No hay rutas en tu alcance.</p> : (
          <div className="space-y-3">
            {diag.rutas.map(r => (
              <div key={r.routeId} className="rounded-xl border border-gray-100 p-3 space-y-2" data-testid={`diag-${r.routeId}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{r.nombre}</p>
                    <p className="text-xs text-gray-500">Responsable: {r.controllerAdminId ? nombre(r.controllerAdminId) : 'ninguno'}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={ESTADO[r.estado].variant} size="sm">{ESTADO[r.estado].label}</Badge>
                    {r.bloqueada && <Badge variant="warning" size="sm">Bloqueada</Badge>}
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <Dato label="Base · efectivo de la ruta" value={money(r.base)} />
                  <Dato label={activo ? 'Saldo heredado actual' : 'Sin asignar (pasará a saldo heredado)'} value={money(r.sinAsignar)} />
                  <Dato label="En manos de trabajadores" value={money(r.enTrabajadores)} />
                  <Dato label="Conciliación" value={r.cuadra ? 'Cuadra' : 'No cuadra'} tone={r.cuadra ? 'text-emerald-700' : 'text-red-600'} />
                  {r.heredadoAlActivar !== undefined && <Dato label="Saldo heredado al activar" value={money(r.heredadoAlActivar)} />}
                  {r.faltantesPendientes > 0 && <Dato label="Faltantes pendientes" value={money(r.faltantesPendientes)} tone="text-amber-700" />}
                  {r.sobrantesRegistrados > 0 && <Dato label="Sobrantes registrados" value={money(r.sobrantesRegistrados)} tone="text-amber-700" />}
                  {r.cobrosNoPersonales.cantidad > 0 && <Dato label={`Cobros no en efectivo (${r.cobrosNoPersonales.cantidad})`} value={money(r.cobrosNoPersonales.total)} />}
                  {r.ajustesHistoricos.cantidad > 0 && <Dato label={`Ajustes de cobros históricos (${r.ajustesHistoricos.cantidad})`} value={money(r.ajustesHistoricos.total)} tone="text-amber-700" />}
                </div>
                <p className="text-xs text-gray-600">{r.explicacion}</p>
                {r.ajustesHistoricos.cantidad > 0 && (
                  <p className="text-[11px] text-amber-800">Correcciones posteriores a la activación sobre cobros no en efectivo anteriores a ella: siguen el circuito histórico y mueven el saldo heredado. No son operaciones de capital nuevas.</p>
                )}
                {esSuperAdmin && activo && r.bloqueada && (
                  <Button size="sm" variant="secondary" icon={<LockOpen className="w-3.5 h-3.5" />} onClick={() => { setLiberar(r); setMotivoLiberar(''); setAceptar(false) }}>Revisar y liberar</Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {esSuperAdmin && !activo && listo && (
        <>
          {/* 2. RESPALDO */}
          <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-3" data-testid="central-backup">
            <h2 className="text-sm font-semibold text-gray-900">2. Respaldo de la empresa</h2>
            <p className="text-xs text-gray-600">
              {listo.requiereRespaldo
                ? 'Antes de activar, exporta un respaldo de los datos de esta empresa en este navegador y vuelve a cargarlo para comprobar que está completo. El archivo queda en tu equipo; no se envía a ningún servidor.'
                : 'Esta empresa todavía no tiene movimientos financieros: no hace falta respaldo para activar.'}
            </p>
            {listo.requiereRespaldo && (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={exportar} loading={trabajando} icon={<Download className="w-4 h-4" />}>Exportar respaldo</Button>
                  <Button variant="secondary" onClick={() => archivo.current?.click()} disabled={trabajando || !respaldo?.receipt} icon={<Upload className="w-4 h-4" />}>Cargar respaldo para verificar</Button>
                  <input ref={archivo} type="file" accept="application/json,.json" className="hidden" onChange={e => verificar(e.target.files?.[0])} data-testid="backup-file" />
                </div>
                {respaldo?.receipt && (
                  <p className="text-xs text-gray-500">Último respaldo: {formatDateTime(respaldo.receipt.exportedAt)} · {Object.values(respaldo.receipt.conteos).reduce((s, n) => s + n, 0)} registros · huella {respaldo.receipt.integridad.slice(0, 12)}…</p>
                )}
                <p className={`flex items-start gap-1.5 text-sm ${respaldo?.vigente ? 'text-emerald-700' : 'text-amber-700'}`} data-testid="backup-status">
                  {respaldo?.vigente ? <><FileCheck2 className="w-4 h-4 mt-0.5" />Respaldo verificado y vigente.</> : <><AlertTriangle className="w-4 h-4 mt-0.5" />{respaldo?.motivo}</>}
                </p>
                {problemas.length > 0 && (
                  <ul className="text-xs text-red-700 list-disc ml-5" data-testid="backup-problems">{problemas.map(p => <li key={p}>{p}</li>)}</ul>
                )}
              </>
            )}
          </section>

          {/* 3. ACTIVACIÓN */}
          <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-3" data-testid="central-activation">
            <h2 className="text-sm font-semibold text-gray-900">3. Activar el capital centralizado</h2>
            <ul className="text-xs text-gray-600 list-disc ml-5 space-y-0.5">
              <li>No se borra ni se reescribe ningún movimiento, cuadre ni liquidación.</li>
              <li>Lo que haya en la caja de cada ruta queda como <b>saldo heredado</b>: solo puede bajar (traspaso a la bolsa del responsable o entrega a un trabajador).</li>
              <li>Desde ese momento, los cuadres, las devoluciones y los cobros no en efectivo vuelven a la bolsa del Administrador responsable.</li>
              <li>{listo.rutasABloquear.length > 0
                ? `${listo.rutasABloquear.length} ruta(s) inconsistente(s) o sin responsable quedarán bloqueadas para capital nuevo hasta que las revises y liberes.`
                : 'Ninguna ruta quedará bloqueada.'}</li>
              <li>La activación no se puede deshacer desde la aplicación.</li>
            </ul>
            <Textarea label="Motivo de la activación" value={motivo} onChange={e => setMotivo(e.target.value)} rows={2} />
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input type="checkbox" className="mt-1" checked={entendido} onChange={e => setEntendido(e.target.checked)} data-testid="activation-check" />
              <span>Revisé el diagnóstico y el respaldo. Entiendo que las rutas dejan de tener caja propia en esta empresa.</span>
            </label>
            <Input label={`Escribe ${PALABRA} para confirmar`} value={palabra} onChange={e => setPalabra(e.target.value)} />
            {!listo.puedeActivar && <p className="text-xs text-amber-700">Primero exporta y verifica el respaldo.</p>}
            <Button onClick={activar} loading={trabajando} disabled={!puedeConfirmar} icon={<ShieldCheck className="w-4 h-4" />}>Activar capital centralizado</Button>
          </section>
        </>
      )}

      <Modal open={!!liberar} onClose={() => setLiberar(null)} title={liberar ? `Liberar ${liberar.nombre}` : ''}
        footer={<><Button variant="secondary" onClick={() => setLiberar(null)}>Cancelar</Button>
          <Button onClick={confirmarLiberacion} loading={trabajando} disabled={motivoLiberar.trim().length < 10 || (liberar?.estado === 'inconsistente' && !aceptar)}>Liberar ruta</Button></>}>
        {liberar && (
          <div className="space-y-3 text-sm">
            <p className="text-gray-600">{liberar.explicacion}</p>
            <p className="text-xs text-gray-500">Liberar permite volver a entregarle capital. No corrige ningún saldo: queda registrado en la auditoría con tu motivo.</p>
            <Textarea label="Revisión realizada (mínimo 10 caracteres)" value={motivoLiberar} onChange={e => setMotivoLiberar(e.target.value)} rows={3} />
            {liberar.estado === 'inconsistente' && (
              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input type="checkbox" className="mt-1" checked={aceptar} onChange={e => setAceptar(e.target.checked)} />
                <span>La ruta sigue sin cuadrar. La revisé y acepto liberarla con esa diferencia documentada.</span>
              </label>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

function Dato({ label, value, tone = 'text-gray-900' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-gray-50 rounded-lg px-2.5 py-2">
      <p className="text-gray-500">{label}</p>
      <p className={`font-semibold ${tone}`}>{value}</p>
    </div>
  )
}
