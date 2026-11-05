-- 0046 · Migración de rutas: sin el nombre del sistema anterior en ADEX (pedido de Helmer, 2026-11-05).
-- «No me gusta ver en NUESTRA plataforma el nombre de Listos». Los textos que ven las personas dicen «sistema anterior»:
--   · cliente: «Cliente migrado (código X)»; abono: «Abono previo a la migración (crédito X)»; cartera: «Cartera migrada (crédito X)».
--   · `route_migration_load` (0045) igual, solo cambian esos textos y los mensajes de error de la vista previa.
--   · Se reescriben los textos ya guardados (notas de clientes y abonos, descripción del libro y de la auditoría). Solo el
--     TEXTO: importes, fechas, asientos y estados no se tocan. Las protecciones (libro inmutable, auditoría de solo
--     añadir, ruta en migración de solo lectura) se apagan solo durante esta transacción y vuelven a encenderse.
-- Las claves internas (`source_system = 'listos'`, `overdueListos`, `collectedInListosMinor`) no se muestran y no cambian.

-- ============================================================
-- 1. Carga de un cierre: textos nuevos
-- ============================================================
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
    v_first    boolean;
    v_country  char(2);
    v_portf    text;
    v_fund     text;
    v_income   text;
    v_clients  jsonb := coalesce(p_payload -> 'clients', '[]'::jsonb);
    v_credits  jsonb := coalesce(p_payload -> 'credits', '[]'::jsonb);
    v_history  jsonb := coalesce(p_payload -> 'history', '[]'::jsonb);
    v_ctl      jsonb := coalesce(p_payload -> 'control', '{}'::jsonb);
    c          jsonb;
    s          jsonb;
    it         adex.route_migration_items;
    sl         adex.sales;
    v_cid      text;
    v_sale     text;
    v_op       text;
    v_pay      text;
    v_norm     text;
    v_dup      boolean;
    v_dups     text[] := '{}';
    v_value    bigint;
    v_total    bigint;
    v_balance  bigint;
    v_princ    bigint;
    v_amt      bigint;
    v_paid     bigint;
    v_known    bigint;
    v_int      bigint;
    v_n        int;
    v_sum      numeric;
    v_end      date;
    v_freq     text;
    v_days     smallint[];
    v_new_cl   int := 0;
    v_new_cr   int := 0;
    v_paid_n   int := 0;
    v_closed_n int := 0;
    v_coll     bigint := 0;
    v_overdue  int := 0;
    v_sum_bal  bigint;
    v_sum_cap  bigint;
    v_count    int;
    v_result   jsonb;
    i          record;
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
    if jsonb_typeof(v_clients) <> 'array' or jsonb_typeof(v_credits) <> 'array' or jsonb_typeof(v_history) <> 'array'
       or jsonb_array_length(v_clients) = 0 then
      perform adex.capital_raise('AX445', 'clients, credits and history must be lists (at least one client)');
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

    -- La marca de esta carga (txid) habilita las escrituras en la ruta en migración (0043).
    insert into adex.route_migration_loads (id, company_id, migration_id, route_id, report_date, operation_id, txid, actor_membership_id, actor_identity_id)
    values (v_load, x.company, m.id, p_route, v_report, p_operation_id, txid_current(), x.actor, x.identity);
    if v_first then
      update adex.route_migrations set source_report_date = v_report where company_id = x.company and id = m.id;
    end if;

    -- ---------- Clientes: altas y reactivaciones ----------
    v_country := adex.company_country(x.company);
    for c in select e from jsonb_array_elements(v_clients) e loop
      if nullif(btrim(coalesce(c ->> 'code', '')), '') is null or nullif(btrim(coalesce(c ->> 'name', '')), '') is null
         or nullif(btrim(coalesce(c ->> 'document', '')), '') is null then
        perform adex.capital_raise('AX445', 'every client needs code, name and document');
      end if;
      select * into it from adex.route_migration_items
       where company_id = x.company and migration_id = m.id and kind = 'client' and source_code = c ->> 'code';
      if found then
        if (c ->> 'active')::boolean then
          update adex.clients set status = 'activo', updated_at = now()
           where company_id = x.company and id = it.client_id and status = 'inactivo';
        end if;
        continue;
      end if;
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
              case when (c ->> 'active')::boolean then 'activo' else 'inactivo' end,
              'Cliente migrado (código ' || (c ->> 'code') || ')', now(), now());
      insert into adex.route_migration_items (id, company_id, migration_id, route_id, kind, source_code, client_id, data, load_id)
      values (gen_random_uuid()::text, x.company, m.id, p_route, 'client', c ->> 'code', v_cid, jsonb_build_object('documentDuplicate', v_dup), v_load);
      v_new_cl := v_new_cl + 1;
    end loop;

    v_portf  := adex.capital_account_for(x.company, 'portfolio', null, p_route);
    v_fund   := adex.capital_account_for(x.company, 'route_funding', null, p_route);
    v_income := adex.capital_account_for(x.company, 'income', null, p_route);
    perform 1 from adex.capital_accounts where company_id = x.company and id in (v_fund, v_portf, v_income) order by id for update;

    -- ---------- Créditos activos del reporte ----------
    for s in select e from jsonb_array_elements(v_credits) e loop
      v_balance := (s ->> 'balanceMinor')::bigint;
      select * into it from adex.route_migration_items
       where company_id = x.company and migration_id = m.id and kind = 'credit' and source_code = s ->> 'code';
      if found then
        -- Crédito ya cargado: la baja de saldo es un abono hecho en el sistema anterior.
        select * into sl from adex.sales where company_id = x.company and id = it.sale_id for update;
        if sl.status <> 'activa' then perform adex.capital_raise('AX445', 'credit ' || (s ->> 'code') || ': it was finished and appears active again'); end if;
        if v_balance is null or v_balance <= 0 then perform adex.capital_raise('AX445', 'credit ' || (s ->> 'code') || ': invalid balance'); end if;
        if v_balance > sl.balance_minor then
          perform adex.capital_raise('AX445', 'credit ' || (s ->> 'code') || ': the balance went up in the previous system (' || sl.balance_minor || ' → ' || v_balance
                                              || '); check the correction in the previous system');
        end if;
        if v_balance < sl.balance_minor then
          v_amt := sl.balance_minor - v_balance;
          v_pay := gen_random_uuid()::text;
          v_op  := gen_random_uuid()::text;
          select coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0) into v_paid, v_known
            from adex.payments where company_id = x.company and sale_id = sl.id;
          v_princ := adex.credit_principal_of(v_paid + v_amt, sl.sale_value_minor, sl.total_value_minor) - v_known - sl.principal_reclassified_minor;
          v_int := v_amt - v_princ;
          insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, created_by_membership_id, amount_minor,
                                     payment_date, payment_type, note, sync_status, created_at, state, ledger_operation_id, principal_minor, interest_minor)
          values (v_pay, x.company, sl.id, sl.client_id, p_route, v_ctrl, x.actor, v_amt, v_report, 'otro',
                  'Abono previo a la migración (crédito ' || (s ->> 'code') || ')', 'synced', now(), 'active', v_op, v_princ, v_int);
          perform adex.credit_recompute(x.company, sl.id, x.today, v_report);
          insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                               worker_membership_id, sale_id, payment_id, reason, entry_date, actor_membership_id, actor_identity_id,
                                               actor_role, txid)
          values (v_op, x.company, md5(p_operation_id::text || '|pay|' || (s ->> 'code'))::uuid, 'MIGRATION_COLLECTION', v_amt, x.currency, p_route,
                  v_ctrl, null, sl.id, v_pay, 'Abono previo a la migración (crédito ' || (s ->> 'code') || ')', v_report,
                  x.actor, x.identity, x.role, txid_current());
          perform adex.capital_write_legs(x.company, v_op, array[v_fund, v_portf, v_income], array[v_amt, -v_princ, -v_int]);
          v_paid_n := v_paid_n + 1;
          v_coll := v_coll + v_amt;
        end if;
        continue;
      end if;

      -- Crédito nuevo: venta por lo que falta cobrar.
      v_cid := null;
      select t.client_id into v_cid from adex.route_migration_items t
       where t.company_id = x.company and t.migration_id = m.id and t.kind = 'client' and t.source_code = s ->> 'clientCode';
      if v_cid is null then perform adex.capital_raise('AX445', 'credit ' || coalesce(s ->> 'code', '?') || ': unknown client'); end if;
      v_value   := (s ->> 'valueMinor')::bigint;
      v_total   := (s ->> 'totalMinor')::bigint;
      v_freq    := s ->> 'frequency';
      select coalesce(array_agg(d::smallint order by d::smallint), '{}') into v_days from jsonb_array_elements_text(coalesce(s -> 'paymentDays', '[]')) d;
      if v_value is null or v_total is null or v_balance is null or v_value <= 0 or v_total < v_value or v_balance <= 0 or v_balance > v_total
         or v_freq not in ('diaria', 'semanal', 'quincenal', 'mensual') or cardinality(v_days) = 0
         or (s ->> 'installmentValueMinor')::bigint <= 0 or (s ->> 'rate')::numeric < 0 or (s ->> 'grantedOn')::date > v_report then
        perform adex.capital_raise('AX445', 'credit ' || coalesce(s ->> 'code', '?') || ': invalid figures');
      end if;
      v_princ := v_value - adex.credit_principal_of(v_total - v_balance, v_value, v_total);
      if v_princ <= 0 or v_princ > v_balance then perform adex.capital_raise('AX445', 'credit ' || (s ->> 'code') || ': no pending principal'); end if;
      select count(*), coalesce(sum((e ->> 'amountMinor')::numeric), 0), max((e ->> 'dueDate')::date) into v_n, v_sum, v_end
        from jsonb_array_elements(coalesce(s -> 'schedule', '[]')) e;
      if v_n = 0 or v_sum <> v_balance
         or exists (select 1 from jsonb_array_elements(s -> 'schedule') with ordinality y(e, k)
                     where (e ->> 'number')::int <> k or (e ->> 'amountMinor')::bigint <= 0 or (e ->> 'dueDate')::date <= (s ->> 'grantedOn')::date
                        or (k > 1 and (e ->> 'dueDate')::date < ((s -> 'schedule') -> (k::int - 2) ->> 'dueDate')::date)) then
        perform adex.capital_raise('AX445', 'credit ' || (s ->> 'code') || ': the schedule does not add up to the balance');
      end if;
      v_sale := gen_random_uuid()::text;
      v_op   := gen_random_uuid()::text;
      insert into adex.sales (id, company_id, route_id, client_id, created_by_membership_id, sale_value_minor, interest_rate, interest_value_minor,
                              total_value_minor, balance_minor, installments_count, installment_value_minor, payment_frequency, payment_days,
                              start_date, estimated_end_date, status, disbursement_status, disbursed_by_collector_id, disbursed_by_membership_id,
                              disbursement_date, delivered_on, disbursed_at, sale_request_id, ledger_operation_id, created_at, updated_at)
      values (v_sale, x.company, p_route, v_cid, x.actor, v_princ, (s ->> 'rate')::numeric, v_balance - v_princ, v_balance, v_balance, v_n,
              (s ->> 'installmentValueMinor')::bigint, v_freq, v_days, (s ->> 'grantedOn')::date, v_end, 'activa', 'desembolsado', null, v_ctrl,
              (s ->> 'grantedOn')::date, (s ->> 'grantedOn')::date, now(), null, v_op, now(), now());
      for i in select (e ->> 'number')::int n, (e ->> 'dueDate')::date d, (e ->> 'amountMinor')::bigint a from jsonb_array_elements(s -> 'schedule') e loop
        insert into adex.installments (id, company_id, sale_id, number, due_date, amount_minor, paid_minor, balance_minor, status, days_overdue)
        values (gen_random_uuid()::text, x.company, v_sale, i.n, i.d, i.a, 0, i.a, 'pendiente', 0);
      end loop;
      perform adex.credit_recompute(x.company, v_sale, x.today, null);
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, sale_request_id, sale_id, reason, entry_date, actor_membership_id,
                                           actor_identity_id, actor_role, txid)
      values (v_op, x.company, md5(p_operation_id::text || '|credit|' || (s ->> 'code'))::uuid, 'MIGRATION_OPENING', v_princ, x.currency, p_route,
              v_ctrl, null, null, v_sale, 'Cartera migrada (crédito ' || (s ->> 'code') || ')', x.today,
              x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_op, array[v_fund, v_portf], array[-v_princ, v_princ]);
      insert into adex.route_migration_items (id, company_id, migration_id, route_id, kind, source_code, client_id, sale_id, data, load_id)
      values (gen_random_uuid()::text, x.company, m.id, p_route, 'credit', s ->> 'code', v_cid, v_sale,
              jsonb_build_object('grantedOn', s ->> 'grantedOn', 'valueMinor', v_value, 'totalMinor', v_total, 'balanceMinor', v_balance,
                                 'paidBeforeMinor', v_total - v_balance, 'installmentsCount', (s ->> 'installmentsCount')::int,
                                 'installmentValueMinor', (s ->> 'installmentValueMinor')::bigint, 'frequency', v_freq,
                                 'overdueListos', (s ->> 'overdueListos')::int, 'lastPaymentOn', s ->> 'lastPaymentOn'), v_load);
      if not v_first then
        update adex.clients set status = 'activo', updated_at = now() where company_id = x.company and id = v_cid and status = 'inactivo';
      end if;
      v_new_cr := v_new_cr + 1;
    end loop;

    -- ---------- Créditos cargados que ya no están activos ----------
    for it in select t.* from adex.route_migration_items t join adex.sales v on v.company_id = t.company_id and v.id = t.sale_id
               where t.company_id = x.company and t.migration_id = m.id and t.kind = 'credit' and v.status = 'activa'
                 and not exists (select 1 from jsonb_array_elements(v_credits) q where q ->> 'code' = t.source_code) loop
      if not exists (select 1 from jsonb_array_elements(v_history) q where q ->> 'code' = it.source_code) then
        perform adex.capital_raise('AX445', 'credit ' || it.source_code || ': it is no longer active and is not paid in the report (export from 2025-01-01)');
      end if;
      -- Pagado en el sistema anterior: abono por el resto y la venta queda finalizada.
      select * into sl from adex.sales where company_id = x.company and id = it.sale_id for update;
      v_amt := sl.balance_minor;
      v_pay := gen_random_uuid()::text;
      v_op  := gen_random_uuid()::text;
      select coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0) into v_paid, v_known
        from adex.payments where company_id = x.company and sale_id = sl.id;
      v_princ := adex.credit_principal_of(v_paid + v_amt, sl.sale_value_minor, sl.total_value_minor) - v_known - sl.principal_reclassified_minor;
      v_int := v_amt - v_princ;
      insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, created_by_membership_id, amount_minor,
                                 payment_date, payment_type, note, sync_status, created_at, state, ledger_operation_id, principal_minor, interest_minor)
      values (v_pay, x.company, sl.id, sl.client_id, p_route, v_ctrl, x.actor, v_amt, v_report, 'otro',
              'Abono previo a la migración (crédito ' || it.source_code || ' pagado)', 'synced', now(), 'active', v_op, v_princ, v_int);
      perform adex.credit_recompute(x.company, sl.id, x.today, v_report);
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, sale_id, payment_id, reason, entry_date, actor_membership_id, actor_identity_id,
                                           actor_role, txid)
      values (v_op, x.company, md5(p_operation_id::text || '|pay|' || it.source_code)::uuid, 'MIGRATION_COLLECTION', v_amt, x.currency, p_route,
              v_ctrl, null, sl.id, v_pay, 'Abono previo a la migración (crédito ' || it.source_code || ' pagado)', v_report,
              x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_op, array[v_fund, v_portf, v_income], array[v_amt, -v_princ, -v_int]);
      v_closed_n := v_closed_n + 1;
      v_coll := v_coll + v_amt;
    end loop;

    -- ---------- Historial de pagados (los que aún no estaban) ----------
    for s in select e from jsonb_array_elements(v_history) e loop
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

    -- ---------- Control: la ruta en ADEX = el reporte del sistema anterior ----------
    select count(*), coalesce(sum(v.balance_minor), 0), coalesce(sum(v.sale_value_minor - adex.credit_principal_of(v.total_value_minor - v.balance_minor, v.sale_value_minor, v.total_value_minor)), 0),
           count(*) filter (where exists (select 1 from adex.installments n where n.company_id = v.company_id and n.sale_id = v.id and n.status = 'vencida'))
      into v_count, v_sum_bal, v_sum_cap, v_overdue
      from adex.sales v where v.company_id = x.company and v.route_id = p_route and v.status = 'activa';
    if v_count <> jsonb_array_length(v_credits) or v_sum_bal is distinct from (v_ctl ->> 'balanceMinor')::bigint then
      perform adex.capital_raise('AX445', 'after the load, the route in ADEX (' || v_count || ' active, balance ' || v_sum_bal
                                          || ') does not match the report (' || jsonb_array_length(v_credits) || ' active, balance '
                                          || coalesce(v_ctl ->> 'balanceMinor', '?') || ')');
    end if;

    v_result := jsonb_build_object(
      'migrationId', m.id, 'loadId', v_load, 'routeId', p_route, 'routeName', r.name, 'status', 'en_migracion', 'reportDate', v_report,
      'firstLoad', v_first, 'previousReportDate', v_last,
      'clients', (select count(*) from adex.clients where company_id = x.company and route_id = p_route),
      'activeClients', (select count(distinct client_id) from adex.sales where company_id = x.company and route_id = p_route and status = 'activa'),
      'newClients', v_new_cl, 'newCredits', v_new_cr, 'creditsWithPayments', v_paid_n, 'creditsPaidOff', v_closed_n,
      'collectedInListosMinor', v_coll,
      'activeCredits', v_count, 'paidCredits', (select count(*) from adex.route_migration_items where company_id = x.company and migration_id = m.id and kind = 'paid_credit'),
      'balanceMinor', v_sum_bal, 'principalMinor', (select balance_minor from adex.capital_accounts where company_id = x.company and id = v_portf),
      'creditsOverdue', v_overdue, 'duplicateDocuments', to_jsonb(v_dups),
      'listos', coalesce(p_payload -> 'listos', '{}'::jsonb),
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
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
      perform adex.capital_raise('AX445', 'invalid value in the payload: ' || sqlerrm);
  end $$;

-- ============================================================
-- 2. Textos ya guardados
-- ============================================================
create policy owner_0046_clients on adex.clients for all to adex_owner using (true) with check (true);
create policy owner_0046_payments on adex.payments for all to adex_owner using (true) with check (true);
create policy owner_0046_capital_operations on adex.capital_operations for all to adex_owner using (true) with check (true);
create policy owner_0046_audit_log on adex.audit_log for all to adex_owner using (true) with check (true);
alter table adex.payments disable trigger payments_route_migration_guard_upd;
alter table adex.capital_operations disable trigger capital_operations_immutable;
alter table adex.audit_log disable trigger audit_log_append_only;

update adex.clients
   set notes = regexp_replace(notes, '^Migrado de Listos \(cliente (.*)\)$', 'Cliente migrado (código \1)')
 where notes ~ '^Migrado de Listos \(cliente .*\)$';
update adex.payments
   set note = regexp_replace(note, '^Abono en Listos \(migración, crédito (.*)\)$', 'Abono previo a la migración (crédito \1)')
 where payment_type = 'otro' and note ~ '^Abono en Listos \(migración, crédito .*\)$';
update adex.capital_operations
   set reason = regexp_replace(reason, '^Abono en Listos durante la migración \(crédito (.*)\)$', 'Abono previo a la migración (crédito \1)')
 where kind = 'MIGRATION_COLLECTION' and reason ~ '^Abono en Listos durante la migración \(';
update adex.capital_operations
   set reason = regexp_replace(reason, '^Cartera migrada de Listos \(crédito (.*)\)$', 'Cartera migrada (crédito \1)')
 where kind = 'MIGRATION_OPENING' and reason ~ '^Cartera migrada de Listos \(';
update adex.audit_log
   set description = replace(replace(description, ' en migración desde Listos («', ' en migración desde el sistema anterior («'),
                             ': cierre de Listos del ', ': cierre del sistema anterior del ')
 where action in ('ROUTE_MIGRATION_OPENED', 'ROUTE_MIGRATION_LOADED') and description like '%Listos%';

-- Los controles diferidos del libro se comprueban ya: con eventos pendientes no se puede volver a encender un trigger.
set constraints all immediate;
alter table adex.audit_log enable trigger audit_log_append_only;
alter table adex.capital_operations enable trigger capital_operations_immutable;
alter table adex.payments enable trigger payments_route_migration_guard_upd;
drop policy owner_0046_audit_log on adex.audit_log;
drop policy owner_0046_capital_operations on adex.capital_operations;
drop policy owner_0046_payments on adex.payments;
drop policy owner_0046_clients on adex.clients;

-- Control: no queda el nombre en ningún texto visible de una migración.
do $$
begin
  if exists (select 1 from adex.clients where notes like 'Migrado de Listos%')
     or exists (select 1 from adex.payments where note like 'Abono en Listos%')
     or exists (select 1 from adex.capital_operations where kind in ('MIGRATION_OPENING', 'MIGRATION_COLLECTION') and reason like '%Listos%')
     or exists (select 1 from adex.audit_log where action like 'ROUTE_MIGRATION%' and description like '%Listos%') then
    raise exception '0046: quedan textos con el nombre del sistema anterior';
  end if;
end $$;
