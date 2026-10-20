// ADEX Online: COPIA del AdminPoolPanel original de CLEAN (src/components/capital/AdminPoolPanel.tsx).
// Misma Caja principal. Único cambio, marcado: si el servidor no ofrece el capital en rutas
// de la bolsa (no tiene esa cifra con el significado de CLEAN), la conciliación dice que no
// está disponible en lugar de mostrar una «Diferencia» que no existe.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CheckCircle2, Receipt, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Input'
import { DateRangeFilter } from '@/components/ui/DateRangeFilter'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/formatters'
import { POOL_MOVEMENT_LABEL, poolExpensesInPeriod, type PoolMovementKind, type PoolStatement } from '@/lib/adminPoolStatement'
import type { ExpenseCategory, Route, User } from '@/models/types'

/** Grupos del filtro de tipo (cada uno agrupa registros reales del mismo origen). */
const FILTROS: { value: string; label: string; kinds: PoolMovementKind[] }[] = [
  { value: 'sa', label: 'Capital recibido / devuelto al SuperAdmin', kinds: ['asignacion', 'devolucionSA'] },
  { value: 'rutas', label: 'Colocado / retirado de rutas', kinds: ['colocacion', 'retiroRuta'] },
  { value: 'responsable', label: 'Cambio de responsable de ruta', kinds: ['rutaRecibida', 'rutaEntregada'] },
  { value: 'gastos', label: 'Gastos, anulaciones y reintegros', kinds: ['gasto', 'anulacionGasto', 'reintegro'] },
  { value: 'trabajadores', label: 'Capital entregado / devuelto por trabajadores', kinds: ['entregaTrabajador', 'devolucionTrabajador'] },
  { value: 'cuadres', label: 'Efectivo recibido en cuadres', kinds: ['retornoCuadre'] },
  { value: 'cobros', label: 'Cobros no en efectivo', kinds: ['cobroNoPersonal'] },
  { value: 'operacion', label: 'Préstamos y gastos de ruta con la bolsa', kinds: ['desembolsoAdmin', 'gastoRuta'] },
  { value: 'socios', label: 'Aportes externos (históricos)', kinds: ['aporteSocio'] },
]

/** Entradas a la bolsa que vienen de las rutas (v16: retiros; centralizado: su operación real). */
const DESDE_RUTAS: PoolMovementKind[] = ['retiroRuta', 'devolucionTrabajador', 'retornoCuadre', 'cobroNoPersonal']

function Cifra({ label, value, tone = 'text-gray-900', bg = 'bg-gray-50', testId, hint }: { label: string; value: string; tone?: string; bg?: string; testId?: string; hint?: string }) {
  return (
    <div className={`${bg} rounded-xl p-3`} data-testid={testId}>
      <p className={`text-xs ${tone} opacity-75`}>{label}</p>
      {hint && <p className="text-[11px] text-gray-500">{hint}</p>}
      <p className={`text-base font-bold ${tone}`}>{value}</p>
    </div>
  )
}

/**
 * CAJA PRINCIPAL DEL ADMINISTRADOR (Ronda 3/6). Solo PRESENTA el estado de cuenta
 * que calcula el servicio (`getAdminPoolStatement` → `adminCapital`): ninguna cifra
 * financiera se calcula aquí, salvo filtrar y sumar movimientos ya clasificados
 * para el resumen del período (`poolExpensesInPeriod`).
 */
