-- ============================================================
-- 0034 · Base por Ruta (núcleo) · intervención R74, bloque D
-- ============================================================
-- Decisiones del propietario aplicadas (docs/ADEX_RONDA_74_INTERVENCION_INTEGRAL.md §4 y §8):
--   O1  cuenta `route_base` por ruta (≥ 0, nunca negativa). La Base es de la RUTA: se queda con ella
--       cuando cambia el Administrador responsable.
--   O2  contrapartida `route_funding` por ruta (con signo, como `external` pero por ruta) para
--       inyecciones y retiros. Sin patrimonio personal ni acuerdos de socios.
--   O3  saldos históricos de bolsas no atribuibles a una ruta = «sin asignar»: se quedan en la bolsa
--       del Administrador, que en `route_base` NO admite entradas. Solo se reparten con un
--       procedimiento auditado confirmado por ese Administrador (`LEGACY_POOL_TO_ROUTE`, fechado el
--       día de la confirmación; nunca se reescribe historia). Sin reparto proporcional automático ni
--       plazo automático; ninguna ruta los consume por su cuenta.
--   O4  el ALCANCE del gasto (ruta / general de un Administrador / general de la empresa) y la FUENTE
--       de fondos son dimensiones distintas. Con `route_base`: el gasto de ruta lo paga la Base de esa
--       ruta; el del trabajador sigue en su custodia; el gasto general (de Administrador o de empresa)
--       se RECHAZA (AX426) hasta que el propietario decida su financiación. Además, naturaleza de la
--       categoría de gasto: operativo (por defecto) | bien_duradero | otro (sin depreciación).
--   O5  cambio de responsable con entrega controlada: la ruta queda «en entrega» (sin inyecciones,
--       retiros, entregas a cobradores, ventas directas, gastos de ruta ni transferencias de salida;
--       cobros, devoluciones y cuadres siguen) hasta que el nuevo responsable confirma el conteo; la
--       diferencia queda en un acta (`route_handover_records`) SIN movimientos automáticos.
--   O6  el SuperAdmin autoriza estructuralmente el modelo por empresa (`companies.capital_model`:
--       admin_pool | migrating | route_base) sin volverse operador financiero; la función comprueba
--       los requisitos y guarda el registro de activación (quién, cuándo, evidencia, respaldo).
--   O9  tres estados distintos por ruta (resultado negativo; flujo negativo por crecimiento;
--       insuficiencia de liquidez) en `adex.route_panel`. Una inyección nunca es pérdida.
--   O10 sin «ganancia retirable»: un solo «Retiro de Base».
--   O11 transferencia entre rutas (incluso de responsables distintos) iniciada por el responsable de
--       la ruta de ORIGEN («quien tiene el dinero lo entrega», R59): inmediata, atómica, idempotente,
--       auditada; el destino la VE (operación visible + aviso derivado). Gancho documentado si el
--       propietario quiere un estado de tránsito/confirmación: ver `route_base_post`.
--   E2  con `route_base` el SuperAdmin no deposita, retira ni asigna capital de empresa; inyecta y
--       retira la Base el Administrador responsable de la ruta. Con `admin_pool` (toda empresa actual)
--       NADA cambia: nunca hay una etapa en la que nadie pueda inyectar Base.
--
-- Aditiva y detrás de `capital_model`: con `admin_pool` cada función redefinida elige EXACTAMENTE la
-- misma cuenta que antes (`route_cash_account` devuelve la bolsa del responsable) y los guardianes
-- nuevos solo rechazan lo que no existía (cuentas y tipos nuevos). No cambia ni borra filas.
-- Generado por tmp/r74p/d/build-0034.mjs (copia literal de la última definición de cada función con
-- reemplazos exactos de una sola ocurrencia).

-- ============================================================
-- 1. Esquema
-- ============================================================

-- ---------- Modelo de capital por empresa ----------
alter table adex.companies
  add column capital_model text not null default 'admin_pool'
    constraint companies_capital_model_check check (capital_model in ('admin_pool', 'migrating', 'route_base')),
  add column route_base_since timestamptz,
  add constraint companies_route_base_since_check check ((capital_model = 'route_base') = (route_base_since is not null));

-- ---------- Cuentas: Base de la ruta y su contrapartida ----------
alter table adex.capital_accounts drop constraint capital_accounts_kind_check;
alter table adex.capital_accounts add constraint capital_accounts_kind_check
  check (kind in ('company', 'admin', 'custody', 'external', 'portfolio', 'income', 'expense', 'suspense', 'unidentified', 'transit',
                  'route_base', 'route_funding'));
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
-- La Base nunca es negativa (barrera de sobregiro bajo el bloqueo de la fila); la contrapartida sí:
-- −saldo = aportes netos de la ruta (positivo = se retiró más de lo que se aportó).
alter table adex.capital_accounts drop constraint capital_accounts_no_overdraft;
alter table adex.capital_accounts add constraint capital_accounts_no_overdraft
  check (kind in ('external', 'income', 'custody', 'unidentified', 'route_funding') or balance_minor >= 0);

-- ---------- Operaciones nuevas ----------
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY', 'WORKER_RETURN',
  'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE',
  'EXPENSE_REFUND', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE',
  'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION',
  'ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE'));
-- Solo la inyección se anula (si la Base aún tiene ese dinero). Un retiro se corrige con una
-- inyección nueva; una transferencia, con otra de vuelta por quien ahora tiene el dinero; un reparto
-- de «sin asignar» no vuelve a la bolsa (en `route_base` la bolsa no admite entradas).
alter table adex.capital_operations drop constraint capital_operations_reverses_kind_check;
alter table adex.capital_operations add constraint capital_operations_reverses_kind_check
  check (reverses_kind is null or reverses_kind in ('COMPANY_DEPOSIT', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
                                                   'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE',
                                                   'COMPANY_EXPENSE', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ROUTE_BASE_INJECTION'));
alter table adex.capital_operations add constraint capital_operations_route_base_shape
  check ((coalesce(reverses_kind, kind) not in ('ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE') or route_id is not null)
         and ((coalesce(reverses_kind, kind) = 'ROUTE_TRANSFER') = (to_route_id is not null) or coalesce(reverses_kind, kind) = 'ROUTE_REASSIGNMENT'));

-- ---------- Naturaleza del gasto (O4) ----------
alter table adex.expense_categories add column nature text not null default 'operativo'
  constraint expense_categories_nature_check check (nature in ('operativo', 'bien_duradero', 'otro'));
grant insert (nature), update (nature) on adex.expense_categories to adex_api;

-- ---------- Estado de entrega de la ruta (O5) ----------
alter table adex.routes add column handover_state text not null default 'normal'
  constraint routes_handover_state_check check (handover_state in ('normal', 'en_entrega'));

-- ---------- Actas de entrega (O5) ----------
create table adex.route_handover_records (
  id                         adex.eid primary key,
  company_id                 adex.eid not null references adex.companies(id),
  route_id                   adex.eid not null,
  from_membership_id         adex.eid,                 -- responsable saliente (NULL si la ruta no tenía)
  to_membership_id           adex.eid not null,        -- nuevo responsable: SOLO él confirma el conteo
  status                     text not null check (status in ('pendiente', 'confirmada', 'sustituida')),
  base_at_start_minor        bigint not null,          -- saldo del libro al abrir la entrega (informativo)
  custody_at_start_minor     bigint not null,          -- Σ custodias de la ruta al abrir (informativo)
  started_at                 timestamptz not null default now(),
  started_by_membership_id   adex.eid,
  started_txid               bigint not null,
  expected_base_minor        bigint,                   -- saldo del libro al confirmar (bajo bloqueo)
  counted_minor              bigint check (counted_minor is null or counted_minor >= 0),
  difference_minor           bigint,                   -- contado − esperado; SIN movimiento automático
  note                       text check (note is null or length(note) <= 500),
  confirmed_at               timestamptz,
  confirmed_by_membership_id adex.eid,
  confirmed_by_identity_id   uuid references adex.identities(id),
  confirm_operation_id       uuid,
  superseded_at              timestamptz,
  unique (company_id, id),
  constraint route_handover_confirm_key unique (company_id, confirm_operation_id),
  check ((status = 'confirmada') = (confirmed_at is not null)),
  check ((status = 'confirmada') = (counted_minor is not null and expected_base_minor is not null and difference_minor is not null)),
  check ((status = 'sustituida') = (superseded_at is not null)),
  foreign key (company_id, route_id) references adex.routes(company_id, id),
  foreign key (company_id, from_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, to_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, started_by_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, confirmed_by_membership_id) references adex.memberships(company_id, id)
);
create unique index route_handover_one_pending on adex.route_handover_records (company_id, route_id) where status = 'pendiente';
create index route_handover_route on adex.route_handover_records (company_id, route_id, started_at);
create trigger route_handover_records_no_delete before delete on adex.route_handover_records for each row execute function adex.reject_mutation();
create trigger route_handover_records_no_truncate before truncate on adex.route_handover_records for each statement execute function adex.reject_mutation();
alter table adex.route_handover_records enable row level security;
alter table adex.route_handover_records force row level security;
create policy owner_handover_all on adex.route_handover_records for all to adex_owner using (true) with check (true);
create policy route_handover_records_ctx on adex.route_handover_records for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and (
           (select adex.ctx_role()) = 'superadmin'
        or adex.ctx_membership() in (from_membership_id, to_membership_id)
        or ((select adex.ctx_is(array['admin', 'supervisor'])) and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())))));
grant select on adex.route_handover_records to adex_api;

-- ---------- Registro de activación del modelo (O6) ----------
create table adex.capital_model_activations (
  id                  adex.eid primary key,
  company_id          adex.eid not null references adex.companies(id),
  operation_id        uuid not null,
  from_model          text not null check (from_model in ('admin_pool', 'migrating', 'route_base')),
  to_model            text not null check (to_model in ('admin_pool', 'migrating', 'route_base')),
  evidence            text not null check (length(btrim(evidence)) >= 10 and length(evidence) <= 1000),
  backup_reference    text check (backup_reference is null or (length(btrim(backup_reference)) >= 3 and length(backup_reference) <= 300)),
  company_balance_note text check (company_balance_note is null or (length(btrim(company_balance_note)) >= 10 and length(company_balance_note) <= 500)),
  prerequisites       jsonb not null,
  unassigned_pools    jsonb not null,           -- bolsas con saldo que quedan «sin asignar» (no se mueven)
  actor_membership_id adex.eid not null,
  actor_identity_id   uuid not null references adex.identities(id),
  actor_role          text not null check (actor_role = 'superadmin'),
  txid                bigint not null,
  created_at          timestamptz not null default now(),
  unique (company_id, id),
  constraint capital_model_activations_operation_key unique (company_id, operation_id),
  check (from_model <> to_model),
  check (to_model <> 'route_base' or backup_reference is not null),
  foreign key (company_id, actor_membership_id) references adex.memberships(company_id, id)
);
do $$
begin
  execute 'create trigger capital_model_activations_immutable before update or delete on adex.capital_model_activations for each row execute function adex.reject_mutation()';
  execute 'create trigger capital_model_activations_no_truncate before truncate on adex.capital_model_activations for each statement execute function adex.reject_mutation()';
end $$;
alter table adex.capital_model_activations enable row level security;
alter table adex.capital_model_activations force row level security;
create policy owner_model_all on adex.capital_model_activations for all to adex_owner using (true) with check (true);
create policy capital_model_activations_ctx on adex.capital_model_activations for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and (select adex.ctx_is(array['superadmin', 'admin'])));
grant select on adex.capital_model_activations to adex_api;

-- ---------- Visibilidad (aditiva) ----------
-- Cuentas de la ruta (Base, contrapartida, cartera, interés, gastos y control): Administrador y
-- Supervisor de las rutas de su alcance. Es lo que ya veían por `route_liquidation` (cashbox.viewRoute).
create policy capital_accounts_route_ctx on adex.capital_accounts for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and route_id is not null
         and kind in ('route_base', 'route_funding', 'portfolio', 'income', 'expense', 'suspense', 'unidentified')
         and (select adex.ctx_is(array['admin', 'supervisor']))
         and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())));
-- Operaciones de la Base: quienes gestionan la ruta de origen o de destino (O11: el destino las ve).
create policy capital_operations_route_base_ctx on adex.capital_operations for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active())
         and coalesce(reverses_kind, kind) in ('ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE')
         and (select adex.ctx_is(array['admin', 'supervisor']))
         and (adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids()))
              or adex.route_in_scope(to_route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids()))));

-- ============================================================
-- 2. Ayudantes
-- ============================================================
create function adex.company_capital_model(p_company text) returns text
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select capital_model from adex.companies where id = p_company $$;
revoke all on function adex.company_capital_model(text) from public;
grant execute on function adex.company_capital_model(text) to adex_api;

-- LA bifurcación del modelo: cuenta de efectivo de la ruta para un comando. Con `admin_pool`, la
-- bolsa del responsable (misma cuenta y mismo id que antes de 0034); con `route_base`, la Base.
create function adex.route_cash_account(p_company text, p_route text, p_admin text) returns text
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$ begin
    if adex.company_capital_model(p_company) = 'route_base' then
      return adex.capital_account_for(p_company, 'route_base', null, p_route);
    end if;
    return adex.capital_account_for(p_company, 'admin', p_admin, null);
  end $$;
revoke all on function adex.route_cash_account(text, text, text) from public;

-- Correcciones de operaciones anteriores al corte (§4.4, alternativa b): la pata que tocó una bolsa
-- se redirige a la Base de la ruta de la operación. Con `admin_pool` devuelve la misma cuenta.
create function adex.route_cash_redirect(p_company text, p_account text, p_route text) returns text
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$ begin
    if p_route is not null and adex.company_capital_model(p_company) = 'route_base'
       and exists (select 1 from adex.capital_accounts where company_id = p_company and id = p_account and kind = 'admin') then
      return adex.capital_account_for(p_company, 'route_base', null, p_route);
    end if;
    return p_account;
  end $$;
revoke all on function adex.route_cash_redirect(text, text, text) from public;

