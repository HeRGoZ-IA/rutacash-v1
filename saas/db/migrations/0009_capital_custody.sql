-- ============================================================
-- ADEX SaaS · Fase 3 · 0009 · Capital centralizado y custodia
-- ------------------------------------------------------------
-- Autorizada por el propietario (Fase 3, 2026-10-16). Modelo aprobado en CLEAN (C1):
--
--     Empresa → bolsa del Administrador → custodia del trabajador por ruta
--
-- SIN caja financiera de ruta: ninguna tabla, fila de saldo ni cuenta representa
-- dinero «de la ruta». La ruta es la referencia de atribución (custodia, cuadres,
-- cartera) y su responsable de capital decide qué bolsa paga y recibe.
--
-- 1. Exposición (bloqueante): un Cobrador asignado a una ruta podía LEER el libro de
--    capital, los movimientos de capital, la custodia de otros y la auditoría de esa
--    ruta. Las políticas de lectura se rehacen por rol (`can()` de CLEAN:
--    `cashbox.viewRoute`, `capital.manage`, `audit.view`, `cashSettlement.viewOwn`).
--
-- 2. Libro de doble entrada, inmutable:
--      capital_accounts    posiciones materializadas (empresa, bolsa de cada
--                          Administrador, custodia por ruta y trabajador, y las
--                          contrapartes externa y de cada socio);
--      capital_operations  una fila por operación (idempotente por operationId);
--      capital_entries     las patas con signo; Σ patas de una operación = 0.
--    Conservación por construcción: el dinero solo cambia de cuenta. Solo las
--    contrapartes (externa, socio) pueden quedar negativas: miden lo que entró.
--
-- 3. Escritura ÚNICAMENTE por `adex.capital_post` (SECURITY DEFINER): la API no
--    tiene INSERT/UPDATE sobre estas tablas. La función revalida con los datos del
--    servidor y bajo bloqueo: contexto activo, rol, responsable de capital, custodio,
--    ruta operativa, periodo abierto (D7), fondos y forma de las patas.
--
-- Orden global de bloqueos (sin interbloqueos): bloqueos consultivos de REVOKE-004
-- → filas de rutas (id asc) → cuentas (empresa → bolsas → custodias → contrapartes,
-- id asc). La ruta va antes que las bolsas porque su fila fija QUIÉN es el
-- responsable: con ella bloqueada, el cambio de responsable (Fase 2, que bloquea la
-- misma fila) no puede intercalarse y la bolsa elegida ya es definitiva (R5).
-- ============================================================

-- ============================================================
-- 1. Lectura de datos financieros por rol (corrige la exposición)
-- ============================================================
-- Caja de ruta heredada (modelo v16, solo histórico; la API ya no escribe aquí):
-- quien tiene `cashbox.viewRoute` (SuperAdmin, Administrador, Socio, Supervisor).
drop policy capital_movements_ctx on adex.capital_movements;
create policy capital_movements_ctx on adex.capital_movements for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id)
         and adex.ctx_is(array['superadmin', 'admin', 'socio', 'supervisor']));
drop policy withdrawals_ctx on adex.withdrawals;
create policy withdrawals_ctx on adex.withdrawals for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id)
         and adex.ctx_is(array['superadmin', 'admin', 'socio', 'supervisor']));
drop policy weekly_settlements_ctx on adex.weekly_settlements;
create policy weekly_settlements_ctx on adex.weekly_settlements for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id)
         and adex.ctx_is(array['superadmin', 'admin', 'socio', 'supervisor']));
drop policy transfers_ctx on adex.transfers;
create policy transfers_ctx on adex.transfers for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_is(array['superadmin', 'admin', 'socio', 'supervisor'])
         and (adex.ctx_route_allowed(route_origin_id) or adex.ctx_route_allowed(route_destination_id)
              or adex.ctx_role() = 'superadmin'));

-- Libro de bolsas v16 y responsables (`capital.manage`): SuperAdmin y Administrador
-- de la ruta. Los asientos sin ruta (empresa ↔ bolsas) siguen solo para el SuperAdmin.
drop policy capital_ledger_ctx on adex.capital_ledger;
create policy capital_ledger_ctx on adex.capital_ledger for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id) and adex.ctx_is(array['superadmin', 'admin']));
drop policy route_capital_controller_events_ctx on adex.route_capital_controller_events;
create policy route_capital_controller_events_ctx on adex.route_capital_controller_events for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id) and adex.ctx_is(array['superadmin', 'admin']));

-- Custodia heredada y cuadres: quien gestiona la ruta, o la PROPIA persona.
drop policy cash_custody_movements_ctx on adex.cash_custody_movements;
create policy cash_custody_movements_ctx on adex.cash_custody_movements for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id)
         and (adex.ctx_is(array['superadmin', 'admin', 'socio', 'supervisor'])
              or adex.ctx_membership() in (from_membership_id, to_membership_id)));
