-- ============================================================
-- ADEX SaaS · Fase 6 · 0014 · Cuadres y cierres
-- ------------------------------------------------------------
-- Autorizada por el propietario (Fase 6, 2026-10-17). Solo en línea (DS-07). Mismo
-- motor que las Fases 3–5 (Empresa → bolsa del Administrador → custodia del
-- trabajador por ruta, SIN caja de ruta). Decisiones aplicadas: DS-04 (zona horaria
-- de la empresa y reloj del servidor) y F6-D01 (entregas parciales y varios cuadres
-- por trabajador dentro de un periodo; entregas, cuadres y cierres independientes).
--
-- CONCEPTOS (cada uno su propio objeto; ninguno arrastra a otro):
--   · Entrega parcial: WORKER_RETURN de la Fase 3 (custodia → bolsa). No cierra nada.
--   · Cuadre: `custody_settlements`. Concilia esperado, entregado, diferencia y
--     arrastre de UN trabajador en UNA ruta. Su ciclo es un tramo del libro de esa
--     custodia (secuencia de patas), no un rango de fechas: dos cuadres el mismo día
--     son dos ciclos (CLEAN `cashSettlementRules`). No cierra la semana.
--   · Liquidación: cálculo desde el libro por ruta, trabajador y rango de fechas
--     (`route_period_figures`). Consultarla no mueve dinero.
--   · Cierre de periodo: `weekly_settlements` (la MISMA fila que ya protege D7 en
--     todas las funciones de dinero) + `period_closures` (archivo inmutable de las
--     cifras del libro). No inventa entregas ni mueve dinero.
--
-- FÓRMULA DEL CUADRE (CLEAN `computeExpected`, adaptada al libro):
--   posición P = saldo de la custodia = arrastre/negativo anterior + Base recibida
--                − devuelta (incluidas las entregas parciales) + recaudado
--                − desembolsado − gastos   (las patas del ciclo, comprobado)
--   efectivo esperado E = máx(P, 0)          (un negativo no es efectivo)
--   diferencia = entregado − E; faltante = máx(0, −dif); sobrante = máx(0, dif)
--   a la bolsa T = mín(entregado, E)         (= entregado − sobrante, `cuadreReturnToPool`)
--   después: saldo = P − T; arrastre = faltante (`carryOverFrom`).
--   · FALTANTE: queda en la custodia como DEUDA marcada en `carried_minor`
--     (previsto por 0009). Saldo − arrastre = 0: no se traspasa, no se devuelve, no
--     se desembolsa ni se anula con él (guardia nueva sobre TODAS las patas). Al
--     cuadrar el ciclo siguiente forma parte del esperado UNA vez (está en el saldo).
--   · SOBRANTE: no es capital ni crédito. Se registra en dos cuentas de CONTROL de la
--     ruta: `suspense` (efectivo recibido sin identificar, en manos del responsable,
--     nunca gastable: ninguna función lo debita salvo la reapertura del propio
--     cuadre) y su contrapartida `unidentified` (origen sin identificar, ≤ 0). Σ = 0.
--     Qué hacer con él (devolverlo, reconocerlo como ingreso, imputarlo) es una
--     decisión de negocio NO tomada aquí (F6-D02, pendiente).
--   · NEGATIVO (gasto del trabajador sin efectivo, 73209ce/Fase 5): E = 0, nada
--     vuelve a la bolsa, el negativo sigue en la custodia al ciclo siguiente y lo
--     compensan las operaciones válidas posteriores. Sin reembolso automático.
--     (CLEAN calculaba dif = entregado − P y lo convertía en «sobrante», perdiendo el
--     negativo al arrastrar 0: sería un reembolso implícito no aprobado.)
--
-- ORDEN DE BLOQUEOS (el vigente, extendido): consultivos de REVOKE-004 → ruta
-- (FOR SHARE el cuadre y su reapertura, como recaudos y gastos; FOR UPDATE el cierre
-- de periodo, que así espera a todo lo que está en curso en la ruta) → cuadre →
-- cuentas (empresa → bolsas → custodias → cartera → socios → externa → interés →
-- gasto → control de sobrantes).
-- ============================================================

-- ============================================================
-- 1. Libro: secuencia de patas y cuentas de control
-- ============================================================
-- Orden de las patas de UNA cuenta. Toda escritura bloquea la fila de la cuenta
-- (UPDATE) ANTES de insertar su pata, así que para una misma cuenta el orden de
-- `seq` es el orden de confirmación: cada movimiento cae exactamente en un ciclo.
alter table adex.capital_entries add column seq bigint generated always as identity;
create index capital_entries_account_seq on adex.capital_entries (company_id, account_id, seq);

alter table adex.capital_accounts drop constraint capital_accounts_kind_check;
alter table adex.capital_accounts add constraint capital_accounts_kind_check
  check (kind in ('company', 'admin', 'custody', 'external', 'partner', 'portfolio', 'income', 'expense', 'suspense', 'unidentified'));
alter table adex.capital_accounts drop constraint capital_accounts_shape_check;
alter table adex.capital_accounts add constraint capital_accounts_shape_check
  check (case kind
           when 'company'      then membership_id is null and route_id is null
           when 'external'     then membership_id is null and route_id is null
           when 'admin'        then membership_id is not null and route_id is null
           when 'partner'      then membership_id is not null and route_id is null
           when 'custody'      then membership_id is not null and route_id is not null
           when 'portfolio'    then membership_id is null and route_id is not null
           when 'income'       then membership_id is null and route_id is not null
           when 'expense'      then membership_id is null
           -- Sobrante recibido en un cuadre, en manos del responsable que lo recibió (control).
           when 'suspense'     then membership_id is not null and route_id is not null
           -- Su origen, sin identificar (contrapartida: mide lo recibido, nunca positiva).
           when 'unidentified' then membership_id is null and route_id is not null
         end);
alter table adex.capital_accounts drop constraint capital_accounts_no_overdraft;
alter table adex.capital_accounts add constraint capital_accounts_no_overdraft
  check (kind in ('external', 'partner', 'income', 'custody', 'unidentified') or balance_minor >= 0);
alter table adex.capital_accounts add constraint capital_accounts_unidentified_sign check (kind <> 'unidentified' or balance_minor <= 0);

