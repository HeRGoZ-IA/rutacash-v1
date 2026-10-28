-- 0040 · Tipos de gasto «Para Cobradores» y eliminación que conserva la historia (pendiente 3.14; decisión 2.1.15,
-- propietario 2026-10-27 y 2026-10-28).
--
--   · Un solo catálogo por empresa. El Administrador ve y usa todos los tipos activos; el Cobrador y el Supervisor,
--     solo los marcados «Para Cobradores» (la API lo valida al registrar; el frontend solo los ofrece).
--   · Empresas existentes y nuevas: nacen marcados Transporte, Alimentación y Combustible (los demás, sin marcar).
--     Cada empresa cambia las casillas cuando quiera. Desmarcar no altera los gastos ya registrados.
--   · Eliminar un tipo CON gastos ya no se rechaza: el tipo sale de la lista (deleted_at) y los gastos registrados
--     conservan su tipo y su nombre. Sin gastos se sigue borrando de verdad. El nombre queda libre para otro tipo.
--   · Un gasto capturado SIN CONEXIÓN con un tipo que ya no está disponible para Cobradores se acepta al sincronizar
--     y avisa al Administrador de la ruta (offline_captures.category_outside_list, legible por el Administrador).

-- ---------- A. Columnas del catálogo ----------
alter table adex.expense_categories add column for_collectors boolean;
alter table adex.expense_categories add column deleted_at timestamptz;

-- Nombres que nacen marcados (comparación sin mayúsculas ni espacios; Alimentación con o sin tilde).
create function adex.default_collector_category(p_name text) returns boolean
  language sql immutable set search_path = pg_catalog
  as $$ select lower(btrim(p_name)) in ('transporte', 'alimentación', 'alimentacion', 'combustible') $$;

-- La migración corre como adex_owner (RLS forzada): permiso temporal SOLO para este relleno (como 0007 con los documentos).
create policy owner_category_backfill on adex.expense_categories for all to adex_owner using (true) with check (true);
update adex.expense_categories set for_collectors = adex.default_collector_category(name);
drop policy owner_category_backfill on adex.expense_categories;
alter table adex.expense_categories alter column for_collectors set not null;
alter table adex.expense_categories add constraint expense_categories_deleted_inactive check (deleted_at is null or not active);

-- Toda vía de alta (alta de empresa del Owner, importación, API sin la casilla) recibe el valor por nombre.
create function adex.expense_category_collector_default() returns trigger
  language plpgsql
  as $$ begin
    if new.for_collectors is null then
      new.for_collectors := adex.default_collector_category(new.name);
    end if;
    return new;
  end $$;
create trigger expense_categories_collector_default before insert on adex.expense_categories
  for each row execute function adex.expense_category_collector_default();

-- Un tipo eliminado (con historia) ya no reserva su nombre.
drop index adex.expense_categories_company_name_key;
create unique index expense_categories_company_name_key on adex.expense_categories (company_id, lower(btrim(name))) where deleted_at is null;

grant insert (for_collectors), update (for_collectors, deleted_at) on adex.expense_categories to adex_api;

-- Un tipo eliminado no se edita ni se reactiva (solo la API lo marca, una vez).
create function adex.expense_category_deleted_frozen() returns trigger
  language plpgsql
  as $$ begin
    if old.deleted_at is not null then
      raise exception 'adex: a deleted expense category cannot change' using errcode = 'AX720';
    end if;
    return new;
  end $$;
create trigger expense_categories_deleted_frozen before update on adex.expense_categories
  for each row execute function adex.expense_category_deleted_frozen();

-- Sin EXECUTE para PUBLIC (como las demás funciones del esquema). El disparador de alta llama a
-- default_collector_category con los permisos de quien inserta (adex_api).
revoke all on function adex.default_collector_category(text) from public;
grant execute on function adex.default_collector_category(text) to adex_api;
revoke all on function adex.expense_category_collector_default() from public;
revoke all on function adex.expense_category_deleted_frozen() from public;

-- ---------- B. Aviso de capturas sin conexión con un tipo fuera de la lista ----------
alter table adex.offline_captures add column category_outside_list boolean not null default false;
grant insert (category_outside_list) on adex.offline_captures to adex_api;
grant select on adex.offline_captures to adex_api;

-- El Administrador lee las capturas de SUS rutas (solo para el aviso); nadie más.
create policy offline_captures_admin_read on adex.offline_captures for select to adex_api
  using ((((company_id)::text = adex.ctx_company()) AND (select adex.ctx_membership_active()) AND ((select adex.ctx_role()) = 'admin'::text)
          AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids()))));
