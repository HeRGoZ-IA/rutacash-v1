-- 0050 · Migración de rutas REAL, no un cuadre forzado (Helmer, 2026-11-08). Diseño: docs/ADEX_DISENO_MIGRACION_RUTAS_2026-11.md §19.
--
--   · Cada venta con SU VALOR REGISTRADO (valor, total, cuotas, fecha del préstamo y todas sus cuotas).
--   · Primer cierre: lo abonado antes es UN SOLO «abono previo a la migración» por crédito (sin caja).
--   · Cierres siguientes: los abonos son «abonos durante la migración» y ENTRAN a la Base de la ruta; los créditos nuevos
--     SALEN de la Base (desembolso); los gastos e ingresos del cuadre del sistema anterior se registran en la Base.
--   · Caja: el primer cierre abre la Base con la caja del sistema anterior. Si esa caja es NEGATIVA es porque el socio puso
--     de su dinero (pago de la cadena, Helmer 2026-11-08): la Base abre en 0 y queda una DEUDA de la empresa con el
--     Administrador responsable de la ruta (`admin_payable`, la misma de los gastos con dinero propio, se le reembolsa).
--     Si en un cierre la Base no alcanza para un desembolso o un gasto, la diferencia la cubrió el socio: más deuda.
--     Identidad en cada cierre: Base de ADEX = caja del sistema anterior + deuda con el socio. El resultado del cierre
--     muestra la diferencia; «Terminar migración» exige que sea 0.
--   · Comprobaciones de cada cierre contra el cuadre: abonos, desembolsos y caja (además del saldo y la cartera de 0045).
--   · Las correcciones de diferencias (0048) usan la caja cuando el abono es posterior al primer cierre.
--   · Las migraciones EN CURSO se reinician: sus datos se cargaron con el modelo anterior. Se borran SOLO los datos que
--     escribieron las cargas en esas rutas (en migración no admiten ninguna otra escritura, 0043) y la ruta queda en
--     migración, sin cierres. La auditoría se conserva y registra el reinicio.

-- ============================================================
-- 1. Libro: asientos nuevos
-- ============================================================
--   MIGRATION_CASH_COLLECTION  abono durante la migración: Base + / cartera − capital / interés − interés.
--   MIGRATION_DISBURSEMENT     crédito nuevo durante la migración: cartera + capital / Base −.
--   MIGRATION_CASH             caja de apertura positiva o ingreso del cuadre: Base + / financiación de la ruta −.
--   MIGRATION_PARTNER_DEBT     el socio cubrió la caja: deuda con el Administrador (admin_payable −) y Base + (cubre un
--                              faltante en un cierre) o financiación de la ruta + (caja negativa de apertura).
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY', 'WORKER_RETURN',
  'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE',
  'EXPENSE_REFUND', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE',
  'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION',
  'ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE',
  'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT',
  'DIFFERENCE_CONCILIATION', 'MIGRATION_OPENING', 'MIGRATION_COLLECTION', 'MIGRATION_ADJUSTMENT',
  'MIGRATION_CASH_COLLECTION', 'MIGRATION_DISBURSEMENT', 'MIGRATION_CASH', 'MIGRATION_PARTNER_DEBT'));
alter table adex.capital_operations drop constraint capital_operations_sale_shape;
alter table adex.capital_operations add constraint capital_operations_sale_shape
  check ((coalesce(reverses_kind, kind) in ('LOAN_DISBURSEMENT', 'COLLECTION', 'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION',
                                            'MIGRATION_OPENING', 'MIGRATION_COLLECTION', 'MIGRATION_ADJUSTMENT',
                                            'MIGRATION_CASH_COLLECTION', 'MIGRATION_DISBURSEMENT')) = (sale_id is not null));
alter table adex.capital_operations drop constraint capital_operations_reverses_kind_check;
alter table adex.capital_operations add constraint capital_operations_reverses_kind_check
  check (reverses_kind is null or reverses_kind in ('COMPANY_DEPOSIT', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
                                                   'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE',
                                                   'COMPANY_EXPENSE', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ROUTE_BASE_INJECTION',
                                                   'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT',
                                                   'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'MIGRATION_COLLECTION', 'MIGRATION_CASH_COLLECTION'));
alter table adex.capital_operations drop constraint capital_operations_payment_shape;
alter table adex.capital_operations add constraint capital_operations_payment_shape
  check ((coalesce(reverses_kind, kind) in ('COLLECTION', 'MIGRATION_COLLECTION', 'MIGRATION_CASH_COLLECTION')) = (payment_id is not null));
-- La deuda con el socio lleva a quién se le debe.
alter table adex.capital_operations add constraint capital_operations_partner_debt_shape
  check (kind <> 'MIGRATION_PARTNER_DEBT' or (admin_membership_id is not null and route_id is not null));

-- Conciliación (`capital_ledger_checks`, 0036): la deuda con el socio cruza a una cuenta sin ruta (como un reembolso) y
-- el saldo a favor de cada Administrador suma también esa deuda. Se reescribe la definición vigente con esos dos cambios.
do $$
declare
  def text := pg_get_functiondef('adex.capital_ledger_checks()'::regprocedure);
  a   text := '''GENERAL_EXPENSE_CONTRIBUTION'', ''ADMIN_REIMBURSEMENT'')
                               group by o.id, a.route_id having sum(e.amount_minor) <> 0) x),';
  b   text := 'and r.admin_membership_id = m.id and r.reversed_at is null), 0)),';
begin
  if position(a in def) = 0 or position(b in def) = 0 or position(a in substr(def, position(a in def) + 1)) > 0
     or position(b in substr(def, position(b in def) + 1)) > 0 then
    raise exception '0050: capital_ledger_checks does not have the expected text';
  end if;
  def := replace(def, a, '''GENERAL_EXPENSE_CONTRIBUTION'', ''ADMIN_REIMBURSEMENT'', ''MIGRATION_PARTNER_DEBT'')
                               group by o.id, a.route_id having sum(e.amount_minor) <> 0) x),');
  def := replace(def, b, 'and r.admin_membership_id = m.id and r.reversed_at is null), 0)
                                    -- 0050: deuda con el socio de una migración de ruta (caja negativa del sistema anterior).
                                    + coalesce((select sum(o.amount_minor) from adex.capital_operations o where o.company_id = m.company_id
                                                  and o.kind = ''MIGRATION_PARTNER_DEBT'' and o.admin_membership_id = m.id), 0)),');
  execute def;
end $$;

-- RB-D11 (0039/0048): el SuperAdmin anula abonos migrados al corregir una diferencia; ahora también los de caja.
create or replace function adex.guard_reversal_by_admin() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  begin
    if new.reverses_operation_id is not null and new.actor_role is distinct from 'admin'
       and not (new.reverses_kind in ('MIGRATION_COLLECTION', 'MIGRATION_CASH_COLLECTION') and new.actor_role = 'superadmin'
                and exists (select 1 from adex.route_migration_differences d where d.company_id = new.company_id and d.route_id = new.route_id
                              and d.resolved_txid = txid_current())) then
      raise exception 'adex: only an administrator reverses operations (RB-D11)' using errcode = 'AX402';
    end if;
    return new;
  end $$;

-- ============================================================
-- 2. Piezas internas
-- ============================================================
-- Primer cierre de la migración (fecha del corte): lo anterior es «previo a la migración», lo posterior pasa por la caja.
create function adex.route_migration_cut_date(p_company text, p_route text) returns date
  language sql stable
  as $$ select source_report_date from adex.route_migrations where company_id = p_company and route_id = p_route and status = 'en_migracion' $$;
revoke all on function adex.route_migration_cut_date(text, text) from public;

