-- ============================================================
-- ADEX SaaS · Fase 2 · 0007 · Estructura y catálogo multiempresa
-- ------------------------------------------------------------
-- Autorizada por el propietario (Fase 2: estructura y catálogo; sin comandos
-- financieros). Oficinas, rutas (con responsable de capital), asignaciones,
-- categorías de gasto, clientes y datos de la empresa pasan a COMANDOS de la API
-- de empresa. Este archivo pone las barreras que ninguna escritura puede saltarse:
--
--   · DS-10 (aprobada): documento del cliente ÚNICO por (empresa, tipo, número
--     normalizado). Índice único: dos altas simultáneas no pueden crear el mismo
--     documento. La normalización la hace PostgreSQL (disparador) y el documento
--     original se conserva tal cual. No se fusiona nada ni se inventan documentos.
--   · DS-11 (aprobada): clientes, membresías (trabajadores), rutas, Oficinas y
--     categorías con historia o referencias protegidas NO se borran físicamente,
--     tampoco por el SuperAdmin ni por el administrador de la base. La historia se
--     deriva del catálogo de claves foráneas (una tabla nueva queda protegida sin
--     tocar esta lista) y, para las membresías, de su rastro de auditoría.
--   · Capital por Administrador v16: el responsable de capital de una ruta es NULL o
--     un Administrador ACTIVO asignado a ella, comprobado al COMMIT de cualquier
--     transacción (`withCapitalControllerGuard` como restricción transaccional).
--   · Entidades inactivas: no reciben operaciones nuevas incompatibles.
--   · Escrituras de la API de empresa (`adex_api`) por tabla y columna, con RLS como
--     segunda barrera. El plano Owner no gana ningún privilegio.
--
-- Los traspasos ROUTE_CONTROL_TRANSFER que acompañan un cambio de responsable (regla
-- v16 aprobada) son la ÚNICA escritura en el libro de capital que se habilita aquí:
-- no crean ni destruyen dinero, solo cambian la bolsa que responde por la ruta.
-- ============================================================

-- ---------- Lectura completa para las funciones del propietario ----------
-- Las comprobaciones de historia (DS-11) y de estado corren como `adex_owner`
-- (SECURITY DEFINER, sin login). Con RLS FORZADA, sin estas políticas el
-- propietario vería CERO filas y una entidad con historia parecería no tenerla.
-- Las funciones solo devuelven nombres de referencias o booleanos.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'adex' loop
    if not exists (select 1 from pg_policies p
                    where p.schemaname = 'adex' and p.tablename = t and 'adex_owner' = any(p.roles) and p.cmd in ('SELECT', 'ALL')) then
      execute format('create policy owner_history_read on adex.%I for select to adex_owner using (true)', t);
    end if;
  end loop;
end $$;

-- ============================================================
-- DS-10 · Documento del cliente
-- ============================================================

-- Tipos de documento por país (ISO 3166-1). Catálogo inicial ampliable con una
-- migración. `normalization`:
--   digits → se quitan separadores (espacio . - /); lo que queda deben ser dígitos.
--   alnum  → se quitan separadores y se pasa a mayúsculas; lo que queda, [A-Z0-9].
-- Nunca se quitan letras ni dígitos: un documento con caracteres ajenos al tipo se
-- RECHAZA en vez de «arreglarse» (cambiaría su significado). Ceros a la izquierda se
-- conservan. No se valida dígito verificador (no lo exige DS-10).
create table adex.document_types (
  country_code  char(2) not null check (country_code ~ '^[A-Z]{2}$'),
  code          text    not null check (code ~ '^[A-Z][A-Z0-9_]{1,15}$'),
  label         text    not null,
  normalization text    not null check (normalization in ('digits', 'alnum')),
  min_length    smallint not null check (min_length >= 1),
  max_length    smallint not null check (max_length >= min_length and max_length <= 30),
  primary key (country_code, code)
);
insert into adex.document_types (country_code, code, label, normalization, min_length, max_length) values
  ('BR', 'CPF',  'CPF',                               'digits', 11, 11),
  ('BR', 'CNPJ', 'CNPJ',                              'digits', 14, 14),
  ('BR', 'RG',   'RG',                                'alnum',   5, 14),
  ('BR', 'RNM',  'RNM (Registro Nacional Migratório)', 'alnum',   7, 10),
  ('BR', 'PAS',  'Passaporte',                        'alnum',   5, 20),
  ('CO', 'CC',   'Cédula de ciudadanía',              'digits',  3, 10),
  ('CO', 'CE',   'Cédula de extranjería',             'alnum',   3, 15),
  ('CO', 'NIT',  'NIT',                               'digits',  5, 15),
  ('CO', 'PPT',  'Permiso por Protección Temporal',   'alnum',   5, 15),
  ('CO', 'PAS',  'Pasaporte',                         'alnum',   5, 20);
