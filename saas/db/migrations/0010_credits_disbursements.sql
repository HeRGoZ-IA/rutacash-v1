-- ============================================================
-- ADEX SaaS · Fase 4 · 0010 · Solicitudes de crédito, autorización y desembolso
-- ------------------------------------------------------------
-- Autorizada por el propietario (Fase 4, 2026-10-16). Primera versión de ADEX Online:
-- SOLO EN LÍNEA (sin cola financiera offline). Reglas de CLEAN conservadas
-- (`saleRequestService`, `interestRatePolicy`, `activeCredit`):
--   · el Cobrador solo SOLICITA y solo al 20 %; el 10 % lo fija un autorizador con
--     `authorization.modifyConditions`; no hay otras tasas;
--   · nadie resuelve su propia solicitud, tampoco con otra membresía de la misma
--     persona (DS-05: se compara la identidad);
--   · una sola solicitud pendiente por cliente; el crédito activo del cliente se
--     evalúa en TODA la empresa;
--   · venta directa: solo quien tiene `sale.createDirect` (SuperAdmin, Administrador,
--     Supervisor). La libertad de Cobradores para vender sin aprobación NO se habilita.
--
-- Separación de estados (decisión del propietario, Fase 4):
--   solicitud pending → approved (condiciones finales; NO crea deuda) → disbursed
--   (el dinero salió: crédito + cuotas + asiento, en UNA transacción) · rejected ·
--   cancelled (aprobada que no se entregará). En CLEAN, «aprobada» ya creaba la venta
--   en `pendiente`; aquí la obligación del cliente nace SOLO al desembolsar. Para la
--   regla del segundo crédito, una solicitud aprobada cuenta como crédito activo
--   (equivale a la venta pendiente de CLEAN).
--
-- Contabilidad (motor de la Fase 3): el desembolso sale de la custodia de quien
-- entrega el efectivo (Cobrador o Supervisor, D25: sin el faltante arrastrado) o, en
-- el desembolso administrativo, de la bolsa del responsable de la ruta (D30/C1). Entra
-- en la CARTERA de la ruta (`portfolio`) por el capital prestado. El interés NO se
-- contabiliza como dinero: no existe hasta cobrarse (sin capital ficticio). Σ = 0.
-- ============================================================

-- ---------- Libro: cartera por ruta y tipo de operación de desembolso ----------
alter table adex.capital_accounts drop constraint capital_accounts_kind_check;
alter table adex.capital_accounts add constraint capital_accounts_kind_check
  check (kind in ('company', 'admin', 'custody', 'external', 'partner', 'portfolio'));
alter table adex.capital_accounts drop constraint capital_accounts_check;
alter table adex.capital_accounts add constraint capital_accounts_shape_check
  check (case kind
           when 'company'   then membership_id is null and route_id is null
           when 'external'  then membership_id is null and route_id is null
           when 'admin'     then membership_id is not null and route_id is null
           when 'partner'   then membership_id is not null and route_id is null
           when 'custody'   then membership_id is not null and route_id is not null
           -- Capital prestado pendiente de cobro de la ruta (deuda de clientes, no efectivo).
           when 'portfolio' then membership_id is null and route_id is not null
         end);

alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
  'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT'));
-- El Cobrador desembolsa desde su custodia (`sale.confirmDisbursement`); ninguna otra
-- operación de capital la registra un Cobrador.
alter table adex.capital_operations drop constraint capital_operations_actor_role_check;
alter table adex.capital_operations add constraint capital_operations_actor_role_check
  check (actor_role in ('superadmin', 'admin', 'supervisor') or (actor_role = 'cobrador' and kind = 'LOAN_DISBURSEMENT'));
alter table adex.capital_operations add column sale_id adex.eid;
alter table adex.capital_operations add constraint capital_operations_sale_fk
  foreign key (company_id, sale_id) references adex.sales(company_id, id) deferrable initially deferred;
