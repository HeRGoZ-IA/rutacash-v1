-- ============================================================
-- ADEX SaaS · Fase 0 · 0001 · Núcleo multiempresa
-- ------------------------------------------------------------
-- Empresas (tenants), identidades, membresías (DS-05), Oficinas y Rutas.
-- Derivado de Dexie v16 (`src/models/types.ts`): Tenant, User, Office, Route.
-- La correspondencia campo a campo y cada diferencia justificada están en
-- `saas/src/model/dexieV16.ts` y las verifica `test/contracts/schema-coverage`.
--
-- Convenciones:
--   · Identificadores de entidad: `adex.eid` (texto). Se CONSERVAN los ids locales
--     en una importación futura (plan §4.2.4); los nuevos son UUID en texto.
--   · Dinero: `bigint` en unidades menores (`*_minor`), según `currencies.minor_units`.
--     El motor local trabaja con enteros (Math.round): la conversión es exacta.
--   · Fechas contables: `date`. Instantes: `timestamptz`.
--   · Toda tabla operativa lleva `company_id` y una clave única (company_id, id):
--     las FK son COMPUESTAS, así que una fila nunca puede apuntar a otra empresa.
--
-- Se ejecuta con `set local role adex_owner` (sin superusuario ni BYPASSRLS). El
-- esquema `adex` lo crea antes el administrador con `authorization adex_owner`
-- (scripts de migración), igual que en el proyecto Supabase de la Fase 0A.1.
-- ============================================================