alter table adex.document_types enable row level security;
alter table adex.document_types force row level security;
create policy document_types_read on adex.document_types for select to adex_api, adex_owner using (true);

-- Normalización determinista. Sin tipo (`NULL`, solo clientes importados de CLEAN
-- que nunca declararon tipo): la regla EXACTA de CLEAN (`normalizeDoc`: sin
-- espacios, puntos ni guiones, en minúsculas). Devuelve NULL si no queda nada.
create function adex.normalize_document(p_normalization text, p_raw text) returns text
  language sql immutable
  as $$
    select nullif(case p_normalization
                    when 'digits' then regexp_replace(coalesce(p_raw, ''), '[[:space:].\-/]', '', 'g')
                    when 'alnum'  then upper(regexp_replace(coalesce(p_raw, ''), '[[:space:].\-/]', '', 'g'))
                    else lower(regexp_replace(coalesce(p_raw, ''), '[[:space:].\-]', '', 'g'))
                  end, '')
  $$;

alter table adex.clients
  add column document_type text check (document_type ~ '^[A-Z][A-Z0-9_]{1,15}$'),
  add column document_normalized text,
  -- Duplicado HISTÓRICO marcado en una importación (Fase 7): se conserva sin fusionar
  -- y queda fuera de la unicidad. La API no puede escribir esta columna.
  add column document_legacy_duplicate boolean not null default false;

-- Normaliza los clientes ya existentes (sin tipo: regla de CLEAN), antes del
-- disparador. Con RLS forzada el propietario necesita una política de UPDATE
-- solo durante esta migración.
create policy owner_document_backfill on adex.clients for update to adex_owner using (true) with check (true);
update adex.clients set document_normalized = adex.normalize_document(null, document);
drop policy owner_document_backfill on adex.clients;

create function adex.company_country(p_company_id text) returns char(2)
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select country_code from adex.companies where id = p_company_id $$;

-- SECURITY INVOKER: `current_user` es quien escribe. La API (`adex_api`) siempre
-- declara el tipo; los clientes importados sin tipo conservan su documento.
create function adex.clients_document_guard() returns trigger
  language plpgsql
  as $$
  declare
    dt adex.document_types%rowtype;
    norm text;
  begin
    if tg_op = 'UPDATE' and new.document is not distinct from old.document
       and new.document_type is not distinct from old.document_type then
      new.document_normalized := old.document_normalized;
      return new;
    end if;
    if new.document_type is null then
      if current_user = 'adex_api' then
        raise exception 'adex: a client document needs its document type' using errcode = 'AX201';
      end if;
      new.document_normalized := adex.normalize_document(null, new.document);
      return new;
    end if;
    select * into dt from adex.document_types t
     where t.country_code = adex.company_country(new.company_id) and t.code = new.document_type;
    if not found then
      raise exception 'adex: document type % is not valid for the company country', new.document_type using errcode = 'AX201';
    end if;
    norm := adex.normalize_document(dt.normalization, new.document);
    if norm is null
       or (dt.normalization = 'digits' and norm !~ '^[0-9]+$')
       or (dt.normalization = 'alnum'  and norm !~ '^[A-Z0-9]+$')
       or length(norm) not between dt.min_length and dt.max_length then
      raise exception 'adex: document is not a valid %', new.document_type using errcode = 'AX202';
    end if;
    new.document_normalized := norm;
    return new;
  end $$;