-- Un crédito se desembolsa UNA vez: un solo asiento por crédito.
create unique index capital_operations_one_disbursement on adex.capital_operations (company_id, sale_id) where kind = 'LOAN_DISBURSEMENT';
alter table adex.capital_operations add constraint capital_operations_disbursement_shape
  check ((kind = 'LOAN_DISBURSEMENT') = (sale_id is not null));

-- ---------- Créditos: enlace con su asiento ----------
alter table adex.sales add column ledger_operation_id adex.eid;
alter table adex.sales add constraint sales_ledger_operation_fk
  foreign key (company_id, ledger_operation_id) references adex.capital_operations(company_id, id) deferrable initially deferred;
create unique index sales_ledger_operation_key on adex.sales (company_id, ledger_operation_id) where ledger_operation_id is not null;

-- Un crédito creado por la API nace DESEMBOLSADO y con su asiento (nunca una deuda sin
-- dinero entregado). Los créditos sembrados o importados no pasan por aquí.
create function adex.sales_server_guard() returns trigger
  language plpgsql
  as $$ begin
    if session_user = 'adex_api' and (new.disbursement_status is distinct from 'desembolsado' or new.ledger_operation_id is null) then
      raise exception 'adex: a credit is created only by its disbursement' using errcode = '42501';
    end if;
    return new;
  end $$;
create trigger sales_server_guard before insert on adex.sales for each row execute function adex.sales_server_guard();

-- ---------- Solicitudes: cancelación de una aprobada ----------
alter table adex.sale_requests
  add column cancelled_at timestamptz,
  add column cancelled_by_membership_id adex.eid,
  add column cancel_reason text,
  add foreign key (company_id, cancelled_by_membership_id) references adex.memberships(company_id, id);
-- Una cancelación registrada lleva quién, cuándo y motivo (las importadas sin estos datos se conservan).
alter table adex.sale_requests add constraint sale_requests_cancel_shape
  check (cancelled_at is null or (status = 'cancelled' and cancelled_by_membership_id is not null
                                  and length(btrim(coalesce(cancel_reason, ''))) >= 3));

-- Totales derivados (`calculateTotalWithInterest` / `calculateInstallmentValue` de CLEAN,
-- sobre unidades menores: `Math.round` = `round` de PostgreSQL para positivos).
create function adex.credit_total(p_amount bigint, p_rate numeric) returns bigint
  language sql immutable as $$ select p_amount + round(p_amount * p_rate / 100)::bigint $$;
create function adex.credit_installment(p_total bigint, p_count integer) returns bigint
  language sql immutable as $$ select round(p_total::numeric / p_count)::bigint $$;