-- Abono de un crédito migrado. p_cash = false: previo a la migración (financiación de la ruta +, sin caja).
-- p_cash = true: durante la migración (Base de la ruta +, como un recaudo).
create function adex.route_migration_collect_internal(x adex.money_ctx, p_route text, p_ctrl text, p_sale text, p_amount bigint,
                                                      p_date date, p_op uuid, p_note text, p_cash boolean) returns void
  language plpgsql
  as $$
  declare
    sl       adex.sales;
    v_pay    text := gen_random_uuid()::text;
    v_op     text := gen_random_uuid()::text;
    v_paid   bigint;
    v_known  bigint;
    v_princ  bigint;
    v_int    bigint;
    v_portf  text := adex.capital_account_for(x.company, 'portfolio', null, p_route);
    v_src    text := adex.capital_account_for(x.company, case when p_cash then 'route_base' else 'route_funding' end, null, p_route);
    v_income text := adex.capital_account_for(x.company, 'income', null, p_route);
  begin
    if p_amount <= 0 then return; end if;
    select * into sl from adex.sales where company_id = x.company and id = p_sale for update;
    select coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0) into v_paid, v_known
      from adex.payments where company_id = x.company and sale_id = sl.id;
    v_princ := adex.credit_principal_of(v_paid + p_amount, sl.sale_value_minor, sl.total_value_minor) - v_known - sl.principal_reclassified_minor;
    v_int := p_amount - v_princ;
    insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, created_by_membership_id, amount_minor,
                               payment_date, payment_type, note, sync_status, created_at, state, ledger_operation_id, principal_minor, interest_minor)
    values (v_pay, x.company, sl.id, sl.client_id, p_route, p_ctrl, x.actor, p_amount, p_date, 'otro', p_note, 'synced', now(), 'active', v_op, v_princ, v_int);
    perform adex.credit_recompute(x.company, sl.id, x.today, p_date);
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, sale_id, payment_id, reason, entry_date, actor_membership_id, actor_identity_id,
                                         actor_role, txid)
    values (v_op, x.company, p_op, case when p_cash then 'MIGRATION_CASH_COLLECTION' else 'MIGRATION_COLLECTION' end, p_amount, x.currency, p_route,
            p_ctrl, null, sl.id, v_pay, left(p_note, 300), p_date, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_src, v_portf, v_income], array[p_amount, -v_princ, -v_int]);
  end $$;
revoke all on function adex.route_migration_collect_internal(adex.money_ctx, text, text, text, bigint, date, uuid, text, boolean) from public;

-- 0048 la usa al corregir diferencias: con la fecha del abono decide si es previo o durante la migración.
create or replace function adex.route_migration_pay_internal(x adex.money_ctx, p_route text, p_ctrl text, p_sale text, p_code text, p_amount bigint,
                                                             p_date date, p_op uuid, p_note text) returns void
  language plpgsql
  as $$
  declare v_cut date := adex.route_migration_cut_date(x.company, p_route);
  begin
    perform adex.route_migration_collect_internal(x, p_route, p_ctrl, p_sale, p_amount, p_date, p_op,
              case when v_cut is not null and p_date > v_cut then replace(p_note, 'Abono previo a la migración', 'Abono durante la migración') else p_note end,
              v_cut is not null and p_date > v_cut);
  end $$;

-- Anulación de un abono migrado (previo o durante la migración), con la fecha del abono. El de caja sale de la Base.
create or replace function adex.route_migration_reverse_internal(x adex.money_ctx, p_route text, p_payment text, p_op uuid, p_reason text) returns bigint
  language plpgsql
  as $$
  declare
    p        adex.payments;
    o        adex.capital_operations;
    sl       adex.sales;
    v_rev    text := gen_random_uuid()::text;
    v_op     text := gen_random_uuid()::text;
    v_paid   bigint;
    v_known  bigint;
    v_princ  bigint;
    v_int    bigint;
    v_portf  text := adex.capital_account_for(x.company, 'portfolio', null, p_route);
    v_src    text;
    v_income text := adex.capital_account_for(x.company, 'income', null, p_route);
  begin
    select * into p from adex.payments where company_id = x.company and id = p_payment for update;
    select * into o from adex.capital_operations where company_id = x.company and id = p.ledger_operation_id;
    if p.state <> 'active' or p.amount_minor <= 0 or o.kind not in ('MIGRATION_COLLECTION', 'MIGRATION_CASH_COLLECTION') then
      perform adex.capital_raise('AX444', 'only payments loaded by the migration are reversed here');
    end if;
    v_src := adex.capital_account_for(x.company, case when o.kind = 'MIGRATION_CASH_COLLECTION' then 'route_base' else 'route_funding' end, null, p_route);
    select * into sl from adex.sales where company_id = x.company and id = p.sale_id for update;
    select coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0) into v_paid, v_known
      from adex.payments where company_id = x.company and sale_id = sl.id;
    v_known := v_known + sl.principal_reclassified_minor;
    v_princ := adex.credit_principal_of(v_paid - p.amount_minor, sl.sale_value_minor, sl.total_value_minor) - v_known;
    v_int := -p.amount_minor - v_princ;
    if v_princ > 0 or v_int > 0 then perform adex.capital_raise('AX420', 'inconsistent principal recognition'); end if;
    insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, created_by_membership_id, amount_minor,
                               payment_date, payment_type, note, sync_status, created_at, state, reverses_payment_id, correction_reason,
                               corrected_by_membership_id, corrected_at, ledger_operation_id, principal_minor, interest_minor)
    values (v_rev, x.company, sl.id, sl.client_id, p_route, p.collector_membership_id, x.actor, -p.amount_minor, p.payment_date, p.payment_type,
            'Anulación del pago ' || p.id, 'synced', now(), 'reversal', p.id, p_reason, x.actor, now(), v_op, v_princ, v_int);
    update adex.payments set state = 'reversed', reversal_payment_id = v_rev, correction_reason = p_reason,
                             corrected_by_membership_id = x.actor, corrected_at = now()
     where company_id = x.company and id = p.id;
    perform adex.credit_recompute(x.company, sl.id, x.today, p.payment_date);
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, sale_id, payment_id, reverses_operation_id, reverses_kind, reason, entry_date,
                                         actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_op, x.company, p_op, 'REVERSAL', p.amount_minor, x.currency, p_route, o.admin_membership_id, null, sl.id, v_rev, o.id,
            o.kind, left(p_reason, 300), x.today, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_src, v_portf, v_income], array[-p.amount_minor, -v_princ, -v_int]);
    return p.amount_minor;
  end $$;