create domain adex.eid as text
  check (value ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$');

-- ---------- Internacionalización (P6) ----------
create table adex.currencies (
  code        char(3)  primary key check (code ~ '^[A-Z]{3}$'),
  minor_units smallint not null check (minor_units between 0 and 4)
);
-- Mercados iniciales aprobados. ISO 4217: precisión de ALMACENAMIENTO (2 decimales).
-- La presentación y el redondeo de COP siguen pendientes; CLEAN trabaja en enteros.
insert into adex.currencies (code, minor_units) values ('BRL', 2), ('COP', 2);

create function adex.is_valid_timezone(tz text) returns boolean
  language sql stable
  as $$ select exists (select 1 from pg_catalog.pg_timezone_names where name = tz) $$;

-- ---------- Empresas (Tenant) ----------
-- `status` es el estado OPERATIVO que consume la aplicación de la empresa
-- (espejo del estado comercial que decide el Owner, ver 0004).
create table adex.companies (
  id                    adex.eid primary key,
  name                  text not null check (length(btrim(name)) > 0),
  legal_name            text,
  tax_id                text,
  email                 text not null,
  phone                 text,
  plan                  text not null check (plan in ('basico', 'operativo', 'profesional', 'empresarial')),
  status                text not null check (status in ('activa', 'suspendida', 'prueba')),
  expires_on            date,
  logo                  text,
  country_code          char(2) not null check (country_code ~ '^[A-Z]{2}$'),   -- ISO 3166-1
  country_label         text not null,                                          -- `Tenant.pais` tal cual
  city                  text,
  currency_code         char(3) not null references adex.currencies(code),
  timezone              text not null check (adex.is_valid_timezone(timezone)),  -- IANA (DS-04 pendiente)
  address               text,
  contact_name          text,
  cash_model_start_at   timestamptz,
  base_custody_start_at timestamptz,
  created_at            timestamptz not null,
  updated_at            timestamptz not null
);

-- Bloqueo efectivo (`lib/company.isCompanyBlocked`): suspendida o vencida. La fecha
-- de vencimiento se evalúa en la zona horaria de la empresa, no en la del servidor.
create function adex.company_is_operable(p_status text, p_expires_on date, p_timezone text) returns boolean
  language sql stable
  as $$ select p_status <> 'suspendida'
           and (p_expires_on is null or p_expires_on >= (now() at time zone p_timezone)::date) $$;

-- ---------- Identidades (DS-05) ----------
-- Una fila por PERSONA. `id` = `sub` del proveedor de identidad (Supabase Auth:
-- auth.users.id). No guarda contraseña: la gestiona el proveedor (DS-03).
create table adex.identities (
  id         uuid primary key,
  email      text not null check (email = lower(btrim(email)) and position('@' in email) > 1),
  status     text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index identities_email_key on adex.identities (email);

-- ---------- Membresías (User de Dexie, DS-05) ----------
-- Un `User` local es una persona con UN rol en UNA empresa: en el servidor es una
-- membresía. El `id` local se conserva como id de la membresía (lo referencian
-- ventas, pagos, gastos, cuadres y auditoría).
--
-- `identity_id` NULL = membresía histórica o aún no aprovisionada: existe para
-- conservar la trazabilidad, pero no puede iniciar sesión.
--
-- Sin herencia ni acumulación: los permisos se evalúan con UNA membresía activa por
-- operación (contexto explícito); no hay ninguna estructura que una membresías.
create table adex.memberships (
  id                              adex.eid primary key,
  company_id                      adex.eid not null references adex.companies(id),
  identity_id                     uuid references adex.identities(id),
  role                            text not null check (role in ('superadmin', 'admin', 'socio', 'supervisor', 'cobrador', 'secretario')),
  status                          text not null check (status in ('activo', 'inactivo')),
  display_name                    text not null check (length(btrim(display_name)) > 0),
  phone                           text,
  avatar                          text,
  -- LEGADO conservado por fidelidad; `can()` los ignora (modelo ROL + RUTAS).
  legacy_can_create_direct_sales  boolean,
  legacy_max_direct_sale_minor    bigint,
  granted_capabilities            text[] not null default '{}',
  revoked_capabilities            text[] not null default '{}',
  created_at                      timestamptz not null,
  updated_at                      timestamptz not null,
  unique (company_id, id)
);
-- Una persona no tiene dos membresías con el mismo rol en la misma empresa.
create unique index memberships_identity_company_role_key
  on adex.memberships (identity_id, company_id, role) where identity_id is not null;
create index memberships_identity on adex.memberships (identity_id);

-- ---------- Oficinas ----------
create table adex.offices (
  id         adex.eid primary key,
  company_id adex.eid not null references adex.companies(id),
  name       text not null check (length(btrim(name)) > 0),
  code       text,
  status     text not null check (status in ('activa', 'inactiva')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (company_id, id)
);
create unique index offices_company_name_key on adex.offices (company_id, lower(name));
create unique index offices_company_code_key on adex.offices (company_id, lower(code)) where code is not null;

-- ---------- Rutas ----------
create table adex.routes (
  id                               adex.eid primary key,
  company_id                       adex.eid not null references adex.companies(id),
  office_id                        adex.eid,                     -- NULL = "Sin Oficina" (válido y permanente)
  name                             text not null,
  code                             text not null,
  city                             text,
  email                            text,
  phone                            text,
  interest_rate                    numeric(9, 4) not null check (interest_rate >= 0),
  free_rate                        boolean not null,
  max_loan_minor                   bigint not null check (max_loan_minor >= 0),
  initial_capital_minor            bigint not null,
  -- @deprecated en CLEAN (no es la Base). Se conserva por fidelidad; nunca se lee.
  legacy_capital_actual_minor      bigint not null,
  collector_membership_id          adex.eid,                     -- `Route.cobradorId`
  -- Capital por Administrador v16: 0 o 1 responsable por construcción.
  capital_controller_membership_id adex.eid,
  capital_controller_since         timestamptz,
  status                           text not null check (status in ('activa', 'inactiva')),
  created_at                       timestamptz not null,
  updated_at                       timestamptz not null,
  unique (company_id, id),
  foreign key (company_id, office_id)                        references adex.offices(company_id, id),
  foreign key (company_id, collector_membership_id)          references adex.memberships(company_id, id),
  foreign key (company_id, capital_controller_membership_id) references adex.memberships(company_id, id)
);
create index routes_company on adex.routes (company_id);

-- Rutas autorizadas (`User.authorizedRouteIds` ∪ `User.routeId` legado).
-- El SuperAdmin no se limita por esta tabla (`isRouteUnrestricted`).
create table adex.membership_routes (
  company_id    adex.eid not null,
  membership_id adex.eid not null,
  route_id      adex.eid not null,
  primary key (membership_id, route_id),
  foreign key (company_id, membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, route_id)      references adex.routes(company_id, id)
);
create index membership_routes_route on adex.membership_routes (company_id, route_id);
