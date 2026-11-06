-- 0048 · Migración de rutas: DIFERENCIAS en un cierre (3.27, decisión 2.2.2 de Helmer, 2026-11-05).
-- Diseño: docs/ADEX_DISENO_MIGRACION_RUTAS_2026-11.md §17 (decisiones de §17.5 tomadas el 2026-11-05).
--
--   · Un cierre que no cuadra en un crédito SE CARGA IGUAL. Los tres casos que antes detenían todo (AX445) quedan como
--     DIFERENCIA ABIERTA del crédito, con el valor de ADEX y el del sistema anterior, sin mover dinero:
--       A. `balance_up`  — el saldo sube en el sistema anterior;
--       B. `missing`     — un crédito activo desaparece del reporte sin estar en el historial de pagados;
--       C. `reappeared`  — un crédito que ADEX dio por pagado vuelve a estar activo.
--   · Con una diferencia abierta, los cierres siguientes NO tocan ese crédito: solo actualizan el valor del sistema
--     anterior; si el reporte vuelve a coincidir con ADEX, la diferencia se cierra sola («Se corrigió en el sistema
--     anterior»). El control final del cierre descuenta los créditos con diferencia (en los dos lados).
--   · `adex.route_migration_resolve_difference`: la corrigen el SuperAdmin o el Administrador responsable de la ruta,
--     con motivo obligatorio. Opciones (§17.3):
--       A: `accept_source` (anula abonos previos a la migración por el importe exacto; si no alcanzan, ajuste de
--          interés con motivo) · `keep_adex` (no cambia nada; los cierres siguientes respetan esa diferencia aceptada).
--       B: `paid` (abono previo a la migración por el resto) · `void` (la venta sale de la cartera y el capital pendiente
--          vuelve a la financiación de la ruta) · `still_active` (no cambia nada; se cobra en ADEX).
--       C: `reopen` (anula el abono final y el crédito vuelve a activo con el saldo del sistema anterior) · `keep_paid`.
--     Ningún ajuste toca una caja: solo cartera, financiación de la ruta e interés (como MIGRATION_COLLECTION).
--     La anulación de abonos es un REVERSAL de MIGRATION_COLLECTION; anular la venta, el asiento nuevo
--     MIGRATION_ADJUSTMENT. El ajuste de interés no mueve dinero (el interés se reconoce al cobrar): queda en la
--     diferencia y en la auditoría.
--   · `adex.route_migration_close` exige CERO diferencias abiertas.
--   · Aditiva: tabla nueva, una columna nueva en ventas (`migration_voided_at`), tipos de asiento admitidos y funciones.
--     No cambia ni borra filas existentes.

-- ============================================================
-- 1. Libro: asiento de corrección y anulación de abonos previos a la migración
-- ============================================================
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY', 'WORKER_RETURN',
  'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE',
  'EXPENSE_REFUND', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE',
  'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION',
  'ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE',
  'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT',
  'DIFFERENCE_CONCILIATION', 'MIGRATION_OPENING', 'MIGRATION_COLLECTION', 'MIGRATION_ADJUSTMENT'));
alter table adex.capital_operations drop constraint capital_operations_sale_shape;
alter table adex.capital_operations add constraint capital_operations_sale_shape
  check ((coalesce(reverses_kind, kind) in ('LOAN_DISBURSEMENT', 'COLLECTION', 'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION',
                                            'MIGRATION_OPENING', 'MIGRATION_COLLECTION', 'MIGRATION_ADJUSTMENT')) = (sale_id is not null));