drop policy cash_settlements_ctx on adex.cash_settlements;
create policy cash_settlements_ctx on adex.cash_settlements for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_route_allowed(route_id)
         and (adex.ctx_is(array['superadmin', 'admin', 'supervisor']) or worker_membership_id = adex.ctx_membership()));

-- Auditoría (`audit.view`: SuperAdmin y Administrador de la ruta) y, para cualquiera,
-- sus propias acciones. Las demás personas de la ruta ya no leen decisiones ajenas.
drop policy audit_log_ctx on adex.audit_log;
create policy audit_log_ctx on adex.audit_log for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_membership_active()
         and (adex.ctx_role() = 'superadmin'
              or (adex.ctx_role() = 'admin' and adex.ctx_route_allowed(route_id))
              or actor_membership_id = adex.ctx_membership()));

-- ============================================================
-- 2. Libro de capital y custodia (doble entrada)
-- ============================================================

-- ---------- Cuentas (posiciones materializadas) ----------
create table adex.capital_accounts (
  id             adex.eid primary key,
  company_id     adex.eid not null references adex.companies(id),
  kind           text not null check (kind in ('company', 'admin', 'custody', 'external', 'partner')),
  membership_id  adex.eid,          -- Administrador (bolsa), trabajador (custodia) o socio
  route_id       adex.eid,          -- solo custodia: ruta de atribución
  balance_minor  bigint not null default 0,
  -- Faltante arrastrado de un cuadre (lo mantiene la Fase 6). Es deuda, no billetes:
  -- no se traspasa ni se «anula» (`transferableCash` de CLEAN = saldo − arrastre).
  carried_minor  bigint not null default 0 check (carried_minor >= 0),
  version        bigint not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (company_id, id),
  check (case kind
           when 'company'  then membership_id is null and route_id is null
           when 'external' then membership_id is null and route_id is null
           when 'admin'    then membership_id is not null and route_id is null
           when 'partner'  then membership_id is not null and route_id is null
           when 'custody'  then membership_id is not null and route_id is not null
         end),
  check (kind = 'custody' or carried_minor = 0),
  -- LA barrera de sobregiro: empresa, bolsas y custodias nunca negativas. Bajo el
  -- bloqueo de la fila, dos operaciones simultáneas no pueden gastar el mismo saldo.
  -- (La Fase 5 decidirá cómo admitir el gasto del trabajador que deja su posición en
  -- negativo, regla vigente 73209ce; aquí ningún comando lo necesita.)
  constraint capital_accounts_no_overdraft check (kind in ('external', 'partner') or balance_minor >= 0),
  foreign key (company_id, membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, route_id)      references adex.routes(company_id, id)
);
create unique index capital_accounts_key
  on adex.capital_accounts (company_id, kind, coalesce(membership_id, ''), coalesce(route_id, ''));
create index capital_accounts_route on adex.capital_accounts (company_id, route_id) where route_id is not null;

-- ---------- Operaciones ----------
create table adex.capital_operations (
  id                        adex.eid primary key,
  company_id                adex.eid not null references adex.companies(id),
  operation_id              uuid not null,
  kind                      text not null check (kind in (
                              'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN',
                              'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY', 'WORKER_RETURN', 'WORKER_TRANSFER',
                              'ROUTE_REASSIGNMENT', 'REVERSAL')),
  amount_minor              bigint not null check (amount_minor > 0),
  currency_code             char(3) not null references adex.currencies(code),
  route_id                  adex.eid,     -- ruta de atribución (origen en una reasignación)
  to_route_id               adex.eid,     -- ruta destino de una reasignación
  admin_membership_id       adex.eid,     -- bolsa que paga o recibe
  worker_membership_id      adex.eid,     -- trabajador que recibe, devuelve o entrega
  counterpart_membership_id adex.eid,     -- trabajador destino, o socio que aporta
  sale_request_id           adex.eid,     -- referencia opcional de una entrega (no crea venta)
  reverses_operation_id     adex.eid,
  reverses_kind             text,         -- tipo de la operación anulada (visibilidad y trazabilidad)
  reason                    text not null check (length(btrim(reason)) >= 3 and length(reason) <= 300),
  entry_date                date not null,                 -- hoy, en la zona horaria de la empresa (D7)
  actor_membership_id       adex.eid not null,
  actor_identity_id         uuid not null references adex.identities(id),
  actor_role                text not null check (actor_role in ('superadmin', 'admin', 'supervisor')),
  txid                      bigint not null,
  created_at                timestamptz not null default now(),
  unique (company_id, id),
  constraint capital_operations_operation_key unique (company_id, operation_id),
  constraint capital_operations_reversal_key unique (company_id, reverses_operation_id),
  check ((kind = 'REVERSAL') = (reverses_operation_id is not null)),
  check ((kind = 'REVERSAL') = (reverses_kind is not null)),
  check (reverses_kind is null or reverses_kind in ('COMPANY_DEPOSIT', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION',
                                                   'WORKER_DELIVERY', 'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT')),
  check (to_route_id is null or to_route_id <> route_id),
  foreign key (company_id, route_id)                  references adex.routes(company_id, id),
  foreign key (company_id, to_route_id)               references adex.routes(company_id, id),
  foreign key (company_id, admin_membership_id)       references adex.memberships(company_id, id),
  foreign key (company_id, worker_membership_id)      references adex.memberships(company_id, id),
  foreign key (company_id, counterpart_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, sale_request_id)           references adex.sale_requests(company_id, id),
  foreign key (company_id, actor_membership_id)       references adex.memberships(company_id, id),
  foreign key (company_id, reverses_operation_id)     references adex.capital_operations(company_id, id)
);
create index capital_operations_route on adex.capital_operations (company_id, route_id, created_at);
create index capital_operations_admin on adex.capital_operations (company_id, admin_membership_id, created_at);
create index capital_operations_worker on adex.capital_operations (company_id, worker_membership_id, created_at);

