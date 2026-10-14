-- ============================================================
-- ADEX SaaS · Fase 0 · 0004 · Plano de control Owner (modelo)
-- ------------------------------------------------------------
-- Las 4 tablas de plataforma de Dexie v13 (`platformUsers`, `companyControl`,
-- `saasPayments`, `controlEvents`) en un ESQUEMA PROPIO. Regla innegociable
-- (CONTROL_PLANE_BACKEND_REQUIREMENTS §2): aquí solo entran datos estructurales y
-- comerciales; nunca clientes, ventas, pagos, cartera, caja ni cobradores.
--
--   · La única relación con la operación es el id de la empresa.
--   · El rol del plano de control (`adex_control`, 0006) no tendrá NINGÚN
--     privilegio sobre el esquema `adex`: lo que necesite de él pasa por funciones
--     SECURITY DEFINER revisadas que devuelven solo hechos estructurales.
--   · Ser Owner no es una membresía: no da contexto de empresa ni autoridad
--     financiera, y no existe impersonación.
--
-- Esquema separado para no prejuzgar DS-17 (integrado o separado): puede moverse a
-- otra base sin tocar la operación.
-- El esquema `adex_control` lo crea el administrador con `authorization adex_owner`.
-- ============================================================

-- Owner (PlatformUser). La contraseña NO existe aquí: la gestiona el proveedor (DS-03).
create table adex_control.platform_operators (
  id             adex.eid primary key,
  identity_id    uuid not null unique references adex.identities(id),
  display_name   text not null check (length(btrim(display_name)) > 0),
  role           text not null check (role = 'owner'),
  status         text not null check (status in ('activo', 'inactivo')),
  first_login_at timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz not null,
  updated_at     timestamptz not null
);

-- Ficha de control: TODO lo que el Owner puede saber de una empresa.
create table adex_control.company_control (
  company_id           adex.eid primary key references adex.companies(id),
  name                 text not null,
  tax_id               text,
  contact_name         text,
  contact_email        text,
  created_at           timestamptz not null,
  first_login_at       timestamptz,
  last_login_at        timestamptz,
  status               text not null check (status in ('trial', 'active', 'suspended')),
  route_count          integer not null check (route_count >= 0),
  billable_route_count integer not null check (billable_route_count >= 0),
  billing_mode         text not null check (billing_mode in ('per_route', 'fixed')),
  billing_rate         numeric(14, 2) not null check (billing_rate >= 0),
  next_billing_date    date,
  payment_status       text not null check (payment_status in ('pending', 'paid', 'overdue')),
  updated_at           timestamptz not null
);

-- Cobro de ADEX a una empresa. No es la Caja del cliente.
create table adex_control.saas_payments (
  id            adex.eid primary key,
  company_id    adex.eid not null references adex_control.company_control(company_id),
  period        char(7) not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  amount        numeric(14, 2) not null check (amount > 0),
  expected_date date not null,
  paid_date     date,
  status        text not null check (status in ('pending', 'paid', 'overdue')),
  note          text,
  created_at    timestamptz not null,
  updated_at    timestamptz not null,
  check ((status = 'paid') = (paid_date is not null))
);

-- Historial estructural y comercial. SOLO estos 10 tipos (§3.3 del contrato).
create table adex_control.control_events (
  id         adex.eid primary key,
  company_id adex.eid not null references adex_control.company_control(company_id),
  type       text not null check (type in ('COMPANY_CREATED', 'COMPANY_ACTIVATED', 'COMPANY_SUSPENDED',
                                           'FIRST_LOGIN', 'LOGIN', 'ROUTE_CREATED', 'ROUTE_DEACTIVATED',
                                           'ROUTE_DELETED', 'BILLING_UPDATED', 'PAYMENT_REGISTERED')),
  at         timestamptz not null,
  detail     text
);
create index control_events_company_at on adex_control.control_events (company_id, at);

-- `firstLoginAt` es inmutable una vez escrito; el historial es append-only.
create function adex_control.guard_company_control() returns trigger
  language plpgsql
  as $$ begin
    if old.first_login_at is not null and new.first_login_at is distinct from old.first_login_at then
      raise exception 'adex_control: first_login_at is immutable' using errcode = '42501';
    end if;
    return new;
  end $$;
create trigger company_control_first_login before update on adex_control.company_control
  for each row execute function adex_control.guard_company_control();
create trigger control_events_append_only before update or delete on adex_control.control_events
  for each row execute function adex.reject_mutation();

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'adex_control' loop
    execute format('alter table adex_control.%I enable row level security', t);
    execute format('alter table adex_control.%I force row level security', t);
  end loop;
end $$;

revoke all on schema adex_control from public;
revoke all on all tables in schema adex_control from public;
revoke all on all functions in schema adex_control from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'authenticator', 'adex_api'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema adex_control from %I', r);
      execute format('revoke all on all tables in schema adex_control from %I', r);
    end if;
  end loop;
end $$;
