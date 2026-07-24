import { useState, useEffect, useMemo } from 'react'
import { Search, Users, Lock } from 'lucide-react'
import { Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useAccessibleRoutes } from '@/hooks/useAccessibleRoutes'
import { filterByAccessibleRoute, can } from '@/lib/permissions'
import { logAction } from '@/services/auditService'
import { nowISO } from '@/lib/formatters'
import type { Client } from '@/models/types'

/**
 * Clientes del SECRETARIO: consulta + EDICIÓN LIMITADA a datos operativos
 * (nombre, teléfonos, direcciones, negocio, observaciones). NO puede crear
 * clientes, ni tocar documento (si hay movimientos), saldos, historial ni ruta.
 * Toda edición queda auditada (before/after) y limitada a sus rutas autorizadas.
 */
const EDITABLE_FIELDS = ['nombre', 'telefonoPrincipal', 'telefonoSecundario', 'direccionPrincipal', 'direccionSecundaria', 'negocio', 'notas'] as const
type EditableField = typeof EDITABLE_FIELDS[number]

export default function SecretarioClientsPage() {
  const { user } = useAuth()
  const { routes } = useAccessibleRoutes()
  const [clients, setClients] = useState<Client[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Client | null>(null)
  const [hasMovements, setHasMovements] = useState(false)
  const [form, setForm] = useState<Record<EditableField, string>>({ nombre: '', telefonoPrincipal: '', telefonoSecundario: '', direccionPrincipal: '', direccionSecundaria: '', negocio: '', notas: '' })
  const [saving, setSaving] = useState(false)

  useEffect(() => { load() }, [user, routes.length])

  async function load() {
    if (!user) return
    setLoading(true)
    const cs = await db.clients.where('tenantId').equals(user.tenantId).toArray()
    setClients(filterByAccessibleRoute(user, cs))
    setLoading(false)
  }

  async function openEdit(c: Client) {
    if (!user || !can(user, 'client.editLimited', { routeId: c.routeId })) {
      toast.error('No puedes editar este cliente (fuera de tus rutas).')
      return
    }
    setEditing(c)
    setForm({
      nombre: c.nombre, telefonoPrincipal: c.telefonoPrincipal, telefonoSecundario: c.telefonoSecundario ?? '',
      direccionPrincipal: c.direccionPrincipal, direccionSecundaria: c.direccionSecundaria ?? '',
      negocio: c.negocio ?? '', notas: c.notas ?? '',
    })
    // documento bloqueado si el cliente ya tiene ventas (movimientos).
    const salesCount = await db.sales.where('clientId').equals(c.id).count()
    setHasMovements(salesCount > 0)
  }

  async function handleSave() {
    if (!editing || !user) return
    if (!form.nombre.trim()) { toast.error('El nombre es requerido'); return }
    setSaving(true)
    try {
      const before: Record<string, unknown> = {}
      const after: Record<string, unknown> = {}
      for (const f of EDITABLE_FIELDS) {
        const prev = (editing[f] ?? '') as string
        const next = form[f].trim()
        if (prev !== next) { before[f] = prev; after[f] = next }
      }
      if (Object.keys(after).length === 0) { toast.info('Sin cambios'); setEditing(null); setSaving(false); return }
      await db.clients.update(editing.id, {
        nombre: form.nombre.trim(),
        telefonoPrincipal: form.telefonoPrincipal.trim(),
        telefonoSecundario: form.telefonoSecundario.trim() || undefined,
        direccionPrincipal: form.direccionPrincipal.trim(),
        direccionSecundaria: form.direccionSecundaria.trim() || undefined,
        negocio: form.negocio.trim() || undefined,
        notas: form.notas.trim() || undefined,
        updatedAt: nowISO(),
      })
      await logAction({
        tenantId: user.tenantId, userId: user.id, userRole: user.rol, routeId: editing.routeId,
        action: 'UPDATE_CLIENT', entityType: 'Client', entityId: editing.id,
        descripcion: `Secretario editó datos operativos de ${editing.nombre}`, before, after,
      })
      toast.success('Cliente actualizado')
      setEditing(null)
      await load()
    } catch { toast.error('Error al guardar') } finally { setSaving(false) }
  }

  const routeName = (id: string) => routes.find(r => r.id === id)?.nombre ?? '—'
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return clients.filter(c => !q || c.nombre.toLowerCase().includes(q) || c.documento.includes(q)).sort((a, b) => a.nombre.localeCompare(b.nombre))
  }, [clients, search])

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Clientes</h1>
        <p className="text-sm text-gray-500 mt-0.5">{filtered.length} cliente(s) · edición de datos operativos</p>
      </div>

      <div className="max-w-sm">
        <Input placeholder="Buscar por nombre o documento…" value={search} onChange={e => setSearch(e.target.value)} leftIcon={<Search className="w-4 h-4" />} />
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<Users className="w-8 h-8" />} title="Sin clientes" description="No hay clientes en tus rutas autorizadas." />
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 divide-y divide-gray-50">
          {filtered.map(c => (
            <button key={c.id} onClick={() => openEdit(c)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-primary-50/40 transition-colors">
              <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center text-primary-700 font-bold text-sm flex-shrink-0">{c.nombre.charAt(0)}</div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{c.nombre}</p>
                <p className="text-xs text-gray-400 truncate">{c.documento} · {c.telefonoPrincipal} · {routeName(c.routeId)}</p>
              </div>
            </button>
          ))}
        </div>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} title="Editar cliente"
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>Guardar</Button></>}>
        <div className="space-y-3">
          <div className="flex items-center gap-2 p-2.5 bg-gray-50 rounded-xl text-xs text-gray-500">
            <Lock className="w-3.5 h-3.5" />
            Documento: <span className="font-semibold text-gray-700">{editing?.documento}</span>
            {hasMovements ? ' (bloqueado: cliente con movimientos)' : ' (no editable aquí)'}
          </div>
          <Input label="Nombre" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Teléfono principal" value={form.telefonoPrincipal} onChange={e => setForm(f => ({ ...f, telefonoPrincipal: e.target.value }))} />
            <Input label="Teléfono secundario" value={form.telefonoSecundario} onChange={e => setForm(f => ({ ...f, telefonoSecundario: e.target.value }))} />
          </div>
          <Input label="Dirección" value={form.direccionPrincipal} onChange={e => setForm(f => ({ ...f, direccionPrincipal: e.target.value }))} />
          <Input label="Dirección de negocio" value={form.direccionSecundaria} onChange={e => setForm(f => ({ ...f, direccionSecundaria: e.target.value }))} />
          <Input label="Negocio" value={form.negocio} onChange={e => setForm(f => ({ ...f, negocio: e.target.value }))} />
          <Textarea label="Observaciones" rows={2} value={form.notas} onChange={e => setForm(f => ({ ...f, notas: e.target.value }))} />
        </div>
      </Modal>
    </div>
  )
}
