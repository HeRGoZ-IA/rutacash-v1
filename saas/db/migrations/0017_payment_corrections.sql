-- ============================================================
-- 0017 · Corrección de pagos y solicitudes de ajuste (CLEAN `paymentCorrectionService`)
-- ============================================================
-- CLEAN corrige un abono con REVERSIÓN + REEMPLAZO en una sola transacción
-- (`correctPayment`): el original queda «reversed», nace su asiento espejo y un pago nuevo
-- por el valor correcto, a nombre del MISMO responsable del efectivo, y el crédito se
-- recalcula. En periodo cerrado quien no aprueba ajustes (Secretario) crea una SOLICITUD
-- (`requestPaymentAdjustment`) que aprueba un Administrador de la ruta o el SuperAdmin.
--
-- El motor no se duplica: `adex.collection_correct` llama a `collection_reverse` y a
-- `collection_post` (0013) dentro de la MISMA transacción. Para que el Secretario
-- (`payment.correct`, sin `payment.reverse` ni `payment.register`) pueda ejecutar esos dos
-- pasos, la corrección registra un permiso de UN SOLO USO por operación en una tabla que
-- solo escribe el propietario (`adex.correction_steps`); los dos motores lo aceptan en
-- lugar de su capacidad. Sus cuerpos son los de 0013 sin otro cambio.
--
-- Fechas (DS-04, D7): la reversión va a la fecha del original si su semana está abierta y
-- a hoy si está cerrada (regla de 0013); el pago corregido, como todo asiento del servidor,
-- va a HOY. CLEAN permitía elegir otra fecha: el servidor no fecha asientos en el pasado.

create table adex.correction_steps (
  txid         bigint not null,
  operation_id uuid   not null,
  primary key (txid, operation_id)
);
alter table adex.correction_steps enable row level security;
alter table adex.correction_steps force row level security;
create policy owner_correction_steps on adex.correction_steps for all to adex_owner using (true) with check (true);
revoke all on adex.correction_steps from public;

-- ¿Es `p_operation_id` un paso autorizado de la corrección EN CURSO en esta transacción?
create function adex.correction_step(p_operation_id uuid) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select exists (select 1 from adex.correction_steps where txid = txid_current() and operation_id = p_operation_id) $$;
revoke all on function adex.correction_step(uuid) from public;

-- Segunda barrera: `payment.correct` de CLEAN (SuperAdmin, Administrador, Secretario). Resto igual que 0014.
create or replace function adex.ctx_can(p_capability text) returns boolean
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
      when 'payment.register'                 then array['superadmin', 'admin', 'supervisor', 'cobrador']
      when 'payment.reverse'                  then array['superadmin', 'admin']
      when 'payment.approveAdjustment'        then array['superadmin', 'admin']
      when 'payment.correct'                  then array['superadmin', 'admin', 'secretario']
      when 'payment.viewHistory'              then array['superadmin', 'admin', 'socio', 'supervisor', 'cobrador', 'secretario']
      when 'expense.register'                 then array['superadmin', 'admin', 'supervisor', 'cobrador']
      when 'expense.correct'                  then array['superadmin', 'admin']
      when 'cashCustody.manage'               then array['superadmin', 'admin', 'supervisor']
      when 'cashbox.viewConsolidated'         then array['superadmin', 'admin']
      when 'cashbox.viewRoute'                then array['superadmin', 'admin', 'socio', 'supervisor']
      when 'cashSettlement.view'              then array['superadmin', 'admin', 'supervisor']
      when 'cashSettlement.viewOwn'           then array['supervisor', 'cobrador']
      when 'cashSettlement.close'             then array['superadmin', 'admin', 'supervisor']
      when 'cashSettlement.reopen'            then array['superadmin', 'admin']
      when 'settlement.close'                 then array['superadmin', 'admin']
      when 'settlement.reopen'                then array['superadmin', 'admin']
      else array[]::text[] end), false)
  $$;

