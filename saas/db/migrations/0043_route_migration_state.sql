-- 0043 · Migración de rutas con historial, parte 1: estado «en migración» POR RUTA (decisiones de Helmer 2026-11-04).
--
-- Diseño: docs/ADEX_DISENO_MIGRACION_RUTAS_2026-11.md (§2, §3). Primera ruta: VALPARAISO SOC GAJ (Listos) → BlueLine.
--
--   · Mientras una ruta está `en_migracion` sigue operando en el sistema anterior (Listos). En ADEX es un ESPEJO de solo
--     lectura: nadie crea clientes, solicitudes, ventas, abonos, gastos, movimientos de capital, cuadres ni cierres en ella.
--     Sí se permite asignar o cambiar el cobrador y los Administradores (tablas de membresías), y editar los datos de un
--     cliente ya existente.
--   · El bloqueo vive en PostgreSQL (triggers sobre las tablas), no solo en la pantalla.
--   · Abre y cancela la migración SOLO el SuperAdmin, sobre una ruta ACTIVA, VACÍA (sin clientes, ventas, solicitudes,
--     movimientos ni saldos), sin entrega pendiente y en una empresa con `capital_model = 'route_base'`.
--   · La carga de datos (clientes, ventas, abonos de migración) y el paso a normal con el conteo de caja llegan en la
--     parte 2 (0044), que redefine `adex.route_migration_writing` para permitir sus propias escrituras.
--   · Aditiva: no cambia ni borra filas. Con ninguna ruta en migración, todo se comporta igual que en 0042.

-- ============================================================
-- 1. Esquema
-- ============================================================
alter table adex.routes add column migration_state text not null default 'normal'
  constraint routes_migration_state_check check (migration_state in ('normal', 'en_migracion'));

create table adex.route_migrations (
  id                        adex.eid primary key,
  company_id                adex.eid not null references adex.companies(id),
  route_id                  adex.eid not null,
  status                    text not null check (status in ('en_migracion', 'finalizada', 'cancelada')),
  source_system             text not null check (source_system in ('listos')),
  source_route_name         text not null check (length(btrim(source_route_name)) between 2 and 120),
  note                      text check (note is null or length(note) <= 500),
  opened_at                 timestamptz not null default now(),
  opened_by_membership_id   adex.eid not null,
  opened_by_identity_id     uuid not null references adex.identities(id),
  open_operation_id         uuid not null,
  opened_txid               bigint not null,
  closed_at                 timestamptz,
  closed_by_membership_id   adex.eid,
  closed_by_identity_id     uuid references adex.identities(id),
  close_operation_id        uuid,
  closed_txid               bigint,
  close_reason              text check (close_reason is null or length(close_reason) <= 500),
  unique (company_id, id),
  constraint route_migrations_open_key unique (company_id, open_operation_id),
  constraint route_migrations_close_key unique (company_id, close_operation_id),
  check ((status = 'en_migracion') = (closed_at is null)),
  check ((closed_at is null) = (closed_by_membership_id is null)
     and (closed_at is null) = (closed_by_identity_id is null)
     and (closed_at is null) = (close_operation_id is null)
     and (closed_at is null) = (closed_txid is null)),
  foreign key (company_id, route_id) references adex.routes(company_id, id),
  foreign key (company_id, opened_by_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, closed_by_membership_id) references adex.memberships(company_id, id)
);
create unique index route_migrations_one_open on adex.route_migrations (company_id, route_id) where status = 'en_migracion';
create index route_migrations_route on adex.route_migrations (company_id, route_id, opened_at);
create trigger route_migrations_no_delete before delete on adex.route_migrations for each row execute function adex.reject_mutation();
create trigger route_migrations_no_truncate before truncate on adex.route_migrations for each statement execute function adex.reject_mutation();
alter table adex.route_migrations enable row level security;
alter table adex.route_migrations force row level security;
create policy owner_route_migrations_all on adex.route_migrations for all to adex_owner using (true) with check (true);
create policy route_migrations_ctx on adex.route_migrations for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and (
           (select adex.ctx_role()) = 'superadmin'
        or ((select adex.ctx_is(array['admin', 'supervisor', 'secretario']))
            and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())))));
grant select on adex.route_migrations to adex_api;
revoke all on adex.route_migrations from public;

