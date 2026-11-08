"""Migración de rutas: plantilla ADEX llena por el dueño (archivo .html) → archivo de carga para ADEX.

Para rutas que NO vienen con los reportes de excel del sistema anterior: el dueño llena
docs/plantillas/ADEX_Plantilla_Migracion_Ruta.html en su celular o computador, la guarda y la devuelve por WhatsApp.

Uso (la plantilla devuelta y la salida van FUERA del repositorio: tienen datos personales):

    python -I plantilla_a_adex.py --plantilla <ADEX_migracion_<ruta>_<fecha>.html> --salida <cierre_AAAA-MM-DD.json>
        [--anterior <cierre anterior.json>] [--hoy AAAA-MM-DD]

- Saca los datos guardados dentro del archivo (bloque «adex-datos») y arma el mismo JSON que listos_a_adex.py:
  sourceRouteName, reportDate, control, listos, clients, credits, history. Se sube igual en ADEX
  (Rutas → «Cargar datos»), que lo vuelve a comprobar todo en PostgreSQL.
- Códigos: cada cliente y cada crédito de la plantilla tiene un identificador fijo (uid) que no cambia al editarla;
  ese es su código en ADEX. Así una plantilla corregida y reenviada sirve como cierre del día siguiente.
- Calendario de cada crédito activo: cuotas pactadas desde la fecha del préstamo (la cuota k vence k días, semanas,
  quincenas o meses después; en los diarios se salta el domingo si el cobrador no cobra ese día). Van TODAS las cuotas
  (0050, venta por su valor registrado); ADEX registra lo pagado (total − saldo) como un abono previo a la migración.
  Si el dueño anota «cuotas atrasadas», el calendario se corre (misma frecuencia) para que exactamente esas cuotas de las
  que faltan queden vencidas el día del reporte: ADEX marca vencidas por fecha. Sin ese dato, quedan las fechas pactadas.
- Caja (0050): efectivo de la ruta + efectivo del cobrador que anotó el dueño = caja de apertura de la ruta en ADEX.
- «Créditos que ya pagó antes» (solo un número) queda como historial sin detalle.
- Modo diario (--anterior): un crédito que estaba en el cierre anterior y ya no está en la plantilla debe aparecer
  como pagado (el dueño lo quita y sube «créditos que ya pagó» de ese cliente). Si no, se detiene: ADEX no sabe si se
  pagó o se borró por error.
- Imprime solo cifras agregadas (sin nombres ni documentos). Los errores señalan el cliente por su número en la plantilla.
"""
import argparse
import datetime as dt
import html
import json
import math
import re
import sys

MINOR = 100
FREQS = ('diaria', 'semanal', 'quincenal', 'mensual')
BLOCK = re.compile(r'<script\b[^>]*\bid="adex-datos"[^>]*>\s*/\*DATOS_INICIO\*/(.*?)/\*DATOS_FIN\*/\s*</script>', re.S)


def fail(msg):
    print(f'ERROR: {msg}', file=sys.stderr)
    sys.exit(2)


def num(v):
    """Igual que num() de la plantilla: acepta «1.234,50», «1234.5», «R$ 300», «1.500»."""
    if v is None:
        return None
    s = re.sub(r'R\$|\s', '', str(v))
    if not s:
        return None
    if ',' in s:
        s = s.replace('.', '').replace(',', '.')
    elif s.count('.') > 1 or re.fullmatch(r'\d{1,3}(\.\d{3})+', s):
        s = s.replace('.', '')
    try:
        x = float(s)
    except ValueError:
        return None
    return x if math.isfinite(x) else None


def minor(x):
    return int(round(x * MINOR))


def cpf_ok(d):
    if len(d) != 11 or len(set(d)) == 1:
        return False
    for t in (9, 10):
        s = sum(int(d[i]) * (t + 1 - i) for i in range(t))
        if (s * 10) % 11 % 10 != int(d[t]):
            return False
    return True


