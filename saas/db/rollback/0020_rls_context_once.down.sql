-- REVERSIÓN de 0020 (manual, como adex_owner, en una transacción). Restaura las USING

-- vigentes antes de 0020 (texto exacto de pg_policies en ADEX-Staging, 2026-10-19) y elimina

-- las funciones nuevas. Después: delete from adex_meta.schema_migrations where version = '0020'.

begin;

set local role adex_owner;

alter policy audit_log_ctx on adex.audit_log
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_membership_active() AND ((adex.ctx_role() = 'superadmin'::text) OR ((adex.ctx_role() = 'admin'::text) AND adex.ctx_route_allowed((route_id)::text)) OR ((actor_membership_id)::text = adex.ctx_membership()))));

alter policy capital_accounts_ctx on adex.capital_accounts
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_membership_active() AND ((adex.ctx_role() = 'superadmin'::text) OR ((kind = ANY (ARRAY['admin'::text, 'partner'::text, 'custody'::text, 'suspense'::text])) AND ((membership_id)::text = adex.ctx_membership())) OR ((kind = 'custody'::text) AND adex.ctx_is(ARRAY['admin'::text, 'supervisor'::text, 'socio'::text]) AND adex.ctx_route_allowed((route_id)::text)))));

alter policy capital_ledger_ctx on adex.capital_ledger
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_route_allowed((route_id)::text) AND adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text])));

alter policy capital_movements_ctx on adex.capital_movements
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_route_allowed((route_id)::text) AND adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'socio'::text, 'supervisor'::text])));

alter policy capital_operations_ctx on adex.capital_operations
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_membership_active() AND ((adex.ctx_role() = 'superadmin'::text) OR ((admin_membership_id)::text = adex.ctx_membership()) OR ((COALESCE(reverses_kind, kind) = ANY (ARRAY['WORKER_DELIVERY'::text, 'WORKER_RETURN'::text, 'WORKER_TRANSFER'::text, 'ROUTE_REASSIGNMENT'::text, 'LOAN_DISBURSEMENT'::text, 'COLLECTION'::text, 'WORKER_EXPENSE'::text, 'ROUTE_EXPENSE'::text, 'SETTLEMENT_RETURN'::text, 'SETTLEMENT_SURPLUS'::text])) AND (((adex.ctx_membership() = (worker_membership_id)::text) OR (adex.ctx_membership() = (counterpart_membership_id)::text)) OR (adex.ctx_is(ARRAY['admin'::text, 'supervisor'::text, 'socio'::text]) AND (adex.ctx_route_allowed((route_id)::text) OR adex.ctx_route_allowed((to_route_id)::text))))) OR ((COALESCE(reverses_kind, kind) = 'PARTNER_CONTRIBUTION'::text) AND ((counterpart_membership_id)::text = adex.ctx_membership())))));

alter policy cash_custody_movements_ctx on adex.cash_custody_movements
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_route_allowed((route_id)::text) AND (adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'socio'::text, 'supervisor'::text]) OR ((adex.ctx_membership() = (from_membership_id)::text) OR (adex.ctx_membership() = (to_membership_id)::text)))));

alter policy cash_settlements_ctx on adex.cash_settlements
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_route_allowed((route_id)::text) AND (adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'supervisor'::text]) OR ((worker_membership_id)::text = adex.ctx_membership()))));

alter policy clients_ctx on adex.clients
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_route_allowed((route_id)::text)));

alter policy companies_ctx on adex.companies
  using ((((((id)::text = adex.ctx_company()) AND adex.ctx_membership_active()) OR adex.ctx_identity_member_of((id)::text)) AND (retired_at IS NULL)));

alter policy custody_settlements_ctx on adex.custody_settlements
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_membership_active() AND adex.ctx_route_allowed((route_id)::text) AND (adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'supervisor'::text]) OR ((worker_membership_id)::text = adex.ctx_membership()))));

alter policy expense_categories_ctx on adex.expense_categories
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_membership_active()));

alter policy expenses_ctx on adex.expenses
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_membership_active() AND ((adex.ctx_role() = 'superadmin'::text) OR ((route_id IS NOT NULL) AND adex.ctx_is(ARRAY['admin'::text, 'supervisor'::text, 'socio'::text]) AND adex.ctx_route_allowed((route_id)::text)) OR ((route_id IS NOT NULL) AND adex.ctx_route_allowed((route_id)::text) AND ((adex.ctx_membership() = (collector_membership_id)::text) OR (adex.ctx_membership() = (registered_by_membership_id)::text))) OR ((route_id IS NULL) AND (adex.ctx_role() = 'admin'::text) AND (((funding_admin_membership_id)::text = adex.ctx_membership()) OR ((funding IS NULL) AND ((registered_by_membership_id)::text = adex.ctx_membership())))))));

alter policy identities_ctx on adex.identities
  using (((id = adex.ctx_identity()) OR ((adex.ctx_role() = ANY (ARRAY['superadmin'::text, 'admin'::text])) AND adex.identity_in_ctx_company(id))));

alter policy memberships_ctx on adex.memberships
  using (((identity_id = adex.ctx_identity()) OR (((company_id)::text = adex.ctx_company()) AND adex.ctx_membership_active())));

alter policy no_payment_visits_ctx on adex.no_payment_visits
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_route_allowed((route_id)::text)));

alter policy offices_ctx on adex.offices
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_membership_active()));

alter policy operations_ctx on adex.operations
  using ((((company_id)::text = adex.ctx_company()) AND ((membership_id)::text = adex.ctx_membership()) AND adex.ctx_membership_active()));

alter policy partner_cash_movements_ctx on adex.partner_cash_movements
  using ((((company_id)::text = adex.ctx_company()) AND (adex.ctx_role() = 'superadmin'::text)));

alter policy payment_adjustment_requests_ctx on adex.payment_adjustment_requests
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_route_allowed((route_id)::text)));

alter policy payments_ctx on adex.payments
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_route_allowed((route_id)::text)));

alter policy period_closures_ctx on adex.period_closures
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_membership_active() AND adex.ctx_route_allowed((route_id)::text) AND adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'socio'::text, 'supervisor'::text])));

alter policy route_capital_controller_events_ctx on adex.route_capital_controller_events
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_route_allowed((route_id)::text) AND adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text])));

alter policy routes_ctx on adex.routes
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_route_allowed((id)::text)));

alter policy sale_requests_ctx on adex.sale_requests
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_route_allowed((route_id)::text) AND (adex.ctx_can('authorization.access'::text) OR ((requested_by_membership_id)::text = adex.ctx_membership()))));

alter policy sales_ctx on adex.sales
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_route_allowed((route_id)::text)));

alter policy transfers_ctx on adex.transfers
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'socio'::text, 'supervisor'::text]) AND (adex.ctx_route_allowed((route_origin_id)::text) OR adex.ctx_route_allowed((route_destination_id)::text) OR (adex.ctx_role() = 'superadmin'::text))));

alter policy weekly_settlements_ctx on adex.weekly_settlements
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_route_allowed((route_id)::text) AND adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'socio'::text, 'supervisor'::text])));

alter policy withdrawals_ctx on adex.withdrawals
  using ((((company_id)::text = adex.ctx_company()) AND adex.ctx_route_allowed((route_id)::text) AND adex.ctx_is(ARRAY['superadmin'::text, 'admin'::text, 'socio'::text, 'supervisor'::text])));

drop function adex.ctx_change_marker();

drop function adex.ctx_closed_weeks();

drop function adex.route_in_scope(text, boolean, text[]);

drop function adex.ctx_route_ids();

drop function adex.ctx_routes_all();

commit;
