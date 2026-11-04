-- 0045 · Migración de rutas: CARGA DE CADA CIERRE DIARIO y finalización aparte (Helmer, 2026-11-04).
--
-- Corrige 0044 (que escribía la ruta una sola vez, al final): Helmer quiere ver la ruta cada día con el cierre de Listos
-- («ver la Ruta como iba quedando … hasta llegar al domingo ya con la migración revisada, y solo agregar el cierre del
-- domingo para establecer la caja inicial del lunes»). Diseño: docs/ADEX_DISENO_MIGRACION_RUTAS_2026-11.md §15.
--
--   · `adex.route_migration_load` carga UN cierre (reporte de Listos de un día). La ruta SIGUE «en migración» (solo
--     lectura para todos). Se puede cargar un cierre por día, en orden de fecha.
--       - Primera carga: clientes, créditos activos (venta por lo que falta cobrar, fechas originales) e historial.
--       - Cargas siguientes, por código de Listos: cliente nuevo → alta; crédito nuevo → venta nueva; saldo menor →
--         «abono en Listos» por la diferencia (fecha = día del reporte); crédito que pasó a PAGADO → abono por el resto y
--         la venta queda finalizada; saldo MAYOR o crédito activo que desaparece sin estar pagado → se detiene (AX445).
--   · «Abono en Listos» = un pago de ADEX (para que saldo, cuotas y retraso sean los reales) con su asiento propio
--     `MIGRATION_COLLECTION`: cartera − capital, interés − interés, financiación de la ruta + importe. NO toca ninguna caja
--     (ni Base, ni custodia, ni bolsas): el dinero quedó en Listos. Cobrador del pago = Administrador responsable.
--   · `adex.route_migration_close` termina la migración (`finalizada`) y deja la ruta en estado normal. La caja se abre
--     después con una inyección de Base normal (el conteo del cierre).
--   · Las escrituras de la carga pasan el bloqueo de 0043 por la marca de txid (`route_migration_loads.txid`).
--   · `adex.route_migration_finish` (0044) se retira: nunca se usó con datos reales.

-- ============================================================
-- 1. Asiento del abono en Listos
-- ============================================================
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY', 'WORKER_RETURN',
  'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE',
  'EXPENSE_REFUND', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE',
  'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION',
  'ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE',
  'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT',
  'DIFFERENCE_CONCILIATION', 'MIGRATION_OPENING', 'MIGRATION_COLLECTION'));
alter table adex.capital_operations drop constraint capital_operations_sale_shape;
alter table adex.capital_operations add constraint capital_operations_sale_shape
  check ((coalesce(reverses_kind, kind) in ('LOAN_DISBURSEMENT', 'COLLECTION', 'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION',
                                            'MIGRATION_OPENING', 'MIGRATION_COLLECTION')) = (sale_id is not null));
alter table adex.capital_operations drop constraint capital_operations_payment_shape;
alter table adex.capital_operations add constraint capital_operations_payment_shape
  check ((coalesce(reverses_kind, kind) in ('COLLECTION', 'MIGRATION_COLLECTION')) = (payment_id is not null));

-- ============================================================
-- 2. Cargas (una por cierre diario) y marca de escritura
-- ============================================================
create table adex.route_migration_loads (
  id                       adex.eid primary key,
  company_id               adex.eid not null references adex.companies(id),
  migration_id             adex.eid not null,
  route_id                 adex.eid not null,
  report_date              date not null,
  operation_id             uuid not null,
  txid                     bigint not null,
  actor_membership_id      adex.eid not null,
  actor_identity_id        uuid not null references adex.identities(id),
  result                   jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  unique (company_id, id),
  constraint route_migration_loads_operation_key unique (company_id, operation_id),
  constraint route_migration_loads_day_key unique (company_id, migration_id, report_date),
  foreign key (company_id, migration_id) references adex.route_migrations(company_id, id),
  foreign key (company_id, route_id) references adex.routes(company_id, id),
  foreign key (company_id, actor_membership_id) references adex.memberships(company_id, id)
);
create trigger route_migration_loads_no_delete before delete on adex.route_migration_loads for each row execute function adex.reject_mutation();
create trigger route_migration_loads_no_truncate before truncate on adex.route_migration_loads for each statement execute function adex.reject_mutation();
alter table adex.route_migration_loads enable row level security;
alter table adex.route_migration_loads force row level security;
create policy owner_route_migration_loads_all on adex.route_migration_loads for all to adex_owner using (true) with check (true);
create policy route_migration_loads_ctx on adex.route_migration_loads for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and (
           (select adex.ctx_role()) = 'superadmin'
        or ((select adex.ctx_is(array['admin', 'supervisor', 'secretario']))
            and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())))));
