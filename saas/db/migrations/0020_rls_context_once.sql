-- 0020 · Rendimiento de lectura: el contexto RLS se evalúa UNA vez por consulta.
--
-- Diagnóstico (Ronda 33, EXPLAIN ANALYZE como adex_api en ADEX-Staging): las políticas
-- SELECT llamaban a las funciones SECURITY DEFINER del contexto (`ctx_route_allowed`,
-- `ctx_membership_active`, `ctx_role`, `ctx_is`, `ctx_can`) POR CADA FILA. Una página de
-- 1000 cobros de la Empresa Demo recorría las 4138 filas de la empresa a ~1,15 ms por fila
-- (4,8 s solo en RLS); la lectura de operaciones de capital del Administrador, 15 s. El
-- coste crece con el volumen de cada empresa.
--
-- Cambio: SOLO la forma de evaluación, nunca la regla.
--   · Cada llamada sin dependencia de la fila se envuelve en una subconsulta escalar
--     `(select adex.ctx_…())`: PostgreSQL la ejecuta una vez por consulta (InitPlan). Son
--     funciones STABLE: dentro de una sentencia devuelven siempre el mismo valor, así que
--     el resultado de la política es idéntico.
--   · `ctx_route_allowed(col)` se sustituye por `route_in_scope(col, todas, rutas)`, con el
--     alcance de rutas del contexto calculado una vez (`ctx_routes_all`, `ctx_route_ids`).
--     Equivalencia exacta con `ctx_route_allowed`:
--       membresía inactiva           → todas = false, rutas = {}      → false
--       SuperAdmin activo            → todas = true                   → true (también sin ruta)
--       otro rol, fila sin ruta      → coalesce(null = any(…), false) → false
--       otro rol, ruta autorizada    → misma consulta a membership_routes (membresía + empresa)
--   · Las políticas de escritura (INSERT/UPDATE/DELETE) no cambian: afectan a una fila.
--   · `ctx_route_allowed` y el resto de funciones siguen existiendo y no cambian (las usan
--     las funciones SECURITY DEFINER de los comandos).
--
-- Además, dos lecturas de apoyo, ambas SECURITY DEFINER, solo para la membresía ACTIVA del
-- contexto y sin escribir nada:
--   · `ctx_closed_weeks()`: semanas cerradas de las rutas del alcance. Sustituye en el
--     listado de cobros a `payment_in_closed_period(id)` fila a fila (misma regla:
--     `capital_period_closed`), que costaba ~1,4 ms por cobro.
--   · `ctx_change_marker()`: huella (md5) de los contadores de actividad de la empresa del
--     contexto (auditoría y libro de capital, ambos solo de inserción, más las tablas
--     operativas). Permite a ADEX Online saber si algo cambió sin volver a descargar el
--     historial. No expone cifras: solo cambia cuando cambia la actividad.
--
-- Reversión: `db/rollback/0020_rls_context_once.down.sql` restaura las USING
-- anteriores tal cual estaban y elimina las funciones nuevas.

create function adex.ctx_routes_all() returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select coalesce(adex.ctx_membership_active() and adex.ctx_role() = 'superadmin', false) $$;

create function adex.ctx_route_ids() returns text[]
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select case when adex.ctx_membership_active() then
      coalesce((select array_agg(mr.route_id::text) from adex.membership_routes mr
                 where mr.membership_id = adex.ctx_membership() and mr.company_id = adex.ctx_company()), '{}'::text[])
    else '{}'::text[] end
  $$;

-- Sin SECURITY DEFINER y con cada parámetro usado una vez: PostgreSQL la expande dentro
-- de la política (no hay llamada por fila).
create function adex.route_in_scope(p_route_id text, p_all boolean, p_route_ids text[]) returns boolean
  language sql immutable
  as $$ select p_all or coalesce(p_route_id = any(p_route_ids), false) $$;

create function adex.ctx_closed_weeks() returns table (route_id text, week_start date, week_end date)
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select w.route_id::text, w.week_start, w.week_end
      from adex.weekly_settlements w
     where w.company_id = adex.ctx_company()
       and coalesce(w.status, 'cerrada') = 'cerrada'
       and adex.route_in_scope(w.route_id::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids()))
  $$;

