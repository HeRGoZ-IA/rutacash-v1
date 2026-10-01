"""
ADEX Soluciones: derivados PNG "right-sized" para la web (los que sirve la app).

    python scripts/generate-brand-web-assets.py          # genera y verifica
    python scripts/generate-brand-web-assets.py --check  # solo verifica

Familias de assets (las tres se conservan):
  src/assets/branding/adex/            maestros aprobados (no se tocan)
  src/assets/branding/adex/optimized/  lossless, mismas dimensiones (fuente de este script)
  src/assets/branding/adex/web/        right-sized: los que importa BrandLogo

Criterio de tamaño: ~3x el mayor tamaño de render en la UI (168x56 en login/Owner),
margen para pantallas HiDPI. Misma relación de aspecto, mismo encuadre, sin
recortes ni padding.

Método (determinista, solo Pillow): reescalado LANCZOS en RGBA. Pillow premultiplica
el alpha al reescalar (RGBA -> RGBa), así que los bordes transparentes no arrastran
halos de color. PNG RGBA de 8 bits por canal, sin paleta ni pérdida añadida
(optimize + compress_level 9).
"""
import io
import sys
from pathlib import Path

from PIL import Image

RAIZ = Path(__file__).resolve().parent.parent / 'src' / 'assets' / 'branding' / 'adex'
SRC = RAIZ / 'optimized'
OUT = RAIZ / 'web'

# nombre → (ancho, alto) exactos. `None` en el alto = proporcional al original.
DESTINOS = {
    'adex-logo-horizontal-primary.png': (504, 168),
    'adex-logo-horizontal-on-dark.png': (504, 168),
    'adex-logo-horizontal-monochrome-navy.png': (504, 168),
    'adex-wordmark-primary.png': (600, None),
    'adex-symbol-primary.png': (512, 512),
    'adex-logo-stacked-primary.png': (600, 600),
}


def tamano_destino(origen: Image.Image, ancho: int, alto: int | None) -> tuple[int, int]:
    w, h = origen.size
    if alto is None:
        alto = round(h * ancho / w)
    # La proporción pedida debe ser la del original (tolerancia de 1 px por redondeo).
    if abs(alto - h * ancho / w) > 1:
        raise ValueError(f'{ancho}x{alto} no conserva la proporción de {w}x{h}')
    return ancho, alto


def generar_bytes(origen: Path, ancho: int, alto: int | None) -> tuple[bytes, tuple[int, int]]:
    im = Image.open(origen).convert('RGBA')
    size = tamano_destino(im, ancho, alto)
    web = im.resize(size, Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    web.save(buf, 'PNG', optimize=True, compress_level=9)
    return buf.getvalue(), size


def verificar(nombre: str, destino: Path, esperado_bytes: bytes, size: tuple[int, int]) -> str | None:
    if not destino.exists():
        return 'no existe'
    try:
        im = Image.open(destino)
        im.verify()
        im = Image.open(destino)
    except Exception as e:  # noqa: BLE001
        return f'PNG inválido: {e}'
    if im.format != 'PNG':
        return f'formato {im.format}'
    if im.size != size:
        return f'dimensiones {im.size[0]}x{im.size[1]} (esperado {size[0]}x{size[1]})'
    if im.mode != 'RGBA':
        return f'modo {im.mode} (esperado RGBA)'
    alpha = im.getchannel('A')
    if alpha.getextrema()[0] != 0:
        return 'sin transparencia'
    if destino.read_bytes() != esperado_bytes:
        return 'no es reproducible (difiere de una generación nueva)'
    return None


def main() -> int:
    solo_check = '--check' in sys.argv
    OUT.mkdir(exist_ok=True)
    fallos = 0
    sobrantes = sorted(p.name for p in OUT.glob('*') if p.name not in DESTINOS)
    for nombre, (ancho, alto) in DESTINOS.items():
        origen = SRC / nombre
        if not origen.exists():
            print(f'MAL {nombre}: falta el origen {origen}')
            fallos += 1
            continue
        datos, size = generar_bytes(origen, ancho, alto)
        destino = OUT / nombre
        if not solo_check:
            destino.write_bytes(datos)
        error = verificar(nombre, destino, datos, size)
        peso = destino.stat().st_size / 1024 if destino.exists() else 0
        print(f"{'OK ' if not error else 'MAL'} {nombre:42} {size[0]}x{size[1]:<5} {peso:6.1f} KB"
              + (f'  <- {error}' if error else ''))
        fallos += bool(error)
    if sobrantes:
        print(f'MAL archivos inesperados en web/: {", ".join(sobrantes)}')
        fallos += 1
    return 1 if fallos else 0


if __name__ == '__main__':
    sys.exit(main())
