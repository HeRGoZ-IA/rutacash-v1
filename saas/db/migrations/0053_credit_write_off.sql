-- 0053 · Castigo de créditos «Dar por perdida» (pendiente 3.28; decisión 2.1.10 del 2026-11-05; diseño aprobado por
-- Helmer el 2026-11-08: docs/ADEX_DISENO_CASTIGO_CREDITOS_2026-11.md).
--
--   · Solo el Administrador responsable de la ruta castiga una venta activa con saldo, con motivo (falleció / se fue del
--     país / otro + explicación). Sin plazo automático y sin estado «congelado».
--   · El dinero no se mueve: el CAPITAL pendiente sale de la cartera (`portfolio`) a una cuenta nueva por ruta,
--     `credit_loss` («Pérdida por créditos»). El interés pendiente nunca entró al libro, así que no se toca.
--     Operación `CREDIT_WRITE_OFF`: credit_loss +P / portfolio −P.
--   · Recuperación (solo el Administrador responsable): un pago posterior entra a la Base de la ruta; su capital reduce la
--     pérdida y su interés va a intereses. Operación `CREDIT_RECOVERY`: Base +a / credit_loss −capital / income −interés.
--     Un pago de recuperación NO se anula (anularlo con la fórmula de un cobro normal descuadraría el libro).
--   · Deshacer (con motivo, solo si no hubo recuperaciones): `REVERSAL` de `CREDIT_WRITE_OFF`; la venta vuelve a activa.
--   · Liquidación: `route_period_figures.credit.creditLossMinor` = Σ patas de `credit_loss` del periodo (castigo − deshacer −
--     capital recuperado). Se muestra en una línea aparte «Pérdida por créditos (capital)».
--   · Historial inmutable `adex.sale_write_offs` (castigos y deshacer).
-- No cambia ni borra filas existentes.

-- ============================================================
-- 1. Esquema
-- ============================================================

-- ---------- Cuenta «Pérdida por créditos» (de la ruta) ----------
alter table adex.capital_accounts drop constraint capital_accounts_kind_check;
alter table adex.capital_accounts add constraint capital_accounts_kind_check
  check (kind in ('company', 'admin', 'custody', 'external', 'portfolio', 'income', 'expense', 'suspense', 'unidentified', 'transit',
                  'route_base', 'route_funding', 'admin_payable', 'route_difference', 'credit_loss'));
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
           when 'route_base'    then membership_id is null and route_id is not null
           when 'route_funding' then membership_id is null and route_id is not null
           when 'admin_payable' then membership_id is not null and route_id is null
           when 'route_difference' then membership_id is null and route_id is not null
           -- 0053: de la RUTA; nunca negativa (una recuperación nunca supera lo castigado).
           when 'credit_loss' then membership_id is null and route_id is not null
         end);

-- ---------- Operaciones ----------
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY', 'WORKER_RETURN',
  'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE',
  'EXPENSE_REFUND', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE',
  'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION',
  'ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE',
  'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT',
  'DIFFERENCE_CONCILIATION', 'MIGRATION_OPENING', 'MIGRATION_COLLECTION', 'MIGRATION_ADJUSTMENT',
  'MIGRATION_CASH_COLLECTION', 'MIGRATION_DISBURSEMENT', 'MIGRATION_CASH', 'MIGRATION_PARTNER_DEBT', 'MIGRATION_PARTNER_REPAY',
  'CREDIT_WRITE_OFF', 'CREDIT_RECOVERY'));
alter table adex.capital_operations drop constraint capital_operations_reverses_kind_check;
alter table adex.capital_operations add constraint capital_operations_reverses_kind_check
  check (reverses_kind is null or reverses_kind in ('COMPANY_DEPOSIT', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
                                                   'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE',
                                                   'COMPANY_EXPENSE', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ROUTE_BASE_INJECTION',
                                                   'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT',
                                                   'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'MIGRATION_COLLECTION', 'MIGRATION_CASH_COLLECTION',
                                                   'CREDIT_WRITE_OFF'));