create trigger clients_document_guard before insert or update on adex.clients
  for each row execute function adex.clients_document_guard();

-- LA barrera de DS-10. Concurrencia: dos transacciones que insertan la misma clave
-- se serializan en el índice; la segunda falla con 23505 al confirmar la primera.
create unique index clients_document_key
  on adex.clients (company_id, coalesce(document_type, ''), document_normalized)
  where document_normalized is not null and not document_legacy_duplicate;

-- ============================================================
-- DS-11 · Historia protegida: sin borrado físico
-- ============================================================

-- Referencias a (p_company, p_id) en `p_table`, derivadas del catálogo de claves
-- foráneas COMPUESTAS (company_id, x) → (company_id, id). Devuelve «tabla.columna»
-- de cada referencia existente. VOLATILE: dentro del disparador de borrado cada
-- consulta toma una instantánea nueva y ve lo confirmado mientras esperaba el bloqueo.
create function adex.protected_references(p_table regclass, p_company text, p_id text) returns text[]
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    fk record;
    found_refs text[] := '{}';
    hit boolean;
  begin
    if adex.ctx_company() is not null and p_company is distinct from adex.ctx_company() then
      raise exception 'adex: history of another company is not visible' using errcode = '42501';
    end if;
    for fk in
      select c.conrelid::regclass as src,
             (select a.attname from unnest(c.conkey, c.confkey) k(src_att, dst_att)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.src_att
                join pg_attribute d on d.attrelid = c.confrelid and d.attnum = k.dst_att
               where d.attname = 'id') as id_col,
             (select a.attname from unnest(c.conkey, c.confkey) k(src_att, dst_att)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.src_att
                join pg_attribute d on d.attrelid = c.confrelid and d.attnum = k.dst_att
               where d.attname = 'company_id') as company_col
        from pg_constraint c
       where c.contype = 'f' and c.confrelid = p_table
       order by 1, 2
    loop
      if fk.id_col is null then continue; end if;
      if fk.company_col is null then
        execute format('select exists (select 1 from %s where %I = $1)', fk.src, fk.id_col) into hit using p_id;
      else
        execute format('select exists (select 1 from %s where %I = $1 and %I = $2)', fk.src, fk.company_col, fk.id_col)
          into hit using p_company, p_id;
      end if;
      if hit then found_refs := found_refs || format('%s.%s', fk.src, fk.id_col); end if;
    end loop;
    -- Membresías: además de las FK (actor de auditoría, asignaciones, movimientos…),
    -- cuenta como historia toda decisión auditada SOBRE la persona salvo su alta y la
    -- edición de sus datos de contacto (estado, rutas, rol).
    if p_table = 'adex.memberships'::regclass and exists (
         select 1 from adex.audit_log a
          where a.company_id = p_company and a.entity_type = 'membership' and a.entity_id = p_id
            and a.action not in ('CREATE_USER', 'UPDATE_USER')) then
      found_refs := found_refs || 'audit_log.entity_id'::text;
    end if;
    return found_refs;
  end $$;

create function adex.guard_protected_delete() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  declare refs text[];
  begin
    refs := adex.protected_references(tg_relid::regclass, old.company_id, old.id);
    if cardinality(refs) > 0 then
      raise exception 'adex: % % has protected history (%)', tg_table_name, old.id, array_to_string(refs, ', ')
        using errcode = '2BP01';
    end if;
    return old;
  end $$;

do $$
declare t text;
begin
  foreach t in array array['clients', 'memberships', 'routes', 'offices', 'expense_categories'] loop
    execute format('create trigger %I before delete on adex.%I for each row execute function adex.guard_protected_delete()',
                   t || '_protected_delete', t);
    -- Ni masivo ni en cascada: TRUNCATE no dispara reglas por fila.
    execute format('create trigger %I before truncate on adex.%I for each statement execute function adex.reject_mutation()',
                   t || '_no_truncate', t);
  end loop;