-- Roles con cada capacidad de CLEAN que la base vuelve a comprobar (segunda barrera).
-- Fuente: `ROLE_CAPABILITIES` + `INCOMPATIBLE_BY_ROLE` (lo verifica CRED-SQL-001).
create function adex.ctx_can(p_capability text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select coalesce(adex.ctx_role() = any(case p_capability
      when 'sale.createRequest'               then array['superadmin', 'admin', 'supervisor', 'cobrador']
      when 'sale.createDirect'                then array['superadmin', 'admin', 'supervisor']
      when 'sale.confirmDisbursement'         then array['superadmin', 'admin', 'supervisor', 'cobrador']
      when 'sale.cancel'                      then array['superadmin', 'admin']
      when 'authorization.access'             then array['superadmin', 'admin', 'supervisor', 'secretario']
      when 'authorization.approve'            then array['superadmin', 'admin', 'supervisor', 'secretario']
      when 'authorization.reject'             then array['superadmin', 'admin', 'supervisor', 'secretario']
      when 'authorization.modifyConditions'   then array['superadmin', 'admin', 'supervisor', 'secretario']
      when 'authorization.phoneConfirm'       then array['superadmin', 'supervisor', 'secretario']
      else array[]::text[] end), false)
  $$;

-- ¿Las dos membresías son la MISMA persona? (DS-05)
create function adex.same_person(p_company text, p_a text, p_b text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select adex.api_scope_ok(p_company) and (p_a = p_b or exists (select 1 from adex.memberships a join adex.memberships b on b.company_id = a.company_id and b.identity_id = a.identity_id
                                 where a.company_id = p_company and a.id = p_a and b.id = p_b and a.identity_id is not null))
  $$;

-- Créditos activos del cliente en TODA la empresa (regla de CLEAN): ventas 'activa' y
-- solicitudes aprobadas aún sin desembolsar. Solo para el contexto de la propia empresa.
create function adex.client_active_credits(p_company text, p_client text) returns table (kind text, id text)
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select 'sale', s.id::text from adex.sales s
     where adex.api_scope_ok(p_company) and s.company_id = p_company and s.client_id = p_client and s.status = 'activa'
    union all
    select 'approved_request', r.id::text from adex.sale_requests r
     where adex.api_scope_ok(p_company) and r.company_id = p_company and r.client_id = p_client and r.status = 'approved'
    order by 1, 2
  $$;

-- ---------- Guardia de solicitudes (segunda barrera para la API) ----------
create function adex.sale_requests_guard() returns trigger
  language plpgsql
  as $$
  declare
    v_role text := adex.ctx_role();
    frozen text[] := array['id', 'company_id', 'client_id', 'route_id', 'collector_membership_id', 'amount_minor', 'installments_count',
                           'start_date', 'requested_at', 'requested_by_membership_id', 'requested_interest_rate', 'requested_frequency',
                           'requested_payment_days', 'active_credit_sale_ids', 'active_credit_snapshot_units', 'authorization_reason'];
  begin
    -- La función de desembolso (propietario) es la única que pasa a 'disbursed'.
    if current_user <> 'adex_api' then
      if tg_op = 'UPDATE' and new.status = 'disbursed' and old.status <> 'approved' then
        raise exception 'adex: only an approved request is disbursed' using errcode = 'AX501';
      end if;
      return new;
    end if;
    if new.interest_rate not in (10, 20) then raise exception 'adex: interest rate must be 10 or 20' using errcode = 'AX502'; end if;
    if new.total_amount_minor <> adex.credit_total(new.amount_minor, new.interest_rate)
       or new.installment_value_minor <> adex.credit_installment(new.total_amount_minor, new.installments_count) then
      raise exception 'adex: request totals do not match its conditions' using errcode = 'AX503';
    end if;
    if coalesce(cardinality(new.payment_days), 0) = 0 then raise exception 'adex: payment days are required' using errcode = 'AX503'; end if;
    if tg_op = 'INSERT' then
      if new.status <> 'pending' or new.requested_by_membership_id is distinct from adex.ctx_membership()
         or new.collector_membership_id is distinct from adex.ctx_membership()
         or new.reviewed_at is not null or new.reviewed_by_membership_id is not null or new.sale_id is not null
         or (new.requested_interest_rate, new.requested_frequency, new.requested_payment_days)
            is distinct from (new.interest_rate, new.frequency, new.payment_days) then
        raise exception 'adex: a new request is pending and made by its requester' using errcode = '42501';
      end if;
      -- El Cobrador solo origina al 20 % (`originationRatesFor`).
      if v_role = 'cobrador' and new.interest_rate <> 20 then raise exception 'adex: the Cobrador originates only at 20%%' using errcode = 'AX502'; end if;
      if new.start_date < (select (now() at time zone timezone)::date from adex.companies where id = new.company_id) then
        raise exception 'adex: start date before today' using errcode = 'AX503';
      end if;
      if not exists (select 1 from adex.clients c where c.company_id = new.company_id and c.id = new.client_id and c.route_id = new.route_id and c.status = 'activo') then
        raise exception 'adex: the client is not active in this route' using errcode = 'AX504';
      end if;
      return new;
    end if;
    -- UPDATE por la API: resolver o cancelar.
    if exists (select 1 from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o using (key)
                where n.key = any(frozen) and n.value is distinct from o.value) then
      raise exception 'adex: request facts are immutable' using errcode = '42501';
    end if;
    if old.status = 'pending' and new.status in ('approved', 'rejected') then
      if new.reviewed_by_membership_id is distinct from adex.ctx_membership() or new.reviewed_at is null then
        raise exception 'adex: the reviewer is the active membership' using errcode = '42501';
      end if;
      if adex.same_person(new.company_id, new.reviewed_by_membership_id, coalesce(old.requested_by_membership_id, old.collector_membership_id)) then
        raise exception 'adex: nobody resolves their own request' using errcode = 'AX505';
      end if;
      if new.status = 'approved' then
        if not adex.ctx_can('authorization.approve') then raise exception 'adex: no approval authority' using errcode = '42501'; end if;
        if (new.interest_rate, new.frequency, new.payment_days) is distinct from (old.interest_rate, old.frequency, old.payment_days)
           and not adex.ctx_can('authorization.modifyConditions') then
          raise exception 'adex: changing conditions needs its authority' using errcode = '42501';
        end if;
        if coalesce(new.phone_confirmed, false) and not coalesce(old.phone_confirmed, false) and not adex.ctx_can('authorization.phoneConfirm') then
          raise exception 'adex: phone confirmation needs its authority' using errcode = '42501';
        end if;
        if (new.approved_interest_rate, new.approved_frequency, new.approved_payment_days) is distinct from (new.interest_rate, new.frequency, new.payment_days) then
          raise exception 'adex: approved conditions must be the final ones' using errcode = 'AX503';
        end if;
      else
        if not adex.ctx_can('authorization.reject') or length(btrim(coalesce(new.rejection_reason, ''))) = 0
           or (new.interest_rate, new.frequency, new.payment_days) is distinct from (old.interest_rate, old.frequency, old.payment_days) then
          raise exception 'adex: invalid rejection' using errcode = '42501';
        end if;
      end if;
      return new;
    end if;
    if old.status = 'approved' and new.status = 'cancelled' then
      if not adex.ctx_can('sale.cancel') or new.cancelled_by_membership_id is distinct from adex.ctx_membership() or new.cancelled_at is null
         or (to_jsonb(new) - array['status', 'cancelled_at', 'cancelled_by_membership_id', 'cancel_reason'])
            is distinct from (to_jsonb(old) - array['status', 'cancelled_at', 'cancelled_by_membership_id', 'cancel_reason']) then
        raise exception 'adex: invalid cancellation' using errcode = '42501';
      end if;
      return new;
    end if;
    raise exception 'adex: request cannot go from % to %', old.status, new.status using errcode = 'AX501';
  end $$;
create trigger sale_requests_guard before insert or update on adex.sale_requests
  for each row execute function adex.sale_requests_guard();

-- ---------- RLS de solicitudes, créditos y cuotas ----------
-- Lectura: quien autoriza en la ruta (`authorization.access`), quien gestiona la ruta
-- (`sale.viewActive`: Admin, SuperAdmin) y, siempre, quien pidió.
drop policy sale_requests_ctx on adex.sale_requests;
create policy sale_requests_ctx on adex.sale_requests for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id)
         and (adex.ctx_can('authorization.access') or requested_by_membership_id = adex.ctx_membership()));
