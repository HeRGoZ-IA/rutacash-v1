-- ============================================================
-- ADEX SaaS · Fase 1 · 0006 · Acceso del plano de control Owner
-- ------------------------------------------------------------
-- DS-17 (aprobada por el propietario el 2026-10-14): mismo PostgreSQL, plano
-- SEPARADO. El rol `adex_control` (API Owner):
--   · no tiene USAGE sobre el esquema `adex` ni ningún privilegio de tabla en él;
--   · solo ve el plano de control si el contexto es un Owner ACTIVO con sesión válida;
--   · actúa sobre la empresa únicamente mediante funciones SECURITY DEFINER revisadas
--     que devuelven hechos ESTRUCTURALES (nunca clientes, ventas, pagos, cartera ni caja).
-- Ser Owner no es una membresía: no da contexto de empresa ni autoridad financiera,
-- y no existe ninguna función de impersonación.
--
-- `billableRouteCount` lo calcula el SERVIDOR (DS-17): rutas en estado 'activa',
-- misma regla que `src/platform/billing.ts`. El cliente ya no envía la cifra.
-- ============================================================

-- Lectura estructural para las funciones del propietario (sin login).
create policy owner_core_read on adex.routes for select to adex_owner using (true);
create policy owner_company_insert on adex.companies for insert to adex_owner with check (true);
create policy owner_company_update on adex.companies for update to adex_owner using (true) with check (true);
create policy owner_identity_insert on adex.identities for insert to adex_owner with check (true);
create policy owner_membership_insert on adex.memberships for insert to adex_owner with check (true);
create policy owner_session_revoke on adex.revoked_sessions for insert to adex_owner with check (true);
create policy owner_identity_cutoff on adex.identities for update to adex_owner using (true) with check (true);
do $$
declare t text;
begin
  foreach t in array array['platform_operators', 'company_control', 'saas_payments', 'control_events'] loop
    execute format('create policy owner_all on adex_control.%I for all to adex_owner using (true) with check (true)', t);
  end loop;
end $$;

-- ---------- Contexto del Owner ----------
-- La API Owner fija `adex.identity_id`, `adex.session_id` y `adex.token_iat` (mismo
-- registro de revocación que la API de empresa) y NUNCA `adex.membership_id`.
create function adex_control.ctx_operator_valid() returns boolean
  language sql stable security definer set search_path = pg_catalog, adex, adex_control
  as $$
    select adex.ctx_session_valid()
       and adex.ctx_membership() is null
       and exists (select 1 from adex_control.platform_operators o
                     join adex.identities i on i.id = o.identity_id
                    where o.identity_id = adex.ctx_identity() and o.status = 'activo' and i.status = 'active')
  $$;

-- Diagnóstico para la API Owner (sin datos): 'ok' | 'session_revoked' | 'not_operator'.
create function adex_control.operator_status() returns text
  language sql stable security definer set search_path = pg_catalog, adex, adex_control
  as $$
    select case
      when not adex.ctx_session_valid() then 'session_revoked'
      when adex_control.ctx_operator_valid() then 'ok'
      else 'not_operator'
    end
  $$;

-- Cierre de sesión del Owner en el mismo registro de revocación (decisión 2026-10-14).
create function adex_control.logout(p_global boolean) returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$ begin
    if not adex.ctx_session_valid() then
      raise exception 'adex_control: session already revoked' using errcode = '42501';
    end if;
    insert into adex.revoked_sessions (session_id, identity_id, reason)
    values (adex.ctx_session(), adex.ctx_identity(), case when p_global then 'logout_global' else 'logout' end);
    if p_global then
      update adex.identities set sessions_valid_after = now(), updated_at = now() where id = adex.ctx_identity();
    end if;
  end $$;

create function adex_control.assert_operator() returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$ begin
    if not adex_control.ctx_operator_valid() then
      raise exception 'adex_control: no active Owner in context' using errcode = '42501';
    end if;
  end $$;

do $$
declare t text;
begin
  foreach t in array array['platform_operators', 'company_control', 'saas_payments', 'control_events'] loop
    execute format('create policy %I on adex_control.%I for select to adex_control using (adex_control.ctx_operator_valid())', t || '_operator', t);
  end loop;
end $$;
create policy saas_payments_write on adex_control.saas_payments for insert to adex_control with check (adex_control.ctx_operator_valid());
create policy saas_payments_update on adex_control.saas_payments for update to adex_control
  using (adex_control.ctx_operator_valid()) with check (adex_control.ctx_operator_valid());
create policy company_control_billing on adex_control.company_control for update to adex_control
  using (adex_control.ctx_operator_valid()) with check (adex_control.ctx_operator_valid());
create policy platform_operators_login on adex_control.platform_operators for update to adex_control
  using (adex_control.ctx_operator_valid() and identity_id = adex.ctx_identity())
  with check (identity_id = adex.ctx_identity());

-- ---------- Funciones del plano de control ----------

-- Alta de empresa (estructural): Tenant + ficha de control + evento.
create function adex_control.create_company(
  p_id text, p_name text, p_email text, p_plan text, p_country_code text, p_country_label text,
  p_currency text, p_timezone text, p_tax_id text, p_contact text, p_billing_mode text, p_billing_rate numeric
) returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$ begin
    perform adex_control.assert_operator();
    insert into adex.companies (id, name, email, plan, status, country_code, country_label, currency_code, timezone, tax_id,
                                contact_name, created_at, updated_at)
    values (p_id, p_name, lower(btrim(p_email)), p_plan, 'prueba', p_country_code, p_country_label, p_currency, p_timezone, p_tax_id,
            p_contact, now(), now());
    insert into adex_control.company_control (company_id, name, tax_id, contact_name, contact_email, created_at, status,
                                              route_count, billable_route_count, billing_mode, billing_rate, payment_status, updated_at)
    values (p_id, p_name, p_tax_id, p_contact, lower(btrim(p_email)), now(), 'trial', 0, 0, p_billing_mode, p_billing_rate, 'pending', now());
    insert into adex_control.control_events (id, company_id, type, at, detail)
    values (gen_random_uuid()::text, p_id, 'COMPANY_CREATED', now(), p_name);
  end $$;