create or replace function adex.collection_reverse(p_operation_id uuid, p_payment text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x          adex.money_ctx;
    p          adex.payments;
    o          adex.capital_operations;
    s          adex.sales;
    v_route    text;
    v_closed   boolean;
    v_date     date;
    v_receiver text;
    v_rkind    text;
    v_rmember  text;
    v_bal      bigint;
    v_carried  bigint;
    v_paid     bigint;
    v_known    bigint;
    v_principal bigint;
    v_interest bigint;
    v_portf    text;
    v_income   text;
    v_new      bigint;
    v_rev      text := gen_random_uuid()::text;
    v_op       text := gen_random_uuid()::text;
    v_cname    text;
  begin
    x := adex.money_context(p_operation_id);
    if not (adex.ctx_can('payment.reverse') or adex.correction_step(p_operation_id)) then perform adex.capital_raise('42501', 'no reversal authority'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    select route_id into v_route from adex.payments where company_id = x.company and id = p_payment;
    if not found or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'payment not found'); end if;

    -- Bloqueos: ruta (compartido) → crédito → pago → cuentas.
    perform 1 from adex.routes where company_id = x.company and id = v_route for share;
    select * into p from adex.payments where company_id = x.company and id = p_payment;
    select * into s from adex.sales where company_id = x.company and id = p.sale_id for update;
    select * into p from adex.payments where company_id = x.company and id = p_payment for update;
    if p.state = 'reversal' then perform adex.capital_raise('AX404', 'a reversal cannot be reversed'); end if;
    if p.state = 'reversed' then perform adex.capital_raise('AX405', 'payment already reversed'); end if;
    if p.ledger_operation_id is null then perform adex.capital_raise('AX706', 'payment without ledger entry is not corrected here'); end if;
    select * into o from adex.capital_operations where company_id = x.company and id = p.ledger_operation_id;

    -- D7 (6C.1): fecha del original si su semana sigue abierta; si no, hoy (con autoridad
    -- de ajuste); el asiento del libro va hoy y hoy debe estar abierto.
    v_closed := adex.capital_period_closed(x.company, v_route, p.payment_date);
    if v_closed and not adex.ctx_can('payment.approveAdjustment') then perform adex.capital_raise('42501', 'closed period needs adjustment authority'); end if;
    if adex.capital_period_closed(x.company, v_route, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
    v_date := case when v_closed then x.today else p.payment_date end;

    -- Quien recibió el dinero debe conservarlo (nunca se devuelve dinero ya usado).
    select e.account_id, a.kind, a.membership_id into v_receiver, v_rkind, v_rmember
      from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
     where e.company_id = x.company and e.operation_id = o.id and e.amount_minor > 0 and a.kind in ('custody', 'admin');
    if v_rkind = 'custody' and adex.same_person(x.company, x.actor, v_rmember) then
      perform adex.capital_raise('AX410', 'nobody reduces their own custody');
    end if;
    v_portf := adex.capital_account_for(x.company, 'portfolio', null, v_route);
    v_income := adex.capital_account_for(x.company, 'income', null, v_route);
    perform adex.capital_lock_accounts(x.company, array[v_receiver, v_portf, v_income]);
    select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = x.company and id = v_receiver;
    if v_bal - v_carried < p.amount_minor then perform adex.capital_raise('AX413', 'the cash was already used'); end if;

    select coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0) into v_paid, v_known
      from adex.payments where company_id = x.company and sale_id = p.sale_id;
    v_principal := adex.credit_principal_of(v_paid - p.amount_minor, s.sale_value_minor, s.total_value_minor) - v_known;
    v_interest := -p.amount_minor - v_principal;
    if v_principal > 0 or v_interest > 0 then perform adex.capital_raise('AX420', 'inconsistent principal recognition'); end if;

    insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, created_by_membership_id, amount_minor,
                               payment_date, payment_type, note, sync_status, created_at, state, reverses_payment_id, correction_reason,
                               corrected_by_membership_id, corrected_at, ledger_operation_id, principal_minor, interest_minor)
    values (v_rev, x.company, p.sale_id, p.client_id, v_route, p.collector_membership_id, x.actor, -p.amount_minor, v_date, p.payment_type,
            'Anulación del pago ' || p.id, 'synced', now(), 'reversal', p.id, btrim(p_reason), x.actor, now(), v_op, v_principal, v_interest);
    update adex.payments set state = 'reversed', reversal_payment_id = v_rev, correction_reason = btrim(p_reason),
                             corrected_by_membership_id = x.actor, corrected_at = now()
     where company_id = x.company and id = p.id;
    v_new := adex.credit_recompute(x.company, p.sale_id, x.today, v_date);
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, sale_id, payment_id, reverses_operation_id, reverses_kind, reason, entry_date,
                                         actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_op, x.company, p_operation_id, 'REVERSAL', p.amount_minor, x.currency, v_route, o.admin_membership_id, o.worker_membership_id,
            p.sale_id, v_rev, o.id, 'COLLECTION', btrim(p_reason), x.today, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_receiver, v_portf, v_income], array[-p.amount_minor, -v_principal, -v_interest]);

    return jsonb_build_object('reversalPaymentId', v_rev, 'operationId', v_op, 'paymentId', p.id, 'saleId', p.sale_id, 'routeId', v_route,
      'amountMinor', p.amount_minor, 'reversalDate', v_date, 'periodClosed', v_closed, 'newBalanceMinor', v_new);
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX413', 'the cash was already used'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname in ('capital_operations_reversal_key', 'payments_company_id_reverses_payment_id_key') then perform adex.capital_raise('AX405', 'payment already reversed'); end if;
      raise;
  end $$;

