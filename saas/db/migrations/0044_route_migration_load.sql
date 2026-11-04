-- 0044 · Migración de rutas con historial, parte 2: CARGA FINAL desde Listos y paso a normal (Helmer, 2026-11-04).
--
-- Diseño: docs/ADEX_DISENO_MIGRACION_RUTAS_2026-11.md (§5, §7, §14). Primera ruta: Valparaíso (BlueLine).
--
-- Decisión de implementación (§14 del diseño): la ruta se escribe UNA sola vez, al final, con el último reporte de Listos.
--   · Mientras dura la migración, los reportes diarios se REVISAN (vista previa, sin guardar): así ningún cobro hecho en
--     Listos se convierte en un abono de ADEX (no se mezcla con recaudos, cuadres, comisiones ni informes).
--   · Cada crédito ACTIVO entra como una venta de ADEX con LO QUE FALTA POR COBRAR:
--       total = saldo de Listos; capital = capital pendiente (misma proporción que el cobro, `credit_principal_of`);
--       cuotas = las que faltan, con sus FECHAS ORIGINALES (el retraso se ve tal cual: ADEX no castiga, P5).
--     Las cifras originales (valor, total, cuotas pactadas, mora de Listos) quedan en `route_migration_items`.
--   · Asiento nuevo `MIGRATION_OPENING` por venta: cartera de la ruta + capital pendiente / financiación de la ruta −.
--     No toca ninguna caja (Base, custodia ni bolsas). Cuadra por ruta (`routeConservation`).
--   · Los créditos PAGADOS de Listos solo quedan como historial (`route_migration_items`, tipo `paid_credit`).
--   · La función cierra la migración (`finalizada`) y deja la ruta en estado normal en la MISMA transacción: si algo
--     falla no queda nada escrito (todo o nada). La caja se abre después con una inyección de Base normal (el conteo).
--   · Solo el SuperAdmin, por la API (`adex_api`). `p_preview = true` no está aquí: la API ejecuta la función dentro de
--     un punto de guardado y lo deshace (vista previa con las mismas comprobaciones).

-- ============================================================
-- 1. Tipo de asiento nuevo
-- ============================================================
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY', 'WORKER_RETURN',
  'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE',
  'EXPENSE_REFUND', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE',
  'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION',
  'ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE',
  'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT',
  'DIFFERENCE_CONCILIATION', 'MIGRATION_OPENING'));
-- Pertenece a un crédito (como el desembolso). Nunca se anula (no está entre los `reverses_kind`).
alter table adex.capital_operations drop constraint capital_operations_sale_shape;
alter table adex.capital_operations add constraint capital_operations_sale_shape
  check ((coalesce(reverses_kind, kind) in ('LOAN_DISBURSEMENT', 'COLLECTION', 'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION',
                                            'MIGRATION_OPENING')) = (sale_id is not null));
create unique index capital_operations_one_migration_opening on adex.capital_operations (company_id, sale_id) where kind = 'MIGRATION_OPENING';

-- ============================================================
-- 2. Datos de origen (Listos): cifras originales, códigos e historial
-- ============================================================
alter table adex.route_migrations
  add column source_report_date date,
  add column result jsonb;

create table adex.route_migration_items (
  id             adex.eid primary key,
  company_id     adex.eid not null references adex.companies(id),
  migration_id   adex.eid not null,
  route_id       adex.eid not null,
  kind           text not null check (kind in ('client', 'credit', 'paid_credit')),
  source_code    text not null check (length(btrim(source_code)) between 1 and 60),
  client_id      adex.eid not null,                 -- cliente de ADEX (para 'client' es el propio cliente)
  sale_id        adex.eid,                          -- solo 'credit': la venta creada
  data           jsonb not null default '{}'::jsonb, -- cifras originales de Listos (sin datos personales)
  created_at     timestamptz not null default now(),
  unique (company_id, id),
  constraint route_migration_items_code_key unique (company_id, migration_id, kind, source_code),
  check ((kind = 'credit') = (sale_id is not null)),
  foreign key (company_id, migration_id) references adex.route_migrations(company_id, id),
  foreign key (company_id, route_id) references adex.routes(company_id, id),
  foreign key (company_id, client_id) references adex.clients(company_id, id),
  foreign key (company_id, sale_id) references adex.sales(company_id, id)
);
create index route_migration_items_client on adex.route_migration_items (company_id, client_id);
create index route_migration_items_sale on adex.route_migration_items (company_id, sale_id) where sale_id is not null;
create trigger route_migration_items_immutable before update or delete on adex.route_migration_items
  for each row execute function adex.reject_mutation();
