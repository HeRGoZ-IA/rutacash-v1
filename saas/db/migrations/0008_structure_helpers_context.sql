-- ============================================================
-- ADEX SaaS · Fase 2 · 0008 · Funciones auxiliares de 0007 atadas al contexto
-- ------------------------------------------------------------
-- Defensa en profundidad (DS-15). Las funciones SECURITY DEFINER de 0007 reciben la
-- empresa como parámetro porque las usan políticas RLS, disparadores y la
-- importación. Usadas por la API (`session_user = adex_api`) SIN contexto válido, o
-- con una empresa distinta de la del contexto, no deben revelar nada de otra empresa
-- (ni booleanos de estado, ni roles, ni nombres de referencias). El administrador del
-- proyecto (importación, migraciones) no cambia: no es `adex_api`.
--
-- `session_user` no cambia dentro de SECURITY DEFINER (sí `current_user`), así que
-- identifica la conexión de la API también a través del pooler.
-- ============================================================

create function adex.api_scope_ok(p_company text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select session_user <> 'adex_api' or (p_company = adex.ctx_company() and adex.ctx_membership_active()) $$;

create or replace function adex.company_country(p_company_id text) returns char(2)
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select country_code from adex.companies where id = p_company_id and adex.api_scope_ok(p_company_id) $$;

create or replace function adex.route_operational(p_company text, p_route text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select adex.api_scope_ok(p_company) and exists (
      select 1 from adex.routes r left join adex.offices o on o.company_id = r.company_id and o.id = r.office_id
       where r.company_id = p_company and r.id = p_route and r.status = 'activa'
         and coalesce(o.status, 'activa') <> 'inactiva')
  $$;

create or replace function adex.membership_active_role(p_company text, p_membership text) returns text
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select m.role from adex.memberships m
     where m.company_id = p_company and m.id = p_membership and m.status = 'activo' and adex.api_scope_ok(p_company)
  $$;

-- La comprobación del COMMIT (v16) usa una función INTERNA, sin restricción de
-- alcance y sin EXECUTE para la API: nunca puede volverse «válida por defecto»
-- (p. ej. si el actor pierde su contexto dentro de la misma transacción).
create function adex.route_controller_valid_internal(p_company text, p_route text) returns boolean
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
revoke all on function adex.route_controller_valid_internal(text, text) from public;

create or replace function adex.assert_route_controllers() returns trigger
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
      if not adex.route_controller_valid_internal(v_company, v_route) then
        raise exception 'adex: route % capital controller is not an active Administrator assigned to it', v_route
          using errcode = 'AX101';
      end if;
    end loop;
    return null;
  end $$;

-- Versión consultable por la API: solo dentro de su contexto (fuera de él, NULL).
create or replace function adex.route_controller_valid(p_company text, p_route text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select case when adex.api_scope_ok(p_company) then adex.route_controller_valid_internal(p_company, p_route) end $$;

create or replace function adex.protected_references(p_table regclass, p_company text, p_id text) returns text[]
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    fk record;
    found_refs text[] := '{}';
    hit boolean;
  begin
    if (adex.ctx_company() is not null and p_company is distinct from adex.ctx_company()) or not adex.api_scope_ok(p_company) then
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
    if p_table = 'adex.memberships'::regclass and exists (
         select 1 from adex.audit_log a
          where a.company_id = p_company and a.entity_type = 'membership' and a.entity_id = p_id
            and a.action not in ('CREATE_USER', 'UPDATE_USER')) then
      found_refs := found_refs || 'audit_log.entity_id'::text;
    end if;
    return found_refs;
  end $$;

grant execute on function adex.api_scope_ok(text) to adex_api;