create function adex.route_in_handover(p_company text, p_route text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select exists (select 1 from adex.routes where company_id = p_company and id = p_route and handover_state = 'en_entrega') $$;
revoke all on function adex.route_in_handover(text, text) from public;
grant execute on function adex.route_in_handover(text, text) to adex_api;

-- ============================================================
-- 3. Guardianes
-- ============================================================
-- Tipos de operación según el modelo de la empresa.
create function adex.guard_capital_model_op() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  declare v_model text; v_k text := coalesce(new.reverses_kind, new.kind);
  begin
    select capital_model into v_model from adex.companies where id = new.company_id;
    if v_k in ('ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE') then
      if v_model is distinct from 'route_base' then
        raise exception 'adex: the route base model is not active in this company' using errcode = 'AX428';
      end if;
    elsif v_k in ('COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION',
                  'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE', 'COMPANY_EXPENSE') then
      if v_model = 'route_base' then
        raise exception 'adex: company capital and administrator pools do not move in the route base model' using errcode = 'AX421';
      elsif v_model = 'migrating' then
        raise exception 'adex: the capital model of the company is being migrated' using errcode = 'AX422';
      end if;
    end if;
    return new;
  end $$;
revoke all on function adex.guard_capital_model_op() from public;
create trigger capital_operations_capital_model before insert on adex.capital_operations
  for each row execute function adex.guard_capital_model_op();

-- Cada pata: (1) ámbito de ruta, (2) modelo de capital, (3) ruta en entrega.
create function adex.guard_route_base_entry() returns trigger
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
revoke all on function adex.guard_route_base_entry() from public;
create trigger capital_entries_route_base before insert on adex.capital_entries
  for each row execute function adex.guard_route_base_entry();

-- Solicitudes de capital de bolsas: obsoletas con el modelo nuevo (las de devolución del Cobrador siguen).
create function adex.guard_capital_request_model() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  declare v_model text;
  begin
    if new.kind in ('admin_return', 'admin_allocation', 'admin_transfer') then
      select capital_model into v_model from adex.companies where id = new.company_id;
      if v_model = 'route_base' then
        raise exception 'adex: administrator pool requests do not exist in the route base model' using errcode = 'AX421';
      elsif v_model = 'migrating' then
        raise exception 'adex: the capital model of the company is being migrated' using errcode = 'AX422';
      end if;
    end if;
    return new;
  end $$;
revoke all on function adex.guard_capital_request_model() from public;
create trigger capital_requests_capital_model before insert on adex.capital_requests
  for each row execute function adex.guard_capital_request_model();

-- El propietario del esquema solo cambia el ESTADO DE ENTREGA de una ruta (la confirmación del conteo);
-- cualquier otro cambio por esa vía sigue prohibido como en 0009 («bloquear sí; modificar, jamás»).
create policy owner_route_handover on adex.routes for update to adex_owner using (true) with check (true);
create function adex.routes_owner_update_guard() returns trigger
  language plpgsql
  as $$ begin
    if current_user = 'adex_owner'
       and (to_jsonb(new) - 'handover_state' - 'updated_at') is distinct from (to_jsonb(old) - 'handover_state' - 'updated_at') then
      raise exception 'adex: the schema owner only changes the hand-over state of a route' using errcode = '42501';
    end if;
    return new;
  end $$;
revoke all on function adex.routes_owner_update_guard() from public;
create trigger routes_owner_update_guard before update on adex.routes
  for each row execute function adex.routes_owner_update_guard();

-- O5: con `route_base`, cambiar el responsable abre la entrega (y sustituye una pendiente). La Base no
-- se mueve. Sin responsable nuevo (liberación) no hay a quién entregar: la ruta ya no opera (AX408).
create function adex.route_handover_open() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  declare v_base bigint; v_custody bigint;
  begin
    if new.capital_controller_membership_id is not distinct from old.capital_controller_membership_id
       or adex.company_capital_model(new.company_id) is distinct from 'route_base' then
      return new;
    end if;
    update adex.route_handover_records set status = 'sustituida', superseded_at = now()
     where company_id = new.company_id and route_id = new.id and status = 'pendiente';
    select coalesce(sum(balance_minor) filter (where kind = 'route_base'), 0), coalesce(sum(balance_minor) filter (where kind = 'custody'), 0)
      into v_base, v_custody
      from adex.capital_accounts where company_id = new.company_id and route_id = new.id and kind in ('route_base', 'custody');
    if new.capital_controller_membership_id is not null and (old.capital_controller_membership_id is not null or v_base <> 0) then
      insert into adex.route_handover_records (id, company_id, route_id, from_membership_id, to_membership_id, status, base_at_start_minor,
                                               custody_at_start_minor, started_by_membership_id, started_txid)
      values (gen_random_uuid()::text, new.company_id, new.id, old.capital_controller_membership_id, new.capital_controller_membership_id,
              'pendiente', v_base, v_custody, adex.ctx_membership(), txid_current());
      new.handover_state := 'en_entrega';
    else
      new.handover_state := 'normal';
    end if;
    return new;
  end $$;
revoke all on function adex.route_handover_open() from public;
create trigger routes_handover_open before update of capital_controller_membership_id on adex.routes
  for each row execute function adex.route_handover_open();

-- ============================================================
-- 4. Funciones de dinero redefinidas (copia literal + cambios mínimos detrás de `capital_model`)
-- ============================================================

-- capital_lock_accounts: la de 0014_settlements_closures.sql.
create or replace function adex.capital_lock_accounts(p_company text, p_accounts text[]) returns void
  language plpgsql
  as $$ begin
    perform 1 from adex.capital_accounts
      where company_id = p_company and id = any(p_accounts)
      order by array_position(array['company', 'admin', 'route_base', 'custody', 'portfolio', 'partner', 'external', 'income', 'expense', 'suspense', 'unidentified', 'route_funding'], kind), id
      for update;
  end $$;

-- capital_post: la de 0033_superadmin_supervisor_roles.sql.
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
    -- Ronda 59: el Cobrador solo registra la entrega de SU efectivo (WORKER_RETURN, abajo).
    if v_role not in ('superadmin', 'admin', 'supervisor') and not (v_role = 'cobrador' and p_kind = 'WORKER_RETURN') then
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
      -- R74 Base por Ruta (0034): inyecciones, retiros, transferencias y repartos se corrigen con su propio comando.
      if v_orig.kind in ('ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE') then
        perform adex.capital_raise('AX404', 'route base operations are corrected by their own command');
      end if;
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
    -- structural = solo el responsable; settle = responsable o Supervisor asignado; correct =
    -- solo el responsable (`routeCashAuthorityError` de CLEAN). R74: el SuperAdmin supervisa;
    -- no recibe devoluciones, no traspasa entre trabajadores ni anula operaciones de la ruta.
    -- Comparaciones con IS [NOT] DISTINCT FROM: un NULL nunca concede autoridad.
    if v_kind in ('COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN') then
      -- Ronda 59: el Administrador devuelve capital de SU bolsa sin aprobación (entrega voluntaria).
      if v_role <> 'superadmin' and not (v_role = 'admin' and v_kind = 'ADMIN_RETURN' and not v_reversal and v_admin is not distinct from v_actor) then
        perform adex.capital_raise('AX402', 'only the SuperAdmin moves company capital');
      end if;
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
        if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the route capital controller can correct'); end if;
      else
        if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the route capital controller delivers capital'); end if;
        -- R74 (DS-05): nadie entrega capital a SU propia custodia, tampoco con otra membresía.
        if exists (select 1 from adex.memberships where company_id = v_company and id = v_worker and identity_id = v_identity) then
          perform adex.capital_raise('AX419', 'nobody delivers capital to their own custody');
        end if;
        if not adex.route_operational(v_company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
        if not adex.capital_custodian_ok(v_company, v_route, v_worker) then perform adex.capital_raise('AX403', 'recipient cannot hold cash in this route'); end if;
        if p_sale_request is not null and not exists (select 1 from adex.sale_requests where company_id = v_company and id = p_sale_request and route_id = v_route) then
          perform adex.capital_raise('AX412', 'sale request not found in this route');
        end if;
      end if;
      v_admin := v_ctrl;   -- paga (o, al anular, recupera) la bolsa que HOY responde por la ruta
      -- R74 Base por Ruta (0034): con `route_base`, la Base de la ruta (O1); con `admin_pool`, la misma bolsa.
      v_accts := array[adex.route_cash_account(v_company, v_route, v_admin), adex.capital_account_for(v_company, 'custody', v_worker, v_route)];

    elsif v_kind = 'WORKER_RETURN' then
      if v_reversal then
        if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the route capital controller can correct'); end if;
      else
        if v_role = 'cobrador' then
          -- Ronda 59: entrega VOLUNTARIA de su propio efectivo al responsable de la ruta.
          if v_worker is distinct from v_actor then perform adex.capital_raise('AX402', 'a collector only delivers their own cash'); end if;
          if not exists (select 1 from adex.membership_routes where company_id = v_company and membership_id = v_actor and route_id = v_route) then
            perform adex.capital_raise('AX402', 'route is not assigned to the collector');
          end if;
          if exists (select 1 from adex.memberships where company_id = v_company and id = v_ctrl and identity_id = v_identity) then
            perform adex.capital_raise('AX410', 'nobody delivers cash to their own pool');
          end if;
        elsif not (v_actor is not distinct from v_ctrl
                or (v_role = 'supervisor' and exists (select 1 from adex.membership_routes where company_id = v_company and membership_id = v_actor and route_id = v_route))) then
          perform adex.capital_raise('AX402', 'no authority to receive returns in this route');
        end if;
        if not exists (select 1 from adex.memberships where company_id = v_company and id = v_worker and role in ('cobrador', 'supervisor')) then
          perform adex.capital_raise('AX403', 'worker not found');
        end if;
      end if;
      v_admin := v_ctrl;
      v_accts := array[adex.capital_account_for(v_company, 'custody', v_worker, v_route), adex.route_cash_account(v_company, v_route, v_admin)];

    elsif v_kind = 'WORKER_TRANSFER' then
      if v_reversal then
        if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the route capital controller can correct'); end if;
        v_accts := array[adex.capital_account_for(v_company, 'custody', v_counter, v_route), adex.capital_account_for(v_company, 'custody', v_worker, v_route)];
      else
        if not (v_actor is not distinct from v_ctrl
                or (v_role = 'supervisor' and exists (select 1 from adex.membership_routes where company_id = v_company and membership_id = v_actor and route_id = v_route))) then
          perform adex.capital_raise('AX402', 'no authority over cash in this route');
        end if;
        if v_worker = v_counter then perform adex.capital_raise('AX411', 'origin and destination must differ'); end if;
        -- D74-H2: nadie traspasa efectivo de otro trabajador a SU propia custodia (tampoco con otra membresía).
        if exists (select 1 from adex.memberships where company_id = v_company and id = v_counter and identity_id = v_identity) then
          perform adex.capital_raise('AX419', 'nobody transfers cash into their own custody');
        end if;
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
        if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the route capital controller can correct'); end if;
        -- R74 (0034): con `route_base`, devolución a la Base de la ruta destino y entrega desde la de origen.
        v_accts := array[adex.capital_account_for(v_company, 'custody', v_counter, v_to_route), adex.route_cash_account(v_company, v_to_route, v_ctrl),
                         adex.route_cash_account(v_company, v_route, v_ctrl), adex.capital_account_for(v_company, 'custody', v_worker, v_route)];
      else
        if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the capital controller of both routes reassigns cash'); end if;
        if not adex.route_operational(v_company, v_to_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
        if not exists (select 1 from adex.memberships where company_id = v_company and id = v_worker and role in ('cobrador', 'supervisor')) then
          perform adex.capital_raise('AX403', 'worker not found');
        end if;
        if not adex.capital_custodian_ok(v_company, v_to_route, v_counter) then perform adex.capital_raise('AX403', 'recipient cannot hold cash in the destination route'); end if;
        -- R74 (0034): con `route_base`, cada ruta con su Base: la devolución entra a la Base de la ruta de
        -- origen y la entrega sale de la Base de la ruta destino (ninguna ruta financia a otra en silencio).
        v_accts := array[adex.capital_account_for(v_company, 'custody', v_worker, v_route), adex.route_cash_account(v_company, v_route, v_ctrl),
                         adex.route_cash_account(v_company, v_to_route, v_ctrl), adex.capital_account_for(v_company, 'custody', v_counter, v_to_route)];
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
    -- Ronda 59: salvo el Cobrador que entrega voluntariamente SU efectivo (comprobado arriba).
    if not (v_role = 'cobrador' and v_kind = 'WORKER_RETURN' and not v_reversal and v_worker = v_actor) and exists (select 1 from adex.capital_accounts a join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
                where a.company_id = v_company and a.id = v_accts[1] and a.kind = 'custody'
                  and (m.id = v_actor or m.identity_id = v_identity)) then
      perform adex.capital_raise('AX410', 'nobody reduces their own custody');
    end if;

    -- ---------- Bloqueo de cuentas en orden global ----------
    perform 1 from adex.capital_accounts
      where company_id = v_company and id = any(v_accts)
      order by array_position(array['company', 'admin', 'route_base', 'custody', 'external', 'route_funding'], kind), id
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

-- credit_disburse: la de 0033_superadmin_supervisor_roles.sql.
create or replace function adex.credit_disburse(
  p_operation_id   uuid,
  p_request        text,
  p_route          text,
  p_client         text,
  p_amount         bigint,
  p_rate           numeric,
  p_count          integer,
  p_frequency      text,
  p_start          date,
  p_payment_days   smallint[],
  p_schedule       jsonb,      -- [{ "number": 1, "dueDate": "YYYY-MM-DD", "amountMinor": 0 }, …]
  p_reason         text
) returns table (credit_id text, disbursement_id text)
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.ctx_company();
    v_actor    text := adex.ctx_membership();
    v_role     text := adex.ctx_role();
    v_identity uuid := adex.ctx_identity();
    v_req      adex.sale_requests;
    v_today    date;
    v_currency char(3);
    v_ctrl     text;
    v_total    bigint;
    v_value    bigint;
    v_payer    text;
    v_portf    text;
    v_bal      bigint;
    v_carried  bigint;
    v_sale     text := gen_random_uuid()::text;
    v_op       text := gen_random_uuid()::text;
    v_creator  text;
    v_end      date;
    v_n        int;
    v_sum      numeric;
    i          record;
    v_cname    text;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'credits are disbursed only through the company API'); end if;
    if v_role is null or v_company is null or v_identity is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    if p_operation_id is null or p_route is null then perform adex.capital_raise('AX411', 'operation id and route are required'); end if;
    if exists (select 1 from adex.capital_operations where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    select c.currency_code, adex.business_today(c.id) into v_currency, v_today from adex.companies c where c.id = v_company;

    -- Ruta: bloqueo y responsable releído (R5). Solo rutas del alcance del actor.
    perform 1 from adex.routes where company_id = v_company and id = p_route for update;
    select capital_controller_membership_id into v_ctrl from adex.routes where company_id = v_company and id = p_route;
    if not found or not adex.ctx_route_allowed(p_route) then perform adex.capital_raise('AX412', 'route not found'); end if;
    if v_ctrl is not null and not adex.route_controller_valid_internal(v_company, p_route) then v_ctrl := null; end if;
    if not adex.route_operational(v_company, p_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;

    if p_request is not null then
      -- Confirmación de una solicitud aprobada: condiciones FINALES de la solicitud.
      if not adex.ctx_can('sale.confirmDisbursement') then perform adex.capital_raise('AX402', 'no disbursement authority'); end if;
      select * into v_req from adex.sale_requests where company_id = v_company and id = p_request for update;
      if not found or v_req.route_id <> p_route then perform adex.capital_raise('AX412', 'request not found in this route'); end if;
      if v_req.status <> 'approved' then perform adex.capital_raise('AX506', 'the request is not approved (' || v_req.status || ')'); end if;
      if (p_client, p_amount, p_rate, p_count, p_frequency, p_start, p_payment_days)
         is distinct from (v_req.client_id::text, v_req.amount_minor, v_req.interest_rate, v_req.installments_count, v_req.frequency, v_req.start_date, v_req.payment_days) then
        perform adex.capital_raise('AX503', 'disbursement conditions differ from the approved ones');
      end if;
      v_creator := coalesce(v_req.requested_by_membership_id, v_req.collector_membership_id);
    else
      -- Venta directa: `sale.createDirect` y, sin `route.edit`, el límite de la ruta.
      if not adex.ctx_can('sale.createDirect') then perform adex.capital_raise('AX402', 'no direct sale authority'); end if;
      if p_rate not in (10, 20) then perform adex.capital_raise('AX502', 'interest rate must be 10 or 20'); end if;
      if p_start < v_today then perform adex.capital_raise('AX503', 'start date before today'); end if;
      if v_role = 'supervisor' and exists (select 1 from adex.routes where company_id = v_company and id = p_route and max_loan_minor > 0 and p_amount > max_loan_minor) then
        perform adex.capital_raise('AX507', 'over the direct sale limit: send it as a request');
      end if;
      v_creator := v_actor;
    end if;
    if p_amount is null or p_amount <= 0 or p_count is null or p_count < 1 or p_frequency is null or p_start is null
       or coalesce(cardinality(p_payment_days), 0) = 0 then
      perform adex.capital_raise('AX503', 'invalid credit conditions');
    end if;
    if not exists (select 1 from adex.clients c where c.company_id = v_company and c.id = p_client and c.route_id = p_route and c.status = 'activo') then
      perform adex.capital_raise('AX504', 'the client is not active in this route');
    end if;
    -- D7: el préstamo cuenta en la semana de su fecha de inicio; el asiento, hoy.
    if adex.capital_period_closed(v_company, p_route, p_start) or adex.capital_period_closed(v_company, p_route, v_today) then
      perform adex.capital_raise('AX407', 'the period of the route is closed');
    end if;

    -- Quién paga: el efectivo de quien entrega (caja personal) o la bolsa del responsable.
    if v_role in ('cobrador', 'supervisor') then
      if not adex.capital_custodian_ok(v_company, p_route, v_actor) then perform adex.capital_raise('AX403', 'you cannot hold cash in this route'); end if;
      v_payer := adex.capital_account_for(v_company, 'custody', v_actor, p_route);
    else
      if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
      if v_actor is distinct from v_ctrl then
        perform adex.capital_raise('AX402', 'only the route capital controller disburses from the pool');
      end if;
      -- R74 Base por Ruta (0034): con `route_base` paga la Base de la ruta (D26: nunca más que su saldo).
      v_payer := adex.route_cash_account(v_company, p_route, v_ctrl);
    end if;
    -- Calendario: invariantes del motor de CLEAN.
    v_total := adex.credit_total(p_amount, p_rate);
    v_value := adex.credit_installment(v_total, p_count);
    select count(*), coalesce(sum((e->>'amountMinor')::numeric), 0), max((e->>'dueDate')::date) into v_n, v_sum, v_end
      from jsonb_array_elements(coalesce(p_schedule, '[]'::jsonb)) e;
    if v_n <> p_count or v_sum <> v_total
       or exists (select 1 from jsonb_array_elements(p_schedule) with ordinality x(e, k)
                   where (e->>'number')::int <> k or (e->>'dueDate')::date < p_start
                      or (k < p_count and (e->>'amountMinor')::bigint <> v_value)
                      or (e->>'amountMinor')::bigint < 0
                      or (k > 1 and (e->>'dueDate')::date < (p_schedule -> (k::int - 2) ->> 'dueDate')::date)) then
      perform adex.capital_raise('AX503', 'installment schedule does not match the conditions');
    end if;

    v_portf := adex.capital_account_for(v_company, 'portfolio', null, p_route);
    perform 1 from adex.capital_accounts where company_id = v_company and id in (v_payer, v_portf)
      order by array_position(array['company', 'admin', 'route_base', 'custody', 'portfolio', 'partner', 'external'], kind), id for update;
    select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = v_company and id = v_payer;
    -- D25: un faltante arrastrado es deuda, no billetes.
    if v_bal - v_carried < p_amount then perform adex.capital_raise('AX401', 'insufficient funds'); end if;

    -- Crédito + cuotas + solicitud + asiento: una sola transacción.
    insert into adex.sales (id, company_id, route_id, client_id, created_by_membership_id, sale_value_minor, interest_rate, interest_value_minor,
                            total_value_minor, balance_minor, installments_count, installment_value_minor, payment_frequency, payment_days,
                            start_date, estimated_end_date, status, disbursement_status, disbursed_by_collector_id, disbursed_by_membership_id,
                            disbursement_date, disbursed_at, sale_request_id, ledger_operation_id, created_at, updated_at)
    values (v_sale, v_company, p_route, p_client, v_creator, p_amount, p_rate, v_total - p_amount, v_total, v_total, p_count, v_value, p_frequency,
            p_payment_days, p_start, v_end, 'activa', 'desembolsado', case when v_role in ('cobrador', 'supervisor') then v_actor end, v_actor,
            v_today, now(), p_request, v_op, now(), now());
    for i in select (e->>'number')::int n, (e->>'dueDate')::date d, (e->>'amountMinor')::bigint a from jsonb_array_elements(p_schedule) e loop
      insert into adex.installments (id, company_id, sale_id, number, due_date, amount_minor, paid_minor, balance_minor, status, days_overdue)
      values (gen_random_uuid()::text, v_company, v_sale, i.n, i.d, i.a, 0, i.a, 'pendiente', 0);
    end loop;
    if p_request is not null then
      update adex.sale_requests set status = 'disbursed', sale_id = v_sale where company_id = v_company and id = p_request;
    end if;
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, sale_request_id, sale_id, reason, entry_date, actor_membership_id,
                                         actor_identity_id, actor_role, txid)
    values (v_op, v_company, p_operation_id, 'LOAN_DISBURSEMENT', p_amount, v_currency, p_route,
            case when v_role in ('cobrador', 'supervisor') then null else v_ctrl end,
            case when v_role in ('cobrador', 'supervisor') then v_actor end, p_request, v_sale,
            coalesce(nullif(btrim(p_reason), ''), 'Desembolso de crédito'), v_today, v_actor, v_identity, v_role, txid_current());
    update adex.capital_accounts set balance_minor = balance_minor - p_amount, version = version + 1, updated_at = now()
     where company_id = v_company and id = v_payer returning balance_minor into v_bal;
    insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor) values (v_company, v_op, 1, v_payer, -p_amount, v_bal);
    update adex.capital_accounts set balance_minor = balance_minor + p_amount, version = version + 1, updated_at = now()
     where company_id = v_company and id = v_portf returning balance_minor into v_bal;
    insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor) values (v_company, v_op, 2, v_portf, p_amount, v_bal);
    return query select v_sale, v_op;
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('capital_operations_one_disbursement', 'sales_company_id_sale_request_id_key') then perform adex.capital_raise('AX506', 'already disbursed'); end if;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;

-- collection_post: la de 0032_rectification_with_payments.sql.
create or replace function adex.collection_post(p_operation_id uuid, p_sale text, p_amount bigint, p_collector text, p_note text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x          adex.money_ctx;
    s          adex.sales;
    v_route    text;
    v_ctrl     text;
    v_n        int;
    v_balance  bigint;
    v_applied  bigint;
    v_paid     bigint;
    v_known    bigint;
    v_principal bigint;
    v_interest bigint;
    v_receiver text;
    v_kind     text;
    v_portf    text;
    v_income   text;
    v_new      bigint;
    v_payment  text := gen_random_uuid()::text;
    v_op       text := gen_random_uuid()::text;
    v_cname    text;
  begin
    x := adex.money_context(p_operation_id);
    if not (adex.ctx_can('payment.register') or adex.correction_step(p_operation_id)) then perform adex.capital_raise('42501', 'no collection authority'); end if;
    if p_sale is null or p_collector is null or p_amount is null or p_amount <= 0 then
      perform adex.capital_raise('AX411', 'sale, collector and a positive amount are required');
    end if;
    if p_note is not null and length(p_note) > 500 then perform adex.capital_raise('AX411', 'note is too long'); end if;
    select route_id into v_route from adex.sales where company_id = x.company and id = p_sale;
    if not found or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'credit not found'); end if;

    -- Bloqueos: ruta (compartido) → crédito.
    perform 1 from adex.routes where company_id = x.company and id = v_route for share;
    select * into s from adex.sales where company_id = x.company and id = p_sale for update;
    if not adex.route_operational(x.company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
    if adex.capital_period_closed(x.company, v_route, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
    if s.status <> 'activa' then perform adex.capital_raise('AX701', 'the credit does not accept payments (' || s.status || ')'); end if;
    if s.disbursement_status = 'pendiente' then perform adex.capital_raise('AX702', 'the credit is not disbursed'); end if;
    if s.ledger_operation_id is null then perform adex.capital_raise('AX703', 'the credit has no ledger disbursement'); end if;
    select count(*), coalesce(sum(balance_minor), 0) into v_n, v_balance from adex.installments where company_id = x.company and sale_id = p_sale;
    if v_n = 0 then perform adex.capital_raise('AX704', 'the credit has no installments'); end if;
    if v_balance <= 0 then perform adex.capital_raise('AX705', 'the credit has no balance'); end if;

    -- Responsable del efectivo (`resolveResponsibleCollector`, revalidado bajo bloqueo).
    v_ctrl := adex.route_valid_controller(x.company, v_route);
    if x.role in ('cobrador', 'supervisor') then
      if p_collector is distinct from x.actor then perform adex.capital_raise('AX708', 'your collections are your responsibility'); end if;
      if not adex.capital_custodian_ok(x.company, v_route, x.actor) then perform adex.capital_raise('AX708', 'you cannot hold cash in this route'); end if;
      v_kind := 'custody';
    elsif p_collector = x.actor then
      -- Actor administrativo sin caja personal: solo en una ruta sin Cobrador activo.
      if exists (select 1 from adex.memberships m join adex.membership_routes mr on mr.company_id = m.company_id and mr.membership_id = m.id
                  where m.company_id = x.company and mr.route_id = v_route and m.role = 'cobrador' and m.status = 'activo') then
        perform adex.capital_raise('AX707', 'indicate who received the cash');
      end if;
      if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
      v_kind := 'admin';
    elsif adex.correction_step(p_operation_id)
          and (select m.role from adex.memberships m where m.company_id = x.company and m.id = p_collector) not in ('cobrador', 'supervisor') then
      -- Corrección (0017) de un cobro que entró a la BOLSA: el reemplazo vuelve a la bolsa del responsable.
      if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
      v_kind := 'admin';
    else
      if not adex.capital_custodian_ok(x.company, v_route, p_collector) then perform adex.capital_raise('AX708', 'the collector cannot hold cash in this route'); end if;
      v_kind := 'custody';
    end if;
    -- R74 Base por Ruta (0034): el cobro sin caja personal entra a la Base de la ruta con `route_base`.
    v_receiver := case v_kind when 'custody' then adex.capital_account_for(x.company, 'custody', p_collector, v_route)
                              else adex.route_cash_account(x.company, v_route, v_ctrl) end;

    -- Tope al saldo y reparto capital / interés.
    v_applied := least(p_amount, v_balance);
    select coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0) into v_paid, v_known
      from adex.payments where company_id = x.company and sale_id = p_sale;
    v_known := v_known + s.principal_reclassified_minor;
    v_principal := adex.credit_principal_of(v_paid + v_applied, s.sale_value_minor, s.total_value_minor) - v_known;
    v_interest := v_applied - v_principal;
    if v_principal < 0 or v_interest < 0 then perform adex.capital_raise('AX420', 'inconsistent principal recognition'); end if;

    v_portf := adex.capital_account_for(x.company, 'portfolio', null, v_route);
    v_income := adex.capital_account_for(x.company, 'income', null, v_route);
    perform adex.capital_lock_accounts(x.company, array[v_receiver, v_portf, v_income]);

    insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, created_by_membership_id, amount_minor,
                               payment_date, payment_type, note, sync_status, created_at, state, ledger_operation_id, principal_minor, interest_minor)
    values (v_payment, x.company, p_sale, s.client_id, v_route, p_collector, x.actor, v_applied, x.today, 'efectivo', nullif(btrim(p_note), ''),
            'synced', now(), 'active', v_op, v_principal, v_interest);
    v_new := adex.credit_recompute(x.company, p_sale, x.today, x.today);
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, sale_id, payment_id, reason, entry_date, actor_membership_id, actor_identity_id,
                                         actor_role, txid)
    values (v_op, x.company, p_operation_id, 'COLLECTION', v_applied, x.currency, v_route, case when v_kind = 'admin' then v_ctrl end,
            case when v_kind = 'custody' then p_collector end, p_sale, v_payment, 'Recaudo de cuota', x.today, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_receiver, v_portf, v_income], array[v_applied, -v_principal, -v_interest]);

    return jsonb_build_object('paymentId', v_payment, 'operationId', v_op, 'saleId', p_sale, 'routeId', v_route,
      'collectorId', p_collector, 'receiver', v_kind, 'requestedMinor', p_amount, 'appliedMinor', v_applied, 'capped', v_applied < p_amount,
      'previousBalanceMinor', v_balance, 'newBalanceMinor', v_new, 'principalMinor', v_principal, 'interestMinor', v_interest,
      'paymentDate', x.today);
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

