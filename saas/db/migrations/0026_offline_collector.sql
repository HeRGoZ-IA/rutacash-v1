-- ============================================================
-- 0026 · Ronda 62: MODO SIN CONEXIÓN DEL COBRADOR (primera versión)
-- ============================================================
-- El Cobrador puede registrar abonos, visitas sin pago y sus gastos sin internet. El
-- dispositivo guarda la operación con su id (`X-Adex-Operation-Id`) y la envía al volver la
-- conexión con los MISMOS comandos de siempre (`/v1/collections`, `/v1/no-payment-visits`,
-- `/v1/expenses`) y el mismo contrato de idempotencia (`adex.operations`). El servidor decide
-- con el estado VIGENTE (membresía, rol, ruta asignada, ruta operativa, crédito, periodo): el
-- dispositivo nunca decide nada y no hay un segundo libro.
--
-- Lo que añade esta migración (no modifica datos existentes):
--   A. `adex.offline_captures`: evidencia de la captura sin conexión (hora del DISPOSITIVO,
--      saldo que el dispositivo mostraba). Dato NO confiable: no fecha el movimiento (la fecha
--      contable sigue siendo la de la empresa al confirmarse, así un periodo cerrado nunca se
--      toca) ni autoriza nada. Una fila por operación; sin UPDATE ni DELETE.
--   B. `adex.offline_collection_balance`: saldo del crédito BAJO EL MISMO BLOQUEO que usa
--      `collection_post` (ruta compartido → crédito exclusivo). Un abono capturado sin conexión
--      que ya no cabe en el saldo se RECHAZA para revisión en vez de topearse en silencio.
--   C. `adex.offline_keys` + `adex.offline_key()`: llave por membresía para cifrar en el
--      dispositivo la copia de consulta y las operaciones pendientes. Al cerrar sesión el
--      dispositivo borra la llave (los pendientes quedan cifrados); solo la MISMA membresía,
--      con sesión válida, la vuelve a obtener. Sin lectura para el plano Owner.
--   D. Visitas sin pago: el guardián exige además ruta OPERATIVA (como los abonos, AX301).

-- ---------- A. Evidencia de captura sin conexión ----------
create table adex.offline_captures (
  company_id          adex.eid not null references adex.companies(id),
  operation_id        uuid not null,
  kind                text not null check (kind in ('payment', 'visit', 'expense')),
  entity_id           adex.eid not null,
  route_id            adex.eid not null,
  membership_id       adex.eid not null,
  device_captured_at  timestamptz,
  known_balance_minor bigint check (known_balance_minor >= 0),
  note                text check (char_length(note) <= 200),
  received_at         timestamptz not null,
  primary key (company_id, operation_id),
  unique (company_id, kind, entity_id),
  foreign key (company_id, route_id)      references adex.routes(company_id, id),
  foreign key (company_id, membership_id) references adex.memberships(company_id, id)
);

comment on table adex.offline_captures is
  'Operaciones del Cobrador capturadas sin conexión: hora del dispositivo y saldo mostrado (evidencia, dato no confiable). Ronda 62.';

alter table adex.offline_captures enable row level security;
alter table adex.offline_captures force row level security;

-- SECURITY INVOKER: valida como quien escribe. La entidad existe, es de esa ruta y la registró
-- ESTA membresía en esta misma transacción de API.
create function adex.offline_capture_guard() returns trigger
  language plpgsql
  as $$
  begin
    if current_user <> 'adex_api' then
      return new;
    end if;
    if new.kind = 'payment' and not exists (select 1 from adex.payments p
         where p.company_id = new.company_id and p.id = new.entity_id and p.route_id = new.route_id
           and p.created_by_membership_id = new.membership_id) then
      raise exception 'adex: offline capture must belong to a payment registered by the same membership' using errcode = 'AX411';
    end if;
    if new.kind = 'visit' and not exists (select 1 from adex.no_payment_visits v
         where v.company_id = new.company_id and v.id = new.entity_id and v.route_id = new.route_id
           and v.collector_membership_id = new.membership_id) then
      raise exception 'adex: offline capture must belong to a visit registered by the same membership' using errcode = 'AX411';
    end if;
    if new.kind = 'expense' and not exists (select 1 from adex.expenses e
         where e.company_id = new.company_id and e.id = new.entity_id and e.route_id = new.route_id
           and e.registered_by_membership_id = new.membership_id) then
      raise exception 'adex: offline capture must belong to an expense registered by the same membership' using errcode = 'AX411';
    end if;
    -- La hora de recepción la pone el servidor, no el cliente.
    new.received_at := now();
    return new;
  end $$;

create trigger offline_captures_guard before insert on adex.offline_captures
  for each row execute function adex.offline_capture_guard();

create policy offline_captures_insert on adex.offline_captures for insert to adex_api
  with check (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id) and membership_id = adex.ctx_membership()
              and adex.ctx_role() = 'cobrador');

