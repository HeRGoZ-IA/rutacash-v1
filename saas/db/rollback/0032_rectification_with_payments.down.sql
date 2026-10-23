-- REVERSIÓN de 0032 (manual, como adex_owner, en una transacción). Intervención post-R73, bloque A.
-- SOLO si todavía no hubo rectificaciones con pagos, reclasificaciones ni reaplicaciones: en ese caso se
-- detiene sin tocar nada (lo financiero registrado se corrige hacia adelante, nunca se borra).
-- Restaura literalmente las funciones de 0017 y 0030 y retira lo añadido por 0032.
-- Después: delete from adex_meta.schema_migrations where version = '0032'.
-- Generado por tmp/r74/a/build-0032-down.mjs.

begin;

set local role adex_owner;

do $$ begin
  if exists (select 1 from adex.capital_operations where kind = 'PRINCIPAL_RECLASSIFICATION')
     or exists (select 1 from adex.payments where reapplies_payment_id is not null)
     or exists (select 1 from adex.credit_rectifications where net_paid_minor <> 0 or principal_reclass_minor <> 0)
     or exists (select 1 from adex.sales where principal_reclassified_minor <> 0)
     or exists (select 1 from adex.credit_rectifications r where exists (select 1 from adex.payments p where p.company_id = r.company_id and p.sale_id = r.sale_id))
     or exists (select 1 from adex.credit_rectification_cases where blocker in ('OVERPAYMENT', 'PAYMENT_ADJUSTMENT_PENDING', 'LEGACY_PAYMENTS', 'LEDGER_INCONSISTENT')) then
    raise exception 'adex: 0032 ya tiene uso registrado (rectificaciones con pagos, reclasificaciones o reaplicaciones): no se revierte; corregir hacia adelante';
  end if;
end $$;

drop function adex.collection_reapply_check(text);
drop function adex.collection_reapply(uuid, text, text);

-- Funciones anteriores (texto literal de sus migraciones).
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

