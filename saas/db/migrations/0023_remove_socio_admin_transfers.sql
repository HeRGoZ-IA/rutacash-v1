-- 0023 · Ronda 53: retirada definitiva del modelo Socio y traspasos entre Administradores (D2).
--
-- A. SOCIO deja de existir en ADEX Online (decisión del propietario, R53):
--    · ninguna membresía Socio (las que quedan se borran; ver verificación previa);
--    · sin Caja socios (`partner_cash_movements`), sin cuentas `partner`, sin columnas de socio en
--      `transfers`, sin el comando PARTNER_CONTRIBUTION y sin `socio` en `ctx_can` ni en las políticas.
--    Los aportes HISTÓRICOS de socio (tipo PARTNER_CONTRIBUTION, ya no se pueden crear ni anular) eran
--    capital que entró desde fuera a la bolsa de un Administrador: su contrapartida pasa a la cuenta
--    EXTERNA de la empresa. Mismo importe, fecha, actor y bolsa; ninguna bolsa ni custodia cambia; la
--    conservación (Σ saldos = 0) se mantiene. Los cierres de periodo no cambian (su huella son los
--    identificadores de operación y las cifras de custodia).
--
-- B. TRASPASOS ENTRE ADMINISTRADORES (`adex.admin_transfers`), contrato en
--    docs/ADEX_RONDA_53_TRANSFERENCIAS_SIN_SOCIO.md §2:
--      registrar  → ADMIN_TRANSFER_HOLD     bolsa origen → tránsito (el capital queda comprometido)
--      aplicar    → ADMIN_TRANSFER_APPLY    tránsito → bolsa destino (con todas las confirmaciones)
--      rechazar / cancelar → ADMIN_TRANSFER_RELEASE  tránsito → bolsa origen
--    Directo: lo registra el Administrador origen (su parte queda confirmada) y confirma el destino.
--    Secretario: lo registra un Secretario y confirman AMBOS Administradores, cada uno por su lado.

-- ============================================================
-- A.1 Verificación previa: lo único que puede colgar de una membresía Socio
-- ============================================================
do $$
declare
  fk record;
  n bigint;
  handled text[] := array['adex.membership_routes.membership_id', 'adex.capital_accounts.membership_id',
                          'adex.capital_operations.counterpart_membership_id', 'adex.partner_cash_movements.partner_membership_id',
                          'adex.transfers.partner_origin_membership_id', 'adex.transfers.partner_destination_membership_id'];
begin
  for fk in
    select k.conrelid::regclass::text t, a.attname::text col
      from pg_constraint k cross join lateral unnest(k.conkey) x(attnum)
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.attnum
     where k.contype = 'f' and k.confrelid = 'adex.memberships'::regclass and a.attname <> 'company_id'
  loop
    if fk.t || '.' || fk.col = any(handled) then continue; end if;
    execute format('select count(*) from %s x where x.%I in (select id from adex.memberships where role = ''socio'')', fk.t, fk.col) into n;
    if n > 0 then
      raise exception 'adex 0023: % fila(s) de %.% dependen de membresías Socio; retirar antes (p. ej. purgar las Demo)', n, fk.t, fk.col;
    end if;
  end loop;
  if exists (select 1 from adex.capital_accounts a where a.kind = 'partner'
               and not exists (select 1 from adex.memberships m where m.company_id = a.company_id and m.id = a.membership_id and m.role = 'socio')) then
    raise exception 'adex 0023: hay cuentas partner que no pertenecen a un Socio';
  end if;
  if exists (select 1 from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
               join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
              where a.kind = 'partner' and coalesce(o.reverses_kind, o.kind) <> 'PARTNER_CONTRIBUTION') then
    raise exception 'adex 0023: una cuenta partner tiene asientos que no son aportes';
  end if;
  if exists (select 1 from adex.capital_operations where counterpart_membership_id in (select id from adex.memberships where role = 'socio')
               and coalesce(reverses_kind, kind) <> 'PARTNER_CONTRIBUTION') then
    raise exception 'adex 0023: una membresía Socio es contrapartida de una operación que no es un aporte';
  end if;
  if exists (select 1 from adex.capital_operations where actor_role = 'socio')
     or exists (select 1 from adex.audit_log where actor_role = 'socio')
     or exists (select 1 from adex.capital_ledger where actor_role = 'socio')
     or exists (select 1 from adex.route_capital_controller_events where actor_role = 'socio')
     or exists (select 1 from adex.payment_adjustment_requests where requested_by_role = 'socio') then
    raise exception 'adex 0023: un Socio figura como actor de un registro';
  end if;
end $$;

-- ============================================================
-- A.2 Datos (una sola transacción; las guardas se desactivan y restauran aquí dentro)
-- ============================================================
-- Como dueño de las tablas con FORCE RLS, adex_owner vería filtrado su propio UPDATE/DELETE.
alter table adex.capital_accounts       no force row level security;
alter table adex.capital_entries        no force row level security;
alter table adex.capital_operations     no force row level security;
alter table adex.transfers              no force row level security;
alter table adex.memberships            no force row level security;
alter table adex.membership_routes      no force row level security;
alter table adex.capital_accounts   disable trigger capital_accounts_guard;
alter table adex.capital_accounts   disable trigger capital_accounts_no_delete;
alter table adex.capital_entries    disable trigger capital_entries_immutable;
alter table adex.capital_operations disable trigger capital_operations_immutable;
alter table adex.transfers          disable trigger transfers_no_delete;

-- Aportes históricos: contrapartida socio → cuenta externa de la misma empresa.
do $$
declare r record; v_ext text;
begin
  for r in select id, company_id from adex.capital_accounts where kind = 'partner' order by company_id, id loop
    perform adex.capital_account_for(r.company_id, 'external', null, null);
    select id into strict v_ext from adex.capital_accounts where company_id = r.company_id and kind = 'external';
    update adex.capital_entries set account_id = v_ext where company_id = r.company_id and account_id = r.id;
    -- Saldo tras cada pata de la cuenta externa, en el orden del libro.
    update adex.capital_entries e set balance_after_minor = x.run
      from (select operation_id, leg, sum(amount_minor) over (order by seq) run
              from adex.capital_entries where company_id = r.company_id and account_id = v_ext) x
     where e.company_id = r.company_id and e.operation_id = x.operation_id and e.leg = x.leg and e.balance_after_minor <> x.run;
    update adex.capital_accounts
       set balance_minor = coalesce((select sum(e.amount_minor) from adex.capital_entries e where e.company_id = r.company_id and e.account_id = v_ext), 0),
           version = version + 1, updated_at = now()
     where company_id = r.company_id and id = v_ext;
  end loop;
end $$;
update adex.capital_operations set counterpart_membership_id = null
 where coalesce(reverses_kind, kind) = 'PARTNER_CONTRIBUTION' and counterpart_membership_id is not null;
delete from adex.capital_accounts where kind = 'partner';

-- Transferencias Ruta↔Socio del modelo importado y Caja socios.
-- Primero Caja socios (sus filas referencian las transferencias), después las transferencias con socio.
drop table adex.partner_cash_movements;
delete from adex.transfers where partner_origin_membership_id is not null or partner_destination_membership_id is not null;

-- Membresías Socio (y sus rutas). La historia que podía colgar de ellas ya se trató arriba.
alter table adex.memberships disable trigger memberships_protected_delete;
delete from adex.membership_routes where membership_id in (select id from adex.memberships where role = 'socio');
delete from adex.memberships where role = 'socio';
alter table adex.memberships enable trigger memberships_protected_delete;
-- Las restricciones diferidas de lo borrado se comprueban AQUÍ (un ALTER TABLE no admite eventos pendientes).
set constraints all immediate;