-- ---------- Patas ----------
create table adex.capital_entries (
  company_id          adex.eid not null references adex.companies(id),
  operation_id        adex.eid not null,
  leg                 smallint not null check (leg between 1 and 8),
  account_id          adex.eid not null,
  amount_minor        bigint not null check (amount_minor <> 0),   -- + entra, − sale
  balance_after_minor bigint not null,                             -- saldo de la cuenta tras la pata
  primary key (company_id, operation_id, leg),
  foreign key (company_id, operation_id) references adex.capital_operations(company_id, id),
  foreign key (company_id, account_id)   references adex.capital_accounts(company_id, id)
);
create index capital_entries_account on adex.capital_entries (company_id, account_id);

-- ---------- Inmutabilidad ----------
do $$
declare t text;
begin
  foreach t in array array['capital_operations', 'capital_entries'] loop
    execute format('create trigger %I before update or delete on adex.%I for each row execute function adex.reject_mutation()', t || '_immutable', t);
    execute format('create trigger %I before truncate on adex.%I for each statement execute function adex.reject_mutation()', t || '_no_truncate', t);
  end loop;
end $$;
create trigger capital_accounts_no_delete before delete on adex.capital_accounts
  for each row execute function adex.reject_mutation();
create trigger capital_accounts_no_truncate before truncate on adex.capital_accounts
  for each statement execute function adex.reject_mutation();

-- Una cuenta solo cambia su saldo, su arrastre y su versión; su identidad es fija.
create function adex.guard_capital_account() returns trigger
  language plpgsql
  as $$ begin
    if (new.id, new.company_id, new.kind, new.membership_id, new.route_id, new.created_at)
       is distinct from (old.id, old.company_id, old.kind, old.membership_id, old.route_id, old.created_at) then
      raise exception 'adex: capital account % identity is immutable', old.id using errcode = '42501';
    end if;
    if new.version <> old.version + 1 then
      raise exception 'adex: capital account % must advance its version', old.id using errcode = '42501';
    end if;
    return new;
  end $$;
create trigger capital_accounts_guard before update on adex.capital_accounts
  for each row execute function adex.guard_capital_account();

-- Conservación comprobada al COMMIT, también frente a escritores que no sean la
-- función: cada operación tiene al menos dos patas y suman cero.
create function adex.assert_capital_operation_balanced() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  declare v_sum numeric; v_n int;
  begin
    select coalesce(sum(amount_minor), 0), count(*) into v_sum, v_n
      from adex.capital_entries where company_id = new.company_id and operation_id = new.operation_id;
    if v_n < 2 or v_sum <> 0 then
      raise exception 'adex: capital operation % is unbalanced (% legs, sum %)', new.operation_id, v_n, v_sum using errcode = 'AX420';
    end if;
    return null;
  end $$;
create constraint trigger capital_entries_balanced after insert on adex.capital_entries
  deferrable initially deferred for each row execute function adex.assert_capital_operation_balanced();

-- Toda operación tiene patas (una cabecera sola sería un movimiento incompleto).
create function adex.assert_capital_operation_has_entries() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$ begin
    if not exists (select 1 from adex.capital_entries where company_id = new.company_id and operation_id = new.id) then
      raise exception 'adex: capital operation % has no entries', new.id using errcode = 'AX420';
    end if;
    return null;
  end $$;