end $$;

-- Borrar una membresía también es una vía de REVOCACIÓN (REVOKE-004): toma el
-- bloqueo exclusivo antes de la comprobación de historia (orden alfabético).
create function adex.revoke_lock_membership_delete() returns trigger
  language plpgsql
  as $$ begin
    perform pg_advisory_xact_lock(adex.lock_key('membership', old.id));
    return old;
  end $$;
create trigger memberships_lock_before_delete before delete on adex.memberships
  for each row execute function adex.revoke_lock_membership_delete();

-- ============================================================
-- Entidades inactivas: sin operaciones nuevas incompatibles
-- ============================================================

-- ¿La ruta admite operaciones NUEVAS? Activa y sin Oficina inactiva
-- (`isRouteOperationBlocked` de CLEAN + estado de la ruta).
create function adex.route_operational(p_company text, p_route text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select exists (select 1 from adex.routes r left join adex.offices o on o.company_id = r.company_id and o.id = r.office_id
                    where r.company_id = p_company and r.id = p_route and r.status = 'activa'
                      and coalesce(o.status, 'activa') <> 'inactiva')
  $$;

-- Código siguiente de ruta (`RT-001`…, forma de RoutesPage) sobre TODAS las rutas de
-- la empresa del contexto, sin depender del alcance del actor.
create function adex.next_route_code(p_company text) returns text
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select 'RT-' || lpad((coalesce(max(substring(code from '^RT-([0-9]+)$')::int), 0) + 1)::text, 3, '0')
      from adex.routes where company_id = p_company and p_company = adex.ctx_company() and code ~ '^RT-[0-9]+$'
  $$;

create function adex.membership_active_role(p_company text, p_membership text) returns text
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select m.role from adex.memberships m where m.company_id = p_company and m.id = p_membership and m.status = 'activo' $$;

-- Mover un cliente a otra ruta es colocarlo de nuevo: la ruta destino debe operar.
-- (El alta lo exige la política de inserción de la API; las importaciones conservan
-- el histórico tal cual.)
create function adex.clients_route_guard() returns trigger
  language plpgsql
  as $$ begin
    if new.route_id is distinct from old.route_id and not adex.route_operational(new.company_id, new.route_id) then
      raise exception 'adex: route % does not accept new clients', new.route_id using errcode = 'AX301';
    end if;
    return new;
  end $$;
create trigger clients_route_guard before update of route_id on adex.clients
  for each row execute function adex.clients_route_guard();

-- Cobrador responsable NUEVO: activo y con rol Cobrador (`validateCobradorInvariant`).
create function adex.routes_collector_guard() returns trigger
  language plpgsql
  as $$ begin
    if new.collector_membership_id is not null
       and new.collector_membership_id is distinct from old.collector_membership_id
       and adex.membership_active_role(new.company_id, new.collector_membership_id) is distinct from 'cobrador' then
      raise exception 'adex: route collector must be an active Cobrador' using errcode = 'AX302';
    end if;
    return new;
  end $$;
create trigger routes_collector_guard before update of collector_membership_id on adex.routes
  for each row execute function adex.routes_collector_guard();

-- El Secretario edita SOLO datos operativos (`client.editLimited`): segunda barrera.
create function adex.clients_limited_edit_guard() returns trigger
  language plpgsql
  as $$ begin
    if current_user = 'adex_api' and adex.ctx_role() = 'secretario'
       and (new.document, new.document_type, new.route_id, new.status, new.document_photo_url, new.business_photo_url)
           is distinct from (old.document, old.document_type, old.route_id, old.status, old.document_photo_url, old.business_photo_url) then
      raise exception 'adex: limited client edit cannot change document, route, status or photos' using errcode = '42501';
    end if;
    return new;
  end $$;
create trigger clients_limited_edit_guard before update on adex.clients
  for each row execute function adex.clients_limited_edit_guard();

-- ============================================================
-- Capital por Administrador v16: responsable válido al COMMIT
-- ============================================================

-- NULL o Administrador ACTIVO de la empresa asignado a la ruta (`isValidCapitalController`).
create function adex.route_controller_valid(p_company text, p_route text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select coalesce((
      select r.capital_controller_membership_id is null or exists (
               select 1 from adex.memberships m
                 join adex.membership_routes mr on mr.membership_id = m.id and mr.route_id = r.id
                where m.company_id = r.company_id and m.id = r.capital_controller_membership_id
                  and m.role = 'admin' and m.status = 'activo')
        from adex.routes r where r.company_id = p_company and r.id = p_route), true)
  $$;

create function adex.assert_route_controllers() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text;
    v_routes text[];
    v_route text;
  begin
    if tg_table_name = 'routes' then
      v_company := new.company_id;
      v_routes := array[new.id::text];
    elsif tg_table_name = 'membership_routes' then
      if tg_op = 'DELETE' then
        v_company := old.company_id; v_routes := array[old.route_id::text];
      else
        v_company := new.company_id; v_routes := array[new.route_id::text];
      end if;
    else
      v_company := old.company_id;
      select coalesce(array_agg(ro.id::text), '{}') into v_routes
        from adex.routes ro where ro.company_id = old.company_id and ro.capital_controller_membership_id = old.id;
    end if;
    foreach v_route in array v_routes loop
      if not adex.route_controller_valid(v_company, v_route) then
        raise exception 'adex: route % capital controller is not an active Administrator assigned to it', v_route
          using errcode = 'AX101';
      end if;
    end loop;
    return null;
  end $$;

create constraint trigger routes_controller_valid after insert or update of capital_controller_membership_id on adex.routes
  deferrable initially deferred for each row execute function adex.assert_route_controllers();
create constraint trigger membership_routes_controller_valid after insert or delete on adex.membership_routes
  deferrable initially deferred for each row execute function adex.assert_route_controllers();
create constraint trigger memberships_controller_valid after update of status, role on adex.memberships
  deferrable initially deferred for each row execute function adex.assert_route_controllers();

-- ============================================================
-- Categorías de gasto
-- ============================================================
-- Nombre único por empresa sin distinguir mayúsculas ni espacios extremos (regla de
-- `ExpenseCategoriesPage`), impuesto también ante altas simultáneas.
create unique index expense_categories_company_name_key on adex.expense_categories (company_id, lower(btrim(name)));

-- Las categorías predeterminadas nacen con la empresa (CLEAN:
-- `buildDefaultExpenseCategories` dentro de `createCompanyWithFirstSuperAdmin`).
-- Mismos nombres que `DEFAULT_EXPENSE_CATEGORY_NAMES` (lo comprueba CAT-001).
create policy owner_category_insert on adex.expense_categories for insert to adex_owner with check (true);

create or replace function adex_control.create_company(
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
    insert into adex.expense_categories (id, company_id, name, active)
    select gen_random_uuid()::text, p_id, n, true
      from unnest(array['Transporte', 'Alimentación', 'Papelería', 'Combustible', 'Comunicación', 'Mantenimiento', 'Otros']) n;
    insert into adex_control.company_control (company_id, name, tax_id, contact_name, contact_email, created_at, status,
                                              route_count, billable_route_count, billing_mode, billing_rate, payment_status, updated_at)
    values (p_id, p_name, p_tax_id, p_contact, lower(btrim(p_email)), now(), 'trial', 0, 0, p_billing_mode, p_billing_rate, 'pending', now());
    insert into adex_control.control_events (id, company_id, type, at, detail)
    values (gen_random_uuid()::text, p_id, 'COMPANY_CREATED', now(), p_name);
  end $$;

-- ============================================================
-- Escrituras de la API de empresa (Fase 2)
-- ============================================================
-- Primera barrera: la API (`can()` de CLEAN, jerarquía, alcance por rutas, reglas de
-- negocio). Segunda barrera: estas políticas. Toda escritura exige un contexto válido
-- (`ctx_role()` es NULL sin él) y la empresa del contexto.

create function adex.ctx_is(p_roles text[]) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select coalesce(adex.ctx_role() = any(p_roles), false) $$;

-- Empresa: datos de contacto (SuperAdmin y Administrador, `settings.access`). Estado,
-- vencimiento, plan, país y moneda NO: son del plano Owner (DS-17) o estructurales.
create policy companies_settings_update on adex.companies for update to adex_api
  using (id = adex.ctx_company() and adex.ctx_is(array['superadmin', 'admin']))
  with check (id = adex.ctx_company());

-- Oficinas (`office.*`: SuperAdmin y Administrador).
create policy offices_manage_insert on adex.offices for insert to adex_api
  with check (company_id = adex.ctx_company() and adex.ctx_is(array['superadmin', 'admin']));
create policy offices_manage_update on adex.offices for update to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_is(array['superadmin', 'admin']))
  with check (company_id = adex.ctx_company());
create policy offices_manage_delete on adex.offices for delete to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_is(array['superadmin', 'admin']));

-- Rutas. Alta: SuperAdmin o Administrador (que queda autoasignado en la misma
-- transacción). Edición: además, ruta dentro del alcance. Borrado: solo SuperAdmin.
create policy routes_manage_insert on adex.routes for insert to adex_api
  with check (company_id = adex.ctx_company() and adex.ctx_is(array['superadmin', 'admin'])
              and status = 'activa' and capital_controller_membership_id is null
              and initial_capital_minor = 0 and legacy_capital_actual_minor = 0
              and (collector_membership_id is null
                   or adex.membership_active_role(company_id, collector_membership_id) = 'cobrador'));
create policy routes_manage_update on adex.routes for update to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_is(array['superadmin', 'admin']) and adex.ctx_route_allowed(id))
  with check (company_id = adex.ctx_company());
