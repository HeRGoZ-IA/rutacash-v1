-- 0021 · Ronda 40: Plataforma Owner ORIGINAL de CLEAN en ADEX Online y primer acceso.
--
-- Solo plano de control y aprovisionamiento. Ninguna regla financiera cambia y ninguna
-- función nueva lee cartera, capital, caja, cobros ni clientes de una empresa.
--
--   1. Historial del plano de control (`control_events`): tres tipos nuevos
--      (SUPERADMIN_ASSIGNED, ACCESS_LINK_ISSUED, COMPANY_UPDATED) y el AUTOR de cada
--      evento (`actor_identity_id`, sellado por disparador con la identidad del contexto).
--   2. Eventos que CLEAN registraba y el servidor no: datos comerciales actualizados y
--      cobros SaaS (disparadores sobre las tablas que el Owner ya podía escribir) y
--      altas/bajas de rutas con su recuento (disparador sobre `adex.routes`, que solo
--      cuenta filas y nunca devuelve datos de la ruta al Owner).
--   3. Primer SuperAdmin: no puede ser un Owner; queda registrado en el historial.
--   4. Enlace de PRIMER ACCESO (sin contraseñas conocidas por nadie): las funciones solo
--      dicen si una membresía admite enlace. Lo admite si su identidad NO pertenece a
--      ninguna otra empresa y NO es Owner: un enlace sobre una identidad compartida
--      daría acceso a membresías de otra empresa (DS-05). El proveedor comprueba además
--      que la persona nunca haya iniciado sesión (servidor).
--   5. Ficha comercial: editar nombre, identificación y contacto (como en CLEAN) y leer
--      país, moneda y zona horaria (solo lectura: no se cambian tras el alta).
--   6. Lista de Owners para la Configuración del portal (nombre, correo, estado, accesos) y
--      sellado de su primer/último acceso. (La política `platform_operators_login` de 0006
--      no puede evaluarse como `adex_control`, que no tiene USAGE sobre `adex`: el sellado
--      se hace con una función del propietario.)

-- ---------- 1. Historial: tipos y autor ----------
alter table adex_control.control_events drop constraint control_events_type_check;
alter table adex_control.control_events add constraint control_events_type_check
  check (type in ('COMPANY_CREATED', 'COMPANY_ACTIVATED', 'COMPANY_SUSPENDED', 'FIRST_LOGIN', 'LOGIN', 'ROUTE_CREATED',
                  'ROUTE_DEACTIVATED', 'ROUTE_DELETED', 'BILLING_UPDATED', 'PAYMENT_REGISTERED',
                  'SUPERADMIN_ASSIGNED', 'ACCESS_LINK_ISSUED', 'COMPANY_UPDATED'));
alter table adex_control.control_events add column actor_identity_id uuid;

create function adex_control.stamp_event_actor() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$ begin
    new.actor_identity_id := adex.ctx_identity();
    return new;
  end $$;
create trigger control_events_actor before insert on adex_control.control_events
  for each row execute function adex_control.stamp_event_actor();

-- ---------- 2. Eventos comerciales y de rutas ----------
-- Solo se registran cambios hechos por una PERSONA (con contexto de sesión). Las cargas sin
-- contexto (semillas sintéticas, importaciones) no generan eventos: conservan su determinismo.
create function adex_control.log_billing_change() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$ begin
    if adex.ctx_identity() is null then return null; end if;
    insert into adex_control.control_events (id, company_id, type, at, detail)
    values (gen_random_uuid()::text, new.company_id, 'BILLING_UPDATED', now(), 'Datos comerciales actualizados');
    return null;
  end $$;
create trigger company_control_billing_event after update on adex_control.company_control
  for each row when ((old.billing_mode, old.billing_rate, old.next_billing_date, old.payment_status)
                     is distinct from (new.billing_mode, new.billing_rate, new.next_billing_date, new.payment_status))
  execute function adex_control.log_billing_change();

create function adex_control.log_saas_payment() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$ begin
    if adex.ctx_identity() is null then return null; end if;
    if tg_op = 'UPDATE' and new.status is not distinct from old.status then return null; end if;
    insert into adex_control.control_events (id, company_id, type, at, detail)
    values (gen_random_uuid()::text, new.company_id, 'PAYMENT_REGISTERED', now(), format('Cobro %s: %s', new.period, new.status));
    return null;
  end $$;