-- ============================================================
-- 2. Cuadres por trabajador (servidor)
-- ============================================================
-- `cash_settlements` (0002) sigue siendo el histórico importado de CLEAN (DS-06). El
-- cuadre del servidor guarda además el tramo del libro, la posición con signo y los
-- asientos que produjo; ninguna de sus cifras es una segunda fuente: todas se
-- recalculan desde `capital_entries` (lo comprueba la conciliación).
create table adex.custody_settlements (
  id                            adex.eid primary key,
  company_id                    adex.eid not null references adex.companies(id),
  route_id                      adex.eid not null,
  worker_membership_id          adex.eid not null,
  worker_identity_id            uuid,
  custody_account_id            adex.eid not null,
  operation_id                  uuid not null,                 -- idempotencia del comando
  -- Número de ciclo de la custodia: el del cuadre vigente anterior + 1. Volver a cerrar
  -- un ciclo reabierto repite el número con una VERSIÓN nueva (`nextCashVersion`).
  cycle_no                      integer not null check (cycle_no >= 1),
  version                       integer not null check (version >= 1),
  previous_settlement_id        adex.eid,                      -- cuadre vigente anterior (origen del ciclo)
  -- Ciclo = patas de la custodia con from_seq < seq ≤ to_seq; el asiento del propio
  -- cuadre queda en (to_seq, closing_seq]; el ciclo siguiente parte de closing_seq.
  from_seq                      bigint not null check (from_seq >= 0),
  to_seq                        bigint not null,
  closing_seq                   bigint not null,
  opening_position_minor        bigint not null,               -- saldo al empezar (arrastre o negativo anterior)
  opening_carried_minor         bigint not null check (opening_carried_minor >= 0),
  base_received_minor           bigint not null,               -- Base recibida + traspasos recibidos
  base_returned_minor           bigint not null,               -- entregas parciales + traspasos entregados
  collected_minor               bigint not null,
  disbursed_minor               bigint not null,
  expenses_minor                bigint not null,
  other_minor                   bigint not null,               -- reaperturas de cuadres anteriores, etc.
  expected_position_minor       bigint not null,               -- P (con signo)
  expected_cash_minor           bigint not null,               -- E = máx(P, 0)
  expected_seen_minor           bigint not null,               -- lo que la pantalla mostraba (debe coincidir)
  delivered_minor               bigint not null check (delivered_minor >= 0),
  difference_minor              bigint not null,
  shortage_minor                bigint not null,
  surplus_minor                 bigint not null,
  returned_to_pool_minor        bigint not null,
  carried_after_minor           bigint not null,
  negative_position_minor       bigint not null,               -- mín(P, 0): sigue en la custodia
  breakdown                     jsonb not null,
  reason                        text check (reason is null or length(reason) <= 300),
  status                        text not null check (status in ('cerrada', 'reabierta')),
  superseded_by                 adex.eid,
  business_date                 date not null,                 -- fecha contable (zona de la empresa, DS-04)
  timezone                      text not null,
  closed_at                     timestamptz not null,
  closed_by_membership_id       adex.eid not null,
  closed_by_identity_id         uuid not null references adex.identities(id),
  closed_by_role                text not null check (closed_by_role in ('superadmin', 'admin', 'supervisor')),
  receiver_admin_membership_id  adex.eid not null,             -- bolsa que recibió (responsable al cuadrar)
  return_operation_id           adex.eid,
  surplus_operation_id          adex.eid,
  reopened_at                   timestamptz,
  reopened_by_membership_id     adex.eid,
  reopen_reason                 text,
  txid                          bigint not null,
  unique (company_id, id),
  constraint custody_settlements_operation_key unique (company_id, operation_id),
  check (from_seq <= to_seq and to_seq <= closing_seq),
  check (expected_position_minor = opening_position_minor + base_received_minor - base_returned_minor
                                   + collected_minor - disbursed_minor - expenses_minor + other_minor),
  check (expected_cash_minor = greatest(0, expected_position_minor)),
  check (difference_minor = delivered_minor - expected_cash_minor),
  check (shortage_minor = greatest(0, -difference_minor)),
  check (surplus_minor = greatest(0, difference_minor)),
  check (returned_to_pool_minor = least(delivered_minor, expected_cash_minor)),
  check (carried_after_minor = shortage_minor),
  check (negative_position_minor = least(0, expected_position_minor)),
  check (expected_seen_minor = expected_position_minor),
  check (difference_minor = 0 or length(btrim(coalesce(reason, ''))) >= 10),
  check ((returned_to_pool_minor > 0) = (return_operation_id is not null)),
  check ((surplus_minor > 0) = (surplus_operation_id is not null)),
  check ((status = 'reabierta') = (reopened_at is not null)),
  check (status <> 'reabierta' or length(btrim(coalesce(reopen_reason, ''))) >= 10),
  foreign key (company_id, route_id)                     references adex.routes(company_id, id),
  foreign key (company_id, worker_membership_id)         references adex.memberships(company_id, id),
  foreign key (company_id, custody_account_id)           references adex.capital_accounts(company_id, id),
  foreign key (company_id, previous_settlement_id)       references adex.custody_settlements(company_id, id),
  foreign key (company_id, superseded_by)                references adex.custody_settlements(company_id, id) deferrable initially deferred,
  foreign key (company_id, closed_by_membership_id)      references adex.memberships(company_id, id),
  foreign key (company_id, receiver_admin_membership_id) references adex.memberships(company_id, id),
  foreign key (company_id, reopened_by_membership_id)    references adex.memberships(company_id, id)
);
create index custody_settlements_account on adex.custody_settlements (company_id, custody_account_id, cycle_no);
create index custody_settlements_route_date on adex.custody_settlements (company_id, route_id, business_date);
-- Un solo cuadre VIGENTE por ciclo: dos cierres simultáneos del mismo ciclo no conviven.
create unique index custody_settlements_one_active_per_cycle
  on adex.custody_settlements (company_id, custody_account_id, cycle_no) where status = 'cerrada';

create trigger custody_settlements_closure before update on adex.custody_settlements
  for each row execute function adex.guard_closure();
create trigger custody_settlements_no_delete before delete on adex.custody_settlements
  for each statement execute function adex.reject_mutation();
create trigger custody_settlements_no_truncate before truncate on adex.custody_settlements
  for each statement execute function adex.reject_mutation();

-- ---------- Operaciones del cuadre en el libro ----------
alter table adex.capital_operations drop constraint capital_operations_kind_check;
alter table adex.capital_operations add constraint capital_operations_kind_check check (kind in (
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
  'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'REVERSAL', 'LOAN_DISBURSEMENT',
  'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE', 'EXPENSE_REFUND',
  'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS'));
alter table adex.capital_operations drop constraint capital_operations_reverses_kind_check;
alter table adex.capital_operations add constraint capital_operations_reverses_kind_check
  check (reverses_kind is null or reverses_kind in ('COMPANY_DEPOSIT', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION',
                                                   'WORKER_DELIVERY', 'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT',
                                                   'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE',
                                                   'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS'));
alter table adex.capital_operations add column settlement_id adex.eid;
alter table adex.capital_operations add constraint capital_operations_settlement_fk
  foreign key (company_id, settlement_id) references adex.custody_settlements(company_id, id) deferrable initially deferred;
alter table adex.capital_operations add constraint capital_operations_settlement_shape
  check ((coalesce(reverses_kind, kind) in ('SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS')) = (settlement_id is not null));
-- Un retorno y un sobrante por cuadre, y como mucho una anulación de cada uno.
create unique index capital_operations_one_per_settlement
  on adex.capital_operations (company_id, settlement_id, coalesce(reverses_kind, kind), (kind = 'REVERSAL')) where settlement_id is not null;

alter table adex.custody_settlements add constraint custody_settlements_return_fk
  foreign key (company_id, return_operation_id) references adex.capital_operations(company_id, id);
alter table adex.custody_settlements add constraint custody_settlements_surplus_fk
  foreign key (company_id, surplus_operation_id) references adex.capital_operations(company_id, id);

-- ============================================================
-- 3. Cierre de periodo: archivo inmutable de las cifras del libro
-- ============================================================
-- La fila de `weekly_settlements` (misma id) es la que protege el periodo (D7) en
-- todas las funciones de dinero; aquí se archiva el detalle con el que se cerró.
create table adex.period_closures (
  id                       adex.eid primary key,
  company_id               adex.eid not null references adex.companies(id),
  route_id                 adex.eid not null,
  operation_id             uuid not null,
  week_start               date not null,
  week_end                 date not null,
  version                  integer not null check (version >= 1),
  business_date            date not null,             -- día del cierre (zona de la empresa)
  timezone                 text not null,
  figures                  jsonb not null,            -- cifras del libro (ruta, trabajadores, bolsa, crédito, cuadres)
  ledger_operations        integer not null,          -- operaciones del rango
  ledger_hash              text not null,             -- huella de sus ids (referencia verificable)
  ledger_last_seq          bigint not null,
  note                     text check (note is null or length(note) <= 300),
  closed_at                timestamptz not null,
  closed_by_membership_id  adex.eid not null,
  closed_by_identity_id    uuid not null references adex.identities(id),
  closed_by_role           text not null check (closed_by_role in ('superadmin', 'admin')),
  txid                     bigint not null,
  unique (company_id, id),
  constraint period_closures_operation_key unique (company_id, operation_id),
  check (week_start <= week_end and week_end < business_date),   -- D29: solo un periodo terminado
  foreign key (company_id, id)                      references adex.weekly_settlements(company_id, id),
  foreign key (company_id, route_id)                references adex.routes(company_id, id),
  foreign key (company_id, closed_by_membership_id) references adex.memberships(company_id, id)
);
create trigger period_closures_immutable before update or delete on adex.period_closures
  for each row execute function adex.reject_mutation();
