-- ============================================================
-- 0027 · Ronda 65: SIN CONEXIÓN DEL COBRADOR — CLIENTES, SOLICITUDES Y DESEMBOLSOS
-- ============================================================
-- El Cobrador puede, sin internet, dar de alta un cliente, registrar una solicitud de crédito
-- y entregar el dinero de una solicitud YA APROBADA con el efectivo que tiene en custodia. El
-- dispositivo envía cada operación al volver la conexión por el MISMO comando de siempre
-- (`POST /v1/clients`, `POST /v1/credit-requests`, `POST /v1/credit-requests/:id/disburse`)
-- con su id de operación y un campo `offline`; el servidor decide con el estado VIGENTE.
--
-- Reglas que esta migración NO cambia (siguen en 0010/0018 y en la API):
--   · el Cobrador no tiene venta directa: lo que registra sin conexión es una SOLICITUD que
--     otra persona aprueba en línea; sin conexión solo entrega el dinero de lo ya aprobado;
--   · `adex.credit_disburse` sigue siendo la única vía de creación de créditos: relee la
--     solicitud aprobada, la custodia del Cobrador (sin contar faltante arrastrado), la ruta
--     operativa y el periodo, en UNA transacción con el asiento. Sin fondos: 409 y nada escrito.
--
-- Lo que añade (no modifica ni borra datos existentes):
--   A. `adex.offline_captures.kind` admite además 'client', 'credit_request' y 'disbursement'
--      (se amplía la restricción; ninguna fila existente deja de cumplirla).
--   B. El guardián de esas capturas comprueba que la entidad la registró ESTA membresía en
--      esta misma transacción de API (cliente creado ahora, solicitud pedida por ella,
--      crédito desembolsado por ella).

-- ---------- A. Nuevos tipos de captura ----------
alter table adex.offline_captures drop constraint offline_captures_kind_check;
alter table adex.offline_captures add constraint offline_captures_kind_check
  check (kind in ('payment', 'visit', 'expense', 'client', 'credit_request', 'disbursement'));

comment on table adex.offline_captures is
  'Operaciones del Cobrador capturadas sin conexión (abonos, visitas, gastos, clientes, solicitudes y desembolsos): hora del dispositivo y saldo mostrado (evidencia, dato no confiable). Rondas 62 y 65.';

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
    -- Ronda 65. Cliente: sin columna de autor; se exige que se haya creado en ESTA transacción.
    if new.kind = 'client' and not exists (select 1 from adex.clients c
         where c.company_id = new.company_id and c.id = new.entity_id and c.route_id = new.route_id and c.created_at = now()) then
      raise exception 'adex: offline capture must belong to a client created in the same operation' using errcode = 'AX411';
    end if;
    if new.kind = 'credit_request' and not exists (select 1 from adex.sale_requests r
         where r.company_id = new.company_id and r.id = new.entity_id and r.route_id = new.route_id
           and r.requested_by_membership_id = new.membership_id) then
      raise exception 'adex: offline capture must belong to a credit request made by the same membership' using errcode = 'AX411';
    end if;
    if new.kind = 'disbursement' and not exists (select 1 from adex.sales s
         where s.company_id = new.company_id and s.id = new.entity_id and s.route_id = new.route_id
           and s.disbursed_by_membership_id = new.membership_id) then
      raise exception 'adex: offline capture must belong to a credit disbursed by the same membership' using errcode = 'AX411';
    end if;
    -- La hora de recepción la pone el servidor, no el cliente.
    new.received_at := now();
    return new;
  end $$;