create trigger saas_payments_event after insert or update on adex_control.saas_payments
  for each row execute function adex_control.log_saas_payment();

-- Recuento de rutas (todas / facturables = activas) y su historial. Se ejecuta en la
-- transacción de la API de empresa; solo toca el plano de control de ESA empresa.
create function adex_control.track_routes() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$
  declare
    cid text := coalesce(new.company_id, old.company_id);
    ev text;
  begin
    if adex.ctx_identity() is null then return null; end if;
    update adex_control.company_control c
       set route_count = x.total, billable_route_count = x.billable, updated_at = now()
      from (select count(*)::int total, (count(*) filter (where r.status = 'activa'))::int billable
              from adex.routes r where r.company_id = cid) x
     where c.company_id = cid;
    if not found then return null; end if;
    if tg_op = 'INSERT' then ev := 'ROUTE_CREATED';
    elsif tg_op = 'DELETE' then ev := 'ROUTE_DELETED';
    elsif new.status is distinct from old.status and new.status <> 'activa' then ev := 'ROUTE_DEACTIVATED';
    end if;
    if ev is not null then
      insert into adex_control.control_events (id, company_id, type, at, detail) values (gen_random_uuid()::text, cid, ev, now(), null);
    end if;
    return null;
  end $$;
create trigger routes_control_metrics after insert or delete or update of status on adex.routes
  for each row execute function adex_control.track_routes();

-- Recuento inicial (las fichas existentes quedan al día).
update adex_control.company_control c
   set route_count = x.total, billable_route_count = x.billable
  from (select company_id, count(*)::int total, (count(*) filter (where status = 'activa'))::int billable
          from adex.routes group by company_id) x
 where c.company_id = x.company_id
   and (c.route_count, c.billable_route_count) is distinct from (x.total, x.billable);

-- ---------- 3. Primer SuperAdmin ----------
create or replace function adex_control.create_company_superadmin(
  p_company_id text, p_membership_id text, p_identity_id uuid, p_email text, p_display_name text
) returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$ begin
    perform adex_control.assert_operator();
    if p_identity_id = adex.ctx_identity() then
      raise exception 'adex_control: an Owner cannot grant itself a company membership' using errcode = '42501';
    end if;
    if exists (select 1 from adex_control.platform_operators o where o.identity_id = p_identity_id) then
      raise exception 'adex_control: an Owner identity cannot be a company member' using errcode = '42501';
    end if;
    insert into adex.identities (id, email) values (p_identity_id, lower(btrim(p_email))) on conflict (id) do nothing;
    insert into adex.memberships (id, company_id, identity_id, role, status, display_name, created_at, updated_at)
    values (p_membership_id, p_company_id, p_identity_id, 'superadmin', 'activo', p_display_name, now(), now());
    insert into adex_control.control_events (id, company_id, type, at, detail)
    values (gen_random_uuid()::text, p_company_id, 'SUPERADMIN_ASSIGNED', now(), p_display_name);
  end $$;

