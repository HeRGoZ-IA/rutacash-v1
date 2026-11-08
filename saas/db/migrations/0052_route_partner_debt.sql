-- 0052: la deuda de la migración es DE LA RUTA (pedido de Helmer, 2026-11-08).
--
-- En 0050, cuando la caja del sistema anterior era negativa, el socio (Administrador responsable) cubrió la diferencia
-- con su dinero: `MIGRATION_PARTNER_DEBT` (Base + o financiación +, y `admin_payable` −). Esa cuenta es la misma de los
-- gastos generales pagados con dinero propio, así que la deuda aparecía mezclada en «Reembolsos pendientes a
-- Administradores» y un reembolso general (pagado con aportes de CUALQUIER ruta) podía consumirla.
--
-- Regla de Helmer: «el dinero de cada ruta es sagrado»; un gasto dentro de una ruta no es un gasto general. Por eso:
--   1. La deuda se lleva POR RUTA: Σ MIGRATION_PARTNER_DEBT − Σ MIGRATION_PARTNER_REPAY de esa ruta.
--   2. Se devuelve SOLO con la Base de esa misma ruta (`route_partner_debt_repay`, nueva operación MIGRATION_PARTNER_REPAY:
--      Base − / admin_payable +). Nunca con otras rutas.
--   3. Lo general (saldo a favor por gastos con dinero propio, reembolsos) ya no la cuenta ni la puede pagar.
--   4. El Panel de rutas la muestra en cada ruta (y la alerta), y el detalle separa «Cubierto por el Administrador».
-- Ningún saldo cambia: solo dónde se ve la deuda y desde dónde se paga.

-- ---------- 1. Operación nueva ----------
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY', 'WORKER_RETURN',
  'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE',
  'EXPENSE_REFUND', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE',
  'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION',
  'ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE',
  'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT',
  'DIFFERENCE_CONCILIATION', 'MIGRATION_OPENING', 'MIGRATION_COLLECTION', 'MIGRATION_ADJUSTMENT',
  'MIGRATION_CASH_COLLECTION', 'MIGRATION_DISBURSEMENT', 'MIGRATION_CASH', 'MIGRATION_PARTNER_DEBT', 'MIGRATION_PARTNER_REPAY'));
alter table adex.capital_operations add constraint capital_operations_partner_repay_shape
  check (kind <> 'MIGRATION_PARTNER_REPAY' or (admin_membership_id is not null and route_id is not null));

-- ---------- 2. Deuda por ruta ----------
-- Por ruta y Administrador acreedor: deuda, devuelto y pendiente. Interno (security definer).
create function adex.route_partner_debt_internal(p_company text)
  returns table (route_id text, admin_id text, debt_minor bigint, repaid_minor bigint, outstanding_minor bigint)
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select o.route_id::text, o.admin_membership_id::text,
           coalesce(sum(o.amount_minor) filter (where o.kind = 'MIGRATION_PARTNER_DEBT'), 0)::bigint,
           coalesce(sum(o.amount_minor) filter (where o.kind = 'MIGRATION_PARTNER_REPAY'), 0)::bigint,
           (coalesce(sum(o.amount_minor) filter (where o.kind = 'MIGRATION_PARTNER_DEBT'), 0)
            - coalesce(sum(o.amount_minor) filter (where o.kind = 'MIGRATION_PARTNER_REPAY'), 0))::bigint
      from adex.capital_operations o
     where o.company_id = p_company and p_company = adex.ctx_company()   -- solo la empresa del contexto activo
       and o.kind in ('MIGRATION_PARTNER_DEBT', 'MIGRATION_PARTNER_REPAY')
     group by o.route_id, o.admin_membership_id
  $$;
revoke all on function adex.route_partner_debt_internal(text) from public;
grant execute on function adex.route_partner_debt_internal(text) to adex_api;   -- lo usa route_panel (invocador)

-- Lo que las rutas aún le deben a un Administrador (parte de su `admin_payable` que NO es general).
create function adex.admin_partner_debt_outstanding(p_company text, p_admin text) returns bigint
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select coalesce(sum(outstanding_minor), 0)::bigint from adex.route_partner_debt_internal(p_company) where admin_id = p_admin $$;
revoke all on function adex.admin_partner_debt_outstanding(text, text) from public;
grant execute on function adex.admin_partner_debt_outstanding(text, text) to adex_api;

