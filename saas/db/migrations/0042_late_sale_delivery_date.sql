-- 0042 · Venta registrada tarde y corrección de la fecha de entrega (decisión del propietario 2026-11-04).
--
-- «¿Qué pasa si a un cobrador se le olvida registrar una venta y pasa un día?». Decidido:
--   · los DOS casos: (1) el Administrador registra una venta que no se registró el día que se entregó el dinero;
--     (2) el Administrador corrige la fecha de una venta registrada tarde;
--   · como máximo 3 días hacia atrás;
--   · los días cerrados NO se reabren.
--
-- Reglas comunes:
--   · solo el rol Administrador; motivo obligatorio (10–300); historial inmutable en `adex.sale_delivery_dates`;
--   · `sales.delivered_on` = fecha REAL de entrega (informativa siempre);
--   · `sales.disbursement_date` = fecha de NEGOCIO de la venta (reportes, Informe del día, fichas).
--
-- Caso 1 · `adex.credit_disburse_late` (venta directa con fecha de entrega pasada):
--   · solo el responsable de capital de la ruta (como la venta directa del Administrador);
--   · fecha real entre hoy−3 y hoy−1. Si la semana de esa fecha sigue ABIERTA, el asiento y la venta quedan con esa
--     fecha (cuenta en su día en la liquidación). Si está CERRADA, quedan con la fecha de hoy y la real se guarda aparte;
--   · quién entregó: un trabajador con efectivo en la ruta (sale de SU custodia y figura como quien desembolsó) o el
--     propio Administrador (sale de la Base de la ruta);
--   · el cuadre del trabajador es por orden de registro, no por fecha: la venta entra en su ciclo abierto. Rige la
--     regla de 0014 (un faltante arrastrado es deuda, no billetes): la venta sale del efectivo LIBRE de la custodia
--     (saldo − arrastre). Si el trabajador ya cuadró con faltante por este dinero y tiene otro efectivo, la venta se
--     registra y su cuadre siguiente sale exacto (el arrastre se renueva solo); sin efectivo libre, se rechaza;
--   · inicio del cobro desde la fecha real de entrega; el periodo de la fecha de inicio debe estar abierto (D7).
--
-- Caso 2 · `adex.credit_correct_delivery_date` (venta ya registrada, entregada antes):
--   · nueva fecha entre la fecha registrada −3 y la registrada −1; una sola corrección por venta;
--   · el libro contable es INMUTABLE: el asiento conserva su fecha. Si las semanas de la fecha registrada y de la
--     nueva siguen abiertas, la venta pasa a la fecha real (reportes, Informe del día, fichas); si alguna está
--     cerrada, solo se guarda la fecha real (informativa). Las cuotas no cambian (para eso, «Rectificar»).

-- ---------- A. Fecha real de entrega ----------
alter table adex.sales add column delivered_on date;

-- ---------- B. Historial (inmutable) ----------
create table adex.sale_delivery_dates (
  id                        adex.eid primary key,
  company_id                adex.eid not null references adex.companies(id),
  sale_id                   adex.eid not null,
  route_id                  adex.eid not null,
  operation_id              uuid not null,                  -- idempotencia del comando
  kind                      text not null check (kind in ('LATE_REGISTRATION', 'DATE_CORRECTION')),
  delivered_on              date not null,                  -- fecha real de entrega
  registered_on             date not null,                  -- fecha de negocio en que se registra este hecho
  before_disbursement_date  date,                           -- NULL en el caso 1 (la venta no existía)
  after_disbursement_date   date not null,
  applied_to_books          boolean not null,               -- la venta quedó con la fecha real (semanas abiertas)
  delivered_by_membership_id adex.eid,                      -- caso 1: trabajador que entregó (NULL: el Administrador, desde la Base)
  reason                    text not null check (length(btrim(reason)) >= 10 and length(reason) <= 300),
  actor_membership_id       adex.eid not null,
  actor_identity_id         uuid not null,
  actor_role                text not null check (actor_role = 'admin'),
  txid                      bigint not null,
  created_at                timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, operation_id),
  check (delivered_on < registered_on),
  check (applied_to_books = (after_disbursement_date = delivered_on)),
  foreign key (company_id, sale_id) references adex.sales(company_id, id),
  foreign key (company_id, actor_membership_id) references adex.memberships(company_id, id)
);
create unique index sale_delivery_dates_one_correction on adex.sale_delivery_dates (company_id, sale_id);
alter table adex.sale_delivery_dates enable row level security;
alter table adex.sale_delivery_dates force row level security;
create trigger sale_delivery_dates_immutable before update or delete on adex.sale_delivery_dates
  for each row execute function adex.reject_mutation();
