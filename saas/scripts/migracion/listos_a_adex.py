"""Migración de rutas (0044): reportes de Listos → archivo de carga para ADEX.

Uso (desde cualquier carpeta; los archivos de Listos y la salida van FUERA del repositorio, tienen datos personales):

    python -I listos_a_adex.py --ruta "VALPARAISO SOC GAJ" --fecha 2026-11-08 \
        --clientes <ReporteExcelClientesActivos.xlsx> --creditos <carpeta o archivos ReporteExcelCreditos*.xlsx> \
        [--caja -1580] [--cartera 63773] --salida <carga.json>

- Lee los «ReporteExcelCreditos completo» (uno o varios, de la oficina o de la ruta; se unen por CÓDIGO CRÉDITO y gana la
  exportación más reciente) y el «ReporteExcelClientesActivos» de la ruta.
- Comprueba: encabezados conocidos, ruta correcta, Σ saldos y número de activos por cliente iguales en los dos reportes.
- Cada crédito ACTIVO: calendario original (frecuencia y cuotas pactadas desde la fecha del crédito), se descuenta lo
  pagado (TOTAL − SALDO) desde la primera cuota y quedan las cuotas que FALTAN, con sus fechas originales.
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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--ruta', required=True, help='nombre de la ruta en Listos, tal cual')
    ap.add_argument('--fecha', required=True, help='fecha del reporte (cierre del día), AAAA-MM-DD')
    ap.add_argument('--clientes', required=True)
    ap.add_argument('--creditos', required=True, nargs='+', help='archivos o carpetas con ReporteExcelCreditos')
    ap.add_argument('--caja', type=float, help='TOTAL CAJA de Listos ese día (referencia)')
    ap.add_argument('--cartera', type=float, help='CARTERA de Listos ese día (referencia)')
    ap.add_argument('--salida', required=True)
    a = ap.parse_args()
    report = dt.date.fromisoformat(a.fecha)
    route = a.ruta.strip().upper()

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
    credits = {}
    for f in sorted(files, key=export_stamp):
        t, sc, h, rows = rows_of(f)
        if 'créditos completo' not in t.lower() and 'creditos completo' not in t.lower():
            fail(f'{os.path.basename(f)} no es el «Reporte excel créditos completo»')
        if h[:len(CREDIT_COLS)] != CREDIT_COLS or 'ESTADO' not in h:
            fail(f'{os.path.basename(f)} no tiene las columnas conocidas')
        for r in rows:
            if text(r['RUTA']).upper() != route:
                continue
            credits[text(r['CÓDIGO CRÉDITO'])] = r
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
        if freq is None or n <= 0 or value <= 0 or total < value or bal <= 0 or bal > total:
            fail(f'crédito activo {code}: cifras o forma de pago no válidas ({text(r["FORMA PAGO"])})')
        quota = money(r['VALOR CUOTA'], code)
        last = total - quota * (n - 1)
        if quota <= 0 or last <= 0:
            fail(f'crédito activo {code}: el valor de la cuota no cuadra con el total')
        amounts = [quota] * (n - 1) + [last]
        if last != quota:
            warnings.append(f'crédito {code}: última cuota ajustada ({last / MINOR:.2f} en lugar de {quota / MINOR:.2f})')
        paid = total - bal
        schedule = []
        for k, amt in enumerate(amounts, start=1):
            take = min(paid, amt)
            paid -= take
            if amt - take > 0:
                schedule.append({'number': len(schedule) + 1, 'dueDate': due_date(granted, freq, k).isoformat(), 'amountMinor': amt - take})
        first_due = due_date(granted, freq, 1)
        days = list(range(7)) if freq == 'diaria' else [(first_due.weekday() + 1) % 7]
        # Como cuenta Listos (comprobado: 37 de 41 en Valparaíso): vencidas hasta el día del reporte inclusive, sin contar
        # la cuota con abono parcial. ADEX marca vencida toda cuota con fecha anterior a hoy: la diferencia es solo informativa.
        partial = bool(schedule) and schedule[0]['amountMinor'] != amounts[len(amounts) - len(schedule)]
        overdue_adex = sum(1 for i, s in enumerate(schedule) if dt.date.fromisoformat(s['dueDate']) <= report and not (i == 0 and partial))
        overdue_listos = int(r['CUOTAS ATRASADAS'] or 0)
        if overdue_adex != overdue_listos:
            mora_diff += 1
        active.append({'code': code, 'clientCode': ccode, 'grantedOn': granted.isoformat(), 'valueMinor': value, 'totalMinor': total,
                       'rate': round(float(r['% INTERÉS'] or 0) * 100, 4), 'installmentsCount': n, 'installmentValueMinor': quota,
                       'frequency': freq, 'paymentDays': days, 'balanceMinor': bal, 'overdueListos': overdue_listos,
                       'lastPaymentOn': day(r['FECHA ÚLTIMO ABONO'], code).isoformat() if r.get('FECHA ÚLTIMO ABONO') else None,
                       'schedule': schedule})
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
        out_clients.append({'code': c['code'], 'name': c['name'] or f'CLIENTE {c["code"]}', 'document': c['document'] or c['code'],
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
    with open(a.salida, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)

    # ---------- Resumen (solo cifras) ----------
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
