-- REVERSIÓN de 0035 (manual, como adex_owner, en una transacción). Intervención R74, D74-O4F.
-- Se NIEGA si existe cualquier dato de la financiación de gastos generales (cuentas `admin_payable`,
-- operaciones de aporte / dinero propio / reembolso, aportes, reembolsos o gastos con alcance
-- `administrador` o con las fuentes `routes` / `own_money`): revertir los perdería. Sin esos datos, 0035
-- no cambió ninguna fila existente y la reversión deja el esquema idéntico al de 0034.
-- Restaura literalmente las funciones de 0013 y 0034.
-- Después: delete from adex_meta.schema_migrations where version = '0035'.
-- Generado por tmp/r74p/o4f/build-0035.mjs.

begin;

set local role adex_owner;

do $$
begin
  if exists (select 1 from adex.capital_accounts where kind = 'admin_payable')
     or exists (select 1 from adex.capital_operations
                 where coalesce(reverses_kind, kind) in ('GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT'))
     or exists (select 1 from adex.general_funding_contributions)
     or exists (select 1 from adex.admin_reimbursements)
     or exists (select 1 from adex.expenses where scope = 'administrador' or funding in ('routes', 'own_money') or responsible_admin_membership_id is not null) then
    raise exception 'adex: 0035 cannot be reverted: general expense funding data exists' using errcode = '55000';
  end if;
end $$;

drop function adex.admin_payables();
drop function adex.admin_reimbursement_reverse(uuid, text, text);
drop function adex.admin_reimbursement_post(uuid, text, bigint, jsonb, text);
drop function adex.general_expense_reverse(adex.money_ctx, uuid, text, text);
drop function adex.general_expense_post(uuid, text, text, bigint, text, text, text, jsonb);

-- Funciones anteriores (texto literal de sus migraciones).

-- capital_lock_accounts: texto literal de 0034_route_base.sql.
create or replace function adex.capital_lock_accounts(p_company text, p_accounts text[]) returns void
  language plpgsql
  as $$ begin
    perform 1 from adex.capital_accounts
      where company_id = p_company and id = any(p_accounts)
      order by array_position(array['company', 'admin', 'route_base', 'custody', 'portfolio', 'partner', 'external', 'income', 'expense', 'suspense', 'unidentified', 'route_funding'], kind), id
      for update;
  end $$;

-- guard_route_base_entry: texto literal de 0034_route_base.sql.
create or replace function adex.guard_route_base_entry() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_akind text; v_aroute text; v_okind text; v_orev text; v_oroute text; v_oto text; v_model text;
  begin
    select kind, route_id into v_akind, v_aroute from adex.capital_accounts where company_id = new.company_id and id = new.account_id;
    select kind, reverses_kind, route_id, to_route_id into v_okind, v_orev, v_oroute, v_oto
      from adex.capital_operations where company_id = new.company_id and id = new.operation_id;
    -- (1) Una ruta nunca consume dinero de otra: la pata en una cuenta CON ruta pertenece a la ruta de
    --     la operación o a su ruta de destino (transferencias y reasignaciones).
    if v_aroute is not null and v_aroute is distinct from v_oroute and v_aroute is distinct from v_oto then
      raise exception 'adex: a leg on a route account belongs to another route' using errcode = 'AX424';
    end if;
    -- (2) Modelo de capital.
    if v_akind in ('admin', 'company', 'transit', 'route_base', 'route_funding') then
      select capital_model into v_model from adex.companies where id = new.company_id;
      if v_model = 'route_base' then
        -- Bolsas: «sin asignar», solo salen hacia una ruta por el reparto confirmado (O3).
        if v_akind in ('company', 'transit') or (v_akind = 'admin' and not (v_okind = 'LEGACY_POOL_TO_ROUTE' and new.amount_minor < 0)) then
          raise exception 'adex: administrator pools and company capital do not move in the route base model' using errcode = 'AX421';
        end if;
      elsif v_akind in ('route_base', 'route_funding') then
        raise exception 'adex: the route base model is not active in this company' using errcode = 'AX428';
      elsif v_model = 'migrating' then
        raise exception 'adex: the capital model of the company is being migrated' using errcode = 'AX422';
      end if;
    end if;
    -- (3) En entrega (O5): ni inyección ni salidas de la Base salvo correcciones de cobros, devoluciones y cuadres.
    if v_akind = 'route_base'
       and (v_okind = 'ROUTE_BASE_INJECTION'
            or (new.amount_minor < 0 and (v_okind in ('WORKER_DELIVERY', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LOAN_DISBURSEMENT', 'ROUTE_EXPENSE',
                                                     'DISBURSEMENT_ADJUSTMENT', 'ROUTE_REASSIGNMENT')
                                          or (v_okind = 'REVERSAL' and v_orev = 'ROUTE_BASE_INJECTION'))))
       and adex.route_in_handover(new.company_id, v_aroute) then
      raise exception 'adex: the route is being handed over to a new responsible: confirm the count first' using errcode = 'AX423';
    end if;
    return new;
  end $$;