alter table adex.capital_accounts   enable trigger capital_accounts_guard;
alter table adex.capital_accounts   enable trigger capital_accounts_no_delete;
alter table adex.capital_entries    enable trigger capital_entries_immutable;
alter table adex.capital_operations enable trigger capital_operations_immutable;
alter table adex.transfers          enable trigger transfers_no_delete;
alter table adex.capital_accounts       force row level security;
alter table adex.capital_entries        force row level security;
alter table adex.capital_operations     force row level security;
alter table adex.transfers              force row level security;
alter table adex.memberships            force row level security;
alter table adex.membership_routes      force row level security;

-- ============================================================
-- A.3 Esquema sin Socio
-- ============================================================
alter table adex.memberships drop constraint memberships_role_check;
alter table adex.memberships add constraint memberships_role_check
  check (role in ('superadmin', 'admin', 'supervisor', 'cobrador', 'secretario'));
alter table adex.payment_adjustment_requests drop constraint payment_adjustment_requests_requested_by_role_check;
alter table adex.payment_adjustment_requests add constraint payment_adjustment_requests_requested_by_role_check
  check (requested_by_role in ('superadmin', 'admin', 'supervisor', 'cobrador', 'secretario'));
alter table adex.capital_ledger drop constraint capital_ledger_actor_role_check;
alter table adex.capital_ledger add constraint capital_ledger_actor_role_check
  check (actor_role in ('superadmin', 'admin', 'supervisor', 'cobrador', 'secretario', 'system'));
alter table adex.route_capital_controller_events drop constraint route_capital_controller_events_actor_role_check;
alter table adex.route_capital_controller_events add constraint route_capital_controller_events_actor_role_check
  check (actor_role in ('superadmin', 'admin', 'supervisor', 'cobrador', 'secretario', 'system'));
alter table adex.audit_log drop constraint audit_log_actor_role_check;
alter table adex.audit_log add constraint audit_log_actor_role_check
  check (actor_role in ('superadmin', 'admin', 'supervisor', 'cobrador', 'secretario'));

-- `transfers` (modelo importado de CLEAN): solo Ruta → Ruta.
alter table adex.transfers drop column partner_origin_membership_id, drop column partner_destination_membership_id;
alter table adex.transfers drop constraint if exists transfers_origin_type_check, drop constraint if exists transfers_destination_type_check;
alter table adex.transfers add constraint transfers_route_endpoints
  check (route_origin_id is not null and route_destination_id is not null
         and (origin_type is null or origin_type = 'route') and (destination_type is null or destination_type = 'route'));

-- Cuentas: sin `partner`; nueva cuenta de TRÁNSITO de la empresa (traspasos pendientes). Nunca negativa.
alter table adex.capital_accounts drop constraint capital_accounts_kind_check;
alter table adex.capital_accounts add constraint capital_accounts_kind_check
  check (kind in ('company', 'admin', 'custody', 'external', 'portfolio', 'income', 'expense', 'suspense', 'unidentified', 'transit'));
alter table adex.capital_accounts drop constraint capital_accounts_shape_check;
alter table adex.capital_accounts add constraint capital_accounts_shape_check check (case kind
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
end);
alter table adex.capital_accounts drop constraint capital_accounts_no_overdraft;
alter table adex.capital_accounts add constraint capital_accounts_no_overdraft
  check (kind in ('external', 'income', 'custody', 'unidentified') or balance_minor >= 0);

-- Operaciones: PARTNER_CONTRIBUTION queda SOLO como historia; tres tipos nuevos del traspaso.
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
  'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT',
  'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE', 'EXPENSE_REFUND',
  'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE'));
alter table adex.capital_operations drop constraint capital_operations_actor_role_check;
alter table adex.capital_operations add constraint capital_operations_actor_role_check
  check (actor_role in ('superadmin', 'admin', 'supervisor')
         or (actor_role = 'cobrador' and kind in ('LOAN_DISBURSEMENT', 'COLLECTION', 'WORKER_EXPENSE'))
         or (actor_role = 'secretario' and (kind in ('COLLECTION', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_RELEASE')
                                            or (kind = 'REVERSAL' and reverses_kind = 'COLLECTION'))));
create trigger capital_operations_no_new_partner before insert on adex.capital_operations
  for each row when (new.kind = 'PARTNER_CONTRIBUTION' or new.reverses_kind = 'PARTNER_CONTRIBUTION')
  execute function adex.reject_mutation();

-- Segunda barrera de capacidades: la de 0017 sin `socio`.
create or replace function adex.ctx_can(p_capability text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select coalesce(adex.ctx_role() = any(case p_capability
      when 'sale.createRequest'               then array['superadmin', 'admin', 'supervisor', 'cobrador']
      when 'sale.createDirect'                then array['superadmin', 'admin', 'supervisor']
      when 'sale.confirmDisbursement'         then array['superadmin', 'admin', 'supervisor', 'cobrador']
      when 'sale.cancel'                      then array['superadmin', 'admin']
      when 'authorization.access'             then array['superadmin', 'admin', 'supervisor', 'secretario']
      when 'authorization.approve'            then array['superadmin', 'admin', 'supervisor', 'secretario']
      when 'authorization.reject'             then array['superadmin', 'admin', 'supervisor', 'secretario']
      when 'authorization.modifyConditions'   then array['superadmin', 'admin', 'supervisor', 'secretario']
      when 'authorization.phoneConfirm'       then array['superadmin', 'supervisor', 'secretario']
      when 'payment.register'                 then array['superadmin', 'admin', 'supervisor', 'cobrador']
      when 'payment.reverse'                  then array['superadmin', 'admin']
      when 'payment.approveAdjustment'        then array['superadmin', 'admin']
      when 'payment.correct'                  then array['superadmin', 'admin', 'secretario']
      when 'payment.viewHistory'              then array['superadmin', 'admin', 'supervisor', 'cobrador', 'secretario']
      when 'expense.register'                 then array['superadmin', 'admin', 'supervisor', 'cobrador']
      when 'expense.correct'                  then array['superadmin', 'admin']
      when 'cashCustody.manage'               then array['superadmin', 'admin', 'supervisor']
      when 'cashbox.viewConsolidated'         then array['superadmin', 'admin']
      when 'cashbox.viewRoute'                then array['superadmin', 'admin', 'supervisor']
      when 'cashSettlement.view'              then array['superadmin', 'admin', 'supervisor']
      when 'cashSettlement.viewOwn'           then array['supervisor', 'cobrador']
      when 'cashSettlement.close'             then array['superadmin', 'admin', 'supervisor']
      when 'cashSettlement.reopen'            then array['superadmin', 'admin']
      when 'settlement.close'                 then array['superadmin', 'admin']
      when 'settlement.reopen'                then array['superadmin', 'admin']
      else array[]::text[] end), false)
  $$;

-- Políticas: las de 0020 sin `socio` (y sin la visibilidad del socio sobre sus aportes).
alter policy capital_accounts_ctx on adex.capital_accounts
  using ((((company_id)::text = adex.ctx_company()) AND ( SELECT adex.ctx_membership_active() AS ctx_membership_active) AND ((( SELECT adex.ctx_role() AS ctx_role) = 'superadmin'::text) OR ((kind = ANY (ARRAY['admin'::text, 'custody'::text, 'suspense'::text])) AND ((membership_id)::text = adex.ctx_membership())) OR ((kind = 'custody'::text) AND ( SELECT adex.ctx_is(ARRAY['admin'::text, 'supervisor'::text]) AS ctx_is) AND adex.route_in_scope((route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids))))));
alter policy capital_movements_ctx on adex.capital_movements
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)) AND ( SELECT adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'supervisor'::text]) AS ctx_is)));
alter policy capital_operations_ctx on adex.capital_operations
  using ((((company_id)::text = adex.ctx_company()) AND ( SELECT adex.ctx_membership_active() AS ctx_membership_active) AND ((( SELECT adex.ctx_role() AS ctx_role) = 'superadmin'::text) OR ((admin_membership_id)::text = adex.ctx_membership()) OR ((COALESCE(reverses_kind, kind) = ANY (ARRAY['WORKER_DELIVERY'::text, 'WORKER_RETURN'::text, 'WORKER_TRANSFER'::text, 'ROUTE_REASSIGNMENT'::text, 'LOAN_DISBURSEMENT'::text, 'COLLECTION'::text, 'WORKER_EXPENSE'::text, 'ROUTE_EXPENSE'::text, 'SETTLEMENT_RETURN'::text, 'SETTLEMENT_SURPLUS'::text])) AND ((adex.ctx_membership() = (worker_membership_id)::text) OR (adex.ctx_membership() = (counterpart_membership_id)::text) OR (( SELECT adex.ctx_is(ARRAY['admin'::text, 'supervisor'::text]) AS ctx_is) AND (adex.route_in_scope((route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)) OR adex.route_in_scope((to_route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)))))))));