-- JSON de la deuda de una ruta (para el Panel de rutas): una fila por Administrador acreedor con pendiente o historia.
create function adex.route_partner_debt_json(p_company text, p_route text) returns jsonb
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select jsonb_build_object(
             'debtMinor', coalesce(sum(d.debt_minor), 0), 'repaidMinor', coalesce(sum(d.repaid_minor), 0),
             'outstandingMinor', coalesce(sum(d.outstanding_minor), 0), 'isCash', false,
             'creditors', coalesce(jsonb_agg(jsonb_build_object('adminId', d.admin_id, 'name', m.display_name, 'debtMinor', d.debt_minor,
                                                                'repaidMinor', d.repaid_minor, 'outstandingMinor', d.outstanding_minor)
                                             order by m.display_name, d.admin_id) filter (where d.admin_id is not null), '[]'::jsonb))
      from adex.route_partner_debt_internal(p_company) d
      left join adex.memberships m on m.company_id = p_company and m.id = d.admin_id
     where d.route_id = p_route
  $$;
revoke all on function adex.route_partner_debt_json(text, text) from public;
grant execute on function adex.route_partner_debt_json(text, text) to adex_api;

-- ---------- 3. Devolver la deuda con la Base de la MISMA ruta ----------
-- La registra el responsable de capital de la ruta (como cualquier movimiento de su Base). Nunca más que lo pendiente ni
-- más que la Base disponible de la ruta. No toca ninguna otra ruta.
create function adex.route_partner_debt_repay(p_operation_id uuid, p_route text, p_amount bigint, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x         adex.money_ctx;
    v_ctrl    text;
    v_admin   text;
    v_out     bigint;
    v_base    text;
    v_pay     text;
    v_have    bigint;
    v_op      text := gen_random_uuid()::text;
    v_reason  text := btrim(coalesce(p_reason, ''));
  begin
    x := adex.money_context(p_operation_id);
    if x.role is distinct from 'admin' then perform adex.capital_raise('AX402', 'only the responsible administrator moves the base of a route'); end if;
    if adex.company_capital_model(x.company) is distinct from 'route_base' then
      perform adex.capital_raise('AX428', 'the route base model is not active in this company');
    end if;
    if length(v_reason) < 3 or length(v_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    if p_amount is null or p_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
    if p_route is null or not adex.ctx_route_allowed(p_route) then perform adex.capital_raise('AX412', 'route not found'); end if;
    perform 1 from adex.routes where company_id = x.company and id = p_route for update;
    if not found then perform adex.capital_raise('AX412', 'route not found'); end if;
    v_ctrl := adex.route_valid_controller(x.company, p_route);
    if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    if x.actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the route capital controller moves its base'); end if;
    if adex.capital_period_closed(x.company, p_route, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
    if adex.route_in_handover(x.company, p_route) then
      perform adex.capital_raise('AX423', 'the route is being handed over to a new responsible: confirm the count first');
    end if;
    perform pg_advisory_xact_lock(adex.lock_key('route-partner-debt', x.company || ':' || p_route));
    -- Acreedor: el Administrador con deuda pendiente en esta ruta (la más antigua si hubiera varios).
    select d.admin_id, d.outstanding_minor into v_admin, v_out
      from adex.route_partner_debt_internal(x.company) d
      left join lateral (select min(o.created_at) t from adex.capital_operations o where o.company_id = x.company and o.route_id = d.route_id
                           and o.admin_membership_id = d.admin_id and o.kind = 'MIGRATION_PARTNER_DEBT') f on true
     where d.route_id = p_route and d.outstanding_minor > 0
     order by f.t, d.admin_id limit 1;
    if v_admin is null then perform adex.capital_raise('AX447', 'the route owes nothing to its administrator'); end if;
    if p_amount > v_out then perform adex.capital_raise('AX447', 'the repayment exceeds what the route owes'); end if;
    v_base := adex.capital_account_for(x.company, 'route_base', null, p_route);
    v_pay := adex.capital_account_for(x.company, 'admin_payable', v_admin, null);
    perform adex.capital_lock_accounts(x.company, array[v_base, v_pay]);
    select balance_minor into v_have from adex.capital_accounts where company_id = x.company and id = v_base;
    if v_have < p_amount then perform adex.capital_raise('AX401', 'insufficient funds in the base of this route'); end if;
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_op, x.company, p_operation_id, 'MIGRATION_PARTNER_REPAY', p_amount, x.currency, p_route, v_admin,
            v_reason, x.today, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_base, v_pay], array[-p_amount, p_amount]);
    return jsonb_build_object('operationId', v_op, 'routeId', p_route, 'adminId', v_admin, 'amountMinor', p_amount,
                              'outstandingBeforeMinor', v_out, 'outstandingAfterMinor', v_out - p_amount, 'entryDate', x.today);
  end $$;
revoke all on function adex.route_partner_debt_repay(uuid, text, bigint, text) from public;
grant execute on function adex.route_partner_debt_repay(uuid, text, bigint, text) to adex_api;

-- ---------- 4. Lo general deja de contar (y de poder pagar) la deuda de las rutas ----------
-- Reescribe la definición vigente de cada función con un reemplazo exacto (falla si el texto no está una sola vez).
create function pg_temp.patch(p_fn regprocedure, p_from text, p_to text) returns text
  language plpgsql as $$
  declare def text := pg_get_functiondef(p_fn);
  begin
    if (length(def) - length(replace(def, p_from, ''))) / length(p_from) <> 1 then
      raise exception '0052: % should contain this text exactly once: %', p_fn, left(p_from, 120);
    end if;
    return replace(def, p_from, p_to);
  end $$;

do $$
declare def text;
begin
  -- 4a. Saldo a favor por gastos generales: −admin_payable menos lo que le deben las rutas.
  def := pg_temp.patch('adex.admin_payables()'::regprocedure,
    'coalesce(-(select a.balance_minor from adex.capital_accounts a where a.company_id = adex.ctx_company() and a.kind = ''admin_payable'' and a.membership_id = w.m), 0)::bigint',
    '(coalesce(-(select a.balance_minor from adex.capital_accounts a where a.company_id = adex.ctx_company() and a.kind = ''admin_payable'' and a.membership_id = w.m), 0)
             - adex.admin_partner_debt_outstanding(adex.ctx_company(), w.m))::bigint');
  execute def;

  -- 4b. Un reembolso general nunca paga deuda de rutas.
  def := pg_temp.patch('adex.admin_reimbursement_post(uuid, text, bigint, jsonb, text)'::regprocedure,
    'select -balance_minor into v_pending from adex.capital_accounts where company_id = x.company and id = v_payable;',
    'select -balance_minor into v_pending from adex.capital_accounts where company_id = x.company and id = v_payable;
    -- 0052: la deuda de la migración es de cada ruta y se paga solo con su Base (route_partner_debt_repay).
    v_pending := v_pending - adex.admin_partner_debt_outstanding(x.company, p_admin);');
  execute def;

  -- 4c. Anular un gasto con dinero propio ya reembolsado tampoco puede consumir deuda de rutas.
  def := pg_temp.patch('adex.general_expense_reverse(adex.money_ctx, uuid, text, text)'::regprocedure,
    'if (select balance_minor from adex.capital_accounts where company_id = x.company and id = v_payable) + e.amount_minor > 0 then',
    'if (select balance_minor from adex.capital_accounts where company_id = x.company and id = v_payable)
         + adex.admin_partner_debt_outstanding(x.company, e.responsible_admin_membership_id) + e.amount_minor > 0 then');
  execute def;
end $$;

-- ---------- 5. Panel de rutas y detalle ----------
do $$
declare def text;
begin
  -- 5a. Cada ruta trae su deuda y la alerta; los reembolsos pendientes generales ya no la incluyen; total aparte.
  def := pg_temp.patch('adex.route_panel(date, date)'::regprocedure,
    '''differences'', v_dif,',
    '''differences'', v_dif,
        ''partnerDebt'', adex.route_partner_debt_json(v_company, r.id),');
  def := replace(def, $q$case when coalesce(v_needs, 0) > 0 then 'INSUFFICIENT_LIQUIDITY' end], null);$q$,
    $q$case when coalesce(v_needs, 0) > 0 then 'INSUFFICIENT_LIQUIDITY' end,
        -- 0052: la ruta le debe al Administrador lo que cubrió en la migración.
        case when (select coalesce(sum(d.outstanding_minor), 0) from adex.route_partner_debt_internal(v_company) d where d.route_id = r.id) > 0
             then 'PARTNER_DEBT' end], null);$q$);
  if position('PARTNER_DEBT'' end], null);' in def) = 0 and position($q$'PARTNER_DEBT' end], null);$q$ in def) = 0 then
    raise exception '0052: route_panel alerts not patched';
  end if;
  def := replace(def,
    $q$select jsonb_build_object('totalMinor', coalesce(sum(-a.balance_minor), 0), 'isCash', false,
             'admins', coalesce(jsonb_agg(jsonb_build_object('adminId', a.membership_id, 'name', m.display_name, 'pendingMinor', -a.balance_minor)
                         order by m.display_name, a.membership_id), '[]'::jsonb))
      into v_payables
      from adex.capital_accounts a left join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
     where a.company_id = v_company and a.kind = 'admin_payable' and a.balance_minor <> 0;$q$,
    $q$select jsonb_build_object('totalMinor', coalesce(sum(p.pending), 0), 'isCash', false,
             'admins', coalesce(jsonb_agg(jsonb_build_object('adminId', p.membership_id, 'name', p.display_name, 'pendingMinor', p.pending)
                         order by p.display_name, p.membership_id), '[]'::jsonb))
      into v_payables
      from (select a.membership_id, m.display_name,
                   -a.balance_minor - adex.admin_partner_debt_outstanding(v_company, a.membership_id) pending   -- 0052: solo lo general
              from adex.capital_accounts a left join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
             where a.company_id = v_company and a.kind = 'admin_payable') p
     where p.pending <> 0;$q$);
  if position('0052: solo lo general' in def) = 0 then raise exception '0052: route_panel payables not patched'; end if;
  def := replace(def, $q$'pendingAdminReimbursementsMinor', coalesce((v_payables->>'totalMinor')::bigint, 0)),$q$,
    $q$'pendingAdminReimbursementsMinor', coalesce((v_payables->>'totalMinor')::bigint, 0),
                  -- 0052: lo que las rutas les deben a sus Administradores (cada ruta paga la suya con su Base).
                  'routePartnerDebtsMinor', (select coalesce(sum(d.outstanding_minor), 0) from adex.route_partner_debt_internal(v_company) d
                                              where adex.ctx_route_allowed(d.route_id))),$q$);
  if position('routePartnerDebtsMinor' in def) = 0 then raise exception '0052: route_panel consolidated not patched'; end if;
  execute def;

  -- 5b. Movimiento de la Base: «Cubierto por el Administrador», «Devuelto al Administrador» y los cierres de la migración
  --     dejan de caer en «Otros».
  def := pg_temp.patch('adex.route_period_figures(text, text, date, date)'::regprocedure,
    $q$'otherMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b not in ('ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL',$q$,
    $q$'partnerCoverMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'MIGRATION_PARTNER_DEBT'), 0),
             'partnerRepaidMinor', coalesce(-sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'MIGRATION_PARTNER_REPAY'), 0),
             'migrationLoadsMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from
                                                              and b in ('MIGRATION_CASH_COLLECTION', 'MIGRATION_DISBURSEMENT', 'MIGRATION_CASH')), 0),
             'otherMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b not in ('ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL',
                              'MIGRATION_PARTNER_DEBT', 'MIGRATION_PARTNER_REPAY', 'MIGRATION_CASH_COLLECTION', 'MIGRATION_DISBURSEMENT', 'MIGRATION_CASH',$q$);
  execute def;