export function AdminPoolPanel({ statement, routes, users, categories, currency, titular, onRegistrarGasto, onDistribuir, puedeDistribuir, central = false }: {
  statement: PoolStatement
  routes: Route[]
  users: User[]
  categories: ExpenseCategory[]
  currency: string
  /** Nombre del Administrador dueño de la bolsa (para el SuperAdmin en consulta). */
  titular?: string
  onRegistrarGasto?: () => void
  onDistribuir?: () => void
  puedeDistribuir: boolean
  /** Capital centralizado (C2): la bolsa entrega a trabajadores; las rutas no tienen caja. */
  central?: boolean
}) {
  const money = (n: number) => formatCurrency(n, currency)
  const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n))}`
  const nombre = (id?: string) => (id ? id.startsWith('system:') ? 'migración' : users.find(u => u.id === id)?.nombre ?? id : '—')
  const ruta = (id?: string) => (id ? routes.find(r => r.id === id)?.nombre ?? id : '')
  const cat = (id?: string) => (id ? categories.find(c => c.id === id)?.nombre ?? '' : '')
  const { capital: c, partidas: p, conciliacion: k, movimientos } = statement
  const negativo = c.disponible < 0

  // Resumen de gastos del PERÍODO (no se mezcla con el acumulado de la conciliación).
  const [gDesde, setGDesde] = useState('')
  const [gHasta, setGHasta] = useState('')
  const periodo = poolExpensesInPeriod(movimientos, gDesde || undefined, gHasta || undefined)

  // Filtros del historial.
  const [tipo, setTipo] = useState('')
  const [rutaFiltro, setRutaFiltro] = useState('')
  const [desde, setDesde] = useState('')
  const [hasta, setHasta] = useState('')
  const kinds = FILTROS.find(f => f.value === tipo)?.kinds
  const visibles = movimientos.filter(m =>
    (!kinds || kinds.includes(m.kind)) && (!rutaFiltro || m.routeId === rutaFiltro)
    && (!desde || m.fecha >= desde) && (!hasta || m.fecha <= hasta))
  const rutasConMovs = [...new Set(movimientos.map(m => m.routeId).filter(Boolean) as string[])]
  const devoluciones = movimientos.filter(m => DESDE_RUTAS.includes(m.kind))

  return (
    <div className="space-y-6" data-testid="admin-pool">
      {/* DISPONIBLE: lo que se puede distribuir o gastar ahora. */}
      <section className={`rounded-2xl border p-4 sm:p-5 ${negativo ? 'bg-red-50 border-red-200' : 'bg-white border-gray-100 shadow-card'}`}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0" data-testid="my-available">
            <p className="text-sm text-gray-600 flex items-center gap-1.5"><Wallet className="w-4 h-4 text-primary-600" />Disponible en caja{titular ? ` · ${titular}` : ''}</p>
            <p className="text-xs text-gray-500">{central ? 'Para entregar capital a tus trabajadores o pagar gastos.' : 'Para distribuir a tus rutas o pagar gastos administrativos.'}</p>
            <p className={`text-3xl font-bold tracking-tight ${negativo ? 'text-red-700' : 'text-gray-900'}`}>{money(c.disponible)}</p>
          </div>
          {(onRegistrarGasto || onDistribuir) && (
            <div className="flex flex-col gap-2 sm:flex-row">
              {onRegistrarGasto && <Button variant="secondary" onClick={onRegistrarGasto} disabled={c.disponible <= 0} icon={<Receipt className="w-4 h-4" />}>Registrar gasto</Button>}
              {onDistribuir && <Button onClick={onDistribuir} disabled={c.disponible <= 0 || !puedeDistribuir} icon={<ArrowUpRight className="w-4 h-4" />}>{central ? 'Entregar capital' : 'Distribuir capital'}</Button>}
            </div>
          )}
        </div>
        {negativo && (
          <p className="mt-3 flex items-start gap-2 text-sm text-red-700" data-testid="pool-negative">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            El disponible es negativo: hay una inconsistencia en los registros. No se muestra como cero y las operaciones que usan fondos quedan bloqueadas hasta revisarla con el SuperAdmin.
          </p>
        )}
        {!negativo && c.disponible === 0 && (onRegistrarGasto || onDistribuir) && (
          <p className="mt-3 text-xs text-gray-500">{central
            ? 'Sin disponible: para gastar o entregar, recibe devoluciones o cuadres de tus trabajadores o pide una asignación al SuperAdmin.'
            : 'Sin disponible: para gastar o distribuir, retira capital de una ruta o pide una asignación al SuperAdmin.'}</p>
        )}
      </section>

      {/* INDICADORES */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-2" data-testid="my-capital">
        <Cifra label="Capital recibido" hint="Asignado por el SuperAdmin, neto de devoluciones" value={money(p.recibidoSA)} testId="pool-received" />
        <Cifra label={central ? 'Capital en rutas' : 'Colocado en rutas'} hint={central ? 'En manos de trabajadores y prestado, neto de lo devuelto' : 'Neto: colocado − retirado'} value={money(c.enRutas)} tone="text-indigo-700" bg="bg-indigo-50" testId="my-in-routes" />
        <Cifra label="Gastos administrativos" hint="Acumulado neto" value={money(c.gastos)} tone="text-red-700" bg="bg-red-50" testId="pool-expenses" />
        <Cifra label="Capital bajo mi responsabilidad" hint="Disponible + en rutas" value={money(c.asignado)} tone="text-primary-700" bg="bg-primary-50" testId="my-assigned" />
      </section>

      {/* CONCILIACIÓN: identidad del modelo, sin ajustes. */}
      <section className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden" data-testid="pool-reconciliation">
        <div className="flex items-center justify-between gap-2 px-4 py-3 bg-gray-50">
          <h2 className="text-sm font-semibold text-gray-900">Conciliación de la bolsa</h2>
          {/* ADEX Online: conciliación no disponible en el servidor. */}
          {Number.isNaN(k.diferencia)
            ? <span className="flex items-center gap-1 text-xs font-semibold text-gray-500" data-testid="pool-unreconciled">Sin conciliación en el servidor</span>
            : k.diferencia === 0
            ? <span className="flex items-center gap-1 text-xs font-semibold text-emerald-700" data-testid="pool-reconciled"><CheckCircle2 className="w-4 h-4" />Cuadra</span>
            : <span className="flex items-center gap-1 text-xs font-semibold text-red-700" data-testid="pool-difference"><AlertTriangle className="w-4 h-4" />Diferencia {signed(k.diferencia)}</span>}
        </div>
        <div className="divide-y divide-gray-50 text-sm">
          <Linea label="Asignado por el SuperAdmin" value={money(p.asignaciones)} />
          {p.devolucionesSA !== 0 && <Linea label="(−) Devuelto al SuperAdmin" value={money(p.devolucionesSA)} />}
          {p.aportesSocios !== 0 && <Linea label="(+) Aportes externos (históricos)" value={money(p.aportesSocios)} />}
          {/* ADEX Online · Ronda 53 */}
          {(p as { traspasos?: number }).traspasos ? <Linea label="(±) Transferencias entre Administradores" value={money((p as { traspasos?: number }).traspasos ?? 0)} /> : null}
          {(p as { comprometido?: number }).comprometido ? <Linea label="(−) Comprometido en transferencias pendientes" value={money(-((p as { comprometido?: number }).comprometido ?? 0))} /> : null}
          {p.rutasRecibidas !== 0 && <Linea label="(+) Capital recibido con rutas (cambio de responsable)" value={money(p.rutasRecibidas)} />}
          {p.rutasEntregadas !== 0 && <Linea label="(−) Capital entregado con rutas (cambio de responsable)" value={money(p.rutasEntregadas)} />}
          <Linea label="= Capital a explicar" value={money(k.entradas)} strong />
          <Linea label="Disponible en caja" value={money(c.disponible)} />
          <Linea label="(+) Capital neto en rutas" value={money(c.enRutas)} />
          <Linea label="(+) Gastos administrativos netos (acumulado)" value={money(c.gastos)} />
          <Linea label="= Capital explicado" value={money(k.explicado)} strong />
        </div>
        {/* ADEX Online */}
        {Number.isNaN(k.diferencia) && (
          <p className="px-4 pt-2 text-[11px] text-gray-500">
            El capital en rutas aún no tiene cifra en el servidor: se muestra «—».
          </p>
        )}
        <p className="px-4 py-2 text-[11px] text-gray-500">
          Lo retirado de una ruta vuelve al disponible y reduce el capital neto en rutas (puede incluir utilidades de la ruta). Los gastos históricos sin bolsa no entran.
        </p>
      </section>

      {/* GASTOS DEL PERÍODO */}
      <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-3" data-testid="pool-period">
        <h2 className="text-sm font-semibold text-gray-900">Gastos administrativos por período</h2>
        <DateRangeFilter desde={gDesde} hasta={gHasta} onDesde={setGDesde} onHasta={setGHasta} onClear={() => { setGDesde(''); setGHasta('') }} />
        <div className="grid grid-cols-2 gap-2">
          <Cifra label={gDesde || gHasta ? 'Gasto neto del período' : 'Gasto neto (todo el historial)'} value={money(periodo.neto)} tone="text-red-700" bg="bg-red-50" testId="pool-period-total" />
          <Cifra label="Gastos registrados" value={String(periodo.registros)} />
        </div>
        <p className="text-[11px] text-gray-500">Por fecha contable, con anulaciones y reintegros.</p>
      </section>

      {/* DEVOLUCIONES DESDE RUTAS */}
      <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-2" data-testid="pool-returns">
        <h2 className="text-sm font-semibold text-gray-900">{central ? 'Dinero recibido desde rutas' : 'Devoluciones de capital desde rutas'}</h2>
        {devoluciones.length === 0 ? <p className="text-sm text-gray-400">Sin devoluciones.</p> : (
          <div className="divide-y divide-gray-50">
            {devoluciones.map(m => (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-gray-900 flex items-center gap-1.5"><ArrowDownLeft className="w-4 h-4 text-emerald-600" />{ruta(m.routeId)}{m.kind !== 'retiroRuta' ? ` · ${POOL_MOVEMENT_LABEL[m.kind]}` : ''}{m.estado !== 'vigente' ? ` · ${m.estado === 'anulado' ? 'anulado' : 'reversión'}` : ''}</p>
                  <p className="text-xs text-gray-500 break-words">{formatDate(m.fecha)} · registró {nombre(m.actorId)} · Ref. {m.id.slice(0, 8).toUpperCase()}</p>
                </div>
                <span className={`text-sm font-semibold ${m.estado === 'anulado' ? 'text-gray-400 line-through' : m.monto >= 0 ? 'text-emerald-600' : 'text-amber-600'}`}>{signed(m.monto)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* HISTORIAL DE LA BOLSA */}
      <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-3" data-testid="pool-movements">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-900">Movimientos de la bolsa</h2>
          <span className="flex items-center gap-3 text-xs text-gray-500">
            {visibles.length} de {movimientos.length}
            <Link to={`/admin/movements?adminId=${encodeURIComponent(statement.adminId)}`} className="text-primary-700 hover:underline" data-testid="go-history">Historial completo y comprobantes</Link>
          </span>
        </div>
        <DateRangeFilter desde={desde} hasta={hasta} onDesde={setDesde} onHasta={setHasta} onClear={() => { setDesde(''); setHasta(''); setTipo(''); setRutaFiltro('') }}>
          <div className="w-full sm:w-64">
            <Select aria-label="Tipo de movimiento" value={tipo} onChange={e => setTipo(e.target.value)} options={FILTROS.map(f => ({ value: f.value, label: f.label }))} placeholder="Todos los movimientos" />
          </div>
          {rutasConMovs.length > 0 && (
            <div className="w-full sm:w-48">
              <Select aria-label="Ruta" value={rutaFiltro} onChange={e => setRutaFiltro(e.target.value)} options={rutasConMovs.map(id => ({ value: id, label: ruta(id) }))} placeholder="Todas las rutas" />
            </div>
          )}
        </DateRangeFilter>
        {visibles.length === 0 ? <p className="text-sm text-gray-400">Sin movimientos.</p> : (
          <div className="divide-y divide-gray-50">
            {visibles.map(m => (
              <div key={m.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5 py-2.5" data-testid="pool-movement">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-900 flex flex-wrap items-center gap-1.5">
                    {POOL_MOVEMENT_LABEL[m.kind]}{m.routeId ? ` · ${ruta(m.routeId)}` : ''}{m.categoryId ? ` · ${cat(m.categoryId)}` : ''}
                    {m.estado === 'anulado' && <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-red-50 text-red-600">Anulado</span>}
                    {m.estado === 'reversion' && m.kind !== 'anulacionGasto' && <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-emerald-50 text-emerald-700">Reversión</span>}
                    {m.afecta === 'enRutas' && <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-indigo-50 text-indigo-700">Afecta capital en rutas</span>}
                  </p>
                  <p className="text-xs text-gray-500 break-words">
                    {formatDateTime(m.createdAt)}{m.fecha !== m.createdAt.slice(0, 10) ? ` · fecha contable ${formatDate(m.fecha)}` : ''} · registró {nombre(m.actorId)}
                    {m.relatedAdminId ? ` · ${m.kind === 'rutaRecibida' ? 'de' : 'a'} ${nombre(m.relatedAdminId)}` : ''}
                    {m.descripcion ? ` · ${m.descripcion}` : ''} · Ref. {m.id.slice(0, 8).toUpperCase()}
                  </p>
                </div>
                <span className={`text-sm font-semibold whitespace-nowrap ${m.estado === 'anulado' ? 'text-gray-400 line-through' : m.monto >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {m.monto >= 0 ? 'Entrada ' : 'Salida '}{signed(m.monto)}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] text-gray-500">Los traslados entre tus rutas no cambian la bolsa.</p>
      </section>
    </div>
  )
}

function Linea({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2">
      <span className={strong ? 'font-semibold text-gray-900' : 'text-gray-600'}>{label}</span>
      <span className={strong ? 'font-bold text-gray-900' : 'font-semibold text-gray-800'}>{value}</span>
    </div>
  )
}