create function adex.ctx_change_marker() returns text
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select case when adex.ctx_membership_active() then md5(concat_ws('|', c.id,
      (select count(*) from adex.audit_log x where x.company_id = c.id),
      (select count(*) from adex.capital_operations x where x.company_id = c.id),
      (select count(*) from adex.payments x where x.company_id = c.id),
      (select count(*) from adex.expenses x where x.company_id = c.id),
      (select count(*) from adex.sales x where x.company_id = c.id),
      (select count(*) from adex.sale_requests x where x.company_id = c.id),
      (select count(*) from adex.no_payment_visits x where x.company_id = c.id),
      (select count(*) from adex.payment_adjustment_requests x where x.company_id = c.id),
      (select count(*) from adex.weekly_settlements x where x.company_id = c.id),
      (select count(*) from adex.memberships x where x.company_id = c.id)))
    end
      from (select adex.ctx_company() id) c
  $$;

revoke all on function adex.ctx_routes_all(), adex.ctx_route_ids(), adex.route_in_scope(text, boolean, text[]),
  adex.ctx_closed_weeks(), adex.ctx_change_marker() from public;
grant execute on function adex.ctx_routes_all(), adex.ctx_route_ids(), adex.route_in_scope(text, boolean, text[]),
  adex.ctx_closed_weeks(), adex.ctx_change_marker() to adex_api;

-- ---------- Políticas SELECT de adex_api: misma regla, contexto evaluado una vez ----------
alter policy audit_log_ctx on adex.audit_log
  using ((((company_id)::text = adex.ctx_company()) AND (select adex.ctx_membership_active()) AND (((select adex.ctx_role()) = 'superadmin'::text) OR (((select adex.ctx_role()) = 'admin'::text) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids()))) OR ((actor_membership_id)::text = adex.ctx_membership()))));

alter policy capital_accounts_ctx on adex.capital_accounts
  using ((((company_id)::text = adex.ctx_company()) AND (select adex.ctx_membership_active()) AND (((select adex.ctx_role()) = 'superadmin'::text) OR ((kind = ANY (ARRAY['admin'::text, 'partner'::text, 'custody'::text, 'suspense'::text])) AND ((membership_id)::text = adex.ctx_membership())) OR ((kind = 'custody'::text) AND (select adex.ctx_is(ARRAY['admin'::text, 'supervisor'::text, 'socio'::text])) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids()))))));

alter policy capital_ledger_ctx on adex.capital_ledger
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())) AND (select adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text]))));

alter policy capital_movements_ctx on adex.capital_movements
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())) AND (select adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'socio'::text, 'supervisor'::text]))));

alter policy capital_operations_ctx on adex.capital_operations
  using ((((company_id)::text = adex.ctx_company()) AND (select adex.ctx_membership_active()) AND (((select adex.ctx_role()) = 'superadmin'::text) OR ((admin_membership_id)::text = adex.ctx_membership()) OR ((COALESCE(reverses_kind, kind) = ANY (ARRAY['WORKER_DELIVERY'::text, 'WORKER_RETURN'::text, 'WORKER_TRANSFER'::text, 'ROUTE_REASSIGNMENT'::text, 'LOAN_DISBURSEMENT'::text, 'COLLECTION'::text, 'WORKER_EXPENSE'::text, 'ROUTE_EXPENSE'::text, 'SETTLEMENT_RETURN'::text, 'SETTLEMENT_SURPLUS'::text])) AND (((adex.ctx_membership() = (worker_membership_id)::text) OR (adex.ctx_membership() = (counterpart_membership_id)::text)) OR ((select adex.ctx_is(ARRAY['admin'::text, 'supervisor'::text, 'socio'::text])) AND (adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())) OR adex.route_in_scope((to_route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())))))) OR ((COALESCE(reverses_kind, kind) = 'PARTNER_CONTRIBUTION'::text) AND ((counterpart_membership_id)::text = adex.ctx_membership())))));

alter policy cash_custody_movements_ctx on adex.cash_custody_movements
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())) AND ((select adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'socio'::text, 'supervisor'::text])) OR ((adex.ctx_membership() = (from_membership_id)::text) OR (adex.ctx_membership() = (to_membership_id)::text)))));

alter policy cash_settlements_ctx on adex.cash_settlements
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())) AND ((select adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'supervisor'::text])) OR ((worker_membership_id)::text = adex.ctx_membership()))));

