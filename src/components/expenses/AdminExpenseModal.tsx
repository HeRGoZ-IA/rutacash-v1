import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/Toast'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useDataRevision } from '@/hooks/useDataRevision'
import { formatCurrency, formatDate, today } from '@/lib/formatters'
import { generateId } from '@/lib/utils'
import { formatPersonName } from '@/lib/displayName'
import { createExpense, payablePoolsFor } from '@/services/expenseService'
import { getAdminAvailableCapital, getCompanyAvailableCapital } from '@/services/capitalControlService'
import type { Expense, ExpenseCategory, User } from '@/models/types'

/** Bolsa codificada: 'empresa' o `admin:<id>`. */
export const encodeBolsa = (b: { source: 'empresa' } | { source: 'admin'; adminId: string }) =>
  b.source === 'empresa' ? 'empresa' : `admin:${b.adminId}`
const decodeBolsa = (v: string): { source: 'empresa' } | { source: 'admin'; adminId: string } | undefined =>
  v === 'empresa' ? { source: 'empresa' } : v.startsWith('admin:') ? { source: 'admin', adminId: v.slice(6) } : undefined

const VACIO = { bolsa: '', categoryId: '', valor: 0, descripcion: '', fecha: today(), referencia: '' }

/**
 * GASTO ADMINISTRATIVO (pagado con una bolsa) — formulario ÚNICO de Gastos y de
 * Caja principal (Ronda 3/6). No calcula nada financiero: el disponible sale del
 * servicio de capital y `createExpense` revalida bolsa, permisos y fondos dentro
 * de la transacción. Un id de operación por formulario abierto: un doble clic o un
 * reintento devuelven el mismo gasto.
 */
