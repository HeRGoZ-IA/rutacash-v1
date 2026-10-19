-- ============================================================
-- 0018 · Fecha contable de la empresa y reloj de INICIALIZACIÓN de la Empresa Demo
-- ============================================================
-- Toda fecha contable del servidor («hoy» en la zona de la empresa: fecha de los
-- asientos, de los cobros y gastos, del desembolso, de la solicitud, del periodo) sale de
-- una sola función: `adex.business_today(empresa)`. Para cualquier empresa es la fecha
-- real (igual que antes de esta migración).
--
-- Única excepción, para que la Empresa Demo tenga MESES de operación registrada con los
-- MISMOS comandos, validaciones, cierres y auditoría que una empresa real (sin escrituras
-- directas): mientras una Demo está en APROVISIONAMIENTO (`adex_demo.companies.state =
-- 'provisioning'`), su inicialización puede fijar, dentro de su propia transacción, el día
-- simulado (`adex.seed_today`). Solo hacia atrás (nunca futuro) y como mucho 400 días.
-- Una empresa real, o la Demo ya activa, ignoran ese valor. La hora de registro
-- (`created_at`, auditoría) sigue siendo la real: la historia dice cuándo se inicializó.

create function adex.business_today(p_company text) returns date
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_real date;
    v_seed text := nullif(current_setting('adex.seed_today', true), '');
    v_day  date;
  begin
    select (now() at time zone c.timezone)::date into v_real from adex.companies c where c.id = p_company;
    if v_seed is null or v_real is null then return v_real; end if;
    if not exists (select 1 from adex.companies c join adex_demo.companies d on d.company_id = c.id
                    where c.id = p_company and c.is_demo and d.state = 'provisioning') then
      return v_real;
    end if;
    v_day := v_seed::date;
    if v_day > v_real or v_day < v_real - 400 then raise exception 'adex: seed date out of range' using errcode = 'AX411'; end if;
    return v_day;
  end $$;
revoke all on function adex.business_today(text) from public;
grant execute on function adex.business_today(text) to adex_api;