-- collection_reverse: la de 0032_rectification_with_payments.sql.
create or replace function adex.collection_reverse(p_operation_id uuid, p_payment text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x          adex.money_ctx;
    p          adex.payments;
    o          adex.capital_operations;
    s          adex.sales;
    v_route    text;
    v_closed   boolean;
    v_date     date;
    v_receiver text;
    v_rkind    text;
    v_rmember  text;
    v_bal      bigint;
    v_carried  bigint;
    v_paid     bigint;
    v_known    bigint;
    v_principal bigint;
    v_interest bigint;
    v_portf    text;
    v_income   text;
    v_new      bigint;
    v_rev      text := gen_random_uuid()::text;
    v_op       text := gen_random_uuid()::text;
    v_cname    text;
  begin
    x := adex.money_context(p_operation_id);
    if not (adex.ctx_can('payment.reverse') or adex.correction_step(p_operation_id)) then perform adex.capital_raise('42501', 'no reversal authority'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    select route_id into v_route from adex.payments where company_id = x.company and id = p_payment;
    if not found or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'payment not found'); end if;

    -- Bloqueos: ruta (compartido) → crédito → pago → cuentas.
    perform 1 from adex.routes where company_id = x.company and id = v_route for share;
    select * into p from adex.payments where company_id = x.company and id = p_payment;
    select * into s from adex.sales where company_id = x.company and id = p.sale_id for update;
    select * into p from adex.payments where company_id = x.company and id = p_payment for update;
    if p.state = 'reversal' then perform adex.capital_raise('AX404', 'a reversal cannot be reversed'); end if;
    if p.state = 'reversed' then perform adex.capital_raise('AX405', 'payment already reversed'); end if;
    if p.ledger_operation_id is null then perform adex.capital_raise('AX706', 'payment without ledger entry is not corrected here'); end if;
    select * into o from adex.capital_operations where company_id = x.company and id = p.ledger_operation_id;

    -- D7 (6C.1): fecha del original si su semana sigue abierta; si no, hoy (con autoridad
    -- de ajuste); el asiento del libro va hoy y hoy debe estar abierto.
    v_closed := adex.capital_period_closed(x.company, v_route, p.payment_date);
    if v_closed and not adex.ctx_can('payment.approveAdjustment') then perform adex.capital_raise('42501', 'closed period needs adjustment authority'); end if;
    if adex.capital_period_closed(x.company, v_route, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
    v_date := case when v_closed then x.today else p.payment_date end;

    -- Quien recibió el dinero debe conservarlo (nunca se devuelve dinero ya usado).
    select e.account_id, a.kind, a.membership_id into v_receiver, v_rkind, v_rmember
      from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
     where e.company_id = x.company and e.operation_id = o.id and e.amount_minor > 0 and a.kind in ('custody', 'admin', 'route_base');
    -- R74 Base por Ruta (0034): lo que recibió una bolsa antes del corte se devuelve desde la Base de la ruta.
    v_receiver := adex.route_cash_redirect(x.company, v_receiver, v_route);
    if v_rkind = 'custody' and adex.same_person(x.company, x.actor, v_rmember) then
      perform adex.capital_raise('AX410', 'nobody reduces their own custody');
    end if;
    v_portf := adex.capital_account_for(x.company, 'portfolio', null, v_route);
    v_income := adex.capital_account_for(x.company, 'income', null, v_route);
    perform adex.capital_lock_accounts(x.company, array[v_receiver, v_portf, v_income]);
    select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = x.company and id = v_receiver;
    if v_bal - v_carried < p.amount_minor then perform adex.capital_raise('AX413', 'the cash was already used'); end if;

    select coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0) into v_paid, v_known
      from adex.payments where company_id = x.company and sale_id = p.sale_id;
    v_known := v_known + s.principal_reclassified_minor;
    v_principal := adex.credit_principal_of(v_paid - p.amount_minor, s.sale_value_minor, s.total_value_minor) - v_known;
    v_interest := -p.amount_minor - v_principal;
    if v_principal > 0 or v_interest > 0 then perform adex.capital_raise('AX420', 'inconsistent principal recognition'); end if;

    insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, created_by_membership_id, amount_minor,
                               payment_date, payment_type, note, sync_status, created_at, state, reverses_payment_id, correction_reason,
                               corrected_by_membership_id, corrected_at, ledger_operation_id, principal_minor, interest_minor)
    values (v_rev, x.company, p.sale_id, p.client_id, v_route, p.collector_membership_id, x.actor, -p.amount_minor, v_date, p.payment_type,
            'Anulación del pago ' || p.id, 'synced', now(), 'reversal', p.id, btrim(p_reason), x.actor, now(), v_op, v_principal, v_interest);
    update adex.payments set state = 'reversed', reversal_payment_id = v_rev, correction_reason = btrim(p_reason),
                             corrected_by_membership_id = x.actor, corrected_at = now()
     where company_id = x.company and id = p.id;
    v_new := adex.credit_recompute(x.company, p.sale_id, x.today, v_date);
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, sale_id, payment_id, reverses_operation_id, reverses_kind, reason, entry_date,
                                         actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_op, x.company, p_operation_id, 'REVERSAL', p.amount_minor, x.currency, v_route, o.admin_membership_id, o.worker_membership_id,
            p.sale_id, v_rev, o.id, 'COLLECTION', btrim(p_reason), x.today, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_receiver, v_portf, v_income], array[-p.amount_minor, -v_principal, -v_interest]);

    return jsonb_build_object('reversalPaymentId', v_rev, 'operationId', v_op, 'paymentId', p.id, 'saleId', p.sale_id, 'routeId', v_route,
      'amountMinor', p.amount_minor, 'reversalDate', v_date, 'periodClosed', v_closed, 'newBalanceMinor', v_new);
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX413', 'the cash was already used'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname in ('capital_operations_reversal_key', 'payments_company_id_reverses_payment_id_key') then perform adex.capital_raise('AX405', 'payment already reversed'); end if;
      raise;
  end $$;