export function AdminExpenseModal({ open, onClose, onSaved, users, categories, bolsaInicial }: {
  open: boolean
  onClose: () => void
  onSaved?: (e: Expense) => void
  users: User[]
  categories: ExpenseCategory[]
  /** Bolsa preseleccionada ('empresa' o `admin:<id>`), si el actor puede usarla. */
  bolsaInicial?: string
}) {
  const { user } = useAuth()
  const { tenantId, currency } = useTenant()
  const revision = useDataRevision()
  const money = (n: number) => formatCurrency(n, currency)
  const [form, setForm] = useState(VACIO)
  const [operationId, setOperationId] = useState('')
  const [confirmando, setConfirmando] = useState(false)
  const [saving, setSaving] = useState(false)
  const [disponible, setDisponible] = useState<number | null | undefined>(undefined)

  const nombreDe = (id: string) => formatPersonName(users.find(u => u.id === id)?.nombre ?? id)
  const opciones = payablePoolsFor(user, users).map(b => ({
    value: encodeBolsa(b),
    label: b.source === 'empresa' ? 'Bolsa de la empresa' : b.adminId === user?.id ? `Mi bolsa (${formatPersonName(user?.nombre)})` : `Bolsa de ${nombreDe(b.adminId)}`,
  }))
  const bolsaSel = decodeBolsa(form.bolsa)
  const bolsaNombre = opciones.find(o => o.value === form.bolsa)?.label ?? ''
  const despues = disponible != null ? disponible - form.valor : null
  const insuficiente = !!bolsaSel && disponible != null && form.valor > disponible
  const sinFondos = disponible != null && disponible <= 0

  // Cada apertura es UNA operación nueva; la bolsa inicial solo si está permitida.
  useEffect(() => {
    if (!open) return
    const permitida = bolsaInicial && opciones.some(o => o.value === bolsaInicial) ? bolsaInicial : opciones.length === 1 ? opciones[0].value : ''
    setForm({ ...VACIO, fecha: today(), bolsa: permitida })
    setOperationId(generateId())
    setConfirmando(false)
  }, [open])  // eslint-disable-line react-hooks/exhaustive-deps

  // Disponible de la bolsa elegida (fuente oficial; el servicio revalida al registrar).
  useEffect(() => {
    let alive = true
    if (!open || !bolsaSel) { setDisponible(undefined); return }
    setDisponible(undefined)
    const p = bolsaSel.source === 'empresa' ? getCompanyAvailableCapital(tenantId) : getAdminAvailableCapital(tenantId, bolsaSel.adminId)
    p.then(v => { if (alive) setDisponible(v) }, () => { if (alive) setDisponible(null) })
    return () => { alive = false }
  }, [open, form.bolsa, tenantId, revision])  // eslint-disable-line react-hooks/exhaustive-deps

  const cerrar = () => { if (!saving) { setConfirmando(false); onClose() } }

  async function guardar() {
    if (!bolsaSel) { toast.error('Indica qué bolsa paga el gasto'); return }
    if (!form.categoryId || form.valor <= 0) { toast.error('Categoría y valor son requeridos'); return }
    if (form.descripcion.trim().length < 3) { toast.error('Indica el concepto del gasto'); return }
    if (insuficiente) { toast.error(`El gasto supera el disponible de la bolsa (${money(disponible ?? 0)}).`); return }
    if (!confirmando) { setConfirmando(true); return }
    setSaving(true)
    try {
      const e = await createExpense({
        actor: user, tenantId, scope: 'empresa', categoryId: form.categoryId, valor: form.valor,
        descripcion: form.descripcion, fecha: form.fecha, referencia: form.referencia, syncStatus: 'synced',
        operationId, funding: bolsaSel,
      })
      toast.success(`Gasto registrado · Ref. ${e.id.slice(0, 8).toUpperCase()}`)
      setConfirmando(false)
      onSaved?.(e)
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo registrar el gasto')
      setConfirmando(false)
    } finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={cerrar}
      title={confirmando ? 'Confirmar gasto administrativo' : 'Gasto administrativo'}
      footer={confirmando
        ? <><Button variant="secondary" onClick={() => setConfirmando(false)} disabled={saving}>Volver</Button><Button onClick={guardar} loading={saving}>Confirmar y registrar</Button></>
        : <><Button variant="secondary" onClick={cerrar}>Cancelar</Button><Button onClick={guardar} loading={saving} disabled={insuficiente}>Continuar</Button></>}>
      {confirmando ? (
        <div className="space-y-2 text-sm" data-testid="expense-confirm">
          <p className="text-lg font-bold text-gray-900">{money(form.valor)} · {categories.find(c => c.id === form.categoryId)?.nombre ?? ''}</p>
          <p className="text-gray-700 break-words">{form.descripcion.trim()}{form.referencia.trim() ? ` · Ref. ${form.referencia.trim()}` : ''}</p>
          <div className="rounded-xl border border-gray-100 divide-y divide-gray-50">
            <div className="flex justify-between gap-2 px-3 py-2"><span className="text-gray-500">Paga</span><b className="text-right">{bolsaNombre}</b></div>
            <div className="flex justify-between gap-2 px-3 py-2"><span className="text-gray-500">Disponible</span><span>{disponible == null ? '…' : money(disponible)}</span></div>
            <div className="flex justify-between gap-2 px-3 py-2"><span className="text-gray-500">Disponible después</span><b>{despues == null ? '…' : money(despues)}</b></div>
          </div>
          <p className="text-xs text-gray-500">Fecha {formatDate(form.fecha)}. El disponible se vuelve a comprobar al registrar.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-gray-500">Compras y gastos de la administración (combustible, cascos, maletines, herramientas…). Salen de una bolsa y reducen su disponible; no tocan ninguna ruta ni a ningún trabajador.</p>
          <Select label="¿Qué bolsa paga?" value={form.bolsa} required
            onChange={e => setForm(f => ({ ...f, bolsa: e.target.value }))}
            options={opciones} placeholder="Seleccionar bolsa"
            hint={user?.rol === 'admin' ? 'Tus gastos administrativos salen de tu bolsa: la misma que distribuyes a tus rutas.' : 'La bolsa de la empresa o la de un Administrador activo.'} />
          <Select label="Categoría" value={form.categoryId} onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))}
            options={categories.filter(c => c.activa).map(c => ({ value: c.id, label: c.nombre }))} placeholder="Seleccionar categoría" required />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <MoneyInput label="Valor" currency={currency} value={form.valor} onValueChange={v => setForm(f => ({ ...f, valor: v }))} required />
            <Input label="Fecha" type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
          </div>
          {bolsaSel && (
            <div className="rounded-xl border border-gray-100 divide-y divide-gray-50 text-sm" data-testid="pool-preview">
              <div className="flex justify-between gap-2 px-3 py-2"><span className="text-gray-500">Disponible de la bolsa</span>
                <b data-testid="pool-available" className={disponible != null && disponible < 0 ? 'text-red-600' : undefined}>{disponible === undefined ? '…' : disponible === null ? 'No disponible' : money(disponible)}</b></div>
              <div className="flex justify-between gap-2 px-3 py-2"><span className="text-gray-500">Gasto</span><span>− {money(form.valor)}</span></div>
              <div className="flex justify-between gap-2 px-3 py-2"><span className="text-gray-500">Disponible después</span>
                <b className={insuficiente ? 'text-red-600' : 'text-gray-900'} data-testid="pool-after">{insuficiente ? 'Insuficiente' : despues == null ? '…' : money(despues)}</b></div>
              {insuficiente && <p className="px-3 py-2 text-xs text-red-600">{sinFondos ? 'La bolsa no tiene disponible.' : 'El gasto supera el disponible.'} Lo colocado en rutas no se puede gastar: primero retíralo de una ruta.</p>}
            </div>
          )}
          <Textarea label="Concepto" value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} rows={2} />
          <Input label="Referencia del soporte (opcional)" value={form.referencia} placeholder="N.º de factura o recibo"
            onChange={e => setForm(f => ({ ...f, referencia: e.target.value }))} />
        </div>
      )}
    </Modal>
  )
}
