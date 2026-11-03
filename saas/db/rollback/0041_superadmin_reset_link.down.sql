-- Reversión de 0041: quita el evento de restablecimiento del historial del Owner.
-- Se ejecuta como administrador SOLO si hubiera que deshacer 0041 (ver procedimiento de R73 §7.5).
-- Los eventos RESET_LINK_ISSUED ya registrados se conservan como ACCESS_LINK_ISSUED (el historial
-- no se borra; el texto del detalle sigue nombrando al SuperAdmin).
-- Después: delete from adex_meta.schema_migrations where version = '0041'.
begin;
drop function if exists adex_control.record_reset_link(text, text);
alter table adex_control.control_events drop constraint control_events_type_check;
update adex_control.control_events set type = 'ACCESS_LINK_ISSUED' where type = 'RESET_LINK_ISSUED';
alter table adex_control.control_events add constraint control_events_type_check
  check (type in ('COMPANY_CREATED', 'COMPANY_ACTIVATED', 'COMPANY_SUSPENDED', 'FIRST_LOGIN', 'LOGIN', 'ROUTE_CREATED',
                  'ROUTE_DEACTIVATED', 'ROUTE_DELETED', 'BILLING_UPDATED', 'PAYMENT_REGISTERED',
                  'SUPERADMIN_ASSIGNED', 'ACCESS_LINK_ISSUED', 'COMPANY_UPDATED', 'SUPERADMIN_EMAIL_CHANGED'));
commit;
