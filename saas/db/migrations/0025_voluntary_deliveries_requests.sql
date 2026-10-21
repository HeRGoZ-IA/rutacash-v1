-- 0025 · Ronda 59: ENTREGAS VOLUNTARIAS y SOLICITUDES DE CAPITAL.
--
-- Regla del propietario (R59): quien tiene el dinero lo entrega sin pedir autorización a quien lo
-- recibe; quien necesita dinero que tiene otra persona, se lo solicita.
--
-- A. Entregas voluntarias, con los MISMOS comandos y el mismo libro:
--    · Traspaso DIRECTO entre Administradores: se aplica al registrarlo (ADMIN_TRANSFER_HOLD +
--      ADMIN_TRANSFER_APPLY en la misma transacción; el tránsito vuelve a cero). El destino no
--      confirma: `destination_decision = 'not_required'`. El registro por SECRETARIO no cambia:
--      queda pendiente de ambos Administradores (R53). Los directos que quedaron pendientes con la
--      regla anterior se pueden seguir confirmando o rechazando: esta migración no toca datos.
--    · El Administrador devuelve capital de SU bolsa a la empresa (`ADMIN_RETURN`), sin aprobación.
--    · El Cobrador entrega efectivo de SU custodia al responsable de la ruta (`WORKER_RETURN`). Solo
--      para este caso deja de regir «nadie reduce su propia custodia» (AX410): registra quien tiene
--      el dinero, el responsable queda avisado y puede anular la entrega si no la recibió.
--      La custodia sigue sin poder bajar de su arrastre (0014) ni quedar negativa (0013).
-- B. Solicitudes (`adex.capital_requests`): NO mueven dinero. Las atiende quien tiene el capital con
--    el comando ordinario y el id de la solicitud, en la MISMA transacción:
--      capital_request_claim (bloquea, pendiente, es su titular) → comando → capital_request_fulfill
--    Una solicitud se atiende una sola vez y una operación atiende una sola solicitud.
--
--      tipo              pide         tiene (atiende)   se atiende con
--      admin_return      SuperAdmin   Administrador     ADMIN_RETURN de su bolsa
--      admin_allocation  Administrador SuperAdmin        ADMIN_ALLOCATION a quien pidió
--      admin_transfer    Administrador Administrador     traspaso directo hacia quien pidió
--      worker_return     Administrador Cobrador          WORKER_RETURN de su custodia en la ruta
--
-- No modifica datos existentes: solo restricciones, funciones y la tabla nueva.

-- ============================================================
-- A.1 Traspaso directo sin confirmación del destino
-- ============================================================
do $$
declare r record; n int := 0;
begin
  for r in select conname, pg_get_constraintdef(oid) def from pg_constraint
            where conrelid = 'adex.admin_transfers'::regclass and contype = 'c' loop
    if r.def like '%destination_decision %' or r.def like '%destination_decision)%' or r.def like '%(destination_decision%' then
      if r.def like '%''confirmed''%' or r.def like '%destination_decided_at%' then
        execute format('alter table adex.admin_transfers drop constraint %I', r.conname);
        n := n + 1;
      end if;
    end if;
  end loop;
  if n <> 3 then raise exception 'adex 0025: expected 3 destination_decision checks, found %', n; end if;
end $$;
alter table adex.admin_transfers
  add constraint admin_transfers_destination_decision_check check (destination_decision in ('pending', 'confirmed', 'rejected', 'not_required')),
  add constraint admin_transfers_destination_decided_check check ((destination_decision in ('pending', 'not_required')) = (destination_decided_at is null)),
  add constraint admin_transfers_applied_check
    check (state <> 'applied' or (origin_decision = 'confirmed' and destination_decision in ('confirmed', 'not_required'))),
  -- Sin confirmación del destino solo el traspaso directo, y ya aplicado.
  add constraint admin_transfers_not_required_check check (destination_decision <> 'not_required' or (mode = 'direct' and state = 'applied'));

