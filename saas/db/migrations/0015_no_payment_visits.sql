-- ============================================================
-- 0015 · Visitas sin pago (ADEX Online: pantalla original «No pagó» de CLEAN)
-- ============================================================
-- La tabla existe desde 0002 (mismo modelo que CLEAN) con lectura por empresa y rutas
-- (0003). Aquí solo se abre el ALTA desde la API, con la segunda barrera en RLS:
--
--   · quien registra es quien visita: `collector_membership_id = ctx_membership()`;
--   · con `payment.register` en una ruta de su alcance (Cobrador, Supervisor,
--     Administrador, SuperAdmin: los que cobran);
--   · la venta debe ser de ESA ruta y de ESE cliente, desembolsada y activa;
--   · la fecha es la de la empresa (el servidor no admite otra).
--
-- Es historia: sin UPDATE ni DELETE (0002 ya rechaza el borrado físico). No mueve dinero.

-- SECURITY INVOKER: `current_user` es quien escribe. Solo las altas de la API se
-- validan; la importación histórica de CLEAN (propietario) conserva sus visitas.
create function adex.no_payment_visit_guard() returns trigger
  language plpgsql
  as $$
  begin
    if current_user <> 'adex_api' then
      return new;
    end if;
    if not exists (select 1 from adex.sales s
                    where s.company_id = new.company_id and s.id = new.sale_id and s.route_id = new.route_id
                      and s.client_id = new.client_id and s.status = 'activa' and s.disbursement_status is distinct from 'pendiente') then
      raise exception 'adex: no-payment visit needs an active disbursed credit of that route and client' using errcode = 'AX701';
    end if;
    if new.visit_date <> adex.company_today(new.company_id) then
      raise exception 'adex: no-payment visit must use the company business date' using errcode = 'AX411';
    end if;
    return new;
  end $$;

create trigger no_payment_visits_guard before insert on adex.no_payment_visits
  for each row execute function adex.no_payment_visit_guard();

create policy no_payment_visits_insert on adex.no_payment_visits for insert to adex_api
  with check (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id) and adex.ctx_can('payment.register')
              and collector_membership_id = adex.ctx_membership() and sync_status = 'synced');

grant insert (id, company_id, sale_id, client_id, route_id, collector_membership_id, reason, promised_payment_date, note,
              visit_date, sync_status, created_at) on adex.no_payment_visits to adex_api;

create trigger no_payment_visits_append_only before update on adex.no_payment_visits
  for each row execute function adex.reject_mutation();