create trigger period_closures_no_truncate before truncate on adex.period_closures
  for each statement execute function adex.reject_mutation();

-- ============================================================
-- 4. RLS y visibilidad
-- ============================================================
alter table adex.custody_settlements enable row level security;
alter table adex.custody_settlements force row level security;
alter table adex.period_closures enable row level security;
alter table adex.period_closures force row level security;
create policy owner_all on adex.custody_settlements for all to adex_owner using (true) with check (true);
create policy owner_all on adex.period_closures for all to adex_owner using (true) with check (true);
create policy owner_period_close on adex.weekly_settlements for insert to adex_owner with check (true);
create policy owner_period_supersede on adex.weekly_settlements for update to adex_owner using (true) with check (true);

-- Cuadres (`cashSettlement.view` / `viewOwn`): quien gestiona la ruta, o la propia membresía.
create policy custody_settlements_ctx on adex.custody_settlements for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_membership_active() and adex.ctx_route_allowed(route_id)
         and (adex.ctx_is(array['superadmin', 'admin', 'supervisor']) or worker_membership_id = adex.ctx_membership()));
-- Cierres: como `weekly_settlements` (0009, `cashbox.viewRoute`).
create policy period_closures_ctx on adex.period_closures for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_membership_active() and adex.ctx_route_allowed(route_id)
         and adex.ctx_is(array['superadmin', 'admin', 'socio', 'supervisor']));

-- Cuentas: amplía 0009 con el sobrante en manos del Administrador que lo recibió.
drop policy capital_accounts_ctx on adex.capital_accounts;
create policy capital_accounts_ctx on adex.capital_accounts for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_membership_active() and (
           adex.ctx_role() = 'superadmin'
        or (kind in ('admin', 'partner', 'custody', 'suspense') and membership_id = adex.ctx_membership())
        or (kind = 'custody' and adex.ctx_is(array['admin', 'supervisor', 'socio']) and adex.ctx_route_allowed(route_id))));

-- Operaciones: amplía 0013 con el retorno y el sobrante del cuadre (y sus anulaciones).
drop policy capital_operations_ctx on adex.capital_operations;
create policy capital_operations_ctx on adex.capital_operations for select to adex_api
  using (company_id = adex.ctx_company() and adex.ctx_membership_active() and (
           adex.ctx_role() = 'superadmin'
        or admin_membership_id = adex.ctx_membership()
        or (coalesce(reverses_kind, kind) in ('WORKER_DELIVERY', 'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'LOAN_DISBURSEMENT',
                                              'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS')
            and (adex.ctx_membership() in (worker_membership_id, counterpart_membership_id)
                 or (adex.ctx_is(array['admin', 'supervisor', 'socio'])
                     and (adex.ctx_route_allowed(route_id) or adex.ctx_route_allowed(to_route_id)))))
        or (coalesce(reverses_kind, kind) = 'PARTNER_CONTRIBUTION' and counterpart_membership_id = adex.ctx_membership())));

-- ============================================================
-- 5. Segunda barrera: capacidades de CLEAN (amplía 0013; CAN-SQL-001 las verifica)
-- ============================================================
create or replace function adex.ctx_can(p_capability text) returns boolean
  language sql stable security definer set search_path = pg_catalog, adex
  as $$
    select coalesce(adex.ctx_role() = any(case p_capability
      when 'sale.createRequest'               then array['superadmin', 'admin', 'supervisor', 'cobrador']
      when 'sale.createDirect'                then array['superadmin', 'admin', 'supervisor']
      when 'sale.confirmDisbursement'         then array['superadmin', 'admin', 'supervisor', 'cobrador']
      when 'sale.cancel'                      then array['superadmin', 'admin']
      when 'authorization.access'             then array['superadmin', 'admin', 'supervisor', 'secretario']
      when 'authorization.approve'            then array['superadmin', 'admin', 'supervisor', 'secretario']
      when 'authorization.reject'             then array['superadmin', 'admin', 'supervisor', 'secretario']
      when 'authorization.modifyConditions'   then array['superadmin', 'admin', 'supervisor', 'secretario']
      when 'authorization.phoneConfirm'       then array['superadmin', 'supervisor', 'secretario']
      when 'payment.register'                 then array['superadmin', 'admin', 'supervisor', 'cobrador']
      when 'payment.reverse'                  then array['superadmin', 'admin']
      when 'payment.approveAdjustment'        then array['superadmin', 'admin']
      when 'payment.viewHistory'              then array['superadmin', 'admin', 'socio', 'supervisor', 'cobrador', 'secretario']
      when 'expense.register'                 then array['superadmin', 'admin', 'supervisor', 'cobrador']
      when 'expense.correct'                  then array['superadmin', 'admin']
      when 'cashCustody.manage'               then array['superadmin', 'admin', 'supervisor']
      when 'cashbox.viewConsolidated'         then array['superadmin', 'admin']
      when 'cashbox.viewRoute'                then array['superadmin', 'admin', 'socio', 'supervisor']
      when 'cashSettlement.view'              then array['superadmin', 'admin', 'supervisor']
      when 'cashSettlement.viewOwn'           then array['supervisor', 'cobrador']
      when 'cashSettlement.close'             then array['superadmin', 'admin', 'supervisor']
      when 'cashSettlement.reopen'            then array['superadmin', 'admin']
      when 'settlement.close'                 then array['superadmin', 'admin']
      when 'settlement.reopen'                then array['superadmin', 'admin']
      else array[]::text[] end), false)
  $$;

-- ============================================================
-- 6. Guardia del arrastre: un faltante no es efectivo (amplía 0013)
-- ============================================================
-- Toda pata que DEBITA una custodia, salvo el gasto del trabajador (73209ce), debe
-- dejar saldo ≥ arrastre: la deuda de un cuadre no se devuelve a una bolsa, no se
-- traspasa, no se desembolsa ni se usa para anular. El retorno del propio cuadre es
-- la excepción (es donde el arrastre se liquida) y nunca deja la custodia negativa.
-- Con arrastre 0 (todo lo anterior a la Fase 6) es exactamente la regla de 0013.
create or replace function adex.guard_custody_negative() returns trigger
  language plpgsql security definer set search_path = pg_catalog, adex
  as $$
  declare v_kind text; v_carried bigint; v_op text;
  begin
    if new.amount_minor >= 0 then return new; end if;
    select kind, carried_minor into v_kind, v_carried from adex.capital_accounts where company_id = new.company_id and id = new.account_id;
    if v_kind is distinct from 'custody' then return new; end if;
    select kind into v_op from adex.capital_operations where company_id = new.company_id and id = new.operation_id;
    if v_op = 'WORKER_EXPENSE' then return new; end if;
    if new.balance_after_minor < (case when v_op = 'SETTLEMENT_RETURN' then 0 else v_carried end) then
      -- Mismo nombre de restricción que el sobregiro: las funciones lo informan sin cifras.
      raise exception 'adex: custody cash below the carried shortage' using errcode = '23514', constraint = 'capital_accounts_no_overdraft';
    end if;
    return new;
  end $$;

-- Orden global de bloqueo de cuentas (amplía 0013 con las de control, al final).
create or replace function adex.capital_lock_accounts(p_company text, p_accounts text[]) returns void
  language plpgsql
  as $$ begin
    perform 1 from adex.capital_accounts
      where company_id = p_company and id = any(p_accounts)
      order by array_position(array['company', 'admin', 'custody', 'portfolio', 'partner', 'external', 'income', 'expense', 'suspense', 'unidentified'], kind), id
      for update;
  end $$;

-- ============================================================
-- 7. Periodos (DS-04): fecha contable con la zona de la empresa
-- ============================================================
create function adex.company_today(p_company text) returns date
  language sql stable security definer set search_path = pg_catalog, adex
  as $$ select (now() at time zone c.timezone)::date from adex.companies c where c.id = p_company and adex.api_scope_ok(p_company) $$;