grant insert (company_id, operation_id, kind, entity_id, route_id, membership_id, device_captured_at, known_balance_minor, note, received_at)
  on adex.offline_captures to adex_api;

create trigger offline_captures_append_only before update on adex.offline_captures
  for each row execute function adex.reject_mutation();
create trigger offline_captures_no_delete before delete on adex.offline_captures
  for each statement execute function adex.reject_mutation();
create trigger offline_captures_no_truncate before truncate on adex.offline_captures
  for each statement execute function adex.reject_mutation();

-- ---------- B. Saldo bajo bloqueo para un abono capturado sin conexión ----------
-- Mismo orden de bloqueos que `collection_post` (ruta FOR SHARE → crédito FOR UPDATE), en la
-- misma transacción del comando: entre esta lectura y el asiento nadie más cambia el saldo.
create function adex.offline_collection_balance(p_sale text) returns bigint
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    v_route   text;
    v_balance bigint;
  begin
    if not adex.ctx_membership_active() or not adex.ctx_can('payment.register') then
      perform adex.capital_raise('42501', 'no collection authority');
    end if;
    select route_id into v_route from adex.sales where company_id = v_company and id = p_sale;
    if not found or not adex.ctx_route_allowed(v_route) then perform adex.capital_raise('AX412', 'credit not found'); end if;
    perform 1 from adex.routes where company_id = v_company and id = v_route for share;
    perform 1 from adex.sales where company_id = v_company and id = p_sale for update;
    select coalesce(sum(balance_minor), 0) into v_balance from adex.installments where company_id = v_company and sale_id = p_sale;
    return v_balance;
  end $$;
revoke all on function adex.offline_collection_balance(text) from public;
grant execute on function adex.offline_collection_balance(text) to adex_api;

-- ---------- C. Llave de cifrado del dispositivo, por membresía ----------
create table adex.offline_keys (
  company_id    adex.eid not null references adex.companies(id),
  membership_id adex.eid not null,
  key           bytea not null check (octet_length(key) = 32),
  created_at    timestamptz not null default now(),
  primary key (company_id, membership_id),
  foreign key (company_id, membership_id) references adex.memberships(company_id, id)
);

comment on table adex.offline_keys is
  'Llave por membresía con la que ADEX Online cifra en el dispositivo la copia de consulta y los pendientes sin conexión. Ronda 62.';

alter table adex.offline_keys enable row level security;
alter table adex.offline_keys force row level security;
-- Sin políticas ni privilegios para adex_api: solo la función de abajo (SECURITY DEFINER,
-- adex_owner) la lee o la crea, y aun así solo la fila de la membresía del CONTEXTO activo.
create policy offline_keys_owner_ctx on adex.offline_keys for all to adex_owner
  using (company_id = adex.ctx_company() and membership_id = adex.ctx_membership())
  with check (company_id = adex.ctx_company() and membership_id = adex.ctx_membership());

-- La llave de la membresía DEL CONTEXTO (activa, rol Cobrador). Se crea la primera vez. Nunca
-- se rota aquí: rotarla dejaría ilegibles los pendientes cifrados que aún no se enviaron.
create function adex.offline_key() returns bytea
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company    text := adex.ctx_company();
    v_membership text := adex.ctx_membership();
    v_key        bytea;
  begin
    if v_company is null or v_membership is null or not adex.ctx_membership_active() then
      perform adex.capital_raise('42501', 'no active membership');
    end if;
    if adex.ctx_role() is distinct from 'cobrador' then perform adex.capital_raise('42501', 'offline mode is only for collectors'); end if;
    -- 32 bytes de dos UUID v4 (pg_strong_random): sin depender de pgcrypto.
    insert into adex.offline_keys (company_id, membership_id, key)
    values (v_company, v_membership,
            decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex'))
    on conflict (company_id, membership_id) do nothing;
    select key into v_key from adex.offline_keys where company_id = v_company and membership_id = v_membership;
    return v_key;
  end $$;
revoke all on function adex.offline_key() from public;
grant execute on function adex.offline_key() to adex_api;

-- ---------- D. Visitas sin pago: también exigen ruta operativa ----------
create or replace function adex.no_payment_visit_guard() returns trigger
  language plpgsql
  as $$
  begin
    if current_user <> 'adex_api' then
      return new;
    end if;
    if not adex.route_operational(new.company_id, new.route_id) then
      raise exception 'adex: route is not operational' using errcode = 'AX301';
    end if;
    if not exists (select 1 from adex.sales s
                    where s.company_id = new.company_id and s.id = new.sale_id and s.route_id = new.route_id
                      and s.client_id = new.client_id and s.status = 'activa' and s.disbursement_status is distinct from 'pendiente') then
      raise exception 'adex: no-payment visit needs an active disbursed credit of that route and client' using errcode = 'AX701';
    end if;
    if new.visit_date <> adex.company_today(new.company_id) then
      raise exception 'adex: no-payment visit must use the company business date' using errcode = 'AX411';
    end if;
    return new;
  end $$;