alter table adex.capital_operations drop constraint capital_operations_reverses_kind_check;
alter table adex.capital_operations add constraint capital_operations_reverses_kind_check
  check (reverses_kind is null or reverses_kind in ('COMPANY_DEPOSIT', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
                                                   'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE',
                                                   'COMPANY_EXPENSE', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ROUTE_BASE_INJECTION',
                                                   'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT',
                                                   'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'MIGRATION_COLLECTION'));

-- Venta migrada anulada («nunca debió existir»): queda con lo que ya se había cobrado (capital y total = lo cobrado,
-- saldo 0, finalizada). Si no tenía abonos, capital y total quedan en 0: solo se admite con esta marca.
alter table adex.sales add column migration_voided_at timestamptz;
comment on column adex.sales.migration_voided_at is
  '0048: venta migrada anulada al corregir una diferencia de migración («nunca debió existir»). Capital y total = lo ya cobrado.';
alter table adex.sales drop constraint sales_sale_value_minor_check;
alter table adex.sales add constraint sales_sale_value_minor_check check (sale_value_minor > 0 or (migration_voided_at is not null and sale_value_minor >= 0));
alter table adex.sales drop constraint sales_total_value_minor_check;
alter table adex.sales add constraint sales_total_value_minor_check check (total_value_minor > 0 or (migration_voided_at is not null and total_value_minor >= 0));

-- ============================================================
-- 2. Diferencias
-- ============================================================
create table adex.route_migration_differences (
  id                         adex.eid primary key,
  company_id                 adex.eid not null references adex.companies(id),
  migration_id               adex.eid not null,
  route_id                   adex.eid not null,
  sale_id                    adex.eid not null,
  client_id                  adex.eid not null,
  source_code                text not null check (length(btrim(source_code)) between 1 and 60),
  kind                       text not null check (kind in ('balance_up', 'missing', 'reappeared')),
  -- ADEX al detectarla (el crédito no cambia mientras está abierta).
  adex_status                text not null,
  adex_balance_minor         bigint not null check (adex_balance_minor >= 0),
  -- Sistema anterior: lo que dice el último cierre cargado.
  source_status              text not null check (source_status in ('active', 'missing', 'paid')),
  source_balance_minor       bigint check (source_balance_minor is null or source_balance_minor >= 0),
  detected_load_id           adex.eid not null,
  detected_report_date       date not null,
  source_report_date         date not null,
  status                     text not null check (status in ('abierta', 'resuelta')),
  action                     text check (action in ('accept_source', 'keep_adex', 'paid', 'void', 'still_active', 'reopen', 'keep_paid', 'coincide')),
  reason                     text check (reason is null or length(reason) between 3 and 500),
  -- `keep_adex`: diferencia aceptada (sistema anterior − ADEX); los cierres siguientes la descuentan.
  kept_offset_minor          bigint not null default 0,
  resolved_at                timestamptz,
  resolved_by_membership_id  adex.eid,
  resolved_by_identity_id    uuid references adex.identities(id),
  resolved_role              text,
  resolve_operation_id       uuid,
  resolved_txid              bigint,
  resolved_load_id           adex.eid,
  result                     jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (company_id, id),
  constraint route_migration_differences_resolve_key unique (company_id, resolve_operation_id),
  check ((status = 'resuelta') = (action is not null) and (status = 'resuelta') = (resolved_at is not null) and (status = 'resuelta') = (reason is not null)),
  -- Cerrada sola por un cierre que vuelve a coincidir, o corregida por una persona (con su operación).
  check (action is distinct from 'coincide' or (resolved_load_id is not null and resolved_by_membership_id is null)),
  check (action is null or action = 'coincide' or (resolved_by_membership_id is not null and resolved_by_identity_id is not null
                                                   and resolve_operation_id is not null and resolved_role in ('superadmin', 'admin'))),
  check (kind <> 'balance_up' or action is null or action in ('accept_source', 'keep_adex', 'coincide')),
  check (kind <> 'missing' or action is null or action in ('paid', 'void', 'still_active', 'coincide')),
  check (kind <> 'reappeared' or action is null or action in ('reopen', 'keep_paid', 'coincide')),
  foreign key (company_id, migration_id) references adex.route_migrations(company_id, id),
  foreign key (company_id, route_id) references adex.routes(company_id, id),
  foreign key (company_id, sale_id) references adex.sales(company_id, id),
  foreign key (company_id, client_id) references adex.clients(company_id, id),
  foreign key (company_id, detected_load_id) references adex.route_migration_loads(company_id, id),
  foreign key (company_id, resolved_load_id) references adex.route_migration_loads(company_id, id),
  foreign key (company_id, resolved_by_membership_id) references adex.memberships(company_id, id)
);
create unique index route_migration_differences_one_open on adex.route_migration_differences (company_id, sale_id) where status = 'abierta';
create index route_migration_differences_migration on adex.route_migration_differences (company_id, migration_id, status);
create index route_migration_differences_sale on adex.route_migration_differences (company_id, sale_id, resolved_at);
create trigger route_migration_differences_no_delete before delete on adex.route_migration_differences for each row execute function adex.reject_mutation();
create trigger route_migration_differences_no_truncate before truncate on adex.route_migration_differences for each statement execute function adex.reject_mutation();
alter table adex.route_migration_differences enable row level security;
alter table adex.route_migration_differences force row level security;
create policy owner_route_migration_differences_all on adex.route_migration_differences for all to adex_owner using (true) with check (true);
create policy route_migration_differences_ctx on adex.route_migration_differences for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and (
           (select adex.ctx_role()) = 'superadmin'
        or ((select adex.ctx_is(array['admin', 'supervisor', 'secretario']))
            and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())))));