create trigger route_migration_items_no_truncate before truncate on adex.route_migration_items
  for each statement execute function adex.reject_mutation();
alter table adex.route_migration_items enable row level security;
alter table adex.route_migration_items force row level security;
create policy owner_route_migration_items_all on adex.route_migration_items for all to adex_owner using (true) with check (true);
create policy route_migration_items_ctx on adex.route_migration_items for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and (
           (select adex.ctx_role()) = 'superadmin'
        or ((select adex.ctx_is(array['admin', 'supervisor', 'secretario']))
            and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())))));
grant select on adex.route_migration_items to adex_api;
revoke all on adex.route_migration_items from public;

-- La carga crea clientes desde una función del propietario (la API los crea con su propia política).
create policy owner_migration_clients_insert on adex.clients for insert to adex_owner with check (true);

-- ============================================================
-- 3. Carga final y paso a normal
-- ============================================================
-- p_payload (importes en unidades MENORES; lo arma `saas/scripts/migracion/listos_a_adex.py`):
-- { "sourceRouteName": text, "reportDate": "YYYY-MM-DD",
--   "control": { "clients": n, "activeCredits": n, "balanceMinor": n },
--   "listos":  { "cajaMinor": n|null, "carteraMinor": n|null },              -- solo referencia
--   "clients": [ { "code", "name", "document", "documentType" (CPF|null), "phone", "phone2", "address", "address2", "active": bool } ],
--   "credits": [ { "code", "clientCode", "grantedOn", "valueMinor", "totalMinor", "rate", "installmentsCount", "installmentValueMinor",
--                  "frequency", "paymentDays": [0..6], "balanceMinor", "overdueListos", "lastPaymentOn",
--                  "schedule": [ { "number", "dueDate", "amountMinor" } ] } ],          -- solo las cuotas que FALTAN
--   "history": [ { "code", "clientCode", "grantedOn", "valueMinor", "totalMinor", "installmentsCount", "frequency", "lastPaymentOn" } ] }
create function adex.route_migration_finish(p_operation_id uuid, p_route text, p_payload jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x          adex.money_ctx;
    r          adex.routes;
    m          adex.route_migrations;
    v_ctrl     text;
    v_report   date;
    v_country  char(2);
    v_portf    text;
    v_fund     text;
    v_bal      bigint;
    v_clients  jsonb := coalesce(p_payload -> 'clients', '[]'::jsonb);
    v_credits  jsonb := coalesce(p_payload -> 'credits', '[]'::jsonb);
    v_history  jsonb := coalesce(p_payload -> 'history', '[]'::jsonb);
    v_ctl      jsonb := coalesce(p_payload -> 'control', '{}'::jsonb);
    c          jsonb;
    s          jsonb;
    v_cid      text;
    v_sale     text;
    v_op       text;
    v_norm     text;
    v_dup      boolean;
    v_dups     text[] := '{}';
    v_value    bigint;
    v_total    bigint;
    v_balance  bigint;
    v_princ    bigint;
    v_n        int;
    v_sum      numeric;
    v_end      date;
    v_freq     text;
    v_days     smallint[];
    v_sum_bal  bigint := 0;
    v_sum_cap  bigint := 0;
    v_overdue  int := 0;
    v_result   jsonb;
    i          record;
  begin
    x := adex.money_context(p_operation_id);
    if x.role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the SuperAdmin loads a route migration'); end if;
    if p_route is null or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
      perform adex.capital_raise('AX411', 'route and payload are required');
    end if;
    if exists (select 1 from adex.route_migrations where company_id = x.company and close_operation_id = p_operation_id)
       or exists (select 1 from adex.capital_operations where company_id = x.company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;

    -- Ruta y migración abierta: bloqueo de ambas.
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
    -- Sigue vacía (las escrituras estaban bloqueadas; se comprueba igual).
    if exists (select 1 from adex.clients where company_id = x.company and route_id = p_route)
       or exists (select 1 from adex.sales where company_id = x.company and route_id = p_route)
       or exists (select 1 from adex.capital_accounts where company_id = x.company and route_id = p_route and balance_minor <> 0) then
      perform adex.capital_raise('AX444', 'the route already has data');
    end if;

    -- Forma general y controles del reporte.
    begin
      v_report := (p_payload ->> 'reportDate')::date;
    exception when others then v_report := null;
    end;
    if v_report is null or v_report > x.today or v_report < m.opened_at::date - 7 then
      perform adex.capital_raise('AX445', 'invalid report date');
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

    -- Primero se cierra la migración y la ruta pasa a normal (marca por txid): así las altas de abajo están permitidas.
    update adex.route_migrations
       set status = 'finalizada', closed_at = now(), closed_by_membership_id = x.actor, closed_by_identity_id = x.identity,
           close_operation_id = p_operation_id, closed_txid = txid_current(),
           close_reason = 'Carga final desde ' || initcap(m.source_system) || ' (reporte del ' || to_char(v_report, 'DD/MM/YYYY') || ')',
           source_report_date = v_report
     where company_id = x.company and id = m.id;
    update adex.routes set migration_state = 'normal', updated_at = now() where company_id = x.company and id = p_route;

    -- ---------- Clientes ----------
    v_country := adex.company_country(x.company);
    for c in select e from jsonb_array_elements(v_clients) e loop
      if nullif(btrim(coalesce(c ->> 'code', '')), '') is null or nullif(btrim(coalesce(c ->> 'name', '')), '') is null
         or nullif(btrim(coalesce(c ->> 'document', '')), '') is null then
        perform adex.capital_raise('AX445', 'every client needs code, name and document');
      end if;
      v_norm := adex.normalize_document((select t.normalization from adex.document_types t
                                          where t.country_code = v_country and t.code = nullif(c ->> 'documentType', '')),
                                        c ->> 'document');
      -- Documento ya usado en la empresa (otra ruta u otro cliente de esta carga): se conserva sin fusionar, marcado.
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
      insert into adex.route_migration_items (id, company_id, migration_id, route_id, kind, source_code, client_id, data)
      values (gen_random_uuid()::text, x.company, m.id, p_route, 'client', c ->> 'code', v_cid,
              jsonb_build_object('documentDuplicate', v_dup));
    end loop;

    -- ---------- Créditos activos → ventas por lo que falta cobrar ----------
    v_portf := adex.capital_account_for(x.company, 'portfolio', null, p_route);
    v_fund  := adex.capital_account_for(x.company, 'route_funding', null, p_route);
    perform 1 from adex.capital_accounts where company_id = x.company and id in (v_fund, v_portf) order by id for update;
    for s in select e from jsonb_array_elements(v_credits) e loop
      v_cid := null;
      select it.client_id into v_cid from adex.route_migration_items it
       where it.company_id = x.company and it.migration_id = m.id and it.kind = 'client' and it.source_code = s ->> 'clientCode';
      if v_cid is null then perform adex.capital_raise('AX445', 'credit ' || coalesce(s ->> 'code', '?') || ': unknown client'); end if;
      v_value   := (s ->> 'valueMinor')::bigint;
      v_total   := (s ->> 'totalMinor')::bigint;
      v_balance := (s ->> 'balanceMinor')::bigint;
      v_freq    := s ->> 'frequency';
      select coalesce(array_agg(d::smallint order by d::smallint), '{}') into v_days from jsonb_array_elements_text(coalesce(s -> 'paymentDays', '[]')) d;
      if v_value is null or v_total is null or v_balance is null or v_value <= 0 or v_total < v_value or v_balance <= 0 or v_balance > v_total
         or v_freq not in ('diaria', 'semanal', 'quincenal', 'mensual') or cardinality(v_days) = 0
         or (s ->> 'installmentValueMinor')::bigint <= 0 or (s ->> 'rate')::numeric < 0 or (s ->> 'grantedOn')::date > v_report then
        perform adex.capital_raise('AX445', 'credit ' || coalesce(s ->> 'code', '?') || ': invalid figures');
      end if;
      -- Capital pendiente = valor − capital ya cobrado (la misma proporción que usa el cobro).
      v_princ := v_value - adex.credit_principal_of(v_total - v_balance, v_value, v_total);
      if v_princ <= 0 or v_princ > v_balance then perform adex.capital_raise('AX445', 'credit ' || (s ->> 'code') || ': no pending principal'); end if;
      -- Cuotas que faltan: 1..k, importes > 0, fechas no decrecientes desde el otorgamiento, suma = saldo.
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
      perform adex.credit_recompute(x.company, v_sale, x.today, null);   -- vencidas y días de retraso por la fecha de hoy
      if exists (select 1 from adex.installments where company_id = x.company and sale_id = v_sale and status = 'vencida') then v_overdue := v_overdue + 1; end if;

      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, sale_request_id, sale_id, reason, entry_date, actor_membership_id,
                                           actor_identity_id, actor_role, txid)
      values (v_op, x.company, md5(p_operation_id::text || '|credit|' || (s ->> 'code'))::uuid, 'MIGRATION_OPENING', v_princ, x.currency, p_route,
              v_ctrl, null, null, v_sale,
              'Cartera migrada de ' || initcap(m.source_system) || ' (crédito ' || (s ->> 'code') || ')', x.today, x.actor, x.identity, x.role,
              txid_current());
      update adex.capital_accounts set balance_minor = balance_minor - v_princ, version = version + 1, updated_at = now()
       where company_id = x.company and id = v_fund returning balance_minor into v_bal;
      insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor) values (x.company, v_op, 1, v_fund, -v_princ, v_bal);
      update adex.capital_accounts set balance_minor = balance_minor + v_princ, version = version + 1, updated_at = now()
       where company_id = x.company and id = v_portf returning balance_minor into v_bal;
      insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor) values (x.company, v_op, 2, v_portf, v_princ, v_bal);

      insert into adex.route_migration_items (id, company_id, migration_id, route_id, kind, source_code, client_id, sale_id, data)
      values (gen_random_uuid()::text, x.company, m.id, p_route, 'credit', s ->> 'code', v_cid, v_sale,
              jsonb_build_object('grantedOn', s ->> 'grantedOn', 'valueMinor', v_value, 'totalMinor', v_total, 'balanceMinor', v_balance,
                                 'paidBeforeMinor', v_total - v_balance, 'installmentsCount', (s ->> 'installmentsCount')::int,
                                 'installmentValueMinor', (s ->> 'installmentValueMinor')::bigint, 'frequency', v_freq,
                                 'overdueListos', (s ->> 'overdueListos')::int, 'lastPaymentOn', s ->> 'lastPaymentOn'));
      v_sum_bal := v_sum_bal + v_balance;
      v_sum_cap := v_sum_cap + v_princ;
    end loop;
    if v_sum_bal is distinct from (v_ctl ->> 'balanceMinor')::bigint then
      perform adex.capital_raise('AX445', 'the total balance does not match the control of the report');
    end if;

    -- ---------- Créditos pagados: solo historial ----------
    for s in select e from jsonb_array_elements(v_history) e loop
      v_cid := null;
      select it.client_id into v_cid from adex.route_migration_items it
       where it.company_id = x.company and it.migration_id = m.id and it.kind = 'client' and it.source_code = s ->> 'clientCode';
      if v_cid is null then perform adex.capital_raise('AX445', 'paid credit ' || coalesce(s ->> 'code', '?') || ': unknown client'); end if;
      insert into adex.route_migration_items (id, company_id, migration_id, route_id, kind, source_code, client_id, data)
      values (gen_random_uuid()::text, x.company, m.id, p_route, 'paid_credit', s ->> 'code', v_cid,
              jsonb_build_object('grantedOn', s ->> 'grantedOn', 'valueMinor', (s ->> 'valueMinor')::bigint, 'totalMinor', (s ->> 'totalMinor')::bigint,
                                 'installmentsCount', (s ->> 'installmentsCount')::int, 'frequency', s ->> 'frequency', 'lastPaymentOn', s ->> 'lastPaymentOn'));
    end loop;

    v_result := jsonb_build_object(
      'migrationId', m.id, 'routeId', p_route, 'routeName', r.name, 'status', 'finalizada', 'reportDate', v_report,
      'clients', jsonb_array_length(v_clients),
      'activeClients', (select count(*) from jsonb_array_elements(v_clients) q where (q ->> 'active')::boolean),
      'activeCredits', jsonb_array_length(v_credits), 'paidCredits', jsonb_array_length(v_history),
      'balanceMinor', v_sum_bal, 'principalMinor', v_sum_cap, 'creditsOverdue', v_overdue,
      'duplicateDocuments', to_jsonb(v_dups),
      'listos', coalesce(p_payload -> 'listos', '{}'::jsonb),
      'responsibleMembershipId', v_ctrl, 'businessDate', x.today);
    update adex.route_migrations set result = v_result where company_id = x.company and id = m.id;
    return v_result;
  exception
    when unique_violation then
      if sqlerrm like '%capital_operations_operation_key%' or sqlerrm like '%route_migrations_close_key%' then
        perform adex.capital_raise('AX409', 'operation id already used');
      end if;
      raise;
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
      perform adex.capital_raise('AX445', 'invalid value in the payload: ' || sqlerrm);
  end $$;
revoke all on function adex.route_migration_finish(uuid, text, jsonb) from public;
grant execute on function adex.route_migration_finish(uuid, text, jsonb) to adex_api;
