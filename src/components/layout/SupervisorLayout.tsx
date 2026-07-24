/**
 * Layout del Supervisor = CAPA OPERATIVA COMPARTIDA con el Cobrador.
 * Se reutiliza `CollectorLayout`, que es base-aware (`useOpBase`): bajo `/supervisor`
 * navega a `/supervisor/*` y muestra el título "Supervisor"; el rol/auditoría y las
 * validaciones de servicio (p. ej. sin venta directa) siguen siendo del Supervisor.
 */
export { CollectorLayout as SupervisorLayout } from './CollectorLayout'