grant select on adex.route_migration_differences to adex_api;
revoke all on adex.route_migration_differences from public;

-- Marca de escritura de 0045 ampliada: también es verdadera dentro de la transacción que corrige una diferencia de esa ruta.
create or replace function adex.route_migration_writing(p_company text, p_route text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select exists (select 1 from adex.route_migration_loads l
                        where l.company_id = p_company and l.route_id = p_route and l.txid = txid_current())
            or exists (select 1 from adex.route_migration_differences d
                        where d.company_id = p_company and d.route_id = p_route and d.resolved_txid = txid_current()) $$;

-- RB-D11 (0039): solo el Administrador anula. Excepción única: la anulación de un abono previo a la migración al
-- corregir una diferencia, que también puede hacer el SuperAdmin (decisión 1 de §17.5).
create or replace function adex.guard_reversal_by_admin() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  begin
    if new.reverses_operation_id is not null and new.actor_role is distinct from 'admin'
       and not (new.reverses_kind = 'MIGRATION_COLLECTION' and new.actor_role = 'superadmin'
                and exists (select 1 from adex.route_migration_differences d where d.company_id = new.company_id and d.route_id = new.route_id
                              and d.resolved_txid = txid_current())) then
      raise exception 'adex: only an administrator reverses operations (RB-D11)' using errcode = 'AX402';
    end if;
    return new;
  end $$;

-- ============================================================
-- 3. Piezas internas (solo las usan las funciones de migración; sin permisos para la API)
-- ============================================================
-- Última corrección de un crédito (la que manda: una diferencia aceptada o un ajuste posterior).
create function adex.route_migration_last_resolution(p_company text, p_sale text) returns adex.route_migration_differences
  language sql stable
  as $$ select d.* from adex.route_migration_differences d where d.company_id = p_company and d.sale_id = p_sale and d.status = 'resuelta'
         order by d.resolved_at desc, d.id desc limit 1 $$;
revoke all on function adex.route_migration_last_resolution(text, text) from public;

create function adex.route_migration_difference_add(p_company text, p_migration text, p_route text, p_sale text, p_client text, p_code text,
                                                    p_kind text, p_adex_status text, p_adex_balance bigint, p_source_status text,
                                                    p_source_balance bigint, p_load text, p_date date) returns void
  language plpgsql
  as $$ begin
    insert into adex.route_migration_differences (id, company_id, migration_id, route_id, sale_id, client_id, source_code, kind, adex_status,
                                                  adex_balance_minor, source_status, source_balance_minor, detected_load_id, detected_report_date,
                                                  source_report_date, status)
    values (gen_random_uuid()::text, p_company, p_migration, p_route, p_sale, p_client, p_code, p_kind, p_adex_status, p_adex_balance,
            p_source_status, p_source_balance, p_load, p_date, p_date, 'abierta');
  end $$;
revoke all on function adex.route_migration_difference_add(text, text, text, text, text, text, text, text, bigint, text, bigint, text, date) from public;

-- Diferencias de una migración para la vista previa, el resultado del cierre y la lista (abiertas primero).
create function adex.route_migration_differences_json(p_company text, p_migration text, p_only_open boolean) returns jsonb
  language sql stable
  as $$ select coalesce(jsonb_agg(jsonb_build_object(
             'id', d.id, 'saleId', d.sale_id, 'clientId', d.client_id, 'clientName', c.name, 'code', d.source_code, 'kind', d.kind,
             'status', d.status, 'adexStatus', d.adex_status, 'adexBalanceMinor', d.adex_balance_minor,
             'currentStatus', v.status, 'currentBalanceMinor', v.balance_minor,
             'sourceStatus', d.source_status, 'sourceBalanceMinor', d.source_balance_minor,
             'detectedReportDate', d.detected_report_date, 'sourceReportDate', d.source_report_date,
             'action', d.action, 'reason', d.reason, 'resolvedAt', d.resolved_at, 'resolvedById', d.resolved_by_membership_id)
           order by (d.status = 'abierta') desc, d.detected_report_date, d.source_code), '[]'::jsonb)
         from adex.route_migration_differences d
         join adex.clients c on c.company_id = d.company_id and c.id = d.client_id
         join adex.sales v on v.company_id = d.company_id and v.id = d.sale_id
        where d.company_id = p_company and d.migration_id = p_migration and (not p_only_open or d.status = 'abierta') $$;
revoke all on function adex.route_migration_differences_json(text, text, boolean) from public;

-- Abono previo a la migración (MIGRATION_COLLECTION): cartera − capital, interés − interés, financiación + importe. Sin caja.
create function adex.route_migration_pay_internal(x adex.money_ctx, p_route text, p_ctrl text, p_sale text, p_code text, p_amount bigint,
                                                  p_date date, p_op uuid, p_note text) returns void
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
    v_fund   text := adex.capital_account_for(x.company, 'route_funding', null, p_route);
    v_income text := adex.capital_account_for(x.company, 'income', null, p_route);
  begin
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
    values (v_op, x.company, p_op, 'MIGRATION_COLLECTION', p_amount, x.currency, p_route, p_ctrl, null, sl.id, v_pay, left(p_note, 300), p_date,
            x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_fund, v_portf, v_income], array[p_amount, -v_princ, -v_int]);
  end $$;
