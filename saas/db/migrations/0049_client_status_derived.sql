-- 0049 · Estado del cliente automático (decisión del propietario y su socio, 2026-11-07).
--   · «Activo» = tiene un crédito activo en este momento; si no, «Inactivo». Nada más decide el estado.
--     Crédito activo = la regla que ADEX ya usa para el segundo crédito (`adex.client_active_credits`, 0010):
--     una venta `activa` o una solicitud APROBADA aún sin entregar (el propietario: «ya cuenta»).
--   · El cambio es automático: cliente nuevo sin crédito → inactivo; recibe o le aprueban un crédito → activo;
--     termina de pagar (o se anula/rechaza/cancela) y no le queda otro → inactivo.
--   · Ya no se fija a mano (la API retira `POST /v1/clients/:id/status`). `moroso` y `perdido` dejan de usarse.
--   · «Inactivo» YA NO impide darle crédito (antes sí: AX504). El propietario: no hace falta otra marca para bloquear
--     a un cliente; quien aprueba decide. Se quita la condición de estado en `sale_requests_guard`, `credit_disburse`
--     y `credit_disburse_late` (el cliente sigue teniendo que ser de la ruta).
--   · Todos los clientes existentes se recalculan una vez (BlueLine incluida): cambia solo la etiqueta, ningún dinero.
--   · Rutas en migración: la edición de un cliente existente no está bloqueada (0043), y las cargas ya escriben sus
--     ventas en la misma transacción: el estado sale solo de los créditos cargados.

-- ---------- El estado que corresponde ----------
create function adex.client_derived_status(p_company text, p_client text) returns text
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select case when exists (select 1 from adex.sales s where s.company_id = p_company and s.client_id = p_client and s.status = 'activa')
                  or exists (select 1 from adex.sale_requests r where r.company_id = p_company and r.client_id = p_client and r.status = 'approved')
                then 'activo' else 'inactivo' end
  $$;
revoke all on function adex.client_derived_status(text, text) from public;

-- Toda alta o edición de un cliente lleva el estado que corresponde (lo que venga en la fila se ignora).
create function adex.clients_status_derive() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$ begin
    new.status := adex.client_derived_status(new.company_id, new.id);
    return new;
  end $$;
revoke all on function adex.clients_status_derive() from public;
-- Nombre posterior a `clients_limited_edit_guard` (orden alfabético): el Secretario sigue sin poder cambiarlo a mano.
create trigger clients_status_derive before insert or update on adex.clients
  for each row execute function adex.clients_status_derive();

-- Alta por la API: misma regla de 0028, pero el cliente nuevo nace «inactivo» (aún no tiene crédito).
alter policy clients_manage_insert on adex.clients
  with check (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id)
              and adex.ctx_is(array['admin', 'supervisor', 'cobrador'])
              and adex.route_operational(company_id, route_id)
              and document_type is not null and status = 'inactivo' and not document_legacy_duplicate);

-- El propietario solo actualiza clientes dentro de `client_status_refresh` (marca de la transacción).
create policy owner_client_status on adex.clients for update to adex_owner
  using (current_setting('adex.client_status', true) = 'derive')
  with check (current_setting('adex.client_status', true) = 'derive');

create function adex.client_status_refresh(p_company text, p_client text) returns void
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  declare v_prev text := current_setting('adex.client_status', true);
  begin
    if p_client is null then return; end if;
    perform set_config('adex.client_status', 'derive', true);
    -- Sin tocar `updated_at`: la fecha de edición del cliente es de sus datos; el estado lo pone el disparador.
    update adex.clients set updated_at = updated_at
     where company_id = p_company and id = p_client and status is distinct from adex.client_derived_status(p_company, p_client);
    perform set_config('adex.client_status', coalesce(v_prev, ''), true);
  end $$;
revoke all on function adex.client_status_refresh(text, text) from public;

-- Ventas y solicitudes: al nacer, cambiar de estado o de cliente, o borrarse, se recalcula el cliente.
create function adex.credit_client_status_sync() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$ begin
    if tg_op in ('UPDATE', 'DELETE') then perform adex.client_status_refresh(old.company_id, old.client_id); end if;
    if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.client_id is distinct from old.client_id or new.status is distinct from old.status) then
      perform adex.client_status_refresh(new.company_id, new.client_id);
    end if;
    return null;
  end $$;
revoke all on function adex.credit_client_status_sync() from public;
create trigger sales_client_status after insert or update of status, client_id or delete on adex.sales
  for each row execute function adex.credit_client_status_sync();
create trigger sale_requests_client_status after insert or update of status, client_id or delete on adex.sale_requests
  for each row execute function adex.credit_client_status_sync();

-- ---------- «Inactivo» ya no impide el crédito ----------
-- Se reescriben las tres funciones vigentes con la misma definición, sin la condición de estado del cliente.
do $$
declare
  f   record;
  def text;
  n   int := 0;
begin
  for f in select p.oid, p.proname from pg_proc p
            where p.pronamespace = 'adex'::regnamespace and p.prosrc like '%from adex.clients c where%c.status = ''activo''%' loop
    if f.proname not in ('sale_requests_guard', 'credit_disburse', 'credit_disburse_late') then
      raise exception '0049: unexpected function with the client status check: %', f.proname;
    end if;
    def := pg_get_functiondef(f.oid);
    if (length(def) - length(replace(def, ' and c.status = ''activo''', ''))) / length(' and c.status = ''activo''') <> 1 then
      raise exception '0049: % should contain the client status check exactly once', f.proname;
    end if;
    execute replace(def, ' and c.status = ''activo''', '');
    n := n + 1;
  end loop;
  if n <> 3 then raise exception '0049: expected 3 functions with the client status check, found %', n; end if;
end $$;

-- ---------- Recalcular todos los clientes una vez ----------
select set_config('adex.client_status', 'derive', true);
update adex.clients set updated_at = updated_at
 where status is distinct from adex.client_derived_status(company_id, id);
select set_config('adex.client_status', '', true);