create trigger sale_delivery_dates_no_truncate before truncate on adex.sale_delivery_dates
  for each statement execute function adex.reject_mutation();
create policy sale_delivery_dates_ctx on adex.sale_delivery_dates for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active())
         and (select adex.ctx_is(array['superadmin', 'admin']))
         and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())));
create policy owner_sale_delivery_dates on adex.sale_delivery_dates for insert to adex_owner with check (true);
-- Las funciones (security definer, dueño adex_owner) comprueban si la venta ya tiene fecha registrada.
create policy owner_sale_delivery_dates_read on adex.sale_delivery_dates for select to adex_owner using (true);
grant select on adex.sale_delivery_dates to adex_api;
revoke all on adex.sale_delivery_dates from public;

-- ---------- C. Caso 1: venta registrada tarde ----------
create function adex.credit_disburse_late(
  p_operation_id   uuid,
  p_route          text,
  p_client         text,
  p_amount         bigint,
  p_rate           numeric,
  p_count          integer,
  p_frequency      text,
  p_start          date,
  p_payment_days   smallint[],
  p_schedule       jsonb,
  p_delivered_on   date,
  p_delivered_by   text,       -- NULL: el Administrador entregó desde la Base de la ruta
  p_reason         text
) returns table (credit_id text, disbursement_id text, business_date date, applied_to_books boolean)
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.ctx_company();
    v_actor    text := adex.ctx_membership();
    v_role     text := adex.ctx_role();
    v_identity uuid := adex.ctx_identity();
    v_today    date;
    v_date     date;
    v_applied  boolean;
    v_currency char(3);
    v_ctrl     text;
    v_total    bigint;
    v_value    bigint;
    v_payer    text;
    v_portf    text;
    v_bal      bigint;
    v_carried  bigint;
    v_worker   adex.memberships;
    v_sale     text := gen_random_uuid()::text;
    v_op       text := gen_random_uuid()::text;
    v_end      date;
    v_n        int;
    v_sum      numeric;
    v_reason   text := btrim(coalesce(p_reason, ''));
    i          record;
    v_cname    text;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'credits are disbursed only through the company API'); end if;
    if v_role is null or v_company is null or v_identity is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    if v_role <> 'admin' then perform adex.capital_raise('AX402', 'only an administrator registers a late sale'); end if;
    if not adex.ctx_can('sale.createDirect') then perform adex.capital_raise('AX402', 'no direct sale authority'); end if;
    if p_operation_id is null or p_route is null or p_delivered_on is null then
      perform adex.capital_raise('AX411', 'operation id, route and delivery date are required');
    end if;
    if length(v_reason) < 10 or length(v_reason) > 300 then perform adex.capital_raise('AX411', 'a reason of 10 to 300 characters is required'); end if;
    if exists (select 1 from adex.capital_operations where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    select c.currency_code, adex.business_today(c.id) into v_currency, v_today from adex.companies c where c.id = v_company;
    if p_delivered_on >= v_today or p_delivered_on < v_today - 3 then
      perform adex.capital_raise('AX530', 'the delivery date must be between 3 days ago and yesterday');
    end if;

    -- Ruta: bloqueo y responsable releído. Solo el responsable de capital registra la venta tarde.
    perform 1 from adex.routes where company_id = v_company and id = p_route for update;
    select capital_controller_membership_id into v_ctrl from adex.routes where company_id = v_company and id = p_route;
    if not found or not adex.ctx_route_allowed(p_route) then perform adex.capital_raise('AX412', 'route not found'); end if;
    if v_ctrl is not null and not adex.route_controller_valid_internal(v_company, p_route) then v_ctrl := null; end if;
    if not adex.route_operational(v_company, p_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
    if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the route capital controller registers a late sale'); end if;

    if p_rate not in (10, 20) then perform adex.capital_raise('AX502', 'interest rate must be 10 or 20'); end if;
    if p_amount is null or p_amount <= 0 or p_count is null or p_count < 1 or p_frequency is null or p_start is null
       or coalesce(cardinality(p_payment_days), 0) = 0 then
      perform adex.capital_raise('AX503', 'invalid credit conditions');
    end if;
    if p_start < p_delivered_on then perform adex.capital_raise('AX503', 'start date before the delivery date'); end if;
    if not exists (select 1 from adex.clients c where c.company_id = v_company and c.id = p_client and c.route_id = p_route and c.status = 'activo') then
      perform adex.capital_raise('AX504', 'the client is not active in this route');
    end if;

    -- Días cerrados no se reabren: la fecha real solo cuenta si su semana sigue abierta; si no, hoy.
    if adex.capital_period_closed(v_company, p_route, v_today) or adex.capital_period_closed(v_company, p_route, p_start) then
      perform adex.capital_raise('AX407', 'the period of the route is closed');
    end if;
    v_applied := not adex.capital_period_closed(v_company, p_route, p_delivered_on);
    v_date := case when v_applied then p_delivered_on else v_today end;

    -- Quién entregó: un trabajador con efectivo en la ruta (su custodia) o el Administrador (Base de la ruta).
    if p_delivered_by is not null and p_delivered_by is distinct from v_actor then
      select * into v_worker from adex.memberships where company_id = v_company and id = p_delivered_by;
      if not found or v_worker.role not in ('cobrador', 'supervisor') then
        perform adex.capital_raise('AX708', 'the person who delivered must be a collector or supervisor');
      end if;
      if not adex.capital_custodian_ok(v_company, p_route, p_delivered_by) then perform adex.capital_raise('AX403', 'that worker cannot hold cash in this route'); end if;
      v_payer := adex.capital_account_for(v_company, 'custody', p_delivered_by, p_route);
    else
      p_delivered_by := null;
      v_payer := adex.route_cash_account(v_company, p_route, v_ctrl);
    end if;

    -- Calendario: mismas invariantes que la venta directa.
    v_total := adex.credit_total(p_amount, p_rate);
    v_value := adex.credit_installment(v_total, p_count);
    select count(*), coalesce(sum((e->>'amountMinor')::numeric), 0), max((e->>'dueDate')::date) into v_n, v_sum, v_end
      from jsonb_array_elements(coalesce(p_schedule, '[]'::jsonb)) e;
    if v_n <> p_count or v_sum <> v_total
       or exists (select 1 from jsonb_array_elements(p_schedule) with ordinality x(e, k)
                   where (e->>'number')::int <> k or (e->>'dueDate')::date < p_start
                      or (k < p_count and (e->>'amountMinor')::bigint <> v_value)
                      or (e->>'amountMinor')::bigint < 0
                      or (k > 1 and (e->>'dueDate')::date < (p_schedule -> (k::int - 2) ->> 'dueDate')::date)) then
      perform adex.capital_raise('AX503', 'installment schedule does not match the conditions');
    end if;

    v_portf := adex.capital_account_for(v_company, 'portfolio', null, p_route);
    perform 1 from adex.capital_accounts where company_id = v_company and id in (v_payer, v_portf)
      order by array_position(array['company', 'admin', 'route_base', 'custody', 'portfolio', 'partner', 'external'], kind), id for update;
    select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = v_company and id = v_payer;
    -- D25 / 0014: un faltante arrastrado es deuda, no billetes (la guardia de la custodia lo exige igual).
    if v_bal - v_carried < p_amount then
      perform adex.capital_raise('AX401', 'insufficient funds');
    end if;

    insert into adex.sales (id, company_id, route_id, client_id, created_by_membership_id, sale_value_minor, interest_rate, interest_value_minor,
                            total_value_minor, balance_minor, installments_count, installment_value_minor, payment_frequency, payment_days,
                            start_date, estimated_end_date, status, disbursement_status, disbursed_by_collector_id, disbursed_by_membership_id,
                            disbursement_date, delivered_on, disbursed_at, sale_request_id, ledger_operation_id, created_at, updated_at)
    values (v_sale, v_company, p_route, p_client, v_actor, p_amount, p_rate, v_total - p_amount, v_total, v_total, p_count, v_value, p_frequency,
            p_payment_days, p_start, v_end, 'activa', 'desembolsado', p_delivered_by, coalesce(p_delivered_by, v_actor),
            v_date, p_delivered_on, now(), null, v_op, now(), now());
    for i in select (e->>'number')::int n, (e->>'dueDate')::date d, (e->>'amountMinor')::bigint a from jsonb_array_elements(p_schedule) e loop
      insert into adex.installments (id, company_id, sale_id, number, due_date, amount_minor, paid_minor, balance_minor, status, days_overdue)
      values (gen_random_uuid()::text, v_company, v_sale, i.n, i.d, i.a, 0, i.a, 'pendiente', 0);
    end loop;
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, sale_request_id, sale_id, reason, entry_date, actor_membership_id,
                                         actor_identity_id, actor_role, txid)
    values (v_op, v_company, p_operation_id, 'LOAN_DISBURSEMENT', p_amount, v_currency, p_route,
            case when p_delivered_by is null then v_ctrl end, p_delivered_by, null, v_sale,
            'Venta registrada tarde (entregada el ' || to_char(p_delivered_on, 'DD/MM/YYYY') || '): ' || v_reason, v_date,
            v_actor, v_identity, v_role, txid_current());
    update adex.capital_accounts set balance_minor = balance_minor - p_amount, version = version + 1, updated_at = now()
     where company_id = v_company and id = v_payer returning balance_minor into v_bal;
    insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor) values (v_company, v_op, 1, v_payer, -p_amount, v_bal);
    update adex.capital_accounts set balance_minor = balance_minor + p_amount, version = version + 1, updated_at = now()
     where company_id = v_company and id = v_portf returning balance_minor into v_bal;
    insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor) values (v_company, v_op, 2, v_portf, p_amount, v_bal);

    insert into adex.sale_delivery_dates (id, company_id, sale_id, route_id, operation_id, kind, delivered_on, registered_on, before_disbursement_date,
                                          after_disbursement_date, applied_to_books, delivered_by_membership_id, reason, actor_membership_id,
                                          actor_identity_id, actor_role, txid)
    values (gen_random_uuid()::text, v_company, v_sale, p_route, p_operation_id, 'LATE_REGISTRATION', p_delivered_on, v_today, null,
            v_date, v_applied, p_delivered_by, v_reason, v_actor, v_identity, v_role, txid_current());
    return query select v_sale, v_op, v_date, v_applied;
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('capital_operations_operation_key', 'sale_delivery_dates_company_id_operation_id_key') then
        perform adex.capital_raise('AX409', 'operation id already used');
      end if;
      raise;
  end $$;