revoke all on function adex.route_migration_pay_internal(adex.money_ctx, text, text, text, text, bigint, date, uuid, text) from public;

-- Anulación de un abono previo a la migración (REVERSAL de MIGRATION_COLLECTION, con la fecha del abono). Sin caja.
create function adex.route_migration_reverse_internal(x adex.money_ctx, p_route text, p_payment text, p_op uuid, p_reason text) returns bigint
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
    v_fund   text := adex.capital_account_for(x.company, 'route_funding', null, p_route);
    v_income text := adex.capital_account_for(x.company, 'income', null, p_route);
  begin
    select * into p from adex.payments where company_id = x.company and id = p_payment for update;
    select * into o from adex.capital_operations where company_id = x.company and id = p.ledger_operation_id;
    if p.state <> 'active' or p.amount_minor <= 0 or o.kind is distinct from 'MIGRATION_COLLECTION' then
      perform adex.capital_raise('AX444', 'only payments made before the migration are reversed here');
    end if;
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
            'MIGRATION_COLLECTION', left(p_reason, 300), x.today, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_fund, v_portf, v_income], array[-p.amount_minor, -v_princ, -v_int]);
    return p.amount_minor;
  end $$;
revoke all on function adex.route_migration_reverse_internal(adex.money_ctx, text, text, uuid, text) from public;

