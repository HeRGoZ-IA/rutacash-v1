-- ============================================================
-- 0029 · Mapa de rutas del Administrador (Ronda 67 · Entrega B)
-- ============================================================
-- Dos ubicaciones DISTINTAS, nunca confundidas:
--   1. Ubicación de REFERENCIA del cliente (`adex.client_locations`): dónde se le atiende. La fija
--      a propósito una persona autorizada de la ruta (Administrador, Supervisor o Cobrador), con su
--      ORIGEN declarado: `gps_on_site` (lectura del dispositivo estando en el lugar del cliente) o
--      `map_pin` (punto marcado a mano en el mapa). Historia completa: cada cambio es una fila nueva
--      (quién, cuándo, de dónde); la vigente es la última. Nada se corrige ni se borra.
--   2. Ubicación del DISPOSITIVO al registrar una venta en línea (`adex.sale_locations`): evidencia
--      complementaria, como la del abono (0022). Mismo contrato de estados (`captured` con
--      coordenadas reales, o la causa de su ausencia). NUNCA se copia a la referencia del cliente:
--      una venta registrada desde la oficina no mueve al cliente a la oficina.
-- Lectura (antes nadie podía leer coordenadas, 0022): SOLO el Administrador, en las rutas que
-- tiene autorizadas, para el mapa. Las referencias de cliente las ven además Supervisor y Cobrador
-- de la ruta (para saber si el cliente ya tiene ubicación). El SuperAdmin no lee coordenadas (su
-- cartera es de consulta, 0028) y el plano Owner no tiene acceso al esquema `adex`.
-- Las ventas, los créditos, los abonos y los saldos no cambian: tablas aparte, sin tocar el libro.
-- Conservación de las coordenadas: decisión pendiente del propietario (igual que en 0022).

