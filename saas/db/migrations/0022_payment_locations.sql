-- ============================================================
-- 0022 · Ubicación del cobro (Ronda 48 · D-UX48-02/03)
-- ============================================================
-- Al registrar un abono, ADEX Online pide la ubicación del dispositivo y la guarda como
-- EVIDENCIA COMPLEMENTARIA del cobro (no prueba infalible de presencia).
--
-- Diseño:
--   · Tabla APARTE del libro de pagos: `adex.payments` y `adex.collection_post` no se
--     tocan. La ubicación se escribe en la MISMA transacción del abono, después de
--     `collection_post`, y bajo un SAVEPOINT en la API: si fallara, el abono legítimo
--     NO se revierte (queda sin ubicación).
--   · Una fila por pago como máximo (clave primaria). La idempotencia la da
--     `adex.operations`: un reintento con el mismo id devuelve el resultado guardado y
--     no vuelve a escribir nada.
--   · Siempre se guarda el ESTADO: `captured` con coordenadas reales, o la causa de la
--     ausencia (`denied`, `unavailable`, `timeout`, `unsupported`) y `invalid` cuando el
--     servidor descartó una lectura malformada. Nunca coordenadas inventadas.
--   · Solo la escribe quien REGISTRÓ ese abono (`created_by_membership_id`), en su
--     empresa y en una ruta de su alcance (RLS + guarda). Historia: sin UPDATE ni DELETE.
--   · SIN lectura por la API ni por el plano Owner (adex_control no tiene acceso al
--     esquema `adex`): quién puede consultar coordenadas y por cuánto tiempo se
--     conservan son decisiones PENDIENTES del propietario.

create table adex.payment_locations (
  company_id                 adex.eid not null references adex.companies(id),
  payment_id                 adex.eid not null,
  route_id                   adex.eid not null,
  captured_by_membership_id  adex.eid not null,
  status                     text not null check (status in ('captured', 'denied', 'unavailable', 'timeout', 'unsupported', 'invalid')),
  lat                        double precision check (lat between -90 and 90),
  lng                        double precision check (lng between -180 and 180),
  accuracy_m                 integer check (accuracy_m between 0 and 100000),
  device_captured_at         timestamptz,
  reason                     text check (char_length(reason) <= 200),
  received_at                timestamptz not null,
  primary key (company_id, payment_id),
  foreign key (company_id, payment_id)                references adex.payments(company_id, id),
  foreign key (company_id, route_id)                  references adex.routes(company_id, id),
  foreign key (company_id, captured_by_membership_id) references adex.memberships(company_id, id),
  -- Coordenadas solo con posición real; nunca a medias.
  check ((status = 'captured') = (lat is not null and lng is not null)),
  check (status = 'captured' or (accuracy_m is null and device_captured_at is null))
);

comment on table adex.payment_locations is
  'Ubicación del dispositivo al registrar un abono (evidencia complementaria, dato no confiable). Ronda 48.';

alter table adex.payment_locations enable row level security;
alter table adex.payment_locations force row level security;

-- SECURITY INVOKER: valida como quien escribe. La importación del propietario no pasa por aquí.
create function adex.payment_location_guard() returns trigger
  language plpgsql
  as $$
  begin
    if current_user <> 'adex_api' then
      return new;
    end if;
    -- El abono existe en esa empresa y ruta, está vigente y lo registró ESTA membresía.
    if not exists (select 1 from adex.payments p
                    where p.company_id = new.company_id and p.id = new.payment_id and p.route_id = new.route_id
                      and coalesce(p.state, 'active') = 'active'
                      and p.created_by_membership_id = new.captured_by_membership_id) then
      raise exception 'adex: payment location must belong to an active payment registered by the same membership' using errcode = 'AX801';
    end if;
    -- La hora de recepción la pone el servidor, no el cliente.
    new.received_at := now();
    return new;
  end $$;

create trigger payment_locations_guard before insert on adex.payment_locations
  for each row execute function adex.payment_location_guard();

create policy payment_locations_insert on adex.payment_locations for insert to adex_api
  with check (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id) and adex.ctx_can('payment.register')
              and captured_by_membership_id = adex.ctx_membership());

grant insert (company_id, payment_id, route_id, captured_by_membership_id, status, lat, lng, accuracy_m,
              device_captured_at, reason, received_at) on adex.payment_locations to adex_api;

-- Historia: nada se corrige ni se borra.
create trigger payment_locations_append_only before update on adex.payment_locations
  for each row execute function adex.reject_mutation();
create trigger payment_locations_no_delete before delete on adex.payment_locations
  for each statement execute function adex.reject_mutation();
create trigger payment_locations_no_truncate before truncate on adex.payment_locations
  for each statement execute function adex.reject_mutation();
