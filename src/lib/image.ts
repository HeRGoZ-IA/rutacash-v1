// ============================================================
// Paquete 2.5 — Compresión de imágenes para fotos del cliente
// ============================================================
//
// Local-first: las fotos se guardan como Data URL (base64) dentro del
// registro del cliente en IndexedDB. NO hay subida a servidor ni storage
// externo. Para no inflar la base de datos, redimensionamos y comprimimos
// con canvas nativo (sin librerías externas) antes de guardar.

const DEFAULT_MAX_SIZE = 1280
const DEFAULT_QUALITY = 0.78

/**
 * Lee un File de imagen, lo redimensiona (lado mayor ≤ maxSize) y lo
 * comprime a JPEG, devolviendo un Data URL listo para guardar.
 * Si algo falla, hace fallback al Data URL original sin redimensionar.
 */
export async function resizeImageToDataUrl(
  file: File,
  maxSize = DEFAULT_MAX_SIZE,
  quality = DEFAULT_QUALITY,
): Promise<string> {
  const originalDataUrl = await readFileAsDataUrl(file)
  try {
    const img = await loadImage(originalDataUrl)
    const { width, height } = scaleToFit(img.naturalWidth || img.width, img.naturalHeight || img.height, maxSize)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return originalDataUrl
    ctx.drawImage(img, 0, 0, width, height)

    // JPEG para reducir tamaño; si la imagen tenía transparencia se pierde,
    // pero para fotos de documento/negocio es perfectamente aceptable.
    const out = canvas.toDataURL('image/jpeg', quality)
    // Si por alguna razón el resultado es más grande, conserva el original.
    return out.length < originalDataUrl.length ? out : originalDataUrl
  } catch {
    return originalDataUrl
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

function scaleToFit(w: number, h: number, maxSize: number): { width: number; height: number } {
  if (w <= maxSize && h <= maxSize) return { width: w, height: h }
  const ratio = w > h ? maxSize / w : maxSize / h
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) }
}