-- Solo una migración que se abre o se cierra EN ESTA MISMA TRANSACCIÓN cambia el estado de la ruta (marca por txid,
-- como `route_handover_records.started_txid`). La API (adex_api) nunca lo cambia directamente.
create function adex.routes_migration_state_guard() returns trigger
  language plpgsql
  as $$ begin
    if new.migration_state is distinct from old.migration_state
       and not exists (select 1 from adex.route_migrations m where m.company_id = new.company_id and m.route_id = new.id
                          and txid_current() in (m.opened_txid, m.closed_txid)) then
      raise exception 'adex: the migration state of a route changes only by opening or closing its migration' using errcode = '42501';
    end if;
    if new.migration_state = 'en_migracion' and new.handover_state <> 'normal' then
      raise exception 'adex: a route in migration cannot start a hand-over' using errcode = 'AX443';
    end if;
    return new;
  end $$;
revoke all on function adex.routes_migration_state_guard() from public;
create trigger routes_migration_state_guard before update on adex.routes
  for each row execute function adex.routes_migration_state_guard();

-- El propietario del esquema (funciones security definer) cambia el ESTADO DE ENTREGA y, desde 0043, el ESTADO DE
-- MIGRACIÓN. Cualquier otro cambio por esa vía sigue prohibido (0009/0034: «bloquear sí; modificar, jamás»).
create or replace function adex.routes_owner_update_guard() returns trigger
  language plpgsql
  as $$ begin
    if current_user = 'adex_owner'
       and (to_jsonb(new) - 'handover_state' - 'migration_state' - 'updated_at') is distinct from (to_jsonb(old) - 'handover_state' - 'migration_state' - 'updated_at') then
      raise exception 'adex: the schema owner only changes the hand-over or migration state of a route' using errcode = '42501';
    end if;
    return new;
  end $$;