create policy routes_manage_delete on adex.routes for delete to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_is(array['superadmin']));

-- Membresías: borrado físico solo SuperAdmin y nunca la propia (DS-11 decide el resto).
create policy memberships_manage_delete on adex.memberships for delete to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_is(array['superadmin']) and id <> adex.ctx_membership());

-- Una membresía inactiva no recibe rutas nuevas.
create policy membership_routes_active_only on adex.membership_routes as restrictive for insert to adex_api
  with check (adex.membership_active_role(company_id, membership_id) is not null);

-- Categorías de gasto (pantalla de Administrador/SuperAdmin, `settings.access`).
create policy expense_categories_manage_insert on adex.expense_categories for insert to adex_api
  with check (company_id = adex.ctx_company() and adex.ctx_is(array['superadmin', 'admin']));
create policy expense_categories_manage_update on adex.expense_categories for update to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_is(array['superadmin', 'admin']))
  with check (company_id = adex.ctx_company());
create policy expense_categories_manage_delete on adex.expense_categories for delete to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_is(array['superadmin', 'admin']));

-- Clientes. Alta: roles con `client.create`, ruta autorizada y operativa, tipo de
-- documento declarado. Edición: `client.edit` (SuperAdmin, Administrador) o
-- `client.editLimited` (Secretario, campos limitados por disparador). Borrado:
-- SuperAdmin o Administrador de la ruta, y solo sin historia (DS-11).
create policy clients_manage_insert on adex.clients for insert to adex_api
  with check (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id)
              and adex.ctx_is(array['superadmin', 'admin', 'supervisor', 'cobrador'])
              and adex.route_operational(company_id, route_id)
              and document_type is not null and status = 'activo' and not document_legacy_duplicate);
