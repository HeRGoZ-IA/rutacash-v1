-- REVERSIÓN de 0033 (manual, como adex_owner, en una transacción). Intervención R74, E1 + H.
-- 0033 solo cambia AUTORIDAD (quién puede hacer qué); no registra datos propios, así que la
-- reversión no tiene nada que negar: devuelve al SuperAdmin las facultades financieras retiradas
-- y quita las barreras de autoasignación/autoaprobación/autoentrega en PostgreSQL.
-- OJO: la API y la matriz de CLEAN siguen negándolas mientras no se revierta también el código.
-- Restaura literalmente las funciones de 0013, 0014, 0016, 0017, 0018, 0025, 0028 y 0029.
-- Después: delete from adex_meta.schema_migrations where version = '0033'.
-- Generado por tmp/r74/e1h/build-0033.mjs.

begin;

set local role adex_owner;

drop policy membership_routes_no_self_scope on adex.membership_routes;
drop function adex.membership_routes_not_own(text, text);
drop trigger memberships_profile_rule on adex.memberships;
drop function adex.memberships_profile_rule();
drop trigger memberships_no_self_reactivation on adex.memberships;
drop function adex.memberships_no_self_reactivation();
drop policy memberships_no_self_insert on adex.memberships;

alter policy payment_adjustment_reject on adex.payment_adjustment_requests
  using (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id) and adex.ctx_can('payment.approveAdjustment') and status = 'pending')
  with check (company_id = adex.ctx_company() and status = 'rejected' and reviewed_by_membership_id = adex.ctx_membership());

-- Funciones anteriores (texto literal de sus migraciones).