create or replace function adex.capital_post(
  p_operation_id uuid,
  p_kind         text,
  p_amount       bigint,
  p_reason       text,
  p_route        text default null,
  p_worker       text default null,
  p_counterpart  text default null,
  p_to_route     text default null,
  p_admin        text default null,
  p_sale_request text default null,
  p_reverses     text default null
) returns adex.capital_operations
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company   text := adex.ctx_company();
    v_actor     text := adex.ctx_membership();
    v_role      text := adex.ctx_role();          -- NULL sin contexto válido (sesión, membresía, empresa)
    v_identity  uuid := adex.ctx_identity();
    v_reversal  boolean := p_kind = 'REVERSAL';
    v_currency  char(3);
    v_date      date;
    v_kind      text := p_kind;
    v_amount    bigint := p_amount;
    v_route     text := p_route;
    v_to_route  text := p_to_route;
    v_worker    text := p_worker;
    v_counter   text := p_counterpart;
    v_admin     text := p_admin;
    v_orig      adex.capital_operations;
    v_ctrl      text;
    v_ctrl2     text;
    v_accts     text[];
    v_amts      bigint[];
    v_bal       bigint;
    v_carried   bigint;
    v_op        adex.capital_operations;
    v_i         int;
    v_cname     text;
  begin
    -- ---------- Contexto y entrada ----------
    if session_user <> 'adex_api' then
      perform adex.capital_raise('42501', 'capital commands run only through the company API');
    end if;
    if v_role is null or v_company is null or v_identity is null or v_actor is null then
      perform adex.capital_raise('42501', 'no valid active context');
    end if;
    if v_role not in ('superadmin', 'admin', 'supervisor') then
      perform adex.capital_raise('AX402', 'role has no capital authority');
    end if;
    if p_operation_id is null or p_kind is null then perform adex.capital_raise('AX411', 'operation id and kind are required'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    select c.currency_code, adex.business_today(c.id) into v_currency, v_date from adex.companies c where c.id = v_company;
    if exists (select 1 from adex.capital_operations where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;

    -- ---------- Anulación: todo se deriva de la operación original ----------
    if v_reversal then
      if p_reverses is null then perform adex.capital_raise('AX411', 'reversal needs the original operation'); end if;
      perform pg_advisory_xact_lock(adex.lock_key('capital-reversal', v_company || ':' || p_reverses));
      select * into v_orig from adex.capital_operations where company_id = v_company and id = p_reverses;
      if not found then perform adex.capital_raise('AX412', 'operation not found'); end if;
      if v_orig.kind = 'REVERSAL' then perform adex.capital_raise('AX404', 'a reversal cannot be reversed'); end if;
      -- «Anular» un retiro de la empresa reintroduciría dinero: si vuelve, es un depósito nuevo.
      if v_orig.kind = 'COMPANY_WITHDRAWAL' then perform adex.capital_raise('AX404', 'a company withdrawal is corrected with a new deposit'); end if;
      if exists (select 1 from adex.capital_operations where company_id = v_company and reverses_operation_id = v_orig.id) then
        perform adex.capital_raise('AX405', 'operation already reversed');
      end if;
      v_kind := v_orig.kind; v_amount := v_orig.amount_minor; v_route := v_orig.route_id; v_to_route := v_orig.to_route_id;
      v_worker := v_orig.worker_membership_id; v_counter := v_orig.counterpart_membership_id; v_admin := v_orig.admin_membership_id;
    end if;

    -- ---------- Campos obligatorios por tipo ----------
    if v_amount is null or v_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
    if (v_kind in ('ADMIN_ALLOCATION', 'ADMIN_RETURN') and v_admin is null)
       or (v_kind in ('PARTNER_CONTRIBUTION', 'WORKER_DELIVERY', 'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and v_route is null)
       or (v_kind in ('WORKER_DELIVERY', 'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and v_worker is null)
       or (v_kind in ('PARTNER_CONTRIBUTION', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and v_counter is null)
       or (v_kind = 'ROUTE_REASSIGNMENT' and (v_to_route is null or v_to_route = v_route))
       or (v_kind not in ('ROUTE_REASSIGNMENT') and v_to_route is not null)
       or (v_kind in ('COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN') and v_route is not null)
       or (p_sale_request is not null and (v_reversal or v_kind <> 'WORKER_DELIVERY')) then
      perform adex.capital_raise('AX411', 'invalid fields for this operation kind');
    end if;

    -- ---------- Rutas: bloqueo y responsable releído bajo bloqueo (R5) ----------
    if v_route is not null then
      perform 1 from adex.routes where company_id = v_company and id in (v_route, v_to_route) order by id for update;
      select capital_controller_membership_id into v_ctrl from adex.routes where company_id = v_company and id = v_route;
      if not found then perform adex.capital_raise('AX412', 'route not found'); end if;
      if v_ctrl is not null and not adex.route_controller_valid_internal(v_company, v_route) then v_ctrl := null; end if;
      if v_to_route is not null then
        select capital_controller_membership_id into v_ctrl2 from adex.routes where company_id = v_company and id = v_to_route;
        if not found then perform adex.capital_raise('AX412', 'route not found'); end if;
        if v_ctrl2 is not null and not adex.route_controller_valid_internal(v_company, v_to_route) then v_ctrl2 := null; end if;
      end if;
      if v_ctrl is null or (v_to_route is not null and v_ctrl2 is null) then
        perform adex.capital_raise('AX408', 'route has no valid capital controller');
      end if;
      if adex.capital_period_closed(v_company, v_route, v_date)
         or (v_to_route is not null and adex.capital_period_closed(v_company, v_to_route, v_date)) then
        perform adex.capital_raise('AX407', 'the period of the route is closed');
      end if;
    end if;

    -- ---------- Autoridad y patas por tipo ----------
    -- structural = solo el responsable; settle = responsable, SuperAdmin o Supervisor
    -- asignado; correct = responsable o SuperAdmin (`routeCashAuthorityError` de CLEAN).
    -- Comparaciones con IS [NOT] DISTINCT FROM: un NULL nunca concede autoridad.
    if v_kind in ('COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN') then
      if v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the SuperAdmin moves company capital'); end if;
      if v_kind in ('ADMIN_ALLOCATION', 'ADMIN_RETURN') then
        -- Recibir capital exige estar activo; devolverlo, no (una bolsa inactiva se vacía).
        if not exists (select 1 from adex.memberships where company_id = v_company and id = v_admin and role = 'admin'
                         and (status = 'activo' or (v_kind = 'ADMIN_ALLOCATION') = v_reversal)) then
          perform adex.capital_raise('AX412', 'administrator not found or inactive');
        end if;
      end if;
      case v_kind
        when 'COMPANY_DEPOSIT'    then v_accts := array[adex.capital_account_for(v_company, 'external', null, null), adex.capital_account_for(v_company, 'company', null, null)];
        when 'COMPANY_WITHDRAWAL' then v_accts := array[adex.capital_account_for(v_company, 'company', null, null), adex.capital_account_for(v_company, 'external', null, null)];
        when 'ADMIN_ALLOCATION'   then v_accts := array[adex.capital_account_for(v_company, 'company', null, null), adex.capital_account_for(v_company, 'admin', v_admin, null)];
        else                           v_accts := array[adex.capital_account_for(v_company, 'admin', v_admin, null), adex.capital_account_for(v_company, 'company', null, null)];
      end case;

    elsif v_kind = 'PARTNER_CONTRIBUTION' then
      -- Socio → bolsa del responsable de la ruta que el aporte va a operar (C1). Caja
      -- socios (D1) no se toca: si debe tener saldo sigue siendo una decisión abierta.
      if v_reversal then
        if v_actor is distinct from v_ctrl and v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can correct'); end if;
      else
        if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the route capital controller receives partner capital'); end if;
        if not adex.route_operational(v_company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
        if not exists (select 1 from adex.memberships where company_id = v_company and id = v_counter and role = 'socio') then
          perform adex.capital_raise('AX412', 'partner not found');
        end if;
        -- `isTransferInScope`: el socio comparte alguna ruta con quien registra.
        if not exists (select 1 from adex.membership_routes p join adex.membership_routes a on a.route_id = p.route_id and a.company_id = p.company_id
                        where p.company_id = v_company and p.membership_id = v_counter and a.membership_id = v_actor) then
          perform adex.capital_raise('AX402', 'partner is outside your scope');
        end if;
        v_admin := v_ctrl;
      end if;
      v_accts := array[adex.capital_account_for(v_company, 'partner', v_counter, null), adex.capital_account_for(v_company, 'admin', v_admin, null)];

    elsif v_kind = 'WORKER_DELIVERY' then
      if v_reversal then
        if v_actor is distinct from v_ctrl and v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can correct'); end if;
      else
        if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the route capital controller delivers capital'); end if;
        if not adex.route_operational(v_company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
        if not adex.capital_custodian_ok(v_company, v_route, v_worker) then perform adex.capital_raise('AX403', 'recipient cannot hold cash in this route'); end if;
        if p_sale_request is not null and not exists (select 1 from adex.sale_requests where company_id = v_company and id = p_sale_request and route_id = v_route) then
          perform adex.capital_raise('AX412', 'sale request not found in this route');
        end if;
      end if;
      v_admin := v_ctrl;   -- paga (o, al anular, recupera) la bolsa que HOY responde por la ruta
      v_accts := array[adex.capital_account_for(v_company, 'admin', v_admin, null), adex.capital_account_for(v_company, 'custody', v_worker, v_route)];

    elsif v_kind = 'WORKER_RETURN' then
      if v_reversal then
        if v_actor is distinct from v_ctrl and v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can correct'); end if;
      else
        if not (v_actor is not distinct from v_ctrl or v_role = 'superadmin'
                or (v_role = 'supervisor' and exists (select 1 from adex.membership_routes where company_id = v_company and membership_id = v_actor and route_id = v_route))) then
          perform adex.capital_raise('AX402', 'no authority to receive returns in this route');
        end if;
        if not exists (select 1 from adex.memberships where company_id = v_company and id = v_worker and role in ('cobrador', 'supervisor')) then
          perform adex.capital_raise('AX403', 'worker not found');
        end if;
      end if;
      v_admin := v_ctrl;
      v_accts := array[adex.capital_account_for(v_company, 'custody', v_worker, v_route), adex.capital_account_for(v_company, 'admin', v_admin, null)];

    elsif v_kind = 'WORKER_TRANSFER' then
      if v_reversal then
        if v_actor is distinct from v_ctrl and v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can correct'); end if;
        v_accts := array[adex.capital_account_for(v_company, 'custody', v_counter, v_route), adex.capital_account_for(v_company, 'custody', v_worker, v_route)];
      else
        if not (v_actor is not distinct from v_ctrl or v_role = 'superadmin'
                or (v_role = 'supervisor' and exists (select 1 from adex.membership_routes where company_id = v_company and membership_id = v_actor and route_id = v_route))) then
          perform adex.capital_raise('AX402', 'no authority over cash in this route');
        end if;
        if v_worker = v_counter then perform adex.capital_raise('AX411', 'origin and destination must differ'); end if;
        if not adex.route_operational(v_company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
        if not exists (select 1 from adex.memberships m join adex.membership_routes mr on mr.membership_id = m.id and mr.route_id = v_route and mr.company_id = m.company_id
                        where m.company_id = v_company and m.id = v_worker and m.role in ('cobrador', 'supervisor')) then
          perform adex.capital_raise('AX403', 'origin worker is not assigned to this route');
        end if;
        if not adex.capital_custodian_ok(v_company, v_route, v_counter) then perform adex.capital_raise('AX403', 'recipient cannot hold cash in this route'); end if;
        v_accts := array[adex.capital_account_for(v_company, 'custody', v_worker, v_route), adex.capital_account_for(v_company, 'custody', v_counter, v_route)];
      end if;

    elsif v_kind = 'ROUTE_REASSIGNMENT' then
      -- Devolución en una ruta + entrega en otra, por el MISMO responsable, en una sola
      -- operación: cada ruta conserva su atribución y el dinero pasa por la bolsa.
      -- Entre responsables distintos es la decisión abierta D2: se bloquea solo ese caso.
      if v_ctrl is distinct from v_ctrl2 then perform adex.capital_raise('AX406', 'routes with different capital controllers (decision D2 pending)'); end if;
      if v_reversal then
        if v_actor is distinct from v_ctrl and v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can correct'); end if;
        v_accts := array[adex.capital_account_for(v_company, 'custody', v_counter, v_to_route), adex.capital_account_for(v_company, 'admin', v_ctrl, null),
                         adex.capital_account_for(v_company, 'admin', v_ctrl, null), adex.capital_account_for(v_company, 'custody', v_worker, v_route)];
      else
        if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the capital controller of both routes reassigns cash'); end if;
        if not adex.route_operational(v_company, v_to_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
        if not exists (select 1 from adex.memberships where company_id = v_company and id = v_worker and role in ('cobrador', 'supervisor')) then
          perform adex.capital_raise('AX403', 'worker not found');
        end if;
        if not adex.capital_custodian_ok(v_company, v_to_route, v_counter) then perform adex.capital_raise('AX403', 'recipient cannot hold cash in the destination route'); end if;
        v_accts := array[adex.capital_account_for(v_company, 'custody', v_worker, v_route), adex.capital_account_for(v_company, 'admin', v_ctrl, null),
                         adex.capital_account_for(v_company, 'admin', v_ctrl, null), adex.capital_account_for(v_company, 'custody', v_counter, v_to_route)];
      end if;
      v_admin := v_ctrl;
    else
      perform adex.capital_raise('AX411', 'unknown operation kind');
    end if;

    -- Anular invierte el sentido. Los tipos de dos patas se construyeron en el sentido
    -- original: se intercambian. Traspaso y reasignación ya se construyeron invertidos.
    if v_reversal and array_length(v_accts, 1) = 2 and v_kind <> 'WORKER_TRANSFER' then
      v_accts := array[v_accts[2], v_accts[1]];
    end if;
    v_amts := case when array_length(v_accts, 1) = 4 then array[-v_amount, v_amount, -v_amount, v_amount] else array[-v_amount, v_amount] end;

    -- Nadie REDUCE su propia custodia, ni con otra de sus membresías (DS-05: misma
    -- persona). Quien entrega el efectivo no puede ser quien registra que lo entregó.
    if exists (select 1 from adex.capital_accounts a join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
                where a.company_id = v_company and a.id = v_accts[1] and a.kind = 'custody'
                  and (m.id = v_actor or m.identity_id = v_identity)) then
      perform adex.capital_raise('AX410', 'nobody reduces their own custody');
    end if;

    -- ---------- Bloqueo de cuentas en orden global ----------
    perform 1 from adex.capital_accounts
      where company_id = v_company and id = any(v_accts)
      order by array_position(array['company', 'admin', 'custody', 'partner', 'external'], kind), id
      for update;

    -- Efectivo en manos (no deuda arrastrada) para lo que mueve billetes ya entregados:
    -- traspasos, reasignaciones y anular una entrega (`transferableCash` de CLEAN).
    if (v_kind in ('WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') or (v_reversal and v_kind = 'WORKER_DELIVERY')) then
      select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = v_company and id = v_accts[1];
      if v_bal - v_carried < v_amount then perform adex.capital_raise('AX413', 'the cash was already used'); end if;
    end if;

    -- ---------- Escritura ----------
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, to_route_id,
                                         admin_membership_id, worker_membership_id, counterpart_membership_id, sale_request_id,
                                         reverses_operation_id, reverses_kind, reason, entry_date, actor_membership_id, actor_identity_id,
                                         actor_role, txid)
    values (gen_random_uuid()::text, v_company, p_operation_id, p_kind, v_amount, v_currency, v_route, v_to_route,
            v_admin, v_worker, v_counter, case when v_reversal then v_orig.sale_request_id else p_sale_request end,
            v_orig.id, case when v_reversal then v_orig.kind end, btrim(p_reason), v_date, v_actor, v_identity, v_role, txid_current())
    returning * into v_op;

    for v_i in 1 .. array_length(v_accts, 1) loop
      update adex.capital_accounts
         set balance_minor = balance_minor + v_amts[v_i], version = version + 1, updated_at = now()
       where company_id = v_company and id = v_accts[v_i]
      returning balance_minor into v_bal;
      insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor)
      values (v_company, v_op.id, v_i, v_accts[v_i], v_amts[v_i], v_bal);
    end loop;
    return v_op;
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      -- El sobregiro se informa SIN cifras: nunca revela el saldo de otra cuenta.
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_reversal_key' then perform adex.capital_raise('AX405', 'operation already reversed'); end if;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;

create or replace function adex.credit_disburse(
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
    select c.currency_code, adex.business_today(c.id) into v_currency, v_today from adex.companies c where c.id = v_company;

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

create or replace function adex.money_context(p_operation_id uuid) returns adex.money_ctx
  language plpgsql
  as $$
  declare r adex.money_ctx;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'money commands run only through the company API'); end if;
    select adex.ctx_company() as company, adex.ctx_membership() as actor, adex.ctx_role() as role, adex.ctx_identity() as identity,
           c.currency_code as currency, adex.business_today(c.id) as today
      into r from adex.companies c where c.id = adex.ctx_company();
    if r.role is null or r.company is null or r.identity is null or r.actor is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    if p_operation_id is null then perform adex.capital_raise('AX411', 'operation id is required'); end if;
    if exists (select 1 from adex.capital_operations where company_id = r.company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    return r;
  end $$;

create or replace function adex.company_today(p_company text) returns date
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select adex.business_today(c.id) from adex.companies c where c.id = p_company and adex.api_scope_ok(p_company) $$;

create or replace function adex.sale_requests_guard() returns trigger
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
      if new.start_date < adex.business_today(new.company_id) then
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