create policy clients_manage_update on adex.clients for update to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id)
         and adex.ctx_is(array['superadmin', 'admin', 'secretario']))
  with check (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id));
create policy clients_manage_delete on adex.clients for delete to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id) and adex.ctx_is(array['superadmin', 'admin']));

-- Responsable de capital (v16): evento + traspaso ROUTE_CONTROL_TRANSFER, sellados con
-- el actor del contexto, en rutas de su alcance. Ningún otro tipo de asiento.
create policy route_capital_controller_events_insert on adex.route_capital_controller_events for insert to adex_api
  with check (company_id = adex.ctx_company() and actor_membership_id = adex.ctx_membership() and actor_system is null
              and actor_role = adex.ctx_role() and adex.ctx_is(array['superadmin', 'admin'])
              and adex.ctx_route_allowed(route_id) and sync_status = 'synced');
create policy capital_ledger_route_control_insert on adex.capital_ledger for insert to adex_api
  with check (company_id = adex.ctx_company() and kind = 'ROUTE_CONTROL_TRANSFER' and related_event_id is not null
              and route_id is not null and adex.ctx_route_allowed(route_id)
              and actor_membership_id = adex.ctx_membership() and actor_system is null and actor_role = adex.ctx_role()
              and adex.ctx_is(array['superadmin', 'admin']) and reverses_id is null and reversal_id is null
              and status = 'aplicado' and sync_status = 'synced');

