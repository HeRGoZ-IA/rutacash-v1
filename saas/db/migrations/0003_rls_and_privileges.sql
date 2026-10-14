-- ============================================================
-- ADEX SaaS · Fase 0 · 0003 · Aislamiento por empresa (RLS) y privilegios mínimos
-- ------------------------------------------------------------
-- Segunda barrera (DS-15): la API autoriza cada operación y, además, PostgreSQL
-- filtra TODAS las filas por el contexto activo de la transacción:
--
--   adex.identity_id   = `sub` verificado del token
--   adex.membership_id = membresía elegida por el cliente (contexto explícito, DS-05)
--   adex.company_id    = empresa de ESA membresía (la fija la API tras releerla)
--
-- Un contexto solo es válido si la membresía es de esa identidad y de esa empresa,
-- está activa, la identidad está activa y la empresa no está bloqueada. Sin contexto
-- válido no se ve ninguna fila. FORCE RLS somete también al propietario.
--
-- Las funciones de contexto son SECURITY DEFINER del propietario `adex_owner` (sin
-- login): leen membresías, identidades y empresas sin recursión de políticas y solo
-- devuelven booleanos o ids del PROPIO contexto.
--
-- Alcance por rutas (`authorizedRouteIds`): el SuperAdmin ve todas las rutas de su
-- empresa (`isRouteUnrestricted`); el resto solo sus rutas autorizadas. Las filas
-- operativas SIN ruta (bolsas, libro de empresa, Caja socios) quedan, en esta fase,
-- solo para el SuperAdmin: se amplían por comando en las fases 3–6 con sus pruebas
-- (fallo cerrado: la ausencia de regla nunca amplía el acceso).
-- ============================================================

-- ---------- Contexto de la transacción ----------
create function adex.ctx_identity() returns uuid language sql stable
  as $$ select nullif(current_setting('adex.identity_id', true), '')::uuid $$;
create function adex.ctx_membership() returns text language sql stable
  as $$ select nullif(current_setting('adex.membership_id', true), '') $$;
create function adex.ctx_company() returns text language sql stable
  as $$ select nullif(current_setting('adex.company_id', true), '') $$;

-- Lectura del núcleo de identidad para las funciones SECURITY DEFINER del propietario.
alter table adex.companies         enable row level security;
alter table adex.identities        enable row level security;
alter table adex.memberships       enable row level security;
alter table adex.membership_routes enable row level security;
create policy owner_core_read on adex.companies         for select to adex_owner using (true);
create policy owner_core_read on adex.identities        for select to adex_owner using (true);
create policy owner_core_read on adex.memberships       for select to adex_owner using (true);
create policy owner_core_read on adex.membership_routes for select to adex_owner using (true);

-- Validez de una sesión (se refuerza en 0005 con la revocación de sesiones).
create function adex.ctx_session_valid() returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select true $$;

-- ¿El contexto (identidad, membresía, empresa) es válido y operable?
create function adex.ctx_membership_active() returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select adex.ctx_session_valid() and exists (
      select 1
        from adex.memberships m
        join adex.identities i on i.id = m.identity_id
        join adex.companies  c on c.id = m.company_id
       where m.id          = adex.ctx_membership()
         and m.identity_id = adex.ctx_identity()
         and m.company_id  = adex.ctx_company()
         and m.status = 'activo'
         and i.status = 'active'
         and adex.company_is_operable(c.status, c.expires_on, c.timezone))
  $$;

-- Rol de la membresía activa (NULL si el contexto no es válido).
create function adex.ctx_role() returns text
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select m.role from adex.memberships m
     where adex.ctx_membership_active() and m.id = adex.ctx_membership()
  $$;