revoke all on function adex.credit_disburse_late(uuid, text, text, bigint, numeric, integer, text, date, smallint[], jsonb, date, text, text) from public;
grant execute on function adex.credit_disburse_late(uuid, text, text, bigint, numeric, integer, text, date, smallint[], jsonb, date, text, text) to adex_api;

-- ---------- D. Caso 2: corrección de la fecha de entrega ----------
create function adex.credit_correct_delivery_date(
  p_operation_id uuid,
  p_sale         text,
  p_delivered_on date,
  p_reason       text
) returns table (business_date date, applied_to_books boolean)
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.ctx_company();
    v_actor    text := adex.ctx_membership();
    v_role     text := adex.ctx_role();
    v_identity uuid := adex.ctx_identity();
    v_today    date;
    s          adex.sales;
    v_entry    date;
    v_applied  boolean;
    v_date     date;
    v_reason   text := btrim(coalesce(p_reason, ''));
    v_cname    text;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'credits are corrected only through the company API'); end if;
    if v_role is null or v_company is null or v_identity is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    if v_role <> 'admin' then perform adex.capital_raise('AX402', 'only an administrator corrects the delivery date'); end if;
    if p_operation_id is null or p_sale is null or p_delivered_on is null then perform adex.capital_raise('AX411', 'operation id, sale and date are required'); end if;
    if length(v_reason) < 10 or length(v_reason) > 300 then perform adex.capital_raise('AX411', 'a reason of 10 to 300 characters is required'); end if;
    if exists (select 1 from adex.sale_delivery_dates where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    v_today := adex.business_today(v_company);

    select * into s from adex.sales where company_id = v_company and id = p_sale;
    if not found or not adex.ctx_route_allowed(s.route_id) then perform adex.capital_raise('AX412', 'sale not found'); end if;
    perform 1 from adex.routes where company_id = v_company and id = s.route_id for share;
    select * into s from adex.sales where company_id = v_company and id = p_sale for update;
    if s.disbursement_status is distinct from 'desembolsado' or s.disbursement_date is null then
      perform adex.capital_raise('AX702', 'the credit is not disbursed');
    end if;
    if s.delivered_on is not null or exists (select 1 from adex.sale_delivery_dates where company_id = v_company and sale_id = s.id) then
      perform adex.capital_raise('AX531', 'the delivery date of this sale was already set');
    end if;
    if p_delivered_on >= s.disbursement_date or p_delivered_on < s.disbursement_date - 3 then
      perform adex.capital_raise('AX530', 'the delivery date must be between 3 days before the registered date and the day before');
    end if;

    -- El libro es inmutable: el asiento conserva su fecha. La venta pasa a la fecha real solo con las semanas abiertas.
    select entry_date into v_entry from adex.capital_operations where company_id = v_company and id = s.ledger_operation_id;
    v_applied := not adex.capital_period_closed(v_company, s.route_id, p_delivered_on)
                 and not adex.capital_period_closed(v_company, s.route_id, s.disbursement_date)
                 and not adex.capital_period_closed(v_company, s.route_id, coalesce(v_entry, s.disbursement_date));
    v_date := case when v_applied then p_delivered_on else s.disbursement_date end;

    update adex.sales set delivered_on = p_delivered_on, disbursement_date = v_date, updated_at = now()
     where company_id = v_company and id = s.id;
    insert into adex.sale_delivery_dates (id, company_id, sale_id, route_id, operation_id, kind, delivered_on, registered_on, before_disbursement_date,
                                          after_disbursement_date, applied_to_books, delivered_by_membership_id, reason, actor_membership_id,
                                          actor_identity_id, actor_role, txid)
    values (gen_random_uuid()::text, v_company, s.id, s.route_id, p_operation_id, 'DATE_CORRECTION', p_delivered_on, v_today, s.disbursement_date,
            v_date, v_applied, null, v_reason, v_actor, v_identity, v_role, txid_current());
    return query select v_date, v_applied;
  exception
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'sale_delivery_dates_company_id_operation_id_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname = 'sale_delivery_dates_one_correction' then perform adex.capital_raise('AX531', 'the delivery date of this sale was already set'); end if;
      raise;
  end $$;
revoke all on function adex.credit_correct_delivery_date(uuid, text, date, text) from public;
grant execute on function adex.credit_correct_delivery_date(uuid, text, date, text) to adex_api;