-- ============================================================
-- 2. Bloqueo de escrituras en una ruta en migración
-- ============================================================
-- Parte 1: la ruta en migración no admite escrituras operativas. 0044 redefine esta función para permitir las de una
-- carga de migración (marca por txid); aquí siempre es falso.
create function adex.route_migration_writing(p_company text, p_route text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select false $$;
revoke all on function adex.route_migration_writing(text, text) from public;

create function adex.route_in_migration(p_company text, p_route text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select exists (select 1 from adex.routes where company_id = p_company and id = p_route and migration_state = 'en_migracion') $$;
revoke all on function adex.route_in_migration(text, text) from public;
grant execute on function adex.route_in_migration(text, text) to adex_api;

create function adex.guard_route_migration_write() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_new    jsonb := to_jsonb(new);
    v_routes text[] := array[v_new ->> 'route_id'];
    v_route  text;
  begin
    if tg_table_name = 'capital_operations' then v_routes := v_routes || (v_new ->> 'to_route_id'); end if;
    foreach v_route in array v_routes loop
      if v_route is not null and adex.route_in_migration(new.company_id, v_route)
         and not adex.route_migration_writing(new.company_id, v_route) then
        raise exception 'adex: the route is being migrated from the previous system (read only until the migration ends)'
          using errcode = 'AX443';
      end if;
    end loop;
    return new;
  end $$;
revoke all on function adex.guard_route_migration_write() from public;

-- Altas en todas las tablas operativas y de dinero con ruta. Cambios: ventas y abonos (saldos, estados, correcciones).
-- No se bloquean: membresías y asignaciones de ruta, ubicaciones del mapa ni la edición de un cliente existente.
do $$
declare t text;
begin
  foreach t in array array['clients', 'sale_requests', 'sales', 'payments', 'payment_adjustment_requests', 'no_payment_visits',
                           'expenses', 'capital_operations', 'capital_requests', 'custody_settlements', 'period_closures',
                           'weekly_settlements', 'offline_captures', 'credit_rectifications', 'credit_rectification_cases',
                           'sale_delivery_dates', 'general_funding_contributions', 'joint_reversal_parts', 'route_handover_records',
                           'difference_conciliations'] loop
    execute format('create trigger %I before insert on adex.%I for each row execute function adex.guard_route_migration_write()',
                   t || '_route_migration_guard', t);
  end loop;
  foreach t in array array['sales', 'payments'] loop
    execute format('create trigger %I before update on adex.%I for each row execute function adex.guard_route_migration_write()',
                   t || '_route_migration_guard_upd', t);
  end loop;
end $$;

-- ============================================================
-- 3. Abrir y cancelar la migración (solo el SuperAdmin)
-- ============================================================
create function adex.route_migration_open(p_operation_id uuid, p_route text, p_source_route_name text, p_note text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x      adex.money_ctx;
    r      adex.routes;
    v_id   text := gen_random_uuid()::text;
    v_name text := nullif(btrim(coalesce(p_source_route_name, '')), '');
    v_note text := nullif(btrim(coalesce(p_note, '')), '');
    v_busy text[] := '{}';
  begin
    x := adex.money_context(p_operation_id);
    if x.role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the SuperAdmin opens a route migration'); end if;
    if p_route is null or v_name is null or length(v_name) < 2 or length(v_name) > 120 then
      perform adex.capital_raise('AX411', 'route and the route name in the previous system (2-120 characters) are required');
    end if;
    if v_note is not null and length(v_note) > 500 then perform adex.capital_raise('AX411', 'note is too long'); end if;
    if exists (select 1 from adex.route_migrations where company_id = x.company and open_operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    select * into r from adex.routes where company_id = x.company and id = p_route for update;
    if not found then perform adex.capital_raise('AX412', 'route not found'); end if;
    if adex.company_capital_model(x.company) is distinct from 'route_base' then
      perform adex.capital_raise('AX444', 'route migration needs the Base per Route capital model');
    end if;
    if r.status <> 'activa' then v_busy := array_append(v_busy, 'ROUTE_INACTIVE'); end if;
    if r.migration_state <> 'normal' then v_busy := array_append(v_busy, 'ALREADY_IN_MIGRATION'); end if;
    if r.handover_state <> 'normal' then v_busy := array_append(v_busy, 'HANDOVER_PENDING'); end if;
    if exists (select 1 from adex.clients where company_id = x.company and route_id = p_route) then v_busy := array_append(v_busy, 'HAS_CLIENTS'); end if;
    if exists (select 1 from adex.sale_requests where company_id = x.company and route_id = p_route) then v_busy := array_append(v_busy, 'HAS_SALE_REQUESTS'); end if;
    if exists (select 1 from adex.sales where company_id = x.company and route_id = p_route) then v_busy := array_append(v_busy, 'HAS_SALES'); end if;
    if exists (select 1 from adex.expenses where company_id = x.company and route_id = p_route) then v_busy := array_append(v_busy, 'HAS_EXPENSES'); end if;
    if exists (select 1 from adex.capital_operations where company_id = x.company and p_route in (route_id, to_route_id)) then
      v_busy := array_append(v_busy, 'HAS_CAPITAL_OPERATIONS');
    end if;
    if exists (select 1 from adex.capital_accounts where company_id = x.company and route_id = p_route and balance_minor <> 0) then
      v_busy := array_append(v_busy, 'HAS_BALANCES');
    end if;
    if exists (select 1 from adex.offline_captures where company_id = x.company and route_id = p_route) then v_busy := array_append(v_busy, 'HAS_OFFLINE_CAPTURES'); end if;
    if cardinality(v_busy) > 0 then
      perform adex.capital_raise('AX444', 'the route must be active, empty and without a pending hand-over: ' || array_to_string(v_busy, ', '));
    end if;
    insert into adex.route_migrations (id, company_id, route_id, status, source_system, source_route_name, note, opened_by_membership_id,
                                       opened_by_identity_id, open_operation_id, opened_txid)
    values (v_id, x.company, p_route, 'en_migracion', 'listos', v_name, v_note, x.actor, x.identity, p_operation_id, txid_current());
    update adex.routes set migration_state = 'en_migracion', updated_at = now() where company_id = x.company and id = p_route;
    return jsonb_build_object('migrationId', v_id, 'routeId', p_route, 'routeName', r.name, 'status', 'en_migracion',
                              'sourceSystem', 'listos', 'sourceRouteName', v_name, 'note', v_note, 'openedAt', now(), 'businessDate', x.today);
  exception
    when unique_violation then
      if sqlerrm like '%route_migrations_open_key%' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if sqlerrm like '%route_migrations_one_open%' then perform adex.capital_raise('AX444', 'the route is already in migration'); end if;
      raise;
  end $$;
revoke all on function adex.route_migration_open(uuid, text, text, text) from public;
grant execute on function adex.route_migration_open(uuid, text, text, text) to adex_api;

-- Cancelar: la ruta vuelve a `normal` sin cambios. Parte 1: siempre posible (la ruta sigue vacía, nada se pudo escribir).
-- 0044 la redefine para negarla cuando ya hay datos cargados.
create function adex.route_migration_cancel(p_operation_id uuid, p_route text, p_reason text) returns jsonb
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
    update adex.route_migrations
       set status = 'cancelada', closed_at = now(), closed_by_membership_id = x.actor, closed_by_identity_id = x.identity,
           close_operation_id = p_operation_id, closed_txid = txid_current(), close_reason = v_why
     where company_id = x.company and id = m.id;
    update adex.routes set migration_state = 'normal', updated_at = now() where company_id = x.company and id = p_route;
    return jsonb_build_object('migrationId', m.id, 'routeId', p_route, 'status', 'cancelada', 'reason', v_why, 'closedAt', now());
  end $$;
revoke all on function adex.route_migration_cancel(uuid, text, text) from public;
grant execute on function adex.route_migration_cancel(uuid, text, text) to adex_api;