-- ============================================================
-- 8. Ciclo de una custodia (una sola fórmula para vista previa, cuadre y conciliación)
-- ============================================================
create type adex.custody_cycle_t as (
  opening bigint, base_received bigint, transfers_in bigint, transfers_out bigint, partial_returns bigint,
  settlement_adjust bigint, collected bigint, disbursed bigint, expenses bigint, other bigint, entries integer);

create function adex.custody_cycle(p_company text, p_account text, p_from bigint, p_to bigint) returns adex.custody_cycle_t
  language sql stable
  as $$
    select coalesce((select sum(amount_minor) from adex.capital_entries where company_id = p_company and account_id = p_account and seq <= p_from), 0)::bigint,
           coalesce(sum(e.amount_minor) filter (where k.b = 'WORKER_DELIVERY'), 0)::bigint,
           coalesce(sum(e.amount_minor) filter (where k.b in ('WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and e.amount_minor > 0), 0)::bigint,
           coalesce(-sum(e.amount_minor) filter (where k.b in ('WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and e.amount_minor < 0), 0)::bigint,
           coalesce(-sum(e.amount_minor) filter (where k.b = 'WORKER_RETURN'), 0)::bigint,
           coalesce(sum(e.amount_minor) filter (where k.b = 'SETTLEMENT_RETURN'), 0)::bigint,
           coalesce(sum(e.amount_minor) filter (where k.b = 'COLLECTION'), 0)::bigint,
           coalesce(-sum(e.amount_minor) filter (where k.b = 'LOAN_DISBURSEMENT'), 0)::bigint,
           coalesce(-sum(e.amount_minor) filter (where k.b = 'WORKER_EXPENSE'), 0)::bigint,
           coalesce(sum(e.amount_minor) filter (where k.b not in ('WORKER_DELIVERY', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'WORKER_RETURN',
                                                                 'SETTLEMENT_RETURN', 'COLLECTION', 'LOAN_DISBURSEMENT', 'WORKER_EXPENSE')), 0)::bigint,
           count(*)::int
      from adex.capital_entries e
      join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
      cross join lateral (select coalesce(o.reverses_kind, o.kind) as b) k
     where e.company_id = p_company and e.account_id = p_account and e.seq > p_from and e.seq <= p_to
  $$;

create function adex.custody_cycle_position(c adex.custody_cycle_t) returns bigint
  language sql immutable
  as $$ select c.opening + c.base_received + c.transfers_in - c.transfers_out - c.partial_returns + c.settlement_adjust
               + c.collected - c.disbursed - c.expenses + c.other $$;

create function adex.custody_cycle_json(c adex.custody_cycle_t) returns jsonb
  language sql immutable
  as $$ select jsonb_build_object('openingMinor', c.opening, 'baseDeliveredMinor', c.base_received, 'transfersInMinor', c.transfers_in,
                                  'transfersOutMinor', c.transfers_out, 'partialReturnsMinor', c.partial_returns,
                                  'reopenedSettlementsMinor', c.settlement_adjust, 'collectedMinor', c.collected,
                                  'disbursedMinor', c.disbursed, 'expensesMinor', c.expenses, 'otherMinor', c.other, 'entries', c.entries) $$;

-- Último cuadre VIGENTE de una custodia (el que fija dónde empieza el ciclo abierto).
create function adex.custody_last_settlement(p_company text, p_account text) returns adex.custody_settlements
  language sql stable
  as $$ select * from adex.custody_settlements where company_id = p_company and custody_account_id = p_account and status = 'cerrada'
         order by cycle_no desc limit 1 $$;

-- ============================================================
-- 9. Vista previa del cuadre (`previewCashSettlement`): no escribe nada
-- ============================================================
create function adex.custody_preview(p_route text, p_worker text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    v_actor   text := adex.ctx_membership();
    v_role    text := adex.ctx_role();
    v_acc     text;
    v_bal     bigint := 0;
    v_carried bigint := 0;
    v_prev    adex.custody_settlements;
    v_from    bigint;
    v_to      bigint;
    c         adex.custody_cycle_t;
    v_p       bigint;
    v_ctrl    text;
    m         adex.memberships;
    v_today   date;
  begin
    if session_user <> 'adex_api' then perform adex.capital_raise('42501', 'settlement queries run only through the company API'); end if;
    if v_role is null or v_company is null or v_actor is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    if p_route is null or p_worker is null or not adex.ctx_route_allowed(p_route)
       or not exists (select 1 from adex.routes where company_id = v_company and id = p_route) then
      perform adex.capital_raise('AX412', 'route not found');
    end if;
    select * into m from adex.memberships where company_id = v_company and id = p_worker;
    if not found or m.role not in ('cobrador', 'supervisor') then perform adex.capital_raise('AX412', 'worker not found'); end if;
    if adex.same_person(v_company, v_actor, p_worker) then
      if not adex.ctx_can('cashSettlement.viewOwn') then perform adex.capital_raise('42501', 'no settlement authority'); end if;
    elsif not adex.ctx_can('cashSettlement.view') then
      perform adex.capital_raise('42501', 'no settlement authority');
    end if;
    v_acc := 'acc-' || md5(v_company || '|custody|' || p_worker || '|' || p_route);
    select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = v_company and id = v_acc;
    v_bal := coalesce(v_bal, 0); v_carried := coalesce(v_carried, 0);
    v_prev := adex.custody_last_settlement(v_company, v_acc);
    v_from := coalesce(v_prev.closing_seq, 0);
    v_to := greatest(v_from, coalesce((select max(seq) from adex.capital_entries where company_id = v_company and account_id = v_acc), 0));
    c := adex.custody_cycle(v_company, v_acc, v_from, v_to);
    v_p := adex.custody_cycle_position(c);
    if v_p <> v_bal then perform adex.capital_raise('AX420', 'custody cycle does not match the ledger'); end if;
    v_ctrl := adex.route_valid_controller(v_company, p_route);
    v_today := adex.company_today(v_company);
    return jsonb_build_object(
      'routeId', p_route, 'workerId', p_worker, 'workerName', m.display_name, 'workerRole', m.role, 'workerActive', m.status = 'activo',
      'assigned', exists (select 1 from adex.membership_routes where company_id = v_company and membership_id = p_worker and route_id = p_route),
      'previousSettlementId', v_prev.id, 'previousClosedAt', v_prev.closed_at, 'cycleFromSeq', v_from, 'cycleToSeq', v_to,
      'cycle', adex.custody_cycle_json(c), 'openingCarriedMinor', coalesce(v_prev.carried_after_minor, 0),
      'expectedPositionMinor', v_p, 'expectedCashMinor', greatest(v_p, 0), 'negativePositionMinor', least(v_p, 0),
      'carriedMinor', v_carried, 'availableMinor', greatest(0, v_bal - v_carried),
      'controllerId', v_ctrl, 'businessDate', v_today, 'timezone', (select timezone from adex.companies where id = v_company),
      'periodClosedToday', adex.capital_period_closed(v_company, p_route, v_today));
  end $$;

-- ============================================================
-- 10. Cuadre: `adex.custody_settle` (`closeCashSettlement` + C1)
-- ============================================================
create function adex.custody_settle(
  p_operation_id  uuid,
  p_route         text,
  p_worker        text,
  p_delivered     bigint,
  p_expected_seen bigint,
  p_previous      text,
  p_reason        text
) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x         adex.money_ctx;
    m         adex.memberships;
    v_ctrl    text;
    v_acc     text;
    v_pool    text;
    v_sus     text;
    v_uni     text;
    v_bal     bigint;
    v_carried bigint;
    v_prev    adex.custody_settlements;
    v_from    bigint;
    v_to      bigint;
    v_closing bigint;
    c         adex.custody_cycle_t;
    v_p       bigint;
    v_e       bigint;
    v_diff    bigint;
    v_short   bigint;
    v_surplus bigint;
    v_t       bigint;
    v_version int;
    v_id      text := gen_random_uuid()::text;
    v_ret     text;
    v_sop     text;
    v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
    v_tz      text;
    v_cname   text;
  begin
    x := adex.money_context(p_operation_id);
    if not adex.ctx_can('cashSettlement.close') then perform adex.capital_raise('42501', 'no settlement authority'); end if;
    if p_delivered is null or p_delivered < 0 or p_expected_seen is null or p_route is null or p_worker is null then
      perform adex.capital_raise('AX411', 'route, worker, delivered (>= 0) and the expected amount seen are required');
    end if;
    if v_reason is not null and length(v_reason) > 300 then perform adex.capital_raise('AX411', 'reason is too long'); end if;
    if exists (select 1 from adex.custody_settlements where company_id = x.company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    if not adex.ctx_route_allowed(p_route) or not exists (select 1 from adex.routes where company_id = x.company and id = p_route) then
      perform adex.capital_raise('AX412', 'route not found');
    end if;

    -- Bloqueos: ruta (compartido: fija responsable y cierres; deja correr la ruta).
    perform 1 from adex.routes where company_id = x.company and id = p_route for share;
    v_ctrl := adex.route_valid_controller(x.company, p_route);
    if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    -- Autoridad `settle` (`routeCashAuthorityError`): responsable, SuperAdmin o Supervisor de la ruta.
    if not (x.actor is not distinct from v_ctrl or x.role = 'superadmin'
            or (x.role = 'supervisor' and exists (select 1 from adex.membership_routes where company_id = x.company and membership_id = x.actor and route_id = p_route))) then
      perform adex.capital_raise('AX402', 'no authority to settle cash in this route');
    end if;
    if adex.capital_period_closed(x.company, p_route, x.today) then perform adex.capital_raise('AX407', 'the period of the route is closed'); end if;

    -- Trabajador con caja personal; asignado a la ruta o con custodia en ella (un trabajador
    -- retirado o desactivado debe poder entregar lo que tiene: nunca se deja dinero varado).
    select * into m from adex.memberships where company_id = x.company and id = p_worker;
    if not found then perform adex.capital_raise('AX412', 'worker not found'); end if;
    if m.role not in ('cobrador', 'supervisor') then perform adex.capital_raise('AX403', 'only collectors and supervisors hold personal cash'); end if;
    v_acc := 'acc-' || md5(x.company || '|custody|' || p_worker || '|' || p_route);
    if not exists (select 1 from adex.membership_routes where company_id = x.company and membership_id = p_worker and route_id = p_route)
       and not exists (select 1 from adex.capital_accounts where company_id = x.company and id = v_acc) then
      perform adex.capital_raise('AX403', 'the worker has no cash in this route');
    end if;
    -- Nadie se cuadra a sí mismo, ni con otra de sus membresías (DS-05: misma persona).
    if adex.same_person(x.company, x.actor, p_worker) then perform adex.capital_raise('AX801', 'nobody settles their own cash'); end if;

    v_acc := adex.capital_account_for(x.company, 'custody', p_worker, p_route);
    v_pool := adex.capital_account_for(x.company, 'admin', v_ctrl, null);
    perform adex.capital_lock_accounts(x.company, array[v_pool, v_acc]);

    -- Bajo bloqueo: ciclo abierto, esperado y comprobaciones de cifras obsoletas.
    select balance_minor, carried_minor into v_bal, v_carried from adex.capital_accounts where company_id = x.company and id = v_acc;
    v_prev := adex.custody_last_settlement(x.company, v_acc);
    if v_prev.id is distinct from p_previous then perform adex.capital_raise('AX802', 'another settlement was closed meanwhile'); end if;
    v_from := coalesce(v_prev.closing_seq, 0);
    v_to := greatest(v_from, coalesce((select max(seq) from adex.capital_entries where company_id = x.company and account_id = v_acc), 0));
    c := adex.custody_cycle(x.company, v_acc, v_from, v_to);
    v_p := adex.custody_cycle_position(c);
    if v_p <> v_bal then perform adex.capital_raise('AX420', 'custody cycle does not match the ledger'); end if;
    if p_expected_seen <> v_p then perform adex.capital_raise('AX802', 'the figures changed since the preview'); end if;

    v_e := greatest(v_p, 0);
    v_diff := p_delivered - v_e;
    v_short := greatest(0, -v_diff);
    v_surplus := greatest(0, v_diff);
    v_t := least(p_delivered, v_e);
    if v_diff <> 0 and length(coalesce(v_reason, '')) < 10 then perform adex.capital_raise('AX803', 'a difference needs a reason (10+ characters)'); end if;
    select coalesce(max(version), 0) + 1 into v_version from adex.custody_settlements
     where company_id = x.company and custody_account_id = v_acc and cycle_no = coalesce(v_prev.cycle_no, 0) + 1;

    -- Efectivo reconocido → bolsa del responsable (C1). Nunca el faltante ni el sobrante.
    if v_t > 0 then
      v_ret := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, settlement_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_ret, x.company, p_operation_id, 'SETTLEMENT_RETURN', v_t, x.currency, p_route, v_ctrl, p_worker, v_id,
              'Cuadre: efectivo entregado', x.today, x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_ret, array[v_acc, v_pool], array[-v_t, v_t]);
    end if;
    -- Sobrante → cuentas de control (no gastable; su destino es la decisión F6-D02).
    if v_surplus > 0 then
      v_sus := adex.capital_account_for(x.company, 'suspense', v_ctrl, p_route);
      v_uni := adex.capital_account_for(x.company, 'unidentified', null, p_route);
      perform adex.capital_lock_accounts(x.company, array[v_sus, v_uni]);
      v_sop := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, settlement_id, reason, entry_date, actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_sop, x.company, md5(p_operation_id::text || ':surplus')::uuid, 'SETTLEMENT_SURPLUS', v_surplus, x.currency, p_route, v_ctrl,
              p_worker, v_id, 'Cuadre: sobrante sin identificar', x.today, x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_sop, array[v_uni, v_sus], array[-v_surplus, v_surplus]);
    end if;
    -- Arrastre: SOLO el faltante, en positivo (`carryOverFrom`).
    update adex.capital_accounts set carried_minor = v_short, version = version + 1, updated_at = now()
     where company_id = x.company and id = v_acc;
    v_closing := greatest(v_to, coalesce((select max(seq) from adex.capital_entries where company_id = x.company and account_id = v_acc), 0));
    select timezone into v_tz from adex.companies where id = x.company;

    insert into adex.custody_settlements (
      id, company_id, route_id, worker_membership_id, worker_identity_id, custody_account_id, operation_id, cycle_no, version, previous_settlement_id,
      from_seq, to_seq, closing_seq, opening_position_minor, opening_carried_minor, base_received_minor, base_returned_minor, collected_minor,
      disbursed_minor, expenses_minor, other_minor, expected_position_minor, expected_cash_minor, expected_seen_minor, delivered_minor,
      difference_minor, shortage_minor, surplus_minor, returned_to_pool_minor, carried_after_minor, negative_position_minor, breakdown, reason,
      status, business_date, timezone, closed_at, closed_by_membership_id, closed_by_identity_id, closed_by_role, receiver_admin_membership_id,
      return_operation_id, surplus_operation_id, txid)
    values (
      v_id, x.company, p_route, p_worker, m.identity_id, v_acc, p_operation_id, coalesce(v_prev.cycle_no, 0) + 1, v_version, v_prev.id,
      v_from, v_to, v_closing, c.opening, coalesce(v_prev.carried_after_minor, 0), c.base_received + c.transfers_in, c.partial_returns + c.transfers_out,
      c.collected, c.disbursed, c.expenses, c.settlement_adjust + c.other, v_p, v_e, p_expected_seen, p_delivered,
      v_diff, v_short, v_surplus, v_t, v_short, least(v_p, 0), adex.custody_cycle_json(c), v_reason,
      'cerrada', x.today, v_tz, now(), x.actor, x.identity, x.role, v_ctrl, v_ret, v_sop, txid_current());
    -- Volver a cerrar un ciclo reabierto: la versión nueva sustituye a las reabiertas del mismo arranque.
    update adex.custody_settlements set superseded_by = v_id
     where company_id = x.company and custody_account_id = v_acc and cycle_no = coalesce(v_prev.cycle_no, 0) + 1
       and status = 'reabierta' and superseded_by is null;

    return jsonb_build_object('settlementId', v_id, 'version', v_version, 'routeId', p_route, 'workerId', p_worker,
      'expectedPositionMinor', v_p, 'expectedCashMinor', v_e, 'deliveredMinor', p_delivered, 'differenceMinor', v_diff,
      'shortageMinor', v_short, 'surplusMinor', v_surplus, 'returnedToPoolMinor', v_t, 'carriedAfterMinor', v_short,
      'negativePositionMinor', least(v_p, 0), 'returnOperationId', v_ret, 'surplusOperationId', v_sop, 'businessDate', x.today,
      'result', case when v_diff = 0 then 'exacto' when v_diff < 0 then 'faltante' else 'sobrante' end);
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX401', 'insufficient funds'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname in ('capital_operations_operation_key', 'custody_settlements_operation_key') then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname = 'custody_settlements_one_active_per_cycle' then perform adex.capital_raise('AX802', 'another settlement was closed meanwhile'); end if;
      raise;
  end $$;

-- ============================================================
-- 11. Reapertura de un cuadre (`reopenCashSettlement` + C1), solo en periodo abierto
-- ============================================================
create function adex.custody_settlement_reopen(p_operation_id uuid, p_settlement text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x       adex.money_ctx;
    s       adex.custody_settlements;
    v_ctrl  text;
    v_pool  text;
    v_sus   text;
    v_uni   text;
    v_rev   text;
    v_rev2  text;
    v_reason text := btrim(coalesce(p_reason, ''));
    v_cname text;
  begin
    x := adex.money_context(p_operation_id);
    if not adex.ctx_can('cashSettlement.reopen') then perform adex.capital_raise('42501', 'no reopen authority'); end if;
    if length(v_reason) < 10 or length(v_reason) > 300 then perform adex.capital_raise('AX803', 'reopening needs a reason (10+ characters)'); end if;
    select * into s from adex.custody_settlements where company_id = x.company and id = p_settlement;
    if not found or not adex.ctx_route_allowed(s.route_id) then perform adex.capital_raise('AX412', 'settlement not found'); end if;

    perform 1 from adex.routes where company_id = x.company and id = s.route_id for share;
    v_ctrl := adex.route_valid_controller(x.company, s.route_id);
    if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    -- Reabrir es CORREGIR: responsable de capital de la ruta o SuperAdmin.
    if x.actor is distinct from v_ctrl and x.role <> 'superadmin' then
      perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin can reopen');
    end if;
    if adex.same_person(x.company, x.actor, s.worker_membership_id) then perform adex.capital_raise('AX801', 'nobody reopens their own settlement'); end if;
    -- D7: hoy abierto y el día del cuadre en un periodo abierto (lo cerrado no se reabre).
    if adex.capital_period_closed(x.company, s.route_id, x.today) or adex.capital_period_closed(x.company, s.route_id, s.business_date) then
      perform adex.capital_raise('AX407', 'the period of the settlement is closed');
    end if;

    v_pool := adex.capital_account_for(x.company, 'admin', s.receiver_admin_membership_id, null);
    perform adex.capital_lock_accounts(x.company, array[v_pool, s.custody_account_id]);
    if s.surplus_operation_id is not null then
      v_sus := adex.capital_account_for(x.company, 'suspense', s.receiver_admin_membership_id, s.route_id);
      v_uni := adex.capital_account_for(x.company, 'unidentified', null, s.route_id);
      perform adex.capital_lock_accounts(x.company, array[v_sus, v_uni]);
    end if;
    select * into s from adex.custody_settlements where company_id = x.company and id = p_settlement for update;
    if s.status <> 'cerrada' or s.superseded_by is not null then perform adex.capital_raise('AX806', 'the settlement is not open to reopening'); end if;
    -- Solo el ÚLTIMO cuadre vigente (`reopenCashBlockedReason`).
    if exists (select 1 from adex.custody_settlements where company_id = x.company and custody_account_id = s.custody_account_id
                 and status = 'cerrada' and id <> s.id and cycle_no > s.cycle_no) then
      perform adex.capital_raise('AX806', 'only the latest settlement can be reopened');
    end if;

    -- El efectivo devuelto a la bolsa vuelve a la custodia (si la bolsa aún lo tiene).
    if s.return_operation_id is not null then
      v_rev := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, settlement_id, reverses_operation_id, reverses_kind, reason, entry_date,
                                           actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_rev, x.company, p_operation_id, 'REVERSAL', s.returned_to_pool_minor, x.currency, s.route_id, s.receiver_admin_membership_id,
              s.worker_membership_id, s.id, s.return_operation_id, 'SETTLEMENT_RETURN', 'Reapertura del cuadre: ' || v_reason, x.today,
              x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_rev, array[v_pool, s.custody_account_id], array[-s.returned_to_pool_minor, s.returned_to_pool_minor]);
    end if;
    if s.surplus_operation_id is not null then
      v_rev2 := gen_random_uuid()::text;
      insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, route_id, admin_membership_id,
                                           worker_membership_id, settlement_id, reverses_operation_id, reverses_kind, reason, entry_date,
                                           actor_membership_id, actor_identity_id, actor_role, txid)
      values (v_rev2, x.company, md5(p_operation_id::text || ':surplus')::uuid, 'REVERSAL', s.surplus_minor, x.currency, s.route_id,
              s.receiver_admin_membership_id, s.worker_membership_id, s.id, s.surplus_operation_id, 'SETTLEMENT_SURPLUS',
              'Reapertura del cuadre: ' || v_reason, x.today, x.actor, x.identity, x.role, txid_current());
      perform adex.capital_write_legs(x.company, v_rev2, array[v_sus, v_uni], array[-s.surplus_minor, s.surplus_minor]);
    end if;
    -- El arrastre vuelve al que había antes de este cuadre.
    update adex.capital_accounts set carried_minor = s.opening_carried_minor, version = version + 1, updated_at = now()
     where company_id = x.company and id = s.custody_account_id;
    update adex.custody_settlements set status = 'reabierta', reopened_at = now(), reopened_by_membership_id = x.actor, reopen_reason = v_reason
     where company_id = x.company and id = s.id;
    return jsonb_build_object('settlementId', s.id, 'routeId', s.route_id, 'workerId', s.worker_membership_id,
      'returnedToCustodyMinor', s.returned_to_pool_minor, 'surplusReleasedMinor', s.surplus_minor, 'carriedMinor', s.opening_carried_minor,
      'reversalOperationId', v_rev, 'surplusReversalOperationId', v_rev2, 'reopenDate', x.today);
  exception
    when check_violation then
      get stacked diagnostics v_cname = constraint_name;
      -- La bolsa ya usó ese efectivo: no se reabre (nunca se recupera dinero ya usado).
      if v_cname = 'capital_accounts_no_overdraft' then perform adex.capital_raise('AX413', 'the cash was already used'); end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'capital_operations_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      if v_cname in ('capital_operations_reversal_key', 'capital_operations_one_per_settlement') then perform adex.capital_raise('AX806', 'the settlement is not open to reopening'); end if;
      raise;
  end $$;

-- ============================================================
-- 12. Liquidación: cifras de una ruta en un rango de fechas, desde el libro
-- ============================================================
-- Fecha de cada asiento = `entry_date` (hoy en la zona de la empresa al registrarse).
-- Nadie fecha asientos en el pasado, así que lo que cae en un periodo ya cerrado no
-- cambia: una corrección posterior es un asiento nuevo con su propia fecha (D7).
create function adex.route_period_figures(p_company text, p_route text, p_from date, p_to date) returns jsonb
  language plpgsql stable
  as $$
  declare
    v_workers jsonb;
    v_custody jsonb;
    v_pool    jsonb;
    v_credit  jsonb;
    v_setl    jsonb;
    v_ops     jsonb;
  begin
    with legs as (
      select e.amount_minor amt, a.membership_id mid, o.entry_date d, coalesce(o.reverses_kind, o.kind) b
        from adex.capital_entries e
        join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
        join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
       where e.company_id = p_company and a.kind = 'custody' and a.route_id = p_route and o.entry_date <= p_to
    ), w as (
      select mid,
             coalesce(sum(amt) filter (where d < p_from), 0)::bigint opening,
             coalesce(sum(amt) filter (where d >= p_from and b = 'WORKER_DELIVERY'), 0)::bigint deliveries,
             coalesce(sum(amt) filter (where d >= p_from and b in ('WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and amt > 0), 0)::bigint t_in,
             coalesce(-sum(amt) filter (where d >= p_from and b in ('WORKER_TRANSFER', 'ROUTE_REASSIGNMENT') and amt < 0), 0)::bigint t_out,
             coalesce(-sum(amt) filter (where d >= p_from and b = 'WORKER_RETURN'), 0)::bigint partial_returns,
             coalesce(-sum(amt) filter (where d >= p_from and b = 'SETTLEMENT_RETURN'), 0)::bigint settlement_returns,
             coalesce(sum(amt) filter (where d >= p_from and b = 'COLLECTION'), 0)::bigint collections,
             coalesce(-sum(amt) filter (where d >= p_from and b = 'LOAN_DISBURSEMENT'), 0)::bigint disbursements,
             coalesce(-sum(amt) filter (where d >= p_from and b = 'WORKER_EXPENSE'), 0)::bigint expenses,
             coalesce(sum(amt) filter (where d >= p_from and b not in ('WORKER_DELIVERY', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'WORKER_RETURN',
                                                                     'SETTLEMENT_RETURN', 'COLLECTION', 'LOAN_DISBURSEMENT', 'WORKER_EXPENSE')), 0)::bigint other,
             coalesce(sum(amt), 0)::bigint closing
        from legs group by mid
    )
    select coalesce(jsonb_agg(jsonb_build_object('workerId', w.mid, 'name', m.display_name, 'role', m.role,
             'openingMinor', w.opening, 'deliveriesMinor', w.deliveries, 'transfersInMinor', w.t_in, 'transfersOutMinor', w.t_out,
             'partialReturnsMinor', w.partial_returns, 'settlementReturnsMinor', w.settlement_returns, 'collectionsMinor', w.collections,
             'disbursementsMinor', w.disbursements, 'workerExpensesMinor', w.expenses, 'otherMinor', w.other, 'closingMinor', w.closing)
             order by m.display_name, w.mid), '[]'::jsonb),
           jsonb_build_object('openingMinor', coalesce(sum(w.opening), 0), 'deliveriesMinor', coalesce(sum(w.deliveries), 0),
             'transfersInMinor', coalesce(sum(w.t_in), 0), 'transfersOutMinor', coalesce(sum(w.t_out), 0),
             'partialReturnsMinor', coalesce(sum(w.partial_returns), 0), 'settlementReturnsMinor', coalesce(sum(w.settlement_returns), 0),
             'collectionsMinor', coalesce(sum(w.collections), 0), 'disbursementsMinor', coalesce(sum(w.disbursements), 0),
             'workerExpensesMinor', coalesce(sum(w.expenses), 0), 'otherMinor', coalesce(sum(w.other), 0), 'closingMinor', coalesce(sum(w.closing), 0))
      into v_workers, v_custody
      from w join adex.memberships m on m.company_id = p_company and m.id = w.mid;

    -- Lado de la bolsa, cartera, interés, gastos y control, de lo atribuido a la ruta.
    with legs as (
      select e.amount_minor amt, a.kind ak, coalesce(o.reverses_kind, o.kind) b
        from adex.capital_entries e
        join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
        join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
       where e.company_id = p_company and o.entry_date between p_from and p_to
         and ((a.kind = 'admin' and o.route_id = p_route and o.to_route_id is null)
              or (a.kind in ('portfolio', 'income', 'expense', 'suspense') and a.route_id = p_route))
    )
    select jsonb_build_object(
             'collectionsReceivedMinor', coalesce(sum(amt) filter (where ak = 'admin' and b = 'COLLECTION'), 0),
             'deliveredToWorkersMinor', coalesce(-sum(amt) filter (where ak = 'admin' and b = 'WORKER_DELIVERY'), 0),
             'returnsReceivedMinor', coalesce(sum(amt) filter (where ak = 'admin' and b in ('WORKER_RETURN', 'SETTLEMENT_RETURN')), 0),
             'routeExpensesMinor', coalesce(-sum(amt) filter (where ak = 'admin' and b = 'ROUTE_EXPENSE'), 0),
             'disbursedFromPoolMinor', coalesce(-sum(amt) filter (where ak = 'admin' and b = 'LOAN_DISBURSEMENT'), 0),
             'partnerContributionsMinor', coalesce(sum(amt) filter (where ak = 'admin' and b = 'PARTNER_CONTRIBUTION'), 0),
             'surplusHeldMinor', coalesce(sum(amt) filter (where ak = 'suspense'), 0)),
           jsonb_build_object(
             'principalDisbursedMinor', coalesce(sum(amt) filter (where ak = 'portfolio' and b = 'LOAN_DISBURSEMENT'), 0),
             'principalCollectedMinor', coalesce(-sum(amt) filter (where ak = 'portfolio' and b = 'COLLECTION'), 0),
             'interestCollectedMinor', coalesce(-sum(amt) filter (where ak = 'income'), 0),
             'expensesMinor', coalesce(sum(amt) filter (where ak = 'expense'), 0))
      into v_pool, v_credit from legs;

    select jsonb_build_object('count', count(*), 'deliveredMinor', coalesce(sum(delivered_minor), 0),
             'returnedToPoolMinor', coalesce(sum(returned_to_pool_minor), 0), 'shortageMinor', coalesce(sum(shortage_minor), 0),
             'surplusMinor', coalesce(sum(surplus_minor), 0),
             'items', coalesce(jsonb_agg(jsonb_build_object('id', id, 'workerId', worker_membership_id, 'version', version, 'status', status,
                        'businessDate', business_date, 'expectedPositionMinor', expected_position_minor, 'deliveredMinor', delivered_minor,
                        'shortageMinor', shortage_minor, 'surplusMinor', surplus_minor) order by closed_at, id), '[]'::jsonb))
      into v_setl
      from adex.custody_settlements where company_id = p_company and route_id = p_route and business_date between p_from and p_to;

    select jsonb_build_object('count', count(*), 'lastSeq', coalesce(max(last_seq), 0),
             'hash', encode(sha256(convert_to(coalesce(string_agg(id, ',' order by id), ''), 'UTF8')), 'hex'))
      into v_ops
      from (select o.id, max(e.seq) last_seq
              from adex.capital_operations o join adex.capital_entries e on e.company_id = o.company_id and e.operation_id = o.id
              join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
             where o.company_id = p_company and o.entry_date between p_from and p_to
               and (o.route_id = p_route or o.to_route_id = p_route or a.route_id = p_route)
             group by o.id) q;

    return jsonb_build_object('routeId', p_route, 'from', p_from, 'to', p_to, 'custody', v_custody, 'workers', v_workers,
                              'pool', v_pool, 'credit', v_credit, 'settlements', v_setl, 'operations', v_ops);
  end $$;

-- Liquidación para la API (`cashbox.viewRoute` sobre la ruta). No escribe nada.
create function adex.route_liquidation(p_route text, p_from date, p_to date) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare v_company text := adex.ctx_company(); v_today date; v_closures jsonb;
  begin
    if session_user <> 'adex_api' or v_company is null or adex.ctx_role() is null then perform adex.capital_raise('42501', 'no valid active context'); end if;
    if not adex.ctx_can('cashbox.viewRoute') then perform adex.capital_raise('42501', 'no route cash authority'); end if;
    if p_route is null or not adex.ctx_route_allowed(p_route) or not exists (select 1 from adex.routes where company_id = v_company and id = p_route) then
      perform adex.capital_raise('AX412', 'route not found');
    end if;
    if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 366 then perform adex.capital_raise('AX411', 'invalid date range'); end if;
    v_today := adex.company_today(v_company);
    select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'weekStart', w.week_start, 'weekEnd', w.week_end, 'status', coalesce(w.status, 'cerrada'),
                    'version', coalesce(w.version, 1), 'closedAt', w.closed_at, 'archived', p.id is not null) order by w.week_start, w.version), '[]'::jsonb)
      into v_closures
      from adex.weekly_settlements w left join adex.period_closures p on p.company_id = w.company_id and p.id = w.id
     where w.company_id = v_company and w.route_id = p_route and w.week_start <= p_to and p_from <= w.week_end;
    return adex.route_period_figures(v_company, p_route, p_from, p_to)
           || jsonb_build_object('businessDate', v_today, 'timezone', (select timezone from adex.companies where id = v_company),
                                 'ended', p_to < v_today, 'closures', v_closures,
                                 'closable', p_to < v_today and not exists (
                                    select 1 from adex.weekly_settlements w where w.company_id = v_company and w.route_id = p_route
                                       and coalesce(w.status, 'cerrada') = 'cerrada' and w.week_start <= p_to and p_from <= w.week_end));
  end $$;

-- ============================================================
-- 13. Cierre de periodo: `adex.period_close` (`closeSettlement`, D7, D29, DS-04)
-- ============================================================
create function adex.period_close(p_operation_id uuid, p_route text, p_from date, p_to date, p_note text) returns jsonb
  language plpgsql volatile security definer set search_path = pg_catalog, adex
  as $$
  declare
    x         adex.money_ctx;
    v_ctrl    text;
    v_fig     jsonb;
    v_c       jsonb;
    v_version int;
    v_id      text := gen_random_uuid()::text;
    v_office  record;
    v_tz      text;
    v_note    text := nullif(btrim(coalesce(p_note, '')), '');
    v_cname   text;
  begin
    x := adex.money_context(p_operation_id);
    if not adex.ctx_can('settlement.close') then perform adex.capital_raise('42501', 'no period close authority'); end if;
    if exists (select 1 from adex.period_closures where company_id = x.company and operation_id = p_operation_id) then
      perform adex.capital_raise('AX409', 'operation id already used');
    end if;
    if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 366 then perform adex.capital_raise('AX411', 'invalid date range'); end if;
    if v_note is not null and length(v_note) > 300 then perform adex.capital_raise('AX411', 'note is too long'); end if;
    if p_route is null or not adex.ctx_route_allowed(p_route) or not exists (select 1 from adex.routes where company_id = x.company and id = p_route) then
      perform adex.capital_raise('AX412', 'route not found');
    end if;
    -- Bloqueo EXCLUSIVO de la ruta: espera a todo recaudo, gasto, desembolso, entrega o
    -- cuadre en curso de la ruta y a otro cierre simultáneo; lo que llegue después ve el cierre.
    perform 1 from adex.routes where company_id = x.company and id = p_route for update;
    v_ctrl := adex.route_valid_controller(x.company, p_route);
    if v_ctrl is null then perform adex.capital_raise('AX408', 'route has no valid capital controller'); end if;
    -- Autoridad `correct` (CLEAN `closeSettlement`): responsable de capital o SuperAdmin.
    if x.actor is distinct from v_ctrl and x.role <> 'superadmin' then
      perform adex.capital_raise('AX402', 'only the route capital controller or the SuperAdmin closes the period');
    end if;
    -- D29 con el reloj del servidor y la zona de la empresa (DS-04).
    if p_to >= x.today then perform adex.capital_raise('AX804', 'the period has not ended yet'); end if;
    -- Sin duplicados ni solapamientos con un cierre vigente (`closureBlockedReason`).
    if exists (select 1 from adex.weekly_settlements w where w.company_id = x.company and w.route_id = p_route
                 and coalesce(w.status, 'cerrada') = 'cerrada' and w.week_start <= p_to and p_from <= w.week_end) then
      perform adex.capital_raise('AX805', 'the range overlaps a closed period');
    end if;

    v_fig := adex.route_period_figures(x.company, p_route, p_from, p_to);
    v_c := v_fig -> 'custody';
    if (v_c ->> 'otherMinor')::bigint <> 0 then perform adex.capital_raise('AX420', 'unclassified custody movements'); end if;
    select coalesce(max(coalesce(version, 1)), 0) + 1 into v_version from adex.weekly_settlements
     where company_id = x.company and route_id = p_route and week_start = p_from and week_end = p_to;
    select o.id, o.name, o.code into v_office from adex.routes r left join adex.offices o on o.company_id = r.company_id and o.id = r.office_id
     where r.company_id = x.company and r.id = p_route;
    select timezone into v_tz from adex.companies where id = x.company;

    insert into adex.weekly_settlements (id, company_id, route_id, week_start, week_end, opening_balance_minor, capital_in_minor, collections_minor,
                                         loans_disbursed_minor, expenses_minor, transfers_in_minor, transfers_out_minor, withdrawals_minor,
                                         closing_balance_minor, created_at, status, created_by_membership_id, closed_at, closed_by_membership_id,
                                         version, office_id_at_close, office_name_at_close, office_code_at_close, capital_controller_at_close_id)
    values (v_id, x.company, p_route, p_from, p_to, (v_c ->> 'openingMinor')::bigint, (v_c ->> 'deliveriesMinor')::bigint,
            (v_c ->> 'collectionsMinor')::bigint, (v_c ->> 'disbursementsMinor')::bigint, (v_c ->> 'workerExpensesMinor')::bigint,
            (v_c ->> 'transfersInMinor')::bigint, (v_c ->> 'transfersOutMinor')::bigint,
            (v_c ->> 'partialReturnsMinor')::bigint + (v_c ->> 'settlementReturnsMinor')::bigint, (v_c ->> 'closingMinor')::bigint,
            now(), 'cerrada', x.actor, now(), x.actor, v_version, v_office.id, coalesce(v_office.name, 'Sin Oficina'), v_office.code, v_ctrl);
    update adex.weekly_settlements set superseded_by = v_id
     where company_id = x.company and route_id = p_route and week_start = p_from and week_end = p_to and id <> v_id
       and superseded_by is null and coalesce(status, 'cerrada') = 'reabierta';
    insert into adex.period_closures (id, company_id, route_id, operation_id, week_start, week_end, version, business_date, timezone, figures,
                                      ledger_operations, ledger_hash, ledger_last_seq, note, closed_at, closed_by_membership_id,
                                      closed_by_identity_id, closed_by_role, txid)
    values (v_id, x.company, p_route, p_operation_id, p_from, p_to, v_version, x.today, v_tz, v_fig,
            (v_fig #>> '{operations,count}')::int, v_fig #>> '{operations,hash}', (v_fig #>> '{operations,lastSeq}')::bigint, v_note, now(),
            x.actor, x.identity, x.role, txid_current());
    return jsonb_build_object('closureId', v_id, 'routeId', p_route, 'weekStart', p_from, 'weekEnd', p_to, 'version', v_version,
                              'businessDate', x.today, 'timezone', v_tz, 'figures', v_fig);
  exception
    when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname = 'period_closures_operation_key' then perform adex.capital_raise('AX409', 'operation id already used'); end if;
      raise;
  end $$;

-- ============================================================
-- 14. Privilegios
-- ============================================================
grant select on adex.custody_settlements, adex.period_closures to adex_api;
grant execute on function adex.custody_preview(text, text), adex.custody_settle(uuid, text, text, bigint, bigint, text, text),
  adex.custody_settlement_reopen(uuid, text, text), adex.route_liquidation(text, date, date), adex.period_close(uuid, text, date, date, text),
  adex.company_today(text) to adex_api;
-- Cifras de un rango SIN privilegios propios (SECURITY INVOKER): para `adex_api` respetan su
-- RLS; la conciliación del SuperAdmin las usa para comprobar que lo cerrado no cambió.
grant execute on function adex.route_period_figures(text, text, date, date) to adex_api;
revoke all on function adex.custody_cycle(text, text, bigint, bigint), adex.custody_cycle_position(adex.custody_cycle_t),
  adex.custody_cycle_json(adex.custody_cycle_t), adex.custody_last_settlement(text, text) from public;
