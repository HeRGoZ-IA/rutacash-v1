-- ============================================================
-- ADEX SaaS · Fase 1 · 0005 · Sesiones revocables, REVOKE-004 y gestión de membresías
-- ------------------------------------------------------------
-- Decisiones del propietario (2026-10-14):
--   · Revocación de sesión: REGISTRO ADEX en PostgreSQL. Un token de acceso sigue
--     siendo criptográficamente válido hasta `exp`, pero ADEX deja de aceptarlo:
--       - sesión revocada (`revoked_sessions`, por `session_id` del token);
--       - corte por identidad (`identities.sessions_valid_after`): todo token emitido
--         ANTES o EN el mismo segundo del corte queda revocado (cierre global,
--         desactivación de la persona).
--     Se comprueba en la transacción de cada operación y en RLS (`ctx_session_valid`).
--   · REVOKE-004: bloqueo consultivo de transacción. Cada operación toma el bloqueo
--     COMPARTIDO de su identidad, empresa y membresía; TODA vía de revocación toma el
--     EXCLUSIVO mediante disparadores, quien sea el que escriba:
--       - membresía: estado, rol o empresa; quitar una ruta autorizada;
--       - identidad: estado o corte de sesiones; sesión revocada;
--       - empresa: estado o vencimiento.
--     La revocación espera a las operaciones en curso; las que empiezan durante la
--     revocación esperan y, al seguir, ya ven el estado nuevo.
-- ============================================================

-- ---------- Sesiones ----------
alter table adex.identities add column sessions_valid_after timestamptz;

create table adex.revoked_sessions (
  session_id  uuid primary key,
  identity_id uuid not null references adex.identities(id),
  revoked_at  timestamptz not null default now(),
  reason      text not null check (reason in ('logout', 'logout_global', 'admin', 'security'))
);
alter table adex.revoked_sessions enable row level security;
alter table adex.revoked_sessions force row level security;
create policy owner_core_read on adex.revoked_sessions for select to adex_owner using (true);

-- Contexto de sesión que fija la API tras verificar el token.
create function adex.ctx_session() returns uuid language sql stable
  as $$ select nullif(current_setting('adex.session_id', true), '')::uuid $$;
create function adex.ctx_token_iat() returns bigint language sql stable
  as $$ select nullif(current_setting('adex.token_iat', true), '')::bigint $$;

-- Sin sesión o sin `iat` no hay contexto válido (fallo cerrado).
create or replace function adex.ctx_session_valid() returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select adex.ctx_session() is not null
       and adex.ctx_token_iat() is not null
       and not exists (select 1 from adex.revoked_sessions r where r.session_id = adex.ctx_session())
       and exists (select 1 from adex.identities i
                    where i.id = adex.ctx_identity()
                      and (i.sessions_valid_after is null
                           or adex.ctx_token_iat() > floor(extract(epoch from i.sessions_valid_after))::bigint))
  $$;

-- ---------- REVOKE-004: claves de bloqueo ----------
create function adex.lock_key(p_kind text, p_id text) returns bigint
  language sql immutable
  as $$ select hashtextextended('adex:' || p_kind || ':' || p_id, 0) $$;

-- La API lo llama al empezar cada operación protegida, con el contexto ya fijado.
-- Orden fijo (identidad → empresa → membresía): sin interbloqueos entre operaciones.
create function adex.acquire_operation_locks() returns void
  language plpgsql
  as $$ begin
    if adex.ctx_identity() is not null then
      perform pg_advisory_xact_lock_shared(adex.lock_key('identity', adex.ctx_identity()::text));
    end if;
    if adex.ctx_company() is not null then
      perform pg_advisory_xact_lock_shared(adex.lock_key('company', adex.ctx_company()));
    end if;
    if adex.ctx_membership() is not null then
      perform pg_advisory_xact_lock_shared(adex.lock_key('membership', adex.ctx_membership()));
    end if;
  end $$;

create function adex.revoke_lock_membership() returns trigger
  language plpgsql
  as $$ begin
    if tg_table_name = 'membership_routes' then
      perform pg_advisory_xact_lock(adex.lock_key('membership', old.membership_id));
      return old;
    end if;
    if new.status is distinct from old.status or new.role is distinct from old.role
       or new.company_id is distinct from old.company_id or new.identity_id is distinct from old.identity_id then
      perform pg_advisory_xact_lock(adex.lock_key('membership', old.id));
    end if;
    return new;
  end $$;
create trigger memberships_revoke_lock before update on adex.memberships
  for each row execute function adex.revoke_lock_membership();
create trigger membership_routes_revoke_lock before delete on adex.membership_routes
  for each row execute function adex.revoke_lock_membership();