alter policy clients_ctx on adex.clients
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids()))));

alter policy companies_ctx on adex.companies
  using ((((((id)::text = adex.ctx_company()) AND (select adex.ctx_membership_active())) OR adex.ctx_identity_member_of((id)::text)) AND (retired_at IS NULL)));

alter policy custody_settlements_ctx on adex.custody_settlements
  using ((((company_id)::text = adex.ctx_company()) AND (select adex.ctx_membership_active()) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())) AND ((select adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'supervisor'::text])) OR ((worker_membership_id)::text = adex.ctx_membership()))));

alter policy expense_categories_ctx on adex.expense_categories
  using ((((company_id)::text = adex.ctx_company()) AND (select adex.ctx_membership_active())));

alter policy expenses_ctx on adex.expenses
  using ((((company_id)::text = adex.ctx_company()) AND (select adex.ctx_membership_active()) AND (((select adex.ctx_role()) = 'superadmin'::text) OR ((route_id IS NOT NULL) AND (select adex.ctx_is(ARRAY['admin'::text, 'supervisor'::text, 'socio'::text])) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids()))) OR ((route_id IS NOT NULL) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())) AND ((adex.ctx_membership() = (collector_membership_id)::text) OR (adex.ctx_membership() = (registered_by_membership_id)::text))) OR ((route_id IS NULL) AND ((select adex.ctx_role()) = 'admin'::text) AND (((funding_admin_membership_id)::text = adex.ctx_membership()) OR ((funding IS NULL) AND ((registered_by_membership_id)::text = adex.ctx_membership())))))));

alter policy identities_ctx on adex.identities
  using (((id = adex.ctx_identity()) OR (((select adex.ctx_role()) = ANY (ARRAY['superadmin'::text, 'admin'::text])) AND adex.identity_in_ctx_company(id))));

alter policy memberships_ctx on adex.memberships
  using (((identity_id = adex.ctx_identity()) OR (((company_id)::text = adex.ctx_company()) AND (select adex.ctx_membership_active()))));

alter policy no_payment_visits_ctx on adex.no_payment_visits
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids()))));

alter policy offices_ctx on adex.offices
  using ((((company_id)::text = adex.ctx_company()) AND (select adex.ctx_membership_active())));

alter policy operations_ctx on adex.operations
  using ((((company_id)::text = adex.ctx_company()) AND ((membership_id)::text = adex.ctx_membership()) AND (select adex.ctx_membership_active())));

alter policy partner_cash_movements_ctx on adex.partner_cash_movements
  using ((((company_id)::text = adex.ctx_company()) AND ((select adex.ctx_role()) = 'superadmin'::text)));

alter policy payment_adjustment_requests_ctx on adex.payment_adjustment_requests
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids()))));

alter policy payments_ctx on adex.payments
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids()))));

alter policy period_closures_ctx on adex.period_closures
  using ((((company_id)::text = adex.ctx_company()) AND (select adex.ctx_membership_active()) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())) AND (select adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'socio'::text, 'supervisor'::text]))));

alter policy route_capital_controller_events_ctx on adex.route_capital_controller_events
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())) AND (select adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text]))));

alter policy routes_ctx on adex.routes
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids()))));

alter policy sale_requests_ctx on adex.sale_requests
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())) AND ((select adex.ctx_can('authorization.access'::text)) OR ((requested_by_membership_id)::text = adex.ctx_membership()))));

alter policy sales_ctx on adex.sales
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids()))));

alter policy transfers_ctx on adex.transfers
  using ((((company_id)::text = adex.ctx_company()) AND (select adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'socio'::text, 'supervisor'::text])) AND (adex.route_in_scope((route_origin_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())) OR adex.route_in_scope((route_destination_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())) OR ((select adex.ctx_role()) = 'superadmin'::text))));

alter policy weekly_settlements_ctx on adex.weekly_settlements
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())) AND (select adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'socio'::text, 'supervisor'::text]))));

alter policy withdrawals_ctx on adex.withdrawals
  using ((((company_id)::text = adex.ctx_company()) AND adex.route_in_scope((route_id)::text, (select adex.ctx_routes_all()), (select adex.ctx_route_ids())) AND (select adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'socio'::text, 'supervisor'::text]))));
