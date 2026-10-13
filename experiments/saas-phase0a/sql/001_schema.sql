-- ============================================================
-- ADEX SaaS · Fase 0A · Esquema mínimo EXPERIMENTAL Y DESCARTABLE
-- ------------------------------------------------------------
-- No es el esquema de la Fase 1. No reproduce las 28 tablas Dexie ni el modelo
-- real de préstamos. Solo lo necesario para probar identidad, membresías,
-- aislamiento por empresa y transacciones financieras sintéticas.
--
-- Se ejecuta como el rol propietario `adex_owner` (no superusuario, sin BYPASSRLS).
-- ============================================================

create schema adex;

-- ---------- Internacionalización ----------
-- Monedas: solo código ISO 4217 y número de decimales. Nada de conversión ni tasas.
create table adex.currencies (
  code        char(3)  primary key check (code ~ '^[A-Z]{3}$'),
  minor_units smallint not null check (minor_units between 0 and 4)
);

create function adex.is_valid_timezone(tz text) returns boolean
  language sql stable
  as $$ select exists (select 1 from pg_catalog.pg_timezone_names where name = tz) $$;

-- ---------- Empresas (tenants) ----------
create table adex.companies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) > 0),
  country_code  char(2) not null check (country_code ~ '^[A-Z]{2}$'),  -- ISO 3166-1 alfa-2
  currency_code char(3) not null references adex.currencies(code),
  timezone      text not null check (adex.is_valid_timezone(timezone)),  -- IANA
  status        text not null default 'active' check (status in ('active', 'suspended')),
  created_at    timestamptz not null default now()
);

-- ---------- Identidad ----------
-- Espejo mínimo de la identidad del proveedor de autenticación.
-- En Supabase, `id` sería `auth.users.id` (el claim `sub` del token).
create table adex.identities (
  id         uuid primary key,
  email      text not null unique,
  created_at timestamptz not null default now()
);

-- ---------- Rutas (solo para el alcance de las membresías) ----------
create table adex.routes (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references adex.companies(id),
  name       text not null,
  unique (company_id, id)
);

-- ---------- Membresías ----------
-- Una identidad puede tener varias membresías (varias empresas y varios roles
-- dentro de una empresa). Cada membresía es un contexto independiente: los
-- permisos NUNCA se acumulan entre membresías.
-- Roles EXPERIMENTALES de la POC; no reflejan ni modifican los roles de CLEAN.
create table adex.memberships (
  id          uuid primary key default gen_random_uuid(),
  identity_id uuid not null references adex.identities(id),
  company_id  uuid not null references adex.companies(id),
  role        text not null check (role in ('admin', 'supervisor', 'cobrador')),
  status      text not null default 'active' check (status in ('active', 'inactive')),
  scope       text not null check (scope in ('company', 'routes')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (identity_id, company_id, role),
  unique (company_id, id)
);

-- Alcance por rutas (solo si scope = 'routes'). Las FK compuestas impiden
-- asignar una ruta de otra empresa.
create table adex.membership_routes (
  membership_id uuid not null,
  company_id    uuid not null,
  route_id      uuid not null,
  primary key (membership_id, route_id),
  foreign key (company_id, membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, route_id)      references adex.routes(company_id, id)
);

-- ---------- Libro financiero SINTÉTICO ----------
-- Independiente del modelo real de préstamos. Dinero en unidades menores (bigint).
create table adex.accounts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references adex.companies(id),
  route_id      uuid null,                      -- null = caja de empresa
  name          text not null,
  balance_minor bigint not null default 0 check (balance_minor >= 0),
  updated_at    timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, route_id) references adex.routes(company_id, id)
);

-- Idempotencia: una fila por (empresa, operationId). `request_hash` fija los
-- parámetros; reutilizar el identificador con otros parámetros se rechaza.
create table adex.operations (
  company_id    uuid not null references adex.companies(id),
  operation_id  uuid not null,
  kind          text not null check (kind in ('deposit', 'withdrawal')),
  request_hash  text not null,
  membership_id uuid not null,
  outcome       text not null check (outcome in ('pending', 'approved', 'rejected')),
  http_status   smallint null,
  result        jsonb null,
  created_at    timestamptz not null default now(),
  primary key (company_id, operation_id),
  foreign key (company_id, membership_id) references adex.memberships(company_id, id)
);

create table adex.movements (
  id                  bigint generated always as identity primary key,
  company_id          uuid not null,
  account_id          uuid not null,
  operation_id        uuid not null,
  kind                text not null check (kind in ('deposit', 'withdrawal')),
  amount_minor        bigint not null check (amount_minor > 0),
  balance_after_minor bigint not null check (balance_after_minor >= 0),
  currency_code       char(3) not null references adex.currencies(code),
  identity_id         uuid not null references adex.identities(id),
  membership_id       uuid not null,
  role                text not null,
  txid                bigint not null default txid_current(),
  created_at          timestamptz not null default now(),
  unique (company_id, operation_id),                         -- un movimiento por operación
  foreign key (company_id, account_id)    references adex.accounts(company_id, id),
  foreign key (company_id, operation_id)  references adex.operations(company_id, operation_id),
  foreign key (company_id, membership_id) references adex.memberships(company_id, id)
);

-- Auditoría: identidad, empresa, rol y membresía actuante; misma transacción
-- que el movimiento (`txid`).
create table adex.audit_log (
  id            bigint generated always as identity primary key,
  company_id    uuid not null references adex.companies(id),
  identity_id   uuid not null references adex.identities(id),
  membership_id uuid not null,
  role          text not null,
  action        text not null,
  entity_type   text not null,
  entity_id     text not null,
  operation_id  uuid null,
  outcome       text not null check (outcome in ('approved', 'rejected')),
  detail        jsonb not null default '{}'::jsonb,
  txid          bigint not null default txid_current(),
  created_at    timestamptz not null default now(),
  foreign key (company_id, membership_id) references adex.memberships(company_id, id)
);

create index audit_log_company_operation on adex.audit_log (company_id, operation_id);
create index movements_company_account on adex.movements (company_id, account_id);

-- Libro y auditoría son append-only, incluso para el propietario.
create function adex.reject_mutation() returns trigger
  language plpgsql
  as $$ begin raise exception 'append-only table %: % is not allowed', tg_table_name, tg_op using errcode = '42501'; end $$;

create trigger movements_append_only before update or delete on adex.movements
  for each row execute function adex.reject_mutation();
create trigger audit_log_append_only before update or delete on adex.audit_log
  for each row execute function adex.reject_mutation();