-- Deja el saldo del crédito en p_target sin tocar ninguna caja:
--   · baja → abono previo a la migración por la diferencia (fecha del último cierre);
--   · sube → anula abonos previos a la migración, del más reciente al más antiguo, por el importe EXACTO (si el último
--     anulado sobra, se vuelve a registrar el sobrante con su misma fecha); si no alcanzan, el resto es un AJUSTE DE
--     INTERÉS (sube el total y la última cuota; no mueve dinero: el interés se reconoce al cobrar).
create function adex.route_migration_set_balance_internal(x adex.money_ctx, p_route text, p_ctrl text, p_sale text, p_code text, p_target bigint,
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
                where q.company_id = x.company and q.sale_id = sl.id and q.state = 'active' and q.amount_minor > 0 and o.kind = 'MIGRATION_COLLECTION'
                order by q.payment_date desc, q.created_at desc, q.id desc loop
        exit when v_rev >= least(v_need, v_paid);
        v_n := v_n + 1;
        v_rev := v_rev + adex.route_migration_reverse_internal(x, p_route, p.id, adex.derived_operation_id(p_op, 'reverse:' || p.id), p_reason);
        v_last := p.payment_date;
      end loop;
      if v_rev < least(v_need, v_paid) then
        perform adex.capital_raise('AX444', 'the credit has payments that were not made before the migration');
      end if;
      if v_rev > v_need then
        v_repay := v_rev - v_need;
        perform adex.route_migration_pay_internal(x, p_route, p_ctrl, sl.id, p_code, v_repay, v_last, adex.derived_operation_id(p_op, 'repay'),
                                                  'Abono previo a la migración (crédito ' || p_code || ', parte que se mantiene)');
      end if;
      v_extra := v_need - (v_rev - v_repay);
      if v_extra > 0 then
        -- Ya no queda ningún abono: el capital reconocido es 0 y el total puede subir sin reclasificar nada.
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
revoke all on function adex.route_migration_set_balance_internal(adex.money_ctx, text, text, text, text, bigint, date, uuid, text) from public;

-- «Nunca debió existir»: la venta queda con lo ya cobrado (saldo 0, finalizada, marcada) y su capital pendiente vuelve a la
-- financiación de la ruta con el asiento MIGRATION_ADJUSTMENT (cartera − / financiación +). Sin caja.
create function adex.route_migration_void_internal(x adex.money_ctx, p_route text, p_ctrl text, p_sale text, p_code text, p_date date,
                                                   p_op uuid, p_reason text) returns jsonb
  language plpgsql
  as $$
  declare
    sl      adex.sales;
    v_paid  bigint;
    v_known bigint;
    v_pend  bigint;
    v_op    text := gen_random_uuid()::text;
    v_portf text := adex.capital_account_for(x.company, 'portfolio', null, p_route);
    v_fund  text := adex.capital_account_for(x.company, 'route_funding', null, p_route);
  begin
    select * into sl from adex.sales where company_id = x.company and id = p_sale for update;
    if sl.status <> 'activa' then perform adex.capital_raise('AX444', 'only an active credit is voided'); end if;
    select coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0) into v_paid, v_known
      from adex.payments where company_id = x.company and sale_id = sl.id;
    v_known := v_known + sl.principal_reclassified_minor;
    v_pend := sl.sale_value_minor - v_known;
    if v_pend < 0 or v_known > v_paid then perform adex.capital_raise('AX420', 'inconsistent principal recognition'); end if;
    perform adex.credit_recompute(x.company, sl.id, x.today, p_date);
    -- Cada cuota queda con lo cobrado; las que no tenían nada cobrado se sustituyen (nunca se borra una cuota).
    update adex.installments
       set amount_minor = paid_minor, balance_minor = 0, days_overdue = 0, status = case when paid_minor > 0 then 'pagada' else 'sustituida' end
     where company_id = x.company and sale_id = sl.id and status <> 'sustituida';
    update adex.sales set sale_value_minor = v_known, total_value_minor = v_paid, interest_value_minor = v_paid - v_known,
                          migration_voided_at = now(), updated_at = now()
     where company_id = x.company and id = sl.id;
    perform adex.credit_recompute(x.company, sl.id, x.today, p_date);
    if v_pend > 0 then
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, sale_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_op, x.company, p_op, 'MIGRATION_ADJUSTMENT', v_pend, x.currency, p_route, p_ctrl, null, sl.id,
              left('Venta migrada anulada (crédito ' || p_code || '): ' || p_reason, 300), x.today, x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_op, array[v_portf, v_fund], array[-v_pend, v_pend]);
    end if;
    return jsonb_build_object('balanceBeforeMinor', sl.balance_minor, 'balanceAfterMinor', 0, 'principalReturnedMinor', v_pend,
                              'keptPaidMinor', v_paid);
  end $$;
revoke all on function adex.route_migration_void_internal(adex.money_ctx, text, text, text, text, date, uuid, text) from public;