-- Idempotencia (P3): el comando y su resultado en la MISMA transacción.
create policy operations_insert on adex.operations for insert to adex_api
  with check (company_id = adex.ctx_company() and membership_id = adex.ctx_membership() and adex.ctx_membership_active());
create policy operations_update on adex.operations for update to adex_api
  using (company_id = adex.ctx_company() and membership_id = adex.ctx_membership())
  with check (company_id = adex.ctx_company() and membership_id = adex.ctx_membership());

-- ---------- Privilegios (contrato: src/db/privileges.ts) ----------
grant select on adex.document_types to adex_api;
grant update (name, legal_name, tax_id, email, phone, city, address, contact_name, updated_at) on adex.companies to adex_api;
grant insert (id, company_id, name, code, status, created_at, updated_at) on adex.offices to adex_api;
grant update (name, code, status, updated_at) on adex.offices to adex_api;
grant delete on adex.offices to adex_api;
grant insert (id, company_id, office_id, name, code, city, email, phone, interest_rate, free_rate, max_loan_minor,
              initial_capital_minor, legacy_capital_actual_minor, collector_membership_id, status, created_at, updated_at)
  on adex.routes to adex_api;
grant update (office_id, name, city, email, phone, interest_rate, free_rate, max_loan_minor, collector_membership_id,
              capital_controller_membership_id, capital_controller_since, status, updated_at) on adex.routes to adex_api;
grant delete on adex.routes to adex_api;
grant delete on adex.memberships to adex_api;
grant insert (id, company_id, name, icon, active) on adex.expense_categories to adex_api;
grant update (name, icon, active) on adex.expense_categories to adex_api;
grant delete on adex.expense_categories to adex_api;
grant insert (id, company_id, route_id, name, document, document_type, phone_primary, phone_secondary, address_primary,
              address_secondary, business, document_photo_url, business_photo_url, status, notes, created_at, updated_at)
  on adex.clients to adex_api;
grant update (route_id, name, document, document_type, phone_primary, phone_secondary, address_primary, address_secondary,
              business, document_photo_url, business_photo_url, status, notes, updated_at) on adex.clients to adex_api;
grant delete on adex.clients to adex_api;
grant insert (id, company_id, route_id, kind, from_admin_membership_id, to_admin_membership_id, capital_transferred_minor,
              base_at_change_minor, ledger_entry_id, reason, created_at, actor_membership_id, actor_role, sync_status)
  on adex.route_capital_controller_events to adex_api;
grant insert (id, company_id, kind, amount_minor, from_admin_membership_id, to_admin_membership_id, route_id, related_event_id,
              description, entry_date, created_at, actor_membership_id, actor_role, status, sync_status)
  on adex.capital_ledger to adex_api;
grant insert (company_id, operation_id, kind, request_hash, membership_id, outcome) on adex.operations to adex_api;
grant update (outcome, http_status, result) on adex.operations to adex_api;
grant execute on function adex.normalize_document(text, text), adex.company_country(text),
  adex.protected_references(regclass, text, text), adex.route_operational(text, text),
  adex.membership_active_role(text, text), adex.route_controller_valid(text, text), adex.ctx_is(text[]),
  adex.next_route_code(text) to adex_api;