-- 0048 · dejar el saldo en p_target: ahora también anula abonos durante la migración (de caja).
create or replace function adex.route_migration_set_balance_internal(x adex.money_ctx, p_route text, p_ctrl text, p_sale text, p_code text, p_target bigint,
                                                                     p_date date, p_op uuid, p_reason text) returns jsonb
  language plpgsql
  as $$
  declare
    sl       adex.sales;
    p        adex.payments;
    v_before bigint;
    v_need   bigint;
    v_paid   bigint;
    v_rev    bigint := 0;
    v_repay  bigint := 0;
    v_coll   bigint := 0;
    v_extra  bigint := 0;
    v_last   date;
    v_n      int := 0;
  begin
    select * into sl from adex.sales where company_id = x.company and id = p_sale for update;
    v_before := sl.balance_minor;
    if p_target is null or p_target < 0 then perform adex.capital_raise('AX411', 'invalid target balance'); end if;
    if p_target < sl.balance_minor then
      v_coll := sl.balance_minor - p_target;
      perform adex.route_migration_pay_internal(x, p_route, p_ctrl, sl.id, p_code, v_coll, p_date, adex.derived_operation_id(p_op, 'pay'),
                                                'Abono previo a la migración (crédito ' || p_code || ', corrección de diferencia)');
    elsif p_target > sl.balance_minor then
      v_need := p_target - sl.balance_minor;
      select coalesce(sum(amount_minor), 0) into v_paid from adex.payments where company_id = x.company and sale_id = sl.id;
      for p in select q.* from adex.payments q join adex.capital_operations o on o.company_id = q.company_id and o.id = q.ledger_operation_id
                where q.company_id = x.company and q.sale_id = sl.id and q.state = 'active' and q.amount_minor > 0
                  and o.kind in ('MIGRATION_COLLECTION', 'MIGRATION_CASH_COLLECTION')
                order by q.payment_date desc, q.created_at desc, q.id desc loop
        exit when v_rev >= least(v_need, v_paid);
        v_n := v_n + 1;
        v_rev := v_rev + adex.route_migration_reverse_internal(x, p_route, p.id, adex.derived_operation_id(p_op, 'reverse:' || p.id), p_reason);
        v_last := p.payment_date;
      end loop;
      if v_rev < least(v_need, v_paid) then
        perform adex.capital_raise('AX444', 'the credit has payments that were not loaded by the migration');
      end if;
      if v_rev > v_need then
        v_repay := v_rev - v_need;
        perform adex.route_migration_pay_internal(x, p_route, p_ctrl, sl.id, p_code, v_repay, v_last, adex.derived_operation_id(p_op, 'repay'),
                                                  'Abono previo a la migración (crédito ' || p_code || ', parte que se mantiene)');
      end if;
      v_extra := v_need - (v_rev - v_repay);
      if v_extra > 0 then
        if (select coalesce(sum(amount_minor), 0) from adex.payments where company_id = x.company and sale_id = sl.id) <> 0 then
          perform adex.capital_raise('AX420', 'inconsistent principal recognition');
        end if;
        update adex.installments set amount_minor = amount_minor + v_extra
         where company_id = x.company and sale_id = sl.id
           and number = (select max(number) from adex.installments where company_id = x.company and sale_id = sl.id and status <> 'sustituida');
        if not found then perform adex.capital_raise('AX444', 'the credit has no installments to adjust'); end if;
        update adex.sales set total_value_minor = total_value_minor + v_extra, interest_value_minor = interest_value_minor + v_extra, updated_at = now()
         where company_id = x.company and id = sl.id;
        perform adex.credit_recompute(x.company, sl.id, x.today, p_date);
      end if;
    end if;
    select * into sl from adex.sales where company_id = x.company and id = p_sale;
    if sl.balance_minor <> p_target then perform adex.capital_raise('AX420', 'the credit did not reach the expected balance'); end if;
    return jsonb_build_object('balanceBeforeMinor', v_before, 'balanceAfterMinor', sl.balance_minor, 'collectedMinor', v_coll + v_repay,
                              'reversedMinor', v_rev, 'reversedPayments', v_n, 'interestAdjustmentMinor', v_extra);
  end $$;

-- El socio cubrió la caja: si la Base no alcanza para p_need, la diferencia entra a la Base como deuda con el Administrador.
create function adex.route_migration_cover_internal(x adex.money_ctx, p_route text, p_ctrl text, p_need bigint, p_date date, p_op uuid) returns bigint
  language plpgsql
  as $$
  declare
    v_base  text := adex.capital_account_for(x.company, 'route_base', null, p_route);
    v_pay   text := adex.capital_account_for(x.company, 'admin_payable', p_ctrl, null);
    v_have  bigint;
    v_short bigint;
    v_op    text := gen_random_uuid()::text;
  begin
    select balance_minor into v_have from adex.capital_accounts where company_id = x.company and id = v_base for update;
    v_short := p_need - v_have;
    if v_short <= 0 then return 0; end if;
    perform 1 from adex.capital_accounts where company_id = x.company and id = v_pay for update;
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_op, x.company, p_op, 'MIGRATION_PARTNER_DEBT', v_short, x.currency, p_route, p_ctrl,
            'El socio cubrió la caja de la ruta (caja negativa en el sistema anterior)', p_date, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_base, v_pay], array[v_short, -v_short]);
    return v_short;
  end $$;
revoke all on function adex.route_migration_cover_internal(adex.money_ctx, text, text, bigint, date, uuid) from public;

