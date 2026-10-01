// ============================================================
// MARCA VISIBLE — ADEX Soluciones (punto ÚNICO)
// ------------------------------------------------------------
// La identidad comercial visible es ADEX Soluciones; el producto sigue llamándose
// RutaCash internamente (base `RutaCashDB`, sesión `rutacash-auth`, paquete, docs).
// Este componente es el único lugar que importa los logos: usa los derivados
// RIGHT-SIZED de `src/assets/branding/adex/web/` (~3x el mayor tamaño de render,
// generados con `scripts/generate-brand-web-assets.py` desde `optimized/`).
// `src/assets/branding/adex/` (maestros) y `optimized/` (lossless, mismas
// dimensiones) se conservan como fuente y no se sirven.
// Las pantallas eligen una variante, nunca un archivo.
//
// Elegir la variante por el FONDO, no por el tamaño:
//   · 'on-dark'  → letras claras: fondos azules u oscuros (sidebar, cabeceras,
//                  login). Las demás variantes son azul marino y pierden contraste.
//   · 'primary'  → logo horizontal principal sobre fondo claro.
//   · 'wordmark' · 'symbol' · 'stacked' · 'monochrome' → fondos claros.
//
// Los PNG son transparentes: el componente no añade fondo. Las dimensiones
// intrínsecas van en `width`/`height` para que el navegador reserve el espacio
// (sin salto de maquetación); el tamaño visible lo fija `className` (p. ej. `h-8`).
// ============================================================
import primary from '@/assets/branding/adex/web/adex-logo-horizontal-primary.png'
import onDark from '@/assets/branding/adex/web/adex-logo-horizontal-on-dark.png'
import wordmark from '@/assets/branding/adex/web/adex-wordmark-primary.png'
import symbol from '@/assets/branding/adex/web/adex-symbol-primary.png'
import stacked from '@/assets/branding/adex/web/adex-logo-stacked-primary.png'
import monochrome from '@/assets/branding/adex/web/adex-logo-horizontal-monochrome-navy.png'
import { cn } from '@/lib/utils'

export const BRAND_NAME = 'ADEX Soluciones'

const VARIANTS = {
  primary: { src: primary, width: 504, height: 168 },
  'on-dark': { src: onDark, width: 504, height: 168 },
  wordmark: { src: wordmark, width: 600, height: 300 },
  symbol: { src: symbol, width: 512, height: 512 },
  stacked: { src: stacked, width: 600, height: 600 },
  monochrome: { src: monochrome, width: 504, height: 168 },
} as const

export type BrandLogoVariant = keyof typeof VARIANTS

export function BrandLogo({ variant = 'primary', className, alt = BRAND_NAME }: {
  variant?: BrandLogoVariant
  /** Tamaño visible (altura). Por defecto `h-8`; el ancho se ajusta solo. */
  className?: string
  /** `''` solo si un texto contiguo ya nombra la marca. */
  alt?: string
}) {
  const v = VARIANTS[variant]
  return (
    <img
      src={v.src}
      width={v.width}
      height={v.height}
      alt={alt}
      draggable={false}
      // `cn` no fusiona clases de Tailwind: si llega una altura, la por defecto NO se
      // añade (en el CSS generado `h-8` va después de `h-10…h-16` y ganaría).
      className={cn('w-auto max-w-full object-contain select-none', /(^|\s)h-/.test(className ?? '') ? className : cn('h-8', className))}
    />
  )
}