def day(v):
    try:
        return dt.date.fromisoformat(str(v)[:10]) if v else None
    except ValueError:
        return None


def add_months(d, n):
    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    last = [31, 29 if y % 4 == 0 and (y % 100 != 0 or y % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return dt.date(y, m, min(d.day, last))


def due_dates(start, freq, n, sundays):
    if freq == 'diaria':
        out, cur = [], start
        while len(out) < n:
            cur += dt.timedelta(days=1)
            if sundays or cur.weekday() != 6:
                out.append(cur)
        return out
    if freq == 'semanal':
        return [start + dt.timedelta(days=7 * k) for k in range(1, n + 1)]
    if freq == 'quincenal':
        return [start + dt.timedelta(days=15 * k) for k in range(1, n + 1)]
    return [add_months(start, k) for k in range(1, n + 1)]


def js_weekday(d):
    return (d.weekday() + 1) % 7  # ADEX: domingo = 0


def read_template(path):
    with open(path, encoding='utf-8') as fh:
        m = BLOCK.search(fh.read())
    if not m:
        fail('el archivo no es la plantilla de migración de ADEX (no tiene el bloque de datos)')
    raw = m.group(1).strip()
    if raw == 'null':
        fail('la plantilla está vacía: el dueño debe usar «Guardar archivo» y enviar ESE archivo (no la plantilla original)')
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        try:
            d = json.loads(html.unescape(raw))
        except json.JSONDecodeError:
            fail('los datos guardados en la plantilla están dañados')
    if not isinstance(d, dict) or d.get('version') != 1:
        fail(f'versión de plantilla desconocida ({d.get("version") if isinstance(d, dict) else "?"})')
    return d


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--plantilla', required=True, help='archivo .html guardado y devuelto por el dueño')
    ap.add_argument('--salida', required=True, help='JSON de carga para ADEX')
    ap.add_argument('--anterior', help='cierre anterior (.json) de esta misma plantilla: modo diario')
    ap.add_argument('--hoy', help='fecha de hoy (AAAA-MM-DD) para las comprobaciones; por omisión, la del equipo')
    a = ap.parse_args()
    today = day(a.hoy) if a.hoy else dt.date.today()

    D = read_template(a.plantilla)
    r = D.get('ruta') or {}
    errors, warnings = [], []
    route_name = str(r.get('ruta') or '').strip()
    report = day(r.get('fechaCorte'))
    sundays = r.get('cobraDomingos') == 'si'
    if not route_name:
        errors.append('falta el nombre de la ruta')
    if not str(r.get('empresa') or '').strip() or not str(r.get('responsable') or '').strip():
        errors.append('faltan la empresa o el responsable (paso 1)')
    if report is None:
        fail('falta la fecha de los datos (paso 1)')
    if report > today:
        fail(f'la fecha de los datos ({report}) es posterior a hoy ({today})')

    clients_in = D.get('clientes') or []
    if not clients_in:
        fail('la plantilla no tiene clientes')

    clients, credits, placeholders = [], [], {}
    shifted = 0
    seen_docs, codes = {}, set()
    for i, cl in enumerate(clients_in, start=1):
        who = f'cliente n.º {i}'
        ccode = str(cl.get('uid') or '').strip()
        if not ccode or ccode in codes:
            fail(f'{who}: sin identificador o repetido (archivo alterado)')
        codes.add(ccode)
        name = str(cl.get('nombre') or '').strip()
        doc_raw = str(cl.get('documento') or '').strip()
        if not name:
            errors.append(f'{who}: falta el nombre')
        if not doc_raw:
            errors.append(f'{who}: falta el documento')
        digits = re.sub(r'\D', '', doc_raw)
        is_cpf = cpf_ok(digits)
        document = digits if is_cpf else doc_raw
        if doc_raw:
            seen_docs.setdefault(digits or doc_raw.upper(), []).append(i)
        n_active = 0
        for j, c in enumerate(cl.get('creditos') or [], start=1):
            cw = f'{who}, crédito {j}'
            code = str(c.get('uid') or '').strip()
            if not code or code in codes:
                fail(f'{cw}: sin identificador o repetido (archivo alterado)')
            codes.add(code)
            granted = day(c.get('fecha'))
            value, total, bal = num(c.get('valor')), num(c.get('total')), num(c.get('saldo'))
            n = num(c.get('cuotas'))
            quota = num(c.get('valorCuota'))
            freq = c.get('forma')
            bad = []
            if granted is None:
                bad.append('falta la fecha del préstamo')
            elif granted > report:
                bad.append('fecha del préstamo posterior a la fecha de los datos')
            if not value or value <= 0:
                bad.append('falta el valor prestado')
            if not total or total <= 0:
                bad.append('falta el total a pagar')
            if not n or n <= 0 or n != int(n):
                bad.append('número de cuotas no válido')
            if bal is None:
                bad.append('falta el saldo')
            if freq not in FREQS:
                bad.append('forma de pago no válida')
            if not bad:
                if total < value:
                    bad.append('total menor que lo prestado')
                if bal > total:
                    bad.append('saldo mayor que el total')
            if bad:
                errors.append(f'{cw}: ' + '; '.join(bad))
                continue
            if bal <= 0:
                warnings.append(f'{cw}: saldo cero, se cuenta como ya pagado')
                placeholders[ccode] = placeholders.get(ccode, 0) + 1
                continue
            n = int(n)
            value_m, total_m, bal_m = minor(value), minor(total), minor(bal)
            quota_m = minor(quota) if quota and quota > 0 else int(math.ceil(total_m / n))
            last = total_m - quota_m * (n - 1)
            if last <= 0:
                errors.append(f'{cw}: cuotas × valor de la cuota es mayor que el total')
                continue
            if abs(last - quota_m) > quota_m:
                warnings.append(f'{cw}: cuotas × valor de la cuota no da el total; la última cuota se ajusta')
            amounts = [quota_m] * (n - 1) + [last]
            dates = due_dates(granted, freq, n, sundays)
            # 0050 (venta real): TODAS las cuotas; ADEX registra lo ya pagado como un abono.
            schedule = [{'number': k, 'dueDate': due.isoformat(), 'amountMinor': amt} for k, (amt, due) in enumerate(zip(amounts, dates), start=1)]
            paid, first_left = total_m - bal_m, 0
            for x in schedule:
                if paid >= x['amountMinor']:
                    paid -= x['amountMinor']
                    first_left += 1
                else:
                    break
            rate = num(c.get('interes'))
            if rate is None or rate < 0:
                rate = (total / value - 1) * 100
            overdue_given = num(c.get('atrasadas'))
            if overdue_given is not None and (overdue_given < 0 or overdue_given != int(overdue_given)):
                warnings.append(f'{cw}: cuotas atrasadas no válidas, se calculan por las fechas')
                overdue_given = None
            if overdue_given is not None:
                # Las fechas salen de la fecha del préstamo como si el cliente hubiera pagado siempre al día; el dueño sabe
                # cuántas cuotas lleva atrasadas. Se corren las fechas que faltan, con la misma frecuencia, para que
                # exactamente esas queden vencidas al día del reporte (ADEX marca vencidas por fecha).
                want = int(overdue_given)
                remaining = n - first_left
                cadence = due_dates(granted, freq, n, sundays)
                while cadence[-1] <= report:
                    cadence = due_dates(granted, freq, len(cadence) * 2, sundays)
                due_by_report = sum(1 for x in cadence if x <= report)
                if want > remaining:
                    warnings.append(f'{cw}: anotó {want} cuotas atrasadas pero solo le faltan {remaining}; quedan vencidas las {remaining}')
                    want = remaining
                if want > due_by_report:
                    warnings.append(f'{cw}: anotó {want} cuotas atrasadas pero desde el préstamo solo han vencido {due_by_report}; quedan {due_by_report}')
                    want = due_by_report
                start = due_by_report - want
                cadence = due_dates(granted, freq, start + remaining, sundays)
                # Se corre todo el calendario: la primera cuota que falta cae en cadence[start]; las ya pagadas antes (nunca
                # antes de la primera fecha posible).
                for i, x in enumerate(schedule):
                    x['dueDate'] = cadence[max(0, start + i - first_left)].isoformat()
                overdue_given = want
                shifted += 1
            overdue_calc = sum(1 for x in schedule[first_left:] if dt.date.fromisoformat(x['dueDate']) <= report)
            last_pay = day(c.get('ultimoAbono'))
            if freq == 'diaria':
                days = list(range(7)) if sundays else list(range(1, 7))
            else:
                days = [js_weekday(dt.date.fromisoformat(schedule[first_left]['dueDate']))]
            credits.append({'code': code, 'clientCode': ccode, 'grantedOn': granted.isoformat(), 'valueMinor': value_m,
                            'totalMinor': total_m, 'rate': round(rate, 4), 'installmentsCount': n, 'installmentValueMinor': quota_m,
                            'frequency': freq, 'paymentDays': days, 'balanceMinor': bal_m,
                            'overdueListos': int(overdue_given) if overdue_given is not None and overdue_given >= 0 else overdue_calc,
                            'lastPaymentOn': last_pay.isoformat() if last_pay else None, 'schedule': schedule})
            n_active += 1
        before = num(cl.get('pagadosAntes'))
        if before is not None and (before < 0 or before != int(before)):
            errors.append(f'{who}: «créditos que ya pagó» no es un número entero')
            before = None
        placeholders[ccode] = placeholders.get(ccode, 0) + int(before or 0)
        clients.append({'code': ccode, 'name': name, 'document': document, 'documentType': 'CPF' if is_cpf else None,
                        'phone': str(cl.get('celular') or '').strip(), 'phone2': str(cl.get('celular2') or '').strip() or None,
                        'address': str(cl.get('direccion') or '').strip(), 'address2': str(cl.get('barrio') or '').strip() or None,
                        'active': n_active > 0, '_n': i})
    if errors:
        for e in errors[:40]:
            print(f'  · {e}', file=sys.stderr)
        fail(f'{len(errors)} problema(s) en la plantilla: hay que corregirlos con el dueño y que la reenvíe')

    # ---------- Historial: reales (del modo diario) + «créditos que ya pagó» sin detalle ----------
    history = []
    by_client = {c['code']: c for c in clients}
    if a.anterior:
        with open(a.anterior, encoding='utf-8') as fh:
            prev = json.load(fh)
        prev_report = day(prev.get('reportDate'))
        if prev_report is None or report <= prev_report:
            fail(f'la fecha de los datos ({report}) debe ser posterior al cierre anterior ({prev.get("reportDate")})')
        if str(prev.get('sourceRouteName', '')).strip().upper() != route_name.upper():
            fail('el cierre anterior es de otra ruta')
        prev_clients = {c['code'] for c in prev.get('clients', [])}
        if not prev_clients <= set(by_client):
            fail(f'{len(prev_clients - set(by_client))} cliente(s) del cierre anterior ya no están en la plantilla: '
                 'no se quitan clientes durante la migración')
        now_codes = {c['code'] for c in credits}
        # Todo lo que ya estaba en el historial se conserva (con sus códigos); los créditos que desaparecen pasan a pagados.
        history = [dict(h) for h in prev.get('history', [])]
        gone = [c for c in prev.get('credits', []) if c['code'] not in now_codes]
        for c in gone:
            history.append({'code': c['code'], 'clientCode': c['clientCode'], 'grantedOn': c['grantedOn'], 'valueMinor': c['valueMinor'],
                            'totalMinor': c['totalMinor'], 'installmentsCount': c['installmentsCount'], 'frequency': c['frequency'],
                            'lastPaymentOn': report.isoformat()})
    # «Créditos que ya pagó» (+ créditos con saldo cero) de cada cliente debe cubrir su historial: si un crédito
    # desaparece sin que el dueño lo sume como pagado, no se sabe si se pagó o se borró por error.
    in_hist, in_hist_ph = {}, {}
    for h in history:
        in_hist[h['clientCode']] = in_hist.get(h['clientCode'], 0) + 1
        if h.get('placeholder'):
            in_hist_ph[h['clientCode']] = in_hist_ph.get(h['clientCode'], 0) + 1
    short = [k for k in by_client if placeholders.get(k, 0) < in_hist.get(k, 0)]
    if short:
        fail(f'{len(short)} cliente(s) tienen créditos que desaparecieron (o bajaron «créditos que ya pagó») sin sumarse como pagados '
             f'(clientes n.º {", ".join(str(by_client[k]["_n"]) for k in short[:15])}): '
             'confirme con el dueño si se pagaron (y que lo anote) o si se borraron por error')
    for k in by_client:
        for i in range(1, placeholders.get(k, 0) - in_hist.get(k, 0) + 1):
            history.append({'code': f'{k}-P{in_hist_ph.get(k, 0) + i}', 'clientCode': k, 'grantedOn': None, 'valueMinor': None,
                            'totalMinor': None, 'installmentsCount': None, 'frequency': None, 'lastPaymentOn': None, 'placeholder': True})

    dups = [v for v in seen_docs.values() if len(v) > 1]
    total_bal = sum(c['balanceMinor'] for c in credits)
    caja = D.get('caja') or {}
    cash = num(caja.get('efectivoRuta'))
    for c in clients:
        del c['_n']
    payload = {
        'sourceRouteName': route_name, 'reportDate': report.isoformat(),
        'control': {'clients': len(clients), 'activeCredits': len(credits), 'balanceMinor': total_bal},
        'listos': {'cajaMinor': minor(cash) if cash is not None else None, 'carteraMinor': total_bal},
        'origin': 'plantilla',
        'templateCash': {k: (minor(num(caja.get(k))) if num(caja.get(k)) is not None else None)
                         for k in ('efectivoRuta', 'efectivoCobrador', 'gastosSinAnotar', 'ahorros')},
        'clients': clients, 'credits': credits, 'history': history,
        # 0050: caja de la ruta al corte = efectivo de la ruta + el que tiene el cobrador (lo que anotó el dueño).
        'cash': {'closingMinor': (minor(cash) if cash is not None else 0) + (minor(num(caja.get('efectivoCobrador'))) if num(caja.get('efectivoCobrador')) is not None else 0)},
    }
    with open(a.salida, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)

    # ---------- Resumen (solo cifras) ----------
    freqs = {}
    for c in credits:
        freqs[c['frequency']] = freqs.get(c['frequency'], 0) + 1
    print(f'Ruta {route_name} · datos del {report.isoformat()} · plantilla actualizada {str(D.get("actualizado", ""))[:16]}')
    print(f'Clientes: {len(clients)} ({sum(1 for c in clients if c["active"])} con crédito activo)')
    print(f'Créditos activos: {len(credits)} · saldo {total_bal / MINOR:,.2f} · por forma de pago {freqs}')
    print(f'Historial de pagados: {len(history)} ({sum(1 for h in history if h.get("placeholder"))} solo como número)')
    print(f'Créditos con fechas ajustadas a las cuotas atrasadas anotadas: {shifted} de {len(credits)}')
    print(f'Documentos que no son CPF válido (se cargan sin tipo): {sum(1 for c in clients if c["documentType"] is None)}')
    print(f'Documentos repetidos dentro de la plantilla: {len(dups)}')
    tc = payload['templateCash']
    print('Caja anotada: ' + ' · '.join(f'{k} {v / MINOR:,.2f}' if v is not None else f'{k} —' for k, v in tc.items()))
    if str(caja.get('notas') or '').strip():
        print('La plantilla trae notas de caja: léalas en el archivo (no se copian aquí).')
    for w in warnings:
        print(f'AVISO: {w}')
    print(f'Archivo de carga: {a.salida}')


if __name__ == '__main__':
    main()