alter table adex.capital_operations drop constraint capital_operations_sale_shape;
alter table adex.capital_operations add constraint capital_operations_sale_shape
  check ((coalesce(reverses_kind, kind) in ('LOAN_DISBURSEMENT', 'COLLECTION', 'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION',
                                            'MIGRATION_OPENING', 'MIGRATION_COLLECTION', 'MIGRATION_ADJUSTMENT',
                                            'MIGRATION_CASH_COLLECTION', 'MIGRATION_DISBURSEMENT',
                                            'CREDIT_WRITE_OFF', 'CREDIT_RECOVERY')) = (sale_id is not null));
alter table adex.capital_operations drop constraint capital_operations_payment_shape;
alter table adex.capital_operations add constraint capital_operations_payment_shape
  check ((coalesce(reverses_kind, kind) in ('COLLECTION', 'MIGRATION_COLLECTION', 'MIGRATION_CASH_COLLECTION', 'CREDIT_RECOVERY')) = (payment_id is not null));

-- ---------- Venta: castigo vigente ----------
-- `lost_reason`, `lost_at` y `lost_by_membership_id` existen desde 0002. Se añade el capital castigado y la operación
-- (NULL = no castigada o castigo deshecho).
alter table adex.sales add column lost_principal_minor bigint check (lost_principal_minor is null or lost_principal_minor >= 0);
alter table adex.sales add column lost_operation_id adex.eid;
alter table adex.sales add column lost_kind text check (lost_kind is null or lost_kind in ('fallecio', 'se_fue_del_pais', 'otro'));

-- ---------- Historial inmutable ----------
create table adex.sale_write_offs (
  id                        adex.eid primary key,
  company_id                adex.eid not null references adex.companies(id),
  sale_id                   adex.eid not null,
  route_id                  adex.eid not null,
  operation_id              uuid not null,                  -- idempotencia del comando
  kind                      text not null check (kind in ('WRITE_OFF', 'UNDO')),
  reason_kind               text check (reason_kind is null or reason_kind in ('fallecio', 'se_fue_del_pais', 'otro')),
  reason                    text not null check (length(btrim(reason)) >= 3 and length(reason) <= 300),
  principal_minor           bigint not null check (principal_minor >= 0),   -- capital que sale (o vuelve) a la cartera
  balance_minor             bigint not null check (balance_minor >= 0),     -- saldo (capital + interés) en ese momento
  capital_operation_id      adex.eid not null,
  business_date             date not null,
  actor_membership_id       adex.eid not null,
  actor_identity_id         uuid not null,
  actor_role                text not null check (actor_role = 'admin'),
  txid                      bigint not null,
  created_at                timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, operation_id),
  check ((kind = 'WRITE_OFF') = (reason_kind is not null)),
  foreign key (company_id, sale_id) references adex.sales(company_id, id),
  foreign key (company_id, actor_membership_id) references adex.memberships(company_id, id)
);
alter table adex.sale_write_offs enable row level security;
alter table adex.sale_write_offs force row level security;
create trigger sale_write_offs_immutable before update or delete on adex.sale_write_offs
  for each row execute function adex.reject_mutation();
create trigger sale_write_offs_no_truncate before truncate on adex.sale_write_offs
  for each statement execute function adex.reject_mutation();
create policy sale_write_offs_ctx on adex.sale_write_offs for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active())
         and (select adex.ctx_is(array['superadmin', 'admin']))
         and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())));
create policy owner_sale_write_offs on adex.sale_write_offs for insert to adex_owner with check (true);
create policy owner_sale_write_offs_read on adex.sale_write_offs for select to adex_owner using (true);
grant select on adex.sale_write_offs to adex_api;
revoke all on adex.sale_write_offs from public;

-- ---------- Visibilidad (aditiva) ----------
create policy capital_accounts_credit_loss_ctx on adex.capital_accounts for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and kind = 'credit_loss'
         and (select adex.ctx_is(array['superadmin', 'admin', 'supervisor']))
         and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())));
create policy capital_operations_credit_loss_ctx on adex.capital_operations for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active())
         and coalesce(reverses_kind, kind) in ('CREDIT_WRITE_OFF', 'CREDIT_RECOVERY')
         and (select adex.ctx_is(array['superadmin', 'admin', 'supervisor']))
         and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())));

