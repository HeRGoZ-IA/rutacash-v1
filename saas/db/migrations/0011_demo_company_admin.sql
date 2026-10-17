-- ============================================================
-- ADEX SaaS · ADEX Online v1 · 0011 · Administración de la Empresa Demo
-- ------------------------------------------------------------
-- La Empresa Demo es una empresa NORMAL a efectos técnicos (mismo esquema, mismas
-- reglas, mismo motor financiero) con datos 100 % ficticios. Lo único propio es su
-- CICLO DE VIDA, que se administra aquí, en un plano separado:
--
--   · Esquema `adex_demo` y rol `adex_demo` (login, NOINHERIT, sin privilegios de
--     tabla): solo ejecuta las funciones de este archivo. Ni `adex_api` ni
--     `adex_control` pueden llamarlas.
--   · Autoridad específica: `adex_demo.operators` (identidades habilitadas para
--     administrar demos). NO es el Owner ni una membresía: no da acceso a ninguna
--     empresa ni a sus finanzas. La alta de operadores la hace el administrador de la
--     base (script), nunca la API.
--
-- Decisión de diseño (documentada en ADEX_ONLINE_V1_RESULTADOS.md): el libro
-- financiero es inmutable también para el administrador de la base (0002, 0009,
-- 0010). Por eso REINICIAR = RECREAR con una identidad interna NUEVA y RETIRAR la
-- anterior; ELIMINAR = RETIRAR. Retirar una empresa Demo:
--   · la suspende (REVOKE-004: el bloqueo exclusivo de empresa espera a las
--     operaciones en curso; las siguientes reciben COMPANY_BLOCKED);
--   · la marca `retired_at` de forma IRREVERSIBLE (ningún plano puede reactivarla);
--   · la oculta del selector de contexto;
--   · desactiva sus identidades sintéticas.
-- Sus filas financieras quedan intactas, cuadradas e inaccesibles. No existe borrado
-- físico de datos financieros, ni para demos ni para empresas normales.
--
-- La auditoría administrativa (`adex_demo.events`) vive FUERA de los datos de la
-- empresa: sobrevive a reinicios, retiradas y recreaciones. Solo se añade.
-- ============================================================

-- ---------- Marca Demo en la empresa (inmutable) ----------
alter table adex.companies
  add column is_demo    boolean not null default false,
  add column retired_at timestamptz,
  add constraint companies_retired_only_demo check (retired_at is null or (is_demo and status = 'suspendida'));

-- `is_demo` se fija al crear y nunca cambia. Estado y retirada de una Demo solo los
-- cambia el ciclo de vida de `adex_demo` (marca de transacción); una Demo retirada
-- es definitiva (ni el plano Owner ni la API pueden reactivarla).
create function adex.guard_company_demo() returns trigger
  language plpgsql
  as $$
  declare
    lifecycle boolean := coalesce(current_setting('adex_demo.lifecycle', true), '') = 'on';
  begin
    if tg_op = 'INSERT' then
      if (new.is_demo or new.retired_at is not null) and not lifecycle then
        raise exception 'adex: demo companies are created only by the demo lifecycle' using errcode = '42501';
      end if;
      return new;
    end if;
    if new.is_demo is distinct from old.is_demo then
      raise exception 'adex: is_demo is immutable' using errcode = '42501';
    end if;
    if old.retired_at is not null
       and (new.status, new.retired_at, new.expires_on) is distinct from (old.status, old.retired_at, old.expires_on) then
      raise exception 'adex: a retired demo company is final' using errcode = '42501';
    end if;
    if old.is_demo and (new.status, new.retired_at, new.expires_on) is distinct from (old.status, old.retired_at, old.expires_on)
       and not lifecycle then
      raise exception 'adex: demo company status changes only through the demo lifecycle' using errcode = '42501';
    end if;
    return new;
  end $$;
create trigger companies_demo_guard before insert or update on adex.companies
  for each row execute function adex.guard_company_demo();

-- Una empresa Demo retirada desaparece del selector de contexto (0003 la dejaba ver
-- a quien tuviera membresía). La API la rechaza igualmente: está suspendida.
drop policy companies_ctx on adex.companies;
create policy companies_ctx on adex.companies for select to adex_api
  using (((id = adex.ctx_company() and adex.ctx_membership_active()) or adex.ctx_identity_member_of(id))
         and retired_at is null);