create or replace function adex.admin_transfer_register(p_operation_id uuid, p_origin text, p_destination text, p_amount bigint, p_reason text)
  returns adex.admin_transfers
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.admin_transfer_ctx();
    v_actor    text := adex.ctx_membership();
    v_role     text := adex.ctx_role();
    v_identity uuid := adex.ctx_identity();
    v_mode     text;
    v_origin   text := p_origin;
    v_currency char(3);
    v_date     date;
    v_o        adex.memberships;
    v_d        adex.memberships;
    v_hold     text;
    v_apply    text;
    v_direct   boolean;
    v_row      adex.admin_transfers;
  begin
    if v_role = 'admin' then
      v_mode := 'direct';
      if v_origin is not null and v_origin <> v_actor then perform adex.capital_raise('AX402', 'an administrator only transfers from their own pool'); end if;
      v_origin := v_actor;
    elsif v_role = 'secretario' then
      v_mode := 'secretary';
      if v_origin is null then perform adex.capital_raise('AX411', 'origin administrator is required'); end if;
    else
      perform adex.capital_raise('AX402', 'role cannot register administrator transfers');
    end if;
    v_direct := v_mode = 'direct';
    if p_operation_id is null or p_destination is null then perform adex.capital_raise('AX411', 'operation id and destination are required'); end if;
    if p_amount is null or p_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    if v_origin = p_destination then perform adex.capital_raise('AX411', 'origin and destination must differ'); end if;
    if exists (select 1 from adex.admin_transfers where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    -- Partes releídas bajo bloqueo compartido (un cambio de rol o estado simultáneo espera).
    perform 1 from adex.memberships where company_id = v_company and id in (v_origin, p_destination) order by id for share;
    select * into v_o from adex.memberships where company_id = v_company and id = v_origin;
    select * into v_d from adex.memberships where company_id = v_company and id = p_destination;
    if v_o.id is null or v_o.role <> 'admin' or v_o.status <> 'activo' then perform adex.capital_raise('AX412', 'origin administrator not found or inactive'); end if;
    if v_d.id is null or v_d.role <> 'admin' or v_d.status <> 'activo' then perform adex.capital_raise('AX412', 'destination administrator not found or inactive'); end if;
    if v_o.identity_id = v_d.identity_id then perform adex.capital_raise('AX411', 'origin and destination are the same person'); end if;
    if v_mode = 'secretary' and v_identity in (v_o.identity_id, v_d.identity_id) then
      perform adex.capital_raise('AX416', 'whoever registers cannot be a party');
    end if;
    select c.currency_code, adex.business_today(c.id) into v_currency, v_date from adex.companies c where c.id = v_company;
    -- El capital sale YA del disponible de la bolsa de origen (sin sobregiro, bajo bloqueo).
    v_hold := adex.admin_transfer_post(v_company, p_operation_id, 'ADMIN_TRANSFER_HOLD', p_amount, v_currency, v_date, p_reason,
                                       v_origin, p_destination, adex.capital_account_for(v_company, 'admin', v_origin, null),
                                       adex.capital_account_for(v_company, 'transit', null, null));
    -- R59: el directo lo entrega quien tiene el capital; llega al destino en la misma transacción.
    if v_direct then
      v_apply := adex.admin_transfer_post(v_company, md5('r59-admin-transfer-apply:' || p_operation_id::text)::uuid, 'ADMIN_TRANSFER_APPLY',
                                          p_amount, v_currency, v_date, p_reason, p_destination, v_origin,
                                          adex.capital_account_for(v_company, 'transit', null, null),
                                          adex.capital_account_for(v_company, 'admin', p_destination, null));
    end if;
    insert into adex.admin_transfers (id, company_id, operation_id, mode, origin_admin_membership_id, destination_admin_membership_id, amount_minor,
                                      currency_code, reason, entry_date, state, registered_by_membership_id, registered_by_identity_id, registered_by_role,
                                      origin_decision, origin_decided_at, origin_decided_identity_id, destination_decision, hold_operation_id,
                                      settle_operation_id, closed_at, closed_by_membership_id)
    values (gen_random_uuid()::text, v_company, p_operation_id, v_mode, v_origin, p_destination, p_amount, v_currency, btrim(p_reason), v_date,
            case when v_direct then 'applied' else 'pending' end, v_actor, v_identity, v_role,
            case when v_direct then 'confirmed' else 'pending' end, case when v_direct then now() end,
            case when v_direct then v_identity end, case when v_direct then 'not_required' else 'pending' end, v_hold,
            v_apply, case when v_direct then now() end, case when v_direct then v_actor end)
    returning * into v_row;
    return v_row;
  exception
    when unique_violation then
      if sqlerrm like '%admin_transfers_operation_key%' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;

-- ============================================================
-- A.2 / A.3 Devolución del Administrador y entrega del Cobrador (mismo `capital_post`)
-- ============================================================
alter table adex.capital_operations drop constraint capital_operations_actor_role_check;
alter table adex.capital_operations add constraint capital_operations_actor_role_check
  check (actor_role in ('superadmin', 'admin', 'supervisor')
         or (actor_role = 'cobrador' and kind in ('LOAN_DISBURSEMENT', 'COLLECTION', 'WORKER_EXPENSE', 'WORKER_RETURN'))
         or (actor_role = 'secretario' and (kind in ('COLLECTION', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_RELEASE')
                                            or (kind = 'REVERSAL' and reverses_kind = 'COLLECTION'))));

-- `capital_post` de 0023 con las dos entregas voluntarias (marcadas «Ronda 59»).
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

-- Avisos por tipo de movimiento (Notificaciones, últimos 30 días).
create index capital_operations_kind on adex.capital_operations (company_id, kind, created_at);

-- ============================================================
-- B. Solicitudes de capital
-- ============================================================
create table adex.capital_requests (
  id                         adex.eid primary key,
  company_id                 adex.eid not null references adex.companies(id),
  operation_id               uuid not null,             -- id de operación de la CREACIÓN (idempotencia)
  kind                       text not null check (kind in ('admin_return', 'admin_allocation', 'admin_transfer', 'worker_return')),
  requester_membership_id    adex.eid not null,
  requester_identity_id      uuid not null references adex.identities(id),
  requester_role             text not null check (requester_role in ('superadmin', 'admin')),
  -- Quien tiene el capital. NULL solo en `admin_allocation`: la atiende cualquier SuperAdmin.
  holder_membership_id       adex.eid,
  holder_role                text not null check (holder_role in ('superadmin', 'admin', 'cobrador')),
  route_id                   adex.eid,                  -- `worker_return`: ruta de la custodia
  concept                    text check (concept in ('recaudo', 'base')),
  amount_minor               bigint not null check (amount_minor > 0),
  currency_code              char(3) not null references adex.currencies(code),
  note                       text check (note is null or (length(btrim(note)) > 0 and length(note) <= 300)),
  state                      text not null check (state in ('pending', 'fulfilled', 'rejected', 'cancelled')),
  resolved_at                timestamptz,
  resolved_by_membership_id  adex.eid,
  resolved_by_identity_id    uuid references adex.identities(id),
  resolution_reason          text check (resolution_reason is null or length(resolution_reason) <= 300),
  fulfilled_operation_id     adex.eid,                  -- capital_operations (devolución, asignación, entrega)
  fulfilled_transfer_id      adex.eid,                  -- admin_transfers (traspaso directo)
  created_at                 timestamptz not null default now(),
  unique (company_id, id),
  constraint capital_requests_operation_key unique (company_id, operation_id),
  -- Una operación atiende UNA sola solicitud.
  constraint capital_requests_fulfilled_operation_key unique (company_id, fulfilled_operation_id),
  constraint capital_requests_fulfilled_transfer_key unique (company_id, fulfilled_transfer_id),
  check ((state = 'pending') = (resolved_at is null)),
  check ((state = 'pending') = (resolved_by_membership_id is null)),
  check (state <> 'fulfilled' or ((fulfilled_operation_id is not null) <> (fulfilled_transfer_id is not null))),
  check (state = 'fulfilled' or (fulfilled_operation_id is null and fulfilled_transfer_id is null)),
  check (state not in ('rejected', 'cancelled') or length(btrim(coalesce(resolution_reason, ''))) >= 3),
  check ((kind = 'admin_allocation') = (holder_membership_id is null)),
  check ((kind = 'worker_return') = (route_id is not null)),
  check ((kind = 'worker_return') = (concept is not null)),
  check (holder_role = case kind when 'admin_allocation' then 'superadmin' when 'worker_return' then 'cobrador' else 'admin' end),
  check (requester_role = case kind when 'admin_return' then 'superadmin' else 'admin' end),
  check (holder_membership_id is distinct from requester_membership_id),
  foreign key (company_id, requester_membership_id)   references adex.memberships(company_id, id),
  foreign key (company_id, holder_membership_id)      references adex.memberships(company_id, id),
  foreign key (company_id, resolved_by_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, route_id)                  references adex.routes(company_id, id),
  foreign key (company_id, fulfilled_operation_id)    references adex.capital_operations(company_id, id),
  foreign key (company_id, fulfilled_transfer_id)     references adex.admin_transfers(company_id, id)
);
create index capital_requests_holder on adex.capital_requests (company_id, holder_membership_id, created_at);
create index capital_requests_requester on adex.capital_requests (company_id, requester_membership_id, created_at);
create index capital_requests_pending on adex.capital_requests (company_id, created_at) where state = 'pending';

-- Solo la resolución cambia, una sola vez.
create function adex.guard_capital_request() returns trigger
  language plpgsql
  as $$ begin
    if old.state <> 'pending' then raise exception 'adex: resolved capital request % is immutable', old.id using errcode = '42501'; end if;
    if (new.id, new.company_id, new.operation_id, new.kind, new.requester_membership_id, new.requester_identity_id, new.requester_role,
        new.holder_membership_id, new.holder_role, new.route_id, new.concept, new.amount_minor, new.currency_code, new.note, new.created_at)
       is distinct from
       (old.id, old.company_id, old.operation_id, old.kind, old.requester_membership_id, old.requester_identity_id, old.requester_role,
        old.holder_membership_id, old.holder_role, old.route_id, old.concept, old.amount_minor, old.currency_code, old.note, old.created_at) then
      raise exception 'adex: capital request % facts are immutable', old.id using errcode = '42501';
    end if;
    return new;
  end $$;
create trigger capital_requests_guard before update on adex.capital_requests for each row execute function adex.guard_capital_request();
create trigger capital_requests_no_delete before delete on adex.capital_requests for each row execute function adex.reject_mutation();
create trigger capital_requests_no_truncate before truncate on adex.capital_requests for each statement execute function adex.reject_mutation();

alter table adex.capital_requests enable row level security;
alter table adex.capital_requests force row level security;
create policy owner_capital_requests_all on adex.capital_requests for all to adex_owner using (true) with check (true);
-- Quien pide y quien tiene el capital; la de asignación, cualquier SuperAdmin; el SuperAdmin, todas.
create policy capital_requests_ctx on adex.capital_requests for select to adex_api
  using (company_id::text = adex.ctx_company() and (select adex.ctx_membership_active())
         and ((select adex.ctx_role()) = 'superadmin'
              or adex.ctx_membership() = requester_membership_id::text
              or adex.ctx_membership() = holder_membership_id::text));
grant select on adex.capital_requests to adex_api;

-- CREAR una solicitud (no mueve dinero).
create function adex.capital_request_create(p_operation_id uuid, p_kind text, p_holder text, p_route text, p_concept text,
                                            p_amount bigint, p_note text)
  returns adex.capital_requests
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.admin_transfer_ctx();
    v_actor    text := adex.ctx_membership();
    v_role     text := adex.ctx_role();
    v_identity uuid := adex.ctx_identity();
    v_h        adex.memberships;
    v_ctrl     text;
    v_note     text := nullif(btrim(coalesce(p_note, '')), '');
    v_row      adex.capital_requests;
  begin
    if p_operation_id is null or p_kind is null then perform adex.capital_raise('AX411', 'operation id and kind are required'); end if;
    if p_amount is null or p_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
    if v_note is not null and length(v_note) > 300 then perform adex.capital_raise('AX411', 'note is too long'); end if;
    if exists (select 1 from adex.capital_requests where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    if (p_kind = 'admin_return' and v_role <> 'superadmin') or (p_kind in ('admin_allocation', 'admin_transfer', 'worker_return') and v_role <> 'admin') then
      perform adex.capital_raise('AX402', 'role cannot create this request');
    end if;
    if p_kind not in ('admin_return', 'admin_allocation', 'admin_transfer', 'worker_return') then perform adex.capital_raise('AX411', 'unknown request kind'); end if;
    if (p_kind = 'worker_return') <> (p_route is not null) or (p_kind = 'worker_return') <> (p_concept is not null)
       or (p_kind = 'admin_allocation') <> (p_holder is null) then
      perform adex.capital_raise('AX411', 'invalid fields for this request kind');
    end if;
    if p_holder is not null then
      perform 1 from adex.memberships where company_id = v_company and id = p_holder for share;
      select * into v_h from adex.memberships where company_id = v_company and id = p_holder;
      if v_h.id is null or v_h.status <> 'activo' or v_h.role <> (case p_kind when 'worker_return' then 'cobrador' else 'admin' end) then
        perform adex.capital_raise('AX412', 'recipient of the request not found or inactive');
      end if;
      if v_h.identity_id = v_identity then perform adex.capital_raise('AX411', 'nobody requests capital from themselves'); end if;
    end if;
    if p_kind = 'worker_return' then
      if p_concept not in ('recaudo', 'base') then perform adex.capital_raise('AX411', 'invalid concept'); end if;
      select capital_controller_membership_id into v_ctrl from adex.routes where company_id = v_company and id = p_route;
      if not found then perform adex.capital_raise('AX412', 'route not found'); end if;
      -- Solo el responsable de capital de la ruta pide a su trabajador (es quien recibe la entrega).
      if v_ctrl is distinct from v_actor or not adex.route_controller_valid_internal(v_company, p_route) then
        perform adex.capital_raise('AX402', 'only the route capital controller requests cash from its workers');
      end if;
      if not exists (select 1 from adex.membership_routes where company_id = v_company and membership_id = p_holder and route_id = p_route) then
        perform adex.capital_raise('AX403', 'worker is not assigned to this route');
      end if;
    end if;
    insert into adex.capital_requests (id, company_id, operation_id, kind, requester_membership_id, requester_identity_id, requester_role,
                                       holder_membership_id, holder_role, route_id, concept, amount_minor, currency_code, note, state)
    select gen_random_uuid()::text, v_company, p_operation_id, p_kind, v_actor, v_identity, v_role, p_holder,
           case p_kind when 'admin_allocation' then 'superadmin' when 'worker_return' then 'cobrador' else 'admin' end,
           p_route, p_concept, p_amount, c.currency_code, v_note, 'pending'
      from adex.companies c where c.id = v_company
    returning * into v_row;
    return v_row;
  exception
    when unique_violation then
      if sqlerrm like '%capital_requests_operation_key%' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;

-- Solicitud del contexto BLOQUEADA y comprobada para quien la atiende (o la rechaza).
create function adex.capital_request_lock(p_request text) returns adex.capital_requests
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.admin_transfer_ctx();
    r         adex.capital_requests;
  begin
    if p_request is null then perform adex.capital_raise('AX411', 'request is required'); end if;
    select * into r from adex.capital_requests where company_id = v_company and id = p_request for update;
    if not found then perform adex.capital_raise('AX412', 'request not found'); end if;
    if not (r.holder_membership_id is not distinct from adex.ctx_membership()
            or (r.holder_membership_id is null and adex.ctx_role() = 'superadmin')) then
      if r.requester_membership_id = adex.ctx_membership() then perform adex.capital_raise('AX402', 'only whoever has the capital attends the request'); end if;
      perform adex.capital_raise('AX412', 'request not found');
    end if;
    if r.state <> 'pending' then perform adex.capital_raise('AX417', 'request is no longer pending'); end if;
    -- Revocada: quien la pidió ya no está activo.
    if not exists (select 1 from adex.memberships where company_id = v_company and id = r.requester_membership_id and status = 'activo') then
      perform adex.capital_raise('AX417', 'the requester is no longer active');
    end if;
    return r;
  end $$;

-- ATENDER: el comando ordinario ya se ejecutó en esta transacción; se enlaza y se comprueba que es la entrega pedida.
create function adex.capital_request_fulfill(p_request text, p_operation text, p_transfer text) returns adex.capital_requests
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.admin_transfer_ctx();
    v_actor   text := adex.ctx_membership();
    r         adex.capital_requests := adex.capital_request_lock(p_request);
    o         adex.capital_operations;
    t         adex.admin_transfers;
  begin
    if (p_operation is null) = (p_transfer is null) then perform adex.capital_raise('AX411', 'one operation or transfer is required'); end if;
    if p_operation is not null then
      select * into o from adex.capital_operations where company_id = v_company and id = p_operation and actor_membership_id = v_actor and txid = txid_current();
      if not found
         or (r.kind = 'admin_return' and not (o.kind = 'ADMIN_RETURN' and o.reverses_operation_id is null and o.admin_membership_id = r.holder_membership_id))
         or (r.kind = 'admin_allocation' and not (o.kind = 'ADMIN_ALLOCATION' and o.reverses_operation_id is null and o.admin_membership_id = r.requester_membership_id))
         or (r.kind = 'worker_return' and not (o.kind = 'WORKER_RETURN' and o.reverses_operation_id is null and o.worker_membership_id = r.holder_membership_id
                                                and o.route_id = r.route_id))
         or r.kind = 'admin_transfer' then
        perform adex.capital_raise('AX418', 'the operation does not match the request');
      end if;
    else
      select * into t from adex.admin_transfers where company_id = v_company and id = p_transfer and registered_by_membership_id = v_actor;
      if not found or r.kind <> 'admin_transfer' or t.mode <> 'direct' or t.state <> 'applied'
         or t.origin_admin_membership_id <> r.holder_membership_id or t.destination_admin_membership_id <> r.requester_membership_id then
        perform adex.capital_raise('AX418', 'the transfer does not match the request');
      end if;
    end if;
    update adex.capital_requests set state = 'fulfilled', resolved_at = now(), resolved_by_membership_id = v_actor,
           resolved_by_identity_id = adex.ctx_identity(), fulfilled_operation_id = p_operation, fulfilled_transfer_id = p_transfer
     where company_id = v_company and id = r.id
    returning * into r;
    return r;
  exception
    when unique_violation then perform adex.capital_raise('AX418', 'the operation already attends another request');
  end $$;

-- RECHAZAR (quien tiene el capital) o CANCELAR (quien la pidió), con motivo. No mueve dinero.
create function adex.capital_request_close(p_request text, p_action text, p_reason text) returns adex.capital_requests
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.admin_transfer_ctx();
    v_actor   text := adex.ctx_membership();
    v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
    r         adex.capital_requests;
  begin
    if p_request is null or p_action not in ('reject', 'cancel') then perform adex.capital_raise('AX411', 'invalid action'); end if;
    if v_reason is null or length(v_reason) < 3 or length(v_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    if p_action = 'reject' then
      r := adex.capital_request_lock(p_request);
    else
      select * into r from adex.capital_requests where company_id = v_company and id = p_request for update;
      if not found then perform adex.capital_raise('AX412', 'request not found'); end if;
      if r.requester_membership_id <> v_actor then
        if r.holder_membership_id is not distinct from v_actor or (r.holder_membership_id is null and adex.ctx_role() = 'superadmin') then
          perform adex.capital_raise('AX402', 'only whoever requested can cancel');
        end if;
        perform adex.capital_raise('AX412', 'request not found');
      end if;
      if r.state <> 'pending' then perform adex.capital_raise('AX417', 'request is no longer pending'); end if;
    end if;
    update adex.capital_requests set state = case p_action when 'reject' then 'rejected' else 'cancelled' end, resolved_at = now(),
           resolved_by_membership_id = v_actor, resolved_by_identity_id = adex.ctx_identity(), resolution_reason = v_reason
     where company_id = v_company and id = r.id
    returning * into r;
    return r;
  end $$;

revoke all on function adex.capital_request_create(uuid, text, text, text, text, bigint, text), adex.capital_request_lock(text),
  adex.capital_request_fulfill(text, text, text), adex.capital_request_close(text, text, text), adex.guard_capital_request() from public;
grant execute on function adex.capital_request_create(uuid, text, text, text, text, bigint, text), adex.capital_request_lock(text),
  adex.capital_request_fulfill(text, text, text), adex.capital_request_close(text, text, text) to adex_api;

-- ============================================================
-- C. Comprobación final dentro de la misma transacción
-- ============================================================
do $$ begin
  if exists (select a.company_id from adex.capital_accounts a group by a.company_id having sum(a.balance_minor) <> 0) then
    raise exception 'adex 0025: la conservación de capital no se mantiene';
  end if;
end $$;