-- ============================================================
-- 2. Bloqueo de cuentas (orden fijo, con la cuenta nueva al final)
-- ============================================================
create or replace function adex.capital_lock_accounts(p_company text, p_accounts text[]) returns void
  language plpgsql
  as $$ begin
    perform 1 from adex.capital_accounts
      where company_id = p_company and id = any(p_accounts)
      order by array_position(array['company', 'admin', 'route_base', 'custody', 'portfolio', 'partner', 'external', 'income', 'expense', 'suspense', 'unidentified', 'route_funding', 'admin_payable', 'route_difference', 'credit_loss'], kind), id
      for update;
  end $$;

-- ============================================================
-- 3. Un pago de recuperación no se anula
-- ============================================================
create function adex.guard_recovery_not_reversed() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$ begin
    if new.kind = 'REVERSAL' and new.reverses_operation_id is not null
       and exists (select 1 from adex.capital_operations o where o.company_id = new.company_id and o.id = new.reverses_operation_id
                     and o.kind = 'CREDIT_RECOVERY') then
      raise exception 'adex: a recovery payment of a written-off credit cannot be reversed' using errcode = 'AX543';
    end if;
    return new;
  end $$;
revoke all on function adex.guard_recovery_not_reversed() from public;
create trigger capital_operations_recovery_not_reversed before insert on adex.capital_operations
  for each row execute function adex.guard_recovery_not_reversed();

-- ============================================================
-- 4. Comandos
-- ============================================================

-- Capital pendiente de una venta (lo que su cartera aún lleva).
create function adex.credit_principal_outstanding(p_company text, p_sale text) returns bigint
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select s.sale_value_minor - s.principal_reclassified_minor
           - coalesce((select sum(p.principal_minor) from adex.payments p where p.company_id = s.company_id and p.sale_id = s.id), 0)
      from adex.sales s where s.company_id = p_company and s.id = p_sale $$;
revoke all on function adex.credit_principal_outstanding(text, text) from public;

-- Comprobaciones comunes: Administrador responsable vigente de la ruta, ruta operativa y semana abierta.
create function adex.credit_loss_actor_check(x adex.money_ctx, p_route text) returns void
  language plpgsql
  as $$
  declare v_ctrl text;
  begin
    if x.role <> 'admin' then perform adex.capital_raise('AX402', 'only the administrator in charge of the route writes off a credit'); end if;
    v_ctrl := adex.route_valid_controller(x.company, p_route);
    if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    if v_ctrl is distinct from x.actor then perform adex.capital_raise('AX402', 'only the administrator in charge of the route writes off a credit'); end if;
    if not adex.route_operational(x.company, p_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
    if adex.capital_period_closed(x.company, p_route, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
  end $$;
revoke all on function adex.credit_loss_actor_check(adex.money_ctx, text) from public;

-- ---------- Dar por perdida ----------
create function adex.credit_write_off(p_operation_id uuid, p_sale text, p_reason_kind text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x          adex.money_ctx;
    s          adex.sales;
    v_route    text;
    v_reason   text := btrim(coalesce(p_reason, ''));
    v_balance  bigint;
    v_p        bigint;
    v_portf    text;
    v_loss     text;
    v_op       text := gen_random_uuid()::text;
    v_cname    text;
  begin
    x := adex.money_context(p_operation_id);
    if p_sale is null or p_reason_kind is null or p_reason_kind not in ('fallecio', 'se_fue_del_pais', 'otro') then
      perform adex.capital_raise('AX411', 'sale and reason kind are required');
    end if;
    if (p_reason_kind = 'otro' and length(v_reason) < 10) or length(v_reason) > 300 then
      perform adex.capital_raise('AX411', 'a reason of 10 to 300 characters is required');
    end if;
    if v_reason = '' then v_reason := case p_reason_kind when 'fallecio' then 'Falleció' else 'Se fue del país' end; end if;
    select route_id into v_route from adex.sales where company_id = x.company and id = p_sale;
    if not found or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'credit not found'); end if;

    perform 1 from adex.routes where company_id = x.company and id = v_route for share;
    select * into s from adex.sales where company_id = x.company and id = p_sale for update;
    perform adex.credit_loss_actor_check(x, v_route);
    if s.status <> 'activa' or s.disbursement_status is distinct from 'desembolsado' or s.ledger_operation_id is null then
      perform adex.capital_raise('AX540', 'only an active disbursed credit can be written off');
    end if;
    select coalesce(sum(balance_minor), 0) into v_balance from adex.installments where company_id = x.company and sale_id = p_sale;
    if v_balance <= 0 then perform adex.capital_raise('AX540', 'the credit has no balance'); end if;
    v_p := adex.credit_principal_outstanding(x.company, p_sale);
    if v_p < 0 then perform adex.capital_raise('AX420', 'inconsistent principal recognition'); end if;

    v_portf := adex.capital_account_for(x.company, 'portfolio', null, v_route);
    v_loss := adex.capital_account_for(x.company, 'credit_loss', null, v_route);
    perform adex.capital_lock_accounts(x.company, array[v_portf, v_loss]);
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, sale_id, reason, entry_date,
                                         actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_op, x.company, p_operation_id, 'CREDIT_WRITE_OFF', v_p, x.currency, v_route, p_sale, v_reason, x.today,
            x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_loss, v_portf], array[v_p, -v_p]);

    update adex.sales set status = 'perdida', lost_reason = v_reason, lost_kind = p_reason_kind, lost_at = now(),
                          lost_by_membership_id = x.actor, lost_principal_minor = v_p, lost_operation_id = v_op, updated_at = now()
     where company_id = x.company and id = p_sale;
    insert into adex.sale_write_offs (id, company_id, sale_id, route_id, operation_id, kind, reason_kind, reason, principal_minor, balance_minor,
                                      capital_operation_id, business_date, actor_membership_id, actor_identity_id, actor_role, txid)
    values (gen_random_uuid()::text, x.company, p_sale, v_route, p_operation_id, 'WRITE_OFF', p_reason_kind, v_reason, v_p, v_balance,
            v_op, x.today, x.actor, x.identity, x.role, txid_current());
    return jsonb_build_object('operationId', v_op, 'saleId', p_sale, 'routeId', v_route, 'principalMinor', v_p, 'balanceMinor', v_balance,
                              'reasonKind', p_reason_kind, 'reason', v_reason, 'businessDate', x.today);
  exception
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('capital_operations_operation_key', 'sale_write_offs_company_id_operation_id_key') then
        perform adex.capital_raise('AX409', 'operation id already used');
      end if;
      raise;
  end $$;