create or replace function adex.collection_post(p_operation_id uuid, p_sale text, p_amount bigint, p_collector text, p_note text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x          adex.money_ctx;
    s          adex.sales;
    v_route    text;
    v_ctrl     text;
    v_n        int;
    v_balance  bigint;
    v_applied  bigint;
    v_paid     bigint;
    v_known    bigint;
    v_principal bigint;
    v_interest bigint;
    v_receiver text;
    v_kind     text;
    v_portf    text;
    v_income   text;
    v_new      bigint;
    v_payment  text := gen_random_uuid()::text;
    v_op       text := gen_random_uuid()::text;
    v_cname    text;
  begin
    x := adex.money_context(p_operation_id);
    if not (adex.ctx_can('payment.register') or adex.correction_step(p_operation_id)) then perform adex.capital_raise('42501', 'no collection authority'); end if;
    if p_sale is null or p_collector is null or p_amount is null or p_amount <= 0 then
      perform adex.capital_raise('AX411', 'sale, collector and a positive amount are required');
    end if;
    if p_note is not null and length(p_note) > 500 then perform adex.capital_raise('AX411', 'note is too long'); end if;
    select route_id into v_route from adex.sales where company_id = x.company and id = p_sale;
    if not found or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'credit not found'); end if;

    -- Bloqueos: ruta (compartido) → crédito.
    perform 1 from adex.routes where company_id = x.company and id = v_route for share;
    select * into s from adex.sales where company_id = x.company and id = p_sale for update;
    if not adex.route_operational(x.company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
    if adex.capital_period_closed(x.company, v_route, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
    if s.status <> 'activa' then perform adex.capital_raise('AX701', 'the credit does not accept payments (' || s.status || ')'); end if;
    if s.disbursement_status = 'pendiente' then perform adex.capital_raise('AX702', 'the credit is not disbursed'); end if;
    if s.ledger_operation_id is null then perform adex.capital_raise('AX703', 'the credit has no ledger disbursement'); end if;
    select count(*), coalesce(sum(balance_minor), 0) into v_n, v_balance from adex.installments where company_id = x.company and sale_id = p_sale;
    if v_n = 0 then perform adex.capital_raise('AX704', 'the credit has no installments'); end if;
    if v_balance <= 0 then perform adex.capital_raise('AX705', 'the credit has no balance'); end if;

    -- Responsable del efectivo (`resolveResponsibleCollector`, revalidado bajo bloqueo).
    v_ctrl := adex.route_valid_controller(x.company, v_route);
    if x.role in ('cobrador', 'supervisor') then
      if p_collector is distinct from x.actor then perform adex.capital_raise('AX708', 'your collections are your responsibility'); end if;
      if not adex.capital_custodian_ok(x.company, v_route, x.actor) then perform adex.capital_raise('AX708', 'you cannot hold cash in this route'); end if;
      v_kind := 'custody';
    elsif p_collector = x.actor then
      -- Actor administrativo sin caja personal: solo en una ruta sin Cobrador activo.
      if exists (select 1 from adex.memberships m join adex.membership_routes mr on mr.company_id = m.company_id and mr.membership_id = m.id
                  where m.company_id = x.company and mr.route_id = v_route and m.role = 'cobrador' and m.status = 'activo') then
        perform adex.capital_raise('AX707', 'indicate who received the cash');
      end if;
      if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
      v_kind := 'admin';
    elsif adex.correction_step(p_operation_id)
          and (select m.role from adex.memberships m where m.company_id = x.company and m.id = p_collector) not in ('cobrador', 'supervisor') then
      -- Corrección (0017) de un cobro que entró a la BOLSA: el reemplazo vuelve a la bolsa del responsable.
      if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
      v_kind := 'admin';
    else
      if not adex.capital_custodian_ok(x.company, v_route, p_collector) then perform adex.capital_raise('AX708', 'the collector cannot hold cash in this route'); end if;
      v_kind := 'custody';
    end if;
    v_receiver := case v_kind when 'custody' then adex.capital_account_for(x.company, 'custody', p_collector, v_route)
                              else adex.capital_account_for(x.company, 'admin', v_ctrl, null) end;

    -- Tope al saldo y reparto capital / interés.
    v_applied := least(p_amount, v_balance);
    select coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0) into v_paid, v_known
      from adex.payments where company_id = x.company and sale_id = p_sale;
    v_principal := adex.credit_principal_of(v_paid + v_applied, s.sale_value_minor, s.total_value_minor) - v_known;
    v_interest := v_applied - v_principal;
    if v_principal < 0 or v_interest < 0 then perform adex.capital_raise('AX420', 'inconsistent principal recognition'); end if;

    v_portf := adex.capital_account_for(x.company, 'portfolio', null, v_route);
    v_income := adex.capital_account_for(x.company, 'income', null, v_route);
    perform adex.capital_lock_accounts(x.company, array[v_receiver, v_portf, v_income]);

    insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, created_by_membership_id, amount_minor,
                               payment_date, payment_type, note, sync_status, created_at, state, ledger_operation_id, principal_minor, interest_minor)
    values (v_payment, x.company, p_sale, s.client_id, v_route, p_collector, x.actor, v_applied, x.today, 'efectivo', nullif(btrim(p_note), ''),
            'synced', now(), 'active', v_op, v_principal, v_interest);
    v_new := adex.credit_recompute(x.company, p_sale, x.today, x.today);
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, sale_id, payment_id, reason, entry_date, actor_membership_id, actor_identity_id,
                                         actor_role, txid)
    values (v_op, x.company, p_operation_id, 'COLLECTION', v_applied, x.currency, v_route, case when v_kind = 'admin' then v_ctrl end,
            case when v_kind = 'custody' then p_collector end, p_sale, v_payment, 'Recaudo de cuota', x.today, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_receiver, v_portf, v_income], array[v_applied, -v_principal, -v_interest]);

    return jsonb_build_object('paymentId', v_payment, 'operationId', v_op, 'saleId', p_sale, 'routeId', v_route,
      'collectorId', p_collector, 'receiver', v_kind, 'requestedMinor', p_amount, 'appliedMinor', v_applied, 'capped', v_applied < p_amount,
      'previousBalanceMinor', v_balance, 'newBalanceMinor', v_new, 'principalMinor', v_principal, 'interestMinor', v_interest,
      'paymentDate', x.today);
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