-- ============================================================
-- 4. Carga de un cierre: las diferencias se registran en lugar de detener la carga
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
    d          adex.route_migration_differences;
    lr         adex.route_migration_differences;
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
    v_eff      bigint;
    v_off      bigint;
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
    -- 0048 · diferencias
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

    -- ---------- 0048 · Diferencias abiertas: solo se actualiza el valor del sistema anterior ----------
    -- Si el reporte vuelve a coincidir con ADEX, se cierra sola. Si no, este cierre no toca ese crédito.
    for d in select t.* from adex.route_migration_differences t
              where t.company_id = x.company and t.migration_id = m.id and t.status = 'abierta' order by t.created_at, t.id for update loop
      v_rep := (select e from jsonb_array_elements(v_credits) e where e ->> 'code' = d.source_code limit 1);
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

    -- ---------- Créditos activos del reporte ----------
    for s in select e from jsonb_array_elements(v_credits) e loop
      v_balance := (s ->> 'balanceMinor')::bigint;
      select * into it from adex.route_migration_items
       where company_id = x.company and migration_id = m.id and kind = 'credit' and source_code = s ->> 'code';
      if found then
        continue when (s ->> 'code') = any(v_skip);
        -- Crédito ya cargado: la baja de saldo es un abono hecho en el sistema anterior.
        select * into sl from adex.sales where company_id = x.company and id = it.sale_id for update;
        if v_balance is null or v_balance <= 0 then perform adex.capital_raise('AX445', 'credit ' || (s ->> 'code') || ': invalid balance'); end if;
        lr := adex.route_migration_last_resolution(x.company, sl.id);
        if sl.status <> 'activa' then
          -- C · ADEX lo dio por pagado y reaparece activo (salvo que se haya decidido mantenerlo pagado).
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
          -- A · el saldo sube: diferencia abierta, el crédito se queda como estaba.
          perform adex.route_migration_difference_add(x.company, m.id, p_route, sl.id, sl.client_id, s ->> 'code', 'balance_up', sl.status,
                                                      sl.balance_minor, 'active', v_balance, v_load, v_report);
          v_new_df := v_new_df + 1;
          continue;
        end if;
        if v_eff < sl.balance_minor then
          v_amt := sl.balance_minor - v_eff;
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
      select coalesce(array_agg(d2::smallint order by d2::smallint), '{}') into v_days from jsonb_array_elements_text(coalesce(s -> 'paymentDays', '[]')) d2;
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
      for i in select (e ->> 'number')::int n, (e ->> 'dueDate')::date dd, (e ->> 'amountMinor')::bigint a from jsonb_array_elements(s -> 'schedule') e loop
        insert into adex.installments (id, company_id, sale_id, number, due_date, amount_minor, paid_minor, balance_minor, status, days_overdue)
        values (gen_random_uuid()::text, x.company, v_sale, i.n, i.dd, i.a, 0, i.a, 'pendiente', 0);
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
      continue when it.source_code = any(v_skip);
      if not exists (select 1 from jsonb_array_elements(v_history) q where q ->> 'code' = it.source_code) then
        -- B · desaparece sin estar pagado: diferencia abierta (salvo que se haya decidido que sigue activo en ADEX).
        lr := adex.route_migration_last_resolution(x.company, it.sale_id);
        continue when lr.action = 'still_active';
        select * into sl from adex.sales where company_id = x.company and id = it.sale_id;
        perform adex.route_migration_difference_add(x.company, m.id, p_route, sl.id, sl.client_id, it.source_code, 'missing', sl.status,
                                                    sl.balance_minor, 'missing', null, v_load, v_report);
        v_new_df := v_new_df + 1;
        continue;
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

    -- ---------- Control: la ruta en ADEX = el reporte, sin contar los créditos con diferencia ----------
    -- (abiertas, o aceptadas con «Mantener»: en esos créditos ADEX y el sistema anterior no coinciden a propósito).
    select count(*), coalesce(sum(v.balance_minor), 0), coalesce(sum(v.sale_value_minor - adex.credit_principal_of(v.total_value_minor - v.balance_minor, v.sale_value_minor, v.total_value_minor)), 0),
           count(*) filter (where exists (select 1 from adex.installments n where n.company_id = v.company_id and n.sale_id = v.id and n.status = 'vencida'))
      into v_count, v_sum_bal, v_sum_cap, v_overdue
      from adex.sales v where v.company_id = x.company and v.route_id = p_route and v.status = 'activa';
    select coalesce(sum(case when v.status = 'activa' then 1 else 0 end), 0), coalesce(sum(case when v.status = 'activa' then v.balance_minor else 0 end), 0),
           coalesce(sum(case when q.e is not null then 1 else 0 end), 0), coalesce(sum(coalesce((q.e ->> 'balanceMinor')::bigint, 0)), 0)
      into v_adj_a, v_adj_ab, v_adj_r, v_adj_rb
      from (select distinct t.sale_id, t.source_code from adex.route_migration_differences t
             where t.company_id = x.company and t.migration_id = m.id
               and (t.status = 'abierta'
                    or (adex.route_migration_last_resolution(x.company, t.sale_id)).action in ('keep_adex', 'still_active', 'keep_paid'))) dd
      join adex.sales v on v.company_id = x.company and v.id = dd.sale_id
      left join lateral (select e from jsonb_array_elements(v_credits) e where e ->> 'code' = dd.source_code limit 1) q on true;
    if v_count - v_adj_a <> jsonb_array_length(v_credits) - v_adj_r
       or v_sum_bal - v_adj_ab is distinct from (v_ctl ->> 'balanceMinor')::bigint - v_adj_rb then
      perform adex.capital_raise('AX445', 'after the load, the route in ADEX (' || v_count || ' active, balance ' || v_sum_bal
                                          || ') does not match the report (' || jsonb_array_length(v_credits) || ' active, balance '
                                          || coalesce(v_ctl ->> 'balanceMinor', '?') || ')'
                                          || case when v_adj_a + v_adj_r > 0 then ' after setting aside the credits with differences' else '' end);
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
      -- 0048: diferencias de este cierre y las que siguen abiertas.
      'newDifferences', v_new_df, 'resolvedDifferences', v_auto_df,
      'openDifferences', (select count(*) from adex.route_migration_differences where company_id = x.company and migration_id = m.id and status = 'abierta'),
      'differences', adex.route_migration_differences_json(x.company, m.id, true),
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
-- 5. Corregir una diferencia (SuperAdmin o Administrador responsable de la ruta; motivo obligatorio)
-- ============================================================
create function adex.route_migration_resolve_difference(p_operation_id uuid, p_route text, p_difference text, p_action text, p_reason text)
  returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x        adex.money_ctx;
    r        adex.routes;
    m        adex.route_migrations;
    d        adex.route_migration_differences;
    sl       adex.sales;
    v_why    text := nullif(btrim(coalesce(p_reason, '')), '');
    v_ctrl   text;
    v_before jsonb;
    v_after  jsonb;
    v_money  jsonb := '{}'::jsonb;
    v_off    bigint := 0;
    v_res    jsonb;
    v_cname  text;
  begin
    x := adex.money_context(p_operation_id);
    if x.role not in ('superadmin', 'admin') then
      perform adex.capital_raise('AX402', 'only the SuperAdmin or the responsible administrator of the route resolves a migration difference');
    end if;
    if p_route is null or p_difference is null or p_action is null then perform adex.capital_raise('AX411', 'route, difference and action are required'); end if;
    if v_why is null or length(v_why) < 10 or length(v_why) > 500 then perform adex.capital_raise('AX411', 'a reason (10-500 characters) is required'); end if;
    if exists (select 1 from adex.route_migration_differences where company_id = x.company and resolve_operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;

    select * into r from adex.routes where company_id = x.company and id = p_route for update;
    if not found then perform adex.capital_raise('AX412', 'route not found'); end if;
    if x.role = 'admin' and r.capital_controller_membership_id is distinct from x.actor then
      perform adex.capital_raise('AX402', 'only the responsible administrator of the route (or the SuperAdmin) resolves its migration differences');
    end if;
    select * into m from adex.route_migrations where company_id = x.company and route_id = p_route and status = 'en_migracion' for update;
    if not found then perform adex.capital_raise('AX444', 'the route is not in migration'); end if;
    select * into d from adex.route_migration_differences where company_id = x.company and id = p_difference and migration_id = m.id for update;
    if not found then perform adex.capital_raise('AX412', 'difference not found'); end if;
    if d.status <> 'abierta' then perform adex.capital_raise('AX444', 'the difference is already resolved'); end if;
    if not (case d.kind when 'balance_up' then p_action in ('accept_source', 'keep_adex')
                        when 'missing' then p_action in ('paid', 'void', 'still_active')
                        when 'reappeared' then p_action in ('reopen', 'keep_paid') else false end) then
      perform adex.capital_raise('AX411', 'that option does not apply to this difference');
    end if;
    v_ctrl := r.capital_controller_membership_id;
    if v_ctrl is null or not adex.route_controller_valid_internal(x.company, p_route) then
      perform adex.capital_raise('AX408', 'the route needs a valid capital controller (its responsible administrator)');
    end if;

    -- Marca de esta corrección (txid): habilita las escrituras en la ruta en migración, solo en esta transacción.
    update adex.route_migration_differences set resolved_txid = txid_current() where company_id = x.company and id = d.id;
    perform 1 from adex.capital_accounts
      where company_id = x.company and route_id = p_route and kind in ('portfolio', 'route_funding', 'income') order by id for update;
    select * into sl from adex.sales where company_id = x.company and id = d.sale_id for update;
    v_before := jsonb_build_object('status', sl.status, 'balanceMinor', sl.balance_minor, 'valueMinor', sl.sale_value_minor, 'totalMinor', sl.total_value_minor);

    if p_action = 'accept_source' then
      if d.source_status = 'missing' then
        perform adex.capital_raise('AX444', 'the previous system no longer shows this credit: keep the ADEX balance and resolve the new difference');
      end if;
      v_money := adex.route_migration_set_balance_internal(x, p_route, v_ctrl, sl.id, d.source_code,
                   case when d.source_status = 'paid' then 0 else d.source_balance_minor end, d.source_report_date, p_operation_id, v_why);
    elsif p_action = 'reopen' then
      if d.source_status <> 'active' then
        perform adex.capital_raise('AX444', 'the previous system no longer shows this credit as active: keep it paid');
      end if;
      v_money := adex.route_migration_set_balance_internal(x, p_route, v_ctrl, sl.id, d.source_code, d.source_balance_minor, d.source_report_date,
                                                           p_operation_id, v_why);
    elsif p_action = 'paid' then
      v_money := adex.route_migration_set_balance_internal(x, p_route, v_ctrl, sl.id, d.source_code, 0, d.source_report_date, p_operation_id, v_why);
    elsif p_action = 'void' then
      v_money := adex.route_migration_void_internal(x, p_route, v_ctrl, sl.id, d.source_code, d.source_report_date,
                                                    adex.derived_operation_id(p_operation_id, 'void'), v_why);
    elsif p_action = 'keep_adex' and d.source_status = 'active' then
      v_off := d.source_balance_minor - sl.balance_minor;
    end if;

    select * into sl from adex.sales where company_id = x.company and id = d.sale_id;
    v_after := jsonb_build_object('status', sl.status, 'balanceMinor', sl.balance_minor, 'valueMinor', sl.sale_value_minor, 'totalMinor', sl.total_value_minor);
    v_res := jsonb_build_object('before', v_before, 'after', v_after) || v_money;
    update adex.route_migration_differences
       set status = 'resuelta', action = p_action, reason = v_why, kept_offset_minor = v_off, resolved_at = now(),
           resolved_by_membership_id = x.actor, resolved_by_identity_id = x.identity, resolved_role = x.role,
           resolve_operation_id = p_operation_id, result = v_res, updated_at = now()
     where company_id = x.company and id = d.id;
    return jsonb_build_object('differenceId', d.id, 'migrationId', m.id, 'routeId', p_route, 'routeName', r.name, 'code', d.source_code,
                              'kind', d.kind, 'action', p_action, 'reason', v_why, 'sourceStatus', d.source_status,
                              'sourceBalanceMinor', d.source_balance_minor, 'adexBalanceMinor', d.adex_balance_minor,
                              'openDifferences', (select count(*) from adex.route_migration_differences
                                                   where company_id = x.company and migration_id = m.id and status = 'abierta'),
                              'businessDate', x.today) || v_res;
  exception
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('route_migration_differences_resolve_key', 'capital_operations_operation_key') then
        perform adex.capital_raise('AX409', 'operation id already used');
      end if;
      raise;
  end $$;
revoke all on function adex.route_migration_resolve_difference(uuid, text, text, text, text) from public;
grant execute on function adex.route_migration_resolve_difference(uuid, text, text, text, text) to adex_api;

-- ============================================================
-- 6. Terminar la migración: cero diferencias abiertas
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