revoke all on function adex.credit_write_off(uuid, text, text, text) from public;
grant execute on function adex.credit_write_off(uuid, text, text, text) to adex_api;

-- ---------- Deshacer ----------
create function adex.credit_write_off_undo(p_operation_id uuid, p_sale text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x          adex.money_ctx;
    s          adex.sales;
    o          adex.capital_operations;
    v_route    text;
    v_reason   text := btrim(coalesce(p_reason, ''));
    v_portf    text;
    v_loss     text;
    v_balance  bigint;
    v_op       text := gen_random_uuid()::text;
    v_cname    text;
  begin
    x := adex.money_context(p_operation_id);
    if p_sale is null then perform adex.capital_raise('AX411', 'sale is required'); end if;
    if length(v_reason) < 10 or length(v_reason) > 300 then perform adex.capital_raise('AX411', 'a reason of 10 to 300 characters is required'); end if;
    select route_id into v_route from adex.sales where company_id = x.company and id = p_sale;
    if not found or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'credit not found'); end if;

    perform 1 from adex.routes where company_id = x.company and id = v_route for share;
    select * into s from adex.sales where company_id = x.company and id = p_sale for update;
    perform adex.credit_loss_actor_check(x, v_route);
    if s.status <> 'perdida' or s.lost_operation_id is null then perform adex.capital_raise('AX541', 'the credit is not written off'); end if;
    if exists (select 1 from adex.capital_operations where company_id = x.company and sale_id = p_sale and kind = 'CREDIT_RECOVERY'
                 and entry_date >= (select entry_date from adex.capital_operations where company_id = x.company and id = s.lost_operation_id)) then
      perform adex.capital_raise('AX542', 'the credit has recovery payments');
    end if;
    select * into o from adex.capital_operations where company_id = x.company and id = s.lost_operation_id;

    v_portf := adex.capital_account_for(x.company, 'portfolio', null, v_route);
    v_loss := adex.capital_account_for(x.company, 'credit_loss', null, v_route);
    perform adex.capital_lock_accounts(x.company, array[v_portf, v_loss]);
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, sale_id, reverses_operation_id,
                                         reverses_kind, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_op, x.company, p_operation_id, 'REVERSAL', o.amount_minor, x.currency, v_route, p_sale, o.id, 'CREDIT_WRITE_OFF', v_reason, x.today,
            x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_loss, v_portf], array[-o.amount_minor, o.amount_minor]);

    update adex.sales set status = 'activa', lost_reason = null, lost_kind = null, lost_at = null, lost_by_membership_id = null,
                          lost_principal_minor = null, lost_operation_id = null, updated_at = now()
     where company_id = x.company and id = p_sale;
    perform adex.credit_recompute(x.company, p_sale, x.today, x.today);
    select coalesce(sum(balance_minor), 0) into v_balance from adex.installments where company_id = x.company and sale_id = p_sale;
    insert into adex.sale_write_offs (id, company_id, sale_id, route_id, operation_id, kind, reason_kind, reason, principal_minor, balance_minor,
                                      capital_operation_id, business_date, actor_membership_id, actor_identity_id, actor_role, txid)
    values (gen_random_uuid()::text, x.company, p_sale, v_route, p_operation_id, 'UNDO', null, v_reason, o.amount_minor, v_balance,
            v_op, x.today, x.actor, x.identity, x.role, txid_current());
    return jsonb_build_object('operationId', v_op, 'saleId', p_sale, 'routeId', v_route, 'principalMinor', o.amount_minor, 'businessDate', x.today);
  exception
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('capital_operations_operation_key', 'sale_write_offs_company_id_operation_id_key') then
        perform adex.capital_raise('AX409', 'operation id already used');
      end if;
      raise;
  end $$;
