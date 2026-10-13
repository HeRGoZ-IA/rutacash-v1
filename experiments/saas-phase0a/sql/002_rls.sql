-- ============================================================
-- ADEX SaaS · Fase 0A · Segunda barrera: Row Level Security
-- ------------------------------------------------------------
-- La API valida la membresía y los permisos (primera barrera). Además, cada
-- transacción de la API fija su contexto con set_config(..., true) y PostgreSQL
-- filtra TODAS las filas por ese contexto, aunque la API tuviera un fallo.
--
-- El contexto solo es válido si la membresía pertenece a la identidad, es de la
-- empresa indicada y tanto la membresía como la empresa están activas. Una
-- empresa "forzada" en el contexto sin membresía válida no ve nada.
--
-- La API se conecta como `adex_api`: NO superusuario, NO BYPASSRLS, NO propietario
-- de las tablas. FORCE ROW LEVEL SECURITY somete también al propietario.
-- ============================================================

create function adex.ctx_identity() returns uuid language sql stable
  as $$ select nullif(current_setting('adex.identity_id', true), '')::uuid $$;
create function adex.ctx_membership() returns uuid language sql stable
  as $$ select nullif(current_setting('adex.membership_id', true), '')::uuid $$;
create function adex.ctx_company() returns uuid language sql stable
  as $$ select nullif(current_setting('adex.company_id', true), '')::uuid $$;

-- ¿El contexto (identidad, membresía, empresa) es válido y está activo?
create function adex.ctx_membership_active() returns boolean language sql stable
  as $$
    select exists (
      select 1
        from adex.memberships m
        join adex.companies c on c.id = m.company_id
       where m.id          = adex.ctx_membership()
         and m.identity_id = adex.ctx_identity()
         and m.company_id  = adex.ctx_company()
         and m.status = 'active'
         and c.status = 'active')
  $$;

-- ¿La membresía activa alcanza esta ruta? (null = caja de empresa: solo alcance empresa)
create function adex.ctx_route_allowed(p_route_id uuid) returns boolean language sql stable
  as $$
    select exists (
      select 1
        from adex.memberships m
       where m.id          = adex.ctx_membership()
         and m.identity_id = adex.ctx_identity()
         and m.company_id  = adex.ctx_company()
         and m.status = 'active'
         and (m.scope = 'company'
              or (p_route_id is not null and exists (
                    select 1 from adex.membership_routes mr
                     where mr.membership_id = m.id and mr.route_id = p_route_id))))
  $$;

alter table adex.currencies        enable row level security;
alter table adex.companies         enable row level security;
alter table adex.identities        enable row level security;
alter table adex.routes            enable row level security;
alter table adex.memberships       enable row level security;
alter table adex.membership_routes enable row level security;
alter table adex.accounts          enable row level security;
alter table adex.operations        enable row level security;
alter table adex.movements         enable row level security;
alter table adex.audit_log         enable row level security;

alter table adex.currencies        force row level security;
alter table adex.companies         force row level security;
alter table adex.identities        force row level security;
alter table adex.routes            force row level security;
alter table adex.memberships       force row level security;
alter table adex.membership_routes force row level security;
alter table adex.accounts          force row level security;
alter table adex.operations        force row level security;
alter table adex.movements         force row level security;
alter table adex.audit_log         force row level security;

-- Catálogo público de monedas (solo lectura).
create policy currencies_read on adex.currencies for select using (true);

-- La identidad solo se ve a sí misma y solo ve SUS membresías (para elegir contexto).
create policy identities_self on adex.identities for select
  using (id = adex.ctx_identity());
create policy memberships_self on adex.memberships for select
  using (identity_id = adex.ctx_identity());
create policy membership_routes_self on adex.membership_routes for select
  using (exists (select 1 from adex.memberships m where m.id = membership_routes.membership_id));

-- La empresa solo es visible con una membresía activa de esa empresa en el contexto.
create policy companies_ctx on adex.companies for select
  using (id = adex.ctx_company()
         and exists (select 1 from adex.memberships m
                      where m.id = adex.ctx_membership()
                        and m.company_id = companies.id
                        and m.status = 'active'));

create policy routes_ctx on adex.routes for select
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()));

-- Cuentas: empresa del contexto + alcance de rutas de la membresía activa.
create policy accounts_read on adex.accounts for select
  using (company_id = adex.ctx_company()
         and (select adex.ctx_membership_active())
         and adex.ctx_route_allowed(route_id));
create policy accounts_update on adex.accounts for update
  using (company_id = adex.ctx_company()
         and (select adex.ctx_membership_active())
         and adex.ctx_route_allowed(route_id))
  with check (company_id = adex.ctx_company()
              and (select adex.ctx_membership_active())
              and adex.ctx_route_allowed(route_id));

create policy operations_read on adex.operations for select
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()));
create policy operations_insert on adex.operations for insert
  with check (company_id = adex.ctx_company()
              and membership_id = adex.ctx_membership()
              and (select adex.ctx_membership_active()));
create policy operations_update on adex.operations for update
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()))
  with check (company_id = adex.ctx_company()
              and membership_id = adex.ctx_membership()
              and (select adex.ctx_membership_active()));

create policy movements_read on adex.movements for select
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()));
create policy movements_insert on adex.movements for insert
  with check (company_id = adex.ctx_company()
              and identity_id = adex.ctx_identity()
              and membership_id = adex.ctx_membership()
              and (select adex.ctx_membership_active()));

create policy audit_read on adex.audit_log for select
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()));
create policy audit_insert on adex.audit_log for insert
  with check (company_id = adex.ctx_company()
              and identity_id = adex.ctx_identity()
              and membership_id = adex.ctx_membership()
              and (select adex.ctx_membership_active()));

-- ---------- Privilegios mínimos del rol de la API ----------
revoke all on schema adex from public;
revoke all on all tables in schema adex from public;
revoke all on all functions in schema adex from public;

grant usage on schema adex to adex_api;
grant select on adex.currencies, adex.companies, adex.identities, adex.routes,
                adex.memberships, adex.membership_routes to adex_api;
grant select on adex.accounts to adex_api;
grant update (balance_minor, updated_at) on adex.accounts to adex_api;
grant select, insert on adex.operations to adex_api;
grant update (outcome, http_status, result) on adex.operations to adex_api;
grant select, insert on adex.movements, adex.audit_log to adex_api;   -- sin UPDATE ni DELETE
grant usage on all sequences in schema adex to adex_api;
grant execute on all functions in schema adex to adex_api;