create policy sale_requests_insert on adex.sale_requests for insert to adex_api
  with check (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id) and adex.ctx_can('sale.createRequest')
              and adex.route_operational(company_id, route_id));
create policy sale_requests_review on adex.sale_requests for update to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id)
         and (adex.ctx_can('authorization.approve') or adex.ctx_can('sale.cancel')))
  with check (company_id = adex.ctx_company());
create policy owner_credit_write on adex.sale_requests for update to adex_owner using (true) with check (true);
create policy owner_credit_write on adex.sales for insert to adex_owner with check (true);
create policy owner_credit_write on adex.installments for insert to adex_owner with check (true);

-- ---------- Cuentas y operaciones visibles (amplía 0009 con la cartera) ----------
drop policy capital_accounts_ctx on adex.capital_accounts;
create policy capital_accounts_ctx on adex.capital_accounts for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_membership_active() and (
           adex.ctx_role() = 'superadmin'
        or (kind in ('admin', 'partner', 'custody') and membership_id = adex.ctx_membership())
        or (kind in ('custody', 'portfolio') and adex.ctx_is(array['admin', 'supervisor', 'socio']) and adex.ctx_route_allowed(route_id))));
drop policy capital_operations_ctx on adex.capital_operations;
create policy capital_operations_ctx on adex.capital_operations for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_membership_active() and (
           adex.ctx_role() = 'superadmin'
        or admin_membership_id = adex.ctx_membership()
        or (coalesce(reverses_kind, kind) in ('WORKER_DELIVERY', 'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'LOAN_DISBURSEMENT')
            and (adex.ctx_membership() in (worker_membership_id, counterpart_membership_id)
                 or (adex.ctx_is(array['admin', 'supervisor', 'socio'])
                     and (adex.ctx_route_allowed(route_id) or adex.ctx_route_allowed(to_route_id)))))
        or (coalesce(reverses_kind, kind) = 'PARTNER_CONTRIBUTION' and counterpart_membership_id = adex.ctx_membership())));

