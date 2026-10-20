-- REVERSIÓN de 0021 (manual, como adex_owner, en una transacción). Los eventos ya
-- registrados con los tipos nuevos se conservan (historial append-only): por eso la
-- restricción de tipos NO se restaura. Después: delete from adex_meta.schema_migrations where version = '0021'.

begin;

set local role adex_owner;

drop trigger routes_control_metrics on adex.routes;
drop trigger saas_payments_event on adex_control.saas_payments;
drop trigger company_control_billing_event on adex_control.company_control;
drop trigger control_events_actor on adex_control.control_events;

drop function adex_control.track_routes();
drop function adex_control.log_saas_payment();
drop function adex_control.log_billing_change();
drop function adex_control.stamp_event_actor();
drop function adex_control.record_operator_login();
drop function adex_control.list_operators();
drop function adex_control.company_locale(text);
drop function adex_control.update_company_profile(text, text, text, text, text);
drop function adex_control.record_access_link(text, text);
drop function adex_control.company_superadmins(text);
drop function adex.access_link_target(text);
drop function adex.identity_exclusive(uuid, text);

create or replace function adex_control.create_company_superadmin(
  p_company_id text, p_membership_id text, p_identity_id uuid, p_email text, p_display_name text
) returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$ begin
    perform adex_control.assert_operator();
    if p_identity_id = adex.ctx_identity() then
      raise exception 'adex_control: an Owner cannot grant itself a company membership' using errcode = '42501';
    end if;
    insert into adex.identities (id, email) values (p_identity_id, lower(btrim(p_email))) on conflict (id) do nothing;
    insert into adex.memberships (id, company_id, identity_id, role, status, display_name, created_at, updated_at)
    values (p_membership_id, p_company_id, p_identity_id, 'superadmin', 'activo', p_display_name, now(), now());
  end $$;

commit;
