"""
ADEX Soluciones: versiones optimizadas de los logos aprobados (SIN pérdida visible).

    python scripts/optimize-brand-assets.py          # genera y verifica
    python scripts/optimize-brand-assets.py --check  # solo verifica

Fuente maestra (no se modifica): src/assets/branding/adex/*.png
Salida (la que consume la app):  src/assets/branding/adex/optimized/*.png

Método (determinista, solo Pillow):
  1. Los píxeles 100% transparentes (alpha = 0) pasan a RGB 0. Son invisibles en
     cualquier fondo, pero su "ruido" de color impedía comprimir.
  2. Recompresión PNG RGBA con zlib al máximo (optimize + compress_level 9).

Garantía: mismas dimensiones, mismo modo RGBA, y todo píxel con alpha > 0 es
IDÉNTICO al original (se comprueba aquí). No se cuantiza la paleta: a 256 colores
el degradado del check mostraba bandas visibles al 100 %.
"""
import hashlib
import sys
from pathlib import Path

from PIL import Image

SRC = Path(__file__).resolve().parent.parent / 'src' / 'assets' / 'branding' / 'adex'
OUT = SRC / 'optimized'
NOMBRES = [
    'adex-logo-horizontal-primary.png',
    'adex-logo-horizontal-on-dark.png',
    'adex-wordmark-primary.png',
    'adex-symbol-primary.png',
    'adex-logo-stacked-primary.png',
    'adex-logo-horizontal-monochrome-navy.png',
]


def optimizar(origen: Path, destino: Path) -> None:
    im = Image.open(origen).convert('RGBA')
    limpio = Image.new('RGBA', im.size)
    limpio.putdata([(0, 0, 0, 0) if p[3] == 0 else p for p in im.getdata()])
    limpio.save(destino, 'PNG', optimize=True, compress_level=9)


def verificar(origen: Path, destino: Path) -> str | None:
    a, b = Image.open(origen), Image.open(destino)
    if a.size != b.size:
        return f"dimensiones {a.size} -> {b.size}"
    if b.mode != 'RGBA':
        return f'modo {b.mode} (se esperaba RGBA)'
    for p, q in zip(a.convert('RGBA').getdata(), b.getdata()):
        if p[3] != q[3] or (p[3] > 0 and p != q):
            return 'algún píxel visible cambió'
    return None


def main() -> int:
    solo_check = '--check' in sys.argv
    OUT.mkdir(exist_ok=True)
    fallos = 0
    for nombre in NOMBRES:
        origen, destino = SRC / nombre, OUT / nombre
        if not origen.exists():
            print(f'FALTA el original: {origen}')
            return 1
        antes = hashlib.sha256(origen.read_bytes()).hexdigest()
        if not solo_check:
            optimizar(origen, destino)
        error = verificar(origen, destino)
        if hashlib.sha256(origen.read_bytes()).hexdigest() != antes:
            error = 'el ORIGINAL cambió'
        o, d = origen.stat().st_size, destino.stat().st_size
        print(f"{'OK ' if not error else 'MAL'} {nombre:42} {o / 1024:7.1f} KB -> {d / 1024:7.1f} KB "
              f"(-{100 - 100 * d / o:.1f}%)  {Image.open(destino).size[0]}x{Image.open(destino).size[1]}"
              + (f'  <- {error}' if error else ''))
        fallos += bool(error)
    return 1 if fallos else 0


if __name__ == '__main__':
    sys.exit(main())