-- collection_reapply: la de 0032_rectification_with_payments.sql.
create or replace function adex.collection_reapply(p_operation_id uuid, p_payment text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x          adex.money_ctx;
    p          adex.payments;
    rv         adex.payments;
    s          adex.sales;
    v_route    text;
    v_receiver text;
    v_rkind    text;
    v_rmember  text;
    v_rseq     bigint;
    v_date     date;
    v_paid     bigint;
    v_known    bigint;
    v_principal bigint;
    v_interest bigint;
    v_portf    text;
    v_income   text;
    v_new      bigint;
    v_payment  text := gen_random_uuid()::text;
    v_op       text := gen_random_uuid()::text;
    v_cname    text;
  begin
    x := adex.money_context(p_operation_id);
    -- Solo el Administrador (el SuperAdmin supervisa y no mueve dinero).
    if x.role <> 'admin' then perform adex.capital_raise('AX402', 'only an administrator reapplies a reversed payment'); end if;
    if p_reason is null or length(btrim(p_reason)) < 10 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    select route_id into v_route from adex.payments where company_id = x.company and id = p_payment;
    if not found or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'payment not found'); end if;

    -- Bloqueos: ruta (compartido) → crédito → pago → cuentas (los de `collection_reverse`).
    perform 1 from adex.routes where company_id = x.company and id = v_route for share;
    select * into p from adex.payments where company_id = x.company and id = p_payment;
    select * into s from adex.sales where company_id = x.company and id = p.sale_id for update;
    select * into p from adex.payments where company_id = x.company and id = p_payment for update;
    if p.state is distinct from 'reversed' or p.reversal_payment_id is null or p.amount_minor <= 0 then
      perform adex.capital_raise('AX528', 'only a reversed payment can be reapplied');
    end if;
    if p.corrected_by_payment_id is not null then perform adex.capital_raise('AX528', 'the payment was corrected: its replacement already exists'); end if;
    if exists (select 1 from adex.payments where company_id = x.company and reapplies_payment_id = p.id) then
      perform adex.capital_raise('AX528', 'the payment was already reapplied');
    end if;
    if p.ledger_operation_id is null then perform adex.capital_raise('AX706', 'payment without ledger entry is not corrected here'); end if;
    if not adex.route_operational(x.company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
    if adex.capital_period_closed(x.company, v_route, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
    if s.status <> 'activa' then perform adex.capital_raise('AX701', 'the credit does not accept payments (' || s.status || ')'); end if;
    if s.ledger_operation_id is null then perform adex.capital_raise('AX703', 'the credit has no ledger disbursement'); end if;
    if s.balance_minor < p.amount_minor then perform adex.capital_raise('AX525', 'reapplying would exceed the balance of the credit'); end if;

    -- La cuenta que recibió el pago original vuelve a recibirlo.
    select e.account_id, a.kind, a.membership_id into v_receiver, v_rkind, v_rmember
      from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
     where e.company_id = x.company and e.operation_id = p.ledger_operation_id and e.amount_minor > 0 and a.kind in ('custody', 'admin', 'route_base');
    if v_receiver is null then perform adex.capital_raise('AX706', 'the original receiver is unknown'); end if;
    -- R74 Base por Ruta (0034): lo que recibió una bolsa o la Base vuelve a la Base de la ruta y lo reaplica
    -- su Administrador responsable vigente.
    if v_rkind in ('admin', 'route_base') and adex.company_capital_model(x.company) = 'route_base' then
      v_receiver := adex.capital_account_for(x.company, 'route_base', null, v_route); v_rkind := 'route_base';
      v_rmember := adex.route_valid_controller(x.company, v_route);
      if v_rmember is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    end if;
    select * into rv from adex.payments where company_id = x.company and id = p.reversal_payment_id;
    select e.seq into v_rseq from adex.capital_entries e
     where e.company_id = x.company and e.operation_id = rv.ledger_operation_id and e.account_id = v_receiver;
    if v_rkind = 'custody' then
      if not adex.capital_custodian_ok(x.company, v_route, v_rmember) then
        perform adex.capital_raise('AX522', 'the worker who received the payment no longer holds cash in this route');
      end if;
      -- Si la anulación ya entró en un cuadre, ese efectivo pudo quedar como sobrante: sin
      -- política de conciliación aprobada, no se reaplica.
      if exists (select 1 from adex.custody_settlements cs where cs.company_id = x.company and cs.custody_account_id = v_receiver
                   and cs.status = 'cerrada' and cs.to_seq >= v_rseq) then
        perform adex.capital_raise('AX529', 'the reversal is already included in a settlement');
      end if;
    elsif v_rmember is distinct from x.actor then
      perform adex.capital_raise('AX402', 'only the administrator whose pool received the payment reapplies it');
    end if;
    -- Fecha del pago original si su semana sigue abierta; si no, hoy. El asiento va hoy (D7).
    v_date := case when adex.capital_period_closed(x.company, v_route, p.payment_date) then x.today else p.payment_date end;

    select coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0) into v_paid, v_known
      from adex.payments where company_id = x.company and sale_id = p.sale_id;
    v_known := v_known + s.principal_reclassified_minor;
    v_principal := adex.credit_principal_of(v_paid + p.amount_minor, s.sale_value_minor, s.total_value_minor) - v_known;
    v_interest := p.amount_minor - v_principal;
    if v_principal < 0 or v_interest < 0 then perform adex.capital_raise('AX420', 'inconsistent principal recognition'); end if;

    v_portf := adex.capital_account_for(x.company, 'portfolio', null, v_route);
    v_income := adex.capital_account_for(x.company, 'income', null, v_route);
    perform adex.capital_lock_accounts(x.company, array[v_receiver, v_portf, v_income]);

    insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, created_by_membership_id, amount_minor,
                               payment_date, payment_type, note, sync_status, created_at, state, ledger_operation_id, principal_minor, interest_minor,
                               reapplies_payment_id)
    values (v_payment, x.company, p.sale_id, p.client_id, v_route, p.collector_membership_id, x.actor, p.amount_minor, v_date, p.payment_type,
            left('Reaplicación del pago ' || p.id || ': ' || btrim(p_reason), 500), 'synced', now(), 'active', v_op, v_principal, v_interest, p.id);
    v_new := adex.credit_recompute(x.company, p.sale_id, x.today, v_date);
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                         worker_membership_id, sale_id, payment_id, reason, entry_date, actor_membership_id, actor_identity_id,
                                         actor_role, txid)
    values (v_op, x.company, p_operation_id, 'COLLECTION', p.amount_minor, x.currency, v_route, case when v_rkind in ('admin', 'route_base') then v_rmember end,
            case when v_rkind = 'custody' then v_rmember end, p.sale_id, v_payment, left('Reaplicación de pago anulado: ' || btrim(p_reason), 300),
            x.today, x.actor, x.identity, x.role, txid_current());
    perform adex.capital_write_legs(x.company, v_op, array[v_receiver, v_portf, v_income], array[p.amount_minor, -v_principal, -v_interest]);

    return jsonb_build_object('paymentId', v_payment, 'operationId', v_op, 'reappliesPaymentId', p.id, 'saleId', p.sale_id, 'routeId', v_route,
      'collectorId', p.collector_membership_id, 'receiver', v_rkind, 'amountMinor', p.amount_minor, 'paymentDate', v_date,
      'principalMinor', v_principal, 'interestMinor', v_interest, 'newBalanceMinor', v_new);
  exception
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname = 'payments_one_reapplication' then perform adex.capital_raise('AX528', 'the payment was already reapplied'); end if;
      raise;
  end $$;

