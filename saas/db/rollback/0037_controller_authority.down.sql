-- REVERSIÓN de 0037 (manual, como adex_owner, en una transacción). R74, regla definitiva del responsable de capital.
-- Se NIEGA si existe cualquier dato que solo 0037 sabe explicar: propuestas de anulación coordinada, reembolsos
-- enlazados a una obligación concreta o anulaciones de retiros de Base o de transferencias entre rutas (revertir
-- dejaría historia que las funciones anteriores no admiten). Sin esos datos, 0037 no cambió ninguna fila existente
-- y la reversión deja el esquema idéntico al de 0036 (vuelven también la independencia F5-D02 / AX717 y las
-- anulaciones sin camino de retiros y transferencias).
-- Restaura literalmente las funciones de 0034, 0035 y 0036.
-- Después: delete from adex_meta.schema_migrations where version = '0037'.
-- Generado por tmp/r74/w6/build-0037.mjs.

begin;

set local role adex_owner;

do $$
begin
  if exists (select 1 from adex.joint_reversal_proposals)
     or exists (select 1 from adex.admin_reimbursements where expense_id is not null)
     or exists (select 1 from adex.capital_operations where kind = 'REVERSAL' and reverses_kind in ('ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER')) then
    raise exception 'adex: 0037 cannot be reverted: joint reversals, linked reimbursements or reversals of base withdrawals/transfers exist' using errcode = '55000';
  end if;
end $$;

drop table adex.joint_reversal_events;
drop table adex.joint_reversal_parts;
drop table adex.joint_reversal_proposals;
drop function adex.guard_joint_reversal();
drop function adex.joint_reversal_cancel(uuid, text, text);
drop function adex.joint_reversal_confirm(uuid, text);
drop function adex.joint_reversal_propose(uuid, text, text, text);
drop function adex.joint_reversal_get(text);
drop function adex.joint_reversal_list(text);
drop function adex.joint_reversal_view(text, text);
drop function adex.expense_reversal_dependencies(text);
drop function adex.reimbursement_dependency(text, text, boolean, text);
drop function adex.admin_payable_items();
drop function adex.admin_reimbursement_pay(uuid, text, bigint, jsonb, text, text);
drop function adex.joint_reversal_routes(text, text, text);
drop function adex.admin_payable_items_internal(text, text);
drop function adex.joint_posting_ok(text, text, text);
drop function adex.joint_proposal_visible(text, text);

-- Funciones anteriores (texto literal de sus migraciones).

