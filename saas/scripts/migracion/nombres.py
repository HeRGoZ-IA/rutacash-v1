"""Separa el nombre del cliente y su negocio (en el sistema anterior los cobradores los escribían juntos).

Mismas reglas que la auditoría de nombres de BlueLine (2026-11-08, chat de Errores):
- «NOMBRE - NEGOCIO» o «NOMBRE _NEGOCIO»: lo que va después del guion es el negocio;
- sin guion: desde la primera palabra de negocio conocida (UBER, BAR, RESTAURANTE…), nunca la primera palabra;
- si el negocio termina con el nombre de la ruta del cliente, ese lugar sobra («Aguas Lindas es la Ruta»);
- notas como «RECOM. RENATO» o «/ CLIENTE EDWAR» van a observaciones, no al nombre ni al negocio.
"""
import re
import unicodedata

KW = ['UBER', 'BAR', 'RESTAURANTE', 'DISTRIBUIDORA', 'ROPA', 'ALMACEN', 'LOJA', 'BARBERO', 'BARBEARIA', 'BARBERIA', 'SALON', 'SALAO',
      'PELUQUERIA', 'PELUQUERO', 'ESTETICA', 'ACADEMIA', 'MARMITAS', 'MARMITA', 'PIZZERIA', 'PIZZARIA', 'PIZZA', 'LANCHONETE', 'CELULAR',
      'CELULARES', 'LAVADORA', 'LAVADORAS', 'LAVA', 'TALLER', 'MECANICO', 'PANADERIA', 'HAMBURGUER', 'HAMBURGUESAS', 'COSTURERA', 'BOLOS',
      'CAFE', 'SUPERMERCADO', 'FRUTERIA', 'CARPINTERIA', 'TAPICERIA', 'APARTAMENTOS', 'BRONCEADO', 'NEVERAS', 'TRAJES', 'CONFECCAO', 'BANCA',
      'BRECHO', 'VASOS', 'REPARTO', 'BORRACHERO', 'PAPELERIA', 'FOTOESTUDIO', 'BATERIAS', 'COMPRA', 'POLLO', 'ESPETO', 'TIENDA', 'MERCEARIA',
      'CHAVEIRO', 'AGROPECUARIA', 'SACOLAO', 'MADEREIRA', 'CORRETORA', 'ESPETINHO', 'FRANGO']
SMALL = {'de', 'da', 'do', 'das', 'dos', 'y', 'e', 'en', 'del', 'la', 'el'}


def fold(s):
    return ''.join(c for c in unicodedata.normalize('NFD', (s or '').upper()) if unicodedata.category(c) != 'Mn')


def clean(s):
    s = re.sub(r'^[\s\-_–—/.:]+|[\s\-_–—/.:]+$', '', (s or '').replace('\U0001f488', ''))
    return re.sub(r'\s+', ' ', s).strip()


def titlecase(b):
    w = clean(re.sub(r'[-_]+', ' ', b)).lower().split()
    w = [x for i, x in enumerate(w) if not i or fold(x) != fold(w[i - 1])]  # «BAR BAR» → «Bar»
    return ' '.join(x if (i and x in SMALL) else x[:1].upper() + x[1:] for i, x in enumerate(w))


def _notes(raw):
    """Quita del texto las notas para observaciones: «RECOM. X» / «RECOMENDADO POR X» al final y lo que va tras « / »."""
    notes, s = [], raw
    m = re.search(r'\s*/\s*(.+)$', s)
    if m and m.start() > 0:
        notes.append(titlecase(m.group(1)))
        s = s[:m.start()]
    m = re.search(r'\s+RECOM(?:\.|ENDAD[OA]S?(?:\s+POR)?)\s+(.+)$', s, re.I)
    if m:
        notes.append('Recomendado por ' + titlecase(m.group(1)))
        s = s[:m.start()]
    return s, notes


def _split(name):
    m = re.search(r'\s*(?:-+|_+)\s*', name)
    if m and m.start() > 0 and clean(name[m.end():]):
        head, tail = clean(name[:m.start()]), name[m.end():]
        hw = head.split()
        for i, w in enumerate(hw):  # negocio pegado antes del guion (p. ej. «… RESTAURANTE -CEILANDIA-»)
            if i >= 1 and fold(w).strip('.:-') in KW:
                return ' '.join(hw[:i]), titlecase(' '.join(hw[i:]) + ' ' + tail)
        return head, titlecase(tail)
    words = clean(name).split()
    for i, w in enumerate(words):
        if i >= 1 and fold(w).strip('.:-') in KW:
            return ' '.join(words[:i]), titlecase(' '.join(words[i:]))
    return clean(name), ''


def route_place(route):
    """«VALPARAISO SOC GAJ» → «VALPARAISO»; «CARTERA TAGUATINGA SOC A.A.L» → «TAGUATINGA»."""
    s = re.sub(r'^\s*CARTERA\s+', '', clean(route), flags=re.I)
    return clean(re.split(r'\s+SOC\b', s, maxsplit=1, flags=re.I)[0])


def split_client(raw, route=''):
    """→ (nombre, negocio o None, observación o None)."""
    s, notes = _notes(raw or '')
    name, business = _split(s)
    name = clean(name)
    if not name:  # nunca dejar el cliente sin nombre
        name, business = clean(raw), ''
    place = route_place(route)
    rt, fb = fold(place), fold(business)
    if rt and fb.endswith(' ' + rt) and fb != rt:
        business = business[: len(business) - len(place)].rstrip(' ,-')
    return name, (business or None), ('\n'.join(notes) or None)


if __name__ == '__main__':  # prueba rápida: python -I nombres.py
    cases = [
        ('JOSEILTON ROCHA - PIZZARIA', '', ('JOSEILTON ROCHA', 'Pizzaria', None)),
        ('EDSON MENDES FERREIRA UBER', '', ('EDSON MENDES FERREIRA', 'Uber', None)),
        ('MARIA MIRTES XAVIER PEREIRA RESTAURANTE -CEILANDIA-', '', ('MARIA MIRTES XAVIER PEREIRA', 'Restaurante Ceilandia', None)),
        ('IATAN SANTOS MARQUES - UBER RECOM. RENATO', '', ('IATAN SANTOS MARQUES', 'Uber', 'Recomendado por Renato')),
        ('ELZANY AFONSO. ALMACEN DE ROPA -VALPARAÍSO-', 'VALPARAISO SOC GAJ', ('ELZANY AFONSO', 'Almacen de Ropa', None)),
        ('REGINALDO DA SILVA ROCHA UBER AGUAS LINDAS', 'Aguas Lindas', ('REGINALDO DA SILVA ROCHA', 'Uber', None)),
        ('BARBARA SOUZA', '', ('BARBARA SOUZA', None, None)),
        ('KELLY BAR BAR', '', ('KELLY', 'Bar', None)),
        ('DIANA SALÃO SALAO', '', ('DIANA', 'Salão', None)),
        ('UBER', '', ('UBER', None, None)),
    ]
    bad = [(r, got, exp) for r, rt, exp in cases if (got := split_client(r, rt)) != exp]
    for b in bad:
        print('FALLA', b)
    print('ok' if not bad else f'{len(bad)} fallas')