-- ¿La membresía activa alcanza esta ruta? NULL = fila sin ruta: solo SuperAdmin.
create function adex.ctx_route_allowed(p_route_id text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select case
      when not adex.ctx_membership_active() then false
      when adex.ctx_role() = 'superadmin' then true
      when p_route_id is null then false
      else exists (select 1 from adex.membership_routes mr
                    where mr.membership_id = adex.ctx_membership()
                      and mr.company_id    = adex.ctx_company()
                      and mr.route_id      = p_route_id)
    end
  $$;

-- Empresas en las que la identidad tiene alguna membresía activa (selector, DS-05).
create function adex.ctx_identity_member_of(p_company_id text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select adex.ctx_session_valid() and exists (
      select 1 from adex.memberships m join adex.identities i on i.id = m.identity_id
       where m.identity_id = adex.ctx_identity() and m.company_id = p_company_id
         and m.status = 'activo' and i.status = 'active')
  $$;

-- ¿La identidad pertenece (con cualquier estado) a la empresa del contexto?
create function adex.identity_in_ctx_company(p_identity_id uuid) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select exists (select 1 from adex.memberships m
                    where m.identity_id = p_identity_id and m.company_id = adex.ctx_company())
  $$;

-- ---------- RLS habilitada y FORZADA en todas las tablas ----------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'adex' loop
    execute format('alter table adex.%I enable row level security', t);
    execute format('alter table adex.%I force row level security', t);
  end loop;
end $$;

create policy currencies_read on adex.currencies for select to adex_api using (true);

create policy companies_ctx on adex.companies for select to adex_api
  using ((id = adex.ctx_company() and adex.ctx_membership_active())
         or adex.ctx_identity_member_of(id));

create policy identities_ctx on adex.identities for select to adex_api
  using (id = adex.ctx_identity()
         or (adex.ctx_role() in ('superadmin', 'admin') and adex.identity_in_ctx_company(id)));

create policy memberships_ctx on adex.memberships for select to adex_api
  using (identity_id = adex.ctx_identity()
         or (company_id = adex.ctx_company() and adex.ctx_membership_active()));

create policy membership_routes_ctx on adex.membership_routes for select to adex_api
  using (exists (select 1 from adex.memberships m where m.id = membership_routes.membership_id));

-- Tablas de empresa sin alcance por ruta.
do $$
declare t text;
begin
  foreach t in array array['offices', 'expense_categories'] loop
    execute format(
      'create policy %I on adex.%I for select to adex_api
         using (company_id = adex.ctx_company() and adex.ctx_membership_active())', t || '_ctx', t);
  end loop;
end $$;

create policy routes_ctx on adex.routes for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_route_allowed(id));

-- Tablas con `route_id` (obligatorio u opcional): empresa + alcance de rutas.
do $$
declare t text;
begin
  foreach t in array array['clients', 'sale_requests', 'sales', 'payments', 'payment_adjustment_requests',
                           'no_payment_visits', 'expenses', 'capital_movements', 'withdrawals', 'capital_ledger',
                           'route_capital_controller_events', 'cash_custody_movements', 'cash_settlements',
                           'weekly_settlements', 'audit_log'] loop
    execute format(
      'create policy %I on adex.%I for select to adex_api
         using (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id))', t || '_ctx', t);
  end loop;
end $$;

create policy installments_ctx on adex.installments for select to adex_api
  using (company_id = adex.ctx_company()
         and exists (select 1 from adex.sales s where s.company_id = installments.company_id and s.id = installments.sale_id));

create policy transfers_ctx on adex.transfers for select to adex_api
  using (company_id = adex.ctx_company()
         and (adex.ctx_route_allowed(route_origin_id) or adex.ctx_route_allowed(route_destination_id)
              or adex.ctx_role() = 'superadmin'));

-- Caja socios (D1 abierta): solo SuperAdmin hasta la Fase 3.
create policy partner_cash_movements_ctx on adex.partner_cash_movements for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_role() = 'superadmin');

create policy operations_ctx on adex.operations for select to adex_api
  using (company_id = adex.ctx_company() and membership_id = adex.ctx_membership() and adex.ctx_membership_active());

-- ---------- Privilegios mínimos ----------
revoke all on schema adex from public;
revoke all on all tables in schema adex from public;
revoke all on all functions in schema adex from public;
revoke all on all sequences in schema adex from public;
alter default privileges in schema adex revoke all on tables from public;
alter default privileges in schema adex revoke all on functions from public;

-- Roles de la Data API de Supabase (si existen): sin ningún acceso a `adex`.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'authenticator'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema adex from %I', r);
      execute format('revoke all on all tables in schema adex from %I', r);
      execute format('revoke all on all functions in schema adex from %I', r);
    end if;
  end loop;
end $$;

-- Fase 0: la API solo LEE. Las escrituras se conceden comando a comando en las
-- fases siguientes (Fase 1: identidad y membresías, 0005). Nunca DELETE ni TRUNCATE.
grant usage on schema adex to adex_api;
grant select on all tables in schema adex to adex_api;
grant execute on all functions in schema adex to adex_api;