alter policy cash_custody_movements_ctx on adex.cash_custody_movements
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)) AND (( SELECT adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'supervisor'::text]) AS ctx_is) OR ((adex.ctx_membership() = (from_membership_id)::text) OR (adex.ctx_membership() = (to_membership_id)::text)))));
alter policy expenses_ctx on adex.expenses
  using ((((company_id)::text = adex.ctx_company()) AND ( SELECT adex.ctx_membership_active() AS ctx_membership_active) AND ((( SELECT adex.ctx_role() AS ctx_role) = 'superadmin'::text) OR ((route_id IS NOT NULL) AND ( SELECT adex.ctx_is(ARRAY['admin'::text, 'supervisor'::text]) AS ctx_is) AND adex.route_in_scope((route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids))) OR ((route_id IS NOT NULL) AND adex.route_in_scope((route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)) AND ((adex.ctx_membership() = (collector_membership_id)::text) OR (adex.ctx_membership() = (registered_by_membership_id)::text))) OR ((route_id IS NULL) AND (( SELECT adex.ctx_role() AS ctx_role) = 'admin'::text) AND (((funding_admin_membership_id)::text = adex.ctx_membership()) OR ((funding IS NULL) AND ((registered_by_membership_id)::text = adex.ctx_membership())))))));
alter policy period_closures_ctx on adex.period_closures
  using ((((company_id)::text = adex.ctx_company()) AND ( SELECT adex.ctx_membership_active() AS ctx_membership_active) AND adex.route_in_scope((route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)) AND ( SELECT adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'supervisor'::text]) AS ctx_is)));
alter policy transfers_ctx on adex.transfers
  using ((((company_id)::text = adex.ctx_company()) AND ( SELECT adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'supervisor'::text]) AS ctx_is) AND (adex.route_in_scope((route_origin_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)) OR adex.route_in_scope((route_destination_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)) OR (( SELECT adex.ctx_role() AS ctx_role) = 'superadmin'::text))));
alter policy weekly_settlements_ctx on adex.weekly_settlements
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)) AND ( SELECT adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'supervisor'::text]) AS ctx_is)));
alter policy withdrawals_ctx on adex.withdrawals
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, ( SELECT adex.ctx_routes_all() AS ctx_routes_all), ( SELECT adex.ctx_route_ids() AS ctx_route_ids)) AND ( SELECT adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'supervisor'::text]) AS ctx_is)));

-- Empresa Demo: sin puestos de Socio (la Demo podrá recrearse con el modelo vigente).
create or replace function adex_demo.provision_company(
  p_slot text, p_company_id text, p_name text, p_country_code text, p_country_label text, p_currency text,
  p_timezone text, p_scenario text, p_seats jsonb
) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, adex, adex_demo
  as $$
  declare
    s jsonb;
    v_identity uuid;
    v_membership text;
    v_tag text := left(replace(p_company_id, '-', ''), 12);
    out jsonb := '[]'::jsonb;
  begin
    if jsonb_typeof(p_seats) <> 'array' or jsonb_array_length(p_seats) = 0 then
      raise exception 'adex_demo: seats required' using errcode = 'AX611';
    end if;
    perform set_config('adex_demo.lifecycle', 'on', true);
    insert into adex.companies (id, name, email, plan, status, country_code, country_label, currency_code, timezone,
                                contact_name, is_demo, created_at, updated_at)
    values (p_company_id, p_name, format('demo-%s@example.test', v_tag), 'operativo', 'activa', p_country_code, p_country_label,
            p_currency, p_timezone, 'Empresa Demo (datos ficticios)', true, now(), now());
    insert into adex.expense_categories (id, company_id, name, active)
    select gen_random_uuid()::text, p_company_id, n, true
      from unnest(array['Transporte', 'Alimentación', 'Papelería', 'Combustible', 'Comunicación', 'Mantenimiento', 'Otros']) n;
    insert into adex_demo.companies (company_id, slot, state, scenario_version, created_by)
    values (p_company_id, p_slot, 'provisioning', p_scenario, adex.ctx_identity());
    for s in select * from jsonb_array_elements(p_seats) loop
      if (s ->> 'role') not in ('superadmin', 'admin', 'supervisor', 'cobrador', 'secretario')
         or coalesce(s ->> 'seat', '') !~ '^[a-z][a-z0-9-]{1,40}$'
         or length(btrim(coalesce(s ->> 'displayName', ''))) = 0 then
        raise exception 'adex_demo: invalid seat' using errcode = 'AX611';
      end if;
      v_identity := gen_random_uuid();
      v_membership := gen_random_uuid()::text;
      -- Identidad SINTÉTICA: sin cuenta en el proveedor, nadie puede iniciar sesión con ella.
      insert into adex.identities (id, email) values (v_identity, format('demo-%s-%s@example.test', v_tag, s ->> 'seat'));
      insert into adex.memberships (id, company_id, identity_id, role, status, display_name, created_at, updated_at)
      values (v_membership, p_company_id, v_identity, s ->> 'role', 'activo', btrim(s ->> 'displayName'), now(), now());
      insert into adex_demo.seats (company_id, seat, role, membership_id, identity_id, placeholder_identity_id, synthetic, assignable)
      values (p_company_id, s ->> 'seat', s ->> 'role', v_membership, v_identity, v_identity, true,
              coalesce((s ->> 'assignable')::boolean, false));
      out := out || jsonb_build_object('seat', s ->> 'seat', 'role', s ->> 'role', 'membershipId', v_membership);
    end loop;
    return out;
  end $$;