-- ============================================================
-- Desembolso: `adex.credit_disburse` (única vía para crear un crédito)
-- ============================================================
-- Confirma una solicitud APROBADA (`p_request`) o registra una venta DIRECTA (sin
-- solicitud, `p_request` NULL, condiciones en los parámetros). El calendario de cuotas
-- lo calcula la API con el motor de CLEAN (`installmentEngine`); aquí se comprueban
-- sus invariantes (número, importes, suma, fechas). Orden de bloqueos (el de la
-- Fase 3 ampliado): ruta → solicitud → cuentas.
create function adex.credit_disburse(
  p_operation_id   uuid,
  p_request        text,
  p_route          text,
  p_client         text,
  p_amount         bigint,
  p_rate           numeric,
  p_count          integer,
  p_frequency      text,
  p_start          date,
  p_payment_days   smallint[],
  p_schedule       jsonb,      -- [{ "number": 1, "dueDate": "YYYY-MM-DD", "amountMinor": 0 }, …]
  p_reason         text
) returns table (credit_id text, disbursement_id text)
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.ctx_company();
    v_actor    text := adex.ctx_membership();
    v_role     text := adex.ctx_role();
    v_identity uuid := adex.ctx_identity();
    v_req      adex.sale_requests;
    v_today    date;
    v_currency char(3);
    v_ctrl     text;
    v_total    bigint;
    v_value    bigint;
    v_payer    text;
    v_portf    text;
    v_bal      bigint;
    v_carried  bigint;
    v_sale     text := gen_random_uuid()::text;
    v_op       text := gen_random_uuid()::text;
    v_creator  text;
    v_end      date;
    v_n        int;
    v_sum      numeric;
    i          record;
    v_cname    text;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'credits are disbursed only through the company API'); end if;
    if v_role is null or v_company is null or v_identity is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    if p_operation_id is null or p_route is null then perform adex.capital_raise('AX411', 'operation id and route are required'); end if;
    if exists (select 1 from adex.capital_operations where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    select c.currency_code, (now() at time zone c.timezone)::date into v_currency, v_today from adex.companies c where c.id = v_company;

    -- Ruta: bloqueo y responsable releído (R5). Solo rutas del alcance del actor.
    perform 1 from adex.routes where company_id = v_company and id = p_route for update;
    select capital_controller_membership_id into v_ctrl from adex.routes where company_id = v_company and id = p_route;
    if not found or not adex.ctx_route_allowed(p_route) then perform adex.capital_raise('AX412', 'route not found'); end if;
    if v_ctrl is not null and not adex.route_controller_valid_internal(v_company, p_route) then v_ctrl := null; end if;
    if not adex.route_operational(v_company, p_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;

    if p_request is not null then
      -- Confirmación de una solicitud aprobada: condiciones FINALES de la solicitud.
      if not adex.ctx_can('sale.confirmDisbursement') then perform adex.capital_raise('AX402', 'no disbursement authority'); end if;
      select * into v_req from adex.sale_requests where company_id = v_company and id = p_request for update;
      if not found or v_req.route_id <> p_route then perform adex.capital_raise('AX412', 'request not found in this route'); end if;
      if v_req.status <> 'approved' then perform adex.capital_raise('AX506', 'the request is not approved (' || v_req.status || ')'); end if;
      if (p_client, p_amount, p_rate, p_count, p_frequency, p_start, p_payment_days)
         is distinct from (v_req.client_id::text, v_req.amount_minor, v_req.interest_rate, v_req.installments_count, v_req.frequency, v_req.start_date, v_req.payment_days) then
        perform adex.capital_raise('AX503', 'disbursement conditions differ from the approved ones');
      end if;
      v_creator := coalesce(v_req.requested_by_membership_id, v_req.collector_membership_id);
    else
      -- Venta directa: `sale.createDirect` y, sin `route.edit`, el límite de la ruta.
      if not adex.ctx_can('sale.createDirect') then perform adex.capital_raise('AX402', 'no direct sale authority'); end if;
      if p_rate not in (10, 20) then perform adex.capital_raise('AX502', 'interest rate must be 10 or 20'); end if;
      if p_start < v_today then perform adex.capital_raise('AX503', 'start date before today'); end if;
      if v_role = 'supervisor' and exists (select 1 from adex.routes where company_id = v_company and id = p_route and max_loan_minor > 0 and p_amount > max_loan_minor) then
        perform adex.capital_raise('AX507', 'over the direct sale limit: send it as a request');
      end if;
      v_creator := v_actor;
    end if;
    if p_amount is null or p_amount <= 0 or p_count is null or p_count < 1 or p_frequency is null or p_start is null
       or coalesce(cardinality(p_payment_days), 0) = 0 then
      perform adex.capital_raise('AX503', 'invalid credit conditions');
    end if;
    if not exists (select 1 from adex.clients c where c.company_id = v_company and c.id = p_client and c.route_id = p_route and c.status = 'activo') then
      perform adex.capital_raise('AX504', 'the client is not active in this route');
    end if;
    -- D7: el préstamo cuenta en la semana de su fecha de inicio; el asiento, hoy.
    if adex.capital_period_closed(v_company, p_route, p_start) or adex.capital_period_closed(v_company, p_route, v_today) then
      perform adex.capital_raise('AX407', 'the period of the route is closed');
    end if;

    -- Quién paga: el efectivo de quien entrega (caja personal) o la bolsa del responsable.
    if v_role in ('cobrador', 'supervisor') then
      if not adex.capital_custodian_ok(v_company, p_route, v_actor) then perform adex.capital_raise('AX403', 'you cannot hold cash in this route'); end if;
      v_payer := adex.capital_account_for(v_company, 'custody', v_actor, p_route);
    else
      if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
      if v_actor is distinct from v_ctrl and v_role <> 'superadmin' then
        perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin disburses from the pool');
      end if;
      v_payer := adex.capital_account_for(v_company, 'admin', v_ctrl, null);
    end if;
    -- Calendario: invariantes del motor de CLEAN.
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
      order by array_position(array['company', 'admin', 'custody', 'portfolio', 'partner', 'external'], kind), id for update;
    select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = v_company and id = v_payer;
    -- D25: un faltante arrastrado es deuda, no billetes.
    if v_bal - v_carried < p_amount then perform adex.capital_raise('AX401', 'insufficient funds'); end if;

    -- Crédito + cuotas + solicitud + asiento: una sola transacción.
    insert into adex.sales (id, company_id, route_id, client_id, created_by_membership_id, sale_value_minor, interest_rate, interest_value_minor,
                            total_value_minor, balance_minor, installments_count, installment_value_minor, payment_frequency, payment_days,
                            start_date, estimated_end_date, status, disbursement_status, disbursed_by_collector_id, disbursed_by_membership_id,
                            disbursement_date, disbursed_at, sale_request_id, ledger_operation_id, created_at, updated_at)
    values (v_sale, v_company, p_route, p_client, v_creator, p_amount, p_rate, v_total - p_amount, v_total, v_total, p_count, v_value, p_frequency,
            p_payment_days, p_start, v_end, 'activa', 'desembolsado', case when v_role in ('cobrador', 'supervisor') then v_actor end, v_actor,
            v_today, now(), p_request, v_op, now(), now());
    for i in select (e->>'number')::int n, (e->>'dueDate')::date d, (e->>'amountMinor')::bigint a from jsonb_array_elements(p_schedule) e loop
      insert into adex.installments (id, company_id, sale_id, number, due_date, amount_minor, paid_minor, balance_minor, status, days_overdue)
      values (gen_random_uuid()::text, v_company, v_sale, i.n, i.d, i.a, 0, i.a, 'pendiente', 0);
    end loop;
    if p_request is not null then
      update adex.sale_requests set status = 'disbursed', sale_id = v_sale where company_id = v_company and id = p_request;
    end if;
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, sale_request_id, sale_id, reason, entry_date, actor_membership_id,
                                         actor_identity_id, actor_role, txid)
    values (v_op, v_company, p_operation_id, 'LOAN_DISBURSEMENT', p_amount, v_currency, p_route,
            case when v_role in ('cobrador', 'supervisor') then null else v_ctrl end,
            case when v_role in ('cobrador', 'supervisor') then v_actor end, p_request, v_sale,
            coalesce(nullif(btrim(p_reason), ''), 'Desembolso de crédito'), v_today, v_actor, v_identity, v_role, txid_current());
    update adex.capital_accounts set balance_minor = balance_minor - p_amount, version = version + 1, updated_at = now()
     where company_id = v_company and id = v_payer returning balance_minor into v_bal;
    insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor) values (v_company, v_op, 1, v_payer, -p_amount, v_bal);
    update adex.capital_accounts set balance_minor = balance_minor + p_amount, version = version + 1, updated_at = now()
     where company_id = v_company and id = v_portf returning balance_minor into v_bal;
    insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor) values (v_company, v_op, 2, v_portf, p_amount, v_bal);
    return query select v_sale, v_op;
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('capital_operations_one_disbursement', 'sales_company_id_sale_request_id_key') then perform adex.capital_raise('AX506', 'already disbursed'); end if;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;

