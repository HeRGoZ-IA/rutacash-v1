-- ============================================================
-- 0031 · Ronda 73 · SOC-01: UNA sola sesión activa por identidad
-- ------------------------------------------------------------
-- Pendiente de autorización del propietario para aplicarse en el PostgreSQL gestionado.
-- Solo AÑADE: una tabla, un motivo de revocación, una función y una condición de validez.
--
-- Regla del propietario: si una persona inicia sesión en otro dispositivo, la sesión anterior
-- queda revocada (todos los perfiles, también los Owners). Mecanismo (DS-05: una identidad,
-- varias membresías; cambiar de empresa o de rol NO es una sesión nueva):
--   · `adex.identity_active_sessions`: la sesión VIGENTE de cada identidad. La fija
--     `adex.claim_session` SOLO en un inicio de sesión explícito (API de empresa:
--     `POST /v1/session/claim`; API Owner: `POST /control/v1/session/start`), nunca al renovar
--     el token ni al cambiar de contexto: un dispositivo antiguo que renueva su token sigue
--     siendo la sesión antigua.
--   · La sesión anterior se registra en `adex.revoked_sessions` (motivo nuevo `superseded`) con
--     el bloqueo exclusivo de la identidad (REVOKE-004): las peticiones en curso de la sesión
--     anterior terminan antes; las siguientes ven la revocación.
--   · `adex.ctx_session_valid()` (que usan RLS, la apertura de contexto y la API Owner) exige
--     además que la sesión sea la vigente, si la identidad ya reclamó alguna. Así también caen
--     las sesiones aún más antiguas. Identidades que nunca reclamaron: sin cambio.
-- Capturas sin conexión: el servidor ya rechaza la sincronización con una sesión revocada
-- (SESSION_REVOKED) y el dispositivo conserva la captura cifrada; nada se borra ni se aplica.
-- ============================================================

create table adex.identity_active_sessions (
  identity_id          uuid primary key references adex.identities(id),
  session_id           uuid not null,
  claimed_at           timestamptz not null default now(),
  previous_session_id  uuid,
  claims               integer not null default 1 check (claims >= 1)
);
alter table adex.identity_active_sessions enable row level security;
alter table adex.identity_active_sessions force row level security;
create policy owner_active_sessions on adex.identity_active_sessions for all to adex_owner using (true) with check (true);
revoke all on adex.identity_active_sessions from public;

alter table adex.revoked_sessions drop constraint revoked_sessions_reason_check;
alter table adex.revoked_sessions add constraint revoked_sessions_reason_check
  check (reason in ('logout', 'logout_global', 'admin', 'security', 'superseded'));

-- Validez de 0005 + «es la sesión vigente de su identidad» (si ya reclamó alguna).
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
       and not exists (select 1 from adex.identity_active_sessions a
                        where a.identity_id = adex.ctx_identity() and a.session_id <> adex.ctx_session())
  $$;

-- Inicio de sesión explícito: esta sesión pasa a ser la única vigente de la identidad. La API la
-- llama con las afirmaciones del token YA verificado. Se exige lo mismo que antes de 0031
-- (identidad aprovisionada y activa, sesión no revocada, posterior al corte): una sesión
-- revocada o anterior a un cierre global nunca recupera la vigencia.
create function adex.claim_session(p_identity uuid, p_session uuid, p_iat bigint) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_prev uuid;
    v_ok boolean;
  begin
    if session_user not in ('adex_api', 'adex_control') then
      raise exception 'adex: sessions are claimed only through the APIs' using errcode = '42501';
    end if;
    if p_identity is null or p_session is null or p_iat is null then
      return jsonb_build_object('outcome', 'SESSION_REVOKED');
    end if;
    -- Bloqueo exclusivo de la identidad (REVOKE-004): espera a las peticiones en curso.
    perform pg_advisory_xact_lock(adex.lock_key('identity', p_identity::text));
    select i.status = 'active'
           and not exists (select 1 from adex.revoked_sessions r where r.session_id = p_session)
           and (i.sessions_valid_after is null or p_iat > floor(extract(epoch from i.sessions_valid_after))::bigint)
      into v_ok
      from adex.identities i where i.id = p_identity;
    if v_ok is null then return jsonb_build_object('outcome', 'IDENTITY_NOT_PROVISIONED'); end if;
    if not v_ok then return jsonb_build_object('outcome', 'SESSION_REVOKED'); end if;
    select session_id into v_prev from adex.identity_active_sessions where identity_id = p_identity for update;
    if v_prev is not null and v_prev <> p_session then
      insert into adex.revoked_sessions (session_id, identity_id, reason) values (v_prev, p_identity, 'superseded')
      on conflict (session_id) do nothing;
    end if;
    insert into adex.identity_active_sessions (identity_id, session_id, claimed_at, previous_session_id)
    values (p_identity, p_session, now(), null)
    on conflict (identity_id) do update
      set session_id = excluded.session_id, claimed_at = now(),
          previous_session_id = case when adex.identity_active_sessions.session_id <> excluded.session_id
                                     then adex.identity_active_sessions.session_id else adex.identity_active_sessions.previous_session_id end,
          claims = adex.identity_active_sessions.claims + case when adex.identity_active_sessions.session_id <> excluded.session_id then 1 else 0 end;
    return jsonb_build_object('outcome', 'ok', 'revokedPrevious', v_prev is not null and v_prev <> p_session);
  end $$;
revoke all on function adex.claim_session(uuid, uuid, bigint) from public;
grant execute on function adex.claim_session(uuid, uuid, bigint) to adex_api, adex_control;

-- La API Owner no usa el esquema `adex` directamente (0006): envoltura en su propio esquema.
create function adex_control.claim_session(p_identity uuid, p_session uuid, p_iat bigint) returns jsonb
  language sql volatile security definer set search_path = pg_catalog, adex, adex_control
  as $$ select adex.claim_session(p_identity, p_session, p_iat) $$;
revoke all on function adex_control.claim_session(uuid, uuid, bigint) from public;
grant execute on function adex_control.claim_session(uuid, uuid, bigint) to adex_control;