-- `capital_post` de 0018 sin PARTNER_CONTRIBUTION: ni aporte nuevo ni anulación de uno histórico. Los
-- asientos del traspaso entre Administradores tampoco se anulan por aquí (tienen sus propios comandos).
create or replace function adex.capital_post(
  p_operation_id uuid,
  p_kind         text,
  p_amount       bigint,
  p_reason       text,
  p_route        text default null,
  p_worker       text default null,
  p_counterpart  text default null,
  p_to_route     text default null,
  p_admin        text default null,
  p_sale_request text default null,
  p_reverses     text default null
) returns adex.capital_operations
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company   text := adex.ctx_company();
    v_actor     text := adex.ctx_membership();
    v_role      text := adex.ctx_role();          -- NULL sin contexto válido (sesión, membresía, empresa)
    v_identity  uuid := adex.ctx_identity();
    v_reversal  boolean := p_kind = 'REVERSAL';
    v_currency  char(3);
    v_date      date;
    v_kind      text := p_kind;
    v_amount    bigint := p_amount;
    v_route     text := p_route;
    v_to_route  text := p_to_route;
    v_worker    text := p_worker;
    v_counter   text := p_counterpart;
    v_admin     text := p_admin;
    v_orig      adex.capital_operations;
    v_ctrl      text;
    v_ctrl2     text;
    v_accts     text[];
    v_amts      bigint[];
    v_bal       bigint;
    v_carried   bigint;
    v_op        adex.capital_operations;
    v_i         int;
    v_cname     text;
  begin
    -- ---------- Contexto y entrada ----------
    if session_user <> 'adex_api' then
      perform adex.capital_raise('42501', 'capital commands run only through the company API');
    end if;
    if v_role is null or v_company is null or v_identity is null or v_actor is null then
      perform adex.capital_raise('42501', 'no valid active context');
    end if;
    if v_role not in ('superadmin', 'admin', 'supervisor') then
      perform adex.capital_raise('AX402', 'role has no capital authority');
    end if;
    if p_operation_id is null or p_kind is null then perform adex.capital_raise('AX411', 'operation id and kind are required'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    select c.currency_code, adex.business_today(c.id) into v_currency, v_date from adex.companies c where c.id = v_company;
    if exists (select 1 from adex.capital_operations where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;

    -- ---------- Anulación: todo se deriva de la operación original ----------
    if v_reversal then
      if p_reverses is null then perform adex.capital_raise('AX411', 'reversal needs the original operation'); end if;
      perform pg_advisory_xact_lock(adex.lock_key('capital-reversal', v_company || ':' || p_reverses));
      select * into v_orig from adex.capital_operations where company_id = v_company and id = p_reverses;
      if not found then perform adex.capital_raise('AX412', 'operation not found'); end if;
      if v_orig.kind = 'REVERSAL' then perform adex.capital_raise('AX404', 'a reversal cannot be reversed'); end if;
      -- «Anular» un retiro de la empresa reintroduciría dinero: si vuelve, es un depósito nuevo.
      if v_orig.kind = 'COMPANY_WITHDRAWAL' then perform adex.capital_raise('AX404', 'a company withdrawal is corrected with a new deposit'); end if;
      if v_orig.kind = 'PARTNER_CONTRIBUTION' then perform adex.capital_raise('AX404', 'historical partner contributions cannot be reversed'); end if;
      if v_orig.kind like 'ADMIN_TRANSFER_%' then perform adex.capital_raise('AX404', 'administrator transfers are settled by their own commands'); end if;
      if exists (select 1 from adex.capital_operations where company_id = v_company and reverses_operation_id = v_orig.id) then
        perform adex.capital_raise('AX405', 'operation already reversed');
      end if;
      v_kind := v_orig.kind; v_amount := v_orig.amount_minor; v_route := v_orig.route_id; v_to_route := v_orig.to_route_id;
      v_worker := v_orig.worker_membership_id; v_counter := v_orig.counterpart_membership_id; v_admin := v_orig.admin_membership_id;
    end if;

    -- ---------- Campos obligatorios por tipo ----------
    if v_amount is null or v_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
    if (v_kind in ('ADMIN_ALLOCATION', 'ADMIN_RETURN') and v_admin is null)
       or (v_kind in ('WORKER_DELIVERY', 'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and v_route is null)
       or (v_kind in ('WORKER_DELIVERY', 'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and v_worker is null)
       or (v_kind in ('WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and v_counter is null)
       or (v_kind = 'ROUTE_REASSIGNMENT' and (v_to_route is null or v_to_route = v_route))
       or (v_kind not in ('ROUTE_REASSIGNMENT') and v_to_route is not null)
       or (v_kind in ('COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN') and v_route is not null)
       or (p_sale_request is not null and (v_reversal or v_kind <> 'WORKER_DELIVERY')) then
      perform adex.capital_raise('AX411', 'invalid fields for this operation kind');
    end if;

    -- ---------- Rutas: bloqueo y responsable releído bajo bloqueo (R5) ----------
    if v_route is not null then
      perform 1 from adex.routes where company_id = v_company and id in (v_route, v_to_route) order by id for update;
      select capital_controller_membership_id into v_ctrl from adex.routes where company_id = v_company and id = v_route;
      if not found then perform adex.capital_raise('AX412', 'route not found'); end if;
      if v_ctrl is not null and not adex.route_controller_valid_internal(v_company, v_route) then v_ctrl := null; end if;
      if v_to_route is not null then
        select capital_controller_membership_id into v_ctrl2 from adex.routes where company_id = v_company and id = v_to_route;
        if not found then perform adex.capital_raise('AX412', 'route not found'); end if;
        if v_ctrl2 is not null and not adex.route_controller_valid_internal(v_company, v_to_route) then v_ctrl2 := null; end if;
      end if;
      if v_ctrl is null or (v_to_route is not null and v_ctrl2 is null) then
        perform adex.capital_raise('AX408', 'route has no valid capital controller');
      end if;
      if adex.capital_period_closed(v_company, v_route, v_date)
         or (v_to_route is not null and adex.capital_period_closed(v_company, v_to_route, v_date)) then
        perform adex.capital_raise('AX407', 'the period of the route is closed');
      end if;
    end if;

    -- ---------- Autoridad y patas por tipo ----------
    -- structural = solo el responsable; settle = responsable, SuperAdmin o Supervisor
    -- asignado; correct = responsable o SuperAdmin (`routeCashAuthorityError` de CLEAN).
    -- Comparaciones con IS [NOT] DISTINCT FROM: un NULL nunca concede autoridad.
    if v_kind in ('COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN') then
      if v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the SuperAdmin moves company capital'); end if;
      if v_kind in ('ADMIN_ALLOCATION', 'ADMIN_RETURN') then
        -- Recibir capital exige estar activo; devolverlo, no (una bolsa inactiva se vacía).
        if not exists (select 1 from adex.memberships where company_id = v_company and id = v_admin and role = 'admin'
                         and (status = 'activo' or (v_kind = 'ADMIN_ALLOCATION') = v_reversal)) then
          perform adex.capital_raise('AX412', 'administrator not found or inactive');
        end if;
      end if;
      case v_kind
        when 'COMPANY_DEPOSIT'    then v_accts := array[adex.capital_account_for(v_company, 'external', null, null), adex.capital_account_for(v_company, 'company', null, null)];
        when 'COMPANY_WITHDRAWAL' then v_accts := array[adex.capital_account_for(v_company, 'company', null, null), adex.capital_account_for(v_company, 'external', null, null)];
        when 'ADMIN_ALLOCATION'   then v_accts := array[adex.capital_account_for(v_company, 'company', null, null), adex.capital_account_for(v_company, 'admin', v_admin, null)];
        else                           v_accts := array[adex.capital_account_for(v_company, 'admin', v_admin, null), adex.capital_account_for(v_company, 'company', null, null)];
      end case;

    elsif v_kind = 'WORKER_DELIVERY' then
      if v_reversal then
        if v_actor is distinct from v_ctrl and v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can correct'); end if;
      else
        if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the route capital controller delivers capital'); end if;
        if not adex.route_operational(v_company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
        if not adex.capital_custodian_ok(v_company, v_route, v_worker) then perform adex.capital_raise('AX403', 'recipient cannot hold cash in this route'); end if;
        if p_sale_request is not null and not exists (select 1 from adex.sale_requests where company_id = v_company and id = p_sale_request and route_id = v_route) then
          perform adex.capital_raise('AX412', 'sale request not found in this route');
        end if;
      end if;
      v_admin := v_ctrl;   -- paga (o, al anular, recupera) la bolsa que HOY responde por la ruta
      v_accts := array[adex.capital_account_for(v_company, 'admin', v_admin, null), adex.capital_account_for(v_company, 'custody', v_worker, v_route)];

    elsif v_kind = 'WORKER_RETURN' then
      if v_reversal then
        if v_actor is distinct from v_ctrl and v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can correct'); end if;
      else
        if not (v_actor is not distinct from v_ctrl or v_role = 'superadmin'
                or (v_role = 'supervisor' and exists (select 1 from adex.membership_routes where company_id = v_company and membership_id = v_actor and route_id = v_route))) then
          perform adex.capital_raise('AX402', 'no authority to receive returns in this route');
        end if;
        if not exists (select 1 from adex.memberships where company_id = v_company and id = v_worker and role in ('cobrador', 'supervisor')) then
          perform adex.capital_raise('AX403', 'worker not found');
        end if;
      end if;
      v_admin := v_ctrl;
      v_accts := array[adex.capital_account_for(v_company, 'custody', v_worker, v_route), adex.capital_account_for(v_company, 'admin', v_admin, null)];

    elsif v_kind = 'WORKER_TRANSFER' then
      if v_reversal then
        if v_actor is distinct from v_ctrl and v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can correct'); end if;
        v_accts := array[adex.capital_account_for(v_company, 'custody', v_counter, v_route), adex.capital_account_for(v_company, 'custody', v_worker, v_route)];
      else
        if not (v_actor is not distinct from v_ctrl or v_role = 'superadmin'
                or (v_role = 'supervisor' and exists (select 1 from adex.membership_routes where company_id = v_company and membership_id = v_actor and route_id = v_route))) then
          perform adex.capital_raise('AX402', 'no authority over cash in this route');
        end if;
        if v_worker = v_counter then perform adex.capital_raise('AX411', 'origin and destination must differ'); end if;
        if not adex.route_operational(v_company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
        if not exists (select 1 from adex.memberships m join adex.membership_routes mr on mr.membership_id = m.id and mr.route_id = v_route and mr.company_id = m.company_id
                        where m.company_id = v_company and m.id = v_worker and m.role in ('cobrador', 'supervisor')) then
          perform adex.capital_raise('AX403', 'origin worker is not assigned to this route');
        end if;
        if not adex.capital_custodian_ok(v_company, v_route, v_counter) then perform adex.capital_raise('AX403', 'recipient cannot hold cash in this route'); end if;
        v_accts := array[adex.capital_account_for(v_company, 'custody', v_worker, v_route), adex.capital_account_for(v_company, 'custody', v_counter, v_route)];
      end if;

    elsif v_kind = 'ROUTE_REASSIGNMENT' then
      -- Devolución en una ruta + entrega en otra, por el MISMO responsable, en una sola
      -- operación: cada ruta conserva su atribución y el dinero pasa por la bolsa.
      -- Entre responsables distintos se usa el traspaso entre Administradores (0023).
      if v_ctrl is distinct from v_ctrl2 then perform adex.capital_raise('AX406', 'routes with different capital controllers'); end if;
      if v_reversal then
        if v_actor is distinct from v_ctrl and v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can correct'); end if;
        v_accts := array[adex.capital_account_for(v_company, 'custody', v_counter, v_to_route), adex.capital_account_for(v_company, 'admin', v_ctrl, null),
                         adex.capital_account_for(v_company, 'admin', v_ctrl, null), adex.capital_account_for(v_company, 'custody', v_worker, v_route)];
      else
        if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the capital controller of both routes reassigns cash'); end if;
        if not adex.route_operational(v_company, v_to_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
        if not exists (select 1 from adex.memberships where company_id = v_company and id = v_worker and role in ('cobrador', 'supervisor')) then
          perform adex.capital_raise('AX403', 'worker not found');
        end if;
        if not adex.capital_custodian_ok(v_company, v_to_route, v_counter) then perform adex.capital_raise('AX403', 'recipient cannot hold cash in the destination route'); end if;
        v_accts := array[adex.capital_account_for(v_company, 'custody', v_worker, v_route), adex.capital_account_for(v_company, 'admin', v_ctrl, null),
                         adex.capital_account_for(v_company, 'admin', v_ctrl, null), adex.capital_account_for(v_company, 'custody', v_counter, v_to_route)];
      end if;
      v_admin := v_ctrl;
    else
      perform adex.capital_raise('AX411', 'unknown operation kind');
    end if;

    -- Anular invierte el sentido. Los tipos de dos patas se construyeron en el sentido
    -- original: se intercambian. Traspaso y reasignación ya se construyeron invertidos.
    if v_reversal and array_length(v_accts, 1) = 2 and v_kind <> 'WORKER_TRANSFER' then
      v_accts := array[v_accts[2], v_accts[1]];
    end if;
    v_amts := case when array_length(v_accts, 1) = 4 then array[-v_amount, v_amount, -v_amount, v_amount] else array[-v_amount, v_amount] end;

    -- Nadie REDUCE su propia custodia, ni con otra de sus membresías (DS-05: misma
    -- persona). Quien entrega el efectivo no puede ser quien registra que lo entregó.
    if exists (select 1 from adex.capital_accounts a join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
                where a.company_id = v_company and a.id = v_accts[1] and a.kind = 'custody'
                  and (m.id = v_actor or m.identity_id = v_identity)) then
      perform adex.capital_raise('AX410', 'nobody reduces their own custody');
    end if;

    -- ---------- Bloqueo de cuentas en orden global ----------
    perform 1 from adex.capital_accounts
      where company_id = v_company and id = any(v_accts)
      order by array_position(array['company', 'admin', 'custody', 'external'], kind), id
      for update;

    -- Efectivo en manos (no deuda arrastrada) para lo que mueve billetes ya entregados:
    -- traspasos, reasignaciones y anular una entrega (`transferableCash` de CLEAN).
    if (v_kind in ('WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') or (v_reversal and v_kind = 'WORKER_DELIVERY')) then
      select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = v_company and id = v_accts[1];
      if v_bal - v_carried < v_amount then perform adex.capital_raise('AX413', 'the cash was already used'); end if;
    end if;

    -- ---------- Escritura ----------
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, to_route_id,
                                         admin_membership_id, worker_membership_id, counterpart_membership_id, sale_request_id,
                                         reverses_operation_id, reverses_kind, reason, entry_date, actor_membership_id, actor_identity_id,
                                         actor_role, txid)
    values (gen_random_uuid()::text, v_company, p_operation_id, p_kind, v_amount, v_currency, v_route, v_to_route,
            v_admin, v_worker, v_counter, case when v_reversal then v_orig.sale_request_id else p_sale_request end,
            v_orig.id, case when v_reversal then v_orig.kind end, btrim(p_reason), v_date, v_actor, v_identity, v_role, txid_current())
    returning * into v_op;

    for v_i in 1 .. array_length(v_accts, 1) loop
      update adex.capital_accounts
         set balance_minor = balance_minor + v_amts[v_i], version = version + 1, updated_at = now()
       where company_id = v_company and id = v_accts[v_i]
      returning balance_minor into v_bal;
      insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor)
      values (v_company, v_op.id, v_i, v_accts[v_i], v_amts[v_i], v_bal);
    end loop;
    return v_op;
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      -- El sobregiro se informa SIN cifras: nunca revela el saldo de otra cuenta.
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_reversal_key' then perform adex.capital_raise('AX405', 'operation already reversed'); end if;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;

-- ============================================================
-- B. Traspasos entre Administradores
-- ============================================================
create table adex.admin_transfers (
  id                              adex.eid primary key,
  company_id                      adex.eid not null references adex.companies(id),
  operation_id                    uuid not null,          -- id de operación del REGISTRO (= el del asiento de compromiso)
  mode                            text not null check (mode in ('direct', 'secretary')),
  origin_admin_membership_id      adex.eid not null,
  destination_admin_membership_id adex.eid not null,
  amount_minor                    bigint not null check (amount_minor > 0),
  currency_code                   char(3) not null references adex.currencies(code),
  reason                          text not null check (length(btrim(reason)) >= 3 and length(reason) <= 300),
  entry_date                      date not null,
  state                           text not null check (state in ('pending', 'applied', 'rejected', 'cancelled')),
  registered_by_membership_id     adex.eid not null,
  registered_by_identity_id       uuid not null references adex.identities(id),
  registered_by_role              text not null check (registered_by_role in ('admin', 'secretario')),
  origin_decision                 text not null check (origin_decision in ('pending', 'confirmed', 'rejected')),
  origin_decided_at               timestamptz,
  origin_decided_identity_id      uuid references adex.identities(id),
  origin_decision_reason          text check (origin_decision_reason is null or length(origin_decision_reason) <= 300),
  destination_decision            text not null check (destination_decision in ('pending', 'confirmed', 'rejected')),
  destination_decided_at          timestamptz,
  destination_decided_identity_id uuid references adex.identities(id),
  destination_decision_reason     text check (destination_decision_reason is null or length(destination_decision_reason) <= 300),
  hold_operation_id               adex.eid not null,
  settle_operation_id             adex.eid,
  closed_at                       timestamptz,
  closed_by_membership_id         adex.eid,
  close_reason                    text check (close_reason is null or length(close_reason) <= 300),
  created_at                      timestamptz not null default now(),
  unique (company_id, id),
  constraint admin_transfers_operation_key unique (company_id, operation_id),
  check (origin_admin_membership_id <> destination_admin_membership_id),
  check ((state = 'pending') = (settle_operation_id is null)),
  check ((state = 'pending') = (closed_at is null)),
  check (state <> 'applied' or (origin_decision = 'confirmed' and destination_decision = 'confirmed')),
  check (state <> 'rejected' or 'rejected' in (origin_decision, destination_decision)),
  check ((origin_decision = 'pending') = (origin_decided_at is null)),
  check ((destination_decision = 'pending') = (destination_decided_at is null)),
  -- Directo: lo registra el propio origen (su parte, confirmada). Secretario: lo registra un Secretario.
  check ((mode = 'direct') = (registered_by_role = 'admin')),
  check (mode <> 'direct' or registered_by_membership_id = origin_admin_membership_id),
  foreign key (company_id, origin_admin_membership_id)      references adex.memberships(company_id, id),
  foreign key (company_id, destination_admin_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, registered_by_membership_id)     references adex.memberships(company_id, id),
  foreign key (company_id, closed_by_membership_id)         references adex.memberships(company_id, id),
  foreign key (company_id, hold_operation_id)               references adex.capital_operations(company_id, id),
  foreign key (company_id, settle_operation_id)             references adex.capital_operations(company_id, id)
);
create index admin_transfers_origin on adex.admin_transfers (company_id, origin_admin_membership_id, created_at);
create index admin_transfers_destination on adex.admin_transfers (company_id, destination_admin_membership_id, created_at);
create index admin_transfers_pending on adex.admin_transfers (company_id, created_at) where state = 'pending';

-- Solo cambia lo que una decisión puede cambiar, y solo mientras está pendiente.
create function adex.guard_admin_transfer() returns trigger
  language plpgsql
  as $$ begin
    if old.state <> 'pending' then raise exception 'adex: closed administrator transfer % is immutable', old.id using errcode = '42501'; end if;
    if (new.id, new.company_id, new.operation_id, new.mode, new.origin_admin_membership_id, new.destination_admin_membership_id,
        new.amount_minor, new.currency_code, new.reason, new.entry_date, new.registered_by_membership_id, new.registered_by_identity_id,
        new.registered_by_role, new.hold_operation_id, new.created_at)
       is distinct from
       (old.id, old.company_id, old.operation_id, old.mode, old.origin_admin_membership_id, old.destination_admin_membership_id,
        old.amount_minor, old.currency_code, old.reason, old.entry_date, old.registered_by_membership_id, old.registered_by_identity_id,
        old.registered_by_role, old.hold_operation_id, old.created_at) then
      raise exception 'adex: administrator transfer % facts are immutable', old.id using errcode = '42501';
    end if;
    if (old.origin_decision <> 'pending' and (new.origin_decision, new.origin_decided_at, new.origin_decided_identity_id, new.origin_decision_reason)
          is distinct from (old.origin_decision, old.origin_decided_at, old.origin_decided_identity_id, old.origin_decision_reason))
       or (old.destination_decision <> 'pending' and (new.destination_decision, new.destination_decided_at, new.destination_decided_identity_id, new.destination_decision_reason)
          is distinct from (old.destination_decision, old.destination_decided_at, old.destination_decided_identity_id, old.destination_decision_reason)) then
      raise exception 'adex: a decision on administrator transfer % cannot change', old.id using errcode = '42501';
    end if;
    return new;
  end $$;
create trigger admin_transfers_guard before update on adex.admin_transfers for each row execute function adex.guard_admin_transfer();
create trigger admin_transfers_no_delete before delete on adex.admin_transfers for each row execute function adex.reject_mutation();
create trigger admin_transfers_no_truncate before truncate on adex.admin_transfers for each statement execute function adex.reject_mutation();

alter table adex.admin_transfers enable row level security;
alter table adex.admin_transfers force row level security;
create policy owner_admin_transfers_all on adex.admin_transfers for all to adex_owner using (true) with check (true);
-- Cada Administrador, los suyos (origen o destino); el Secretario, los registrados por Secretarios; el SuperAdmin, todos.
create policy admin_transfers_ctx on adex.admin_transfers for select to adex_api
  using (company_id::text = adex.ctx_company() and (select adex.ctx_membership_active())
         and ((select adex.ctx_role()) = 'superadmin'
              or ((select adex.ctx_role()) = 'admin' and adex.ctx_membership() in (origin_admin_membership_id::text, destination_admin_membership_id::text))
              or ((select adex.ctx_role()) = 'secretario' and mode = 'secretary')));
grant select on adex.admin_transfers to adex_api;

-- Asiento de dos patas del traspaso (interno: solo lo llaman las tres funciones de abajo).
create function adex.admin_transfer_post(
  p_company text, p_operation_id uuid, p_kind text, p_amount bigint, p_currency char(3), p_date date, p_reason text,
  p_admin text, p_counterpart text, p_from text, p_to text
) returns text
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare v_op text := gen_random_uuid()::text; v_bal bigint; v_cname text;
  begin
    if exists (select 1 from adex.capital_operations where company_id = p_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    perform 1 from adex.capital_accounts where company_id = p_company and id in (p_from, p_to)
      order by array_position(array['admin', 'transit'], kind), id for update;
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, admin_membership_id,
                                         counterpart_membership_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_op, p_company, p_operation_id, p_kind, p_amount, p_currency, p_admin, p_counterpart, btrim(p_reason), p_date,
            adex.ctx_membership(), adex.ctx_identity(), adex.ctx_role(), txid_current());
    update adex.capital_accounts set balance_minor = balance_minor - p_amount, version = version + 1, updated_at = now()
     where company_id = p_company and id = p_from returning balance_minor into v_bal;
    insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor)
    values (p_company, v_op, 1, p_from, -p_amount, v_bal);
    update adex.capital_accounts set balance_minor = balance_minor + p_amount, version = version + 1, updated_at = now()
     where company_id = p_company and id = p_to returning balance_minor into v_bal;
    insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor)
    values (p_company, v_op, 2, p_to, p_amount, v_bal);
    return v_op;
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
revoke all on function adex.admin_transfer_post(text, uuid, text, bigint, char, date, text, text, text, text, text) from public;

-- Contexto válido de un comando de traspaso (mismas comprobaciones que `capital_post`).
create function adex.admin_transfer_ctx() returns text
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$ begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'capital commands run only through the company API'); end if;
    if adex.ctx_role() is null or adex.ctx_company() is null or adex.ctx_identity() is null or adex.ctx_membership() is null then
      perform adex.capital_raise('42501', 'no valid active context');
    end if;
    return adex.ctx_company();
  end $$;
revoke all on function adex.admin_transfer_ctx() from public;

-- REGISTRAR. Administrador: origen = él mismo (directo). Secretario: origen y destino (por cuenta de ambos).
create function adex.admin_transfer_register(p_operation_id uuid, p_origin text, p_destination text, p_amount bigint, p_reason text)
  returns adex.admin_transfers
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.admin_transfer_ctx();
    v_actor    text := adex.ctx_membership();
    v_role     text := adex.ctx_role();
    v_identity uuid := adex.ctx_identity();
    v_mode     text;
    v_origin   text := p_origin;
    v_currency char(3);
    v_date     date;
    v_o        adex.memberships;
    v_d        adex.memberships;
    v_hold     text;
    v_row      adex.admin_transfers;
  begin
    if v_role = 'admin' then
      v_mode := 'direct';
      if v_origin is not null and v_origin <> v_actor then perform adex.capital_raise('AX402', 'an administrator only transfers from their own pool'); end if;
      v_origin := v_actor;
    elsif v_role = 'secretario' then
      v_mode := 'secretary';
      if v_origin is null then perform adex.capital_raise('AX411', 'origin administrator is required'); end if;
    else
      perform adex.capital_raise('AX402', 'role cannot register administrator transfers');
    end if;
    if p_operation_id is null or p_destination is null then perform adex.capital_raise('AX411', 'operation id and destination are required'); end if;
    if p_amount is null or p_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    if v_origin = p_destination then perform adex.capital_raise('AX411', 'origin and destination must differ'); end if;
    if exists (select 1 from adex.admin_transfers where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    -- Partes releídas bajo bloqueo compartido (un cambio de rol o estado simultáneo espera).
    perform 1 from adex.memberships where company_id = v_company and id in (v_origin, p_destination) order by id for share;
    select * into v_o from adex.memberships where company_id = v_company and id = v_origin;
    select * into v_d from adex.memberships where company_id = v_company and id = p_destination;
    if v_o.id is null or v_o.role <> 'admin' or v_o.status <> 'activo' then perform adex.capital_raise('AX412', 'origin administrator not found or inactive'); end if;
    if v_d.id is null or v_d.role <> 'admin' or v_d.status <> 'activo' then perform adex.capital_raise('AX412', 'destination administrator not found or inactive'); end if;
    if v_o.identity_id = v_d.identity_id then perform adex.capital_raise('AX411', 'origin and destination are the same person'); end if;
    if v_mode = 'secretary' and v_identity in (v_o.identity_id, v_d.identity_id) then
      perform adex.capital_raise('AX416', 'whoever registers cannot be a party');
    end if;
    select c.currency_code, adex.business_today(c.id) into v_currency, v_date from adex.companies c where c.id = v_company;
    -- El capital queda comprometido YA: sale del disponible de la bolsa de origen (sin sobregiro).
    v_hold := adex.admin_transfer_post(v_company, p_operation_id, 'ADMIN_TRANSFER_HOLD', p_amount, v_currency, v_date, p_reason,
                                       v_origin, p_destination, adex.capital_account_for(v_company, 'admin', v_origin, null),
                                       adex.capital_account_for(v_company, 'transit', null, null));
    insert into adex.admin_transfers (id, company_id, operation_id, mode, origin_admin_membership_id, destination_admin_membership_id, amount_minor,
                                      currency_code, reason, entry_date, state, registered_by_membership_id, registered_by_identity_id, registered_by_role,
                                      origin_decision, origin_decided_at, origin_decided_identity_id, destination_decision, hold_operation_id)
    values (gen_random_uuid()::text, v_company, p_operation_id, v_mode, v_origin, p_destination, p_amount, v_currency, btrim(p_reason), v_date, 'pending',
            v_actor, v_identity, v_role,
            case when v_mode = 'direct' then 'confirmed' else 'pending' end, case when v_mode = 'direct' then now() end,
            case when v_mode = 'direct' then v_identity end, 'pending', v_hold)
    returning * into v_row;
    return v_row;
  exception
    when unique_violation then
      if sqlerrm like '%admin_transfers_operation_key%' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;

-- DECIDIR (cada Administrador, su parte, una sola vez). Con todas las confirmaciones se aplica;
-- un rechazo devuelve el capital comprometido a la bolsa de origen.
create function adex.admin_transfer_decide(p_operation_id uuid, p_transfer text, p_decision text, p_reason text)
  returns adex.admin_transfers
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.admin_transfer_ctx();
    v_actor    text := adex.ctx_membership();
    v_identity uuid := adex.ctx_identity();
    t          adex.admin_transfers;
    v_side     text;
    v_op       text;
    v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  begin
    if adex.ctx_role() <> 'admin' then perform adex.capital_raise('AX402', 'only the administrators involved decide'); end if;
    if p_operation_id is null or p_transfer is null or p_decision not in ('confirm', 'reject') then perform adex.capital_raise('AX411', 'invalid decision'); end if;
    if p_decision = 'reject' and (v_reason is null or length(v_reason) < 3 or length(v_reason) > 300) then
      perform adex.capital_raise('AX411', 'reason is required');
    end if;
    select * into t from adex.admin_transfers where company_id = v_company and id = p_transfer for update;
    if not found then perform adex.capital_raise('AX412', 'transfer not found'); end if;
    v_side := case v_actor when t.origin_admin_membership_id then 'origin' when t.destination_admin_membership_id then 'destination' end;
    if v_side is null then perform adex.capital_raise('AX412', 'transfer not found'); end if;
    if t.state <> 'pending' then perform adex.capital_raise('AX414', 'transfer is no longer pending'); end if;
    if (v_side = 'origin' and t.origin_decision <> 'pending') or (v_side = 'destination' and t.destination_decision <> 'pending') then
      perform adex.capital_raise('AX415', 'your decision is already registered');
    end if;
    if v_identity = t.registered_by_identity_id and t.mode = 'secretary' then perform adex.capital_raise('AX416', 'whoever registers cannot decide'); end if;

    if v_side = 'origin' then
      t.origin_decision := case p_decision when 'confirm' then 'confirmed' else 'rejected' end;
      t.origin_decided_at := now(); t.origin_decided_identity_id := v_identity; t.origin_decision_reason := v_reason;
    else
      t.destination_decision := case p_decision when 'confirm' then 'confirmed' else 'rejected' end;
      t.destination_decided_at := now(); t.destination_decided_identity_id := v_identity; t.destination_decision_reason := v_reason;
    end if;

    if p_decision = 'reject' then
      v_op := adex.admin_transfer_post(v_company, p_operation_id, 'ADMIN_TRANSFER_RELEASE', t.amount_minor, t.currency_code, adex.business_today(v_company),
                                       'Rechazado: ' || v_reason, t.origin_admin_membership_id, t.destination_admin_membership_id,
                                       adex.capital_account_for(v_company, 'transit', null, null),
                                       adex.capital_account_for(v_company, 'admin', t.origin_admin_membership_id, null));
      t.state := 'rejected'; t.settle_operation_id := v_op; t.closed_at := now(); t.closed_by_membership_id := v_actor; t.close_reason := v_reason;
    elsif t.origin_decision = 'confirmed' and t.destination_decision = 'confirmed' then
      if not exists (select 1 from adex.memberships where company_id = v_company and id = t.destination_admin_membership_id and role = 'admin' and status = 'activo') then
        perform adex.capital_raise('AX412', 'destination administrator not found or inactive');
      end if;
      v_op := adex.admin_transfer_post(v_company, p_operation_id, 'ADMIN_TRANSFER_APPLY', t.amount_minor, t.currency_code, adex.business_today(v_company),
                                       t.reason, t.destination_admin_membership_id, t.origin_admin_membership_id,
                                       adex.capital_account_for(v_company, 'transit', null, null),
                                       adex.capital_account_for(v_company, 'admin', t.destination_admin_membership_id, null));
      t.state := 'applied'; t.settle_operation_id := v_op; t.closed_at := now(); t.closed_by_membership_id := v_actor;
    end if;

    update adex.admin_transfers set
      origin_decision = t.origin_decision, origin_decided_at = t.origin_decided_at, origin_decided_identity_id = t.origin_decided_identity_id,
      origin_decision_reason = t.origin_decision_reason, destination_decision = t.destination_decision, destination_decided_at = t.destination_decided_at,
      destination_decided_identity_id = t.destination_decided_identity_id, destination_decision_reason = t.destination_decision_reason,
      state = t.state, settle_operation_id = t.settle_operation_id, closed_at = t.closed_at, closed_by_membership_id = t.closed_by_membership_id,
      close_reason = t.close_reason
     where company_id = v_company and id = t.id
    returning * into t;
    return t;
  end $$;

-- CANCELAR (solo quien registró, mientras siga pendiente): el capital vuelve a la bolsa de origen.
create function adex.admin_transfer_cancel(p_operation_id uuid, p_transfer text, p_reason text)
  returns adex.admin_transfers
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.admin_transfer_ctx();
    v_actor   text := adex.ctx_membership();
    t         adex.admin_transfers;
    v_op      text;
    v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  begin
    if p_operation_id is null or p_transfer is null then perform adex.capital_raise('AX411', 'invalid cancellation'); end if;
    if v_reason is null or length(v_reason) < 3 or length(v_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    select * into t from adex.admin_transfers where company_id = v_company and id = p_transfer for update;
    if not found then perform adex.capital_raise('AX412', 'transfer not found'); end if;
    if t.registered_by_membership_id <> v_actor then
      -- Una parte que no registró no lo ve como «cancelable»: decide (rechaza).
      if v_actor in (t.origin_admin_membership_id, t.destination_admin_membership_id) or (adex.ctx_role() = 'secretario' and t.mode = 'secretary') then
        perform adex.capital_raise('AX402', 'only whoever registered can cancel');
      end if;
      perform adex.capital_raise('AX412', 'transfer not found');
    end if;
    if t.state <> 'pending' then perform adex.capital_raise('AX414', 'transfer is no longer pending'); end if;
    v_op := adex.admin_transfer_post(v_company, p_operation_id, 'ADMIN_TRANSFER_RELEASE', t.amount_minor, t.currency_code, adex.business_today(v_company),
                                     'Cancelado: ' || v_reason, t.origin_admin_membership_id, t.destination_admin_membership_id,
                                     adex.capital_account_for(v_company, 'transit', null, null),
                                     adex.capital_account_for(v_company, 'admin', t.origin_admin_membership_id, null));
    update adex.admin_transfers set state = 'cancelled', settle_operation_id = v_op, closed_at = now(), closed_by_membership_id = v_actor, close_reason = v_reason
     where company_id = v_company and id = t.id
    returning * into t;
    return t;
  end $$;

revoke all on function adex.admin_transfer_register(uuid, text, text, bigint, text), adex.admin_transfer_decide(uuid, text, text, text),
  adex.admin_transfer_cancel(uuid, text, text), adex.guard_admin_transfer() from public;
grant execute on function adex.admin_transfer_register(uuid, text, text, bigint, text), adex.admin_transfer_decide(uuid, text, text, text),
  adex.admin_transfer_cancel(uuid, text, text) to adex_api;

-- Directorio mínimo de Administradores activos (id y nombre) para elegir la contraparte. Sin
-- saldos. Lo usan el Administrador (destino) y el Secretario (origen y destino).
create function adex.admin_directory() returns table (membership_id text, display_name text)
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select m.id::text, m.display_name from adex.memberships m
     where m.company_id = adex.ctx_company() and adex.ctx_membership_active() and adex.ctx_role() in ('superadmin', 'admin', 'secretario')
       and m.role = 'admin' and m.status = 'activo'
     order by m.display_name, m.id
  $$;
revoke all on function adex.admin_directory() from public;
grant execute on function adex.admin_directory() to adex_api;

-- ============================================================
-- C. Comprobación final dentro de la misma transacción
-- ============================================================
do $$ begin
  if exists (select 1 from adex.memberships where role = 'socio') then raise exception 'adex 0023: quedan membresías Socio'; end if;
  if exists (select 1 from adex.capital_accounts where kind = 'partner') then raise exception 'adex 0023: quedan cuentas partner'; end if;
  if exists (select 1 from pg_policies where schemaname like 'adex%' and (qual ilike '%socio%' or with_check ilike '%socio%')) then
    raise exception 'adex 0023: una política menciona socio';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname like 'adex%' and p.proname in ('ctx_can', 'capital_post', 'provision_company') and p.prosrc ilike '%''socio''%') then
    raise exception 'adex 0023: una función de autorización o de capital menciona socio';
  end if;
  if exists (select a.company_id from adex.capital_accounts a group by a.company_id having sum(a.balance_minor) <> 0) then
    raise exception 'adex 0023: la conservación de capital no se mantiene';
  end if;
  if exists (select 1 from adex.capital_accounts a where a.balance_minor <> coalesce((select sum(e.amount_minor) from adex.capital_entries e
               where e.company_id = a.company_id and e.account_id = a.id), 0)) then
    raise exception 'adex 0023: un saldo no coincide con sus asientos';
  end if;
end $$;
