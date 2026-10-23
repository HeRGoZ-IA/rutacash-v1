// D73-04 (decisión del propietario, Ronda 73): CAPTURAS SIN CONEXIÓN DE UNA SESIÓN DESPLAZADA.
//
// Una identidad tiene una sola sesión activa: al iniciar sesión en otro dispositivo, la de este queda
// revocada. Lo capturado aquí sin conexión NO se borra y NO se envía con la sesión revocada (el servidor
// además lo rechazaría). Cuando la sincronización descubre que la sesión terminó, cada operación que iba
// a enviarse pasa a «Requiere revisión» con este motivo. Al volver a iniciar sesión en ESTE dispositivo,
// nada se envía solo: la persona revisa cada operación y pulsa «Reintentar», que la envía con su MISMO id
// (idempotente) y las validaciones vigentes del servidor (permisos, ruta, saldos, cierres, duplicados).
// Sin dependencias: lo prueban las pruebas de unidad de `saas/` (test/unit/r73-offline-session-review.test.ts).

export const SESSION_ENDED = 'SESSION_ENDED';
export const SESSION_ENDED_TEXT = 'La sesión de este dispositivo se cerró (por ejemplo, porque se inició sesión en otro). '
  + 'Esta operación NO se envió con esa sesión: revísela y pulse «Reintentar» para enviarla con las validaciones vigentes.';

interface ReviewableOp {
  status: 'local' | 'sending' | 'confirmed' | 'review' | 'rejected';
  error?: { code: string; message: string; at: string };
  reviewedAt?: string;
}

/** Código de sync.ts: abono retenido detrás de otro abono en revisión (se enviaría solo al liberarse). */
const DEPENDENCY_HELD = 'DEPENDENCY_HELD';

/** ¿La operación se iba a enviar sola? (pendiente, enviada sin respuesta o retenida por dependencia). */
export const awaitingSend = (o: ReviewableOp) => o.status === 'local' || o.status === 'sending'
  || (o.status === 'review' && o.error?.code === DEPENDENCY_HELD && !o.reviewedAt);

/** Copias de las operaciones que deben quedar retenidas para revisión (las demás no cambian). */
export function holdForSessionReview<T extends ReviewableOp>(ops: readonly T[], at: string): T[] {
  return ops.filter(awaitingSend).map((o) => ({ ...o, status: 'review' as const, error: { code: SESSION_ENDED, message: SESSION_ENDED_TEXT, at } }));
}