-- ============================================================
-- 3. Carga de un cierre
-- ============================================================
--   Archivo (además de lo de 0045/0048):
--     credits[].schedule   TODAS las cuotas del crédito (1..installmentsCount, suma = totalMinor), con su fecha.
--     cash.closingMinor    caja de la ruta en el sistema anterior al final del día del cierre (puede ser negativa).
--     cash.collectionsMinor / cash.disbursementsMinor   totales del cuadre de los días que abarca el cierre (control).
--     cash.expenses[]      {date, amountMinor, category, concept}: egresos del cuadre (gastos de la ruta).
--     cash.income[]        {date, amountMinor, concept}: ingresos del cuadre.
create or replace function adex.route_migration_load(p_operation_id uuid, p_route text, p_payload jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x          adex.money_ctx;
    r          adex.routes;
    m          adex.route_migrations;
    v_load     text := gen_random_uuid()::text;
    v_ctrl     text;
    v_report   date;
    v_last     date;
    v_cut      date;
    v_first    boolean;
    v_country  char(2);
    v_portf    text;
    v_fund     text;
    v_income   text;
    v_base     text;
    v_payable  text;
    v_clients  jsonb := coalesce(p_payload -> 'clients', '[]'::jsonb);
    v_credits  jsonb := coalesce(p_payload -> 'credits', '[]'::jsonb);
    v_history  jsonb := coalesce(p_payload -> 'history', '[]'::jsonb);
    v_ctl      jsonb := coalesce(p_payload -> 'control', '{}'::jsonb);
    v_cash     jsonb := p_payload -> 'cash';
    v_closing  bigint;
    c          jsonb;
    s          jsonb;
    e          jsonb;
    it         adex.route_migration_items;
    sl         adex.sales;
    d          adex.route_migration_differences;
    lr         adex.route_migration_differences;
    v_cid      text;
    v_sale     text;
    v_op       text;
    v_norm     text;
    v_dup      boolean;
    v_dups     text[] := '{}';
    v_value    bigint;
    v_total    bigint;
    v_balance  bigint;
    v_eff      bigint;
    v_off      bigint;
    v_amt      bigint;
    v_n        int;
    v_sum      numeric;
    v_end      date;
    v_freq     text;
    v_days     smallint[];
    v_granted  date;
    v_during   boolean;
    v_new_cl   int := 0;
    v_new_cr   int := 0;
    v_paid_n   int := 0;
    v_closed_n int := 0;
    v_prev_coll bigint := 0;
    v_coll     bigint := 0;
    v_disb     bigint := 0;
    v_exp      bigint := 0;
    v_inc      bigint := 0;
    v_cover    bigint := 0;
    v_overdue  int := 0;
    v_sum_bal  bigint;
    v_count    int;
    v_result   jsonb;
    v_cat      text;
    v_exp_id   text;
    v_k        int := 0;
    v_debt     bigint;
    v_base_bal bigint;
    i          record;
    v_skip     text[] := '{}';
    v_rep      jsonb;
    v_rstat    text;
    v_rbal     bigint;
    v_new_df   int := 0;
    v_auto_df  int := 0;
    v_adj_a    int;
    v_adj_ab   bigint;
    v_adj_r    int;
    v_adj_rb   bigint;
  begin
    x := adex.money_context(p_operation_id);
    if x.role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the SuperAdmin loads a route migration'); end if;
    if p_route is null or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
      perform adex.capital_raise('AX411', 'route and payload are required');
    end if;
    if exists (select 1 from adex.route_migration_loads where company_id = x.company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;

    select * into r from adex.routes where company_id = x.company and id = p_route for update;
    if not found then perform adex.capital_raise('AX412', 'route not found'); end if;
    select * into m from adex.route_migrations where company_id = x.company and route_id = p_route and status = 'en_migracion' for update;
    if not found then perform adex.capital_raise('AX444', 'the route is not in migration'); end if;
    if adex.company_capital_model(x.company) is distinct from 'route_base' then
      perform adex.capital_raise('AX444', 'route migration needs the Base per Route capital model');
    end if;
    v_ctrl := r.capital_controller_membership_id;
    if v_ctrl is null or not adex.route_controller_valid_internal(x.company, p_route) then
      perform adex.capital_raise('AX408', 'the route needs a valid capital controller (its responsible administrator) before loading');
    end if;
    select max(report_date) into v_last from adex.route_migration_loads where company_id = x.company and migration_id = m.id;
    v_first := v_last is null;

    -- Forma y controles del reporte.
    begin
      v_report := (p_payload ->> 'reportDate')::date;
    exception when others then v_report := null;
    end;
    if v_report is null or v_report > x.today or v_report < m.opened_at::date - 7 then
      perform adex.capital_raise('AX445', 'invalid report date');
    end if;
    if not v_first and v_report <= v_last then
      perform adex.capital_raise('AX445', 'the report date must be after the last loaded close (' || to_char(v_last, 'DD/MM/YYYY') || ')');
    end if;
    v_cut := case when v_first then v_report else m.source_report_date end;
    if jsonb_typeof(v_clients) <> 'array' or jsonb_typeof(v_credits) <> 'array' or jsonb_typeof(v_history) <> 'array'
       or jsonb_array_length(v_clients) = 0 then
      perform adex.capital_raise('AX445', 'clients, credits and history must be lists (at least one client)');
    end if;
    if v_cash is null or jsonb_typeof(v_cash) <> 'object' or jsonb_typeof(v_cash -> 'closingMinor') <> 'number' then
      perform adex.capital_raise('AX445', 'the close needs the cash of the route in the previous system (cash.closingMinor)');
    end if;
    v_closing := (v_cash ->> 'closingMinor')::bigint;
    if jsonb_typeof(coalesce(v_cash -> 'expenses', '[]')) <> 'array' or jsonb_typeof(coalesce(v_cash -> 'income', '[]')) <> 'array' then
      perform adex.capital_raise('AX445', 'cash.expenses and cash.income must be lists');
    end if;
    if v_first and (jsonb_array_length(coalesce(v_cash -> 'expenses', '[]')) > 0 or jsonb_array_length(coalesce(v_cash -> 'income', '[]')) > 0) then
      perform adex.capital_raise('AX445', 'the first close only opens the cash: expenses and income start with the next close');
    end if;
    if (v_ctl ->> 'clients')::int is distinct from jsonb_array_length(v_clients)
       or (v_ctl ->> 'activeCredits')::int is distinct from jsonb_array_length(v_credits) then
      perform adex.capital_raise('AX445', 'the control counts do not match the lists');
    end if;
    if (select count(distinct q ->> 'code') from jsonb_array_elements(v_clients) q) <> jsonb_array_length(v_clients)
       or (select count(distinct q ->> 'code') from jsonb_array_elements(v_credits || v_history) q) <> jsonb_array_length(v_credits) + jsonb_array_length(v_history) then
      perform adex.capital_raise('AX445', 'repeated client or credit codes');
    end if;
    if v_first and (exists (select 1 from adex.clients where company_id = x.company and route_id = p_route)
                    or exists (select 1 from adex.sales where company_id = x.company and route_id = p_route)
                    or exists (select 1 from adex.capital_accounts where company_id = x.company and route_id = p_route and balance_minor <> 0)) then
      perform adex.capital_raise('AX444', 'the route already has data');
    end if;

    insert into adex.route_migration_loads (id, company_id, migration_id, route_id, report_date, operation_id, txid, actor_membership_id, actor_identity_id)
    values (v_load, x.company, m.id, p_route, v_report, p_operation_id, txid_current(), x.actor, x.identity);
    if v_first then
      update adex.route_migrations set source_report_date = v_report where company_id = x.company and id = m.id;
    end if;

    -- ---------- Clientes: altas (el estado lo calcula PostgreSQL, 0049) ----------
    v_country := adex.company_country(x.company);
    for c in select q from jsonb_array_elements(v_clients) q loop
      if nullif(btrim(coalesce(c ->> 'code', '')), '') is null or nullif(btrim(coalesce(c ->> 'name', '')), '') is null
         or nullif(btrim(coalesce(c ->> 'document', '')), '') is null then
        perform adex.capital_raise('AX445', 'every client needs code, name and document');
      end if;
      continue when exists (select 1 from adex.route_migration_items
                             where company_id = x.company and migration_id = m.id and kind = 'client' and source_code = c ->> 'code');
      v_norm := adex.normalize_document((select t.normalization from adex.document_types t
                                          where t.country_code = v_country and t.code = nullif(c ->> 'documentType', '')),
                                        c ->> 'document');
      v_dup := v_norm is not null and exists (select 1 from adex.clients k where k.company_id = x.company
                                                and coalesce(k.document_type, '') = coalesce(nullif(c ->> 'documentType', ''), '')
                                                and k.document_normalized = v_norm and not k.document_legacy_duplicate);
      if v_dup then v_dups := array_append(v_dups, c ->> 'code'); end if;
      v_cid := gen_random_uuid()::text;
      insert into adex.clients (id, company_id, route_id, name, document, document_type, document_legacy_duplicate, phone_primary, phone_secondary,
                                address_primary, address_secondary, status, notes, created_at, updated_at)
      values (v_cid, x.company, p_route, btrim(c ->> 'name'), btrim(c ->> 'document'), nullif(c ->> 'documentType', ''), v_dup,
              coalesce(nullif(btrim(coalesce(c ->> 'phone', '')), ''), '-'), nullif(btrim(coalesce(c ->> 'phone2', '')), ''),
              coalesce(nullif(btrim(coalesce(c ->> 'address', '')), ''), '-'), nullif(btrim(coalesce(c ->> 'address2', '')), ''),
              'inactivo', 'Cliente migrado (código ' || (c ->> 'code') || ')', now(), now());
      insert into adex.route_migration_items (id, company_id, migration_id, route_id, kind, source_code, client_id, data, load_id)
      values (gen_random_uuid()::text, x.company, m.id, p_route, 'client', c ->> 'code', v_cid, jsonb_build_object('documentDuplicate', v_dup), v_load);
      v_new_cl := v_new_cl + 1;
    end loop;

    v_portf   := adex.capital_account_for(x.company, 'portfolio', null, p_route);
    v_fund    := adex.capital_account_for(x.company, 'route_funding', null, p_route);
    v_income  := adex.capital_account_for(x.company, 'income', null, p_route);
    v_base    := adex.capital_account_for(x.company, 'route_base', null, p_route);
    v_payable := adex.capital_account_for(x.company, 'admin_payable', v_ctrl, null);
    perform 1 from adex.capital_accounts where company_id = x.company and id in (v_fund, v_portf, v_income, v_base, v_payable) order by id for update;

    -- ---------- Caja de apertura (primer cierre) ----------
    if v_first then
      if v_closing > 0 then
        v_op := gen_random_uuid()::text;
        insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                             reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
        values (v_op, x.company, adex.derived_operation_id(p_operation_id, 'cash-opening'), 'MIGRATION_CASH', v_closing, x.currency, p_route, v_ctrl,
                'Caja de la ruta al migrar', v_report, x.actor, x.identity, x.role, txid_current());
        perform adex.capital_write_legs(x.company, v_op, array[v_base, v_fund], array[v_closing, -v_closing]);
      elsif v_closing < 0 then
        -- Caja negativa: el socio puso de su dinero (pago de la cadena). La Base abre en 0 y queda la deuda con él.
        v_op := gen_random_uuid()::text;
        insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                             reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
        values (v_op, x.company, adex.derived_operation_id(p_operation_id, 'cash-opening'), 'MIGRATION_PARTNER_DEBT', -v_closing, x.currency, p_route,
                v_ctrl, 'Caja negativa de la ruta al migrar: el socio puso de su dinero (pago de la cadena)', v_report,
                x.actor, x.identity, x.role, txid_current());
        perform adex.capital_write_legs(x.company, v_op, array[v_fund, v_payable], array[-v_closing, v_closing]);
      end if;
    end if;

    -- ---------- 0048 · Diferencias abiertas: solo se actualiza el valor del sistema anterior ----------
    for d in select t.* from adex.route_migration_differences t
              where t.company_id = x.company and t.migration_id = m.id and t.status = 'abierta' order by t.created_at, t.id for update loop
      v_rep := (select q from jsonb_array_elements(v_credits) q where q ->> 'code' = d.source_code limit 1);
      if v_rep is not null then
        v_rstat := 'active'; v_rbal := (v_rep ->> 'balanceMinor')::bigint;
        if v_rbal is null or v_rbal <= 0 then perform adex.capital_raise('AX445', 'credit ' || d.source_code || ': invalid balance'); end if;
      elsif exists (select 1 from jsonb_array_elements(v_history) q where q ->> 'code' = d.source_code) then
        v_rstat := 'paid'; v_rbal := 0;
      else
        v_rstat := 'missing'; v_rbal := null;
      end if;
      select * into sl from adex.sales where company_id = x.company and id = d.sale_id;
      lr := adex.route_migration_last_resolution(x.company, d.sale_id);
      v_off := case when lr.action = 'keep_adex' then lr.kept_offset_minor else 0 end;
      if (sl.status = 'activa' and v_rstat = 'active' and v_rbal - v_off = sl.balance_minor) or (sl.status = 'finalizada' and v_rstat = 'paid') then
        update adex.route_migration_differences
           set source_status = v_rstat, source_balance_minor = v_rbal, source_report_date = v_report, status = 'resuelta', action = 'coincide',
               reason = 'Se corrigió en el sistema anterior', resolved_at = now(), resolved_load_id = v_load, updated_at = now()
         where company_id = x.company and id = d.id;
        v_auto_df := v_auto_df + 1;
      else
        update adex.route_migration_differences
           set source_status = v_rstat, source_balance_minor = v_rbal, source_report_date = v_report, updated_at = now()
         where company_id = x.company and id = d.id;
        v_skip := array_append(v_skip, d.source_code);
      end if;
    end loop;

    -- ---------- 1. Abonos de los créditos ya cargados (entran a la caja) ----------
    for s in select q from jsonb_array_elements(v_credits) q loop
      v_balance := (s ->> 'balanceMinor')::bigint;
      select * into it from adex.route_migration_items
       where company_id = x.company and migration_id = m.id and kind = 'credit' and source_code = s ->> 'code';
      continue when not found;
      continue when (s ->> 'code') = any(v_skip);
      select * into sl from adex.sales where company_id = x.company and id = it.sale_id for update;
      if v_balance is null or v_balance <= 0 then perform adex.capital_raise('AX445', 'credit ' || (s ->> 'code') || ': invalid balance'); end if;
      lr := adex.route_migration_last_resolution(x.company, sl.id);
      if sl.status <> 'activa' then
        continue when lr.action = 'keep_paid';
        perform adex.route_migration_difference_add(x.company, m.id, p_route, sl.id, sl.client_id, s ->> 'code', 'reappeared', sl.status,
                                                    sl.balance_minor, 'active', v_balance, v_load, v_report);
        v_new_df := v_new_df + 1;
        continue;
      end if;
      v_off := case when lr.action = 'keep_adex' then lr.kept_offset_minor else 0 end;
      v_eff := v_balance - v_off;
      if v_eff <= 0 then
        perform adex.capital_raise('AX445', 'credit ' || (s ->> 'code') || ': the balance in the previous system is below the accepted difference');
      end if;
      if v_eff > sl.balance_minor then
        perform adex.route_migration_difference_add(x.company, m.id, p_route, sl.id, sl.client_id, s ->> 'code', 'balance_up', sl.status,
                                                    sl.balance_minor, 'active', v_balance, v_load, v_report);
        v_new_df := v_new_df + 1;
        continue;
      end if;
      if v_eff < sl.balance_minor then
        v_amt := sl.balance_minor - v_eff;
        perform adex.route_migration_collect_internal(x, p_route, v_ctrl, sl.id, v_amt, v_report,
                  adex.derived_operation_id(p_operation_id, 'pay|' || (s ->> 'code')), 'Abono durante la migración (crédito ' || (s ->> 'code') || ')', true);
        v_paid_n := v_paid_n + 1;
        v_coll := v_coll + v_amt;
      end if;
    end loop;

    -- ---------- 2. Créditos cargados que ya no están activos ----------
    for it in select t.* from adex.route_migration_items t join adex.sales v on v.company_id = t.company_id and v.id = t.sale_id
               where t.company_id = x.company and t.migration_id = m.id and t.kind = 'credit' and v.status = 'activa'
                 and not exists (select 1 from jsonb_array_elements(v_credits) q where q ->> 'code' = t.source_code) loop
      continue when it.source_code = any(v_skip);
      if not exists (select 1 from jsonb_array_elements(v_history) q where q ->> 'code' = it.source_code) then
        lr := adex.route_migration_last_resolution(x.company, it.sale_id);
        continue when lr.action = 'still_active';
        select * into sl from adex.sales where company_id = x.company and id = it.sale_id;
        perform adex.route_migration_difference_add(x.company, m.id, p_route, sl.id, sl.client_id, it.source_code, 'missing', sl.status,
                                                    sl.balance_minor, 'missing', null, v_load, v_report);
        v_new_df := v_new_df + 1;
        continue;
      end if;
      -- Pagado: abono por el resto, entra a la caja; la venta queda finalizada.
      select * into sl from adex.sales where company_id = x.company and id = it.sale_id for update;
      v_amt := sl.balance_minor;
      perform adex.route_migration_collect_internal(x, p_route, v_ctrl, sl.id, v_amt, v_report,
                adex.derived_operation_id(p_operation_id, 'pay|' || it.source_code), 'Abono durante la migración (crédito ' || it.source_code || ' pagado)', true);
      v_closed_n := v_closed_n + 1;
      v_coll := v_coll + v_amt;
    end loop;

    -- ---------- 3. Ingresos del cuadre (entran a la caja) ----------
    for e in select q from jsonb_array_elements(coalesce(v_cash -> 'income', '[]')) q loop
      v_k := v_k + 1;
      v_amt := (e ->> 'amountMinor')::bigint;
      if v_amt is null or v_amt <= 0 or (e ->> 'date')::date <= v_last or (e ->> 'date')::date > v_report then
        perform adex.capital_raise('AX445', 'income ' || v_k || ': invalid amount or date');
      end if;
      v_op := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_op, x.company, adex.derived_operation_id(p_operation_id, 'income|' || v_k), 'MIGRATION_CASH', v_amt, x.currency, p_route, v_ctrl,
              left('Ingreso del sistema anterior: ' || coalesce(nullif(btrim(e ->> 'concept'), ''), 'sin concepto'), 300), (e ->> 'date')::date,
              x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_op, array[v_base, v_fund], array[v_amt, -v_amt]);
      v_inc := v_inc + v_amt;
    end loop;

    -- ---------- 4. Créditos nuevos: venta por su valor registrado ----------
    for s in select q from jsonb_array_elements(v_credits) q loop
      continue when exists (select 1 from adex.route_migration_items t
                             where t.company_id = x.company and t.migration_id = m.id and t.kind = 'credit' and t.source_code = s ->> 'code');
      v_balance := (s ->> 'balanceMinor')::bigint;
      v_cid := null;
      select t.client_id into v_cid from adex.route_migration_items t
       where t.company_id = x.company and t.migration_id = m.id and t.kind = 'client' and t.source_code = s ->> 'clientCode';
      if v_cid is null then perform adex.capital_raise('AX445', 'credit ' || coalesce(s ->> 'code', '?') || ': unknown client'); end if;
      v_value   := (s ->> 'valueMinor')::bigint;
      v_total   := (s ->> 'totalMinor')::bigint;
      v_freq    := s ->> 'frequency';
      v_granted := (s ->> 'grantedOn')::date;
      select coalesce(array_agg(d2::smallint order by d2::smallint), '{}') into v_days from jsonb_array_elements_text(coalesce(s -> 'paymentDays', '[]')) d2;
      if v_value is null or v_total is null or v_balance is null or v_value <= 0 or v_total < v_value or v_balance <= 0 or v_balance > v_total
         or v_freq not in ('diaria', 'semanal', 'quincenal', 'mensual') or cardinality(v_days) = 0
         or (s ->> 'installmentValueMinor')::bigint <= 0 or (s ->> 'rate')::numeric < 0 or v_granted is null or v_granted > v_report then
        perform adex.capital_raise('AX445', 'credit ' || coalesce(s ->> 'code', '?') || ': invalid figures');
      end if;
      -- Calendario COMPLETO: todas las cuotas pactadas, suma = total.
      select count(*), coalesce(sum((q ->> 'amountMinor')::numeric), 0), max((q ->> 'dueDate')::date) into v_n, v_sum, v_end
        from jsonb_array_elements(coalesce(s -> 'schedule', '[]')) q;
      if v_n = 0 or v_n <> (s ->> 'installmentsCount')::int or v_sum <> v_total
         or exists (select 1 from jsonb_array_elements(s -> 'schedule') with ordinality y(q, k)
                     where (q ->> 'number')::int <> k or (q ->> 'amountMinor')::bigint <= 0 or (q ->> 'dueDate')::date <= v_granted
                        or (k > 1 and (q ->> 'dueDate')::date < ((s -> 'schedule') -> (k::int - 2) ->> 'dueDate')::date)) then
        perform adex.capital_raise('AX445', 'credit ' || (s ->> 'code') || ': the schedule must have all its installments and add up to the total');
      end if;
      -- Prestado después del corte = desembolso durante la migración (sale de la caja); antes = cartera de apertura.
      v_during := not v_first and v_granted > v_cut;
      v_sale := gen_random_uuid()::text;
      v_op   := gen_random_uuid()::text;
      insert into adex.sales (id, company_id, route_id, client_id, created_by_membership_id, sale_value_minor, interest_rate, interest_value_minor,
                              total_value_minor, balance_minor, installments_count, installment_value_minor, payment_frequency, payment_days,
                              start_date, estimated_end_date, status, disbursement_status, disbursed_by_collector_id, disbursed_by_membership_id,
                              disbursement_date, delivered_on, disbursed_at, sale_request_id, ledger_operation_id, created_at, updated_at)
      values (v_sale, x.company, p_route, v_cid, x.actor, v_value, (s ->> 'rate')::numeric, v_total - v_value, v_total, v_total, v_n,
              (s ->> 'installmentValueMinor')::bigint, v_freq, v_days, v_granted, v_end, 'activa', 'desembolsado', null, v_ctrl,
              v_granted, v_granted, now(), null, v_op, now(), now());
      for i in select (q ->> 'number')::int n, (q ->> 'dueDate')::date dd, (q ->> 'amountMinor')::bigint a from jsonb_array_elements(s -> 'schedule') q loop
        insert into adex.installments (id, company_id, sale_id, number, due_date, amount_minor, paid_minor, balance_minor, status, days_overdue)
        values (gen_random_uuid()::text, x.company, v_sale, i.n, i.dd, i.a, 0, i.a, 'pendiente', 0);
      end loop;
      perform adex.credit_recompute(x.company, v_sale, x.today, null);
      if v_during then
        v_cover := v_cover + adex.route_migration_cover_internal(x, p_route, v_ctrl, v_value, v_granted,
                                                                 adex.derived_operation_id(p_operation_id, 'cover|' || (s ->> 'code')));
        insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                             worker_membership_id, sale_request_id, sale_id, reason, entry_date, actor_membership_id,
                                             actor_identity_id, actor_role, txid)
        values (v_op, x.company, adex.derived_operation_id(p_operation_id, 'credit|' || (s ->> 'code')), 'MIGRATION_DISBURSEMENT', v_value, x.currency,
                p_route, v_ctrl, null, null, v_sale, 'Crédito entregado durante la migración (crédito ' || (s ->> 'code') || ')', v_granted,
                x.actor, x.identity, x.role, txid_current());
        perform adex.capital_write_legs(x.company, v_op, array[v_base, v_portf], array[-v_value, v_value]);
        v_disb := v_disb + v_value;
      else
        insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                             worker_membership_id, sale_request_id, sale_id, reason, entry_date, actor_membership_id,
                                             actor_identity_id, actor_role, txid)
        values (v_op, x.company, adex.derived_operation_id(p_operation_id, 'credit|' || (s ->> 'code')), 'MIGRATION_OPENING', v_value, x.currency,
                p_route, v_ctrl, null, null, v_sale, 'Cartera migrada (crédito ' || (s ->> 'code') || ')', v_report,
                x.actor, x.identity, x.role, txid_current());
        perform adex.capital_write_legs(x.company, v_op, array[v_fund, v_portf], array[-v_value, v_value]);
      end if;
      -- Lo ya pagado: un solo abono, previo a la migración (cartera de apertura) o durante ella (entra a la caja).
      v_amt := v_total - v_balance;
      if v_amt > 0 then
        perform adex.route_migration_collect_internal(x, p_route, v_ctrl, v_sale, v_amt, v_report,
                  adex.derived_operation_id(p_operation_id, 'pay|' || (s ->> 'code')),
                  case when v_during then 'Abono durante la migración (crédito ' || (s ->> 'code') || ')'
                       else 'Abono previo a la migración (crédito ' || (s ->> 'code') || ')' end, v_during);
        if v_during then v_coll := v_coll + v_amt; else v_prev_coll := v_prev_coll + v_amt; end if;
      end if;
      if (select balance_minor from adex.sales where company_id = x.company and id = v_sale) <> v_balance then
        perform adex.capital_raise('AX420', 'credit ' || (s ->> 'code') || ': the balance after the previous payments does not match');
      end if;
      insert into adex.route_migration_items (id, company_id, migration_id, route_id, kind, source_code, client_id, sale_id, data, load_id)
      values (gen_random_uuid()::text, x.company, m.id, p_route, 'credit', s ->> 'code', v_cid, v_sale,
              jsonb_build_object('grantedOn', s ->> 'grantedOn', 'valueMinor', v_value, 'totalMinor', v_total, 'balanceMinor', v_balance,
                                 'paidBeforeMinor', v_total - v_balance, 'installmentsCount', v_n,
                                 'installmentValueMinor', (s ->> 'installmentValueMinor')::bigint, 'frequency', v_freq,
                                 'overdueListos', (s ->> 'overdueListos')::int, 'lastPaymentOn', s ->> 'lastPaymentOn', 'duringMigration', v_during), v_load);
      v_new_cr := v_new_cr + 1;
    end loop;

    -- ---------- 5. Gastos del cuadre (salen de la caja) ----------
    v_k := 0;
    for e in select q from jsonb_array_elements(coalesce(v_cash -> 'expenses', '[]')) q loop
      v_k := v_k + 1;
      v_amt := (e ->> 'amountMinor')::bigint;
      if v_amt is null or v_amt <= 0 or (e ->> 'date')::date <= v_last or (e ->> 'date')::date > v_report then
        perform adex.capital_raise('AX445', 'expense ' || v_k || ': invalid amount or date');
      end if;
      select k.id into v_cat from adex.expense_categories k
       where k.company_id = x.company and adex.expense_category_key(k.name) = adex.expense_category_key(coalesce(nullif(btrim(e ->> 'category'), ''), 'Otros'))
       order by k.active desc, k.id limit 1;
      if v_cat is null then
        select k.id into v_cat from adex.expense_categories k
         where k.company_id = x.company and adex.expense_category_key(k.name) = 'otros' order by k.active desc, k.id limit 1;
      end if;
      if v_cat is null then perform adex.capital_raise('AX445', 'expense ' || v_k || ': the company has no category «Otros»'); end if;
      v_cover := v_cover + adex.route_migration_cover_internal(x, p_route, v_ctrl, v_amt, (e ->> 'date')::date,
                                                               adex.derived_operation_id(p_operation_id, 'cover-expense|' || v_k));
      v_exp_id := gen_random_uuid()::text;
      v_op := gen_random_uuid()::text;
      insert into adex.expenses (id, company_id, route_id, scope, category_id, amount_minor, description, expense_date, registered_by_membership_id,
                                 collector_membership_id, funding, funding_admin_membership_id, reference, sync_status, created_at, ledger_operation_id)
      values (v_exp_id, x.company, p_route, 'ruta', v_cat, v_amt,
              left('Gasto del sistema anterior: ' || coalesce(nullif(btrim(e ->> 'concept'), ''), 'sin concepto'), 300), (e ->> 'date')::date, x.actor,
              null, null, null, null, 'synced', now(), v_op);
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, expense_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_op, x.company, adex.derived_operation_id(p_operation_id, 'expense|' || v_k), 'ROUTE_EXPENSE', v_amt, x.currency, p_route, v_ctrl, null,
              v_exp_id, left('Gasto del sistema anterior: ' || coalesce(nullif(btrim(e ->> 'concept'), ''), 'sin concepto'), 300), (e ->> 'date')::date,
              x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_op, array[v_base, adex.capital_account_for(x.company, 'expense', null, p_route)], array[-v_amt, v_amt]);
      v_exp := v_exp + v_amt;
    end loop;

    -- ---------- Historial de pagados (los que aún no estaban) ----------
    for s in select q from jsonb_array_elements(v_history) q loop
      continue when exists (select 1 from adex.route_migration_items t where t.company_id = x.company and t.migration_id = m.id
                              and t.kind = 'paid_credit' and t.source_code = s ->> 'code');
      v_cid := null;
      select t.client_id into v_cid from adex.route_migration_items t
       where t.company_id = x.company and t.migration_id = m.id and t.kind = 'client' and t.source_code = s ->> 'clientCode';
      if v_cid is null then perform adex.capital_raise('AX445', 'paid credit ' || coalesce(s ->> 'code', '?') || ': unknown client'); end if;
      insert into adex.route_migration_items (id, company_id, migration_id, route_id, kind, source_code, client_id, data, load_id)
      values (gen_random_uuid()::text, x.company, m.id, p_route, 'paid_credit', s ->> 'code', v_cid,
              jsonb_build_object('grantedOn', s ->> 'grantedOn', 'valueMinor', (s ->> 'valueMinor')::bigint, 'totalMinor', (s ->> 'totalMinor')::bigint,
                                 'installmentsCount', (s ->> 'installmentsCount')::int, 'frequency', s ->> 'frequency', 'lastPaymentOn', s ->> 'lastPaymentOn'),
              v_load);
    end loop;

    -- ---------- Control: créditos (0045/0048) ----------
    select count(*), coalesce(sum(v.balance_minor), 0),
           count(*) filter (where exists (select 1 from adex.installments n where n.company_id = v.company_id and n.sale_id = v.id and n.status = 'vencida'))
      into v_count, v_sum_bal, v_overdue
      from adex.sales v where v.company_id = x.company and v.route_id = p_route and v.status = 'activa';
    select coalesce(sum(case when v.status = 'activa' then 1 else 0 end), 0), coalesce(sum(case when v.status = 'activa' then v.balance_minor else 0 end), 0),
           coalesce(sum(case when q.e is not null then 1 else 0 end), 0), coalesce(sum(coalesce((q.e ->> 'balanceMinor')::bigint, 0)), 0)
      into v_adj_a, v_adj_ab, v_adj_r, v_adj_rb
      from (select distinct t.sale_id, t.source_code from adex.route_migration_differences t
             where t.company_id = x.company and t.migration_id = m.id
               and (t.status = 'abierta'
                    or (adex.route_migration_last_resolution(x.company, t.sale_id)).action in ('keep_adex', 'still_active', 'keep_paid'))) dd
      join adex.sales v on v.company_id = x.company and v.id = dd.sale_id
      left join lateral (select q as e from jsonb_array_elements(v_credits) q where q ->> 'code' = dd.source_code limit 1) q on true;
    if v_count - v_adj_a <> jsonb_array_length(v_credits) - v_adj_r
       or v_sum_bal - v_adj_ab is distinct from (v_ctl ->> 'balanceMinor')::bigint - v_adj_rb then
      perform adex.capital_raise('AX445', 'after the load, the route in ADEX (' || v_count || ' active, balance ' || v_sum_bal
                                          || ') does not match the report (' || jsonb_array_length(v_credits) || ' active, balance '
                                          || coalesce(v_ctl ->> 'balanceMinor', '?') || ')'
                                          || case when v_adj_a + v_adj_r > 0 then ' after setting aside the credits with differences' else '' end);
    end if;

    -- ---------- Control: caja. Base de ADEX = caja del sistema anterior + deuda con el socio ----------
    select balance_minor into v_base_bal from adex.capital_accounts where company_id = x.company and id = v_base;
    select coalesce(sum(o.amount_minor), 0) into v_debt from adex.capital_operations o
     where o.company_id = x.company and o.route_id = p_route and o.kind = 'MIGRATION_PARTNER_DEBT';

    v_result := jsonb_build_object(
      'migrationId', m.id, 'loadId', v_load, 'routeId', p_route, 'routeName', r.name, 'status', 'en_migracion', 'reportDate', v_report,
      'firstLoad', v_first, 'previousReportDate', v_last,
      'clients', (select count(*) from adex.clients where company_id = x.company and route_id = p_route),
      'activeClients', (select count(distinct client_id) from adex.sales where company_id = x.company and route_id = p_route and status = 'activa'),
      'newClients', v_new_cl, 'newCredits', v_new_cr, 'creditsWithPayments', v_paid_n, 'creditsPaidOff', v_closed_n,
      'collectedInListosMinor', v_coll, 'paidBeforeMigrationMinor', v_prev_coll,
      'activeCredits', v_count, 'paidCredits', (select count(*) from adex.route_migration_items where company_id = x.company and migration_id = m.id and kind = 'paid_credit'),
      'balanceMinor', v_sum_bal, 'principalMinor', (select balance_minor from adex.capital_accounts where company_id = x.company and id = v_portf),
      'creditsOverdue', v_overdue, 'duplicateDocuments', to_jsonb(v_dups),
      'listos', coalesce(p_payload -> 'listos', '{}'::jsonb),
      'newDifferences', v_new_df, 'resolvedDifferences', v_auto_df,
      'openDifferences', (select count(*) from adex.route_migration_differences where company_id = x.company and migration_id = m.id and status = 'abierta'),
      'differences', adex.route_migration_differences_json(x.company, m.id, true),
      -- 0050 · caja y cuadre del sistema anterior.
      'cash', jsonb_build_object(
        'sourceClosingMinor', v_closing, 'partnerDebtMinor', v_debt, 'partnerCoverMinor', v_cover, 'baseMinor', v_base_bal,
        'expectedBaseMinor', v_closing + v_debt, 'differenceMinor', v_base_bal - (v_closing + v_debt),
        'collectionsMinor', v_coll, 'sourceCollectionsMinor', (v_cash ->> 'collectionsMinor')::bigint,
        'collectionsDifferenceMinor', case when v_cash ? 'collectionsMinor' and not v_first then v_coll - (v_cash ->> 'collectionsMinor')::bigint end,
        'disbursementsMinor', v_disb, 'sourceDisbursementsMinor', (v_cash ->> 'disbursementsMinor')::bigint,
        'disbursementsDifferenceMinor', case when v_cash ? 'disbursementsMinor' and not v_first then v_disb - (v_cash ->> 'disbursementsMinor')::bigint end,
        'expensesMinor', v_exp, 'incomeMinor', v_inc,
        'debtHolderMembershipId', v_ctrl),
      'responsibleMembershipId', v_ctrl, 'businessDate', x.today);
    update adex.route_migration_loads set result = v_result where company_id = x.company and id = v_load;
    return v_result;
  exception
    when unique_violation then
      if sqlerrm like '%capital_operations_operation_key%' or sqlerrm like '%route_migration_loads_operation_key%' then
        perform adex.capital_raise('AX409', 'operation id already used');
      end if;
      if sqlerrm like '%route_migration_loads_day_key%' then perform adex.capital_raise('AX445', 'that close is already loaded'); end if;
      raise;
    when check_violation then
      if sqlerrm like '%capital_accounts_no_overdraft%' then perform adex.capital_raise('AX445', 'the route cash would go below zero'); end if;
      raise;
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
      perform adex.capital_raise('AX445', 'invalid value in the payload: ' || sqlerrm);
  end $$;