create constraint trigger capital_operations_complete after insert on adex.capital_operations
  deferrable initially deferred for each row execute function adex.assert_capital_operation_has_entries();

-- ---------- RLS ----------
alter table adex.capital_accounts   enable row level security;
alter table adex.capital_accounts   force row level security;
alter table adex.capital_operations enable row level security;
alter table adex.capital_operations force row level security;
alter table adex.capital_entries    enable row level security;
alter table adex.capital_entries    force row level security;

-- Propietario: solo lo usan las funciones SECURITY DEFINER de este archivo.
create policy owner_capital_all on adex.capital_accounts   for all to adex_owner using (true) with check (true);
create policy owner_capital_all on adex.capital_operations for all to adex_owner using (true) with check (true);
create policy owner_capital_all on adex.capital_entries    for all to adex_owner using (true) with check (true);
-- Bloqueo de la fila de la ruta desde `capital_post` (FOR UPDATE exige una política
-- de UPDATE). WITH CHECK (false): bloquear sí; modificar, jamás por esta vía.
create policy owner_capital_route_lock on adex.routes for update to adex_owner using (true) with check (false);

-- Cuentas visibles:
--   · SuperAdmin: todas las de su empresa;
--   · Administrador: SU bolsa y las custodias de sus rutas (nunca otra bolsa ni la empresa);
--   · Supervisor y Socio: custodias de sus rutas (`cashbox.viewRoute`); el Socio, su contrapartida;
--   · Cobrador (y cualquiera): SOLO su propia custodia.
create policy capital_accounts_ctx on adex.capital_accounts for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_membership_active() and (
           adex.ctx_role() = 'superadmin'
        or (kind in ('admin', 'partner', 'custody') and membership_id = adex.ctx_membership())
        or (kind = 'custody' and adex.ctx_is(array['admin', 'supervisor', 'socio']) and adex.ctx_route_allowed(route_id))));

-- Operaciones visibles: las que mueven la bolsa propia, la custodia propia o, para
-- quien gestiona la ruta, la custodia de esa ruta. Una anulación se ve como su original.
create policy capital_operations_ctx on adex.capital_operations for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_membership_active() and (
           adex.ctx_role() = 'superadmin'
        or admin_membership_id = adex.ctx_membership()
        or (coalesce(reverses_kind, kind) in ('WORKER_DELIVERY', 'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT')
            and (adex.ctx_membership() in (worker_membership_id, counterpart_membership_id)
                 or (adex.ctx_is(array['admin', 'supervisor', 'socio'])
                     and (adex.ctx_route_allowed(route_id) or adex.ctx_route_allowed(to_route_id)))))
        or (coalesce(reverses_kind, kind) = 'PARTNER_CONTRIBUTION' and counterpart_membership_id = adex.ctx_membership())));

-- Patas: solo las de cuentas visibles (la subconsulta está sujeta a la RLS de cuentas).
create policy capital_entries_ctx on adex.capital_entries for select to adex_api
  using (company_id = adex.ctx_company()
         and exists (select 1 from adex.capital_accounts a where a.company_id = capital_entries.company_id and a.id = capital_entries.account_id));

-- ============================================================
-- 3. Escritura: `adex.capital_post`
-- ============================================================

-- Cuenta de (empresa, tipo, membresía, ruta); se crea con saldo 0 la primera vez.
create function adex.capital_account_for(p_company text, p_kind text, p_membership text, p_route text) returns text
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  declare v_id text := 'acc-' || md5(p_company || '|' || p_kind || '|' || coalesce(p_membership, '') || '|' || coalesce(p_route, ''));
  begin
    insert into adex.capital_accounts (id, company_id, kind, membership_id, route_id)
    values (v_id, p_company, p_kind, p_membership, p_route) on conflict (id) do nothing;
    return v_id;
  end $$;

