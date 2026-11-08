"""Migración de rutas (0044): reportes de Listos → archivo de carga para ADEX.

Uso (desde cualquier carpeta; los archivos de Listos y la salida van FUERA del repositorio, tienen datos personales):

    python -I listos_a_adex.py --ruta "VALPARAISO SOC GAJ" --fecha 2026-11-02 \
        --clientes <ReporteExcelClientesActivos.xlsx> --creditos <carpeta o archivos ReporteExcelCreditos*.xlsx> \
        --cuadre <carpeta o archivos ReporteExcelCuadreVariasRutas*.xlsx> --salida <carga.json>

--fecha es el día cuyo FINAL muestran los reportes: si se bajaron por la mañana, antes de cobrar, es el día ANTERIOR.
El lector lo comprueba con la columna CARTERA del cuadre (la del inicio de cada día).

Modo diario (desde el segundo cierre): --anterior <cierre del día anterior.json> --clientes <clientes activos del día>
    --creditos <«Reporte excel créditos» desde la fecha del cierre anterior> [--clientes-anterior <clientes del día anterior>]

- Lee los «ReporteExcelCreditos completo» (uno o varios, de la oficina o de la ruta; se unen por CÓDIGO CRÉDITO y gana la
  exportación más reciente) y el «ReporteExcelClientesActivos» de la ruta.
- Comprueba: encabezados conocidos, ruta correcta, Σ saldos y número de activos por cliente iguales en los dos reportes.
- Cada crédito ACTIVO (0050, venta real): TODAS sus cuotas pactadas con sus fechas originales (frecuencia y cuotas desde
  la fecha del crédito). ADEX registra lo ya pagado (TOTAL − SALDO) como un abono.
- Caja (0050): del «Cuadre varias rutas» de la ruta. Primer cierre: TOTAL CAJA de ese día (apertura; negativa = el socio
  puso de su dinero). Cierres siguientes: abonos, desembolsos, ingresos y egresos de los días que abarca el cierre y el
  TOTAL CAJA del último; ADEX lo comprueba contra lo que carga.
- Los créditos PAGADOS quedan como historial. Otros estados se informan y no se cargan.
- Imprime solo cifras agregadas (sin nombres ni documentos) y escribe el JSON que se sube en ADEX
  (Rutas → «Cargar datos de Listos»), que lo vuelve a comprobar todo en PostgreSQL.

Convención de Listos (comprobada con los datos de Valparaíso, 2026-11-04): las cuotas diarias cuentan los 7 días; la
cuota k vence k días (semanas, quincenas, meses) después de la fecha del crédito.
"""
import argparse
import datetime as dt
import glob
import json
import os
import re
import sys
from collections import defaultdict

import openpyxl

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nombres import split_client  # noqa: E402

CREDIT_COLS = ['RUTA', 'FECHA', 'CÓDIGO CLIENTE', 'DOCUMENTO', 'CLIENTE', 'ZONA', 'DIRECCIÓN COBRO', 'BARRIO', 'TELÉFONO', 'CELULAR',
               'CÓDIGO CRÉDITO', 'VALOR CRÉDITO', '% INTERÉS', 'TOTAL CRÉDITO', 'SALDO', 'FORMA PAGO', 'DÍA DE COBRO', 'VALOR CUOTA']
CLIENT_COLS = ['CÓDIGO CLIENTE', 'DOCUMENTO', 'CLIENTE', 'DIRECCIÓN', 'BARRIO', 'CELULAR', 'CELULAR ADICIONAL', 'ZONA',
               'CANTIDAD ACTIVOS', 'CANTIDAD PAGADOS', 'SALDO ACTIVOS']
FREQ = {'DIARIO': 'diaria', 'SEMANAL': 'semanal', 'QUINCENAL': 'quincenal', 'MENSUAL': 'mensual'}
MINOR = 100  # BRL: 2 decimales; Listos exporta reales enteros


def fail(msg):
    print(f'ERROR: {msg}', file=sys.stderr)
    sys.exit(2)


def rows_of(path):
    ws = openpyxl.load_workbook(path, read_only=True, data_only=True).worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    if len(rows) < 9:
        fail(f'{os.path.basename(path)}: el archivo no tiene el formato de Listos')
    title = ' '.join(str(c) for c in rows[4] if c is not None)
    scope = ' '.join(str(c) for c in rows[7] if c is not None)
    header = [str(c).strip() if c is not None else '' for c in rows[8]]
    data = [dict(zip(header, r)) for r in rows[9:] if any(c is not None for c in r)]
    return title, scope, header, data


def text(v):
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


def money(v, what):
    if v is None or v == '':
        return 0
    x = float(v)
    if x < 0 or abs(x * MINOR - round(x * MINOR)) > 1e-6:
        fail(f'importe no válido en {what}: {v}')
    return int(round(x * MINOR))