-- ---------- Capacidades de la base: las de 0028 más la ubicación de referencia ----------
create or replace function adex.ctx_can(p_capability text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select coalesce(adex.ctx_role() = any(case p_capability
      when 'sale.createRequest'               then array['admin', 'supervisor', 'cobrador']
      when 'sale.createDirect'                then array['admin', 'supervisor']
      when 'sale.confirmDisbursement'         then array['admin', 'supervisor', 'cobrador']
      when 'sale.cancel'                      then array['admin']
      when 'authorization.access'             then array['admin', 'supervisor', 'secretario']
      when 'authorization.approve'            then array['admin', 'supervisor', 'secretario']
      when 'authorization.reject'             then array['admin', 'supervisor', 'secretario']
      when 'authorization.modifyConditions'   then array['admin', 'supervisor', 'secretario']
      when 'authorization.phoneConfirm'       then array['supervisor', 'secretario']
      when 'payment.register'                 then array['admin', 'supervisor', 'cobrador']
      when 'payment.reverse'                  then array['admin']
      when 'payment.approveAdjustment'        then array['admin']
      when 'payment.correct'                  then array['admin', 'secretario']
      when 'payment.viewHistory'              then array['superadmin', 'admin', 'supervisor', 'cobrador', 'secretario']
      when 'expense.register'                 then array['superadmin', 'admin', 'supervisor', 'cobrador']
      when 'expense.correct'                  then array['superadmin', 'admin']
      when 'cashCustody.manage'               then array['superadmin', 'admin', 'supervisor']
      when 'cashbox.viewConsolidated'         then array['superadmin', 'admin']
      when 'cashbox.viewRoute'                then array['superadmin', 'admin', 'supervisor']
      when 'cashSettlement.view'              then array['superadmin', 'admin', 'supervisor']
      when 'cashSettlement.viewOwn'           then array['supervisor', 'cobrador']
      when 'cashSettlement.close'             then array['superadmin', 'admin', 'supervisor']
      when 'cashSettlement.reopen'            then array['superadmin', 'admin']
      when 'settlement.close'                 then array['superadmin', 'admin']
      when 'settlement.reopen'                then array['superadmin', 'admin']
      when 'client.setLocation'               then array['admin', 'supervisor', 'cobrador']
      when 'map.view'                         then array['admin']
      else array[]::text[] end), false)
  $$;

-- ---------- 1. Ubicación de referencia del cliente ----------
create table adex.client_locations (
  id                     adex.eid primary key,
  company_id             adex.eid not null references adex.companies(id),
  client_id              adex.eid not null,
  route_id               adex.eid not null,          -- ruta del cliente al fijarla (la lectura usa la vigente)
  source                 text not null check (source in ('gps_on_site', 'map_pin')),
  lat                    double precision not null check (lat between -90 and 90),
  lng                    double precision not null check (lng between -180 and 180),
  accuracy_m             integer check (accuracy_m between 0 and 100000),
  device_captured_at     timestamptz,
  note                   text check (char_length(note) <= 200),
  set_by_membership_id   adex.eid not null,
  set_by_role            text not null,
  created_at             timestamptz not null,
  foreign key (company_id, client_id)            references adex.clients(company_id, id),
  foreign key (company_id, route_id)             references adex.routes(company_id, id),
  foreign key (company_id, set_by_membership_id) references adex.memberships(company_id, id),
  check (not (lat = 0 and lng = 0)),
  -- Solo una lectura del dispositivo trae precisión y hora del dispositivo; un punto marcado a mano, no.
  check (source = 'gps_on_site' or (accuracy_m is null and device_captured_at is null))
);
create index client_locations_current on adex.client_locations (company_id, client_id, created_at desc);

comment on table adex.client_locations is
  'Ubicación de REFERENCIA del cliente (dónde se le atiende), fijada a propósito con su origen. Historia completa; vigente = última. Ronda 67.';

alter table adex.client_locations enable row level security;
alter table adex.client_locations force row level security;

-- SECURITY INVOKER: valida como quien escribe. El cliente existe en esa empresa y está en esa ruta.
create function adex.client_location_guard() returns trigger
  language plpgsql
  as $$
  begin
    if current_user <> 'adex_api' then
      return new;
    end if;
    if not exists (select 1 from adex.clients c
                    where c.company_id = new.company_id and c.id = new.client_id and c.route_id = new.route_id) then
      raise exception 'adex: client location must name the current route of an existing client' using errcode = 'AX802';
    end if;
    -- Hora y rol los pone el servidor, no el cliente.
    new.created_at := now();
    new.set_by_role := adex.ctx_role();
    return new;
  end $$;

create trigger client_locations_guard before insert on adex.client_locations
  for each row execute function adex.client_location_guard();

create policy client_locations_insert on adex.client_locations for insert to adex_api
  with check (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id) and adex.ctx_can('client.setLocation')
              and set_by_membership_id = adex.ctx_membership());
-- Lectura por la ruta VIGENTE del cliente (si cambia de ruta, la ve quien gestiona la nueva). Patrón de
-- 0020: el contexto se evalúa UNA vez por consulta (subconsultas escalares), no por fila.
create policy client_locations_read on adex.client_locations for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active())
         and (select adex.ctx_is(array['admin', 'supervisor', 'cobrador']))
         and exists (select 1 from adex.clients c where c.company_id = client_locations.company_id and c.id = client_locations.client_id
                       and adex.route_in_scope(c.route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids()))));

grant select, insert (id, company_id, client_id, route_id, source, lat, lng, accuracy_m, device_captured_at, note,
                      set_by_membership_id, set_by_role, created_at) on adex.client_locations to adex_api;

create trigger client_locations_append_only before update on adex.client_locations
  for each row execute function adex.reject_mutation();
create trigger client_locations_no_delete before delete on adex.client_locations
  for each statement execute function adex.reject_mutation();
create trigger client_locations_no_truncate before truncate on adex.client_locations
  for each statement execute function adex.reject_mutation();