create function adex.revoke_lock_identity() returns trigger
  language plpgsql
  as $$ begin
    if tg_table_name = 'revoked_sessions' then
      perform pg_advisory_xact_lock(adex.lock_key('identity', new.identity_id::text));
    elsif new.status is distinct from old.status or new.sessions_valid_after is distinct from old.sessions_valid_after then
      perform pg_advisory_xact_lock(adex.lock_key('identity', old.id::text));
    end if;
    return new;
  end $$;
create trigger identities_revoke_lock before update on adex.identities
  for each row execute function adex.revoke_lock_identity();
create trigger revoked_sessions_revoke_lock before insert on adex.revoked_sessions
  for each row execute function adex.revoke_lock_identity();

create function adex.revoke_lock_company() returns trigger
  language plpgsql
  as $$ begin
    if new.status is distinct from old.status or new.expires_on is distinct from old.expires_on then
      perform pg_advisory_xact_lock(adex.lock_key('company', old.id));
    end if;
    return new;
  end $$;
create trigger companies_revoke_lock before update on adex.companies
  for each row execute function adex.revoke_lock_company();

-- El corte de sesiones solo avanza; una sesión revocada no se «desrevoca».
create function adex.guard_identity_cutoff() returns trigger
  language plpgsql
  as $$ begin
    if old.sessions_valid_after is not null
       and (new.sessions_valid_after is null or new.sessions_valid_after < old.sessions_valid_after) then
      raise exception 'adex: the session cutoff only moves forward' using errcode = '42501';
    end if;
    return new;
  end $$;
create trigger identities_cutoff_forward before update on adex.identities
  for each row execute function adex.guard_identity_cutoff();
create trigger revoked_sessions_append_only before update or delete or truncate on adex.revoked_sessions
  for each statement execute function adex.reject_mutation();

-- ---------- Gestión de identidad y membresías por la API (Fase 1) ----------
-- Primera barrera: la API (`can()` de CLEAN + jerarquía de roles + último SuperAdmin).
-- Segunda barrera: estas políticas. Solo un SuperAdmin o Administrador ACTIVO de la
-- empresa del contexto escribe membresías de ESA empresa.
create function adex.ctx_can_manage_members() returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select adex.ctx_role() in ('superadmin', 'admin') $$;

-- Aprovisionar la identidad de una persona invitada (id = `sub` del proveedor).
create policy identities_provision on adex.identities for insert to adex_api
  with check (adex.ctx_can_manage_members());
-- Cierre de sesión global: solo la propia identidad mueve su corte.
create policy identities_self_cutoff on adex.identities for update to adex_api
  using (id = adex.ctx_identity() and adex.ctx_session_valid())
  with check (id = adex.ctx_identity());

create policy memberships_manage_insert on adex.memberships for insert to adex_api
  with check (company_id = adex.ctx_company() and adex.ctx_can_manage_members());
create policy memberships_manage_update on adex.memberships for update to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_can_manage_members())
  with check (company_id = adex.ctx_company() and adex.ctx_can_manage_members());

create policy membership_routes_manage_insert on adex.membership_routes for insert to adex_api
  with check (company_id = adex.ctx_company() and adex.ctx_can_manage_members());
create policy membership_routes_manage_delete on adex.membership_routes for delete to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_can_manage_members());

-- Cierre de sesión: la identidad revoca SUS sesiones (con sesión todavía válida).
create policy revoked_sessions_self on adex.revoked_sessions for insert to adex_api
  with check (identity_id = adex.ctx_identity() and adex.ctx_session_valid());
create policy revoked_sessions_read_self on adex.revoked_sessions for select to adex_api
  using (identity_id = adex.ctx_identity());

-- Auditoría del servidor: misma transacción (txid), identidad, membresía y rol del contexto.
create policy audit_log_insert on adex.audit_log for insert to adex_api
  with check (company_id = adex.ctx_company()
              and actor_membership_id = adex.ctx_membership()
              and actor_identity_id = adex.ctx_identity()
              and actor_role = adex.ctx_role()
              and txid = txid_current());

grant select on adex.revoked_sessions to adex_api;
grant insert (id, email) on adex.identities to adex_api;
grant update (sessions_valid_after, updated_at) on adex.identities to adex_api;
grant insert (id, company_id, identity_id, role, status, display_name, phone, created_at, updated_at) on adex.memberships to adex_api;
grant update (status, display_name, phone, updated_at) on adex.memberships to adex_api;
grant insert, delete on adex.membership_routes to adex_api;
grant insert (session_id, identity_id, reason) on adex.revoked_sessions to adex_api;
grant insert (id, company_id, actor_membership_id, actor_identity_id, actor_role, route_id, action, entity_type, entity_id,
              description, before_data, after_data, reason, metadata, operation_id, txid, created_at) on adex.audit_log to adex_api;
grant execute on function adex.ctx_session(), adex.ctx_token_iat(), adex.ctx_session_valid(), adex.lock_key(text, text),
                          adex.acquire_operation_locks(), adex.ctx_can_manage_members() to adex_api;