create or replace function adex.credit_rectify(
  p_operation_id   uuid,
  p_sale           text,
  p_expected_count integer,     -- rectificaciones que vio quien rectifica (concurrencia optimista)
  p_amount         bigint,
  p_rate           numeric,
  p_count          integer,
  p_frequency      text,
  p_start          date,
  p_payment_days   smallint[],
  p_schedule       jsonb,       -- [{ "number": 1, "dueDate": "YYYY-MM-DD", "amountMinor": 0 }, …] (motor de CLEAN)
  p_reason         text,
  p_evidence       text,
  p_offline_checked boolean
) returns table (rectification_id text, adjustment_id text, delta_minor bigint)
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.ctx_company();
    v_actor    text := adex.ctx_membership();
    v_role     text := adex.ctx_role();
    v_identity uuid := adex.ctx_identity();
    v_today    date;
    v_currency char(3);
    v_route    text;
    s          adex.sales;
    v_orig     adex.capital_operations;
    v_payer    text;
    v_pkind    text;
    v_powner   text;
    v_pseq     bigint;
    v_portf    text;
    v_bal      bigint;
    v_carried  bigint;
    v_total    bigint;
    v_value    bigint;
    v_end      date;
    v_n        int;
    v_sum      numeric;
    v_delta    bigint;
    v_adj      text;
    v_rect     text := gen_random_uuid()::text;
    v_before   jsonb;
    v_after    jsonb;
    i          record;
    v_cname    text;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'credits are rectified only through the company API'); end if;
    if v_role is null or v_company is null or v_identity is null or v_actor is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    -- Decisión del propietario (Ronda 73): solo el Administrador.
    if v_role <> 'admin' then perform adex.capital_raise('AX402', 'only an administrator rectifies a disbursed credit'); end if;
    if p_operation_id is null or p_sale is null then perform adex.capital_raise('AX411', 'operation id and credit are required'); end if;
    if exists (select 1 from adex.capital_operations where company_id = v_company and operation_id = p_operation_id)
       or exists (select 1 from adex.credit_rectifications where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    if p_reason is null or length(btrim(p_reason)) < 10 or length(p_reason) > 300
       or p_evidence is null or length(btrim(p_evidence)) < 10 or length(p_evidence) > 500 then
      perform adex.capital_raise('AX411', 'reason and evidence are required');
    end if;
    if p_offline_checked is distinct from true then
      perform adex.capital_raise('AX411', 'confirm there are no offline captures pending for this credit');
    end if;
    select c.currency_code, adex.business_today(c.id) into v_currency, v_today from adex.companies c where c.id = v_company;

    -- Orden de bloqueos (el de `credit_disburse` y los recaudos): ruta → crédito → cuentas.
    select route_id into v_route from adex.sales where company_id = v_company and id = p_sale;
    if not found or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'credit not found'); end if;
    perform 1 from adex.routes where company_id = v_company and id = v_route for update;
    select * into s from adex.sales where company_id = v_company and id = p_sale for update;
    if s.route_id <> v_route then perform adex.capital_raise('AX523', 'the credit changed: reload it'); end if;
    if not adex.route_operational(v_company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
    if s.rectification_count is distinct from p_expected_count then perform adex.capital_raise('AX523', 'the credit changed: reload it'); end if;
    if s.status <> 'activa' then perform adex.capital_raise('AX701', 'the credit is not active (' || s.status || ')'); end if;
    if s.disbursement_status is distinct from 'desembolsado' or s.ledger_operation_id is null then
      perform adex.capital_raise('AX703', 'the credit has no disbursement in the ledger');
    end if;
    -- Sin recaudos: ningún pago (tampoco anulado o corregido) ni cuota con abonos.
    if exists (select 1 from adex.payments p where p.company_id = v_company and p.sale_id = s.id)
       or exists (select 1 from adex.installments x where x.company_id = v_company and x.sale_id = s.id and x.paid_minor <> 0)
       or s.balance_minor <> s.total_value_minor then
      perform adex.capital_raise('AX520', 'the credit already has collections');
    end if;

    -- Desembolso original y la cuenta que pagó (pata negativa).
    select * into v_orig from adex.capital_operations where company_id = v_company and id = s.ledger_operation_id;
    if not found or v_orig.kind <> 'LOAN_DISBURSEMENT' or v_orig.sale_id is distinct from s.id then
      perform adex.capital_raise('AX703', 'the credit has no disbursement in the ledger');
    end if;
    select e.account_id, a.kind, a.membership_id, e.seq into v_payer, v_pkind, v_powner, v_pseq
      from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
     where e.company_id = v_company and e.operation_id = v_orig.id and e.amount_minor < 0;
    if v_payer is null or v_pkind not in ('custody', 'admin') then perform adex.capital_raise('AX703', 'the credit has no disbursement in the ledger'); end if;

    -- El desembolso no entró en un cuadre vigente de la custodia que pagó.
    if v_pkind = 'custody' and exists (select 1 from adex.custody_settlements cs
         where cs.company_id = v_company and cs.custody_account_id = v_payer and cs.status = 'cerrada' and cs.to_seq >= v_pseq) then
      perform adex.capital_raise('AX521', 'the disbursement is already included in a settlement');
    end if;
    -- Ningún periodo cerrado: ni el del desembolso, ni el del calendario anterior o nuevo, ni hoy.
    if adex.capital_period_closed(v_company, v_route, v_orig.entry_date) or adex.capital_period_closed(v_company, v_route, s.disbursement_date)
       or adex.capital_period_closed(v_company, v_route, s.start_date) or adex.capital_period_closed(v_company, v_route, p_start)
       or adex.capital_period_closed(v_company, v_route, v_today) then
      perform adex.capital_raise('AX407', 'the period of the route is closed');
    end if;
    -- Quien respondió del efectivo sigue pudiendo hacerlo; la bolsa solo la mueve su Administrador.
    if v_pkind = 'custody' and not adex.capital_custodian_ok(v_company, v_route, v_powner) then
      perform adex.capital_raise('AX522', 'the worker who paid no longer holds cash in this route');
    end if;
    if v_pkind = 'admin' and v_powner is distinct from v_actor then
      perform adex.capital_raise('AX402', 'only the administrator whose pool paid rectifies this credit');
    end if;

    -- Condiciones nuevas (mismas reglas que el desembolso; el inicio no antecede al desembolso).
    if p_amount is null or p_amount <= 0 or p_count is null or p_count not between 1 and 1000 or p_frequency is null
       or p_frequency not in ('diaria', 'semanal', 'quincenal', 'mensual', 'personalizada') or p_start is null
       or coalesce(cardinality(p_payment_days), 0) = 0 or p_start < coalesce(s.disbursement_date, v_orig.entry_date) then
      perform adex.capital_raise('AX503', 'invalid credit conditions');
    end if;
    if p_rate not in (10, 20) then perform adex.capital_raise('AX502', 'interest rate must be 10 or 20'); end if;
    if (p_amount, p_rate, p_count, p_frequency, p_start, p_payment_days)
       is not distinct from (s.sale_value_minor, s.interest_rate, s.installments_count, s.payment_frequency, s.start_date, s.payment_days) then
      perform adex.capital_raise('AX524', 'nothing to rectify');
    end if;
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

    v_before := jsonb_build_object('sale', to_jsonb(s), 'installments',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.number), '[]'::jsonb) from adex.installments x where x.company_id = v_company and x.sale_id = s.id));

    -- Diferencia de capital: operación nueva entre la cuenta que pagó y la cartera.
    v_delta := p_amount - s.sale_value_minor;
    if v_delta <> 0 then
      v_portf := adex.capital_account_for(v_company, 'portfolio', null, v_route);
      perform 1 from adex.capital_accounts where company_id = v_company and id in (v_payer, v_portf)
        order by array_position(array['company', 'admin', 'custody', 'portfolio', 'partner', 'external', 'income', 'expense', 'suspense', 'unidentified'], kind), id for update;
      if v_delta > 0 then
        select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = v_company and id = v_payer;
        -- D25: un faltante arrastrado es deuda, no billetes.
        if v_bal - v_carried < v_delta then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      end if;
      v_adj := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, sale_request_id, sale_id, reason, entry_date, actor_membership_id,
                                           actor_identity_id, actor_role, txid)
      values (v_adj, v_company, p_operation_id, 'DISBURSEMENT_ADJUSTMENT', abs(v_delta), v_currency, v_route, v_orig.admin_membership_id,
              v_orig.worker_membership_id, v_orig.sale_request_id, s.id, left('Rectificación de desembolso: ' || btrim(p_reason), 300),
              v_today, v_actor, v_identity, v_role, txid_current());
      update adex.capital_accounts set balance_minor = balance_minor - v_delta, version = version + 1, updated_at = now()
       where company_id = v_company and id = v_payer returning balance_minor into v_bal;
      insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor) values (v_company, v_adj, 1, v_payer, -v_delta, v_bal);
      update adex.capital_accounts set balance_minor = balance_minor + v_delta, version = version + 1, updated_at = now()
       where company_id = v_company and id = v_portf returning balance_minor into v_bal;
      insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor) values (v_company, v_adj, 2, v_portf, v_delta, v_bal);
    end if;

    -- Cuotas (sin pagos): la misma fila de cada número se actualiza y las nuevas se añaden; las
    -- condiciones anteriores quedan completas en `before_state`. Nunca se borra una cuota (0002).
    for i in select (e->>'number')::int n, (e->>'dueDate')::date d, (e->>'amountMinor')::bigint a from jsonb_array_elements(p_schedule) e loop
      update adex.installments set due_date = i.d, amount_minor = i.a, paid_minor = 0, balance_minor = i.a, status = 'pendiente', days_overdue = 0
       where company_id = v_company and sale_id = s.id and number = i.n;
      if not found then
        insert into adex.installments (id, company_id, sale_id, number, due_date, amount_minor, paid_minor, balance_minor, status, days_overdue)
        values (gen_random_uuid()::text, v_company, s.id, i.n, i.d, i.a, 0, i.a, 'pendiente', 0);
      end if;
    end loop;
    -- D73-02: las que quedan fuera del calendario vigente se SUSTITUYEN (nunca se borran).
    update adex.installments set amount_minor = 0, paid_minor = 0, balance_minor = 0, status = 'sustituida', days_overdue = 0
     where company_id = v_company and sale_id = s.id and number > p_count and status <> 'sustituida';

    -- Crédito: condiciones corregidas; fecha, hora, asiento y solicitud del desembolso intactos.
    update adex.sales set sale_value_minor = p_amount, interest_rate = p_rate, interest_value_minor = v_total - p_amount, total_value_minor = v_total,
                          balance_minor = v_total, installments_count = p_count, installment_value_minor = v_value, payment_frequency = p_frequency,
                          payment_days = p_payment_days, start_date = p_start, estimated_end_date = v_end,
                          rectification_count = rectification_count + 1, updated_at = now()
     where company_id = v_company and id = s.id returning * into s;
    v_after := jsonb_build_object('sale', to_jsonb(s), 'installments',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.number), '[]'::jsonb) from adex.installments x where x.company_id = v_company and x.sale_id = s.id));

    insert into adex.credit_rectifications (id, company_id, sale_id, route_id, operation_id, sequence_no, adjustment_operation_id, delta_minor,
                                            payer_account_id, before_state, after_state, reason, evidence, offline_checked,
                                            actor_membership_id, actor_identity_id, actor_role, business_date, txid)
    values (v_rect, v_company, s.id, v_route, p_operation_id, s.rectification_count, v_adj, v_delta, v_payer, v_before, v_after,
            btrim(p_reason), btrim(p_evidence), true, v_actor, v_identity, v_role, v_today, txid_current());
    return query select v_rect, v_adj, v_delta;
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('capital_operations_operation_key', 'credit_rectifications_company_id_operation_id_key') then
        perform adex.capital_raise('AX409', 'operation id already used');
      end if;
      if v_cname = 'credit_rectifications_company_id_sale_id_sequence_no_key' then perform adex.capital_raise('AX523', 'the credit changed: reload it'); end if;
      raise;
  end $$;

