import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  Building2, MapPin, Users, AlertTriangle, ChevronRight, Plus, Edit,
  ArrowRightLeft, BarChart3, CalendarRange, UserCog, CreditCard, Archive,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { can, ROLE_LABELS, canManageUser } from '@/lib/permissions'
import { formatCurrency } from '@/lib/formatters'
import { NO_OFFICE_LABEL } from '@/lib/officeGrouping'
import { ROUTE_STATE_LABEL, applyOfficeRouteSelection } from '@/lib/officeManagement'
import {
  getOfficeManagementSummary, moveRouteToOffice, setUserOfficeRoutes,
  type OfficeManagementSummary,
} from '@/services/officeService'
import { db } from '@/lib/db'
import type { Office, Route, User } from '@/models/types'

/**
 * OFICINA COMO UNIDAD DE GESTIÓN — panel de una Oficina concreta.
 *
 * Todo lo que se muestra aquí (indicadores, rutas, alertas, usuarios) sale de
 * `getOfficeManagementSummary`, que recorta PRIMERO por las rutas autorizadas del
 * usuario y solo después filtra por la Oficina. Entrar a una Oficina no concede
 * ninguna ruta: un Administrador con 2 de las 5 rutas de Leticia ve 2, y la
 * cabecera lo dice explícitamente en vez de aparentar un total.
 */