-- El Secretario corrige (CLEAN `payment.correct`): firma la reversión de un cobro y su
-- reemplazo, y nada más. Que sea una corrección lo garantiza `collection_correct` (único
-- camino con su capacidad); esta restricción acota los tipos de asiento que puede firmar.
alter table adex.capital_operations drop constraint capital_operations_actor_role_check;
alter table adex.capital_operations add constraint capital_operations_actor_role_check
  check (actor_role in ('superadmin', 'admin', 'supervisor')
         or (actor_role = 'cobrador' and kind in ('LOAN_DISBURSEMENT', 'COLLECTION', 'WORKER_EXPENSE'))
         or (actor_role = 'secretario' and (kind = 'COLLECTION' or (kind = 'REVERSAL' and reverses_kind = 'COLLECTION'))));

-- ¿La fecha de un pago VISIBLE cae en una semana cerrada de su ruta? Decide en pantalla si
-- se corrige directamente o se pide un ajuste (CLEAN `isPaymentInClosedPeriod`). Solo
-- responde sobre pagos de la empresa y las rutas del contexto (el Secretario no lee cierres).
create function adex.payment_in_closed_period(p_payment text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select adex.capital_period_closed(p.company_id, p.route_id, p.payment_date)
          from adex.payments p where p.company_id = adex.ctx_company() and p.id = p_payment and adex.ctx_route_allowed(p.route_id) $$;
revoke all on function adex.payment_in_closed_period(text) from public;
grant execute on function adex.payment_in_closed_period(text) to adex_api;

-- Id determinista del pago de reemplazo a partir del id de la corrección (un reintento
-- con el mismo id produce los mismos dos asientos o ninguno).
create function adex.correction_replacement_id(p_operation_id uuid) returns uuid
  language sql immutable
  as $$ select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-a' || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
          from (select md5(p_operation_id::text || ':replacement') h) q $$;

create function adex.collection_correct(p_operation_id uuid, p_payment text, p_new_amount bigint, p_reason text, p_note text, p_adjustment text default null)
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
revoke all on function adex.collection_correct(uuid, text, bigint, text, text, text) from public;
grant execute on function adex.collection_correct(uuid, text, bigint, text, text, text) to adex_api;

-- ---------- Solicitudes de ajuste (periodo cerrado) ----------
-- Alta: quien tiene `payment.correct` en la ruta, sobre un pago vigente, una sola pendiente
-- por pago. Resolución: aprobar = `collection_correct` (arriba, con `payment.approveAdjustment`);
-- rechazar = estado y motivo. La API solo inserta y rechaza; nada más se reescribe.
create unique index payment_adjustment_one_pending on adex.payment_adjustment_requests (company_id, payment_id) where status = 'pending';

create function adex.payment_adjustment_guard() returns trigger
  language plpgsql
  as $$
  begin
    if tg_op = 'INSERT' then
      if current_user = 'adex_api' and not exists (select 1 from adex.payments p where p.company_id = new.company_id and p.id = new.payment_id
            and p.route_id = new.route_id and p.sale_id = new.sale_id and p.client_id = new.client_id and coalesce(p.state, 'active') = 'active'
            and p.amount_minor = new.original_amount_minor and p.payment_date = new.original_date) then
        raise exception 'adex: the adjustment must describe an active payment exactly' using errcode = 'AX411';
      end if;
      return new;
    end if;
    if old.status <> 'pending' then raise exception 'adex: adjustment % is already resolved', old.id using errcode = 'AX501'; end if;
    if (to_jsonb(new) - array['status', 'reviewed_by_membership_id', 'reviewed_at', 'rejection_reason', 'resulting_reversal_id', 'resulting_payment_id'])
       is distinct from (to_jsonb(old) - array['status', 'reviewed_by_membership_id', 'reviewed_at', 'rejection_reason', 'resulting_reversal_id', 'resulting_payment_id']) then
      raise exception 'adex: adjustment % facts are immutable', old.id using errcode = '42501';
    end if;
    return new;
  end $$;
create trigger payment_adjustment_guard before insert or update on adex.payment_adjustment_requests
  for each row execute function adex.payment_adjustment_guard();

create policy payment_adjustment_insert on adex.payment_adjustment_requests for insert to adex_api
  with check (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id) and adex.ctx_can('payment.correct')
              and requested_by_membership_id = adex.ctx_membership() and requested_by_role = adex.ctx_role() and status = 'pending'
              and reviewed_by_membership_id is null and resulting_payment_id is null and resulting_reversal_id is null);
create policy payment_adjustment_reject on adex.payment_adjustment_requests for update to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id) and adex.ctx_can('payment.approveAdjustment') and status = 'pending')
  with check (company_id = adex.ctx_company() and status = 'rejected' and reviewed_by_membership_id = adex.ctx_membership());
create policy owner_payment_adjustment_update on adex.payment_adjustment_requests for update to adex_owner using (true) with check (true);

grant insert (id, company_id, route_id, payment_id, client_id, sale_id, requested_by_membership_id, requested_by_role, requested_at,
              original_amount_minor, original_date, reason, new_amount_minor, new_date, note, status) on adex.payment_adjustment_requests to adex_api;
grant update (status, reviewed_by_membership_id, reviewed_at, rejection_reason) on adex.payment_adjustment_requests to adex_api;
