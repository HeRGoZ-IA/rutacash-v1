// Puente de ADEX Online · migración de rutas con historial (SaaS 0043, parte 1).
//
// Solo el SuperAdmin pone una ruta «en migración» (o cancela la migración). El servidor comprueba todo
// (ruta activa, vacía, sin entrega pendiente, Base por Ruta) y bloquea en PostgreSQL cualquier escritura en
// la ruta mientras está en migración. Aquí solo se pide el dato y se muestra el resultado.

import { useState } from 'react'
import { ArrowRightLeft } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { toast } from '@/components/ui/Toast'
import type { Route } from '@/models/types'
import { OnlineCommandError, money } from '../../../runtime/commands.ts'

const MESSAGES: Record<string, string> = {
  ROUTE_MIGRATION_NOT_ALLOWED: 'La ruta debe estar activa, sin clientes, ventas ni movimientos, y sin una entrega pendiente.',
  PERMISSION_DENIED: 'Solo el SuperAdmin puede hacerlo.',
  INVALID_INPUT: 'Revise los datos.',
}

// `inUse`: la ruta ya tiene Base, cartera, ventas o clientes activos. Solo se ofrece «Poner en migración» en rutas
// nuevas y vacías (pedido de Helmer, 2026-11-04); el servidor lo rechaza igual (AX444) si queda algún dato.
export function RouteMigrationAction({ route, isSuperadmin, inUse = true }: { route: Route; isSuperadmin: boolean; inUse?: boolean }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [operationId, setOperationId] = useState('')
  if (!isSuperadmin) return null
  const inMigration = route.migrationState === 'en_migracion'
  if (!inMigration && (route.status !== 'activa' || inUse)) return null

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
      const code = e instanceof OnlineCommandError ? e.code : ''
      toast.error(MESSAGES[code] ?? (e instanceof Error ? e.message : 'No se pudo completar.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={start} icon={<ArrowRightLeft className="w-3.5 h-3.5" />} data-testid={`route-migration-action-${route.id}`}>
        {inMigration ? 'Cancelar migración' : 'Poner en migración'}
      </Button>
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
    </>
  )
}