export default function OfficeDetailPage() {
  const { officeId = '' } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { tenantId, currency } = useTenant()

  const [data, setData] = useState<OfficeManagementSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [offices, setOffices] = useState<Office[]>([])

  // Mover ruta de Oficina
  const [moveTarget, setMoveTarget] = useState<Route | null>(null)
  const [moveTo, setMoveTo] = useState<string>('')
  const [moving, setMoving] = useState(false)

  // Gestión de asignaciones usuario ↔ rutas de ESTA Oficina
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignUserId, setAssignUserId] = useState('')
  const [assignSelected, setAssignSelected] = useState<string[]>([])
  const [assignSaving, setAssignSaving] = useState(false)

  const load = useCallback(async () => {
    if (!user || !tenantId || !officeId) { setLoading(false); return }
    setLoading(true)
    const summary = await getOfficeManagementSummary({ user, tenantId, officeId })
    if (!summary) { setNotFound(true); setLoading(false); return }
    setData(summary)
    setOffices(await db.offices.where('tenantId').equals(tenantId).toArray())
    setLoading(false)
  }, [user, tenantId, officeId])

  useEffect(() => { load() }, [load])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
      </div>
    )
  }

  if (notFound || !data) {
    return (
      <div className="p-4 md:p-6">
        <EmptyState
          icon={<Building2 className="w-8 h-8" />}
          title="Oficina no encontrada"
          description="La oficina no existe o pertenece a otra empresa."
          action={<Button onClick={() => navigate('/admin/offices')}>Volver a Oficinas</Button>}
        />
      </div>
    )
  }

  const { office, accessibleOfficeRoutes, facts, kpis, alerts, scope, relatedUsers, assignableUsers } = data
  const officeRouteIds = accessibleOfficeRoutes.map(r => r.id)
  const puedeEditarRutas = can(user, 'route.edit', { tenantId })
  const puedeCrearRutas = can(user, 'route.create', { tenantId })
  const puedeAsignar = can(user, 'route.assign', { tenantId })
  const factOf = (routeId: string) => facts.find(f => f.routeId === routeId)

  // --- Mover ruta ---
  async function confirmMove() {
    if (!moveTarget || !user) return
    setMoving(true)
    try {
      await moveRouteToOffice(
        { routeId: moveTarget.id, tenantId, officeId: moveTo || undefined }, user,
      )
      toast.success(moveTo
        ? `${moveTarget.nombre} movida a ${offices.find(o => o.id === moveTo)?.nombre ?? 'otra oficina'}`
        : `${moveTarget.nombre} quedó ${NO_OFFICE_LABEL}`)
      setMoveTarget(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo mover la ruta')
    } finally { setMoving(false) }
  }

  // --- Asignaciones ---
  function openAssign(userId?: string) {
    const first = userId ?? assignableUsers.find(u => canManageUser(user, u))?.id ?? ''
    setAssignUserId(first)
    setAssignSelected(selectionFor(first))
    setAssignOpen(true)
  }

  /** Rutas de ESTA Oficina que el usuario ya tiene marcadas. */
  function selectionFor(userId: string): string[] {
    const rel = relatedUsers.find(r => r.id === userId)
    return rel ? rel.routes.map(r => r.id) : []
  }

  function toggleAssignRoute(routeId: string) {
    setAssignSelected(prev => prev.includes(routeId) ? prev.filter(id => id !== routeId) : [...prev, routeId])
  }

  async function saveAssignments() {
    if (!assignUserId || !user) return
    setAssignSaving(true)
    try {
      // Solo se deciden las rutas de ESTA Oficina: el servicio conserva las que el
      // usuario tenga en otras Oficinas (y las que estén Sin Oficina).
      const { authorizedRouteIds } = await setUserOfficeRoutes({
        userId: assignUserId, tenantId, officeRouteIds, selectedRouteIds: assignSelected,
      }, user)
      const fuera = authorizedRouteIds.filter(id => !officeRouteIds.includes(id)).length
      toast.success(fuera > 0
        ? `Asignaciones actualizadas. Se conservaron ${fuera} ruta(s) de otras oficinas.`
        : 'Asignaciones actualizadas')
      setAssignOpen(false)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudieron guardar las asignaciones')
    } finally { setAssignSaving(false) }
  }

  const usuarioSeleccionado = assignableUsers.find(u => u.id === assignUserId)
  // Vista previa del resultado: deja claro que no se pierden rutas de otras oficinas.
  const previewFuera = usuarioSeleccionado
    ? applyOfficeRouteSelection(
        (usuarioSeleccionado.authorizedRouteIds ?? []).concat(usuarioSeleccionado.routeId ? [usuarioSeleccionado.routeId] : []),
        officeRouteIds, assignSelected,
      ).filter(id => !officeRouteIds.includes(id)).length
    : 0

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Breadcrumbs: orientación, no una dependencia funcional. Las rutas siguen
          abriéndose igual desde /admin/routes. */}
      <nav className="flex items-center gap-1.5 text-xs text-gray-400">
        <Link to="/admin/dashboard" className="hover:text-gray-600">Empresa</Link>
        <ChevronRight className="w-3 h-3" />
        <Link to="/admin/offices" className="hover:text-gray-600">Oficinas</Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-gray-700 font-medium">{office.nombre}</span>
      </nav>

      {/* Cabecera de contexto: no se pierde de vista de qué Oficina hablamos. */}
      <div className="sticky top-0 z-10 -mx-4 md:-mx-6 px-4 md:px-6 py-3 bg-white/95 backdrop-blur border-b border-gray-100">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Building2 className="w-5 h-5 text-primary-500 flex-shrink-0" />
              <h1 className="text-xl font-bold text-gray-900 truncate">{office.nombre}</h1>
              <Badge variant={office.status === 'activa' ? 'success' : 'danger'}>
                {office.status === 'activa' ? 'Activa' : 'Inactiva'}
              </Badge>
            </div>
            <p className="text-xs text-gray-500 mt-0.5 ml-7">
              {office.codigo ? `Código: ${office.codigo} · ` : ''}
              <span className={scope.parcial ? 'font-medium text-amber-600' : ''}>{scope.label}</span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {puedeCrearRutas && (
              // Reutiliza el flujo de creación existente; la Oficina llega preseleccionada.
              <Button size="sm" icon={<Plus className="w-3.5 h-3.5" />}
                onClick={() => navigate(`/admin/routes?nueva=1&officeId=${office.id}`)}>
                Nueva ruta
              </Button>
            )}
            {puedeAsignar && accessibleOfficeRoutes.length > 0 && (
              <Button size="sm" variant="secondary" icon={<UserCog className="w-3.5 h-3.5" />} onClick={() => openAssign()}>
                Gestionar asignaciones
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Indicadores — calculados SOLO sobre las rutas accesibles de esta Oficina. */}
      <div>
        <p className="text-xs text-gray-400 mb-2">
          Indicadores calculados sobre tus rutas autorizadas en esta oficina.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <Card className="text-center py-3">
            <p className="text-lg font-bold text-primary-600">{kpis.rutasVisibles}</p>
            <p className="text-xs text-gray-400">Rutas visibles</p>
          </Card>
          <Card className="text-center py-3">
            <p className="text-lg font-bold text-emerald-600">{kpis.rutasOperativas}</p>
            <p className="text-xs text-gray-400">Operativas</p>
          </Card>
          <Card className="text-center py-3">
            <p className={`text-lg font-bold ${kpis.rutasSinCobrador > 0 ? 'text-amber-600' : 'text-gray-400'}`}>{kpis.rutasSinCobrador}</p>
            <p className="text-xs text-gray-400">Sin Cobrador</p>
          </Card>
          <Card className="text-center py-3">
            <p className="text-lg font-bold text-gray-700">{kpis.clientesActivos}</p>
            <p className="text-xs text-gray-400">Clientes activos</p>
          </Card>
          <Card className="text-center py-3">
            <p className="text-lg font-bold text-gray-700">{kpis.ventasActivas}</p>
            <p className="text-xs text-gray-400">Ventas activas</p>
          </Card>
          <Card className="text-center py-3">
            <p className={`text-lg font-bold ${kpis.desembolsosPendientes > 0 ? 'text-amber-600' : 'text-gray-400'}`}>{kpis.desembolsosPendientes}</p>
            <p className="text-xs text-gray-400">Desembolsos pend.</p>
          </Card>
        </div>
        {kpis.carteraEnCalle > 0 && (
          <div className="mt-3 bg-indigo-50 rounded-xl p-3 flex items-center justify-between">
            <p className="text-xs text-gray-500">Cartera activa de tus rutas en esta oficina</p>
            <p className="text-sm font-bold text-indigo-600">{formatCurrency(kpis.carteraEnCalle, currency)}</p>
          </div>
        )}
      </div>

      {/* Alertas derivadas: se recalculan al abrir, no hay tabla de alertas. */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-700">Alertas</h2>
          {alerts.map((a, i) => (
            <div key={`${a.kind}-${a.routeId ?? 'office'}-${i}`}
              className={`flex items-start gap-3 p-3 rounded-xl border ${a.severity === 'error' ? 'bg-red-50 border-red-100' : 'bg-amber-50 border-amber-100'}`}>
              <AlertTriangle className={`w-4 h-4 mt-0.5 flex-shrink-0 ${a.severity === 'error' ? 'text-red-500' : 'text-amber-500'}`} />
              <p className={`text-xs ${a.severity === 'error' ? 'text-red-700' : 'text-amber-800'}`}>{a.mensaje}</p>
            </div>
          ))}
        </div>
      )}

      {/* Rutas de la Oficina */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">Rutas de esta oficina</h2>
          <Link to={`/admin/routes?officeId=${office.id}`} className="text-xs text-primary-600 hover:underline">Ver estas rutas</Link>
        </div>

        {accessibleOfficeRoutes.length === 0 ? (
          <EmptyState
            icon={<MapPin className="w-8 h-8" />}
            title={scope.totales > 0 ? 'No tienes rutas autorizadas en esta oficina' : 'Esta oficina no tiene rutas'}
            description={scope.totales > 0
              ? `La oficina tiene ${scope.totales} ruta(s), pero ninguna está asignada a tu usuario.`
              : 'Puedes crear una ruta y asignarla a esta oficina.'}
            action={puedeCrearRutas && scope.totales === 0
              ? <Button onClick={() => navigate(`/admin/routes?nueva=1&officeId=${office.id}`)} icon={<Plus className="w-4 h-4" />}>Crear ruta</Button>
              : undefined}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {accessibleOfficeRoutes.map(route => {
              const f = factOf(route.id)
              return (
                <Card key={route.id} className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <MapPin className="w-4 h-4 text-primary-500 flex-shrink-0" />
                        <h3 className="font-semibold text-gray-900 text-sm truncate">{route.nombre}</h3>
                      </div>
                      <p className="text-xs text-gray-400 ml-6">{route.codigo}{route.ciudad ? ` · ${route.ciudad}` : ''}</p>
                    </div>
                    {f && (
                      <Badge variant={f.state === 'operativa' ? 'success' : f.state === 'inactiva' ? 'gray' : 'warning'}>
                        {ROUTE_STATE_LABEL[f.state]}
                      </Badge>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div className="bg-gray-50 rounded-xl p-2 text-center">
                      <p className="text-sm font-bold text-gray-700">{f?.clientesActivos ?? 0}</p>
                      <p className="text-xs text-gray-400">Clientes</p>
                    </div>
                    <div className="bg-gray-50 rounded-xl p-2 text-center">
                      <p className="text-sm font-bold text-gray-700">{f?.ventasActivas ?? 0}</p>
                      <p className="text-xs text-gray-400">Ventas</p>
                    </div>
                    <div className="bg-gray-50 rounded-xl p-2 text-center">
                      <p className={`text-sm font-bold ${(f?.desembolsosPendientes ?? 0) > 0 ? 'text-amber-600' : 'text-gray-700'}`}>{f?.desembolsosPendientes ?? 0}</p>
                      <p className="text-xs text-gray-400">Desemb.</p>
                    </div>
                  </div>

                  {/* Usuarios de ESTA oficina asignados a la ruta. */}
                  <div className="border-t border-gray-50 pt-2">
                    {(() => {
                      const enRuta = relatedUsers.filter(u => u.routes.some(r => r.id === route.id))
                      if (enRuta.length === 0) return <p className="text-xs text-gray-400">Sin usuarios asignados</p>
                      return (
                        <p className="text-xs text-gray-600 leading-snug">
                          <span className="font-medium text-gray-500">Equipo: </span>
                          {enRuta.slice(0, 3).map(u => u.nombre).join(', ')}
                          {enRuta.length > 3 && <span className="text-gray-400"> +{enRuta.length - 3} más</span>}
                        </p>
                      )
                    })()}
                  </div>

                  <div className="flex gap-2 pt-1">
                    {puedeEditarRutas && (
                      <Button variant="secondary" size="sm" className="flex-1" icon={<Edit className="w-3.5 h-3.5" />}
                        onClick={() => navigate(`/admin/routes?editar=${route.id}`)}>Editar</Button>
                    )}
                    {puedeEditarRutas && (
                      <Button variant="ghost" size="sm" className="flex-1" icon={<ArrowRightLeft className="w-3.5 h-3.5" />}
                        onClick={() => { setMoveTarget(route); setMoveTo('') }}>Mover</Button>
                    )}
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Usuarios RELACIONADOS — derivados de authorizedRouteIds ∩ rutas de la oficina */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">Usuarios con rutas asignadas en esta oficina</h2>
          {puedeAsignar && accessibleOfficeRoutes.length > 0 && (
            <button onClick={() => openAssign()} className="text-xs text-primary-600 hover:underline">Gestionar</button>
          )}
        </div>
        <p className="text-xs text-gray-400">
          Los usuarios pertenecen a la empresa, no a la oficina. Aquí se muestran sus rutas
          <span className="font-medium"> de esta oficina</span>; las de otras oficinas no se ven ni se modifican desde aquí.
        </p>

        {relatedUsers.length === 0 ? (
          <Card><p className="text-xs text-gray-400">Ningún usuario tiene rutas asignadas en esta oficina todavía.</p></Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {relatedUsers.map(u => (
              <Card key={u.id} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Users className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    <p className="text-sm font-semibold text-gray-800 truncate">{u.nombre}</p>
                  </div>
                  <Badge variant="gray">{ROLE_LABELS[u.rol]}</Badge>
                </div>
                <ul className="space-y-0.5 ml-6">
                  {u.routes.map(r => (
                    <li key={r.id} className="text-xs text-gray-600 flex items-center gap-1.5">
                      <MapPin className="w-3 h-3 text-primary-400" />{r.nombre}
                    </li>
                  ))}
                </ul>
                {puedeAsignar && (
                  <button onClick={() => openAssign(u.id)} className="text-xs text-primary-600 hover:underline ml-6">
                    Editar sus rutas de esta oficina
                  </button>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* ACCESOS RÁPIDOS CON CONTEXTO: cada destino recibe `?officeId=` y abre ya
          filtrado por esta Oficina, sobre las rutas que el usuario tenga autorizadas.
          No son enlaces al módulo general. */}
      <div className="pt-2 border-t border-gray-100 space-y-2">
        <p className="text-xs text-gray-400">
          Estos accesos abren cada módulo filtrado por <span className="font-medium">{office.nombre}</span>,
          con tus rutas autorizadas de esta oficina.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" icon={<Users className="w-3.5 h-3.5" />}
            onClick={() => navigate(`/admin/clients?officeId=${office.id}`)}>Ver Clientes</Button>
          <Button variant="ghost" size="sm" icon={<CreditCard className="w-3.5 h-3.5" />}
            onClick={() => navigate(`/admin/active-sales?officeId=${office.id}`)}>Ver Ventas</Button>
          <Button variant="ghost" size="sm" icon={<Archive className="w-3.5 h-3.5" />}
            onClick={() => navigate(`/admin/cashbox?officeId=${office.id}`)}>Ver Caja</Button>
          <Button variant="ghost" size="sm" icon={<BarChart3 className="w-3.5 h-3.5" />}
            onClick={() => navigate(`/admin/reports?officeId=${office.id}`)}>Ver Reportes</Button>
          <Button variant="ghost" size="sm" icon={<CalendarRange className="w-3.5 h-3.5" />}
            onClick={() => navigate(`/admin/weekly-settlement?officeId=${office.id}`)}>Liquidación</Button>
          <Button variant="ghost" size="sm" icon={<MapPin className="w-3.5 h-3.5" />}
            onClick={() => navigate(`/admin/routes?officeId=${office.id}`)}>Ver Rutas</Button>
        </div>
      </div>

      {/* Mover ruta de Oficina */}
      <Modal open={!!moveTarget} onClose={() => setMoveTarget(null)} title="Mover ruta de oficina" size="sm"
        footer={<><Button variant="secondary" onClick={() => setMoveTarget(null)} disabled={moving}>Cancelar</Button><Button onClick={confirmMove} loading={moving}>Mover</Button></>}>
        <div className="space-y-4">
          <div className="bg-gray-50 rounded-xl p-3 space-y-1">
            <p className="text-sm font-semibold text-gray-800">{moveTarget?.nombre}</p>
            <p className="text-xs text-gray-500">Oficina actual: <span className="font-medium text-gray-700">{office.nombre}</span></p>
            <p className="text-xs text-gray-500">
              Nueva oficina: <span className="font-medium text-gray-700">
                {moveTo ? (offices.find(o => o.id === moveTo)?.nombre ?? '—') : NO_OFFICE_LABEL}
              </span>
            </p>
          </div>
          <Select label="Mover a" value={moveTo} onChange={e => setMoveTo(e.target.value)}
            options={offices.filter(o => o.id !== office.id).map(o => ({
              value: o.id, label: o.status === 'inactiva' ? `${o.nombre} (inactiva)` : o.nombre,
            }))}
            placeholder={`${NO_OFFICE_LABEL} (quitar de la oficina)`} />
          <p className="text-xs text-gray-400">
            Solo cambia la oficina de la ruta. Sus clientes, ventas, pagos y los usuarios
            asignados no se modifican.
          </p>
        </div>
      </Modal>

      {/* Gestión de asignaciones: SOLO rutas de esta Oficina */}
      <Modal open={assignOpen} onClose={() => setAssignOpen(false)} title="Asignar rutas de esta oficina" size="md"
        footer={<><Button variant="secondary" onClick={() => setAssignOpen(false)} disabled={assignSaving}>Cancelar</Button><Button onClick={saveAssignments} loading={assignSaving} disabled={!assignUserId}>Guardar</Button></>}>
        <div className="space-y-4">
          <Select label="Usuario" value={assignUserId}
            onChange={e => { setAssignUserId(e.target.value); setAssignSelected(selectionFor(e.target.value)) }}
            options={assignableUsers.filter(u => canManageUser(user, u)).map(u => ({ value: u.id, label: `${u.nombre} · ${ROLE_LABELS[u.rol]}` }))}
            placeholder="Selecciona un usuario" />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Rutas de {office.nombre}</label>
            {accessibleOfficeRoutes.length === 0 ? (
              <p className="text-xs text-gray-400">No hay rutas que puedas asignar en esta oficina.</p>
            ) : (
              <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                {accessibleOfficeRoutes.map(r => {
                  const marcada = assignSelected.includes(r.id)
                  return (
                    <button key={r.id} type="button" onClick={() => toggleAssignRoute(r.id)}
                      className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border text-left transition-colors ${marcada ? 'bg-primary-50 border-primary-200' : 'bg-white border-gray-200 hover:bg-gray-50'}`}>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{r.nombre}</p>
                        <p className="text-xs text-gray-400">{r.codigo}</p>
                      </div>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${marcada ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-500'}`}>
                        {marcada ? 'Asignada' : 'Asignar'}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="flex items-start gap-3 p-3 rounded-xl bg-gray-50 border border-gray-200">
            <AlertTriangle className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-gray-600">
              Aquí solo se deciden las rutas de <span className="font-medium">{office.nombre}</span>.
              {previewFuera > 0
                ? <> Este usuario conserva además <span className="font-medium">{previewFuera} ruta(s)</span> de otras oficinas, que no se tocan.</>
                : ' Las rutas que tenga en otras oficinas no se modifican.'}
            </p>
          </div>
        </div>
      </Modal>
    </div>
  )
}

/** Tipo auxiliar: evita importar `User` sin uso cuando cambia la firma. */
export type { User as OfficeDetailUser }
