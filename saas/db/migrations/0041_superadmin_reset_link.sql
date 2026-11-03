-- 0041 · 3.20 (decisión 2.3.4 opción B; detalles del propietario 2026-11-03): el Owner emite un
-- enlace de RESTABLECIMIENTO de contraseña para un SuperAdmin activo que la olvidó.
--
-- Solo plano de control. El enlace de los usuarios de la empresa no necesita migración (su
-- auditoría va a `adex.audit_log` con la acción ISSUE_RESET_LINK). Aquí solo se añade el evento
-- propio del historial del Owner, distinto del de primer acceso (ACCESS_LINK_ISSUED):
--   · solo un Owner activo, solo una membresía SuperAdmin de ESA empresa;
--   · el token no se guarda ni se registra: el historial anota a quién se emitió.

alter table adex_control.control_events drop constraint control_events_type_check;
alter table adex_control.control_events add constraint control_events_type_check
  check (type in ('COMPANY_CREATED', 'COMPANY_ACTIVATED', 'COMPANY_SUSPENDED', 'FIRST_LOGIN', 'LOGIN', 'ROUTE_CREATED',
                  'ROUTE_DEACTIVATED', 'ROUTE_DELETED', 'BILLING_UPDATED', 'PAYMENT_REGISTERED',
                  'SUPERADMIN_ASSIGNED', 'ACCESS_LINK_ISSUED', 'COMPANY_UPDATED', 'SUPERADMIN_EMAIL_CHANGED',
                  'RESET_LINK_ISSUED'));

create function adex_control.record_reset_link(p_company_id text, p_membership_id text) returns void
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$
  declare who text;
  begin
    perform adex_control.assert_operator();
    select m.display_name into who from adex.memberships m
     where m.id = p_membership_id and m.company_id = p_company_id and m.role = 'superadmin' and m.status = 'activo';
    if not found then raise exception 'adex_control: superadmin not found' using errcode = 'P0002'; end if;
    insert into adex_control.control_events (id, company_id, type, at, detail)
    values (gen_random_uuid()::text, p_company_id, 'RESET_LINK_ISSUED', now(), who);
  end $$;

revoke all on function adex_control.record_reset_link(text, text) from public;
grant execute on function adex_control.record_reset_link(text, text) to adex_control;