-- Primer SuperAdmin de una empresa (lo que hoy hace el portal Owner). Estructural:
-- crea la membresía; el Owner NO obtiene ninguna. La identidad la aprovisiona el
-- proveedor (id = `sub`); aquí solo se registra si aún no existe.
create function adex_control.create_company_superadmin(
  p_company_id text, p_membership_id text, p_identity_id uuid, p_email text, p_display_name text
) returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$ begin
    perform adex_control.assert_operator();
    if p_identity_id = adex.ctx_identity() then
      raise exception 'adex_control: an Owner cannot grant itself a company membership' using errcode = '42501';
    end if;
    insert into adex.identities (id, email) values (p_identity_id, lower(btrim(p_email))) on conflict (id) do nothing;
    insert into adex.memberships (id, company_id, identity_id, role, status, display_name, created_at, updated_at)
    values (p_membership_id, p_company_id, p_identity_id, 'superadmin', 'activo', p_display_name, now(), now());
  end $$;

-- Estado comercial (trial/active/suspended) y su espejo operativo (prueba/activa/
-- suspendida). Suspender es una vía de REVOCACIÓN: el disparador de `companies` toma
-- el bloqueo exclusivo de la empresa (REVOKE-004) y espera a las operaciones en curso.
create function adex_control.set_company_status(p_company_id text, p_status text, p_detail text) returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$
  declare
    mirror text := case p_status when 'trial' then 'prueba' when 'active' then 'activa' when 'suspended' then 'suspendida' end;
  begin
    perform adex_control.assert_operator();
    if mirror is null then raise exception 'adex_control: invalid status %', p_status using errcode = '22023'; end if;
    update adex.companies set status = mirror, updated_at = now() where id = p_company_id;
    if not found then raise exception 'adex_control: company not found' using errcode = 'P0002'; end if;
    update adex_control.company_control set status = p_status, updated_at = now() where company_id = p_company_id;
    insert into adex_control.control_events (id, company_id, type, at, detail)
    values (gen_random_uuid()::text, p_company_id,
            case when p_status = 'suspended' then 'COMPANY_SUSPENDED' else 'COMPANY_ACTIVATED' end, now(), p_detail);
  end $$;

-- DS-17: el servidor cuenta las rutas. Solo devuelve dos enteros.
create function adex_control.refresh_route_counts(p_company_id text) returns table (route_count integer, billable_route_count integer)
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$
  declare total integer; billable integer;
  begin
    perform adex_control.assert_operator();
    select count(*)::int, (count(*) filter (where r.status = 'activa'))::int into total, billable
      from adex.routes r where r.company_id = p_company_id;
    update adex_control.company_control c set route_count = total, billable_route_count = billable, updated_at = now()
     where c.company_id = p_company_id;
    if not found then raise exception 'adex_control: company not found' using errcode = 'P0002'; end if;
    return query select total, billable;
  end $$;

-- Telemetría de acceso (FIRST_LOGIN / LOGIN): la registra la API de EMPRESA al
-- seleccionar un contexto válido. Solo escribe fechas y un evento estructural.
create function adex_control.record_company_login() returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$
  declare first_time boolean;
  begin
    if not adex.ctx_membership_active() then
      raise exception 'adex_control: no valid company context' using errcode = '42501';
    end if;
    update adex_control.company_control c
       set first_login_at = coalesce(c.first_login_at, now()), last_login_at = now(), updated_at = now()
     where c.company_id = adex.ctx_company()
     returning (c.first_login_at = c.last_login_at) into first_time;
    if found then
      insert into adex_control.control_events (id, company_id, type, at)
      values (gen_random_uuid()::text, adex.ctx_company(), case when first_time then 'FIRST_LOGIN' else 'LOGIN' end, now());
    end if;
  end $$;

-- ---------- Privilegios ----------
revoke all on all functions in schema adex_control from public;
grant usage on schema adex_control to adex_control;
grant select on adex_control.platform_operators, adex_control.company_control, adex_control.saas_payments,
                adex_control.control_events to adex_control;
grant update (last_login_at, first_login_at, updated_at) on adex_control.platform_operators to adex_control;
grant update (billing_mode, billing_rate, next_billing_date, payment_status, updated_at) on adex_control.company_control to adex_control;
grant insert, update on adex_control.saas_payments to adex_control;
grant execute on function adex_control.ctx_operator_valid(), adex_control.assert_operator(),
  adex_control.operator_status(), adex_control.logout(boolean),
  adex_control.create_company(text, text, text, text, text, text, text, text, text, text, text, numeric),
  adex_control.create_company_superadmin(text, text, uuid, text, text),
  adex_control.set_company_status(text, text, text),
  adex_control.refresh_route_counts(text) to adex_control;
-- La API de empresa solo puede registrar su propio acceso.
grant usage on schema adex_control to adex_api;
grant execute on function adex_control.record_company_login() to adex_api;
-- El contexto de sesión (`adex.ctx_*`) lo leen las funciones del propietario; el rol
-- de control no necesita USAGE sobre `adex` (comprobado en OWN-002).