-- collection_reapply_check: la de 0032_rectification_with_payments.sql.
create or replace function adex.collection_reapply_check(p_payment text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    v_today date;
    p adex.payments; rv adex.payments; s adex.sales;
    v_receiver text; v_rkind text; v_rmember text; v_rseq bigint;
    v_blockers text[] := array[]::text[];
  begin
    if adex.ctx_role() is distinct from 'admin' then perform adex.capital_raise('AX402', 'only an administrator reapplies a reversed payment'); end if;
    select * into p from adex.payments where company_id = v_company and id = p_payment;
    if not found or not adex.ctx_route_allowed(p.route_id) then perform adex.capital_raise('AX412', 'payment not found'); end if;
    v_today := adex.business_today(v_company);
    select * into s from adex.sales where company_id = v_company and id = p.sale_id;
    if p.state is distinct from 'reversed' or p.reversal_payment_id is null then v_blockers := array_append(v_blockers, 'NOT_REVERSED'); end if;
    if p.corrected_by_payment_id is not null then v_blockers := array_append(v_blockers, 'CORRECTED'); end if;
    if exists (select 1 from adex.payments where company_id = v_company and reapplies_payment_id = p.id) then v_blockers := array_append(v_blockers, 'ALREADY_REAPPLIED'); end if;
    if adex.capital_period_closed(v_company, p.route_id, v_today) then v_blockers := array_append(v_blockers, 'PERIOD_CLOSED'); end if;
    if s.status <> 'activa' then v_blockers := array_append(v_blockers, 'CREDIT_NOT_ACTIVE'); end if;
    if s.balance_minor < p.amount_minor then v_blockers := array_append(v_blockers, 'OVERPAYMENT'); end if;
    select e.account_id, a.kind, a.membership_id into v_receiver, v_rkind, v_rmember
      from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
     where e.company_id = v_company and e.operation_id = p.ledger_operation_id and e.amount_minor > 0 and a.kind in ('custody', 'admin', 'route_base');
    -- R74 Base por Ruta (0034): con `route_base` lo reaplica el responsable vigente de la ruta.
    if v_rkind in ('admin', 'route_base') and adex.company_capital_model(v_company) = 'route_base' then
      v_rkind := 'route_base'; v_rmember := adex.route_valid_controller(v_company, p.route_id);
    end if;
    if v_receiver is null then
      v_blockers := array_append(v_blockers, 'LEGACY_PAYMENTS');
    elsif v_rkind = 'custody' then
      if not adex.capital_custodian_ok(v_company, p.route_id, v_rmember) then v_blockers := array_append(v_blockers, 'CUSTODIAN_CHANGED'); end if;
      select * into rv from adex.payments where company_id = v_company and id = p.reversal_payment_id;
      select e.seq into v_rseq from adex.capital_entries e where e.company_id = v_company and e.operation_id = rv.ledger_operation_id and e.account_id = v_receiver;
      if exists (select 1 from adex.custody_settlements cs where cs.company_id = v_company and cs.custody_account_id = v_receiver
                   and cs.status = 'cerrada' and cs.to_seq >= v_rseq) then
        v_blockers := array_append(v_blockers, 'REVERSAL_SETTLED');
      end if;
    elsif v_rmember is distinct from adex.ctx_membership() then
      v_blockers := array_append(v_blockers, 'POOL_OF_ANOTHER_ADMIN');
    end if;
    return jsonb_build_object('paymentId', p.id, 'saleId', p.sale_id, 'amountMinor', p.amount_minor, 'paymentDate', p.payment_date,
      'reapplyDate', case when adex.capital_period_closed(v_company, p.route_id, p.payment_date) then v_today else p.payment_date end,
      'receiverKind', v_rkind, 'receiverId', v_rmember, 'blockers', to_jsonb(v_blockers));
  end $$;

-- expense_post: la de 0033_superadmin_supervisor_roles.sql.
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

-- expense_correctable: la de 0033_superadmin_supervisor_roles.sql.
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

-- custody_settle: la de 0033_superadmin_supervisor_roles.sql.
create or replace function adex.custody_settle(
  p_operation_id  uuid,
  p_route         text,
  p_worker        text,
  p_delivered     bigint,
  p_expected_seen bigint,
  p_previous      text,
  p_reason        text
) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x         adex.money_ctx;
    m         adex.memberships;
    v_ctrl    text;
    v_acc     text;
    v_pool    text;
    v_sus     text;
    v_uni     text;
    v_bal     bigint;
    v_carried bigint;
    v_prev    adex.custody_settlements;
    v_from    bigint;
    v_to      bigint;
    v_closing bigint;
    c         adex.custody_cycle_t;
    v_p       bigint;
    v_e       bigint;
    v_diff    bigint;
    v_short   bigint;
    v_surplus bigint;
    v_t       bigint;
    v_version int;
    v_id      text := gen_random_uuid()::text;
    v_ret     text;
    v_sop     text;
    v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
    v_tz      text;
    v_cname   text;
  begin
    x := adex.money_context(p_operation_id);
    if not adex.ctx_can('cashSettlement.close') then perform adex.capital_raise('42501', 'no settlement authority'); end if;
    if p_delivered is null or p_delivered < 0 or p_expected_seen is null or p_route is null or p_worker is null then
      perform adex.capital_raise('AX411', 'route, worker, delivered (>= 0) and the expected amount seen are required');
    end if;
    if v_reason is not null and length(v_reason) > 300 then perform adex.capital_raise('AX411', 'reason is too long'); end if;
    if exists (select 1 from adex.custody_settlements where company_id = x.company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    if not adex.ctx_route_allowed(p_route) or not exists (select 1 from adex.routes where company_id = x.company and id = p_route) then
      perform adex.capital_raise('AX412', 'route not found');
    end if;

    -- Bloqueos: ruta (compartido: fija responsable y cierres; deja correr la ruta).
    perform 1 from adex.routes where company_id = x.company and id = p_route for share;
    v_ctrl := adex.route_valid_controller(x.company, p_route);
    if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    -- Autoridad `settle` (`routeCashAuthorityError`): responsable o Supervisor de la ruta (R74: no el SuperAdmin).
    if not (x.actor is not distinct from v_ctrl
            or (x.role = 'supervisor' and exists (select 1 from adex.membership_routes where company_id = x.company and membership_id = x.actor and route_id = p_route))) then
      perform adex.capital_raise('AX402', 'no authority to settle cash in this route');
    end if;
    if adex.capital_period_closed(x.company, p_route, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;

    -- Trabajador con caja personal; asignado a la ruta o con custodia en ella (un trabajador
    -- retirado o desactivado debe poder entregar lo que tiene: nunca se deja dinero varado).
    select * into m from adex.memberships where company_id = x.company and id = p_worker;
    if not found then perform adex.capital_raise('AX412', 'worker not found'); end if;
    if m.role not in ('cobrador', 'supervisor') then perform adex.capital_raise('AX403', 'only collectors and supervisors hold personal cash'); end if;
    v_acc := 'acc-' || md5(x.company || '|custody|' || p_worker || '|' || p_route);
    if not exists (select 1 from adex.membership_routes where company_id = x.company and membership_id = p_worker and route_id = p_route)
       and not exists (select 1 from adex.capital_accounts where company_id = x.company and id = v_acc) then
      perform adex.capital_raise('AX403', 'the worker has no cash in this route');
    end if;
    -- Nadie se cuadra a sí mismo, ni con otra de sus membresías (DS-05: misma persona).
    if adex.same_person(x.company, x.actor, p_worker) then perform adex.capital_raise('AX801', 'nobody settles their own cash'); end if;

    v_acc := adex.capital_account_for(x.company, 'custody', p_worker, p_route);
    -- R74 Base por Ruta (0034): con `route_base` el efectivo reconocido vuelve a la Base de la ruta.
    v_pool := adex.route_cash_account(x.company, p_route, v_ctrl);
    perform adex.capital_lock_accounts(x.company, array[v_pool, v_acc]);

    -- Bajo bloqueo: ciclo abierto, esperado y comprobaciones de cifras obsoletas.
    select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = x.company and id = v_acc;
    v_prev := adex.custody_last_settlement(x.company, v_acc);
    if v_prev.id is distinct from p_previous then perform adex.capital_raise('AX802', 'another settlement was closed meanwhile'); end if;
    v_from := coalesce(v_prev.closing_seq, 0);
    v_to := greatest(v_from, coalesce((select max(seq) from adex.capital_entries where company_id = x.company and account_id = v_acc), 0));
    c := adex.custody_cycle(x.company, v_acc, v_from, v_to);
    v_p := adex.custody_cycle_position(c);
    if v_p <> v_bal then perform adex.capital_raise('AX420', 'custody cycle does not match the ledger'); end if;
    if p_expected_seen <> v_p then perform adex.capital_raise('AX802', 'the figures changed since the preview'); end if;

    v_e := greatest(v_p, 0);
    v_diff := p_delivered - v_e;
    v_short := greatest(0, -v_diff);
    v_surplus := greatest(0, v_diff);
    v_t := least(p_delivered, v_e);
    if v_diff <> 0 and length(coalesce(v_reason, '')) < 10 then perform adex.capital_raise('AX803', 'a difference needs a reason (10+ characters)'); end if;
    select coalesce(max(version), 0) + 1 into v_version from adex.custody_settlements
     where company_id = x.company and custody_account_id = v_acc and cycle_no = coalesce(v_prev.cycle_no, 0) + 1;

    -- Efectivo reconocido → bolsa del responsable (C1). Nunca el faltante ni el sobrante.
    if v_t > 0 then
      v_ret := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, settlement_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_ret, x.company, p_operation_id, 'SETTLEMENT_RETURN', v_t, x.currency, p_route, v_ctrl, p_worker, v_id,
              'Cuadre: efectivo entregado', x.today, x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_ret, array[v_acc, v_pool], array[-v_t, v_t]);
    end if;
    -- Sobrante → cuentas de control (no gastable; su destino es la decisión F6-D02).
    if v_surplus > 0 then
      v_sus := adex.capital_account_for(x.company, 'suspense', v_ctrl, p_route);
      v_uni := adex.capital_account_for(x.company, 'unidentified', null, p_route);
      perform adex.capital_lock_accounts(x.company, array[v_sus, v_uni]);
      v_sop := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, settlement_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_sop, x.company, md5(p_operation_id::text || ':surplus')::uuid, 'SETTLEMENT_SURPLUS', v_surplus, x.currency, p_route, v_ctrl,
              p_worker, v_id, 'Cuadre: sobrante sin identificar', x.today, x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_sop, array[v_uni, v_sus], array[-v_surplus, v_surplus]);
    end if;
    -- Arrastre: SOLO el faltante, en positivo (`carryOverFrom`).
    update adex.capital_accounts set carried_minor = v_short, version = version + 1, updated_at = now()
     where company_id = x.company and id = v_acc;
    v_closing := greatest(v_to, coalesce((select max(seq) from adex.capital_entries where company_id = x.company and account_id = v_acc), 0));
    select timezone into v_tz from adex.companies where id = x.company;

    insert into adex.custody_settlements (
      id, company_id, route_id, worker_membership_id, worker_identity_id, custody_account_id, operation_id, cycle_no, version, previous_settlement_id,
      from_seq, to_seq, closing_seq, opening_position_minor, opening_carried_minor, base_received_minor, base_returned_minor, collected_minor,
      disbursed_minor, expenses_minor, other_minor, expected_position_minor, expected_cash_minor, expected_seen_minor, delivered_minor,
      difference_minor, shortage_minor, surplus_minor, returned_to_pool_minor, carried_after_minor, negative_position_minor, breakdown, reason,
      status, business_date, timezone, closed_at, closed_by_membership_id, closed_by_identity_id, closed_by_role, receiver_admin_membership_id,
      return_operation_id, surplus_operation_id, txid)
    values (
      v_id, x.company, p_route, p_worker, m.identity_id, v_acc, p_operation_id, coalesce(v_prev.cycle_no, 0) + 1, v_version, v_prev.id,
      v_from, v_to, v_closing, c.opening, coalesce(v_prev.carried_after_minor, 0), c.base_received + c.transfers_in, c.partial_returns + c.transfers_out,
      c.collected, c.disbursed, c.expenses, c.settlement_adjust + c.other, v_p, v_e, p_expected_seen, p_delivered,
      v_diff, v_short, v_surplus, v_t, v_short, least(v_p, 0), adex.custody_cycle_json(c), v_reason,
      'cerrada', x.today, v_tz, now(), x.actor, x.identity, x.role, v_ctrl, v_ret, v_sop, txid_current());
    -- Volver a cerrar un ciclo reabierto: la versión nueva sustituye a las reabiertas del mismo arranque.
    update adex.custody_settlements set superseded_by = v_id
     where company_id = x.company and custody_account_id = v_acc and cycle_no = coalesce(v_prev.cycle_no, 0) + 1
       and status = 'reabierta' and superseded_by is null;

    return jsonb_build_object('settlementId', v_id, 'version', v_version, 'routeId', p_route, 'workerId', p_worker,
      'expectedPositionMinor', v_p, 'expectedCashMinor', v_e, 'deliveredMinor', p_delivered, 'differenceMinor', v_diff,
      'shortageMinor', v_short, 'surplusMinor', v_surplus, 'returnedToPoolMinor', v_t, 'carriedAfterMinor', v_short,
      'negativePositionMinor', least(v_p, 0), 'returnOperationId', v_ret, 'surplusOperationId', v_sop, 'businessDate', x.today,
      'result', case when v_diff = 0 then 'exacto' when v_diff < 0 then 'faltante' else 'sobrante' end);
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('capital_operations_operation_key', 'custody_settlements_operation_key') then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname = 'custody_settlements_one_active_per_cycle' then perform adex.capital_raise('AX802', 'another settlement was closed meanwhile'); end if;
      raise;
  end $$;

-- custody_settlement_reopen: la de 0033_superadmin_supervisor_roles.sql.
create or replace function adex.custody_settlement_reopen(p_operation_id uuid, p_settlement text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x       adex.money_ctx;
    s       adex.custody_settlements;
    v_ctrl  text;
    v_pool  text;
    v_sus   text;
    v_uni   text;
    v_rev   text;
    v_rev2  text;
    v_reason text := btrim(coalesce(p_reason, ''));
    v_cname text;
  begin
    x := adex.money_context(p_operation_id);
    if not adex.ctx_can('cashSettlement.reopen') then perform adex.capital_raise('42501', 'no reopen authority'); end if;
    if length(v_reason) < 10 or length(v_reason) > 300 then perform adex.capital_raise('AX803', 'reopening needs a reason (10+ characters)'); end if;
    select * into s from adex.custody_settlements where company_id = x.company and id = p_settlement;
    if not found or not adex.ctx_route_allowed(s.route_id) then perform adex.capital_raise('AX412', 'settlement not found'); end if;

    perform 1 from adex.routes where company_id = x.company and id = s.route_id for share;
    v_ctrl := adex.route_valid_controller(x.company, s.route_id);
    if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    -- Reabrir es CORREGIR: solo el responsable de capital de la ruta (R74: no el SuperAdmin).
    if x.actor is distinct from v_ctrl then
      perform adex.capital_raise('AX402', 'only the route capital controller can reopen');
    end if;
    if adex.same_person(x.company, x.actor, s.worker_membership_id) then perform adex.capital_raise('AX801', 'nobody reopens their own settlement'); end if;
    -- D7: hoy abierto y el día del cuadre en un periodo abierto (lo cerrado no se reabre).
    if adex.capital_period_closed(x.company, s.route_id, x.today) or adex.capital_period_closed(x.company, s.route_id, s.business_date) then
      perform adex.capital_raise('AX407', 'the period of the settlement is closed');
    end if;

    -- R74 Base por Ruta (0034): con `route_base` el efectivo devuelto sale de la Base de la ruta.
    v_pool := adex.route_cash_redirect(x.company, adex.capital_account_for(x.company, 'admin', s.receiver_admin_membership_id, null), s.route_id);
    perform adex.capital_lock_accounts(x.company, array[v_pool, s.custody_account_id]);
    if s.surplus_operation_id is not null then
      v_sus := adex.capital_account_for(x.company, 'suspense', s.receiver_admin_membership_id, s.route_id);
      v_uni := adex.capital_account_for(x.company, 'unidentified', null, s.route_id);
      perform adex.capital_lock_accounts(x.company, array[v_sus, v_uni]);
    end if;
    select * into s from adex.custody_settlements where company_id = x.company and id = p_settlement for update;
    if s.status <> 'cerrada' or s.superseded_by is not null then perform adex.capital_raise('AX806', 'the settlement is not open to reopening'); end if;
    -- Solo el ÚLTIMO cuadre vigente (`reopenCashBlockedReason`).
    if exists (select 1 from adex.custody_settlements where company_id = x.company and custody_account_id = s.custody_account_id
                 and status = 'cerrada' and id <> s.id and cycle_no > s.cycle_no) then
      perform adex.capital_raise('AX806', 'only the latest settlement can be reopened');
    end if;

    -- El efectivo devuelto a la bolsa vuelve a la custodia (si la bolsa aún lo tiene).
    if s.return_operation_id is not null then
      v_rev := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, settlement_id, reverses_operation_id, reverses_kind, reason, entry_date,
                                           actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_rev, x.company, p_operation_id, 'REVERSAL', s.returned_to_pool_minor, x.currency, s.route_id, s.receiver_admin_membership_id,
              s.worker_membership_id, s.id, s.return_operation_id, 'SETTLEMENT_RETURN', 'Reapertura del cuadre: ' || v_reason, x.today,
              x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_rev, array[v_pool, s.custody_account_id], array[-s.returned_to_pool_minor, s.returned_to_pool_minor]);
    end if;
    if s.surplus_operation_id is not null then
      v_rev2 := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, settlement_id, reverses_operation_id, reverses_kind, reason, entry_date,
                                           actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_rev2, x.company, md5(p_operation_id::text || ':surplus')::uuid, 'REVERSAL', s.surplus_minor, x.currency, s.route_id,
              s.receiver_admin_membership_id, s.worker_membership_id, s.id, s.surplus_operation_id, 'SETTLEMENT_SURPLUS',
              'Reapertura del cuadre: ' || v_reason, x.today, x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_rev2, array[v_sus, v_uni], array[-s.surplus_minor, s.surplus_minor]);
    end if;
    -- El arrastre vuelve al que había antes de este cuadre.
    update adex.capital_accounts set carried_minor = s.opening_carried_minor, version = version + 1, updated_at = now()
     where company_id = x.company and id = s.custody_account_id;
    update adex.custody_settlements set status = 'reabierta', reopened_at = now(), reopened_by_membership_id = x.actor, reopen_reason = v_reason
     where company_id = x.company and id = s.id;
    return jsonb_build_object('settlementId', s.id, 'routeId', s.route_id, 'workerId', s.worker_membership_id,
      'returnedToCustodyMinor', s.returned_to_pool_minor, 'surplusReleasedMinor', s.surplus_minor, 'carriedMinor', s.opening_carried_minor,
      'reversalOperationId', v_rev, 'surplusReversalOperationId', v_rev2, 'reopenDate', x.today);
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      -- La bolsa ya usó ese efectivo: no se reabre (nunca se recupera dinero ya usado).
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX413', 'the cash was already used'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname in ('capital_operations_reversal_key', 'capital_operations_one_per_settlement') then perform adex.capital_raise('AX806', 'the settlement is not open to reopening'); end if;
      raise;
  end $$;