revoke all on function adex.credit_write_off_undo(uuid, text, text) from public;
grant execute on function adex.credit_write_off_undo(uuid, text, text) to adex_api;

-- ---------- Recuperación ----------
create function adex.credit_recovery_post(p_operation_id uuid, p_sale text, p_amount bigint, p_note text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x           adex.money_ctx;
    s           adex.sales;
    v_route     text;
    v_ctrl      text;
    v_balance   bigint;
    v_applied   bigint;
    v_paid      bigint;
    v_known     bigint;
    v_principal bigint;
    v_interest  bigint;
    v_receiver  text;
    v_loss      text;
    v_income    text;
    v_new       bigint;
    v_payment   text := gen_random_uuid()::text;
    v_op        text := gen_random_uuid()::text;
    v_cname     text;
  begin
    x := adex.money_context(p_operation_id);
    if p_sale is null or p_amount is null or p_amount <= 0 then perform adex.capital_raise('AX411', 'sale and a positive amount are required'); end if;
    if p_note is not null and length(p_note) > 500 then perform adex.capital_raise('AX411', 'note is too long'); end if;
    select route_id into v_route from adex.sales where company_id = x.company and id = p_sale;
    if not found or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'credit not found'); end if;

    perform 1 from adex.routes where company_id = x.company and id = v_route for share;
    select * into s from adex.sales where company_id = x.company and id = p_sale for update;
    perform adex.credit_loss_actor_check(x, v_route);
    if s.lost_operation_id is null or s.status not in ('perdida') then perform adex.capital_raise('AX544', 'only a written-off credit takes a recovery'); end if;
    select coalesce(sum(balance_minor), 0) into v_balance from adex.installments where company_id = x.company and sale_id = p_sale;
    if v_balance <= 0 then perform adex.capital_raise('AX705', 'the credit has no balance'); end if;

    v_applied := least(p_amount, v_balance);
    select coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0) into v_paid, v_known
      from adex.payments where company_id = x.company and sale_id = p_sale;
    v_known := v_known + s.principal_reclassified_minor;
    v_principal := adex.credit_principal_of(v_paid + v_applied, s.sale_value_minor, s.total_value_minor) - v_known;
    v_interest := v_applied - v_principal;
    if v_principal < 0 or v_interest < 0 then perform adex.capital_raise('AX420', 'inconsistent principal recognition'); end if;

    v_ctrl := adex.route_valid_controller(x.company, v_route);
    v_receiver := adex.route_cash_account(x.company, v_route, v_ctrl);
    v_loss := adex.capital_account_for(x.company, 'credit_loss', null, v_route);
    v_income := adex.capital_account_for(x.company, 'income', null, v_route);
    perform adex.capital_lock_accounts(x.company, array[v_receiver, v_loss, v_income]);

    insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, created_by_membership_id, amount_minor,
                               payment_date, payment_type, note, sync_status, created_at, state, ledger_operation_id, principal_minor, interest_minor)
    values (v_payment, x.company, p_sale, s.client_id, v_route, x.actor, x.actor, v_applied, x.today, 'efectivo',
            coalesce(nullif(btrim(p_note), ''), 'Recuperación de venta perdida'), 'synced', now(), 'active', v_op, v_principal, v_interest);
    v_new := adex.credit_recompute(x.company, p_sale, x.today, x.today);
    if v_new <= 0 then
      update adex.sales set status = 'finalizada', finished_on = coalesce(finished_on, x.today), updated_at = now()
       where company_id = x.company and id = p_sale;
    end if;
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         sale_id, payment_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_op, x.company, p_operation_id, 'CREDIT_RECOVERY', v_applied, x.currency, v_route, v_ctrl, p_sale, v_payment,
            'Recuperación de venta perdida', x.today, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_receiver, v_loss, v_income], array[v_applied, -v_principal, -v_interest]);

    return jsonb_build_object('paymentId', v_payment, 'operationId', v_op, 'saleId', p_sale, 'routeId', v_route,
      'requestedMinor', p_amount, 'appliedMinor', v_applied, 'capped', v_applied < p_amount, 'previousBalanceMinor', v_balance,
      'newBalanceMinor', v_new, 'principalMinor', v_principal, 'interestMinor', v_interest, 'paymentDate', x.today);
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
revoke all on function adex.credit_recovery_post(uuid, text, bigint, text) from public;
grant execute on function adex.credit_recovery_post(uuid, text, bigint, text) to adex_api;

