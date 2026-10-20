-- 0024 · Ronda 54: el Owner cambia el CORREO de acceso de un SuperAdmin sin cambiar su identidad.
--
-- Solo plano de control y aprovisionamiento. La identidad (`adex.identities.id` = `sub` del
-- proveedor) NO cambia: sus membresías, permisos, historial y datos siguen siendo los mismos.
-- Cambia el correo en ADEX (esta función) y, en la misma petición, en el proveedor (la API Owner,
-- que deshace esta transacción si el proveedor lo rechaza). La contraseña no se toca.
--
-- Reglas (segunda barrera; la API las comprueba antes):
--   · solo un Owner activo, solo una membresía SuperAdmin de ESA empresa;
--   · la identidad debe ser EXCLUSIVA de la empresa (no pertenece a otra empresa ni es Owner):
--     cambiar el correo de una identidad compartida cambiaría el acceso a otras empresas (DS-05);
--   · el correo nuevo no puede pertenecer a otra identidad (índice único `identities_email_key`);
--   · queda en el historial con su autor (disparador de 0021): «nombre: anterior → nuevo».

alter table adex_control.control_events drop constraint control_events_type_check;
alter table adex_control.control_events add constraint control_events_type_check
  check (type in ('COMPANY_CREATED', 'COMPANY_ACTIVATED', 'COMPANY_SUSPENDED', 'FIRST_LOGIN', 'LOGIN', 'ROUTE_CREATED',
                  'ROUTE_DEACTIVATED', 'ROUTE_DELETED', 'BILLING_UPDATED', 'PAYMENT_REGISTERED',
                  'SUPERADMIN_ASSIGNED', 'ACCESS_LINK_ISSUED', 'COMPANY_UPDATED', 'SUPERADMIN_EMAIL_CHANGED'));

create function adex_control.change_superadmin_email(p_company_id text, p_membership_id text, p_email text)
  returns table (identity_id uuid, previous_email text, changed boolean)
  language plpgsql security definer set search_path = pg_catalog, adex, adex_control
  as $$
  declare
    v_identity uuid;
    v_old text;
    v_name text;
    v_email text := lower(btrim(p_email));
  begin
    perform adex_control.assert_operator();
    if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(v_email) > 160 then
      raise exception 'adex_control: invalid email' using errcode = '23514';
    end if;
    select m.identity_id, i.email, m.display_name into v_identity, v_old, v_name
      from adex.memberships m join adex.identities i on i.id = m.identity_id
     where m.id = p_membership_id and m.company_id = p_company_id and m.role = 'superadmin'
       for update of i;
    if not found then raise exception 'adex_control: superadmin not found' using errcode = 'P0002'; end if;
    if not adex.identity_exclusive(v_identity, p_company_id) then
      raise exception 'adex_control: identity shared with another company or an Owner' using errcode = '42501';
    end if;
    if v_old = v_email then
      return query select v_identity, v_old, false;
      return;
    end if;
    update adex.identities set email = v_email, updated_at = now() where id = v_identity;
    insert into adex_control.control_events (id, company_id, type, at, detail)
    values (gen_random_uuid()::text, p_company_id, 'SUPERADMIN_EMAIL_CHANGED', now(), format('%s: %s → %s', v_name, v_old, v_email));
    return query select v_identity, v_old, true;
  end $$;

revoke all on function adex_control.change_superadmin_email(text, text, text) from public;
grant execute on function adex_control.change_superadmin_email(text, text, text) to adex_control;