-- El ciclo de vida reasigna el ocupante de los puestos de una Demo (nunca de otra empresa).
create policy demo_membership_update on adex.memberships for update to adex_owner
  using (exists (select 1 from adex.companies c where c.id = company_id and c.is_demo and c.retired_at is null))
  with check (exists (select 1 from adex.companies c where c.id = company_id and c.is_demo and c.retired_at is null));

-- ---------- Registro del plano Demo ----------
create table adex_demo.operators (
  identity_id uuid primary key references adex.identities(id),
  status      text not null default 'activo' check (status in ('activo', 'inactivo')),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Un «hueco» Demo (p. ej. `principal`) apunta a la Demo vigente. Máquina de estados:
--   empty → provisioning → active → (resetting → active) | (deleting → empty)
create table adex_demo.slots (
  slot               text primary key check (slot ~ '^[a-z][a-z0-9-]{1,30}$'),
  state              text not null check (state in ('empty', 'provisioning', 'active', 'resetting')),
  company_id         adex.eid references adex.companies(id),
  pending_company_id adex.eid references adex.companies(id),
  updated_at         timestamptz not null default now(),
  check ((state = 'empty') = (company_id is null)),
  check ((state = 'resetting') = (pending_company_id is not null))
);

create table adex_demo.companies (
  company_id       adex.eid primary key references adex.companies(id),
  slot             text not null references adex_demo.slots(slot),
  state            text not null check (state in ('provisioning', 'active', 'frozen', 'retired', 'failed')),
  scenario_version text not null,
  created_at       timestamptz not null default now(),
  created_by       uuid not null,
  activated_at     timestamptz,
  retired_at       timestamptz,
  retired_reason   text
);

-- Puestos del escenario. `assignable`: puede ocuparlo un participante invitado; si no,
-- lo ocupa siempre una identidad SINTÉTICA (sin cuenta de acceso), que es la única con
-- la que el aprovisionamiento ejecuta el escenario.
create table adex_demo.seats (
  company_id              adex.eid not null references adex_demo.companies(company_id),
  seat                    text not null check (seat ~ '^[a-z][a-z0-9-]{1,40}$'),
  role                    text not null,
  membership_id           adex.eid not null,
  identity_id             uuid not null references adex.identities(id),
  placeholder_identity_id uuid not null references adex.identities(id),
  synthetic               boolean not null,
  assignable              boolean not null,
  primary key (company_id, seat),
  unique (company_id, membership_id),
  foreign key (company_id, membership_id) references adex.memberships(company_id, id),
  check (synthetic = (identity_id = placeholder_identity_id)),
  check (assignable or synthetic)
);

-- Configuración persistente: quién ocupa cada puesto asignable en las Demos que se
-- creen o recreen en este hueco. Las identidades son globales y nunca se borran.
create table adex_demo.participants (
  slot         text not null references adex_demo.slots(slot),
  seat         text not null check (seat ~ '^[a-z][a-z0-9-]{1,40}$'),
  identity_id  uuid not null references adex.identities(id),
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  added_at     timestamptz not null default now(),
  added_by     uuid not null,
  primary key (slot, seat)
);

-- Auditoría administrativa, EXTERNA a los datos de la empresa: sin FK a la empresa
-- (sobrevive a cualquier retirada) y solo se añade.
create table adex_demo.events (
  id                   bigint generated always as identity primary key,
  at                   timestamptz not null default now(),
  slot                 text not null,
  company_id           text,
  operator_identity_id uuid,
  action               text not null check (action ~ '^[A-Z_]{3,40}$'),
  outcome              text not null check (outcome in ('started', 'succeeded', 'failed', 'rejected')),
  detail               jsonb
);
create trigger events_append_only before update or delete on adex_demo.events
  for each statement execute function adex.reject_mutation();
create trigger events_no_truncate before truncate on adex_demo.events
  for each statement execute function adex.reject_mutation();

do $$
declare t text;
begin
  foreach t in array array['operators', 'slots', 'companies', 'seats', 'participants', 'events'] loop
    execute format('alter table adex_demo.%I enable row level security', t);
    execute format('alter table adex_demo.%I force row level security', t);
    execute format('create policy owner_all on adex_demo.%I for all to adex_owner using (true) with check (true)', t);
  end loop;
end $$;

-- ============================================================
-- Funciones (SECURITY DEFINER, dueño `adex_owner`). Errores AX6xx sin datos.
-- ============================================================

-- Contexto: la API fija identidad, sesión e `iat` del token (mismo registro de
-- revocación que el resto) y NUNCA membresía ni empresa.
create function adex_demo.ctx_operator_valid() returns boolean
  language sql stable security definer set search_path = pg_catalog, adex, adex_demo
  as $$
    select adex.ctx_session_valid()
       and adex.ctx_membership() is null
       and adex.ctx_company() is null
       and exists (select 1 from adex_demo.operators o join adex.identities i on i.id = o.identity_id
                    where o.identity_id = adex.ctx_identity() and o.status = 'activo' and i.status = 'active')
  $$;

create function adex_demo.operator_status() returns text
  language sql stable security definer set search_path = pg_catalog, adex, adex_demo
  as $$
    select case
      when not exists (select 1 from adex.identities i where i.id = adex.ctx_identity()) then 'not_operator'
      when not adex.ctx_session_valid() then 'session_revoked'
      when adex_demo.ctx_operator_valid() then 'ok'
      else 'not_operator'
    end
  $$;

create function adex_demo.assert_operator() returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_demo
  as $$ begin
    if not adex_demo.ctx_operator_valid() then
      raise exception 'adex_demo: no active demo operator in context' using errcode = '42501';
    end if;
  end $$;

create function adex_demo.log(p_slot text, p_company text, p_action text, p_outcome text, p_detail jsonb) returns void
  language sql security definer set search_path = pg_catalog, adex, adex_demo
  as $$
    insert into adex_demo.events (slot, company_id, operator_identity_id, action, outcome, detail)
    values (p_slot, p_company, adex.ctx_identity(), p_action, p_outcome, p_detail)
  $$;

-- Bloquea el hueco (lo crea vacío la primera vez). Serializa TODO el ciclo de vida.
create function adex_demo.lock_slot(p_slot text) returns adex_demo.slots
  language plpgsql security definer set search_path = pg_catalog, adex, adex_demo
  as $$
  declare s adex_demo.slots;
  begin
    insert into adex_demo.slots (slot, state) values (p_slot, 'empty') on conflict do nothing;
    select * into s from adex_demo.slots where slot = p_slot for update;
    return s;
  end $$;

-- Empresa + categorías predeterminadas + puestos, en la transacción que la invoca.
create function adex_demo.provision_company(
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
      if (s ->> 'role') not in ('superadmin', 'admin', 'supervisor', 'cobrador', 'socio', 'secretario')
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

-- Retirada definitiva (ver cabecera). Toma el bloqueo exclusivo de la empresa.
create function adex_demo.retire_company(p_company text, p_reason text) returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_demo
  as $$ begin
    perform set_config('adex_demo.lifecycle', 'on', true);
    update adex.companies set status = 'suspendida', retired_at = now(), updated_at = now()
     where id = p_company and is_demo and retired_at is null;
    if not found then raise exception 'adex_demo: not a live demo company' using errcode = 'AX604'; end if;
    update adex.identities i set status = 'disabled', updated_at = now()
      from adex_demo.seats s where s.company_id = p_company and i.id = s.placeholder_identity_id and i.status = 'active';
    update adex_demo.companies set state = 'retired', retired_at = now(), retired_reason = p_reason where company_id = p_company;
  end $$;

-- Puestos asignables → participantes configurados; los marcadores quedan desactivados.
create function adex_demo.activate_company(p_slot text, p_company text) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, adex, adex_demo
  as $$
  declare
    r record;
    assigned jsonb := '[]'::jsonb;
  begin
    for r in
      select s.seat, s.membership_id, s.placeholder_identity_id, p.identity_id, p.display_name
        from adex_demo.seats s join adex_demo.participants p on p.slot = p_slot and p.seat = s.seat
       where s.company_id = p_company and s.assignable
       order by s.seat
    loop
      if not exists (select 1 from adex.identities i where i.id = r.identity_id and i.status = 'active')
         or exists (select 1 from adex_demo.seats x where x.placeholder_identity_id = r.identity_id) then
        raise exception 'adex_demo: participant identity is not usable' using errcode = 'AX612';
      end if;
      update adex.memberships set identity_id = r.identity_id, display_name = r.display_name, updated_at = now()
       where company_id = p_company and id = r.membership_id;
      update adex_demo.seats set identity_id = r.identity_id, synthetic = false where company_id = p_company and seat = r.seat;
      update adex.identities set status = 'disabled', updated_at = now() where id = r.placeholder_identity_id;
      assigned := assigned || jsonb_build_object('seat', r.seat, 'identityId', r.identity_id);
    end loop;
    update adex_demo.companies set state = 'active', activated_at = now() where company_id = p_company;
    return assigned;
  end $$;

-- ---------- Ciclo de vida (API de administración Demo) ----------

-- CREAR: hueco vacío → empresa nueva en aprovisionamiento.
create function adex_demo.begin_create(
  p_slot text, p_company_id text, p_name text, p_country_code text, p_country_label text, p_currency text,
  p_timezone text, p_scenario text, p_seats jsonb
) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, adex, adex_demo
  as $$
  declare s adex_demo.slots; seats jsonb;
  begin
    perform adex_demo.assert_operator();
    s := adex_demo.lock_slot(p_slot);
    if s.state <> 'empty' then raise exception 'adex_demo: slot is not empty' using errcode = 'AX601'; end if;
    seats := adex_demo.provision_company(p_slot, p_company_id, p_name, p_country_code, p_country_label, p_currency, p_timezone, p_scenario, p_seats);
    update adex_demo.slots set state = 'provisioning', company_id = p_company_id, updated_at = now() where slot = p_slot;
    perform adex_demo.log(p_slot, p_company_id, 'CREATE', 'started', jsonb_build_object('scenario', p_scenario));
    return seats;
  end $$;

-- REINICIAR (fase 1): congela la Demo vigente —identificada por su ID interno— y
-- crea la nueva. Congelar espera a las operaciones en curso (REVOKE-004) y rechaza
-- las siguientes. Un reinicio o eliminación simultáneos encuentran el hueco ocupado.
create function adex_demo.begin_reset(
  p_slot text, p_target text, p_company_id text, p_name text, p_country_code text, p_country_label text, p_currency text,
  p_timezone text, p_scenario text, p_seats jsonb
) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, adex, adex_demo
  as $$
  declare s adex_demo.slots; seats jsonb;
  begin
    perform adex_demo.assert_operator();
    s := adex_demo.lock_slot(p_slot);
    if s.state <> 'active' then raise exception 'adex_demo: slot busy' using errcode = 'AX601'; end if;
    if s.company_id is distinct from p_target then raise exception 'adex_demo: target is not the live demo' using errcode = 'AX603'; end if;
    perform set_config('adex_demo.lifecycle', 'on', true);
    update adex.companies set status = 'suspendida', updated_at = now() where id = p_target and is_demo and retired_at is null;
    if not found then raise exception 'adex_demo: not a live demo company' using errcode = 'AX604'; end if;
    update adex_demo.companies set state = 'frozen' where company_id = p_target;
    seats := adex_demo.provision_company(p_slot, p_company_id, p_name, p_country_code, p_country_label, p_currency, p_timezone, p_scenario, p_seats);
    update adex_demo.slots set state = 'resetting', pending_company_id = p_company_id, updated_at = now() where slot = p_slot;
    perform adex_demo.log(p_slot, p_target, 'RESET', 'started', jsonb_build_object('newCompanyId', p_company_id, 'scenario', p_scenario));
    return seats;
  end $$;

-- Fin del aprovisionamiento (crear o reiniciar): activa la nueva, retira la anterior.
create function adex_demo.finish_provision(p_slot text, p_company text, p_detail jsonb) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, adex, adex_demo
  as $$
  declare s adex_demo.slots; assigned jsonb; previous text;
  begin
    perform adex_demo.assert_operator();
    s := adex_demo.lock_slot(p_slot);
    if s.state = 'provisioning' and s.company_id = p_company then
      assigned := adex_demo.activate_company(p_slot, p_company);
      update adex_demo.slots set state = 'active', updated_at = now() where slot = p_slot;
      perform adex_demo.log(p_slot, p_company, 'CREATE', 'succeeded', coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('participants', assigned));
    elsif s.state = 'resetting' and s.pending_company_id = p_company then
      previous := s.company_id;
      assigned := adex_demo.activate_company(p_slot, p_company);
      perform adex_demo.retire_company(previous, 'reset');
      update adex_demo.slots set state = 'active', company_id = p_company, pending_company_id = null, updated_at = now() where slot = p_slot;
      perform adex_demo.log(p_slot, previous, 'RESET', 'succeeded',
        coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('newCompanyId', p_company, 'participants', assigned));
    else
      raise exception 'adex_demo: nothing to finish for this company' using errcode = 'AX603';
    end if;
    return jsonb_build_object('companyId', p_company, 'previousCompanyId', previous, 'participants', assigned);
  end $$;

-- Fallo del aprovisionamiento: la empresa a medio crear se retira (nunca queda
-- visible) y, en un reinicio, la Demo anterior se descongela intacta.
create function adex_demo.abort_provision(p_slot text, p_company text, p_error text) returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_demo
  as $$
  declare s adex_demo.slots; previous text;
  begin
    perform adex_demo.assert_operator();
    s := adex_demo.lock_slot(p_slot);
    if s.state = 'provisioning' and s.company_id = p_company then
      update adex_demo.slots set state = 'empty', company_id = null, updated_at = now() where slot = p_slot;
    elsif s.state = 'resetting' and s.pending_company_id = p_company then
      previous := s.company_id;
      perform set_config('adex_demo.lifecycle', 'on', true);
      update adex.companies set status = 'activa', updated_at = now() where id = previous and retired_at is null;
      update adex_demo.companies set state = 'active' where company_id = previous;
      update adex_demo.slots set state = 'active', pending_company_id = null, updated_at = now() where slot = p_slot;
    else
      raise exception 'adex_demo: nothing to abort for this company' using errcode = 'AX603';
    end if;
    perform adex_demo.retire_company(p_company, 'provisioning_failed');
    update adex_demo.companies set state = 'failed' where company_id = p_company;
    perform adex_demo.log(p_slot, p_company, case when previous is null then 'CREATE' else 'RESET' end, 'failed',
      jsonb_build_object('error', left(coalesce(p_error, ''), 200), 'restoredCompanyId', previous));
  end $$;

-- ELIMINAR: retira la Demo vigente (ID interno exacto) y deja el hueco vacío para
-- RECREAR. En una sola transacción.
create function adex_demo.delete_company(p_slot text, p_target text) returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_demo
  as $$
  declare s adex_demo.slots;
  begin
    perform adex_demo.assert_operator();
    s := adex_demo.lock_slot(p_slot);
    if s.state <> 'active' then raise exception 'adex_demo: slot busy' using errcode = 'AX601'; end if;
    if s.company_id is distinct from p_target then raise exception 'adex_demo: target is not the live demo' using errcode = 'AX603'; end if;
    perform adex_demo.retire_company(p_target, 'deleted');
    update adex_demo.slots set state = 'empty', company_id = null, updated_at = now() where slot = p_slot;
    perform adex_demo.log(p_slot, p_target, 'DELETE', 'succeeded', null);
  end $$;

-- Rechazos auditados (la transacción del rechazo se revierte; el registro se hace aparte).
create function adex_demo.record_event(p_slot text, p_company text, p_action text, p_outcome text, p_detail jsonb) returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_demo
  as $$ begin
    perform adex_demo.assert_operator();
    if p_outcome not in ('rejected', 'failed', 'succeeded') or p_action !~ '^[A-Z_]{3,40}$' or coalesce(p_slot, '') !~ '^[a-z][a-z0-9-]{1,30}$' then
      raise exception 'adex_demo: invalid event' using errcode = 'AX611';
    end if;
    perform adex_demo.log(p_slot, p_company, p_action, p_outcome, p_detail);
  end $$;

-- Participantes (configuración del hueco). La identidad la aprovisiona antes el
-- proveedor con el procedimiento de invitación; aquí solo se registra.
create function adex_demo.set_participant(p_slot text, p_seat text, p_identity uuid, p_email text, p_display_name text) returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_demo
  as $$ begin
    perform adex_demo.assert_operator();
    perform adex_demo.lock_slot(p_slot);
    if exists (select 1 from adex_demo.seats x where x.placeholder_identity_id = p_identity) then
      raise exception 'adex_demo: synthetic identities cannot be participants' using errcode = 'AX612';
    end if;
    insert into adex.identities (id, email) values (p_identity, lower(btrim(p_email))) on conflict (id) do nothing;
    if not exists (select 1 from adex.identities where id = p_identity and email = lower(btrim(p_email)) and status = 'active') then
      raise exception 'adex_demo: participant identity is not usable' using errcode = 'AX612';
    end if;
    insert into adex_demo.participants (slot, seat, identity_id, display_name, added_by)
    values (p_slot, p_seat, p_identity, btrim(p_display_name), adex.ctx_identity())
    on conflict (slot, seat) do update set identity_id = excluded.identity_id, display_name = excluded.display_name,
                                          added_at = now(), added_by = excluded.added_by;
    perform adex_demo.log(p_slot, null, 'SET_PARTICIPANT', 'succeeded', jsonb_build_object('seat', p_seat, 'identityId', p_identity));
  end $$;

create function adex_demo.remove_participant(p_slot text, p_seat text) returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_demo
  as $$ begin
    perform adex_demo.assert_operator();
    perform adex_demo.lock_slot(p_slot);
    delete from adex_demo.participants where slot = p_slot and seat = p_seat;
    perform adex_demo.log(p_slot, null, 'REMOVE_PARTICIPANT', case when found then 'succeeded' else 'rejected' end, jsonb_build_object('seat', p_seat));
  end $$;

-- Actor SINTÉTICO de un puesto de la Demo (para ejecutar el escenario y la
-- conciliación con el motor normal). Nunca devuelve un puesto ocupado por una persona.
create function adex_demo.synthetic_actor(p_company text, p_seat text) returns table (identity_id uuid, membership_id text)
  language plpgsql security definer set search_path = pg_catalog, adex, adex_demo
  as $$ begin
    perform adex_demo.assert_operator();
    return query
      select s.identity_id, s.membership_id::text
        from adex_demo.seats s
        join adex_demo.companies d on d.company_id = s.company_id
        join adex.companies c on c.id = s.company_id
       where s.company_id = p_company and s.seat = p_seat and s.synthetic
         and d.state in ('provisioning', 'active') and c.is_demo and c.retired_at is null;
  end $$;

-- Estado para el panel de administración. Sin datos financieros.
create function adex_demo.status(p_slot text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex, adex_demo
  as $$
  declare s adex_demo.slots; result jsonb;
  begin
    perform adex_demo.assert_operator();
    select * into s from adex_demo.slots where slot = p_slot;
    select jsonb_build_object(
      'slot', p_slot,
      'state', coalesce(s.state, 'empty'),
      'company', (select jsonb_build_object('id', c.id, 'name', c.name, 'countryCode', c.country_code, 'currencyCode', c.currency_code,
                                            'createdAt', d.created_at, 'activatedAt', d.activated_at, 'scenario', d.scenario_version,
                                            'state', d.state, 'operable', adex.company_is_operable(c.status, c.expires_on, c.timezone))
                    from adex.companies c join adex_demo.companies d on d.company_id = c.id where c.id = s.company_id),
      'pendingCompanyId', s.pending_company_id,
      'seats', coalesce((select jsonb_agg(jsonb_build_object('seat', x.seat, 'role', x.role, 'synthetic', x.synthetic, 'assignable', x.assignable,
                                                            'displayName', m.display_name) order by x.seat)
                           from adex_demo.seats x join adex.memberships m on m.company_id = x.company_id and m.id = x.membership_id
                          where x.company_id = s.company_id), '[]'::jsonb),
      'participants', coalesce((select jsonb_agg(jsonb_build_object('seat', p.seat, 'email', i.email, 'displayName', p.display_name,
                                                                   'identityStatus', i.status) order by p.seat)
                                  from adex_demo.participants p join adex.identities i on i.id = p.identity_id
                                 where p.slot = p_slot), '[]'::jsonb),
      'retiredCount', (select count(*) from adex_demo.companies d where d.slot = p_slot and d.state in ('retired', 'failed')),
      'events', coalesce((select jsonb_agg(e order by e.id desc) from (
                            select id, at, company_id as "companyId", action, outcome, detail
                              from adex_demo.events where slot = p_slot order by id desc limit 30) e), '[]'::jsonb)
    ) into result;
    return result;
  end $$;

-- ---------- Privilegios ----------
revoke all on all functions in schema adex_demo from public;
revoke all on all tables in schema adex_demo from public;
revoke all on schema adex_demo from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'authenticator', 'adex_api', 'adex_control'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema adex_demo from %I', r);
      execute format('revoke all on all tables in schema adex_demo from %I', r);
      execute format('revoke all on all functions in schema adex_demo from %I', r);
    end if;
  end loop;
end $$;
-- Funciones internas: sin EXECUTE para nadie más que su dueño.
grant usage on schema adex_demo to adex_demo;
grant execute on function adex_demo.operator_status(), adex_demo.begin_create(text, text, text, text, text, text, text, text, jsonb),
  adex_demo.begin_reset(text, text, text, text, text, text, text, text, text, jsonb), adex_demo.finish_provision(text, text, jsonb),
  adex_demo.abort_provision(text, text, text), adex_demo.delete_company(text, text), adex_demo.record_event(text, text, text, text, jsonb),
  adex_demo.set_participant(text, text, uuid, text, text), adex_demo.remove_participant(text, text),
  adex_demo.synthetic_actor(text, text), adex_demo.status(text) to adex_demo;
