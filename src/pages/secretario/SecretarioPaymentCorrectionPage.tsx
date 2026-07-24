import { useState, useEffect, useMemo } from 'react'
import { Search, Receipt, AlertTriangle, Lock, RotateCcw } from 'lucide-react'
import { Input, Textarea } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { filterByAccessibleRoute } from '@/lib/permissions'
import { formatCurrency, formatDate, today } from '@/lib/formatters'
import { correctPayment, requestPaymentAdjustment, isPaymentInClosedPeriod } from '@/services/paymentCorrectionService'
import type { Payment, Client } from '@/models/types'

/**
 * CORRECCIÓN CONTROLADA DE PAGOS (Secretario).
 * Muestra los pagos vigentes de las rutas autorizadas. Al corregir:
 *  - Periodo ABIERTO  → reversión + reemplazo inmediatos (no destructivo).
 *  - Periodo CERRADO  → genera Solicitud de ajuste para aprobación de Admin/Superadmin.
 * El pago original NUNCA se elimina.
 */
export default function SecretarioPaymentCorrectionPage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const [payments, setPayments] = useState<Payment[]>([])
  const [clientMap, setClientMap] = useState<Map<string, Client>>(new Map())
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [target, setTarget] = useState<Payment | null>(null)
  const [closed, setClosed] = useState(false)
  const [form, setForm] = useState({ newValor: 0, newFecha: '', reason: '', observacion: '' })
  const [saving, setSaving] = useState(false)

  useEffect(() => { load() }, [user])

  async function load() {
    if (!user) return
    setLoading(true)
    const [pays, clients] = await Promise.all([
      db.payments.where('tenantId').equals(user.tenantId).toArray(),
      db.clients.where('tenantId').equals(user.tenantId).toArray(),
    ])
    // Solo pagos vigentes (no reversados ni asientos de reversión) de rutas autorizadas.
    const vigentes = filterByAccessibleRoute(user, pays)
      .filter(p => (p.state ?? 'active') === 'active' && p.valor > 0)
      .sort((a, b) => b.fecha.localeCompare(a.fecha))
    setPayments(vigentes)
    setClientMap(new Map(clients.map(c => [c.id, c])))
    setLoading(false)
  }

  async function openCorrect(p: Payment) {
    setTarget(p)
    setForm({ newValor: p.valor, newFecha: p.fecha, reason: '', observacion: '' })
    setClosed(await isPaymentInClosedPeriod(p))
  }

  async function handleSubmit() {
    if (!target || !user) return
    if (!form.reason.trim()) { toast.error('El motivo es obligatorio'); return }
    if (!(form.newValor > 0)) { toast.error('El valor corregido debe ser mayor a 0'); return }
    setSaving(true)
    try {
      const input = {
        newValor: form.newValor,
        newFecha: form.newFecha || undefined,
        reason: form.reason.trim(),
        observacion: form.observacion.trim() || undefined,
      }
      const res = closed
        ? await requestPaymentAdjustment(user, target.id, input)
        : await correctPayment(user, target.id, input)
      if (!res.success) { toast.error(res.error ?? 'No se pudo procesar'); return }
      toast.success(closed
        ? 'Solicitud de ajuste enviada para aprobación'
        : 'Pago corregido. Se creó reversión y pago corregido.')
      setTarget(null)
      await load()
    } catch { toast.error('Error al procesar la corrección') } finally { setSaving(false) }
  }

  const clientName = (id: string) => clientMap.get(id)?.nombre ?? 'Cliente'
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return payments.slice(0, 100)
    return payments.filter(p => clientName(p.clientId).toLowerCase().includes(q)).slice(0, 100)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payments, search, clientMap])

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Corrección de pagos</h1>
        <p className="text-sm text-gray-500 mt-0.5">Corrige pagos mediante reversión y reemplazo (no destructivo)</p>
      </div>

      <div className="max-w-sm">
        <Input placeholder="Buscar por cliente…" value={search} onChange={e => setSearch(e.target.value)} leftIcon={<Search className="w-4 h-4" />} />
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<Receipt className="w-8 h-8" />} title="Sin pagos" description="No hay pagos vigentes en tus rutas autorizadas." />
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 divide-y divide-gray-50">
          {filtered.map(p => (
            <div key={p.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{clientName(p.clientId)}</p>
                <p className="text-xs text-gray-400">{formatDate(p.fecha)} · {p.tipo}</p>
              </div>
              <p className="text-sm font-semibold text-emerald-600 flex-shrink-0">{formatCurrency(p.valor, currency)}</p>
              <Button variant="secondary" size="sm" onClick={() => openCorrect(p)} icon={<RotateCcw className="w-3.5 h-3.5" />}>Corregir</Button>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!target} onClose={() => setTarget(null)} title="Corregir pago"
        footer={<>
          <Button variant="secondary" onClick={() => setTarget(null)}>Cancelar</Button>
          <Button onClick={handleSubmit} loading={saving} icon={<RotateCcw className="w-4 h-4" />}>
            {closed ? 'Solicitar ajuste' : 'Corregir pago'}
          </Button>
        </>}>
        {target && (
          <div className="space-y-3">
            {/* Pago original (inalterable) */}
            <div className="bg-gray-50 rounded-xl p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">Pago original (se conserva como histórico)</p>
                <Badge variant="gray" size="sm"><Lock className="w-3 h-3 mr-1 inline" />Inalterable</Badge>
              </div>
              <p className="text-sm font-semibold text-gray-800 mt-1">{clientName(target.clientId)} · {formatCurrency(target.valor, currency)} · {formatDate(target.fecha)}</p>
            </div>

            {closed && (
              <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-xs">
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>Este pago está en un <b>periodo cerrado</b>. No puedes corregirlo directamente: se generará una <b>solicitud de ajuste</b> que debe aprobar un Administrador autorizado o el Super Admin.</span>
              </div>
            )}

            <MoneyInput label="Valor correcto" currency={currency} value={form.newValor} onValueChange={v => setForm(f => ({ ...f, newValor: v }))} required />
            <Input label="Fecha correcta (opcional)" type="date" max={today()} value={form.newFecha} onChange={e => setForm(f => ({ ...f, newFecha: e.target.value }))} />
            <Textarea label="Motivo (obligatorio)" rows={2} value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} required />
            <Textarea label="Observación" rows={2} value={form.observacion} onChange={e => setForm(f => ({ ...f, observacion: e.target.value }))} />
          </div>
        )}
      </Modal>
    </div>
  )
}