-- ¿`p_membership` puede RECIBIR efectivo en la ruta? (`custodianBlockedReason` de CLEAN:
-- misma empresa, activa, con caja personal —Cobrador o Supervisor— y asignada a la ruta).
create function adex.capital_custodian_ok(p_company text, p_route text, p_membership text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select exists (select 1 from adex.memberships m
                     join adex.membership_routes mr on mr.membership_id = m.id and mr.route_id = p_route and mr.company_id = m.company_id
                    where m.company_id = p_company and m.id = p_membership and m.status = 'activo'
                      and m.role in ('cobrador', 'supervisor'))
  $$;

-- ¿El periodo (semana) de la ruta que contiene `p_date` está cerrado? (D7)
create function adex.capital_period_closed(p_company text, p_route text, p_date date) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select exists (select 1 from adex.weekly_settlements w
                    where w.company_id = p_company and w.route_id = p_route
                      and coalesce(w.status, 'cerrada') = 'cerrada' and p_date between w.week_start and w.week_end)
  $$;

create function adex.capital_raise(p_code text, p_message text) returns void
  language plpgsql
  as $$ begin raise exception 'adex: %', p_message using errcode = p_code; end $$;

create function adex.capital_post(
  p_operation_id uuid,
  p_kind         text,
  p_amount       bigint,
  p_reason       text,
  p_route        text default null,
  p_worker       text default null,
  p_counterpart  text default null,
  p_to_route     text default null,
  p_admin        text default null,
  p_sale_request text default null,
  p_reverses     text default null
) returns adex.capital_operations
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company   text := adex.ctx_company();
    v_actor     text := adex.ctx_membership();
    v_role      text := adex.ctx_role();          -- NULL sin contexto válido (sesión, membresía, empresa)
    v_identity  uuid := adex.ctx_identity();
    v_reversal  boolean := p_kind = 'REVERSAL';
    v_currency  char(3);
    v_date      date;
    v_kind      text := p_kind;
    v_amount    bigint := p_amount;
    v_route     text := p_route;
    v_to_route  text := p_to_route;
    v_worker    text := p_worker;
    v_counter   text := p_counterpart;
    v_admin     text := p_admin;
    v_orig      adex.capital_operations;
    v_ctrl      text;
    v_ctrl2     text;
    v_accts     text[];
    v_amts      bigint[];
    v_bal       bigint;
    v_carried   bigint;
    v_op        adex.capital_operations;
    v_i         int;
    v_cname     text;
  begin
    -- ---------- Contexto y entrada ----------
    if session_user <> 'adex_api' then
      perform adex.capital_raise('42501', 'capital commands run only through the company API');
    end if;
    if v_role is null or v_company is null or v_identity is null or v_actor is null then
      perform adex.capital_raise('42501', 'no valid active context');
    end if;
    if v_role not in ('superadmin', 'admin', 'supervisor') then
      perform adex.capital_raise('AX402', 'role has no capital authority');
    end if;
    if p_operation_id is null or p_kind is null then perform adex.capital_raise('AX411', 'operation id and kind are required'); end if;
    if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then perform adex.capital_raise('AX411', 'reason is required'); end if;
    select c.currency_code, (now() at time zone c.timezone)::date into v_currency, v_date from adex.companies c where c.id = v_company;
    if exists (select 1 from adex.capital_operations where company_id = v_company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;

    -- ---------- Anulación: todo se deriva de la operación original ----------
    if v_reversal then
      if p_reverses is null then perform adex.capital_raise('AX411', 'reversal needs the original operation'); end if;
      perform pg_advisory_xact_lock(adex.lock_key('capital-reversal', v_company || ':' || p_reverses));
      select * into v_orig from adex.capital_operations where company_id = v_company and id = p_reverses;
      if not found then perform adex.capital_raise('AX412', 'operation not found'); end if;
      if v_orig.kind = 'REVERSAL' then perform adex.capital_raise('AX404', 'a reversal cannot be reversed'); end if;
      -- «Anular» un retiro de la empresa reintroduciría dinero: si vuelve, es un depósito nuevo.
      if v_orig.kind = 'COMPANY_WITHDRAWAL' then perform adex.capital_raise('AX404', 'a company withdrawal is corrected with a new deposit'); end if;
      if exists (select 1 from adex.capital_operations where company_id = v_company and reverses_operation_id = v_orig.id) then
        perform adex.capital_raise('AX405', 'operation already reversed');
      end if;
      v_kind := v_orig.kind; v_amount := v_orig.amount_minor; v_route := v_orig.route_id; v_to_route := v_orig.to_route_id;
      v_worker := v_orig.worker_membership_id; v_counter := v_orig.counterpart_membership_id; v_admin := v_orig.admin_membership_id;
    end if;

    -- ---------- Campos obligatorios por tipo ----------
    if v_amount is null or v_amount <= 0 then perform adex.capital_raise('AX411', 'amount must be a positive integer'); end if;
    if (v_kind in ('ADMIN_ALLOCATION', 'ADMIN_RETURN') and v_admin is null)
       or (v_kind in ('PARTNER_CONTRIBUTION', 'WORKER_DELIVERY', 'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and v_route is null)
       or (v_kind in ('WORKER_DELIVERY', 'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and v_worker is null)
       or (v_kind in ('PARTNER_CONTRIBUTION', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and v_counter is null)
       or (v_kind = 'ROUTE_REASSIGNMENT' and (v_to_route is null or v_to_route = v_route))
       or (v_kind not in ('ROUTE_REASSIGNMENT') and v_to_route is not null)
       or (v_kind in ('COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN') and v_route is not null)
       or (p_sale_request is not null and (v_reversal or v_kind <> 'WORKER_DELIVERY')) then
      perform adex.capital_raise('AX411', 'invalid fields for this operation kind');
    end if;

    -- ---------- Rutas: bloqueo y responsable releído bajo bloqueo (R5) ----------
    if v_route is not null then
      perform 1 from adex.routes where company_id = v_company and id in (v_route, v_to_route) order by id for update;
      select capital_controller_membership_id into v_ctrl from adex.routes where company_id = v_company and id = v_route;
      if not found then perform adex.capital_raise('AX412', 'route not found'); end if;
      if v_ctrl is not null and not adex.route_controller_valid_internal(v_company, v_route) then v_ctrl := null; end if;
      if v_to_route is not null then
        select capital_controller_membership_id into v_ctrl2 from adex.routes where company_id = v_company and id = v_to_route;
        if not found then perform adex.capital_raise('AX412', 'route not found'); end if;
        if v_ctrl2 is not null and not adex.route_controller_valid_internal(v_company, v_to_route) then v_ctrl2 := null; end if;
      end if;
      if v_ctrl is null or (v_to_route is not null and v_ctrl2 is null) then
        perform adex.capital_raise('AX408', 'route has no valid capital controller');
      end if;
      if adex.capital_period_closed(v_company, v_route, v_date)
         or (v_to_route is not null and adex.capital_period_closed(v_company, v_to_route, v_date)) then
        perform adex.capital_raise('AX407', 'the period of the route is closed');
      end if;
    end if;

    -- ---------- Autoridad y patas por tipo ----------
    -- structural = solo el responsable; settle = responsable, SuperAdmin o Supervisor
    -- asignado; correct = responsable o SuperAdmin (`routeCashAuthorityError` de CLEAN).
    -- Comparaciones con IS [NOT] DISTINCT FROM: un NULL nunca concede autoridad.
    if v_kind in ('COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN') then
      if v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the SuperAdmin moves company capital'); end if;
      if v_kind in ('ADMIN_ALLOCATION', 'ADMIN_RETURN') then
        -- Recibir capital exige estar activo; devolverlo, no (una bolsa inactiva se vacía).
        if not exists (select 1 from adex.memberships where company_id = v_company and id = v_admin and role = 'admin'
                         and (status = 'activo' or (v_kind = 'ADMIN_ALLOCATION') = v_reversal)) then
          perform adex.capital_raise('AX412', 'administrator not found or inactive');
        end if;
      end if;
      case v_kind
        when 'COMPANY_DEPOSIT'    then v_accts := array[adex.capital_account_for(v_company, 'external', null, null), adex.capital_account_for(v_company, 'company', null, null)];
        when 'COMPANY_WITHDRAWAL' then v_accts := array[adex.capital_account_for(v_company, 'company', null, null), adex.capital_account_for(v_company, 'external', null, null)];
        when 'ADMIN_ALLOCATION'   then v_accts := array[adex.capital_account_for(v_company, 'company', null, null), adex.capital_account_for(v_company, 'admin', v_admin, null)];
        else                           v_accts := array[adex.capital_account_for(v_company, 'admin', v_admin, null), adex.capital_account_for(v_company, 'company', null, null)];
      end case;

    elsif v_kind = 'PARTNER_CONTRIBUTION' then
      -- Socio → bolsa del responsable de la ruta que el aporte va a operar (C1). Caja
      -- socios (D1) no se toca: si debe tener saldo sigue siendo una decisión abierta.
      if v_reversal then
        if v_actor is distinct from v_ctrl and v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can correct'); end if;
      else
        if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the route capital controller receives partner capital'); end if;
        if not adex.route_operational(v_company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
        if not exists (select 1 from adex.memberships where company_id = v_company and id = v_counter and role = 'socio') then
          perform adex.capital_raise('AX412', 'partner not found');
        end if;
        -- `isTransferInScope`: el socio comparte alguna ruta con quien registra.
        if not exists (select 1 from adex.membership_routes p join adex.membership_routes a on a.route_id = p.route_id and a.company_id = p.company_id
                        where p.company_id = v_company and p.membership_id = v_counter and a.membership_id = v_actor) then
          perform adex.capital_raise('AX402', 'partner is outside your scope');
        end if;
        v_admin := v_ctrl;
      end if;
      v_accts := array[adex.capital_account_for(v_company, 'partner', v_counter, null), adex.capital_account_for(v_company, 'admin', v_admin, null)];

    elsif v_kind = 'WORKER_DELIVERY' then
      if v_reversal then
        if v_actor is distinct from v_ctrl and v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can correct'); end if;
      else
        if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the route capital controller delivers capital'); end if;
        if not adex.route_operational(v_company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
        if not adex.capital_custodian_ok(v_company, v_route, v_worker) then perform adex.capital_raise('AX403', 'recipient cannot hold cash in this route'); end if;
        if p_sale_request is not null and not exists (select 1 from adex.sale_requests where company_id = v_company and id = p_sale_request and route_id = v_route) then
          perform adex.capital_raise('AX412', 'sale request not found in this route');
        end if;
      end if;
      v_admin := v_ctrl;   -- paga (o, al anular, recupera) la bolsa que HOY responde por la ruta
      v_accts := array[adex.capital_account_for(v_company, 'admin', v_admin, null), adex.capital_account_for(v_company, 'custody', v_worker, v_route)];

    elsif v_kind = 'WORKER_RETURN' then
      if v_reversal then
        if v_actor is distinct from v_ctrl and v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can correct'); end if;
      else
        if not (v_actor is not distinct from v_ctrl or v_role = 'superadmin'
                or (v_role = 'supervisor' and exists (select 1 from adex.membership_routes where company_id = v_company and membership_id = v_actor and route_id = v_route))) then
          perform adex.capital_raise('AX402', 'no authority to receive returns in this route');
        end if;
        if not exists (select 1 from adex.memberships where company_id = v_company and id = v_worker and role in ('cobrador', 'supervisor')) then
          perform adex.capital_raise('AX403', 'worker not found');
        end if;
      end if;
      v_admin := v_ctrl;
      v_accts := array[adex.capital_account_for(v_company, 'custody', v_worker, v_route), adex.capital_account_for(v_company, 'admin', v_admin, null)];

    elsif v_kind = 'WORKER_TRANSFER' then
      if v_reversal then
        if v_actor is distinct from v_ctrl and v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can correct'); end if;
        v_accts := array[adex.capital_account_for(v_company, 'custody', v_counter, v_route), adex.capital_account_for(v_company, 'custody', v_worker, v_route)];
      else
        if not (v_actor is not distinct from v_ctrl or v_role = 'superadmin'
                or (v_role = 'supervisor' and exists (select 1 from adex.membership_routes where company_id = v_company and membership_id = v_actor and route_id = v_route))) then
          perform adex.capital_raise('AX402', 'no authority over cash in this route');
        end if;
        if v_worker = v_counter then perform adex.capital_raise('AX411', 'origin and destination must differ'); end if;
        if not adex.route_operational(v_company, v_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
        if not exists (select 1 from adex.memberships m join adex.membership_routes mr on mr.membership_id = m.id and mr.route_id = v_route and mr.company_id = m.company_id
                        where m.company_id = v_company and m.id = v_worker and m.role in ('cobrador', 'supervisor')) then
          perform adex.capital_raise('AX403', 'origin worker is not assigned to this route');
        end if;
        if not adex.capital_custodian_ok(v_company, v_route, v_counter) then perform adex.capital_raise('AX403', 'recipient cannot hold cash in this route'); end if;
        v_accts := array[adex.capital_account_for(v_company, 'custody', v_worker, v_route), adex.capital_account_for(v_company, 'custody', v_counter, v_route)];
      end if;

    elsif v_kind = 'ROUTE_REASSIGNMENT' then
      -- Devolución en una ruta + entrega en otra, por el MISMO responsable, en una sola
      -- operación: cada ruta conserva su atribución y el dinero pasa por la bolsa.
      -- Entre responsables distintos es la decisión abierta D2: se bloquea solo ese caso.
      if v_ctrl is distinct from v_ctrl2 then perform adex.capital_raise('AX406', 'routes with different capital controllers (decision D2 pending)'); end if;
      if v_reversal then
        if v_actor is distinct from v_ctrl and v_role <> 'superadmin' then perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can correct'); end if;
        v_accts := array[adex.capital_account_for(v_company, 'custody', v_counter, v_to_route), adex.capital_account_for(v_company, 'admin', v_ctrl, null),
                         adex.capital_account_for(v_company, 'admin', v_ctrl, null), adex.capital_account_for(v_company, 'custody', v_worker, v_route)];
      else
        if v_actor is distinct from v_ctrl then perform adex.capital_raise('AX402', 'only the capital controller of both routes reassigns cash'); end if;
        if not adex.route_operational(v_company, v_to_route) then perform adex.capital_raise('AX301', 'route is not operational'); end if;
        if not exists (select 1 from adex.memberships where company_id = v_company and id = v_worker and role in ('cobrador', 'supervisor')) then
          perform adex.capital_raise('AX403', 'worker not found');
        end if;
        if not adex.capital_custodian_ok(v_company, v_to_route, v_counter) then perform adex.capital_raise('AX403', 'recipient cannot hold cash in the destination route'); end if;
        v_accts := array[adex.capital_account_for(v_company, 'custody', v_worker, v_route), adex.capital_account_for(v_company, 'admin', v_ctrl, null),
                         adex.capital_account_for(v_company, 'admin', v_ctrl, null), adex.capital_account_for(v_company, 'custody', v_counter, v_to_route)];
      end if;
      v_admin := v_ctrl;
    else
      perform adex.capital_raise('AX411', 'unknown operation kind');
    end if;

    -- Anular invierte el sentido. Los tipos de dos patas se construyeron en el sentido
    -- original: se intercambian. Traspaso y reasignación ya se construyeron invertidos.
    if v_reversal and array_length(v_accts, 1) = 2 and v_kind <> 'WORKER_TRANSFER' then
      v_accts := array[v_accts[2], v_accts[1]];
    end if;
    v_amts := case when array_length(v_accts, 1) = 4 then array[-v_amount, v_amount, -v_amount, v_amount] else array[-v_amount, v_amount] end;

    -- Nadie REDUCE su propia custodia, ni con otra de sus membresías (DS-05: misma
    -- persona). Quien entrega el efectivo no puede ser quien registra que lo entregó.
    if exists (select 1 from adex.capital_accounts a join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
                where a.company_id = v_company and a.id = v_accts[1] and a.kind = 'custody'
                  and (m.id = v_actor or m.identity_id = v_identity)) then
      perform adex.capital_raise('AX410', 'nobody reduces their own custody');
    end if;

    -- ---------- Bloqueo de cuentas en orden global ----------
    perform 1 from adex.capital_accounts
      where company_id = v_company and id = any(v_accts)
      order by array_position(array['company', 'admin', 'custody', 'partner', 'external'], kind), id
      for update;

    -- Efectivo en manos (no deuda arrastrada) para lo que mueve billetes ya entregados:
    -- traspasos, reasignaciones y anular una entrega (`transferableCash` de CLEAN).
    if (v_kind in ('WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') or (v_reversal and v_kind = 'WORKER_DELIVERY')) then
      select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = v_company and id = v_accts[1];
      if v_bal - v_carried < v_amount then perform adex.capital_raise('AX413', 'the cash was already used'); end if;
    end if;

    -- ---------- Escritura ----------
    insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, to_route_id,
                                         admin_membership_id, worker_membership_id, counterpart_membership_id, sale_request_id,
                                         reverses_operation_id, reverses_kind, reason, entry_date, actor_membership_id, actor_identity_id,
                                         actor_role, txid)
    values (gen_random_uuid()::text, v_company, p_operation_id, p_kind, v_amount, v_currency, v_route, v_to_route,
            v_admin, v_worker, v_counter, case when v_reversal then v_orig.sale_request_id else p_sale_request end,
            v_orig.id, case when v_reversal then v_orig.kind end, btrim(p_reason), v_date, v_actor, v_identity, v_role, txid_current())
    returning * into v_op;

    for v_i in 1 .. array_length(v_accts, 1) loop
      update adex.capital_accounts
         set balance_minor = balance_minor + v_amts[v_i], version = version + 1, updated_at = now()
       where company_id = v_company and id = v_accts[v_i]
      returning balance_minor into v_bal;
      insert into adex.capital_entries (company_id, operation_id, leg, account_id, amount_minor, balance_after_minor)
      values (v_company, v_op.id, v_i, v_accts[v_i], v_amts[v_i], v_bal);
    end loop;
    return v_op;
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      -- El sobregiro se informa SIN cifras: nunca revela el saldo de otra cuenta.
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_reversal_key' then perform adex.capital_raise('AX405', 'operation already reversed'); end if;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;

-- ---------- Responsable de capital: Base de la ruta al cambiar (informativo) ----------
-- Σ custodias de la ruta (todas las personas). Solo para quien ya alcanza la ruta.
create function adex.capital_route_custody_total(p_company text, p_route text) returns bigint
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select case when adex.api_scope_ok(p_company) and (session_user <> 'adex_api' or adex.ctx_route_allowed(p_route))
                then coalesce((select sum(balance_minor) from adex.capital_accounts
                                where company_id = p_company and kind = 'custody' and route_id = p_route), 0)::bigint end
  $$;

-- ---------- Privilegios ----------
-- Lectura con RLS; NINGUNA escritura directa: solo la función.
grant select on adex.capital_accounts, adex.capital_operations, adex.capital_entries to adex_api;
grant execute on function adex.capital_post(uuid, text, bigint, text, text, text, text, text, text, text, text),
  adex.capital_route_custody_total(text, text) to adex_api;
revoke all on function adex.capital_account_for(text, text, text, text), adex.capital_custodian_ok(text, text, text),
  adex.capital_period_closed(text, text, date), adex.capital_raise(text, text),
  adex.assert_capital_operation_balanced(), adex.assert_capital_operation_has_entries(), adex.guard_capital_account() from public;