end $$;

-- ---------- 6. Conciliación ----------
-- La devolución cruza de la Base de la ruta a `admin_payable` (sin ruta), como la deuda; y el saldo a favor de cada
-- Administrador = gastos con dinero propio − reembolsos + deuda de rutas − devoluciones.
do $$
declare def text;
begin
  def := pg_temp.patch('adex.capital_ledger_checks()'::regprocedure,
    $q$'GENERAL_EXPENSE_CONTRIBUTION', 'ADMIN_REIMBURSEMENT', 'MIGRATION_PARTNER_DEBT')$q$,
    $q$'GENERAL_EXPENSE_CONTRIBUTION', 'ADMIN_REIMBURSEMENT', 'MIGRATION_PARTNER_DEBT', 'MIGRATION_PARTNER_REPAY')$q$);
  def := replace(def, $q$coalesce((select sum(o.amount_minor) from adex.capital_operations o where o.company_id = m.company_id$q$,
    $q$coalesce((select sum(case when o.kind = 'MIGRATION_PARTNER_REPAY' then -o.amount_minor else o.amount_minor end)
                                                 from adex.capital_operations o where o.company_id = m.company_id$q$);
  def := replace(def, $q$and o.kind = 'MIGRATION_PARTNER_DEBT' and o.admin_membership_id = m.id), 0)),$q$,
    $q$and o.kind in ('MIGRATION_PARTNER_DEBT', 'MIGRATION_PARTNER_REPAY') and o.admin_membership_id = m.id), 0)),$q$);
  if position($q$then -o.amount_minor else o.amount_minor end)$q$ in def) = 0
     or position($q$o.kind in ('MIGRATION_PARTNER_DEBT', 'MIGRATION_PARTNER_REPAY') and o.admin_membership_id = m.id$q$ in def) = 0 then
    raise exception '0052: capital_ledger_checks adminPayableDrift not patched';
  end if;
  execute def;
end $$;