-- ============================================================
-- 4. Terminar: además de cero diferencias, la caja tiene que cuadrar con el sistema anterior
-- ============================================================
create or replace function adex.route_migration_close(p_operation_id uuid, p_route text, p_note text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x      adex.money_ctx;
    m      adex.route_migrations;
    v_last adex.route_migration_loads;
    v_note text := nullif(btrim(coalesce(p_note, '')), '');
    v_open int;
    v_diff bigint;
    v_res  jsonb;
  begin
    x := adex.money_context(p_operation_id);
    if x.role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the SuperAdmin finishes a route migration'); end if;
    if p_route is null then perform adex.capital_raise('AX411', 'route is required'); end if;
    if v_note is not null and length(v_note) > 500 then perform adex.capital_raise('AX411', 'note is too long'); end if;
    if exists (select 1 from adex.route_migrations where company_id = x.company and close_operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    perform 1 from adex.routes where company_id = x.company and id = p_route for update;
    select * into m from adex.route_migrations where company_id = x.company and route_id = p_route and status = 'en_migracion' for update;
    if not found then perform adex.capital_raise('AX444', 'the route is not in migration'); end if;
    select * into v_last from adex.route_migration_loads where company_id = x.company and migration_id = m.id order by report_date desc limit 1;
    if not found then perform adex.capital_raise('AX444', 'load at least one close before finishing the migration'); end if;
    select count(*) into v_open from adex.route_migration_differences where company_id = x.company and migration_id = m.id and status = 'abierta';
    if v_open > 0 then
      perform adex.capital_raise('AX444', 'there are ' || v_open || ' open differences: resolve them before finishing the migration');
    end if;
    -- 0050: la Base de ADEX = caja del sistema anterior + deuda con el socio, al último cierre y ahora.
    v_diff := (select balance_minor from adex.capital_accounts where company_id = x.company and id = adex.capital_account_for(x.company, 'route_base', null, p_route))
              - ((v_last.result #>> '{cash,sourceClosingMinor}')::bigint
                 + (select coalesce(sum(o.amount_minor), 0) from adex.capital_operations o
                     where o.company_id = x.company and o.route_id = p_route and o.kind = 'MIGRATION_PARTNER_DEBT'));
    if v_diff is null or v_diff <> 0 then
      perform adex.capital_raise('AX444', 'the route cash in ADEX does not match the previous system (difference ' || coalesce(v_diff::text, '?')
                                          || '): review the last close before finishing');
    end if;
    v_res := (v_last.result - 'differences') || jsonb_build_object('status', 'finalizada', 'lastReportDate', v_last.report_date,
               'loads', (select count(*) from adex.route_migration_loads where company_id = x.company and migration_id = m.id),
               'openDifferences', 0,
               'resolvedDifferences', (select count(*) from adex.route_migration_differences where company_id = x.company and migration_id = m.id));
    update adex.route_migrations
       set status = 'finalizada', closed_at = now(), closed_by_membership_id = x.actor, closed_by_identity_id = x.identity,
           close_operation_id = p_operation_id, closed_txid = txid_current(),
           close_reason = coalesce(v_note, 'Migración terminada con el cierre del ' || to_char(v_last.report_date, 'DD/MM/YYYY')),
           result = v_res
     where company_id = x.company and id = m.id;
    update adex.routes set migration_state = 'normal', updated_at = now() where company_id = x.company and id = p_route;
    return v_res || jsonb_build_object('closedAt', now());
  end $$;

-- ============================================================
-- 5. Reinicio de las migraciones EN CURSO (se cargaron con el modelo anterior)
-- ============================================================
-- Solo los datos que escribieron las cargas en rutas en migración (0043 bloquea cualquier otra escritura en ellas).
-- La ruta sigue en migración, sin cierres; su auditoría se conserva y registra el reinicio.
create policy owner_0050_clients on adex.clients for delete to adex_owner using (true);
create policy owner_0050_sales on adex.sales for delete to adex_owner using (true);
create policy owner_0050_installments on adex.installments for delete to adex_owner using (true);
create policy owner_0050_payments on adex.payments for delete to adex_owner using (true);
create policy owner_0050_expenses on adex.expenses for delete to adex_owner using (true);
create policy owner_0050_audit on adex.audit_log for insert to adex_owner with check (true);
alter table adex.route_migration_items disable trigger user;
alter table adex.route_migration_loads disable trigger user;
alter table adex.route_migration_differences disable trigger user;
alter table adex.capital_entries disable trigger user;
alter table adex.capital_operations disable trigger user;
alter table adex.capital_accounts disable trigger user;
alter table adex.payments disable trigger user;
alter table adex.installments disable trigger user;
alter table adex.sales disable trigger user;
alter table adex.clients disable trigger user;
alter table adex.expenses disable trigger user;
do $$
declare
  m   record;
  v_n jsonb;
begin
  for m in select g.* from adex.route_migrations g
            where g.status = 'en_migracion' and exists (select 1 from adex.route_migration_loads l where l.company_id = g.company_id and l.migration_id = g.id)
            order by g.company_id, g.id loop
    v_n := jsonb_build_object(
      'loads', (select count(*) from adex.route_migration_loads where company_id = m.company_id and migration_id = m.id),
      'clients', (select count(*) from adex.clients where company_id = m.company_id and route_id = m.route_id),
      'sales', (select count(*) from adex.sales where company_id = m.company_id and route_id = m.route_id),
      'payments', (select count(*) from adex.payments where company_id = m.company_id and route_id = m.route_id),
      'operations', (select count(*) from adex.capital_operations where company_id = m.company_id and route_id = m.route_id));
    if exists (select 1 from adex.capital_operations where company_id = m.company_id and route_id = m.route_id
                and kind not in ('MIGRATION_OPENING', 'MIGRATION_COLLECTION', 'MIGRATION_ADJUSTMENT', 'REVERSAL')) then
      raise exception '0050: route % in migration has operations that were not written by a migration load', m.route_id;
    end if;
    delete from adex.route_migration_differences where company_id = m.company_id and migration_id = m.id;
    delete from adex.route_migration_items where company_id = m.company_id and migration_id = m.id;
    delete from adex.route_migration_loads where company_id = m.company_id and migration_id = m.id;
    delete from adex.capital_entries e using adex.capital_operations o
     where e.company_id = m.company_id and o.company_id = e.company_id and o.id = e.operation_id and o.route_id = m.route_id;
    update adex.payments set reversal_payment_id = null where company_id = m.company_id and route_id = m.route_id and reversal_payment_id is not null;
    delete from adex.payments where company_id = m.company_id and route_id = m.route_id;
    delete from adex.installments t using adex.sales v where t.company_id = m.company_id and v.company_id = t.company_id and v.id = t.sale_id and v.route_id = m.route_id;
    delete from adex.capital_operations where company_id = m.company_id and route_id = m.route_id;
    delete from adex.sales where company_id = m.company_id and route_id = m.route_id;
    delete from adex.clients where company_id = m.company_id and route_id = m.route_id;
    update adex.capital_accounts set balance_minor = 0, updated_at = now() where company_id = m.company_id and route_id = m.route_id and balance_minor <> 0;
    update adex.route_migrations set source_report_date = null where company_id = m.company_id and id = m.id;
    insert into adex.audit_log (id, company_id, actor_system, route_id, action, entity_type, entity_id, description, before_data, reason, created_at)
    values (gen_random_uuid()::text, m.company_id, 'system:migration:0050', m.route_id, 'ROUTE_MIGRATION_RESTARTED', 'route_migration', m.id,
            'Migración reiniciada: las ventas se vuelven a cargar con su valor registrado, abonos, gastos y caja', v_n,
            'Corrección de la migración (venta real, caja y gastos del sistema anterior)', now());
  end loop;
end $$;
-- Las referencias diferidas (ventas ↔ asientos) se comprueban ya, antes de volver a activar los disparadores.
set constraints all immediate;
alter table adex.route_migration_items enable trigger user;
alter table adex.route_migration_loads enable trigger user;
alter table adex.route_migration_differences enable trigger user;
alter table adex.capital_entries enable trigger user;
alter table adex.capital_operations enable trigger user;
alter table adex.capital_accounts enable trigger user;
alter table adex.payments enable trigger user;
alter table adex.installments enable trigger user;
alter table adex.sales enable trigger user;
alter table adex.clients enable trigger user;
alter table adex.expenses enable trigger user;
drop policy owner_0050_clients on adex.clients;
drop policy owner_0050_sales on adex.sales;
drop policy owner_0050_installments on adex.installments;
drop policy owner_0050_payments on adex.payments;
drop policy owner_0050_expenses on adex.expenses;
drop policy owner_0050_audit on adex.audit_log;
