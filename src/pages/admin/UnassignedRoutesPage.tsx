import { useState, useEffect, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { MapPin, Building2, ChevronRight, AlertTriangle, CheckSquare, Square } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Select } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { can, filterAccessibleRoutes } from '@/lib/permissions'
import { NO_OFFICE_LABEL } from '@/lib/officeGrouping'
import { unassignedRoutesOf } from '@/lib/officeManagement'
import { assignRoutesToOffice } from '@/services/officeService'
import type { Office, Route } from '@/models/types'

/**
 * "SIN OFICINA" — área administrable, no una Oficina.
 *
 * No existe ningún registro `Office` llamado "Sin Oficina": es una agrupación
 * DERIVADA de `route.officeId === undefined`. Aquí es donde quedaron las rutas que
 * ya existían cuando se introdujeron las Oficinas (migración v11), y desde aquí se
 * organizan.
 *
 * Como en el resto del sistema, solo se listan las rutas que el usuario tiene
 * autorizadas: estar "Sin Oficina" no expone ninguna ruta ajena.
 */
export default function UnassignedRoutesPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { tenantId } = useTenant()
  const [routes, setRoutes] = useState<Route[]>([])
  const [offices, setOffices] = useState<Office[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [destino, setDestino] = useState('')
  const [saving, setSaving] = useState(false)

  const puedeEditar = can(user, 'route.edit', { tenantId })

  const load = useCallback(async () => {
    if (!tenantId) { setLoading(false); return }
    setLoading(true)
    const all = await db.routes.where('tenantId').equals(tenantId).toArray()
    // Scoping primero, agrupación después: igual que en todas las demás vistas.
    setRoutes(unassignedRoutesOf(filterAccessibleRoutes(user, all)))
    setOffices((await db.offices.where('tenantId').equals(tenantId).toArray())
      .sort((a, b) => a.nombre.localeCompare(b.nombre)))
    setSelected([])
    setLoading(false)
  }, [user, tenantId])

  useEffect(() => { load() }, [load])

  const toggle = (id: string) => setSelected(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])
  const toggleAll = () => setSelected(p => p.length === routes.length ? [] : routes.map(r => r.id))

  async function asignar(routeIds: string[]) {
    if (!user || routeIds.length === 0) return
    if (!destino) { toast.error('Selecciona la oficina de destino.'); return }
    setSaving(true)
    try {
      // Transaccional: o se mueven todas o no se mueve ninguna.
      const { moved } = await assignRoutesToOffice({ routeIds, tenantId, officeId: destino }, user)
      const nombre = offices.find(o => o.id === destino)?.nombre ?? 'la oficina'
      toast.success(moved.length === 1
        ? `Ruta asignada a ${nombre}`
        : `${moved.length} rutas asignadas a ${nombre}`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudieron asignar las rutas')
    } finally { setSaving(false) }
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <nav className="flex items-center gap-1.5 text-xs text-gray-400">
        <Link to="/admin/dashboard" className="hover:text-gray-600">Empresa</Link>
        <ChevronRight className="w-3 h-3" />
        <Link to="/admin/offices" className="hover:text-gray-600">Oficinas</Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-gray-700 font-medium">{NO_OFFICE_LABEL}</span>
      </nav>

      <div>
        <div className="flex items-center gap-2">
          <MapPin className="w-5 h-5 text-gray-400" />
          <h1 className="text-xl font-bold text-gray-900">{NO_OFFICE_LABEL}</h1>
          <Badge variant="gray">Agrupación</Badge>
        </div>
        <p className="text-sm text-gray-500 mt-1 ml-7">
          {routes.length} ruta(s) pendiente(s) de organizar
        </p>
      </div>

      <div className="flex items-start gap-3 p-4 rounded-2xl bg-gray-50 border border-gray-200">
        <AlertTriangle className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-gray-600">
          Esto <span className="font-medium">no es una oficina</span>: es el conjunto de rutas que
          todavía no pertenecen a ninguna. Es un estado válido — una ruta puede quedarse aquí
          indefinidamente y opera con total normalidad. Asignarle una oficina solo la reagrupa:
          no cambia sus clientes, ventas, pagos ni los usuarios que la tienen asignada.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
        </div>
      ) : routes.length === 0 ? (
        <EmptyState
          icon={<Building2 className="w-8 h-8" />}
          title="Todas tus rutas tienen oficina"
          description="No hay rutas pendientes de organizar."
          action={<Button onClick={() => navigate('/admin/offices')}>Volver a Oficinas</Button>}
        />
      ) : (
        <>
          {puedeEditar && (
            <Card className="space-y-3">
              <p className="text-sm font-semibold text-gray-700">Asignar oficina</p>
              <div className="flex flex-wrap items-end gap-3">
                <Select label="Oficina de destino" value={destino} onChange={e => setDestino(e.target.value)}
                  options={offices.map(o => ({
                    value: o.id, label: o.status === 'inactiva' ? `${o.nombre} (inactiva)` : o.nombre,
                  }))}
                  placeholder="Selecciona una oficina" className="w-64"
                  hint={offices.length === 0 ? 'Aún no hay oficinas creadas.' : undefined} />
                <Button onClick={() => asignar(selected)} loading={saving}
                  disabled={selected.length === 0 || !destino}>
                  Asignar {selected.length > 0 ? `${selected.length} seleccionada(s)` : 'seleccionadas'}
                </Button>
                <Button variant="ghost" size="sm" onClick={toggleAll}
                  icon={selected.length === routes.length ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}>
                  {selected.length === routes.length ? 'Quitar selección' : 'Seleccionar todas'}
                </Button>
              </div>
            </Card>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {routes.map(route => {
              const marcada = selected.includes(route.id)
              return (
                <Card key={route.id} className={`space-y-3 ${marcada ? 'ring-2 ring-primary-200' : ''}`}>
                  <button type="button" onClick={() => puedeEditar && toggle(route.id)}
                    className="w-full flex items-start justify-between gap-2 text-left">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <MapPin className="w-4 h-4 text-primary-500 flex-shrink-0" />
                        <h3 className="font-semibold text-gray-900 text-sm truncate">{route.nombre}</h3>
                      </div>
                      <p className="text-xs text-gray-400 ml-6">{route.codigo}{route.ciudad ? ` · ${route.ciudad}` : ''}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant={route.status === 'activa' ? 'success' : 'gray'}>
                        {route.status === 'activa' ? 'Activa' : 'Inactiva'}
                      </Badge>
                      {puedeEditar && (
                        marcada
                          ? <CheckSquare className="w-4 h-4 text-primary-600" />
                          : <Square className="w-4 h-4 text-gray-300" />
                      )}
                    </div>
                  </button>

                  {puedeEditar && (
                    <Button variant="secondary" size="sm" className="w-full"
                      icon={<Building2 className="w-3.5 h-3.5" />}
                      loading={saving}
                      disabled={!destino}
                      onClick={() => asignar([route.id])}>
                      Asignar oficina
                    </Button>
                  )}
                </Card>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