-- ---------- 2. Ubicación del dispositivo al registrar una venta en línea ----------
create table adex.sale_locations (
  company_id                 adex.eid not null references adex.companies(id),
  entity_kind                text not null check (entity_kind in ('direct_sale', 'credit_request')),
  entity_id                  adex.eid not null,          -- adex.sales.id (venta directa) o adex.sale_requests.id
  route_id                   adex.eid not null,
  client_id                  adex.eid not null,
  captured_by_membership_id  adex.eid not null,
  status                     text not null check (status in ('captured', 'denied', 'unavailable', 'timeout', 'unsupported', 'invalid')),
  lat                        double precision check (lat between -90 and 90),
  lng                        double precision check (lng between -180 and 180),
  accuracy_m                 integer check (accuracy_m between 0 and 100000),
  device_captured_at         timestamptz,
  reason                     text check (char_length(reason) <= 200),
  received_at                timestamptz not null,
  primary key (company_id, entity_kind, entity_id),
  foreign key (company_id, route_id)                  references adex.routes(company_id, id),
  foreign key (company_id, client_id)                 references adex.clients(company_id, id),
  foreign key (company_id, captured_by_membership_id) references adex.memberships(company_id, id),
  check ((status = 'captured') = (lat is not null and lng is not null)),
  check (status = 'captured' or (accuracy_m is null and device_captured_at is null))
);

comment on table adex.sale_locations is
  'Ubicación del DISPOSITIVO al registrar una venta en línea (evidencia complementaria; nunca es la del cliente). Ronda 67.';

alter table adex.sale_locations enable row level security;
alter table adex.sale_locations force row level security;

create function adex.sale_location_guard() returns trigger
  language plpgsql
  as $$
  begin
    if current_user <> 'adex_api' then
      return new;
    end if;
    -- La venta (o la solicitud) existe, es de ese cliente y ruta y la registró ESTA membresía.
    if new.entity_kind = 'direct_sale' and not exists (
         select 1 from adex.sales s where s.company_id = new.company_id and s.id = new.entity_id and s.route_id = new.route_id
           and s.client_id = new.client_id and s.created_by_membership_id = new.captured_by_membership_id) then
      raise exception 'adex: sale location must belong to a sale registered by the same membership' using errcode = 'AX803';
    end if;
    if new.entity_kind = 'credit_request' and not exists (
         select 1 from adex.sale_requests r where r.company_id = new.company_id and r.id = new.entity_id and r.route_id = new.route_id
           and r.client_id = new.client_id and r.requested_by_membership_id = new.captured_by_membership_id) then
      raise exception 'adex: sale location must belong to a request registered by the same membership' using errcode = 'AX803';
    end if;
    new.received_at := now();
    return new;
  end $$;

create trigger sale_locations_guard before insert on adex.sale_locations
  for each row execute function adex.sale_location_guard();

create policy sale_locations_insert on adex.sale_locations for insert to adex_api
  with check (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id)
              and (adex.ctx_can('sale.createDirect') or adex.ctx_can('sale.createRequest'))
              and captured_by_membership_id = adex.ctx_membership());
create policy sale_locations_read on adex.sale_locations for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and (select adex.ctx_can('map.view'))
         and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())));

grant select, insert (company_id, entity_kind, entity_id, route_id, client_id, captured_by_membership_id, status, lat, lng,
                      accuracy_m, device_captured_at, reason, received_at) on adex.sale_locations to adex_api;

create trigger sale_locations_append_only before update on adex.sale_locations
  for each row execute function adex.reject_mutation();
create trigger sale_locations_no_delete before delete on adex.sale_locations
  for each statement execute function adex.reject_mutation();
create trigger sale_locations_no_truncate before truncate on adex.sale_locations
  for each statement execute function adex.reject_mutation();

-- ---------- 3. Ubicación del abono (0022): lectura para el mapa del Administrador ----------
create policy payment_locations_read on adex.payment_locations for select to adex_api
  using (company_id = adex.ctx_company() and (select adex.ctx_membership_active()) and (select adex.ctx_can('map.view'))
         and adex.route_in_scope(route_id, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())));
grant select on adex.payment_locations to adex_api;