-- ---------- Privilegios ----------
grant insert (id, company_id, client_id, route_id, collector_membership_id, amount_minor, interest_rate, total_amount_minor, installments_count,
              installment_value_minor, frequency, start_date, payment_days, status, requested_at, requested_by_membership_id,
              requested_interest_rate, requested_frequency, requested_payment_days, active_credit_sale_ids, active_credit_snapshot_units,
              authorization_reason)
  on adex.sale_requests to adex_api;
grant update (status, reviewed_at, reviewed_by_membership_id, rejection_reason, approval_notes, interest_rate, total_amount_minor,
              installment_value_minor, frequency, payment_days, approved_interest_rate, approved_frequency, approved_payment_days,
              phone_confirmed, phone_confirmation_note, cancelled_at, cancelled_by_membership_id, cancel_reason)
  on adex.sale_requests to adex_api;
grant execute on function adex.credit_disburse(uuid, text, text, text, bigint, numeric, integer, text, date, smallint[], jsonb, text),
  adex.client_active_credits(text, text), adex.ctx_can(text), adex.credit_total(bigint, numeric), adex.credit_installment(bigint, integer)
  to adex_api;
grant execute on function adex.same_person(text, text, text) to adex_api;
revoke all on function adex.sale_requests_guard(), adex.sales_server_guard() from public;