create or replace function adex.credit_rectify_check(p_sale text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    v_actor   text := adex.ctx_membership();
    v_today   date;
    s         adex.sales;
    v_orig    adex.capital_operations;
    v_payer   text; v_pkind text; v_powner text; v_pseq bigint;
    v_bal     bigint; v_carried bigint;
    v_blockers text[] := array[]::text[];
  begin
    if adex.ctx_role() is distinct from 'admin' then perform adex.capital_raise('AX402', 'only an administrator rectifies a disbursed credit'); end if;
    select * into s from adex.sales where company_id = v_company and id = p_sale;
    if not found or not adex.ctx_route_allowed(s.route_id) then perform adex.capital_raise('AX412', 'credit not found'); end if;
    v_today := adex.business_today(v_company);
    if s.status <> 'activa' then v_blockers := array_append(v_blockers, 'CREDIT_NOT_ACTIVE'); end if;
    if exists (select 1 from adex.payments p where p.company_id = v_company and p.sale_id = s.id)
       or exists (select 1 from adex.installments x where x.company_id = v_company and x.sale_id = s.id and x.paid_minor <> 0) then
      v_blockers := array_append(v_blockers, 'CREDIT_HAS_COLLECTIONS');
    end if;
    select * into v_orig from adex.capital_operations where company_id = v_company and id = s.ledger_operation_id;
    if found then
      select e.account_id, a.kind, a.membership_id, e.seq into v_payer, v_pkind, v_powner, v_pseq
        from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
       where e.company_id = v_company and e.operation_id = v_orig.id and e.amount_minor < 0;
      if v_pkind = 'custody' and exists (select 1 from adex.custody_settlements cs where cs.company_id = v_company and cs.custody_account_id = v_payer
                                           and cs.status = 'cerrada' and cs.to_seq >= v_pseq) then
        v_blockers := array_append(v_blockers, 'DISBURSEMENT_SETTLED');
      end if;
      if adex.capital_period_closed(v_company, s.route_id, v_orig.entry_date) or adex.capital_period_closed(v_company, s.route_id, s.disbursement_date)
         or adex.capital_period_closed(v_company, s.route_id, s.start_date) or adex.capital_period_closed(v_company, s.route_id, v_today) then
        v_blockers := array_append(v_blockers, 'PERIOD_CLOSED');
      end if;
      if v_pkind = 'custody' and not adex.capital_custodian_ok(v_company, s.route_id, v_powner) then v_blockers := array_append(v_blockers, 'CUSTODIAN_CHANGED'); end if;
      if v_pkind = 'admin' and v_powner is distinct from v_actor then v_blockers := array_append(v_blockers, 'POOL_OF_ANOTHER_ADMIN'); end if;
      select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = v_company and id = v_payer;
    else
      v_blockers := array_append(v_blockers, 'CREDIT_NOT_LEDGERED');
    end if;
    return jsonb_build_object('blockers', to_jsonb(v_blockers), 'payerKind', v_pkind,
      -- Lo que se puede subir el capital sin sobregirar la cuenta que pagó (sin faltante arrastrado, D25).
      'maxIncreaseMinor', greatest(coalesce(v_bal, 0) - coalesce(v_carried, 0), 0), 'rectificationCount', s.rectification_count);
  end $$;

create or replace function adex.route_period_figures(p_company text, p_route text, p_from date, p_to date) returns jsonb
  language plpgsql stable
  as $$
  declare
    v_workers jsonb;
    v_custody jsonb;
    v_pool    jsonb;
    v_credit  jsonb;
    v_setl    jsonb;
    v_ops     jsonb;
  begin
    with legs as (
      select e.amount_minor amt, a.membership_id mid, o.entry_date d, coalesce(o.reverses_kind, o.kind) b
        from adex.capital_entries e
        join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
        join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
       where e.company_id = p_company and a.kind = 'custody' and a.route_id = p_route and o.entry_date <= p_to
    ), w as (
      select mid,
             coalesce(sum(amt) filter (where d < p_from), 0)::bigint opening,
             coalesce(sum(amt) filter (where d >= p_from and b = 'WORKER_DELIVERY'), 0)::bigint deliveries,
             coalesce(sum(amt) filter (where d >= p_from and b in ('WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and amt > 0), 0)::bigint t_in,
             coalesce(-sum(amt) filter (where d >= p_from and b in ('WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and amt < 0), 0)::bigint t_out,
             coalesce(-sum(amt) filter (where d >= p_from and b = 'WORKER_RETURN'), 0)::bigint partial_returns,
             coalesce(-sum(amt) filter (where d >= p_from and b = 'SETTLEMENT_RETURN'), 0)::bigint settlement_returns,
             coalesce(sum(amt) filter (where d >= p_from and b = 'COLLECTION'), 0)::bigint collections,
             coalesce(-sum(amt) filter (where d >= p_from and b in ('LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT')), 0)::bigint disbursements,
             coalesce(-sum(amt) filter (where d >= p_from and b = 'WORKER_EXPENSE'), 0)::bigint expenses,
             coalesce(sum(amt) filter (where d >= p_from and b not in ('WORKER_DELIVERY', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'WORKER_RETURN',
                                                                     'SETTLEMENT_RETURN', 'COLLECTION', 'LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT', 'WORKER_EXPENSE')), 0)::bigint other,
             coalesce(sum(amt), 0)::bigint closing
        from legs group by mid
    )
    select coalesce(jsonb_agg(jsonb_build_object('workerId', w.mid, 'name', m.display_name, 'role', m.role,
             'openingMinor', w.opening, 'deliveriesMinor', w.deliveries, 'transfersInMinor', w.t_in, 'transfersOutMinor', w.t_out,
             'partialReturnsMinor', w.partial_returns, 'settlementReturnsMinor', w.settlement_returns, 'collectionsMinor', w.collections,
             'disbursementsMinor', w.disbursements, 'workerExpensesMinor', w.expenses, 'otherMinor', w.other, 'closingMinor', w.closing)
             order by m.display_name, w.mid), '[]'::jsonb),
           jsonb_build_object('openingMinor', coalesce(sum(w.opening), 0), 'deliveriesMinor', coalesce(sum(w.deliveries), 0),
             'transfersInMinor', coalesce(sum(w.t_in), 0), 'transfersOutMinor', coalesce(sum(w.t_out), 0),
             'partialReturnsMinor', coalesce(sum(w.partial_returns), 0), 'settlementReturnsMinor', coalesce(sum(w.settlement_returns), 0),
             'collectionsMinor', coalesce(sum(w.collections), 0), 'disbursementsMinor', coalesce(sum(w.disbursements), 0),
             'workerExpensesMinor', coalesce(sum(w.expenses), 0), 'otherMinor', coalesce(sum(w.other), 0), 'closingMinor', coalesce(sum(w.closing), 0))
      into v_workers, v_custody
      from w join adex.memberships m on m.company_id = p_company and m.id = w.mid;

    -- Lado de la bolsa, cartera, interés, gastos y control, de lo atribuido a la ruta.
    with legs as (
      select e.amount_minor amt, a.kind ak, coalesce(o.reverses_kind, o.kind) b
        from adex.capital_entries e
        join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
        join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
       where e.company_id = p_company and o.entry_date between p_from and p_to
         and ((a.kind = 'admin' and o.route_id = p_route and o.to_route_id is null)
              or (a.kind in ('portfolio', 'income', 'expense', 'suspense') and a.route_id = p_route))
    )
    select jsonb_build_object(
             'collectionsReceivedMinor', coalesce(sum(amt) filter (where ak = 'admin' and b = 'COLLECTION'), 0),
             'deliveredToWorkersMinor', coalesce(-sum(amt) filter (where ak = 'admin' and b = 'WORKER_DELIVERY'), 0),
             'returnsReceivedMinor', coalesce(sum(amt) filter (where ak = 'admin' and b in ('WORKER_RETURN', 'SETTLEMENT_RETURN')), 0),
             'routeExpensesMinor', coalesce(-sum(amt) filter (where ak = 'admin' and b = 'ROUTE_EXPENSE'), 0),
             'disbursedFromPoolMinor', coalesce(-sum(amt) filter (where ak = 'admin' and b in ('LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT')), 0),
             'partnerContributionsMinor', coalesce(sum(amt) filter (where ak = 'admin' and b = 'PARTNER_CONTRIBUTION'), 0),
             'surplusHeldMinor', coalesce(sum(amt) filter (where ak = 'suspense'), 0)),
           jsonb_build_object(
             'principalDisbursedMinor', coalesce(sum(amt) filter (where ak = 'portfolio' and b in ('LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT')), 0),
             'principalCollectedMinor', coalesce(-sum(amt) filter (where ak = 'portfolio' and b = 'COLLECTION'), 0),
             'interestCollectedMinor', coalesce(-sum(amt) filter (where ak = 'income'), 0),
             'expensesMinor', coalesce(sum(amt) filter (where ak = 'expense'), 0))
      into v_pool, v_credit from legs;

    select jsonb_build_object('count', count(*), 'deliveredMinor', coalesce(sum(delivered_minor), 0),
             'returnedToPoolMinor', coalesce(sum(returned_to_pool_minor), 0), 'shortageMinor', coalesce(sum(shortage_minor), 0),
             'surplusMinor', coalesce(sum(surplus_minor), 0),
             'items', coalesce(jsonb_agg(jsonb_build_object('id', id, 'workerId', worker_membership_id, 'version', version, 'status', status,
                        'businessDate', business_date, 'expectedPositionMinor', expected_position_minor, 'deliveredMinor', delivered_minor,
                        'shortageMinor', shortage_minor, 'surplusMinor', surplus_minor) order by closed_at, id), '[]'::jsonb))
      into v_setl
      from adex.custody_settlements where company_id = p_company and route_id = p_route and business_date between p_from and p_to;

    select jsonb_build_object('count', count(*), 'lastSeq', coalesce(max(last_seq), 0),
             'hash', encode(sha256(convert_to(coalesce(string_agg(id, ',' order by id), ''), 'UTF8')), 'hex'))
      into v_ops
      from (select o.id, max(e.seq) last_seq
              from adex.capital_operations o join adex.capital_entries e on e.company_id = o.company_id and e.operation_id = o.id
              join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
             where o.company_id = p_company and o.entry_date between p_from and p_to
               and (o.route_id = p_route or o.to_route_id = p_route or a.route_id = p_route)
             group by o.id) q;

    return jsonb_build_object('routeId', p_route, 'from', p_from, 'to', p_to, 'custody', v_custody, 'workers', v_workers,
                              'pool', v_pool, 'credit', v_credit, 'settlements', v_setl, 'operations', v_ops);
  end $$;

drop function adex.derived_operation_id(uuid, text);

alter policy capital_operations_ctx on adex.capital_operations
  using ((((company_id)::text = adex.ctx_company()) AND ( SELECT adex.ctx_membership_active() AS ctx_membership_active) AND ((( SELECT adex.ctx_role() AS ctx_role) = 'superadmin'::text) OR ((admin_membership_id)::text = adex.ctx_membership()) OR ((COALESCE(reverses_kind, kind) = ANY (ARRAY['WORKER_DELIVERY'::text, 'WORKER_RETURN'::text, 'WORKER_TRANSFER'::text, 'ROUTE_REASSIGNMENT'::text, 'LOAN_DISBURSEMENT'::text, 'COLLECTION'::text, 'WORKER_EXPENSE'::text, 'ROUTE_EXPENSE'::text, 'SETTLEMENT_RETURN'::text, 'SETTLEMENT_SURPLUS'::text, 'DISBURSEMENT_ADJUSTMENT'::text])) AND ((adex.ctx_membership() = (worker_membership_id)::text) OR (adex.ctx_membership() = (counterpart_membership_id)::text) OR (( SELECT adex.ctx_is(ARRAY['admin'::text, 'supervisor'::text]) AS ctx_is) AND (adex.route_in_scope((route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)) OR adex.route_in_scope((to_route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)))))))));

alter table adex.credit_rectification_cases drop constraint credit_rectification_cases_blocker_check;
alter table adex.credit_rectification_cases add constraint credit_rectification_cases_blocker_check
  check (blocker in ('INSUFFICIENT_FUNDS', 'CUSTODIAN_CHANGED', 'DISBURSEMENT_SETTLED', 'PERIOD_CLOSED', 'OFFLINE_PENDING',
                     'CREDIT_HAS_COLLECTIONS', 'POOL_OF_ANOTHER_ADMIN'));

alter table adex.credit_rectifications drop constraint credit_rectifications_reclass_fk;
alter table adex.credit_rectifications drop constraint credit_rectifications_reclass_shape;
alter table adex.credit_rectifications drop column reclass_operation_id, drop column principal_reclass_minor, drop column net_paid_minor;

alter table adex.payments drop constraint payments_reapply_shape;
drop index adex.payments_one_reapplication;
alter table adex.payments drop constraint payments_reapplies_fk;
alter table adex.payments drop column reapplies_payment_id;

alter table adex.sales drop column principal_reclassified_minor;

alter table adex.capital_operations drop constraint capital_operations_sale_shape;
alter table adex.capital_operations add constraint capital_operations_sale_shape
  check ((coalesce(reverses_kind, kind) in ('LOAN_DISBURSEMENT', 'COLLECTION', 'DISBURSEMENT_ADJUSTMENT')) = (sale_id is not null));
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
  'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT',
  'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE', 'EXPENSE_REFUND',
  'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE',
  'DISBURSEMENT_ADJUSTMENT'));

commit;
