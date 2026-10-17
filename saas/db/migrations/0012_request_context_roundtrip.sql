-- ============================================================
-- ADEX SaaS · ADEX Online v1 · 0012 · Contexto de la petición en UN viaje
-- ------------------------------------------------------------
-- Medido en ADEX-Staging (2026-10-16): con la base en São Paulo y la API a ~135 ms,
-- cada petición tardaba 2–3 s porque resolver el contexto eran ~11 consultas
-- SECUENCIALES (fijar contexto, bloqueos REVOKE-004, identidad, membresía, empresa,
-- rutas). Esta función hace EXACTAMENTE la misma secuencia, en el mismo orden y con
-- los mismos bloqueos, dentro de PostgreSQL, en un solo viaje de red.
--
--   · SECURITY INVOKER (sin SET): corre como `adex_api`, así que identidad, membresía
--     y empresa se leen con las MISMAS políticas RLS que antes. Nada se amplía.
--   · Las marcas de contexto se fijan con set_config(…, true): duran la transacción,
--     como antes (seguro con el pooler en modo transacción).
--   · Orden de bloqueos (REVOKE-004) idéntico: identidad → (membresía) → empresa.
--   · Devuelve un resultado y la API traduce cada código al mismo error de antes.
-- ============================================================

create function adex.open_request_context(p_identity text, p_session text, p_iat text, p_membership text) returns jsonb
  language plpgsql volatile
  as $$
  declare
    v_status text;
    v_session_ok boolean;
    m record;
    c record;
    v_routes text[];
  begin
    -- 1. Identidad y sesión (sin empresa ni membresía): bloqueo compartido de la identidad.
    perform pg_catalog.set_config('adex.identity_id', p_identity, true), pg_catalog.set_config('adex.session_id', p_session, true),
            pg_catalog.set_config('adex.token_iat', p_iat, true), pg_catalog.set_config('adex.membership_id', '', true),
            pg_catalog.set_config('adex.company_id', '', true);
    perform adex.acquire_operation_locks();
    select i.status, adex.ctx_session_valid() into v_status, v_session_ok from adex.identities i where i.id = adex.ctx_identity();
    if not found then return jsonb_build_object('outcome', 'IDENTITY_NOT_PROVISIONED'); end if;
    if not v_session_ok then return jsonb_build_object('outcome', 'SESSION_REVOKED'); end if;
    if v_status <> 'active' then return jsonb_build_object('outcome', 'IDENTITY_DISABLED'); end if;
    if p_membership is null then return jsonb_build_object('outcome', 'ok'); end if;

    -- 2. Membresía elegida (RLS: solo las de ESTA identidad): bloqueo compartido de la membresía.
    perform pg_catalog.set_config('adex.membership_id', p_membership, true);
    perform adex.acquire_operation_locks();
    select x.id, x.company_id, x.role, x.status, x.display_name, x.created_at into m
      from adex.memberships x where x.id = p_membership and x.identity_id = adex.ctx_identity();
    if not found then return jsonb_build_object('outcome', 'MEMBERSHIP_NOT_FOUND'); end if;
    if m.status <> 'activo' then return jsonb_build_object('outcome', 'MEMBERSHIP_INACTIVE'); end if;

    -- 3. Empresa: bloqueo compartido de la empresa; operable y contexto válido.
    perform pg_catalog.set_config('adex.company_id', m.company_id, true);
    perform adex.acquire_operation_locks();
    select co.id, co.name, co.country_code, co.currency_code, cur.minor_units, co.timezone, co.is_demo,
           adex.company_is_operable(co.status, co.expires_on, co.timezone) as operable, adex.ctx_membership_active() as ctx_ok
      into c
      from adex.companies co join adex.currencies cur on cur.code = co.currency_code
     where co.id = m.company_id;
    if not found then return jsonb_build_object('outcome', 'MEMBERSHIP_NOT_FOUND'); end if;
    if not c.operable then return jsonb_build_object('outcome', 'COMPANY_BLOCKED'); end if;
    if not c.ctx_ok then return jsonb_build_object('outcome', 'CONTEXT_INVALID'); end if;

    select coalesce(array_agg(mr.route_id::text order by mr.route_id), '{}') into v_routes
      from adex.membership_routes mr where mr.membership_id = p_membership;
    return jsonb_build_object(
      'outcome', 'ok',
      'membership', jsonb_build_object('id', m.id, 'companyId', m.company_id, 'role', m.role, 'status', m.status,
                                       'displayName', m.display_name, 'createdAt', m.created_at),
      'company', jsonb_build_object('id', c.id, 'name', c.name, 'countryCode', c.country_code, 'currencyCode', c.currency_code,
                                    'minorUnits', c.minor_units, 'timezone', c.timezone, 'isDemo', c.is_demo),
      'routeIds', to_jsonb(v_routes));
  end $$;

revoke all on function adex.open_request_context(text, text, text, text) from public;
grant execute on function adex.open_request_context(text, text, text, text) to adex_api;
