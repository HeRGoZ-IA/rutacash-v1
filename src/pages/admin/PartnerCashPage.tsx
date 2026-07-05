import { useState, useEffect } from 'react'
import { Plus, Users, ChevronRight, ArrowDownCircle, ArrowUpCircle, Link2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { ModuleTabs, CASHBOX_TABS } from '@/components/ui/ModuleTabs'
import { DateRangeFilter } from '@/components/ui/DateRangeFilter'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { formatCurrency, formatDate, today } from '@/lib/formatters'
import {
  getPartners, buildPartnerSummaries, createPartnerMovement,
  type PartnerCashSummary,
} from '@/services/partnerCashService'
import type { PartnerCashMovement, PartnerCashCategory, PartnerCashType, User } from '@/models/types'

// Categorías por tipo (Revisión 2).
const INGRESO_CATEGORIES: { value: PartnerCashCategory; label: string }[] = [
  { value: 'ingreso', label: 'Ingreso' },
  { value: 'inversion', label: 'Inversión' },
  { value: 'otro', label: 'Otro' },
]
const SALIDA_CATEGORIES: { value: PartnerCashCategory; label: string }[] = [
  { value: 'reembolso', label: 'Reembolso' },
  { value: 'inversion', label: 'Inversión' },
  { value: 'retiro', label: 'Retiro' },
  { value: 'envio_exterior', label: 'Envío al exterior' },
  { value: 'otro', label: 'Otro' },
]

const CATEGORY_LABEL: Record<string, string> = {
  ingreso: 'Ingreso', reembolso: 'Reembolso', inversion: 'Inversión',
  retiro: 'Retiro', envio_exterior: 'Envío al exterior', transferencia: 'Transferencia', otro: 'Otro',
}

export default function PartnerCashPage() {
  const { tenantId, currency } = useTenant()
  const { user } = useAuth()
  const [partners, setPartners] = useState<User[]>([])
  const [movements, setMovements] = useState<PartnerCashMovement[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [detailGroup, setDetailGroup] = useState<PartnerCashSummary | null>(null)
  // Filtro por fecha
  const [desde, setDesde] = useState('')
  const [hasta, setHasta] = useState('')
  const [form, setForm] = useState({
    partnerId: '', type: 'ingreso' as PartnerCashType,
    category: 'ingreso' as PartnerCashCategory, amount: 0, description: '', fecha: today(),
  })

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const [ps, movs] = await Promise.all([
      getPartners(tenantId),
      db.partnerCashMovements.where('tenantId').equals(tenantId).toArray(),
    ])
    setPartners(ps)
    setMovements(movs)
    setLoading(false)
  }

  // Movimientos filtrados por rango de fecha (si se define).
  const filteredMovs = movements.filter(m =>
    (!desde || m.fecha >= desde) && (!hasta || m.fecha <= hasta)
  )
  const groups = buildPartnerSummaries(partners, filteredMovs)

  function openCreate() {
    setForm({ partnerId: partners[0]?.id ?? '', type: 'ingreso', category: 'ingreso', amount: 0, description: '', fecha: today() })
    setModalOpen(true)
  }

  function handleTypeChange(type: PartnerCashType) {
    // Al cambiar el tipo, reiniciar la categoría a la primera válida.
    const cats = type === 'ingreso' ? INGRESO_CATEGORIES : SALIDA_CATEGORIES
    setForm(f => ({ ...f, type, category: cats[0].value }))
  }

  async function handleSave() {
    if (!form.partnerId) { toast.error('Selecciona un socio'); return }
    if (form.amount <= 0) { toast.error('El valor debe ser mayor a 0'); return }
    setSaving(true)
    try {
      await createPartnerMovement({
        tenantId, partnerId: form.partnerId, type: form.type, category: form.category,
        amount: form.amount, description: form.description || undefined, fecha: form.fecha,
        createdBy: user?.id,
      })
      toast.success('Movimiento registrado en Caja socios')
      setModalOpen(false)
      await load()
    } catch { toast.error('Error al guardar') } finally { setSaving(false) }
  }

  const availableCategories = form.type === 'ingreso' ? INGRESO_CATEGORIES : SALIDA_CATEGORIES

  return (
    <div className="p-4 md:p-6 space-y-6">
      <ModuleTabs tabs={CASHBOX_TABS} />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Caja socios</h1>
          <p className="text-sm text-gray-500 mt-0.5">{partners.length} socio(s) · {filteredMovs.length} movimiento(s)</p>
        </div>
        <Button onClick={openCreate} icon={<Plus className="w-4 h-4" />} disabled={partners.length === 0}>Nuevo movimiento</Button>
      </div>

      {/* Filtro por fecha (compacto) */}
      <DateRangeFilter desde={desde} hasta={hasta} onDesde={setDesde} onHasta={setHasta}
        onClear={() => { setDesde(''); setHasta('') }} />

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : partners.length === 0 ? (
        <EmptyState icon={<Users className="w-8 h-8" />} title="No hay socios" description="Crea un usuario con rol Socio en el módulo Usuarios para usar Caja socios." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {groups.map(g => (
            <div key={g.partnerId} className="bg-white rounded-2xl shadow-card border border-gray-100 p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-9 h-9 bg-purple-100 rounded-xl flex items-center justify-center flex-shrink-0">
                    <Users className="w-4 h-4 text-purple-600" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{g.nombre}</p>
                    <Badge variant="purple" size="sm">Socio</Badge>
                  </div>
                </div>
                <span className="text-xs text-gray-400">{g.cantidad} mov.</span>
              </div>

              <div className="grid grid-cols-2 gap-2 mt-3">
                <div className="bg-emerald-50 rounded-xl p-2.5">
                  <p className="text-xs text-gray-400">Ingresos</p>
                  <p className="text-sm font-bold text-emerald-600">{formatCurrency(g.totalIngresos, currency)}</p>
                </div>
                <div className="bg-red-50 rounded-xl p-2.5">
                  <p className="text-xs text-gray-400">Salidas</p>
                  <p className="text-sm font-bold text-red-600">{formatCurrency(g.totalSalidas, currency)}</p>
                </div>
              </div>
              <div className="mt-2 bg-gray-50 rounded-xl p-2.5 flex items-center justify-between">
                <p className="text-xs text-gray-400">Saldo socio</p>
                <p className={`text-sm font-bold ${g.saldo >= 0 ? 'text-gray-800' : 'text-red-600'}`}>{formatCurrency(g.saldo, currency)}</p>
              </div>

              <div className="flex items-center justify-between mt-3">
                <p className="text-xs text-gray-400">
                  {g.ultimoMovimiento ? `Último: ${formatDate(g.ultimoMovimiento)}` : 'Sin movimientos'}
                </p>
                <Button variant="secondary" size="sm" disabled={g.cantidad === 0} onClick={() => setDetailGroup(g)} icon={<ChevronRight className="w-3.5 h-3.5" />}>
                  Ver movimientos
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Nuevo movimiento */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Nuevo movimiento de Caja socios"
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>Registrar</Button></>}>
        <div className="space-y-4">
          <Select label="Socio" value={form.partnerId} onChange={e => setForm(f => ({ ...f, partnerId: e.target.value }))}
            options={partners.map(p => ({ value: p.id, label: p.nombre }))} placeholder="Seleccionar socio" required />
          <div className="grid grid-cols-2 gap-3">
            <Select label="Tipo" value={form.type} onChange={e => handleTypeChange(e.target.value as PartnerCashType)}
              options={[{ value: 'ingreso', label: 'Ingreso' }, { value: 'salida', label: 'Salida' }]} required />
            <Select label="Categoría" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value as PartnerCashCategory }))}
              options={availableCategories} required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <MoneyInput label="Valor" currency={currency} value={form.amount} onValueChange={v => setForm(f => ({ ...f, amount: v }))} required />
            <Input label="Fecha" type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
          </div>
          <Textarea label="Observación" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} />
        </div>
      </Modal>

      {/* Detalle de movimientos de un socio */}
      <Modal open={!!detailGroup} onClose={() => setDetailGroup(null)} title={detailGroup ? `Movimientos · ${detailGroup.nombre}` : 'Movimientos'} size="lg"
        footer={<Button variant="secondary" onClick={() => setDetailGroup(null)}>Cerrar</Button>}>
        {detailGroup && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-emerald-50 rounded-xl p-3"><p className="text-xs text-gray-400">Ingresos</p><p className="font-bold text-emerald-600">{formatCurrency(detailGroup.totalIngresos, currency)}</p></div>
              <div className="bg-red-50 rounded-xl p-3"><p className="text-xs text-gray-400">Salidas</p><p className="font-bold text-red-600">{formatCurrency(detailGroup.totalSalidas, currency)}</p></div>
              <div className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-400">Saldo</p><p className="font-bold text-gray-800">{formatCurrency(detailGroup.saldo, currency)}</p></div>
            </div>
            {detailGroup.movements.length === 0 ? (
              <div className="flex justify-center py-8 text-gray-400 text-sm">Este socio no tiene movimientos</div>
            ) : (
              <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
                {detailGroup.movements.map(m => (
                  <div key={m.id} className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${m.type === 'ingreso' ? 'bg-emerald-50' : 'bg-red-50'}`}>
                        {m.type === 'ingreso' ? <ArrowDownCircle className="w-4 h-4 text-emerald-600" /> : <ArrowUpCircle className="w-4 h-4 text-red-500" />}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900 flex items-center gap-1.5">
                          {CATEGORY_LABEL[m.category] ?? m.category}
                          {m.relatedTransferId && <Link2 className="w-3 h-3 text-gray-400" aria-label="Origen: transferencia" />}
                        </p>
                        <p className="text-xs text-gray-400">{formatDate(m.fecha)}{m.description ? ` · ${m.description}` : ''}{m.relatedTransferId ? ' · desde Transferencias' : ''}</p>
                      </div>
                    </div>
                    <span className={`text-sm font-bold ${m.type === 'ingreso' ? 'text-emerald-600' : 'text-red-500'}`}>
                      {m.type === 'ingreso' ? '+' : '-'}{formatCurrency(m.amount, currency)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