grant select on adex.route_migration_loads to adex_api;
revoke all on adex.route_migration_loads from public;

-- Un mismo crédito puede pasar a pagado en una carga posterior: queda como `credit` (venta) y como `paid_credit`.
-- La carga también registra en qué cierre entró cada fila.
alter table adex.route_migration_items add column load_id adex.eid;

-- 0043 dejó esta función siempre en falso: ahora es verdadera dentro de la transacción de una carga de esa ruta.
create or replace function adex.route_migration_writing(p_company text, p_route text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select exists (select 1 from adex.route_migration_loads l
                        where l.company_id = p_company and l.route_id = p_route and l.txid = txid_current()) $$;

-- El propietario actualiza el estado de un cliente cargado (inactivo → activo cuando renueva en Listos).
create policy owner_migration_clients_update on adex.clients for update to adex_owner
  using (exists (select 1 from adex.route_migration_loads l where l.company_id = clients.company_id and l.route_id = clients.route_id
                   and l.txid = txid_current()))
  with check (true);

drop function adex.route_migration_finish(uuid, text, jsonb);

-- ============================================================
-- 3. Cargar un cierre
-- ============================================================
-- p_payload: el mismo formato que 0044 (lo arma `saas/scripts/migracion/listos_a_adex.py`).
create function adex.route_migration_load(p_operation_id uuid, p_route text, p_payload jsonb) returns jsonb
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
              'Migrado de ' || initcap(m.source_system) || ' (cliente ' || (c ->> 'code') || ')', now(), now());
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
        -- Crédito ya cargado: la baja de saldo es un abono hecho en Listos.
        select * into sl from adex.sales where company_id = x.company and id = it.sale_id for update;
        if sl.status <> 'activa' then perform adex.capital_raise('AX445', 'credit ' || (s ->> 'code') || ': it was finished and appears active again'); end if;
        if v_balance is null or v_balance <= 0 then perform adex.capital_raise('AX445', 'credit ' || (s ->> 'code') || ': invalid balance'); end if;
        if v_balance > sl.balance_minor then
          perform adex.capital_raise('AX445', 'credit ' || (s ->> 'code') || ': the balance went up in Listos (' || sl.balance_minor || ' → ' || v_balance
                                              || '); check the correction in Listos');
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
                  'Abono en Listos (migración, crédito ' || (s ->> 'code') || ')', 'synced', now(), 'active', v_op, v_princ, v_int);
          perform adex.credit_recompute(x.company, sl.id, x.today, v_report);
          insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                               worker_membership_id, sale_id, payment_id, reason, entry_date, actor_membership_id, actor_identity_id,
                                               actor_role, txid)
          values (v_op, x.company, md5(p_operation_id::text || '|pay|' || (s ->> 'code'))::uuid, 'MIGRATION_COLLECTION', v_amt, x.currency, p_route,
                  v_ctrl, null, sl.id, v_pay, 'Abono en Listos durante la migración (crédito ' || (s ->> 'code') || ')', v_report,
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
              v_ctrl, null, null, v_sale, 'Cartera migrada de ' || initcap(m.source_system) || ' (crédito ' || (s ->> 'code') || ')', x.today,
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
      -- Pagado en Listos: abono por el resto y la venta queda finalizada.
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
              'Abono en Listos (migración, crédito ' || it.source_code || ' pagado)', 'synced', now(), 'active', v_op, v_princ, v_int);
      perform adex.credit_recompute(x.company, sl.id, x.today, v_report);
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, sale_id, payment_id, reason, entry_date, actor_membership_id, actor_identity_id,
                                           actor_role, txid)
      values (v_op, x.company, md5(p_operation_id::text || '|pay|' || it.source_code)::uuid, 'MIGRATION_COLLECTION', v_amt, x.currency, p_route,
              v_ctrl, null, sl.id, v_pay, 'Abono en Listos durante la migración (crédito ' || it.source_code || ' pagado)', v_report,
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

    -- ---------- Control: la ruta en ADEX = el reporte de Listos ----------
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
revoke all on function adex.route_migration_load(uuid, text, jsonb) from public;
grant execute on function adex.route_migration_load(uuid, text, jsonb) to adex_api;

-- ============================================================
-- 4. Finalizar: la ruta pasa a estado normal (la caja se abre después con la inyección de Base)
-- ============================================================
create function adex.route_migration_close(p_operation_id uuid, p_route text, p_note text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x      adex.money_ctx;
    m      adex.route_migrations;
    v_last adex.route_migration_loads;
    v_note text := nullif(btrim(coalesce(p_note, '')), '');
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
    v_res := v_last.result || jsonb_build_object('status', 'finalizada', 'lastReportDate', v_last.report_date,
               'loads', (select count(*) from adex.route_migration_loads where company_id = x.company and migration_id = m.id));
    update adex.route_migrations
       set status = 'finalizada', closed_at = now(), closed_by_membership_id = x.actor, closed_by_identity_id = x.identity,
           close_operation_id = p_operation_id, closed_txid = txid_current(),
           close_reason = coalesce(v_note, 'Migración terminada con el cierre del ' || to_char(v_last.report_date, 'DD/MM/YYYY')),
           result = v_res
     where company_id = x.company and id = m.id;
    update adex.routes set migration_state = 'normal', updated_at = now() where company_id = x.company and id = p_route;
    return v_res || jsonb_build_object('closedAt', now());
  end $$;
revoke all on function adex.route_migration_close(uuid, text, text) from public;
grant execute on function adex.route_migration_close(uuid, text, text) to adex_api;

-- Cancelar solo mientras no se haya cargado ningún cierre.
create or replace function adex.route_migration_cancel(p_operation_id uuid, p_route text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x      adex.money_ctx;
    m      adex.route_migrations;
    v_why  text := nullif(btrim(coalesce(p_reason, '')), '');
  begin
    x := adex.money_context(p_operation_id);
    if x.role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the SuperAdmin cancels a route migration'); end if;
    if p_route is null or v_why is null or length(v_why) < 10 or length(v_why) > 500 then
      perform adex.capital_raise('AX411', 'route and a reason (10-500 characters) are required');
    end if;
    if exists (select 1 from adex.route_migrations where company_id = x.company and close_operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    perform 1 from adex.routes where company_id = x.company and id = p_route for update;
    select * into m from adex.route_migrations where company_id = x.company and route_id = p_route and status = 'en_migracion' for update;
    if not found then perform adex.capital_raise('AX444', 'the route is not in migration'); end if;
    if exists (select 1 from adex.route_migration_loads where company_id = x.company and migration_id = m.id) then
      perform adex.capital_raise('AX444', 'closes were already loaded: the migration can no longer be cancelled');
    end if;
    update adex.route_migrations
       set status = 'cancelada', closed_at = now(), closed_by_membership_id = x.actor, closed_by_identity_id = x.identity,
           close_operation_id = p_operation_id, closed_txid = txid_current(), close_reason = v_why
     where company_id = x.company and id = m.id;
    update adex.routes set migration_state = 'normal', updated_at = now() where company_id = x.company and id = p_route;
    return jsonb_build_object('migrationId', m.id, 'routeId', p_route, 'status', 'cancelada', 'reason', v_why, 'closedAt', now());
  end $$;
