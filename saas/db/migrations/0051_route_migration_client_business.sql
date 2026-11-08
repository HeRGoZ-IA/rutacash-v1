-- 0051: la carga de migración de rutas guarda el NEGOCIO del cliente y sus observaciones (pedido de Helmer, 2026-11-08).
--
-- En el sistema anterior los cobradores escribían el negocio pegado al nombre («JOSÉ ROCHA - PIZZARIA»). Los lectores
-- (saas/scripts/migracion/nombres.py) ahora los separan y mandan en cada cliente:
--   business  → adex.clients.business (vacío = sin negocio);
--   notes     → se suma a las observaciones, después de «Cliente migrado (código X)» (p. ej. «Recomendado por Renato»).
-- Solo cambia el alta de clientes nuevos en adex.route_migration_load; los clientes ya cargados se saltan por código,
-- así que lo corregido a mano en BlueLine se mantiene. Misma técnica que 0049: se reescribe la definición vigente.

do $$
declare
  f   regprocedure;
  def text;
  a1  constant text := 'address_primary, address_secondary, status, notes, created_at, updated_at)';
  b1  constant text := 'address_primary, address_secondary, status, notes, business, created_at, updated_at)';
  a2  constant text := '''inactivo'', ''Cliente migrado (código '' || (c ->> ''code'') || '')'', now(), now());';
  b2  constant text := '''inactivo'', ''Cliente migrado (código '' || (c ->> ''code'') || '')''
                || coalesce(E''\n'' || nullif(btrim(coalesce(c ->> ''notes'', '''')), ''''), ''''),
              nullif(btrim(coalesce(c ->> ''business'', '''')), ''''), now(), now());';
begin
  select p.oid::regprocedure into strict f from pg_proc p
   where p.pronamespace = 'adex'::regnamespace and p.proname = 'route_migration_load';
  def := pg_get_functiondef(f);
  if (length(def) - length(replace(def, a1, ''))) / length(a1) <> 1 or (length(def) - length(replace(def, a2, ''))) / length(a2) <> 1 then
    raise exception '0051: route_migration_load should contain the client insert exactly once';
  end if;
  execute replace(replace(def, a1, b1), a2, b2);
end $$;