-- ctx_can: texto literal de 0029_route_map_locations.sql.
create or replace function adex.ctx_can(p_capability text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select coalesce(adex.ctx_role() = any(case p_capability
      when 'sale.createRequest'               then array['admin', 'supervisor', 'cobrador']
      when 'sale.createDirect'                then array['admin', 'supervisor']
      when 'sale.confirmDisbursement'         then array['admin', 'supervisor', 'cobrador']
      when 'sale.cancel'                      then array['admin']
      when 'authorization.access'             then array['admin', 'supervisor', 'secretario']
      when 'authorization.approve'            then array['admin', 'supervisor', 'secretario']
      when 'authorization.reject'             then array['admin', 'supervisor', 'secretario']
      when 'authorization.modifyConditions'   then array['admin', 'supervisor', 'secretario']
      when 'authorization.phoneConfirm'       then array['supervisor', 'secretario']
      when 'payment.register'                 then array['admin', 'supervisor', 'cobrador']
      when 'payment.reverse'                  then array['admin']
      when 'payment.approveAdjustment'        then array['admin']
      when 'payment.correct'                  then array['admin', 'secretario']
      when 'payment.viewHistory'              then array['superadmin', 'admin', 'supervisor', 'cobrador', 'secretario']
      when 'expense.register'                 then array['superadmin', 'admin', 'supervisor', 'cobrador']
      when 'expense.correct'                  then array['superadmin', 'admin']
      when 'cashCustody.manage'               then array['superadmin', 'admin', 'supervisor']
      when 'cashbox.viewConsolidated'         then array['superadmin', 'admin']
      when 'cashbox.viewRoute'                then array['superadmin', 'admin', 'supervisor']
      when 'cashSettlement.view'              then array['superadmin', 'admin', 'supervisor']
      when 'cashSettlement.viewOwn'           then array['supervisor', 'cobrador']
      when 'cashSettlement.close'             then array['superadmin', 'admin', 'supervisor']
      when 'cashSettlement.reopen'            then array['superadmin', 'admin']
      when 'settlement.close'                 then array['superadmin', 'admin']
      when 'settlement.reopen'                then array['superadmin', 'admin']
      when 'client.setLocation'               then array['admin', 'supervisor', 'cobrador']
      when 'map.view'                         then array['admin']
      else array[]::text[] end), false)
  $$;

-- capital_post: texto literal de 0025_voluntary_deliveries_requests.sql.
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
    -- Ronda 59: el Cobrador solo registra la entrega de SU efectivo (WORKER_RETURN, abajo).
    if v_role not in ('superadmin', 'admin', 'supervisor') and not (v_role = 'cobrador' and p_kind = 'WORKER_RETURN') then
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
      if v_orig.kind = 'PARTNER_CONTRIBUTION' then perform adex.capital_raise('AX404', 'historical partner contributions cannot be reversed'); end if;
      if v_orig.kind like 'ADMIN_TRANSFER_%' then perform adex.capital_raise('AX404', 'administrator transfers are settled by their own commands'); end if;
      if exists (select 1 from adex.capital_operations where company_id = v_company and reverses_operation_id = v_orig.id) then
        perform adex.capital_raise('AX405', 'operation already reversed');
      end if;
      v_kind := v_orig.kind; v_amount := v_orig.amount_minor; v_route := v_orig.route_id; v_to_route := v_orig.to_route_id;
      v_worker := v_orig.worker_membership_id; v_counter := v_orig.counterpart_membership_id; v_admin := v_orig.admin_membership_id;
    end if;

    -- ---------- Campos obligatorios por tipo ----------
    if v_amount is null or v_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
    if (v_kind in ('ADMIN_ALLOCATION', 'ADMIN_RETURN') and v_admin is null)
       or (v_kind in ('WORKER_DELIVERY', 'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and v_route is null)
       or (v_kind in ('WORKER_DELIVERY', 'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and v_worker is null)
       or (v_kind in ('WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and v_counter is null)
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
      -- Ronda 59: el Administrador devuelve capital de SU bolsa sin aprobación (entrega voluntaria).
      if v_role <> 'superadmin' and not (v_role = 'admin' and v_kind = 'ADMIN_RETURN' and not v_reversal and v_admin is not distinct from v_actor) then
        perform adex.capital_raise('AX402', 'only the SuperAdmin moves company capital');
      end if;
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
        if v_role = 'cobrador' then
          -- Ronda 59: entrega VOLUNTARIA de su propio efectivo al responsable de la ruta.
          if v_worker is distinct from v_actor then perform adex.capital_raise('AX402', 'a collector only delivers their own cash'); end if;
          if not exists (select 1 from adex.membership_routes where company_id = v_company and membership_id = v_actor and route_id = v_route) then
            perform adex.capital_raise('AX402', 'route is not assigned to the collector');
          end if;
          if exists (select 1 from adex.memberships where company_id = v_company and id = v_ctrl and identity_id = v_identity) then
            perform adex.capital_raise('AX410', 'nobody delivers cash to their own pool');
          end if;
        elsif not (v_actor is not distinct from v_ctrl or v_role = 'superadmin'
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
      -- Entre responsables distintos se usa el traspaso entre Administradores (0023).
      if v_ctrl is distinct from v_ctrl2 then perform adex.capital_raise('AX406', 'routes with different capital controllers'); end if;
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
    -- Ronda 59: salvo el Cobrador que entrega voluntariamente SU efectivo (comprobado arriba).
    if not (v_role = 'cobrador' and v_kind = 'WORKER_RETURN' and not v_reversal and v_worker = v_actor) and exists (select 1 from adex.capital_accounts a join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
                where a.company_id = v_company and a.id = v_accts[1] and a.kind = 'custody'
                  and (m.id = v_actor or m.identity_id = v_identity)) then
      perform adex.capital_raise('AX410', 'nobody reduces their own custody');
    end if;

    -- ---------- Bloqueo de cuentas en orden global ----------
    perform 1 from adex.capital_accounts
      where company_id = v_company and id = any(v_accts)
      order by array_position(array['company', 'admin', 'custody', 'external'], kind), id
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

-- credit_disburse: texto literal de 0018_business_date.sql.
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

-- expense_post: texto literal de 0013_collections_expenses.sql.
create or replace function adex.expense_post(
  p_operation_id  uuid,
  p_scope         text,
  p_route         text,
  p_worker        text,
  p_category      text,
  p_amount        bigint,
  p_description   text,
  p_reference     text,
  p_funding       text,      -- solo empresa: 'admin' | 'empresa'
  p_funding_admin text
) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x         adex.money_ctx;
    v_ctrl    text;
    v_payer   text;
    v_expacc  text;
    v_kind    text;
    v_admin   text;
    v_expense text := gen_random_uuid()::text;
    v_op      text := gen_random_uuid()::text;
    v_cname   text;
  begin
    x := adex.money_context(p_operation_id);
    if not adex.ctx_can('expense.register') then perform adex.capital_raise('42501', 'no expense authority'); end if;
    if p_amount is null or p_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
    if (p_description is not null and length(p_description) > 300) or (p_reference is not null and length(p_reference) > 120) then
      perform adex.capital_raise('AX411', 'text too long');
    end if;
    -- Forma (`expenseShapeError`).
    if p_scope is null or p_scope not in ('empresa', 'ruta', 'trabajador')
       or (p_scope = 'empresa' and (p_route is not null or p_worker is not null))
       or (p_scope = 'ruta' and (p_route is null or p_worker is not null))
       or (p_scope = 'trabajador' and (p_route is null or p_worker is null))
       or (p_scope <> 'empresa' and (p_funding is not null or p_funding_admin is not null)) then
      perform adex.capital_raise('AX411', 'invalid expense shape');
    end if;
    if not exists (select 1 from adex.expense_categories where company_id = x.company and id = p_category) then
      perform adex.capital_raise('AX711', 'category not found');
    end if;

    if p_scope = 'empresa' then
      if not adex.ctx_can('cashbox.viewConsolidated') then perform adex.capital_raise('42501', 'no company expense authority'); end if;
      if p_description is null or length(btrim(p_description)) < 3 then perform adex.capital_raise('AX411', 'description is required'); end if;
      -- Bolsa (D10/D11): Administrador → solo la suya; SuperAdmin → la de la empresa o la de un Administrador activo.
      if x.role = 'admin' then
        if p_funding is distinct from 'admin' or p_funding_admin is distinct from x.actor then perform adex.capital_raise('AX712', 'an administrator pays only from their own pool'); end if;
      elsif x.role = 'superadmin' then
        if p_funding = 'empresa' and p_funding_admin is null then null;
        elsif p_funding = 'admin' and exists (select 1 from adex.memberships where company_id = x.company and id = p_funding_admin and role = 'admin' and status = 'activo') then null;
        else perform adex.capital_raise('AX712', 'invalid pool');
        end if;
      else
        perform adex.capital_raise('42501', 'no company expense authority');
      end if;
      v_kind := 'COMPANY_EXPENSE';
      v_admin := case when p_funding = 'admin' then p_funding_admin end;
      v_payer := case when p_funding = 'admin' then adex.capital_account_for(x.company, 'admin', p_funding_admin, null)
                      else adex.capital_account_for(x.company, 'company', null, null) end;
    else
      if not adex.ctx_route_allowed(p_route) or not exists (select 1 from adex.routes where company_id = x.company and id = p_route) then
        perform adex.capital_raise('AX412', 'route not found');
      end if;
      perform 1 from adex.routes where company_id = x.company and id = p_route for share;
      if not adex.route_operational(x.company, p_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
      if adex.capital_period_closed(x.company, p_route, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
      v_ctrl := adex.route_valid_controller(x.company, p_route);
      if p_scope = 'ruta' then
        -- C1: la paga la bolsa del responsable; solo él la registra (`structural`).
        if not adex.ctx_can('cashCustody.manage') then perform adex.capital_raise('42501', 'no route cash authority'); end if;
        if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
        if x.actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the route capital controller pays route expenses'); end if;
        v_kind := 'ROUTE_EXPENSE';
        v_admin := v_ctrl;
        v_payer := adex.capital_account_for(x.company, 'admin', v_ctrl, null);
      else
        if not adex.capital_custodian_ok(x.company, p_route, p_worker) then perform adex.capital_raise('AX403', 'the worker cannot answer for an expense in this route'); end if;
        -- Cargarlo a OTRA persona es operar con su efectivo (`settle`).
        if p_worker is distinct from x.actor then
          if not adex.ctx_can('cashCustody.manage') then perform adex.capital_raise('42501', 'expenses you register are yours'); end if;
          if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
          if not (x.actor is not distinct from v_ctrl or x.role = 'superadmin'
                  or (x.role = 'supervisor' and exists (select 1 from adex.membership_routes where company_id = x.company and membership_id = x.actor and route_id = p_route))) then
            perform adex.capital_raise('AX402', 'no authority over cash in this route');
          end if;
        end if;
        v_kind := 'WORKER_EXPENSE';
        v_payer := adex.capital_account_for(x.company, 'custody', p_worker, p_route);
      end if;
    end if;
    v_expacc := adex.capital_account_for(x.company, 'expense', null, p_route);
    perform adex.capital_lock_accounts(x.company, array[v_payer, v_expacc]);

    insert into adex.expenses (id, company_id, route_id, scope, category_id, amount_minor, description, expense_date, registered_by_membership_id,
                               collector_membership_id, funding, funding_admin_membership_id, reference, sync_status, created_at, ledger_operation_id)
    values (v_expense, x.company, p_route, p_scope, p_category, p_amount, nullif(btrim(p_description), ''), x.today, x.actor, p_worker,
            case when p_scope = 'empresa' then p_funding end, case when p_scope = 'empresa' then p_funding_admin end,
            nullif(btrim(p_reference), ''), 'synced', now(), v_op);
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, expense_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_op, x.company, p_operation_id, v_kind, p_amount, x.currency, p_route, v_admin, p_worker, v_expense,
            case when length(btrim(coalesce(p_description, ''))) >= 3 then btrim(p_description) else 'Gasto' end,
            x.today, x.actor, x.identity, x.role, txid_current());
    -- Gasto del trabajador SIN tope (73209ce): `guard_custody_negative` admite su negativo.
    perform adex.capital_write_legs(x.company, v_op, array[v_payer, v_expacc], array[-p_amount, p_amount]);
    return jsonb_build_object('expenseId', v_expense, 'operationId', v_op, 'kind', v_kind, 'expenseDate', x.today);
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;

-- expense_correctable: texto literal de 0028_superadmin_portfolio_read_only.sql.
create or replace function adex.expense_correctable(x adex.money_ctx, p_expense text, p_refund boolean) returns adex.expense_fix
  language plpgsql
  as $$
  declare e adex.expenses; o adex.capital_operations; v_ctrl text; r adex.expense_fix;
  begin
    if not adex.ctx_can('expense.correct') then perform adex.capital_raise('42501', 'no expense correction authority'); end if;
    select * into e from adex.expenses where company_id = x.company and id = p_expense;
    if not found or (e.route_id is not null and not adex.ctx_route_allowed(e.route_id)) then perform adex.capital_raise('AX412', 'expense not found'); end if;
    if e.route_id is not null then perform 1 from adex.routes where company_id = x.company and id = e.route_id for share; end if;
    select * into e from adex.expenses where company_id = x.company and id = p_expense for update;
    if e.ledger_operation_id is null then perform adex.capital_raise('AX706', 'expense without ledger entry is not corrected here (D9)'); end if;
    if e.reverses_id is not null or e.refunds_expense_id is not null then perform adex.capital_raise('AX404', 'a correction cannot be corrected'); end if;
    if e.reversal_id is not null then perform adex.capital_raise('AX405', 'expense already reversed'); end if;
    select * into o from adex.capital_operations where company_id = x.company and id = e.ledger_operation_id;
    if e.scope is distinct from 'empresa' then
      -- F5-D02 (aprobada 2026-10-17): anulación de gastos de trabajador y de ruta.
      if p_refund then perform adex.capital_raise('AX713', 'only pool expenses have refunds'); end if;
      -- Autoridad `correct`: el Administrador responsable de capital de la ruta o el SuperAdmin.
      v_ctrl := adex.route_valid_controller(x.company, e.route_id);
      if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
      if x.actor is distinct from v_ctrl and x.role <> 'superadmin' then
        perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can reverse');
      end if;
      -- Control independiente: quien anula no es la PERSONA que registró (ni con otra membresía).
      if adex.same_person(x.company, x.actor, e.registered_by_membership_id) then
        perform adex.capital_raise('AX717', 'the person who registered the expense cannot reverse it');
      end if;
      -- D7: la anulación se asienta hoy, que debe estar abierto; si la semana del gasto está
      -- cerrada, es un ajuste en el periodo abierto y exige la autoridad de aprobar ajustes.
      if adex.capital_period_closed(x.company, e.route_id, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
      if adex.capital_period_closed(x.company, e.route_id, e.expense_date)
         and not (adex.ctx_can('payment.approveAdjustment') or x.role = 'superadmin') then
        perform adex.capital_raise('42501', 'closed period needs adjustment authority');
      end if;
    -- D12 (CLEAN `canCorrectPoolExpense`): el Administrador, su bolsa; el SuperAdmin, cualquiera.
    elsif not (x.role = 'superadmin' or (x.role = 'admin' and e.funding = 'admin' and e.funding_admin_membership_id = x.actor)) then
      perform adex.capital_raise('AX402', 'you cannot correct expenses of that pool');
    end if;
    select e.id as id, e.amount_minor as amount, e.route_id as route, e.scope as scope, o.id as op, o.kind as kind,
           o.admin_membership_id as admin, o.worker_membership_id as worker,
           (select account_id from adex.capital_entries where company_id = x.company and operation_id = o.id and amount_minor < 0) as payer,
           (select account_id from adex.capital_entries where company_id = x.company and operation_id = o.id and amount_minor > 0) as expacc,
           coalesce((select -sum(amount_minor) from adex.expenses where company_id = x.company and refunds_expense_id = e.id), 0) as refunded
      into r;
    return r;
  end $$;

-- custody_settle: texto literal de 0014_settlements_closures.sql.
create or replace function adex.custody_settle(
  p_operation_id  uuid,
  p_route         text,
  p_worker        text,
  p_delivered     bigint,
  p_expected_seen bigint,
  p_previous      text,
  p_reason        text
) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x         adex.money_ctx;
    m         adex.memberships;
    v_ctrl    text;
    v_acc     text;
    v_pool    text;
    v_sus     text;
    v_uni     text;
    v_bal     bigint;
    v_carried bigint;
    v_prev    adex.custody_settlements;
    v_from    bigint;
    v_to      bigint;
    v_closing bigint;
    c         adex.custody_cycle_t;
    v_p       bigint;
    v_e       bigint;
    v_diff    bigint;
    v_short   bigint;
    v_surplus bigint;
    v_t       bigint;
    v_version int;
    v_id      text := gen_random_uuid()::text;
    v_ret     text;
    v_sop     text;
    v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
    v_tz      text;
    v_cname   text;
  begin
    x := adex.money_context(p_operation_id);
    if not adex.ctx_can('cashSettlement.close') then perform adex.capital_raise('42501', 'no settlement authority'); end if;
    if p_delivered is null or p_delivered < 0 or p_expected_seen is null or p_route is null or p_worker is null then
      perform adex.capital_raise('AX411', 'route, worker, delivered (>= 0) and the expected amount seen are required');
    end if;
    if v_reason is not null and length(v_reason) > 300 then perform adex.capital_raise('AX411', 'reason is too long'); end if;
    if exists (select 1 from adex.custody_settlements where company_id = x.company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    if not adex.ctx_route_allowed(p_route) or not exists (select 1 from adex.routes where company_id = x.company and id = p_route) then
      perform adex.capital_raise('AX412', 'route not found');
    end if;

    -- Bloqueos: ruta (compartido: fija responsable y cierres; deja correr la ruta).
    perform 1 from adex.routes where company_id = x.company and id = p_route for share;
    v_ctrl := adex.route_valid_controller(x.company, p_route);
    if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    -- Autoridad `settle` (`routeCashAuthorityError`): responsable, SuperAdmin o Supervisor de la ruta.
    if not (x.actor is not distinct from v_ctrl or x.role = 'superadmin'
            or (x.role = 'supervisor' and exists (select 1 from adex.membership_routes where company_id = x.company and membership_id = x.actor and route_id = p_route))) then
      perform adex.capital_raise('AX402', 'no authority to settle cash in this route');
    end if;
    if adex.capital_period_closed(x.company, p_route, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;

    -- Trabajador con caja personal; asignado a la ruta o con custodia en ella (un trabajador
    -- retirado o desactivado debe poder entregar lo que tiene: nunca se deja dinero varado).
    select * into m from adex.memberships where company_id = x.company and id = p_worker;
    if not found then perform adex.capital_raise('AX412', 'worker not found'); end if;
    if m.role not in ('cobrador', 'supervisor') then perform adex.capital_raise('AX403', 'only collectors and supervisors hold personal cash'); end if;
    v_acc := 'acc-' || md5(x.company || '|custody|' || p_worker || '|' || p_route);
    if not exists (select 1 from adex.membership_routes where company_id = x.company and membership_id = p_worker and route_id = p_route)
       and not exists (select 1 from adex.capital_accounts where company_id = x.company and id = v_acc) then
      perform adex.capital_raise('AX403', 'the worker has no cash in this route');
    end if;
    -- Nadie se cuadra a sí mismo, ni con otra de sus membresías (DS-05: misma persona).
    if adex.same_person(x.company, x.actor, p_worker) then perform adex.capital_raise('AX801', 'nobody settles their own cash'); end if;

    v_acc := adex.capital_account_for(x.company, 'custody', p_worker, p_route);
    v_pool := adex.capital_account_for(x.company, 'admin', v_ctrl, null);
    perform adex.capital_lock_accounts(x.company, array[v_pool, v_acc]);

    -- Bajo bloqueo: ciclo abierto, esperado y comprobaciones de cifras obsoletas.
    select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = x.company and id = v_acc;
    v_prev := adex.custody_last_settlement(x.company, v_acc);
    if v_prev.id is distinct from p_previous then perform adex.capital_raise('AX802', 'another settlement was closed meanwhile'); end if;
    v_from := coalesce(v_prev.closing_seq, 0);
    v_to := greatest(v_from, coalesce((select max(seq) from adex.capital_entries where company_id = x.company and account_id = v_acc), 0));
    c := adex.custody_cycle(x.company, v_acc, v_from, v_to);
    v_p := adex.custody_cycle_position(c);
    if v_p <> v_bal then perform adex.capital_raise('AX420', 'custody cycle does not match the ledger'); end if;
    if p_expected_seen <> v_p then perform adex.capital_raise('AX802', 'the figures changed since the preview'); end if;

    v_e := greatest(v_p, 0);
    v_diff := p_delivered - v_e;
    v_short := greatest(0, -v_diff);
    v_surplus := greatest(0, v_diff);
    v_t := least(p_delivered, v_e);
    if v_diff <> 0 and length(coalesce(v_reason, '')) < 10 then perform adex.capital_raise('AX803', 'a difference needs a reason (10+ characters)'); end if;
    select coalesce(max(version), 0) + 1 into v_version from adex.custody_settlements
     where company_id = x.company and custody_account_id = v_acc and cycle_no = coalesce(v_prev.cycle_no, 0) + 1;

    -- Efectivo reconocido → bolsa del responsable (C1). Nunca el faltante ni el sobrante.
    if v_t > 0 then
      v_ret := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, settlement_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_ret, x.company, p_operation_id, 'SETTLEMENT_RETURN', v_t, x.currency, p_route, v_ctrl, p_worker, v_id,
              'Cuadre: efectivo entregado', x.today, x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_ret, array[v_acc, v_pool], array[-v_t, v_t]);
    end if;
    -- Sobrante → cuentas de control (no gastable; su destino es la decisión F6-D02).
    if v_surplus > 0 then
      v_sus := adex.capital_account_for(x.company, 'suspense', v_ctrl, p_route);
      v_uni := adex.capital_account_for(x.company, 'unidentified', null, p_route);
      perform adex.capital_lock_accounts(x.company, array[v_sus, v_uni]);
      v_sop := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, settlement_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_sop, x.company, md5(p_operation_id::text || ':surplus')::uuid, 'SETTLEMENT_SURPLUS', v_surplus, x.currency, p_route, v_ctrl,
              p_worker, v_id, 'Cuadre: sobrante sin identificar', x.today, x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_sop, array[v_uni, v_sus], array[-v_surplus, v_surplus]);
    end if;
    -- Arrastre: SOLO el faltante, en positivo (`carryOverFrom`).
    update adex.capital_accounts set carried_minor = v_short, version = version + 1, updated_at = now()
     where company_id = x.company and id = v_acc;
    v_closing := greatest(v_to, coalesce((select max(seq) from adex.capital_entries where company_id = x.company and account_id = v_acc), 0));
    select timezone into v_tz from adex.companies where id = x.company;

    insert into adex.custody_settlements (
      id, company_id, route_id, worker_membership_id, worker_identity_id, custody_account_id, operation_id, cycle_no, version, previous_settlement_id,
      from_seq, to_seq, closing_seq, opening_position_minor, opening_carried_minor, base_received_minor, base_returned_minor, collected_minor,
      disbursed_minor, expenses_minor, other_minor, expected_position_minor, expected_cash_minor, expected_seen_minor, delivered_minor,
      difference_minor, shortage_minor, surplus_minor, returned_to_pool_minor, carried_after_minor, negative_position_minor, breakdown, reason,
      status, business_date, timezone, closed_at, closed_by_membership_id, closed_by_identity_id, closed_by_role, receiver_admin_membership_id,
      return_operation_id, surplus_operation_id, txid)
    values (
      v_id, x.company, p_route, p_worker, m.identity_id, v_acc, p_operation_id, coalesce(v_prev.cycle_no, 0) + 1, v_version, v_prev.id,
      v_from, v_to, v_closing, c.opening, coalesce(v_prev.carried_after_minor, 0), c.base_received + c.transfers_in, c.partial_returns + c.transfers_out,
      c.collected, c.disbursed, c.expenses, c.settlement_adjust + c.other, v_p, v_e, p_expected_seen, p_delivered,
      v_diff, v_short, v_surplus, v_t, v_short, least(v_p, 0), adex.custody_cycle_json(c), v_reason,
      'cerrada', x.today, v_tz, now(), x.actor, x.identity, x.role, v_ctrl, v_ret, v_sop, txid_current());
    -- Volver a cerrar un ciclo reabierto: la versión nueva sustituye a las reabiertas del mismo arranque.
    update adex.custody_settlements set superseded_by = v_id
     where company_id = x.company and custody_account_id = v_acc and cycle_no = coalesce(v_prev.cycle_no, 0) + 1
       and status = 'reabierta' and superseded_by is null;

    return jsonb_build_object('settlementId', v_id, 'version', v_version, 'routeId', p_route, 'workerId', p_worker,
      'expectedPositionMinor', v_p, 'expectedCashMinor', v_e, 'deliveredMinor', p_delivered, 'differenceMinor', v_diff,
      'shortageMinor', v_short, 'surplusMinor', v_surplus, 'returnedToPoolMinor', v_t, 'carriedAfterMinor', v_short,
      'negativePositionMinor', least(v_p, 0), 'returnOperationId', v_ret, 'surplusOperationId', v_sop, 'businessDate', x.today,
      'result', case when v_diff = 0 then 'exacto' when v_diff < 0 then 'faltante' else 'sobrante' end);
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('capital_operations_operation_key', 'custody_settlements_operation_key') then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname = 'custody_settlements_one_active_per_cycle' then perform adex.capital_raise('AX802', 'another settlement was closed meanwhile'); end if;
      raise;
  end $$;

-- custody_settlement_reopen: texto literal de 0014_settlements_closures.sql.
create or replace function adex.custody_settlement_reopen(p_operation_id uuid, p_settlement text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x       adex.money_ctx;
    s       adex.custody_settlements;
    v_ctrl  text;
    v_pool  text;
    v_sus   text;
    v_uni   text;
    v_rev   text;
    v_rev2  text;
    v_reason text := btrim(coalesce(p_reason, ''));
    v_cname text;
  begin
    x := adex.money_context(p_operation_id);
    if not adex.ctx_can('cashSettlement.reopen') then perform adex.capital_raise('42501', 'no reopen authority'); end if;
    if length(v_reason) < 10 or length(v_reason) > 300 then perform adex.capital_raise('AX803', 'reopening needs a reason (10+ characters)'); end if;
    select * into s from adex.custody_settlements where company_id = x.company and id = p_settlement;
    if not found or not adex.ctx_route_allowed(s.route_id) then perform adex.capital_raise('AX412', 'settlement not found'); end if;

    perform 1 from adex.routes where company_id = x.company and id = s.route_id for share;
    v_ctrl := adex.route_valid_controller(x.company, s.route_id);
    if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    -- Reabrir es CORREGIR: responsable de capital de la ruta o SuperAdmin.
    if x.actor is distinct from v_ctrl and x.role <> 'superadmin' then
      perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can reopen');
    end if;
    if adex.same_person(x.company, x.actor, s.worker_membership_id) then perform adex.capital_raise('AX801', 'nobody reopens their own settlement'); end if;
    -- D7: hoy abierto y el día del cuadre en un periodo abierto (lo cerrado no se reabre).
    if adex.capital_period_closed(x.company, s.route_id, x.today) or adex.capital_period_closed(x.company, s.route_id, s.business_date) then
      perform adex.capital_raise('AX407', 'the period of the settlement is closed');
    end if;

    v_pool := adex.capital_account_for(x.company, 'admin', s.receiver_admin_membership_id, null);
    perform adex.capital_lock_accounts(x.company, array[v_pool, s.custody_account_id]);
    if s.surplus_operation_id is not null then
      v_sus := adex.capital_account_for(x.company, 'suspense', s.receiver_admin_membership_id, s.route_id);
      v_uni := adex.capital_account_for(x.company, 'unidentified', null, s.route_id);
      perform adex.capital_lock_accounts(x.company, array[v_sus, v_uni]);
    end if;
    select * into s from adex.custody_settlements where company_id = x.company and id = p_settlement for update;
    if s.status <> 'cerrada' or s.superseded_by is not null then perform adex.capital_raise('AX806', 'the settlement is not open to reopening'); end if;
    -- Solo el ÚLTIMO cuadre vigente (`reopenCashBlockedReason`).
    if exists (select 1 from adex.custody_settlements where company_id = x.company and custody_account_id = s.custody_account_id
                 and status = 'cerrada' and id <> s.id and cycle_no > s.cycle_no) then
      perform adex.capital_raise('AX806', 'only the latest settlement can be reopened');
    end if;

    -- El efectivo devuelto a la bolsa vuelve a la custodia (si la bolsa aún lo tiene).
    if s.return_operation_id is not null then
      v_rev := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, settlement_id, reverses_operation_id, reverses_kind, reason, entry_date,
                                           actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_rev, x.company, p_operation_id, 'REVERSAL', s.returned_to_pool_minor, x.currency, s.route_id, s.receiver_admin_membership_id,
              s.worker_membership_id, s.id, s.return_operation_id, 'SETTLEMENT_RETURN', 'Reapertura del cuadre: ' || v_reason, x.today,
              x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_rev, array[v_pool, s.custody_account_id], array[-s.returned_to_pool_minor, s.returned_to_pool_minor]);
    end if;
    if s.surplus_operation_id is not null then
      v_rev2 := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, settlement_id, reverses_operation_id, reverses_kind, reason, entry_date,
                                           actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_rev2, x.company, md5(p_operation_id::text || ':surplus')::uuid, 'REVERSAL', s.surplus_minor, x.currency, s.route_id,
              s.receiver_admin_membership_id, s.worker_membership_id, s.id, s.surplus_operation_id, 'SETTLEMENT_SURPLUS',
              'Reapertura del cuadre: ' || v_reason, x.today, x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_rev2, array[v_sus, v_uni], array[-s.surplus_minor, s.surplus_minor]);
    end if;
    -- El arrastre vuelve al que había antes de este cuadre.
    update adex.capital_accounts set carried_minor = s.opening_carried_minor, version = version + 1, updated_at = now()
     where company_id = x.company and id = s.custody_account_id;
    update adex.custody_settlements set status = 'reabierta', reopened_at = now(), reopened_by_membership_id = x.actor, reopen_reason = v_reason
     where company_id = x.company and id = s.id;
    return jsonb_build_object('settlementId', s.id, 'routeId', s.route_id, 'workerId', s.worker_membership_id,
      'returnedToCustodyMinor', s.returned_to_pool_minor, 'surplusReleasedMinor', s.surplus_minor, 'carriedMinor', s.opening_carried_minor,
      'reversalOperationId', v_rev, 'surplusReversalOperationId', v_rev2, 'reopenDate', x.today);
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      -- La bolsa ya usó ese efectivo: no se reabre (nunca se recupera dinero ya usado).
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX413', 'the cash was already used'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname in ('capital_operations_reversal_key', 'capital_operations_one_per_settlement') then perform adex.capital_raise('AX806', 'the settlement is not open to reopening'); end if;
      raise;
  end $$;

-- period_close: texto literal de 0014_settlements_closures.sql.
create or replace function adex.period_close(p_operation_id uuid, p_route text, p_from date, p_to date, p_note text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x         adex.money_ctx;
    v_ctrl    text;
    v_fig     jsonb;
    v_c       jsonb;
    v_version int;
    v_id      text := gen_random_uuid()::text;
    v_office  record;
    v_tz      text;
    v_note    text := nullif(btrim(coalesce(p_note, '')), '');
    v_cname   text;
  begin
    x := adex.money_context(p_operation_id);
    if not adex.ctx_can('settlement.close') then perform adex.capital_raise('42501', 'no period close authority'); end if;
    if exists (select 1 from adex.period_closures where company_id = x.company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 366 then perform adex.capital_raise('AX411', 'invalid date range'); end if;
    if v_note is not null and length(v_note) > 300 then perform adex.capital_raise('AX411', 'note is too long'); end if;
    if p_route is null or not adex.ctx_route_allowed(p_route) or not exists (select 1 from adex.routes where company_id = x.company and id = p_route) then
      perform adex.capital_raise('AX412', 'route not found');
    end if;
    -- Bloqueo EXCLUSIVO de la ruta: espera a todo recaudo, gasto, desembolso, entrega o
    -- cuadre en curso de la ruta y a otro cierre simultáneo; lo que llegue después ve el cierre.
    perform 1 from adex.routes where company_id = x.company and id = p_route for update;
    v_ctrl := adex.route_valid_controller(x.company, p_route);
    if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    -- Autoridad `correct` (CLEAN `closeSettlement`): responsable de capital o SuperAdmin.
    if x.actor is distinct from v_ctrl and x.role <> 'superadmin' then
      perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin closes the period');
    end if;
    -- D29 con el reloj del servidor y la zona de la empresa (DS-04).
    if p_to >= x.today then perform adex.capital_raise('AX804', 'the period has not ended yet'); end if;
    -- Sin duplicados ni solapamientos con un cierre vigente (`closureBlockedReason`).
    if exists (select 1 from adex.weekly_settlements w where w.company_id = x.company and w.route_id = p_route
                 and coalesce(w.status, 'cerrada') = 'cerrada' and w.week_start <= p_to and p_from <= w.week_end) then
      perform adex.capital_raise('AX805', 'the range overlaps a closed period');
    end if;

    v_fig := adex.route_period_figures(x.company, p_route, p_from, p_to);
    v_c := v_fig -> 'custody';
    if (v_c ->> 'otherMinor')::bigint <> 0 then perform adex.capital_raise('AX420', 'unclassified custody movements'); end if;
    select coalesce(max(coalesce(version, 1)), 0) + 1 into v_version from adex.weekly_settlements
     where company_id = x.company and route_id = p_route and week_start = p_from and week_end = p_to;
    select o.id, o.name, o.code into v_office from adex.routes r left join adex.offices o on o.company_id = r.company_id and o.id = r.office_id
     where r.company_id = x.company and r.id = p_route;
    select timezone into v_tz from adex.companies where id = x.company;

    insert into adex.weekly_settlements (id, company_id, route_id, week_start, week_end, opening_balance_minor, capital_in_minor, collections_minor,
                                         loans_disbursed_minor, expenses_minor, transfers_in_minor, transfers_out_minor, withdrawals_minor,
                                         closing_balance_minor, created_at, status, created_by_membership_id, closed_at, closed_by_membership_id,
                                         version, office_id_at_close, office_name_at_close, office_code_at_close, capital_controller_at_close_id)
    values (v_id, x.company, p_route, p_from, p_to, (v_c ->> 'openingMinor')::bigint, (v_c ->> 'deliveriesMinor')::bigint,
            (v_c ->> 'collectionsMinor')::bigint, (v_c ->> 'disbursementsMinor')::bigint, (v_c ->> 'workerExpensesMinor')::bigint,
            (v_c ->> 'transfersInMinor')::bigint, (v_c ->> 'transfersOutMinor')::bigint,
            (v_c ->> 'partialReturnsMinor')::bigint + (v_c ->> 'settlementReturnsMinor')::bigint, (v_c ->> 'closingMinor')::bigint,
            now(), 'cerrada', x.actor, now(), x.actor, v_version, v_office.id, coalesce(v_office.name, 'Sin Oficina'), v_office.code, v_ctrl);
    update adex.weekly_settlements set superseded_by = v_id
     where company_id = x.company and route_id = p_route and week_start = p_from and week_end = p_to and id <> v_id
       and superseded_by is null and coalesce(status, 'cerrada') = 'reabierta';
    insert into adex.period_closures (id, company_id, route_id, operation_id, week_start, week_end, version, business_date, timezone, figures,
                                      ledger_operations, ledger_hash, ledger_last_seq, note, closed_at, closed_by_membership_id,
                                      closed_by_identity_id, closed_by_role, txid)
    values (v_id, x.company, p_route, p_operation_id, p_from, p_to, v_version, x.today, v_tz, v_fig,
            (v_fig #>> '{operations,count}')::int, v_fig #>> '{operations,hash}', (v_fig #>> '{operations,lastSeq}')::bigint, v_note, now(),
            x.actor, x.identity, x.role, txid_current());
    return jsonb_build_object('closureId', v_id, 'routeId', p_route, 'weekStart', p_from, 'weekEnd', p_to, 'version', v_version,
                              'businessDate', x.today, 'timezone', v_tz, 'figures', v_fig);
  exception
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'period_closures_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;

-- period_reopen: texto literal de 0016_period_reopen.sql.
create or replace function adex.period_reopen(p_operation_id uuid, p_closure text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x       adex.money_ctx;
    w       adex.weekly_settlements%rowtype;
    v_ctrl  text;
    v_reason text := btrim(coalesce(p_reason, ''));
  begin
    x := adex.money_context(p_operation_id);
    if not adex.ctx_can('settlement.reopen') then perform adex.capital_raise('42501', 'no period reopen authority'); end if;
    select * into w from adex.weekly_settlements where company_id = x.company and id = p_closure;
    if not found or not adex.ctx_route_allowed(w.route_id) then perform adex.capital_raise('AX412', 'closure not found'); end if;
    -- Mismo bloqueo que el cierre: espera a lo que esté en curso en la ruta.
    perform 1 from adex.routes where company_id = x.company and id = w.route_id for update;
    select * into w from adex.weekly_settlements where company_id = x.company and id = p_closure for update;
    v_ctrl := adex.route_valid_controller(x.company, w.route_id);
    if x.actor is distinct from v_ctrl and x.role <> 'superadmin' then
      perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin reopens a period');
    end if;
    if length(v_reason) < 10 then perform adex.capital_raise('AX803', 'reason needs at least 10 characters'); end if;
    if length(v_reason) > 300 then perform adex.capital_raise('AX411', 'reason is too long'); end if;
    if coalesce(w.status, 'cerrada') <> 'cerrada' then perform adex.capital_raise('AX806', 'only a closed period can be reopened'); end if;
    if w.superseded_by is not null then perform adex.capital_raise('AX806', 'this version was superseded'); end if;
    update adex.weekly_settlements set status = 'reabierta', reopened_at = now(), reopened_by_membership_id = x.actor, reopen_reason = v_reason
     where company_id = x.company and id = w.id;
    return jsonb_build_object('closureId', w.id, 'routeId', w.route_id, 'weekStart', w.week_start, 'weekEnd', w.week_end,
                              'version', coalesce(w.version, 1), 'status', 'reabierta');
  end $$;

-- collection_correct: texto literal de 0017_payment_corrections.sql.
create or replace function adex.collection_correct(p_operation_id uuid, p_payment text, p_new_amount bigint, p_reason text, p_note text, p_adjustment text default null)
  returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x       adex.money_ctx;
    p       adex.payments;
    v_closed boolean;
    v_op2   uuid := adex.correction_replacement_id(p_operation_id);
    r1      jsonb;
    r2      jsonb;
  begin
    x := adex.money_context(p_operation_id);
    if p_adjustment is null and not adex.ctx_can('payment.correct') then perform adex.capital_raise('42501', 'no correction authority'); end if;
    if p_adjustment is not null and not adex.ctx_can('payment.approveAdjustment') then perform adex.capital_raise('42501', 'no adjustment authority'); end if;
    if p_new_amount is null or p_new_amount <= 0 then perform adex.capital_raise('AX411', 'the corrected amount must be positive'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    select * into p from adex.payments where company_id = x.company and id = p_payment;
    if not found or not adex.ctx_route_allowed(p.route_id) then perform adex.capital_raise('AX412', 'payment not found'); end if;
    if p.state in ('reversed', 'reversal') then perform adex.capital_raise('AX405', 'payment already corrected or a reversal'); end if;
    -- Periodo cerrado: solo quien aprueba ajustes corrige directamente (CLEAN `can(payment.correct, periodClosed)`).
    v_closed := adex.capital_period_closed(x.company, p.route_id, p.payment_date);
    if v_closed and not adex.ctx_can('payment.approveAdjustment') then
      perform adex.capital_raise('AX807', 'the payment is in a closed period: request an adjustment');
    end if;
    insert into adex.correction_steps (txid, operation_id) values (txid_current(), p_operation_id), (txid_current(), v_op2);
    r1 := adex.collection_reverse(p_operation_id, p.id, btrim(p_reason));
    r2 := adex.collection_post(v_op2, p.sale_id, p_new_amount, p.collector_membership_id, coalesce(nullif(btrim(coalesce(p_note, '')), ''), p.note));
    delete from adex.correction_steps where txid = txid_current();
    update adex.payments set corrected_by_payment_id = (r2 ->> 'paymentId') where company_id = x.company and id = p.id;
    update adex.payments set correction_of_payment_id = p.id, correction_reason = btrim(p_reason), corrected_by_membership_id = x.actor, corrected_at = now()
     where company_id = x.company and id = (r2 ->> 'paymentId');
    if p_adjustment is not null then
      update adex.payment_adjustment_requests set status = 'approved', reviewed_by_membership_id = x.actor, reviewed_at = now(),
             resulting_reversal_id = (r1 ->> 'reversalPaymentId'), resulting_payment_id = (r2 ->> 'paymentId')
       where company_id = x.company and id = p_adjustment and status = 'pending' and payment_id = p.id;
      if not found then perform adex.capital_raise('AX501', 'the adjustment request is not pending'); end if;
    end if;
    return jsonb_build_object('paymentId', p.id, 'reversalPaymentId', r1 ->> 'reversalPaymentId', 'correctedPaymentId', r2 ->> 'paymentId',
      'reversalDate', r1 ->> 'reversalDate', 'correctedDate', r2 ->> 'paymentDate', 'periodClosed', v_closed,
      'appliedMinor', (r2 ->> 'appliedMinor')::bigint, 'newBalanceMinor', (r2 ->> 'newBalanceMinor')::bigint, 'saleId', p.sale_id, 'routeId', p.route_id);
  end $$;

commit;