-- expense_post: texto literal de 0034_route_base.sql.
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
      -- R74 Base por Ruta (0034, O4): con `route_base`, quién financia un gasto GENERAL (de un Administrador
      -- o de la empresa) está pendiente de decisión del propietario: no se elige una ruta en silencio.
      if adex.company_capital_model(x.company) = 'route_base' then
        perform adex.capital_raise('AX426', 'general expenses are pending the funding decision of the route base model');
      end if;
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
        -- R74 Base por Ruta (0034): con `route_base` lo paga la Base de la ruta.
        v_payer := adex.route_cash_account(x.company, p_route, v_ctrl);
      else
        if not adex.capital_custodian_ok(x.company, p_route, p_worker) then perform adex.capital_raise('AX403', 'the worker cannot answer for an expense in this route'); end if;
        -- Cargarlo a OTRA persona es operar con su efectivo (`settle`).
        if p_worker is distinct from x.actor then
          if not adex.ctx_can('cashCustody.manage') then perform adex.capital_raise('42501', 'expenses you register are yours'); end if;
          if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
          if not (x.actor is not distinct from v_ctrl
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

-- expense_correctable: texto literal de 0034_route_base.sql.
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

-- expense_reverse: texto literal de 0013_collections_expenses.sql.
create or replace function adex.expense_reverse(p_operation_id uuid, p_expense text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare x adex.money_ctx; c adex.expense_fix; v_rev text := gen_random_uuid()::text; v_op text := gen_random_uuid()::text; v_cname text;
  begin
    x := adex.money_context(p_operation_id);
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 200 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    c := adex.expense_correctable(x, p_expense, false);
    -- D12: con reintegros previos se reintegra el resto; no se anula.
    if c.refunded > 0 then perform adex.capital_raise('AX715', 'the expense has refunds: refund the rest instead'); end if;
    perform adex.capital_lock_accounts(x.company, array[c.payer, c.expacc]);
    insert into adex.expenses (id, company_id, route_id, scope, category_id, amount_minor, description, expense_date, registered_by_membership_id,
                               collector_membership_id, funding, funding_admin_membership_id, sync_status, created_at, reverses_id, reversal_reason,
                               ledger_operation_id)
    select v_rev, company_id, route_id, scope, category_id, -amount_minor, 'Anulación: ' || btrim(p_reason), x.today, x.actor,
           collector_membership_id, funding, funding_admin_membership_id, 'synced', now(), id, btrim(p_reason), v_op
      from adex.expenses where company_id = x.company and id = c.id;
    update adex.expenses set reversal_id = v_rev, reversed_at = now(), reversed_by_membership_id = x.actor, reversal_reason = btrim(p_reason)
     where company_id = x.company and id = c.id;
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, expense_id, reverses_operation_id, reverses_kind, reason, entry_date,
                                         actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_op, x.company, p_operation_id, 'REVERSAL', c.amount, x.currency, c.route, c.admin, c.worker, v_rev, c.op, c.kind, btrim(p_reason),
            x.today, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[c.payer, c.expacc], array[c.amount::bigint, -c.amount::bigint]);
    return jsonb_build_object('reversalExpenseId', v_rev, 'operationId', v_op, 'expenseId', c.id, 'amountMinor', c.amount, 'reversalDate', x.today,
      'periodClosed', c.route is not null and adex.capital_period_closed(x.company, c.route,
                        (select expense_date from adex.expenses where company_id = x.company and id = c.id)));
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname in ('capital_operations_reversal_key', 'expenses_company_id_reverses_id_key') then perform adex.capital_raise('AX405', 'expense already reversed'); end if;
      raise;
  end $$;

-- capital_ledger_checks: texto literal de 0034_route_base.sql.
create or replace function adex.capital_ledger_checks() returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    r jsonb;
  begin
    if v_company is null or not adex.ctx_membership_active() or adex.ctx_role() is distinct from 'superadmin' then
      perform adex.capital_raise('42501', 'reconciliation is reserved to the SuperAdmin');
    end if;
    select jsonb_build_object(
      'mismatched', (select count(*) from adex.capital_accounts a
                      where a.company_id = v_company and a.balance_minor <> coalesce((select sum(e.amount_minor) from adex.capital_entries e
                                                                                      where e.company_id = a.company_id and e.account_id = a.id), 0)),
      'unbalanced', (select count(*) from adex.capital_operations o
                      where o.company_id = v_company and (select coalesce(sum(e.amount_minor), 0) <> 0 or count(*) < 2 from adex.capital_entries e
                                                           where e.company_id = o.company_id and e.operation_id = o.id)),
      'negativeCustody', (select count(*) from adex.capital_entries e
                            join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
                            join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
                           where e.company_id = v_company and a.kind = 'custody' and e.amount_minor < 0 and e.balance_after_minor < 0
                             and o.kind <> 'WORKER_EXPENSE'),
      'carriedDrift', (select count(*) from adex.capital_accounts a
                        where a.company_id = v_company and a.kind = 'custody'
                          and a.carried_minor <> coalesce((select s.carried_after_minor from adex.custody_settlements s where s.company_id = a.company_id
                                                            and s.custody_account_id = a.id and s.status = 'cerrada' order by s.cycle_no desc limit 1), 0)),
      'settlementDrift', (select count(*) from adex.custody_settlements s
                           where s.company_id = v_company
                             and (s.expected_position_minor <> coalesce((select sum(e.amount_minor) from adex.capital_entries e
                                                                          where e.company_id = s.company_id and e.account_id = s.custody_account_id and e.seq <= s.to_seq), 0)
                                  or s.returned_to_pool_minor <> coalesce((select o.amount_minor from adex.capital_operations o where o.company_id = s.company_id
                                                                            and o.id = s.return_operation_id and o.kind = 'SETTLEMENT_RETURN' and o.settlement_id = s.id), 0)
                                  or s.surplus_minor <> coalesce((select o.amount_minor from adex.capital_operations o where o.company_id = s.company_id
                                                                   and o.id = s.surplus_operation_id and o.kind = 'SETTLEMENT_SURPLUS' and o.settlement_id = s.id), 0)
                                  or (s.status = 'reabierta') <> exists (select 1 from adex.capital_operations o where o.company_id = s.company_id and o.settlement_id = s.id
                                                                          and o.kind = 'REVERSAL') and (s.return_operation_id is not null or s.surplus_operation_id is not null))),
      'surplusDrift', (select count(*) from adex.capital_accounts a
                        where a.company_id = v_company and a.kind in ('suspense', 'unidentified')
                          and abs(a.balance_minor) <> coalesce((select sum(s.surplus_minor) from adex.custody_settlements s where s.company_id = a.company_id
                                                                 and s.route_id = a.route_id and s.status = 'cerrada'
                                                                 and (a.kind = 'unidentified' or s.receiver_admin_membership_id = a.membership_id)), 0)),
      'closedDrift', (select count(*) from adex.period_closures p
                        cross join lateral (select adex.route_period_figures(p.company_id, p.route_id, p.week_start, p.week_end) f) now
                       where p.company_id = v_company
                         and (p.figures -> 'custody' is distinct from now.f -> 'custody' or p.ledger_hash is distinct from now.f #>> '{operations,hash}')),
      -- R74 Base por Ruta (0034). Ámbito: toda pata en una cuenta CON ruta es de la ruta de la operación o de su destino.
      'routeScope', (select count(*) from adex.capital_entries e
                      join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
                      join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
                     where e.company_id = v_company and a.route_id is not null
                       and a.route_id is distinct from o.route_id and a.route_id is distinct from o.to_route_id),
      -- Desde el corte, ninguna bolsa recibe dinero y solo sale por el reparto confirmado de «sin asignar».
      'adminInflowAfterCutover', (select count(*) from adex.capital_entries e
                                   join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
                                   join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
                                   join adex.companies c on c.id = e.company_id
                                  where e.company_id = v_company and c.route_base_since is not null and o.created_at >= c.route_base_since
                                    and a.kind = 'admin' and (e.amount_minor > 0 or o.kind <> 'LEGACY_POOL_TO_ROUTE')),
      -- Conservación por ruta: desde el corte, toda operación que no cruza rutas suma cero dentro de cada ruta.
      'routeConservation', (select count(*) from (
                              select o.id, a.route_id from adex.capital_entries e
                                join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
                                join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
                                join adex.companies c on c.id = e.company_id
                               where e.company_id = v_company and c.route_base_since is not null and o.created_at >= c.route_base_since
                                 and a.route_id is not null
                                 and coalesce(o.reverses_kind, o.kind) not in ('ROUTE_TRANSFER', 'ROUTE_REASSIGNMENT', 'LEGACY_POOL_TO_ROUTE')
                               group by o.id, a.route_id having sum(e.amount_minor) <> 0) x))
      into r;
    return r;
  end $$;

-- capital_model_prerequisites: texto literal de 0034_route_base.sql.
create or replace function adex.capital_model_prerequisites() returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    v_company_bal bigint; v_transit bigint; v_pending_transfers int; v_pending_requests int; v_routes text[]; v_ledger jsonb;
    v_overdrawn int; v_conservation numeric; v_pools jsonb; v_checks jsonb;
  begin
    if v_company is null or not adex.ctx_membership_active() or adex.ctx_role() is distinct from 'superadmin' then
      perform adex.capital_raise('42501', 'the capital model is managed by the SuperAdmin');
    end if;
    select coalesce(sum(balance_minor) filter (where kind = 'company'), 0), coalesce(sum(balance_minor) filter (where kind = 'transit'), 0)
      into v_company_bal, v_transit from adex.capital_accounts where company_id = v_company and kind in ('company', 'transit');
    select count(*) into v_pending_transfers from adex.admin_transfers where company_id = v_company and state = 'pending';
    select count(*) into v_pending_requests from adex.capital_requests
     where company_id = v_company and state = 'pending' and kind in ('admin_return', 'admin_allocation', 'admin_transfer');
    select coalesce(array_agg(r.id::text order by r.id), '{}') into v_routes from adex.routes r
     where r.company_id = v_company and r.status = 'activa' and adex.route_valid_controller(v_company, r.id) is null;
    v_ledger := adex.capital_ledger_checks();
    select count(*) into v_overdrawn from adex.capital_accounts
     where company_id = v_company and kind not in ('external', 'income', 'custody', 'unidentified', 'route_funding') and balance_minor < 0;
    select coalesce(sum(balance_minor), 0) into v_conservation from adex.capital_accounts where company_id = v_company;
    select coalesce(jsonb_agg(jsonb_build_object('adminId', a.membership_id, 'name', m.display_name, 'status', m.status, 'balanceMinor', a.balance_minor)
                    order by m.display_name, a.membership_id), '[]'::jsonb)
      into v_pools
      from adex.capital_accounts a join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
     where a.company_id = v_company and a.kind = 'admin' and a.balance_minor <> 0;
    v_checks := jsonb_build_array(
      jsonb_build_object('name', 'company-account-zero', 'ok', v_company_bal = 0, 'detail', v_company_bal, 'documentable', true),
      jsonb_build_object('name', 'transit-zero', 'ok', v_transit = 0, 'detail', v_transit),
      jsonb_build_object('name', 'no-pending-admin-transfers', 'ok', v_pending_transfers = 0, 'detail', v_pending_transfers),
      jsonb_build_object('name', 'no-pending-pool-requests', 'ok', v_pending_requests = 0, 'detail', v_pending_requests),
      jsonb_build_object('name', 'active-routes-have-controller', 'ok', cardinality(v_routes) = 0, 'detail', to_jsonb(v_routes)),
      jsonb_build_object('name', 'ledger-clean', 'ok', (v_ledger->>'mismatched')::int = 0 and (v_ledger->>'unbalanced')::int = 0
                           and (v_ledger->>'negativeCustody')::int = 0 and (v_ledger->>'routeScope')::int = 0 and v_overdrawn = 0 and v_conservation = 0,
                         'detail', jsonb_build_object('mismatched', v_ledger->'mismatched', 'unbalanced', v_ledger->'unbalanced', 'negativeCustody', v_ledger->'negativeCustody',
                                                      'routeScope', v_ledger->'routeScope', 'overdrawn', v_overdrawn, 'conservation', v_conservation)));
    return jsonb_build_object('model', adex.company_capital_model(v_company), 'checks', v_checks,
      'ok', not exists (select 1 from jsonb_array_elements(v_checks) c where not (c->>'ok')::boolean),
      'unassignedPools', v_pools);
  end $$;

-- route_panel: texto literal de 0034_route_base.sql.
create or replace function adex.route_panel(p_from date, p_to date) returns jsonb
  language plpgsql stable set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    v_model   text;
    v_since   timestamptz;
    v_routes  jsonb := '[]'::jsonb;
    r record;
    f jsonb;
    c record;
    v_base bigint; v_funding bigint; v_portf bigint; v_surplus bigint; v_outstanding bigint; v_approved bigint;
    v_exp_op bigint; v_exp_dur bigint; v_exp_other bigint; v_interest bigint; v_collected bigint; v_disbursed bigint;
    v_result bigint; v_flow bigint; v_needs bigint; v_alerts text[]; v_handover jsonb;
    t_base bigint := 0; t_custody bigint := 0; t_deliverable bigint := 0; t_portf bigint := 0; t_result bigint := 0; t_flow bigint := 0;
    v_general jsonb; v_pools jsonb;
  begin
    if v_company is null or adex.ctx_role() is null or not adex.ctx_can('cashbox.viewRoute') then
      perform adex.capital_raise('42501', 'no route cash authority');
    end if;
    if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 370 then perform adex.capital_raise('AX411', 'invalid period'); end if;
    select capital_model, route_base_since into v_model, v_since from adex.companies where id = v_company;

    for r in select ro.id, ro.name, ro.code, ro.status, ro.handover_state, ro.capital_controller_membership_id ctrl, m.display_name ctrl_name,
                    (ro.capital_controller_membership_id is not null and coalesce(adex.route_controller_valid(v_company, ro.id), false)) ctrl_valid
               from adex.routes ro left join adex.memberships m on m.company_id = ro.company_id and m.id = ro.capital_controller_membership_id
              where ro.company_id = v_company order by ro.name, ro.id loop
      f := adex.route_period_figures(v_company, r.id, p_from, p_to);
      select coalesce(sum(balance_minor), 0) gross, coalesce(sum(least(balance_minor, 0)), 0) negative,
             coalesce(sum(greatest(balance_minor - carried_minor, 0)), 0) deliverable, coalesce(sum(carried_minor), 0) carried, count(*) n
        into c from adex.capital_accounts where company_id = v_company and route_id = r.id and kind = 'custody';
      select coalesce(sum(balance_minor) filter (where kind = 'route_base'), 0), coalesce(-sum(balance_minor) filter (where kind = 'route_funding'), 0),
             coalesce(sum(balance_minor) filter (where kind = 'portfolio'), 0), coalesce(sum(balance_minor) filter (where kind = 'suspense'), 0)
        into v_base, v_funding, v_portf, v_surplus
        from adex.capital_accounts where company_id = v_company and route_id = r.id and kind in ('route_base', 'route_funding', 'portfolio', 'suspense');
      select coalesce(sum(balance_minor), 0) into v_outstanding from adex.sales
       where company_id = v_company and route_id = r.id and status = 'activa' and ledger_operation_id is not null;
      select coalesce(sum(amount_minor), 0) into v_approved from adex.sale_requests where company_id = v_company and route_id = r.id and status = 'approved';
      select coalesce(sum(x.amount_minor) filter (where coalesce(k.nature, 'operativo') = 'operativo'), 0),
             coalesce(sum(x.amount_minor) filter (where k.nature = 'bien_duradero'), 0),
             coalesce(sum(x.amount_minor) filter (where k.nature = 'otro'), 0)
        into v_exp_op, v_exp_dur, v_exp_other
        from adex.expenses x left join adex.expense_categories k on k.company_id = x.company_id and k.id = x.category_id
       where x.company_id = v_company and x.route_id = r.id and x.ledger_operation_id is not null and x.expense_date between p_from and p_to;
      v_interest := coalesce((f #>> '{credit,interestCollectedMinor}')::bigint, 0);
      v_collected := coalesce((f #>> '{credit,principalCollectedMinor}')::bigint, 0) + v_interest;
      v_disbursed := coalesce((f #>> '{credit,principalDisbursedMinor}')::bigint, 0);
      v_result := v_interest - v_exp_op - v_exp_other;
      v_flow := v_collected - v_disbursed - v_exp_op - v_exp_other - v_exp_dur;
      v_needs := case when v_model = 'route_base' then greatest(0, v_approved - (v_base + c.deliverable)) end;
      select to_jsonb(h) - 'company_id' into v_handover from (
        select id, status, from_membership_id, to_membership_id, base_at_start_minor, started_at, expected_base_minor, counted_minor, difference_minor, confirmed_at
          from adex.route_handover_records where company_id = v_company and route_id = r.id order by started_at desc, id limit 1) h;
      v_alerts := array_remove(array[
        case when not r.ctrl_valid then 'NO_VALID_CONTROLLER' end,
        case when r.handover_state = 'en_entrega' then 'ROUTE_IN_HANDOVER' end,
        case when (v_handover->>'status') = 'confirmada' and coalesce((v_handover->>'difference_minor')::bigint, 0) <> 0 then 'HANDOVER_DIFFERENCE' end,
        case when c.negative < 0 then 'NEGATIVE_CUSTODY' end,
        case when c.carried > 0 then 'CARRIED_SHORTAGE' end,
        case when v_surplus > 0 then 'SURPLUS_IN_CONTROL' end,
        case when v_result < 0 then 'NEGATIVE_OPERATING_RESULT' end,
        case when v_flow < 0 and v_result >= 0 then 'NEGATIVE_FLOW_GROWTH' end,
        case when coalesce(v_needs, 0) > 0 then 'INSUFFICIENT_LIQUIDITY' end], null);
      v_routes := v_routes || jsonb_build_object(
        'routeId', r.id, 'name', r.name, 'code', r.code, 'status', r.status, 'handoverState', r.handover_state, 'lastHandover', v_handover,
        'controller', jsonb_build_object('id', r.ctrl, 'name', r.ctrl_name, 'valid', r.ctrl_valid),
        'baseMinor', v_base, 'contributionsNetMinor', v_funding,
        'custody', jsonb_build_object('grossMinor', c.gross, 'negativeMinor', c.negative, 'deliverableMinor', c.deliverable, 'carriedShortageMinor', c.carried, 'positions', c.n),
        'cashMinor', v_base + c.gross, 'surplusInControlMinor', v_surplus,
        'portfolio', jsonb_build_object('principalPlacedMinor', v_portf, 'outstandingWithInterestMinor', v_outstanding),
        'approvedNotDisbursedMinor', v_approved,
        'period', jsonb_build_object('collectionsMinor', v_collected, 'interestCollectedMinor', v_interest, 'principalDisbursedMinor', v_disbursed,
                    'expenses', jsonb_build_object('operativoMinor', v_exp_op, 'bienDuraderoMinor', v_exp_dur, 'otroMinor', v_exp_other),
                    'base', f -> 'base'),
        'operatingResultMinor', v_result, 'operatingFlowMinor', v_flow, 'capitalNeedMinor', v_needs,
        'states', jsonb_build_object('negativeOperatingResult', v_result < 0, 'negativeFlowFromGrowth', v_flow < 0 and v_result >= 0,
                    'insufficientLiquidity', case when v_needs is null then null else v_needs > 0 end),
        'alerts', to_jsonb(v_alerts));
      t_base := t_base + v_base; t_custody := t_custody + c.gross; t_deliverable := t_deliverable + c.deliverable; t_portf := t_portf + v_portf;
      t_result := t_result + v_result; t_flow := t_flow + v_flow;
    end loop;

    -- Gastos generales (alcance empresa) del periodo, aparte de las rutas (O8): por fuente y naturaleza.
    select jsonb_build_object(
             'administratorMinor', coalesce(sum(x.amount_minor) filter (where x.funding = 'admin'), 0),
             'companyMinor', coalesce(sum(x.amount_minor) filter (where x.funding is distinct from 'admin'), 0),
             'operativoMinor', coalesce(sum(x.amount_minor) filter (where coalesce(k.nature, 'operativo') = 'operativo'), 0),
             'bienDuraderoMinor', coalesce(sum(x.amount_minor) filter (where k.nature = 'bien_duradero'), 0),
             'otroMinor', coalesce(sum(x.amount_minor) filter (where k.nature = 'otro'), 0))
      into v_general
      from adex.expenses x left join adex.expense_categories k on k.company_id = x.company_id and k.id = x.category_id
     where x.company_id = v_company and x.scope = 'empresa' and x.ledger_operation_id is not null and x.expense_date between p_from and p_to;
    -- Bolsas visibles: con `route_base` son saldo «sin asignar» (O3); con `admin_pool`, la bolsa operativa.
    select coalesce(jsonb_agg(jsonb_build_object('adminId', a.membership_id, 'name', m.display_name, 'balanceMinor', a.balance_minor)
                    order by m.display_name, a.membership_id), '[]'::jsonb)
      into v_pools
      from adex.capital_accounts a left join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
     where a.company_id = v_company and a.kind = 'admin' and a.balance_minor <> 0;

    return jsonb_build_object('model', v_model, 'routeBaseSince', v_since, 'from', p_from, 'to', p_to, 'routes', v_routes,
      'general', jsonb_build_object('expenses', v_general,
                   (case when v_model = 'route_base' then 'unassignedPools' else 'adminPools' end), v_pools,
                   'companyAccountMinor', (select balance_minor from adex.capital_accounts where company_id = v_company and kind = 'company')),
      'totals', jsonb_build_object('baseMinor', t_base, 'custodyMinor', t_custody, 'deliverableCustodyMinor', t_deliverable, 'cashMinor', t_base + t_custody,
                  'portfolioPrincipalMinor', t_portf, 'operatingResultMinor', t_result, 'operatingFlowMinor', t_flow));
  end $$;

drop function adex.general_contributions_parse(jsonb);
drop function adex.general_contribution_op_id(uuid, int);
drop function adex.general_contribution_route_allowed(text, text, text, text);

drop policy capital_operations_general_funding_ctx on adex.capital_operations;
drop policy capital_accounts_admin_payable_ctx on adex.capital_accounts;
drop policy expenses_general_ctx on adex.expenses;
drop table adex.general_funding_contributions;
drop table adex.admin_reimbursements;
drop function adex.guard_admin_reimbursement();

drop index adex.expenses_responsible_admin;
alter table adex.expenses drop constraint expenses_responsible_admin_check;
alter table adex.expenses drop constraint expenses_funding_scope_check;
alter table adex.expenses add constraint expenses_check4 check (funding is null or scope = 'empresa');
alter table adex.expenses drop constraint expenses_funding_check;
alter table adex.expenses add constraint expenses_funding_check check (funding in ('admin', 'empresa'));
alter table adex.expenses drop constraint expenses_scope_check;
alter table adex.expenses add constraint expenses_scope_check check (scope in ('empresa', 'ruta', 'trabajador'));
alter table adex.expenses drop constraint expenses_responsible_admin_fk;
alter table adex.expenses drop column responsible_admin_membership_id;

drop index adex.capital_operations_one_per_expense;
create unique index capital_operations_one_per_expense on adex.capital_operations (company_id, expense_id) where expense_id is not null;
alter table adex.capital_operations drop constraint capital_operations_general_funding_shape;
alter table adex.capital_operations drop constraint capital_operations_expense_shape;
alter table adex.capital_operations add constraint capital_operations_expense_shape
  check ((coalesce(reverses_kind, kind) in ('WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE', 'EXPENSE_REFUND')) = (expense_id is not null));
alter table adex.capital_operations drop constraint capital_operations_reverses_kind_check;
alter table adex.capital_operations add constraint capital_operations_reverses_kind_check
  check (reverses_kind is null or reverses_kind in ('COMPANY_DEPOSIT', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
                                                   'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE',
                                                   'COMPANY_EXPENSE', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ROUTE_BASE_INJECTION'));
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY', 'WORKER_RETURN',
  'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE',
  'EXPENSE_REFUND', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE',
  'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION',
  'ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE'));

alter table adex.capital_accounts drop constraint capital_accounts_admin_payable_sign;
alter table adex.capital_accounts drop constraint capital_accounts_no_overdraft;
alter table adex.capital_accounts add constraint capital_accounts_no_overdraft
  check (kind in ('external', 'income', 'custody', 'unidentified', 'route_funding') or balance_minor >= 0);
alter table adex.capital_accounts drop constraint capital_accounts_shape_check;
alter table adex.capital_accounts add constraint capital_accounts_shape_check
  check (case kind
           when 'company'      then membership_id is null and route_id is null
           when 'external'     then membership_id is null and route_id is null
           when 'admin'        then membership_id is not null and route_id is null
           when 'custody'      then membership_id is not null and route_id is not null
           when 'portfolio'    then membership_id is null and route_id is not null
           when 'income'       then membership_id is null and route_id is not null
           when 'expense'      then membership_id is null
           when 'suspense'     then membership_id is not null and route_id is not null
           when 'unidentified' then membership_id is null and route_id is not null
           when 'transit'      then membership_id is null and route_id is null
           -- O1/O2: de la RUTA, nunca de una persona.
           when 'route_base'    then membership_id is null and route_id is not null
           when 'route_funding' then membership_id is null and route_id is not null
         end);
alter table adex.capital_accounts drop constraint capital_accounts_kind_check;
alter table adex.capital_accounts add constraint capital_accounts_kind_check
  check (kind in ('company', 'admin', 'custody', 'external', 'portfolio', 'income', 'expense', 'suspense', 'unidentified', 'transit',
                  'route_base', 'route_funding'));

commit;