def day(v, what):
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    try:
        return dt.date.fromisoformat(str(v)[:10])
    except ValueError:
        fail(f'fecha no válida en {what}: {v}')


def add_months(d, n):
    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    last = [31, 29 if y % 4 == 0 and (y % 100 != 0 or y % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return dt.date(y, m, min(d.day, last))


def due_date(start, freq, k):
    if freq == 'diaria':
        return start + dt.timedelta(days=k)
    if freq == 'semanal':
        return start + dt.timedelta(days=7 * k)
    if freq == 'quincenal':
        return start + dt.timedelta(days=15 * k)
    return add_months(start, k)


def export_stamp(path):
    m = re.search(r'(\d{4}-\d\d-\d\d)_(\d\d)_(\d\d)_(\d\d)', os.path.basename(path))
    return m.group(0) if m else os.path.basename(path)


def full_amounts(c):
    n, quota, total = c['installmentsCount'], c['installmentValueMinor'], c['totalMinor']
    return [quota] * (n - 1) + [total - quota * (n - 1)]


def remaining_of(c):
    """Cuotas que faltan (cuota, lo que falta de ella): lo pagado se descuenta desde la primera."""
    paid, out = c['totalMinor'] - c['balanceMinor'], []
    for x in c['schedule']:
        take = min(paid, x['amountMinor'])
        paid -= take
        if x['amountMinor'] - take > 0:
            out.append((x, x['amountMinor'] - take))
    return out


def overdue_of(c, report):
    """Cuotas atrasadas como las cuenta Listos (comprobado: 37 de 41 en Valparaíso): vencidas hasta el día del reporte
    inclusive, sin contar la cuota con abono parcial. ADEX marca vencida toda cuota con fecha anterior a hoy: es informativo."""
    rem = remaining_of(c)
    partial = bool(rem) and rem[0][1] != rem[0][0]['amountMinor']
    return sum(1 for i, (x, _) in enumerate(rem) if dt.date.fromisoformat(x['dueDate']) <= report and not (i == 0 and partial))


CUADRE_COLS = ['FECHA', 'ABONOS', 'OTROS ABONOS', 'DESEMBOLSOS', 'INGRESOS', 'EGRESOS', 'ANULACIÓN INGRESOS', 'ANULACIÓN EGRESO']


def cents(v):
    return int(round(float(v or 0) * MINOR))


def read_cuadre(paths, route):
    """«Reporte excel cuadre varias rutas» (uno o varios tramos de fechas) → {fecha: fila}. Comprueba la caja día a día."""
    files = []
    for p in paths:
        files += sorted(glob.glob(os.path.join(p, '*CuadreVariasRutas*.xlsx'))) if os.path.isdir(p) else [p]
    if not files:
        fail('no hay archivos de cuadre («Reporte excel cuadre varias rutas»)')
    days = {}
    for f in files:
        title, scope, header, rows = rows_of(f)
        if 'cuadre varias rutas' not in title.lower():
            fail(f'{os.path.basename(f)} no es el «Reporte excel cuadre varias rutas»')
        if route not in scope.upper():
            continue
        if header[:len(CUADRE_COLS)] != CUADRE_COLS or 'CAJA ANTERIOR' not in header or 'TOTAL CAJA' not in header or 'CARTERA' not in header:
            fail(f'{os.path.basename(f)} no tiene las columnas conocidas')
        for r in rows:
            if isinstance(r['FECHA'], (dt.date, dt.datetime)):
                days[day(r['FECHA'], 'cuadre')] = r
    if not days:
        fail(f'ningún cuadre de la ruta {route}')
    order = sorted(days)
    for a, b in zip(order, order[1:]):
        if (b - a).days != 1:
            fail(f'faltan días en los cuadres entre {a} y {b}')
        if cents(days[b]['CAJA ANTERIOR']) != cents(days[a]['TOTAL CAJA']):
            fail(f'el cuadre del {b} no empieza con la caja del {a}')
    for d in order:
        r = days[d]
        if cents(r['CAJA ANTERIOR']) + cents(r['ABONOS']) + cents(r['OTROS ABONOS']) + cents(r['INGRESOS']) - cents(r['DESEMBOLSOS']) \
                - cents(r['EGRESOS']) != cents(r['TOTAL CAJA']):
            fail(f'el cuadre del {d} no cuadra (caja anterior + abonos + ingresos − desembolsos − egresos ≠ total caja)')
    return days


def check_report_date(cuadre, report, total_bal):
    """La CARTERA del cuadre es la del INICIO del día: la del día siguiente al cierre debe ser Σ saldos."""
    nxt = report + dt.timedelta(days=1)
    if nxt not in cuadre:
        return f'sin cuadre del {nxt}: no se pudo comprobar que los reportes son del final del {report}'
    if cents(cuadre[nxt]['CARTERA']) == total_bal:
        return None
    match = [d - dt.timedelta(days=1) for d in sorted(cuadre) if cents(cuadre[d]['CARTERA']) == total_bal]
    fail(f'Σ saldos ({total_bal / MINOR:,.2f}) no es la cartera del final del {report} en el cuadre '
         f'({cents(cuadre[nxt]["CARTERA"]) / MINOR:,.2f})' + (f'; coincide con el final del {match[-1]}: use --fecha {match[-1]}' if match else ''))


def cash_block(cuadre, prev_date, report):
    if report not in cuadre:
        fail(f'falta el cuadre del {report}')
    closing = cents(cuadre[report]['TOTAL CAJA'])
    if prev_date is None:
        return {'closingMinor': closing}
    span = [prev_date + dt.timedelta(days=k) for k in range(1, (report - prev_date).days + 1)]
    if any(d not in cuadre for d in span) or prev_date not in cuadre:
        fail(f'faltan cuadres entre el {prev_date} y el {report}')
    expenses = [{'date': d.isoformat(), 'amountMinor': cents(cuadre[d]['EGRESOS']), 'category': 'Otros',
                 'concept': f'Egresos del {d.strftime("%d/%m/%Y")} en el sistema anterior'} for d in span if cents(cuadre[d]['EGRESOS']) > 0]
    income = [{'date': d.isoformat(), 'amountMinor': cents(cuadre[d]['INGRESOS']),
               'concept': f'Ingresos del {d.strftime("%d/%m/%Y")} en el sistema anterior'} for d in span if cents(cuadre[d]['INGRESOS']) > 0]
    return {'closingMinor': closing, 'openingMinor': cents(cuadre[prev_date]['TOTAL CAJA']),
            'collectionsMinor': sum(cents(cuadre[d]['ABONOS']) + cents(cuadre[d]['OTROS ABONOS']) for d in span),
            'disbursementsMinor': sum(cents(cuadre[d]['DESEMBOLSOS']) for d in span), 'expenses': expenses, 'income': income}


def active_credit(code, r, ccode, report, warnings):
    granted = day(r['FECHA'], f'crédito {code}')
    value, total, bal = money(r['VALOR CRÉDITO'], code), money(r['TOTAL CRÉDITO'], code), money(r['SALDO'], code)
    n = int(r['CUOTAS PACTADAS'] or 0)
    freq = FREQ.get(text(r['FORMA PAGO']).upper())
    if freq is None or n <= 0 or value <= 0 or total < value or bal <= 0 or bal > total:
        fail(f'crédito activo {code}: cifras o forma de pago no válidas ({text(r["FORMA PAGO"])})')
    quota = money(r['VALOR CUOTA'], code)
    last = total - quota * (n - 1)
    if quota <= 0 or last <= 0:
        fail(f'crédito activo {code}: el valor de la cuota no cuadra con el total')
    amounts = [quota] * (n - 1) + [last]
    if last != quota:
        warnings.append(f'crédito {code}: última cuota ajustada ({last / MINOR:.2f} en lugar de {quota / MINOR:.2f})')
    schedule = [{'number': k, 'dueDate': due_date(granted, freq, k).isoformat(), 'amountMinor': amt} for k, amt in enumerate(amounts, start=1)]
    first_due = due_date(granted, freq, 1)
    days = list(range(7)) if freq == 'diaria' else [(first_due.weekday() + 1) % 7]
    return {'code': code, 'clientCode': ccode, 'grantedOn': granted.isoformat(), 'valueMinor': value, 'totalMinor': total,
            'rate': round(float(r['% INTERÉS'] or 0) * 100, 4), 'installmentsCount': n, 'installmentValueMinor': quota,
            'frequency': freq, 'paymentDays': days, 'balanceMinor': bal, 'overdueListos': int(r['CUOTAS ATRASADAS'] or 0),
            'lastPaymentOn': day(r['FECHA ÚLTIMO ABONO'], code).isoformat() if r.get('FECHA ÚLTIMO ABONO') else None,
            'schedule': schedule}


def history_credit(code, r, ccode):
    freq = FREQ.get(text(r['FORMA PAGO']).upper())
    return {'code': code, 'clientCode': ccode, 'grantedOn': day(r['FECHA'], code).isoformat(), 'valueMinor': money(r['VALOR CRÉDITO'], code),
            'totalMinor': money(r['TOTAL CRÉDITO'], code), 'installmentsCount': int(r['CUOTAS PACTADAS'] or 0),
            'frequency': freq or text(r['FORMA PAGO']).lower(),
            'lastPaymentOn': day(r['FECHA ÚLTIMO ABONO'], code).isoformat() if r.get('FECHA ÚLTIMO ABONO') else None}


def client_of(r):
    code = text(r['CÓDIGO CLIENTE'])
    return {'code': code, 'name': text(r['CLIENTE']), 'document': text(r['DOCUMENTO']),
            'phone': text(r['CELULAR']), 'phone2': text(r['CELULAR ADICIONAL']) or None,
            'address': text(r['DIRECCIÓN']), 'address2': text(r['BARRIO']) or None,
            '_activos': int(r['CANTIDAD ACTIVOS'] or 0), '_saldo': money(r['SALDO ACTIVOS'], f'saldo del cliente {code}'),
            '_pagados': int(r['CANTIDAD PAGADOS'] or 0),
            '_ultimo_abono': day(r['FECHA ÚLTIMO ABONO'], code).isoformat() if r.get('FECHA ÚLTIMO ABONO') else None}


def read_clients(path, route):
    title, scope, header, crow = rows_of(path)
    if 'clientes activos' not in title.lower():
        fail('el archivo de clientes no es el «Reporte excel clientes activos»')
    if route not in scope.upper():
        fail(f'el reporte de clientes es de otra ruta ({scope})')
    if header[:len(CLIENT_COLS)] != CLIENT_COLS:
        fail('el reporte de clientes no tiene las columnas conocidas')
    return crow


def named(c, route):
    """Nombre y negocio separados (el sistema anterior los traía juntos); las notas van a observaciones."""
    name, business, notes = split_client(c['name'], route)
    return {'name': name or f'CLIENTE {c["code"]}', 'business': business, 'notes': notes}


def out_client(c, route):
    doc = re.sub(r'\D', '', c['document'])
    return {'code': c['code'], **named(c, route), 'document': c['document'] or c['code'],
            'documentType': 'CPF' if len(doc) == 11 and doc == c['document'] else None,
            'phone': c['phone'], 'phone2': c['phone2'], 'address': c['address'], 'address2': c['address2'], 'active': False}


DAY_COLS = ['RUTA', 'FECHA', 'DOCUMENTO', 'CÓDIGO CRÉDITO', 'VALOR CRÉDITO', '% INTERÉS', 'TOTAL CRÉDITO', 'SALDO', 'FORMA PAGO',
            'VALOR CUOTA', 'CUOTAS PACTADAS', 'CUOTAS ATRASADAS', 'FECHA ÚLTIMO ABONO', 'ESTADO']


def main_daily(a, report, route):
    """Cierre diario sobre el cierre ANTERIOR (.json): el «Reporte excel clientes activos» del día da el saldo y el número de
    créditos activos de cada cliente; el «Reporte excel créditos» (o «completo») trae los créditos nuevos o renovados.
    Un cliente con UN crédito que cambia de saldo = abono a ese crédito; si queda sin activos = crédito pagado. Si un cliente
    con varios créditos cambia y no se sabe a cuál, se detiene y pide el «créditos completo» de ese día."""
    with open(a.anterior, encoding='utf-8') as fh:
        prev = json.load(fh)
    if prev.get('sourceRouteName', '').strip().upper() != route:
        fail('el cierre anterior es de otra ruta')
    if prev['reportDate'] >= report.isoformat():
        fail(f'el cierre anterior ({prev["reportDate"]}) no es de una fecha anterior a {report.isoformat()}')
    warnings = []
    rep_clients = {}
    for r in read_clients(a.clientes, route):
        c = client_of(r)
        rep_clients[c['code']] = c
    by_doc = defaultdict(set)
    for c in list(rep_clients.values()) + prev['clients']:
        if c['document']:
            by_doc[c['document']].add(c['code'])

    # Créditos del día (nuevos, renovaciones o cambios): mandan sobre el cierre anterior.
    files = []
    for p in a.creditos or []:
        files += sorted(glob.glob(os.path.join(p, '*.xlsx'))) if os.path.isdir(p) else [p]
    fresh = {}
    for f in sorted(files, key=export_stamp):
        t, sc, h, rows = rows_of(f)
        if 'créditos' not in t.lower() and 'creditos' not in t.lower():
            fail(f'{os.path.basename(f)} no es un «Reporte excel créditos»')
        if any(col not in h for col in DAY_COLS):
            fail(f'{os.path.basename(f)} no tiene las columnas conocidas')
        for r in rows:
            if text(r['RUTA']).upper() == route:
                fresh[text(r['CÓDIGO CRÉDITO'])] = r
    prev_active = {c['code']: c for c in prev['credits']}
    history = [dict(h) for h in prev['history']]
    hist_codes = {h['code'] for h in history}
    active = {code: json.loads(json.dumps(c)) for code, c in prev_active.items()}
    touched = set()
    for code, r in fresh.items():
        if text(r.get('CÓDIGO CLIENTE')):
            ccode = text(r['CÓDIGO CLIENTE'])
        elif code in prev_active:
            ccode = prev_active[code]['clientCode']
        else:
            codes = sorted(by_doc.get(text(r['DOCUMENTO']), set()))
            if len(codes) != 1:
                fail(f'crédito {code}: no se encuentra un único cliente con ese documento')
            ccode = codes[0]
        state = text(r['ESTADO']).upper()
        if state == 'PAGADO':
            active.pop(code, None)
            if code not in hist_codes:
                history.append(history_credit(code, r, ccode))
                hist_codes.add(code)
            touched.add(code)
        elif state == 'ACTIVO':
            if code in hist_codes:
                fail(f'crédito {code}: estaba pagado y ahora aparece activo')
            active[code] = active_credit(code, r, ccode, report, warnings)
            touched.add(code)
        else:
            warnings.append(f'crédito {code} en estado {state}: no se carga')

    # Abonos y créditos pagados que no vinieron en el reporte de créditos: se deducen del reporte de clientes.
    per_client = defaultdict(list)
    for c in active.values():
        per_client[c['clientCode']].append(c)
    deduced_pay = deduced_paid = 0
    for code in sorted(set(per_client) | set(rep_clients)):
        rc = rep_clients.get(code)
        want_n, want_bal = (rc['_activos'], rc['_saldo']) if rc else (0, 0)
        mine = per_client.get(code, [])
        fixed = [c for c in mine if c['code'] in touched]
        free = [c for c in mine if c['code'] not in touched]
        rest_n = want_n - len(fixed)
        rest_bal = want_bal - sum(c['balanceMinor'] for c in fixed)
        if rest_n == len(free) and rest_bal == sum(c['balanceMinor'] for c in free):
            continue
        if rest_n == 0 and rest_bal == 0:
            for c in free:  # se pagaron
                active.pop(c['code'])
                history.append({'code': c['code'], 'clientCode': code, 'grantedOn': c['grantedOn'], 'valueMinor': c['valueMinor'],
                                'totalMinor': c['totalMinor'], 'installmentsCount': c['installmentsCount'], 'frequency': c['frequency'],
                                'lastPaymentOn': (rc or {}).get('_ultimo_abono') or report.isoformat()})
                hist_codes.add(c['code'])
                deduced_paid += 1
            continue
        if rest_n == 1 and len(free) == 1 and rest_bal > 0:
            c = active[free[0]['code']]
            drop = c['balanceMinor'] - rest_bal
            if drop < 0:
                fail(f'crédito {c["code"]}: el saldo subió ({c["balanceMinor"] / MINOR:,.2f} → {rest_bal / MINOR:,.2f}). '
                     'Falta en el reporte de créditos un crédito nuevo o renovado de ese cliente')
            c['balanceMinor'] = rest_bal
            c['lastPaymentOn'] = (rc or {}).get('_ultimo_abono') or c['lastPaymentOn']
            c['overdueListos'] = overdue_of(c, report)
            deduced_pay += 1
            continue
        if rest_n > len(free):
            fail(f'cliente {code}: tiene {want_n} crédito(s) activo(s) en Listos y faltan {rest_n - len(free)} en el reporte de créditos '
                 '(un crédito nuevo o una renovación). Descargue el «Reporte excel créditos» desde la fecha del cierre anterior')
        fail(f'cliente {code}: cambió y tiene varios créditos activos; no se sabe a cuál fue el abono. '
             'Para este día descargue el «Reporte excel créditos completo»')

    # Clientes: todos los del cierre anterior (actualizados con el reporte del día) y los nuevos.
    counts = defaultdict(int)
    for c in active.values():
        counts[c['clientCode']] += 1
    clients = {c['code']: dict(c) for c in prev['clients']}
    for code, rc in rep_clients.items():
        clients[code] = out_client(rc, route)
    for c in active.values():
        if c['clientCode'] not in clients:
            fail(f'crédito {c["code"]}: el cliente {c["clientCode"]} no está en ningún reporte')
    out_clients = []
    for code in sorted(clients):
        c = clients[code]
        c['active'] = counts.get(code, 0) > 0
        out_clients.append(c)
    act = sorted(active.values(), key=lambda c: (c['grantedOn'], c['code']))
    total_bal = sum(c['balanceMinor'] for c in act)
    if total_bal != sum(rc['_saldo'] for rc in rep_clients.values()):
        fail('Σ saldos de créditos activos ≠ Σ SALDO ACTIVOS del reporte de clientes')
    for rc in rep_clients.values():
        if (rc['_activos'], rc['_saldo']) != (counts.get(rc['code'], 0), sum(c['balanceMinor'] for c in act if c['clientCode'] == rc['code'])):
            fail(f'cliente {rc["code"]}: no cuadra con el reporte de clientes')
    if any(code not in rep_clients for code in counts):
        fail('hay créditos activos de clientes que no están en el reporte de clientes activos')
    # Créditos pagados: lo que sube CANTIDAD PAGADOS de cada cliente es lo que pasó al historial.
    if a.clientes_anterior:
        prev_rep = {text(r['CÓDIGO CLIENTE']): int(r['CANTIDAD PAGADOS'] or 0) for r in read_clients(a.clientes_anterior, route)}
        before, now = defaultdict(int), defaultdict(int)
        for h in prev['history']:
            before[h['clientCode']] += 1
        for h in history:
            now[h['clientCode']] += 1
        for code, rc in rep_clients.items():
            if code in prev_rep and rc['_pagados'] - prev_rep[code] != now[code] - before[code]:
                fail(f'cliente {code}: CANTIDAD PAGADOS subió {rc["_pagados"] - prev_rep[code]} y el historial {now[code] - before[code]}')
    payload = {
        'sourceRouteName': prev['sourceRouteName'], 'reportDate': report.isoformat(),
        'control': {'clients': len(out_clients), 'activeCredits': len(act), 'balanceMinor': total_bal},
        'listos': {'cajaMinor': int(round(a.caja * MINOR)) if a.caja is not None else None,
                   'carteraMinor': int(round(a.cartera * MINOR)) if a.cartera is not None else None},
        'clients': out_clients, 'credits': act, 'history': history,
    }
    if any(len(c['schedule']) != c['installmentsCount'] for c in prev['credits']):
        fail('el cierre anterior es del formato viejo (solo cuotas que faltaban): vuelva a generar los cierres desde el primero')
    cuadre = read_cuadre(a.cuadre, route)
    note = check_report_date(cuadre, report, total_bal)
    if note:
        warnings.append(note)
    payload['cash'] = cash_block(cuadre, dt.date.fromisoformat(prev['reportDate']), report)
    with open(a.salida, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
    print(f'Ruta {route} · cierre del {report.isoformat()} sobre el del {prev["reportDate"]} · {len(files)} archivo(s) de créditos')
    k = payload['cash']
    print(f'Cuadre de esos días: abonos {k["collectionsMinor"] / MINOR:,.2f} · desembolsos {k["disbursementsMinor"] / MINOR:,.2f} · '
          f'ingresos {sum(x["amountMinor"] for x in k["income"]) / MINOR:,.2f} · egresos {sum(x["amountMinor"] for x in k["expenses"]) / MINOR:,.2f} · '
          f'caja {k["openingMinor"] / MINOR:,.2f} → {k["closingMinor"] / MINOR:,.2f}')
    print(f'Clientes: {len(out_clients)} ({sum(1 for c in out_clients if c["active"])} con crédito activo)')
    print(f'Créditos activos: {len(act)} · saldo {total_bal / MINOR:,.2f} (antes {sum(c["balanceMinor"] for c in prev["credits"]) / MINOR:,.2f})')
    print(f'Del reporte de créditos: {len(touched)} · abonos deducidos: {deduced_pay} · pagados deducidos: {deduced_paid}')
    print(f'Créditos pagados (historial): {len(history)} (antes {len(prev["history"])})')
    for w in warnings:
        print(f'AVISO: {w}')
    print(f'Archivo de carga: {a.salida}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--ruta', required=True, help='nombre de la ruta en Listos, tal cual')
    ap.add_argument('--fecha', required=True, help='fecha del reporte (cierre del día), AAAA-MM-DD')
    ap.add_argument('--clientes', required=True)
    ap.add_argument('--creditos', nargs='+', help='archivos o carpetas con ReporteExcelCreditos')
    ap.add_argument('--anterior', help='cierre anterior (.json): modo diario con el reporte de clientes y los créditos del día')
    ap.add_argument('--clientes-anterior', help='reporte de clientes del cierre anterior (comprueba CANTIDAD PAGADOS)')
    ap.add_argument('--cuadre', nargs='+', required=True, help='archivos o carpetas con ReporteExcelCuadreVariasRutas (caja día a día)')
    ap.add_argument('--caja', type=float, help='TOTAL CAJA de Listos ese día (referencia)')
    ap.add_argument('--cartera', type=float, help='CARTERA de Listos ese día (referencia)')
    ap.add_argument('--salida', required=True)
    a = ap.parse_args()
    report = dt.date.fromisoformat(a.fecha)
    route = a.ruta.strip().upper()
    if a.anterior:
        return main_daily(a, report, route)
    if not a.creditos:
        fail('falta --creditos (o --anterior para el modo diario)')

    # ---------- Clientes activos (de la ruta) ----------
    title, scope, header, crow = rows_of(a.clientes)
    if 'clientes activos' not in title.lower():
        fail('el archivo de clientes no es el «Reporte excel clientes activos»')
    if route not in scope.upper():
        fail(f'el reporte de clientes es de otra ruta ({scope})')
    if header[:len(CLIENT_COLS)] != CLIENT_COLS:
        fail('el reporte de clientes no tiene las columnas conocidas')

    # ---------- Créditos (uno o varios archivos; gana la exportación más reciente) ----------
    files = []
    for p in a.creditos:
        files += sorted(glob.glob(os.path.join(p, '*Creditos*.xlsx'))) if os.path.isdir(p) else [p]
    if not files:
        fail('no hay archivos de créditos')
    # El «Reporte excel créditos» corto (sin CÓDIGO CLIENTE) también sirve: el cliente se busca por DOCUMENTO en el
    # reporte de clientes. Un crédito ACTIVO sin cliente único detiene la carga; un PAGADO sin cliente queda fuera del
    # historial y se informa.
    by_doc = defaultdict(set)
    for r in crow:
        by_doc[text(r['DOCUMENTO'])].add(text(r['CÓDIGO CLIENTE']))
    credits, short_files, paid_without_client = {}, 0, set()
    for f in sorted(files, key=export_stamp):
        t, sc, h, rows = rows_of(f)
        full = 'créditos completo' in t.lower() or 'creditos completo' in t.lower()
        if full:
            if h[:len(CREDIT_COLS)] != CREDIT_COLS or 'ESTADO' not in h:
                fail(f'{os.path.basename(f)} no tiene las columnas conocidas')
        elif 'excel créditos' in t.lower() or 'excel creditos' in t.lower():
            if not set(DAY_COLS + ['NOMBRE']) <= set(h):
                fail(f'{os.path.basename(f)} no tiene las columnas conocidas')
            short_files += 1
        else:
            fail(f'{os.path.basename(f)} no es un «Reporte excel créditos»')
        for r in rows:
            if text(r['RUTA']).upper() != route:
                continue
            code = text(r['CÓDIGO CRÉDITO'])
            if not full:
                r = dict(r)
                owners = by_doc.get(text(r['DOCUMENTO']), set())
                if len(owners) != 1:
                    if text(r['ESTADO']).upper() == 'ACTIVO':
                        fail(f'crédito activo {code}: su documento no está (o está repetido) en el reporte de clientes')
                    paid_without_client.add(code)
                    continue
                r['CÓDIGO CLIENTE'] = next(iter(owners))
                r['CLIENTE'] = r['NOMBRE']
            paid_without_client.discard(code)
            credits[code] = r
    if short_files:
        print(f'reporte corto de créditos en {short_files} archivo(s): cliente buscado por documento; '
              f'{len(paid_without_client)} crédito(s) pagado(s) sin cliente en el reporte quedan fuera del historial')
    if not credits:
        fail('ningún crédito de esa ruta en los archivos de créditos')

    # ---------- Clientes ----------
    clients = {}
    for r in crow:
        code = text(r['CÓDIGO CLIENTE'])
        clients[code] = {'code': code, 'name': text(r['CLIENTE']), 'document': text(r['DOCUMENTO']),
                         'phone': text(r['CELULAR']), 'phone2': text(r['CELULAR ADICIONAL']) or None,
                         'address': text(r['DIRECCIÓN']), 'address2': text(r['BARRIO']) or None,
                         '_activos': int(r['CANTIDAD ACTIVOS'] or 0), '_saldo': money(r['SALDO ACTIVOS'], f'saldo del cliente {code}')}
    extra_clients = 0
    for r in credits.values():
        code = text(r['CÓDIGO CLIENTE'])
        if code not in clients:  # solo con créditos pagados y fuera del reporte de clientes
            extra_clients += 1
            clients[code] = {'code': code, 'name': text(r['CLIENTE']), 'document': text(r['DOCUMENTO']),
                             'phone': text(r['CELULAR']) or text(r['TELÉFONO']), 'phone2': None,
                             'address': text(r['DIRECCIÓN COBRO']), 'address2': text(r['BARRIO']) or None, '_activos': 0, '_saldo': 0}

    active, history, other = [], [], defaultdict(int)
    per_client = defaultdict(lambda: [0, 0])
    warnings = []
    mora_diff = 0
    for code, r in sorted(credits.items(), key=lambda kv: (day(kv[1]['FECHA'], kv[0]), kv[0])):
        state = text(r['ESTADO']).upper()
        granted = day(r['FECHA'], f'crédito {code}')
        value, total, bal = money(r['VALOR CRÉDITO'], code), money(r['TOTAL CRÉDITO'], code), money(r['SALDO'], code)
        n = int(r['CUOTAS PACTADAS'] or 0)
        freq = FREQ.get(text(r['FORMA PAGO']).upper())
        ccode = text(r['CÓDIGO CLIENTE'])
        if state == 'PAGADO':
            history.append({'code': code, 'clientCode': ccode, 'grantedOn': granted.isoformat(), 'valueMinor': value, 'totalMinor': total,
                            'installmentsCount': n, 'frequency': freq or text(r['FORMA PAGO']).lower(),
                            'lastPaymentOn': day(r['FECHA ÚLTIMO ABONO'], code).isoformat() if r.get('FECHA ÚLTIMO ABONO') else None})
            continue
        if state != 'ACTIVO':
            other[state] += 1
            continue
        c = active_credit(code, r, ccode, report, warnings)
        if overdue_of(c, report) != c['overdueListos']:
            mora_diff += 1
        active.append(c)
        per_client[ccode][0] += 1
        per_client[ccode][1] += bal

    # ---------- Controles cruzados con el reporte de clientes ----------
    total_bal = sum(c['balanceMinor'] for c in active)
    total_clients_report = sum(c['_saldo'] for c in clients.values())
    if total_bal != total_clients_report:
        fail(f'Σ saldos de créditos activos ({total_bal / MINOR:,.2f}) ≠ Σ SALDO ACTIVOS de clientes ({total_clients_report / MINOR:,.2f}): '
             'falta algún archivo de créditos (exporte desde 2025-01-01) o son de días distintos')
    bad = [c for c in clients.values() if (c['_activos'], c['_saldo']) != tuple(per_client.get(c['code'], [0, 0]))]
    if bad:
        fail(f'{len(bad)} cliente(s) con número de activos o saldo distinto entre los dos reportes')

    out_clients = []
    for c in sorted(clients.values(), key=lambda x: x['code']):
        doc = re.sub(r'\D', '', c['document'])
        out_clients.append({'code': c['code'], **named(c, route), 'document': c['document'] or c['code'],
                            'documentType': 'CPF' if len(doc) == 11 and doc == c['document'] else None,
                            'phone': c['phone'], 'phone2': c['phone2'], 'address': c['address'], 'address2': c['address2'],
                            'active': per_client.get(c['code'], [0])[0] > 0})
    payload = {
        'sourceRouteName': a.ruta.strip(), 'reportDate': report.isoformat(),
        'control': {'clients': len(out_clients), 'activeCredits': len(active), 'balanceMinor': total_bal},
        'listos': {'cajaMinor': int(round(a.caja * MINOR)) if a.caja is not None else None,
                   'carteraMinor': int(round(a.cartera * MINOR)) if a.cartera is not None else None},
        'clients': out_clients, 'credits': active, 'history': history,
    }
    if a.cartera is not None and int(round(a.cartera * MINOR)) != total_bal:
        warnings.append(f'la CARTERA de Listos ({a.cartera:,.2f}) no es igual a Σ saldos ({total_bal / MINOR:,.2f})')
    cuadre = read_cuadre(a.cuadre, route)
    note = check_report_date(cuadre, report, total_bal)
    if note:
        warnings.append(note)
    payload['cash'] = cash_block(cuadre, None, report)
    with open(a.salida, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)

    # ---------- Resumen (solo cifras) ----------
    print(f'Caja de apertura (TOTAL CAJA del {report}): {payload["cash"]["closingMinor"] / MINOR:,.2f}'
          + (' (negativa: deuda con el socio en ADEX)' if payload['cash']['closingMinor'] < 0 else ''))
    freqs = defaultdict(int)
    for c in active:
        freqs[c['frequency']] += 1
    print(f'Ruta {route} · reporte del {report.isoformat()} · {len(files)} archivo(s) de créditos')
    print(f'Clientes: {len(out_clients)} ({sum(1 for c in out_clients if c["active"])} con crédito activo; {extra_clients} solo en el reporte de créditos)')
    print(f'Créditos activos: {len(active)} · saldo {total_bal / MINOR:,.2f} · por frecuencia {dict(freqs)}')
    print(f'Créditos pagados (historial): {len(history)}' + (f' · otros estados no cargados: {dict(other)}' if other else ''))
    print(f'Cuotas atrasadas distintas de Listos: {mora_diff} de {len(active)} créditos')
    print(f'Documentos sin CPF válido (se cargan sin tipo): {sum(1 for c in out_clients if c["documentType"] is None)}')
    for w in warnings:
        print(f'AVISO: {w}')
    print(f'Archivo de carga: {a.salida}')


if __name__ == '__main__':
    main()
