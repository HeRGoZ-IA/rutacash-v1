-- REVERSIÓN de 0031 (manual, como adex_owner, en una transacción). Ronda 73.
-- Vuelve a la validez de sesión de 0005 (varias sesiones por identidad). NO borra nada del registro de
-- revocación (append-only): las sesiones ya desplazadas siguen revocadas y el motivo 'superseded' se
-- conserva en la restricción para que esas filas sigan siendo válidas.
-- Después: delete from adex_meta.schema_migrations where version = '0031'.

begin;

set local role adex_owner;

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

drop function adex_control.claim_session(uuid, uuid, bigint);
drop function adex.claim_session(uuid, uuid, bigint);
drop table adex.identity_active_sessions;

commit;