-- credit_rectify: la de 0032_rectification_with_payments.sql.
create or replace function adex.credit_rectify(
  p_operation_id   uuid,
  p_sale           text,
  p_expected_count integer,
  p_amount         bigint,
  p_rate           numeric,
  p_count          integer,
  p_frequency      text,
  p_start          date,
  p_payment_days   smallint[],
  p_schedule       jsonb,
  p_reason         text,
  p_evidence       text,
  p_offline_checked boolean
) returns table (rectification_id text, adjustment_id text, delta_minor bigint)
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.ctx_company();
    v_actor    text := adex.ctx_membership();
    v_role     text := adex.ctx_role();
    v_identity uuid := adex.ctx_identity();
    v_today    date;
    v_currency char(3);
    v_route    text;
    s          adex.sales;
    v_orig     adex.capital_operations;
    v_payer    text;
    v_pkind    text;
    v_powner   text;
    v_pseq     bigint;
    v_portf    text;
    v_income   text;
    v_bal      bigint;
    v_carried  bigint;
    v_total    bigint;
    v_value    bigint;
    v_end      date;
    v_n        int;
    v_sum      numeric;
    v_delta    bigint;
    v_adj      text;
    v_rect     text := gen_random_uuid()::text;
    v_before   jsonb;
    v_after    jsonb;
    i          record;
    v_cname    text;
    -- Pagos (A1/A2)
    v_pays     int;
    v_paid     bigint;
    v_known    bigint;
    v_inst_paid bigint;
    v_paid_on  date;
    v_reclass  bigint := 0;
    v_rop      text;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'credits are rectified only through the company API'); end if;
    if v_role is null or v_company is null or v_identity is null or v_actor is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    if v_role <> 'admin' then perform adex.capital_raise('AX402', 'only an administrator rectifies a disbursed credit'); end if;
    if p_operation_id is null or p_sale is null then perform adex.capital_raise('AX411', 'operation id and credit are required'); end if;
    if exists (select 1 from adex.capital_operations where company_id = v_company and operation_id in (p_operation_id, adex.derived_operation_id(p_operation_id, 'reclassification')))
       or exists (select 1 from adex.credit_rectifications where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    if p_reason is null or length(btrim(p_reason)) < 10 or length(p_reason) > 300
       or p_evidence is null or length(btrim(p_evidence)) < 10 or length(p_evidence) > 500 then
      perform adex.capital_raise('AX411', 'reason and evidence are required');
    end if;
    if p_offline_checked is distinct from true then
      perform adex.capital_raise('AX411', 'confirm there are no offline captures pending for this credit');
    end if;
    select c.currency_code, adex.business_today(c.id) into v_currency, v_today from adex.companies c where c.id = v_company;

    -- Bloqueos: ruta → crédito → cuentas (el crédito bloqueado detiene recaudos y anulaciones).
    select route_id into v_route from adex.sales where company_id = v_company and id = p_sale;
    if not found or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'credit not found'); end if;
    perform 1 from adex.routes where company_id = v_company and id = v_route for update;
    select * into s from adex.sales where company_id = v_company and id = p_sale for update;
    if s.route_id <> v_route then perform adex.capital_raise('AX523', 'the credit changed: reload it'); end if;
    if not adex.route_operational(v_company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
    if s.rectification_count is distinct from p_expected_count then perform adex.capital_raise('AX523', 'the credit changed: reload it'); end if;
    if s.status <> 'activa' then perform adex.capital_raise('AX701', 'the credit is not active (' || s.status || ')'); end if;
    if s.disbursement_status is distinct from 'desembolsado' or s.ledger_operation_id is null then
      perform adex.capital_raise('AX703', 'the credit has no disbursement in the ledger');
    end if;

    -- Pagos: lo que cuenta es el efecto NETO (originales + anulaciones) y su imputación.
    select count(*), coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0),
           max(payment_date) filter (where amount_minor > 0 and coalesce(state, 'active') = 'active')
      into v_pays, v_paid, v_known, v_paid_on
      from adex.payments where company_id = v_company and sale_id = s.id;
    v_known := v_known + s.principal_reclassified_minor;
    if exists (select 1 from adex.payments where company_id = v_company and sale_id = s.id and ledger_operation_id is null) then
      perform adex.capital_raise('AX526', 'the credit has payments without a ledger entry');
    end if;
    if exists (select 1 from adex.payment_adjustment_requests where company_id = v_company and sale_id = s.id and status = 'pending') then
      perform adex.capital_raise('AX527', 'resolve the pending payment adjustment first');
    end if;
    select coalesce(sum(paid_minor), 0) into v_inst_paid from adex.installments where company_id = v_company and sale_id = s.id;
    if s.balance_minor <> s.total_value_minor - v_paid or v_inst_paid <> v_paid
       or v_known <> adex.credit_principal_of(v_paid, s.sale_value_minor, s.total_value_minor) then
      perform adex.capital_raise('AX420', 'collections and their allocation do not reconcile');
    end if;

    -- Desembolso original y la cuenta que pagó (pata negativa).
    select * into v_orig from adex.capital_operations where company_id = v_company and id = s.ledger_operation_id;
    if not found or v_orig.kind <> 'LOAN_DISBURSEMENT' or v_orig.sale_id is distinct from s.id then
      perform adex.capital_raise('AX703', 'the credit has no disbursement in the ledger');
    end if;
    select e.account_id, a.kind, a.membership_id, e.seq into v_payer, v_pkind, v_powner, v_pseq
      from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
     where e.company_id = v_company and e.operation_id = v_orig.id and e.amount_minor < 0;
    -- R74 Base por Ruta (0034): lo que pagó una bolsa o la Base lo cubre (o lo recibe) la Base de la ruta y lo
    -- rectifica su Administrador responsable vigente.
    if v_pkind in ('admin', 'route_base') and adex.company_capital_model(v_company) = 'route_base' then
      v_payer := adex.capital_account_for(v_company, 'route_base', null, v_route); v_pkind := 'route_base';
      v_powner := adex.route_valid_controller(v_company, v_route);
    end if;
    if v_payer is null or v_pkind not in ('custody', 'admin', 'route_base') then perform adex.capital_raise('AX703', 'the credit has no disbursement in the ledger'); end if;

    v_delta := p_amount - s.sale_value_minor;
    -- Cambio de capital entregado: los controles de SOC-09 (la diferencia mueve efectivo de la
    -- cuenta que pagó). Sin cambio de capital ninguna cuenta de efectivo se toca.
    if v_delta is distinct from 0 then
      if v_pkind = 'custody' and exists (select 1 from adex.custody_settlements cs
           where cs.company_id = v_company and cs.custody_account_id = v_payer and cs.status = 'cerrada' and cs.to_seq >= v_pseq) then
        perform adex.capital_raise('AX521', 'the disbursement is already included in a settlement');
      end if;
      if v_pkind = 'custody' and not adex.capital_custodian_ok(v_company, v_route, v_powner) then
        perform adex.capital_raise('AX522', 'the worker who paid no longer holds cash in this route');
      end if;
      if v_pkind = 'admin' and v_powner is distinct from v_actor then
        perform adex.capital_raise('AX402', 'only the administrator whose pool paid rectifies this credit');
      end if;
      if v_pkind = 'route_base' and v_powner is distinct from v_actor then
        perform adex.capital_raise('AX402', 'only the responsible administrator of the route rectifies this credit');
      end if;
    end if;
    -- D73-03: ningún periodo cerrado (desembolso, calendario anterior o nuevo, hoy).
    if adex.capital_period_closed(v_company, v_route, v_orig.entry_date) or adex.capital_period_closed(v_company, v_route, s.disbursement_date)
       or adex.capital_period_closed(v_company, v_route, s.start_date) or adex.capital_period_closed(v_company, v_route, p_start)
       or adex.capital_period_closed(v_company, v_route, v_today) then
      perform adex.capital_raise('AX407', 'the period of the route is closed');
    end if;

    -- Condiciones nuevas (mismas reglas que el desembolso; el inicio no antecede al desembolso).
    if p_amount is null or p_amount <= 0 or p_count is null or p_count not between 1 and 1000 or p_frequency is null
       or p_frequency not in ('diaria', 'semanal', 'quincenal', 'mensual', 'personalizada') or p_start is null
       or coalesce(cardinality(p_payment_days), 0) = 0 or p_start < coalesce(s.disbursement_date, v_orig.entry_date) then
      perform adex.capital_raise('AX503', 'invalid credit conditions');
    end if;
    if p_rate not in (10, 20) then perform adex.capital_raise('AX502', 'interest rate must be 10 or 20'); end if;
    if (p_amount, p_rate, p_count, p_frequency, p_start, p_payment_days)
       is not distinct from (s.sale_value_minor, s.interest_rate, s.installments_count, s.payment_frequency, s.start_date, s.payment_days) then
      perform adex.capital_raise('AX524', 'nothing to rectify');
    end if;
    v_total := adex.credit_total(p_amount, p_rate);
    v_value := adex.credit_installment(v_total, p_count);
    -- Sin política aprobada de sobrepagos y devoluciones: el total no baja de lo ya pagado.
    if v_total < v_paid then perform adex.capital_raise('AX525', 'the corrected total is below what was already paid'); end if;
    select count(*), coalesce(sum((e->>'amountMinor')::numeric), 0), max((e->>'dueDate')::date) into v_n, v_sum, v_end
      from jsonb_array_elements(coalesce(p_schedule, '[]'::jsonb)) e;
    if v_n <> p_count or v_sum <> v_total
       or exists (select 1 from jsonb_array_elements(p_schedule) with ordinality x(e, k)
                   where (e->>'number')::int <> k or (e->>'dueDate')::date < p_start
                      or (k < p_count and (e->>'amountMinor')::bigint <> v_value)
                      or (e->>'amountMinor')::bigint < 0
                      or (k > 1 and (e->>'dueDate')::date < (p_schedule -> (k::int - 2) ->> 'dueDate')::date)) then
      perform adex.capital_raise('AX503', 'installment schedule does not match the conditions');
    end if;

    v_before := jsonb_build_object('sale', to_jsonb(s), 'installments',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.number), '[]'::jsonb) from adex.installments x where x.company_id = v_company and x.sale_id = s.id),
      'netPaidMinor', v_paid, 'principalRecognizedMinor', v_known);

    v_portf := adex.capital_account_for(v_company, 'portfolio', null, v_route);
    -- Diferencia de capital: operación nueva entre la cuenta que pagó y la cartera (SOC-09).
    if v_delta <> 0 then
      perform 1 from adex.capital_accounts where company_id = v_company and id in (v_payer, v_portf)
        order by array_position(array['company', 'admin', 'route_base', 'custody', 'portfolio', 'partner', 'external', 'income', 'expense', 'suspense', 'unidentified', 'route_funding'], kind), id for update;
      if v_delta > 0 then
        select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = v_company and id = v_payer;
        if v_bal - v_carried < v_delta then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      end if;
      v_adj := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, sale_request_id, sale_id, reason, entry_date, actor_membership_id,
                                           actor_identity_id, actor_role, txid)
      values (v_adj, v_company, p_operation_id, 'DISBURSEMENT_ADJUSTMENT', abs(v_delta), v_currency, v_route, v_orig.admin_membership_id,
              v_orig.worker_membership_id, v_orig.sale_request_id, s.id, left('Rectificación de desembolso: ' || btrim(p_reason), 300),
              v_today, v_actor, v_identity, v_role, txid_current());
      update adex.capital_accounts set balance_minor = balance_minor - v_delta, version = version + 1, updated_at = now()
       where company_id = v_company and id = v_payer returning balance_minor into v_bal;
      insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor) values (v_company, v_adj, 1, v_payer, -v_delta, v_bal);
      update adex.capital_accounts set balance_minor = balance_minor + v_delta, version = version + 1, updated_at = now()
       where company_id = v_company and id = v_portf returning balance_minor into v_bal;
      insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor) values (v_company, v_adj, 2, v_portf, v_delta, v_bal);
    end if;

    -- Cuotas: la misma fila de cada número se actualiza y las nuevas se añaden; las que quedan
    -- fuera del calendario se SUSTITUYEN (D73-02). Nunca se borra una cuota (0002).
    for i in select (e->>'number')::int n, (e->>'dueDate')::date d, (e->>'amountMinor')::bigint a from jsonb_array_elements(p_schedule) e loop
      update adex.installments set due_date = i.d, amount_minor = i.a, paid_minor = 0, balance_minor = i.a, status = 'pendiente', days_overdue = 0
       where company_id = v_company and sale_id = s.id and number = i.n;
      if not found then
        insert into adex.installments (id, company_id, sale_id, number, due_date, amount_minor, paid_minor, balance_minor, status, days_overdue)
        values (gen_random_uuid()::text, v_company, s.id, i.n, i.d, i.a, 0, i.a, 'pendiente', 0);
      end if;
    end loop;
    update adex.installments set amount_minor = 0, paid_minor = 0, balance_minor = 0, status = 'sustituida', days_overdue = 0
     where company_id = v_company and sale_id = s.id and number > p_count and status <> 'sustituida';

    update adex.sales set sale_value_minor = p_amount, interest_rate = p_rate, interest_value_minor = v_total - p_amount, total_value_minor = v_total,
                          balance_minor = v_total, installments_count = p_count, installment_value_minor = v_value, payment_frequency = p_frequency,
                          payment_days = p_payment_days, start_date = p_start, estimated_end_date = v_end,
                          rectification_count = rectification_count + 1, updated_at = now()
     where company_id = v_company and id = s.id;
    -- Con historia de pagos, las cuotas y el saldo salen del pagado NETO (motor de recaudos).
    if v_pays > 0 then
      perform adex.credit_recompute(v_company, s.id, v_today, coalesce(v_paid_on, v_today));
    end if;

    -- A2 · reclasificación: capital reconocido con las condiciones nuevas − el ya reconocido.
    v_reclass := adex.credit_principal_of(v_paid, p_amount, v_total) - v_known;
    if v_reclass <> 0 then
      v_income := adex.capital_account_for(v_company, 'income', null, v_route);
      perform adex.capital_lock_accounts(v_company, array[v_portf, v_income]);
      v_rop := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, sale_request_id, sale_id, reason, entry_date, actor_membership_id,
                                           actor_identity_id, actor_role, txid)
      values (v_rop, v_company, adex.derived_operation_id(p_operation_id, 'reclassification'), 'PRINCIPAL_RECLASSIFICATION', abs(v_reclass), v_currency,
              v_route, v_orig.admin_membership_id, v_orig.worker_membership_id, v_orig.sale_request_id, s.id,
              left('Reclasificación capital/interés por rectificación: ' || btrim(p_reason), 300), v_today, v_actor, v_identity, v_role, txid_current());
      perform adex.capital_write_legs(v_company, v_rop, array[v_portf, v_income], array[-v_reclass, v_reclass]);
      update adex.sales set principal_reclassified_minor = principal_reclassified_minor + v_reclass, updated_at = now()
       where company_id = v_company and id = s.id;
    end if;

    select * into s from adex.sales where company_id = v_company and id = p_sale;
    v_after := jsonb_build_object('sale', to_jsonb(s), 'installments',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.number), '[]'::jsonb) from adex.installments x where x.company_id = v_company and x.sale_id = s.id),
      'netPaidMinor', v_paid, 'principalRecognizedMinor', v_known + v_reclass);

    insert into adex.credit_rectifications (id, company_id, sale_id, route_id, operation_id, sequence_no, adjustment_operation_id, delta_minor,
                                            payer_account_id, before_state, after_state, reason, evidence, offline_checked,
                                            actor_membership_id, actor_identity_id, actor_role, business_date, txid,
                                            net_paid_minor, principal_reclass_minor, reclass_operation_id)
    values (v_rect, v_company, s.id, v_route, p_operation_id, s.rectification_count, v_adj, v_delta, v_payer, v_before, v_after,
            btrim(p_reason), btrim(p_evidence), true, v_actor, v_identity, v_role, v_today, txid_current(),
            v_paid, v_reclass, v_rop);
    return query select v_rect, v_adj, v_delta;
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('capital_operations_operation_key', 'credit_rectifications_company_id_operation_id_key') then
        perform adex.capital_raise('AX409', 'operation id already used');
      end if;
      if v_cname = 'credit_rectifications_company_id_sale_id_sequence_no_key' then perform adex.capital_raise('AX523', 'the credit changed: reload it'); end if;
      raise;
  end $$;