-- ============================================================
-- 5. Liquidación: «Pérdida por créditos (capital)»
-- ============================================================
create or replace function pg_temp.patch(p_fn regprocedure, p_from text, p_to text) returns text
  language plpgsql as $$
  declare def text := pg_get_functiondef(p_fn);
  begin
    if (length(def) - length(replace(def, p_from, ''))) / length(p_from) <> 1 then
      raise exception '0053: % should contain this text exactly once: %', p_fn, left(p_from, 120);
    end if;
    return replace(def, p_from, p_to);
  end $$;

do $$
declare def text;
begin
  def := pg_temp.patch('adex.route_period_figures(text, text, date, date)'::regprocedure,
    'or (a.kind in (''portfolio'', ''income'', ''expense'', ''suspense'') and a.route_id = p_route))',
    'or (a.kind in (''portfolio'', ''income'', ''expense'', ''suspense'', ''credit_loss'') and a.route_id = p_route))');
  def := replace(def,
    '''expensesMinor'', coalesce(sum(amt) filter (where ak = ''expense''), 0))',
    '''expensesMinor'', coalesce(sum(amt) filter (where ak = ''expense''), 0),
             -- 0053: capital castigado en el periodo, neto de deshacer y de lo recuperado.
             ''creditLossMinor'', coalesce(sum(amt) filter (where ak = ''credit_loss''), 0))');
  if position('creditLossMinor' in def) = 0 then raise exception '0053: route_period_figures credit block not found'; end if;
  execute def;
end $$;

-- Panel de rutas («Periodo y resultado»): la pérdida por créditos del periodo baja el resultado operativo (no el flujo:
-- no es efectivo). Decisión del propietario 2026-11-08: línea aparte.
do $$
declare def text;
begin
  def := pg_temp.patch('adex.route_panel(date, date)'::regprocedure,
    'v_result := v_interest - v_exp_op - v_exp_other;',
    'v_result := v_interest - v_exp_op - v_exp_other - coalesce((f #>> ''{credit,creditLossMinor}'')::bigint, 0);   -- 0053');
  def := replace(def,
    '''interestCollectedMinor'', v_interest, ''principalDisbursedMinor'', v_disbursed,',
    '''interestCollectedMinor'', v_interest, ''principalDisbursedMinor'', v_disbursed,
                    ''creditLossMinor'', coalesce((f #>> ''{credit,creditLossMinor}'')::bigint, 0),');
  if position('''creditLossMinor'', coalesce((f' in def) = 0 then raise exception '0053: route_panel period not patched'; end if;
  execute def;
end $$;