-- ---------- 4. Enlace de primer acceso ----------
-- ¿Admite enlace la identidad de esta membresía? Solo si es exclusiva de la empresa.
create function adex.identity_exclusive(p_identity_id uuid, p_company_id text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex, adex_control
  as $$
    select not exists (select 1 from adex.memberships m where m.identity_id = p_identity_id and m.company_id <> p_company_id)
       and not exists (select 1 from adex_control.platform_operators o where o.identity_id = p_identity_id)
  $$;

-- API de empresa: destino del enlace para una membresía de la empresa del contexto.
-- La autorización (rol, jerarquía, alcance) la hace la API antes de llamar.
create function adex.access_link_target(p_membership_id text)
  returns table (identity_id uuid, email text, exclusive boolean)
  language plpgsql stable security definer set search_path = pg_catalog, adex, adex_control
  as $$ begin
    if not adex.ctx_membership_active() then
      raise exception 'adex: no valid company context' using errcode = '42501';
    end if;
    return query
      select m.identity_id, i.email, adex.identity_exclusive(m.identity_id, m.company_id)
        from adex.memberships m join adex.identities i on i.id = m.identity_id
       where m.id = p_membership_id and m.company_id = adex.ctx_company() and m.status = 'activo';
  end $$;

-- Plano Owner: SuperAdmins de una empresa (nombre, correo, estado, si admiten enlace).
create function adex_control.company_superadmins(p_company_id text)
  returns table (membership_id text, identity_id uuid, email text, display_name text, status text, exclusive boolean, created_at timestamptz)
  language plpgsql stable security definer set search_path = pg_catalog, adex, adex_control
  as $$ begin
    perform adex_control.assert_operator();
    return query
      select m.id::text, m.identity_id, i.email, m.display_name, m.status, adex.identity_exclusive(m.identity_id, m.company_id), m.created_at
        from adex.memberships m join adex.identities i on i.id = m.identity_id
       where m.company_id = p_company_id and m.role = 'superadmin'
       order by m.created_at, m.id;
  end $$;

-- Plano Owner: registra en el historial que se emitió un enlace (tras emitirlo).
create function adex_control.record_access_link(p_company_id text, p_membership_id text) returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$
  declare who text;
  begin
    perform adex_control.assert_operator();
    select m.display_name into who from adex.memberships m
     where m.id = p_membership_id and m.company_id = p_company_id and m.role = 'superadmin';
    if not found then raise exception 'adex_control: superadmin not found' using errcode = 'P0002'; end if;
    insert into adex_control.control_events (id, company_id, type, at, detail)
    values (gen_random_uuid()::text, p_company_id, 'ACCESS_LINK_ISSUED', now(), who);
  end $$;

-- ---------- 5. Ficha comercial ----------
create function adex_control.update_company_profile(p_company_id text, p_name text, p_tax_id text, p_contact text, p_contact_email text)
  returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$ begin
    perform adex_control.assert_operator();
    update adex.companies set name = p_name, tax_id = p_tax_id, contact_name = p_contact,
           email = coalesce(lower(btrim(p_contact_email)), email), updated_at = now()
     where id = p_company_id;
    if not found then raise exception 'adex_control: company not found' using errcode = 'P0002'; end if;
    update adex_control.company_control set name = p_name, tax_id = p_tax_id, contact_name = p_contact,
           contact_email = lower(btrim(p_contact_email)), updated_at = now()
     where company_id = p_company_id;
    insert into adex_control.control_events (id, company_id, type, at, detail)
    values (gen_random_uuid()::text, p_company_id, 'COMPANY_UPDATED', now(), p_name);
  end $$;

create function adex_control.company_locale(p_company_id text)
  returns table (country_code text, country_label text, currency_code text, timezone text)
  language plpgsql stable security definer set search_path = pg_catalog, adex, adex_control
  as $$ begin
    perform adex_control.assert_operator();
    return query select c.country_code::text, c.country_label::text, c.currency_code::text, c.timezone::text
                   from adex.companies c where c.id = p_company_id;
  end $$;

-- ---------- 6. Owners ----------
create function adex_control.list_operators()
  returns table (identity_id uuid, display_name text, email text, status text, first_login_at timestamptz, last_login_at timestamptz, created_at timestamptz)
  language plpgsql stable security definer set search_path = pg_catalog, adex, adex_control
  as $$ begin
    perform adex_control.assert_operator();
    return query select o.identity_id, o.display_name, i.email, o.status, o.first_login_at, o.last_login_at, o.created_at
                   from adex_control.platform_operators o join adex.identities i on i.id = o.identity_id
                  order by o.created_at, o.id;
  end $$;

create function adex_control.record_operator_login() returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$ begin
    perform adex_control.assert_operator();
    update adex_control.platform_operators
       set first_login_at = coalesce(first_login_at, now()), last_login_at = now(), updated_at = now()
     where identity_id = adex.ctx_identity();
  end $$;

-- ---------- Privilegios ----------
revoke all on function adex_control.stamp_event_actor(), adex_control.log_billing_change(), adex_control.log_saas_payment(),
  adex_control.track_routes(), adex.identity_exclusive(uuid, text), adex.access_link_target(text),
  adex_control.company_superadmins(text), adex_control.record_access_link(text, text),
  adex_control.update_company_profile(text, text, text, text, text), adex_control.company_locale(text),
  adex_control.list_operators(), adex_control.record_operator_login() from public;
grant execute on function adex_control.company_superadmins(text), adex_control.record_access_link(text, text),
  adex_control.update_company_profile(text, text, text, text, text), adex_control.company_locale(text),
  adex_control.list_operators(), adex_control.record_operator_login() to adex_control;
grant execute on function adex.access_link_target(text) to adex_api;
