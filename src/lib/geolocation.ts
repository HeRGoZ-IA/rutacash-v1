// ============================================================
// UBICACIÓN DEL COBRADOR AL REGISTRAR UN ABONO (Ronda 48 · D-UX48-02/03)
// ------------------------------------------------------------
// La ubicación es EVIDENCIA COMPLEMENTARIA del cobro, no una prueba infalible de
// presencia (el dispositivo la reporta y puede falsearse). Por eso:
//   · se pide al registrar el abono (gesto del usuario), una sola vez, sin seguimiento
//     continuo ni en segundo plano;
//   · NUNCA bloquea el abono: si el permiso se niega, el GPS no responde o se agota el
//     tiempo, el pago sigue y se conserva la CAUSA;
//   · nunca se inventan coordenadas: sin posición real no hay lat/lng.
// Solo se toman latitud, longitud, precisión y hora de captura.
// ============================================================

export type GeoCaptureStatus = 'captured' | 'denied' | 'unavailable' | 'timeout' | 'unsupported'

export interface GeoCapture {
  status: GeoCaptureStatus
  lat?: number
  lng?: number
  /** Precisión reportada por el dispositivo, en metros. */
  accuracyM?: number
  /** Momento de la lectura según el dispositivo (ISO). */
  capturedAt?: string
  /** Causa conocida cuando no hay posición. */
  reason?: string
}

/** Estados que puede devolver el servidor además de los del dispositivo. */
export type GeoRecordStatus = GeoCaptureStatus | 'invalid' | 'not_stored'

export const GEO_STATUS_LABEL: Record<GeoRecordStatus, string> = {
  captured: 'Ubicación registrada',
  denied: 'Sin ubicación: permiso denegado',
  unavailable: 'Sin ubicación: no disponible',
  timeout: 'Sin ubicación: tiempo agotado',
  unsupported: 'Sin ubicación: este dispositivo o sitio no la permite',
  invalid: 'Sin ubicación: la lectura no era válida',
  not_stored: 'Ubicación no guardada',
}

type PolicyDoc = Document & {
  permissionsPolicy?: { allowsFeature?: (f: string) => boolean }
  featurePolicy?: { allowsFeature?: (f: string) => boolean }
}

/** ¿Se puede pedir la ubicación aquí? (API presente, contexto seguro y política del sitio). */
export function geolocationSupport(): { supported: true } | { supported: false; reason: string } {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return { supported: false, reason: 'El navegador no ofrece ubicación.' }
  if (typeof window !== 'undefined' && window.isSecureContext === false) return { supported: false, reason: 'La conexión no es segura (HTTPS).' }
  const d = typeof document !== 'undefined' ? (document as PolicyDoc) : undefined
  const policy = d?.permissionsPolicy ?? d?.featurePolicy
  if (policy?.allowsFeature && !policy.allowsFeature('geolocation')) return { supported: false, reason: 'La configuración del sitio bloquea la ubicación.' }
  return { supported: true }
}

/**
 * Una lectura de posición. Siempre resuelve (nunca lanza): con `captured` y datos
 * reales, o con el motivo de la ausencia.
 *
 * `promptLimitMs` cubre el aviso de permiso del navegador, que NO cuenta en el
 * `timeout` estándar: si la persona no responde, el abono no espera para siempre.
 */
export function captureLocation(opts: { timeoutMs?: number; maximumAgeMs?: number; promptLimitMs?: number } = {}): Promise<GeoCapture> {
  const { timeoutMs = 8000, maximumAgeMs = 30_000, promptLimitMs = 15_000 } = opts
  const support = geolocationSupport()
  if (!support.supported) return Promise.resolve({ status: 'unsupported', reason: support.reason })
  return new Promise<GeoCapture>(resolve => {
    let done = false
    const finish = (g: GeoCapture) => { if (!done) { done = true; clearTimeout(guard); resolve(g) } }
    const guard = setTimeout(() => finish({ status: 'timeout', reason: 'No hubo respuesta de ubicación a tiempo.' }), promptLimitMs)
    try {
      navigator.geolocation.getCurrentPosition(
        pos => {
          const { latitude, longitude, accuracy } = pos.coords
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            finish({ status: 'unavailable', reason: 'El dispositivo devolvió una posición vacía.' })
            return
          }
          finish({
            status: 'captured', lat: latitude, lng: longitude,
            accuracyM: Number.isFinite(accuracy) ? Math.round(accuracy) : undefined,
            capturedAt: new Date(pos.timestamp || Date.now()).toISOString(),
          })
        },
        err => {
          // Chrome informa la política del sitio como PERMISSION_DENIED: se distingue por el texto.
          if (err.code === 1 && /policy/i.test(err.message)) finish({ status: 'unsupported', reason: 'La configuración del sitio bloquea la ubicación.' })
          else if (err.code === 1) finish({ status: 'denied', reason: 'El permiso de ubicación fue denegado.' })
          else if (err.code === 3) finish({ status: 'timeout', reason: 'El GPS no respondió a tiempo.' })
          else finish({ status: 'unavailable', reason: 'La posición no está disponible.' })
        },
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: maximumAgeMs },
      )
    } catch {
      finish({ status: 'unsupported', reason: 'El navegador no permitió pedir la ubicación.' })
    }
  })
}
