-- ============================================================
-- 0027 · Ronda 65 (corregida en 65-C1): DESEMBOLSOS SIN CONEXIÓN DEL COBRADOR
-- ============================================================
-- El Cobrador puede, sin internet, entregar el dinero de una solicitud YA APROBADA (conocida por
-- su dispositivo en la última sincronización) con el efectivo que tiene en custodia. El
-- dispositivo envía la operación al volver la conexión por el MISMO comando de siempre
-- (`POST /v1/credit-requests/:id/disburse`) con su id de operación y un campo `offline`; el
-- servidor decide con el estado VIGENTE.
--
-- Decisión del propietario (65-C1): clientes nuevos y ventas/solicitudes NO se registran sin
-- conexión; el Cobrador llama a la oficina. Por eso esta migración solo admite desembolsos.
--
-- Reglas que NO cambian (0010/0018 y la API): el Cobrador no tiene venta directa;
-- `adex.credit_disburse` sigue siendo la única vía de creación de créditos (solicitud aprobada,
-- custodia sin faltante arrastrado, ruta operativa, periodo abierto, una transacción con el
-- asiento). Sin fondos: 409 y nada escrito.
--
-- Lo que añade (no modifica ni borra datos existentes):
--   A. `adex.offline_captures.kind` admite además 'disbursement' (se amplía la restricción;
--      ninguna fila existente deja de cumplirla).
--   B. El guardián exige que el crédito lo desembolsara ESTA membresía.

-- ---------- A. Nuevo tipo de captura ----------
alter table adex.offline_captures drop constraint offline_captures_kind_check;
alter table adex.offline_captures add constraint offline_captures_kind_check
  check (kind in ('payment', 'visit', 'expense', 'disbursement'));

comment on table adex.offline_captures is
  'Operaciones del Cobrador capturadas sin conexión (abonos, visitas, gastos y desembolsos de solicitudes aprobadas): hora del dispositivo y saldo mostrado (evidencia, dato no confiable). Rondas 62 y 65.';

-- ---------- B. Guardián ----------
create or replace function adex.offline_capture_guard() returns trigger
  language plpgsql
  as $$
  begin
    if current_user <> 'adex_api' then
      return new;
    end if;
    if new.kind = 'payment' and not exists (select 1 from adex.payments p
         where p.company_id = new.company_id and p.id = new.entity_id and p.route_id = new.route_id
           and p.created_by_membership_id = new.membership_id) then
      raise exception 'adex: offline capture must belong to a payment registered by the same membership' using errcode = 'AX411';
    end if;
    if new.kind = 'visit' and not exists (select 1 from adex.no_payment_visits v
         where v.company_id = new.company_id and v.id = new.entity_id and v.route_id = new.route_id
           and v.collector_membership_id = new.membership_id) then
      raise exception 'adex: offline capture must belong to a visit registered by the same membership' using errcode = 'AX411';
    end if;
    if new.kind = 'expense' and not exists (select 1 from adex.expenses e
         where e.company_id = new.company_id and e.id = new.entity_id and e.route_id = new.route_id
           and e.registered_by_membership_id = new.membership_id) then
      raise exception 'adex: offline capture must belong to an expense registered by the same membership' using errcode = 'AX411';
    end if;
    -- Ronda 65: desembolso de una solicitud aprobada, hecho por la misma membresía.
    if new.kind = 'disbursement' and not exists (select 1 from adex.sales s
         where s.company_id = new.company_id and s.id = new.entity_id and s.route_id = new.route_id
           and s.disbursed_by_membership_id = new.membership_id) then
      raise exception 'adex: offline capture must belong to a credit disbursed by the same membership' using errcode = 'AX411';
    end if;
    -- La hora de recepción la pone el servidor, no el cliente.
    new.received_at := now();
    return new;
  end $$;
