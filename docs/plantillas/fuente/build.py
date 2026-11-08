"""Arma la plantilla final: incrusta el logo de ADEX (fondo oscuro) en la fuente."""
import base64, pathlib
aqui = pathlib.Path(__file__).resolve().parent
raiz = aqui.parents[2]
logo = base64.b64encode((raiz / 'src/assets/branding/adex/web/adex-logo-horizontal-on-dark.png').read_bytes()).decode()
src = (aqui / 'plantilla_migracion_ruta.src.html').read_text(encoding='utf-8')
assert src.count('{{LOGO_DARK}}') == 1
out = aqui.parent / 'ADEX_Plantilla_Migracion_Ruta.html'
out.write_text(src.replace('{{LOGO_DARK}}', 'data:image/png;base64,' + logo), encoding='utf-8', newline='\n')
print(out, out.stat().st_size // 1024, 'KB')