-- expense_correctable: texto literal de 0036_admin_authority_reconciliation.sql.
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
    -- R74 (0035, D74-O4F): gasto general con aportes de rutas o dinero propio: lo anula SOLO el Administrador
    -- responsable que lo registró (socio de confianza, sin aprobación); sin reintegros parciales.
    if e.funding in ('routes', 'own_money') then
      if p_refund then perform adex.capital_raise('AX713', 'general expenses funded by routes or own money are corrected only by reversal'); end if;
      if x.role is distinct from 'admin' then perform adex.capital_raise('AX402', 'only an administrator reverses general expenses'); end if;
      if e.funding = 'own_money' then
        -- Sin rutas afectadas: la obligación es con ese Administrador; solo él la anula (AX432 si ya se reembolsó).
        if e.responsible_admin_membership_id is distinct from x.actor then
          perform adex.capital_raise('AX402', 'only the administrator the company owes reverses an expense paid with own money');
        end if;
      else
        -- R74 (0036, RB-D7): el dinero vuelve a la Base de cada ruta aportante: lo anula el responsable VIGENTE de
        -- TODAS ellas (aunque no lo registrara); rutas de distintos responsables → AX434 (nunca una anulación parcial).
        perform 1 from adex.routes where company_id = x.company
           and id in (select g.route_id from adex.general_funding_contributions g where g.company_id = x.company and g.expense_id = e.id)
         order by id for share;
        perform adex.require_controls_all_routes(x.company, array(select g.route_id::text from adex.general_funding_contributions g
                                                                    where g.company_id = x.company and g.expense_id = e.id order by g.route_id), x.actor);
      end if;
    elsif e.scope is distinct from 'empresa' then
      -- F5-D02 (aprobada 2026-10-17): anulación de gastos de trabajador y de ruta.
      if p_refund then perform adex.capital_raise('AX713', 'only pool expenses have refunds'); end if;
      -- Autoridad `correct`: el Administrador responsable de capital de la ruta (R74: no el SuperAdmin).
      v_ctrl := adex.route_valid_controller(x.company, e.route_id);
      if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
      if x.actor is distinct from v_ctrl then
        perform adex.capital_raise('AX402', 'only the route capital controller can reverse');
      end if;
      -- Control independiente: quien anula no es la PERSONA que registró (ni con otra membresía).
      if adex.same_person(x.company, x.actor, e.registered_by_membership_id) then
        perform adex.capital_raise('AX717', 'the person who registered the expense cannot reverse it');
      end if;
      -- D7: la anulación se asienta hoy, que debe estar abierto; si la semana del gasto está
      -- cerrada, es un ajuste en el periodo abierto y exige la autoridad de aprobar ajustes.
      if adex.capital_period_closed(x.company, e.route_id, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
      if adex.capital_period_closed(x.company, e.route_id, e.expense_date)
         and not adex.ctx_can('payment.approveAdjustment') then
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
    -- R74 Base por Ruta (0034): un gasto de ruta pagado por la bolsa antes del corte se corrige contra la Base.
    if r.scope is distinct from 'empresa' then r.payer := adex.route_cash_redirect(x.company, r.payer, r.route); end if;
    return r;
  end $$;

-- general_expense_reverse: texto literal de 0035_general_expenses_funding.sql.
create or replace function adex.general_expense_reverse(x adex.money_ctx, p_operation_id uuid, p_expense text, p_reason text) returns jsonb
  language plpgsql
  as $$
  declare
    e        adex.expenses;
    o        adex.capital_operations;
    v_rev    text := gen_random_uuid()::text;
    v_first  text;
    v_op     text;
    v_expacc text;
    v_payable text;
    v_accts  text[] := '{}';
    v_ops    jsonb := '[]'::jsonb;
    v_n      int := 0;
    c        record;
  begin
    select * into e from adex.expenses where company_id = x.company and id = p_expense;
    select * into o from adex.capital_operations where company_id = x.company and id = e.ledger_operation_id;
    v_expacc := adex.capital_account_for(x.company, 'expense', null, null);
    if e.funding = 'own_money' then
      v_payable := adex.capital_account_for(x.company, 'admin_payable', e.responsible_admin_membership_id, null);
      perform adex.capital_lock_accounts(x.company, array[v_payable, v_expacc]);
      if (select balance_minor from adex.capital_accounts where company_id = x.company and id = v_payable) + e.amount_minor > 0 then
        perform adex.capital_raise('AX432', 'the obligation was already reimbursed: reverse the reimbursement first');
      end if;
      v_first := gen_random_uuid()::text;
    else
      for c in select g.route_id from adex.general_funding_contributions g
                where g.company_id = x.company and g.expense_id = e.id order by g.route_id loop
        perform 1 from adex.routes where company_id = x.company and id = c.route_id for share;
        if not adex.general_contribution_route_allowed(x.company, c.route_id, x.actor, e.scope) then
          perform adex.capital_raise('AX430', 'the money returns to each route base: you must still be the capital controller of every contributing route');
        end if;
        if adex.capital_period_closed(x.company, c.route_id, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
        v_accts := v_accts || adex.capital_account_for(x.company, 'route_base', null, c.route_id);
      end loop;
      perform adex.capital_lock_accounts(x.company, v_accts || v_expacc);
      v_first := gen_random_uuid()::text;
    end if;
    insert into adex.expenses (id, company_id, route_id, scope, category_id, amount_minor, description, expense_date, registered_by_membership_id,
                               collector_membership_id, funding, funding_admin_membership_id, responsible_admin_membership_id, sync_status, created_at,
                               reverses_id, reversal_reason, ledger_operation_id)
    values (v_rev, x.company, null, e.scope, e.category_id, -e.amount_minor, 'Anulación: ' || p_reason, x.today, x.actor, null, e.funding, null,
            e.responsible_admin_membership_id, 'synced', now(), e.id, p_reason, v_first);
    update adex.expenses set reversal_id = v_rev, reversed_at = now(), reversed_by_membership_id = x.actor, reversal_reason = p_reason
     where company_id = x.company and id = e.id;
    if e.funding = 'own_money' then
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           expense_id, reverses_operation_id, reverses_kind, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_first, x.company, p_operation_id, 'REVERSAL', e.amount_minor, x.currency, null, e.responsible_admin_membership_id, v_rev, o.id,
              'GENERAL_EXPENSE_OWN_MONEY', p_reason, x.today, x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_first, array[v_payable, v_expacc], array[e.amount_minor, -e.amount_minor]);
      v_ops := jsonb_build_array(v_first);
    else
      for c in select g.route_id, g.amount_minor, g.operation_id from adex.general_funding_contributions g
                where g.company_id = x.company and g.expense_id = e.id order by g.route_id loop
        v_n := v_n + 1;
        v_op := case when v_n = 1 then v_first else gen_random_uuid()::text end;
        insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                             expense_id, reverses_operation_id, reverses_kind, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
        values (v_op, x.company, adex.general_contribution_op_id(p_operation_id, v_n), 'REVERSAL', c.amount_minor, x.currency, c.route_id, x.actor, v_rev,
                c.operation_id, 'GENERAL_EXPENSE_CONTRIBUTION', p_reason, x.today, x.actor, x.identity, x.role, txid_current());
        perform adex.capital_write_legs(x.company, v_op, array[adex.capital_account_for(x.company, 'route_base', null, c.route_id), v_expacc],
                                        array[c.amount_minor, -c.amount_minor]);
        v_ops := v_ops || to_jsonb(v_op);
      end loop;
    end if;
    return jsonb_build_object('reversalExpenseId', v_rev, 'operationId', v_first, 'operationIds', v_ops, 'expenseId', e.id, 'amountMinor', e.amount_minor,
                              'reversalDate', x.today, 'periodClosed', false);
  end $$;

-- admin_reimbursement_reverse: texto literal de 0036_admin_authority_reconciliation.sql.
create or replace function adex.admin_reimbursement_reverse(p_operation_id uuid, p_reimbursement text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x       adex.money_ctx;
    r       adex.admin_reimbursements;
    v_payable text;
    v_src   text;
    v_accts text[] := '{}';
    v_op    text;
    v_first text;
    v_n     int := 0;
    v_ops   jsonb := '[]'::jsonb;
    c       record;
    v_cname text;
  begin
    x := adex.money_context(p_operation_id);
    if x.role is distinct from 'admin' then perform adex.capital_raise('AX402', 'only the administrator who paid reverses a reimbursement'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    select * into r from adex.admin_reimbursements where company_id = x.company and id = p_reimbursement for update;
    if not found then perform adex.capital_raise('AX412', 'reimbursement not found'); end if;
    if r.reversed_at is not null then perform adex.capital_raise('AX405', 'reimbursement already reversed'); end if;
    -- R74 (0036, RB-D7): desde rutas, el responsable VIGENTE de TODAS las rutas aportantes (el dinero vuelve a cada
    -- Base y la obligación vuelve a quedar pendiente); desde una bolsa (`admin_pool`), quien pagó (vuelve a su bolsa).
    if r.source = 'admin_pool' then
      if r.payer_membership_id is distinct from x.actor then perform adex.capital_raise('AX402', 'only the administrator who paid reverses a reimbursement'); end if;
    else
      perform 1 from adex.routes where company_id = x.company
         and id in (select g.route_id from adex.general_funding_contributions g where g.company_id = x.company and g.reimbursement_id = r.id)
       order by id for share;
      perform adex.require_controls_all_routes(x.company, array(select g.route_id::text from adex.general_funding_contributions g
                                                                  where g.company_id = x.company and g.reimbursement_id = r.id order by g.route_id), x.actor);
    end if;
    v_payable := adex.capital_account_for(x.company, 'admin_payable', r.admin_membership_id, null);
    for c in select g.route_id from adex.general_funding_contributions g
              where g.company_id = x.company and g.reimbursement_id = r.id order by g.route_id loop
      if c.route_id is null then
        v_accts := v_accts || adex.capital_account_for(x.company, 'admin', x.actor, null);
      else
        perform 1 from adex.routes where company_id = x.company and id = c.route_id for share;
        if not adex.general_contribution_route_allowed(x.company, c.route_id, x.actor, 'reembolso') then
          perform adex.capital_raise('AX430', 'the money returns to each route base: you must still be the capital controller of every contributing route');
        end if;
        if adex.capital_period_closed(x.company, c.route_id, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
        v_accts := v_accts || adex.capital_account_for(x.company, 'route_base', null, c.route_id);
      end if;
    end loop;
    perform adex.capital_lock_accounts(x.company, v_accts || v_payable);
    for c in select g.route_id, g.amount_minor, g.operation_id from adex.general_funding_contributions g
              where g.company_id = x.company and g.reimbursement_id = r.id order by g.route_id loop
      v_n := v_n + 1;
      v_op := gen_random_uuid()::text;
      if v_n = 1 then v_first := v_op; end if;
      v_src := case when c.route_id is null then adex.capital_account_for(x.company, 'admin', x.actor, null)
                    else adex.capital_account_for(x.company, 'route_base', null, c.route_id) end;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           counterpart_membership_id, reverses_operation_id, reverses_kind, reason, entry_date, actor_membership_id,
                                           actor_identity_id, actor_role, txid)
      values (v_op, x.company, adex.general_contribution_op_id(p_operation_id, v_n), 'REVERSAL', c.amount_minor, x.currency, c.route_id, x.actor,
              r.admin_membership_id, c.operation_id, 'ADMIN_REIMBURSEMENT', btrim(p_reason), x.today, x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_op, array[v_payable, v_src], array[-c.amount_minor, c.amount_minor]);
      v_ops := v_ops || to_jsonb(v_op);
    end loop;
    update adex.admin_reimbursements set reversed_at = now(), reversed_by_membership_id = x.actor, reversal_reason = btrim(p_reason),
           reversal_operation_id = p_operation_id
     where company_id = x.company and id = r.id;
    return jsonb_build_object('reimbursementId', r.id, 'adminId', r.admin_membership_id, 'amountMinor', r.amount_minor, 'operationIds', v_ops,
                              'operationId', v_first, 'pendingAfterMinor', -(select balance_minor from adex.capital_accounts where company_id = x.company and id = v_payable));
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('capital_operations_operation_key', 'admin_reimbursements_reversal_key') then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname = 'capital_operations_reversal_key' then perform adex.capital_raise('AX405', 'reimbursement already reversed'); end if;
      raise;
  end $$;

-- admin_reimbursement_post: texto literal de 0035_general_expenses_funding.sql.
create or replace function adex.admin_reimbursement_post(p_operation_id uuid, p_admin text, p_amount bigint, p_contributions jsonb, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x         adex.money_ctx;
    v_model   text;
    v_payable text;
    v_pool    text;
    v_total   bigint;
    v_pending bigint;
    v_id      text := gen_random_uuid()::text;
    v_op      text;
    v_accts   text[] := '{}';
    v_ops     jsonb := '[]'::jsonb;
    v_contrib jsonb := '[]'::jsonb;
    c         record;
    v_cname   text;
  begin
    x := adex.money_context(p_operation_id);
    if x.role is distinct from 'admin' then perform adex.capital_raise('AX402', 'only an administrator pays reimbursements'); end if;
    if not adex.ctx_can('cashbox.viewConsolidated') then perform adex.capital_raise('42501', 'no reimbursement authority'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    if p_admin is null or not exists (select 1 from adex.memberships where company_id = x.company and id = p_admin and role = 'admin') then
      perform adex.capital_raise('AX412', 'administrator not found');
    end if;
    if exists (select 1 from adex.admin_reimbursements where company_id = x.company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    v_model := adex.company_capital_model(x.company);
    v_payable := adex.capital_account_for(x.company, 'admin_payable', p_admin, null);
    if v_model = 'route_base' then
      if p_contributions is null or p_contributions = 'null'::jsonb then perform adex.capital_raise('AX429', 'contributions are required'); end if;
      select coalesce(sum(amount_minor), 0) into v_total from adex.general_contributions_parse(p_contributions);
      if p_amount is not null and p_amount <> v_total then perform adex.capital_raise('AX429', 'the contributions must add up to the amount'); end if;
      for c in select * from adex.general_contributions_parse(p_contributions) loop
        if not adex.ctx_route_allowed(c.route_id) or not exists (select 1 from adex.routes where company_id = x.company and id = c.route_id) then
          perform adex.capital_raise('AX412', 'route not found');
        end if;
        perform 1 from adex.routes where company_id = x.company and id = c.route_id for share;
        if adex.route_valid_controller(x.company, c.route_id) is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
        if not adex.general_contribution_route_allowed(x.company, c.route_id, x.actor, 'reembolso') then
          perform adex.capital_raise('AX430', 'a route contributes only when you are its capital controller');
        end if;
        if adex.capital_period_closed(x.company, c.route_id, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
        if adex.route_in_handover(x.company, c.route_id) then
          perform adex.capital_raise('AX423', 'the route is being handed over to a new responsible: confirm the count first');
        end if;
        v_accts := v_accts || adex.capital_account_for(x.company, 'route_base', null, c.route_id);
      end loop;
    elsif v_model = 'admin_pool' then
      if p_contributions is not null and p_contributions <> 'null'::jsonb then
        perform adex.capital_raise('AX429', 'without the route base model the reimbursement is paid from your pool: send amountMinor only');
      end if;
      if p_amount is null or p_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
      v_total := p_amount;
      v_pool := adex.capital_account_for(x.company, 'admin', x.actor, null);
      v_accts := array[v_pool];
    else
      perform adex.capital_raise('AX422', 'the capital model of the company is being migrated');
    end if;
    perform adex.capital_lock_accounts(x.company, v_accts || v_payable);
    select -balance_minor into v_pending from adex.capital_accounts where company_id = x.company and id = v_payable;
    if v_total > v_pending then perform adex.capital_raise('AX431', 'the reimbursement exceeds what the company owes this administrator'); end if;

    insert into adex.admin_reimbursements (id, company_id, operation_id, admin_membership_id, payer_membership_id, amount_minor, source, reason, entry_date,
                                           actor_identity_id, txid)
    values (v_id, x.company, p_operation_id, p_admin, x.actor, v_total, case when v_pool is null then 'routes' else 'admin_pool' end, btrim(p_reason), x.today,
            x.identity, txid_current());
    if v_pool is not null then
      v_op := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           counterpart_membership_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_op, x.company, p_operation_id, 'ADMIN_REIMBURSEMENT', v_total, x.currency, null, x.actor, p_admin, btrim(p_reason), x.today,
              x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_op, array[v_pool, v_payable], array[-v_total, v_total]);
      insert into adex.general_funding_contributions (id, company_id, purpose, reimbursement_id, route_id, amount_minor, operation_id, controller_membership_id)
      values (gen_random_uuid()::text, x.company, 'reimbursement', v_id, null, v_total, v_op, x.actor);
      v_ops := jsonb_build_array(v_op);
      v_contrib := jsonb_build_array(jsonb_build_object('routeId', null, 'amountMinor', v_total, 'operationId', v_op));
    else
      for c in select * from adex.general_contributions_parse(p_contributions) loop
        v_op := gen_random_uuid()::text;
        insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                             counterpart_membership_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
        values (v_op, x.company, adex.general_contribution_op_id(p_operation_id, c.n), 'ADMIN_REIMBURSEMENT', c.amount_minor, x.currency, c.route_id,
                x.actor, p_admin, btrim(p_reason), x.today, x.actor, x.identity, x.role, txid_current());
        perform adex.capital_write_legs(x.company, v_op, array[adex.capital_account_for(x.company, 'route_base', null, c.route_id), v_payable],
                                        array[-c.amount_minor, c.amount_minor]);
        insert into adex.general_funding_contributions (id, company_id, purpose, reimbursement_id, route_id, amount_minor, operation_id, controller_membership_id)
        values (gen_random_uuid()::text, x.company, 'reimbursement', v_id, c.route_id, c.amount_minor, v_op, x.actor);
        v_ops := v_ops || to_jsonb(v_op);
        v_contrib := v_contrib || jsonb_build_object('routeId', c.route_id, 'amountMinor', c.amount_minor, 'operationId', v_op);
      end loop;
    end if;
    return jsonb_build_object('reimbursementId', v_id, 'adminId', p_admin, 'payerId', x.actor, 'amountMinor', v_total, 'operationIds', v_ops,
                              'contributions', v_contrib, 'pendingBeforeMinor', v_pending, 'pendingAfterMinor', v_pending - v_total, 'entryDate', x.today,
                              'source', case when v_pool is null then 'routes' else 'admin_pool' end);
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      if v_cname = 'capital_accounts_admin_payable_sign' then perform adex.capital_raise('AX431', 'the reimbursement exceeds what the company owes this administrator'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('capital_operations_operation_key', 'admin_reimbursements_operation_key') then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;

-- route_base_post: texto literal de 0034_route_base.sql.
create or replace function adex.route_base_post(
  p_operation_id uuid,
  p_kind         text,
  p_amount       bigint,
  p_reason       text,
  p_route        text,
  p_to_route     text default null,
  p_reverses     text default null
) returns adex.capital_operations
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.ctx_company();
    v_actor    text := adex.ctx_membership();
    v_role     text := adex.ctx_role();
    v_identity uuid := adex.ctx_identity();
    v_reversal boolean := p_kind = 'REVERSAL';
    v_kind     text := p_kind;
    v_amount   bigint := p_amount;
    v_route    text := p_route;
    v_to       text := p_to_route;
    v_orig     adex.capital_operations;
    v_ctrl     text;
    v_ctrl2    text;
    v_currency char(3);
    v_date     date;
    v_accts    text[];
    v_amts     bigint[];
    v_op       adex.capital_operations;
    v_bal      bigint;
    v_i        int;
    v_cname    text;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'capital commands run only through the company API'); end if;
    if v_role is null or v_company is null or v_identity is null or v_actor is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    -- E2: el SuperAdmin supervisa; la Base la mueve el Administrador responsable de la ruta.
    if v_role <> 'admin' then perform adex.capital_raise('AX402', 'only the responsible administrator moves the base of a route'); end if;
    if p_operation_id is null or p_kind is null then perform adex.capital_raise('AX411', 'operation id and kind are required'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    if adex.company_capital_model(v_company) is distinct from 'route_base' then
      perform adex.capital_raise('AX428', 'the route base model is not active in this company');
    end if;
    select c.currency_code, adex.business_today(c.id) into v_currency, v_date from adex.companies c where c.id = v_company;
    if exists (select 1 from adex.capital_operations where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;

    if v_reversal then
      if p_reverses is null then perform adex.capital_raise('AX411', 'reversal needs the original operation'); end if;
      perform pg_advisory_xact_lock(adex.lock_key('capital-reversal', v_company || ':' || p_reverses));
      select * into v_orig from adex.capital_operations where company_id = v_company and id = p_reverses;
      if not found then perform adex.capital_raise('AX412', 'operation not found'); end if;
      if v_orig.kind = 'ROUTE_BASE_WITHDRAWAL' then perform adex.capital_raise('AX404', 'a base withdrawal is corrected with a new injection'); end if;
      if v_orig.kind = 'ROUTE_TRANSFER' then perform adex.capital_raise('AX404', 'a transfer is corrected with a transfer back by the destination responsible'); end if;
      if v_orig.kind = 'LEGACY_POOL_TO_ROUTE' then perform adex.capital_raise('AX404', 'an assignment of unassigned capital cannot be reversed'); end if;
      if v_orig.kind <> 'ROUTE_BASE_INJECTION' then perform adex.capital_raise('AX404', 'not a route base operation'); end if;
      if exists (select 1 from adex.capital_operations where company_id = v_company and reverses_operation_id = v_orig.id) then
        perform adex.capital_raise('AX405', 'operation already reversed');
      end if;
      v_kind := v_orig.kind; v_amount := v_orig.amount_minor; v_route := v_orig.route_id; v_to := null;
    end if;

    if v_amount is null or v_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
    if v_kind not in ('ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE') or v_route is null
       or (v_kind = 'ROUTE_TRANSFER') <> (v_to is not null) or v_to = v_route then
      perform adex.capital_raise('AX411', 'invalid fields for this operation kind');
    end if;
    if not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'route not found'); end if;

    -- Rutas (orden de id) y responsables releídos bajo bloqueo (R5).
    perform 1 from adex.routes where company_id = v_company and id in (v_route, v_to) order by id for update;
    if not exists (select 1 from adex.routes where company_id = v_company and id = v_route) then perform adex.capital_raise('AX412', 'route not found'); end if;
    v_ctrl := adex.route_valid_controller(v_company, v_route);
    if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the route capital controller moves its base'); end if;
    if adex.capital_period_closed(v_company, v_route, v_date) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
    if adex.route_in_handover(v_company, v_route) then
      perform adex.capital_raise('AX423', 'the route is being handed over to a new responsible: confirm the count first');
    end if;
    if not v_reversal and v_kind in ('ROUTE_BASE_INJECTION', 'LEGACY_POOL_TO_ROUTE') and not adex.route_operational(v_company, v_route) then
      perform adex.capital_raise('AX301', 'route is not operational');
    end if;
    if v_kind = 'ROUTE_TRANSFER' then
      if not exists (select 1 from adex.routes where company_id = v_company and id = v_to) then perform adex.capital_raise('AX412', 'destination route not found'); end if;
      v_ctrl2 := adex.route_valid_controller(v_company, v_to);
      if v_ctrl2 is null then perform adex.capital_raise('AX408', 'the destination route has no valid capital controller'); end if;
      if not adex.route_operational(v_company, v_to) then perform adex.capital_raise('AX301', 'destination route is not operational'); end if;
      if adex.capital_period_closed(v_company, v_to, v_date) then perform adex.capital_raise('AX407', 'the period of the destination route is closed'); end if;
    end if;

    case v_kind
      when 'ROUTE_BASE_INJECTION'  then v_accts := array[adex.capital_account_for(v_company, 'route_funding', null, v_route), adex.capital_account_for(v_company, 'route_base', null, v_route)];
      when 'ROUTE_BASE_WITHDRAWAL' then v_accts := array[adex.capital_account_for(v_company, 'route_base', null, v_route), adex.capital_account_for(v_company, 'route_funding', null, v_route)];
      when 'ROUTE_TRANSFER'        then v_accts := array[adex.capital_account_for(v_company, 'route_base', null, v_route), adex.capital_account_for(v_company, 'route_base', null, v_to)];
      else
        -- O3: el Administrador confirma el reparto de SU saldo «sin asignar» a una ruta de la que es responsable.
        if not exists (select 1 from adex.capital_accounts where company_id = v_company and kind = 'admin' and membership_id = v_actor) then
          perform adex.capital_raise('AX401', 'insufficient funds');
        end if;
        v_accts := array[adex.capital_account_for(v_company, 'admin', v_actor, null), adex.capital_account_for(v_company, 'route_base', null, v_route)];
    end case;
    if v_reversal then v_accts := array[v_accts[2], v_accts[1]]; end if;
    v_amts := array[-v_amount, v_amount];
    perform adex.capital_lock_accounts(v_company, v_accts);

    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, to_route_id,
                                         admin_membership_id, counterpart_membership_id, reverses_operation_id, reverses_kind, reason, entry_date,
                                         actor_membership_id, actor_identity_id, actor_role, txid)
    values (gen_random_uuid()::text, v_company, p_operation_id, p_kind, v_amount, v_currency, v_route, v_to,
            v_ctrl, v_ctrl2, v_orig.id, case when v_reversal then v_orig.kind end, btrim(p_reason), v_date, v_actor, v_identity, v_role, txid_current())
    returning * into v_op;
    for v_i in 1 .. 2 loop
      update adex.capital_accounts set balance_minor = balance_minor + v_amts[v_i], version = version + 1, updated_at = now()
       where company_id = v_company and id = v_accts[v_i]
      returning balance_minor into v_bal;
      insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor)
      values (v_company, v_op.id, v_i, v_accts[v_i], v_amts[v_i], v_bal);
    end loop;
    return v_op;
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      -- Sin cifras: nunca revela el saldo de otra cuenta.
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_reversal_key' then perform adex.capital_raise('AX405', 'operation already reversed'); end if;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;

drop index adex.admin_reimbursements_expense;
alter table adex.admin_reimbursements drop constraint admin_reimbursements_expense_fk;
alter table adex.admin_reimbursements drop column expense_id;

alter table adex.capital_operations drop constraint capital_operations_reverses_kind_check;
alter table adex.capital_operations add constraint capital_operations_reverses_kind_check
  check (reverses_kind is null or reverses_kind in ('COMPANY_DEPOSIT', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
                                                   'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE',
                                                   'COMPANY_EXPENSE', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ROUTE_BASE_INJECTION',
                                                   'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT'));

commit;