-- credit_rectify_check: la de 0032_rectification_with_payments.sql.
create or replace function adex.credit_rectify_check(p_sale text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    v_actor   text := adex.ctx_membership();
    v_today   date;
    s         adex.sales;
    v_orig    adex.capital_operations;
    v_payer   text; v_pkind text; v_powner text; v_pseq bigint;
    v_bal     bigint; v_carried bigint;
    v_blockers text[] := array[]::text[];
    v_capital  text[] := array[]::text[];
    v_active int; v_reversed int; v_reversals int; v_reapplied int;
    v_paid bigint; v_known bigint; v_inst_paid bigint; v_last date;
  begin
    if adex.ctx_role() is distinct from 'admin' then perform adex.capital_raise('AX402', 'only an administrator rectifies a disbursed credit'); end if;
    select * into s from adex.sales where company_id = v_company and id = p_sale;
    if not found or not adex.ctx_route_allowed(s.route_id) then perform adex.capital_raise('AX412', 'credit not found'); end if;
    v_today := adex.business_today(v_company);
    if s.status <> 'activa' then v_blockers := array_append(v_blockers, 'CREDIT_NOT_ACTIVE'); end if;

    select count(*) filter (where coalesce(state, 'active') = 'active' and amount_minor > 0),
           count(*) filter (where state = 'reversed'),
           count(*) filter (where state = 'reversal'),
           count(*) filter (where reapplies_payment_id is not null),
           coalesce(sum(amount_minor), 0), coalesce(sum(principal_minor), 0),
           max(payment_date) filter (where coalesce(state, 'active') = 'active' and amount_minor > 0)
      into v_active, v_reversed, v_reversals, v_reapplied, v_paid, v_known, v_last
      from adex.payments where company_id = v_company and sale_id = s.id;
    v_known := v_known + s.principal_reclassified_minor;
    select coalesce(sum(paid_minor), 0) into v_inst_paid from adex.installments where company_id = v_company and sale_id = s.id;
    if exists (select 1 from adex.payments where company_id = v_company and sale_id = s.id and ledger_operation_id is null) then
      v_blockers := array_append(v_blockers, 'LEGACY_PAYMENTS');
    end if;
    if exists (select 1 from adex.payment_adjustment_requests where company_id = v_company and sale_id = s.id and status = 'pending') then
      v_blockers := array_append(v_blockers, 'PAYMENT_ADJUSTMENT_PENDING');
    end if;
    if s.balance_minor <> s.total_value_minor - v_paid or v_inst_paid <> v_paid
       or v_known <> adex.credit_principal_of(v_paid, s.sale_value_minor, s.total_value_minor) then
      v_blockers := array_append(v_blockers, 'LEDGER_INCONSISTENT');
    end if;

    select * into v_orig from adex.capital_operations where company_id = v_company and id = s.ledger_operation_id;
    if found then
      select e.account_id, a.kind, a.membership_id, e.seq into v_payer, v_pkind, v_powner, v_pseq
        from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
       where e.company_id = v_company and e.operation_id = v_orig.id and e.amount_minor < 0;
      -- R74 Base por Ruta (0034): con `route_base` responde la Base de la ruta y su responsable vigente.
      if v_pkind in ('admin', 'route_base') and adex.company_capital_model(v_company) = 'route_base' then
        v_payer := 'acc-' || md5(v_company || '|route_base||' || s.route_id); v_pkind := 'route_base';
        v_powner := adex.route_valid_controller(v_company, s.route_id);
      end if;
      if adex.capital_period_closed(v_company, s.route_id, v_orig.entry_date) or adex.capital_period_closed(v_company, s.route_id, s.disbursement_date)
         or adex.capital_period_closed(v_company, s.route_id, s.start_date) or adex.capital_period_closed(v_company, s.route_id, v_today) then
        v_blockers := array_append(v_blockers, 'PERIOD_CLOSED');
      end if;
      if v_pkind = 'custody' and exists (select 1 from adex.custody_settlements cs where cs.company_id = v_company and cs.custody_account_id = v_payer
                                           and cs.status = 'cerrada' and cs.to_seq >= v_pseq) then
        v_capital := array_append(v_capital, 'DISBURSEMENT_SETTLED');
      end if;
      if v_pkind = 'custody' and not adex.capital_custodian_ok(v_company, s.route_id, v_powner) then v_capital := array_append(v_capital, 'CUSTODIAN_CHANGED'); end if;
      if v_pkind = 'admin' and v_powner is distinct from v_actor then v_capital := array_append(v_capital, 'POOL_OF_ANOTHER_ADMIN'); end if;
      if v_pkind = 'route_base' and v_powner is distinct from v_actor then v_capital := array_append(v_capital, 'NOT_ROUTE_CONTROLLER'); end if;
      if v_pkind = 'route_base' and adex.route_in_handover(v_company, s.route_id) then v_capital := array_append(v_capital, 'ROUTE_IN_HANDOVER'); end if;
      select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = v_company and id = v_payer;
    else
      v_blockers := array_append(v_blockers, 'CREDIT_NOT_LEDGERED');
    end if;
    return jsonb_build_object('blockers', to_jsonb(v_blockers), 'capitalBlockers', to_jsonb(v_capital), 'payerKind', v_pkind,
      'maxIncreaseMinor', case when cardinality(v_capital) > 0 then 0 else greatest(coalesce(v_bal, 0) - coalesce(v_carried, 0), 0) end,
      'rectificationCount', s.rectification_count,
      'payments', jsonb_build_object('active', v_active, 'reversed', v_reversed, 'reversals', v_reversals, 'reapplied', v_reapplied,
                                     'netPaidMinor', v_paid, 'principalRecognizedMinor', v_known, 'interestRecognizedMinor', v_paid - v_known,
                                     'lastPaymentDate', v_last),
      -- El total corregido no puede quedar por debajo de lo ya pagado.
      'minTotalMinor', v_paid);
  end $$;

-- route_period_figures: la de 0032_rectification_with_payments.sql.
create or replace function adex.route_period_figures(p_company text, p_route text, p_from date, p_to date) returns jsonb
  language plpgsql stable
  as $$
  declare
    v_workers jsonb;
    v_custody jsonb;
    v_pool    jsonb;
    v_credit  jsonb;
    v_setl    jsonb;
    v_ops     jsonb;
    v_base    jsonb;
  begin
    with legs as (
      select e.amount_minor amt, a.membership_id mid, o.entry_date d, coalesce(o.reverses_kind, o.kind) b
        from adex.capital_entries e
        join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
        join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
       where e.company_id = p_company and a.kind = 'custody' and a.route_id = p_route and o.entry_date <= p_to
    ), w as (
      select mid,
             coalesce(sum(amt) filter (where d < p_from), 0)::bigint opening,
             coalesce(sum(amt) filter (where d >= p_from and b = 'WORKER_DELIVERY'), 0)::bigint deliveries,
             coalesce(sum(amt) filter (where d >= p_from and b in ('WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and amt > 0), 0)::bigint t_in,
             coalesce(-sum(amt) filter (where d >= p_from and b in ('WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and amt < 0), 0)::bigint t_out,
             coalesce(-sum(amt) filter (where d >= p_from and b = 'WORKER_RETURN'), 0)::bigint partial_returns,
             coalesce(-sum(amt) filter (where d >= p_from and b = 'SETTLEMENT_RETURN'), 0)::bigint settlement_returns,
             coalesce(sum(amt) filter (where d >= p_from and b = 'COLLECTION'), 0)::bigint collections,
             coalesce(-sum(amt) filter (where d >= p_from and b in ('LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT')), 0)::bigint disbursements,
             coalesce(-sum(amt) filter (where d >= p_from and b = 'WORKER_EXPENSE'), 0)::bigint expenses,
             coalesce(sum(amt) filter (where d >= p_from and b not in ('WORKER_DELIVERY', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'WORKER_RETURN',
                                                                     'SETTLEMENT_RETURN', 'COLLECTION', 'LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT', 'WORKER_EXPENSE')), 0)::bigint other,
             coalesce(sum(amt), 0)::bigint closing
        from legs group by mid
    )
    select coalesce(jsonb_agg(jsonb_build_object('workerId', w.mid, 'name', m.display_name, 'role', m.role,
             'openingMinor', w.opening, 'deliveriesMinor', w.deliveries, 'transfersInMinor', w.t_in, 'transfersOutMinor', w.t_out,
             'partialReturnsMinor', w.partial_returns, 'settlementReturnsMinor', w.settlement_returns, 'collectionsMinor', w.collections,
             'disbursementsMinor', w.disbursements, 'workerExpensesMinor', w.expenses, 'otherMinor', w.other, 'closingMinor', w.closing)
             order by m.display_name, w.mid), '[]'::jsonb),
           jsonb_build_object('openingMinor', coalesce(sum(w.opening), 0), 'deliveriesMinor', coalesce(sum(w.deliveries), 0),
             'transfersInMinor', coalesce(sum(w.t_in), 0), 'transfersOutMinor', coalesce(sum(w.t_out), 0),
             'partialReturnsMinor', coalesce(sum(w.partial_returns), 0), 'settlementReturnsMinor', coalesce(sum(w.settlement_returns), 0),
             'collectionsMinor', coalesce(sum(w.collections), 0), 'disbursementsMinor', coalesce(sum(w.disbursements), 0),
             'workerExpensesMinor', coalesce(sum(w.expenses), 0), 'otherMinor', coalesce(sum(w.other), 0), 'closingMinor', coalesce(sum(w.closing), 0))
      into v_workers, v_custody
      from w join adex.memberships m on m.company_id = p_company and m.id = w.mid;

    -- Lado de la bolsa, cartera, interés, gastos y control, de lo atribuido a la ruta.
    with legs as (
      select e.amount_minor amt, a.kind ak, coalesce(o.reverses_kind, o.kind) b
        from adex.capital_entries e
        join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
        join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
       where e.company_id = p_company and o.entry_date between p_from and p_to
         and ((a.kind = 'admin' and o.route_id = p_route and o.to_route_id is null)
              or (a.kind in ('portfolio', 'income', 'expense', 'suspense') and a.route_id = p_route))
    )
    select jsonb_build_object(
             'collectionsReceivedMinor', coalesce(sum(amt) filter (where ak = 'admin' and b = 'COLLECTION'), 0),
             'deliveredToWorkersMinor', coalesce(-sum(amt) filter (where ak = 'admin' and b = 'WORKER_DELIVERY'), 0),
             'returnsReceivedMinor', coalesce(sum(amt) filter (where ak = 'admin' and b in ('WORKER_RETURN', 'SETTLEMENT_RETURN')), 0),
             'routeExpensesMinor', coalesce(-sum(amt) filter (where ak = 'admin' and b = 'ROUTE_EXPENSE'), 0),
             'disbursedFromPoolMinor', coalesce(-sum(amt) filter (where ak = 'admin' and b in ('LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT')), 0),
             'partnerContributionsMinor', coalesce(sum(amt) filter (where ak = 'admin' and b = 'PARTNER_CONTRIBUTION'), 0),
             'surplusHeldMinor', coalesce(sum(amt) filter (where ak = 'suspense'), 0)),
           jsonb_build_object(
             'principalDisbursedMinor', coalesce(sum(amt) filter (where ak = 'portfolio' and b in ('LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT')), 0),
             'principalCollectedMinor', coalesce(-sum(amt) filter (where ak = 'portfolio' and b in ('COLLECTION', 'PRINCIPAL_RECLASSIFICATION')), 0),
             'principalReclassifiedMinor', coalesce(-sum(amt) filter (where ak = 'portfolio' and b = 'PRINCIPAL_RECLASSIFICATION'), 0),
             'interestCollectedMinor', coalesce(-sum(amt) filter (where ak = 'income'), 0),
             'expensesMinor', coalesce(sum(amt) filter (where ak = 'expense'), 0))
      into v_pool, v_credit from legs;

    select jsonb_build_object('count', count(*), 'deliveredMinor', coalesce(sum(delivered_minor), 0),
             'returnedToPoolMinor', coalesce(sum(returned_to_pool_minor), 0), 'shortageMinor', coalesce(sum(shortage_minor), 0),
             'surplusMinor', coalesce(sum(surplus_minor), 0),
             'items', coalesce(jsonb_agg(jsonb_build_object('id', id, 'workerId', worker_membership_id, 'version', version, 'status', status,
                        'businessDate', business_date, 'expectedPositionMinor', expected_position_minor, 'deliveredMinor', delivered_minor,
                        'shortageMinor', shortage_minor, 'surplusMinor', surplus_minor) order by closed_at, id), '[]'::jsonb))
      into v_setl
      from adex.custody_settlements where company_id = p_company and route_id = p_route and business_date between p_from and p_to;

    select jsonb_build_object('count', count(*), 'lastSeq', coalesce(max(last_seq), 0),
             'hash', encode(sha256(convert_to(coalesce(string_agg(id, ',' order by id), ''), 'UTF8')), 'hex'))
      into v_ops
      from (select o.id, max(e.seq) last_seq
              from adex.capital_operations o join adex.capital_entries e on e.company_id = o.company_id and e.operation_id = o.id
              join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
             where o.company_id = p_company and o.entry_date between p_from and p_to
               and (o.route_id = p_route or o.to_route_id = p_route or a.route_id = p_route)
             group by o.id) q;

    -- R74 Base por Ruta (0034): Base de la ruta (route_base) y su contrapartida (route_funding).
    with legs as (
      select e.amount_minor amt, a.kind ak, o.entry_date d, coalesce(o.reverses_kind, o.kind) b
        from adex.capital_entries e
        join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
        join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
       where e.company_id = p_company and a.kind in ('route_base', 'route_funding') and a.route_id = p_route and o.entry_date <= p_to
    )
    select jsonb_build_object(
             'openingMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d < p_from), 0),
             'injectionsMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'ROUTE_BASE_INJECTION'), 0),
             'withdrawalsMinor', coalesce(-sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'ROUTE_BASE_WITHDRAWAL'), 0),
             'transfersInMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'ROUTE_TRANSFER' and amt > 0), 0),
             'transfersOutMinor', coalesce(-sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'ROUTE_TRANSFER' and amt < 0), 0),
             'unassignedAssignedMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'LEGACY_POOL_TO_ROUTE'), 0),
             'deliveredToWorkersMinor', coalesce(-sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'WORKER_DELIVERY'), 0),
             'returnsReceivedMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b in ('WORKER_RETURN', 'SETTLEMENT_RETURN')), 0),
             'reassignmentsNetMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'ROUTE_REASSIGNMENT'), 0),
             'collectionsReceivedMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'COLLECTION'), 0),
             'disbursedMinor', coalesce(-sum(amt) filter (where ak = 'route_base' and d >= p_from and b in ('LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT')), 0),
             'routeExpensesMinor', coalesce(-sum(amt) filter (where ak = 'route_base' and d >= p_from and b = 'ROUTE_EXPENSE'), 0),
             'otherMinor', coalesce(sum(amt) filter (where ak = 'route_base' and d >= p_from and b not in ('ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL',
                              'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE', 'WORKER_DELIVERY', 'WORKER_RETURN', 'SETTLEMENT_RETURN', 'ROUTE_REASSIGNMENT', 'COLLECTION',
                              'LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT', 'ROUTE_EXPENSE')), 0),
             'closingMinor', coalesce(sum(amt) filter (where ak = 'route_base'), 0),
             'contributionsNetMinor', coalesce(-sum(amt) filter (where ak = 'route_funding'), 0))
      into v_base from legs;

    return jsonb_build_object('routeId', p_route, 'from', p_from, 'to', p_to, 'custody', v_custody, 'workers', v_workers,
                              'pool', v_pool, 'credit', v_credit, 'settlements', v_setl, 'operations', v_ops, 'base', v_base);
  end $$;

-- capital_ledger_checks: la de 0019_reconciliation_ledger_checks.sql.
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


-- ============================================================
-- 5. Comandos nuevos de la Base
-- ============================================================
-- Inyección (route_funding → route_base), retiro (route_base → route_funding, tope el saldo),
-- transferencia entre rutas (route_base(R1) → route_base(R2), una operación con `route_id` y
-- `to_route_id`) y reparto de «sin asignar» (bolsa del Administrador → route_base). Siempre el
-- Administrador responsable VIGENTE de la ruta (de ORIGEN en la transferencia), releído bajo bloqueo.
-- Solo se anula la inyección (si la Base aún tiene ese dinero).
-- Gancho O11: si el propietario quisiera un estado de tránsito/confirmación para las transferencias,
-- se haría como `admin_transfer_*` (0023): HOLD route_base(R1) → cuenta de tránsito por ruta, y
-- APPLY/RELEASE por el responsable del destino. Hoy NO existe: la transferencia es inmediata.
create function adex.route_base_post(
  p_operation_id uuid,
  p_kind         text,
  p_amount       bigint,
  p_reason       text,
  p_route        text,
  p_to_route     text default null,
  p_reverses     text default null
) returns adex.capital_operations
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company  text := adex.ctx_company();
    v_actor    text := adex.ctx_membership();
    v_role     text := adex.ctx_role();
    v_identity uuid := adex.ctx_identity();
    v_reversal boolean := p_kind = 'REVERSAL';
    v_kind     text := p_kind;
    v_amount   bigint := p_amount;
    v_route    text := p_route;
    v_to       text := p_to_route;
    v_orig     adex.capital_operations;
    v_ctrl     text;
    v_ctrl2    text;
    v_currency char(3);
    v_date     date;
    v_accts    text[];
    v_amts     bigint[];
    v_op       adex.capital_operations;
    v_bal      bigint;
    v_i        int;
    v_cname    text;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'capital commands run only through the company API'); end if;
    if v_role is null or v_company is null or v_identity is null or v_actor is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    -- E2: el SuperAdmin supervisa; la Base la mueve el Administrador responsable de la ruta.
    if v_role <> 'admin' then perform adex.capital_raise('AX402', 'only the responsible administrator moves the base of a route'); end if;
    if p_operation_id is null or p_kind is null then perform adex.capital_raise('AX411', 'operation id and kind are required'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    if adex.company_capital_model(v_company) is distinct from 'route_base' then
      perform adex.capital_raise('AX428', 'the route base model is not active in this company');
    end if;
    select c.currency_code, adex.business_today(c.id) into v_currency, v_date from adex.companies c where c.id = v_company;
    if exists (select 1 from adex.capital_operations where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;

    if v_reversal then
      if p_reverses is null then perform adex.capital_raise('AX411', 'reversal needs the original operation'); end if;
      perform pg_advisory_xact_lock(adex.lock_key('capital-reversal', v_company || ':' || p_reverses));
      select * into v_orig from adex.capital_operations where company_id = v_company and id = p_reverses;
      if not found then perform adex.capital_raise('AX412', 'operation not found'); end if;
      if v_orig.kind = 'ROUTE_BASE_WITHDRAWAL' then perform adex.capital_raise('AX404', 'a base withdrawal is corrected with a new injection'); end if;
      if v_orig.kind = 'ROUTE_TRANSFER' then perform adex.capital_raise('AX404', 'a transfer is corrected with a transfer back by the destination responsible'); end if;
      if v_orig.kind = 'LEGACY_POOL_TO_ROUTE' then perform adex.capital_raise('AX404', 'an assignment of unassigned capital cannot be reversed'); end if;
      if v_orig.kind <> 'ROUTE_BASE_INJECTION' then perform adex.capital_raise('AX404', 'not a route base operation'); end if;
      if exists (select 1 from adex.capital_operations where company_id = v_company and reverses_operation_id = v_orig.id) then
        perform adex.capital_raise('AX405', 'operation already reversed');
      end if;
      v_kind := v_orig.kind; v_amount := v_orig.amount_minor; v_route := v_orig.route_id; v_to := null;
    end if;

    if v_amount is null or v_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
    if v_kind not in ('ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE') or v_route is null
       or (v_kind = 'ROUTE_TRANSFER') <> (v_to is not null) or v_to = v_route then
      perform adex.capital_raise('AX411', 'invalid fields for this operation kind');
    end if;
    if not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'route not found'); end if;

    -- Rutas (orden de id) y responsables releídos bajo bloqueo (R5).
    perform 1 from adex.routes where company_id = v_company and id in (v_route, v_to) order by id for update;
    if not exists (select 1 from adex.routes where company_id = v_company and id = v_route) then perform adex.capital_raise('AX412', 'route not found'); end if;
    v_ctrl := adex.route_valid_controller(v_company, v_route);
    if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the route capital controller moves its base'); end if;
    if adex.capital_period_closed(v_company, v_route, v_date) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;
    if adex.route_in_handover(v_company, v_route) then
      perform adex.capital_raise('AX423', 'the route is being handed over to a new responsible: confirm the count first');
    end if;
    if not v_reversal and v_kind in ('ROUTE_BASE_INJECTION', 'LEGACY_POOL_TO_ROUTE') and not adex.route_operational(v_company, v_route) then
      perform adex.capital_raise('AX301', 'route is not operational');
    end if;
    if v_kind = 'ROUTE_TRANSFER' then
      if not exists (select 1 from adex.routes where company_id = v_company and id = v_to) then perform adex.capital_raise('AX412', 'destination route not found'); end if;
      v_ctrl2 := adex.route_valid_controller(v_company, v_to);
      if v_ctrl2 is null then perform adex.capital_raise('AX408', 'the destination route has no valid capital controller'); end if;
      if not adex.route_operational(v_company, v_to) then perform adex.capital_raise('AX301', 'destination route is not operational'); end if;
      if adex.capital_period_closed(v_company, v_to, v_date) then perform adex.capital_raise('AX407', 'the period of the destination route is closed'); end if;
    end if;

    case v_kind
      when 'ROUTE_BASE_INJECTION'  then v_accts := array[adex.capital_account_for(v_company, 'route_funding', null, v_route), adex.capital_account_for(v_company, 'route_base', null, v_route)];
      when 'ROUTE_BASE_WITHDRAWAL' then v_accts := array[adex.capital_account_for(v_company, 'route_base', null, v_route), adex.capital_account_for(v_company, 'route_funding', null, v_route)];
      when 'ROUTE_TRANSFER'        then v_accts := array[adex.capital_account_for(v_company, 'route_base', null, v_route), adex.capital_account_for(v_company, 'route_base', null, v_to)];
      else
        -- O3: el Administrador confirma el reparto de SU saldo «sin asignar» a una ruta de la que es responsable.
        if not exists (select 1 from adex.capital_accounts where company_id = v_company and kind = 'admin' and membership_id = v_actor) then
          perform adex.capital_raise('AX401', 'insufficient funds');
        end if;
        v_accts := array[adex.capital_account_for(v_company, 'admin', v_actor, null), adex.capital_account_for(v_company, 'route_base', null, v_route)];
    end case;
    if v_reversal then v_accts := array[v_accts[2], v_accts[1]]; end if;
    v_amts := array[-v_amount, v_amount];
    perform adex.capital_lock_accounts(v_company, v_accts);

    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, to_route_id,
                                         admin_membership_id, counterpart_membership_id, reverses_operation_id, reverses_kind, reason, entry_date,
                                         actor_membership_id, actor_identity_id, actor_role, txid)
    values (gen_random_uuid()::text, v_company, p_operation_id, p_kind, v_amount, v_currency, v_route, v_to,
            v_ctrl, v_ctrl2, v_orig.id, case when v_reversal then v_orig.kind end, btrim(p_reason), v_date, v_actor, v_identity, v_role, txid_current())
    returning * into v_op;
    for v_i in 1 .. 2 loop
      update adex.capital_accounts set balance_minor = balance_minor + v_amts[v_i], version = version + 1, updated_at = now()
       where company_id = v_company and id = v_accts[v_i]
      returning balance_minor into v_bal;
      insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor)
      values (v_company, v_op.id, v_i, v_accts[v_i], v_amts[v_i], v_bal);
    end loop;
    return v_op;
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      -- Sin cifras: nunca revela el saldo de otra cuenta.
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_reversal_key' then perform adex.capital_raise('AX405', 'operation already reversed'); end if;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;
revoke all on function adex.route_base_post(uuid, text, bigint, text, text, text, text) from public;
grant execute on function adex.route_base_post(uuid, text, bigint, text, text, text, text) to adex_api;

-- Rutas destino de una transferencia (O11): las rutas operativas de la empresa con responsable válido,
-- también las de otro Administrador (solo nombre, código y responsable; nunca saldos).
create function adex.route_transfer_destinations() returns table (route_id text, name text, code text, controller_id text, controller_name text, in_scope boolean)
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare v_company text := adex.ctx_company();
  begin
    if session_user <> 'adex_api' or v_company is null or not adex.ctx_membership_active() or adex.ctx_role() is distinct from 'admin' then
      perform adex.capital_raise('42501', 'no valid active context');
    end if;
    return query
      select r.id::text, r.name, r.code, r.capital_controller_membership_id::text, m.display_name, adex.ctx_route_allowed(r.id)
        from adex.routes r join adex.memberships m on m.company_id = r.company_id and m.id = r.capital_controller_membership_id
       where r.company_id = v_company and adex.route_operational(v_company, r.id) and adex.route_valid_controller(v_company, r.id) is not null
       order by r.name, r.id;
  end $$;
revoke all on function adex.route_transfer_destinations() from public;
grant execute on function adex.route_transfer_destinations() to adex_api;

-- ============================================================
-- 6. Entrega controlada (O5): confirmación del conteo
-- ============================================================
create function adex.route_handover_confirm(p_operation_id uuid, p_route text, p_counted bigint, p_expected_seen bigint, p_note text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x       adex.money_ctx;
    h       adex.route_handover_records;
    v_ctrl  text;
    v_acc   text;
    v_base  bigint;
    v_cust  bigint;
    v_diff  bigint;
    v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  begin
    x := adex.money_context(p_operation_id);
    if x.role <> 'admin' then perform adex.capital_raise('AX402', 'only the new responsible administrator confirms the count'); end if;
    if p_route is null or p_counted is null or p_counted < 0 or p_expected_seen is null then
      perform adex.capital_raise('AX411', 'route, counted amount (>= 0) and the expected amount seen are required');
    end if;
    if v_note is not null and length(v_note) > 500 then perform adex.capital_raise('AX411', 'note is too long'); end if;
    if exists (select 1 from adex.route_handover_records where company_id = x.company and confirm_operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    if not adex.ctx_route_allowed(p_route) or not exists (select 1 from adex.routes where company_id = x.company and id = p_route) then
      perform adex.capital_raise('AX412', 'route not found');
    end if;
    perform 1 from adex.routes where company_id = x.company and id = p_route for update;
    select * into h from adex.route_handover_records where company_id = x.company and route_id = p_route and status = 'pendiente' for update;
    if not found then perform adex.capital_raise('AX427', 'the route has no pending hand-over'); end if;
    v_ctrl := adex.route_valid_controller(x.company, p_route);
    if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    if x.actor is distinct from v_ctrl or x.actor is distinct from h.to_membership_id then
      perform adex.capital_raise('AX402', 'only the new responsible administrator confirms the count');
    end if;
    v_acc := adex.capital_account_for(x.company, 'route_base', null, p_route);
    perform adex.capital_lock_accounts(x.company, array[v_acc]);
    select balance_minor into v_base from adex.capital_accounts where company_id = x.company and id = v_acc;
    select coalesce(sum(balance_minor), 0) into v_cust from adex.capital_accounts where company_id = x.company and route_id = p_route and kind = 'custody';
    if p_expected_seen <> v_base then perform adex.capital_raise('AX802', 'the figures changed since the preview'); end if;
    v_diff := p_counted - v_base;
    if v_diff <> 0 and length(coalesce(v_note, '')) < 10 then perform adex.capital_raise('AX803', 'a difference needs a note (10+ characters)'); end if;
    -- El acta registra la diferencia; el libro NO se toca (sin movimientos ficticios).
    update adex.route_handover_records
       set status = 'confirmada', expected_base_minor = v_base, counted_minor = p_counted, difference_minor = v_diff, note = v_note,
           confirmed_at = now(), confirmed_by_membership_id = x.actor, confirmed_by_identity_id = x.identity, confirm_operation_id = p_operation_id
     where company_id = x.company and id = h.id;
    update adex.routes set handover_state = 'normal', updated_at = now() where company_id = x.company and id = p_route;
    return jsonb_build_object('handoverId', h.id, 'routeId', p_route, 'fromId', h.from_membership_id, 'toId', h.to_membership_id,
      'baseAtStartMinor', h.base_at_start_minor, 'expectedBaseMinor', v_base, 'countedMinor', p_counted, 'differenceMinor', v_diff,
      'custodyMinor', v_cust, 'note', v_note, 'confirmedAt', now(), 'businessDate', x.today,
      'result', case when v_diff = 0 then 'exacto' when v_diff < 0 then 'faltante' else 'sobrante' end);
  exception
    when unique_violation then
      if sqlerrm like '%route_handover_confirm_key%' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;
revoke all on function adex.route_handover_confirm(uuid, text, bigint, bigint, text) from public;
grant execute on function adex.route_handover_confirm(uuid, text, bigint, bigint, text) to adex_api;

-- ============================================================
-- 7. Activación del modelo (O6): requisitos y transición
-- ============================================================
create function adex.capital_model_prerequisites() returns jsonb
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
revoke all on function adex.capital_model_prerequisites() from public;
grant execute on function adex.capital_model_prerequisites() to adex_api;

create function adex.capital_model_transition(p_operation_id uuid, p_target text, p_evidence text, p_backup_reference text, p_company_balance_note text)
  returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    v_actor   text := adex.ctx_membership();
    v_identity uuid := adex.ctx_identity();
    v_from    text;
    v_pre     jsonb := '{}'::jsonb;
    v_failed  text[];
    v_note    text := nullif(btrim(coalesce(p_company_balance_note, '')), '');
    v_backup  text := nullif(btrim(coalesce(p_backup_reference, '')), '');
    v_since   timestamptz;
    v_id      text := gen_random_uuid()::text;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'capital commands run only through the company API'); end if;
    if v_company is null or v_actor is null or v_identity is null or not adex.ctx_membership_active() or adex.ctx_role() is distinct from 'superadmin' then
      perform adex.capital_raise('42501', 'the capital model is authorized by the SuperAdmin');
    end if;
    if p_operation_id is null or p_target is null or p_target not in ('admin_pool', 'migrating', 'route_base') then
      perform adex.capital_raise('AX411', 'operation id and a valid target model are required');
    end if;
    if p_evidence is null or length(btrim(p_evidence)) < 10 or length(p_evidence) > 1000 then perform adex.capital_raise('AX411', 'evidence is required (10+ characters)'); end if;
    if exists (select 1 from adex.capital_model_activations where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    -- Como una revocación (REVOKE-004): espera a que terminen los comandos en curso de la empresa y
    -- detiene los nuevos hasta el COMMIT; los requisitos se leen con todo lo ya confirmado.
    perform pg_advisory_xact_lock(adex.lock_key('company', v_company));
    select capital_model into v_from from adex.companies where id = v_company for update;
    if v_from = p_target then perform adex.capital_raise('AX411', 'the company already uses that model'); end if;
    if v_from = 'route_base' then perform adex.capital_raise('AX421', 'the route base model cannot be deactivated'); end if;
    if p_target = 'admin_pool' and v_from <> 'migrating' then perform adex.capital_raise('AX411', 'invalid transition'); end if;
    if p_target = 'route_base' then
      if v_backup is null or length(v_backup) > 300 then perform adex.capital_raise('AX411', 'a verified backup reference is required'); end if;
      if v_note is not null and length(v_note) < 10 then perform adex.capital_raise('AX411', 'the company balance note needs 10+ characters'); end if;
      v_pre := adex.capital_model_prerequisites();
      select coalesce(array_agg(c->>'name'), '{}') into v_failed from jsonb_array_elements(v_pre->'checks') c
       where not (c->>'ok')::boolean and not (c->>'name' = 'company-account-zero' and v_note is not null);
      if cardinality(v_failed) > 0 then
        perform adex.capital_raise('AX425', 'prerequisites not met: ' || array_to_string(v_failed, ', '));
      end if;
      v_since := now();
    end if;
    update adex.companies set capital_model = p_target, route_base_since = v_since, updated_at = now() where id = v_company;
    insert into adex.capital_model_activations (id, company_id, operation_id, from_model, to_model, evidence, backup_reference, company_balance_note,
                                                prerequisites, unassigned_pools, actor_membership_id, actor_identity_id, actor_role, txid)
    values (v_id, v_company, p_operation_id, v_from, p_target, btrim(p_evidence), v_backup, case when p_target = 'route_base' then v_note end,
            v_pre, coalesce(v_pre->'unassignedPools', '[]'::jsonb), v_actor, v_identity, 'superadmin', txid_current());
    return jsonb_build_object('activationId', v_id, 'fromModel', v_from, 'model', p_target, 'routeBaseSince', v_since,
      'prerequisites', v_pre, 'unassignedPools', coalesce(v_pre->'unassignedPools', '[]'::jsonb));
  end $$;
revoke all on function adex.capital_model_transition(uuid, text, text, text, text) from public;
grant execute on function adex.capital_model_transition(uuid, text, text, text, text) to adex_api;

-- ============================================================
-- 8. Panel por ruta / Caja principal consolidada (O8, O9)
-- ============================================================
-- SECURITY INVOKER: cada cifra sale de lo que la RLS deja ver al contexto (SuperAdmin: todas las
-- rutas; Administrador y Supervisor: las de su alcance). No es una cuenta ni mueve nada.
--   resultado operativo básico = interés efectivamente cobrado − gastos operativos atribuibles a la
--     ruta (operativo + otro; `bien_duradero` aparte). No es ganancia retirable (O10).
--   flujo operativo = recaudos − desembolsos − todos los gastos de la ruta (puede ser negativo por
--     crecimiento sin ser pérdida; una inyección nunca es pérdida).
--   necesidad de capital = máx(0, solicitudes aprobadas sin desembolsar − (Base + custodia entregable)),
--     solo con `route_base` (con bolsas, la liquidez no es de la ruta).
create function adex.route_panel(p_from date, p_to date) returns jsonb
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
revoke all on function adex.route_panel(date, date) from public;
grant execute on function adex.route_panel(date, date) to adex_api;
